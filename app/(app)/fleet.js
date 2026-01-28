// 📂 FILE: app/(app)/fleet.js
// ✅ Updates to help the app “run right”
// - Stops showing the WRONG fleet by re-syncing groupId from the *current device* row in `devices` after login
// - Clears stale cached fleet context on SIGN OUT (prevents cross-account bleed)
// - Dedupes tracking rows to 1 row per device (prevents duplicates)
// - Marks devices OFFLINE locally if last_updated is old (prevents stale “ONLINE forever”)
// - Adds realtime SOS broadcast listener (`fleet:${groupId}`) to refresh instantly when BatSignal fires
// - Adds AppState resume refresh (when returning to the app)
// ✅ NEW (Phase 3 Baby Step 3 + 4):
// - Adds stealth "Back" button
// - Adds in-app "Switch Fleet" (no logout):
//   1) resolve group_id by invite code
//   2) join_group_with_invite_code RPC (group_members)
//   3) ✅ handshakeDevice({ groupId }) to MOVE the device row (devices.group_id) to the new fleet
//   4) update sentinel_group_id, refresh UI,
//   5) force a one-shot sync so tracking_sessions binds to the new fleet immediately.
// ✅ NEW (Phase 3 Baby Step 5):
// - Admin-only “Remove device” action (stealth ⋯ button per member)
// - Calls remove_device_from_fleet RPC and refreshes instantly

import React, { useEffect, useMemo, useRef, useState, useCallback } from "react";
import {
  View,
  Text,
  FlatList,
  StyleSheet,
  ActivityIndicator,
  RefreshControl,
  TouchableOpacity,
  Alert,
  Linking,
  AppState,
  Modal,
  TextInput,
  KeyboardAvoidingView,
  Platform,
  Pressable,
} from "react-native";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { supabase } from "../../src/lib/supabase";
import { Ionicons } from "@expo/vector-icons";
import { useRouter } from "expo-router";
import { getDeviceId } from "../../src/services/Identity";
import { forceOneShotSync } from "../../src/services/LiveTracker";
import { handshakeDevice } from "../../src/services/deviceHandshake";

const STORAGE_KEY_GROUP_ID = "sentinel_group_id";
const STORAGE_KEY_INVITE_CODE = "sentinel_invite_code";

// ✅ RPCs
const RPC_JOIN_GROUP = "join_group_with_invite_code";
const RPC_GET_GROUP_ID = "get_group_id_by_invite_code";
const RPC_REMOVE_DEVICE = "remove_device_from_fleet";

// ✅ Your guardian dashboard base URL (existing public dashboard)
const GUARDIAN_DASHBOARD_URL = "https://sentihnel.com/";

// Local UI rule: if a device hasn’t updated recently, show it as OFFLINE
const OFFLINE_AFTER_MS = 3 * 60 * 1000; // 3 minutes

// ✅ match Phase 2 SQL normalization (strip non-alphanumeric)
function normalizeInviteCode(code) {
  return String(code || "")
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");
}

/**
 * ✅ Extract UUID from various RPC return shapes
 */
function extractGroupIdFromRpc(data) {
  if (!data) return null;

  if (typeof data === "string") return data;

  if (Array.isArray(data)) {
    const row = data[0];
    if (!row) return null;
    if (typeof row === "string") return row;
    if (typeof row === "object") return row.group_id || row.id || null;
    return null;
  }

  if (typeof data === "object") {
    return data.group_id || data.id || null;
  }

  return null;
}

export default function FleetScreen() {
  const router = useRouter();

  // ✅ Stealth back/menu: return to main screen where you came from
  // (terminate session + open fleet manager lives on /(app)/home in your app)
  const goBackToMenu = useCallback(() => {
    try {
      router.replace("/(app)/home");
    } catch (e) {
      try {
        router.back();
      } catch {}
    }
  }, [router]);

  const [workers, setWorkers] = useState([]);
  const [nameByDevice, setNameByDevice] = useState({}); // device_id -> display_name

  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [errorText, setErrorText] = useState("");

  const [groupId, setGroupId] = useState(null);
  const [inviteCode, setInviteCode] = useState("");
  const [inviteLoading, setInviteLoading] = useState(true);

  // Optional: show a quick banner when an SOS broadcast hits
  const [incomingSos, setIncomingSos] = useState(null);

  // ✅ Switch Fleet modal
  const [switchModalVisible, setSwitchModalVisible] = useState(false);
  const [switchInviteInput, setSwitchInviteInput] = useState("");
  const [switching, setSwitching] = useState(false);
  const [switchError, setSwitchError] = useState("");

  // ✅ Admin detection + remove device
  const [isAdmin, setIsAdmin] = useState(false);
  const [adminLoading, setAdminLoading] = useState(false);
  const [removingDeviceId, setRemovingDeviceId] = useState(null);

  // Throttle realtime refreshes
  const refetchTimerRef = useRef(null);

  // Realtime channels
  const pgChannelRef = useRef(null);
  const broadcastChannelRef = useRef(null);

  const isMountedRef = useRef(true);
  const fetchingRef = useRef(false);
  const appStateRef = useRef(AppState.currentState);

  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  const safeTime = (iso) => {
    try {
      if (!iso) return "—";
      const d = new Date(iso);
      if (Number.isNaN(d.getTime())) return "—";
      return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    } catch {
      return "—";
    }
  };

  const safePercent = (n) => {
    const v = typeof n === "number" ? n : parseInt(n, 10);
    if (Number.isNaN(v)) return "—";
    return `${Math.max(0, Math.min(100, v))}%`;
    };

  const safeCoords = (lat, lng) => {
    if (typeof lat !== "number" || typeof lng !== "number") return "—";
    return `${lat.toFixed(6)}, ${lng.toFixed(6)}`;
  };

  const shortId = (s) => {
    const str = String(s || "");
    if (!str) return "—";
    return str.length <= 8 ? str : `${str.slice(0, 4)}…${str.slice(-3)}`;
  };

  const buildFallbackLabel = (deviceId) => {
    const id = String(deviceId || "").trim();
    if (!id) return "Unknown";
    return `Member • ${shortId(id)}`;
  };

  const getFriendlyName = (deviceId) => {
    const key = String(deviceId || "");
    const name = nameByDevice?.[key];
    if (name && String(name).trim()) return String(name).trim();
    return buildFallbackLabel(deviceId);
  };

  const computeDisplayStatus = (item) => {
    const raw = String(item?.status || "UNKNOWN").toUpperCase();
    if (raw === "SOS") return "SOS";

    // If last_updated is old, treat as OFFLINE
    const t = item?.last_updated ? new Date(item.last_updated).getTime() : 0;
    const now = Date.now();
    if (!t || Number.isNaN(t) || now - t > OFFLINE_AFTER_MS) return "OFFLINE";

    return raw === "ACTIVE" ? "ACTIVE" : raw;
  };

  const fetchInviteCodeForGroup = useCallback(async (gid) => {
    try {
      if (!gid) return null;

      const { data, error } = await supabase
        .from("groups")
        .select("invite_code")
        .eq("id", gid)
        .limit(1)
        .maybeSingle();

      if (error) {
        console.log("groups invite_code fetch warning:", error.message);
        return null;
      }

      return data?.invite_code || null;
    } catch (e) {
      console.log("invite_code fetch error:", e?.message || e);
      return null;
    }
  }, []);

  const loadFleetContext = useCallback(async () => {
    try {
      setInviteLoading(true);

      const gid = await AsyncStorage.getItem(STORAGE_KEY_GROUP_ID);
      const cachedCode = await AsyncStorage.getItem(STORAGE_KEY_INVITE_CODE);

      const gidStr = gid ? String(gid) : null;
      if (isMountedRef.current) setGroupId(gidStr);

      if (cachedCode) {
        if (isMountedRef.current) setInviteCode(String(cachedCode));
      } else if (gidStr) {
        const code = await fetchInviteCodeForGroup(gidStr);
        if (code) {
          if (isMountedRef.current) setInviteCode(String(code));
          await AsyncStorage.setItem(STORAGE_KEY_INVITE_CODE, String(code));
        }
      }

      return gidStr;
    } catch (e) {
      console.log("loadFleetContext error:", e?.message || e);
      return null;
    } finally {
      if (isMountedRef.current) setInviteLoading(false);
    }
  }, [fetchInviteCodeForGroup]);

  // ✅ After login, don’t trust cached group_id.
  const reconcileGroupFromDeviceRow = useCallback(async () => {
    try {
      const deviceId = await getDeviceId();

      const { data, error } = await supabase
        .from("devices")
        .select("group_id")
        .eq("device_id", deviceId)
        .limit(1)
        .maybeSingle();

      if (error) {
        console.log("reconcileGroupFromDeviceRow warning:", error.message);
        return null;
      }

      const gid = data?.group_id ? String(data.group_id) : null;
      if (!gid) return null;

      const cached = await AsyncStorage.getItem(STORAGE_KEY_GROUP_ID);
      const cachedStr = cached ? String(cached) : null;

      if (cachedStr !== gid) {
        console.log("✅ Fleet context corrected from device row:", { cached: cachedStr, actual: gid });

        await AsyncStorage.setItem(STORAGE_KEY_GROUP_ID, gid);
        await AsyncStorage.removeItem(STORAGE_KEY_INVITE_CODE);

        if (isMountedRef.current) {
          setGroupId(gid);
          setInviteCode("");
        }

        const code = await fetchInviteCodeForGroup(gid);
        if (code) {
          await AsyncStorage.setItem(STORAGE_KEY_INVITE_CODE, String(code));
          if (isMountedRef.current) setInviteCode(String(code));
        }
      }

      return gid;
    } catch (e) {
      console.log("reconcileGroupFromDeviceRow error:", e?.message || e);
      return null;
    }
  }, [fetchInviteCodeForGroup]);

  const resolveGroupIdByInviteCode = useCallback(async (cleanCode) => {
    try {
      const { data, error } = await supabase.rpc(RPC_GET_GROUP_ID, { p_invite_code: cleanCode });
      if (error) throw error;
      const gid = extractGroupIdFromRpc(data);
      return gid ? String(gid) : null;
    } catch (e) {
      console.log("resolveGroupIdByInviteCode error:", e?.message || e);
      return null;
    }
  }, []);

  // ✅ Admin status: try groups table first; fall back to group_members
  const resolveIsAdmin = useCallback(async (gid) => {
    const fleetId = gid ? String(gid) : null;
    if (!fleetId) {
      if (isMountedRef.current) setIsAdmin(false);
      return;
    }

    setAdminLoading(true);

    try {
      const { data: userRes } = await supabase.auth.getUser();
      const user = userRes?.user;
      const uid = user?.id ? String(user.id) : null;
      if (!uid) {
        if (isMountedRef.current) setIsAdmin(false);
        return;
      }

      // 1) Try groups.* (owner/admin columns vary across builds)
      const groupSelects = [
        "owner_user_id, admin_id",
        "admin_id, owner_user_id",
        "owner_user_id",
        "admin_id",
        "owner_id",
        "created_by",
        "user_id",
      ];

      for (const sel of groupSelects) {
        try {
          const { data, error } = await supabase
            .from("groups")
            .select(sel)
            .eq("id", fleetId)
            .limit(1)
            .maybeSingle();

          if (error) continue;

          const row = data || {};
          const candidates = [
            row.owner_user_id,
            row.admin_id,
            row.owner_id,
            row.created_by,
            row.user_id,
          ]
            .filter(Boolean)
            .map((x) => String(x));

          if (candidates.includes(uid)) {
            if (isMountedRef.current) setIsAdmin(true);
            return;
          }
        } catch {}
      }

      // 2) Fall back to group_members role/is_admin (schema varies)
      const gmSelects = ["role, is_admin", "role", "is_admin", "is_manager", "*"];
      for (const sel of gmSelects) {
        try {
          const { data, error } = await supabase
            .from("group_members")
            .select(sel)
            .eq("group_id", fleetId)
            .eq("user_id", uid)
            .limit(1)
            .maybeSingle();

          if (error) continue;

          const row = data || {};
          const role = row?.role ? String(row.role).toLowerCase() : "";
          const isAdminBool = row?.is_admin === true || row?.is_manager === true;

          if (isAdminBool || role.includes("admin") || role.includes("owner")) {
            if (isMountedRef.current) setIsAdmin(true);
            return;
          }
        } catch {}
      }

      if (isMountedRef.current) setIsAdmin(false);
    } finally {
      if (isMountedRef.current) setAdminLoading(false);
    }
  }, []);

  useEffect(() => {
    // refresh admin status whenever fleet changes
    resolveIsAdmin(groupId);
  }, [groupId, resolveIsAdmin]);

  const shareInviteCode = async () => {
    try {
      if (!inviteCode) return;
      Alert.alert("Invite Code", `${inviteCode}\n\n(Press and hold to copy if supported)`);
    } catch (e) {
      console.log("shareInviteCode error:", e?.message || e);
    }
  };

  const buildLiveUrl = (deviceId, lat, lng) => {
    const id = encodeURIComponent(String(deviceId || ""));
    const hasLatLng = typeof lat === "number" && typeof lng === "number";
    const qs = hasLatLng
      ? `?id=${id}&lat=${encodeURIComponent(String(lat))}&lng=${encodeURIComponent(String(lng))}`
      : `?id=${id}`;
    return `${GUARDIAN_DASHBOARD_URL}${qs}`;
  };

  const openUrl = async (url) => {
    try {
      const can = await Linking.canOpenURL(url);
      if (!can) {
        Alert.alert("Cannot Open", "Your phone cannot open this link.");
        return;
      }
      await Linking.openURL(url);
    } catch (e) {
      console.log("openUrl error:", e?.message || e);
      Alert.alert("Error", "Could not open the link.");
    }
  };

  const openLiveView = async (item) => {
    try {
      const url = buildLiveUrl(item?.device_id, item?.latitude, item?.longitude);
      await openUrl(url);
    } catch (e) {
      console.log("openLiveView error:", e?.message || e);
      Alert.alert("Error", "Could not open live view.");
    }
  };

  const openMaps = async (item) => {
    try {
      const lat = item?.latitude;
      const lng = item?.longitude;
      if (typeof lat !== "number" || typeof lng !== "number") {
        Alert.alert("No Location", "This device has not sent coordinates yet.");
        return;
      }
      const url = `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(`${lat},${lng}`)}`;
      await openUrl(url);
    } catch (e) {
      console.log("openMaps error:", e?.message || e);
      Alert.alert("Error", "Could not open maps.");
    }
  };

  const showCoordinatesBox = (item) => {
    const coords = safeCoords(item?.latitude, item?.longitude);
    const who = getFriendlyName(item?.device_id);
    Alert.alert("Coordinates", `${who}\n\n${coords}\n\n(Read to police exactly as shown)`);
  };

  const hydrateNamesForSessions = useCallback(async ({ gid, sessions }) => {
    try {
      if (!gid || !Array.isArray(sessions) || sessions.length === 0) return;

      const deviceIds = Array.from(
        new Set(
          sessions
            .map((s) => s?.device_id)
            .filter(Boolean)
            .map((x) => String(x))
        )
      );

      if (deviceIds.length === 0) return;

      const { data, error } = await supabase
        .from("devices")
        .select("device_id, display_name")
        .eq("group_id", gid)
        .in("device_id", deviceIds);

      if (error) {
        console.log("devices name lookup warning:", error.message);
        return;
      }

      const rows = Array.isArray(data) ? data : [];
      const nextMap = {};

      for (const r of rows) {
        const dId = String(r?.device_id || "");
        const dName = r?.display_name ? String(r.display_name).trim() : "";
        if (dId && dName) nextMap[dId] = dName;
      }

      if (Object.keys(nextMap).length > 0 && isMountedRef.current) {
        setNameByDevice((prev) => ({ ...(prev || {}), ...nextMap }));
      }
    } catch (e) {
      console.log("hydrateNamesForSessions error:", e?.message || e);
    }
  }, []);

  const dedupeLatestByDevice = (rows) => {
    const map = new Map();
    for (const r of rows) {
      const id = String(r?.device_id || "");
      if (!id) continue;

      const t = r?.last_updated ? new Date(r.last_updated).getTime() : 0;
      const prev = map.get(id);
      if (!prev) {
        map.set(id, r);
        continue;
      }
      const pt = prev?.last_updated ? new Date(prev.last_updated).getTime() : 0;
      if ((t || 0) >= (pt || 0)) map.set(id, r);
    }
    return Array.from(map.values());
  };

  const fetchFleet = useCallback(
    async (gidOverride) => {
      if (fetchingRef.current) return;
      fetchingRef.current = true;

      if (isMountedRef.current) setErrorText("");

      try {
        const gid = gidOverride ?? groupId;

        if (!gid) {
          if (isMountedRef.current) {
            setWorkers([]);
            setNameByDevice({});
            setErrorText("No fleet linked yet. Use Join Fleet or Create Fleet to activate tracking.");
          }
          return;
        }

        const { data, error } = await supabase
          .from("tracking_sessions")
          .select("device_id, group_id, latitude, longitude, battery_level, status, last_updated")
          .eq("group_id", gid)
          .order("last_updated", { ascending: false });

        if (error) throw error;

        const rows = Array.isArray(data) ? data : [];
        const deduped = dedupeLatestByDevice(rows);

        if (isMountedRef.current) setWorkers(deduped);

        await hydrateNamesForSessions({ gid, sessions: deduped });
      } catch (err) {
        const msg = err?.message || "Failed to load fleet.";

        if (String(msg).toLowerCase().includes("infinite recursion")) {
          console.error("Fleet fetch error:", msg);
          if (isMountedRef.current) {
            setErrorText(
              "Security policy error (RLS recursion). Fix policies for group_members/groups. Fleet data is currently blocked."
            );
          }
        } else {
          console.error("Fleet fetch error:", msg);
          if (isMountedRef.current) setErrorText(msg);
        }
      } finally {
        fetchingRef.current = false;
        if (isMountedRef.current) {
          setLoading(false);
          setRefreshing(false);
        }
      }
    },
    [groupId, hydrateNamesForSessions]
  );

  const sortedWorkers = useMemo(() => {
    const arr = Array.isArray(workers) ? [...workers] : [];

    const rank = (s) => {
      if (s === "SOS") return 0;
      if (s === "ACTIVE") return 1;
      if (s === "OFFLINE") return 2;
      return 3;
    };

    arr.sort((a, b) => {
      const sa = computeDisplayStatus(a);
      const sb = computeDisplayStatus(b);

      const ra = rank(sa);
      const rb = rank(sb);
      if (ra !== rb) return ra - rb;

      const aTime = a?.last_updated ? new Date(a.last_updated).getTime() : 0;
      const bTime = b?.last_updated ? new Date(b.last_updated).getTime() : 0;
      return bTime - aTime;
    });

    return arr;
  }, [workers]);

  const hasSOS = useMemo(() => sortedWorkers.some((w) => computeDisplayStatus(w) === "SOS"), [sortedWorkers]);

  const firstSOS = useMemo(
    () => sortedWorkers.find((w) => computeDisplayStatus(w) === "SOS") || null,
    [sortedWorkers]
  );

  const openSosLiveView = async (list) => {
    const source = Array.isArray(list) ? list : sortedWorkers;
    const sos = source.find((w) => computeDisplayStatus(w) === "SOS");
    if (!sos) {
      Alert.alert("No SOS", "No SOS devices are currently active.");
      return;
    }
    await openLiveView(sos);
  };

  const boot = useCallback(async () => {
    if (!isMountedRef.current) return;
    setLoading(true);

    const cachedGid = await loadFleetContext();
    const reconciledGid = await reconcileGroupFromDeviceRow();
    const gidToUse = reconciledGid || cachedGid;

    await fetchFleet(gidToUse);

    if (isMountedRef.current) setLoading(false);
  }, [fetchFleet, loadFleetContext, reconcileGroupFromDeviceRow]);

  useEffect(() => {
    boot();
  }, [boot]);

  useEffect(() => {
    const { data } = supabase.auth.onAuthStateChange(async (event) => {
      if (event === "SIGNED_OUT") {
        try {
          await AsyncStorage.multiRemove([STORAGE_KEY_GROUP_ID, STORAGE_KEY_INVITE_CODE]);
        } catch {}
        if (isMountedRef.current) {
          setGroupId(null);
          setInviteCode("");
          setWorkers([]);
          setNameByDevice({});
          setErrorText("");
          setIsAdmin(false);
        }
        return;
      }

      if (event === "SIGNED_IN" || event === "TOKEN_REFRESHED") {
        boot();
      }
    });

    return () => {
      try {
        data?.subscription?.unsubscribe?.();
      } catch {}
    };
  }, [boot]);

  useEffect(() => {
    const sub = AppState.addEventListener("change", (nextState) => {
      const prev = appStateRef.current;
      appStateRef.current = nextState;

      if (prev.match(/inactive|background/) && nextState === "active") {
        if (groupId) fetchFleet(groupId);
      }
    });

    return () => {
      try {
        sub?.remove?.();
      } catch {}
    };
  }, [groupId, fetchFleet]);

  useEffect(() => {
    if (pgChannelRef.current) {
      try {
        supabase.removeChannel(pgChannelRef.current);
      } catch {}
      pgChannelRef.current = null;
    }

    if (!groupId) return;

    const channel = supabase
      .channel(`fleet_updates_${groupId}`)
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "tracking_sessions",
          filter: `group_id=eq.${groupId}`,
        },
        () => {
          if (refetchTimerRef.current) return;

          refetchTimerRef.current = setTimeout(() => {
            refetchTimerRef.current = null;
            fetchFleet(groupId);
          }, 800);
        }
      )
      .subscribe();

    pgChannelRef.current = channel;

    return () => {
      if (refetchTimerRef.current) {
        clearTimeout(refetchTimerRef.current);
        refetchTimerRef.current = null;
      }
      if (pgChannelRef.current) {
        try {
          supabase.removeChannel(pgChannelRef.current);
        } catch {}
        pgChannelRef.current = null;
      }
    };
  }, [groupId, fetchFleet]);

  useEffect(() => {
    if (broadcastChannelRef.current) {
      try {
        supabase.removeChannel(broadcastChannelRef.current);
      } catch {}
      broadcastChannelRef.current = null;
    }

    if (!groupId) return;

    const ch = supabase
      .channel(`fleet:${groupId}`)
      .on("broadcast", { event: "sos" }, (payload) => {
        const p = payload?.payload || payload;
        const device_id = p?.device_id || p?.deviceId || "Unknown";
        console.log("🚨 SOS broadcast received:", device_id);

        if (isMountedRef.current) {
          setIncomingSos({
            device_id: String(device_id),
            ts: Date.now(),
          });
        }

        fetchFleet(groupId);

        setTimeout(() => {
          if (!isMountedRef.current) return;
          setIncomingSos((prev) => {
            if (!prev) return null;
            if (Date.now() - prev.ts > 12000) return null;
            return prev;
          });
        }, 12500);
      })
      .subscribe();

    broadcastChannelRef.current = ch;

    return () => {
      if (broadcastChannelRef.current) {
        try {
          supabase.removeChannel(broadcastChannelRef.current);
        } catch {}
        broadcastChannelRef.current = null;
      }
    };
  }, [groupId, fetchFleet]);

  // =========================
  // ✅ Switch Fleet flow (Baby Step 3)
  // =========================
  const openSwitchModal = () => {
    setSwitchError("");
    setSwitchInviteInput("");
    setSwitchModalVisible(true);
  };

  const closeSwitchModal = () => {
    if (switching) return;
    setSwitchModalVisible(false);
    setSwitchError("");
  };

  const handleSwitchFleet = async () => {
    const clean = normalizeInviteCode(switchInviteInput);
    if (!clean) {
      setSwitchError("Enter a valid invite code.");
      return;
    }

    const prevGroupId = groupId ? String(groupId) : null;

    setSwitchError("");
    setSwitching(true);

    try {
      // 1) Resolve group_id first
      const targetGroupId = await resolveGroupIdByInviteCode(clean);
      if (!targetGroupId) {
        setSwitchError("That invite code does not exist.");
        return;
      }

      // 2) Join fleet via RPC (no direct writes)
      const { data: joinData, error: joinErr } = await supabase.rpc(RPC_JOIN_GROUP, { p_invite_code: clean });
      if (joinErr) throw joinErr;

      const extracted = extractGroupIdFromRpc(joinData);
      const newGroupId = String(extracted || targetGroupId);

      if (!newGroupId || newGroupId.includes("[object")) {
        throw new Error("Join returned, but no valid group_id was produced.");
      }

      // 3) ✅ CRITICAL: Move device row to the new fleet (devices.group_id)
      const hs = await handshakeDevice({ groupId: newGroupId });
      if (!hs?.ok) {
        throw new Error(hs?.error || "Could not move device to the new fleet.");
      }

      // 4) Update local fleet context immediately
      await AsyncStorage.setItem(STORAGE_KEY_GROUP_ID, newGroupId);
      await AsyncStorage.removeItem(STORAGE_KEY_INVITE_CODE);

      if (isMountedRef.current) {
        setGroupId(newGroupId);
        setInviteCode("");
        setWorkers([]);
        setNameByDevice({});
        setErrorText("");
      }

      // 5) Fetch invite code for display
      const code = await fetchInviteCodeForGroup(newGroupId);
      if (code) {
        await AsyncStorage.setItem(STORAGE_KEY_INVITE_CODE, String(code));
        if (isMountedRef.current) setInviteCode(String(code));
      }

      // 6) Refresh fleet list in the new group
      await fetchFleet(newGroupId);

      // 7) Force immediate tracking bind to new fleet
      try {
        await forceOneShotSync();
      } catch {}

      // Close modal
      if (isMountedRef.current) setSwitchModalVisible(false);

      Alert.alert("Linked", "Fleet updated.");
    } catch (e) {
      const msg = e?.message || "Could not switch fleets.";
      console.log("switch fleet error:", msg);

      // restore previous context
      try {
        await AsyncStorage.removeItem(STORAGE_KEY_INVITE_CODE);
      } catch {}

      try {
        if (prevGroupId) {
          await AsyncStorage.setItem(STORAGE_KEY_GROUP_ID, prevGroupId);
        } else {
          await AsyncStorage.removeItem(STORAGE_KEY_GROUP_ID);
        }
      } catch {}

      try {
        await loadFleetContext();
        await fetchFleet(prevGroupId || null);
      } catch {}

      setSwitchError(msg);
    } finally {
      setSwitching(false);
    }
  };

  // =========================
  // ✅ Remove Device (Baby Step 5)
  // =========================
  const tryRemoveDeviceRpc = async ({ deviceId, hard }) => {
    const d = String(deviceId || "").trim();
    if (!d) throw new Error("Invalid device id.");

    const flag = hard === true;

    // Try multiple common arg-name shapes so you don't get blocked by naming differences
    const attempts = [
      { p_device_id: d, p_full_wipe: flag },
      { p_device_id: d, p_purge: flag },
      { p_device_id: d, p_delete_history: flag },
      { p_device_id: d, p_delete: flag },
      { p_device_id: d, p_remove: flag },

      { device_id: d, full_wipe: flag },
      { device_id: d, purge: flag },
      { device_id: d, delete_history: flag },
      { device_id: d, delete: flag },
      { device_id: d, remove: flag },

      // In case boolean is optional / has a default
      { p_device_id: d },
      { device_id: d },
    ];

    let lastErr = null;

    for (const payload of attempts) {
      const { data, error } = await supabase.rpc(RPC_REMOVE_DEVICE, payload);

      if (!error) {
        // Some RPCs return void; some return {ok:true}
        if (data && typeof data === "object" && data.ok === false) {
          throw new Error(data.error || "Remove failed.");
        }
        return data ?? { ok: true };
      }

      lastErr = error;

      // If it's a "missing function/arg" style error, keep trying other payloads
      const msg = String(error?.message || "");
      const lower = msg.toLowerCase();

      const isParamMismatch =
        lower.includes("function") ||
        lower.includes("does not exist") ||
        lower.includes("parameter") ||
        lower.includes("unknown") ||
        lower.includes("pgrst") ||
        lower.includes("schema cache");

      if (isParamMismatch) continue;

      // If it's permission/auth-related, stop early
      if (lower.includes("not authenticated") || lower.includes("not authorized") || lower.includes("permission")) {
        throw error;
      }

      // otherwise continue one more try, but keep the error
    }

    throw lastErr || new Error("Remove failed.");
  };

  const openMemberMenu = (item) => {
    if (!isAdmin) return;

    const who = getFriendlyName(item?.device_id);
    Alert.alert("Options", who, [
      {
        text: "Remove from Fleet",
        style: "destructive",
        onPress: () => {
          Alert.alert("Confirm", `Remove ${who} from this fleet?`, [
            { text: "Cancel", style: "cancel" },
            {
              text: "Remove",
              style: "destructive",
              onPress: async () => {
                try {
                  if (removingDeviceId) return;
                  setRemovingDeviceId(String(item?.device_id || ""));
                  await tryRemoveDeviceRpc({ deviceId: item?.device_id, hard: true });

                  // optimistic UI
                  if (isMountedRef.current) {
                    setWorkers((prev) => (Array.isArray(prev) ? prev.filter((w) => String(w?.device_id) !== String(item?.device_id)) : prev));
                  }

                  // refresh
                  try {
                    await fetchFleet(groupId);
                  } catch {}

                  Alert.alert("Removed", "Device removed from fleet.");
                } catch (e) {
                  const msg = e?.message || "Could not remove device.";
                  console.log("remove device error:", msg);
                  Alert.alert("Error", msg);
                } finally {
                  setRemovingDeviceId(null);
                }
              },
            },
          ]);
        },
      },
      { text: "Cancel", style: "cancel" },
    ]);
  };

  const renderWorker = ({ item }) => {
    const status = computeDisplayStatus(item);
    const isSOS = status === "SOS";
    const isOnline = status === "ACTIVE" || isSOS;

    const lastSeen = safeTime(item?.last_updated);
    const label = getFriendlyName(item?.device_id);

    const showAdminDots = isAdmin && !adminLoading;

    const isRemovingThis = removingDeviceId && String(removingDeviceId) === String(item?.device_id);

    return (
      <View style={[styles.card, isSOS && styles.cardSOS, isOnline && !isSOS && styles.cardActive]}>
        {/* Header row is long-pressable for admin options (stealth) */}
        <Pressable onLongPress={() => openMemberMenu(item)} delayLongPress={650}>
          <View style={styles.cardHeader}>
            <View style={styles.row}>
              <View
                style={[
                  styles.statusDot,
                  { backgroundColor: isSOS ? "#ef4444" : isOnline ? "#22c55e" : "#64748b" },
                ]}
              />
              <View style={{ flexDirection: "column", flex: 1 }}>
                <Text style={[styles.workerName, isSOS && styles.workerNameSOS]} numberOfLines={1}>
                  {label}
                </Text>
                <Text style={[styles.subLabel, isSOS && styles.subLabelSOS]}>
                  {isSOS ? "🚨 SOS" : isOnline ? "ONLINE" : "OFFLINE"} • Last: {lastSeen}
                </Text>
                <Text style={styles.deviceLine}>Device: {shortId(item?.device_id)}</Text>
              </View>
            </View>

            <View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
              {showAdminDots ? (
                <TouchableOpacity
                  onPress={() => openMemberMenu(item)}
                  disabled={!!removingDeviceId}
                  style={[styles.dotsBtn, isRemovingThis && { opacity: 0.75 }]}
                  activeOpacity={0.8}
                >
                  {isRemovingThis ? (
                    <ActivityIndicator color="#e2e8f0" />
                  ) : (
                    <Ionicons name="ellipsis-vertical" size={16} color="#e2e8f0" />
                  )}
                </TouchableOpacity>
              ) : null}

              <Ionicons
                name={isSOS ? "warning" : isOnline ? "shield-checkmark" : "shield-outline"}
                size={18}
                color={isSOS ? "#ef4444" : isOnline ? "#22c55e" : "#64748b"}
              />
            </View>
          </View>
        </Pressable>

        <View style={styles.statsRow}>
          <View style={styles.stat}>
            <Ionicons name="battery-half" size={16} color={isSOS ? "#fecaca" : "#94a3b8"} />
            <Text style={[styles.statText, isSOS && styles.statTextSOS]}>{safePercent(item?.battery_level)}</Text>
          </View>

          <View style={styles.stat}>
            <Ionicons name="location-outline" size={16} color={isSOS ? "#fecaca" : "#94a3b8"} />
            <Text style={[styles.statText, isSOS && styles.statTextSOS]}>
              {safeCoords(item?.latitude, item?.longitude)}
            </Text>
          </View>
        </View>

        <View style={styles.cardActions}>
          <TouchableOpacity
            style={[styles.actionBtn, styles.liveBtn, isSOS && styles.liveBtnSOS]}
            onPress={() => openLiveView(item)}
          >
            <Ionicons name="videocam-outline" size={16} color={isSOS ? "#fee2e2" : "#0b1220"} />
            <Text style={[styles.actionBtnText, isSOS && styles.actionBtnTextSOS]}>Live View</Text>
          </TouchableOpacity>

          <TouchableOpacity
            style={[styles.actionBtn, styles.mapsBtn, isSOS && styles.mapsBtnSOS]}
            onPress={() => openMaps(item)}
          >
            <Ionicons name="map-outline" size={16} color={isSOS ? "#fee2e2" : "#e2e8f0"} />
            <Text style={[styles.actionBtnText, styles.actionBtnTextLight, isSOS && styles.actionBtnTextSOS]}>
              Maps
            </Text>
          </TouchableOpacity>

          <TouchableOpacity
            style={[styles.actionBtn, styles.coordsBtn, isSOS && styles.coordsBtnSOS]}
            onPress={() => showCoordinatesBox(item)}
          >
            <Ionicons name="pin-outline" size={16} color={isSOS ? "#fee2e2" : "#e2e8f0"} />
            <Text style={[styles.actionBtnText, styles.actionBtnTextLight, isSOS && styles.actionBtnTextSOS]}>
              Coords
            </Text>
          </TouchableOpacity>
        </View>
      </View>
    );
  };

  if (loading) {
    return (
      <View style={styles.centered}>
        <ActivityIndicator size="large" color="#22c55e" />
        <Text style={styles.loadingText}>Loading fleet…</Text>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      {/* ✅ Switch Fleet modal */}
      <Modal transparent visible={switchModalVisible} animationType="fade" onRequestClose={closeSwitchModal}>
        <Pressable style={styles.modalBackdrop} onPress={closeSwitchModal}>
          <Pressable style={styles.modalCard} onPress={() => {}}>
            <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : undefined}>
              <View style={styles.modalHeaderRow}>
                <View style={styles.modalTitleRow}>
                  <Ionicons name="swap-horizontal" size={18} color="#e2e8f0" />
                  <Text style={styles.modalTitle}>Switch Fleet</Text>
                </View>

                <TouchableOpacity onPress={closeSwitchModal} disabled={switching} style={styles.modalCloseBtn}>
                  <Ionicons name="close" size={18} color="#94a3b8" />
                </TouchableOpacity>
              </View>

              <Text style={styles.modalHint}>Enter an invite code to link a different fleet. You will stay logged in.</Text>

              <TextInput
                value={switchInviteInput}
                onChangeText={(t) => setSwitchInviteInput(t)}
                placeholder="Invite Code"
                placeholderTextColor="#64748b"
                autoCapitalize="characters"
                style={styles.modalInput}
                editable={!switching}
              />

              {!!switchError && <Text style={styles.modalError}>⚠ {switchError}</Text>}

              <View style={styles.modalBtnRow}>
                <TouchableOpacity
                  style={[styles.modalBtn, styles.modalBtnGhost]}
                  onPress={closeSwitchModal}
                  disabled={switching}
                  activeOpacity={0.85}
                >
                  <Text style={styles.modalBtnGhostText}>Cancel</Text>
                </TouchableOpacity>

                <TouchableOpacity
                  style={[styles.modalBtn, styles.modalBtnPrimary, switching && { opacity: 0.75 }]}
                  onPress={handleSwitchFleet}
                  disabled={switching}
                  activeOpacity={0.9}
                >
                  {switching ? (
                    <ActivityIndicator color="#0b1220" />
                  ) : (
                    <>
                      <Ionicons name="link-outline" size={16} color="#0b1220" />
                      <Text style={styles.modalBtnPrimaryText}>Link</Text>
                    </>
                  )}
                </TouchableOpacity>
              </View>
            </KeyboardAvoidingView>
          </Pressable>
        </Pressable>
      </Modal>

      <View style={styles.header}>
        {/* ✅ stealth back/menu + switch controls */}
        <View style={styles.headerTopRow}>
          <TouchableOpacity onPress={goBackToMenu} style={styles.backBtn} activeOpacity={0.75}>
            <Ionicons name="chevron-back" size={18} color="#e2e8f0" />
            <Text style={styles.backText}>Back</Text>
          </TouchableOpacity>

          <View style={{ flex: 1 }} />

          <TouchableOpacity onPress={openSwitchModal} style={styles.switchBtn} activeOpacity={0.8}>
            <Ionicons name="swap-horizontal" size={16} color="#e2e8f0" />
            <Text style={styles.switchText}>Switch</Text>
          </TouchableOpacity>
        </View>

        <Text style={styles.headerTitle}>Fleet Manager</Text>
        <Text style={styles.headerSub}>
          {sortedWorkers.length} member{sortedWorkers.length === 1 ? "" : "s"} visible
          {!!groupId ? ` • Fleet ${String(groupId).slice(0, 8)}…` : ""}
          {isAdmin ? " • Manager" : ""}
        </Text>

        {!!incomingSos?.device_id && (
          <View style={styles.sosBroadcastBanner}>
            <Ionicons name="warning" size={16} color="#fee2e2" />
            <Text style={styles.sosBroadcastText} numberOfLines={1}>
              Incoming SOS ping: {getFriendlyName(incomingSos.device_id)}
            </Text>
          </View>
        )}

        {!!groupId ? (
          <View style={styles.fleetInfoCard}>
            <View style={styles.fleetInfoRow}>
              <Text style={styles.fleetInfoLabel}>Invite Code</Text>
              <View style={styles.inviteRow}>
                <Text style={styles.inviteCode} selectable>
                  {inviteLoading ? "Loading…" : inviteCode || "—"}
                </Text>

                <TouchableOpacity
                  style={[styles.copyBtn, !inviteCode && styles.copyBtnDisabled]}
                  onPress={shareInviteCode}
                  disabled={!inviteCode}
                >
                  <Ionicons name="share-outline" size={16} color="#0b1220" />
                </TouchableOpacity>
              </View>
            </View>

            {hasSOS && firstSOS && (
              <View style={styles.sosPanel}>
                <View style={{ flex: 1 }}>
                  <Text style={styles.sosTitle}>🚨 SOS ACTIVE</Text>
                  <Text style={styles.sosWho} numberOfLines={1}>
                    {getFriendlyName(firstSOS?.device_id)}
                  </Text>
                  <Text style={styles.sosCoords}>{safeCoords(firstSOS?.latitude, firstSOS?.longitude)}</Text>
                </View>

                <View style={styles.sosBtns}>
                  <TouchableOpacity style={styles.sosLiveBtn} onPress={() => openSosLiveView(sortedWorkers)}>
                    <Ionicons name="warning-outline" size={18} color="#fee2e2" />
                    <Text style={styles.sosLiveBtnText}>LIVE VIEW</Text>
                  </TouchableOpacity>

                  <TouchableOpacity style={styles.sosCoordsBtn} onPress={() => showCoordinatesBox(firstSOS)}>
                    <Ionicons name="pin-outline" size={18} color="#e2e8f0" />
                    <Text style={styles.sosCoordsBtnText}>COORDS</Text>
                  </TouchableOpacity>
                </View>
              </View>
            )}

            <Text style={styles.fleetInfoHint}>
              Only devices in your fleet appear here (same invite code / group).
              {"\n"}Use “LIVE VIEW” when SOS triggers, and “COORDS” to read to police.
              {isAdmin ? "\n(Manager: long-press a member card header or tap ⋯ to remove old devices.)" : ""}
            </Text>
          </View>
        ) : (
          <Text style={styles.noFleetHint}>No fleet linked yet. Go to Login and use Join Fleet or Create Fleet.</Text>
        )}

        {!!errorText && <Text style={styles.errorText}>⚠ {errorText}</Text>}
      </View>

      <FlatList
        data={sortedWorkers}
        keyExtractor={(item, idx) => String(item?.device_id || `row-${idx}`)}
        renderItem={renderWorker}
        contentContainerStyle={styles.list}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={() => {
              setRefreshing(true);
              fetchFleet();
            }}
            tintColor="#22c55e"
          />
        }
        ListEmptyComponent={
          <Text style={styles.emptyText}>
            No devices are reporting yet.
            {"\n"}(Once a member logs in + GPS syncs, they will appear here.)
          </Text>
        }
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#0b1220" },
  centered: {
    flex: 1,
    backgroundColor: "#0b1220",
    justifyContent: "center",
    alignItems: "center",
  },
  loadingText: { color: "#475569", marginTop: 12, fontSize: 12 },

  header: { padding: 22, paddingTop: 56, backgroundColor: "#0f172a" },

  headerTopRow: { flexDirection: "row", alignItems: "center", marginBottom: 10 },
  backBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    paddingVertical: 8,
    paddingHorizontal: 10,
    borderRadius: 12,
    backgroundColor: "rgba(148, 163, 184, 0.08)",
    borderWidth: 1,
    borderColor: "rgba(148, 163, 184, 0.16)",
    alignSelf: "flex-start",
  },
  backText: { color: "#e2e8f0", fontWeight: "900", fontSize: 12, letterSpacing: 0.4 },

  switchBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingVertical: 8,
    paddingHorizontal: 10,
    borderRadius: 12,
    backgroundColor: "rgba(148, 163, 184, 0.08)",
    borderWidth: 1,
    borderColor: "rgba(148, 163, 184, 0.16)",
  },
  switchText: { color: "#e2e8f0", fontWeight: "900", fontSize: 12, letterSpacing: 0.4 },

  headerTitle: { color: "white", fontSize: 24, fontWeight: "900", letterSpacing: 1 },
  headerSub: { color: "#94a3b8", fontSize: 13, marginTop: 6 },
  errorText: { color: "#fca5a5", marginTop: 10, fontSize: 12 },

  sosBroadcastBanner: {
    marginTop: 12,
    borderRadius: 12,
    paddingVertical: 10,
    paddingHorizontal: 12,
    backgroundColor: "rgba(239, 68, 68, 0.12)",
    borderWidth: 1,
    borderColor: "rgba(239, 68, 68, 0.28)",
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
  },
  sosBroadcastText: {
    color: "#fee2e2",
    fontWeight: "900",
    letterSpacing: 0.3,
    fontSize: 12,
    flex: 1,
  },

  fleetInfoCard: {
    marginTop: 14,
    padding: 14,
    borderRadius: 14,
    backgroundColor: "#0b1220",
    borderWidth: 1,
    borderColor: "rgba(34, 197, 94, 0.25)",
  },
  fleetInfoRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: 10,
  },
  fleetInfoLabel: { color: "#94a3b8", fontSize: 12, fontWeight: "800", letterSpacing: 0.6 },

  inviteRow: { flexDirection: "row", alignItems: "center", gap: 10 },
  inviteCode: { color: "#22c55e", fontSize: 18, fontWeight: "900", letterSpacing: 2 },

  copyBtn: {
    width: 34,
    height: 34,
    borderRadius: 10,
    backgroundColor: "#22c55e",
    alignItems: "center",
    justifyContent: "center",
  },
  copyBtnDisabled: { opacity: 0.35 },

  sosPanel: {
    marginTop: 10,
    borderRadius: 14,
    padding: 12,
    backgroundColor: "rgba(239, 68, 68, 0.12)",
    borderWidth: 1,
    borderColor: "rgba(239, 68, 68, 0.35)",
    flexDirection: "row",
    gap: 12,
    alignItems: "center",
  },
  sosTitle: { color: "#fee2e2", fontWeight: "900", letterSpacing: 1, fontSize: 12 },
  sosWho: { color: "white", fontWeight: "900", fontSize: 14, marginTop: 2 },
  sosCoords: { color: "#fecaca", fontWeight: "900", letterSpacing: 0.4, marginTop: 4 },

  sosBtns: { flexDirection: "column", gap: 8 },
  sosLiveBtn: {
    borderRadius: 12,
    paddingVertical: 10,
    paddingHorizontal: 12,
    backgroundColor: "rgba(239, 68, 68, 0.20)",
    borderWidth: 1,
    borderColor: "rgba(239, 68, 68, 0.35)",
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
  },
  sosLiveBtnText: { color: "#fee2e2", fontWeight: "900", letterSpacing: 1, fontSize: 12 },

  sosCoordsBtn: {
    borderRadius: 12,
    paddingVertical: 10,
    paddingHorizontal: 12,
    backgroundColor: "rgba(148, 163, 184, 0.10)",
    borderWidth: 1,
    borderColor: "rgba(148, 163, 184, 0.22)",
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
  },
  sosCoordsBtnText: { color: "#e2e8f0", fontWeight: "900", letterSpacing: 1, fontSize: 12 },

  fleetInfoHint: {
    color: "#64748b",
    fontSize: 12,
    lineHeight: 16,
    fontWeight: "700",
    marginTop: 10,
  },
  noFleetHint: { color: "#64748b", fontSize: 12, marginTop: 12, fontWeight: "700" },

  list: { padding: 14 },

  card: {
    backgroundColor: "#1e293b",
    padding: 14,
    borderRadius: 14,
    marginBottom: 12,
    borderWidth: 1,
    borderColor: "#0f172a",
  },

  cardSOS: {
    borderColor: "#ef4444",
    borderWidth: 2,
    backgroundColor: "rgba(239, 68, 68, 0.10)",
  },

  cardActive: {
    borderColor: "rgba(34, 197, 94, 0.3)",
  },

  cardHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "flex-start",
    marginBottom: 10,
  },

  row: { flexDirection: "row", alignItems: "flex-start" },
  statusDot: { width: 8, height: 8, borderRadius: 999, marginRight: 10, marginTop: 6 },

  workerName: { color: "white", fontWeight: "900", fontSize: 16 },
  workerNameSOS: { color: "#fee2e2" },

  subLabel: { color: "#64748b", fontSize: 12, marginTop: 2, fontWeight: "700" },
  subLabelSOS: { color: "#fecaca" },

  deviceLine: { color: "#475569", fontSize: 11, marginTop: 4, fontWeight: "700" },

  dotsBtn: {
    width: 32,
    height: 32,
    borderRadius: 12,
    backgroundColor: "rgba(148, 163, 184, 0.08)",
    borderWidth: 1,
    borderColor: "rgba(148, 163, 184, 0.14)",
    justifyContent: "center",
    alignItems: "center",
  },

  statsRow: { flexDirection: "row", gap: 18 },

  stat: { flexDirection: "row", alignItems: "center", gap: 6 },
  statText: { color: "#94a3b8", fontSize: 13, fontWeight: "700" },
  statTextSOS: { color: "#fee2e2" },

  cardActions: {
    marginTop: 12,
    flexDirection: "row",
    justifyContent: "flex-end",
    gap: 10,
    flexWrap: "wrap",
  },

  actionBtn: {
    borderRadius: 12,
    paddingVertical: 10,
    paddingHorizontal: 12,
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },

  liveBtn: { backgroundColor: "#22c55e" },
  liveBtnSOS: {
    backgroundColor: "rgba(239, 68, 68, 0.2)",
    borderWidth: 1,
    borderColor: "rgba(239, 68, 68, 0.35)",
  },

  mapsBtn: {
    backgroundColor: "rgba(148, 163, 184, 0.12)",
    borderWidth: 1,
    borderColor: "rgba(148, 163, 184, 0.20)",
  },
  mapsBtnSOS: {
    backgroundColor: "rgba(239, 68, 68, 0.16)",
    borderWidth: 1,
    borderColor: "rgba(239, 68, 68, 0.30)",
  },

  coordsBtn: {
    backgroundColor: "rgba(148, 163, 184, 0.12)",
    borderWidth: 1,
    borderColor: "rgba(148, 163, 184, 0.20)",
  },
  coordsBtnSOS: {
    backgroundColor: "rgba(239, 68, 68, 0.16)",
    borderWidth: 1,
    borderColor: "rgba(239, 68, 68, 0.30)",
  },

  actionBtnText: { fontWeight: "900", fontSize: 12, letterSpacing: 0.6 },
  actionBtnTextSOS: { color: "#fee2e2" },
  actionBtnTextLight: { color: "#e2e8f0" },

  emptyText: { color: "#475569", textAlign: "center", marginTop: 50, lineHeight: 20 },

  // =========================
  // ✅ Modal styles (Switch Fleet)
  // =========================
  modalBackdrop: {
    flex: 1,
    backgroundColor: "rgba(2, 6, 23, 0.72)",
    justifyContent: "center",
    alignItems: "center",
    padding: 18,
  },
  modalCard: {
    width: "100%",
    maxWidth: 420,
    borderRadius: 18,
    backgroundColor: "#0f172a",
    borderWidth: 1,
    borderColor: "rgba(148, 163, 184, 0.18)",
    padding: 16,
  },
  modalHeaderRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  modalTitleRow: { flexDirection: "row", alignItems: "center", gap: 10 },
  modalTitle: { color: "white", fontSize: 16, fontWeight: "900", letterSpacing: 0.6 },
  modalCloseBtn: {
    width: 34,
    height: 34,
    borderRadius: 12,
    backgroundColor: "rgba(148, 163, 184, 0.08)",
    borderWidth: 1,
    borderColor: "rgba(148, 163, 184, 0.14)",
    justifyContent: "center",
    alignItems: "center",
  },
  modalHint: { color: "#94a3b8", fontSize: 12, fontWeight: "700", marginTop: 10, lineHeight: 16 },
  modalInput: {
    marginTop: 12,
    backgroundColor: "#0b1220",
    borderRadius: 12,
    paddingVertical: 12,
    paddingHorizontal: 12,
    borderWidth: 1,
    borderColor: "rgba(148, 163, 184, 0.14)",
    color: "#e2e8f0",
    fontWeight: "900",
    letterSpacing: 1.2,
  },
  modalError: { color: "#fca5a5", marginTop: 10, fontSize: 12, fontWeight: "800" },
  modalBtnRow: { flexDirection: "row", gap: 10, marginTop: 14 },
  modalBtn: {
    flex: 1,
    borderRadius: 14,
    paddingVertical: 12,
    alignItems: "center",
    justifyContent: "center",
    flexDirection: "row",
    gap: 8,
  },
  modalBtnGhost: {
    backgroundColor: "rgba(148, 163, 184, 0.08)",
    borderWidth: 1,
    borderColor: "rgba(148, 163, 184, 0.16)",
  },
  modalBtnGhostText: { color: "#e2e8f0", fontWeight: "900", letterSpacing: 0.6, fontSize: 12 },
  modalBtnPrimary: { backgroundColor: "#22c55e" },
  modalBtnPrimaryText: { color: "#0b1220", fontWeight: "900", letterSpacing: 0.8, fontSize: 12 },
});

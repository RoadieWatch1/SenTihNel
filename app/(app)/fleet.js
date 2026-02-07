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
import { useNavigation, DrawerActions } from "@react-navigation/native";
import { getDeviceId } from "../../src/services/Identity";
import { forceOneShotSync } from "../../src/services/LiveTracker";
import { handshakeDevice } from "../../src/services/deviceHandshake";

// Prefer SecureStore for PIN hash (encrypted on device); fall back to AsyncStorage
let SecureStore = null;
try {
  SecureStore = require("expo-secure-store");
} catch {}

const PIN_STORAGE_KEY = "sentinel_pin_hash";

async function readPinHash() {
  if (SecureStore?.getItemAsync) {
    try {
      const v = await SecureStore.getItemAsync(PIN_STORAGE_KEY);
      if (v) return v;
    } catch {}
  }
  try { return await AsyncStorage.getItem(PIN_STORAGE_KEY); } catch {}
  return null;
}

async function writePinHash(hash) {
  if (SecureStore?.setItemAsync) {
    try { await SecureStore.setItemAsync(PIN_STORAGE_KEY, hash); } catch {}
  }
  try { await AsyncStorage.setItem(PIN_STORAGE_KEY, hash); } catch {}
}

const STORAGE_KEY_GROUP_ID = "sentinel_group_id";
const STORAGE_KEY_INVITE_CODE = "sentinel_invite_code";

// ✅ RPCs
const RPC_JOIN_GROUP = "join_group_with_invite_code";
const RPC_GET_GROUP_ID = "get_group_id_by_invite_code";
const RPC_REMOVE_DEVICE = "remove_device_from_fleet";
const RPC_HAS_SOS_PIN = "has_user_sos_pin";
const RPC_SET_SOS_PIN = "set_user_sos_pin";

// Simple hash function for PIN (consistent across app)
const hashPin = (pin) => {
  // Simple hash - in production you might use a proper crypto library
  let hash = 0;
  const str = String(pin || "");
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash; // Convert to 32bit integer
  }
  return `pin_${Math.abs(hash).toString(16).padStart(8, '0')}`;
};

// ✅ Your guardian dashboard base URL (existing public dashboard)
const GUARDIAN_DASHBOARD_URL = "https://sentihnel.com/";

// Local UI rule: if a device hasn't updated recently, show it as OFFLINE
const OFFLINE_AFTER_MS = 3 * 60 * 1000; // 3 minutes

// ✅ Battery warning thresholds
const BATTERY_LOW_THRESHOLD = 20;      // Yellow warning
const BATTERY_CRITICAL_THRESHOLD = 10; // Red warning

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
  const navigation = useNavigation();

  // ✅ Stealth back/menu: opens the drawer menu (Access page)
  const goBackToMenu = useCallback(() => {
    try {
      navigation.dispatch(DrawerActions.openDrawer());
    } catch (e) {
      try {
        router.replace("/(app)/home");
      } catch {}
    }
  }, [navigation, router]);

  const [workers, setWorkers] = useState([]);
  const [nameByDevice, setNameByDevice] = useState({}); // device_id -> display_name

  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [errorText, setErrorText] = useState("");

  const [groupId, setGroupId] = useState(null);
  const [inviteCode, setInviteCode] = useState("");
  const [inviteLoading, setInviteLoading] = useState(true);

  // ✅ Fleet Tabs - Work/Family toggle
  const [activeTab, setActiveTab] = useState("family"); // "work" or "family"
  const [ownedFleets, setOwnedFleets] = useState({
    work: { groupId: null, inviteCode: null },
    family: { groupId: null, inviteCode: null },
  });
  const [fleetsLoading, setFleetsLoading] = useState(true);

  // Optional: show a quick banner when an SOS broadcast hits
  const [incomingSos, setIncomingSos] = useState(null);

  // ✅ Check-in notifications
  const [recentCheckIns, setRecentCheckIns] = useState([]);

  // ✅ Switch Fleet modal
  const [switchModalVisible, setSwitchModalVisible] = useState(false);
  const [switchInviteInput, setSwitchInviteInput] = useState("");
  const [switchFleetType, setSwitchFleetType] = useState("family"); // "family" or "work"
  const [switching, setSwitching] = useState(false);
  const [switchError, setSwitchError] = useState("");

  // ✅ Admin detection + remove device
  const [isAdmin, setIsAdmin] = useState(false);
  const [adminLoading, setAdminLoading] = useState(false);
  const [removingDeviceId, setRemovingDeviceId] = useState(null);

  // ✅ SOS PIN setup
  const [hasPin, setHasPin] = useState(null); // null = loading, true/false = known
  const [pinModalVisible, setPinModalVisible] = useState(false);
  const [pinStep, setPinStep] = useState(1); // 1 = enter, 2 = confirm
  const [pinInput, setPinInput] = useState("");
  const [pinConfirm, setPinConfirm] = useState("");
  const [pinError, setPinError] = useState("");
  const [pinSaving, setPinSaving] = useState(false);

  // ✅ Collapsible panel states (default collapsed to not block fleet members list)
  const [inviteCodeExpanded, setInviteCodeExpanded] = useState(false);
  const [pinSectionExpanded, setPinSectionExpanded] = useState(false);

  // Throttle realtime refreshes
  const refetchTimerRef = useRef(null);

  // Realtime channels
  const pgChannelRef = useRef(null);
  const broadcastChannelRef = useRef(null);

  const isMountedRef = useRef(true);
  const fetchingRef = useRef(false);
  const appStateRef = useRef(AppState.currentState);
  const initialBootDoneRef = useRef(false); // ✅ Prevent boot from running multiple times
  const activeGroupIdRef = useRef(null); // ✅ Track active group to prevent stale subscription data

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

  // ✅ Relative time helper (e.g., "2 min ago")
  const getRelativeTime = (iso) => {
    try {
      if (!iso) return null;
      const d = new Date(iso);
      if (Number.isNaN(d.getTime())) return null;

      const now = Date.now();
      const diff = now - d.getTime();

      if (diff < 0) return "just now";
      if (diff < 60000) return "just now";
      if (diff < 120000) return "1 min ago";
      if (diff < 3600000) return `${Math.floor(diff / 60000)} min ago`;
      if (diff < 7200000) return "1 hr ago";
      if (diff < 86400000) return `${Math.floor(diff / 3600000)} hrs ago`;
      return `${Math.floor(diff / 86400000)} days ago`;
    } catch {
      return null;
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

  // ✅ Battery status helper
  const computeBatteryStatus = (batteryLevel) => {
    const level = typeof batteryLevel === "number" ? batteryLevel : parseInt(batteryLevel, 10);
    if (Number.isNaN(level) || level < 0) return "unknown";
    if (level <= BATTERY_CRITICAL_THRESHOLD) return "critical";
    if (level <= BATTERY_LOW_THRESHOLD) return "low";
    return "ok";
  };

  const getBatteryIcon = (batteryStatus, level) => {
    if (batteryStatus === "critical") return "battery-dead";
    if (batteryStatus === "low") return "battery-half";
    if (level >= 70) return "battery-full";
    if (level >= 40) return "battery-half";
    return "battery-half";
  };

  const getBatteryColor = (batteryStatus, isSOS) => {
    if (isSOS) return "#fecaca";
    if (batteryStatus === "critical") return "#ef4444";
    if (batteryStatus === "low") return "#fbbf24";
    return "#94a3b8";
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
      if (gidStr) activeGroupIdRef.current = gidStr; // ✅ Track active group
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

  // ✅ Ensure user has both Work and Family fleets (auto-create on first load)
  const ensureUserFleets = useCallback(async () => {
    try {
      setFleetsLoading(true);

      const { data, error } = await supabase.rpc("ensure_user_fleets");

      if (error) {
        console.log("ensure_user_fleets error:", error.message);
        // Fall back to loading from context if RPC doesn't exist yet
        return null;
      }

      if (data?.success) {
        const workFleet = data.work_fleet || {};
        const familyFleet = data.family_fleet || {};

        const newOwnedFleets = {
          work: {
            groupId: workFleet.group_id || null,
            inviteCode: workFleet.invite_code || null,
          },
          family: {
            groupId: familyFleet.group_id || null,
            inviteCode: familyFleet.invite_code || null,
          },
        };

        if (isMountedRef.current) {
          setOwnedFleets(newOwnedFleets);
        }

        console.log("✅ User fleets ensured:", {
          work: workFleet.group_id?.slice(0, 8),
          family: familyFleet.group_id?.slice(0, 8),
        });

        return newOwnedFleets;
      }

      return null;
    } catch (e) {
      console.log("ensureUserFleets error:", e?.message || e);
      return null;
    } finally {
      if (isMountedRef.current) setFleetsLoading(false);
    }
  }, []);

  // ✅ After login, don't trust cached group_id.
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

        activeGroupIdRef.current = gid; // ✅ Track active group
        if (isMountedRef.current) {
          setGroupId(gid);
          setInviteCode("");
          setRecentCheckIns([]); // ✅ Clear stale banners from previous fleet
          setIncomingSos(null);
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

  // ✅ Check if user has SOS PIN set (falls back to local cache if Supabase is unreachable)
  const checkHasPin = useCallback(async () => {
    try {
      const { data, error } = await supabase.rpc(RPC_HAS_SOS_PIN);
      if (error) {
        console.log("checkHasPin warning:", error.message);
        // Fall back to local cache
        const cached = await readPinHash();
        if (isMountedRef.current) setHasPin(!!cached);
        return;
      }
      const result = data?.has_pin === true;
      if (isMountedRef.current) setHasPin(result);
    } catch (e) {
      console.log("checkHasPin error:", e?.message || e);
      // Fall back to local cache
      try {
        const cached = await readPinHash();
        if (isMountedRef.current) setHasPin(!!cached);
      } catch {
        if (isMountedRef.current) setHasPin(false);
      }
    }
  }, []);

  useEffect(() => {
    checkHasPin();
  }, [checkHasPin]);

  // ✅ PIN modal handlers
  const openPinModal = () => {
    setPinStep(1);
    setPinInput("");
    setPinConfirm("");
    setPinError("");
    setPinModalVisible(true);
  };

  const closePinModal = () => {
    if (pinSaving) return;
    setPinModalVisible(false);
    setPinError("");
  };

  const handlePinDigit = (digit) => {
    if (pinSaving) return;
    if (pinStep === 1) {
      if (pinInput.length < 4) {
        setPinInput((prev) => prev + digit);
        setPinError("");
      }
    } else {
      if (pinConfirm.length < 4) {
        setPinConfirm((prev) => prev + digit);
        setPinError("");
      }
    }
  };

  const handlePinBackspace = () => {
    if (pinSaving) return;
    if (pinStep === 1) {
      setPinInput((prev) => prev.slice(0, -1));
    } else {
      setPinConfirm((prev) => prev.slice(0, -1));
    }
    setPinError("");
  };

  const handlePinNext = async () => {
    if (pinSaving) return;

    if (pinStep === 1) {
      if (pinInput.length !== 4) {
        setPinError("Enter a 4-digit PIN");
        return;
      }
      setPinStep(2);
      setPinError("");
      return;
    }

    // Step 2: Confirm
    if (pinConfirm.length !== 4) {
      setPinError("Confirm your 4-digit PIN");
      return;
    }

    if (pinInput !== pinConfirm) {
      setPinError("PINs do not match. Try again.");
      setPinStep(1);
      setPinInput("");
      setPinConfirm("");
      return;
    }

    // Save PIN
    setPinSaving(true);
    setPinError("");

    try {
      const hashed = hashPin(pinInput);

      // Always save locally first (SecureStore + AsyncStorage fallback)
      await writePinHash(hashed);

      // Verify the save actually worked
      const verify = await readPinHash();
      if (verify !== hashed) {
        throw new Error("PIN failed to save to device storage. Please try again.");
      }
      console.log("✅ PIN saved locally, hash:", hashed.slice(0, 12) + "...");

      // Sync to Supabase (upsert — works for both new and changed PINs)
      let cloudSaved = false;
      let cloudError = null;
      try {
        const { data, error } = await Promise.race([
          supabase.rpc(RPC_SET_SOS_PIN, { p_pin_hash: hashed }),
          new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), 6000)),
        ]);

        if (!error && data?.success !== false) {
          cloudSaved = true;
        } else {
          cloudError = error?.message || data?.error || "Server rejected PIN save";
          console.log("PIN cloud save rejected:", cloudError);
        }
      } catch (e) {
        cloudError = e?.message || "Network error";
        console.log("PIN cloud save failed (saved locally):", cloudError);
      }

      if (isMountedRef.current) {
        setHasPin(true);
        setPinModalVisible(false);
      }

      Alert.alert(
        cloudSaved ? "PIN Saved" : "PIN Saved Locally",
        cloudSaved
          ? "Your SOS PIN is saved. If you change it later, your old PIN will stop working."
          : `PIN saved to this device but could not sync to server (${cloudError}). It will work on this device but may not work after reinstall.`
      );
    } catch (e) {
      const msg = e?.message || "Could not save PIN";
      console.log("save PIN error:", msg);
      setPinError(msg);
    } finally {
      setPinSaving(false);
    }
  };

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
          .select("device_id, group_id, latitude, longitude, battery_level, status, last_updated, gps_quality, gps_accuracy_m, speed, heading")
          .eq("group_id", gid)
          .order("last_updated", { ascending: false });

        if (error) throw error;

        // ✅ Check if this fetch is still relevant (prevents stale data from old subscription)
        if (activeGroupIdRef.current && gid !== activeGroupIdRef.current) {
          console.log("🟡 Ignoring stale fleet fetch:", gid?.slice(0, 8), "active:", activeGroupIdRef.current?.slice(0, 8));
          return;
        }

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

  // ✅ Handle tab switch between user's OWN fleets (Work/Family)
  // NOTE: Switching tabs only VIEWS the fleet - device stays in its current tracking fleet
  // Device only moves when user explicitly joins a fleet via invite code
  const handleTabSwitch = useCallback(async (tab) => {
    if (tab === activeTab) return;

    const fleet = ownedFleets[tab];
    if (!fleet?.groupId) {
      console.log("Tab switch: No fleet found for tab", tab);
      return;
    }

    // ✅ Set active group ref FIRST to prevent stale subscription callbacks
    activeGroupIdRef.current = fleet.groupId;

    // Update tab state (VIEW only - don't change tracking fleet)
    setActiveTab(tab);
    setSwitchFleetType(tab); // ✅ Fix #1: keep switch modal in sync with active tab

    // ✅ Update VIEW state but DON'T update AsyncStorage (device stays in current tracking fleet)
    // NOTE: groupId here is the VIEW fleet (subscriptions + list), not necessarily the device tracking fleet.
    if (isMountedRef.current) {
      setGroupId(fleet.groupId);
      setInviteCode(fleet.inviteCode || "");
      setInviteLoading(false);
      setWorkers([]);
      setNameByDevice({});
      setRecentCheckIns([]); // ✅ Fix #5: clear stale check-ins from previous fleet
      setIncomingSos(null);  // ✅ Fix #5: clear stale SOS from previous fleet
    }

    // Fetch members for this fleet (view only)
    await fetchFleet(fleet.groupId);

    console.log("✅ Viewing", tab, "fleet:", fleet.groupId?.slice(0, 8));
  }, [activeTab, ownedFleets, fetchFleet]);

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

  // ✅ Battery warnings summary
  const lowBatteryMembers = useMemo(() => {
    return sortedWorkers.filter((w) => {
      const status = computeDisplayStatus(w);
      if (status === "OFFLINE") return false; // Don't warn about offline devices
      const batteryStatus = computeBatteryStatus(w?.battery_level);
      return batteryStatus === "low" || batteryStatus === "critical";
    });
  }, [sortedWorkers]);

  const hasLowBattery = lowBatteryMembers.length > 0;

  const criticalBatteryCount = useMemo(() => {
    return lowBatteryMembers.filter((w) => computeBatteryStatus(w?.battery_level) === "critical").length;
  }, [lowBatteryMembers]);

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

    // ✅ Prevent boot from running multiple times (causes re-render loops)
    if (initialBootDoneRef.current) {
      console.log("Boot already done, skipping");
      return;
    }
    initialBootDoneRef.current = true;

    setLoading(true);

    try {
      // ✅ First, ensure user has both Work and Family fleets (timeout: 8s)
      let fleets = null;
      try {
        fleets = await Promise.race([
          ensureUserFleets(),
          new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), 8000)),
        ]);
      } catch (e) {
        console.log("ensureUserFleets timed out or failed:", e?.message || e);
      }

      // Default to Family fleet on initial load (user can switch via tabs)
      let gidToUse = null;
      let codeToUse = null;

      // ✅ Fix #2: Always reconcile from device row first (source of truth for tracking).
      // ensureUserFleets is for VIEW only — don't write to AsyncStorage from it.
      let reconciledGid = null;
      try {
        reconciledGid = await Promise.race([
          reconcileGroupFromDeviceRow(),
          new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), 6000)),
        ]);
      } catch (e) {
        console.log("reconcileGroup timed out or failed:", e?.message || e);
      }

      if (reconciledGid) {
        // Device row is the source of truth for tracking
        gidToUse = reconciledGid;
        activeGroupIdRef.current = gidToUse;
      } else if (fleets) {
        // No device row yet — use ensured fleet for VIEW only (don't stomp storage)
        const defaultFleet = fleets.family || fleets.work;
        if (defaultFleet?.groupId) {
          gidToUse = defaultFleet.groupId;
          codeToUse = defaultFleet.inviteCode;
          activeGroupIdRef.current = gidToUse;
          if (isMountedRef.current) {
            setGroupId(gidToUse);
            setInviteCode(codeToUse || "");
            setInviteLoading(false);
          }
        }
      } else {
        // Fall back to cached context
        const cachedGid = await loadFleetContext();
        gidToUse = cachedGid;
        if (gidToUse) activeGroupIdRef.current = gidToUse;
      }

      await fetchFleet(gidToUse);
    } catch (e) {
      console.log("boot error:", e?.message || e);
      if (isMountedRef.current) setErrorText("Could not load fleet. Pull down to retry.");
    } finally {
      if (isMountedRef.current) setLoading(false);
    }
  }, [fetchFleet, loadFleetContext, reconcileGroupFromDeviceRow, ensureUserFleets]);

  // ✅ Force retry boot (resets the boot guard so boot() can run again)
  const retryBoot = useCallback(() => {
    initialBootDoneRef.current = false;
    setErrorText("");
    boot();
  }, [boot]);

  useEffect(() => {
    boot();
  }, [boot]);

  // ✅ Safety timeout: if loading stays true for 12 seconds, force-stop and show retry
  useEffect(() => {
    if (!loading) return;
    const timer = setTimeout(() => {
      if (isMountedRef.current && loading) {
        console.log("⚠️ Fleet loading safety timeout (12s)");
        setLoading(false);
        setErrorText("Loading timed out. Tap to retry.");
      }
    }, 12000);
    return () => clearTimeout(timer);
  }, [loading]);

  useEffect(() => {
    const { data } = supabase.auth.onAuthStateChange(async (event) => {
      if (event === "SIGNED_OUT") {
        try {
          await AsyncStorage.multiRemove([STORAGE_KEY_GROUP_ID, STORAGE_KEY_INVITE_CODE]);
        } catch {}
        activeGroupIdRef.current = null; // ✅ Clear active group tracking
        if (isMountedRef.current) {
          setGroupId(null);
          setInviteCode("");
          setWorkers([]);
          setNameByDevice({});
          setErrorText("");
          setIsAdmin(false);
          setOwnedFleets({ work: { groupId: null, inviteCode: null }, family: { groupId: null, inviteCode: null } });
          setActiveTab("family");
        }
        // ✅ Reset boot flag so boot can run again after sign-in
        initialBootDoneRef.current = false;
        return;
      }

      if (event === "SIGNED_IN" || event === "TOKEN_REFRESHED") {
        // ✅ Reset boot flag to allow fresh boot on sign-in
        initialBootDoneRef.current = false;
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
        // ✅ Fix #6: use ref to avoid stale closure over groupId
        const gid = activeGroupIdRef.current;
        if (gid) fetchFleet(gid);
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
          // ✅ Check if this subscription is still for the active group
          if (activeGroupIdRef.current && groupId !== activeGroupIdRef.current) {
            console.log("🟡 Ignoring stale subscription event:", groupId?.slice(0, 8));
            return;
          }

          if (refetchTimerRef.current) return;

          refetchTimerRef.current = setTimeout(() => {
            refetchTimerRef.current = null;
            // Double-check still active before fetching
            if (activeGroupIdRef.current && groupId !== activeGroupIdRef.current) return;
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

    const subscribedGroup = groupId; // ✅ Fix #6: capture in closure to avoid stale ref

    const ch = supabase
      .channel(`fleet:${groupId}`)
      .on("broadcast", { event: "sos" }, (payload) => {
        // ✅ Check if this broadcast is still for the active group
        if (activeGroupIdRef.current && subscribedGroup !== activeGroupIdRef.current) {
          console.log("🟡 Ignoring stale SOS broadcast:", subscribedGroup?.slice(0, 8));
          return;
        }

        const p = payload?.payload || payload;
        const device_id = p?.device_id || p?.deviceId || "Unknown";
        console.log("🚨 SOS broadcast received:", device_id);

        if (isMountedRef.current) {
          setIncomingSos({
            device_id: String(device_id),
            ts: Date.now(),
          });
        }

        fetchFleet(subscribedGroup);

        setTimeout(() => {
          if (!isMountedRef.current) return;
          setIncomingSos((prev) => {
            if (!prev) return null;
            if (Date.now() - prev.ts > 12000) return null;
            return prev;
          });
        }, 12500);
      })
      .on("broadcast", { event: "check_in" }, (payload) => {
        // ✅ Check-in broadcast received — ignore if fleet changed
        if (activeGroupIdRef.current && subscribedGroup !== activeGroupIdRef.current) return;
        const p = payload?.payload || payload;
        const device_id = p?.device_id || p?.deviceId || "Unknown";
        const display_name = p?.display_name || null;
        console.log("✅ Check-in broadcast received:", device_id);

        if (isMountedRef.current) {
          setRecentCheckIns((prev) => {
            // Keep only last 5 check-ins from last 30 seconds
            const now = Date.now();
            const filtered = prev.filter((c) => now - c.ts < 30000).slice(-4);
            return [...filtered, {
              device_id: String(device_id),
              display_name,
              ts: now,
            }];
          });
        }

        // Auto-clear after 8 seconds
        setTimeout(() => {
          if (!isMountedRef.current) return;
          setRecentCheckIns((prev) => {
            const now = Date.now();
            return prev.filter((c) => now - c.ts < 8000);
          });
        }, 8500);
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
    setSwitchFleetType(activeTab); // ✅ Match current tab (work or family)
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

      // ✅ Early exit if already on this fleet
      if (prevGroupId && String(targetGroupId) === String(prevGroupId)) {
        setSwitchError("You're already linked to this fleet.");
        return;
      }

      // ✅ Check if user already OWNS this fleet (skip subscription check)
      const isOwnedWorkFleet = ownedFleets.work?.groupId === targetGroupId;
      const isOwnedFamilyFleet = ownedFleets.family?.groupId === targetGroupId;
      const isOwnedFleet = isOwnedWorkFleet || isOwnedFamilyFleet;

      let newGroupId = targetGroupId;

      if (isOwnedFleet) {
        // User owns this fleet - no need to join, just switch tracking to it
        console.log("✅ Switching to owned fleet:", targetGroupId?.slice(0, 8));
        // Also switch to the correct tab
        if (isOwnedWorkFleet && activeTab !== "work") {
          setActiveTab("work");
        } else if (isOwnedFamilyFleet && activeTab !== "family") {
          setActiveTab("family");
        }
      } else {
        // 2) Join fleet via RPC (requires subscription for external fleets)
        const { data: joinData, error: joinErr } = await supabase.rpc(RPC_JOIN_GROUP, {
          p_invite_code: clean,
          p_fleet_type: switchFleetType, // ✅ source of truth for the join intent
        });
        if (joinErr) throw joinErr;

        // ✅ Check RPC response for success (RPC returns {success: false} as data, not error)
        if (joinData?.success === false) {
          throw new Error(joinData?.error || "Could not join fleet");
        }

        const extracted = extractGroupIdFromRpc(joinData);
        newGroupId = String(extracted || targetGroupId);
      }

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

      activeGroupIdRef.current = newGroupId; // ✅ Track active group
      if (isMountedRef.current) {
        setGroupId(newGroupId);
        setInviteCode("");
        setWorkers([]);
        setNameByDevice({});
        setErrorText("");
        setRecentCheckIns([]); // ✅ Fix #5: clear stale check-ins from previous fleet
        setIncomingSos(null);  // ✅ Fix #5: clear stale SOS from previous fleet
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

      // ✅ Restore previous context (including ref — prevents stale subscription filtering)
      activeGroupIdRef.current = prevGroupId;

      if (isMountedRef.current) {
        setGroupId(prevGroupId);
        setWorkers([]);
        setNameByDevice({});
        setRecentCheckIns([]);
        setIncomingSos(null);
      }

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
  const isSelfDevice = async (deviceId) => {
    try {
      const myId = await getDeviceId();
      return String(myId) === String(deviceId);
    } catch {
      return false;
    }
  };

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

  const openMemberMenu = async (item) => {
    if (!isAdmin) return;

    // ✅ Prevent admin from removing their own device by mistake
    if (await isSelfDevice(item?.device_id)) {
      Alert.alert("Not allowed", "You can't remove your own device from the fleet.");
      return;
    }

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

    // ✅ Battery status
    const batteryStatus = computeBatteryStatus(item?.battery_level);
    const batteryLevel = typeof item?.battery_level === "number" ? item.battery_level : parseInt(item?.battery_level, 10);
    const batteryIcon = getBatteryIcon(batteryStatus, batteryLevel);
    const batteryColor = getBatteryColor(batteryStatus, isSOS);
    const isBatteryWarning = batteryStatus === "low" || batteryStatus === "critical";

    // ✅ Enhanced card data
    const relativeTime = getRelativeTime(item?.last_updated);
    const gpsQuality = item?.gps_quality ? String(item.gps_quality).toUpperCase() : null;
    const gpsAccuracy = typeof item?.gps_accuracy_m === "number" ? Math.round(item.gps_accuracy_m) : null;
    const speed = typeof item?.speed === "number" && item.speed >= 0 ? item.speed : null;
    const speedMph = speed !== null ? Math.round(speed * 2.237) : null; // m/s to mph

    return (
      <View style={[
        styles.card,
        isSOS && styles.cardSOS,
        isOnline && !isSOS && styles.cardActive,
        !isSOS && isBatteryWarning && batteryStatus === "critical" && styles.cardBatteryCritical,
      ]}>
        {/* ✅ Battery Warning Badge */}
        {isOnline && isBatteryWarning && !isSOS && (
          <View style={[
            styles.batteryWarningBadge,
            batteryStatus === "critical" && styles.batteryWarningBadgeCritical,
          ]}>
            <Ionicons
              name={batteryStatus === "critical" ? "battery-dead" : "battery-half"}
              size={12}
              color={batteryStatus === "critical" ? "#fee2e2" : "#fef3c7"}
            />
            <Text style={[
              styles.batteryWarningBadgeText,
              batteryStatus === "critical" && styles.batteryWarningBadgeTextCritical,
            ]}>
              {batteryStatus === "critical" ? "LOW BATTERY" : "Battery Low"}
            </Text>
          </View>
        )}

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
                  {isSOS ? "🚨 SOS" : isOnline ? "ONLINE" : "OFFLINE"}
                  {relativeTime ? ` • ${relativeTime}` : ` • ${lastSeen}`}
                </Text>
                <View style={styles.deviceLineRow}>
                  <Text style={styles.deviceLine}>Device: {shortId(item?.device_id)}</Text>
                  {gpsQuality && isOnline && (
                    <View style={[
                      styles.gpsQualityBadge,
                      gpsQuality === "GOOD" && styles.gpsQualityGood,
                      gpsQuality === "POOR" && styles.gpsQualityPoor,
                    ]}>
                      <Text style={[
                        styles.gpsQualityText,
                        gpsQuality === "GOOD" && styles.gpsQualityTextGood,
                      ]}>
                        GPS {gpsQuality === "GOOD" ? "✓" : "~"}
                      </Text>
                    </View>
                  )}
                </View>
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
          <View style={[styles.stat, isBatteryWarning && !isSOS && styles.statWarning]}>
            <Ionicons name={batteryIcon} size={16} color={batteryColor} />
            <Text style={[
              styles.statText,
              isSOS && styles.statTextSOS,
              !isSOS && batteryStatus === "critical" && styles.statTextCritical,
              !isSOS && batteryStatus === "low" && styles.statTextLow,
            ]}>
              {safePercent(item?.battery_level)}
            </Text>
          </View>

          <View style={styles.stat}>
            <Ionicons name="location-outline" size={16} color={isSOS ? "#fecaca" : "#94a3b8"} />
            <Text style={[styles.statText, isSOS && styles.statTextSOS]} numberOfLines={1}>
              {safeCoords(item?.latitude, item?.longitude)}
              {gpsAccuracy && isOnline ? ` (±${gpsAccuracy}m)` : ""}
            </Text>
          </View>

          {/* ✅ Speed indicator (only show if moving) */}
          {speedMph !== null && speedMph > 0 && isOnline && (
            <View style={styles.stat}>
              <Ionicons name="speedometer-outline" size={16} color={isSOS ? "#fecaca" : "#94a3b8"} />
              <Text style={[styles.statText, isSOS && styles.statTextSOS]}>
                {speedMph} mph
              </Text>
            </View>
          )}
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
        <TouchableOpacity
          style={{ marginTop: 24, paddingHorizontal: 20, paddingVertical: 10, backgroundColor: "#334155", borderRadius: 8 }}
          onPress={retryBoot}
        >
          <Text style={{ color: "#e2e8f0", fontSize: 13, fontWeight: "600" }}>Tap to retry</Text>
        </TouchableOpacity>
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

              {/* ✅ Fleet Type Indicator (auto-matches current tab) */}
              <View style={styles.switchFleetTypeContainer}>
                <View style={styles.switchFleetTypeIndicator}>
                  <Ionicons
                    name={switchFleetType === "work" ? "briefcase" : "home"}
                    size={18}
                    color={switchFleetType === "work" ? "#3b82f6" : "#22c55e"}
                  />
                  <Text style={[
                    styles.switchFleetTypeIndicatorText,
                    { color: switchFleetType === "work" ? "#3b82f6" : "#22c55e" }
                  ]}>
                    Joining {switchFleetType === "work" ? "Work" : "Family"} Fleet
                  </Text>
                </View>
                <Text style={styles.switchFleetTypeHint}>
                  This will replace your current {switchFleetType} fleet membership
                </Text>
              </View>

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

      {/* ✅ SOS PIN Setup Modal */}
      <Modal transparent visible={pinModalVisible} animationType="fade" onRequestClose={closePinModal}>
        <Pressable style={styles.modalBackdrop} onPress={closePinModal}>
          <Pressable style={styles.pinModalCard} onPress={() => {}}>
            <View style={styles.modalHeaderRow}>
              <View style={styles.modalTitleRow}>
                <Ionicons name="lock-closed" size={18} color="#e2e8f0" />
                <Text style={styles.modalTitle}>
                  {pinStep === 1 ? (hasPin ? "Change Your SOS PIN" : "Create Your SOS PIN") : "Confirm Your PIN"}
                </Text>
              </View>

              <TouchableOpacity onPress={closePinModal} disabled={pinSaving} style={styles.modalCloseBtn}>
                <Ionicons name="close" size={18} color="#94a3b8" />
              </TouchableOpacity>
            </View>

            <Text style={styles.modalHint}>
              {pinStep === 1
                ? "This PIN deactivates emergency SOS."
                : "Enter the same PIN again to confirm."}
            </Text>

            <Text style={styles.pinWarningModal}>
              ⚠️ Remember this PIN. If you change it, your old PIN will stop working.
            </Text>

            {/* PIN Dots Display */}
            <View style={styles.pinDotsRow}>
              {[0, 1, 2, 3].map((i) => {
                const currentPin = pinStep === 1 ? pinInput : pinConfirm;
                const filled = i < currentPin.length;
                return (
                  <View
                    key={i}
                    style={[styles.pinDot, filled && styles.pinDotFilled]}
                  />
                );
              })}
            </View>

            {!!pinError && <Text style={styles.modalError}>⚠ {pinError}</Text>}

            {/* PIN Keypad */}
            <View style={styles.pinKeypad}>
              {[[1, 2, 3], [4, 5, 6], [7, 8, 9], ["", 0, "⌫"]].map((row, rowIdx) => (
                <View key={rowIdx} style={styles.pinKeypadRow}>
                  {row.map((key, keyIdx) => {
                    if (key === "") {
                      return <View key={keyIdx} style={styles.pinKeyEmpty} />;
                    }
                    if (key === "⌫") {
                      return (
                        <TouchableOpacity
                          key={keyIdx}
                          style={styles.pinKey}
                          onPress={handlePinBackspace}
                          disabled={pinSaving}
                          activeOpacity={0.7}
                        >
                          <Ionicons name="backspace-outline" size={24} color="#e2e8f0" />
                        </TouchableOpacity>
                      );
                    }
                    return (
                      <TouchableOpacity
                        key={keyIdx}
                        style={styles.pinKey}
                        onPress={() => handlePinDigit(String(key))}
                        disabled={pinSaving}
                        activeOpacity={0.7}
                      >
                        <Text style={styles.pinKeyText}>{key}</Text>
                      </TouchableOpacity>
                    );
                  })}
                </View>
              ))}
            </View>

            {/* Action Button */}
            <TouchableOpacity
              style={[styles.pinActionBtn, pinSaving && { opacity: 0.75 }]}
              onPress={handlePinNext}
              disabled={pinSaving}
              activeOpacity={0.9}
            >
              {pinSaving ? (
                <ActivityIndicator color="#0b1220" />
              ) : (
                <Text style={styles.pinActionBtnText}>
                  {pinStep === 1 ? "NEXT" : "CONFIRM & SAVE"}
                </Text>
              )}
            </TouchableOpacity>

            {pinStep === 2 && !pinSaving && (
              <TouchableOpacity
                style={styles.pinBackBtn}
                onPress={() => {
                  setPinStep(1);
                  setPinConfirm("");
                  setPinError("");
                }}
                activeOpacity={0.8}
              >
                <Text style={styles.pinBackBtnText}>← Go Back</Text>
              </TouchableOpacity>
            )}
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
            <Text style={styles.switchText}>Join</Text>
          </TouchableOpacity>
        </View>

        {/* ✅ Work/Family Tab Switcher */}
        <View style={styles.tabContainer}>
          <TouchableOpacity
            style={[styles.tab, activeTab === "family" && styles.tabActive]}
            onPress={() => handleTabSwitch("family")}
            activeOpacity={0.8}
          >
            <Ionicons
              name="home"
              size={16}
              color={activeTab === "family" ? "#22c55e" : "#64748b"}
            />
            <Text style={[styles.tabText, activeTab === "family" && styles.tabTextActive]}>
              Family
            </Text>
            {ownedFleets.family?.groupId && (
              <View style={[styles.tabDot, activeTab === "family" && styles.tabDotActive]} />
            )}
          </TouchableOpacity>

          <TouchableOpacity
            style={[styles.tab, activeTab === "work" && styles.tabActiveWork]}
            onPress={() => handleTabSwitch("work")}
            activeOpacity={0.8}
          >
            <Ionicons
              name="briefcase"
              size={16}
              color={activeTab === "work" ? "#3b82f6" : "#64748b"}
            />
            <Text style={[styles.tabText, activeTab === "work" && styles.tabTextActiveWork]}>
              Work
            </Text>
            {ownedFleets.work?.groupId && (
              <View style={[styles.tabDot, activeTab === "work" && styles.tabDotActiveWork]} />
            )}
          </TouchableOpacity>
        </View>

        <Text style={styles.headerTitle}>
          {activeTab === "work" ? "Work Fleet" : "Family Fleet"}
        </Text>
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

        {/* ✅ Check-In Notifications */}
        {recentCheckIns.length > 0 && !incomingSos?.device_id && (
          <View style={styles.checkInBanner}>
            <Ionicons name="checkmark-circle" size={16} color="#bbf7d0" />
            <Text style={styles.checkInBannerText} numberOfLines={1}>
              {recentCheckIns.length === 1
                ? `${recentCheckIns[0].display_name || getFriendlyName(recentCheckIns[0].device_id)} checked in ✓`
                : `${recentCheckIns.length} members checked in ✓`}
            </Text>
          </View>
        )}

        {!!groupId ? (
          <View style={styles.fleetInfoCard}>
            {/* ✅ Collapsible Invite Code Header */}
            <TouchableOpacity
              style={styles.collapsibleHeader}
              onPress={() => setInviteCodeExpanded(!inviteCodeExpanded)}
              activeOpacity={0.7}
            >
              <View style={styles.collapsibleHeaderLeft}>
                <Ionicons name="people" size={18} color="#94a3b8" />
                <Text style={styles.collapsibleHeaderText}>Fleet Info & Invite Code</Text>
              </View>
              <Ionicons
                name={inviteCodeExpanded ? "chevron-up" : "chevron-down"}
                size={20}
                color="#94a3b8"
              />
            </TouchableOpacity>

            {/* ✅ Collapsible Content */}
            {inviteCodeExpanded && (
              <>
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

                <Text style={styles.fleetInfoHint}>
                  Only devices in your fleet appear here (same invite code / group).
                  {"\n"}Use "LIVE VIEW" when SOS triggers, and "COORDS" to read to police.
                  {isAdmin ? "\n(Manager: long-press a member card header or tap ⋯ to remove old devices.)" : ""}
                </Text>
              </>
            )}

            {/* ✅ Battery Warning Banner - always visible when relevant */}
            {hasLowBattery && !hasSOS && (
              <View style={[
                styles.batteryBanner,
                criticalBatteryCount > 0 && styles.batteryBannerCritical,
              ]}>
                <Ionicons
                  name={criticalBatteryCount > 0 ? "battery-dead" : "battery-half"}
                  size={16}
                  color={criticalBatteryCount > 0 ? "#fee2e2" : "#fef3c7"}
                />
                <Text style={[
                  styles.batteryBannerText,
                  criticalBatteryCount > 0 && styles.batteryBannerTextCritical,
                ]}>
                  {criticalBatteryCount > 0
                    ? `${criticalBatteryCount} member${criticalBatteryCount > 1 ? "s" : ""} with critical battery`
                    : `${lowBatteryMembers.length} member${lowBatteryMembers.length > 1 ? "s" : ""} with low battery`}
                </Text>
              </View>
            )}

            {/* ✅ SOS Panel - always visible when SOS is active */}
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
          </View>
        ) : (
          <Text style={styles.noFleetHint}>No fleet linked yet. Go to Login and use Join Fleet or Create Fleet.</Text>
        )}

        {/* ✅ SOS PIN Setup Section - Collapsible */}
        <View style={styles.pinSection}>
          <TouchableOpacity
            style={styles.collapsibleHeader}
            onPress={() => setPinSectionExpanded(!pinSectionExpanded)}
            activeOpacity={0.7}
          >
            <View style={styles.collapsibleHeaderLeft}>
              <Ionicons name="lock-closed" size={18} color="#94a3b8" />
              <Text style={styles.collapsibleHeaderText}>SOS PIN</Text>
              {hasPin && (
                <View style={styles.statusBadgeGreen}>
                  <Text style={styles.statusBadgeText}>SET</Text>
                </View>
              )}
              {hasPin === false && (
                <View style={styles.statusBadgeYellow}>
                  <Text style={styles.statusBadgeTextDark}>NOT SET</Text>
                </View>
              )}
            </View>
            <Ionicons
              name={pinSectionExpanded ? "chevron-up" : "chevron-down"}
              size={20}
              color="#94a3b8"
            />
          </TouchableOpacity>

          {pinSectionExpanded && (
            <>
              <Text style={styles.pinDescription}>
                Use to Deactivate SOS Alert PIN Code
              </Text>

              {hasPin === null ? (
                <View style={styles.pinStatusRow}>
                  <ActivityIndicator size="small" color="#94a3b8" />
                  <Text style={styles.pinStatusText}>Checking...</Text>
                </View>
              ) : hasPin ? (
                <View>
                  <View style={styles.pinStatusRow}>
                    <Ionicons name="checkmark-circle" size={18} color="#22c55e" />
                    <Text style={[styles.pinStatusText, { color: "#22c55e" }]}>PIN Configured</Text>
                  </View>
                  <TouchableOpacity style={[styles.pinSetupBtn, { backgroundColor: "#334155", marginTop: 8 }]} onPress={openPinModal} activeOpacity={0.85}>
                    <Ionicons name="refresh-outline" size={16} color="#e2e8f0" />
                    <Text style={[styles.pinSetupBtnText, { color: "#e2e8f0" }]}>CHANGE PIN</Text>
                  </TouchableOpacity>
                </View>
              ) : (
                <TouchableOpacity style={styles.pinSetupBtn} onPress={openPinModal} activeOpacity={0.85}>
                  <Ionicons name="key-outline" size={16} color="#0b1220" />
                  <Text style={styles.pinSetupBtnText}>SET UP PIN</Text>
                </TouchableOpacity>
              )}

              <Text style={styles.pinWarning}>
                ⚠️ IMPORTANT: Remember this PIN. If you change it, your old PIN will no longer unlock the SOS screen.
              </Text>
            </>
          )}
        </View>

        {!!errorText && (
          <TouchableOpacity onPress={retryBoot}>
            <Text style={styles.errorText}>⚠ {errorText}</Text>
            <Text style={[styles.errorText, { fontSize: 11, marginTop: 2 }]}>Tap to retry</Text>
          </TouchableOpacity>
        )}
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
              const gid = activeGroupIdRef.current;
              if (!gid) return;
              setRefreshing(true);
              fetchFleet(gid);
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

  // ✅ Tab Switcher Styles
  tabContainer: {
    flexDirection: "row",
    marginTop: 16,
    marginBottom: 8,
    gap: 10,
  },
  tab: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    paddingVertical: 12,
    paddingHorizontal: 16,
    borderRadius: 12,
    backgroundColor: "rgba(148, 163, 184, 0.08)",
    borderWidth: 1,
    borderColor: "rgba(148, 163, 184, 0.16)",
  },
  tabActive: {
    backgroundColor: "rgba(34, 197, 94, 0.12)",
    borderColor: "rgba(34, 197, 94, 0.35)",
  },
  tabActiveWork: {
    backgroundColor: "rgba(59, 130, 246, 0.12)",
    borderColor: "rgba(59, 130, 246, 0.35)",
  },
  tabText: {
    color: "#64748b",
    fontSize: 14,
    fontWeight: "800",
    letterSpacing: 0.4,
  },
  tabTextActive: {
    color: "#22c55e",
  },
  tabTextActiveWork: {
    color: "#3b82f6",
  },
  tabDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: "#64748b",
  },
  tabDotActive: {
    backgroundColor: "#22c55e",
  },
  tabDotActiveWork: {
    backgroundColor: "#3b82f6",
  },

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

  // ✅ Check-In Banner
  checkInBanner: {
    marginTop: 12,
    borderRadius: 12,
    paddingVertical: 10,
    paddingHorizontal: 12,
    backgroundColor: "rgba(34, 197, 94, 0.12)",
    borderWidth: 1,
    borderColor: "rgba(34, 197, 94, 0.28)",
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
  },
  checkInBannerText: {
    color: "#bbf7d0",
    fontWeight: "800",
    letterSpacing: 0.3,
    fontSize: 12,
    flex: 1,
  },

  fleetInfoCard: {
    marginTop: 10,
    padding: 10,
    borderRadius: 12,
    backgroundColor: "#0b1220",
    borderWidth: 1,
    borderColor: "rgba(34, 197, 94, 0.25)",
  },
  fleetInfoRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: 8,
  },
  fleetInfoLabel: { color: "#94a3b8", fontSize: 11, fontWeight: "800", letterSpacing: 0.6 },

  // ✅ Collapsible Header Styles (compact when collapsed)
  collapsibleHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingVertical: 4,
    marginBottom: 0,
  },
  collapsibleHeaderLeft: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  collapsibleHeaderText: {
    color: "#e2e8f0",
    fontSize: 13,
    fontWeight: "800",
    letterSpacing: 0.3,
  },
  statusBadgeGreen: {
    backgroundColor: "rgba(34, 197, 94, 0.20)",
    borderWidth: 1,
    borderColor: "rgba(34, 197, 94, 0.4)",
    borderRadius: 8,
    paddingHorizontal: 8,
    paddingVertical: 3,
  },
  statusBadgeYellow: {
    backgroundColor: "rgba(251, 191, 36, 0.20)",
    borderWidth: 1,
    borderColor: "rgba(251, 191, 36, 0.4)",
    borderRadius: 8,
    paddingHorizontal: 8,
    paddingVertical: 3,
  },
  statusBadgeText: {
    color: "#22c55e",
    fontSize: 10,
    fontWeight: "900",
    letterSpacing: 0.5,
  },
  statusBadgeTextDark: {
    color: "#fbbf24",
    fontSize: 10,
    fontWeight: "900",
    letterSpacing: 0.5,
  },

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

  deviceLine: { color: "#475569", fontSize: 11, fontWeight: "700" },
  deviceLineRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    marginTop: 4,
  },
  gpsQualityBadge: {
    paddingVertical: 2,
    paddingHorizontal: 6,
    borderRadius: 4,
    backgroundColor: "rgba(148, 163, 184, 0.10)",
  },
  gpsQualityGood: {
    backgroundColor: "rgba(34, 197, 94, 0.15)",
  },
  gpsQualityPoor: {
    backgroundColor: "rgba(251, 191, 36, 0.15)",
  },
  gpsQualityText: {
    fontSize: 9,
    fontWeight: "800",
    color: "#94a3b8",
    letterSpacing: 0.5,
  },
  gpsQualityTextGood: {
    color: "#22c55e",
  },

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

  // ✅ Fleet Type Selector styles (Switch Fleet modal)
  switchFleetTypeContainer: {
    marginTop: 14,
    padding: 12,
    borderRadius: 12,
    backgroundColor: "rgba(148, 163, 184, 0.06)",
    borderWidth: 1,
    borderColor: "rgba(148, 163, 184, 0.12)",
  },
  switchFleetTypeIndicator: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 10,
    paddingVertical: 8,
  },
  switchFleetTypeIndicatorText: {
    fontSize: 14,
    fontWeight: "800",
    letterSpacing: 0.3,
  },
  switchFleetTypeLabel: {
    color: "#94a3b8",
    fontSize: 11,
    fontWeight: "700",
    marginBottom: 10,
    letterSpacing: 0.3,
  },
  switchFleetTypeButtons: {
    flexDirection: "row",
    gap: 10,
  },
  switchFleetTypeBtn: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    paddingVertical: 10,
    paddingHorizontal: 12,
    borderRadius: 10,
    backgroundColor: "rgba(148, 163, 184, 0.08)",
    borderWidth: 1,
    borderColor: "rgba(148, 163, 184, 0.16)",
  },
  switchFleetTypeBtnActive: {
    backgroundColor: "#22c55e",
    borderColor: "#22c55e",
  },
  switchFleetTypeBtnText: {
    color: "#94a3b8",
    fontSize: 13,
    fontWeight: "700",
  },
  switchFleetTypeBtnTextActive: {
    color: "#0b1220",
  },
  switchFleetTypeHint: {
    color: "#64748b",
    fontSize: 10,
    marginTop: 10,
    textAlign: "center",
    fontWeight: "600",
    fontStyle: "italic",
  },

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

  // =========================
  // ✅ SOS PIN Section styles
  // =========================
  pinSection: {
    marginTop: 10,
    padding: 10,
    borderRadius: 12,
    backgroundColor: "#0b1220",
    borderWidth: 1,
    borderColor: "rgba(148, 163, 184, 0.20)",
  },
  pinHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    marginBottom: 6,
  },
  pinTitle: {
    color: "#e2e8f0",
    fontSize: 14,
    fontWeight: "900",
    letterSpacing: 0.6,
  },
  pinDescription: {
    color: "#94a3b8",
    fontSize: 12,
    fontWeight: "700",
    marginBottom: 12,
  },
  pinStatusRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    marginBottom: 10,
  },
  pinStatusText: {
    color: "#94a3b8",
    fontSize: 13,
    fontWeight: "800",
  },
  pinSetupBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    backgroundColor: "#22c55e",
    paddingVertical: 12,
    paddingHorizontal: 20,
    borderRadius: 12,
    marginBottom: 10,
  },
  pinSetupBtnText: {
    color: "#0b1220",
    fontWeight: "900",
    fontSize: 13,
    letterSpacing: 0.8,
  },
  pinWarning: {
    color: "#fbbf24",
    fontSize: 11,
    fontWeight: "700",
    lineHeight: 15,
  },

  // =========================
  // ✅ PIN Modal styles
  // =========================
  pinModalCard: {
    width: "100%",
    maxWidth: 360,
    borderRadius: 18,
    backgroundColor: "#0f172a",
    borderWidth: 1,
    borderColor: "rgba(148, 163, 184, 0.18)",
    padding: 16,
  },
  pinWarningModal: {
    color: "#fbbf24",
    fontSize: 11,
    fontWeight: "700",
    marginTop: 8,
    lineHeight: 15,
  },
  pinDotsRow: {
    flexDirection: "row",
    justifyContent: "center",
    gap: 16,
    marginVertical: 20,
  },
  pinDot: {
    width: 16,
    height: 16,
    borderRadius: 8,
    borderWidth: 2,
    borderColor: "#64748b",
    backgroundColor: "transparent",
  },
  pinDotFilled: {
    backgroundColor: "#22c55e",
    borderColor: "#22c55e",
  },
  pinKeypad: {
    marginTop: 8,
  },
  pinKeypadRow: {
    flexDirection: "row",
    justifyContent: "center",
    gap: 16,
    marginBottom: 12,
  },
  pinKey: {
    width: 64,
    height: 64,
    borderRadius: 32,
    backgroundColor: "rgba(148, 163, 184, 0.10)",
    borderWidth: 1,
    borderColor: "rgba(148, 163, 184, 0.20)",
    justifyContent: "center",
    alignItems: "center",
  },
  pinKeyEmpty: {
    width: 64,
    height: 64,
  },
  pinKeyText: {
    color: "#e2e8f0",
    fontSize: 24,
    fontWeight: "700",
  },
  pinActionBtn: {
    marginTop: 16,
    backgroundColor: "#22c55e",
    paddingVertical: 14,
    borderRadius: 14,
    alignItems: "center",
    justifyContent: "center",
  },
  pinActionBtnText: {
    color: "#0b1220",
    fontWeight: "900",
    fontSize: 14,
    letterSpacing: 1,
  },
  pinBackBtn: {
    marginTop: 12,
    alignItems: "center",
    paddingVertical: 8,
  },
  pinBackBtnText: {
    color: "#94a3b8",
    fontWeight: "800",
    fontSize: 13,
  },

  // =========================
  // ✅ Battery Warning styles
  // =========================
  batteryBanner: {
    marginTop: 10,
    borderRadius: 12,
    paddingVertical: 10,
    paddingHorizontal: 12,
    backgroundColor: "rgba(251, 191, 36, 0.12)",
    borderWidth: 1,
    borderColor: "rgba(251, 191, 36, 0.28)",
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
  },
  batteryBannerCritical: {
    backgroundColor: "rgba(239, 68, 68, 0.12)",
    borderColor: "rgba(239, 68, 68, 0.28)",
  },
  batteryBannerText: {
    color: "#fbbf24",
    fontWeight: "800",
    letterSpacing: 0.3,
    fontSize: 12,
    flex: 1,
  },
  batteryBannerTextCritical: {
    color: "#fee2e2",
  },
  batteryWarningBadge: {
    position: "absolute",
    top: 10,
    right: 10,
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    paddingVertical: 4,
    paddingHorizontal: 8,
    borderRadius: 8,
    backgroundColor: "rgba(251, 191, 36, 0.15)",
    borderWidth: 1,
    borderColor: "rgba(251, 191, 36, 0.30)",
    zIndex: 10,
  },
  batteryWarningBadgeCritical: {
    backgroundColor: "rgba(239, 68, 68, 0.15)",
    borderColor: "rgba(239, 68, 68, 0.35)",
  },
  batteryWarningBadgeText: {
    color: "#fbbf24",
    fontSize: 10,
    fontWeight: "800",
    letterSpacing: 0.4,
  },
  batteryWarningBadgeTextCritical: {
    color: "#fee2e2",
  },
  cardBatteryCritical: {
    borderColor: "rgba(239, 68, 68, 0.35)",
  },
  statWarning: {
    backgroundColor: "rgba(251, 191, 36, 0.10)",
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 8,
  },
  statTextCritical: {
    color: "#ef4444",
    fontWeight: "900",
  },
  statTextLow: {
    color: "#fbbf24",
    fontWeight: "900",
  },
});

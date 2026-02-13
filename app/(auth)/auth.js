// 📂 FILE: app/(auth)/auth.js
import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  StyleSheet,
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  Modal,
  Animated,
  Easing,
  Share,
  Pressable,
} from "react-native";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { useLocalSearchParams, useRouter } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import * as Clipboard from "expo-clipboard";
import { supabase } from "../../src/lib/supabase";
import { handshakeDevice } from "../../src/services/deviceHandshake";
import { forceOneShotSync } from "../../src/services/LiveTracker";

let SecureStore = null;
try { SecureStore = require("expo-secure-store"); } catch {}

// ===============================
// Storage Keys
// ===============================
const STORAGE_KEY_GROUP_ID = "sentinel_group_id";
const STORAGE_KEY_INVITE_CODE = "sentinel_invite_code";
const STORAGE_KEY_PENDING_INVITE = "sentinel_pending_invite_code";
const STORAGE_KEY_PENDING_FLEET_TYPE = "sentinel_pending_fleet_type"; // ✅ Store fleet type for pending join
const STORAGE_KEY_POST_LOGIN_ACTION = "sentinel_post_login_action"; // "create_required"

// ✅ Phase 1 Option A: name is stored on devices.display_name
const STORAGE_KEY_DEVICE_NAME_LEGACY = "sentinel_device_display_name";
const STORAGE_KEY_LAST_USER_ID = "sentinel_last_user_id";
const DEVICE_NAME_PREFIX = "sentinel_device_display_name:";

// ===============================
// RPC names
// ===============================
const RPC_GET_GROUP_ID = "get_group_id_by_invite_code";
const RPC_JOIN_GROUP = "join_group_with_invite_code";

// ✅ Preferred create RPC (but we’ll fallback to others in Phase 1)
const RPC_CREATE_GROUP_AUTO = "create_group_auto_invite_code";

// ✅ Phase 1: safe web landing page for email links
// ✅ CHANGE (baby step): add trailing "/" so static hosts reliably serve /confirm/index.html and /reset/index.html
const EMAIL_CONFIRM_REDIRECT = "https://sentihnel.com/confirm/";
const PASSWORD_RESET_REDIRECT = "https://sentihnel.com/reset/";

// ✅ Phase 1: try multiple possible create-RPC names (schema cache mismatch)
const CREATE_RPC_CANDIDATES = [
  RPC_CREATE_GROUP_AUTO,
  "create_group_invite_code",
  "create_group_with_invite_code",
];

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

function resetAuthUiToLogin(setAuthMode, setActionMode, setPassword, setInviteCode) {
  setAuthMode("login");
  setActionMode("login");
  setPassword("");
  setInviteCode("");
}

const isRpcMissingError = (msgRaw) => {
  const msg = String(msgRaw || "").toLowerCase();
  return (
    msg.includes("could not find the function") ||
    msg.includes("schema cache") ||
    (msg.includes("function") && msg.includes("not found"))
  );
};

// expo-clipboard imported directly at top of file

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * ✅ Phase 3 Baby Step 2:
 * After a fleet join/create/resume + handshake, force a best-effort tracking sync
 * so `tracking_sessions` is created/updated under the new group quickly.
 */
async function kickTrackerRebind(label) {
  try {
    await forceOneShotSync();
  } catch (e) {
    console.log(`forceOneShotSync failed (${label})`, e?.message || e);
  }
}

function getDeviceNameKeyForUser(userId) {
  if (!userId) return STORAGE_KEY_DEVICE_NAME_LEGACY;
  return `${DEVICE_NAME_PREFIX}${userId}`;
}

/**
 * ✅ Local session identity (what the client THINKS is logged in)
 */
async function getLocalSessionIdentity() {
  try {
    const { data } = await supabase.auth.getSession();
    const s = data?.session || null;
    const u = s?.user || null;
    return {
      id: u?.id || null,
      email: u?.email ? String(u.email).trim().toLowerCase() : null,
    };
  } catch {
    return { id: null, email: null };
  }
}

/**
 * ✅ Server-validated identity (SOURCE OF TRUTH)
 */
async function getServerUserIdentity() {
  try {
    const { data, error } = await supabase.auth.getUser();
    if (error) return { id: null, email: null, error: error.message || String(error) };
    const u = data?.user || null;
    return {
      id: u?.id || null,
      email: u?.email ? String(u.email).trim().toLowerCase() : null,
      error: null,
    };
  } catch (e) {
    return { id: null, email: null, error: e?.message || String(e) };
  }
}

/**
 * ✅ Debug helper: log local session vs server user
 */
async function logAuth(label) {
  const local = await getLocalSessionIdentity();
  const server = await getServerUserIdentity();
  console.log(`🧾 AUTH[${label}]`, { local, server });
  return { local, server };
}

/**
 * ✅ Hard wait until server user matches expected (prevents stale session causing wrong-account RPC)
 */
async function waitForServerMatch({ expectedUserId, expectedEmail, tries = 12, delayMs = 250 } = {}) {
  const expEmail = expectedEmail ? String(expectedEmail).trim().toLowerCase() : null;

  for (let i = 0; i < tries; i++) {
    const server = await getServerUserIdentity();
    if (
      server?.id &&
      server.id === expectedUserId &&
      (!expEmail || (server.email && server.email === expEmail))
    ) {
      return server;
    }
    // eslint-disable-next-line no-await-in-loop
    await sleep(delayMs);
  }
  return null;
}

/**
 * ✅ Block dangerous flows if server session is not the user we expect
 */
async function assertServerIsExpected(expectedUserId, expectedEmail, label) {
  const server = await getServerUserIdentity();
  const expEmail = expectedEmail ? String(expectedEmail).trim().toLowerCase() : null;

  const ok =
    server?.id &&
    server.id === expectedUserId &&
    (!expEmail || (server.email && server.email === expEmail));

  if (!ok) {
    console.log("🚨 SESSION MISMATCH", { label, expectedUserId, expectedEmail: expEmail, server });
    throw new Error(
      `Session mismatch (${label}). Server user != expected login. Please sign out and log in again.`
    );
  }
  return true;
}

/**
 * ✅ If there is already a persisted session for a DIFFERENT email,
 * sign out locally first so we never "accidentally" keep the wrong user.
 * Uses BOTH local session + server user (whichever is available).
 */
async function ensureFreshSessionForEmail(targetEmail) {
  const clean = String(targetEmail || "").trim().toLowerCase();
  if (!clean) return;

  try {
    const local = await getLocalSessionIdentity();
    const server = await getServerUserIdentity();

    const currentEmail = (server?.email && server.email) || (local?.email && local.email) || "";

    if ((server?.id || local?.id) && currentEmail && currentEmail !== clean) {
      console.log("🔄 SESSION EMAIL MISMATCH — forcing local sign-out", {
        currentEmail,
        targetEmail: clean,
      });

      try {
        await supabase.auth.signOut({ scope: "local" });
      } catch {
        await supabase.auth.signOut();
      }

      await AsyncStorage.multiRemove([
        STORAGE_KEY_GROUP_ID,
        STORAGE_KEY_INVITE_CODE,
        STORAGE_KEY_PENDING_INVITE,
        STORAGE_KEY_POST_LOGIN_ACTION,
        STORAGE_KEY_LAST_USER_ID,
        "sentinel_pin_hash",
      ]);
      try { if (SecureStore?.deleteItemAsync) await SecureStore.deleteItemAsync("sentinel_pin_hash"); } catch {}
      // don't clear displayName here — user may be pre-typing it
    }
  } catch {}
}

/**
 * ✅ Enforce per-user isolation of local fleet state.
 * Prevents stale group keys from another account.
 */
async function enforceUserIsolation(userId) {
  if (!userId) return;
  try {
    const last = await AsyncStorage.getItem(STORAGE_KEY_LAST_USER_ID);

    if (last && last !== userId) {
      console.log("🔄 USER SWITCH — clearing fleet keys + PIN", { last, userId });

      await AsyncStorage.multiRemove([
        STORAGE_KEY_GROUP_ID,
        STORAGE_KEY_INVITE_CODE,
        STORAGE_KEY_PENDING_INVITE,
        STORAGE_KEY_POST_LOGIN_ACTION,
        "sentinel_pin_hash",
      ]);
      try { if (SecureStore?.deleteItemAsync) await SecureStore.deleteItemAsync("sentinel_pin_hash"); } catch {}
    }

    await AsyncStorage.setItem(STORAGE_KEY_LAST_USER_ID, String(userId));
  } catch (e) {
    console.log("enforceUserIsolation warning:", e?.message || e);
  }
}

/**
 * ✅ Display name is per-user (and legacy fallback).
 */
async function loadDisplayNameForUser(userId) {
  try {
    const key = getDeviceNameKeyForUser(userId);
    const dn = await AsyncStorage.getItem(key);
    if (dn && String(dn).trim()) return String(dn).trim();

    const legacy = await AsyncStorage.getItem(STORAGE_KEY_DEVICE_NAME_LEGACY);
    if (legacy && String(legacy).trim()) return String(legacy).trim();
  } catch {}
  return "";
}

async function persistDisplayNameForUser(userId, displayName) {
  const dn = String(displayName || "").trim();
  try {
    if (userId) {
      const key = getDeviceNameKeyForUser(userId);
      if (dn) await AsyncStorage.setItem(key, dn);
      else await AsyncStorage.removeItem(key);
    }
    // keep legacy for backwards compatibility
    if (dn) await AsyncStorage.setItem(STORAGE_KEY_DEVICE_NAME_LEGACY, dn);
    else await AsyncStorage.removeItem(STORAGE_KEY_DEVICE_NAME_LEGACY);
  } catch {}
  return dn || null;
}

// ✅ Secure group lookup via RPC (no direct groups lookup)
async function resolveGroupIdByInviteCode(inviteCode) {
  const clean = normalizeInviteCode(inviteCode);
  if (!clean) return null;

  const { data, error } = await supabase.rpc(RPC_GET_GROUP_ID, {
    p_invite_code: clean,
  });

  if (error) {
    console.log("RPC group lookup error:", error.message);
    return null;
  }

  return extractGroupIdFromRpc(data) || null;
}

// ✅ Fetch invite code for a group (RLS should allow members)
async function fetchInviteCodeForGroup(groupId) {
  if (!groupId) return null;

  const { data, error } = await supabase
    .from("groups")
    .select("invite_code")
    .eq("id", groupId)
    .limit(1)
    .maybeSingle();

  if (error) {
    console.log("groups invite_code fetch warning:", error.message);
    return null;
  }
  return data?.invite_code || null;
}

// ✅ Get all memberships
async function getGroupIdsForUser(userId) {
  if (!userId) return [];

  const { data, error } = await supabase.from("group_members").select("group_id").eq("user_id", userId);

  if (error) {
    console.log("group_members fetch warning:", error.message);
    return [];
  }

  return Array.isArray(data) ? data.map((r) => r?.group_id).filter(Boolean) : [];
}

// ✅ Keep old helper for “resume”
async function getGroupIdForUser(userId) {
  const gids = await getGroupIdsForUser(userId);
  return gids.length ? gids[0] : null;
}

/**
 * ✅ Wait for membership, and (if provided) ensure it matches expectedGroupId.
 */
async function waitForMembershipGroupId(
  userId,
  { expectedGroupId = null, tries = 6, delayMs = 250 } = {}
) {
  for (let i = 0; i < tries; i++) {
    const gids = await getGroupIdsForUser(userId);

    if (expectedGroupId) {
      if (gids.includes(expectedGroupId)) return expectedGroupId;
    } else {
      if (gids.length) return gids[0];
    }

    // eslint-disable-next-line no-await-in-loop
    await sleep(delayMs);
  }
  return null;
}

// ✅ Optional improvement: detect owned fleet (helps helpers)
async function getOwnedGroupForUser(userId) {
  if (!userId) return null;

  const { data, error } = await supabase
    .from("groups")
    .select("id, invite_code")
    .eq("owner_user_id", userId)
    .limit(1)
    .maybeSingle();

  if (error) {
    console.log("groups owned fetch warning:", error.message);
    return null;
  }

  if (!data?.id) return null;
  return { groupId: data.id, inviteCode: data.invite_code || null };
}

// ✅ Phase 1: create fleet RPC can be named differently in your Supabase.
async function tryCreateFleetRpc(userId) {
  const attempts = [];
  const argVariants = [{}, { p_user_id: userId }];

  for (const fn of CREATE_RPC_CANDIDATES) {
    for (const args of argVariants) {
      const key = `${fn}(${Object.keys(args).join(",") || "noargs"})`;
      try {
        const { data, error } = await supabase.rpc(fn, args);
        if (!error) return { data, used: fn, attempts };
        attempts.push({ key, message: error.message || String(error) });
      } catch (e) {
        attempts.push({ key, message: e?.message || String(e) });
      }
    }
  }

  return { data: null, used: null, attempts };
}

export default function AuthPage() {
  const router = useRouter();
  const params = useLocalSearchParams();

  const [authMode, setAuthMode] = useState("login");
  const [actionMode, setActionMode] = useState("login");

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [inviteCode, setInviteCode] = useState("");
  const [fleetType, setFleetType] = useState("family"); // "family" or "work"

  const [displayName, setDisplayName] = useState("");

  const [loading, setLoading] = useState(false);
  const [showPassword, setShowPassword] = useState(false);

  const [uiModal, setUiModal] = useState({
    visible: false,
    variant: "info",
    title: "",
    message: "",
    code: "",
    showCode: false,
    primaryText: "OK",
    secondaryText: "",
    showCopy: false,
    showShare: false,
  });

  const primaryActionRef = useRef(null);
  const secondaryActionRef = useRef(null);

  const modalAnim = useRef(new Animated.Value(0)).current;

  const toastAnim = useRef(new Animated.Value(0)).current;
  const [toastText, setToastText] = useState("");

  // ✅ Load any previously saved legacy display name
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const dn = await AsyncStorage.getItem(STORAGE_KEY_DEVICE_NAME_LEGACY);
        if (!alive) return;
        if (dn && String(dn).trim()) setDisplayName(String(dn).trim());
      } catch {}
    })();
    return () => {
      alive = false;
    };
  }, []);

  const showToast = (text) => {
    setToastText(String(text || ""));
    toastAnim.stopAnimation();
    toastAnim.setValue(0);

    Animated.timing(toastAnim, {
      toValue: 1,
      duration: 180,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: true,
    }).start(() => {
      setTimeout(() => {
        Animated.timing(toastAnim, {
          toValue: 0,
          duration: 180,
          easing: Easing.in(Easing.cubic),
          useNativeDriver: true,
        }).start();
      }, 1200);
    });
  };

  const openModal = ({
    variant = "info",
    title = "",
    message = "",
    code = "",
    showCode = false,
    primaryText = "OK",
    secondaryText = "",
    showCopy = false,
    showShare = false,
    onPrimary = null,
    onSecondary = null,
  }) => {
    primaryActionRef.current = typeof onPrimary === "function" ? onPrimary : null;
    secondaryActionRef.current = typeof onSecondary === "function" ? onSecondary : null;

    setUiModal({
      visible: true,
      variant,
      title,
      message,
      code: String(code || ""),
      showCode: !!showCode,
      primaryText: String(primaryText || "OK"),
      secondaryText: String(secondaryText || ""),
      showCopy: !!showCopy,
      showShare: !!showShare,
    });

    modalAnim.stopAnimation();
    modalAnim.setValue(0);
    Animated.timing(modalAnim, {
      toValue: 1,
      duration: 220,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: true,
    }).start();
  };

  const closeModal = () => {
    modalAnim.stopAnimation();
    Animated.timing(modalAnim, {
      toValue: 0,
      duration: 160,
      easing: Easing.in(Easing.cubic),
      useNativeDriver: true,
    }).start(() => {
      setUiModal((m) => ({ ...m, visible: false }));
      primaryActionRef.current = null;
      secondaryActionRef.current = null;
    });
  };

  const runPrimary = () => {
    const fn = primaryActionRef.current;
    closeModal();
    if (fn) setTimeout(() => fn(), 50);
  };

  const runSecondary = () => {
    const fn = secondaryActionRef.current;
    closeModal();
    if (fn) setTimeout(() => fn(), 50);
  };

  const setupParam = String(params?.setup || "") === "1";
  const [hasSession, setHasSession] = useState(false);
  const [createRequired, setCreateRequired] = useState(false);

  useEffect(() => {
    let alive = true;

    (async () => {
      try {
        const { data } = await supabase.auth.getSession();
        if (!alive) return;
        setHasSession(!!data?.session);
      } catch {
        if (!alive) return;
        setHasSession(false);
      }
    })();

    const { data: sub } = supabase.auth.onAuthStateChange((_event, session) => {
      setHasSession(!!session);
    });

    return () => {
      alive = false;
      sub?.subscription?.unsubscribe?.();
    };
  }, []);

  useEffect(() => {
    let mounted = true;

    (async () => {
      try {
        const flag = await AsyncStorage.getItem(STORAGE_KEY_POST_LOGIN_ACTION);
        const mustCreate = flag === "create_required";
        if (!mounted) return;

        setCreateRequired(mustCreate);

        if (hasSession && (setupParam || mustCreate)) {
          setAuthMode("login");
          setActionMode("create");
        }
      } catch {
        if (!mounted) return;
        setCreateRequired(false);
      }
    })();

    return () => {
      mounted = false;
    };
  }, [setupParam, hasSession]);

  const inSetupRequired = hasSession && (setupParam || createRequired);

  const title = useMemo(() => {
    if (inSetupRequired) return "Fleet Setup Required";
    if (authMode === "signup") return "Create Account";
    if (actionMode === "join") return "System Login • Join Fleet";
    if (actionMode === "create") return "System Login • Create Fleet";
    return "System Login";
  }, [authMode, actionMode, inSetupRequired]);

  const signOutAndClear = async () => {
    try {
      setLoading(true);

      // ✅ get uid BEFORE signout (after signout you won't have it)
      const before = await getServerUserIdentity();
      const uid = before?.id || null;

      // ✅ IMPORTANT: local sign-out so one device cannot log out the other
      try {
        await supabase.auth.signOut({ scope: "local" });
      } catch {
        await supabase.auth.signOut();
      }

      await AsyncStorage.multiRemove([
        STORAGE_KEY_GROUP_ID,
        STORAGE_KEY_INVITE_CODE,
        STORAGE_KEY_PENDING_INVITE,
        STORAGE_KEY_POST_LOGIN_ACTION,
        STORAGE_KEY_LAST_USER_ID,
        "sentinel_pin_hash",
        ...(uid ? [getDeviceNameKeyForUser(uid)] : []),
        // keep legacy name unless you want a total wipe:
        // STORAGE_KEY_DEVICE_NAME_LEGACY,
      ]);
      try { if (SecureStore?.deleteItemAsync) await SecureStore.deleteItemAsync("sentinel_pin_hash"); } catch {}
    } catch {}
    setLoading(false);
    router.replace("/(auth)/auth");
  };

  const handleForgotPassword = async () => {
    const cleanEmail = String(email || "").trim().toLowerCase();
    if (!cleanEmail) {
      openModal({
        variant: "info",
        title: "Enter your email",
        message: "Type the email you used, then tap Forgot Password again.",
      });
      return;
    }

    try {
      setLoading(true);
      const { error } = await supabase.auth.resetPasswordForEmail(cleanEmail, {
        redirectTo: PASSWORD_RESET_REDIRECT,
      });

      if (error) throw error;

      openModal({
        variant: "success",
        title: "Reset Email Sent",
        message:
          "Check your email for a password reset link.\n\nAfter you reset it, come back to the app and log in.",
        primaryText: "OK",
      });
    } catch (e) {
      openModal({
        variant: "error",
        title: "Reset Failed",
        message: e?.message || "Could not send reset email.",
      });
    } finally {
      setLoading(false);
    }
  };

  const shareInvite = async (code) => {
    try {
      const clean = String(code || "").trim();
      if (!clean) return;

      await Share.share({
        message: `SenTihNel Invite Code: ${clean}\n\nOpen the app → Login → Join Fleet → enter this code.`,
      });
    } catch (e) {
      console.log("Share failed:", e?.message || e);
      showToast("Share not available");
    }
  };

  const copyInvite = async (code) => {
    const clean = String(code || "").trim();
    if (!clean) return;

    try {
      await Clipboard.setStringAsync(clean);
      showToast("Copied invite code");
    } catch (e) {
      console.log("Clipboard copy failed:", e?.message || e);
      showToast("Could not copy — long-press code to select");
    }
  };

  const createFleetNow = async (expectedUser) => {
    setLoading(true);
    try {
      // ✅ If we were called from login flow, enforce the expected server session
      if (expectedUser?.id) {
        await assertServerIsExpected(expectedUser.id, expectedUser.email || null, "before-createFleet");
      }

      const server = await getServerUserIdentity();
      const userId = server?.id;

      if (!userId) {
        openModal({
          variant: "error",
          title: "Login Required",
          message: "Please log in after confirming your email, then try Create Fleet again.",
        });
        return;
      }

      await enforceUserIsolation(userId);

      // ✅ prefer stored per-user name if UI is empty
      const storedName = await loadDisplayNameForUser(userId);
      const effectiveName = String(displayName || "").trim() || storedName;
      const dnStored = await persistDisplayNameForUser(userId, effectiveName);

      const owned = await getOwnedGroupForUser(userId);
      if (owned?.groupId) {
        await AsyncStorage.setItem(STORAGE_KEY_GROUP_ID, String(owned.groupId));
        if (owned.inviteCode) await AsyncStorage.setItem(STORAGE_KEY_INVITE_CODE, String(owned.inviteCode));

        await AsyncStorage.removeItem(STORAGE_KEY_POST_LOGIN_ACTION);
        await AsyncStorage.removeItem(STORAGE_KEY_PENDING_INVITE);

        // ✅ block handshake if session mismatched (safety)
        await assertServerIsExpected(userId, server.email || null, "before-handshake(create)");
        const hsOwned = await handshakeDevice({ groupId: owned.groupId, displayName: dnStored });
        if (!hsOwned?.ok) {
          openModal({
            variant: "error",
            title: "Device Registration Failed",
            message: `Fleet exists but device could not register: ${hsOwned?.error || "Unknown error"}\n\nPlease try again.`,
            primaryText: "RETRY",
            onPrimary: () => createFleetNow(expectedUser),
          });
          return;
        }
        await kickTrackerRebind("create-owned");

        openModal({
          variant: "success",
          title: "Fleet Ready",
          message: "Your fleet is active. Share your invite code with family/helpers.",
          code: owned.inviteCode || "",
          showCode: !!owned.inviteCode,
          showCopy: !!owned.inviteCode,
          showShare: !!owned.inviteCode,
          primaryText: "CONTINUE",
          onPrimary: () => router.replace("/(app)/fleet"),
        });
        return;
      }

      await AsyncStorage.multiRemove([STORAGE_KEY_GROUP_ID, STORAGE_KEY_INVITE_CODE]);

      const { data: created, used, attempts } = await tryCreateFleetRpc(userId);

      if (!used) {
        const last = attempts?.length ? attempts[attempts.length - 1]?.message : "No matching RPC found.";
        openModal({
          variant: "error",
          title: "Create Fleet Failed",
          message:
            `Create Fleet could not run.\n\nMost recent error:\n${last}\n\n` +
            `Phase 1 fix (most common):\n• Ensure src/lib/supabase.js uses AsyncStorage\n• Restart app: npx expo start -c`,
          primaryText: "OK",
        });
        return;
      }

      const row = Array.isArray(created) ? created[0] : created;
      const createdGroupId = row?.group_id || row?.id || null;
      const createdInvite = row?.invite_code || null;

      if (!createdGroupId || !createdInvite) {
        throw new Error(`Create fleet RPC '${used}' returned, but no group_id/invite_code was found.`);
      }

      await AsyncStorage.setItem(STORAGE_KEY_GROUP_ID, String(createdGroupId));
      await AsyncStorage.setItem(STORAGE_KEY_INVITE_CODE, String(createdInvite));

      await AsyncStorage.removeItem(STORAGE_KEY_POST_LOGIN_ACTION);
      await AsyncStorage.removeItem(STORAGE_KEY_PENDING_INVITE);

      await assertServerIsExpected(userId, server.email || null, "before-handshake(create2)");
      const hsNew = await handshakeDevice({ groupId: createdGroupId, displayName: dnStored });
      if (!hsNew?.ok) {
        openModal({
          variant: "error",
          title: "Device Registration Failed",
          message: `Fleet created but device could not register: ${hsNew?.error || "Unknown error"}\n\nPlease try again.`,
          primaryText: "RETRY",
          onPrimary: () => createFleetNow(expectedUser),
        });
        return;
      }
      await kickTrackerRebind("create-new");

      openModal({
        variant: "success",
        title: "Fleet Created",
        message: "Share this code with family/helpers so they can join instantly.",
        code: createdInvite,
        showCode: true,
        showCopy: true,
        showShare: true,
        primaryText: "CONTINUE",
        onPrimary: () => router.replace("/(app)/fleet"),
      });
    } catch (err) {
      const msg = String(err?.message || "");

      if (msg.toLowerCase().includes("group_members") && msg.toLowerCase().includes("user_id")) {
        openModal({
          variant: "error",
          title: "Session Not Attached",
          message:
            "You are logged in, but Supabase did not receive your auth identity during Create Fleet.\n\n" +
            "Fix:\n• Ensure src/lib/supabase.js uses AsyncStorage adapter\n• Restart: npx expo start -c\n• Log in again → Create Fleet",
        });
        return;
      }

      if (isRpcMissingError(msg)) {
        openModal({
          variant: "error",
          title: "Create Fleet RPC Missing",
          message: "Supabase can’t find the Create Fleet RPC.\n\nConfirm you have:\n• create_group_auto_invite_code",
        });
        return;
      }

      openModal({
        variant: "error",
        title: "Error",
        message: err?.message || "Something went wrong.",
      });
    } finally {
      setLoading(false);
    }
  };

  const handleSubmit = async () => {
    if (inSetupRequired) {
      await createFleetNow(null);
      return;
    }

    const cleanEmail = String(email || "").trim().toLowerCase();
    const cleanCode = normalizeInviteCode(inviteCode);

    if (!cleanEmail || !password) {
      openModal({ variant: "info", title: "Missing Info", message: "Please enter email and password." });
      return;
    }

    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleanEmail)) {
      openModal({ variant: "info", title: "Invalid Email", message: "Please enter a valid email address." });
      return;
    }

    if (authMode === "signup" && password.length < 6) {
      openModal({ variant: "info", title: "Weak Password", message: "Password must be at least 6 characters." });
      return;
    }

    if (actionMode === "join" && !cleanCode) {
      openModal({ variant: "info", title: "Invite Code Required", message: "Enter your fleet invite code." });
      return;
    }

    setLoading(true);

    try {
      await ensureFreshSessionForEmail(cleanEmail);

      // SIGNUP
      if (authMode === "signup") {
        if (actionMode !== "join") {
          await AsyncStorage.setItem(STORAGE_KEY_POST_LOGIN_ACTION, "create_required");
          await AsyncStorage.removeItem(STORAGE_KEY_PENDING_INVITE);
        } else {
          await AsyncStorage.removeItem(STORAGE_KEY_POST_LOGIN_ACTION);
        }

        if (actionMode === "join") {
          const exists = await resolveGroupIdByInviteCode(cleanCode);
          if (!exists) {
            openModal({ variant: "error", title: "Invalid Code", message: "That invite code does not exist." });
            return;
          }
        }

        const { data: authData, error: authError } = await supabase.auth.signUp({
          email: cleanEmail,
          password,
          options: { emailRedirectTo: EMAIL_CONFIRM_REDIRECT },
        });

        if (authError) throw authError;

        if (!authData?.session) {
          if (actionMode === "join" && cleanCode) {
            await AsyncStorage.setItem(STORAGE_KEY_PENDING_INVITE, cleanCode);
            await AsyncStorage.setItem(STORAGE_KEY_PENDING_FLEET_TYPE, fleetType); // ✅ Store fleet type
          } else {
            await AsyncStorage.removeItem(STORAGE_KEY_PENDING_INVITE);
            await AsyncStorage.removeItem(STORAGE_KEY_PENDING_FLEET_TYPE);
          }

          openModal({
            variant: "success",
            title: "Confirm Your Email",
            message:
              actionMode === "join"
                ? "Account created!\n\nConfirm your email, then come back and LOG IN.\nAfter login, you’ll be linked to the fleet."
                : "Account created!\n\nConfirm your email, then come back and LOG IN.\nAfter login, you must Create Fleet before continuing.",
            primaryText: "OK",
          });

          resetAuthUiToLogin(setAuthMode, setActionMode, setPassword, setInviteCode);
          setShowPassword(false);
          return;
        }

        openModal({
          variant: "success",
          title: "Account Created",
          message: "Your account is ready. Please log in to continue.",
        });

        resetAuthUiToLogin(setAuthMode, setActionMode, setPassword, setInviteCode);
        setShowPassword(false);
        return;
      }

      // LOGIN
      await logAuth("before-login");

      const { data: loginData, error: loginError } = await supabase.auth.signInWithPassword({
        email: cleanEmail,
        password,
      });
      if (loginError) throw loginError;

      const loginUser = loginData?.user;
      if (!loginUser?.id) {
        openModal({ variant: "error", title: "Login Error", message: "Login succeeded but no user was returned." });
        return;
      }

      // ✅ CRITICAL FIX: wait until SERVER user matches the login result + typed email
      const matched = await waitForServerMatch({
        expectedUserId: loginUser.id,
        expectedEmail: cleanEmail,
        tries: 14,
        delayMs: 250,
      });

      if (!matched?.id) {
        await logAuth("login-mismatch");
        openModal({
          variant: "error",
          title: "Session Not Updating",
          message:
            "Your device did not switch to the account you just logged into.\n\n" +
            "This causes the invite code to run under the wrong account.\n\n" +
            "Fix:\n• Tap OK to sign out\n• Reopen app\n• Log in again",
          primaryText: "OK",
          onPrimary: signOutAndClear,
        });
        return;
      }

      // ✅ Clear stale fleet ID before isolation check (prevents wrong-user fleet surviving login swap)
      await AsyncStorage.removeItem(STORAGE_KEY_GROUP_ID);
      await enforceUserIsolation(matched.id);

      // Clear local PIN hash so home.js re-syncs the correct one from cloud
      // (handles: reinstall, PIN changed on another device, user switch)
      try { await AsyncStorage.removeItem("sentinel_pin_hash"); } catch {}
      try { if (SecureStore?.deleteItemAsync) await SecureStore.deleteItemAsync("sentinel_pin_hash"); } catch {}

      // ✅ Load per-user display name if UI is empty
      const storedName = await loadDisplayNameForUser(matched.id);
      if (storedName && !String(displayName || "").trim()) {
        setDisplayName(storedName);
      }
      const dn = await persistDisplayNameForUser(matched.id, storedName || displayName);

      await logAuth("after-login");

      const postAction = await AsyncStorage.getItem(STORAGE_KEY_POST_LOGIN_ACTION);
      if (postAction === "create_required") {
        router.replace("/(auth)/auth?setup=1");
        return;
      }

      const pending = normalizeInviteCode(await AsyncStorage.getItem(STORAGE_KEY_PENDING_INVITE));

      // CREATE
      if (actionMode === "create") {
        await AsyncStorage.removeItem(STORAGE_KEY_PENDING_INVITE);
        await createFleetNow({ id: matched.id, email: matched.email || cleanEmail });
        return;
      }

      // JOIN (explicit)
      if (actionMode === "join") {
        await assertServerIsExpected(matched.id, matched.email || cleanEmail, "before-join");

        const targetGroupId = await resolveGroupIdByInviteCode(cleanCode);
        if (!targetGroupId) {
          openModal({ variant: "error", title: "Invalid Code", message: "That invite code does not exist." });
          return;
        }

        await AsyncStorage.multiRemove([STORAGE_KEY_GROUP_ID, STORAGE_KEY_INVITE_CODE]);

        await logAuth("before-join-rpc");

        const { data: joinData, error: joinErr } = await supabase.rpc(RPC_JOIN_GROUP, {
          p_invite_code: cleanCode,
          p_fleet_type: fleetType, // ✅ Pass user's chosen fleet type
        });
        if (joinErr) throw joinErr;

        const extracted = extractGroupIdFromRpc(joinData);
        const expected = extracted || targetGroupId;

        const verified = await waitForMembershipGroupId(matched.id, { expectedGroupId: expected });
        const groupId = verified || expected;

        if (!groupId || String(groupId).includes("[object")) {
          openModal({
            variant: "error",
            title: "Join Failed",
            message:
              "Join request returned, but membership was not created for the expected fleet.\n\n" +
              "This usually means the join RPC is not inserting into group_members correctly.",
            primaryText: "OK",
          });
          return;
        }

        await AsyncStorage.setItem(STORAGE_KEY_GROUP_ID, String(groupId));

        const code = await fetchInviteCodeForGroup(groupId);
        if (code) await AsyncStorage.setItem(STORAGE_KEY_INVITE_CODE, String(code));

        await AsyncStorage.removeItem(STORAGE_KEY_PENDING_INVITE);
        await AsyncStorage.removeItem(STORAGE_KEY_POST_LOGIN_ACTION);

        // ✅ HARD BLOCK: do not handshake unless session is still correct
        await assertServerIsExpected(matched.id, matched.email || cleanEmail, "before-handshake(join)");
        const hsJoin = await handshakeDevice({ groupId, displayName: dn });
        if (!hsJoin?.ok) {
          openModal({
            variant: "error",
            title: "Device Registration Failed",
            message: `Joined fleet but device could not register: ${hsJoin?.error || "Unknown error"}\n\nPlease restart the app and try again.`,
          });
          return;
        }
        await kickTrackerRebind("join");

        await logAuth("after-join");

        openModal({
          variant: "success",
          title: "Joined Fleet",
          message: "You're now linked and visible to the fleet manager.",
          primaryText: "CONTINUE",
          onPrimary: () => router.replace("/(app)/fleet"),
        });
        return;
      }

      // PENDING JOIN (signup flow)
      if (pending) {
        await assertServerIsExpected(matched.id, matched.email || cleanEmail, "before-pending-join");

        const targetGroupId = await resolveGroupIdByInviteCode(pending);
        // ✅ Retrieve stored fleet type (default to "family" if not found)
        const pendingFleetType = (await AsyncStorage.getItem(STORAGE_KEY_PENDING_FLEET_TYPE)) || "family";

        await AsyncStorage.multiRemove([STORAGE_KEY_GROUP_ID, STORAGE_KEY_INVITE_CODE]);

        const { data: joinData, error: joinErr } = await supabase.rpc(RPC_JOIN_GROUP, {
          p_invite_code: pending,
          p_fleet_type: pendingFleetType, // ✅ Pass stored fleet type
        });

        if (joinErr) {
          // ✅ Don't clear pending invite on failure — user should retry
          openModal({
            variant: "error",
            title: "Fleet Join Failed",
            message: `Could not join fleet with code "${pending}".\n\nError: ${joinErr?.message || "Unknown error"}\n\nPlease log in again to retry.`,
            primaryText: "OK",
          });
          return;
        } else {
          const extracted = extractGroupIdFromRpc(joinData);
          const expected = extracted || targetGroupId;

          const verified = await waitForMembershipGroupId(matched.id, { expectedGroupId: expected });
          const groupId = verified || expected;

          if (groupId) {
            await AsyncStorage.setItem(STORAGE_KEY_GROUP_ID, String(groupId));
            const code = await fetchInviteCodeForGroup(groupId);
            if (code) await AsyncStorage.setItem(STORAGE_KEY_INVITE_CODE, String(code));

            await AsyncStorage.removeItem(STORAGE_KEY_PENDING_INVITE);
            await AsyncStorage.removeItem(STORAGE_KEY_PENDING_FLEET_TYPE);
            await AsyncStorage.removeItem(STORAGE_KEY_POST_LOGIN_ACTION);

            await assertServerIsExpected(matched.id, matched.email || cleanEmail, "before-handshake(pending)");
            const hsPending = await handshakeDevice({ groupId, displayName: dn });
            if (!hsPending?.ok) {
              openModal({
                variant: "error",
                title: "Device Registration Failed",
                message: `Joined fleet but device could not register: ${hsPending?.error || "Unknown error"}\n\nPlease restart the app and try again.`,
              });
              return;
            }
            await kickTrackerRebind("pending-join");

            openModal({
              variant: "success",
              title: "Fleet Linked",
              message: `Your account is now linked to the fleet as your ${pendingFleetType} fleet.`,
              primaryText: "CONTINUE",
              onPrimary: () => router.replace("/(app)/fleet"),
            });
            return;
          }

          await AsyncStorage.removeItem(STORAGE_KEY_PENDING_INVITE);
          await AsyncStorage.removeItem(STORAGE_KEY_PENDING_FLEET_TYPE);
        }
      }

      // RESUME (only if no join intent happened)
      const existingGroupId = await getGroupIdForUser(matched.id);
      if (existingGroupId) {
        await AsyncStorage.setItem(STORAGE_KEY_GROUP_ID, String(existingGroupId));

        const code = await fetchInviteCodeForGroup(existingGroupId);
        if (code) await AsyncStorage.setItem(STORAGE_KEY_INVITE_CODE, String(code));

        await AsyncStorage.removeItem(STORAGE_KEY_PENDING_INVITE);
        await AsyncStorage.removeItem(STORAGE_KEY_POST_LOGIN_ACTION);

        await assertServerIsExpected(matched.id, matched.email || cleanEmail, "before-handshake(resume)");
        const hsResume = await handshakeDevice({ groupId: existingGroupId, displayName: dn });
        if (!hsResume?.ok) {
          console.log("⚠️ Resume handshake failed:", hsResume?.error);
          // Non-blocking on resume — user can still enter app, handshake will retry on next sync
        }
        await kickTrackerRebind("resume");

        router.replace("/(app)/fleet");
        return;
      }

      router.replace("/(auth)/auth?setup=1");
    } catch (err) {
      openModal({ variant: "error", title: "Error", message: err?.message || "Something went wrong." });
    } finally {
      setLoading(false);
    }
  };

  const showInviteInput = !inSetupRequired && actionMode === "join";

  const modalAccent =
    uiModal.variant === "success" ? "#22c55e" : uiModal.variant === "error" ? "#ef4444" : "#94a3b8";

  const modalIcon =
    uiModal.variant === "success"
      ? "checkmark-circle"
      : uiModal.variant === "error"
      ? "warning-outline"
      : "information-circle";

  const modalScale = modalAnim.interpolate({ inputRange: [0, 1], outputRange: [0.96, 1] });
  const modalOpacity = modalAnim.interpolate({ inputRange: [0, 1], outputRange: [0, 1] });

  const toastTranslateY = toastAnim.interpolate({ inputRange: [0, 1], outputRange: [12, 0] });
  const toastOpacity = toastAnim.interpolate({ inputRange: [0, 1], outputRange: [0, 1] });

  return (
    <KeyboardAvoidingView
      style={{ flex: 1, backgroundColor: "#0b1220" }}
      behavior={Platform.OS === "ios" ? "padding" : undefined}
    >
      <Modal transparent visible={uiModal.visible} animationType="none" onRequestClose={closeModal}>
        <Pressable style={styles.modalBackdrop} onPress={closeModal}>
          <Pressable onPress={() => {}} style={{ width: "100%", maxWidth: 420 }}>
            <Animated.View
              style={[
                styles.modalCard,
                {
                  opacity: modalOpacity,
                  transform: [
                    { scale: modalScale },
                    { translateY: modalAnim.interpolate({ inputRange: [0, 1], outputRange: [10, 0] }) },
                  ],
                },
              ]}
            >
              <View style={styles.modalHeader}>
                <View
                  style={[
                    styles.modalIconWrap,
                    { borderColor: `${modalAccent}55`, backgroundColor: `${modalAccent}14` },
                  ]}
                >
                  <Ionicons name={modalIcon} size={22} color={modalAccent} />
                </View>
                <TouchableOpacity onPress={closeModal} style={styles.modalCloseBtn} activeOpacity={0.7}>
                  <Ionicons name="close" size={18} color="#94a3b8" />
                </TouchableOpacity>
              </View>

              <Text style={styles.modalTitle}>{uiModal.title}</Text>
              {!!uiModal.message && <Text style={styles.modalMsg}>{uiModal.message}</Text>}

              {uiModal.showCode && (
                <TouchableOpacity
                  activeOpacity={0.85}
                  onPress={() => copyInvite(uiModal.code)}
                  onLongPress={() => copyInvite(uiModal.code)}
                  style={[
                    styles.codePill,
                    { borderColor: `${modalAccent}55`, backgroundColor: `${modalAccent}12` },
                  ]}
                >
                  <Text style={[styles.codeText, { color: modalAccent }]} selectable>
                    {uiModal.code}
                  </Text>
                  <View style={styles.codePillRight}>
                    <Ionicons name="copy-outline" size={16} color={modalAccent} />
                    <Text style={[styles.codeHint, { color: modalAccent }]}>Tap / Hold to copy</Text>
                  </View>
                </TouchableOpacity>
              )}

              {(uiModal.showCopy || uiModal.showShare) && (
                <View style={styles.modalActionsRow}>
                  {uiModal.showCopy && (
                    <TouchableOpacity
                      style={[styles.modalSmallBtn, { borderColor: `${modalAccent}55` }]}
                      onPress={() => copyInvite(uiModal.code)}
                      activeOpacity={0.85}
                    >
                      <Ionicons name="copy-outline" size={16} color="#e2e8f0" />
                      <Text style={styles.modalSmallBtnText}>Copy</Text>
                    </TouchableOpacity>
                  )}

                  {uiModal.showShare && (
                    <TouchableOpacity
                      style={[styles.modalSmallBtn, { borderColor: `${modalAccent}55` }]}
                      onPress={() => shareInvite(uiModal.code)}
                      activeOpacity={0.85}
                    >
                      <Ionicons name="share-social-outline" size={16} color="#e2e8f0" />
                      <Text style={styles.modalSmallBtnText}>Share</Text>
                    </TouchableOpacity>
                  )}
                </View>
              )}

              {!!uiModal.secondaryText && (
                <TouchableOpacity onPress={runSecondary} style={styles.modalSecondaryBtn} activeOpacity={0.85}>
                  <Text style={styles.modalSecondaryText}>{uiModal.secondaryText}</Text>
                </TouchableOpacity>
              )}

              <TouchableOpacity
                onPress={runPrimary}
                style={[styles.modalPrimaryBtn, { backgroundColor: modalAccent }]}
                activeOpacity={0.9}
              >
                <Text style={styles.modalPrimaryText}>{uiModal.primaryText}</Text>
              </TouchableOpacity>
            </Animated.View>
          </Pressable>
        </Pressable>
      </Modal>

      <Animated.View
        pointerEvents="none"
        style={[styles.toast, { opacity: toastOpacity, transform: [{ translateY: toastTranslateY }] }]}
      >
        <Ionicons name="checkmark" size={14} color="#0b1220" />
        <Text style={styles.toastText}>{toastText}</Text>
      </Animated.View>

      <View style={styles.container}>
        <Text style={styles.logo}>SENTIHNEL</Text>
        <Text style={styles.subtitle}>{title}</Text>

        {inSetupRequired ? (
          <View style={styles.setupCard}>
            <Text style={styles.setupTitle}>Create your fleet to continue</Text>
            <Text style={styles.setupText}>
              Your account is active, but you don’t have a fleet yet.
              {"\n\n"}
              Create a fleet now and you’ll get an invite code you can share.
            </Text>

            <TextInput
              style={styles.input}
              placeholder="Your Name (for SOS alerts)"
              placeholderTextColor="#64748b"
              value={displayName}
              onChangeText={setDisplayName}
              autoCapitalize="words"
            />

            <TouchableOpacity style={styles.button} onPress={handleSubmit} disabled={loading}>
              {loading ? <ActivityIndicator color="#fff" /> : <Text style={styles.buttonText}>CREATE FLEET</Text>}
            </TouchableOpacity>

            <TouchableOpacity onPress={signOutAndClear} disabled={loading} style={{ marginTop: 14 }}>
              <Text style={styles.signOutText}>Sign out</Text>
            </TouchableOpacity>
          </View>
        ) : (
          <>
            <TextInput
              style={styles.input}
              placeholder="Email"
              placeholderTextColor="#64748b"
              value={email}
              onChangeText={setEmail}
              autoCapitalize="none"
              keyboardType="email-address"
            />

            <TextInput
              style={styles.input}
              placeholder="Your Name (for SOS alerts)"
              placeholderTextColor="#64748b"
              value={displayName}
              onChangeText={setDisplayName}
              autoCapitalize="words"
            />

            <View style={styles.passwordWrap}>
              <TextInput
                style={styles.passwordInput}
                placeholder="Password"
                placeholderTextColor="#64748b"
                value={password}
                onChangeText={setPassword}
                secureTextEntry={!showPassword}
                autoCapitalize="none"
              />
              <TouchableOpacity onPress={() => setShowPassword((v) => !v)} style={styles.eyeBtn} activeOpacity={0.7}>
                <Ionicons name={showPassword ? "eye-off" : "eye"} size={20} color="#94a3b8" />
              </TouchableOpacity>
            </View>

            {authMode === "login" && (
              <TouchableOpacity onPress={handleForgotPassword} disabled={loading} style={styles.forgotBtn}>
                <Text style={styles.forgotText}>Forgot Password?</Text>
              </TouchableOpacity>
            )}

            {showInviteInput && (
              <>
                <TextInput
                  style={styles.input}
                  placeholder="Invite Code (Required)"
                  placeholderTextColor="#64748b"
                  value={inviteCode}
                  onChangeText={setInviteCode}
                  keyboardType="default"
                  autoCapitalize="characters"
                />

                {/* ✅ Fleet Type Selector */}
                <View style={styles.fleetTypeContainer}>
                  <Text style={styles.fleetTypeLabel}>Join as:</Text>
                  <View style={styles.fleetTypeButtons}>
                    <TouchableOpacity
                      style={[
                        styles.fleetTypeBtn,
                        fleetType === "family" && styles.fleetTypeBtnActive,
                      ]}
                      onPress={() => setFleetType("family")}
                      disabled={loading}
                    >
                      <Ionicons
                        name="home"
                        size={16}
                        color={fleetType === "family" ? "#0b1220" : "#94a3b8"}
                      />
                      <Text
                        style={[
                          styles.fleetTypeBtnText,
                          fleetType === "family" && styles.fleetTypeBtnTextActive,
                        ]}
                      >
                        Family
                      </Text>
                    </TouchableOpacity>

                    <TouchableOpacity
                      style={[
                        styles.fleetTypeBtn,
                        fleetType === "work" && styles.fleetTypeBtnActive,
                      ]}
                      onPress={() => setFleetType("work")}
                      disabled={loading}
                    >
                      <Ionicons
                        name="briefcase"
                        size={16}
                        color={fleetType === "work" ? "#0b1220" : "#94a3b8"}
                      />
                      <Text
                        style={[
                          styles.fleetTypeBtnText,
                          fleetType === "work" && styles.fleetTypeBtnTextActive,
                        ]}
                      >
                        Work
                      </Text>
                    </TouchableOpacity>
                  </View>
                  <Text style={styles.fleetTypeHint}>
                    You can have one Family fleet and one Work fleet
                  </Text>
                </View>
              </>
            )}

            <TouchableOpacity style={styles.button} onPress={handleSubmit} disabled={loading}>
              {loading ? (
                <ActivityIndicator color="#fff" />
              ) : (
                <Text style={styles.buttonText}>
                  {authMode === "signup"
                    ? actionMode === "join"
                      ? "SIGN UP + JOIN"
                      : "SIGN UP"
                    : actionMode === "join"
                    ? "LOGIN + JOIN"
                    : actionMode === "create"
                    ? "LOGIN + CREATE"
                    : "LOGIN"}
                </Text>
              )}
            </TouchableOpacity>

            <View style={styles.toggleRow}>
              <TouchableOpacity onPress={() => setAuthMode("login")} disabled={loading}>
                <Text style={[styles.toggleText, authMode === "login" && styles.activeToggle]}>Login</Text>
              </TouchableOpacity>

              <Text style={styles.divider}>|</Text>

              <TouchableOpacity onPress={() => setAuthMode("signup")} disabled={loading}>
                <Text style={[styles.toggleText, authMode === "signup" && styles.activeToggle]}>Sign Up</Text>
              </TouchableOpacity>
            </View>

            <View style={[styles.toggleRow, { marginTop: 14 }]}>
              <TouchableOpacity onPress={() => setActionMode("login")} disabled={loading || authMode === "signup"}>
                <Text
                  style={[
                    styles.toggleText,
                    actionMode === "login" && authMode === "login" && styles.activeToggle,
                    authMode === "signup" && styles.disabledToggle,
                  ]}
                >
                  Login Only
                </Text>
              </TouchableOpacity>

              <Text style={styles.divider}>|</Text>

              <TouchableOpacity onPress={() => setActionMode("join")} disabled={loading}>
                <Text style={[styles.toggleText, actionMode === "join" && styles.activeToggle]}>Join Fleet</Text>
              </TouchableOpacity>

              <Text style={styles.divider}>|</Text>

              <TouchableOpacity onPress={() => setActionMode("create")} disabled={loading || authMode === "signup"}>
                <Text
                  style={[
                    styles.toggleText,
                    actionMode === "create" && authMode === "login" && styles.activeToggle,
                    authMode === "signup" && styles.disabledToggle,
                  ]}
                >
                  Create Fleet
                </Text>
              </TouchableOpacity>
            </View>

            <Text style={styles.footnote}>
              {authMode === "signup"
                ? actionMode === "join"
                  ? "Create account. Confirm email. Then log in and you’ll be linked to the fleet."
                  : "Create account. Confirm email. Then log in. You will be required to create a fleet before continuing."
                : actionMode === "create"
                ? "Create a new fleet and get a unique invite code (saved in Fleet Manager)."
                : actionMode === "join"
                ? "Join a fleet using the invite code."
                : "Log in to resume protection."}
            </Text>
          </>
        )}
      </View>
    </KeyboardAvoidingView>
  );
}

// ===============================
// Styles
// ===============================
const styles = StyleSheet.create({
  container: { flex: 1, justifyContent: "center", padding: 30 },
  logo: { color: "#22c55e", fontSize: 32, fontWeight: "bold", textAlign: "center", letterSpacing: 4, marginBottom: 8 },
  subtitle: { color: "#94a3b8", textAlign: "center", marginBottom: 26 },

  input: {
    backgroundColor: "#1e293b",
    color: "#fff",
    padding: 15,
    borderRadius: 10,
    marginBottom: 12,
    borderWidth: 1,
    borderColor: "#0f172a",
  },

  passwordWrap: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: "#1e293b",
    borderRadius: 10,
    borderWidth: 1,
    borderColor: "#0f172a",
    marginBottom: 6,
  },
  passwordInput: { flex: 1, color: "#fff", paddingVertical: 15, paddingLeft: 15, paddingRight: 10 },
  eyeBtn: { paddingHorizontal: 14, paddingVertical: 14 },

  forgotBtn: { alignSelf: "flex-end", marginBottom: 10, marginTop: 2 },
  forgotText: { color: "#94a3b8", fontWeight: "800", fontSize: 12 },

  button: { backgroundColor: "#22c55e", padding: 16, borderRadius: 10, alignItems: "center", marginTop: 6 },
  buttonText: { color: "#fff", fontWeight: "800", fontSize: 16, letterSpacing: 1 },

  toggleRow: {
    flexDirection: "row",
    justifyContent: "center",
    alignItems: "center",
    marginTop: 24,
    gap: 15,
    flexWrap: "wrap",
  },
  toggleText: { color: "#64748b", fontWeight: "600" },
  activeToggle: { color: "#22c55e", fontWeight: "bold" },
  disabledToggle: { color: "#334155" },
  divider: { color: "#334155" },

  footnote: { color: "#334155", textAlign: "center", marginTop: 20, fontSize: 12 },

  // ✅ Fleet Type Selector styles
  fleetTypeContainer: {
    marginBottom: 14,
    padding: 14,
    borderRadius: 12,
    backgroundColor: "rgba(148, 163, 184, 0.06)",
    borderWidth: 1,
    borderColor: "rgba(148, 163, 184, 0.12)",
  },
  fleetTypeLabel: {
    color: "#94a3b8",
    fontSize: 12,
    fontWeight: "700",
    marginBottom: 10,
    letterSpacing: 0.3,
  },
  fleetTypeButtons: {
    flexDirection: "row",
    gap: 10,
  },
  fleetTypeBtn: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    paddingVertical: 12,
    paddingHorizontal: 14,
    borderRadius: 10,
    backgroundColor: "rgba(148, 163, 184, 0.08)",
    borderWidth: 1,
    borderColor: "rgba(148, 163, 184, 0.16)",
  },
  fleetTypeBtnActive: {
    backgroundColor: "#22c55e",
    borderColor: "#22c55e",
  },
  fleetTypeBtnText: {
    color: "#94a3b8",
    fontSize: 14,
    fontWeight: "700",
  },
  fleetTypeBtnTextActive: {
    color: "#0b1220",
  },
  fleetTypeHint: {
    color: "#64748b",
    fontSize: 10,
    marginTop: 10,
    textAlign: "center",
    fontWeight: "600",
  },

  setupCard: {
    backgroundColor: "#0f172a",
    borderRadius: 16,
    padding: 16,
    borderWidth: 1,
    borderColor: "rgba(34, 197, 94, 0.25)",
  },
  setupTitle: { color: "white", fontSize: 16, fontWeight: "900", marginBottom: 8 },
  setupText: { color: "#94a3b8", fontSize: 13, lineHeight: 18, fontWeight: "700" },
  signOutText: { color: "#64748b", fontWeight: "800", textAlign: "center" },

  modalBackdrop: {
    flex: 1,
    backgroundColor: "rgba(2, 6, 23, 0.72)",
    justifyContent: "center",
    alignItems: "center",
    padding: 18,
  },
  modalCard: {
    width: "100%",
    borderRadius: 18,
    backgroundColor: "#0f172a",
    borderWidth: 1,
    borderColor: "rgba(148, 163, 184, 0.18)",
    padding: 16,
  },
  modalHeader: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  modalIconWrap: {
    width: 38,
    height: 38,
    borderRadius: 12,
    borderWidth: 1,
    justifyContent: "center",
    alignItems: "center",
  },
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
  modalTitle: { color: "white", fontSize: 18, fontWeight: "900", marginTop: 10 },
  modalMsg: { color: "#94a3b8", fontSize: 13, lineHeight: 18, fontWeight: "700", marginTop: 8 },

  codePill: { marginTop: 14, borderRadius: 14, borderWidth: 1, paddingVertical: 12, paddingHorizontal: 14 },
  codeText: { fontSize: 22, fontWeight: "900", letterSpacing: 5, textAlign: "center" },
  codePillRight: { marginTop: 10, flexDirection: "row", justifyContent: "center", alignItems: "center", gap: 8 },
  codeHint: { fontSize: 12, fontWeight: "900", letterSpacing: 1 },

  modalActionsRow: { marginTop: 12, flexDirection: "row", gap: 10 },
  modalSmallBtn: {
    flex: 1,
    borderRadius: 14,
    paddingVertical: 12,
    backgroundColor: "rgba(148, 163, 184, 0.08)",
    borderWidth: 1,
    alignItems: "center",
    justifyContent: "center",
    flexDirection: "row",
    gap: 8,
  },
  modalSmallBtnText: { color: "#e2e8f0", fontWeight: "900", letterSpacing: 0.6, fontSize: 12 },

  modalSecondaryBtn: { marginTop: 10, alignItems: "center", paddingVertical: 8 },
  modalSecondaryText: { color: "#94a3b8", fontWeight: "900", letterSpacing: 0.6 },

  modalPrimaryBtn: { marginTop: 10, borderRadius: 14, paddingVertical: 14, alignItems: "center", justifyContent: "center" },
  modalPrimaryText: { color: "#0b1220", fontWeight: "900", letterSpacing: 1, fontSize: 13 },

  toast: {
    position: "absolute",
    left: 18,
    right: 18,
    bottom: 24,
    backgroundColor: "#22c55e",
    borderRadius: 14,
    paddingVertical: 12,
    paddingHorizontal: 14,
    flexDirection: "row",
    gap: 10,
    alignItems: "center",
    justifyContent: "center",
    zIndex: 50,
  },
  toastText: { color: "#0b1220", fontWeight: "900", letterSpacing: 0.6, fontSize: 12 },
});

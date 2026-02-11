// 📂 FILE LOCATION: SenTihNel/src/services/LiveTracker.js
// ✅ Phase 1: DO NOT delete sentinel_device_id (device ID must be stable)
// ✅ Phase 1: Always read latest group_id from AsyncStorage (avoid stale cache)
// ✅ Option B (movable): ALWAYS bind/move this device_id to the logged-in user via SECURITY DEFINER RPC
//    → uses register_or_move_device through handshakeDevice() with caching/throttling
//
// ✅ Phase 5 update (THIS CHANGE):
// - If SOS triggers before we get a “good” GPS lock, we immediately use LAST-KNOWN GPS (best-effort),
//   upload it to tracking_sessions, and keep updating as better GPS arrives.
// - forceOneShotSync() now supports fallback to getLastKnownPositionAsync() and can accept injected coords.

import * as Location from "expo-location";
import * as Battery from "expo-battery";
import * as TaskManager from "expo-task-manager";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { activateKeepAwakeAsync, deactivateKeepAwake } from "expo-keep-awake";
import { supabase } from "../lib/supabase";
import { getDeviceId as getStableDeviceId } from "./Identity";
import { handshakeDevice } from "./deviceHandshake";

const BACKGROUND_TASK_NAME = "BACKGROUND_LOCATION_TASK";
const STORAGE_KEY_DEVICE_ID = "sentinel_device_id";
const STORAGE_KEY_GROUP_ID = "sentinel_group_id";
const STORAGE_KEY_SOS = "sentinel_sos_active";

// ✅ server-side "claim" RPC (deletes stale tracking_sessions row for this device)
const RPC_CLAIM_TRACKING_DEVICE = "claim_tracking_session_device";

// ✅ Your DB now has these columns (after running your SQL):
const SCHEMA_FLAGS = {
  has_speed: true,
  has_heading: true,
  has_altitude: true,
  has_gps_quality: true,
  has_gps_accuracy_m: true,
  has_status: true,
  has_last_updated: true,
};

// Tracking profiles
const TRACKING_PROFILES = {
  SOS: {
    accuracy: Location.Accuracy.Highest,
    distanceInterval: 5,
    timeInterval: 5000,
    deferredUpdatesInterval: 5000,
    deferredUpdatesDistance: 5,
  },
};

// State Tracking (Memory)
let memoryDeviceId = null;
let isSending = false;
let pendingLocation = null;

// ✅ “Good” GPS (accurate) cache
let lastGoodCoords = null;

// ✅ Phase 5: “Last known” GPS cache (can be poor, but used immediately for SOS)
let lastKnownCoords = null;
let lastKnownAccuracyM = null;
let lastLastKnownFetchAt = 0;
const LAST_KNOWN_FETCH_COOLDOWN_MS = 15_000;

// ✅ Phase 3 fix: track last-seen group id in memory so we can rebind instantly on switch
let memoryGroupId = null;

// Small safety: avoid hammering Supabase if user is logged out / not ready
let lastAuthWarningAt = 0;
const AUTH_WARN_COOLDOWN_MS = 8000;

// ✅ Membership cache (reduces repeated queries)
let membershipCache = {
  userId: null,
  groupId: null,
  ok: false,
  checkedAt: 0,
};
const MEMBERSHIP_CACHE_MS_OK = 30_000;
const MEMBERSHIP_CACHE_MS_FAIL = 8_000;

// ✅ Device bind/move cache (prevents repeated register_or_move_device spam)
let bindCache = {
  userId: null,
  deviceId: null,
  groupId: null,
  ok: false,
  checkedAt: 0,
};
const BIND_CACHE_MS_OK = 60_000;
const BIND_CACHE_MS_FAIL = 3_000;

// ✅ Claim cache (prevents repeated claim spam)
let claimCache = {
  deviceId: null,
  groupId: null,
  ok: false,
  checkedAt: 0,
};
const CLAIM_CACHE_MS_OK = 60_000;
const CLAIM_CACHE_MS_FAIL = 10_000;

// ✅ Clear all tracker caches (call when switching fleets)
export const clearTrackerCaches = () => {
  membershipCache = { userId: null, groupId: null, ok: false, checkedAt: 0 };
  bindCache = { userId: null, deviceId: null, groupId: null, ok: false, checkedAt: 0 };
  claimCache = { deviceId: null, groupId: null, ok: false, checkedAt: 0 };
  console.log("✅ TRACKER: Caches cleared for fleet switch");
};

const safeIsoNow = () => new Date().toISOString();
const safeCoord = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);

const isRlsError = (err) => {
  const msg = String(err?.message || err || "").toLowerCase();
  return (
    msg.includes("row-level security") ||
    msg.includes("violates row level security") ||
    msg.includes("violates row-level security") ||
    msg.includes("new row violates row-level security") ||
    msg.includes("permission denied")
  );
};

// ✅ Detect expired/invalid auth token errors (long background sessions)
const isAuthError = (err) => {
  const msg = String(err?.message || err || "").toLowerCase();
  const code = err?.code || err?.status || "";
  return (
    String(code) === "401" ||
    msg.includes("jwt expired") ||
    msg.includes("invalid jwt") ||
    msg.includes("token is expired") ||
    msg.includes("not authenticated") ||
    msg.includes("invalid claim") ||
    msg.includes("pgrst301")
  );
};

const setIfAllowed = (payload, key, value) => {
  const flagName = `has_${key}`;
  if (!Object.prototype.hasOwnProperty.call(SCHEMA_FLAGS, flagName)) return;
  if (!SCHEMA_FLAGS[flagName]) return;
  payload[key] = value;
};

const safeGetBatteryPercent = async () => {
  try {
    const level = await Battery.getBatteryLevelAsync();
    if (typeof level === "number" && level >= 0) return Math.round(level * 100);
  } catch (_) {}
  return null;
};

/**
 * ✅ Phase 1: Always resolve device id via Identity (stable)
 * - Persist to AsyncStorage so all modules share the same value.
 */
const safeGetDeviceId = async () => {
  if (memoryDeviceId) return memoryDeviceId;

  try {
    const id = await getStableDeviceId();
    if (id) {
      memoryDeviceId = id;
      try {
        await AsyncStorage.setItem(STORAGE_KEY_DEVICE_ID, id);
      } catch (_) {}
      return memoryDeviceId;
    }
  } catch (_) {}

  // fallback to storage (rare)
  const stored = await AsyncStorage.getItem(STORAGE_KEY_DEVICE_ID);
  memoryDeviceId = stored || null;
  return memoryDeviceId;
};

/**
 * ✅ Phase 1: DO NOT cache group_id forever.
 * Users can create/join a fleet after tracking already started.
 * So always read latest group id from AsyncStorage.
 */
const safeGetGroupId = async () => {
  try {
    const stored = await AsyncStorage.getItem(STORAGE_KEY_GROUP_ID);
    return stored || null;
  } catch (_) {
    return null;
  }
};

// ✅ Phase 3 fix: hard reset local caches when group changes / after switch
const resetFleetBoundState = (reason = "unknown") => {
  // Important: do NOT clear sentinel_device_id (Phase 1 rule)
  pendingLocation = null;
  isSending = false;

  lastGoodCoords = null;
  lastKnownCoords = null;
  lastKnownAccuracyM = null;
  lastLastKnownFetchAt = 0;

  membershipCache = { userId: null, groupId: null, ok: false, checkedAt: 0 };
  bindCache = { userId: null, deviceId: null, groupId: null, ok: false, checkedAt: 0 };
  claimCache = { deviceId: null, groupId: null, ok: false, checkedAt: 0 };

  console.log(`🔁 TRACKER: Fleet context reset (${reason})`);
};

// ✅ SOS Helpers
export const setSOSActive = async (active) => {
  try {
    await AsyncStorage.setItem(STORAGE_KEY_SOS, active ? "1" : "0");
  } catch (_) {}
};

export const clearSOS = async () => {
  await setSOSActive(false);
};

const normalizeInjectedLocation = (input) => {
  if (!input) return null;

  // If a full Expo Location object was passed
  if (input?.coords && typeof input.coords === "object") {
    const lat = safeCoord(input.coords.latitude);
    const lng = safeCoord(input.coords.longitude);
    if (lat != null && lng != null) return input;
    return null;
  }

  // If simple coords were passed: { latitude, longitude, accuracy? }
  const lat = safeCoord(input.latitude);
  const lng = safeCoord(input.longitude);
  if (lat == null || lng == null) return null;

  return {
    coords: {
      latitude: lat,
      longitude: lng,
      accuracy: safeCoord(input.accuracy) ?? null,
      speed: safeCoord(input.speed) ?? null,
      heading: safeCoord(input.heading) ?? null,
      altitude: safeCoord(input.altitude) ?? null,
    },
    timestamp: typeof input.timestamp === "number" ? input.timestamp : Date.now(),
  };
};

const maybeUpdateLastKnown = (latitude, longitude, accuracyM) => {
  if (latitude == null || longitude == null) return;
  lastKnownCoords = { latitude, longitude };
  if (typeof accuracyM === "number" && Number.isFinite(accuracyM)) {
    lastKnownAccuracyM = Math.round(accuracyM);
  }
};

const fetchLastKnownLocationBestEffort = async ({ force = false } = {}) => {
  const now = Date.now();
  if (!force && now - lastLastKnownFetchAt < LAST_KNOWN_FETCH_COOLDOWN_MS) return null;
  lastLastKnownFetchAt = now;

  try {
    const last = await Location.getLastKnownPositionAsync();
    const lat = safeCoord(last?.coords?.latitude);
    const lng = safeCoord(last?.coords?.longitude);
    if (lat == null || lng == null) return null;

    maybeUpdateLastKnown(lat, lng, last?.coords?.accuracy);
    return last;
  } catch (_) {
    return null;
  }
};

/**
 * ✅ Phase 5 update:
 * forceOneShotSync now supports:
 * - injected coords/location (from SOS trigger)
 * - fallback to getLastKnownPositionAsync if current GPS can't lock yet
 * - optional status override (e.g., "OFFLINE" for privacy restoration)
 */
export const forceOneShotSync = async (opts = {}) => {
  // ✅ PRIVACY RESTORATION: Support status override
  const statusOverride = opts?.status || null;

  try {
    const injected = normalizeInjectedLocation(opts?.location || opts?.coords || opts);
    if (injected) {
      // Immediately process the injected "best effort" location
      await handleLocationUpdate(injected, { statusOverride });
      return;
    }

    const hasPerm = await Location.getForegroundPermissionsAsync();
    if (hasPerm.status !== "granted") return;

    try {
      const loc = await Location.getCurrentPositionAsync({
        accuracy: Location.Accuracy.Highest,
      });
      await handleLocationUpdate(loc, { statusOverride });
      return;
    } catch (e) {
      // Fallback to last-known
      const last = await fetchLastKnownLocationBestEffort({ force: true });
      if (last) {
        await handleLocationUpdate(last, { statusOverride });
        return;
      }

      console.log("🟡 forceOneShotSync failed (no current GPS, no last-known):", e?.message || e);
    }
  } catch (e) {
    console.log("🟡 forceOneShotSync failed (non-fatal):", e?.message || e);
  }
};

// ✅ Phase 3 fix: call this right after join/switch completes (after you set sentinel_group_id)
// It clears stale caches AND forces an immediate sync attempt on the new group.
export const rebindTrackerToLatestFleet = async (reason = "manual_rebind") => {
  try {
    // Always clear stale caches first — even if we can't read the new group yet,
    // we must not keep uploading to the OLD fleet.
    resetFleetBoundState(reason);

    const nextGroupId = await safeGetGroupId();
    if (!nextGroupId) {
      console.log("🟡 TRACKER REBIND: No group_id found yet — caches cleared, skipping sync.");
      return;
    }

    // Update memoryGroupId immediately so processUpload treats this as the active fleet
    const prev = memoryGroupId;
    memoryGroupId = nextGroupId;

    // Try an immediate sync (best-effort)
    await forceOneShotSync();
  } catch (e) {
    console.log("🟡 TRACKER REBIND failed (non-fatal):", e?.message || e);
  }
};

const isSOSActive = async () => {
  try {
    const v = await AsyncStorage.getItem(STORAGE_KEY_SOS);
    return v === "1";
  } catch (_) {
    return false;
  }
};

// ✅ REQUIRE AUTH (prevents RLS spam when logged out)
const requireSessionUser = async () => {
  try {
    const { data, error } = await supabase.auth.getSession();
    if (error) return null;
    return data?.session?.user ?? null;
  } catch (_) {
    return null;
  }
};

// ✅ Check membership OR ownership (cached)
const ensureMemberOfGroup = async (userId, groupId) => {
  if (!userId || !groupId) return false;

  const now = Date.now();
  const ttl = membershipCache.ok ? MEMBERSHIP_CACHE_MS_OK : MEMBERSHIP_CACHE_MS_FAIL;

  if (
    membershipCache.userId === userId &&
    membershipCache.groupId === groupId &&
    now - membershipCache.checkedAt < ttl
  ) {
    return membershipCache.ok;
  }

  try {
    // Check membership first
    const { data: memberData, error: memberError } = await supabase
      .from("group_members")
      .select("group_id")
      .eq("user_id", userId)
      .eq("group_id", groupId)
      .limit(1);

    const isMember = !memberError && Array.isArray(memberData) && memberData.length > 0;

    if (isMember) {
      membershipCache = { userId, groupId, ok: true, checkedAt: now };
      return true;
    }

    // ✅ Also check if user OWNS this fleet (can track even without being a "member")
    const { data: ownerData, error: ownerError } = await supabase
      .from("groups")
      .select("id")
      .eq("id", groupId)
      .eq("owner_user_id", userId)
      .limit(1);

    const isOwner = !ownerError && Array.isArray(ownerData) && ownerData.length > 0;

    if (isOwner) {
      console.log("✅ TRACKER: User is OWNER of fleet, allowing tracking");
      membershipCache = { userId, groupId, ok: true, checkedAt: now };
      return true;
    }

    membershipCache = { userId, groupId, ok: false, checkedAt: now };
    if (memberError) console.log("🟡 MEMBERSHIP CHECK ERROR:", memberError.message || memberError);
    return false;
  } catch (e) {
    // ✅ Network/timeout exceptions: don't cache as false — allow upload to proceed
    // so the device doesn't go invisible during transient connectivity issues.
    console.log("🟡 MEMBERSHIP CHECK EXCEPTION (allowing upload):", e?.message || e);
    return true;
  }
};

/**
 * ✅ Option B core: bind/move device row to current user+group via SECURITY DEFINER RPC
 * Uses handshakeDevice() which prefers register_or_move_device.
 */
const ensureDeviceBoundToUserAndGroup = async (userId, deviceId, groupId, { force = false } = {}) => {
  if (!userId || !deviceId || !groupId) return false;

  const now = Date.now();
  const ttl = bindCache.ok ? BIND_CACHE_MS_OK : BIND_CACHE_MS_FAIL;

  if (
    !force &&
    bindCache.userId === userId &&
    bindCache.deviceId === deviceId &&
    bindCache.groupId === groupId &&
    now - bindCache.checkedAt < ttl
  ) {
    return bindCache.ok;
  }

  try {
    let res = await handshakeDevice({ groupId, deviceId });
    let ok = !!res?.ok;

    // ✅ Single retry on failure (covers transient network blips)
    if (!ok) {
      console.log("🟡 DEVICE HANDSHAKE FAILED, retrying once:", res?.error || "Unknown error");
      await new Promise((r) => setTimeout(r, 1500));
      res = await handshakeDevice({ groupId, deviceId });
      ok = !!res?.ok;
    }

    bindCache = { userId, deviceId, groupId, ok, checkedAt: now };

    if (!ok) {
      console.log("🟡 DEVICE HANDSHAKE FAILED after retry:", res?.error || "Unknown error");
    }

    return ok;
  } catch (e) {
    // ✅ Network exception: don't cache as false — allow next upload to retry immediately
    console.log("🟡 DEVICE HANDSHAKE EXCEPTION (not caching):", e?.message || e);
    return false;
  }
};

// ✅ claim stale tracking_sessions row server-side (cached)
const claimTrackingDeviceIfNeeded = async (deviceId, groupId, { force = false } = {}) => {
  if (!deviceId || !groupId) return false;

  const now = Date.now();
  const ttl = claimCache.ok ? CLAIM_CACHE_MS_OK : CLAIM_CACHE_MS_FAIL;

  if (
    !force &&
    claimCache.deviceId === deviceId &&
    claimCache.groupId === groupId &&
    now - claimCache.checkedAt < ttl
  ) {
    return claimCache.ok;
  }

  try {
    let { error } = await supabase.rpc(RPC_CLAIM_TRACKING_DEVICE, {
      p_device_id: deviceId,
      p_group_id: groupId,
    });

    // ✅ Single retry on failure (covers race where old row hasn't been released yet)
    if (error) {
      console.log("🟡 CLAIM DEVICE RPC ERROR, retrying once:", error.message || error);
      await new Promise((r) => setTimeout(r, 1500));
      ({ error } = await supabase.rpc(RPC_CLAIM_TRACKING_DEVICE, {
        p_device_id: deviceId,
        p_group_id: groupId,
      }));
    }

    const ok = !error;
    claimCache = { deviceId, groupId, ok, checkedAt: now };

    if (error) {
      console.log("🟡 CLAIM DEVICE RPC ERROR after retry:", error.message || error);
    } else {
      console.log("✅ CLAIMED TRACKING DEVICE (stale row moved):", deviceId);
    }

    return ok;
  } catch (e) {
    // ✅ Network exception: don't cache as false — allow next upload to retry immediately
    console.log("🟡 CLAIM DEVICE RPC EXCEPTION (not caching):", e?.message || e);
    return false;
  }
};

/**
 * 1️⃣ DEFINE THE BACKGROUND TASK
 */
try {
  TaskManager.defineTask(BACKGROUND_TASK_NAME, async ({ data, error }) => {
    if (error) {
      console.error("❌ BACKGROUND TASK ERROR:", error);
      return;
    }
    const locations = data?.locations;
    if (!locations || locations.length === 0) return;

    const latestLocation = locations[locations.length - 1];
    await handleLocationUpdate(latestLocation);
  });
} catch (e) {
  // Ignore re-definition errors during hot reload
}

/**
 * 2️⃣ SMART UPDATE HANDLER
 * ✅ PRIVACY RESTORATION: Now supports statusOverride (e.g., "OFFLINE")
 */
const handleLocationUpdate = async (location, { statusOverride = null } = {}) => {
  const acc = location?.coords?.accuracy;
  const isPoorGps = typeof acc === "number" && acc > 50;

  if (isSending) {
    pendingLocation = location;
    return;
  }

  try {
    isSending = true;
    await processUpload(location, { isPoorGps, statusOverride });

    while (pendingLocation) {
      const next = pendingLocation;
      pendingLocation = null;

      const nextAcc = next?.coords?.accuracy;
      const nextPoor = typeof nextAcc === "number" && nextAcc > 50;

      await processUpload(next, { isPoorGps: nextPoor });
    }
  } catch (err) {
    console.error("⚠️ UPDATE LOOP FAILED:", err?.message || err);
  } finally {
    isSending = false;
  }
};

/**
 * 3️⃣ UPLOAD WORKER
 * ✅ PRIVACY RESTORATION: Now supports statusOverride (e.g., "OFFLINE")
 */
const processUpload = async (location, { isPoorGps, statusOverride = null }) => {
  const user = await requireSessionUser();
  if (!user) {
    const now = Date.now();
    if (now - lastAuthWarningAt > AUTH_WARN_COOLDOWN_MS) {
      lastAuthWarningAt = now;
      console.log("🟡 TRACKER: Not logged in yet — skipping upload.");
    }
    return;
  }

  const deviceId = await safeGetDeviceId();
  if (!deviceId) {
    console.log("🟡 TRACKER: No device_id available — skipping upload.");
    return;
  }

  const groupId = await safeGetGroupId();
  if (!groupId) {
    console.log("🟡 TRACKER: No fleet group_id yet — skipping upload.");
    return;
  }

  // ✅ Phase 3 fix: If fleet changed, hard-reset caches immediately
  if (memoryGroupId && memoryGroupId !== groupId) {
    const prev = memoryGroupId;
    memoryGroupId = groupId;
    resetFleetBoundState(`group_id_changed (${prev} → ${groupId})`);
  } else if (!memoryGroupId) {
    memoryGroupId = groupId;
  }

  // ✅ Avoid RLS spam if membership isn't ready / not linked
  const isMember = await ensureMemberOfGroup(user.id, groupId);
  if (!isMember) {
    console.log(
      "🟡 TRACKER: Authenticated but NOT a member of this fleet yet — skipping upload.",
      `user_id=${user.id} group_id=${groupId}`
    );
    return;
  }

  // ✅ Option B: ensure device is bound/moved to this user+group before we touch tracking_sessions
  const boundOk = await ensureDeviceBoundToUserAndGroup(user.id, deviceId, groupId);
  if (!boundOk) {
    console.log("🟡 TRACKER: Device not bound to user+group yet — will still attempt claim + upload.");
  }

  // ✅ Best-effort claim on the current group (run even if bind failed — claim may succeed independently)
  await claimTrackingDeviceIfNeeded(deviceId, groupId);

  const batteryPercent = await safeGetBatteryPercent();
  const coords = location?.coords || {};

  const latitude = safeCoord(coords.latitude);
  const longitude = safeCoord(coords.longitude);
  const speed = safeCoord(coords.speed);
  const heading = safeCoord(coords.heading);
  const altitude = safeCoord(coords.altitude);
  const accuracyM = typeof coords.accuracy === "number" ? coords.accuracy : null;

  // ✅ Phase 5: Always remember last-known when we have ANY coords (even poor)
  if (latitude != null && longitude != null) {
    maybeUpdateLastKnown(latitude, longitude, accuracyM);
  }

  // ✅ “Good” GPS cache only when accuracy is decent
  if (latitude != null && longitude != null && !isPoorGps) {
    lastGoodCoords = { latitude, longitude };
  }

  const payload = {
    device_id: deviceId,
    group_id: groupId, // ✅ ALWAYS include group_id for RLS
    battery_level: batteryPercent ?? -1,
  };

  // ✅ PRIVACY RESTORATION: Use statusOverride if provided (e.g., "OFFLINE")
  const sosOn = await isSOSActive();
  const finalStatus = statusOverride || (sosOn ? "SOS" : "ACTIVE");
  setIfAllowed(payload, "status", finalStatus);
  setIfAllowed(payload, "last_updated", safeIsoNow());
  setIfAllowed(payload, "gps_accuracy_m", typeof accuracyM === "number" ? Math.round(accuracyM) : lastKnownAccuracyM);

  // ✅ Decision tree:
  // 1) If current coords are not poor → use them
  // 2) Else if we have lastGoodCoords → use them
  // 3) Else if SOS is on and we have lastKnownCoords → use them immediately (Phase 5 requirement)
  // 4) Else if SOS is on, try fetching last-known once → use it if found
  // 5) Else: wait
  if (!isPoorGps && latitude != null && longitude != null) {
    payload.latitude = latitude;
    payload.longitude = longitude;

    setIfAllowed(payload, "speed", speed);
    setIfAllowed(payload, "heading", heading);
    setIfAllowed(payload, "altitude", altitude);
    setIfAllowed(payload, "gps_quality", "GOOD");
  } else if (lastGoodCoords) {
    payload.latitude = lastGoodCoords.latitude;
    payload.longitude = lastGoodCoords.longitude;
    setIfAllowed(payload, "gps_quality", "POOR");
  } else if (sosOn && lastKnownCoords) {
    payload.latitude = lastKnownCoords.latitude;
    payload.longitude = lastKnownCoords.longitude;
    setIfAllowed(payload, "gps_quality", "POOR");
  } else if (sosOn) {
    const last = await fetchLastKnownLocationBestEffort({ force: false });
    const llat = safeCoord(last?.coords?.latitude);
    const llng = safeCoord(last?.coords?.longitude);

    if (llat != null && llng != null) {
      payload.latitude = llat;
      payload.longitude = llng;
      setIfAllowed(payload, "gps_quality", "POOR");
    } else {
      console.log("⚠️ SOS: No current GPS yet and no last-known available (waiting briefly)");
      return;
    }
  } else {
    console.log("⚠️ GPS not ready yet (waiting for first reliable fix)");
    return;
  }

  console.log(
    `📡 SYNC [${finalStatus}]: ${payload.latitude?.toFixed(4)}, ${payload.longitude?.toFixed(
      4
    )} | 🔋 ${payload.battery_level}% | 👥 ${payload.group_id} | 🎯 ${payload.gps_quality || "?"}`
  );

  // ✅ Use SECURITY DEFINER RPC to bypass all RLS issues
  const rpcParams = {
    p_device_id: deviceId,
    p_group_id: groupId,
    p_data: {
      latitude: payload.latitude,
      longitude: payload.longitude,
      battery_level: payload.battery_level,
      status: payload.status,
      last_updated: payload.last_updated,
      gps_quality: payload.gps_quality,
      gps_accuracy_m: payload.gps_accuracy_m,
      speed: payload.speed,
      heading: payload.heading,
    },
  };

  let { data: rpcResult, error: rpcError } = await supabase.rpc("upsert_tracking_session", rpcParams);

  // ✅ If auth token expired (long background session), refresh and retry once
  if (rpcError && isAuthError(rpcError)) {
    console.log("🔄 SYNC: Auth error — refreshing session and retrying once...");
    try {
      await supabase.auth.refreshSession();
      const retry = await supabase.rpc("upsert_tracking_session", rpcParams);
      rpcResult = retry.data;
      rpcError = retry.error;
    } catch (refreshErr) {
      console.log("❌ SYNC: Session refresh failed:", refreshErr?.message || refreshErr);
      return;
    }
  }

  // Check if RPC returned an error in the response
  if (rpcResult?.ok === false) {
    console.log("🟡 SYNC RPC error:", rpcResult?.error);
    return;
  }

  if (rpcError) {
    // Fallback: if RPC doesn't exist yet, try direct upsert
    if (rpcError.message?.includes("function") && rpcError.message?.includes("does not exist")) {
      console.log("🟡 upsert_tracking_session RPC not found, falling back to direct upsert...");
      const { error: directError } = await supabase.from("tracking_sessions").upsert([payload], { onConflict: "device_id" });
      if (directError) {
        console.log("❌ Direct upsert also failed:", directError.message);
        return;
      }
    } else {
      console.log("❌ SYNC RPC error:", rpcError.message);
      return;
    }
  }

  console.log("✅ SYNC OK");
  return;

  // Legacy error handling removed - RPC handles all cases now
  /*
  if (error) {
    if (isRlsError(error)) {
      console.error(
        `❌ SUPABASE RLS BLOCKED (tracking_sessions).
Likely causes:
• tracking_sessions row exists under a DIFFERENT group_id (stale row) → claim RPC should fix
• devices row not bound/moved to this user+group → register_or_move_device should fix
• group_members / RLS policy not allowing this user for this group

Debug:
• device_id: ${deviceId}
• user_id:   ${user.id}
• payload group_id: ${groupId}

RPCs installed (you confirmed):
• public.register_or_move_device(text, uuid, text default null)
• public.claim_tracking_session_device(text, uuid)
`
      );
      return;
    }

    console.error("❌ SUPABASE ERROR:", error.message || error);
    return;
  }

  console.log("✅ SYNC OK");
  */
};

/**
 * 4️⃣ START TRACKING
 */
export const startLiveTracking = async (_deviceId, mode = "SOS") => {
  // ✅ Phase 1: ALWAYS use Identity as the source of truth
  const stableId = await safeGetDeviceId();
  if (!stableId) {
    console.log("❌ TRACKER: Cannot start (no device id).");
    return;
  }

  console.log(`🚀 ACTIVATING STEALTH TRACKER: ${stableId}`);

  try {
    await activateKeepAwakeAsync();
  } catch (e) {
    console.log("🟡 KeepAwake not available right now (non-fatal).");
  }

  const fg = await Location.requestForegroundPermissionsAsync();
  await Location.requestBackgroundPermissionsAsync();

  if (fg.status !== "granted") {
    console.error("❌ LOCATION PERMISSIONS NOT GRANTED");
    return;
  }

  // ✅ Phase 3 fix: snapshot memoryGroupId at start (still reads from storage every tick)
  try {
    const g = await safeGetGroupId();
    memoryGroupId = g || null;
  } catch (_) {
    memoryGroupId = null;
  }

  // ✅ Best-effort: pre-bind device to current user+group (prevents first-sync RLS failures)
  try {
    const user = await requireSessionUser();
    const groupId = await safeGetGroupId();
    if (user?.id && groupId) {
      const isMember = await ensureMemberOfGroup(user.id, groupId);
      if (isMember) {
        await ensureDeviceBoundToUserAndGroup(user.id, stableId, groupId);
        await claimTrackingDeviceIfNeeded(stableId, groupId);
      }
    }
  } catch (_) {}

  const alreadyRunning = await Location.hasStartedLocationUpdatesAsync(BACKGROUND_TASK_NAME);
  if (alreadyRunning) {
    console.log("⚠️ TRACKER ALREADY RUNNING (Ensuring background task is fresh)");
    await Location.stopLocationUpdatesAsync(BACKGROUND_TASK_NAME);
  }

  const profile = TRACKING_PROFILES[mode] || TRACKING_PROFILES.SOS;

  await Location.startLocationUpdatesAsync(BACKGROUND_TASK_NAME, {
    ...profile,
    showsBackgroundLocationIndicator: true,
    foregroundService: {
      notificationTitle: "System Security Active",
      notificationBody: "SenTihNel is protecting this device.",
      notificationColor: "#FF0000",
      killServiceOnTerminate: false,
    },
    pausesUpdatesAutomatically: false,
    mayShowUserSettingsDialog: true,
  });

  console.log("✅ TRACKER STARTED");
};

/**
 * 5️⃣ STOP TRACKING
 */
export const stopLiveTracking = async () => {
  try {
    deactivateKeepAwake();
  } catch (_) {}

  const isRegistered = await TaskManager.isTaskRegisteredAsync(BACKGROUND_TASK_NAME);
  if (isRegistered) {
    await Location.stopLocationUpdatesAsync(BACKGROUND_TASK_NAME);
    console.log("🛑 BACKGROUND TRACKER STOPPED");
  }

  // Mark OFFLINE once (best-effort) if logged in
  if (memoryDeviceId) {
    const user = await requireSessionUser();
    if (user) {
      try {
        const offlinePayload = { device_id: memoryDeviceId };
        setIfAllowed(offlinePayload, "status", "OFFLINE");
        setIfAllowed(offlinePayload, "last_updated", safeIsoNow());

        const groupId = await safeGetGroupId();
        if (groupId) offlinePayload.group_id = groupId;

        const { error } = await supabase.from("tracking_sessions").upsert([offlinePayload], {
          onConflict: "device_id",
        });

        if (error) {
          // best-effort only; avoid noisy spam on shutdown
          // console.log("🟡 OFFLINE upsert warning:", error.message || error);
        }
      } catch (_) {}
    }
  }

  // ✅ Phase 1 CRITICAL: DO NOT remove sentinel_device_id
  // await AsyncStorage.removeItem(STORAGE_KEY_DEVICE_ID);

  pendingLocation = null;
  isSending = false;

  lastGoodCoords = null;
  lastKnownCoords = null;
  lastKnownAccuracyM = null;
  lastLastKnownFetchAt = 0;

  membershipCache = { userId: null, groupId: null, ok: false, checkedAt: 0 };
  bindCache = { userId: null, deviceId: null, groupId: null, ok: false, checkedAt: 0 };
  claimCache = { deviceId: null, groupId: null, ok: false, checkedAt: 0 };

  // ✅ Phase 3: clear memoryGroupId on stop
  memoryGroupId = null;
};

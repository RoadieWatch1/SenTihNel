// 📂 FILE LOCATION: SenTihNel/src/services/LiveTracker.js
// ✅ Updated for: Auth-required tracking + RLS-safe UPSERT + schema flags + safer keep-awake
// ✅ IMPORTANT: This file now uses your shared Supabase client from src/lib/supabase
// (Do NOT create a new client here — it can cause auth/session mismatches.)

import * as Location from "expo-location";
import * as Battery from "expo-battery";
import * as TaskManager from "expo-task-manager";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { activateKeepAwakeAsync, deactivateKeepAwake } from "expo-keep-awake";
import { supabase } from "../lib/supabase"; // ✅ uses the same client/session as your Auth screen

const BACKGROUND_TASK_NAME = "BACKGROUND_LOCATION_TASK";
const STORAGE_KEY_DEVICE_ID = "sentinel_device_id";

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
    distanceInterval: 5, // Update every 5 meters
    timeInterval: 5000, // or every 5 seconds

    // Background persistence
    deferredUpdatesInterval: 5000,
    deferredUpdatesDistance: 5,
  },
};

// State Tracking (Memory)
let memoryDeviceId = null;
let isSending = false;
let pendingLocation = null;
let lastGoodCoords = null;

// Small safety: avoid hammering Supabase if user is logged out / not ready
let lastAuthWarningAt = 0;
const AUTH_WARN_COOLDOWN_MS = 8000;

/**
 * Safe helpers
 */
const safeIsoNow = () => new Date().toISOString();
const safeCoord = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);

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

const safeGetDeviceId = async () => {
  if (memoryDeviceId) return memoryDeviceId;
  const stored = await AsyncStorage.getItem(STORAGE_KEY_DEVICE_ID);
  memoryDeviceId = stored || null;
  return memoryDeviceId;
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

// ✅ Optional guard: verify this device belongs to this user (matches our RLS design)
// If RLS blocks this SELECT, it will return null — we just skip uploads until device exists.
const deviceExistsForUser = async (deviceId) => {
  try {
    const { data, error } = await supabase
      .from("devices")
      .select("device_id")
      .eq("device_id", deviceId)
      .limit(1);

    if (error) return false;
    return Array.isArray(data) && data.length > 0;
  } catch (_) {
    return false;
  }
};

/**
 * 1️⃣ DEFINE THE BACKGROUND TASK
 * Note: defineTask can throw during Fast Refresh if already defined, so we guard it.
 */
try {
  TaskManager.defineTask(BACKGROUND_TASK_NAME, async ({ data, error }) => {
    if (error) {
      console.error("❌ BACKGROUND TASK ERROR:", error);
      return;
    }
    const locations = data?.locations;
    if (!locations || locations.length === 0) return;

    // Use most recent
    const latestLocation = locations[locations.length - 1];
    await handleLocationUpdate(latestLocation);
  });
} catch (e) {
  // Ignore re-definition errors during hot reload
}

/**
 * 2️⃣ SMART UPDATE HANDLER (latest-wins queue)
 */
const handleLocationUpdate = async (location) => {
  const acc = location?.coords?.accuracy;
  const isPoorGps = typeof acc === "number" && acc > 50;

  if (isSending) {
    pendingLocation = location;
    return;
  }

  try {
    isSending = true;
    await processUpload(location, { isPoorGps });

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
 * 3️⃣ UPLOAD WORKER (Auth + RLS safe)
 */
const processUpload = async (location, { isPoorGps }) => {
  // ✅ Must be logged in (your RLS policies require authenticated)
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
    console.log("🟡 TRACKER: No device_id stored yet — skipping upload.");
    return;
  }

  // ✅ Ensure device row exists (and belongs to this user) before writing tracking
  // If device doesn't exist yet, the tracking upsert will fail RLS.
  const hasDevice = await deviceExistsForUser(deviceId);
  if (!hasDevice) {
    console.log("🟡 TRACKER: Device not registered yet — skipping upload.");
    return;
  }

  const batteryPercent = await safeGetBatteryPercent();
  const coords = location?.coords || {};

  const latitude = safeCoord(coords.latitude);
  const longitude = safeCoord(coords.longitude);
  const speed = safeCoord(coords.speed);
  const heading = safeCoord(coords.heading);
  const altitude = safeCoord(coords.altitude);

  if (latitude != null && longitude != null && !isPoorGps) {
    lastGoodCoords = { latitude, longitude };
  }

  const payload = {
    device_id: deviceId,
    battery_level: batteryPercent ?? -1,
  };

  // Pro fields
  setIfAllowed(payload, "status", "ACTIVE");
  setIfAllowed(payload, "last_updated", safeIsoNow());
  setIfAllowed(
    payload,
    "gps_accuracy_m",
    typeof coords.accuracy === "number" ? Math.round(coords.accuracy) : null
  );

  // Coordinates decision
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
  } else {
    console.log("⚠️ GPS not ready yet (waiting for first reliable fix)");
    return;
  }

  console.log(
    `📡 SYNC [${payload.status || "ACTIVE"}]: ${payload.latitude?.toFixed(4)}, ${payload.longitude?.toFixed(
      4
    )} | 🔋 ${payload.battery_level}%`
  );

  // ✅ UPSERT requires INSERT + UPDATE policies (you added those)
  const { error } = await supabase.from("tracking_sessions").upsert([payload], {
    onConflict: "device_id",
  });

  if (error) console.error("❌ SUPABASE ERROR:", error.message || error);
  else console.log("✅ SYNC OK");
};

/**
 * 4️⃣ START TRACKING
 */
export const startLiveTracking = async (deviceId, mode = "SOS") => {
  console.log(`🚀 ACTIVATING STEALTH TRACKER: ${deviceId}`);

  // Keep Awake can throw on some builds/dev states — don’t crash tracking
  try {
    await activateKeepAwakeAsync();
  } catch (e) {
    console.log("🟡 KeepAwake not available right now (non-fatal).");
  }

  memoryDeviceId = deviceId;
  await AsyncStorage.setItem(STORAGE_KEY_DEVICE_ID, deviceId);

  // Permissions
  const fg = await Location.requestForegroundPermissionsAsync();
  await Location.requestBackgroundPermissionsAsync();

  if (fg.status !== "granted") {
    console.error("❌ LOCATION PERMISSIONS NOT GRANTED");
    return;
  }

  // Avoid duplicate starts
  const alreadyRunning = await Location.hasStartedLocationUpdatesAsync(BACKGROUND_TASK_NAME);
  if (alreadyRunning) {
    console.log("⚠️ TRACKER ALREADY RUNNING (Ensuring background task is fresh)");
    await Location.stopLocationUpdatesAsync(BACKGROUND_TASK_NAME);
  }

  const profile = TRACKING_PROFILES[mode] || TRACKING_PROFILES.SOS;

  await Location.startLocationUpdatesAsync(BACKGROUND_TASK_NAME, {
    ...profile,

    // iOS indicator (fine for dev; you can disable for production stealth decisions)
    showsBackgroundLocationIndicator: true,

    // Android foreground service notification (required for background GPS)
    foregroundService: {
      notificationTitle: "System Security Active",
      notificationBody: "SenTihNel is protecting this device.",
      notificationColor: "#FF0000",
      killServiceOnTerminate: false,
    },

    // Android persistence
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

  if (memoryDeviceId) {
    // Only attempt OFFLINE write if logged in + device exists
    const user = await requireSessionUser();
    const hasDevice = user ? await deviceExistsForUser(memoryDeviceId) : false;

    if (user && hasDevice) {
      const offlinePayload = { device_id: memoryDeviceId };
      setIfAllowed(offlinePayload, "status", "OFFLINE");
      setIfAllowed(offlinePayload, "last_updated", safeIsoNow());

      await supabase.from("tracking_sessions").upsert([offlinePayload], {
        onConflict: "device_id",
      });
    }
  }

  // Cleanup
  await AsyncStorage.removeItem(STORAGE_KEY_DEVICE_ID);
  memoryDeviceId = null;
  pendingLocation = null;
  isSending = false;
  lastGoodCoords = null;
};

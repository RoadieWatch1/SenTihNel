// 📂 FILE: src/services/BatSignal.js
// ✅ Phase 5 update (Fleet-wide alerts first, SMS kept but not used by default)
//
// What it does:
// 1) ✅ Last-known GPS FIRST (fast): When SOS triggers with no GPS lock, we immediately use last-known coords
//    to build the dashboard link + broadcast.
// 2) ✅ Avoids bad “0,0” links: If we don’t have coords yet, we send a link with only ?id=DEVICE (no lat/lng).
// 3) ✅ Fleet-wide in-app alert payload improved: Broadcast includes richer payload.
// 4) ✅ SMS left intact but disabled by default.
//
// ✅ Phase 6: Cloud Recording (Agora → S3) start/stop (backup, best-effort)
// - When SOS triggers → call Edge Function: agora-recording-start (ONLY on SOS activation)
// - When SOS cancels → call Edge Function: agora-recording-stop
//
// ✅ FIX (this update): Edge Function 401 "Invalid JWT" & missing cloud-rec attempts
// - Uses direct fetch to Supabase Functions endpoint with explicit:
//   apikey + Authorization: Bearer <user_access_token>
// - Adds strict token retrieval + refreshSession retry (fixes stale/invalid JWT cases)
// - Logs cloud recording attempts so you can see what’s happening
// - Stores resourceId + sid on start and includes them on stop (more reliable)
// - Adds timeouts so cancel never hangs UI

import * as Location from "expo-location";
import { Vibration } from "react-native";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { supabase, SUPABASE_URL, SUPABASE_KEY, SUPABASE_ANON_KEY } from "../lib/supabase";
import { getDeviceId } from "./Identity";
import { setSOSActive, clearSOS, forceOneShotSync, stopLiveTracking } from "./LiveTracker";

// 🔴 CONFIGURATION
const GUARDIAN_SITE = "https://sentihnel.com";
const CLOUD_ROBOT_URL = `${GUARDIAN_SITE}/.netlify/functions/send-sos`;

// ✅ Phase 5: Prefer fleet notifications over SMS for now
const ENABLE_SMS = false;

// 🔴 TEST NUMBER (optional) - kept intact
const GUARDIAN_PHONE_NUMBER = "+14708123029";

// Storage
const STORAGE_KEY_GROUP_ID = "sentinel_group_id";
const STORAGE_KEY_DEVICE_NAME = "sentinel_device_display_name";

// ✅ Cloud Recording Edge Functions (Supabase)
const REC_START_FN = "agora-recording-start";
const REC_STOP_FN = "agora-recording-stop";

// ✅ SOS Push Notification Edge Function (fallback if pg_net not available)
const SOS_NOTIFY_FN = "send-sos-notifications";

// ✅ AUTO-START CLOUD RECORDING ONLY WHEN SOS IS ACTIVATED (backup safety)
const ENABLE_CLOUD_RECORDING_AUTOSTART = true;

// ✅ Prevent spamming recording-start (start only once per SOS session)
const CLOUDREC_STARTED_PREFIX = "sentinel_cloudrec_started:";

// ✅ Store recording session details (helps STOP be reliable)
const CLOUDREC_RESOURCE_PREFIX = "sentinel_cloudrec_resourceId:";
const CLOUDREC_SID_PREFIX = "sentinel_cloudrec_sid:";

// ✅ Retry window (helps if SOS fires before auth/session or before Agora channel is live)
const CLOUDREC_MAX_ATTEMPTS = 6; // ~6 attempts
const CLOUDREC_RETRY_DELAY_MS = 4000; // every 4s

// ✅ Safety timeouts (so UI never hangs)
// ✅ FIX: Increased from 3500 to 5000ms — during SOS the network is saturated
// (video streaming, GPS syncs, cloud recording) so cleanup needs more time
const CANCEL_TIMEOUT_MS = 5000;
const FN_TIMEOUT_MS = 12000;

// Timer ref for delayed OFFLINE RPC retry (cleared if cancel runs again)
let offlineRetryTimer = null;

// ✅ Debug logs (dev only)
const DEBUG_CLOUDREC = !!__DEV__;

// --- helpers ---
function safeNum(n, fallback = null) {
  const x = Number(n);
  return Number.isFinite(x) ? x : fallback;
}

function buildLink(deviceId, lat, lng) {
  const safeLat = safeNum(lat, null);
  const safeLng = safeNum(lng, null);

  // ✅ If we don't have coords yet, don't send 0,0 (ocean) — send only device id
  if (safeLat == null || safeLng == null) {
    return `${GUARDIAN_SITE}/?id=${encodeURIComponent(deviceId)}`;
  }

  const la = safeLat.toFixed(7);
  const lo = safeLng.toFixed(7);

  return `${GUARDIAN_SITE}/?id=${encodeURIComponent(deviceId)}&lat=${encodeURIComponent(
    la
  )}&lng=${encodeURIComponent(lo)}`;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function withTimeout(promise, timeoutMs, label = "timeout") {
  let t;
  try {
    return await Promise.race([
      promise,
      new Promise((_, rej) => {
        t = setTimeout(() => rej(new Error(label)), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(t);
  }
}

async function getGroupId() {
  try {
    const g = await AsyncStorage.getItem(STORAGE_KEY_GROUP_ID);
    return g ? String(g) : null;
  } catch {
    return null;
  }
}

async function getDisplayName() {
  try {
    const name = await AsyncStorage.getItem(STORAGE_KEY_DEVICE_NAME);
    return name ? String(name).trim() : null;
  } catch {
    return null;
  }
}

async function safeSetSOSActive() {
  // Some builds had setSOSActive(true), some had setSOSActive() — support both safely.
  try {
    await setSOSActive(true);
    return;
  } catch {}
  try {
    await setSOSActive();
  } catch {}
}

async function safeForceSOSSync({ lat, lng, accuracy } = {}) {
  try {
    await forceOneShotSync({
      status: "SOS",
      coords:
        Number.isFinite(lat) && Number.isFinite(lng)
          ? { latitude: lat, longitude: lng, accuracy: accuracy ?? null }
          : null,
    });
    return;
  } catch {}

  try {
    await forceOneShotSync({ status: "SOS" });
    return;
  } catch {}

  try {
    await forceOneShotSync();
  } catch {}
}

async function safeForceActiveSync() {
  try {
    await forceOneShotSync({ status: "ACTIVE" });
    return;
  } catch {}
  try {
    await forceOneShotSync();
  } catch {}
}

// ✅ PRIVACY RESTORATION: Force sync as OFFLINE (used when stopLiveTracking fails)
async function safeForceOfflineSync() {
  try {
    await forceOneShotSync({ status: "OFFLINE" });
    return;
  } catch {}
  // Last resort: just clear SOS status
  try {
    await clearSOS();
  } catch {}
}

/**
 * ✅ FAST PATH
 * We want last-known immediately (no GPS lock needed), then optionally refine with current GPS.
 */
async function getFastThenRefineLocation() {
  try {
    const { status } = await Location.getForegroundPermissionsAsync();
    if (status !== "granted") {
      const req = await Location.requestForegroundPermissionsAsync();
      if (req.status !== "granted") return { fast: null, refined: null };
    }

    let fast = null;
    try {
      fast = await Location.getLastKnownPositionAsync({});
    } catch {}

    let refined = null;
    try {
      refined = await Location.getCurrentPositionAsync({
        accuracy: Location.Accuracy.Balanced,
      });
    } catch {}

    return { fast: fast || null, refined: refined || null };
  } catch {
    return { fast: null, refined: null };
  }
}

async function postWithTimeout(url, bodyObj, timeoutMs = 8000) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(bodyObj),
      signal: controller.signal,
    });
    return res;
  } finally {
    clearTimeout(t);
  }
}

function formatFnError(err) {
  try {
    if (!err) return { message: "Unknown error" };
    const message = err.message || err.error || String(err);

    const status =
      err?.context?.status ??
      err?.status ??
      err?.context?.response?.status ??
      null;

    const details =
      err?.context?.body ??
      err?.context?.response ??
      err?.details ??
      null;

    return { message, status, details };
  } catch {
    return { message: "Unknown error" };
  }
}

async function fetchJsonWithTimeout(
  url,
  { method = "POST", headers = {}, body = null } = {},
  timeoutMs = FN_TIMEOUT_MS
) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method,
      headers,
      body,
      signal: controller.signal,
    });

    const ct = res.headers?.get?.("content-type") || "";
    const isJson = ct.includes("application/json");
    const data = isJson
      ? await res.json().catch(() => null)
      : await res.text().catch(() => null);

    return { ok: res.ok, status: res.status, data };
  } finally {
    clearTimeout(t);
  }
}

// --- CloudRec session storage helpers ---
function cloudRecKey(deviceId) {
  return `${CLOUDREC_STARTED_PREFIX}${String(deviceId || "").trim()}`;
}

function cloudRecResourceKey(deviceId) {
  return `${CLOUDREC_RESOURCE_PREFIX}${String(deviceId || "").trim()}`;
}

function cloudRecSidKey(deviceId) {
  return `${CLOUDREC_SID_PREFIX}${String(deviceId || "").trim()}`;
}

async function markCloudRecStarted(deviceId) {
  try {
    if (!deviceId) return;
    await AsyncStorage.setItem(cloudRecKey(deviceId), "1");
  } catch {}
}

async function clearCloudRecStarted(deviceId) {
  try {
    if (!deviceId) return;
    await AsyncStorage.removeItem(cloudRecKey(deviceId));
  } catch {}
}

async function hasCloudRecStarted(deviceId) {
  try {
    if (!deviceId) return false;
    const v = await AsyncStorage.getItem(cloudRecKey(deviceId));
    return v === "1";
  } catch {
    return false;
  }
}

async function saveCloudRecSession(deviceId, { resourceId, sid } = {}) {
  try {
    if (!deviceId) return;
    if (resourceId) await AsyncStorage.setItem(cloudRecResourceKey(deviceId), String(resourceId));
    if (sid) await AsyncStorage.setItem(cloudRecSidKey(deviceId), String(sid));
  } catch {}
}

async function loadCloudRecSession(deviceId) {
  try {
    if (!deviceId) return { resourceId: null, sid: null };
    const resourceId = await AsyncStorage.getItem(cloudRecResourceKey(deviceId));
    const sid = await AsyncStorage.getItem(cloudRecSidKey(deviceId));
    return {
      resourceId: resourceId ? String(resourceId) : null,
      sid: sid ? String(sid) : null,
    };
  } catch {
    return { resourceId: null, sid: null };
  }
}

async function clearCloudRecSession(deviceId) {
  try {
    if (!deviceId) return;
    await AsyncStorage.removeItem(cloudRecResourceKey(deviceId));
    await AsyncStorage.removeItem(cloudRecSidKey(deviceId));
  } catch {}
}

// ✅ Strict token getter with refresh fallback (fixes stale/invalid JWT cases)
async function getUserAccessTokenStrict({ minTtlSeconds = 60 } = {}) {
  try {
    const nowSec = Math.floor(Date.now() / 1000);

    const s1 = await supabase.auth.getSession();
    const session1 = s1?.data?.session || null;
    const t1 = session1?.access_token ? String(session1.access_token) : null;
    const exp1 = session1?.expires_at ? Number(session1.expires_at) : null;

    // If we have a token and it’s not about to expire, use it
    if (t1 && exp1 && exp1 - nowSec > minTtlSeconds) return t1;
    if (t1 && !exp1) return t1; // no exp? still use it

    // One refresh attempt
    try {
      await supabase.auth.refreshSession();
    } catch {}

    const s2 = await supabase.auth.getSession();
    const session2 = s2?.data?.session || null;
    const t2 = session2?.access_token ? String(session2.access_token) : null;
    return t2 || null;
  } catch {
    return null;
  }
}

/**
 * ✅ Edge Function invoke (reliable RN path):
 * Direct call to: {SUPABASE_URL}/functions/v1/{fnName}
 * with headers: apikey + Authorization: Bearer <user_access_token>
 *
 * 🔧 Fix:
 * - If 401, refresh session and retry once (common "Invalid JWT" cause).
 *
 * ✅ STEP 2 CHANGE:
 * - apikey MUST be the Legacy ANON key for functions calls:
 *   apikey: SUPABASE_ANON_KEY   (NOT SUPABASE_KEY)
 */
async function invokeFunctionWithTimeout(fnName, bodyObj, timeoutMs = FN_TIMEOUT_MS) {
  try {
    if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
      return { ok: false, error: { message: "Missing SUPABASE_URL or SUPABASE_ANON_KEY" } };
    }

    const url = `${String(SUPABASE_URL).replace(/\/$/, "")}/functions/v1/${encodeURIComponent(
      fnName
    )}`;

    const attemptOnce = async () => {
      const token = await getUserAccessTokenStrict({ minTtlSeconds: 60 });
      if (!token) {
        return {
          ok: false,
          status: 401,
          data: { code: 401, message: "Auth session missing (no access_token)" },
        };
      }

      const headers = {
        "Content-Type": "application/json",
        // ✅ STEP 2: Legacy ANON key here
        apikey: String(SUPABASE_ANON_KEY),
        Authorization: `Bearer ${token}`,
      };

      return await fetchJsonWithTimeout(
        url,
        {
          method: "POST",
          headers,
          body: JSON.stringify(bodyObj || {}),
        },
        timeoutMs
      );
    };

    // Attempt 1
    const out1 = await attemptOnce();
    if (out1.ok) return { ok: true, data: out1.data };

    // If 401, refresh and retry once
    if (out1.status === 401) {
      if (DEBUG_CLOUDREC) console.log("🎥 CLOUD REC: 401 received, refreshing session and retrying...");

      try {
        await supabase.auth.refreshSession();
      } catch {}

      const out2 = await attemptOnce();
      if (out2.ok) return { ok: true, data: out2.data };

      return {
        ok: false,
        error: {
          message: "Edge Function returned a non-2xx status code",
          status: out2.status,
          details: out2.data ?? null,
        },
      };
    }

    return {
      ok: false,
      error: {
        message: "Edge Function returned a non-2xx status code",
        status: out1.status,
        details: out1.data ?? null,
      },
    };
  } catch (e) {
    return { ok: false, error: formatFnError(e) };
  }
}

async function tryStartCloudRecording({ deviceId, channel }) {
  // Never block SOS on network
  try {
    const ch = channel || deviceId;
    if (!deviceId || !ch) return false;

    const out = await invokeFunctionWithTimeout(
      REC_START_FN,
      { device_id: deviceId, channel: ch },
      FN_TIMEOUT_MS
    );

    if (out.ok) {
      console.log("🎥 CLOUD REC START OK:", {
        deviceId,
        channel: ch,
        resourceId: out?.data?.resourceId,
        sid: out?.data?.sid,
      });

      // ✅ Save resourceId + sid for STOP reliability
      await saveCloudRecSession(deviceId, {
        resourceId: out?.data?.resourceId,
        sid: out?.data?.sid,
      });

      return true;
    }

    console.log("⚠️ CLOUD REC START FAILED (non-blocking):", JSON.stringify(out.error));
    return false;
  } catch (e) {
    if (DEBUG_CLOUDREC) console.log("⚠️ CLOUD REC START EXCEPTION:", e?.message || String(e));
    return false;
  }
}

async function tryStopCloudRecording({ deviceId, channel }) {
  // Never block cancel on network
  try {
    const ch = channel || deviceId;
    if (!deviceId) return false;

    // ✅ Include session details if we have them (doesn't break if server ignores)
    const sess = await loadCloudRecSession(deviceId);

    const out = await invokeFunctionWithTimeout(
      REC_STOP_FN,
      {
        device_id: deviceId,
        channel: ch,
        resourceId: sess.resourceId || undefined,
        sid: sess.sid || undefined,
      },
      FN_TIMEOUT_MS
    );

    if (out.ok) {
      const uploadingStatus = out?.data?.stopResp?.serverResponse?.uploadingStatus;
      const fileList = out?.data?.stopResp?.serverResponse?.fileList;
      console.log("🎥 CLOUD REC STOP OK:", {
        deviceId,
        channel: ch,
        stopped: out?.data?.stopped,
        alreadyEnded: out?.data?.alreadyEnded,
        uploadingStatus: uploadingStatus || null,
        files: Array.isArray(fileList) ? fileList.map((f) => f.fileName) : null,
      });

      // Clear session after successful stop
      await clearCloudRecSession(deviceId);
      return true;
    }

    console.log("⚠️ CLOUD REC STOP FAILED (non-blocking):", JSON.stringify(out.error));
    return false;
  } catch (e) {
    if (DEBUG_CLOUDREC) console.log("⚠️ CLOUD REC STOP EXCEPTION:", e?.message || String(e));
    return false;
  }
}

/**
 * ✅ Trigger push notifications via Edge Function (fallback for when pg_net isn't available)
 * This is fire-and-forget to avoid blocking SOS activation
 */
async function triggerPushNotifications({ deviceId, groupId, displayName, lat, lng }) {
  try {
    if (!deviceId || !groupId) return;

    // Fire-and-forget (don't await, don't block SOS)
    invokeFunctionWithTimeout(
      SOS_NOTIFY_FN,
      {
        payload: {
          device_id: deviceId,
          display_name: displayName || null,
          group_id: groupId,
          latitude: lat,
          longitude: lng,
          timestamp: new Date().toISOString(),
        },
      },
      FN_TIMEOUT_MS
    )
      .then((out) => {
        if (out.ok) {
          console.log("✅ Push notification trigger sent via Edge Function");
        } else {
          console.log("⚠️ Push notification trigger failed (non-blocking):", out.error?.message);
        }
      })
      .catch((e) => {
        console.log("⚠️ Push notification trigger exception (non-blocking):", e?.message);
      });
  } catch (e) {
    console.log("⚠️ Push notification trigger error (non-blocking):", e?.message);
  }
}

/**
 * ✅ Trigger CANCEL push notification via Edge Function
 * So users with app in background know the SOS has been resolved
 */
async function triggerCancelPushNotification({ deviceId, groupId, displayName }) {
  try {
    if (!deviceId || !groupId) return;

    invokeFunctionWithTimeout(
      SOS_NOTIFY_FN,
      {
        payload: {
          device_id: deviceId,
          display_name: displayName || null,
          group_id: groupId,
          latitude: null,
          longitude: null,
          timestamp: new Date().toISOString(),
          type: "sos_cancel",
        },
      },
      FN_TIMEOUT_MS
    )
      .then((out) => {
        if (out.ok) {
          console.log("✅ Cancel push notification sent via Edge Function");
        } else {
          console.log("⚠️ Cancel push notification failed (non-blocking):", out.error?.message);
        }
      })
      .catch((e) => {
        console.log("⚠️ Cancel push notification exception (non-blocking):", e?.message);
      });
  } catch (e) {
    console.log("⚠️ Cancel push notification error (non-blocking):", e?.message);
  }
}

// ✅ Start cloud recording ONCE per SOS activation, retrying (best-effort)
async function safeStartCloudRecordingOnce(deviceId) {
  try {
    if (!ENABLE_CLOUD_RECORDING_AUTOSTART) return;

    const already = await hasCloudRecStarted(deviceId);
    if (already) {
      if (DEBUG_CLOUDREC) console.log("🎥 CLOUD REC: already started for this SOS session — skipping");
      return;
    }

    // Fire-and-forget background task (never blocks SOS)
    (async () => {
      for (let attempt = 1; attempt <= CLOUDREC_MAX_ATTEMPTS; attempt++) {
        if (DEBUG_CLOUDREC) console.log(`🎥 CLOUD REC: attempt ${attempt}/${CLOUDREC_MAX_ATTEMPTS}`);

        const ok = await tryStartCloudRecording({ deviceId, channel: deviceId });
        if (ok) {
          await markCloudRecStarted(deviceId);
          return;
        }

        await sleep(CLOUDREC_RETRY_DELAY_MS);
      }

      if (DEBUG_CLOUDREC) console.log("🎥 CLOUD REC: gave up after max attempts (non-fatal)");
    })();
  } catch {}
}

/**
 * ✅ Fleet-wide realtime broadcast.
 * NOTE: This is NOT push notifications. It will reach anyone currently online in the app.
 */
async function tryBroadcastSOS({ groupId, deviceId, displayName, link, lat, lng }) {
  if (!groupId) return false;

  try {
    const ch = supabase.channel(`fleet:${groupId}`);

    const subscribed = await new Promise((resolve) => {
      let done = false;
      const timer = setTimeout(() => {
        if (!done) resolve(false);
      }, 2500);

      ch.subscribe((status) => {
        if (status === "SUBSCRIBED") {
          done = true;
          clearTimeout(timer);
          resolve(true);
        }
        if (status === "CHANNEL_ERROR" || status === "TIMED_OUT") {
          done = true;
          clearTimeout(timer);
          resolve(false);
        }
      });
    });

    if (!subscribed) {
      try {
        await supabase.removeChannel(ch);
      } catch {}
      return false;
    }

    const sosId = `SOS_${deviceId}_${Date.now()}`;

    // ✅ FIX: Field names must match what SOSAlertManager expects
    // SOSAlertManager looks for: device_id, display_name, latitude, longitude, timestamp
    const payload = {
      kind: "SOS",
      sos_id: sosId,
      device_id: deviceId,
      display_name: displayName || null, // Sender's display name for immediate use
      group_id: groupId,
      latitude: Number.isFinite(lat) ? lat : null,
      longitude: Number.isFinite(lng) ? lng : null,
      link,
      title: "🚨 SOS ALERT",
      body: `${displayName || "A fleet member"} triggered SOS. Tap to open Fleet Manager.`,
      timestamp: Date.now(),
    };

    const out = await ch.send({ type: "broadcast", event: "sos", payload });

    try {
      await supabase.removeChannel(ch);
    } catch {}

    return !!out && (!out.status || out.status === "ok");
  } catch {
    return false;
  }
}

async function tryBroadcastCancel({ groupId, deviceId, displayName }) {
  if (!groupId) return false;

  try {
    const ch = supabase.channel(`fleet:${groupId}`);

    const subscribed = await new Promise((resolve) => {
      let done = false;
      const timer = setTimeout(() => {
        if (!done) resolve(false);
      }, 2500);

      ch.subscribe((status) => {
        if (status === "SUBSCRIBED") {
          done = true;
          clearTimeout(timer);
          resolve(true);
        }
        if (status === "CHANNEL_ERROR" || status === "TIMED_OUT") {
          done = true;
          clearTimeout(timer);
          resolve(false);
        }
      });
    });

    if (!subscribed) {
      try {
        await supabase.removeChannel(ch);
      } catch {}
      return false;
    }

    // ✅ FIX: Field names must match what SOSAlertManager expects
    const payload = {
      kind: "SOS_CANCEL",
      device_id: deviceId,
      display_name: displayName || null,
      group_id: groupId,
      title: "✅ SOS CANCELED",
      body: `${displayName || "Fleet member"}'s emergency has been resolved.`,
      timestamp: Date.now(),
    };

    const out = await ch.send({ type: "broadcast", event: "sos_cancel", payload });

    try {
      await supabase.removeChannel(ch);
    } catch {}

    return !!out && (!out.status || out.status === "ok");
  } catch {
    return false;
  }
}

// ✅ Optional: call this once at app start if you want
export const registerForBatSignal = async () => {
  try {
    const { status } = await Location.requestForegroundPermissionsAsync();
    if (status !== "granted") console.log("⚠️ Location permission denied");
  } catch {
    console.log("⚠️ Location permission request failed");
  }
};

/**
 * ✅ sendBatSignal(deviceId)
 * Backwards compatible:
 * - sendBatSignal("Device-XXXX")
 * - sendBatSignal({ deviceId, guardianNumber })
 */
export const sendBatSignal = async (arg) => {
  console.log("🦇 BAT SIGNAL: ACTIVATING SILENT MODE...");

  // Always flip SOS first (never block SOS on network)
  await safeSetSOSActive();

  // Discreet tactile confirmation
  try {
    Vibration.vibrate([0, 50, 100, 50]);
  } catch {}

  // Resolve deviceId
  const deviceId =
    typeof arg === "string"
      ? arg
      : typeof arg === "object" && arg?.deviceId
      ? String(arg.deviceId)
      : await getDeviceId();

  // Cloud recording auto-start ONLY on SOS activation (backup)
  safeStartCloudRecordingOnce(deviceId);

  // Resolve guardian number (kept intact even though we're not using SMS by default)
  const guardianNumber =
    typeof arg === "object" && arg?.guardianNumber
      ? String(arg.guardianNumber)
      : GUARDIAN_PHONE_NUMBER;

  const groupId = await getGroupId();
  const displayName = await getDisplayName();

  // ✅ FAST last-known first, then refine
  const { fast, refined } = await getFastThenRefineLocation();

  const fastLat = safeNum(fast?.coords?.latitude, null);
  const fastLng = safeNum(fast?.coords?.longitude, null);
  const fastAcc = safeNum(fast?.coords?.accuracy, null);

  // Build link (uses last-known immediately if present; else device-only link)
  const fullLink = buildLink(deviceId, fastLat, fastLng);
  console.log("🔗 SOS LINK:", fullLink);

  // Force immediate SOS sync using last-known coords if we have them
  await safeForceSOSSync({ lat: fastLat, lng: fastLng, accuracy: fastAcc });

  // Fleet-wide in-app alert (realtime broadcast)
  const broadcastOk = await tryBroadcastSOS({
    groupId,
    deviceId,
    displayName,
    link: fullLink,
    lat: fastLat,
    lng: fastLng,
  });
  if (broadcastOk) console.log("✅ SOS broadcast delivered (in-app)");

  // Trigger push notifications for background/offline users (fallback if pg_net unavailable)
  triggerPushNotifications({ deviceId, groupId, displayName, lat: fastLat, lng: fastLng });

  // ✅ If we got a refined current GPS fix, sync again (best-effort upgrade)
  const refLat = safeNum(refined?.coords?.latitude, null);
  const refLng = safeNum(refined?.coords?.longitude, null);
  const refAcc = safeNum(refined?.coords?.accuracy, null);

  const refinedLooksBetter =
    Number.isFinite(refLat) &&
    Number.isFinite(refLng) &&
    (fastAcc == null || (refAcc != null && refAcc < fastAcc));

  if (refinedLooksBetter) {
    console.log("📍 Refined GPS acquired, syncing improved coordinates...");
    await safeForceSOSSync({ lat: refLat, lng: refLng, accuracy: refAcc });
  }

  // ✅ SMS path kept intact but disabled by default
  if (ENABLE_SMS) {
    try {
      const res = await postWithTimeout(
        CLOUD_ROBOT_URL,
        {
          guardianNumber,
          messageLink: fullLink,
          deviceId,
          groupId,
        },
        8000
      );

      const contentType = res.headers?.get?.("content-type") || "";
      const isJson = contentType.includes("application/json");

      if (res.ok && isJson) {
        console.log("✅ SILENT SMS REQUEST ACCEPTED");
        return true;
      }

      console.log(
        "⚠️ Cloud Robot not ready (SMS not sent). Status:",
        res.status,
        "Type:",
        contentType
      );
      console.log("⚠️ USE THIS LINK MANUALLY:", fullLink);
      return true;
    } catch (e) {
      const msg = e?.name === "AbortError" ? "Request timed out" : e?.message || String(e);
      console.log("⚠️ Cloud Robot network error (SMS not sent):", msg);
      console.log("⚠️ USE THIS LINK MANUALLY:", fullLink);
      return true;
    }
  }

  return true;
};

/**
 * ✅ CHECK-IN: Send "I'm OK" status to fleet (non-SOS)
 * Broadcasts a check-in message without triggering emergency protocols
 */
export const sendCheckIn = async () => {
  console.log("✅ CHECK-IN: Sending 'I'm OK' to fleet...");

  try {
    const deviceId = await getDeviceId();
    const groupId = await getGroupId();
    const displayName = await getDisplayName();

    if (!deviceId || !groupId) {
      console.log("⚠️ CHECK-IN: No device or group context");
      return false;
    }

    // Get current location for the check-in
    const { fast } = await getFastThenRefineLocation();
    const lat = safeNum(fast?.coords?.latitude, null);
    const lng = safeNum(fast?.coords?.longitude, null);

    // Broadcast check-in to fleet
    const ch = supabase.channel(`fleet:${groupId}`);

    const subscribed = await new Promise((resolve) => {
      let done = false;
      const timer = setTimeout(() => {
        if (!done) resolve(false);
      }, 2500);

      ch.subscribe((status) => {
        if (status === "SUBSCRIBED") {
          done = true;
          clearTimeout(timer);
          resolve(true);
        }
        if (status === "CHANNEL_ERROR" || status === "TIMED_OUT") {
          done = true;
          clearTimeout(timer);
          resolve(false);
        }
      });
    });

    if (!subscribed) {
      try {
        await supabase.removeChannel(ch);
      } catch {}
      return false;
    }

    const payload = {
      kind: "CHECK_IN",
      device_id: deviceId,
      display_name: displayName || null,
      group_id: groupId,
      latitude: Number.isFinite(lat) ? lat : null,
      longitude: Number.isFinite(lng) ? lng : null,
      title: "✅ Check-In",
      body: `${displayName || "A fleet member"} checked in: I'm OK`,
      timestamp: Date.now(),
    };

    const out = await ch.send({ type: "broadcast", event: "check_in", payload });

    try {
      await supabase.removeChannel(ch);
    } catch {}

    const success = !!out && (!out.status || out.status === "ok");
    if (success) console.log("✅ CHECK-IN: Broadcast delivered");

    return success;
  } catch (e) {
    console.log("⚠️ CHECK-IN error:", e?.message || e);
    return false;
  }
};

// ✅ Hidden Safe Cancel (won't hang)
// ✅ PRIVACY RESTORATION: When SOS is cancelled, fleet loses ALL access to
//    location, camera, and audio until user triggers SOS again.
// ✅ FIX: Broadcast cancel FIRST so fleet members stop alarms immediately,
//    then run all cleanup in parallel so nothing blocks the cancel.
export const cancelBatSignal = async () => {
  console.log("🟢 SOS CANCEL: Restoring privacy (stopping all sharing)...");

  // ✅ Step 0: Resolve identifiers upfront (needed for broadcast + cleanup)
  let deviceId, groupId, displayName;
  try {
    deviceId = await getDeviceId();
    groupId = await getGroupId();
    displayName = await getDisplayName();
  } catch {}

  // ✅ Step 1: BROADCAST CANCEL FIRST — this is what stops alarms on other devices
  // Must happen before any cleanup that could hang (e.g., stopLiveTracking on Android)
  try {
    if (deviceId && groupId) {
      const ok = await withTimeout(
        tryBroadcastCancel({ groupId, deviceId, displayName }),
        3000,
        "broadcast_cancel_timeout"
      );
      if (ok) console.log("✅ SOS cancel broadcast delivered (in-app)");
      else console.log("⚠️ SOS cancel broadcast may not have reached fleet");
    }
  } catch (e) {
    console.log("⚠️ Broadcast cancel failed (non-fatal):", e?.message || e);
  }

  // ✅ Step 2: Send CANCEL push notification so background/offline users get notified
  try {
    if (deviceId && groupId) {
      triggerCancelPushNotification({ deviceId, groupId, displayName });
    }
  } catch {}

  // ✅ Step 3: Run ALL cleanup in PARALLEL (nothing should block the cancel)
  await Promise.allSettled([
    // Clear SOS flag in AsyncStorage
    withTimeout(clearSOS(), CANCEL_TIMEOUT_MS, "clearSOS_timeout").catch(() => {}),

    // Stop background GPS tracking + mark OFFLINE
    withTimeout(stopLiveTracking(), CANCEL_TIMEOUT_MS, "stopLiveTracking_timeout")
      .then(() => console.log("✅ GPS tracking stopped (privacy restored)"))
      .catch(async (e) => {
        console.log("⚠️ stopLiveTracking timeout/failed (non-fatal):", e?.message || e);
        // Fallback: at least try to sync OFFLINE status via RPC
        try {
          await withTimeout(safeForceOfflineSync(), CANCEL_TIMEOUT_MS, "forceOfflineSync_timeout");
        } catch {}
      }),

    // Stop cloud recording (best-effort)
    (async () => {
      try {
        if (deviceId && ENABLE_CLOUD_RECORDING_AUTOSTART) {
          tryStopCloudRecording({ deviceId, channel: deviceId });
          clearCloudRecStarted(deviceId);
          clearCloudRecSession(deviceId);
        }
      } catch {}
    })(),

    // ✅ Force DB status to OFFLINE via RPC (reliable backup — direct upsert may fail due to RLS)
    (async () => {
      try {
        if (deviceId && groupId) {
          const { error } = await withTimeout(
            supabase.rpc("upsert_tracking_session", {
              p_device_id: deviceId,
              p_group_id: groupId,
              p_data: {
                status: "OFFLINE",
                last_updated: new Date().toISOString(),
              },
            }),
            CANCEL_TIMEOUT_MS,
            "rpc_offline_timeout"
          );
          if (error) {
            console.log("⚠️ RPC OFFLINE update failed (non-fatal):", error.message);
          } else {
            console.log("✅ DB status set to OFFLINE via RPC");
          }
        }
      } catch (e) {
        console.log("⚠️ RPC OFFLINE timeout (non-fatal):", e?.message || e);
      }
    })(),
  ]);

  // ✅ FIX: Delayed retry for OFFLINE RPC — during SOS the network is saturated,
  // so the immediate attempt often fails. Retry after 3s when video/GPS have stopped.
  if (offlineRetryTimer) {
    clearTimeout(offlineRetryTimer);
    offlineRetryTimer = null;
  }
  if (deviceId && groupId) {
    offlineRetryTimer = setTimeout(async () => {
      offlineRetryTimer = null;
      try {
        const { error } = await supabase.rpc("upsert_tracking_session", {
          p_device_id: deviceId,
          p_group_id: groupId,
          p_data: {
            status: "OFFLINE",
            last_updated: new Date().toISOString(),
          },
        });
        if (!error) {
          console.log("✅ Delayed OFFLINE RPC succeeded");
        }
      } catch {}
    }, 3000);
  }

  return true;
};

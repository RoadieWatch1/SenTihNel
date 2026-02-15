// 📂 FILE: src/services/SOSAlertManager.js
// Central manager for SOS alerts across the app
// Coordinates alarm, notifications, and UI overlay
// Works on both iOS and Android
//
// ✅ GOLDEN RULE: Only the SOS SENDER can change their tracking_sessions.status.
//    Receivers NEVER write sender status. Acknowledgment is LOCAL suppression only.
//
// ✅ FIX: Broadcast listeners on sos:{groupId} channel (must match BatSignal sender)
// ✅ FIX: postgres_changes on SEPARATE db_watch channel (non-fatal if it fails)
// ✅ FIX: Added retry on CHANNEL_ERROR with backoff
// ✅ FIX: Check for resolved alerts when app resumes from background
// ✅ FIX: Local suppression replaces DB write on acknowledge (stops alarm loop)
// ✅ FIX: Centralized maybeRaiseAlarm prevents 5-channel stampede
// ✅ FIX: Resume only restarts alarm for unsuppressed incidents
// ✅ FIX: Multi-group init no longer spams stopAlarm

import { AppState } from "react-native";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { supabase } from "../lib/supabase";
import AlarmService from "./AlarmService";
import NotificationService from "./NotificationService";

// ============================================
// CONFIGURATION
// ============================================

const ACTIVE_SOS_KEY = "sentinel_active_sos";
const SUPPRESSED_KEY = "sentinel_suppressed_sos"; // ✅ Persisted suppression
const MY_DEVICE_ID_KEY = "sentinel_device_id";

// Retry config for channel connection
const MAX_CHANNEL_RETRIES = 5;
const INITIAL_RETRY_DELAY_MS = 2000;

// Periodic DB poll interval when SOS alerts are active (unsuppressed only)
const RESOLVED_POLL_INTERVAL_MS = 15_000;

// ============================================
// STATE
// ============================================

let isInitialized = false;
let isInitializing = false;
let currentGroupIds = [];
let myDeviceId = null;
let realtimeChannels = new Map(); // groupId -> channel (broadcast)
let dbWatchChannels = new Map(); // groupId -> channel (postgres_changes backup)
let channelRetryTimers = new Map();
let channelRetryCounts = new Map();
let appStateSubscription = null;
let notificationSubscriptions = [];
let resolvedPollTimer = null;

// Callbacks for UI updates
let onSOSReceived = null; // (sosData) => void
let onSOSCancelled = null; // (deviceId) => void
let onSOSAcknowledged = null; // (deviceId, byDeviceId) => void

// Track active SOS alerts (truth from sender's DB status)
let activeSOSAlerts = new Map(); // deviceId -> sosData

// ✅ LOCAL SUPPRESSION: Receiver-side "I saw it, stop alarming me"
// Key = deviceId (one active SOS per device at a time)
// Cleared ONLY when sender actually cancels SOS
let suppressedIncidents = new Map(); // deviceId -> { suppressedAt, suppressedBy }

// Deduplication: prevent same broadcast from triggering alarm twice
let handledIncidents = new Map(); // incidentKey -> timestamp
const HANDLED_INCIDENT_TTL_MS = 5 * 60 * 1000;

// ============================================
// SUPPRESSION PERSISTENCE
// ============================================

async function saveSuppressed() {
  try {
    const entries = Array.from(suppressedIncidents.entries());
    await AsyncStorage.setItem(SUPPRESSED_KEY, JSON.stringify(entries));
  } catch (e) {
    console.log("SOSAlertManager: Failed to save suppressed incidents", e);
  }
}

async function loadSuppressed() {
  try {
    const stored = await AsyncStorage.getItem(SUPPRESSED_KEY);
    if (stored) {
      suppressedIncidents = new Map(JSON.parse(stored));
    }
  } catch (e) {
    console.log("SOSAlertManager: Failed to load suppressed incidents", e);
  }
}

/**
 * Clear suppression for a device (called when sender cancels SOS)
 */
function clearSuppression(deviceId) {
  if (suppressedIncidents.has(deviceId)) {
    console.log("SOSAlertManager: Clearing suppression for", deviceId, "(SOS cancelled by sender)");
    suppressedIncidents.delete(deviceId);
    saveSuppressed().catch(() => {});
  }
}

/**
 * Check if incident is suppressed on this device
 */
function isSuppressed(deviceId) {
  return suppressedIncidents.has(deviceId);
}

// ============================================
// INITIALIZATION
// ============================================

async function initialize(groupIds, deviceId, callbacks = {}) {
  const ids = Array.from(new Set(
    (Array.isArray(groupIds) ? groupIds : [groupIds]).filter(Boolean).map(String)
  ));

  if (isInitializing) {
    console.log("SOSAlertManager: Already initializing, skipping duplicate call");
    return;
  }

  if (isInitialized && JSON.stringify(currentGroupIds.sort()) === JSON.stringify(ids.sort())) {
    console.log("SOSAlertManager: Already initialized for these groups");
    return;
  }

  isInitializing = true;
  console.log("SOSAlertManager: Initializing for", ids.length, "groups:", ids.map(g => g?.slice(0, 8)));

  try {
    currentGroupIds = ids;
    myDeviceId = deviceId || (await AsyncStorage.getItem(MY_DEVICE_ID_KEY));
    onSOSReceived = callbacks.onSOSReceived || null;
    onSOSCancelled = callbacks.onSOSCancelled || null;
    onSOSAcknowledged = callbacks.onSOSAcknowledged || null;

    // Cleanup existing subscriptions (but preserve suppression state)
    await cleanup();

    // ✅ Load persisted suppression state (survives app restart)
    await loadSuppressed();

    // Register push tokens for ALL groups
    const pushToken = await NotificationService.registerForPushNotifications();
    if (pushToken && myDeviceId) {
      for (const gid of ids) {
        await NotificationService.savePushTokenToSupabase(pushToken, myDeviceId, gid);
      }
    }

    // Subscribe to broadcast + DB changes for EACH group
    for (const gid of ids) {
      subscribeToRealtimeChannel(gid);
      subscribeToDbWatchChannel(gid);
    }

    setupAppStateListener();
    setupNotificationListeners();

    // Check for active SOS alerts across all groups (batched, no per-group alarm spam)
    await checkAllGroupsForActiveAlerts(ids);

    isInitialized = true;
    console.log("SOSAlertManager: Initialized successfully for", ids.length, "groups");
  } finally {
    isInitializing = false;
  }
}

async function cleanup() {
  console.log("SOSAlertManager: Cleaning up");

  for (const [, timer] of channelRetryTimers) clearTimeout(timer);
  channelRetryTimers.clear();
  channelRetryCounts.clear();

  stopResolvedPoll();

  for (const [, ch] of realtimeChannels) {
    try { await supabase.removeChannel(ch); } catch {}
  }
  realtimeChannels.clear();

  for (const [, ch] of dbWatchChannels) {
    try { await supabase.removeChannel(ch); } catch {}
  }
  dbWatchChannels.clear();

  if (appStateSubscription) {
    appStateSubscription.remove();
    appStateSubscription = null;
  }

  notificationSubscriptions.forEach((sub) => sub.remove());
  notificationSubscriptions = [];

  await AlarmService.stopAlarm();

  handledIncidents.clear();
  // ✅ NOTE: We do NOT clear suppressedIncidents on cleanup.
  // Suppression persists until sender cancels SOS.

  isInitialized = false;
  isInitializing = false;
}

// ============================================
// REALTIME SUBSCRIPTIONS
// ============================================

function subscribeToRealtimeChannel(groupId) {
  const channelName = `sos:${groupId}`;

  const channel = supabase
    .channel(channelName)
    .on("broadcast", { event: "sos" }, (payload) => {
      handleSOSBroadcast(payload.payload);
    })
    .on("broadcast", { event: "sos_cancel" }, (payload) => {
      handleSOSCancelBroadcast(payload.payload);
    })
    .on("broadcast", { event: "sos_acknowledge" }, (payload) => {
      handleSOSAcknowledgeBroadcast(payload.payload);
    });

  channel.subscribe((status) => {
    console.log("SOSAlertManager: Broadcast channel status:", status, "for", groupId?.slice(0, 8));

    if (status === "SUBSCRIBED") {
      console.log("SOSAlertManager: Broadcast channel connected for", groupId?.slice(0, 8));
      channelRetryCounts.set(groupId, 0);
    }

    if (status === "CHANNEL_ERROR" || status === "TIMED_OUT") {
      console.log("SOSAlertManager: Broadcast channel failed for", groupId?.slice(0, 8), "will retry...");
      scheduleChannelRetry(groupId);
    }
  });

  realtimeChannels.set(groupId, channel);
}

function subscribeToDbWatchChannel(groupId) {
  const channelName = `db_watch:${groupId}`;

  try {
    const channel = supabase
      .channel(channelName)
      .on(
        "postgres_changes",
        {
          event: "UPDATE",
          schema: "public",
          table: "tracking_sessions",
          filter: `group_id=eq.${groupId}`,
        },
        (payload) => {
          const { new: newRow, old: oldRow } = payload;

          if (newRow.status === "SOS" && oldRow?.status !== "SOS") {
            handleSOSStatusChange(newRow);
          }

          if (oldRow?.status === "SOS" && newRow.status !== "SOS") {
            handleSOSCancelledStatusChange(newRow);
          }
        }
      );

    channel.subscribe((status) => {
      console.log("SOSAlertManager: DB watch channel status:", status);

      if (status === "SUBSCRIBED") {
        console.log("SOSAlertManager: DB watch channel connected (backup active)");
      }

      if (status === "CHANNEL_ERROR" || status === "TIMED_OUT") {
        console.log("SOSAlertManager: DB watch channel failed (non-fatal, broadcast still active)");
      }
    });

    dbWatchChannels.set(groupId, channel);
  } catch (e) {
    console.log("SOSAlertManager: DB watch setup failed (non-fatal):", e?.message || e);
  }
}

function scheduleChannelRetry(groupId) {
  const retryCount = channelRetryCounts.get(groupId) || 0;
  if (retryCount >= MAX_CHANNEL_RETRIES) {
    console.log("SOSAlertManager: Max retries reached for", groupId?.slice(0, 8), "will retry on next app resume");
    return;
  }

  const existingTimer = channelRetryTimers.get(groupId);
  if (existingTimer) clearTimeout(existingTimer);

  const newCount = retryCount + 1;
  channelRetryCounts.set(groupId, newCount);
  const delay = INITIAL_RETRY_DELAY_MS * Math.pow(2, retryCount);

  console.log(`SOSAlertManager: Retrying channel for ${groupId?.slice(0, 8)} in ${delay}ms (attempt ${newCount}/${MAX_CHANNEL_RETRIES})`);

  const timer = setTimeout(async () => {
    channelRetryTimers.delete(groupId);

    const oldCh = realtimeChannels.get(groupId);
    if (oldCh) {
      try { await supabase.removeChannel(oldCh); } catch {}
      realtimeChannels.delete(groupId);
    }

    if (currentGroupIds.includes(groupId)) {
      subscribeToRealtimeChannel(groupId);
    }
  }, delay);

  channelRetryTimers.set(groupId, timer);
}

// ============================================
// CENTRALIZED ALARM GATE (prevents 5-channel stampede)
// ============================================

/**
 * ✅ Single entry point for raising alarm + overlay.
 * All channels (broadcast, postgres_changes, DB poll, push notification)
 * must go through this function. It checks:
 * 1. Not our own device
 * 2. Not already handled (dedup)
 * 3. Not suppressed (user already acknowledged this incident)
 * Returns true if alarm was raised, false if suppressed/deduped.
 */
async function maybeRaiseAlarm(sosData) {
  const { device_id, display_name, latitude, longitude, timestamp } = sosData;

  // Don't alert for our own SOS
  if (device_id === myDeviceId) {
    return false;
  }

  // ✅ SUPPRESSION CHECK: If receiver already acknowledged this incident, no alarm
  if (isSuppressed(device_id)) {
    console.log("SOSAlertManager: Incident suppressed for", device_id, "- no alarm");
    // Still track as active (truth from sender) but don't alarm
    if (!activeSOSAlerts.has(device_id)) {
      activeSOSAlerts.set(device_id, { ...sosData, receivedAt: Date.now() });
      await saveActiveAlerts();
    }
    return false;
  }

  // Deduplication: don't re-alarm for same broadcast received multiple times
  const dedupeKey = `${device_id}:${timestamp || "none"}`;
  if (handledIncidents.has(dedupeKey)) {
    console.log("SOSAlertManager: Duplicate SOS ignored (already handled)", dedupeKey);
    return false;
  }

  // Already alarming for this device
  if (activeSOSAlerts.has(device_id)) {
    console.log("SOSAlertManager: Already tracking active alert for", device_id);
    return false;
  }

  // Mark as handled
  handledIncidents.set(dedupeKey, Date.now());
  cleanupOldHandledIncidents();

  // Store active SOS (truth: sender is in SOS)
  activeSOSAlerts.set(device_id, {
    ...sosData,
    receivedAt: Date.now(),
  });
  await saveActiveAlerts();

  // ✅ RAISE ALARM
  const appState = AppState.currentState;
  console.log("🚨 SOSAlertManager: Raising alarm for", device_id, "(appState:", appState, ")");
  await AlarmService.startAlarm();

  if (appState !== "active") {
    console.log("SOSAlertManager: App backgrounded - showing notification");
    await NotificationService.showSOSNotification(
      display_name || `Device ${device_id?.slice(0, 8)}`,
      sosData
    );
  }

  // Start polling for resolved alerts
  startResolvedPoll();

  // Notify UI callback (shows overlay)
  if (onSOSReceived) {
    onSOSReceived({
      deviceId: device_id,
      displayName: display_name,
      latitude,
      longitude,
      timestamp,
    });
  }

  return true;
}

// ============================================
// SOS EVENT HANDLERS
// ============================================

async function handleSOSBroadcast(sosData) {
  console.log("🚨 SOSAlertManager: SOS received from", sosData?.device_id);
  await maybeRaiseAlarm(sosData);
}

async function handleSOSStatusChange(row) {
  await maybeRaiseAlarm({
    device_id: row.device_id,
    display_name: row.display_name,
    latitude: row.latitude,
    longitude: row.longitude,
    timestamp: row.last_updated,
    group_id: row.group_id || null,
  });
}

/**
 * Handle SOS cancel broadcast (sender cancelled their SOS)
 */
async function handleSOSCancelBroadcast(data) {
  const { device_id } = data;

  console.log("SOSAlertManager: SOS cancelled by sender for", device_id);

  // ✅ Clear suppression - incident is over, next SOS from same device should alarm
  clearSuppression(device_id);

  // Remove from active alerts
  activeSOSAlerts.delete(device_id);
  await saveActiveAlerts();

  // Stop alarm + polling if no more UNSUPPRESSED active alerts
  if (!hasUnsuppressedAlerts()) {
    await AlarmService.stopAlarm();
    stopResolvedPoll();
  }

  // Show cancel notification
  await NotificationService.showSOSCancelledNotification(
    data.display_name || `Device ${device_id?.slice(0, 8)}`
  );

  // Notify UI callback (hides overlay)
  if (onSOSCancelled) {
    onSOSCancelled(device_id);
  }
}

async function handleSOSCancelledStatusChange(row) {
  await handleSOSCancelBroadcast({
    device_id: row.device_id,
    display_name: row.display_name,
  });
}

function handleSOSAcknowledgeBroadcast(data) {
  const { device_id, acknowledged_by } = data;
  console.log("SOSAlertManager: SOS acknowledged for", device_id, "by", acknowledged_by);
  if (onSOSAcknowledged) {
    onSOSAcknowledged(device_id, acknowledged_by);
  }
}

// ============================================
// APP STATE HANDLING
// ============================================

function setupAppStateListener() {
  if (appStateSubscription) {
    console.log("SOSAlertManager: App state listener already exists, skipping");
    return;
  }

  appStateSubscription = AppState.addEventListener("change", async (nextState) => {
    console.log("SOSAlertManager: App state changed to", nextState);

    if (nextState === "active") {
      // Re-check database for SOS status changes we may have missed
      await checkAllGroupsForActiveAlerts(currentGroupIds);

      // Reconnect channels on foreground resume
      if (currentGroupIds.length > 0) {
        console.log("SOSAlertManager: Reconnecting channels on app resume");
        channelRetryCounts.clear();

        for (const [, ch] of realtimeChannels) {
          try { await supabase.removeChannel(ch); } catch {}
        }
        realtimeChannels.clear();

        for (const [, ch] of dbWatchChannels) {
          try { await supabase.removeChannel(ch); } catch {}
        }
        dbWatchChannels.clear();

        for (const gid of currentGroupIds) {
          subscribeToRealtimeChannel(gid);
          subscribeToDbWatchChannel(gid);
        }
      }

      // ✅ FIX: Only restart alarm if there are UNSUPPRESSED active alerts
      if (hasUnsuppressedAlerts()) {
        console.log("SOSAlertManager: Unsuppressed alerts exist, restarting alarm on resume");
        await AlarmService.startAlarm();
      }

      await NotificationService.clearAllNotifications();
    }
  });
}

function setupNotificationListeners() {
  if (notificationSubscriptions.length > 0) {
    console.log("SOSAlertManager: Notification listeners already exist, skipping");
    return;
  }

  const receivedSub = NotificationService.addNotificationReceivedListener(
    (notification) => {
      // ✅ FIX: Check if this SOS is suppressed before logging
      const data = notification?.request?.content?.data;
      if (data?.type === "sos" && data?.device_id && isSuppressed(data.device_id)) {
        console.log("SOSAlertManager: Foreground notification suppressed for", data.device_id);
        return;
      }
      console.log("SOSAlertManager: Notification received in foreground");
    }
  );

  const responseSub = NotificationService.addNotificationResponseListener(
    async (response) => {
      console.log("SOSAlertManager: Notification tapped");
      const data = response.notification.request.content.data;

      if (data?.type === "sos" && data?.device_id) {
        // ✅ FIX: Suppress locally instead of writing to DB
        console.log("SOSAlertManager: User tapped SOS notification - suppressing locally");
        await suppressIncident(data.device_id);

        if (onSOSReceived) {
          onSOSReceived({
            deviceId: data.device_id,
            displayName: data.display_name,
            latitude: data.latitude,
            longitude: data.longitude,
            fromNotification: true,
          });
        }
      }
    }
  );

  notificationSubscriptions.push(receivedSub, responseSub);
}

// ============================================
// PERSISTENCE
// ============================================

async function saveActiveAlerts() {
  try {
    const alerts = Array.from(activeSOSAlerts.entries());
    await AsyncStorage.setItem(ACTIVE_SOS_KEY, JSON.stringify(alerts));
  } catch (e) {
    console.log("SOSAlertManager: Failed to save active alerts", e);
  }
}

async function loadActiveAlerts() {
  try {
    const stored = await AsyncStorage.getItem(ACTIVE_SOS_KEY);
    if (stored) {
      activeSOSAlerts = new Map(JSON.parse(stored));
    }
  } catch (e) {
    console.log("SOSAlertManager: Failed to load active alerts", e);
  }
}

// ============================================
// BATCHED GROUP CHECK (replaces per-group spam)
// ============================================

/**
 * ✅ FIX: Check all groups in one pass, then make ONE alarm decision at the end.
 * Prevents per-group stopAlarm/onSOSCancelled spam during init.
 */
async function checkAllGroupsForActiveAlerts(groupIds) {
  try {
    await loadActiveAlerts();
    await loadSuppressed();

    // Collect all active SOS devices across all groups
    const dbActiveDevices = new Set(); // deviceIds still in SOS in DB

    for (const groupId of groupIds) {
      const { data, error } = await supabase
        .from('tracking_sessions_with_name')
        .select("device_id, display_name, latitude, longitude, status, last_updated")
        .eq("group_id", groupId)
        .eq("status", "SOS");

      if (error) {
        console.log("SOSAlertManager: Failed to check active SOS for group", groupId?.slice(0, 8), error);
        continue;
      }

      if (data && data.length > 0) {
        for (const row of data) {
          if (row.device_id === myDeviceId) continue;
          dbActiveDevices.add(row.device_id);

          // Add to active alerts if not already there
          if (!activeSOSAlerts.has(row.device_id)) {
            // Use maybeRaiseAlarm (checks suppression + dedup)
            await maybeRaiseAlarm({
              device_id: row.device_id,
              display_name: row.display_name,
              latitude: row.latitude,
              longitude: row.longitude,
              timestamp: row.last_updated,
              group_id: groupId,
            });
          }
        }
      }
    }

    // Clear stale alerts: devices that are no longer in SOS in any group
    let removedAny = false;
    for (const [deviceId] of activeSOSAlerts) {
      if (!dbActiveDevices.has(deviceId)) {
        console.log("SOSAlertManager: Clearing stale alert for", deviceId);
        activeSOSAlerts.delete(deviceId);
        clearSuppression(deviceId); // Also clear suppression for resolved incidents
        removedAny = true;
        if (onSOSCancelled) onSOSCancelled(deviceId);
      }
    }

    if (removedAny) {
      await saveActiveAlerts();
    }

    // ✅ FIX: Single alarm decision AFTER all groups checked
    if (!hasUnsuppressedAlerts()) {
      // No unsuppressed alerts - make sure alarm is off (ONE call, not per-group)
      if (AlarmService.isPlaying()) {
        await AlarmService.stopAlarm();
      }
      stopResolvedPoll();
    }
  } catch (e) {
    console.log("SOSAlertManager: Error checking all groups for active SOS", e);
  }
}

// ============================================
// RESOLVED-ALERT POLLING
// ============================================

function startResolvedPoll() {
  if (resolvedPollTimer) return;
  if (currentGroupIds.length === 0) return;

  // ✅ FIX: Don't start polling if all alerts are suppressed
  if (!hasUnsuppressedAlerts()) return;

  console.log("SOSAlertManager: Starting resolved-alert polling");
  resolvedPollTimer = setInterval(async () => {
    if (activeSOSAlerts.size === 0) {
      stopResolvedPoll();
      return;
    }

    // ✅ FIX: Stop polling if all remaining alerts are suppressed
    if (!hasUnsuppressedAlerts()) {
      console.log("SOSAlertManager: All alerts suppressed - pausing resolved-alert polling");
      stopResolvedPoll();
      return;
    }

    for (const gid of currentGroupIds) {
      await checkForResolvedAlerts(gid);
    }
  }, RESOLVED_POLL_INTERVAL_MS);
}

function stopResolvedPoll() {
  if (resolvedPollTimer) {
    clearInterval(resolvedPollTimer);
    resolvedPollTimer = null;
    console.log("SOSAlertManager: Stopped resolved-alert polling");
  }
}

/**
 * Check if any active SOS alerts have been resolved
 */
async function checkForResolvedAlerts(groupId) {
  try {
    if (activeSOSAlerts.size === 0) return;

    const activeDeviceIds = Array.from(activeSOSAlerts.entries())
      .filter(([, data]) => data.group_id === groupId)
      .map(([deviceId]) => deviceId);

    if (activeDeviceIds.length === 0) return;

    const { data, error } = await supabase
      .from('tracking_sessions_with_name')
      .select("device_id, status, display_name")
      .eq("group_id", groupId)
      .in("device_id", activeDeviceIds);

    if (error) {
      console.log("SOSAlertManager: Failed to check resolved alerts", error);
      return;
    }

    const stillSOS = new Set((data || []).filter(r => r.status === "SOS").map(r => r.device_id));

    for (const deviceId of activeDeviceIds) {
      if (!stillSOS.has(deviceId)) {
        console.log("SOSAlertManager: Alert resolved (sender cancelled) for", deviceId);
        const alertData = activeSOSAlerts.get(deviceId);
        await handleSOSCancelBroadcast({
          device_id: deviceId,
          display_name: alertData?.display_name || null,
        });
      }
    }
  } catch (e) {
    console.log("SOSAlertManager: Error checking resolved alerts", e);
  }
}

// ============================================
// DEDUPLICATION CLEANUP
// ============================================

function cleanupOldHandledIncidents() {
  const now = Date.now();
  let removedCount = 0;

  for (const [key, handledAt] of handledIncidents) {
    if (now - handledAt > HANDLED_INCIDENT_TTL_MS) {
      handledIncidents.delete(key);
      removedCount++;
    }
  }

  if (removedCount > 0) {
    console.log(`SOSAlertManager: Cleaned up ${removedCount} old handled incidents`);
  }
}

// ============================================
// HELPERS
// ============================================

/**
 * ✅ Check if there are any active alerts that are NOT suppressed
 */
function hasUnsuppressedAlerts() {
  for (const [deviceId] of activeSOSAlerts) {
    if (!isSuppressed(deviceId)) {
      return true;
    }
  }
  return false;
}

// ============================================
// PUBLIC API
// ============================================

/**
 * ✅ Suppress an incident locally (receiver acknowledged)
 * - Stops alarm on this device
 * - Prevents overlay from re-appearing
 * - Does NOT modify sender's DB status (golden rule)
 * - Persisted to AsyncStorage (survives app restart)
 * - Cleared only when sender cancels SOS
 */
async function suppressIncident(deviceId) {
  if (!deviceId) return;

  console.log("SOSAlertManager: Suppressing incident for", deviceId);
  suppressedIncidents.set(deviceId, {
    suppressedAt: Date.now(),
    suppressedBy: myDeviceId,
  });
  await saveSuppressed();

  // Stop alarm if no unsuppressed alerts remain
  if (!hasUnsuppressedAlerts()) {
    await AlarmService.stopAlarm();
    stopResolvedPoll();
  }

  // Broadcast acknowledgment to fleet (informational only - no DB write)
  for (const [, ch] of realtimeChannels) {
    try {
      await ch.send({
        type: "broadcast",
        event: "sos_acknowledge",
        payload: {
          device_id: deviceId,
          acknowledged_by: myDeviceId,
          timestamp: Date.now(),
        },
      });
    } catch {}
  }
}

/**
 * ✅ RENAMED: acknowledgeAlert now delegates to suppressIncident
 * - Does NOT write to sender's tracking_sessions (golden rule)
 * - Only suppresses locally + broadcasts ack
 */
async function acknowledgeAlert(deviceId) {
  console.log("SOSAlertManager: Acknowledging alert for", deviceId);
  await suppressIncident(deviceId);
}

/**
 * Dismiss all alerts (stops alarm, suppresses all, no broadcast)
 */
async function dismissAllAlerts() {
  console.log("SOSAlertManager: Dismissing all alerts");

  // Suppress all active incidents
  for (const [deviceId] of activeSOSAlerts) {
    suppressedIncidents.set(deviceId, {
      suppressedAt: Date.now(),
      suppressedBy: myDeviceId,
    });
  }
  await saveSuppressed();

  await AlarmService.stopAlarm();
  stopResolvedPoll();
}

/**
 * Get all active SOS alerts
 */
function getActiveAlerts() {
  return Array.from(activeSOSAlerts.values());
}

/**
 * Get unsuppressed active alerts (for showing next overlay)
 */
function getUnsuppressedAlerts() {
  return Array.from(activeSOSAlerts.entries())
    .filter(([deviceId]) => !isSuppressed(deviceId))
    .map(([, data]) => data);
}

/**
 * Check if there are any active alerts
 */
function hasActiveAlerts() {
  return activeSOSAlerts.size > 0;
}

/**
 * ✅ setEngaged is now an alias for suppressIncident
 * Kept for backwards compatibility with fleet.js
 */
function setEngaged(deviceId) {
  suppressIncident(deviceId).catch(() => {});
}

/**
 * ✅ Check if an incident is suppressed/engaged
 */
function isEngaged(deviceId) {
  return isSuppressed(deviceId);
}

/**
 * Update group IDs (when user switches fleets)
 */
async function updateGroup(newGroupIds, deviceId) {
  const ids = Array.from(new Set(
    (Array.isArray(newGroupIds) ? newGroupIds : [newGroupIds]).filter(Boolean).map(String)
  ));
  const changed = JSON.stringify(currentGroupIds.sort()) !== JSON.stringify(ids.sort());
  if (changed) {
    await initialize(ids, deviceId, {
      onSOSReceived,
      onSOSCancelled,
      onSOSAcknowledged,
    });
  }
}

// ============================================
// EXPORTS
// ============================================

export const SOSAlertManager = {
  initialize,
  cleanup,
  acknowledgeAlert,
  suppressIncident,
  dismissAllAlerts,
  getActiveAlerts,
  getUnsuppressedAlerts,
  hasActiveAlerts,
  hasUnsuppressedAlerts,
  isSuppressed,
  updateGroup,
  setEngaged,
  isEngaged,
};

export default SOSAlertManager;

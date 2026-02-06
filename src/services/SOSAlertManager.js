// 📂 FILE: src/services/SOSAlertManager.js
// Central manager for SOS alerts across the app
// Coordinates alarm, notifications, and UI overlay
// Works on both iOS and Android
//
// ✅ FIX: Broadcast listeners on fleet:{groupId} channel (must match BatSignal sender)
// ✅ FIX: postgres_changes on SEPARATE db_watch channel (non-fatal if it fails)
// ✅ FIX: Added retry on CHANNEL_ERROR with backoff
// ✅ FIX: Check for resolved alerts when app resumes from background

import { AppState } from "react-native";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { supabase } from "../lib/supabase";
import AlarmService from "./AlarmService";
import NotificationService from "./NotificationService";

// ============================================
// CONFIGURATION
// ============================================

const ACTIVE_SOS_KEY = "sentinel_active_sos";
const MY_DEVICE_ID_KEY = "sentinel_device_id";

// ✅ FIX: Retry config for channel connection
const MAX_CHANNEL_RETRIES = 5;
const INITIAL_RETRY_DELAY_MS = 2000;

// ============================================
// STATE
// ============================================

let isInitialized = false;
let currentGroupId = null;
let myDeviceId = null;
let realtimeChannel = null; // Broadcast channel (critical — must always work)
let dbWatchChannel = null; // Postgres changes channel (optional — best-effort backup)
let channelRetryTimer = null;
let channelRetryCount = 0;
let appStateSubscription = null;
let notificationSubscriptions = [];

// Callbacks for UI updates
let onSOSReceived = null; // (sosData) => void
let onSOSCancelled = null; // (deviceId) => void
let onSOSAcknowledged = null; // (deviceId, byDeviceId) => void

// Track active SOS alerts
let activeSOSAlerts = new Map(); // deviceId -> sosData

// ============================================
// INITIALIZATION
// ============================================

/**
 * Initialize the SOS Alert Manager
 * Call this once when app starts (in _layout.js or App.js)
 */
async function initialize(groupId, deviceId, callbacks = {}) {
  if (isInitialized && currentGroupId === groupId) {
    console.log("SOSAlertManager: Already initialized for this group");
    return;
  }

  console.log("SOSAlertManager: Initializing for group", groupId);

  // Store references
  currentGroupId = groupId;
  myDeviceId = deviceId || (await AsyncStorage.getItem(MY_DEVICE_ID_KEY));
  onSOSReceived = callbacks.onSOSReceived || null;
  onSOSCancelled = callbacks.onSOSCancelled || null;
  onSOSAcknowledged = callbacks.onSOSAcknowledged || null;

  // Cleanup any existing subscriptions
  await cleanup();

  // Register for push notifications
  const pushToken = await NotificationService.registerForPushNotifications();
  if (pushToken && myDeviceId && groupId) {
    await NotificationService.savePushTokenToSupabase(pushToken, myDeviceId, groupId);
  }

  // ✅ FIX: Subscribe to broadcast events (critical) and DB changes (optional backup)
  // These are on SEPARATE channels so a postgres_changes failure can't kill broadcast reception
  subscribeToRealtimeChannel(groupId);
  subscribeToDbWatchChannel(groupId);

  // Listen for app state changes
  setupAppStateListener();

  // Setup notification response listeners
  setupNotificationListeners();

  // Check for any active SOS alerts we might have missed
  await checkForActiveSOSAlerts(groupId);

  isInitialized = true;
  console.log("SOSAlertManager: Initialized successfully");
}

/**
 * Cleanup all subscriptions
 */
async function cleanup() {
  console.log("SOSAlertManager: Cleaning up");

  // Clear retry timer
  if (channelRetryTimer) {
    clearTimeout(channelRetryTimer);
    channelRetryTimer = null;
  }
  channelRetryCount = 0;

  // Remove realtime channels
  if (realtimeChannel) {
    try {
      await supabase.removeChannel(realtimeChannel);
    } catch {}
    realtimeChannel = null;
  }

  if (dbWatchChannel) {
    try {
      await supabase.removeChannel(dbWatchChannel);
    } catch {}
    dbWatchChannel = null;
  }

  // Remove app state subscription
  if (appStateSubscription) {
    appStateSubscription.remove();
    appStateSubscription = null;
  }

  // Remove notification subscriptions
  notificationSubscriptions.forEach((sub) => sub.remove());
  notificationSubscriptions = [];

  // Stop any playing alarm
  await AlarmService.stopAlarm();

  isInitialized = false;
}

// ============================================
// REALTIME SUBSCRIPTIONS
// ============================================

/**
 * ✅ FIX: Subscribe to broadcast events ONLY on the main channel
 * - MUST use same channel name as BatSignal sender (fleet:{groupId}) for broadcasts to work
 * - postgres_changes is on a SEPARATE channel so it can't take down broadcasts if it fails
 * - Retries on CHANNEL_ERROR with backoff
 */
function subscribeToRealtimeChannel(groupId) {
  // MUST match the channel name used in BatSignal.js tryBroadcastSOS/tryBroadcastCancel
  const channelName = `fleet:${groupId}`;

  // Build channel with ONLY broadcast listeners (no postgres_changes)
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

  // Subscribe with retry logic
  channel.subscribe((status) => {
    console.log("SOSAlertManager: Broadcast channel status:", status);

    if (status === "SUBSCRIBED") {
      console.log("SOSAlertManager: Broadcast channel connected successfully");
      channelRetryCount = 0; // Reset on success
    }

    if (status === "CHANNEL_ERROR" || status === "TIMED_OUT") {
      console.log("SOSAlertManager: Broadcast channel failed, will retry...");
      scheduleChannelRetry(groupId);
    }
  });

  realtimeChannel = channel;
}

/**
 * ✅ Subscribe to postgres_changes on a SEPARATE channel (best-effort backup)
 * If this fails (e.g., Realtime not enabled on tracking_sessions table), the broadcast
 * channel keeps working. This is just an extra safety net for catching SOS status changes
 * that happen via direct DB writes (not through broadcast).
 */
function subscribeToDbWatchChannel(groupId) {
  // Use a different channel name so it doesn't conflict with the broadcast channel
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

          // Check if status changed to SOS
          if (newRow.status === "SOS" && oldRow?.status !== "SOS") {
            handleSOSStatusChange(newRow);
          }

          // Check if status changed from SOS (cancelled)
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
        // Non-fatal: broadcast channel is the primary, this is just a backup
        console.log("SOSAlertManager: DB watch channel failed (non-fatal, broadcast still active)");
      }
    });

    dbWatchChannel = channel;
  } catch (e) {
    // Complete failure is non-fatal — broadcast handles the critical path
    console.log("SOSAlertManager: DB watch setup failed (non-fatal):", e?.message || e);
  }
}

/**
 * ✅ FIX: Retry channel connection with exponential backoff
 */
function scheduleChannelRetry(groupId) {
  if (channelRetryCount >= MAX_CHANNEL_RETRIES) {
    console.log("SOSAlertManager: Max retries reached, will retry on next app resume");
    return;
  }

  // Clear any existing timer
  if (channelRetryTimer) {
    clearTimeout(channelRetryTimer);
  }

  const delay = INITIAL_RETRY_DELAY_MS * Math.pow(2, channelRetryCount);
  channelRetryCount++;

  console.log(`SOSAlertManager: Retrying channel in ${delay}ms (attempt ${channelRetryCount}/${MAX_CHANNEL_RETRIES})`);

  channelRetryTimer = setTimeout(async () => {
    // Remove old channel
    if (realtimeChannel) {
      try {
        await supabase.removeChannel(realtimeChannel);
      } catch {}
      realtimeChannel = null;
    }

    // Re-subscribe
    if (currentGroupId === groupId) {
      subscribeToRealtimeChannel(groupId);
    }
  }, delay);
}

// ============================================
// SOS EVENT HANDLERS
// ============================================

/**
 * Handle incoming SOS broadcast
 */
async function handleSOSBroadcast(sosData) {
  const { device_id, display_name, latitude, longitude, timestamp } = sosData;

  console.log("🚨 SOSAlertManager: SOS received from", device_id);

  // Don't alert for our own SOS
  if (device_id === myDeviceId) {
    console.log("SOSAlertManager: Ignoring own SOS");
    return;
  }

  // Store active SOS
  activeSOSAlerts.set(device_id, {
    ...sosData,
    receivedAt: Date.now(),
  });

  // Save to AsyncStorage for persistence
  await saveActiveAlerts();

  // Get app state
  const appState = AppState.currentState;

  if (appState === "active") {
    // App is in foreground - show overlay + alarm
    console.log("SOSAlertManager: App active - starting alarm");
    await AlarmService.startAlarm();
  } else {
    // App is in background - show notification + vibrate
    console.log("SOSAlertManager: App backgrounded - showing notification");
    await NotificationService.showSOSNotification(
      display_name || `Device ${device_id?.slice(0, 8)}`,
      sosData
    );
    // Also start vibration (will work on some devices even in background)
    AlarmService.startVibration();
  }

  // Notify UI callback
  if (onSOSReceived) {
    onSOSReceived({
      deviceId: device_id,
      displayName: display_name,
      latitude,
      longitude,
      timestamp,
    });
  }
}

/**
 * Handle SOS status change from database
 */
async function handleSOSStatusChange(row) {
  // Only process if we don't already have this alert (prevents duplicates)
  if (activeSOSAlerts.has(row.device_id)) {
    return;
  }

  await handleSOSBroadcast({
    device_id: row.device_id,
    display_name: row.display_name,
    latitude: row.latitude,
    longitude: row.longitude,
    timestamp: row.last_updated,
  });
}

/**
 * Handle SOS cancel broadcast
 */
async function handleSOSCancelBroadcast(data) {
  const { device_id } = data;

  console.log("SOSAlertManager: SOS cancelled for", device_id);

  // Remove from active alerts
  activeSOSAlerts.delete(device_id);
  await saveActiveAlerts();

  // Stop alarm if no more active alerts
  if (activeSOSAlerts.size === 0) {
    await AlarmService.stopAlarm();
  }

  // Show cancel notification
  await NotificationService.showSOSCancelledNotification(
    data.display_name || `Device ${device_id?.slice(0, 8)}`
  );

  // Notify UI callback
  if (onSOSCancelled) {
    onSOSCancelled(device_id);
  }
}

/**
 * Handle SOS cancelled from database status change
 */
async function handleSOSCancelledStatusChange(row) {
  await handleSOSCancelBroadcast({
    device_id: row.device_id,
    display_name: row.display_name,
  });
}

/**
 * Handle SOS acknowledge broadcast
 */
function handleSOSAcknowledgeBroadcast(data) {
  const { device_id, acknowledged_by } = data;

  console.log("SOSAlertManager: SOS acknowledged for", device_id, "by", acknowledged_by);

  // Notify UI callback
  if (onSOSAcknowledged) {
    onSOSAcknowledged(device_id, acknowledged_by);
  }
}

// ============================================
// APP STATE HANDLING
// ============================================

/**
 * Setup app state change listener
 */
function setupAppStateListener() {
  appStateSubscription = AppState.addEventListener("change", async (nextState) => {
    console.log("SOSAlertManager: App state changed to", nextState);

    if (nextState === "active") {
      // App came to foreground
      // ✅ FIX: Re-check database for SOS status changes we may have missed while backgrounded
      // This catches both new SOS alerts AND cancellations that happened while offline
      if (currentGroupId) {
        await checkForActiveSOSAlerts(currentGroupId);
        await checkForResolvedAlerts(currentGroupId);
      }

      // ✅ FIX: If channel was in error state, retry connection on app resume
      if (channelRetryCount >= MAX_CHANNEL_RETRIES && currentGroupId) {
        console.log("SOSAlertManager: Retrying channels on app resume");
        channelRetryCount = 0; // Reset counter
        if (realtimeChannel) {
          try {
            await supabase.removeChannel(realtimeChannel);
          } catch {}
          realtimeChannel = null;
        }
        if (dbWatchChannel) {
          try {
            await supabase.removeChannel(dbWatchChannel);
          } catch {}
          dbWatchChannel = null;
        }
        subscribeToRealtimeChannel(currentGroupId);
        subscribeToDbWatchChannel(currentGroupId);
      }

      // Check if there are active SOS alerts
      if (activeSOSAlerts.size > 0) {
        // Start alarm for any active alerts
        await AlarmService.startAlarm();
      }

      // Clear notifications since user is now in app
      await NotificationService.clearAllNotifications();
    } else if (nextState === "background") {
      // App going to background
      // Alarm continues, notifications take over for new alerts
    }
  });
}

/**
 * Setup notification response listeners
 */
function setupNotificationListeners() {
  // Handle notification received in foreground
  const receivedSub = NotificationService.addNotificationReceivedListener(
    (notification) => {
      console.log("SOSAlertManager: Notification received in foreground");
      // Don't need to do anything - realtime should have handled it
    }
  );

  // Handle notification tap
  const responseSub = NotificationService.addNotificationResponseListener(
    (response) => {
      console.log("SOSAlertManager: Notification tapped");
      const data = response.notification.request.content.data;

      if (data?.type === "sos" && data?.device_id) {
        // User tapped SOS notification - trigger UI callback
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

/**
 * Save active alerts to AsyncStorage
 */
async function saveActiveAlerts() {
  try {
    const alerts = Array.from(activeSOSAlerts.entries());
    await AsyncStorage.setItem(ACTIVE_SOS_KEY, JSON.stringify(alerts));
  } catch (e) {
    console.log("SOSAlertManager: Failed to save active alerts", e);
  }
}

/**
 * Load active alerts from AsyncStorage
 */
async function loadActiveAlerts() {
  try {
    const stored = await AsyncStorage.getItem(ACTIVE_SOS_KEY);
    if (stored) {
      const alerts = JSON.parse(stored);
      activeSOSAlerts = new Map(alerts);
    }
  } catch (e) {
    console.log("SOSAlertManager: Failed to load active alerts", e);
  }
}

/**
 * Check for any active SOS alerts in the database
 */
async function checkForActiveSOSAlerts(groupId) {
  try {
    // Load persisted alerts first
    await loadActiveAlerts();

    // Query database for current SOS statuses
    const { data, error } = await supabase
      .from('tracking_sessions_with_name')
      .select("device_id, display_name, latitude, longitude, status, last_updated")
      .eq("group_id", groupId)
      .eq("status", "SOS");

    if (error) {
      console.log("SOSAlertManager: Failed to check active SOS", error);
      return;
    }

    if (data && data.length > 0) {
      console.log("SOSAlertManager: Found", data.length, "active SOS alerts");

      for (const row of data) {
        // Don't alert for our own SOS
        if (row.device_id === myDeviceId) continue;

        // Add to active alerts if not already there
        if (!activeSOSAlerts.has(row.device_id)) {
          await handleSOSBroadcast({
            device_id: row.device_id,
            display_name: row.display_name,
            latitude: row.latitude,
            longitude: row.longitude,
            timestamp: row.last_updated,
          });
        }
      }
    } else {
      // ✅ No active SOS in DB — if we have local alerts, they're stale
      if (activeSOSAlerts.size > 0) {
        console.log("SOSAlertManager: No SOS in DB but", activeSOSAlerts.size, "local alerts — clearing stale alerts");
        activeSOSAlerts.clear();
        await saveActiveAlerts();
        await AlarmService.stopAlarm();
      }
    }
  } catch (e) {
    console.log("SOSAlertManager: Error checking active SOS", e);
  }
}

/**
 * ✅ FIX: Check if any active SOS alerts have been resolved while app was backgrounded
 * This catches cancel events that were missed because the WebSocket was inactive
 */
async function checkForResolvedAlerts(groupId) {
  try {
    if (activeSOSAlerts.size === 0) return;

    // Query current SOS statuses for all devices we think are in SOS
    const activeDeviceIds = Array.from(activeSOSAlerts.keys());
    const { data, error } = await supabase
      .from('tracking_sessions_with_name')
      .select("device_id, status, display_name")
      .eq("group_id", groupId)
      .in("device_id", activeDeviceIds);

    if (error) {
      console.log("SOSAlertManager: Failed to check resolved alerts", error);
      return;
    }

    // Find devices that are no longer in SOS
    const stillSOS = new Set((data || []).filter(r => r.status === "SOS").map(r => r.device_id));

    for (const deviceId of activeDeviceIds) {
      if (!stillSOS.has(deviceId)) {
        console.log("SOSAlertManager: Alert resolved while backgrounded for", deviceId);
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
// PUBLIC API
// ============================================

/**
 * Acknowledge an SOS alert
 * Stops alarm for this device and broadcasts acknowledgment
 */
async function acknowledgeAlert(deviceId) {
  console.log("SOSAlertManager: Acknowledging alert for", deviceId);

  // Remove from active alerts
  activeSOSAlerts.delete(deviceId);
  await saveActiveAlerts();

  // Stop alarm if no more active alerts
  if (activeSOSAlerts.size === 0) {
    await AlarmService.stopAlarm();
  }

  // Broadcast acknowledgment to fleet
  if (currentGroupId && realtimeChannel) {
    await realtimeChannel.send({
      type: "broadcast",
      event: "sos_acknowledge",
      payload: {
        device_id: deviceId,
        acknowledged_by: myDeviceId,
        timestamp: Date.now(),
      },
    });
  }
}

/**
 * Dismiss all alerts (stops alarm but doesn't broadcast)
 */
async function dismissAllAlerts() {
  console.log("SOSAlertManager: Dismissing all alerts");
  activeSOSAlerts.clear();
  await saveActiveAlerts();
  await AlarmService.stopAlarm();
}

/**
 * Get all active SOS alerts
 */
function getActiveAlerts() {
  return Array.from(activeSOSAlerts.values());
}

/**
 * Check if there are any active alerts
 */
function hasActiveAlerts() {
  return activeSOSAlerts.size > 0;
}

/**
 * Update group ID (when user switches fleets)
 */
async function updateGroup(newGroupId, deviceId) {
  if (newGroupId !== currentGroupId) {
    await initialize(newGroupId, deviceId, {
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
  dismissAllAlerts,
  getActiveAlerts,
  hasActiveAlerts,
  updateGroup,
};

export default SOSAlertManager;

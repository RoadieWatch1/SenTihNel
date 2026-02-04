// 📂 FILE: src/services/SOSAlertManager.js
// Central manager for SOS alerts across the app
// Coordinates alarm, notifications, and UI overlay
// Works on both iOS and Android

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

// ============================================
// STATE
// ============================================

let isInitialized = false;
let currentGroupId = null;
let myDeviceId = null;
let realtimeChannel = null;
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

  // Subscribe to realtime SOS broadcasts
  subscribeToSOSBroadcasts(groupId);

  // Subscribe to tracking_sessions changes for SOS status
  subscribeToSOSStatusChanges(groupId);

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

  // Remove realtime channel
  if (realtimeChannel) {
    await supabase.removeChannel(realtimeChannel);
    realtimeChannel = null;
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
 * Subscribe to SOS broadcasts on the fleet channel
 * Uses same channel as BatSignal.js: fleet:${groupId}
 */
function subscribeToSOSBroadcasts(groupId) {
  const channelName = `fleet:${groupId}`;

  realtimeChannel = supabase
    .channel(channelName)
    .on("broadcast", { event: "sos" }, (payload) => {
      handleSOSBroadcast(payload.payload);
    })
    .on("broadcast", { event: "sos_cancel" }, (payload) => {
      handleSOSCancelBroadcast(payload.payload);
    })
    .on("broadcast", { event: "sos_acknowledge" }, (payload) => {
      handleSOSAcknowledgeBroadcast(payload.payload);
    })
    .subscribe((status) => {
      console.log("SOSAlertManager: Broadcast channel status:", status);
    });
}

/**
 * Subscribe to tracking_sessions table for SOS status changes
 * This catches SOS triggers even if broadcast is missed
 */
function subscribeToSOSStatusChanges(groupId) {
  // This is handled by the broadcast channel primarily
  // But we also listen to postgres changes as a backup
  if (realtimeChannel) {
    realtimeChannel.on(
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
  }
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
    }
  } catch (e) {
    console.log("SOSAlertManager: Error checking active SOS", e);
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

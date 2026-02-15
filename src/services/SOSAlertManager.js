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

// ✅ FIX: Periodic DB poll interval when SOS alerts are active
// Catches missed cancel broadcasts (e.g., WebSocket momentarily disconnected)
const RESOLVED_POLL_INTERVAL_MS = 15_000; // Check every 15 seconds

// ============================================
// STATE
// ============================================

let isInitialized = false;
let isInitializing = false; // ✅ FIX (Step 5): Prevent concurrent initialization
let currentGroupIds = []; // ✅ Multi-group support
let myDeviceId = null;
let realtimeChannels = new Map(); // groupId -> channel (broadcast — critical)
let dbWatchChannels = new Map(); // groupId -> channel (postgres_changes — backup)
let channelRetryTimers = new Map(); // groupId -> timer
let channelRetryCounts = new Map(); // groupId -> count
let appStateSubscription = null;
let notificationSubscriptions = [];
let resolvedPollTimer = null; // ✅ Periodic DB poll for missed cancel broadcasts

// Callbacks for UI updates
let onSOSReceived = null; // (sosData) => void
let onSOSCancelled = null; // (deviceId) => void
let onSOSAcknowledged = null; // (deviceId, byDeviceId) => void

// Track active SOS alerts
let activeSOSAlerts = new Map(); // deviceId -> sosData

// ✅ Track engaged/acknowledged SOS (prevents re-alarming while in Live View)
let engagedIncidents = new Map(); // incidentKey -> timestamp

// ✅ FIX (Step 2): Track handled incidents to prevent duplicate alarm triggers
// If same SOS broadcast received multiple times (retries, network delays), ignore duplicates
let handledIncidents = new Map(); // incidentKey -> timestamp
const HANDLED_INCIDENT_TTL_MS = 5 * 60 * 1000; // Keep for 5 minutes then auto-cleanup

// ============================================
// INITIALIZATION
// ============================================

/**
 * Initialize the SOS Alert Manager
 * Call this once when app starts (in _layout.js or App.js)
 * ✅ Now accepts an array of groupIds to listen on ALL user fleets
 * Also accepts a single groupId string for backwards compatibility
 */
async function initialize(groupIds, deviceId, callbacks = {}) {
  // Normalize: accept single string or array
  const ids = Array.from(new Set(
    (Array.isArray(groupIds) ? groupIds : [groupIds]).filter(Boolean).map(String)
  ));

  // ✅ FIX (Step 5): Prevent concurrent initialization (race condition guard)
  if (isInitializing) {
    console.log("SOSAlertManager: Already initializing, skipping duplicate call");
    return;
  }

  // Check if already initialized with same groups
  if (isInitialized && JSON.stringify(currentGroupIds.sort()) === JSON.stringify(ids.sort())) {
    console.log("SOSAlertManager: Already initialized for these groups");
    return;
  }

  isInitializing = true;
  console.log("SOSAlertManager: Initializing for", ids.length, "groups:", ids.map(g => g?.slice(0, 8)));

  try {
    // Store references
    currentGroupIds = ids;
    myDeviceId = deviceId || (await AsyncStorage.getItem(MY_DEVICE_ID_KEY));
    onSOSReceived = callbacks.onSOSReceived || null;
    onSOSCancelled = callbacks.onSOSCancelled || null;
    onSOSAcknowledged = callbacks.onSOSAcknowledged || null;

    // Cleanup any existing subscriptions
    await cleanup();

    // Register push tokens for ALL groups
    const pushToken = await NotificationService.registerForPushNotifications();
    if (pushToken && myDeviceId) {
      for (const gid of ids) {
        await NotificationService.savePushTokenToSupabase(pushToken, myDeviceId, gid);
      }
    }

    // ✅ Subscribe to broadcast + DB changes for EACH group
    for (const gid of ids) {
      subscribeToRealtimeChannel(gid);
      subscribeToDbWatchChannel(gid);
    }

    // Listen for app state changes
    setupAppStateListener();

    // Setup notification response listeners
    setupNotificationListeners();

    // Check for any active SOS alerts we might have missed (all groups)
    for (const gid of ids) {
      await checkForActiveSOSAlerts(gid);
    }

    isInitialized = true;
    console.log("SOSAlertManager: Initialized successfully for", ids.length, "groups");
  } finally {
    // ✅ FIX (Step 5): Always release initialization lock, even if initialization fails
    isInitializing = false;
  }
}

/**
 * Cleanup all subscriptions
 */
async function cleanup() {
  console.log("SOSAlertManager: Cleaning up");

  // Clear all retry timers
  for (const [, timer] of channelRetryTimers) {
    clearTimeout(timer);
  }
  channelRetryTimers.clear();
  channelRetryCounts.clear();

  // ✅ Clear resolved-alert polling timer
  stopResolvedPoll();

  // Remove all realtime channels
  for (const [, ch] of realtimeChannels) {
    try { await supabase.removeChannel(ch); } catch {}
  }
  realtimeChannels.clear();

  // Remove all DB watch channels
  for (const [, ch] of dbWatchChannels) {
    try { await supabase.removeChannel(ch); } catch {}
  }
  dbWatchChannels.clear();

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

  // ✅ Clear deduplication and engagement tracking
  handledIncidents.clear();
  engagedIncidents.clear();

  isInitialized = false;
  isInitializing = false; // ✅ FIX (Step 5): Release initialization lock
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
  // ✅ FIX #1: Changed to sos: prefix to avoid collision with fleet_ui channel
  const channelName = `sos:${groupId}`;

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
    console.log("SOSAlertManager: Broadcast channel status:", status, "for", groupId?.slice(0, 8));

    if (status === "SUBSCRIBED") {
      console.log("SOSAlertManager: Broadcast channel connected for", groupId?.slice(0, 8));
      channelRetryCounts.set(groupId, 0); // Reset on success
    }

    if (status === "CHANNEL_ERROR" || status === "TIMED_OUT") {
      console.log("SOSAlertManager: Broadcast channel failed for", groupId?.slice(0, 8), "will retry...");
      scheduleChannelRetry(groupId);
    }
  });

  realtimeChannels.set(groupId, channel);
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

    dbWatchChannels.set(groupId, channel);
  } catch (e) {
    // Complete failure is non-fatal — broadcast handles the critical path
    console.log("SOSAlertManager: DB watch setup failed (non-fatal):", e?.message || e);
  }
}

/**
 * ✅ FIX: Retry channel connection with exponential backoff
 */
function scheduleChannelRetry(groupId) {
  const retryCount = channelRetryCounts.get(groupId) || 0;
  if (retryCount >= MAX_CHANNEL_RETRIES) {
    console.log("SOSAlertManager: Max retries reached for", groupId?.slice(0, 8), "will retry on next app resume");
    return;
  }

  // Clear any existing timer for this group
  const existingTimer = channelRetryTimers.get(groupId);
  if (existingTimer) clearTimeout(existingTimer);

  const newCount = retryCount + 1;
  channelRetryCounts.set(groupId, newCount);
  const delay = INITIAL_RETRY_DELAY_MS * Math.pow(2, retryCount);

  console.log(`SOSAlertManager: Retrying channel for ${groupId?.slice(0, 8)} in ${delay}ms (attempt ${newCount}/${MAX_CHANNEL_RETRIES})`);

  const timer = setTimeout(async () => {
    channelRetryTimers.delete(groupId);

    // Remove old channel for this group
    const oldCh = realtimeChannels.get(groupId);
    if (oldCh) {
      try { await supabase.removeChannel(oldCh); } catch {}
      realtimeChannels.delete(groupId);
    }

    // Re-subscribe if this group is still in our list
    if (currentGroupIds.includes(groupId)) {
      subscribeToRealtimeChannel(groupId);
    }
  }, delay);

  channelRetryTimers.set(groupId, timer);
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

  // ✅ FIX (Step 2): Deduplication - ignore if we already handled this exact incident
  // Prevents duplicate alarms from retry broadcasts, network delays, or multi-fleet spam
  const incidentKey = `${device_id}:${timestamp || Date.now()}`;
  if (handledIncidents.has(incidentKey)) {
    console.log("SOSAlertManager: Duplicate SOS ignored (already handled)", incidentKey);
    return;
  }

  // ✅ FIX (Step 1): Check if this incident is already engaged (guard in Live View)
  if (engagedIncidents.has(incidentKey)) {
    console.log("SOSAlertManager: Incident already engaged - suppressing alarm", incidentKey);
    return;
  }

  // ✅ FIX (Step 2): Mark incident as handled to prevent duplicate processing
  handledIncidents.set(incidentKey, Date.now());
  cleanupOldHandledIncidents(); // Periodic cleanup to prevent memory leak

  // Store active SOS
  activeSOSAlerts.set(device_id, {
    ...sosData,
    receivedAt: Date.now(),
    incidentKey, // Store incident key for tracking
  });

  // Save to AsyncStorage for persistence
  await saveActiveAlerts();

  // Get app state
  const appState = AppState.currentState;

  // ✅ FIX: Always start alarm (sound + vibration) regardless of app state.
  // AlarmService uses staysActiveInBackground: true, so it can play in background.
  // Previously only foreground got the alarm — background users got silent vibration only.
  console.log("SOSAlertManager: Starting alarm (appState:", appState, ")");
  await AlarmService.startAlarm();

  if (appState !== "active") {
    // App is in background - also show push notification as fallback
    console.log("SOSAlertManager: App backgrounded - showing notification");
    await NotificationService.showSOSNotification(
      display_name || `Device ${device_id?.slice(0, 8)}`,
      sosData
    );
  }

  // ✅ FIX: Start polling DB for resolved alerts (catches missed cancel broadcasts)
  startResolvedPoll();

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
    group_id: row.group_id || null,
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

  // Stop alarm + polling if no more active alerts
  if (activeSOSAlerts.size === 0) {
    await AlarmService.stopAlarm();
    stopResolvedPoll();
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
 * ✅ FIX (Step 5): Guard against duplicate listeners
 */
function setupAppStateListener() {
  // Don't create duplicate listener if one already exists
  if (appStateSubscription) {
    console.log("SOSAlertManager: App state listener already exists, skipping");
    return;
  }

  appStateSubscription = AppState.addEventListener("change", async (nextState) => {
    console.log("SOSAlertManager: App state changed to", nextState);

    if (nextState === "active") {
      // App came to foreground
      // ✅ Re-check database for SOS status changes we may have missed while backgrounded
      for (const gid of currentGroupIds) {
        await checkForActiveSOSAlerts(gid);
        await checkForResolvedAlerts(gid);
      }

      // ✅ Always reconnect channels on foreground resume (all groups).
      if (currentGroupIds.length > 0) {
        console.log("SOSAlertManager: Reconnecting channels on app resume");
        channelRetryCounts.clear();

        for (const [gid, ch] of realtimeChannels) {
          try { await supabase.removeChannel(ch); } catch {}
        }
        realtimeChannels.clear();

        for (const [gid, ch] of dbWatchChannels) {
          try { await supabase.removeChannel(ch); } catch {}
        }
        dbWatchChannels.clear();

        for (const gid of currentGroupIds) {
          subscribeToRealtimeChannel(gid);
          subscribeToDbWatchChannel(gid);
        }
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
 * ✅ FIX (Step 5): Guard against duplicate listeners
 */
function setupNotificationListeners() {
  // Don't create duplicate listeners if they already exist
  if (notificationSubscriptions.length > 0) {
    console.log("SOSAlertManager: Notification listeners already exist, skipping");
    return;
  }

  // Handle notification received in foreground
  const receivedSub = NotificationService.addNotificationReceivedListener(
    (notification) => {
      console.log("SOSAlertManager: Notification received in foreground");
      // Don't need to do anything - realtime should have handled it
    }
  );

  // Handle notification tap
  const responseSub = NotificationService.addNotificationResponseListener(
    async (response) => {
      console.log("SOSAlertManager: Notification tapped");
      const data = response.notification.request.content.data;

      if (data?.type === "sos" && data?.device_id) {
        // ✅ FIX: Stop alarm when user taps "View" to acknowledge the SOS
        console.log("SOSAlertManager: User viewed SOS - acknowledging alert");
        await acknowledgeAlert(data.device_id);

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
      console.log("SOSAlertManager: Found", data.length, "active SOS alerts in group", groupId?.slice(0, 8));

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
            group_id: groupId,
          });
        }
      }
    } else {
      // ✅ FIX (Bug 3): Only clear alerts that belong to THIS group, not all groups.
      // Previously, checking a "quiet" fleet cleared alerts from the "active" fleet.
      let removedAny = false;
      for (const [deviceId, alertData] of activeSOSAlerts) {
        if (alertData.group_id === groupId) {
          console.log("SOSAlertManager: Clearing stale alert for", deviceId, "in group", groupId?.slice(0, 8));
          activeSOSAlerts.delete(deviceId);
          removedAny = true;
          if (onSOSCancelled) onSOSCancelled(deviceId);
        }
      }

      if (removedAny) {
        await saveActiveAlerts();
      }

      // Stop alarm + polling only if NO alerts remain across ANY group
      if (activeSOSAlerts.size === 0) {
        await AlarmService.stopAlarm();
        stopResolvedPoll();
        if (!removedAny && onSOSCancelled) {
          onSOSCancelled(null);
        }
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

    // ✅ FIX (Bug 4): Only check devices whose alert belongs to THIS group.
    // Previously, all active device IDs were checked against one group's DB,
    // causing cross-group alerts to be falsely cancelled.
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
// RESOLVED-ALERT POLLING
// ============================================

/**
 * ✅ FIX: Start periodic DB polling to catch missed SOS cancel broadcasts.
 * When a cancel broadcast is missed (WebSocket momentary disconnect), the overlay
 * stays forever. This poll checks the DB every 15s while alerts are active.
 * ✅ FIX (Step 4): Stop polling if all active alerts are engaged (guard in Live View)
 */
function startResolvedPoll() {
  if (resolvedPollTimer) return; // Already running
  if (currentGroupIds.length === 0) return;

  console.log("SOSAlertManager: Starting resolved-alert polling");
  resolvedPollTimer = setInterval(async () => {
    if (activeSOSAlerts.size === 0) {
      stopResolvedPoll();
      return;
    }

    // ✅ FIX (Step 4): Stop polling if all active alerts are engaged
    // No need to poll DB when guard is actively viewing all incidents
    const allEngaged = Array.from(activeSOSAlerts.values()).every(alert =>
      alert.incidentKey && engagedIncidents.has(alert.incidentKey)
    );

    if (allEngaged) {
      console.log("SOSAlertManager: All alerts engaged - pausing resolved-alert polling");
      stopResolvedPoll();
      return;
    }

    for (const gid of currentGroupIds) {
      await checkForResolvedAlerts(gid);
    }
  }, RESOLVED_POLL_INTERVAL_MS);
}

/**
 * Stop the resolved-alert polling timer
 */
function stopResolvedPoll() {
  if (resolvedPollTimer) {
    clearInterval(resolvedPollTimer);
    resolvedPollTimer = null;
    console.log("SOSAlertManager: Stopped resolved-alert polling");
  }
}

// ============================================
// DEDUPLICATION CLEANUP
// ============================================

/**
 * ✅ FIX (Step 2): Clean up old handled incidents to prevent memory leak
 * Removes incidents older than HANDLED_INCIDENT_TTL_MS (5 minutes)
 */
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
// PUBLIC API
// ============================================

/**
 * ✅ FIX (Step 1): Mark an incident as engaged (guard entered Live View)
 * This prevents re-alarming for the same incident
 * @param {string} deviceId - The device ID that triggered SOS
 * @param {number} timestamp - The SOS timestamp (optional, uses current alert if not provided)
 */
function setEngaged(deviceId, timestamp) {
  // Get timestamp from active alert if not provided
  const alertData = activeSOSAlerts.get(deviceId);
  const ts = timestamp || alertData?.timestamp || Date.now();
  const incidentKey = `${deviceId}:${ts}`;

  console.log("SOSAlertManager: Marking incident as engaged:", incidentKey);
  engagedIncidents.set(incidentKey, Date.now());

  // Stop alarm immediately when guard engages
  AlarmService.stopAlarm().catch(() => {});

  // ✅ FIX (Step 4): Stop polling if all active alerts are now engaged
  const allEngaged = Array.from(activeSOSAlerts.values()).every(alert =>
    alert.incidentKey && engagedIncidents.has(alert.incidentKey)
  );

  if (allEngaged && resolvedPollTimer) {
    console.log("SOSAlertManager: All alerts engaged - stopping resolved-alert polling");
    stopResolvedPoll();
  }
}

/**
 * ✅ FIX (Step 1): Check if an incident is already engaged
 * @param {string} deviceId - The device ID that triggered SOS
 * @param {number} timestamp - The SOS timestamp (optional)
 * @returns {boolean} True if incident is engaged
 */
function isEngaged(deviceId, timestamp) {
  if (!timestamp) {
    // If no timestamp provided, check by deviceId prefix
    for (const key of engagedIncidents.keys()) {
      if (key.startsWith(`${deviceId}:`)) {
        return true;
      }
    }
    return false;
  }
  const incidentKey = `${deviceId}:${timestamp}`;
  return engagedIncidents.has(incidentKey);
}

/**
 * Acknowledge an SOS alert
 * Stops alarm for this device and broadcasts acknowledgment
 * ✅ FIX: Now updates database to stop future notifications
 */
async function acknowledgeAlert(deviceId) {
  console.log("SOSAlertManager: Acknowledging alert for", deviceId);

  // Remove from active alerts
  activeSOSAlerts.delete(deviceId);
  await saveActiveAlerts();

  // Stop alarm + polling if no more active alerts
  if (activeSOSAlerts.size === 0) {
    await AlarmService.stopAlarm();
    stopResolvedPoll();
  }

  // ✅ Update database to mark SOS as resolved (prevents new notifications)
  // Set status to OFFLINE so DB triggers stop sending push notifications
  try {
    const { error } = await supabase
      .from("tracking_sessions")
      .update({ status: "OFFLINE" })
      .eq("device_id", deviceId)
      .eq("status", "SOS");

    if (error) {
      console.log("SOSAlertManager: Failed to update DB on acknowledge:", error);
    } else {
      console.log("SOSAlertManager: Database updated - no more notifications will be sent");
    }
  } catch (e) {
    console.log("SOSAlertManager: Error updating DB:", e);
  }

  // Broadcast acknowledgment to all fleet channels
  for (const [gid, ch] of realtimeChannels) {
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
 * Dismiss all alerts (stops alarm but doesn't broadcast)
 */
async function dismissAllAlerts() {
  console.log("SOSAlertManager: Dismissing all alerts");
  activeSOSAlerts.clear();
  await saveActiveAlerts();
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
 * Check if there are any active alerts
 */
function hasActiveAlerts() {
  return activeSOSAlerts.size > 0;
}

/**
 * Update group IDs (when user switches fleets or groups change)
 * Accepts single groupId (backwards compat) or array
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
  dismissAllAlerts,
  getActiveAlerts,
  hasActiveAlerts,
  updateGroup,
  setEngaged,  // ✅ Step 1: Track when guard enters Live View
  isEngaged,   // ✅ Step 1: Check if incident is already engaged
};

export default SOSAlertManager;

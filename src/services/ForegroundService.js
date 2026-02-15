// 📂 FILE: src/services/ForegroundService.js
// Manages foreground service with persistent notification for all-day background operation
// Prevents Android from killing the app and shows "SHIELD ACTIVE" notification

import { Platform } from "react-native";
import * as Notifications from "expo-notifications";
import * as TaskManager from "expo-task-manager";
import * as Location from "expo-location";

// ============================================
// CONFIGURATION
// ============================================

const FOREGROUND_NOTIFICATION_ID = "sentihnel-shield-active";
const LOCATION_TASK_NAME = "sentihnel-background-location";

let isServiceRunning = false;
let notificationIdentifier = null;

// ============================================
// NOTIFICATION CONFIGURATION
// ============================================

// Configure how notifications appear
Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowAlert: true,
    shouldPlaySound: false,
    shouldSetBadge: false,
    priority: Notifications.AndroidNotificationPriority.MAX,
  }),
});

// ============================================
// FOREGROUND SERVICE
// ============================================

/**
 * Start the foreground service with persistent notification
 * This keeps the app running in the background on Android
 */
async function startForegroundService() {
  if (isServiceRunning) {
    console.log("ForegroundService: Already running");
    return;
  }

  try {
    // Request notification permissions
    const { status: existingStatus } = await Notifications.getPermissionsAsync();
    let finalStatus = existingStatus;

    if (existingStatus !== "granted") {
      const { status } = await Notifications.requestPermissionsAsync();
      finalStatus = status;
    }

    if (finalStatus !== "granted") {
      console.warn("ForegroundService: Notification permission denied");
      // Continue anyway - service still works, just no notification
    }

    if (Platform.OS === "android") {
      // Create notification channel for foreground service (Android 8+)
      await Notifications.setNotificationChannelAsync("shield-active", {
        name: "Shield Active",
        importance: Notifications.AndroidImportance.MAX,
        sound: null, // No sound for persistent notification
        vibrationPattern: null,
        enableLights: false,
        enableVibrate: false,
        showBadge: false,
        lockscreenVisibility: Notifications.AndroidNotificationVisibility.PUBLIC,
        description: "Shows when SenTihNel protection is active",
      });

      // Show persistent foreground notification
      notificationIdentifier = await Notifications.scheduleNotificationAsync({
        identifier: FOREGROUND_NOTIFICATION_ID,
        content: {
          title: "🛡️ SENTIHNEL SHIELD ACTIVE",
          body: "Protection running - Location tracking enabled",
          data: { type: "foreground-service" },
          priority: Notifications.AndroidNotificationPriority.MAX,
          sticky: true,
          ongoing: true, // Makes notification persistent (can't be swiped away)
          sound: null,
          vibrate: null,
        },
        trigger: null, // Show immediately
      });

      console.log("✅ ForegroundService: Persistent notification shown");
    }

    isServiceRunning = true;
    console.log("✅ ForegroundService: Service started");
  } catch (error) {
    console.log("ForegroundService: Failed to start:", error);
  }
}

/**
 * Stop the foreground service and remove notification
 */
async function stopForegroundService() {
  if (!isServiceRunning) {
    console.log("ForegroundService: Not running");
    return;
  }

  try {
    // Cancel the persistent notification
    if (notificationIdentifier) {
      await Notifications.dismissNotificationAsync(notificationIdentifier);
      notificationIdentifier = null;
    }

    // Also try canceling by identifier (backup)
    await Notifications.dismissNotificationAsync(FOREGROUND_NOTIFICATION_ID);

    isServiceRunning = false;
    console.log("✅ ForegroundService: Service stopped");
  } catch (error) {
    console.log("ForegroundService: Failed to stop:", error);
  }
}

/**
 * Update the notification text (e.g., when SOS is active)
 */
async function updateNotification(title, body) {
  if (!isServiceRunning) return;

  try {
    if (Platform.OS === "android") {
      // Cancel old notification
      if (notificationIdentifier) {
        await Notifications.dismissNotificationAsync(notificationIdentifier);
      }

      // Show updated notification
      notificationIdentifier = await Notifications.scheduleNotificationAsync({
        identifier: FOREGROUND_NOTIFICATION_ID,
        content: {
          title: title || "🛡️ SENTIHNEL SHIELD ACTIVE",
          body: body || "Protection running - Location tracking enabled",
          data: { type: "foreground-service" },
          priority: Notifications.AndroidNotificationPriority.MAX,
          sticky: true,
          ongoing: true,
          sound: null,
          vibrate: null,
        },
        trigger: null,
      });

      console.log("✅ ForegroundService: Notification updated");
    }
  } catch (error) {
    console.log("ForegroundService: Failed to update notification:", error);
  }
}

/**
 * Check if service is currently running
 */
function isRunning() {
  return isServiceRunning;
}

// ============================================
// BACKGROUND LOCATION TASK (Optional - for extreme reliability)
// ============================================

/**
 * Background location task - runs even when app is killed
 * This is optional but provides extra reliability
 */
TaskManager.defineTask(LOCATION_TASK_NAME, async ({ data, error }) => {
  if (error) {
    console.log("BackgroundLocation: Error:", error);
    return;
  }

  if (data) {
    const { locations } = data;
    console.log("BackgroundLocation: Received locations:", locations?.length || 0);
    // Location updates are handled by LiveTracker - this just keeps the task alive
  }
});

/**
 * Start background location tracking (optional, for extreme reliability)
 * Only call this if you want location updates even when app is killed
 */
async function startBackgroundLocation() {
  try {
    // Check if task is already registered
    const isRegistered = await TaskManager.isTaskRegisteredAsync(LOCATION_TASK_NAME);
    if (isRegistered) {
      console.log("BackgroundLocation: Already registered");
      return;
    }

    // Start background location updates
    await Location.startLocationUpdatesAsync(LOCATION_TASK_NAME, {
      accuracy: Location.Accuracy.High,
      timeInterval: 30000, // Update every 30 seconds (battery-friendly)
      distanceInterval: 50, // Or when moved 50 meters
      foregroundService: {
        notificationTitle: "🛡️ SENTIHNEL SHIELD ACTIVE",
        notificationBody: "Protection running - Location tracking enabled",
        notificationColor: "#22c55e",
      },
      pausesUpdatesAutomatically: false,
      showsBackgroundLocationIndicator: true,
    });

    console.log("✅ BackgroundLocation: Task registered");
  } catch (error) {
    console.log("BackgroundLocation: Failed to start:", error);
  }
}

/**
 * Stop background location tracking
 */
async function stopBackgroundLocation() {
  try {
    const isRegistered = await TaskManager.isTaskRegisteredAsync(LOCATION_TASK_NAME);
    if (isRegistered) {
      await Location.stopLocationUpdatesAsync(LOCATION_TASK_NAME);
      console.log("✅ BackgroundLocation: Task unregistered");
    }
  } catch (error) {
    console.log("BackgroundLocation: Failed to stop:", error);
  }
}

// ============================================
// EXPORTS
// ============================================

export const ForegroundService = {
  startForegroundService,
  stopForegroundService,
  updateNotification,
  isRunning,
  startBackgroundLocation, // Optional - for extreme reliability
  stopBackgroundLocation,
};

export default ForegroundService;

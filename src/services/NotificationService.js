// 📂 FILE: src/services/NotificationService.js
// Handles push notification registration and handling for SOS alerts
// Works on both iOS and Android

import * as Notifications from "expo-notifications";
import * as Device from "expo-device";
import Constants from "expo-constants";
import { Platform } from "react-native";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { supabase } from "../lib/supabase";

// Get project ID from app.json/app.config.js (EAS project id)
const PROJECT_ID = Constants.expoConfig?.extra?.eas?.projectId;

// ============================================
// CONFIGURATION
// ============================================

const PUSH_TOKEN_KEY = "sentinel_push_token";

/**
 * ✅ IMPORTANT:
 * This channel ID MUST match what your Edge Function sends in `channelId`.
 * Your Edge Function uses: "sos_alerts" (underscore), so we use the same.
 */
const SOS_CHANNEL_ID = "sos_alerts";

// ============================================
// NOTIFICATION HANDLER SETUP
// ============================================

// Configure how notifications appear when app is in foreground
Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowAlert: true,
    shouldPlaySound: true,
    shouldSetBadge: true,
    priority: Notifications.AndroidNotificationPriority.MAX,
  }),
});

// ============================================
// CHANNEL SETUP (Android)
// ============================================

/**
 * Create Android notification channel for SOS alerts
 * High importance = sound + vibration + heads-up display
 *
 * ✅ Custom sound notes:
 * - Your file must be here:
 *   android/app/src/main/res/raw/alarm.mp3
 * - You must reference it by RESOURCE NAME (no extension):
 *   sound: "alarm"
 *
 * ⚠️ Android channels are cached by the OS.
 * If you change sound/importance, uninstall the app and reinstall.
 */
async function setupNotificationChannel() {
  if (Platform.OS !== "android") return;

  await Notifications.setNotificationChannelAsync(SOS_CHANNEL_ID, {
    name: "SOS Alerts",
    description: "Emergency alerts when a fleet member triggers SOS",
    importance: Notifications.AndroidImportance.MAX,
    vibrationPattern: [0, 500, 200, 500, 200, 500],
    lightColor: "#FF0000",
    lockscreenVisibility: Notifications.AndroidNotificationVisibility.PUBLIC,
    bypassDnd: true, // Bypass Do Not Disturb
    sound: "alarm", // ✅ Resource name (android/app/src/main/res/raw/alarm.mp3)
  });

  console.log("NotificationService: Android channel created");
}

// ============================================
// PERMISSION & TOKEN REGISTRATION
// ============================================

/**
 * Request notification permissions and get push token
 * Returns the Expo push token or null if failed
 */
async function registerForPushNotifications() {
  // Must be a physical device
  if (!Device.isDevice) {
    console.log("NotificationService: Push notifications require physical device");
    return null;
  }

  // Setup Android channel first
  await setupNotificationChannel();

  // Check existing permissions
  const { status: existingStatus } = await Notifications.getPermissionsAsync();
  let finalStatus = existingStatus;

  // Request if not granted
  if (existingStatus !== "granted") {
    const { status } = await Notifications.requestPermissionsAsync({
      ios: {
        allowAlert: true,
        allowBadge: true,
        allowSound: true,
        // NOTE: "critical alerts" typically requires Apple entitlement/approval
        allowCriticalAlerts: true,
      },
    });
    finalStatus = status;
  }

  if (finalStatus !== "granted") {
    console.log("NotificationService: Permission not granted");
    return null;
  }

  // Get Expo push token
  try {
    if (!PROJECT_ID) {
      console.log(
        "NotificationService: Missing EAS projectId (Constants.expoConfig.extra.eas.projectId). Push token may fail in Dev Client."
      );
    }

    const tokenData = await Notifications.getExpoPushTokenAsync(
      PROJECT_ID ? { projectId: PROJECT_ID } : undefined
    );

    const token = tokenData?.data;
    console.log("NotificationService: Push token:", token);

    if (!token) return null;

    // Store locally
    await AsyncStorage.setItem(PUSH_TOKEN_KEY, token);

    return token;
  } catch (e) {
    console.log("NotificationService: Failed to get push token", e);
    return null;
  }
}

/**
 * Save push token to Supabase for this device
 * Links token to device_id and group_id for targeted notifications
 */
async function savePushTokenToSupabase(token, deviceId, groupId) {
  if (!token || !deviceId || !groupId) {
    console.log("NotificationService: Missing token, deviceId, or groupId");
    return false;
  }

  try {
    // Get current user
    const {
      data: { user },
    } = await supabase.auth.getUser();
    const userId = user?.id || null;

    // Upsert to push_tokens table
    const { error } = await supabase.from("push_tokens").upsert(
      {
        device_id: deviceId,
        group_id: groupId,
        user_id: userId,
        push_token: token,
        platform: Platform.OS,
        updated_at: new Date().toISOString(),
      },
      {
        onConflict: "device_id",
      }
    );

    if (error) {
      console.log("NotificationService: Failed to save token", error);
      return false;
    }

    console.log("NotificationService: Token saved to Supabase");
    return true;
  } catch (e) {
    console.log("NotificationService: Error saving token", e);
    return false;
  }
}

/**
 * Remove push token from Supabase (on logout or leave fleet)
 */
async function removePushToken(deviceId) {
  try {
    await supabase.from("push_tokens").delete().eq("device_id", deviceId);

    await AsyncStorage.removeItem(PUSH_TOKEN_KEY);
    console.log("NotificationService: Token removed");
  } catch (e) {
    console.log("NotificationService: Error removing token", e);
  }
}

// ============================================
// LOCAL NOTIFICATIONS
// ============================================

/**
 * Show a local SOS notification immediately
 * Used when receiving SOS via realtime while app is in foreground/background
 */
async function showSOSNotification(senderName, sosData = {}) {
  try {
    await Notifications.scheduleNotificationAsync({
      content: {
        title: "🚨 SOS ALERT",
        body: `${senderName || "A fleet member"} needs help!`,
        data: {
          type: "sos",
          ...sosData,
        },
        sound: true,
        priority: Notifications.AndroidNotificationPriority.MAX,
        vibrate: [0, 500, 200, 500, 200, 500],
        ...(Platform.OS === "android" ? { channelId: SOS_CHANNEL_ID } : {}),
      },
      trigger: null, // Show immediately
    });
    console.log("NotificationService: SOS notification shown");
  } catch (e) {
    console.log("NotificationService: Failed to show notification", e);
  }
}

/**
 * Show SOS cancelled notification
 */
async function showSOSCancelledNotification(senderName) {
  try {
    await Notifications.scheduleNotificationAsync({
      content: {
        title: "SOS Cancelled",
        body: `${senderName || "Fleet member"}'s emergency has been resolved`,
        data: { type: "sos_cancel" },
        sound: false,
        ...(Platform.OS === "android" ? { channelId: SOS_CHANNEL_ID } : {}),
      },
      trigger: null,
    });
  } catch (e) {
    console.log("NotificationService: Failed to show cancel notification", e);
  }
}

/**
 * Clear all SOS notifications
 */
async function clearAllNotifications() {
  await Notifications.dismissAllNotificationsAsync();
}

// ============================================
// NOTIFICATION LISTENERS
// ============================================

/**
 * Add listener for when notification is received while app is foregrounded
 * Returns subscription object - call .remove() to unsubscribe
 */
function addNotificationReceivedListener(callback) {
  return Notifications.addNotificationReceivedListener(callback);
}

/**
 * Add listener for when user taps on notification
 * Returns subscription object - call .remove() to unsubscribe
 */
function addNotificationResponseListener(callback) {
  return Notifications.addNotificationResponseReceivedListener(callback);
}

/**
 * Get the notification that was used to open the app (if any)
 */
async function getInitialNotification() {
  return await Notifications.getLastNotificationResponseAsync();
}

// ============================================
// EXPORTS
// ============================================

export const NotificationService = {
  registerForPushNotifications,
  savePushTokenToSupabase,
  removePushToken,
  showSOSNotification,
  showSOSCancelledNotification,
  clearAllNotifications,
  addNotificationReceivedListener,
  addNotificationResponseListener,
  getInitialNotification,
  SOS_CHANNEL_ID,
};

export default NotificationService;


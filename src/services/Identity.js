// 📂 FILE: src/services/Identity.js
// ✅ SINGLE SOURCE OF TRUTH FOR DEVICE IDENTITY (stable + persistent)

import { Platform } from "react-native";
import AsyncStorage from "@react-native-async-storage/async-storage";
import Constants from "expo-constants";
import * as Application from "expo-application";

const KEY = "sentinel_device_id";

/**
 * Returns a stable device identifier.
 * Priority:
 * 1) OS-native ID (Android ID / iOS vendor ID)
 * 2) Expo installation ID (if available)
 * 3) Persistent locally generated ID (fallback)
 */
export async function getDeviceId() {
  // 1️⃣ Best: platform-native stable IDs
  try {
    if (Platform.OS === "android") {
      const androidId = await Application.getAndroidId();
      if (androidId) return `android:${androidId}`;
    }

    if (Platform.OS === "ios") {
      const iosId = await Application.getIosIdForVendorAsync();
      if (iosId) return `ios:${iosId}`;
    }
  } catch (err) {
    console.log("Device native ID unavailable:", err?.message);
  }

  // 2️⃣ Expo installationId (sometimes present depending on SDK/build)
  const expoInstallId =
    Constants?.installationId ||
    Constants?.expoConfig?.extra?.installationId ||
    null;

  if (expoInstallId) {
    return `expo:${expoInstallId}`;
  }

  // 3️⃣ Fallback: persistent locally generated ID
  try {
    let storedId = await AsyncStorage.getItem(KEY);

    if (!storedId) {
      const random =
        globalThis.crypto?.randomUUID?.() ||
        `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

      storedId = `local:${random}`;
      await AsyncStorage.setItem(KEY, storedId);
    }

    return storedId;
  } catch (e) {
    console.error("Error creating/storing device ID", e);
    // absolute last-resort fallback (should be rare)
    return `local:${Date.now()}-fallback`;
  }
}

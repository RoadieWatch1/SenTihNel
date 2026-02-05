// 📂 FILE: src/services/FloatingSOSButton.js
// Floating SOS button that appears over other apps when SenTihNel is in the background.
// Android only - uses SYSTEM_ALERT_WINDOW permission.

import { NativeModules, NativeEventEmitter, Platform } from "react-native";

const { FloatingSOSModule } = NativeModules;

// Only available on Android with the native module installed
const isAvailable = Platform.OS === "android" && !!FloatingSOSModule;

const eventEmitter = isAvailable ? new NativeEventEmitter(FloatingSOSModule) : null;

export const FloatingSOSButton = {
  isAvailable,

  /**
   * Check if "Draw Over Other Apps" permission is granted
   */
  checkPermission: async () => {
    if (!isAvailable) return false;
    try {
      return await FloatingSOSModule.checkPermission();
    } catch {
      return false;
    }
  },

  /**
   * Open system settings to grant overlay permission
   * Returns false (user must grant manually), or true if already granted
   */
  requestPermission: async () => {
    if (!isAvailable) return false;
    try {
      return await FloatingSOSModule.requestPermission();
    } catch {
      return false;
    }
  },

  /**
   * Show the floating SOS button overlay
   * Returns false if permission not granted
   */
  start: async () => {
    if (!isAvailable) return false;
    try {
      return await FloatingSOSModule.startFloating();
    } catch {
      return false;
    }
  },

  /**
   * Hide the floating SOS button overlay
   */
  stop: async () => {
    if (!isAvailable) return false;
    try {
      return await FloatingSOSModule.stopFloating();
    } catch {
      return false;
    }
  },

  /**
   * Check if the floating button service is currently running
   */
  isRunning: async () => {
    if (!isAvailable) return false;
    try {
      return await FloatingSOSModule.isRunning();
    } catch {
      return false;
    }
  },

  /**
   * Check and clear the SOS trigger flag (backup mechanism)
   * Returns true if SOS was triggered from the floating button
   */
  checkSOSFlag: async () => {
    if (!isAvailable) return false;
    try {
      return await FloatingSOSModule.checkSOSFlag();
    } catch {
      return false;
    }
  },

  /**
   * Listen for SOS trigger events from the floating button
   * Returns subscription object - call .remove() to unsubscribe
   */
  addSOSTriggerListener: (callback) => {
    if (!eventEmitter) return { remove: () => {} };
    return eventEmitter.addListener("FloatingSOSTrigger", callback);
  },
};

export default FloatingSOSButton;

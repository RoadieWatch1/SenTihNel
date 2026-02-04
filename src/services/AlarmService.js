// 📂 FILE: src/services/AlarmService.js
// Handles loud alarm sounds and vibration for SOS alerts
// Works on both iOS and Android

import { Audio } from "expo-av";
import { Vibration, Platform } from "react-native";

// ============================================
// CONFIGURATION
// ============================================

// Vibration pattern: [wait, vibrate, wait, vibrate, ...]
// Android: milliseconds array
// iOS: only first value matters (will vibrate once per call)
const VIBRATION_PATTERN = [0, 500, 200, 500, 200, 500, 200, 500];
const VIBRATION_REPEAT = true;

// Alarm will loop until stopped
const ALARM_LOOP = true;

// ============================================
// STATE
// ============================================

let alarmSound = null;
let isAlarmPlaying = false;
let vibrationInterval = null;

// ============================================
// ALARM FUNCTIONS
// ============================================

/**
 * Initialize audio settings for alarm playback
 * Must be called before playing alarm
 */
async function initAudio() {
  try {
    await Audio.setAudioModeAsync({
      allowsRecordingIOS: false,
      playsInSilentModeIOS: true, // CRITICAL: Play even in silent mode
      staysActiveInBackground: true, // Keep playing in background
      shouldDuckAndroid: false, // Don't lower other audio
      playThroughEarpieceAndroid: false, // Use speaker, not earpiece
    });
  } catch (e) {
    console.log("AlarmService: Failed to init audio mode", e);
  }
}

/**
 * Start the SOS alarm - loud sound + vibration
 * Call this when an SOS is received
 */
async function startAlarm() {
  if (isAlarmPlaying) {
    console.log("AlarmService: Alarm already playing");
    return;
  }

  console.log("🚨 AlarmService: Starting SOS alarm");
  isAlarmPlaying = true;

  // Initialize audio mode
  await initAudio();

  // Start vibration
  startVibration();

  // Load and play alarm sound
  try {
    // Unload any existing sound
    if (alarmSound) {
      try {
        await alarmSound.unloadAsync();
      } catch (_) {}
      alarmSound = null;
    }

    // Try to load custom alarm sound, fall back to bundled asset
    let soundSource;
    try {
      // Try custom alarm.mp3 first
      soundSource = require("../../assets/alarm.mp3");
    } catch (_) {
      // No custom sound - will rely on vibration only
      console.log("AlarmService: No alarm.mp3 found, using vibration only");
      soundSource = null;
    }

    if (soundSource) {
      // Load the alarm sound
      const { sound } = await Audio.Sound.createAsync(soundSource, {
        shouldPlay: true,
        isLooping: ALARM_LOOP,
        volume: 1.0,
      });

      alarmSound = sound;

      // Set up playback status listener
      alarmSound.setOnPlaybackStatusUpdate((status) => {
        if (status.didJustFinish && !status.isLooping) {
          // Sound finished and not looping
          isAlarmPlaying = false;
        }
      });

      console.log("🔊 AlarmService: Alarm sound playing");
    }
  } catch (e) {
    console.log("AlarmService: Failed to play alarm sound", e);
    // Continue with vibration even if sound fails
  }
}

/**
 * Stop the SOS alarm - stops sound and vibration
 * Call this when SOS is acknowledged or cancelled
 */
async function stopAlarm() {
  console.log("🔕 AlarmService: Stopping SOS alarm");
  isAlarmPlaying = false;

  // Stop vibration
  stopVibration();

  // Stop and unload sound
  if (alarmSound) {
    try {
      await alarmSound.stopAsync();
      await alarmSound.unloadAsync();
    } catch (e) {
      console.log("AlarmService: Error stopping sound", e);
    }
    alarmSound = null;
  }
}

/**
 * Start continuous vibration pattern
 */
function startVibration() {
  // Stop any existing vibration
  stopVibration();

  if (Platform.OS === "android") {
    // Android supports pattern with repeat
    Vibration.vibrate(VIBRATION_PATTERN, VIBRATION_REPEAT);
  } else {
    // iOS: vibrate repeatedly using interval
    Vibration.vibrate();
    vibrationInterval = setInterval(() => {
      if (isAlarmPlaying) {
        Vibration.vibrate();
      } else {
        stopVibration();
      }
    }, 1000);
  }
}

/**
 * Stop vibration
 */
function stopVibration() {
  Vibration.cancel();
  if (vibrationInterval) {
    clearInterval(vibrationInterval);
    vibrationInterval = null;
  }
}

/**
 * Check if alarm is currently playing
 */
function isPlaying() {
  return isAlarmPlaying;
}

/**
 * Play a short alert sound (for notifications)
 */
async function playAlertSound() {
  try {
    await initAudio();

    let soundSource;
    try {
      soundSource = require("../../assets/alarm.mp3");
    } catch (_) {
      // No custom sound available
      Vibration.vibrate([0, 200, 100, 200]);
      return;
    }

    const { sound } = await Audio.Sound.createAsync(soundSource, {
      shouldPlay: true,
      isLooping: false,
      volume: 1.0,
    });

    // Auto-unload when done
    sound.setOnPlaybackStatusUpdate((status) => {
      if (status.didJustFinish) {
        sound.unloadAsync();
      }
    });
  } catch (e) {
    console.log("AlarmService: Failed to play alert sound", e);
    // Fall back to vibration
    Vibration.vibrate([0, 200, 100, 200]);
  }
}

// ============================================
// EXPORTS
// ============================================

export const AlarmService = {
  startAlarm,
  stopAlarm,
  isPlaying,
  playAlertSound,
  startVibration,
  stopVibration,
};

export default AlarmService;

// 📂 FILE: src/components/FakeLockScreen.js
import React, { useEffect, useRef, useState } from "react";
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  Dimensions,
  Vibration,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { cancelBatSignal } from "../services/BatSignal";
import { supabase } from "../lib/supabase";

// Prefer SecureStore for PIN hash (encrypted on device); fall back to AsyncStorage
let SecureStore = null;
try {
  SecureStore = require("expo-secure-store");
} catch {}

const PIN_KEY = "sentinel_pin_hash";

async function readPinHash() {
  // Try SecureStore first
  if (SecureStore?.getItemAsync) {
    try {
      const v = await SecureStore.getItemAsync(PIN_KEY);
      if (v) return v;
    } catch {}
  }
  // Fall back to AsyncStorage (also migrates on next write)
  try {
    return await AsyncStorage.getItem(PIN_KEY);
  } catch {}
  return null;
}

async function writePinHash(hash) {
  // Write to SecureStore (primary) + AsyncStorage (fallback)
  if (SecureStore?.setItemAsync) {
    try { await SecureStore.setItemAsync(PIN_KEY, hash); } catch {}
  }
  try { await AsyncStorage.setItem(PIN_KEY, hash); } catch {}
}

const { width } = Dimensions.get("window");

// Simple hash function (must match fleet.js)
const hashPin = (pin) => {
  let hash = 0;
  const str = String(pin || "");
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash;
  }
  return `pin_${Math.abs(hash).toString(16).padStart(8, '0')}`;
};

// ✅ Hard timeout so UI never gets stuck
// ✅ FIX: Increased from 4000 to 6000ms to give broadcast cancel time to reach fleet
const CANCEL_TIMEOUT_MS = 6000;
// ✅ FIX: Increased from 3000 to 8000ms — during SOS the network is saturated
// (video streaming, GPS syncs, cloud recording) so RPC needs more time
const PIN_VERIFY_TIMEOUT_MS = 8000;

export default function FakeLockScreen({ onUnlock }) {
  const [pin, setPin] = useState("");
  const [message, setMessage] = useState("Enter PIN");
  const [attempts, setAttempts] = useState(0);
  const [isCancelling, setIsCancelling] = useState(false);

  // ✅ Avoid setState after unmount when onUnlock navigates away
  const mountedRef = useRef(true);
  const verifyingRef = useRef(false); // Prevent duplicate verifyPin calls
  useEffect(() => {
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // ✅ Brief "SOS Sent" confirmation so user knows the alert went through
  useEffect(() => {
    setMessage("SOS Sent — Enter PIN to cancel");
    const timer = setTimeout(() => {
      if (mountedRef.current) setMessage("Enter PIN");
    }, 2500);
    return () => clearTimeout(timer);
  }, []);

  const safeSet = (fn) => {
    if (mountedRef.current) fn();
  };

  const withTimeout = (promise, ms) => {
    return Promise.race([
      promise,
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("timeout")), ms)
      ),
    ]);
  };

  const handlePress = (num) => {
    if (isCancelling || verifyingRef.current) return;

    if (pin.length < 4) {
      const newPin = pin + num;
      setPin(newPin);

      // Auto-verify when 4 digits are entered
      if (newPin.length === 4) {
        verifyPin(newPin);
      }
    }
  };

  const handleBackspace = () => {
    if (isCancelling || verifyingRef.current) return;
    setPin(pin.slice(0, -1));
  };

  const doUnlock = async () => {
    // ✅ Show unlocking state immediately
    safeSet(() => {
      setIsCancelling(true);
      setMessage("Unlocking...");
      setPin("");
      setAttempts(0);
    });

    // ✅ Best-effort cancel SOS, but NEVER block unlock forever
    try {
      await withTimeout(cancelBatSignal(), CANCEL_TIMEOUT_MS);
    } catch (e) {
      console.log("⚠️ SOS cancel timed out/failed (non-fatal):", e?.message || e);
    }

    // ✅ Always return to normal app UI — this is the critical call
    try {
      if (typeof onUnlock === "function") onUnlock();
    } catch (e) {
      console.log("⚠️ onUnlock error:", e?.message || e);
    }
  };

  const verifyPin = async (inputPin) => {
    // Prevent duplicate concurrent calls
    if (isCancelling || verifyingRef.current) return;
    verifyingRef.current = true;

    safeSet(() => setMessage("Verifying..."));

    // Verify PIN against server, then local cache. No hardcoded fallbacks.
    let isValid = false;

    try {
      const hashed = hashPin(inputPin);
      const { data, error } = await withTimeout(
        supabase.rpc("verify_user_sos_pin", { p_pin_hash: hashed }),
        PIN_VERIFY_TIMEOUT_MS
      );

      if (!error && data?.valid === true) {
        isValid = true;
        // Cache PIN hash locally (SecureStore + AsyncStorage) for offline use
        await writePinHash(hashed);
      }
      // If "No PIN set" server-side, stay locked (user must set a PIN from fleet screen)
    } catch (e) {
      console.log("PIN verification error (falling back to local/cloud cache):", e?.message || e);
      const hashed = hashPin(inputPin);

      // 1) Check local cache first (fastest)
      let cachedHash = await readPinHash();

      // 2) If local cache is empty (reinstall), try pulling PIN hash from cloud
      if (!cachedHash) {
        try {
          const { data: pinRow } = await withTimeout(
            supabase.from("user_sos_pins").select("pin_hash").limit(1).maybeSingle(),
            5000
          );
          if (pinRow?.pin_hash) {
            cachedHash = pinRow.pin_hash;
            // Restore to local storage for future offline use
            await writePinHash(cachedHash);
            console.log("✅ PIN hash restored from cloud during SOS verify fallback");
          }
        } catch (fetchErr) {
          console.log("PIN cloud fetch also failed:", fetchErr?.message || fetchErr);
        }
      }

      if (cachedHash && cachedHash === hashed) {
        isValid = true;
      }
      // No cached PIN + no server = stay locked (safe default)
    }

    if (isValid) {
      // ✅ SUCCESS: Unlock immediately, don't let anything block it
      verifyingRef.current = false;
      await doUnlock();
      return;
    }

    // ❌ FAILURE
    verifyingRef.current = false;
    Vibration.vibrate(400);

    const nextAttempts = attempts + 1;

    safeSet(() => {
      setMessage("Incorrect PIN");
      setPin("");
      setAttempts(nextAttempts);
    });

    if (nextAttempts >= 3) {
      safeSet(() => setMessage("Try again in 30 seconds"));
    } else {
      setTimeout(() => {
        safeSet(() => setMessage("Enter PIN"));
      }, 2000);
    }
  };

  // Render the 4 dots
  const renderDots = () => (
    <View style={styles.dotContainer}>
      {[...Array(4)].map((_, i) => (
        <View key={i} style={[styles.dot, i < pin.length && styles.filledDot]} />
      ))}
    </View>
  );

  // Render a single number key
  const renderKey = (num) => (
    <TouchableOpacity
      key={num}
      onPress={() => handlePress(num)}
      style={[styles.key, isCancelling && styles.keyDisabled]}
      activeOpacity={0.8}
      disabled={isCancelling}
    >
      <Text style={styles.keyText}>{num}</Text>
    </TouchableOpacity>
  );

  return (
    <View style={styles.container}>
      {/* Top Section: Message & Dots */}
      <View style={styles.displayArea}>
        <Text style={styles.message}>{message}</Text>
        {renderDots()}
      </View>

      {/* Bottom Section: Keypad */}
      <View style={styles.keypad}>
        <View style={styles.row}>{[1, 2, 3].map(renderKey)}</View>
        <View style={styles.row}>{[4, 5, 6].map(renderKey)}</View>
        <View style={styles.row}>{[7, 8, 9].map(renderKey)}</View>
        <View style={styles.row}>
          <TouchableOpacity
            onPress={() => {
              if (pin.length === 4 && !verifyingRef.current) verifyPin(pin);
            }}
            style={[
              styles.key,
              pin.length === 4 ? styles.submitKey : styles.submitKeyDisabled,
              (isCancelling || verifyingRef.current) && styles.keyDisabled,
            ]}
            activeOpacity={0.8}
            disabled={isCancelling || pin.length < 4}
          >
            <Ionicons name="checkmark-circle-outline" size={32} color={pin.length === 4 ? "#4CAF50" : "rgba(255,255,255,0.3)"} />
          </TouchableOpacity>
          {renderKey(0)}
          <TouchableOpacity
            onPress={handleBackspace}
            style={[styles.key, isCancelling && styles.keyDisabled]}
            activeOpacity={0.8}
            disabled={isCancelling}
          >
            <Ionicons name="backspace-outline" size={28} color="white" />
          </TouchableOpacity>
        </View>
      </View>

      {/* PIN is now user-specific, no hint shown */}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.95)",
    justifyContent: "center",
    alignItems: "center",
  },
  displayArea: { alignItems: "center", marginBottom: 50 },
  message: { color: "white", fontSize: 20, marginBottom: 20, fontWeight: "500" },
  dotContainer: { flexDirection: "row", gap: 20 },
  dot: { width: 15, height: 15, borderRadius: 10, borderWidth: 1, borderColor: "white" },
  filledDot: { backgroundColor: "white" },
  keypad: { width: width * 0.8 },
  row: { flexDirection: "row", justifyContent: "space-between", marginBottom: 20 },
  key: {
    width: 75,
    height: 75,
    borderRadius: 40,
    backgroundColor: "rgba(255,255,255,0.15)",
    justifyContent: "center",
    alignItems: "center",
  },
  keyDisabled: {
    opacity: 0.6,
  },
  keyText: { color: "white", fontSize: 28, fontWeight: "400" },
  submitKey: {
    backgroundColor: "rgba(76, 175, 80, 0.25)",
    borderWidth: 1,
    borderColor: "rgba(76, 175, 80, 0.5)",
  },
  submitKeyDisabled: {
    backgroundColor: "rgba(255,255,255,0.05)",
  },
});

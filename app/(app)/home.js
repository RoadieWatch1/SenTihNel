// 📂 FILE: app/(app)/home.js
import React, { useEffect, useRef, useState } from "react";
import { View, Text, TouchableOpacity, StatusBar, StyleSheet, BackHandler, Platform } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { useNavigation } from "@react-navigation/native";
import { Ionicons } from "@expo/vector-icons"; // ✅ Added Icon Import

// --- Imports ---
import WakeWordListener from "../../src/components/WakeWordListener";
import StealthStreamer from "../../src/components/StealthStreamer";
import { sendBatSignal, registerForBatSignal, cancelBatSignal } from "../../src/services/BatSignal";
import FakeLockScreen from "../../src/components/FakeLockScreen";
import { startLiveTracking } from "../../src/services/LiveTracker";

// ✅ Must match Auth + LiveTracker key
const STORAGE_KEY_DEVICE_ID = "sentinel_device_id";

// ✅ Constants for Hidden Cancel Gesture
const STORAGE_KEY_SOS = "sentinel_sos_active";
const TAP_WINDOW_MS = 3000;
const TAP_TARGET = 7;

export default function HomePage() {
  const navigation = useNavigation();

  const [isSOS, setIsSOS] = useState(false);
  const [deviceId, setDeviceId] = useState("Loading...");

  const bootedRef = useRef(false);
  const sosLockRef = useRef(false);

  // ✅ Hidden Tap State
  const [tapCount, setTapCount] = useState(0);
  const tapStartRef = useRef(0);

  useEffect(() => {
    if (bootedRef.current) return;
    bootedRef.current = true;

    (async () => {
      // 1) Get device_id (Auth should set it)
      const storedId = await AsyncStorage.getItem(STORAGE_KEY_DEVICE_ID);

      // Failsafe: if missing, create a local id so app can still run
      const finalId =
        storedId || `Device-${Math.random().toString(36).slice(2, 10).toUpperCase()}`;

      if (!storedId) {
        await AsyncStorage.setItem(STORAGE_KEY_DEVICE_ID, finalId);
      }

      setDeviceId(finalId);

      // 2) Start LiveTracker (NOTE: if user is not logged in, RLS will block DB writes — that's okay for now)
      try {
        await startLiveTracking(finalId);
      } catch (e) {
        console.log("Tracker start warning:", e?.message || e);
      }

      // 3) Register bat signal listener
      registerForBatSignal();
    })();
  }, []);

  // ✅ Lock Android back button during SOS
  useEffect(() => {
    const backAction = () => {
      if (isSOS) return true;
      return false;
    };

    const sub = BackHandler.addEventListener("hardwareBackPress", backAction);
    return () => sub.remove();
  }, [isSOS]);

  const triggerSOS = () => {
    if (deviceId === "Loading...") return;
    if (sosLockRef.current) return;

    sosLockRef.current = true;

    console.log("⚠️ SILENT ALARM TRIGGERED");
    sendBatSignal(deviceId);
    setIsSOS(true);

    setTimeout(() => {
      sosLockRef.current = false;
    }, 1200);
  };

  const disarmSOS = () => setIsSOS(false);

  const openDrawer = () => {
    // Safe open drawer call (works with expo-router/drawer)
    try {
      navigation.openDrawer();
    } catch (e) {
      console.log("Drawer open warning:", e?.message || e);
    }
  };

  // ✅ Hidden Cancel Handler
  const handleHiddenCancelTap = async () => {
    const now = Date.now();

    // Start/reset the tap window
    if (!tapStartRef.current || now - tapStartRef.current > TAP_WINDOW_MS) {
      tapStartRef.current = now;
      setTapCount(1);
      return;
    }

    // Continue counting taps within the window
    const next = tapCount + 1;
    setTapCount(next);

    if (next >= TAP_TARGET) {
      tapStartRef.current = 0;
      setTapCount(0);

      console.log("🕵️ HIDDEN GESTURE DETECTED: Checking SOS status...");

      // Only cancel if SOS is actually active (prevents accidental triggers)
      const sosVal = await AsyncStorage.getItem(STORAGE_KEY_SOS);
      const sosOn = sosVal === "1";
      if (!sosOn) {
        console.log("🕵️ SOS not active, ignoring gesture.");
        return;
      }

      await cancelBatSignal();
    }
  };

  return (
    <View style={{ flex: 1, backgroundColor: "#0f172a" }}>
      <StatusBar barStyle="light-content" hidden={isSOS} />

      {/* ✅ UPDATED MENU BUTTON (New Pro Style) */}
      {!isSOS && (
        <TouchableOpacity
          onPress={openDrawer}
          style={{
            position: "absolute",
            top: 50,
            left: 18,
            zIndex: 100,
            padding: 12,                 // BIG tap target
            borderRadius: 20,
            backgroundColor: "rgba(255,255,255,0.08)", // subtle visibility
            marginLeft: 6,
          }}
          activeOpacity={0.7}
        >
          <Ionicons
            name="menu"
            size={28}                    // bigger than before
            color="#e5e7eb"              // light gray / near white
          />
        </TouchableOpacity>
      )}

      {/* Always-on stealth uplink */}
      {deviceId !== "Loading..." && <StealthStreamer channelId={deviceId} />}

      {isSOS ? (
        <View style={styles.fullScreen}>
          <FakeLockScreen onUnlock={disarmSOS} />
        </View>
      ) : (
        <SafeAreaView style={styles.container}>
          <WakeWordListener onTrigger={triggerSOS} />

          {/* ✅ Hidden Cancel Button (7 taps on Header) */}
          <TouchableOpacity activeOpacity={1} onPress={handleHiddenCancelTap}>
            <Text style={styles.title}>Device Health</Text>
          </TouchableOpacity>

          <View style={styles.statusBox}>
            <Text style={styles.statusLabel}>SYSTEM STATUS</Text>
            <Text style={[styles.statusValue, { color: "#facc15" }]}>ACTION REQUIRED</Text>
            <Text style={styles.statusSub}>System Update Available</Text>
            <Text style={styles.idText}>ID: {deviceId}</Text>
          </View>

          <TouchableOpacity onPress={triggerSOS} style={styles.diagnosticBtn}>
            <Text style={styles.diagnosticText}>Download & Install</Text>
          </TouchableOpacity>

          <Text style={styles.microHint}>
            {Platform.OS === "android" ? "Tip: voice trigger is active." : "Tip: keep app running for best protection."}
          </Text>
        </SafeAreaView>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  // drawerButtonWrap removed (replaced with inline styles above)

  container: { flex: 1, backgroundColor: "#0f172a", alignItems: "center", justifyContent: "center" },
  title: { color: "white", fontSize: 32, fontWeight: "600", marginBottom: 40 },

  statusBox: { alignItems: "center", marginBottom: 40 },
  statusLabel: { color: "#94a3b8", fontSize: 14, letterSpacing: 2 },
  statusValue: { fontSize: 36, fontWeight: "bold", marginTop: 5 },
  statusSub: { color: "#cbd5e1", marginTop: 8, fontSize: 16 },
  idText: { color: "#475569", marginTop: 10, fontSize: 14, fontWeight: "bold" },

  diagnosticBtn: {
    backgroundColor: "#3b82f6",
    paddingHorizontal: 40,
    paddingVertical: 15,
    borderRadius: 8,
    width: "85%",
    alignItems: "center",
  },
  diagnosticText: { color: "white", fontSize: 16, fontWeight: "600" },

  microHint: { color: "#334155", marginTop: 18, fontSize: 12 },

  fullScreen: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: "black",
    zIndex: 99,
  },
});
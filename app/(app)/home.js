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
  Vibration,
  Alert,
  AppState,
  Modal,
  Pressable,
} from "react-native";
import NetInfo from "@react-native-community/netinfo";
import { SafeAreaView } from "react-native-safe-area-context";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { useNavigation } from "@react-navigation/native";
import { useRouter } from "expo-router";
import { Ionicons } from "@expo/vector-icons";

import * as Location from "expo-location";
import { Camera } from "expo-camera";

import WakeWordListener from "../../src/components/WakeWordListener";
import StealthStreamer from "../../src/components/StealthStreamer";
import {
  sendBatSignal,
  registerForBatSignal,
  cancelBatSignal,
  sendCheckIn,
} from "../../src/services/BatSignal";
import FakeLockScreen from "../../src/components/FakeLockScreen";
import { startLiveTracking } from "../../src/services/LiveTracker";
import { getDeviceId as getStableDeviceId } from "../../src/services/Identity";
import { supabase } from "../../src/lib/supabase";
import FloatingSOSButton from "../../src/services/FloatingSOSButton";
import { colors, font, radius, space } from "../../src/theme";

let SecureStore = null;
try { SecureStore = require("expo-secure-store"); } catch {}

const STORAGE_KEY_DEVICE_ID = "sentinel_device_id";
const STORAGE_KEY_SOS = "sentinel_sos_active";
const TAP_WINDOW_MS = 3000;
const TAP_TARGET = 7;

function isGranted(status) {
  return String(status || "").toLowerCase() === "granted";
}

export default function HomePage() {
  const navigation = useNavigation();
  const router = useRouter();

  const [isSOS, setIsSOS] = useState(false);
  const [deviceId, setDeviceId] = useState("Loading...");
  const [wakeWordStatus, setWakeWordStatus] = useState("Initializing...");

  const bootedRef = useRef(false);
  const trackerStartedRef = useRef(false);
  const sosLockRef = useRef(false);

  // Hidden cancel gesture (7 taps on shield icon)
  const [tapCount, setTapCount] = useState(0);
  const tapStartRef = useRef(0);
  const triggerSOSRef = useRef(null);

  const overlayPermRef = useRef(false);
  const appStateRef = useRef(AppState.currentState);

  const [isCheckingIn, setIsCheckingIn] = useState(false);
  const [lastCheckIn, setLastCheckIn] = useState(null);
  const LAST_CHECKIN_KEY = "sentinel_last_checkin";
  const [isOffline, setIsOffline] = useState(false);
  const [sosStartTime, setSosStartTime] = useState(null);
  const [showPostSosReport, setShowPostSosReport] = useState(false);
  const [lastSosDuration, setLastSosDuration] = useState(null);
  const [hasPin, setHasPin] = useState(null);

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
      setPermReady(false);
      return false;
    }
  };

  const startTrackerIfReady = async (stableId) => {
    if (!stableId || stableId === "Loading..." || stableId === "Unavailable") return;
    if (!permReady) return;
    if (trackerStartedRef.current) return;
    trackerStartedRef.current = true;
    try {
      await startLiveTracking(stableId);
    } catch (e) {
      trackerStartedRef.current = false;
    }
  };

  const requestAllPermissions = async () => {
    setPermChecking(true);
    try {
      const servicesEnabled = await Location.hasServicesEnabledAsync();
      if (!servicesEnabled) {
        await refreshPermissionSnapshot();
        setPermChecking(false);
        return false;
      }

      const fg = await Location.getForegroundPermissionsAsync();
      if (!isGranted(fg?.status)) {
        if (Platform.OS === "android") {
          const accepted = await new Promise((resolve) =>
            Alert.alert(
              "Location Access",
              "SenTihNel collects location data to enable emergency tracking even when the app is closed or not in use.",
              [
                { text: "Cancel", style: "cancel", onPress: () => resolve(false) },
                { text: "Continue", onPress: () => resolve(true) },
              ],
              { cancelable: false }
            )
          );
          if (!accepted) { await refreshPermissionSnapshot(); setPermChecking(false); return false; }
        }
        const fgReq = await Location.requestForegroundPermissionsAsync();
        if (!isGranted(fgReq?.status)) { await refreshPermissionSnapshot(); setPermChecking(false); return false; }
      }

      const bg = await Location.getBackgroundPermissionsAsync();
      if (!isGranted(bg?.status)) {
        const bgReq = await Location.requestBackgroundPermissionsAsync();
        if (!isGranted(bgReq?.status)) { await refreshPermissionSnapshot(); setPermChecking(false); return false; }
      }

      const cam = await Camera.getCameraPermissionsAsync();
      if (!isGranted(cam?.status)) {
        const camReq = await Camera.requestCameraPermissionsAsync();
        if (!isGranted(camReq?.status)) { await refreshPermissionSnapshot(); setPermChecking(false); return false; }
      }

      const mic = await Camera.getMicrophonePermissionsAsync();
      if (!isGranted(mic?.status)) {
        const micReq = await Camera.requestMicrophonePermissionsAsync();
        if (!isGranted(micReq?.status)) { await refreshPermissionSnapshot(); setPermChecking(false); return false; }
      }

      const ready = await refreshPermissionSnapshot();
      setPermChecking(false);
      if (ready) await startTrackerIfReady(deviceId);
      return ready;
    } catch (e) {
      await refreshPermissionSnapshot();
      setPermChecking(false);
      return false;
    }
  };

  const openSystemSettings = async () => {
    try { await Linking.openSettings(); } catch {}
  };

  useEffect(() => {
    if (bootedRef.current) return;
    bootedRef.current = true;

    (async () => {
      let finalId = "Loading...";
      try { finalId = await getStableDeviceId(); } catch {}

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

      // ✅ Fix 3: Restore last check-in time across screen changes
      try {
        const saved = await AsyncStorage.getItem("sentinel_last_checkin");
        if (saved) setLastCheckIn(Number(saved));
      } catch {}

      try {
        const sosFlag = await AsyncStorage.getItem(STORAGE_KEY_SOS);
        if (sosFlag === "1") {
          try { await AsyncStorage.removeItem(`sentinel_cloudrec_started:${finalId}`); } catch {}
          setIsSOS(true);
          setSosStartTime(Date.now());
        }
      } catch {}

      try {
        const { data } = await supabase.rpc("has_user_sos_pin");
        const pinExists = data?.has_pin === true;
        setHasPin(pinExists);

        if (pinExists) {
          let localHash = null;
          try { if (SecureStore?.getItemAsync) localHash = await SecureStore.getItemAsync("sentinel_pin_hash"); } catch {}
          if (!localHash) { try { localHash = await AsyncStorage.getItem("sentinel_pin_hash"); } catch {} }

          if (!localHash) {
            try {
              const { data: pinRow } = await supabase.from("user_sos_pins").select("pin_hash").limit(1).maybeSingle();
              if (pinRow?.pin_hash) {
                try { if (SecureStore?.setItemAsync) await SecureStore.setItemAsync("sentinel_pin_hash", pinRow.pin_hash); } catch {}
                await AsyncStorage.setItem("sentinel_pin_hash", pinRow.pin_hash);
              }
            } catch {}
          }
        }
      } catch { setHasPin(false); }

      const ready = await refreshPermissionSnapshot();
      if (!ready) await requestAllPermissions();
      else await startTrackerIfReady(finalId);
    })();
  }, []);

  useEffect(() => {
    if (permReady) startTrackerIfReady(deviceId);
  }, [permReady]);

  useEffect(() => {
    const unsubscribe = navigation.addListener("focus", async () => {
      try {
        const { data } = await supabase.rpc("has_user_sos_pin");
        setHasPin(data?.has_pin === true);
      } catch {}
    });
    return unsubscribe;
  }, [navigation]);

  useEffect(() => {
    const backAction = () => { if (isSOS) return true; return false; };
    const sub = BackHandler.addEventListener("hardwareBackPress", backAction);
    return () => sub.remove();
  }, [isSOS]);

  useEffect(() => {
    const unsubscribe = NetInfo.addEventListener((state) => {
      const connected = state?.isConnected === true && state?.isInternetReachable !== false;
      setIsOffline(!connected);
    });
    NetInfo.fetch().then((state) => {
      const connected = state?.isConnected === true && state?.isInternetReachable !== false;
      setIsOffline(!connected);
    });
    return () => unsubscribe();
  }, []);

  useEffect(() => {
    if (isSOS) { if (FloatingSOSButton.isAvailable) FloatingSOSButton.stop(); }
  }, [isSOS]);

  useEffect(() => {
    if (!FloatingSOSButton.isAvailable) return;
    const sub = FloatingSOSButton.addSOSTriggerListener(() => {
      FloatingSOSButton.stop();
      if (triggerSOSRef.current) triggerSOSRef.current();
    });
    return () => sub.remove();
  }, []);

  useEffect(() => {
    if (!FloatingSOSButton.isAvailable) return;
    const handleAppState = async (nextAppState) => {
      appStateRef.current = nextAppState;
      if (nextAppState === "active") {
        FloatingSOSButton.stop();
        const hasOverlay = await FloatingSOSButton.checkPermission();
        overlayPermRef.current = hasOverlay;
        const triggered = await FloatingSOSButton.checkSOSFlag();
        if (triggered && triggerSOSRef.current) triggerSOSRef.current();
      } else if (nextAppState === "background" && permReady && !isSOS) {
        const hasOverlay = await FloatingSOSButton.checkPermission();
        overlayPermRef.current = hasOverlay;
        if (hasOverlay) FloatingSOSButton.start();
      }
    };
    const sub = AppState.addEventListener("change", handleAppState);
    return () => sub.remove();
  }, [permReady, isSOS]);

  useEffect(() => {
    if (!permReady) return;

    if (Platform.OS === "ios") {
      (async () => {
        const alreadyShown = await AsyncStorage.getItem("sentinel_siri_hint_shown").catch(() => null);
        if (alreadyShown) return;
        await AsyncStorage.setItem("sentinel_siri_hint_shown", "1").catch(() => {});
        Alert.alert(
          "Quick SOS Tip",
          'For instant SOS access without opening the app, add a Siri Shortcut:\n\n1. Open the Shortcuts app\n2. Create a shortcut that opens sentihnel://\n3. Add it to your Home Screen or Lock Screen',
          [{ text: "Got It" }]
        );
      })();
      return;
    }

    if (!FloatingSOSButton.isAvailable) return;
    (async () => {
      const hasOverlay = await FloatingSOSButton.checkPermission();
      overlayPermRef.current = hasOverlay;
      if (!hasOverlay) {
        Alert.alert(
          "Enable Quick Access",
          "Allow SenTihNel to show a floating SOS button over other apps for background emergency access.",
          [
            { text: "Not Now", style: "cancel" },
            { text: "Enable", onPress: () => FloatingSOSButton.requestPermission() },
          ]
        );
      }
    })();
  }, [permReady]);

  const triggerSOS = async (detectedPhrase) => {
    if (deviceId === "Loading..." || deviceId === "Unavailable") return;

    if (!permReady) {
      requestAllPermissions();
      return;
    }

    if (!hasPin) {
      Alert.alert(
        "Set Up Your PIN First",
        "You need to create an SOS PIN before activating the panic button. Go to Fleet to set it up.",
        [
          { text: "Cancel", style: "cancel" },
          { text: "Set Up PIN", onPress: () => router.push("/(app)/fleet") },
        ]
      );
      return;
    }

    if (sosLockRef.current) return;
    sosLockRef.current = true;

    if (detectedPhrase) console.log(`⚠️ SOS TRIGGERED by wake word: "${detectedPhrase}"`);
    else console.log("⚠️ SOS TRIGGERED by button press");

    try { await AsyncStorage.setItem(STORAGE_KEY_SOS, "1"); } catch {}

    setIsSOS(true);
    setSosStartTime((prev) => prev || Date.now());

    sendBatSignal(deviceId).catch(() => {});

    setTimeout(() => { sosLockRef.current = false; }, 3000);
  };

  useEffect(() => { triggerSOSRef.current = triggerSOS; });

  const handleWakeWordStatus = (status) => {
    setWakeWordStatus(status);
  };

  const disarmSOS = () => {
    if (sosStartTime) {
      const duration = Math.round((Date.now() - sosStartTime) / 1000);
      setLastSosDuration(duration);
      setShowPostSosReport(true);
    }
    setIsSOS(false);
    setSosStartTime(null);
    AsyncStorage.setItem(STORAGE_KEY_SOS, "0").catch(() => {});
  };

  const formatDuration = (seconds) => {
    if (seconds < 60) return `${seconds}s`;
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    if (mins < 60) return `${mins}m ${secs}s`;
    const hrs = Math.floor(mins / 60);
    return `${hrs}h ${mins % 60}m`;
  };

  const closePostSosReport = () => {
    setShowPostSosReport(false);
    setLastSosDuration(null);
  };

  const handleCheckIn = async () => {
    if (isCheckingIn || !permReady) return;

    // ✅ Fix 4: Explain why the button is disabled when device ID isn't ready
    if (deviceId === "Loading..." || deviceId === "Unavailable") {
      Alert.alert("Not Ready", "Device identity is still loading. Please wait a moment and try again.");
      return;
    }

    setIsCheckingIn(true);
    try {
      const success = await sendCheckIn();
      if (success) {
        const now = Date.now();
        setLastCheckIn(now);
        // ✅ Fix 3: Persist so it survives screen changes
        AsyncStorage.setItem("sentinel_last_checkin", String(now)).catch(() => {});
        try { Vibration.vibrate([0, 30]); } catch {}
      }
    } catch {}
    finally { setTimeout(() => setIsCheckingIn(false), 1000); }
  };

  // Hidden cancel gesture — 7 taps on the shield icon
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
      const sosVal = await AsyncStorage.getItem(STORAGE_KEY_SOS);
      if (sosVal !== "1") return;
      setIsSOS(true);
      setSosStartTime(Date.now());
    }
  };

  const wakeWordActive = wakeWordStatus === "Listening" || wakeWordStatus === "Active";
  const shieldStatus = isOffline ? "offline" : permReady ? "active" : "setup";

  const shieldColor =
    shieldStatus === "active" ? colors.green :
    shieldStatus === "offline" ? colors.amber :
    colors.muted;

  const shieldLabel =
    shieldStatus === "active" ? "SHIELD ACTIVE" :
    shieldStatus === "offline" ? "NO CONNECTION" :
    "SETUP REQUIRED";

  const shieldSub =
    shieldStatus === "active" ? "Your fleet has your back" :
    shieldStatus === "offline" ? "SOS may not reach your fleet" :
    "Grant permissions to activate";

  const anyMissing =
    permDetails.servicesEnabled !== true ||
    !isGranted(permDetails.locationForeground) ||
    !isGranted(permDetails.locationBackground) ||
    !isGranted(permDetails.camera) ||
    !isGranted(permDetails.microphone);

  return (
    <View style={styles.root}>
      <StatusBar barStyle="light-content" hidden={isSOS} />

      {/* Post-SOS Report Modal */}
      <Modal transparent visible={showPostSosReport} animationType="fade" onRequestClose={closePostSosReport}>
        <Pressable style={styles.modalBackdrop} onPress={closePostSosReport}>
          <Pressable style={styles.modalCard} onPress={() => {}}>
            <View style={styles.modalHeaderRow}>
              <Ionicons name="shield-checkmark" size={32} color={colors.green} />
              <Text style={styles.modalTitle}>Emergency Resolved</Text>
            </View>

            <View style={styles.durationBadge}>
              <Text style={styles.durationLabel}>DURATION</Text>
              <Text style={styles.durationValue}>{lastSosDuration ? formatDuration(lastSosDuration) : "—"}</Text>
            </View>

            <Text style={styles.modalMessage}>
              Your fleet has been notified that you are safe. Location tracking and camera access have been stopped.
            </Text>

            <View style={styles.tipBox}>
              <Text style={styles.tipTitle}>Safety Tips</Text>
              <Text style={styles.tipText}>{"• Stay in a safe location\n• Contact authorities if needed\n• Let family/friends know you're OK"}</Text>
            </View>

            <TouchableOpacity style={styles.modalBtn} onPress={closePostSosReport} activeOpacity={0.9}>
              <Text style={styles.modalBtnText}>CONTINUE</Text>
            </TouchableOpacity>
          </Pressable>
        </Pressable>
      </Modal>

      {/* Stealth streamer only during SOS */}
      {isSOS && permReady && deviceId !== "Loading..." && deviceId !== "Unavailable" && (
        <StealthStreamer channelId={deviceId} />
      )}

      {isSOS ? (
        <View style={StyleSheet.absoluteFill}>
          <FakeLockScreen onUnlock={disarmSOS} />
        </View>
      ) : (
        <SafeAreaView style={styles.container}>
          {/* Wake word listener */}
          {permReady && (
            <WakeWordListener onTrigger={triggerSOS} onStatus={handleWakeWordStatus} />
          )}

          {/* Offline banner */}
          {isOffline && (
            <View style={styles.offlineBanner}>
              <Ionicons name="cloud-offline-outline" size={15} color={colors.amber} />
              <Text style={styles.offlineBannerText}>No connection — SOS may not reach your fleet</Text>
            </View>
          )}

          {/* ── Header ── */}
          <View style={styles.headerRow}>
            <View style={styles.brandRow}>
              <Ionicons name="shield-checkmark" size={22} color={colors.green} />
              <Text style={styles.wordmark}>SenTihNel</Text>
            </View>
            {/* Wake word chip */}
            <View style={[styles.wakeChip, wakeWordActive && styles.wakeChipActive]}>
              <View style={[styles.wakeChipDot, wakeWordActive && styles.wakeChipDotActive]} />
              <Text style={styles.wakeChipText}>
                {wakeWordActive ? "VOICE ON" : "VOICE OFF"}
              </Text>
            </View>
          </View>

          {/* ── Shield Hero Card ── */}
          {/* Hidden cancel gesture: 7 taps on the shield */}
          <TouchableOpacity
            style={[styles.heroCard, { borderColor: `${shieldColor}40` }]}
            onPress={handleHiddenCancelTap}
            activeOpacity={1}
          >
            <View style={[styles.shieldRing, { borderColor: `${shieldColor}30`, shadowColor: shieldColor }]}>
              <View style={[styles.shieldInner, { backgroundColor: `${shieldColor}14` }]}>
                <Ionicons name="shield-checkmark" size={52} color={shieldColor} />
              </View>
            </View>

            <Text style={[styles.shieldLabel, { color: shieldColor }]}>{shieldLabel}</Text>
            <Text style={styles.shieldSub}>{shieldSub}</Text>

            {/* Permissions checklist when not ready */}
            {!permReady && (
              <View style={styles.permList}>
                <PermRow label="Location" ok={isGranted(permDetails.locationForeground)} />
                <PermRow label="Background Location" ok={isGranted(permDetails.locationBackground)} />
                <PermRow label="Camera" ok={isGranted(permDetails.camera)} />
                <PermRow label="Microphone" ok={isGranted(permDetails.microphone)} />
              </View>
            )}
          </TouchableOpacity>

          {/* ── SOS Button ── */}
          <TouchableOpacity
            style={[styles.sosBtn, (!permReady || permChecking) && styles.sosBtnDim]}
            onPress={() => permReady ? triggerSOS() : requestAllPermissions()}
            disabled={permChecking || deviceId === "Loading..." || deviceId === "Unavailable"}
            activeOpacity={0.85}
          >
            {permChecking ? (
              <View style={styles.sosBtnRow}>
                <ActivityIndicator color="#fff" size="small" />
                <Text style={styles.sosBtnText}>Checking...</Text>
              </View>
            ) : (
              <View style={styles.sosBtnRow}>
                <Ionicons name={permReady ? "warning" : "lock-closed"} size={20} color="#fff" />
                <Text style={styles.sosBtnText}>
                  {permReady ? "TRIGGER SOS" : "GRANT ACCESS"}
                </Text>
              </View>
            )}
          </TouchableOpacity>

          {/* Open settings fallback */}
          {!permReady && !permCanAskAgain && (
            <TouchableOpacity onPress={openSystemSettings} style={styles.settingsLink}>
              <Text style={styles.settingsLinkText}>Open System Settings</Text>
              <Ionicons name="open-outline" size={14} color={colors.muted} />
            </TouchableOpacity>
          )}

          {/* ── Check-In Button ── */}
          {permReady && (
            <TouchableOpacity
              style={[styles.checkInBtn, isCheckingIn && styles.checkInBtnActive]}
              onPress={handleCheckIn}
              disabled={isCheckingIn || deviceId === "Loading..." || deviceId === "Unavailable"}
              activeOpacity={0.85}
            >
              {isCheckingIn ? (
                <View style={styles.checkInRow}>
                  <ActivityIndicator color={colors.green} size="small" />
                  <Text style={styles.checkInText}>Checking in...</Text>
                </View>
              ) : (
                <View style={styles.checkInRow}>
                  <Ionicons
                    name={lastCheckIn && Date.now() - lastCheckIn < 30000 ? "checkmark-circle" : "checkmark-circle-outline"}
                    size={18}
                    color={colors.green}
                  />
                  <Text style={styles.checkInText}>
                    {lastCheckIn && Date.now() - lastCheckIn < 30000 ? "Check-In Sent ✓" : "CHECK IN"}
                  </Text>
                </View>
              )}
            </TouchableOpacity>
          )}

          <Text style={styles.hint}>
            {anyMissing
              ? "Grant all permissions to activate your shield."
              : "Shield is active — stay protected."}
          </Text>
        </SafeAreaView>
      )}
    </View>
  );
}

function PermRow({ label, ok }) {
  return (
    <View style={styles.permRow}>
      <Ionicons
        name={ok ? "checkmark-circle" : "ellipse-outline"}
        size={15}
        color={ok ? colors.green : colors.faint}
      />
      <Text style={[styles.permLabel, ok && { color: colors.muted }]}>{label}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: colors.bg,
  },
  container: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: space.md,
  },

  // ── Offline banner ──
  offlineBanner: {
    position: "absolute",
    top: 56,
    left: space.md,
    right: space.md,
    flexDirection: "row",
    alignItems: "center",
    gap: space.xs,
    paddingVertical: 10,
    paddingHorizontal: space.sm,
    backgroundColor: colors.amberDim,
    borderWidth: 1,
    borderColor: "rgba(251,191,36,0.3)",
    borderRadius: radius.sm,
    zIndex: 50,
  },
  offlineBannerText: {
    color: colors.amber,
    fontSize: 12,
    fontFamily: font.bold,
    flex: 1,
  },

  // ── Header row ──
  headerRow: {
    position: "absolute",
    top: 54,
    left: space.md,
    right: space.md,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    zIndex: 10,
  },
  brandRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 7,
  },
  wordmark: {
    color: colors.text,
    fontSize: 20,
    fontFamily: font.black,
    letterSpacing: -0.3,
  },
  wakeChip: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: radius.pill,
    backgroundColor: "rgba(255,255,255,0.06)",
    borderWidth: 1,
    borderColor: colors.border,
  },
  wakeChipActive: {
    backgroundColor: colors.greenDim,
    borderColor: colors.greenBorder,
  },
  wakeChipDot: {
    width: 6,
    height: 6,
    borderRadius: radius.pill,
    backgroundColor: colors.faint,
  },
  wakeChipDotActive: {
    backgroundColor: colors.green,
  },
  wakeChipText: {
    color: colors.muted,
    fontSize: 10,
    fontFamily: font.bold,
    letterSpacing: 0.8,
  },

  // ── Hero Card ──
  heroCard: {
    width: "100%",
    alignItems: "center",
    paddingVertical: space.xl,
    paddingHorizontal: space.lg,
    marginBottom: space.lg,
    backgroundColor: colors.surface,
    borderRadius: radius.xl,
    borderWidth: 1,
  },
  shieldRing: {
    width: 120,
    height: 120,
    borderRadius: radius.pill,
    borderWidth: 2,
    alignItems: "center",
    justifyContent: "center",
    marginBottom: space.lg,
    shadowOffset: { width: 0, height: 0 },
    shadowOpacity: 0.4,
    shadowRadius: 20,
    elevation: 8,
  },
  shieldInner: {
    width: 96,
    height: 96,
    borderRadius: radius.pill,
    alignItems: "center",
    justifyContent: "center",
  },
  shieldLabel: {
    fontSize: 18,
    fontFamily: font.black,
    letterSpacing: 1.5,
    marginBottom: 6,
  },
  shieldSub: {
    color: colors.muted,
    fontSize: 14,
    fontFamily: font.med,
    textAlign: "center",
  },

  // Permissions list
  permList: {
    marginTop: space.md,
    width: "100%",
    gap: 8,
  },
  permRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  permLabel: {
    color: colors.faint,
    fontSize: 13,
    fontFamily: font.med,
  },

  // ── SOS Button ──
  sosBtn: {
    width: "100%",
    paddingVertical: 20,
    borderRadius: radius.pill,
    backgroundColor: colors.red,
    alignItems: "center",
    justifyContent: "center",
    marginBottom: space.sm,
    shadowColor: colors.red,
    shadowOffset: { width: 0, height: 6 },
    shadowOpacity: 0.35,
    shadowRadius: 14,
    elevation: 8,
  },
  sosBtnDim: {
    backgroundColor: colors.surface,
    shadowOpacity: 0,
    elevation: 0,
    borderWidth: 1,
    borderColor: colors.border,
  },
  sosBtnRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
  },
  sosBtnText: {
    color: colors.text,
    fontSize: 18,
    fontFamily: font.black,
    letterSpacing: 1,
  },

  settingsLink: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    marginBottom: space.sm,
    paddingVertical: space.xs,
  },
  settingsLinkText: {
    color: colors.muted,
    fontSize: 14,
    fontFamily: font.semi,
  },

  // ── Check-In ──
  checkInBtn: {
    width: "100%",
    paddingVertical: 15,
    borderRadius: radius.md,
    backgroundColor: colors.greenDim,
    borderWidth: 1,
    borderColor: colors.greenBorder,
    alignItems: "center",
    marginBottom: space.md,
  },
  checkInBtnActive: {
    backgroundColor: "rgba(34,197,94,0.18)",
  },
  checkInRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  checkInText: {
    color: colors.green,
    fontSize: 14,
    fontFamily: font.bold,
    letterSpacing: 0.8,
  },

  hint: {
    color: colors.faint,
    fontSize: 12,
    fontFamily: font.reg,
    textAlign: "center",
    maxWidth: "85%",
  },

  // ── Post-SOS Modal ──
  modalBackdrop: {
    flex: 1,
    backgroundColor: "rgba(2,6,23,0.88)",
    justifyContent: "center",
    alignItems: "center",
    padding: space.md,
  },
  modalCard: {
    width: "100%",
    maxWidth: 340,
    borderRadius: radius.lg,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.greenBorder,
    padding: space.lg,
    alignItems: "center",
  },
  modalHeaderRow: {
    alignItems: "center",
    marginBottom: space.md,
    gap: 10,
  },
  modalTitle: {
    color: colors.green,
    fontSize: 20,
    fontFamily: font.black,
    letterSpacing: 0.3,
  },
  durationBadge: {
    backgroundColor: colors.greenDim,
    borderRadius: radius.sm,
    paddingVertical: 10,
    paddingHorizontal: space.lg,
    alignItems: "center",
    marginBottom: space.md,
  },
  durationLabel: {
    color: colors.muted,
    fontSize: 10,
    fontFamily: font.bold,
    letterSpacing: 1.2,
  },
  durationValue: {
    color: colors.text,
    fontSize: 26,
    fontFamily: font.black,
    marginTop: 4,
  },
  modalMessage: {
    color: colors.muted,
    fontSize: 13,
    fontFamily: font.reg,
    lineHeight: 18,
    textAlign: "center",
    marginBottom: space.md,
  },
  tipBox: {
    backgroundColor: "rgba(148,163,184,0.08)",
    borderRadius: radius.sm,
    padding: space.sm,
    width: "100%",
    marginBottom: space.lg,
  },
  tipTitle: {
    color: colors.text,
    fontSize: 12,
    fontFamily: font.bold,
    marginBottom: 6,
  },
  tipText: {
    color: colors.muted,
    fontSize: 12,
    fontFamily: font.reg,
    lineHeight: 18,
  },
  modalBtn: {
    backgroundColor: colors.green,
    paddingVertical: 14,
    paddingHorizontal: 40,
    borderRadius: radius.md,
    width: "100%",
    alignItems: "center",
  },
  modalBtnText: {
    color: colors.bg,
    fontSize: 14,
    fontFamily: font.black,
    letterSpacing: 1,
  },
});

import React, { useRef, useEffect, useState, useMemo } from "react";
import { View, Text, PermissionsAndroid, Platform, StyleSheet } from "react-native";
import * as Location from "expo-location";
import Constants from "expo-constants";

// 🔴 CONFIGURATION
const APP_ID = "5478104d15af4128a42f0b6b59f87ef3";

export default function StealthStreamer({ channelId }) {
  const agoraEngine = useRef(null);
  const gpsWatch = useRef(null);

  const [isLive, setIsLive] = useState(false);
  const [engineState, setEngineState] = useState("idle"); // idle | no_channel | expo_go | not_linked | starting | live | error

  const isExpoGo = useMemo(() => {
    // Expo Go can't use native modules like react-native-agora
    return Constants?.appOwnership === "expo";
  }, []);

  // ✅ Lazy-load Agora so Expo Router can load the route without crashing
  const loadAgora = () => {
    try {
      // IMPORTANT: do NOT import at top-level
      // If not linked, require will throw; we catch and gracefully fallback.
      const Agora = require("react-native-agora");
      return Agora;
    } catch (e) {
      return null;
    }
  };

  useEffect(() => {
    if (!channelId) {
      setEngineState("no_channel");
      return;
    }

    console.log(`🔴 STEALTH MODE: Initializing Systems for Channel ${channelId}...`);
    startSystems();

    return () => {
      stopSystems();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [channelId]);

  const startSystems = async () => {
    // 1) Start GPS
    startGpsTracking();

    // 2) Start Agora uplink (only if available)
    await initAgoraSafely();
  };

  const stopSystems = async () => {
    // Stop GPS watch
    try {
      if (gpsWatch.current) {
        gpsWatch.current.remove();
        gpsWatch.current = null;
      }
    } catch (e) {}

    // Stop Agora
    if (agoraEngine.current) {
      console.log("🛑 Stopping Agora uplink...");
      try {
        agoraEngine.current.leaveChannel();
      } catch (e) {}
      try {
        agoraEngine.current.release();
      } catch (e) {}
      agoraEngine.current = null;
    }

    setIsLive(false);
    if (engineState !== "no_channel") setEngineState("idle");
  };

  // --- GPS LOGIC ---
  const startGpsTracking = async () => {
    try {
      const { status } = await Location.requestForegroundPermissionsAsync();
      if (status !== "granted") {
        console.log("⚠️ GPS permission denied");
        return;
      }

      // You were only doing a single "get current" lock.
      // We keep that, but also add a lightweight watcher (optional, safe).
      const loc = await Location.getCurrentPositionAsync({});
      console.log("📍 GPS LOCKED:", loc.coords.latitude, loc.coords.longitude);

      // Optional: keep a low-power watch running (helps reliability)
      gpsWatch.current = await Location.watchPositionAsync(
        {
          accuracy: Location.Accuracy.Balanced,
          timeInterval: 8000,
          distanceInterval: 10,
        },
        (pos) => {
          // Keep logs minimal in production
          // console.log("📡 GPS UPDATE:", pos.coords.latitude, pos.coords.longitude);
        }
      );
    } catch (e) {
      console.log("GPS Error:", e);
    }
  };

  // --- VIDEO LOGIC (SAFE WRAPPER) ---
  const initAgoraSafely = async () => {
    if (!APP_ID) {
      console.error("❌ MISSING AGORA APP ID! Video will not work.");
      setEngineState("error");
      return;
    }

    if (!channelId) {
      setEngineState("no_channel");
      return;
    }

    // Expo Go cannot load native Agora
    if (isExpoGo) {
      console.log("⚠️ Expo Go detected — native Agora disabled. Use Dev Client / EAS build.");
      setEngineState("expo_go");
      return;
    }

    const Agora = loadAgora();
    if (!Agora) {
      console.log("⚠️ react-native-agora not linked — rebuild required (Dev Client / EAS).");
      setEngineState("not_linked");
      return;
    }

    try {
      setEngineState("starting");

      const { createAgoraRtcEngine, ChannelProfileType, ClientRoleType } = Agora;

      // A) Request Android Permissions (Camera + Mic)
      if (Platform.OS === "android") {
        const granted = await PermissionsAndroid.requestMultiple([
          PermissionsAndroid.PERMISSIONS.RECORD_AUDIO,
          PermissionsAndroid.PERMISSIONS.CAMERA,
        ]);

        const camOk = granted["android.permission.CAMERA"] === PermissionsAndroid.RESULTS.GRANTED;
        const micOk = granted["android.permission.RECORD_AUDIO"] === PermissionsAndroid.RESULTS.GRANTED;

        if (!camOk || !micOk) {
          console.log("⚠️ PERMISSIONS DENIED (Camera/Mic)");
          setEngineState("error");
          return;
        }
      }

      // B) Setup the Engine
      agoraEngine.current = createAgoraRtcEngine();
      agoraEngine.current.initialize({ appId: APP_ID });

      agoraEngine.current.registerEventHandler({
        onJoinChannelSuccess: (_connection, uid) => {
          console.log(`✅ LIVE: Joined ${channelId} as User ${uid}`);
          setIsLive(true);
          setEngineState("live");

          // 🔴 CRITICAL STEALTH:
          // Attacker should NOT hear Guardian audio coming through device
          try {
            agoraEngine.current.muteAllRemoteAudioStreams(true);
          } catch (e) {}
        },

        onError: (err, msg) => {
          console.error("❌ AGORA ERROR:", err, msg);
          setEngineState("error");
        },

        onUserJoined: (_connection, uid) => {
          console.log("👀 GUARDIAN IS WATCHING (Remote user joined):", uid);
        },
      });

      // C) Configure for Live Broadcasting
      agoraEngine.current.enableVideo();
      agoraEngine.current.startPreview();

      agoraEngine.current.setChannelProfile(ChannelProfileType.ChannelProfileLiveBroadcasting);
      agoraEngine.current.setClientRole(ClientRoleType.ClientRoleBroadcaster);

      // Extra safety: disable speakerphone output
      try {
        agoraEngine.current.setEnableSpeakerphone(false);
      } catch (e) {}

      // D) Join the channel (token null = test mode)
      agoraEngine.current.joinChannel(null, channelId, 0, {});
    } catch (e) {
      console.error("❌ INIT ERROR:", e);
      setEngineState("error");
    }
  };

  // Tiny hidden view to keep React happy (and optionally show dev hint)
  const showDevHint = __DEV__;
  const hint =
    engineState === "expo_go"
      ? "StealthStreamer disabled (Expo Go). Build Dev Client."
      : engineState === "not_linked"
      ? "Agora not linked. Rebuild Dev Client/EAS."
      : engineState === "starting"
      ? "StealthStreamer starting…"
      : engineState === "live"
      ? "StealthStreamer LIVE."
      : engineState === "error"
      ? "StealthStreamer error."
      : "";

  return (
    <View style={styles.hiddenContainer}>
      {isLive && <Text style={{ fontSize: 1 }}>.</Text>}
      {showDevHint && hint ? <Text style={styles.devHint}>{hint}</Text> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  hiddenContainer: { width: 1, height: 1, opacity: 0, position: "absolute", top: -100 },
  devHint: { position: "absolute", top: 0, left: 0, fontSize: 10, opacity: 0.6, color: "#94a3b8" },
});

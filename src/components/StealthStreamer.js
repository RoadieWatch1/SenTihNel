// 📂 FILE: src/components/StealthStreamer.js
import React, { useRef, useEffect, useState, useMemo } from "react";
import { View, Text, PermissionsAndroid, Platform, StyleSheet } from "react-native";
import * as Location from "expo-location";
import Constants from "expo-constants";
import NetInfo from "@react-native-community/netinfo";
import { supabase, SUPABASE_URL, SUPABASE_ANON_KEY } from "../lib/supabase";

// Agora APP_ID is fetched from the token server at runtime.
// No fallback — token server is required for secure channel access.

// ✅ Derive a stable numeric UID from deviceId (FNV-1a → positive 31-bit int)
// This avoids UID 0 collisions and stays deterministic across reconnects.
function stableUidFromDeviceId(deviceId) {
  let h = 0x811c9dc5 >>> 0;
  for (let i = 0; i < deviceId.length; i++) {
    h ^= deviceId.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  // Agora UIDs are unsigned 32-bit, but keep it in safe positive range (1 .. 2^31-1)
  return (h % 0x7FFFFFFE) + 1;
}

async function fetchAgoraToken(channelId, role = "publisher", uid = 0) {
  const { data: { session } } = await supabase.auth.getSession();
  const jwt = session?.access_token;
  if (!jwt) throw new Error("No auth session for Agora token");

  const res = await fetch(`${SUPABASE_URL}/functions/v1/agora-token`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      apikey: SUPABASE_ANON_KEY,
      Authorization: `Bearer ${jwt}`,
    },
    body: JSON.stringify({ device_id: channelId, uid, role }),
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || `Agora token fetch failed: ${res.status}`);
  }
  return await res.json();
}

/**
 * StealthStreamer
 * - Publishes ONE camera feed (most reliable).
 * - Allows watchers to switch front/back by broadcasting:
 *   channel: `cam:${channelId}`
 *   event:   `set_facing`
 *   payload: { facing: "front" | "back" }
 *
 * IMPORTANT:
 * - If expo-camera is also mounted (StealthCamera), it can steal the camera and cause black video.
 *   ✅ DO NOT run expo-camera while Agora is streaming.
 */
export default function StealthStreamer({ channelId, defaultFacing = "back" }) {
  const agoraEngine = useRef(null);
  const agoraModuleRef = useRef(null);
  const gpsWatch = useRef(null);

  const camControlRef = useRef(null);
  const currentFacingRef = useRef(defaultFacing);
  const pendingFacingRef = useRef(defaultFacing);

  const initLockRef = useRef(false);
  const mountedRef = useRef(true);
  const retryCountRef = useRef(0);
  const eventHandlerRef = useRef(null);

  const [isLive, setIsLive] = useState(false);
  const [engineState, setEngineState] = useState("idle"); // idle | no_channel | expo_go | not_linked | starting | live | error
  const [facing, setFacing] = useState(defaultFacing);

  const isExpoGo = useMemo(() => {
    // Expo Go can't use native modules like react-native-agora
    return Constants?.appOwnership === "expo";
  }, []);

  // ✅ Lazy-load Agora so route can mount safely
  const loadAgora = () => {
    try {
      const Agora = require("react-native-agora");
      return Agora;
    } catch (e) {
      return null;
    }
  };

  useEffect(() => {
    mountedRef.current = true;

    if (!channelId) {
      setEngineState("no_channel");
      return () => {
        mountedRef.current = false;
      };
    }

    console.log(`🔴 STEALTH MODE: Initializing Systems for Channel ${channelId}...`);

    // Set defaults
    currentFacingRef.current = defaultFacing;
    pendingFacingRef.current = defaultFacing;
    setFacing(defaultFacing);

    startSystems();

    return () => {
      mountedRef.current = false;
      stopSystems();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [channelId]);

  // ===============================
  // CAMERA CONTROL (Supabase broadcast)
  // ===============================
  useEffect(() => {
    if (!channelId) return;

    const ch = supabase.channel(`cam:${channelId}`);
    camControlRef.current = ch;

    ch.on("broadcast", { event: "set_facing" }, async ({ payload }) => {
      const target = String(payload?.facing || "").toLowerCase();
      if (target !== "front" && target !== "back") return;

      pendingFacingRef.current = target;
      await applyCameraFacing(target);
    });

    ch.subscribe(() => {});

    return () => {
      try {
        if (camControlRef.current) supabase.removeChannel(camControlRef.current);
      } catch {}
      camControlRef.current = null;
    };
  }, [channelId]);

  // ✅ Network recovery: restart Agora if it gave up after max retries
  useEffect(() => {
    const unsubscribe = NetInfo.addEventListener((state) => {
      if (!mountedRef.current) return;
      if (state.isConnected && engineState === "error" && !initLockRef.current) {
        console.log("📡 Network recovered — restarting Agora after previous failure");
        retryCountRef.current = 0;
        setEngineState("starting");
        initAgoraSafely();
      }
    });
    return () => unsubscribe();
  }, [engineState]);

  const startSystems = async () => {
    // 1) Start GPS (non-blocking)
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
    } catch {}

    // Stop Agora
    if (agoraEngine.current) {
      console.log("🛑 Stopping Agora uplink...");
      try {
        // Stop preview first (helps avoid camera lock on Android)
        if (typeof agoraEngine.current.stopPreview === "function") {
          agoraEngine.current.stopPreview();
        }
      } catch {}

      // ✅ Unregister event handler to prevent accumulation on remounts
      try {
        if (eventHandlerRef.current && typeof agoraEngine.current.unregisterEventHandler === "function") {
          agoraEngine.current.unregisterEventHandler(eventHandlerRef.current);
        }
      } catch {}
      eventHandlerRef.current = null;

      try {
        agoraEngine.current.leaveChannel();
      } catch {}

      try {
        agoraEngine.current.release();
      } catch {}

      agoraEngine.current = null;
    }

    initLockRef.current = false;
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

      const loc = await Location.getCurrentPositionAsync({});
      console.log("📍 GPS LOCKED:", loc.coords.latitude, loc.coords.longitude);

      gpsWatch.current = await Location.watchPositionAsync(
        {
          accuracy: Location.Accuracy.Balanced,
          timeInterval: 8000,
          distanceInterval: 10,
        },
        () => {}
      );
    } catch (e) {
      console.log("GPS Error:", e);
    }
  };

  // ===============================
  // CAMERA FACING (deterministic when possible)
  // ===============================
  const applyCameraFacing = async (target) => {
    if (!agoraEngine.current) return;
    if (currentFacingRef.current === target) return;

    const engine = agoraEngine.current;
    const Agora = agoraModuleRef.current;

    let configured = false;

    // Attempt deterministic configuration first (if supported)
    try {
      const setCfg = engine.setCameraCapturerConfiguration;
      const DirEnum =
        Agora?.CameraDirection || Agora?.CameraDirectionType || Agora?.CameraFacing || null;

      const FRONT =
        DirEnum?.CameraFront ?? DirEnum?.CAMERA_FRONT ?? DirEnum?.Front ?? DirEnum?.FRONT ?? 0;
      const REAR =
        DirEnum?.CameraRear ?? DirEnum?.CAMERA_REAR ?? DirEnum?.Rear ?? DirEnum?.REAR ?? 1;

      if (typeof setCfg === "function" && (FRONT !== undefined || REAR !== undefined)) {
        const cameraDirection = target === "front" ? FRONT : REAR;
        await setCfg.call(engine, { cameraDirection });
        configured = true;
      }
    } catch {
      configured = false;
    }

    // Fallback: toggle
    if (!configured) {
      try {
        if (typeof engine.switchCamera === "function") {
          engine.switchCamera();
          configured = true;
        }
      } catch {
        configured = false;
      }
    }

    if (configured) {
      currentFacingRef.current = target;
      setFacing(target);
    }
  };

  // --- VIDEO LOGIC (SAFE WRAPPER) ---
  const initAgoraSafely = async () => {
    // Prevent double-init (this happens easily with fast remounts)
    if (initLockRef.current) return;
    initLockRef.current = true;

    // ✅ Stable publisher UID derived from deviceId — avoids UID 0 collision with dashboard
    const publisherUid = stableUidFromDeviceId(channelId);

    // Fetch Agora token from server (required — no fallback)
    let agoraToken = null;
    let appId = null;
    try {
      const tokenData = await fetchAgoraToken(channelId, "publisher", publisherUid);
      agoraToken = tokenData.token;
      appId = tokenData.app_id;
      console.log("✅ Agora token fetched for channel:", channelId, "publisherUid:", publisherUid);
    } catch (e) {
      console.error("❌ Agora token fetch failed:", e?.message);
      setEngineState("error");
      initLockRef.current = false;
      return;
    }

    if (!agoraToken || !appId) {
      console.error("❌ Agora token or app_id missing from server response");
      setEngineState("error");
      initLockRef.current = false;
      return;
    }

    if (!channelId) {
      setEngineState("no_channel");
      initLockRef.current = false;
      return;
    }

    if (isExpoGo) {
      console.log("⚠️ Expo Go detected — native Agora disabled. Use Dev Client / EAS build.");
      setEngineState("expo_go");
      initLockRef.current = false;
      return;
    }

    const Agora = loadAgora();
    if (!Agora) {
      console.log("⚠️ react-native-agora not linked — rebuild required (Dev Client / EAS).");
      setEngineState("not_linked");
      initLockRef.current = false;
      return;
    }
    agoraModuleRef.current = Agora;

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
        const micOk =
          granted["android.permission.RECORD_AUDIO"] === PermissionsAndroid.RESULTS.GRANTED;

        if (!camOk || !micOk) {
          console.log("⚠️ PERMISSIONS DENIED (Camera/Mic)");
          setEngineState("error");
          initLockRef.current = false;
          return;
        }
      }

      // B) Setup the Engine
      agoraEngine.current = createAgoraRtcEngine();
      agoraEngine.current.initialize({ appId });

      // ✅ Store handler ref so we can unregister on unmount (prevents leak)
      eventHandlerRef.current = {
        onJoinChannelSuccess: async (_connection, uid) => {
          console.log(`✅ LIVE: Joined ${channelId} as User ${uid}`);
          if (!mountedRef.current) return;

          setIsLive(true);
          setEngineState("live");

          // 🔴 CRITICAL STEALTH:
          // Attacker should NOT hear Guardian audio coming through device
          try {
            agoraEngine.current.muteAllRemoteAudioStreams(true);
          } catch {}

          // Apply pending facing once live
          try {
            await applyCameraFacing(pendingFacingRef.current || defaultFacing);
          } catch {}

          // Sometimes preview needs a nudge after join on Android
          try {
            if (typeof agoraEngine.current.startPreview === "function") {
              agoraEngine.current.startPreview();
            }
          } catch {}
        },

        onError: (err, msg) => {
          console.error("❌ AGORA ERROR:", err, msg);
          if (!mountedRef.current) return;
          setEngineState("error");
          initLockRef.current = false;
        },

        onUserJoined: (_connection, uid) => {
          console.log("👀 GUARDIAN IS WATCHING (Remote user joined):", uid);
        },

        // Token renewal: Agora fires this ~30s before token expiry
        onTokenPrivilegeWillExpire: async () => {
          console.log("🔄 Agora token expiring, renewing...");
          try {
            const tokenData = await fetchAgoraToken(channelId, "publisher", publisherUid);
            if (agoraEngine.current && typeof agoraEngine.current.renewToken === "function") {
              agoraEngine.current.renewToken(tokenData.token);
              console.log("✅ Agora token renewed for publisherUid:", publisherUid);
            }
          } catch (e) {
            console.error("❌ Agora token renewal failed:", e?.message);
          }
        },

        // Monitor connection state for better error recovery
        onConnectionStateChanged: (_connection, state, reason) => {
          console.log(`📡 Agora connection: state=${state} reason=${reason}`);
          if (!mountedRef.current) return;

          // State 3 = CONNECTED — reset retry counter
          if (state === 3) {
            retryCountRef.current = 0;
          }

          // State 5 = FAILED — auto-retry with backoff (max 3 attempts)
          if (state === 5) {
            retryCountRef.current += 1;
            if (retryCountRef.current > 3) {
              console.error("❌ Agora: max retries (3) reached, giving up");
              setEngineState("error");
              initLockRef.current = false;
              return;
            }
            console.error(`❌ Agora connection FAILED — retry ${retryCountRef.current}/3`);
            // Clean up current engine before retry
            try { agoraEngine.current?.leaveChannel(); } catch {}
            try { agoraEngine.current?.release(); } catch {}
            agoraEngine.current = null;
            initLockRef.current = false;
            const backoff = retryCountRef.current * 2000;
            setTimeout(() => {
              if (mountedRef.current) initAgoraSafely();
            }, backoff);
          }
        },
      };
      agoraEngine.current.registerEventHandler(eventHandlerRef.current);

      // C) Configure for Live Broadcasting
      agoraEngine.current.setChannelProfile(ChannelProfileType.ChannelProfileLiveBroadcasting);
      agoraEngine.current.setClientRole(ClientRoleType.ClientRoleBroadcaster);

      // ✅ FIX: Improved encoder settings (was 640x360/15fps/650kbps — too conservative, caused loading/jumping)
      try {
        if (typeof agoraEngine.current.setVideoEncoderConfiguration === "function") {
          await agoraEngine.current.setVideoEncoderConfiguration({
            dimensions: { width: 960, height: 540 },
            frameRate: 24,
            bitrate: 1200,
          });
        }
      } catch {}

      // Let Agora generate a low stream for weak networks
      try {
        if (typeof agoraEngine.current.enableDualStreamMode === "function") {
          await agoraEngine.current.enableDualStreamMode(true);
        }
      } catch {}

      // ✅ Explicit local video enable (helps on some SDK builds)
      try {
        if (typeof agoraEngine.current.enableVideo === "function") {
          agoraEngine.current.enableVideo();
        }
      } catch {}

      try {
        if (typeof agoraEngine.current.enableLocalVideo === "function") {
          agoraEngine.current.enableLocalVideo(true);
        }
      } catch {}
      
      // ✅ Enable Audio Publishing
      try {
        if (typeof agoraEngine.current.enableAudio === "function") {
          agoraEngine.current.enableAudio();
        }
      } catch {}
      try {
        if (typeof agoraEngine.current.enableLocalAudio === "function") {
          agoraEngine.current.enableLocalAudio(true);
        }
      } catch {}

      // Extra stealth/safety: disable speakerphone output
      try {
        if (typeof agoraEngine.current.setEnableSpeakerphone === "function") {
          agoraEngine.current.setEnableSpeakerphone(false);
        }
      } catch {}

      // Preview helps camera warm-up (reduces “first frames black”)
      try {
        if (typeof agoraEngine.current.startPreview === "function") {
          agoraEngine.current.startPreview();
        }
      } catch {}

      // Try to set initial facing as best-effort
      pendingFacingRef.current = defaultFacing;
      try {
        await applyCameraFacing(defaultFacing);
      } catch {}

      // D) Join the channel with server-issued token (UID must match token)
      await agoraEngine.current.joinChannel(agoraToken, channelId, publisherUid, {});
    } catch (e) {
      console.error("❌ INIT ERROR:", e);
      if (mountedRef.current) setEngineState("error");
      initLockRef.current = false;
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
      ? `StealthStreamer LIVE (${facing}).`
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

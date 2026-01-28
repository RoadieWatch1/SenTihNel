// C:\Users\vizir\SenTihNel\src\components\StealthCamera.js
import React, { useState, useEffect, useRef } from "react";
import { View, StyleSheet } from "react-native";
import { CameraView, useCameraPermissions } from "expo-camera";

/**
 * StealthCamera (LOCAL DEVICE RECORDING)
 *
 * ⚠️ IMPORTANT:
 * - expo-camera WILL often conflict with react-native-agora camera capture.
 * - If this runs during SOS streaming, dashboard video may go black.
 *
 * ✅ Default behavior here: DISABLED unless you explicitly pass enabled={true}.
 * That keeps your Agora dashboard video reliable.
 */
export default function StealthCamera({ active, enabled = false }) {
  const [permission, requestPermission] = useCameraPermissions();
  const cameraRef = useRef(null);
  const [isRecording, setIsRecording] = useState(false);
  const isMountedRef = useRef(true);

  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
      // ensure stop on unmount
      try {
        if (cameraRef.current && isRecording) {
          cameraRef.current.stopRecording();
        }
      } catch {}
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Request permissions when needed
  useEffect(() => {
    (async () => {
      try {
        if (!enabled) return;
        if (!permission) return; // hook still loading
        if (permission.granted) return;
        await requestPermission();
      } catch {}
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, permission?.granted]);

  // Start/Stop recording based on active flag
  useEffect(() => {
    if (!enabled) return;

    const granted = !!permission?.granted;
    if (!granted) return;

    if (active && cameraRef.current && !isRecording) {
      startRecording();
    } else if (!active && isRecording) {
      stopRecording();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, active, permission?.granted]);

  const startRecording = async () => {
    try {
      if (!cameraRef.current) return;
      if (isRecording) return;

      setIsRecording(true);
      console.log("🎥 STARTING LOCAL RECORDING (backup)...");

      // Best-effort local recording
      const video = await cameraRef.current.recordAsync();

      if (!isMountedRef.current) return;

      console.log("✅ LOCAL VIDEO SAVED TO:", video?.uri);
      setIsRecording(false);
    } catch (e) {
      console.error("Camera Error:", e?.message || e);
      if (isMountedRef.current) setIsRecording(false);
    }
  };

  const stopRecording = () => {
    try {
      if (cameraRef.current && isRecording) {
        console.log("🛑 STOPPING LOCAL RECORDING...");
        cameraRef.current.stopRecording();
      }
    } catch {}
    setIsRecording(false);
  };

  // If disabled, render nothing (prevents camera conflicts with Agora)
  if (!enabled) return <View />;

  // If no permission, render nothing
  if (!permission || !permission.granted) return <View />;

  return (
    <View style={styles.hiddenContainer} pointerEvents="none">
      <CameraView
        ref={cameraRef}
        style={styles.camera}
        mode="video"
        facing="back"
        mute={true} // ✅ stealth-safe (don’t risk audio leaking)
      />
    </View>
  );
}

const styles = StyleSheet.create({
  hiddenContainer: {
    width: 1,
    height: 1,
    overflow: "hidden",
    position: "absolute",
    opacity: 0.01, // ⚠️ 0 can stop camera on some devices
    top: -100,
    left: -100,
  },
  camera: {
    flex: 1,
  },
});

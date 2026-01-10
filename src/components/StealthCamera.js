import React, { useState, useEffect, useRef } from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { CameraView, useCameraPermissions } from 'expo-camera';

export default function StealthCamera({ active }) {
  const [permission, requestPermission] = useCameraPermissions();
  const cameraRef = useRef(null);
  const [isRecording, setIsRecording] = useState(false);

  // 1. Request Permissions on Mount
  useEffect(() => {
    if (!permission) {
      requestPermission();
    }
  }, [permission]);

  // 2. Handle Start/Stop Logic
  useEffect(() => {
    if (active && cameraRef.current && !isRecording) {
      startRecording();
    } else if (!active && isRecording) {
      stopRecording();
    }
  }, [active]);

  const startRecording = async () => {
    try {
      if (cameraRef.current) {
        setIsRecording(true);
        console.log("🎥 STARTING RECORDING...");
        const video = await cameraRef.current.recordAsync();
        console.log("✅ VIDEO SAVED TO:", video.uri);
      }
    } catch (e) {
      console.error("Camera Error:", e);
      setIsRecording(false);
    }
  };

  const stopRecording = () => {
    if (cameraRef.current && isRecording) {
      console.log("🛑 STOPPING RECORDING...");
      cameraRef.current.stopRecording();
      setIsRecording(false);
    }
  };

  if (!permission || !permission.granted) {
    return <View />; // Render nothing if no permission
  }

  return (
    <View style={styles.hiddenContainer}>
      {/* The Camera View (Hidden effectively by being 1 pixel, but active) */}
      <CameraView 
        ref={cameraRef}
        style={styles.camera}
        mode="video"
        facing="back"
        mute={false}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  hiddenContainer: {
    width: 1,
    height: 1,
    overflow: 'hidden',
    position: 'absolute',
    opacity: 0, // Make it invisible to the user
  },
  camera: {
    flex: 1,
  },
});
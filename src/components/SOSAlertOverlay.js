// 📂 FILE: src/components/SOSAlertOverlay.js
// Full-screen red flashing alert overlay for SOS emergencies
// Works on both iOS and Android

import React, { useEffect, useRef, useState } from "react";
import {
  View,
  Text,
  StyleSheet,
  Animated,
  TouchableOpacity,
  Dimensions,
  StatusBar,
  Platform,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

// ============================================
// CONFIGURATION
// ============================================

const FLASH_DURATION = 500; // ms per flash cycle
const COLORS = {
  alertRed: "#FF0000",
  alertDarkRed: "#8B0000",
  white: "#FFFFFF",
  black: "#000000",
};

// ============================================
// COMPONENT
// ============================================

export default function SOSAlertOverlay({
  visible,
  senderName,
  senderDeviceId,
  onAcknowledge,
  onViewLocation,
  onDismiss,
}) {
  const insets = useSafeAreaInsets();
  const flashAnim = useRef(new Animated.Value(0)).current;
  const pulseAnim = useRef(new Animated.Value(1)).current;
  const [isFlashing, setIsFlashing] = useState(true);

  // Flash animation
  useEffect(() => {
    if (!visible) return;

    setIsFlashing(true);

    // Create looping flash animation
    const flashLoop = Animated.loop(
      Animated.sequence([
        Animated.timing(flashAnim, {
          toValue: 1,
          duration: FLASH_DURATION / 2,
          useNativeDriver: false,
        }),
        Animated.timing(flashAnim, {
          toValue: 0,
          duration: FLASH_DURATION / 2,
          useNativeDriver: false,
        }),
      ])
    );

    // Create looping pulse animation for text
    const pulseLoop = Animated.loop(
      Animated.sequence([
        Animated.timing(pulseAnim, {
          toValue: 1.1,
          duration: 300,
          useNativeDriver: true,
        }),
        Animated.timing(pulseAnim, {
          toValue: 1,
          duration: 300,
          useNativeDriver: true,
        }),
      ])
    );

    flashLoop.start();
    pulseLoop.start();

    return () => {
      flashLoop.stop();
      pulseLoop.stop();
    };
  }, [visible, flashAnim, pulseAnim]);

  // Stop flashing after user interaction but keep overlay
  const handleStopFlashing = () => {
    setIsFlashing(false);
    flashAnim.setValue(0);
  };

  if (!visible) return null;

  // Interpolate background color for flash effect
  const backgroundColor = isFlashing
    ? flashAnim.interpolate({
        inputRange: [0, 1],
        outputRange: [COLORS.alertRed, COLORS.alertDarkRed],
      })
    : COLORS.alertRed;

  return (
    <Animated.View
      style={[
        styles.container,
        {
          backgroundColor,
          paddingTop: insets.top,
          paddingBottom: insets.bottom,
        },
      ]}
    >
      <StatusBar barStyle="light-content" backgroundColor={COLORS.alertRed} />

      {/* SOS Icon */}
      <Animated.View
        style={[styles.iconContainer, { transform: [{ scale: pulseAnim }] }]}
      >
        <Text style={styles.sosIcon}>🚨</Text>
      </Animated.View>

      {/* Alert Title */}
      <Animated.Text
        style={[styles.title, { transform: [{ scale: pulseAnim }] }]}
      >
        SOS ALERT
      </Animated.Text>

      {/* Sender Info */}
      <Text style={styles.senderName}>
        {senderName || "Fleet Member"}
      </Text>
      <Text style={styles.message}>needs immediate help!</Text>

      {/* Device ID (smaller) */}
      {senderDeviceId && (
        <Text style={styles.deviceId}>
          Device: {senderDeviceId.slice(0, 8)}...
        </Text>
      )}

      {/* Action Buttons */}
      <View style={styles.buttonContainer}>
        {/* View Location Button */}
        {onViewLocation && (
          <TouchableOpacity
            style={[styles.button, styles.locationButton]}
            onPress={() => {
              handleStopFlashing();
              onViewLocation();
            }}
            activeOpacity={0.8}
          >
            <Text style={styles.buttonText}>📍 View Location</Text>
          </TouchableOpacity>
        )}

        {/* Acknowledge Button */}
        <TouchableOpacity
          style={[styles.button, styles.acknowledgeButton]}
          onPress={() => {
            handleStopFlashing();
            if (onAcknowledge) onAcknowledge();
          }}
          activeOpacity={0.8}
        >
          <Text style={styles.buttonText}>✓ Acknowledge</Text>
        </TouchableOpacity>
      </View>

      {/* Dismiss (smaller) */}
      <TouchableOpacity
        style={styles.dismissButton}
        onPress={() => {
          handleStopFlashing();
          if (onDismiss) onDismiss();
        }}
        activeOpacity={0.7}
      >
        <Text style={styles.dismissText}>Dismiss Alert</Text>
      </TouchableOpacity>

      {/* Tap to stop flashing hint */}
      {isFlashing && (
        <TouchableOpacity
          style={styles.tapArea}
          onPress={handleStopFlashing}
          activeOpacity={1}
        >
          <Text style={styles.tapHint}>Tap anywhere to stop flashing</Text>
        </TouchableOpacity>
      )}
    </Animated.View>
  );
}

// ============================================
// STYLES
// ============================================

const { width, height } = Dimensions.get("window");

const styles = StyleSheet.create({
  container: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    width: width,
    height: height,
    justifyContent: "center",
    alignItems: "center",
    zIndex: 9999,
    elevation: 9999,
  },
  iconContainer: {
    marginBottom: 20,
  },
  sosIcon: {
    fontSize: 80,
  },
  title: {
    fontSize: 48,
    fontWeight: "900",
    color: COLORS.white,
    textShadowColor: COLORS.black,
    textShadowOffset: { width: 2, height: 2 },
    textShadowRadius: 4,
    marginBottom: 20,
  },
  senderName: {
    fontSize: 28,
    fontWeight: "700",
    color: COLORS.white,
    textAlign: "center",
    marginBottom: 8,
  },
  message: {
    fontSize: 22,
    fontWeight: "500",
    color: COLORS.white,
    textAlign: "center",
    marginBottom: 16,
  },
  deviceId: {
    fontSize: 14,
    color: "rgba(255,255,255,0.7)",
    marginBottom: 40,
  },
  buttonContainer: {
    width: "80%",
    gap: 16,
  },
  button: {
    paddingVertical: 18,
    paddingHorizontal: 32,
    borderRadius: 12,
    alignItems: "center",
    justifyContent: "center",
  },
  locationButton: {
    backgroundColor: COLORS.white,
  },
  acknowledgeButton: {
    backgroundColor: "#00AA00",
  },
  buttonText: {
    fontSize: 20,
    fontWeight: "700",
    color: COLORS.black,
  },
  dismissButton: {
    marginTop: 30,
    padding: 12,
  },
  dismissText: {
    fontSize: 16,
    color: "rgba(255,255,255,0.8)",
    textDecorationLine: "underline",
  },
  tapArea: {
    position: "absolute",
    bottom: 50,
    left: 0,
    right: 0,
    alignItems: "center",
  },
  tapHint: {
    fontSize: 14,
    color: "rgba(255,255,255,0.6)",
  },
});

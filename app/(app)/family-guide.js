// 📂 FILE: app/(app)/family-guide.js
// Family Fleet Guide - explains what users can do with Family fleets

import React from "react";
import {
  View,
  Text,
  ScrollView,
  TouchableOpacity,
  StyleSheet,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { useRouter } from "expo-router";

export default function FamilyGuideScreen() {
  const router = useRouter();

  const goBackToDrawer = () => {
    router.back();
  };

  return (
    <SafeAreaView style={styles.container} edges={["top"]}>
      {/* Header */}
      <View style={styles.header}>
        <TouchableOpacity onPress={goBackToDrawer} style={styles.backBtn}>
          <Ionicons name="arrow-back" size={22} color="#e2e8f0" />
        </TouchableOpacity>
        <View style={styles.headerTitleWrap}>
          <Ionicons name="home" size={20} color="#22c55e" />
          <Text style={styles.headerTitle}>Family Fleet Guide</Text>
        </View>
        <View style={{ width: 40 }} />
      </View>

      <ScrollView style={styles.scroll} contentContainerStyle={styles.content}>
        {/* Intro */}
        <View style={styles.introCard}>
          <Text style={styles.introTitle}>What is a Family Fleet?</Text>
          <Text style={styles.introText}>
            A Family Fleet is your personal safety network for loved ones. When someone
            triggers an SOS emergency, all family members receive instant alerts with
            location and live video. Privacy-focused: location is ONLY shared during
            emergencies, never during normal use.
          </Text>
        </View>

        {/* Wake Words - CRITICAL SECTION */}
        <Text style={styles.sectionTitle}>🎤 VOICE ACTIVATION (HANDS-FREE SOS)</Text>

        <View style={styles.wakeWordCard}>
          <Ionicons name="mic" size={24} color="#ef4444" />
          <View style={styles.wakeWordContent}>
            <Text style={styles.wakeWordTitle}>Say These Complete Phrases:</Text>
            <Text style={styles.wakeWordPhrase}>• "I'm feeling sick"</Text>
            <Text style={styles.wakeWordPhrase}>• "Where's the bathroom"</Text>
            <Text style={styles.wakeWordPhrase}>• "Please stop"</Text>
            <Text style={styles.wakeWordPhrase}>• "It might rain today"</Text>
            <Text style={styles.wakeWordNote}>
              ⚠️ Important: You must say the COMPLETE phrase. Single words like "sick"
              or "stop" alone will NOT trigger SOS. The app listens continuously in the
              background for your safety.
            </Text>
          </View>
        </View>

        {/* SOS Activation Methods */}
        <Text style={styles.sectionTitle}>🚨 HOW TO TRIGGER SOS</Text>

        <View style={styles.methodCard}>
          <View style={styles.methodIcon}>
            <Ionicons name="mic" size={20} color="#ef4444" />
          </View>
          <View style={styles.methodContent}>
            <Text style={styles.methodTitle}>Voice Activation (Recommended)</Text>
            <Text style={styles.methodDesc}>
              Say one of the wake phrases above. Works hands-free even when phone is
              in your pocket or bag.
            </Text>
          </View>
        </View>

        <View style={styles.methodCard}>
          <View style={styles.methodIcon}>
            <Ionicons name="radio-button-on" size={20} color="#ef4444" />
          </View>
          <View style={styles.methodContent}>
            <Text style={styles.methodTitle}>SOS Button</Text>
            <Text style={styles.methodDesc}>
              Press the red SOS button in the app or use the floating overlay button
              (Android only). Quick and reliable in any situation.
            </Text>
          </View>
        </View>

        <View style={styles.methodCard}>
          <View style={styles.methodIcon}>
            <Ionicons name="hand-left" size={20} color="#ef4444" />
          </View>
          <View style={styles.methodContent}>
            <Text style={styles.methodTitle}>7-Tap Gesture</Text>
            <Text style={styles.methodDesc}>
              Rapidly tap the screen 7 times anywhere in the app. Silent activation
              method for discreet emergencies.
            </Text>
          </View>
        </View>

        {/* What Happens During SOS */}
        <Text style={styles.sectionTitle}>⚡ WHAT HAPPENS DURING SOS</Text>

        <View style={styles.featureCard}>
          <View style={styles.featureIcon}>
            <Ionicons name="warning" size={24} color="#ef4444" />
          </View>
          <View style={styles.featureContent}>
            <Text style={styles.featureTitle}>Instant Alerts</Text>
            <Text style={styles.featureDesc}>
              All family members get a LOUD alarm with red flashing screen, even if
              their phone is on silent. Alert includes your exact location and name.
            </Text>
          </View>
        </View>

        <View style={styles.featureCard}>
          <View style={styles.featureIcon}>
            <Ionicons name="location" size={24} color="#22c55e" />
          </View>
          <View style={styles.featureContent}>
            <Text style={styles.featureTitle}>Live Location Tracking</Text>
            <Text style={styles.featureDesc}>
              Your GPS location updates every 5 seconds. Family can see where you are
              in real-time on a map. Stops immediately when you cancel SOS.
            </Text>
          </View>
        </View>

        <View style={styles.featureCard}>
          <View style={styles.featureIcon}>
            <Ionicons name="videocam" size={24} color="#3b82f6" />
          </View>
          <View style={styles.featureContent}>
            <Text style={styles.featureTitle}>Live Video Stream</Text>
            <Text style={styles.featureDesc}>
              Your camera automatically starts streaming. Family members can see live
              video from your phone to understand the situation and help faster.
            </Text>
          </View>
        </View>

        <View style={styles.featureCard}>
          <View style={styles.featureIcon}>
            <Ionicons name="notifications" size={24} color="#f59e0b" />
          </View>
          <View style={styles.featureContent}>
            <Text style={styles.featureTitle}>Push Notifications</Text>
            <Text style={styles.featureDesc}>
              Even if family members don't have the app open, they'll receive urgent
              push notifications with your location link.
            </Text>
          </View>
        </View>

        {/* Privacy & Permissions */}
        <Text style={styles.sectionTitle}>🔒 PRIVACY & PERMISSIONS</Text>

        <View style={styles.privacyCard}>
          <Ionicons name="shield-checkmark" size={20} color="#22c55e" />
          <Text style={styles.privacyText}>
            <Text style={styles.privacyBold}>Your Location is Private:{"\n"}</Text>
            • Location is ONLY shared when you trigger SOS{"\n"}
            • NOT shared during normal daily use{"\n"}
            • Automatically stops sharing when you cancel SOS{"\n"}
            • Only visible to your family fleet members
          </Text>
        </View>

        <View style={styles.permissionCard}>
          <Ionicons name="lock-closed" size={18} color="#f59e0b" />
          <Text style={styles.permissionText}>
            <Text style={styles.permissionBold}>Required Permissions:{"\n"}</Text>
            • Location: "Always Allow" - needed for background SOS tracking{"\n"}
            • Microphone: For wake word detection and audio alerts{"\n"}
            • Camera: For live video streaming during emergencies{"\n"}
            • Notifications: To receive SOS alerts from family
          </Text>
        </View>

        {/* Dashboard Features */}
        <Text style={styles.sectionTitle}>📱 RECEIVING AN SOS ALERT</Text>

        <View style={styles.alertStepCard}>
          <View style={styles.stepNumber}>
            <Text style={styles.stepText}>1</Text>
          </View>
          <View style={styles.stepContent}>
            <Text style={styles.stepTitle}>Alarm Plays</Text>
            <Text style={styles.stepDesc}>
              Loud alarm sound, red flashing screen, and vibration. Works even if phone
              is on silent mode.
            </Text>
          </View>
        </View>

        <View style={styles.alertStepCard}>
          <View style={styles.stepNumber}>
            <Text style={styles.stepText}>2</Text>
          </View>
          <View style={styles.stepContent}>
            <Text style={styles.stepTitle}>Tap "View Location"</Text>
            <Text style={styles.stepDesc}>
              Opens dashboard showing family member's live location, battery level, and
              accuracy status.
            </Text>
          </View>
        </View>

        <View style={styles.alertStepCard}>
          <View style={styles.stepNumber}>
            <Text style={styles.stepText}>3</Text>
          </View>
          <View style={styles.stepContent}>
            <Text style={styles.stepTitle}>Watch Live Video</Text>
            <Text style={styles.stepDesc}>
              If available, see live camera feed from their phone to assess the
              situation and coordinate help.
            </Text>
          </View>
        </View>

        <View style={styles.alertStepCard}>
          <View style={styles.stepNumber}>
            <Text style={styles.stepText}>4</Text>
          </View>
          <View style={styles.stepContent}>
            <Text style={styles.stepTitle}>Tap "Acknowledge"</Text>
            <Text style={styles.stepDesc}>
              Stops the alarm and lets other family members know you're aware and
              responding to the emergency.
            </Text>
          </View>
        </View>

        {/* Tips */}
        <Text style={styles.sectionTitle}>💡 IMPORTANT TIPS</Text>

        <View style={styles.tipCard}>
          <Ionicons name="bulb" size={18} color="#fbbf24" />
          <Text style={styles.tipText}>
            Keep the app running in the background for instant alerts. Enable
            "Always Allow" location permission.
          </Text>
        </View>

        <View style={styles.tipCard}>
          <Ionicons name="bulb" size={18} color="#fbbf24" />
          <Text style={styles.tipText}>
            Test the wake words with family members so everyone knows they work. Try
            saying them in different tones and speeds.
          </Text>
        </View>

        <View style={styles.tipCard}>
          <Ionicons name="bulb" size={18} color="#fbbf24" />
          <Text style={styles.tipText}>
            Battery drains faster during active SOS due to GPS and video streaming.
            Keep your phone charged when possible.
          </Text>
        </View>

        <View style={styles.tipCard}>
          <Ionicons name="bulb" size={18} color="#fbbf24" />
          <Text style={styles.tipText}>
            You can cancel a false alarm by tapping "Cancel SOS" in the app. Location
            and video stop sharing immediately.
          </Text>
        </View>

        <View style={styles.tipCard}>
          <Ionicons name="bulb" size={18} color="#fbbf24" />
          <Text style={styles.tipText}>
            Family fleet invite codes start with "F-". Work fleet codes start with
            "W-". Don't share your family code publicly.
          </Text>
        </View>

        <View style={{ height: 40 }} />
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: "#0f172a",
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: "#1e293b",
  },
  backBtn: {
    width: 40,
    height: 40,
    borderRadius: 12,
    backgroundColor: "#1e293b",
    alignItems: "center",
    justifyContent: "center",
  },
  headerTitleWrap: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
  },
  headerTitle: {
    color: "#e2e8f0",
    fontSize: 18,
    fontWeight: "900",
    letterSpacing: 0.5,
  },
  scroll: {
    flex: 1,
  },
  content: {
    padding: 16,
  },
  introCard: {
    backgroundColor: "rgba(34, 197, 94, 0.10)",
    borderWidth: 1,
    borderColor: "rgba(34, 197, 94, 0.25)",
    borderRadius: 16,
    padding: 16,
    marginBottom: 24,
  },
  introTitle: {
    color: "#22c55e",
    fontSize: 16,
    fontWeight: "900",
    marginBottom: 8,
  },
  introText: {
    color: "#94a3b8",
    fontSize: 14,
    lineHeight: 22,
  },
  sectionTitle: {
    color: "#64748b",
    fontSize: 12,
    fontWeight: "900",
    letterSpacing: 1.5,
    marginBottom: 12,
    marginTop: 8,
  },
  wakeWordCard: {
    flexDirection: "row",
    backgroundColor: "rgba(239, 68, 68, 0.12)",
    borderWidth: 2,
    borderColor: "rgba(239, 68, 68, 0.35)",
    borderRadius: 14,
    padding: 16,
    marginBottom: 20,
    gap: 14,
  },
  wakeWordContent: {
    flex: 1,
  },
  wakeWordTitle: {
    color: "#fee2e2",
    fontSize: 15,
    fontWeight: "900",
    marginBottom: 10,
  },
  wakeWordPhrase: {
    color: "#fecaca",
    fontSize: 14,
    fontWeight: "700",
    marginBottom: 6,
    letterSpacing: 0.3,
  },
  wakeWordNote: {
    color: "#fca5a5",
    fontSize: 12,
    lineHeight: 18,
    marginTop: 8,
    fontStyle: "italic",
  },
  methodCard: {
    flexDirection: "row",
    backgroundColor: "#1e293b",
    borderRadius: 12,
    padding: 14,
    marginBottom: 10,
    gap: 12,
  },
  methodIcon: {
    width: 40,
    height: 40,
    borderRadius: 10,
    backgroundColor: "rgba(239, 68, 68, 0.15)",
    alignItems: "center",
    justifyContent: "center",
  },
  methodContent: {
    flex: 1,
  },
  methodTitle: {
    color: "#e2e8f0",
    fontSize: 14,
    fontWeight: "800",
    marginBottom: 4,
  },
  methodDesc: {
    color: "#94a3b8",
    fontSize: 12,
    lineHeight: 18,
  },
  featureCard: {
    flexDirection: "row",
    backgroundColor: "#1e293b",
    borderRadius: 14,
    padding: 14,
    marginBottom: 10,
    gap: 14,
  },
  featureIcon: {
    width: 48,
    height: 48,
    borderRadius: 12,
    backgroundColor: "#0f172a",
    alignItems: "center",
    justifyContent: "center",
  },
  featureContent: {
    flex: 1,
  },
  featureTitle: {
    color: "#e2e8f0",
    fontSize: 15,
    fontWeight: "800",
    marginBottom: 4,
  },
  featureDesc: {
    color: "#94a3b8",
    fontSize: 13,
    lineHeight: 19,
  },
  privacyCard: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 12,
    backgroundColor: "rgba(34, 197, 94, 0.10)",
    borderWidth: 1,
    borderColor: "rgba(34, 197, 94, 0.25)",
    borderRadius: 12,
    padding: 14,
    marginBottom: 12,
  },
  privacyText: {
    flex: 1,
    color: "#d1fae5",
    fontSize: 13,
    lineHeight: 20,
  },
  privacyBold: {
    fontWeight: "900",
    color: "#86efac",
  },
  permissionCard: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 12,
    backgroundColor: "rgba(245, 158, 11, 0.10)",
    borderWidth: 1,
    borderColor: "rgba(245, 158, 11, 0.25)",
    borderRadius: 12,
    padding: 14,
    marginBottom: 20,
  },
  permissionText: {
    flex: 1,
    color: "#fef3c7",
    fontSize: 12,
    lineHeight: 19,
  },
  permissionBold: {
    fontWeight: "900",
    color: "#fde047",
  },
  alertStepCard: {
    flexDirection: "row",
    backgroundColor: "#1e293b",
    borderRadius: 12,
    padding: 12,
    marginBottom: 10,
    gap: 14,
  },
  stepNumber: {
    width: 32,
    height: 32,
    borderRadius: 8,
    backgroundColor: "#3b82f6",
    alignItems: "center",
    justifyContent: "center",
  },
  stepText: {
    color: "#fff",
    fontSize: 16,
    fontWeight: "900",
  },
  stepContent: {
    flex: 1,
  },
  stepTitle: {
    color: "#e2e8f0",
    fontSize: 14,
    fontWeight: "800",
    marginBottom: 4,
  },
  stepDesc: {
    color: "#94a3b8",
    fontSize: 12,
    lineHeight: 18,
  },
  tipCard: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 12,
    backgroundColor: "rgba(251, 191, 36, 0.08)",
    borderWidth: 1,
    borderColor: "rgba(251, 191, 36, 0.20)",
    borderRadius: 12,
    padding: 12,
    marginBottom: 10,
  },
  tipText: {
    flex: 1,
    color: "#fef3c7",
    fontSize: 13,
    lineHeight: 19,
  },
});

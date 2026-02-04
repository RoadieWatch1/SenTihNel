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
import { useNavigation, DrawerActions } from "@react-navigation/native";

export default function FamilyGuideScreen() {
  const navigation = useNavigation();

  const goBackToDrawer = () => {
    navigation.dispatch(DrawerActions.openDrawer());
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
            A Family Fleet is your personal safety network for loved ones. Share your
            invite code with family members so you can see each other's location and
            receive SOS alerts in emergencies.
          </Text>
        </View>

        {/* Features */}
        <Text style={styles.sectionTitle}>FEATURES</Text>

        <View style={styles.featureCard}>
          <View style={styles.featureIcon}>
            <Ionicons name="location" size={24} color="#22c55e" />
          </View>
          <View style={styles.featureContent}>
            <Text style={styles.featureTitle}>Live Location Sharing</Text>
            <Text style={styles.featureDesc}>
              See where your family members are in real-time. Great for knowing when
              someone arrives home safely.
            </Text>
          </View>
        </View>

        <View style={styles.featureCard}>
          <View style={styles.featureIcon}>
            <Ionicons name="warning" size={24} color="#ef4444" />
          </View>
          <View style={styles.featureContent}>
            <Text style={styles.featureTitle}>SOS Alerts</Text>
            <Text style={styles.featureDesc}>
              When a family member triggers an SOS, you'll receive an instant alert
              with their location. Their phone will also start recording.
            </Text>
          </View>
        </View>

        <View style={styles.featureCard}>
          <View style={styles.featureIcon}>
            <Ionicons name="checkmark-circle" size={24} color="#3b82f6" />
          </View>
          <View style={styles.featureContent}>
            <Text style={styles.featureTitle}>Check-Ins</Text>
            <Text style={styles.featureDesc}>
              Family members can send check-ins to let everyone know they're safe.
              You'll see a notification when someone checks in.
            </Text>
          </View>
        </View>

        <View style={styles.featureCard}>
          <View style={styles.featureIcon}>
            <Ionicons name="battery-half" size={24} color="#fbbf24" />
          </View>
          <View style={styles.featureContent}>
            <Text style={styles.featureTitle}>Battery Monitoring</Text>
            <Text style={styles.featureDesc}>
              See battery levels of family members' phones. Get warned when someone's
              battery is running low.
            </Text>
          </View>
        </View>

        {/* Buttons Explained */}
        <Text style={styles.sectionTitle}>BUTTON GUIDE</Text>

        <View style={styles.buttonGuide}>
          <View style={styles.buttonRow}>
            <View style={[styles.buttonDemo, styles.buttonRed]}>
              <Ionicons name="radio" size={16} color="#fee2e2" />
            </View>
            <View style={styles.buttonInfo}>
              <Text style={styles.buttonName}>Panic Button</Text>
              <Text style={styles.buttonExplain}>
                Press and hold to trigger SOS. Alerts all fleet members with your location.
              </Text>
            </View>
          </View>

          <View style={styles.buttonRow}>
            <View style={[styles.buttonDemo, styles.buttonGreen]}>
              <Ionicons name="checkmark" size={16} color="#0b1220" />
            </View>
            <View style={styles.buttonInfo}>
              <Text style={styles.buttonName}>Check-In</Text>
              <Text style={styles.buttonExplain}>
                Tap to let your family know you're safe. Sends a quick "I'm OK" to the fleet.
              </Text>
            </View>
          </View>

          <View style={styles.buttonRow}>
            <View style={[styles.buttonDemo, styles.buttonBlue]}>
              <Ionicons name="share" size={16} color="#bfdbfe" />
            </View>
            <View style={styles.buttonInfo}>
              <Text style={styles.buttonName}>Share Invite Code</Text>
              <Text style={styles.buttonExplain}>
                Share your fleet's invite code with family members so they can join.
              </Text>
            </View>
          </View>

          <View style={styles.buttonRow}>
            <View style={[styles.buttonDemo, styles.buttonGray]}>
              <Ionicons name="eye" size={16} color="#e2e8f0" />
            </View>
            <View style={styles.buttonInfo}>
              <Text style={styles.buttonName}>Live View</Text>
              <Text style={styles.buttonExplain}>
                Opens a map showing the real-time location during an active SOS.
              </Text>
            </View>
          </View>
        </View>

        {/* Tips */}
        <Text style={styles.sectionTitle}>TIPS</Text>

        <View style={styles.tipCard}>
          <Ionicons name="bulb" size={18} color="#fbbf24" />
          <Text style={styles.tipText}>
            Keep the app running in the background for instant SOS alerts.
          </Text>
        </View>

        <View style={styles.tipCard}>
          <Ionicons name="bulb" size={18} color="#fbbf24" />
          <Text style={styles.tipText}>
            Set up your SOS PIN code so only you can cancel a false alarm.
          </Text>
        </View>

        <View style={styles.tipCard}>
          <Ionicons name="bulb" size={18} color="#fbbf24" />
          <Text style={styles.tipText}>
            You can say "Hey Sentinel" to trigger an SOS hands-free.
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
  buttonGuide: {
    backgroundColor: "#1e293b",
    borderRadius: 14,
    padding: 14,
    marginBottom: 24,
  },
  buttonRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 14,
    paddingVertical: 10,
    borderBottomWidth: 1,
    borderBottomColor: "#0f172a",
  },
  buttonDemo: {
    width: 40,
    height: 40,
    borderRadius: 10,
    alignItems: "center",
    justifyContent: "center",
  },
  buttonRed: {
    backgroundColor: "rgba(239, 68, 68, 0.20)",
    borderWidth: 1,
    borderColor: "rgba(239, 68, 68, 0.35)",
  },
  buttonGreen: {
    backgroundColor: "#22c55e",
  },
  buttonBlue: {
    backgroundColor: "rgba(59, 130, 246, 0.20)",
    borderWidth: 1,
    borderColor: "rgba(59, 130, 246, 0.35)",
  },
  buttonGray: {
    backgroundColor: "rgba(148, 163, 184, 0.15)",
    borderWidth: 1,
    borderColor: "rgba(148, 163, 184, 0.25)",
  },
  buttonInfo: {
    flex: 1,
  },
  buttonName: {
    color: "#e2e8f0",
    fontSize: 14,
    fontWeight: "800",
  },
  buttonExplain: {
    color: "#64748b",
    fontSize: 12,
    marginTop: 2,
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

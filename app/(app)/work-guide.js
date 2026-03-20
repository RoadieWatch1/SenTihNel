// 📂 FILE: app/(app)/work-guide.js
// Work Fleet Guide - explains what users can do with Work fleets

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

export default function WorkGuideScreen() {
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
          <Ionicons name="briefcase" size={20} color="#3b82f6" />
          <Text style={styles.headerTitle}>Work Fleet Guide</Text>
        </View>
        <View style={{ width: 40 }} />
      </View>

      <ScrollView style={styles.scroll} contentContainerStyle={styles.content}>
        {/* Intro */}
        <View style={styles.introCard}>
          <Text style={styles.introTitle}>What is a Work Fleet?</Text>
          <Text style={styles.introText}>
            A Work Fleet is designed for businesses to protect employees in the field,
            on job sites, or during work hours. Managers can respond instantly to
            emergencies, track team safety status, and coordinate help when needed.
            Employees get immediate assistance when danger strikes.
          </Text>
        </View>

        {/* Wake Words for ALL Users */}
        <Text style={styles.sectionTitle}>🎤 VOICE-ACTIVATED SOS (ALL USERS)</Text>

        <View style={styles.wakeWordCard}>
          <Ionicons name="mic" size={24} color="#ef4444" />
          <View style={styles.wakeWordContent}>
            <Text style={styles.wakeWordTitle}>Emergency Voice Commands:</Text>
            <Text style={styles.wakeWordPhrase}>• "I'm feeling sick"</Text>
            <Text style={styles.wakeWordPhrase}>• "Where's the bathroom"</Text>
            <Text style={styles.wakeWordPhrase}>• "Please stop"</Text>
            <Text style={styles.wakeWordPhrase}>• "It might rain today"</Text>
            <Text style={styles.wakeWordNote}>
              ⚠️ Say the COMPLETE phrase for hands-free SOS activation. Works even if
              phone is in pocket, toolbelt, or vehicle. Designed for situations where
              you can't reach your phone safely.
            </Text>
          </View>
        </View>

        {/* Manager vs Member */}
        <Text style={styles.sectionTitle}>ROLES IN WORK FLEET</Text>

        <View style={styles.roleCard}>
          <View style={[styles.roleIcon, styles.roleManager]}>
            <Ionicons name="shield-checkmark" size={24} color="#3b82f6" />
          </View>
          <View style={styles.roleContent}>
            <Text style={styles.roleTitle}>Fleet Manager (Owner)</Text>
            <Text style={styles.roleDesc}>
              Can view all team members' SOS alerts, access Work Dashboard for
              analytics, see location during emergencies, and manage team membership.
              Responsible for coordinating emergency response.
            </Text>
          </View>
        </View>

        <View style={styles.roleCard}>
          <View style={[styles.roleIcon, styles.roleMember]}>
            <Ionicons name="person" size={24} color="#22c55e" />
          </View>
          <View style={styles.roleContent}>
            <Text style={styles.roleTitle}>Team Member (Employee)</Text>
            <Text style={styles.roleDesc}>
              Can trigger SOS for emergencies, see other team members' SOS alerts, and
              respond to coworker emergencies. Protected by instant alert system when
              danger occurs.
            </Text>
          </View>
        </View>

        {/* SOS Activation for Workers */}
        <Text style={styles.sectionTitle}>🚨 HOW EMPLOYEES TRIGGER SOS</Text>

        <View style={styles.methodCard}>
          <View style={styles.methodIcon}>
            <Ionicons name="mic" size={20} color="#ef4444" />
          </View>
          <View style={styles.methodContent}>
            <Text style={styles.methodTitle}>Voice Commands</Text>
            <Text style={styles.methodDesc}>
              Use wake phrases when hands are busy, injured, or phone is out of reach.
              Ideal for field workers, drivers, and hazardous situations.
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
              Tap the red SOS button in-app or use floating overlay button (Android).
              Fast activation when you have phone access.
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
              Discreet emergency signal - tap screen 7 times rapidly. Silent activation
              for situations requiring discretion.
            </Text>
          </View>
        </View>

        {/* What Happens During Work SOS */}
        <Text style={styles.sectionTitle}>⚡ WHAT HAPPENS DURING SOS</Text>

        <View style={styles.featureCard}>
          <View style={styles.featureIcon}>
            <Ionicons name="people" size={24} color="#ef4444" />
          </View>
          <View style={styles.featureContent}>
            <Text style={styles.featureTitle}>Team-Wide Alert</Text>
            <Text style={styles.featureDesc}>
              ALL team members and managers get loud alarm with flashing red screen,
              even on silent. Includes employee name and exact location for fast
              response.
            </Text>
          </View>
        </View>

        <View style={styles.featureCard}>
          <View style={styles.featureIcon}>
            <Ionicons name="location" size={24} color="#22c55e" />
          </View>
          <View style={styles.featureContent}>
            <Text style={styles.featureTitle}>GPS Tracking</Text>
            <Text style={styles.featureDesc}>
              Employee's location updates every 5 seconds. Manager can track in
              real-time on dashboard map. Stops when employee cancels SOS or situation
              is resolved.
            </Text>
          </View>
        </View>

        <View style={styles.featureCard}>
          <View style={styles.featureIcon}>
            <Ionicons name="videocam" size={24} color="#3b82f6" />
          </View>
          <View style={styles.featureContent}>
            <Text style={styles.featureTitle}>Live Video Feed</Text>
            <Text style={styles.featureDesc}>
              Camera starts streaming automatically. Managers can view live video to
              assess the emergency, guide response teams, and document incidents.
            </Text>
          </View>
        </View>

        <View style={styles.featureCard}>
          <View style={styles.featureIcon}>
            <Ionicons name="battery-half" size={24} color="#f59e0b" />
          </View>
          <View style={styles.featureContent}>
            <Text style={styles.featureTitle}>Battery & Status</Text>
            <Text style={styles.featureDesc}>
              Dashboard shows employee's battery level and GPS accuracy. Critical for
              planning response and knowing if phone might die.
            </Text>
          </View>
        </View>

        {/* Manager Features */}
        <Text style={styles.sectionTitle}>👔 MANAGER DASHBOARD FEATURES</Text>

        <View style={styles.featureCard}>
          <View style={styles.featureIcon}>
            <Ionicons name="analytics" size={24} color="#3b82f6" />
          </View>
          <View style={styles.featureContent}>
            <Text style={styles.featureTitle}>Work Dashboard</Text>
            <Text style={styles.featureDesc}>
              Access detailed team overview, SOS history, location tracking during
              emergencies, and safety analytics. See who's on-site vs offline.
            </Text>
          </View>
        </View>

        <View style={styles.featureCard}>
          <View style={styles.featureIcon}>
            <Ionicons name="people" size={24} color="#8b5cf6" />
          </View>
          <View style={styles.featureContent}>
            <Text style={styles.featureTitle}>Team Management</Text>
            <Text style={styles.featureDesc}>
              Add employees by sharing work fleet code (starts with "W-"). Remove
              inactive members. Monitor team size and membership status.
            </Text>
          </View>
        </View>

        <View style={styles.featureCard}>
          <View style={styles.featureIcon}>
            <Ionicons name="shield" size={24} color="#22c55e" />
          </View>
          <View style={styles.featureContent}>
            <Text style={styles.featureTitle}>Emergency Coordination</Text>
            <Text style={styles.featureDesc}>
              When SOS triggered, immediately see location, video, and status.
              Coordinate with emergency services, dispatch help, or send nearby
              coworkers to assist.
            </Text>
          </View>
        </View>

        {/* Privacy for Work Fleet */}
        <Text style={styles.sectionTitle}>🔒 EMPLOYEE PRIVACY</Text>

        <View style={styles.privacyCard}>
          <Ionicons name="shield-checkmark" size={20} color="#22c55e" />
          <Text style={styles.privacyText}>
            <Text style={styles.privacyBold}>Location Privacy Protected:{"\n"}</Text>
            • Employees' location is ONLY visible during active SOS{"\n"}
            • NOT tracked during breaks, lunch, or off-hours{"\n"}
            • Automatically stops sharing when SOS is cancelled{"\n"}
            • Managers cannot see location during normal work unless SOS active
          </Text>
        </View>

        <View style={styles.privacyCard}>
          <Ionicons name="business" size={20} color="#3b82f6" />
          <Text style={styles.privacyText}>
            <Text style={styles.privacyBold}>Separate Fleets:{"\n"}</Text>
            Employees can join BOTH work fleet and personal family fleet. Manager only
            sees work fleet data. Family fleet remains completely private from
            workplace.
          </Text>
        </View>

        {/* Buttons Explained */}
        <Text style={styles.sectionTitle}>📱 DASHBOARD BUTTONS (MANAGERS)</Text>

        <View style={styles.buttonGuide}>
          <View style={styles.buttonRow}>
            <View style={[styles.buttonDemo, styles.buttonBlue]}>
              <Ionicons name="grid" size={16} color="#bfdbfe" />
            </View>
            <View style={styles.buttonInfo}>
              <Text style={styles.buttonName}>Work Dashboard</Text>
              <Text style={styles.buttonExplain}>
                Opens manager dashboard with team overview, SOS alerts, and analytics.
              </Text>
            </View>
          </View>

          <View style={styles.buttonRow}>
            <View style={[styles.buttonDemo, styles.buttonGreen]}>
              <Ionicons name="share" size={16} color="#0b1220" />
            </View>
            <View style={styles.buttonInfo}>
              <Text style={styles.buttonName}>Share Work Code</Text>
              <Text style={styles.buttonExplain}>
                Share work fleet invite code (W-xxxxx) with new employees to add them.
              </Text>
            </View>
          </View>

          <View style={styles.buttonRow}>
            <View style={[styles.buttonDemo, styles.buttonRed]}>
              <Ionicons name="warning" size={16} color="#fee2e2" />
            </View>
            <View style={styles.buttonInfo}>
              <Text style={styles.buttonName}>View SOS Alert</Text>
              <Text style={styles.buttonExplain}>
                When employee triggers SOS, tap to see live location, video, and status.
              </Text>
            </View>
          </View>

          <View style={styles.buttonRow}>
            <View style={[styles.buttonDemo, styles.buttonGray]}>
              <Ionicons name="checkmark-circle" size={16} color="#e2e8f0" />
            </View>
            <View style={styles.buttonInfo}>
              <Text style={styles.buttonName}>Acknowledge SOS</Text>
              <Text style={styles.buttonExplain}>
                Tap to stop alarm and let team know you're responding to emergency.
              </Text>
            </View>
          </View>
        </View>

        {/* Employee Section */}
        <Text style={styles.sectionTitle}>👷 FOR EMPLOYEES</Text>

        <View style={styles.employeeCard}>
          <Ionicons name="information-circle" size={20} color="#3b82f6" />
          <Text style={styles.employeeText}>
            <Text style={styles.employeeBold}>Joining Your Work Fleet:{"\n\n"}</Text>
            1. Get the invite code from your manager (starts with "W-"){"\n"}
            2. Open app → Fleet Manager → tap "Switch Fleet"{"\n"}
            3. Enter code and select "Work" as fleet type{"\n"}
            4. Grant permissions (location, mic, camera, notifications){"\n"}
            5. Test voice commands to ensure SOS works
          </Text>
        </View>

        <View style={styles.employeeCard}>
          <Ionicons name="fitness" size={20} color="#22c55e" />
          <Text style={styles.employeeText}>
            <Text style={styles.employeeBold}>Using SOS at Work:{"\n\n"}</Text>
            • Test wake words regularly so you're confident they work{"\n"}
            • Keep phone charged - SOS drains battery faster{"\n"}
            • Enable background location for instant alerts{"\n"}
            • Practice cancelling false alarms (tap "Cancel SOS" in app){"\n"}
            • Know that ALL team members will be alerted when you trigger SOS
          </Text>
        </View>

        {/* Important Tips */}
        <Text style={styles.sectionTitle}>💡 CRITICAL SAFETY TIPS</Text>

        <View style={styles.tipCard}>
          <Ionicons name="bulb" size={18} color="#3b82f6" />
          <Text style={styles.tipText}>
            Managers: Respond to SOS alerts immediately. Delays can cost lives. Have an
            emergency response plan ready.
          </Text>
        </View>

        <View style={styles.tipCard}>
          <Ionicons name="bulb" size={18} color="#3b82f6" />
          <Text style={styles.tipText}>
            Employees: Don't hesitate to trigger SOS if you feel unsafe. False alarm is
            better than no alarm in a real emergency.
          </Text>
        </View>

        <View style={styles.tipCard}>
          <Ionicons name="bulb" size={18} color="#3b82f6" />
          <Text style={styles.tipText}>
            Test the system regularly during safety meetings. Make sure all employees
            know the wake phrases and button locations.
          </Text>
        </View>

        <View style={styles.tipCard}>
          <Ionicons name="bulb" size={18} color="#3b82f6" />
          <Text style={styles.tipText}>
            Work fleet codes (W-) are separate from family codes (F-). Employees can
            safely use both without workplace seeing personal data.
          </Text>
        </View>

        <View style={styles.tipCard}>
          <Ionicons name="bulb" size={18} color="#3b82f6" />
          <Text style={styles.tipText}>
            Battery monitoring is critical for field workers. Manager dashboard shows
            battery levels - remind low-battery employees to charge.
          </Text>
        </View>

        <View style={styles.tipCard}>
          <Ionicons name="bulb" size={18} color="#3b82f6" />
          <Text style={styles.tipText}>
            Live video feed helps managers assess severity and coordinate response.
            Explain to employees this is for their safety, not surveillance.
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
    backgroundColor: "rgba(59, 130, 246, 0.10)",
    borderWidth: 1,
    borderColor: "rgba(59, 130, 246, 0.25)",
    borderRadius: 16,
    padding: 16,
    marginBottom: 24,
  },
  introTitle: {
    color: "#3b82f6",
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
  roleCard: {
    flexDirection: "row",
    backgroundColor: "#1e293b",
    borderRadius: 14,
    padding: 14,
    marginBottom: 10,
    gap: 14,
  },
  roleIcon: {
    width: 48,
    height: 48,
    borderRadius: 12,
    alignItems: "center",
    justifyContent: "center",
  },
  roleManager: {
    backgroundColor: "rgba(59, 130, 246, 0.15)",
  },
  roleMember: {
    backgroundColor: "rgba(34, 197, 94, 0.15)",
  },
  roleContent: {
    flex: 1,
  },
  roleTitle: {
    color: "#e2e8f0",
    fontSize: 15,
    fontWeight: "800",
    marginBottom: 4,
  },
  roleDesc: {
    color: "#94a3b8",
    fontSize: 13,
    lineHeight: 19,
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
  employeeCard: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 12,
    backgroundColor: "rgba(59, 130, 246, 0.08)",
    borderWidth: 1,
    borderColor: "rgba(59, 130, 246, 0.20)",
    borderRadius: 12,
    padding: 14,
    marginBottom: 16,
  },
  employeeText: {
    flex: 1,
    color: "#bfdbfe",
    fontSize: 13,
    lineHeight: 20,
  },
  employeeBold: {
    fontWeight: "900",
    color: "#93c5fd",
  },
  tipCard: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 12,
    backgroundColor: "rgba(59, 130, 246, 0.08)",
    borderWidth: 1,
    borderColor: "rgba(59, 130, 246, 0.20)",
    borderRadius: 12,
    padding: 12,
    marginBottom: 10,
  },
  tipText: {
    flex: 1,
    color: "#bfdbfe",
    fontSize: 13,
    lineHeight: 19,
  },
});

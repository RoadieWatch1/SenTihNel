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
import { useNavigation, DrawerActions } from "@react-navigation/native";

export default function WorkGuideScreen() {
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
            A Work Fleet is designed for businesses to protect employees. Managers can
            monitor team members' safety, track locations during work hours, and receive
            instant SOS alerts from any team member.
          </Text>
        </View>

        {/* Manager vs Member */}
        <Text style={styles.sectionTitle}>ROLES</Text>

        <View style={styles.roleCard}>
          <View style={[styles.roleIcon, styles.roleManager]}>
            <Ionicons name="shield-checkmark" size={24} color="#3b82f6" />
          </View>
          <View style={styles.roleContent}>
            <Text style={styles.roleTitle}>Fleet Manager (Owner)</Text>
            <Text style={styles.roleDesc}>
              Can view all team members, access the Work Dashboard, see detailed
              tracking history, and remove members from the fleet.
            </Text>
          </View>
        </View>

        <View style={styles.roleCard}>
          <View style={[styles.roleIcon, styles.roleMember]}>
            <Ionicons name="person" size={24} color="#22c55e" />
          </View>
          <View style={styles.roleContent}>
            <Text style={styles.roleTitle}>Team Member</Text>
            <Text style={styles.roleDesc}>
              Can see other team members' status, trigger SOS alerts, and send check-ins.
              Cannot access the manager dashboard or remove members.
            </Text>
          </View>
        </View>

        {/* Features */}
        <Text style={styles.sectionTitle}>MANAGER FEATURES</Text>

        <View style={styles.featureCard}>
          <View style={styles.featureIcon}>
            <Ionicons name="analytics" size={24} color="#3b82f6" />
          </View>
          <View style={styles.featureContent}>
            <Text style={styles.featureTitle}>Work Dashboard</Text>
            <Text style={styles.featureDesc}>
              Access detailed analytics, tracking history, and team status overview.
              See who's on-site, traveling, or offline.
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
              Add or remove team members. Share the work fleet invite code with new
              employees to onboard them quickly.
            </Text>
          </View>
        </View>

        <View style={styles.featureCard}>
          <View style={styles.featureIcon}>
            <Ionicons name="time" size={24} color="#f59e0b" />
          </View>
          <View style={styles.featureContent}>
            <Text style={styles.featureTitle}>Location History</Text>
            <Text style={styles.featureDesc}>
              Review past locations and movement patterns. Useful for verifying job
              site visits and responding to incidents.
            </Text>
          </View>
        </View>

        <View style={styles.featureCard}>
          <View style={styles.featureIcon}>
            <Ionicons name="warning" size={24} color="#ef4444" />
          </View>
          <View style={styles.featureContent}>
            <Text style={styles.featureTitle}>Emergency Response</Text>
            <Text style={styles.featureDesc}>
              Receive instant SOS alerts from any team member. Get their exact location
              and coordinate emergency response.
            </Text>
          </View>
        </View>

        {/* Buttons Explained */}
        <Text style={styles.sectionTitle}>DASHBOARD BUTTONS</Text>

        <View style={styles.buttonGuide}>
          <View style={styles.buttonRow}>
            <View style={[styles.buttonDemo, styles.buttonBlue]}>
              <Ionicons name="grid" size={16} color="#bfdbfe" />
            </View>
            <View style={styles.buttonInfo}>
              <Text style={styles.buttonName}>Work Dashboard</Text>
              <Text style={styles.buttonExplain}>
                Opens the manager dashboard with team overview and analytics.
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
                Share the work fleet invite code to add new team members.
              </Text>
            </View>
          </View>

          <View style={styles.buttonRow}>
            <View style={[styles.buttonDemo, styles.buttonGray]}>
              <Ionicons name="swap-horizontal" size={16} color="#e2e8f0" />
            </View>
            <View style={styles.buttonInfo}>
              <Text style={styles.buttonName}>Switch Fleet View</Text>
              <Text style={styles.buttonExplain}>
                Toggle between Work and Family fleet views on the Fleet Manager screen.
              </Text>
            </View>
          </View>

          <View style={styles.buttonRow}>
            <View style={[styles.buttonDemo, styles.buttonRed]}>
              <Ionicons name="remove-circle" size={16} color="#fee2e2" />
            </View>
            <View style={styles.buttonInfo}>
              <Text style={styles.buttonName}>Remove Member</Text>
              <Text style={styles.buttonExplain}>
                Long-press a member card to remove them from the work fleet (managers only).
              </Text>
            </View>
          </View>
        </View>

        {/* Employee Section */}
        <Text style={styles.sectionTitle}>FOR EMPLOYEES</Text>

        <View style={styles.employeeCard}>
          <Ionicons name="information-circle" size={20} color="#3b82f6" />
          <Text style={styles.employeeText}>
            If you're an employee joining a work fleet:{"\n\n"}
            1. Get the invite code from your manager{"\n"}
            2. Go to Fleet Manager and tap "Switch"{"\n"}
            3. Enter the code and select "Work" fleet type{"\n"}
            4. You'll now be visible to your manager during work hours
          </Text>
        </View>

        {/* Privacy Note */}
        <View style={styles.privacyCard}>
          <Ionicons name="shield" size={20} color="#f59e0b" />
          <Text style={styles.privacyText}>
            <Text style={styles.privacyBold}>Privacy Note: </Text>
            Your manager can only see your location while you're in the work fleet.
            You can join a separate Family fleet for personal use that your manager
            cannot access.
          </Text>
        </View>

        {/* Tips */}
        <Text style={styles.sectionTitle}>MANAGER TIPS</Text>

        <View style={styles.tipCard}>
          <Ionicons name="bulb" size={18} color="#3b82f6" />
          <Text style={styles.tipText}>
            Invite codes starting with "W-" are for Work fleets, "F-" for Family.
          </Text>
        </View>

        <View style={styles.tipCard}>
          <Ionicons name="bulb" size={18} color="#3b82f6" />
          <Text style={styles.tipText}>
            Check the Work Dashboard regularly to ensure all team members are checking in.
          </Text>
        </View>

        <View style={styles.tipCard}>
          <Ionicons name="bulb" size={18} color="#3b82f6" />
          <Text style={styles.tipText}>
            Remove inactive members to keep your fleet organized and easy to monitor.
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
  privacyCard: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 12,
    backgroundColor: "rgba(245, 158, 11, 0.08)",
    borderWidth: 1,
    borderColor: "rgba(245, 158, 11, 0.20)",
    borderRadius: 12,
    padding: 14,
    marginBottom: 24,
  },
  privacyText: {
    flex: 1,
    color: "#fef3c7",
    fontSize: 13,
    lineHeight: 20,
  },
  privacyBold: {
    fontWeight: "800",
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

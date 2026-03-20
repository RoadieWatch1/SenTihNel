import React, { useEffect, useState } from "react";
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  ScrollView,
  Alert,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { useRouter } from "expo-router";
import { supabase } from "../../src/lib/supabase";
import Diagnostics from "../../src/components/Diagnostics";
import Paywall from "../../src/components/Paywall";
import { performLogout } from "./_layout";
import { colors, font, radius, space } from "../../src/theme";

export default function SettingsScreen() {
  const router = useRouter();
  const [userEmail, setUserEmail] = useState("");
  const [showDiagnostics, setShowDiagnostics] = useState(false);
  const [showPaywall, setShowPaywall] = useState(false);
  const [loggingOut, setLoggingOut] = useState(false);

  useEffect(() => {
    supabase.auth.getUser().then(({ data }) => {
      if (data?.user?.email) setUserEmail(data.user.email);
    });
  }, []);

  const handleLogout = async () => {
    Alert.alert(
      "Sign Out",
      "Are you sure you want to sign out? This will stop all protection.",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Sign Out",
          style: "destructive",
          onPress: async () => {
            setLoggingOut(true);
            await performLogout(router);
          },
        },
      ]
    );
  };

  if (showDiagnostics) {
    return (
      <SafeAreaView style={styles.screen}>
        <View style={styles.subHeader}>
          <TouchableOpacity onPress={() => setShowDiagnostics(false)} style={styles.backBtn}>
            <Ionicons name="chevron-back" size={22} color={colors.text} />
          </TouchableOpacity>
          <Text style={styles.subHeaderTitle}>System Diagnostics</Text>
        </View>
        <ScrollView contentContainerStyle={{ padding: space.md }}>
          <Diagnostics />
        </ScrollView>
      </SafeAreaView>
    );
  }

  if (showPaywall) {
    return (
      <SafeAreaView style={styles.screen}>
        <View style={styles.subHeader}>
          <TouchableOpacity onPress={() => setShowPaywall(false)} style={styles.backBtn}>
            <Ionicons name="chevron-back" size={22} color={colors.text} />
          </TouchableOpacity>
          <Text style={styles.subHeaderTitle}>Upgrade Plan</Text>
        </View>
        <Paywall onClose={() => setShowPaywall(false)} />
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.screen}>
      <ScrollView showsVerticalScrollIndicator={false}>
        {/* Header */}
        <View style={styles.header}>
          <Text style={styles.title}>Settings</Text>
        </View>

        {/* Profile card */}
        <View style={styles.profileCard}>
          <View style={styles.avatar}>
            <Ionicons name="person" size={26} color={colors.green} />
          </View>
          <View style={{ flex: 1 }}>
            <Text style={styles.profileLabel}>Signed in as</Text>
            <Text style={styles.profileEmail} numberOfLines={1}>{userEmail || "—"}</Text>
          </View>
        </View>

        {/* Section: Protection */}
        <Text style={styles.sectionLabel}>PROTECTION</Text>
        <View style={styles.section}>
          <SettingsRow
            icon="pulse-outline"
            iconColor={colors.blue}
            label="System Diagnostics"
            onPress={() => setShowDiagnostics(true)}
          />
          <View style={styles.divider} />
          <SettingsRow
            icon="shield-half-outline"
            iconColor={colors.green}
            label="Upgrade Plan"
            onPress={() => setShowPaywall(true)}
          />
        </View>

        {/* Section: Guides */}
        <Text style={styles.sectionLabel}>GUIDES</Text>
        <View style={styles.section}>
          <SettingsRow
            icon="home-outline"
            iconColor={colors.green}
            label="Family Fleet Guide"
            sublabel="How to use SenTihNel with family"
            onPress={() => router.push("/(app)/family-guide")}
          />
          <View style={styles.divider} />
          <SettingsRow
            icon="briefcase-outline"
            iconColor={colors.blue}
            label="Work Fleet Guide"
            sublabel="How to use SenTihNel at work"
            onPress={() => router.push("/(app)/work-guide")}
          />
          <View style={styles.divider} />
          <SettingsRow
            icon="grid-outline"
            iconColor={colors.amber}
            label="Manager Dashboard"
            sublabel="Work fleet owner tools"
            onPress={() => router.push("/(app)/manager-dashboard")}
          />
        </View>

        {/* Section: Support */}
        <Text style={styles.sectionLabel}>SUPPORT</Text>
        <View style={styles.section}>
          <SettingsRow
            icon="document-text-outline"
            iconColor={colors.muted}
            label="Privacy Policy"
            onPress={() => Alert.alert("Privacy Policy", "Visit sentihnel.com/privacy for our full privacy policy.")}
          />
          <View style={styles.divider} />
          <SettingsRow
            icon="help-circle-outline"
            iconColor={colors.muted}
            label="Help & Support"
            onPress={() => Alert.alert("Support", "Email support@sentihnel.com for assistance.")}
          />
        </View>

        {/* Version */}
        <Text style={styles.version}>SenTihNel v1.0.0</Text>

        {/* Logout */}
        <TouchableOpacity
          style={[styles.logoutBtn, loggingOut && { opacity: 0.6 }]}
          onPress={handleLogout}
          disabled={loggingOut}
          activeOpacity={0.8}
        >
          <Ionicons name="log-out-outline" size={18} color={colors.red} />
          <Text style={styles.logoutText}>{loggingOut ? "Signing out..." : "Sign Out"}</Text>
        </TouchableOpacity>
      </ScrollView>
    </SafeAreaView>
  );
}

function SettingsRow({ icon, iconColor, label, sublabel, onPress }) {
  return (
    <TouchableOpacity style={styles.row} onPress={onPress} activeOpacity={0.7}>
      <View style={[styles.rowIcon, { backgroundColor: `${iconColor}18` }]}>
        <Ionicons name={icon} size={18} color={iconColor} />
      </View>
      <View style={{ flex: 1 }}>
        <Text style={styles.rowLabel}>{label}</Text>
        {sublabel ? <Text style={styles.rowSublabel}>{sublabel}</Text> : null}
      </View>
      <Ionicons name="chevron-forward" size={16} color={colors.faint} />
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: colors.bg,
  },
  header: {
    paddingHorizontal: space.lg,
    paddingTop: space.xl,
    paddingBottom: space.md,
  },
  title: {
    color: colors.text,
    fontSize: 28,
    fontFamily: font.black,
    letterSpacing: -0.5,
  },
  profileCard: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.sm,
    marginHorizontal: space.md,
    marginBottom: space.lg,
    backgroundColor: colors.surface,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    padding: space.md,
  },
  avatar: {
    width: 48,
    height: 48,
    borderRadius: radius.pill,
    backgroundColor: colors.greenDim,
    alignItems: "center",
    justifyContent: "center",
  },
  profileLabel: {
    color: colors.muted,
    fontSize: 12,
    fontFamily: font.med,
  },
  profileEmail: {
    color: colors.text,
    fontSize: 15,
    fontFamily: font.semi,
    marginTop: 2,
  },
  sectionLabel: {
    color: colors.faint,
    fontSize: 11,
    fontFamily: font.bold,
    letterSpacing: 1.2,
    marginHorizontal: space.lg,
    marginBottom: space.xs,
    marginTop: space.xs,
  },
  section: {
    marginHorizontal: space.md,
    marginBottom: space.lg,
    backgroundColor: colors.surface,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    overflow: "hidden",
  },
  divider: {
    height: 1,
    backgroundColor: colors.border,
    marginLeft: 56,
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    paddingVertical: space.md,
    paddingHorizontal: space.md,
    gap: space.sm,
  },
  rowIcon: {
    width: 34,
    height: 34,
    borderRadius: radius.xs,
    alignItems: "center",
    justifyContent: "center",
  },
  rowLabel: {
    color: colors.text,
    fontSize: 15,
    fontFamily: font.med,
  },
  rowSublabel: {
    color: colors.muted,
    fontSize: 12,
    fontFamily: font.reg,
    marginTop: 2,
  },
  version: {
    color: colors.faint,
    fontSize: 12,
    fontFamily: font.reg,
    textAlign: "center",
    marginBottom: space.lg,
  },
  logoutBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: space.xs,
    marginHorizontal: space.md,
    marginBottom: space.xl,
    paddingVertical: space.md,
    borderRadius: radius.md,
    backgroundColor: colors.redDim,
    borderWidth: 1,
    borderColor: colors.redBorder,
  },
  logoutText: {
    color: colors.red,
    fontSize: 15,
    fontFamily: font.bold,
  },
  subHeader: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: space.md,
    paddingTop: space.md,
    paddingBottom: space.sm,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
    gap: space.xs,
  },
  backBtn: {
    padding: space.xs,
  },
  subHeaderTitle: {
    color: colors.text,
    fontSize: 17,
    fontFamily: font.semi,
  },
});

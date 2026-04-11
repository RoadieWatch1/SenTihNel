import React, { useEffect, useState } from "react";
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  ScrollView,
  Alert,
  Linking,
  ActivityIndicator,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { useRouter } from "expo-router";
import AsyncStorage from "@react-native-async-storage/async-storage";
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
  const [deleting, setDeleting] = useState(false);

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

  const handleDeleteAccount = () => {
    Alert.alert(
      "Delete Account",
      "This will permanently delete your account and all your data — fleets, SOS history, and settings. This cannot be undone.",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Delete Account",
          style: "destructive",
          onPress: () => {
            Alert.alert(
              "Are you sure?",
              "Your account will be permanently deleted. You will be signed out immediately.",
              [
                { text: "Cancel", style: "cancel" },
                {
                  text: "Yes, Delete My Account",
                  style: "destructive",
                  onPress: async () => {
                    setDeleting(true);
                    try {
                      const { data: { user } } = await supabase.auth.getUser();
                      if (user) {
                        const deviceId = await AsyncStorage.getItem("sentinel_device_id").catch(() => null);
                        // Delete all user data from public tables
                        await Promise.allSettled([
                          supabase.from("push_tokens").delete().eq("user_id", user.id),
                          supabase.from("user_sos_pins").delete().eq("user_id", user.id),
                          supabase.from("group_members").delete().eq("user_id", user.id),
                          ...(deviceId ? [
                            supabase.from("devices").delete().eq("device_id", deviceId),
                            supabase.from("tracking_sessions").delete().eq("device_id", deviceId),
                          ] : [
                            supabase.from("devices").delete().eq("user_id", user.id),
                            supabase.from("tracking_sessions").delete().eq("user_id", user.id),
                          ]),
                        ]);
                        // Delete groups the user owns
                        await supabase.from("groups").delete().eq("owner_user_id", user.id);
                        // Delete the auth account via RPC (requires delete_account function in Supabase)
                        const { error: rpcError } = await supabase.rpc("delete_account");
                        if (rpcError) {
                          // RPC not available — fall back to sign out; account deletion completes via webhook
                          console.warn("delete_account RPC not available:", rpcError.message);
                        }
                      }
                    } catch (e) {
                      console.warn("Account deletion error:", e?.message);
                    } finally {
                      setDeleting(false);
                      await performLogout(router);
                    }
                  },
                },
              ]
            );
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
        <ScrollView contentContainerStyle={{ padding: space.md, paddingBottom: 120 }}>
          <Diagnostics onComplete={() => setShowDiagnostics(false)} />
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
    <SafeAreaView style={styles.screen} edges={["top", "left", "right"]}>
      <ScrollView
        showsVerticalScrollIndicator={false}
        contentContainerStyle={styles.scrollContent}
      >
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
            onPress={() => Linking.openURL("https://sentihnel.com/privacy")}
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
          disabled={loggingOut || deleting}
          activeOpacity={0.8}
        >
          <Ionicons name="log-out-outline" size={18} color={colors.red} />
          <Text style={styles.logoutText}>{loggingOut ? "Signing out..." : "Sign Out"}</Text>
        </TouchableOpacity>

        {/* Delete Account */}
        <TouchableOpacity
          style={[styles.deleteBtn, (deleting || loggingOut) && { opacity: 0.6 }]}
          onPress={handleDeleteAccount}
          disabled={deleting || loggingOut}
          activeOpacity={0.8}
        >
          {deleting ? (
            <ActivityIndicator size="small" color={colors.red} />
          ) : (
            <Ionicons name="trash-outline" size={18} color={colors.red} />
          )}
          <Text style={styles.deleteText}>{deleting ? "Deleting account..." : "Delete Account"}</Text>
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
  scrollContent: {
    paddingBottom: 120, // clears the 60px tab bar + iPhone home indicator + breathing room
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
    marginBottom: space.sm,
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
  deleteBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: space.xs,
    marginHorizontal: space.md,
    marginBottom: space.xl,
    paddingVertical: space.md,
    borderRadius: radius.md,
    backgroundColor: "transparent",
    borderWidth: 1,
    borderColor: colors.redBorder,
  },
  deleteText: {
    color: colors.red,
    fontSize: 14,
    fontFamily: font.semi,
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

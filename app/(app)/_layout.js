import React from "react";
import { Drawer } from "expo-router/drawer";
import { View, Text, TouchableOpacity, StyleSheet } from "react-native";
import { supabase } from "../../src/lib/supabase";
import { Ionicons } from "@expo/vector-icons";
import {
  DrawerContentScrollView,
  DrawerItemList,
} from "@react-navigation/drawer";

function CustomDrawerContent(props) {
  const handleLogout = async () => {
    await supabase.auth.signOut();
    // Root AuthGate will route user to /(auth)/auth
  };

  return (
    <View style={styles.drawerContainer}>
      {/* HEADER */}
      <View style={styles.header}>
        <View style={styles.brandRow}>
          <View style={styles.logoDot} />
          <Text style={styles.brand}>SENTIHNEL</Text>
        </View>

        <View style={styles.statusRow}>
          <View style={styles.statusPill}>
            <View style={styles.statusDot} />
            <Text style={styles.statusText}>SHIELD ACTIVE</Text>
          </View>
          <Text style={styles.version}>v1.0.2</Text>
        </View>
      </View>

      {/* NAV ITEMS (this is the correct way) */}
      <DrawerContentScrollView
        {...props}
        contentContainerStyle={styles.scrollContent}
      >
        <View style={styles.navWrap}>
          <DrawerItemList {...props} />
        </View>
      </DrawerContentScrollView>

      {/* FOOTER */}
      <View style={styles.footer}>
        <TouchableOpacity onPress={handleLogout} style={styles.logoutBtn}>
          <Ionicons name="log-out-outline" size={18} color="#ef4444" />
          <Text style={styles.logoutText}>Terminate Session</Text>
        </TouchableOpacity>

        <Text style={styles.footerHint}>
          Tip: keep the app running for maximum protection.
        </Text>
      </View>
    </View>
  );
}

export default function AppLayout() {
  return (
    <Drawer
      drawerContent={(props) => <CustomDrawerContent {...props} />}
      screenOptions={{
        headerShown: false, // stealth
        drawerStyle: {
          backgroundColor: "#0b1220",
          width: 290,
        },
        drawerActiveTintColor: "#22c55e",
        drawerInactiveTintColor: "#94a3b8",
        drawerLabelStyle: {
          fontWeight: "700",
          letterSpacing: 0.5,
        },
        drawerItemStyle: {
          borderRadius: 12,
          marginHorizontal: 12,
          marginVertical: 4,
        },
        sceneContainerStyle: {
          backgroundColor: "#0f172a",
        },
      }}
    >
      {/* These names MUST match files in app/(app)/ */}
      <Drawer.Screen
        name="home"
        options={{
          drawerLabel: "Panic Button",
          title: "Home",
          drawerIcon: ({ color, size }) => (
            <Ionicons name="radio-outline" size={size} color={color} />
          ),
        }}
      />

      <Drawer.Screen
        name="fleet"
        options={{
          drawerLabel: "Fleet Manager",
          title: "Fleet",
          drawerIcon: ({ color, size }) => (
            <Ionicons name="people-outline" size={size} color={color} />
          ),
        }}
      />
    </Drawer>
  );
}

const styles = StyleSheet.create({
  drawerContainer: { flex: 1, backgroundColor: "#0b1220" },

  header: {
    paddingHorizontal: 22,
    paddingTop: 58,
    paddingBottom: 18,
    borderBottomWidth: 1,
    borderBottomColor: "#1e293b",
  },

  brandRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
  },

  logoDot: {
    width: 10,
    height: 10,
    borderRadius: 999,
    backgroundColor: "#22c55e",
    shadowColor: "#22c55e",
    shadowOpacity: 0.35,
    shadowRadius: 10,
    shadowOffset: { width: 0, height: 0 },
  },

  brand: {
    color: "#e2e8f0",
    fontSize: 20,
    fontWeight: "900",
    letterSpacing: 3,
  },

  statusRow: {
    marginTop: 12,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },

  statusPill: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 999,
    backgroundColor: "rgba(34, 197, 94, 0.10)",
    borderWidth: 1,
    borderColor: "rgba(34, 197, 94, 0.25)",
  },

  statusDot: {
    width: 6,
    height: 6,
    borderRadius: 999,
    backgroundColor: "#22c55e",
  },

  statusText: {
    color: "#86efac",
    fontSize: 11,
    fontWeight: "800",
    letterSpacing: 1,
  },

  version: { color: "#475569", fontSize: 12, fontWeight: "700" },

  scrollContent: { paddingTop: 14 },

  navWrap: {
    paddingTop: 8,
  },

  footer: {
    paddingHorizontal: 16,
    paddingTop: 10,
    paddingBottom: 26,
    borderTopWidth: 1,
    borderTopColor: "#1e293b",
  },

  logoutBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingVertical: 12,
    paddingHorizontal: 12,
    borderRadius: 12,
    backgroundColor: "rgba(239, 68, 68, 0.10)",
    borderWidth: 1,
    borderColor: "rgba(239, 68, 68, 0.25)",
  },

  logoutText: { color: "#fecaca", fontWeight: "900", letterSpacing: 0.4 },

  footerHint: { color: "#334155", marginTop: 10, fontSize: 11 },
});

import React, { useEffect, useState, useCallback } from "react";
import { Tabs } from "expo-router";
import { View } from "react-native";
import { useRouter } from "expo-router";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { supabase } from "../../src/lib/supabase";
import { Ionicons } from "@expo/vector-icons";
import SOSAlertOverlay from "../../src/components/SOSAlertOverlay";
import SOSAlertManager from "../../src/services/SOSAlertManager";
import AlarmService from "../../src/services/AlarmService";
import ForegroundService from "../../src/services/ForegroundService";
import { colors, font } from "../../src/theme";

let SecureStore = null;
try { SecureStore = require("expo-secure-store"); } catch {}
import { cancelBatSignal } from "../../src/services/BatSignal";
import { clearSOS, stopLiveTracking } from "../../src/services/LiveTracker";

// Export logout so Settings screen can call it
export async function performLogout(router) {
  try { AlarmService.stopAlarm(); } catch {}
  try { ForegroundService.stopForegroundService(); } catch {}

  const deviceId = await AsyncStorage.getItem("sentinel_device_id").catch(() => null);

  try {
    await Promise.race([
      Promise.allSettled([
        clearSOS().catch(() => {}),
        stopLiveTracking().catch(() => {}),
        cancelBatSignal().catch(() => {}),
        ...(deviceId ? [
          supabase.from("devices").update({ is_active: false }).eq("device_id", deviceId).then(() => {}),
          supabase.from("tracking_sessions").update({ status: "OFFLINE", last_updated: new Date().toISOString() }).eq("device_id", deviceId).then(() => {}),
          supabase.from("push_tokens").delete().eq("device_id", deviceId).then(() => {}),
        ] : []),
        AsyncStorage.removeItem("sentinel_pin_hash").catch(() => {}),
        (async () => { try { if (SecureStore?.deleteItemAsync) await SecureStore.deleteItemAsync("sentinel_pin_hash"); } catch {} })(),
      ]),
      new Promise((r) => setTimeout(r, 2000)),
    ]);
  } catch {}

  try {
    await AsyncStorage.multiRemove([
      "sentinel_group_id",
      "sentinel_invite_code",
      "sentinel_selected_fleet_type",
    ]);
  } catch {}

  try { supabase.removeAllChannels(); } catch {}

  globalThis.__SENTIHNEL_AUTH_REFRESH_ENABLED__ = false;
  try { supabase.auth.stopAutoRefresh(); } catch {}
  try {
    await Promise.race([
      supabase.auth.signOut({ scope: "local" }),
      new Promise((_, reject) => setTimeout(() => reject(new Error("signOut timeout")), 6000)),
    ]);
  } catch (e) {
    try { await supabase.auth.signOut({ scope: "local" }); } catch {}
  }

  try { router.replace("/(auth)/auth"); } catch {}
}

export default function AppLayout() {
  const router = useRouter();
  const [sosAlert, setSosAlert] = useState(null);

  useEffect(() => {
    let mounted = true;

    const initSOSManager = async () => {
      try {
        const deviceId = await AsyncStorage.getItem("sentinel_device_id");

        let allGroupIds = [];
        try {
          const { data: { user } } = await supabase.auth.getUser();
          const userId = user?.id;
          if (userId) {
            const { data: memberData } = await supabase
              .from("group_members")
              .select("group_id")
              .eq("user_id", userId);
            const { data: ownerData } = await supabase
              .from("groups")
              .select("id")
              .eq("owner_user_id", userId);

            const memberIds = (memberData || []).map((r) => r.group_id).filter(Boolean);
            const ownerIds = (ownerData || []).map((r) => r.id).filter(Boolean);
            allGroupIds = Array.from(new Set([...memberIds, ...ownerIds]));
          }
        } catch {}

        if (allGroupIds.length === 0) {
          const fallbackId = await AsyncStorage.getItem("sentinel_group_id");
          if (fallbackId) allGroupIds = [fallbackId];
        }

        if (allGroupIds.length === 0) return;

        await SOSAlertManager.initialize(allGroupIds, deviceId, {
          onSOSReceived: (data) => {
            if (!mounted) return;
            if (data.deviceId && SOSAlertManager.isSuppressed(data.deviceId)) return;
            setSosAlert({
              deviceId: data.deviceId,
              displayName: data.displayName,
              latitude: data.latitude,
              longitude: data.longitude,
            });
            ForegroundService.updateNotification(
              "🚨 SOS ALERT ACTIVE",
              `${data.displayName || "Fleet member"} needs immediate help!`
            ).catch(() => {});
          },
          onSOSCancelled: (deviceId) => {
            if (!mounted) return;
            setSosAlert((prev) => {
              if (!deviceId) return null;
              return prev?.deviceId === deviceId ? null : prev;
            });
            ForegroundService.updateNotification(
              "🛡️ SENTIHNEL SHIELD ACTIVE",
              "Protection running - Location tracking enabled"
            ).catch(() => {});
          },
          onSOSAcknowledged: () => {},
        });

        try {
          await ForegroundService.startForegroundService();
        } catch {}
      } catch (e) {
        console.log("AppLayout: Failed to init SOS manager", e);
      }
    };

    initSOSManager();

    return () => {
      mounted = false;
      SOSAlertManager.cleanup();
      ForegroundService.stopForegroundService().catch(() => {});
    };
  }, []);

  const handleAcknowledge = useCallback(async () => {
    if (sosAlert?.deviceId) {
      await SOSAlertManager.suppressIncident(sosAlert.deviceId);
    }
    const remaining = SOSAlertManager.getUnsuppressedAlerts();
    if (remaining.length > 0) {
      const next = remaining[0];
      setSosAlert({ deviceId: next.device_id, displayName: next.display_name, latitude: next.latitude, longitude: next.longitude });
    } else {
      setSosAlert(null);
    }
  }, [sosAlert]);

  const handleViewLocation = useCallback(async () => {
    if (sosAlert?.deviceId) {
      await SOSAlertManager.suppressIncident(sosAlert.deviceId);
    }
    setSosAlert(null);
    router.push("/fleet");
  }, [router, sosAlert]);

  const handleDismiss = useCallback(async () => {
    await SOSAlertManager.dismissAllAlerts();
    setSosAlert(null);
  }, []);

  return (
    <View style={{ flex: 1, backgroundColor: colors.bg }}>
      <SOSAlertOverlay
        visible={sosAlert !== null}
        senderName={sosAlert?.displayName}
        senderDeviceId={sosAlert?.deviceId}
        onAcknowledge={handleAcknowledge}
        onViewLocation={handleViewLocation}
        onDismiss={handleDismiss}
      />

      <Tabs
        screenOptions={{
          headerShown: false,
          tabBarStyle: {
            backgroundColor: colors.surface,
            borderTopColor: colors.border,
            borderTopWidth: 1,
            height: 60,
            paddingBottom: 8,
            paddingTop: 6,
          },
          tabBarActiveTintColor: colors.green,
          tabBarInactiveTintColor: colors.muted,
          tabBarLabelStyle: {
            fontFamily: font.semi,
            fontSize: 11,
            letterSpacing: 0.3,
          },
          sceneStyle: { backgroundColor: colors.bg },
        }}
      >
        <Tabs.Screen
          name="home"
          options={{
            title: "Shield",
            tabBarIcon: ({ color, size }) => (
              <Ionicons name="shield-checkmark" size={size} color={color} />
            ),
          }}
        />
        <Tabs.Screen
          name="fleet"
          options={{
            title: "Fleet",
            tabBarIcon: ({ color, size }) => (
              <Ionicons name="people" size={size} color={color} />
            ),
          }}
        />
        <Tabs.Screen
          name="settings"
          options={{
            title: "Settings",
            tabBarIcon: ({ color, size }) => (
              <Ionicons name="settings" size={size} color={color} />
            ),
          }}
        />

        {/* Hidden screens — not shown in tab bar */}
        <Tabs.Screen name="manager-dashboard" options={{ href: null }} />
        <Tabs.Screen name="family-guide" options={{ href: null }} />
        <Tabs.Screen name="work-guide" options={{ href: null }} />
      </Tabs>
    </View>
  );
}

// 📂 FILE: app/_layout.js
import React, { useEffect, useRef, useState } from "react";
import { Stack, useRouter, useSegments } from "expo-router";
import { ActivityIndicator, View } from "react-native";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { supabase } from "../src/lib/supabase";
import { handshakeDevice } from "../src/services/deviceHandshake";

// ===============================
// Storage Keys
// ===============================
const STORAGE_KEY_GROUP_ID = "sentinel_group_id";
const STORAGE_KEY_INVITE_CODE = "sentinel_invite_code";
const STORAGE_KEY_PENDING_INVITE = "sentinel_pending_invite_code";
const STORAGE_KEY_POST_LOGIN_ACTION = "sentinel_post_login_action";

export default function RootLayout() {
  return (
    <>
      <Stack screenOptions={{ headerShown: false }}>
        <Stack.Screen name="(auth)" />
        <Stack.Screen name="(app)" />
      </Stack>

      <AuthGate />
    </>
  );
}

function AuthGate() {
  const router = useRouter();
  const segments = useSegments();

  const [booting, setBooting] = useState(true);

  // Prevent redirect spam
  const didRedirectRef = useRef(false);
  const lastRouteRef = useRef("");

  // Prevent handshake spam
  const lastHandshakeKeyRef = useRef("");
  const lastHandshakeAtRef = useRef(0);

  useEffect(() => {
    let isMounted = true;

    const safeReplace = (path) => {
      // avoid hammering the same route
      if (lastRouteRef.current === path) return;
      if (didRedirectRef.current) return;

      didRedirectRef.current = true;
      lastRouteRef.current = path;

      router.replace(path);

      setTimeout(() => {
        didRedirectRef.current = false;
      }, 450);
    };

    const getSession = async () => {
      const { data } = await supabase.auth.getSession();
      return data?.session ?? null;
    };

    const getGroupIdFromDb = async (userId) => {
      if (!userId) return null;
      try {
        const { data, error } = await supabase
          .from("group_members")
          .select("group_id")
          .eq("user_id", userId)
          .limit(1);

        if (error) return null;

        const gid =
          Array.isArray(data) && data.length > 0 && data[0]?.group_id
            ? String(data[0].group_id)
            : null;

        return gid;
      } catch {
        return null;
      }
    };

    const ensureFleetOrSetup = async (session) => {
      const userId = session?.user?.id;
      if (!userId) return { hasFleet: false, groupId: null };

      // 1) Prefer local storage
      let gid = await AsyncStorage.getItem(STORAGE_KEY_GROUP_ID);
      gid = gid ? String(gid) : "";

      // 2) Recover from DB if missing (fresh install / storage wiped)
      if (!gid) {
        const recovered = await getGroupIdFromDb(userId);
        if (recovered) {
          gid = recovered;
          await AsyncStorage.setItem(STORAGE_KEY_GROUP_ID, gid);
        }
      }

      return { hasFleet: !!gid, groupId: gid || null };
    };

    const clearSensitiveStorage = async () => {
      // ✅ IMPORTANT: do NOT clear sentinel_device_id here.
      await AsyncStorage.multiRemove([
        STORAGE_KEY_GROUP_ID,
        STORAGE_KEY_INVITE_CODE,
        STORAGE_KEY_PENDING_INVITE,
        STORAGE_KEY_POST_LOGIN_ACTION,
      ]);
    };

    const resetGateState = () => {
      // resets throttles so next login handshake happens immediately
      lastHandshakeKeyRef.current = "";
      lastHandshakeAtRef.current = 0;
      lastRouteRef.current = "";
      didRedirectRef.current = false;
    };

    // ✅ Phase 1: ensure devices row is aligned when logged in + has fleet
    const maybeHandshake = async (session, groupId) => {
      try {
        const userId = session?.user?.id;
        if (!userId || !groupId) return;

        const key = `${String(userId)}:${String(groupId)}`;
        const now = Date.now();

        // throttle (prevents repeated calls during router transitions)
        if (
          lastHandshakeKeyRef.current === key &&
          now - lastHandshakeAtRef.current < 15_000
        ) {
          return;
        }

        lastHandshakeKeyRef.current = key;
        lastHandshakeAtRef.current = now;

        const res = await handshakeDevice({ groupId });
        if (!res?.ok) {
          console.log("🟡 AuthGate handshake warning:", res?.error || "Unknown error");
        } else {
          console.log("✅ AuthGate handshake OK:", res.deviceId);
        }
      } catch (e) {
        console.log("🟡 AuthGate handshake failed (non-fatal):", e?.message || e);
      }
    };

    const routeFromSession = async () => {
      try {
        const rootSeg = String(segments?.[0] || "");
        const inAuthGroup = rootSeg === "(auth)";
        const inAppGroup = rootSeg === "(app)";

        const session = await getSession();

        // ✅ Not logged in -> must be in auth
        if (!session) {
          await clearSensitiveStorage();
          resetGateState();
          if (!inAuthGroup) safeReplace("/(auth)/auth");
          return;
        }

        // ✅ Logged in -> must have fleet before entering app
        const { hasFleet, groupId } = await ensureFleetOrSetup(session);

        if (!hasFleet) {
          safeReplace("/(auth)/auth?setup=1");
          return;
        }

        // ✅ Handshake on boot when session + fleet exist
        await maybeHandshake(session, groupId);

        // ✅ Logged in + has fleet -> must be in app
        if (!inAppGroup) safeReplace("/(app)/home");
        return;
      } catch (e) {
        safeReplace("/(auth)/auth");
      } finally {
        if (isMounted) setBooting(false);
      }
    };

    // Run on boot + when route group changes
    routeFromSession();

    // Listen for sign-ins/sign-outs (authoritative)
    const { data: authListener } = supabase.auth.onAuthStateChange(
      async (_event, session) => {
        if (!session) {
          await clearSensitiveStorage();
          resetGateState();
          safeReplace("/(auth)/auth");
          return;
        }

        const { hasFleet, groupId } = await ensureFleetOrSetup(session);

        if (!hasFleet) {
          safeReplace("/(auth)/auth?setup=1");
          return;
        }

        // ✅ Handshake after auth restore/sign-in too
        await maybeHandshake(session, groupId);

        safeReplace("/(app)/home");
      }
    );

    return () => {
      isMounted = false;
      authListener?.subscription?.unsubscribe?.();
    };
  }, [segments?.[0], router]);

  if (booting) {
    return (
      <View
        style={{
          flex: 1,
          backgroundColor: "#0b1220",
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <ActivityIndicator size="large" color="#22c55e" />
      </View>
    );
  }

  return null;
}

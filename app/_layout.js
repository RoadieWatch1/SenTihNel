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
      if (lastRouteRef.current === path) return;
      if (didRedirectRef.current) return;

      didRedirectRef.current = true;
      lastRouteRef.current = path;

      router.replace(path);

      setTimeout(() => {
        didRedirectRef.current = false;
      }, 450);
    };

    const stopRefreshAndClearAuth = async () => {
      try {
        // ✅ MUST match storageKey in supabase.js EXACTLY
        await AsyncStorage.removeItem("sentihnel.auth");
      } catch {}

      // ✅ Local signout (don't spam server if token is dead)
      try {
        await supabase.auth.signOut({ scope: "local" });
      } catch {}
    };

    const getSession = async () => {
      const { data, error } = await supabase.auth.getSession();

      if (error) {
        console.log(
          "⚠️ AuthGate: Stale session detected — signing out:",
          error.message
        );
        await stopRefreshAndClearAuth();
        return null;
      }

      return data?.session ?? null;
    };

    const getGroupIdFromDb = async (userId) => {
      if (!userId) return null;

      try {
        const req = supabase
          .from("group_members")
          .select("group_id")
          .eq("user_id", userId)
          .limit(1)
          .maybeSingle();

        const { data, error } = await Promise.race([
          req,
          new Promise((_, reject) =>
            setTimeout(() => reject(new Error("timeout")), 4000)
          ),
        ]);

        if (error) return null;
        return data?.group_id ? String(data.group_id) : null;
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
      await AsyncStorage.multiRemove([
        STORAGE_KEY_GROUP_ID,
        STORAGE_KEY_INVITE_CODE,
        STORAGE_KEY_PENDING_INVITE,
        STORAGE_KEY_POST_LOGIN_ACTION,
      ]);
    };

    const resetGateState = () => {
      lastHandshakeKeyRef.current = "";
      lastHandshakeAtRef.current = 0;
      lastRouteRef.current = "";
      didRedirectRef.current = false;
    };

    const maybeHandshake = async (session, groupId) => {
      try {
        const userId = session?.user?.id;
        if (!userId || !groupId) return;

        const key = `${String(userId)}:${String(groupId)}`;
        const now = Date.now();

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
          console.log(
            "🟡 AuthGate handshake warning:",
            res?.error || "Unknown error"
          );
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

        // ✅ Route FIRST (never block boot on handshake)
        if (!inAppGroup) safeReplace("/(app)/fleet");

        // ✅ Fire-and-forget handshake (do not await)
        maybeHandshake(session, groupId);

        // ✅ Fire-and-forget orphan cleanup
        (async () => {
          try {
            const currentDeviceId = await AsyncStorage.getItem("sentinel_device_id");
            if (currentDeviceId && session?.user?.id) {
              supabase
                .rpc("cleanup_orphaned_devices", {
                  p_user_id: session.user.id,
                  p_current_device_id: currentDeviceId,
                })
                .then(({ data }) => {
                  if (data > 0) {
                    console.log(
                      `✅ Cleaned up ${data} orphaned device(s) from previous installs`
                    );
                  }
                })
                .catch(() => {});
            }
          } catch {}
        })();

        return;
      } catch (e) {
        safeReplace("/(auth)/auth");
      } finally {
        if (isMounted) setBooting(false);
      }
    };

    // Run on boot + when route group changes
    routeFromSession();

    // Listen for sign-ins/sign-outs (authoritative) — just re-run routing
    const { data: authListener } = supabase.auth.onAuthStateChange(async () => {
      routeFromSession();
    });

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

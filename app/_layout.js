import React, { useEffect, useRef, useState } from "react";
import { Stack, useRouter, useSegments } from "expo-router";
import { ActivityIndicator, View } from "react-native";
import { supabase } from "../src/lib/supabase";

export default function RootLayout() {
  return (
    <>
      <Stack screenOptions={{ headerShown: false }}>
        {/* Route fences */}
        <Stack.Screen name="(auth)" />
        <Stack.Screen name="(app)" />
      </Stack>

      {/* Gatekeeper runs above the router */}
      <AuthGate />
    </>
  );
}

function AuthGate() {
  const router = useRouter();
  const segments = useSegments();

  const [booting, setBooting] = useState(true);
  const didRedirectRef = useRef(false); // prevents redirect spam

  useEffect(() => {
    let isMounted = true;

    const safeReplace = (path) => {
      // Avoid infinite replace loops
      if (didRedirectRef.current) return;
      didRedirectRef.current = true;
      router.replace(path);

      // allow future redirects after route settles
      setTimeout(() => {
        didRedirectRef.current = false;
      }, 400);
    };

    const routeFromSession = async () => {
      try {
        // segments might be empty for a split second on boot
        const rootSeg = segments?.[0];
        const inAuthGroup = rootSeg === "(auth)";
        const inAppGroup = rootSeg === "(app)";

        const { data } = await supabase.auth.getSession();
        const session = data?.session ?? null;

        // If user not logged in -> must be in auth
        if (!session) {
          if (!inAuthGroup) safeReplace("/(auth)/auth");
          return;
        }

        // If logged in -> must be in app
        if (session) {
          if (!inAppGroup) safeReplace("/(app)/home");
          return;
        }
      } catch (e) {
        // If something weird happens, fail safe to auth
        safeReplace("/(auth)/auth");
      } finally {
        if (isMounted) setBooting(false);
      }
    };

    // Run on boot + when route group changes
    routeFromSession();

    // Listen for sign-ins/sign-outs (authoritative)
    const { data: authListener } = supabase.auth.onAuthStateChange((_event, session) => {
      // If user signs out -> go auth
      if (!session) safeReplace("/(auth)/auth");
      // If user signs in -> go app
      if (session) safeReplace("/(app)/home");
    });

    return () => {
      isMounted = false;
      authListener?.subscription?.unsubscribe?.();
    };
    // Only depend on the first segment so we don't re-run for deep route changes
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

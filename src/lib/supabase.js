// 📂 FILE: src/lib/supabase.js
import "react-native-url-polyfill/auto";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { AppState, Platform } from "react-native";
import { createClient } from "@supabase/supabase-js";

export const SUPABASE_URL = "https://yjnqyzozvrgajavndgbm.supabase.co";
export const SUPABASE_KEY = "sb_publishable_t3KmD3g6zK3c-4cyzGMrQw_carXwjUq";

export const SUPABASE_ANON_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InlqbnF5em96dnJnYWphdm5kZ2JtIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Njc3Mzk3MjksImV4cCI6MjA4MzMxNTcyOX0.8y7bbX4blhyDxZylhkfKQmgU5TfG2xWs51rSVSl-Bnw";

// ✅ Gate refresh until AuthGate confirms session validity
if (typeof globalThis.__SENTIHNEL_AUTH_REFRESH_ENABLED__ === "undefined") {
  globalThis.__SENTIHNEL_AUTH_REFRESH_ENABLED__ = false;
}

// ✅ RN-safe storage adapter
const rnStorage =
  Platform.OS === "web"
    ? undefined
    : {
        getItem: (key) => AsyncStorage.getItem(key),
        setItem: (key, value) => AsyncStorage.setItem(key, value),
        removeItem: (key) => AsyncStorage.removeItem(key),
      };

function makeClient() {
  return createClient(SUPABASE_URL, SUPABASE_KEY, {
    auth: {
      ...(rnStorage ? { storage: rnStorage } : {}),
      storageKey: "sentihnel.auth",
      autoRefreshToken: false, // AuthGate manually starts it AFTER session is verified
      persistSession: true,
      detectSessionInUrl: false,
    },
  });
}

// ✅ HARD singleton across hot reload / fast refresh
export const supabase =
  globalThis.__SENTIHNEL_SUPABASE_CLIENT__ ?? makeClient();

if (!globalThis.__SENTIHNEL_SUPABASE_CLIENT__) {
  globalThis.__SENTIHNEL_SUPABASE_CLIENT__ = supabase;
}

// ✅ Handle stale/invalid refresh tokens gracefully (best-effort cleanup)
if (!globalThis.__SENTIHNEL_AUTH_ERROR_GUARD__) {
  globalThis.__SENTIHNEL_AUTH_ERROR_GUARD__ = true;

  supabase.auth.onAuthStateChange(async (event, session) => {
    // If refresh logic ever yields no session, clear stored auth.
    if (event === "TOKEN_REFRESHED" && !session) {
      console.log("⚠️ Auth: Token refresh returned no session — clearing stale auth");
      try {
        await AsyncStorage.removeItem("sentihnel.auth");
      } catch {}
    }
  });
}

// ✅ AppState refresh toggling — ONLY after AuthGate enables it
if (Platform.OS !== "web") {
  if (!globalThis.__SENTIHNEL_SUPABASE_APPSTATE__) {
    globalThis.__SENTIHNEL_SUPABASE_APPSTATE__ = AppState.addEventListener(
      "change",
      (state) => {
        if (!globalThis.__SENTIHNEL_AUTH_REFRESH_ENABLED__) return;

        if (state === "active") {
          supabase.auth.startAutoRefresh();
        } else {
          supabase.auth.stopAutoRefresh();
        }
      }
    );
  }
}

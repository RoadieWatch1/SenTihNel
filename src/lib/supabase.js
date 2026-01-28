// 📂 FILE: src/lib/supabase.js
import "react-native-url-polyfill/auto";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { AppState, Platform } from "react-native";
import { createClient } from "@supabase/supabase-js";

export const SUPABASE_URL = "https://yjnqyzozvrgajavndgbm.supabase.co";

// ✅ Keep your current publishable key for the main Supabase client (unchanged)
export const SUPABASE_KEY = "sb_publishable_t3KmD3g6zK3c-4cyzGMrQw_carXwjUq";

// ✅ NEW (Step 1): Add your *Legacy anon key* here (starts with: eyJ...)
// This will be used ONLY for Edge Function "apikey" header (Step 2).
export const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InlqbnF5em96dnJnYWphdm5kZ2JtIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Njc3Mzk3MjksImV4cCI6MjA4MzMxNTcyOX0.8y7bbX4blhyDxZylhkfKQmgU5TfG2xWs51rSVSl-Bnw";

// ✅ RN-safe storage adapter (explicit interface Supabase expects)
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
      // ✅ Make storageKey explicit (easier to debug + avoid collisions)
      storageKey: "sentihnel.auth",
      autoRefreshToken: true,
      persistSession: true,
      detectSessionInUrl: false,
    },
    // 🚫 Do NOT set processLock in RN — it can contribute to session “sticking”
  });
}

// ✅ HARD singleton across hot reload / fast refresh
export const supabase =
  globalThis.__SENTIHNEL_SUPABASE_CLIENT__ ?? makeClient();

if (!globalThis.__SENTIHNEL_SUPABASE_CLIENT__) {
  globalThis.__SENTIHNEL_SUPABASE_CLIENT__ = supabase;
}

// ✅ Register AppState auto-refresh ONCE
if (Platform.OS !== "web") {
  if (!globalThis.__SENTIHNEL_SUPABASE_APPSTATE__) {
    globalThis.__SENTIHNEL_SUPABASE_APPSTATE__ = AppState.addEventListener(
      "change",
      (state) => {
        if (state === "active") {
          supabase.auth.startAutoRefresh();
        } else {
          supabase.auth.stopAutoRefresh();
        }
      }
    );
  }

  // ✅ Ensure refresh starts immediately in active state
  supabase.auth.startAutoRefresh();
}

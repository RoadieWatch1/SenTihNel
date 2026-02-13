// 📂 FILE: src/lib/supabase.js
import "react-native-url-polyfill/auto";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { AppState, Platform } from "react-native";
import { createClient } from "@supabase/supabase-js";

export const SUPABASE_URL = "https://yjnqyzozvrgajavndgbm.supabase.co";

// ✅ Use the ANON (public) key for the client app.
// ❌ Do NOT use service_role in an app. Avoid nonstandard keys here.
export const SUPABASE_ANON_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InlqbnF5em96dnJnYWphdm5kZ2JtIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Njc3Mzk3MjksImV4cCI6MjA4MzMxNTcyOX0.8y7bbX4blhyDxZylhkfKQmgU5TfG2xWs51rSVSl-Bnw";

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
  return createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: {
      ...(rnStorage ? { storage: rnStorage } : {}),
      storageKey: "sentihnel.auth",
      autoRefreshToken: true, // ✅ let the client refresh normally
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

// ✅ Best-effort cleanup for edge cases (stale auth persisted)
// Keep this light — do NOT fight the auth system.
if (!globalThis.__SENTIHNEL_AUTH_ERROR_GUARD__) {
  globalThis.__SENTIHNEL_AUTH_ERROR_GUARD__ = true;

  supabase.auth.onAuthStateChange(async (event, session) => {
    // If we ever end up with no session after a refresh-ish event,
    // wipe the persisted auth so app can recover cleanly.
    if ((event === "TOKEN_REFRESHED" || event === "SIGNED_OUT") && !session) {
      try {
        await AsyncStorage.removeItem("sentihnel.auth");
      } catch {}
    }
  });
}

// ✅ AppState refresh toggling (safe + session-aware)
// This avoids background refresh churn and prevents "dead token" windows after resume.
if (Platform.OS !== "web") {
  if (!globalThis.__SENTIHNEL_SUPABASE_APPSTATE__) {
    globalThis.__SENTIHNEL_SUPABASE_APPSTATE__ = AppState.addEventListener(
      "change",
      async (state) => {
        try {
          const { data } = await supabase.auth.getSession();
          const hasSession = !!data?.session;

          if (!hasSession) {
            try { supabase.auth.stopAutoRefresh(); } catch {}
            return;
          }

          if (state === "active") {
            supabase.auth.startAutoRefresh();

            // Belt-and-suspenders: if close to expiry, refresh right away.
            const expiresAt = data?.session?.expires_at;
            if (expiresAt && expiresAt * 1000 < Date.now() + 60_000) {
              supabase.auth.refreshSession().catch(() => {});
            }
          } else {
            supabase.auth.stopAutoRefresh();
          }
        } catch {
          // If anything fails here, don't crash the app.
          try { supabase.auth.stopAutoRefresh(); } catch {}
        }
      }
    );
  }
}

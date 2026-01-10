// 📂 FILE: app/(auth)/auth.js
import React, { useMemo, useState } from "react";
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  StyleSheet,
  ActivityIndicator,
  Alert,
  KeyboardAvoidingView,
  Platform,
} from "react-native";
import * as Device from "expo-device";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { supabase } from "../../src/lib/supabase";

// ✅ Must match LiveTracker STORAGE_KEY_DEVICE_ID
const STORAGE_KEY_DEVICE_ID = "sentinel_device_id";

/**
 * 🔒 IMPORTANT:
 * We do NOT query `groups` directly (no public SELECT policy).
 * Instead we call a secure RPC:
 *   public.get_group_id_by_invite_code(p_invite_code text) returns uuid
 */
const RPC_GET_GROUP_ID = "get_group_id_by_invite_code";

function makeShortCode(len = 4) {
  const chars = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
  let out = "";
  for (let i = 0; i < len; i++) out += chars[Math.floor(Math.random() * chars.length)];
  return out;
}

async function getOrCreateDeviceId(userIdMaybe) {
  // 1) Reuse stored device_id (keeps tracker + auth consistent)
  const existing = await AsyncStorage.getItem(STORAGE_KEY_DEVICE_ID);
  if (existing) return existing;

  // 2) Otherwise generate a stable-ish id and persist it
  const model = (Device.modelName || "Device").replace(/\s+/g, "");
  const tail = userIdMaybe ? String(userIdMaybe).slice(0, 4).toUpperCase() : makeShortCode(4);
  const code = makeShortCode(4);
  const deviceId = `${model}-${tail}-${code}`;

  await AsyncStorage.setItem(STORAGE_KEY_DEVICE_ID, deviceId);
  return deviceId;
}

/**
 * ✅ Secure group lookup (no public SELECT on groups)
 * Returns: uuid or null
 */
async function resolveGroupIdByInviteCode(inviteCode) {
  const clean = String(inviteCode || "").trim();
  if (!clean) return null;

  const { data, error } = await supabase.rpc(RPC_GET_GROUP_ID, { p_invite_code: clean });

  if (error) {
    console.log("RPC group lookup error:", error.message);
    return null;
  }

  // Supabase returns uuid as string, or null
  return data || null;
}

export default function AuthPage() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [inviteCode, setInviteCode] = useState(""); // 112233
  const [loading, setLoading] = useState(false);
  const [isSignUp, setIsSignUp] = useState(false);

  const title = useMemo(() => (isSignUp ? "Worker Registration" : "System Login"), [isSignUp]);

  const handleAuth = async () => {
    const cleanEmail = email.trim().toLowerCase();
    const cleanCode = inviteCode.trim();

    if (!cleanEmail || !password) {
      Alert.alert("Missing Info", "Please enter email and password.");
      return;
    }

    // Invite code required only on signup (login keeps optional for repair flows)
    if (isSignUp && !cleanCode) {
      Alert.alert("Invite Code Required", "Enter your company Invite Code (ex: 112233).");
      return;
    }

    setLoading(true);

    try {
      if (isSignUp) {
        // 1) Resolve group id securely first (so user gets immediate feedback if code is bad)
        const groupId = await resolveGroupIdByInviteCode(cleanCode);
        if (!groupId) {
          Alert.alert("Invalid Code", "That company code does not exist.");
          return;
        }

        // 2) Sign up user
        const { data: authData, error: authError } = await supabase.auth.signUp({
          email: cleanEmail,
          password,
        });
        if (authError) throw authError;

        const user = authData?.user;

        // If email confirmations are enabled, user may exist but session may be null.
        // Still okay: we can show next-step message.
        if (!user) {
          Alert.alert(
            "Check Email",
            "Your account was created. Please confirm your email, then sign in."
          );
          return;
        }

        // 3) Create membership row (idempotent)
        const { error: joinError } = await supabase.from("group_members").upsert(
          [
            {
              group_id: groupId,
              user_id: user.id,
              role: "worker",
            },
          ],
          { onConflict: "group_id,user_id" }
        );
        if (joinError) throw joinError;

        // 4) Register device row (idempotent)
        const deviceId = await getOrCreateDeviceId(user.id);
        const label = Device.deviceName || Device.modelName || "Worker Phone";

        const { error: deviceError } = await supabase.from("devices").upsert(
          [
            {
              device_id: deviceId,
              user_id: user.id,
              group_id: groupId,
              label,
              last_seen_at: new Date().toISOString(),
            },
          ],
          { onConflict: "device_id" }
        );
        if (deviceError) throw deviceError;

        Alert.alert("Success", "Registered and linked to your company.");
        // AuthGate will route to /(app)/home automatically if session exists.
      } else {
        // SIGN IN
        const { data: loginData, error } = await supabase.auth.signInWithPassword({
          email: cleanEmail,
          password,
        });
        if (error) throw error;

        const user = loginData?.user;
        if (!user) return;

        // Create/restore local deviceId (used by tracker)
        const deviceId = await getOrCreateDeviceId(user.id);

        // Try to see if device already exists (may be blocked by RLS; that's ok)
        const { data: existingDevice, error: deviceCheckError } = await supabase
          .from("devices")
          .select("id, group_id")
          .eq("device_id", deviceId)
          .limit(1);

        const hasDevice = Array.isArray(existingDevice) && existingDevice.length > 0;

        // If missing, allow optional re-link using invite code (still secure via RPC)
        if (!hasDevice && cleanCode) {
          const groupId = await resolveGroupIdByInviteCode(cleanCode);

          if (!groupId) {
            // Don't block login — just explain why tracking may not work
            Alert.alert(
              "Linked Account Needed",
              "Login succeeded, but your device isn't linked to a company. Double-check the invite code."
            );
            return;
          }

          // Link membership + device (idempotent)
          await supabase.from("group_members").upsert(
            [{ group_id: groupId, user_id: user.id, role: "worker" }],
            { onConflict: "group_id,user_id" }
          );

          const label = Device.deviceName || Device.modelName || "Worker Phone";
          await supabase.from("devices").upsert(
            [
              {
                device_id: deviceId,
                user_id: user.id,
                group_id: groupId,
                label,
                last_seen_at: new Date().toISOString(),
              },
            ],
            { onConflict: "device_id" }
          );

          Alert.alert("Linked", "Your device has been linked. Protection will work now.");
        } else if (deviceCheckError) {
          // Not fatal; user is still logged in.
          console.log("Device check warning:", deviceCheckError.message);
        }
      }
    } catch (err) {
      Alert.alert("Error", err?.message || "Something went wrong.");
    } finally {
      setLoading(false);
    }
  };

  return (
    <KeyboardAvoidingView
      style={{ flex: 1, backgroundColor: "#0b1220" }}
      behavior={Platform.OS === "ios" ? "padding" : undefined}
    >
      <View style={styles.container}>
        <Text style={styles.logo}>SENTIHNEL</Text>
        <Text style={styles.subtitle}>{title}</Text>

        <TextInput
          style={styles.input}
          placeholder="Email"
          placeholderTextColor="#64748b"
          value={email}
          onChangeText={setEmail}
          autoCapitalize="none"
          keyboardType="email-address"
        />

        <TextInput
          style={styles.input}
          placeholder="Password"
          placeholderTextColor="#64748b"
          value={password}
          onChangeText={setPassword}
          secureTextEntry
        />

        {/* Invite Code:
            - Required for Sign Up
            - Optional for Sign In (helps repair link)
        */}
        <TextInput
          style={styles.input}
          placeholder={isSignUp ? "Invite Code (ex: 112233)" : "Invite Code (optional)"}
          placeholderTextColor="#64748b"
          value={inviteCode}
          onChangeText={setInviteCode}
          keyboardType="numeric"
        />

        <TouchableOpacity style={styles.button} onPress={handleAuth} disabled={loading}>
          {loading ? (
            <ActivityIndicator color="#fff" />
          ) : (
            <Text style={styles.buttonText}>{isSignUp ? "JOIN FLEET" : "AUTHORIZE"}</Text>
          )}
        </TouchableOpacity>

        <TouchableOpacity onPress={() => setIsSignUp((v) => !v)} disabled={loading}>
          <Text style={styles.toggleText}>
            {isSignUp ? "Already have an account? Sign In" : "New Worker? Sign Up with Code"}
          </Text>
        </TouchableOpacity>

        <Text style={styles.footnote}>Tip: Invite Code is required for first-time registration.</Text>
      </View>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, justifyContent: "center", padding: 30 },
  logo: {
    color: "#22c55e",
    fontSize: 32,
    fontWeight: "bold",
    textAlign: "center",
    letterSpacing: 4,
    marginBottom: 8,
  },
  subtitle: { color: "#94a3b8", textAlign: "center", marginBottom: 26 },

  input: {
    backgroundColor: "#1e293b",
    color: "#fff",
    padding: 15,
    borderRadius: 10,
    marginBottom: 12,
    borderWidth: 1,
    borderColor: "#0f172a",
  },

  button: {
    backgroundColor: "#22c55e",
    padding: 16,
    borderRadius: 10,
    alignItems: "center",
    marginTop: 6,
  },
  buttonText: { color: "#fff", fontWeight: "800", fontSize: 16, letterSpacing: 1 },

  toggleText: { color: "#94a3b8", textAlign: "center", marginTop: 18 },
  footnote: { color: "#334155", textAlign: "center", marginTop: 12, fontSize: 12 },
});

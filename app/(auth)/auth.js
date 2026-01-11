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
import AsyncStorage from "@react-native-async-storage/async-storage";
import { supabase } from "../../src/lib/supabase";
import { getDeviceId } from "../../src/services/Identity";
import { handshakeDevice } from "../../src/services/deviceHandshake";

const STORAGE_KEY_GROUP_ID = "sentinel_group_id";

// RPC names (we will add the SQL later)
const RPC_GET_GROUP_ID = "get_group_id_by_invite_code";
const RPC_CREATE_GROUP = "create_group_with_invite_code";

// ✅ Invite code generator (6 chars with dash)
function generateInviteCode() {
  const p1 = Math.floor(100 + Math.random() * 900); // 100-999
  const p2 = Math.floor(100 + Math.random() * 900); // 100-999
  return `${p1}-${p2}`;
}

// ✅ Secure group lookup via RPC (no direct groups SELECT)
async function resolveGroupIdByInviteCode(inviteCode) {
  const clean = String(inviteCode || "").trim().toUpperCase();
  if (!clean) return null;

  const { data, error } = await supabase.rpc(RPC_GET_GROUP_ID, {
    p_invite_code: clean,
  });

  if (error) {
    console.log("RPC group lookup error:", error.message);
    return null;
  }

  return data || null;
}

export default function AuthPage() {
  const [mode, setMode] = useState("signIn"); // "signIn" | "join" | "create"

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [inviteCode, setInviteCode] = useState("");

  const [loading, setLoading] = useState(false);

  const title = useMemo(() => {
    if (mode === "signIn") return "System Login";
    if (mode === "join") return "Join Existing Fleet";
    return "Create New Fleet";
  }, [mode]);

  const handleAuth = async () => {
    const cleanEmail = email.trim().toLowerCase();
    const cleanCode = inviteCode.trim().toUpperCase();

    if (!cleanEmail || !password) {
      Alert.alert("Missing Info", "Please enter email and password.");
      return;
    }

    if (mode === "join" && !cleanCode) {
      Alert.alert("Invite Code Required", "Enter your fleet invite code.");
      return;
    }

    setLoading(true);

    try {
      // ============================================================
      // 🔵 MODE: SIGN IN
      // ============================================================
      if (mode === "signIn") {
        const { data: loginData, error } = await supabase.auth.signInWithPassword({
          email: cleanEmail,
          password,
        });
        if (error) throw error;

        const user = loginData?.user;
        if (!user) return;

        // 1) Find user's group
        const { data: gmRows, error: gmErr } = await supabase
          .from("group_members")
          .select("group_id")
          .eq("user_id", user.id)
          .limit(1);

        if (gmErr) console.log("group_members fetch warning:", gmErr.message);

        const groupId = Array.isArray(gmRows) && gmRows.length > 0 ? gmRows[0].group_id : null;

        // If no group, allow "repair" using invite code
        if (!groupId) {
          if (!cleanCode) {
            Alert.alert(
              "Invite Code Needed",
              "You’re signed in, but not linked to a fleet. Enter an invite code to activate tracking."
            );
            return;
          }

          const repairedGroupId = await resolveGroupIdByInviteCode(cleanCode);
          if (!repairedGroupId) {
            Alert.alert("Invalid Code", "That invite code does not exist.");
            return;
          }

          // Link membership
          const { error: upErr } = await supabase.from("group_members").upsert(
            [{ group_id: repairedGroupId, user_id: user.id, role: "member" }],
            { onConflict: "group_id,user_id" }
          );
          if (upErr) throw upErr;

          await AsyncStorage.setItem(STORAGE_KEY_GROUP_ID, String(repairedGroupId));
          await handshakeDevice({ groupId: repairedGroupId });

          Alert.alert("Linked", "Your account is now linked to the fleet.");
          return;
        }

        // Normal login success
        await AsyncStorage.setItem(STORAGE_KEY_GROUP_ID, String(groupId));
        await handshakeDevice({ groupId });
        return;
      }

      // ============================================================
      // 🟢 MODE: JOIN or CREATE (Sign Up)
      // ============================================================
      if (mode === "join" || mode === "create") {
        let groupId = null;

        // If joining, validate invite code BEFORE signup
        if (mode === "join") {
          groupId = await resolveGroupIdByInviteCode(cleanCode);
          if (!groupId) {
            Alert.alert("Invalid Code", "That invite code does not exist.");
            return;
          }
        }

        // Sign up
        const { data: authData, error: authError } = await supabase.auth.signUp({
          email: cleanEmail,
          password,
        });
        if (authError) throw authError;

        // ✅ DOORMAN CHECK (email confirmation ON = no session yet)
        // If there is NO session, STOP here. Do NOT write group_members/devices.
        if (!authData?.session) {
          if (mode === "create") {
            Alert.alert(
              "Confirm Email",
              "Account created! Please confirm your email, then come back and LOG IN.\n\nAfter you log in, you can create your fleet and get your invite code."
            );
          } else {
            Alert.alert(
              "Confirm Email",
              "Account created! Please confirm your email, then come back and LOG IN.\n\nAfter login, you will be linked to the fleet."
            );
          }
          return;
        }

        // If session exists, we can safely write to DB
        const user = authData?.user;
        if (!user) throw new Error("No user returned from signup.");

        // If creating, generate invite code and create the group via RPC
        if (mode === "create") {
          const newCode = generateInviteCode();

          const { data: newGroupId, error: createErr } = await supabase.rpc(RPC_CREATE_GROUP, {
            p_invite_code: newCode,
          });

          if (createErr) throw createErr;
          groupId = newGroupId;

          Alert.alert(
            "Fleet Created",
            `Your invite code is:\n\n${newCode}\n\nShare it with your team/family.`
          );
        }

        // If joining, link membership to the group that was resolved
        if (mode === "join") {
          const { error: joinErr } = await supabase.from("group_members").upsert(
            [{ group_id: groupId, user_id: user.id, role: "member" }],
            { onConflict: "group_id,user_id" }
          );
          if (joinErr) throw joinErr;
        }

        // Save group_id locally for tracking
        if (groupId) {
          await AsyncStorage.setItem(STORAGE_KEY_GROUP_ID, String(groupId));
        }

        // Register device
        const deviceId = await getDeviceId();
        const { error: devErr } = await supabase.from("devices").upsert(
          [
            {
              device_id: deviceId,
              user_id: user.id,
              group_id: groupId,
              last_seen_at: new Date().toISOString(),
            },
          ],
          { onConflict: "device_id" }
        );
        if (devErr) throw devErr;

        // Handshake device (needs groupId)
        if (groupId) {
          await handshakeDevice({ groupId });
        }

        Alert.alert("Success", mode === "create" ? "Fleet created." : "Joined fleet.");
        return;
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

        {/* Invite Code input only for JOIN, OR for LOGIN repairs */}
        {(mode === "join" || mode === "signIn") && (
          <TextInput
            style={styles.input}
            placeholder={mode === "join" ? "Invite Code (Required)" : "Invite Code (Optional for repair)"}
            placeholderTextColor="#64748b"
            value={inviteCode}
            onChangeText={setInviteCode}
            keyboardType="default"
            autoCapitalize="characters"
          />
        )}

        <TouchableOpacity style={styles.button} onPress={handleAuth} disabled={loading}>
          {loading ? (
            <ActivityIndicator color="#fff" />
          ) : (
            <Text style={styles.buttonText}>
              {mode === "signIn" ? "LOGIN" : mode === "join" ? "JOIN FLEET" : "CREATE FLEET"}
            </Text>
          )}
        </TouchableOpacity>

        {/* Mode toggles */}
        <View style={styles.toggleRow}>
          <TouchableOpacity onPress={() => setMode("signIn")} disabled={loading}>
            <Text style={[styles.toggleText, mode === "signIn" && styles.activeToggle]}>Login</Text>
          </TouchableOpacity>

          <Text style={styles.divider}>|</Text>

          <TouchableOpacity onPress={() => setMode("join")} disabled={loading}>
            <Text style={[styles.toggleText, mode === "join" && styles.activeToggle]}>Join</Text>
          </TouchableOpacity>

          <Text style={styles.divider}>|</Text>

          <TouchableOpacity onPress={() => setMode("create")} disabled={loading}>
            <Text style={[styles.toggleText, mode === "create" && styles.activeToggle]}>Create</Text>
          </TouchableOpacity>
        </View>

        <Text style={styles.footnote}>
          {mode === "create"
            ? "Create a new fleet and get a unique invite code."
            : mode === "join"
            ? "Join a fleet using the invite code."
            : "Log in to resume protection."}
        </Text>
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

  toggleRow: {
    flexDirection: "row",
    justifyContent: "center",
    alignItems: "center",
    marginTop: 24,
    gap: 15,
  },
  toggleText: { color: "#64748b", fontWeight: "600" },
  activeToggle: { color: "#22c55e", fontWeight: "bold" },
  divider: { color: "#334155" },

  footnote: { color: "#334155", textAlign: "center", marginTop: 20, fontSize: 12 },
});

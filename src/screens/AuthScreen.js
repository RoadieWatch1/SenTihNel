// 📂 FILE: src/screens/AuthScreen.js
import React, { useMemo, useRef, useState } from 'react';
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  StyleSheet,
  Alert,
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  ActivityIndicator,
  Keyboard,
} from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import Constants from 'expo-constants';
import { supabase } from '../services/supabaseClient';

const DEVICE_ID_STORAGE_KEY = 'sentinel_device_id_v1';

export default function AuthScreen({ onLoginSuccess }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);

  const passRef = useRef(null);

  const emailClean = useMemo(() => email.trim().toLowerCase(), [email]);
  const canSubmit = useMemo(() => {
    return emailClean.length > 3 && password.length >= 6 && !loading;
  }, [emailClean, password, loading]);

  const isValidEmail = (v) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v);

  const showFriendlyError = (error) => {
    const msg = (error?.message || '').toLowerCase();

    if (msg.includes('invalid login credentials')) {
      Alert.alert('Login Failed', 'Email or password is incorrect.');
      return;
    }
    if (msg.includes('email not confirmed')) {
      Alert.alert('Email Not Confirmed', 'Please confirm your email, then try again.');
      return;
    }
    if (msg.includes('network') || msg.includes('fetch')) {
      Alert.alert('Connection Problem', 'Check your internet connection and try again.');
      return;
    }

    Alert.alert('Login Failed', error?.message || 'Something went wrong.');
  };

  // ✅ Stable device id (simple + reliable)
  const getStableDeviceId = async () => {
    // Try expo installationId (may be undefined in some builds)
    const installId = Constants?.installationId || null;
    if (installId) return `expo:${installId}`;

    // Fallback: persist a UUID in AsyncStorage
    let stored = await AsyncStorage.getItem(DEVICE_ID_STORAGE_KEY);
    if (!stored) {
      const uuid =
        globalThis?.crypto?.randomUUID?.() ||
        `${Date.now()}-${Math.random().toString(16).slice(2)}`;
      stored = `local:${uuid}`;
      await AsyncStorage.setItem(DEVICE_ID_STORAGE_KEY, stored);
    }
    return stored;
  };

  // ✅ Device handshake after login
  const handshakeDevice = async () => {
    try {
      const { data: userResp, error: userErr } = await supabase.auth.getUser();
      const user = userResp?.user;

      if (userErr || !user) {
        console.warn('Handshake: no user session', userErr?.message);
        return;
      }

      const deviceId = await getStableDeviceId();

      const payload = {
        device_id: deviceId,
        owner_user_id: user.id,
        platform: Platform.OS,
        app_version:
          Constants?.expoConfig?.version ||
          Constants?.manifest2?.version ||
          null,
        last_seen_at: new Date().toISOString(),
        is_active: true,
      };

      const { error } = await supabase
        .from('devices')
        .upsert(payload, { onConflict: 'device_id' });

      if (error) {
        console.warn('Device Handshake Failed:', error.message);
      } else {
        console.log('✅ Device Handshake OK:', deviceId);
      }
    } catch (e) {
      console.warn('Device Handshake Exception:', e?.message || e);
    }
  };

  async function signIn() {
    if (loading) return;

    const e = emailClean;
    const p = password;

    if (!e || !p) {
      Alert.alert('Missing Info', 'Please enter your email and password.');
      return;
    }

    if (!isValidEmail(e)) {
      Alert.alert('Invalid Email', 'Please enter a valid email address.');
      return;
    }

    setLoading(true);
    Keyboard.dismiss();

    try {
      const { data, error } = await supabase.auth.signInWithPassword({
        email: e,
        password: p,
      });

      if (error) {
        showFriendlyError(error);
        return;
      }

      if (!data?.session) {
        Alert.alert('Login Issue', 'Signed in, but no session was returned. Please try again.');
        return;
      }

      // ✅ NEW: Device handshake
      await handshakeDevice();

      onLoginSuccess?.();
    } catch (err) {
      showFriendlyError(err);
    } finally {
      setLoading(false);
    }
  }

  async function forgotPassword() {
    const e = emailClean;

    if (!e) {
      Alert.alert('Enter Email', 'Type your email first, then tap "Forgot password".');
      return;
    }
    if (!isValidEmail(e)) {
      Alert.alert('Invalid Email', 'Please enter a valid email address.');
      return;
    }

    setLoading(true);
    Keyboard.dismiss();

    try {
      const { error } = await supabase.auth.resetPasswordForEmail(e);
      if (error) {
        showFriendlyError(error);
        return;
      }
      Alert.alert('Check Your Email', 'We sent a password reset link to your email.');
    } catch (err) {
      showFriendlyError(err);
    } finally {
      setLoading(false);
    }
  }

  return (
    <KeyboardAvoidingView
      style={styles.screen}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <ScrollView contentContainerStyle={styles.container} keyboardShouldPersistTaps="handled">
        <View style={styles.card}>
          <Text style={styles.logo}>SENTIHNEL</Text>
          <Text style={styles.tagline}>Field Employee Safety Portal</Text>

          <View style={styles.hr} />

          <Text style={styles.label}>Corporate Email</Text>
          <TextInput
            style={styles.input}
            placeholder="name@company.com"
            placeholderTextColor="#64748b"
            value={email}
            onChangeText={setEmail}
            autoCapitalize="none"
            keyboardType="email-address"
            autoCorrect={false}
            textContentType="emailAddress"
            autoComplete="email"
            returnKeyType="next"
            onSubmitEditing={() => passRef.current?.focus?.()}
          />

          <Text style={styles.label}>Password</Text>
          <TextInput
            ref={passRef}
            style={styles.input}
            placeholder="••••••••"
            placeholderTextColor="#64748b"
            value={password}
            onChangeText={setPassword}
            secureTextEntry
            autoCapitalize="none"
            autoCorrect={false}
            textContentType="password"
            autoComplete="password"
            returnKeyType="done"
            onSubmitEditing={signIn}
          />

          <TouchableOpacity
            style={[styles.btn, !canSubmit && styles.btnDisabled]}
            onPress={signIn}
            disabled={!canSubmit}
            activeOpacity={0.85}
          >
            {loading ? (
              <View style={styles.loadingRow}>
                <ActivityIndicator />
                <Text style={styles.btnText}>AUTHENTICATING…</Text>
              </View>
            ) : (
              <Text style={styles.btnText}>SIGN IN</Text>
            )}
          </TouchableOpacity>

          <TouchableOpacity
            onPress={forgotPassword}
            disabled={loading}
            style={styles.linkBtn}
            activeOpacity={0.7}
          >
            <Text style={styles.linkText}>Forgot password?</Text>
          </TouchableOpacity>

          <Text style={styles.footerHint}>
            Tip: For best tracking reliability, enable Background Location and set Battery to Unrestricted.
          </Text>
        </View>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: '#0b1220' },
  container: { flexGrow: 1, justifyContent: 'center', padding: 22 },
  card: {
    backgroundColor: 'rgba(15, 23, 42, 0.92)',
    borderRadius: 18,
    padding: 20,
    borderWidth: 1,
    borderColor: 'rgba(148, 163, 184, 0.18)',
  },
  logo: {
    color: '#22c55e',
    fontSize: 34,
    fontWeight: '900',
    textAlign: 'center',
    letterSpacing: 1.2,
  },
  tagline: { color: '#94a3b8', textAlign: 'center', marginTop: 6, marginBottom: 14 },
  hr: { height: 1, backgroundColor: 'rgba(148, 163, 184, 0.18)', marginBottom: 16 },
  label: {
    color: '#e2e8f0',
    fontSize: 12,
    fontWeight: '800',
    marginBottom: 8,
    letterSpacing: 0.6,
    textTransform: 'uppercase',
  },
  input: {
    backgroundColor: '#0f172a',
    color: '#fff',
    paddingVertical: 14,
    paddingHorizontal: 14,
    borderRadius: 12,
    marginBottom: 14,
    borderWidth: 1,
    borderColor: 'rgba(148, 163, 184, 0.16)',
  },
  btn: {
    backgroundColor: '#22c55e',
    paddingVertical: 16,
    borderRadius: 12,
    alignItems: 'center',
    marginTop: 4,
  },
  btnDisabled: { backgroundColor: '#1e293b' },
  btnText: { color: '#001b0b', fontWeight: '900', fontSize: 16, letterSpacing: 0.5 },
  loadingRow: { flexDirection: 'row', gap: 10, alignItems: 'center' },
  linkBtn: { alignItems: 'center', paddingVertical: 14 },
  linkText: { color: '#60a5fa', fontWeight: '800' },
  footerHint: { color: '#64748b', fontSize: 11, textAlign: 'center', marginTop: 8, lineHeight: 16 },
});

import { Platform } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import Constants from 'expo-constants';
import * as Application from 'expo-application';
import { supabase } from './supabaseClient';

const STORAGE_KEY = 'sentinel_device_id_v1';

async function getStableDeviceId() {
  // 1) Try platform-native stable IDs (best)
  try {
    if (Platform.OS === 'android') {
      const androidId = await Application.getAndroidId();
      if (androidId) return `android:${androidId}`;
    }
    if (Platform.OS === 'ios') {
      const iosId = await Application.getIosIdForVendorAsync();
      if (iosId) return `ios:${iosId}`;
    }
  } catch (_) {}

  // 2) Try Expo installationId (sometimes available)
  const installId =
    Constants?.installationId ||
    Constants?.expoConfig?.extra?.installationId ||
    null;
  if (installId) return `expo:${installId}`;

  // 3) Fallback: persisted UUID
  let stored = await AsyncStorage.getItem(STORAGE_KEY);
  if (!stored) {
    stored = `local:${globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random()}`}`;
    await AsyncStorage.setItem(STORAGE_KEY, stored);
  }
  return stored;
}

export async function handshakeDevice() {
  // Ensure user is real
  const { data: userResp, error: userErr } = await supabase.auth.getUser();
  const user = userResp?.user;

  if (userErr || !user) {
    return { ok: false, error: userErr?.message || 'No authenticated user' };
  }

  const deviceId = await getStableDeviceId();

  const payload = {
    device_id: deviceId,
    owner_user_id: user.id,
    // Optional metadata (nice for admin dashboards)
    platform: Platform.OS,
    app_version: Constants?.expoConfig?.version || Constants?.manifest2?.version || null,
    last_seen_at: new Date().toISOString(),
    is_active: true,
  };

  const { error } = await supabase
    .from('devices')
    .upsert(payload, { onConflict: 'device_id' });

  if (error) return { ok: false, error: error.message, deviceId };

  return { ok: true, deviceId };
}

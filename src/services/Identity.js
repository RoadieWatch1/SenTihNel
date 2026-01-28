// 📂 FILE: src/services/Identity.js
// ✅ SINGLE SOURCE OF TRUTH FOR DEVICE IDENTITY (stable + persistent)
// ✅ FIX: add per-install salt so emulators/clones can't collide on same Android ID

import { Platform } from "react-native";
import AsyncStorage from "@react-native-async-storage/async-storage";
import * as Application from "expo-application";

const KEY = "sentinel_device_id";
const SALT_KEY = "sentinel_device_salt";

// Optional SecureStore (won’t crash if not installed)
function getOptionalSecureStore() {
  try {
    // eslint-disable-next-line no-eval
    const req = eval("require");
    return req("expo-secure-store");
  } catch {
    return null;
  }
}
const SecureStore = getOptionalSecureStore();

// FNV-1a 32-bit hash (fast + deterministic, no native deps)
function fnv1a32(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

// Encode to a nice 8-char base32-ish code (A–Z + 2–7)
function toCode8(base) {
  const ALPH = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  const s = String(base || "");

  const h1 = fnv1a32(s);
  const h2 = fnv1a32(`${s}|sentihnel`);

  // make 40 bits using (h1<<8) + low8(h2)
  let x = (BigInt(h1) << 8n) | BigInt(h2 & 0xff);

  let out = "";
  for (let i = 0; i < 8; i++) {
    out = ALPH[Number(x & 31n)] + out;
    x >>= 5n;
  }
  return out;
}

function safeTrim(v) {
  const s = String(v || "").trim();
  return s.length ? s : null;
}

function randomHex(bytes = 16) {
  // Try crypto.getRandomValues if available
  try {
    const cryptoObj = globalThis?.crypto;
    if (cryptoObj?.getRandomValues) {
      const arr = new Uint8Array(bytes);
      cryptoObj.getRandomValues(arr);
      return Array.from(arr)
        .map((b) => b.toString(16).padStart(2, "0"))
        .join("");
    }
  } catch {
    // ignore
  }

  // Fallback
  const seed = `${Date.now()}|${Math.random()}|${Math.random()}|${Math.random()}`;
  return seed
    .split("")
    .map((c) => c.charCodeAt(0).toString(16))
    .join("")
    .slice(0, bytes * 2)
    .padEnd(bytes * 2, "0");
}

function makeRandomDeviceId() {
  const uuid =
    globalThis?.crypto?.randomUUID?.() ||
    `${Date.now()}-${Math.floor(Math.random() * 1e9)}-${Math.floor(Math.random() * 1e9)}`;
  return `Device-${toCode8(uuid)}`;
}

async function readFromStores(k) {
  // 1) SecureStore first (if available)
  if (SecureStore?.getItemAsync) {
    try {
      const v = await SecureStore.getItemAsync(k);
      const t = safeTrim(v);
      if (t) return t;
    } catch {}
  }

  // 2) AsyncStorage
  try {
    const v = await AsyncStorage.getItem(k);
    const t = safeTrim(v);
    if (t) return t;
  } catch {}

  return null;
}

async function writeToStores(k, v) {
  const val = String(v || "").trim();

  // Best-effort: write both
  try {
    await AsyncStorage.setItem(k, val);
  } catch (e) {
    console.log(`Identity: unable to persist ${k} to AsyncStorage:`, e?.message || e);
  }

  if (SecureStore?.setItemAsync) {
    try {
      await SecureStore.setItemAsync(k, val);
    } catch (e) {
      console.log(`Identity: unable to persist ${k} to SecureStore:`, e?.message || e);
    }
  }
}

function isBadAndroidId(id) {
  const v = String(id || "").trim().toLowerCase();
  // Known problematic / placeholder-ish IDs often seen in emulators/clones
  return (
    !v ||
    v === "unknown" ||
    v === "android_id" ||
    v === "0000000000000000" ||
    v === "9774d56d682e549c"
  );
}

async function getOrCreateSalt() {
  const existing = await readFromStores(SALT_KEY);
  if (existing) return existing;

  const salt = `salt:${randomHex(16)}`;
  await writeToStores(SALT_KEY, salt);
  return salt;
}

/**
 * Returns a stable device identifier.
 *
 * ✅ RULES:
 * - ALWAYS return stored KEY first (never change once set).
 * - If missing, compute Device-XXXXXXXX from (stable native ID + per-install salt).
 *   This prevents emulator/cloned devices from colliding.
 * - Persist it immediately (so every file uses the exact same value).
 */
export async function getDeviceId() {
  // 0) Always return stored device id first (single source of truth)
  const existing = await readFromStores(KEY);
  if (existing) return existing;

  // 1) Per-install salt to avoid collisions across emulators/clones
  const salt = await getOrCreateSalt();

  let base = null;

  // 2) Best: stable native IDs
  try {
    if (Platform.OS === "android") {
      const androidId = await Application.getAndroidId();
      if (androidId && !isBadAndroidId(androidId)) base = `android:${androidId}`;
    } else if (Platform.OS === "ios") {
      const iosId = await Application.getIosIdForVendorAsync();
      if (iosId) base = `ios:${iosId}`;
    }
  } catch (err) {
    console.log("Identity: native device ID unavailable:", err?.message || err);
  }

  // 3) Deterministic device id from base + salt (or random fallback)
  const computed = base ? `Device-${toCode8(`${base}|${salt}`)}` : makeRandomDeviceId();

  // 4) Persist so it becomes the single source of truth
  await writeToStores(KEY, computed);

  return computed;
}

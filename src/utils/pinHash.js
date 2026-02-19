// 📂 FILE: src/utils/pinHash.js
// Shared PIN hashing + user-scoped storage key builders.
// Used by FakeLockScreen.js (SOS cancel PIN pad) and fleet.js (PIN setup modal).

/**
 * Deterministic PIN hash — must produce the same output as the SQL verify_user_sos_pin RPC.
 * Not cryptographically strong but consistent across app versions.
 */
export const hashPin = (pin) => {
  let hash = 0;
  const str = String(pin || "");
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash; // Convert to 32-bit integer
  }
  return `pin_${Math.abs(hash).toString(16).padStart(8, "0")}`;
};

/**
 * User-scoped AsyncStorage / SecureStore key for the PIN hash.
 * Falls back to the legacy unscoped key if userId is not available
 * (e.g., offline or pre-auth state).
 */
export const pinHashKey = (userId) =>
  userId ? `sentinel_pin_hash:${userId}` : "sentinel_pin_hash";

/**
 * User-scoped key for the PIN lockout timestamp (ms since epoch).
 */
export const pinLockKey = (userId) =>
  userId ? `sentinel_pin_lock_until:${userId}` : "sentinel_pin_lock_until";

/**
 * User-scoped key for the PIN lockout level (exponential backoff tier).
 */
export const pinLockLevelKey = (userId) =>
  userId ? `sentinel_pin_lock_level:${userId}` : "sentinel_pin_lock_level";

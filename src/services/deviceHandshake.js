// 📂 FILE: src/services/deviceHandshake.js
// ✅ Phase 1: SCHEMA-SAFE DEVICE HANDSHAKE + SINGLE SOURCE OF TRUTH DEVICE ID
// ✅ Goal: devices.device_id MUST match tracking_sessions.device_id (AsyncStorage sentinel_device_id)
//
// OPTION B (Movable device ownership):
// - Device can be re-claimed by whoever is logged in
// - Requires SECURITY DEFINER RPC: register_or_move_device(p_device_id, p_group_id, p_display_name)
//
// CRITICAL FIX (Jan 2026):
// - NEVER accept out_device_id from RPC as “truth”.
// - The only canonical device_id is AsyncStorage sentinel_device_id.
// - If RPC returns a different out_device_id, that indicates the RPC is incorrectly mapping devices,
//   and we FAIL HARD to prevent “Phone B becomes Phone A”.
//
// Additional hardening:
// - Per-user display name storage (matches updated auth.js)
// - Verify current user is a member of group before handshake
// - Serialize handshake to avoid racing calls
// - Verify auth user remains same before/after RPC

import { supabase } from "../lib/supabase";
import { getDeviceId as getStableDeviceId } from "./Identity";
import AsyncStorage from "@react-native-async-storage/async-storage";

const STORAGE_KEY_DEVICE_ID = "sentinel_device_id";
const STORAGE_KEY_GROUP_ID = "sentinel_group_id";

// legacy global display name (kept for backward compatibility)
const STORAGE_KEY_DEVICE_NAME_LEGACY = "sentinel_device_display_name";

// per-user display name key prefix (matches updated auth.js)
const DEVICE_NAME_PREFIX = "sentinel_device_display_name:";

let handshakeInFlight = null;

function normalizeRpcRow(data) {
  if (Array.isArray(data)) return data[0] || null;
  if (data && typeof data === "object") return data;
  return null;
}

function looksLikeSignatureMismatch(msgLower) {
  return (
    (msgLower.includes("function") &&
      msgLower.includes("register_or_move_device") &&
      msgLower.includes("does not exist")) ||
    (msgLower.includes("no function matches") &&
      msgLower.includes("register_or_move_device")) ||
    (msgLower.includes("could not find the function") &&
      msgLower.includes("register_or_move_device"))
  );
}

function shortDevice(deviceId) {
  const s = String(deviceId || "").trim();
  if (!s) return "Unknown";
  if (s.length <= 8) return s;
  return `${s.slice(0, 4)}…${s.slice(-3)}`;
}

function titleizeEmailLocal(local) {
  const raw = String(local || "").trim();
  if (!raw) return "";

  const parts = raw
    .replace(/[^a-zA-Z0-9._-]/g, " ")
    .split(/[\s._-]+/g)
    .filter(Boolean);

  if (parts.length === 0) return "";

  return parts
    .slice(0, 3)
    .map((p) => p.charAt(0).toUpperCase() + p.slice(1).toLowerCase())
    .join(" ");
}

function deriveDisplayName({ user, deviceId }) {
  const meta = user?.user_metadata || {};
  const mName =
    (meta?.full_name && String(meta.full_name).trim()) ||
    (meta?.name && String(meta.name).trim()) ||
    (meta?.display_name && String(meta.display_name).trim()) ||
    "";

  if (mName) return mName;

  const email = user?.email ? String(user.email).trim() : "";
  if (email.includes("@")) {
    const local = email.split("@")[0];
    const nice = titleizeEmailLocal(local);
    if (nice) return nice;
    if (local) return local;
  }

  return `Member • ${shortDevice(deviceId)}`;
}

function getDeviceNameKeyForUser(userId) {
  if (!userId) return STORAGE_KEY_DEVICE_NAME_LEGACY;
  return `${DEVICE_NAME_PREFIX}${userId}`;
}

function isUuidish(v) {
  const s = String(v || "").trim();
  // loose UUID v4-ish check (good enough for guarding obvious junk)
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);
}

async function safeGetAuthedUser() {
  try {
    const { data, error } = await supabase.auth.getUser();
    if (error) return null;
    return data?.user || null;
  } catch {
    return null;
  }
}

async function safeWait(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitForMembership(userId, groupId, { tries = 6, delayMs = 250 } = {}) {
  if (!userId || !groupId) return false;

  for (let i = 0; i < tries; i++) {
    try {
      // Check membership
      const { data, error } = await supabase
        .from("group_members")
        .select("group_id")
        .eq("user_id", userId)
        .eq("group_id", groupId)
        .limit(1);

      if (!error && Array.isArray(data) && data.length > 0) return true;

      // ✅ Also check if user OWNS this fleet
      const { data: ownerData, error: ownerError } = await supabase
        .from("groups")
        .select("id")
        .eq("id", groupId)
        .eq("owner_user_id", userId)
        .limit(1);

      if (!ownerError && Array.isArray(ownerData) && ownerData.length > 0) {
        console.log("✅ handshakeDevice: User is OWNER of fleet, allowing handshake");
        return true;
      }

      // if RLS blocks reads later, we don't want infinite loops — break and let handshake proceed
      if (error) {
        console.log("🟡 handshakeDevice membership check warning:", error.message);
        return true; // best-effort: don't block app if RLS isn't ready yet
      }
    } catch (e) {
      console.log("🟡 handshakeDevice membership check exception:", e?.message || e);
      return true;
    }

    // eslint-disable-next-line no-await-in-loop
    await safeWait(delayMs);
  }

  return false;
}

/**
 * Handshake the device into the `devices` table using SECURITY DEFINER RPC.
 *
 * @param {Object} opts
 * @param {string=} opts.groupId Optional group_id to attach (preferred)
 * @param {string=} opts.deviceId Optional override (rare)
 * @param {string=} opts.displayName Optional override (preferred)
 * @param {boolean=} opts.allowFallbackUpsert Defaults false. Only set true if RPC is missing.
 */
export async function handshakeDevice(opts = {}) {
  // serialize to avoid racing calls from multiple screens/services
  if (handshakeInFlight) {
    return handshakeInFlight;
  }

  handshakeInFlight = (async () => {
    const {
      groupId: groupIdOverride = null,
      deviceId: deviceIdOverride = null,
      displayName: displayNameOverride = null,
      allowFallbackUpsert = false,
    } = opts;

    try {
      // 1) Ensure user is real (server-validated)
      const userBefore = await safeGetAuthedUser();
      if (!userBefore?.id) {
        return { ok: false, error: "No authenticated user" };
      }

      // 2) ✅ SINGLE SOURCE OF TRUTH for device_id
      let deviceId = deviceIdOverride || (await AsyncStorage.getItem(STORAGE_KEY_DEVICE_ID));
      if (!deviceId) deviceId = await getStableDeviceId();

      deviceId = String(deviceId || "").trim();
      if (!deviceId) {
        return { ok: false, error: "Device ID unavailable" };
      }

      // Always persist trimmed device_id
      await AsyncStorage.setItem(STORAGE_KEY_DEVICE_ID, deviceId);

      // 3) Resolve group_id (required)
      let groupId = groupIdOverride || (await AsyncStorage.getItem(STORAGE_KEY_GROUP_ID));
      groupId = String(groupId || "").trim();

      if (!groupId) {
        return { ok: false, error: "Missing groupId (sentinel_group_id)", deviceId };
      }

      if (!isUuidish(groupId)) {
        return { ok: false, error: `Invalid groupId format: ${groupId}`, deviceId, groupId };
      }

      // If override provided, keep storage in sync to prevent stale fleet reuse
      if (groupIdOverride && String(groupIdOverride).trim()) {
        await AsyncStorage.setItem(STORAGE_KEY_GROUP_ID, String(groupIdOverride).trim());
      }

      // 4) ✅ Verify membership (prevents accidental use of stale groupId)
      const isMember = await waitForMembership(userBefore.id, groupId, { tries: 6, delayMs: 220 });
      if (!isMember) {
        return {
          ok: false,
          error:
            "Handshake blocked: user is not a member of this fleet (prevents stale group_id takeover).",
          deviceId,
          groupId,
        };
      }

      // 5) ✅ Display name
      // Only resolve + send a name when explicitly provided (login/signup flows).
      // Maintenance handshakes (tab switch, GPS sync) pass null so the SQL
      // preserves whatever name is already in the devices table.
      const overrideName = String(displayNameOverride || "").trim();
      let displayName = null;

      if (overrideName) {
        // Explicit override from auth flow → use it and persist
        displayName = overrideName;
        const perUserKey = getDeviceNameKeyForUser(userBefore.id);
        try {
          await AsyncStorage.setItem(perUserKey, displayName);
          await AsyncStorage.setItem(STORAGE_KEY_DEVICE_NAME_LEGACY, displayName);
        } catch {}
      }

      // 6) ✅ Preferred path: SECURITY DEFINER RPC
      const authUidBeforeRpc = userBefore.id;

      const { data, error } = await supabase.rpc("register_or_move_device", {
        p_device_id: deviceId,
        p_group_id: groupId,
        p_display_name: displayName || null,
      });

      if (!error) {
        const row = normalizeRpcRow(data);

        // 🚨 CRITICAL GUARD: refuse to adopt any out_device_id that differs
        const outDeviceId = row?.out_device_id ? String(row.out_device_id).trim() : null;
        const outGroupId = row?.out_group_id ? String(row.out_group_id).trim() : null;
        const outUserId = row?.out_user_id ? String(row.out_user_id).trim() : null;

        if (outDeviceId && outDeviceId !== deviceId) {
          console.log("🚨 handshakeDevice BLOCKED: RPC returned mismatched out_device_id", {
            deviceId,
            outDeviceId,
            groupId,
            outGroupId,
            userId: authUidBeforeRpc,
            outUserId,
          });

          return {
            ok: false,
            error:
              "Server handshake returned a different device_id. Blocking to prevent device identity takeover.",
            deviceId,
            groupId,
            displayName,
            usedRpc: true,
            data: row || data,
          };
        }

        if (outGroupId && outGroupId !== groupId) {
          console.log("🚨 handshakeDevice BLOCKED: RPC returned mismatched out_group_id", {
            groupId,
            outGroupId,
            deviceId,
            userId: authUidBeforeRpc,
            outUserId,
          });

          return {
            ok: false,
            error:
              "Server handshake returned a different group_id. Blocking to prevent wrong-fleet attachment.",
            deviceId,
            groupId,
            displayName,
            usedRpc: true,
            data: row || data,
          };
        }

        // ✅ Verify auth user did not change during handshake (should never happen)
        const userAfter = await safeGetAuthedUser();
        const authUidAfterRpc = userAfter?.id || null;
        if (authUidAfterRpc && authUidAfterRpc !== authUidBeforeRpc) {
          console.log("🚨 handshakeDevice BLOCKED: auth changed during handshake", {
            authUidBeforeRpc,
            authUidAfterRpc,
          });
          return {
            ok: false,
            error: "Auth session changed during device handshake. Blocking to prevent account mixing.",
            deviceId,
            groupId,
            displayName,
            usedRpc: true,
            data: row || data,
          };
        }

        if (outUserId && outUserId !== authUidBeforeRpc) {
          console.log("🟡 handshakeDevice warning: RPC returned different out_user_id than session user", {
            authUidBeforeRpc,
            outUserId,
          });
          // Do NOT fail here (some RPCs may not return it correctly), but we never adopt it.
        }

        // ✅ ALWAYS return the canonical local deviceId/groupId
        return {
          ok: true,
          deviceId,
          groupId,
          displayName,
          usedRpc: true,
          data: row || data,
        };
      }

      // If RPC signature mismatch (older 2-arg only), retry without display name
      const msgLower = String(error?.message || "").toLowerCase();
      if (looksLikeSignatureMismatch(msgLower)) {
        const retry = await supabase.rpc("register_or_move_device", {
          p_device_id: deviceId,
          p_group_id: groupId,
        });

        if (!retry.error) {
          const row = normalizeRpcRow(retry.data);

          const outDeviceId = row?.out_device_id ? String(row.out_device_id).trim() : null;
          const outGroupId = row?.out_group_id ? String(row.out_group_id).trim() : null;

          if (outDeviceId && outDeviceId !== deviceId) {
            return {
              ok: false,
              error:
                "Server handshake returned a different device_id (2-arg RPC). Blocking to prevent identity takeover.",
              deviceId,
              groupId,
              displayName,
              usedRpc: true,
              data: row || retry.data,
            };
          }

          if (outGroupId && outGroupId !== groupId) {
            return {
              ok: false,
              error:
                "Server handshake returned a different group_id (2-arg RPC). Blocking wrong-fleet attachment.",
              deviceId,
              groupId,
              displayName,
              usedRpc: true,
              data: row || retry.data,
            };
          }

          const userAfter = await safeGetAuthedUser();
          if (userAfter?.id && userAfter.id !== userBefore.id) {
            return {
              ok: false,
              error: "Auth session changed during device handshake. Blocking.",
              deviceId,
              groupId,
              displayName,
              usedRpc: true,
              data: row || retry.data,
            };
          }

          return {
            ok: true,
            deviceId,
            groupId,
            displayName,
            usedRpc: true,
            data: row || retry.data,
          };
        }

        return {
          ok: false,
          error: retry.error?.message || "register_or_move_device failed",
          deviceId,
          groupId,
          usedRpc: true,
        };
      }

      return {
        ok: false,
        error: error?.message || "register_or_move_device failed",
        deviceId,
        groupId,
        usedRpc: true,
      };
    } catch (e) {
      // 7) Optional fallback (off by default)
      if (!opts?.allowFallbackUpsert) {
        return { ok: false, error: e?.message || String(e) };
      }

      try {
        const user = await safeGetAuthedUser();
        if (!user?.id) {
          return { ok: false, error: "No authenticated user" };
        }

        let deviceId = opts.deviceId || (await AsyncStorage.getItem(STORAGE_KEY_DEVICE_ID));
        deviceId = String(deviceId || "").trim();
        if (!deviceId) return { ok: false, error: "Device ID unavailable" };

        let groupId = opts.groupId || (await AsyncStorage.getItem(STORAGE_KEY_GROUP_ID));
        groupId = String(groupId || "").trim();
        if (!groupId) return { ok: false, error: "Missing groupId", deviceId };

        const overrideName = String(opts.displayName || "").trim();
        let displayName = null;

        if (overrideName) {
          displayName = overrideName;
          const perUserKey = getDeviceNameKeyForUser(user.id);
          try {
            await AsyncStorage.setItem(perUserKey, displayName);
            await AsyncStorage.setItem(STORAGE_KEY_DEVICE_NAME_LEGACY, displayName);
          } catch {}
        }

        const payload = {
          device_id: deviceId,
          user_id: user.id,
          group_id: groupId,
          is_active: true,
          last_seen_at: new Date().toISOString(),
          ...(displayName ? { display_name: displayName } : {}),
        };

        const upsertRes = await supabase.from("devices").upsert([payload], {
          onConflict: "device_id",
        });

        if (upsertRes?.error) {
          return {
            ok: false,
            error:
              upsertRes.error.message ||
              "Devices upsert blocked. Use register_or_move_device RPC.",
            deviceId,
            groupId,
            usedRpc: false,
          };
        }

        return { ok: true, deviceId, groupId, displayName, usedRpc: false };
      } catch (fallbackErr) {
        return { ok: false, error: fallbackErr?.message || String(fallbackErr) };
      }
    } finally {
      // release lock
      handshakeInFlight = null;
    }
  })();

  return handshakeInFlight;
}

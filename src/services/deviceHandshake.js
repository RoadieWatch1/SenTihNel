// 📂 FILE: src/services/deviceHandshake.js
// ✅ SCHEMA-SAFE DEVICE HANDSHAKE (NO label column)

import { supabase } from "../lib/supabase";
import { getDeviceId } from "./Identity";

/**
 * Handshake the device into the `devices` table.
 * Uses only confirmed columns.
 *
 * @param {Object} opts
 * @param {string=} opts.groupId Optional group_id to attach
 */
export async function handshakeDevice(opts = {}) {
  const { groupId = null } = opts;

  // 1) Ensure user is real
  const { data: userResp, error: userErr } = await supabase.auth.getUser();
  const user = userResp?.user;

  if (userErr || !user) {
    return { ok: false, error: userErr?.message || "No authenticated user" };
  }

  // 2) Get stable device id (single source of truth)
  const deviceId = await getDeviceId();

  // 3) Minimal payload — ONLY columns that exist
  const payload = {
    device_id: deviceId,
    user_id: user.id,
    last_seen_at: new Date().toISOString(),
  };

  if (groupId) payload.group_id = groupId;

  // 4) Upsert (idempotent)
  const { error } = await supabase
    .from("devices")
    .upsert([payload], { onConflict: "device_id" });

  if (error) return { ok: false, error: error.message, deviceId };

  return { ok: true, deviceId };
}

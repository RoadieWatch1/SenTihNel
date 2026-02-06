// Agora RTC Token Server
// Generates short-lived Agora tokens for authenticated fleet members only.
// Prevents unauthorized access to video/audio channels.

import { serve } from "std/http/server";
import { createClient } from "@supabase/supabase-js";
import { AccessToken2, ServiceRtc } from "./AccessToken2.ts";

const VERSION = "2026-02-06-v1";
const DEFAULT_EXPIRE_SECONDS = 3600; // 1 hour
const MAX_EXPIRE_SECONDS = 86400; // 24 hours

const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, apikey, content-type, x-client-info",
  "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
};

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...CORS_HEADERS },
  });
}

serve(async (req: Request) => {
  // ── CORS preflight ──────────────────────────────────────
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: CORS_HEADERS });
  }

  // ── Environment ─────────────────────────────────────────
  const supabaseUrl =
    Deno.env.get("SB_URL") ?? Deno.env.get("SUPABASE_URL") ?? "";
  const supabaseKey =
    Deno.env.get("SB_SERVICE_ROLE_KEY") ??
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ??
    "";
  const agoraAppId = Deno.env.get("AGORA_APP_ID") ?? "";
  const agoraCert = Deno.env.get("AGORA_APP_CERTIFICATE") ?? "";

  // ── Health check ────────────────────────────────────────
  if (req.method === "GET") {
    return json({
      ok: true,
      VERSION,
      hasAppId: !!agoraAppId,
      hasCert: !!agoraCert,
    });
  }

  if (req.method !== "POST") {
    return json({ error: "Method not allowed" }, 405);
  }

  // ── Validate config ─────────────────────────────────────
  if (!supabaseUrl || !supabaseKey) {
    console.error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
    return json({ error: "Server misconfigured" }, 500);
  }
  if (!agoraAppId || !agoraCert) {
    console.error("Missing AGORA_APP_ID or AGORA_APP_CERTIFICATE");
    return json({ error: "Server misconfigured" }, 500);
  }

  // ── Auth: verify JWT ────────────────────────────────────
  const authHeader = req.headers.get("Authorization") ?? "";
  const jwt = authHeader.replace("Bearer ", "").trim();
  if (!jwt) {
    return json({ error: "Missing authorization" }, 401);
  }

  try {
    const supabase = createClient(supabaseUrl, supabaseKey);

    const {
      data: { user },
      error: authError,
    } = await supabase.auth.getUser(jwt);

    if (authError || !user) {
      return json({ error: "Invalid or expired token" }, 401);
    }

    // ── Parse body ──────────────────────────────────────
    const body = await req.json().catch(() => ({}));
    const deviceId =
      typeof body.device_id === "string" ? body.device_id.trim() : "";
    const uid = typeof body.uid === "number" ? body.uid : 0;
    const role =
      body.role === "publisher" ? "publisher" : ("subscriber" as const);
    const expireSeconds =
      typeof body.expire === "number"
        ? Math.min(Math.max(body.expire, 60), MAX_EXPIRE_SECONDS)
        : DEFAULT_EXPIRE_SECONDS;

    if (!deviceId) {
      return json({ error: "device_id is required" }, 400);
    }

    // ── Authorization: device exists + user is in fleet ─
    const { data: device, error: devErr } = await supabase
      .from("devices")
      .select("device_id, group_id, user_id")
      .eq("device_id", deviceId)
      .single();

    if (devErr || !device) {
      return json({ error: "Device not found" }, 404);
    }

    // Check group membership
    const { count: memberCount } = await supabase
      .from("group_members")
      .select("id", { count: "exact", head: true })
      .eq("group_id", device.group_id)
      .eq("user_id", user.id);

    if ((memberCount ?? 0) === 0) {
      return json({ error: "Not authorized for this device's fleet" }, 403);
    }

    // ── Generate Agora RTC token ────────────────────────
    const nowTs = Math.floor(Date.now() / 1000);
    const privilegeExpireTs = nowTs + expireSeconds;

    const token = new AccessToken2(
      agoraAppId,
      agoraCert,
      nowTs,
      expireSeconds
    );
    const serviceRtc = new ServiceRtc(deviceId, uid);

    serviceRtc.add_privilege(
      ServiceRtc.kPrivilegeJoinChannel,
      privilegeExpireTs
    );

    if (role === "publisher") {
      serviceRtc.add_privilege(
        ServiceRtc.kPrivilegePublishAudioStream,
        privilegeExpireTs
      );
      serviceRtc.add_privilege(
        ServiceRtc.kPrivilegePublishVideoStream,
        privilegeExpireTs
      );
      serviceRtc.add_privilege(
        ServiceRtc.kPrivilegePublishDataStream,
        privilegeExpireTs
      );
    }

    token.add_service(serviceRtc);
    const builtToken = token.build();

    if (!builtToken) {
      console.error("Token build returned empty string — check APP_ID/CERT");
      return json({ error: "Token generation failed" }, 500);
    }

    return json({
      token: builtToken,
      app_id: agoraAppId,
      channel: deviceId,
      uid,
      expires_in: expireSeconds,
    });
  } catch (e: unknown) {
    const err = e instanceof Error ? e : new Error(String(e));
    console.error("agora-token error:", err.message);
    return json({ error: err.message }, 500);
  }
});

// supabase/functions/send-sos-notifications/index.ts
import { serve } from "std/http/server";
import { createClient } from "@supabase/supabase-js";

// ============================================
// VERSION (deploy verification)
// ============================================

const VERSION = "2026-01-29-debugstamp-2";

// ============================================
// CONFIGURATION
// ============================================

const EXPO_PUSH_URL = "https://exp.host/--/api/v2/push/send";
const BATCH_SIZE = 100; // Expo recommends max 100 per request
const ANDROID_CHANNEL_ID = "sos_alerts"; // must match the in-app channel name

// ============================================
// TYPES
// ============================================

interface SOSPayload {
  device_id: string;
  display_name?: string;
  latitude?: number;
  longitude?: number;
  timestamp?: string;
  group_id: string;
}

interface PushToken {
  device_id: string;
  push_token: string;
  platform: "ios" | "android";
}

interface ExpoPushMessage {
  to: string;
  title: string;
  body: string;
  data: Record<string, unknown>;
  sound: "default";
  priority: "high";
  channelId?: string;
  badge?: number;
}

type SendResult = { success: boolean; sent: number; error?: string };

type QueueProcessResult = {
  processed: number;
  errors: number;
  debug?: Record<string, unknown>;
};

// ============================================
// HELPERS
// ============================================

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function isExpoToken(token: string): boolean {
  return (
    typeof token === "string" &&
    (token.startsWith("ExponentPushToken") || token.startsWith("ExpoPushToken"))
  );
}

function asError(e: unknown): Error {
  return e instanceof Error ? e : new Error(String(e));
}

function safeStringify(x: unknown) {
  try {
    return JSON.stringify(x);
  } catch {
    return String(x);
  }
}

function getDebugFlag(req: Request) {
  const url = new URL(req.url);
  return url.searchParams.get("debug") === "1";
}

// ============================================
// MAIN HANDLER
// ============================================

serve(async (req: Request) => {
  const debugMode = getDebugFlag(req);

  // You set these as SB_URL / SB_SERVICE_ROLE_KEY because CLI blocks SUPABASE_*
  const supabaseUrl = Deno.env.get("SB_URL") ?? Deno.env.get("SUPABASE_URL");
  const supabaseKey =
    Deno.env.get("SB_SERVICE_ROLE_KEY") ?? Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

  const hasUrl = !!supabaseUrl;
  const hasServiceKey = !!supabaseKey;

  // Health check (requires auth header unless you change function auth settings)
  if (req.method === "GET") {
    return json({
      ok: true,
      VERSION,
      hasUrl,
      hasServiceKey,
    });
  }

  if (req.method !== "POST") {
    return json({ error: `Method ${req.method} not allowed.` }, 405);
  }

  if (!supabaseUrl || !supabaseKey) {
    return json(
      debugMode
        ? {
            success: false,
            sent: 0,
            error: "Missing SB_URL or SB_SERVICE_ROLE_KEY (or SUPABASE_* equivalents).",
            debug: { VERSION, hasUrl, hasServiceKey },
          }
        : {
            success: false,
            sent: 0,
            error: "Missing SB_URL or SB_SERVICE_ROLE_KEY (or SUPABASE_* equivalents).",
          },
      500
    );
  }

  try {
    const supabase = createClient(supabaseUrl, supabaseKey) as any;

    const body = await req.json().catch(() => ({}));

    // 1) Allow processing a specific queue id for debugging
    const queueIdFromBody =
      typeof body?.queue_id === "string" && body.queue_id.length > 0 ? body.queue_id : null;

    // 2) Direct payload send support (manual invoke)
    const directPayload: SOSPayload | null =
      body?.payload && typeof body.payload === "object" ? (body.payload as SOSPayload) : null;

    // If direct payload provided => send immediately
    if (directPayload) {
      if (!directPayload.group_id || !directPayload.device_id) {
        return json(
          debugMode
            ? {
                success: false,
                sent: 0,
                error: "Invalid payload: group_id and device_id required.",
                debug: { VERSION, hasUrl, hasServiceKey, mode: "directPayload-invalid" },
              }
            : { success: false, sent: 0, error: "Invalid payload: group_id and device_id required." },
          400
        );
      }

      const result = await sendSOSNotifications(supabase, directPayload);

      if (debugMode) {
        return json({
          ...result,
          debug: {
            VERSION,
            hasUrl,
            hasServiceKey,
            mode: "directPayload",
            group_id: directPayload.group_id,
            sender_device_id: directPayload.device_id,
          },
        });
      }

      return json(result);
    }

    // Otherwise process queue (optionally one item)
    const result = await processNotificationQueue(supabase, {
      queueId: queueIdFromBody,
      debug: debugMode,
    });

    // ALWAYS include debug when debugMode=1
    if (debugMode) {
      return json({
        processed: result.processed,
        errors: result.errors,
        debug: {
          VERSION,
          hasUrl,
          hasServiceKey,
          ...(result.debug ?? {}),
        },
      });
    }

    return json(result);
  } catch (e: unknown) {
    const err = asError(e);
    console.error("Error in send-sos-notifications:", err);

    return json(
      debugMode
        ? {
            processed: 0,
            errors: 1,
            debug: {
              VERSION,
              hasUrl,
              hasServiceKey,
              topLevelError: err.message,
            },
          }
        : { processed: 0, errors: 1 },
      500
    );
  }
});

// ============================================
// NOTIFICATION FUNCTIONS
// ============================================

async function sendSOSNotifications(supabase: any, payload: SOSPayload): Promise<SendResult> {
  const { device_id, display_name, latitude, longitude, group_id, timestamp } = payload;

  console.log(`Sending SOS notifications for device ${device_id} in group ${group_id}`);

  const { data: tokens, error: tokenError } = await supabase
    .from("push_tokens")
    .select("device_id, push_token, platform")
    .eq("group_id", group_id)
    .neq("device_id", device_id);

  if (tokenError) {
    console.error("Error fetching push tokens:", tokenError);
    return { success: false, sent: 0, error: tokenError.message };
  }

  if (!tokens || tokens.length === 0) {
    console.log("No push tokens found for group");
    return { success: true, sent: 0 };
  }

  const messages: ExpoPushMessage[] = (tokens as PushToken[])
    .filter((t) => isExpoToken(t.push_token))
    .map((t) => ({
      to: t.push_token,
      title: "🚨 SOS ALERT",
      body: `${display_name || "A fleet member"} needs immediate help!`,
      data: {
        type: "sos",
        device_id,
        display_name: display_name ?? null,
        latitude: latitude ?? null,
        longitude: longitude ?? null,
        timestamp: timestamp ?? null,
        group_id,
      },
      sound: "default",
      priority: "high",
      ...(t.platform === "android" ? { channelId: ANDROID_CHANNEL_ID } : {}),
      badge: 1,
    }));

  if (messages.length === 0) {
    console.log("No valid Expo push tokens (expected ExponentPushToken[...] / ExpoPushToken[...])");
    return { success: true, sent: 0 };
  }

  let totalSent = 0;
  const errors: string[] = [];

  for (let i = 0; i < messages.length; i += BATCH_SIZE) {
    const batch = messages.slice(i, i + BATCH_SIZE);

    try {
      const response = await fetch(EXPO_PUSH_URL, {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Accept-Encoding": "gzip, deflate",
          "Content-Type": "application/json",
        },
        body: JSON.stringify(batch),
      });

      const result = (await response.json().catch(() => null)) as
        | { data?: Array<{ status: string; message?: string; details?: unknown }> }
        | { errors?: unknown }
        | null;

      if (!response.ok) {
        errors.push(`Expo HTTP ${response.status}: ${safeStringify(result)}`);
        continue;
      }

      if (!result || !("data" in result) || !Array.isArray((result as any).data)) {
        errors.push(`Expo returned unexpected response: ${safeStringify(result)}`);
        continue;
      }

      const data = (result as any).data as Array<{ status: string; message?: string }>;
      totalSent += data.filter((r) => r.status === "ok").length;

      data.forEach((r, idx) => {
        if (r.status === "error") {
          const msg = r.message || "Unknown push error";
          console.error(`Push error for ${batch[idx]?.to}: ${msg}`);
          errors.push(msg);
        }
      });
    } catch (e: unknown) {
      const err = asError(e);
      console.error("Batch send error:", err);
      errors.push(err.message);
    }
  }

  console.log(`Sent ${totalSent}/${messages.length} notifications`);

  return {
    success: errors.length === 0,
    sent: totalSent,
    error: errors.length > 0 ? errors.join("; ") : undefined,
  };
}

async function processNotificationQueue(
  supabase: any,
  opts: { queueId: string | null; debug: boolean }
): Promise<QueueProcessResult> {
  const debug: Record<string, unknown> = {};
  try {
    let query = supabase.from("sos_notification_queue").select("*");

    if (opts.queueId) {
      query = query.eq("id", opts.queueId);
      debug.mode = "singleQueueId";
      debug.queue_id = opts.queueId;
    } else {
      query = query.eq("status", "pending").order("created_at", { ascending: true }).limit(10);
      debug.mode = "pendingBatch";
    }

    const { data, error } = await query;

    if (error || !data) {
      console.error("Error fetching queue:", error);
      return {
        processed: 0,
        errors: 1,
        ...(opts.debug ? { debug: { ...debug, queueFetchError: error?.message ?? "unknown" } } : {}),
      };
    }

    const items = data as Array<any>;
    debug.fetched = items.length;

    let processed = 0;
    let errorsCount = 0;

    for (const item of items) {
      const id = item.id as string;
      const payload = item.payload as SOSPayload;

      // mark processing
      const { error: markErr } = await supabase
        .from("sos_notification_queue")
        .update({ status: "processing" })
        .eq("id", id);

      if (markErr) {
        errorsCount++;
        if (opts.debug) debug[`queue_${id}_mark_processing_error`] = markErr.message;

        // best-effort mark failed (don’t crash if this fails)
        await supabase
          .from("sos_notification_queue")
          .update({
            status: "failed",
            error_message: `Failed to mark processing: ${markErr.message}`,
            processed_at: new Date().toISOString(),
          })
          .eq("id", id);

        continue;
      }

      const result = await sendSOSNotifications(supabase, payload);

      const { error: updErr } = await supabase
        .from("sos_notification_queue")
        .update({
          status: result.success ? "sent" : "failed",
          error_message: result.error ?? null,
          processed_at: new Date().toISOString(),
        })
        .eq("id", id);

      if (updErr) {
        errorsCount++;
        if (opts.debug) debug[`queue_${id}_update_status_error`] = updErr.message;
        continue;
      }

      if (result.success) processed++;
      else errorsCount++;

      if (opts.debug) {
        debug[`queue_${id}_sent`] = result.sent;
        if (!result.success) debug[`queue_${id}_send_error`] = result.error ?? "unknown";
      }
    }

    return { processed, errors: errorsCount, ...(opts.debug ? { debug } : {}) };
  } catch (e: unknown) {
    const err = asError(e);
    console.error("Queue processing exception:", err);
    return {
      processed: 0,
      errors: 1,
      ...(opts.debug ? { debug: { ...debug, exception: err.message } } : {}),
    };
  }
}

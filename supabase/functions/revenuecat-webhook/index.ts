/**
 * RevenueCat Webhook Handler
 *
 * This Edge Function receives webhook events from RevenueCat and syncs
 * subscription status to the Supabase subscriptions table.
 *
 * Setup:
 * 1. Deploy this function: supabase functions deploy revenuecat-webhook
 * 2. Get function URL: https://<project-ref>.supabase.co/functions/v1/revenuecat-webhook
 * 3. Add webhook URL in RevenueCat Dashboard > Project Settings > Integrations > Webhooks
 * 4. Set REVENUECAT_WEBHOOK_SECRET in Supabase Dashboard > Project Settings > Edge Functions > Secrets
 */

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// Types for RevenueCat webhook events
interface RevenueCatEvent {
  api_version: string;
  event: {
    type: string;
    id: string;
    app_user_id: string;
    original_app_user_id: string;
    aliases: string[];
    product_id: string;
    entitlement_ids: string[];
    period_type: string;
    purchased_at_ms: number;
    expiration_at_ms: number | null;
    environment: string;
    store: string;
    is_trial_period?: boolean;
    cancellation_reason?: string;
    subscriber_attributes?: Record<string, { value: string; updated_at_ms: number }>;
  };
}

// Event types we care about
const SUBSCRIPTION_EVENTS = [
  "INITIAL_PURCHASE",
  "RENEWAL",
  "PRODUCT_CHANGE",
  "CANCELLATION",
  "UNCANCELLATION",
  "EXPIRATION",
  "BILLING_ISSUE",
  "SUBSCRIPTION_PAUSED",
  "SUBSCRIPTION_EXTENDED",
];

Deno.serve(async (req) => {
  // Only accept POST requests
  if (req.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }

  try {
    // Verify webhook signature (optional but recommended)
    const webhookSecret = Deno.env.get("REVENUECAT_WEBHOOK_SECRET");
    if (webhookSecret) {
      const signature = req.headers.get("Authorization");
      if (signature !== `Bearer ${webhookSecret}`) {
        console.error("Invalid webhook signature");
        return new Response("Unauthorized", { status: 401 });
      }
    }

    // Parse the webhook payload
    const payload: RevenueCatEvent = await req.json();
    const event = payload.event;

    console.log(`Received RevenueCat event: ${event.type} for user: ${event.app_user_id}`);

    // Skip events we don't care about
    if (!SUBSCRIPTION_EVENTS.includes(event.type)) {
      console.log(`Skipping event type: ${event.type}`);
      return new Response(JSON.stringify({ received: true, skipped: true }), {
        headers: { "Content-Type": "application/json" },
      });
    }

    // Initialize Supabase client with service role key (bypasses RLS)
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(supabaseUrl, supabaseServiceKey);

    // The app_user_id should be the Supabase user UUID (set during RevenueCat.logIn)
    const userId = event.app_user_id;

    // Validate UUID format
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (!uuidRegex.test(userId)) {
      console.error(`Invalid user ID format: ${userId}`);
      return new Response(JSON.stringify({
        received: true,
        error: "Invalid user ID format - expected UUID"
      }), {
        headers: { "Content-Type": "application/json" },
      });
    }

    // Determine subscription status based on event type
    let status: string;
    let expiresAt: Date | null = null;

    switch (event.type) {
      case "INITIAL_PURCHASE":
      case "RENEWAL":
      case "UNCANCELLATION":
      case "SUBSCRIPTION_EXTENDED":
        status = "active";
        break;
      case "CANCELLATION":
        // Still active until expiration
        status = "active";
        break;
      case "EXPIRATION":
        status = "expired";
        break;
      case "BILLING_ISSUE":
        status = "pending";
        break;
      case "SUBSCRIPTION_PAUSED":
        status = "cancelled";
        break;
      case "PRODUCT_CHANGE":
        status = "active";
        break;
      default:
        status = "active";
    }

    // Set expiration date if provided
    if (event.expiration_at_ms) {
      expiresAt = new Date(event.expiration_at_ms);
    }

    // Determine provider from store
    const provider = event.store === "APP_STORE" ? "apple"
                   : event.store === "PLAY_STORE" ? "google"
                   : event.store === "STRIPE" ? "stripe"
                   : "manual";

    // Upsert subscription record
    const { error: upsertError } = await supabase
      .from("subscriptions")
      .upsert({
        user_id: userId,
        plan: "individual",
        status: status,
        provider: provider,
        provider_subscription_id: event.id,
        provider_product_id: event.product_id,
        starts_at: new Date(event.purchased_at_ms),
        expires_at: expiresAt,
        updated_at: new Date(),
      }, {
        onConflict: "user_id",
      });

    if (upsertError) {
      console.error("Failed to upsert subscription:", upsertError);
      return new Response(JSON.stringify({
        received: true,
        error: upsertError.message
      }), {
        status: 500,
        headers: { "Content-Type": "application/json" },
      });
    }

    console.log(`Successfully processed ${event.type} for user ${userId} - status: ${status}`);

    return new Response(JSON.stringify({
      received: true,
      processed: true,
      user_id: userId,
      status: status,
      event_type: event.type,
    }), {
      headers: { "Content-Type": "application/json" },
    });

  } catch (error) {
    console.error("Webhook processing error:", error);
    return new Response(JSON.stringify({
      received: true,
      error: error.message
    }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
});

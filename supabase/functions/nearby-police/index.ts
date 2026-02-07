// Nearby Police Station Proxy
// Proxies Overpass API requests through our server with:
// - JWT auth (must be logged in)
// - Response caching (avoids rate limits during real emergencies)
// - Coordinate rounding (reduces cache misses + limits precision exposure)

import { serve } from "std/http/server";
import { createClient } from "@supabase/supabase-js";

const VERSION = "2026-02-06-v1";

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

// In-memory cache: key -> { data, timestamp }
const cache = new Map<string, { data: unknown; ts: number }>();
const CACHE_TTL_MS = 30 * 60 * 1000; // 30 minutes
const MAX_CACHE_ENTRIES = 200;

// Round coords to ~1.1km grid to reduce cache misses and limit precision
function roundCoord(n: number, decimals = 2): number {
  return Math.round(n * 10 ** decimals) / 10 ** decimals;
}

function cacheKey(lat: number, lng: number, radius: number): string {
  return `${roundCoord(lat)},${roundCoord(lng)},${radius}`;
}

function pruneCache() {
  if (cache.size <= MAX_CACHE_ENTRIES) return;
  const now = Date.now();
  for (const [key, val] of cache) {
    if (now - val.ts > CACHE_TTL_MS) cache.delete(key);
  }
  // If still too big, delete oldest entries
  if (cache.size > MAX_CACHE_ENTRIES) {
    const entries = [...cache.entries()].sort((a, b) => a[1].ts - b[1].ts);
    const toDelete = entries.slice(0, entries.length - MAX_CACHE_ENTRIES);
    for (const [key] of toDelete) cache.delete(key);
  }
}

const OVERPASS_ENDPOINTS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
  "https://overpass.nchc.org.tw/api/interpreter",
];

const OVERPASS_TIMEOUT_MS = 15000;
const DEFAULT_RADIUS = 50000;
const MAX_RADIUS = 100000;
const MAX_RESULTS = 10;

serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: CORS_HEADERS });
  }

  if (req.method === "GET") {
    return json({ ok: true, VERSION, cache_size: cache.size });
  }

  if (req.method !== "POST") {
    return json({ error: "Method not allowed" }, 405);
  }

  // ── Environment ─────────────────────────────────────────
  const supabaseUrl =
    Deno.env.get("SB_URL") ?? Deno.env.get("SUPABASE_URL") ?? "";
  const supabaseKey =
    Deno.env.get("SB_SERVICE_ROLE_KEY") ??
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ??
    "";

  if (!supabaseUrl || !supabaseKey) {
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
    const lat = typeof body.lat === "number" ? body.lat : NaN;
    const lng = typeof body.lng === "number" ? body.lng : NaN;
    const radius = Math.min(
      typeof body.radius === "number" ? body.radius : DEFAULT_RADIUS,
      MAX_RADIUS
    );

    if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
      return json({ error: "lat and lng are required (numbers)" }, 400);
    }

    // ── Check cache ─────────────────────────────────────
    const key = cacheKey(lat, lng, radius);
    const cached = cache.get(key);
    if (cached && Date.now() - cached.ts < CACHE_TTL_MS) {
      return json({ source: "cache", elements: cached.data });
    }

    // ── Query Overpass (try multiple endpoints) ─────────
    const roundedLat = roundCoord(lat);
    const roundedLng = roundCoord(lng);

    const query = `[out:json][timeout:15];
(
  node["amenity"="police"](around:${radius},${roundedLat},${roundedLng});
  way["amenity"="police"](around:${radius},${roundedLat},${roundedLng});
  relation["amenity"="police"](around:${radius},${roundedLat},${roundedLng});
);
out center tags;`;

    let overpassData: { elements?: unknown[] } | null = null;

    for (const ep of OVERPASS_ENDPOINTS) {
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), OVERPASS_TIMEOUT_MS);

        const res = await fetch(`${ep}?data=${encodeURIComponent(query)}`, {
          signal: controller.signal,
        });
        clearTimeout(timer);

        if (!res.ok) continue;

        overpassData = (await res.json()) as { elements?: unknown[] };
        if (overpassData && Array.isArray(overpassData.elements)) break;
        overpassData = null;
      } catch {
        continue;
      }
    }

    if (!overpassData || !Array.isArray(overpassData.elements)) {
      return json(
        { error: "Overpass temporarily unavailable", elements: [] },
        503
      );
    }

    // Trim to max results
    const elements = overpassData.elements.slice(0, MAX_RESULTS);

    // ── Store in cache ──────────────────────────────────
    pruneCache();
    cache.set(key, { data: elements, ts: Date.now() });

    return json({ source: "overpass", elements });
  } catch (e: unknown) {
    const err = e instanceof Error ? e : new Error(String(e));
    console.error("nearby-police error:", err.message);
    return json({ error: "Internal error" }, 500);
  }
});

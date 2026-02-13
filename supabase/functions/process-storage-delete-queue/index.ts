import { createClient } from "npm:@supabase/supabase-js@2.95.3";

type QueueRow = {
  id: string;
  bucket: string;
  object_path: string;
};

function errToString(err: unknown): string {
  if (!err) return "Unknown error";
  if (typeof err === "string") return err;

  if (err instanceof Error) {
    return `${err.name}: ${err.message}${err.stack ? `\n${err.stack}` : ""}`;
  }

  // Supabase errors are often plain objects
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

Deno.serve(async (_req) => {
  try {
    const url = Deno.env.get("SUPABASE_URL");
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

    if (!url || !serviceKey) {
      return new Response(
        JSON.stringify({
          ok: false,
          error: "Missing env SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY",
        }),
        { status: 500, headers: { "Content-Type": "application/json" } },
      );
    }

    const supabase = createClient(url, serviceKey, {
      auth: { persistSession: false },
    });

    const { data: rows, error: qErr } = await supabase
      .from("storage_delete_queue")
      .select("id,bucket,object_path")
      .eq("status", "pending")
      .is("processed_at", null)
      .order("created_at", { ascending: true })
      .limit(25);

    if (qErr) throw new Error(`queue select error: ${errToString(qErr)}`);

    const pending = (rows ?? []) as QueueRow[];

    let deleted = 0;
    let failed = 0;

    for (const row of pending) {
      const bucket = row.bucket;
      const prefix = (row.object_path || "").replace(/^\/+/, "");
      const folderPrefix = prefix.endsWith("/") ? prefix : `${prefix}/`;

      try {
        const { error: procErr } = await supabase
          .from("storage_delete_queue")
          .update({ status: "processing" })
          .eq("id", row.id);

        if (procErr) throw new Error(`mark processing error: ${errToString(procErr)}`);

        // Your existing approach (non-recursive list)
        const parts = folderPrefix.split("/").filter(Boolean);
        const rootPath = parts.length > 0 ? parts[0] : "";

        const { data: listed, error: lErr } = await supabase.storage
          .from(bucket)
          .list(rootPath, { limit: 1000, offset: 0 });

        if (lErr) throw new Error(`storage list error: ${errToString(lErr)}`);

        const keysToDelete =
          (listed ?? [])
            .map((o) => (rootPath ? `${rootPath}/${o.name}` : o.name))
            .filter((k) => k.startsWith(folderPrefix));

        if (keysToDelete.length > 0) {
          const { error: delErr } = await supabase.storage
            .from(bucket)
            .remove(keysToDelete);

          if (delErr) throw new Error(`storage remove error: ${errToString(delErr)}`);
        }

        const { error: okErr } = await supabase
          .from("storage_delete_queue")
          .update({
            status: "deleted",
            processed_at: new Date().toISOString(),
            error: null,
          })
          .eq("id", row.id);

        if (okErr) throw new Error(`mark deleted error: ${errToString(okErr)}`);

        deleted++;
      } catch (err) {
        const msg = errToString(err);

        await supabase
          .from("storage_delete_queue")
          .update({
            status: "failed",
            processed_at: new Date().toISOString(),
            error: msg,
          })
          .eq("id", row.id);

        failed++;
      }
    }

    return new Response(
      JSON.stringify({
        ok: true,
        processed: pending.length,
        deleted,
        failed,
      }),
      { headers: { "Content-Type": "application/json" } },
    );
  } catch (e) {
    const msg = errToString(e);
    return new Response(
      JSON.stringify({ ok: false, error: msg }),
      { status: 500, headers: { "Content-Type": "application/json" } },
    );
  }
});

// Approve or reject a pending account. Used by approve.html (link in the owner's email).
// The per-account token from signup_tokens is the credential — no login needed.
//   POST { u, t }                      → { email, status }
//   POST { u, t, action: "approve" }   → sets status
//   POST { u, t, action: "reject" }
// Deploy with verify_jwt = false.
import { createClient } from "npm:@supabase/supabase-js@2";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "method not allowed" }, 405);

  let body: { u?: string; t?: string; action?: string };
  try { body = await req.json(); } catch { return json({ error: "bad request" }, 400); }
  const { u, t, action } = body;
  if (!u || !t || !UUID.test(u) || !UUID.test(t)) return json({ error: "invalid link" }, 400);
  if (action && action !== "approve" && action !== "reject") return json({ error: "bad action" }, 400);

  const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
    auth: { persistSession: false },
  });
  const { data: tok } = await admin.from("signup_tokens").select("token").eq("user_id", u).maybeSingle();
  if (!tok || tok.token !== t) return json({ error: "invalid or expired link" }, 403);

  if (action) {
    const status = action === "approve" ? "approved" : "rejected";
    const { error } = await admin.from("profiles").update({ status, decided_at: new Date().toISOString() }).eq("id", u);
    if (error) return json({ error: error.message }, 500);
  }
  const { data: prof } = await admin.from("profiles").select("email,status,created_at").eq("id", u).maybeSingle();
  if (!prof) return json({ error: "account not found" }, 404);
  return json(prof);
});

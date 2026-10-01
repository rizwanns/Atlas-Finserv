// Emails the owner when a signed-in account is still waiting for approval.
// Called by the app (with the user's session) from the "Waiting for approval" screen.
// Sends at most one email per account (signup_tokens.notified_at).
//
// Secrets: RESEND_API_KEY (required), ADMIN_EMAIL, APP_URL, RESEND_FROM (optional)
import { createClient } from "npm:@supabase/supabase-js@2";

const ADMIN_EMAIL = Deno.env.get("ADMIN_EMAIL") ?? "atlasstudiopvtltd@gmail.com";
const APP_URL = (Deno.env.get("APP_URL") ?? "https://atlasfinserv.vercel.app").replace(/\/$/, "");
const FROM = Deno.env.get("RESEND_FROM") ?? "Atlas <onboarding@resend.dev>";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "method not allowed" }, 405);

  const jwt = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
  const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
    auth: { persistSession: false },
  });
  const { data: u, error: uErr } = await admin.auth.getUser(jwt);
  if (uErr || !u.user) return json({ error: "not signed in" }, 401);
  const user = u.user;

  // accounts created before the migration may lack rows — create them
  await admin.from("profiles").upsert({ id: user.id, email: (user.email ?? "").toLowerCase() }, { onConflict: "id", ignoreDuplicates: true });
  await admin.from("signup_tokens").upsert({ user_id: user.id }, { onConflict: "user_id", ignoreDuplicates: true });

  const { data: prof } = await admin.from("profiles").select("status").eq("id", user.id).single();
  if (!prof || prof.status !== "pending") return json({ ok: true, sent: false });

  const { data: tok } = await admin.from("signup_tokens").select("token,notified_at").eq("user_id", user.id).single();
  if (!tok || tok.notified_at) return json({ ok: true, sent: false });

  const key = Deno.env.get("RESEND_API_KEY");
  if (!key) return json({ error: "RESEND_API_KEY is not set" }, 500);

  const link = `${APP_URL}/approve.html?u=${user.id}&t=${tok.token}`;
  const email = esc(user.email ?? "(no email)");
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      from: FROM,
      to: [ADMIN_EMAIL],
      subject: `Atlas: approve new account — ${user.email}`,
      html: `<div style="font-family:system-ui,sans-serif;font-size:15px;line-height:1.5">
        <p>A new Atlas account is waiting for approval:</p>
        <p style="font-size:17px"><b>${email}</b><br><span style="color:#777;font-size:13px">created ${new Date(user.created_at).toUTCString()}</span></p>
        <p><a href="${link}" style="display:inline-block;background:#c9a86a;color:#1a1206;padding:10px 18px;border-radius:10px;text-decoration:none;font-weight:600">Review &amp; approve</a></p>
        <p style="color:#777;font-size:12px">The link opens a page where you choose Approve or Reject. Don't forward this email — anyone with the link can decide on this account.</p>
      </div>`,
    }),
  });
  if (!res.ok) return json({ error: "email failed", detail: await res.text() }, 502);

  await admin.from("signup_tokens").update({ notified_at: new Date().toISOString() }).eq("user_id", user.id);
  return json({ ok: true, sent: true });
});

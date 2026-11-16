import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Content-Type": "application/json; charset=utf-8",
};
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: corsHeaders });
const encoder = new TextEncoder();

function base64url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/g, "");
}
function fromBase64url(value: string): Uint8Array {
  const base64 = value.replaceAll("-", "+").replaceAll("_", "/");
  const binary = atob(base64 + "=".repeat((4 - base64.length % 4) % 4));
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}
async function getUser(req: Request) {
  const authorization = req.headers.get("Authorization");
  if (!authorization?.startsWith("Bearer ")) throw new Error("سجّل الدخول إلى VARA قبل ربط TikTok.");
  const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!, {
    global: { headers: { Authorization: authorization } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data, error } = await supabase.auth.getUser();
  if (error || !data.user) throw new Error("جلسة VARA غير صالحة. سجّل الدخول من جديد.");
  return data.user;
}
async function signState(userId: string, secret: string): Promise<string> {
  const payload = base64url(encoder.encode(JSON.stringify({ sub: userId, exp: Date.now() + 10 * 60 * 1000, nonce: crypto.randomUUID() })));
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const signature = new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(payload)));
  return `${payload}.${base64url(signature)}`;
}
async function verifyState(state: string, userId: string, secret: string): Promise<boolean> {
  const parts = state.split(".");
  if (parts.length !== 2) return false;
  try {
    const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["verify"]);
    const valid = await crypto.subtle.verify("HMAC", key, fromBase64url(parts[1]), encoder.encode(parts[0]));
    if (!valid) return false;
    const payload = JSON.parse(new TextDecoder().decode(fromBase64url(parts[0])));
    return payload.sub === userId && Number(payload.exp) > Date.now() && typeof payload.nonce === "string";
  } catch { return false; }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);
  try {
    const user = await getUser(req);
    const body = await req.json();
    const action = body?.action;
    const clientKey = Deno.env.get("TIKTOK_CLIENT_KEY");
    const clientSecret = Deno.env.get("TIKTOK_CLIENT_SECRET");
    const redirectUri = Deno.env.get("TIKTOK_REDIRECT_URI");
    const stateSecret = Deno.env.get("TIKTOK_STATE_SECRET");
    if (!clientKey || !clientSecret || !redirectUri || !stateSecret || stateSecret.length < 32) {
      return json({ error: "إعدادات TikTok غير مكتملة على خادم Supabase." }, 500);
    }

    if (action === "start") {
      const state = await signState(user.id, stateSecret);
      const authorize = new URL("https://www.tiktok.com/v2/auth/authorize/");
      authorize.search = new URLSearchParams({ client_key: clientKey, response_type: "code", scope: "user.info.basic", redirect_uri: redirectUri, state }).toString();
      return json({ auth_url: authorize.toString() });
    }

    if (action !== "exchange") return json({ error: "عملية غير معروفة." }, 400);
    const code = typeof body.code === "string" ? body.code : "";
    const state = typeof body.state === "string" ? body.state : "";
    if (!code || !state || !(await verifyState(state, user.id, stateSecret))) {
      return json({ error: "تعذّر التحقق من طلب الربط. ابدأ عملية الربط من جديد." }, 400);
    }

    const tokenResponse = await fetch("https://open.tiktokapis.com/v2/oauth/token/", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", "Cache-Control": "no-cache" },
      body: new URLSearchParams({ client_key: clientKey, client_secret: clientSecret, code, grant_type: "authorization_code", redirect_uri: redirectUri }),
    });
    const tokenData = await tokenResponse.json();
    if (!tokenResponse.ok || !tokenData.access_token || !tokenData.open_id) {
      console.error("TikTok token exchange failed", tokenData?.error, tokenData?.log_id);
      return json({ error: tokenData?.error_description || "رفض TikTok إكمال التفويض. تحقق من Redirect URI وإعدادات التطبيق." }, 400);
    }

    const profileUrl = new URL("https://open.tiktokapis.com/v2/user/info/");
    profileUrl.searchParams.set("fields", "open_id,display_name,avatar_url");
    const profileResponse = await fetch(profileUrl, { headers: { Authorization: `Bearer ${tokenData.access_token}` } });
    const profileData = await profileResponse.json();
    const profile = profileData?.data?.user;
    if (!profileResponse.ok || profileData?.error?.code !== "ok" || !profile?.open_id) {
      console.error("TikTok profile request failed", profileData?.error?.code, profileData?.error?.log_id);
      return json({ error: "تم تفويض TikTok لكن تعذّر قراءة بيانات الحساب الأساسية." }, 400);
    }

    const service = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const { error: saveError } = await service.from("tiktok_links").upsert({
      auth_user_id: user.id,
      tiktok_open_id: profile.open_id,
      display_name: profile.display_name ?? null,
      avatar_url: profile.avatar_url ?? null,
      linked_at: new Date().toISOString(),
    }, { onConflict: "auth_user_id" });
    if (saveError) {
      console.error("TikTok link save failed", saveError.code, saveError.message);
      if (saveError.code === "23505") return json({ error: "حساب TikTok هذا مرتبط مسبقًا بحساب VARA آخر." }, 409);
      return json({ error: "تم التحقق من TikTok لكن تعذّر حفظ الربط. تحقق من تشغيل ملف SQL." }, 500);
    }
    // Tokens are deliberately not returned to the browser or stored by this identity-linking function.
    return json({ linked: true, display_name: profile.display_name ?? null });
  } catch (error) {
    console.error("TikTok link function error", error);
    return json({ error: error instanceof Error ? error.message : "حدث خطأ غير متوقع." }, 400);
  }
});

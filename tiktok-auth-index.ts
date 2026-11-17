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
function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (value) => value.toString(16).padStart(2, "0")).join("");
}
async function hmac(message: string, secret: string): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(message)));
}
async function signedState(payload: Record<string, unknown>, secret: string): Promise<string> {
  const body = base64url(encoder.encode(JSON.stringify(payload)));
  return `${body}.${base64url(await hmac(body, secret))}`;
}
async function verifyState(state: string, secret: string): Promise<Record<string, unknown> | null> {
  const parts = state.split(".");
  if (parts.length !== 2) return null;
  try {
    const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["verify"]);
    const valid = await crypto.subtle.verify("HMAC", key, fromBase64url(parts[1]), encoder.encode(parts[0]));
    if (!valid) return null;
    const payload = JSON.parse(new TextDecoder().decode(fromBase64url(parts[0])));
    if (!payload.nonce || Number(payload.exp) <= Date.now() || !["signup", "login"].includes(payload.intent)) return null;
    return payload;
  } catch { return null; }
}
function getAdminClient() {
  return createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);
  try {
    const body = await req.json();
    const action = body?.action;
    const clientKey = Deno.env.get("TIKTOK_CLIENT_KEY");
    const clientSecret = Deno.env.get("TIKTOK_CLIENT_SECRET");
    const redirectUri = Deno.env.get("TIKTOK_REDIRECT_URI");
    const stateSecret = Deno.env.get("TIKTOK_STATE_SECRET");
    const accountSecret = Deno.env.get("TIKTOK_ACCOUNT_SECRET");
    if (!clientKey || !clientSecret || !redirectUri || !stateSecret || stateSecret.length < 32 || !accountSecret || accountSecret.length < 32) {
      return json({ error: "إعدادات TikTok غير مكتملة على خادم Supabase." }, 500);
    }

    if (action === "start") {
      const intent = body.intent === "login" ? "login" : body.intent === "signup" ? "signup" : "";
      if (!intent) return json({ error: "اختر إنشاء حساب أو تسجيل الدخول." }, 400);
      const username = typeof body.username === "string" ? body.username.trim().slice(0, 32) : "";
      const accountType = body.account_type === "streamer" ? "streamer" : "player";
      if (intent === "signup" && username.length < 3) return json({ error: "اسم المستخدم يجب أن يتكوّن من 3 أحرف على الأقل." }, 400);
      const state = await signedState({ intent, username, account_type: accountType, exp: Date.now() + 10 * 60 * 1000, nonce: crypto.randomUUID() }, stateSecret);
      const authorize = new URL("https://www.tiktok.com/v2/auth/authorize/");
      authorize.search = new URLSearchParams({ client_key: clientKey, response_type: "code", scope: "user.info.basic", redirect_uri: redirectUri, state, disable_auto_auth: "1" }).toString();
      return json({ auth_url: authorize.toString() });
    }

    if (action !== "exchange") return json({ error: "عملية غير معروفة." }, 400);
    const code = typeof body.code === "string" ? body.code : "";
    const state = typeof body.state === "string" ? body.state : "";
    const stateData = await verifyState(state, stateSecret);
    if (!code || !stateData) return json({ error: "تعذّر التحقق من طلب TikTok. ابدأ من جديد." }, 400);

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
      return json({ error: "تعذّر قراءة بيانات حساب TikTok." }, 400);
    }

    const admin = getAdminClient();
    const { data: existingLink, error: lookupError } = await admin.from("tiktok_links").select("auth_user_id").eq("tiktok_open_id", profile.open_id).maybeSingle();
    if (lookupError) {
      console.error("TikTok account lookup failed", lookupError.message);
      return json({ error: "تعذّر التحقق من حسابك. تأكد من إعداد جدول TikTok." }, 500);
    }

    const accountEmailHash = hex(new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(profile.open_id)))).slice(0, 40);
    const accountEmail = `tiktok-${accountEmailHash}@accounts.vara.invalid`;
    const accountPassword = hex(await hmac(`vara-login:${profile.open_id}`, accountSecret)) + "Aa1!";
    let gameUser: any;

    if (existingLink) {
      const { data, error } = await admin.auth.admin.getUserById(existingLink.auth_user_id);
      if (error || !data.user) return json({ error: "تعذّر العثور على حساب VARA المرتبط بهذا TikTok." }, 404);
      gameUser = data.user;
      if (gameUser.user_metadata?.auth_provider !== "tiktok") {
        return json({ error: "حساب TikTok هذا مرتبط مسبقًا بحساب VARA آخر. سجّل الدخول بذلك الحساب." }, 409);
      }
    } else {
      if (stateData.intent === "login") return json({ error: "لا يوجد حساب VARA مسجّل بهذا TikTok. اختر «حساب جديد» لإنشاء واحد." }, 404);
      const chosenName = typeof stateData.username === "string" && stateData.username.trim().length >= 3
        ? stateData.username.trim().slice(0, 32)
        : (profile.display_name || "لاعب VARA").slice(0, 32);
      const accountType = stateData.account_type === "streamer" ? "streamer" : "player";
      const { data: created, error: createError } = await admin.auth.admin.createUser({
        email: accountEmail,
        password: accountPassword,
        email_confirm: true,
        user_metadata: { username: chosenName, account_type: accountType, auth_provider: "tiktok", tiktok_display_name: profile.display_name ?? null },
      });
      if (createError || !created.user) {
        console.error("TikTok user creation failed", createError?.message);
        return json({ error: "تعذّر إنشاء حساب VARA عبر TikTok. أعد المحاولة أو استخدم البريد الإلكتروني." }, 500);
      }
      const { error: saveError } = await admin.from("tiktok_links").insert({
        auth_user_id: created.user.id,
        tiktok_open_id: profile.open_id,
        display_name: profile.display_name ?? null,
        avatar_url: profile.avatar_url ?? null,
        linked_at: new Date().toISOString(),
      });
      if (saveError) {
        console.error("TikTok identity save failed", saveError.code, saveError.message);
        await admin.auth.admin.deleteUser(created.user.id);
        return json({ error: saveError.code === "23505" ? "يوجد حساب VARA مسجّل بهذا TikTok بالفعل. جرّب تسجيل الدخول." : "تعذّر حفظ هوية TikTok في VARA." }, 409);
      }
      gameUser = created.user;
    }

    const publicAuth = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const { data: loginData, error: loginError } = await publicAuth.auth.signInWithPassword({ email: accountEmail, password: accountPassword });
    if (loginError || !loginData.session) {
      console.error("TikTok Supabase session creation failed", loginError?.message);
      return json({ error: "تم التحقق من TikTok لكن تعذّر بدء جلسة VARA." }, 500);
    }
    return json({
      session: {
        access_token: loginData.session.access_token,
        refresh_token: loginData.session.refresh_token,
        expires_at: loginData.session.expires_at,
        expires_in: loginData.session.expires_in,
        token_type: loginData.session.token_type,
      },
    });
  } catch (error) {
    console.error("TikTok auth error", error);
    return json({ error: error instanceof Error ? error.message : "حدث خطأ غير متوقع." }, 400);
  }
});
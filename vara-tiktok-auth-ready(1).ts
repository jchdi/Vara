import { createClient } from "npm:@supabase/supabase-js@2";

const CLIENT_KEY = Deno.env.get("TIKTOK_CLIENT_KEY") ?? "";
const CLIENT_SECRET = Deno.env.get("TIKTOK_CLIENT_SECRET") ?? "";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SITE_URL = "https://jchdi.github.io/Vara/";
const REDIRECT_URI =
  "https://dzcnxxigsnarzfdcmmir.supabase.co/functions/v1/vara-tiktok-auth";

const COOKIE_NAME = "vara_tiktok_state";
const COOKIE_PATH = "/functions/v1/vara-tiktok-auth";

function getSupabaseSecretKey(): string {
  // Supabase injects SUPABASE_SECRET_KEYS into hosted Edge Functions.
  // The legacy variable is kept as a fallback for older projects.
  const legacy = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (legacy) return legacy;

  const raw = Deno.env.get("SUPABASE_SECRET_KEYS");
  if (!raw) return "";

  try {
    const parsed = JSON.parse(raw);
    return parsed.default ?? "";
  } catch {
    return "";
  }
}

function redirectResponse(location: string, cookie?: string): Response {
  const headers = new Headers({
    Location: location,
    "Cache-Control": "no-store",
    "Referrer-Policy": "no-referrer",
  });

  if (cookie) headers.set("Set-Cookie", cookie);

  return new Response(null, { status: 302, headers });
}

function clearStateCookie(): string {
  return `${COOKIE_NAME}=; Max-Age=0; Path=${COOKIE_PATH}; HttpOnly; Secure; SameSite=Lax`;
}

function redirectToSite(status: "success" | "error", reason?: string, tokenHash?: string) {
  const url = new URL(SITE_URL);
  url.searchParams.set("tiktok_oauth", status);

  if (reason) url.searchParams.set("reason", reason);

  if (tokenHash) {
    url.searchParams.set("token_hash", tokenHash);
    url.searchParams.set("type", "magiclink");
  }

  return url;
}

function fail(reason: string): Response {
  return redirectResponse(
    redirectToSite("error", reason).toString(),
    clearStateCookie(),
  );
}

async function hashOpenId(openId: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(openId),
  );

  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

Deno.serve(async (req: Request) => {
  try {
    if (req.method !== "GET") {
      return new Response("Method not allowed", { status: 405 });
    }

    if (!CLIENT_KEY || !CLIENT_SECRET || !SUPABASE_URL) {
      console.error("Required OAuth or Supabase configuration is missing.");
      return new Response("Server configuration is incomplete.", {
        status: 500,
      });
    }

    const secretKey = getSupabaseSecretKey();

    if (!secretKey) {
      console.error("No Supabase secret key is available to this function.");
      return new Response("Server configuration is incomplete.", {
        status: 500,
      });
    }

    const supabaseAdmin = createClient(SUPABASE_URL, secretKey, {
      auth: {
        autoRefreshToken: false,
        persistSession: false,
        detectSessionInUrl: false,
      },
    });

    const url = new URL(req.url);

    // TikTok may return an authorization error instead of a code.
    const oauthError = url.searchParams.get("error");
    if (oauthError) {
      return fail("authorization_denied");
    }

    const code = url.searchParams.get("code");
    const returnedState = url.searchParams.get("state");

    // First visit: create a CSRF state value and send the user to TikTok.
    if (!code) {
      const stateBytes = crypto.getRandomValues(new Uint8Array(32));
      const state = Array.from(stateBytes)
        .map((byte) => byte.toString(16).padStart(2, "0"))
        .join("");

      const authUrl = new URL("https://www.tiktok.com/v2/auth/authorize/");
      authUrl.searchParams.set("client_key", CLIENT_KEY);
      authUrl.searchParams.set("response_type", "code");
      authUrl.searchParams.set("scope", "user.info.basic");
      authUrl.searchParams.set("redirect_uri", REDIRECT_URI);
      authUrl.searchParams.set("state", state);

      const cookie =
        `${COOKIE_NAME}=${state}; Max-Age=600; Path=${COOKIE_PATH}; ` +
        "HttpOnly; Secure; SameSite=Lax";

      return redirectResponse(authUrl.toString(), cookie);
    }

    // Callback: compare TikTok's state with the state stored in the cookie.
    const cookieHeader = req.headers.get("Cookie") ?? "";
    const stateCookie = cookieHeader
      .split(";")
      .map((part) => part.trim())
      .find((part) => part.startsWith(`${COOKIE_NAME}=`));

    const savedState = stateCookie
      ? stateCookie.slice(COOKIE_NAME.length + 1)
      : "";

    if (!returnedState || !savedState || returnedState !== savedState) {
      return fail("state_mismatch");
    }

    // Exchange the one-time authorization code on the server.
    const tokenBody = new URLSearchParams({
      client_key: CLIENT_KEY,
      client_secret: CLIENT_SECRET,
      code,
      grant_type: "authorization_code",
      redirect_uri: REDIRECT_URI,
    });

    const tokenResponse = await fetch(
      "https://open.tiktokapis.com/v2/oauth/token/",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: tokenBody,
      },
    );

    const tokenData = await tokenResponse.json();

    if (!tokenResponse.ok || !tokenData.access_token) {
      console.error("TikTok token exchange failed.");
      return fail("token_exchange_failed");
    }

    // Read the TikTok identity. The access token is never sent to the browser.
    const profileResponse = await fetch(
      "https://open.tiktokapis.com/v2/user/info/?fields=open_id,display_name,avatar_url",
      {
        headers: {
          Authorization: `Bearer ${tokenData.access_token}`,
        },
      },
    );

    const profileData = await profileResponse.json();
    const tiktokUser = profileData?.data?.user;

    if (!profileResponse.ok || !tiktokUser?.open_id) {
      console.error("TikTok profile request failed.");
      return fail("profile_request_failed");
    }

    // Create a stable internal email alias from TikTok's immutable open_id.
    // It is not a real email address and is never shown as the user's contact.
    const openIdHash = await hashOpenId(String(tiktokUser.open_id));
    const internalEmail = `tiktok_${openIdHash}@users.vara.invalid`;

    const username =
      String(tiktokUser.display_name ?? "TikTok Player").slice(0, 40);

    const userMetadata = {
      auth_provider: "tiktok",
      tiktok_open_id: String(tiktokUser.open_id),
      tiktok_display_name: username,
      tiktok_avatar_url: String(tiktokUser.avatar_url ?? ""),
      username,
      account_type: "player",
    };

    // Create a confirmed internal Auth user on first TikTok sign-in.
    // If the deterministic address already exists, reuse that account.
    const { data: createdData, error: createError } =
      await supabaseAdmin.auth.admin.createUser({
        email: internalEmail,
        email_confirm: true,
        user_metadata: userMetadata,
      });

    if (createError && createError.code !== "email_exists") {
      console.error("Supabase user creation failed:", createError.message);
      return fail("supabase_login_failed");
    }

    // Generate a one-time link for the confirmed internal user.
    const { data: linkData, error: linkError } =
      await supabaseAdmin.auth.admin.generateLink({
        type: "magiclink",
        email: internalEmail,
        options: {
          data: userMetadata,
          redirectTo: SITE_URL,
        },
      });

    if (linkError || !linkData?.properties?.hashed_token || !linkData.user) {
      console.error("Supabase magic link generation failed:", linkError?.message);
      return fail("supabase_login_failed");
    }

    // Keep the latest TikTok profile details on the existing VARA account.
    const { error: updateError } =
      await supabaseAdmin.auth.admin.updateUserById(linkData.user.id, {
        user_metadata: {
          ...(linkData.user.user_metadata ?? {}),
          ...userMetadata,
        },
      });

    if (updateError) {
      console.error("Supabase user metadata update failed:", updateError.message);
      return fail("supabase_user_update_failed");
    }

    // The frontend must immediately call supabase.auth.verifyOtp() with
    // token_hash and type=magiclink to establish the browser session.
    const successUrl = redirectToSite(
      "success",
      undefined,
      linkData.properties.hashed_token,
    );

    return redirectResponse(successUrl.toString(), clearStateCookie());
  } catch (error) {
    console.error(
      "VARA TikTok authentication error:",
      error instanceof Error ? error.message : "Unknown error",
    );

    return new Response("An internal error occurred.", {
      status: 500,
      headers: {
        "Cache-Control": "no-store",
        "Referrer-Policy": "no-referrer",
      },
    });
  }
});

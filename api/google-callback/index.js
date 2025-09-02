const fetch = global.fetch;
const { popPkceVerifier, popStateCookie, setRefreshCookie, setSessionCookie, parseCookies } = require("../_lib/session");

module.exports = async function (context, req) {
  if (req.method !== "GET") {
    context.res = { status: 405, headers: { "Allow": "GET" }, body: "" };
    return;
  }

  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  const redirectUri = (process.env.APP_BASE_URL || "") + "/api/google/callback";
  if (!clientId || !clientSecret || !redirectUri) {
    context.res = { status: 500, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ error: "Missing GOOGLE_* envs or APP_BASE_URL" }) };
    return;
  }

  const cookies = [];
  const expectedStateCookie = popStateCookie(req, cookies) || "";
  const pkceVerifier = popPkceVerifier(req, cookies);

  const { code = "", state = "" } = req.query || {};
  // Diagnostic: capture incoming cookies for debugging state mismatches
  try {
    const receivedCookies = parseCookies(req);
    // Best-effort console log; server environments should surface these logs to their log stream
    console.log('google-callback: incoming query', { code: !!code, state });
    console.log('google-callback: received cookies', receivedCookies);
  } catch (e) {
    console.log('google-callback: cookie parse failed', e instanceof Error ? e.message : String(e));
  }
  if (!code || !state || !pkceVerifier) {
    context.res = { status: 400, headers: { "Content-Type": "application/json", "Set-Cookie": cookies }, body: JSON.stringify({ error: "invalid_callback_params" }) };
    return;
  }

  if (!expectedStateCookie.startsWith(state + ":")) {
    context.res = { status: 400, headers: { "Content-Type": "application/json", "Set-Cookie": cookies }, body: JSON.stringify({ error: "state_mismatch" }) };
    return;
  }
  const returnTo = decodeURIComponent(expectedStateCookie.slice(state.length + 1));

  const body = new URLSearchParams({
    code: String(code),
    client_id: clientId,
    client_secret: clientSecret,
    redirect_uri: redirectUri,
    grant_type: "authorization_code",
    code_verifier: pkceVerifier
  });

  const r = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body
  });

  const text = await r.text();
  if (!r.ok) {
    context.res = { status: 400, headers: { "Set-Cookie": cookies, "Content-Type": "application/json" }, body: JSON.stringify({ error: "token_exchange_failed", details: text.slice(0, 512) }) };
    return;
  }

  const tok = JSON.parse(text);
  const refresh_token = tok.refresh_token;
  const id_token = tok.id_token;
  const scope = tok.scope;

  // Parse id_token for sub/email without remote JWKS (best-effort)
  let sub = "unknown";
  let email = undefined;
  try {
    const parts = String(id_token || "").split(".");
    if (parts.length === 3) {
      const payload = JSON.parse(Buffer.from(parts[1], "base64").toString("utf8"));
      sub = payload.sub || sub;
      email = payload.email || undefined;
    }
  } catch (_) {}

  if (!refresh_token) {
    context.res = { status: 400, headers: { "Set-Cookie": cookies, "Content-Type": "application/json" }, body: JSON.stringify({ error: "no_refresh_token_returned", note: "Use prompt=consent once and ensure access_type=offline" }) };
    return;
  }

  // Issue cookies
  setRefreshCookie(cookies, { refresh_token, sub, email, scope });
  const now = Math.floor(Date.now() / 1000);
  setSessionCookie(cookies, { sub, email, scope, iat: now, exp: now + 3600 });

  context.res = {
    status: 302,
    headers: { Location: returnTo || "/", "Set-Cookie": cookies },
    body: ""
  };
};


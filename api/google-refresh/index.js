const fetch = global.fetch;
const { getRefreshPayload, setSessionCookie, setRefreshCookie } = require("../_lib/session");

module.exports = async function (context, req) {
  if (req.method !== "POST") {
    context.res = { status: 405, headers: { "Allow": "POST" }, body: "" };
    return;
  }

  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    context.res = { status: 500, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ error: "Missing GOOGLE_* envs" }) };
    return;
  }

  const payload = getRefreshPayload(req);
  if (!payload || !payload.refresh_token) {
    context.res = { status: 401, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ error: "no_refresh_token" }) };
    return;
  }

  const params = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    grant_type: "refresh_token",
    refresh_token: payload.refresh_token
  });
  const r = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: params
  });
  const text = await r.text();
  if (!r.ok) {
    context.res = { status: 401, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ error: "refresh_failed", details: text.slice(0, 512) }) };
    return;
  }
  const tok = JSON.parse(text);
  const now = Math.floor(Date.now() / 1000);
  const sub = payload.sub || "unknown";
  const email = payload.email || undefined;
  const scope = payload.scope || tok.scope;
  setSessionCookie(context.resHeaders = (context.resHeaders || []), { sub, email, scope, iat: now, exp: now + 3600 });
  if (tok.refresh_token && tok.refresh_token !== payload.refresh_token) {
    setRefreshCookie(context.resHeaders, { refresh_token: tok.refresh_token, sub, email, scope });
  }

  context.res = { status: 200, headers: { "Content-Type": "application/json", "Set-Cookie": context.resHeaders }, body: JSON.stringify({ ok: true, expires_in: tok.expires_in }) };
};


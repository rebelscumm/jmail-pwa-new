const fetch = global.fetch;
const { getSession, getRefreshPayload, setSessionCookie, setRefreshCookie } = require("../_lib/session");

async function getGoogleAccessToken(payload) {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  if (!clientId || !clientSecret) throw new Error("Missing GOOGLE_* envs");
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
  if (!r.ok) {
    const t = await r.text();
    throw new Error("refresh_failed:" + t.slice(0, 256));
  }
  return await r.json();
}

module.exports = async function (context, req) {
  const method = (req.method || "GET").toUpperCase();
  // Extract path from Azure Functions route parameters
  const rawPath = req.params && req.params.segments ? String(req.params.segments) : "";
  const path = rawPath.replace(/^\/+/, "");
  
  console.log('gmail-proxy: path extraction', {
    originalUrl: req.url,
    rawPath,
    extractedPath: path,
    method,
    params: req.params
  });
  const resHeaders = [];

  const session = getSession(req);
  const payload = getRefreshPayload(req);
  if (!session || !payload || !payload.refresh_token) {
    context.res = { status: 401, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ error: "unauthenticated" }) };
    return;
  }

  // Obtain a fresh Google access token
  let token;
  try {
    const tok = await getGoogleAccessToken(payload);
    token = tok.access_token;
    // rotate session cookie TTL
    const now = Math.floor(Date.now() / 1000);
    setSessionCookie(resHeaders, { sub: session.sub, email: session.email, scope: session.scope || tok.scope, iat: now, exp: now + 3600 });
    if (tok.refresh_token && tok.refresh_token !== payload.refresh_token) {
      setRefreshCookie(resHeaders, { refresh_token: tok.refresh_token, sub: session.sub, email: session.email, scope: tok.scope || session.scope });
    }
  } catch (e) {
    context.res = { status: 401, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ error: "token_refresh_failed" }) };
    return;
  }

  // Ensure path is appended correctly to avoid double slashes which can
  // cause the Gmail API to return 404 for some routes. Also PRESERVE the
  // original query string exactly (supports repeated params like metadataHeaders).
  const base = "https://gmail.googleapis.com/gmail/v1/users/me";
  const cleanPath = path ? `/${path.replace(/^\/+/, '')}` : '';
  let queryString = '';
  try {
    const u = new URL(req.url);
    queryString = u.search || '';
  } catch (_) {
    const i = (req.url || '').indexOf('?');
    queryString = i >= 0 ? (req.url || '').slice(i) : '';
  }
  const url = `${base}${cleanPath}${queryString}`;
  // Debug: record constructed URL for troubleshooting 404/403 while avoiding logging full URL
  try { context.log(`[gmail-proxy] incoming path=${path} method=${method} query=${queryString}`); } catch (_) {}
  const headers = {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json"
  };
  const init = { method, headers };
  if (method !== "GET" && method !== "HEAD") {
    init.body = typeof req.body === "string" ? req.body : JSON.stringify(req.body || {});
  }
  const r = await fetch(url, init);
  const text = await r.text();
  // If Gmail returned an error status, log the body to help debug 404/403
  if (!r.ok) {
    try { context.log(`[gmail-proxy] gmail response status=${r.status} statusText=${r.statusText} body=${text.slice(0,1024)}`); } catch (_) {}
  }
  const forward = ["content-type"]; // safe subset
  const hdr = { "Set-Cookie": resHeaders };
  for (const h of forward) {
    const v = r.headers.get(h);
    if (v) hdr[h] = v;
  }
  context.res = { status: r.status, headers: hdr, body: text };
};


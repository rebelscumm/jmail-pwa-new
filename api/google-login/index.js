const { sha256Base64url, randomId } = require("../_lib/crypto");
const { setOAuthCookie } = require("../_lib/session");
const { setCorsHeaders } = require("../_lib/cors");

module.exports = async function (context, req) {
  // Handle OPTIONS preflight requests
  if (req.method === "OPTIONS") {
    const headers = {};
    setCorsHeaders(headers, req);
    context.res = { status: 200, headers, body: "" };
    return;
  }
  
  if (req.method !== "GET") {
    const headers = { "Allow": "GET" };
    setCorsHeaders(headers, req);
    context.res = { status: 405, headers, body: "" };
    return;
  }

  const clientId = process.env.GOOGLE_CLIENT_ID;
  const redirectUri = (process.env.APP_BASE_URL || "") + "/api/google-callback";
  const scope = process.env.GOOGLE_SCOPES || [
    "https://www.googleapis.com/auth/gmail.modify",
    "https://www.googleapis.com/auth/gmail.labels",
    "https://www.googleapis.com/auth/gmail.readonly"
  ].join(" ");
  if (!clientId || !redirectUri) {
    const headers = { "Content-Type": "application/json" };
    setCorsHeaders(headers, req);
    context.res = { status: 500, body: JSON.stringify({ error: "Missing GOOGLE_CLIENT_ID or APP_BASE_URL" }), headers };
    return;
  }

  const codeVerifier = randomId(48);
  const codeChallenge = sha256Base64url(codeVerifier);
  const state = randomId(16);
  const returnTo = (req.query && req.query.return_to) ? String(req.query.return_to) : (process.env.APP_BASE_URL || "/");

  // Use a single combined cookie to avoid issues with multiple Set-Cookie headers
  const cookies = [];
  const stateWithReturn = state + ":" + encodeURIComponent(returnTo);
  setOAuthCookie(cookies, codeVerifier, stateWithReturn);

  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope,
    access_type: "offline",
    include_granted_scopes: "true",
    prompt: "consent",
    code_challenge: codeChallenge,
    code_challenge_method: "S256",
    state
  });

  const headers = {
    Location: `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`,
    "Set-Cookie": cookies
  };
  setCorsHeaders(headers, req);
  context.res = {
    status: 302,
    headers,
    body: ""
  };
};
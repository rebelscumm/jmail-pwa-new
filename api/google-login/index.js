const { sha256Base64url, randomId } = require("../_lib/crypto");
const { setPkceCookie, setStateCookie } = require("../_lib/session");

module.exports = async function (context, req) {
  if (req.method !== "GET") {
    context.res = { status: 405, headers: { "Allow": "GET" }, body: "" };
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
    context.res = { status: 500, body: JSON.stringify({ error: "Missing GOOGLE_CLIENT_ID or APP_BASE_URL" }), headers: { "Content-Type": "application/json" } };
    return;
  }

  const codeVerifier = randomId(48);
  const codeChallenge = sha256Base64url(codeVerifier);
  const state = randomId(16);
  const returnTo = (req.query && req.query.return_to) ? String(req.query.return_to) : (process.env.APP_BASE_URL || "/");

  const cookies = [];
  setPkceCookie(cookies, codeVerifier);
  setStateCookie(cookies, state + ":" + encodeURIComponent(returnTo));

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

  context.res = {
    status: 302,
    headers: {
      Location: `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`,
      "Set-Cookie": cookies
    },
    body: ""
  };
};


const fetch = global.fetch;
const { getRefreshPayload } = require("../_lib/session");

module.exports = async function (context, req) {
  if (req.method !== "GET") {
    context.res = { status: 405, headers: { "Allow": "GET" }, body: "" };
    return;
  }
  const payload = getRefreshPayload(req);
  if (!payload || !payload.refresh_token) {
    context.res = { status: 401, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ authenticated: false }) };
    return;
  }
  // We don't expose access token; just show granted scopes by hitting tokeninfo requires an access token.
  // Instead, return stored scope from cookie payload.
  context.res = { status: 200, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ authenticated: true, scope: payload.scope || null }) };
};


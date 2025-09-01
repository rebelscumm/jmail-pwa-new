const { clearRefreshCookie, clearSessionCookie } = require("../_lib/session");

module.exports = async function (context, req) {
  if (req.method !== "POST") {
    context.res = { status: 405, headers: { "Allow": "POST" }, body: "" };
    return;
  }
  const cookies = [];
  clearRefreshCookie(cookies);
  clearSessionCookie(cookies);
  context.res = { status: 200, headers: { "Set-Cookie": cookies, "Content-Type": "application/json" }, body: JSON.stringify({ ok: true }) };
};


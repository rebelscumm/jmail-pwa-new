const { getSession } = require("../_lib/session");

module.exports = async function (context, req) {
  if (req.method !== "GET") {
    context.res = { status: 405, headers: { "Allow": "GET" }, body: "" };
    return;
  }
  const session = getSession(req);
  if (!session) {
    context.res = { status: 401, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ authenticated: false }) };
    return;
  }
  context.res = { status: 200, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ authenticated: true, user: { sub: session.sub, email: session.email }, scope: session.scope }) };
};


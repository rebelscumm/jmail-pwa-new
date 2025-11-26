const { getSession } = require("../_lib/session");
const { setCorsHeaders } = require("../_lib/cors");

module.exports = async function (context, req) {
  // Log request details for debugging
  try {
    context.log('[google-me] Request:', {
      method: req.method,
      origin: req.headers && req.headers.origin,
      url: req.url
    });
  } catch (_) {}
  
  // Handle OPTIONS preflight requests
  if (req.method === "OPTIONS") {
    const headers = {};
    setCorsHeaders(headers, req);
    try {
      context.log('[google-me] OPTIONS response headers:', headers);
    } catch (_) {}
    context.res = { status: 200, headers, body: "" };
    return;
  }
  
  if (req.method !== "GET") {
    const headers = { "Allow": "GET" };
    setCorsHeaders(headers, req);
    context.res = { status: 405, headers, body: "" };
    return;
  }
  
  const headers = { "Content-Type": "application/json" };
  setCorsHeaders(headers, req);
  
  try {
    context.log('[google-me] GET response headers:', headers);
  } catch (_) {}
  
  const session = getSession(req);
  if (!session) {
    context.res = { status: 401, headers, body: JSON.stringify({ authenticated: false }) };
    return;
  }
  context.res = { status: 200, headers, body: JSON.stringify({ authenticated: true, user: { sub: session.sub, email: session.email }, scope: session.scope }) };
};


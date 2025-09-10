const { parseCookies } = require("../_lib/session");

module.exports = async function (context, req) {
  if (req.method !== "GET") {
    context.res = { status: 405, headers: { "Allow": "GET" }, body: "" };
    return;
  }

  // Allow diagnostics for debugging (remove in production)
  // For now, allow access without key for debugging purposes
  const diagKey = process.env.DIAGNOSTICS_KEY;
  const providedKey = req.query.key || req.headers["x-diagnostics-key"];
  
  // Only require key if one is set in environment
  if (diagKey && providedKey !== diagKey) {
    context.res = { 
      status: 403, 
      headers: { "Content-Type": "application/json" }, 
      body: JSON.stringify({ error: "Unauthorized", note: "Diagnostics key required" }) 
    };
    return;
  }

  const diagnostics = {
    timestamp: new Date().toISOString(),
    environment: {
      NODE_ENV: process.env.NODE_ENV || 'undefined',
      FUNCTIONS_WORKER_RUNTIME: process.env.FUNCTIONS_WORKER_RUNTIME || 'undefined',
      APP_BASE_URL: process.env.APP_BASE_URL || 'MISSING',
      GOOGLE_CLIENT_ID: process.env.GOOGLE_CLIENT_ID ? 'SET' : 'MISSING',
      GOOGLE_CLIENT_SECRET: process.env.GOOGLE_CLIENT_SECRET ? 'SET' : 'MISSING',
      GOOGLE_SCOPES: process.env.GOOGLE_SCOPES || 'DEFAULT',
      COOKIE_SECRET: process.env.COOKIE_SECRET ? 'SET' : 'MISSING',
      COOKIE_SIGNING_SECRET: process.env.COOKIE_SIGNING_SECRET ? 'SET' : 'MISSING',
      COOKIE_SECURE: process.env.COOKIE_SECURE || 'true (default)'
    },
    request: {
      method: req.method,
      url: req.url,
      headers: {
        'user-agent': req.headers['user-agent'],
        'host': req.headers['host'],
        'cookie': req.headers['cookie'] ? 'present' : 'missing'
      },
      query: req.query || {}
    },
    cookies: parseCookies(req),
    redirectUri: (process.env.APP_BASE_URL || "") + "/api/google/callback"
  };

  context.res = {
    status: 200,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(diagnostics, null, 2)
  };
};

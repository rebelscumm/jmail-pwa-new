const fetch = global.fetch;

const SERVER_ENDPOINTS = [
  { name: "Google Login", path: "/api/google-login" },
  { name: "Google Callback", path: "/api/google-callback" },
  { name: "Google Me", path: "/api/google-me" },
  { name: "Google Refresh", path: "/api/google-refresh" },
  { name: "Google Logout", path: "/api/google-logout" },
  { name: "Google Token Info", path: "/api/google-tokeninfo" },
  { name: "Gmail Proxy Profile", path: "/api/gmail/users/me/profile" }
];

function sanitize(value) {
  if (value === undefined || value === null) return "";
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function renderTableRows(rows) {
  return rows
    .map(
      (row) => `<tr>
    <td>${sanitize(row.name)}</td>
    <td>${sanitize(row.status)}</td>
    <td>${sanitize(row.details)}</td>
  </tr>`
    )
    .join("\n");
}

module.exports = async function (context, req) {
  const proto =
    req.headers["x-forwarded-proto"] ||
    (req.headers["x-arr-ssl"] ? "https" : "http");
  const host =
    req.headers["x-original-host"] || req.headers.host || "localhost:7071";
  const baseUrl = `${proto}://${host}`;

  const serverResults = [];

  for (const endpoint of SERVER_ENDPOINTS) {
    const url = `${baseUrl}${endpoint.path}`;
    const start = Date.now();
    try {
      const res = await fetch(url, {
        method: "GET",
        headers: {
          Cookie: req.headers.cookie || "",
        },
        redirect: "manual",
      });
      const elapsed = Date.now() - start;
      let snippet = "";
      try {
        const text = await res.text();
        snippet = text.slice(0, 200);
      } catch (err) {
        snippet = `<<unable to read body: ${err.message}>>`;
      }
      serverResults.push({
        name: endpoint.name,
        status: `${res.status} ${res.statusText || ""}`.trim(),
        details: `URL: ${url}
Time: ${elapsed}ms
Body: ${snippet}`,
      });
    } catch (err) {
      const elapsed = Date.now() - start;
      serverResults.push({
        name: endpoint.name,
        status: "ERROR",
        details: `URL: ${url}
Time: ${elapsed}ms
Error: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }

  const envStatus = [
    {
      name: "APP_BASE_URL",
      status: process.env.APP_BASE_URL ? "SET" : "MISSING",
      details: process.env.APP_BASE_URL || "Not configured",
    },
    {
      name: "GOOGLE_CLIENT_ID",
      status: process.env.GOOGLE_CLIENT_ID ? "SET" : "MISSING",
      details: process.env.GOOGLE_CLIENT_ID ? "Configured" : "Required",
    },
    {
      name: "GOOGLE_CLIENT_SECRET",
      status: process.env.GOOGLE_CLIENT_SECRET ? "SET" : "MISSING",
      details: process.env.GOOGLE_CLIENT_SECRET ? "Configured" : "Required",
    },
    {
      name: "COOKIE_SECRET",
      status: process.env.COOKIE_SECRET ? "SET" : "MISSING",
      details: process.env.COOKIE_SECRET ? "Configured" : "Required",
    },
    {
      name: "COOKIE_SIGNING_SECRET",
      status: process.env.COOKIE_SIGNING_SECRET ? "SET" : "MISSING",
      details: process.env.COOKIE_SIGNING_SECRET ? "Configured" : "Required",
    },
  ];

  const html = `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <title>Diagnostics Lite</title>
    <style>
      body { font-family: Arial, sans-serif; margin: 2rem; line-height: 1.4; }
      h1 { margin-bottom: 0.5rem; }
      table { border-collapse: collapse; width: 100%; margin-bottom: 2rem; }
      th, td { border: 1px solid #ccc; padding: 0.5rem; text-align: left; vertical-align: top; white-space: pre-wrap; }
      th { background: #f4f4f4; }
      .status-ok { color: #2e7d32; font-weight: bold; }
      .status-error { color: #c62828; font-weight: bold; }
      .status-warning { color: #ed6c02; font-weight: bold; }
      code { font-size: 0.9rem; }
    </style>
  </head>
  <body>
    <h1>Diagnostics Lite</h1>
    <p>Base URL: <code>${sanitize(baseUrl)}</code></p>
    <p>Timestamp: ${sanitize(new Date().toISOString())}</p>
    <h2>Environment Variables</h2>
    <table>
      <tr><th>Variable</th><th>Status</th><th>Details</th></tr>
      ${renderTableRows(envStatus)}
    </table>
    <h2>Server Endpoints</h2>
    <table>
      <tr><th>Endpoint</th><th>Status</th><th>Details</th></tr>
      ${renderTableRows(serverResults)}
    </table>
    <p>Use this page to confirm that the API is reachable from your local machine. If an endpoint shows "ERROR" or unexpected status codes, check that Azure Functions are running and that your environment variables are configured.</p>
  </body>
</html>`;

  context.res = {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
    },
    body: html,
  };
};



















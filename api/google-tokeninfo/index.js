const fetch = global.fetch;
const { getSession } = require("../_lib/session");

module.exports = async function (context, req) {
  if (req.method !== "GET") {
    context.res = { status: 405, headers: { "Allow": "GET" }, body: "" };
    return;
  }

  try {
    // Get current session to extract access token
    const session = getSession(req);
    if (!session) {
      context.res = { 
        status: 401, 
        headers: { "Content-Type": "application/json" }, 
        body: JSON.stringify({ error: "no_session" }) 
      };
      return;
    }

    // For security, we don't expose the actual access token
    // Instead, we'll try to get a fresh token via refresh and then query tokeninfo
    const clientId = process.env.GOOGLE_CLIENT_ID;
    const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
    
    if (!clientId || !clientSecret) {
      context.res = { 
        status: 500, 
        headers: { "Content-Type": "application/json" }, 
        body: JSON.stringify({ error: "Missing GOOGLE_* envs" }) 
      };
      return;
    }

    // Try to get refresh payload to get a fresh access token
    const { getRefreshPayload } = require("../_lib/session");
    const refreshPayload = getRefreshPayload(req);
    
    if (!refreshPayload || !refreshPayload.refresh_token) {
      context.res = { 
        status: 401, 
        headers: { "Content-Type": "application/json" }, 
        body: JSON.stringify({ error: "no_refresh_token" }) 
      };
      return;
    }

    // Get a fresh access token
    const tokenParams = new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      grant_type: "refresh_token",
      refresh_token: refreshPayload.refresh_token
    });

    const tokenResponse = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: tokenParams
    });

    if (!tokenResponse.ok) {
      const errorText = await tokenResponse.text();
      context.res = { 
        status: 401, 
        headers: { "Content-Type": "application/json" }, 
        body: JSON.stringify({ error: "token_refresh_failed", details: errorText.slice(0, 256) }) 
      };
      return;
    }

    const tokenData = await tokenResponse.json();
    const accessToken = tokenData.access_token;

    if (!accessToken) {
      context.res = { 
        status: 401, 
        headers: { "Content-Type": "application/json" }, 
        body: JSON.stringify({ error: "no_access_token_in_refresh" }) 
      };
      return;
    }

    // Now query Google's tokeninfo endpoint
    const tokenInfoUrl = `https://oauth2.googleapis.com/tokeninfo?access_token=${encodeURIComponent(accessToken)}`;
    const tokenInfoResponse = await fetch(tokenInfoUrl, {
      method: "GET"
    });

    if (!tokenInfoResponse.ok) {
      const errorText = await tokenInfoResponse.text();
      context.res = { 
        status: tokenInfoResponse.status, 
        headers: { "Content-Type": "application/json" }, 
        body: JSON.stringify({ error: "tokeninfo_failed", details: errorText.slice(0, 256) }) 
      };
      return;
    }

    const tokenInfo = await tokenInfoResponse.json();

    // Return tokeninfo but don't expose the actual access token
    const safeTokenInfo = {
      scope: tokenInfo.scope,
      expires_in: tokenInfo.expires_in,
      aud: tokenInfo.aud,
      sub: tokenInfo.sub,
      email: tokenInfo.email,
      email_verified: tokenInfo.email_verified,
      access_type: tokenInfo.access_type,
      timestamp: new Date().toISOString()
    };

    context.res = {
      status: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(safeTokenInfo)
    };

  } catch (error) {
    console.error('google-tokeninfo: unhandled error', {
      error: error.message,
      stack: error.stack
    });
    
    context.res = {
      status: 500,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ 
        error: "internal_server_error", 
        message: error.message,
        timestamp: new Date().toISOString()
      })
    };
  }
};
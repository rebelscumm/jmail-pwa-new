"use strict";

const { encryptJson, decryptJson, sign, randomId } = require("./crypto");

const COOKIE_NAME_RT = "g_rt";
const COOKIE_NAME_SESS = "g_sess";
const COOKIE_NAME_PKCE = "g_pkce";
const COOKIE_NAME_STATE = "g_state";
const COOKIE_NAME_OAUTH = "g_oauth"; // Combined PKCE + state for OAuth flow
const COOKIE_NAME_AUTH = "g_auth"; // Combined refresh + session for authenticated state

function isSecureCookies() {
  const v = process.env.COOKIE_SECURE;
  if (typeof v === "string" && v.length) return v === "1" || v.toLowerCase() === "true";
  return true; // default secure
}

function cookieSerialize(name, value, options = {}) {
  const parts = [name + "=" + value];
  if (options.maxAge) parts.push("Max-Age=" + Math.floor(options.maxAge));
  if (options.expires) parts.push("Expires=" + options.expires.toUTCString());
  parts.push("Path=" + (options.path || "/"));
  if (options.domain) parts.push("Domain=" + options.domain);
  if (options.sameSite) parts.push("SameSite=" + options.sameSite);
  if (options.httpOnly) parts.push("HttpOnly");
  if (options.secure) parts.push("Secure");
  return parts.join("; ");
}

function parseCookies(req) {
  const header = req.headers["cookie"]; 
  if (!header) return {};
  const out = {};
  String(header).split(";").forEach((p) => {
    const i = p.indexOf("=");
    if (i === -1) return;
    const k = p.slice(0, i).trim();
    const v = p.slice(i + 1).trim();
    out[k] = v;
  });
  return out;
}

function setRefreshCookie(headers, payload) {
  const months6 = 60 * 60 * 24 * 30 * 6;
  const serialized = encryptJson(payload);
  headers.push(
    cookieSerialize(COOKIE_NAME_RT, serialized, {
      httpOnly: true,
      secure: isSecureCookies(),
      sameSite: "Lax",
      path: "/",
      maxAge: months6
    })
  );
}

function clearRefreshCookie(headers) {
  headers.push(
    cookieSerialize(COOKIE_NAME_RT, "", {
      httpOnly: true,
      secure: isSecureCookies(),
      sameSite: "Lax",
      path: "/",
      expires: new Date(0)
    })
  );
}

function setSessionCookie(headers, session) {
  const hours1 = 60 * 60; 
  const payload = JSON.stringify(session);
  const sig = sign(payload);
  const value = Buffer.from(payload, "utf8").toString("base64") + "." + sig;
  headers.push(
    cookieSerialize(COOKIE_NAME_SESS, value, {
      httpOnly: true,
      secure: isSecureCookies(),
      sameSite: "Lax",
      path: "/",
      maxAge: hours1
    })
  );
}

function clearSessionCookie(headers) {
  headers.push(
    cookieSerialize(COOKIE_NAME_SESS, "", {
      httpOnly: true,
      secure: isSecureCookies(),
      sameSite: "Lax",
      path: "/",
      expires: new Date(0)
    })
  );
}

// Combined auth cookie that stores both refresh token and session in one cookie
// This avoids issues with multiple Set-Cookie headers not being handled correctly by SWA CLI
function setAuthCookie(headers, refreshPayload, session) {
  const months6 = 60 * 60 * 24 * 30 * 6;
  const refreshSerialized = encryptJson(refreshPayload);
  const sessionPayload = JSON.stringify(session);
  const sessionSig = sign(sessionPayload);
  const sessionValue = Buffer.from(sessionPayload, "utf8").toString("base64") + "." + sessionSig;
  
  // Combine both into one JSON object, then base64 encode
  const combined = JSON.stringify({ r: refreshSerialized, s: sessionValue });
  const encoded = Buffer.from(combined).toString('base64');
  
  headers.push(
    cookieSerialize(COOKIE_NAME_AUTH, encoded, {
      httpOnly: true,
      secure: true, // Use secure for consistency with OAuth cookie
      sameSite: "Lax",
      path: "/",
      maxAge: months6
    })
  );
}

function clearAuthCookie(headers) {
  headers.push(
    cookieSerialize(COOKIE_NAME_AUTH, "", {
      httpOnly: true,
      secure: true,
      sameSite: "Lax",
      path: "/",
      expires: new Date(0)
    })
  );
}

function getAuthFromCookie(req) {
  const cookies = parseCookies(req);
  const v = cookies[COOKIE_NAME_AUTH];
  if (!v) return { refresh: null, session: null };
  
  try {
    const decoded = Buffer.from(v, 'base64').toString('utf8');
    const parsed = JSON.parse(decoded);
    
    // Decrypt refresh token
    const refresh = parsed.r ? decryptJson(parsed.r) : null;
    
    // Verify and parse session
    let session = null;
    if (parsed.s) {
      const dot = parsed.s.lastIndexOf(".");
      if (dot !== -1) {
        const payloadB64 = parsed.s.slice(0, dot);
        const sig = parsed.s.slice(dot + 1);
        const payload = Buffer.from(payloadB64, "base64").toString("utf8");
        if (sign(payload) === sig) {
          const sess = JSON.parse(payload);
          if (typeof sess.exp !== "number" || Date.now() / 1000 <= sess.exp) {
            session = sess;
          }
        }
      }
    }
    
    return { refresh, session };
  } catch (_) {
    return { refresh: null, session: null };
  }
}

function getSession(req) {
  // First check combined auth cookie
  const { session: authSession } = getAuthFromCookie(req);
  if (authSession) return authSession;
  
  // Fall back to individual session cookie
  const cookies = parseCookies(req);
  const v = cookies[COOKIE_NAME_SESS];
  if (!v) return null;
  const dot = v.lastIndexOf(".");
  if (dot === -1) return null;
  const payloadB64 = v.slice(0, dot);
  const sig = v.slice(dot + 1);
  const payload = Buffer.from(payloadB64, "base64").toString("utf8");
  if (sign(payload) !== sig) return null;
  try {
    const session = JSON.parse(payload);
    if (typeof session.exp === "number" && Date.now() / 1000 > session.exp) return null;
    return session;
  } catch {
    return null;
  }
}

function getRefreshPayload(req) {
  // First check combined auth cookie
  const { refresh: authRefresh } = getAuthFromCookie(req);
  if (authRefresh) return authRefresh;
  
  // Fall back to individual refresh cookie
  const cookies = parseCookies(req);
  const enc = cookies[COOKIE_NAME_RT];
  if (!enc) return null;
  return decryptJson(enc);
}

function setPkceCookie(headers, verifier) {
  // Use SameSite=None for OAuth flow - the callback comes from a cross-site redirect
  // For SameSite=None, Secure is required (localhost is treated as secure context)
  headers.push(
    cookieSerialize(COOKIE_NAME_PKCE, verifier, {
      httpOnly: true,
      secure: true, // Required for SameSite=None
      sameSite: "None",
      path: "/",
      maxAge: 300
    })
  );
}

// Combined OAuth cookie that stores both PKCE verifier and state in one cookie
// This avoids issues with multiple Set-Cookie headers not being handled correctly
function setOAuthCookie(headers, verifier, state) {
  // Combine verifier and state with a separator that won't appear in either value
  const combined = JSON.stringify({ v: verifier, s: state });
  const encoded = Buffer.from(combined).toString('base64');
  headers.push(
    cookieSerialize(COOKIE_NAME_OAUTH, encoded, {
      httpOnly: true,
      secure: true, // Required for SameSite=None
      sameSite: "None",
      path: "/",
      maxAge: 600
    })
  );
}

function popOAuthCookie(req, headers) {
  const cookies = parseCookies(req);
  const v = cookies[COOKIE_NAME_OAUTH];
  // Don't add a clear cookie - we only want one Set-Cookie header (the g_auth cookie)
  // The g_oauth cookie will naturally expire or be overwritten on next login
  if (!v) return { verifier: null, state: null };
  try {
    const decoded = Buffer.from(v, 'base64').toString('utf8');
    const parsed = JSON.parse(decoded);
    return { verifier: parsed.v || null, state: parsed.s || null };
  } catch (_) {
    return { verifier: null, state: null };
  }
}

function popPkceVerifier(req, headers) {
  const cookies = parseCookies(req);
  const v = cookies[COOKIE_NAME_PKCE];
  headers.push(
    cookieSerialize(COOKIE_NAME_PKCE, "", {
      httpOnly: true,
      secure: isSecureCookies(),
      sameSite: "Lax",
      path: "/",
      expires: new Date(0)
    })
  );
  return v || null;
}

function setStateCookie(headers, state) {
  // URL-encode the state value to handle special characters like : and %
  // Use SameSite=None for OAuth flow - the callback comes from a cross-site redirect
  // For SameSite=None, Secure is required (localhost is treated as secure context)
  headers.push(
    cookieSerialize(COOKIE_NAME_STATE, encodeURIComponent(state), {
      httpOnly: true,
      secure: true, // Required for SameSite=None
      sameSite: "None",
      path: "/",
      maxAge: 600
    })
  );
}

function popStateCookie(req, headers) {
  const cookies = parseCookies(req);
  const v = cookies[COOKIE_NAME_STATE];
  headers.push(
    cookieSerialize(COOKIE_NAME_STATE, "", {
      httpOnly: true,
      secure: isSecureCookies(),
      sameSite: "Lax",
      path: "/",
      expires: new Date(0)
    })
  );
  // URL-decode the state value since we encoded it when setting
  if (!v) return null;
  try {
    return decodeURIComponent(v);
  } catch (_) {
    return v; // fallback to raw value if decoding fails
  }
}

module.exports = {
  COOKIE_NAME_RT,
  COOKIE_NAME_SESS,
  COOKIE_NAME_AUTH,
  parseCookies,
  setRefreshCookie,
  clearRefreshCookie,
  setSessionCookie,
  clearSessionCookie,
  setAuthCookie,
  clearAuthCookie,
  getAuthFromCookie,
  getSession,
  getRefreshPayload,
  setPkceCookie,
  popPkceVerifier,
  setStateCookie,
  popStateCookie,
  setOAuthCookie,
  popOAuthCookie,
  randomId
};


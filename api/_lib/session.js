"use strict";

const { encryptJson, decryptJson, sign, randomId } = require("./crypto");

const COOKIE_NAME_RT = "g_rt";
const COOKIE_NAME_SESS = "g_sess";
const COOKIE_NAME_PKCE = "g_pkce";
const COOKIE_NAME_STATE = "g_state";

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

function getSession(req) {
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
  const cookies = parseCookies(req);
  const enc = cookies[COOKIE_NAME_RT];
  if (!enc) return null;
  return decryptJson(enc);
}

function setPkceCookie(headers, verifier) {
  headers.push(
    cookieSerialize(COOKIE_NAME_PKCE, verifier, {
      httpOnly: true,
      secure: isSecureCookies(),
      sameSite: "Lax",
      path: "/",
      maxAge: 300
    })
  );
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
  headers.push(
    cookieSerialize(COOKIE_NAME_STATE, state, {
      httpOnly: true,
      secure: isSecureCookies(),
      sameSite: "Lax",
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
  return v || null;
}

module.exports = {
  COOKIE_NAME_RT,
  COOKIE_NAME_SESS,
  parseCookies,
  setRefreshCookie,
  clearRefreshCookie,
  setSessionCookie,
  clearSessionCookie,
  getSession,
  getRefreshPayload,
  setPkceCookie,
  popPkceVerifier,
  setStateCookie,
  popStateCookie,
  randomId
};


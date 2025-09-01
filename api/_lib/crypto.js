"use strict";

const crypto = require("crypto");

// Helpers: base64url without padding
function base64urlEncode(buf) {
  return Buffer.from(buf)
    .toString("base64")
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}

function base64urlDecode(str) {
  const pad = 4 - (str.length % 4 || 4);
  const b64 = (str + "===").slice(0, str.length + pad).replace(/-/g, "+").replace(/_/g, "/");
  return Buffer.from(b64, "base64");
}

function getKeyFromEnv() {
  const secret = process.env.COOKIE_SECRET || process.env.SESSION_SECRET || "dev_secret_change_me";
  // Derive 32-byte key using SHA-256 of provided secret
  return crypto.createHash("sha256").update(String(secret)).digest();
}

function encryptJson(data) {
  const key = getKeyFromEnv();
  const iv = crypto.randomBytes(12); // GCM nonce
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const plaintext = Buffer.from(JSON.stringify(data), "utf8");
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [base64urlEncode(iv), base64urlEncode(ciphertext), base64urlEncode(tag)].join(".");
}

function decryptJson(token) {
  try {
    const [ivB64, ctB64, tagB64] = String(token).split(".");
    if (!ivB64 || !ctB64 || !tagB64) return null;
    const key = getKeyFromEnv();
    const iv = base64urlDecode(ivB64);
    const ciphertext = base64urlDecode(ctB64);
    const tag = base64urlDecode(tagB64);
    const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAuthTag(tag);
    const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    return JSON.parse(plaintext.toString("utf8"));
  } catch (_) {
    return null;
  }
}

function sign(data) {
  const key = process.env.COOKIE_SIGNING_SECRET || process.env.COOKIE_SECRET || "dev_secret_change_me";
  return base64urlEncode(crypto.createHmac("sha256", String(key)).update(data).digest());
}

function randomId(bytes = 16) {
  return base64urlEncode(crypto.randomBytes(bytes));
}

function sha256Base64url(input) {
  return base64urlEncode(crypto.createHash("sha256").update(input).digest());
}

module.exports = {
  base64urlEncode,
  base64urlDecode,
  encryptJson,
  decryptJson,
  sign,
  randomId,
  sha256Base64url
};


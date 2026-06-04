import crypto from "crypto";

const ADMIN_KEY = mustEnv("ADMIN_KEY");

export const DEFAULT_SHOW_SELF = true;

export function sha256(s) {
  return crypto.createHash("sha256").update(s).digest("hex");
}

export function mustEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env var: ${name}`);
  return v;
}

// Initialize LiveKit Room Service client for admin operations
// RoomServiceClient needs HTTP URL, not WebSocket URL
// Convert ws:// to http:// and wss:// to https://
export function toHttpUrl(wsUrl) {
  return wsUrl.replace(/^wss:/, "https:").replace(/^ws:/, "http:");
}

export function requireAdmin(req, res, next) {
  const key = req.header("x-admin-key");
  if (!key || key !== ADMIN_KEY) return res.status(401).json({ error: "unauthorized" });
  next();
}

export function log(message) {
  let timestamp = new Date().toISOString();
  console.log(`${timestamp} ${message}`);
}

export function toWsUrl(u) {
  return u.replace(/^https:\/\//, "wss://").replace(/^http:\/\//, "ws://");
}

export function nowSec() {
  return Math.floor(Date.now() / 1000);
}

export function randomId(bytes = 16) {
  return crypto.randomBytes(bytes).toString("base64url");
}

export function sanitizeIdentity(raw) {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  if (!/^p_[A-Za-z0-9_-]{3,64}$/.test(trimmed)) return null;
  return trimmed;
}

export function parseBooleanAttr(value, fallback = true) {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (["true", "1", "yes", "on"].includes(normalized)) return true;
    if (["false", "0", "no", "off"].includes(normalized)) return false;
  }
  return fallback;
}

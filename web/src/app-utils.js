import {
  Track,
} from "livekit-client";

const BASE_PATH = (import.meta.env.BASE_URL || "/").replace(/\/$/, "");
const IDENTITY_STORAGE_PREFIX = "clasp_vc_identity:";

export function clearRoom(room) {
  try {
    room.removeAllListeners();
  } catch (e) {
    console.log("Unable to remove room listeners", e);
  }
  try {
    room.disconnect();
  } catch (e) {
    console.log("Unable to disconnect from room", e);
  }
}

export function parseInviteFromUrl() {
  const pathname = stripBasePath(window.location.pathname);
  const m = pathname.match(/^\/join\/([^/]+)\/?$/);
  const inviteId = m?.[1] || null;
  const params = new URLSearchParams(window.location.search);
  const key = params.get("k");
  const adminKey = params.get("adminKey");

  // Direct join parameters (admin-generated tokens)
  const token = params.get("token");
  const roomName = params.get("room");
  const name = params.get("name");

  return { inviteId, key, adminKey, token, roomName, name };
}

export function stripBasePath(pathname) {
  if (BASE_PATH && pathname.startsWith(BASE_PATH)) {
    const next = pathname.slice(BASE_PATH.length);
    return next.startsWith("/") ? next : `/${next}`;
  }
  return pathname;
}

function sessionKey(inviteId, key) {
  if (!inviteId || !key) return null;
  return `${IDENTITY_STORAGE_PREFIX}${inviteId}:${key}`;
}

function getIdentityStorage() {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

export function loadStoredSession(inviteId, key) {
  const storage = getIdentityStorage();
  const storageKey = sessionKey(inviteId, key);
  if (!storage || !storageKey) return null;
  try {
    const raw = storage.getItem(storageKey);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

export function saveStoredSession(inviteId, key, data) {
  const storage = getIdentityStorage();
  const storageKey = sessionKey(inviteId, key);
  if (!storage || !storageKey) return;
  try {
    storage.setItem(storageKey, JSON.stringify(data));
  } catch {
    console.warn("Unable to set storage item", storageKey);
  }
}

export function clearStoredSession(inviteId, key) {
  const storage = getIdentityStorage();
  const storageKey = sessionKey(inviteId, key);
  if (!storage || !storageKey) return;
  try {
    storage.removeItem(storageKey);
  } catch {
    console.warn("Unable to remove storage item", storageKey);
  }
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

export function isAdminPath() {
  return stripBasePath(window.location.pathname).startsWith("/admin");
}

export function isRecordingPath() {
  return stripBasePath(window.location.pathname).startsWith("/recording");
}

export function hasSubscribedVideo(participant) {
  if (!participant) return false;
  for (const pub of participant.trackPublications.values()) {
    if (pub.kind === Track.Kind.Video && pub.track && pub.isSubscribed) {
      return true;
    }
  }
  return false;
}

export async function remoteLog(message) {
  await fetch("/api/log", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ message }),
  }).catch((err) => {
    console.log("Debug failed: " + err);
  });
}

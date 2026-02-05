/**
 * Admin API utilities
 * All admin APIs require x-admin-key header
 */

function getAdminKey() {
  // Get from sessionStorage or query param for security
  return sessionStorage.getItem("adminKey") || new URLSearchParams(window.location.search).get("adminKey");
}

function makeAdminRequest(endpoint, options = {}) {
  const adminKey = getAdminKey();
  if (!adminKey) {
    throw new Error("Admin key not found. Use ?adminKey=YOUR_KEY");
  }

  const { timeoutMs = 8000, ...rest } = options;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  return fetch(endpoint, {
    ...rest,
    signal: controller.signal,
    headers: {
      "x-admin-key": adminKey,
      "content-type": "application/json",
      ...rest.headers,
    },
  })
    .catch((err) => {
      if (err?.name === "AbortError") {
        throw new Error("Request timed out");
      }
      throw err;
    })
    .finally(() => clearTimeout(timeoutId));
}

async function parseResponse(r, label) {
  const text = await r.text().catch(() => "");
  let data = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = null;
    }
  }
  if (!r.ok) {
    const detail = data?.error || text;
    const suffix = detail ? ` - ${detail}` : "";
    throw new Error(`${label} failed: ${r.status}${suffix}`);
  }
  return data ?? {};
}

export async function getRooms() {
  const r = await makeAdminRequest("/api/admin/rooms");
  return parseResponse(r, "getRooms");
}

export async function getRoom() {
  const r = await makeAdminRequest("/api/admin/room");
  return parseResponse(r, "getRoom");
}

export async function getParticipants(roomName) {
  const r = await makeAdminRequest(`/api/admin/rooms/${encodeURIComponent(roomName)}/participants`);
  return parseResponse(r, "getParticipants");
}

export async function removeParticipant(roomName, identity) {
  const r = await makeAdminRequest(
    `/api/admin/rooms/${encodeURIComponent(roomName)}/participants/${encodeURIComponent(identity)}/remove`,
    { method: "POST" }
  );
  return parseResponse(r, "removeParticipant");
}

export async function startRecording(room, mode) {
  const r = await makeAdminRequest("/api/admin/recording/start", {
    method: "POST",
    body: JSON.stringify({ room, mode }),
  });
  return parseResponse(r, "startRecording");
}

export async function stopRecording(room, mode) {
  const r = await makeAdminRequest("/api/admin/recording/stop", {
    method: "POST",
    body: JSON.stringify({ room, mode: mode || "all" }),
  });
  return parseResponse(r, "stopRecording");
}

export async function getRecordingStatus(room) {
  const r = await makeAdminRequest(`/api/admin/recording/status?room=${encodeURIComponent(room)}`);
  return parseResponse(r, "getRecordingStatus");
}

export async function setStreamDelay(room, participant, delayMs) {
  const r = await makeAdminRequest("/api/admin/stream-delay", {
    method: "POST",
    body: JSON.stringify({ room, participant, delayMs }),
  });
  return parseResponse(r, "setStreamDelay");
}

export async function getStreamDelayStatus(room) {
  const r = await makeAdminRequest(`/api/admin/stream-delay/status?room=${encodeURIComponent(room)}`);
  return parseResponse(r, "getStreamDelayStatus");
}

export async function getPreviewToken(room) {
  const r = await makeAdminRequest("/api/admin/preview-token", {
    method: "POST",
    body: JSON.stringify({ room }),
  });
  return parseResponse(r, "getPreviewToken");
}

export async function getHealth() {
  const r = await makeAdminRequest("/api/admin/health");
  return parseResponse(r, "getHealth");
}

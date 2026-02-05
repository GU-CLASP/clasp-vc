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

export async function getRooms() {
  const r = await makeAdminRequest("/api/admin/rooms");
  if (!r.ok) throw new Error(`getRooms failed: ${r.status}`);
  return r.json();
}

export async function getParticipants(roomName) {
  const r = await makeAdminRequest(`/api/admin/rooms/${encodeURIComponent(roomName)}/participants`);
  if (!r.ok) throw new Error(`getParticipants failed: ${r.status}`);
  return r.json();
}

export async function startRecording(room, mode) {
  const r = await makeAdminRequest("/api/admin/recording/start", {
    method: "POST",
    body: JSON.stringify({ room, mode }),
  });
  if (!r.ok) throw new Error(`startRecording failed: ${r.status}`);
  return r.json();
}

export async function stopRecording(room, mode) {
  const r = await makeAdminRequest("/api/admin/recording/stop", {
    method: "POST",
    body: JSON.stringify({ room, mode: mode || "all" }),
  });
  if (!r.ok) throw new Error(`stopRecording failed: ${r.status}`);
  return r.json();
}

export async function getRecordingStatus(room) {
  const r = await makeAdminRequest(`/api/admin/recording/status?room=${encodeURIComponent(room)}`);
  if (!r.ok) throw new Error(`getRecordingStatus failed: ${r.status}`);
  return r.json();
}

export async function setStreamDelay(room, participant, delayMs) {
  const r = await makeAdminRequest("/api/admin/stream-delay", {
    method: "POST",
    body: JSON.stringify({ room, participant, delayMs }),
  });
  if (!r.ok) throw new Error(`setStreamDelay failed: ${r.status}`);
  return r.json();
}

export async function getStreamDelayStatus(room) {
  const r = await makeAdminRequest(`/api/admin/stream-delay/status?room=${encodeURIComponent(room)}`);
  if (!r.ok) throw new Error(`getStreamDelayStatus failed: ${r.status}`);
  return r.json();
}

export async function getPreviewToken(room) {
  const r = await makeAdminRequest("/api/admin/preview-token", {
    method: "POST",
    body: JSON.stringify({ room }),
  });
  if (!r.ok) throw new Error(`getPreviewToken failed: ${r.status}`);
  return r.json();
}

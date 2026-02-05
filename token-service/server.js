import express from "express";
import cors from "cors";
import crypto from "crypto";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import {
  AccessToken,
  RoomServiceClient,
  EgressClient,
  EncodedFileOutput,
  EncodedFileType,
  EncodingOptionsPreset,
} from "livekit-server-sdk";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Where token-service can read/write recording files (shared volume with the egress container).
// In compose.yml we mount host ./data/recordings -> token-service:/app/recordings and egress:/out/recordings
const RECORDINGS_DIR = process.env.RECORDINGS_DIR
  ? path.resolve(process.env.RECORDINGS_DIR)
  : path.join(__dirname, "recordings");

// Where the egress container should write files *inside the egress container*.
// This must match the egress volume mount in compose.yml.
const EGRESS_FILE_BASE = process.env.EGRESS_FILE_BASE || "/out/recordings";

function ensureWritableDir(dirPath) {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true, mode: 0o777 });
  }
  try {
    fs.chmodSync(dirPath, 0o777);
  } catch (err) {
    console.warn(`Unable to chmod ${dirPath}:`, err.message || err);
  }
}

// Ensure recordings directory exists and is writable by egress container
ensureWritableDir(RECORDINGS_DIR);

const app = express();
app.use(express.json());
app.use(cors({ origin: true }));
app.use((req, _res, next) => {
  console.log(`${req.method} ${req.path}`);
  next();
});

const PORT = Number(process.env.PORT || 9000);
const LIVEKIT_URL = mustEnv("LIVEKIT_URL");
const LIVEKIT_URL_INTERNAL = process.env.LIVEKIT_URL_INTERNAL || LIVEKIT_URL;
const LIVEKIT_API_KEY = mustEnv("LIVEKIT_API_KEY");
const LIVEKIT_API_SECRET = mustEnv("LIVEKIT_API_SECRET");
const ADMIN_KEY = mustEnv("ADMIN_KEY");
const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL || "http://127.0.0.1:5173";
const DELAY_SERVICE_URL = process.env.DELAY_SERVICE_URL || "http://127.0.0.1:9100";
const RECORDING_BASE_URL = process.env.RECORDING_BASE_URL || PUBLIC_BASE_URL;

// Initialize LiveKit Room Service client for admin operations
// RoomServiceClient needs HTTP URL, not WebSocket URL
// Convert ws:// to http:// and wss:// to https://
function toHttpUrl(wsUrl) {
  return wsUrl.replace(/^wss:/, "https:").replace(/^ws:/, "http:");
}

const LIVEKIT_HTTP_URL = toHttpUrl(LIVEKIT_URL_INTERNAL);

const roomService = new RoomServiceClient(LIVEKIT_HTTP_URL, LIVEKIT_API_KEY, LIVEKIT_API_SECRET);

// Egress client for starting/stopping recordings
const egressClient = new EgressClient(
  LIVEKIT_HTTP_URL,  // must be http(s), not ws(s)
  LIVEKIT_API_KEY,
  LIVEKIT_API_SECRET
);

// In-memory store for active recordings: roomName -> recordingState
const recordingState = new Map();
const individualMonitors = new Map(); // roomName -> interval id

const INVITE_TTL_SECONDS = Number(process.env.INVITE_TTL_SECONDS || 86400); // 24h
const INVITE_MAX_USES = Number(process.env.INVITE_MAX_USES || 1);

// In-memory invite store for a pilot.
// For anything serious, swap to Redis/Postgres.
const invites = new Map(); // inviteId -> { secretHash, room, role, exp, uses, maxUses }

// Track participant identities issued per invite so we can clean up relays on leave.
const identitySessions = new Map(); // identity -> { inviteId, room, name }

function toWsUrl(u) {
  return u.replace(/^https:\/\//, "wss://").replace(/^http:\/\//, "ws://");
}

function mustEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env var: ${name}`);
  return v;
}

function nowSec() {
  return Math.floor(Date.now() / 1000);
}

function randomId(bytes = 16) {
  return crypto.randomBytes(bytes).toString("base64url");
}

const DEFAULT_ROOM_NAME =
  process.env.SINGLE_ROOM_NAME ||
  process.env.DEFAULT_ROOM_NAME ||
  process.env.ROOM_NAME ||
  `room_${randomId(12)}`;

function sha256(s) {
  return crypto.createHash("sha256").update(s).digest("hex");
}

function sanitizeIdentity(raw) {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  if (!/^p_[A-Za-z0-9_-]{3,64}$/.test(trimmed)) return null;
  return trimmed;
}

function formatTimestamp(d = new Date()) {
  const pad = (n, w = 2) => String(n).padStart(w, "0");
  return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}_` +
    `${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}${pad(d.getUTCMilliseconds(), 3)}`;
}

function sanitizeFilePart(value, fallback = "participant") {
  const cleaned = String(value || "")
    .trim()
    .replace(/\s+/g, "_")
    .replace(/[^a-zA-Z0-9._-]/g, "")
    .slice(0, 40);
  return cleaned || fallback;
}

async function delayServiceRequest(pathname, options = {}) {
  const url = `${DELAY_SERVICE_URL}${pathname}`;
  const headers = {
    "content-type": "application/json",
    "x-admin-key": ADMIN_KEY,
    ...(options.headers || {}),
  };
  const started = Date.now();
  let res;
  try {
    res = await fetchWithTimeout(url, { ...options, headers }, 5000);
  } catch (err) {
    const ms = Date.now() - started;
    console.error(`[delay-service] ${options.method || "GET"} ${pathname} -> network error (${ms}ms):`, err?.message || err);
    throw new Error(`delay-service request failed: ${err?.message || err}`);
  }
  const ms = Date.now() - started;
  if (!res.ok) {
    const t = await res.text().catch(() => "");
    console.error(`[delay-service] ${options.method || "GET"} ${pathname} -> ${res.status} (${ms}ms): ${t}`);
    throw new Error(`delay-service failed: ${res.status} ${t}`);
  }
  console.log(`[delay-service] ${options.method || "GET"} ${pathname} -> ${res.status} (${ms}ms)`);
  return res.json();
}

async function fetchWithTimeout(url, options = {}, timeoutMs = 4000) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timeoutId);
  }
}

async function getExistingDelay(room, participant) {
  if (!room || !participant) return 0;
  try {
    const payload = await delayServiceRequest(`/delay/status?room=${encodeURIComponent(room)}`, {
      method: "GET",
    });
    const value = Number(payload?.delays?.[participant] ?? 0);
    return Number.isFinite(value) ? value : 0;
  } catch (err) {
    console.warn("getExistingDelay failed:", err?.message || err);
    return 0;
  }
}

function egressPathFor(room, filename) {
  // Egress file paths must be POSIX-style paths inside the egress container.
  return path.posix.join(EGRESS_FILE_BASE, room, filename);
}

function isRecordableParticipant(identity) {
  if (!identity) return false;
  if (identity.startsWith("relay_")) return false;
  if (identity.startsWith("EG_")) return false;
  if (identity.startsWith("admin_")) return false;
  return identity.startsWith("p_");
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function listEgressParticipants(room) {
  const participants = await roomService.listParticipants(room);
  return participants.filter((p) => p.identity?.startsWith("EG_"));
}

async function tagEgressParticipant(room, identity, mode) {
  try {
    const info = await roomService.getParticipant(room, identity);
    const attributes = { ...(info?.attributes || {}), egressMode: mode };
    let metadata = typeof info?.metadata === "string" ? info.metadata : "";
    if (!metadata.includes("egressMode=")) {
      metadata = metadata ? `${metadata};egressMode=${mode}` : `egressMode=${mode}`;
    }
    await roomService.updateParticipant(room, identity, { attributes, metadata });
  } catch (err) {
    console.warn(`egress tag failed (${identity}, ${mode}):`, err.message || err);
  }
}

async function tagNewEgressParticipants(room, mode, beforeSet, expectedCount = 1) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    try {
      const participants = await listEgressParticipants(room);
      const newOnes = participants.filter((p) => !beforeSet.has(p.identity));
      if (newOnes.length >= expectedCount) {
        for (const p of newOnes) {
          await tagEgressParticipant(room, p.identity, mode);
        }
        return newOnes.map((p) => p.identity);
      }
    } catch (err) {
      console.warn("egress tag polling failed:", err.message || err);
    }
    await sleep(200);
  }
  console.warn(`egress tag timeout: no ${mode} participant detected`);
  return [];
}

async function startParticipantEgress(room, recordingBase, participantIdentity, participantName) {
  const safeName = sanitizeFilePart(participantName || participantIdentity);
  const egressFilepath = egressPathFor(
    room,
    `${recordingBase}_${safeName}_${participantIdentity}.mp4`
  );
  const fileOutput = new EncodedFileOutput({
    filepath: egressFilepath,
    fileType: EncodedFileType.MP4,
  });

  const info = await egressClient.startParticipantEgress(
    room,
    participantIdentity,
    { file: fileOutput },
    { encodingOptions: EncodingOptionsPreset.H264_720P_30 }
  );
  return info.egressId || info.egress_id || null;
}

function stopIndividualMonitor(room) {
  const id = individualMonitors.get(room);
  if (id) {
    clearInterval(id);
    individualMonitors.delete(room);
  }
}

function cleanupEgressJson(room) {
  const roomDir = path.join(RECORDINGS_DIR, room);
  if (!fs.existsSync(roomDir)) return;
  try {
    const files = fs.readdirSync(roomDir);
    for (const file of files) {
      if (/^EG_.*\.json$/i.test(file)) {
        try {
          fs.unlinkSync(path.join(roomDir, file));
        } catch (err) {
          console.warn(`cleanup failed for ${file}:`, err.message || err);
        }
      }
    }
  } catch (err) {
    console.warn("cleanupEgressJson error:", err.message || err);
  }
}

function cleanExpired() {
  const t = nowSec();
  for (const [id, inv] of invites.entries()) {
    if (inv.exp <= t) invites.delete(id);
  }
}
setInterval(cleanExpired, 60_000).unref();

function requireAdmin(req, res, next) {
  const key = req.header("x-admin-key");
  if (!key || key !== ADMIN_KEY) return res.status(401).json({ error: "unauthorized" });
  next();
}

// Health check endpoint for container startup verification
app.get("/api/healthz", (req, res) => {
  res.json({ status: "ok" });
});

/**
 * ADMIN: create an invite link
 * POST /api/invites
 * body: { role?: "participant" | "moderator", ttlSeconds?: number, maxUses?: number }
 *
 * returns: { inviteUrl, inviteId, room }
 */
app.post("/api/invites", requireAdmin, (req, res) => {
  const role = (req.body?.role || "participant").toLowerCase();
  const ttlSeconds = Number(req.body?.ttlSeconds || INVITE_TTL_SECONDS);
  let maxUses = Number(req.body?.maxUses || INVITE_MAX_USES);
  if (Number.isNaN(maxUses)) maxUses = INVITE_MAX_USES;
  if (maxUses <= 0) maxUses = 0; // 0 = unlimited

  const inviteId = randomId(12);
  const inviteSecret = randomId(24);
  const room = DEFAULT_ROOM_NAME;

  const exp = nowSec() + ttlSeconds;
  invites.set(inviteId, {
    secretHash: sha256(inviteSecret),
    room,
    role,
    exp,
    uses: 0,
    maxUses,
  });

  // Your frontend join route: /join/:inviteId?k=...
  // You will serve the web app at https://meet.example.org
  const inviteUrl = `${PUBLIC_BASE_URL}/join/${inviteId}?k=${inviteSecret}`;

  res.json({ inviteUrl, inviteId, room, exp, maxUses });
});

/**
 * CLIENT: exchange invite for LiveKit token
 * POST /api/connection-details
 * body: { inviteId, key, name?, identity? }
 *
 * returns: { url, token, room, identity, role }
 */
app.post("/api/connection-details", async (req, res) => {
  try {
    const { inviteId, key, name, identity: requestedIdentity } = req.body || {};
    if (!inviteId || !key) return res.status(400).json({ error: "missing inviteId/key" });

    const inv = invites.get(inviteId);
    if (!inv) return res.status(404).json({ error: "invalid invite" });

    if (inv.exp <= nowSec()) {
      invites.delete(inviteId);
      return res.status(410).json({ error: "invite expired" });
    }

    if (inv.maxUses > 0 && inv.uses >= inv.maxUses) {
      return res.status(410).json({ error: "invite already used" });
    }
    if (sha256(key) !== inv.secretHash) return res.status(403).json({ error: "invalid key" });

    const requested = sanitizeIdentity(requestedIdentity);
    if (requested) {
      const existingSession = identitySessions.get(requested);
      if (!existingSession || existingSession.inviteId !== inviteId) {
        return res.status(409).json({ error: "identity_revoked" });
      }
    }

    inv.uses += 1;
    if (requested) {
      try {
        await roomService.removeParticipant(inv.room, requested);
      } catch (err) {
        console.warn("reclaim identity removeParticipant error:", err.message || err);
      }
    }

    const identity = requested || `p_${randomId(10)}`;
    const displayName = typeof name === "string" && name.trim() ? name.trim().slice(0, 48) : undefined;

    const at = new AccessToken(LIVEKIT_API_KEY, LIVEKIT_API_SECRET, {
      identity,
      name: displayName,
      ttl: 60 * 15,
    });

    at.addGrant({
      room: inv.room,
      roomJoin: true,
      canPublish: true,
      canSubscribe: true,
      canPublishData: true,
    });

    const token = await at.toJwt(); // ✅ IMPORTANT

    identitySessions.set(identity, { inviteId, room: inv.room, name: displayName });

    try {
      const existingDelay = await getExistingDelay(inv.room, identity);
      await delayServiceRequest("/delay", {
        method: "POST",
        body: JSON.stringify({
          room: inv.room,
          participant: identity,
          delayMs: existingDelay,
          keepAlive: true,
          participantName: displayName,
        }),
      });
    } catch (err) {
      console.warn("delay keepAlive error:", err.message || err);
    }

    res.json({
      url: LIVEKIT_URL,          // http(s)
      wsUrl: toWsUrl(LIVEKIT_URL),
      token,
      room: inv.room,
      identity,
      role: inv.role,
    });

  } catch (err) {
    console.error("connection-details error:", err);
    res.status(500).json({ error: "internal_error" });
  }
});

/**
 * CLIENT: leave session and remove relay placeholder
 * POST /api/leave
 * body: { inviteId, key, identity }
 */
app.post("/api/leave", async (req, res) => {
  try {
    const { inviteId, key, identity } = req.body || {};
    if (!inviteId || !key || !identity) {
      return res.status(400).json({ error: "missing inviteId/key/identity" });
    }

    const inv = invites.get(inviteId);
    if (!inv) return res.status(404).json({ error: "invalid invite" });

    if (inv.exp <= nowSec()) {
      invites.delete(inviteId);
      return res.status(410).json({ error: "invite expired" });
    }

    if (sha256(key) !== inv.secretHash) return res.status(403).json({ error: "invalid key" });

    const session = identitySessions.get(identity);
    if (!session || session.inviteId !== inviteId) {
      return res.status(403).json({ error: "unauthorized" });
    }

    try {
      await roomService.removeParticipant(inv.room, identity);
    } catch (err) {
      console.warn("leave removeParticipant error:", err.message || err);
    }

    try {
      await delayServiceRequest("/delay/remove", {
        method: "POST",
        body: JSON.stringify({ room: inv.room, participant: identity }),
      });
    } catch (err) {
      console.warn("leave delay remove error:", err.message || err);
    }

    identitySessions.delete(identity);
    res.json({ success: true });
  } catch (err) {
    console.error("leave error:", err);
    res.status(500).json({ error: "internal_error" });
  }
});


/**
 * ADMIN: List egress jobs (and errors) for a room
 * GET /api/admin/egress?room=roomName
 */
app.get("/api/admin/egress", requireAdmin, async (req, res) => {
  try {
    const { room } = req.query;
    const list = await egressClient.listEgress(room ? { roomName: String(room) } : {});
    res.json({ egress: list });
  } catch (err) {
    console.error("admin/egress list error:", err);
    res.status(500).json({ error: err.message || "internal_error" });
  }
});


/**
 * ADMIN: Get egress info by id
 * GET /api/admin/egress/:egressId
 */
app.get("/api/admin/egress/:egressId", requireAdmin, async (req, res) => {
  try {
    const { egressId } = req.params;
    const info = await egressClient.getEgress(egressId);
    res.json({ egress: info });
  } catch (err) {
    console.error("admin/egress get error:", err);
    res.status(500).json({ error: err.message || "internal_error" });
  }
});


/**
 * ADMIN: Start recording for a room
 * POST /api/admin/recording/start
 * headers: { x-admin-key: ADMIN_KEY }
 * body: { room, mode: "individual" | "composite" }
 *
 * returns: { success: true, recordingId, egressIds, room, mode }
 */
app.post("/api/admin/recording/start", requireAdmin, async (req, res) => {
  try {
    const { room, mode } = req.body || {};
    if (!room || !mode) {
      return res.status(400).json({ error: "missing room or mode" });
    }

    if (!["individual", "composite"].includes(mode)) {
      return res.status(400).json({ error: "invalid mode; must be 'individual' or 'composite'" });
    }

    const existing = recordingState.get(room)?.[mode];
    if (existing?.status === "recording") {
      return res.status(409).json({
        error: "recording already active",
        recordingId: existing.recordingId,
      });
    }

    const recordingId = `${formatTimestamp()}_${randomId(4)}`;
    const startedAt = new Date().toISOString();

    if (!recordingState.has(room)) {
      recordingState.set(room, {});
    }

    // Ensure room directory exists under the token-service container
    const recordingDir = path.join(RECORDINGS_DIR, room);
    ensureWritableDir(recordingDir);

    const egressIds = [];
    let participantSet = null;

    if (mode === "composite") {
      // Single MP4 file with all participants composited
      // IMPORTANT: this path is inside the Egress container
      // and should map to the host + token-service via volume mounts.
      const egressFilepath = egressPathFor(room, `${recordingId}_ROOM.mp4`);

      const egressBefore = new Set(
        (await listEgressParticipants(room)).map((p) => p.identity)
      );

      const fileOutput = new EncodedFileOutput({
        filepath: egressFilepath,
        fileType: EncodedFileType.MP4,
      });

      const info = await egressClient.startRoomCompositeEgress(
        room,
        { file: fileOutput },
        {
          layout: "grid",
          customBaseUrl: `${RECORDING_BASE_URL}/recording`,
        }
      );

      const egressId = info.egressId || info.egress_id;
      if (!egressId) {
        throw new Error("egress did not return an egressId");
      }
      egressIds.push(egressId);
      await tagNewEgressParticipants(room, "composite", egressBefore, 1);

    } else if (mode === "individual") {
      // Record each participant separately using Participant Egress
      // We snapshot current participants at start time.
      const participants = await roomService.listParticipants(room);
      const recordable = (participants || []).filter((p) => isRecordableParticipant(p.identity));
      if (!recordable || recordable.length === 0) {
        return res.status(409).json({ error: "no participants to record" });
      }
      participantSet = new Set();

      for (const p of recordable) {
        const egressBefore = new Set(
          (await listEgressParticipants(room)).map((p) => p.identity)
        );
        const egressId = await startParticipantEgress(room, recordingId, p.identity, p.name);
        if (egressId) {
          egressIds.push(egressId);
          participantSet.add(p.identity);
          await tagNewEgressParticipants(room, "individual", egressBefore, 1);
        }
      }

      if (egressIds.length === 0) {
        throw new Error("no participants to record, or egress failed to start");
      }

      // Monitor joins and start individual egress for late participants.
      stopIndividualMonitor(room);
      const intervalId = setInterval(async () => {
        const state = recordingState.get(room)?.individual;
        if (!state || state.status !== "recording") return;
        try {
          const current = await roomService.listParticipants(room);
          for (const p of current) {
            if (!isRecordableParticipant(p.identity)) continue;
            if (!state.participants.has(p.identity)) {
              const egressBefore = new Set(
                (await listEgressParticipants(room)).map((p) => p.identity)
              );
              const egressId = await startParticipantEgress(
                room,
                state.recordingId,
                p.identity,
                p.name
              );
              if (egressId) {
                state.egressIds.push(egressId);
                state.participants.add(p.identity);
                await tagNewEgressParticipants(room, "individual", egressBefore, 1);
              }
            }
          }
        } catch (err) {
          console.error("individual monitor error:", err.message || err);
        }
      }, 2000);
      intervalId.unref?.();
      individualMonitors.set(room, intervalId);
    }

    // Update in-memory state
    recordingState.get(room)[mode] = {
      recordingId,
      startedAt,
      status: "recording",
      egressIds,
      participants: mode === "individual" ? participantSet : undefined,
    };

    console.log(
      `Recording started for room ${room}, mode: ${mode}, recordingId: ${recordingId}, egressIds: ${egressIds.join(", ")}`
    );

    res.json({
      success: true,
      recordingId,
      egressIds,
      room,
      mode,
      startedAt,
    });
  } catch (err) {
    console.error("recording/start error:", err);
    res.status(500).json({ error: err.message || "internal_error" });
  }
});


/**
 * ADMIN: Stop recording for a room
 * POST /api/admin/recording/stop
 * headers: { x-admin-key: ADMIN_KEY }
 * body: { room, mode: "individual" | "composite" | "all" }
 *
 * returns: { success: true, recordings: [...] }
 */
app.post("/api/admin/recording/stop", requireAdmin, async (req, res) => {
  try {
    const { room, mode } = req.body || {};
    if (!room) return res.status(400).json({ error: "missing room" });

    const roomRecordings = recordingState.get(room);
    const recordings = [];
    const stopPromises = [];

    if (roomRecordings) {
      const stopMode = mode || "all";

      const stopOneState = (recordMode, state) => {
        if (state.status !== "recording") return;

        const duration = Date.now() - new Date(state.startedAt).getTime();
        recordings.push({
          recordingId: state.recordingId,
          mode: recordMode,
          duration,
        });

        if (recordMode === "individual") {
          stopIndividualMonitor(room);
        }

        state.status = "stopped";
        state.stoppedAt = new Date().toISOString();

        if (Array.isArray(state.egressIds)) {
          for (const egressId of state.egressIds) {
            stopPromises.push(
              egressClient
                .stopEgress(egressId)
                .catch((err) => console.error(`stopEgress failed for ${egressId}:`, err.message || err))
            );
          }
        }
      };

      if (stopMode === "all") {
        for (const [recordMode, state] of Object.entries(roomRecordings)) {
          stopOneState(recordMode, state);
        }
      } else if (["individual", "composite"].includes(stopMode)) {
        const state = roomRecordings[stopMode];
        if (state) stopOneState(stopMode, state);
      }
    }

    // Wait for all stopEgress calls to finish (best-effort)
    if (stopPromises.length > 0) {
      await Promise.all(stopPromises);
    }

    // Remove egress-generated JSON sidecars
    cleanupEgressJson(room);
    const delayedCleanup = setTimeout(() => cleanupEgressJson(room), 5000);
    delayedCleanup.unref?.();

    console.log(`Recording stopped for room ${room}, mode: ${mode || "all"}`);

    res.json({
      success: true,
      recordings,
      room,
    });
  } catch (err) {
    console.error("recording/stop error:", err);
    res.status(500).json({ error: err.message || "internal_error" });
  }
});

/**
 * ADMIN: Get recording status for a room
 * GET /api/admin/recording/status?room=roomName
 * headers: { x-admin-key: ADMIN_KEY }
 *
 * returns: { recordings: [...] }
 */
app.get("/api/admin/recording/status", requireAdmin, (req, res) => {
  try {
    const { room } = req.query;
    if (!room) return res.status(400).json({ error: "missing room query param" });

    const recordings = recordingState.get(room) || {};
    const formatted = Object.entries(recordings).map(([mode, state]) => ({
      mode,
      recordingId: state.recordingId,
      status: state.status,
      startedAt: state.startedAt,
      stoppedAt: state.stoppedAt,
    }));

    res.json({ recordings: formatted, room });
  } catch (err) {
    console.error("recording/status error:", err);
    res.status(500).json({ error: "internal_error" });
  }
});

/**
 * ADMIN: List all recordings
 * GET /api/admin/recordings
 * headers: { x-admin-key: ADMIN_KEY }
 *
 * returns: { recordings: [{ room, recordingId, mode, status, startedAt, stoppedAt, duration }] }
 */
app.get("/api/admin/recordings", requireAdmin, (req, res) => {
  try {
    const recordings = [];
    const rooms = fs.readdirSync(RECORDINGS_DIR);

    for (const room of rooms) {
      const roomDir = path.join(RECORDINGS_DIR, room);
      if (fs.statSync(roomDir).isDirectory()) {
        const files = fs.readdirSync(roomDir);
        for (const file of files) {
          if (file.endsWith(".mp4")) {
            recordings.push({ room, file });
          }
        }
      }
    }

    res.json({ recordings });
  } catch (err) {
    console.error("recordings list error:", err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * ADMIN: Set stream delay for a participant
 * POST /api/admin/stream-delay
 * headers: { x-admin-key: ADMIN_KEY }
 * body: { room, participant, delayMs }
 *
 * returns: { success: true, room, participant, delayMs }
 */
app.post("/api/admin/stream-delay", requireAdmin, async (req, res) => {
  try {
    const { room, participant, delayMs } = req.body || {};
    if (!room || !participant) {
      return res.status(400).json({ error: "missing room or participant" });
    }

    const delay = Number(delayMs) || 0;
    if (delay < 0 || delay > 10000) {
      return res.status(400).json({ error: "delayMs must be between 0 and 10000" });
    }

    const session = identitySessions.get(participant);
    const payload = await delayServiceRequest("/delay", {
      method: "POST",
      body: JSON.stringify({
        room,
        participant,
        delayMs: delay,
        keepAlive: true,
        participantName: session?.name,
      }),
    });

    console.log(`Stream delay set for ${participant} in room ${room}: ${delay}ms`);
    res.json(payload);
  } catch (err) {
    console.error("stream-delay error:", err);
    res.status(500).json({ error: err.message || "internal_error" });
  }
});

/**
 * ADMIN: Get all stream delays for a room
 * GET /api/admin/stream-delay/status?room=roomName
 * headers: { x-admin-key: ADMIN_KEY }
 *
 * returns: { room, delays: { participantName: delayMs, ... } }
 */
app.get("/api/admin/stream-delay/status", requireAdmin, async (req, res) => {
  try {
    const { room } = req.query;
    if (!room) return res.status(400).json({ error: "missing room query param" });
    const payload = await delayServiceRequest(`/delay/status?room=${encodeURIComponent(room)}`, {
      method: "GET",
    });
    res.json(payload);
  } catch (err) {
    console.error("stream-delay/status error:", err);
    res.status(500).json({ error: err.message || "internal_error" });
  }
});

/**
 * ADMIN: Service health
 * GET /api/admin/health
 * headers: { x-admin-key: ADMIN_KEY }
 */
app.get("/api/admin/health", requireAdmin, async (_req, res) => {
  const health = {
    delayService: { ok: false, error: null, ms: null },
    livekit: { ok: false, error: null },
  };

  const start = Date.now();
  try {
    const r = await fetchWithTimeout(`${DELAY_SERVICE_URL}/healthz`, {}, 3000);
    health.delayService.ok = r.ok;
    if (!r.ok) {
      health.delayService.error = `status ${r.status}`;
    }
  } catch (err) {
    health.delayService.error = err?.message || String(err);
  } finally {
    health.delayService.ms = Date.now() - start;
  }

  try {
    await roomService.listRooms();
    health.livekit.ok = true;
  } catch (err) {
    health.livekit.error = err?.message || String(err);
  }

  res.json(health);
});

/**
 * ADMIN: Get rooms and their participants
 * GET /api/admin/rooms
 * headers: { x-admin-key: ADMIN_KEY }
 *
 * returns: { rooms: [{ name, participants: [...] }] }
 */
app.get("/api/admin/rooms", requireAdmin, async (req, res) => {
  try {
    let rooms = [];
    try {
      rooms = await roomService.listRooms();
    } catch (err) {
      console.warn("admin/rooms listRooms failed:", err.message || err);
      rooms = [];
    }
    const roomMap = new Map(rooms.map((room) => [room.name, room]));

    const sessionCounts = new Map();
    for (const [identity, session] of identitySessions.entries()) {
      if (!session?.room) continue;
      if (!sessionCounts.has(session.room)) {
        sessionCounts.set(session.room, new Set());
      }
      sessionCounts.get(session.room).add(identity);
    }

    const allRoomNames = new Set([
      ...roomMap.keys(),
      ...sessionCounts.keys(),
      DEFAULT_ROOM_NAME,
    ]);

    const detailed = await Promise.all(
      Array.from(allRoomNames).map(async (roomName) => {
        const room = roomMap.get(roomName);
        let realParticipantCount = 0;
        try {
          const participants = await roomService.listParticipants(roomName);
          realParticipantCount = participants.filter((p) =>
            isRecordableParticipant(p.identity)
          ).length;
        } catch (err) {
          console.warn("admin/rooms listParticipants failed:", err.message || err);
        }

        const sessionCount = sessionCounts.get(roomName)?.size || 0;
        const logicalCount = Math.max(realParticipantCount, sessionCount);

        return {
          name: roomName,
          participantCount: room?.numParticipants ?? sessionCount,
          realParticipantCount: logicalCount,
          createdAt: room?.creationTime
            ? new Date(Number(room.creationTime) * 1000).toISOString()
            : null,
        };
      })
    );

    const filtered = detailed.filter((room) => room.realParticipantCount > 0);
    res.json({ rooms: filtered });
  } catch (err) {
    console.error("admin/rooms error:", err.message, err);
    res.status(500).json({ error: err.message || "internal_error" });
  }
});

/**
 * ADMIN: Get the single active room name
 * GET /api/admin/room
 * headers: { x-admin-key: ADMIN_KEY }
 *
 * returns: { room }
 */
app.get("/api/admin/room", requireAdmin, async (_req, res) => {
  res.json({ room: DEFAULT_ROOM_NAME });
});

/**
 * ADMIN: Get participants in a room
 * GET /api/admin/rooms/:roomName/participants
 * headers: { x-admin-key: ADMIN_KEY }
 *
 * returns: { room, participants: [...] }
 */
app.get("/api/admin/rooms/:roomName/participants", requireAdmin, async (req, res) => {
  try {
    const { roomName } = req.params;
    let participants = [];
    try {
      participants = await roomService.listParticipants(roomName);
    } catch (err) {
      const message = err?.message || "";
      const notFound = err?.code === 404 || /not found/i.test(message);
      if (!notFound) {
        throw err;
      }
      participants = [];
    }
    const byIdentity = new Map(participants.map((p) => [p.identity, p]));

    const formatted = participants.map((p) => ({
      identity: p.identity,
      name: p.name,
      state: p.state,
      present: true,
      placeholder: false,
      tracks: p.tracks.map((t) => ({
        type: t.type,
        sid: t.sid,
        muted: t.muted,
      })),
    }));

    for (const [identity, session] of identitySessions.entries()) {
      if (session.room !== roomName) continue;
      if (byIdentity.has(identity)) continue;
      formatted.push({
        identity,
        name: session.name,
        state: "offline",
        present: false,
        placeholder: true,
        tracks: [],
      });
    }

    res.json({ room: roomName, participants: formatted });
  } catch (err) {
    console.error("admin/participants error:", err.message, err);
    res.status(500).json({ error: err.message || "internal_error" });
  }
});

/**
 * ADMIN: Remove participant from a room
 * POST /api/admin/rooms/:roomName/participants/:identity/remove
 * headers: { x-admin-key: ADMIN_KEY }
 */
app.post("/api/admin/rooms/:roomName/participants/:identity/remove", requireAdmin, async (req, res) => {
  try {
    const { roomName, identity } = req.params;
    if (!roomName || !identity) {
      return res.status(400).json({ error: "missing room or identity" });
    }

    try {
      await roomService.removeParticipant(roomName, identity);
    } catch (err) {
      console.warn("admin/removeParticipant error:", err.message || err);
    }

    try {
      await delayServiceRequest("/delay/remove", {
        method: "POST",
        body: JSON.stringify({ room: roomName, participant: identity }),
      });
    } catch (err) {
      console.warn("admin/delay remove error:", err.message || err);
    }

    identitySessions.delete(identity);
    res.json({ success: true, room: roomName, identity });
  } catch (err) {
    console.error("admin/removeParticipant error:", err.message || err);
    res.status(500).json({ error: err.message || "internal_error" });
  }
});


/**
 * ADMIN: Create a new room and get a participant token (research mode)
 * POST /api/admin/create-room
 * headers: { x-admin-key: ADMIN_KEY }
 * body: { participantName?, roomName? }
 *
 * returns: { url, wsUrl, token, room, identity, participantName }
 */
app.post("/api/admin/create-room", requireAdmin, async (req, res) => {
  try {
    const { participantName, roomName } = req.body || {};

    const room = roomName || `room_${randomId(18)}`;
    const name = participantName && typeof participantName === "string"
      ? participantName.trim().slice(0, 48)
      : `Participant_${randomId(6)}`;

    const identity = `p_${randomId(10)}`;

    const at = new AccessToken(LIVEKIT_API_KEY, LIVEKIT_API_SECRET, {
      identity,
      name,
      ttl: 60 * 60 * 24, // 24 hour token
    });

    at.addGrant({
      room,
      roomJoin: true,
      canPublish: true,
      canSubscribe: true,
      canPublishData: true,
    });

    const token = await at.toJwt();

    res.json({
      url: LIVEKIT_URL,
      wsUrl: toWsUrl(LIVEKIT_URL),
      token,
      room,
      identity,
      participantName: name,
      joinUrl: `${PUBLIC_BASE_URL}/?room=${encodeURIComponent(room)}&token=${encodeURIComponent(token)}&name=${encodeURIComponent(name)}`,
    });
  } catch (err) {
    console.error("admin/create-room error:", err.message, err);
    res.status(500).json({ error: err.message || "internal_error" });
  }
});

/**
 * ADMIN: Get token for joining an existing room (research mode)
 * POST /api/admin/get-token
 * headers: { x-admin-key: ADMIN_KEY }
 * body: { room, participantName? }
 *
 * returns: { url, wsUrl, token, room, identity, participantName }
 */
app.post("/api/admin/get-token", requireAdmin, async (req, res) => {
  try {
    const { room, participantName } = req.body || {};
    if (!room) return res.status(400).json({ error: "missing room" });

    const name = participantName && typeof participantName === "string"
      ? participantName.trim().slice(0, 48)
      : `Participant_${randomId(6)}`;

    const identity = `p_${randomId(10)}`;

    const at = new AccessToken(LIVEKIT_API_KEY, LIVEKIT_API_SECRET, {
      identity,
      name,
      ttl: 60 * 60 * 24, // 24 hour token
    });

    at.addGrant({
      room,
      roomJoin: true,
      canPublish: true,
      canSubscribe: true,
      canPublishData: true,
    });

    const token = await at.toJwt();

    res.json({
      url: LIVEKIT_URL,
      wsUrl: toWsUrl(LIVEKIT_URL),
      token,
      room,
      identity,
      participantName: name,
      joinUrl: `${PUBLIC_BASE_URL}/?room=${encodeURIComponent(room)}&token=${encodeURIComponent(token)}&name=${encodeURIComponent(name)}`,
    });
  } catch (err) {
    console.error("admin/get-token error:", err.message, err);
    res.status(500).json({ error: err.message || "internal_error" });
  }
});

/**
 * ADMIN: Get token for composite preview (admin panel)
 * POST /api/admin/preview-token
 * headers: { x-admin-key: ADMIN_KEY }
 * body: { room }
 *
 * returns: { url, wsUrl, token, room, identity, participantName }
 */
app.post("/api/admin/preview-token", requireAdmin, async (req, res) => {
  try {
    const { room } = req.body || {};
    if (!room) return res.status(400).json({ error: "missing room" });

    const name = "Admin Preview";
    const identity = `admin_preview_${randomId(10)}`;

    const at = new AccessToken(LIVEKIT_API_KEY, LIVEKIT_API_SECRET, {
      identity,
      name,
      ttl: 60 * 60,
    });

    at.addGrant({
      room,
      roomJoin: true,
      canPublish: false,
      canSubscribe: true,
      canPublishData: false,
    });

    const token = await at.toJwt();

    res.json({
      url: LIVEKIT_URL,
      wsUrl: toWsUrl(LIVEKIT_URL),
      token,
      room,
      identity,
      participantName: name,
    });
  } catch (err) {
    console.error("admin/preview-token error:", err.message, err);
    res.status(500).json({ error: err.message || "internal_error" });
  }
});



app.listen(PORT, () => {
  console.log(`token-service listening on http://127.0.0.1:${PORT}`);
});

function publicBaseUrl() {
  // If you’re serving the web app on the same domain as LIVEKIT_URL,
  // you can derive HTTPS base from it.
  // LIVEKIT_URL example: wss://meet.example.org
  const u = new URL(LIVEKIT_URL.replace(/^wss:/, "https:").replace(/^ws:/, "http:"));
  return u.origin;
}

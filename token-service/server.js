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

function sha256(s) {
  return crypto.createHash("sha256").update(s).digest("hex");
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
  const res = await fetch(url, { ...options, headers });
  if (!res.ok) {
    const t = await res.text().catch(() => "");
    throw new Error(`delay-service failed: ${res.status} ${t}`);
  }
  return res.json();
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
  const maxUses = Number(req.body?.maxUses || INVITE_MAX_USES);

  const inviteId = randomId(12);
  const inviteSecret = randomId(24);
  const room = `room_${randomId(18)}`; // unguessable room name

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
 * body: { inviteId, key, name? }
 *
 * returns: { url, token, room, identity, role }
 */
app.post("/api/connection-details", async (req, res) => {
  try {
    const { inviteId, key, name } = req.body || {};
    if (!inviteId || !key) return res.status(400).json({ error: "missing inviteId/key" });

    const inv = invites.get(inviteId);
    if (!inv) return res.status(404).json({ error: "invalid invite" });

    if (inv.exp <= nowSec()) {
      invites.delete(inviteId);
      return res.status(410).json({ error: "invite expired" });
    }

    if (inv.uses >= inv.maxUses) return res.status(410).json({ error: "invite already used" });
    if (sha256(key) !== inv.secretHash) return res.status(403).json({ error: "invalid key" });

    inv.uses += 1;

    const identity = `p_${randomId(10)}`;

    const at = new AccessToken(LIVEKIT_API_KEY, LIVEKIT_API_SECRET, {
      identity,
      name: typeof name === "string" && name.trim() ? name.trim().slice(0, 48) : undefined,
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
        const egressId = await startParticipantEgress(room, recordingId, p.identity, p.name);
        if (egressId) {
          egressIds.push(egressId);
          participantSet.add(p.identity);
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
              const egressId = await startParticipantEgress(
                room,
                state.recordingId,
                p.identity,
                p.name
              );
              if (egressId) {
                state.egressIds.push(egressId);
                state.participants.add(p.identity);
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

    const payload = await delayServiceRequest("/delay", {
      method: "POST",
      body: JSON.stringify({ room, participant, delayMs: delay }),
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
 * ADMIN: Get rooms and their participants
 * GET /api/admin/rooms
 * headers: { x-admin-key: ADMIN_KEY }
 *
 * returns: { rooms: [{ name, participants: [...] }] }
 */
app.get("/api/admin/rooms", requireAdmin, async (req, res) => {
  try {
    const rooms = await roomService.listRooms();
    const detailed = await Promise.all(
      rooms.map(async (room) => {
        let realParticipantCount = 0;
        try {
          const participants = await roomService.listParticipants(room.name);
          realParticipantCount = participants.filter((p) =>
            isRecordableParticipant(p.identity)
          ).length;
        } catch (err) {
          console.warn("admin/rooms listParticipants failed:", err.message || err);
        }
        return {
          name: room.name,
          participantCount: room.numParticipants,
          realParticipantCount,
          createdAt: new Date(Number(room.creationTime) * 1000).toISOString(),
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
 * ADMIN: Get participants in a room
 * GET /api/admin/rooms/:roomName/participants
 * headers: { x-admin-key: ADMIN_KEY }
 *
 * returns: { room, participants: [...] }
 */
app.get("/api/admin/rooms/:roomName/participants", requireAdmin, async (req, res) => {
  try {
    const { roomName } = req.params;
    const participants = await roomService.listParticipants(roomName);

    const formatted = participants.map((p) => ({
      identity: p.identity,
      name: p.name,
      state: p.state,
      tracks: p.tracks.map((t) => ({
        type: t.type,
        sid: t.sid,
        muted: t.muted,
      })),
    }));

    res.json({ room: roomName, participants: formatted });
  } catch (err) {
    console.error("admin/participants error:", err.message, err);
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

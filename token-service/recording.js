import { app } from "./express.js";
import {
  EgressClient,
  EncodedFileOutput,
  EncodedFileType,
  EncodingOptionsPreset,
} from "livekit-server-sdk";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { PUBLIC_BASE_URL, LIVEKIT_HTTP_URL, LIVEKIT_API_KEY, LIVEKIT_API_SECRET } from "./livekit-api.js";
import { roomService } from "./livekit-api.js";
import { requireAdmin, log, randomId } from "./utils.js";
import { isRecordableParticipant } from "./subscription-logic.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RECORDING_BASE_URL = process.env.RECORDING_BASE_URL || PUBLIC_BASE_URL;

// Where token-service can read/write recording files (shared volume with the egress container).
// In compose.yml we mount host ./data/recordings -> token-service:/app/recordings and egress:/out/recordings
const RECORDINGS_DIR = process.env.RECORDINGS_DIR
  ? path.resolve(process.env.RECORDINGS_DIR)
  : path.join(__dirname, "recordings");

// Where the egress container should write files *inside the egress container*.
// This must match the egress volume mount in compose.yml.
const EGRESS_FILE_BASE = process.env.EGRESS_FILE_BASE || "/out/recordings";

// Egress client for starting/stopping recordings
const egressClient = new EgressClient(
  LIVEKIT_HTTP_URL,  // must be http(s), not ws(s)
  LIVEKIT_API_KEY,
  LIVEKIT_API_SECRET
);

// In-memory store for active recordings: roomName -> recordingState
const recordingState = new Map();
const individualMonitors = new Map(); // roomName -> interval id

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

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

function egressPathFor(room, filename) {
  // Egress file paths must be POSIX-style paths inside the egress container.
  return path.posix.join(EGRESS_FILE_BASE, room, filename);
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
          log(`Recording: ${p.identity} (${p.name}) gets egress id ${egressId}`);
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

    log(
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

    log(`Recording stopped for room ${room}, mode: ${mode || "all"}`);

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

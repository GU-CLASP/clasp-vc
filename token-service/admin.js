import { app } from "./express.js";
import {
  AccessToken,
} from "livekit-server-sdk";
import { requireAdmin, randomId, toWsUrl, parseBooleanAttr, DEFAULT_SHOW_SELF } from "./utils.js";
import { LIVEKIT_API_KEY, LIVEKIT_API_SECRET, LIVEKIT_URL, DEFAULT_ROOM_NAME, roomService } from "./livekit-api.js";
import { identitySessions } from "./identity-sessions.js";
import { removeDelay } from "./delays.js";
import { isRecordableParticipant } from "./subscription-logic.js"

/**
 * ADMIN: Service health
 * GET /api/admin/health
 * headers: { x-admin-key: ADMIN_KEY }
 */
app.get("/api/admin/health", requireAdmin, async (_req, res) => {
  const health = {
    livekit: { ok: false, error: null },
  };
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

    const formatted = participants.map((p) => {
      const session = identitySessions.get(p.identity);
      const showSelf = parseBooleanAttr(p?.attributes?.showSelf, session?.showSelf ?? DEFAULT_SHOW_SELF);
      return {
        identity: p.identity,
        name: p.name,
        state: p.state,
        present: true,
        placeholder: false,
        showSelf,
        admissionStatus: session?.admissionStatus || "pending",
        tracks: p.tracks.map((t) => ({
          type: t.type,
          sid: t.sid,
          muted: t.muted,
        })),
      };
    });

    for (const [identity, session] of identitySessions.entries()) {
      if (session.room !== roomName) continue;
      if (byIdentity.has(identity)) continue;
      formatted.push({
        identity,
        name: session.name,
        state: session.admissionStatus === "admitted" ? "offline" : "waiting",
        present: false,
        placeholder: true,
        showSelf: session.showSelf ?? DEFAULT_SHOW_SELF,
        admissionStatus: session.admissionStatus || "pending",
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
      const success = removeDelay(roomName, identity);
      res.json({ success: success, room: roomName, identity });
    } catch (err) {
      console.warn("admin/effects remove error:", err.message || err);
      res.json({ success: false, room: roomName, identity });
    }
    identitySessions.delete(identity);
  } catch (err) {
    console.error("admin/removeParticipant error:", err.message || err);
    res.status(500).json({ error: err.message || "internal_error" });
  }
});

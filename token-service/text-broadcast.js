import { app } from "./express.js";
import { roomService } from "./livekit-api.js";
import { requireAdmin } from "./utils.js";
import { identitySessions } from "./identity-sessions.js";

/**
 * ADMIN: Send message to all participants
 * POST /api/admin/textBroadcast
 * headers: { x-admin-key: ADMIN_KEY }
 * body: { room: string, text: string }
 */
app.post("/api/admin/textBroadcast", requireAdmin, async (req, res) => {
  try {
    const { room, text } = req.body || {};
    if (!room) {
      return res.status(400).json({ error: "missing room" });
    }
    const message = text || "";

    let applied = false;
    try {
      const participants = await roomService.listParticipants(room);
      for (const participant of participants) {
        const info = participant;
        const attributes = { ...(info?.attributes || {}) };
        attributes.message = message;
        await roomService.updateParticipant(room, participant.identity, { attributes });

        const session = identitySessions.get(participant.identity);
        if (session) {
          session.message = message;
          identitySessions.set(participant.identity, session);
        }
      }
      applied = true;
    } catch (err) {
      const message = String(err?.message || "");
      const notFound = err?.code === 404 || /not found/i.test(message);
      if (!notFound) {
        throw err;
      }
    }

    res.json({ success: true, room: room, message, applied });
  } catch (err) {
    console.error("admin/textBroadcast error:", err.message || err);
    res.status(500).json({ error: err.message || "internal_error" });
  }
});


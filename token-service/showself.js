import { app } from "./express";
import { roomService } from "./livekit-api";
import { requireAdmin } from "./utils";
import { identitySessions } from "./identity-sessions";

async function updateParticipantShowSelf(room, identity, showSelf) {
  const info = await roomService.getParticipant(room, identity);
  const attributes = { ...(info?.attributes || {}) };
  attributes.showSelf = showSelf ? "true" : "false";
  await roomService.updateParticipant(room, identity, { attributes });
}

/**
 * ADMIN: Toggle participant self-visibility
 * POST /api/admin/rooms/:roomName/participants/:identity/self-visibility
 * headers: { x-admin-key: ADMIN_KEY }
 * body: { showSelf: boolean }
 */
app.post("/api/admin/rooms/:roomName/participants/:identity/self-visibility", requireAdmin, async (req, res) => {
  try {
    const { roomName, identity } = req.params;
    const { showSelf } = req.body || {};
    if (!roomName || !identity) {
      return res.status(400).json({ error: "missing room or identity" });
    }
    if (typeof showSelf !== "boolean") {
      return res.status(400).json({ error: "showSelf must be boolean" });
    }

    const session = identitySessions.get(identity);
    if (session) {
      session.showSelf = showSelf;
      identitySessions.set(identity, session);
    }

    let applied = false;
    try {
      await updateParticipantShowSelf(roomName, identity, showSelf);
      applied = true;
    } catch (err) {
      const message = String(err?.message || "");
      const notFound = err?.code === 404 || /not found/i.test(message);
      if (!notFound) {
        throw err;
      }
    }

    res.json({ success: true, room: roomName, identity, showSelf, applied });
  } catch (err) {
    console.error("admin/self-visibility error:", err.message || err);
    res.status(500).json({ error: err.message || "internal_error" });
  }
});


import { app } from "./express";

/**
 * ADMIN: Admit participant to the room
 * POST /api/admin/rooms/:roomName/participants/:identity/admit
 * headers: { x-admin-key: ADMIN_KEY }
 */
app.post("/api/admin/rooms/:roomName/participants/:identity/admit", requireAdmin, async (req, res) => {
  try {
    const { roomName, identity } = req.params;
    if (!roomName || !identity) {
      return res.status(400).json({ error: "missing room or identity" });
    }

    const session = identitySessions.get(identity);
    if (!session || session.room !== roomName) {
      return res.status(404).json({ error: "participant not found" });
    }

    session.admissionStatus = "admitted";
    identitySessions.set(identity, session);

    log(`Admit ${identity} into room ${roomName}`);
    await applyParticipantSessionState(roomName, identity);
    log(`Sync subscriptions in room ${roomName}`);
    await syncAdmittedSubscriptions(roomName);

    res.json({
      success: true,
      room: roomName,
      identity,
      admissionStatus: session.admissionStatus,
    });
  } catch (err) {
    console.error("admin/admitParticipant error:", err.message || err);
    res.status(500).json({ error: err.message || "internal_error" });
  }
});

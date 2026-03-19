import { app } from "./express";

process.on("unhandledRejection", (reason) => {
  console.error("unhandledRejection:", reason);
});

process.on("uncaughtException", (err) => {
  console.error("uncaughtException:", err);
});

const ADMIN_KEY = mustEnv("ADMIN_KEY");
const PORT = Number(process.env.PORT || 9000);

// Track participant identities issued per invite so we can clean up effect tracks on leave.
const identitySessions = new Map(); // identity -> { inviteId, room, name, showSelf, admissionStatus }

// Health check endpoint for container startup verification
app.get("/api/healthz", (req, res) => {
  res.json({ status: "ok" });
});

/**
 * CLIENT: leave session and remove effect placeholder
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
      await effectsServiceRequest("/effects/delay/remove", {
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

app.listen(PORT, () => {
  log(`token-service listening on http://127.0.0.1:${PORT}`);
});

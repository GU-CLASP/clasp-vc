import { app } from "./express.js";
import { nowSec, sha256, log } from "./utils.js";
import { roomService } from "./livekit-api.js";
import { identitySessions } from "./identity-sessions.js";
import { invites } from "./invites.js";
import { removeDelay } from "./delays.js";
import "./admin.js"; // Setup admin endpoints
import "./recording.js"; // Setup recording endpoints
import "./waiting-room.js"; // Setup waiting-room endpoints
import "./showself.js"; // Setup show-self endpoints
import "./text-broadcast.js"; // Setup text-broadcast endpoint

process.on("unhandledRejection", (reason) => {
  console.error("unhandledRejection:", reason);
});

process.on("uncaughtException", (err) => {
  console.error("uncaughtException:", err);
});

const PORT = Number(process.env.PORT || 9000);

// Remote logging to send log information from browser to server
app.post("/api/log", (req, res) => {
  log("Remote log: " + JSON.stringify(req.body));
  res.status(204);
});

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
      await removeDelay(inv.room, identity);
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

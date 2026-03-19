import {
  AccessToken,
} from "livekit-server-sdk";
import { getExistingDelay } from "./delays";
import { app } from "./express";

const INVITE_TTL_SECONDS = Number(process.env.INVITE_TTL_SECONDS || 86400); // 24h
const INVITE_MAX_USES = Number(process.env.INVITE_MAX_USES || 1);

// In-memory invite store for a pilot.
// For anything serious, swap to Redis/Postgres.
const invites = new Map(); // inviteId -> { secretHash, room, role, exp, uses, maxUses }

function cleanExpired() {
  const t = nowSec();
  for (const [id, inv] of invites.entries()) {
    if (inv.exp <= t) invites.delete(id);
  }
}
setInterval(cleanExpired, 60_000).unref();

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

    if (sha256(key) !== inv.secretHash) return res.status(403).json({ error: "invalid key" });

    const requested = sanitizeIdentity(requestedIdentity);
    let existingSession = null;
    if (requested) {
      existingSession = identitySessions.get(requested);
      if (!existingSession || existingSession.inviteId !== inviteId) {
        return res.status(409).json({ error: "identity_revoked" });
      }
    }

    if (requested) {
      try {
        await roomService.removeParticipant(inv.room, requested);
      } catch (err) {
        console.warn("reclaim identity removeParticipant error:", err.message || err);
      }
    }

    let identity = requested;
    const displayName = typeof name === "string" && name.trim() ? name.trim().slice(0, 48) : undefined;
    let session = existingSession;

    if (!session) {
      if (inv.maxUses > 0 && inv.uses >= inv.maxUses) {
        return res.status(410).json({ error: "invite already used" });
      }
      inv.uses += 1;
      identity = `p_${randomId(10)}`;
      session = {
        inviteId,
        room: inv.room,
        name: displayName,
        showSelf: true,
        admissionStatus: "pending",
      };
      identitySessions.set(identity, session);
    } else if (displayName && displayName !== session.name) {
      session.name = displayName;
      identitySessions.set(identity, session);
    }

    const showSelf = session.showSelf ?? true;

    const at = new AccessToken(LIVEKIT_API_KEY, LIVEKIT_API_SECRET, {
      identity,
      name: displayName ?? session.name,
      ttl: 60 * 15,
    });

    at.addGrant({
      room: inv.room,
      roomJoin: true,
      canPublish: true,
      canSubscribe: true,// session.admissionStatus === "admitted",
      canPublishData: true,
    });

    const token = await at.toJwt(); // ✅ IMPORTANT

    identitySessions.set(identity, {
      ...session,
      inviteId,
      room: inv.room,
      name: displayName ?? session.name,
      showSelf,
    });
    scheduleSync(inv.room, identity, session);

    try {
      const existingDelay = getExistingDelay(inv.room, identity);
      await effectsServiceRequest("/effects/delay", {
        method: "POST",
        body: JSON.stringify({
          room: inv.room,
          participant: identity,
          delayMs: existingDelay,
          keepAlive: true,
          participantName: displayName ?? session.name,
        }),
      });
    } catch (err) {
      console.warn("delay keepAlive error:", err.message || err);
    }

    res.json({
      admissionStatus: session.admissionStatus || "pending",
      url: LIVEKIT_URL, // http(s)
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


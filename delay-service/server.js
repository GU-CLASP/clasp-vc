import express from "express";
import {
  AccessToken,
  RoomServiceClient,
} from "livekit-server-sdk";
import {
  AudioFrame,
  AudioSource,
  AudioStream,
  LocalAudioTrack,
  LocalVideoTrack,
  Room,
  RoomEvent,
  TrackKind,
  TrackPublishOptions,
  TrackSource,
  VideoFrame,
  VideoSource,
  VideoStream,
} from "@livekit/rtc-node";

const app = express();
app.use(express.json());

const PORT = Number(process.env.PORT || 9100);
const LIVEKIT_URL = mustEnv("LIVEKIT_URL");
const LIVEKIT_URL_INTERNAL = process.env.LIVEKIT_URL_INTERNAL || LIVEKIT_URL;
const LIVEKIT_API_KEY = mustEnv("LIVEKIT_API_KEY");
const LIVEKIT_API_SECRET = mustEnv("LIVEKIT_API_SECRET");
const ADMIN_KEY = mustEnv("ADMIN_KEY");

const roomService = new RoomServiceClient(
  toHttpUrl(LIVEKIT_URL_INTERNAL),
  LIVEKIT_API_KEY,
  LIVEKIT_API_SECRET
);

// room -> Map(participantIdentity -> DelayRelay)
const roomRelays = new Map();

function mustEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env var: ${name}`);
  return v;
}

function toHttpUrl(wsUrl) {
  return wsUrl.replace(/^wss:/, "https:").replace(/^ws:/, "http:");
}

function requireAdmin(req, res, next) {
  const key = req.header("x-admin-key");
  if (!key || key !== ADMIN_KEY) return res.status(401).json({ error: "unauthorized" });
  next();
}

function relayIdentityFor(participant) {
  return `relay_${participant}`;
}

function isClientParticipant(identity) {
  return typeof identity === "string" && identity.startsWith("p_");
}

function getRelayMap(room) {
  if (!roomRelays.has(room)) {
    roomRelays.set(room, new Map());
  }
  return roomRelays.get(room);
}

app.get("/healthz", (_req, res) => {
  res.json({ status: "ok" });
});

/**
 * POST /delay
 * body: { room, participant, delayMs }
 */
app.post("/delay", requireAdmin, async (req, res) => {
  try {
    const { room, participant, delayMs } = req.body || {};
    if (!room || !participant) {
      return res.status(400).json({ error: "missing room or participant" });
    }

    const delay = Number(delayMs) || 0;
    if (delay < 0 || delay > 10000) {
      return res.status(400).json({ error: "delayMs must be between 0 and 10000" });
    }

    const relays = getRelayMap(room);
    const existing = relays.get(participant);

    if (delay === 0) {
      if (existing) {
        await existing.stop();
        relays.delete(participant);
      }
      if (relays.size === 0) roomRelays.delete(room);
      return res.json({ success: true, room, participant, delayMs: 0, active: false });
    }

    if (existing) {
      await existing.setDelay(delay);
      return res.json({ success: true, room, participant, delayMs: delay, active: true });
    }

    const relay = new DelayRelay({
      room,
      participant,
      delayMs: delay,
      livekitUrl: LIVEKIT_URL_INTERNAL,
      apiKey: LIVEKIT_API_KEY,
      apiSecret: LIVEKIT_API_SECRET,
      roomService,
    });
    await relay.start();
    relays.set(participant, relay);

    res.json({ success: true, room, participant, delayMs: delay, active: true });
  } catch (err) {
    console.error("delay start error:", err);
    res.status(500).json({ error: err.message || "internal_error" });
  }
});

/**
 * GET /delay/status?room=roomName
 */
app.get("/delay/status", requireAdmin, async (req, res) => {
  try {
    const { room } = req.query;
    if (!room) return res.status(400).json({ error: "missing room query param" });

    const relays = roomRelays.get(String(room));
    const delays = {};
    if (relays) {
      for (const [participant, relay] of relays.entries()) {
        delays[participant] = relay.delayMs;
      }
    }
    res.json({ room: String(room), delays });
  } catch (err) {
    console.error("delay/status error:", err);
    res.status(500).json({ error: err.message || "internal_error" });
  }
});

app.listen(PORT, () => {
  console.log(`delay-service listening on http://127.0.0.1:${PORT}`);
});

class DelayRelay {
  constructor({ room, participant, delayMs, livekitUrl, apiKey, apiSecret, roomService }) {
    this.roomName = room;
    this.participant = participant;
    this.delayMs = delayMs;
    this.livekitUrl = livekitUrl;
    this.apiKey = apiKey;
    this.apiSecret = apiSecret;
    this.roomService = roomService;

    this.relayIdentity = relayIdentityFor(participant);
    this.room = null;

    this.audioSource = null;
    this.audioTrack = null;
    this.videoSource = null;
    this.videoTrack = null;

    this.running = false;
    this.generation = 0;
    this.trackSids = new Set();
  }

  async start() {
    this.running = true;
    await this._connect();
    await this._syncTrackSids();
    await this._applyUnsubscribeToAll();
  }

  async stop() {
    this.running = false;
    this.generation += 1;

    try {
      await this._applyResubscribeToAll();
    } catch (err) {
      console.warn("resubscribe failed:", err.message || err);
    }

    try {
      await this.room?.disconnect();
    } catch (err) {
      console.warn("relay disconnect failed:", err.message || err);
    }

    this.room = null;
    this.audioSource = null;
    this.audioTrack = null;
    this.videoSource = null;
    this.videoTrack = null;
  }

  async setDelay(delayMs) {
    this.delayMs = delayMs;
    // invalidate queued frames so change can take effect (freeze is OK)
    this.generation += 1;
  }

  async _connect() {
    const token = await this._relayToken();
    const room = new Room({ adaptiveStream: true, dynacast: true });
    this.room = room;

    room
      .on(RoomEvent.TrackSubscribed, (track, _pub, participant) => {
        if (!this.running) return;
        if (participant.identity !== this.participant) return;
        if (track.kind === TrackKind.KIND_AUDIO) {
          this._startAudioRelay(track);
        } else if (track.kind === TrackKind.KIND_VIDEO) {
          this._startVideoRelay(track);
        }
      })
      .on(RoomEvent.TrackUnsubscribed, (_track, _pub, participant) => {
        if (participant.identity !== this.participant) return;
        // If the source track disappears, drop output until it returns.
        this.generation += 1;
      })
      .on(RoomEvent.ParticipantConnected, async (participant) => {
        if (!this.running) return;
        if (participant.identity === this.participant) return;
        if (participant.identity.startsWith("relay_")) return;
        if (!isClientParticipant(participant.identity)) return;
        if (this.trackSids.size === 0) return;
        try {
          await this.roomService.updateSubscriptions(
            this.roomName,
            participant.identity,
            Array.from(this.trackSids),
            false
          );
        } catch (err) {
          console.warn("updateSubscriptions (join) failed:", err.message || err);
        }
      })
      .on(RoomEvent.TrackPublished, async (_pub, participant) => {
        if (participant.identity !== this.participant) return;
        await this._syncTrackSids();
        await this._applyUnsubscribeToAll();
      })
      .on(RoomEvent.TrackUnpublished, async (_pub, participant) => {
        if (participant.identity !== this.participant) return;
        await this._syncTrackSids();
        await this._applyUnsubscribeToAll();
      });

    await room.connect(this.livekitUrl, token, { autoSubscribe: true });
  }

  async _relayToken() {
    const at = new AccessToken(this.apiKey, this.apiSecret, {
      identity: this.relayIdentity,
      name: `Relay ${this.participant}`,
      ttl: 60 * 60 * 24,
    });
    at.addGrant({
      room: this.roomName,
      roomJoin: true,
      canPublish: true,
      canSubscribe: true,
      canPublishData: false,
    });
    return at.toJwt();
  }

  async _syncTrackSids() {
    const participants = await this.roomService.listParticipants(this.roomName);
    const target = participants.find((p) => p.identity === this.participant);
    const sids = new Set();
    if (target?.tracks) {
      for (const t of target.tracks) {
        if (t.sid) sids.add(t.sid);
      }
    }
    this.trackSids = sids;
  }

  async _applyUnsubscribeToAll() {
    if (this.trackSids.size === 0) return;
    const participants = await this.roomService.listParticipants(this.roomName);
    const trackSids = Array.from(this.trackSids);

    for (const p of participants) {
      if (p.identity === this.participant) continue;
      if (p.identity.startsWith("relay_")) continue;
      if (!isClientParticipant(p.identity)) continue;
      try {
        await this.roomService.updateSubscriptions(
          this.roomName,
          p.identity,
          trackSids,
          false
        );
      } catch (err) {
        console.warn(`updateSubscriptions failed for ${p.identity}:`, err.message || err);
      }
    }
  }

  async _applyResubscribeToAll() {
    if (this.trackSids.size === 0) return;
    const participants = await this.roomService.listParticipants(this.roomName);
    const trackSids = Array.from(this.trackSids);

    for (const p of participants) {
      if (p.identity === this.participant) continue;
      if (p.identity.startsWith("relay_")) continue;
      if (!isClientParticipant(p.identity)) continue;
      try {
        await this.roomService.updateSubscriptions(
          this.roomName,
          p.identity,
          trackSids,
          true
        );
      } catch (err) {
        console.warn(`resubscribe failed for ${p.identity}:`, err.message || err);
      }
    }
  }

  async _startAudioRelay(track) {
    if (!this.running) return;
    const audioStream = new AudioStream(track);

    for await (const frame of audioStream) {
      if (!this.running) break;
      const generation = this.generation;

      if (!this.audioSource) {
        this.audioSource = new AudioSource(frame.sampleRate, frame.channels);
        this.audioTrack = LocalAudioTrack.createAudioTrack("relay_audio", this.audioSource);
        const options = new TrackPublishOptions();
        options.source = TrackSource.SOURCE_MICROPHONE;
        await this.room.localParticipant.publishTrack(this.audioTrack, options);
      }

      const dataCopy = new Int16Array(frame.data);
      const delayedFrame = new AudioFrame(
        dataCopy,
        frame.sampleRate,
        frame.channels,
        frame.samplesPerChannel
      );

      setTimeout(() => {
        if (!this.running) return;
        if (generation !== this.generation) return;
        try {
          this.audioSource.captureFrame(delayedFrame);
        } catch (err) {
          console.warn("audio capture failed:", err.message || err);
        }
      }, this.delayMs);
    }
  }

  async _startVideoRelay(track) {
    if (!this.running) return;
    const videoStream = new VideoStream(track);

    for await (const ev of videoStream) {
      if (!this.running) break;
      const generation = this.generation;
      const frame = ev.frame;

      if (!this.videoSource) {
        this.videoSource = new VideoSource(frame.width, frame.height);
        this.videoTrack = LocalVideoTrack.createVideoTrack("relay_video", this.videoSource);
        const options = new TrackPublishOptions();
        options.source = TrackSource.SOURCE_CAMERA;
        await this.room.localParticipant.publishTrack(this.videoTrack, options);
      }

      const dataCopy = new Uint8Array(frame.data);
      const delayedFrame = new VideoFrame(
        dataCopy,
        frame.width,
        frame.height,
        frame.type
      );

      setTimeout(() => {
        if (!this.running) return;
        if (generation !== this.generation) return;
        try {
          this.videoSource.captureFrame(delayedFrame);
        } catch (err) {
          console.warn("video capture failed:", err.message || err);
        }
      }, this.delayMs);
    }
  }
}

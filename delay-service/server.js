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

process.on("unhandledRejection", (reason) => {
  console.error("unhandledRejection:", reason);
});

process.on("uncaughtException", (err) => {
  console.error("uncaughtException:", err);
});

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

function isSubscriberParticipant(identity, sourceIdentity) {
  if (!identity) return false;
  if (identity === sourceIdentity) return false;
  if (identity.startsWith("relay_")) return false;
  if (identity.startsWith("EG_")) return false;
  return true;
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
 * body: { room, participant, delayMs, keepAlive?, participantName? }
 */
app.post("/delay", requireAdmin, async (req, res) => {
  const started = Date.now();
  console.log("[delay-service] POST /delay", req.body || {});
  try {
    const { room, participant, delayMs, keepAlive, participantName } = req.body || {};
    if (!room || !participant) {
      console.warn("[delay-service] POST /delay -> 400 missing params");
      return res.status(400).json({ error: "missing room or participant" });
    }

    const delay = Number(delayMs) || 0;
    if (delay < 0 || delay > 10000) {
      return res.status(400).json({ error: "delayMs must be between 0 and 10000" });
    }

    const relays = getRelayMap(room);
    const existing = relays.get(participant);

    if (delay === 0) {
      if (keepAlive) {
        if (existing) {
          if (participantName) existing.setParticipantName(participantName);
          await existing.setDelay(0);
        } else {
          const relay = new DelayRelay({
            room,
            participant,
            participantName,
            delayMs: 0,
            livekitUrl: LIVEKIT_URL_INTERNAL,
            apiKey: LIVEKIT_API_KEY,
            apiSecret: LIVEKIT_API_SECRET,
            roomService,
          });
          await relay.start();
          relays.set(participant, relay);
        }
        const ms = Date.now() - started;
        console.log(`[delay-service] POST /delay -> 200 (${ms}ms) active=true`);
        return res.json({ success: true, room, participant, delayMs: 0, active: true });
      }

      if (existing) {
        await existing.stop();
        relays.delete(participant);
      }
      if (relays.size === 0) roomRelays.delete(room);
      const ms = Date.now() - started;
      console.log(`[delay-service] POST /delay -> 200 (${ms}ms) active=false`);
      return res.json({ success: true, room, participant, delayMs: 0, active: false });
    }

    if (existing) {
      if (participantName) existing.setParticipantName(participantName);
      await existing.setDelay(delay);
      const ms = Date.now() - started;
      console.log(`[delay-service] POST /delay -> 200 (${ms}ms) active=true`);
      return res.json({ success: true, room, participant, delayMs: delay, active: true });
    }

    const relay = new DelayRelay({
      room,
      participant,
      participantName,
      delayMs: delay,
      livekitUrl: LIVEKIT_URL_INTERNAL,
      apiKey: LIVEKIT_API_KEY,
      apiSecret: LIVEKIT_API_SECRET,
      roomService,
    });
    await relay.start();
    relays.set(participant, relay);

    const ms = Date.now() - started;
    console.log(`[delay-service] POST /delay -> 200 (${ms}ms) active=true`);
    res.json({ success: true, room, participant, delayMs: delay, active: true });
  } catch (err) {
    console.error("delay start error:", err);
    console.error(`[delay-service] POST /delay -> 500 (${Date.now() - started}ms)`);
    res.status(500).json({ error: err.message || "internal_error" });
  }
});

/**
 * POST /delay/remove
 * body: { room, participant }
 */
app.post("/delay/remove", requireAdmin, async (req, res) => {
  try {
    const { room, participant } = req.body || {};
    if (!room || !participant) {
      return res.status(400).json({ error: "missing room or participant" });
    }

    const relays = roomRelays.get(room);
    const existing = relays?.get(participant);
    if (existing) {
      await existing.stop();
      relays.delete(participant);
    }
    if (relays && relays.size === 0) roomRelays.delete(room);

    res.json({ success: true, room, participant });
  } catch (err) {
    console.error("delay remove error:", err);
    res.status(500).json({ error: err.message || "internal_error" });
  }
});

/**
 * GET /delay/status?room=roomName
 */
app.get("/delay/status", requireAdmin, async (req, res) => {
  const started = Date.now();
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
    console.log(`[delay-service] GET /delay/status -> 200 (${Date.now() - started}ms)`);
    res.json({ room: String(room), delays });
  } catch (err) {
    console.error("delay/status error:", err);
    console.error(`[delay-service] GET /delay/status -> 500 (${Date.now() - started}ms)`);
    res.status(500).json({ error: err.message || "internal_error" });
  }
});

app.listen(PORT, () => {
  console.log(`delay-service listening on http://127.0.0.1:${PORT}`);
});

class DelayRelay {
  constructor({ room, participant, participantName, delayMs, livekitUrl, apiKey, apiSecret, roomService }) {
    this.roomName = room;
    this.participant = participant;
    this.participantName = participantName || null;
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

    this.lastAudioInfo = null;
    this.lastVideoInfo = null;
    this.lastVideoDataLength = null;
    this.audioCaptureFailed = false;
    this.videoCaptureFailed = false;

    this.sourceActive = false;
    this.relayIdleAudioTimer = null;
    this.relayIdleVideoTimer = null;
    this.relayIdleStarting = false;
  }

  async start() {
    this.running = true;
    await this._connect();
    try {
      await this._syncTrackSids();
      await this._applySubscriptionState();
    } catch (err) {
      console.warn("relay sync failed:", err.message || err);
    }
    this._startRelayIdle();
  }

  async stop() {
    this.running = false;
    this.generation += 1;

    try {
      await this._applyResubscribeToAll();
    } catch (err) {
      console.warn("resubscribe failed:", err.message || err);
    }

    this._stopRelayIdle();

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
    const prev = this.delayMs;
    this.delayMs = delayMs;
    // invalidate queued frames so change can take effect (freeze is OK)
    this.generation += 1;
    if (prev !== delayMs) {
      try {
        await this._applySubscriptionState();
      } catch (err) {
        console.warn("apply subscription state failed:", err.message || err);
      }
    }
  }

  setParticipantName(name) {
    if (typeof name === "string" && name.trim()) {
      this.participantName = name.trim().slice(0, 48);
    }
  }

  async _connect() {
    const token = await this._relayToken();
    const room = new Room({ adaptiveStream: true, dynacast: true });
    this.room = room;

    room
      .on(RoomEvent.TrackSubscribed, (track, _pub, participant) => {
        if (!this.running) return;
        if (participant.identity !== this.participant) return;
        this.sourceActive = true;
        this._stopRelayIdle();
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
        this.sourceActive = false;
        this._startRelayIdle();
      })
      .on(RoomEvent.ParticipantDisconnected, (participant) => {
        if (!this.running) return;
        if (participant.identity !== this.participant) return;
        // Source participant left; keep relay tracks alive (black screen), reset state.
        this.generation += 1;
        this.trackSids = new Set();
        this.sourceActive = false;
        this._startRelayIdle();
      })
      .on(RoomEvent.Disconnected, () => {
        if (!this.running) return;
        this._stopRelayIdle();
      })
      .on(RoomEvent.ParticipantConnected, async (participant) => {
        if (!this.running) return;
        if (participant.identity === this.participant) return;
        if (participant.identity.startsWith("relay_")) return;
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
        this.sourceActive = true;
        this._stopRelayIdle();
        await this._syncTrackSids();
        await this._applySubscriptionState();
      })
      .on(RoomEvent.TrackUnpublished, async (_pub, participant) => {
        if (participant.identity !== this.participant) return;
        await this._syncTrackSids();
        await this._applySubscriptionState();
      });

    await room.connect(this.livekitUrl, token, { autoSubscribe: true });
  }

  async _relayToken() {
    const at = new AccessToken(this.apiKey, this.apiSecret, {
      identity: this.relayIdentity,
      name: this.participantName || this.participant,
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
    try {
      const participants = await this.roomService.listParticipants(this.roomName);
      const target = participants.find((p) => p.identity === this.participant);
      const sids = new Set();
      if (target?.tracks) {
        for (const t of target.tracks) {
          if (t.sid) sids.add(t.sid);
        }
      }
      this.trackSids = sids;
    } catch (err) {
      console.warn("syncTrackSids failed:", err.message || err);
      this.trackSids = new Set();
    }
  }

  async _applyUnsubscribeToAll() {
    if (this.trackSids.size === 0) return;
    try {
      const participants = await this.roomService.listParticipants(this.roomName);
      const trackSids = Array.from(this.trackSids);

      for (const p of participants) {
        if (!isSubscriberParticipant(p.identity, this.participant)) continue;
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
    } catch (err) {
      console.warn("applyUnsubscribe failed:", err.message || err);
    }
  }

  async _applyResubscribeToAll() {
    if (this.trackSids.size === 0) return;
    try {
      const participants = await this.roomService.listParticipants(this.roomName);
      const trackSids = Array.from(this.trackSids);

      for (const p of participants) {
        if (!isSubscriberParticipant(p.identity, this.participant)) continue;
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
    } catch (err) {
      console.warn("applyResubscribe failed:", err.message || err);
    }
  }

  async _applySubscriptionState() {
    if (this.delayMs > 0) {
      await this._applyUnsubscribeToAll();
    } else {
      await this._applyResubscribeToAll();
    }
  }

  _handleCaptureError(kind, err) {
    const message = err?.message || err;
    if (kind === "audio") {
      if (this.audioCaptureFailed) return;
      this.audioCaptureFailed = true;
      console.warn("audio capture failed:", message);
      return;
    }
    if (kind === "video") {
      if (this.videoCaptureFailed) return;
      this.videoCaptureFailed = true;
      console.warn("video capture failed:", message);
    }
  }

  _safeCaptureAudio(frame) {
    if (this.audioCaptureFailed) return;
    const source = this.audioSource;
    if (!source) return;
    source.captureFrame(frame).catch((err) => this._handleCaptureError("audio", err));
  }

  _safeCaptureVideo(frame) {
    if (this.videoCaptureFailed) return;
    const source = this.videoSource;
    if (!source) return;
    source.captureFrame(frame).catch((err) => this._handleCaptureError("video", err));
  }

  async _startAudioRelay(track) {
    if (!this.running) return;
    this.audioCaptureFailed = false;
    const audioStream = new AudioStream(track);

    for await (const frame of audioStream) {
      if (!this.running) break;
      const generation = this.generation;
      this.lastAudioInfo = {
        sampleRate: frame.sampleRate,
        channels: frame.channels,
        samplesPerChannel: frame.samplesPerChannel,
      };

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
        this._safeCaptureAudio(delayedFrame);
      }, this.delayMs);
    }
  }

  async _startVideoRelay(track) {
    if (!this.running) return;
    this.videoCaptureFailed = false;
    const videoStream = new VideoStream(track);

    for await (const ev of videoStream) {
      if (!this.running) break;
      const generation = this.generation;
      const frame = ev.frame;
      this.lastVideoInfo = {
        width: frame.width,
        height: frame.height,
        type: frame.type,
      };
      this.lastVideoDataLength = frame.data?.length ?? null;

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
        this._safeCaptureVideo(delayedFrame);
      }, this.delayMs);
    }
  }

  async _ensureRelayTracks() {
    if (!this.room) return;
    const local = this.room.localParticipant;

    if (!this.audioSource && this.lastAudioInfo) {
      const audioInfo = this.lastAudioInfo;
      const source = new AudioSource(audioInfo.sampleRate, audioInfo.channels);
      const track = LocalAudioTrack.createAudioTrack("relay_audio", source);
      const options = new TrackPublishOptions();
      options.source = TrackSource.SOURCE_MICROPHONE;
      await local.publishTrack(track, options);
      this.audioSource = source;
      this.audioTrack = track;
    }

    if (!this.videoSource && this.lastVideoInfo) {
      const videoInfo = this.lastVideoInfo;
      const source = new VideoSource(videoInfo.width, videoInfo.height);
      const track = LocalVideoTrack.createVideoTrack("relay_video", source);
      const options = new TrackPublishOptions();
      options.source = TrackSource.SOURCE_CAMERA;
      await local.publishTrack(track, options);
      this.videoSource = source;
      this.videoTrack = track;
    }
  }

  async _startRelayIdle() {
    if (!this.running) return;
    if (this.relayIdleAudioTimer || this.relayIdleVideoTimer) return;
    if (this.relayIdleStarting) return;
    this.relayIdleStarting = true;

    try {
      await this._ensureRelayTracks();
    } catch (err) {
      console.warn("ensure relay tracks failed:", err.message || err);
      this.relayIdleStarting = false;
      return;
    }
    this.relayIdleStarting = false;
    if (!this.running) return;

    if (this.lastAudioInfo && this.audioSource) {
      const audioInfo = this.lastAudioInfo;
      const audioSamples = audioInfo.samplesPerChannel * audioInfo.channels;
      this.relayIdleAudioTimer = setInterval(() => {
        if (!this.running || !this.audioSource) return;
        const silent = new Int16Array(audioSamples);
        const frame = new AudioFrame(
          silent,
          audioInfo.sampleRate,
          audioInfo.channels,
          audioInfo.samplesPerChannel
        );
        this._safeCaptureAudio(frame);
      }, 20);
      this.relayIdleAudioTimer.unref?.();
    }

    if (this.lastVideoInfo && this.lastVideoDataLength && this.videoSource) {
      this.relayIdleVideoTimer = setInterval(() => {
        if (!this.running || !this.videoSource) return;
        const info = this.lastVideoInfo;
        const data = new Uint8Array(this.lastVideoDataLength);
        const frame = new VideoFrame(data, info.width, info.height, info.type);
        this._safeCaptureVideo(frame);
      }, 200);
      this.relayIdleVideoTimer.unref?.();
    }
  }

  _stopRelayIdle() {
    if (this.relayIdleAudioTimer) {
      clearInterval(this.relayIdleAudioTimer);
      this.relayIdleAudioTimer = null;
    }
    if (this.relayIdleVideoTimer) {
      clearInterval(this.relayIdleVideoTimer);
      this.relayIdleVideoTimer = null;
    }
  }

}

import { app } from "./express.js";
import { AccessToken } from "livekit-server-sdk";
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
import { log, requireAdmin } from "./utils.js";
import { useDelays } from "../shared/shared.js";
import { LIVEKIT_API_KEY, LIVEKIT_API_SECRET, LIVEKIT_URL_INTERNAL, roomService } from "./livekit-api.js";
import { identitySessions } from "./identity-sessions.js";
import { fixRoomSubscriptions } from "./subscription-logic.js";

export function getExistingDelay(room, participant) {
  if (!useDelays) return 0;
  if (!room || !participant) return 0;
  try {
    const payload = getCurrentDelays(room);
    const value = Number(payload?.delays?.[participant] ?? 0);
    return Number.isFinite(value) ? value : 0;
  } catch (err) {
    console.warn("getExistingDelay failed:", err?.message || err);
    return -1;
  }
}


// room -> Map(participantIdentity -> DelayEffectSession)
const roomEffects = new Map();

/**
 * Custom version of setTimeout which invokes the function directly if the delay is 0.
 * 
 * @param {function} func Function to invoke
 * @param {number} delay Delay to invoke the function at
 */
function myTimeout(func, delay) {
  if (delay == 0) {
    func();
  } else {
    setTimeout(func, delay);
  }
}

function effectIdentityFor(participant) {
  return `fx_${participant}`;
}

function getEffectMap(room) {
  if (!roomEffects.has(room)) {
    roomEffects.set(room, new Map());
  }
  return roomEffects.get(room);
}

export async function setParticipantDelay(request) {
  if (!useDelays) return { success: true };
  try {
    const { room, participant, delayMs, keepAlive, participantName } = request || {};
    if (!room || !participant) {
      console.warn("[effects-service] POST /effects/delay -> 400 missing params");
      throw "missing room or participant";
    }

    const delay = Number(delayMs) || 0;
    if (delay < 0 || delay > 10000) {
      return "delayMs must be between 0 and 10000";
    }

    const effectSessions = getEffectMap(room);
    const existing = effectSessions.get(participant);

    if (delay === 0) {
      if (keepAlive) {
        if (existing) {
          if (participantName) existing.setParticipantName(participantName);
          await existing.setDelay(0);
        } else {
          const effectSession = new DelayEffectSession({
            room,
            participant,
            participantName,
            delayMs: 0,
            livekitUrl: LIVEKIT_URL_INTERNAL,
            apiKey: LIVEKIT_API_KEY,
            apiSecret: LIVEKIT_API_SECRET,
            roomService,
          });
          await effectSession.start();
          effectSessions.set(participant, effectSession);
        }
        return { success: true, room, participant, delayMs: 0, active: true };
      }

      if (existing) {
        await existing.stop();
        effectSessions.delete(participant);
      }
      if (effectSessions.size === 0) roomEffects.delete(room);
      return { success: true, room, participant, delayMs: 0, active: false };
    }

    if (existing) {
      if (participantName) existing.setParticipantName(participantName);
      await existing.setDelay(delay);
      return { success: true, room, participant, delayMs: delay, active: true };
    }

    const effectSession = new DelayEffectSession({
      room,
      participant,
      participantName,
      delayMs: delay,
      livekitUrl: LIVEKIT_URL_INTERNAL,
      apiKey: LIVEKIT_API_KEY,
      apiSecret: LIVEKIT_API_SECRET,
      roomService,
    });
    await effectSession.start();
    effectSessions.set(participant, effectSession);

    return { success: true, room, participant, delayMs: delay, active: true };
  } catch (err) {
    console.error("effects/delay start error:", err);
    throw "internal_error";
  }
}

export async function removeDelay(roomName, participantIdentity) {
  if (!useDelays) return true;
  try {
    const effectSessions = roomEffects.get(roomName);
    const existing = effectSessions?.get(participantIdentity);
    if (existing) {
      await existing.stop();
      effectSessions.delete(participantIdentity);
    }
    if (effectSessions && effectSessions.size === 0) roomEffects.delete(roomName);

    log(`[effects-service] POST /effects/delay/remove -> 200 for participant ${participantIdentity}`);
    return true;
  } catch (err) {
    console.error("removeDelay error:", err);
    return false;
  }
}

export function getCurrentDelays(roomName) {
  const effectSessions = roomEffects.get(String(roomName));
  const delays = {};
  if (effectSessions) {
    for (const [participant, effectSession] of effectSessions.entries()) {
      delays[participant] = effectSession.delayMs;
    }
  }
  return delays;
}

class DelayEffectSession {
  constructor({ room, participant, participantName, delayMs, livekitUrl, apiKey, apiSecret, roomService }) {
    this.roomName = room;
    this.participant = participant;
    this.participantName = participantName || null;
    this.delayMs = delayMs;
    this.livekitUrl = livekitUrl;
    this.apiKey = apiKey;
    this.apiSecret = apiSecret;
    this.roomService = roomService;

    this.effectIdentity = effectIdentityFor(participant);
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
    this.effectIdleAudioTimer = null;
    this.effectIdleVideoTimer = null;
    this.effectIdleStarting = false;
  }

  async start() {
    if (!useDelays) return;
    this.running = true;
    log(`Starting ${this.toString()}`);
    await this._connect();
    try {
      await this._syncTrackSids();
      await this._applySubscriptionState();
    } catch (err) {
      console.warn("effect session sync failed:", err.message || err);
    }
    this._startEffectIdle();
  }

  async stop() {
    if (!useDelays) return;
    this.running = false;
    log(`Stopping ${this.toString()}`);
    this.generation += 1;

    try {
      await this._applyResubscribeToAll();
    } catch (err) {
      console.warn("resubscribe failed:", err.message || err);
    }

    this._stopEffectIdle();

    try {
      await this.room?.disconnect();
    } catch (err) {
      console.warn("effect session disconnect failed:", err.message || err);
    }

    this.room = null;
    this.audioSource = null;
    this.audioTrack = null;
    this.videoSource = null;
    this.videoTrack = null;
  }

  async setDelay(delayMs) {
    if (!useDelays) return;
    log(`Change delay of ${this.toString()} to ${delayMs}`);
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
    if (!useDelays) return;
    log(`Connecting ${this.toString()}`);
    const token = await this._effectToken();
    const room = new Room({ adaptiveStream: true, dynacast: true });
    this.room = room;

    room
      .on(RoomEvent.TrackSubscriptionFailed, (a, b, c) => {
        log("trackSubscriptionFailed", a, b.name, b.sid, c);
      })
      .on(RoomEvent.TrackSubscribed, (track, pub, participant) => {
        log(`TrackSubscribed ${this}: ${participant.identity} (${participant.name}) subscribed to track ${track.sid} pub ${pub.sid}`);
        if (!this.running) return;
        if (participant.identity !== this.participant) return;
        this.sourceActive = true;
        this._stopEffectIdle();
        if (track.kind === TrackKind.KIND_AUDIO) {
          this._startAudioEffect(track);
        } else if (track.kind === TrackKind.KIND_VIDEO) {
          this._startVideoEffect(track);
        }
      })
      .on(RoomEvent.TrackUnsubscribed, (track, pub, participant) => {
        log(`TrackUnsubscribed ${this}: ${participant.identity} (${participant.name}) unsubscribed from track ${track.sid} pub ${pub.sid}`);
        if (participant.identity !== this.participant) return;
        // If the source track disappears, drop output until it returns.
        this.generation += 1;
        this.sourceActive = false;
        this._startEffectIdle();
      })
      .on(RoomEvent.ParticipantDisconnected, (participant) => {
        if (!this.running) return;
        log(`ParticipantDisconnected ${this.toString()} a ${participant.identity}`);
        if (participant.identity !== this.participant) return;
        log(`ParticipantDisconnected ${this.toString()} b`);
        // Source participant left; keep effect tracks alive (black screen), reset state.
        this.generation += 1;
        this.trackSids = new Set();
        this.sourceActive = false;
        this._startEffectIdle();
      })
      .on(RoomEvent.Disconnected, () => {
        if (!this.running) return;
        log(`Disconnected ${this.toString()}`);
        this._stopEffectIdle();
      })
      .on(RoomEvent.ParticipantConnected, async (participant) => {
        if (!this.running) return;
        log(`ParticipantConnected: ${this} ${participant.identity} (${participant.name})`);
      })
      .on(RoomEvent.ParticipantAttributesChanged, async (_changed, participant) => {
        if (!this.running) return;
        log(`ParticipantAttributesChanged: ${this} ${participant.identity} (${participant.name})`);
      })
      .on(RoomEvent.TrackPublished, async (_pub, participant) => {
        if (participant.identity !== this.participant) return;
        log(`TrackPublished ${this.toString()}: ${participant.identity}`);
        this.sourceActive = true;
        this._stopEffectIdle();
        await this._syncTrackSids();
        await this._applySubscriptionState();
      })
      .on(RoomEvent.TrackUnpublished, async (_pub, participant) => {
        if (participant.identity !== this.participant) return;
        log(`TrackUnpublished ${this.toString()}: ${participant.identity}`);
        await this._syncTrackSids();
        await this._applySubscriptionState();
      });

    await room.connect(this.livekitUrl, token, { autoSubscribe: true });
  }

  async _effectToken() {
    const at = new AccessToken(this.apiKey, this.apiSecret, {
      identity: this.effectIdentity,
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
    if (!useDelays) return;
    try {
      const participants = await this.roomService.listParticipants(this.roomName);
      const target = participants.find((p) => p.identity === this.participant);
      const sids = new Set();
      if (target?.tracks) {
        for (const t of target.tracks) {
          if (t.sid) sids.add(t.sid);
        }
      }
      log(`${this.toString()}: syncTrackSids ${Array.from(sids)}`);
      this.trackSids = sids;
    } catch (err) {
      console.warn("syncTrackSids failed:", err.message || err);
      this.trackSids = new Set();
    }
  }

  async _applyUnsubscribeToAll() {
    if (!useDelays) return;
    log(`${this.toString()}: _applyUnsubscribeToAll`);
    if (this.trackSids.size === 0) return;
    fixRoomSubscriptions(this.roomName);
  }

  async _applyResubscribeToAll() {
    if (!useDelays) return;
    log(`${this.toString()}: _applyResubscribeToAll`);
    fixRoomSubscriptions(this.roomName);
  }

  async _applySubscriptionState() {
    if (!useDelays) return;
    // Always use fx_* tracks to avoid flickering when switching delay on and off
    await this._applyUnsubscribeToAll();
  }

  _handleCaptureError(kind, err) {
    const message = err?.message || err;
    if (kind === "audio") {
      if (this.audioCaptureFailed) return;
      this.audioCaptureFailed = true;
      console.warn("audio capture failed:", message);
      return;
    }
    else if (kind === "video") {
      if (this.videoCaptureFailed) return;
      this.videoCaptureFailed = true;
      console.warn("video capture failed:", message);
    }
    else {
      console.warn("unknown capture failed of type", kind, message);
    }
  }

  _safeCaptureAudio(frame) {
    if (!useDelays) return;
    if (this.audioCaptureFailed) return;
    const source = this.audioSource;
    if (!source) return;
    source.captureFrame(frame).catch((err) => this._handleCaptureError("audio", err));
  }

  _safeCaptureVideo(frame) {
    if (!useDelays) return;
    if (this.videoCaptureFailed) return;
    const source = this.videoSource;
    if (!source) return;
    // VideoSource.captureFrame returns void, unlike AudioSource.captureFrame which returns a promise.
    source.captureFrame(frame);
  }

  async _startAudioEffect(track) {
    if (!useDelays) return;
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
        this.audioTrack = LocalAudioTrack.createAudioTrack("fx_audio", this.audioSource);
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

      myTimeout(() => {
        if (!this.running) return;
        if (generation !== this.generation) return;
        this._safeCaptureAudio(delayedFrame);
      }, this.delayMs);
    }
  }

  async _startVideoEffect(track) {
    if (!useDelays) return;
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
        this.videoTrack = LocalVideoTrack.createVideoTrack("fx_video", this.videoSource);
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

      myTimeout(() => {
        if (!this.running) return;
        if (generation !== this.generation) return;
        this._safeCaptureVideo(delayedFrame);
      }, this.delayMs);
    }
  }

  async _ensureEffectTracks() {
    if (!useDelays) return;
    if (!this.room) return;
    const local = this.room.localParticipant;
    log(`${this.toString()}: _ensureEffectTracks`);

    if (!this.audioSource && this.lastAudioInfo) {
      const audioInfo = this.lastAudioInfo;
      const source = new AudioSource(audioInfo.sampleRate, audioInfo.channels);
      const track = LocalAudioTrack.createAudioTrack("fx_audio", source);
      const options = new TrackPublishOptions();
      options.source = TrackSource.SOURCE_MICROPHONE;
      await local.publishTrack(track, options);
      this.audioSource = source;
      this.audioTrack = track;
    }

    if (!this.videoSource && this.lastVideoInfo) {
      const videoInfo = this.lastVideoInfo;
      const source = new VideoSource(videoInfo.width, videoInfo.height);
      const track = LocalVideoTrack.createVideoTrack("fx_video", source);
      const options = new TrackPublishOptions();
      options.source = TrackSource.SOURCE_CAMERA;
      await local.publishTrack(track, options);
      this.videoSource = source;
      this.videoTrack = track;
    }
  }

  async _startEffectIdle() {
    if (!useDelays) return;
    if (!this.running) return;
    if (this.effectIdleAudioTimer || this.effectIdleVideoTimer) return;
    if (this.effectIdleStarting) return;
    log(`${this.toString()}: _startEffectIdle`);
    this.effectIdleStarting = true;

    try {
      await this._ensureEffectTracks();
    } catch (err) {
      console.warn("ensure effect tracks failed:", err.message || err);
      this.effectIdleStarting = false;
      return;
    }
    this.effectIdleStarting = false;
    if (!this.running) return;

    if (this.lastAudioInfo && this.audioSource) {
      const audioInfo = this.lastAudioInfo;
      const audioSamples = audioInfo.samplesPerChannel * audioInfo.channels;
      this.effectIdleAudioTimer = setInterval(() => {
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
      this.effectIdleAudioTimer.unref?.();
    }

    if (this.lastVideoInfo && this.lastVideoDataLength && this.videoSource) {
      this.effectIdleVideoTimer = setInterval(() => {
        if (!this.running || !this.videoSource) return;
        const info = this.lastVideoInfo;
        const data = new Uint8Array(this.lastVideoDataLength);
        const frame = new VideoFrame(data, info.width, info.height, info.type);
        this._safeCaptureVideo(frame);
      }, 200);
      this.effectIdleVideoTimer.unref?.();
    }
  }

  _stopEffectIdle() {
    if (!useDelays) return;
    if (this.effectIdleAudioTimer) {
      clearInterval(this.effectIdleAudioTimer);
      this.effectIdleAudioTimer = null;
    }
    if (this.effectIdleVideoTimer) {
      clearInterval(this.effectIdleVideoTimer);
      this.effectIdleVideoTimer = null;
    }
  }

  toString() {
    return `DelayEffectSession(${this.participant},${this.participantName},delay=${this.delayMs})`
  }

}

/**
 * ADMIN: Set delay effect for a participant
 * POST /api/admin/effects/delay
 * headers: { x-admin-key: ADMIN_KEY }
 * body: { room, participant, delayMs }
 *
 * returns: { success: true, room, participant, delayMs }
 */
app.post("/api/admin/effects/delay", requireAdmin, async (req, res) => {
  try {
    const { room, participant, delayMs } = req.body || {};
    if (!room || !participant) {
      return res.status(400).json({ error: "missing room or participant" });
    }

    const delay = Number(delayMs) || 0;
    if (delay < 0 || delay > 10000) {
      return res.status(400).json({ error: "delayMs must be between 0 and 10000" });
    }

    const session = identitySessions.get(participant);

    const payload = setParticipantDelay({
      room,
      participant,
      delayMs: delay,
      keepAlive: true,
      participantName: session?.name,
    });

    log(`Delay effect set for ${participant} in room ${room}: ${delay}ms`);
    res.json(payload);
  } catch (err) {
    console.error("effects/delay error:", err);
    res.status(500).json({ error: err.message || "internal_error" });
  }
});

/**
 * ADMIN: Get delay effect status for a room
 * GET /api/admin/effects/delay/status?room=roomName
 * headers: { x-admin-key: ADMIN_KEY }
 *
 * returns: { room, delays: { participantName: delayMs, ... } }
 */
app.get("/api/admin/effects/delay/status", requireAdmin, async (req, res) => {
  try {
    const { room } = req.query;
    if (!room) return res.status(400).json({ error: "missing room query param" });
    const payload = getCurrentDelays(room);
    res.json({
      room: room,
      delays: payload
    });
  } catch (err) {
    console.error("effects/delay/status error:", err);
    res.status(500).json({ error: err.message || "internal_error" });
  }
});

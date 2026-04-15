import { FaceLandmarker } from '@mediapipe/tasks-vision';
import { useEffect, useMemo, useRef, useState, useCallback } from "react";
import {
  Room,
  RoomEvent,
  Track,
  createLocalTracks,
  DisconnectReason,
} from "livekit-client";
import { Aniface } from "aniface";

import { getConnectionDetails, leaveSession } from "./api.js";
import ParticipantCard from "./ParticipantCard.jsx";
import {
  parseInviteFromUrl,
  parseBooleanAttr,
  hasSubscribedVideo,
  loadStoredSession,
  clearStoredSession,
  saveStoredSession,
} from "./app-utils.js";
import { clearRoom } from "./app-utils.js";
import { useDelays } from "../../shared/shared.js";

function buildParticipantList(room) {
  const local = room.localParticipant;
  const localAdmissionStatus = local?.attributes?.admissionStatus || "pending";
  const remotes = Array.from(room.remoteParticipants.values());

  const relays = new Map();
  const originals = new Map();

  for (const p of remotes) {
    if (p.identity.startsWith("admin_") || p.identity.startsWith("EG_")) {
      continue;
    }
    if (p.identity.startsWith("fx_")) {
      const originalId = p.identity.slice("fx_".length);
      relays.set(originalId, p);
    } else {
      originals.set(p.identity, p);
    }
  }

  const list = [];
  const localShowSelf = localAdmissionStatus == "pending" || parseBooleanAttr(local?.attributes?.showSelf, true);
  if (localShowSelf) {
    list.push({
      key: `local:${local.identity}`,
      participant: local,
      displayName: local.name || local.identity,
      displayIdentity: local.identity,
    });
  }

  if (localAdmissionStatus !== "admitted") {
    return list;
  }

  const usedRelays = new Set();

  for (const [id, original] of originals.entries()) {
    if ((original?.attributes?.admissionStatus || "pending") !== "admitted") {
      continue;
    }
    const relay = relays.get(id);
    const originalHasVideo = hasSubscribedVideo(original);
    const shouldUseRelay = relay && id !== local.identity && !originalHasVideo;

    if (shouldUseRelay) {
      usedRelays.add(id);
      list.push({
        key: `fx:${relay.identity}`,
        participant: relay,
        displayName: original.name || original.identity,
        displayIdentity: original.identity,
      });
      continue;
    }

    list.push({
      key: `remote:${original.identity}`,
      participant: original,
      displayName: original.name || original.identity,
      displayIdentity: original.identity,
    });
  }

  for (const [id, relay] of relays.entries()) {
    if (originals.has(id) || usedRelays.has(id)) continue;
    if (id === local.identity) continue;
    if ((relay?.attributes?.admissionStatus || "pending") !== "admitted") continue;
    list.push({
      key: `fx:${relay.identity}`,
      participant: relay,
      displayName: relay.name || id,
      displayIdentity: id,
    });
  }

  return list;
}

function syncParticipantSubscriptions(room, role) {
  console.log("syncParticipantSubscriptions", room, role);
  if (!room || role !== "participant") return;

  const localIdentity = room.localParticipant?.identity || "(unknown)";
  const localAdmissionStatus = room.localParticipant?.attributes?.admissionStatus || "pending";
  const localCanReceive = localAdmissionStatus === "admitted";
  console.log(`syncParticipantSubscriptions: ${localAdmissionStatus} ${localCanReceive}`);

  for (const remoteParticipant of room.remoteParticipants.values()) {
    if (remoteParticipant.identity.startsWith("admin_") || remoteParticipant.identity.startsWith("EG_")) {
      continue;
    }

    const shouldSubscribeWithDelays = localCanReceive &&
      remoteParticipant.identity.startsWith("fx_") &&
      remoteParticipant.identity != "fx_" + localIdentity; // Subscribe to all effects except your own

    const shouldSubscribeNoDelays = localCanReceive &&
      remoteParticipant.identity.startsWith("p_") &&
      remoteParticipant.identity != "p_" + localIdentity; // Subscribe to all participants except your own

    const shouldSubscribe = useDelays ? shouldSubscribeWithDelays : shouldSubscribeNoDelays;

    console.log(`should I - ${localIdentity} - subscribe to ${remoteParticipant.identity} ? ${shouldSubscribe}`);

    for (const publication of remoteParticipant.trackPublications.values()) {
      if (publication.isDesired !== shouldSubscribe) {
        publication.setSubscribed(shouldSubscribe);
      }
    }
  }
}

async function avatarInit() {
  const avatar = new Aniface({
    canvasElement: document.getElementById('avatar'),
    modelPath: 'raccoon_head_small.glb'
    // No videoElement needed when using custom MediaPipe
  });
  await avatar.initialize();

  const vision = await FilesetResolver.forVisionTasks(
    'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@latest/wasm'
  );
  // Create MediaPipe instance with custom configuration
  const myLandmarker = await FaceLandmarker.createFromOptions(vision, {
    runningMode: 'VIDEO',
    minFaceDetectionConfidence: 0.7,
    minFacePresenceConfidence: 0.7,
    minTrackingConfidence: 0.7
    // ... other custom options
  });

  // Manual animation loop with custom MediaPipe
  function animate() {
    requestAnimationFrame(animate);
    const results = myLandmarker.detectForVideo(video, performance.now());
    console.log(results);
    avatar.processLandmarkData(results);
  }
  animate();
}

export default function ParticipantView() {
  const { inviteId, key, token, roomName, name: urlName } = useMemo(parseInviteFromUrl, []);
  const storedSession = useMemo(() => loadStoredSession(inviteId, key), [inviteId, key]);
  const [savedIdentity, setSavedIdentity] = useState(storedSession?.identity || "");
  const [name, setName] = useState(urlName || storedSession?.name || "");
  const [conn, setConn] = useState(null);
  const [err, setErr] = useState("");
  const [status, setStatus] = useState("idle"); // idle | connecting | connected | error
  const [autoJoinBlocked, setAutoJoinBlocked] = useState(false);
  const manualLeaveRef = useRef(false);
  const localTracksRef = useRef({ video: null, audio: null });
  const [serverOffline, setServerOffline] = useState(false);

  useEffect(() => {
    avatarInit();
  }, [token, roomName, conn]);

  // Keep a single Room instance per "session"
  const roomRef = useRef(null);

  // Re-render trigger when participants/tracks change
  const [, bump] = useState(0);
  const forceRender = () => bump((x) => x + 1);

  function clearLocalTracks() {
    const { video, audio } = localTracksRef.current;
    try {
      video?.stop?.();
    } catch (e) {
      console.log("Unable to clear video track", e);
    }
    try {
      audio?.stop?.();
    } catch (e) {
      console.log("Unable to clear audio track", e);
    }
    localTracksRef.current = { video: null, audio: null };
  }

  const onJoin = useCallback(async () => {
    setAutoJoinBlocked(false);
    manualLeaveRef.current = false;
    setErr("");
    setStatus("connecting");

    // If we have a direct token from admin, use it immediately
    if (token && roomName) {
      const LIVEKIT_URL = "ws://127.0.0.1:7880"; // Default - usually set by admin
      setConn({
        url: LIVEKIT_URL,
        token,
        room: roomName,
        identity: `p_${Math.random().toString(36).substr(2, 9)}`,
        role: "moderator",
        admissionStatus: "admitted",
      });
      return;
    }

    try {
      if (!inviteId || !key) throw new Error("Invalid invite link.");
      const details = await getConnectionDetails({
        inviteId,
        key,
        name,
        identity: savedIdentity || undefined,
      });
      setConn(details);
      setSavedIdentity(details.identity || savedIdentity);
      saveStoredSession(inviteId, key, {
        identity: details.identity || savedIdentity,
        name: name || "",
      });
    } catch (e) {
      const code = e?.code;
      const isRevoked =
        code === "identity_revoked" ||
        e?.status === 409 ||
        String(e?.message || "").includes("identity_revoked");

      if (isRevoked) {
        if (inviteId && key) {
          clearStoredSession(inviteId, key);
        }
        setSavedIdentity("");
        setName("");
        setAutoJoinBlocked(true);
        setStatus("idle");
        setErr("Session was reset by admin. Please enter your name to rejoin.");
        return;
      }

      setStatus("error");
      setErr(e?.message || "Join failed");
    }
  }, [token, roomName, inviteId, key, name, savedIdentity]);

  async function onLeave() {
    manualLeaveRef.current = true;
    setAutoJoinBlocked(true);
    setErr("");

    // Immediately return UI to join screen.
    const room = roomRef.current;
    setConn(null);
    setStatus("idle");

    try {
      if (inviteId && key && savedIdentity) {
        await leaveSession({ inviteId, key, identity: savedIdentity });
      }
    } catch (e) {
      console.warn("leave error:", e?.message || e);
    }

    if (inviteId && key) {
      clearStoredSession(inviteId, key);
    }
    setSavedIdentity("");
    setName("");
    try {
      room?.disconnect();
    } catch (e) {
      console.log("Unable to disconnect from room", e);
    }
    clearLocalTracks();
    roomRef.current = null;
  }

  // Auto-join if we have a direct token
  useEffect(() => {
    if (token && roomName && !conn) {
      onJoin();
    }
  }, [token, roomName, conn, onJoin]);

  useEffect(() => {
    let cancelled = false;
    const checkHealth = async () => {
      try {
        const r = await fetch("/api/healthz", { cache: "no-store" });
        if (!r.ok) throw new Error(`status ${r.status}`);
        if (!cancelled) setServerOffline(false);
      } catch {
        if (!cancelled) setServerOffline(true);
      }
    };
    checkHealth();
    const interval = setInterval(checkHealth, 5000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, []);

  // Auto-join if we have a saved identity for this invite
  useEffect(() => {
    if (conn) return;
    if (!inviteId || !key) return;
    if (!savedIdentity) return;
    if (autoJoinBlocked) return;
    if (status !== "idle") return;
    onJoin();
  }, [conn, inviteId, key, savedIdentity, status, autoJoinBlocked, onJoin]);

  // Connect + wire events when conn is set
  useEffect(() => {
    if (!conn) return;

    let cancelled = false;
    const room = new Room({
      adaptiveStream: true,
      dynacast: true,
    });
    roomRef.current = room;

    const onAnyUpdate = () => {
      // Any participant/track change -> rerender
      forceRender();
    };

    // Participant changes
    room
      .on(RoomEvent.ParticipantConnected, () => {
        syncParticipantSubscriptions(room, conn?.role);
        onAnyUpdate();
      })
      .on(RoomEvent.ParticipantDisconnected, () => {
        syncParticipantSubscriptions(room, conn?.role);
        onAnyUpdate();
      })
      .on(RoomEvent.ParticipantAttributesChanged, () => {
        syncParticipantSubscriptions(room, conn?.role);
        onAnyUpdate();
      })
      .on(RoomEvent.ActiveSpeakersChanged, onAnyUpdate);

    // Track changes
    room
      .on(RoomEvent.TrackSubscribed, onAnyUpdate)
      .on(RoomEvent.TrackUnsubscribed, onAnyUpdate)
      .on(RoomEvent.TrackPublished, () => {
        syncParticipantSubscriptions(room, conn?.role);
        onAnyUpdate();
      })
      .on(RoomEvent.TrackUnpublished, () => {
        syncParticipantSubscriptions(room, conn?.role);
        onAnyUpdate();
      });

    // Connection lifecycle
    room
      .on(RoomEvent.Disconnected, (reason) => {
        if (cancelled) return;
        setStatus("idle");
        setConn(null);
        roomRef.current = null;
        clearLocalTracks();

        if (manualLeaveRef.current) {
          manualLeaveRef.current = false;
          return;
        }

        // Only block auto-join when the server explicitly removes the participant.
        const removedByAdmin =
          reason === DisconnectReason.PARTICIPANT_REMOVED ||
          reason === DisconnectReason.DUPLICATE_IDENTITY;

        if (removedByAdmin) {
          setAutoJoinBlocked(true);
          if (inviteId && key) {
            clearStoredSession(inviteId, key);
          }
          setSavedIdentity("");
          setName("");
        } else {
          setAutoJoinBlocked(false);
        }
      })
      .on(RoomEvent.Reconnecting, () => {
        if (!cancelled) setStatus("connecting");
      })
      .on(RoomEvent.Reconnected, () => {
        if (!cancelled) setStatus("connected");
      });

    (async () => {
      try {
        const shouldAutoSubscribe = false;// conn?.role !== "participant";
//        const shouldAutoSubscribe = true;
        console.log("shouldAutoSubscribe", shouldAutoSubscribe);
        await room.connect(conn.url, conn.token, { autoSubscribe: shouldAutoSubscribe });
        if (cancelled) return;
        syncParticipantSubscriptions(room, conn?.role);
        setStatus("connected");
        forceRender();
      } catch (e) {
        console.error("connect error:", e);
        if (!cancelled) {
          setStatus("error");
          setErr(e?.message || String(e));
        }
        try {
          await room.disconnect();
        } catch (e) {
          console.log("Unable to disconnect from room", e);
        }
        return;
      }

      try {
        // Publish local tracks (cam + mic). If permissions fail, stay connected.
        const tracks = await createLocalTracks({
          audio: true,
          video: true,
        });

        const localVideo = tracks.find((t) => t.kind === Track.Kind.Video) || null;
        const localAudio = tracks.find((t) => t.kind === Track.Kind.Audio) || null;
        localTracksRef.current = { video: localVideo, audio: localAudio };

        for (const t of tracks) {
          await room.localParticipant.publishTrack(t);
        }
        forceRender();
      } catch (e) {
        console.warn("local media error:", e);
        if (!cancelled) {
          setErr(e?.message || "Could not access camera/microphone.");
        }
      }
    })();

    return () => {
      cancelled = true;
      clearRoom(room);
      clearLocalTracks();
      roomRef.current = null;
    };
  }, [conn, inviteId, key]);

  if (!inviteId && !key && !token) {
    return (
      <div style={{ padding: 24, fontFamily: "system-ui" }}>
        <h2>Invalid session link</h2>
        <p>This session requires a valid invite URL or access link.</p>
      </div>
    );
  }

  if (!conn) {
    if (savedIdentity && !autoJoinBlocked && status !== "error") {
      return (
        <div style={{ padding: 24, fontFamily: "system-ui", maxWidth: 520 }}>
          {serverOffline ? (
            <div style={{ marginBottom: 12, padding: 10, background: "#fee", color: "#a00", borderRadius: 6 }}>
              Server appears to be offline or shutting down.
            </div>
          ) : null}
          <h2>Rejoining session</h2>
          <p>Connecting you back to the room...</p>
          {err ? <p style={{ marginTop: 12, color: "crimson" }}>{err}</p> : null}
        </div>
      );
    }

    return (
      <div style={{ padding: 24, fontFamily: "system-ui", maxWidth: 520 }}>
        {serverOffline ? (
          <div style={{ marginBottom: 12, padding: 10, background: "#fee", color: "#a00", borderRadius: 6 }}>
            Server appears to be offline or shutting down.
          </div>
        ) : null}
        <h2>Join session</h2>
        <p>Enter an optional display name, then join.</p>

        <label style={{ display: "block", marginTop: 12 }}>
          Display name (optional)
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            style={{ width: "100%", padding: 8, marginTop: 6 }}
            placeholder="e.g. Participant"
          />
        </label>

        <button
          onClick={onJoin}
          style={{ marginTop: 12, padding: "10px 14px", cursor: "pointer" }}
        >
          Join
        </button>

        {err ? <p style={{ marginTop: 12, color: "crimson" }}>{err}</p> : null}
        <p style={{ marginTop: 18, opacity: 0.75, fontSize: 13 }}>
          Tip: allow microphone/camera permissions when prompted.
        </p>
      </div>
    );
  }

  const room = roomRef.current;
  const localAdmissionStatus = room?.localParticipant?.attributes?.admissionStatus || conn?.admissionStatus || "pending";
  const participants = room ? buildParticipantList(room) : [];

  return (
    <div style={{ fontFamily: "system-ui", padding: 12 }}>
      {serverOffline ? (
        <div style={{ marginBottom: 10, padding: 10, background: "#fee", color: "#a00", borderRadius: 6 }}>
          Server appears to be offline or shutting down.
        </div>
      ) : null}

      {localAdmissionStatus !== "admitted" ? (
        <div style={{ marginBottom: 10, padding: 10, background: "#fff7df", color: "#6b4f00", borderRadius: 6 }}>
          Waiting for admission. Your camera and microphone are live for admins, but you can only see yourself until you are admitted.
        </div>
      ) : null}

      {err ? <div style={{ color: "crimson", marginBottom: 10 }}>{err}</div> : null}
      <div>
        {room?.localParticipant?.attributes?.message || ""}
      </div>

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))",
          gap: 12,
          maxWidth: participants.length === 1 ? 1280 : "100%",
          margin: participants.length === 1 ? "0 auto" : undefined,
        }}
      >
        {participants.map((p) => (
          <ParticipantCard
            key={p.key}
            room={room}
            participant={p.participant}
            displayName={p.displayName}
            displayIdentity={p.displayIdentity}
            overrideVideoTrack={
              room && p.participant.identity === room.localParticipant.identity
                ? localTracksRef.current.video
                : null
            }
            overrideAudioTrack={
              room && p.participant.identity === room.localParticipant.identity
                ? localTracksRef.current.audio
                : null
            }
            muteAudioPlayback={
              room && p.participant.identity === room.localParticipant.identity
            }
          />
        ))}
      </div>

      <canvas id="avatar" />

      <div style={{ marginTop: 12 }}>
        <button
          onClick={onLeave}
          style={{ padding: "8px 12px", cursor: "pointer" }}
        >
          Leave
        </button>
      </div>
    </div>
  );
}

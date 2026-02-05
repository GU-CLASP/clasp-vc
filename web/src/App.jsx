import React, {
  useEffect,
  useMemo,
  useRef,
  useState
} from "react";
import {
  Room,
  RoomEvent,
  Track,
  createLocalTracks,
  DisconnectReason,
} from "livekit-client";

import { getConnectionDetails, leaveSession } from "./api.js";
import AdminPage from "./AdminPage.jsx";

function parseInviteFromUrl() {
  const pathname = stripBasePath(window.location.pathname);
  const m = pathname.match(/^\/join\/([^/]+)\/?$/);
  const inviteId = m?.[1] || null;
  const params = new URLSearchParams(window.location.search);
  const key = params.get("k");
  const adminKey = params.get("adminKey");

  // Direct join parameters (admin-generated tokens)
  const token = params.get("token");
  const roomName = params.get("room");
  const name = params.get("name");

  return { inviteId, key, adminKey, token, roomName, name };
}

const BASE_PATH = (import.meta.env.BASE_URL || "/").replace(/\/$/, "");

function stripBasePath(pathname) {
  if (BASE_PATH && pathname.startsWith(BASE_PATH)) {
    const next = pathname.slice(BASE_PATH.length);
    return next.startsWith("/") ? next : `/${next}`;
  }
  return pathname;
}

function parseRecordingParams() {
  const params = new URLSearchParams(window.location.search);
  return {
    url: params.get("url"),
    token: params.get("token"),
    layout: params.get("layout"),
  };
}

const IDENTITY_STORAGE_PREFIX = "clasp_vc_identity:";

function sessionKey(inviteId, key) {
  if (!inviteId || !key) return null;
  return `${IDENTITY_STORAGE_PREFIX}${inviteId}:${key}`;
}

function getIdentityStorage() {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

function loadStoredSession(inviteId, key) {
  const storage = getIdentityStorage();
  const storageKey = sessionKey(inviteId, key);
  if (!storage || !storageKey) return null;
  try {
    const raw = storage.getItem(storageKey);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function saveStoredSession(inviteId, key, data) {
  const storage = getIdentityStorage();
  const storageKey = sessionKey(inviteId, key);
  if (!storage || !storageKey) return;
  try {
    storage.setItem(storageKey, JSON.stringify(data));
  } catch {}
}

function clearStoredSession(inviteId, key) {
  const storage = getIdentityStorage();
  const storageKey = sessionKey(inviteId, key);
  if (!storage || !storageKey) return;
  try {
    storage.removeItem(storageKey);
  } catch {}
}

function isAdminPath() {
  return stripBasePath(window.location.pathname).startsWith("/admin");
}

function isRecordingPath() {
  return stripBasePath(window.location.pathname).startsWith("/recording");
}

function attachTrack(el, track) {
  // livekit-client track.attach() returns the element it attached to
  // but we want to attach to our existing element.
  // Easiest: detach anything currently on it, then attach fresh.
  try {
    track.detach(); // detach from any prior elements
  } catch {}
  const attachedEl = track.attach(el);
  // If attach() replaced element, we can copy attributes back,
  // but in practice with provided el this usually works.
  return attachedEl;
}

function hasSubscribedVideo(participant) {
  if (!participant) return false;
  for (const pub of participant.trackPublications.values()) {
    if (pub.kind === Track.Kind.Video && pub.track && pub.isSubscribed) {
      return true;
    }
  }
  return false;
}

function buildParticipantList(room) {
  const local = room.localParticipant;
  const remotes = Array.from(room.remoteParticipants.values());

  const relays = new Map();
  const originals = new Map();

  for (const p of remotes) {
    if (p.identity.startsWith("admin_") || p.identity.startsWith("EG_")) {
      continue;
    }
    if (p.identity.startsWith("relay_")) {
      const originalId = p.identity.slice("relay_".length);
      relays.set(originalId, p);
    } else {
      originals.set(p.identity, p);
    }
  }

  const list = [
    {
      key: `local:${local.identity}`,
      participant: local,
      displayName: local.name || local.identity,
      displayIdentity: local.identity,
    },
  ];

  const usedRelays = new Set();

  for (const [id, original] of originals.entries()) {
    const relay = relays.get(id);
    const originalHasVideo = hasSubscribedVideo(original);
    const shouldUseRelay = relay && id !== local.identity && !originalHasVideo;

    if (shouldUseRelay) {
      usedRelays.add(id);
      list.push({
        key: `relay:${relay.identity}`,
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
    list.push({
      key: `relay:${relay.identity}`,
      participant: relay,
      displayName: relay.name || id,
      displayIdentity: id,
    });
  }

  return list;
}

function buildRecordingParticipantList(room) {
  const remotes = Array.from(room.remoteParticipants.values());
  const relays = new Map();
  const originals = new Map();

  for (const p of remotes) {
    if (p.identity.startsWith("admin_") || p.identity.startsWith("EG_")) {
      continue;
    }
    if (p.identity.startsWith("relay_")) {
      const originalId = p.identity.slice("relay_".length);
      relays.set(originalId, p);
    } else {
      originals.set(p.identity, p);
    }
  }

  const list = [];

  const usedRelays = new Set();

  for (const [id, original] of originals.entries()) {
    const relay = relays.get(id);
    const originalHasVideo = hasSubscribedVideo(original);
    const shouldUseRelay = relay && !originalHasVideo;

    if (shouldUseRelay) {
      usedRelays.add(id);
      list.push({
        key: `relay:${relay.identity}`,
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
    list.push({
      key: `relay:${relay.identity}`,
      participant: relay,
      displayName: relay.name || id,
      displayIdentity: id,
    });
  }

  return list;
}

export default function App() {
  const { inviteId, key, adminKey, token, roomName, name: urlName } = useMemo(parseInviteFromUrl, []);
  const storedSession = useMemo(() => loadStoredSession(inviteId, key), [inviteId, key]);
  const [savedIdentity, setSavedIdentity] = useState(storedSession?.identity || "");
  const [name, setName] = useState(urlName || storedSession?.name || "");
  const [conn, setConn] = useState(null);
  const [err, setErr] = useState("");
  const [status, setStatus] = useState("idle"); // idle | connecting | connected | error
  const [autoJoinBlocked, setAutoJoinBlocked] = useState(false);
  const manualLeaveRef = useRef(false);
  const localTracksRef = useRef({ video: null, audio: null });

  // Check if admin path
  const admin = useMemo(isAdminPath, []);
  const recording = useMemo(isRecordingPath, []);

  // If admin path, show admin page
  if (admin) {
    if (adminKey) {
      // Store admin key in sessionStorage for API calls
      sessionStorage.setItem("adminKey", adminKey);
      return <AdminPage />;
    } else {
      return (
        <div style={{ padding: 24, fontFamily: "system-ui" }}>
          <h2>Admin Access Required</h2>
          <p>This page requires an admin key.</p>
          <p>
            Use the URL format: <code>/admin?adminKey=YOUR_ADMIN_KEY</code>
          </p>
        </div>
      );
    }
  }
  if (recording) {
    return <RecordingView />;
  }

  // Keep a single Room instance per "session"
  const roomRef = useRef(null);

  // Re-render trigger when participants/tracks change
  const [, bump] = useState(0);
  const forceRender = () => bump((x) => x + 1);

  function clearLocalTracks() {
    const { video, audio } = localTracksRef.current;
    try {
      video?.stop?.();
    } catch {}
    try {
      audio?.stop?.();
    } catch {}
    localTracksRef.current = { video: null, audio: null };
  }

  async function onJoin() {
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
      setStatus("error");
      setErr(e?.message || "Join failed");
    }
  }

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
    } catch {}
    clearLocalTracks();
    roomRef.current = null;
  }

  // Auto-join if we have a direct token
  useEffect(() => {
    if (token && roomName && !conn) {
      onJoin();
    }
  }, [token, roomName, conn]);

  // Auto-join if we have a saved identity for this invite
  useEffect(() => {
    if (conn) return;
    if (!inviteId || !key) return;
    if (!savedIdentity) return;
    if (autoJoinBlocked) return;
    if (status !== "idle") return;
    onJoin();
  }, [conn, inviteId, key, savedIdentity, status, autoJoinBlocked]);

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
      .on(RoomEvent.ParticipantConnected, onAnyUpdate)
      .on(RoomEvent.ParticipantDisconnected, onAnyUpdate)
      .on(RoomEvent.ActiveSpeakersChanged, onAnyUpdate);

    // Track changes
    room
      .on(RoomEvent.TrackSubscribed, onAnyUpdate)
      .on(RoomEvent.TrackUnsubscribed, onAnyUpdate)
      .on(RoomEvent.TrackPublished, onAnyUpdate)
      .on(RoomEvent.TrackUnpublished, onAnyUpdate);

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
            saveStoredSession(inviteId, key, {
              identity: "",
              name: name || "",
            });
          }
          setSavedIdentity("");
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
        // IMPORTANT: autoSubscribe must be true to see other participants
        await room.connect(conn.url, conn.token, { autoSubscribe: true });
        if (cancelled) return;
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
        } catch {}
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
      try {
        room.removeAllListeners();
      } catch {}
      try {
        room.disconnect();
      } catch {}
      clearLocalTracks();
      roomRef.current = null;
    };
  }, [conn]);

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
          <h2>Rejoining session</h2>
          <p>Connecting you back to the room...</p>
          {err ? <p style={{ marginTop: 12, color: "crimson" }}>{err}</p> : null}
        </div>
      );
    }

    return (
      <div style={{ padding: 24, fontFamily: "system-ui", maxWidth: 520 }}>
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
  const participants = room ? buildParticipantList(room) : [];

  return (
    <div style={{ fontFamily: "system-ui", padding: 12 }}>
      <div style={{ marginBottom: 10 }}>
        <b>Status:</b> {status}{" "}
        {room ? (
          <>
            | <b>room:</b> {conn.room} | <b>me:</b>{" "}
            {room.localParticipant.identity}
          </>
        ) : null}
      </div>

      {err ? <div style={{ color: "crimson", marginBottom: 10 }}>{err}</div> : null}

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
            participant={p.participant}
            displayName={p.displayName}
            displayIdentity={p.displayIdentity}
            overrideVideoTrack={
              room && p.participant.identity === room.localParticipant.identity
                ? localTracksRef.current.video
                : null
            }
          />
        ))}
      </div>

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

function RecordingView() {
  const { url, token } = useMemo(parseRecordingParams, []);
  const [status, setStatus] = useState("connecting");
  const [err, setErr] = useState("");
  const roomRef = useRef(null);
  const startedRef = useRef(false);
  const [, bump] = useState(0);

  const forceRender = () => bump((x) => x + 1);

  useEffect(() => {
    if (!url || !token) {
      setErr("Missing recording url or token");
      setStatus("error");
      return;
    }

    let cancelled = false;
    const room = new Room({ adaptiveStream: true, dynacast: true });
    roomRef.current = room;

    const onAnyUpdate = () => forceRender();

    room
      .on(RoomEvent.ParticipantConnected, onAnyUpdate)
      .on(RoomEvent.ParticipantDisconnected, onAnyUpdate)
      .on(RoomEvent.TrackSubscribed, onAnyUpdate)
      .on(RoomEvent.TrackUnsubscribed, onAnyUpdate);

    room.on(RoomEvent.Disconnected, () => {
      if (!cancelled) setStatus("idle");
      if (startedRef.current) {
        console.log("END_RECORDING");
        startedRef.current = false;
      }
    });

    (async () => {
      try {
        await room.connect(url, token, { autoSubscribe: true });
        if (cancelled) return;
        setStatus("connected");
        if (!startedRef.current) {
          console.log("START_RECORDING");
          startedRef.current = true;
        }
        forceRender();
      } catch (e) {
        console.error("recording connect error:", e);
        if (!cancelled) {
          setStatus("error");
          setErr(e?.message || String(e));
        }
      }
    })();

    return () => {
      cancelled = true;
      try {
        room.removeAllListeners();
      } catch {}
      try {
        room.disconnect();
      } catch {}
      if (startedRef.current) {
        console.log("END_RECORDING");
        startedRef.current = false;
      }
      roomRef.current = null;
    };
  }, [url, token]);

  const room = roomRef.current;
  const participants = room ? buildRecordingParticipantList(room) : [];

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        background: "#000",
        fontFamily: "system-ui",
        padding: 12,
      }}
    >
      {err ? (
        <div style={{ color: "#fff", padding: 12, background: "rgba(0,0,0,0.6)" }}>
          {err}
        </div>
      ) : null}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(320px, 1fr))",
          gap: 12,
          height: "100%",
          alignContent: "center",
        }}
      >
        {participants.map((p) => (
          <ParticipantCard
            key={p.key}
            participant={p.participant}
            displayName={p.displayName}
            displayIdentity={p.displayIdentity}
          />
        ))}
      </div>
      {status !== "connected" ? (
        <div style={{ position: "absolute", top: 12, right: 12, color: "#fff", opacity: 0.8 }}>
          {status}
        </div>
      ) : null}
    </div>
  );
}

function ParticipantCard({ participant, displayName, displayIdentity, overrideVideoTrack }) {
  const videoRef = useRef(null);
  const audioRef = useRef(null);

  // Pick the "best" subscribed video/audio track
  const tracks = Array.from(participant.trackPublications.values());
  const videoPub = tracks.find(
    (t) => t.kind === Track.Kind.Video && t.track && t.isSubscribed
  );
  const audioPub = tracks.find(
    (t) => t.kind === Track.Kind.Audio && t.track && t.isSubscribed
  );

  useEffect(() => {
    const el = videoRef.current;
    if (!el) return;

    const track = overrideVideoTrack || videoPub?.track;
    if (track) {
      attachTrack(el, track);
      el.muted = true; // prevent local echo; remote video doesn’t carry audio anyway
      el.playsInline = true;
      el.autoplay = true;
    } else {
      // Clear srcObject if any (some browsers)
      try {
        el.srcObject = null;
      } catch {}
    }
  }, [videoPub?.trackSid, videoPub?.track, overrideVideoTrack]);

  useEffect(() => {
    const el = audioRef.current;
    if (!el) return;

    if (audioPub?.track) {
      attachTrack(el, audioPub.track);
      el.autoplay = true;
      el.playsInline = true;
    } else {
      try {
        el.srcObject = null;
      } catch {}
    }
  }, [audioPub?.trackSid, audioPub?.track]);

  return (
    <div
      style={{
        border: "1px solid #ddd",
        borderRadius: 10,
        padding: 10,
        minHeight: 240,
      }}
    >
      <div style={{ marginBottom: 8 }}>
        <b>{displayName || participant.name || participant.identity}</b>
        <div style={{ opacity: 0.7, fontSize: 12 }}>
          {displayIdentity || participant.identity}
        </div>
      </div>

      {/* ✅ Video container with aspect ratio */}
      <div
        style={{
          position: "relative",
          width: "100%",
          aspectRatio: "16 / 9",  // Firefox supports this now
          background: "#111",
          borderRadius: 8,
          overflow: "hidden",
        }}
      >
        <video
          ref={videoRef}
          style={{
            width: "100%",
            height: "100%",
            objectFit: "contain",  // ✅ show full frame, no cropping
          }}
        />
      </div>

      {/* Audio element is separate */}
      <audio ref={audioRef} />

      <div style={{ marginTop: 8, fontSize: 12, opacity: 0.8 }}>
        video: {overrideVideoTrack ? "local" : videoPub?.track ? "subscribed" : "none"} | audio:{" "}
        {audioPub?.track ? "subscribed" : "none"}
      </div>
    </div>
  );
}

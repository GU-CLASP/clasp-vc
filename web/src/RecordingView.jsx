import { useEffect, useMemo, useRef, useState } from "react";
import {
  Room,
  RoomEvent,
} from "livekit-client";
import ParticipantCard from "./ParticipantCard";
import { hasSubscribedVideo } from "./app-utils";

function parseRecordingParams() {
  const params = new URLSearchParams(window.location.search);
  return {
    url: params.get("url"),
    token: params.get("token"),
  };
}

function buildRecordingParticipantList(room) {
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

  const usedRelays = new Set();

  for (const [id, original] of originals.entries()) {
    const relay = relays.get(id);
    const originalHasVideo = hasSubscribedVideo(original);
    const shouldUseRelay = relay && !originalHasVideo;

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
    list.push({
      key: `fx:${relay.identity}`,
      participant: relay,
      displayName: relay.name || id,
      displayIdentity: id,
    });
  }

  return list;
}

export default function RecordingView() {
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
      } catch (e) {
        console.warn("Unable to remove listeners from room", e);
      }
      try {
        room.disconnect();
      } catch (e) {
        console.warn("Unable to disconnect from room", e);
      }
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
            room={room}
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

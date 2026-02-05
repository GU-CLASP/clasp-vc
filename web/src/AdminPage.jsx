import React, { useEffect, useRef, useState } from "react";
import { Room, RoomEvent, Track } from "livekit-client";
import {
  getRooms,
  getParticipants,
  startRecording,
  stopRecording,
  getRecordingStatus,
  setStreamDelay,
  getStreamDelayStatus,
  getPreviewToken,
} from "./adminApi.js";

export default function AdminPage() {
  const [rooms, setRooms] = useState([]);
  const [selectedRoom, setSelectedRoom] = useState(null);
  const selectedRoomRef = useRef(null);
  const [participants, setParticipants] = useState([]);
  const [recordingStatus, setRecordingStatus] = useState({});
  const [streamDelays, setStreamDelays] = useState({});
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const [previewConn, setPreviewConn] = useState(null);
  const [previewError, setPreviewError] = useState("");

  // Delay controls per participant
  const [delayValues, setDelayValues] = useState({});
  const realParticipants = participants.filter(
    (p) => p?.identity && p.identity.startsWith("p_")
  );

  useEffect(() => {
    refreshRooms();
    const interval = setInterval(refreshRooms, 3000); // Refresh every 3 seconds
    return () => clearInterval(interval);
  }, []);

  useEffect(() => {
    selectedRoomRef.current = selectedRoom;
  }, [selectedRoom]);

  useEffect(() => {
    if (selectedRoom) {
      refreshParticipants();
      refreshRecordingStatus();
      refreshStreamDelays();
      const interval = setInterval(() => {
        refreshParticipants();
        refreshRecordingStatus();
        refreshStreamDelays();
      }, 2000);
      return () => clearInterval(interval);
    }
  }, [selectedRoom]);

  useEffect(() => {
    if (!selectedRoom) {
      setPreviewConn(null);
      setPreviewError("");
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const data = await getPreviewToken(selectedRoom);
        if (!cancelled) {
          setPreviewConn(data);
          setPreviewError("");
        }
      } catch (e) {
        if (!cancelled) setPreviewError(e.message || "Failed to load preview");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [selectedRoom]);

  async function refreshRooms() {
    try {
      const data = await getRooms();
      const nextRooms = data.rooms || [];
      setRooms(nextRooms);
      const currentSelected = selectedRoomRef.current;
      if (currentSelected && !nextRooms.some((room) => room.name === currentSelected)) {
        setSelectedRoom(null);
        setParticipants([]);
        setRecordingStatus({});
        setStreamDelays({});
        setDelayValues({});
      }
      setError("");
    } catch (e) {
      setError(e.message);
    }
  }

  async function refreshParticipants() {
    if (!selectedRoom) return;
    try {
      const data = await getParticipants(selectedRoom);
      setParticipants(data.participants || []);
      setError("");
    } catch (e) {
      setError(e.message);
    }
  }

  async function refreshRecordingStatus() {
    if (!selectedRoom) return;
    try {
      const data = await getRecordingStatus(selectedRoom);
      setRecordingStatus(data.recordings || {});
      setError("");
    } catch (e) {
      setError(e.message);
    }
  }

  async function refreshStreamDelays() {
    if (!selectedRoom) return;
    try {
      const data = await getStreamDelayStatus(selectedRoom);
      setStreamDelays(data.delays || {});
      setError("");
    } catch (e) {
      setError(e.message);
    }
  }

  async function handleSetDelay(participant, delayMs) {
    if (!selectedRoom) return;
    setLoading(true);
    try {
      await setStreamDelay(selectedRoom, participant, delayMs);
      setSuccess(`Delay set for ${participant}: ${delayMs}ms`);
      setTimeout(() => setSuccess(""), 3000);
      refreshStreamDelays();
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }

  async function handleToggleRecording() {
    if (!selectedRoom) return;
    setLoading(true);
    try {
      const anyActive = isRecordingActive("individual") || isRecordingActive("composite");
      if (anyActive) {
        await stopRecording(selectedRoom, "all");
        setSuccess("Recording stopped (all)");
      } else {
        await startRecording(selectedRoom, "individual");
        await startRecording(selectedRoom, "composite");
        setSuccess("Recording started (individual + composite)");
      }
      setTimeout(() => setSuccess(""), 3000);
      refreshRecordingStatus();
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }

  const isRecordingActive = (mode) => {
    return Array.isArray(recordingStatus)
      ? recordingStatus.some((r) => r.mode === mode && r.status === "recording")
      : Object.values(recordingStatus).some((r) => r.mode === mode && r.status === "recording");
  };
  const anyRecordingActive = isRecordingActive("individual") || isRecordingActive("composite");

  return (
    <div style={{ fontFamily: "system-ui", padding: 24, maxWidth: 1200, margin: "0 auto" }}>
      <h1>Video Conference Admin Panel</h1>

      <div style={{ marginBottom: 24 }}>
        <h2>Select Room</h2>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 12 }}>
          {rooms.length === 0 ? (
            <p style={{ opacity: 0.6 }}>No active rooms</p>
          ) : (
            rooms.map((room) => (
              <button
                key={room.name}
                onClick={() => {
                  setSelectedRoom(room.name);
                  setDelayValues({}); // Reset delay controls
                }}
                style={{
                  padding: "10px 14px",
                  backgroundColor: selectedRoom === room.name ? "#0066cc" : "#f0f0f0",
                  color: selectedRoom === room.name ? "white" : "black",
                  border: "1px solid #ccc",
                  borderRadius: 4,
                  cursor: "pointer",
                  fontWeight: selectedRoom === room.name ? "bold" : "normal",
                }}
              >
                {room.name}
                <br />
                <span style={{ fontSize: 11, opacity: 0.7 }}>
                  {(room.realParticipantCount ?? room.participantCount)} participant
                  {(room.realParticipantCount ?? room.participantCount) !== 1 ? "s" : ""}
                </span>
              </button>
            ))
          )}
        </div>
      </div>

      {selectedRoom && (
        <>
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "1fr 1fr",
              gap: 24,
              marginBottom: 24,
            }}
          >
            {/* Recording Controls */}
            <div
              style={{
                border: "1px solid #ddd",
                borderRadius: 8,
                padding: 16,
                backgroundColor: "#f9f9f9",
              }}
            >
              <h3>Recording</h3>
              <p style={{ opacity: 0.7, fontSize: 13, marginBottom: 16 }}>
                Starts both individual and composite recordings together.
              </p>
              <button
                onClick={handleToggleRecording}
                disabled={loading}
                style={{
                  padding: "10px 14px",
                  backgroundColor: anyRecordingActive ? "#f44336" : "#4CAF50",
                  color: "white",
                  border: "none",
                  borderRadius: 4,
                  cursor: "pointer",
                  width: "100%",
                  fontWeight: "bold",
                }}
              >
                {anyRecordingActive
                  ? "Stop Recording (All)"
                  : "Start Recording (All)"}
              </button>
            </div>

            {/* Stream Delay Controls */}
            <div
              style={{
                border: "1px solid #ddd",
                borderRadius: 8,
                padding: 16,
                backgroundColor: "#f9f9f9",
              }}
            >
              <h3>Stream Delay Controls</h3>
              <p style={{ opacity: 0.7, fontSize: 13, marginBottom: 16 }}>
                Add delay to participants' streams (other participants will experience the delay).
              </p>

              {realParticipants.length === 0 ? (
                <p style={{ opacity: 0.6 }}>No participants in this room</p>
              ) : (
                <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
                  {realParticipants.map((participant) => (
                    <div
                      key={participant.identity}
                      style={{
                        backgroundColor: "white",
                        border: "1px solid #ddd",
                        borderRadius: 4,
                        padding: 8,
                        display: "flex",
                        alignItems: "center",
                        gap: 8,
                      }}
                    >
                      <div style={{ flex: 1 }}>
                        <div style={{ fontWeight: "bold" }}>{participant.name || participant.identity}</div>
                        <div style={{ fontSize: 11, opacity: 0.6 }}>{participant.identity}</div>
                      </div>
                      <input
                        type="number"
                        min="0"
                        max="10000"
                        step="100"
                        value={delayValues[participant.identity] ?? streamDelays[participant.identity] ?? 0}
                        onChange={(e) =>
                          setDelayValues({
                            ...delayValues,
                            [participant.identity]: Number(e.target.value),
                          })
                        }
                        placeholder="ms"
                        style={{
                          width: 80,
                          padding: "4px 6px",
                          border: "1px solid #ccc",
                          borderRadius: 3,
                        }}
                      />
                      <span style={{ fontSize: 12, opacity: 0.6, minWidth: 30 }}>ms</span>
                      <button
                        onClick={() =>
                          handleSetDelay(
                            participant.identity,
                            delayValues[participant.identity] ?? streamDelays[participant.identity] ?? 0
                          )
                        }
                        disabled={loading}
                        style={{
                          padding: "4px 8px",
                          backgroundColor: "#2196F3",
                          color: "white",
                          border: "none",
                          borderRadius: 3,
                          cursor: "pointer",
                          fontSize: 12,
                        }}
                      >
                        Apply
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>

          <div
            style={{
              border: "1px solid #ddd",
              borderRadius: 8,
              padding: 16,
              backgroundColor: "#f9f9f9",
              marginBottom: 24,
            }}
          >
            <h3>Composite Preview</h3>
            {previewError ? (
              <div style={{ color: "#c00", marginBottom: 8 }}>{previewError}</div>
            ) : null}
            {previewConn ? (
              <CompositePreview conn={previewConn} />
            ) : (
              <div style={{ opacity: 0.6 }}>Loading preview...</div>
            )}
          </div>

          {/* Room Info */}
          <div
            style={{
              border: "1px solid #ddd",
              borderRadius: 8,
              padding: 16,
              backgroundColor: "#f9f9f9",
            }}
          >
            <h3>Room Information</h3>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: 16 }}>
              <div>
                <strong>Room:</strong>
                <div style={{ opacity: 0.7 }}>{selectedRoom}</div>
              </div>
              <div>
                <strong>Participants:</strong>
                <div style={{ opacity: 0.7 }}>{realParticipants.length}</div>
              </div>
              <div>
                <strong>Recording Status:</strong>
                <div style={{ opacity: 0.7 }}>
                  {Array.isArray(recordingStatus) ? recordingStatus.length : Object.keys(recordingStatus).length} active
                </div>
              </div>
            </div>
          </div>

          <div style={{ marginTop: 16, minHeight: 44 }}>
            {error && (
              <div style={{ backgroundColor: "#fee", color: "#c00", padding: 12, borderRadius: 6 }}>
                <strong>Error:</strong> {error}
              </div>
            )}
            {success && (
              <div style={{ backgroundColor: "#efe", color: "#060", padding: 12, borderRadius: 6, marginTop: 8 }}>
                <strong>Success:</strong> {success}
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}

function isPreviewableIdentity(identity) {
  if (!identity) return false;
  if (identity.startsWith("relay_")) return true;
  if (identity.startsWith("p_")) return true;
  return false;
}

function buildPreviewParticipants(room) {
  const remotes = Array.from(room.remoteParticipants.values());
  const relays = new Map();
  const originals = new Map();

  for (const p of remotes) {
    if (!isPreviewableIdentity(p.identity)) continue;
    if (p.identity.startsWith("relay_")) {
      const originalId = p.identity.slice("relay_".length);
      relays.set(originalId, p);
    } else {
      originals.set(p.identity, p);
    }
  }

  const list = [];
  for (const [id, original] of originals.entries()) {
    const relay = relays.get(id);
    if (relay) {
      list.push({
        key: `relay:${relay.identity}`,
        participant: relay,
        displayName: original.name || original.identity,
        displayIdentity: original.identity,
      });
    } else {
      list.push({
        key: `remote:${original.identity}`,
        participant: original,
        displayName: original.name || original.identity,
        displayIdentity: original.identity,
      });
    }
  }

  for (const [id, relay] of relays.entries()) {
    if (originals.has(id)) continue;
    list.push({
      key: `relay:${relay.identity}`,
      participant: relay,
      displayName: id,
      displayIdentity: id,
    });
  }

  return list;
}

function attachTrack(el, track) {
  try {
    track.detach();
  } catch {}
  const attachedEl = track.attach(el);
  return attachedEl;
}

function CompositePreview({ conn }) {
  const roomRef = useRef(null);
  const [, bump] = useState(0);

  const forceRender = () => bump((x) => x + 1);

  useEffect(() => {
    if (!conn?.url || !conn?.token) return;
    let cancelled = false;
    const room = new Room({ adaptiveStream: true, dynacast: true });
    roomRef.current = room;

    const onAnyUpdate = () => forceRender();

    room
      .on(RoomEvent.ParticipantConnected, onAnyUpdate)
      .on(RoomEvent.ParticipantDisconnected, onAnyUpdate)
      .on(RoomEvent.TrackSubscribed, onAnyUpdate)
      .on(RoomEvent.TrackUnsubscribed, onAnyUpdate);

    (async () => {
      try {
        await room.connect(conn.url, conn.token, { autoSubscribe: true });
        if (!cancelled) forceRender();
      } catch (e) {
        console.error("preview connect error:", e);
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
      roomRef.current = null;
    };
  }, [conn?.url, conn?.token]);

  const room = roomRef.current;
  const participants = room ? buildPreviewParticipants(room) : [];

  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))",
        gap: 12,
      }}
    >
      {participants.length === 0 ? (
        <div style={{ opacity: 0.6 }}>No participants yet</div>
      ) : (
        participants.map((p) => (
          <PreviewTile
            key={p.key}
            participant={p.participant}
            displayName={p.displayName}
            displayIdentity={p.displayIdentity}
          />
        ))
      )}
    </div>
  );
}

function PreviewTile({ participant, displayName, displayIdentity }) {
  const videoRef = useRef(null);
  const audioRef = useRef(null);
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
    if (videoPub?.track) {
      attachTrack(el, videoPub.track);
      el.muted = true;
      el.playsInline = true;
      el.autoplay = true;
    } else {
      try {
        el.srcObject = null;
      } catch {}
    }
  }, [videoPub?.trackSid, videoPub?.track]);

  useEffect(() => {
    const el = audioRef.current;
    if (!el) return;
    if (audioPub?.track) {
      attachTrack(el, audioPub.track);
      el.autoplay = true;
      el.playsInline = true;
      el.muted = true;
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
        borderRadius: 8,
        padding: 8,
        background: "#fff",
      }}
    >
      <div style={{ marginBottom: 6 }}>
        <strong>{displayName || participant.name || participant.identity}</strong>
        <div style={{ opacity: 0.6, fontSize: 12 }}>
          {displayIdentity || participant.identity}
        </div>
      </div>
      <div
        style={{
          position: "relative",
          width: "100%",
          aspectRatio: "16 / 9",
          background: "#111",
          borderRadius: 6,
          overflow: "hidden",
        }}
      >
        <video
          ref={videoRef}
          style={{
            width: "100%",
            height: "100%",
            objectFit: "contain",
          }}
        />
      </div>
      <audio ref={audioRef} />
    </div>
  );
}

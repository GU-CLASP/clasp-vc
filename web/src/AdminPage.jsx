import React, { useEffect, useRef, useState } from "react";
import { Room, RoomEvent, Track } from "livekit-client";
import {
  getRoom,
  getParticipants,
  removeParticipant,
  startRecording,
  stopRecording,
  getRecordingStatus,
  setStreamDelay,
  getStreamDelayStatus,
  getPreviewToken,
  getHealth,
} from "./adminApi.js";

export default function AdminPage() {
  const [selectedRoom, setSelectedRoom] = useState(null);
  const [participants, setParticipants] = useState([]);
  const [recordingStatus, setRecordingStatus] = useState({});
  const [streamDelays, setStreamDelays] = useState({});
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [errorLog, setErrorLog] = useState([]);
  const [success, setSuccess] = useState("");
  const [previewConn, setPreviewConn] = useState(null);
  const [previewError, setPreviewError] = useState("");
  const previewStateRef = useRef({ conn: null, error: "" });
  const [serviceHealth, setServiceHealth] = useState(null);
  const [serverOffline, setServerOffline] = useState(false);
  const serverOfflineRef = useRef(false);

  // Delay controls per participant
  const [delayValues, setDelayValues] = useState({});
  const realParticipants = participants.filter(
    (p) => p?.identity && p.identity.startsWith("p_")
  );

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const data = await getRoom();
        if (!cancelled) setSelectedRoom(data.room || null);
      } catch (e) {
        if (!cancelled) appendError(`room load failed: ${e?.message || e}`);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

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
    serverOfflineRef.current = serverOffline;
  }, [serverOffline]);

  useEffect(() => {
    let cancelled = false;
    const checkHealthz = async () => {
      try {
        const r = await fetch("/api/healthz", { cache: "no-store" });
        if (!r.ok) throw new Error(`status ${r.status}`);
        if (!cancelled) setServerOffline(false);
      } catch {
        if (!cancelled) setServerOffline(true);
      }
    };
    checkHealthz();
    const interval = setInterval(checkHealthz, 5000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    const runHealth = async () => {
      try {
        if (serverOffline) {
          if (!cancelled) setServiceHealth(null);
          return;
        }
        const data = await getHealth();
        if (!cancelled) setServiceHealth(data);
      } catch (e) {
        if (!cancelled && !serverOffline) appendError(`health check failed: ${e?.message || e}`);
      }
    };
    runHealth();
    const interval = setInterval(runHealth, 5000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [serverOffline]);

  useEffect(() => {
    if (!selectedRoom) {
      setPreviewConn(null);
      setPreviewError("");
      return;
    }
    let cancelled = false;

    const loadPreview = async () => {
      try {
        if (serverOfflineRef.current) {
          if (!cancelled) setPreviewError("Server appears offline");
          return;
        }
        const data = await getPreviewToken(selectedRoom);
        if (!cancelled) {
          setPreviewConn(data);
          setPreviewError("");
        }
      } catch (e) {
        if (!cancelled) setPreviewError(e.message || "Failed to load preview");
      }
    };

    loadPreview();
    const interval = setInterval(() => {
      const state = previewStateRef.current;
      if (serverOfflineRef.current) return;
      if (!state.conn || state.error) {
        loadPreview();
      }
    }, 3000);

    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [selectedRoom]);

  useEffect(() => {
    previewStateRef.current = { conn: previewConn, error: previewError };
  }, [previewConn, previewError]);

  function appendError(message) {
    const entry = {
      time: new Date().toLocaleTimeString(),
      message,
    };
    setError(message);
    setErrorLog((prev) => [...prev, entry].slice(-50));
  }

  async function refreshParticipants() {
    if (!selectedRoom) return;
    if (serverOfflineRef.current) return;
    try {
      const data = await getParticipants(selectedRoom);
      setParticipants(data.participants || []);
    } catch (e) {
      if (!serverOffline) appendError(`participants refresh failed: ${e?.message || e}`);
    }
  }

  async function refreshRecordingStatus() {
    if (!selectedRoom) return;
    if (serverOfflineRef.current) return;
    try {
      const data = await getRecordingStatus(selectedRoom);
      setRecordingStatus(data.recordings || {});
    } catch (e) {
      if (!serverOffline) appendError(`recording status failed: ${e?.message || e}`);
    }
  }

  async function refreshStreamDelays() {
    if (!selectedRoom) return;
    if (serverOfflineRef.current) return;
    try {
      const data = await getStreamDelayStatus(selectedRoom);
      setStreamDelays(data.delays || {});
    } catch (e) {
      if (!serverOffline) appendError(`stream delay status failed: ${e?.message || e}`);
    }
  }

  async function handleSetDelay(participant, delayMs) {
    if (!selectedRoom) return;
    if (serverOffline) {
      appendError("set delay failed: server appears offline");
      return;
    }
    setLoading(true);
    try {
      await setStreamDelay(selectedRoom, participant, delayMs);
      setSuccess(`Delay set for ${participant}: ${delayMs}ms`);
      setTimeout(() => setSuccess(""), 3000);
      refreshStreamDelays();
    } catch (e) {
      appendError(`set delay failed: ${e?.message || e}`);
    } finally {
      setLoading(false);
    }
  }

  async function handleRemoveParticipant(identity) {
    if (!selectedRoom) return;
    if (serverOffline) {
      appendError("remove participant failed: server appears offline");
      return;
    }
    setLoading(true);
    try {
      await removeParticipant(selectedRoom, identity);
      setSuccess(`Removed ${identity}`);
      setTimeout(() => setSuccess(""), 3000);
      refreshParticipants();
      refreshStreamDelays();
    } catch (e) {
      appendError(`remove participant failed: ${e?.message || e}`);
    } finally {
      setLoading(false);
    }
  }

  async function handleToggleRecording() {
    if (!selectedRoom) return;
    if (serverOffline) {
      appendError("recording toggle failed: server appears offline");
      return;
    }
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
      appendError(`recording toggle failed: ${e?.message || e}`);
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

      <div style={{ marginBottom: 16 }}>
        <strong>Room:</strong>{" "}
        <span style={{ opacity: 0.8 }}>
          {selectedRoom || "Loading..."}
        </span>
      </div>

      <div style={{ marginBottom: 16 }}>
        <strong>Service Health:</strong>
        <div style={{ marginTop: 6, fontSize: 13 }}>
          {serverOffline ? (
            <span style={{ color: "crimson", marginRight: 12 }}>
              token-service: down
            </span>
          ) : null}
          <span style={{ marginRight: 12 }}>
            delay-service:{" "}
            <span style={{ color: serviceHealth?.delayService?.ok ? "green" : "crimson" }}>
              {serviceHealth?.delayService?.ok ? "up" : "down"}
            </span>
            {serviceHealth?.delayService?.ms != null ? ` (${serviceHealth.delayService.ms}ms)` : ""}
            {serviceHealth?.delayService?.error ? ` - ${serviceHealth.delayService.error}` : ""}
          </span>
          <span>
            livekit:{" "}
            <span style={{ color: serviceHealth?.livekit?.ok ? "green" : "crimson" }}>
              {serviceHealth?.livekit?.ok ? "up" : "down"}
            </span>
            {serviceHealth?.livekit?.error ? ` - ${serviceHealth.livekit.error}` : ""}
          </span>
        </div>
      </div>

      {selectedRoom ? (
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
                      <button
                        onClick={() => handleRemoveParticipant(participant.identity)}
                        disabled={loading}
                        style={{
                          padding: "4px 8px",
                          backgroundColor: "#d9534f",
                          color: "white",
                          border: "none",
                          borderRadius: 3,
                          cursor: "pointer",
                          fontSize: 12,
                        }}
                      >
                        Remove
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
              <CompositePreview
                conn={previewConn}
                streamDelays={streamDelays}
                onDisconnect={() => {
                  setPreviewConn(null);
                  setPreviewError("Preview disconnected, retrying...");
                }}
              />
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
      ) : null}

      <div style={{ marginTop: 16 }}>
        <strong>Error Log</strong>
        <div
          style={{
            marginTop: 8,
            maxHeight: 180,
            overflow: "auto",
            background: "#fafafa",
            border: "1px solid #eee",
            borderRadius: 6,
            padding: 8,
            fontSize: 12,
          }}
        >
          {errorLog.length === 0 ? (
            <div style={{ opacity: 0.6 }}>No errors yet.</div>
          ) : (
            errorLog.map((entry, idx) => (
              <div key={`${entry.time}-${idx}`} style={{ marginBottom: 6 }}>
                <span style={{ color: "#888", marginRight: 6 }}>{entry.time}</span>
                <span>{entry.message}</span>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}

function isPreviewableIdentity(identity) {
  if (!identity) return false;
  if (identity.startsWith("relay_")) return true;
  if (identity.startsWith("p_")) return true;
  return false;
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

function buildPreviewParticipants(room, streamDelays) {
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
  const usedRelays = new Set();

  for (const [id, original] of originals.entries()) {
    const relay = relays.get(id);
    const originalHasVideo = hasSubscribedVideo(original);
    const hasDelay = Number(streamDelays?.[id] || 0) > 0;
    const shouldUseRelay = relay && (hasDelay || !originalHasVideo);

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

function attachTrack(el, track) {
  try {
    track.detach();
  } catch {}
  const attachedEl = track.attach(el);
  return attachedEl;
}

function CompositePreview({ conn, streamDelays, onDisconnect }) {
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
      .on(RoomEvent.TrackUnsubscribed, onAnyUpdate)
      .on(RoomEvent.Disconnected, () => {
        if (!cancelled) onDisconnect?.();
      });

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
  const participants = room ? buildPreviewParticipants(room, streamDelays) : [];

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

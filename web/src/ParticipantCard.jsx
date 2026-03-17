import { useEffect, useRef, useState } from "react";
import {
  Track,
} from "livekit-client";

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

export default function ParticipantCard({ room, participant, displayName, displayIdentity, overrideVideoTrack }) {
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
      console.log(`Adding video track for ${displayName}:`, videoRef);
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
      console.log(`Adding audio track for ${displayName}:`, audioRef);
      if (displayIdentity !== room?.localParticipant?.identity) {
        attachTrack(el, audioPub.track);
        el.autoplay = true;
        el.playsInline = true;
      }
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

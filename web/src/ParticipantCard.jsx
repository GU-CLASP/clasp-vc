import { useEffect, useRef } from "react";
import {
  Track,
} from "livekit-client";

function attachTrack(el, track) {
  console.log("attachTrack", el, track);

  // livekit-client track.attach() returns the element it attached to
  // but we want to attach to our existing element.
  // Easiest: detach anything currently on it, then attach fresh.
  track.detach();
  const attachedEl = track.attach(el);
  // If attach() replaced element, we can copy attributes back,
  // but in practice with provided el this usually works.
  return attachedEl;
}

export default function ParticipantCard({
  room,
  participant,
  displayName,
  displayIdentity,
  overrideVideoTrack,
  overrideAudioTrack,
  muteAudioPlayback = false,
}) {
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
      el.srcObject = null;
    }
  }, [videoPub?.trackSid, videoPub?.track, overrideVideoTrack, displayName]);

  useEffect(() => {
    const el = audioRef.current;
    if (!el) return;

    const track = overrideAudioTrack || audioPub?.track;
    if (track) {
      console.log(`Adding audio track for ${displayName}:`, audioRef);
      attachTrack(el, track);
      el.autoplay = true;
      el.playsInline = true;
      el.muted = muteAudioPlayback || displayIdentity === room?.localParticipant?.identity;
    } else {
      el.srcObject = null;
    }
  }, [audioPub?.trackSid, audioPub?.track, overrideAudioTrack, muteAudioPlayback, displayIdentity, room, displayName]);

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
        {overrideVideoTrack != null ? "override" : JSON.stringify(videoPub?.trackSid)}
        {overrideAudioTrack != null ? "override" : JSON.stringify(audioPub?.trackSid)}
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
    </div>
  );
}

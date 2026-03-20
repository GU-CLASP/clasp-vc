import { log } from "./utils";
import { roomService } from "./livekit-api";
import { identitySessions } from "./identity-sessions";

export function isRecordableParticipant(identity) {
  if (!identity) return false;
  if (identity.startsWith("fx_")) return false;
  if (identity.startsWith("EG_")) return false;
  if (identity.startsWith("admin_")) return false;
  return identity.startsWith("p_");
}

function participantPermissionForSession(session) {
  return {
    canPublish: true,
    canPublishData: true,
    canSubscribe: true,// session?.admissionStatus === "admitted",
  };
}

export async function applyParticipantSessionState(room, identity) {
  const session = identitySessions.get(identity);
  if (!session) return;

  const info = await roomService.getParticipant(room, identity);
  const attributes = { ...(info?.attributes || {}) };
  attributes.showSelf = session.showSelf === false ? "false" : "true";
  attributes.admissionStatus = session.admissionStatus || "pending";

  await roomService.updateParticipant(room, identity, {
    attributes,
    permission: participantPermissionForSession(session),
    name: session.name,
  });
}

function scheduleApplyParticipantSessionState(room, identity, attempts = 20, delayMs = 500) {
  const run = async (remaining) => {
    const session = identitySessions.get(identity);
    if (!session || session.room !== room) return;
    try {
      await applyParticipantSessionState(room, identity);
    } catch (err) {
      const message = String(err?.message || "");
      const notFound = err?.code === 404 || /not found/i.test(message);
      if (!notFound || remaining <= 1) {
        if (!notFound) {
          console.warn("applyParticipantSessionState error:", err?.message || err);
        }
        return;
      }
      const timeoutId = setTimeout(() => {
        run(remaining - 1).catch((nextErr) => {
          console.warn("applyParticipantSessionState retry error:", nextErr?.message || nextErr);
        });
      }, delayMs);
      timeoutId.unref?.();
    }
  };

  run(attempts).catch((err) => {
    console.warn("scheduleApplyParticipantSessionState error:", err?.message || err);
  });
}

function shouldSubscribeToTracks(p) {
  const hasAdmittedProperty = identitySessions.get(p.identity)?.admissionStatus === "admitted";
  const isEffect = p.identity.startsWith("fx_");
  return hasAdmittedProperty || isEffect
}

async function logAllTracks(room) {
  log("LOGALLTRACKS");
  const participantInfos = await roomService.listParticipants(room.name);
  for (let p of participantInfos) {
    log(`Participant ${p.identity} (${p.name}): ((${p.sid}))`);
    log(`- Attributes: ${JSON.stringify(p.attributes)}`);
    log(`- Kind: ${p.kind}`);
    log(`- Track ids: ${p.tracks.map((tr) => `${tr.sid} ${tr.type} ${tr.name}`)}`);
    log(`- Permissions: ${JSON.stringify(p.permission)}`);
  }
}

export async function syncAdmittedSubscriptions(roomName) {
  const rooms = await roomService.listRooms([roomName]);
  const room = rooms[0];
  await logAllTracks(room);
  const participants = await roomService.listParticipants(roomName);
  const connected = participants.filter((p) => isRecordableParticipant(p.identity));
  const admitted = connected.filter((p) => shouldSubscribeToTracks(p));
  const pendingTrackSids = connected
    .filter((p) => identitySessions.get(p.identity)?.admissionStatus !== "admitted")
    .flatMap((p) => (p.tracks || []).map((t) => t.sid).filter(Boolean));

  // Need to check if everyone is in room with the right status when this code runs...
  log(`syncAdmittedSubscriptions, participants: ${participants.map(p => p.identity)}`);
  log(`syncAdmittedSubscriptions, connected: ${connected.map(p => p.identity)}`);
  log(`syncAdmittedSubscriptions, admitted: ${admitted.map(p => p.identity)}`);
  log(`syncAdmittedSubscriptions, pendingTrackSids: ${pendingTrackSids}`);

  for (const participant of admitted) {
    const subscribeTrackSids = admitted
      .filter((other) => other.identity !== participant.identity)
      .flatMap((other) => (other.tracks || []).map((t) => t.sid).filter(Boolean));
    log(`syncAdmittedSubscriptions, subscribeTrackSids for ${participant.identity}: ${subscribeTrackSids}`);

    if (subscribeTrackSids.length > 0) {
      log(`syncAdmittedSubscriptions. updateSubscriptions ${participant.name} ${participant.identity} ${subscribeTrackSids} true`);
      await roomService.updateSubscriptions(roomName, participant.identity, subscribeTrackSids, true);
    }
    if (pendingTrackSids.length > 0) {
      log(`syncAdmittedSubscriptions. updateSubscriptions ${participant.name} ${participant.identity} ${pendingTrackSids} false`);
      await roomService.updateSubscriptions(roomName, participant.identity, pendingTrackSids, false);
    }
  }
}

export function scheduleSync(room, identity, session) {
  const attempts = 10;
  const delayMs = 500;

  const run = async (remaining) => {
    try {
      log(`scheduleSync attempt #${remaining}`);
      await applyParticipantSessionState(room, identity);
      if (session.admissionStatus === "admitted") {
        await syncAdmittedSubscriptions(room);
      }
    } catch (err) {
      console.warn("scheduleSync error inner:", err?.message || err);
    }
    if (remaining <= 1) return;
    const timeoutId = setTimeout(() => {
      run(remaining - 1).catch((err) => {
        console.warn("scheduleSync retry error:", err?.message || err);
      });
    }, delayMs);
    timeoutId.unref?.();
  };

  run(attempts).catch((err) => {
    console.warn("scheduleSync error:", err?.message || err);
  });
}

function scheduleSyncAdmittedSubscriptions(room, attempts = 6, delayMs = 500) {
  const run = async (remaining) => {
    try {
      await syncAdmittedSubscriptions(room);
    } catch (err) {
      console.warn("syncAdmittedSubscriptions error:", err?.message || err);
    }
    if (remaining <= 1) return;
    const timeoutId = setTimeout(() => {
      run(remaining - 1).catch((err) => {
        console.warn("scheduleSyncAdmittedSubscriptions retry error:", err?.message || err);
      });
    }, delayMs);
    timeoutId.unref?.();
  };

  run(attempts).catch((err) => {
    console.warn("scheduleSyncAdmittedSubscriptions error:", err?.message || err);
  });
}

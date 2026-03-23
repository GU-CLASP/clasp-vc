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

export async function onParticipantAdmitted(roomName, participant) {

}

export async function onEffectStarted(roomName, participant) {

}

export async function onAdminConnected(roomName, participant) {

}

export async function fixImportedSubscriptionsFromParticipant(roomName, participant) {
  // Check who should subscribe to this participant's tracks and fix that
}

/**
 * Check if participant is admin
 * @param {ParticipantInfo} participant Participant to check
 * @returns {boolean} True if participant is admin, false otherwise
 */
function isAdminParticipant(participant) {
  return participant.identity.startsWith("admin_");
}

/**
 * Check if participant is a normal admitted participant
 * @param {ParticipantInfo} participant Participant to check
 * @returns {boolean} True if participant is regular particpant and has been admitted, false otherwise
 */
function isAdmittedParticipant(participant) {
  return participant.identity.startsWith("p_") && participant.attributes["admissionStatus"] == "admitted";
}

/**
 * Check if participant is waiting to be admitted inside the room
 * @param {ParticipantInfo} participant Participant to check
 * @returns {boolean} True if participant is waiting to be admitted, false otherwise
 */
function isWaitingRoomParticipant(participant) {
  return participant.identity.startsWith("p_") && participant.attributes["admissionStatus"] == "pending";
}

/**
 * Check if participant is an egress (recording)
 * @param {ParticipantInfo} participant Participant to check
 * @returns {boolean} True if participant is an egress, false otherwise
 */
function isEgressParticipant(participant) {
  return participant.identity.startsWith("EG_");
}

/**
 * Check if participant is an internal effect created from another participant
 * @param {ParticipantInfo} participant Participant to check
 * @returns {boolean} True if participant is an effect, false otherwise
 */
function isEffectParticipant(participant) {
  return participant.identity.startsWith("fx_");
}

/**
 * Single source of truth about who should subscribe to what
 * 
 * @param {ParticipantInfo} who The subject, who should do the (un)subscribing
 * @param {ParticipantInfo} trackOwner The owner of the tracks to (un)subscribe to
 */
function shouldSubscribeTo(who, trackOwner) {
  if (isAdminParticipant(who)) {
    return !isAdmittedParticipant(trackOwner);
  }
  if (isWaitingRoomParticipant(who)) {
    return false;
  }
  if (isEffectParticipant(who)) {
    const effectSource = who.identity.substring("fx_".length);
    return trackOwner.identity == effectSource;
  }
  if (isAdmittedParticipant(who)) {
    if (isEffectParticipant(trackOwner)) {
      const effectSource = trackOwner.identity.substring("fx_".length);
      return effectSource != who.identity;
    } else {
      return false;
    }
  }
  if (isEgressParticipant(who)) {
    return isEffectParticipant(trackOwner);
  }
  console.warn(`Unable to determine subscriptions for participant: ${who} ${who.identity} for trackOwner ${trackOwner} ${trackOwner.identity}`);
}

export async function fixRoomSubscriptions(roomName) {
  const participantInfos = await roomService.listParticipants(roomName);
  logAllTracks(roomName);
  console.log(`fixRoomSubscriptions ${roomName}`);
  for (let who of participantInfos) {
    let subscribeTrackSids = [];
    let unsubscribeTrackSids = [];
    for (let trackOwner of participantInfos) {
      const targetTracks = trackOwner.tracks.map((t) => t.sid);
      if (shouldSubscribeTo(who, trackOwner)) {
        subscribeTrackSids = subscribeTrackSids.concat(targetTracks);
      } else {
        unsubscribeTrackSids = unsubscribeTrackSids.concat(targetTracks);
      }
    }
    console.log(`fixRoomSubscriptions: ${who.identity} should subscribe to ${subscribeTrackSids} but not to ${unsubscribeTrackSids}`);
    await roomService.updateSubscriptions(roomName, who.identity, subscribeTrackSids, true);
    await roomService.updateSubscriptions(roomName, who.identity, unsubscribeTrackSids, false);
  }
}

export async function fixSubscriptionsFor(roomName) {
  await fixRoomSubscriptions(roomName);
}


// on participant admitted: give them subscriptions, take their effect subscriptions

/*
  Current updateSubscription calls:
  - participant admitted
  - retrieve connection details (invites.js)  --- can be removed?
  - effect started, effect stopped



  Expected subscriptions:
  -----------------------
  Participant         Tracks owned by         Should subscribe?
  waiting room        *                       false
  normal              effect (minus self)     true
  normal              waiting room            false
  egress-participant  specific participant    true
  egress-composite    effect                  true
  admin               waiting room            true
  admin               normal                  eventually yes, but not needed right now
  admin               effect                  true
  effect              specific participant    true
*/

function isSubscriberParticipant(participantInfo, sourceIdentity) {
  const identity = participantInfo?.identity || participantInfo;
  if (!identity) return false;
  if (identity === sourceIdentity) return false;
  if (identity.startsWith("fx_")) return false;
  if (identity.startsWith("EG_")) {
    const mode = parseEgressMode(participantInfo);
    if (mode === "individual") return false;
    if (mode === "composite") return true;
    return false;
  }
  return true;
}

function parseEgressMode(participantInfo) {
  if (!participantInfo) return null;
  const attrs = participantInfo.attributes || {};
  if (attrs.egressMode) return String(attrs.egressMode);
  const metadata = participantInfo.metadata;
  if (typeof metadata === "string") {
    const match = metadata.match(/(?:^|;)\s*egressMode=([a-z]+)/i);
    if (match) return match[1].toLowerCase();
  }
  return null;
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
  fixRoomSubscriptions(roomName);
  return;

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

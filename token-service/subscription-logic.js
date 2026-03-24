/*
This file centralizes the logic for which participant should subscribe to which tracks.

  Subscriptions are updated on:
  - participant joined --- this can maybe be removed? Assuming admin page will still work
  - participant admitted
  - retrieve connection details (invites.js)  --- this can maybe be removed?
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

import { log } from "./utils.js";
import { roomService } from "./livekit-api.js";
import { identitySessions } from "./identity-sessions.js";

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
  // Sometimes your attribute might not have been set properly as 'pending', so default to waiting if you're not admitted.
  return participant.identity.startsWith("p_") && !isAdmittedParticipant(participant);
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
  console.warn(`Unable to determine subscriptions for participant: ${who.identity} for trackOwner ${trackOwner.identity}`);
  return false;
}

export async function fixRoomSubscriptions(roomName) {
  const participantInfos = await roomService.listParticipants(roomName);
  await logAllTracks(roomName);
  log(`fixRoomSubscriptions ${roomName}`);
  for (let who of participantInfos) {
    if (isEgressParticipant(who)) {
      log(`fixRoomSubscriptions: Skipping ${who.identity}`);
      continue;
    }
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
    log(`fixRoomSubscriptions: ${who.identity} (${who.name}) should subscribe to ${subscribeTrackSids}`);
    log(`fixRoomSubscriptions: ${who.identity} (${who.name}) should unsubscribe from ${unsubscribeTrackSids}`);
    await roomService.updateSubscriptions(roomName, who.identity, subscribeTrackSids, true);
    await roomService.updateSubscriptions(roomName, who.identity, unsubscribeTrackSids, false);
  }
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

async function logAllTracks(roomName) {
  log("LOGALLTRACKS");
  const participantInfos = await roomService.listParticipants(roomName);
  for (let p of participantInfos) {
    log(`Participant ${p.identity} (${p.name}):`);
    log(`- Attributes: ${JSON.stringify(p.attributes)}`);
    log(`- Kind: ${p.kind}`);
    log(`- Track ids: ${p.tracks.map((tr) => `${tr.sid} ${tr.type} ${tr.name}`)}`);
    log(`- Permissions: ${JSON.stringify(p.permission)}`);
  }
}

export async function syncAdmittedSubscriptions(roomName) {
  fixRoomSubscriptions(roomName);
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

// Track participant identities issued per invite so we can clean up effect tracks on leave.
export const identitySessions = new Map(); // identity -> { inviteId, room, name, showSelf, admissionStatus }

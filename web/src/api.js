export async function getConnectionDetails({ inviteId, key, name, identity }) {
  const r = await fetch("/api/connection-details", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ inviteId, key, name, identity }),
  });

  if (!r.ok) {
    const t = await r.text().catch(() => "");
    throw new Error(`connection-details failed: ${r.status} ${t}`);
  }
  return r.json();
}

export async function leaveSession({ inviteId, key, identity }) {
  const r = await fetch("/api/leave", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ inviteId, key, identity }),
  });

  if (!r.ok) {
    const t = await r.text().catch(() => "");
    throw new Error(`leave failed: ${r.status} ${t}`);
  }
  return r.json();
}

export async function getConnectionDetails({ inviteId, key, name, identity }) {
  const r = await fetch("/api/connection-details", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ inviteId, key, name, identity }),
  });

  if (!r.ok) {
    let message = "";
    let code = "";
    try {
      const data = await r.json();
      message = data?.error || "";
      code = data?.error || "";
    } catch {
      message = await r.text().catch(() => "");
    }
    const err = new Error(`connection-details failed: ${r.status} ${message}`);
    err.status = r.status;
    err.code = code;
    throw err;
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

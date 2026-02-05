export async function getConnectionDetails({ inviteId, key, name }) {
  const r = await fetch("/api/connection-details", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ inviteId, key, name }),
  });

  if (!r.ok) {
    const t = await r.text().catch(() => "");
    throw new Error(`connection-details failed: ${r.status} ${t}`);
  }
  return r.json();
}

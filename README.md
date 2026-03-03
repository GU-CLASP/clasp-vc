## Clasp Video Conference App

This is a self-hosted video conferencing app for research use. It uses [LiveKit](https://github.com/livekit/livekit) for real-time media, a small token service for invites and admin operations, and a web UI for participants and admins.

Key features:
- Invite participants with links.
- Adjust stream delay per participant for research protocols.
- Record both a composite (grid) view and individual participant tracks. The composite recording reflects the configured delay, while individual recordings do not.

### Prerequisites

- [podman](https://podman.io/docs/installation)
- `podman-compose` (the `./clasp-vc` script invokes `podman-compose`)

### Environment Variables

The most important variables in `.env`:

- `PUBLIC_BASE_URL`: Public URL where users access the web app (used for admin/invite links).
- `ADMIN_KEY`: Admin auth key for admin APIs/UI.
- `LIVEKIT_URL`: Client-facing LiveKit URL (returned to browser clients), often `wss://...` in production.
- `LIVEKIT_URL_INTERNAL`: Backend-to-LiveKit URL for token-service/delay-service, commonly `ws://127.0.0.1:7880` or a private host.
- `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET`, `LIVEKIT_KEYS`: LiveKit server credentials.
- `VITE_BASE_PATH`: Base path for web UI routing (default `/`).
- `VITE_ALLOWED_HOSTS`: Allowed hostnames for Vite dev server (comma-separated, or `all`).

### Development (Localhost)

1. Copy `.env.example` to `.env` and set at least `ADMIN_KEY` and `PUBLIC_BASE_URL`.
2. For local development, use localhost values like:
   `PUBLIC_BASE_URL=http://127.0.0.1:5173`
   `LIVEKIT_URL=ws://127.0.0.1:7880`
   `LIVEKIT_URL_INTERNAL=ws://127.0.0.1:7880`
3. Start the stack: `./clasp-vc up`
4. To check status and links: `./clasp-vc status`
5. Stop everything: `./clasp-vc down`

Notes:
- `./clasp-vc up` prints the admin link and invite link, and also stores the invite link in `.invite-link` while the app is running.
- Admin UI is at `/admin?adminKey=YOUR_ADMIN_KEY` on `PUBLIC_BASE_URL`.

### Production (Firewall + Web Server / Proxy)

1. Set production values in `.env`, including:
   `PUBLIC_BASE_URL=https://your-domain.example`
   `LIVEKIT_URL=wss://your-domain.example/livekit` (or a dedicated LiveKit host)
   `LIVEKIT_URL_INTERNAL=ws://127.0.0.1:7880` (or a private LiveKit address)
2. Put a web server / reverse proxy in front of the app.
   Recommended: serve the web UI and proxy `/api/*` to the token service.
3. Open firewall ports required by LiveKit from `livekit.yaml`:
   `7880` (HTTP/WebSocket), `7881` (TCP), `7882` (UDP), and the UDP port range `51000-51100`.
4. Prefer exposing only the proxy ports (80/443) to the public internet; keep internal services bound to localhost or a private network.
5. If you serve under a subpath (for example `/videochat/`), set:
   `VITE_BASE_PATH=/videochat/`
   `VITE_ALLOWED_HOSTS=your-domain.example`
6. Start the stack with `./clasp-vc up` and verify `./clasp-vc status`.

Production note:
- Current `compose.yml` runs `npm install` and a Vite dev server for `web`. For hardened production, prefer prebuilt static assets behind nginx/caddy and pinned images/dependencies.

### Joining a meeting

Users join with the invite link. Each user gets a unique identity/session.
That session ends when the user leaves or when an admin removes the participant.

If a user loses connectivity the session remains and can only be removed manually
by either the user or the admin.

### Recording

The admin can record participants in two modes, with separate output files:

1. Composite auto-grid view: reflects the group with applied effects (such as delay).
2. Individual participant tracks: no applied effects, effectively real-time self stream.

The recorded files are stored in `./data/recordings`.

### Operational Notes / Troubleshooting

- Health check endpoint: `http://127.0.0.1:9000/api/healthz`
- Invite link file: `.invite-link` (written by `./clasp-vc up`)
- If startup times out or services seem down, inspect logs:
  `podman-compose logs -f token-service web delay-service livekit egress`

### Example Nginx Config

This example proxies the web UI under `/videochat/`, `/api/*`, and LiveKit under `/livekit/` on the same domain.
Replace hostname and TLS paths as needed.

For this layout, set:
- `PUBLIC_BASE_URL=https://DOMAIN.COM/videochat`
- `LIVEKIT_URL=wss://DOMAIN.COM/livekit`
- `LIVEKIT_URL_INTERNAL=ws://127.0.0.1:7880`
- `VITE_BASE_PATH=/videochat/`
- `VITE_ALLOWED_HOSTS=DOMAIN.COM`

```nginx
map $http_upgrade $connection_upgrade {
  default upgrade;
  ''      close;
}

server {
  listen 80;
  server_name DOMAIN.COM;
  return 301 https://$host$request_uri;
}

server {
  listen 443 ssl http2;
  server_name DOMAIN.COM;

  ssl_certificate     /path/to/cert;
  ssl_certificate_key /path/to/private_key;

  # Web app (Vite dev server or built app behind it)
  # location can also be just '/'
  location /videochat/ {
    proxy_pass http://127.0.0.1:5173;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection $connection_upgrade;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
  }

  # Token service API for clasp vc
  location /api/ {
    proxy_pass http://127.0.0.1:9000;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
  }

  # LiveKit (WebSocket) (clasp vc)
  location = /livekit {
    return 301 /livekit/;
  }

  location /livekit/ {
    proxy_pass http://127.0.0.1:7880/;  # trailing slash
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection $connection_upgrade;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
  }
}
```

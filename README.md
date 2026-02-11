## Clasp Video Conference App

This is a self-hosted video conferencing app for research use. It uses [LiveKit](https://github.com/livekit/livekit) for real-time media, a small token service for invites and admin operations, and a web UI for participants and admins.

Key features:
- Invite participants with links.
- Adjust stream delay per participant for research protocols.
- Record both a composite (grid) view and individual participant tracks. The composite recording reflects the configured delay, while individual recordings do not.

### Recording

The admin can record participants. Recordings are done in two separate views and stored to separate files.

1. Composite/auto-grid view, which reflects the whole group of participants and how they experience each other after having applied various effects (such as delay)
2. Individual tracks where no effects or adjustments are applied. This is how the participants experience themselves - in realtime.

The recorded files are stored in `./data/recordings`.

### Development (Localhost)

*You need to have [podman](https://podman.io/docs/installation) installed in order to use the script 'clasp-vc'*

1. Copy `.env.example` to `.env` and set at least `ADMIN_KEY` and `PUBLIC_BASE_URL`.
2. For local development, use localhost values like:
   `PUBLIC_BASE_URL=http://127.0.0.1:5173`
   `LIVEKIT_URL=ws://127.0.0.1:7880`
3. Start the stack: `./clasp-vc up`
4. To check status and links: `./clasp-vc status`
5. Stop everything: `./clasp-vc down`

Notes:
- `./clasp-vc up` prints the admin link and invite link, and also stores the invite link in `.invite-link` while the app is running.
- Admin UI is at `/admin?adminKey=YOUR_ADMIN_KEY` on `PUBLIC_BASE_URL`.

### Production (Firewall + Web Server / Proxy)

1. Set production values in `.env`, including:
   `PUBLIC_BASE_URL=https://your-domain.example`
   `LIVEKIT_URL=wss://your-domain.example` (or a dedicated LiveKit host)
2. Put a web server / reverse proxy in front of the app.
   Recommended: serve the web UI and proxy `/api/*` to the token service.
3. Open firewall ports required by LiveKit from `livekit.yaml`:
   `7880` (HTTP/WebSocket), `7881` (TCP), `7882` (UDP), and the UDP port range `51000-51100`.
4. Prefer exposing only the proxy ports (80/443) to the public internet; keep internal services bound to localhost or a private network.
5. Start the stack with `./clasp-vc up` and verify `./clasp-vc status`.

### Example Nginx Config

This example proxies the web UI under `/videochat/`, `/api/*`, and LiveKit under `/livekit/` on the same domain. Replace the hostname and TLS paths as needed. For this layout, set `PUBLIC_BASE_URL=https://DOMAIN.COM/videochat` and `LIVEKIT_URL=wss://DOMAIN.COM/livekit`.

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

# Demolition

A local workspace for cataloguing music demos, assembling project tracklists, and collecting album references.

## Local storage

Demolition does not require external hosting or cloud storage.

- Project and demo metadata is stored in `data/demolition.sqlite` during local development.
- Imported audio copies are stored in `data/audio/`.
- Imported moodboard files are stored in `data/media/`.
- The entire `data/` directory is excluded from Git.
- Imported source files are read-only inputs. Demolition works with its own copies.

The Docker deployment keeps SQLite in the local path configured by `DEMOLITION_DATABASE_DIR`; `DEMOLITION_DATA_DIR` can point to separate bulk storage for audio and moodboard files.

When upgrading from the earlier browser-storage version, existing browser metadata and files are copied into the local backend automatically on first load. The old browser data is retained as a fallback.

## Requirements

- Node.js 22.13 or newer

## Commands

```bash
npm install
npm run dev
```

`npm run dev` starts both the interface at `http://localhost:3000` and the loopback-only SQLite service at `127.0.0.1:3001`. If port 3001 is already in use, the launcher automatically selects the next available API port and passes it to the interface.

## Trusted LAN access

To use the full workspace from another device on the same trusted Wi-Fi/LAN, opt in to LAN bindings:

```bash
DEMOLITION_UI_HOST=0.0.0.0 \
DEMOLITION_API_HOST=0.0.0.0 \
DEMOLITION_ALLOW_LAN=true \
npm run dev
```

Find this machine's LAN address with `ipconfig getifaddr en0` on macOS (or `hostname -I` on Linux), then open `http://<LAN-IP>:3000` on the other device. Use the same environment variables with `npm run start` after `npm run build` for a production-style run. `DEMOLITION_ALLOW_LAN=true` permits owner API access from private LAN addresses, so only enable it on a trusted network and never forward these ports to the internet.

## Mesh VPN sync

Every installation owns its SQLite database, managed audio copies, identity, and signing key. To make the peer API reachable through a mesh VPN, bind it to that machine's stable VPN address:

```bash
DEMOLITION_API_HOST=0.0.0.0 npm run start
```

Then enter the machine's VPN address, such as `http://100.64.0.10:3001`, under **Friends & sync**. Each friend must do the same on their own installation.

Pairing uses a single-use invitation that expires after 24 hours. The normal library and file-management endpoints remain loopback-only even when the peer API is exposed. Demo metadata and managed audio are shared only when explicitly enabled for a paired friend. Original source folders are never exposed.

Tracks can be shared individually from their detail panel, or an entire project can be shared from Project settings. Project sharing automatically includes demos added to that project later. Ratings and timed notes retain the identity that created them, and edited signed events are updated on the next sync. Use **Sync all** under **Friends & sync** to exchange changes with every reachable peer. Removing a share stops future access and updates; copies already received by a friend remain on their instance until they remove them.

Friend ratings and timed notes are collected in **Friend feedback**. The inbox records when feedback first reaches the local instance, shows an unread count, supports rating/note filters and search, and links each item back to its demo. Opening the inbox saves its read position in SQLite.

## Phone remote

While Listen mode is open on the computer, choose **Phone remote** and scan the QR code. The phone opens a compact controller for play/pause, seeking, previous/next, skip, and thumbs-up/down scoring. Audio continues to play from the computer.

The URL encoded in the QR code must be reachable from the phone. When using the home-server deployment, use the normal Demolition domain. For direct local development, start Demolition with trusted LAN access and replace `localhost` in the pairing panel with the computer's LAN address. Remote sessions and queued commands are stored in SQLite, remain inside the Demolition instance, and expire after eight hours.

For a production-style local run:

```bash
npm run build
npm run start
```

Validation:

```bash
npm run lint
npm test
```

## Self-host with Docker

Demolition runs from the published container image. A server only needs `docker-compose.yml` and `.env`; cloning this repository is not required. Reverse proxies and custom Docker networks are deliberately outside the supplied Compose file.

### Requirements

- A Linux server with Docker Engine and the Docker Compose plugin.
- OpenSSL for generating a proxy token.
- Access to `ghcr.io/joshtrim/demolition` (run `docker login ghcr.io` first if the package is private).

The SQLite database must live on a local Linux filesystem. Audio and moodboard media may live on larger attached or network storage.

### 1. Create the two deployment files

Create a directory and save [docker-compose.yml](docker-compose.yml) and [.env.example](.env.example) into it. Rename `.env.example` to `.env`:

```bash
mkdir -p demolition
cd demolition
# Save docker-compose.yml here, then save .env.example as .env.
```

These are the only application files required on the server.

### 2. Prepare storage

The defaults below keep SQLite on local storage and managed media under `/srv`:

```bash
sudo mkdir -p /var/lib/demolition/database /srv/demolition/data
sudo chown -R "$(id -u):$(id -g)" /var/lib/demolition /srv/demolition
```

### 3. Configure Demolition

```bash
openssl rand -hex 32
```

Copy the generated token into `.env`, then set each value for your server:

```dotenv
DEMOLITION_IMAGE=ghcr.io/joshtrim/demolition:0.1.1
DEMOLITION_BIND_ADDRESS=127.0.0.1
DEMOLITION_ALLOW_LAN=false
DEMOLITION_UI_PORT=5030
DEMOLITION_API_PORT=5031
DEMOLITION_DATA_DIR=/srv/demolition/data
DEMOLITION_DATABASE_DIR=/var/lib/demolition/database
DEMOLITION_PROXY_TOKEN=PASTE_THE_GENERATED_TOKEN
DEMOLITION_UID=1000
DEMOLITION_GID=1000
TZ=UTC
```

- `DEMOLITION_IMAGE` selects the release to run. Pin a numbered version for predictable updates.
- `DEMOLITION_BIND_ADDRESS` controls which host interface receives both ports. Keep `127.0.0.1` for a host-native proxy, or use a specific LAN/VPN address when direct access is required. Avoid `0.0.0.0` unless the host firewall restricts access.
- `DEMOLITION_ALLOW_LAN=true` permits owner API requests directly from private LAN addresses. Leave it `false` when using the authenticated reverse proxy.
- `DEMOLITION_UI_PORT` and `DEMOLITION_API_PORT` select the host ports.
- `DEMOLITION_DATA_DIR` stores managed audio and moodboard files.
- `DEMOLITION_DATABASE_DIR` stores SQLite, the local identity, and signing keys. Do not place it on NFS, SMB, or CIFS.
- `DEMOLITION_UID` and `DEMOLITION_GID` must match the numeric owner of both storage directories. Check them with `stat -c '%u %g' PATH`.
- `DEMOLITION_PROXY_TOKEN` authorizes owner API requests arriving through the reverse proxy. Keep it out of Git and browser-visible configuration.

### 4. Start the container

```bash
docker compose pull
docker compose up -d
docker compose ps
docker compose logs --tail=100 demolition
```

Compose reads `.env` automatically and pulls the prebuilt image. No source tree or local image build is involved.

### 5. Configure the reverse proxy

Browser traffic must send `/api/*` to the configured API host port and all other paths to the configured UI host port. For Caddy running directly on the host:

```caddyfile
demolition.example.com {
	@api path /api /api/*
	reverse_proxy @api 127.0.0.1:5031 {
		header_up X-Demolition-Proxy-Token {$DEMOLITION_PROXY_TOKEN}
	}

	reverse_proxy 127.0.0.1:5030
}
```

Make the same `DEMOLITION_PROXY_TOKEN` value available in Caddy's environment, then reload Caddy. If the proxy runs in a container, add whatever Docker network or host routing your proxy stack uses; Demolition does not create or join one automatically.

Do not expose either owner port directly to the internet.

### 6. Verify the installation

```bash
set -a
. ./.env
set +a
curl -fsS "http://127.0.0.1:${DEMOLITION_API_PORT}/api/health"
```

The health request should return JSON containing `"ok":true`. Then open the configured reverse-proxy hostname and confirm that the library loads, imports persist after a container restart, and Listen mode can play a managed audio copy.

### Updates

Back up the instance, change `DEMOLITION_IMAGE` in `.env` to the desired release, then pull and recreate the container:

```bash
docker compose pull
docker compose up -d
```

### Backups and migration

Back up both `DEMOLITION_DATABASE_DIR` and `DEMOLITION_DATA_DIR`. The database contains catalogue metadata, ratings, account identity, and signing keys; the data directory contains Demolition's managed media copies. A backup stored only on the same disk does not protect against disk failure.

See [docs/debian-server.md](docs/debian-server.md) for Debian preparation, migrating an existing library, firewall and WireGuard guidance, backups, and migration verification.

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

The included Compose deployment builds Demolition locally and runs the interface and SQLite API in one container. It is intended to sit behind an existing reverse proxy and WireGuard network. Nothing in this setup requires a managed hosting service or router port forwarding.

### Requirements

- A Linux server with Docker Engine and the Docker Compose plugin.
- Git, OpenSSL, cURL, and rsync.
- An existing WireGuard interface and a stable address assigned to the server.
- A reverse proxy, either in Docker or running directly on the host.
- Git access to this repository.

The SQLite database must live on a local Linux filesystem. Audio and moodboard media may live on larger attached or network storage.

### 1. Clone the repository

```bash
git clone https://github.com/JoshTrim/demolition.git
cd demolition
```

If the repository is private, authenticate with GitHub first or use its SSH clone URL.

### 2. Prepare storage and the proxy network

The defaults below keep SQLite on local storage and managed media under `/srv`:

```bash
sudo mkdir -p /var/lib/demolition/database /srv/demolition/data
sudo chown -R "$(id -u):$(id -g)" /var/lib/demolition /srv/demolition
docker network create demolition-proxy
```

If your reverse proxy already uses an external Docker network, do not create another one. Use the existing network name for `DEMOLITION_PROXY_NETWORK` instead, and attach the Demolition service and proxy to that same network.

### 3. Configure Demolition

```bash
cp .env.example .env
openssl rand -hex 32
```

Copy the generated token into `.env`, then set each value for your server:

```dotenv
DEMOLITION_WIREGUARD_IP=10.8.0.2
DEMOLITION_UI_PORT=5030
DEMOLITION_API_PORT=5031
DEMOLITION_PROXY_NETWORK=demolition-proxy
DEMOLITION_DATA_DIR=/srv/demolition/data
DEMOLITION_DATABASE_DIR=/var/lib/demolition/database
DEMOLITION_PROXY_TOKEN=PASTE_THE_GENERATED_TOKEN
DEMOLITION_UID=1000
DEMOLITION_GID=1000
TZ=Australia/Brisbane
```

- `DEMOLITION_WIREGUARD_IP` must be an address already assigned to this server.
- `DEMOLITION_UI_PORT` and `DEMOLITION_API_PORT` are loopback ports used by a host-native reverse proxy and local diagnostics.
- `DEMOLITION_PROXY_NETWORK` must match the external Docker network used by a containerized reverse proxy.
- `DEMOLITION_DATA_DIR` stores managed audio and moodboard files.
- `DEMOLITION_DATABASE_DIR` stores SQLite, the local identity, and signing keys. Do not place it on NFS, SMB, or CIFS.
- `DEMOLITION_UID` and `DEMOLITION_GID` must match the numeric owner of both storage directories. Check them with `stat -c '%u %g' PATH`.
- `DEMOLITION_PROXY_TOKEN` authorizes owner API requests arriving through the reverse proxy. Keep it out of Git and browser-visible configuration.

### 4. Start the container

```bash
docker compose up -d --build
docker compose ps
docker compose logs --tail=100 demolition
```

Compose reads `.env` automatically. The first command builds the image from the checked-out source and starts it with `restart: unless-stopped`.

### 5. Configure the reverse proxy

Browser traffic must send `/api/*` to the API port and all other paths to the interface. A containerized proxy should use the internal service ports, not the host ports from `.env`.

For Caddy running on the same external Docker network:

```caddyfile
demolition.example.com {
	@api path /api /api/*
	reverse_proxy @api demolition:3001 {
		header_up X-Demolition-Proxy-Token {$DEMOLITION_PROXY_TOKEN}
	}

	reverse_proxy demolition:3000
}
```

Make the same `DEMOLITION_PROXY_TOKEN` value available in Caddy's environment, attach Caddy to `DEMOLITION_PROXY_NETWORK`, then reload Caddy. If the proxy runs directly on the host, route to `127.0.0.1:DEMOLITION_API_PORT` and `127.0.0.1:DEMOLITION_UI_PORT` instead.

Do not expose either owner port directly to the internet. The API is separately bound to the WireGuard address for authenticated peer syncing.

### 6. Verify the installation

```bash
set -a
. ./.env
set +a
curl -fsS "http://127.0.0.1:${DEMOLITION_API_PORT}/api/health"
```

The health request should return JSON containing `"ok":true`. Then open the configured reverse-proxy hostname and confirm that the library loads, imports persist after a container restart, and Listen mode can play a managed audio copy.

### Updates

Back up the instance before updating, then rebuild from the latest source:

```bash
./scripts/server-backup.sh /srv/demolition/backups
git pull --ff-only
docker compose up -d --build
```

### Backups and migration

Back up both `DEMOLITION_DATABASE_DIR` and `DEMOLITION_DATA_DIR`. The database contains catalogue metadata, ratings, account identity, and signing keys; the data directory contains Demolition's managed media copies. A backup stored only on the same disk does not protect against disk failure.

See [docs/debian-server.md](docs/debian-server.md) for detailed Debian preparation, migrating an existing library, Caddy and firewall configuration, WireGuard peer sync, consistent backup and restore procedures, and migration verification.

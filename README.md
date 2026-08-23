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

## Debian home server

Demolition includes a Docker Compose deployment for a Debian server reached through WireGuard. It exposes loopback-only UI and API upstreams for your existing reverse proxy, while direct peer traffic remains restricted to authenticated `/api/peer/*` routes on the WireGuard address.

After copying `.env.example` to `.env`, start or update it with the standard Compose command:

```bash
docker compose up -d --build
```

See [docs/debian-server.md](docs/debian-server.md) for migration, reverse-proxy, firewall, backup, restore, and update instructions. Nothing in this deployment requires public hosting or router port forwarding.

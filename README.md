# Demolition

A local workspace for cataloguing music demos, assembling project tracklists, and collecting album references.

## Local storage

Demolition does not require external hosting or cloud storage.

- Project and demo metadata is stored in `data/demolition.sqlite`.
- Imported audio copies are stored in `data/audio/`.
- Imported moodboard files are stored in `data/media/`.
- The entire `data/` directory is excluded from Git.
- Imported source files are read-only inputs. Demolition works with its own copies.

When upgrading from the earlier browser-storage version, existing browser metadata and files are copied into the local backend automatically on first load. The old browser data is retained as a fallback.

## Requirements

- Node.js 22.13 or newer

## Commands

```bash
npm install
npm run dev
```

`npm run dev` starts both the interface at `http://localhost:3000` and the loopback-only SQLite service at `127.0.0.1:3001`.

## Mesh VPN sync

Every installation owns its SQLite database, managed audio copies, identity, and signing key. To make the peer API reachable through a mesh VPN, bind it to that machine's stable VPN address:

```bash
DEMOLITION_API_HOST=0.0.0.0 npm run start
```

Then enter the machine's VPN address, such as `http://100.64.0.10:3001`, under **Friends & sync**. Each friend must do the same on their own installation.

Pairing uses a single-use invitation that expires after 24 hours. The normal library and file-management endpoints remain loopback-only even when the peer API is exposed. Demo metadata and managed audio are shared only when explicitly enabled for a paired friend. Original source folders are never exposed.

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

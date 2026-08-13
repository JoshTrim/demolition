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

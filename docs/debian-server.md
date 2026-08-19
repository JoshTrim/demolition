# Debian home-server deployment

This deployment keeps Demolition private behind an existing WireGuard network. It does not require Tailscale or any public port forwarding.

## Architecture

- Demolition's interface is available to a host-managed reverse proxy at `127.0.0.1:DEMOLITION_UI_PORT`.
- Its API is available to the reverse proxy at `127.0.0.1:DEMOLITION_API_PORT`.
- `DEMOLITION_API_PORT` is also bound to the WireGuard address for authenticated peer sync.
- The normal owner API rejects remote requests that do not include the configured private proxy token.
- SQLite, the owner identity, and signing keys live in the local `DEMOLITION_DATABASE_DIR`.
- Managed audio and moodboard media live in `DEMOLITION_DATA_DIR`, which may be a TrueNAS or other bulk-storage mount.

TLS, hostnames, and public or private ingress are managed outside this repository. Do not forward the configured UI or API ports from the internet-facing router.

## 1. Prepare Debian

Install Docker Engine with the Compose plugin using [Docker's official Debian instructions](https://docs.docker.com/engine/install/debian/). Also install `git` and `rsync`.

Confirm the WireGuard address:

```bash
ip -brief address show wg0
docker --version
docker compose version
```

## 2. Install the application source

```bash
sudo mkdir -p /opt/demolition /srv/demolition/data /var/lib/demolition/database /srv/demolition/backups
sudo chown -R "$USER":"$USER" /opt/demolition /srv/demolition /var/lib/demolition
gh repo clone JoshTrim/demolition /opt/demolition
cd /opt/demolition
cp .env.example .env
```

Create a proxy token:

```bash
openssl rand -hex 32
```

Edit `.env`:

```dotenv
DEMOLITION_WIREGUARD_IP=10.8.0.2
DEMOLITION_UI_PORT=3000
DEMOLITION_API_PORT=3001
DEMOLITION_DATA_DIR=/srv/demolition/data
DEMOLITION_DATABASE_DIR=/var/lib/demolition/database
DEMOLITION_PROXY_TOKEN=PASTE_THE_GENERATED_TOKEN
DEMOLITION_UID=1000
DEMOLITION_GID=1000
TZ=Australia/Brisbane
```

Use the numeric owner of the data and database directories for `DEMOLITION_UID` and `DEMOLITION_GID`:

```bash
stat -c '%u %g' /srv/demolition/data
stat -c '%u %g' /var/lib/demolition/database
findmnt -T /var/lib/demolition/database -o TARGET,SOURCE,FSTYPE,OPTIONS
```

The database directory must be on a local Linux filesystem, not NFS, SMB, or CIFS. Keep `.env` private; it is excluded from Git.

## 3. Transfer the existing library

The current library is approximately 7.4 GB. Transfer the complete legacy `data/` directory first so the database, audio, media, identity, signing key, and peer state arrive together.

On the Mac, stop the running Demolition process. Then, from the repository:

```bash
./scripts/transfer-data.sh YOUR_USER@WIREGUARD_SERVER_IP /srv/demolition/data
```

The transfer is resumable. Do not delete or modify the Mac copy yet.

On Debian, ensure the container user owns the transferred files:

```bash
sudo chown -R 1000:1000 /srv/demolition/data
```

Use the UID and GID configured in `.env` if they differ from `1000:1000`.

Before the first server start, copy the SQLite database and any WAL onto the local filesystem. Leave the original files on bulk storage until migration is verified, and do not copy the transient `demolition.sqlite-shm` file:

```bash
cd /opt/demolition
set -a
source .env
set +a
sudo mkdir -p "$DEMOLITION_DATABASE_DIR"
sudo cp -a "$DEMOLITION_DATA_DIR/demolition.sqlite" "$DEMOLITION_DATABASE_DIR/"
if [[ -f "$DEMOLITION_DATA_DIR/demolition.sqlite-wal" ]]; then
  sudo cp -a "$DEMOLITION_DATA_DIR/demolition.sqlite-wal" "$DEMOLITION_DATABASE_DIR/"
fi
sudo chown -R "$DEMOLITION_UID:$DEMOLITION_GID" "$DEMOLITION_DATABASE_DIR"
```

SQLite will rebuild its shared-memory file locally and recover committed WAL contents when Demolition starts.

## 4. Start Demolition

```bash
cd /opt/demolition
docker compose up -d --build
```

Docker Compose reads `.env` automatically, builds the image, and starts Demolition. Confirm the bindings on Debian:

```bash
ss -lnt
docker compose ps
```

Expected bindings are:

- `127.0.0.1:DEMOLITION_UI_PORT` for the browser interface.
- `127.0.0.1:DEMOLITION_API_PORT` for API requests from the host reverse proxy.
- `WIREGUARD_IP:DEMOLITION_API_PORT` for authenticated peer sync.

## 5. Connect your reverse proxy

Configure the reverse proxy you already manage with these upstream rules:

- Forward `/api/*` to `http://127.0.0.1:DEMOLITION_API_PORT` without stripping the `/api` prefix.
- Add `X-Demolition-Proxy-Token` to API requests, using the exact `DEMOLITION_PROXY_TOKEN` value from `.env`.
- Forward all other requests to `http://127.0.0.1:DEMOLITION_UI_PORT`.
- Preserve normal forwarding headers and WebSocket support.

The proxy token is what allows owner-level API requests through the reverse proxy. Do not expose it to browsers, commit it, or place it in a client-visible configuration file.

For example, the routing contract is:

```text
/api/*  -> 127.0.0.1:DEMOLITION_API_PORT + X-Demolition-Proxy-Token
/*      -> 127.0.0.1:DEMOLITION_UI_PORT
```

## 6. Configure WireGuard and firewall policy

Friend instances may reach `DEMOLITION_API_PORT` only over WireGuard; Demolition still requires pairing tokens and signed events on peer routes. Access to your separately managed reverse proxy is outside the Demolition Compose stack.

Keep these rules true regardless of whether Debian uses nftables, UFW, or another firewall manager:

- Allow `DEMOLITION_API_PORT` on `wg0` only from paired friend addresses when friend sync is needed.
- Keep `DEMOLITION_UI_PORT` loopback-only.
- Do not allow `DEMOLITION_API_PORT` from the LAN or internet-facing interface.
- Do not add router port forwarding.

After migration, set the instance's **Mesh VPN URL** under **Friends & sync** to the server's WireGuard URL and configured API port, for example `http://10.8.0.2:3001`.

## 7. Verify the migration

Before retiring the Mac instance:

1. Compare the demo, project, tag, rating, and timed-note counts.
2. Play several old and recent audio files.
3. Open moodboards and verify local media.
4. Run **Storage status → Verify all copies**.
5. Import a disposable audio file and then remove its managed copy.
6. Test pairing and syncing with one friend instance.
7. Create and restore a server backup in a maintenance window.

Keep the Mac copy offline and unchanged until these checks pass.

## Backups

Create a consistent snapshot. The script briefly stops Demolition and copies both the local database directory and bulk media directory into one snapshot:

```bash
cd /opt/demolition
./scripts/server-backup.sh /srv/demolition/backups
```

Restore a snapshot:

```bash
cd /opt/demolition
./scripts/server-restore.sh /srv/demolition/backups/20260818T030000Z
```

Restore requires typing `RESTORE` and moves the previous live data to a timestamped rollback directory instead of deleting it.

A basic daily cron entry is:

```cron
0 3 * * * cd /opt/demolition && ./scripts/server-backup.sh /srv/demolition/backups >> /var/log/demolition-backup.log 2>&1
```

Snapshots on the same disk do not protect against disk failure. Replicate `/srv/demolition/backups` to another disk or machine.

## Updates

```bash
cd /opt/demolition
git pull --ff-only
docker compose up -d --build
```

Run a backup before updating. Database upgrades happen when the application starts, so retain the pre-update snapshot for rollback.

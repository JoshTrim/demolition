# Debian home-server deployment

This deployment keeps Demolition private behind an existing WireGuard network. It does not require Tailscale or any public port forwarding.

## Architecture

- Caddy listens only on the Debian server's WireGuard address at port 443.
- Browser requests to `/` go to the Demolition interface.
- Browser requests to `/api/*` go to the SQLite API with a private proxy token added by Caddy.
- Port 3001 is bound only to the WireGuard address for authenticated peer sync.
- The normal owner API rejects direct remote requests that did not pass through Caddy.
- SQLite, managed audio, moodboard media, the owner identity, and signing keys live in `/srv/demolition/data`.

Do not forward ports 443, 3000, or 3001 from the internet-facing router.

## 1. Prepare Debian

Install Docker Engine with the Compose plugin using [Docker's official Debian instructions](https://docs.docker.com/engine/install/debian/). Also install `git` and `rsync`.

Confirm the WireGuard address:

```bash
ip -brief address show wg0
docker --version
docker compose version
```

Choose a private hostname such as `demolition.home.arpa`. Add it to local DNS, or add an entry on each owner device that maps the hostname to the Debian server's WireGuard address.

## 2. Install the application source

```bash
sudo mkdir -p /opt/demolition /srv/demolition/data /srv/demolition/caddy-data /srv/demolition/backups
sudo chown -R "$USER":"$USER" /opt/demolition /srv/demolition
git clone YOUR_REPOSITORY_URL /opt/demolition
cd /opt/demolition
cp .env.server.example .env.server
```

Create a proxy token:

```bash
openssl rand -hex 32
```

Edit `.env.server`:

```dotenv
DEMOLITION_WIREGUARD_IP=10.8.0.2
DEMOLITION_HOSTNAME=demolition.home.arpa
DEMOLITION_DATA_DIR=/srv/demolition/data
DEMOLITION_CADDY_DATA_DIR=/srv/demolition/caddy-data
DEMOLITION_PROXY_TOKEN=PASTE_THE_GENERATED_TOKEN
DEMOLITION_UID=1000
DEMOLITION_GID=1000
TZ=Australia/Brisbane
```

Use the numeric owner of `/srv/demolition/data` for `DEMOLITION_UID` and `DEMOLITION_GID`:

```bash
stat -c '%u %g' /srv/demolition/data
```

Keep `.env.server` private. It is excluded from Git.

## 3. Transfer the existing library

The current library is approximately 7.4 GB. The complete `data/` directory must move together because it contains the database, audio, media, identity, signing key, and peer state.

On the Mac, stop the running Demolition process. Then, from the repository:

```bash
./scripts/transfer-data.sh YOUR_USER@WIREGUARD_SERVER_IP /srv/demolition/data
```

The transfer is resumable. Do not delete or modify the Mac copy yet.

On Debian, ensure the container user owns the transferred files:

```bash
sudo chown -R 1000:1000 /srv/demolition/data
```

Use the UID and GID configured in `.env.server` if they differ from `1000:1000`.

## 4. Start Demolition

```bash
cd /opt/demolition
./scripts/server-up.sh
```

The script validates the environment, builds the image, starts both services, and shows their health. Open:

```text
https://demolition.home.arpa
```

The services bind only to the configured WireGuard address. Confirm this on Debian:

```bash
ss -lnt | grep -E ':(443|3001)\b'
docker compose --env-file .env.server ps
```

## 5. Trust Caddy's private certificate

Caddy uses a persistent internal certificate authority because the hostname is private. Export its root certificate:

```bash
cd /opt/demolition
docker compose --env-file .env.server cp caddy:/data/caddy/pki/authorities/local/root.crt ./demolition-root.crt
```

Install `demolition-root.crt` as a trusted root certificate on each owner device. Do not distribute the CA private key from `/srv/demolition/caddy-data`.

## 6. Configure WireGuard and firewall policy

Only owner devices should reach the Caddy address on TCP 443. Friend instances may later reach TCP 3001, but only over WireGuard; Demolition still requires pairing tokens and signed events on peer routes.

Keep these rules true regardless of whether Debian uses nftables, UFW, or another firewall manager:

- Allow TCP 443 on `wg0` from owner WireGuard addresses.
- Allow TCP 3001 on `wg0` only from paired friend addresses when friend sync is needed.
- Do not allow TCP 3000 from any external interface.
- Do not allow TCP 3001 from the LAN or internet-facing interface.
- Do not add router port forwarding.

After migration, set the instance's **Mesh VPN URL** under **Friends & sync** to the server's WireGuard URL, for example `http://10.8.0.2:3001`.

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

Create a consistent snapshot. The script briefly stops both containers so SQLite, its WAL, audio, and the Caddy certificate authority are copied together:

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
0 3 * * * cd /opt/demolition && DEMOLITION_ENV_FILE=/opt/demolition/.env.server ./scripts/server-backup.sh /srv/demolition/backups >> /var/log/demolition-backup.log 2>&1
```

Snapshots on the same disk do not protect against disk failure. Replicate `/srv/demolition/backups` to another disk or machine.

## Updates

```bash
cd /opt/demolition
git pull --ff-only
./scripts/server-up.sh
```

Run a backup before updating. Database upgrades happen when the application starts, so retain the pre-update snapshot for rollback.

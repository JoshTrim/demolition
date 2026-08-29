# Debian home-server deployment

This deployment runs the published Demolition image with two local files: `docker-compose.yml` and `.env`. It does not clone or build the source repository, create a proxy network, install Caddy, or configure WireGuard.

## Architecture

- The interface and API are published on the host address and ports selected in `.env`.
- A host-native reverse proxy can use loopback bindings. Containerized proxies can use host routing or a Docker network added by the operator.
- SQLite, the owner identity, and signing keys live in `DEMOLITION_DATABASE_DIR` on a local Linux filesystem.
- Managed audio and moodboard media live in `DEMOLITION_DATA_DIR`, which may be an attached or network-storage mount.
- TLS, hostnames, VPN access, firewall policy, and ingress are managed outside Demolition.

Do not forward the UI or API ports directly from an internet-facing router.

## 1. Prepare Debian

Install Docker Engine with the Compose plugin using [Docker's official Debian instructions](https://docs.docker.com/engine/install/debian/). Confirm the installation:

```bash
docker --version
docker compose version
```

If the GHCR package is private, authenticate using a GitHub personal access token with `read:packages`:

```bash
docker login ghcr.io
```

## 2. Install the deployment files

Create a deployment directory and place the repository's `docker-compose.yml` and `.env.example` files in it. Save `.env.example` as `.env`:

```bash
sudo mkdir -p /opt/demolition /srv/demolition/data /var/lib/demolition/database
sudo chown -R "$USER":"$USER" /opt/demolition /srv/demolition /var/lib/demolition
cd /opt/demolition
# Save docker-compose.yml and .env here.
```

No other repository files are required.

Generate a proxy token:

```bash
openssl rand -hex 32
```

Edit `.env`:

```dotenv
DEMOLITION_IMAGE=ghcr.io/joshtrim/demolition:0.1.3
DEMOLITION_BIND_ADDRESS=127.0.0.1
DEMOLITION_ALLOW_LAN=false
DEMOLITION_UI_PORT=3000
DEMOLITION_API_PORT=3001
DEMOLITION_DATA_DIR=/srv/demolition/data
DEMOLITION_DATABASE_DIR=/var/lib/demolition/database
DEMOLITION_PROXY_TOKEN=PASTE_THE_GENERATED_TOKEN
DEMOLITION_UID=1000
DEMOLITION_GID=1000
TZ=UTC
```

Use the numeric owner of the storage directories for `DEMOLITION_UID` and `DEMOLITION_GID`:

```bash
stat -c '%u %g' /srv/demolition/data
stat -c '%u %g' /var/lib/demolition/database
findmnt -T /var/lib/demolition/database -o TARGET,SOURCE,FSTYPE,OPTIONS
```

The database directory must be on a local Linux filesystem, not NFS, SMB, or CIFS. Keep `.env` private.

`DEMOLITION_BIND_ADDRESS=127.0.0.1` is suitable for a reverse proxy running on the host. Use the server's LAN or VPN address for direct access over that interface. Set `DEMOLITION_ALLOW_LAN=true` only when trusted LAN clients need owner API access directly. Only use `0.0.0.0` when the host firewall reliably limits both ports.

## 3. Transfer an existing library

Stop the old Demolition instance before copying it. Transfer its managed data directory to the configured server data directory with a resumable tool such as `rsync`:

```bash
rsync -a --info=progress2 /path/to/old/data/ YOUR_USER@SERVER:/srv/demolition/data/
```

Copy the SQLite database and any WAL file to the local database directory. Do not copy `demolition.sqlite-shm`:

```bash
sudo cp -a /srv/demolition/data/demolition.sqlite /var/lib/demolition/database/
if [ -f /srv/demolition/data/demolition.sqlite-wal ]; then
  sudo cp -a /srv/demolition/data/demolition.sqlite-wal /var/lib/demolition/database/
fi
sudo chown -R 1000:1000 /srv/demolition/data /var/lib/demolition/database
```

Replace `1000:1000` with the UID and GID configured in `.env`. Keep the old instance offline and unchanged until the migration has been verified.

## 4. Start Demolition

```bash
cd /opt/demolition
docker compose pull
docker compose up -d
docker compose ps
docker compose logs --tail=100 demolition
```

Compose reads `.env`, pulls the selected release, and starts Demolition. It does not build an image locally.

Verify the API health endpoint:

```bash
set -a
. ./.env
set +a
curl -fsS "http://${DEMOLITION_BIND_ADDRESS}:${DEMOLITION_API_PORT}/api/health"
```

## 5. Connect a reverse proxy

Browser traffic must route `/api/*` to the API host port and all other paths to the UI host port. A Caddy process running directly on the host can use:

```caddyfile
demolition.example.com {
	@api path /api /api/*
	reverse_proxy @api 127.0.0.1:3001 {
		header_up X-Demolition-Proxy-Token {$DEMOLITION_PROXY_TOKEN}
	}

	reverse_proxy 127.0.0.1:3000
}
```

The proxy token authorizes owner-level API requests through the proxy. Do not expose it to browsers or commit it.

For a proxy running in another container, choose the integration appropriate to that proxy stack. The operator can attach Demolition to an existing external network by extending `docker-compose.yml`; the supplied file intentionally has no custom network configuration.

## 6. WireGuard and firewall policy

To expose friend syncing through WireGuard, set `DEMOLITION_BIND_ADDRESS` to the server's WireGuard address or provide another operator-managed route to the API port. Demolition still requires pairing tokens and signed events on peer routes.

Keep these rules true regardless of whether Debian uses nftables, UFW, or another firewall manager:

- Permit the API port on the VPN interface only from intended peers.
- Keep the UI private unless direct VPN access is intentional.
- Do not allow either port from an internet-facing interface.
- Do not add router port forwarding.

Set the instance's **Mesh VPN URL** under **Friends & sync** to its reachable WireGuard URL and API port, for example `http://10.8.0.2:3001`.

## 7. Verify the migration

Before retiring the old instance:

1. Compare demo, project, tag, rating, and timed-note counts.
2. Play several old and recent audio files.
3. Open moodboards and verify local media.
4. Run **Storage status → Verify all copies**.
5. Import a disposable audio file and confirm it survives a container restart.
6. Test pairing and syncing with one friend instance.
7. Create and restore a server backup during a maintenance window.

## Backups

Stop the container briefly so SQLite and its media snapshot are consistent, then archive both configured directories:

```bash
cd /opt/demolition
docker compose stop demolition
sudo tar -C / -czf /srv/demolition-backup-$(date +%Y%m%dT%H%M%S).tar.gz \
  var/lib/demolition/database srv/demolition/data
docker compose start demolition
```

A backup on the same disk does not protect against disk failure. Replicate it to another disk or machine. Test restoration before relying on the backup procedure.

## Updates

Back up the instance, change `DEMOLITION_IMAGE` in `.env` to the desired release, then run:

```bash
cd /opt/demolition
docker compose pull
docker compose up -d
```

Database upgrades happen when the application starts, so retain the pre-update backup for rollback.

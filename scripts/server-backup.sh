#!/usr/bin/env bash
set -euo pipefail

repo_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
env_file=${DEMOLITION_ENV_FILE:-"$repo_dir/.env"}
backup_root=${1:-/srv/demolition/backups}

[[ -f "$env_file" ]] || { echo "Missing $env_file" >&2; exit 1; }
command -v docker >/dev/null || { echo "Docker is required." >&2; exit 1; }
command -v rsync >/dev/null || { echo "rsync is required." >&2; exit 1; }

set -a
source "$env_file"
set +a

data_dir=${DEMOLITION_DATA_DIR:-/srv/demolition/data}
database_dir=${DEMOLITION_DATABASE_DIR:-/var/lib/demolition/database}
stamp=$(date -u +%Y%m%dT%H%M%SZ)
mkdir -p "$backup_root"
backup_root=$(cd "$backup_root" && pwd)
snapshot="$backup_root/$stamp"

mkdir -p "$snapshot/data" "$snapshot/database"
cd "$repo_dir"

started=false
restart_services() {
  if [[ "$started" == false ]]; then
    docker compose --env-file "$env_file" start >/dev/null
    started=true
  fi
}
trap restart_services EXIT

docker compose --env-file "$env_file" stop
rsync -a --delete --exclude '/demolition.sqlite' --exclude '/demolition.sqlite-wal' --exclude '/demolition.sqlite-shm' "$data_dir/" "$snapshot/data/"
rsync -a --delete "$database_dir/" "$snapshot/database/"
date -u +%FT%TZ > "$snapshot/created-at.txt"
if command -v sha256sum >/dev/null && [[ -f "$snapshot/database/demolition.sqlite" ]]; then
  sha256sum "$snapshot/database/demolition.sqlite" > "$snapshot/demolition.sqlite.sha256"
fi
ln -sfn "$snapshot" "$backup_root/latest"
restart_services
trap - EXIT

echo "Backup created at $snapshot"

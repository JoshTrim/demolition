#!/usr/bin/env bash
set -euo pipefail

repo_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
env_file=${DEMOLITION_ENV_FILE:-"$repo_dir/.env"}
snapshot=${1:-}

[[ -n "$snapshot" && -d "$snapshot/data" && ( -d "$snapshot/database" || -f "$snapshot/data/demolition.sqlite" ) ]] || { echo "Usage: $0 /srv/demolition/backups/TIMESTAMP" >&2; exit 1; }
[[ -f "$env_file" ]] || { echo "Missing $env_file" >&2; exit 1; }
command -v docker >/dev/null || { echo "Docker is required." >&2; exit 1; }
command -v rsync >/dev/null || { echo "rsync is required." >&2; exit 1; }

set -a
source "$env_file"
set +a

data_dir=${DEMOLITION_DATA_DIR:-/srv/demolition/data}
database_dir=${DEMOLITION_DATABASE_DIR:-/var/lib/demolition/database}
uid=${DEMOLITION_UID:-1000}
gid=${DEMOLITION_GID:-1000}
rollback_root="${data_dir%/}-before-restore-$(date -u +%Y%m%dT%H%M%SZ)"
database_rollback_root="${database_dir%/}-before-restore-$(date -u +%Y%m%dT%H%M%SZ)"

read -r -p "Restore $snapshot and replace the active server data? Type RESTORE: " confirmation
[[ "$confirmation" == "RESTORE" ]] || { echo "Restore cancelled."; exit 1; }

cd "$repo_dir"
docker compose --env-file "$env_file" stop
services_stopped=true
restart_services() {
  if [[ "$services_stopped" == true ]]; then
    docker compose --env-file "$env_file" start >/dev/null
    services_stopped=false
  fi
}
trap restart_services EXIT

if [[ -d "$data_dir" ]]; then mv "$data_dir" "$rollback_root"; fi
if [[ -d "$database_dir" ]]; then mv "$database_dir" "$database_rollback_root"; fi
mkdir -p "$data_dir" "$database_dir"

database_snapshot="$snapshot/database"
if [[ ! -d "$database_snapshot" ]]; then database_snapshot="$snapshot/data"; fi

if ! rsync -a --delete "$snapshot/data/" "$data_dir/" || ! rsync -a --delete --include '/demolition.sqlite' --include '/demolition.sqlite-wal' --include '/demolition.sqlite-shm' --exclude '*' "$database_snapshot/" "$database_dir/"; then
  failed_restore="${data_dir%/}-failed-$(date -u +%Y%m%dT%H%M%SZ)"
  failed_database_restore="${database_dir%/}-failed-$(date -u +%Y%m%dT%H%M%SZ)"
  mv "$data_dir" "$failed_restore"
  mv "$database_dir" "$failed_database_restore"
  if [[ -d "$rollback_root" ]]; then mv "$rollback_root" "$data_dir"; fi
  if [[ -d "$database_rollback_root" ]]; then mv "$database_rollback_root" "$database_dir"; fi
  restart_services
  trap - EXIT
  echo "Restore failed; the previous data and database directories were put back. Partial files remain at $failed_restore and $failed_database_restore" >&2
  exit 1
fi

chown -R "$uid:$gid" "$data_dir" "$database_dir"
restart_services
trap - EXIT

echo "Restore complete. Previous data remains at $rollback_root and $database_rollback_root"

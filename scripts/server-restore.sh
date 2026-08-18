#!/usr/bin/env bash
set -euo pipefail

repo_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
env_file=${DEMOLITION_ENV_FILE:-"$repo_dir/.env.server"}
snapshot=${1:-}

[[ -n "$snapshot" && -d "$snapshot/data" ]] || { echo "Usage: $0 /srv/demolition/backups/TIMESTAMP" >&2; exit 1; }
[[ -f "$env_file" ]] || { echo "Missing $env_file" >&2; exit 1; }
command -v docker >/dev/null || { echo "Docker is required." >&2; exit 1; }
command -v rsync >/dev/null || { echo "rsync is required." >&2; exit 1; }

set -a
source "$env_file"
set +a

data_dir=${DEMOLITION_DATA_DIR:-/srv/demolition/data}
caddy_data_dir=${DEMOLITION_CADDY_DATA_DIR:-/srv/demolition/caddy-data}
uid=${DEMOLITION_UID:-1000}
gid=${DEMOLITION_GID:-1000}
rollback_root="${data_dir%/}-before-restore-$(date -u +%Y%m%dT%H%M%SZ)"

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
mkdir -p "$data_dir" "$caddy_data_dir"

if ! rsync -a --delete "$snapshot/data/" "$data_dir/"; then
  failed_restore="${data_dir%/}-failed-$(date -u +%Y%m%dT%H%M%SZ)"
  mv "$data_dir" "$failed_restore"
  if [[ -d "$rollback_root" ]]; then mv "$rollback_root" "$data_dir"; fi
  restart_services
  trap - EXIT
  echo "Restore failed; the previous data directory was put back. Partial files remain at $failed_restore" >&2
  exit 1
fi

if [[ -d "$snapshot/caddy-data" ]]; then rsync -a --delete "$snapshot/caddy-data/" "$caddy_data_dir/"; fi
chown -R "$uid:$gid" "$data_dir"
restart_services
trap - EXIT

echo "Restore complete. Previous data remains at $rollback_root"

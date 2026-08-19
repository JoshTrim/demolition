#!/usr/bin/env bash
set -euo pipefail

repo_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
env_file=${1:-"$repo_dir/.env.server"}

if [[ ! -f "$env_file" ]]; then
  echo "Missing $env_file. Copy .env.server.example and fill in the server values." >&2
  exit 1
fi
command -v docker >/dev/null || { echo "Docker is required." >&2; exit 1; }

set -a
source "$env_file"
set +a

: "${DEMOLITION_WIREGUARD_IP:?Set DEMOLITION_WIREGUARD_IP}"
: "${DEMOLITION_PROXY_TOKEN:?Set DEMOLITION_PROXY_TOKEN}"

if [[ ${#DEMOLITION_PROXY_TOKEN} -lt 32 || "$DEMOLITION_PROXY_TOKEN" == replace-* ]]; then
  echo "DEMOLITION_PROXY_TOKEN must be a generated secret of at least 32 characters." >&2
  exit 1
fi

data_dir=${DEMOLITION_DATA_DIR:-/srv/demolition/data}
uid=${DEMOLITION_UID:-1000}
gid=${DEMOLITION_GID:-1000}

mkdir -p "$data_dir"
if [[ $EUID -eq 0 ]]; then
  chown -R "$uid:$gid" "$data_dir"
elif [[ ! -w "$data_dir" ]]; then
  echo "Cannot write $data_dir. Create it and assign it to $uid:$gid first." >&2
  exit 1
fi

cd "$repo_dir"
docker compose --env-file "$env_file" config --quiet
docker compose --env-file "$env_file" build
docker compose --env-file "$env_file" up -d
docker compose --env-file "$env_file" ps

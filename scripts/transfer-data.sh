#!/usr/bin/env bash
set -euo pipefail

repo_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
target=${1:-}
remote_dir=${2:-/srv/demolition/data}

[[ -n "$target" ]] || { echo "Usage: $0 user@debian-server [/srv/demolition/data]" >&2; exit 1; }
[[ -d "$repo_dir/data" ]] || { echo "No local data directory found at $repo_dir/data" >&2; exit 1; }
command -v rsync >/dev/null || { echo "rsync is required." >&2; exit 1; }
command -v ssh >/dev/null || { echo "ssh is required." >&2; exit 1; }

echo "Demolition must be stopped locally before this transfer so SQLite and its WAL files are consistent."
read -r -p "Type TRANSFER to continue: " confirmation
[[ "$confirmation" == "TRANSFER" ]] || { echo "Transfer cancelled."; exit 1; }

ssh "$target" "mkdir -p '$remote_dir'"
rsync -a --partial --info=progress2 "$repo_dir/data/" "$target:$remote_dir/"

echo "Transfer complete. Keep the local data directory until the server restore has been verified."

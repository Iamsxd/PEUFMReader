#!/usr/bin/env sh
set -eu

project_dir=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cd "$project_dir"

backup_name=${1:-}
case "$backup_name" in
  *[!A-Za-z0-9._-]*|'') echo "Usage: scripts/verify-backup.sh BACKUP_NAME" >&2; exit 2 ;;
esac

docker compose --profile tools run --rm --entrypoint /bin/sh -e BACKUP_NAME="$backup_name" backup /tools/verify-backup-container.sh

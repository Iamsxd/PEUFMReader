#!/usr/bin/env sh
set -eu

project_dir=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cd "$project_dir"

backup_name=${1:-$(date -u +%Y%m%dT%H%M%SZ)}
case "$backup_name" in
  *[!A-Za-z0-9._-]*|'') echo "Backup name may only contain letters, numbers, dot, underscore, and dash." >&2; exit 2 ;;
esac

restart_app() {
  docker compose start app >/dev/null 2>&1 || true
}
trap restart_app EXIT INT TERM

echo "Stopping application writes..."
docker compose stop -t 30 app
echo "Creating backup: $backup_name"
docker compose --profile tools run --rm -e BACKUP_NAME="$backup_name" backup
restart_app
trap - EXIT INT TERM
echo "Backup completed: $backup_name"

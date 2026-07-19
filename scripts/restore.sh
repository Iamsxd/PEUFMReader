#!/usr/bin/env sh
set -eu

project_dir=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cd "$project_dir"

restore_name=${1:-}
confirmation=${2:-}
case "$restore_name" in
  *[!A-Za-z0-9._-]*|'') echo "Usage: scripts/restore.sh BACKUP_NAME --yes" >&2; exit 2 ;;
esac
if [ "$confirmation" != "--yes" ]; then
  echo "Restore replaces the current database and managed files. Re-run with --yes after verifying the backup name." >&2
  exit 2
fi

restart_app() {
  docker compose start app >/dev/null 2>&1 || true
}
trap restart_app EXIT INT TERM

echo "Stopping application writes..."
docker compose stop -t 30 app
echo "Restoring backup: $restore_name"
docker compose --profile tools run --rm --entrypoint /bin/sh -e RESTORE_NAME="$restore_name" backup /tools/restore-container.sh
restart_app
trap - EXIT INT TERM
echo "Restore completed: $restore_name"

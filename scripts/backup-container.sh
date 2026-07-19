#!/bin/sh
set -eu
umask 077

backup_name=${BACKUP_NAME:-}
case "$backup_name" in
  *[!A-Za-z0-9._-]*|'') echo "Invalid BACKUP_NAME" >&2; exit 2 ;;
esac

target="/backup/$backup_name"
if [ -e "$target" ]; then
  echo "Backup already exists: $backup_name" >&2
  exit 3
fi
mkdir -p "$target"

pg_dump --format=custom --no-owner --no-privileges --file="$target/database.dump"
tar -C /restore/library -czf "$target/library.tar.gz" .
tar -C /restore/cache -czf "$target/cache.tar.gz" .
tar -C /restore/import -czf "$target/import.tar.gz" .

(
  cd "$target"
  sha256sum database.dump library.tar.gz cache.tar.gz import.tar.gz > SHA256SUMS
  printf 'PEUFMReader backup\nname=%s\ncreated_at=%s\n' "$backup_name" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > MANIFEST.txt
)


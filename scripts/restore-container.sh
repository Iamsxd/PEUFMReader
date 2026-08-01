#!/bin/sh
set -eu

restore_name=${RESTORE_NAME:-}
case "$restore_name" in
  *[!A-Za-z0-9._-]*|'') echo "Invalid RESTORE_NAME" >&2; exit 2 ;;
esac

source_dir="/backup/$restore_name"
/bin/sh /tools/validate-backup-container.sh "$source_dir"

for target in /restore/library /restore/cache /restore/import; do
  find "$target" -mindepth 1 -maxdepth 1 -exec rm -rf -- {} +
done
tar -C /restore/library -xzf "$source_dir/library.tar.gz"
tar -C /restore/cache -xzf "$source_dir/cache.tar.gz"
tar -C /restore/import -xzf "$source_dir/import.tar.gz"
pg_restore --clean --if-exists --no-owner --no-privileges --dbname="$PGDATABASE" "$source_dir/database.dump"

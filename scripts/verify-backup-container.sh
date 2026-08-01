#!/bin/sh
set -eu

backup_name=${BACKUP_NAME:-}
case "$backup_name" in
  *[!A-Za-z0-9._-]*|'') echo "Invalid BACKUP_NAME" >&2; exit 2 ;;
esac

source_dir="/backup/$backup_name"
/bin/sh /tools/validate-backup-container.sh "$source_dir"
echo "Backup verified: $backup_name"

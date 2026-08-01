#!/bin/sh
set -eu

source_dir=${1:-}
if [ -z "$source_dir" ] || [ ! -d "$source_dir" ]; then
  echo "Backup directory does not exist: $source_dir" >&2
  exit 3
fi

for required in database.dump library.tar.gz cache.tar.gz import.tar.gz MANIFEST.txt SHA256SUMS; do
  if [ ! -f "$source_dir/$required" ]; then
    echo "Backup is incomplete: missing $required" >&2
    exit 3
  fi
done

(
  cd "$source_dir"
  sha256sum -c SHA256SUMS
)

pg_restore --list "$source_dir/database.dump" >/dev/null

for archive in library.tar.gz cache.tar.gz import.tar.gz; do
  list_file="/tmp/${archive}.list.$$"
  trap 'rm -f -- "$list_file"' EXIT INT TERM
  tar -tzf "$source_dir/$archive" > "$list_file"
  if ! awk '/^\// || /(^|\/)\.\.(\/|$)/ { unsafe=1 } END { exit unsafe }' "$list_file"; then
    echo "Backup archive contains an unsafe path: $archive" >&2
    exit 4
  fi
  rm -f -- "$list_file"
  trap - EXIT INT TERM
done

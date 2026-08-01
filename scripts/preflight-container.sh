#!/bin/sh
set -eu

echo "container identity: $(id)"
for directory in /data/library /data/staging /data/cache /data/import; do
  if [ ! -d "$directory" ]; then
    echo "Required directory is missing: $directory" >&2
    exit 3
  fi
  probe="$directory/.peufmreader-write-test-$$"
  if ! : > "$probe"; then
    echo "Configured PUID/PGID cannot write: $directory" >&2
    exit 4
  fi
  rm -f -- "$probe"
done

for directory in /watch/library /import/calibre; do
  if [ ! -r "$directory" ]; then
    echo "Optional read-only source is not readable: $directory" >&2
    exit 5
  fi
done

df -h /data/library /data/cache /data/import

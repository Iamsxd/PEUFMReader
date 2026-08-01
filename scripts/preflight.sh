#!/usr/bin/env sh
set -eu

project_dir=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cd "$project_dir"

echo "Validating Compose configuration..."
docker compose config --quiet

echo "Checking app volume access with the configured PUID/PGID..."
docker compose run --rm --no-deps \
  --volume "$project_dir/scripts:/tools:ro" \
  --entrypoint /bin/sh app /tools/preflight-container.sh

echo "Preflight checks passed."

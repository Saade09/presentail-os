#!/usr/bin/env bash
set -euo pipefail

VITE_CMD="vite --config vite.config.ts --host 0.0.0.0"
CACHE_DIR="node_modules/.vite"

attempt=0
while true; do
  attempt=$((attempt + 1))
  rm -rf "$CACHE_DIR"/deps_temp_*

  if $VITE_CMD; then
    break
  fi

  echo "[dev-start] Vite exited (attempt $attempt). Retrying in 8s..."
  sleep 8
done

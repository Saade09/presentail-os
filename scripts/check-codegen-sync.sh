#!/usr/bin/env bash
# check-codegen-sync.sh
# Verifies that the committed Orval-generated files match the current OpenAPI spec.
# Runs Orval codegen (without the full typecheck:libs step), then checks for any
# git diff in the generated output directories.  Fails with a clear message if
# anything is out of sync.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

echo "Running Orval codegen..."
pnpm --filter @workspace/api-spec exec orval --config ./orval.config.ts

echo "Checking for uncommitted changes in generated files..."
if ! git diff --exit-code \
    lib/api-client-react/src/generated \
    lib/api-zod/src/generated; then
  echo ""
  echo "ERROR: Generated API files are out of sync with the OpenAPI spec."
  echo "Run 'pnpm --filter @workspace/api-spec run codegen' and commit the result."
  exit 1
fi

echo "Generated API files are in sync."

echo "Running OpenAPI spec lint..."
pnpm --filter @workspace/api-spec run lint:spec

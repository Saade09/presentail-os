#!/usr/bin/env bash
set -euo pipefail

publish_phase() {
  node scripts/publish/run-phase.mjs "$@"
}

# These checks are part of the real API artifact build, not only the optional
# root orchestrator. This prevents .replitignore or service-contract drift from
# silently changing a production publish.
node scripts/publish/validate-contract.mjs
pnpm run check:deployment-context
pnpm run typecheck:production

# Ensure the full Chromium browser is present in the deployment image so the
# api-server can render gift-card PDFs (GET /api/orders/:id/card-pdf) at runtime.
#
# The deploy build starts from a clean checkout, and the gitignored
# .cache/ms-playwright (where dev keeps Chromium) is never carried in. Without
# this step production has no browser binary and gift-card rendering 500s with
# "Executable doesn't exist at .../chrome-headless-shell". `playwright` and
# `playwright-core` are pinned to the same version, so the installed Chromium
# revision matches what the server launches. This is idempotent: playwright
# skips the download when the matching revision already exists.
#
# CRITICAL: pin PLAYWRIGHT_BROWSERS_PATH to a workspace-relative cache so the
# browser is installed INTO the deployed workspace (which ships into the run
# image), not Playwright's default HOME cache (~/.cache/ms-playwright), which
# lives outside the workspace and is discarded before the server runs. The run
# env in .replit-artifact/artifact.toml must set the SAME path so the resolver
# finds exactly the binary this step installed.
export PLAYWRIGHT_BROWSERS_PATH="/home/runner/workspace/.cache/ms-playwright"
timing_start() {
  TIMING_PHASE_START_MS=$(date +%s%3N)
  echo "[TIMING] component=api-server phase=$1 event=start timestamp=$(date -u +%Y-%m-%dT%H:%M:%S.%3NZ)"
}

timing_complete() {
  local phase="$1"
  local status="${2:-success}"
  local now_ms
  now_ms=$(date +%s%3N)
  echo "[TIMING] component=api-server phase=$phase event=complete timestamp=$(date -u +%Y-%m-%dT%H:%M:%S.%3NZ) elapsed_ms=$((now_ms - TIMING_PHASE_START_MS)) status=$status"
}

find_full_chromium() {
  find "$PLAYWRIGHT_BROWSERS_PATH" -maxdepth 3 \
    \( -path "*/chrome-linux64/chrome" -o -path "*/chrome-linux/chrome" \) \
    -path "*/chromium-*/*" 2>/dev/null | head -1
}

timing_start chromium_installation
CHROME_BIN=$(find_full_chromium)
if [ -n "$CHROME_BIN" ]; then
  echo "Reusing full Chromium build at $CHROME_BIN"
  publish_phase chromium-preparation node -e 'console.log("Reused cached full Chromium build")'
else
  echo "Installing Chromium into PLAYWRIGHT_BROWSERS_PATH=$PLAYWRIGHT_BROWSERS_PATH"
  publish_phase chromium-preparation pnpm --filter @workspace/print-agent-web exec playwright install --no-shell chromium
fi
timing_complete chromium_installation

# Fail fast if the full Chromium build is not where the runtime resolver will
# look, so a broken deploy build never ships a server that 500s on the first
# card PDF. Matches resolveChromiumPath()/findFullChromiumInCache() in
# artifacts/api-server/src/lib/giftCardPdf.ts.
timing_start chromium_verification
CHROME_BIN=$(find_full_chromium)
if [ -z "$CHROME_BIN" ]; then
  echo "ERROR: full Chromium build not found under $PLAYWRIGHT_BROWSERS_PATH after install." >&2
  exit 1
fi
echo "Verified full Chromium build at $CHROME_BIN"
timing_complete chromium_verification

# Build the api-server production bundle.
timing_start api_bundle
publish_phase build:api-server pnpm --filter @workspace/api-server run build
timing_complete api_bundle

# The API bundle deliberately leaves native/runtime-asset-heavy packages
# external. Replit removes the workspace node_modules tree from the final image,
# so install only those runtime packages beside dist/index.mjs where Node's
# normal package resolution can find them. Keeping this list minimal avoids
# shipping the full ~490 MB API dependency tree.
RUNTIME_DEPS_DIR="artifacts/api-server/.deploy-runtime-deps"
RUNTIME_NODE_MODULES="artifacts/api-server/dist/node_modules"
rm -rf "$RUNTIME_DEPS_DIR" "$RUNTIME_NODE_MODULES"
mkdir -p "$RUNTIME_DEPS_DIR"

timing_start runtime_dependency_resolution
node <<'NODE'
const fs = require("node:fs");
const path = require("node:path");
const { createRequire } = require("node:module");

const apiPackageDir = path.resolve("artifacts/api-server");
const requireFromApi = createRequire(path.join(apiPackageDir, "package.json"));
const runtimePackages = [
  "@napi-rs/canvas",
  "pdfkit",
  "playwright-core",
  "sharp",
];

function installedVersion(name) {
  let current = path.dirname(requireFromApi.resolve(name));
  while (current !== path.dirname(current)) {
    const packageJsonPath = path.join(current, "package.json");
    if (fs.existsSync(packageJsonPath)) {
      const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf8"));
      if (packageJson.name === name && packageJson.version) {
        return packageJson.version;
      }
    }
    current = path.dirname(current);
  }
  throw new Error(`Could not determine installed version for ${name}`);
}

const dependencies = Object.fromEntries(
  runtimePackages.map((name) => [name, installedVersion(name)]),
);
fs.writeFileSync(
  "artifacts/api-server/.deploy-runtime-deps/package.json",
  `${JSON.stringify({ private: true, dependencies }, null, 2)}\n`,
);
NODE
timing_complete runtime_dependency_resolution

timing_start runtime_dependency_installation
publish_phase package:api-runtime pnpm --dir "$RUNTIME_DEPS_DIR" install \
  --prod \
  --ignore-workspace \
  --lockfile=false
timing_complete runtime_dependency_installation

timing_start runtime_dependency_packaging
mv "$RUNTIME_DEPS_DIR/node_modules" "$RUNTIME_NODE_MODULES"
rm -rf "$RUNTIME_DEPS_DIR"

echo "Packaged minimal API runtime dependencies:"
du -sh "$RUNTIME_NODE_MODULES"
timing_complete runtime_dependency_packaging

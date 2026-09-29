#!/bin/bash
set -e
pnpm install --frozen-lockfile
# pnpm install runs the root prepare script, which installs/refreshes Husky.
# Do not invoke Husky a second time here: the duplicate process is redundant
# and can fail with EAGAIN during post-merge reconciliation.
# Regenerate API client from OpenAPI spec so generated files are always present.
# Missing generated/ files cause Vite pre-transform errors and TS2307 errors.
pnpm --filter @workspace/api-spec run codegen
# Ensure the Playwright Chromium browser is present and uncorrupted.
# A missing or corrupted v8_context_snapshot.bin causes all e2e tests to crash
# at launch. This is idempotent: no-op when the browser is already healthy.
CHROME_BIN=$(find /home/runner/workspace/.cache/ms-playwright -name "chrome" -path "*/chrome-linux64/chrome" 2>/dev/null | head -1)
if [ -z "$CHROME_BIN" ]; then
  pnpm --filter @workspace/print-agent-web exec playwright install chromium
else
  echo "Chromium already installed at $CHROME_BIN — skipping install."
fi
# NOTE: Do NOT run drizzle-kit push here. The lib/db schema is intentionally
# empty (export {}). All schema migrations are handled by initDb.ts at API
# server startup using raw CREATE TABLE/ALTER TABLE IF NOT EXISTS statements.
# Running drizzle-kit push against an empty schema drops every table in the DB.

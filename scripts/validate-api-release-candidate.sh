#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

echo "==> Typechecking production libraries and API"
pnpm run typecheck:libs
pnpm --filter @workspace/api-server run typecheck

echo "==> Running the complete API unit suite"
timeout --signal=TERM --kill-after=15s 180s \
  pnpm --filter @workspace/api-server test

echo "==> Building the production API bundle"
pnpm --filter @workspace/api-server run build

echo "==> Running release-critical PostgreSQL and production-entry checks"
bash artifacts/api-server/test-integration-local.sh \
  src/lib/initDb.schema.integration.test.ts \
  src/lib/mutationDatabaseReadiness.integration.test.ts \
  src/productionEntry.integration.test.ts \
  src/routes/products.recipe.integration.test.ts \
  src/routes/products.integration.test.ts \
  src/lib/finance/syncImportedSupplierInvoice.integration.test.ts \
  src/routes/finance.review.integration.test.ts \
  src/routes/cashSessions.bills.integration.test.ts \
  src/routes/cashSessions.billPayment.integration.test.ts \
  src/routes/floristOrders.integration.test.ts \
  src/routes/purchaseOrders.integration.test.ts \
  src/routes/orders.contactEdits.integration.test.ts \
  src/routes/orders.invoice.integration.test.ts

echo "==> API release candidate passed"
/**
 * Public source-build marker used to prove which API bundle is live.
 *
 * Keep this value in sync with API_BUILD_ID in production-entry.cjs because
 * that bootstrap serves /api/healthz before the Express bundle has loaded.
 */
export const API_BUILD_ID = "address-reverification-recovery-2026-09-16-v3";

export const ADDRESS_REVERIFICATION_WORKER_REVISION =
  "bounded-retry-after-and-nullable-worker-recovery-2026-09-16-v3";
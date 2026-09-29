/**
 * Unit tests for enqueueMerchantSyncBackfill — verifies the backfill:
 *   - has NO product cap (no LIMIT in the eligible-product insert),
 *   - resets stale active jobs (RETRY_WAITING + stale RUNNING) back to PENDING
 *     so previously-stuck products get re-enqueued rather than skipped,
 *   - returns the combined enqueued count (inserted + reset).
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("./db", () => ({
  db: { query: vi.fn() },
}));

vi.mock("./logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { db } from "./db";
import {
  enqueueMerchantSyncBackfill,
  enqueueSelectedMerchantSync,
  enqueueSelectedMerchantUnsync,
} from "./merchantSyncQueue";

const mockDbQuery = vi.mocked(db.query);

describe("enqueueMerchantSyncBackfill", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("resets stale jobs and enqueues the whole eligible catalog without a cap", async () => {
    mockDbQuery
      .mockResolvedValueOnce({ rows: [{ count: 3 }], rowCount: 1 } as never) // reset
      .mockResolvedValueOnce({ rows: [{ count: 907 }], rowCount: 1 } as never); // insert

    const result = await enqueueMerchantSyncBackfill("owner_1");

    expect(result).toEqual({ enqueued: 910, inserted: 907, reset: 3 });
    expect(mockDbQuery).toHaveBeenCalledTimes(2);

    const [resetSql, resetParams] = mockDbQuery.mock.calls[0] as unknown as [string, unknown[]];
    const [insertSql, insertParams] = mockDbQuery.mock.calls[1] as unknown as [string, unknown[]];

    // Reset statement: reclaims RETRY_WAITING and stale RUNNING jobs to PENDING
    expect(resetSql).toContain("'RETRY_WAITING'");
    expect(resetSql).toContain("'RUNNING'");
    expect(resetSql).toContain("INTERVAL '10 minutes'");
    expect(resetSql).toContain("SET status = 'PENDING'");
    expect(resetSql).toContain("attempts = 0");
    // Products of reset jobs are re-marked PENDING with error cleared
    expect(resetSql).toContain("merchant_sync_status = 'PENDING'");
    expect(resetSql).toContain("merchant_sync_error  = NULL");
    expect(resetParams).toEqual(["owner_1"]);

    // Insert statement: batched INSERT ... SELECT covering the ENTIRE catalog —
    // no LIMIT clause anywhere (the old hard 500 cap is gone)
    expect(insertSql).not.toMatch(/\bLIMIT\b/i);
    expect(insertSql).toContain("INSERT INTO merchant_sync_jobs");
    expect(insertSql).toContain("merchant_sync_disabled IS NOT TRUE");
    // Still idempotent: products with an active job are skipped
    expect(insertSql).toContain("'PENDING', 'RUNNING', 'RETRY_WAITING'");
    expect(insertParams).toEqual(["owner_1"]);
  });

  it("returns zeros when nothing needs enqueueing (idempotent second run)", async () => {
    mockDbQuery
      .mockResolvedValueOnce({ rows: [{ count: 0 }], rowCount: 1 } as never)
      .mockResolvedValueOnce({ rows: [{ count: 0 }], rowCount: 1 } as never);

    const result = await enqueueMerchantSyncBackfill("owner_1");
    expect(result).toEqual({ enqueued: 0, inserted: 0, reset: 0 });
  });
});

describe("enqueueSelectedMerchantSync", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("queues only distinct requested products from the workspace without payload snapshots", async () => {
    mockDbQuery.mockResolvedValueOnce({
      rows: [{ queued: 2, skipped: 1 }],
      rowCount: 1,
    } as never);

    const result = await enqueueSelectedMerchantSync("owner_1", [10, 10, 11, 999]);

    expect(result).toEqual({ queued: 2, skipped: 1 });
    expect(mockDbQuery).toHaveBeenCalledTimes(1);
    const [sql, params] = mockDbQuery.mock.calls[0] as unknown as [string, unknown[]];
    expect(params).toEqual(["owner_1", [10, 11, 999]]);
    expect(sql).toContain("p.workspace_owner_id = $1");
    expect(sql).toContain("p.status = 'available'");
    expect(sql).toContain("p.is_archived IS NOT TRUE");
    expect(sql).toContain("p.merchant_sync_disabled IS NOT TRUE");
    expect(sql).toContain("jsonb_build_object('id', id)");
    expect(sql).toContain("ON CONFLICT DO NOTHING");
    expect(sql).not.toContain("buildMerchantSyncPayload");
  });

  it("skips products with an active job but allows completed and failed products to be queued again", async () => {
    mockDbQuery.mockResolvedValueOnce({
      rows: [{ queued: 1, skipped: 2 }],
      rowCount: 1,
    } as never);

    const result = await enqueueSelectedMerchantSync("owner_1", [1, 2, 3]);

    expect(result).toEqual({ queued: 1, skipped: 2 });
    const [sql] = mockDbQuery.mock.calls[0] as unknown as [string];
    expect(sql).toContain("'PENDING', 'RUNNING', 'RETRY_WAITING'");
    expect(sql).not.toMatch(/'COMPLETED'|'FAILED'/);
    expect(sql).toContain("ON CONFLICT DO NOTHING");
    expect(sql).toContain("merchant_sync_status = 'PENDING'");
    expect(sql).toContain("merchant_sync_error = NULL");
  });

  it("does not query the database for an empty direct helper call", async () => {
    await expect(enqueueSelectedMerchantSync("owner_1", [])).resolves.toEqual({ queued: 0, skipped: 0 });
    expect(mockDbQuery).not.toHaveBeenCalled();
  });
});

describe("enqueueSelectedMerchantUnsync", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("scopes products to the workspace, disables sync, supersedes active writes, and queues deduplicated deletes", async () => {
    mockDbQuery.mockResolvedValueOnce({
      rows: [{ excluded: 2, queued: 1, skipped: 1 }],
      rowCount: 1,
    } as never);

    const result = await enqueueSelectedMerchantUnsync("owner_1", [10, 10, 11, 999]);

    expect(result).toEqual({ excluded: 2, queued: 1, skipped: 1 });
    const [sql, params] = mockDbQuery.mock.calls[0] as unknown as [string, unknown[]];
    expect(params).toEqual(["owner_1", [10, 11, 999]]);
    expect(sql).toContain("p.workspace_owner_id = $1");
    expect(sql).toContain("merchant_sync_disabled = TRUE");
    expect(sql).toContain("merchant_sync_status = 'DISABLED'");
    expect(sql).toContain("j.operation = 'CREATE_OR_UPDATE'");
    expect(sql).toContain("'PENDING', 'RUNNING', 'RETRY_WAITING'");
    expect(sql).toContain("INSERT INTO merchant_sync_jobs");
    expect(sql).toContain("'DELETE', 'PENDING'");
    expect(sql).toContain("'merchantResourceName', merchant_resource_name");
    expect(sql).toContain("o.merchant_sync_status IN ('PENDING', 'SYNCED', 'FAILED', 'ACTION_REQUIRED')");
    expect(sql).not.toContain("o.sku IS NOT NULL");
    expect(sql).toContain("ON CONFLICT DO NOTHING");
  });

  it("does not query the database for an empty direct helper call", async () => {
    await expect(enqueueSelectedMerchantUnsync("owner_1", [])).resolves.toEqual({
      excluded: 0,
      queued: 0,
      skipped: 0,
    });
    expect(mockDbQuery).not.toHaveBeenCalled();
  });
});

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const { mockClient, mockDbConnect } = vi.hoisted(() => {
  const mockClient = {
    query: vi.fn(),
    release: vi.fn(),
  };
  return {
    mockClient,
    mockDbConnect: vi.fn().mockResolvedValue(mockClient),
  };
});

vi.mock("./db", () => ({
  db: {
    connect: () => mockDbConnect(),
  },
}));

vi.mock("./logger", () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

import { runCleanup, runCleanupWithLock, startPaymentLinkCleanupJob } from "./paymentLinkCleanupJob";
import { logger } from "./logger";

/**
 * Sets up mockClient.query to behave correctly for all expected SQL patterns:
 *  - BEGIN / COMMIT / ROLLBACK   → { rows: [], rowCount: null }
 *  - pg_try_advisory_lock        → { rows: [{ acquired }], rowCount: 1 }
 *  - pg_advisory_unlock          → { rows: [{ pg_advisory_unlock: true }], rowCount: 1 }
 *  - cleanup queries             → { rows: [], rowCount }
 */
function setupClientMock(opts: { acquired?: boolean; rowCount?: number } = {}) {
  const { acquired = true, rowCount = 0 } = opts;
  mockClient.query.mockImplementation(async (sql: string) => {
    if (/pg_try_advisory_lock/i.test(sql)) {
      return { rows: [{ acquired }], rowCount: 1 };
    }
    if (/pg_advisory_unlock/i.test(sql)) {
      return { rows: [{ pg_advisory_unlock: true }], rowCount: 1 };
    }
    return { rows: [], rowCount };
  });
}

describe("runCleanup — payment link cleanup job", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDbConnect.mockResolvedValue(mockClient);
    mockClient.release.mockReturnValue(undefined);
    setupClientMock({ rowCount: 0 });
  });

  it("marks active links older than 7 days as expired", async () => {
    setupClientMock({ rowCount: 3 });

    await runCleanup();

    const expireCall = mockClient.query.mock.calls.find(([sql]: [string]) =>
      /UPDATE\s+payment_links/i.test(sql) &&
      /status\s*=\s*'expired'/i.test(sql),
    );

    expect(expireCall).toBeDefined();
    const [, params] = expireCall as [string, unknown[]];
    expect(params[0]).toBe(7);
  });

  it("hard-deletes expired links older than 30 days", async () => {
    setupClientMock({ rowCount: 2 });

    await runCleanup();

    const deleteCall = mockClient.query.mock.calls.find(([sql]: [string]) =>
      /DELETE\s+FROM\s+payment_links/i.test(sql),
    );

    expect(deleteCall).toBeDefined();
    const [, params] = deleteCall as [string, unknown[]];
    expect(params[0]).toBe(30);
  });

  it("never touches paid links — UPDATE targets only active status", async () => {
    await runCleanup();

    const expireCall = mockClient.query.mock.calls.find(([sql]: [string]) =>
      /UPDATE\s+payment_links/i.test(sql) &&
      /status\s*=\s*'expired'/i.test(sql),
    );

    expect(expireCall).toBeDefined();
    const [sql] = expireCall as [string, unknown[]];
    expect(sql).toMatch(/WHERE\s[\s\S]*status\s*=\s*'active'/i);
  });

  it("never deletes paid links — DELETE targets only expired status", async () => {
    await runCleanup();

    const deleteCall = mockClient.query.mock.calls.find(([sql]: [string]) =>
      /DELETE\s+FROM\s+payment_links/i.test(sql),
    );

    expect(deleteCall).toBeDefined();
    const [sql] = deleteCall as [string, unknown[]];
    expect(sql).toMatch(/WHERE\s[\s\S]*status\s*=\s*'expired'/i);
  });

  it("uses a created_at threshold for expiring active links so young links are untouched", async () => {
    await runCleanup();

    const expireCall = mockClient.query.mock.calls.find(([sql]: [string]) =>
      /UPDATE\s+payment_links/i.test(sql) &&
      /status\s*=\s*'expired'/i.test(sql),
    );

    expect(expireCall).toBeDefined();
    const [sql] = expireCall as [string, unknown[]];
    expect(sql).toMatch(/created_at\s*<\s*now\(\)/i);
  });

  it("uses a created_at threshold for deleting expired links so recently-expired links are untouched", async () => {
    await runCleanup();

    const deleteCall = mockClient.query.mock.calls.find(([sql]: [string]) =>
      /DELETE\s+FROM\s+payment_links/i.test(sql),
    );

    expect(deleteCall).toBeDefined();
    const [sql] = deleteCall as [string, unknown[]];
    expect(sql).toMatch(/created_at\s*<\s*now\(\)/i);
  });

  it("always runs both the expire UPDATE and the delete DELETE in every invocation", async () => {
    await runCleanup();

    const expireCalls = mockClient.query.mock.calls.filter(([sql]: [string]) =>
      /UPDATE\s+payment_links/i.test(sql) &&
      /status\s*=\s*'expired'/i.test(sql),
    );
    const deleteCalls = mockClient.query.mock.calls.filter(([sql]: [string]) =>
      /DELETE\s+FROM\s+payment_links/i.test(sql),
    );

    expect(expireCalls).toHaveLength(1);
    expect(deleteCalls).toHaveLength(1);
  });

  it("runs the expire UPDATE before the delete DELETE", async () => {
    const callOrder: string[] = [];

    mockClient.query.mockImplementation(async (sql: string) => {
      if (/UPDATE\s+payment_links/i.test(sql)) callOrder.push("update");
      if (/DELETE\s+FROM\s+payment_links/i.test(sql)) callOrder.push("delete");
      return { rows: [], rowCount: 0 };
    });

    await runCleanup();

    expect(callOrder).toEqual(["update", "delete"]);
  });

  it("resolves without throwing when both queries return rowCount 0 (nothing to clean)", async () => {
    setupClientMock({ rowCount: 0 });

    await expect(runCleanup()).resolves.toBeUndefined();
  });

  it("resolves without throwing when rowCount is null (some drivers return null)", async () => {
    mockClient.query.mockResolvedValue({ rows: [], rowCount: null });

    await expect(runCleanup()).resolves.toBeUndefined();
  });

  it("re-throws when a cleanup query rejects", async () => {
    const dbError = new Error("connection refused");
    mockClient.query.mockImplementation(async (sql: string) => {
      if (/BEGIN/i.test(sql)) return { rows: [], rowCount: null };
      throw dbError;
    });

    await expect(runCleanup()).rejects.toThrow("connection refused");
  });

  it("wraps both statements in a transaction — sends BEGIN before the UPDATE", async () => {
    const callOrder: string[] = [];

    mockClient.query.mockImplementation(async (sql: string) => {
      if (/^\s*BEGIN\s*$/i.test(sql)) callOrder.push("BEGIN");
      if (/UPDATE\s+payment_links/i.test(sql)) callOrder.push("UPDATE");
      if (/DELETE\s+FROM\s+payment_links/i.test(sql)) callOrder.push("DELETE");
      if (/^\s*COMMIT\s*$/i.test(sql)) callOrder.push("COMMIT");
      return { rows: [], rowCount: 0 };
    });

    await runCleanup();

    expect(callOrder.indexOf("BEGIN")).toBeLessThan(callOrder.indexOf("UPDATE"));
    expect(callOrder.indexOf("UPDATE")).toBeLessThan(callOrder.indexOf("DELETE"));
    expect(callOrder.indexOf("DELETE")).toBeLessThan(callOrder.indexOf("COMMIT"));
  });

  it("sends COMMIT after both cleanup queries succeed", async () => {
    await runCleanup();

    const commitCall = mockClient.query.mock.calls.find(([sql]: [string]) =>
      /^\s*COMMIT\s*$/i.test(sql),
    );
    expect(commitCall).toBeDefined();
  });

  it("sends ROLLBACK and re-throws when a cleanup query fails, leaving no partial state", async () => {
    const dbError = new Error("disk full");

    mockClient.query.mockImplementation(async (sql: string) => {
      if (/^\s*BEGIN\s*$/i.test(sql)) return { rows: [], rowCount: null };
      if (/^\s*ROLLBACK\s*$/i.test(sql)) return { rows: [], rowCount: null };
      throw dbError;
    });

    await expect(runCleanup()).rejects.toThrow("disk full");

    const rollbackCall = mockClient.query.mock.calls.find(([sql]: [string]) =>
      /^\s*ROLLBACK\s*$/i.test(sql),
    );
    expect(rollbackCall).toBeDefined();

    const commitCall = mockClient.query.mock.calls.find(([sql]: [string]) =>
      /^\s*COMMIT\s*$/i.test(sql),
    );
    expect(commitCall).toBeUndefined();
  });

  it("checks out a dedicated client from the pool for the transaction", async () => {
    await runCleanup();

    expect(mockDbConnect).toHaveBeenCalledTimes(1);
  });

  it("always releases the pool client after a successful run", async () => {
    await runCleanup();

    expect(mockClient.release).toHaveBeenCalledTimes(1);
  });

  it("always releases the pool client even when a cleanup query throws", async () => {
    mockClient.query.mockImplementation(async (sql: string) => {
      if (/^\s*BEGIN\s*$/i.test(sql)) return { rows: [], rowCount: null };
      if (/^\s*ROLLBACK\s*$/i.test(sql)) return { rows: [], rowCount: null };
      throw new Error("boom");
    });

    await expect(runCleanup()).rejects.toThrow("boom");

    expect(mockClient.release).toHaveBeenCalledTimes(1);
  });
});

describe("runCleanupWithLock — distributed lock guard", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDbConnect.mockResolvedValue(mockClient);
    mockClient.release.mockReturnValue(undefined);
  });

  it("checks out a dedicated client from the pool rather than using pool.query", async () => {
    setupClientMock({ acquired: true });

    await runCleanupWithLock();

    expect(mockDbConnect).toHaveBeenCalledTimes(1);
  });

  it("runs cleanup when the advisory lock is acquired", async () => {
    setupClientMock({ acquired: true });

    await runCleanupWithLock();

    const updateCall = mockClient.query.mock.calls.find(([sql]: [string]) =>
      /UPDATE\s+payment_links/i.test(sql),
    );
    expect(updateCall).toBeDefined();
  });

  it("skips cleanup when another instance holds the advisory lock", async () => {
    setupClientMock({ acquired: false });

    await runCleanupWithLock();

    const updateCall = mockClient.query.mock.calls.find(([sql]: [string]) =>
      /UPDATE\s+payment_links/i.test(sql),
    );
    expect(updateCall).toBeUndefined();
  });

  it("logs an info message when the lock is already held and the tick is skipped", async () => {
    setupClientMock({ acquired: false });

    await runCleanupWithLock();

    expect(vi.mocked(logger.info)).toHaveBeenCalledWith(
      expect.stringContaining("advisory lock"),
    );
  });

  it("releases the advisory lock after a successful cleanup", async () => {
    setupClientMock({ acquired: true });

    await runCleanupWithLock();

    const unlockCall = mockClient.query.mock.calls.find(([sql]: [string]) =>
      /pg_advisory_unlock/i.test(sql),
    );
    expect(unlockCall).toBeDefined();
  });

  it("releases the advisory lock even when cleanup throws", async () => {
    mockClient.query.mockImplementation(async (sql: string) => {
      if (/pg_try_advisory_lock/i.test(sql)) {
        return { rows: [{ acquired: true }], rowCount: 1 };
      }
      if (/pg_advisory_unlock/i.test(sql)) {
        return { rows: [], rowCount: 1 };
      }
      if (/^\s*(BEGIN|ROLLBACK)\s*$/i.test(sql)) {
        return { rows: [], rowCount: null };
      }
      throw new Error("db exploded");
    });

    await expect(runCleanupWithLock()).rejects.toThrow("db exploded");

    const unlockCall = mockClient.query.mock.calls.find(([sql]: [string]) =>
      /pg_advisory_unlock/i.test(sql),
    );
    expect(unlockCall).toBeDefined();
  });

  it("always releases the pool client back to the pool, even when the lock is not acquired", async () => {
    setupClientMock({ acquired: false });

    await runCleanupWithLock();

    expect(mockClient.release).toHaveBeenCalledTimes(1);
  });

  it("always releases the pool client back to the pool after a successful run", async () => {
    setupClientMock({ acquired: true });

    await runCleanupWithLock();

    expect(mockClient.release).toHaveBeenCalledTimes(1);
  });

  it("always releases the pool client even when cleanup throws", async () => {
    mockClient.query.mockImplementation(async (sql: string) => {
      if (/pg_try_advisory_lock/i.test(sql)) {
        return { rows: [{ acquired: true }], rowCount: 1 };
      }
      if (/pg_advisory_unlock/i.test(sql)) {
        return { rows: [], rowCount: 1 };
      }
      if (/^\s*(BEGIN|ROLLBACK)\s*$/i.test(sql)) {
        return { rows: [], rowCount: null };
      }
      throw new Error("db exploded");
    });

    await expect(runCleanupWithLock()).rejects.toThrow("db exploded");

    expect(mockClient.release).toHaveBeenCalledTimes(1);
  });

  it("passes the same lock ID to both pg_try_advisory_lock and pg_advisory_unlock", async () => {
    setupClientMock({ acquired: true });

    await runCleanupWithLock();

    const lockCall = mockClient.query.mock.calls.find(([sql]: [string]) =>
      /pg_try_advisory_lock/i.test(sql),
    );
    const unlockCall = mockClient.query.mock.calls.find(([sql]: [string]) =>
      /pg_advisory_unlock/i.test(sql),
    );

    expect(lockCall).toBeDefined();
    expect(unlockCall).toBeDefined();

    const [, lockParams] = lockCall as [string, unknown[]];
    const [, unlockParams] = unlockCall as [string, unknown[]];
    expect(lockParams[0]).toBe(unlockParams[0]);
  });

  it("wraps cleanup queries in a transaction — BEGIN issued before UPDATE, COMMIT after DELETE", async () => {
    const callOrder: string[] = [];

    mockClient.query.mockImplementation(async (sql: string) => {
      if (/pg_try_advisory_lock/i.test(sql)) return { rows: [{ acquired: true }], rowCount: 1 };
      if (/pg_advisory_unlock/i.test(sql)) return { rows: [{ pg_advisory_unlock: true }], rowCount: 1 };
      if (/^\s*BEGIN\s*$/i.test(sql)) callOrder.push("BEGIN");
      if (/UPDATE\s+payment_links/i.test(sql)) callOrder.push("UPDATE");
      if (/DELETE\s+FROM\s+payment_links/i.test(sql)) callOrder.push("DELETE");
      if (/^\s*COMMIT\s*$/i.test(sql)) callOrder.push("COMMIT");
      return { rows: [], rowCount: 0 };
    });

    await runCleanupWithLock();

    expect(callOrder).toEqual(["BEGIN", "UPDATE", "DELETE", "COMMIT"]);
  });

  it("sends ROLLBACK (not COMMIT) when a cleanup query throws under the lock", async () => {
    mockClient.query.mockImplementation(async (sql: string) => {
      if (/pg_try_advisory_lock/i.test(sql)) return { rows: [{ acquired: true }], rowCount: 1 };
      if (/pg_advisory_unlock/i.test(sql)) return { rows: [], rowCount: 1 };
      if (/^\s*(BEGIN|ROLLBACK)\s*$/i.test(sql)) return { rows: [], rowCount: null };
      throw new Error("timeout");
    });

    await expect(runCleanupWithLock()).rejects.toThrow("timeout");

    const rollbackCall = mockClient.query.mock.calls.find(([sql]: [string]) =>
      /^\s*ROLLBACK\s*$/i.test(sql),
    );
    const commitCall = mockClient.query.mock.calls.find(([sql]: [string]) =>
      /^\s*COMMIT\s*$/i.test(sql),
    );

    expect(rollbackCall).toBeDefined();
    expect(commitCall).toBeUndefined();
  });
});

describe("startPaymentLinkCleanupJob — tick error handling", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("calls logger.warn with the error when db.connect rejects during the scheduled tick", async () => {
    const dbError = new Error("db unavailable");
    mockDbConnect.mockRejectedValue(dbError);

    startPaymentLinkCleanupJob();

    await vi.advanceTimersByTimeAsync(30_000);

    expect(vi.mocked(logger.warn)).toHaveBeenCalledWith(
      { err: dbError },
      "Payment link cleanup job error",
    );
  });

  it("keeps scheduling future runs after a db error — the interval is not cancelled", async () => {
    const dbError = new Error("transient db error");
    mockDbConnect.mockRejectedValue(dbError);

    startPaymentLinkCleanupJob();

    await vi.advanceTimersByTimeAsync(30_000);
    const connectCallsAfterFirstTick = mockDbConnect.mock.calls.length;

    await vi.advanceTimersByTimeAsync(60 * 60 * 1000);
    const connectCallsAfterSecondTick = mockDbConnect.mock.calls.length;

    expect(connectCallsAfterFirstTick).toBeGreaterThan(0);
    expect(connectCallsAfterSecondTick).toBeGreaterThan(connectCallsAfterFirstTick);
    expect(vi.mocked(logger.warn)).toHaveBeenCalledTimes(2);
  });
});

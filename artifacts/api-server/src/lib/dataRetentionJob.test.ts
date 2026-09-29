import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import type { PoolClient } from "pg";

const mockDbConnect = vi.fn();
const mockLoggerInfo = vi.fn();
const mockLoggerError = vi.fn();

vi.mock("./db", () => ({
  db: { connect: (...args: unknown[]) => mockDbConnect(...args) },
}));

vi.mock("./logger", () => ({
  logger: {
    info: (...args: unknown[]) => mockLoggerInfo(...args),
    error: (...args: unknown[]) => mockLoggerError(...args),
    warn: vi.fn(),
  },
}));

import {
  RETENTION_DELETE_BATCH_SIZE,
  RETENTION_POLICY,
  runRetentionCleanup,
  runRetentionCleanupOnClient,
} from "./dataRetentionJob";

function metrics(
  liveRowCount: string,
  deadRowCount: string,
  totalBytes: string,
) {
  return {
    rows: [{
      live_row_count: liveRowCount,
      dead_row_count: deadRowCount,
      total_bytes: totalBytes,
    }],
    rowCount: 1,
  };
}

function makeClient(query: ReturnType<typeof vi.fn>) {
  return {
    query,
    release: vi.fn(),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("data retention cleanup", () => {
  it("uses separate business windows and preserves active webhook work", async () => {
    const query = vi.fn()
      .mockResolvedValueOnce({ rowCount: 0, rows: [] })
      .mockResolvedValueOnce(metrics("12", "2", "1200"))
      .mockResolvedValueOnce(metrics("20", "3", "2000"))
      .mockResolvedValueOnce({ rowCount: 3, rows: [] })
      .mockResolvedValueOnce({ rowCount: 4, rows: [] })
      .mockResolvedValueOnce(metrics("9", "1", "900"))
      .mockResolvedValueOnce(metrics("16", "2", "1600"))
      .mockResolvedValueOnce({ rowCount: 0, rows: [] });
    const client = makeClient(query);

    const result = await runRetentionCleanupOnClient(
      client as unknown as PoolClient,
    );

    expect(result.webhookDeliveries.deleted).toBe(3);
    expect(result.webEvents.deleted).toBe(4);
    expect(query).toHaveBeenNthCalledWith(
      4,
      expect.stringContaining("status IN ('delivered', 'failed')"),
      [
        RETENTION_POLICY.webhookDeliveryDays,
        RETENTION_DELETE_BATCH_SIZE,
      ],
    );
    expect(query).toHaveBeenNthCalledWith(
      5,
      expect.stringContaining("received_at < now()"),
      [RETENTION_POLICY.webEventDays, RETENTION_DELETE_BATCH_SIZE],
    );
    expect(query.mock.calls[3][0]).toContain("deliveries.created_at < now()");
    expect(query.mock.calls[3][0]).toContain("deliveries.status IN ('delivered', 'failed')");
    expect(query.mock.calls[3][0]).not.toContain("status NOT IN");
    expect(query).toHaveBeenCalledWith("COMMIT");
    expect(mockLoggerInfo).toHaveBeenCalledWith(
      expect.objectContaining({
        policy: RETENTION_POLICY,
        batchSize: RETENTION_DELETE_BATCH_SIZE,
      }),
      "data-retention cleanup completed",
    );
  });

  it("rolls back when a bounded delete fails", async () => {
    const query = vi.fn()
      .mockResolvedValueOnce({ rowCount: 0, rows: [] })
      .mockResolvedValueOnce(metrics("1", "0", "100"))
      .mockResolvedValueOnce(metrics("1", "0", "100"))
      .mockRejectedValueOnce(new Error("database unavailable"));
    const client = makeClient(query);

    await expect(
      runRetentionCleanupOnClient(client as unknown as PoolClient),
    ).rejects.toThrow("database unavailable");
    expect(query).toHaveBeenCalledWith("ROLLBACK");
    expect(query).not.toHaveBeenCalledWith("COMMIT");
  });

  it("skips the pass when another API instance owns the lock", async () => {
    const query = vi.fn().mockResolvedValueOnce({
      rows: [{ acquired: false }],
      rowCount: 1,
    });
    const client = makeClient(query);
    mockDbConnect.mockResolvedValueOnce(client);

    await expect(runRetentionCleanup()).resolves.toBeNull();

    expect(query).toHaveBeenCalledTimes(1);
    expect(client.release).toHaveBeenCalledOnce();
    expect(mockLoggerInfo).toHaveBeenCalledWith(
      "data-retention cleanup skipped — another instance holds the advisory lock",
    );
  });
});
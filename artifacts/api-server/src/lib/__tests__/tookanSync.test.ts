import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockDbQuery, mockRelease } = vi.hoisted(() => ({
  mockDbQuery: vi.fn(),
  mockRelease: vi.fn(),
}));

vi.mock("../db", () => ({
  db: {
    connect: vi.fn().mockResolvedValue({
      query: (...args: unknown[]) => mockDbQuery(...args),
      release: mockRelease,
    }),
  },
}));

import { syncTookanOrderStatus, parseTookanCompletionDatetime } from "../tookan";

const orderRow = {
  id: "ord-1",
  status: "out_for_delivery",
  workspace_owner_id: "owner_1",
  external_order_id: "EXT-1",
};

beforeEach(() => {
  mockDbQuery.mockReset();
  mockDbQuery.mockResolvedValue({ rows: [], rowCount: 0 });
  mockRelease.mockClear();
});

function mockOrderLookup(row: typeof orderRow): void {
  mockDbQuery.mockImplementation((sql: unknown) => {
    if (typeof sql === "string" && sql.includes("WHERE tookan_job_id = $1")) {
      return Promise.resolve({ rows: [row], rowCount: 1 });
    }
    return Promise.resolve({ rows: [], rowCount: 0 });
  });
}

function findQuery(fragment: string): [string, unknown[]] {
  const call = mockDbQuery.mock.calls.find(
    ([sql]) => typeof sql === "string" && sql.includes(fragment),
  );
  expect(call).toBeDefined();
  return call as [string, unknown[]];
}

describe("parseTookanCompletionDatetime", () => {
  it("parses completed_datetime_gmt in 'YYYY-MM-DD HH:mm:ss' as UTC", () => {
    expect(
      parseTookanCompletionDatetime({ completed_datetime_gmt: "2026-07-08 14:30:00" }),
    ).toBe("2026-07-08T14:30:00.000Z");
  });

  it("parses an ISO completed_datetime", () => {
    expect(
      parseTookanCompletionDatetime({ completed_datetime: "2026-07-08T14:30:00.000Z" }),
    ).toBe("2026-07-08T14:30:00.000Z");
  });

  it("skips a zone-ambiguous plain completed_datetime (no GMT variant)", () => {
    expect(
      parseTookanCompletionDatetime({ completed_datetime: "2026-07-08 14:30:00" }),
    ).toBeNull();
  });

  it("returns null for missing/empty/garbage payloads", () => {
    expect(parseTookanCompletionDatetime(null)).toBeNull();
    expect(parseTookanCompletionDatetime({})).toBeNull();
    expect(parseTookanCompletionDatetime({ completed_datetime: "not-a-date" })).toBeNull();
  });
});

describe("syncTookanOrderStatus delivered-at capture", () => {
  it("sets tookan_delivered_at from the provided completion time on successful (status 2)", async () => {
    mockOrderLookup(orderRow);

    const result = await syncTookanOrderStatus("job-1", 2, "2026-07-08T10:00:00.000Z");
    expect(result.newStatus).toBe("completed");

    const [sql, params] = findQuery("SET status = $1");
    expect(sql).toContain("tookan_delivered_at = COALESCE(tookan_delivered_at, $3)");
    expect(params).toEqual([
      "completed",
      "successful",
      "2026-07-08T10:00:00.000Z",
      "ord-1",
      "owner_1",
    ]);

    const [floristSql, floristParams] = findQuery("UPDATE order_florist_assignments");
    expect(floristSql).toContain("UPDATE order_florist_assignments");
    expect(floristSql).toContain("completed_at = COALESCE(completed_at, now())");
    expect(floristSql).toContain("AND workspace_owner_id = $2");
    expect(floristSql).toContain("AND status <> 'completed'");
    expect(floristParams).toEqual(["ord-1", "owner_1"]);
  });

  it("falls back to the sync time when no completion time is provided", async () => {
    mockOrderLookup(orderRow);

    const before = Date.now();
    await syncTookanOrderStatus("job-1", 2);
    const after = Date.now();

    const params = findQuery("SET status = $1")[1];
    const ts = new Date(params[2] as string).getTime();
    expect(ts).toBeGreaterThanOrEqual(before);
    expect(ts).toBeLessThanOrEqual(after);
  });

  it("falls back to the sync time when the provided completion time is invalid", async () => {
    mockOrderLookup(orderRow);

    await syncTookanOrderStatus("job-1", 2, "garbage");
    const params = findQuery("SET status = $1")[1];
    expect(Number.isNaN(new Date(params[2] as string).getTime())).toBe(false);
  });

  it("passes NULL delivered-at for non-successful statuses (COALESCE keeps existing value)", async () => {
    mockOrderLookup(orderRow);

    await syncTookanOrderStatus("job-1", 1, "2026-07-08T10:00:00.000Z");
    const [sql, params] = findQuery("SET tookan_status = $1");
    expect(sql).toContain("tookan_delivered_at = COALESCE(tookan_delivered_at,");
    expect(params).toContain(null);
    expect(
      mockDbQuery.mock.calls.some(
        ([candidate]) =>
          typeof candidate === "string" &&
          candidate.includes("UPDATE order_florist_assignments"),
      ),
    ).toBe(false);
  });

  it("still writes delivered-at when the order is already completed (no status transition)", async () => {
    mockOrderLookup({ ...orderRow, status: "completed" });

    const result = await syncTookanOrderStatus("job-1", 2, "2026-07-08T10:00:00.000Z");
    expect(result.newStatus).toBeNull();

    // No-transition branch: UPDATE sets label + COALESCE'd delivered-at only.
    const [sql, params] = findQuery("SET tookan_status = $1");
    expect(sql).toContain("SET tookan_status = $1");
    expect(sql).toContain("tookan_delivered_at = COALESCE(tookan_delivered_at, $2)");
    expect(params).toEqual([
      "successful",
      "2026-07-08T10:00:00.000Z",
      "ord-1",
      "owner_1",
    ]);

    const [floristSql, floristParams] = findQuery("UPDATE order_florist_assignments");
    expect(floristSql).toContain("UPDATE order_florist_assignments");
    expect(floristParams).toEqual(["ord-1", "owner_1"]);
  });

  it("rolls back both updates when florist completion fails", async () => {
    mockDbQuery.mockImplementation((sql: unknown) => {
      if (typeof sql === "string" && sql.includes("WHERE tookan_job_id = $1")) {
        return Promise.resolve({ rows: [orderRow], rowCount: 1 });
      }
      if (
        typeof sql === "string" &&
        sql.includes("UPDATE order_florist_assignments")
      ) {
        return Promise.reject(new Error("assignment update failed"));
      }
      return Promise.resolve({ rows: [], rowCount: 0 });
    });

    await expect(syncTookanOrderStatus("job-1", 2)).rejects.toThrow(
      "assignment update failed",
    );
    expect(mockDbQuery.mock.calls.map(([sql]) => sql)).toContain("ROLLBACK");
    expect(mockDbQuery.mock.calls.map(([sql]) => sql)).not.toContain("COMMIT");
    expect(mockRelease).toHaveBeenCalledOnce();
  });

  it("refuses an ambiguous Tookan job id without updating either order", async () => {
    mockDbQuery.mockImplementation((sql: unknown) => {
      if (typeof sql === "string" && sql.includes("WHERE tookan_job_id = $1")) {
        return Promise.resolve({
          rows: [orderRow, { ...orderRow, id: "ord-2", workspace_owner_id: "owner_2" }],
          rowCount: 2,
        });
      }
      return Promise.resolve({ rows: [], rowCount: 0 });
    });

    await expect(syncTookanOrderStatus("job-1", 2)).rejects.toThrow(
      "Multiple orders share Tookan job id",
    );
    expect(
      mockDbQuery.mock.calls.some(
        ([sql]) => typeof sql === "string" && sql.includes("UPDATE orders"),
      ),
    ).toBe(false);
    expect(
      mockDbQuery.mock.calls.some(
        ([sql]) =>
          typeof sql === "string" &&
          sql.includes("UPDATE order_florist_assignments"),
      ),
    ).toBe(false);
  });
});

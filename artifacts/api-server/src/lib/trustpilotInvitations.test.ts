import { describe, it, expect, vi, beforeEach } from "vitest";

const mockDbQuery = vi.fn();
vi.mock("./db", () => ({
  db: { query: (...args: unknown[]) => mockDbQuery(...args) },
}));

vi.mock("./logger", () => ({
  logger: { error: vi.fn(), info: vi.fn(), warn: vi.fn() },
}));

const mockIsEnabled = vi.fn();
const mockCreateInvitation = vi.fn();
const mockIsRetryable = vi.fn();

vi.mock("./trustpilot", () => ({
  isTrustpilotEnabled: (...args: unknown[]) => mockIsEnabled(...args),
  createTrustpilotInvitation: (...args: unknown[]) => mockCreateInvitation(...args),
  isRetryableTrustpilotError: (...args: unknown[]) => mockIsRetryable(...args),
  resolveTrustpilotLocale: () => "en-US",
  computePreferredSendTime: () => "2026-07-02T10:00:00.000Z",
  TrustpilotApiError: class TrustpilotApiError extends Error {
    status: number;
    body: string;
    constructor(message: string, status = 0, body = "") {
      super(message);
      this.status = status;
      this.body = body;
    }
  },
}));

import {
  maybeEnqueueTrustpilotInvitation,
  processTrustpilotInvitation,
  runTrustpilotInvitationSweep,
  backoffMinutesForAttempt,
  MAX_TRUSTPILOT_ATTEMPTS,
} from "./trustpilotInvitations";

const ORDER_ID = "11111111-1111-1111-1111-111111111111";
const INV_ID = "22222222-2222-2222-2222-222222222222";

const baseOrderRow = {
  id: ORDER_ID,
  workspace_owner_id: "owner_1",
  display_order_number: "lb-1001",
  external_order_id: null,
  channel: "web",
  delivery_address: { country: "Lebanon" },
  tookan_delivered_at: "2026-07-01T10:00:00Z",
  customer_email: "a@b.com",
  customer_name: "Alice",
  trustpilot_invitations_enabled: true,
};

beforeEach(() => {
  vi.clearAllMocks();
  mockIsEnabled.mockReturnValue(true);
});

describe("maybeEnqueueTrustpilotInvitation", () => {
  it("returns disabled when the master switch is off (no DB access)", async () => {
    mockIsEnabled.mockReturnValue(false);
    const outcome = await maybeEnqueueTrustpilotInvitation(ORDER_ID, "out_for_delivery", "completed");
    expect(outcome).toBe("disabled");
    expect(mockDbQuery).not.toHaveBeenCalled();
  });

  it("ignores transitions that are not into completed", async () => {
    expect(await maybeEnqueueTrustpilotInvitation(ORDER_ID, "pending", "processing")).toBe(
      "not_completion",
    );
    expect(await maybeEnqueueTrustpilotInvitation(ORDER_ID, "completed", "completed")).toBe(
      "not_completion",
    );
    expect(mockDbQuery).not.toHaveBeenCalled();
  });

  it("enqueues a pending invitation on a genuine completion", async () => {
    mockDbQuery
      .mockResolvedValueOnce({ rows: [baseOrderRow], rowCount: 1 }) // order lookup
      .mockResolvedValueOnce({ rows: [{ id: INV_ID }], rowCount: 1 }) // insert
      .mockResolvedValue({ rows: [], rowCount: 0 }); // async processing claim

    const outcome = await maybeEnqueueTrustpilotInvitation(ORDER_ID, "out_for_delivery", "completed");
    expect(outcome).toBe("enqueued");
    const insertSql = mockDbQuery.mock.calls[1][0] as string;
    expect(insertSql).toContain("ON CONFLICT (order_id) DO NOTHING");
    expect(mockDbQuery.mock.calls[1][1]).toEqual([
      ORDER_ID,
      "owner_1",
      "a@b.com",
      "Alice",
      "lb-1001",
      "en-US",
      "2026-07-02T10:00:00.000Z",
    ]);
  });

  it("returns duplicate when a row already exists", async () => {
    mockDbQuery
      .mockResolvedValueOnce({ rows: [baseOrderRow], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 });
    expect(await maybeEnqueueTrustpilotInvitation(ORDER_ID, "pending", "completed")).toBe(
      "duplicate",
    );
  });

  it("records skipped when the customer has no email", async () => {
    mockDbQuery
      .mockResolvedValueOnce({
        rows: [{ ...baseOrderRow, customer_email: null }],
        rowCount: 1,
      })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 });
    expect(await maybeEnqueueTrustpilotInvitation(ORDER_ID, "pending", "completed")).toBe(
      "skipped",
    );
    const sql = mockDbQuery.mock.calls[1][0] as string;
    expect(sql).toContain("'skipped'");
  });

  it("respects the workspace toggle when explicitly off", async () => {
    mockDbQuery.mockResolvedValueOnce({
      rows: [{ ...baseOrderRow, trustpilot_invitations_enabled: false }],
      rowCount: 1,
    });
    expect(await maybeEnqueueTrustpilotInvitation(ORDER_ID, "pending", "completed")).toBe(
      "workspace_disabled",
    );
    expect(mockDbQuery).toHaveBeenCalledTimes(1);
  });

  it("treats a missing settings row as enabled", async () => {
    mockDbQuery
      .mockResolvedValueOnce({
        rows: [{ ...baseOrderRow, trustpilot_invitations_enabled: null }],
        rowCount: 1,
      })
      .mockResolvedValueOnce({ rows: [{ id: INV_ID }], rowCount: 1 })
      .mockResolvedValue({ rows: [], rowCount: 0 });
    expect(await maybeEnqueueTrustpilotInvitation(ORDER_ID, "pending", "completed")).toBe(
      "enqueued",
    );
  });

  it("never throws on unexpected DB errors", async () => {
    mockDbQuery.mockRejectedValueOnce(new Error("boom"));
    expect(await maybeEnqueueTrustpilotInvitation(ORDER_ID, "pending", "completed")).toBe("error");
  });
});

const claimedRow = {
  id: INV_ID,
  order_id: ORDER_ID,
  workspace_owner_id: "owner_1",
  recipient_email: "a@b.com",
  recipient_name: "Alice",
  reference_id: "lb-1001",
  locale: "en-US",
  preferred_send_time: "2026-07-02T10:00:00.000Z",
  attempt_count: 0,
  channel: "web",
  delivery_address: { country: "Lebanon" },
};

describe("processTrustpilotInvitation", () => {
  it("does nothing when the claim matches no row", async () => {
    mockDbQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    await processTrustpilotInvitation(INV_ID);
    expect(mockDbQuery).toHaveBeenCalledTimes(1);
    expect(mockCreateInvitation).not.toHaveBeenCalled();
  });

  it("marks created on success with the returned invitation id", async () => {
    mockDbQuery
      .mockResolvedValueOnce({ rows: [claimedRow], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 });
    mockCreateInvitation.mockResolvedValueOnce({
      invitationId: "tp-1",
      responsePayload: { ok: true },
    });
    await processTrustpilotInvitation(INV_ID);
    expect(mockCreateInvitation).toHaveBeenCalledWith(
      expect.objectContaining({
        email: "a@b.com",
        referenceId: "lb-1001",
        locale: "en-US",
        tags: ["Lebanon", "web"],
      }),
    );
    const updateSql = mockDbQuery.mock.calls[1][0] as string;
    expect(updateSql).toContain("'created'");
    expect(mockDbQuery.mock.calls[1][1][0]).toBe("tp-1");
  });

  it("re-schedules with backoff on retryable failure", async () => {
    mockDbQuery
      .mockResolvedValueOnce({ rows: [claimedRow], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 });
    mockCreateInvitation.mockRejectedValueOnce(new Error("429"));
    mockIsRetryable.mockReturnValueOnce(true);
    await processTrustpilotInvitation(INV_ID);
    const updateSql = mockDbQuery.mock.calls[1][0] as string;
    expect(updateSql).toContain("'pending'");
    expect(mockDbQuery.mock.calls[1][1][0]).toBe(1); // attempt_count
  });

  it("fails permanently on non-retryable errors", async () => {
    mockDbQuery
      .mockResolvedValueOnce({ rows: [claimedRow], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 });
    mockCreateInvitation.mockRejectedValueOnce(new Error("400 bad request"));
    mockIsRetryable.mockReturnValueOnce(false);
    await processTrustpilotInvitation(INV_ID);
    const updateSql = mockDbQuery.mock.calls[1][0] as string;
    expect(updateSql).toContain("'failed'");
  });

  it("fails permanently once max attempts are exhausted even if retryable", async () => {
    mockDbQuery
      .mockResolvedValueOnce({
        rows: [{ ...claimedRow, attempt_count: MAX_TRUSTPILOT_ATTEMPTS - 1 }],
        rowCount: 1,
      })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 });
    mockCreateInvitation.mockRejectedValueOnce(new Error("503"));
    mockIsRetryable.mockReturnValueOnce(true);
    await processTrustpilotInvitation(INV_ID);
    const updateSql = mockDbQuery.mock.calls[1][0] as string;
    expect(updateSql).toContain("'failed'");
  });

  it("skips rows missing a recipient email", async () => {
    mockDbQuery
      .mockResolvedValueOnce({
        rows: [{ ...claimedRow, recipient_email: null }],
        rowCount: 1,
      })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 });
    await processTrustpilotInvitation(INV_ID);
    expect(mockCreateInvitation).not.toHaveBeenCalled();
    const updateSql = mockDbQuery.mock.calls[1][0] as string;
    expect(updateSql).toContain("'skipped'");
  });
});

describe("runTrustpilotInvitationSweep", () => {
  it("does nothing when disabled", async () => {
    mockIsEnabled.mockReturnValue(false);
    await runTrustpilotInvitationSweep();
    expect(mockDbQuery).not.toHaveBeenCalled();
  });

  it("processes every due row", async () => {
    mockDbQuery
      .mockResolvedValueOnce({ rows: [{ id: "a" }, { id: "b" }], rowCount: 2 }) // due query
      .mockResolvedValue({ rows: [], rowCount: 0 }); // claims find nothing
    await runTrustpilotInvitationSweep();
    // 1 due query + 2 claim attempts
    expect(mockDbQuery).toHaveBeenCalledTimes(3);
  });
});

describe("backoffMinutesForAttempt", () => {
  it("follows the escalating schedule and clamps at the end", () => {
    expect(backoffMinutesForAttempt(1)).toBe(1);
    expect(backoffMinutesForAttempt(2)).toBe(5);
    expect(backoffMinutesForAttempt(3)).toBe(15);
    expect(backoffMinutesForAttempt(4)).toBe(60);
    expect(backoffMinutesForAttempt(5)).toBe(240);
    expect(backoffMinutesForAttempt(99)).toBe(240);
  });
});

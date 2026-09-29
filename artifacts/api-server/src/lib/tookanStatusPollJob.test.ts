import { describe, it, expect, vi, beforeEach } from "vitest";
import { runTookanStatusPoll } from "./tookanStatusPollJob";
import { db } from "./db";
import {
  isTookanEnabled,
  getTookanJobStatuses,
  syncTookanOrderStatus,
} from "./tookan";
import { fireWebhookEvent } from "./catalogWebhook";
import { notifyOrderStatusEmail, recordOrderEvent } from "../routes/orders";

vi.mock("./orderWhatsappNotify", () => ({
  notifyOrderStatusWhatsApp: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("./db", () => ({ db: { query: vi.fn() } }));
vi.mock("./tookan", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./tookan")>();
  return {
    ...actual,
    isTookanEnabled: vi.fn(),
    getTookanJobStatuses: vi.fn(),
    syncTookanOrderStatus: vi.fn(),
  };
});
vi.mock("./catalogWebhook", () => ({ fireWebhookEvent: vi.fn() }));
vi.mock("../routes/orders", () => ({
  recordOrderEvent: vi.fn(),
  notifyOrderStatusEmail: vi.fn().mockResolvedValue(undefined),
}));

const mockDbQuery = vi.mocked(db.query);
const mockEnabled = vi.mocked(isTookanEnabled);
const mockGetStatuses = vi.mocked(getTookanJobStatuses);
const mockSync = vi.mocked(syncTookanOrderStatus);
const mockFireWebhook = vi.mocked(fireWebhookEvent);
const mockRecordEvent = vi.mocked(recordOrderEvent);
const mockNotifyEmail = vi.mocked(notifyOrderStatusEmail);

beforeEach(() => {
  vi.clearAllMocks();
  // The poll reads both orders and branch requests. Keep the second query
  // harmless for tests that only configure the orders result.
  mockDbQuery.mockResolvedValue({ rows: [], rowCount: 0 } as never);
  mockEnabled.mockReturnValue(true);
  mockFireWebhook.mockResolvedValue(undefined as never);
  mockNotifyEmail.mockResolvedValue(undefined);
});

describe("runTookanStatusPoll", () => {
  it("does nothing when Tookan is disabled", async () => {
    mockEnabled.mockReturnValue(false);
    await runTookanStatusPoll();
    expect(mockDbQuery).not.toHaveBeenCalled();
    expect(mockGetStatuses).not.toHaveBeenCalled();
  });

  it("does not call Tookan when no active orders have a job id", async () => {
    mockDbQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 } as never);
    await runTookanStatusPoll();
    expect(mockGetStatuses).not.toHaveBeenCalled();
  });

  it("syncs orders whose Tookan status label changed and fires side effects", async () => {
    mockDbQuery.mockResolvedValueOnce({
      rows: [
        // unchanged: still unassigned on both sides → skipped
        {
          id: "order-1",
          tookan_job_id: "111",
          status: "processing",
          tookan_status: "unassigned",
        },
        // changed: Tookan now reports assigned (0) → synced
        {
          id: "order-2",
          tookan_job_id: "222",
          status: "processing",
          tookan_status: "unassigned",
        },
      ],
      rowCount: 2,
    } as never);
    mockGetStatuses.mockResolvedValueOnce([
      { jobId: "111", jobStatus: 6, completedAt: null },
      { jobId: "222", jobStatus: 0, completedAt: null },
    ]);
    mockSync.mockResolvedValueOnce({
      matched: true,
      newStatus: "out_for_delivery",
      previousStatus: "processing",
      orderId: "order-2",
      externalOrderId: "LB-1175",
      workspaceOwnerId: "ws-1",
    });

    await runTookanStatusPoll();

    expect(mockGetStatuses).toHaveBeenCalledWith(["111", "222"]);
    expect(mockSync).toHaveBeenCalledTimes(1);
    expect(mockSync).toHaveBeenCalledWith("222", 0, null);
    expect(mockRecordEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceOwnerId: "ws-1",
        orderId: "order-2",
        eventType: "status_changed",
        payload: expect.objectContaining({ source: "tookan_poll" }),
      }),
    );
    expect(mockFireWebhook).toHaveBeenCalledWith(
      "order.status_updated",
      "ws-1",
      expect.objectContaining({
        orderId: "order-2",
        appOrderId: "LB-1175",
        status: "out_for_delivery",
      }),
    );
    expect(mockNotifyEmail).toHaveBeenCalledTimes(1);
    expect(mockNotifyEmail).toHaveBeenCalledWith(
      "order-2",
      "LB-1175",
      "out_for_delivery",
      "ws-1",
    );
  });

  it("records only the label (no side effects) when sync applies no order-status change", async () => {
    mockDbQuery.mockResolvedValueOnce({
      rows: [
        {
          id: "order-3",
          tookan_job_id: "333",
          status: "out_for_delivery",
          tookan_status: "assigned",
        },
      ],
      rowCount: 1,
    } as never);
    mockGetStatuses.mockResolvedValueOnce([{ jobId: "333", jobStatus: 1, completedAt: null }]);
    mockSync.mockResolvedValueOnce({
      matched: true,
      newStatus: null,
      previousStatus: "out_for_delivery",
      orderId: "order-3",
      externalOrderId: null,
      workspaceOwnerId: "ws-1",
    });

    await runTookanStatusPoll();

    expect(mockSync).toHaveBeenCalledWith("333", 1, null);
    expect(mockRecordEvent).not.toHaveBeenCalled();
    expect(mockFireWebhook).not.toHaveBeenCalled();
    expect(mockNotifyEmail).not.toHaveBeenCalled();
  });

  it("emails the customer when the poll marks the order delivered", async () => {
    mockDbQuery.mockResolvedValueOnce({
      rows: [
        {
          id: "order-6",
          tookan_job_id: "666",
          status: "out_for_delivery",
          tookan_status: "started",
        },
      ],
      rowCount: 1,
    } as never);
    mockGetStatuses.mockResolvedValueOnce([
      { jobId: "666", jobStatus: 2, completedAt: "2026-07-15T10:00:00.000Z" },
    ]);
    mockSync.mockResolvedValueOnce({
      matched: true,
      newStatus: "completed",
      previousStatus: "out_for_delivery",
      orderId: "order-6",
      externalOrderId: null,
      workspaceOwnerId: "ws-1",
    });

    await runTookanStatusPoll();

    expect(mockNotifyEmail).toHaveBeenCalledWith(
      "order-6",
      "order-6",
      "completed",
      "ws-1",
    );
  });

  it("does not fail the poll when the status email rejects", async () => {
    mockDbQuery.mockResolvedValueOnce({
      rows: [
        {
          id: "order-7",
          tookan_job_id: "777",
          status: "processing",
          tookan_status: "unassigned",
        },
      ],
      rowCount: 1,
    } as never);
    mockGetStatuses.mockResolvedValueOnce([{ jobId: "777", jobStatus: 0, completedAt: null }]);
    mockSync.mockResolvedValueOnce({
      matched: true,
      newStatus: "out_for_delivery",
      previousStatus: "processing",
      orderId: "order-7",
      externalOrderId: null,
      workspaceOwnerId: "ws-1",
    });
    mockNotifyEmail.mockRejectedValueOnce(new Error("email down"));

    await expect(runTookanStatusPoll()).resolves.toBeUndefined();
    expect(mockRecordEvent).toHaveBeenCalledTimes(1);
  });

  it("continues past a per-job sync failure", async () => {
    mockDbQuery.mockResolvedValueOnce({
      rows: [
        {
          id: "order-4",
          tookan_job_id: "444",
          status: "processing",
          tookan_status: "unassigned",
        },
        {
          id: "order-5",
          tookan_job_id: "555",
          status: "processing",
          tookan_status: "unassigned",
        },
      ],
      rowCount: 2,
    } as never);
    mockGetStatuses.mockResolvedValueOnce([
      { jobId: "444", jobStatus: 0, completedAt: null },
      { jobId: "555", jobStatus: 0, completedAt: null },
    ]);
    mockSync
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValueOnce({
        matched: true,
        newStatus: "out_for_delivery",
        previousStatus: "processing",
        orderId: "order-5",
        externalOrderId: null,
        workspaceOwnerId: "ws-1",
      });

    await runTookanStatusPoll();

    expect(mockSync).toHaveBeenCalledTimes(2);
    expect(mockRecordEvent).toHaveBeenCalledTimes(1);
    expect(mockRecordEvent).toHaveBeenCalledWith(
      expect.objectContaining({ orderId: "order-5" }),
    );
  });
});

import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";
import express from "express";
import request from "supertest";

vi.mock("../lib/orderWhatsappNotify", () => ({
  notifyOrderStatusWhatsApp: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../lib/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock("../lib/tookan", () => ({
  parseTookanCompletionDatetime: vi.fn().mockReturnValue(null),
  syncTookanOrderStatus: vi.fn(),
  syncTookanBranchRequestStatus: vi.fn(),
}));
vi.mock("../lib/catalogWebhook", () => ({ fireWebhookEvent: vi.fn() }));
vi.mock("./orders", () => ({
  recordOrderEvent: vi.fn(),
  notifyOrderStatusEmail: vi.fn().mockResolvedValue(undefined),
}));

import tookanWebhookRouter from "./tookanWebhook";
import { syncTookanOrderStatus, syncTookanBranchRequestStatus } from "../lib/tookan";
import { fireWebhookEvent } from "../lib/catalogWebhook";
import { notifyOrderStatusEmail, recordOrderEvent } from "./orders";

const mockSync = vi.mocked(syncTookanOrderStatus);
const mockBranchSync = vi.mocked(syncTookanBranchRequestStatus);
const mockFireWebhook = vi.mocked(fireWebhookEvent);
const mockRecordEvent = vi.mocked(recordOrderEvent);
const mockNotifyEmail = vi.mocked(notifyOrderStatusEmail);

const NO_ORDER_MATCH = {
  matched: false, newStatus: null, previousStatus: null,
  orderId: null, externalOrderId: null, workspaceOwnerId: null,
};
const NO_BRANCH_MATCH = {
  matched: false, newStatus: null, previousStatus: null,
  requestId: null, workspaceOwnerId: null,
};

const SECRET = "test-secret";
const prevSecret = process.env.TOOKAN_WEBHOOK_SECRET;
process.env.TOOKAN_WEBHOOK_SECRET = SECRET;

afterAll(() => {
  if (prevSecret === undefined) delete process.env.TOOKAN_WEBHOOK_SECRET;
  else process.env.TOOKAN_WEBHOOK_SECRET = prevSecret;
});

const app = express();
app.use(express.json());
app.use("/api", tookanWebhookRouter);

function post(body: Record<string, unknown>) {
  return request(app)
    .post("/api/webhooks/tookan")
    .set("x-tookan-webhook-secret", SECRET)
    .send(body);
}

beforeEach(() => {
  vi.clearAllMocks();
  mockFireWebhook.mockResolvedValue(undefined as never);
  mockNotifyEmail.mockResolvedValue(undefined);
  // Default: branch-request lookup finds nothing — existing order tests unaffected.
  mockBranchSync.mockResolvedValue(NO_BRANCH_MATCH);
});

describe("webhook authentication", () => {
  it("rejects a valid secret supplied through the query string", async () => {
    const res = await request(app)
      .post(`/api/webhooks/tookan?secret=${SECRET}`)
      .send({ job_id: "query-secret-job", job_status: 2 });

    expect(res.status).toBe(401);
    expect(mockSync).not.toHaveBeenCalled();
    expect(mockBranchSync).not.toHaveBeenCalled();
  });

  it("accepts a valid secret supplied through the webhook header", async () => {
    mockSync.mockResolvedValueOnce(NO_ORDER_MATCH);

    const res = await request(app)
      .post("/api/webhooks/tookan")
      .set("x-tookan-webhook-secret", SECRET)
      .send({ job_id: "header-secret-job", job_status: 2 });

    expect(res.status).toBe(200);
    expect(mockSync).toHaveBeenCalledOnce();
  });
});

describe("POST /api/webhooks/tookan status emails", () => {
  it("emails the customer when the webhook moves the order out for delivery", async () => {
    mockSync.mockResolvedValueOnce({
      matched: true,
      newStatus: "out_for_delivery",
      previousStatus: "processing",
      orderId: "ord-1",
      externalOrderId: "LB-42",
      workspaceOwnerId: "ws-1",
    });

    const res = await post({ job_id: "111", job_status: 0 });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ received: true, matched: true, statusChanged: true });
    expect(mockNotifyEmail).toHaveBeenCalledTimes(1);
    expect(mockNotifyEmail).toHaveBeenCalledWith("ord-1", "LB-42", "out_for_delivery", "ws-1");
    expect(mockRecordEvent).toHaveBeenCalledTimes(1);
  });

  it("emails the customer when the webhook marks the order delivered", async () => {
    mockSync.mockResolvedValueOnce({
      matched: true,
      newStatus: "completed",
      previousStatus: "out_for_delivery",
      orderId: "ord-2",
      externalOrderId: null,
      workspaceOwnerId: "ws-1",
    });

    const res = await post({ job_id: "222", job_status: 2 });

    expect(res.status).toBe(200);
    expect(mockNotifyEmail).toHaveBeenCalledWith("ord-2", "ord-2", "completed", "ws-1");
  });

  it("sends no email on a repeat webhook with no status transition", async () => {
    mockSync.mockResolvedValueOnce({
      matched: true,
      newStatus: null,
      previousStatus: "completed",
      orderId: "ord-3",
      externalOrderId: null,
      workspaceOwnerId: "ws-1",
    });

    const res = await post({ job_id: "333", job_status: 2 });

    expect(res.status).toBe(200);
    expect(res.body.statusChanged).toBe(false);
    expect(mockNotifyEmail).not.toHaveBeenCalled();
    expect(mockRecordEvent).not.toHaveBeenCalled();
    expect(mockFireWebhook).not.toHaveBeenCalled();
  });

  it("sends no email when no order matches the job", async () => {
    mockSync.mockResolvedValueOnce({
      matched: false,
      newStatus: null,
      previousStatus: null,
      orderId: null,
      externalOrderId: null,
      workspaceOwnerId: null,
    });

    const res = await post({ job_id: "444", job_status: 2 });

    expect(res.status).toBe(200);
    expect(res.body.matched).toBe(false);
    expect(mockNotifyEmail).not.toHaveBeenCalled();
  });

  it("still returns 200 when the status email rejects (fire-and-forget)", async () => {
    mockSync.mockResolvedValueOnce({
      matched: true,
      newStatus: "completed",
      previousStatus: "out_for_delivery",
      orderId: "ord-5",
      externalOrderId: null,
      workspaceOwnerId: "ws-1",
    });
    mockNotifyEmail.mockRejectedValueOnce(new Error("email down"));

    const res = await post({ job_id: "555", job_status: 2 });

    expect(res.status).toBe(200);
    expect(res.body.statusChanged).toBe(true);
  });
});

describe("branch request sync", () => {
  it("returns matched:true, statusChanged:true when only a branch request matches", async () => {
    mockSync.mockResolvedValueOnce(NO_ORDER_MATCH);
    mockBranchSync.mockResolvedValueOnce({
      matched: true,
      newStatus: "dispatched",
      previousStatus: "submitted",
      requestId: "req-1",
      workspaceOwnerId: "ws-1",
    });

    const res = await post({ job_id: "job-br-1", job_status: 0 });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ received: true, matched: true, statusChanged: true });
  });

  it("returns statusChanged:false when the branch request is already terminal (newStatus null)", async () => {
    mockSync.mockResolvedValueOnce(NO_ORDER_MATCH);
    mockBranchSync.mockResolvedValueOnce({
      matched: true,
      newStatus: null,
      previousStatus: "received",
      requestId: "req-2",
      workspaceOwnerId: "ws-1",
    });

    const res = await post({ job_id: "job-br-2", job_status: 2 });

    expect(res.status).toBe(200);
    expect(res.body.matched).toBe(true);
    expect(res.body.statusChanged).toBe(false);
  });

  it("returns matched:false when neither order nor branch request matches", async () => {
    mockSync.mockResolvedValueOnce(NO_ORDER_MATCH);
    mockBranchSync.mockResolvedValueOnce(NO_BRANCH_MATCH);

    const res = await post({ job_id: "job-nobody", job_status: 0 });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ received: true, matched: false });
  });

  it("duplicate status-2 webhook on a received request is a safe no-op (200, statusChanged:false)", async () => {
    mockSync.mockResolvedValueOnce(NO_ORDER_MATCH);
    mockBranchSync.mockResolvedValueOnce({
      matched: true,
      newStatus: null,
      previousStatus: "received",
      requestId: "req-3",
      workspaceOwnerId: "ws-1",
    });

    const res = await post({ job_id: "job-dup", job_status: 2 });

    expect(res.status).toBe(200);
    expect(res.body.matched).toBe(true);
    expect(res.body.statusChanged).toBe(false);
    // No side effects (no order emails, no audit events)
    expect(mockNotifyEmail).not.toHaveBeenCalled();
    expect(mockRecordEvent).not.toHaveBeenCalled();
  });
});

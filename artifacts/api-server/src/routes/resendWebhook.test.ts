import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";

const mockDbQuery = vi.fn();

vi.mock("../lib/db", () => ({
  db: {
    query: (...args: unknown[]) => mockDbQuery(...args),
  },
}));

vi.mock("../lib/logger", () => ({
  logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

const mockVerify = vi.fn();
vi.mock("svix", () => ({
  Webhook: class {
    verify(...args: unknown[]) {
      return mockVerify(...args);
    }
  },
}));

import resendWebhookRouter from "./resendWebhook";

function buildApp() {
  const app = express();
  app.use((req, _res, next) => {
    let chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      (req as express.Request & { rawBody?: Buffer }).rawBody =
        Buffer.concat(chunks);
      next();
    });
  });
  app.use("/api", resendWebhookRouter);
  return app;
}

const SVIX_HEADERS = {
  "svix-id": "msg_evt_1",
  "svix-timestamp": "1700000000",
  "svix-signature": "v1,abc",
};

const commRow = {
  id: "comm1",
  workspace_owner_id: "ws1",
  order_id: "ord1",
  template_type: "order_confirmation",
  recipient_email: "a@b.com",
  status: "sent",
  delivered_at: null,
  opened_at: null,
  clicked_at: null,
};

function deliveredPayload(overrides?: Record<string, unknown>) {
  return {
    type: "email.delivered",
    created_at: "2026-07-17T10:00:00Z",
    data: { email_id: "re_msg_1", to: ["a@b.com"], subject: "Your order" },
    ...overrides,
  };
}

beforeEach(() => {
  mockDbQuery.mockReset();
  mockVerify.mockReset();
  process.env.RESEND_WEBHOOK_SECRET = "whsec_test";
});

describe("POST /api/webhooks/resend", () => {
  it("returns 503 when the webhook secret is not configured", async () => {
    delete process.env.RESEND_WEBHOOK_SECRET;
    const res = await request(buildApp())
      .post("/api/webhooks/resend")
      .set(SVIX_HEADERS)
      .send({});
    expect(res.status).toBe(503);
  });

  it("returns 400 when svix headers are missing", async () => {
    const res = await request(buildApp())
      .post("/api/webhooks/resend")
      .send({ hello: 1 });
    expect(res.status).toBe(400);
  });

  it("returns 400 on signature verification failure", async () => {
    mockVerify.mockImplementation(() => {
      throw new Error("bad signature");
    });
    const res = await request(buildApp())
      .post("/api/webhooks/resend")
      .set(SVIX_HEADERS)
      .send(deliveredPayload());
    expect(res.status).toBe(400);
    expect(mockDbQuery).not.toHaveBeenCalled();
  });

  it("acknowledges irrelevant event types without touching the DB", async () => {
    mockVerify.mockReturnValue({ type: "contact.created", data: {} });
    const res = await request(buildApp())
      .post("/api/webhooks/resend")
      .set(SVIX_HEADERS)
      .send({});
    expect(res.status).toBe(200);
    expect(mockDbQuery).not.toHaveBeenCalled();
  });

  it("acknowledges unmatched email ids (untracked emails)", async () => {
    mockVerify.mockReturnValue(deliveredPayload());
    mockDbQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    const res = await request(buildApp())
      .post("/api/webhooks/resend")
      .set(SVIX_HEADERS)
      .send({});
    expect(res.status).toBe(200);
    expect(mockDbQuery).toHaveBeenCalledTimes(1);
  });

  it("upgrades sent → delivered, sets delivered_at once, records activity", async () => {
    mockVerify.mockReturnValue(deliveredPayload());
    mockDbQuery
      .mockResolvedValueOnce({ rows: [commRow], rowCount: 1 }) // lookup
      .mockResolvedValueOnce({ rows: [], rowCount: 1 }) // event insert
      .mockResolvedValueOnce({ rows: [], rowCount: 1 }) // update
      .mockResolvedValueOnce({ rows: [], rowCount: 0 }) // pg_notify (broadcastEvent, fire-and-forget)
      .mockResolvedValueOnce({ rows: [], rowCount: 1 }); // activity
    const res = await request(buildApp())
      .post("/api/webhooks/resend")
      .set(SVIX_HEADERS)
      .send({});
    expect(res.status).toBe(200);
    const updateSql = String(mockDbQuery.mock.calls[2][0]);
    expect(updateSql).toContain("status = $3");
    expect(updateSql).toContain("delivered_at = COALESCE(delivered_at, $2)");
    expect(mockDbQuery.mock.calls[2][1][2]).toBe("delivered");
    const activitySql = String(mockDbQuery.mock.calls[4][0]);
    expect(activitySql).toContain("order_events");
    expect(mockDbQuery.mock.calls[4][1][2]).toBe("email_delivered");
  });

  it("drops duplicate svix deliveries via the event-ledger conflict", async () => {
    mockVerify.mockReturnValue(deliveredPayload());
    mockDbQuery
      .mockResolvedValueOnce({ rows: [commRow], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 }); // conflict → no insert
    const res = await request(buildApp())
      .post("/api/webhooks/resend")
      .set(SVIX_HEADERS)
      .send({});
    expect(res.status).toBe(200);
    expect(res.body.duplicate).toBe(true);
    expect(mockDbQuery).toHaveBeenCalledTimes(2); // no update, no activity
  });

  it("never downgrades on out-of-order events but still sets timestamps once", async () => {
    mockVerify.mockReturnValue(deliveredPayload());
    mockDbQuery
      .mockResolvedValueOnce({
        rows: [{ ...commRow, status: "opened", opened_at: new Date() }],
        rowCount: 1,
      })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 }) // update (ts only)
      .mockResolvedValueOnce({ rows: [], rowCount: 1 }); // activity (first delivered)
    const res = await request(buildApp())
      .post("/api/webhooks/resend")
      .set(SVIX_HEADERS)
      .send({});
    expect(res.status).toBe(200);
    const updateSql = String(mockDbQuery.mock.calls[2][0]);
    expect(updateSql).not.toContain("status = $");
    expect(updateSql).toContain("delivered_at = COALESCE(delivered_at, $2)");
  });

  it("upgrades to bounced with failure reason and records email_bounced", async () => {
    mockVerify.mockReturnValue({
      type: "email.bounced",
      created_at: "2026-07-17T10:00:00Z",
      data: {
        email_id: "re_msg_1",
        bounce: { message: "mailbox full" },
      },
    });
    mockDbQuery
      .mockResolvedValueOnce({
        rows: [{ ...commRow, status: "delivered", delivered_at: new Date() }],
        rowCount: 1,
      })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 }) // pg_notify (broadcastEvent, fire-and-forget)
      .mockResolvedValueOnce({ rows: [], rowCount: 1 }); // activity
    const res = await request(buildApp())
      .post("/api/webhooks/resend")
      .set(SVIX_HEADERS)
      .send({});
    expect(res.status).toBe(200);
    const updateParams = mockDbQuery.mock.calls[2][1] as unknown[];
    expect(updateParams).toContain("bounced");
    expect(updateParams).toContain("mailbox full");
    expect(mockDbQuery.mock.calls[4][1][2]).toBe("email_bounced");
  });

  it("returns 200 even when DB processing throws (provider retries not desired)", async () => {
    mockVerify.mockReturnValue(deliveredPayload());
    mockDbQuery.mockRejectedValue(new Error("db down"));
    const res = await request(buildApp())
      .post("/api/webhooks/resend")
      .set(SVIX_HEADERS)
      .send({});
    expect(res.status).toBe(200);
  });
});

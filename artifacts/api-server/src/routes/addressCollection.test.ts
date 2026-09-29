import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";

const { mockDbQuery } = vi.hoisted(() => ({ mockDbQuery: vi.fn() }));

vi.mock("../lib/db", () => ({
  db: { query: (...args: unknown[]) => mockDbQuery(...args) },
}));

vi.mock("../lib/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import addressCollectionRouter from "./addressCollection";
import { generateAddressToken } from "../lib/addressCollector/tokens";

function makeApp() {
  const app = express();
  app.use(express.json());
  // Mounted under /api like production (see routes/index.ts).
  app.use("/api", addressCollectionRouter);
  return app;
}

const { token, tokenHash } = generateAddressToken();

function requestRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "11111111-1111-1111-1111-111111111111",
    order_id: "22222222-2222-2222-2222-222222222222",
    recipient_name: "Maya Khalil",
    preferred_language: "en",
    status: "whatsapp_sent",
    token_expires_at: new Date(Date.now() + 3600_000).toISOString(),
    window_start: new Date(Date.now() + 4 * 3600_000).toISOString(),
    window_end: new Date(Date.now() + 7 * 3600_000).toISOString(),
    delivery_timezone: "Asia/Beirut",
    link_first_opened_at: null,
    submitted_address: null,
    ...overrides,
  };
}

/** Route SELECT-by-token queries to a row; default everything else to empty. */
function primeDb(row: Record<string, unknown> | null) {
  mockDbQuery.mockImplementation((sql: string) => {
    if (typeof sql === "string" && sql.includes("token_hash = $1")) {
      return Promise.resolve({ rows: row ? [row] : [], rowCount: row ? 1 : 0 });
    }
    return Promise.resolve({ rows: [], rowCount: 1 });
  });
}

beforeEach(() => {
  mockDbQuery.mockReset();
});

describe("GET /api/address/:token", () => {
  it("404s on junk token shapes without querying the DB", async () => {
    const res = await request(makeApp()).get("/api/address/short");
    expect(res.status).toBe(404);
    expect(mockDbQuery).not.toHaveBeenCalled();
  });

  it("404s when the token hash matches nothing", async () => {
    primeDb(null);
    const res = await request(makeApp()).get(`/api/address/${token}`);
    expect(res.status).toBe(404);
  });

  it("returns surprise-safe page data and marks the link opened", async () => {
    primeDb(requestRow());
    const res = await request(makeApp()).get(`/api/address/${token}`);
    expect(res.status).toBe(200);
    expect(res.body.state).toBe("open");
    expect(res.body.recipient_first_name).toBe("Maya");
    // Never leaks sender / gift / price / card message
    const body = JSON.stringify(res.body).toLowerCase();
    expect(body).not.toContain("sender");
    expect(body).not.toContain("price");
    expect(body).not.toContain("card");
    // link_first_opened_at update fired
    const sqls = mockDbQuery.mock.calls.map((c) => String(c[0]));
    expect(sqls.some((s) => s.includes("link_first_opened_at = now()"))).toBe(true);
  });

  it("410s for cancelled requests (invalidated links)", async () => {
    primeDb(requestRow({ status: "cancelled" }));
    const res = await request(makeApp()).get(`/api/address/${token}`);
    expect(res.status).toBe(410);
  });

  it("410s for expired tokens", async () => {
    primeDb(requestRow({ token_expires_at: new Date(Date.now() - 1000).toISOString() }));
    const res = await request(makeApp()).get(`/api/address/${token}`);
    expect(res.status).toBe(410);
    expect(res.body.state).toBe("expired");
  });

  it("shows the confirmation state on re-open after submission (multi-device)", async () => {
    primeDb(requestRow({ status: "address_received", submitted_address: { area: "x" } }));
    const res = await request(makeApp()).get(`/api/address/${token}`);
    expect(res.status).toBe(200);
    expect(res.body.state).toBe("submitted");
  });
});

const validSubmission = {
  latitude: 33.8938,
  longitude: 35.5018,
  area: "Achrafieh",
  street: "Sassine Square, Bldg 12",
  floor: "3",
  landmark: "Next to the pharmacy",
};

describe("POST /api/address/:token", () => {
  it("rejects submissions without coordinates", async () => {
    primeDb(requestRow());
    const { latitude: _lat, ...noCoords } = validSubmission;
    const res = await request(makeApp()).post(`/api/address/${token}`).send(noCoords);
    expect(res.status).toBe(400);
  });

  it("rejects insufficient written directions", async () => {
    primeDb(requestRow());
    const res = await request(makeApp())
      .post(`/api/address/${token}`)
      .send({ ...validSubmission, area: "A", street: "B" });
    expect(res.status).toBe(400);
  });

  it("accepts a valid submission, updates the order address, and cancels pending actions", async () => {
    primeDb(requestRow());
    const res = await request(makeApp()).post(`/api/address/${token}`).send(validSubmission);
    expect(res.status).toBe(200);
    expect(res.body.state).toBe("submitted");
    const sqls = mockDbQuery.mock.calls.map((c) => String(c[0]));
    expect(sqls.some((s) => s.includes("status = 'address_received'"))).toBe(true);
    expect(sqls.some((s) => s.includes("UPDATE orders"))).toBe(true);
    expect(sqls.some((s) => s.includes("UPDATE address_collection_actions") && s.includes("'cancelled'"))).toBe(true);
  });

  it("is idempotent — a second submission returns the confirmation, not an error", async () => {
    primeDb(requestRow({ status: "address_received", submitted_address: { area: "x" } }));
    const res = await request(makeApp()).post(`/api/address/${token}`).send(validSubmission);
    expect(res.status).toBe(200);
    expect(res.body.state).toBe("submitted");
    // No order update on the repeat submission
    const sqls = mockDbQuery.mock.calls.map((c) => String(c[0]));
    expect(sqls.some((s) => s.includes("UPDATE orders"))).toBe(false);
  });

  it("is idempotent under a race: guarded UPDATE matched 0 rows → confirmation", async () => {
    const row = requestRow();
    mockDbQuery.mockImplementation((sql: string) => {
      if (typeof sql === "string" && sql.includes("token_hash = $1")) {
        return Promise.resolve({ rows: [row], rowCount: 1 });
      }
      if (typeof sql === "string" && sql.includes("status = 'address_received'")) {
        return Promise.resolve({ rows: [], rowCount: 0 }); // lost the race
      }
      return Promise.resolve({ rows: [], rowCount: 1 });
    });
    const res = await request(makeApp()).post(`/api/address/${token}`).send(validSubmission);
    expect(res.status).toBe(200);
    expect(res.body.state).toBe("submitted");
  });

  it("410s submissions to cancelled requests", async () => {
    primeDb(requestRow({ status: "cancelled" }));
    const res = await request(makeApp()).post(`/api/address/${token}`).send(validSubmission);
    expect(res.status).toBe(410);
  });
});

describe("POST /api/webhooks/respondio/address-status", () => {
  it("404s when the webhook secret is not configured", async () => {
    delete process.env.RESPONDIO_STATUS_WEBHOOK_SECRET;
    const res = await request(makeApp())
      .post("/api/webhooks/respondio/address-status")
      .send({ request_ref: "11111111-1111-1111-1111-111111111111", status: "delivered", provider_ref: "msg-1" });
    expect(res.status).toBe(404);
  });

  it("401s on a wrong secret and 200s idempotently on unknown refs", async () => {
    process.env.RESPONDIO_STATUS_WEBHOOK_SECRET = "s3cret";
    const bad = await request(makeApp())
      .post("/api/webhooks/respondio/address-status")
      .set("x-webhook-secret", "nope")
      .send({ request_ref: "11111111-1111-1111-1111-111111111111", status: "delivered", provider_ref: "msg-1" });
    expect(bad.status).toBe(401);

    primeDb(null);
    mockDbQuery.mockImplementation(() => Promise.resolve({ rows: [], rowCount: 0 }));
    const unknown = await request(makeApp())
      .post("/api/webhooks/respondio/address-status")
      .set("x-webhook-secret", "s3cret")
      .send({ request_ref: "11111111-1111-1111-1111-111111111111", status: "failed", provider_ref: "msg-1" });
    expect(unknown.status).toBe(200);
    delete process.env.RESPONDIO_STATUS_WEBHOOK_SECRET;
  });

  it("resolves via provider_ref fallback when request_ref UUID is not found", async () => {
    process.env.RESPONDIO_STATUS_WEBHOOK_SECRET = "s3cret";

    const activeRequest = {
      id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
      status: "whatsapp_sent",
    };

    // First call: UUID lookup returns nothing. Second call: provider_ref JOIN
    // returns the active request. All subsequent calls (applyProviderStatus
    // internals) return safe empty results.
    mockDbQuery
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })       // UUID lookup
      .mockResolvedValueOnce({ rows: [activeRequest], rowCount: 1 }) // provider_ref JOIN
      .mockResolvedValue({ rows: [], rowCount: 1 });            // applyProviderStatus queries

    const res = await request(makeApp())
      .post("/api/webhooks/respondio/address-status")
      .set("x-webhook-secret", "s3cret")
      .send({
        request_ref: "11111111-1111-1111-1111-111111111111",
        status: "delivered",
        provider_ref: "msg-provider-99",
      });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);

    // Confirm the fallback JOIN was executed with the provider_ref value
    const calls = mockDbQuery.mock.calls.map((c) => String(c[0]));
    expect(calls.some((s) => s.includes("address_collection_actions") && s.includes("provider_ref = $1"))).toBe(true);

    delete process.env.RESPONDIO_STATUS_WEBHOOK_SECRET;
  });

  it("reconciles an unknown attempted send by request_ref when its provider ref was not persisted", async () => {
    process.env.RESPONDIO_STATUS_WEBHOOK_SECRET = "s3cret";
    const requestId = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
    mockDbQuery
      .mockResolvedValueOnce({
        rows: [{ id: requestId, status: "needs_review" }],
        rowCount: 1,
      })
      .mockResolvedValue({ rows: [], rowCount: 1 });

    const res = await request(makeApp())
      .post("/api/webhooks/respondio/address-status")
      .set("x-webhook-secret", "s3cret")
      .send({
        request_ref: requestId,
        status: "delivered",
        provider_ref: "msg-late-after-timeout",
      });

    expect(res.status).toBe(200);
    const lookupSql = String(mockDbQuery.mock.calls[0][0]);
    expect(lookupSql).toContain("whatsapp_template_attempted_at IS NOT NULL");
    expect(lookupSql).toContain("unknown_action.status = 'processing'");
    expect(mockDbQuery.mock.calls.some(([sql]) =>
      String(sql).includes("UPDATE address_collection_actions"),
    )).toBe(true);
    delete process.env.RESPONDIO_STATUS_WEBHOOK_SECRET;
  });

  it("is still a no-op (200) when both UUID and provider_ref fallback find nothing", async () => {
    process.env.RESPONDIO_STATUS_WEBHOOK_SECRET = "s3cret";

    mockDbQuery.mockResolvedValue({ rows: [], rowCount: 0 });

    const res = await request(makeApp())
      .post("/api/webhooks/respondio/address-status")
      .set("x-webhook-secret", "s3cret")
      .send({
        request_ref: "11111111-1111-1111-1111-111111111111",
        status: "delivered",
        provider_ref: "msg-unknown-99",
      });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);

    delete process.env.RESPONDIO_STATUS_WEBHOOK_SECRET;
  });
});

import { beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";
import type { WorkspaceRequest } from "../lib/workspace";

const { mockDbQuery } = vi.hoisted(() => ({ mockDbQuery: vi.fn() }));

vi.mock("../lib/db", () => ({
  db: { query: (...args: unknown[]) => mockDbQuery(...args) },
}));

vi.mock("../lib/auth", () => ({
  requireAuth: (_req: express.Request, _res: express.Response, next: express.NextFunction) => next(),
}));

vi.mock("../lib/workspace", () => ({
  resolveWorkspace: (req: express.Request, _res: express.Response, next: express.NextFunction) => {
    const wreq = req as unknown as WorkspaceRequest;
    wreq.workspaceOwnerId = "owner-1";
    wreq.userId = "operator-1";
    next();
  },
}));

vi.mock("../lib/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import addressCollectorRouter from "./addressCollector";

const REQUEST_ID = "11111111-1111-1111-1111-111111111111";

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use("/api", addressCollectorRouter);
  return app;
}

beforeEach(() => {
  mockDbQuery.mockReset();
  mockDbQuery.mockImplementation((sql: string) => {
    if (sql.includes("SELECT id, status, order_id, closed_at FROM address_collection_requests")) {
      return Promise.resolve({
        rows: [{ id: REQUEST_ID, status: "whatsapp_sent" }],
        rowCount: 1,
      });
    }
    return Promise.resolve({ rows: [], rowCount: 1 });
  });
});

describe("POST /api/address-collector/:id/send-reminder", () => {
  it("rejects legacy manual repeat requests and records the suppression", async () => {
    const res = await request(makeApp())
      .post(`/api/address-collector/${REQUEST_ID}/send-reminder`);

    expect(res.status).toBe(409);
    expect(res.body.code).toBe("whatsapp_single_send");
    expect(mockDbQuery.mock.calls.some(([sql]) =>
      String(sql).includes("INSERT INTO address_collection_events"),
    )).toBe(true);
    expect(mockDbQuery.mock.calls.some(([sql]) =>
      String(sql).includes("INSERT INTO address_collection_actions"),
    )).toBe(false);
  });
});

describe("Address Collector order references", () => {
  it("maps the best available order number in the list response", async () => {
    mockDbQuery.mockImplementation((sql: string) => {
      if (sql.includes("AVG(EXTRACT")) return Promise.resolve({ rows: [{}], rowCount: 1 });
      if (sql.includes("COUNT(*)::text AS n")) {
        return Promise.resolve({ rows: [{ n: "1" }], rowCount: 1 });
      }
      if (sql.includes("FROM address_collection_requests r") && sql.includes("LIMIT $")) {
        return Promise.resolve({
          rows: [{
            id: REQUEST_ID,
            order_id: "22222222-2222-2222-2222-222222222222",
            order_number: "LB-2465",
            recipient_phone: "+971501234567",
          }],
          rowCount: 1,
        });
      }
      return Promise.resolve({ rows: [], rowCount: 0 });
    });

    const res = await request(makeApp()).get("/api/address-collector");

    expect(res.status).toBe(200);
    expect(res.body.requests[0].order_number).toBe("LB-2465");
    const listSql = mockDbQuery.mock.calls
      .map(([sql]) => String(sql))
      .find((sql) => sql.includes("LIMIT $"));
    expect(listSql).toContain("o.external_order_number");
    expect(listSql).toContain("o.order_number");
  });

  it("maps the same human-readable order number in the detail response", async () => {
    mockDbQuery.mockImplementation((sql: string) => {
      if (sql.includes("FROM address_collection_requests r")) {
        return Promise.resolve({
          rows: [{
            id: REQUEST_ID,
            order_id: "22222222-2222-2222-2222-222222222222",
            order_number: "LB-2465",
          }],
          rowCount: 1,
        });
      }
      return Promise.resolve({ rows: [], rowCount: 0 });
    });

    const res = await request(makeApp()).get(`/api/address-collector/${REQUEST_ID}`);

    expect(res.status).toBe(200);
    expect(res.body.request.order_number).toBe("LB-2465");
    const detailSql = String(mockDbQuery.mock.calls[0]?.[0]);
    expect(detailSql).toContain("o.external_order_number");
    expect(detailSql).toContain("o.order_number");
  });
});

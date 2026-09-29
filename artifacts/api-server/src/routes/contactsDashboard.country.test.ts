import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";
import type { WorkspaceRequest } from "../lib/workspace";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockDbQuery = vi.fn();

vi.mock("../lib/db", () => ({
  db: {
    query: (...args: unknown[]) => mockDbQuery(...args),
  },
  withTransaction: vi.fn(),
}));

vi.mock("../lib/auth", () => ({
  requireAuth: (_req: express.Request, _res: express.Response, next: express.NextFunction) =>
    next(),
  authed: (req: express.Request) => req,
}));

vi.mock("../lib/workspace", () => ({
  resolveWorkspace: (req: express.Request, _res: express.Response, next: express.NextFunction) => {
    const wreq = req as unknown as WorkspaceRequest;
    wreq.workspaceOwnerId = "owner_123";
    wreq.workspaceRole = "owner";
    wreq.workspaceActualRole = "owner";
    wreq.userId = "user_abc";
    next();
  },
  workspace: (req: express.Request) => req as unknown as WorkspaceRequest,
  hasPageAccess: () => true,
}));

vi.mock("../lib/logger", () => ({
  logger: { error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

import contactsRouter from "./contactsDashboard.js";

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as { log: unknown }).log = {
      error: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      debug: vi.fn(),
    };
    next();
  });
  app.use("/api", contactsRouter);
  return app;
}

const listRow = {
  id: "c1",
  first_name: "Sara",
  last_name: null,
  display_name: null,
  email: null,
  phone: "+966501234567",
  tags: [],
  created_at: "2026-07-01T00:00:00Z",
  is_customer: true,
  is_recipient: false,
  orders_placed: 2,
  last_order_at: null,
  customer_id: null,
  total_spent_usd: "100",
  country_raw: "sa",
  is_vip: false,
};

describe("GET /api/contacts — phone-derived country", () => {
  beforeEach(() => {
    mockDbQuery.mockReset();
    mockDbQuery.mockImplementation((sql: string) => {
      if (sql.includes("AS country_raw") && sql.includes("FROM contacts c")) {
        return Promise.resolve({ rows: [listRow] });
      }
      if (sql.includes("COUNT(*)")) {
        return Promise.resolve({ rows: [{ count: "1" }] });
      }
      return Promise.resolve({ rows: [] });
    });
  });

  it("derives country from the phone dial code FIRST, before billing/delivery", async () => {
    const res = await request(buildApp()).get("/api/contacts");
    expect(res.status).toBe(200);

    const listCall = mockDbQuery.mock.calls.find(
      (c) => typeof c[0] === "string" && (c[0] as string).includes("AS country_raw"),
    );
    expect(listCall).toBeDefined();
    const sql = listCall![0] as string;

    // The effective-country COALESCE must try the phone classifier before the
    // billing metadata country_code and delivery-address fallbacks.
    const phoneIdx = sql.indexOf("LIKE '966%'");
    const billingIdx = sql.indexOf("c.metadata->>'country_code'");
    const deliveryIdx = sql.indexOf("o.delivery_address->>'countryCode'");
    expect(phoneIdx).toBeGreaterThan(-1);
    expect(billingIdx).toBeGreaterThan(-1);
    expect(deliveryIdx).toBeGreaterThan(-1);
    expect(phoneIdx).toBeLessThan(billingIdx);
    expect(billingIdx).toBeLessThan(deliveryIdx);
  });

  it("resolves the lowercase ISO code from the phone into a display name", async () => {
    const res = await request(buildApp()).get("/api/contacts");
    expect(res.status).toBe(200);
    expect(res.body.contacts[0].country).toBe("Saudi Arabia");
  });

  it("includes phone-derived codes in the available country filter options", async () => {
    const res = await request(buildApp()).get("/api/contacts");
    expect(res.status).toBe(200);

    const countriesCall = mockDbQuery.mock.calls.find(
      (c) =>
        typeof c[0] === "string" &&
        (c[0] as string).includes("SELECT DISTINCT x.raw"),
    );
    expect(countriesCall).toBeDefined();
    const sql = countriesCall![0] as string;
    // Dropdown union includes the phone classifier arm alongside billing +
    // delivery country sources.
    expect(sql).toMatch(/LIKE '966%'/);
    expect(sql).toMatch(/c\.metadata->>'country_code'/);
    expect(sql).toMatch(/o\.delivery_address->>'countryCode'/);
  });
});

import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";

const mockDbQuery = vi.fn();
const mockClientQuery = vi.fn();
const mockDbConnect = vi.fn();
const mockUpsertContact = vi.fn();
const mockRefreshPhonePlaceholderContactAfterFirstOrder = vi.fn().mockResolvedValue(false);

vi.mock("../lib/db", () => ({
  db: {
    query: (...args: unknown[]) => mockDbQuery(...args),
    connect: (...args: unknown[]) => mockDbConnect(...args),
  },
}));

vi.mock("../lib/apiKeyAuth", () => ({
  requireApiKey: (_req: express.Request, _res: express.Response, next: express.NextFunction) => next(),
}));

vi.mock("../lib/contactUpsert", () => ({
  upsertContact: (...args: unknown[]) => mockUpsertContact(...args),
  refreshPhonePlaceholderContactAfterFirstOrder: (...args: unknown[]) =>
    mockRefreshPhonePlaceholderContactAfterFirstOrder(...args),
}));

vi.mock("../lib/eventsSse", () => ({ broadcastEvent: vi.fn() }));
vi.mock("../lib/orderAlerts", () => ({ notifyNewOrderAlerts: vi.fn().mockResolvedValue(undefined) }));
vi.mock("../lib/catalogWebhook", () => ({ fireWebhookEvent: vi.fn().mockResolvedValue(undefined) }));
vi.mock("../lib/logger", () => ({ logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() } }));

import router from "./importToters";

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as { userId: string }).userId = "owner-1";
    next();
  });
  app.use("/api", router);
  return app;
}

function setupTransaction(wasInserted: boolean) {
  mockClientQuery.mockImplementation((sql: string) => {
    if (/INSERT INTO orders/i.test(sql)) {
      return { rows: [{ id: "toters-order-1", was_inserted: wasInserted }] };
    }
    return { rows: [] };
  });
  mockDbConnect.mockResolvedValue({
    query: (...args: unknown[]) => mockClientQuery(...args),
    release: vi.fn(),
  });
}

const body = {
  order: { orderNumber: "TOT-1001" },
  customer: { customerName: "Rana K", customerPhone: "+96170000001" },
  lineItems: [{ name: "Roses", qty: "1", price: "25", total: "25" }],
};

beforeEach(() => {
  vi.clearAllMocks();
  mockUpsertContact.mockResolvedValue("contact-1");
  mockRefreshPhonePlaceholderContactAfterFirstOrder.mockResolvedValue(false);
});

describe("POST /api/orders/import-toters — first-order phone placeholder repair", () => {
  it("triggers the guarded repair only for a newly imported customer order", async () => {
    setupTransaction(true);

    const res = await request(makeApp()).post("/api/orders/import-toters").send(body);

    expect(res.status).toBe(201);
    expect(mockRefreshPhonePlaceholderContactAfterFirstOrder).toHaveBeenCalledWith({
      workspaceOwnerId: "owner-1",
      contactId: "contact-1",
      orderId: "toters-order-1",
      buyer: { firstName: "Rana", lastName: "K", displayName: "Rana K" },
    });
  });

  it("does not trigger the repair when the Toters submission is a duplicate", async () => {
    setupTransaction(false);

    const res = await request(makeApp()).post("/api/orders/import-toters").send(body);

    expect(res.status).toBe(200);
    expect(mockRefreshPhonePlaceholderContactAfterFirstOrder).not.toHaveBeenCalled();
  });
});
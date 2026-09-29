import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import express from "express";
import request from "supertest";
import type { WorkspaceRequest } from "../lib/workspace";

// ---------------------------------------------------------------------------
// Mocks — must be declared before importing the module under test
// ---------------------------------------------------------------------------

const mockDbQuery = vi.fn();

vi.mock("../lib/db", () => ({
  db: {
    query: (...args: unknown[]) => mockDbQuery(...args),
  },
}));

vi.mock("../lib/auth", () => ({
  requireAuth: (_req: express.Request, _res: express.Response, next: express.NextFunction) => next(),
  authed: () => ({ userId: "user_abc" }),
}));

let stubWorkspaceOwnerId = "owner_123";
let stubWorkspaceRole: "owner" | "member" = "owner";
let stubMemberDbId: number | null = null;
let stubHasPageAccess = true;

vi.mock("../lib/workspace", () => ({
  resolveWorkspace: (req: express.Request, _res: express.Response, next: express.NextFunction) => {
    const wreq = req as unknown as WorkspaceRequest;
    wreq.workspaceOwnerId = stubWorkspaceOwnerId;
    wreq.workspaceRole = stubWorkspaceRole;
    wreq.workspaceActualRole = stubWorkspaceRole;
    wreq.memberDbId = stubMemberDbId;
    wreq.userId = "user_abc";
    next();
  },
  workspace: (req: express.Request) => req as unknown as WorkspaceRequest,
  hasPageAccess: () => stubHasPageAccess,
}));

vi.mock("../lib/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("@clerk/express", () => ({
  clerkClient: {
    users: {
      getUser: vi.fn().mockResolvedValue({
        firstName: "Test",
        lastName: "User",
        emailAddresses: [{ emailAddress: "test@example.com" }],
      }),
    },
  },
}));

import cardMessageRouter from "./cardMessage";

describe("POST /api/card-message/print-cake", () => {
  const originalUrl = process.env.CAKE_PRINT_MAKE_WEBHOOK_URL;
  const originalFetch = global.fetch;
  async function cakeApp(url?: string) {
    if (url) process.env.CAKE_PRINT_MAKE_WEBHOOK_URL = url;
    else delete process.env.CAKE_PRINT_MAKE_WEBHOOK_URL;
    vi.resetModules();
    const { default: router } = await import("./cardMessage");
    const app = express();
    app.use(express.json());
    app.use("/api", router);
    return app;
  }
  afterEach(() => {
    global.fetch = originalFetch;
    if (originalUrl === undefined) delete process.env.CAKE_PRINT_MAKE_WEBHOOK_URL;
    else process.env.CAKE_PRINT_MAKE_WEBHOOK_URL = originalUrl;
  });
  it("posts only the exact Make fields to the dedicated cake URL", async () => {
    const app = await cakeApp("https://hooks.make.com/cake-test");
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    global.fetch = fetchMock as unknown as typeof fetch;
    const res = await request(app).post("/api/card-message/print-cake")
      .send({ location: "Jdeideh", cakeMessage: "  Happy 18th!  " });
    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledWith("https://hooks.make.com/cake-test", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ Cake_Message: "Happy 18th!", Location: "Jdeideh" }),
    });
    expect(mockDbQuery).not.toHaveBeenCalled();
  });
  it("rejects manual printing for members without card-message access", async () => {
    const app = await cakeApp("https://hooks.make.com/cake-test");
    stubWorkspaceRole = "member";
    stubHasPageAccess = false;
    const fetchMock = vi.fn();
    global.fetch = fetchMock as unknown as typeof fetch;
    const response = await request(app).post("/api/card-message/print-cake")
      .send({ location: "Jdeideh", cakeMessage: "Happy birthday" });
    expect(response.status).toBe(403);
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it.each([
    { location: "Beirut", cakeMessage: "hello" },
    { location: "Achrafieh", cakeMessage: "   " },
    { location: "Achrafieh" },
  ])("rejects invalid input without contacting the webhook", async (body) => {
    const app = await cakeApp("https://hooks.make.com/cake-test");
    const fetchMock = vi.fn();
    global.fetch = fetchMock as unknown as typeof fetch;
    expect((await request(app).post("/api/card-message/print-cake").send(body)).status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it("reports missing configuration and non-2xx and network failures", async () => {
    const body = { location: "Achrafieh", cakeMessage: "Hi" };
    const missing = await cakeApp();
    expect((await request(missing).post("/api/card-message/print-cake").send(body)).body.error)
      .toBe("webhook_not_configured");
    const app = await cakeApp("https://hooks.make.com/cake-test");
    global.fetch = vi.fn().mockResolvedValue({ ok: false, status: 500 }) as unknown as typeof fetch;
    expect((await request(app).post("/api/card-message/print-cake").send(body)).body.error)
      .toBe("webhook_error");
    global.fetch = vi.fn().mockRejectedValue(new Error("offline")) as unknown as typeof fetch;
    expect((await request(app).post("/api/card-message/print-cake").send(body)).body.error)
      .toBe("webhook_error");
  });
  it("derives florist message and location from the assignment rather than caller fields", async () => {
    const app = await cakeApp("https://hooks.make.com/cake-test");
    mockDbQuery.mockResolvedValueOnce({ rows: [{ location_name: "Jdeideh", cake_message: "DB cake" }] });
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    global.fetch = fetchMock as unknown as typeof fetch;
    const res = await request(app).post("/api/card-message/print-cake").send({
      location: "Achrafieh", cakeMessage: "Forged", floristOrderId: "11111111-1111-4111-8111-111111111111",
    });
    expect(res.status).toBe(200);
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ Cake_Message: "DB cake", Location: "Jdeideh" });
  });
  it("derives order-detail cake text from the workspace-owned order even without a card", async () => {
    const app = await cakeApp("https://hooks.make.com/cake-test");
    mockDbQuery.mockResolvedValueOnce({ rows: [{ cake_message: "Persisted cake" }] });
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    global.fetch = fetchMock as unknown as typeof fetch;
    const id = "11111111-1111-4111-8111-111111111111";
    const res = await request(app).post("/api/card-message/print-cake").send({
      location: "Achrafieh", cakeMessage: "Forged", realOrderId: id,
    });
    expect(res.status).toBe(200);
    expect(mockDbQuery.mock.calls[0][1]).toEqual([id, "owner_123"]);
    expect(String(mockDbQuery.mock.calls[0][0])).not.toContain("o.card_message");
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({
      Cake_Message: "Persisted cake", Location: "Achrafieh",
    });
  });
  it.each([
    [{ location_name: "Beirut", cake_message: "Hi" }, "invalid_location"],
    [{ location_name: "Jdeideh", cake_message: null }, "no_cake_message"],
  ])("rejects florist assignments without a supported location or cake text", async (row, error) => {
    const app = await cakeApp("https://hooks.make.com/cake-test");
    mockDbQuery.mockResolvedValueOnce({ rows: [row] });
    const fetchMock = vi.fn();
    global.fetch = fetchMock as unknown as typeof fetch;
    const response = await request(app).post("/api/card-message/print-cake").send({
      location: "Achrafieh", cakeMessage: "Hi",
      floristOrderId: "11111111-1111-4111-8111-111111111111",
    });
    expect(response.status).toBe(400);
    expect(response.body.error).toBe(error);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Test app
// ---------------------------------------------------------------------------

function makeApp() {
  // Mirror production mounting: the shared router is mounted at /api
  // (see app.ts), so card-message routes must be registered WITHOUT the
  // /api prefix. Mounting under /api here catches double-prefix regressions.
  const app = express();
  app.use(express.json());
  const apiRouter = express.Router();
  apiRouter.use(cardMessageRouter);
  app.use("/api", apiRouter);
  return app;
}

function makeConfigRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 1,
    workspace_owner_id: "owner_123",
    name: "Dubai - Branch A",
    machine_id: "machine-1",
    printer_id: "printer-1",
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockDbQuery.mockResolvedValue({ rows: [], rowCount: 0 });
  stubWorkspaceOwnerId = "owner_123";
  stubWorkspaceRole = "owner";
  stubMemberDbId = null;
  stubHasPageAccess = true;
});

// ---------------------------------------------------------------------------
// GET /api/card-message/config
// ---------------------------------------------------------------------------

describe("GET /api/card-message/config", () => {
  it("returns shop names sourced from brands", async () => {
    mockDbQuery.mockResolvedValueOnce({
      rows: [{ name: "Blooms & Balloons" }, { name: "Eternal Rose" }, { name: "Flower Scent" }],
      rowCount: 3,
    });

    const res = await request(makeApp()).get("/api/card-message/config");

    expect(res.status).toBe(200);
    expect(res.body.shops).toEqual(["Blooms & Balloons", "Eternal Rose", "Flower Scent"]);
    expect(Array.isArray(res.body.presentailShops)).toBe(true);

    const [sql, params] = mockDbQuery.mock.calls[0];
    expect(String(sql)).toContain("FROM brands");
    expect(String(sql)).toContain("ORDER BY name ASC");
    expect(params).toEqual(["owner_123"]);
  });

  it("returns an empty shops list when the workspace has no brands", async () => {
    const res = await request(makeApp()).get("/api/card-message/config");
    expect(res.status).toBe(200);
    expect(res.body.shops).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// POST /api/card-message/print
// ---------------------------------------------------------------------------

describe("POST /api/card-message/print", () => {
  const validBody = {
    location: "Dubai - Branch A",
    shopName: "Presentail",
    orderId: "ORD-1",
    cardMessage: "Happy birthday!",
  };

  it("returns no_printer_configured when the branch is not in the DB", async () => {
    mockDbQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const res = await request(makeApp()).post("/api/card-message/print").send(validBody);

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("no_printer_configured");

    const [sql, params] = mockDbQuery.mock.calls[0];
    expect(String(sql)).toContain("FROM branch_print_configs");
    expect(params).toEqual(["owner_123", "Dubai - Branch A"]);
  });

  it("looks up the printer config by workspace and location name", async () => {
    mockDbQuery.mockResolvedValueOnce({
      rows: [{ machine_id: "machine-1", printer_id: "printer-1" }],
      rowCount: 1,
    });

    // Block the outbound webhook (env var may or may not be set); whichever
    // branch is taken, the route must have performed the branch-config lookup.
    const originalFetch = global.fetch;
    global.fetch = vi.fn().mockResolvedValue({ ok: false, text: () => Promise.resolve("") }) as unknown as typeof fetch;
    const res = await request(makeApp()).post("/api/card-message/print").send(validBody);
    global.fetch = originalFetch;

    expect(res.status).toBe(502);
    const [sql, params] = mockDbQuery.mock.calls[0];
    expect(String(sql)).toContain("FROM branch_print_configs");
    expect(params).toEqual(["owner_123", "Dubai - Branch A"]);
  });

  it("rejects an invalid body without querying the DB", async () => {
    const res = await request(makeApp()).post("/api/card-message/print").send({});
    expect(res.status).toBe(400);
    expect(mockDbQuery).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// POST /api/card-message/print — outbound webhook payload shape
// ---------------------------------------------------------------------------

describe("POST /api/card-message/print webhook payload", () => {
  const originalFetch = global.fetch;
  const originalWebhookUrl = process.env.CARD_PRINT_MAKE_WEBHOOK_URL;
  const originalPresentailShops = process.env.CARD_PRINT_PRESENTAIL_SHOPS;

  let fetchMock: ReturnType<typeof vi.fn>;

  // CARD_PRINT_MAKE_WEBHOOK_URL / CARD_PRINT_PRESENTAIL_SHOPS are read once at
  // module import time, so the router must be freshly re-imported under
  // vi.resetModules() after the env vars are set for each test.
  async function loadAppWithEnv(presentailShops: string) {
    process.env.CARD_PRINT_MAKE_WEBHOOK_URL = "https://hooks.make.com/test";
    process.env.CARD_PRINT_PRESENTAIL_SHOPS = presentailShops;
    vi.resetModules();
    const mod = await import("./cardMessage");
    const app = express();
    app.use(express.json());
    app.use("/api", mod.default);
    return app;
  }

  beforeEach(() => {
    fetchMock = vi.fn().mockResolvedValue({ ok: true, text: () => Promise.resolve("") });
    global.fetch = fetchMock as unknown as typeof fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
    if (originalWebhookUrl === undefined) delete process.env.CARD_PRINT_MAKE_WEBHOOK_URL;
    else process.env.CARD_PRINT_MAKE_WEBHOOK_URL = originalWebhookUrl;
    if (originalPresentailShops === undefined) delete process.env.CARD_PRINT_PRESENTAIL_SHOPS;
    else process.env.CARD_PRINT_PRESENTAIL_SHOPS = originalPresentailShops;
  });

  it("sends an array with one object using the exact required key set for a non-Presentail shop", async () => {
    const app = await loadAppWithEnv("Presentail");
    mockDbQuery.mockResolvedValueOnce({
      rows: [{ machine_id: "machine-1", printer_id: "printer-1" }],
      rowCount: 1,
    });
    // Second call: INSERT INTO card_print_logs
    mockDbQuery.mockResolvedValueOnce({ rows: [], rowCount: 1 });

    const res = await request(app).post("/api/card-message/print").send({
      location: "Dubai - Branch A",
      shopName: "Some Aggregator Shop",
      orderId: "ORD-1",
      cardMessage: "Happy birthday!",
      toName: "Alice",
      fromName: "Bob",
    });

    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, options] = fetchMock.mock.calls[0];
    const body = JSON.parse(options.body as string);

    expect(Array.isArray(body)).toBe(true);
    expect(body).toHaveLength(1);
    expect(Object.keys(body[0]).sort()).toEqual(
      [
        "Location",
        "Shop Name",
        "Order ID",
        "Card Message",
        "receiverName",
        "senderName",
        "Source",
        "machineId",
        "printerId",
      ].sort(),
    );
    expect(body[0]).toEqual({
      Location: "Dubai - Branch A",
      "Shop Name": "Some Aggregator Shop",
      "Order ID": "ORD-1",
      "Card Message": "Happy birthday!",
      receiverName: "Alice",
      senderName: "Bob",
      Source: "Presentail Dashboard",
      machineId: "machine-1",
      printerId: "printer-1",
    });
  });

  it("loads and prints a workspace-owned additional card without unlocking the florist gate", async () => {
    const app = await loadAppWithEnv("Presentail Flowers and Gifts");
    mockDbQuery
      .mockResolvedValueOnce({
        rows: [{
          card_message: "Persisted extra",
          card_to: "Extra recipient",
          card_from: "Extra sender",
          qr_link: "https://example.com/extra",
          order_number: "ORD-2",
        }],
        rowCount: 1,
      })
      .mockResolvedValueOnce({
        rows: [{ machine_id: "machine-1", printer_id: "printer-1" }],
        rowCount: 1,
      })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 });

    const res = await request(app).post("/api/card-message/print").send({
      location: "Branch A",
      shopName: "Presentail Flowers and Gifts",
      orderId: "FORGED",
      cardMessage: "Forged",
      toName: "Forged",
      fromName: "Forged",
      realOrderId: "11111111-1111-4111-8111-111111111111",
      additionalCardMessageId: "22222222-2222-4222-8222-222222222222",
    });

    expect(res.status).toBe(200);
    expect(mockDbQuery.mock.calls[0]?.[0]).toContain("FROM order_card_messages cm");
    expect(mockDbQuery.mock.calls[0]?.[1]).toEqual([
      "22222222-2222-4222-8222-222222222222",
      "11111111-1111-4111-8111-111111111111",
      "owner_123",
    ]);
    const payload = JSON.parse(fetchMock.mock.calls[0][1].body as string)[0];
    expect(payload).toMatchObject({
      "Order ID": "ORD-2",
      "Card Message": "Persisted extra",
      receiverName: "Extra recipient",
      senderName: "Extra sender",
      "QR code": "https://example.com/extra",
    });
    expect(mockDbQuery.mock.calls.some(([sql]) =>
      String(sql).includes("UPDATE order_florist_assignments"),
    )).toBe(false);
  });

  it("populates receiverName/senderName from To/From for a Presentail shop", async () => {
    const app = await loadAppWithEnv("Presentail");
    mockDbQuery.mockResolvedValueOnce({
      rows: [{ machine_id: "machine-1", printer_id: "printer-1" }],
      rowCount: 1,
    });

    const res = await request(app).post("/api/card-message/print").send({
      location: "Dubai - Branch A",
      shopName: "Presentail",
      orderId: "ORD-2",
      cardMessage: "Congrats!",
      toName: "Alice",
      fromName: "Bob",
    });

    expect(res.status).toBe(200);
    const [, options] = fetchMock.mock.calls[0];
    const body = JSON.parse(options.body as string);
    expect(body[0].receiverName).toBe("Alice");
    expect(body[0].senderName).toBe("Bob");
  });

  it("sends empty-string receiverName/senderName for a Presentail shop with no To/From", async () => {
    const app = await loadAppWithEnv("Presentail");
    mockDbQuery.mockResolvedValueOnce({
      rows: [{ machine_id: "machine-1", printer_id: "printer-1" }],
      rowCount: 1,
    });

    const res = await request(app).post("/api/card-message/print").send({
      location: "Dubai - Branch A",
      shopName: "Presentail",
      orderId: "ORD-3",
      cardMessage: "Congrats!",
    });

    expect(res.status).toBe(200);
    const [, options] = fetchMock.mock.calls[0];
    const body = JSON.parse(options.body as string);
    expect(body[0].receiverName).toBe("");
    expect(body[0].senderName).toBe("");
  });

  it("sends the exact QR code key with a trimmed valid HTTP(S) link", async () => {
    const app = await loadAppWithEnv("Presentail");
    mockDbQuery.mockResolvedValueOnce({
      rows: [{ machine_id: "machine-1", printer_id: "printer-1" }],
      rowCount: 1,
    });
    // Second call: INSERT INTO card_print_logs
    mockDbQuery.mockResolvedValueOnce({ rows: [], rowCount: 1 });

    const res = await request(app).post("/api/card-message/print").send({
      location: "Dubai - Branch A",
      shopName: "Presentail",
      orderId: "ORD-4",
      cardMessage: "Happy birthday!",
      qrLink: "  https://example.com/qr/abc123  ",
    });

    expect(res.status).toBe(200);
    const [, options] = fetchMock.mock.calls[0];
    const body = JSON.parse(options.body as string);
    expect(body[0]["QR code"]).toBe("https://example.com/qr/abc123");
    expect(body[0]).not.toHaveProperty("QR Link");
    // Card Message must be the plain message — the QR link is NOT appended to it.
    expect(body[0]["Card Message"]).toBe("Happy birthday!");
  });

  it("Card Message is unchanged when no qrLink is provided (direct body path)", async () => {
    const app = await loadAppWithEnv("Presentail");
    mockDbQuery.mockResolvedValueOnce({
      rows: [{ machine_id: "machine-1", printer_id: "printer-1" }],
      rowCount: 1,
    });
    // Second call: INSERT INTO card_print_logs
    mockDbQuery.mockResolvedValueOnce({ rows: [], rowCount: 1 });

    const res = await request(app).post("/api/card-message/print").send({
      location: "Dubai - Branch A",
      shopName: "Presentail",
      orderId: "ORD-4b",
      cardMessage: "No QR here",
    });

    expect(res.status).toBe(200);
    const [, options] = fetchMock.mock.calls[0];
    const body = JSON.parse(options.body as string);
    expect(body[0]["Card Message"]).toBe("No QR here");
    expect(body[0]).not.toHaveProperty("QR code");
  });

  it.each(["", "example.com/qr", "javascript:alert(1)", "https://"])(
    "omits invalid or empty QR input %j from the webhook payload",
    async (qrLink) => {
    const app = await loadAppWithEnv("Presentail");
    mockDbQuery.mockResolvedValueOnce({
      rows: [{ machine_id: "machine-1", printer_id: "printer-1" }],
      rowCount: 1,
    });
    // Second call: INSERT INTO card_print_logs
    mockDbQuery.mockResolvedValueOnce({ rows: [], rowCount: 1 });

    const res = await request(app).post("/api/card-message/print").send({
      location: "Dubai - Branch A",
      shopName: "Presentail",
      orderId: "ORD-5",
      cardMessage: "Congrats!",
      qrLink,
    });

    expect(res.status).toBe(200);
    const [, options] = fetchMock.mock.calls[0];
    const body = JSON.parse(options.body as string);
    expect(body[0]).not.toHaveProperty("QR code");
    expect(body[0]).not.toHaveProperty("QR Link");
    },
  );

  // ── Florist verification gate (realOrderId) ───────────────────────────────
  // With realOrderId the printed payload is rebuilt server-side from the
  // persisted order card fields; the client's card fields must be ignored so
  // a forged payload cannot falsify the card-printed unlock.

  const GATE_ORDER_ID = "11111111-1111-4111-8111-111111111111";

  function gateRow(overrides: Record<string, unknown> = {}) {
    return {
      rows: [
        {
          location_id: 7,
          card_message: "Persisted card text",
          card_to: "DB To",
          card_from: "DB From",
          qr_link: "https://example.com/qr/db",
          order_number: "LB-2122",
          ...overrides,
        },
      ],
      rowCount: 1,
    };
  }

  it("rebuilds the printed payload from persisted order fields, ignoring forged client values", async () => {
    const app = await loadAppWithEnv("Presentail");
    mockDbQuery
      .mockResolvedValueOnce(gateRow()) // order + assignment lookup
      .mockResolvedValueOnce({
        rows: [{ machine_id: "machine-1", printer_id: "printer-1" }],
        rowCount: 1,
      })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 }) // print log insert
      .mockResolvedValueOnce({ rows: [], rowCount: 1 }); // card_printed_at unlock

    const res = await request(app).post("/api/card-message/print").send({
      location: "Dubai - Branch A",
      shopName: "Presentail",
      orderId: "FORGED-ORDER",
      cardMessage: "forged message",
      toName: "Forged To",
      fromName: "Forged From",
      qrLink: "https://evil.example/qr",
      realOrderId: GATE_ORDER_ID,
    });

    expect(res.status).toBe(200);
    // Gate lookup is scoped to workspace + order.
    const [gateSql, gateParams] = mockDbQuery.mock.calls[0];
    expect(String(gateSql)).toContain("FROM order_florist_assignments");
    expect(gateParams).toEqual([GATE_ORDER_ID, "owner_123"]);
    // Webhook payload comes from the DB, not the request body.
    const [, options] = fetchMock.mock.calls[0];
    const body = JSON.parse(options.body as string);
    expect(body[0]["Order ID"]).toBe("LB-2122");
    // Card Message is the plain persisted text — the QR link is NOT appended.
    expect(body[0]["Card Message"]).toBe("Persisted card text");
    expect(body[0].receiverName).toBe("DB To");
    expect(body[0].senderName).toBe("DB From");
    expect(body[0]["QR code"]).toBe("https://example.com/qr/db");
    expect(body[0]).not.toHaveProperty("QR Link");
    // Unlock UPDATE targets exactly this order + workspace.
    const unlockCall = mockDbQuery.mock.calls.find((c) =>
      String(c[0]).includes("card_printed_at = now()"),
    );
    expect(unlockCall).toBeDefined();
    expect(unlockCall![1]).toEqual([GATE_ORDER_ID, "owner_123", 7]);
  });

  it("404s when realOrderId has no florist assignment in this workspace (no print, no unlock)", async () => {
    const app = await loadAppWithEnv("Presentail");
    mockDbQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const res = await request(app).post("/api/card-message/print").send({
      location: "Dubai - Branch A",
      shopName: "Presentail",
      orderId: "ORD-1",
      cardMessage: "hi",
      realOrderId: GATE_ORDER_ID,
    });
    expect(res.status).toBe(404);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(mockDbQuery).toHaveBeenCalledTimes(1);
  });

  it("404s when a location-bound member prints for another location's assignment", async () => {
    const app = await loadAppWithEnv("Presentail");
    stubWorkspaceRole = "member";
    stubMemberDbId = 42;
    mockDbQuery
      .mockResolvedValueOnce(gateRow({ location_id: 7 }))
      .mockResolvedValueOnce({ rows: [{ florist_location_id: 8 }], rowCount: 1 }); // member's location differs

    const res = await request(app).post("/api/card-message/print").send({
      location: "Dubai - Branch A",
      shopName: "Presentail",
      orderId: "ORD-1",
      cardMessage: "hi",
      realOrderId: GATE_ORDER_ID,
    });
    expect(res.status).toBe(404);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("400s no_card_message when the order has no persisted card to print", async () => {
    const app = await loadAppWithEnv("Presentail");
    mockDbQuery.mockResolvedValueOnce(gateRow({ card_message: null }));

    const res = await request(app).post("/api/card-message/print").send({
      location: "Dubai - Branch A",
      shopName: "Presentail",
      orderId: "ORD-1",
      cardMessage: "forged",
      realOrderId: GATE_ORDER_ID,
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("no_card_message");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("403s when the caller lacks both florist and orders page access", async () => {
    const app = await loadAppWithEnv("Presentail");
    stubHasPageAccess = false;
    const res = await request(app).post("/api/card-message/print").send({
      location: "Dubai - Branch A",
      shopName: "Presentail",
      orderId: "ORD-1",
      cardMessage: "hi",
      realOrderId: GATE_ORDER_ID,
    });
    expect(res.status).toBe(403);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(mockDbQuery).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Branch config CRUD — owner gating
// ---------------------------------------------------------------------------

describe("branch config CRUD owner gating", () => {
  it.each([
    ["post", "/api/card-message/branch-configs"],
    ["patch", "/api/card-message/branch-configs/1"],
    ["delete", "/api/card-message/branch-configs/1"],
  ] as const)("returns 403 for non-owners on %s %s", async (method, path) => {
    stubWorkspaceRole = "member";
    const res = await request(makeApp())[method](path).send({});
    expect(res.status).toBe(403);
    expect(mockDbQuery).not.toHaveBeenCalled();
  });

  it("allows members to GET /api/card-message/branch-configs (needed by print dialog)", async () => {
    stubWorkspaceRole = "member";
    mockDbQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    const res = await request(makeApp()).get("/api/card-message/branch-configs");
    expect(res.status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// Branch config CRUD — behavior
// ---------------------------------------------------------------------------

describe("branch config CRUD", () => {
  it("lists workspace branch configs", async () => {
    mockDbQuery.mockResolvedValueOnce({ rows: [makeConfigRow()], rowCount: 1 });

    const res = await request(makeApp()).get("/api/card-message/branch-configs");

    expect(res.status).toBe(200);
    expect(res.body.configs).toHaveLength(1);
    expect(res.body.configs[0].name).toBe("Dubai - Branch A");
    const [, params] = mockDbQuery.mock.calls[0];
    expect(params).toEqual(["owner_123"]);
  });

  it("creates a branch config", async () => {
    mockDbQuery.mockResolvedValueOnce({ rows: [makeConfigRow()], rowCount: 1 });

    const res = await request(makeApp())
      .post("/api/card-message/branch-configs")
      .send({ name: "Dubai - Branch A", machineId: "machine-1", printerId: "printer-1" });

    expect(res.status).toBe(201);
    expect(res.body.config.machine_id).toBe("machine-1");
    const [sql, params] = mockDbQuery.mock.calls[0];
    expect(String(sql)).toContain("INSERT INTO branch_print_configs");
    expect(params).toEqual(["owner_123", "Dubai - Branch A", "machine-1", "printer-1"]);
  });

  it("rejects creation with missing fields", async () => {
    const res = await request(makeApp())
      .post("/api/card-message/branch-configs")
      .send({ name: "Dubai" });
    expect(res.status).toBe(400);
    expect(mockDbQuery).not.toHaveBeenCalled();
  });

  it("returns 409 on duplicate branch name", async () => {
    mockDbQuery.mockRejectedValueOnce(Object.assign(new Error("dup"), { code: "23505" }));

    const res = await request(makeApp())
      .post("/api/card-message/branch-configs")
      .send({ name: "Dubai - Branch A", machineId: "m", printerId: "p" });

    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/already exists/);
  });

  it("updates a branch config", async () => {
    mockDbQuery.mockResolvedValueOnce({
      rows: [makeConfigRow({ machine_id: "machine-2" })],
      rowCount: 1,
    });

    const res = await request(makeApp())
      .patch("/api/card-message/branch-configs/1")
      .send({ machineId: "machine-2" });

    expect(res.status).toBe(200);
    expect(res.body.config.machine_id).toBe("machine-2");
    const [sql, params] = mockDbQuery.mock.calls[0];
    expect(String(sql)).toContain("UPDATE branch_print_configs");
    expect(params).toEqual([1, "owner_123", "machine-2"]);
  });

  it("returns 404 when updating a config from another workspace", async () => {
    mockDbQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const res = await request(makeApp())
      .patch("/api/card-message/branch-configs/99")
      .send({ name: "New name" });

    expect(res.status).toBe(404);
  });

  it("deletes a branch config scoped to the workspace", async () => {
    mockDbQuery.mockResolvedValueOnce({ rows: [], rowCount: 1 });

    const res = await request(makeApp()).delete("/api/card-message/branch-configs/1");

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    const [sql, params] = mockDbQuery.mock.calls[0];
    expect(String(sql)).toContain("DELETE FROM branch_print_configs");
    expect(params).toEqual([1, "owner_123"]);
  });

  it("returns 404 when deleting a missing config", async () => {
    mockDbQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    const res = await request(makeApp()).delete("/api/card-message/branch-configs/42");
    expect(res.status).toBe(404);
  });
});

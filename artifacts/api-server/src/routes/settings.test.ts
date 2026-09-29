import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";
import type { WorkspaceRequest } from "../lib/workspace";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockDbQuery = vi.fn();
const mockAssertPublicStoreUrl = vi.fn();

vi.mock("../lib/db", () => ({
  db: {
    query: (...args: unknown[]) => mockDbQuery(...args),
  },
}));

vi.mock("../lib/auth", () => ({
  requireAuth: (_req: express.Request, _res: express.Response, next: express.NextFunction) => next(),
  authed: (req: express.Request) => req,
}));

let stubWorkspaceOwnerId = "owner_123";
let stubWorkspaceRole: "owner" | "member" = "owner";

vi.mock("../lib/workspace", () => ({
  resolveWorkspace: (req: express.Request, _res: express.Response, next: express.NextFunction) => {
    const wreq = req as unknown as WorkspaceRequest;
    wreq.workspaceOwnerId = stubWorkspaceOwnerId;
    wreq.workspaceRole = stubWorkspaceRole;
    wreq.workspaceActualRole = stubWorkspaceRole;
    next();
  },
  workspace: (req: express.Request) => req as unknown as WorkspaceRequest,
}));

vi.mock("../lib/logger", () => ({
  logger: { error: vi.fn(), info: vi.fn(), warn: vi.fn() },
}));

vi.mock("../lib/urlValidator", () => ({
  assertPublicStoreUrl: (...args: unknown[]) => mockAssertPublicStoreUrl(...args),
}));

import settingsRouter from "./settings";

// ---------------------------------------------------------------------------
// Test app
// ---------------------------------------------------------------------------

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as { log: { error: (...a: unknown[]) => void; warn: (...a: unknown[]) => void; info: (...a: unknown[]) => void } }).log = {
      error: () => {},
      warn: () => {},
      info: () => {},
    };
    next();
  });
  app.use(settingsRouter);
  return app;
}

// ---------------------------------------------------------------------------
// GET /settings
// ---------------------------------------------------------------------------

describe("GET /settings", () => {
  const app = makeApp();

  beforeEach(() => {
    vi.clearAllMocks();
    mockDbQuery.mockResolvedValue({ rows: [], rowCount: 0 });
    mockAssertPublicStoreUrl.mockResolvedValue(undefined);
    stubWorkspaceOwnerId = "owner_123";
    stubWorkspaceRole = "owner";
  });

  it("returns default countries when no settings row exists", async () => {
    mockDbQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const res = await request(app).get("/settings");

    expect(res.status).toBe(200);
    expect(res.body.available_countries).toEqual(["Lebanon", "United Arab Emirates"]);
  });

  it("returns saved countries from the database", async () => {
    mockDbQuery.mockResolvedValueOnce({
      rows: [
        {
          offline_alert_threshold_minutes: 15,
          offline_alert_email_enabled: true,
          available_countries: ["France", "Germany", "Spain"],
        },
      ],
      rowCount: 1,
    });

    const res = await request(app).get("/settings");

    expect(res.status).toBe(200);
    expect(res.body.available_countries).toEqual(["France", "Germany", "Spain"]);
  });

  it("falls back to default countries when the saved list is null", async () => {
    mockDbQuery.mockResolvedValueOnce({
      rows: [
        {
          offline_alert_threshold_minutes: 5,
          offline_alert_email_enabled: false,
          available_countries: null,
        },
      ],
      rowCount: 1,
    });

    const res = await request(app).get("/settings");

    expect(res.status).toBe(200);
    expect(res.body.available_countries).toEqual(["Lebanon", "United Arab Emirates"]);
  });

  it("falls back to default countries when the saved list is empty", async () => {
    mockDbQuery.mockResolvedValueOnce({
      rows: [
        {
          offline_alert_threshold_minutes: 5,
          offline_alert_email_enabled: false,
          available_countries: [],
        },
      ],
      rowCount: 1,
    });

    const res = await request(app).get("/settings");

    expect(res.status).toBe(200);
    expect(res.body.available_countries).toEqual(["Lebanon", "United Arab Emirates"]);
  });

  it("returns other settings fields alongside available_countries", async () => {
    mockDbQuery.mockResolvedValueOnce({
      rows: [
        {
          offline_alert_threshold_minutes: 60,
          offline_alert_email_enabled: true,
          available_countries: ["Lebanon"],
        },
      ],
      rowCount: 1,
    });

    const res = await request(app).get("/settings");

    expect(res.status).toBe(200);
    expect(res.body.offline_alert_threshold_minutes).toBe(60);
    expect(res.body.offline_alert_email_enabled).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// PUT /settings
// ---------------------------------------------------------------------------

describe("PUT /settings", () => {
  const app = makeApp();

  beforeEach(() => {
    vi.clearAllMocks();
    mockDbQuery.mockResolvedValue({ rows: [], rowCount: 0 });
    stubWorkspaceOwnerId = "owner_123";
    stubWorkspaceRole = "owner";
  });

  it("returns 403 when the caller is not an owner", async () => {
    stubWorkspaceRole = "member";

    const res = await request(app).put("/settings").send({
      offline_alert_threshold_minutes: 5,
      offline_alert_email_enabled: false,
      available_countries: ["Lebanon"],
    });

    expect(res.status).toBe(403);
    expect(res.body.error).toBe("owner_only");
  });

  it("saves and returns the provided available_countries list", async () => {
    mockDbQuery.mockResolvedValueOnce({ rows: [] });

    const res = await request(app).put("/settings").send({
      offline_alert_threshold_minutes: 5,
      offline_alert_email_enabled: false,
      available_countries: ["France", "Germany"],
    });

    expect(res.status).toBe(200);
    expect(res.body.available_countries).toEqual(["France", "Germany"]);
  });

  it("passes available_countries to the INSERT/UPDATE query", async () => {
    // call[0] = SELECT delivery_webhook_url (no delivery_webhook_url in body)
    // call[1] = INSERT/UPDATE workspace_settings
    mockDbQuery.mockResolvedValueOnce({ rows: [] }); // SELECT delivery_webhook_url

    await request(app).put("/settings").send({
      offline_alert_threshold_minutes: 5,
      offline_alert_email_enabled: false,
      available_countries: ["Japan", "South Korea"],
    });

    const queryParams = mockDbQuery.mock.calls[1][1] as unknown[];
    expect(queryParams).toContainEqual(["Japan", "South Korea"]);
  });

  it("returns 400 when available_countries is not an array", async () => {
    const res = await request(app).put("/settings").send({
      offline_alert_threshold_minutes: 5,
      offline_alert_email_enabled: false,
      available_countries: "Lebanon",
    });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/array/i);
  });

  it("returns 400 for an invalid threshold value", async () => {
    const res = await request(app).put("/settings").send({
      offline_alert_threshold_minutes: 999,
      offline_alert_email_enabled: false,
      available_countries: ["Lebanon"],
    });

    expect(res.status).toBe(400);
  });

  it("rejects a delivery webhook URL that is not a public HTTPS address", async () => {
    mockAssertPublicStoreUrl.mockRejectedValueOnce(new Error("private address"));

    const res = await request(app).put("/settings").send({
      offline_alert_threshold_minutes: 5,
      offline_alert_email_enabled: false,
      available_countries: ["Lebanon"],
      delivery_webhook_url: "http://169.254.169.254/latest/meta-data",
    });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("delivery_webhook_url must be a public HTTPS address");
    expect(mockDbQuery.mock.calls.some(([sql]) => /INSERT INTO workspace_settings/.test(String(sql)))).toBe(false);
  });

  it("strips empty strings from available_countries before saving", async () => {
    mockDbQuery.mockResolvedValueOnce({ rows: [] });

    const res = await request(app).put("/settings").send({
      offline_alert_threshold_minutes: 5,
      offline_alert_email_enabled: false,
      available_countries: ["Lebanon", "  ", ""],
    });

    expect(res.status).toBe(200);
    expect(res.body.available_countries).toEqual(["Lebanon"]);
  });

  it("falls back to default countries when available_countries array is entirely empty strings", async () => {
    mockDbQuery.mockResolvedValueOnce({ rows: [] });

    const res = await request(app).put("/settings").send({
      offline_alert_threshold_minutes: 5,
      offline_alert_email_enabled: false,
      available_countries: ["  ", ""],
    });

    expect(res.status).toBe(200);
    expect(res.body.available_countries).toEqual(["Lebanon", "United Arab Emirates"]);
  });

  it("rejects 400 when available_countries includes Israel", async () => {
    const res = await request(app).put("/settings").send({
      offline_alert_threshold_minutes: 5,
      offline_alert_email_enabled: false,
      available_countries: ["Lebanon", "Israel", "France"],
    });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/not supported/i);
    expect(mockDbQuery).not.toHaveBeenCalled();
  });

  it("rejects 400 when only Israel is sent in available_countries", async () => {
    const res = await request(app).put("/settings").send({
      offline_alert_threshold_minutes: 5,
      offline_alert_email_enabled: false,
      available_countries: ["Israel"],
    });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/not supported/i);
    expect(mockDbQuery).not.toHaveBeenCalled();
  });

  it("rejects 400 when the ISO code IL is sent in available_countries", async () => {
    const res = await request(app).put("/settings").send({
      offline_alert_threshold_minutes: 5,
      offline_alert_email_enabled: false,
      available_countries: ["Lebanon", "IL"],
    });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/not supported/i);
    expect(mockDbQuery).not.toHaveBeenCalled();
  });
});

describe("GET /settings — Israel exclusion", () => {
  const app = makeApp();

  beforeEach(() => {
    vi.clearAllMocks();
    mockDbQuery.mockResolvedValue({ rows: [], rowCount: 0 });
    stubWorkspaceOwnerId = "owner_123";
    stubWorkspaceRole = "owner";
  });

  it("strips Israel from a saved available_countries list returned by GET", async () => {
    mockDbQuery.mockResolvedValueOnce({
      rows: [
        {
          offline_alert_threshold_minutes: 5,
          offline_alert_email_enabled: false,
          available_countries: ["Lebanon", "Israel", "United Arab Emirates"],
        },
      ],
      rowCount: 1,
    });

    const res = await request(app).get("/settings");

    expect(res.status).toBe(200);
    expect(res.body.available_countries).toEqual(["Lebanon", "United Arab Emirates"]);
    expect(res.body.available_countries).not.toContain("Israel");
  });

  it("falls back to default countries when the saved list contains only Israel", async () => {
    mockDbQuery.mockResolvedValueOnce({
      rows: [
        {
          offline_alert_threshold_minutes: 5,
          offline_alert_email_enabled: false,
          available_countries: ["Israel"],
        },
      ],
      rowCount: 1,
    });

    const res = await request(app).get("/settings");

    expect(res.status).toBe(200);
    expect(res.body.available_countries).toEqual(["Lebanon", "United Arab Emirates"]);
  });
});

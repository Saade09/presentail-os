import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";

// ---------------------------------------------------------------------------
// Mocks — declared before importing the module under test
// ---------------------------------------------------------------------------

const mockDbQuery = vi.fn();

vi.mock("../lib/db", () => ({
  db: {
    query: (...args: unknown[]) => mockDbQuery(...args),
  },
}));

// Configurable requireApiKey stub — mirrors the pattern used in brands.test.ts.
// When stubApiKeyValid=true it injects userId/apiKeyId and calls next().
// When false it short-circuits with 401 exactly as the real middleware would.
let stubApiKeyValid = true;
let stubUserId = "user_abc";

vi.mock("../lib/apiKeyAuth", () => ({
  requireApiKey: (
    req: express.Request,
    res: express.Response,
    next: express.NextFunction,
  ) => {
    if (!stubApiKeyValid) {
      res.status(401).json({ error: "Missing Bearer token" });
      return;
    }
    (req as express.Request & { userId: string; apiKeyId: number }).userId = stubUserId;
    (req as express.Request & { userId: string; apiKeyId: number }).apiKeyId = 1;
    next();
  },
}));

vi.mock("../lib/logger", () => ({
  logger: { error: vi.fn(), info: vi.fn(), warn: vi.fn() },
}));

import jobsRouter from "./jobs";

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
  app.use(jobsRouter);
  return app;
}

// Minimal valid PDF header
const TINY_PDF = Buffer.from("%PDF-1.4\n%%EOF\n");

// ---------------------------------------------------------------------------
// POST /jobs — submit a remote print job
// ---------------------------------------------------------------------------

describe("POST /jobs — submit a remote print job", () => {
  const app = makeApp();

  beforeEach(() => {
    vi.clearAllMocks();
    mockDbQuery.mockResolvedValue({ rows: [], rowCount: 0 });
    stubApiKeyValid = true;
    stubUserId = "user_abc";
  });

  it("returns 401 when no API key is provided", async () => {
    stubApiKeyValid = false;

    const res = await request(app)
      .post("/jobs")
      .attach("file", TINY_PDF, { filename: "doc.pdf", contentType: "application/pdf" });

    expect(res.status).toBe(401);
    expect(res.body).toHaveProperty("error");
  });

  it("returns 400 when the file field is missing", async () => {
    const res = await request(app)
      .post("/jobs")
      .field("device_id", "dev-1");

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/missing 'file' field/i);
  });

  it("returns 400 when the uploaded file is not a PDF", async () => {
    const notPdf = Buffer.from("Not a PDF");

    const res = await request(app)
      .post("/jobs")
      .attach("file", notPdf, { filename: "doc.txt", contentType: "text/plain" });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/does not look like a valid PDF/i);
  });

  it("returns 404 when the device_id is not found or does not belong to the caller", async () => {
    mockDbQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 }); // device check fails

    const res = await request(app)
      .post("/jobs")
      .field("device_id", "missing-device")
      .attach("file", TINY_PDF, { filename: "doc.pdf", contentType: "application/pdf" });

    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/device_id not found/i);
  });

  it("returns 201 with job id and status on successful submission (no device_id)", async () => {
    mockDbQuery.mockResolvedValueOnce({
      rows: [{ id: 77, status: "pending", created_at: "2024-01-01T00:00:00Z" }],
    });

    const res = await request(app)
      .post("/jobs")
      .field("title", "My Print Job")
      .field("copies", "2")
      .attach("file", TINY_PDF, { filename: "doc.pdf", contentType: "application/pdf" });

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ id: 77, status: "pending" });
    expect(res.body).toHaveProperty("created_at");
  });

  it("returns 201 when a valid device_id belonging to the caller is provided", async () => {
    mockDbQuery
      .mockResolvedValueOnce({ rows: [{ id: "dev-1" }], rowCount: 1 }) // device check passes
      .mockResolvedValueOnce({
        rows: [{ id: 88, status: "pending", created_at: "2024-06-01T00:00:00Z" }],
      });

    const res = await request(app)
      .post("/jobs")
      .field("device_id", "dev-1")
      .attach("file", TINY_PDF, { filename: "report.pdf", contentType: "application/pdf" });

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ id: 88, status: "pending" });
  });

  it("scopes the device ownership check to the authenticated user id", async () => {
    stubUserId = "user_xyz";
    mockDbQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    await request(app)
      .post("/jobs")
      .field("device_id", "dev-99")
      .attach("file", TINY_PDF, { filename: "doc.pdf", contentType: "application/pdf" });

    const [, params] = mockDbQuery.mock.calls[0];
    expect(params).toContain("user_xyz");
    expect(params).toContain("dev-99");
  });
});

// ---------------------------------------------------------------------------
// GET /jobs/:id — poll job status
// ---------------------------------------------------------------------------

describe("GET /jobs/:id — poll job status", () => {
  const app = makeApp();

  beforeEach(() => {
    vi.clearAllMocks();
    mockDbQuery.mockResolvedValue({ rows: [], rowCount: 0 });
    stubApiKeyValid = true;
    stubUserId = "user_abc";
  });

  it("returns 401 when no API key is provided", async () => {
    stubApiKeyValid = false;

    const res = await request(app).get("/jobs/42");

    expect(res.status).toBe(401);
    expect(res.body).toHaveProperty("error");
  });

  it("returns 400 for a non-numeric job id", async () => {
    const res = await request(app).get("/jobs/not-a-number");

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/invalid job id/i);
  });

  it("returns 404 when the job does not exist or belongs to a different user", async () => {
    mockDbQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const res = await request(app).get("/jobs/999");

    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/job not found/i);
  });

  it("returns 200 with job details when the job belongs to the caller", async () => {
    const jobRow = {
      id: 42,
      device_id: "dev-1",
      device_name: "Printer A",
      printer_name: "HP LaserJet",
      file_name: "doc.pdf",
      copies: 1,
      status: "done",
      error: null,
      pages: 3,
      created_at: "2024-01-01T00:00:00Z",
      completed_at: "2024-01-01T00:01:00Z",
      claimed_at: null,
    };
    mockDbQuery.mockResolvedValueOnce({ rows: [jobRow], rowCount: 1 });

    const res = await request(app).get("/jobs/42");

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("job");
    expect(res.body.job).toMatchObject({ id: 42, status: "done", pages: 3 });
  });

  it("scopes the query to the authenticated user id", async () => {
    stubUserId = "user_xyz";
    mockDbQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    await request(app).get("/jobs/5");

    const [, params] = mockDbQuery.mock.calls[0];
    expect(params).toContain("user_xyz");
    expect(params).toContain(5);
  });
});

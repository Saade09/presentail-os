import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";
import type { WorkspaceRequest } from "../lib/workspace";

// ---------------------------------------------------------------------------
// Mocks — must be declared before importing the module under test
// ---------------------------------------------------------------------------

// SENTINEL PATTERN
// Tests that exercise multi-DB-call route handlers should assert the exact
// number of db.query() calls at the end of every success-path test using
// expect(mockDbQuery).toHaveBeenCalledTimes(N).  This ensures that any new
// db.query() call added to the route fails the test immediately rather than
// silently consuming the catch-all mockResolvedValue fallback set in beforeEach.
// See products.test.ts and timeOff.test.ts for annotated examples.
//
// Current base-items tests focus on GET list/filter and image-upload paths
// that either make 2 DB calls (COUNT + SELECT) or no DB calls (uploads).
// If POST /base-items or PATCH /base-items/:id unit tests are added, follow
// the same call-count assertion pattern.

const mockDbQuery = vi.fn();
const mockClientQuery = vi.fn();
const mockClientRelease = vi.fn();
const ADJUSTMENT_ACTION_ID = "11111111-1111-4111-8111-111111111111";
const TRANSFER_ACTION_ID = "22222222-2222-4222-8222-222222222222";

vi.mock("../lib/db", () => ({
  db: {
    query: (...args: unknown[]) => mockDbQuery(...args),
    connect: () => Promise.resolve({
      query: (...args: unknown[]) => mockClientQuery(...args),
      release: () => mockClientRelease(),
    }),
  },
}));

vi.mock("../lib/auth", () => ({
  requireAuth: (_req: express.Request, _res: express.Response, next: express.NextFunction) => next(),
  authed: (req: express.Request) => req,
}));

let stubWorkspaceOwnerId = "owner_123";
let stubActualRole = "owner";
let stubAllowedPages: string[] | null = null;

vi.mock("../lib/workspace", () => ({
  resolveWorkspace: (req: express.Request, _res: express.Response, next: express.NextFunction) => {
    const wreq = req as unknown as WorkspaceRequest;
    wreq.workspaceOwnerId = stubWorkspaceOwnerId;
    wreq.workspaceActualRole = stubActualRole;
    wreq.workspaceRole = stubActualRole === "owner" ? "owner" : "member";
    wreq.allowedPages = stubAllowedPages;
    next();
  },
  workspace: (req: express.Request) => req as unknown as WorkspaceRequest,
}));

const mockFileSave = vi.fn().mockResolvedValue(undefined);
const mockBucketFile = vi.fn().mockReturnValue({ save: mockFileSave });
const mockBucket = vi.fn().mockReturnValue({ file: mockBucketFile });

vi.mock("../lib/objectStorage", () => ({
  objectStorageClient: {
    bucket: (...args: unknown[]) => mockBucket(...args),
  },
}));

const mockGenerateImageBuffer = vi.fn();

vi.mock("@workspace/integrations-openai-ai-server/image", () => ({
  generateImageBuffer: (...args: unknown[]) => mockGenerateImageBuffer(...args),
}));

vi.mock("../lib/logger", () => ({
  logger: { error: vi.fn(), info: vi.fn(), warn: vi.fn() },
}));

const mockSendLowStockAlertEmail = vi.fn().mockResolvedValue(undefined);

vi.mock("../lib/email", () => ({
  sendLowStockAlertEmail: (...args: unknown[]) => mockSendLowStockAlertEmail(...args),
}));

import baseItemsRouter from "./baseItems";

// ---------------------------------------------------------------------------
// Test app
// ---------------------------------------------------------------------------

const mockReqLogError = vi.fn();

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as { log: { error: typeof mockReqLogError; warn: typeof mockReqLogError; info: typeof mockReqLogError } }).log = {
      error: mockReqLogError,
      warn: mockReqLogError,
      info: mockReqLogError,
    };
    next();
  });
  app.use(baseItemsRouter);
  return app;
}

describe("GET /base-items — response validation", () => {
  const app = makeApp();

  beforeEach(() => {
    vi.clearAllMocks();
    mockDbQuery.mockReset();
    // Default: COUNT returns 0, items returns []
    mockDbQuery.mockImplementation(async (sql: string) => {
      if (/COUNT\(\*\)/i.test(sql)) return { rows: [{ count: "0" }] };
      return { rows: [], rowCount: 0 };
    });
    stubActualRole = "owner";
    stubWorkspaceOwnerId = "owner_123";
    stubAllowedPages = null;
  });

  it("returns 500 and logs when a row fails response validation", async () => {
    const invalidRow = {
      id: 1,
      workspace_owner_id: "owner_123",
      // name is required string but null here triggers Zod failure
      name: null,
      code: "ABC123",
      image_url: null,
      category_id: null,
      alternate_name: null,
      accounting_category: null,
      tax_rate: null,
      created_at: "2024-01-01T00:00:00Z",
      main_category_name: null,
      sub_category_name: null,
    };
    mockDbQuery
      .mockResolvedValueOnce({ rows: [{ count: "1" }] }) // COUNT call
      .mockResolvedValueOnce({ rows: [invalidRow] });     // items call (triggers Zod failure)

    const res = await request(app).get("/base-items");

    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: "Internal server error" });
    expect(mockReqLogError).toHaveBeenCalledWith(
      expect.objectContaining({ route: "GET /base-items", err: expect.any(Array) }),
      "Response validation failed",
    );
  });
});

describe("canonical supplier pricing UOM routes", () => {
  const app = makeApp();

  beforeEach(() => {
    vi.clearAllMocks();
    mockDbQuery.mockReset();
    stubActualRole = "owner";
    stubWorkspaceOwnerId = "owner_123";
    stubAllowedPages = null;
  });

  it("lists active context units and searches aliases", async () => {
    mockDbQuery.mockResolvedValueOnce({
      rows: [{ code: "piece", display_name: "Piece", aliases: ["piece", "pieces", "pc", "pcs"] }],
      rowCount: 1,
    });

    const res = await request(app).get("/uoms?context=supplier_pricing&q=pcs");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      context: "supplier_pricing",
      uoms: [{ code: "piece", display_name: "Piece", aliases: ["piece", "pieces", "pc", "pcs"] }],
    });
    expect(mockDbQuery).toHaveBeenCalledTimes(1);
    expect(mockDbQuery.mock.calls[0][0]).toContain("uom_context_availability");
    expect(mockDbQuery.mock.calls[0][1]).toEqual(["supplier_pricing", "%pcs%"]);
  });

  it("rejects arbitrary or alias text when creating a supplier link", async () => {
    mockDbQuery
      .mockResolvedValueOnce({ rows: [{ id: 42 }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [{ id: 10 }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const res = await request(app)
      .post("/base-items/42/suppliers")
      .send({ supplier_id: 10, pricing_uom_code: "pcs" });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/active canonical/i);
    expect(mockDbQuery).toHaveBeenCalledTimes(3);
    expect(mockDbQuery.mock.calls.some(([sql]) => String(sql).includes("INSERT INTO base_item_suppliers"))).toBe(false);
  });

  it("stores a validated stable code and compatibility label", async () => {
    mockDbQuery
      .mockResolvedValueOnce({ rows: [{ id: 42 }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [{ id: 10 }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [{ code: "piece", display_name: "Piece" }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [{ id: 77 }], rowCount: 1 })
      .mockResolvedValueOnce({
        rows: [{ id: 77, pricing_uom: "Piece", pricing_uom_code: "piece", pricing_uom_legacy: null }],
        rowCount: 1,
      });

    const res = await request(app)
      .post("/base-items/42/suppliers")
      .send({ supplier_id: 10, pricing_uom_code: "piece" });

    expect(res.status).toBe(201);
    expect(res.body.supplier.pricing_uom_code).toBe("piece");
    const insertParams = mockDbQuery.mock.calls[3][1] as unknown[];
    expect(insertParams[6]).toBe("piece");
    expect(insertParams[7]).toBe("Piece");
    expect(mockDbQuery).toHaveBeenCalledTimes(5);
  });

  it("preserves unresolved legacy text when an unrelated field is patched", async () => {
    const legacyRow = {
      id: 77,
      workspace_owner_id: "owner_123",
      base_item_id: 42,
      supplier_id: 10,
      package_id: null,
      supplier_item_name: null,
      supplier_item_code: null,
      pricing_uom_code: null,
      pricing_uom: "crate",
      price: "2",
      currency: "AED",
      is_preferred: false,
      is_default_order_unit: false,
      name_ar: null,
      name_ar_source: null,
    };
    mockDbQuery
      .mockResolvedValueOnce({ rows: [legacyRow], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })
      .mockResolvedValueOnce({
        rows: [{ ...legacyRow, price: "3", pricing_uom_legacy: "crate" }],
        rowCount: 1,
      });

    const res = await request(app)
      .patch("/base-items/42/suppliers/77")
      .send({ price: 3 });

    expect(res.status).toBe(200);
    const updateParams = mockDbQuery.mock.calls[1][1] as unknown[];
    expect(updateParams[4]).toBeNull();
    expect(updateParams[5]).toBe("crate");
    expect(mockDbQuery).toHaveBeenCalledTimes(3);
  });
});

// ---------------------------------------------------------------------------
// POST /base-items/generate-image
// ---------------------------------------------------------------------------

describe("POST /base-items/generate-image — auth check", () => {
  const app = makeApp();

  beforeEach(() => {
    vi.clearAllMocks();
    mockDbQuery.mockReset();
    mockDbQuery.mockResolvedValue({ rows: [], rowCount: 0 });
    stubActualRole = "owner";
    stubWorkspaceOwnerId = "owner_123";
    stubAllowedPages = null;
  });

  it("returns 403 when caller is a member without manage permissions", async () => {
    stubActualRole = "member";
    stubAllowedPages = [];

    const res = await request(app)
      .post("/base-items/generate-image")
      .send({ prompt: "a red mug" });

    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/creating base items/i);
  });

  it("returns 403 when caller has allowedPages that do not include base_items.manage or base_items.create", async () => {
    stubActualRole = "member";
    stubAllowedPages = ["base_items.view", "brands.manage"];

    const res = await request(app)
      .post("/base-items/generate-image")
      .send({ prompt: "a blue hat" });

    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/creating base items/i);
  });

  it("allows a member with base_items.manage in allowedPages", async () => {
    stubActualRole = "member";
    stubAllowedPages = ["base_items.manage"];
    process.env.PRIVATE_OBJECT_DIR = "/test-bucket/private";
    mockGenerateImageBuffer.mockResolvedValueOnce(Buffer.from("fake-image-data"));

    const res = await request(app)
      .post("/base-items/generate-image")
      .send({ prompt: "a green bottle" });

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("urls");
    expect(Array.isArray(res.body.urls)).toBe(true);
    expect(res.body.urls.length).toBeGreaterThan(0);
  });

  it("allows a member with base_items.create in allowedPages", async () => {
    stubActualRole = "member";
    stubAllowedPages = ["base_items.create"];
    process.env.PRIVATE_OBJECT_DIR = "/test-bucket/private";
    mockGenerateImageBuffer.mockResolvedValueOnce(Buffer.from("fake-image-data"));

    const res = await request(app)
      .post("/base-items/generate-image")
      .send({ prompt: "a green bottle" });

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("urls");
  });
});

describe("POST /base-items/generate-image — prompt validation", () => {
  const app = makeApp();

  beforeEach(() => {
    vi.clearAllMocks();
    mockDbQuery.mockReset();
    mockDbQuery.mockResolvedValue({ rows: [], rowCount: 0 });
    stubActualRole = "owner";
    stubWorkspaceOwnerId = "owner_123";
    stubAllowedPages = null;
  });

  it("returns 400 when prompt field is missing", async () => {
    const res = await request(app)
      .post("/base-items/generate-image")
      .send({});

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/prompt is required/i);
  });

  it("returns 400 when prompt is an empty string", async () => {
    const res = await request(app)
      .post("/base-items/generate-image")
      .send({ prompt: "" });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/prompt is required/i);
  });

  it("returns 400 when prompt is a whitespace-only string", async () => {
    const res = await request(app)
      .post("/base-items/generate-image")
      .send({ prompt: "   " });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/prompt is required/i);
  });

  it("returns 400 when prompt is not a string (number)", async () => {
    const res = await request(app)
      .post("/base-items/generate-image")
      .send({ prompt: 42 });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/prompt is required/i);
  });
});

describe("POST /base-items/generate-image — successful generation", () => {
  const app = makeApp();

  beforeEach(() => {
    vi.clearAllMocks();
    mockDbQuery.mockReset();
    mockDbQuery.mockResolvedValue({ rows: [], rowCount: 0 });
    stubActualRole = "owner";
    stubWorkspaceOwnerId = "owner_123";
    stubAllowedPages = null;
    process.env.PRIVATE_OBJECT_DIR = "/test-bucket/private";
    mockGenerateImageBuffer.mockResolvedValue(Buffer.from("fake-png-bytes"));
  });

  it("returns 200 with a urls array pointing to object storage on a valid request", async () => {
    const res = await request(app)
      .post("/base-items/generate-image")
      .send({ prompt: "a ceramic coffee mug" });

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("urls");
    expect(Array.isArray(res.body.urls)).toBe(true);
    expect(res.body.urls.length).toBeGreaterThan(0);
    expect(typeof res.body.urls[0]).toBe("string");
    expect(res.body.urls[0]).toMatch(/^\/objects\//);
  });

  it("includes the workspaceOwnerId in the returned url path", async () => {
    stubWorkspaceOwnerId = "ws_abc";

    const res = await request(app)
      .post("/base-items/generate-image")
      .send({ prompt: "a leather wallet" });

    expect(res.status).toBe(200);
    expect(res.body.urls[0]).toContain("ws_abc");
    expect(res.body.urls[0]).toContain("base-items");
  });

  it("passes the prompt (with style suffix appended) to generateImageBuffer", async () => {
    const res = await request(app)
      .post("/base-items/generate-image")
      .send({ prompt: "a silver pen" });

    expect(res.status).toBe(200);
    expect(mockGenerateImageBuffer).toHaveBeenCalledOnce();
    const [calledPrompt] = mockGenerateImageBuffer.mock.calls[0];
    expect(calledPrompt).toContain("a silver pen");
    expect(calledPrompt).toContain("photorealistic product photo");
  });

  it("uploads the generated buffer to object storage with image/png content type", async () => {
    const fakeBuffer = Buffer.from("png-data");
    mockGenerateImageBuffer.mockResolvedValueOnce(fakeBuffer);

    const res = await request(app)
      .post("/base-items/generate-image")
      .send({ prompt: "a wooden spoon" });

    expect(res.status).toBe(200);
    expect(mockFileSave).toHaveBeenCalledOnce();
    const [savedBuffer, saveOptions] = mockFileSave.mock.calls[0];
    expect(Buffer.isBuffer(savedBuffer)).toBe(true);
    expect(saveOptions).toMatchObject({ contentType: "image/png" });
  });

  it("returns 502 when generateImageBuffer returns an empty buffer", async () => {
    mockGenerateImageBuffer.mockResolvedValueOnce(Buffer.alloc(0));

    const res = await request(app)
      .post("/base-items/generate-image")
      .send({ prompt: "a golden ring" });

    expect(res.status).toBe(502);
    expect(res.body.error).toMatch(/empty result/i);
  });

  it("returns 500 when generateImageBuffer throws an error", async () => {
    mockGenerateImageBuffer.mockRejectedValueOnce(new Error("OpenAI quota exceeded"));

    const res = await request(app)
      .post("/base-items/generate-image")
      .send({ prompt: "a purple umbrella" });

    expect(res.status).toBe(500);
    expect(res.body.error).toMatch(/failed to generate image/i);
  });

  it("returns 500 when object storage upload fails", async () => {
    mockFileSave.mockRejectedValueOnce(new Error("Storage unavailable"));

    const res = await request(app)
      .post("/base-items/generate-image")
      .send({ prompt: "a black notebook" });

    expect(res.status).toBe(500);
    expect(res.body.error).toMatch(/failed to generate image/i);
  });
});

// ---------------------------------------------------------------------------
// POST /base-items/generate-image — missing storage configuration
// ---------------------------------------------------------------------------

describe("POST /base-items/generate-image — missing storage configuration", () => {
  const app = makeApp();

  beforeEach(() => {
    vi.clearAllMocks();
    mockDbQuery.mockReset();
    mockDbQuery.mockResolvedValue({ rows: [], rowCount: 0 });
    stubActualRole = "owner";
    stubWorkspaceOwnerId = "owner_123";
    stubAllowedPages = null;
  });

  it("returns 500 when PRIVATE_OBJECT_DIR is not configured", async () => {
    const savedDir = process.env.PRIVATE_OBJECT_DIR;
    delete process.env.PRIVATE_OBJECT_DIR;

    mockGenerateImageBuffer.mockResolvedValueOnce(Buffer.from("fake-image-data"));

    try {
      const res = await request(app)
        .post("/base-items/generate-image")
        .send({ prompt: "a ceramic mug" });

      expect(res.status).toBe(500);
      expect(res.body.error).toMatch(/failed to generate image/i);
    } finally {
      if (savedDir !== undefined) {
        process.env.PRIVATE_OBJECT_DIR = savedDir;
      }
    }
  });
});

// ---------------------------------------------------------------------------
// POST /base-items/upload-image
// ---------------------------------------------------------------------------

describe("POST /base-items/upload-image", () => {
  const app = makeApp();

  beforeEach(() => {
    vi.clearAllMocks();
    mockDbQuery.mockReset();
    mockDbQuery.mockResolvedValue({ rows: [], rowCount: 0 });
    stubActualRole = "owner";
    stubWorkspaceOwnerId = "owner_123";
    stubAllowedPages = null;
    process.env.PRIVATE_OBJECT_DIR = "/test-bucket/private";
    mockFileSave.mockReset();
    mockFileSave.mockResolvedValue(undefined);
  });

  it("returns 403 when caller is a member without manage permissions", async () => {
    stubActualRole = "member";
    stubAllowedPages = [];

    const res = await request(app)
      .post("/base-items/upload-image")
      .attach("image", Buffer.from("fake-image"), { filename: "test.png", contentType: "image/png" });

    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/creating base items/i);
  });

  it("returns 403 when caller has allowedPages that do not include base_items.manage or base_items.create", async () => {
    stubActualRole = "member";
    stubAllowedPages = ["base_items.view", "brands.manage"];

    const res = await request(app)
      .post("/base-items/upload-image")
      .attach("image", Buffer.from("fake-image"), { filename: "test.png", contentType: "image/png" });

    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/creating base items/i);
  });

  it("allows a member with base_items.create permission to upload an image", async () => {
    stubActualRole = "member";
    stubAllowedPages = ["base_items.create"];
    process.env.PRIVATE_OBJECT_DIR = "/test-bucket/private";

    const res = await request(app)
      .post("/base-items/upload-image")
      .attach("image", Buffer.from("fake-png-data"), { filename: "photo.png", contentType: "image/png" });

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("url");
  });

  it("returns 400 when no file is attached", async () => {
    const res = await request(app)
      .post("/base-items/upload-image");

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/image file is required/i);
  });

  it("returns 400 when file has an unsupported mime type", async () => {
    const res = await request(app)
      .post("/base-items/upload-image")
      .attach("image", Buffer.from("fake-data"), { filename: "test.txt", contentType: "text/plain" });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/JPEG, PNG, or WebP/i);
  });

  it("returns 200 with a storage url on a valid PNG upload", async () => {
    const res = await request(app)
      .post("/base-items/upload-image")
      .attach("image", Buffer.from("fake-png-data"), { filename: "photo.png", contentType: "image/png" });

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("url");
    expect(typeof res.body.url).toBe("string");
    expect(res.body.url).toMatch(/^\/objects\//);
    expect(res.body.url).toContain("owner_123");
    expect(res.body.url).toContain("base-items");
  });

  it("accepts JPEG files and returns 200", async () => {
    const res = await request(app)
      .post("/base-items/upload-image")
      .attach("image", Buffer.from("fake-jpeg-data"), { filename: "photo.jpg", contentType: "image/jpeg" });

    expect(res.status).toBe(200);
    expect(res.body.url).toMatch(/^\/objects\//);
  });

  it("accepts WebP files and returns 200", async () => {
    const res = await request(app)
      .post("/base-items/upload-image")
      .attach("image", Buffer.from("fake-webp-data"), { filename: "photo.webp", contentType: "image/webp" });

    expect(res.status).toBe(200);
    expect(res.body.url).toMatch(/^\/objects\//);
  });

  it("passes the buffer to object storage with the correct content type", async () => {
    const fakeBuffer = Buffer.from("real-png-bytes");

    const res = await request(app)
      .post("/base-items/upload-image")
      .attach("image", fakeBuffer, { filename: "photo.png", contentType: "image/png" });

    expect(res.status).toBe(200);
    expect(mockFileSave).toHaveBeenCalledOnce();
    const [, saveOptions] = mockFileSave.mock.calls[0];
    expect(saveOptions).toMatchObject({ contentType: "image/png" });
  });

  it("returns 500 when object storage upload fails", async () => {
    mockFileSave.mockRejectedValueOnce(new Error("Storage unavailable"));

    const res = await request(app)
      .post("/base-items/upload-image")
      .attach("image", Buffer.from("fake-png-data"), { filename: "photo.png", contentType: "image/png" });

    expect(res.status).toBe(500);
    expect(res.body.error).toMatch(/failed to upload image/i);
  });

  it("returns 500 when PRIVATE_OBJECT_DIR is not configured", async () => {
    const savedDir = process.env.PRIVATE_OBJECT_DIR;
    delete process.env.PRIVATE_OBJECT_DIR;

    try {
      const res = await request(app)
        .post("/base-items/upload-image")
        .attach("image", Buffer.from("fake-png-data"), { filename: "photo.png", contentType: "image/png" });

      expect(res.status).toBe(500);
      expect(res.body.error).toMatch(/failed to upload image/i);
    } finally {
      if (savedDir !== undefined) {
        process.env.PRIVATE_OBJECT_DIR = savedDir;
      }
    }
  });
});

// ---------------------------------------------------------------------------
// GET /base-items/check-name
// ---------------------------------------------------------------------------

describe("GET /base-items/check-name", () => {
  const app = makeApp();

  beforeEach(() => {
    vi.clearAllMocks();
    mockDbQuery.mockReset();
    mockDbQuery.mockResolvedValue({ rows: [], rowCount: 0 });
    stubActualRole = "owner";
    stubWorkspaceOwnerId = "owner_123";
    stubAllowedPages = null;
  });

  it("returns empty result when name query param is missing", async () => {
    const res = await request(app).get("/base-items/check-name");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ exactMatch: null, similarMatches: [] });
    expect(mockDbQuery).not.toHaveBeenCalled();
  });

  it("returns empty result when name query param is whitespace-only", async () => {
    const res = await request(app).get("/base-items/check-name?name=   ");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ exactMatch: null, similarMatches: [] });
    expect(mockDbQuery).not.toHaveBeenCalled();
  });

  it("returns exactMatch when a name matches case-insensitively", async () => {
    mockDbQuery.mockResolvedValueOnce({
      rows: [{ name: "Red Roses" }, { name: "Blue Tulips" }],
      rowCount: 2,
    });

    const res = await request(app).get("/base-items/check-name?name=red+roses");

    expect(res.status).toBe(200);
    expect(res.body.exactMatch).toBe("Red Roses");
    expect(res.body.similarMatches).toEqual([]);
    expect(mockDbQuery).toHaveBeenCalledTimes(1);
    expect(mockDbQuery.mock.calls[0][1]).toContain("owner_123");
  });

  it("returns similarMatches when the typed name is a substring of an existing name", async () => {
    mockDbQuery.mockResolvedValueOnce({
      rows: [{ name: "Red Roses" }, { name: "Blue Tulips" }],
      rowCount: 2,
    });

    const res = await request(app).get("/base-items/check-name?name=Red");

    expect(res.status).toBe(200);
    expect(res.body.exactMatch).toBeNull();
    expect(res.body.similarMatches).toEqual(["Red Roses"]);
  });

  it("returns similarMatches when an existing name is a substring of the typed name", async () => {
    mockDbQuery.mockResolvedValueOnce({
      rows: [{ name: "Rose" }],
      rowCount: 1,
    });

    const res = await request(app).get("/base-items/check-name?name=Red+Rose+Bouquet");

    expect(res.status).toBe(200);
    expect(res.body.exactMatch).toBeNull();
    expect(res.body.similarMatches).toEqual(["Rose"]);
  });

  it("returns no matches when the name is unique", async () => {
    mockDbQuery.mockResolvedValueOnce({
      rows: [{ name: "Red Roses" }, { name: "Blue Tulips" }],
      rowCount: 2,
    });

    const res = await request(app).get("/base-items/check-name?name=Orchid");

    expect(res.status).toBe(200);
    expect(res.body.exactMatch).toBeNull();
    expect(res.body.similarMatches).toEqual([]);
  });

  it("scopes the query to the authenticated workspace owner", async () => {
    stubWorkspaceOwnerId = "owner_xyz";
    mockDbQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    await request(app).get("/base-items/check-name?name=Rose");

    expect(mockDbQuery).toHaveBeenCalledTimes(1);
    expect(mockDbQuery.mock.calls[0][1]).toContain("owner_xyz");
  });
});

// ---------------------------------------------------------------------------
// GET /base-items — category filtering
// ---------------------------------------------------------------------------

describe("GET /base-items — no filter", () => {
  const app = makeApp();

  beforeEach(() => {
    vi.clearAllMocks();
    mockDbQuery.mockReset();
    mockDbQuery.mockImplementation(async (sql: string) => {
      if (/COUNT\(\*\)/i.test(sql)) return { rows: [{ count: "0" }] };
      return { rows: [], rowCount: 0 };
    });
    stubActualRole = "owner";
    stubWorkspaceOwnerId = "owner_123";
    stubAllowedPages = null;
  });

  it("returns all workspace items when no filters are provided", async () => {
    const rows = [
      { id: 1, workspace_owner_id: "owner_123", name: "Red Roses", code: "A12345", image_url: null, category_id: null, created_at: "2024-01-01T00:00:00Z", main_category_name: null, sub_category_name: null },
      { id: 2, workspace_owner_id: "owner_123", name: "Blue Tulips", code: "B23456", image_url: null, category_id: 10, created_at: "2024-01-02T00:00:00Z", main_category_name: "Flowers", sub_category_name: "Dutch" },
    ];
    mockDbQuery
      .mockResolvedValueOnce({ rows: [{ count: "2" }] }) // COUNT call
      .mockResolvedValueOnce({ rows, rowCount: 2 });     // items call

    const res = await request(app).get("/base-items");

    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(2);
    expect(res.body.items[0].name).toBe("Red Roses");
    expect(res.body.items[1].name).toBe("Blue Tulips");
  });

  it("passes the workspace owner id as the first query param", async () => {
    stubWorkspaceOwnerId = "owner_xyz";

    await request(app).get("/base-items");

    expect(mockDbQuery).toHaveBeenCalledTimes(2);
    const [, params] = mockDbQuery.mock.calls[0]; // COUNT query — has workspaceOwnerId as $1
    expect(params[0]).toBe("owner_xyz");
  });
});

describe("GET /base-items — ?main_category_id filter", () => {
  const app = makeApp();

  beforeEach(() => {
    vi.clearAllMocks();
    mockDbQuery.mockReset();
    mockDbQuery.mockImplementation(async (sql: string) => {
      if (/COUNT\(\*\)/i.test(sql)) return { rows: [{ count: "0" }] };
      return { rows: [], rowCount: 0 };
    });
    stubActualRole = "owner";
    stubWorkspaceOwnerId = "owner_123";
    stubAllowedPages = null;
  });

  it("returns 200 with items matching the main category and its subcategories", async () => {
    const matchingRows = [
      { id: 3, workspace_owner_id: "owner_123", name: "Rose stem", code: "C34567", image_url: null, category_id: 5, created_at: "2024-01-03T00:00:00Z", main_category_name: "Flowers", sub_category_name: null },
      { id: 4, workspace_owner_id: "owner_123", name: "Carnation", code: "D45678", image_url: null, category_id: 6, created_at: "2024-01-04T00:00:00Z", main_category_name: "Flowers", sub_category_name: "Garden" },
    ];
    mockDbQuery
      .mockResolvedValueOnce({ rows: [{ count: "2" }] })      // COUNT call
      .mockResolvedValueOnce({ rows: matchingRows, rowCount: 2 }); // items call

    const res = await request(app).get("/base-items?main_category_id=5");

    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(2);
    expect(res.body.items.map((i: { name: string }) => i.name)).toEqual(["Rose stem", "Carnation"]);
  });

  it("passes main_category_id as a SQL param for both direct and subcategory matching", async () => {
    await request(app).get("/base-items?main_category_id=5");

    expect(mockDbQuery).toHaveBeenCalledTimes(2);
    const [sql, params] = mockDbQuery.mock.calls[0]; // COUNT query — same WHERE clause
    expect(params).toContain(5);
    expect(sql).toMatch(/SELECT id FROM base_item_categories WHERE parent_id/i);
  });

  it("returns an empty list when no items belong to the main category or its subcategories", async () => {
    const res = await request(app).get("/base-items?main_category_id=99");

    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(0);
  });

  it("does not include items from a different, unrelated main category", async () => {
    const unrelatedRows = [
      { id: 10, workspace_owner_id: "owner_123", name: "Pine Cone", code: "E56789", image_url: null, category_id: 20, created_at: "2024-01-05T00:00:00Z", main_category_name: "Seasonal", sub_category_name: null },
    ];
    mockDbQuery
      .mockResolvedValueOnce({ rows: [{ count: "0" }] })          // COUNT for filtered request
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })            // items for filtered request
      .mockResolvedValueOnce({ rows: [{ count: "1" }] })          // COUNT for all-items request
      .mockResolvedValueOnce({ rows: unrelatedRows, rowCount: 1 }); // items for all-items request

    const resFiltered = await request(app).get("/base-items?main_category_id=5");
    const resAll = await request(app).get("/base-items");

    expect(resFiltered.body.items).toHaveLength(0);
    expect(resAll.body.items).toHaveLength(1);
    expect(resAll.body.items[0].name).toBe("Pine Cone");
  });

  it("ignores main_category_id when category_id is also present (category_id takes precedence)", async () => {
    await request(app).get("/base-items?main_category_id=5&category_id=10");

    expect(mockDbQuery).toHaveBeenCalledTimes(2);
    const [sql, params] = mockDbQuery.mock.calls[0]; // COUNT query — same WHERE clause
    expect(params).toContain(10);
    expect(sql).not.toMatch(/SELECT id FROM base_item_categories WHERE parent_id/i);
  });

  it("ignores a non-numeric main_category_id and returns all items", async () => {
    const res = await request(app).get("/base-items?main_category_id=abc");

    expect(res.status).toBe(200);
    const [sql] = mockDbQuery.mock.calls[0]; // COUNT query
    expect(sql).not.toMatch(/SELECT id FROM base_item_categories WHERE parent_id/i);
  });
});

describe("GET /base-items — ?category_id filter (subcategory)", () => {
  const app = makeApp();

  beforeEach(() => {
    vi.clearAllMocks();
    mockDbQuery.mockReset();
    mockDbQuery.mockImplementation(async (sql: string) => {
      if (/COUNT\(\*\)/i.test(sql)) return { rows: [{ count: "0" }] };
      return { rows: [], rowCount: 0 };
    });
    stubActualRole = "owner";
    stubWorkspaceOwnerId = "owner_123";
    stubAllowedPages = null;
  });

  it("returns only items assigned to the specific subcategory", async () => {
    const subCatRows = [
      { id: 7, workspace_owner_id: "owner_123", name: "White Lily", code: "F67890", image_url: null, category_id: 10, created_at: "2024-01-06T00:00:00Z", main_category_name: "Flowers", sub_category_name: "Spring" },
    ];
    mockDbQuery
      .mockResolvedValueOnce({ rows: [{ count: "1" }] })       // COUNT call
      .mockResolvedValueOnce({ rows: subCatRows, rowCount: 1 }); // items call

    const res = await request(app).get("/base-items?category_id=10");

    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(1);
    expect(res.body.items[0].name).toBe("White Lily");
    expect(res.body.items[0].category_id).toBe(10);
  });

  it("passes category_id as a SQL param and filters to bi.category_id = X", async () => {
    await request(app).get("/base-items?category_id=10");

    expect(mockDbQuery).toHaveBeenCalledTimes(2);
    const [sql, params] = mockDbQuery.mock.calls[0]; // COUNT query — same WHERE clause
    expect(params).toContain(10);
    // status filter ("active") is always added as $2, so category_id becomes $3
    expect(sql).toMatch(/bi\.category_id\s*=\s*\$3/i);
  });

  it("returns an empty list when no items belong to the specified subcategory", async () => {
    const res = await request(app).get("/base-items?category_id=999");

    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(0);
  });

  it("ignores a non-numeric category_id and returns all items", async () => {
    const res = await request(app).get("/base-items?category_id=xyz");

    expect(res.status).toBe(200);
    const [sql] = mockDbQuery.mock.calls[0]; // COUNT query
    expect(sql).not.toMatch(/bi\.category_id\s*=\s*\$2/i);
  });
});

// ---------------------------------------------------------------------------
// POST /base-items — permission checks
// ---------------------------------------------------------------------------

describe("POST /base-items — permission checks", () => {
  const app = makeApp();

  beforeEach(() => {
    vi.clearAllMocks();
    mockDbQuery.mockReset();
    mockDbQuery.mockResolvedValue({ rows: [], rowCount: 0 });
    stubActualRole = "owner";
    stubWorkspaceOwnerId = "owner_123";
    stubAllowedPages = null;
  });

  it("returns 403 when caller is a member with no permissions", async () => {
    stubActualRole = "member";
    stubAllowedPages = [];

    const res = await request(app)
      .post("/base-items")
      .send({ name: "New Item" });

    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/creating base items/i);
  });

  it("returns 403 when caller has unrelated permissions but not base_items.create or base_items.manage", async () => {
    stubActualRole = "member";
    stubAllowedPages = ["brands.manage", "base_items.delete"];

    const res = await request(app)
      .post("/base-items")
      .send({ name: "New Item" });

    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/creating base items/i);
  });

  it("allows a member with base_items.manage to create a base item", async () => {
    stubActualRole = "member";
    stubAllowedPages = ["base_items.manage"];
    mockDbQuery
      .mockResolvedValueOnce({ rows: [], rowCount: 0 }) // unique code check
      .mockResolvedValueOnce({ rows: [{ id: 1, workspace_owner_id: "owner_123", name: "New Item", code: "A12345", image_url: null, category_id: null, created_at: "2024-01-01T00:00:00Z" }], rowCount: 1 });

    const res = await request(app)
      .post("/base-items")
      .send({ name: "New Item" });

    expect(res.status).toBe(201);
  });

  it("allows a member with base_items.create to create a base item", async () => {
    stubActualRole = "member";
    stubAllowedPages = ["base_items.create"];
    mockDbQuery
      .mockResolvedValueOnce({ rows: [], rowCount: 0 }) // unique code check
      .mockResolvedValueOnce({ rows: [{ id: 2, workspace_owner_id: "owner_123", name: "Another Item", code: "B23456", image_url: null, category_id: null, created_at: "2024-01-01T00:00:00Z" }], rowCount: 1 });

    const res = await request(app)
      .post("/base-items")
      .send({ name: "Another Item" });

    expect(res.status).toBe(201);
  });
});

// ---------------------------------------------------------------------------
// DELETE /base-items/:id — permission checks
// ---------------------------------------------------------------------------

describe("DELETE /base-items/:id — permission checks", () => {
  const app = makeApp();

  beforeEach(() => {
    vi.clearAllMocks();
    mockDbQuery.mockReset();
    mockDbQuery.mockResolvedValue({ rows: [], rowCount: 0 });
    stubActualRole = "owner";
    stubWorkspaceOwnerId = "owner_123";
    stubAllowedPages = null;
  });

  it("returns 403 when caller is a member with no permissions", async () => {
    stubActualRole = "member";
    stubAllowedPages = [];

    const res = await request(app).delete("/base-items/1");

    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/owner/i);
  });

  it("returns 403 when caller has base_items.create but is not the owner", async () => {
    stubActualRole = "member";
    stubAllowedPages = ["base_items.create"];

    const res = await request(app).delete("/base-items/1");

    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/owner/i);
  });

  it("allows owner to delete a base item", async () => {
    stubActualRole = "owner";
    // Transaction client: SELECT snapshot returns the row, other queries no-op.
    mockClientQuery.mockResolvedValue({
      rows: [{ name: "Red Roses", code: "RR-1", image_url: null, category_name: "Fresh" }],
      rowCount: 1,
    });

    const res = await request(app).delete("/base-items/1");

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    // An audit row must be written inside the same transaction as the delete.
    const sqls = mockClientQuery.mock.calls.map((c) => String(c[0]));
    expect(sqls.some((s) => /INSERT INTO base_item_audit_log/i.test(s))).toBe(true);
    expect(sqls.some((s) => /DELETE FROM base_items/i.test(s))).toBe(true);
    expect(sqls.some((s) => /COMMIT/i.test(s))).toBe(true);
  });

  it("returns 404 when owner deletes a non-existent base item", async () => {
    stubActualRole = "owner";
    mockClientQuery.mockResolvedValue({ rows: [], rowCount: 0 });

    const res = await request(app).delete("/base-items/999");

    expect(res.status).toBe(404);
  });

  it("returns 403 when a member with base_items.manage tries to delete (owner-only)", async () => {
    stubActualRole = "member";
    stubAllowedPages = ["base_items.manage"];

    const res = await request(app).delete("/base-items/1");

    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/owner/i);
  });

  it("returns 403 when a member with base_items.delete tries to delete (owner-only)", async () => {
    stubActualRole = "member";
    stubAllowedPages = ["base_items.delete"];

    const res = await request(app).delete("/base-items/1");

    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/owner/i);
  });
});

describe("GET /base-items/deletion-history — owner gating", () => {
  const app = makeApp();

  beforeEach(() => {
    vi.clearAllMocks();
    mockDbQuery.mockReset();
    mockDbQuery.mockResolvedValue({ rows: [], rowCount: 0 });
    stubActualRole = "owner";
    stubWorkspaceOwnerId = "owner_123";
    stubAllowedPages = null;
  });

  it("returns 403 for a non-owner member", async () => {
    stubActualRole = "member";
    stubAllowedPages = ["base_items.manage"];

    const res = await request(app).get("/base-items/deletion-history");

    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/owner/i);
    // The owner gate must short-circuit before any DB query runs.
    expect(mockDbQuery).not.toHaveBeenCalled();
  });
});

describe("GET /base-items — combined ?q and ?main_category_id filters", () => {
  const app = makeApp();

  beforeEach(() => {
    vi.clearAllMocks();
    mockDbQuery.mockReset();
    mockDbQuery.mockImplementation(async (sql: string) => {
      if (/COUNT\(\*\)/i.test(sql)) return { rows: [{ count: "0" }] };
      return { rows: [], rowCount: 0 };
    });
    stubActualRole = "owner";
    stubWorkspaceOwnerId = "owner_123";
    stubAllowedPages = null;
  });

  it("applies both text search and main_category_id filter simultaneously", async () => {
    const matchingRow = [
      { id: 8, workspace_owner_id: "owner_123", name: "Red Carnation", code: "G78901", image_url: null, category_id: 6, created_at: "2024-01-07T00:00:00Z", main_category_name: "Flowers", sub_category_name: "Garden" },
    ];
    mockDbQuery
      .mockResolvedValueOnce({ rows: [{ count: "1" }] })       // COUNT call
      .mockResolvedValueOnce({ rows: matchingRow, rowCount: 1 }); // items call

    const res = await request(app).get("/base-items?q=carnation&main_category_id=5");

    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(1);
    expect(res.body.items[0].name).toBe("Red Carnation");

    const [sql, params] = mockDbQuery.mock.calls[0]; // COUNT query — same WHERE clause
    expect(sql).toMatch(/ILIKE/i);
    expect(sql).toMatch(/parent_id/i);
    expect(params).toContain("%carnation%");
    expect(params).toContain(5);
  });
});

// ---------------------------------------------------------------------------
// GET /base-items — ?status= filter
// ---------------------------------------------------------------------------

describe("GET /base-items — ?status= filter", () => {
  const app = makeApp();

  beforeEach(() => {
    vi.clearAllMocks();
    mockDbQuery.mockReset();
    mockDbQuery.mockImplementation(async (sql: string) => {
      if (/COUNT\(\*\)/i.test(sql)) return { rows: [{ count: "0" }] };
      return { rows: [], rowCount: 0 };
    });
    stubActualRole = "owner";
    stubWorkspaceOwnerId = "owner_123";
    stubAllowedPages = null;
  });

  it("defaults to ?status=active and adds bi.status = $2 to the WHERE clause", async () => {
    await request(app).get("/base-items");

    const [sql, params] = mockDbQuery.mock.calls[0]; // COUNT query
    expect(sql).toMatch(/bi\.status\s*=\s*\$2/i);
    expect(params).toContain("active");
  });

  it("sends ?status=archived and adds bi.status = 'archived' to the WHERE clause", async () => {
    await request(app).get("/base-items?status=archived");

    const [sql, params] = mockDbQuery.mock.calls[0]; // COUNT query
    expect(sql).toMatch(/bi\.status\s*=\s*\$2/i);
    expect(params).toContain("archived");
  });

  it("sends ?status=merged and adds bi.status = 'merged' to the WHERE clause", async () => {
    await request(app).get("/base-items?status=merged");

    const [sql, params] = mockDbQuery.mock.calls[0]; // COUNT query
    expect(sql).toMatch(/bi\.status\s*=\s*\$2/i);
    expect(params).toContain("merged");
  });

  it("sends ?status=all and omits a status condition from the WHERE clause", async () => {
    await request(app).get("/base-items?status=all");

    const [sql] = mockDbQuery.mock.calls[0]; // COUNT query
    expect(sql).not.toMatch(/bi\.status\s*=/i);
  });

  it("falls back to active filter when an invalid status value is provided", async () => {
    await request(app).get("/base-items?status=unknown_value");

    const [sql, params] = mockDbQuery.mock.calls[0]; // COUNT query
    expect(sql).toMatch(/bi\.status\s*=\s*\$2/i);
    expect(params).toContain("active");
  });
});

// ---------------------------------------------------------------------------
// POST /base-items/bulk-archive
// ---------------------------------------------------------------------------

describe("POST /base-items/bulk-archive — permission checks", () => {
  const app = makeApp();

  beforeEach(() => {
    vi.clearAllMocks();
    mockDbQuery.mockReset();
    mockDbQuery.mockResolvedValue({ rows: [], rowCount: 0 });
    stubActualRole = "owner";
    stubWorkspaceOwnerId = "owner_123";
    stubAllowedPages = null;
  });

  it("returns 403 when caller is a member without manage permissions", async () => {
    stubActualRole = "member";
    stubAllowedPages = [];

    const res = await request(app)
      .post("/base-items/bulk-archive")
      .send({ ids: [1, 2] });

    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/managing base items/i);
  });

  it("returns 403 when caller has base_items.create but not base_items.manage", async () => {
    stubActualRole = "member";
    stubAllowedPages = ["base_items.create"];

    const res = await request(app)
      .post("/base-items/bulk-archive")
      .send({ ids: [1] });

    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/managing base items/i);
  });

  it("allows a member with base_items.manage to bulk-archive", async () => {
    stubActualRole = "member";
    stubAllowedPages = ["base_items.manage"];

    const res = await request(app)
      .post("/base-items/bulk-archive")
      .send({ ids: [1, 2] });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });
});

describe("POST /base-items/bulk-archive — validation", () => {
  const app = makeApp();

  beforeEach(() => {
    vi.clearAllMocks();
    mockDbQuery.mockReset();
    mockDbQuery.mockResolvedValue({ rows: [], rowCount: 0 });
    stubActualRole = "owner";
    stubWorkspaceOwnerId = "owner_123";
    stubAllowedPages = null;
  });

  it("returns 400 when ids is missing", async () => {
    const res = await request(app).post("/base-items/bulk-archive").send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/ids must be a non-empty array/i);
  });

  it("returns 400 when ids is an empty array", async () => {
    const res = await request(app).post("/base-items/bulk-archive").send({ ids: [] });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/ids must be a non-empty array/i);
  });

  it("returns 400 when all ids are non-numeric strings", async () => {
    const res = await request(app)
      .post("/base-items/bulk-archive")
      .send({ ids: ["abc", "xyz"] });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/no valid IDs/i);
  });
});

describe("POST /base-items/bulk-archive — success", () => {
  const app = makeApp();

  beforeEach(() => {
    vi.clearAllMocks();
    mockDbQuery.mockReset();
    mockDbQuery.mockResolvedValue({ rows: [], rowCount: 0 });
    stubActualRole = "owner";
    stubWorkspaceOwnerId = "owner_123";
    stubAllowedPages = null;
  });

  it("returns ok and archived count and makes exactly 2 DB calls", async () => {
    mockDbQuery
      .mockResolvedValueOnce({ rows: [], rowCount: 2 }) // UPDATE base_items
      .mockResolvedValueOnce({ rows: [], rowCount: 0 }); // INSERT audit log

    const res = await request(app)
      .post("/base-items/bulk-archive")
      .send({ ids: [1, 2] });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.archived).toBe(2);
    expect(mockDbQuery).toHaveBeenCalledTimes(2);
  });

  it("passes workspaceOwnerId and status=active to the UPDATE query", async () => {
    const res = await request(app)
      .post("/base-items/bulk-archive")
      .send({ ids: [3] });

    expect(res.status).toBe(200);
    const [sql, params] = mockDbQuery.mock.calls[0]; // UPDATE call
    expect(sql).toMatch(/status\s*=\s*'archived'/i);
    expect(sql).toMatch(/status\s*=\s*'active'/i);
    expect(params[0]).toBe("owner_123");
  });

  it("returns 200 even when the audit log INSERT fails", async () => {
    mockDbQuery
      .mockResolvedValueOnce({ rows: [], rowCount: 2 })     // UPDATE base_items
      .mockRejectedValueOnce(new Error("audit log table missing")); // INSERT audit log fails

    const res = await request(app)
      .post("/base-items/bulk-archive")
      .send({ ids: [1, 2] });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.archived).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// POST /base-items/bulk-update-category
// ---------------------------------------------------------------------------

describe("POST /base-items/bulk-update-category — permission checks", () => {
  const app = makeApp();

  beforeEach(() => {
    vi.clearAllMocks();
    mockDbQuery.mockReset();
    mockDbQuery.mockResolvedValue({ rows: [], rowCount: 0 });
    mockClientQuery.mockReset();
    mockClientQuery.mockResolvedValue({ rows: [], rowCount: 0 });
    stubActualRole = "owner";
    stubWorkspaceOwnerId = "owner_123";
    stubAllowedPages = null;
  });

  it("returns 403 when caller is a member without manage permissions", async () => {
    stubActualRole = "member";
    stubAllowedPages = [];

    const res = await request(app)
      .post("/base-items/bulk-update-category")
      .send({ ids: [1], category_id: null });

    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/managing base items/i);
  });
});

describe("POST /base-items/bulk-update-category — validation", () => {
  const app = makeApp();

  beforeEach(() => {
    vi.clearAllMocks();
    mockDbQuery.mockReset();
    mockDbQuery.mockResolvedValue({ rows: [], rowCount: 0 });
    mockClientQuery.mockReset();
    mockClientQuery.mockResolvedValue({ rows: [], rowCount: 0 });
    stubActualRole = "owner";
    stubWorkspaceOwnerId = "owner_123";
    stubAllowedPages = null;
  });

  it("returns 400 when ids is empty", async () => {
    const res = await request(app)
      .post("/base-items/bulk-update-category")
      .send({ ids: [], category_id: null });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/ids must be a non-empty array/i);
  });

  it("returns 400 when any id is malformed instead of silently dropping it", async () => {
    const res = await request(app)
      .post("/base-items/bulk-update-category")
      .send({ ids: [1, "2"], category_id: null });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/every id must be a positive integer/i);
    expect(mockClientQuery).not.toHaveBeenCalled();
  });

  it("returns 400 when ids contain a duplicate", async () => {
    const res = await request(app)
      .post("/base-items/bulk-update-category")
      .send({ ids: [1, 1], category_id: null });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/duplicate ids/i);
    expect(mockClientQuery).not.toHaveBeenCalled();
  });

  it("returns 400 when category_id is invalid (negative)", async () => {
    const res = await request(app)
      .post("/base-items/bulk-update-category")
      .send({ ids: [1], category_id: -5 });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/invalid category_id/i);
  });

  it("returns 404 when category_id does not exist in the workspace", async () => {
    mockClientQuery
      .mockResolvedValueOnce({ rows: [], rowCount: 0 }) // BEGIN
      .mockResolvedValueOnce({ rows: [], rowCount: 0 }) // category check
      .mockResolvedValueOnce({ rows: [], rowCount: 0 }); // ROLLBACK

    const res = await request(app)
      .post("/base-items/bulk-update-category")
      .send({ ids: [1], category_id: 999 });

    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/category not found/i);
    expect(mockDbQuery).not.toHaveBeenCalled();
  });

  it("returns 400 when category_id is inactive", async () => {
    mockClientQuery
      .mockResolvedValueOnce({ rows: [], rowCount: 0 }) // BEGIN
      .mockResolvedValueOnce({
        rows: [{ id: 5, parent_id: null, status: "archived" }],
        rowCount: 1,
      })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 }); // ROLLBACK

    const res = await request(app)
      .post("/base-items/bulk-update-category")
      .send({ ids: [1], category_id: 5 });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/inactive/i);
    expect(mockDbQuery).not.toHaveBeenCalled();
  });

  it("returns 400 when a parent category has active subcategories", async () => {
    mockClientQuery
      .mockResolvedValueOnce({ rows: [], rowCount: 0 }) // BEGIN
      .mockResolvedValueOnce({
        rows: [{ id: 5, parent_id: null, status: "active" }],
        rowCount: 1,
      })
      .mockResolvedValueOnce({ rows: [{ id: 6 }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 }); // ROLLBACK

    const res = await request(app)
      .post("/base-items/bulk-update-category")
      .send({ ids: [1], category_id: 5 });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/select an active subcategory/i);
    expect(mockDbQuery).not.toHaveBeenCalled();
  });

  it("returns 404 and does not update when any selected item is missing or cross-workspace", async () => {
    mockClientQuery
      .mockResolvedValueOnce({ rows: [], rowCount: 0 }) // BEGIN
      .mockResolvedValueOnce({ rows: [{ id: 1, category_id: null }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 }); // ROLLBACK

    const res = await request(app)
      .post("/base-items/bulk-update-category")
      .send({ ids: [1, 999], category_id: null });

    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/not found in this workspace or are not eligible/i);
    expect(mockClientQuery).toHaveBeenCalledTimes(3);
    expect(mockClientQuery.mock.calls.some(([sql]) => /UPDATE base_items/i.test(String(sql)))).toBe(false);
    expect(mockDbQuery).not.toHaveBeenCalled();
  });
});

describe("POST /base-items/bulk-update-category — success", () => {
  const app = makeApp();

  beforeEach(() => {
    vi.clearAllMocks();
    mockDbQuery.mockReset();
    mockDbQuery.mockResolvedValue({ rows: [], rowCount: 1 });
    mockClientQuery.mockReset();
    mockClientQuery.mockResolvedValue({ rows: [], rowCount: 0 });
    stubActualRole = "owner";
    stubWorkspaceOwnerId = "owner_123";
    stubAllowedPages = null;
  });

  it("clears category for one item atomically and returns the actual update count", async () => {
    mockClientQuery
      .mockResolvedValueOnce({ rows: [], rowCount: 0 }) // BEGIN
      .mockResolvedValueOnce({ rows: [{ id: 1, category_id: 5 }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [{ id: 1 }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 }); // COMMIT

    const res = await request(app)
      .post("/base-items/bulk-update-category")
      .send({ ids: [1], category_id: null });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.updated).toBe(1);
    expect(mockClientQuery).toHaveBeenCalledTimes(4);
    expect(mockDbQuery).toHaveBeenCalledTimes(1);
  });

  it("updates multiple items to a valid leaf main category by database ID", async () => {
    mockClientQuery
      .mockResolvedValueOnce({ rows: [], rowCount: 0 }) // BEGIN
      .mockResolvedValueOnce({
        rows: [{ id: 5, parent_id: null, status: "active" }],
        rowCount: 1,
      })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 }) // no active children
      .mockResolvedValueOnce({
        rows: [{ id: 1, category_id: null }, { id: 2, category_id: 8 }],
        rowCount: 2,
      })
      .mockResolvedValueOnce({ rows: [{ id: 1 }, { id: 2 }], rowCount: 2 })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 }); // COMMIT

    const res = await request(app)
      .post("/base-items/bulk-update-category")
      .send({ ids: [1, 2], category_id: 5 });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.updated).toBe(2);
    const updateCall = mockClientQuery.mock.calls.find(([sql]) => /UPDATE base_items/i.test(String(sql)));
    expect(updateCall?.[1]).toEqual(["owner_123", 5, [1, 2]]);
    expect(mockClientQuery).toHaveBeenCalledTimes(6);
    expect(mockDbQuery).toHaveBeenCalledTimes(1);
  });

  it("updates to a valid active subcategory whose parent is active", async () => {
    mockClientQuery
      .mockResolvedValueOnce({ rows: [], rowCount: 0 }) // BEGIN
      .mockResolvedValueOnce({
        rows: [{ id: 6, parent_id: 5, status: "active" }],
        rowCount: 1,
      })
      .mockResolvedValueOnce({
        rows: [{ id: 5, parent_id: null, status: "active" }],
        rowCount: 1,
      })
      .mockResolvedValueOnce({ rows: [{ id: 1, category_id: null }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [{ id: 1 }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 }); // COMMIT

    const res = await request(app)
      .post("/base-items/bulk-update-category")
      .send({ ids: [1], category_id: 6 });

    expect(res.status).toBe(200);
    expect(res.body.updated).toBe(1);
    expect(mockClientQuery).toHaveBeenCalledTimes(6);
  });

  it("returns 200 even when the audit log INSERT fails", async () => {
    mockClientQuery
      .mockResolvedValueOnce({ rows: [], rowCount: 0 }) // BEGIN
      .mockResolvedValueOnce({ rows: [{ id: 1, category_id: 5 }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [{ id: 1 }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 }); // COMMIT
    mockDbQuery.mockRejectedValueOnce(new Error("audit log table missing"));

    const res = await request(app)
      .post("/base-items/bulk-update-category")
      .send({ ids: [1], category_id: null });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.updated).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// POST /base-items/bulk-update-type
// ---------------------------------------------------------------------------

describe("POST /base-items/bulk-update-type — permission checks", () => {
  const app = makeApp();

  beforeEach(() => {
    vi.clearAllMocks();
    mockDbQuery.mockReset();
    mockDbQuery.mockResolvedValue({ rows: [], rowCount: 0 });
    stubActualRole = "owner";
    stubWorkspaceOwnerId = "owner_123";
    stubAllowedPages = null;
  });

  it("returns 403 when caller is a member without manage permissions", async () => {
    stubActualRole = "member";
    stubAllowedPages = ["base_items.create"];

    const res = await request(app)
      .post("/base-items/bulk-update-type")
      .send({ ids: [1], type: "flower" });

    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/managing base items/i);
  });
});

describe("POST /base-items/bulk-update-type — validation and success", () => {
  const app = makeApp();

  beforeEach(() => {
    vi.clearAllMocks();
    mockDbQuery.mockReset();
    mockDbQuery.mockResolvedValue({ rows: [], rowCount: 0 });
    stubActualRole = "owner";
    stubWorkspaceOwnerId = "owner_123";
    stubAllowedPages = null;
  });

  it("returns 400 when ids is empty", async () => {
    const res = await request(app)
      .post("/base-items/bulk-update-type")
      .send({ ids: [], type: "flower" });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/ids must be a non-empty array/i);
  });

  it("returns 200 and makes exactly 3 DB calls on success", async () => {
    mockDbQuery
      .mockResolvedValueOnce({ rows: [{ id: 1, type: null }], rowCount: 1 }) // SELECT prev values
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })                       // UPDATE
      .mockResolvedValueOnce({ rows: [], rowCount: 0 });                      // INSERT audit log

    const res = await request(app)
      .post("/base-items/bulk-update-type")
      .send({ ids: [1], type: "flower" });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.updated).toBe(1);
    expect(mockDbQuery).toHaveBeenCalledTimes(3);
  });

  it("passes the trimmed type value to the UPDATE query", async () => {
    await request(app)
      .post("/base-items/bulk-update-type")
      .send({ ids: [1], type: "  Flower  " });

    const [, params] = mockDbQuery.mock.calls[1]; // UPDATE call (index 1 after SELECT)
    expect(params).toContain("Flower");
  });

  it("sets type to null when type is an empty string", async () => {
    const res = await request(app)
      .post("/base-items/bulk-update-type")
      .send({ ids: [1], type: "" });

    expect(res.status).toBe(200);
    const [, params] = mockDbQuery.mock.calls[1]; // UPDATE call (index 1 after SELECT)
    expect(params[1]).toBeNull();
  });

  it("returns 200 even when the audit log INSERT fails", async () => {
    mockDbQuery
      .mockResolvedValueOnce({ rows: [{ id: 1, type: null }], rowCount: 1 }) // SELECT prev values
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })                       // UPDATE
      .mockRejectedValueOnce(new Error("audit log table missing"));           // INSERT audit log fails

    const res = await request(app)
      .post("/base-items/bulk-update-type")
      .send({ ids: [1], type: "flower" });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.updated).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// POST /base-items/merge
// ---------------------------------------------------------------------------

describe("POST /base-items/merge — permission checks", () => {
  const app = makeApp();

  beforeEach(() => {
    vi.clearAllMocks();
    mockDbQuery.mockReset();
    mockDbQuery.mockResolvedValue({ rows: [], rowCount: 0 });
    stubActualRole = "owner";
    stubWorkspaceOwnerId = "owner_123";
    stubAllowedPages = null;
  });

  it("returns 403 when caller is a member without manage permissions", async () => {
    stubActualRole = "member";
    stubAllowedPages = [];

    const res = await request(app)
      .post("/base-items/merge")
      .send({ ids: [1, 2], master_id: 1 });

    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/managing base items/i);
  });
});

describe("POST /base-items/merge — validation", () => {
  const app = makeApp();

  beforeEach(() => {
    vi.clearAllMocks();
    mockDbQuery.mockReset();
    mockDbQuery.mockResolvedValue({ rows: [], rowCount: 0 });
    stubActualRole = "owner";
    stubWorkspaceOwnerId = "owner_123";
    stubAllowedPages = null;
  });

  it("returns 400 when ids has fewer than 2 items", async () => {
    const res = await request(app)
      .post("/base-items/merge")
      .send({ ids: [1], master_id: 1 });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/at least 2 items/i);
  });

  it("returns 400 when master_id is missing", async () => {
    const res = await request(app)
      .post("/base-items/merge")
      .send({ ids: [1, 2] });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/master_id is required/i);
  });

  it("returns 400 when master_id is not one of the selected ids", async () => {
    const res = await request(app)
      .post("/base-items/merge")
      .send({ ids: [1, 2], master_id: 99 });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/master_id must be one of the selected ids/i);
  });

  it("returns 400 when one or more items are not active in the workspace", async () => {
    mockDbQuery.mockResolvedValueOnce({ rows: [{ id: 1 }], rowCount: 1 }); // only 1 of 2 found

    const res = await request(app)
      .post("/base-items/merge")
      .send({ ids: [1, 2], master_id: 1 });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/not found or not active/i);
  });
});

describe("POST /base-items/merge — success", () => {
  const app = makeApp();

  beforeEach(() => {
    vi.clearAllMocks();
    mockDbQuery.mockReset();
    mockDbQuery.mockResolvedValue({ rows: [], rowCount: 0 });
    mockClientQuery.mockReset();
    mockClientQuery.mockResolvedValue({ rows: [], rowCount: 0 });
    stubActualRole = "owner";
    stubWorkspaceOwnerId = "owner_123";
    stubAllowedPages = null;
  });

  it("returns ok with master_id and merged ids, locking and versioning affected products", async () => {
    mockDbQuery
      .mockResolvedValueOnce({ rows: [{ id: 1 }, { id: 2 }], rowCount: 2 }) // SELECT active check
      .mockResolvedValueOnce({ rows: [], rowCount: 0 });                     // INSERT audit log

    // client calls: BEGIN, SET LOCAL lock_timeout, Base Item FOR UPDATE,
    // Product FOR UPDATE, DELETE product_recipes, UPDATE product_recipes,
    // UPDATE product recipe versions,
    // DELETE location_statuses, UPDATE location_statuses,
    // UPDATE base_item_suppliers, UPDATE base_items, COMMIT
    mockClientQuery
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })                    // BEGIN
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })                    // SET LOCAL
      .mockResolvedValueOnce({ rows: [{ id: 1 }, { id: 2 }], rowCount: 2 }) // FOR UPDATE
      .mockResolvedValue({ rows: [], rowCount: 0 });                        // remaining stmts + COMMIT

    const res = await request(app)
      .post("/base-items/merge")
      .send({ ids: [1, 2], master_id: 1 });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.master_id).toBe(1);
    expect(res.body.merged).toEqual([2]);
    expect(mockDbQuery).toHaveBeenCalledTimes(2);   // SELECT check + audit log
    expect(mockClientQuery).toHaveBeenCalledTimes(11); // BEGIN + locks + 6 mutations + COMMIT
  });

  it("wraps operations in a transaction (BEGIN then COMMIT)", async () => {
    mockDbQuery.mockResolvedValueOnce({ rows: [{ id: 3 }, { id: 4 }], rowCount: 2 });

    mockClientQuery
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })                    // BEGIN
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })                    // SET LOCAL
      .mockResolvedValueOnce({ rows: [{ id: 3 }, { id: 4 }], rowCount: 2 }) // FOR UPDATE
      .mockResolvedValue({ rows: [], rowCount: 0 });                        // remaining stmts + COMMIT

    await request(app).post("/base-items/merge").send({ ids: [3, 4], master_id: 3 });

    const calls = mockClientQuery.mock.calls;
    expect(calls[0][0]).toBe("BEGIN");
    expect(calls[1][0]).toMatch(/SET LOCAL lock_timeout/i);
    expect(calls[2][0]).toMatch(/FOR UPDATE/i);
    expect(calls[10][0]).toBe("COMMIT");
  });

  it("issues a ROLLBACK on transaction failure", async () => {
    mockDbQuery.mockResolvedValueOnce({ rows: [{ id: 1 }, { id: 2 }], rowCount: 2 }); // SELECT check
    mockClientQuery
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })   // BEGIN
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })   // SET LOCAL lock_timeout
      .mockResolvedValueOnce({ rows: [{ id: 1 }, { id: 2 }], rowCount: 2 }) // FOR UPDATE
      .mockRejectedValueOnce(new Error("DB error"));       // DELETE conflicting product_recipes fails

    const res = await request(app)
      .post("/base-items/merge")
      .send({ ids: [1, 2], master_id: 1 });

    expect(res.status).toBe(500);
    const sqlCalls = mockClientQuery.mock.calls.map((c: unknown[]) => String(c[0]));
    expect(sqlCalls).toContain("ROLLBACK");
    expect(mockClientRelease).toHaveBeenCalled();
  });

  it("releases the client on success", async () => {
    mockDbQuery
      .mockResolvedValueOnce({ rows: [{ id: 1 }, { id: 2 }], rowCount: 2 })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 });
    mockClientQuery
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })                    // BEGIN
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })                    // SET LOCAL
      .mockResolvedValueOnce({ rows: [{ id: 1 }, { id: 2 }], rowCount: 2 }) // FOR UPDATE
      .mockResolvedValue({ rows: [], rowCount: 0 });                        // remaining stmts + COMMIT

    await request(app)
      .post("/base-items/merge")
      .send({ ids: [1, 2], master_id: 1 });

    expect(mockClientRelease).toHaveBeenCalled();
  });

  it("deletes conflicting product_recipes before updating when product uses both master and duplicate", async () => {
    mockDbQuery
      .mockResolvedValueOnce({ rows: [{ id: 10 }, { id: 20 }], rowCount: 2 }) // SELECT active check
      .mockResolvedValueOnce({ rows: [], rowCount: 0 });                       // INSERT audit log

    mockClientQuery
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })                    // BEGIN
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })                    // SET LOCAL lock_timeout
      .mockResolvedValueOnce({ rows: [{ id: 10 }, { id: 20 }], rowCount: 2 }) // FOR UPDATE
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })                    // DELETE conflicting product_recipes (1 removed)
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })                    // UPDATE product_recipes
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })                    // DELETE conflicting base_item_location_statuses
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })                    // UPDATE base_item_location_statuses
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })                    // UPDATE base_item_suppliers
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })                    // UPDATE base_items SET merged
      .mockResolvedValueOnce({ rows: [], rowCount: 0 });                   // COMMIT

    const res = await request(app)
      .post("/base-items/merge")
      .send({ ids: [10, 20], master_id: 10 });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.master_id).toBe(10);
    expect(res.body.merged).toEqual([20]);
    expect(mockDbQuery).toHaveBeenCalledTimes(2);    // SELECT check + audit log
    expect(mockClientQuery).toHaveBeenCalledTimes(11); // BEGIN + SET LOCAL + both locks + 6 stmts + COMMIT

    const productLockSql = String(mockClientQuery.mock.calls[3][0]);
    expect(productLockSql).toMatch(/FROM products/i);
    expect(productLockSql).toMatch(/FOR UPDATE/i);

    const deleteSql = String(mockClientQuery.mock.calls[4][0]); // after both locks
    expect(deleteSql).toMatch(/DELETE FROM product_recipes/i);
    expect(deleteSql).toMatch(/base_item_id = \$1/i);

    const updateSql = String(mockClientQuery.mock.calls[5][0]); // after DELETE
    expect(updateSql).toMatch(/UPDATE product_recipes/i);
    expect(updateSql).toMatch(/SET base_item_id = \$1/i);
  });

  it("returns 200 even when the audit log INSERT throws (e.g. table missing)", async () => {
    // mockDbQuery handles only the two pool-level calls: SELECT active check and audit log INSERT.
    // The transaction operations (BEGIN, SET LOCAL, FOR UPDATE, DELETEs, UPDATEs, COMMIT) use the pool client.
    mockDbQuery
      .mockResolvedValueOnce({ rows: [{ id: 1 }, { id: 2 }], rowCount: 2 }) // SELECT active check
      .mockRejectedValueOnce(                                                 // audit log INSERT fails
        new Error('relation "base_item_audit_log" does not exist'),
      );

    mockClientQuery
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })                    // BEGIN
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })                    // SET LOCAL
      .mockResolvedValueOnce({ rows: [{ id: 1 }, { id: 2 }], rowCount: 2 }) // FOR UPDATE
      .mockResolvedValue({ rows: [], rowCount: 0 });                        // remaining stmts + COMMIT

    const res = await request(app)
      .post("/base-items/merge")
      .send({ ids: [1, 2], master_id: 1 });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.master_id).toBe(1);
    expect(res.body.merged).toEqual([2]);
  });
});

// ---------------------------------------------------------------------------
// POST /base-items/:id/duplicate
// ---------------------------------------------------------------------------

describe("POST /base-items/:id/duplicate — permission checks", () => {
  const app = makeApp();

  beforeEach(() => {
    vi.clearAllMocks();
    mockDbQuery.mockReset();
    mockDbQuery.mockResolvedValue({ rows: [], rowCount: 0 });
    stubActualRole = "owner";
    stubWorkspaceOwnerId = "owner_123";
    stubAllowedPages = null;
  });

  it("returns 403 when caller is a member without create or manage permissions", async () => {
    stubActualRole = "member";
    stubAllowedPages = [];

    const res = await request(app).post("/base-items/5/duplicate");

    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/creating base items/i);
  });

  it("allows a member with base_items.create to duplicate", async () => {
    stubActualRole = "member";
    stubAllowedPages = ["base_items.create"];

    const srcRow = {
      id: 5, workspace_owner_id: "owner_123", name: "Rose Stem", code: "ABCDEF",
      image_url: null, category_id: null, alternate_name: null, accounting_category: null,
      tax_rate: null, created_at: "2024-01-01T00:00:00Z", stock: 0, low_stock_threshold: 0,
    };

    mockDbQuery
      .mockResolvedValueOnce({ rows: [srcRow], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({ rows: [{ id: 6, name: "Copy of Rose Stem", code: "ZZZZZZ" }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const res = await request(app).post("/base-items/5/duplicate");

    expect(res.status).toBe(201);
  });
});

describe("POST /base-items/:id/duplicate — validation and success", () => {
  const app = makeApp();

  beforeEach(() => {
    vi.clearAllMocks();
    mockDbQuery.mockReset();
    mockDbQuery.mockResolvedValue({ rows: [], rowCount: 0 });
    stubActualRole = "owner";
    stubWorkspaceOwnerId = "owner_123";
    stubAllowedPages = null;
  });

  it("returns 400 for a non-numeric id", async () => {
    const res = await request(app).post("/base-items/notanumber/duplicate");
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/invalid base item id/i);
  });

  it("returns 404 when source item does not exist in the workspace", async () => {
    mockDbQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 }); // item not found

    const res = await request(app).post("/base-items/999/duplicate");

    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/base item not found/i);
  });

  it("returns 201 with new item details and makes exactly 4 DB calls", async () => {
    const srcRow = {
      id: 5, workspace_owner_id: "owner_123", name: "Rose Stem", code: "ABCDEF",
      image_url: "/objects/owner_123/base-items/img1", category_id: 3,
      alternate_name: "Rosa", accounting_category: null,
      tax_rate: null, created_at: "2024-01-01T00:00:00Z", stock: 10, low_stock_threshold: 2,
    };

    mockDbQuery
      .mockResolvedValueOnce({ rows: [srcRow], rowCount: 1 })                                     // SELECT source
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })                                            // code uniqueness check
      .mockResolvedValueOnce({ rows: [{ id: 6, name: "Copy of Rose Stem", code: "ZNEWCD" }], rowCount: 1 }) // INSERT
      .mockResolvedValueOnce({ rows: [], rowCount: 0 });                                           // INSERT audit log

    const res = await request(app).post("/base-items/5/duplicate");

    expect(res.status).toBe(201);
    expect(res.body.item.name).toBe("Copy of Rose Stem");
    expect(res.body.item.id).toBe(6);
    expect(mockDbQuery).toHaveBeenCalledTimes(4);
  });

  it("prefixes the new name with 'Copy of '", async () => {
    const srcRow = {
      id: 7, workspace_owner_id: "owner_123", name: "Blue Tulip", code: "TULIPX",
      image_url: null, category_id: null, alternate_name: null, accounting_category: null,
      tax_rate: null, created_at: "2024-01-01T00:00:00Z", stock: 5, low_stock_threshold: 1,
    };

    mockDbQuery
      .mockResolvedValueOnce({ rows: [srcRow], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({ rows: [{ id: 8, name: "Copy of Blue Tulip", code: "NEWYYY" }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 });

    await request(app).post("/base-items/7/duplicate");

    const insertCall = mockDbQuery.mock.calls[2]; // INSERT call (index 2)
    expect(insertCall[1]).toContain("Copy of Blue Tulip");
  });

  it("returns 201 even when the audit log INSERT fails after the duplicate is created", async () => {
    const srcRow = {
      id: 5, workspace_owner_id: "owner_123", name: "Rose Stem", code: "ABCDEF",
      image_url: null, category_id: null, alternate_name: null, accounting_category: null,
      tax_rate: null, created_at: "2024-01-01T00:00:00Z", stock: 10, low_stock_threshold: 2,
    };

    mockDbQuery
      .mockResolvedValueOnce({ rows: [srcRow], rowCount: 1 })                                              // SELECT source
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })                                                     // code uniqueness check
      .mockResolvedValueOnce({ rows: [{ id: 9, name: "Copy of Rose Stem", code: "NEWXYZ" }], rowCount: 1 }) // INSERT new item
      .mockRejectedValueOnce(new Error("audit log table missing"));                                         // INSERT audit log fails

    const res = await request(app).post("/base-items/5/duplicate");

    expect(res.status).toBe(201);
    expect(res.body.item.id).toBe(9);
    expect(res.body.item.name).toBe("Copy of Rose Stem");
  });
});

// ---------------------------------------------------------------------------
// GET /base-items/:id/usage
// ---------------------------------------------------------------------------

describe("GET /base-items/:id/usage — validation and success", () => {
  const app = makeApp();

  beforeEach(() => {
    vi.clearAllMocks();
    mockDbQuery.mockReset();
    mockDbQuery.mockResolvedValue({ rows: [], rowCount: 0 });
    stubActualRole = "owner";
    stubWorkspaceOwnerId = "owner_123";
    stubAllowedPages = null;
  });

  it("returns 400 for a non-numeric id", async () => {
    const res = await request(app).get("/base-items/abc/usage");
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/invalid base item id/i);
  });

  it("returns 404 when the base item does not exist in the workspace", async () => {
    mockDbQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 }); // item not found

    const res = await request(app).get("/base-items/999/usage");

    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/base item not found/i);
  });

  it("returns 200 with an empty products array when item has no recipe links", async () => {
    mockDbQuery
      .mockResolvedValueOnce({ rows: [{ id: 5 }], rowCount: 1 }) // item exists
      .mockResolvedValueOnce({ rows: [], rowCount: 0 });           // no recipes

    const res = await request(app).get("/base-items/5/usage");

    expect(res.status).toBe(200);
    expect(res.body.products).toEqual([]);
    expect(mockDbQuery).toHaveBeenCalledTimes(2);
  });

  it("returns 200 with product usage details and makes exactly 2 DB calls", async () => {
    const usageRows = [
      { product_id: 10, product_name: "Red Rose Bouquet", quantity: 5, brand: "Florist Co", status: "available" },
      { product_id: 11, product_name: "Mixed Flowers", quantity: 3, brand: null, status: "out_of_stock" },
    ];

    mockDbQuery
      .mockResolvedValueOnce({ rows: [{ id: 5 }], rowCount: 1 }) // item exists
      .mockResolvedValueOnce({ rows: usageRows, rowCount: 2 });    // product recipes

    const res = await request(app).get("/base-items/5/usage");

    expect(res.status).toBe(200);
    expect(res.body.products).toHaveLength(2);
    expect(res.body.products[0].product_name).toBe("Red Rose Bouquet");
    expect(res.body.products[0].quantity).toBe(5);
    expect(res.body.products[1].brand).toBeNull();
    expect(mockDbQuery).toHaveBeenCalledTimes(2);
  });

  it("passes the correct workspaceOwnerId to both queries", async () => {
    stubWorkspaceOwnerId = "owner_xyz";
    mockDbQuery
      .mockResolvedValueOnce({ rows: [{ id: 5 }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 });

    await request(app).get("/base-items/5/usage");

    const [, checkParams] = mockDbQuery.mock.calls[0];
    const [, usageParams] = mockDbQuery.mock.calls[1];
    expect(checkParams).toContain("owner_xyz");
    expect(usageParams).toContain("owner_xyz");
  });
});

// ---------------------------------------------------------------------------
// POST /base-items/:id/adjustments — location-scoped inventory adjustments
// ---------------------------------------------------------------------------

describe("POST /base-items/:id/adjustments — validation", () => {
  const app = makeApp();

  beforeEach(() => {
    vi.clearAllMocks();
    mockDbQuery.mockReset();
    mockDbQuery.mockResolvedValue({ rows: [], rowCount: 0 });
    mockClientQuery.mockReset();
    mockClientQuery.mockResolvedValue({ rows: [], rowCount: 0 });
    stubActualRole = "owner";
    stubWorkspaceOwnerId = "owner_123";
    stubAllowedPages = null;
  });

  it("returns 403 when caller is a member without manage permission", async () => {
    stubActualRole = "member";
    stubAllowedPages = [];

    const res = await request(app)
      .post("/base-items/5/adjustments")
      .send({ location_id: 1, quantity_change: 10, reason: "receive" });

    expect(res.status).toBe(403);
  });

  it("returns 400 for a non-numeric base item id", async () => {
    const res = await request(app)
      .post("/base-items/abc/adjustments")
      .send({ location_id: 1, quantity_change: 10, reason: "receive" });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/invalid base item id/i);
  });

  it("returns 404 when base item does not exist in the workspace", async () => {
    mockDbQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 }); // item not found

    const res = await request(app)
      .post("/base-items/999/adjustments")
      .send({ location_id: 1, quantity_change: 10, reason: "receive" });

    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/base item not found/i);
  });

  it("returns 400 when location_id is missing", async () => {
    mockDbQuery.mockResolvedValueOnce({ rows: [{ id: 5, stock: "0" }], rowCount: 1 }); // item exists

    const res = await request(app)
      .post("/base-items/5/adjustments")
      .send({ quantity_change: 10, reason: "receive" });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/location_id is required/i);
  });

  it("returns 400 when location_id is not a number", async () => {
    mockDbQuery.mockResolvedValueOnce({ rows: [{ id: 5, stock: "0" }], rowCount: 1 }); // item exists

    const res = await request(app)
      .post("/base-items/5/adjustments")
      .send({ location_id: "abc", quantity_change: 10, reason: "receive" });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/location_id is required/i);
  });

  it("returns 400 when quantity_change is zero", async () => {
    mockDbQuery.mockResolvedValueOnce({ rows: [{ id: 5, stock: "10" }], rowCount: 1 }); // item exists

    const res = await request(app)
      .post("/base-items/5/adjustments")
      .send({ location_id: 1, quantity_change: 0, reason: "receive" });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/non-zero/i);
  });

  it("returns 400 when reason is invalid", async () => {
    mockDbQuery.mockResolvedValueOnce({ rows: [{ id: 5, stock: "10" }], rowCount: 1 }); // item exists

    const res = await request(app)
      .post("/base-items/5/adjustments")
      .send({ location_id: 1, quantity_change: 5, reason: "broken" });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/reason must be one of/i);
  });

  it("returns 400 when location_id refers to an inactive or foreign location", async () => {
    mockDbQuery
      .mockResolvedValueOnce({ rows: [{ id: 5, stock: "10" }], rowCount: 1 }) // item exists
      .mockResolvedValueOnce({ rows: [], rowCount: 0 }); // location check fails (inactive / wrong workspace)

    const res = await request(app)
      .post("/base-items/5/adjustments")
      .send({ location_id: 99, quantity_change: 5, reason: "receive", adjustment_action_id: ADJUSTMENT_ACTION_ID });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/active location/i);
  });

  it("location validation query includes workspace_owner_id to prevent cross-tenant access", async () => {
    stubWorkspaceOwnerId = "owner_xyz";
    mockDbQuery
      .mockResolvedValueOnce({ rows: [{ id: 5, stock: "0" }], rowCount: 1 }) // item exists
      .mockResolvedValueOnce({ rows: [], rowCount: 0 });                       // location check fails

    await request(app)
      .post("/base-items/5/adjustments")
      .send({ location_id: 1, quantity_change: 10, reason: "receive", adjustment_action_id: ADJUSTMENT_ACTION_ID });

    const locationCheckCall = mockDbQuery.mock.calls[1];
    expect(locationCheckCall[1]).toContain("owner_xyz"); // workspace_owner_id is a param
  });
});

describe("POST /base-items/:id/adjustments — success", () => {
  const app = makeApp();

  const locationRow = { location_id: 1, stock: "20", location_name: "Main Warehouse" };
  const insertedRow = {
    id: 100,
    workspace_owner_id: "owner_123",
    base_item_id: 5,
    quantity_change: "10",
    reason: "receive",
    note: null,
    stock_after: "30",
    created_by_user_id: null,
    created_at: "2026-01-01T00:00:00Z",
    location_id: 1,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockDbQuery.mockReset();
    mockDbQuery.mockResolvedValue({ rows: [], rowCount: 0 });
    mockClientQuery.mockReset();
    mockClientQuery.mockResolvedValue({ rows: [], rowCount: 0 });
    stubActualRole = "owner";
    stubWorkspaceOwnerId = "owner_123";
    stubAllowedPages = null;
  });

  it("positive adjustment: returns 201 with updated location stock and total", async () => {
    mockDbQuery
      .mockResolvedValueOnce({ rows: [{ id: 5, stock: "0" }], rowCount: 1 })       // item exists
      .mockResolvedValueOnce({ rows: [locationRow], rowCount: 1 })                   // location check (stock=20)
      .mockResolvedValueOnce({ rows: [{ stock: "55" }], rowCount: 1 });              // SELECT total stock

    mockClientQuery
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })                              // BEGIN
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })                              // advisory lock
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })                              // idempotency (not dup)
      .mockResolvedValueOnce({ rows: [{ stock: "20" }], rowCount: 1 })               // postMovement SELECT FOR UPDATE
      .mockResolvedValueOnce({ rows: [{ id: 100 }], rowCount: 1 })                   // postMovement INSERT adj
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })                              // postMovement UPDATE location
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })                              // postMovement UPDATE base_items
      .mockResolvedValueOnce({ rows: [insertedRow], rowCount: 1 })                   // SELECT inserted row
      .mockResolvedValueOnce({ rows: [], rowCount: 0 });                             // COMMIT

    const res = await request(app)
      .post("/base-items/5/adjustments")
      .send({ location_id: 1, quantity_change: 10, reason: "receive", adjustment_action_id: ADJUSTMENT_ACTION_ID });

    expect(res.status).toBe(201);
    expect(res.body.stock).toBe(55);
    expect(res.body.adjustment.location_id).toBe(1);
    expect(res.body.adjustment.location_name).toBe("Main Warehouse");
    // 3 route pool calls + 1 extra from fireAndForgetLowStockAlert (SELECT base item name → rowCount 0 → early exit)
    expect(mockDbQuery).toHaveBeenCalledTimes(4);
  });

  it("negative adjustment exceeding stock: returns 400 and does not write to DB", async () => {
    const lowStockLocation = { location_id: 2, stock: "3", location_name: "Store B" };

    mockDbQuery
      .mockResolvedValueOnce({ rows: [{ id: 5, stock: "3" }], rowCount: 1 })         // item exists
      .mockResolvedValueOnce({ rows: [lowStockLocation], rowCount: 1 });              // location check (stock=3)
    mockClientQuery
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })                               // BEGIN
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })                               // advisory lock
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })                               // route idempotency check
      .mockResolvedValueOnce({
        rows: [{
          stock: "3",
          duplicate_id: null,
          duplicate_stock_after: null,
          base_item_name: "Item",
          location_name: "Store B",
          canonical_unit: "unit",
        }],
        rowCount: 1,
      })                                                                               // locked stock context
      .mockResolvedValueOnce({ rows: [], rowCount: 0 });                              // ROLLBACK

    const res = await request(app)
      .post("/base-items/5/adjustments")
      .send({ location_id: 2, quantity_change: -10, reason: "remove", adjustment_action_id: ADJUSTMENT_ACTION_ID });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/insufficient_stock/i);
    // Only the item and location pool reads occur; the transaction is rolled
    // back before an adjustment or balance update can be written.
    expect(mockDbQuery).toHaveBeenCalledTimes(2);
    expect(mockClientQuery.mock.calls.some(([sql]) =>
      /INSERT INTO base_item_stock_adjustments|UPDATE base_item_location_statuses|UPDATE base_items/i.test(String(sql)),
    )).toBe(false);
  });

  it("upsert location_stock call uses correct base_item_id and location_id params", async () => {
    mockDbQuery
      .mockResolvedValueOnce({ rows: [{ id: 7, stock: "5" }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [{ location_id: 3, stock: "5", location_name: "Depot" }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [{ stock: "12" }], rowCount: 1 });  // SELECT total stock

    mockClientQuery
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })                             // BEGIN
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })                             // advisory lock
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })                             // idempotency (not dup)
      .mockResolvedValueOnce({ rows: [{ stock: "5" }], rowCount: 1 })               // postMovement SELECT FOR UPDATE
      .mockResolvedValueOnce({ rows: [{ id: 100 }], rowCount: 1 })                  // postMovement INSERT adj
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })                             // postMovement UPDATE location
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })                             // postMovement UPDATE base_items
      .mockResolvedValueOnce({ rows: [{ ...insertedRow, base_item_id: 7, location_id: 3 }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 });                            // COMMIT

    await request(app)
      .post("/base-items/7/adjustments")
      .send({ location_id: 3, quantity_change: 7, reason: "correction", adjustment_action_id: ADJUSTMENT_ACTION_ID });

    // The UPDATE location stock call (postMovement client call index 4) carries base_item_id + location_id
    const updateLocCall = mockClientQuery.mock.calls[5]; // UPDATE base_item_location_statuses
    expect(updateLocCall[0]).toMatch(/UPDATE base_item_location_statuses/i);
    expect(updateLocCall[1]).toContain(7);   // base_item_id ($2)
    expect(updateLocCall[1]).toContain(3);   // location_id ($3)
  });

  it("total stock equals sum of all active location stocks after adjustment", async () => {
    mockDbQuery
      .mockResolvedValueOnce({ rows: [{ id: 5, stock: "10" }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [locationRow], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [{ stock: "75" }], rowCount: 1 });  // SELECT total stock from DB

    mockClientQuery
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })                             // BEGIN
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })                             // advisory lock
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })                             // idempotency (not dup)
      .mockResolvedValueOnce({ rows: [{ stock: "10" }], rowCount: 1 })              // postMovement SELECT FOR UPDATE
      .mockResolvedValueOnce({ rows: [{ id: 100 }], rowCount: 1 })                  // postMovement INSERT adj
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })                             // postMovement UPDATE location
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })                             // postMovement UPDATE base_items
      .mockResolvedValueOnce({ rows: [insertedRow], rowCount: 1 })                  // SELECT inserted row
      .mockResolvedValueOnce({ rows: [], rowCount: 0 });                            // COMMIT

    const res = await request(app)
      .post("/base-items/5/adjustments")
      .send({ location_id: 1, quantity_change: 5, reason: "receive", adjustment_action_id: ADJUSTMENT_ACTION_ID });

    expect(res.status).toBe(201);
    expect(res.body.stock).toBe(75); // derived from SELECT stock on base_items after transaction
  });

  it("adjustment row includes location_name in the response", async () => {
    mockDbQuery
      .mockResolvedValueOnce({ rows: [{ id: 5, stock: "0" }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [{ location_id: 1, stock: "0", location_name: "Warehouse Alpha" }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [{ stock: "10" }], rowCount: 1 });  // SELECT total stock

    mockClientQuery
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })                             // BEGIN
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })                             // advisory lock
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })                             // idempotency (not dup)
      .mockResolvedValueOnce({ rows: [{ stock: "0" }], rowCount: 1 })               // postMovement SELECT FOR UPDATE
      .mockResolvedValueOnce({ rows: [{ id: 100 }], rowCount: 1 })                  // postMovement INSERT adj
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })                             // postMovement UPDATE location
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })                             // postMovement UPDATE base_items
      .mockResolvedValueOnce({ rows: [{ ...insertedRow, location_name: undefined }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 });                            // COMMIT

    const res = await request(app)
      .post("/base-items/5/adjustments")
      .send({ location_id: 1, quantity_change: 10, reason: "receive", adjustment_action_id: ADJUSTMENT_ACTION_ID });

    expect(res.status).toBe(201);
    expect(res.body.adjustment.location_name).toBe("Warehouse Alpha");
  });
});

// ---------------------------------------------------------------------------
// GET /base-items/:id/adjustments — list includes location_name
// ---------------------------------------------------------------------------

describe("GET /base-items/:id/adjustments — location-aware history", () => {
  const app = makeApp();

  beforeEach(() => {
    vi.clearAllMocks();
    mockDbQuery.mockReset();
    mockDbQuery.mockResolvedValue({ rows: [], rowCount: 0 });
    stubActualRole = "owner";
    stubWorkspaceOwnerId = "owner_123";
    stubAllowedPages = null;
  });

  it("returns 400 for a non-numeric id", async () => {
    const res = await request(app).get("/base-items/abc/adjustments");
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/invalid base item id/i);
  });

  it("returns 404 when the base item does not exist", async () => {
    mockDbQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const res = await request(app).get("/base-items/999/adjustments");

    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/base item not found/i);
  });

  it("returns rows with location_name for new adjustments and null for legacy", async () => {
    const rows = [
      {
        id: 1, workspace_owner_id: "owner_123", base_item_id: 5,
        quantity_change: "10", reason: "receive", note: null,
        stock_after: "30", created_by_user_id: null,
        created_at: "2026-01-01T00:00:00Z",
        location_id: 1, location_name: "Main Warehouse",
      },
      {
        id: 2, workspace_owner_id: "owner_123", base_item_id: 5,
        quantity_change: "-5", reason: "remove", note: null,
        stock_after: "20", created_by_user_id: null,
        created_at: "2025-12-01T00:00:00Z",
        location_id: null, location_name: null,
      },
    ];

    mockDbQuery
      .mockResolvedValueOnce({ rows: [{ id: 5 }], rowCount: 1 }) // item exists
      .mockResolvedValueOnce({ rows, rowCount: 2 });               // adjustments with JOIN

    const res = await request(app).get("/base-items/5/adjustments");

    expect(res.status).toBe(200);
    expect(res.body.adjustments).toHaveLength(2);
    expect(res.body.adjustments[0].location_name).toBe("Main Warehouse");
    expect(res.body.adjustments[0].location_id).toBe(1);
    expect(res.body.adjustments[1].location_name).toBeNull();
    expect(res.body.adjustments[1].location_id).toBeNull();
    expect(mockDbQuery).toHaveBeenCalledTimes(2);
  });

  it("SELECT query uses a LEFT JOIN on locations", async () => {
    mockDbQuery
      .mockResolvedValueOnce({ rows: [{ id: 5 }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 });

    await request(app).get("/base-items/5/adjustments");

    const [selectSql] = mockDbQuery.mock.calls[1];
    expect(selectSql).toMatch(/LEFT JOIN locations/i);
    expect(selectSql).toMatch(/location_name/i);
  });
});

// ---------------------------------------------------------------------------
// GET /base-items/:id/products
// ---------------------------------------------------------------------------

describe("GET /base-items/:id/products — validation and success", () => {
  const app = makeApp();

  beforeEach(() => {
    vi.clearAllMocks();
    mockDbQuery.mockReset();
    mockDbQuery.mockResolvedValue({ rows: [], rowCount: 0 });
    stubActualRole = "owner";
    stubWorkspaceOwnerId = "owner_123";
    stubAllowedPages = null;
  });

  it("returns 400 for a non-numeric id", async () => {
    const res = await request(app).get("/base-items/abc/products");
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/invalid base item id/i);
  });

  it("returns 404 when the base item does not exist in the workspace", async () => {
    mockDbQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 }); // item not found

    const res = await request(app).get("/base-items/999/products");

    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/base item not found/i);
  });

  it("returns 200 with an empty products array when item has no recipe links", async () => {
    mockDbQuery
      .mockResolvedValueOnce({ rows: [{ id: 5 }], rowCount: 1 }) // item exists
      .mockResolvedValueOnce({ rows: [], rowCount: 0 });           // no recipes

    const res = await request(app).get("/base-items/5/products");

    expect(res.status).toBe(200);
    expect(res.body.products).toEqual([]);
    expect(mockDbQuery).toHaveBeenCalledTimes(2);
  });

  it("returns 200 with product link details and makes exactly 2 DB calls", async () => {
    const productRows = [
      {
        id: 10,
        name: "Red Rose Bouquet",
        sku: "RB001",
        category: "Flowers",
        status: "available",
        image_url: "https://example.com/rose.jpg",
        brand_id: 1,
        brand_logo_id: 2,
        quantity: "5",
        unit: null,
        recipe_updated_at: "2024-01-15T10:00:00Z",
        recipe_line_item_id: 100,
      },
      {
        id: 11,
        name: "Mixed Flowers",
        sku: null,
        category: null,
        status: "out_of_stock",
        image_url: null,
        brand_id: null,
        brand_logo_id: null,
        quantity: "3",
        unit: null,
        recipe_updated_at: "2024-02-01T14:00:00Z",
        recipe_line_item_id: 101,
      },
    ];

    mockDbQuery
      .mockResolvedValueOnce({ rows: [{ id: 5 }], rowCount: 1 }) // item exists
      .mockResolvedValueOnce({ rows: productRows, rowCount: 2 }); // product recipes

    const res = await request(app).get("/base-items/5/products");

    expect(res.status).toBe(200);
    expect(res.body.products).toHaveLength(2);
    expect(res.body.products[0].name).toBe("Red Rose Bouquet");
    expect(res.body.products[0].quantity).toBe("5");
    expect(res.body.products[0].unit).toBeNull();
    expect(res.body.products[1].brand_id).toBeNull();
    expect(mockDbQuery).toHaveBeenCalledTimes(2);
  });

  it("returns 500 and logs when the products query fails", async () => {
    mockDbQuery
      .mockResolvedValueOnce({ rows: [{ id: 5 }], rowCount: 1 }) // item exists
      .mockRejectedValueOnce(new Error("Database connection lost")); // products query fails

    const res = await request(app).get("/base-items/5/products");

    expect(res.status).toBe(500);
    expect(res.body.error).toMatch(/internal server error/i);
    expect(mockReqLogError).toHaveBeenCalledWith(
      expect.objectContaining({ err: expect.any(Error), baseItemId: 5 }),
      "Failed to load base item products",
    );
  });

  it("passes the correct workspaceOwnerId to both queries", async () => {
    stubWorkspaceOwnerId = "owner_xyz";
    mockDbQuery
      .mockResolvedValueOnce({ rows: [{ id: 5 }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 });

    await request(app).get("/base-items/5/products");

    const [, checkParams] = mockDbQuery.mock.calls[0];
    const [, productParams] = mockDbQuery.mock.calls[1];
    expect(checkParams).toContain("owner_xyz");
    expect(productParams).toContain("owner_xyz");
  });
});

// ---------------------------------------------------------------------------
// GET /base-items/spend-breakdown
// ---------------------------------------------------------------------------

describe("GET /base-items/spend-breakdown", () => {
  const app = makeApp();

  beforeEach(() => {
    vi.clearAllMocks();
    mockDbQuery.mockReset();
    mockDbQuery.mockResolvedValue({ rows: [], rowCount: 0 });
    stubActualRole = "owner";
    stubWorkspaceOwnerId = "owner_123";
    stubAllowedPages = null;
  });

  it("returns 200 with items array on success", async () => {
    const rows = [
      { id: 1, name: "Roses", category: "Flowers", spend_ytd: "5000", total_spend: "12000" },
      { id: 2, name: "Box", category: "Packaging", spend_ytd: "3000", total_spend: "8000" },
    ];
    mockDbQuery.mockResolvedValueOnce({ rows, rowCount: 2 });

    const res = await request(app).get("/base-items/spend-breakdown");

    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(2);
    expect(res.body.items[0].name).toBe("Roses");
    expect(res.body.items[1].name).toBe("Box");
    expect(mockDbQuery).toHaveBeenCalledTimes(1);
  });

  it("returns items in the order provided by the database (YTD spend DESC)", async () => {
    const rows = [
      { id: 3, name: "Tulips", category: "Flowers", spend_ytd: "9000", total_spend: "20000" },
      { id: 1, name: "Roses", category: "Flowers", spend_ytd: "5000", total_spend: "12000" },
      { id: 2, name: "Box", category: "Packaging", spend_ytd: "3000", total_spend: "8000" },
    ];
    mockDbQuery.mockResolvedValueOnce({ rows, rowCount: 3 });

    const res = await request(app).get("/base-items/spend-breakdown");

    expect(res.status).toBe(200);
    expect(res.body.items[0].id).toBe(3);
    expect(res.body.items[1].id).toBe(1);
    expect(res.body.items[2].id).toBe(2);
    const spends = res.body.items.map((i: { spend_ytd: string }) => Number(i.spend_ytd));
    expect(spends[0]).toBeGreaterThan(spends[1]);
    expect(spends[1]).toBeGreaterThan(spends[2]);
  });

  it("passes the workspaceOwnerId as the first query parameter (workspace isolation)", async () => {
    mockDbQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    await request(app).get("/base-items/spend-breakdown");

    const [, params] = mockDbQuery.mock.calls[0];
    expect(params[0]).toBe("owner_123");
  });

  it("uses workspaceOwnerId from the request context, not a hard-coded value", async () => {
    stubWorkspaceOwnerId = "other_owner_456";
    mockDbQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    await request(app).get("/base-items/spend-breakdown");

    const [, params] = mockDbQuery.mock.calls[0];
    expect(params[0]).toBe("other_owner_456");
  });

  it("uses the default limit of 10 when no limit param is provided", async () => {
    mockDbQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    await request(app).get("/base-items/spend-breakdown");

    const [, params] = mockDbQuery.mock.calls[0];
    expect(params[1]).toBe(10);
  });

  it("respects a valid custom limit param", async () => {
    mockDbQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    await request(app).get("/base-items/spend-breakdown?limit=25");

    const [, params] = mockDbQuery.mock.calls[0];
    expect(params[1]).toBe(25);
  });

  it("clamps limit to 10 when limit=0 (below minimum)", async () => {
    mockDbQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    await request(app).get("/base-items/spend-breakdown?limit=0");

    const [, params] = mockDbQuery.mock.calls[0];
    expect(params[1]).toBe(10);
  });

  it("clamps limit to 10 when limit exceeds 100", async () => {
    mockDbQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    await request(app).get("/base-items/spend-breakdown?limit=999");

    const [, params] = mockDbQuery.mock.calls[0];
    expect(params[1]).toBe(10);
  });

  it("clamps limit to 10 when limit is not a number", async () => {
    mockDbQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    await request(app).get("/base-items/spend-breakdown?limit=abc");

    const [, params] = mockDbQuery.mock.calls[0];
    expect(params[1]).toBe(10);
  });

  it("accepts limit=100 (boundary maximum)", async () => {
    mockDbQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    await request(app).get("/base-items/spend-breakdown?limit=100");

    const [, params] = mockDbQuery.mock.calls[0];
    expect(params[1]).toBe(100);
  });

  it("accepts limit=1 (boundary minimum)", async () => {
    mockDbQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    await request(app).get("/base-items/spend-breakdown?limit=1");

    const [, params] = mockDbQuery.mock.calls[0];
    expect(params[1]).toBe(1);
  });

  it("includes a HAVING clause to exclude zero-YTD-spend items", async () => {
    mockDbQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    await request(app).get("/base-items/spend-breakdown");

    const [sql] = mockDbQuery.mock.calls[0];
    expect(sql).toMatch(/HAVING/i);
    expect(sql).toMatch(/> 0/);
  });

  it("returns empty items array when no rows match", async () => {
    mockDbQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const res = await request(app).get("/base-items/spend-breakdown");

    expect(res.status).toBe(200);
    expect(res.body.items).toEqual([]);
    expect(mockDbQuery).toHaveBeenCalledTimes(1);
  });

  it("returns 500 when the database query throws", async () => {
    mockDbQuery.mockRejectedValueOnce(new Error("DB connection lost"));

    const res = await request(app).get("/base-items/spend-breakdown");

    expect(res.status).toBe(500);
  });
});

// ---------------------------------------------------------------------------
// GET /base-items/spend-summary
// ---------------------------------------------------------------------------

describe("GET /base-items/spend-summary", () => {
  const app = makeApp();

  beforeEach(() => {
    vi.clearAllMocks();
    mockDbQuery.mockReset();
    mockDbQuery.mockResolvedValue({ rows: [], rowCount: 0 });
    stubActualRole = "owner";
    stubWorkspaceOwnerId = "owner_123";
    stubAllowedPages = null;
  });

  it("returns 200 with total_spend and spend_ytd on success", async () => {
    mockDbQuery.mockResolvedValueOnce({
      rows: [{ total_spend: "42000", spend_ytd: "15000" }],
      rowCount: 1,
    });

    const res = await request(app).get("/base-items/spend-summary");

    expect(res.status).toBe(200);
    expect(res.body.total_spend).toBe("42000");
    expect(res.body.spend_ytd).toBe("15000");
    expect(mockDbQuery).toHaveBeenCalledTimes(1);
  });

  it("returns total_spend='0' and spend_ytd='0' when the DB returns no rows", async () => {
    mockDbQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const res = await request(app).get("/base-items/spend-summary");

    expect(res.status).toBe(200);
    expect(res.body.total_spend).toBe("0");
    expect(res.body.spend_ytd).toBe("0");
  });

  it("passes the workspaceOwnerId as the first query parameter (workspace isolation)", async () => {
    mockDbQuery.mockResolvedValueOnce({
      rows: [{ total_spend: "0", spend_ytd: "0" }],
      rowCount: 1,
    });

    await request(app).get("/base-items/spend-summary");

    const [, params] = mockDbQuery.mock.calls[0];
    expect(params[0]).toBe("owner_123");
  });

  it("uses workspaceOwnerId from the request context, not a hard-coded value", async () => {
    stubWorkspaceOwnerId = "other_owner_456";
    mockDbQuery.mockResolvedValueOnce({
      rows: [{ total_spend: "0", spend_ytd: "0" }],
      rowCount: 1,
    });

    await request(app).get("/base-items/spend-summary");

    const [, params] = mockDbQuery.mock.calls[0];
    expect(params[0]).toBe("other_owner_456");
  });

  it("returns 500 when the database query throws", async () => {
    mockDbQuery.mockRejectedValueOnce(new Error("DB connection lost"));

    const res = await request(app).get("/base-items/spend-summary");

    expect(res.status).toBe(500);
  });
});

// PATCH /base-items/:id — tax_category field
// ---------------------------------------------------------------------------

describe("PATCH /base-items/:id — tax_category field", () => {
  const app = makeApp();

  const EXISTING_ITEM: Record<string, unknown> = {
    id: 10,
    workspace_owner_id: "owner_123",
    name: "Rose Stem",
    code: "ROSEXX",
    image_url: null,
    category_id: null,
    alternate_name: null,
    accounting_category: null,
    tax_rate: null,
    tax_category: "not_classified",
    stock: 0,
    low_stock_threshold: 0,
    created_at: "2024-01-01T00:00:00Z",
  };

  const UPDATED_ITEM: Record<string, unknown> = {
    ...EXISTING_ITEM,
    tax_category: "standard_taxable",
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockDbQuery.mockReset();
    mockDbQuery.mockResolvedValue({ rows: [], rowCount: 0 });
    stubActualRole = "owner";
    stubWorkspaceOwnerId = "owner_123";
    stubAllowedPages = null;
  });

  it("returns 404 when the base item does not exist", async () => {
    mockDbQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 }); // SELECT existing

    const res = await request(app)
      .patch("/base-items/10")
      .send({ name: "Rose Stem", tax_category: "standard_taxable" });

    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/base item not found/i);
    expect(mockDbQuery).toHaveBeenCalledTimes(1);
  });

  it("returns 403 when caller is a member without manage permission", async () => {
    stubActualRole = "member";
    stubAllowedPages = [];

    const res = await request(app)
      .patch("/base-items/10")
      .send({ name: "Rose Stem" });

    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/managing base items/i);
    expect(mockDbQuery).not.toHaveBeenCalled();
  });

  it("returns 400 for a non-numeric id", async () => {
    const res = await request(app)
      .patch("/base-items/not-a-number")
      .send({ name: "Rose Stem" });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/invalid base item id/i);
    expect(mockDbQuery).not.toHaveBeenCalled();
  });

  it("returns 400 when an invalid tax_category is provided", async () => {
    mockDbQuery.mockResolvedValueOnce({ rows: [EXISTING_ITEM], rowCount: 1 }); // SELECT existing

    const res = await request(app)
      .patch("/base-items/10")
      .send({ name: "Rose Stem", tax_category: "invalid_value" });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/tax_category must be one of/i);
  });

  it("includes tax_category in the UPDATE query params and makes exactly 2 DB calls", async () => {
    mockDbQuery
      .mockResolvedValueOnce({ rows: [EXISTING_ITEM], rowCount: 1 }) // SELECT existing
      .mockResolvedValueOnce({ rows: [UPDATED_ITEM], rowCount: 1 }); // UPDATE

    const res = await request(app)
      .patch("/base-items/10")
      .send({ name: "Rose Stem", tax_category: "standard_taxable" });

    expect(res.status).toBe(200);
    expect(res.body.item.tax_category).toBe("standard_taxable");
    expect(mockDbQuery).toHaveBeenCalledTimes(2);

    const [updateSql, updateParams] = mockDbQuery.mock.calls[1];
    expect(updateSql).toMatch(/UPDATE base_items/i);
    expect(updateSql).toMatch(/tax_category\s*=\s*\$9/i);
    expect(updateParams[8]).toBe("standard_taxable"); // $9 is index 8
  });

  it("persists the previous tax_category when tax_category is not in the request body", async () => {
    const existingWithCategory = { ...EXISTING_ITEM, tax_category: "zero_rated" };
    const updatedWithSameCategory = { ...EXISTING_ITEM, name: "Updated Name", tax_category: "zero_rated" };

    mockDbQuery
      .mockResolvedValueOnce({ rows: [existingWithCategory], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [updatedWithSameCategory], rowCount: 1 });

    const res = await request(app)
      .patch("/base-items/10")
      .send({ name: "Updated Name" });

    expect(res.status).toBe(200);
    const [, updateParams] = mockDbQuery.mock.calls[1];
    expect(updateParams[8]).toBe("zero_rated"); // $9 carries previous value
  });

  it("accepts all valid tax_category values", async () => {
    const validCategories = [
      "not_classified", "standard_taxable", "zero_rated", "exempt",
      "non_taxable", "food_grocery", "packaging", "service", "import_related",
    ];

    for (const category of validCategories) {
      vi.clearAllMocks();
      mockDbQuery.mockReset();
      mockDbQuery
        .mockResolvedValueOnce({ rows: [EXISTING_ITEM], rowCount: 1 })
        .mockResolvedValueOnce({ rows: [{ ...EXISTING_ITEM, tax_category: category }], rowCount: 1 });

      const res = await request(app)
        .patch("/base-items/10")
        .send({ name: "Rose Stem", tax_category: category });

      expect(res.status).toBe(200);
      const [, updateParams] = mockDbQuery.mock.calls[1];
      expect(updateParams[8]).toBe(category);
    }
  });

  it("scopes the SELECT and UPDATE to the authenticated workspace owner", async () => {
    stubWorkspaceOwnerId = "owner_xyz";

    mockDbQuery
      .mockResolvedValueOnce({ rows: [{ ...EXISTING_ITEM, workspace_owner_id: "owner_xyz" }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [UPDATED_ITEM], rowCount: 1 });

    await request(app)
      .patch("/base-items/10")
      .send({ name: "Rose Stem", tax_category: "packaging" });

    const [, selectParams] = mockDbQuery.mock.calls[0];
    expect(selectParams).toContain("owner_xyz");
    const [, updateParams] = mockDbQuery.mock.calls[1];
    expect(updateParams).toContain("owner_xyz");
  });

  it("includes tax_category in UPDATE when category_id is also changed (3 DB calls total)", async () => {
    mockDbQuery
      .mockResolvedValueOnce({ rows: [EXISTING_ITEM], rowCount: 1 }) // SELECT existing
      .mockResolvedValueOnce({ rows: [{ id: 5 }], rowCount: 1 })    // SELECT category check
      .mockResolvedValueOnce({ rows: [{ ...UPDATED_ITEM, category_id: 5 }], rowCount: 1 }); // UPDATE

    const res = await request(app)
      .patch("/base-items/10")
      .send({ name: "Rose Stem", tax_category: "exempt", category_id: 5 });

    expect(res.status).toBe(200);
    expect(mockDbQuery).toHaveBeenCalledTimes(3);

    const [updateSql, updateParams] = mockDbQuery.mock.calls[2];
    expect(updateSql).toMatch(/tax_category\s*=\s*\$9/i);
    expect(updateParams[8]).toBe("exempt");
    expect(updateParams[2]).toBe(5); // $3 = categoryId
  });
});

// ---------------------------------------------------------------------------
// GET /base-items/:id/inventory-overview
// ---------------------------------------------------------------------------

describe("GET /base-items/:id/inventory-overview — permission checks", () => {
  const app = makeApp();

  beforeEach(() => {
    vi.clearAllMocks();
    mockDbQuery.mockReset();
    mockDbQuery.mockResolvedValue({ rows: [], rowCount: 0 });
    stubActualRole = "owner";
    stubWorkspaceOwnerId = "owner_123";
    stubAllowedPages = null;
  });

  it("returns 403 when caller has no base_items permission", async () => {
    stubActualRole = "member";
    stubAllowedPages = ["products.view"];

    const res = await request(app).get("/base-items/5/inventory-overview");

    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/viewing base item inventory/i);
  });

  it("allows a member with base_items.view permission", async () => {
    stubActualRole = "member";
    stubAllowedPages = ["base_items.view"];

    mockDbQuery
      .mockResolvedValueOnce({ rows: [{ id: 5 }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const res = await request(app).get("/base-items/5/inventory-overview");

    expect(res.status).toBe(200);
  });

  it("allows a member with base_items.manage permission", async () => {
    stubActualRole = "member";
    stubAllowedPages = ["base_items.manage"];

    mockDbQuery
      .mockResolvedValueOnce({ rows: [{ id: 5 }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const res = await request(app).get("/base-items/5/inventory-overview");

    expect(res.status).toBe(200);
  });
});

describe("GET /base-items/:id/inventory-overview — validation", () => {
  const app = makeApp();

  beforeEach(() => {
    vi.clearAllMocks();
    mockDbQuery.mockReset();
    mockDbQuery.mockResolvedValue({ rows: [], rowCount: 0 });
    stubActualRole = "owner";
    stubWorkspaceOwnerId = "owner_123";
    stubAllowedPages = null;
  });

  it("returns 400 for a non-numeric id", async () => {
    const res = await request(app).get("/base-items/abc/inventory-overview");
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/invalid base item id/i);
  });

  it("returns 404 when the base item does not exist", async () => {
    mockDbQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const res = await request(app).get("/base-items/5/inventory-overview");

    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/base item not found/i);
  });
});

describe("GET /base-items/:id/inventory-overview — success", () => {
  const app = makeApp();

  const locationRows = [
    { location_id: 1, location_name: "Dubai HQ", country: "AE", is_active: true, stock: "50", low_stock_threshold: "10" },
    { location_id: 2, location_name: "Dubai Branch", country: "AE", is_active: true, stock: "5", low_stock_threshold: "15" },
    { location_id: 3, location_name: "Beirut Store", country: "LB", is_active: true, stock: "0", low_stock_threshold: "0" },
  ];

  const thresholdRows = [
    { id: 1, base_item_id: 5, country: "AE", default_low_stock_threshold: "20", created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z" },
  ];

  beforeEach(() => {
    vi.clearAllMocks();
    mockDbQuery.mockReset();
    mockDbQuery.mockResolvedValue({ rows: [], rowCount: 0 });
    stubActualRole = "owner";
    stubWorkspaceOwnerId = "owner_123";
    stubAllowedPages = null;
  });

  it("returns 200 with countries, global_total, locations, country_thresholds, and suggested_actions", async () => {
    mockDbQuery
      .mockResolvedValueOnce({ rows: [{ id: 5 }], rowCount: 1 })           // item exists
      .mockResolvedValueOnce({ rows: locationRows, rowCount: 3 })            // locations
      .mockResolvedValueOnce({ rows: thresholdRows, rowCount: 1 });          // country thresholds

    const res = await request(app).get("/base-items/5/inventory-overview");

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("countries");
    expect(res.body).toHaveProperty("global_total");
    expect(res.body).toHaveProperty("locations");
    expect(res.body).toHaveProperty("country_thresholds");
    expect(res.body).toHaveProperty("suggested_actions");
    expect(mockDbQuery).toHaveBeenCalledTimes(3);
  });

  it("computes global_total as sum of active location stocks", async () => {
    mockDbQuery
      .mockResolvedValueOnce({ rows: [{ id: 5 }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: locationRows, rowCount: 3 })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const res = await request(app).get("/base-items/5/inventory-overview");

    expect(res.status).toBe(200);
    expect(res.body.global_total).toBe(55); // 50 + 5 + 0
  });

  it("groups locations by country and counts active locations per country", async () => {
    mockDbQuery
      .mockResolvedValueOnce({ rows: [{ id: 5 }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: locationRows, rowCount: 3 })
      .mockResolvedValueOnce({ rows: thresholdRows, rowCount: 1 });

    const res = await request(app).get("/base-items/5/inventory-overview");

    const countries = res.body.countries as Array<{ country: string; active_location_count: number; total_stock: number }>;
    const ae = countries.find(c => c.country === "AE");
    const lb = countries.find(c => c.country === "LB");

    expect(ae).toBeDefined();
    expect(ae!.active_location_count).toBe(2);
    expect(ae!.total_stock).toBe(55);
    expect(lb).toBeDefined();
    expect(lb!.active_location_count).toBe(1);
    expect(lb!.total_stock).toBe(0);
  });

  it("marks a location as low_stock when stock <= effective threshold", async () => {
    mockDbQuery
      .mockResolvedValueOnce({ rows: [{ id: 5 }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: locationRows, rowCount: 3 })
      .mockResolvedValueOnce({ rows: thresholdRows, rowCount: 1 });

    const res = await request(app).get("/base-items/5/inventory-overview");

    const countries = res.body.countries as Array<{ country: string; status: string; low_stock_location_count: number }>;
    const ae = countries.find(c => c.country === "AE");
    // loc1: stock=50, locThreshold=10 (>0) → effective=10; 50 > 10 → not low_stock
    // loc2: stock=5,  locThreshold=15 (>0) → effective=15; 5 <= 15 → low_stock
    expect(ae!.low_stock_location_count).toBe(1);
  });

  it("marks a country as out_of_stock when all active locations have zero stock", async () => {
    const outOfStockLocs = [
      { location_id: 3, location_name: "Beirut Store", country: "LB", is_active: true, stock: "0", low_stock_threshold: "5" },
    ];
    const lbThreshold = [
      { id: 2, base_item_id: 5, country: "LB", default_low_stock_threshold: "10", created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z" },
    ];
    mockDbQuery
      .mockResolvedValueOnce({ rows: [{ id: 5 }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: outOfStockLocs, rowCount: 1 })
      .mockResolvedValueOnce({ rows: lbThreshold, rowCount: 1 });

    const res = await request(app).get("/base-items/5/inventory-overview");

    const lb = res.body.countries.find((c: { country: string; status: string }) => c.country === "LB");
    expect(lb.status).toBe("out_of_stock");
  });

  it("marks a country as alert_disabled when no thresholds are set", async () => {
    const noThresholdLocs = [
      { location_id: 3, location_name: "Beirut Store", country: "LB", is_active: true, stock: "5", low_stock_threshold: "0" },
    ];
    mockDbQuery
      .mockResolvedValueOnce({ rows: [{ id: 5 }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: noThresholdLocs, rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 }); // no country thresholds

    const res = await request(app).get("/base-items/5/inventory-overview");

    const lb = res.body.countries.find((c: { country: string; status: string }) => c.country === "LB");
    expect(lb.status).toBe("alert_disabled");
  });

  it("includes suggested_actions for low-stock locations", async () => {
    mockDbQuery
      .mockResolvedValueOnce({ rows: [{ id: 5 }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: locationRows, rowCount: 3 })
      .mockResolvedValueOnce({ rows: thresholdRows, rowCount: 1 });

    const res = await request(app).get("/base-items/5/inventory-overview");

    const actions = res.body.suggested_actions as Array<{ location_id: number; deficit: number }>;
    const lowLoc = actions.find(a => a.location_id === 2);
    expect(lowLoc).toBeDefined();
    expect(lowLoc!.deficit).toBeGreaterThan(0);
  });

  it("converts stock and low_stock_threshold from string to number in locations array", async () => {
    mockDbQuery
      .mockResolvedValueOnce({ rows: [{ id: 5 }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: locationRows, rowCount: 3 })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const res = await request(app).get("/base-items/5/inventory-overview");

    const locs = res.body.locations as Array<{ stock: unknown; low_stock_threshold: unknown }>;
    expect(typeof locs[0].stock).toBe("number");
    expect(typeof locs[0].low_stock_threshold).toBe("number");
  });

  it("converts default_low_stock_threshold from string to number in country_thresholds", async () => {
    mockDbQuery
      .mockResolvedValueOnce({ rows: [{ id: 5 }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({ rows: thresholdRows, rowCount: 1 });

    const res = await request(app).get("/base-items/5/inventory-overview");

    const thresholds = res.body.country_thresholds as Array<{ default_low_stock_threshold: unknown }>;
    expect(typeof thresholds[0].default_low_stock_threshold).toBe("number");
  });

  it("scopes location and threshold queries to the workspace", async () => {
    stubWorkspaceOwnerId = "owner_xyz";
    mockDbQuery
      .mockResolvedValueOnce({ rows: [{ id: 5 }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 });

    await request(app).get("/base-items/5/inventory-overview");

    const [, checkParams] = mockDbQuery.mock.calls[0];
    expect(checkParams).toContain("owner_xyz");
    const [, locsParams] = mockDbQuery.mock.calls[1];
    expect(locsParams).toContain("owner_xyz");
  });
});

// ---------------------------------------------------------------------------
// GET /base-items/:id/country-thresholds
// ---------------------------------------------------------------------------

describe("GET /base-items/:id/country-thresholds — permission checks", () => {
  const app = makeApp();

  beforeEach(() => {
    vi.clearAllMocks();
    mockDbQuery.mockReset();
    mockDbQuery.mockResolvedValue({ rows: [], rowCount: 0 });
    stubActualRole = "owner";
    stubWorkspaceOwnerId = "owner_123";
    stubAllowedPages = null;
  });

  it("returns 403 when caller has no base_items permission", async () => {
    stubActualRole = "member";
    stubAllowedPages = ["products.view"];

    const res = await request(app).get("/base-items/5/country-thresholds");

    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/viewing base item inventory/i);
  });

  it("allows a member with base_items.view permission", async () => {
    stubActualRole = "member";
    stubAllowedPages = ["base_items.view"];

    mockDbQuery
      .mockResolvedValueOnce({ rows: [{ id: 5 }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const res = await request(app).get("/base-items/5/country-thresholds");

    expect(res.status).toBe(200);
  });

  it("allows a member with base_items.manage permission", async () => {
    stubActualRole = "member";
    stubAllowedPages = ["base_items.manage"];

    mockDbQuery
      .mockResolvedValueOnce({ rows: [{ id: 5 }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const res = await request(app).get("/base-items/5/country-thresholds");

    expect(res.status).toBe(200);
  });
});

describe("GET /base-items/:id/country-thresholds — validation and success", () => {
  const app = makeApp();

  beforeEach(() => {
    vi.clearAllMocks();
    mockDbQuery.mockReset();
    mockDbQuery.mockResolvedValue({ rows: [], rowCount: 0 });
    stubActualRole = "owner";
    stubWorkspaceOwnerId = "owner_123";
    stubAllowedPages = null;
  });

  it("returns 400 for a non-numeric id", async () => {
    const res = await request(app).get("/base-items/abc/country-thresholds");
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/invalid base item id/i);
  });

  it("returns 404 when the base item does not exist", async () => {
    mockDbQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const res = await request(app).get("/base-items/5/country-thresholds");

    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/base item not found/i);
  });

  it("returns 200 with an empty thresholds array when none are set", async () => {
    mockDbQuery
      .mockResolvedValueOnce({ rows: [{ id: 5 }], rowCount: 1 }) // item exists
      .mockResolvedValueOnce({ rows: [], rowCount: 0 });            // no thresholds

    const res = await request(app).get("/base-items/5/country-thresholds");

    expect(res.status).toBe(200);
    expect(res.body.thresholds).toEqual([]);
    expect(mockDbQuery).toHaveBeenCalledTimes(2);
  });

  it("returns 200 with thresholds ordered by country and makes exactly 2 DB calls", async () => {
    const rows = [
      { id: 1, base_item_id: 5, country: "AE", default_low_stock_threshold: "20", created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z" },
      { id: 2, base_item_id: 5, country: "LB", default_low_stock_threshold: "10", created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z" },
    ];
    mockDbQuery
      .mockResolvedValueOnce({ rows: [{ id: 5 }], rowCount: 1 })
      .mockResolvedValueOnce({ rows, rowCount: 2 });

    const res = await request(app).get("/base-items/5/country-thresholds");

    expect(res.status).toBe(200);
    expect(res.body.thresholds).toHaveLength(2);
    expect(res.body.thresholds[0].country).toBe("AE");
    expect(res.body.thresholds[0].default_low_stock_threshold).toBe(20);
    expect(typeof res.body.thresholds[0].default_low_stock_threshold).toBe("number");
    expect(mockDbQuery).toHaveBeenCalledTimes(2);
  });

  it("scopes the existence check to the authenticated workspace", async () => {
    stubWorkspaceOwnerId = "owner_xyz";
    mockDbQuery
      .mockResolvedValueOnce({ rows: [{ id: 5 }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 });

    await request(app).get("/base-items/5/country-thresholds");

    const [, checkParams] = mockDbQuery.mock.calls[0];
    expect(checkParams).toContain("owner_xyz");
  });
});

// ---------------------------------------------------------------------------
// PUT /base-items/:id/country-thresholds/:country
// ---------------------------------------------------------------------------

describe("PUT /base-items/:id/country-thresholds/:country — permission checks", () => {
  const app = makeApp();

  beforeEach(() => {
    vi.clearAllMocks();
    mockDbQuery.mockReset();
    mockDbQuery.mockResolvedValue({ rows: [], rowCount: 0 });
    stubActualRole = "owner";
    stubWorkspaceOwnerId = "owner_123";
    stubAllowedPages = null;
  });

  it("returns 403 when caller is a member without manage permissions", async () => {
    stubActualRole = "member";
    stubAllowedPages = ["base_items.view"];

    const res = await request(app)
      .put("/base-items/5/country-thresholds/AE")
      .send({ default_low_stock_threshold: 10 });

    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/managing base items/i);
  });

  it("allows a member with base_items.manage permission", async () => {
    stubActualRole = "member";
    stubAllowedPages = ["base_items.manage"];

    const upsertedRow = { id: 1, base_item_id: 5, country: "AE", default_low_stock_threshold: "10", created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z" };
    mockDbQuery
      .mockResolvedValueOnce({ rows: [{ id: 5 }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [upsertedRow], rowCount: 1 });

    const res = await request(app)
      .put("/base-items/5/country-thresholds/AE")
      .send({ default_low_stock_threshold: 10 });

    expect(res.status).toBe(200);
  });
});

describe("PUT /base-items/:id/country-thresholds/:country — validation", () => {
  const app = makeApp();

  beforeEach(() => {
    vi.clearAllMocks();
    mockDbQuery.mockReset();
    mockDbQuery.mockResolvedValue({ rows: [], rowCount: 0 });
    stubActualRole = "owner";
    stubWorkspaceOwnerId = "owner_123";
    stubAllowedPages = null;
  });

  it("returns 400 for a non-numeric base item id", async () => {
    const res = await request(app)
      .put("/base-items/notanumber/country-thresholds/AE")
      .send({ default_low_stock_threshold: 10 });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/invalid base item id/i);
  });

  it("returns 400 when default_low_stock_threshold is missing", async () => {
    mockDbQuery.mockResolvedValueOnce({ rows: [{ id: 5 }], rowCount: 1 });

    const res = await request(app)
      .put("/base-items/5/country-thresholds/AE")
      .send({});

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/non-negative number/i);
  });

  it("returns 400 when default_low_stock_threshold is negative", async () => {
    const res = await request(app)
      .put("/base-items/5/country-thresholds/AE")
      .send({ default_low_stock_threshold: -5 });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/non-negative number/i);
  });

  it("returns 400 when default_low_stock_threshold is not a number", async () => {
    const res = await request(app)
      .put("/base-items/5/country-thresholds/AE")
      .send({ default_low_stock_threshold: "bad" });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/non-negative number/i);
  });

  it("returns 404 when the base item does not exist in the workspace", async () => {
    mockDbQuery
      .mockResolvedValueOnce({ rows: [], rowCount: 0 }); // item not found

    const res = await request(app)
      .put("/base-items/999/country-thresholds/AE")
      .send({ default_low_stock_threshold: 10 });

    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/base item not found/i);
  });
});

describe("PUT /base-items/:id/country-thresholds/:country — success", () => {
  const app = makeApp();

  const upsertedRow = {
    id: 1, base_item_id: 5, country: "AE", default_low_stock_threshold: "25",
    created_at: "2026-01-01T00:00:00Z", updated_at: "2026-06-01T00:00:00Z",
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockDbQuery.mockReset();
    mockDbQuery.mockResolvedValue({ rows: [], rowCount: 0 });
    stubActualRole = "owner";
    stubWorkspaceOwnerId = "owner_123";
    stubAllowedPages = null;
  });

  it("returns 200 with the upserted row and converts threshold to number", async () => {
    mockDbQuery
      .mockResolvedValueOnce({ rows: [{ id: 5 }], rowCount: 1 })           // item exists
      .mockResolvedValueOnce({ rows: [upsertedRow], rowCount: 1 });          // INSERT ON CONFLICT RETURNING

    const res = await request(app)
      .put("/base-items/5/country-thresholds/AE")
      .send({ default_low_stock_threshold: 25 });

    expect(res.status).toBe(200);
    expect(res.body.country).toBe("AE");
    expect(res.body.default_low_stock_threshold).toBe(25);
    expect(typeof res.body.default_low_stock_threshold).toBe("number");
    expect(mockDbQuery).toHaveBeenCalledTimes(2);
  });

  it("uses an INSERT ON CONFLICT upsert query targeting base_item_id and country", async () => {
    mockDbQuery
      .mockResolvedValueOnce({ rows: [{ id: 5 }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [upsertedRow], rowCount: 1 });

    await request(app)
      .put("/base-items/5/country-thresholds/AE")
      .send({ default_low_stock_threshold: 25 });

    const [upsertSql, upsertParams] = mockDbQuery.mock.calls[1];
    expect(upsertSql).toMatch(/INSERT INTO base_item_country_thresholds/i);
    expect(upsertSql).toMatch(/ON CONFLICT/i);
    expect(upsertParams).toContain(5);   // base_item_id
    expect(upsertParams).toContain("AE"); // country
    expect(upsertParams).toContain(25);  // threshold value
  });

  it("accepts zero as a valid threshold (disables the alert)", async () => {
    const zeroRow = { ...upsertedRow, default_low_stock_threshold: "0" };
    mockDbQuery
      .mockResolvedValueOnce({ rows: [{ id: 5 }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [zeroRow], rowCount: 1 });

    const res = await request(app)
      .put("/base-items/5/country-thresholds/AE")
      .send({ default_low_stock_threshold: 0 });

    expect(res.status).toBe(200);
    expect(res.body.default_low_stock_threshold).toBe(0);
  });

  it("scopes the existence check to the authenticated workspace owner", async () => {
    stubWorkspaceOwnerId = "owner_xyz";
    mockDbQuery
      .mockResolvedValueOnce({ rows: [{ id: 5 }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [upsertedRow], rowCount: 1 });

    await request(app)
      .put("/base-items/5/country-thresholds/AE")
      .send({ default_low_stock_threshold: 25 });

    const [, checkParams] = mockDbQuery.mock.calls[0];
    expect(checkParams).toContain("owner_xyz");
  });
});

// ---------------------------------------------------------------------------
// POST /base-items/:id/transfers
// ---------------------------------------------------------------------------

describe("POST /base-items/:id/transfers — permission checks", () => {
  const app = makeApp();

  beforeEach(() => {
    vi.clearAllMocks();
    mockDbQuery.mockReset();
    mockDbQuery.mockResolvedValue({ rows: [], rowCount: 0 });
    mockClientQuery.mockReset();
    mockClientQuery.mockResolvedValue({ rows: [], rowCount: 0 });
    stubActualRole = "owner";
    stubWorkspaceOwnerId = "owner_123";
    stubAllowedPages = null;
  });

  it("returns 403 when caller is a member without manage permissions", async () => {
    stubActualRole = "member";
    stubAllowedPages = ["base_items.view"];

    const res = await request(app)
      .post("/base-items/5/transfers")
      .send({
        from_location_id: 1,
        to_location_id: 2,
        quantity: 5,
        reason: "rebalance",
        transfer_action_id: TRANSFER_ACTION_ID,
      });

    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/managing base items/i);
  });

  it("allows a member with base_items.manage permission", async () => {
    stubActualRole = "member";
    stubAllowedPages = ["base_items.manage"];

    const fromRow = { location_id: 1, location_name: "Dubai HQ", country: "AE", stock: "20" };
    const toRow = { location_id: 2, location_name: "Dubai Branch", country: "AE", stock: "10" };

    mockDbQuery
      .mockResolvedValueOnce({ rows: [{ id: 5 }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [fromRow, toRow], rowCount: 2 });

    mockClientQuery
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })                     // BEGIN
      .mockResolvedValueOnce({ rows: [{ id: 42 }], rowCount: 1 })           // INSERT transfer RETURNING id
      .mockResolvedValueOnce({ rows: [{ stock: "20" }], rowCount: 1 })      // postMov(out) SELECT FOR UPDATE
      .mockResolvedValueOnce({ rows: [{ id: 1 }], rowCount: 1 })            // postMov(out) INSERT adj
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })                     // postMov(out) UPDATE location
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })                     // postMov(out) UPDATE base_items
      .mockResolvedValueOnce({ rows: [{ stock: "10" }], rowCount: 1 })      // postMov(in) SELECT FOR UPDATE
      .mockResolvedValueOnce({ rows: [{ id: 2 }], rowCount: 1 })            // postMov(in) INSERT adj
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })                     // postMov(in) UPDATE location
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })                     // postMov(in) UPDATE base_items
      .mockResolvedValueOnce({ rows: [], rowCount: 0 });                    // COMMIT

    const res = await request(app)
      .post("/base-items/5/transfers")
      .send({ from_location_id: 1, to_location_id: 2, quantity: 5, reason: "rebalance", transfer_action_id: TRANSFER_ACTION_ID });

    expect(res.status).toBe(201);
  });
});

describe("POST /base-items/:id/transfers — validation", () => {
  const app = makeApp();

  beforeEach(() => {
    vi.clearAllMocks();
    mockDbQuery.mockReset();
    mockDbQuery.mockResolvedValue({ rows: [], rowCount: 0 });
    mockClientQuery.mockReset();
    mockClientQuery.mockResolvedValue({ rows: [], rowCount: 0 });
    stubActualRole = "owner";
    stubWorkspaceOwnerId = "owner_123";
    stubAllowedPages = null;
  });

  it("returns 400 for a non-numeric base item id", async () => {
    const res = await request(app)
      .post("/base-items/notanumber/transfers")
      .send({ from_location_id: 1, to_location_id: 2, quantity: 5, reason: "rebalance" });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/invalid base item id/i);
  });

  it("returns 404 when the base item does not exist", async () => {
    mockDbQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const res = await request(app)
      .post("/base-items/999/transfers")
      .send({ from_location_id: 1, to_location_id: 2, quantity: 5, reason: "rebalance" });

    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/base item not found/i);
  });

  it("returns 400 when from_location_id or to_location_id is not an integer", async () => {
    mockDbQuery.mockResolvedValueOnce({ rows: [{ id: 5 }], rowCount: 1 });

    const res = await request(app)
      .post("/base-items/5/transfers")
      .send({ from_location_id: "abc", to_location_id: 2, quantity: 5, reason: "rebalance" });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/must be integers/i);
  });

  it("returns 400 when from_location_id equals to_location_id", async () => {
    mockDbQuery.mockResolvedValueOnce({ rows: [{ id: 5 }], rowCount: 1 });

    const res = await request(app)
      .post("/base-items/5/transfers")
      .send({ from_location_id: 1, to_location_id: 1, quantity: 5, reason: "rebalance" });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/must be different/i);
  });

  it("returns 400 when quantity is zero or negative", async () => {
    mockDbQuery.mockResolvedValueOnce({ rows: [{ id: 5 }], rowCount: 1 });

    const res = await request(app)
      .post("/base-items/5/transfers")
      .send({ from_location_id: 1, to_location_id: 2, quantity: 0, reason: "rebalance" });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/positive number/i);
  });

  it("returns 400 when reason is missing", async () => {
    mockDbQuery.mockResolvedValueOnce({ rows: [{ id: 5 }], rowCount: 1 });

    const res = await request(app)
      .post("/base-items/5/transfers")
      .send({ from_location_id: 1, to_location_id: 2, quantity: 5 });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/reason is required/i);
  });

  it("returns 400 when from_location_id is not an active location for this base item", async () => {
    const toRow = { location_id: 2, location_name: "Dubai Branch", country: "AE", stock: "10" };
    mockDbQuery
      .mockResolvedValueOnce({ rows: [{ id: 5 }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [toRow], rowCount: 1 }) // only to-location found
      .mockResolvedValueOnce({ rows: [{ id: 2 }], rowCount: 1 }); // existence check: only id 2 exists

    const res = await request(app)
      .post("/base-items/5/transfers")
      .send({ from_location_id: 99, to_location_id: 2, quantity: 5, reason: "rebalance", transfer_action_id: TRANSFER_ACTION_ID });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/from_location_id \(location 99\) does not exist in this workspace/i);
  });

  it("returns 400 when to_location_id is not an active location for this base item", async () => {
    const fromRow = { location_id: 1, location_name: "Dubai HQ", country: "AE", stock: "20" };
    mockDbQuery
      .mockResolvedValueOnce({ rows: [{ id: 5 }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [fromRow], rowCount: 1 }) // only from-location found
      .mockResolvedValueOnce({ rows: [{ id: 1 }], rowCount: 1 }); // existence check: only id 1 exists

    const res = await request(app)
      .post("/base-items/5/transfers")
      .send({ from_location_id: 1, to_location_id: 99, quantity: 5, reason: "rebalance", transfer_action_id: TRANSFER_ACTION_ID });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/to_location_id \(location 99\) does not exist in this workspace/i);
  });

  it("returns 400 when from and to locations are in different countries", async () => {
    const fromRow = { location_id: 1, location_name: "Dubai HQ", country: "AE", stock: "20" };
    const toRow = { location_id: 2, location_name: "Beirut Store", country: "LB", stock: "10" };
    mockDbQuery
      .mockResolvedValueOnce({ rows: [{ id: 5 }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [fromRow, toRow], rowCount: 2 });

    const res = await request(app)
      .post("/base-items/5/transfers")
      .send({ from_location_id: 1, to_location_id: 2, quantity: 5, reason: "rebalance", transfer_action_id: TRANSFER_ACTION_ID });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/cross-country transfers are not allowed/i);
  });

  it("returns 400 when from location has insufficient stock", async () => {
    const fromRow = { location_id: 1, location_name: "Dubai HQ", country: "AE", stock: "3" };
    const toRow = { location_id: 2, location_name: "Dubai Branch", country: "AE", stock: "10" };
    mockDbQuery
      .mockResolvedValueOnce({ rows: [{ id: 5 }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [fromRow, toRow], rowCount: 2 });
    mockClientQuery
      .mockResolvedValueOnce({ rows: [], rowCount: 0 }) // BEGIN
      .mockResolvedValueOnce({ rows: [{ id: 42 }], rowCount: 1 }) // transfer claim
      .mockResolvedValueOnce({
        rows: [{
          stock: "3",
          duplicate_id: null,
          duplicate_stock_after: null,
          base_item_name: "Item",
          location_name: "Dubai HQ",
          canonical_unit: "unit",
        }],
        rowCount: 1,
      }) // outbound locked stock context
      .mockResolvedValueOnce({ rows: [], rowCount: 0 }); // ROLLBACK

    const res = await request(app)
      .post("/base-items/5/transfers")
      .send({ from_location_id: 1, to_location_id: 2, quantity: 10, reason: "rebalance", transfer_action_id: TRANSFER_ACTION_ID });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/insufficient_stock/i);
  });
});

describe("POST /base-items/:id/transfers — success", () => {
  const app = makeApp();

  const fromRow = { location_id: 1, location_name: "Dubai HQ", country: "AE", stock: "20" };
  const toRow = { location_id: 2, location_name: "Dubai Branch", country: "AE", stock: "10" };
  const transferBody = {
    from_location_id: 1,
    to_location_id: 2,
    quantity: 5,
    reason: "rebalance",
    transfer_action_id: TRANSFER_ACTION_ID,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockDbQuery.mockReset();
    mockDbQuery.mockResolvedValue({ rows: [], rowCount: 0 });
    mockClientQuery.mockReset();
    mockClientQuery.mockResolvedValue({ rows: [], rowCount: 0 });
    stubActualRole = "owner";
    stubWorkspaceOwnerId = "owner_123";
    stubAllowedPages = null;
  });

  it("returns 201 with transfer_id and updated stock values, makes 2 pool calls and 11 client calls", async () => {
    mockDbQuery
      .mockResolvedValueOnce({ rows: [{ id: 5 }], rowCount: 1 })            // item exists
      .mockResolvedValueOnce({ rows: [fromRow, toRow], rowCount: 2 });        // locations query

    mockClientQuery
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })                      // BEGIN
      .mockResolvedValueOnce({ rows: [{ id: 42 }], rowCount: 1 })            // INSERT transfer RETURNING id
      .mockResolvedValueOnce({ rows: [{ stock: "20" }], rowCount: 1 })       // postMov(out) SELECT FOR UPDATE
      .mockResolvedValueOnce({ rows: [{ id: 1 }], rowCount: 1 })             // postMov(out) INSERT adj
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })                      // postMov(out) UPDATE location
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })                      // postMov(out) UPDATE base_items
      .mockResolvedValueOnce({ rows: [{ stock: "10" }], rowCount: 1 })       // postMov(in) SELECT FOR UPDATE
      .mockResolvedValueOnce({ rows: [{ id: 2 }], rowCount: 1 })             // postMov(in) INSERT adj
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })                      // postMov(in) UPDATE location
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })                      // postMov(in) UPDATE base_items
      .mockResolvedValueOnce({ rows: [], rowCount: 0 });                     // COMMIT

    const res = await request(app)
      .post("/base-items/5/transfers")
      .send(transferBody);

    expect(res.status).toBe(201);
    expect(res.body.ok).toBe(true);
    expect(res.body.transfer_id).toBe(42);
    expect(res.body.from_stock_after).toBe(15); // 20 - 5
    expect(res.body.to_stock_after).toBe(15);   // 10 + 5
    // 2 route pool calls + 1 extra from fireAndForgetLowStockAlert on the from-location
    // (SELECT base item name → rowCount 0 → early exit; to-location is not alerted since its stock increased)
    expect(mockDbQuery).toHaveBeenCalledTimes(3);
    expect(mockClientQuery).toHaveBeenCalledTimes(11);
  });

  it("wraps operations in a transaction (BEGIN then COMMIT)", async () => {
    mockDbQuery
      .mockResolvedValueOnce({ rows: [{ id: 5 }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [fromRow, toRow], rowCount: 2 });

    mockClientQuery
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })                      // BEGIN
      .mockResolvedValueOnce({ rows: [{ id: 42 }], rowCount: 1 })            // INSERT transfer
      .mockResolvedValueOnce({ rows: [{ stock: "20" }], rowCount: 1 })       // postMov(out) SELECT FOR UPDATE
      .mockResolvedValueOnce({ rows: [{ id: 1 }], rowCount: 1 })             // postMov(out) INSERT adj
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })                      // postMov(out) UPDATE location
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })                      // postMov(out) UPDATE base_items
      .mockResolvedValueOnce({ rows: [{ stock: "10" }], rowCount: 1 })       // postMov(in) SELECT FOR UPDATE
      .mockResolvedValueOnce({ rows: [{ id: 2 }], rowCount: 1 })             // postMov(in) INSERT adj
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })                      // postMov(in) UPDATE location
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })                      // postMov(in) UPDATE base_items
      .mockResolvedValueOnce({ rows: [], rowCount: 0 });                     // COMMIT

    await request(app)
      .post("/base-items/5/transfers")
      .send(transferBody);

    const calls = mockClientQuery.mock.calls;
    expect(calls[0][0]).toBe("BEGIN");
    expect(calls[10][0]).toBe("COMMIT");
  });

  it("inserts adjustment rows with transfer_out and transfer_in movement_type", async () => {
    mockDbQuery
      .mockResolvedValueOnce({ rows: [{ id: 5 }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [fromRow, toRow], rowCount: 2 });

    mockClientQuery
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })                      // BEGIN
      .mockResolvedValueOnce({ rows: [{ id: 42 }], rowCount: 1 })            // INSERT transfer
      .mockResolvedValueOnce({ rows: [{ stock: "20" }], rowCount: 1 })       // postMov(out) SELECT FOR UPDATE
      .mockResolvedValueOnce({ rows: [{ id: 1 }], rowCount: 1 })             // postMov(out) INSERT adj
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })                      // postMov(out) UPDATE location
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })                      // postMov(out) UPDATE base_items
      .mockResolvedValueOnce({ rows: [{ stock: "10" }], rowCount: 1 })       // postMov(in) SELECT FOR UPDATE
      .mockResolvedValueOnce({ rows: [{ id: 2 }], rowCount: 1 })             // postMov(in) INSERT adj
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })                      // postMov(in) UPDATE location
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })                      // postMov(in) UPDATE base_items
      .mockResolvedValueOnce({ rows: [], rowCount: 0 });                     // COMMIT

    await request(app)
      .post("/base-items/5/transfers")
      .send(transferBody);

    // postMov(out) INSERT adj is at client call index 3; postMov(in) INSERT adj at index 7.
    // movement_type is passed as the 6th parameter ($6, index 5) — not embedded in the SQL string.
    const outInsert = String(mockClientQuery.mock.calls[3][0]);
    expect(outInsert).toMatch(/INSERT INTO base_item_stock_adjustments/i);
    expect(mockClientQuery.mock.calls[3][1][5]).toBe("transfer_out");
    const inInsert = String(mockClientQuery.mock.calls[7][0]);
    expect(inInsert).toMatch(/INSERT INTO base_item_stock_adjustments/i);
    expect(mockClientQuery.mock.calls[7][1][5]).toBe("transfer_in");
  });

  it("issues a ROLLBACK and re-throws when a transaction step fails", async () => {
    mockDbQuery
      .mockResolvedValueOnce({ rows: [{ id: 5 }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [fromRow, toRow], rowCount: 2 });

    mockClientQuery
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })                      // BEGIN
      .mockRejectedValueOnce(new Error("DB failure"));                        // UPDATE from-location fails

    const res = await request(app)
      .post("/base-items/5/transfers")
      .send(transferBody);

    expect(res.status).toBe(500);
    const sqlCalls = mockClientQuery.mock.calls.map((c: unknown[]) => String(c[0]));
    expect(sqlCalls).toContain("ROLLBACK");
    expect(mockClientRelease).toHaveBeenCalled();
  });

  it("releases the client connection on success", async () => {
    mockDbQuery
      .mockResolvedValueOnce({ rows: [{ id: 5 }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [fromRow, toRow], rowCount: 2 });

    mockClientQuery
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [{ total: "30" }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [{ id: 42 }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 2 })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 });

    await request(app)
      .post("/base-items/5/transfers")
      .send(transferBody);

    expect(mockClientRelease).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// GET /base-items/:id/adjustments — filter params (movement_type, country,
// location_id, date_from, date_to)
// ---------------------------------------------------------------------------

describe("GET /base-items/:id/adjustments — filter params", () => {
  const app = makeApp();

  beforeEach(() => {
    vi.clearAllMocks();
    mockDbQuery.mockReset();
    mockDbQuery
      .mockResolvedValueOnce({ rows: [{ id: 5 }], rowCount: 1 }) // item exists (catch-all for first call)
      .mockResolvedValue({ rows: [], rowCount: 0 });
    stubActualRole = "owner";
    stubWorkspaceOwnerId = "owner_123";
    stubAllowedPages = null;
  });

  it("adds a movement_type filter to the WHERE clause when provided", async () => {
    await request(app).get("/base-items/5/adjustments?movement_type=transfer_in");

    const [selectSql, selectParams] = mockDbQuery.mock.calls[1];
    expect(selectSql).toMatch(/movement_type/i);
    expect(selectParams).toContain("transfer_in");
  });

  it("adds a country filter to the WHERE clause when provided", async () => {
    await request(app).get("/base-items/5/adjustments?country=AE");

    const [selectSql, selectParams] = mockDbQuery.mock.calls[1];
    expect(selectSql).toMatch(/l\.country/i);
    expect(selectParams).toContain("AE");
  });

  it("adds a location_id filter to the WHERE clause when provided", async () => {
    await request(app).get("/base-items/5/adjustments?location_id=3");

    const [selectSql, selectParams] = mockDbQuery.mock.calls[1];
    expect(selectSql).toMatch(/a\.location_id/i);
    expect(selectParams).toContain(3);
  });

  it("adds a date_from filter to the WHERE clause when provided", async () => {
    await request(app).get("/base-items/5/adjustments?date_from=2026-01-01");

    const [selectSql, selectParams] = mockDbQuery.mock.calls[1];
    expect(selectSql).toMatch(/created_at\s*>=/i);
    expect(selectParams).toContain("2026-01-01");
  });

  it("adds a date_to filter to the WHERE clause when provided", async () => {
    await request(app).get("/base-items/5/adjustments?date_to=2026-06-30");

    const [selectSql, selectParams] = mockDbQuery.mock.calls[1];
    expect(selectSql).toMatch(/created_at\s*</i);
    expect(selectParams).toContain("2026-06-30");
  });

  it("includes all five filters when all filter params are provided", async () => {
    await request(app).get(
      "/base-items/5/adjustments?movement_type=transfer_out&country=AE&location_id=2&date_from=2026-01-01&date_to=2026-06-30",
    );

    const [selectSql, selectParams] = mockDbQuery.mock.calls[1];
    expect(selectSql).toMatch(/movement_type/i);
    expect(selectSql).toMatch(/l\.country/i);
    expect(selectSql).toMatch(/a\.location_id/i);
    expect(selectSql).toMatch(/created_at\s*>=/i);
    expect(selectSql).toMatch(/created_at\s*</i);
    expect(selectParams).toContain("transfer_out");
    expect(selectParams).toContain("AE");
    expect(selectParams).toContain(2);
    expect(selectParams).toContain("2026-01-01");
    expect(selectParams).toContain("2026-06-30");
  });

  it("omits all filter clauses when no query params are provided", async () => {
    await request(app).get("/base-items/5/adjustments");

    const [selectSql] = mockDbQuery.mock.calls[1];
    expect(selectSql).not.toMatch(/movement_type\s*=/i);
    expect(selectSql).not.toMatch(/l\.country\s*=/i);
    expect(selectSql).not.toMatch(/a\.location_id\s*=/i);
    expect(selectSql).not.toMatch(/created_at\s*>=/i);
    expect(selectSql).not.toMatch(/created_at\s*</i);
  });

  it("includes transfer_id and linked location names in the SELECT", async () => {
    await request(app).get("/base-items/5/adjustments");

    const [selectSql] = mockDbQuery.mock.calls[1];
    expect(selectSql).toMatch(/base_item_stock_transfers/i);
    expect(selectSql).toMatch(/from_location_name/i);
    expect(selectSql).toMatch(/to_location_name/i);
  });

  it("computes stock_before from stock_after minus quantity_change", async () => {
    const adjustmentRow = {
      id: 1, workspace_owner_id: "owner_123", base_item_id: 5,
      quantity_change: "10", reason: "receive", movement_type: null, note: null,
      stock_after: "30", created_by_user_id: null, created_at: "2026-01-01T00:00:00Z",
      location_id: 1, location_name: "Main Warehouse", country: "AE",
      transfer_id: null, from_location_id: null, from_location_name: null,
      to_location_id: null, to_location_name: null,
      purchase_order_id: null, po_number_label: null,
    };

    mockDbQuery.mockReset();
    mockDbQuery
      .mockResolvedValueOnce({ rows: [{ id: 5 }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [adjustmentRow], rowCount: 1 });

    const res = await request(app).get("/base-items/5/adjustments");

    expect(res.status).toBe(200);
    expect(res.body.adjustments[0].stock_before).toBe(20); // 30 - 10
    expect(res.body.adjustments[0].stock_after).toBe(30);
    expect(res.body.adjustments[0].quantity_change).toBe(10);
  });
});

// ---------------------------------------------------------------------------
// POST /base-items/:id/adjustments — movement_type field coverage
// ---------------------------------------------------------------------------

describe("POST /base-items/:id/adjustments — movement_type field", () => {
  const app = makeApp();

  const locationRow = { location_id: 1, stock: "20", location_name: "Main Warehouse" };
  const baseInsertedRow = {
    id: 100, workspace_owner_id: "owner_123", base_item_id: 5,
    quantity_change: "10", reason: "receive", movement_type: null, note: null,
    stock_after: "30", created_by_user_id: null, created_at: "2026-01-01T00:00:00Z",
    location_id: 1, transfer_id: null, purchase_order_id: null, po_number_label: null,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockDbQuery.mockReset();
    mockDbQuery.mockResolvedValue({ rows: [], rowCount: 0 });
    mockClientQuery.mockReset();
    mockClientQuery.mockResolvedValue({ rows: [], rowCount: 0 });
    stubActualRole = "owner";
    stubWorkspaceOwnerId = "owner_123";
    stubAllowedPages = null;
  });

  it("passes movement_type to the INSERT when provided", async () => {
    const insertedRow = { ...baseInsertedRow, movement_type: "manual_adjustment" };
    mockDbQuery
      .mockResolvedValueOnce({ rows: [{ id: 5, stock: "20" }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [locationRow], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [{ stock: "30" }], rowCount: 1 });  // SELECT total stock

    mockClientQuery
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })                             // BEGIN
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })                             // advisory lock
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })                             // idempotency (not dup)
      .mockResolvedValueOnce({ rows: [{ stock: "20" }], rowCount: 1 })               // postMovement SELECT FOR UPDATE
      .mockResolvedValueOnce({ rows: [{ id: 100 }], rowCount: 1 })                   // postMovement INSERT adj
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })                              // postMovement UPDATE location
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })                              // postMovement UPDATE base_items
      .mockResolvedValueOnce({ rows: [insertedRow], rowCount: 1 })                   // SELECT inserted row
      .mockResolvedValueOnce({ rows: [], rowCount: 0 });                             // COMMIT

    const res = await request(app)
      .post("/base-items/5/adjustments")
      .send({
        location_id: 1,
        quantity_change: 10,
        reason: "receive",
        movement_type: "manual_in",
        adjustment_action_id: ADJUSTMENT_ACTION_ID,
      });

    expect(res.status).toBe(201);
    // postMovement INSERT adj is at client call index 3; movementType is param index 5 (0-based)
    const insertCall = mockClientQuery.mock.calls[4];
    expect(insertCall[1]).toContain("manual_adjustment");
  });

  it("passes manual_adjustment as default movement_type when not provided", async () => {
    mockDbQuery
      .mockResolvedValueOnce({ rows: [{ id: 5, stock: "20" }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [locationRow], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [{ stock: "30" }], rowCount: 1 });  // SELECT total stock

    mockClientQuery
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })                             // BEGIN
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })                             // advisory lock
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })                             // idempotency (not dup)
      .mockResolvedValueOnce({ rows: [{ stock: "20" }], rowCount: 1 })               // postMovement SELECT FOR UPDATE
      .mockResolvedValueOnce({ rows: [{ id: 100 }], rowCount: 1 })                   // postMovement INSERT adj
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })                              // postMovement UPDATE location
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })                              // postMovement UPDATE base_items
      .mockResolvedValueOnce({ rows: [baseInsertedRow], rowCount: 1 })               // SELECT inserted row
      .mockResolvedValueOnce({ rows: [], rowCount: 0 });                             // COMMIT

    await request(app)
      .post("/base-items/5/adjustments")
      .send({ location_id: 1, quantity_change: 10, reason: "receive", adjustment_action_id: ADJUSTMENT_ACTION_ID });

    // Route defaults trimmedMovementType ?? "manual_adjustment"; movementType is param index 5
    const insertCall = mockClientQuery.mock.calls[4];
    const movementTypeParam = insertCall[1][5];
    expect(movementTypeParam).toBe("manual_adjustment");
  });

  it("trims whitespace from movement_type and defaults to manual_adjustment when whitespace-only", async () => {
    mockDbQuery
      .mockResolvedValueOnce({ rows: [{ id: 5, stock: "20" }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [locationRow], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [{ stock: "30" }], rowCount: 1 });  // SELECT total stock

    mockClientQuery
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })                             // BEGIN
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })                             // advisory lock
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })                             // idempotency (not dup)
      .mockResolvedValueOnce({ rows: [{ stock: "20" }], rowCount: 1 })               // postMovement SELECT FOR UPDATE
      .mockResolvedValueOnce({ rows: [{ id: 100 }], rowCount: 1 })                   // postMovement INSERT adj
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })                              // postMovement UPDATE location
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })                              // postMovement UPDATE base_items
      .mockResolvedValueOnce({ rows: [baseInsertedRow], rowCount: 1 })               // SELECT inserted row
      .mockResolvedValueOnce({ rows: [], rowCount: 0 });                             // COMMIT

    await request(app)
      .post("/base-items/5/adjustments")
      .send({
        location_id: 1,
        quantity_change: 10,
        reason: "receive",
        movement_type: "   ",
        adjustment_action_id: ADJUSTMENT_ACTION_ID,
      });

    // trimmedMovementType = null → "manual_adjustment" default; movementType is param index 5
    const insertCall = mockClientQuery.mock.calls[4];
    const movementTypeParam = insertCall[1][5];
    expect(movementTypeParam).toBe("manual_adjustment");
  });
});

// ---------------------------------------------------------------------------
// fireAndForgetLowStockAlert — focused tests
// Driven through POST /base-items/:id/adjustments to exercise the full path.
// DB call layout per test:
//   1  SELECT id, stock FROM base_items             (item exists check)
//   2  SELECT bils.stock …                          (location stock lookup)
//   3  INSERT … ON CONFLICT … SET stock             (update loc stock)
//   4  SELECT COALESCE(SUM(stock)…)                 (total stock)
//   5  UPDATE base_items SET stock                  (write total)
//   6  INSERT INTO base_item_stock_adjustments …    (record adjustment)
//   7  SELECT name FROM base_items                  (helper: item name)
//   8  SELECT l.name, country, loc_threshold …      (helper: loc + threshold)
//   9  SELECT default_low_stock_threshold …         (helper: country threshold)
//  10  INSERT INTO low_stock_alert_notifications …  (helper: atomic dedup)
//  11  SELECT DISTINCT wm.member_email …            (helper: recipients)
// ---------------------------------------------------------------------------
describe("fireAndForgetLowStockAlert — crossing semantics, dedup, and recipient targeting", () => {
  const app = makeApp();

  const adjInsertRow = {
    id: 100, workspace_owner_id: "owner_123", base_item_id: 5,
    quantity_change: "-17", reason: "adjustment", note: null,
    stock_after: "3", created_by_user_id: null,
    created_at: "2026-01-01T00:00:00Z", location_id: 1, movement_type: null,
  };

  function mockRouteCalls(stockBefore: number, stockAfter: number) {
    // Use stockAfter for stock_after so the route computes locationStockAfter correctly
    const insertedRowForCall = { ...adjInsertRow, stock_after: String(stockAfter) };
    mockDbQuery
      .mockResolvedValueOnce({ rows: [{ id: 5, stock: String(stockBefore) }], rowCount: 1 })  // item
      .mockResolvedValueOnce({ rows: [{ location_id: 1, stock: String(stockBefore), location_name: "WH1" }], rowCount: 1 })  // location
      .mockResolvedValueOnce({ rows: [{ stock: String(stockAfter) }], rowCount: 1 });  // SELECT total stock

    mockClientQuery
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })                                        // BEGIN
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })                                        // advisory lock
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })                                        // idempotency (not dup)
      .mockResolvedValueOnce({ rows: [{ stock: String(stockBefore) }], rowCount: 1 })          // postMovement SELECT FOR UPDATE
      .mockResolvedValueOnce({ rows: [{ id: 100 }], rowCount: 1 })                             // postMovement INSERT adj
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })                                        // postMovement UPDATE location
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })                                        // postMovement UPDATE base_items
      .mockResolvedValueOnce({ rows: [insertedRowForCall], rowCount: 1 })                      // SELECT inserted row
      .mockResolvedValueOnce({ rows: [], rowCount: 0 });                                       // COMMIT
  }

  const helperItemRow = { rows: [{ name: "Widget A" }], rowCount: 1 };
  const helperLocRow = { rows: [{ location_name: "WH1", country: "AE", loc_threshold: "5" }], rowCount: 1 };
  const helperNoCountryThreshold = { rows: [], rowCount: 0 };
  const helperDedupNewRow = { rows: [{ id: 1 }], rowCount: 1 };
  const helperDedupSuppressed = { rows: [], rowCount: 0 };

  beforeEach(() => {
    vi.clearAllMocks();
    mockDbQuery.mockReset();
    mockDbQuery.mockResolvedValue({ rows: [], rowCount: 0 });
    mockClientQuery.mockReset();
    mockClientQuery.mockResolvedValue({ rows: [], rowCount: 0 });
    mockSendLowStockAlertEmail.mockResolvedValue(undefined);
    stubWorkspaceOwnerId = "owner_123";
    stubActualRole = "owner";
    stubAllowedPages = null;
  });

  it("fires alert when stock crosses from above to at/below threshold", async () => {
    mockRouteCalls(20, 3);
    mockDbQuery
      .mockResolvedValueOnce(helperItemRow)          // 7
      .mockResolvedValueOnce(helperLocRow)            // 8
      .mockResolvedValueOnce(helperNoCountryThreshold) // 9
      .mockResolvedValueOnce(helperDedupNewRow)       // 10: dedup INSERT succeeds → proceed
      .mockResolvedValueOnce({ rows: [{ member_email: "owner@example.com" }], rowCount: 1 }); // 11

    await request(app)
      .post("/base-items/5/adjustments")
      .send({ location_id: 1, quantity_change: -17, reason: "correction", adjustment_action_id: ADJUSTMENT_ACTION_ID });

    await vi.waitFor(() => expect(mockSendLowStockAlertEmail).toHaveBeenCalledOnce());
    expect(mockSendLowStockAlertEmail).toHaveBeenCalledWith(
      expect.objectContaining({
        toEmail: "owner@example.com",
        itemName: "Widget A",
        locationName: "WH1",
        currentStock: 3,
        effectiveThreshold: 5,
        deficit: 2,
      }),
    );
  });

  it("does not fire when stock stays above threshold after the adjustment", async () => {
    // stockBefore=20, stockAfter=15, threshold=5 → 15 > 5 → no crossing
    mockRouteCalls(20, 15);
    mockDbQuery
      .mockResolvedValueOnce(helperItemRow)            // 4
      .mockResolvedValueOnce(helperLocRow)             // 5
      .mockResolvedValueOnce(helperNoCountryThreshold); // 6 → exits after crossing check

    await request(app)
      .post("/base-items/5/adjustments")
      .send({ location_id: 1, quantity_change: -5, reason: "correction", adjustment_action_id: ADJUSTMENT_ACTION_ID });

    await vi.waitFor(() => expect(mockDbQuery).toHaveBeenCalledTimes(6));
    expect(mockSendLowStockAlertEmail).not.toHaveBeenCalled();
  });

  it("does not fire when stock was already below threshold before the adjustment (no fresh crossing)", async () => {
    // stockBefore=3, stockAfter=2, threshold=5 → 3 > 5 is false → no crossing
    mockRouteCalls(3, 2);
    mockDbQuery
      .mockResolvedValueOnce(helperItemRow)            // 4
      .mockResolvedValueOnce(helperLocRow)             // 5
      .mockResolvedValueOnce(helperNoCountryThreshold); // 6 → exits after crossing check

    await request(app)
      .post("/base-items/5/adjustments")
      .send({ location_id: 1, quantity_change: -1, reason: "correction", adjustment_action_id: ADJUSTMENT_ACTION_ID });

    await vi.waitFor(() => expect(mockDbQuery).toHaveBeenCalledTimes(6));
    expect(mockSendLowStockAlertEmail).not.toHaveBeenCalled();
  });

  it("suppresses alert when dedup upsert returns no rows (within 24-hour window)", async () => {
    // Crossing is detected but the atomic INSERT returns 0 rows → already sent recently → skip
    mockRouteCalls(20, 3);
    mockDbQuery
      .mockResolvedValueOnce(helperItemRow)             // 4
      .mockResolvedValueOnce(helperLocRow)              // 5
      .mockResolvedValueOnce(helperNoCountryThreshold)  // 6
      .mockResolvedValueOnce(helperDedupSuppressed);    // 7: ON CONFLICT → row still fresh → RETURNING empty

    await request(app)
      .post("/base-items/5/adjustments")
      .send({ location_id: 1, quantity_change: -17, reason: "correction", adjustment_action_id: ADJUSTMENT_ACTION_ID });

    await vi.waitFor(() => expect(mockDbQuery).toHaveBeenCalledTimes(7));
    expect(mockSendLowStockAlertEmail).not.toHaveBeenCalled();
  });

  it("sends email to owners and base_items.manage members, not plain members", async () => {
    mockRouteCalls(20, 3);
    mockDbQuery
      .mockResolvedValueOnce(helperItemRow)            // 4
      .mockResolvedValueOnce(helperLocRow)             // 5
      .mockResolvedValueOnce(helperNoCountryThreshold) // 6
      .mockResolvedValueOnce(helperDedupNewRow)        // 7
      .mockResolvedValueOnce({                         // 8: two recipients
        rows: [
          { member_email: "owner@example.com" },
          { member_email: "manager@example.com" },
        ],
        rowCount: 2,
      });

    await request(app)
      .post("/base-items/5/adjustments")
      .send({ location_id: 1, quantity_change: -17, reason: "correction", adjustment_action_id: ADJUSTMENT_ACTION_ID });

    await vi.waitFor(() => expect(mockSendLowStockAlertEmail).toHaveBeenCalledTimes(2));
    const sentTo = mockSendLowStockAlertEmail.mock.calls.map((c) => (c[0] as { toEmail: string }).toEmail);
    expect(sentTo).toContain("owner@example.com");
    expect(sentTo).toContain("manager@example.com");

    const recipientsSql = (mockDbQuery.mock.calls[7] as [string])[0];
    expect(recipientsSql).toMatch(/wm\.role = 'owner'/);
    expect(recipientsSql).toMatch(/base_items\.manage/);
    expect(recipientsSql).toMatch(/joined_at IS NOT NULL/);
  });
});

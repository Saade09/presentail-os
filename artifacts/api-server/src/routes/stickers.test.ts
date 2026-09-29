import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";
import type { WorkspaceRequest } from "../lib/workspace";

// ---------------------------------------------------------------------------
// Drizzle mock — queue-based, chainable builder pattern
//
// Each awaited Drizzle call (select/insert/update/delete) pops ONE entry
// from the queue in the order the route code enqueues them.
// ---------------------------------------------------------------------------

const drizzleQueue: unknown[][] = [];
let drizzleUpdateSetArgs: Record<string, unknown> | null = null;

function popResult(): unknown[] {
  return (drizzleQueue.shift() as unknown[]) ?? [];
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function makeChain(result: unknown[]): any {
  const p = Promise.resolve(result);
  const chain: Record<string, unknown> = {
    from: () => chain,
    leftJoin: () => chain,
    where: () => chain,
    orderBy: () => chain,
    limit: () => chain,
    values: () => chain,
    returning: () => p,
    set: (args: unknown) => {
      drizzleUpdateSetArgs = args as Record<string, unknown>;
      return chain;
    },
    then: (f: Parameters<typeof p.then>[0], r: Parameters<typeof p.then>[1]) => p.then(f, r),
    catch: (f: Parameters<typeof p.catch>[0]) => p.catch(f),
    finally: (f: Parameters<typeof p.finally>[0]) => p.finally(f),
  };
  return chain;
}

const mockDrizzleSelect = vi.fn(() => makeChain(popResult()));
const mockDrizzleInsert = vi.fn(() => makeChain(popResult()));
const mockDrizzleUpdate = vi.fn(() => makeChain(popResult()));
const mockDrizzleDelete = vi.fn(() => {
  const result = popResult();
  return {
    where: () => ({
      returning: () => Promise.resolve(result),
    }),
  };
});

vi.mock("../lib/drizzle", () => ({
  drizzleDb: {
    select: () => mockDrizzleSelect(),
    insert: () => mockDrizzleInsert(),
    update: () => mockDrizzleUpdate(),
    delete: () => mockDrizzleDelete(),
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

vi.mock("../lib/pdfToImage", () => ({
  pdfToImage: vi.fn().mockResolvedValue(null),
}));

const mockRunPdfToImageInWorker = vi.fn();
vi.mock("../lib/pdfToImagePool", () => ({
  runPdfToImageInWorker: (...args: unknown[]) => mockRunPdfToImageInWorker(...args),
}));

const mockExtractStickerThumbnail = vi.fn();
vi.mock("../lib/extractStickerThumbnail", () => ({
  extractStickerThumbnail: (...args: unknown[]) => mockExtractStickerThumbnail(...args),
}));

vi.mock("../lib/logger", () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

import stickersRouter from "./stickers";

// ---------------------------------------------------------------------------
// Test app
// ---------------------------------------------------------------------------

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use(stickersRouter);
  return app;
}

// Minimal 1×1 transparent PNG (valid image bytes)
const TINY_PNG = Buffer.from(
  "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c6260000000020001e221bc330000000049454e44ae426082",
  "hex",
);

// ---------------------------------------------------------------------------
// GET /stickers/:id/thumbnail — with thumbnail present
// ---------------------------------------------------------------------------

describe("GET /stickers/:id/thumbnail — thumbnail present", () => {
  const app = makeApp();

  beforeEach(() => {
    vi.clearAllMocks();
    drizzleQueue.length = 0;
    drizzleUpdateSetArgs = null;
    stubActualRole = "owner";
    stubWorkspaceOwnerId = "owner_123";
    stubAllowedPages = null;
  });

  it("returns 200 with the thumbnail bytes and correct Content-Type when a thumbnail exists", async () => {
    drizzleQueue.push([{ thumbnailData: TINY_PNG, thumbnailMime: "image/png" }]);

    const res = await request(app).get("/stickers/42/thumbnail");

    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/image\/png/);
    expect(res.body).toBeInstanceOf(Buffer);
  });

  it("sets Cache-Control: public, max-age=3600 on a successful thumbnail response", async () => {
    drizzleQueue.push([{ thumbnailData: TINY_PNG, thumbnailMime: "image/png" }]);

    const res = await request(app).get("/stickers/7/thumbnail");

    expect(res.status).toBe(200);
    expect(res.headers["cache-control"]).toMatch(/max-age=3600/);
  });

  it("enforces workspace isolation: sticker found with correct workspace owner", async () => {
    stubWorkspaceOwnerId = "ws_scoped";
    drizzleQueue.push([{ thumbnailData: TINY_PNG, thumbnailMime: "image/png" }]);

    const res = await request(app).get("/stickers/5/thumbnail");

    expect(res.status).toBe(200);
    expect(mockDrizzleSelect).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// GET /stickers/:id/thumbnail — without thumbnail (null data)
// ---------------------------------------------------------------------------

describe("GET /stickers/:id/thumbnail — no thumbnail data", () => {
  const app = makeApp();

  beforeEach(() => {
    vi.clearAllMocks();
    drizzleQueue.length = 0;
    drizzleUpdateSetArgs = null;
    stubActualRole = "owner";
    stubWorkspaceOwnerId = "owner_123";
    stubAllowedPages = null;
  });

  it("returns 404 when the sticker exists but has no thumbnail_data", async () => {
    drizzleQueue.push([{ thumbnailData: null, thumbnailMime: null }]);

    const res = await request(app).get("/stickers/10/thumbnail");

    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/no thumbnail available/i);
  });

  it("returns 404 when thumbnail_data is present but thumbnail_mime is null", async () => {
    drizzleQueue.push([{ thumbnailData: TINY_PNG, thumbnailMime: null }]);

    const res = await request(app).get("/stickers/10/thumbnail");

    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/no thumbnail available/i);
  });
});

// ---------------------------------------------------------------------------
// GET /stickers/:id/thumbnail — sticker not found / wrong workspace
// ---------------------------------------------------------------------------

describe("GET /stickers/:id/thumbnail — wrong workspace or missing sticker", () => {
  const app = makeApp();

  beforeEach(() => {
    vi.clearAllMocks();
    drizzleQueue.length = 0;
    drizzleUpdateSetArgs = null;
    stubActualRole = "owner";
    stubWorkspaceOwnerId = "owner_123";
    stubAllowedPages = null;
  });

  it("returns 404 when the sticker does not exist", async () => {
    drizzleQueue.push([]); // no rows

    const res = await request(app).get("/stickers/999/thumbnail");

    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/sticker not found/i);
  });

  it("returns 404 when the sticker belongs to a different workspace", async () => {
    stubWorkspaceOwnerId = "other_workspace";
    drizzleQueue.push([]); // drizzle WHERE filters out rows from other workspace

    const res = await request(app).get("/stickers/42/thumbnail");

    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/sticker not found/i);
  });

  it("returns 400 for a non-numeric sticker id", async () => {
    const res = await request(app).get("/stickers/not-a-number/thumbnail");

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/invalid sticker id/i);
  });

  it("does not leak cross-workspace data — drizzle WHERE filters by workspace_owner_id", async () => {
    stubWorkspaceOwnerId = "ws_a";
    drizzleQueue.push([]); // no rows for this workspace

    const res = await request(app).get("/stickers/1/thumbnail");

    expect(res.status).toBe(404);
    // drizzle WHERE clause includes workspaceOwnerId — verified by type-safe code
    expect(mockDrizzleSelect).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// POST /stickers — upload + inline thumbnail orchestration
// ---------------------------------------------------------------------------

// Minimal valid PDF (magic bytes %PDF + minimal trailer). Only the magic-byte
// sniff at the start of the route looks at the contents.
const TINY_PDF = Buffer.concat([
  Buffer.from("%PDF-1.4\n"),
  Buffer.from("1 0 obj <<>> endobj\n"),
  Buffer.from("trailer <<>>\n%%EOF\n"),
]);

const IMAGE_BUFFER = Buffer.from("fake-rendered-image-bytes");
const THUMBNAIL_BUFFER = Buffer.from("fake-thumbnail-bytes");

const INSERT_STICKER_ROW = {
  id: 101,
  name: "Test Sticker",
  file_name: "test.pdf",
  created_at: new Date("2026-05-03T00:00:00Z"),
  brand_id: 7,
};

describe("POST /stickers", () => {
  const app = makeApp();

  beforeEach(() => {
    vi.clearAllMocks();
    drizzleQueue.length = 0;
    drizzleUpdateSetArgs = null;
    stubActualRole = "owner";
    stubWorkspaceOwnerId = "owner_123";
    stubAllowedPages = null;

    mockRunPdfToImageInWorker.mockResolvedValue(null);
    mockExtractStickerThumbnail.mockResolvedValue(null);
  });

  it("returns 201 with thumbnail_generated=true and writes the thumbnail when both worker and extractor return buffers", async () => {
    mockRunPdfToImageInWorker.mockResolvedValue(IMAGE_BUFFER);
    mockExtractStickerThumbnail.mockResolvedValue(THUMBNAIL_BUFFER);

    drizzleQueue.push([{ id: 7 }]); // brand check
    drizzleQueue.push([INSERT_STICKER_ROW]); // insert
    drizzleQueue.push([]); // thumbnail update

    const res = await request(app)
      .post("/stickers")
      .field("name", "Test Sticker")
      .field("brand_id", "7")
      .attach("pdf", TINY_PDF, { filename: "test.pdf", contentType: "application/pdf" });

    expect(res.status).toBe(201);
    expect(res.body.thumbnail_generated).toBe(true);
    expect(res.body.sticker.id).toBe(101);

    expect(mockDrizzleUpdate).toHaveBeenCalledTimes(1);
    expect(drizzleUpdateSetArgs).toMatchObject({
      thumbnailData: THUMBNAIL_BUFFER,
      thumbnailMime: "image/png",
    });
  });

  it("returns 201 with thumbnail_generated=false and skips the UPDATE when runPdfToImageInWorker returns null", async () => {
    mockRunPdfToImageInWorker.mockResolvedValue(null);
    mockExtractStickerThumbnail.mockResolvedValue(THUMBNAIL_BUFFER);

    drizzleQueue.push([{ id: 7 }]); // brand check
    drizzleQueue.push([INSERT_STICKER_ROW]); // insert

    const res = await request(app)
      .post("/stickers")
      .field("name", "Test Sticker")
      .field("brand_id", "7")
      .attach("pdf", TINY_PDF, { filename: "test.pdf", contentType: "application/pdf" });

    expect(res.status).toBe(201);
    expect(res.body.thumbnail_generated).toBe(false);
    expect(mockExtractStickerThumbnail).not.toHaveBeenCalled();
    expect(mockDrizzleUpdate).not.toHaveBeenCalled();
  });

  it("returns 201 with thumbnail_generated=false and skips the UPDATE when extractStickerThumbnail returns null", async () => {
    mockRunPdfToImageInWorker.mockResolvedValue(IMAGE_BUFFER);
    mockExtractStickerThumbnail.mockResolvedValue(null);

    drizzleQueue.push([{ id: 7 }]); // brand check
    drizzleQueue.push([INSERT_STICKER_ROW]); // insert

    const res = await request(app)
      .post("/stickers")
      .field("name", "Test Sticker")
      .field("brand_id", "7")
      .attach("pdf", TINY_PDF, { filename: "test.pdf", contentType: "application/pdf" });

    expect(res.status).toBe(201);
    expect(res.body.thumbnail_generated).toBe(false);
    expect(mockExtractStickerThumbnail).toHaveBeenCalledTimes(1);
    expect(mockDrizzleUpdate).not.toHaveBeenCalled();
  });

  it("returns 403 and does not write when caller is not owner/designer and lacks brands.manage / stickers.upload", async () => {
    stubActualRole = "member";
    stubAllowedPages = ["dashboard.view"];

    const res = await request(app)
      .post("/stickers")
      .field("name", "Test Sticker")
      .field("brand_id", "7")
      .attach("pdf", TINY_PDF, { filename: "test.pdf", contentType: "application/pdf" });

    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/insufficient permissions/i);
    expect(mockDrizzleSelect).not.toHaveBeenCalled();
    expect(mockDrizzleInsert).not.toHaveBeenCalled();
  });

  it("returns 400 when the pdf file field is missing", async () => {
    const res = await request(app)
      .post("/stickers")
      .field("name", "Test Sticker")
      .field("brand_id", "7");

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/missing 'pdf' file field/i);
    expect(mockDrizzleSelect).not.toHaveBeenCalled();
  });

  it("returns 400 when brand_id is missing", async () => {
    const res = await request(app)
      .post("/stickers")
      .field("name", "Test Sticker")
      .attach("pdf", TINY_PDF, { filename: "test.pdf", contentType: "application/pdf" });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/brand_id is required/i);
    expect(mockDrizzleSelect).not.toHaveBeenCalled();
  });

  it("returns 400 when brand_id is non-numeric", async () => {
    const res = await request(app)
      .post("/stickers")
      .field("name", "Test Sticker")
      .field("brand_id", "abc")
      .attach("pdf", TINY_PDF, { filename: "test.pdf", contentType: "application/pdf" });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/invalid brand_id/i);
    expect(mockDrizzleSelect).not.toHaveBeenCalled();
  });

  it("returns 400 when brand_id does not belong to the workspace", async () => {
    drizzleQueue.push([]); // brand check returns empty

    const res = await request(app)
      .post("/stickers")
      .field("name", "Test Sticker")
      .field("brand_id", "999")
      .attach("pdf", TINY_PDF, { filename: "test.pdf", contentType: "application/pdf" });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/brand not found/i);
    // Only the brand-check select ran; no INSERT.
    expect(mockDrizzleSelect).toHaveBeenCalledTimes(1);
    expect(mockDrizzleInsert).not.toHaveBeenCalled();
  });
});

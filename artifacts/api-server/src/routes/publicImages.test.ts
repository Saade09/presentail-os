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

// Configurable: return a valid owner ID or null to simulate missing/invalid token
let stubOwnerId: string | null = "owner_123";

vi.mock("../lib/imageSign", () => ({
  COOKIE_NAME: "ws_img",
  verifyWorkspaceToken: () => stubOwnerId,
}));

vi.mock("../lib/logger", () => ({
  logger: { error: vi.fn(), info: vi.fn(), warn: vi.fn() },
}));

// vi.hoisted ensures these are available inside the vi.mock factory (which is hoisted)
const { mockGetObjectEntityFile, mockDownloadObject, mockSearchPublicObject } = vi.hoisted(() => ({
  mockGetObjectEntityFile: vi.fn(),
  mockDownloadObject: vi.fn(),
  mockSearchPublicObject: vi.fn(),
}));

vi.mock("../lib/objectStorage", () => {
  class ObjectNotFoundError extends Error {
    constructor() {
      super("Object not found");
      this.name = "ObjectNotFoundError";
      Object.setPrototypeOf(this, ObjectNotFoundError.prototype);
    }
  }

  class ObjectStorageService {
    getObjectEntityFile(...args: unknown[]) {
      return mockGetObjectEntityFile(...args);
    }
    downloadObject(...args: unknown[]) {
      return mockDownloadObject(...args);
    }
    searchPublicObject(...args: unknown[]) {
      return mockSearchPublicObject(...args);
    }
  }

  return { ObjectStorageService, ObjectNotFoundError };
});

import { ObjectNotFoundError } from "../lib/objectStorage";
import publicImagesRouter from "./publicImages";

// ---------------------------------------------------------------------------
// Test app — no Clerk auth, no workspace middleware (publicImages uses its own cookie)
// ---------------------------------------------------------------------------

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as { log?: unknown }).log = { error: vi.fn(), info: vi.fn(), warn: vi.fn() };
    next();
  });
  app.use(publicImagesRouter);
  return app;
}

// Minimal 1×1 PNG binary
const TINY_PNG = Buffer.from(
  "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c6260000000020001e221bc330000000049454e44ae426082",
  "hex",
);

// ---------------------------------------------------------------------------
// Shared beforeEach
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks();
  stubOwnerId = "owner_123";
  mockDbQuery.mockResolvedValue({ rows: [], rowCount: 0 });
});

// ---------------------------------------------------------------------------
// GET /brands/:id/logo
// ---------------------------------------------------------------------------

describe("GET /brands/:id/logo", () => {
  const app = makeApp();

  it("returns 401 when no valid image cookie is present (no Clerk session needed)", async () => {
    stubOwnerId = null;
    const res = await request(app).get("/brands/1/logo");
    expect(res.status).toBe(401);
  });

  it("returns 200 with logo bytes and Content-Type when logo exists", async () => {
    mockDbQuery.mockResolvedValueOnce({
      rows: [{ logo_data: TINY_PNG, logo_mime: "image/png" }],
      rowCount: 1,
    });

    const res = await request(app).get("/brands/1/logo");

    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/image\/png/);
    expect(res.body).toBeInstanceOf(Buffer);
  });

  it("returns 404 when no logo exists for the brand", async () => {
    mockDbQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const res = await request(app).get("/brands/1/logo");

    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/no logo found/i);
  });

  it("returns 400 for a non-numeric brand id", async () => {
    const res = await request(app).get("/brands/abc/logo");
    expect(res.status).toBe(400);
  });

  it("queries using the resolved owner id from the image token", async () => {
    stubOwnerId = "owner_xyz";
    mockDbQuery.mockResolvedValueOnce({
      rows: [{ logo_data: TINY_PNG, logo_mime: "image/png" }],
      rowCount: 1,
    });

    await request(app).get("/brands/7/logo");

    expect(mockDbQuery).toHaveBeenCalledOnce();
    const [, params] = mockDbQuery.mock.calls[0] as [string, unknown[]];
    expect(params).toContain("owner_xyz");
    expect(params).toContain(7);
  });
});

// ---------------------------------------------------------------------------
// GET /brands/:id/logos/:logoId/image
// ---------------------------------------------------------------------------

describe("GET /brands/:id/logos/:logoId/image", () => {
  const app = makeApp();

  it("returns 401 when no valid image cookie is present", async () => {
    stubOwnerId = null;
    const res = await request(app).get("/brands/1/logos/2/image");
    expect(res.status).toBe(401);
  });

  it("returns 200 with logo bytes when logo exists", async () => {
    mockDbQuery.mockResolvedValueOnce({
      rows: [{ logo_data: TINY_PNG, logo_mime: "image/png" }],
      rowCount: 1,
    });

    const res = await request(app).get("/brands/1/logos/2/image");

    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/image\/png/);
  });

  it("returns 404 when the specific logo is not found", async () => {
    mockDbQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const res = await request(app).get("/brands/1/logos/99/image");

    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/logo not found/i);
  });

  it("returns 400 for a non-numeric brand or logo id", async () => {
    const res1 = await request(app).get("/brands/abc/logos/2/image");
    const res2 = await request(app).get("/brands/1/logos/abc/image");
    expect(res1.status).toBe(400);
    expect(res2.status).toBe(400);
  });

  it("passes brand id, logo id, and owner id to the query", async () => {
    mockDbQuery.mockResolvedValueOnce({
      rows: [{ logo_data: TINY_PNG, logo_mime: "image/jpeg" }],
      rowCount: 1,
    });

    await request(app).get("/brands/3/logos/7/image");

    const [, params] = mockDbQuery.mock.calls[0] as [string, unknown[]];
    expect(params).toContain(3);
    expect(params).toContain(7);
    expect(params).toContain("owner_123");
  });
});

// ---------------------------------------------------------------------------
// GET /brands/:id/card-message
// ---------------------------------------------------------------------------

describe("GET /brands/:id/card-message", () => {
  const app = makeApp();

  it("returns 401 when no valid image cookie is present", async () => {
    stubOwnerId = null;
    const res = await request(app).get("/brands/1/card-message");
    expect(res.status).toBe(401);
  });

  it("returns 200 with card-message bytes when data exists", async () => {
    mockDbQuery.mockResolvedValueOnce({
      rows: [{ card_message_data: TINY_PNG, card_message_mime: "image/png" }],
      rowCount: 1,
    });

    const res = await request(app).get("/brands/1/card-message");

    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/image\/png/);
  });

  it("returns 404 when brand has no card message", async () => {
    mockDbQuery.mockResolvedValueOnce({
      rows: [{ card_message_data: null, card_message_mime: null }],
      rowCount: 1,
    });

    const res = await request(app).get("/brands/1/card-message");

    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/no card message found/i);
  });

  it("returns 404 when brand row is not found", async () => {
    mockDbQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const res = await request(app).get("/brands/5/card-message");

    expect(res.status).toBe(404);
  });

  it("returns 400 for a non-numeric brand id", async () => {
    const res = await request(app).get("/brands/abc/card-message");
    expect(res.status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// GET /brands/:id/cover-photos/:photoId/image
// ---------------------------------------------------------------------------

describe("GET /brands/:id/cover-photos/:photoId/image", () => {
  const app = makeApp();

  it("returns 401 when no valid image cookie is present", async () => {
    stubOwnerId = null;
    const res = await request(app).get("/brands/1/cover-photos/2/image");
    expect(res.status).toBe(401);
  });

  it("returns 200 with cover photo bytes when photo exists", async () => {
    mockDbQuery.mockResolvedValueOnce({
      rows: [{ photo_data: TINY_PNG, photo_mime: "image/jpeg" }],
      rowCount: 1,
    });

    const res = await request(app).get("/brands/1/cover-photos/2/image");

    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/image\/jpeg/);
  });

  it("returns 404 when cover photo is not found", async () => {
    mockDbQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const res = await request(app).get("/brands/1/cover-photos/99/image");

    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/cover photo not found/i);
  });

  it("returns 400 for non-numeric ids", async () => {
    const res1 = await request(app).get("/brands/abc/cover-photos/2/image");
    const res2 = await request(app).get("/brands/1/cover-photos/abc/image");
    expect(res1.status).toBe(400);
    expect(res2.status).toBe(400);
  });

  it("passes brand id, photo id, and owner id to the query", async () => {
    mockDbQuery.mockResolvedValueOnce({
      rows: [{ photo_data: TINY_PNG, photo_mime: "image/png" }],
      rowCount: 1,
    });

    await request(app).get("/brands/4/cover-photos/9/image");

    const [, params] = mockDbQuery.mock.calls[0] as [string, unknown[]];
    expect(params).toContain(4);
    expect(params).toContain(9);
    expect(params).toContain("owner_123");
  });
});

// ---------------------------------------------------------------------------
// GET /channels/:id/logo
// ---------------------------------------------------------------------------

describe("GET /channels/:id/logo", () => {
  const app = makeApp();

  it("returns 401 when no valid image cookie is present", async () => {
    stubOwnerId = null;
    const res = await request(app).get("/channels/1/logo");
    expect(res.status).toBe(401);
  });

  it("returns 200 with logo bytes when channel logo exists", async () => {
    mockDbQuery.mockResolvedValueOnce({
      rows: [{ logo_data: TINY_PNG, logo_mime_type: "image/png" }],
      rowCount: 1,
    });

    const res = await request(app).get("/channels/1/logo");

    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/image\/png/);
  });

  it("returns 404 when channel has no logo", async () => {
    mockDbQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const res = await request(app).get("/channels/1/logo");

    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/no logo found/i);
  });

  it("returns 400 for a non-numeric channel id", async () => {
    const res = await request(app).get("/channels/abc/logo");
    expect(res.status).toBe(400);
  });

  it("queries using the channel id and owner id", async () => {
    stubOwnerId = "owner_456";
    mockDbQuery.mockResolvedValueOnce({
      rows: [{ logo_data: TINY_PNG, logo_mime_type: "image/png" }],
      rowCount: 1,
    });

    await request(app).get("/channels/5/logo");

    const [, params] = mockDbQuery.mock.calls[0] as [string, unknown[]];
    expect(params).toContain(5);
    expect(params).toContain("owner_456");
  });
});

// ---------------------------------------------------------------------------
// GET /stickers/:id/thumbnail
// ---------------------------------------------------------------------------

describe("GET /stickers/:id/thumbnail", () => {
  const app = makeApp();

  it("returns 401 when no valid image cookie is present", async () => {
    stubOwnerId = null;
    const res = await request(app).get("/stickers/1/thumbnail");
    expect(res.status).toBe(401);
  });

  it("returns 200 with thumbnail bytes when thumbnail exists", async () => {
    mockDbQuery.mockResolvedValueOnce({
      rows: [{ thumbnail_data: TINY_PNG, thumbnail_mime: "image/png" }],
      rowCount: 1,
    });

    const res = await request(app).get("/stickers/1/thumbnail");

    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/image\/png/);
  });

  it("returns 404 when sticker is not found in the database", async () => {
    mockDbQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const res = await request(app).get("/stickers/99/thumbnail");

    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/sticker not found/i);
  });

  it("returns 404 when sticker row exists but has no thumbnail yet", async () => {
    mockDbQuery.mockResolvedValueOnce({
      rows: [{ thumbnail_data: null, thumbnail_mime: null }],
      rowCount: 1,
    });

    const res = await request(app).get("/stickers/1/thumbnail");

    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/no thumbnail available/i);
  });

  it("returns 400 for a non-numeric sticker id", async () => {
    const res = await request(app).get("/stickers/abc/thumbnail");
    expect(res.status).toBe(400);
  });

  it("queries using the sticker id and owner id", async () => {
    mockDbQuery.mockResolvedValueOnce({
      rows: [{ thumbnail_data: TINY_PNG, thumbnail_mime: "image/png" }],
      rowCount: 1,
    });

    await request(app).get("/stickers/3/thumbnail");

    const [, params] = mockDbQuery.mock.calls[0] as [string, unknown[]];
    expect(params).toContain(3);
    expect(params).toContain("owner_123");
  });
});

// ---------------------------------------------------------------------------
// GET /storage/objects/*
// ---------------------------------------------------------------------------

describe("GET /storage/objects/*", () => {
  const app = makeApp();

  it("returns 401 when no valid image cookie is present", async () => {
    stubOwnerId = null;
    const res = await request(app).get("/storage/objects/owner_123/image.png");
    expect(res.status).toBe(401);
  });

  it("returns 403 when the path owner segment does not match the token owner", async () => {
    stubOwnerId = "owner_123";
    const res = await request(app).get("/storage/objects/other_owner/image.png");
    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/access denied/i);
  });

  it("returns 200 and pipes the object when found", async () => {
    stubOwnerId = "owner_123";
    mockGetObjectEntityFile.mockResolvedValueOnce({ path: "/objects/owner_123/image.png" });
    mockDownloadObject.mockResolvedValueOnce({
      status: 200,
      headers: { forEach: vi.fn() },
      body: null,
    });

    const res = await request(app).get("/storage/objects/owner_123/image.png");

    expect(res.status).toBe(200);
    expect(mockGetObjectEntityFile).toHaveBeenCalledWith("/objects/owner_123/image.png");
  });

  it("preserves private cache headers for access-controlled objects", async () => {
    stubOwnerId = "owner_123";
    mockGetObjectEntityFile.mockResolvedValueOnce({ path: "/objects/owner_123/image.png" });
    mockDownloadObject.mockResolvedValueOnce({
      status: 200,
      headers: {
        forEach: (fn: (v: string, k: string) => void) =>
          fn("private, max-age=3600", "Cache-Control"),
      },
      body: null,
    });

    const res = await request(app).get("/storage/objects/owner_123/image.png");

    expect(res.headers["cache-control"]).toBe("private, max-age=3600");
    expect(res.headers["timing-allow-origin"]).toBeUndefined();
  });

  it("returns 404 when the object is not found in storage", async () => {
    stubOwnerId = "owner_123";
    mockGetObjectEntityFile.mockRejectedValueOnce(new ObjectNotFoundError());

    const res = await request(app).get("/storage/objects/owner_123/missing.png");

    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/object not found/i);
  });

  it("returns 500 when an unexpected storage error occurs", async () => {
    stubOwnerId = "owner_123";
    mockGetObjectEntityFile.mockRejectedValueOnce(new Error("Unexpected storage failure"));

    const res = await request(app).get("/storage/objects/owner_123/bad.png");

    expect(res.status).toBe(500);
    expect(res.body.error).toMatch(/failed to serve object/i);
  });

  it("enforces workspace isolation — the path's first segment must equal the token owner", async () => {
    stubOwnerId = "owner_A";
    const res = await request(app).get("/storage/objects/owner_B/file.png");
    expect(res.status).toBe(403);
    expect(mockGetObjectEntityFile).not.toHaveBeenCalled();
  });

  it("forwards the correct object path to the storage service", async () => {
    stubOwnerId = "owner_123";
    mockGetObjectEntityFile.mockResolvedValueOnce({});
    mockDownloadObject.mockResolvedValueOnce({
      status: 200,
      headers: { forEach: vi.fn() },
      body: null,
    });

    await request(app).get("/storage/objects/owner_123/sub/dir/photo.jpg");

    expect(mockGetObjectEntityFile).toHaveBeenCalledWith("/objects/owner_123/sub/dir/photo.jpg");
  });
});

// ---------------------------------------------------------------------------
// GET /storage/public-objects/* — unconditionally public, no auth required
// ---------------------------------------------------------------------------

describe("GET /storage/public-objects/*", () => {
  // Dedicated app with a req.log stub, since the public-objects handler logs on error.
  function makePublicApp() {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as { log?: unknown }).log = { error: vi.fn(), info: vi.fn(), warn: vi.fn() };
      next();
    });
    app.use(publicImagesRouter);
    return app;
  }

  const app = makePublicApp();

  it("returns 200 and the image bytes with NO auth header and NO apiKey", async () => {
    mockSearchPublicObject.mockResolvedValueOnce({ name: "products/1/main.jpg" });
    mockDownloadObject.mockResolvedValueOnce({
      status: 200,
      headers: { forEach: (fn: (v: string, k: string) => void) => fn("image/jpeg", "Content-Type") },
      body: null,
    });

    const res = await request(app).get("/storage/public-objects/products/1/main.jpg");

    expect(res.status).toBe(200);
    expect(res.status).not.toBe(401);
    expect(mockSearchPublicObject).toHaveBeenCalledWith("products/1/main.jpg");
  });

  it("sets a permissive CORS header so cross-origin fetch/canvas reads work", async () => {
    mockSearchPublicObject.mockResolvedValueOnce({ name: "products/1/main.jpg" });
    mockDownloadObject.mockResolvedValueOnce({
      status: 200,
      headers: { forEach: vi.fn() },
      body: null,
    });

    const res = await request(app).get("/storage/public-objects/products/1/main.jpg");

    expect(res.headers["access-control-allow-origin"]).toBe("*");
    expect(res.headers["access-control-allow-methods"]).toMatch(/GET/);
    expect(res.headers["timing-allow-origin"]).toBe("*");
  });

  it("serves replaceable public originals with moderate shared caching and stale revalidation", async () => {
    mockSearchPublicObject.mockResolvedValueOnce({ name: "products/1/main.jpg" });
    mockDownloadObject.mockResolvedValueOnce({
      status: 200,
      headers: {
        forEach: (fn: (v: string, k: string) => void) =>
          fn("\"object-etag\"", "ETag"),
      },
      body: null,
    });

    const res = await request(app).get("/storage/public-objects/products/1/main.jpg");

    expect(mockDownloadObject).toHaveBeenCalledWith(expect.anything(), 86_400);
    expect(res.headers["cache-control"]).toBe(
      "public, max-age=86400, stale-while-revalidate=604800",
    );
    expect(res.headers.etag).toBe("\"object-etag\"");
    expect(res.headers["timing-allow-origin"]).toBe("*");
  });

  it("serves versioned product derivatives with immutable one-year caching", async () => {
    const key = "products/1/main-thumbnail-1234567890abcdef.webp";
    mockSearchPublicObject.mockResolvedValueOnce({ name: key });
    mockDownloadObject.mockResolvedValueOnce({
      status: 200,
      headers: { forEach: vi.fn() },
      body: null,
    });

    const res = await request(app).get(`/storage/public-objects/${key}`);

    expect(mockDownloadObject).toHaveBeenCalledWith(
      expect.anything(),
      31_536_000,
    );
    expect(res.headers["cache-control"]).toBe(
      "public, max-age=31536000, immutable",
    );
  });

  it("returns 404 (not 401) when the object does not exist", async () => {
    mockSearchPublicObject.mockResolvedValueOnce(null);

    const res = await request(app).get("/storage/public-objects/products/999/missing.jpg");

    expect(res.status).toBe(404);
    expect(res.status).not.toBe(401);
    expect(res.body.error).toMatch(/file not found/i);
  });

  it("returns 500 (not 401) on an unexpected storage error", async () => {
    mockSearchPublicObject.mockRejectedValueOnce(new Error("boom"));

    const res = await request(app).get("/storage/public-objects/products/1/main.jpg");

    expect(res.status).toBe(500);
    expect(res.status).not.toBe(401);
    expect(res.body.error).toMatch(/failed to serve public object/i);
  });

  it("joins a nested wildcard path into the search key", async () => {
    mockSearchPublicObject.mockResolvedValueOnce({ name: "occasions/12/cover.png" });
    mockDownloadObject.mockResolvedValueOnce({
      status: 200,
      headers: { forEach: vi.fn() },
      body: null,
    });

    await request(app).get("/storage/public-objects/occasions/12/cover.png");

    expect(mockSearchPublicObject).toHaveBeenCalledWith("occasions/12/cover.png");
  });

  it("returns the image even when the request carries Clerk-style session cookies and document-navigation headers", async () => {
    // Regression: browsers with active or stale Clerk sessions attach __session
    // and __client_uat cookies.  When clerkMiddleware intercepts such a request
    // it may return a Clerk FAPI error instead of the asset.  This route must
    // be mounted BEFORE clerkMiddleware so those cookies are irrelevant.
    mockSearchPublicObject.mockResolvedValueOnce({ name: "whatsapp/new-order-received.png" });
    mockDownloadObject.mockResolvedValueOnce({
      status: 200,
      headers: {
        forEach: (fn: (v: string, k: string) => void) => fn("image/png", "content-type"),
      },
      body: null,
    });

    const res = await request(app)
      .get("/storage/public-objects/whatsapp/new-order-received.png")
      // Clerk cookies a signed-in browser would send
      .set("Cookie", "__session=fake-jwt-token; __client_uat=1234567890")
      // Document-navigation headers that trigger Clerk's handshake logic
      .set("Sec-Fetch-Mode", "navigate")
      .set("Sec-Fetch-Dest", "document")
      .set("Accept", "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8");

    expect(res.status).toBe(200);
    // Must be an image Content-Type — not a Clerk error JSON or redirect.
    expect(res.headers["content-type"]).toMatch(/image\/png/i);
    // CORS header must still be present so cross-origin <img> tags work.
    expect(res.headers["access-control-allow-origin"]).toBe("*");
    // The route must have reached the storage service — Clerk did not intercept.
    expect(mockSearchPublicObject).toHaveBeenCalledWith("whatsapp/new-order-received.png");
  });
});

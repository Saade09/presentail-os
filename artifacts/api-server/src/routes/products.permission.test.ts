import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";
import type { WorkspaceRequest } from "../lib/workspace";

// ---------------------------------------------------------------------------
// Mocks — must be declared before importing the module under test.
// This file specifically exercises the products.manage permission check on
// POST, PATCH, and DELETE /products.
// ---------------------------------------------------------------------------

const mockDbQuery = vi.fn();
const mockObjectSave = vi.fn().mockResolvedValue(undefined);

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
let stubAllowedPages: string[] | null = null;

vi.mock("../lib/workspace", () => ({
  resolveWorkspace: (req: express.Request, _res: express.Response, next: express.NextFunction) => {
    const wreq = req as unknown as WorkspaceRequest;
    wreq.workspaceOwnerId = stubWorkspaceOwnerId;
    wreq.workspaceActualRole = stubWorkspaceRole;
    wreq.workspaceRole = stubWorkspaceRole;
    wreq.allowedPages = stubAllowedPages;
    next();
  },
  workspace: (req: express.Request) => req as unknown as WorkspaceRequest,
  hasPageAccess: (wreq: WorkspaceRequest, page: string) =>
    wreq.workspaceRole === "owner" || !!wreq.allowedPages?.includes(page),
}));

vi.mock("../lib/objectStorage", () => ({
  buildPublicObjectUrl: (path: string | null | undefined) =>
    path ? `https://os.presentail.com/api/storage/public-objects/${path}` : null,
  objectStorageClient: {
    bucket: () => ({
      file: () => ({
        save: (...args: unknown[]) => mockObjectSave(...args),
      }),
    }),
  },
}));

vi.mock("../lib/logger", () => ({
  logger: { error: vi.fn(), info: vi.fn(), warn: vi.fn() },
}));

import productsRouter from "./products";

// ---------------------------------------------------------------------------
// Test app
// ---------------------------------------------------------------------------

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use(productsRouter);
  return app;
}

const app = makeApp();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeProductRow(overrides: Partial<{
  id: number;
  workspace_owner_id: string;
  name: string;
  price_usd: string;
  price_aed: string;
  main_image_url: string | null;
  additional_image_urls: string[];
  description: string | null;
  status: string;
  brand: string | null;
  tags: string[];
  category: string | null;
  sku: string | null;
  created_at: string;
}> = {}) {
  return {
    id: 1,
    workspace_owner_id: "owner_123",
    name: "Widget Pro",
    price_usd: "9.99",
    price_aed: "36.70",
    main_image_url: null,
    additional_image_urls: [],
    description: null,
    status: "available",
    brand: "Acme",
    tags: [],
    category: "Gadgets",
    sku: "0001234",
    created_at: "2024-01-01T00:00:00Z",
    ...overrides,
  };
}

const VALID_PRODUCT_BODY = {
  name: "Test Product",
  price_usd: 9.99,
  price_aed: 36.70,
};

describe("GET /products sensitive read permissions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDbQuery.mockResolvedValue({ rows: [], rowCount: 0 });
    stubWorkspaceRole = "owner";
    stubAllowedPages = null;
  });

  it("rejects a member without either product permission before querying", async () => {
    stubWorkspaceRole = "member";
    stubAllowedPages = ["orders"];

    const res = await request(app).get("/products/export");

    expect(res.status).toBe(403);
    expect(mockDbQuery).not.toHaveBeenCalled();
  });

  it.each(["products", "products.manage"])(
    "allows a member with %s access",
    async (permission) => {
      stubWorkspaceRole = "member";
      stubAllowedPages = [permission];

      const res = await request(app).get("/products/not-a-number/cogs");

      expect(res.status).toBe(400);
    },
  );

  it("preserves owner access", async () => {
    const res = await request(app).get("/products/not-a-number/cogs");
    expect(res.status).toBe(400);
  });
});

describe("GET /order-catalog/products order-creation permissions", () => {
  const orderCatalogProduct = {
    id: 42,
    name: "Orderable Bouquet",
    price_usd: "35.00",
    price_aed: "128.55",
    main_image_url: "/objects/owner_123/products/bouquet",
    image_display_public_path: null,
    image_thumbnail_public_path: null,
    status: "available",
    sku: "BOU-42",
    has_input_field: true,
    letter_input_enabled: false,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockDbQuery.mockResolvedValue({ rows: [], rowCount: 0 });
    stubWorkspaceOwnerId = "owner_123";
    stubWorkspaceRole = "owner";
    stubAllowedPages = null;
  });

  it.each([
    ["owner", "owner", null],
    ["Orders member", "member", ["orders"]],
    ["CMC New Order member", "member", ["cmc-pos-new-order"]],
  ] as const)("allows %s to browse the order catalog", async (_name, role, pages) => {
    stubWorkspaceRole = role;
    stubAllowedPages = pages ? [...pages] : null;
    mockDbQuery
      .mockResolvedValueOnce({ rows: [{ count: "1" }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [orderCatalogProduct], rowCount: 1 });

    const res = await request(app).get(
      "/order-catalog/products?q=bouquet&status=available&category=Flowers&occasion=Birthday&page=2&pageSize=10",
    );

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      products: [
        {
          id: 42,
          name: "Orderable Bouquet",
          price_usd: "35.00",
          price_aed: "128.55",
          main_image_url: "/objects/owner_123/products/bouquet",
          main_image_display_url: "/objects/owner_123/products/bouquet",
          main_image_thumbnail_url: "/objects/owner_123/products/bouquet",
          status: "available",
          sku: "BOU-42",
          has_input_field: true,
          letter_input_enabled: false,
        },
      ],
      total: 1,
      page: 1,
      pageSize: 10,
      totalPages: 1,
    });

    const queryParams = mockDbQuery.mock.calls[0]?.[1] as unknown[];
    expect(queryParams.slice(0, 5)).toEqual([
      "owner_123",
      "available",
      "%flowers%",
      "%bouquet%",
      "birthday",
    ]);
    expect(queryParams.slice(-2)).toEqual([10, 0]);
  });

  it("does not expose product-management or sensitive fields", async () => {
    stubWorkspaceRole = "member";
    stubAllowedPages = ["orders"];
    mockDbQuery
      .mockResolvedValueOnce({ rows: [{ count: "1" }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [orderCatalogProduct], rowCount: 1 });

    const res = await request(app).get("/order-catalog/products");

    expect(res.status).toBe(200);
    expect(res.body.products[0]).not.toHaveProperty("cogs_usd");
    expect(res.body.products[0]).not.toHaveProperty("brand");
    expect(res.body.products[0]).not.toHaveProperty("description");
    expect(res.body.products[0]).not.toHaveProperty("merchant_sync_status");
    expect(res.body.products[0]).not.toHaveProperty("recipe");
  });

  it("rejects members without standard or CMC order-creation access before querying", async () => {
    stubWorkspaceRole = "member";
    stubAllowedPages = ["products"];

    const res = await request(app).get("/order-catalog/products");

    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/create orders/i);
    expect(mockDbQuery).not.toHaveBeenCalled();
  });

  it("does not treat CMC Dashboard access as permission to create orders", async () => {
    stubWorkspaceRole = "member";
    stubAllowedPages = ["cmc-pos-dashboard"];

    const res = await request(app).get("/order-catalog/products");

    expect(res.status).toBe(403);
    expect(mockDbQuery).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// POST /products — products.manage permission
// ---------------------------------------------------------------------------

describe("POST /products — products.manage permission", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDbQuery.mockResolvedValue({ rows: [], rowCount: 0 });
    stubWorkspaceOwnerId = "owner_123";
    stubWorkspaceRole = "owner";
    stubAllowedPages = null;
  });

  it("returns 201 when the caller is the workspace owner", async () => {
    stubWorkspaceRole = "owner";
    stubAllowedPages = null;

    mockDbQuery
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({ rows: [makeProductRow()], rowCount: 1 });

    const res = await request(app).post("/products").send(VALID_PRODUCT_BODY);

    expect(res.status).toBe(201);
    expect(res.body).toHaveProperty("product");
  });

  it("returns 201 when a member has products.manage in allowedPages", async () => {
    stubWorkspaceRole = "member";
    stubAllowedPages = ["products", "products.manage"];

    mockDbQuery
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({ rows: [makeProductRow()], rowCount: 1 });

    const res = await request(app).post("/products").send(VALID_PRODUCT_BODY);

    expect(res.status).toBe(201);
    expect(res.body).toHaveProperty("product");
  });

  it("returns 403 when a member has no allowedPages at all", async () => {
    stubWorkspaceRole = "member";
    stubAllowedPages = null;

    const res = await request(app).post("/products").send(VALID_PRODUCT_BODY);

    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/manage products/i);
  });

  it("returns 403 when a member has an empty allowedPages array", async () => {
    stubWorkspaceRole = "member";
    stubAllowedPages = [];

    const res = await request(app).post("/products").send(VALID_PRODUCT_BODY);

    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/manage products/i);
  });

  it("returns 403 when a member has other permissions but not products.manage", async () => {
    stubWorkspaceRole = "member";
    stubAllowedPages = ["products", "brands", "devices"];

    const res = await request(app).post("/products").send(VALID_PRODUCT_BODY);

    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/manage products/i);
  });

  it("includes the correct error message in the 403 response", async () => {
    stubWorkspaceRole = "member";
    stubAllowedPages = [];

    const res = await request(app).post("/products").send(VALID_PRODUCT_BODY);

    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/owner access or the manage products permission/i);
  });
});

// ---------------------------------------------------------------------------
// PATCH /products/:id — products.manage permission
// ---------------------------------------------------------------------------

describe("PATCH /products/:id — products.manage permission", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDbQuery.mockResolvedValue({ rows: [], rowCount: 0 });
    stubWorkspaceOwnerId = "owner_123";
    stubWorkspaceRole = "owner";
    stubAllowedPages = null;
  });

  it("returns 200 when the caller is the workspace owner", async () => {
    stubWorkspaceRole = "owner";
    stubAllowedPages = null;

    mockDbQuery
      .mockResolvedValueOnce({ rows: [makeProductRow()], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [makeProductRow({ name: "Updated" })], rowCount: 1 });

    const res = await request(app).patch("/products/1").send({ name: "Updated" });

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("product");
  });

  it("returns 200 when a member has products.manage in allowedPages", async () => {
    stubWorkspaceRole = "member";
    stubAllowedPages = ["products", "products.manage"];

    mockDbQuery
      .mockResolvedValueOnce({ rows: [makeProductRow()], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [makeProductRow({ name: "Updated" })], rowCount: 1 });

    const res = await request(app).patch("/products/1").send({ name: "Updated" });

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("product");
  });

  it("returns 403 when a member has an empty allowedPages array", async () => {
    stubWorkspaceRole = "member";
    stubAllowedPages = [];

    const res = await request(app).patch("/products/1").send({ name: "Updated" });

    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/manage products/i);
  });

  it("returns 403 when a member has other permissions but not products.manage", async () => {
    stubWorkspaceRole = "member";
    stubAllowedPages = ["products", "brands"];

    const res = await request(app).patch("/products/1").send({ name: "Updated" });

    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/manage products/i);
  });

  it("does not touch the database when a member lacks products.manage", async () => {
    stubWorkspaceRole = "member";
    stubAllowedPages = ["products"];

    await request(app).patch("/products/1").send({ name: "Updated" });

    expect(mockDbQuery).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// DELETE /products/:id — products.manage permission
// ---------------------------------------------------------------------------

describe("DELETE /products/:id — products.manage permission", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDbQuery.mockResolvedValue({ rows: [], rowCount: 0 });
    stubWorkspaceOwnerId = "owner_123";
    stubWorkspaceRole = "owner";
    stubAllowedPages = null;
  });

  it("returns 200 when the caller is the workspace owner", async () => {
    stubWorkspaceRole = "owner";
    stubAllowedPages = null;

    mockDbQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const res = await request(app).delete("/products/1");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });

  it("returns 200 when a member has products.manage in allowedPages", async () => {
    stubWorkspaceRole = "member";
    stubAllowedPages = ["products", "products.manage"];

    mockDbQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const res = await request(app).delete("/products/1");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });

  it("returns 403 when a member has no allowedPages", async () => {
    stubWorkspaceRole = "member";
    stubAllowedPages = null;

    const res = await request(app).delete("/products/1");

    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/manage products/i);
  });

  it("returns 403 when a member has an empty allowedPages array", async () => {
    stubWorkspaceRole = "member";
    stubAllowedPages = [];

    const res = await request(app).delete("/products/1");

    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/manage products/i);
  });

  it("returns 403 when a member has other permissions but not products.manage", async () => {
    stubWorkspaceRole = "member";
    stubAllowedPages = ["products", "devices", "brands"];

    const res = await request(app).delete("/products/1");

    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/manage products/i);
  });

  it("does not touch the database when a member lacks products.manage", async () => {
    stubWorkspaceRole = "member";
    stubAllowedPages = [];

    await request(app).delete("/products/5");

    expect(mockDbQuery).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// POST /products/upload-image — products.manage permission
// ---------------------------------------------------------------------------

describe("POST /products/upload-image — products.manage permission", () => {
  const FAKE_IMAGE = Buffer.from("fake-image-data");

  beforeEach(() => {
    vi.clearAllMocks();
    mockDbQuery.mockResolvedValue({ rows: [], rowCount: 0 });
    mockObjectSave.mockResolvedValue(undefined);
    stubWorkspaceOwnerId = "owner_123";
    stubWorkspaceRole = "owner";
    stubAllowedPages = null;
    process.env.PRIVATE_OBJECT_DIR = "test-bucket/objects";
  });

  it("returns 200 when the caller is the workspace owner", async () => {
    stubWorkspaceRole = "owner";
    stubAllowedPages = null;

    const res = await request(app)
      .post("/products/upload-image")
      .attach("image", FAKE_IMAGE, { filename: "photo.jpg", contentType: "image/jpeg" });

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("url");
  });

  it("returns 200 when a member has products.manage in allowedPages", async () => {
    stubWorkspaceRole = "member";
    stubAllowedPages = ["products", "products.manage"];

    const res = await request(app)
      .post("/products/upload-image")
      .attach("image", FAKE_IMAGE, { filename: "photo.jpg", contentType: "image/jpeg" });

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("url");
  });

  it("returns 403 when a member has no allowedPages", async () => {
    stubWorkspaceRole = "member";
    stubAllowedPages = null;

    const res = await request(app)
      .post("/products/upload-image")
      .attach("image", FAKE_IMAGE, { filename: "photo.jpg", contentType: "image/jpeg" });

    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/manage products/i);
  });

  it("returns 403 when a member has an empty allowedPages array", async () => {
    stubWorkspaceRole = "member";
    stubAllowedPages = [];

    const res = await request(app)
      .post("/products/upload-image")
      .attach("image", FAKE_IMAGE, { filename: "photo.jpg", contentType: "image/jpeg" });

    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/manage products/i);
  });

  it("returns 403 when a member has other permissions but not products.manage", async () => {
    stubWorkspaceRole = "member";
    stubAllowedPages = ["products", "brands", "devices"];

    const res = await request(app)
      .post("/products/upload-image")
      .attach("image", FAKE_IMAGE, { filename: "photo.jpg", contentType: "image/jpeg" });

    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/manage products/i);
  });

  it("does not call object storage when a member lacks products.manage", async () => {
    stubWorkspaceRole = "member";
    stubAllowedPages = [];

    await request(app)
      .post("/products/upload-image")
      .attach("image", FAKE_IMAGE, { filename: "photo.jpg", contentType: "image/jpeg" });

    expect(mockObjectSave).not.toHaveBeenCalled();
  });

  it("returns 400 when no file is attached", async () => {
    stubWorkspaceRole = "owner";
    stubAllowedPages = null;

    const res = await request(app)
      .post("/products/upload-image");

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/image file is required/i);
  });

  it("returns 400 when the attached file has an unsupported MIME type", async () => {
    stubWorkspaceRole = "owner";
    stubAllowedPages = null;

    const res = await request(app)
      .post("/products/upload-image")
      .attach("image", FAKE_IMAGE, { filename: "document.pdf", contentType: "application/pdf" });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/JPEG, PNG, or WebP/i);
  });
});

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

const mockResolvePublicWorkspace = vi.fn();
const mockResolveCityFilter = vi.fn();

vi.mock("../lib/resolvePublicWorkspace", () => ({
  resolvePublicWorkspace: (...args: unknown[]) => mockResolvePublicWorkspace(...args),
  resolveCityFilter: (...args: unknown[]) => mockResolveCityFilter(...args),
}));

vi.mock("../lib/logger", () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn().mockReturnThis(),
  },
}));

const mockRequireApiKey = vi.fn(
  (_req: express.Request, res: express.Response, next: express.NextFunction) => {
    res.status(401).json({ error: "Unauthorized" });
  },
);

vi.mock("../lib/apiKeyAuth", () => ({
  requireApiKey: (...args: Parameters<express.RequestHandler>) =>
    mockRequireApiKey(...args),
}));

// ---------------------------------------------------------------------------
// Test app bootstrap
// ---------------------------------------------------------------------------

let app: express.Express;

beforeEach(async () => {
  vi.resetAllMocks();

  // Default: workspace resolver returns a valid owner ID
  mockResolvePublicWorkspace.mockResolvedValue({ ownerId: "owner_abc" });
  // Default: city filter returns no city filter
  mockResolveCityFilter.mockResolvedValue({ cityId: null, countryCode: null });

  const routerModule = await import("./publicCatalog");
  app = express();
  app.use(express.json());
  app.use(routerModule.default);
});

// ---------------------------------------------------------------------------
// GET /public/catalog/products
// ---------------------------------------------------------------------------

describe("GET /public/catalog/products", () => {
  it("returns 400 when workspace param is missing", async () => {
    mockResolvePublicWorkspace.mockResolvedValue({ error: "missing_workspace" });

    const res = await request(app).get("/public/catalog/products");
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/workspace/i);
  });

  it("returns 404 when workspace slug is not found", async () => {
    mockResolvePublicWorkspace.mockResolvedValue({ error: "workspace_not_found" });

    const res = await request(app).get("/public/catalog/products?workspace=unknown-slug");
    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/workspace/i);
  });

  it("returns 404 when city_slug is not found", async () => {
    mockResolveCityFilter.mockResolvedValue({ status: 404, error: "City not found" });

    const res = await request(app).get("/public/catalog/products?workspace=slug&city_slug=unknown");
    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/city/i);
  });

  it("returns paginated product list with ETag", async () => {
    // count query
    mockDbQuery.mockResolvedValueOnce({ rows: [{ count: "2" }], rowCount: 1 });
    // data query
    mockDbQuery.mockResolvedValueOnce({
      rows: [
        {
          id: 1,
          name: "Product A",
          price_usd: "10.00",
          price_aed: null,
          main_image_url: null,
          additional_image_urls: [],
          description: null,
          status: "available",
          brand: "ACME",
          tags: [],
          category: null,
          sku: null,
          updated_at: "2025-01-01T00:00:00.000Z",
          occasions: null,
          recipients: null,
        },
        {
          id: 2,
          name: "Product B",
          price_usd: "20.00",
          price_aed: null,
          main_image_url: null,
          additional_image_urls: [],
          description: null,
          status: "available",
          brand: null,
          tags: [],
          category: null,
          sku: null,
          updated_at: "2025-01-02T00:00:00.000Z",
          occasions: null,
          recipients: null,
        },
      ],
      rowCount: 2,
    });

    const res = await request(app).get("/public/catalog/products?workspace=slug");
    expect(res.status).toBe(200);
    expect(res.body.products).toHaveLength(2);
    expect(res.body.total).toBe(2);
    expect(res.headers.etag).toBeTruthy();
  });

  it("exposes main_image_public_url and additional_image_public_urls (built from public paths)", async () => {
    mockDbQuery.mockResolvedValueOnce({ rows: [{ count: "1" }], rowCount: 1 });
    mockDbQuery.mockResolvedValueOnce({
      rows: [
        {
          id: 1,
          name: "Product A",
          price_usd: "10.00",
          price_aed: null,
          main_image_url: "/objects/owner/products/abc",
          additional_image_urls: ["/objects/owner/products/def"],
          image_public_path: "products/1.jpg",
          additional_image_public_paths: ["products/1-1.jpg", null],
          image_display_public_path: "products/1/main-display-1234567890abcdef.webp",
          image_thumbnail_public_path: "products/1/main-thumbnail-1234567890abcdef.webp",
          additional_image_display_public_paths: [],
          additional_image_thumbnail_public_paths: [],
          description: null,
          status: "available",
          brand: null,
          tags: [],
          category: null,
          sku: null,
          updated_at: "2025-01-01T00:00:00.000Z",
          occasions: null,
          recipients: null,
        },
      ],
      rowCount: 1,
    });

    const res = await request(app).get("/public/catalog/products?workspace=slug");
    expect(res.status).toBe(200);
    const product = res.body.products[0];
    expect(product.main_image_public_url).toBe(
      "https://os.presentail.com/api/storage/public-objects/products/1.jpg",
    );
    expect(product.additional_image_public_urls).toEqual([
      "https://os.presentail.com/api/storage/public-objects/products/1-1.jpg",
      null,
    ]);
    expect(product.main_image_display_public_url).toContain(
      "main-display-1234567890abcdef.webp",
    );
    expect(product.main_image_thumbnail_public_url).toContain(
      "main-thumbnail-1234567890abcdef.webp",
    );
    // Raw public-path fields are not leaked.
    expect(product).not.toHaveProperty("image_public_path");
    expect(product).not.toHaveProperty("additional_image_public_paths");
  });

  it("uses an external legacy image as the optimized URL fallback", async () => {
    mockDbQuery.mockResolvedValueOnce({ rows: [{ count: "1" }], rowCount: 1 });
    mockDbQuery.mockResolvedValueOnce({
      rows: [
        {
          id: 1,
          name: "Legacy Product",
          price_usd: "10.00",
          price_aed: null,
          main_image_url: "https://images.example.com/legacy.jpg",
          additional_image_urls: [],
          image_public_path: null,
          additional_image_public_paths: [],
          image_display_public_path: null,
          image_thumbnail_public_path: null,
          additional_image_display_public_paths: [],
          additional_image_thumbnail_public_paths: [],
          description: null,
          status: "available",
          brand: null,
          tags: [],
          category: null,
          sku: null,
          updated_at: null,
          occasions: null,
          recipients: null,
        },
      ],
      rowCount: 1,
    });

    const res = await request(app).get("/public/catalog/products?workspace=slug");

    expect(res.status).toBe(200);
    expect(res.body.products[0].main_image_thumbnail_public_url).toBe(
      "https://images.example.com/legacy.jpg",
    );
    expect(res.body.products[0].main_image_url).toBe(
      "https://images.example.com/legacy.jpg",
    );
  });

  it("returns null main_image_public_url when no public copy exists", async () => {
    mockDbQuery.mockResolvedValueOnce({ rows: [{ count: "1" }], rowCount: 1 });
    mockDbQuery.mockResolvedValueOnce({
      rows: [
        {
          id: 1,
          name: "Product A",
          price_usd: null,
          price_aed: null,
          main_image_url: null,
          additional_image_urls: [],
          image_public_path: null,
          additional_image_public_paths: null,
          description: null,
          status: "available",
          brand: null,
          tags: [],
          category: null,
          sku: null,
          updated_at: null,
          occasions: null,
          recipients: null,
        },
      ],
      rowCount: 1,
    });

    const res = await request(app).get("/public/catalog/products?workspace=slug");
    expect(res.status).toBe(200);
    expect(res.body.products[0].main_image_public_url).toBeNull();
    expect(res.body.products[0].additional_image_public_urls).toEqual([]);
  });

  it("returns 304 when ETag matches", async () => {
    mockDbQuery.mockResolvedValueOnce({ rows: [{ count: "1" }], rowCount: 1 });
    mockDbQuery.mockResolvedValueOnce({
      rows: [
        {
          id: 1,
          name: "Product A",
          price_usd: null,
          price_aed: null,
          main_image_url: null,
          additional_image_urls: [],
          description: null,
          status: "available",
          brand: null,
          tags: [],
          category: null,
          sku: null,
          updated_at: null,
          occasions: null,
          recipients: null,
        },
      ],
      rowCount: 1,
    });

    const first = await request(app).get("/public/catalog/products?workspace=slug");
    const etag = first.headers.etag as string;
    expect(etag).toBeTruthy();

    // Second call with matching ETag — mock the same queries again
    mockDbQuery.mockResolvedValueOnce({ rows: [{ count: "1" }], rowCount: 1 });
    mockDbQuery.mockResolvedValueOnce({
      rows: [
        {
          id: 1,
          name: "Product A",
          price_usd: null,
          price_aed: null,
          main_image_url: null,
          additional_image_urls: [],
          description: null,
          status: "available",
          brand: null,
          tags: [],
          category: null,
          sku: null,
          updated_at: null,
          occasions: null,
          recipients: null,
        },
      ],
      rowCount: 1,
    });

    const second = await request(app)
      .get("/public/catalog/products?workspace=slug")
      .set("If-None-Match", etag);
    expect(second.status).toBe(304);
  });

  it("mirrors letter_input_enabled as hasLetterField for both toggle states", async () => {
    mockDbQuery.mockResolvedValueOnce({ rows: [{ count: "2" }], rowCount: 1 });
    mockDbQuery.mockResolvedValueOnce({
      rows: [
        {
          id: 1,
          name: "Letter Product",
          price_usd: "10.00",
          price_aed: null,
          main_image_url: null,
          additional_image_urls: [],
          description: null,
          status: "available",
          brand: null,
          tags: [],
          category: null,
          sku: null,
          updated_at: null,
          letter_input_enabled: true,
          occasions: null,
          recipients: null,
        },
        {
          id: 2,
          name: "Plain Product",
          price_usd: "20.00",
          price_aed: null,
          main_image_url: null,
          additional_image_urls: [],
          description: null,
          status: "available",
          brand: null,
          tags: [],
          category: null,
          sku: null,
          updated_at: null,
          letter_input_enabled: false,
          occasions: null,
          recipients: null,
        },
      ],
      rowCount: 2,
    });

    const res = await request(app).get("/public/catalog/products?workspace=slug");
    expect(res.status).toBe(200);
    expect(res.body.products[0].letter_input_enabled).toBe(true);
    expect(res.body.products[0].hasLetterField).toBe(true);
    expect(res.body.products[1].letter_input_enabled).toBe(false);
    expect(res.body.products[1].hasLetterField).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// GET /public/catalog/products/:id
// ---------------------------------------------------------------------------

describe("GET /public/catalog/products/:id", () => {
  it("returns 400 for invalid product id", async () => {
    const res = await request(app).get("/public/catalog/products/notanumber?workspace=slug");
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/invalid/i);
  });

  it("returns 404 when product not found", async () => {
    mockDbQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    const res = await request(app).get("/public/catalog/products/999?workspace=slug");
    expect(res.status).toBe(404);
  });

  it("returns product detail with ETag", async () => {
    mockDbQuery.mockResolvedValueOnce({
      rows: [
        {
          id: 1,
          name: "Product A",
          price_usd: "10.00",
          price_aed: null,
          main_image_url: null,
          additional_image_urls: [],
          description: null,
          status: "available",
          brand: null,
          tags: [],
          category: null,
          sku: null,
          updated_at: "2025-01-01T00:00:00.000Z",
          occasions: null,
          recipients: null,
        },
      ],
      rowCount: 1,
    });
    const res = await request(app).get("/public/catalog/products/1?workspace=slug");
    expect(res.status).toBe(200);
    expect(res.body.product.id).toBe(1);
    expect(res.headers.etag).toBeTruthy();
  });

  it("exposes public image URLs and hides raw public-path fields", async () => {
    mockDbQuery.mockResolvedValueOnce({
      rows: [
        {
          id: 1,
          name: "Product A",
          price_usd: "10.00",
          price_aed: null,
          main_image_url: "/objects/owner/products/abc",
          additional_image_urls: ["/objects/owner/products/def"],
          image_public_path: "products/1.jpg",
          additional_image_public_paths: ["products/1-1.jpg"],
          description: null,
          status: "available",
          brand: null,
          tags: [],
          category: null,
          sku: null,
          updated_at: "2025-01-01T00:00:00.000Z",
          occasions: null,
          recipients: null,
        },
      ],
      rowCount: 1,
    });
    const res = await request(app).get("/public/catalog/products/1?workspace=slug");
    expect(res.status).toBe(200);
    expect(res.body.product.main_image_public_url).toBe(
      "https://os.presentail.com/api/storage/public-objects/products/1.jpg",
    );
    expect(res.body.product.additional_image_public_urls).toEqual([
      "https://os.presentail.com/api/storage/public-objects/products/1-1.jpg",
    ]);
    expect(res.body.product).not.toHaveProperty("image_public_path");
    expect(res.body.product).not.toHaveProperty("additional_image_public_paths");
  });

  it("mirrors letter_input_enabled as hasLetterField on the detail response", async () => {
    mockDbQuery.mockResolvedValueOnce({
      rows: [
        {
          id: 1,
          name: "Letter Product",
          price_usd: "10.00",
          price_aed: null,
          main_image_url: null,
          additional_image_urls: [],
          description: null,
          status: "available",
          brand: null,
          tags: [],
          category: null,
          sku: null,
          updated_at: null,
          letter_input_enabled: true,
          occasions: null,
          recipients: null,
        },
      ],
      rowCount: 1,
    });
    const res = await request(app).get("/public/catalog/products/1?workspace=slug");
    expect(res.status).toBe(200);
    expect(res.body.product.letter_input_enabled).toBe(true);
    expect(res.body.product.hasLetterField).toBe(true);

    // Toggle off → false
    mockDbQuery.mockResolvedValueOnce({
      rows: [
        {
          id: 2,
          name: "Plain Product",
          price_usd: "20.00",
          price_aed: null,
          main_image_url: null,
          additional_image_urls: [],
          description: null,
          status: "available",
          brand: null,
          tags: [],
          category: null,
          sku: null,
          updated_at: null,
          letter_input_enabled: false,
          occasions: null,
          recipients: null,
        },
      ],
      rowCount: 1,
    });
    const res2 = await request(app).get("/public/catalog/products/2?workspace=slug");
    expect(res2.status).toBe(200);
    expect(res2.body.product.letter_input_enabled).toBe(false);
    expect(res2.body.product.hasLetterField).toBe(false);
  });

  it("applies city + country availability guards and 404s a hidden product", async () => {
    mockResolveCityFilter.mockResolvedValue({ cityId: 7, countryCode: "AE" });
    // Guard filters the product out -> no row -> 404
    mockDbQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    const res = await request(app).get("/public/catalog/products/1?workspace=slug&city=dubai");
    expect(res.status).toBe(404);

    const [sql, params] = mockDbQuery.mock.calls[0];
    expect(sql).toContain("product_city_availability");
    expect(sql).toContain("product_country_availability");
    expect(sql).toContain("UPPER(pcoa.country_code)");
    // params: [id, ownerId, cityId, countryCode]
    expect(params).toEqual([1, "owner_abc", 7, "AE"]);
  });

  it("does not add availability guards when no city/country resolved", async () => {
    mockDbQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    const res = await request(app).get("/public/catalog/products/1?workspace=slug");
    expect(res.status).toBe(404);
    const [sql, params] = mockDbQuery.mock.calls[0];
    expect(sql).not.toContain("product_city_availability");
    expect(sql).not.toContain("product_country_availability");
    expect(params).toEqual([1, "owner_abc"]);
  });
});

// ---------------------------------------------------------------------------
// GET /public/catalog/base-items
// ---------------------------------------------------------------------------

describe("GET /public/catalog/base-items", () => {
  it("returns 400 when workspace param is missing", async () => {
    mockResolvePublicWorkspace.mockResolvedValue({ error: "missing_workspace" });
    const res = await request(app).get("/public/catalog/base-items");
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/workspace/i);
  });

  it("returns 404 when workspace slug is not found", async () => {
    mockResolvePublicWorkspace.mockResolvedValue({ error: "workspace_not_found" });
    const res = await request(app).get("/public/catalog/base-items?workspace=unknown-slug");
    expect(res.status).toBe(404);
  });

  it("returns paginated base-item list with parsed packages and ETag", async () => {
    // count query
    mockDbQuery.mockResolvedValueOnce({ rows: [{ count: "1" }], rowCount: 1 });
    // data query
    mockDbQuery.mockResolvedValueOnce({
      rows: [
        {
          id: 1,
          name: "Red Roses",
          code: "RR-01",
          image_url: "/objects/owner/base-items/abc",
          image_public_path: "base-items/1.jpg",
          category_id: 3,
          main_category_name: "Flowers",
          sub_category_name: "Roses",
          status: "active",
          type: "flower",
          updated_at: "2025-01-01T00:00:00.000Z",
          packages: JSON.stringify([
            { id: 11, name: "Bunch", unit: "stems", quantity: 10, is_default: true },
          ]),
        },
      ],
      rowCount: 1,
    });

    const res = await request(app).get("/public/catalog/base-items?workspace=slug");
    expect(res.status).toBe(200);
    expect(res.body.base_items).toHaveLength(1);
    expect(res.body.total).toBe(1);
    expect(res.body.base_items[0].packages).toEqual([
      { id: 11, name: "Bunch", unit: "stems", quantity: 10, is_default: true },
    ]);
    // Public image URL is built from the stored public path; the raw path is
    // not leaked in the response.
    expect(res.body.base_items[0].image_public_url).toBe(
      "https://os.presentail.com/api/storage/public-objects/base-items/1.jpg",
    );
    expect(res.body.base_items[0]).not.toHaveProperty("image_public_path");
    expect(res.headers.etag).toBeTruthy();
  });

  it("defaults packages to an empty array when null", async () => {
    mockDbQuery.mockResolvedValueOnce({ rows: [{ count: "1" }], rowCount: 1 });
    mockDbQuery.mockResolvedValueOnce({
      rows: [
        {
          id: 2,
          name: "Vase",
          code: null,
          image_url: null,
          image_public_path: null,
          category_id: null,
          main_category_name: null,
          sub_category_name: null,
          status: "active",
          type: null,
          updated_at: null,
          packages: null,
        },
      ],
      rowCount: 1,
    });

    const res = await request(app).get("/public/catalog/base-items?workspace=slug");
    expect(res.status).toBe(200);
    expect(res.body.base_items[0].packages).toEqual([]);
    expect(res.body.base_items[0].image_public_url).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// GET /public/catalog/base-items/:id
// ---------------------------------------------------------------------------

describe("GET /public/catalog/base-items/:id", () => {
  it("returns 400 for invalid base item id", async () => {
    const res = await request(app).get("/public/catalog/base-items/notanumber?workspace=slug");
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/invalid/i);
  });

  it("returns 404 when base item not found", async () => {
    mockDbQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    const res = await request(app).get("/public/catalog/base-items/999?workspace=slug");
    expect(res.status).toBe(404);
  });

  it("returns base item detail with ETag", async () => {
    mockDbQuery.mockResolvedValueOnce({
      rows: [
        {
          id: 1,
          name: "Red Roses",
          code: "RR-01",
          image_url: "/objects/owner/base-items/abc",
          image_public_path: "base-items/1.jpg",
          category_id: 3,
          main_category_name: "Flowers",
          sub_category_name: "Roses",
          status: "active",
          type: "flower",
          updated_at: "2025-01-01T00:00:00.000Z",
          packages: null,
        },
      ],
      rowCount: 1,
    });
    const res = await request(app).get("/public/catalog/base-items/1?workspace=slug");
    expect(res.status).toBe(200);
    expect(res.body.base_item.id).toBe(1);
    expect(res.body.base_item.packages).toEqual([]);
    expect(res.body.base_item.image_public_url).toBe(
      "https://os.presentail.com/api/storage/public-objects/base-items/1.jpg",
    );
    expect(res.body.base_item).not.toHaveProperty("image_public_path");
    expect(res.headers.etag).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// GET /public/catalog/brands
// ---------------------------------------------------------------------------

describe("GET /public/catalog/brands", () => {
  it("returns 400 when workspace param is missing", async () => {
    mockResolvePublicWorkspace.mockResolvedValue({ error: "missing_workspace" });
    const res = await request(app).get("/public/catalog/brands");
    expect(res.status).toBe(400);
  });

  it("returns brand list with logo_url and cover_photo_urls", async () => {
    mockDbQuery.mockResolvedValueOnce({
      rows: [
        {
          id: 10,
          name: "ACME",
          description: null,
          has_logo: true,
          logo_count: "1",
          cover_photo_count: "2",
          cover_photo_ids: JSON.stringify([5, 7]),
          updated_at: "2025-01-01T00:00:00.000Z",
          created_at: "2024-01-01T00:00:00.000Z",
        },
      ],
      rowCount: 1,
    });

    const res = await request(app).get("/public/catalog/brands?workspace=slug");
    expect(res.status).toBe(200);
    expect(res.body.brands).toHaveLength(1);
    const brand = res.body.brands[0];
    expect(brand.logo_url).toBe("/api/public/catalog/brands/10/logo");
    expect(brand.cover_photo_urls).toEqual([
      "/api/public/catalog/brands/10/cover-photos/5",
      "/api/public/catalog/brands/10/cover-photos/7",
    ]);
  });
});

// ---------------------------------------------------------------------------
// GET /public/catalog/banners
// ---------------------------------------------------------------------------

describe("GET /public/catalog/banners", () => {
  it("returns 400 when workspace param is missing", async () => {
    mockResolvePublicWorkspace.mockResolvedValue({ error: "missing_workspace" });
    const res = await request(app).get("/public/catalog/banners");
    expect(res.status).toBe(400);
  });

  it("returns active banners list", async () => {
    mockDbQuery.mockResolvedValueOnce({
      rows: [
        {
          id: 1,
          internal_name: "Summer",
          title: "Summer Sale",
          headline: null,
          subtitle: null,
          cta_text: null,
          country_codes: ["AE"],
          city_ids: [],
          is_global_for_country: true,
          desktop_enabled: true,
          desktop_media_type: "image",
          desktop_media_url: "https://example.com/img.jpg",
          desktop_fallback_url: null,
          desktop_link_url: null,
          mobile_enabled: false,
          mobile_media_type: null,
          mobile_media_url: null,
          mobile_fallback_url: null,
          mobile_link_url: null,
          start_at: null,
          end_at: null,
          sort_order: 0,
          priority: 0,
          updated_at: new Date("2025-01-01"),
        },
      ],
      rowCount: 1,
    });

    const res = await request(app).get("/public/catalog/banners?workspace=slug");
    expect(res.status).toBe(200);
    expect(res.body.banners).toHaveLength(1);
    expect(res.body.banners[0].title).toBe("Summer Sale");
  });
});

// ---------------------------------------------------------------------------
// GET /public/catalog/occasions
// ---------------------------------------------------------------------------

describe("GET /public/catalog/occasions", () => {
  it("returns 400 when workspace param is missing", async () => {
    mockResolvePublicWorkspace.mockResolvedValue({ error: "missing_workspace" });
    const res = await request(app).get("/public/catalog/occasions");
    expect(res.status).toBe(400);
  });

  it("returns occasions list", async () => {
    mockDbQuery.mockResolvedValueOnce({
      rows: [
        { id: 1, name: "Birthday", slug: "birthday", description: null, image_url: null, sort_order: 0, is_featured: false, updated_at: null },
      ],
      rowCount: 1,
    });

    const res = await request(app).get("/public/catalog/occasions?workspace=slug");
    expect(res.status).toBe(200);
    expect(res.body.occasions).toHaveLength(1);
    expect(res.body.occasions[0].slug).toBe("birthday");
  });

  it("exposes featured and image fields mirroring is_featured and image_url", async () => {
    mockDbQuery.mockResolvedValueOnce({
      rows: [
        {
          id: 1,
          name: "Birthday",
          slug: "birthday",
          description: null,
          image_url: "https://cdn.example.com/birthday.png",
          image_public_path: "occasions/1.jpg",
          sort_order: 0,
          is_featured: true,
          updated_at: null,
        },
        {
          id: 2,
          name: "Anniversary",
          slug: "anniversary",
          description: null,
          image_url: null,
          image_public_path: null,
          sort_order: 1,
          is_featured: false,
          updated_at: null,
        },
      ],
      rowCount: 2,
    });

    const res = await request(app).get("/public/catalog/occasions?workspace=slug");
    expect(res.status).toBe(200);
    expect(res.body.occasions).toHaveLength(2);

    const [first, second] = res.body.occasions;
    expect(first.featured).toBe(true);
    expect(first.image).toBe("https://cdn.example.com/birthday.png");
    expect(first.is_featured).toBe(true);
    expect(first.image_url).toBe("https://cdn.example.com/birthday.png");

    expect(second.featured).toBe(false);
    expect(second.image).toBeNull();
    expect(second.is_featured).toBe(false);
    expect(second.image_url).toBeNull();
  });

  it("exposes image_public_url built from image_public_path (null when absent)", async () => {
    mockDbQuery.mockResolvedValueOnce({
      rows: [
        {
          id: 1,
          name: "Birthday",
          slug: "birthday",
          description: null,
          image_url: "https://cdn.example.com/birthday.png",
          image_public_path: "occasions/1.jpg",
          sort_order: 0,
          is_featured: true,
          updated_at: null,
        },
        {
          id: 2,
          name: "Anniversary",
          slug: "anniversary",
          description: null,
          image_url: null,
          image_public_path: null,
          sort_order: 1,
          is_featured: false,
          updated_at: null,
        },
      ],
      rowCount: 2,
    });

    const res = await request(app).get("/public/catalog/occasions?workspace=slug");
    expect(res.status).toBe(200);

    const [first, second] = res.body.occasions;
    expect(first.image_public_url).toBe(
      "https://os.presentail.com/api/storage/public-objects/occasions/1.jpg",
    );
    expect(second.image_public_url).toBeNull();
  });

  it("sort=best_selling is accepted and returns occasions list", async () => {
    mockDbQuery.mockResolvedValueOnce({
      rows: [
        { id: 2, name: "Valentine's Day", slug: "valentines-day", description: null, image_url: null, image_public_path: null, sort_order: 1, is_featured: true, updated_at: null },
        { id: 1, name: "Birthday", slug: "birthday", description: null, image_url: null, image_public_path: null, sort_order: 0, is_featured: false, updated_at: null },
      ],
      rowCount: 2,
    });

    const res = await request(app).get("/public/catalog/occasions?workspace=slug&sort=best_selling");
    expect(res.status).toBe(200);
    expect(res.body.occasions).toHaveLength(2);
    expect(res.body.occasions[0].slug).toBe("valentines-day");
    expect(res.body.occasions[1].slug).toBe("birthday");
  });

  it("sort=best_selling includes revenue JOIN in the SQL query", async () => {
    mockDbQuery.mockResolvedValueOnce({
      rows: [
        { id: 1, name: "Birthday", slug: "birthday", description: null, image_url: null, image_public_path: null, sort_order: 0, is_featured: false, updated_at: null },
      ],
      rowCount: 1,
    });

    await request(app).get("/public/catalog/occasions?workspace=slug&sort=best_selling");

    const callArg = mockDbQuery.mock.calls[mockDbQuery.mock.calls.length - 1][0] as string;
    expect(callArg).toContain("order_line_items");
    expect(callArg).toContain("COALESCE(rev.total_revenue, 0) DESC");
    expect(callArg).toContain("INTERVAL '90 days'");
  });

  it("default sort does NOT include revenue JOIN", async () => {
    mockDbQuery.mockResolvedValueOnce({
      rows: [
        { id: 1, name: "Birthday", slug: "birthday", description: null, image_url: null, image_public_path: null, sort_order: 0, is_featured: false, updated_at: null },
      ],
      rowCount: 1,
    });

    await request(app).get("/public/catalog/occasions?workspace=slug");

    const callArg = mockDbQuery.mock.calls[mockDbQuery.mock.calls.length - 1][0] as string;
    expect(callArg).not.toContain("order_line_items");
    expect(callArg).toContain("o.sort_order ASC");
  });
});

// ---------------------------------------------------------------------------
// GET /public/catalog/categories
// ---------------------------------------------------------------------------

describe("GET /public/catalog/categories", () => {
  it("returns 400 when workspace param is missing", async () => {
    mockResolvePublicWorkspace.mockResolvedValue({ error: "missing_workspace" });
    const res = await request(app).get("/public/catalog/categories");
    expect(res.status).toBe(400);
  });

  it("returns categories list", async () => {
    mockDbQuery.mockResolvedValueOnce({
      rows: [
        { id: 3, name: "Flowers", slug: "flowers", description: null, image_url: null, sort_order: 1, is_featured: false, updated_at: null },
      ],
      rowCount: 1,
    });

    const res = await request(app).get("/public/catalog/categories?workspace=slug");
    expect(res.status).toBe(200);
    expect(res.body.categories).toHaveLength(1);
    expect(res.body.categories[0].slug).toBe("flowers");
  });

  it("exposes featured and image fields mirroring is_featured and image_url", async () => {
    mockDbQuery.mockResolvedValueOnce({
      rows: [
        {
          id: 3,
          name: "Flowers",
          slug: "flowers",
          description: null,
          image_url: "https://cdn.example.com/flowers.png",
          image_public_path: "catalog_categories/3.jpg",
          sort_order: 1,
          is_featured: true,
          updated_at: null,
        },
        {
          id: 4,
          name: "Cakes",
          slug: "cakes",
          description: null,
          image_url: null,
          image_public_path: null,
          sort_order: 2,
          is_featured: false,
          updated_at: null,
        },
      ],
      rowCount: 2,
    });

    const res = await request(app).get("/public/catalog/categories?workspace=slug");
    expect(res.status).toBe(200);
    expect(res.body.categories).toHaveLength(2);

    const [first, second] = res.body.categories;
    expect(first.featured).toBe(true);
    expect(first.image).toBe("https://cdn.example.com/flowers.png");
    expect(first.is_featured).toBe(true);
    expect(first.image_url).toBe("https://cdn.example.com/flowers.png");

    expect(second.featured).toBe(false);
    expect(second.image).toBeNull();
    expect(second.is_featured).toBe(false);
    expect(second.image_url).toBeNull();
  });

  it("filters to featured categories only when featured=true", async () => {
    mockDbQuery.mockResolvedValueOnce({
      rows: [
        { id: 3, name: "Flowers", slug: "flowers", description: null, image_url: null, image_public_path: null, sort_order: 1, is_featured: true, updated_at: null },
      ],
      rowCount: 1,
    });

    const res = await request(app).get("/public/catalog/categories?workspace=slug&featured=true");
    expect(res.status).toBe(200);
    expect(res.body.categories).toHaveLength(1);
    expect(res.body.categories[0].featured).toBe(true);

    const sql = mockDbQuery.mock.calls[0][0] as string;
    expect(sql).toContain("is_featured = true");
  });

  it("exposes image_public_url built from image_public_path (null when absent)", async () => {
    mockDbQuery.mockResolvedValueOnce({
      rows: [
        {
          id: 3,
          name: "Flowers",
          slug: "flowers",
          description: null,
          image_url: "https://cdn.example.com/flowers.png",
          image_public_path: "catalog_categories/3.jpg",
          sort_order: 1,
          updated_at: null,
        },
        {
          id: 4,
          name: "Cakes",
          slug: "cakes",
          description: null,
          image_url: null,
          image_public_path: null,
          sort_order: 2,
          updated_at: null,
        },
      ],
      rowCount: 2,
    });

    const res = await request(app).get("/public/catalog/categories?workspace=slug");
    expect(res.status).toBe(200);
    const [first, second] = res.body.categories;
    expect(first.image_public_url).toBe(
      "https://os.presentail.com/api/storage/public-objects/catalog_categories/3.jpg",
    );
    expect(second.image_public_url).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// GET /public/catalog/customers — requires API key
// ---------------------------------------------------------------------------

describe("GET /public/catalog/customers", () => {
  it("returns 401 when no API key provided", async () => {
    const res = await request(app).get("/public/catalog/customers");
    expect(res.status).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// GET /public/catalog/places
// ---------------------------------------------------------------------------

describe("GET /public/catalog/places", () => {
  it("returns 400 when workspace param is missing", async () => {
    mockResolvePublicWorkspace.mockResolvedValue({ error: "missing_workspace" });

    const res = await request(app).get("/public/catalog/places");
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/workspace/i);
  });

  it("returns 404 when workspace slug is not found", async () => {
    mockResolvePublicWorkspace.mockResolvedValue({ error: "workspace_not_found" });

    const res = await request(app).get("/public/catalog/places?workspace=unknown-slug");
    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/workspace/i);
  });

  it("returns { places: [] } with 200 when no verified places match (never 404)", async () => {
    mockDbQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const res = await request(app).get("/public/catalog/places?workspace=slug&q=nonexistent");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ places: [] });
  });

  it("returns matched places with only safe fields", async () => {
    mockDbQuery.mockResolvedValueOnce({
      rows: [
        {
          id: "uuid-1",
          canonical_name: "The Ritz Carlton",
          place_type: "hotel",
          area: "Downtown",
          city_name: "Dubai",
          country_code: "AE",
          latitude: "25.2048",
          longitude: "55.2708",
          verification_state: "staff_verified",
          aliases: JSON.stringify(["Ritz Carlton", "Ritz"]),
          updated_at: "2025-01-01T00:00:00.000Z",
        },
      ],
      rowCount: 1,
    });

    const res = await request(app).get("/public/catalog/places?workspace=slug&q=ritz");
    expect(res.status).toBe(200);
    expect(res.body.places).toHaveLength(1);

    const place = res.body.places[0];
    expect(place.id).toBe("uuid-1");
    expect(place.canonicalName).toBe("The Ritz Carlton");
    expect(place.placeType).toBe("hotel");
    expect(place.area).toBe("Downtown");
    expect(place.cityName).toBe("Dubai");
    expect(place.country).toBe("AE");
    expect(place.latitude).toBeCloseTo(25.2048);
    expect(place.longitude).toBeCloseTo(55.2708);
    expect(place.verificationState).toBe("staff_verified");
    expect(place.aliases).toEqual(["Ritz Carlton", "Ritz"]);

    // Sensitive fields must not be exposed
    expect(place).not.toHaveProperty("internal_notes");
    expect(place).not.toHaveProperty("entrance_notes");
    expect(place).not.toHaveProperty("ai_invalid");
    expect(place).not.toHaveProperty("canonical_name");
    const sql = mockDbQuery.mock.calls[0][0] as string;
    expect(sql).toContain("p.latitude IS NOT NULL");
    expect(sql).toContain("p.longitude IS NOT NULL");
    expect(sql).toContain("p.location_conflict = false");
  });

  it("returns empty list when workspace has only unverified places", async () => {
    // DB returns no rows because the query filters out unverified state
    mockDbQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const res = await request(app).get("/public/catalog/places?workspace=slug");
    expect(res.status).toBe(200);
    expect(res.body.places).toEqual([]);

    // Verify the SQL includes the verification_state filter
    const sql = mockDbQuery.mock.calls[0][0] as string;
    expect(sql).toContain("verification_state");
    expect(sql).toContain("ai_verified");
    expect(sql).toContain("staff_verified");
    expect(sql).toContain("delivery_verified");
  });

  it("excludes places where checkout_ready is false (the checkout gate)", async () => {
    // DB returns no rows — the checkout_ready = true condition filters them out
    mockDbQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const res = await request(app).get("/public/catalog/places?workspace=slug&q=hotel");
    expect(res.status).toBe(200);
    expect(res.body.places).toEqual([]);

    // Confirm checkout_ready guard is in the SQL
    const sql = mockDbQuery.mock.calls[0][0] as string;
    expect(sql).toContain("checkout_ready = true");
  });

  it("narrows results by country when countryCode is resolved", async () => {
    mockResolveCityFilter.mockResolvedValue({ cityId: null, countryCode: "AE" });
    mockDbQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const res = await request(app).get(
      "/public/catalog/places?workspace=slug&country=AE&q=hotel",
    );
    expect(res.status).toBe(200);

    // Confirm country filter was injected into the SQL
    const sql = mockDbQuery.mock.calls[0][0] as string;
    expect(sql).toContain("country_code");
  });

  it("narrows results by city when cityId is resolved", async () => {
    mockResolveCityFilter.mockResolvedValue({ cityId: 7, countryCode: "AE" });
    mockDbQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const res = await request(app).get(
      "/public/catalog/places?workspace=slug&city_id=7",
    );
    expect(res.status).toBe(200);

    const [sql, params] = mockDbQuery.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain("city_id");
    expect(params).toContain(7);
  });

  it("returns up to 20 results for an empty query (no q param)", async () => {
    const twentyPlaces = Array.from({ length: 20 }, (_, i) => ({
      id: `uuid-${i}`,
      canonical_name: `Place ${i}`,
      place_type: "residence",
      area: null,
      city_name: "Dubai",
      country_code: "AE",
      latitude: null,
      longitude: null,
      verification_state: "estimated",
      aliases: null,
      updated_at: "2025-01-01T00:00:00.000Z",
    }));

    mockDbQuery.mockResolvedValueOnce({ rows: twentyPlaces, rowCount: 20 });

    const res = await request(app).get("/public/catalog/places?workspace=slug");
    expect(res.status).toBe(200);
    expect(res.body.places).toHaveLength(20);

    // Verify the SQL has a LIMIT 20 cap
    const sql = mockDbQuery.mock.calls[0][0] as string;
    expect(sql).toContain("LIMIT 20");
  });

  it("handles null latitude/longitude and empty aliases gracefully", async () => {
    mockDbQuery.mockResolvedValueOnce({
      rows: [
        {
          id: "uuid-no-coords",
          canonical_name: "A Residence",
          place_type: "residence",
          area: null,
          city_name: null,
          country_code: null,
          latitude: null,
          longitude: null,
          verification_state: "estimated",
          aliases: null,
          updated_at: "2025-06-01T00:00:00.000Z",
        },
      ],
      rowCount: 1,
    });

    const res = await request(app).get("/public/catalog/places?workspace=slug&q=residence");
    expect(res.status).toBe(200);
    const place = res.body.places[0];
    expect(place.latitude).toBeNull();
    expect(place.longitude).toBeNull();
    expect(place.cityName).toBeNull();
    expect(place.country).toBeNull();
    expect(place.aliases).toEqual([]);
  });
});

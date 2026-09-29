import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";

// ---------------------------------------------------------------------------
// Mocks — must be declared before importing the module under test
// ---------------------------------------------------------------------------

const mockDbQuery = vi.fn();

vi.mock("../lib/db", () => ({
  db: { query: (...args: unknown[]) => mockDbQuery(...args) },
}));

const mockResolveApiKeyWorkspace = vi.fn();

vi.mock("../lib/apiKeyAuth", () => ({
  resolveApiKeyWorkspace: (...args: unknown[]) => mockResolveApiKeyWorkspace(...args),
}));

vi.mock("../lib/objectStorage", () => ({
  PUBLIC_OBJECT_HOST: "https://os.presentail.com",
  buildPublicObjectUrl: (publicPath: string | null | undefined) =>
    publicPath
      ? `https://os.presentail.com/api/storage/public-objects/${publicPath.replace(/^\/+/, "")}`
      : null,
}));

import router from "./externalProducts";

const OWNER_ID = "owner_123";

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use("/api", router);
  // Fallthrough handler so we can detect when the route calls next().
  app.use((_req, res) => res.status(599).json({ fellThrough: true }));
  return app;
}

type ProductOverrides = Record<string, unknown>;

function productRow(overrides: ProductOverrides = {}) {
  return {
    id: "1",
    sku: "SKU-1",
    name: "White Roses",
    price_usd: "79.99",
    price_aed: "293.99",
    discount_price_usd: null,
    discount_price_aed: null,
    status: "available",
    main_image_url: "/objects/owner_123/products/abc",
    additional_image_urls: [],
    image_public_path: null,
    additional_image_public_paths: [],
    description: null,
    tags: [],
    category: null,
    brand: null,
    occasions_json: [],
    catalog_categories_json: [],
    catalog_brands_json: [],
    deliverable_cities: [],
    deliverable_countries: [],
    ...overrides,
  };
}

// Route the two db.query calls (count, products) by SQL content. The product
// SELECT computes deliverable_cities / deliverable_countries inline (default-on,
// toggle-off model), so there is no separate workspace fallback query.
function stubDb(opts: {
  count?: number;
  products?: ReturnType<typeof productRow>[];
}) {
  const count = opts.count ?? (opts.products?.length ?? 0);
  mockDbQuery.mockImplementation(async (sql: string) => {
    if (sql.includes("COUNT(*)")) {
      return { rows: [{ count: String(count) }], rowCount: 1 };
    }
    return { rows: opts.products ?? [], rowCount: (opts.products ?? []).length };
  });
}

beforeEach(() => {
  vi.resetAllMocks();
  mockResolveApiKeyWorkspace.mockResolvedValue(OWNER_ID);
  delete process.env.PUBLIC_BASE_URL;
});

describe("GET /api/products — external API-key variant", () => {
  it("falls through to the next handler when no API key resolves", async () => {
    mockResolveApiKeyWorkspace.mockResolvedValue(null);
    const res = await request(makeApp()).get("/api/products");
    expect(res.status).toBe(599);
    expect(res.body.fellThrough).toBe(true);
    expect(mockDbQuery).not.toHaveBeenCalled();
  });

  it("honors an arbitrary pageSize (not limited to a fixed set)", async () => {
    stubDb({ count: 0, products: [] });
    const res = await request(makeApp()).get("/api/products?pageSize=30");
    expect(res.status).toBe(200);
    expect(res.body.pageSize).toBe(30);
  });

  it("caps pageSize at 100", async () => {
    stubDb({ count: 0, products: [] });
    const res = await request(makeApp()).get("/api/products?pageSize=5000");
    expect(res.status).toBe(200);
    expect(res.body.pageSize).toBe(100);
  });

  it("defaults pageSize to 25 when missing or invalid", async () => {
    stubDb({ count: 0, products: [] });
    const a = await request(makeApp()).get("/api/products");
    expect(a.body.pageSize).toBe(25);
    const b = await request(makeApp()).get("/api/products?pageSize=abc");
    expect(b.body.pageSize).toBe(25);
    const c = await request(makeApp()).get("/api/products?pageSize=0");
    expect(c.body.pageSize).toBe(25);
  });

  it("exposes the product sku as a string identifier", async () => {
    stubDb({ products: [productRow({ sku: "1657003" })] });
    const res = await request(makeApp()).get("/api/products");
    expect(res.status).toBe(200);
    expect(res.body.products[0].sku).toBe("1657003");
  });

  it("returns full product data (description, AED price, tags)", async () => {
    stubDb({
      products: [
        productRow({
          description: "Fresh white roses bouquet",
          price_usd: "79.99",
          price_aed: "293.99",
          tags: ["bestseller", "roses"],
        }),
      ],
    });
    const res = await request(makeApp()).get("/api/products");
    const product = res.body.products[0];
    expect(product.description).toBe("Fresh white roses bouquet");
    expect(product.price).toBe(79.99);
    expect(product.priceAed).toBe(293.99);
    expect(product.tags).toEqual(["bestseller", "roses"]);
  });

  it("returns discount prices when set on the product", async () => {
    stubDb({
      products: [
        productRow({
          price_usd: "79.99",
          price_aed: "293.99",
          discount_price_usd: "59.99",
          discount_price_aed: "219.99",
        }),
      ],
    });
    const res = await request(makeApp()).get("/api/products");
    const product = res.body.products[0];
    expect(product.price).toBe(79.99);
    expect(product.priceAed).toBe(293.99);
    expect(product.discountPrice).toBe(59.99);
    expect(product.discountPriceAed).toBe(219.99);
  });

  it("returns null discount prices when the product has no discount", async () => {
    stubDb({
      products: [productRow({ discount_price_usd: null, discount_price_aed: null })],
    });
    const res = await request(makeApp()).get("/api/products");
    const product = res.body.products[0];
    expect(product.discountPrice).toBeNull();
    expect(product.discountPriceAed).toBeNull();
  });

  it("returns absolute image URLs for relative object paths", async () => {
    stubDb({
      products: [
        productRow({
          main_image_url: "/objects/owner_123/products/abc",
          additional_image_urls: ["/objects/owner_123/products/def"],
        }),
      ],
    });
    const res = await request(makeApp()).get("/api/products");
    const images = res.body.products[0].images;
    expect(images[0].url).toBe(
      "https://os.presentail.com/api/storage/objects/owner_123/products/abc",
    );
    expect(images[1].url).toBe(
      "https://os.presentail.com/api/storage/objects/owner_123/products/def",
    );
  });

  it("prefers the public bucket copy when a public path is stored", async () => {
    stubDb({
      products: [
        productRow({
          main_image_url: "/objects/owner_123/products/abc",
          additional_image_urls: ["/objects/owner_123/products/def"],
          image_public_path: "products/1/main.jpg",
          additional_image_public_paths: ["products/1/additional-0.jpg"],
        }),
      ],
    });
    const res = await request(makeApp()).get("/api/products");
    const images = res.body.products[0].images;
    expect(images[0].url).toBe(
      "https://os.presentail.com/api/storage/public-objects/products/1/main.jpg",
    );
    expect(images[1].url).toBe(
      "https://os.presentail.com/api/storage/public-objects/products/1/additional-0.jpg",
    );
  });

  it("falls back to the private object URL when no public path exists", async () => {
    stubDb({
      products: [
        productRow({
          main_image_url: "/objects/owner_123/products/abc",
          additional_image_urls: ["/objects/owner_123/products/def"],
          image_public_path: null,
          additional_image_public_paths: [],
        }),
      ],
    });
    const res = await request(makeApp()).get("/api/products");
    const images = res.body.products[0].images;
    expect(images[0].url).toBe(
      "https://os.presentail.com/api/storage/objects/owner_123/products/abc",
    );
    expect(images[1].url).toBe(
      "https://os.presentail.com/api/storage/objects/owner_123/products/def",
    );
  });

  it("passes through already-absolute image URLs unchanged", async () => {
    stubDb({
      products: [productRow({ main_image_url: "https://cdn.example.com/x.jpg" })],
    });
    const res = await request(makeApp()).get("/api/products");
    expect(res.body.products[0].images[0].url).toBe("https://cdn.example.com/x.jpg");
  });

  it("prefers PUBLIC_BASE_URL when configured", async () => {
    process.env.PUBLIC_BASE_URL = "https://shop.example.com/";
    stubDb({
      products: [productRow({ main_image_url: "/objects/owner_123/products/abc" })],
    });
    const res = await request(makeApp()).get("/api/products");
    expect(res.body.products[0].images[0].url).toBe(
      "https://shop.example.com/api/storage/objects/owner_123/products/abc",
    );
  });

  it("returns the per-product deliverable cities/countries computed by the query", async () => {
    // The SELECT already applies the default-on, toggle-off model and returns
    // every active workspace city the product is NOT explicitly disabled in.
    stubDb({
      products: [
        productRow({
          deliverable_cities: ["beirut", "jounieh"],
          deliverable_countries: ["LB"],
        }),
      ],
    });
    const res = await request(makeApp()).get("/api/products");
    const p = res.body.products[0];
    expect(p.deliverableCities).toEqual(["beirut", "jounieh"]);
    expect(p.deliverableCountries).toEqual(["LB"]);
  });

  it("mirrors letter_input_enabled as hasLetterField (alongside letterInputEnabled)", async () => {
    stubDb({
      products: [
        productRow({ id: "1", letter_input_enabled: true }),
        productRow({ id: "2", letter_input_enabled: false }),
        productRow({ id: "3" }), // column absent → defaults to false
      ],
    });
    const res = await request(makeApp()).get("/api/products");
    const [on, off, absent] = res.body.products;
    expect(on.letterInputEnabled).toBe(true);
    expect(on.hasLetterField).toBe(true);
    expect(off.letterInputEnabled).toBe(false);
    expect(off.hasLetterField).toBe(false);
    expect(absent.letterInputEnabled).toBe(false);
    expect(absent.hasLetterField).toBe(false);
  });

  it("returns empty deliverable lists when a product is disabled everywhere", async () => {
    stubDb({
      products: [productRow({ deliverable_cities: [], deliverable_countries: [] })],
    });
    const res = await request(makeApp()).get("/api/products");
    const p = res.body.products[0];
    expect(p.deliverableCities).toEqual([]);
    expect(p.deliverableCountries).toEqual([]);
  });
});

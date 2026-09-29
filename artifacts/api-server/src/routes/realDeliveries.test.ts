import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const query = vi.fn();
vi.mock("../lib/db", () => ({ db: { query: (...args: unknown[]) => query(...args) } }));
vi.mock("../lib/apiKeyAuth", () => ({
  requireApiKey: (req: express.Request, _res: express.Response, next: express.NextFunction) => {
    (req as express.Request & { userId: string }).userId = "owner";
    next();
  },
}));
vi.mock("../lib/objectStorage", () => ({
  buildPublicObjectUrl: (key: string | null) => key ? `https://os.presentail.com/api/storage/public-objects/${key}` : null,
}));
import router from "./realDeliveries";

const app = express();
app.use(router);
const eligible = (id: string) => ({
  photo_id: id, asset_key: `real-deliveries/${id}.jpg`, capture_at: "2026-01-01T00:00:00.000Z",
  products: [{ id: 7, name: "Roses", image_key: "products/7.jpg" }], city: "Beirut", country: "LB",
});

describe("GET /storefront/real-deliveries", () => {
  beforeEach(() => query.mockReset());

  it("allows country-only, city-only, or unfiltered feeds", async () => {
    query.mockResolvedValue({ rows: [], rowCount: 0 });
    const res = await request(app).get("/storefront/real-deliveries?country=LB");
    expect(res.status).toBe(200);
    expect(query.mock.calls[0][1]).toEqual(["owner", "LB", null]);
  });

  it("returns a sparse collection without city, category, recipe, or inventory gates", async () => {
    query.mockResolvedValue({ rows: [eligible("a"), eligible("b")], rowCount: 2 });
    const res = await request(app).get("/storefront/real-deliveries?country=lb&city=beirut");
    expect(res.status).toBe(200);
    expect(res.body.photos).toHaveLength(2);
    const sql = String(query.mock.calls[0][0]);
    expect(sql).toContain("fpp.photo_set_rev=ofa.photo_set_rev");
    expect(sql).toContain("verification_status='approved'");
    expect(sql).not.toContain("product_recipes");
    expect(sql).not.toContain("product_catalog_categories");
    expect(sql).toContain("cityName");
  });

  it("returns only safe public URLs and no order data once threshold is met", async () => {
    query.mockResolvedValue({ rows: [eligible("a"), eligible("b"), eligible("c")], rowCount: 3 });
    const res = await request(app).get("/storefront/real-deliveries?country=LB&city=Beirut");
    expect(res.status).toBe(200);
    expect(res.body.photos).toHaveLength(3);
    expect(res.body.photos[0]).toMatchObject({
      photo_id: "a",
      asset_url: "https://os.presentail.com/api/storage/public-objects/real-deliveries/a.jpg",
      location: { country: "LB", city: "Beirut" },
      eligibility: { approved: true, completed: true },
      product: { id: 7, name: "Roses" },
      products: [{ id: 7, name: "Roses" }],
    });
    expect(JSON.stringify(res.body)).not.toContain("/objects/");
    expect(res.body.photos[0]).not.toHaveProperty("order_id");
  });

  it("fails closed when an unexpected asset key reaches the response mapper", async () => {
    query.mockResolvedValue({
      rows: [eligible("a"), eligible("b"), { ...eligible("c"), asset_key: "/objects/owner/private.jpg" }],
      rowCount: 3,
    });
    const res = await request(app).get("/storefront/real-deliveries?country=LB&city=Beirut");
    expect(res.status).toBe(200);
    expect(res.body.photos).toHaveLength(2);
    expect(res.body.photos.map((photo: { photo_id: string }) => photo.photo_id)).toEqual(["a", "b"]);
    expect(JSON.stringify(res.body)).not.toContain("/objects/");
  });

  it("sanitizes an unexpected optional product-image key", async () => {
    query.mockResolvedValue({
      rows: [eligible("a"), eligible("b"), {
        ...eligible("c"),
        products: [{ id: 7, name: "Roses", image_key: "/objects/owner/private.jpg" }],
      }],
      rowCount: 3,
    });
    const res = await request(app).get("/storefront/real-deliveries?country=LB&city=Beirut");
    expect(res.status).toBe(200);
    expect(res.body.photos[2].product.image_url).toBeNull();
    expect(res.body.photos[2].products[0].image_url).toBeNull();
  });
});
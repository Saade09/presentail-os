import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";
import type { WorkspaceRequest } from "../lib/workspace";

// ---------------------------------------------------------------------------
// Drizzle mock — queue-based, chainable builder pattern
//
// Each awaited Drizzle call (select/insert/update/execute) pops ONE entry
// from the queue in the order the route code enqueues them.
// ---------------------------------------------------------------------------

const drizzleQueue: unknown[][] = [];

function popResult(): unknown[] {
  return (drizzleQueue.shift() as unknown[]) ?? [];
}

/** Returns a thenable chain; all builder methods return `this`. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function makeChain(result: unknown[]): any {
  const p = Promise.resolve(result);
  const chain: Record<string, unknown> = {
    // Builder methods (all return chain)
    from: () => chain,
    where: () => chain,
    orderBy: () => chain,
    limit: () => chain,
    offset: () => chain,
    innerJoin: () => chain,
    set: () => chain,
    values: () => chain,
    // Terminal methods
    returning: () => p,
    onConflictDoUpdate: () => p,
    // Thenable — enables `await chain`
    then: (f: Parameters<typeof p.then>[0], r: Parameters<typeof p.then>[1]) => p.then(f, r),
    catch: (f: Parameters<typeof p.catch>[0]) => p.catch(f),
    finally: (f: Parameters<typeof p.finally>[0]) => p.finally(f),
  };
  return chain;
}

const mockDrizzleTransaction = vi.fn(
  async (cb: (tx: Record<string, unknown>) => Promise<unknown>) => {
    const tx: Record<string, unknown> = {
      insert: () => ({
        values: () => ({ onConflictDoUpdate: () => Promise.resolve() }),
      }),
    };
    return cb(tx);
  },
);

const mockDrizzleSelect = vi.fn(() => makeChain(popResult()));
const mockDrizzleInsert = vi.fn(() => makeChain(popResult()));
const mockDrizzleUpdate = vi.fn(() => makeChain(popResult()));
const mockDrizzleDelete = vi.fn(() => ({ where: () => Promise.resolve() }));
const mockDrizzleExecute = vi.fn(() => Promise.resolve({ rows: popResult() }));

vi.mock("../lib/drizzle", () => ({
  drizzleDb: {
    select: () => mockDrizzleSelect(),
    insert: () => mockDrizzleInsert(),
    update: () => mockDrizzleUpdate(),
    delete: () => mockDrizzleDelete(),
    execute: () => mockDrizzleExecute(),
    transaction: (...args: Parameters<typeof mockDrizzleTransaction>) =>
      mockDrizzleTransaction(...args),
  },
}));

// ---------------------------------------------------------------------------
// Remaining mocks
// ---------------------------------------------------------------------------

vi.mock("../lib/auth", () => ({
  requireAuth: (_req: express.Request, _res: express.Response, next: express.NextFunction) =>
    next(),
  authed: (req: express.Request) => req,
}));

let stubWorkspaceOwnerId = "owner_123";
let stubWorkspaceRole: "owner" | "member" = "owner";
let stubAllowedPages: string[] | null = null;

vi.mock("../lib/workspace", () => ({
  resolveWorkspace: (
    req: express.Request,
    _res: express.Response,
    next: express.NextFunction,
  ) => {
    const wreq = req as unknown as WorkspaceRequest;
    wreq.workspaceOwnerId = stubWorkspaceOwnerId;
    wreq.workspaceRole = stubWorkspaceRole;
    wreq.workspaceActualRole = stubWorkspaceRole;
    wreq.allowedPages = stubAllowedPages;
    next();
  },
  workspace: (req: express.Request) => req as unknown as WorkspaceRequest,
}));

vi.mock("../lib/logger", () => ({
  logger: { error: vi.fn(), info: vi.fn(), warn: vi.fn() },
}));

vi.mock("../lib/catalogWebhook", () => ({
  fireCatalogAttributeWebhook: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../lib/objectStorage", () => ({
  objectStorageService: {
    copyPrivateObjectToPublic: vi.fn().mockResolvedValue("occasions/1.jpg"),
  },
  buildPublicObjectUrl: (p: string | null | undefined) =>
    p ? `https://os.presentail.com/api/storage/public-objects/${p}` : null,
}));

import catalogAttributesRouter from "./catalogAttributes";
import { fireCatalogAttributeWebhook } from "../lib/catalogWebhook";
import { objectStorageService } from "../lib/objectStorage";

const mockFireWebhook = vi.mocked(fireCatalogAttributeWebhook);
const mockCopyToPublic = vi.mocked(objectStorageService.copyPrivateObjectToPublic);

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (
      req as unknown as {
        log: {
          error: (...a: unknown[]) => void;
          warn: (...a: unknown[]) => void;
          info: (...a: unknown[]) => void;
        };
      }
    ).log = { error: () => {}, warn: () => {}, info: () => {} };
    next();
  });
  app.use(catalogAttributesRouter);
  return app;
}

/** Full row shape returned by the LIST and GET endpoints (snake_case API keys). */
function makeAttrRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 1,
    workspace_owner_id: "owner_123",
    name: "Birthday",
    slug: "birthday",
    description: null,
    image_url: null,
    image_public_path: null,
    sort_order: 0,
    is_active: true,
    created_at: "2024-01-01T00:00:00.000Z",
    updated_at: "2024-01-01T00:00:00.000Z",
    product_count: "0",
    enabled_city_count: "0",
    ...overrides,
  };
}

/** Minimal inserted row returned by INSERT … RETURNING (camelCase from Drizzle). */
function makeInsertedRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 1,
    workspaceOwnerId: "owner_123",
    name: "New Item",
    slug: "new-item",
    description: null,
    imageUrl: null,
    imagePublicPath: null,
    sortOrder: 0,
    isActive: true,
    createdAt: new Date("2024-01-01"),
    updatedAt: new Date("2024-01-01"),
    ...overrides,
  };
}

const ATTR_TYPES = [
  "occasions",
  "catalog_categories",
  "catalog_brands",
  "recipients",
] as const;

const PAGE_KEYS: Record<
  (typeof ATTR_TYPES)[number],
  { read: string; create: string; edit: string; delete: string }
> = {
  occasions: {
    read: "catalog-occasions",
    create: "catalog-occasions.create",
    edit: "catalog-occasions.edit",
    delete: "catalog-occasions.delete",
  },
  catalog_categories: {
    read: "catalog-categories-attr",
    create: "catalog-categories-attr.create",
    edit: "catalog-categories-attr.edit",
    delete: "catalog-categories-attr.delete",
  },
  catalog_brands: {
    read: "catalog-brands-attr",
    create: "catalog-brands-attr.create",
    edit: "catalog-brands-attr.edit",
    delete: "catalog-brands-attr.delete",
  },
  recipients: {
    read: "catalog-recipients",
    create: "catalog-recipients.create",
    edit: "catalog-recipients.edit",
    delete: "catalog-recipients.delete",
  },
};

beforeEach(() => {
  vi.clearAllMocks();
  drizzleQueue.length = 0;
  stubWorkspaceRole = "owner";
  stubWorkspaceOwnerId = "owner_123";
  stubAllowedPages = null;
});

// ---------------------------------------------------------------------------
// Tests — per attribute type
// ---------------------------------------------------------------------------

for (const type of ATTR_TYPES) {
  const pk = PAGE_KEYS[type];

  describe(`/${type}`, () => {
    // ── LIST ──────────────────────────────────────────────────────────────

    describe("GET /:type — list", () => {
      it("returns items and total for owner", async () => {
        const row = makeAttrRow();
        // Promise.all runs count query first, then list query
        drizzleQueue.push([{ total: "1" }]); // COUNT
        drizzleQueue.push([row]);              // SELECT list

        const app = makeApp();
        const res = await request(app).get(`/${type}`);

        expect(res.status).toBe(200);
        expect(res.body.items).toHaveLength(1);
        expect(res.body.total).toBe(1);
        expect(res.body.items[0].name).toBe("Birthday");
        expect(res.body.items[0].image_public_url).toBeNull();
        expect(res.body.items[0]).not.toHaveProperty("image_public_path");
      });

      it("maps image_public_path to an absolute image_public_url in the list", async () => {
        const row = makeAttrRow({ image_public_path: `${type}/1.jpg` });
        drizzleQueue.push([{ total: "1" }]); // COUNT
        drizzleQueue.push([row]);              // SELECT list

        const app = makeApp();
        const res = await request(app).get(`/${type}`);

        expect(res.status).toBe(200);
        expect(res.body.items[0].image_public_url).toBe(
          `https://os.presentail.com/api/storage/public-objects/${type}/1.jpg`,
        );
        expect(res.body.items[0]).not.toHaveProperty("image_public_path");
      });

      it("filters by search query q=", async () => {
        drizzleQueue.push([{ total: "0" }]);
        drizzleQueue.push([]);

        const app = makeApp();
        const res = await request(app).get(`/${type}?q=birthday`);

        expect(res.status).toBe(200);
        expect(res.body.items).toHaveLength(0);
      });

      it("filters by status=active", async () => {
        drizzleQueue.push([{ total: "0" }]);
        drizzleQueue.push([]);

        const app = makeApp();
        const res = await request(app).get(`/${type}?status=active`);

        expect(res.status).toBe(200);
      });
    });

    // ── CREATE ────────────────────────────────────────────────────────────

    describe("POST /:type — create", () => {
      it("creates an item and returns 201 for owner", async () => {
        drizzleQueue.push([]);                       // slug uniqueness check → no conflict
        drizzleQueue.push([makeInsertedRow()]);      // INSERT RETURNING

        const app = makeApp();
        const res = await request(app).post(`/${type}`).send({ name: "New Item" });

        expect(res.status).toBe(201);
        expect(res.body.item.name).toBe("New Item");
        expect(res.body.item).toHaveProperty("image_public_url", null);
      });

      it("returns 403 for non-owner without permission", async () => {
        stubWorkspaceRole = "member";
        stubAllowedPages = [];
        const app = makeApp();
        const res = await request(app).post(`/${type}`).send({ name: "New Item" });
        expect(res.status).toBe(403);
      });

      it("allows member with create sub-permission to POST", async () => {
        stubWorkspaceRole = "member";
        stubAllowedPages = [pk.create];
        drizzleQueue.push([]);
        drizzleQueue.push([makeInsertedRow()]);

        const app = makeApp();
        const res = await request(app).post(`/${type}`).send({ name: "New Item" });

        expect(res.status).toBe(201);
        expect(res.body.item.name).toBe("New Item");
      });

      it("returns 409 when slug already exists", async () => {
        drizzleQueue.push([{ id: 99 }]); // slug check → conflict found

        const app = makeApp();
        const res = await request(app)
          .post(`/${type}`)
          .send({ name: "Birthday", slug: "birthday" });

        expect(res.status).toBe(409);
      });

      it("returns 400 when name is missing", async () => {
        const app = makeApp();
        const res = await request(app).post(`/${type}`).send({});
        expect(res.status).toBe(400);
      });
    });

    // ── GET BY ID ─────────────────────────────────────────────────────────

    describe("GET /:type/:id — get by id", () => {
      it("returns 200 with item for valid id", async () => {
        const row = makeAttrRow();
        drizzleQueue.push([row]); // SELECT with embedded count subqueries

        const app = makeApp();
        const res = await request(app).get(`/${type}/1`);

        expect(res.status).toBe(200);
        expect(res.body.item.id).toBe(1);
        expect(res.body.item.image_public_url).toBeNull();
        expect(res.body.item).not.toHaveProperty("image_public_path");
      });

      it("returns an absolute image_public_url when the item has a public image", async () => {
        const row = makeAttrRow({ image_public_path: `${type}/1.jpg` });
        drizzleQueue.push([row]);

        const app = makeApp();
        const res = await request(app).get(`/${type}/1`);

        expect(res.status).toBe(200);
        expect(res.body.item.image_public_url).toBe(
          `https://os.presentail.com/api/storage/public-objects/${type}/1.jpg`,
        );
        expect(res.body.item).not.toHaveProperty("image_public_path");
      });

      it("returns 404 when not found", async () => {
        drizzleQueue.push([]); // empty result

        const app = makeApp();
        const res = await request(app).get(`/${type}/999`);

        expect(res.status).toBe(404);
      });

      it("returns 400 for invalid id", async () => {
        const app = makeApp();
        const res = await request(app).get(`/${type}/not-a-number`);
        expect(res.status).toBe(400);
      });
    });

    // ── PATCH ─────────────────────────────────────────────────────────────

    describe("PATCH /:type/:id — update", () => {
      it("returns 200 with updated item for owner", async () => {
        drizzleQueue.push([{ id: 1 }]); // existence check
        // No slug check (sending name only, no slug field)
        drizzleQueue.push([makeInsertedRow({ name: "Updated" })]); // UPDATE RETURNING

        const app = makeApp();
        const res = await request(app).patch(`/${type}/1`).send({ name: "Updated" });

        expect(res.status).toBe(200);
        expect(res.body.item.name).toBe("Updated");
      });

      it("returns 403 for non-owner without permission", async () => {
        stubWorkspaceRole = "member";
        stubAllowedPages = [];
        const app = makeApp();
        const res = await request(app).patch(`/${type}/1`).send({ name: "X" });
        expect(res.status).toBe(403);
      });

      it("allows member with edit sub-permission to PATCH", async () => {
        stubWorkspaceRole = "member";
        stubAllowedPages = [pk.edit];
        drizzleQueue.push([{ id: 1 }]);
        drizzleQueue.push([makeInsertedRow({ name: "Updated" })]);

        const app = makeApp();
        const res = await request(app).patch(`/${type}/1`).send({ name: "Updated" });
        expect(res.status).toBe(200);
        expect(res.body.item.name).toBe("Updated");
      });

      it("returns 404 when item not found", async () => {
        drizzleQueue.push([]); // existence check → not found

        const app = makeApp();
        const res = await request(app).patch(`/${type}/999`).send({ name: "X" });
        expect(res.status).toBe(404);
      });

      if (type === "occasions" || type === "catalog_categories") {
        const eventSuffix = type === "occasions" ? "occasion" : "catalog_category";

        it(`fires the updated webhook with featured/image fields for ${type}`, async () => {
          drizzleQueue.push([{ id: 1 }]); // existence check
          drizzleQueue.push([
            makeInsertedRow({ isFeatured: true, imageUrl: "https://cdn.example.com/x.png" }),
          ]); // UPDATE RETURNING

          const app = makeApp();
          const res = await request(app).patch(`/${type}/1`).send({ is_featured: true });
          expect(res.status).toBe(200);

          expect(mockFireWebhook).toHaveBeenCalledWith(
            `catalog_attribute.${eventSuffix}.updated`,
            type,
            expect.objectContaining({
              featured: true,
              image: "https://cdn.example.com/x.png",
              is_featured: true,
              image_url: "https://cdn.example.com/x.png",
            }),
            expect.anything(),
          );
        });

        it(`fires featured=false and image=null when ${type} is not featured and has no image`, async () => {
          drizzleQueue.push([{ id: 1 }]); // existence check
          drizzleQueue.push([makeInsertedRow({ isFeatured: false, imageUrl: null })]); // UPDATE RETURNING

          const app = makeApp();
          const res = await request(app).patch(`/${type}/1`).send({ is_featured: false });
          expect(res.status).toBe(200);

          expect(mockFireWebhook).toHaveBeenCalledWith(
            `catalog_attribute.${eventSuffix}.updated`,
            type,
            expect.objectContaining({ featured: false, image: null }),
            expect.anything(),
          );
        });

      }

      it("copies the image into the public bucket when image_url is set on PATCH", async () => {
        drizzleQueue.push([{ id: 1 }]); // existence check
        drizzleQueue.push([
          makeInsertedRow({ imageUrl: "https://cdn.example.com/x.png" }),
        ]); // UPDATE RETURNING
        drizzleQueue.push([]); // syncAttributePublicImage UPDATE imagePublicPath

        const app = makeApp();
        const res = await request(app)
          .patch(`/${type}/1`)
          .send({ image_url: "https://cdn.example.com/x.png" });

        expect(res.status).toBe(200);
        expect(mockCopyToPublic).toHaveBeenCalledWith(
          "https://cdn.example.com/x.png",
          `${type}/1`,
          "owner_123",
        );
      });

      it("clears the public image (no copy) when image_url is set to null on PATCH", async () => {
        drizzleQueue.push([{ id: 1 }]); // existence check
        drizzleQueue.push([makeInsertedRow({ imageUrl: null })]); // UPDATE RETURNING
        drizzleQueue.push([]); // syncAttributePublicImage UPDATE imagePublicPath=null

        const app = makeApp();
        const res = await request(app).patch(`/${type}/1`).send({ image_url: null });

        expect(res.status).toBe(200);
        expect(mockCopyToPublic).not.toHaveBeenCalled();
      });

      it("copies the image into the public bucket when image_url is set on CREATE", async () => {
        drizzleQueue.push([]); // slug uniqueness check → no conflict
        drizzleQueue.push([
          makeInsertedRow({ imageUrl: "https://cdn.example.com/new.png" }),
        ]); // INSERT RETURNING
        drizzleQueue.push([]); // syncAttributePublicImage UPDATE imagePublicPath

        const app = makeApp();
        const res = await request(app)
          .post(`/${type}`)
          .send({ name: "New Item", image_url: "https://cdn.example.com/new.png" });

        expect(res.status).toBe(201);
        expect(mockCopyToPublic).toHaveBeenCalledWith(
          "https://cdn.example.com/new.png",
          `${type}/1`,
          "owner_123",
        );
      });
    });

    // ── DELETE ────────────────────────────────────────────────────────────

    describe("DELETE /:type/:id — delete", () => {
      it("deletes item with no products and returns success", async () => {
        drizzleQueue.push([{ id: 1 }]); // existence check (select)
        // execute() for product count check — push inner rows array
        drizzleQueue.push([{ count: "0" }]); // product count check (execute)

        const app = makeApp();
        const res = await request(app).delete(`/${type}/1`);

        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
      });

      it("returns 409 when item has assigned products", async () => {
        drizzleQueue.push([{ id: 1 }]);       // existence check
        drizzleQueue.push([{ count: "3" }]);  // product count check

        const app = makeApp();
        const res = await request(app).delete(`/${type}/1`);

        expect(res.status).toBe(409);
        expect(res.body.error).toMatch(/3 product/i);
      });

      it("returns 403 for non-owner without permission", async () => {
        stubWorkspaceRole = "member";
        stubAllowedPages = [];
        const app = makeApp();
        const res = await request(app).delete(`/${type}/1`);
        expect(res.status).toBe(403);
      });

      it("allows member with delete sub-permission to DELETE", async () => {
        stubWorkspaceRole = "member";
        stubAllowedPages = [pk.delete];
        drizzleQueue.push([{ id: 1 }]);
        drizzleQueue.push([{ count: "0" }]);

        const app = makeApp();
        const res = await request(app).delete(`/${type}/1`);
        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
      });
    });

    // ── GET city-availability ─────────────────────────────────────────────

    describe("GET /:type/:id/city-availability", () => {
      it("returns list of cities with availability and summary counts", async () => {
        const cityRow = {
          city_id: 1,
          city_name: "Dubai",
          country_code: "AE",
          city_slug: "dubai",
          city_is_active: true,
          is_enabled: true,
          updated_at: null,
        };
        const cityRow2 = {
          city_id: 2,
          city_name: "Abu Dhabi",
          country_code: "AE",
          city_slug: "abu-dhabi",
          city_is_active: true,
          is_enabled: false,
          updated_at: null,
        };
        drizzleQueue.push([{ id: 1 }]);              // existence check (select)
        drizzleQueue.push([cityRow, cityRow2]);        // city query (execute)

        const app = makeApp();
        const res = await request(app).get(`/${type}/1/city-availability`);

        expect(res.status).toBe(200);
        expect(res.body.cities).toHaveLength(2);
        expect(res.body.cities[0].city_name).toBe("Dubai");
        expect(res.body.total_cities).toBe(2);
        expect(res.body.enabled_count).toBe(1);
      });

      it("returns enabled_count=0 and total_cities=0 when workspace has no delivery cities", async () => {
        drizzleQueue.push([{ id: 1 }]); // existence check
        drizzleQueue.push([]);           // no cities

        const app = makeApp();
        const res = await request(app).get(`/${type}/1/city-availability`);

        expect(res.status).toBe(200);
        expect(res.body.cities).toHaveLength(0);
        expect(res.body.total_cities).toBe(0);
        expect(res.body.enabled_count).toBe(0);
      });

      it("returns 404 when attribute not found", async () => {
        drizzleQueue.push([]); // existence check → empty

        const app = makeApp();
        const res = await request(app).get(`/${type}/999/city-availability`);

        expect(res.status).toBe(404);
      });
    });

    // ── PUT city-availability ─────────────────────────────────────────────

    describe("PUT /:type/:id/city-availability", () => {
      it("upserts city availability for valid cities", async () => {
        drizzleQueue.push([{ id: 1 }]);  // existence check (select)
        drizzleQueue.push([{ id: 10 }]); // valid cities check (execute)
        // transaction uses mocked tx that resolves without queue pops

        const app = makeApp();
        const res = await request(app)
          .put(`/${type}/1/city-availability`)
          .send([{ city_id: 10, is_enabled: true }]);

        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
      });

      it("returns 403 for non-owner", async () => {
        stubWorkspaceRole = "member";
        const app = makeApp();
        const res = await request(app).put(`/${type}/1/city-availability`).send([]);
        expect(res.status).toBe(403);
      });
    });

    // ── PATCH city-availability/bulk ──────────────────────────────────────

    describe("PATCH /:type/:id/city-availability/bulk", () => {
      it("enables all cities for the attribute", async () => {
        drizzleQueue.push([{ id: 1 }]);              // existence check (select)
        drizzleQueue.push([{ id: 10 }, { id: 11 }]); // all cities (execute)
        // transaction resolves without queue pops

        const app = makeApp();
        const res = await request(app)
          .patch(`/${type}/1/city-availability/bulk`)
          .send({ enable_all: true });

        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
      });

      it("returns 400 when enable_all is missing", async () => {
        drizzleQueue.push([{ id: 1 }]); // existence check

        const app = makeApp();
        const res = await request(app)
          .patch(`/${type}/1/city-availability/bulk`)
          .send({});
        expect(res.status).toBe(400);
      });

      it("returns 403 for non-owner", async () => {
        stubWorkspaceRole = "member";
        const app = makeApp();
        const res = await request(app)
          .patch(`/${type}/1/city-availability/bulk`)
          .send({ enable_all: true });
        expect(res.status).toBe(403);
      });
    });
  });
}

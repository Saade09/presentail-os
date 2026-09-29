/**
 * Real-PostgreSQL integration coverage for the product create/update routes.
 *
 * Auth and workspace resolution are stubbed, while the route's database access
 * and a subsequent independent read use PostgreSQL.  The suite is skipped
 * without DATABASE_URL so it remains safe for normal unit-test runs.
 */
import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import express from "express";
import request from "supertest";
import pg from "pg";
import type { WorkspaceRequest } from "../lib/workspace";

const { Pool } = pg;
const DATABASE_URL = process.env.DATABASE_URL;

const OWNER_A = "__test_products_create_update_a__";
const OWNER_B = "__test_products_create_update_b__";
let activeWorkspaceOwner = OWNER_A;
let activeWorkspaceRole: "owner" | "member" = "owner";

vi.mock("../lib/auth", () => ({
  requireAuth: (_req: express.Request, _res: express.Response, next: express.NextFunction) => next(),
  authed: (req: express.Request) => req,
}));

vi.mock("../lib/workspace", () => ({
  resolveWorkspace: (
    req: express.Request,
    _res: express.Response,
    next: express.NextFunction,
  ) => {
    const wreq = req as unknown as WorkspaceRequest;
    wreq.workspaceOwnerId = activeWorkspaceOwner;
    wreq.workspaceRole = activeWorkspaceRole;
    wreq.workspaceActualRole = activeWorkspaceRole;
    wreq.allowedPages = [];
    wreq.userId = "__test_products_user__";
    wreq.userEmail = "products-integration@example.com";
    next();
  },
  workspace: (req: express.Request) => req as unknown as WorkspaceRequest,
  hasPageAccess: () => true,
}));

vi.mock("../lib/logger", () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn().mockReturnThis(),
  },
}));

// Every fire-and-forget integration rejects deliberately.  The HTTP request
// must still succeed, and the row must remain committed.
vi.mock("../lib/merchantSyncQueue", () => ({
  enqueueProductCreateOrUpdateSync: vi.fn(() => Promise.reject(new Error("merchant unavailable"))),
  enqueueProductDeleteSync: vi.fn(() => Promise.reject(new Error("merchant unavailable"))),
  enqueueMerchantSyncBackfill: vi.fn(),
  enqueueSelectedMerchantSync: vi.fn(),
  enqueueSelectedMerchantUnsync: vi.fn(),
}));
vi.mock("../lib/productPublishing", () => ({
  autoPublishToChannels: vi.fn(() => Promise.reject(new Error("publishing unavailable"))),
  notifyProductChanged: vi.fn(() => Promise.reject(new Error("notifications unavailable"))),
}));
vi.mock("../lib/catalogWebhook", () => ({
  fireCatalogDataWebhook: vi.fn(() => Promise.reject(new Error("webhook unavailable"))),
}));
vi.mock("../lib/productPublicImages", () => ({
  syncProductPublicImages: vi.fn(() => Promise.reject(new Error("image sync unavailable"))),
}));
vi.mock("../lib/locationSetup", () => ({
  maybeAutoActivateLocationsByBrand: vi.fn(() => Promise.reject(new Error("locations unavailable"))),
}));
vi.mock("../lib/objectStorage", () => ({
  buildPublicObjectUrl: vi.fn(() => null),
  objectStorageClient: { bucket: vi.fn() },
}));

import productsRouter from "./products";

function makeApp(): express.Express {
  const app = express();
  app.use(express.json());
  app.use(productsRouter);
  return app;
}

describe.skipIf(!DATABASE_URL)("POST/PATCH /products — PostgreSQL integration", () => {
  let pool: InstanceType<typeof Pool>;
  let app: express.Express;
  let productId: number;

  beforeAll(async () => {
    pool = new Pool({ connectionString: DATABASE_URL });
    app = makeApp();
    await pool.query("DELETE FROM products WHERE workspace_owner_id IN ($1, $2)", [OWNER_A, OWNER_B]);
  });

  afterAll(async () => {
    if (!pool) return;
    await pool.query("DELETE FROM products WHERE workspace_owner_id IN ($1, $2)", [OWNER_A, OWNER_B]);
    await pool.end();
  });

  it("creates a product, then reads the committed row from a fresh database query", async () => {
    activeWorkspaceOwner = OWNER_A;
    activeWorkspaceRole = "owner";

    const response = await request(app).post("/products").send({
      name: "Integration Created Product",
      price_usd: 12.5,
      price_aed: 46,
      description: "created through HTTP",
      status: "available",
      tags: ["integration", "round-trip"],
    });

    expect(response.status).toBe(201);
    expect(response.body.product).toMatchObject({
      name: "Integration Created Product",
      description: "created through HTTP",
    });
    productId = Number(response.body.product.id);

    const fresh = await pool.query<{
      workspace_owner_id: string;
      name: string;
      price_usd: string;
      price_aed: string;
      description: string;
    }>(
      `SELECT workspace_owner_id, name, price_usd, price_aed, description
         FROM products WHERE id = $1`,
      [productId],
    );
    expect(fresh.rows).toHaveLength(1);
    expect(fresh.rows[0]).toMatchObject({
      workspace_owner_id: OWNER_A,
      name: "Integration Created Product",
      price_usd: "12.50",
      price_aed: "46.00",
      description: "created through HTTP",
    });
  });

  it("updates through PATCH, then reads the updated values from a fresh database query", async () => {
    activeWorkspaceOwner = OWNER_A;
    activeWorkspaceRole = "owner";

    const response = await request(app).patch(`/products/${productId}`).send({
      name: "Integration Updated Product",
      price_usd: 19.75,
      price_aed: 72,
      description: "updated through HTTP",
      tags: ["updated"],
    });

    expect(response.status).toBe(200);
    expect(response.body.product).toMatchObject({
      id: productId,
      name: "Integration Updated Product",
      description: "updated through HTTP",
    });

    const fresh = await pool.query<{
      workspace_owner_id: string;
      name: string;
      price_usd: string;
      price_aed: string;
      description: string;
      tags: string[];
    }>(
      `SELECT workspace_owner_id, name, price_usd, price_aed, description, tags
         FROM products WHERE id = $1`,
      [productId],
    );
    expect(fresh.rows[0]).toMatchObject({
      workspace_owner_id: OWNER_A,
      name: "Integration Updated Product",
      price_usd: "19.75",
      price_aed: "72.00",
      description: "updated through HTTP",
      tags: ["updated"],
    });
  });

  it("does not expose or update another workspace's product, and rejects unauthorized management", async () => {
    activeWorkspaceOwner = OWNER_B;
    activeWorkspaceRole = "owner";

    const crossWorkspaceRead = await request(app).get(`/products/${productId}`);
    expect(crossWorkspaceRead.status).toBe(404);
    const crossWorkspacePatch = await request(app)
      .patch(`/products/${productId}`)
      .send({ name: "Must Not Change" });
    expect(crossWorkspacePatch.status).toBe(404);

    activeWorkspaceOwner = OWNER_A;
    activeWorkspaceRole = "member";
    const unauthorizedCreate = await request(app).post("/products").send({
      name: "Unauthorized Product",
      price_usd: 1,
      price_aed: 4,
    });
    expect(unauthorizedCreate.status).toBe(403);
  });
});
import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";

// ---------------------------------------------------------------------------
// Drizzle mock — queue-based, chainable builder pattern
//
// Both `select()` and `execute()` pop from the same queue in call order.
// `select()` awaited result → the popped array directly.
// `execute()` result      → { rows: <popped array> }
// ---------------------------------------------------------------------------

const drizzleQueue: unknown[][] = [];

function popResult(): unknown[] {
  return (drizzleQueue.shift() as unknown[]) ?? [];
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function makeChain(result: unknown[]): any {
  const p = Promise.resolve(result);
  const chain: Record<string, unknown> = {
    from: () => chain,
    where: () => chain,
    orderBy: () => chain,
    limit: () => chain,
    offset: () => chain,
    innerJoin: () => chain,
    set: () => chain,
    values: () => chain,
    returning: () => p,
    onConflictDoUpdate: () => p,
    then: (f: Parameters<typeof p.then>[0], r: Parameters<typeof p.then>[1]) => p.then(f, r),
    catch: (f: Parameters<typeof p.catch>[0]) => p.catch(f),
    finally: (f: Parameters<typeof p.finally>[0]) => p.finally(f),
  };
  return chain;
}

const mockResolveApiKeyWorkspace = vi.fn();

vi.mock("../lib/drizzle", () => ({
  drizzleDb: {
    select: () => makeChain(popResult()),
    insert: () => makeChain(popResult()),
    update: () => makeChain(popResult()),
    delete: () => ({ where: () => Promise.resolve() }),
    execute: () => Promise.resolve({ rows: popResult() }),
    transaction: async (cb: (tx: unknown) => Promise<unknown>) => cb({}),
  },
}));

vi.mock("../lib/logger", () => ({
  logger: { error: vi.fn(), info: vi.fn(), warn: vi.fn() },
}));

vi.mock("../lib/apiKeyAuth", () => ({
  resolveApiKeyWorkspace: (...args: unknown[]) => mockResolveApiKeyWorkspace(...args),
}));

import catalogAttributesPublicRouter from "./catalogAttributesPublic";

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
  app.use(catalogAttributesPublicRouter);
  return app;
}

// ---------------------------------------------------------------------------
// Shared workspace resolution behaviour (tested via /catalog-attributes)
// ---------------------------------------------------------------------------

describe("workspace resolution (via GET /catalog-attributes)", () => {
  const app = makeApp();

  beforeEach(() => {
    vi.clearAllMocks();
    drizzleQueue.length = 0;
    mockResolveApiKeyWorkspace.mockResolvedValue(null);
  });

  it("400 when no workspace identifier is provided and no API key supplied", async () => {
    const res = await request(app).get("/catalog-attributes");
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/city_id.*city_slug.*workspace_owner_id/i);
  });

  it("400 when API key is invalid and no query param is present", async () => {
    mockResolveApiKeyWorkspace.mockResolvedValue(null);
    const res = await request(app)
      .get("/catalog-attributes")
      .set("Authorization", "Bearer pk_live_invalid");
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/city_id.*city_slug.*workspace_owner_id/i);
  });

  it("resolves workspace from a valid API key when no query params provided", async () => {
    mockResolveApiKeyWorkspace.mockResolvedValue("owner_from_key");
    // Four parallel fetchAttributes calls — each returns empty list
    drizzleQueue.push([], [], [], []);

    const res = await request(app)
      .get("/catalog-attributes")
      .set("Authorization", "Bearer pk_live_somekey");

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ occasions: [], categories: [], brands: [], recipients: [] });
  });

  it("workspace_owner_id query param works without an API key", async () => {
    drizzleQueue.push([], [], [], []);
    const res = await request(app).get("/catalog-attributes?workspace_owner_id=owner_param");
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ occasions: [], categories: [], brands: [], recipients: [] });
  });

  it("workspace_owner_id query param takes precedence over API key when both supplied", async () => {
    mockResolveApiKeyWorkspace.mockResolvedValue("owner_from_key");
    drizzleQueue.push([], [], [], []);

    const res = await request(app)
      .get("/catalog-attributes?workspace_owner_id=owner_from_param")
      .set("Authorization", "Bearer pk_live_somekey");

    expect(res.status).toBe(200);
    // workspace_owner_id is resolved before the API key fallback path,
    // so resolveApiKeyWorkspace should NOT have been called at all.
    expect(mockResolveApiKeyWorkspace).not.toHaveBeenCalled();
  });

  it("resolves workspace from city_slug (ignores API key for workspace resolution)", async () => {
    mockResolveApiKeyWorkspace.mockResolvedValue("owner_from_key");
    // execute() for city slug lookup — push inner rows
    drizzleQueue.push([{ id: 7, workspace_owner_id: "owner_from_city" }]);
    // Four attribute selects
    drizzleQueue.push([], [], [], []);

    const res = await request(app)
      .get("/catalog-attributes?city_slug=beirut")
      .set("Authorization", "Bearer pk_live_somekey");

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ occasions: [], categories: [], brands: [], recipients: [] });
  });

  it("404 when city_slug does not match an active city", async () => {
    // execute() for city slug lookup returns empty
    drizzleQueue.push([]);

    const res = await request(app).get("/catalog-attributes?city_slug=nowhere");

    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/nowhere/i);
  });
});

// ---------------------------------------------------------------------------
// GET /catalog-attributes/occasions
// ---------------------------------------------------------------------------

describe("GET /catalog-attributes/occasions", () => {
  const app = makeApp();

  beforeEach(() => {
    vi.clearAllMocks();
    drizzleQueue.length = 0;
    mockResolveApiKeyWorkspace.mockResolvedValue(null);
  });

  it("400 without workspace identifier or API key", async () => {
    const res = await request(app).get("/catalog-attributes/occasions");
    expect(res.status).toBe(400);
  });

  it("resolves workspace from API key and returns occasions", async () => {
    mockResolveApiKeyWorkspace.mockResolvedValue("owner_key");
    drizzleQueue.push([
      { id: 1, name: "Birthday", slug: "birthday", description: null, image_url: null, sort_order: 0 },
    ]);

    const res = await request(app)
      .get("/catalog-attributes/occasions")
      .set("Authorization", "Bearer pk_live_key");

    expect(res.status).toBe(200);
    expect(res.body.occasions).toHaveLength(1);
    expect(res.body.occasions[0].slug).toBe("birthday");
  });

  it("exposes image_public_url for occasions (built from image_public_path, null when absent)", async () => {
    mockResolveApiKeyWorkspace.mockResolvedValue("owner_key");
    drizzleQueue.push([
      {
        id: 1,
        name: "Birthday",
        slug: "birthday",
        description: null,
        image_url: "https://cdn.example.com/birthday.png",
        image_public_path: "occasions/1.jpg",
        sort_order: 0,
      },
      {
        id: 2,
        name: "Anniversary",
        slug: "anniversary",
        description: null,
        image_url: null,
        image_public_path: null,
        sort_order: 1,
      },
    ]);

    const res = await request(app)
      .get("/catalog-attributes/occasions")
      .set("Authorization", "Bearer pk_live_key");

    expect(res.status).toBe(200);
    const [first, second] = res.body.occasions;
    expect(first.image_public_url).toBe(
      "https://os.presentail.com/api/storage/public-objects/occasions/1.jpg",
    );
    expect(second.image_public_url).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// GET /catalog-attributes/categories
// ---------------------------------------------------------------------------

describe("GET /catalog-attributes/categories", () => {
  const app = makeApp();

  beforeEach(() => {
    vi.clearAllMocks();
    drizzleQueue.length = 0;
    mockResolveApiKeyWorkspace.mockResolvedValue(null);
  });

  it("400 without workspace identifier or API key", async () => {
    const res = await request(app).get("/catalog-attributes/categories");
    expect(res.status).toBe(400);
  });

  it("resolves workspace from API key and returns categories", async () => {
    mockResolveApiKeyWorkspace.mockResolvedValue("owner_key");
    drizzleQueue.push([
      { id: 2, name: "Flowers", slug: "flowers", description: null, image_url: null, sort_order: 1 },
    ]);

    const res = await request(app)
      .get("/catalog-attributes/categories")
      .set("Authorization", "Bearer pk_live_key");

    expect(res.status).toBe(200);
    expect(res.body.categories).toHaveLength(1);
    expect(res.body.categories[0].slug).toBe("flowers");
  });

  it("exposes image_public_url for categories (built from image_public_path, null when absent)", async () => {
    mockResolveApiKeyWorkspace.mockResolvedValue("owner_key");
    drizzleQueue.push([
      {
        id: 2,
        name: "Flowers",
        slug: "flowers",
        description: null,
        image_url: "https://cdn.example.com/flowers.png",
        image_public_path: "catalog_categories/2.jpg",
        sort_order: 0,
      },
      {
        id: 3,
        name: "Cakes",
        slug: "cakes",
        description: null,
        image_url: null,
        image_public_path: null,
        sort_order: 1,
      },
    ]);

    const res = await request(app)
      .get("/catalog-attributes/categories")
      .set("Authorization", "Bearer pk_live_key");

    expect(res.status).toBe(200);
    const [first, second] = res.body.categories;
    expect(first.image_public_url).toBe(
      "https://os.presentail.com/api/storage/public-objects/catalog_categories/2.jpg",
    );
    expect(second.image_public_url).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// GET /catalog-attributes/brands
// ---------------------------------------------------------------------------

describe("GET /catalog-attributes/brands", () => {
  const app = makeApp();

  beforeEach(() => {
    vi.clearAllMocks();
    drizzleQueue.length = 0;
    mockResolveApiKeyWorkspace.mockResolvedValue(null);
  });

  it("400 without workspace identifier or API key", async () => {
    const res = await request(app).get("/catalog-attributes/brands");
    expect(res.status).toBe(400);
  });

  it("resolves workspace from API key and returns brands", async () => {
    mockResolveApiKeyWorkspace.mockResolvedValue("owner_key");
    drizzleQueue.push([
      { id: 3, name: "Acme", slug: "acme", description: null, image_url: null, sort_order: 0 },
    ]);

    const res = await request(app)
      .get("/catalog-attributes/brands")
      .set("Authorization", "Bearer pk_live_key");

    expect(res.status).toBe(200);
    expect(res.body.brands).toHaveLength(1);
    expect(res.body.brands[0].slug).toBe("acme");
  });

  it("default-on: city-filtered request returns brands not explicitly disabled for the city", async () => {
    // city_id + workspace_owner_id resolves directly (no execute lookup).
    // The cityId branch issues a notExists subquery select (popped first,
    // ignored) followed by the main select (popped second → returned rows).
    drizzleQueue.push([]); // notExists(disabled-for-city) subquery select
    drizzleQueue.push([
      { id: 3, name: "Acme", slug: "acme", description: null, image_url: null, sort_order: 0 },
    ]); // main select — default-on results

    const res = await request(app).get(
      "/catalog-attributes/brands?city_id=7&workspace_owner_id=owner_param",
    );

    expect(res.status).toBe(200);
    expect(res.body.brands).toHaveLength(1);
    expect(res.body.brands[0].slug).toBe("acme");
  });

  it("exposes image_public_url for brands (built from image_public_path, null when absent)", async () => {
    mockResolveApiKeyWorkspace.mockResolvedValue("owner_key");
    drizzleQueue.push([
      {
        id: 3,
        name: "Acme",
        slug: "acme",
        description: null,
        image_url: "https://cdn.example.com/acme.png",
        image_public_path: "catalog_brands/3.jpg",
        sort_order: 0,
      },
      {
        id: 4,
        name: "Globex",
        slug: "globex",
        description: null,
        image_url: null,
        image_public_path: null,
        sort_order: 1,
      },
    ]);

    const res = await request(app)
      .get("/catalog-attributes/brands")
      .set("Authorization", "Bearer pk_live_key");

    expect(res.status).toBe(200);
    const [first, second] = res.body.brands;
    expect(first.image_public_url).toBe(
      "https://os.presentail.com/api/storage/public-objects/catalog_brands/3.jpg",
    );
    expect(second.image_public_url).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// GET /catalog-attributes/recipients
// ---------------------------------------------------------------------------

describe("GET /catalog-attributes/recipients", () => {
  const app = makeApp();

  beforeEach(() => {
    vi.clearAllMocks();
    drizzleQueue.length = 0;
    mockResolveApiKeyWorkspace.mockResolvedValue(null);
  });

  it("400 without workspace identifier or API key", async () => {
    const res = await request(app).get("/catalog-attributes/recipients");
    expect(res.status).toBe(400);
  });

  it("resolves workspace from API key and returns recipients", async () => {
    mockResolveApiKeyWorkspace.mockResolvedValue("owner_key");
    drizzleQueue.push([
      { id: 4, name: "Mom", slug: "mom", description: null, image_url: null, sort_order: 0 },
    ]);

    const res = await request(app)
      .get("/catalog-attributes/recipients")
      .set("Authorization", "Bearer pk_live_key");

    expect(res.status).toBe(200);
    expect(res.body.recipients).toHaveLength(1);
    expect(res.body.recipients[0].slug).toBe("mom");
  });

  it("exposes image_public_url for recipients (built from image_public_path, null when absent)", async () => {
    mockResolveApiKeyWorkspace.mockResolvedValue("owner_key");
    drizzleQueue.push([
      {
        id: 4,
        name: "Mom",
        slug: "mom",
        description: null,
        image_url: "https://cdn.example.com/mom.png",
        image_public_path: "recipients/4.jpg",
        sort_order: 0,
      },
      {
        id: 5,
        name: "Dad",
        slug: "dad",
        description: null,
        image_url: null,
        image_public_path: null,
        sort_order: 1,
      },
    ]);

    const res = await request(app)
      .get("/catalog-attributes/recipients")
      .set("Authorization", "Bearer pk_live_key");

    expect(res.status).toBe(200);
    const [first, second] = res.body.recipients;
    expect(first.image_public_url).toBe(
      "https://os.presentail.com/api/storage/public-objects/recipients/4.jpg",
    );
    expect(second.image_public_url).toBeNull();
  });
});

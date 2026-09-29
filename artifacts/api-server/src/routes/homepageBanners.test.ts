import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";
import type { WorkspaceRequest } from "../lib/workspace";

const mockDbQuery = vi.fn();

vi.mock("../lib/db", () => ({
  db: { query: (...args: unknown[]) => mockDbQuery(...args) },
}));

vi.mock("../lib/auth", () => ({
  requireAuth: (_req: express.Request, _res: express.Response, next: express.NextFunction) =>
    next(),
}));

let stubWorkspaceOwnerId = "owner_123";
let stubWorkspaceRole: "owner" | "member" = "owner";
let stubAllowedPages: string[] | null = null;

vi.mock("../lib/workspace", () => ({
  resolveWorkspace: (req: express.Request, _res: express.Response, next: express.NextFunction) => {
    const wreq = req as unknown as WorkspaceRequest;
    wreq.workspaceOwnerId = stubWorkspaceOwnerId;
    wreq.workspaceRole = stubWorkspaceRole;
    wreq.workspaceActualRole = stubWorkspaceRole;
    wreq.allowedPages = stubAllowedPages;
    wreq.userEmail = "user@example.com";
    wreq.userId = "user_123";
    next();
  },
  workspace: (req: express.Request) => req as unknown as WorkspaceRequest,
}));

vi.mock("../lib/catalogWebhook", () => ({
  fireCatalogDataWebhook: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../lib/logger", () => ({
  logger: { error: vi.fn(), info: vi.fn(), warn: vi.fn() },
}));

vi.mock("../lib/objectStorage", () => ({
  objectStorageService: {
    // Returns the requested base key as the "public key" — deterministic and
    // avoids any real object-storage network calls in unit tests.
    copyPrivateObjectToPublic: vi.fn(async (_url: string, baseKey: string) => baseKey),
  },
  buildPublicObjectUrl: (p: string | null | undefined) =>
    p ? `https://os.presentail.com/api/storage/public-objects/${p.replace(/^\/+/, "")}` : null,
}));

import homepageBannersRouter from "./homepageBanners";

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as { log: { error: (...a: unknown[]) => void; warn: (...a: unknown[]) => void; info: (...a: unknown[]) => void } }).log = {
      error: () => {},
      warn: () => {},
      info: () => {},
    };
    next();
  });
  app.use(homepageBannersRouter);
  return app;
}

function makeBannerRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 1,
    workspace_owner_id: "owner_123",
    internal_name: "Banner 1",
    title: null,
    headline: null,
    subtitle: null,
    cta_text: null,
    country_codes: ["Lebanon"],
    city_ids: [],
    is_global_for_country: true,
    desktop_enabled: true,
    desktop_media_type: "image",
    desktop_media_url: "/objects/owner_123/uploads/img.jpg",
    desktop_media_public_path: "homepage_banners/1/desktop_media",
    desktop_fallback_url: null,
    desktop_fallback_public_path: null,
    desktop_link_url: "https://example.com",
    mobile_enabled: false,
    mobile_media_type: null,
    mobile_media_url: null,
    mobile_media_public_path: null,
    mobile_fallback_url: null,
    mobile_fallback_public_path: null,
    mobile_link_url: null,
    start_at: new Date("2026-01-01T00:00:00Z"),
    end_at: null,
    timezone: "UTC",
    sort_order: 0,
    priority: 0,
    is_active: true,
    activated_at: new Date("2026-01-01T00:00:00Z"),
    created_by: "user@example.com",
    updated_by: "user@example.com",
    created_at: new Date("2026-01-01T00:00:00Z"),
    updated_at: new Date("2026-01-01T00:00:00Z"),
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockDbQuery.mockResolvedValue({ rows: [], rowCount: 0 });
  stubWorkspaceOwnerId = "owner_123";
  stubWorkspaceRole = "owner";
  stubAllowedPages = null;
});

describe("GET /storefront/homepage-banners (public)", () => {
  it("rejects requests missing required query params", async () => {
    const res = await request(makeApp()).get("/storefront/homepage-banners");
    expect(res.status).toBe(400);
  });

  it("returns 500 when neither the stored setting nor STOREFRONT_WORKSPACE_OWNER_ID is set", async () => {
    const prev = process.env.STOREFRONT_WORKSPACE_OWNER_ID;
    delete process.env.STOREFRONT_WORKSPACE_OWNER_ID;
    // storefront_config lookup returns no stored workspace.
    mockDbQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    try {
      const res = await request(makeApp())
        .get("/storefront/homepage-banners")
        .query({ countryCode: "Lebanon", device: "desktop" });
      expect(res.status).toBe(500);
      expect(res.body.error).toMatch(/STOREFRONT_WORKSPACE_OWNER_ID/);
    } finally {
      if (prev !== undefined) process.env.STOREFRONT_WORKSPACE_OWNER_ID = prev;
    }
  });

  it("uses the stored storefront workspace setting (env unset)", async () => {
    const prev = process.env.STOREFRONT_WORKSPACE_OWNER_ID;
    delete process.env.STOREFRONT_WORKSPACE_OWNER_ID;
    mockDbQuery
      // storefront_config → stored workspace owner id wins over env.
      .mockResolvedValueOnce({ rows: [{ workspace_owner_id: "owner_db" }], rowCount: 1 })
      // banner query
      .mockResolvedValueOnce({ rows: [], rowCount: 0 });
    try {
      const res = await request(makeApp())
        .get("/storefront/homepage-banners")
        .query({ countryCode: "Lebanon", device: "desktop" });
      expect(res.status).toBe(200);
      const params = mockDbQuery.mock.calls[1][1] as unknown[];
      expect(params[0]).toBe("owner_db");
    } finally {
      if (prev !== undefined) process.env.STOREFRONT_WORKSPACE_OWNER_ID = prev;
    }
  });

  it("falls back to STOREFRONT_WORKSPACE_OWNER_ID when no setting is stored", async () => {
    const prev = process.env.STOREFRONT_WORKSPACE_OWNER_ID;
    process.env.STOREFRONT_WORKSPACE_OWNER_ID = "owner_env";
    mockDbQuery
      .mockResolvedValueOnce({ rows: [], rowCount: 0 }) // no stored setting
      .mockResolvedValueOnce({ rows: [], rowCount: 0 }); // banner query
    try {
      const res = await request(makeApp())
        .get("/storefront/homepage-banners")
        .query({ countryCode: "Lebanon", device: "desktop" });
      expect(res.status).toBe(200);
      const params = mockDbQuery.mock.calls[1][1] as unknown[];
      expect(params[0]).toBe("owner_env");
    } finally {
      if (prev === undefined) delete process.env.STOREFRONT_WORKSPACE_OWNER_ID;
      else process.env.STOREFRONT_WORKSPACE_OWNER_ID = prev;
    }
  });

  it("ignores any caller-supplied workspaceId and uses env (no cross-tenant access)", async () => {
    const prev = process.env.STOREFRONT_WORKSPACE_OWNER_ID;
    process.env.STOREFRONT_WORKSPACE_OWNER_ID = "owner_env";
    mockDbQuery
      .mockResolvedValueOnce({ rows: [], rowCount: 0 }) // no stored setting → env
      .mockResolvedValueOnce({ rows: [], rowCount: 0 }); // banner query
    try {
      const res = await request(makeApp())
        .get("/storefront/homepage-banners")
        .query({
          workspaceId: "attacker_owner",
          countryCode: "Lebanon",
          device: "desktop",
        });
      expect(res.status).toBe(200);
      const params = mockDbQuery.mock.calls[1][1] as unknown[];
      // The server MUST use the env value, not the caller-supplied workspaceId.
      expect(params[0]).toBe("owner_env");
    } finally {
      if (prev === undefined) delete process.env.STOREFRONT_WORKSPACE_OWNER_ID;
      else process.env.STOREFRONT_WORKSPACE_OWNER_ID = prev;
    }
  });

  it("returns flattened device-specific banners", async () => {
    const prev = process.env.STOREFRONT_WORKSPACE_OWNER_ID;
    process.env.STOREFRONT_WORKSPACE_OWNER_ID = "owner_123";
    mockDbQuery
      .mockResolvedValueOnce({ rows: [], rowCount: 0 }) // storefront_config → env fallback
      .mockResolvedValueOnce({ rows: [makeBannerRow()], rowCount: 1 });
    try {
      const res = await request(makeApp())
        .get("/storefront/homepage-banners")
        .query({ countryCode: "Lebanon", device: "desktop" });

      expect(res.status).toBe(200);
      expect(res.body.banners).toHaveLength(1);
      expect(res.body.banners[0]).toMatchObject({
        device: "desktop",
        media_type: "image",
        // Storefront serves the auth-free PUBLIC copy of the banner media so it
        // loads on the public website, not the cookie-gated private path.
        media_url:
          "https://os.presentail.com/api/storage/public-objects/homepage_banners/1/desktop_media",
        link_url: "https://example.com",
      });

      const sql = mockDbQuery.mock.calls[1][0] as string;
      const params = mockDbQuery.mock.calls[1][1] as unknown[];
      expect(sql).toContain("workspace_owner_id = $1");
      expect(sql).toContain("desktop_enabled = true");
      expect(sql).toContain("ORDER BY sort_order ASC, priority ASC, created_at DESC");
      expect(params[0]).toBe("owner_123");
      // Country match is format-agnostic: "Lebanon" resolves to both the name
      // and its ISO code, normalized to lowercase.
      expect(params[1]).toEqual(expect.arrayContaining(["lebanon", "lb"]));
    } finally {
      if (prev === undefined) delete process.env.STOREFRONT_WORKSPACE_OWNER_ID;
      else process.env.STOREFRONT_WORKSPACE_OWNER_ID = prev;
    }
  });

  it("filters using mobile column when device=mobile", async () => {
    const prev = process.env.STOREFRONT_WORKSPACE_OWNER_ID;
    process.env.STOREFRONT_WORKSPACE_OWNER_ID = "owner_123";
    mockDbQuery
      .mockResolvedValueOnce({ rows: [], rowCount: 0 }) // storefront_config → env fallback
      .mockResolvedValueOnce({ rows: [], rowCount: 0 });
    try {
      await request(makeApp())
        .get("/storefront/homepage-banners")
        .query({ countryCode: "Lebanon", cityId: "5", device: "mobile" });

      const sql = mockDbQuery.mock.calls[1][0] as string;
      const params = mockDbQuery.mock.calls[1][1] as unknown[];
      expect(sql).toContain("mobile_enabled = true");
      expect(params[0]).toBe("owner_123");
      expect(params[1]).toEqual(expect.arrayContaining(["lebanon", "lb"]));
      expect(params[2]).toBe(5);
    } finally {
      if (prev === undefined) delete process.env.STOREFRONT_WORKSPACE_OWNER_ID;
      else process.env.STOREFRONT_WORKSPACE_OWNER_ID = prev;
    }
  });

  it("matches a name-stored banner when caller sends an ISO code", async () => {
    const prev = process.env.STOREFRONT_WORKSPACE_OWNER_ID;
    process.env.STOREFRONT_WORKSPACE_OWNER_ID = "owner_123";
    // Banner stored "Lebanon"; caller sends "LB". Both resolve to the same
    // candidate set so the SQL EXISTS clause would match.
    mockDbQuery
      .mockResolvedValueOnce({ rows: [], rowCount: 0 }) // storefront_config → env fallback
      .mockResolvedValueOnce({
        rows: [makeBannerRow({ country_codes: ["Lebanon"] })],
        rowCount: 1,
      });
    try {
      const res = await request(makeApp())
        .get("/storefront/homepage-banners")
        .query({ countryCode: "LB", device: "desktop" });

      expect(res.status).toBe(200);
      expect(res.body.banners).toHaveLength(1);
      const sql = mockDbQuery.mock.calls[1][0] as string;
      const params = mockDbQuery.mock.calls[1][1] as unknown[];
      expect(sql).toContain("unnest(country_codes)");
      expect(sql).toContain("lower(btrim(cc)) = ANY($2::text[])");
      expect(params[1]).toEqual(expect.arrayContaining(["lb", "lebanon"]));
    } finally {
      if (prev === undefined) delete process.env.STOREFRONT_WORKSPACE_OWNER_ID;
      else process.env.STOREFRONT_WORKSPACE_OWNER_ID = prev;
    }
  });

  it("matches a code-stored banner when caller sends the full name", async () => {
    const prev = process.env.STOREFRONT_WORKSPACE_OWNER_ID;
    process.env.STOREFRONT_WORKSPACE_OWNER_ID = "owner_123";
    mockDbQuery
      .mockResolvedValueOnce({ rows: [], rowCount: 0 }) // storefront_config → env fallback
      .mockResolvedValueOnce({
        rows: [makeBannerRow({ country_codes: ["LB"] })],
        rowCount: 1,
      });
    try {
      const res = await request(makeApp())
        .get("/storefront/homepage-banners")
        .query({ countryCode: "Lebanon", device: "desktop" });

      expect(res.status).toBe(200);
      expect(res.body.banners).toHaveLength(1);
      const params = mockDbQuery.mock.calls[1][1] as unknown[];
      expect(params[1]).toEqual(expect.arrayContaining(["lebanon", "lb"]));
    } finally {
      if (prev === undefined) delete process.env.STOREFRONT_WORKSPACE_OWNER_ID;
      else process.env.STOREFRONT_WORKSPACE_OWNER_ID = prev;
    }
  });

  it("builds country candidates case-insensitively and trims whitespace", async () => {
    const prev = process.env.STOREFRONT_WORKSPACE_OWNER_ID;
    process.env.STOREFRONT_WORKSPACE_OWNER_ID = "owner_123";
    mockDbQuery
      .mockResolvedValueOnce({ rows: [], rowCount: 0 }) // storefront_config → env fallback
      .mockResolvedValueOnce({ rows: [], rowCount: 0 });
    try {
      await request(makeApp())
        .get("/storefront/homepage-banners")
        .query({ countryCode: "  lEbAnOn  ", device: "desktop" });

      const params = mockDbQuery.mock.calls[1][1] as unknown[];
      // Candidates are always lowercased + trimmed regardless of input casing.
      expect(params[1]).toEqual(expect.arrayContaining(["lebanon", "lb"]));
    } finally {
      if (prev === undefined) delete process.env.STOREFRONT_WORKSPACE_OWNER_ID;
      else process.env.STOREFRONT_WORKSPACE_OWNER_ID = prev;
    }
  });

  it("passes through external http(s) media URLs unchanged", async () => {
    const prev = process.env.STOREFRONT_WORKSPACE_OWNER_ID;
    process.env.STOREFRONT_WORKSPACE_OWNER_ID = "owner_123";
    mockDbQuery
      .mockResolvedValueOnce({ rows: [], rowCount: 0 }) // storefront_config → env fallback
      .mockResolvedValueOnce({
        rows: [
          makeBannerRow({
            desktop_media_public_path: null,
            desktop_media_url: "https://cdn.example.com/banner.jpg",
          }),
        ],
        rowCount: 1,
      });
    try {
      const res = await request(makeApp())
        .get("/storefront/homepage-banners")
        .query({ countryCode: "Lebanon", device: "desktop" });
      expect(res.status).toBe(200);
      expect(res.body.banners[0].media_url).toBe("https://cdn.example.com/banner.jpg");
    } finally {
      if (prev === undefined) delete process.env.STOREFRONT_WORKSPACE_OWNER_ID;
      else process.env.STOREFRONT_WORKSPACE_OWNER_ID = prev;
    }
  });

  it("lazily copies a legacy private path to public and serves the public URL", async () => {
    const prev = process.env.STOREFRONT_WORKSPACE_OWNER_ID;
    process.env.STOREFRONT_WORKSPACE_OWNER_ID = "owner_123";
    // Legacy banner: private object path stored, no public copy yet.
    mockDbQuery
      .mockResolvedValueOnce({ rows: [], rowCount: 0 }) // storefront_config → env fallback
      .mockResolvedValueOnce({
        rows: [
          makeBannerRow({
            desktop_media_public_path: null,
            desktop_media_url: "/objects/owner_123/uploads/legacy.jpg",
          }),
        ],
        rowCount: 1,
      });
    try {
      const res = await request(makeApp())
        .get("/storefront/homepage-banners")
        .query({ countryCode: "Lebanon", device: "desktop" });
      expect(res.status).toBe(200);
      expect(res.body.banners[0].media_url).toBe(
        "https://os.presentail.com/api/storage/public-objects/homepage_banners/1/desktop_media",
      );
      // The lazily-created public key is persisted for next time.
      const persisted = mockDbQuery.mock.calls.find(
        (c) =>
          typeof c[0] === "string" &&
          c[0].includes("desktop_media_public_path = $1"),
      );
      expect(persisted).toBeDefined();
    } finally {
      if (prev === undefined) delete process.env.STOREFRONT_WORKSPACE_OWNER_ID;
      else process.env.STOREFRONT_WORKSPACE_OWNER_ID = prev;
    }
  });
});

describe("/admin/storefront-workspace (owner-only)", () => {
  it("GET returns connected via setting when caller's workspace is the storefront", async () => {
    const prev = process.env.STOREFRONT_WORKSPACE_OWNER_ID;
    delete process.env.STOREFRONT_WORKSPACE_OWNER_ID;
    mockDbQuery.mockResolvedValueOnce({
      rows: [{ workspace_owner_id: "owner_123" }],
      rowCount: 1,
    });
    try {
      const res = await request(makeApp()).get("/admin/storefront-workspace");
      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        connected: true,
        configured_via: "setting",
        is_current_workspace: true,
      });
    } finally {
      if (prev !== undefined) process.env.STOREFRONT_WORKSPACE_OWNER_ID = prev;
    }
  });

  it("GET returns not connected when neither setting nor env configured", async () => {
    const prev = process.env.STOREFRONT_WORKSPACE_OWNER_ID;
    delete process.env.STOREFRONT_WORKSPACE_OWNER_ID;
    mockDbQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    try {
      const res = await request(makeApp()).get("/admin/storefront-workspace");
      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        connected: false,
        configured_via: null,
        is_current_workspace: false,
      });
    } finally {
      if (prev !== undefined) process.env.STOREFRONT_WORKSPACE_OWNER_ID = prev;
    }
  });

  it("GET reports env fallback as not the current workspace", async () => {
    const prev = process.env.STOREFRONT_WORKSPACE_OWNER_ID;
    process.env.STOREFRONT_WORKSPACE_OWNER_ID = "owner_env";
    mockDbQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    try {
      const res = await request(makeApp()).get("/admin/storefront-workspace");
      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        connected: true,
        configured_via: "env",
        is_current_workspace: false,
      });
    } finally {
      if (prev === undefined) delete process.env.STOREFRONT_WORKSPACE_OWNER_ID;
      else process.env.STOREFRONT_WORKSPACE_OWNER_ID = prev;
    }
  });

  it("PUT connects the caller's workspace and reports it as current", async () => {
    const prev = process.env.STOREFRONT_WORKSPACE_OWNER_ID;
    delete process.env.STOREFRONT_WORKSPACE_OWNER_ID;
    mockDbQuery
      .mockResolvedValueOnce({ rows: [], rowCount: 1 }) // INSERT ... ON CONFLICT
      .mockResolvedValueOnce({
        rows: [{ workspace_owner_id: "owner_123" }],
        rowCount: 1,
      }); // status re-read
    try {
      const res = await request(makeApp()).put("/admin/storefront-workspace");
      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        connected: true,
        configured_via: "setting",
        is_current_workspace: true,
      });
      const insertSql = mockDbQuery.mock.calls[0][0] as string;
      const insertParams = mockDbQuery.mock.calls[0][1] as unknown[];
      expect(insertSql).toContain("INSERT INTO storefront_config");
      expect(insertParams[0]).toBe("owner_123");
    } finally {
      if (prev !== undefined) process.env.STOREFRONT_WORKSPACE_OWNER_ID = prev;
    }
  });

  it("DELETE clears the setting scoped to the caller's workspace", async () => {
    const prev = process.env.STOREFRONT_WORKSPACE_OWNER_ID;
    delete process.env.STOREFRONT_WORKSPACE_OWNER_ID;
    mockDbQuery
      .mockResolvedValueOnce({ rows: [], rowCount: 1 }) // UPDATE ... SET NULL
      .mockResolvedValueOnce({ rows: [], rowCount: 0 }); // status re-read
    try {
      const res = await request(makeApp()).delete("/admin/storefront-workspace");
      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        connected: false,
        configured_via: null,
        is_current_workspace: false,
      });
      const updateSql = mockDbQuery.mock.calls[0][0] as string;
      const updateParams = mockDbQuery.mock.calls[0][1] as unknown[];
      expect(updateSql).toContain("UPDATE storefront_config");
      expect(updateSql).toContain("workspace_owner_id = $1");
      expect(updateParams[0]).toBe("owner_123");
    } finally {
      if (prev !== undefined) process.env.STOREFRONT_WORKSPACE_OWNER_ID = prev;
    }
  });

  it("rejects non-owner callers with 403", async () => {
    stubWorkspaceRole = "member";
    stubAllowedPages = ["homepage_banners.manage"];
    const res = await request(makeApp()).get("/admin/storefront-workspace");
    expect(res.status).toBe(403);
    expect(res.body.error).toBe("owner_only");
  });
});

describe("GET /admin/homepage-banners (permissions)", () => {
  it("returns 200 for owner", async () => {
    mockDbQuery.mockResolvedValueOnce({ rows: [makeBannerRow()], rowCount: 1 });
    const res = await request(makeApp()).get("/admin/homepage-banners");
    expect(res.status).toBe(200);
    expect(res.body.banners).toHaveLength(1);
    expect(res.body.banners[0]).toMatchObject({ status: expect.any(String) });
  });

  it("returns 200 for member with permission", async () => {
    stubWorkspaceRole = "member";
    stubAllowedPages = ["homepage_banners.manage"];
    mockDbQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    const res = await request(makeApp()).get("/admin/homepage-banners");
    expect(res.status).toBe(200);
  });

  it("returns 403 for member without permission", async () => {
    stubWorkspaceRole = "member";
    stubAllowedPages = ["other.permission"];
    const res = await request(makeApp()).get("/admin/homepage-banners");
    expect(res.status).toBe(403);
    expect(mockDbQuery).not.toHaveBeenCalled();
  });
});

describe("POST /admin/homepage-banners (validation)", () => {
  function validInput() {
    return {
      internal_name: "Test",
      country_codes: ["Lebanon"],
      city_ids: [],
      is_global_for_country: true,
      desktop: {
        enabled: true,
        media_type: "image",
        media_url: "/storage/objects/x.jpg",
        link_url: "https://example.com",
      },
      mobile: { enabled: false },
      start_at: "2026-01-01T00:00:00Z",
      timezone: "UTC",
    };
  }

  it("rejects when neither desktop nor mobile is enabled", async () => {
    const res = await request(makeApp())
      .post("/admin/homepage-banners")
      .send({ ...validInput(), desktop: { enabled: false }, mobile: { enabled: false } });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/desktop or mobile/);
  });

  it("rejects when video has no fallback image", async () => {
    const res = await request(makeApp())
      .post("/admin/homepage-banners")
      .send({
        ...validInput(),
        desktop: {
          enabled: true,
          media_type: "video",
          media_url: "/storage/objects/v.mp4",
          link_url: "https://example.com",
        },
      });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/fallback_image_url/);
  });

  it("rejects when no countries are selected", async () => {
    const res = await request(makeApp())
      .post("/admin/homepage-banners")
      .send({ ...validInput(), country_codes: [] });
    expect(res.status).toBe(400);
  });

  it("creates banner on valid input and returns 201", async () => {
    mockDbQuery.mockResolvedValueOnce({ rows: [makeBannerRow()], rowCount: 1 });
    const res = await request(makeApp())
      .post("/admin/homepage-banners")
      .send(validInput());
    expect(res.status).toBe(201);
    expect(res.body.banner).toMatchObject({ id: 1, internal_name: "Banner 1" });
  });
});

describe("POST /admin/homepage-banners — media url normalization", () => {
  it("normalizes a persisted private /objects uploads path to an absolute public URL", async () => {
    // INSERT returns a row whose desktop_media_url is still the private path;
    // syncBannerPublicMedia must copy it to public AND rewrite the url column.
    mockDbQuery.mockResolvedValue({
      rows: [
        makeBannerRow({
          desktop_media_public_path: null,
          desktop_media_url: "/objects/owner_123/uploads/fresh.jpg",
        }),
      ],
      rowCount: 1,
    });

    const res = await request(makeApp())
      .post("/admin/homepage-banners")
      .send({
        internal_name: "Banner 1",
        country_codes: ["Lebanon"],
        is_global_for_country: true,
        desktop: {
          enabled: true,
          media_type: "image",
          media_url: "/objects/owner_123/uploads/fresh.jpg",
          link_url: "https://example.com",
        },
        mobile: { enabled: false },
        start_at: "2026-01-01T00:00:00Z",
        timezone: "Asia/Beirut",
      });

    expect(res.status).toBe(201);
    const normalizeCall = mockDbQuery.mock.calls.find(
      (c) =>
        typeof c[0] === "string" &&
        c[0].includes("SET desktop_media_url = $1") &&
        c[0].includes("AND desktop_media_url = $4"),
    );
    expect(normalizeCall).toBeDefined();
    expect(String(normalizeCall?.[1]?.[0])).toMatch(/^https:\/\//);
    expect(String(normalizeCall?.[1]?.[3])).toBe(
      "/objects/owner_123/uploads/fresh.jpg",
    );
  });
});

describe("DELETE /admin/homepage-banners/:id", () => {
  it("returns 404 when banner not found", async () => {
    mockDbQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    const res = await request(makeApp()).delete("/admin/homepage-banners/999");
    expect(res.status).toBe(404);
  });

  it("returns 204 on successful delete", async () => {
    mockDbQuery.mockResolvedValueOnce({ rows: [], rowCount: 1 });
    const res = await request(makeApp()).delete("/admin/homepage-banners/1");
    expect(res.status).toBe(204);
  });
});

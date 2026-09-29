/**
 * Integration tests for homepage banners — pause/resume and new fields.
 *
 * Verifies that the new columns (languages, destination_type, destination_value,
 * status_override) are correctly persisted and returned, and that the pause/resume
 * endpoints transition status as expected.
 *
 * Auth and workspace middleware are stubbed; the database is real.
 * The suite skips automatically when DATABASE_URL is not set.
 */

import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import express from "express";
import request from "supertest";
import pg from "pg";
import type { WorkspaceRequest } from "../lib/workspace";
import type { WorkspaceRole } from "./integrationTestTypes";

const { Pool } = pg;
const DATABASE_URL = process.env.DATABASE_URL;

const OWNER_ID = "__integration_test_homepage_banners__";
const USER_ID = "__integration_test_banner_user__";

// ─────────────────────────────────────────────────────────────────────────────
// Mocks — auth / workspace / logger / catalogWebhook / objectStorage only.
// db is NOT mocked.
// ─────────────────────────────────────────────────────────────────────────────

vi.mock("../lib/auth", () => ({
  requireAuth: (_req: express.Request, _res: express.Response, next: express.NextFunction) =>
    next(),
}));

let currentRole: WorkspaceRole = "owner";

vi.mock("../lib/workspace", () => ({
  resolveWorkspace: (req: express.Request, _res: express.Response, next: express.NextFunction) => {
    const wreq = req as unknown as WorkspaceRequest;
    wreq.workspaceOwnerId = OWNER_ID;
    wreq.workspaceRole = currentRole;
    wreq.workspaceActualRole = currentRole;
    wreq.userId = USER_ID;
    wreq.userEmail = "banner-test@example.com";
    wreq.allowedPages = null;
    next();
  },
  workspace: (req: express.Request) => req as unknown as WorkspaceRequest,
}));

vi.mock("../lib/logger", () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn().mockReturnThis(),
  },
}));

vi.mock("../lib/catalogWebhook", () => ({
  fireCatalogDataWebhook: vi.fn().mockResolvedValue(undefined),
  fireWebhookEvent: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../lib/objectStorage", () => ({
  objectStorageService: {
    copyPrivateObjectToPublic: vi.fn(async (_url: string, baseKey: string) => baseKey),
  },
  buildPublicObjectUrl: (p: string | null | undefined) =>
    p ? `https://os.presentail.com/api/storage/public-objects/${p.replace(/^\/+/, "")}` : null,
}));

import homepageBannersRouter from "./homepageBanners";

function makeApp(): express.Express {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (
      req as unknown as {
        log: { error: (...a: unknown[]) => void; warn: (...a: unknown[]) => void; info: (...a: unknown[]) => void };
      }
    ).log = { error: () => {}, warn: () => {}, info: () => {} };
    next();
  });
  app.use(homepageBannersRouter);
  app.use(
    (err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
      res.status(500).json({ error: err?.message ?? "Internal server error" });
    },
  );
  return app;
}

/** Minimal valid banner payload — uses an external https URL so no GCS copy is triggered. */
function baseBannerPayload(overrides: Record<string, unknown> = {}) {
  return {
    internal_name: "Integration Test Banner",
    country_codes: ["AE"],
    city_ids: [],
    is_global_for_country: true,
    desktop: {
      enabled: true,
      media_type: "image",
      media_url: "https://cdn.example.com/banner.jpg",
    },
    mobile: { enabled: false },
    start_at: "2026-01-01T00:00:00Z",
    end_at: "2030-01-01T00:00:00Z",
    timezone: "UTC",
    is_active: true,
    ...overrides,
  };
}

describe.skipIf(!DATABASE_URL)("Homepage Banners integration tests", () => {
  let pool: InstanceType<typeof Pool>;
  let app: express.Express;

  beforeAll(async () => {
    currentRole = "owner";
    pool = new Pool({ connectionString: DATABASE_URL });
    app = makeApp();

    // Clean up any leftovers from a previous failed run.
    await pool.query(`DELETE FROM homepage_banners WHERE workspace_owner_id = $1`, [OWNER_ID]);
    // Ensure the storefront_config row exists so the public endpoint won't 500.
    await pool.query(
      `INSERT INTO storefront_config (id, workspace_owner_id, updated_by, updated_at)
         VALUES (1, $1, 'test', now())
       ON CONFLICT (id) DO NOTHING`,
      [OWNER_ID],
    );
  });

  afterAll(async () => {
    if (!pool) return;
    await pool.query(`DELETE FROM homepage_banners WHERE workspace_owner_id = $1`, [OWNER_ID]);
    await pool.end();
  });

  // ─────────────────────────────────────────────────────────────────────────
  // languages field
  // ─────────────────────────────────────────────────────────────────────────

  describe("POST /admin/homepage-banners — languages field", () => {
    it("persists a custom languages array and returns it on GET", async () => {
      const createRes = await request(app)
        .post("/admin/homepage-banners")
        .send(baseBannerPayload({ languages: ["fr", "en"], internal_name: "Lang Test Banner" }));

      expect(createRes.status).toBe(201);
      const banner = createRes.body.banner;
      expect(banner.languages).toEqual(["fr", "en"]);

      const getRes = await request(app).get(`/admin/homepage-banners/${banner.id}`);
      expect(getRes.status).toBe(200);
      expect(getRes.body.banner.languages).toEqual(["fr", "en"]);
    });

    it("defaults languages to ['en', 'ar'] when not provided", async () => {
      const payload = baseBannerPayload({ internal_name: "Default Lang Banner" });
      delete (payload as Record<string, unknown>).languages;

      const createRes = await request(app).post("/admin/homepage-banners").send(payload);

      expect(createRes.status).toBe(201);
      expect(createRes.body.banner.languages).toEqual(["en", "ar"]);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // destination_type + destination_value fields
  // ─────────────────────────────────────────────────────────────────────────

  describe("POST /admin/homepage-banners — destination fields", () => {
    it("persists destination_type='custom_url' and destination_value, returns them on GET", async () => {
      const createRes = await request(app)
        .post("/admin/homepage-banners")
        .send(
          baseBannerPayload({
            internal_name: "Destination Test Banner",
            destination_type: "custom_url",
            destination_value: "https://example.com/promo",
          }),
        );

      expect(createRes.status).toBe(201);
      const banner = createRes.body.banner;
      expect(banner.destination_type).toBe("custom_url");
      expect(banner.destination_value).toBe("https://example.com/promo");

      const getRes = await request(app).get(`/admin/homepage-banners/${banner.id}`);
      expect(getRes.status).toBe(200);
      expect(getRes.body.banner.destination_type).toBe("custom_url");
      expect(getRes.body.banner.destination_value).toBe("https://example.com/promo");
    });

    it("persists destination_type='none' and null destination_value", async () => {
      const createRes = await request(app)
        .post("/admin/homepage-banners")
        .send(
          baseBannerPayload({
            internal_name: "No Destination Banner",
            destination_type: "none",
          }),
        );

      expect(createRes.status).toBe(201);
      const banner = createRes.body.banner;
      expect(banner.destination_type).toBe("none");
      expect(banner.destination_value).toBeNull();
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // pause / resume endpoints
  // ─────────────────────────────────────────────────────────────────────────

  describe("POST /admin/homepage-banners/:id/pause and /resume", () => {
    it("pause sets status_override='paused', is_active=false → status='Paused'", async () => {
      const createRes = await request(app)
        .post("/admin/homepage-banners")
        .send(baseBannerPayload({ internal_name: "Pause Resume Banner", is_active: true }));

      expect(createRes.status).toBe(201);
      const bannerId: number = createRes.body.banner.id;

      const pauseRes = await request(app).post(`/admin/homepage-banners/${bannerId}/pause`);
      expect(pauseRes.status).toBe(200);
      const paused = pauseRes.body.banner;
      expect(paused.status_override).toBe("paused");
      expect(paused.is_active).toBe(false);
      expect(paused.status).toBe("Paused");
    });

    it("resume after pause sets status_override=null, is_active=true → status='Live'", async () => {
      const createRes = await request(app)
        .post("/admin/homepage-banners")
        .send(baseBannerPayload({ internal_name: "Resume Banner", is_active: true }));

      expect(createRes.status).toBe(201);
      const bannerId: number = createRes.body.banner.id;

      // Pause first
      const pauseRes = await request(app).post(`/admin/homepage-banners/${bannerId}/pause`);
      expect(pauseRes.status).toBe(200);
      expect(pauseRes.body.banner.status).toBe("Paused");

      // Then resume
      const resumeRes = await request(app).post(`/admin/homepage-banners/${bannerId}/resume`);
      expect(resumeRes.status).toBe(200);
      const resumed = resumeRes.body.banner;
      expect(resumed.status_override).toBeNull();
      expect(resumed.is_active).toBe(true);
      // Banner has start_at in the past and end_at in the future → Live
      expect(resumed.status).toBe("Live");
    });

    it("pause returns 404 for unknown banner id", async () => {
      const res = await request(app).post("/admin/homepage-banners/999999999/pause");
      expect(res.status).toBe(404);
    });

    it("resume returns 404 for unknown banner id", async () => {
      const res = await request(app).post("/admin/homepage-banners/999999999/resume");
      expect(res.status).toBe(404);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // draft banner (schedule_mode=draft — no start_at)
  // ─────────────────────────────────────────────────────────────────────────

  describe("POST /admin/homepage-banners — draft without start_at", () => {
    it("accepts a banner with no start_at (draft mode) without returning 400", async () => {
      const payload = baseBannerPayload({ internal_name: "Draft Banner", is_active: false });
      delete (payload as Record<string, unknown>).start_at;
      delete (payload as Record<string, unknown>).end_at;

      const res = await request(app).post("/admin/homepage-banners").send(payload);

      expect(res.status).toBe(201);
      const banner = res.body.banner;
      expect(banner.start_at).toBeNull();
      expect(banner.end_at).toBeNull();
      // Never activated → Draft
      expect(banner.status).toBe("Draft");
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // GET /admin/homepage-banners — list includes new fields
  // ─────────────────────────────────────────────────────────────────────────

  describe("GET /admin/homepage-banners — list returns new fields", () => {
    it("list response includes languages, destination_type, destination_value, status_override", async () => {
      const createRes = await request(app)
        .post("/admin/homepage-banners")
        .send(
          baseBannerPayload({
            internal_name: "Fields List Banner",
            languages: ["ar"],
            destination_type: "category",
            is_active: false,
          }),
        );
      expect(createRes.status).toBe(201);

      const listRes = await request(app).get("/admin/homepage-banners");
      expect(listRes.status).toBe(200);

      const found = (listRes.body.banners as Record<string, unknown>[]).find(
        (b) => b.internal_name === "Fields List Banner",
      );
      expect(found).toBeDefined();
      expect(found!.languages).toEqual(["ar"]);
      expect(found!.destination_type).toBe("category");
      expect(found!.status_override).toBeNull();
    });
  });
});

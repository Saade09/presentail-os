/**
 * Unit tests for devEmailPreview route.
 *
 * Covers two scenarios:
 *  1. Development mode — all 9 template slugs return 200 with HTML, the index
 *     page lists templates, and unknown slugs return 404.
 *  2. Production mode — the routes are never registered so every request to
 *     /dev/email-preview returns 404, catching any accidental removal of the
 *     `if (process.env.NODE_ENV !== "production")` guard.
 *
 * The production-mode tests use vi.stubEnv + vi.resetModules() + a dynamic
 * import to force the module to re-execute with NODE_ENV=production.
 */

import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import express from "express";
import request from "supertest";

vi.mock("../lib/email", () => ({
  buildInviteHtml: vi.fn(() => "<html>invite</html>"),
  buildAccessRequestHtml: vi.fn(() => "<html>access-request</html>"),
  buildAccessRejectionHtml: vi.fn(() => "<html>access-rejection</html>"),
  buildOfflineAlertHtml: vi.fn(() => "<html>offline-alert</html>"),
  buildTimeOffDecisionHtml: vi.fn(() => "<html>time-off-decision</html>"),
  buildTimeOffRequestSubmittedHtml: vi.fn(
    () => "<html>time-off-submitted</html>",
  ),
  buildAnnualLeavePolicyAssignedHtml: vi.fn(
    () => "<html>leave-policy-assigned</html>",
  ),
}));

vi.mock("../lib/logger", () => ({
  logger: { error: vi.fn(), info: vi.fn(), warn: vi.fn() },
}));

import devEmailPreviewRouter from "./devEmailPreview";

function makeApp(router: express.Router) {
  const app = express();
  app.use((req, _res, next) => {
    (req as unknown as { log: { error: (...a: unknown[]) => void; warn: (...a: unknown[]) => void; info: (...a: unknown[]) => void } }).log = {
      error: () => {},
      warn: () => {},
      info: () => {},
    };
    next();
  });
  app.use(router);
  return app;
}

describe("GET /dev/email-preview — development mode", () => {
  const app = makeApp(devEmailPreviewRouter);

  it("index page lists all templates", async () => {
    const res = await request(app).get("/dev/email-preview");
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("text/html");
    expect(res.text).toContain("Email Template Preview");
    expect(res.text).toContain("Dev only");
    expect(res.text).toContain("/api/dev/email-preview/invite");
    expect(res.text).toContain("/api/dev/email-preview/leave-policy-assigned");
  });

  const TEMPLATE_SLUGS = [
    "invite",
    "invite-access-approval",
    "access-request",
    "access-rejection",
    "offline-alert",
    "time-off-approved",
    "time-off-declined",
    "time-off-submitted",
    "leave-policy-assigned",
  ];

  for (const slug of TEMPLATE_SLUGS) {
    it(`template ${slug} returns 200 with HTML`, async () => {
      vi.setSystemTime(new Date("2024-01-01T00:00:00Z"));
      const res = await request(app).get(`/dev/email-preview/${slug}`);
      expect(res.status).toBe(200);
      expect(res.headers["content-type"]).toContain("text/html");
      expect(res.text).toContain("<html>");
    });
  }

  it("unknown template slug returns 404 with helpful message", async () => {
    const res = await request(app).get("/dev/email-preview/does-not-exist");
    expect(res.status).toBe(404);
    expect(res.text).toContain("Unknown template");
    expect(res.text).toContain("does-not-exist");
  });
});

describe("GET /dev/email-preview — production mode (routes must not be registered)", () => {
  let prodApp: express.Express;

  beforeAll(async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.resetModules();
    const mod = await import("./devEmailPreview");
    prodApp = makeApp(mod.default);
  });

  afterAll(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it("index route returns 404 in production", async () => {
    const res = await request(prodApp).get("/dev/email-preview");
    expect(res.status).toBe(404);
  });

  it("template route returns 404 in production", async () => {
    const res = await request(prodApp).get("/dev/email-preview/invite");
    expect(res.status).toBe(404);
  });

  it("another template route returns 404 in production", async () => {
    const res = await request(prodApp).get("/dev/email-preview/offline-alert");
    expect(res.status).toBe(404);
  });
});

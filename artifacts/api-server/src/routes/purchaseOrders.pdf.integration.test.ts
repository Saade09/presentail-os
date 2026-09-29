/**
 * Integration test for GET /purchase-orders/:id/pdf
 *
 * The route now renders the PDF via headless Chromium (HTML → PDF, same
 * pattern as giftCardPdf.ts) instead of PDFKit, so we can no longer extract
 * visible text from simple TJ/Tj content-stream operators (Chromium embeds
 * subset TrueType fonts with glyph-id text runs, not char-code text runs).
 * These tests instead verify the HTTP contract and that a well-formed PDF is
 * produced, mirroring the approach used for the gift-card PDF renderer.
 *
 * Auth and workspace middleware are stubbed; db and Chromium rendering are
 * real. The suite skips automatically when DATABASE_URL is not set, or when
 * no Chromium executable is resolvable in this environment.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import fs from "node:fs";
import express from "express";
import request from "supertest";
import pg from "pg";
import { chromium } from "playwright-core";
import type { WorkspaceRequest } from "../lib/workspace";
import type { WorkspaceRole } from "./integrationTestTypes";
import { closePoPdfBrowser } from "../lib/poPdf";

function chromiumAvailable(): boolean {
  const envCandidates = [
    process.env.REPLIT_PLAYWRIGHT_CHROMIUM_EXECUTABLE,
    process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
    process.env.PUPPETEER_EXECUTABLE_PATH,
    process.env.CHROME_PATH,
  ];
  for (const c of envCandidates) {
    if (c && fs.existsSync(c)) return true;
  }
  try {
    const p = chromium.executablePath();
    if (p && fs.existsSync(p)) return true;
  } catch {
    // playwright-core throws when no browser is registered.
  }
  for (const c of [
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
  ]) {
    if (fs.existsSync(c)) return true;
  }
  return false;
}

const HAS_CHROMIUM = chromiumAvailable();

const { Pool } = pg;
const DATABASE_URL = process.env.DATABASE_URL;

const OWNER_ID = "__integration_test_purchase_orders_pdf__";
const USER_ID = "__integration_test_po_pdf_user__";

vi.mock("../lib/auth", () => ({
  requireAuth: (_req: express.Request, _res: express.Response, next: express.NextFunction) =>
    next(),
  authed: (req: express.Request) => ({ ...req, userId: USER_ID }),
}));

let currentRole: WorkspaceRole = "owner";

vi.mock("../lib/workspace", () => ({
  resolveWorkspace: (
    req: express.Request,
    _res: express.Response,
    next: express.NextFunction,
  ) => {
    const wreq = req as unknown as WorkspaceRequest;
    wreq.workspaceOwnerId = OWNER_ID;
    wreq.workspaceRole = currentRole;
    wreq.workspaceActualRole = currentRole;
    wreq.userId = USER_ID;
    wreq.userEmail = "po-pdf-test@example.com";
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

vi.mock("@clerk/express", () => ({
  clerkClient: {
    users: {
      getUserList: vi.fn().mockResolvedValue({ data: [] }),
    },
  },
}));

vi.mock("../lib/email", () => ({
  sendPurchaseOrderEmail: vi.fn().mockResolvedValue(undefined),
}));

import purchaseOrdersRouter from "./purchaseOrders";

function makeApp(): express.Express {
  const app = express();
  app.use(express.json());
  app.use(purchaseOrdersRouter);
  app.use(
    (
      err: Error,
      _req: express.Request,
      res: express.Response,
      _next: express.NextFunction,
    ) => {
      console.error("TEST APP ERROR:", err?.message, err?.stack?.split("\n")[1]);
      res.status(500).json({ error: err?.message ?? "Internal server error" });
    },
  );
  return app;
}

describe.skipIf(!DATABASE_URL || !HAS_CHROMIUM)(
  "Purchase Orders PDF integration tests",
  () => {
    let pool: InstanceType<typeof Pool>;
    let app: express.Express;
    let supplierId: number;
    let poId: number;

    const SUPPLIER_NAME = "PDF Integration Supplier";
    const PO_NUMBER = "PDF-INTTEST-001";

    beforeAll(async () => {
      currentRole = "owner";
      pool = new Pool({ connectionString: DATABASE_URL });
      app = makeApp();

      await pool.query(
        `DELETE FROM purchase_orders WHERE workspace_owner_id = $1`,
        [OWNER_ID],
      );
      await pool.query(
        `DELETE FROM suppliers WHERE workspace_owner_id = $1`,
        [OWNER_ID],
      );
      await pool.query(
        `DELETE FROM locations WHERE workspace_owner_id = $1`,
        [OWNER_ID],
      );

      const loc = await pool.query<{ id: number }>(
        `INSERT INTO locations (workspace_owner_id, name) VALUES ($1, 'PDF Test Location') RETURNING id`,
        [OWNER_ID],
      );
      const locationId = loc.rows[0].id;

      const s = await pool.query<{ id: number }>(
        `INSERT INTO suppliers (workspace_owner_id, name) VALUES ($1, $2) RETURNING id`,
        [OWNER_ID, SUPPLIER_NAME],
      );
      supplierId = s.rows[0].id;

      const po = await pool.query<{ id: number }>(
        `INSERT INTO purchase_orders
           (workspace_owner_id, supplier_id, location_id, po_number, status, currency)
         VALUES ($1, $2, $3, $4, 'confirmed', 'AED')
         RETURNING id`,
        [OWNER_ID, supplierId, locationId, PO_NUMBER],
      );
      poId = po.rows[0].id;

      await pool.query(
        `INSERT INTO purchase_order_line_items
           (purchase_order_id, description, description_ar, quantity, unit_price, currency)
         VALUES ($1, 'Red Roses', 'ورد أحمر', 10, 25.00, 'AED')`,
        [poId],
      );
    });

    afterAll(async () => {
      await closePoPdfBrowser();
      if (!pool) return;
      await pool.query(
        `DELETE FROM purchase_orders WHERE workspace_owner_id = $1`,
        [OWNER_ID],
      );
      await pool.query(
        `DELETE FROM suppliers WHERE workspace_owner_id = $1`,
        [OWNER_ID],
      );
      await pool.query(
        `DELETE FROM locations WHERE workspace_owner_id = $1`,
        [OWNER_ID],
      );
      await pool.end();
    });

    it("returns 200 with Content-Type application/pdf and a valid PDF body", async () => {
      const res = await request(app)
        .get(`/purchase-orders/${poId}/pdf`)
        .buffer(true)
        .parse((res, callback) => {
          const chunks: Buffer[] = [];
          res.on("data", (chunk: Buffer) => chunks.push(chunk));
          res.on("end", () => callback(null, Buffer.concat(chunks)));
        });

      expect(res.status).toBe(200);
      expect(res.headers["content-type"]).toContain("application/pdf");

      const body: Buffer = res.body as Buffer;
      expect(body.subarray(0, 5).toString("ascii")).toBe("%PDF-");
      expect(body.length).toBeGreaterThan(1000);
    }, 30000);

    it("sets Content-Disposition attachment with the PO number in the filename", async () => {
      const res = await request(app)
        .get(`/purchase-orders/${poId}/pdf`)
        .buffer(true)
        .parse((res, callback) => {
          const chunks: Buffer[] = [];
          res.on("data", (chunk: Buffer) => chunks.push(chunk));
          res.on("end", () => callback(null, Buffer.concat(chunks)));
        });

      expect(res.headers["content-disposition"]).toContain("attachment");
      expect(res.headers["content-disposition"]).toContain("PDF-INTTEST-001");
    }, 30000);

    it("returns 404 for an unknown purchase order id", async () => {
      const res = await request(app).get("/purchase-orders/99999999/pdf");
      expect(res.status).toBe(404);
      expect(res.body.error).toMatch(/not found/i);
    });
  },
);

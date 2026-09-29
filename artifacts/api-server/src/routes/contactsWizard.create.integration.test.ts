import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";
import pg from "pg";
import type { WorkspaceRequest } from "../lib/workspace";
import { buildPhoneSearchTokens } from "../lib/contactSearchNormalize";

const { Pool } = pg;
const DATABASE_URL = process.env.DATABASE_URL;
const WORKSPACE_ID = `__wizard_contact_create_${Date.now()}`;

vi.mock("../lib/auth", () => ({
  requireAuth: (_req: express.Request, _res: express.Response, next: express.NextFunction) =>
    next(),
  authed: (req: express.Request) => req,
}));

vi.mock("../lib/workspace", () => ({
  resolveWorkspace: (
    req: express.Request,
    _res: express.Response,
    next: express.NextFunction,
  ) => {
    const wreq = req as unknown as WorkspaceRequest;
    wreq.workspaceOwnerId = WORKSPACE_ID;
    wreq.workspaceRole = "owner";
    wreq.workspaceActualRole = "owner";
    wreq.userId = "integration-user";
    next();
  },
  workspace: (req: express.Request) => req as unknown as WorkspaceRequest,
}));

vi.mock("../lib/genderInference", () => ({
  queueGenderInference: vi.fn(),
}));

vi.mock("../lib/respondio", () => ({
  isRespondIoEnabled: () => false,
  findOrCreateContactByPhone: vi.fn(),
  updateContactName: vi.fn(),
}));

const mockLogger = vi.hoisted(() => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));
vi.mock("../lib/logger", () => ({ logger: mockLogger }));

import contactsWizardRouter from "./contactsWizard";

function makeApp(): express.Express {
  const app = express();
  app.use(express.json());
  app.use("/api", contactsWizardRouter);
  return app;
}

function tokensLiteral(phone: string): string {
  return `{${buildPhoneSearchTokens(phone)
    .map((token) => `"${token.replace(/"/g, '\\"')}"`)
    .join(",")}}`;
}

describe.skipIf(!DATABASE_URL)(
  "POST /api/contacts/wizard-create — mounted route with PostgreSQL",
  () => {
    let pool: InstanceType<typeof Pool>;
    let app: express.Express;

    beforeAll(() => {
      pool = new Pool({ connectionString: DATABASE_URL });
      app = makeApp();
    });

    beforeEach(async () => {
      await pool.query(`DELETE FROM contacts WHERE workspace_owner_id = $1`, [WORKSPACE_ID]);
      vi.clearAllMocks();
    });

    afterAll(async () => {
      if (!pool) return;
      await pool.query(`DELETE FROM contacts WHERE workspace_owner_id = $1`, [WORKSPACE_ID]);
      await pool.end();
    });

    it("creates the reported UAE phone-and-email payload and returns the contract shape", async () => {
      const response = await request(app)
        .post("/api/contacts/wizard-create")
        .send({
          display_name: "UAE Regression Customer",
          phone: "+971501234567",
          email: "uae-regression@example.test",
        });

      expect(response.status).toBe(201);
      expect(response.body).toMatchObject({
        existing: false,
        contact: {
          display_name: "Uae Regression Customer",
          phone: "+971501234567",
          email: "uae-regression@example.test",
          orders_placed: 0,
          last_order_at: null,
        },
      });
      expect(response.body.contact.id).toEqual(expect.any(String));

      const stored = await pool.query<{
        email: string;
        phone: string;
        archived_at: Date | null;
      }>(
        `SELECT email, phone, archived_at
           FROM contacts
          WHERE workspace_owner_id = $1`,
        [WORKSPACE_ID],
      );
      expect(stored.rows).toEqual([
        {
          email: "uae-regression@example.test",
          phone: "+971501234567",
          archived_at: null,
        },
      ]);
    });

    it("resolves normalized Lebanese phone and email variants without a duplicate", async () => {
      const created = await request(app)
        .post("/api/contacts/wizard-create")
        .send({
          display_name: "Lebanese New",
          phone: "+961 70 123 456",
          email: "rana@example.test",
        });
      expect(created.status).toBe(201);

      const response = await request(app)
        .post("/api/contacts/wizard-create")
        .send({
          display_name: "Rana Updated",
          phone: "+96170123456",
          email: " RANA@EXAMPLE.TEST ",
        });

      expect(response.status).toBe(200);
      expect(response.body.existing).toBe(true);
      expect(response.body.contact.id).toBe(created.body.contact.id);

      const count = await pool.query<{ count: string }>(
        `SELECT count(*)::text AS count
           FROM contacts
          WHERE workspace_owner_id = $1`,
        [WORKSPACE_ID],
      );
      expect(count.rows[0].count).toBe("1");
    });

    it("unarchives a matching identity and returns it as usable", async () => {
      const inserted = await pool.query<{ id: string }>(
        `INSERT INTO contacts
           (workspace_owner_id, display_name, email, phone, phone_search_tokens, archived_at)
         VALUES ($1, 'Archived Contact', 'archived@example.test', '+971521234567',
                 $2::text[], now())
         RETURNING id`,
        [WORKSPACE_ID, tokensLiteral("+971521234567")],
      );

      const response = await request(app)
        .post("/api/contacts/wizard-create")
        .send({
          display_name: "Archived Contact",
          email: "archived@example.test",
          phone: "+971521234567",
        });

      expect(response.status).toBe(200);
      expect(response.body).toMatchObject({
        existing: true,
        contact: { id: inserted.rows[0].id },
      });
      const stored = await pool.query<{ archived_at: Date | null }>(
        `SELECT archived_at FROM contacts WHERE id = $1`,
        [inserted.rows[0].id],
      );
      expect(stored.rows[0].archived_at).toBeNull();
    });

    it("predictably returns the phone owner for a cross-field identity conflict", async () => {
      await pool.query(
        `INSERT INTO contacts (workspace_owner_id, display_name, email)
         VALUES ($1, 'Email Owner', 'cross-owner@example.test')`,
        [WORKSPACE_ID],
      );
      const phoneOwner = await pool.query<{ id: string }>(
        `INSERT INTO contacts
           (workspace_owner_id, display_name, phone, phone_search_tokens)
         VALUES ($1, 'Phone Owner', '+971541234567', $2::text[])
         RETURNING id`,
        [WORKSPACE_ID, tokensLiteral("+971541234567")],
      );

      const response = await request(app)
        .post("/api/contacts/wizard-create")
        .send({
          display_name: "Cross Conflict",
          email: "cross-owner@example.test",
          phone: "+971541234567",
        });

      expect(response.status).toBe(200);
      expect(response.body).toMatchObject({
        existing: true,
        contact: {
          id: phoneOwner.rows[0].id,
          phone: "+971541234567",
          email: null,
        },
      });
      const count = await pool.query<{ count: string }>(
        `SELECT count(*)::text AS count
           FROM contacts
          WHERE workspace_owner_id = $1`,
        [WORKSPACE_ID],
      );
      expect(count.rows[0].count).toBe("2");
    });

    it("serializes simultaneous duplicate submissions into one usable contact", async () => {
      const submissions = await Promise.all(
        Array.from({ length: 6 }, () =>
          request(app)
            .post("/api/contacts/wizard-create")
            .send({
              display_name: "Concurrent UAE",
              email: "concurrent-uae@example.test",
              phone: "+971551234567",
            }),
        ),
      );

      expect(submissions.filter((response) => response.status === 201)).toHaveLength(1);
      expect(submissions.filter((response) => response.status === 200)).toHaveLength(5);
      const ids = new Set(submissions.map((response) => response.body.contact.id));
      expect(ids.size).toBe(1);
      expect(submissions.every((response) => response.body.contact.phone === "+971551234567"))
        .toBe(true);

      const stored = await pool.query<{ count: string; active_count: string }>(
        `SELECT count(*)::text AS count,
                count(*) FILTER (WHERE archived_at IS NULL)::text AS active_count
           FROM contacts
          WHERE workspace_owner_id = $1`,
        [WORKSPACE_ID],
      );
      expect(stored.rows[0]).toEqual({ count: "1", active_count: "1" });
    });
  },
);
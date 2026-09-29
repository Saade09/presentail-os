/**
 * Integration tests for the Lebanon Bank Reconciliation API endpoints and the
 * Lebanon-specific close gate in the Monthly Close (accounting) endpoint.
 *
 * Strategy: vi.mock the raw db.query, auth, and workspace modules so we can
 * control exactly what every DB call returns. No real DB or Odoo connection
 * is needed.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";
import type { WorkspaceRequest } from "../lib/workspace";

const { mockSafeOdooFetch } = vi.hoisted(() => ({
  mockSafeOdooFetch: vi.fn(),
}));

vi.mock("../lib/finance/odooUrl", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/finance/odooUrl")>();
  return {
    ...actual,
    safeOdooFetch: (...args: unknown[]) => mockSafeOdooFetch(...args),
  };
});

// ── db mock ──────────────────────────────────────────────────────────────────

const mockDbQuery = vi.fn();
const mockDbConnect = vi.fn();
const mockWithTransaction = vi.fn();

vi.mock("../lib/db", () => ({
  db: {
    query: (...args: unknown[]) => mockDbQuery(...args),
    connect: (...args: unknown[]) => mockDbConnect(...args),
  },
  withTransaction: (...args: unknown[]) => mockWithTransaction(...args),
}));

// ── object-storage mock ───────────────────────────────────────────────────────
// The upload helper calls: objectStorageClient.bucket(b).file(f).save(buf, opts)

const mockSave = vi.fn().mockResolvedValue(undefined);
const mockFile = vi.fn().mockReturnValue({ save: mockSave });
const mockBucket = vi.fn().mockReturnValue({ file: mockFile });

vi.mock("../lib/objectStorage", () => ({
  objectStorageClient: {
    bucket: (...args: unknown[]) => mockBucket(...args),
  },
  objectStorageService: {
    getPrivateObjectDir: vi.fn().mockReturnValue("objects/private"),
    getPublicObjectDir: vi.fn().mockReturnValue("objects/public"),
  },
}));

// ── parser mock ───────────────────────────────────────────────────────────────

const mockParseBLOMBuffer = vi.fn();

const DEFAULT_PARSE_RESULT = {
  periodStart: "01/07/2026",
  periodEnd: "31/07/2026",
  accountType: "Current Account",
  maskedAccountNumber: "LB12 **** **** 1234",
  currency: "LBP",
  openingBalance: -1_000_000,
  closingBalance: -800_000,
  moneyReceived: 200_000,
  moneyPaid: 0,
  balanceDifference: 0,
  balanceCheckPassed: true,
  postedRows: [
    {
      businessDate: "15/07/2026",
      valueDate: "15/07/2026",
      narrative: "Test Credit",
      details: "Details",
      transactionRef: "REF-001",
      debitAmount: null,
      creditAmount: 200_000,
      balance: -800_000,
      lineType: "posted" as const,
      sourceRowIndex: 10,
    },
  ],
  pendingRows: [],
};

vi.mock("../lib/lbBankRecon/blomParser", () => ({
  parseBLOMBuffer: (...args: unknown[]) => mockParseBLOMBuffer(...args),
  BLOMParseError: class BLOMParseError extends Error {
    constructor(msg: string) {
      super(msg);
      this.name = "BLOMParseError";
    }
  },
}));

// ── auth mock ─────────────────────────────────────────────────────────────────

let stubUserId = "user_finance_abc";

vi.mock("../lib/auth", () => ({
  requireAuth: (_req: express.Request, _res: express.Response, next: express.NextFunction) =>
    next(),
  authed: (_req: express.Request) => ({ userId: stubUserId }),
}));

// ── logger mock ───────────────────────────────────────────────────────────────

vi.mock("../lib/logger", () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn().mockReturnThis(),
  },
}));

// ── misc mocks for accounting.ts imports ──────────────────────────────────────

const mockSyncBankStatementLines = vi.fn();
const mockCreateConnector = vi.fn((_entity: unknown) => ({
  syncBankStatementLines: mockSyncBankStatementLines,
  refreshOdooReconciliationState: vi.fn(async (ids: number[]) =>
    ids.map((statementLineId) => ({
      statementLineId,
      isReconciled: true,
      moveLineIds: [statementLineId, statementLineId + 1000],
       liquidityMoveLineIds: [],
       unreconciledLiquidityMoveLineIds: [],
       statementSideEligibleMoveLineIds: [statementLineId],
       unreconciledStatementSideEligibleMoveLineIds: [statementLineId],
      moveLineReconciled: true,
    }))),
   validateOdooMoveLineSelection: vi.fn(async (ids: number[]) =>
     ids.map((id) => ({
       id,
       company_id: 2,
       account_id: 500,
       reconciled: false,
       reconcilable: true,
     }))),
  reconcileOdooMoveLines: vi.fn().mockResolvedValue({}),
}));
vi.mock("../lib/finance/connectorFactory", () => ({
  createConnector: (entity: unknown) => mockCreateConnector(entity),
}));
vi.mock("../lib/xlsxHelper", () => ({ parseSpreadsheetToJson: vi.fn(), writeXlsx: vi.fn() }));
vi.mock("../lib/accountingStripeSync", () => ({ runStripeSync: vi.fn() }));
vi.mock("../lib/accountingPaypalSync", () => ({ runPaypalSync: vi.fn() }));
vi.mock("../lib/accountingCashSync", () => ({ runCashSync: vi.fn() }));
vi.mock("../lib/accountingReconciliation", () => ({ reconcileSourceMonth: vi.fn() }));
vi.mock("../lib/accountingJournalEntry", () => ({
  generateJournalEntry: vi.fn(),
  getJournalEntry: vi.fn(),
  DEFAULT_ACCOUNT_CODES: {},
}));
vi.mock("../lib/accountingVat", () => ({
  generateVatSummary: vi.fn(),
  getVatSummary: vi.fn(),
}));
vi.mock("@workspace/integrations-anthropic-ai-server", () => ({
  anthropic: { messages: { create: vi.fn() } },
}));

// ── workspace mock ────────────────────────────────────────────────────────────

let stubWorkspaceOwnerId = "owner_lb_test";
let stubWorkspaceRole: "owner" | "member" = "owner";
let stubAllowedPages: string[] | null = ["finance_accounting", "finance_manager"];

vi.mock("../lib/workspace", () => ({
  resolveWorkspace: (
    req: express.Request,
    _res: express.Response,
    next: express.NextFunction,
  ) => {
    const wreq = req as unknown as WorkspaceRequest;
    wreq.workspaceOwnerId = stubWorkspaceOwnerId;
    wreq.workspaceActualRole = stubWorkspaceRole;
    wreq.workspaceRole = stubWorkspaceRole;
    wreq.userId = stubUserId;
    wreq.userEmail = "finance@example.com";
    wreq.allowedPages = stubAllowedPages;
    next();
  },
  workspace: (req: express.Request) => req as unknown as WorkspaceRequest,
}));

// ── Routers under test ────────────────────────────────────────────────────────

import lbBankReconRouter from "./lbBankRecon";
import accountingRouter from "./accounting";

// ── Express apps ──────────────────────────────────────────────────────────────

function makeReconApp() {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as { log: Record<string, unknown> }).log = {
      error: vi.fn(),
      warn: vi.fn(),
      info: vi.fn(),
    };
    next();
  });
  app.use(lbBankReconRouter);
  app.use(
    (
      err: Error,
      _req: express.Request,
      res: express.Response,
      _next: express.NextFunction,
    ) => {
      res.status(500).json({ error: err.message });
    },
  );
  return app;
}

function makeAccountingApp() {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as { log: Record<string, unknown> }).log = {
      error: vi.fn(),
      warn: vi.fn(),
      info: vi.fn(),
    };
    next();
  });
  app.use(accountingRouter);
  app.use(
    (
      err: Error,
      _req: express.Request,
      res: express.Response,
      _next: express.NextFunction,
    ) => {
      res.status(500).json({ error: err.message });
    },
  );
  return app;
}

// ── Shared fixtures ───────────────────────────────────────────────────────────

const LB_ENTITY_ROW = {
  id: 1,
  workspace_owner_id: "owner_lb_test",
  country: "LB",
  entity_name: "Presentail SAL",
  is_active: true,
  odoo_url: "https://odoo.example.com",
  odoo_db: "presentail_lb",
  odoo_uid: 1,
  odoo_password: "pass",
};

const ODOO_LB_ENTITY_ROW = {
  id: 1,
  workspace_owner_id: "owner_lb_test",
  legal_name: "Presentail SAL",
  display_name: "Presentail Lebanon",
  country: "LB",
  tax_registration_number: null,
  accounting_system: "odoo",
  odoo_company_id: 2,
  odoo_company_name: "Presentail SAL",
  odoo_database: "presentail_prod",
  odoo_base_url: "https://odoo.example.com",
  odoo_integration_token: "server-only-secret",
  default_currency: "USD",
  is_active: true,
  created_at: "2026-01-01T00:00:00Z",
};

const ACCOUNT_ROW = {
  id: 10,
  workspace_owner_id: "owner_lb_test",
  account_name: "BLOM Account USD",
  bank_name: "BLOM Bank",
  currency: "USD",
  is_active: true,
  is_required_for_close: true,
  odoo_journal_id: 5,
  odoo_journal_name: "BLOM USD",
};

const STATEMENT_ROW = {
  id: 100,
  workspace_owner_id: "owner_lb_test",
  account_id: 10,
  original_filename: "blom-july-2026.xlsx",
  period_start: "01/07/2026",
  period_end: "31/07/2026",
  file_hash: "abc123",
  status: "uploaded",
  odoo_sync_status: null,
  reconciliation_status: "pending",
  reconciled_at: null,
  metadata: {},
  // Fields joined by requireStatement
  odoo_journal_id: 5,
  bank_name: "BLOM Bank",
};

// ── Reset before each test ────────────────────────────────────────────────────

beforeEach(() => {
  // mockReset clears mock.calls AND the once-queue (prevents test bleed)
  mockDbQuery.mockReset();
  // Default: return empty for any un-mocked call so .rows access doesn't throw
  mockDbQuery.mockResolvedValue({ rows: [], rowCount: 0 });

  mockParseBLOMBuffer.mockReset();
  mockParseBLOMBuffer.mockResolvedValue(DEFAULT_PARSE_RESULT);

  mockWithTransaction.mockReset();
  mockWithTransaction.mockImplementation(
    async (client: unknown, cb: (c: unknown) => Promise<unknown>) => cb(client),
  );
  mockDbConnect.mockReset();
  mockDbConnect.mockImplementation(() => ({
    query: vi.fn().mockImplementation(async (sql: string) => {
      if (sql.includes("pg_try_advisory_lock")) return { rows: [{ locked: true }], rowCount: 1 };
      if (sql.includes("pg_advisory_unlock")) return { rows: [{ pg_advisory_unlock: true }], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    }),
    release: vi.fn(),
  }));

  mockSave.mockReset();
  mockSave.mockResolvedValue(undefined);
  mockCreateConnector.mockClear();
  mockSyncBankStatementLines.mockReset();
  mockSafeOdooFetch.mockReset();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();

  stubWorkspaceOwnerId = "owner_lb_test";
  stubWorkspaceRole = "owner";
  stubAllowedPages = ["finance_accounting", "finance_manager"];
  stubUserId = "user_finance_abc";
});

// ─────────────────────────────────────────────────────────────────────────────
// lb-bank-recon: Odoo connection state and health messaging
// ─────────────────────────────────────────────────────────────────────────────

describe("GET /lb-bank-recon/odoo-connection", () => {
  function stubSuccessfulJson2Diagnostics() {
    vi.stubEnv("ODOO_API_KEY", "server-only-secret");
    mockSafeOdooFetch.mockImplementation(async (url: string) => {
      if (url.endsWith("/res.users/context_get")) return new Response(JSON.stringify({ uid: 2 }), { status: 200 });
      if (url.endsWith("/res.company/search_read")) {
        return new Response(JSON.stringify([{ id: 2, name: "Presentail SAL", currency_id: [96, "Lebanese pound"] }]), { status: 200 });
      }
      if (url.endsWith("/account.journal/search_read")) {
        return new Response(JSON.stringify([{
          id: 5,
          name: "BLOM USD",
          code: "BNK2",
          type: "bank",
          company_id: [2, "Presentail SAL"],
          currency_id: [1, "USD"],
          default_account_id: [1903, "Bank"],
          bank_account_id: [1, "BLOM USD"],
        }]), { status: 200 });
      }
      return new Response("true", { status: 200 });
    });
  }

  it("returns a configurable missing-entity state to finance-accounting members", async () => {
    const app = makeReconApp();
    stubWorkspaceRole = "member";
    stubAllowedPages = ["finance_accounting"];
    mockDbQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const res = await request(app).get("/lb-bank-recon/odoo-connection");

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      entity_id: null,
      connected: false,
      configured: false,
      error: expect.stringMatching(/no active Lebanon finance entity/i),
    });
  });

  it("passes database and company identifiers to a successful health check without returning the token", async () => {
    const app = makeReconApp();
    stubSuccessfulJson2Diagnostics();
    mockDbQuery
      .mockResolvedValueOnce({ rows: [ODOO_LB_ENTITY_ROW], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [{ last_sync_at: null }], rowCount: 1 });

    const res = await request(app).get("/lb-bank-recon/odoo-connection");

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      connected: true,
      configured: true,
      entity_id: ODOO_LB_ENTITY_ROW.id,
      odoo_database: ODOO_LB_ENTITY_ROW.odoo_database,
      odoo_company_id: ODOO_LB_ENTITY_ROW.odoo_company_id,
    });
    const json2Url = String(mockSafeOdooFetch.mock.calls[0]?.[0]);
    expect(json2Url).toContain("/json/2/res.users/context_get");
    const options = mockSafeOdooFetch.mock.calls[0]?.[1] as RequestInit;
    expect(options.headers).toMatchObject({
      Authorization: "bearer server-only-secret",
      "X-Odoo-Database": "presentail_prod",
    });
    expect(mockSafeOdooFetch.mock.calls.some((call: unknown[]) =>
      String(call[0]).endsWith("/account.journal/search_read"),
    )).toBe(true);
    expect(res.body).not.toHaveProperty("odoo_integration_token");
    expect(JSON.stringify(res.body)).not.toContain(ODOO_LB_ENTITY_ROW.odoo_integration_token);
  });

  it("maps authentication failures to an actionable redacted message", async () => {
    const app = makeReconApp();
    vi.stubEnv("ODOO_API_KEY", "server-only-secret");
    mockSafeOdooFetch.mockResolvedValue(
      new Response(`Invalid token ${ODOO_LB_ENTITY_ROW.odoo_integration_token}`, { status: 401 }),
    );
    mockDbQuery
      .mockResolvedValueOnce({ rows: [ODOO_LB_ENTITY_ROW], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [{ last_sync_at: null }], rowCount: 1 });

    const res = await request(app).get("/lb-bank-recon/odoo-connection");

    expect(res.status).toBe(200);
    expect(res.body.connected).toBe(false);
    expect(res.body.error).toMatch(/JSON-2 authentication failed.*ODOO_API_KEY/i);
    expect(JSON.stringify(res.body)).not.toContain(ODOO_LB_ENTITY_ROW.odoo_integration_token);
  });

  it("maps a missing addon endpoint to an actionable message", async () => {
    const app = makeReconApp();
    vi.stubEnv("ODOO_API_KEY", "server-only-secret");
    mockSafeOdooFetch.mockResolvedValue(new Response("Not found", { status: 404 }));
    mockDbQuery
      .mockResolvedValueOnce({ rows: [ODOO_LB_ENTITY_ROW], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [{ last_sync_at: null }], rowCount: 1 });

    const res = await request(app).get("/lb-bank-recon/odoo-connection");

    expect(res.status).toBe(200);
    expect(res.body.error).toMatch(/JSON-2 database, model, or method.*not found/i);
  });

  it.each([
    [Object.assign(new Error("getaddrinfo ENOTFOUND server-only-secret"), { code: "ENOTFOUND" }), /hostname.*resolved.*DNS/i],
    [Object.assign(new Error("self signed certificate server-only-secret"), { code: "DEPTH_ZERO_SELF_SIGNED_CERT" }), /TLS verification.*certificate.*hostname/i],
    [Object.assign(new Error("request server-only-secret"), { name: "TimeoutError" }), /timed out.*endpoint.*network/i],
  ])("maps network failures to actionable token-safe messages", async (failure, expected) => {
    const app = makeReconApp();
    vi.stubEnv("ODOO_API_KEY", "server-only-secret");
    mockSafeOdooFetch.mockRejectedValue(failure);
    mockDbQuery
      .mockResolvedValueOnce({ rows: [ODOO_LB_ENTITY_ROW], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [{ last_sync_at: null }], rowCount: 1 });

    const res = await request(app).get("/lb-bank-recon/odoo-connection");

    expect(res.status).toBe(200);
    expect(res.body.connected).toBe(false);
    expect(res.body.error).toMatch(expected);
    expect(JSON.stringify(res.body)).not.toContain(ODOO_LB_ENTITY_ROW.odoo_integration_token);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// lb-bank-recon: duplicate file upload → 409
// ─────────────────────────────────────────────────────────────────────────────

describe("POST /lb-bank-recon/statements/upload", () => {
  it("returns 409 when the same file hash has already been imported", async () => {
    const app = makeReconApp();

    // Call order: requireLebanonEntity → account lookup → duplicate hash check
    mockDbQuery
      .mockResolvedValueOnce({ rows: [LB_ENTITY_ROW], rowCount: 1 }) // requireLebanonEntity
      .mockResolvedValueOnce({ rows: [ACCOUNT_ROW], rowCount: 1 })   // account lookup
      .mockResolvedValueOnce({ rows: [{ id: 99 }], rowCount: 1 });   // duplicate hash found

    const res = await request(app)
      .post("/lb-bank-recon/statements/upload")
      .field("account_id", String(ACCOUNT_ROW.id))
      // The multer field name in the route is "statement", not "file"
      .attach("statement", Buffer.from("fake-xlsx-content"), {
        filename: "blom-july-2026.xlsx",
        contentType:
          "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      });

    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({
      error: expect.stringMatching(/duplicate|already.*upload|already.*import/i),
    });
  });

  it("returns 403 for a non-Lebanon workspace (requireLebanonEntity returns 403)", async () => {
    const app = makeReconApp();

    // requireLebanonEntity finds no Lebanon entity → 403
    mockDbQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const res = await request(app)
      .post("/lb-bank-recon/statements/upload")
      .field("account_id", "1")
      .attach("statement", Buffer.from("fake-xlsx-content"), {
        filename: "blom.xlsx",
        contentType:
          "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      });

    expect(res.status).toBe(403);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// lb-bank-recon: Odoo sync — partial retry syncs only non-success lines
// ─────────────────────────────────────────────────────────────────────────────

describe("POST /lb-bank-recon/statements/:id/sync", () => {
  it("returns 423 when the period is already closed", async () => {
    const app = makeReconApp();

    // Call order: requireLebanonEntity → requireStatement → isPeriodClosedForStatement
    mockDbQuery
      .mockResolvedValueOnce({ rows: [ODOO_LB_ENTITY_ROW], rowCount: 1 })  // requireLebanonEntity
      .mockResolvedValueOnce({ rows: [STATEMENT_ROW], rowCount: 1 })  // requireStatement
      .mockResolvedValueOnce({ rows: [{ status: "closed" }], rowCount: 1 }); // isPeriodClosed

    const res = await request(app).post("/lb-bank-recon/statements/100/sync");

    expect(res.status).toBe(423);
    expect(res.body.error).toMatch(/closed|read.?only/i);
  });

  it("returns 404 when the statement is not found", async () => {
    const app = makeReconApp();

    // requireLebanonEntity returns entity, requireStatement returns nothing → 404
    mockDbQuery
      .mockResolvedValueOnce({ rows: [ODOO_LB_ENTITY_ROW], rowCount: 1 }) // requireLebanonEntity
      .mockResolvedValueOnce({ rows: [], rowCount: 0 });              // requireStatement → 404

    const res = await request(app).post("/lb-bank-recon/statements/999/sync");

    expect(res.status).toBe(404);
  });

  it("only queries lines not already successfully synced (partial retry)", async () => {
    const app = makeReconApp();

    // Call order: requireLebanonEntity → requireStatement → isPeriodClosed → lines-to-sync query
    mockDbQuery
      .mockResolvedValueOnce({ rows: [ODOO_LB_ENTITY_ROW], rowCount: 1 })  // requireLebanonEntity
      .mockResolvedValueOnce({ rows: [STATEMENT_ROW], rowCount: 1 })  // requireStatement
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })               // isPeriodClosed → open
      .mockResolvedValueOnce({ rows: [], rowCount: 0 });              // lines-to-sync → none pending

    const res = await request(app).post("/lb-bank-recon/statements/100/sync");

    // No pending lines → 200 (nothing to sync is not an error)
    expect([200, 207]).toContain(res.status);
    const lockClient = mockDbConnect.mock.results[0]?.value as {
      query: ReturnType<typeof vi.fn>;
      release: ReturnType<typeof vi.fn>;
    };
    expect(lockClient.query.mock.calls[0][0]).toContain("pg_try_advisory_lock");
    expect(lockClient.query.mock.calls.at(-1)?.[0]).toContain("pg_advisory_unlock");
    expect(lockClient.release).toHaveBeenCalledTimes(1);

    // Verify the SQL fetching lines to sync includes a filter for non-success rows
    const syncLineSqlCall = mockDbQuery.mock.calls.find(
      (call: unknown[]) =>
        typeof call[0] === "string" &&
        call[0].toLowerCase().includes("lb_bank_statement_lines") &&
        (call[0].toLowerCase().includes("not exists") ||
          call[0].toLowerCase().includes("success")),
    );
    expect(syncLineSqlCall).toBeTruthy();
  });

  it("rejects sync when the active Lebanon entity is not fully configured for Odoo", async () => {
    const app = makeReconApp();
    mockDbQuery.mockResolvedValueOnce({
      rows: [{ ...ODOO_LB_ENTITY_ROW, accounting_system: "manual" }],
      rowCount: 1,
    });

    const res = await request(app).post("/lb-bank-recon/statements/100/sync");

    expect(res.status).toBe(422);
    expect(res.body.error).toMatch(/configure.*Presentail SAL.*company 2.*before syncing/i);
    expect(mockCreateConnector).not.toHaveBeenCalled();
    expect(mockSyncBankStatementLines).not.toHaveBeenCalled();
  });

  it("rejects a posted line without a durable fingerprint before any Odoo call", async () => {
    const app = makeReconApp();
    mockDbQuery
      .mockResolvedValueOnce({ rows: [ODOO_LB_ENTITY_ROW], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [STATEMENT_ROW], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({
        rows: [{
          id: 41,
          line_type: "posted",
          line_date: "2026-07-15",
          fingerprint: null,
          currency: "USD",
          metadata: {},
        }],
        rowCount: 1,
      });

    const res = await request(app).post("/lb-bank-recon/statements/100/sync");

    expect(res.status).toBe(422);
    expect(res.body.error).toMatch(/fingerprint/i);
    expect(mockCreateConnector).not.toHaveBeenCalled();
  });

  it("serializes posted fingerprints with workspace and journal scope", async () => {
    const app = makeReconApp();
    mockSyncBankStatementLines.mockResolvedValue([
      { lineId: 41, success: true, odooRecordId: "8001" },
    ]);
    mockDbQuery
      .mockResolvedValueOnce({ rows: [ODOO_LB_ENTITY_ROW], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [STATEMENT_ROW], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({
        rows: [{
          id: 41,
          line_type: "posted",
          line_date: "2026-07-15",
          fingerprint: "fp-cross-statement",
          currency: "USD",
          metadata: {},
        }],
        rowCount: 1,
      });

    const res = await request(app).post("/lb-bank-recon/statements/100/sync");
    expect(res.status).toBe(200);
    const lockClient = mockDbConnect.mock.results[0]?.value as {
      query: ReturnType<typeof vi.fn>;
    };
    const fingerprintLock = lockClient.query.mock.calls.find(
      (call: unknown[]) => String(call[0]).includes("pg_try_advisory_lock") &&
        String((call[1] as unknown[] | undefined)?.[0]).includes("fp-cross-statement"),
    );
    expect(fingerprintLock?.[1]?.[0]).toContain("owner_lb_test");
    expect(fingerprintLock?.[1]?.[0]).toContain(":5:");
  });

  it("returns 409 on fingerprint lock contention without calling Odoo", async () => {
    const app = makeReconApp();
    const lockClient = {
      query: vi.fn(async (sql: string) => {
        if (sql.includes("pg_try_advisory_lock")) {
          const tryCount = lockClient.query.mock.calls.filter(
            (call: unknown[]) => String(call[0]).includes("pg_try_advisory_lock"),
          ).length;
          return { rows: [{ locked: tryCount === 1 }], rowCount: 1 };
        }
        return { rows: [], rowCount: 1 };
      }),
      release: vi.fn(),
    };
    mockDbConnect.mockImplementationOnce(() => lockClient);
    mockDbQuery
      .mockResolvedValueOnce({ rows: [ODOO_LB_ENTITY_ROW], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [STATEMENT_ROW], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({
        rows: [{
          id: 41,
          line_type: "posted",
          line_date: "2026-07-15",
          fingerprint: "fp-contended",
          currency: "USD",
          metadata: {},
        }],
        rowCount: 1,
      });

    const res = await request(app).post("/lb-bank-recon/statements/100/sync");

    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/fingerprint/i);
    expect(mockSyncBankStatementLines).not.toHaveBeenCalled();
    expect(lockClient.query.mock.calls.at(-1)?.[0]).toContain("pg_advisory_unlock");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// lb-bank-recon: reconcile endpoint — balance difference and sync blockers
// ─────────────────────────────────────────────────────────────────────────────

describe("POST /lb-bank-recon/statements/:id/reconcile", () => {
  it("denies reconciliation to finance-accounting members without manager approval", async () => {
    const app = makeReconApp();
    stubWorkspaceRole = "member";
    stubAllowedPages = ["finance_accounting"];

    const res = await request(app).post("/lb-bank-recon/statements/100/reconcile");

    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/finance manager/i);
    expect(mockDbQuery).not.toHaveBeenCalled();
  });

  it("returns 423 when the period is already closed", async () => {
    const app = makeReconApp();

    // Call order: requireLebanonEntity → requireStatement → isPeriodClosed
    mockDbQuery
      .mockResolvedValueOnce({ rows: [LB_ENTITY_ROW], rowCount: 1 })          // requireLebanonEntity
      .mockResolvedValueOnce({ rows: [{ ...STATEMENT_ROW, metadata: {} }], rowCount: 1 }) // requireStatement
      .mockResolvedValueOnce({ rows: [{ status: "closed" }], rowCount: 1 });  // isPeriodClosed

    const res = await request(app).post("/lb-bank-recon/statements/100/reconcile");

    expect(res.status).toBe(423);
    expect(res.body.error).toMatch(/closed|read.?only/i);
  });

  it("returns 422 when the statement has a non-zero balance difference", async () => {
    const app = makeReconApp();

    // requireLebanonEntity → requireStatement (with balance discrepancy) → not closed → preconditions
    mockDbQuery
      .mockResolvedValueOnce({ rows: [LB_ENTITY_ROW], rowCount: 1 })
      .mockResolvedValueOnce({
        rows: [{ ...STATEMENT_ROW, metadata: { balanceDifference: 12345, balanceCheckPassed: false } }],
        rowCount: 1,
      })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 }) // isPeriodClosed → open
      .mockResolvedValueOnce({
        rows: [{ total_posted: "5", unsynced: "0", unclassified: "0", open_exceptions: "0" }],
        rowCount: 1,
      });

    const res = await request(app).post("/lb-bank-recon/statements/100/reconcile");

    // Reconcile endpoint returns 422 for precondition failures (not 409)
    expect(res.status).toBe(422);
    expect(res.body.blockers).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/balance.*difference|discrepancy|balance does not reconcile/i),
      ]),
    );
  });

  it("returns 422 when posted lines have not been fully synced to Odoo", async () => {
    const app = makeReconApp();

    // requireLebanonEntity → requireStatement (clean metadata) → not closed → preconditions (unsynced=3)
    mockDbQuery
      .mockResolvedValueOnce({ rows: [LB_ENTITY_ROW], rowCount: 1 })
      .mockResolvedValueOnce({
        rows: [{ ...STATEMENT_ROW, metadata: { balanceDifference: 0, balanceCheckPassed: true } }],
        rowCount: 1,
      })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 }) // isPeriodClosed → open
      .mockResolvedValueOnce({
        rows: [{ total_posted: "10", unsynced: "3", unclassified: "0", open_exceptions: "0" }],
        rowCount: 1,
      });

    const res = await request(app).post("/lb-bank-recon/statements/100/reconcile");

    // Reconcile endpoint returns 422 for precondition failures (not 409)
    expect(res.status).toBe(422);
    expect(res.body.blockers).toEqual(
      expect.arrayContaining([expect.stringMatching(/sync/i)]),
    );
  });

  it("blocks local reconciliation when posted lines have missing or duplicate Odoo IDs", async () => {
    const app = makeReconApp();
    mockDbQuery
      .mockResolvedValueOnce({ rows: [LB_ENTITY_ROW], rowCount: 1 })
      .mockResolvedValueOnce({
        rows: [{ ...STATEMENT_ROW, metadata: { balanceDifference: 0, balanceCheckPassed: true } }],
        rowCount: 1,
      })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({
        rows: [{ total_posted: "3", unsynced: "0", unclassified: "0", open_exceptions: "0" }],
        rowCount: 1,
      })
      .mockResolvedValueOnce({
        rows: [{ odoo_record_id: "8001" }],
        rowCount: 1,
      });

    const res = await request(app).post("/lb-bank-recon/statements/100/reconcile");

    expect(res.status).toBe(422);
    expect(res.body.blockers).toEqual(
      expect.arrayContaining([expect.stringMatching(/unique Odoo statement-line ID/i)]),
    );
    expect(mockCreateConnector).not.toHaveBeenCalled();
  });
});

describe("POST /lb-bank-recon/statements/:id/odoo-reconcile", () => {
  it("denies explicit Odoo reconciliation to non-managers", async () => {
    const app = makeReconApp();
    stubWorkspaceRole = "member";
    stubAllowedPages = ["finance_accounting"];

    const res = await request(app)
      .post("/lb-bank-recon/statements/100/odoo-reconcile")
      .send({ move_line_ids: [10, 11] });

    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/finance manager/i);
  });

  it("rejects duplicate selected move-line IDs before querying Odoo", async () => {
    const app = makeReconApp();
    mockDbQuery
      .mockResolvedValueOnce({ rows: [ODOO_LB_ENTITY_ROW], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({ rows: [STATEMENT_ROW], rowCount: 1 });
    const res = await request(app)
      .post("/lb-bank-recon/statements/100/odoo-reconcile")
      .send({ move_line_ids: [10, 10] });

    expect(res.status).toBe(422);
    expect(res.body.error).toMatch(/duplicate/i);
    expect(mockSafeOdooFetch).not.toHaveBeenCalled();
  });

  it("rejects move-line IDs from another synced bank statement", async () => {
    const app = makeReconApp();
    mockDbQuery
      .mockResolvedValueOnce({ rows: [ODOO_LB_ENTITY_ROW], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({ rows: [STATEMENT_ROW], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [{ odoo_record_id: "8001" }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [{ odoo_record_id: "9001" }], rowCount: 1 });

    const res = await request(app)
      .post("/lb-bank-recon/statements/100/odoo-reconcile")
      .send({ move_line_ids: [8001, 9001] });

    expect(res.status).toBe(422);
    expect(res.body.error).toMatch(/another synced statement|part of this statement/i);
  });

  it("allows a validated external invoice or payment counterpart", async () => {
    const app = makeReconApp();
    mockCreateConnector.mockImplementationOnce(() => ({
      syncBankStatementLines: mockSyncBankStatementLines,
      refreshOdooReconciliationState: vi.fn(async (ids: number[]) =>
        ids.map((statementLineId) => ({
          statementLineId,
          isReconciled: false,
          moveLineIds: [statementLineId],
          liquidityMoveLineIds: [],
          unreconciledLiquidityMoveLineIds: [],
          statementSideEligibleMoveLineIds: [statementLineId],
          unreconciledStatementSideEligibleMoveLineIds: [statementLineId],
          moveLineReconciled: false,
        })),
      ),
      validateOdooMoveLineSelection: vi.fn(async (ids: number[]) =>
        ids.map((id) => ({
          id,
          company_id: 2,
          account_id: 500,
          reconciled: false,
          reconcilable: true,
        })),
      ),
      reconcileOdooMoveLines: vi.fn().mockResolvedValue({}),
    }));
    mockDbQuery
      .mockResolvedValueOnce({ rows: [ODOO_LB_ENTITY_ROW], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({ rows: [STATEMENT_ROW], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [{ odoo_record_id: "8001" }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const res = await request(app)
      .post("/lb-bank-recon/statements/100/odoo-reconcile")
      .send({ move_line_ids: [8001, 9001] });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      success: true,
      move_line_ids: [8001, 9001],
    });
  });

  it("rejects selected lines that use different reconcilable accounts", async () => {
    const app = makeReconApp();
    mockCreateConnector.mockImplementationOnce(() => ({
      syncBankStatementLines: mockSyncBankStatementLines,
      refreshOdooReconciliationState: vi.fn(async (ids: number[]) =>
        ids.map((statementLineId) => ({
          statementLineId,
          isReconciled: false,
          moveLineIds: [statementLineId, statementLineId + 1000],
          liquidityMoveLineIds: [],
          unreconciledLiquidityMoveLineIds: [],
          statementSideEligibleMoveLineIds: [statementLineId],
          unreconciledStatementSideEligibleMoveLineIds: [statementLineId],
          moveLineReconciled: false,
        })),
      ),
      validateOdooMoveLineSelection: vi.fn(async (ids: number[]) =>
        ids.map((id) => ({
          id,
          company_id: 2,
          account_id: id === 9001 ? 501 : 500,
          reconciled: false,
          reconcilable: true,
        })),
      ),
      reconcileOdooMoveLines: vi.fn(),
    }));
    mockDbQuery
      .mockResolvedValueOnce({ rows: [ODOO_LB_ENTITY_ROW], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({ rows: [STATEMENT_ROW], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [{ odoo_record_id: "8001" }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const res = await request(app)
      .post("/lb-bank-recon/statements/100/odoo-reconcile")
      .send({ move_line_ids: [8001, 9001] });

    expect(res.status).toBe(422);
    expect(res.body.error).toMatch(/same account/i);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// accounting close gate: Lebanon accounts not reconciled → blocked
// ─────────────────────────────────────────────────────────────────────────────

describe("POST /accounting/entity-months/:id/close — Lebanon close gate", () => {
  /**
   * Sets up the ordered DB mock sequence for the accounting close endpoint.
   *
   * computeAutoCompletedItems makes 5 queries (sources, exceptions, jeDraft,
   * jeApproval, docs). All mandatory checklist items are pre-checked so the
   * ONLY possible blockers can come from the Lebanon bank-recon gate.
   */
  function setupCloseMocks(opts: {
    entityCountry: "LB" | "CY" | "AE";
    unreconciledCount?: number;
    postedCount?: number;
    odooIdCount?: number;
    withOverride?: boolean;
  }) {
    const {
      entityCountry,
      unreconciledCount = 0,
      postedCount = 1,
      odooIdCount = 1,
      withOverride = false,
    } = opts;

    mockDbQuery
      // 1. SELECT em.* FROM accounting_entity_months
      .mockResolvedValueOnce({
        rows: [
          {
            id: 50,
            workspace_owner_id: stubWorkspaceOwnerId,
            accounting_month_id: 20,
            entity_id: 1,
            status: "open",
          },
        ],
        rowCount: 1,
      })
      // 2. SELECT checklist items — all mandatory pre-checked → no checklist blockers
      .mockResolvedValueOnce({
        rows: [
          { sort_order: 0,  label: "Sales verified",    is_checked: true },
          { sort_order: 4,  label: "Exceptions cleared", is_checked: true },
          { sort_order: 11, label: "Journal posted",     is_checked: true },
          { sort_order: 12, label: "VAT reviewed",       is_checked: true },
          { sort_order: 13, label: "Documents uploaded", is_checked: true },
        ],
        rowCount: 5,
      })
      // 3. computeAutoCompletedItems: sources query (sort_order 0)
      .mockResolvedValueOnce({ rows: [{ total: "1", pending: "0" }], rowCount: 1 })
      // 4. computeAutoCompletedItems: exceptions query (sort_order 4)
      .mockResolvedValueOnce({ rows: [{ open_count: "0" }], rowCount: 1 })
      // 5. computeAutoCompletedItems: jeDraft count (sort_order 10)
      .mockResolvedValueOnce({ rows: [{ cnt: "1" }], rowCount: 1 })
      // 6. computeAutoCompletedItems: jeApproval count (sort_order 11)
      .mockResolvedValueOnce({ rows: [{ cnt: "1" }], rowCount: 1 })
      // 7. computeAutoCompletedItems: docs count (sort_order 12)
      .mockResolvedValueOnce({ rows: [{ cnt: "1" }], rowCount: 1 })
      // 8. SELECT country FROM finance_entities
      .mockResolvedValueOnce({ rows: [{ country: entityCountry }], rowCount: 1 });

    if (entityCountry === "LB" && !withOverride) {
      mockDbQuery
        // 9. SELECT am.year, am.month (period lookup)
        .mockResolvedValueOnce({ rows: [{ year: 2026, month: 7 }], rowCount: 1 })
        // 10. COUNT(*) unreconciled required accounts
        .mockResolvedValueOnce({
          rows: [{ cnt: String(unreconciledCount) }],
          rowCount: 1,
        });
    }

    // Proceed with close if no blockers expected
    if (unreconciledCount === 0 || entityCountry !== "LB" || withOverride) {
      if (entityCountry === "LB" && !withOverride) {
        mockDbQuery
          .mockResolvedValueOnce({
            rows: [{
              account_id: 10,
              statement_count: "1",
              posted_count: String(postedCount),
              odoo_id_count: String(odooIdCount),
            }],
            rowCount: 1,
          }) // exact required statement and per-line Odoo IDs
          .mockResolvedValueOnce({ rows: [ODOO_LB_ENTITY_ROW], rowCount: 1 }) // Odoo entity refresh
          .mockResolvedValueOnce({ rows: [{ odoo_record_id: "8001" }], rowCount: 1 }); // synced Odoo lines
      }
      mockDbQuery
        .mockResolvedValueOnce({ rows: [], rowCount: 0 }) // sources snapshot
        .mockResolvedValueOnce({ rows: [], rowCount: 0 }) // exceptions snapshot
        .mockResolvedValueOnce({ rows: [], rowCount: 0 }) // JE snapshot
        .mockResolvedValueOnce({ rows: [{ id: 50 }], rowCount: 1 }) // UPDATE entity-month
        .mockResolvedValueOnce({ rows: [{ id: 1 }], rowCount: 1 }); // INSERT close_audit_events

      if (withOverride) {
        // INSERT lb_bank_audit_log
        mockDbQuery.mockResolvedValueOnce({ rows: [{ id: 2 }], rowCount: 1 });
      }
    }
  }

  it("returns 409 with 'Lebanon bank reconciliation incomplete' when accounts are not reconciled", async () => {
    const app = makeAccountingApp();
    setupCloseMocks({ entityCountry: "LB", unreconciledCount: 2 });

    const res = await request(app)
      .post("/accounting/entity-months/50/close")
      .send({});

    expect(res.status).toBe(409);
    expect(res.body.blockers).toContain("Lebanon bank reconciliation incomplete");
  });

  it("succeeds for a Lebanon entity-month when all required accounts are reconciled", async () => {
    const app = makeAccountingApp();
    setupCloseMocks({ entityCountry: "LB", unreconciledCount: 0 });

    const res = await request(app)
      .post("/accounting/entity-months/50/close")
      .send({});

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.status).toBe("closed");
    const periodSql = mockDbQuery.mock.calls
      .map((call: unknown[]) => String(call[0]))
      .filter((sql) => sql.includes("lb_bank_statements"))
      .join("\n");
    expect(periodSql).toContain("substring(s.period_start from 7 for 4)::int");
    expect(periodSql).not.toContain("TO_DATE");
    expect(periodSql).toContain("l.line_type = 'posted'");
  });

  it("blocks a required account with no posted lines even when its statement is locally reconciled", async () => {
    const app = makeAccountingApp();
    setupCloseMocks({ entityCountry: "LB", postedCount: 0, odooIdCount: 0 });

    const res = await request(app)
      .post("/accounting/entity-months/50/close")
      .send({});

    expect(res.status).toBe(409);
    expect(res.body.blockers).toEqual(
      expect.arrayContaining([expect.stringMatching(/posted.*Odoo ID|posted line/i)]),
    );
  });

  it("succeeds for a Cyprus entity-month without triggering the Lebanon bank reconciliation check", async () => {
    const app = makeAccountingApp();
    setupCloseMocks({ entityCountry: "CY" });

    const res = await request(app)
      .post("/accounting/entity-months/50/close")
      .send({});

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    // Verify the unreconciled-accounts COUNT query was NOT called for Cyprus
    const lbCountQuery = mockDbQuery.mock.calls.find(
      (call: unknown[]) =>
        typeof call[0] === "string" &&
        call[0].includes("lb_bank_accounts") &&
        call[0].includes("NOT EXISTS"),
    );
    expect(lbCountQuery).toBeUndefined();
  });

  it("bypasses the Lebanon bank-recon check when a finance-manager override reason is provided", async () => {
    const app = makeAccountingApp();
    setupCloseMocks({ entityCountry: "LB", withOverride: true });

    const overrideReason = "Manual override approved by CFO on 26 Aug 2026";
    const res = await request(app)
      .post("/accounting/entity-months/50/close")
      .send({ overrideReason });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);

    // Verify lb_bank_audit_log INSERT was called with the override action
    // mock.calls entries are [sql, params] tuples
    const auditCall = mockDbQuery.mock.calls.find(
      (call: unknown[]) =>
        typeof call[0] === "string" &&
        call[0].includes("lb_bank_audit_log") &&
        call[0].includes("close_override"),
    ) as [string, unknown[]] | undefined;
    expect(auditCall).toBeTruthy();
    // The override reason should appear somewhere in the params (as a JSON-stringified metadata)
    const params = auditCall![1];
    const hasOverrideRef = params.some(
      (p) => typeof p === "string" && p.toLowerCase().includes("override"),
    );
    expect(hasOverrideRef).toBe(true);
  });
});

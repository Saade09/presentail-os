import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";
import type { WorkspaceRequest } from "../lib/workspace";
import {
  buildPhoneSearchTokens,
  buildSearchTerms,
  normalizeQueryDigits,
} from "../lib/contactSearchNormalize";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockDbQuery = vi.fn();
vi.mock("../lib/db", () => ({
  db: { query: (...args: unknown[]) => mockDbQuery(...args) },
}));

const mockLogger = vi.hoisted(() => ({
  error: vi.fn(),
  warn: vi.fn(),
  info: vi.fn(),
}));
vi.mock("../lib/logger", () => ({ logger: mockLogger }));

vi.mock("../lib/auth", () => ({
  requireAuth: (_req: express.Request, _res: express.Response, next: express.NextFunction) =>
    next(),
  authed: (req: express.Request) => req,
}));

vi.mock("../lib/workspace", () => ({
  resolveWorkspace: (req: express.Request, _res: express.Response, next: express.NextFunction) => {
    const wreq = req as unknown as WorkspaceRequest;
    wreq.workspaceOwnerId = "ws-1";
    wreq.workspaceRole = "owner";
    wreq.workspaceActualRole = "owner";
    wreq.userId = "user-1";
    next();
  },
  workspace: (req: express.Request) => req as unknown as WorkspaceRequest,
}));

const mockCreateOrResolveContact = vi.fn();
vi.mock("../lib/contactUpsert", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/contactUpsert")>();
  return {
    ...actual,
    createOrResolveContact: (...args: unknown[]) => mockCreateOrResolveContact(...args),
  };
});

import contactsWizardRouter from "./contactsWizard";

const app = express();
app.use(express.json());
app.use("/api", contactsWizardRouter);

const contactRow = {
  id: "c-1",
  first_name: "Jane",
  last_name: "Doe",
  display_name: "Jane Doe",
  email: "jane@example.com",
  phone: "+961 70 123 456",
  orders_placed: 3,
  last_order_at: "2026-07-01T10:00:00.000Z",
};

beforeEach(() => {
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// Unit tests: buildPhoneSearchTokens
// ---------------------------------------------------------------------------

describe("buildPhoneSearchTokens", () => {
  it("returns E.164 digits, national significant number, and domestic form for a Lebanese number", () => {
    const tokens = buildPhoneSearchTokens("+9613257533");
    expect(tokens).toContain("9613257533"); // E.164 without +
    expect(tokens).toContain("3257533");    // national significant number
    expect(tokens).toContain("03257533");   // domestic form with trunk 0
  });

  it("returns correct forms for a UAE number", () => {
    // UAE mobile: +971 50 123 4567 (9-digit national number)
    const tokens = buildPhoneSearchTokens("+971501234567");
    expect(tokens).toContain("971501234567"); // E.164 without +
    expect(tokens).toContain("501234567");    // national significant number
    expect(tokens).toContain("0501234567");   // domestic form with trunk 0
  });

  it("handles formatted input with spaces, hyphens, and brackets", () => {
    const tokens = buildPhoneSearchTokens("+961 (03) 257-533");
    // Should parse the same as the unformatted version
    const plainTokens = buildPhoneSearchTokens("+9613257533");
    for (const t of plainTokens) {
      expect(tokens).toContain(t);
    }
  });

  it("handles fully international input (same number, already in E.164)", () => {
    const tokens1 = buildPhoneSearchTokens("+9613257533");
    const tokens2 = buildPhoneSearchTokens("+961-03-257533");
    // Both should produce the same national significant number and domestic form
    expect(tokens1).toContain("3257533");
    expect(tokens2).toContain("3257533");
  });

  it("falls back to raw stripped digits for unrecognizable input", () => {
    const tokens = buildPhoneSearchTokens("12345");
    expect(tokens).toEqual(["12345"]);
  });

  it("returns empty array for null/empty input", () => {
    expect(buildPhoneSearchTokens(null)).toEqual([]);
    expect(buildPhoneSearchTokens("")).toEqual([]);
    expect(buildPhoneSearchTokens(undefined)).toEqual([]);
  });

  it("includes raw stripped digits in the token set for any valid number", () => {
    // Even for E.164 numbers, raw digits are included as a safety net
    const tokens = buildPhoneSearchTokens("+9613257533");
    expect(tokens).toContain("9613257533");
  });

  // ── Lebanese / 3-digit-CC regression: exactly-10-digit stripped numbers ───
  // Previously the SQL backfill used `> 10` instead of `>= 10` so
  // +961 numbers (10 stripped digits) never got the domestic "03…" token.
  it("produces the domestic 0-prefix token for a Lebanese 8-digit local number (trunk-prefix regression)", () => {
    // +9613257553 → stripped "9613257553" (10 digits, 3-digit CC + 7-digit NSN)
    const tokens = buildPhoneSearchTokens("+9613257553");
    expect(tokens).toContain("9613257553"); // E.164 digits
    expect(tokens).toContain("3257553");    // national significant number
    expect(tokens).toContain("03257553");   // domestic trunk-prefix form
  });

  it("produces the same tokens regardless of E.164 formatting variations (+, spaces, dashes)", () => {
    const plain = buildPhoneSearchTokens("+9613257553");
    const spaced = buildPhoneSearchTokens("+961 3 257 553");
    const dashed = buildPhoneSearchTokens("+961-03-257553");
    for (const t of plain) {
      expect(spaced).toContain(t);
      expect(dashed).toContain(t);
    }
  });

  it("produces correct tokens for the bare national number (no + or country code)", () => {
    // When user pastes just "9613257553" (no leading +) the library still
    // parses it as Lebanon and produces domestic form.
    const tokens = buildPhoneSearchTokens("9613257553");
    // At minimum the raw digits must be present.
    expect(tokens).toContain("9613257553");
  });
});

// ---------------------------------------------------------------------------
// Unit tests: buildSearchTerms (with raised 4-digit threshold)
// ---------------------------------------------------------------------------

describe("buildSearchTerms", () => {
  it("returns empty phoneDigits for fewer than 4 digits", () => {
    expect(buildSearchTerms("123").phoneDigits).toBe("");
    expect(buildSearchTerms("03").phoneDigits).toBe("");
  });

  it("returns phoneDigits for 4 or more digits", () => {
    expect(buildSearchTerms("0325").phoneDigits).toBe("0325");
    expect(buildSearchTerms("03257").phoneDigits).toBe("03257");
  });

  it("returns empty nameQuery for digit-only input", () => {
    expect(buildSearchTerms("70123").nameQuery).toBe("");
  });

  it("returns nameQuery for letter-containing input", () => {
    expect(buildSearchTerms("Jane").nameQuery).toBe("Jane");
  });

  it("returns emailQuery only when @ is present", () => {
    const t = buildSearchTerms("jane@example.com");
    expect(t.emailQuery).toBe("jane@example.com");
    expect(t.nameQuery).toBe("");
  });

  it("ignores formatting characters in phone queries", () => {
    expect(buildSearchTerms("+961 70-123").phoneDigits).toBe("96170123");
  });
});

// ---------------------------------------------------------------------------
// Unit tests: normalizeQueryDigits
// ---------------------------------------------------------------------------

describe("normalizeQueryDigits", () => {
  it("strips all non-digit characters", () => {
    expect(normalizeQueryDigits("+961 (03) 257-533")).toBe("9610325753 3".replace(/\s/g, ""));
    expect(normalizeQueryDigits("+961 (03) 257-533")).toBe("9610325753 3".replace(/ /g, ""));
  });

  it("handles empty/null input", () => {
    expect(normalizeQueryDigits(null)).toBe("");
    expect(normalizeQueryDigits("")).toBe("");
  });
});

// ---------------------------------------------------------------------------
// GET /contacts/wizard-search
// ---------------------------------------------------------------------------

describe("GET /api/contacts/wizard-search", () => {
  it("returns empty results without querying for a blank query", async () => {
    const res = await request(app).get("/api/contacts/wizard-search?q=");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ results: [] });
    expect(mockDbQuery).not.toHaveBeenCalled();
  });

  it("returns empty results for a query with fewer than 4 digits (raised threshold)", async () => {
    const res = await request(app).get("/api/contacts/wizard-search?q=032");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ results: [] });
    expect(mockDbQuery).not.toHaveBeenCalled();
  });

  it("searches by token-based phone matching for a local-format query (≥4 digits)", async () => {
    mockDbQuery.mockResolvedValueOnce({ rows: [contactRow] });
    const res = await request(app).get(
      "/api/contacts/wizard-search?q=" + encodeURIComponent("03257"),
    );
    expect(res.status).toBe(200);
    expect(res.body.results).toHaveLength(1);
    expect(res.body.results[0].id).toBe("c-1");
    const [sql, params] = mockDbQuery.mock.calls[0] as [string, unknown[]];
    // Should use unnest/LIKE pattern for token matching
    expect(sql).toContain("unnest(c.phone_search_tokens)");
    // Prefix match: "03257%"
    expect((params as string[]).some((p) => typeof p === "string" && p.endsWith("%") && p.includes("03257"))).toBe(true);
  });

  it("matches an international query (E.164 format)", async () => {
    mockDbQuery.mockResolvedValueOnce({ rows: [contactRow] });
    const res = await request(app).get(
      "/api/contacts/wizard-search?q=" + encodeURIComponent("+9613257533"),
    );
    expect(res.status).toBe(200);
    expect(res.body.results).toHaveLength(1);
    const [sql] = mockDbQuery.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain("unnest(c.phone_search_tokens)");
  });

  it("falls back to legacy regex clause for un-backfilled contacts", async () => {
    mockDbQuery.mockResolvedValueOnce({ rows: [contactRow] });
    const res = await request(app).get(
      "/api/contacts/wizard-search?q=" + encodeURIComponent("03257"),
    );
    expect(res.status).toBe(200);
    const [sql] = mockDbQuery.mock.calls[0] as [string, unknown[]];
    // Must include both token path AND legacy fallback
    expect(sql).toContain("phone_search_tokens IS NULL");
    expect(sql).toContain("regexp_replace");
  });

  it("includes a legacy-style substring param for un-backfilled fallback", async () => {
    mockDbQuery.mockResolvedValueOnce({ rows: [] });
    await request(app).get(
      "/api/contacts/wizard-search?q=" + encodeURIComponent("03257"),
    );
    const [, params] = mockDbQuery.mock.calls[0] as [string, unknown[]];
    // Should have both prefix (for token) and substring (for legacy) params
    const hasPrefix = (params as string[]).some((p) => typeof p === "string" && /03257%$/.test(p));
    const hasSubstring = (params as string[]).some((p) => typeof p === "string" && /^%.*03257.*%$/.test(p));
    expect(hasPrefix).toBe(true);
    expect(hasSubstring).toBe(true);
  });

  it("searches by email when query contains @", async () => {
    mockDbQuery.mockResolvedValueOnce({ rows: [contactRow] });
    const res = await request(app).get(
      "/api/contacts/wizard-search?q=" + encodeURIComponent("jane@example.com"),
    );
    expect(res.status).toBe(200);
    const [sql, params] = mockDbQuery.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain("lower(COALESCE(c.email");
    expect((params as string[]).some((p) => p.includes("jane@example.com"))).toBe(true);
  });

  it("searches by name when query contains letters", async () => {
    mockDbQuery.mockResolvedValueOnce({ rows: [contactRow] });
    const res = await request(app).get("/api/contacts/wizard-search?q=Jane");
    expect(res.status).toBe(200);
    const [sql] = mockDbQuery.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain("ILIKE");
    // Customer mode: no recipient metadata
    expect(res.body.results[0]).not.toHaveProperty("is_saved_recipient");
  });

  it("name search is not affected by phone changes (regression)", async () => {
    mockDbQuery.mockResolvedValueOnce({ rows: [contactRow] });
    const res = await request(app).get("/api/contacts/wizard-search?q=Doe");
    expect(res.status).toBe(200);
    expect(res.body.results[0].id).toBe("c-1");
  });

  it("escapes LIKE wildcards in name queries", async () => {
    mockDbQuery.mockResolvedValueOnce({ rows: [] });
    await request(app).get("/api/contacts/wizard-search?q=" + encodeURIComponent("50%off"));
    const [, params] = mockDbQuery.mock.calls[0] as [string, unknown[]];
    expect((params as string[]).some((p) => typeof p === "string" && p.includes("50\\%off"))).toBe(true);
  });

  it("recipient mode adds saved-recipient metadata and sorting", async () => {
    mockDbQuery.mockResolvedValueOnce({
      rows: [
        {
          ...contactRow,
          is_saved_recipient: true,
          deliveries_count: 2,
          last_delivery_city: "Beirut",
        },
      ],
    });
    const res = await request(app).get(
      "/api/contacts/wizard-search?q=jane&customer_contact_id=cust-9",
    );
    expect(res.status).toBe(200);
    expect(res.body.results[0]).toMatchObject({
      is_saved_recipient: true,
      deliveries_count: 2,
      last_delivery_city: "Beirut",
    });
    const [sql, params] = mockDbQuery.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain("is_saved_recipient DESC");
    expect(params).toContain("cust-9");
  });

  it("clamps the limit parameter to at most 20", async () => {
    mockDbQuery.mockResolvedValueOnce({ rows: [] });
    await request(app).get("/api/contacts/wizard-search?q=jane&limit=500");
    const [, params] = mockDbQuery.mock.calls[0] as [string, unknown[]];
    expect(params[params.length - 1]).toBe(20);
  });

  it("returns no results for unrecognizable short numeric input (< 4 digits)", async () => {
    const res = await request(app).get("/api/contacts/wizard-search?q=03");
    expect(res.status).toBe(200);
    expect(res.body.results).toHaveLength(0);
    expect(mockDbQuery).not.toHaveBeenCalled();
  });

  // ── Lebanese trunk-prefix variants (acceptance criteria) ──────────────────
  it("uses '03257553%' as prefix pattern when searching the full local Lebanese number", async () => {
    mockDbQuery.mockResolvedValueOnce({ rows: [] });
    await request(app).get(
      "/api/contacts/wizard-search?q=" + encodeURIComponent("03257553"),
    );
    const [sql, params] = mockDbQuery.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain("unnest(c.phone_search_tokens)");
    // Prefix pattern must be "03257553%" so the stored token "03257553" matches.
    const hasCorrectPrefix = (params as string[]).some(
      (p) => typeof p === "string" && p === "03257553%",
    );
    expect(hasCorrectPrefix).toBe(true);
  });

  it("uses '9613257553%' as prefix pattern for the bare E.164 digits query", async () => {
    mockDbQuery.mockResolvedValueOnce({ rows: [] });
    await request(app).get(
      "/api/contacts/wizard-search?q=" + encodeURIComponent("9613257553"),
    );
    const [, params] = mockDbQuery.mock.calls[0] as [string, unknown[]];
    const hasCorrectPrefix = (params as string[]).some(
      (p) => typeof p === "string" && p === "9613257553%",
    );
    expect(hasCorrectPrefix).toBe(true);
  });

  it("uses '3257553%' as prefix pattern for the national-significant-number query", async () => {
    mockDbQuery.mockResolvedValueOnce({ rows: [] });
    await request(app).get(
      "/api/contacts/wizard-search?q=" + encodeURIComponent("3257553"),
    );
    const [, params] = mockDbQuery.mock.calls[0] as [string, unknown[]];
    const hasCorrectPrefix = (params as string[]).some(
      (p) => typeof p === "string" && p === "3257553%",
    );
    expect(hasCorrectPrefix).toBe(true);
  });

  it("strips non-digit formatting from the query before building the LIKE pattern", async () => {
    // "+961 3 257 553" → digits "9613257553" → prefix "9613257553%"
    mockDbQuery.mockResolvedValueOnce({ rows: [] });
    await request(app).get(
      "/api/contacts/wizard-search?q=" + encodeURIComponent("+961 3 257 553"),
    );
    const [, params] = mockDbQuery.mock.calls[0] as [string, unknown[]];
    const hasCorrectPrefix = (params as string[]).some(
      (p) => typeof p === "string" && p === "9613257553%",
    );
    expect(hasCorrectPrefix).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// GET /contacts/wizard-duplicate-check
// ---------------------------------------------------------------------------

describe("GET /api/contacts/wizard-duplicate-check", () => {
  it("returns null match when neither phone nor email supplied", async () => {
    const res = await request(app).get("/api/contacts/wizard-duplicate-check");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ match: null, matched_field: null });
    expect(mockDbQuery).not.toHaveBeenCalled();
  });

  it("matches by token array overlap for phone (international format)", async () => {
    mockDbQuery.mockResolvedValueOnce({ rows: [contactRow] });
    const res = await request(app).get(
      "/api/contacts/wizard-duplicate-check?phone=" + encodeURIComponent("+9613257533"),
    );
    expect(res.status).toBe(200);
    expect(res.body.matched_field).toBe("phone");
    expect(res.body.match.id).toBe("c-1");
    const [sql] = mockDbQuery.mock.calls[0] as [string, unknown[]];
    // Token overlap via && operator
    expect(sql).toContain("phone_search_tokens &&");
  });

  it("matches by token array for local-format phone query", async () => {
    mockDbQuery.mockResolvedValueOnce({ rows: [contactRow] });
    const res = await request(app).get(
      "/api/contacts/wizard-duplicate-check?phone=" + encodeURIComponent("03257533"),
    );
    expect(res.status).toBe(200);
    expect(res.body.matched_field).toBe("phone");
    const [sql] = mockDbQuery.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain("phone_search_tokens &&");
    // Also has legacy fallback
    expect(sql).toContain("phone_search_tokens IS NULL");
  });

  it("includes legacy regex fallback in duplicate-check for un-backfilled contacts", async () => {
    mockDbQuery.mockResolvedValueOnce({ rows: [] });
    await request(app).get(
      "/api/contacts/wizard-duplicate-check?phone=" + encodeURIComponent("+9613257533"),
    );
    const [sql] = mockDbQuery.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain("regexp_replace");
    expect(sql).toContain("phone_search_tokens IS NULL");
  });

  it("falls back to case-insensitive email when phone finds nothing", async () => {
    mockDbQuery
      .mockResolvedValueOnce({ rows: [] }) // phone check
      .mockResolvedValueOnce({ rows: [contactRow] }); // email check
    const res = await request(app).get(
      "/api/contacts/wizard-duplicate-check?phone=70123456&email=" +
        encodeURIComponent("Jane@Example.COM"),
    );
    expect(res.status).toBe(200);
    expect(res.body.matched_field).toBe("email");
    const [, emailParams] = mockDbQuery.mock.calls[1] as [string, unknown[]];
    expect(emailParams[1]).toBe("jane@example.com");
  });

  it("returns no match when nothing matches", async () => {
    mockDbQuery.mockResolvedValue({ rows: [] });
    const res = await request(app).get(
      "/api/contacts/wizard-duplicate-check?email=nobody@example.com",
    );
    expect(res.body).toEqual({ match: null, matched_field: null });
  });

  it("does not run phone check when phone digits < 4", async () => {
    // Normalize with only 3 digits → phoneDigits.length < 4 → skip phone check
    mockDbQuery.mockResolvedValue({ rows: [] });
    const res = await request(app).get(
      "/api/contacts/wizard-duplicate-check?phone=123",
    );
    expect(res.body).toEqual({ match: null, matched_field: null });
    // Should not have called phone query (no email either)
    expect(mockDbQuery).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// POST /contacts/wizard-create
// ---------------------------------------------------------------------------

describe("POST /api/contacts/wizard-create", () => {
  it("rejects when neither phone nor email is provided", async () => {
    const res = await request(app)
      .post("/api/contacts/wizard-create")
      .send({ display_name: "Jane" });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/phone number or email/i);
    expect(mockCreateOrResolveContact).not.toHaveBeenCalled();
  });

  it("rejects email-only contact without a name", async () => {
    const res = await request(app)
      .post("/api/contacts/wizard-create")
      .send({ email: "jane@example.com" });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/name or phone/i);
  });

  it("rejects unknown body keys (strict schema)", async () => {
    const res = await request(app)
      .post("/api/contacts/wizard-create")
      .send({ phone: "70123456", evil: true });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("Validation error");
  });

  it("creates a new contact → 201 with existing:false", async () => {
    mockDbQuery.mockResolvedValueOnce({ rows: [contactRow] });
    mockCreateOrResolveContact.mockResolvedValueOnce({
      contactId: "c-1",
      existing: false,
    });

    const res = await request(app)
      .post("/api/contacts/wizard-create")
      .send({ display_name: "Jane Doe", phone: "+961 70 123 456" });

    expect(res.status).toBe(201);
    expect(res.body.existing).toBe(false);
    expect(res.body.contact.id).toBe("c-1");
    expect(mockCreateOrResolveContact).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceOwnerId: "ws-1",
        source: "dashboard_wizard",
        displayName: "Jane Doe",
      }),
    );
  });

  it("returns an existing contact as a normal 200 success", async () => {
    mockDbQuery.mockResolvedValueOnce({ rows: [contactRow] });
    mockCreateOrResolveContact.mockResolvedValueOnce({
      contactId: "c-1",
      existing: true,
    });

    const res = await request(app)
      .post("/api/contacts/wizard-create")
      .send({ display_name: "Jane Doe", phone: "70123456" });

    expect(res.status).toBe(200);
    expect(res.body.existing).toBe(true);
    expect(res.body.contact.id).toBe("c-1");
  });

  it("returns 400 when persistence receives no usable identity", async () => {
    mockCreateOrResolveContact.mockResolvedValueOnce(null);
    const res = await request(app)
      .post("/api/contacts/wizard-create")
      .send({ phone: "70123456" });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("contact_identity_required");
  });

  it("returns a safe retryable error and logs only structured database metadata", async () => {
    mockCreateOrResolveContact.mockRejectedValueOnce(
      Object.assign(new Error("duplicate key contains jane@example.com"), {
        code: "23505",
        constraint: "contacts_workspace_email_unique",
      }),
    );

    const res = await request(app)
      .post("/api/contacts/wizard-create")
      .send({
        display_name: "Jane Secret",
        email: "jane@example.com",
        phone: "+971501234567",
      });

    expect(res.status).toBe(500);
    expect(res.body).toEqual({
      error: "contact_persistence_failed",
      message: "The contact could not be saved. Please retry.",
    });
    expect(mockLogger.error).toHaveBeenCalledWith(
      {
        stage: "create_or_resolve",
        workspaceOwnerId: "ws-1",
        pgCode: "23505",
        constraint: "contacts_workspace_email_unique",
        dbColumn: null,
        errorName: "Error",
      },
      "wizard contact persistence failed",
    );
    expect(JSON.stringify(mockLogger.error.mock.calls)).not.toContain("Jane Secret");
    expect(JSON.stringify(mockLogger.error.mock.calls)).not.toContain("jane@example.com");
    expect(JSON.stringify(mockLogger.error.mock.calls)).not.toContain("+971501234567");
  });
});

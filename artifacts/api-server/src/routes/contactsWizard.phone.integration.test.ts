/**
 * Integration tests: phone search end-to-end against a real PostgreSQL database.
 *
 * Exercises the unnest-LIKE token query and the legacy regexp_replace fallback
 * with real contacts rows — unit mocks cannot catch SQL syntax errors or
 * token-vs-query mismatches that only surface with actual data.
 *
 * Skips automatically when DATABASE_URL is not set.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import pg from "pg";
import { buildPhoneSearchTokens, escapeLike } from "../lib/contactSearchNormalize";

const { Pool } = pg;
const DATABASE_URL = process.env.DATABASE_URL;

const WS = `__wizard_phone_search_test_${Date.now()}`;

// ---------------------------------------------------------------------------
// Helpers mirroring the wizard-search SQL
// ---------------------------------------------------------------------------

/**
 * Build the `phone_search_tokens` literal for PostgreSQL from a phone string.
 * Mirrors what upsertContact does at runtime.
 */
function tokensLiteral(phone: string): string {
  const tokens = buildPhoneSearchTokens(phone);
  return `{${tokens.map((t) => `"${t.replace(/"/g, '\\"')}"`).join(",")}}`;
}

/**
 * Execute the actual wizard-search SQL against the test pool and return the
 * matching rows.  Mirrors contactsWizard.ts GET /contacts/wizard-search.
 */
async function runWizardSearch(
  pool: InstanceType<typeof Pool>,
  queryDigits: string,
): Promise<{ id: string; phone: string | null }[]> {
  const likePattern = `${escapeLike(queryDigits)}%`;
  const legacyLike = `%${escapeLike(queryDigits)}%`;

  const r = await pool.query<{ id: string; phone: string | null }>(
    `SELECT c.id, c.phone
       FROM contacts c
      WHERE c.workspace_owner_id = $1
        AND c.archived_at IS NULL
        AND (
          EXISTS (SELECT 1 FROM unnest(c.phone_search_tokens) AS _t WHERE _t LIKE $2 ESCAPE '\\')
          OR (c.phone_search_tokens IS NULL
              AND regexp_replace(COALESCE(c.phone, ''), '[^0-9]', '', 'g') LIKE $3 ESCAPE '\\')
        )
      ORDER BY c.created_at ASC`,
    [WS, likePattern, legacyLike],
  );
  return r.rows;
}

/**
 * Execute the wizard duplicate-check SQL.
 * Mirrors contactsWizard.ts GET /contacts/wizard-duplicate-check.
 */
async function runDuplicateCheck(
  pool: InstanceType<typeof Pool>,
  phone: string,
): Promise<{ id: string; phone: string | null } | null> {
  const tokens = buildPhoneSearchTokens(phone);
  const tokenLiteral = `{${tokens.map((t) => `"${t.replace(/"/g, '\\"')}"`).join(",")}}`;
  const digits = phone.replace(/[^0-9]/g, "");

  const r = await pool.query<{ id: string; phone: string | null }>(
    `SELECT c.id, c.phone
       FROM contacts c
      WHERE c.workspace_owner_id = $1
        AND c.archived_at IS NULL
        AND (
          (c.phone_search_tokens IS NOT NULL
           AND c.phone_search_tokens && $2::text[])
          OR
          (c.phone_search_tokens IS NULL
           AND regexp_replace(COALESCE(c.phone, ''), '[^0-9]', '', 'g') = $3)
        )
      ORDER BY c.created_at ASC LIMIT 1`,
    [WS, tokenLiteral, digits],
  );
  return r.rows[0] ?? null;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe.skipIf(!DATABASE_URL)(
  "contactsWizard phone search — real DB (integration)",
  () => {
    let pool: InstanceType<typeof Pool>;

    beforeAll(async () => {
      pool = new Pool({ connectionString: DATABASE_URL });
    });

    afterAll(async () => {
      if (!pool) return;
      await pool.query(`DELETE FROM contacts WHERE workspace_owner_id = $1`, [WS]);
      await pool.end();
    });

    beforeEach(async () => {
      await pool.query(`DELETE FROM contacts WHERE workspace_owner_id = $1`, [WS]);
    });

    // ── Lebanese numbers ─────────────────────────────────────────────────────

    it("finds a Lebanese E.164 contact by a 5-digit local prefix", async () => {
      // Insert a contact with phone_search_tokens already populated (simulating
      // the runtime upsert path that calls buildPhoneSearchTokens).
      await pool.query(
        `INSERT INTO contacts (workspace_owner_id, display_name, phone, phone_search_tokens)
         VALUES ($1, 'Ahmad Khalil', $2, $3::text[])`,
        [WS, "+9613257533", tokensLiteral("+9613257533")],
      );

      // Query "03257" → should match via unnest-LIKE on token "03257533"
      const rows = await runWizardSearch(pool, "03257");
      expect(rows).toHaveLength(1);
      expect(rows[0].phone).toBe("+9613257533");
    });

    it("finds a Lebanese number by the national significant number (no trunk 0)", async () => {
      await pool.query(
        `INSERT INTO contacts (workspace_owner_id, display_name, phone, phone_search_tokens)
         VALUES ($1, 'Lara Noun', $2, $3::text[])`,
        [WS, "+9613257533", tokensLiteral("+9613257533")],
      );

      // Query the national significant number directly
      const rows = await runWizardSearch(pool, "3257533");
      expect(rows).toHaveLength(1);
      expect(rows[0].phone).toBe("+9613257533");
    });

    it("finds a Lebanese number by the full E.164 digit string", async () => {
      await pool.query(
        `INSERT INTO contacts (workspace_owner_id, display_name, phone, phone_search_tokens)
         VALUES ($1, 'Tony Abi', $2, $3::text[])`,
        [WS, "+9613257533", tokensLiteral("+9613257533")],
      );

      const rows = await runWizardSearch(pool, "9613257533");
      expect(rows).toHaveLength(1);
      expect(rows[0].phone).toBe("+9613257533");
    });

    // ── UAE numbers ──────────────────────────────────────────────────────────

    it("finds a UAE E.164 contact by 9-digit domestic prefix", async () => {
      await pool.query(
        `INSERT INTO contacts (workspace_owner_id, display_name, phone, phone_search_tokens)
         VALUES ($1, 'Fatima Al-Amiri', $2, $3::text[])`,
        [WS, "+971501234567", tokensLiteral("+971501234567")],
      );

      // Query "050123456" → should match via token "0501234567"
      const rows = await runWizardSearch(pool, "050123456");
      expect(rows).toHaveLength(1);
      expect(rows[0].phone).toBe("+971501234567");
    });

    it("finds a UAE number by the national significant number (no trunk 0)", async () => {
      await pool.query(
        `INSERT INTO contacts (workspace_owner_id, display_name, phone, phone_search_tokens)
         VALUES ($1, 'Mohammed Al-Rashid', $2, $3::text[])`,
        [WS, "+971501234567", tokensLiteral("+971501234567")],
      );

      const rows = await runWizardSearch(pool, "501234567");
      expect(rows).toHaveLength(1);
      expect(rows[0].phone).toBe("+971501234567");
    });

    it("finds a UAE number by the full E.164 digit string", async () => {
      await pool.query(
        `INSERT INTO contacts (workspace_owner_id, display_name, phone, phone_search_tokens)
         VALUES ($1, 'Sara Youssef', $2, $3::text[])`,
        [WS, "+971501234567", tokensLiteral("+971501234567")],
      );

      const rows = await runWizardSearch(pool, "971501234567");
      expect(rows).toHaveLength(1);
      expect(rows[0].phone).toBe("+971501234567");
    });

    // ── Formatting variants ──────────────────────────────────────────────────

    it("tokens for +961 03-257 533 (formatted) match the same as +9613257533", async () => {
      // The stored phone has a friendly format; buildPhoneSearchTokens should
      // normalize it to the same token set as the E.164 form.
      await pool.query(
        `INSERT INTO contacts (workspace_owner_id, display_name, phone, phone_search_tokens)
         VALUES ($1, 'Rima Haddad', $2, $3::text[])`,
        [WS, "+961 03-257 533", tokensLiteral("+961 03-257 533")],
      );

      // Should still be found by the local-format prefix
      const rows = await runWizardSearch(pool, "03257");
      expect(rows).toHaveLength(1);
      expect(rows[0].phone).toBe("+961 03-257 533");
    });

    it("tokens for +961 (03) 257-533 (bracket format) resolve correctly", async () => {
      await pool.query(
        `INSERT INTO contacts (workspace_owner_id, display_name, phone, phone_search_tokens)
         VALUES ($1, 'Karim Saab', $2, $3::text[])`,
        [WS, "+961 (03) 257-533", tokensLiteral("+961 (03) 257-533")],
      );

      const rows = await runWizardSearch(pool, "03257");
      expect(rows).toHaveLength(1);
    });

    // ── Legacy fallback (phone_search_tokens IS NULL) ────────────────────────
    //
    // The legacy branch does: regexp_replace(phone, '[^0-9]', '', 'g') LIKE '%digits%'
    // so it performs a substring search on the RAW stripped digits.
    // "+9613257533" stripped = "9613257533", which DOES contain "3257533"
    // but does NOT contain "03257" (the "0" domestic prefix is not present).
    // Queries must therefore be substrings of the stored stripped digits.

    it("finds a contact via the legacy regexp_replace fallback when tokens column is NULL", async () => {
      // Simulate a pre-backfill contact: phone set but phone_search_tokens is NULL.
      await pool.query(
        `INSERT INTO contacts (workspace_owner_id, display_name, phone, phone_search_tokens)
         VALUES ($1, 'Legacy User', $2, NULL)`,
        [WS, "+9613257533"],
      );

      // Query the national significant number — it IS a substring of the
      // stripped E.164 digits "9613257533".
      const rows = await runWizardSearch(pool, "3257533");
      expect(rows).toHaveLength(1);
      expect(rows[0].phone).toBe("+9613257533");
    });

    it("legacy fallback also works for a UAE un-backfilled contact", async () => {
      await pool.query(
        `INSERT INTO contacts (workspace_owner_id, display_name, phone, phone_search_tokens)
         VALUES ($1, 'Legacy UAE', $2, NULL)`,
        [WS, "+971501234567"],
      );

      // "501234567" IS a substring of stripped "971501234567"
      const rows = await runWizardSearch(pool, "501234567");
      expect(rows).toHaveLength(1);
      expect(rows[0].phone).toBe("+971501234567");
    });

    it("legacy fallback does NOT find a contact by local-format prefix (0-prefix limitation)", async () => {
      // This documents the known limitation: "03257" is NOT a substring of
      // "9613257533" (the stripped E.164 digits have no trunk "0"), so the
      // legacy fallback cannot do the cross-format matching that tokens enable.
      await pool.query(
        `INSERT INTO contacts (workspace_owner_id, display_name, phone, phone_search_tokens)
         VALUES ($1, 'Legacy Unmatched', $2, NULL)`,
        [WS, "+9613257533"],
      );

      // Legacy path only: "03257" not a substring of "9613257533" → no match
      const rows = await runWizardSearch(pool, "03257");
      expect(rows).toHaveLength(0);
    });

    // ── Both paths simultaneously ────────────────────────────────────────────

    it("returns backfilled and legacy contacts in the same query", async () => {
      await pool.query(
        `INSERT INTO contacts (workspace_owner_id, display_name, phone, phone_search_tokens)
         VALUES
           ($1, 'Backfilled', '+9613257533', $2::text[]),
           ($1, 'Legacy',     '+9613257539', NULL)`,
        [WS, tokensLiteral("+9613257533")],
      );

      // "325753" works for both paths:
      //   Token path: "+9613257533" has token "3257533" which starts with "325753" → prefix match
      //   Legacy path: "+9613257539" stripped = "9613257539" which contains "325753" → substring match
      const rows = await runWizardSearch(pool, "325753");
      expect(rows).toHaveLength(2);
    });

    // ── Duplicate-check (exact token overlap) ────────────────────────────────

    it("duplicate-check finds a Lebanese contact by E.164 input", async () => {
      await pool.query(
        `INSERT INTO contacts (workspace_owner_id, display_name, phone, phone_search_tokens)
         VALUES ($1, 'Dupe Check', $2, $3::text[])`,
        [WS, "+9613257533", tokensLiteral("+9613257533")],
      );

      const match = await runDuplicateCheck(pool, "+9613257533");
      expect(match).not.toBeNull();
      expect(match!.phone).toBe("+9613257533");
    });

    it("duplicate-check finds a Lebanese contact by local-format input", async () => {
      await pool.query(
        `INSERT INTO contacts (workspace_owner_id, display_name, phone, phone_search_tokens)
         VALUES ($1, 'Local Dupe', $2, $3::text[])`,
        [WS, "+9613257533", tokensLiteral("+9613257533")],
      );

      // "03257533" → buildPhoneSearchTokens → includes "9613257533", "3257533",
      // "03257533" — overlaps with stored tokens
      const match = await runDuplicateCheck(pool, "03257533");
      expect(match).not.toBeNull();
      expect(match!.phone).toBe("+9613257533");
    });

    it("duplicate-check finds a UAE contact by local input", async () => {
      await pool.query(
        `INSERT INTO contacts (workspace_owner_id, display_name, phone, phone_search_tokens)
         VALUES ($1, 'UAE Dupe', $2, $3::text[])`,
        [WS, "+971501234567", tokensLiteral("+971501234567")],
      );

      const match = await runDuplicateCheck(pool, "0501234567");
      expect(match).not.toBeNull();
      expect(match!.phone).toBe("+971501234567");
    });

    it("duplicate-check returns null for a non-existent phone", async () => {
      const match = await runDuplicateCheck(pool, "+9613257533");
      expect(match).toBeNull();
    });

    it("duplicate-check uses legacy fallback when tokens is NULL", async () => {
      await pool.query(
        `INSERT INTO contacts (workspace_owner_id, display_name, phone, phone_search_tokens)
         VALUES ($1, 'Legacy Dupe', $2, NULL)`,
        [WS, "+9613257533"],
      );

      // The legacy path uses regexp_replace(phone) = digits
      const match = await runDuplicateCheck(pool, "+9613257533");
      expect(match).not.toBeNull();
      expect(match!.phone).toBe("+9613257533");
    });

    // ── Workspace isolation ──────────────────────────────────────────────────

    it("does not return contacts from another workspace", async () => {
      const otherWs = `${WS}_other`;
      try {
        await pool.query(
          `INSERT INTO contacts (workspace_owner_id, display_name, phone, phone_search_tokens)
           VALUES ($1, 'Other WS', $2, $3::text[])`,
          [otherWs, "+9613257533", tokensLiteral("+9613257533")],
        );

        const rows = await runWizardSearch(pool, "03257533");
        expect(rows).toHaveLength(0);
      } finally {
        await pool.query(`DELETE FROM contacts WHERE workspace_owner_id = $1`, [otherWs]);
      }
    });
  },
);

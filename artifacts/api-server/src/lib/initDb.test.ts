import { describe, it, expect, vi, beforeAll } from "vitest";

// ---------------------------------------------------------------------------
// Mocks — declared before importing the module under test
// ---------------------------------------------------------------------------

const mockDbQuery = vi.fn();
const mockLoggerInfo = vi.fn();

vi.mock("./db", () => ({
  db: {
    query: (...args: unknown[]) => mockDbQuery(...args),
    // The manual-order-number backfill runs in its own transaction on a
    // dedicated client; delegate to the same query mock.
    connect: () =>
      Promise.resolve({
        query: (...args: unknown[]) => mockDbQuery(...args),
        release: () => {},
      }),
  },
}));

vi.mock("./logger", () => ({
  logger: {
    info: (...args: unknown[]) => mockLoggerInfo(...args),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

import { initDb } from "./initDb";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Returns a mock implementation for db.query that answers pg_indexes EXISTS
 * checks with the given `exists` boolean and returns safe empty results for
 * all other queries (CREATE TABLE, ALTER TABLE, DELETE, UPDATE, INSERT…).
 */
function buildQueryMock(exists: boolean) {
  return (sql: unknown) => {
    const s = typeof sql === "string" ? sql : "";
    if (
      s.includes("FROM pg_attribute") &&
      s.includes("'public.merchant_offer_states'::regclass")
    ) {
      return Promise.resolve({
        rows: [
          "workspace_owner_id",
          "product_id",
          "country",
          "content_language",
          "account_id",
          "data_source_id",
          "offer_id",
        ].map((attname) => ({ attname, attnotnull: true })),
        rowCount: 7,
      });
    }
    if (
      s.includes("FROM pg_constraint c") &&
      s.includes("'public.merchant_offer_states'::regclass") &&
      s.includes("c.contype = 'p'")
    ) {
      return Promise.resolve({
        rows: [{
          constraint_name: "merchant_offer_states_pkey",
          constraint_type: "p",
          columns: [
            "workspace_owner_id",
            "product_id",
            "country",
            "content_language",
            "account_id",
            "data_source_id",
            "offer_id",
          ],
        }],
        rowCount: 1,
      });
    }
    if (s.includes("pg_indexes")) {
      return Promise.resolve({ rows: [{ exists }], rowCount: 1 });
    }
    if (s.includes("information_schema.tables")) {
      return Promise.resolve({ rows: [{ exists }], rowCount: 1 });
    }
    return Promise.resolve({ rows: [], rowCount: 0 });
  };
}

// ---------------------------------------------------------------------------
// Tests: "already present" branch
// ---------------------------------------------------------------------------

describe('initDb index pre-check — "already present" branch', () => {
  beforeAll(async () => {
    vi.clearAllMocks();
    mockDbQuery.mockImplementation(buildQueryMock(true));
    await initDb();
  });

  it('logs "already present" for idx_devices_user when the index pre-exists', () => {
    expect(mockLoggerInfo).toHaveBeenCalledWith(
      "idx_devices_user: already present in pg_indexes — no action needed",
    );
  });

  it('logs "already present" for idx_pj_user when the index pre-exists', () => {
    expect(mockLoggerInfo).toHaveBeenCalledWith(
      "idx_pj_user: already present in pg_indexes — no action needed",
    );
  });

  it('logs "already present" for idx_wm_unique_member when the index pre-exists', () => {
    expect(mockLoggerInfo).toHaveBeenCalledWith(
      "idx_wm_unique_member: already present in pg_indexes — no action needed",
    );
  });

  it('logs "already present" for idx_wm_owner when the index pre-exists', () => {
    expect(mockLoggerInfo).toHaveBeenCalledWith(
      "idx_wm_owner: already present in pg_indexes — no action needed",
    );
  });

  it('logs "already present" for idx_api_keys_user when the index pre-exists', () => {
    expect(mockLoggerInfo).toHaveBeenCalledWith(
      "idx_api_keys_user: already present in pg_indexes — no action needed",
    );
  });

  it('logs "already present" for idx_api_keys_hash when the index pre-exists', () => {
    expect(mockLoggerInfo).toHaveBeenCalledWith(
      "idx_api_keys_hash: already present in pg_indexes — no action needed",
    );
  });

  it("reconciles active florist assignments whose parent orders are completed", () => {
    const call = mockDbQuery.mock.calls.find(
      ([sql]) =>
        typeof sql === "string" &&
        sql.includes("UPDATE order_florist_assignments AS assignment") &&
        sql.includes("order_row.status = 'completed'"),
    );
    expect(call).toBeDefined();
    expect(call?.[0]).toContain(
      "order_row.workspace_owner_id = assignment.workspace_owner_id",
    );
    expect(call?.[0]).toContain(
      "completed_at = COALESCE(assignment.completed_at, now())",
    );
    expect(call?.[0]).toContain("assignment.status <> 'completed'");
  });

  it("makes Recipe suggestion actions append-only", () => {
    const sql = mockDbQuery.mock.calls
      .map(([query]) => (typeof query === "string" ? query : ""))
      .find((query) => query.includes("recipe_suggestion_actions_immutable"));

    expect(sql).toContain("BEFORE UPDATE OR DELETE ON recipe_suggestion_actions");
    expect(sql).toContain("recipe_suggestion_actions is append-only");
  });

  it("makes Recipe rule evidence append-only", () => {
    const sql = mockDbQuery.mock.calls
      .map(([query]) => (typeof query === "string" ? query : ""))
      .find((query) => query.includes("recipe_rule_evidence_immutable"));

    expect(sql).toContain("BEFORE UPDATE OR DELETE ON recipe_rule_evidence");
    expect(sql).toContain("recipe_rule_evidence is append-only");
  });

  it('logs "already present" for idx_pj_pending_device when the index pre-exists', () => {
    expect(mockLoggerInfo).toHaveBeenCalledWith(
      "idx_pj_pending_device: already present in pg_indexes — no action needed",
    );
  });

  it('never logs "was missing" for any index when all indexes pre-exist', () => {
    const wasMissingCalls = mockLoggerInfo.mock.calls.filter(([msg]) =>
      typeof msg === "string" && msg.includes("was missing"),
    );
    expect(wasMissingCalls).toHaveLength(0);
  });

  it("repairs the global LBP pair idempotently without replacing a canonical manual override", () => {
    const repairSql = mockDbQuery.mock.calls
      .map(([query]) => (typeof query === "string" ? query : ""))
      .find(
        (query) =>
          query.includes("DECLARE") &&
          query.includes("chosen_rate numeric") &&
          query.includes("base_currency = 'LBP'") &&
          query.includes("target_currency = 'USD'"),
      );

    expect(repairSql).toBeDefined();
    expect(repairSql).toContain("WHEN provider = 'manual' THEN LEAST(rate, 1.0 / rate)");
    expect(repairSql).toContain("(provider = 'manual') DESC");
    expect(repairSql).toContain("GREATEST(rate, 1.0 / rate) BETWEEN 10000 AND 1000000");
    expect(repairSql).toContain("DELETE FROM exchange_rates");
    expect(repairSql).toContain("VALUES ('__global__', 'USD', 'LBP', 1.0 / 89500, 'manual', now())");
    expect(repairSql).toContain("IF chosen_rate IS NOT NULL");
  });
});

describe("initDb CMC page-permission upgrade", () => {
  beforeAll(async () => {
    vi.clearAllMocks();
    mockDbQuery.mockImplementation(buildQueryMock(true));
    await initDb();
  });

  it("backfills both split page keys only for legacy CMC roles", () => {
    const sql = mockDbQuery.mock.calls
      .map(([query]) => (typeof query === "string" ? query : ""))
      .find((query) => query.includes("cmc-pos-dashboard") && query.includes("cmc-pos-new-order"));

    expect(sql).toBeDefined();
    expect(sql).toContain("UPDATE workspace_roles");
    expect(sql).toContain("existing.page = 'cmc-pos'");
    expect(sql).toContain("existing.page LIKE 'cmc_pos.%'");
  });

  it("is idempotent and does not duplicate either new key", () => {
    const sql = mockDbQuery.mock.calls
      .map(([query]) => (typeof query === "string" ? query : ""))
      .find((query) => query.includes("cmc-pos-dashboard") && query.includes("cmc-pos-new-order"));

    expect(sql).toContain("INSERT INTO init_db_data_migrations");
    expect(sql).toContain("cmc-pos-page-permissions-v1");
    expect(sql).toContain("ON CONFLICT (key) DO NOTHING");
    expect(sql).toContain("WHERE EXISTS (SELECT 1 FROM claimed)");
    expect(sql).toContain("GROUP BY page");
  });
});

describe("initDb discontinued Lebanon Merchant products migration", () => {
  beforeAll(async () => {
    vi.clearAllMocks();
    mockDbQuery.mockImplementation(buildQueryMock(true));
    await initDb();
  });

  function migrationSql() {
    return mockDbQuery.mock.calls
      .map(([query]) => (typeof query === "string" ? query : ""))
      .find((query) =>
        query.includes("merchant-retirement:") === false
        && query.includes("SET merchant_sync_disabled = TRUE")
        && query.includes("913, 465, 914"));
  }

  it("only sets the Merchant exclusion flag for the 37 approved product IDs", () => {
    const sql = migrationSql();
    expect(sql).toBeDefined();
    expect(sql).toContain("UPDATE products");
    expect(sql).toContain("SET merchant_sync_disabled = TRUE");
    expect(sql).toContain(
      "workspace_owner_id = 'user_3DCcbYtdoRYrTOqHwKxb1gwXxJR'",
    );
    expect(sql).toContain("merchant_sync_disabled IS NOT TRUE");
    expect(sql).toContain("RETURNING id");

    const arrayMatch = sql?.match(/ARRAY\[([\s\S]*?)\]::int\[\]/);
    expect(arrayMatch).toBeTruthy();
    const ids = arrayMatch?.[1]
      .split(",")
      .map((value) => Number(value.trim()))
      .filter(Number.isInteger);
    expect(ids).toEqual([
      913, 465, 914, 1041, 1068, 1067, 443, 410, 407, 881,
      503, 879, 467, 1026, 441, 1036, 1040, 1042, 452, 1065,
      1039, 515, 1082, 493, 1038, 1066, 1027, 1069, 344, 521,
      563, 389, 446, 877, 1037, 401, 486,
    ]);
    expect(new Set(ids).size).toBe(37);
  });

  it("is safely repeatable without writing to any migration bookkeeping table", () => {
    const sql = migrationSql();
    expect(sql).toContain("merchant_sync_disabled IS NOT TRUE");
    expect(sql).not.toContain("init_db_data_migrations");
    expect(sql).not.toContain("UPDATE workspace_roles");
  });

  it("runs only after the products table and Merchant exclusion column are ready", () => {
    const sqlCalls = mockDbQuery.mock.calls
      .map(([query]) => (typeof query === "string" ? query : ""));
    const productsTableIndex = sqlCalls.findIndex((sql) =>
      sql.includes("CREATE TABLE IF NOT EXISTS products"));
    const merchantColumnIndex = sqlCalls.findIndex((sql) =>
      sql.includes(
        "ALTER TABLE products ADD COLUMN IF NOT EXISTS merchant_sync_disabled",
      ));
    const migrationIndex = sqlCalls.findIndex((sql) =>
      sql.includes("SET merchant_sync_disabled = TRUE")
      && sql.includes("913, 465, 914"));

    expect(productsTableIndex).toBeGreaterThanOrEqual(0);
    expect(merchantColumnIndex).toBeGreaterThan(productsTableIndex);
    expect(migrationIndex).toBeGreaterThan(merchantColumnIndex);
  });
});

describe("initDb invoice scanners page-permission upgrade", () => {
  beforeAll(async () => {
    vi.clearAllMocks();
    mockDbQuery.mockImplementation(buildQueryMock(true));
    await initDb();
  });

  function migrationSql() {
    return mockDbQuery.mock.calls
      .map(([query]) => (typeof query === "string" ? query : ""))
      .find((query) => query.includes("invoice-scanners-page-permission-v1"));
  }

  it("backfills invoice scanner access only from the legacy Devices grant", () => {
    const sql = migrationSql();
    expect(sql).toBeDefined();
    expect(sql).toContain("UPDATE workspace_roles");
    expect(sql).toContain("existing.page = 'devices'");
    expect(sql).toContain("'invoice-scanners'");
  });

  it("claims the migration once and deduplicates the new key", () => {
    const sql = migrationSql();
    expect(sql).toContain("INSERT INTO init_db_data_migrations");
    expect(sql).toContain("ON CONFLICT (key) DO NOTHING");
    expect(sql).toContain("WHERE EXISTS (SELECT 1 FROM claimed)");
    expect(sql).toContain("GROUP BY page");
  });
});

describe("initDb canonical supplier-pricing UOM migration", () => {
  beforeAll(async () => {
    vi.clearAllMocks();
    mockDbQuery.mockImplementation(buildQueryMock(true));
    await initDb();
  });

  function sqlCalls() {
    return mockDbQuery.mock.calls.map(([sql]) => (typeof sql === "string" ? sql : ""));
  }

  it("seeds all approved stable codes without overwriting catalog edits", () => {
    const seed = sqlCalls().find((sql) => sql.includes("INSERT INTO uom_catalog"));
    expect(seed).toBeDefined();
    for (const code of [
      "piece", "stem", "bunch", "pack", "box", "kg", "g",
      "liter", "ml", "meter", "cm", "set", "pair", "dozen",
    ]) {
      expect(seed).toContain(`'${code}'`);
    }
    expect(seed).toContain("ON CONFLICT (code) DO NOTHING");
  });

  it("seeds the required aliases and supplier-pricing availability idempotently", () => {
    const aliases = sqlCalls().find((sql) => sql.includes("INSERT INTO uom_aliases"));
    expect(aliases).toContain("('piece', 'pcs', 'pcs')");
    expect(aliases).toContain("('kg', 'kilograms', 'kilograms')");
    expect(aliases).toContain("ON CONFLICT (normalized_alias) DO NOTHING");

    const availability = sqlCalls().find((sql) => sql.includes("INSERT INTO uom_context_availability"));
    expect(availability).toContain("'supplier_pricing'");
    expect(availability).toContain("ON CONFLICT (context, uom_code) DO NOTHING");
  });

  it("backfills only missing, unambiguous canonical codes and leaves legacy text untouched", () => {
    const backfill = sqlCalls().find(
      (sql) => sql.includes("UPDATE base_item_suppliers bis") && sql.includes("resolved.uom_code"),
    );
    expect(backfill).toContain("bis2.pricing_uom_code IS NULL");
    expect(backfill).toContain("COUNT(DISTINCT ua.uom_code) = 1");
    expect(backfill).toContain("regexp_replace");
    expect(backfill).not.toMatch(/SET\s+pricing_uom\s*=/);
  });

  it("reports mapped and unmapped migration counts", () => {
    expect(mockLoggerInfo).toHaveBeenCalledWith(
      expect.objectContaining({
        mapped: expect.any(Number),
        unmapped: expect.any(Number),
        mappedByWorkspace: expect.any(Object),
        unmappedByWorkspace: expect.any(Object),
        distinctLegacyValues: expect.any(Number),
        outcomes: expect.any(Array),
        outcomesTruncated: expect.any(Boolean),
      }),
      "supplier-pricing UOM backfill complete",
    );
  });
});

// ---------------------------------------------------------------------------
// Tests: "was missing — created" branch
// ---------------------------------------------------------------------------

describe('initDb index pre-check — "was missing — created" branch', () => {
  beforeAll(async () => {
    vi.clearAllMocks();
    mockDbQuery.mockImplementation(buildQueryMock(false));
    await initDb();
  });

  it('logs "was missing — created" for idx_devices_user on first-time creation', () => {
    expect(mockLoggerInfo).toHaveBeenCalledWith(
      "idx_devices_user: was missing — created successfully (deployment migrated)",
    );
  });

  it('logs "was missing — created" for idx_pj_user on first-time creation', () => {
    expect(mockLoggerInfo).toHaveBeenCalledWith(
      "idx_pj_user: was missing — created successfully (deployment migrated)",
    );
  });

  it('logs "was missing — created" for idx_wm_unique_member on first-time creation', () => {
    expect(mockLoggerInfo).toHaveBeenCalledWith(
      "idx_wm_unique_member: was missing — created successfully (deployment migrated)",
    );
  });

  it('logs "was missing — created" for idx_wm_owner on first-time creation', () => {
    expect(mockLoggerInfo).toHaveBeenCalledWith(
      "idx_wm_owner: was missing — created successfully (deployment migrated)",
    );
  });

  it('logs "was missing — created" for idx_api_keys_user on first-time creation', () => {
    expect(mockLoggerInfo).toHaveBeenCalledWith(
      "idx_api_keys_user: was missing — created successfully (deployment migrated)",
    );
  });

  it('logs "was missing — created" for idx_api_keys_hash on first-time creation', () => {
    expect(mockLoggerInfo).toHaveBeenCalledWith(
      "idx_api_keys_hash: was missing — created successfully (deployment migrated)",
    );
  });

  it('logs "was missing — created" for idx_pj_pending_device on first-time creation', () => {
    expect(mockLoggerInfo).toHaveBeenCalledWith(
      "idx_pj_pending_device: was missing — created successfully (deployment migrated)",
    );
  });

  it('never logs "already present" for any index when no indexes pre-exist', () => {
    const alreadyPresentCalls = mockLoggerInfo.mock.calls.filter(([msg]) =>
      typeof msg === "string" && msg.includes("already present in pg_indexes"),
    );
    expect(alreadyPresentCalls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Tests: pg_indexes query SQL correctness
// ---------------------------------------------------------------------------

describe("initDb index pre-check — pg_indexes query correctness", () => {
  beforeAll(async () => {
    vi.clearAllMocks();
    mockDbQuery.mockImplementation(buildQueryMock(false));
    await initDb();
  });

  it("issues a pg_indexes EXISTS check that names idx_devices_user on the devices table", () => {
    const call = mockDbQuery.mock.calls.find(
      ([sql]) =>
        typeof sql === "string" &&
        sql.includes("pg_indexes") &&
        sql.includes("idx_devices_user") &&
        sql.includes("'devices'"),
    );
    expect(call).toBeDefined();
  });

  it("issues a pg_indexes EXISTS check that names idx_pj_user on the print_jobs table", () => {
    const call = mockDbQuery.mock.calls.find(
      ([sql]) =>
        typeof sql === "string" &&
        sql.includes("pg_indexes") &&
        sql.includes("idx_pj_user") &&
        sql.includes("'print_jobs'"),
    );
    expect(call).toBeDefined();
  });

  it("issues a pg_indexes EXISTS check that names idx_wm_unique_member on the workspace_members table", () => {
    const call = mockDbQuery.mock.calls.find(
      ([sql]) =>
        typeof sql === "string" &&
        sql.includes("pg_indexes") &&
        sql.includes("idx_wm_unique_member") &&
        sql.includes("'workspace_members'"),
    );
    expect(call).toBeDefined();
  });

  it("issues a pg_indexes EXISTS check that names idx_api_keys_hash on the api_keys table", () => {
    const call = mockDbQuery.mock.calls.find(
      ([sql]) =>
        typeof sql === "string" &&
        sql.includes("pg_indexes") &&
        sql.includes("idx_api_keys_hash") &&
        sql.includes("'api_keys'"),
    );
    expect(call).toBeDefined();
  });

  it("all SELECT EXISTS pg_indexes queries filter by schemaname = 'public'", () => {
    const selectExistsChecks = mockDbQuery.mock.calls.filter(
      ([sql]) =>
        typeof sql === "string" &&
        sql.includes("pg_indexes") &&
        sql.trimStart().toUpperCase().startsWith("SELECT"),
    );
    expect(selectExistsChecks.length).toBeGreaterThan(0);
    for (const [sql] of selectExistsChecks) {
      expect(sql).toContain("schemaname");
      expect(sql).toContain("'public'");
    }
  });
});

// ---------------------------------------------------------------------------
// Tests: UAE delivery cities seed idempotency (Task #83)
// ---------------------------------------------------------------------------

describe("initDb UAE delivery cities seed", () => {
  // Call initDb() once in beforeAll. The "is repeatable" test calls it a
  // second time, so tests that need a single-call baseline must run before it.
  beforeAll(async () => {
    vi.clearAllMocks();
    mockDbQuery.mockImplementation(buildQueryMock(true));
    await initDb();
  });

  function findUaeSeedCalls() {
    return mockDbQuery.mock.calls
      .map(([sql]) => (typeof sql === "string" ? sql : ""))
      .filter(
        (sql) =>
          sql.includes("INSERT INTO delivery_cities") &&
          sql.includes("'United Arab Emirates'"),
      );
  }

  it("issues exactly one UAE seed INSERT per initDb invocation", () => {
    expect(findUaeSeedCalls()).toHaveLength(1);
  });

  it("only targets workspaces that have UAE in their available_countries", () => {
    const [sql] = findUaeSeedCalls();
    expect(sql).toBeDefined();
    expect(sql).toContain("FROM workspace_settings");
    expect(sql).toContain("'United Arab Emirates' = ANY(available_countries)");
  });

  it("seeds the 8 emirates with stable slugs and sort orders", () => {
    const [sql] = findUaeSeedCalls();
    expect(sql).toBeDefined();
    const expected: Array<[string, string, number]> = [
      ["Dubai", "dubai", 1],
      ["Abu Dhabi", "abu-dhabi", 2],
      ["Sharjah", "sharjah", 3],
      ["Ajman", "ajman", 4],
      ["Ras Al Khaimah", "ras-al-khaimah", 5],
      ["Fujairah", "fujairah", 6],
      ["Umm Al Quwain", "umm-al-quwain", 7],
      ["Al Ain", "al-ain", 8],
    ];
    for (const [name, slug, order] of expected) {
      expect(sql).toContain(`'${name}'`);
      expect(sql).toContain(`'${slug}'`);
      expect(sql).toContain(`${order}`);
    }
    expect(sql).toMatch(/'AE'/);
    expect(sql).toMatch(/, true\b/);
  });

  it("seeds delivery_country_settings for the Presentail workspace with LB, AE, CY active", () => {
    const inserts = mockDbQuery.mock.calls
      .map(([sql]) => (typeof sql === "string" ? sql : ""))
      .filter((sql) => sql.includes("INSERT INTO delivery_country_settings"));
    expect(inserts).toHaveLength(1);
    const [sql] = inserts;
    expect(sql).toContain("'user_3DCcbYtdoRYrTOqHwKxb1gwXxJR'");
    expect(sql).toContain("'LB'");
    expect(sql).toContain("'AE'");
    expect(sql).toContain("'CY'");
    expect(sql).toMatch(/delivery_active\s*=\s*true/);
    expect(sql).toMatch(/ON CONFLICT \(workspace_owner_id, country_code\) DO UPDATE/);
  });

  it("is repeatable: calling initDb twice never duplicates work because of ON CONFLICT DO NOTHING", async () => {
    // beforeAll ran initDb() once; run it a second time here to verify
    // idempotency — total UAE seed calls should now be 2.
    await initDb();
    const seedCalls = findUaeSeedCalls();
    expect(seedCalls).toHaveLength(2);
    for (const sql of seedCalls) {
      expect(sql).toMatch(/ON CONFLICT \(workspace_owner_id, country_code, slug\) DO NOTHING/);
    }
  });
});

// ---------------------------------------------------------------------------
// Tests: Lebanon & Cyprus delivery cities seeds never overwrite admin edits
// ---------------------------------------------------------------------------

describe("initDb Lebanon & Cyprus delivery cities seeds", () => {
  beforeAll(async () => {
    vi.clearAllMocks();
    mockDbQuery.mockImplementation(buildQueryMock(true));
    await initDb();
  });

  function findSeedCalls(countryCode: "LB" | "CY") {
    return mockDbQuery.mock.calls
      .map(([sql]) => (typeof sql === "string" ? sql : ""))
      .filter(
        (sql) =>
          sql.includes("INSERT INTO delivery_cities") &&
          sql.includes(`'${countryCode}'`),
      );
  }

  it("issues exactly one Lebanon seed INSERT targeting Lebanon workspaces", () => {
    const calls = findSeedCalls("LB");
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain("'Lebanon' = ANY(available_countries)");
  });

  it("issues exactly one Cyprus seed INSERT targeting Cyprus workspaces", () => {
    const calls = findSeedCalls("CY");
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain("'Cyprus' = ANY(available_countries)");
  });

  it("Lebanon seed uses ON CONFLICT DO NOTHING so admin edits persist", () => {
    const [sql] = findSeedCalls("LB");
    expect(sql).toMatch(/ON CONFLICT \(workspace_owner_id, country_code, slug\) DO NOTHING/);
    expect(sql).not.toContain("DO UPDATE");
    expect(sql).not.toContain("is_active  = EXCLUDED.is_active");
    expect(sql).not.toContain("EXCLUDED");
  });

  it("Cyprus seed uses ON CONFLICT DO NOTHING so admin edits persist", () => {
    const [sql] = findSeedCalls("CY");
    expect(sql).toMatch(/ON CONFLICT \(workspace_owner_id, country_code, slug\) DO NOTHING/);
    expect(sql).not.toContain("DO UPDATE");
    expect(sql).not.toContain("EXCLUDED");
  });

  it("Cyprus seed still inserts the 5 expected cities for fresh workspaces", () => {
    const [sql] = findSeedCalls("CY");
    for (const [name, slug] of [
      ["Nicosia", "nicosia"],
      ["Larnaca", "larnaca"],
      ["Paphos", "paphos"],
      ["Limassol", "limassol"],
      ["Ammachostos", "ammachostos"],
    ]) {
      expect(sql).toContain(`'${name}'`);
      expect(sql).toContain(`'${slug}'`);
    }
  });
});

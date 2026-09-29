import { beforeEach, describe, expect, it, vi } from "vitest";

const mockDbQuery = vi.fn();
const mockLockQuery = vi.fn((...args: unknown[]) => mockDbQuery(...args));
const mockLockRelease = vi.fn();
const mockDbConnect = vi.fn();
const mockLoggerInfo = vi.fn();
const mockLoggerError = vi.fn();

vi.mock("./db", () => ({
  db: {
    query: (...args: unknown[]) => mockDbQuery(...args),
    connect: (...args: unknown[]) => mockDbConnect(...args),
  },
}));

vi.mock("./logger", () => ({
  logger: {
    info: (...args: unknown[]) => mockLoggerInfo(...args),
    warn: vi.fn(),
    error: (...args: unknown[]) => mockLoggerError(...args),
  },
}));

import { initDb } from "./initDb";

const EXPECTED_PK_COLUMNS = [
  "workspace_owner_id",
  "product_id",
  "country",
  "content_language",
  "account_id",
  "data_source_id",
  "offer_id",
];

function baseQueryResult(sql: unknown) {
  const statement = typeof sql === "string" ? sql : "";
  if (
    statement.includes("FROM pg_attribute") &&
    statement.includes("'public.merchant_offer_states'::regclass")
  ) {
    return {
      rows: EXPECTED_PK_COLUMNS.map((attname) => ({ attname, attnotnull: true })),
      rowCount: EXPECTED_PK_COLUMNS.length,
    };
  }
  if (statement.includes("pg_indexes")) {
    return { rows: [{ exists: true }], rowCount: 1 };
  }
  if (statement.includes("information_schema.tables")) {
    return { rows: [{ exists: true }], rowCount: 1 };
  }
  return { rows: [], rowCount: 0 };
}

function installPrimaryKey(
  primaryKey: { constraint_name: string; constraint_type: string; columns: string[] } | null,
  invalidKeys: {
    duplicate_groups: number;
    null_groups: number;
    offending_groups: unknown[];
  } = { duplicate_groups: 0, null_groups: 0, offending_groups: [] },
) {
  mockDbQuery.mockImplementation((sql: unknown) => {
    const statement = typeof sql === "string" ? sql : "";
    if (
      statement.includes("FROM pg_constraint c") &&
      statement.includes("'public.merchant_offer_states'::regclass") &&
      statement.includes("c.contype = 'p'")
    ) {
      return Promise.resolve({
        rows: primaryKey ? [primaryKey] : [],
        rowCount: primaryKey ? 1 : 0,
      });
    }
    if (
      statement.includes("FROM merchant_offer_states") &&
      statement.includes("duplicate_groups")
    ) {
      return Promise.resolve({ rows: [invalidKeys], rowCount: 1 });
    }
    return Promise.resolve(baseQueryResult(sql));
  });
}

function merchantPrimaryKeyDdlCalls(): string[] {
  return mockDbQuery.mock.calls
    .map(([sql]) => typeof sql === "string" ? sql : "")
    .filter((sql) =>
      /^\s*ALTER TABLE merchant_offer_states/.test(sql) &&
      (
        sql.includes("ADD CONSTRAINT merchant_offer_states_pkey")
        || sql.includes("DROP CONSTRAINT")
      ),
    );
}

describe("initDb merchant_offer_states primary-key migration", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDbConnect
      .mockImplementationOnce(() =>
        Promise.resolve({
          query: (...args: unknown[]) => mockLockQuery(...args),
          release: (...args: unknown[]) => mockLockRelease(...args),
        }),
      )
      .mockImplementation(() =>
        Promise.resolve({
          query: (...args: unknown[]) => mockDbQuery(...args),
          release: vi.fn(),
        }),
      );
  });

  it("accepts an equivalent PostgreSQL primary key with a different name", async () => {
    installPrimaryKey({
      constraint_name: "legacy_offer_identity_pk",
      constraint_type: "p",
      columns: EXPECTED_PK_COLUMNS,
    });

    await initDb();

    expect(merchantPrimaryKeyDdlCalls()).toEqual([]);
    expect(mockLoggerInfo).toHaveBeenCalledWith(
      {
        constraintName: "legacy_offer_identity_pk",
        columns: EXPECTED_PK_COLUMNS,
      },
      "merchant_offer_states primary key already satisfies the expected contract",
    );
    expect(mockLockQuery.mock.calls.map(([sql]) => sql)).toEqual([
      "BEGIN",
      expect.stringContaining("pg_advisory_xact_lock"),
      "COMMIT",
    ]);
    expect(mockLockRelease).toHaveBeenCalledWith(false);
  });

  it("rejects an unexpected primary key without dropping or replacing it", async () => {
    installPrimaryKey({
      constraint_name: "legacy_offer_identity_pk",
      constraint_type: "p",
      columns: EXPECTED_PK_COLUMNS.slice(0, 4),
    });

    await expect(initDb()).rejects.toThrow(
      /unexpected primary key "legacy_offer_identity_pk".*No constraint was changed/,
    );
    expect(merchantPrimaryKeyDdlCalls()).toEqual([]);
    expect(mockLockQuery.mock.calls.map(([sql]) => sql)).toEqual([
      "BEGIN",
      expect.stringContaining("pg_advisory_xact_lock"),
      "ROLLBACK",
    ]);
    expect(mockLockRelease).toHaveBeenCalledWith(false);
  });

  it("creates the expected primary key when none exists and key data is valid", async () => {
    installPrimaryKey(null);

    await initDb();

    const primaryKeyDdl = merchantPrimaryKeyDdlCalls();
    expect(primaryKeyDdl).toHaveLength(1);
    expect(primaryKeyDdl[0]).toContain("ADD CONSTRAINT merchant_offer_states_pkey");
    expect(primaryKeyDdl[0]).toContain(
      "PRIMARY KEY (workspace_owner_id, product_id, country, content_language",
    );
  });

  it("stops on duplicate or null key data without changing rows or constraints", async () => {
    installPrimaryKey(null, {
      duplicate_groups: 1,
      null_groups: 1,
      offending_groups: [{ workspace_owner_id: "workspace", product_id: null, row_count: 2 }],
    });

    await expect(initDb()).rejects.toThrow(
      /1 duplicate key group\(s\) and 1 null-containing key group\(s\).*no rows were changed/i,
    );
    expect(merchantPrimaryKeyDdlCalls()).toEqual([]);
    expect(
      mockDbQuery.mock.calls.some(([sql]) =>
        typeof sql === "string" &&
        sql.includes("merchant_offer_states") &&
        /\b(?:DELETE|UPDATE|TRUNCATE)\b/i.test(sql),
      ),
    ).toBe(false);
  });

  it("stops with an actionable diagnostic when an expected key column is missing", async () => {
    installPrimaryKey(null);
    mockDbQuery.mockImplementation((sql: unknown) => {
      const statement = typeof sql === "string" ? sql : "";
      if (
        statement.includes("FROM pg_attribute") &&
        statement.includes("'public.merchant_offer_states'::regclass")
      ) {
        return Promise.resolve({
          rows: EXPECTED_PK_COLUMNS
            .filter((column) => column !== "data_source_id")
            .map((attname) => ({ attname, attnotnull: true })),
          rowCount: EXPECTED_PK_COLUMNS.length - 1,
        });
      }
      return Promise.resolve(baseQueryResult(sql));
    });

    await expect(initDb()).rejects.toThrow(
      /missing expected columns data_source_id.*Restore those columns and their data/i,
    );
    expect(merchantPrimaryKeyDdlCalls()).toEqual([]);
  });

  it("destroys the lock client if rollback cannot be confirmed", async () => {
    installPrimaryKey({
      constraint_name: "legacy_offer_identity_pk",
      constraint_type: "p",
      columns: EXPECTED_PK_COLUMNS.slice(0, 4),
    });
    const rollbackError = new Error("connection lost during rollback");
    mockLockQuery.mockImplementation((sql: unknown, ...args: unknown[]) =>
      sql === "ROLLBACK"
        ? Promise.reject(rollbackError)
        : mockDbQuery(sql, ...args),
    );

    await expect(initDb()).rejects.toThrow(/unexpected primary key/);

    expect(mockLockRelease).toHaveBeenCalledWith(true);
    expect(mockLoggerError).toHaveBeenCalledWith(
      { err: rollbackError },
      "database initialization advisory-lock transaction rollback failed; destroying pooled client",
    );
  });
});
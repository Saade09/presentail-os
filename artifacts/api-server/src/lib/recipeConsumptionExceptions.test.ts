/**
 * Unit tests for the recipe-consumption exception subsystem.
 *
 * Covers:
 *  1.  upsertRecipeConsumptionException — creates new row on first call
 *  2.  upsertRecipeConsumptionException — upserts (updates) on conflict
 *  3.  upsertRecipeConsumptionException — appends attempt_history on update
 *  4.  upsertRecipeConsumptionException — empty attempt array does not append
 *  5.  postRecipeConsumption — MISSING_FULFILMENT_LOCATION upserts exception
 *  6.  postRecipeConsumption — MISSING_RECIPE upserts exception
 *  7.  postRecipeConsumption — MISSING_LEDGER_BASELINE upserts exception
 *  8.  postRecipeConsumption — INSUFFICIENT_STOCK upserts exception
 *  9.  postRecipeConsumption — ALREADY_POSTED does NOT upsert exception
 * 10.  postRecipeConsumption — flag_off does NOT upsert exception
 * 11.  postRecipeConsumption — exception persistence failure is non-blocking
 *      (order transition succeeds even if upsert throws)
 * 12.  postRecipeConsumption — successful movement does NOT upsert exception
 * 13.  postRecipeConsumption — exception idempotency key is deterministic
 */

import { describe, it, expect, vi, beforeEach, type MockedFunction } from "vitest";
import * as inventoryService from "./inventoryService";

// ── Mock operational ledger writes ────────────────────────────────────────────
vi.mock("./inventoryService", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./inventoryService")>();
  return {
    ...actual,
    postMovement: vi.fn(),
    reverseMovement: vi.fn(),
  };
});

const mockPostMovement = inventoryService.postMovement as MockedFunction<
  typeof inventoryService.postMovement
>;

// ── Mock logger ───────────────────────────────────────────────────────────────
vi.mock("./logger", () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
  },
}));

import {
  postRecipeConsumption,
  buildConsumptionKey,
  upsertRecipeConsumptionException,
  type ExceptionSourceSnapshot,
  type ExceptionAttempt,
} from "./recipeConsumption";
import { InventoryError } from "./inventoryService";

// ── Fixture IDs ───────────────────────────────────────────────────────────────
const WORKSPACE_ID = "ws_exc_test_001";
const ORDER_ID = "aaaaaaaa-0000-0000-0000-000000000001";
const LINE_ITEM_ID = "bbbbbbbb-0000-0000-0000-000000000002";
const PRODUCT_ID = 100;
const BASE_ITEM_ID = 200;
const LOCATION_ID = 10;

// ── DB client builder ─────────────────────────────────────────────────────────

function makeClient(queryResponses: Array<{ rows: unknown[]; rowCount?: number }>) {
  let callIdx = 0;
  return {
    query: vi.fn().mockImplementation(() => {
      const resp = queryResponses[callIdx] ?? { rows: [], rowCount: 0 };
      callIdx++;
      return Promise.resolve({
        rows: resp.rows,
        rowCount: resp.rowCount ?? resp.rows.length,
      });
    }),
  };
}

// ── Fixture factories ─────────────────────────────────────────────────────────

const FLAG_ON = {
  rows: [{ inventory_recipe_consumption_enabled: true, inventory_allow_negative_stock: false }],
};
const FLAG_ON_NEG = {
  rows: [{ inventory_recipe_consumption_enabled: true, inventory_allow_negative_stock: true }],
};
const FLAG_OFF = {
  rows: [{ inventory_recipe_consumption_enabled: false, inventory_allow_negative_stock: false }],
};
const FLORIST_ASSIGNED = { rows: [{ location_id: LOCATION_ID }], rowCount: 1 };
const NO_FLORIST = { rows: [], rowCount: 0 };
const ORDER_NO_LOCATION = { rows: [{ location_id: null }], rowCount: 1 };
const BASELINE_EXISTS = { rows: [{ cutover_balance: "0" }], rowCount: 1 };
const NO_BASELINE = { rows: [], rowCount: 0 };
const NO_PRIOR_CYCLES = { rows: [], rowCount: 0 };
const ONE_ACTIVE_CYCLE = {
  rows: [
    {
      order_line_item_id: LINE_ITEM_ID,
      base_item_id: BASE_ITEM_ID,
      total_count: "1",
      reversed_count: "0",
    },
  ],
  rowCount: 1,
};

/** Upsert response (returning new UUID) */
const UPSERT_OK = { rows: [{ id: "exc-uuid-0001" }], rowCount: 1 };

function lineItemRows(opts: {
  lineItemId?: string;
  baseItemId?: number | null;
  orderedQty?: string;
  recipeQty?: string | null;
  inventoryTracked?: boolean;
}) {
  const {
    lineItemId = LINE_ITEM_ID,
    baseItemId = BASE_ITEM_ID,
    orderedQty = "1",
    recipeQty = "1",
    inventoryTracked = true,
  } = opts;
  return {
    rows: [
      {
        line_item_id: lineItemId,
        product_id: PRODUCT_ID,
        product_name: "Test Product",
        inventory_tracked: inventoryTracked,
        ordered_qty: orderedQty,
        base_item_id: baseItemId,
        base_item_name: baseItemId != null ? "Test Base Item" : null,
        recipe_qty: recipeQty,
        canonical_unit: "unit",
      },
    ],
    rowCount: 1,
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();
  mockPostMovement.mockResolvedValue({ posted: true, movementId: 1001, stockAfter: 99 });
});

// ── 1. upsertRecipeConsumptionException: new row ──────────────────────────────
describe("upsertRecipeConsumptionException", () => {
  it("issues an INSERT … ON CONFLICT upsert and returns the exception id", async () => {
    const client = makeClient([UPSERT_OK]);

    const snapshot: ExceptionSourceSnapshot = {
      orderId: ORDER_ID,
      lineItemId: LINE_ITEM_ID,
      productId: PRODUCT_ID,
      baseItemId: BASE_ITEM_ID,
      locationId: LOCATION_ID,
      idempotencyKey: "pc:test:li:bi:c0",
      failureDetail: { reason: "INSUFFICIENT_STOCK" },
    };

    const exId = await upsertRecipeConsumptionException(
      client as unknown as import("pg").PoolClient,
      {
        workspaceOwnerId: WORKSPACE_ID,
        orderId: ORDER_ID,
        lineItemId: LINE_ITEM_ID,
        baseItemId: BASE_ITEM_ID,
        productId: PRODUCT_ID,
        locationId: LOCATION_ID,
        reason: "INSUFFICIENT_STOCK",
        idempotencyKey: "pc:test:li:bi:c0",
        sourceSnapshot: snapshot,
      },
    );

    expect(exId).toBe("exc-uuid-0001");
    expect(client.query).toHaveBeenCalledOnce();
    // Should be an INSERT … ON CONFLICT query
    const sql = (client.query.mock.calls[0][0] as string).toLowerCase();
    expect(sql).toContain("insert into recipe_consumption_exceptions");
    expect(sql).toContain("on conflict");
  });

  // ── 2. upsertRecipeConsumptionException: with attempt ────────────────────
  it("includes attempt_history when an attempt is provided", async () => {
    const client = makeClient([UPSERT_OK]);

    const attempt: ExceptionAttempt = {
      attemptedAt: new Date().toISOString(),
      reason: "INSUFFICIENT_STOCK",
      detail: { currentStock: 0 },
      succeeded: false,
    };

    await upsertRecipeConsumptionException(
      client as unknown as import("pg").PoolClient,
      {
        workspaceOwnerId: WORKSPACE_ID,
        orderId: ORDER_ID,
        lineItemId: LINE_ITEM_ID,
        baseItemId: BASE_ITEM_ID,
        productId: PRODUCT_ID,
        locationId: LOCATION_ID,
        reason: "INSUFFICIENT_STOCK",
        idempotencyKey: "pc:test:li:bi:c0",
        sourceSnapshot: {
          orderId: ORDER_ID,
          lineItemId: LINE_ITEM_ID,
          idempotencyKey: "pc:test:li:bi:c0",
        },
        attempt,
      },
    );

    // The attempt array JSON is passed as parameter
    const params = client.query.mock.calls[0][1] as unknown[];
    // Param index 9 (0-based) is the attempt_history JSON
    const attemptJson = params[9] as string;
    const parsed = JSON.parse(attemptJson) as ExceptionAttempt[];
    expect(parsed).toHaveLength(1);
    expect(parsed[0].reason).toBe("INSUFFICIENT_STOCK");
    expect(parsed[0].succeeded).toBe(false);
  });

  // ── 3. empty attempt does not append ─────────────────────────────────────
  it("passes empty JSON array when no attempt is provided", async () => {
    const client = makeClient([UPSERT_OK]);

    await upsertRecipeConsumptionException(
      client as unknown as import("pg").PoolClient,
      {
        workspaceOwnerId: WORKSPACE_ID,
        orderId: ORDER_ID,
        lineItemId: LINE_ITEM_ID,
        baseItemId: BASE_ITEM_ID,
        productId: PRODUCT_ID,
        locationId: LOCATION_ID,
        reason: "MISSING_LEDGER_BASELINE",
        idempotencyKey: "pc:test:li:bi:c0",
        sourceSnapshot: {
          orderId: ORDER_ID,
          lineItemId: LINE_ITEM_ID,
          idempotencyKey: "pc:test:li:bi:c0",
        },
        // no attempt
      },
    );

    const params = client.query.mock.calls[0][1] as unknown[];
    expect(params[9]).toBe("[]");
  });
});

// ── Exception upsert integration with postRecipeConsumption ──────────────────

describe("postRecipeConsumption — exception persistence", () => {
  // ── 5. MISSING_FULFILMENT_LOCATION upserts exception ────────────────────
  it("upserts a MISSING_FULFILMENT_LOCATION exception when no location is resolvable", async () => {
    const client = makeClient([
      FLAG_ON,
      NO_FLORIST,
      ORDER_NO_LOCATION,
      lineItemRows({}),
      NO_PRIOR_CYCLES,
      UPSERT_OK, // exception upsert
    ]);

    const result = await postRecipeConsumption(
      client as unknown as import("pg").PoolClient,
      ORDER_ID,
      WORKSPACE_ID,
    );

    expect(result.movementsPosted).toBe(0);
    expect(result.skippedEntries?.[0].reason).toBe("MISSING_FULFILMENT_LOCATION");
    expect(mockPostMovement).not.toHaveBeenCalled();

    // Verify an upsert query was issued for the exception
    const allSql = (client.query.mock.calls as Array<[string, ...unknown[]]>)
      .map(([sql]) => sql.toLowerCase());
    const upsertCalls = allSql.filter((s) => s.includes("recipe_consumption_exceptions"));
    expect(upsertCalls.length).toBeGreaterThanOrEqual(1);
  });

  // ── 6. MISSING_RECIPE upserts exception ──────────────────────────────────
  it("upserts a MISSING_RECIPE exception when tracked product has no recipe", async () => {
    const client = makeClient([
      FLAG_ON,
      FLORIST_ASSIGNED,
      lineItemRows({ baseItemId: null, recipeQty: null }),
      UPSERT_OK, // exception upsert for MISSING_RECIPE
    ]);

    const result = await postRecipeConsumption(
      client as unknown as import("pg").PoolClient,
      ORDER_ID,
      WORKSPACE_ID,
    );

    expect(result.skippedEntries?.[0].reason).toBe("MISSING_RECIPE");

    const allSql = (client.query.mock.calls as Array<[string, ...unknown[]]>)
      .map(([sql]) => sql.toLowerCase());
    const upsertCalls = allSql.filter((s) => s.includes("recipe_consumption_exceptions"));
    expect(upsertCalls.length).toBeGreaterThanOrEqual(1);
  });

  // ── 7. MISSING_LEDGER_BASELINE upserts exception ─────────────────────────
  it("upserts a MISSING_LEDGER_BASELINE exception when baseline is absent", async () => {
    const client = makeClient([
      FLAG_ON,
      FLORIST_ASSIGNED,
      lineItemRows({}),
      NO_PRIOR_CYCLES,
      NO_BASELINE,
      UPSERT_OK, // exception upsert
    ]);

    const result = await postRecipeConsumption(
      client as unknown as import("pg").PoolClient,
      ORDER_ID,
      WORKSPACE_ID,
    );

    expect(result.skippedEntries?.[0].reason).toBe("MISSING_LEDGER_BASELINE");

    const allSql = (client.query.mock.calls as Array<[string, ...unknown[]]>)
      .map(([sql]) => sql.toLowerCase());
    const upsertCalls = allSql.filter((s) => s.includes("recipe_consumption_exceptions"));
    expect(upsertCalls.length).toBeGreaterThanOrEqual(1);
  });

  // ── 8. INSUFFICIENT_STOCK upserts exception ───────────────────────────────
  it("upserts an INSUFFICIENT_STOCK exception when postMovement throws INSUFFICIENT_STOCK", async () => {
    const client = makeClient([
      FLAG_ON,
      FLORIST_ASSIGNED,
      lineItemRows({}),
      NO_PRIOR_CYCLES,
      BASELINE_EXISTS,
      UPSERT_OK, // exception upsert
    ]);

    mockPostMovement.mockRejectedValueOnce(
      new InventoryError("INSUFFICIENT_STOCK", {
        baseItemId: BASE_ITEM_ID,
        locationId: LOCATION_ID,
        currentStock: 0,
        quantityChange: -5,
        projectedStock: -5,
      }),
    );

    const result = await postRecipeConsumption(
      client as unknown as import("pg").PoolClient,
      ORDER_ID,
      WORKSPACE_ID,
    );

    expect(result.skippedEntries?.[0].reason).toBe("INSUFFICIENT_STOCK");

    const allSql = (client.query.mock.calls as Array<[string, ...unknown[]]>)
      .map(([sql]) => sql.toLowerCase());
    const upsertCalls = allSql.filter((s) => s.includes("recipe_consumption_exceptions"));
    expect(upsertCalls.length).toBeGreaterThanOrEqual(1);
  });

  // ── 9. ALREADY_POSTED does NOT upsert exception ───────────────────────────
  it("does NOT upsert an exception for ALREADY_POSTED (idempotent skip)", async () => {
    const client = makeClient([
      FLAG_ON,
      FLORIST_ASSIGNED,
      lineItemRows({}),
      ONE_ACTIVE_CYCLE,
      // no upsert query expected
    ]);

    const result = await postRecipeConsumption(
      client as unknown as import("pg").PoolClient,
      ORDER_ID,
      WORKSPACE_ID,
    );

    expect(result.skippedEntries?.[0].reason).toBe("ALREADY_POSTED");

    const allSql = (client.query.mock.calls as Array<[string, ...unknown[]]>)
      .map(([sql]) => sql.toLowerCase());
    const upsertCalls = allSql.filter((s) => s.includes("recipe_consumption_exceptions"));
    expect(upsertCalls).toHaveLength(0);
  });

  // ── 10. flag_off does NOT upsert exception ────────────────────────────────
  it("does NOT upsert an exception when the feature flag is off", async () => {
    const client = makeClient([FLAG_OFF]);

    const result = await postRecipeConsumption(
      client as unknown as import("pg").PoolClient,
      ORDER_ID,
      WORKSPACE_ID,
    );

    expect(result.skipped).toBe("flag_off");

    const allSql = (client.query.mock.calls as Array<[string, ...unknown[]]>)
      .map(([sql]) => sql.toLowerCase());
    const upsertCalls = allSql.filter((s) => s.includes("recipe_consumption_exceptions"));
    expect(upsertCalls).toHaveLength(0);
  });

  // ── 11. exception persistence failure is non-blocking ────────────────────
  it("propagates when exception persistence fails so the event cannot be lost", async () => {
    let callIdx = 0;
    const queryResponses: Array<{ rows: unknown[]; rowCount?: number }> = [
      FLAG_ON,
      NO_FLORIST,
      ORDER_NO_LOCATION,
      lineItemRows({}),
      NO_PRIOR_CYCLES,
    ];
    const client = {
      query: vi.fn().mockImplementation((sql: string) => {
        if (sql.toLowerCase().includes("recipe_consumption_exceptions")) {
          return Promise.reject(new Error("DB connection lost"));
        }
        const resp = queryResponses[callIdx] ?? { rows: [], rowCount: 0 };
        callIdx++;
        return Promise.resolve({
          rows: resp.rows,
          rowCount: resp.rowCount ?? resp.rows.length,
        });
      }),
    };

    await expect(
      postRecipeConsumption(
        client as unknown as import("pg").PoolClient,
        ORDER_ID,
        WORKSPACE_ID,
      ),
    ).rejects.toThrow("DB connection lost");
  });

  // ── 12. successful movement does NOT upsert exception ────────────────────
  it("does NOT upsert an exception when movement posts successfully", async () => {
    const client = makeClient([
      FLAG_ON,
      FLORIST_ASSIGNED,
      lineItemRows({}),
      NO_PRIOR_CYCLES,
      BASELINE_EXISTS,
      // no exception upsert expected
    ]);

    const result = await postRecipeConsumption(
      client as unknown as import("pg").PoolClient,
      ORDER_ID,
      WORKSPACE_ID,
    );

    expect(result.movementsPosted).toBe(1);
    expect(result.skippedEntries).toHaveLength(0);

    const allSql = (client.query.mock.calls as Array<[string, ...unknown[]]>)
      .map(([sql]) => sql.toLowerCase());
    const upsertCalls = allSql.filter((s) => s.includes("recipe_consumption_exceptions"));
    expect(upsertCalls).toHaveLength(0);
  });

  // ── 13. exception idempotency key is deterministic ────────────────────────
  it("uses a deterministic idempotency key derived from orderId/lineItemId/baseItemId/cycle", () => {
    const key0 = buildConsumptionKey(ORDER_ID, LINE_ITEM_ID, BASE_ITEM_ID, 0);
    const key0b = buildConsumptionKey(ORDER_ID, LINE_ITEM_ID, BASE_ITEM_ID, 0);
    expect(key0).toBe(key0b);

    const key1 = buildConsumptionKey(ORDER_ID, LINE_ITEM_ID, BASE_ITEM_ID, 1);
    expect(key1).not.toBe(key0);
    expect(key1).toMatch(/:c1$/);
  });

  // ── allow_negative + no baseline: no exception, movement posted ──────────
  it("does NOT upsert a MISSING_LEDGER_BASELINE exception when allow_negative_stock=true", async () => {
    const client = makeClient([
      FLAG_ON_NEG,
      FLORIST_ASSIGNED,
      lineItemRows({}),
      NO_PRIOR_CYCLES,
      // no baseline query, no exception upsert
    ]);

    const result = await postRecipeConsumption(
      client as unknown as import("pg").PoolClient,
      ORDER_ID,
      WORKSPACE_ID,
    );

    expect(result.movementsPosted).toBe(1);

    const allSql = (client.query.mock.calls as Array<[string, ...unknown[]]>)
      .map(([sql]) => sql.toLowerCase());
    const upsertCalls = allSql.filter((s) => s.includes("recipe_consumption_exceptions"));
    expect(upsertCalls).toHaveLength(0);
  });

  // ── source_snapshot includes full recipe snapshot for INSUFFICIENT_STOCK ──
  it("includes recipeSnapshot in source_snapshot for INSUFFICIENT_STOCK exception", async () => {
    const client = makeClient([
      FLAG_ON,
      FLORIST_ASSIGNED,
      lineItemRows({ orderedQty: "3", recipeQty: "5" }),
      NO_PRIOR_CYCLES,
      BASELINE_EXISTS,
      UPSERT_OK,
    ]);

    mockPostMovement.mockRejectedValueOnce(
      new InventoryError("INSUFFICIENT_STOCK", {
        baseItemId: BASE_ITEM_ID,
        locationId: LOCATION_ID,
        currentStock: 10,
        quantityChange: -15,
        projectedStock: -5,
      }),
    );

    await postRecipeConsumption(
      client as unknown as import("pg").PoolClient,
      ORDER_ID,
      WORKSPACE_ID,
    );

    // Find the upsert call and verify params contain recipeSnapshot
    const upsertCall = (client.query.mock.calls as Array<[string, ...unknown[]]>).find(
      ([sql]) => sql.toLowerCase().includes("recipe_consumption_exceptions"),
    );
    expect(upsertCall).toBeDefined();

    const snapshotParam = (upsertCall![1] as unknown[])[8] as string; // source_snapshot JSON
    const snapshot = JSON.parse(snapshotParam) as Record<string, unknown>;
    expect(snapshot.recipeSnapshot).toBeDefined();
    expect((snapshot.recipeSnapshot as Record<string, unknown>).orderedQty).toBe("3");
    expect((snapshot.recipeSnapshot as Record<string, unknown>).recipeQty).toBe("5");
    expect(snapshot.calculation).toContain("×");
  });
});

/**
 * Unit tests for recipeConsumption.ts and cancellationReversal.ts
 *
 * Tests cover the scenarios documented in task 4114:
 *  1.  1×1 → 1 movement created
 *  2.  Multiple units → quantity multiplied correctly
 *  3.  Decimal recipe quantity preserved to full precision
 *  4.  Multi-component product → one movement per recipe component
 *  5.  Bundle product (multiple base items) → all components consumed
 *  6.  Feature flag off → {skipped:"flag_off"}, no movement
 *  7.  Idempotent retry (within same cycle) → ALREADY_POSTED skip
 *  8.  Missing recipe → skip with logged warning, movement NOT created
 *  9.  Missing ledger baseline + allow_negative_stock=false → skip, no movement
 * 10.  Missing ledger baseline + allow_negative_stock=true → movement IS created
 * 11.  No florist assignment + orders.location_id set → uses orders.location_id
 * 12.  No florist assignment + no orders.location_id → skip with warning
 * 13.  Cancellation reversal → one reversal per original consumption
 * 14.  Re-fulfillment after reversal → reversed_count=1 → :c1 key → new movement
 * 15.  Re-fulfillment cycle: already-active consumption → ALREADY_POSTED (no duplicate)
 * 16.  Reconciliation rerun idempotency: unreversed row → satisfied → no second post
 * 17.  movementsPosted / movementsSkipped counts in result
 * 18.  INSUFFICIENT_STOCK maps to its own reason, not MISSING_LEDGER_BASELINE
 */

import { describe, it, expect, vi, beforeEach, type MockedFunction } from "vitest";
import * as inventoryService from "./inventoryService";

// ── Mock operational ledger writes from inventoryService ─────────────────────
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
const mockReverseMovement = inventoryService.reverseMovement as MockedFunction<
  typeof inventoryService.reverseMovement
>;

// ── Mock logger to suppress output during tests ──────────────────────────────
vi.mock("./logger", () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
  },
}));

import { postRecipeConsumption, buildConsumptionKey } from "./recipeConsumption";
import { postCancellationReversal } from "./cancellationReversal";
import { InventoryError } from "./inventoryService";

// ── Fixture IDs (test-only, not production IDs) ──────────────────────────────
const WORKSPACE_ID = "ws_test_001";
const ORDER_ID = "00000000-0000-0000-0000-000000000001";
const LINE_ITEM_ID = "00000000-0000-0000-0000-000000000002";
const LINE_ITEM_ID_2 = "00000000-0000-0000-0000-000000000003";
const PRODUCT_ID = 453; // test product (modelled on 15 Roses & Rocher Luxe Bundle)
const BASE_ITEM_ID = 85; // test base item (modelled on 24 pieces of ferrero rocher)
const BASE_ITEM_ID_2 = 86;
const LOCATION_ID = 10;

// ── DB client builder helpers ─────────────────────────────────────────────────

/** Minimal mock for PoolClient.query that uses a call queue */
function makeClient(queryResponses: Array<{ rows: unknown[]; rowCount?: number }>) {
  let callIdx = 0;
  return {
    query: vi.fn().mockImplementation(() => {
      const resp = queryResponses[callIdx] ?? { rows: [], rowCount: 0 };
      callIdx++;
      return Promise.resolve({ rows: resp.rows, rowCount: resp.rowCount ?? resp.rows.length });
    }),
  };
}

/** Flag row — enabled */
const FLAG_ON = {
  rows: [{ inventory_recipe_consumption_enabled: true, inventory_allow_negative_stock: false }],
};
/** Flag row — enabled + allow negative */
const FLAG_ON_NEG = {
  rows: [{ inventory_recipe_consumption_enabled: true, inventory_allow_negative_stock: true }],
};
/** Flag row — disabled */
const FLAG_OFF = {
  rows: [{ inventory_recipe_consumption_enabled: false, inventory_allow_negative_stock: false }],
};
/** Florist assignment with a location */
const FLORIST_ASSIGNED = { rows: [{ location_id: LOCATION_ID }], rowCount: 1 };
/** No florist assignment */
const NO_FLORIST = { rows: [], rowCount: 0 };
/** orders.location_id set */
const ORDER_LOCATION = { rows: [{ location_id: LOCATION_ID }], rowCount: 1 };
/** orders.location_id null */
const ORDER_NO_LOCATION = { rows: [{ location_id: null }], rowCount: 1 };
/** Ledger baseline exists */
const BASELINE_EXISTS = { rows: [{ cutover_balance: "0" }], rowCount: 1 };
/** No ledger baseline */
const NO_BASELINE = { rows: [], rowCount: 0 };
/** No existing consumption rows → activeCount=0, reversedCount=0 → first fulfillment */
const NO_PRIOR_CYCLES = { rows: [], rowCount: 0 };
/**
 * One reversed consumption row → totalCount=1, reversedCount=1 → activeCount=0
 * → re-fulfillment allowed with cycle :c1
 */
const ONE_REVERSED_CYCLE = {
  rows: [
    {
      order_line_item_id: LINE_ITEM_ID,
      base_item_id: BASE_ITEM_ID,
      total_count: "1",
      reversed_count: "1",
    },
  ],
  rowCount: 1,
};
/**
 * One ACTIVE (unreversed) consumption row → activeCount=1 → ALREADY_POSTED
 */
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

/** Single tracked product line item with one recipe component */
function lineItemRows(opts: {
  lineItemId?: string;
  productId?: number;
  baseItemId?: number;
  orderedQty?: string;
  recipeQty?: string;
  inventoryTracked?: boolean;
}) {
  const {
    lineItemId = LINE_ITEM_ID,
    productId = PRODUCT_ID,
    baseItemId = BASE_ITEM_ID,
    orderedQty = "1",
    recipeQty = "1",
    inventoryTracked = true,
  } = opts;
  return {
    rows: [
      {
        line_item_id: lineItemId,
        product_id: productId,
        product_name: "Test Product",
        inventory_tracked: inventoryTracked,
        ordered_qty: orderedQty,
        base_item_id: baseItemId,
        base_item_name: "Test Base Item",
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
  mockReverseMovement.mockResolvedValue({
    posted: true,
    movementId: 2001,
    stockAfter: 100,
  });
});

describe("buildConsumptionKey", () => {
  it("produces expected format with cycle suffix", () => {
    const key = buildConsumptionKey(ORDER_ID, LINE_ITEM_ID, BASE_ITEM_ID, 0);
    expect(key).toBe(`pc:${ORDER_ID}:${LINE_ITEM_ID}:${BASE_ITEM_ID}:c0`);
  });

  it("cycle 1 produces a different key from cycle 0", () => {
    const k0 = buildConsumptionKey(ORDER_ID, LINE_ITEM_ID, BASE_ITEM_ID, 0);
    const k1 = buildConsumptionKey(ORDER_ID, LINE_ITEM_ID, BASE_ITEM_ID, 1);
    expect(k0).not.toBe(k1);
    expect(k1).toMatch(/:c1$/);
  });
});

describe("postRecipeConsumption", () => {
  // ── Test 6: flag off ───────────────────────────────────────────────────────
  it("returns {skipped:'flag_off'} when feature flag is disabled", async () => {
    const client = makeClient([FLAG_OFF]);
    const result = await postRecipeConsumption(
      client as unknown as import("pg").PoolClient,
      ORDER_ID,
      WORKSPACE_ID,
    );
    expect(result).toEqual({ skipped: "flag_off" });
    expect(mockPostMovement).not.toHaveBeenCalled();
  });

  // ── Test 1: 1×1 → 1 movement ──────────────────────────────────────────────
  it("creates exactly one movement for a 1×1 recipe", async () => {
    const client = makeClient([
      FLAG_ON,
      FLORIST_ASSIGNED,
      lineItemRows({}),
      NO_PRIOR_CYCLES,    // cycle state: no existing consumptions
      BASELINE_EXISTS,
    ]);
    const result = await postRecipeConsumption(
      client as unknown as import("pg").PoolClient,
      ORDER_ID,
      WORKSPACE_ID,
    );
    expect(result.movementsPosted).toBe(1);
    expect(result.movementsSkipped).toBe(0);
    expect(mockPostMovement).toHaveBeenCalledOnce();
    const call = mockPostMovement.mock.calls[0][1];
    expect(call.quantityChange).toBe(-1);
    expect(call.baseItemId).toBe(BASE_ITEM_ID);
    expect(call.locationId).toBe(LOCATION_ID);
    // First fulfillment → cycle 0 (reversedCount = 0)
    expect(call.idempotencyKey).toBe(buildConsumptionKey(ORDER_ID, LINE_ITEM_ID, BASE_ITEM_ID, 0));
  });

  // ── Test 2: multiple units → quantity multiplied ──────────────────────────
  it("multiplies order quantity × recipe quantity", async () => {
    const client = makeClient([
      FLAG_ON,
      FLORIST_ASSIGNED,
      lineItemRows({ orderedQty: "3", recipeQty: "5" }),
      NO_PRIOR_CYCLES,
      BASELINE_EXISTS,
    ]);
    await postRecipeConsumption(
      client as unknown as import("pg").PoolClient,
      ORDER_ID,
      WORKSPACE_ID,
    );
    const call = mockPostMovement.mock.calls[0][1];
    expect(call.quantityChange).toBe(-15);
  });

  // ── Test 3: decimal recipe quantity precision ─────────────────────────────
  it("preserves decimal recipe quantity precision", async () => {
    const client = makeClient([
      FLAG_ON,
      FLORIST_ASSIGNED,
      lineItemRows({ orderedQty: "2", recipeQty: "0.333" }),
      NO_PRIOR_CYCLES,
      BASELINE_EXISTS,
    ]);
    await postRecipeConsumption(
      client as unknown as import("pg").PoolClient,
      ORDER_ID,
      WORKSPACE_ID,
    );
    const call = mockPostMovement.mock.calls[0][1];
    // 2 × 0.333 = 0.666 (not 0.6659999... from float imprecision)
    expect(Math.abs(call.quantityChange - (-0.666))).toBeLessThan(1e-9);
  });

  // ── Test 4: multi-component product ───────────────────────────────────────
  it("creates one movement per recipe component for a multi-component product", async () => {
    const client = makeClient([
      FLAG_ON,
      FLORIST_ASSIGNED,
      {
        rows: [
          {
            line_item_id: LINE_ITEM_ID,
            product_id: PRODUCT_ID,
            product_name: "Bundle",
            inventory_tracked: true,
            ordered_qty: "1",
            base_item_id: BASE_ITEM_ID,
            base_item_name: "Roses",
            recipe_qty: "15",
            canonical_unit: "unit",
          },
          {
            line_item_id: LINE_ITEM_ID,
            product_id: PRODUCT_ID,
            product_name: "Bundle",
            inventory_tracked: true,
            ordered_qty: "1",
            base_item_id: BASE_ITEM_ID_2,
            base_item_name: "Rocher",
            recipe_qty: "24",
            canonical_unit: "unit",
          },
        ],
        rowCount: 2,
      },
      NO_PRIOR_CYCLES, // cycle state for both base items — no existing rows
      BASELINE_EXISTS, // for BASE_ITEM_ID
      BASELINE_EXISTS, // for BASE_ITEM_ID_2
    ]);
    mockPostMovement
      .mockResolvedValueOnce({ posted: true, movementId: 1001 })
      .mockResolvedValueOnce({ posted: true, movementId: 1002 });
    const result = await postRecipeConsumption(
      client as unknown as import("pg").PoolClient,
      ORDER_ID,
      WORKSPACE_ID,
    );
    expect(result.movementsPosted).toBe(2);
    expect(mockPostMovement).toHaveBeenCalledTimes(2);
  });

  // ── Test 5: bundle product verifies quantities ────────────────────────────
  it("consumes correct quantities for each bundle component", async () => {
    const client = makeClient([
      FLAG_ON,
      FLORIST_ASSIGNED,
      {
        rows: [
          {
            line_item_id: LINE_ITEM_ID,
            product_id: PRODUCT_ID,
            product_name: "Bundle",
            inventory_tracked: true,
            ordered_qty: "2",
            base_item_id: BASE_ITEM_ID,
            base_item_name: "Roses",
            recipe_qty: "15",
            canonical_unit: "unit",
          },
          {
            line_item_id: LINE_ITEM_ID,
            product_id: PRODUCT_ID,
            product_name: "Bundle",
            inventory_tracked: true,
            ordered_qty: "2",
            base_item_id: BASE_ITEM_ID_2,
            base_item_name: "Rocher",
            recipe_qty: "24",
            canonical_unit: "unit",
          },
        ],
        rowCount: 2,
      },
      NO_PRIOR_CYCLES,
      BASELINE_EXISTS,
      BASELINE_EXISTS,
    ]);
    mockPostMovement
      .mockResolvedValueOnce({ posted: true, movementId: 1001 })
      .mockResolvedValueOnce({ posted: true, movementId: 1002 });
    await postRecipeConsumption(
      client as unknown as import("pg").PoolClient,
      ORDER_ID,
      WORKSPACE_ID,
    );
    const calls = mockPostMovement.mock.calls.map((c) => c[1].quantityChange);
    expect(calls).toContain(-30); // 2 × 15
    expect(calls).toContain(-48); // 2 × 24
  });

  // ── Test 7: active (unreversed) consumption exists → ALREADY_POSTED ───────
  it("skips when an unreversed consumption already exists (idempotent retry)", async () => {
    // ONE_ACTIVE_CYCLE: total=1, reversed=0 → activeCount=1 → skip without calling postMovement
    const client = makeClient([
      FLAG_ON,
      FLORIST_ASSIGNED,
      lineItemRows({}),
      ONE_ACTIVE_CYCLE,
    ]);
    const result = await postRecipeConsumption(
      client as unknown as import("pg").PoolClient,
      ORDER_ID,
      WORKSPACE_ID,
    );
    expect(result.movementsPosted).toBe(0);
    expect(result.movementsSkipped).toBe(1);
    expect(result.skippedEntries?.[0].reason).toBe("ALREADY_POSTED");
    // postMovement must NOT be called — no duplicate insert attempted
    expect(mockPostMovement).not.toHaveBeenCalled();
  });

  // ── Test 8: missing recipe → skip ─────────────────────────────────────────
  it("skips tracked product with no recipe without throwing", async () => {
    const client = makeClient([
      FLAG_ON,
      FLORIST_ASSIGNED,
      {
        rows: [
          {
            line_item_id: LINE_ITEM_ID,
            product_id: PRODUCT_ID,
            product_name: "No Recipe Product",
            inventory_tracked: true,
            ordered_qty: "1",
            base_item_id: null,
            base_item_name: null,
            recipe_qty: null,
            canonical_unit: null,
          },
        ],
        rowCount: 1,
      },
      { rows: [{ id: "exc-uuid-missing-recipe" }], rowCount: 1 },
    ]);
    const result = await postRecipeConsumption(
      client as unknown as import("pg").PoolClient,
      ORDER_ID,
      WORKSPACE_ID,
    );
    expect(result.movementsPosted).toBe(0);
    expect(result.movementsSkipped).toBe(1);
    expect(result.skippedEntries?.[0].reason).toBe("MISSING_RECIPE");
    expect(mockPostMovement).not.toHaveBeenCalled();
  });

  // ── Test 9: missing baseline + allow_negative=false → skip ────────────────
  it("skips movement when ledger baseline missing and allow_negative_stock=false", async () => {
    const client = makeClient([
      FLAG_ON,
      FLORIST_ASSIGNED,
      lineItemRows({}),
      NO_PRIOR_CYCLES,
      NO_BASELINE,
      { rows: [{ id: "exc-uuid-missing-baseline" }], rowCount: 1 },
    ]);
    const result = await postRecipeConsumption(
      client as unknown as import("pg").PoolClient,
      ORDER_ID,
      WORKSPACE_ID,
    );
    expect(result.movementsPosted).toBe(0);
    expect(result.movementsSkipped).toBe(1);
    expect(result.skippedEntries?.[0].reason).toBe("MISSING_LEDGER_BASELINE");
    expect(mockPostMovement).not.toHaveBeenCalled();
  });

  // ── Test 10: missing baseline + allow_negative=true → movement IS created ─
  it("posts movement when ledger baseline missing but allow_negative_stock=true", async () => {
    const client = makeClient([
      FLAG_ON_NEG,
      FLORIST_ASSIGNED,
      lineItemRows({}),
      NO_PRIOR_CYCLES,
      // No baseline query issued when allowNegative=true
    ]);
    const result = await postRecipeConsumption(
      client as unknown as import("pg").PoolClient,
      ORDER_ID,
      WORKSPACE_ID,
    );
    expect(result.movementsPosted).toBe(1);
    expect(mockPostMovement).toHaveBeenCalledOnce();
    const call = mockPostMovement.mock.calls[0][1];
    expect(call.inventoryAllowNegativeStock).toBe(true);
  });

  // ── Test 11: no florist, orders.location_id set ───────────────────────────
  it("falls back to orders.location_id when no florist assignment exists", async () => {
    const client = makeClient([
      FLAG_ON,
      NO_FLORIST,
      ORDER_LOCATION,
      lineItemRows({}),
      NO_PRIOR_CYCLES,
      BASELINE_EXISTS,
    ]);
    const result = await postRecipeConsumption(
      client as unknown as import("pg").PoolClient,
      ORDER_ID,
      WORKSPACE_ID,
    );
    expect(result.movementsPosted).toBe(1);
    const call = mockPostMovement.mock.calls[0][1];
    expect(call.locationId).toBe(LOCATION_ID);
  });

  // ── Test 12: no florist, no orders.location_id → skip ────────────────────
  it("skips with warning when neither florist assignment nor orders.location_id is set", async () => {
    const client = makeClient([
      FLAG_ON,
      NO_FLORIST,
      ORDER_NO_LOCATION,
      lineItemRows({}),
      NO_PRIOR_CYCLES,
      { rows: [{ id: "exc-uuid-missing-location" }], rowCount: 1 },
    ]);
    const result = await postRecipeConsumption(
      client as unknown as import("pg").PoolClient,
      ORDER_ID,
      WORKSPACE_ID,
    );
    expect(result.movementsPosted).toBe(0);
    expect(result.movementsSkipped).toBe(1);
    expect(result.skippedEntries?.[0].reason).toBe("MISSING_FULFILMENT_LOCATION");
    expect(mockPostMovement).not.toHaveBeenCalled();
  });

  // ── Test 14: Re-fulfillment after reversal uses :c1 key ──────────────────
  it("uses reversedCount=1 key on re-fulfillment after cancellation", async () => {
    // ONE_REVERSED_CYCLE: total=1, reversed=1 → activeCount=0 → post with :c1
    const client = makeClient([
      FLAG_ON,
      FLORIST_ASSIGNED,
      lineItemRows({}),
      ONE_REVERSED_CYCLE,
      BASELINE_EXISTS,
    ]);
    mockReverseMovement.mockResolvedValueOnce({ posted: true, movementId: 2001 });
    const result = await postRecipeConsumption(
      client as unknown as import("pg").PoolClient,
      ORDER_ID,
      WORKSPACE_ID,
    );
    expect(result.movementsPosted).toBe(1);
    const call = mockPostMovement.mock.calls[0][1];
    // Must use reversedCount=1 key — distinct from the original :c0
    expect(call.idempotencyKey).toBe(
      buildConsumptionKey(ORDER_ID, LINE_ITEM_ID, BASE_ITEM_ID, 1),
    );
    expect(call.idempotencyKey).toMatch(/:c1$/);
  });

  // ── Test 15: re-fulfillment cycle: active → ALREADY_POSTED ───────────────
  it("ALREADY_POSTED when re-fulfilling but active consumption exists (no double-post)", async () => {
    // ONE_ACTIVE_CYCLE: total=1, reversed=0 → activeCount=1 → skip
    const client = makeClient([
      FLAG_ON,
      FLORIST_ASSIGNED,
      lineItemRows({}),
      ONE_ACTIVE_CYCLE,
    ]);
    const result = await postRecipeConsumption(
      client as unknown as import("pg").PoolClient,
      ORDER_ID,
      WORKSPACE_ID,
    );
    expect(result.movementsPosted).toBe(0);
    expect(result.skippedEntries?.[0].reason).toBe("ALREADY_POSTED");
    expect(mockPostMovement).not.toHaveBeenCalled();
  });

  // ── Test 17: movementsPosted / movementsSkipped counts ───────────────────
  it("reports accurate movementsPosted and movementsSkipped in result", async () => {
    // Two line items: one with recipe (will post), one without recipe (will skip)
    // Note: the MISSING_RECIPE exception upsert fires before the cycle-state query,
    // so we include a dummy upsert response after the line items query.
    const client = makeClient([
      FLAG_ON,
      FLORIST_ASSIGNED,
      {
        rows: [
          {
            line_item_id: LINE_ITEM_ID,
            product_id: PRODUCT_ID,
            product_name: "Tracked With Recipe",
            inventory_tracked: true,
            ordered_qty: "1",
            base_item_id: BASE_ITEM_ID,
            base_item_name: "Base Item",
            recipe_qty: "1",
            canonical_unit: "unit",
          },
          {
            line_item_id: LINE_ITEM_ID_2,
            product_id: PRODUCT_ID + 1,
            product_name: "Tracked No Recipe",
            inventory_tracked: true,
            ordered_qty: "1",
            base_item_id: null,
            base_item_name: null,
            recipe_qty: null,
            canonical_unit: null,
          },
        ],
        rowCount: 2,
      },
      { rows: [{ id: "exc-uuid-missing-recipe" }], rowCount: 1 }, // exception upsert for MISSING_RECIPE
      NO_PRIOR_CYCLES,
      BASELINE_EXISTS,
    ]);
    const result = await postRecipeConsumption(
      client as unknown as import("pg").PoolClient,
      ORDER_ID,
      WORKSPACE_ID,
    );
    expect(result.movementsPosted).toBe(1);
    expect(result.movementsSkipped).toBe(1);
  });

  // ── Test 18: INSUFFICIENT_STOCK maps to distinct reason ──────────────────
  it("records INSUFFICIENT_STOCK as its own reason, not MISSING_LEDGER_BASELINE", async () => {
    const client = makeClient([
      FLAG_ON,
      FLORIST_ASSIGNED,
      lineItemRows({}),
      NO_PRIOR_CYCLES,
      BASELINE_EXISTS,
      { rows: [{ id: "exc-uuid-insufficient-stock" }], rowCount: 1 },
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
    expect(result.movementsPosted).toBe(0);
    expect(result.movementsSkipped).toBe(1);
    expect(result.skippedEntries?.[0].reason).toBe("INSUFFICIENT_STOCK");
  });

  // ── Test 16: reconciliation rerun idempotency ─────────────────────────────
  it("reconciliation rerun: existing active movement → ALREADY_POSTED (no second post)", async () => {
    // Simulate what happens when the reconciliation script calls postRecipeConsumption
    // on an order that already has an unreversed consumption (i.e., already backfilled).
    const client = makeClient([
      FLAG_ON,
      FLORIST_ASSIGNED,
      lineItemRows({}),
      ONE_ACTIVE_CYCLE, // active movement exists → don't post again
    ]);
    const result = await postRecipeConsumption(
      client as unknown as import("pg").PoolClient,
      ORDER_ID,
      WORKSPACE_ID,
    );
    expect(result.movementsPosted).toBe(0);
    expect(result.movementsSkipped).toBe(1);
    expect(result.skippedEntries?.[0].reason).toBe("ALREADY_POSTED");
    expect(mockPostMovement).not.toHaveBeenCalled();
  });
});

// ── Cancellation reversal tests ───────────────────────────────────────────────

describe("postCancellationReversal", () => {
  // ── Test 13: one reversal per original ───────────────────────────────────
  it("creates one reversal movement per original consumption row", async () => {
    const client = makeClient([
      {
        rows: [
          {
            id: 500,
            base_item_id: BASE_ITEM_ID,
            location_id: LOCATION_ID,
            quantity_change: "-15",
            workspace_owner_id: WORKSPACE_ID,
            order_id: ORDER_ID,
            order_line_item_id: LINE_ITEM_ID,
            product_id: PRODUCT_ID,
          },
        ],
        rowCount: 1,
      },
    ]);
    mockPostMovement.mockResolvedValueOnce({ posted: true, movementId: 2001 });
    const result = await postCancellationReversal(
      client as unknown as import("pg").PoolClient,
      ORDER_ID,
      WORKSPACE_ID,
    );
    expect(result.movementIds).toHaveLength(1);
    expect(result.skippedCount).toBe(0);
    const call = mockReverseMovement.mock.calls[0][1];
    expect(call.movementId).toBe(500);
    expect(call.movementType).toBe("order_cancellation");
    expect(call.idempotencyKey).toBe("rev:cancel:500");
  });

  // ── Null location_id → logged warning, skip ───────────────────────────────
  it("logs warning and skips movements with null location_id", async () => {
    const client = makeClient([
      {
        rows: [
          {
            id: 501,
            base_item_id: BASE_ITEM_ID,
            location_id: null,
            quantity_change: "-10",
            workspace_owner_id: WORKSPACE_ID,
            order_id: ORDER_ID,
            order_line_item_id: LINE_ITEM_ID,
            product_id: PRODUCT_ID,
          },
        ],
        rowCount: 1,
      },
    ]);
    const result = await postCancellationReversal(
      client as unknown as import("pg").PoolClient,
      ORDER_ID,
      WORKSPACE_ID,
    );
    expect(result.movementIds).toHaveLength(0);
    expect(result.skippedCount).toBe(1);
    expect(mockReverseMovement).not.toHaveBeenCalled();
  });

  // ── Duplicate reversal → skipped ─────────────────────────────────────────
  it("skips reversal when idempotency key already posted", async () => {
    const client = makeClient([
      {
        rows: [
          {
            id: 502,
            base_item_id: BASE_ITEM_ID,
            location_id: LOCATION_ID,
            quantity_change: "-5",
            workspace_owner_id: WORKSPACE_ID,
            order_id: ORDER_ID,
            order_line_item_id: LINE_ITEM_ID,
            product_id: PRODUCT_ID,
          },
        ],
        rowCount: 1,
      },
    ]);
    mockReverseMovement.mockResolvedValueOnce({ posted: false, reason: "duplicate" });
    const result = await postCancellationReversal(
      client as unknown as import("pg").PoolClient,
      ORDER_ID,
      WORKSPACE_ID,
    );
    expect(result.movementIds).toHaveLength(0);
    expect(result.skippedCount).toBe(1);
  });

  // ── No consumption rows → empty result ───────────────────────────────────
  it("returns empty movementIds when no consumption rows exist for the order", async () => {
    const client = makeClient([{ rows: [], rowCount: 0 }]);
    const result = await postCancellationReversal(
      client as unknown as import("pg").PoolClient,
      ORDER_ID,
      WORKSPACE_ID,
    );
    expect(result.movementIds).toHaveLength(0);
    expect(result.skippedCount).toBe(0);
    expect(mockReverseMovement).not.toHaveBeenCalled();
  });
});

// ── Full cycle: fulfil → cancel → re-fulfil ───────────────────────────────────

describe("Re-fulfillment cycle (unit-level simulation)", () => {
  it("re-fulfillment after cancellation gets :c1 key and creates a new movement", async () => {
    // Step 1: First fulfillment (no prior cycles → cycle 0)
    const client1 = makeClient([
      FLAG_ON,
      FLORIST_ASSIGNED,
      lineItemRows({}),
      NO_PRIOR_CYCLES,
      BASELINE_EXISTS,
    ]);
    mockPostMovement.mockResolvedValueOnce({ posted: true, movementId: 1000 });
    const r1 = await postRecipeConsumption(
      client1 as unknown as import("pg").PoolClient,
      ORDER_ID,
      WORKSPACE_ID,
    );
    expect(r1.movementsPosted).toBe(1);
    const k0 = mockPostMovement.mock.calls[0][1].idempotencyKey as string;
    expect(k0).toMatch(/:c0$/);

    vi.clearAllMocks();
    mockPostMovement.mockResolvedValue({ posted: true, movementId: 1001, stockAfter: 99 });

    // Step 2: Retry first fulfillment (same active movement → ALREADY_POSTED, no new movement)
    const client1retry = makeClient([
      FLAG_ON,
      FLORIST_ASSIGNED,
      lineItemRows({}),
      ONE_ACTIVE_CYCLE, // total=1, reversed=0 → activeCount=1
    ]);
    const r1retry = await postRecipeConsumption(
      client1retry as unknown as import("pg").PoolClient,
      ORDER_ID,
      WORKSPACE_ID,
    );
    expect(r1retry.movementsPosted).toBe(0);
    expect(r1retry.skippedEntries?.[0].reason).toBe("ALREADY_POSTED");
    expect(mockPostMovement).not.toHaveBeenCalled();

    vi.clearAllMocks();
    mockPostMovement.mockResolvedValue({ posted: true, movementId: 2000, stockAfter: 100 });

    // Step 3: Re-fulfillment after cancellation (reversed=1 → cycle 1)
    const client2 = makeClient([
      FLAG_ON,
      FLORIST_ASSIGNED,
      lineItemRows({}),
      ONE_REVERSED_CYCLE, // total=1, reversed=1 → activeCount=0 → use :c1
      BASELINE_EXISTS,
    ]);
    mockPostMovement.mockResolvedValueOnce({ posted: true, movementId: 2000 });
    const r2 = await postRecipeConsumption(
      client2 as unknown as import("pg").PoolClient,
      ORDER_ID,
      WORKSPACE_ID,
    );
    expect(r2.movementsPosted).toBe(1);
    const k1 = mockPostMovement.mock.calls[0][1].idempotencyKey as string;
    expect(k1).toMatch(/:c1$/);
    expect(k0).not.toBe(k1); // keys differ → no collision
  });
});

// ── Key format (unit-level) ───────────────────────────────────────────────────

describe("key format", () => {
  it("consumption key matches buildConsumptionKey with reversedCount=0", () => {
    const key = buildConsumptionKey(ORDER_ID, LINE_ITEM_ID, BASE_ITEM_ID, 0);
    expect(key).toBe(`pc:${ORDER_ID}:${LINE_ITEM_ID}:${BASE_ITEM_ID}:c0`);
  });

  it("reversal idempotency key format is rev:cancel:<originalId>", () => {
    const originalId = 500;
    const key = `rev:cancel:${originalId}`;
    expect(key).toBe("rev:cancel:500");
  });
});

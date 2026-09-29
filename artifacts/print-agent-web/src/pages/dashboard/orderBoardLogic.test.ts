import { describe, it, expect } from "vitest";
import {
  getBoardColumnKey,
  bucketOrdersByColumn,
  compareActiveOrders,
  compareCompletedOrders,
  sortColumnOrders,
  classifyTransition,
  requiresConfirmation,
  isElevatedTransition,
  boardPunctuality,
  boardAreaLabel,
  boardSlotLabel,
  COLUMN_TARGET_STATUS,
  BOARD_COLUMN_KEYS,
} from "./orderBoardLogic";
import { getUrgency, isAtRiskOrder } from "./orderRowHelpers";
import type { OrderRow } from "./orderRowHelpers";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeOrder(overrides: Partial<OrderRow> = {}): OrderRow {
  return {
    id: "order-1",
    display_order_number: "1001",
    external_order_id: null,
    status: "processing",
    source: "manual",
    channel: null,
    ordered_at: "2026-08-10T08:00:00.000Z",
    delivery_type: "standard",
    window_start: "2026-08-10T10:00:00.000Z",
    window_end: "2026-08-10T12:00:00.000Z",
    created_at: "2026-08-10T08:00:00.000Z",
    delivery_address: { district: "Achrafieh", city: "Beirut", slot: "10:00 AM - 12:00 PM" },
    totals: null,
    contact_name: null,
    contact_email: null,
    contact_phone: null,
    payment_status: "paid",
    payment_method: "card",
    driver_first_name: null,
    driver_last_name: null,
    assignment_status: null,
    thumbnail_url: null,
    qr_link: null,
    delivery_date_review: null,
    workshop: null,
    delivered_at: null,
    delivery_timezone: "Asia/Beirut",
    ...overrides,
  };
}

const NOW = Date.parse("2026-08-10T09:00:00.000Z");

describe("delivery schedule classification", () => {
  it("classifies legacy-only orders with the same market day as scheduled", () => {
    const order = makeOrder({
      window_start: null,
      window_end: null,
      ordered_at: "2026-08-01T08:00:00.000Z",
      delivery_address: {
        date: "2026-08-10",
        slot: "10:00 AM - 12:00 PM",
      },
    });

    expect(getUrgency(order, NOW).group).toBe("today");
    expect(isAtRiskOrder(order, NOW)).toBe(false);
  });

  it("does not guess a delivery date from order placement metadata", () => {
    const order = makeOrder({
      window_start: null,
      window_end: null,
      delivery_address: null,
      ordered_at: "2026-08-10T08:00:00.000Z",
    });

    expect(getUrgency(order, NOW).group).toBe("unscheduled");
    expect(isAtRiskOrder(order, NOW)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Column bucketing
// ---------------------------------------------------------------------------

describe("getBoardColumnKey", () => {
  it("maps pending and processing to the processing column", () => {
    expect(getBoardColumnKey("pending")).toBe("processing");
    expect(getBoardColumnKey("processing")).toBe("processing");
  });

  it("maps each remaining lifecycle status to its own column", () => {
    expect(getBoardColumnKey("preparing")).toBe("preparing");
    expect(getBoardColumnKey("ready_for_delivery")).toBe("ready_for_delivery");
    expect(getBoardColumnKey("out_for_delivery")).toBe("out_for_delivery");
    expect(getBoardColumnKey("completed")).toBe("completed");
  });

  it("normalizes case and separator variants before mapping", () => {
    expect(getBoardColumnKey("Ready For Delivery")).toBe("ready_for_delivery");
    expect(getBoardColumnKey("OUT-FOR-DELIVERY")).toBe("out_for_delivery");
  });

  it("returns null for statuses the board does not represent", () => {
    expect(getBoardColumnKey("cancelled")).toBeNull();
    expect(getBoardColumnKey("on_hold")).toBeNull();
    expect(getBoardColumnKey("refunded")).toBeNull();
  });

  it("has a target status for every column that reads back to the same column", () => {
    for (const key of BOARD_COLUMN_KEYS) {
      expect(getBoardColumnKey(COLUMN_TARGET_STATUS[key])).toBe(key);
    }
  });
});

describe("bucketOrdersByColumn", () => {
  it("groups orders by column and drops unrepresented statuses", () => {
    const orders = [
      makeOrder({ id: "a", status: "pending" }),
      makeOrder({ id: "b", status: "processing" }),
      makeOrder({ id: "c", status: "preparing" }),
      makeOrder({ id: "d", status: "cancelled" }),
    ];
    const buckets = bucketOrdersByColumn(orders);
    expect(buckets.processing.map((o) => o.id)).toEqual(["a", "b"]);
    expect(buckets.preparing.map((o) => o.id)).toEqual(["c"]);
    expect(buckets.completed).toEqual([]);
  });

  it("buckets by an optimistic override status when provided", () => {
    const orders = [makeOrder({ id: "a", status: "processing" })];
    const overrides = new Map([["a", "preparing"]]);
    const buckets = bucketOrdersByColumn(orders, overrides);
    expect(buckets.processing).toEqual([]);
    expect(buckets.preparing.map((o) => o.id)).toEqual(["a"]);
  });
});

// ---------------------------------------------------------------------------
// Sorting
// ---------------------------------------------------------------------------

describe("compareActiveOrders", () => {
  it("sorts at-risk (on_hold) orders before non-at-risk orders", () => {
    const atRisk = makeOrder({ id: "risk", status: "on_hold" });
    const normal = makeOrder({ id: "normal", status: "processing" });
    expect(compareActiveOrders(atRisk, normal, NOW)).toBeLessThan(0);
    expect(compareActiveOrders(normal, atRisk, NOW)).toBeGreaterThan(0);
  });

  it("sorts by soonest delivery-window end time when risk is equal", () => {
    const soon = makeOrder({ id: "soon", window_end: "2026-08-10T11:00:00.000Z" });
    const later = makeOrder({ id: "later", window_end: "2026-08-10T14:00:00.000Z" });
    expect(compareActiveOrders(soon, later, NOW)).toBeLessThan(0);
  });

  it("sorts orders with no resolvable window after dated orders", () => {
    const dated = makeOrder({ id: "dated" });
    const undated = makeOrder({
      id: "undated",
      delivery_address: {},
      window_start: null,
      window_end: null,
    });
    expect(compareActiveOrders(dated, undated, NOW)).toBeLessThan(0);
  });
});

describe("compareCompletedOrders", () => {
  it("sorts most-recently-completed first", () => {
    const earlier = makeOrder({ id: "earlier", delivered_at: "2026-08-09T10:00:00.000Z" });
    const later = makeOrder({ id: "later", delivered_at: "2026-08-10T10:00:00.000Z" });
    const sorted = [earlier, later].sort(compareCompletedOrders);
    expect(sorted.map((o) => o.id)).toEqual(["later", "earlier"]);
  });

  it("falls back to created_at, ranked after any dated completion", () => {
    const dated = makeOrder({ id: "dated", delivered_at: "2026-08-10T10:00:00.000Z" });
    const undated = makeOrder({ id: "undated", delivered_at: null, created_at: "2026-08-11T00:00:00.000Z" });
    const sorted = [undated, dated].sort(compareCompletedOrders);
    expect(sorted.map((o) => o.id)).toEqual(["dated", "undated"]);
  });
});

describe("sortColumnOrders", () => {
  it("uses the completed comparator only for the completed column", () => {
    const a = makeOrder({ id: "a", status: "completed", delivered_at: "2026-08-09T10:00:00.000Z" });
    const b = makeOrder({ id: "b", status: "completed", delivered_at: "2026-08-10T10:00:00.000Z" });
    const result = sortColumnOrders("completed", [a, b], NOW);
    expect(result.map((o) => o.id)).toEqual(["b", "a"]);
  });
});

// ---------------------------------------------------------------------------
// Transition classification
// ---------------------------------------------------------------------------

describe("classifyTransition", () => {
  it("classifies a move to the same status as none", () => {
    expect(classifyTransition("processing", "processing")).toBe("none");
  });

  it("classifies pending to processing as forward (distinct stepper steps within one board column)", () => {
    expect(classifyTransition("pending", "processing")).toBe("forward");
  });

  it("classifies moving one step forward as forward", () => {
    expect(classifyTransition("processing", "preparing")).toBe("forward");
  });

  it("classifies skipping a step forward as forward-skip", () => {
    expect(classifyTransition("processing", "out_for_delivery")).toBe("forward-skip");
  });

  it("classifies moving to an earlier step as backward", () => {
    expect(classifyTransition("out_for_delivery", "preparing")).toBe("backward");
  });
});

describe("requiresConfirmation", () => {
  it("requires confirmation entering ready_for_delivery, out_for_delivery, or completed", () => {
    expect(requiresConfirmation("ready_for_delivery", "forward")).toBe(true);
    expect(requiresConfirmation("out_for_delivery", "forward")).toBe(true);
    expect(requiresConfirmation("completed", "forward")).toBe(true);
  });

  it("does not require confirmation for a plain forward move into preparing", () => {
    expect(requiresConfirmation("preparing", "forward")).toBe(false);
  });

  it("always requires confirmation for backward or skip moves", () => {
    expect(requiresConfirmation("preparing", "backward")).toBe(true);
    expect(requiresConfirmation("preparing", "forward-skip")).toBe(true);
  });
});

describe("isElevatedTransition", () => {
  it("flags backward and forward-skip as elevated", () => {
    expect(isElevatedTransition("backward")).toBe(true);
    expect(isElevatedTransition("forward-skip")).toBe(true);
  });

  it("does not flag a plain forward move as elevated", () => {
    expect(isElevatedTransition("forward")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Card display helpers
// ---------------------------------------------------------------------------

describe("boardAreaLabel / boardSlotLabel", () => {
  it("reads district and slot from the delivery address", () => {
    const order = makeOrder({ delivery_address: { district: "Hamra", slot: "2:00 PM - 4:00 PM" } });
    expect(boardAreaLabel(order)).toBe("Hamra");
    expect(boardSlotLabel(order)).toBe("2:00 PM - 4:00 PM");
  });

  it("falls back to city when district is absent", () => {
    const order = makeOrder({ delivery_address: { city: "Dubai" } });
    expect(boardAreaLabel(order)).toBe("Dubai");
  });

  it("returns empty strings when no address fields are present", () => {
    const order = makeOrder({ delivery_address: {} });
    expect(boardAreaLabel(order)).toBe("");
    expect(boardSlotLabel(order)).toBe("");
  });
});

// ---------------------------------------------------------------------------
// Timezone-aware punctuality classification (Lebanon + UAE)
// ---------------------------------------------------------------------------

describe("boardPunctuality — Lebanon (Asia/Beirut)", () => {
  it("classifies on_time delivery within the promised window", () => {
    const order = makeOrder({
      window_start: "2026-08-10T10:00:00.000Z",
      window_end: "2026-08-10T12:00:00.000Z",
      delivered_at: "2026-08-10T11:00:00.000Z",
      delivery_timezone: "Asia/Beirut",
    });
    expect(boardPunctuality(order)?.verdict).toBe("on_time");
  });

  it("classifies a delivery after the window as late", () => {
    const order = makeOrder({
      window_start: "2026-08-10T10:00:00.000Z",
      window_end: "2026-08-10T12:00:00.000Z",
      delivered_at: "2026-08-10T13:30:00.000Z",
      delivery_timezone: "Asia/Beirut",
    });
    expect(boardPunctuality(order)?.verdict).toBe("late");
  });

  it("classifies a delivery before the window as early", () => {
    const order = makeOrder({
      window_start: "2026-08-10T10:00:00.000Z",
      window_end: "2026-08-10T12:00:00.000Z",
      delivered_at: "2026-08-10T09:00:00.000Z",
      delivery_timezone: "Asia/Beirut",
    });
    expect(boardPunctuality(order)?.verdict).toBe("early");
  });
});

describe("boardPunctuality — UAE (Asia/Dubai)", () => {
  it("classifies on_time delivery within the promised window", () => {
    const order = makeOrder({
      window_start: "2026-08-10T06:00:00.000Z",
      window_end: "2026-08-10T08:00:00.000Z",
      delivered_at: "2026-08-10T07:00:00.000Z",
      delivery_timezone: "Asia/Dubai",
    });
    expect(boardPunctuality(order)?.verdict).toBe("on_time");
  });

  it("classifies a delivery after the window as late even across the Dubai UTC+4 offset", () => {
    // 23:30 Dubai time on the 10th is 19:30 UTC — well after an 08:00 UTC window end.
    const order = makeOrder({
      window_start: "2026-08-10T06:00:00.000Z",
      window_end: "2026-08-10T08:00:00.000Z",
      delivered_at: "2026-08-10T19:30:00.000Z",
      delivery_timezone: "Asia/Dubai",
    });
    expect(boardPunctuality(order)?.verdict).toBe("late");
  });
});

describe("boardPunctuality — missing data", () => {
  it("returns unavailable when delivered_at is missing", () => {
    const order = makeOrder({ delivered_at: null });
    expect(boardPunctuality(order)?.verdict).toBe("unavailable");
  });

  it("falls back to UTC when delivery_timezone is empty without throwing", () => {
    const order = makeOrder({ delivery_timezone: "", delivered_at: "2026-08-10T11:00:00.000Z" });
    expect(() => boardPunctuality(order)).not.toThrow();
  });
});

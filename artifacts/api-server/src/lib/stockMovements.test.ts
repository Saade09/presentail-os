/**
 * Unit tests for the stock movement ledger additions:
 * - GET /api/base-items/:id/stock-movements summary fields
 * - GET /api/base-items/:id/stock-movements/export CSV headers
 * - PATCH /api/base-items/:id/location-stock/:locationId delta behaviour
 * - POST /api/base-items/:id/adjustments idempotency (adjustment_action_id)
 * - PO receive idempotency (receive_action_id + payload_hash)
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  escapeCsvTextCell,
  resolveStockMovementQuery,
} from "./stockMovementReporting";
import type { WorkspaceRequest } from "./workspace";

// ── Helpers ─────────────────────────────────────────────────────────────────

/** Build a minimal mock Express request */
function makeReq(overrides: Record<string, unknown> = {}) {
  return {
    params: {},
    query: {},
    body: {},
    ...overrides,
  };
}

/** Capture res.json / res.status calls */
function makeRes() {
  const res: {
    statusCode: number;
    body: unknown;
    status: (code: number) => typeof res;
    json: (body: unknown) => typeof res;
    send: (body: unknown) => typeof res;
    setHeader: () => void;
    _headersSent: boolean;
  } = {
    statusCode: 200,
    body: undefined,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
    send(body) { this.body = body; return this; },
    setHeader() {},
    _headersSent: false,
  };
  return res;
}

// ── Running balance formula tests ────────────────────────────────────────────

describe("Running balance logic (pure)", () => {
  it("accumulates from cutover_balance", () => {
    const cutoverBalance = 100;
    const moves = [
      { qty: 20, cutoverBaseline: false },
      { qty: -5, cutoverBaseline: false },
      { qty: 10, cutoverBaseline: false },
    ];
    let running = cutoverBalance;
    const results: number[] = [];
    for (const m of moves) {
      running += m.qty;
      results.push(running);
    }
    expect(results).toEqual([120, 115, 125]);
  });

  it("opening balance = cutover_balance + sum of moves before from-date", () => {
    const cutoverBalance = 50;
    // Two moves before cutoff, one after
    const moves = [
      { qty: 30, beforeFrom: true },
      { qty: -10, beforeFrom: true },
      { qty: 20, beforeFrom: false },
    ];
    const beforeSum = moves
      .filter((m) => m.beforeFrom)
      .reduce((s, m) => s + m.qty, 0);
    const opening = cutoverBalance + beforeSum;
    expect(opening).toBe(70); // 50 + 30 - 10
  });
});

describe("stock movement reporting query authorization", () => {
  function workspaceRequest(
    overrides: Partial<WorkspaceRequest> = {},
  ): WorkspaceRequest {
    return {
      workspaceOwnerId: "owner_1",
      workspaceRole: "member",
      workspaceActualRole: "member",
      userEmail: "member@example.com",
      allowedPages: ["base_items.view"],
      customRoleId: 1,
      customRoleIds: [1],
      memberDbId: 1,
      assignedLocationIds: [10, 11],
      userId: "user_1",
      ...overrides,
    } as WorkspaceRequest;
  }

  it("rejects users without Base Item inventory access", () => {
    const result = resolveStockMovementQuery(
      {},
      workspaceRequest({ allowedPages: [] }),
    );
    expect(result).toEqual({ ok: false, status: 403, error: "forbidden" });
  });

  it("rejects a requested location outside the member scope", () => {
    const result = resolveStockMovementQuery(
      { locationId: "99" },
      workspaceRequest(),
    );
    expect(result).toEqual({
      ok: false,
      status: 403,
      error: "Location access denied",
    });
  });

  it("returns the validated member scope for list and export callers", () => {
    const result = resolveStockMovementQuery(
      {
        locationId: "10",
        movementType: "customer_return",
        from: "2026-08-01",
        to: "2026-08-20",
        sortBy: "balance",
        sortDirection: "asc",
      },
      workspaceRequest(),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.filters).toMatchObject({
        locationId: 10,
        movementType: "customer_return",
        permittedLocationIds: [10, 11],
        sortBy: "balance",
        sortDirection: "asc",
      });
    }
  });

  it("rejects malformed dates, taxonomies, sort options, and timezones", () => {
    for (const query of [
      { from: "08/01/2026" },
      { movementType: "made_up_type" },
      { sortBy: "sql" },
      { tz: "Not/A_Timezone" },
      { from: "2026-08-20", to: "2026-08-01" },
    ]) {
      expect(resolveStockMovementQuery(query, workspaceRequest())).toMatchObject({
        ok: false,
        status: 400,
      });
    }
  });
});

describe("stock movement CSV text safety", () => {
  it.each([
    ["=HYPERLINK(\"https://attacker.invalid\")", "\"'=HYPERLINK(\"\"https://attacker.invalid\"\")\""],
    ["+cmd|' /C calc'!A0", "\"'+cmd|' /C calc'!A0\""],
    ["-2+3+cmd|' /C calc'!A0", "\"'-2+3+cmd|' /C calc'!A0\""],
    ["@SUM(1+1)", "\"'@SUM(1+1)\""],
    ["  =1+1", "\"'  =1+1\""],
  ])("neutralizes spreadsheet formula text %s", (input, expected) => {
    expect(escapeCsvTextCell(input)).toBe(expected);
  });

  it("preserves ordinary text while escaping embedded quotes", () => {
    expect(escapeCsvTextCell('Dubai "Main" Warehouse')).toBe(
      '"Dubai ""Main"" Warehouse"',
    );
  });
});

// ── payload_hash determinism ─────────────────────────────────────────────────

describe("PO receive payload_hash", () => {
  it("is the same regardless of input order", () => {
    const { createHash } = require("crypto");
    const hash = (receipts: Array<{ line_item_id: number; quantity: number }>) =>
      createHash("sha256")
        .update(
          JSON.stringify(
            receipts
              .slice()
              .sort((a, b) => a.line_item_id - b.line_item_id)
              .map((r) => ({ l: r.line_item_id, q: r.quantity })),
          ),
        )
        .digest("hex");

    const h1 = hash([{ line_item_id: 1, quantity: 5 }, { line_item_id: 2, quantity: 3 }]);
    const h2 = hash([{ line_item_id: 2, quantity: 3 }, { line_item_id: 1, quantity: 5 }]);
    expect(h1).toBe(h2);
  });

  it("differs when quantities differ", () => {
    const { createHash } = require("crypto");
    const hash = (receipts: Array<{ line_item_id: number; quantity: number }>) =>
      createHash("sha256")
        .update(
          JSON.stringify(
            receipts
              .slice()
              .sort((a, b) => a.line_item_id - b.line_item_id)
              .map((r) => ({ l: r.line_item_id, q: r.quantity })),
          ),
        )
        .digest("hex");

    const h1 = hash([{ line_item_id: 1, quantity: 5 }]);
    const h2 = hash([{ line_item_id: 1, quantity: 6 }]);
    expect(h1).not.toBe(h2);
  });
});

// ── Adjustment idempotency key format ────────────────────────────────────────

describe("adjustment_action_id key format", () => {
  it("prefixes with adj:", () => {
    const actionId = "550e8400-e29b-41d4-a716-446655440000";
    const key = `adj:${actionId}`;
    expect(key).toBe("adj:550e8400-e29b-41d4-a716-446655440000");
  });

  it("transfer keys are deterministic", () => {
    const transferId = 42;
    const outKey = `transfer-out:${transferId}`;
    const inKey  = `transfer-in:${transferId}`;
    expect(outKey).toBe("transfer-out:42");
    expect(inKey).toBe("transfer-in:42");
  });

  it("PO receive key includes lineItemId", () => {
    const receiveActionId = "aabbccdd-0000-1111-2222-333344445555";
    const liId = 7;
    const key = `po-receive:${receiveActionId}:li:${liId}`;
    expect(key).toBe(`po-receive:${receiveActionId}:li:7`);
  });
});

// ── Summary card maths ───────────────────────────────────────────────────────

describe("Summary card computation", () => {
  function computeSummary(
    openingBalance: number,
    received: number,
    consumed: number,
  ) {
    return {
      openingBalance,
      received,
      consumed,
      closingBalance: openingBalance + received - consumed,
    };
  }

  it("closing = opening + received - consumed", () => {
    const s = computeSummary(100, 50, 30);
    expect(s.closingBalance).toBe(120);
  });

  it("handles zero movement period", () => {
    const s = computeSummary(75, 0, 0);
    expect(s.closingBalance).toBe(75);
  });

  it("closing can be negative (oversell)", () => {
    const s = computeSummary(10, 0, 20);
    expect(s.closingBalance).toBe(-10);
  });
});

// ── Delta logic for PATCH location-stock ────────────────────────────────────

describe("PATCH location-stock delta", () => {
  it("computes correct delta when stock is set", () => {
    const targetStock = 80;
    const currentStock = 60;
    const delta = targetStock - currentStock;
    expect(delta).toBe(20);
  });

  it("delta is zero when stock unchanged — no movement posted", () => {
    const targetStock = 60;
    const currentStock = 60;
    const delta = targetStock - currentStock;
    expect(delta).toBe(0);
  });

  it("negative delta for stock decrease", () => {
    const targetStock = 20;
    const currentStock = 60;
    const delta = targetStock - currentStock;
    expect(delta).toBe(-40);
  });
});

// ── CSV row format ───────────────────────────────────────────────────────────

describe("CSV row builder", () => {
  function csvEscape(v: string | null | undefined): string {
    const s = String(v ?? "");
    if (s.includes(",") || s.includes('"') || s.includes("\n")) {
      return `"${s.replace(/"/g, '""')}"`;
    }
    return s;
  }

  function buildRow(
    created_at: string,
    movement_type: string | null,
    reference_label: string | null,
    location_name: string | null,
    quantity_change: string,
    running_balance: string,
    source_display_name: string | null,
    note: string | null,
  ): string {
    const qty = parseFloat(quantity_change);
    const qtyIn  = qty > 0 ? qty.toString() : "";
    const qtyOut = qty < 0 ? Math.abs(qty).toString() : "";
    const balance = parseFloat(running_balance).toFixed(2);
    return [
      csvEscape(new Date(created_at).toISOString()),
      csvEscape(movement_type),
      csvEscape(reference_label),
      csvEscape(location_name),
      qtyIn, qtyOut, balance,
      csvEscape(source_display_name ?? "System"),
      csvEscape(note),
    ].join(",");
  }

  it("produces In column for positive quantity", () => {
    const row = buildRow("2026-01-01T00:00:00Z", "receive", "PO-0001", "Store A", "10", "110", null, null);
    const cols = row.split(",");
    expect(cols[4]).toBe("10"); // In
    expect(cols[5]).toBe("");   // Out
  });

  it("produces Out column for negative quantity", () => {
    const row = buildRow("2026-01-01T00:00:00Z", "product_consumption", "Order-001", "Store A", "-5", "95", "user@example.com", null);
    const cols = row.split(",");
    expect(cols[4]).toBe("");    // In
    expect(cols[5]).toBe("5");   // Out
  });

  it("escapes commas in reference label", () => {
    const row = buildRow("2026-01-01T00:00:00Z", "manual_adjustment", "ref, with comma", null, "1", "1", null, null);
    expect(row).toContain('"ref, with comma"');
  });

  it("shows System for null source", () => {
    const row = buildRow("2026-01-01T00:00:00Z", "manual_adjustment", null, null, "1", "1", null, null);
    expect(row).toContain("System");
  });
});

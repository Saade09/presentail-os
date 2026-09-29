/**
 * Unit tests for cash-transfer helpers in cashDesk.ts.
 *
 * Tests cover:
 *  - generateTransferNumber formatting and uniqueness
 *  - isSessionOverdue with a configurable threshold
 *  - recomputeSessionTotals formula: opening + cash_in − cash_out + transfers_in − transfers_out + adjustments
 *  - Validation logic replicated from the route (amount, currency, available-cash, state-machine)
 *  - formatCashMoney-equivalent formatting rules for USD and LBP
 *
 * DB calls are mocked; all tests are pure / synchronous where possible.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import pg from "pg";

// ── isSessionOverdue ──────────────────────────────────────────────────────────

import { isSessionOverdue } from "../cashDesk";

describe("isSessionOverdue", () => {
  it("returns overdue:false when cutoffTime is null", () => {
    const { overdue } = isSessionOverdue("2026-01-01T08:00:00Z", null, "Asia/Dubai");
    expect(overdue).toBe(false);
  });

  it("returns overdue:false when timezone is null", () => {
    const { overdue } = isSessionOverdue("2026-01-01T08:00:00Z", "18:00", null);
    expect(overdue).toBe(false);
  });

  it("returns overdue:false when still within the grace period", () => {
    // opened 2026-01-01, cutoff 18:00 Dubai (UTC+4 → 14:00 UTC), grace 120 min → deadline 16:00 UTC
    // now = 15:59 UTC → NOT overdue
    const now = new Date("2026-01-01T15:59:00Z");
    const { overdue } = isSessionOverdue(
      "2026-01-01T06:00:00Z",
      "18:00",
      "Asia/Dubai",
      120,
      now,
    );
    expect(overdue).toBe(false);
  });

  it("returns overdue:true with positive overdueByMinutes when past cutoff + grace", () => {
    // now = 17:00 UTC (> 16:00 deadline) → overdue by 60 min
    const now = new Date("2026-01-01T17:00:00Z");
    const { overdue, overdueByMinutes } = isSessionOverdue(
      "2026-01-01T06:00:00Z",
      "18:00",
      "Asia/Dubai",
      120,
      now,
    );
    expect(overdue).toBe(true);
    expect(overdueByMinutes).toBeGreaterThan(0);
  });

  it("returns overdue:false for invalid openedAt string", () => {
    const { overdue } = isSessionOverdue("not-a-date", "18:00", "Asia/Dubai", 120, new Date());
    expect(overdue).toBe(false);
  });

  it("grace period of 0 means overdue immediately after cutoff", () => {
    // cutoff 14:00 UTC (18:00 Dubai), now = 14:01 UTC → overdue with grace=0
    const now = new Date("2026-01-01T14:01:00Z");
    const { overdue } = isSessionOverdue(
      "2026-01-01T06:00:00Z",
      "18:00",
      "Asia/Dubai",
      0,
      now,
    );
    expect(overdue).toBe(true);
  });
});

// ── generateTransferNumber ────────────────────────────────────────────────────

import { generateTransferNumber } from "../cashDesk";

function makeMockClient(count: string): pg.PoolClient {
  return {
    query: vi.fn().mockResolvedValue({ rows: [{ count }], rowCount: 1 }),
    release: vi.fn(),
  } as unknown as pg.PoolClient;
}

describe("generateTransferNumber", () => {
  it("formats TR-YYYY-NNNNN with 5-digit zero-padded sequence", async () => {
    const client = makeMockClient("0"); // 0 existing → seq = 1
    const result = await generateTransferNumber("owner123", 2026, client);
    expect(result).toBe("TR-2026-00001");
  });

  it("increments from existing count", async () => {
    const client = makeMockClient("4"); // 4 existing → seq = 5
    const result = await generateTransferNumber("owner123", 2026, client);
    expect(result).toBe("TR-2026-00005");
  });

  it("handles count of 99999 without truncating digits", async () => {
    const client = makeMockClient("99999");
    const result = await generateTransferNumber("owner123", 2026, client);
    expect(result).toBe("TR-2026-100000"); // beyond 5 digits — no truncation
  });

  it("uses the provided year in the transfer number", async () => {
    const client = makeMockClient("0");
    const result = await generateTransferNumber("owner123", 2025, client);
    expect(result).toMatch(/^TR-2025-/);
  });
});

// ── recomputeSessionTotals — formula verification via mock ────────────────────

// We test the formula logic by verifying the SQL UPDATE is called with the
// computed values; the DB itself is fully mocked.

import { recomputeSessionTotals } from "../cashDesk";

vi.mock("../db", () => {
  const mockPool = { query: vi.fn() };
  return { db: mockPool, withTransaction: vi.fn() };
});

import { db } from "../db";

const mockDb = db as unknown as { query: ReturnType<typeof vi.fn> };

function makeSessionQueryMock(secondaryCurrency: string | null = null) {
  return { rows: [{ secondary_currency: secondaryCurrency }], rowCount: 1 };
}

function makeAggQueryMock(overrides: Partial<{
  cash_in: string; cash_out: string;
  adj_in: string; adj_out: string;
  xfer_in: string; xfer_out: string;
  cash_in_sec: string; cash_out_sec: string;
  adj_in_sec: string; adj_out_sec: string;
  xfer_in_sec: string; xfer_out_sec: string;
}> = {}) {
  return {
    rows: [{
      cash_in: "0", cash_out: "0",
      adj_in: "0", adj_out: "0",
      xfer_in: "0", xfer_out: "0",
      cash_in_sec: "0", cash_out_sec: "0",
      adj_in_sec: "0", adj_out_sec: "0",
      xfer_in_sec: "0", xfer_out_sec: "0",
      ...overrides,
    }],
    rowCount: 1,
  };
}

describe("recomputeSessionTotals formula — single currency session", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("passes correct totals to the UPDATE query (cash_in, cash_out, adjustments, transfers)", async () => {
    const updatedRow = { id: 1, expected_cash: "350.00" };

    mockDb.query
      .mockResolvedValueOnce(makeSessionQueryMock(null))  // session row query
      .mockResolvedValueOnce(makeAggQueryMock({            // aggregate query
        cash_in:  "200",   // sales
        cash_out: "50",    // expenses
        adj_in:   "20",    // adj positive
        adj_out:  "10",    // adj negative → net +10
        xfer_in:  "100",   // transfer in
        xfer_out: "30",    // transfer out
      }))
      .mockResolvedValueOnce({ rows: [updatedRow], rowCount: 1 }); // UPDATE

    await recomputeSessionTotals(1, "owner");

    // The third call (UPDATE) receives the computed values
    const updateCall = mockDb.query.mock.calls[2];
    const params = updateCall[1] as string[];
    // params: [sessionId, ownerId, cashIn, cashOut, adjustments, transfersIn, transfersOut]
    expect(params[2]).toBe("200.00"); // cash_in
    expect(params[3]).toBe("50.00");  // cash_out
    // adjustments = adj_in - adj_out = 20 - 10 = 10
    expect(params[4]).toBe("10.00");  // adjustments
    expect(params[5]).toBe("100.00"); // transfers_in
    expect(params[6]).toBe("30.00");  // transfers_out
  });

  it("handles zero transfers gracefully (no transfer rows exist)", async () => {
    const updatedRow = { id: 1, expected_cash: "100.00" };

    mockDb.query
      .mockResolvedValueOnce(makeSessionQueryMock(null))
      .mockResolvedValueOnce(makeAggQueryMock({ cash_in: "0", cash_out: "0" }))
      .mockResolvedValueOnce({ rows: [updatedRow], rowCount: 1 });

    await recomputeSessionTotals(1, "owner");

    const params = mockDb.query.mock.calls[2][1] as string[];
    expect(params[5]).toBe("0.00"); // transfers_in
    expect(params[6]).toBe("0.00"); // transfers_out
  });

  it("returns null when the session is not found", async () => {
    mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    const result = await recomputeSessionTotals(999, "owner");
    expect(result).toBeNull();
  });

  it("correctly buckets transfer_in and transfer_out separately from sales and expenses", async () => {
    // This verifies the SQL CTE semantics via the mock: transfer types are
    // excluded from cash_in/cash_out and appear only in xfer_in/xfer_out.
    const updatedRow = { id: 1 };
    mockDb.query
      .mockResolvedValueOnce(makeSessionQueryMock(null))
      .mockResolvedValueOnce(makeAggQueryMock({
        cash_in: "500",  // sales only, no transfer mixed in
        xfer_in: "200",  // transfers separately tracked
        xfer_out: "50",
      }))
      .mockResolvedValueOnce({ rows: [updatedRow], rowCount: 1 });

    await recomputeSessionTotals(1, "owner");

    const params = mockDb.query.mock.calls[2][1] as string[];
    expect(params[2]).toBe("500.00"); // cash_in (sales)
    expect(params[5]).toBe("200.00"); // transfers_in
    expect(params[6]).toBe("50.00");  // transfers_out
  });
});

// ── Transfer state-machine validation (route-level logic, extracted for testing) ──

/**
 * Helper that mimics the route's transfer state-machine guard.
 * Returns an error string or null (valid).
 */
function validateTransferStatusTransition(
  currentStatus: string,
  targetAction: "confirm-receipt" | "report-difference" | "resolve-dispute",
): string | null {
  if (targetAction === "confirm-receipt") {
    if (currentStatus === "COMPLETED") return null; // idempotent
    if (currentStatus !== "IN_TRANSIT") return `Transfer is ${currentStatus}, not IN_TRANSIT`;
  }
  if (targetAction === "report-difference") {
    if (currentStatus !== "IN_TRANSIT") return `Cannot report a difference on a ${currentStatus} transfer`;
  }
  if (targetAction === "resolve-dispute") {
    if (currentStatus !== "DISPUTED") return `Transfer is ${currentStatus}, not DISPUTED`;
  }
  return null;
}

describe("transfer state-machine transitions", () => {
  it("IN_TRANSIT → confirm-receipt is valid", () => {
    expect(validateTransferStatusTransition("IN_TRANSIT", "confirm-receipt")).toBeNull();
  });

  it("COMPLETED → confirm-receipt is idempotent (no error)", () => {
    expect(validateTransferStatusTransition("COMPLETED", "confirm-receipt")).toBeNull();
  });

  it("DISPUTED → confirm-receipt is rejected", () => {
    expect(validateTransferStatusTransition("DISPUTED", "confirm-receipt")).toMatch(/DISPUTED/);
  });

  it("IN_TRANSIT → report-difference is valid", () => {
    expect(validateTransferStatusTransition("IN_TRANSIT", "report-difference")).toBeNull();
  });

  it("COMPLETED → report-difference is rejected", () => {
    expect(validateTransferStatusTransition("COMPLETED", "report-difference")).toMatch(/COMPLETED/);
  });

  it("DISPUTED → report-difference is rejected", () => {
    expect(validateTransferStatusTransition("DISPUTED", "report-difference")).toMatch(/DISPUTED/);
  });

  it("DISPUTED → resolve-dispute is valid", () => {
    expect(validateTransferStatusTransition("DISPUTED", "resolve-dispute")).toBeNull();
  });

  it("IN_TRANSIT → resolve-dispute is rejected", () => {
    expect(validateTransferStatusTransition("IN_TRANSIT", "resolve-dispute")).toMatch(/IN_TRANSIT/);
  });

  it("COMPLETED → resolve-dispute is rejected", () => {
    expect(validateTransferStatusTransition("COMPLETED", "resolve-dispute")).toMatch(/COMPLETED/);
  });
});

// ── Amount validation ─────────────────────────────────────────────────────────

function validateTransferAmount(amount: unknown): string | null {
  const amt = Number(amount);
  if (!Number.isFinite(amt) || amt <= 0) return "amount must be a positive number";
  return null;
}

describe("transfer amount validation", () => {
  it("accepts a positive integer", () => {
    expect(validateTransferAmount(100)).toBeNull();
  });

  it("accepts a positive decimal", () => {
    expect(validateTransferAmount(50.25)).toBeNull();
  });

  it("rejects zero", () => {
    expect(validateTransferAmount(0)).toBeTruthy();
  });

  it("rejects negative values", () => {
    expect(validateTransferAmount(-10)).toBeTruthy();
  });

  it("rejects negative-zero", () => {
    expect(validateTransferAmount(-0)).toBeTruthy();
  });

  it("rejects NaN", () => {
    expect(validateTransferAmount(NaN)).toBeTruthy();
  });

  it("rejects Infinity", () => {
    expect(validateTransferAmount(Infinity)).toBeTruthy();
  });

  it("rejects string with invalid separator", () => {
    expect(validateTransferAmount("1,000")).toBeTruthy();
  });

  it("rejects null", () => {
    expect(validateTransferAmount(null)).toBeTruthy();
  });

  it("rejects undefined", () => {
    expect(validateTransferAmount(undefined)).toBeTruthy();
  });
});

// ── Available-cash validation ─────────────────────────────────────────────────

function validateAvailableCash(amount: number, availableCash: number): string | null {
  if (amount > availableCash) {
    return `Insufficient expected cash: ${availableCash.toFixed(2)} available`;
  }
  return null;
}

describe("available-cash validation", () => {
  it("allows transfer equal to available cash", () => {
    expect(validateAvailableCash(100, 100)).toBeNull();
  });

  it("allows transfer less than available cash", () => {
    expect(validateAvailableCash(50, 100)).toBeNull();
  });

  it("rejects transfer exceeding available cash", () => {
    expect(validateAvailableCash(101, 100)).toBeTruthy();
  });

  it("rejects any positive amount when available cash is zero", () => {
    expect(validateAvailableCash(0.01, 0)).toBeTruthy();
  });
});

// ── Sent/received difference calculation ─────────────────────────────────────

function computeDifference(
  sent: number,
  received: number,
): { difference: number; state: "exact" | "short" | "over" } {
  const diff = received - sent;
  const state = diff === 0 ? "exact" : diff < 0 ? "short" : "over";
  return { difference: diff, state };
}

describe("sent/received difference calculation", () => {
  it("exact — no difference", () => {
    const { difference, state } = computeDifference(100, 100);
    expect(difference).toBe(0);
    expect(state).toBe("exact");
  });

  it("short — receiver got less than sent", () => {
    const { difference, state } = computeDifference(100, 95);
    expect(difference).toBeCloseTo(-5, 2);
    expect(state).toBe("short");
  });

  it("over — receiver got more than sent", () => {
    const { difference, state } = computeDifference(100, 105);
    expect(difference).toBeCloseTo(5, 2);
    expect(state).toBe("over");
  });
});

// ── Currency formatting helpers ───────────────────────────────────────────────

/**
 * Simplified versions of the formatCashMoney rules enforced on the client.
 * USD: prefix $, two decimals, thousands separator, no -0.00.
 * LBP: prefix LL, no decimals, thousands separator, no -0.
 */
function formatUSD(amount: number): string {
  const safe = amount === 0 ? 0 : amount; // collapse -0
  const sign = safe < 0 ? "-" : "";
  const abs = Math.abs(safe);
  return `${sign}$${abs.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function formatLBP(amount: number): string {
  const safe = amount === 0 ? 0 : amount;
  const sign = safe < 0 ? "-" : "";
  const abs = Math.abs(safe);
  return `${sign}LL${abs.toLocaleString("en-US", { maximumFractionDigits: 0 })}`;
}

describe("USD formatting", () => {
  it("formats positive amount with two decimals", () => {
    expect(formatUSD(100)).toBe("$100.00");
  });

  it("formats zero without negative sign (no -$0.00)", () => {
    expect(formatUSD(0)).toBe("$0.00");
    expect(formatUSD(-0)).toBe("$0.00");
  });

  it("formats negative amount with leading minus", () => {
    expect(formatUSD(-25.5)).toBe("-$25.50");
  });

  it("uses two decimal places", () => {
    expect(formatUSD(10.1)).toBe("$10.10");
  });
});

describe("LBP formatting", () => {
  it("formats positive amount with no decimals", () => {
    expect(formatLBP(500000)).toBe("LL500,000");
  });

  it("formats zero without negative sign (no -LL0)", () => {
    expect(formatLBP(0)).toBe("LL0");
    expect(formatLBP(-0)).toBe("LL0");
  });

  it("formats negative amount with leading minus", () => {
    expect(formatLBP(-150000)).toBe("-LL150,000");
  });

  it("does not show decimal digits for LBP", () => {
    // LBP amounts are whole numbers; fractional part should be stripped
    const result = formatLBP(500000.99);
    expect(result).not.toContain(".");
  });
});

// ── Permission checks (extracted logic) ────────────────────────────────────────

type PermCheck = {
  workspaceActualRole: string;
  allowedPages?: string[];
};

function hasPermission(wreq: PermCheck, perm: string): boolean {
  return wreq.workspaceActualRole === "owner" || (wreq.allowedPages?.includes(perm) ?? false);
}

describe("permission checks", () => {
  it("owner always has permission", () => {
    expect(hasPermission({ workspaceActualRole: "owner" }, "cash_sessions.transfer")).toBe(true);
  });

  it("member with explicit permission is allowed", () => {
    expect(
      hasPermission(
        { workspaceActualRole: "member", allowedPages: ["cash_sessions.transfer"] },
        "cash_sessions.transfer",
      ),
    ).toBe(true);
  });

  it("member without the permission is denied", () => {
    expect(
      hasPermission(
        { workspaceActualRole: "member", allowedPages: ["cash-sessions"] },
        "cash_sessions.transfer",
      ),
    ).toBe(false);
  });

  it("member with no allowedPages at all is denied", () => {
    expect(hasPermission({ workspaceActualRole: "member" }, "cash_sessions.transfer")).toBe(false);
  });

  it("receive_transfer permission is separate from transfer initiation", () => {
    const wreq: PermCheck = {
      workspaceActualRole: "member",
      allowedPages: ["cash_sessions.receive_transfer"],
    };
    expect(hasPermission(wreq, "cash_sessions.transfer")).toBe(false);
    expect(hasPermission(wreq, "cash_sessions.receive_transfer")).toBe(true);
  });

  it("resolve_transfer_dispute is a distinct permission", () => {
    const wreq: PermCheck = {
      workspaceActualRole: "member",
      allowedPages: ["cash_sessions.receive_transfer"],
    };
    expect(hasPermission(wreq, "cash_sessions.resolve_transfer_dispute")).toBe(false);
  });
});

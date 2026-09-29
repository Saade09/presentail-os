import { describe, it, expect } from "vitest";
import {
  type SessionRow,
  DEFAULT_FILTERS,
  computeKpis,
  computeCashHeldByCurrency,
  computeNeedsAttention,
  applyFilters,
  sortSessions,
  primaryAction,
  findMyOpenSession,
  formatMoney,
  formatDateTime,
  formatOpenDuration,
  heldAmount,
  canManageCashSessionLifecycle,
  resolvePresetRange,
  LONG_OPEN_THRESHOLD_MS,
} from "./cashSessionsDashboard";

const NOW = new Date("2026-07-16T15:00:00Z");

function row(overrides: Partial<SessionRow>): SessionRow {
  return {
    id: 1,
    session_number: "CS-ACH-2026-0001",
    drawer_name: "Achrafieh Main",
    drawer_code: "ACH",
    location_name: "Achrafieh",
    opened_by_clerk_id: "user_a",
    opened_by_name: "Adnan Ammache",
    closed_by_name: null,
    approved_by_name: null,
    currency: "USD",
    status: "open",
    opening_cash: "100.00",
    expected_cash: "712.00",
    actual_cash: null,
    difference: null,
    opened_at: "2026-07-16T10:00:00Z",
    closed_at: null,
    ...overrides,
  };
}

describe("formatting", () => {
  it("formats money with currency prefix and em dash for missing", () => {
    expect(formatMoney("712", "USD")).toBe("USD 712.00");
    expect(formatMoney(24500000, "LBP")).toBe("LBP 24,500,000");
    expect(formatMoney(null)).toBe("—");
  });

  it("formats readable dates", () => {
    expect(formatDateTime("2026-07-16T15:16:00")).toBe("16 Jul 2026, 3:16 PM");
    expect(formatDateTime(null)).toBe("—");
  });

  it("formats open duration", () => {
    expect(formatOpenDuration("2026-07-16T06:18:00Z", NOW)).toBe("8h 42m");
    expect(formatOpenDuration("2026-07-16T14:30:00Z", NOW)).toBe("30m");
  });

  it("held amount falls back from expected to opening cash", () => {
    expect(heldAmount(row({ expected_cash: "712.00" }))).toBe(712);
    expect(heldAmount(row({ expected_cash: null, opening_cash: "100.00" }))).toBe(100);
  });
});

describe("cash session lifecycle permissions", () => {
  it("shows both open and close controls to a member with Cash Sessions page access", () => {
    expect(canManageCashSessionLifecycle(false, ["cash-sessions"], "open")).toBe(true);
    expect(canManageCashSessionLifecycle(false, ["cash-sessions"], "close")).toBe(true);
  });

  it("continues supporting explicit legacy action permissions without granting unrelated actions", () => {
    expect(canManageCashSessionLifecycle(false, ["cash_sessions.open"], "open")).toBe(true);
    expect(canManageCashSessionLifecycle(false, ["cash_sessions.open"], "close")).toBe(false);
  });
});

describe("computeKpis", () => {
  const sessions = [
    row({ id: 1, status: "open", currency: "USD", expected_cash: "712.00" }),
    row({ id: 2, status: "open", currency: "LBP", expected_cash: "24500000" }),
    row({
      id: 3,
      status: "pending_review",
      difference: "0.00",
      closed_at: "2026-07-10T12:00:00Z",
    }),
    row({
      id: 4,
      status: "flagged",
      difference: "-15.00",
      closed_at: "2026-07-12T12:00:00Z",
    }),
    row({
      id: 5,
      status: "approved",
      difference: "5.00",
      closed_at: "2026-04-01T12:00:00Z", // outside 30-day window
    }),
  ];

  it("counts statuses and splits held cash by currency", () => {
    const k = computeKpis(sessions, NOW);
    expect(k.openCount).toBe(2);
    expect(k.pendingCount).toBe(1);
    expect(k.flaggedCount).toBe(1);
    expect(k.openHeldByCurrency).toEqual([
      { currency: "LBP", amount: 24500000, count: 1 },
      { currency: "USD", amount: 712, count: 1 },
    ]);
    expect(k.flaggedDiffByCurrency).toEqual([{ currency: "USD", amount: -15, count: 1 }]);
  });

  it("scopes total difference to the last 30 days", () => {
    const k = computeKpis(sessions, NOW);
    expect(k.differenceByCurrency).toEqual([{ currency: "USD", amount: -15, count: 2 }]);
  });
});

describe("computeCashHeldByCurrency", () => {
  it("only counts open sessions, one row per currency, no conversion", () => {
    const held = computeCashHeldByCurrency([
      row({ id: 1, status: "open", currency: "USD", expected_cash: "500" }),
      row({ id: 2, status: "open", currency: "USD", expected_cash: "212" }),
      row({ id: 3, status: "open", currency: "LBP", expected_cash: "24500000" }),
      row({ id: 4, status: "approved", currency: "USD", actual_cash: "999" }),
    ]);
    expect(held).toEqual([
      { currency: "LBP", amount: 24500000, count: 1 },
      { currency: "USD", amount: 712, count: 2 },
    ]);
  });
});

describe("computeNeedsAttention", () => {
  it("classifies shortage, overage, pending, long-open and closed-no-count, most urgent first", () => {
    const items = computeNeedsAttention(
      [
        row({ id: 1, status: "open", opened_at: new Date(NOW.getTime() - LONG_OPEN_THRESHOLD_MS - 60000).toISOString() }),
        row({ id: 2, status: "open", opened_at: NOW.toISOString() }),
        row({ id: 3, status: "pending_review", difference: "-15.00" }),
        row({ id: 4, status: "pending_review", difference: "0.00" }),
        row({ id: 5, status: "flagged", difference: "20.00" }),
        row({ id: 6, status: "approved", closed_at: "2026-07-15T10:00:00Z", actual_cash: null }),
        row({ id: 7, status: "approved", closed_at: "2026-07-15T10:00:00Z", actual_cash: "100" }),
      ],
      NOW,
    );
    expect(items.map((i) => [i.session.id, i.kind])).toEqual([
      [3, "shortage"],
      [5, "overage"],
      [4, "pending_review"],
      [6, "closed_no_count"],
      [1, "long_open"],
    ]);
  });
});

describe("applyFilters", () => {
  const sessions = [
    row({ id: 1, status: "open", drawer_name: "Achrafieh Main", opened_by_name: "Adnan", currency: "USD" }),
    row({ id: 2, status: "approved", drawer_name: "Jdeideh Counter", opened_by_name: "Maya", currency: "LBP", difference: "0.00", closed_at: "2026-07-15T10:00:00Z", actual_cash: "5" }),
    row({ id: 3, status: "flagged", drawer_name: "Zalka", opened_by_name: "Ahmad", currency: "USD", difference: "-15.00", opened_at: "2026-07-01T09:00:00Z" }),
  ];

  it("filters by status, drawer, operator, currency", () => {
    expect(applyFilters(sessions, { ...DEFAULT_FILTERS, status: "open" }, NOW).map((s) => s.id)).toEqual([1]);
    expect(applyFilters(sessions, { ...DEFAULT_FILTERS, drawer: "Zalka" }, NOW).map((s) => s.id)).toEqual([3]);
    expect(applyFilters(sessions, { ...DEFAULT_FILTERS, operator: "Maya" }, NOW).map((s) => s.id)).toEqual([2]);
    expect(applyFilters(sessions, { ...DEFAULT_FILTERS, currency: "LBP" }, NOW).map((s) => s.id)).toEqual([2]);
  });

  it("supports the attention and difference pseudo-statuses", () => {
    expect(applyFilters(sessions, { ...DEFAULT_FILTERS, status: "attention" }, NOW).map((s) => s.id)).toEqual([3]);
    expect(applyFilters(sessions, { ...DEFAULT_FILTERS, status: "difference" }, NOW).map((s) => s.id)).toEqual([3]);
  });

  it("searches session number, drawer and operator (partial, case-insensitive)", () => {
    expect(applyFilters(sessions, { ...DEFAULT_FILTERS, q: "cs-ach" }, NOW).length).toBe(3);
    expect(applyFilters(sessions, { ...DEFAULT_FILTERS, q: "jdeideh" }, NOW).map((s) => s.id)).toEqual([2]);
    expect(applyFilters(sessions, { ...DEFAULT_FILTERS, q: "ahmad" }, NOW).map((s) => s.id)).toEqual([3]);
    expect(applyFilters(sessions, { ...DEFAULT_FILTERS, q: "nomatch" }, NOW)).toEqual([]);
  });

  it("filters by date preset and custom range", () => {
    const today = applyFilters(sessions, { ...DEFAULT_FILTERS, preset: "today" }, NOW);
    expect(today.map((s) => s.id).sort()).toEqual([1, 2]);
    const custom = applyFilters(
      sessions,
      { ...DEFAULT_FILTERS, preset: "custom", from: "2026-07-01", to: "2026-07-02" },
      NOW,
    );
    expect(custom.map((s) => s.id)).toEqual([3]);
  });
});

describe("resolvePresetRange", () => {
  it("returns nulls for all-time and honors custom bounds", () => {
    expect(resolvePresetRange("all", "", "", NOW)).toEqual({ from: null, to: null });
    const r = resolvePresetRange("custom", "2026-07-01", "2026-07-02", NOW);
    expect(r.from?.getDate()).toBe(1);
    expect(r.to?.getDate()).toBe(3); // exclusive end = day after
  });

  it("ignores invalid custom dates", () => {
    const r = resolvePresetRange("custom", "bogus", "", NOW);
    expect(r.from).toBeNull();
    expect(r.to).toBeNull();
  });
});

describe("sortSessions", () => {
  const sessions = [
    row({ id: 1, opened_at: "2026-07-10T10:00:00Z", status: "approved", difference: "5.00" }),
    row({ id: 2, opened_at: "2026-07-12T10:00:00Z", status: "open", difference: null }),
    row({ id: 3, opened_at: "2026-07-11T10:00:00Z", status: "flagged", difference: "-15.00" }),
  ];

  it("sorts by opened date, status order and difference", () => {
    expect(sortSessions(sessions, "opened_at", "desc").map((s) => s.id)).toEqual([2, 3, 1]);
    expect(sortSessions(sessions, "status", "asc").map((s) => s.id)).toEqual([2, 3, 1]);
    expect(sortSessions(sessions, "difference", "asc").map((s) => s.id)).toEqual([2, 3, 1]);
  });
});

describe("primaryAction / findMyOpenSession", () => {
  it("picks the contextual action by status and permission", () => {
    expect(primaryAction("open", true, true)).toBe("close");
    expect(primaryAction("open", false, true)).toBe("view");
    expect(primaryAction("pending_review", true, true)).toBe("review");
    expect(primaryAction("pending_review", true, false)).toBe("view");
    expect(primaryAction("flagged", true, true)).toBe("investigate");
    expect(primaryAction("approved", true, true)).toBe("view");
  });

  it("finds the current user's most recent open session", () => {
    const sessions = [
      row({ id: 1, status: "open", opened_by_clerk_id: "user_a", opened_at: "2026-07-16T08:00:00Z" }),
      row({ id: 2, status: "open", opened_by_clerk_id: "user_a", opened_at: "2026-07-16T12:00:00Z" }),
      row({ id: 3, status: "open", opened_by_clerk_id: "user_b" }),
      row({ id: 4, status: "approved", opened_by_clerk_id: "user_a" }),
    ];
    expect(findMyOpenSession(sessions, "user_a")?.id).toBe(2);
    expect(findMyOpenSession(sessions, "user_c")).toBeNull();
    expect(findMyOpenSession(sessions, null)).toBeNull();
  });
});

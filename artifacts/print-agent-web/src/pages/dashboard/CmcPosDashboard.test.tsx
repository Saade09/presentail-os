/**
 * Unit tests for CMC POS Dashboard — helpers and component rendering.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Router } from "wouter";

// ── Pure helper tests ────────────────────────────────────────────────────

import {
  formatUsd,
  formatLbp,
  formatAmount,
  deriveHealthSeverity,
  healthMessage,
  activityStatusLabel,
  activityTypeLabel,
  statusBadgeClasses,
  computeTodayRevenue,
  computeTotalOrders,
  computePendingRequests,
} from "./cmc-pos/cmcPosDashboard.helpers";

describe("formatUsd", () => {
  it("formats positive USD correctly", () => {
    expect(formatUsd(1234.5)).toBe("$1,234.50");
  });
  it("formats zero as $0.00", () => {
    expect(formatUsd(0)).toBe("$0.00");
  });
  it("handles null/undefined as $0.00", () => {
    expect(formatUsd(null)).toBe("$0.00");
    expect(formatUsd(undefined)).toBe("$0.00");
  });
  it("formats string numbers", () => {
    expect(formatUsd("99.9")).toBe("$99.90");
  });
});

describe("formatLbp", () => {
  it("formats LBP as whole number", () => {
    expect(formatLbp(1000000)).toBe("1,000,000 LBP");
  });
  it("rounds decimal values", () => {
    expect(formatLbp(999.7)).toBe("1,000 LBP");
  });
});

describe("formatAmount — currency dispatch", () => {
  it("routes LBP to formatLbp", () => {
    expect(formatAmount(500000, "LBP")).toBe("500,000 LBP");
  });
  it("routes USD to formatUsd", () => {
    expect(formatAmount(50, "USD")).toBe("$50.00");
  });
});

describe("deriveHealthSeverity", () => {
  it("returns ok when all counts are zero", () => {
    expect(deriveHealthSeverity({ pendingRequests: 0, paymentIssues: 0, stockAlerts: 0 })).toBe("ok");
  });
  it("returns warning when only pending requests exist", () => {
    expect(deriveHealthSeverity({ pendingRequests: 3, paymentIssues: 0, stockAlerts: 0 })).toBe("warning");
  });
  it("returns critical when payment issues exist", () => {
    expect(deriveHealthSeverity({ pendingRequests: 0, paymentIssues: 1, stockAlerts: 0 })).toBe("critical");
  });
  it("returns critical when stock alerts exist", () => {
    expect(deriveHealthSeverity({ pendingRequests: 2, paymentIssues: 0, stockAlerts: 1 })).toBe("critical");
  });
});

describe("healthMessage", () => {
  it("ok → all clear", () => {
    expect(healthMessage("ok")).toBe("Everything is running smoothly");
  });
  it("warning → review message", () => {
    expect(healthMessage("warning")).toBe("Some items need review");
  });
  it("critical → attention required", () => {
    expect(healthMessage("critical")).toBe("Attention required");
  });
});

describe("activityStatusLabel", () => {
  it("maps sale 'paid' → 'Completed'", () => {
    expect(activityStatusLabel("sale", "paid")).toBe("Completed");
  });
  it("maps request 'dispatched' correctly", () => {
    expect(activityStatusLabel("request", "dispatched")).toBe("Dispatched");
  });
  it("maps delivery 'accepted' → 'In Preparation'", () => {
    expect(activityStatusLabel("delivery", "accepted")).toBe("In Preparation");
  });
  it("returns raw status for unknown types", () => {
    expect(activityStatusLabel("unknown", "foo")).toBe("foo");
  });
});

describe("activityTypeLabel", () => {
  it("maps sale", () => expect(activityTypeLabel("sale")).toBe("Shelf Sale"));
  it("maps request", () => expect(activityTypeLabel("request")).toBe("Branch Request"));
  it("maps delivery", () => expect(activityTypeLabel("delivery")).toBe("Delivery Order"));
});

describe("statusBadgeClasses", () => {
  it("sale paid → emerald", () => {
    expect(statusBadgeClasses("sale", "paid")).toContain("emerald");
  });
  it("sale voided → red", () => {
    expect(statusBadgeClasses("sale", "voided")).toContain("red");
  });
  it("delivery dispatched → blue", () => {
    expect(statusBadgeClasses("delivery", "dispatched")).toContain("blue");
  });
  it("unknown → gray fallback", () => {
    expect(statusBadgeClasses("other", "anything")).toContain("gray");
  });
});

describe("KPI computation helpers", () => {
  describe("computeTodayRevenue — shelf sales USD only", () => {
    it("returns shelf gross_total only (delivery excluded to avoid currency mixing)", () => {
      // Shelf sales are USD. Delivery totals are excluded from the KPI because
      // they may represent mixed currencies.
      expect(computeTodayRevenue("100.00", null)).toBe(100);
    });
    it("sums shelf and delivery when both provided (helper still accepts both for flexibility)", () => {
      expect(computeTodayRevenue("100.00", "50.00")).toBe(150);
    });
    it("handles null gross_total gracefully", () => {
      expect(computeTodayRevenue(null, null)).toBe(0);
    });
    it("handles undefined", () => {
      expect(computeTodayRevenue(undefined, undefined)).toBe(0);
    });
  });

  describe("computeTotalOrders", () => {
    it("sums paid and delivery counts", () => {
      expect(computeTotalOrders("5", "3")).toBe(8);
    });
    it("handles null", () => {
      expect(computeTotalOrders(null, null)).toBe(0);
    });
  });

  describe("computePendingRequests", () => {
    it("sums submitted + accepted + dispatched", () => {
      expect(computePendingRequests("2", "3", "1")).toBe(6);
    });
    it("handles nulls as zero", () => {
      expect(computePendingRequests(null, null, null)).toBe(0);
    });
    it("handles string '0'", () => {
      expect(computePendingRequests("0", "0", "0")).toBe(0);
    });
  });
});

// ── Component rendering tests ─────────────────────────────────────────────

vi.mock("@/lib/queryClient", () => ({
  apiFetch: vi.fn(),
  queryClient: new (require("@tanstack/react-query").QueryClient)(),
}));

vi.mock("@/hooks/use-toast", () => ({
  toast: vi.fn(),
}));

// CmcPosCashDrawer uses useWorkspaceRole (→ useAuth → Clerk). Stub it out so
// CmcPos dashboard tests can render without a ClerkProvider in the wrapper.
vi.mock("@/hooks/use-workspace-role", () => ({
  useWorkspaceRole: () => ({
    isOwner: true,
    realIsOwner: true,
    role: "owner",
    allowedPages: null,
    customRoleId: null,
    customRoleIds: [],
    floristLocationId: null,
    loaded: true,
  }),
}));

function makeWrapper() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={qc}>
      <Router>{children}</Router>
    </QueryClientProvider>
  );
}

const MOCK_SHIFT = {
  id: 1,
  location_id: 42,
  location_name: "CMC Beirut Hospital",
  opened_at: new Date().toISOString(),
  currency: "USD",
};

const MOCK_METRICS = {
  sales: {
    paid_count: "7",
    refunded_count: "1",
    voided_count: "0",
    gross_total: "350.00",
    total_discounts: "10.00",
    cash_total: "200.00",
    cash_count: "4",
    cash_refunds_total: "25.00",
    cash_refunds_count: "1",
    payment_issues: "0",
  },
  requests: {
    draft_count: "0",
    submitted_count: "2",
    accepted_count: "1",
    dispatched_count: "0",
    received_count: "0",
    cancelled_count: "0",
  },
  delivery_orders: { count: "3", revenue: "120.00" },
};

const MOCK_PRODUCTS = { products: [{ id: 1 }, { id: 2 }, { id: 3 }] };

const MOCK_CASH_DRAWER = {
  session: {
    id: 7,
    status: "open",
    currency: "USD",
    secondary_currency: null,
    opening_cash: "50.00",
    opened_at: new Date().toISOString(),
    closed_at: null,
    reconciliation: null,
    location_name: "CMC Beirut",
  },
  currency_summary: [
    {
      currency: "USD",
      opening_cash: 50,
      sales_collected: 200,
      expenses_paid: 0,
      adjustments: 0,
      expected_cash: 250,
    },
  ],
  cash_sales_total: 200,
  expected_balance: 250,
  cash_refunds_total: 0,
  cash_refunds_count: 0,
};

async function getApiFetch() {
  const mod = await import("@/lib/queryClient");
  return mod as typeof mod & { apiFetch: ReturnType<typeof vi.fn> };
}

function mockAllApis(overrides: Record<string, unknown> = {}) {
  return async (url: string) => {
    if (url.includes("shifts/active")) return overrides["shift"] ?? { shift: MOCK_SHIFT };
    if (url.includes("cmc-pos/locations")) {
      return overrides["locations"] ?? {
        locations: [{ id: 42, name: "CMC Beirut Hospital", currency: "USD", secondary_currency: null }],
      };
    }
    if (url.includes("cmc-pos/metrics")) return overrides["metrics"] ?? MOCK_METRICS;
    if (url.includes("shelf-products")) return overrides["products"] ?? MOCK_PRODUCTS;
    if (url.includes("recent-activity")) return overrides["activity"] ?? { items: [] };
    if (url.includes("cash-drawer")) return overrides["cashDrawer"] ?? MOCK_CASH_DRAWER;
    return { sessions: [] };
  };
}

describe("CmcPos dashboard — renders with active shift and metrics", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("shows page title and subtitle", async () => {
    const mod = await getApiFetch();
    mod.apiFetch.mockImplementation(mockAllApis());

    const { default: CmcPos } = await import("./CmcPos");
    render(<CmcPos />, { wrapper: makeWrapper() });

    expect(screen.getByText("CMC POS Dashboard")).toBeInTheDocument();
    // Subtitle is driven by the async active-shift query; use findByText to wait for it.
    await screen.findByText("CMC Beirut Hospital · Point of Sale");
  });

  it("shows Store Open badge when shift is active", async () => {
    const mod = await getApiFetch();
    mod.apiFetch.mockImplementation(mockAllApis());

    const { default: CmcPos } = await import("./CmcPos");
    render(<CmcPos />, { wrapper: makeWrapper() });

    await waitFor(() => {
      expect(screen.getByTestId("badge-store-status")).toHaveTextContent("Store Open");
    });
    expect(screen.getByTestId("badge-shift-status")).toHaveTextContent("Shift Active");
  });

  it("shows Store Closed badge when no shift", async () => {
    const mod = await getApiFetch();
    mod.apiFetch.mockImplementation(mockAllApis({ shift: { shift: null } }));

    const { default: CmcPos } = await import("./CmcPos");
    render(<CmcPos />, { wrapper: makeWrapper() });

    await waitFor(() => {
      expect(screen.getByTestId("badge-store-status")).toHaveTextContent("Store Closed");
    });
    expect(screen.getByTestId("badge-shift-status")).toHaveTextContent("No Shift");
  });

  it("shows View Sales History button", async () => {
    const mod = await getApiFetch();
    mod.apiFetch.mockImplementation(mockAllApis());

    const { default: CmcPos } = await import("./CmcPos");
    render(<CmcPos />, { wrapper: makeWrapper() });

    expect(screen.getByTestId("btn-view-sales-history")).toBeInTheDocument();
  });

  it("renders shelf-sales-only USD revenue in KPI (delivery excluded for currency safety)", async () => {
    const mod = await getApiFetch();
    mod.apiFetch.mockImplementation(mockAllApis());

    const { default: CmcPos } = await import("./CmcPos");
    render(<CmcPos />, { wrapper: makeWrapper() });

    await waitFor(() => {
      // Revenue = shelf gross_total ONLY = $350.00 (delivery $120 is NOT included)
      expect(screen.getByText("$350.00")).toBeInTheDocument();
    });
    // Cash sales KPI — may appear multiple times (also in drawer ledger); check at least one
    expect(screen.getAllByText("$200.00").length).toBeGreaterThanOrEqual(1);
    // Total orders = 7 (paid) + 3 (delivery) = 10 — count only, no currency mixing
    expect(screen.getByText("10")).toBeInTheDocument();
    // Pending requests = 2 submitted + 1 accepted + 0 dispatched = 3
    expect(screen.getByText("3")).toBeInTheDocument();
  });

  it("USD label appears next to shelf revenue KPI", async () => {
    const mod = await getApiFetch();
    mod.apiFetch.mockImplementation(mockAllApis());

    const { default: CmcPos } = await import("./CmcPos");
    render(<CmcPos />, { wrapper: makeWrapper() });

    await waitFor(() => {
      expect(screen.getByText(/shelf sale.*USD/i)).toBeInTheDocument();
    });
  });
});

describe("CmcPos dashboard — primary workflow card", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("shows Start Shelf Sale CTA", async () => {
    const mod = await getApiFetch();
    mod.apiFetch.mockImplementation(mockAllApis());

    const { default: CmcPos } = await import("./CmcPos");
    render(<CmcPos />, { wrapper: makeWrapper() });

    expect(screen.getByTestId("btn-start-shelf-sale")).toBeInTheDocument();
  });

  it("Start Shelf Sale button is always enabled (no shift required)", async () => {
    const mod = await getApiFetch();
    // Simulate no active shift
    mod.apiFetch.mockImplementation(mockAllApis({ shift: { shift: null } }));

    const { default: CmcPos } = await import("./CmcPos");
    render(<CmcPos />, { wrapper: makeWrapper() });

    const btn = screen.getByTestId("btn-start-shelf-sale");
    expect(btn).toBeInTheDocument();
    expect(btn).not.toHaveClass("pointer-events-none");
    expect(btn).not.toHaveClass("opacity-60");
  });

  it("Scan Barcode and Search Products shortcut buttons are not rendered", async () => {
    const mod = await getApiFetch();
    mod.apiFetch.mockImplementation(mockAllApis());

    const { default: CmcPos } = await import("./CmcPos");
    render(<CmcPos />, { wrapper: makeWrapper() });

    expect(screen.queryByTestId("btn-scan-barcode")).not.toBeInTheDocument();
    expect(screen.queryByTestId("btn-search-products")).not.toBeInTheDocument();
  });
});

describe("CmcPos dashboard — health strip", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("shows all-good state when counts are zero", async () => {
    const mod = await getApiFetch();
    const zeroMetrics = {
      ...MOCK_METRICS,
      requests: {
        ...MOCK_METRICS.requests,
        submitted_count: "0",
        accepted_count: "0",
        dispatched_count: "0",
      },
    };
    mod.apiFetch.mockImplementation(mockAllApis({ metrics: zeroMetrics }));

    const { default: CmcPos } = await import("./CmcPos");
    render(<CmcPos />, { wrapper: makeWrapper() });

    await waitFor(() => {
      expect(screen.getByText("Everything is running smoothly")).toBeInTheDocument();
    });
  });

  it("shows warning state when pending requests > 0", async () => {
    const mod = await getApiFetch();
    mod.apiFetch.mockImplementation(mockAllApis());

    const { default: CmcPos } = await import("./CmcPos");
    render(<CmcPos />, { wrapper: makeWrapper() });

    await waitFor(() => {
      // MOCK_METRICS has 2 submitted + 1 accepted = 3 pending
      expect(screen.getByText("Some items need review")).toBeInTheDocument();
    });
  });
});

describe("CmcPos dashboard — cash drawer", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("shows expected USD balance from cash drawer endpoint", async () => {
    const mod = await getApiFetch();
    mod.apiFetch.mockImplementation(mockAllApis());

    const { default: CmcPos } = await import("./CmcPos");
    render(<CmcPos />, { wrapper: makeWrapper() });

    await waitFor(() => {
      expect(screen.getByText("Current Cash Drawer")).toBeInTheDocument();
    });
    // Expected USD balance from MOCK_CASH_DRAWER.currency_summary[0].expected_cash = 250
    await waitFor(() => {
      expect(screen.getByText("$250.00")).toBeInTheDocument();
    });
  });

  it("shows variance alert when reconciliation counts have non-zero variance", async () => {
    const mod = await getApiFetch();
    const drawerWithVariance = {
      ...MOCK_CASH_DRAWER,
      session: {
        ...MOCK_CASH_DRAWER.session,
        reconciliation: {
          started_at: new Date().toISOString(),
          counted_at: new Date().toISOString(),
          counts: [{ currency: "USD", expected: 250, actual: 230, variance: -20, explanation: null }],
        },
      },
    };
    mod.apiFetch.mockImplementation(mockAllApis({ cashDrawer: drawerWithVariance }));

    const { default: CmcPos } = await import("./CmcPos");
    render(<CmcPos />, { wrapper: makeWrapper() });

    await waitFor(() => {
      expect(screen.getByText("Cash variance detected")).toBeInTheDocument();
    });
  });

  it("shows no active shift state when shift is null", async () => {
    const mod = await getApiFetch();
    mod.apiFetch.mockImplementation(mockAllApis({ shift: { shift: null } }));

    const { default: CmcPos } = await import("./CmcPos");
    render(<CmcPos />, { wrapper: makeWrapper() });

    await waitFor(() => {
      expect(screen.getByText("No active shift")).toBeInTheDocument();
    });
  });

  it("does not offer the generic cash-session flow when a CMC drawer has no linked session", async () => {
    const mod = await getApiFetch();
    mod.apiFetch.mockImplementation(
      mockAllApis({ cashDrawer: { session: null, currency_summary: [], cash_refunds_total: 0, cash_refunds_count: 0 } }),
    );

    const { default: CmcPos } = await import("./CmcPos");
    render(<CmcPos />, { wrapper: makeWrapper() });

    await waitFor(() => {
      expect(screen.getByText("No linked cash session")).toBeInTheDocument();
    });
    expect(screen.queryByTestId("btn-open-cash-session")).not.toBeInTheDocument();
    expect(screen.getByText(/Start Shift is the only CMC workflow/i)).toBeInTheDocument();
  });

  it("uses the CMC Start Shift path when no shift is active", async () => {
    const mod = await getApiFetch();
    mod.apiFetch.mockImplementation(mockAllApis({ shift: { shift: null } }));

    const { default: CmcPos } = await import("./CmcPos");
    render(<CmcPos />, { wrapper: makeWrapper() });

    await waitFor(() => {
      expect(screen.getByTestId("btn-start-shift")).toBeInTheDocument();
    });
    fireEvent.click(screen.getByTestId("btn-start-shift"));
    expect(screen.getByText("Start Shift", { selector: "p" })).toBeInTheDocument();
    expect(screen.queryByTestId("btn-open-cash-session")).not.toBeInTheDocument();
    const submit = await screen.findByRole("button", { name: "Start Shift" });
    await waitFor(() => expect(submit).not.toBeDisabled());
    fireEvent.click(submit);
    await waitFor(() => {
      expect(mod.apiFetch).toHaveBeenCalledWith(
        "/api/cmc-pos/shifts",
        expect.objectContaining({ method: "POST" }),
      );
    });
  });

  it("renders the LBP drawer denomination from the response instead of an AED fallback", async () => {
    const mod = await getApiFetch();
    const lbpDrawer = {
      ...MOCK_CASH_DRAWER,
      session: { ...MOCK_CASH_DRAWER.session, currency: "LBP" },
      currency_summary: [{
        currency: "LBP",
        opening_cash: 500000,
        sales_collected: 500000,
        expenses_paid: 0,
        adjustments: 0,
        expected_cash: 1000000,
      }],
      expected_balance: 1000000,
      cash_sales_total: 500000,
    };
    mod.apiFetch.mockImplementation(mockAllApis({
      shift: { shift: { ...MOCK_SHIFT, currency: "LBP", opening_cash: "500000" } },
      cashDrawer: lbpDrawer,
    }));

    const { default: CmcPos } = await import("./CmcPos");
    render(<CmcPos />, { wrapper: makeWrapper() });

    await waitFor(() => {
      expect(screen.getByText("1,000,000 LBP")).toBeInTheDocument();
    });
    expect(screen.queryByText(/AED/)).not.toBeInTheDocument();
  });

  it("labels a non-USD authoritative drawer denomination instead of formatting it as dollars", async () => {
    const mod = await getApiFetch();
    mod.apiFetch.mockImplementation(mockAllApis({
      cashDrawer: {
        ...MOCK_CASH_DRAWER,
        session: { ...MOCK_CASH_DRAWER.session, currency: "AED" },
        currency_summary: [{
          currency: "AED",
          opening_cash: 100,
          sales_collected: 150,
          expenses_paid: 0,
          adjustments: 0,
          expected_cash: 250,
        }],
        expected_balance: 250,
        cash_sales_total: 150,
      },
    }));

    const { default: CmcPos } = await import("./CmcPos");
    render(<CmcPos />, { wrapper: makeWrapper() });

    await waitFor(() => {
      expect(screen.getByText("250.00 AED")).toBeInTheDocument();
    });
    expect(screen.queryByText("$250.00")).not.toBeInTheDocument();
  });

  it("shows the finalized-session recovery close instead of offering a new session", async () => {
    const mod = await getApiFetch();
    mod.apiFetch.mockImplementation(mockAllApis({
      cashDrawer: {
        ...MOCK_CASH_DRAWER,
        session: { ...MOCK_CASH_DRAWER.session, status: "pending_review" },
      },
    }));

    const { default: CmcPos } = await import("./CmcPos");
    render(<CmcPos />, { wrapper: makeWrapper() });

    await waitFor(() => {
      expect(screen.getByTestId("btn-end-shift")).toBeInTheDocument();
    });
    fireEvent.click(screen.getByTestId("btn-end-shift"));
    expect(screen.getByText(/linked cash session was already finalized/i)).toBeInTheDocument();
    expect(screen.queryByTestId("btn-open-cash-session")).not.toBeInTheDocument();
  });

  it("routes an overdue finalized session through shift close and refreshes to Start Shift", async () => {
    const mod = await getApiFetch();
    let activeShift: { shift: Record<string, unknown> | null } = {
      shift: {
        ...MOCK_SHIFT,
        isOverdue: true,
        cash_session_status: "approved",
      },
    };
    mod.apiFetch.mockImplementation(async (url: string) => {
      if (url.includes("shifts/active")) return activeShift;
      if (url.endsWith("/shifts/close")) {
        activeShift = { shift: null };
        return { session_already_finalized: true };
      }
      return mockAllApis({
        cashDrawer: {
          ...MOCK_CASH_DRAWER,
          session: { ...MOCK_CASH_DRAWER.session, status: "approved" },
        },
      })(url);
    });

    const { default: CmcPos } = await import("./CmcPos");
    render(<CmcPos />, { wrapper: makeWrapper() });

    await waitFor(() => {
      expect(screen.getByText(/cash session is already finalized/i)).toBeInTheDocument();
      expect(screen.getByText(/shift still needs to be closed/i)).toBeInTheDocument();
      expect(screen.getByTestId("btn-end-shift")).toBeInTheDocument();
    });
    expect(screen.queryByText("Cash session not closed")).not.toBeInTheDocument();
    expect(screen.getByTestId("link-resolve-overdue")).toHaveTextContent("Close shift");

    fireEvent.click(screen.getByTestId("link-resolve-overdue"));
    expect(screen.getByText(/recorded reconciliation unchanged/i)).toBeInTheDocument();
    const confirmation = screen.getByRole("checkbox");
    fireEvent.click(confirmation);
    fireEvent.click(screen.getByRole("button", { name: "Close Shift" }));

    await waitFor(() => {
      expect(screen.getByTestId("btn-start-shift")).toBeInTheDocument();
    });
    expect(screen.queryByTestId("btn-end-shift")).not.toBeInTheDocument();
    expect(mod.apiFetch).toHaveBeenCalledWith(
      "/api/cmc-pos/shifts/close",
      expect.objectContaining({
        method: "POST",
        body: expect.stringContaining('"cash_transferred":0'),
      }),
    );
  });

  it("shows cash refunds line in ledger when refunds > 0", async () => {
    const mod = await getApiFetch();
    // cashRefundsTotal comes from metrics: cash_refunds_total = 25.00
    mod.apiFetch.mockImplementation(mockAllApis());

    const { default: CmcPos } = await import("./CmcPos");
    render(<CmcPos />, { wrapper: makeWrapper() });

    await waitFor(() => {
      // The cash refunds line renders when cashRefundsTotal > 0
      expect(screen.getByText("Cash Refunds")).toBeInTheDocument();
    });
  });
});

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, act, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Router } from "wouter";

vi.mock("@/lib/queryClient", () => ({
  apiFetch: vi.fn(),
  getClerkToken: vi.fn().mockResolvedValue("tok"),
  queryClient: new (require("@tanstack/react-query").QueryClient)(),
}));

vi.mock("@/hooks/use-toast", () => ({
  toast: vi.fn(),
}));

// Mock the DateRangePicker so we can drive onChange in tests without needing a real calendar.
// Renders a hidden input whose value is "from|to" and a button that calls onChange with a
// complete range when clicked.
vi.mock("@/components/ui/date-range-picker", () => ({
  DateRangePicker: ({
    value,
    onChange,
    "data-testid": testId,
  }: {
    value: { from?: string; to?: string };
    onChange: (v: { from?: string; to?: string }) => void;
    "data-testid"?: string;
  }) => (
    <div data-testid={testId ?? "date-range-picker"}>
      <input
        type="hidden"
        data-testid="drp-value"
        value={`${value.from ?? ""}|${value.to ?? ""}`}
        readOnly
      />
      <button
        data-testid="drp-set-complete"
        onClick={() => onChange({ from: "2026-01-15", to: "2026-01-31" })}
      >
        Set complete range
      </button>
      <button
        data-testid="drp-set-partial"
        onClick={() => onChange({ from: "2026-01-15" })}
      >
        Set partial range (from only)
      </button>
    </div>
  ),
}));

function makeWrapper() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const Wrapper = ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={qc}>
      <Router>{children}</Router>
    </QueryClientProvider>
  );
  return Wrapper;
}

const TODAY = new Date().toISOString().slice(0, 10);

const MOCK_SALE = {
  id: "uuid-1",
  fulfilment_date: TODAY,
  created_at: `${TODAY}T10:30:00.000Z`,
  line_items: [
    { name: "Rose Bouquet", image_url: null, qty: 1 },
    { name: "Greeting Card", image_url: "/objects/ws/card.jpg", qty: 2 },
  ],
  total: "111.00",
  payment_method: "cash",
};

const MOCK_RESPONSE = {
  sales: [MOCK_SALE],
  totals: { gross: "111.00", net: "100.00", vat: "11.00" },
  total: 1,
  limit: 20,
  offset: 0,
};

const EMPTY_RESPONSE = {
  sales: [],
  totals: { gross: "0.00", net: "0.00", vat: "0.00" },
  total: 0,
  limit: 20,
  offset: 0,
};

async function setupModule() {
  const mod = await import("@/lib/queryClient");
  return mod as typeof mod & { apiFetch: ReturnType<typeof vi.fn> };
}

describe("CmcPosAudit — renders with data", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("shows page title and date range picker", async () => {
    const mod = await setupModule();
    mod.apiFetch.mockResolvedValue(MOCK_RESPONSE);

    const CmcPosAudit = (await import("./CmcPosAudit")).default;
    render(<CmcPosAudit />, { wrapper: makeWrapper() });

    expect(screen.getByText("CMC Audit")).toBeInTheDocument();
    expect(screen.getByTestId("input-audit-date-range")).toBeInTheDocument();
    // Apply button must be absent — selection auto-commits
    expect(screen.queryByTestId("btn-apply")).not.toBeInTheDocument();
    expect(screen.queryByText("Apply")).not.toBeInTheDocument();
  });

  it("shows summary cards with correct labels", async () => {
    const mod = await setupModule();
    mod.apiFetch.mockResolvedValue(MOCK_RESPONSE);

    const CmcPosAudit = (await import("./CmcPosAudit")).default;
    render(<CmcPosAudit />, { wrapper: makeWrapper() });

    expect(screen.getByText("Selected Sale Range")).toBeInTheDocument();
    expect(screen.getByText("Net Sales")).toBeInTheDocument();
    expect(screen.getByText("Gross Sales")).toBeInTheDocument();
    expect(screen.getByText("11% VAT included")).toBeInTheDocument();
  });
});

describe("CmcPosAudit — VAT arithmetic in summary cards", () => {
  it("renders the correct net amount from totals", async () => {
    vi.clearAllMocks();
    const mod = await setupModule();
    mod.apiFetch.mockResolvedValue(MOCK_RESPONSE);

    const CmcPosAudit = (await import("./CmcPosAudit")).default;
    render(<CmcPosAudit />, { wrapper: makeWrapper() });

    await waitFor(() => {
      const netEls = screen.getAllByText("$100.00");
      expect(netEls.length).toBeGreaterThanOrEqual(1);
    });
    const grossEls = screen.getAllByText("$111.00");
    expect(grossEls.length).toBeGreaterThanOrEqual(1);
  });
});

describe("CmcPosAudit — table columns", () => {
  it("shows all 5 required columns", async () => {
    vi.clearAllMocks();
    const mod = await setupModule();
    mod.apiFetch.mockResolvedValue(MOCK_RESPONSE);

    const CmcPosAudit = (await import("./CmcPosAudit")).default;
    render(<CmcPosAudit />, { wrapper: makeWrapper() });

    await waitFor(() => {
      expect(screen.getByText("Sale Date/Time")).toBeInTheDocument();
    });
    expect(screen.getByText("Product")).toBeInTheDocument();
    expect(screen.getByText("Net Amount")).toBeInTheDocument();
    expect(screen.getByText("Gross Amount")).toBeInTheDocument();
    expect(screen.getByText("Payment Method")).toBeInTheDocument();
  });

  it("renders product names for multi-product sale", async () => {
    vi.clearAllMocks();
    const mod = await setupModule();
    mod.apiFetch.mockResolvedValue(MOCK_RESPONSE);

    const CmcPosAudit = (await import("./CmcPosAudit")).default;
    render(<CmcPosAudit />, { wrapper: makeWrapper() });

    await waitFor(() => {
      expect(screen.getByText("Rose Bouquet")).toBeInTheDocument();
    });
    expect(screen.getByText(/Greeting Card/)).toBeInTheDocument();
  });
});

describe("CmcPosAudit — empty state", () => {
  it("shows empty state message when no records", async () => {
    vi.clearAllMocks();
    const mod = await setupModule();
    mod.apiFetch.mockResolvedValue(EMPTY_RESPONSE);

    const CmcPosAudit = (await import("./CmcPosAudit")).default;
    render(<CmcPosAudit />, { wrapper: makeWrapper() });

    await waitFor(() => {
      expect(screen.getByText("No recorded sales for this sale date range.")).toBeInTheDocument();
    });
  });

  it("export buttons are disabled when no records", async () => {
    vi.clearAllMocks();
    const mod = await setupModule();
    mod.apiFetch.mockResolvedValue(EMPTY_RESPONSE);

    const CmcPosAudit = (await import("./CmcPosAudit")).default;
    render(<CmcPosAudit />, { wrapper: makeWrapper() });

    await waitFor(() => {
      const csvBtn = screen.getByTestId("btn-export-csv");
      expect(csvBtn).toBeDisabled();
    });
    expect(screen.getByTestId("btn-export-pdf")).toBeDisabled();
  });
});

describe("CmcPosAudit — error state", () => {
  it("shows error message and retry button on fetch failure", async () => {
    vi.clearAllMocks();
    const mod = await setupModule();
    mod.apiFetch.mockRejectedValue(new Error("Network error"));

    const CmcPosAudit = (await import("./CmcPosAudit")).default;
    render(<CmcPosAudit />, { wrapper: makeWrapper() });

    await waitFor(() => {
      expect(screen.getByText("Failed to load audit data.")).toBeInTheDocument();
    });
    expect(screen.getByText("Retry")).toBeInTheDocument();
  });
});

describe("CmcPosAudit — auto-apply on complete selection", () => {
  it("query fires on mount with today's date — no Apply click needed", async () => {
    vi.clearAllMocks();
    const mod = await setupModule();
    mod.apiFetch.mockResolvedValue(EMPTY_RESPONSE);

    const CmcPosAudit = (await import("./CmcPosAudit")).default;
    render(<CmcPosAudit />, { wrapper: makeWrapper() });

    await waitFor(() => {
      const calls = mod.apiFetch.mock.calls as Array<[string, ...unknown[]]>;
      const auditCall = calls.find(([url]) => (url as string).includes("/api/cmc-pos/audit"));
      expect(auditCall).toBeDefined();
    });
  });

  it("selecting a complete range fires the query with the new from/to dates", async () => {
    vi.clearAllMocks();
    const mod = await setupModule();
    mod.apiFetch.mockResolvedValue(EMPTY_RESPONSE);

    const CmcPosAudit = (await import("./CmcPosAudit")).default;
    render(<CmcPosAudit />, { wrapper: makeWrapper() });

    // Simulate user completing a range selection (both from + to)
    await act(async () => {
      screen.getByTestId("drp-set-complete").click();
    });

    await waitFor(() => {
      const calls = mod.apiFetch.mock.calls as Array<[string, ...unknown[]]>;
      const newRangeCall = calls.find(([url]) =>
        (url as string).includes("from=2026-01-15") && (url as string).includes("to=2026-01-31"),
      );
      expect(newRangeCall).toBeDefined();
    });
  });

  it("partial selection (only from date) does NOT change the committed query range", async () => {
    vi.clearAllMocks();
    const mod = await setupModule();
    mod.apiFetch.mockResolvedValue(EMPTY_RESPONSE);

    const CmcPosAudit = (await import("./CmcPosAudit")).default;
    render(<CmcPosAudit />, { wrapper: makeWrapper() });

    // Wait for the initial query to fire with today's date
    await waitFor(() => {
      expect(mod.apiFetch.mock.calls.length).toBeGreaterThanOrEqual(1);
    });
    const callsBeforePartial = mod.apiFetch.mock.calls.length;

    // Simulate a partial selection (only from set, no to)
    await act(async () => {
      screen.getByTestId("drp-set-partial").click();
    });

    // No additional query should have fired because the range is incomplete
    expect(mod.apiFetch.mock.calls.length).toBe(callsBeforePartial);

    // The summary card still shows today's committed range (not the partial selection)
    expect(screen.getByText("Selected Sale Range")).toBeInTheDocument();
  });
});

describe("CmcPosAudit — read-only (no mutation buttons)", () => {
  it("does not render any void, refund, or edit buttons", async () => {
    vi.clearAllMocks();
    const mod = await setupModule();
    mod.apiFetch.mockResolvedValue(MOCK_RESPONSE);

    const CmcPosAudit = (await import("./CmcPosAudit")).default;
    render(<CmcPosAudit />, { wrapper: makeWrapper() });

    await waitFor(() => {
      expect(screen.getByText("Rose Bouquet")).toBeInTheDocument();
    });

    expect(screen.queryByText(/void/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/refund/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/edit/i)).not.toBeInTheDocument();
  });
});

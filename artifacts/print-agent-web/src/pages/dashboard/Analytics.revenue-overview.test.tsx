import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import AnalyticsPage from "./Analytics";

const mockApiFetch = vi.fn();
const mockCaptureDatasets = vi.fn();

vi.mock("@/lib/queryClient", () => ({
  apiFetch: (...args: unknown[]) => mockApiFetch(...args),
}));

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <AnalyticsPage />
    </QueryClientProvider>,
  );
}

const mockUseGetRevenueOverview = vi.fn();

vi.mock("@workspace/api-client-react", () => ({
  useGetRevenueOverview: (...args: unknown[]) => mockUseGetRevenueOverview(...args),
  getGetRevenueOverviewQueryKey: (params: unknown) => ["revenue-overview", params],
}));

vi.mock("wouter", () => ({
  useSearch: () => "",
  useLocation: () => ["/analytics", vi.fn()],
  Link: ({ children }: { children: React.ReactNode }) => <a>{children}</a>,
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) => {
      if (opts) {
        const vals = Object.entries(opts)
          .filter(([k]) => k !== "count")
          .map(([, v]) => String(v))
          .join(" ");
        return vals ? `${key} ${vals}` : key;
      }
      return key;
    },
    i18n: { language: "en" },
  }),
}));

// Recharts renders nothing meaningful in jsdom; stub the primitives.
vi.mock("recharts", () => ({
  ResponsiveContainer: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  LineChart: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="line-chart">{children}</div>
  ),
  Line: ({ dataKey }: { dataKey: string }) => <div data-testid={`line-${dataKey}`} />,
  PieChart: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="pie-chart">{children}</div>
  ),
  Pie: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  Cell: () => null,
  XAxis: () => null,
  YAxis: () => null,
  CartesianGrid: () => null,
  Tooltip: () => null,
}));

vi.mock("@/components/AnalyticsExportMenu", () => ({
  AnalyticsExportMenu: ({
    disabled,
    getDatasets,
  }: {
    disabled?: boolean;
    getDatasets: () => unknown[];
  }) => (
    <button
      data-testid="export-menu"
      disabled={disabled}
      onClick={() => mockCaptureDatasets(getDatasets())}
    >
      export
    </button>
  ),
}));

function makeResponse(overrides: Record<string, unknown> = {}) {
  return {
    range: { from: "2026-08-01T00:00:00.000Z", to: "2026-08-08T00:00:00.000Z" },
    comparison: null,
    granularity: "day",
    currency: "USD",
    generatedAt: "2026-08-08T12:00:00.000Z",
    totals: {
      totalRevenue: 1000,
      comparisonTotal: null,
      totalChangePct: null,
      streams: [
        {
          key: "ecommerce",
          label: "E-Commerce",
          revenue: 600,
          orders: 6,
          refunds: 0,
          shareOfTotal: 60,
          comparisonRevenue: null,
          changePct: null,
        },
        {
          key: "retail",
          label: "Retail",
          revenue: 300,
          orders: 4,
          refunds: 10,
          shareOfTotal: 30,
          comparisonRevenue: null,
          changePct: null,
        },
        {
          key: "cmc",
          label: "CMC",
          revenue: 100,
          orders: 1,
          refunds: 0,
          shareOfTotal: 10,
          comparisonRevenue: null,
          changePct: null,
        },
        {
          key: "toters",
          label: "Toters",
          revenue: 0,
          orders: 0,
          refunds: 0,
          shareOfTotal: 0,
          comparisonRevenue: null,
          changePct: null,
        },
      ],
    },
    series: [
      { bucket: "2026-08-01T00:00:00.000Z", ecommerce: 600, retail: null, cmc: 100, toters: null, total: 700 },
      { bucket: "2026-08-02T00:00:00.000Z", ecommerce: null, retail: 300, cmc: null, toters: null, total: 300 },
    ],
    snapshot: {
      orders: { value: 11, available: true, reason: null },
      aov: { value: 90.91, available: true, reason: null },
      grossMargin: {
        value: null,
        available: false,
        reason: "COGS recorded for only 12% of revenue.",
        coveragePct: 12,
      },
      refundRate: { value: 0.99, available: true, reason: null },
    },
    pulse: [
      {
        stream: "ecommerce",
        label: "E-Commerce",
        status: "on_track",
        changePct: 4,
        reason: "Revenue changed +4% vs the previous period (at risk below -5%).",
        thresholds: { atRiskBelowPct: -5, offTrackBelowPct: -20 },
      },
      {
        stream: "retail",
        label: "Retail",
        status: "at_risk",
        changePct: -12,
        reason: "Revenue changed -12% vs the previous period (off track below -20%).",
        thresholds: { atRiskBelowPct: -5, offTrackBelowPct: -20 },
      },
      {
        stream: "cmc",
        label: "CMC",
        status: "off_track",
        changePct: -45,
        reason: "Revenue changed -45% vs the previous period (off track below -20%).",
        thresholds: { atRiskBelowPct: -5, offTrackBelowPct: -20 },
      },
    ],
    availability: [
      { stream: "ecommerce", label: "E-Commerce", available: true, partial: false, reason: null, lastActivityAt: null },
      { stream: "retail", label: "Retail", available: true, partial: false, reason: null, lastActivityAt: null },
      { stream: "cmc", label: "CMC", available: true, partial: false, reason: null, lastActivityAt: null },
      { stream: "toters", label: "Toters", available: true, partial: false, reason: null, lastActivityAt: null },
    ],
    totersByStore: [],
    definitions: { currency: "All figures in USD.", pulse: "Thresholds: -5 / -20." },
    ...overrides,
  };
}

function mockQuery(state: {
  data?: unknown;
  isLoading?: boolean;
  isError?: boolean;
}) {
  mockUseGetRevenueOverview.mockReturnValue({
    data: state.data,
    isLoading: state.isLoading ?? false,
    isError: state.isError ?? false,
    isFetching: false,
    refetch: vi.fn(),
    dataUpdatedAt: state.data ? Date.now() : 0,
  });
}

beforeEach(() => {
  mockUseGetRevenueOverview.mockReset();
  mockApiFetch.mockReset();
  mockCaptureDatasets.mockReset();
  mockApiFetch.mockResolvedValue({ batches: [] });
});

describe("Revenue Overview page", () => {
  it("renders title, subtitle, and reconciled KPI cards", () => {
    mockQuery({ data: makeResponse() });
    renderPage();

    expect(screen.getByText("revenueOverview.title")).toBeInTheDocument();
    expect(screen.getByText("revenueOverview.subtitle")).toBeInTheDocument();

    // Total equals the sum of the three streams.
    expect(screen.getByTestId("kpi-total-value").textContent).toContain("1,000");
    expect(screen.getByTestId("kpi-ecommerce")).toHaveTextContent("$600");
    expect(screen.getByTestId("kpi-retail")).toHaveTextContent("$300");
    expect(screen.getByTestId("kpi-cmc")).toHaveTextContent("$100");
    // Share of total shown per stream.
    expect(screen.getByTestId("kpi-ecommerce")).toHaveTextContent("60");
  });

  it("shows layout-preserving skeletons while loading", () => {
    mockQuery({ isLoading: true });
    renderPage();
    expect(screen.getByTestId("trend-skeleton")).toBeInTheDocument();
    expect(screen.getByTestId("mix-skeleton")).toBeInTheDocument();
    expect(screen.queryByTestId("revenue-error")).not.toBeInTheDocument();
  });

  it("shows the error state with a retry action", () => {
    const refetch = vi.fn();
    mockUseGetRevenueOverview.mockReturnValue({
      data: undefined,
      isLoading: false,
      isError: true,
      isFetching: false,
      refetch,
      dataUpdatedAt: 0,
    });
    renderPage();
    expect(screen.getByTestId("revenue-error")).toBeInTheDocument();
    fireEvent.click(screen.getByTestId("button-retry"));
    expect(refetch).toHaveBeenCalled();
  });

  it("names the affected stream in the partial-data banner", () => {
    const data = makeResponse();
    (data.availability as Array<Record<string, unknown>>)[2] = {
      stream: "cmc",
      label: "CMC",
      available: false,
      partial: false,
      reason: "CMC data is currently unavailable.",
      lastActivityAt: null,
    };
    mockQuery({ data });
    renderPage();
    const banner = screen.getByTestId("partial-data-banner");
    expect(banner).toHaveTextContent("revenueOverview.streams.cmc");
    expect(banner).toHaveTextContent("CMC data is currently unavailable.");
    // The affected stream's KPI shows unavailable, not a fabricated zero.
    expect(screen.getByTestId("kpi-cmc")).toHaveTextContent("revenueOverview.unavailable");
  });

  it("does not show a banner for rows excluded by a missing exchange rate", () => {
    const data = makeResponse();
    const availability = (data.availability as Array<Record<string, unknown>>).map((entry) =>
      entry.stream === "retail"
        ? {
            ...entry,
            partial: true,
            reason: "Some retail amounts (3440000 LBP) were excluded because no USD exchange rate is stored for that currency.",
          }
        : entry,
    );
    (data as unknown as { availability: Array<Record<string, unknown>> }).availability =
      availability;
    mockQuery({ data });
    renderPage();

    expect(screen.queryByTestId("partial-stream-retail")).not.toBeInTheDocument();
    expect(screen.queryByText(/3440000 LBP/)).not.toBeInTheDocument();
    // The unavailable-stream banner remains separate and still renders above.
    expect(screen.queryByTestId("partial-data-banner")).not.toBeInTheDocument();
  });

  it("distinguishes true no-activity from unavailable data", () => {
    const data = makeResponse();
    data.totals = {
      totalRevenue: 0,
      comparisonTotal: null,
      totalChangePct: null,
      streams: (data.totals as { streams: Array<Record<string, unknown>> }).streams.map((s) => ({
        ...s,
        revenue: 0,
        orders: 0,
        refunds: 0,
        shareOfTotal: 0,
      })),
    } as never;
    mockQuery({ data });
    renderPage();
    expect(screen.getByTestId("revenue-empty")).toBeInTheDocument();
  });

  it("renders Channel Pulse statuses with reasons", () => {
    mockQuery({ data: makeResponse() });
    renderPage();
    expect(screen.getByTestId("pulse-ecommerce")).toHaveTextContent(
      "revenueOverview.pulseStatus.on_track",
    );
    expect(screen.getByTestId("pulse-retail")).toHaveTextContent(
      "revenueOverview.pulseStatus.at_risk",
    );
    expect(screen.getByTestId("pulse-cmc")).toHaveTextContent(
      "revenueOverview.pulseStatus.off_track",
    );
    expect(screen.getByTestId("pulse-retail")).toHaveTextContent("off track below -20%");
  });

  it("shows an explicit unavailable state for gross margin instead of a number", () => {
    mockQuery({ data: makeResponse() });
    renderPage();
    const card = screen.getByTestId("snapshot-gross-margin");
    expect(card).toHaveTextContent("revenueOverview.unavailable");
    expect(card).toHaveTextContent("COGS recorded for only 12% of revenue.");
  });

  it("toggles a stream line via the legend", () => {
    mockQuery({ data: makeResponse() });
    renderPage();
    expect(screen.getByTestId("line-retail")).toBeInTheDocument();
    const legendBtn = screen.getByTestId("legend-retail");
    expect(legendBtn).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(legendBtn);
    expect(legendBtn).toHaveAttribute("aria-pressed", "false");
    expect(screen.queryByTestId("line-retail")).not.toBeInTheDocument();
  });

  it("renders Toters as a fourth channel with KPI card, legend toggle, and imports section", () => {
    const data = makeResponse();
    const streams = (data.totals as { streams: Array<Record<string, unknown>> }).streams;
    streams[3] = { ...streams[3], revenue: 70.23, orders: 1, shareOfTotal: 6.6 };
    (data as Record<string, unknown>).totersByStore = [
      { store: "Presentail Achrafieh", revenue: 70.23, orders: 1 },
    ];
    mockQuery({ data });
    renderPage();

    // KPI card for the fourth channel.
    expect(screen.getByTestId("kpi-toters")).toHaveTextContent("$70.23");
    expect(screen.getByTestId("kpi-toters")).toHaveTextContent("6.6");

    // Trend legend toggle behaves like the other streams.
    const legendBtn = screen.getByTestId("legend-toters");
    expect(legendBtn).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByTestId("line-toters")).toBeInTheDocument();
    fireEvent.click(legendBtn);
    expect(screen.queryByTestId("line-toters")).not.toBeInTheDocument();

    // Revenue by store card.
    const byStore = screen.getByTestId("toters-by-store");
    expect(byStore).toHaveTextContent("Presentail Achrafieh");
    expect(byStore).toHaveTextContent("$70.23");

    // Imports section with upload flow + history is present.
    expect(screen.getByTestId("toters-imports")).toBeInTheDocument();
    expect(screen.getByTestId("toters-upload-button")).toBeInTheDocument();
    expect(mockApiFetch).toHaveBeenCalledWith("/api/toters-imports");
  });

  it("renders the accessible revenue-mix text list with % and value", () => {
    mockQuery({ data: makeResponse() });
    renderPage();
    const legend = screen.getByTestId("mix-legend");
    expect(legend).toHaveTextContent("60% · $600");
    expect(legend).toHaveTextContent("30% · $300");
    expect(legend).toHaveTextContent("10% · $100");
  });

  it("uses the corrected LBP-derived retail value everywhere, including exports", () => {
    const data = makeResponse();
    data.totals = {
      totalRevenue: 40.67,
      comparisonTotal: null,
      totalChangePct: null,
      streams: (data.totals as { streams: Array<Record<string, unknown>> }).streams.map(
        (stream) => ({
          ...stream,
          revenue: stream.key === "retail" ? 40.67 : 0,
          orders: stream.key === "retail" ? 1 : 0,
          refunds: 0,
          shareOfTotal: stream.key === "retail" ? 100 : 0,
        }),
      ),
    } as never;
    data.series = [
      {
        bucket: "2026-08-02T00:00:00.000Z",
        ecommerce: null,
        retail: 40.67,
        cmc: null,
        toters: null,
        total: 40.67,
      },
    ];
    data.snapshot = {
      ...(data.snapshot as Record<string, unknown>),
      orders: { value: 1, available: true, reason: null },
      aov: { value: 40.67, available: true, reason: null },
    } as never;

    mockQuery({ data });
    renderPage();

    expect(screen.getByTestId("kpi-total-value")).toHaveTextContent("$40.67");
    expect(screen.getByTestId("kpi-retail")).toHaveTextContent("$40.67");
    expect(screen.getByTestId("mix-legend")).toHaveTextContent("100% · $40.67");
    expect(screen.getByTestId("snapshot-aov")).toHaveTextContent("$40.67");

    fireEvent.click(screen.getByTestId("export-menu"));
    const datasets = mockCaptureDatasets.mock.calls[0][0] as Array<{
      title: string;
      rows: Array<Record<string, unknown>>;
    }>;
    const summaryValues = datasets[0].rows.map((row) => row.Value);
    expect(summaryValues).toContain(40.67);
    expect(datasets[1].rows.find((row) => row.Stream === "revenueOverview.streams.retail")).toMatchObject({
      "Revenue (USD)": 40.67,
    });
    expect(datasets[2].rows[0]).toMatchObject({
      "revenueOverview.streams.retail": 40.67,
      Total: 40.67,
    });
  });
});

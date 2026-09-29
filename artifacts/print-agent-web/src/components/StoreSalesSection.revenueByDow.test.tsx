import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import type {
  StoreSalesResponse,
  StoreHeatmapCell,
} from "@workspace/api-client-react";

import { RevenueByDowCard } from "./StoreSalesSection";
import StoreSalesSection from "./StoreSalesSection";

// ---------------------------------------------------------------------------
// Mocks for StoreSalesSection visibility tests
// ---------------------------------------------------------------------------

const minimalSalesData: StoreSalesResponse = {
  range: { from: "2026-07-21", to: "2026-07-27" },
  bucket: "day",
  revenueOverTime: [],
  revenueByHour: [],
  hourlyHeatmap: [{ dow: 1, hour: 10, orders: 3, revenue: 120 }],
  revenueByCountry: [],
  revenueByCity: [],
  revenueByBrand: [],
  revenueByChannel: [],
  revenueByPaymentMethod: [],
  revenueByCurrency: [],
  revenueByOccasion: [],
  ordersBySource: [],
  conversionRateByCountry: [],
};

vi.mock("@workspace/api-client-react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@workspace/api-client-react")>();
  return {
    ...actual,
    useGetStoreSales: vi.fn(() => ({
      data: minimalSalesData,
      isLoading: false,
      isError: false,
    })),
    useGetStoreTimeSlots: vi.fn(() => ({ data: undefined, isLoading: false })),
    useGetStoreFunnel: vi.fn(() => ({ data: undefined })),
    getGetStoreSalesQueryKey: vi.fn(() => ["store-sales"]),
    getGetStoreTimeSlotsQueryKey: vi.fn(() => ["store-time-slots"]),
    getGetStoreFunnelQueryKey: vi.fn(() => ["store-funnel"]),
  };
});

vi.mock("@/components/AnalyticsExportMenu", () => ({
  AnalyticsExportMenu: () => null,
}));

vi.mock("@/lib/analytics-export", () => ({
  buildFilterSummary: () => "",
  datasetsFromResponse: () => [],
}));

vi.mock("@/components/analytics/BreakdownCard", () => ({
  BreakdownCard: () => null,
  formatSourceLabel: (s: string) => s,
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a heatmap with revenue on the given dow (JS day, 0=Sun). */
function makeHeatmap(dow: number, revenue = 200): StoreHeatmapCell[] {
  return [{ dow, hour: 10, orders: 5, revenue }];
}

/** Build a resolvedRange spanning exactly `days` days starting from `from`. */
function makeRange(from: Date, days: number): { from: Date; to: Date } {
  const to = new Date(from);
  to.setDate(to.getDate() + days);
  return { from, to };
}

// ---------------------------------------------------------------------------
// RevenueByDowCard — direct unit tests
// ---------------------------------------------------------------------------

describe("RevenueByDowCard", () => {
  it("renders the chart when there is revenue data", () => {
    const today = new Date();
    const range = makeRange(today, 7);
    render(
      <RevenueByDowCard
        hourlyHeatmap={makeHeatmap(today.getDay())}
        resolvedRange={range}
        isThisWeek={false}
        emptyMessage="No data"
      />,
    );

    expect(screen.getByTestId("chart-revenue-by-dow")).toBeInTheDocument();
    expect(screen.queryByText("No data")).not.toBeInTheDocument();
  });

  it("shows the empty-state message when all revenue values are zero", () => {
    const from = new Date("2026-07-21");
    const range = makeRange(from, 7);
    const zeroHeatmap: StoreHeatmapCell[] = [
      { dow: 1, hour: 10, orders: 5, revenue: 0 },
      { dow: 2, hour: 11, orders: 3, revenue: 0 },
    ];

    render(
      <RevenueByDowCard
        hourlyHeatmap={zeroHeatmap}
        resolvedRange={range}
        isThisWeek={false}
        emptyMessage="No data this week"
      />,
    );

    expect(screen.getByText("No data this week")).toBeInTheDocument();
    expect(screen.queryByTestId("chart-revenue-by-dow")).not.toBeInTheDocument();
  });

  it("sets data-has-today on the chart when isThisWeek=true and today is in range", () => {
    const today = new Date();
    const from = new Date(today);
    from.setDate(from.getDate() - 3);
    const range = makeRange(from, 7);

    render(
      <RevenueByDowCard
        hourlyHeatmap={makeHeatmap(today.getDay())}
        resolvedRange={range}
        isThisWeek={true}
        emptyMessage="No data"
      />,
    );

    const chart = screen.getByTestId("chart-revenue-by-dow");
    expect(chart).toHaveAttribute("data-has-today", "true");
  });

  it("does NOT set data-has-today when isThisWeek=false even if today is in range", () => {
    const today = new Date();
    const from = new Date(today);
    from.setDate(from.getDate() - 3);
    const range = makeRange(from, 7);

    render(
      <RevenueByDowCard
        hourlyHeatmap={makeHeatmap(today.getDay())}
        resolvedRange={range}
        isThisWeek={false}
        emptyMessage="No data"
      />,
    );

    const chart = screen.getByTestId("chart-revenue-by-dow");
    expect(chart).not.toHaveAttribute("data-has-today");
  });
});

// ---------------------------------------------------------------------------
// StoreSalesSection — visibility gating (RevenueByDowCard shown/hidden)
// ---------------------------------------------------------------------------

const BASE_PARAMS = { from: "2026-07-21", to: "2026-07-27" };

describe("StoreSalesSection — RevenueByDowCard visibility", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders the RevenueByDowCard for a this_week range (7 days)", () => {
    const from = new Date("2026-07-21");
    const to = new Date("2026-07-28");

    render(
      <StoreSalesSection
        apiParams={BASE_PARAMS}
        preset="this_week"
        resolvedRange={{ from, to }}
      />,
    );

    expect(screen.getByText("Revenue by Day of Week")).toBeInTheDocument();
  });

  it("renders the RevenueByDowCard for a last_week range (7 days)", () => {
    const from = new Date("2026-07-14");
    const to = new Date("2026-07-21");

    render(
      <StoreSalesSection
        apiParams={BASE_PARAMS}
        preset="last_week"
        resolvedRange={{ from, to }}
      />,
    );

    expect(screen.getByText("Revenue by Day of Week")).toBeInTheDocument();
  });

  it("renders the RevenueByDowCard for a custom 7-day range", () => {
    const from = new Date("2026-07-10");
    const to = new Date("2026-07-17");

    render(
      <StoreSalesSection
        apiParams={BASE_PARAMS}
        preset="custom"
        resolvedRange={{ from, to }}
      />,
    );

    expect(screen.getByText("Revenue by Day of Week")).toBeInTheDocument();
  });

  it("does NOT render the RevenueByDowCard for a this_month range (>7 days)", () => {
    const from = new Date("2026-07-01");
    const to = new Date("2026-08-01");

    render(
      <StoreSalesSection
        apiParams={BASE_PARAMS}
        preset="this_month"
        resolvedRange={{ from, to }}
      />,
    );

    expect(screen.queryByText("Revenue by Day of Week")).not.toBeInTheDocument();
  });

  it("does NOT render the RevenueByDowCard for a 30-day custom range", () => {
    const from = new Date("2026-06-01");
    const to = new Date("2026-07-01");

    render(
      <StoreSalesSection
        apiParams={BASE_PARAMS}
        preset="custom"
        resolvedRange={{ from, to }}
      />,
    );

    expect(screen.queryByText("Revenue by Day of Week")).not.toBeInTheDocument();
  });
});

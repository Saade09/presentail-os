import { act, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import OperationsDashboard from "./OperationsDashboard";

const mocks = vi.hoisted(() => ({
  useSummary: vi.fn(),
  queryKey: vi.fn(() => ["operations-summary"]),
  useRole: vi.fn(),
  useVisibility: vi.fn(() => true),
  refetch: vi.fn(),
}));

vi.mock("@workspace/api-client-react", () => ({
  useGetOperationsDashboardSummary: mocks.useSummary,
  getGetOperationsDashboardSummaryQueryKey: mocks.queryKey,
}));

vi.mock("@/hooks/use-workspace-role", () => ({
  useWorkspaceRole: mocks.useRole,
}));

vi.mock("@/hooks/use-document-visibility", () => ({
  useDocumentVisibility: mocks.useVisibility,
}));

function summaryResult(
  data?: {
    florist_manual_review_count: number;
    cmc_submitted_request_count: number;
    processing_orders_today_count: number;
  },
  overrides: Record<string, unknown> = {},
) {
  return {
    data,
    isLoading: false,
    isError: false,
    isRefetching: false,
    refetch: mocks.refetch,
    ...overrides,
  };
}

describe("OperationsDashboard", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-19T08:00:00"));
    mocks.useVisibility.mockReturnValue(true);
    mocks.useRole.mockReturnValue({
      isOwner: false,
      allowedPages: [
        "ops-dashboard",
        "orders",
        "cmc_pos.view_location_requests",
      ],
      loaded: true,
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("renders all mixed counts and their exact authorized destinations", () => {
    mocks.useSummary.mockReturnValue(
      summaryResult({
        florist_manual_review_count: 3,
        cmc_submitted_request_count: 2,
        processing_orders_today_count: 7,
      }),
    );

    render(<OperationsDashboard />);

    expect(screen.getByTestId("ops-florist-review")).toHaveTextContent("3");
    expect(screen.getByTestId("ops-cmc-requests")).toHaveTextContent("2");
    expect(screen.getByTestId("ops-processing-orders")).toHaveTextContent("7");
    expect(screen.getByTestId("ops-florist-review").closest("a")).toHaveAttribute(
      "href",
      "/florist-orders",
    );
    expect(screen.getByTestId("ops-cmc-requests").closest("a")).toHaveAttribute(
      "href",
      "/cmc-pos/location-requests?status=submitted",
    );
    expect(screen.getByTestId("ops-processing-orders").closest("a")).toHaveAttribute(
      "href",
      "/orders?status=processing&deliveryDates=2026-08-19",
    );
  });

  it("hides zero action alerts while keeping the processing KPI at zero", () => {
    mocks.useSummary.mockReturnValue(
      summaryResult({
        florist_manual_review_count: 0,
        cmc_submitted_request_count: 0,
        processing_orders_today_count: 0,
      }),
    );

    render(<OperationsDashboard />);

    expect(screen.queryByTestId("ops-florist-review")).not.toBeInTheDocument();
    expect(screen.queryByTestId("ops-cmc-requests")).not.toBeInTheDocument();
    expect(screen.getByTestId("ops-processing-orders")).toHaveTextContent("0");
    expect(
      screen.getByText("No florist or branch requests need attention."),
    ).toBeVisible();
  });

  it("shows counts without widening access to target workflows", () => {
    mocks.useRole.mockReturnValue({
      isOwner: false,
      allowedPages: ["ops-dashboard"],
      loaded: true,
    });
    mocks.useSummary.mockReturnValue(
      summaryResult({
        florist_manual_review_count: 4,
        cmc_submitted_request_count: 5,
        processing_orders_today_count: 6,
      }),
    );

    render(<OperationsDashboard />);

    expect(screen.getByTestId("ops-florist-review").closest("a")).toBeNull();
    expect(screen.getByTestId("ops-cmc-requests").closest("a")).toBeNull();
    expect(screen.getByTestId("ops-processing-orders").closest("a")).toBeNull();
  });

  it("links florist review alerts for members with florist-only access", () => {
    mocks.useRole.mockReturnValue({
      isOwner: false,
      allowedPages: ["ops-dashboard", "florist_orders"],
      loaded: true,
    });
    mocks.useSummary.mockReturnValue(
      summaryResult({
        florist_manual_review_count: 1,
        cmc_submitted_request_count: 0,
        processing_orders_today_count: 0,
      }),
    );

    render(<OperationsDashboard />);

    expect(screen.getByTestId("ops-florist-review").closest("a")).toHaveAttribute(
      "href",
      "/florist-orders",
    );
    expect(screen.getByTestId("ops-processing-orders").closest("a")).toBeNull();
  });

  it("renders loading and error states cleanly", () => {
    mocks.useSummary.mockReturnValue(
      summaryResult(undefined, { isLoading: true }),
    );
    const { rerender } = render(<OperationsDashboard />);
    expect(screen.getAllByTestId("ops-dashboard-skeleton")).toHaveLength(3);

    mocks.useSummary.mockReturnValue(
      summaryResult(undefined, { isError: true }),
    );
    rerender(<OperationsDashboard />);
    expect(screen.getByText("Failed to load dashboard data.")).toBeVisible();
  });

  it("sends the local date and time zone and pauses polling while hidden", () => {
    mocks.useVisibility.mockReturnValue(false);
    mocks.useSummary.mockReturnValue(
      summaryResult({
        florist_manual_review_count: 0,
        cmc_submitted_request_count: 0,
        processing_orders_today_count: 1,
      }),
    );

    render(<OperationsDashboard />);

    const [params, options] = mocks.useSummary.mock.calls[0];
    expect(params).toEqual({
      date: "2026-08-19",
      tz: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
    });
    expect(options.query).toMatchObject({
      queryKey: ["operations-summary"],
      refetchInterval: false,
      refetchIntervalInBackground: false,
    });
  });

  it("uses 30-second polling while visible and refetches on visibility restore", () => {
    mocks.useSummary.mockReturnValue(
      summaryResult({
        florist_manual_review_count: 0,
        cmc_submitted_request_count: 0,
        processing_orders_today_count: 1,
      }),
    );

    render(<OperationsDashboard />);

    expect(mocks.useSummary.mock.calls[0][1].query.refetchInterval).toBe(30_000);
    expect(mocks.refetch).toHaveBeenCalled();
  });

  it("uses the new local date after local midnight", () => {
    vi.setSystemTime(new Date("2026-08-19T23:59:59"));
    mocks.useSummary.mockReturnValue(
      summaryResult({
        florist_manual_review_count: 0,
        cmc_submitted_request_count: 0,
        processing_orders_today_count: 1,
      }),
    );

    render(<OperationsDashboard />);
    expect(mocks.useSummary.mock.calls.at(-1)?.[0]).toMatchObject({
      date: "2026-08-19",
    });

    act(() => {
      vi.advanceTimersByTime(2_000);
    });

    expect(mocks.useSummary.mock.calls.at(-1)?.[0]).toMatchObject({
      date: "2026-08-20",
    });
    expect(screen.getByTestId("ops-processing-orders").closest("a")).toHaveAttribute(
      "href",
      "/orders?status=processing&deliveryDates=2026-08-20",
    );
  });
});
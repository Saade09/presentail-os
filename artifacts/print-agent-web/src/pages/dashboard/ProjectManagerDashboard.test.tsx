import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, act } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import ProjectManagerDashboard from "./ProjectManagerDashboard";
import { apiFetch } from "@/lib/queryClient";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock("@/lib/queryClient", () => ({
  apiFetch: vi.fn(),
  queryClient: {
    invalidateQueries: vi.fn(),
  },
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}));

const mockApiFetch = vi.mocked(apiFetch);

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeSummary(overrides: Partial<{
  total_brands: number;
  total_locations: number;
  total_channels: number;
  products_available: number;
  products_out_of_stock: number;
  products_not_available: number;
  brands_without_products: number;
  total_base_items: number;
  low_stock_base_items: number;
  out_of_stock_base_items: number;
}> = {}) {
  return {
    total_brands: 3,
    total_locations: 5,
    total_channels: 2,
    products_available: 10,
    products_out_of_stock: 1,
    products_not_available: 0,
    brands_without_products: 4,
    total_base_items: 20,
    low_stock_base_items: 6,
    out_of_stock_base_items: 8,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTestClient() {
  return new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
        staleTime: 0,
        gcTime: 0,
      },
    },
  });
}

function renderDashboard(client: QueryClient) {
  return render(
    <QueryClientProvider client={client}>
      <ProjectManagerDashboard />
    </QueryClientProvider>,
  );
}

// ---------------------------------------------------------------------------
// Tests: initial render (real timers)
// ---------------------------------------------------------------------------

describe("ProjectManagerDashboard — initial render", () => {
  let client: QueryClient;

  beforeEach(() => {
    vi.clearAllMocks();
    client = makeTestClient();
  });

  afterEach(() => {
    client.clear();
  });

  it("shows loading skeletons while the query is in flight", () => {
    mockApiFetch.mockReturnValue(new Promise(() => {}));
    renderDashboard(client);
    const skeletons = screen.getAllByTestId("pm-stat-skeleton");
    expect(skeletons.length).toBe(10);
  });

  it("renders all six stat cards once the query resolves", async () => {
    mockApiFetch.mockResolvedValue(makeSummary({ total_brands: 7 }));
    renderDashboard(client);

    expect(await screen.findByText("7")).toBeInTheDocument();
  });

  it("replaces skeletons with values after data loads", async () => {
    mockApiFetch.mockResolvedValue(makeSummary());
    renderDashboard(client);

    await waitFor(() =>
      expect(screen.queryByTestId("pm-stat-skeleton")).not.toBeInTheDocument(),
    );
  });

  it("re-renders with updated counts when query data changes", async () => {
    mockApiFetch.mockResolvedValue(makeSummary({ total_brands: 3 }));
    renderDashboard(client);

    expect(await screen.findByText("3")).toBeInTheDocument();

    act(() => {
      client.setQueryData(
        ["dashboard-summary"],
        makeSummary({ total_brands: 9 }),
      );
    });

    expect(await screen.findByText("9")).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// Tests: auto-refresh / polling (fake timers)
// ---------------------------------------------------------------------------

describe("ProjectManagerDashboard — auto-refresh every 30 s", () => {
  let client: QueryClient;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    client = makeTestClient();
  });

  afterEach(() => {
    client.clear();
    vi.useRealTimers();
  });

  it("calls the API once on mount", async () => {
    mockApiFetch.mockResolvedValue(makeSummary());
    renderDashboard(client);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(mockApiFetch).toHaveBeenCalledTimes(1);
    expect(mockApiFetch).toHaveBeenCalledWith("/api/dashboard/summary");
  });

  it("calls the API a second time after 30 seconds", async () => {
    mockApiFetch.mockResolvedValue(makeSummary());
    renderDashboard(client);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(mockApiFetch).toHaveBeenCalledTimes(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });

    expect(mockApiFetch).toHaveBeenCalledTimes(2);
  });

  it("does not call the API again before 30 seconds have elapsed", async () => {
    mockApiFetch.mockResolvedValue(makeSummary());
    renderDashboard(client);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(29_999);
    });

    expect(mockApiFetch).toHaveBeenCalledTimes(1);
  });

  it("calls the API a third time after 60 seconds total", async () => {
    mockApiFetch.mockResolvedValue(makeSummary());
    renderDashboard(client);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });

    expect(mockApiFetch).toHaveBeenCalledTimes(3);
  });

  it("stores fresh data in the query cache after the 30-second refetch", async () => {
    mockApiFetch
      .mockResolvedValueOnce(makeSummary({ total_brands: 3 }))
      .mockResolvedValueOnce(makeSummary({ total_brands: 9 }));

    renderDashboard(client);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(client.getQueryData(["dashboard-summary"])).toMatchObject({
      total_brands: 3,
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });

    expect(client.getQueryData(["dashboard-summary"])).toMatchObject({
      total_brands: 9,
    });
  });

  it("uses the query key 'dashboard-summary'", async () => {
    mockApiFetch.mockResolvedValue(makeSummary());
    renderDashboard(client);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    const queryCache = client.getQueryCache().getAll();
    const dashboardQuery = queryCache.find(
      (q) => q.queryKey[0] === "dashboard-summary",
    );
    expect(dashboardQuery).toBeDefined();
  });
});

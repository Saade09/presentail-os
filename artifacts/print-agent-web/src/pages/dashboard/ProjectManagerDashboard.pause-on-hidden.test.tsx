import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, act } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import ProjectManagerDashboard from "./ProjectManagerDashboard";
import { apiFetch } from "@/lib/queryClient";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

let mockIsVisible = true;

vi.mock("@/hooks/use-document-visibility", () => ({
  useDocumentVisibility: () => mockIsVisible,
}));

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
// Helpers
// ---------------------------------------------------------------------------

function makeSummary() {
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
  };
}

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
// Tests: pause on hidden
// ---------------------------------------------------------------------------

describe("ProjectManagerDashboard — pauses polling when tab is hidden", () => {
  let client: QueryClient;

  beforeEach(() => {
    mockIsVisible = true;
    vi.clearAllMocks();
    vi.useFakeTimers();
    client = makeTestClient();
  });

  afterEach(() => {
    client.clear();
    vi.useRealTimers();
  });

  it("does not refetch after 30 s when the tab is hidden", async () => {
    mockApiFetch.mockResolvedValue(makeSummary());
    mockIsVisible = false;

    renderDashboard(client);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    const callsAfterMount = mockApiFetch.mock.calls.length;

    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });

    expect(mockApiFetch).toHaveBeenCalledTimes(callsAfterMount);
  });

  it("does not refetch after 60 s when the tab stays hidden", async () => {
    mockApiFetch.mockResolvedValue(makeSummary());
    mockIsVisible = false;

    renderDashboard(client);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    const callsAfterMount = mockApiFetch.mock.calls.length;

    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });

    expect(mockApiFetch).toHaveBeenCalledTimes(callsAfterMount);
  });

  it("resumes polling after 30 s once the tab becomes visible again", async () => {
    mockApiFetch.mockResolvedValue(makeSummary());
    mockIsVisible = true;

    const { rerender } = renderDashboard(client);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(mockApiFetch).toHaveBeenCalledTimes(1);

    mockIsVisible = false;
    rerender(
      <QueryClientProvider client={client}>
        <ProjectManagerDashboard />
      </QueryClientProvider>,
    );

    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });

    const callsWhileHidden = mockApiFetch.mock.calls.length;

    mockIsVisible = true;
    rerender(
      <QueryClientProvider client={client}>
        <ProjectManagerDashboard />
      </QueryClientProvider>,
    );

    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(mockApiFetch.mock.calls.length).toBeGreaterThan(callsWhileHidden);
  });

  it("polls every 30 s while visible and immediately stops when hidden", async () => {
    mockApiFetch.mockResolvedValue(makeSummary());
    mockIsVisible = true;

    const { rerender } = renderDashboard(client);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(mockApiFetch).toHaveBeenCalledTimes(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });

    expect(mockApiFetch).toHaveBeenCalledTimes(2);

    mockIsVisible = false;
    rerender(
      <QueryClientProvider client={client}>
        <ProjectManagerDashboard />
      </QueryClientProvider>,
    );

    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });

    expect(mockApiFetch).toHaveBeenCalledTimes(2);
  });
});

// ---------------------------------------------------------------------------
// Tests: immediate refetch on tab-focus
// ---------------------------------------------------------------------------

describe("ProjectManagerDashboard — immediately refetches when switching back to the tab", () => {
  let client: QueryClient;

  beforeEach(() => {
    mockIsVisible = true;
    vi.clearAllMocks();
    vi.useFakeTimers();
    client = makeTestClient();
  });

  afterEach(() => {
    client.clear();
    vi.useRealTimers();
  });

  it("calls refetch immediately when isVisible flips from false to true (no 30 s wait)", async () => {
    mockApiFetch.mockResolvedValue(makeSummary());
    mockIsVisible = false;

    const { rerender } = renderDashboard(client);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    const callsWhileHidden = mockApiFetch.mock.calls.length;

    mockIsVisible = true;
    rerender(
      <QueryClientProvider client={client}>
        <ProjectManagerDashboard />
      </QueryClientProvider>,
    );

    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(mockApiFetch.mock.calls.length).toBe(callsWhileHidden + 1);
  });

  it("does not fire a spurious refetch when the tab was already visible on re-render", async () => {
    mockApiFetch.mockResolvedValue(makeSummary());
    mockIsVisible = true;

    const { rerender } = renderDashboard(client);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    const callsAfterMount = mockApiFetch.mock.calls.length;

    rerender(
      <QueryClientProvider client={client}>
        <ProjectManagerDashboard />
      </QueryClientProvider>,
    );

    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(mockApiFetch.mock.calls.length).toBe(callsAfterMount);
  });
});

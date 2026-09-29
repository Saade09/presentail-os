import { renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockApiFetch } = vi.hoisted(() => ({
  mockApiFetch: vi.fn(),
}));

vi.mock("@/lib/queryClient", () => ({
  apiFetch: mockApiFetch,
}));

import { useRecipeBenchmarkComparison } from "./use-recipe-benchmarks";

function createWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
  };
}

describe("useRecipeBenchmarkComparison", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockApiFetch.mockResolvedValue({
      baseline: {},
      candidate: {},
      comparability: { comparable: true, reasons: [] },
      regression_gate: { status: "pass", flagged_formats: [] },
      canonical_failures: [],
    });
  });

  it("loads the selected pair through the authoritative comparison endpoint", async () => {
    const { result } = renderHook(() => useRecipeBenchmarkComparison(12, 34), {
      wrapper: createWrapper(),
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(mockApiFetch).toHaveBeenCalledTimes(1);
    expect(mockApiFetch).toHaveBeenCalledWith(
      "/api/products/recipe-benchmarks/compare?baseline_run_id=12&candidate_run_id=34",
    );
  });

  it("does not issue a request until two different validated run IDs exist", () => {
    renderHook(() => useRecipeBenchmarkComparison(12, 12), {
      wrapper: createWrapper(),
    });

    expect(mockApiFetch).not.toHaveBeenCalled();
  });
});
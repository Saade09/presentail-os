/**
 * CmcPosSale — shared-shift warning behavior.
 *
 * Shelf sales are allowed against the location's open shift regardless of
 * who opened it: when the active-shift endpoint returns a shift (even one
 * opened by another user) the page must NOT show the "no active shift"
 * cash warning; when no shift is open, the warning's Start Shift link must
 * point at the CMC POS dashboard (/cmc-pos) — never the permission-gated
 * cash-drawer page that renders blank for limited users.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Router } from "wouter";

vi.mock("@/lib/queryClient", () => ({
  apiFetch: vi.fn(),
  queryClient: new (require("@tanstack/react-query").QueryClient)(),
}));

vi.mock("@/hooks/use-toast", () => ({
  toast: vi.fn(),
}));

function makeWrapper() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={qc}>
      <Router>{children}</Router>
    </QueryClientProvider>
  );
}

// A shift opened by ANOTHER user — the endpoint is location-scoped, so this
// is what any team member sees when a colleague opened the session.
const SHARED_SHIFT = {
  id: 9,
  location_id: 42,
  location_name: "CMC Beirut Hospital",
  opened_at: new Date().toISOString(),
  opened_by_user_id: "user_someone_else",
};

async function getApiFetch() {
  const mod = await import("@/lib/queryClient");
  return mod as typeof mod & { apiFetch: ReturnType<typeof vi.fn> };
}

function mockApis(shift: unknown) {
  return async (url: string) => {
    if (url.includes("shifts/active")) return { shift };
    if (url.includes("shelf-products")) return { products: [] };
    if (url.includes("/api/locations")) return { locations: [{ id: 42, name: "CMC Beirut Hospital" }] };
    return {};
  };
}

describe("CmcPosSale — shared open shift", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("shows the active shift badge and no cash warning when another user's shift is open", async () => {
    const mod = await getApiFetch();
    mod.apiFetch.mockImplementation(mockApis(SHARED_SHIFT));

    const { default: CmcPosSale } = await import("./CmcPosSale");
    render(<CmcPosSale />, { wrapper: makeWrapper() });

    // Active shift badge appears (location name)
    await screen.findByText(/CMC Beirut Hospital/);
    // No cash-gate warning
    expect(
      screen.queryByText(/Start a cash drawer shift before recording a cash sale/),
    ).not.toBeInTheDocument();
  });

  it("shows the cash warning with a Start Shift link to /cmc-pos when no shift is open", async () => {
    const mod = await getApiFetch();
    mod.apiFetch.mockImplementation(mockApis(null));

    const { default: CmcPosSale } = await import("./CmcPosSale");
    render(<CmcPosSale />, { wrapper: makeWrapper() });

    await waitFor(() => {
      expect(
        screen.getByText(/Start a cash drawer shift before recording a cash sale/),
      ).toBeInTheDocument();
    });

    const link = screen.getByRole("link", { name: "Start Shift" });
    expect(link).toHaveAttribute("href", "/cmc-pos");
  });
});

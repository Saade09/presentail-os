import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import SettingsPage from "./Settings";

vi.mock("@/lib/queryClient", () => ({
  apiFetch: vi.fn(),
  getClerkToken: vi.fn().mockResolvedValue(null),
}));

vi.mock("@/hooks/use-toast", () => ({
  useToast: () => ({ toast: vi.fn() }),
}));

vi.mock("@/contexts/simulated-role-context", () => ({
  useSimulatedRole: () => ({ simulatedRole: null, setSimulatedRole: vi.fn() }),
}));

vi.mock("@/hooks/use-workspace-role", () => ({
  useWorkspaceRole: () => ({ role: "owner", isOwner: true, realRole: "owner" }),
}));

const mockUseQuery = vi.fn();
vi.mock("@tanstack/react-query", () => ({
  useQuery: (...args: unknown[]) => mockUseQuery(...args),
  useMutation: vi.fn(() => ({ mutate: vi.fn(), isPending: false })),
  useQueryClient: vi.fn(() => ({ setQueryData: vi.fn(), invalidateQueries: vi.fn() })),
}));

function makeRatesResponse(lastFetchedAt: string | null) {
  return {
    base_currency: "USD",
    rates: [
      { base_currency: "USD", target_currency: "AED", rate: 3.67, fetched_at: lastFetchedAt ?? "" },
    ],
    last_fetched_at: lastFetchedAt,
  };
}

function hoursAgoIso(hours: number): string {
  return new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();
}

function setupQueryMock(lastFetchedAt: string | null) {
  mockUseQuery.mockImplementation(({ queryKey }: { queryKey: string[] }) => {
    if (queryKey[0] === "exchange-rates") {
      return { data: makeRatesResponse(lastFetchedAt), isLoading: false };
    }
    if (queryKey[0] === "exchange-rate-settings") {
      return {
        data: {
          default_markup_percentage: 0,
          rounding_rule: "round_up_whole",
          base_currency: "USD",
          created_at: null,
          updated_at: null,
        },
        isLoading: false,
      };
    }
    return { data: undefined, isLoading: false };
  });
}

describe("ExchangeRatesCard – stale-rates warning", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("shows the stale warning when last_fetched_at is null", () => {
    setupQueryMock(null);
    render(<SettingsPage />);
    expect(screen.getByTestId("exchange-rates-stale-warning")).toBeInTheDocument();
    expect(screen.getByTestId("exchange-rates-stale-warning")).toHaveTextContent(
      "Exchange rates haven't been refreshed in over 24 hours",
    );
    expect(screen.getByTestId("exchange-rates-stale-warning")).toHaveTextContent("Refresh now");
  });

  it("shows the stale warning when rates are 25 hours old", () => {
    setupQueryMock(hoursAgoIso(25));
    render(<SettingsPage />);
    expect(screen.getByTestId("exchange-rates-stale-warning")).toBeInTheDocument();
  });

  it("does not show the stale warning when rates are 1 hour old", () => {
    setupQueryMock(hoursAgoIso(1));
    render(<SettingsPage />);
    expect(screen.queryByTestId("exchange-rates-stale-warning")).not.toBeInTheDocument();
  });

  it("does not show the stale warning when rates are 23 hours old", () => {
    setupQueryMock(hoursAgoIso(23));
    render(<SettingsPage />);
    expect(screen.queryByTestId("exchange-rates-stale-warning")).not.toBeInTheDocument();
  });

  it("does not show the stale warning while rates are still loading", () => {
    mockUseQuery.mockImplementation(({ queryKey }: { queryKey: string[] }) => {
      if (queryKey[0] === "exchange-rates") {
        return { data: undefined, isLoading: true };
      }
      return { data: undefined, isLoading: false };
    });
    render(<SettingsPage />);
    expect(screen.queryByTestId("exchange-rates-stale-warning")).not.toBeInTheDocument();
  });

  it("warning has role=alert for accessibility", () => {
    setupQueryMock(null);
    render(<SettingsPage />);
    const warning = screen.getByTestId("exchange-rates-stale-warning");
    expect(warning).toHaveAttribute("role", "alert");
  });
});

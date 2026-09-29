import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import TimeOffMyPage from "./TimeOffMyPage";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock("@/hooks/use-workspace-role", () => ({
  useWorkspaceRole: () => ({ allowedPages: null, loaded: true }),
}));

const mockUseGetTimeOffBalance = vi.fn();

vi.mock("@workspace/api-client-react", () => ({
  useGetTimeOffBalance: () => mockUseGetTimeOffBalance(),
  useGetTimeOffBalanceAdjustments: () => ({ data: { adjustments: [] } }),
  useListTimeOffRequests: () => ({ data: { requests: [] }, isLoading: false }),
  useCancelTimeOffRequest: () => ({ mutateAsync: vi.fn() }),
  useListMyPublicHolidays: () => ({ data: { holidays: [] } }),
  getGetTimeOffBalanceQueryKey: () => ["balance"],
  getListTimeOffRequestsQueryKey: () => ["requests"],
}));

vi.mock("@tanstack/react-query", () => ({
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
  useQuery: () => ({ data: undefined, isLoading: false }),
  QueryClient: class {
    setQueryData = vi.fn();
    getQueryData = vi.fn();
    invalidateQueries = vi.fn();
  },
  QueryCache: class {
    constructor(_opts?: unknown) {}
  },
}));

vi.mock("@/hooks/use-toast", () => ({
  useToast: () => ({ toast: vi.fn() }),
}));

vi.mock("@/components/RequestTimeOffDialog", () => ({
  RequestTimeOffDialog: () => null,
}));

vi.mock("wouter", () => ({
  Link: ({ href, children }: { href: string; children: React.ReactNode }) => (
    <a href={href}>{children}</a>
  ),
}));

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeBalance(overrides: Record<string, unknown> = {}) {
  return {
    id: 1,
    member_id: 10,
    policy_id: 2,
    policy_year: 2026,
    vacation_entitled: "15",
    vacation_used: "4",
    vacation_pending: "2.5",
    vacation_carryover: "0",
    vacation_remaining: 8.5,
    sick_leave_entitled: "10",
    sick_leave_used: "1",
    sick_leave_pending: "0",
    manager_name: null,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("TimeOffMyPage – balance cards", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders all four balance cards with correct values", () => {
    mockUseGetTimeOffBalance.mockReturnValue({
      data: { balance: makeBalance() },
      isLoading: false,
    });

    render(<TimeOffMyPage />);

    // Vacation Left card
    expect(screen.getByText("Vacation Left")).toBeInTheDocument();
    expect(screen.getByText("8.5")).toBeInTheDocument();
    expect(screen.getByText("of 15 days")).toBeInTheDocument();

    // Pending card
    expect(screen.getByText("Pending")).toBeInTheDocument();
    expect(screen.getByText("2.5")).toBeInTheDocument();
    expect(screen.getByText("awaiting approval")).toBeInTheDocument();

    // Vacation Used card
    expect(screen.getByText("Vacation Used")).toBeInTheDocument();
    expect(screen.getByText("4.0")).toBeInTheDocument();
    expect(screen.getByText("this year")).toBeInTheDocument();

    // Sick Used card
    expect(screen.getByText("Sick Used")).toBeInTheDocument();
    expect(screen.getByText("1.0")).toBeInTheDocument();
    expect(screen.getByText("of 10")).toBeInTheDocument();
  });

  it("shows 'no limit' for sick leave when sick_leave_entitled is null", () => {
    mockUseGetTimeOffBalance.mockReturnValue({
      data: { balance: makeBalance({ sick_leave_entitled: null }) },
      isLoading: false,
    });

    render(<TimeOffMyPage />);

    expect(screen.getByText("no limit")).toBeInTheDocument();
  });

  it("shows the Carried Over card when vacation_carryover is greater than 0", () => {
    mockUseGetTimeOffBalance.mockReturnValue({
      data: {
        balance: makeBalance({
          vacation_carryover: "3",
          vacation_remaining: 11.5,
        }),
      },
      isLoading: false,
    });

    render(<TimeOffMyPage />);

    expect(screen.getByText("Carried Over")).toBeInTheDocument();
    expect(screen.getByText("3.0")).toBeInTheDocument();
    expect(screen.getByText("from last year")).toBeInTheDocument();
  });

  it("does not show the Carried Over card when vacation_carryover is 0", () => {
    mockUseGetTimeOffBalance.mockReturnValue({
      data: { balance: makeBalance({ vacation_carryover: "0" }) },
      isLoading: false,
    });

    render(<TimeOffMyPage />);

    expect(screen.queryByText("Carried Over")).not.toBeInTheDocument();
    expect(screen.queryByText("from last year")).not.toBeInTheDocument();
  });

  it("renders loading skeletons while balance is loading", () => {
    mockUseGetTimeOffBalance.mockReturnValue({
      data: undefined,
      isLoading: true,
    });

    render(<TimeOffMyPage />);

    // No balance cards shown, no values
    expect(screen.queryByText("Vacation Left")).not.toBeInTheDocument();
    expect(screen.queryByText("Sick Used")).not.toBeInTheDocument();
  });
});

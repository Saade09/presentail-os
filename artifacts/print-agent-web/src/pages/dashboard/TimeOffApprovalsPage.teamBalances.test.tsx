import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import TimeOffApprovalsPage from "./TimeOffApprovalsPage";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockUseListTeamTimeOffBalances = vi.fn();

vi.mock("@workspace/api-client-react", () => ({
  useListTeamTimeOffRequests: () => ({ data: { requests: [] }, isLoading: false, error: null }),
  useListTeamTimeOffBalances: () => mockUseListTeamTimeOffBalances(),
  useApproveTimeOffRequest: () => ({ mutate: vi.fn(), isPending: false }),
  useDeclineTimeOffRequest: () => ({
    mutate: vi.fn(),
    isPending: false,
    onSuccess: undefined,
    onError: undefined,
  }),
  useCancelTimeOffRequest: () => ({ mutateAsync: vi.fn() }),
  getListTeamTimeOffRequestsQueryKey: () => ["team-requests"],
  ListTeamTimeOffRequestsStatus: {
    PENDING: "PENDING",
    APPROVED: "APPROVED",
    DECLINED: "DECLINED",
    CANCELLED: "CANCELLED",
  },
  markAllTimeOffRequestNotificationsSeen: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@tanstack/react-query", () => ({
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
  useQuery: () => ({ data: undefined, isLoading: false }),
}));

vi.mock("@/hooks/use-toast", () => ({
  useToast: () => ({ toast: vi.fn() }),
}));

vi.mock("@/hooks/use-time-off-notifications", () => ({
  getTimeOffNotificationsQueryKey: () => ["time-off-notifications"],
}));

vi.mock("@/lib/queryClient", () => ({
  apiFetch: vi.fn().mockResolvedValue({}),
}));

vi.mock("@/components/MemberHoverCard", () => ({
  MemberHoverCard: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

vi.mock("@clerk/react", () => ({
  useAuth: () => ({ isSignedIn: true, userId: "user_123" }),
  useUser: () => ({
    user: { id: "user_123", firstName: "Test", lastName: "User", imageUrl: null },
    isLoaded: true,
  }),
}));

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeBalance(overrides: Record<string, unknown> = {}) {
  return {
    member_id: 10,
    member_name: "Alice Smith",
    member_email: "alice@example.com",
    policy_year: 2026,
    vacation_entitled: 15,
    vacation_used: 4,
    vacation_pending: 2,
    vacation_carryover: 0,
    vacation_remaining: 9,
    sick_leave_entitled: 10,
    sick_leave_used: 1,
    sick_leave_pending: 0,
    has_policy: true,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks();
  mockUseListTeamTimeOffBalances.mockReturnValue({
    data: { balances: [] },
    isLoading: false,
    isError: false,
  });
});

describe("TeamBalancesSection – via TimeOffApprovalsPage", () => {
  it("renders nothing when the balances list is empty", () => {
    mockUseListTeamTimeOffBalances.mockReturnValue({
      data: { balances: [] },
      isLoading: false,
      isError: false,
    });

    render(<TimeOffApprovalsPage />);

    expect(screen.queryByText("Team Balances")).not.toBeInTheDocument();
  });

  it("renders the Team Balances card heading when there is at least one balance", () => {
    mockUseListTeamTimeOffBalances.mockReturnValue({
      data: { balances: [makeBalance()] },
      isLoading: false,
      isError: false,
    });

    render(<TimeOffApprovalsPage />);

    expect(screen.getByText("Team Balances")).toBeInTheDocument();
  });

  it("renders member name, email, and balance figures for a member with a policy", () => {
    mockUseListTeamTimeOffBalances.mockReturnValue({
      data: { balances: [makeBalance()] },
      isLoading: false,
      isError: false,
    });

    render(<TimeOffApprovalsPage />);

    expect(screen.getByText("Alice Smith")).toBeInTheDocument();
    expect(screen.getByText("alice@example.com")).toBeInTheDocument();
    expect(screen.getByText("9.0")).toBeInTheDocument();
    expect(screen.getByText("2.0")).toBeInTheDocument();
    expect(screen.getByText("1.0")).toBeInTheDocument();
  });

  it("renders 'No policy' badge for a member without a policy", () => {
    mockUseListTeamTimeOffBalances.mockReturnValue({
      data: {
        balances: [
          makeBalance({
            has_policy: false,
            vacation_entitled: null,
            vacation_used: null,
            vacation_pending: null,
            vacation_carryover: null,
            vacation_remaining: null,
            sick_leave_entitled: null,
            sick_leave_used: null,
            sick_leave_pending: null,
          }),
        ],
      },
      isLoading: false,
      isError: false,
    });

    render(<TimeOffApprovalsPage />);

    expect(screen.getByText("No policy")).toBeInTheDocument();
    expect(screen.queryByText("9.0")).not.toBeInTheDocument();
  });

  it("renders loading skeletons when balances are loading", () => {
    mockUseListTeamTimeOffBalances.mockReturnValue({
      data: undefined,
      isLoading: true,
      isError: false,
    });

    render(<TimeOffApprovalsPage />);

    expect(screen.getByText("Team Balances")).toBeInTheDocument();
    expect(screen.queryByText("Alice Smith")).not.toBeInTheDocument();
  });

  it("renders an error message when balances fail to load", () => {
    mockUseListTeamTimeOffBalances.mockReturnValue({
      data: undefined,
      isLoading: false,
      isError: true,
    });

    render(<TimeOffApprovalsPage />);

    expect(screen.getByText("Team Balances")).toBeInTheDocument();
    expect(screen.getByText(/failed to load team balances/i)).toBeInTheDocument();
  });

  it("renders multiple team members when the team has multiple direct reports", () => {
    mockUseListTeamTimeOffBalances.mockReturnValue({
      data: {
        balances: [
          makeBalance({ member_id: 10, member_name: "Alice Smith", member_email: "alice@example.com" }),
          makeBalance({
            member_id: 11,
            member_name: "Bob Jones",
            member_email: "bob@example.com",
            vacation_remaining: 12,
          }),
        ],
      },
      isLoading: false,
      isError: false,
    });

    render(<TimeOffApprovalsPage />);

    expect(screen.getByText("Alice Smith")).toBeInTheDocument();
    expect(screen.getByText("Bob Jones")).toBeInTheDocument();
    expect(screen.getByText("alice@example.com")).toBeInTheDocument();
    expect(screen.getByText("bob@example.com")).toBeInTheDocument();
  });

  it("shows the first letter of the member name as the avatar initial", () => {
    mockUseListTeamTimeOffBalances.mockReturnValue({
      data: { balances: [makeBalance()] },
      isLoading: false,
      isError: false,
    });

    render(<TimeOffApprovalsPage />);

    expect(screen.getByText("A")).toBeInTheDocument();
  });

  it("falls back to the first letter of the email when member_name is empty", () => {
    mockUseListTeamTimeOffBalances.mockReturnValue({
      data: {
        balances: [makeBalance({ member_name: "", member_email: "charlie@example.com" })],
      },
      isLoading: false,
      isError: false,
    });

    render(<TimeOffApprovalsPage />);

    expect(screen.getByText("C")).toBeInTheDocument();
  });
});

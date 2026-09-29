import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import TimeOffMyPage from "./TimeOffMyPage";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock("@/hooks/use-workspace-role", () => ({
  useWorkspaceRole: () => ({ allowedPages: null, loaded: true }),
}));

const mockUseGetTimeOffBalanceAdjustments = vi.fn();

vi.mock("@workspace/api-client-react", () => ({
  useGetTimeOffBalance: () => ({
    data: {
      balance: {
        id: 1,
        member_id: 10,
        policy_id: 2,
        policy_year: 2026,
        vacation_entitled: "18",
        vacation_used: "4",
        vacation_pending: "0",
        vacation_carryover: "0",
        vacation_remaining: 14,
        sick_leave_entitled: "10",
        sick_leave_used: "0",
        sick_leave_pending: "0",
        manager_name: null,
      },
    },
    isLoading: false,
  }),
  useGetTimeOffBalanceAdjustments: () => mockUseGetTimeOffBalanceAdjustments(),
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

function makeAdjustment(overrides: Record<string, unknown> = {}) {
  return {
    id: 42,
    policy_year: 2026,
    vacation_entitled_before: 15,
    vacation_entitled_after: 18,
    amount_changed: 3,
    reason: "Annual grant top-up",
    adjusted_by_name: "Jane Smith",
    adjusted_at: "2026-01-15T10:30:00.000Z",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("TimeOffMyPage – Balance Adjustments section", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders the Balance Adjustments card when adjustments exist", () => {
    mockUseGetTimeOffBalanceAdjustments.mockReturnValue({
      data: { adjustments: [makeAdjustment()] },
    });

    render(<TimeOffMyPage />);

    expect(screen.getByText("Balance Adjustments")).toBeInTheDocument();
  });

  it("shows the adjuster name in the adjustment row", () => {
    mockUseGetTimeOffBalanceAdjustments.mockReturnValue({
      data: { adjustments: [makeAdjustment()] },
    });

    render(<TimeOffMyPage />);

    expect(screen.getByText(/Adjusted by Jane Smith/i)).toBeInTheDocument();
  });

  it("shows the formatted adjustment date in the adjustment row", () => {
    const adjustedAt = "2026-01-15T10:30:00.000Z";
    const expectedDate = new Date(adjustedAt).toLocaleDateString(undefined, {
      year: "numeric",
      month: "short",
      day: "numeric",
    });

    mockUseGetTimeOffBalanceAdjustments.mockReturnValue({
      data: { adjustments: [makeAdjustment({ adjusted_at: adjustedAt })] },
    });

    render(<TimeOffMyPage />);

    expect(screen.getByText(expectedDate)).toBeInTheDocument();
  });

  it("shows the adjustment reason in the adjustment row", () => {
    mockUseGetTimeOffBalanceAdjustments.mockReturnValue({
      data: { adjustments: [makeAdjustment()] },
    });

    render(<TimeOffMyPage />);

    expect(screen.getByText(/"Annual grant top-up"/i)).toBeInTheDocument();
  });

  it("shows the before → after entitlement and policy year", () => {
    mockUseGetTimeOffBalanceAdjustments.mockReturnValue({
      data: { adjustments: [makeAdjustment()] },
    });

    render(<TimeOffMyPage />);

    // e.g. "Vacation entitlement: 15 → 18 days"
    expect(
      screen.getByText(/Vacation entitlement: 15 → 18 days/i),
    ).toBeInTheDocument();
    expect(screen.getByText(/\(2026\)/)).toBeInTheDocument();
  });

  it("shows a positive delta badge for increases", () => {
    mockUseGetTimeOffBalanceAdjustments.mockReturnValue({
      data: { adjustments: [makeAdjustment({ amount_changed: 3 })] },
    });

    render(<TimeOffMyPage />);

    // delta badge shows "+3 d"
    expect(screen.getByText("+3 d")).toBeInTheDocument();
  });

  it("shows a negative delta badge for decreases", () => {
    mockUseGetTimeOffBalanceAdjustments.mockReturnValue({
      data: {
        adjustments: [
          makeAdjustment({
            vacation_entitled_before: 18,
            vacation_entitled_after: 15,
            amount_changed: -3,
          }),
        ],
      },
    });

    render(<TimeOffMyPage />);

    expect(screen.getByText("-3 d")).toBeInTheDocument();
  });

  it("hides the Balance Adjustments card when there are no adjustments", () => {
    mockUseGetTimeOffBalanceAdjustments.mockReturnValue({
      data: { adjustments: [] },
    });

    render(<TimeOffMyPage />);

    expect(screen.queryByText("Balance Adjustments")).not.toBeInTheDocument();
  });

  it("hides the Balance Adjustments card while adjustments data is undefined", () => {
    mockUseGetTimeOffBalanceAdjustments.mockReturnValue({ data: undefined });

    render(<TimeOffMyPage />);

    expect(screen.queryByText("Balance Adjustments")).not.toBeInTheDocument();
  });

  it("renders multiple adjustment rows when there are several adjustments", () => {
    mockUseGetTimeOffBalanceAdjustments.mockReturnValue({
      data: {
        adjustments: [
          makeAdjustment({ id: 1, reason: "First adjustment", adjusted_by_name: "Alice" }),
          makeAdjustment({ id: 2, reason: "Second adjustment", adjusted_by_name: "Bob" }),
        ],
      },
    });

    render(<TimeOffMyPage />);

    expect(screen.getByText(/"First adjustment"/i)).toBeInTheDocument();
    expect(screen.getByText(/"Second adjustment"/i)).toBeInTheDocument();
    expect(screen.getByText(/Adjusted by Alice/i)).toBeInTheDocument();
    expect(screen.getByText(/Adjusted by Bob/i)).toBeInTheDocument();
  });
});

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock("wouter", () => ({
  Link: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  useParams: () => ({ id: "7" }),
  useLocation: () => ["/cash-sessions/7/close", vi.fn()],
}));

vi.mock("@/lib/queryClient", () => ({
  apiFetch: vi.fn(),
  getClerkToken: vi.fn().mockResolvedValue("tok"),
}));

vi.mock("@/hooks/use-toast", () => ({
  useToast: () => ({ toast: vi.fn() }),
}));

let mockIsOwner = true;
vi.mock("@/hooks/use-workspace-role", () => ({
  useWorkspaceRole: () => ({ isOwner: mockIsOwner, allowedPages: null }),
}));

let mockUserId = "user_abc";
vi.mock("@clerk/react", () => ({
  useUser: () => ({ user: { id: mockUserId } }),
}));

// Controllable session fixture.
let mockSession: Record<string, unknown> = {};
let mockSummary: Record<string, unknown>[] = [];

vi.mock("@tanstack/react-query", () => ({
  useQuery: () => ({
    data: {
      session: mockSession,
      currency_summary: mockSummary,
      transactions: [],
      activity: [],
    },
    isLoading: false,
  }),
  useMutation: () => ({ mutate: vi.fn(), isPending: false }),
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
}));

import CashSessionClose from "./CashSessionClose";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function openSession(reconciliation: unknown = null) {
  return {
    id: 7,
    session_number: "CS-001",
    status: "open",
    currency: "USD",
    secondary_currency: null,
    opening_cash: "100.00",
    reconciliation,
  };
}

const usdSummary = {
  currency: "USD",
  opening_cash: 100,
  sales_collected: 0,
  expenses_paid: 0,
  adjustments: 0,
  expected_cash: 100,
};

function countedRec(counts: Record<string, unknown>[]) {
  return {
    started_at: "2026-07-17T00:00:00.000Z",
    started_by_clerk_id: "user_abc",
    counted_at: "2026-07-17T00:05:00.000Z",
    counted_by_clerk_id: "user_abc",
    tx_count: 0,
    last_tx_id: null,
    counts,
  };
}

function pendingApprovalCount() {
  return {
    currency: "USD",
    expected: 100,
    actual: 130,
    variance: 30,
    explanation: "note",
    requires_approval: true,
    approval: {
      status: "pending",
      requested_at: "2026-07-17T00:05:00.000Z",
      decided_by_clerk_id: null,
      decided_at: null,
      note: null,
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockIsOwner = true;
  mockUserId = "user_abc";
  mockSummary = [usdSummary];
  mockSession = openSession();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("CashSessionClose wizard", () => {
  it("starts on the blind count step and never shows the expected total", () => {
    render(<CashSessionClose />);
    expect(screen.getByTestId("button-submit-counts")).toBeInTheDocument();
    expect(screen.getByTestId("input-counted-USD")).toBeInTheDocument();
    // Blind: the expected cash amount must not be visible on step 1.
    expect(screen.queryByText(/100\.00/)).not.toBeInTheDocument();
  });

  it("moves to the variance step when counts already exist on the server", () => {
    mockSession = openSession(
      countedRec([
        {
          currency: "USD",
          expected: 100,
          actual: 95,
          variance: -5,
          explanation: null,
          requires_approval: false,
          approval: null,
        },
      ]),
    );
    render(<CashSessionClose />);
    expect(screen.getByTestId("review-block-USD")).toBeInTheDocument();
    expect(screen.getByTestId("text-variance-USD")).toHaveTextContent("5.00");
    expect(screen.getByTestId("button-recount")).toBeInTheDocument();
  });

  it("hides approve/reject for the user who submitted the counts", () => {
    mockSession = openSession(countedRec([pendingApprovalCount()]));
    render(<CashSessionClose />);
    expect(screen.queryByTestId("button-approve-USD")).not.toBeInTheDocument();
    expect(screen.queryByTestId("button-reject-USD")).not.toBeInTheDocument();
  });

  it("shows approve/reject to a different supervisor", () => {
    mockUserId = "user_supervisor";
    mockSession = openSession(countedRec([pendingApprovalCount()]));
    render(<CashSessionClose />);
    expect(screen.getByTestId("button-approve-USD")).toBeInTheDocument();
    expect(screen.getByTestId("button-reject-USD")).toBeInTheDocument();
  });

  it("blocks continuing to confirm while an approval is pending", () => {
    mockSession = openSession(countedRec([pendingApprovalCount()]));
    render(<CashSessionClose />);
    expect(screen.getByTestId("button-to-confirm")).toBeDisabled();
  });

  it("keeps the close button disabled until the confirmation box is checked", async () => {
    const user = userEvent.setup();
    mockSession = openSession(
      countedRec([
        {
          currency: "USD",
          expected: 100,
          actual: 100,
          variance: 0,
          explanation: null,
          requires_approval: false,
          approval: null,
        },
      ]),
    );
    render(<CashSessionClose />);
    // Advance to step 3.
    await user.click(screen.getByTestId("button-to-confirm"));
    const closeBtn = screen.getByTestId("button-close-session");
    expect(closeBtn).toBeDisabled();
    await user.click(screen.getByTestId("checkbox-confirm"));
    expect(closeBtn).not.toBeDisabled();
  });
});

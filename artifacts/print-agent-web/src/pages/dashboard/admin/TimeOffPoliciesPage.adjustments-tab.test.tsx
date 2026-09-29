import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { AdjustmentsTab } from "./TimeOffPoliciesPage";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockUseListTimeOffPolicyAssignees = vi.fn();

vi.mock("@workspace/api-client-react", async () => {
  const actual = await vi.importActual<typeof import("@workspace/api-client-react")>(
    "@workspace/api-client-react",
  );
  return {
    ...actual,
    useListTimeOffPolicyAssignees: (policyId: number) => mockUseListTimeOffPolicyAssignees(policyId),
    getMemberTimeOffBalanceAdjustments: vi.fn(),
  };
});

vi.mock("@tanstack/react-query", async () => {
  const actual = await vi.importActual<typeof import("@tanstack/react-query")>(
    "@tanstack/react-query",
  );
  return {
    ...actual,
    useQueries: ({ queries }: { queries: Array<Record<string, unknown>> }) => {
      // Map each query to its result. The test file will set
      // mockUseQueriesResults before rendering to control the data.
      return mockUseQueriesResults.splice(0, queries.length);
    },
  };
});

// Shared mutable state so each test can inject per-query results
let mockUseQueriesResults: Array<Record<string, unknown>> = [];

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeAssignee(overrides: Record<string, unknown> = {}) {
  return {
    member_id: 1,
    member_name: "Alice Jones",
    member_email: "alice@example.com",
    member_image_url: null,
    ...overrides,
  };
}

function makeAdjustment(overrides: Record<string, unknown> = {}) {
  return {
    id: 1,
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

describe("AdjustmentsTab", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUseQueriesResults = [];
  });

  it("shows loading state while assignees are loading", () => {
    mockUseListTimeOffPolicyAssignees.mockReturnValue({
      data: undefined,
      isLoading: true,
    });

    render(<AdjustmentsTab policyId={1} />);

    expect(screen.getByText(/Loading adjustments/i)).toBeInTheDocument();
  });

  it("shows empty state when there are no assignees", () => {
    mockUseListTimeOffPolicyAssignees.mockReturnValue({
      data: { assignees: [] },
      isLoading: false,
    });

    render(<AdjustmentsTab policyId={1} />);

    expect(screen.getByText("No adjustments yet")).toBeInTheDocument();
  });

  it("shows empty state when assignees have no adjustments", () => {
    mockUseListTimeOffPolicyAssignees.mockReturnValue({
      data: { assignees: [makeAssignee()] },
      isLoading: false,
    });
    mockUseQueriesResults = [{ data: { adjustments: [] }, isLoading: false }];

    render(<AdjustmentsTab policyId={1} />);

    expect(screen.getByText("No adjustments yet")).toBeInTheDocument();
  });

  it("renders a single adjustment row with all visible fields", () => {
    mockUseListTimeOffPolicyAssignees.mockReturnValue({
      data: { assignees: [makeAssignee({ member_id: 10, member_name: "Alice Jones" })] },
      isLoading: false,
    });
    mockUseQueriesResults = [
      { data: { adjustments: [makeAdjustment({ id: 101 })] }, isLoading: false },
    ];

    render(<AdjustmentsTab policyId={1} />);

    expect(screen.getByText("Alice Jones")).toBeInTheDocument();
    expect(screen.getByText(/15 → 18 days/i)).toBeInTheDocument();
    expect(screen.getByText(/\(2026\)/)).toBeInTheDocument();
    expect(screen.getByText("+3 d")).toBeInTheDocument();
    expect(screen.getByText(/Annual grant top-up/i)).toBeInTheDocument();
    expect(screen.getByText(/Adjusted by Jane Smith/i)).toBeInTheDocument();
    expect(
      screen.getByText(
        new Date("2026-01-15T10:30:00.000Z").toLocaleDateString(undefined, {
          year: "numeric",
          month: "short",
          day: "numeric",
        }),
      ),
    ).toBeInTheDocument();
  });

  it("renders multiple adjustments for the same member in the same year", () => {
    mockUseListTimeOffPolicyAssignees.mockReturnValue({
      data: { assignees: [makeAssignee({ member_id: 10, member_name: "Alice Jones" })] },
      isLoading: false,
    });
    mockUseQueriesResults = [
      {
        data: {
          adjustments: [
            makeAdjustment({
              id: 101,
              vacation_entitled_before: 15,
              vacation_entitled_after: 18,
              amount_changed: 3,
              adjusted_at: "2026-03-10T09:00:00.000Z",
            }),
            makeAdjustment({
              id: 102,
              vacation_entitled_before: 18,
              vacation_entitled_after: 20,
              amount_changed: 2,
              reason: "Extra bonus",
              adjusted_by_name: "Bob Admin",
              adjusted_at: "2026-06-20T14:00:00.000Z",
            }),
          ],
        },
        isLoading: false,
      },
    ];

    render(<AdjustmentsTab policyId={1} />);

    const aliceRows = screen.getAllByText("Alice Jones");
    expect(aliceRows).toHaveLength(2);

    expect(screen.getByText(/15 → 18 days/i)).toBeInTheDocument();
    expect(screen.getByText(/18 → 20 days/i)).toBeInTheDocument();
    expect(screen.getByText("+3 d")).toBeInTheDocument();
    expect(screen.getByText("+2 d")).toBeInTheDocument();
    expect(screen.getByText(/Annual grant top-up/i)).toBeInTheDocument();
    expect(screen.getByText(/Extra bonus/i)).toBeInTheDocument();
    expect(screen.getByText(/Adjusted by Jane Smith/i)).toBeInTheDocument();
    expect(screen.getByText(/Adjusted by Bob Admin/i)).toBeInTheDocument();
  });

  it("renders adjustments for different members and different years", () => {
    mockUseListTimeOffPolicyAssignees.mockReturnValue({
      data: {
        assignees: [
          makeAssignee({ member_id: 10, member_name: "Alice Jones" }),
          makeAssignee({ member_id: 20, member_name: "Bob Smith" }),
        ],
      },
      isLoading: false,
    });
    mockUseQueriesResults = [
      {
        data: {
          adjustments: [
            makeAdjustment({
              id: 101,
              policy_year: 2025,
              vacation_entitled_before: 12,
              vacation_entitled_after: 15,
              amount_changed: 3,
              adjusted_at: "2025-01-10T08:00:00.000Z",
            }),
            makeAdjustment({
              id: 102,
              policy_year: 2026,
              vacation_entitled_before: 15,
              vacation_entitled_after: 18,
              amount_changed: 3,
              adjusted_at: "2026-01-15T10:30:00.000Z",
            }),
          ],
        },
        isLoading: false,
      },
      {
        data: {
          adjustments: [
            makeAdjustment({
              id: 201,
              policy_year: 2026,
              vacation_entitled_before: 10,
              vacation_entitled_after: 14,
              amount_changed: 4,
              adjusted_by_name: "Carol Manager",
              adjusted_at: "2026-02-01T11:00:00.000Z",
            }),
          ],
        },
        isLoading: false,
      },
    ];

    render(<AdjustmentsTab policyId={1} />);

    expect(screen.getAllByText("Alice Jones")).toHaveLength(2);
    expect(screen.getByText("Bob Smith")).toBeInTheDocument();

    // Alice 2025
    expect(screen.getByText(/12 → 15 days/i)).toBeInTheDocument();
    expect(screen.getByText(/\(2025\)/)).toBeInTheDocument();

    // Alice 2026
    expect(screen.getByText(/15 → 18 days/i)).toBeInTheDocument();
    expect(screen.getAllByText(/\(2026\)/)).toHaveLength(2);

    // Bob 2026
    expect(screen.getByText(/10 → 14 days/i)).toBeInTheDocument();
    expect(screen.getByText(/\+4 d/)).toBeInTheDocument();
    expect(screen.getByText(/Adjusted by Carol Manager/i)).toBeInTheDocument();
  });

  it("shows a negative delta badge for decreases", () => {
    mockUseListTimeOffPolicyAssignees.mockReturnValue({
      data: { assignees: [makeAssignee({ member_id: 10 })] },
      isLoading: false,
    });
    mockUseQueriesResults = [
      {
        data: {
          adjustments: [
            makeAdjustment({
              id: 101,
              vacation_entitled_before: 18,
              vacation_entitled_after: 15,
              amount_changed: -3,
            }),
          ],
        },
        isLoading: false,
      },
    ];

    render(<AdjustmentsTab policyId={1} />);

    expect(screen.getByText("-3 d")).toBeInTheDocument();
  });
});

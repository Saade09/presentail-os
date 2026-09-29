import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import TimeOffMyPage from "./TimeOffMyPage";

const mockUseWorkspaceRole = vi.fn();
vi.mock("@/hooks/use-workspace-role", () => ({
  useWorkspaceRole: () => mockUseWorkspaceRole(),
}));

vi.mock("@workspace/api-client-react", () => ({
  useGetTimeOffBalance: () => ({ data: { balance: null }, isLoading: false }),
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
    <a href={href} data-testid="link">
      {children}
    </a>
  ),
}));

describe("TimeOffMyPage – no-policy empty state", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("shows the Assign a time-off policy button for users with time-off.manage permission", () => {
    mockUseWorkspaceRole.mockReturnValue({ allowedPages: ["time-off.manage"], loaded: true });
    render(<TimeOffMyPage />);
    const btn = screen.getByTestId("assign-policy-btn");
    expect(btn).toBeInTheDocument();
    expect(btn).toHaveTextContent("Assign a time-off policy");
    const link = btn.closest("a");
    expect(link).toHaveAttribute("href", "/admin/time-off/policies");
    expect(screen.queryByText(/Ask your manager/i)).not.toBeInTheDocument();
  });

  it("shows the Assign button for owners (allowedPages === null)", () => {
    mockUseWorkspaceRole.mockReturnValue({ allowedPages: null, loaded: true });
    render(<TimeOffMyPage />);
    expect(screen.getByTestId("assign-policy-btn")).toBeInTheDocument();
  });

  it("hides the Assign button and shows the manager guidance copy for non-privileged users", () => {
    mockUseWorkspaceRole.mockReturnValue({ allowedPages: ["time-off"], loaded: true });
    render(<TimeOffMyPage />);
    expect(screen.queryByTestId("assign-policy-btn")).not.toBeInTheDocument();
    expect(screen.getByText(/Ask your manager/i)).toBeInTheDocument();
  });
});

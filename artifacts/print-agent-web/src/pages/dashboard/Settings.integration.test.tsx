/**
 * Integration tests for the Settings page that use the real useWorkspaceRole
 * hook and the real SimulatedRoleProvider/useSimulatedRole context — no mocking
 * of the role wiring.  This catches regressions in the hook/context integration
 * that the unit tests (which mock useWorkspaceRole directly) cannot detect.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { SimulatedRoleProvider } from "@/contexts/simulated-role-context";
import SettingsPage from "./Settings";

const SESSION_KEY = "simulatedRole";

vi.mock("@clerk/react", () => ({
  useAuth: vi.fn(() => ({ isSignedIn: true })),
}));

vi.mock("@/lib/queryClient", () => ({
  apiFetch: vi.fn(),
  getClerkToken: vi.fn(),
}));

vi.mock("@/hooks/use-toast", () => ({
  useToast: () => ({ toast: vi.fn() }),
}));

const mockUseQuery = vi.fn();
vi.mock("@tanstack/react-query", () => ({
  useQuery: (...args: unknown[]) => mockUseQuery(...args),
  useMutation: vi.fn(() => ({ mutate: vi.fn(), isPending: false })),
  useQueryClient: vi.fn(() => ({ setQueryData: vi.fn() })),
}));

function renderWithRealRoleContext() {
  return render(
    <SimulatedRoleProvider>
      <SettingsPage />
    </SimulatedRoleProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  sessionStorage.clear();

  mockUseQuery.mockImplementation(({ queryKey }: { queryKey: string[] }) => {
    if (queryKey[0] === "users") {
      return {
        data: { members: [], me: { role: "owner", email: "owner@example.com" } },
        isLoading: false,
      };
    }
    return { data: undefined, isLoading: false };
  });
});

afterEach(() => {
  sessionStorage.clear();
});

describe("SettingsPage – integration: real useWorkspaceRole + real SimulatedRoleProvider", () => {
  it("shows editable controls when the real role is owner and no simulation is active", { timeout: 15000 }, () => {
    renderWithRealRoleContext();

    expect(screen.queryByTestId("settings-read-only-notice")).not.toBeInTheDocument();
    expect(screen.getByTestId("threshold-select")).not.toBeDisabled();
    expect(screen.getByTestId("email-alert-toggle")).not.toBeDisabled();
    expect(screen.getByTestId("save-settings-button")).toBeInTheDocument();
  });

  it("switches to read-only when a non-owner role is active in sessionStorage (View as simulation)", () => {
    sessionStorage.setItem(SESSION_KEY, JSON.stringify({ id: 1, name: "designer", allowedPages: [] }));

    renderWithRealRoleContext();

    expect(screen.getByTestId("settings-read-only-notice")).toBeInTheDocument();
    expect(screen.getByTestId("settings-read-only-notice")).toHaveTextContent(
      "only workspace owners can make changes",
    );
    expect(screen.getByTestId("threshold-select")).toBeDisabled();
    expect(screen.getByTestId("email-alert-toggle")).toBeDisabled();
    expect(screen.queryByTestId("save-settings-button")).not.toBeInTheDocument();
  });

  it("shows read-only when real role is a non-owner (no simulation needed)", () => {
    mockUseQuery.mockImplementation(({ queryKey }: { queryKey: string[] }) => {
      if (queryKey[0] === "users") {
        return {
          data: { members: [], me: { role: "customer_service_agent", email: "csa@example.com" } },
          isLoading: false,
        };
      }
      return { data: undefined, isLoading: false };
    });

    renderWithRealRoleContext();

    expect(screen.getByTestId("settings-read-only-notice")).toBeInTheDocument();
    expect(screen.getByTestId("threshold-select")).toBeDisabled();
    expect(screen.getByTestId("email-alert-toggle")).toBeDisabled();
    expect(screen.queryByTestId("save-settings-button")).not.toBeInTheDocument();
  });
});

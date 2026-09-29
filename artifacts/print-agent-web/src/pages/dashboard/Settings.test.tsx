import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import SettingsPage from "./Settings";

vi.mock("@tanstack/react-query", () => ({
  useQuery: vi.fn(() => ({ data: undefined, isLoading: false })),
  useMutation: vi.fn(() => ({ mutate: vi.fn(), isPending: false })),
  useQueryClient: vi.fn(() => ({ setQueryData: vi.fn() })),
}));

vi.mock("@/lib/queryClient", () => ({
  apiFetch: vi.fn(),
  getClerkToken: vi.fn(),
}));

vi.mock("@/hooks/use-toast", () => ({
  useToast: () => ({ toast: vi.fn() }),
}));

vi.mock("@/contexts/simulated-role-context", () => ({
  useSimulatedRole: () => ({ simulatedRole: null, setSimulatedRole: vi.fn() }),
}));

const mockUseWorkspaceRole = vi.fn();
vi.mock("@/hooks/use-workspace-role", () => ({
  useWorkspaceRole: () => mockUseWorkspaceRole(),
}));

function renderSettings() {
  return render(<SettingsPage />);
}

describe("SettingsPage – read-only vs editable access control", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("non-owner view (e.g. designer or customer_service_agent)", () => {
    beforeEach(() => {
      mockUseWorkspaceRole.mockReturnValue({
        role: "designer",
        isOwner: false,
        realRole: "designer",
      });
    });

    it("shows the read-only notice banner", () => {
      renderSettings();
      expect(screen.getByTestId("settings-read-only-notice")).toBeInTheDocument();
      expect(screen.getByTestId("settings-read-only-notice")).toHaveTextContent(
        "only workspace owners can make changes",
      );
    });

    it("renders the threshold select in a disabled state", () => {
      renderSettings();
      const trigger = screen.getByTestId("threshold-select");
      expect(trigger).toBeDisabled();
    });

    it("renders the email-alert toggle in a disabled state", () => {
      renderSettings();
      const toggle = screen.getByTestId("email-alert-toggle");
      expect(toggle).toBeDisabled();
    });

    it("does not render the save settings button", () => {
      renderSettings();
      expect(screen.queryByTestId("save-settings-button")).not.toBeInTheDocument();
    });
  });

  describe("owner view", () => {
    beforeEach(() => {
      mockUseWorkspaceRole.mockReturnValue({
        role: "owner",
        isOwner: true,
        realRole: "owner",
      });
    });

    it("does not show the read-only notice banner", () => {
      renderSettings();
      expect(screen.queryByTestId("settings-read-only-notice")).not.toBeInTheDocument();
    });

    it("renders the threshold select in an enabled state", () => {
      renderSettings();
      const trigger = screen.getByTestId("threshold-select");
      expect(trigger).not.toBeDisabled();
    });

    it("renders the email-alert toggle in an enabled state", () => {
      renderSettings();
      const toggle = screen.getByTestId("email-alert-toggle");
      expect(toggle).not.toBeDisabled();
    });

    it("renders the save settings button", () => {
      renderSettings();
      expect(screen.getByTestId("save-settings-button")).toBeInTheDocument();
      expect(screen.getByTestId("save-settings-button")).toHaveTextContent("Save settings");
    });
  });

  describe("non-owner simulated role (owner using View as Designer)", () => {
    beforeEach(() => {
      mockUseWorkspaceRole.mockReturnValue({
        role: "designer",
        isOwner: false,
        realRole: "owner",
      });
    });

    it("shows the read-only notice banner when simulating a non-owner role", () => {
      renderSettings();
      expect(screen.getByTestId("settings-read-only-notice")).toBeInTheDocument();
    });

    it("disables controls when simulating a non-owner role", () => {
      renderSettings();
      expect(screen.getByTestId("threshold-select")).toBeDisabled();
      expect(screen.getByTestId("email-alert-toggle")).toBeDisabled();
    });

    it("hides the save button when simulating a non-owner role", () => {
      renderSettings();
      expect(screen.queryByTestId("save-settings-button")).not.toBeInTheDocument();
    });
  });
});

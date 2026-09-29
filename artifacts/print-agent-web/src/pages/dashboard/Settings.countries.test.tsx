import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
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

const mockUseWorkspaceRole = vi.fn();
vi.mock("@/hooks/use-workspace-role", () => ({
  useWorkspaceRole: () => mockUseWorkspaceRole(),
}));

const mockUseQuery = vi.fn();
const mockUseMutation = vi.fn();
vi.mock("@tanstack/react-query", () => ({
  useQuery: (opts: { queryKey: unknown[] }) => mockUseQuery(opts),
  useMutation: (opts: unknown) => mockUseMutation(opts),
  useQueryClient: vi.fn(() => ({ setQueryData: vi.fn(), invalidateQueries: vi.fn() })),
}));

function renderSettings() {
  return render(<SettingsPage />);
}

describe("SettingsPage – Available Countries section", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUseMutation.mockReturnValue({ mutate: vi.fn(), isPending: false });
    mockUseQuery.mockReturnValue({ data: undefined, isLoading: false });
  });

  describe("owner view", () => {
    beforeEach(() => {
      mockUseWorkspaceRole.mockReturnValue({ role: "owner", isOwner: true, realRole: "owner" });
    });

    it("renders the country search input", () => {
      renderSettings();
      expect(screen.getByTestId("country-search-input")).toBeInTheDocument();
    });

    it("renders the country checklist", () => {
      renderSettings();
      expect(screen.getByTestId("country-checklist")).toBeInTheDocument();
    });

    it("renders the Save Countries button", () => {
      renderSettings();
      expect(screen.getByTestId("save-countries-button")).toBeInTheDocument();
    });

    it("does not render the read-only countries container", () => {
      renderSettings();
      expect(screen.queryByTestId("countries-read-only")).not.toBeInTheDocument();
    });

    it("shows Lebanon checkbox as checked by default", () => {
      renderSettings();
      const checkbox = screen.getByTestId("country-checkbox-Lebanon");
      expect(checkbox).toBeInTheDocument();
      expect(checkbox).toHaveAttribute("data-state", "checked");
    });

    it("shows United Arab Emirates checkbox as checked by default", () => {
      renderSettings();
      const checkbox = screen.getByTestId("country-checkbox-United-Arab-Emirates");
      expect(checkbox).toBeInTheDocument();
      expect(checkbox).toHaveAttribute("data-state", "checked");
    });

    it("pre-selects countries loaded from the API", () => {
      const settingsResult = {
        data: {
          offline_alert_threshold_minutes: 5,
          offline_alert_email_enabled: false,
          available_countries: ["France", "Germany"],
        },
        isLoading: false,
      };
      mockUseQuery.mockImplementation(({ queryKey }: { queryKey: string[] }) => {
        if (queryKey[0] === "workspace-settings") return settingsResult;
        return { data: undefined, isLoading: false };
      });

      renderSettings();

      expect(screen.getByTestId("country-checkbox-France")).toHaveAttribute("data-state", "checked");
      expect(screen.getByTestId("country-checkbox-Germany")).toHaveAttribute("data-state", "checked");
      expect(screen.getByTestId("country-checkbox-Lebanon")).toHaveAttribute("data-state", "unchecked");
    });

    it("shows a selected count label", () => {
      renderSettings();
      expect(screen.getByText(/selected/i)).toBeInTheDocument();
    });

    it("does not render an Israel checkbox in the country checklist", () => {
      renderSettings();
      expect(screen.queryByTestId("country-checkbox-Israel")).not.toBeInTheDocument();
    });
  });

  describe("non-owner view", () => {
    beforeEach(() => {
      mockUseWorkspaceRole.mockReturnValue({ role: "designer", isOwner: false, realRole: "designer" });
    });

    it("renders the read-only countries container", () => {
      renderSettings();
      expect(screen.getByTestId("countries-read-only")).toBeInTheDocument();
    });

    it("does not render the country search input", () => {
      renderSettings();
      expect(screen.queryByTestId("country-search-input")).not.toBeInTheDocument();
    });

    it("does not render the country checklist", () => {
      renderSettings();
      expect(screen.queryByTestId("country-checklist")).not.toBeInTheDocument();
    });

    it("does not render the Save Countries button", () => {
      renderSettings();
      expect(screen.queryByTestId("save-countries-button")).not.toBeInTheDocument();
    });

    it("lists selected countries from the API in the read-only view", () => {
      const settingsResult = {
        data: {
          offline_alert_threshold_minutes: 5,
          offline_alert_email_enabled: false,
          available_countries: ["France", "Germany"],
        },
        isLoading: false,
      };
      mockUseQuery.mockImplementation(({ queryKey }: { queryKey: string[] }) => {
        if (queryKey[0] === "workspace-settings") return settingsResult;
        return { data: undefined, isLoading: false };
      });

      renderSettings();

      const container = screen.getByTestId("countries-read-only");
      expect(container).toHaveTextContent("France");
      expect(container).toHaveTextContent("Germany");
    });
  });

  describe("owner simulating a non-owner role", () => {
    beforeEach(() => {
      mockUseWorkspaceRole.mockReturnValue({ role: "designer", isOwner: false, realRole: "owner" });
    });

    it("shows the read-only countries container when simulating a non-owner role", () => {
      renderSettings();
      expect(screen.getByTestId("countries-read-only")).toBeInTheDocument();
    });

    it("hides the Save Countries button when simulating a non-owner role", () => {
      renderSettings();
      expect(screen.queryByTestId("save-countries-button")).not.toBeInTheDocument();
    });
  });

  describe("zero-countries save hint", () => {
    beforeEach(() => {
      mockUseWorkspaceRole.mockReturnValue({ role: "owner", isOwner: true, realRole: "owner" });
    });

    it("shows the hint and disables the save button when all countries are deselected", async () => {
      renderSettings();

      const user = userEvent.setup();

      const lebanonCheckbox = screen.getByTestId("country-checkbox-Lebanon");
      const uaeCheckbox = screen.getByTestId("country-checkbox-United-Arab-Emirates");

      await user.click(lebanonCheckbox);
      await user.click(uaeCheckbox);

      expect(screen.getByTestId("no-countries-hint")).toBeInTheDocument();
      expect(screen.getByTestId("save-countries-button")).toBeDisabled();
    });

    it("hides the hint and re-enables the save button after re-selecting at least one country", async () => {
      renderSettings();

      const user = userEvent.setup();

      const lebanonCheckbox = screen.getByTestId("country-checkbox-Lebanon");
      const uaeCheckbox = screen.getByTestId("country-checkbox-United-Arab-Emirates");

      await user.click(lebanonCheckbox);
      await user.click(uaeCheckbox);

      expect(screen.getByTestId("no-countries-hint")).toBeInTheDocument();
      expect(screen.getByTestId("save-countries-button")).toBeDisabled();

      await user.click(lebanonCheckbox);

      expect(screen.queryByTestId("no-countries-hint")).not.toBeInTheDocument();
      expect(screen.getByTestId("save-countries-button")).not.toBeDisabled();
    });
  });
});

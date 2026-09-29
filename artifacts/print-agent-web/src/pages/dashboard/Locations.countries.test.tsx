import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import LocationsPage from "./Locations";

vi.mock("wouter", () => ({
  useSearch: () => "",
  useLocation: () => ["/locations", vi.fn()],
  Link: ({ href, children }: { href: string; children: React.ReactNode }) => (
    <a href={href}>{children}</a>
  ),
}));

const mockUseQuery = vi.fn();
const mockUseMutation = vi.fn();

vi.mock("@tanstack/react-query", () => ({
  useQuery: (opts: { queryKey: unknown[] }) => mockUseQuery(opts),
  useMutation: (opts: unknown) => mockUseMutation(opts),
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
}));

vi.mock("@/lib/queryClient", () => ({
  apiFetch: vi.fn(),
  queryClient: { invalidateQueries: vi.fn() },
}));

vi.mock("@/hooks/use-toast", () => ({
  useToast: () => ({ toast: vi.fn() }),
}));

vi.mock("@/hooks/use-workspace-role", () => ({
  useWorkspaceRole: () => ({ isOwner: true }),
}));

function renderLocations() {
  return render(<LocationsPage />);
}

const EXAMPLE_LOCATION = {
  id: 42,
  name: "Beirut Office",
  country: "Lebanon",
  location_type: "Point of Sale" as const,
  annual_rent: null,
  rent_currency: null,
  payments_per_year: null,
  created_at: "2024-01-01",
  device_count: 0,
  job_count: 0,
  page_sum: 0,
};

function setupMocks({
  availableCountries,
  locations = [],
}: {
  availableCountries?: string[];
  locations?: typeof EXAMPLE_LOCATION[];
} = {}) {
  mockUseMutation.mockReturnValue({ mutate: vi.fn(), isPending: false });
  mockUseQuery.mockImplementation(({ queryKey }: { queryKey: string[] }) => {
    if (queryKey[0] === "locations") {
      return { data: { locations }, isLoading: false };
    }
    if (queryKey[0] === "workspace-settings") {
      return {
        data: {
          offline_alert_threshold_minutes: 5,
          offline_alert_email_enabled: false,
          available_countries: availableCountries ?? ["Lebanon", "United Arab Emirates"],
        },
        isLoading: false,
      };
    }
    return { data: undefined, isLoading: false };
  });
}

describe("LocationsPage – country dropdown uses workspace settings", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("shows the new location dialog when the button is clicked", async () => {
    setupMocks();
    renderLocations();

    const user = userEvent.setup();
    await act(() => user.click(screen.getByTestId("button-new-location")));

    expect(screen.getByTestId("select-location-country")).toBeInTheDocument();
  });

  it("defaults the country select to the first saved country from settings", async () => {
    setupMocks({ availableCountries: ["France", "Germany"] });
    renderLocations();

    const user = userEvent.setup();
    await act(() => user.click(screen.getByTestId("button-new-location")));

    const countryTrigger = screen.getByTestId("select-location-country");
    expect(countryTrigger).toHaveTextContent("France");
  });

  it("uses Lebanon as the default first country when settings return Lebanon and UAE", async () => {
    setupMocks({ availableCountries: ["Lebanon", "United Arab Emirates"] });
    renderLocations();

    const user = userEvent.setup();
    await act(() => user.click(screen.getByTestId("button-new-location")));

    const countryTrigger = screen.getByTestId("select-location-country");
    expect(countryTrigger).toHaveTextContent("Lebanon");
  });

  it("shows the saved country options in the select content", async () => {
    setupMocks({ availableCountries: ["France", "Germany"] });
    renderLocations();

    const user = userEvent.setup();
    await act(() => user.click(screen.getByTestId("button-new-location")));

    const countryTrigger = screen.getByTestId("select-location-country");
    await act(() => user.click(countryTrigger));

    expect(screen.getByRole("option", { name: /France/ })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: /Germany/ })).toBeInTheDocument();
  });

  it("does not show countries outside the workspace settings list", async () => {
    setupMocks({ availableCountries: ["France", "Germany"] });
    renderLocations();

    const user = userEvent.setup();
    await act(() => user.click(screen.getByTestId("button-new-location")));

    const countryTrigger = screen.getByTestId("select-location-country");
    await act(() => user.click(countryTrigger));

    expect(screen.queryByRole("option", { name: "Lebanon" })).not.toBeInTheDocument();
    expect(screen.queryByRole("option", { name: "United Arab Emirates" })).not.toBeInTheDocument();
  });

  it("filters Israel out of the country dropdown even if returned by the API", async () => {
    setupMocks({ availableCountries: ["France", "Israel", "Germany"] });
    renderLocations();

    const user = userEvent.setup();
    await act(() => user.click(screen.getByTestId("button-new-location")));

    const countryTrigger = screen.getByTestId("select-location-country");
    await act(() => user.click(countryTrigger));

    expect(screen.getByRole("option", { name: /France/ })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: /Germany/ })).toBeInTheDocument();
    expect(screen.queryByRole("option", { name: /Israel/ })).not.toBeInTheDocument();
  });

  it("disables the country select while settings are loading", async () => {
    mockUseMutation.mockReturnValue({ mutate: vi.fn(), isPending: false });
    mockUseQuery.mockImplementation(({ queryKey }: { queryKey: string[] }) => {
      if (queryKey[0] === "locations") {
        return { data: { locations: [] }, isLoading: false };
      }
      if (queryKey[0] === "workspace-settings") {
        return { data: undefined, isLoading: true };
      }
      return { data: undefined, isLoading: false };
    });

    renderLocations();

    const user = userEvent.setup();
    await act(() => user.click(screen.getByTestId("button-new-location")));

    expect(screen.getByTestId("select-location-country")).toBeDisabled();
  });

  describe("edit dialog – country options also come from workspace settings", () => {
    it("opens the edit dialog with the country select populated from workspace settings", async () => {
      setupMocks({
        availableCountries: ["France", "Germany"],
        locations: [EXAMPLE_LOCATION],
      });
      renderLocations();

      const user = userEvent.setup();
      await act(() => user.click(screen.getByTestId("button-edit-location-42")));

      expect(screen.getByTestId("select-location-country")).toBeInTheDocument();
    });

    it("shows only workspace-settings countries in the edit dialog country select", async () => {
      setupMocks({
        availableCountries: ["France", "Germany"],
        locations: [EXAMPLE_LOCATION],
      });
      renderLocations();

      const user = userEvent.setup();
      await act(() => user.click(screen.getByTestId("button-edit-location-42")));

      const countryTrigger = screen.getByTestId("select-location-country");
      await act(() => user.click(countryTrigger));

      expect(screen.getByRole("option", { name: /France/ })).toBeInTheDocument();
      expect(screen.getByRole("option", { name: /Germany/ })).toBeInTheDocument();
      expect(screen.queryByRole("option", { name: /Lebanon/ })).not.toBeInTheDocument();
    });

    it("does not pre-select the existing location country if it is outside the workspace list", async () => {
      setupMocks({
        availableCountries: ["France", "Germany"],
        locations: [EXAMPLE_LOCATION],
      });
      renderLocations();

      const user = userEvent.setup();
      await act(() => user.click(screen.getByTestId("button-edit-location-42")));

      const countryTrigger = screen.getByTestId("select-location-country");
      expect(countryTrigger).not.toHaveTextContent("Lebanon");
    });
  });
});

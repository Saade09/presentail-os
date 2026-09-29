import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import LocationsPage from "./Locations";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeLocation(overrides: Partial<{
  id: number;
  name: string;
  country: string;
  location_type: "Point of Sale" | "Central Warehouse";
  annual_rent: string | null;
  rent_currency: string | null;
  payments_per_year: number | null;
  created_at: string;
  device_count: number;
  job_count: number;
  page_sum: number;
}> = {}) {
  return {
    id: 1,
    name: "Dubai Office",
    country: "United Arab Emirates",
    location_type: "Point of Sale" as const,
    annual_rent: null,
    rent_currency: null,
    payments_per_year: null,
    created_at: "2024-01-01",
    device_count: 0,
    job_count: 0,
    page_sum: 0,
    ...overrides,
  };
}

const noop = { mutate: vi.fn(), mutateAsync: vi.fn(), isPending: false };

function setupMocks(locations = [makeLocation()]) {
  mockUseMutation.mockReturnValue(noop);
  mockUseQuery.mockImplementation(({ queryKey }: { queryKey: string[] }) => {
    if (queryKey[0] === "locations") {
      return { data: { locations }, isLoading: false };
    }
    if (queryKey[0] === "workspace-settings") {
      return {
        data: {
          offline_alert_threshold_minutes: 5,
          offline_alert_email_enabled: false,
          available_countries: ["United Arab Emirates", "Lebanon"],
        },
        isLoading: false,
      };
    }
    return { data: undefined, isLoading: false };
  });
}

// ---------------------------------------------------------------------------
// Tests: name duplicate warning in the create location form
// ---------------------------------------------------------------------------

describe("LocationsPage – name duplicate warning in create form", () => {
  const LOCATION_DUBAI = makeLocation({ id: 1, name: "Dubai Office" });
  const LOCATION_ABU_DHABI = makeLocation({ id: 2, name: "Abu Dhabi Store" });

  beforeEach(() => {
    vi.clearAllMocks();
    setupMocks([LOCATION_DUBAI, LOCATION_ABU_DHABI]);
  });

  function openCreateDialog() {
    render(<LocationsPage />);
    fireEvent.click(screen.getByTestId("button-new-location"));
  }

  it("shows no warning when the create form first opens (empty name field)", () => {
    openCreateDialog();

    expect(screen.queryByTestId("name-warning-exact")).toBeNull();
    expect(screen.queryByTestId("name-warning-similar")).toBeNull();
  });

  it("shows an exact-match warning when a duplicate name is typed", async () => {
    openCreateDialog();

    fireEvent.change(screen.getByTestId("input-location-name"), {
      target: { value: "Dubai Office" },
    });

    await waitFor(() => {
      expect(screen.getByTestId("name-warning-exact")).toHaveTextContent("Dubai Office");
    });
    expect(screen.queryByTestId("name-warning-similar")).toBeNull();
  });

  it("shows a similar-match warning when a partial overlapping name is typed", async () => {
    openCreateDialog();

    fireEvent.change(screen.getByTestId("input-location-name"), {
      target: { value: "Abu Dhabi" },
    });

    await waitFor(() => {
      expect(screen.getByTestId("name-warning-similar")).toHaveTextContent("Abu Dhabi Store");
    });
    expect(screen.queryByTestId("name-warning-exact")).toBeNull();
  });

  it("does not disable the Save button when an exact-match warning is shown", async () => {
    openCreateDialog();

    fireEvent.change(screen.getByTestId("input-location-name"), {
      target: { value: "Dubai Office" },
    });

    await waitFor(() => {
      expect(screen.getByTestId("name-warning-exact")).toBeTruthy();
    });

    expect(screen.getByTestId("button-confirm-location")).not.toBeDisabled();
  });

  it("does not disable the Save button when a similar-match warning is shown", async () => {
    openCreateDialog();

    fireEvent.change(screen.getByTestId("input-location-name"), {
      target: { value: "Abu Dhabi" },
    });

    await waitFor(() => {
      expect(screen.getByTestId("name-warning-similar")).toBeTruthy();
    });

    expect(screen.getByTestId("button-confirm-location")).not.toBeDisabled();
  });

  it("clears the warning when the name is changed to a unique value", async () => {
    openCreateDialog();

    fireEvent.change(screen.getByTestId("input-location-name"), {
      target: { value: "Dubai Office" },
    });

    await waitFor(() => {
      expect(screen.getByTestId("name-warning-exact")).toBeTruthy();
    });

    fireEvent.change(screen.getByTestId("input-location-name"), {
      target: { value: "Sharjah Branch" },
    });

    await waitFor(() => {
      expect(screen.queryByTestId("name-warning-exact")).toBeNull();
      expect(screen.queryByTestId("name-warning-similar")).toBeNull();
    });
  });

  it("clears the similar-match warning when the name is changed to a unique value", async () => {
    openCreateDialog();

    fireEvent.change(screen.getByTestId("input-location-name"), {
      target: { value: "Abu Dhabi" },
    });

    await waitFor(() => {
      expect(screen.getByTestId("name-warning-similar")).toBeTruthy();
    });

    fireEvent.change(screen.getByTestId("input-location-name"), {
      target: { value: "Sharjah Branch" },
    });

    await waitFor(() => {
      expect(screen.queryByTestId("name-warning-exact")).toBeNull();
      expect(screen.queryByTestId("name-warning-similar")).toBeNull();
    });
  });
});

// ---------------------------------------------------------------------------
// Tests: name duplicate warning in the edit location form (self-match exclusion)
// ---------------------------------------------------------------------------

describe("LocationsPage – name duplicate warning in edit form (self-match exclusion)", () => {
  const LOCATION_DUBAI = makeLocation({ id: 1, name: "Dubai Office" });
  const LOCATION_ABU_DHABI = makeLocation({ id: 2, name: "Abu Dhabi Store" });

  beforeEach(() => {
    vi.clearAllMocks();
    setupMocks([LOCATION_DUBAI, LOCATION_ABU_DHABI]);
  });

  function openEditDialog() {
    render(<LocationsPage />);
    fireEvent.click(screen.getByTestId("button-edit-location-1"));
  }

  it("shows no warning when the edit form first opens (own name pre-filled, excluded from check)", () => {
    openEditDialog();

    expect(screen.queryByTestId("name-warning-exact")).toBeNull();
    expect(screen.queryByTestId("name-warning-similar")).toBeNull();
  });

  it("shows an exact-match warning when the name is changed to match another location", async () => {
    openEditDialog();

    fireEvent.change(screen.getByTestId("input-location-name"), {
      target: { value: "Abu Dhabi Store" },
    });

    await waitFor(() => {
      expect(screen.getByTestId("name-warning-exact")).toHaveTextContent("Abu Dhabi Store");
    });
    expect(screen.queryByTestId("name-warning-similar")).toBeNull();
  });

  it("suppresses the warning when typing the location's own current name (self-match exclusion)", async () => {
    openEditDialog();

    fireEvent.change(screen.getByTestId("input-location-name"), {
      target: { value: "Abu Dhabi Store" },
    });

    await waitFor(() => {
      expect(screen.getByTestId("name-warning-exact")).toBeTruthy();
    });

    fireEvent.change(screen.getByTestId("input-location-name"), {
      target: { value: "Dubai Office" },
    });

    await waitFor(() => {
      expect(screen.queryByTestId("name-warning-exact")).toBeNull();
      expect(screen.queryByTestId("name-warning-similar")).toBeNull();
    });
  });

  it("shows a similar-match warning when the typed name overlaps with another location name", async () => {
    openEditDialog();

    fireEvent.change(screen.getByTestId("input-location-name"), {
      target: { value: "Abu Dhabi" },
    });

    await waitFor(() => {
      expect(screen.getByTestId("name-warning-similar")).toHaveTextContent("Abu Dhabi Store");
    });
    expect(screen.queryByTestId("name-warning-exact")).toBeNull();
  });

  it("does not disable the Save button when an exact-match warning is shown", async () => {
    openEditDialog();

    fireEvent.change(screen.getByTestId("input-location-name"), {
      target: { value: "Abu Dhabi Store" },
    });

    await waitFor(() => {
      expect(screen.getByTestId("name-warning-exact")).toBeTruthy();
    });

    expect(screen.getByTestId("button-confirm-location")).not.toBeDisabled();
  });

  it("does not disable the Save button when a similar-match warning is shown", async () => {
    openEditDialog();

    fireEvent.change(screen.getByTestId("input-location-name"), {
      target: { value: "Abu Dhabi" },
    });

    await waitFor(() => {
      expect(screen.getByTestId("name-warning-similar")).toBeTruthy();
    });

    expect(screen.getByTestId("button-confirm-location")).not.toBeDisabled();
  });

  it("clears the similar-match warning when the name is changed to a unique value", async () => {
    openEditDialog();

    fireEvent.change(screen.getByTestId("input-location-name"), {
      target: { value: "Abu Dhabi" },
    });

    await waitFor(() => {
      expect(screen.getByTestId("name-warning-similar")).toBeTruthy();
    });

    fireEvent.change(screen.getByTestId("input-location-name"), {
      target: { value: "Sharjah Branch" },
    });

    await waitFor(() => {
      expect(screen.queryByTestId("name-warning-exact")).toBeNull();
      expect(screen.queryByTestId("name-warning-similar")).toBeNull();
    });
  });
});

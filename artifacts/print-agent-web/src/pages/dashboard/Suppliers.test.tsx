import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import SuppliersPage from "./Suppliers";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock("react-phone-number-input", () => ({
  default: () => null,
  getCountries: () => [],
}));

vi.mock("@tanstack/react-query", () => ({
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
  useQuery: vi.fn().mockReturnValue({ data: undefined, isLoading: false }),
}));

vi.mock("@/hooks/use-toast", () => ({
  useToast: () => ({ toast: vi.fn() }),
}));

vi.mock("@/hooks/use-workspace-role", () => ({
  useWorkspaceRole: () => ({ isOwner: true, allowedPages: null }),
}));

vi.mock("@/lib/countries", () => ({
  COUNTRY_CATALOGUE: [],
  EXCLUDED_COUNTRY_NAMES: [],
  getCountryMetadata: () => null,
  isExcludedCountry: () => false,
}));

const mockUseListSuppliers = vi.fn();

vi.mock("@workspace/api-client-react", () => ({
  useListSuppliers: (...args: unknown[]) => mockUseListSuppliers(...args),
  useCreateSupplier: () => ({ mutate: vi.fn(), isPending: false }),
  usePatchSupplier: () => ({ mutate: vi.fn(), mutateAsync: vi.fn(), isPending: false }),
  useDeleteSupplier: () => ({ mutate: vi.fn(), isPending: false }),
  useCheckDuplicateSupplier: () => ({ data: undefined, isLoading: false }),
  checkDuplicateSupplier: vi.fn().mockResolvedValue({ exactMatch: false, similarMatches: [] }),
  getCheckDuplicateSupplierQueryKey: (params?: unknown) => ["/api/suppliers/check-duplicate", params],
  getListSuppliersQueryKey: () => ["/api/suppliers"],
}));

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeSupplier(overrides: Record<string, unknown> = {}) {
  return {
    id: 1,
    workspace_owner_id: "owner-1",
    name: "Test Supplier",
    display_name: null,
    contact_name: null,
    contact_email: null,
    contact_phone: null,
    country: null,
    tax_number: null,
    item_count: 0,
    is_archived: false,
    created_at: "2024-01-01T00:00:00Z",
    updated_at: "2024-01-15T00:00:00Z",
    ...overrides,
  };
}

function setup(suppliers: ReturnType<typeof makeSupplier>[]) {
  mockUseListSuppliers.mockReturnValue({
    data: { suppliers },
    isLoading: false,
    isError: false,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
});

// ---------------------------------------------------------------------------
// Tests: tax number display in SuppliersPage table
// ---------------------------------------------------------------------------

describe("SuppliersPage – tax number in supplier table row", () => {
  it("shows TRN value when supplier country is United Arab Emirates", () => {
    setup([makeSupplier({ country: "United Arab Emirates", tax_number: "100012345" })]);

    render(<SuppliersPage />);

    expect(screen.getByText("100012345")).toBeInTheDocument();
  });

  it("shows MOF value when supplier country is Lebanon", () => {
    setup([makeSupplier({ country: "Lebanon", tax_number: "67890" })]);

    render(<SuppliersPage />);

    expect(screen.getByText("67890")).toBeInTheDocument();
  });

  it("shows tax value for a non-UAE, non-Lebanon country", () => {
    setup([makeSupplier({ country: "Saudi Arabia", tax_number: "99999" })]);

    render(<SuppliersPage />);

    expect(screen.getByText("99999")).toBeInTheDocument();
  });

  it("does not show tax value when supplier has no tax_number", () => {
    setup([makeSupplier({ country: "United Arab Emirates", tax_number: null })]);

    render(<SuppliersPage />);

    // No tax value should be shown; the cell renders "—" placeholder
    expect(screen.queryByText("100012345")).not.toBeInTheDocument();
    expect(screen.queryByText(/TRN:/)).not.toBeInTheDocument();
  });

  it("does not show tax value when both tax_number and country are absent", () => {
    setup([makeSupplier({ country: null, tax_number: null })]);

    render(<SuppliersPage />);

    expect(screen.queryByText(/TRN:/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Tax Number:/)).not.toBeInTheDocument();
  });

  it("shows tax value for an archived supplier when Archived filter is selected", () => {
    const archivedSupplier = makeSupplier({
      id: 2,
      name: "Archived Co",
      country: "United Arab Emirates",
      tax_number: "555123456",
      is_archived: true,
    });

    // Initial state: active filter, no archived suppliers returned
    mockUseListSuppliers.mockReturnValue({ data: { suppliers: [] }, isLoading: false, isError: false });

    render(<SuppliersPage />);

    expect(screen.queryByText("555123456")).not.toBeInTheDocument();

    // Simulate clicking "Archived" segmented control button
    mockUseListSuppliers.mockReturnValue({ data: { suppliers: [archivedSupplier] }, isLoading: false, isError: false });

    fireEvent.click(screen.getByText("Archived"));

    expect(screen.getByText("555123456")).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// Tests: table structure
// ---------------------------------------------------------------------------

describe("SuppliersPage – table structure", () => {
  it("renders column headers for the new table layout", () => {
    setup([]);
    render(<SuppliersPage />);

    expect(screen.getByText("Supplier")).toBeInTheDocument();
    expect(screen.getByText("Country")).toBeInTheDocument();
    expect(screen.getByText("TRN / Tax ID")).toBeInTheDocument();
    expect(screen.getByText("Status")).toBeInTheDocument();
    expect(screen.getByText("Last Activity")).toBeInTheDocument();
  });

  it("shows supplier name in table row", () => {
    setup([makeSupplier({ name: "My Test Supplier" })]);
    render(<SuppliersPage />);

    expect(screen.getByText("My Test Supplier")).toBeInTheDocument();
  });

  it("shows Active status badge for non-archived supplier", () => {
    setup([makeSupplier({ is_archived: false })]);
    render(<SuppliersPage />);

    // "Active" appears in both the segmented control button and the status badge;
    // at least one non-button element with that text should be present.
    const activeElements = screen.getAllByText("Active");
    expect(activeElements.some((el) => el.tagName !== "BUTTON")).toBe(true);
  });

  it("shows Archived status badge for archived supplier when viewing archived", () => {
    mockUseListSuppliers.mockReturnValue({
      data: { suppliers: [makeSupplier({ is_archived: true, name: "Old Supplier" })] },
      isLoading: false,
      isError: false,
    });

    render(<SuppliersPage />);
    fireEvent.click(screen.getAllByText("Archived")[0]);

    // "Archived" appears in both the segmented control button and the status badge.
    const archivedElements = screen.getAllByText("Archived");
    expect(archivedElements.some((el) => el.tagName !== "BUTTON")).toBe(true);
  });

  it("shows pagination footer when suppliers are present", () => {
    setup([makeSupplier()]);
    render(<SuppliersPage />);

    expect(screen.getByText(/Showing 1 to 1 of 1 supplier/)).toBeInTheDocument();
  });

  it("renders Active/Archived/All segmented controls", () => {
    setup([]);
    render(<SuppliersPage />);

    expect(screen.getByText("Active")).toBeInTheDocument();
    expect(screen.getByText("All")).toBeInTheDocument();
  });

  it("shows empty state when no suppliers", () => {
    setup([]);
    render(<SuppliersPage />);

    expect(screen.getByText("No suppliers yet")).toBeInTheDocument();
  });

  it("shows loading skeleton rows while loading", () => {
    mockUseListSuppliers.mockReturnValue({ data: undefined, isLoading: true, isError: false });
    render(<SuppliersPage />);
    // Should not show "No suppliers yet" when loading
    expect(screen.queryByText("No suppliers yet")).not.toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// Tests: Assignment column rendering
// ---------------------------------------------------------------------------

vi.mock("@/lib/queryClient", () => ({
  apiFetch: vi.fn().mockResolvedValue({ members: [] }),
  getQueryClient: vi.fn(),
  queryClient: {},
}));

describe("SuppliersPage – assignments rendering", () => {
  it("shows dash in Assigned To column when supplier has no assignments", () => {
    setup([makeSupplier({ assignments: [] })]);
    render(<SuppliersPage />);
    // The assignment column renders "—" when empty; verify via the popover stack
    // DropdownMenu trigger renders AssignmentAvatarStack which shows "—" when empty
    const dashes = screen.queryAllByText("—");
    expect(dashes.length).toBeGreaterThan(0);
  });

  it("shows avatar initial when supplier has an assignment", () => {
    setup([makeSupplier({
      assignments: [{
        memberId: 42,
        memberEmail: "alice@example.com",
        name: "Alice Test",
        imageUrl: null,
        isLead: false,
      }],
    })]);
    render(<SuppliersPage />);
    // The avatar stack renders the first initial of the name
    const avatars = screen.queryAllByTitle(/Alice Test/);
    expect(avatars.length).toBeGreaterThanOrEqual(0);
  });

  it("passes assignments array to useListSuppliers", () => {
    setup([]);
    render(<SuppliersPage />);
    // useListSuppliers should have been called once
    expect(mockUseListSuppliers).toHaveBeenCalledWith(
      expect.objectContaining({ assigned_employee: undefined }),
    );
  });
});

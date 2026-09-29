import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  resolvePackagePricingUomCode,
  SuppliersTab,
} from "./SuppliersTab";
import { taxNumberLabel } from "./Suppliers";
import type { BaseItemPackage, Uom } from "@workspace/api-client-react";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock("wouter", () => ({
  Link: ({ href, children }: { href: string; children: React.ReactNode }) => (
    <a href={href}>{children}</a>
  ),
}));

vi.mock("@tanstack/react-query", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-query")>()),
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
}));

vi.mock("@/hooks/use-toast", () => ({
  useToast: () => ({ toast: vi.fn() }),
}));

vi.mock("@/hooks/use-workspace-role", () => ({
  useWorkspaceRole: () => ({ isOwner: true, allowedPages: null }),
}));

const mockUseListBaseItemSuppliers = vi.fn();
const mockUseListSuppliers = vi.fn();
const mockUseListBaseItemPackages = vi.fn();
const mockUseListUoms = vi.fn();
const mockCreateMutateAsync = vi.fn();
const mockPatchMutate = vi.fn();
const mockRefetchUoms = vi.fn();

vi.mock("@workspace/api-client-react", () => ({
  useListBaseItemSuppliers: (...args: unknown[]) => mockUseListBaseItemSuppliers(...args),
  useListSuppliers: (...args: unknown[]) => mockUseListSuppliers(...args),
  useListBaseItemPackages: (...args: unknown[]) => mockUseListBaseItemPackages(...args),
  useListUoms: (...args: unknown[]) => mockUseListUoms(...args),
  useCreateBaseItemSupplier: () => ({ mutate: vi.fn(), mutateAsync: mockCreateMutateAsync, isPending: false }),
  usePatchBaseItemSupplier: () => ({ mutate: mockPatchMutate, isPending: false }),
  useDeleteBaseItemSupplier: () => ({ mutate: vi.fn(), isPending: false }),
  getListBaseItemSuppliersQueryKey: (id: number) => [`/api/base-items/${id}/suppliers`],
}));

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeSupplierLink(overrides: Record<string, unknown> = {}) {
  return {
    id: 1,
    workspace_owner_id: "owner-1",
    base_item_id: 42,
    supplier_id: 10,
    supplier_name: "Acme Co",
    package_id: null,
    package_name: null,
    supplier_item_name: null,
    supplier_item_code: null,
    pricing_uom: null,
    pricing_uom_code: null,
    pricing_uom_display_name: null,
    pricing_uom_legacy: null,
    price: null,
    currency: "AED",
    is_preferred: false,
    is_default_order_unit: false,
    created_at: "2024-01-01T00:00:00Z",
    ...overrides,
  };
}

function makeWorkspaceSupplier(overrides: Record<string, unknown> = {}) {
  return {
    id: 10,
    workspace_owner_id: "owner-1",
    name: "Acme Co",
    contact_name: null,
    contact_email: null,
    contact_phone: null,
    country: null,
    tax_number: null,
    is_archived: false,
    created_at: "2024-01-01T00:00:00Z",
    ...overrides,
  };
}

const uoms: Uom[] = [
  { code: "piece", display_name: "Piece", aliases: ["piece", "pieces", "pc", "pcs"] },
  { code: "kg", display_name: "Kg", aliases: ["kg", "kilogram", "kilograms"] },
];

function setup({
  existingLinks = [makeSupplierLink()],
  workspaceSuppliers = [makeWorkspaceSupplier()],
  packages = [],
  uomItems = uoms,
  uomsLoading = false,
  uomsError = false,
}: {
  existingLinks?: ReturnType<typeof makeSupplierLink>[];
  workspaceSuppliers?: ReturnType<typeof makeWorkspaceSupplier>[];
  packages?: BaseItemPackage[];
  uomItems?: Uom[];
  uomsLoading?: boolean;
  uomsError?: boolean;
} = {}) {
  mockUseListBaseItemSuppliers.mockReturnValue({
    data: { suppliers: existingLinks },
    isLoading: false,
  });
  mockUseListSuppliers.mockReturnValue({
    data: { suppliers: workspaceSuppliers },
    isLoading: false,
  });
  mockUseListBaseItemPackages.mockReturnValue({
    data: { packages },
    isLoading: false,
  });
  mockUseListUoms.mockReturnValue({
    data: { context: "supplier_pricing", uoms: uomItems },
    isLoading: uomsLoading,
    isError: uomsError,
    refetch: mockRefetchUoms,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// Unit tests: taxNumberLabel utility
// ---------------------------------------------------------------------------

describe("taxNumberLabel", () => {
  it('returns "TRN" for United Arab Emirates', () => {
    expect(taxNumberLabel("United Arab Emirates")).toBe("TRN");
  });

  it('returns "MOF" for Lebanon', () => {
    expect(taxNumberLabel("Lebanon")).toBe("MOF");
  });

  it('returns "Tax Number" for a generic country', () => {
    expect(taxNumberLabel("Saudi Arabia")).toBe("Tax Number");
  });

  it('returns "Tax Number" for an empty string', () => {
    expect(taxNumberLabel("")).toBe("Tax Number");
  });
});

// ---------------------------------------------------------------------------
// Integration tests: ExistingSupplierRow tax number display
// ---------------------------------------------------------------------------

describe("SuppliersTab – tax number in read-only supplier row", () => {
  it("shows TRN label and value when supplier country is United Arab Emirates", () => {
    setup({
      workspaceSuppliers: [
        makeWorkspaceSupplier({ country: "United Arab Emirates", tax_number: "12345" }),
      ],
    });

    render(<SuppliersTab baseItemId={42} />);

    expect(screen.getByText("TRN: 12345")).toBeInTheDocument();
  });

  it("shows MOF label and value when supplier country is Lebanon", () => {
    setup({
      workspaceSuppliers: [
        makeWorkspaceSupplier({ country: "Lebanon", tax_number: "67890" }),
      ],
    });

    render(<SuppliersTab baseItemId={42} />);

    expect(screen.getByText("MOF: 67890")).toBeInTheDocument();
  });

  it("shows generic Tax Number label when the supplier country is not UAE or Lebanon", () => {
    setup({
      workspaceSuppliers: [
        makeWorkspaceSupplier({ country: "Saudi Arabia", tax_number: "99999" }),
      ],
    });

    render(<SuppliersTab baseItemId={42} />);

    expect(screen.getByText("Tax Number: 99999")).toBeInTheDocument();
  });

  it("does not render a tax number entry when the supplier has no tax_number", () => {
    setup({
      workspaceSuppliers: [
        makeWorkspaceSupplier({ country: "United Arab Emirates", tax_number: null }),
      ],
    });

    render(<SuppliersTab baseItemId={42} />);

    expect(screen.queryByText(/TRN:/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Tax Number:/)).not.toBeInTheDocument();
    expect(screen.queryByText(/MOF:/)).not.toBeInTheDocument();
  });

  it("does not render a tax number entry when the supplier link has no matching workspace supplier", () => {
    setup({
      existingLinks: [makeSupplierLink({ supplier_id: 10 })],
      workspaceSuppliers: [makeWorkspaceSupplier({ id: 999, tax_number: "12345" })],
    });

    render(<SuppliersTab baseItemId={42} />);

    expect(screen.queryByText(/TRN:/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Tax Number:/)).not.toBeInTheDocument();
  });
});

describe("supplier pricing UOM catalog", () => {
  it("resolves only an unambiguous registered package alias", () => {
    const pkg = { unit: "  PCS " } as BaseItemPackage;
    expect(resolvePackagePricingUomCode(pkg, uoms)).toBe("piece");
    expect(resolvePackagePricingUomCode({ unit: "crate" } as BaseItemPackage, uoms)).toBeNull();
    expect(
      resolvePackagePricingUomCode(
        { unit: "shared" } as BaseItemPackage,
        [
          { code: "piece", display_name: "Piece", aliases: ["shared"] },
          { code: "pack", display_name: "Pack", aliases: ["shared"] },
        ],
      ),
    ).toBeNull();
  });

  it("renders unresolved legacy text as a protected review state", async () => {
    setup({
      existingLinks: [
        makeSupplierLink({
          pricing_uom: "crate",
          pricing_uom_legacy: "crate",
        }),
      ],
    });

    render(<SuppliersTab baseItemId={42} />);
    expect(screen.getByText("Legacy value: crate — needs review")).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Edit" }));
    expect(screen.getByRole("combobox", { name: "Pricing UOM" })).toHaveTextContent(
      "Legacy value: crate — needs review",
    );
    expect(
      screen.getByText("Select a canonical UOM to replace this protected legacy value."),
    ).toBeInTheDocument();
  });

  it("saves a canonical code rather than display text", async () => {
    setup();
    const user = userEvent.setup();
    render(<SuppliersTab baseItemId={42} />);

    await user.click(screen.getByRole("button", { name: "Edit" }));
    await user.click(screen.getByRole("combobox", { name: "Pricing UOM" }));
    await user.click(screen.getByText("Piece"));
    await user.click(screen.getByRole("button", { name: "Save" }));

    expect(mockPatchMutate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ pricing_uom_code: "piece" }),
      }),
    );
    expect(mockPatchMutate.mock.calls[0][0].data).not.toHaveProperty("pricing_uom");
  });

  it("prefills a blank new row from a package alias without overwriting another row", async () => {
    setup({
      existingLinks: [],
      packages: [
        {
          id: 5,
          workspace_owner_id: "owner-1",
          base_item_id: 42,
          name: "Sleeve",
          unit: "pcs",
          unit_uom_code: "piece",
          unit_uom_display_name: "Piece",
          quantity: 12,
          is_default: false,
          created_at: "2026-01-01",
        },
      ],
    });
    const user = userEvent.setup();
    render(<SuppliersTab baseItemId={42} />);

    await user.click(screen.getByRole("button", { name: "Add Supplier" }));
    const rowComboboxes = screen.getAllByRole("combobox");
    await user.click(rowComboboxes[1]);
    await user.click(screen.getByText("Sleeve"));

    expect(screen.getByRole("combobox", { name: "Pricing UOM" })).toHaveTextContent("Piece");
  });

  it("never replaces an existing pricing UOM when the package changes", async () => {
    setup({
      existingLinks: [
        makeSupplierLink({
          package_id: null,
          pricing_uom: "Kg",
          pricing_uom_code: "kg",
          pricing_uom_display_name: "Kg",
        }),
      ],
      packages: [
        {
          id: 5,
          workspace_owner_id: "owner-1",
          base_item_id: 42,
          name: "Sleeve",
          unit: "pcs",
          unit_uom_code: "piece",
          unit_uom_display_name: "Piece",
          quantity: 12,
          is_default: false,
          created_at: "2026-01-01",
        },
      ],
    });
    const user = userEvent.setup();
    render(<SuppliersTab baseItemId={42} />);

    await user.click(screen.getByRole("button", { name: "Edit" }));
    const rowComboboxes = screen.getAllByRole("combobox");
    await user.click(rowComboboxes[1]);
    await user.click(screen.getByText("Sleeve"));

    expect(screen.getByRole("combobox", { name: "Pricing UOM" })).toHaveTextContent("Kg");
  });

  it("keeps simultaneous new-row selections independent", async () => {
    setup({ existingLinks: [] });
    const user = userEvent.setup();
    render(<SuppliersTab baseItemId={42} />);

    await user.click(screen.getByRole("button", { name: "Add Supplier" }));
    await user.click(screen.getByRole("button", { name: "Add Supplier" }));

    let pricingSelectors = screen.getAllByRole("combobox", { name: "Pricing UOM" });
    await user.click(pricingSelectors[0]);
    await user.click(screen.getByText("Piece"));
    pricingSelectors = screen.getAllByRole("combobox", { name: "Pricing UOM" });
    await user.click(pricingSelectors[1]);
    await user.click(screen.getByText("Kg"));

    pricingSelectors = screen.getAllByRole("combobox", { name: "Pricing UOM" });
    expect(pricingSelectors[0]).toHaveTextContent("Piece");
    expect(pricingSelectors[1]).toHaveTextContent("Kg");
  });

  it("keeps selected and legacy values visible while the catalog refreshes", async () => {
    setup({
      existingLinks: [
        makeSupplierLink({
          pricing_uom: "Kg",
          pricing_uom_code: "kg",
          pricing_uom_display_name: "Kg",
        }),
      ],
      uomsLoading: true,
    });
    const user = userEvent.setup();
    const { unmount } = render(<SuppliersTab baseItemId={42} />);
    await user.click(screen.getByRole("button", { name: "Edit" }));
    expect(screen.getByRole("combobox", { name: "Pricing UOM" })).toHaveTextContent("Kg");
    unmount();

    setup({
      existingLinks: [
        makeSupplierLink({
          pricing_uom: "crate",
          pricing_uom_legacy: "crate",
        }),
      ],
      uomsLoading: true,
    });
    render(<SuppliersTab baseItemId={42} />);
    await user.click(screen.getByRole("button", { name: "Edit" }));
    expect(screen.getByRole("combobox", { name: "Pricing UOM" })).toHaveTextContent(
      "Legacy value: crate — needs review",
    );
  });

  it("shows UOM loading and retry states", async () => {
    setup({ existingLinks: [], uomsLoading: true });
    const user = userEvent.setup();
    const { unmount } = render(<SuppliersTab baseItemId={42} />);
    await user.click(screen.getByRole("button", { name: "Add Supplier" }));
    expect(screen.getByText("Loading pricing UOMs…")).toBeInTheDocument();
    unmount();

    setup({ existingLinks: [], uomsError: true });
    render(<SuppliersTab baseItemId={42} />);
    await user.click(screen.getByRole("button", { name: "Add Supplier" }));
    await user.click(screen.getByRole("button", { name: "Retry" }));
    expect(mockRefetchUoms).toHaveBeenCalled();
  });
});

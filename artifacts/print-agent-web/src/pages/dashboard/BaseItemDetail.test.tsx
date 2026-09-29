import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, act, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import BaseItemDetailPage from "./BaseItemDetail";
import { apiFetch } from "@/lib/queryClient";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockMutate = vi.fn();
const mockInvalidateQueries = vi.fn();
const mockUseParams = vi.fn(() => ({ baseItemId: "42" }));
const mockUseWorkspaceRole = vi.fn(() => ({ isOwner: true, allowedPages: null as string[] | null }));

vi.mock("wouter", () => ({
  Link: ({ href, children }: { href: string; children: React.ReactNode }) => (
    <a href={href}>{children}</a>
  ),
  useParams: () => mockUseParams(),
  useSearch: () => "",
}));

vi.mock("@tanstack/react-query", () => ({
  useQueryClient: () => ({ invalidateQueries: mockInvalidateQueries }),
  useQuery: () => ({ data: { categories: [] }, isLoading: false }),
}));

const mockToast = vi.fn();
vi.mock("@/hooks/use-toast", () => ({
  useToast: () => ({ toast: mockToast }),
}));

vi.mock("@/hooks/use-workspace-role", () => ({
  useWorkspaceRole: () => mockUseWorkspaceRole(),
}));

vi.mock("@/lib/imageUrl", () => ({
  imageUrl: (url: string | null) => url,
}));

const mockUseGetBaseItem = vi.fn();
const mockUseGetBaseItemProducts = vi.fn();
const mockUseGetBaseItemLocationStatuses = vi.fn();
const mockUsePatchBaseItemLocationStatus = vi.fn();
const mockUsePatchBaseItem = vi.fn();

vi.mock("@workspace/api-client-react", () => ({
  useGetBaseItem: (...args: unknown[]) => mockUseGetBaseItem(...args),
  useGetBaseItemProducts: (...args: unknown[]) => mockUseGetBaseItemProducts(...args),
  useGetBaseItemLocationStatuses: (...args: unknown[]) =>
    mockUseGetBaseItemLocationStatuses(...args),
  usePatchBaseItemLocationStatus: (...args: unknown[]) =>
    mockUsePatchBaseItemLocationStatus(...args),
  usePatchBaseItem: (...args: unknown[]) => mockUsePatchBaseItem(...args),
  getGetBaseItemLocationStatusesQueryKey: (id: number) => [
    `/api/base-items/${id}/location-statuses`,
  ],
  getGetBaseItemQueryKey: (id: number) => [`/api/base-items/${id}`],
  useListBaseItemPackages: () => ({ data: undefined, isLoading: false }),
  useCreateBaseItemPackage: () => ({ mutate: vi.fn(), isPending: false }),
  useDeleteBaseItemPackage: () => ({ mutate: vi.fn(), isPending: false }),
  getListBaseItemPackagesQueryKey: (id: number) => [`/api/base-items/${id}/packages`],
  useListBaseItemSuppliers: () => ({ data: undefined, isLoading: false }),
  useCreateBaseItemSupplier: () => ({ mutate: vi.fn(), isPending: false }),
  usePatchBaseItemSupplier: () => ({ mutate: vi.fn(), isPending: false }),
  useDeleteBaseItemSupplier: () => ({ mutate: vi.fn(), isPending: false }),
  useListSuppliers: () => ({ data: undefined, isLoading: false }),
  getListBaseItemSuppliersQueryKey: (id: number) => [`/api/base-items/${id}/suppliers`],
  useListBaseItemAdjustments: () => ({ data: { adjustments: [] }, isLoading: false }),
  useCreateBaseItemAdjustment: () => ({ mutate: vi.fn(), isPending: false }),
  getListBaseItemAdjustmentsQueryKey: (id: number) => [`/api/base-items/${id}/adjustments`],
  useGetBaseItemInventoryOverview: () => ({ data: undefined, isLoading: false }),
  getGetBaseItemInventoryOverviewQueryKey: (id: number) => [`/api/base-items/${id}/inventory-overview`],
  useListBaseItemCountryThresholds: () => ({ data: undefined, isLoading: false }),
  getListBaseItemCountryThresholdsQueryKey: (id: number) => [`/api/base-items/${id}/country-thresholds`],
  useUpsertBaseItemCountryThreshold: () => ({ mutate: vi.fn(), isPending: false }),
  useCreateBaseItemTransfer: () => ({ mutate: vi.fn(), isPending: false }),
  usePatchBaseItemLocationStock: () => ({ mutate: vi.fn(), isPending: false }),
  useListBaseItemAuditLog: () => ({ data: { entries: [], total: 0, page: 1, limit: 25 }, isLoading: false }),
  BaseItemAdjustmentCreateReason: {
    receive: "receive",
    remove: "remove",
    damage: "damage",
    correction: "correction",
    return: "return",
    other: "other",
  },
}));

vi.mock("@/lib/queryClient", () => ({
  apiFetch: vi.fn().mockResolvedValue({ categories: [] }),
}));

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

type ProductLinkFixture = {
  id: number;
  name: string;
  category: string;
  status: string;
  quantity: string;
  unit: string | null;
  recipe_updated_at: string;
  image_url: string | null;
  brand_id: number | null;
  brand_logo_id: number | null;
};

const BASE_ITEM = {
  id: 42,
  name: "Red Roses",
  code: "RR-001",
  alternate_name: "Rosa Roja",
  image_url: null,
  main_category_name: "Flowers",
  sub_category_name: "Spring",
  accounting_category: "Fresh",
  tax_rate: 10,
  created_at: "2024-01-15T00:00:00Z",
  stock: 0,
  low_stock_threshold: 0,
};

const PRODUCT_LINKS: ProductLinkFixture[] = [
  { id: 1, name: "Rose Bouquet", category: "Arrangements", status: "available", quantity: "2.00", unit: "stems", recipe_updated_at: "2024-01-01T00:00:00Z", image_url: null, brand_id: null, brand_logo_id: null },
  { id: 2, name: "Mixed Posy", category: "Posy", status: "out_of_stock", quantity: "1.00", unit: null, recipe_updated_at: "2024-01-02T00:00:00Z", image_url: null, brand_id: null, brand_logo_id: null },
];

const LOCATION_STATUSES = [
  { location_id: 10, location_name: "Main Store", is_active: true },
  { location_id: 11, location_name: "Warehouse", is_active: false },
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function setupDefaults({
  itemLoading = false,
  itemError = false,
  item = BASE_ITEM as typeof BASE_ITEM | undefined,
  productsLoading = false,
  products = [] as ProductLinkFixture[],
  locationsLoading = false,
  locationStatuses = [] as typeof LOCATION_STATUSES,
} = {}) {
  mockUseGetBaseItem.mockReturnValue({
    data: item ? { item } : undefined,
    isLoading: itemLoading,
    isError: itemError,
  });
  mockUseGetBaseItemProducts.mockReturnValue({
    data: { products },
    isLoading: productsLoading,
  });
  mockUseGetBaseItemLocationStatuses.mockReturnValue({
    data: { locationStatuses },
    isLoading: locationsLoading,
  });
  mockUsePatchBaseItemLocationStatus.mockReturnValue({ mutate: mockMutate, isPending: false });
  mockUsePatchBaseItem.mockReturnValue({ mutate: mockMutate, isPending: false });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockUseParams.mockReturnValue({ baseItemId: "42" });
  mockUseWorkspaceRole.mockReturnValue({ isOwner: true, allowedPages: null });
});

// ---------------------------------------------------------------------------
// Tests: page loading and tabs
// ---------------------------------------------------------------------------

describe("BaseItemDetailPage – initial render and tabs", () => {
  it("shows a loading indicator while the base item is being fetched", () => {
    setupDefaults({ itemLoading: true, item: undefined });
    render(<BaseItemDetailPage />);

    expect(screen.getByText(/loading/i)).toBeInTheDocument();
  });

  it("shows an error state when the base item cannot be fetched", () => {
    setupDefaults({ itemError: true, item: undefined });
    render(<BaseItemDetailPage />);

    expect(screen.getByText(/base item not found/i)).toBeInTheDocument();
  });

  it("renders the item name as a heading once data is loaded", () => {
    setupDefaults();
    render(<BaseItemDetailPage />);

    expect(screen.getByRole("heading", { name: "Red Roses" })).toBeInTheDocument();
  });

  it("renders the item code beneath the heading", () => {
    setupDefaults();
    render(<BaseItemDetailPage />);

    // code appears in the monospace subtitle; use getAllByText since it may appear in details too
    const codeEls = screen.getAllByText("RR-001");
    expect(codeEls.length).toBeGreaterThan(0);
  });

  it("renders all five tabs when the base item loads successfully", () => {
    setupDefaults();
    render(<BaseItemDetailPage />);

    expect(screen.getByRole("tab", { name: /base item details/i })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: /packaging/i })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: /suppliers/i })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: /inventory/i })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: /products/i })).toBeInTheDocument();
  });

  it("displays item field values in the default Details tab", () => {
    setupDefaults();
    render(<BaseItemDetailPage />);

    expect(screen.getByText("Rosa Roja")).toBeInTheDocument();
    expect(screen.getByText("Flowers › Spring")).toBeInTheDocument();
    expect(screen.getByText("10%")).toBeInTheDocument();
  });

  it("shows the back-to-base-items navigation link", () => {
    setupDefaults();
    render(<BaseItemDetailPage />);

    const backLink = screen.getByRole("link", { name: /base items/i });
    expect(backLink).toBeInTheDocument();
    expect(backLink).toHaveAttribute("href", "/base-items");
  });
});

// ---------------------------------------------------------------------------
// Tests: Products tab
// ---------------------------------------------------------------------------

describe("BaseItemDetailPage – Products tab", () => {
  it("shows an empty state when no products are linked", async () => {
    const user = userEvent.setup();
    setupDefaults({ products: [] });
    render(<BaseItemDetailPage />);

    await user.click(screen.getByRole("tab", { name: /products/i }));

    await waitFor(() => {
      expect(screen.getByText(/not currently used in any product recipes/i)).toBeInTheDocument();
    });
  });

  it("lists all linked products when products are available", async () => {
    const user = userEvent.setup();
    setupDefaults({ products: PRODUCT_LINKS });
    render(<BaseItemDetailPage />);

    await user.click(screen.getByRole("tab", { name: /products/i }));

    await waitFor(() => {
      expect(screen.getByText("Rose Bouquet")).toBeInTheDocument();
      expect(screen.getByText("Mixed Posy")).toBeInTheDocument();
    });
  });

  it("renders each product as a link that opens in a new tab", async () => {
    const user = userEvent.setup();
    setupDefaults({ products: PRODUCT_LINKS });
    render(<BaseItemDetailPage />);

    await user.click(screen.getByRole("tab", { name: /products/i }));

    await waitFor(() => {
      const viewLinks = screen.getAllByRole("link", { name: /view product/i });
      expect(viewLinks.length).toBeGreaterThan(0);
      for (const link of viewLinks) {
        expect(link).toHaveAttribute("target", "_blank");
        expect(link).toHaveAttribute("rel", "noopener noreferrer");
      }
    });
  });

  it("links each product to the correct product URL", async () => {
    const user = userEvent.setup();
    setupDefaults({ products: PRODUCT_LINKS });
    render(<BaseItemDetailPage />);

    await user.click(screen.getByRole("tab", { name: /products/i }));

    await waitFor(() => {
      const viewLinks = screen.getAllByRole("link", { name: /view product/i });
      const hrefs = viewLinks.map((l) => l.getAttribute("href"));
      expect(hrefs).toContain("/products/1");
      expect(hrefs).toContain("/products/2");
    });
  });

  it("shows a loading spinner while products are being fetched", async () => {
    const user = userEvent.setup();
    setupDefaults({ productsLoading: true, products: [] });
    render(<BaseItemDetailPage />);

    await user.click(screen.getByRole("tab", { name: /products/i }));

    await waitFor(() => {
      expect(screen.getByText(/loading products/i)).toBeInTheDocument();
    });
  });

  it("renders an <img> element for a product that has an image_url", async () => {
    const user = userEvent.setup();
    const productsWithImage = [
      {
        id: 10,
        name: "Floral Box",
        category: "Packaging",
        status: "available",
        quantity: "1.00",
        unit: null,
        recipe_updated_at: "2024-01-01T00:00:00Z",
        image_url: "/objects/owner/products/abc123",
        brand_id: null,
        brand_logo_id: null,
      },
    ];
    setupDefaults({ products: productsWithImage });
    render(<BaseItemDetailPage />);

    await user.click(screen.getByRole("tab", { name: /products/i }));

    await waitFor(() => {
      expect(screen.getByText("Floral Box")).toBeInTheDocument();
    });

    const img = document.querySelector('img[src="/objects/owner/products/abc123"]');
    expect(img).toBeInTheDocument();
  });

  it("does not render an <img> element when a product has no image_url", async () => {
    const user = userEvent.setup();
    const productsWithoutImage = [
      {
        id: 20,
        name: "Plain Tag",
        category: "Tags",
        status: "available",
        quantity: "1.00",
        unit: null,
        recipe_updated_at: "2024-01-01T00:00:00Z",
        image_url: null,
        brand_id: null,
        brand_logo_id: null,
      },
    ];
    setupDefaults({ products: productsWithoutImage });
    render(<BaseItemDetailPage />);

    await user.click(screen.getByRole("tab", { name: /products/i }));

    await waitFor(() => {
      expect(screen.getByText("Plain Tag")).toBeInTheDocument();
    });

    expect(document.querySelector("img")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Tests: Active Locations toggles
// ---------------------------------------------------------------------------

describe("BaseItemDetailPage – Active Locations panel", () => {
  it("renders location names with their toggle switches", () => {
    setupDefaults({ locationStatuses: LOCATION_STATUSES });
    render(<BaseItemDetailPage />);

    expect(screen.getByText("Main Store")).toBeInTheDocument();
    expect(screen.getByText("Warehouse")).toBeInTheDocument();
  });

  it("reflects the current is_active state in each switch", () => {
    setupDefaults({ locationStatuses: LOCATION_STATUSES });
    render(<BaseItemDetailPage />);

    expect(screen.getByRole("switch", { name: /main store active/i })).toBeChecked();
    expect(screen.getByRole("switch", { name: /warehouse active/i })).not.toBeChecked();
  });

  it("calls mutate with isActive: true when activating an inactive location", () => {
    setupDefaults({ locationStatuses: LOCATION_STATUSES });
    render(<BaseItemDetailPage />);

    fireEvent.click(screen.getByRole("switch", { name: /warehouse active/i }));

    expect(mockMutate).toHaveBeenCalledTimes(1);
    expect(mockMutate).toHaveBeenCalledWith({
      id: 42,
      locationId: 11,
      data: { isActive: true },
    });
  });

  it("calls mutate with isActive: false when deactivating an active location", () => {
    setupDefaults({ locationStatuses: LOCATION_STATUSES });
    render(<BaseItemDetailPage />);

    fireEvent.click(screen.getByRole("switch", { name: /main store active/i }));

    expect(mockMutate).toHaveBeenCalledWith({
      id: 42,
      locationId: 10,
      data: { isActive: false },
    });
  });

  it("shows an empty state message when no locations are configured", () => {
    setupDefaults({ locationStatuses: [] });
    render(<BaseItemDetailPage />);

    expect(screen.getByText(/no locations configured/i)).toBeInTheDocument();
  });

  it("disables all switches when the user does not have manage permission", () => {
    mockUseWorkspaceRole.mockReturnValue({ isOwner: false, allowedPages: [] });
    setupDefaults({ locationStatuses: LOCATION_STATUSES });
    render(<BaseItemDetailPage />);

    expect(screen.getByRole("switch", { name: /main store active/i })).toBeDisabled();
    expect(screen.getByRole("switch", { name: /warehouse active/i })).toBeDisabled();
  });

  it("disables the switch for a location while its toggle mutation is in flight", async () => {
    let capturedOnMutate: ((args: { locationId: number }) => void) | undefined;

    // Set up base mocks first, then override the patch mutation hook so we can
    // capture the onMutate callback and trigger it manually.
    setupDefaults({ locationStatuses: LOCATION_STATUSES });
    mockUsePatchBaseItemLocationStatus.mockImplementation(
      ({
        mutation,
      }: {
        mutation: { onMutate: (args: { locationId: number }) => void };
      }) => {
        capturedOnMutate = mutation.onMutate;
        return { mutate: mockMutate, isPending: false };
      },
    );

    render(<BaseItemDetailPage />);

    fireEvent.click(screen.getByRole("switch", { name: /warehouse active/i }));

    await act(async () => {
      capturedOnMutate?.({ locationId: 11 });
    });

    expect(screen.getByRole("switch", { name: /warehouse active/i })).toBeDisabled();
  });

  it("shows a loading spinner while location statuses are being fetched", () => {
    setupDefaults({ locationsLoading: true, locationStatuses: [] });
    render(<BaseItemDetailPage />);

    expect(screen.getByText("Active Locations")).toBeInTheDocument();
    expect(screen.getByText(/^loading…$/i)).toBeInTheDocument();
  });

  it("shows a per-location error message when the toggle mutation fails", async () => {
    let capturedOnError:
      | ((err: unknown, args: { locationId: number }) => void)
      | undefined;

    setupDefaults({ locationStatuses: LOCATION_STATUSES });
    mockUsePatchBaseItemLocationStatus.mockImplementation(
      ({
        mutation,
      }: {
        mutation: {
          onMutate: (args: { locationId: number }) => void;
          onSuccess: (data: unknown, args: { locationId: number }) => void;
          onError: (err: unknown, args: { locationId: number }) => void;
        };
      }) => {
        capturedOnError = mutation.onError;
        return { mutate: mockMutate, isPending: false };
      },
    );

    render(<BaseItemDetailPage />);

    await act(async () => {
      capturedOnError?.(new Error("server error"), { locationId: 10 });
    });

    expect(
      screen.getByText(/failed to save\. please try again\./i),
    ).toBeInTheDocument();
  });

  it("also shows a toast notification alongside the inline error when the toggle fails", async () => {
    let capturedOnError:
      | ((err: unknown, args: { locationId: number }) => void)
      | undefined;

    setupDefaults({ locationStatuses: LOCATION_STATUSES });
    mockUsePatchBaseItemLocationStatus.mockImplementation(
      ({
        mutation,
      }: {
        mutation: {
          onMutate: (args: { locationId: number }) => void;
          onSuccess: (data: unknown, args: { locationId: number }) => void;
          onError: (err: unknown, args: { locationId: number }) => void;
        };
      }) => {
        capturedOnError = mutation.onError;
        return { mutate: mockMutate, isPending: false };
      },
    );

    render(<BaseItemDetailPage />);

    await act(async () => {
      capturedOnError?.(new Error("server error"), { locationId: 10 });
    });

    expect(
      screen.getByText(/failed to save\. please try again\./i),
    ).toBeInTheDocument();
    expect(mockToast).toHaveBeenCalledWith(
      expect.objectContaining({ variant: "destructive" }),
    );
  });

  it("clears the inline error when the same toggle is retried", async () => {
    let capturedOnMutate:
      | ((args: { locationId: number }) => void)
      | undefined;
    let capturedOnError:
      | ((err: unknown, args: { locationId: number }) => void)
      | undefined;

    setupDefaults({ locationStatuses: LOCATION_STATUSES });
    mockUsePatchBaseItemLocationStatus.mockImplementation(
      ({
        mutation,
      }: {
        mutation: {
          onMutate: (args: { locationId: number }) => void;
          onSuccess: (data: unknown, args: { locationId: number }) => void;
          onError: (err: unknown, args: { locationId: number }) => void;
        };
      }) => {
        capturedOnMutate = mutation.onMutate;
        capturedOnError = mutation.onError;
        return { mutate: mockMutate, isPending: false };
      },
    );

    render(<BaseItemDetailPage />);

    await act(async () => {
      capturedOnError?.(new Error("server error"), { locationId: 10 });
    });

    expect(
      screen.getByText(/failed to save\. please try again\./i),
    ).toBeInTheDocument();

    await act(async () => {
      capturedOnMutate?.({ locationId: 10 });
    });

    expect(
      screen.queryByText(/failed to save\. please try again\./i),
    ).not.toBeInTheDocument();
  });

  it("shows each location's error only under its own row when multiple toggles fail simultaneously", async () => {
    let capturedOnError:
      | ((err: unknown, args: { locationId: number }) => void)
      | undefined;

    setupDefaults({ locationStatuses: LOCATION_STATUSES });
    mockUsePatchBaseItemLocationStatus.mockImplementation(
      ({
        mutation,
      }: {
        mutation: {
          onMutate: (args: { locationId: number }) => void;
          onSuccess: (data: unknown, args: { locationId: number }) => void;
          onError: (err: unknown, args: { locationId: number }) => void;
        };
      }) => {
        capturedOnError = mutation.onError;
        return { mutate: mockMutate, isPending: false };
      },
    );

    render(<BaseItemDetailPage />);

    await act(async () => {
      capturedOnError?.(new Error("server error"), { locationId: 10 });
      capturedOnError?.(new Error("server error"), { locationId: 11 });
    });

    const mainStoreContainer = screen.getByText("Main Store").parentElement!;
    const warehouseContainer = screen.getByText("Warehouse").parentElement!;

    expect(
      within(mainStoreContainer).getByText(/failed to save\. please try again\./i),
    ).toBeInTheDocument();

    expect(
      within(warehouseContainer).getByText(/failed to save\. please try again\./i),
    ).toBeInTheDocument();

    expect(
      within(mainStoreContainer).queryByText("Warehouse"),
    ).not.toBeInTheDocument();

    expect(
      within(warehouseContainer).queryByText("Main Store"),
    ).not.toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// Tests: Placeholder tabs
// ---------------------------------------------------------------------------

describe("BaseItemDetailPage – placeholder tabs", () => {
  it("shows a placeholder message when the Packaging tab is activated", async () => {
    const user = userEvent.setup();
    setupDefaults();
    render(<BaseItemDetailPage />);

    await user.click(screen.getByRole("tab", { name: /packaging/i }));

    await waitFor(() => {
      expect(screen.getByText(/packaging data is not yet available/i)).toBeInTheDocument();
    });
  });

  it("shows a placeholder message when the Suppliers tab is activated", async () => {
    const user = userEvent.setup();
    setupDefaults();
    render(<BaseItemDetailPage />);

    await user.click(screen.getByRole("tab", { name: /suppliers/i }));

    await waitFor(() => {
      expect(screen.getByText(/suppliers data is not yet available/i)).toBeInTheDocument();
    });
  });

  it("shows the inventory overview and movement history when the Inventory tab is activated", async () => {
    const user = userEvent.setup();
    setupDefaults();
    render(<BaseItemDetailPage />);

    await user.click(screen.getByRole("tab", { name: /inventory/i }));

    await waitFor(() => {
      expect(screen.getByText(/global total/i)).toBeInTheDocument();
      expect(screen.getByRole("button", { name: /adjust/i })).toBeInTheDocument();
      expect(screen.getByText(/movement history/i)).toBeInTheDocument();
    });
  });
});

// ---------------------------------------------------------------------------
// Tests: invalid base item ID
// ---------------------------------------------------------------------------

describe("BaseItemDetailPage – invalid ID handling", () => {
  it("shows an invalid ID error when the route param is not a number", () => {
    mockUseParams.mockReturnValue({ baseItemId: "not-a-number" });
    setupDefaults({ item: undefined });
    render(<BaseItemDetailPage />);

    expect(screen.getByText(/invalid base item id/i)).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// Tests: Edit form – visibility, pre-population, save and cancel
// ---------------------------------------------------------------------------

const EDIT_ITEM = {
  id: 42,
  name: "Red Roses",
  code: "RR-001",
  alternate_name: "Rosa Roja",
  image_url: null,
  main_category_name: "Flowers",
  sub_category_name: "Spring",
  accounting_category: "Fresh",
  tax_rate: 10,
  created_at: "2024-01-15T00:00:00Z",
  stock: 0,
  low_stock_threshold: 0,
};

describe("BaseItemDetailPage – Edit form visibility", () => {
  it("shows the Edit button when the user is an owner", () => {
    mockUseWorkspaceRole.mockReturnValue({ isOwner: true, allowedPages: null });
    setupDefaults({ item: EDIT_ITEM });
    render(<BaseItemDetailPage />);

    expect(screen.getByTestId("button-edit-base-item")).toBeInTheDocument();
  });

  it("shows the Edit button when the user has base_items.manage in allowedPages", () => {
    mockUseWorkspaceRole.mockReturnValue({
      isOwner: false,
      allowedPages: ["base_items", "base_items.manage"],
    });
    setupDefaults({ item: EDIT_ITEM });
    render(<BaseItemDetailPage />);

    expect(screen.getByTestId("button-edit-base-item")).toBeInTheDocument();
  });

  it("hides the Edit button when the user lacks manage permission", () => {
    mockUseWorkspaceRole.mockReturnValue({ isOwner: false, allowedPages: ["base_items"] });
    setupDefaults({ item: EDIT_ITEM });
    render(<BaseItemDetailPage />);

    expect(screen.queryByTestId("button-edit-base-item")).not.toBeInTheDocument();
  });

  it("hides the Edit button when allowedPages is empty", () => {
    mockUseWorkspaceRole.mockReturnValue({ isOwner: false, allowedPages: [] });
    setupDefaults({ item: EDIT_ITEM });
    render(<BaseItemDetailPage />);

    expect(screen.queryByTestId("button-edit-base-item")).not.toBeInTheDocument();
  });
});

describe("BaseItemDetailPage – Edit form pre-population", () => {
  it("reveals the edit form when the Edit button is clicked", async () => {
    const user = userEvent.setup();
    mockUseWorkspaceRole.mockReturnValue({ isOwner: true, allowedPages: null });
    setupDefaults({ item: EDIT_ITEM });
    render(<BaseItemDetailPage />);

    await user.click(screen.getByTestId("button-edit-base-item"));

    expect(screen.getByLabelText(/^name/i)).toBeInTheDocument();
  });

  it("pre-fills the Name field with the item's current name", async () => {
    const user = userEvent.setup();
    mockUseWorkspaceRole.mockReturnValue({ isOwner: true, allowedPages: null });
    setupDefaults({ item: EDIT_ITEM });
    render(<BaseItemDetailPage />);

    await user.click(screen.getByTestId("button-edit-base-item"));

    expect(screen.getByLabelText(/^name/i)).toHaveValue("Red Roses");
  });

  it("pre-fills the Alternate Name field with the item's current alternate name", async () => {
    const user = userEvent.setup();
    mockUseWorkspaceRole.mockReturnValue({ isOwner: true, allowedPages: null });
    setupDefaults({ item: EDIT_ITEM });
    render(<BaseItemDetailPage />);

    await user.click(screen.getByTestId("button-edit-base-item"));

    expect(screen.getByLabelText(/alternate name/i)).toHaveValue("Rosa Roja");
  });

  it("pre-fills the Accounting Category field with the item's current value", async () => {
    const user = userEvent.setup();
    mockUseWorkspaceRole.mockReturnValue({ isOwner: true, allowedPages: null });
    setupDefaults({ item: EDIT_ITEM });
    render(<BaseItemDetailPage />);

    await user.click(screen.getByTestId("button-edit-base-item"));

    expect(screen.getByLabelText(/accounting category/i)).toHaveValue("Fresh");
  });

  it("pre-fills the Tax Rate field with the item's current tax rate", async () => {
    const user = userEvent.setup();
    mockUseWorkspaceRole.mockReturnValue({ isOwner: true, allowedPages: null });
    setupDefaults({ item: EDIT_ITEM });
    render(<BaseItemDetailPage />);

    await user.click(screen.getByTestId("button-edit-base-item"));

    expect(screen.getByLabelText(/tax rate/i)).toHaveValue(10);
  });
});

describe("BaseItemDetailPage – Edit form save", () => {
  it("calls usePatchBaseItem.mutate with the correct payload when Save is clicked", async () => {
    const mockPatchMutate = vi.fn();
    const user = userEvent.setup();
    mockUseWorkspaceRole.mockReturnValue({ isOwner: true, allowedPages: null });
    setupDefaults({ item: EDIT_ITEM });
    mockUsePatchBaseItem.mockReturnValue({ mutate: mockPatchMutate, isPending: false });
    render(<BaseItemDetailPage />);

    await user.click(screen.getByTestId("button-edit-base-item"));
    await user.click(screen.getByRole("button", { name: /save changes/i }));

    expect(mockPatchMutate).toHaveBeenCalledTimes(1);
    expect(mockPatchMutate).toHaveBeenCalledWith({
      id: 42,
      data: {
        name: "Red Roses",
        alternate_name: "Rosa Roja",
        category_id: null,
        accounting_category: "Fresh",
        tax_category: "not_classified",
        tax_rate: "10",
        image_url: null,
      },
    });
  });

  it("does not call mutate when the Name field is cleared before saving", async () => {
    const mockPatchMutate = vi.fn();
    const user = userEvent.setup();
    mockUseWorkspaceRole.mockReturnValue({ isOwner: true, allowedPages: null });
    setupDefaults({ item: EDIT_ITEM });
    mockUsePatchBaseItem.mockReturnValue({ mutate: mockPatchMutate, isPending: false });
    render(<BaseItemDetailPage />);

    await user.click(screen.getByTestId("button-edit-base-item"));
    await user.clear(screen.getByLabelText(/^name/i));
    await user.click(screen.getByRole("button", { name: /save changes/i }));

    expect(mockPatchMutate).not.toHaveBeenCalled();
  });

  it("calls mutate with the updated name after the user edits the Name field", async () => {
    const mockPatchMutate = vi.fn();
    const user = userEvent.setup();
    mockUseWorkspaceRole.mockReturnValue({ isOwner: true, allowedPages: null });
    setupDefaults({ item: EDIT_ITEM });
    mockUsePatchBaseItem.mockReturnValue({ mutate: mockPatchMutate, isPending: false });
    render(<BaseItemDetailPage />);

    await user.click(screen.getByTestId("button-edit-base-item"));
    const nameInput = screen.getByLabelText(/^name/i);
    await user.clear(nameInput);
    await user.type(nameInput, "Pink Roses");
    await user.click(screen.getByRole("button", { name: /save changes/i }));

    expect(mockPatchMutate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ name: "Pink Roses" }),
      }),
    );
  });

  it("sends null for alternate_name when the field is cleared before saving", async () => {
    const mockPatchMutate = vi.fn();
    const user = userEvent.setup();
    mockUseWorkspaceRole.mockReturnValue({ isOwner: true, allowedPages: null });
    setupDefaults({ item: EDIT_ITEM });
    mockUsePatchBaseItem.mockReturnValue({ mutate: mockPatchMutate, isPending: false });
    render(<BaseItemDetailPage />);

    await user.click(screen.getByTestId("button-edit-base-item"));
    await user.clear(screen.getByLabelText(/alternate name/i));
    await user.click(screen.getByRole("button", { name: /save changes/i }));

    expect(mockPatchMutate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ alternate_name: null }),
      }),
    );
  });

  it("closes the form and fires a success toast after onSuccess resolves", async () => {
    let capturedOnSuccess: (() => void) | undefined;

    const user = userEvent.setup();
    mockUseWorkspaceRole.mockReturnValue({ isOwner: true, allowedPages: null });
    setupDefaults({ item: EDIT_ITEM });
    mockUsePatchBaseItem.mockImplementation(
      ({
        mutation,
      }: {
        mutation: {
          onSuccess: () => void;
          onError: (err: unknown) => void;
        };
      }) => {
        capturedOnSuccess = mutation.onSuccess;
        return { mutate: vi.fn(), isPending: false };
      },
    );
    render(<BaseItemDetailPage />);

    await user.click(screen.getByTestId("button-edit-base-item"));
    expect(screen.getByLabelText(/^name/i)).toBeInTheDocument();

    await act(async () => {
      capturedOnSuccess?.();
    });

    expect(screen.queryByLabelText(/^name/i)).not.toBeInTheDocument();
    expect(mockToast).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Base item updated" }),
    );
  });

  it("fires a destructive toast with the server error message after onError resolves", async () => {
    let capturedOnError: ((err: unknown) => void) | undefined;

    const user = userEvent.setup();
    mockUseWorkspaceRole.mockReturnValue({ isOwner: true, allowedPages: null });
    setupDefaults({ item: EDIT_ITEM });
    mockUsePatchBaseItem.mockImplementation(
      ({
        mutation,
      }: {
        mutation: {
          onSuccess: () => void;
          onError: (err: unknown) => void;
        };
      }) => {
        capturedOnError = mutation.onError;
        return { mutate: vi.fn(), isPending: false };
      },
    );
    render(<BaseItemDetailPage />);

    await user.click(screen.getByTestId("button-edit-base-item"));
    expect(screen.getByLabelText(/^name/i)).toBeInTheDocument();

    await act(async () => {
      capturedOnError?.(new Error("Name already taken"));
    });

    expect(mockToast).toHaveBeenCalledWith(
      expect.objectContaining({
        variant: "destructive",
        description: "Name already taken",
      }),
    );
    expect(screen.getByLabelText(/^name/i)).toBeInTheDocument();
  });
});

describe("BaseItemDetailPage – Edit form cancel", () => {
  it("hides the form and returns to read-only view when Cancel is clicked", async () => {
    const user = userEvent.setup();
    mockUseWorkspaceRole.mockReturnValue({ isOwner: true, allowedPages: null });
    setupDefaults({ item: EDIT_ITEM });
    render(<BaseItemDetailPage />);

    await user.click(screen.getByTestId("button-edit-base-item"));

    expect(screen.getByLabelText(/^name/i)).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /cancel/i }));

    expect(screen.queryByLabelText(/^name/i)).not.toBeInTheDocument();
  });

  it("does not call usePatchBaseItem.mutate when Cancel is clicked", async () => {
    const mockPatchMutate = vi.fn();
    const user = userEvent.setup();
    mockUseWorkspaceRole.mockReturnValue({ isOwner: true, allowedPages: null });
    setupDefaults({ item: EDIT_ITEM });
    mockUsePatchBaseItem.mockReturnValue({ mutate: mockPatchMutate, isPending: false });
    render(<BaseItemDetailPage />);

    await user.click(screen.getByTestId("button-edit-base-item"));
    await user.click(screen.getByRole("button", { name: /cancel/i }));

    expect(mockPatchMutate).not.toHaveBeenCalled();
  });

  it("re-shows the Edit button after cancel so the form can be reopened", async () => {
    const user = userEvent.setup();
    mockUseWorkspaceRole.mockReturnValue({ isOwner: true, allowedPages: null });
    setupDefaults({ item: EDIT_ITEM });
    render(<BaseItemDetailPage />);

    await user.click(screen.getByTestId("button-edit-base-item"));
    await user.click(screen.getByRole("button", { name: /cancel/i }));

    expect(screen.getByTestId("button-edit-base-item")).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// Tests: ImageUploadField – upload and AI-generate error paths
// ---------------------------------------------------------------------------

describe("BaseItemDetailPage – ImageUploadField error paths", () => {
  it("shows a destructive toast and an inline error message when file upload fails", async () => {
    const user = userEvent.setup();
    mockUseWorkspaceRole.mockReturnValue({ isOwner: true, allowedPages: null });
    setupDefaults({ item: EDIT_ITEM });

    vi.mocked(apiFetch).mockRejectedValueOnce(new Error("Server rejected the file"));

    render(<BaseItemDetailPage />);
    await user.click(screen.getByTestId("button-edit-base-item"));

    const fileInput = document.querySelector(
      'input[type="file"]',
    ) as HTMLInputElement;
    const file = new File(["img"], "photo.jpg", { type: "image/jpeg" });

    await act(async () => {
      fireEvent.change(fileInput, { target: { files: [file] } });
    });

    await waitFor(() => {
      expect(mockToast).toHaveBeenCalledWith(
        expect.objectContaining({ variant: "destructive" }),
      );
    });

    expect(screen.getByRole("alert")).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent("Server rejected the file");
  });

  it("shows a destructive toast and an inline error message when AI image generation fails", async () => {
    const user = userEvent.setup();
    mockUseWorkspaceRole.mockReturnValue({ isOwner: true, allowedPages: null });
    setupDefaults({ item: EDIT_ITEM });

    vi.mocked(apiFetch).mockRejectedValueOnce(new Error("AI service unavailable"));

    render(<BaseItemDetailPage />);
    await user.click(screen.getByTestId("button-edit-base-item"));

    await user.click(screen.getByRole("button", { name: /generate with ai/i }));

    const promptInput = screen.getByPlaceholderText(/describe the image/i);
    await user.type(promptInput, "red roses bouquet");

    await user.click(screen.getByRole("button", { name: /^generate$/i }));

    await waitFor(() => {
      expect(mockToast).toHaveBeenCalledWith(
        expect.objectContaining({ variant: "destructive" }),
      );
    });

    expect(screen.getByRole("alert")).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent("AI service unavailable");
  });
});

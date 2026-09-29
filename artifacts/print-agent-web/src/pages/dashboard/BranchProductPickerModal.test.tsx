import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { BranchProductPickerModal } from "./BranchProductPickerModal";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock("@/lib/imageUrl", () => ({
  imageUrl: (url: string | null | undefined) => url ?? null,
}));

vi.mock("@/lib/queryClient", () => ({
  apiFetch: vi.fn(),
  queryClient: { invalidateQueries: vi.fn() },
  getClerkToken: vi.fn().mockResolvedValue("mock-token"),
}));

const mockUseQuery = vi.fn();
const mockUseListCatalogCategories = vi.fn();

vi.mock("@tanstack/react-query", () => ({
  useQuery: (...args: unknown[]) => mockUseQuery(...args),
  useQueryClient: vi.fn(() => ({ invalidateQueries: vi.fn() })),
}));

vi.mock("@workspace/api-client-react", () => ({
  useListCatalogCategories: (...args: unknown[]) =>
    mockUseListCatalogCategories(...args),
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const MOCK_PRODUCTS = [
  {
    id: 1,
    name: "Red Rose Bouquet",
    sku: "RRB-001",
    barcode: null,
    price_usd: "25.00",
    main_image_url: null,
    status: "active",
    catalog_categories: [{ id: 10, name: "Flowers" }],
  },
  {
    id: 2,
    name: "Tulip Arrangement",
    sku: "TA-002",
    barcode: null,
    price_usd: "30.00",
    main_image_url: null,
    status: "active",
    catalog_categories: [{ id: 10, name: "Flowers" }],
  },
  {
    id: 3,
    name: "Gift Box Premium",
    sku: "GBP-003",
    barcode: "1234567890",
    price_usd: "50.00",
    main_image_url: null,
    status: "active",
    catalog_categories: [{ id: 11, name: "Gifts" }],
  },
];

const MOCK_CATEGORIES = [
  { id: 10, name: "Flowers", product_count: 2 },
  { id: 11, name: "Gifts", product_count: 1 },
];

function makeProductsResponse(products = MOCK_PRODUCTS) {
  return {
    data: { products, total: products.length, page: 1, limit: 24 },
    isLoading: false,
    isError: false,
    refetch: vi.fn(),
  };
}

function makeCategoriesResponse(items = MOCK_CATEGORIES) {
  return {
    data: { items, total: items.length, page: 1, pageSize: 100, totalPages: 1 },
    isLoading: false,
    isError: false,
  };
}

function renderModal(props: Partial<Parameters<typeof BranchProductPickerModal>[0]> = {}) {
  const defaultProps = {
    open: true,
    onClose: vi.fn(),
    onConfirm: vi.fn(),
    onAddCustomItem: vi.fn(),
    initialLineItems: [],
    ...props,
  };
  return { ...render(<BranchProductPickerModal {...defaultProps} />), props: defaultProps };
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks();
  mockUseQuery.mockReturnValue(makeProductsResponse());
  mockUseListCatalogCategories.mockReturnValue(makeCategoriesResponse());
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("BranchProductPickerModal", () => {
  it("(a) selecting a product adds it to the right panel", async () => {
    renderModal();

    // Product is in the list
    expect(screen.getByText("Red Rose Bouquet")).toBeTruthy();

    // Click + to add qty 1
    const productRows = screen.getAllByRole("listitem").filter((el) =>
      el.textContent?.includes("Red Rose Bouquet"),
    );
    const increaseBtn = within(productRows[0]).getByLabelText("Increase quantity");
    fireEvent.click(increaseBtn);

    // Should appear in the selected panel
    const selectedPanel = screen.getByRole("list", { name: /selected products/i });
    expect(within(selectedPanel).getByText("Red Rose Bouquet")).toBeTruthy();
  });

  it("(b) qty stepper in catalogue row and selected panel stay in sync", async () => {
    renderModal();

    // Add product via catalogue stepper
    const productRows = screen.getAllByRole("listitem").filter((el) =>
      el.textContent?.includes("Red Rose Bouquet"),
    );
    const increaseBtn = within(productRows[0]).getByLabelText("Increase quantity");
    fireEvent.click(increaseBtn);
    fireEvent.click(increaseBtn); // qty = 2

    // Panel should show qty 2
    const selectedPanel = screen.getByRole("list", { name: /selected products/i });
    const panelItems = within(selectedPanel).getAllByRole("listitem");
    const panelItem = panelItems.find((el) => el.textContent?.includes("Red Rose Bouquet"));
    expect(panelItem).toBeTruthy();

    const panelQtyInput = within(panelItem!).getByLabelText("Quantity") as HTMLInputElement;
    expect(panelQtyInput.value).toBe("2");

    // Change qty in panel — should reflect back (catalogue row for same product should update)
    fireEvent.change(panelQtyInput, { target: { value: "5" } });

    // Verify catalogue row qty input also updated
    const catalogueQtyInputs = within(productRows[0]).getAllByLabelText("Quantity") as HTMLInputElement[];
    expect(catalogueQtyInputs[0].value).toBe("5");
  });

  it("(c) setting qty to 0 removes from panel and resets catalogue row", async () => {
    renderModal();

    // Add the product
    const productRows = screen.getAllByRole("listitem").filter((el) =>
      el.textContent?.includes("Tulip Arrangement"),
    );
    const increaseBtn = within(productRows[0]).getByLabelText("Increase quantity");
    fireEvent.click(increaseBtn); // qty = 1

    // Verify it's in the panel
    const selectedPanel = screen.getByRole("list", { name: /selected products/i });
    expect(within(selectedPanel).getByText("Tulip Arrangement")).toBeTruthy();

    // Decrease back to 0 via catalogue stepper
    const decreaseBtn = within(productRows[0]).getByLabelText("Decrease quantity");
    fireEvent.click(decreaseBtn); // qty → 0, should remove

    // Panel should no longer contain the item
    await waitFor(() => {
      const panelItems = within(selectedPanel).queryAllByRole("listitem");
      const tulipItem = panelItems.find((el) => el.textContent?.includes("Tulip Arrangement"));
      expect(tulipItem).toBeFalsy();
    });

    // Catalogue row qty input should be empty / 0
    const qtyInput = within(productRows[0]).getByLabelText("Quantity") as HTMLInputElement;
    expect(qtyInput.value).toBe("");
  });

  it("(d) selections persist after switching categories", async () => {
    renderModal();

    // Add product 1
    const productRows = screen.getAllByRole("listitem").filter((el) =>
      el.textContent?.includes("Red Rose Bouquet"),
    );
    fireEvent.click(within(productRows[0]).getByLabelText("Increase quantity"));

    // Switch category — mock will return different products for the new query
    mockUseQuery.mockReturnValue(
      makeProductsResponse([MOCK_PRODUCTS[2]]), // only Gift Box
    );

    const flowersBtn = screen.getByText("Flowers");
    fireEvent.click(flowersBtn);

    // Selected panel still shows Red Rose Bouquet
    const selectedPanel = screen.getByRole("list", { name: /selected products/i });
    expect(within(selectedPanel).getByText("Red Rose Bouquet")).toBeTruthy();
  });

  it("(e) Cancel calls onClose without calling onConfirm", () => {
    const onClose = vi.fn();
    const onConfirm = vi.fn();
    renderModal({ onClose, onConfirm });

    const cancelBtn = screen.getByRole("button", { name: /cancel/i });
    fireEvent.click(cancelBtn);

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it("(f) Confirm calls onConfirm with correct product/qty payload", async () => {
    const onConfirm = vi.fn();
    renderModal({ onConfirm });

    // Add product 1 with qty 3
    const productRows = screen.getAllByRole("listitem").filter((el) =>
      el.textContent?.includes("Red Rose Bouquet"),
    );
    const increaseBtn = within(productRows[0]).getByLabelText("Increase quantity");
    fireEvent.click(increaseBtn);
    fireEvent.click(increaseBtn);
    fireEvent.click(increaseBtn);

    // Find and click the confirm button
    const confirmBtn = screen.getByRole("button", { name: /add 1 product/i });
    fireEvent.click(confirmBtn);

    expect(onConfirm).toHaveBeenCalledTimes(1);
    const [lineItems] = onConfirm.mock.calls[0];
    expect(lineItems).toHaveLength(1);
    expect(lineItems[0]).toMatchObject({
      product_id: 1,
      productName: "Red Rose Bouquet",
      requested_qty: 3,
      unit_price: "25.00",
      customMode: false,
    });
  });

  it("(g) quantity input ignores zero, negative, and non-integer values", async () => {
    renderModal();

    // First add the product so the panel qty input is visible
    const productRows = screen.getAllByRole("listitem").filter((el) =>
      el.textContent?.includes("Gift Box Premium"),
    );
    fireEvent.click(within(productRows[0]).getByLabelText("Increase quantity")); // qty = 1

    // Grab the catalogue qty input
    const catalogueQtyInput = within(productRows[0]).getByLabelText("Quantity") as HTMLInputElement;

    // Typing a non-integer (float) — should not change state
    fireEvent.change(catalogueQtyInput, { target: { value: "2.5" } });
    expect(catalogueQtyInput.value).toBe("1"); // stays 1

    // Typing negative — input has min=0, value should be ignored
    fireEvent.change(catalogueQtyInput, { target: { value: "-1" } });
    expect(catalogueQtyInput.value).toBe("1"); // stays 1

    // Confirm button should still be enabled with qty 1
    expect(screen.getByRole("button", { name: /add 1 product/i })).toBeTruthy();
  });

  it("(h) initialLineItems pre-populates selections on open", () => {
    const initialLineItems = [
      {
        product_id: 2,
        productName: "Tulip Arrangement",
        requested_qty: 4,
        unit_price: "30.00",
        notes: "",
        customMode: false,
        image_url: null,
      },
    ];

    renderModal({ initialLineItems });

    // Should see it in the selected panel immediately
    const selectedPanel = screen.getByRole("list", { name: /selected products/i });
    expect(within(selectedPanel).getByText("Tulip Arrangement")).toBeTruthy();

    // Qty should be 4
    const panelItems = within(selectedPanel).getAllByRole("listitem");
    const panelItem = panelItems.find((el) => el.textContent?.includes("Tulip Arrangement"));
    const qtyInput = within(panelItem!).getByLabelText("Quantity") as HTMLInputElement;
    expect(qtyInput.value).toBe("4");

    // Footer should reflect 1 product, 4 units
    expect(screen.getByRole("button", { name: /add 1 product/i })).toBeTruthy();
  });

  it("confirm button is disabled when nothing is selected", () => {
    renderModal();
    // No products added — confirm button should be disabled
    const confirmBtns = screen.getAllByRole("button").filter(
      (b) => b.getAttribute("disabled") !== null && b.textContent?.includes("Add"),
    );
    expect(confirmBtns.length).toBeGreaterThan(0);
  });

  it("'Add as custom item' closes the modal and fires onAddCustomItem", () => {
    const onClose = vi.fn();
    const onAddCustomItem = vi.fn();
    renderModal({ onClose, onAddCustomItem });

    const customBtn = screen.getByRole("button", { name: /add as custom item/i });
    fireEvent.click(customBtn);

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onAddCustomItem).toHaveBeenCalledTimes(1);
  });

  it("blank input on the qty field removes the item from the panel (treated as 0)", async () => {
    renderModal();

    const productRows = screen.getAllByRole("listitem").filter((el) =>
      el.textContent?.includes("Red Rose Bouquet"),
    );
    fireEvent.click(within(productRows[0]).getByLabelText("Increase quantity")); // qty = 1

    const selectedPanel = screen.getByRole("list", { name: /selected products/i });
    expect(within(selectedPanel).getByText("Red Rose Bouquet")).toBeTruthy();

    // Type blank — should remove the item (treated as qty 0)
    const qtyInput = within(productRows[0]).getByLabelText("Quantity") as HTMLInputElement;
    fireEvent.change(qtyInput, { target: { value: "" } });

    await waitFor(() => {
      const panelItems = within(selectedPanel).queryAllByRole("listitem");
      const roseItem = panelItems.find((el) => el.textContent?.includes("Red Rose Bouquet"));
      expect(roseItem).toBeFalsy();
    });
  });

  it("very large quantity is clamped to MAX_QTY (999)", () => {
    renderModal();

    const productRows = screen.getAllByRole("listitem").filter((el) =>
      el.textContent?.includes("Gift Box Premium"),
    );
    fireEvent.click(within(productRows[0]).getByLabelText("Increase quantity")); // qty = 1

    const qtyInput = within(productRows[0]).getByLabelText("Quantity") as HTMLInputElement;
    fireEvent.change(qtyInput, { target: { value: "99999" } });

    // Should be clamped to 999
    expect(qtyInput.value).toBe("999");

    // Confirm payload should also respect the cap
    const onConfirm = vi.fn();
    renderModal({ onConfirm });
    const rows2 = screen.getAllByRole("listitem").filter((el) =>
      el.textContent?.includes("Gift Box Premium"),
    );
    fireEvent.click(within(rows2[0]).getByLabelText("Increase quantity"));
    const inp2 = within(rows2[0]).getByLabelText("Quantity") as HTMLInputElement;
    fireEvent.change(inp2, { target: { value: "5000" } });
    expect(inp2.value).toBe("999");
  });

  it("+ button does not go above MAX_QTY (999)", () => {
    renderModal();

    const productRows = screen.getAllByRole("listitem").filter((el) =>
      el.textContent?.includes("Tulip Arrangement"),
    );
    const increaseBtn = within(productRows[0]).getByLabelText("Increase quantity");
    const qtyInput = within(productRows[0]).getByLabelText("Quantity") as HTMLInputElement;

    // Set to 999 via typed input first
    fireEvent.click(increaseBtn); // qty = 1
    fireEvent.change(qtyInput, { target: { value: "999" } });
    expect(qtyInput.value).toBe("999");

    // Clicking + should not go above 999
    fireEvent.click(increaseBtn);
    expect(qtyInput.value).toBe("999");
  });

  it("search input is rendered and accepts text for filtering", () => {
    renderModal();

    const searchInput = screen.getByLabelText("Search products");
    expect(searchInput).toBeTruthy();

    fireEvent.change(searchInput, { target: { value: "rose" } });
    expect((searchInput as HTMLInputElement).value).toBe("rose");
  });

  it("switching category updates the active nav item", () => {
    renderModal();

    // Initially 'All products' is active
    const allBtn = screen.getByText("All products");
    expect(allBtn.closest("button")?.getAttribute("aria-current")).toBe("true");

    // Click 'Flowers' category
    const flowersBtn = screen.getByText("Flowers").closest("button")!;
    fireEvent.click(flowersBtn);

    expect(flowersBtn.getAttribute("aria-current")).toBe("true");
    expect(allBtn.closest("button")?.getAttribute("aria-current")).toBeNull();
  });

  it("useQuery is called with the category param when a category is selected", () => {
    renderModal();

    // Record the first call's queryKey
    const firstCall = mockUseQuery.mock.calls[0];
    expect(firstCall[0].queryKey).toEqual([
      "cmc-pos-branch-products-picker",
      "", // debouncedSearch (empty)
      null, // activeCategory (All)
      1, // page
    ]);

    // Switch to Flowers
    fireEvent.click(screen.getByText("Flowers"));

    // useQuery should be called again with the new category
    const lastCall = mockUseQuery.mock.calls[mockUseQuery.mock.calls.length - 1];
    expect(lastCall[0].queryKey[2]).toBe("Flowers");
  });
});

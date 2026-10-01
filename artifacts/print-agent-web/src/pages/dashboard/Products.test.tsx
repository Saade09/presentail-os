import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, act, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import ProductsPage, { SEARCH_DEBOUNCE_MS } from "./Products";
import { apiFetch } from "@/lib/queryClient";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockNavigate = vi.fn();
let mockSearch = "";
let mockLocation = "/products";

vi.mock("wouter", () => ({
  useSearch: () => mockSearch,
  useLocation: () => [mockLocation, mockNavigate],
  Link: ({ href, children }: { href: string; children: React.ReactNode }) => (
    <a href={href}>{children}</a>
  ),
}));

const mockUseQuery = vi.fn();
const mockUseMutation = vi.fn();
const mockInvalidateQueries = vi.fn();
const mockToast = vi.fn();
let mockProductCountryAvailability: {
  countries: Array<{
    country_code: string;
    country_name: string;
    flag_emoji: string | null;
    is_available: boolean;
  }>;
} | undefined;
let mockProductCityAvailability: {
  cities: Array<{
    city_id: number;
    city_name: string;
    country_code: string;
    city_is_active: boolean;
    is_available: boolean;
  }>;
} | undefined;

vi.mock("@tanstack/react-query", () => ({
  useQuery: (opts: { queryKey: unknown[] }) => mockUseQuery(opts),
  useMutation: (opts: unknown) => mockUseMutation(opts),
  useQueryClient: () => ({ invalidateQueries: mockInvalidateQueries }),
}));

vi.mock("@/lib/queryClient", () => ({
  apiFetch: vi.fn(),
  getClerkToken: vi.fn(),
  queryClient: { invalidateQueries: vi.fn() },
}));

const mockApiFetch = vi.mocked(apiFetch);

vi.mock("@/hooks/use-toast", () => ({
  useToast: () => ({ toast: mockToast }),
}));

let mockIsOwner = true;
vi.mock("@/hooks/use-workspace-role", () => ({
  useWorkspaceRole: () => ({ isOwner: mockIsOwner }),
}));

beforeEach(() => {
  mockIsOwner = true;
  mockInvalidateQueries.mockReset();
  mockToast.mockReset();
  mockProductCountryAvailability = undefined;
  mockProductCityAvailability = undefined;
});

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) => {
      if (opts && typeof opts === "object") {
        return Object.keys(opts).reduce(
          (acc, k) => acc.replace(`{{${k}}}`, String(opts[k])),
          key,
        );
      }
      return key;
    },
  }),
}));

vi.mock("@workspace/api-client-react", () => ({
  useListDeliveryCountries: () => ({ data: undefined, isLoading: false }),
  getListDeliveryCountriesQueryKey: () => ["delivery-countries"],
  useGetProductCountryAvailability: () => ({ data: mockProductCountryAvailability, isLoading: false }),
  getGetProductCountryAvailabilityQueryKey: (id: number) => ["product-country-availability", id],
  useGetProductCityAvailability: () => ({ data: mockProductCityAvailability, isLoading: false }),
  getGetProductCityAvailabilityQueryKey: (id: number) => ["product-city-availability", id],
  useListOccasions: () => ({ data: undefined, isLoading: false }),
  getListOccasionsQueryKey: () => ["occasions"],
  useListCatalogBrands: () => ({ data: undefined, isLoading: false }),
  getListCatalogBrandsQueryKey: () => ["catalog-brands"],
  useBulkUpdateProducts: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useBulkDeleteProducts: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeProduct(overrides: Partial<{
  id: number;
  name: string;
  status: string;
  brand: string | null;
  category: string | null;
  price_usd: string;
  price_aed: string;
}> = {}) {
  return {
    id: 1,
    workspace_owner_id: "owner_123",
    name: "Widget Pro",
    price_usd: "9.99",
    price_aed: "36.70",
    main_image_url: null,
    additional_image_urls: [],
    description: null,
    status: "available",
    brand: "Acme",
    tags: [],
    category: "Gadgets",
    created_at: "2024-01-01T00:00:00Z",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Test setup helpers
// ---------------------------------------------------------------------------

function setupMocks({
  products = [] as ReturnType<typeof makeProduct>[],
  brands = [] as { id: number; name: string }[],
  categories = [] as string[],
} = {}) {
  mockUseMutation.mockReturnValue({ mutate: vi.fn(), isPending: false });
  mockUseQuery.mockImplementation((opts: { queryKey: unknown[] }) => {
    const key = opts.queryKey[0];
    if (key === "products") return { data: { products, total: products.length, page: 1, pageSize: 25, totalPages: 1 }, isLoading: false };
    if (key === "brands") return { data: { brands }, isLoading: false };
    if (key === "product-categories") return { data: { categories }, isLoading: false };
    if (key === "products-summary") return { data: { total: products.length, available_count: 0, hidden_count: 0, missing_info_count: 0, missing_images_count: 0, avg_cogs_pct: null }, isLoading: false };
    return { data: undefined, isLoading: false };
  });
}

function renderPage() {
  return render(<ProductsPage />);
}

// ---------------------------------------------------------------------------
// Tests: Rendering with active filters
// ---------------------------------------------------------------------------

describe("ProductsPage — rendering with URL filters applied", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockApiFetch.mockReset();
    mockSearch = "";
    mockLocation = "/products";
    mockNavigate.mockReset();
  });

  it("renders the product list when products are returned by the query", () => {
    setupMocks({ products: [makeProduct({ name: "Badge Holder" })] });
    renderPage();
    expect(screen.getByText("Badge Holder")).toBeInTheDocument();
  });

  it("shows empty state when no products match the current filters", () => {
    mockSearch = "?q=nonexistent";
    setupMocks({ products: [] });
    renderPage();
    expect(screen.getByText(/no products match your filters/i)).toBeInTheDocument();
  });

  it("shows empty state with 'No products yet' when there are no products and no filters", () => {
    setupMocks({ products: [] });
    renderPage();
    expect(screen.getByText(/no products yet/i)).toBeInTheDocument();
  });

  it("passes the search term from the URL to the products query key", () => {
    mockSearch = "?q=badge";
    setupMocks({ products: [makeProduct({ name: "Badge Holder" })] });
    renderPage();

    const productsQueryCalls = mockUseQuery.mock.calls.filter(
      (call) => call[0].queryKey[0] === "products",
    );
    expect(productsQueryCalls.length).toBeGreaterThan(0);
    const queryKey = productsQueryCalls[0][0].queryKey;
    expect(queryKey).toContain("badge");
  });

  it("passes the status filter from the URL to the products query key", () => {
    mockSearch = "?status=available";
    setupMocks({ products: [makeProduct({ status: "available" })] });
    renderPage();

    const productsQueryCalls = mockUseQuery.mock.calls.filter(
      (call) => call[0].queryKey[0] === "products",
    );
    const queryKey = productsQueryCalls[0][0].queryKey;
    expect(queryKey).toContainEqual(["available"]);
  });

  it("passes the brand filter from the URL to the products query key", () => {
    mockSearch = "?brand=Acme";
    setupMocks({ products: [makeProduct({ brand: "Acme" })] });
    renderPage();

    const productsQueryCalls = mockUseQuery.mock.calls.filter(
      (call) => call[0].queryKey[0] === "products",
    );
    const queryKey = productsQueryCalls[0][0].queryKey;
    expect(queryKey).toContainEqual(["Acme"]);
  });

  it("passes the category filter from the URL to the products query key", () => {
    mockSearch = "?category=Packaging";
    setupMocks({ products: [makeProduct({ category: "Packaging" })] });
    renderPage();

    const productsQueryCalls = mockUseQuery.mock.calls.filter(
      (call) => call[0].queryKey[0] === "products",
    );
    const queryKey = productsQueryCalls[0][0].queryKey;
    expect(queryKey).toContainEqual(["Packaging"]);
  });

  it("shows products matching the active search filter", () => {
    mockSearch = "?q=badge";
    setupMocks({ products: [makeProduct({ name: "Badge Holder" })] });
    renderPage();
    expect(screen.getByText("Badge Holder")).toBeInTheDocument();
  });

  it("shows only the filtered results — other products are not rendered", () => {
    mockSearch = "?brand=Acme";
    setupMocks({ products: [makeProduct({ name: "Acme Widget", brand: "Acme" })] });
    renderPage();
    expect(screen.getByText("Acme Widget")).toBeInTheDocument();
  });
});

describe("ProductsPage — Merchant Reconciliation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockApiFetch.mockReset();
    mockSearch = "";
    mockLocation = "/products";
    mockNavigate.mockReset();
    setupMocks({ products: [makeProduct()] });

    mockUseMutation.mockImplementation((opts) => ({
      isPending: false,
      mutate: (vars: unknown) => {
        if (opts.mutationFn) {
          opts.mutationFn(vars).then((res: unknown) => opts.onSuccess?.(res, vars)).catch(() => {});
        }
      }
    }));
  });

  it("shows Merchant Reconciliation button to owners only", async () => {
    mockIsOwner = true;
    renderPage();
    expect(screen.getByTestId("btn-open-reconciliation")).toBeInTheDocument();
  });

  it("does not show Merchant Reconciliation button to non-owners", async () => {
    mockIsOwner = false;
    renderPage();
    expect(screen.queryByTestId("btn-open-reconciliation")).not.toBeInTheDocument();
  });

  it("sends correct dry-run payload", async () => {
    mockIsOwner = true;

    mockUseQuery.mockImplementation((opts) => {
      const key = opts.queryKey[0];
      if (key === "merchant-reconciliation-latest") return { data: { runs: {} }, isLoading: false };
      if (key === "merchant-reconciliation-run") return { data: null, isLoading: false };
      return { data: undefined, isLoading: false };
    });

    mockApiFetch.mockImplementation(async (url) => {
      if (url === "/api/products/merchant-reconciliation/dry-run") return { results: [{ country: "AE", ok: true, runId: 10, summary: {}, blocked: null }] };
      return {};
    });

    const user = userEvent.setup();
    renderPage();
    await user.click(screen.getByTestId("btn-open-reconciliation"));

    const dryRunBtn = await screen.findByTestId("btn-run-dry-run");
    await user.click(dryRunBtn);

    await waitFor(() => {
      const call = mockApiFetch.mock.calls.find(c => c[0] === "/api/products/merchant-reconciliation/dry-run");
      if (!call) throw new Error("expected a request to /api/products/merchant-reconciliation/dry-run");
      expect(JSON.parse(String(call[1]?.body))).toEqual({ countries: ["LB"], contentLanguage: "en", includeGoogle: true });
    });
  });

  it("disables approve and apply when run is blocked", async () => {
    mockIsOwner = true;
    mockUseQuery.mockImplementation((opts) => {
      const key = opts.queryKey[0];
      if (key === "merchant-reconciliation-latest") return { data: { run: { id: 1, status: "BLOCKED", summary: { blockedReason: "Missing configs" } } }, isLoading: false };
      if (key === "merchant-reconciliation-run") return { data: { run: { id: 1, status: "BLOCKED", summary: { blockedReason: "Missing configs" } }, items: [] }, isLoading: false };
      return { data: undefined, isLoading: false };
    });

    const user = userEvent.setup();
    renderPage();
    await user.click(screen.getByTestId("btn-open-reconciliation"));

    expect(await screen.findByTestId("run-blocked-alert")).toBeInTheDocument();
    expect(screen.getByTestId("btn-approve-run")).toBeDisabled();
    expect(screen.getByTestId("btn-apply-run")).toBeDisabled();
  });

  it("shows last-offer confirmation before approving deletions if risk exists", async () => {
    mockIsOwner = true;
    mockUseQuery.mockImplementation((opts) => {
      const key = opts.queryKey[0];
      if (key === "merchant-reconciliation-latest") return { data: { run: { id: 2, status: "DRAFT", summary: { DELETE: 1 } } }, isLoading: false };
      if (key === "merchant-reconciliation-run") return { data: { run: { id: 2, status: "DRAFT", summary: { DELETE: 1 } }, items: [{ id: 100, product_id: 5, action: "DELETE", reason: "No local product", state_identity: { isLastOffer: true }, delete_approved: false }] }, isLoading: false };
      return { data: undefined, isLoading: false };
    });

    mockApiFetch.mockImplementation(async (url) => {
      if (url === "/api/products/merchant-reconciliation/2/approve-deletions") return { approved: 1 };
      return {};
    });

    const user = userEvent.setup();
    renderPage();
    await user.click(screen.getByTestId("btn-open-reconciliation"));

    await user.click(await screen.findByTestId("filter-DELETE"));
    await user.click(await screen.findByTestId("select-item-100"));
    await user.click(await screen.findByTestId("btn-approve-deletions"));

    const confirmBtn = await screen.findByTestId("btn-confirm-last-offer");
    expect(confirmBtn).toBeInTheDocument();
    await user.click(confirmBtn);

    await waitFor(() => {
      const call = mockApiFetch.mock.calls.find(c => c[0] === "/api/products/merchant-reconciliation/2/approve-deletions");
      if (!call) throw new Error("expected a request to /api/products/merchant-reconciliation/2/approve-deletions");
      expect(JSON.parse(String(call[1]?.body))).toEqual({ itemIds: [100], approveLastOffer: true });
    });
  });
});

describe("ProductsPage — Clear button resets all filters and updates the URL", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSearch = "";
    mockLocation = "/products";
    mockNavigate.mockReset();
  });

  it("does not show the Clear button when no filters are active", () => {
    setupMocks({ products: [makeProduct()] });
    renderPage();
    expect(screen.queryByText(/clear/i)).not.toBeInTheDocument();
  });

  it("shows the Clear button when the search term is active", () => {
    mockSearch = "?q=badge";
    setupMocks({ products: [] });
    renderPage();
    expect(screen.getAllByRole("button", { name: /clear/i }).length).toBeGreaterThan(0);
  });

  it("shows the Clear button when a status filter is active", () => {
    mockSearch = "?status=available";
    setupMocks({ products: [] });
    renderPage();
    expect(screen.getAllByRole("button", { name: /clear/i }).length).toBeGreaterThan(0);
  });

  it("shows the Clear button when a brand filter is active", () => {
    mockSearch = "?brand=Acme";
    setupMocks({ products: [] });
    renderPage();
    expect(screen.getAllByRole("button", { name: /clear/i }).length).toBeGreaterThan(0);
  });

  it("shows the Clear button when a category filter is active", () => {
    mockSearch = "?category=Packaging";
    setupMocks({ products: [] });
    renderPage();
    expect(screen.getAllByRole("button", { name: /clear/i }).length).toBeGreaterThan(0);
  });

  it("calls navigate with the bare path (no query params) when Clear is clicked", () => {
    mockSearch = "?q=badge&status=available";
    mockLocation = "/products?q=badge&status=available";
    setupMocks({ products: [] });
    renderPage();

    const clearButtons = screen.getAllByRole("button", { name: /clear/i });
    fireEvent.click(clearButtons[0]);

    expect(mockNavigate).toHaveBeenCalledWith(
      "/products",
      expect.objectContaining({ replace: true }),
    );
  });

  it("navigate is called exactly once when Clear is clicked", () => {
    mockSearch = "?q=badge";
    mockLocation = "/products?q=badge";
    setupMocks({ products: [makeProduct({ name: "Any Product" })] });
    renderPage();

    const clearButton = screen.getByRole("button", { name: /^clear$/i });
    fireEvent.click(clearButton);

    const clearCalls = mockNavigate.mock.calls.filter(
      ([url]) => !url.includes("?"),
    );
    expect(clearCalls).toHaveLength(1);
  });

  it("also shows a 'Clear filters' button in the empty state when filters are active", () => {
    mockSearch = "?q=zzznotfound";
    setupMocks({ products: [] });
    renderPage();

    const clearButtons = screen.getAllByRole("button", { name: /clear/i });
    expect(clearButtons.length).toBeGreaterThanOrEqual(1);
  });
});

// ---------------------------------------------------------------------------
// Tests: Search input debounce → URL update
// ---------------------------------------------------------------------------

describe("ProductsPage — search input debounces and updates the URL", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    mockSearch = "";
    mockLocation = "/products";
    mockNavigate.mockReset();
    setupMocks({ products: [] });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("does not call navigate immediately after typing (debounce not yet fired)", () => {
    renderPage();
    const searchInput = screen.getByPlaceholderText(/search products/i);

    fireEvent.change(searchInput, { target: { value: "badge" } });

    const navCallsWithQuery = mockNavigate.mock.calls.filter(([url]) => url.includes("badge"));
    expect(navCallsWithQuery).toHaveLength(0);
  });

  it("calls navigate with ?q= after the 300ms debounce", async () => {
    renderPage();
    const searchInput = screen.getByPlaceholderText(/search products/i);

    await act(async () => {
      fireEvent.change(searchInput, { target: { value: "badge" } });
      vi.advanceTimersByTime(SEARCH_DEBOUNCE_MS);
    });

    const callsWithBadge = mockNavigate.mock.calls.filter(([url]) => url.includes("badge"));
    expect(callsWithBadge.length).toBeGreaterThan(0);
  });

  it("includes the search term in the navigate URL as the q param", async () => {
    renderPage();
    const searchInput = screen.getByPlaceholderText(/search products/i);

    await act(async () => {
      fireEvent.change(searchInput, { target: { value: "widget" } });
      vi.advanceTimersByTime(SEARCH_DEBOUNCE_MS);
    });

    const matchingCall = mockNavigate.mock.calls.find(([url]) => url.includes("q=widget"));
    expect(matchingCall).toBeDefined();
    expect(matchingCall![0]).toContain("q=widget");
  });

  it("passes replace:true to navigate so the search does not add browser history entries", async () => {
    renderPage();
    const searchInput = screen.getByPlaceholderText(/search products/i);

    await act(async () => {
      fireEvent.change(searchInput, { target: { value: "pen" } });
      vi.advanceTimersByTime(SEARCH_DEBOUNCE_MS);
    });

    const callWithPen = mockNavigate.mock.calls.find(([url]) => url.includes("pen"));
    expect(callWithPen).toBeDefined();
    expect(callWithPen![1]).toEqual(expect.objectContaining({ replace: true }));
  });

  it("preserves other active filters when updating the search term", async () => {
    mockSearch = "?status=available";
    setupMocks({ products: [] });
    renderPage();

    const searchInput = screen.getByPlaceholderText(/search products/i);

    await act(async () => {
      fireEvent.change(searchInput, { target: { value: "badge" } });
      vi.advanceTimersByTime(SEARCH_DEBOUNCE_MS);
    });

    const call = mockNavigate.mock.calls.find(([url]) => url.includes("badge"));
    expect(call).toBeDefined();
    expect(call![0]).toContain("status=available");
    expect(call![0]).toContain("q=badge");
  });

  it("navigates to the bare path when the search input is cleared", async () => {
    mockSearch = "?q=badge";
    setupMocks({ products: [] });
    renderPage();

    const searchInput = screen.getByPlaceholderText(/search products/i);

    await act(async () => {
      fireEvent.change(searchInput, { target: { value: "" } });
      vi.advanceTimersByTime(SEARCH_DEBOUNCE_MS);
    });

    const barePathCall = mockNavigate.mock.calls.find(([url]) => !url.includes("?"));
    expect(barePathCall).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Tests: Popover filter selections update the URL
// ---------------------------------------------------------------------------

describe("ProductsPage — popover filter selections update the URL", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSearch = "";
    mockLocation = "/products";
    mockNavigate.mockReset();
    setupMocks({
      products: [makeProduct()],
      brands: [{ id: 1, name: "Acme" }],
      categories: ["Gadgets"],
    });
  });

  it("selecting a status value calls navigate with ?status= in the URL", async () => {
    const user = userEvent.setup();
    renderPage();

    const statusTrigger = screen.getByRole("button", { name: /all statuses/i });
    await user.click(statusTrigger);

    const availableOption = await screen.findByRole("option", { name: "Available" });
    await user.click(availableOption);

    const navCall = mockNavigate.mock.calls.find(([url]) =>
      typeof url === "string" && url.includes("status=available"),
    );
    expect(navCall).toBeDefined();
    expect(navCall![1]).toEqual(expect.objectContaining({ replace: true }));
  });

  it("selecting a brand value calls navigate with ?brand= in the URL", async () => {
    const user = userEvent.setup();
    renderPage();

    const brandTrigger = screen.getByRole("button", { name: /all brands/i });
    await user.click(brandTrigger);

    const brandOption = await screen.findByRole("option", { name: "Acme" });
    await user.click(brandOption);

    const navCall = mockNavigate.mock.calls.find(([url]) =>
      typeof url === "string" && url.includes("brand=Acme"),
    );
    expect(navCall).toBeDefined();
    expect(navCall![1]).toEqual(expect.objectContaining({ replace: true }));
  });

  it("selecting a category value calls navigate with ?category= in the URL", async () => {
    const user = userEvent.setup();
    renderPage();

    const categoryTrigger = screen.getByRole("button", { name: /all categories/i });
    await user.click(categoryTrigger);

    const categoryOption = await screen.findByRole("option", { name: "Gadgets" });
    await user.click(categoryOption);

    const navCall = mockNavigate.mock.calls.find(([url]) =>
      typeof url === "string" && url.includes("category=Gadgets"),
    );
    expect(navCall).toBeDefined();
    expect(navCall![1]).toEqual(expect.objectContaining({ replace: true }));
  });

  it("deselecting an active status removes it from the URL", async () => {
    mockSearch = "?status=available";
    mockLocation = "/products?status=available";
    setupMocks({ products: [], brands: [], categories: [] });
    const user = userEvent.setup();
    renderPage();

    const statusTrigger = screen.getByRole("button", { name: "Available" });
    await user.click(statusTrigger);

    const availableOption = await screen.findByRole("option", { name: "Available" });
    await user.click(availableOption);

    const navCall = mockNavigate.mock.calls.find(([url]) =>
      typeof url === "string" && !url.includes("status=available"),
    );
    expect(navCall).toBeDefined();
  });

  it("selecting a second brand adds it to the URL alongside the first", async () => {
    mockSearch = "?brand=Acme";
    mockLocation = "/products?brand=Acme";
    setupMocks({
      products: [makeProduct({ brand: "Acme" }), makeProduct({ id: 2, name: "Nike Bag", brand: "Nike" })],
      brands: [{ id: 1, name: "Acme" }, { id: 2, name: "Nike" }],
      categories: [],
    });
    const user = userEvent.setup();
    renderPage();

    const brandBtn = screen.getByRole("button", { name: /acme/i });
    await user.click(brandBtn);

    const nikeOption = await screen.findByRole("option", { name: "Nike" });
    await user.click(nikeOption);

    const navCall = mockNavigate.mock.calls.find(([url]) =>
      typeof url === "string" && url.includes("brand=Acme") && url.includes("brand=Nike"),
    );
    expect(navCall).toBeDefined();
    expect(navCall![1]).toEqual(expect.objectContaining({ replace: true }));
  });

  it("selecting a second category adds it to the URL alongside the first", async () => {
    mockSearch = "?category=Gadgets";
    mockLocation = "/products?category=Gadgets";
    setupMocks({
      products: [makeProduct(), makeProduct({ id: 2, name: "Paper Bag", category: "Bags" })],
      brands: [],
      categories: ["Gadgets", "Bags"],
    });
    const user = userEvent.setup();
    renderPage();

    const categoryBtn = screen.getByRole("button", { name: /gadgets/i });
    await user.click(categoryBtn);

    const bagsOption = await screen.findByRole("option", { name: "Bags" });
    await user.click(bagsOption);

    const navCall = mockNavigate.mock.calls.find(([url]) =>
      typeof url === "string" && url.includes("category=Gadgets") && url.includes("category=Bags"),
    );
    expect(navCall).toBeDefined();
    expect(navCall![1]).toEqual(expect.objectContaining({ replace: true }));
  });

  it("deselecting one brand from a multi-brand selection removes only that brand from the URL", async () => {
    mockSearch = "?brand=Acme&brand=Nike";
    mockLocation = "/products?brand=Acme&brand=Nike";
    setupMocks({
      products: [],
      brands: [{ id: 1, name: "Acme" }, { id: 2, name: "Nike" }],
      categories: [],
    });
    const user = userEvent.setup();
    renderPage();

    const brandBtn = screen.getByRole("button", { name: /2 brands/i });
    await user.click(brandBtn);

    const acmeOption = await screen.findByRole("option", { name: "Acme" });
    await user.click(acmeOption);

    const navCall = mockNavigate.mock.calls.find(([url]) =>
      typeof url === "string" && url.includes("brand=Nike") && !url.includes("brand=Acme"),
    );
    expect(navCall).toBeDefined();
  });

  it("deselecting one category from a multi-category selection removes only that category from the URL", async () => {
    mockSearch = "?category=Gadgets&category=Bags";
    mockLocation = "/products?category=Gadgets&category=Bags";
    setupMocks({
      products: [],
      brands: [],
      categories: ["Gadgets", "Bags"],
    });
    const user = userEvent.setup();
    renderPage();

    const categoryBtn = screen.getByRole("button", { name: /2 categories/i });
    await user.click(categoryBtn);

    const gadgetsOption = await screen.findByRole("option", { name: "Gadgets" });
    await user.click(gadgetsOption);

    const navCall = mockNavigate.mock.calls.find(([url]) =>
      typeof url === "string" && url.includes("category=Bags") && !url.includes("category=Gadgets"),
    );
    expect(navCall).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Tests: Multi-select filter label display
// ---------------------------------------------------------------------------

describe("ProductsPage — multi-select filter button label", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSearch = "";
    mockLocation = "/products";
    mockNavigate.mockReset();
  });

  it("shows 'All brands' when no brand filter is active", () => {
    setupMocks({ products: [], brands: [{ id: 1, name: "Acme" }], categories: [] });
    renderPage();
    expect(screen.getByRole("button", { name: /all brands/i })).toBeInTheDocument();
  });

  it("shows the brand name when exactly one brand is selected", () => {
    mockSearch = "?brand=Acme";
    setupMocks({ products: [], brands: [{ id: 1, name: "Acme" }, { id: 2, name: "Nike" }], categories: [] });
    renderPage();
    expect(screen.getByRole("button", { name: /^acme$/i })).toBeInTheDocument();
  });

  it("shows '2 brands' when two brands are selected", () => {
    mockSearch = "?brand=Acme&brand=Nike";
    setupMocks({ products: [], brands: [{ id: 1, name: "Acme" }, { id: 2, name: "Nike" }], categories: [] });
    renderPage();
    expect(screen.getByRole("button", { name: /2 brands/i })).toBeInTheDocument();
  });

  it("shows 'All categories' when no category filter is active", () => {
    setupMocks({ products: [], brands: [], categories: ["Gadgets", "Bags"] });
    renderPage();
    expect(screen.getByRole("button", { name: /all categories/i })).toBeInTheDocument();
  });

  it("shows the category name when exactly one category is selected", () => {
    mockSearch = "?category=Gadgets";
    setupMocks({ products: [], brands: [], categories: ["Gadgets", "Bags"] });
    renderPage();
    expect(screen.getByRole("button", { name: /^gadgets$/i })).toBeInTheDocument();
  });

  it("shows '2 categories' when two categories are selected", () => {
    mockSearch = "?category=Gadgets&category=Bags";
    setupMocks({ products: [], brands: [], categories: ["Gadgets", "Bags"] });
    renderPage();
    expect(screen.getByRole("button", { name: /2 categories/i })).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// Tests: Multi-select filters affect the products query key
// ---------------------------------------------------------------------------

describe("ProductsPage — multi-select filters passed to products query key", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSearch = "";
    mockLocation = "/products";
    mockNavigate.mockReset();
  });

  it("passes both selected brands to the products query key", () => {
    mockSearch = "?brand=Acme&brand=Nike";
    setupMocks({
      products: [
        makeProduct({ brand: "Acme" }),
        makeProduct({ id: 2, name: "Nike Bag", brand: "Nike" }),
      ],
    });
    renderPage();

    const productsQueryCalls = mockUseQuery.mock.calls.filter(
      (call) => call[0].queryKey[0] === "products",
    );
    expect(productsQueryCalls.length).toBeGreaterThan(0);
    const queryKey = productsQueryCalls[0][0].queryKey;
    expect(queryKey).toContainEqual(["Acme", "Nike"]);
  });

  it("passes both selected categories to the products query key", () => {
    mockSearch = "?category=Gadgets&category=Bags";
    setupMocks({
      products: [
        makeProduct({ category: "Gadgets" }),
        makeProduct({ id: 2, name: "Tote", category: "Bags" }),
      ],
    });
    renderPage();

    const productsQueryCalls = mockUseQuery.mock.calls.filter(
      (call) => call[0].queryKey[0] === "products",
    );
    expect(productsQueryCalls.length).toBeGreaterThan(0);
    const queryKey = productsQueryCalls[0][0].queryKey;
    expect(queryKey).toContainEqual(["Gadgets", "Bags"]);
  });

  it("renders all products returned when multiple brands are selected", () => {
    mockSearch = "?brand=Acme&brand=Nike";
    setupMocks({
      products: [
        makeProduct({ name: "Acme Widget", brand: "Acme" }),
        makeProduct({ id: 2, name: "Nike Runner", brand: "Nike" }),
      ],
    });
    renderPage();
    expect(screen.getByText("Acme Widget")).toBeInTheDocument();
    expect(screen.getByText("Nike Runner")).toBeInTheDocument();
  });

  it("renders all products returned when multiple categories are selected", () => {
    mockSearch = "?category=Gadgets&category=Bags";
    setupMocks({
      products: [
        makeProduct({ name: "Gadget Pro", category: "Gadgets" }),
        makeProduct({ id: 2, name: "Tote Bag", category: "Bags" }),
      ],
    });
    renderPage();
    expect(screen.getByText("Gadget Pro")).toBeInTheDocument();
    expect(screen.getByText("Tote Bag")).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// Tests: Clear button resets multi-select brand and category filters
// ---------------------------------------------------------------------------

describe("ProductsPage — Clear button resets multi-select brand and category filters", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSearch = "";
    mockLocation = "/products";
    mockNavigate.mockReset();
  });

  it("shows the Clear button when multiple brands are active", () => {
    mockSearch = "?brand=Acme&brand=Nike";
    setupMocks({ products: [] });
    renderPage();
    expect(screen.getAllByRole("button", { name: /clear/i }).length).toBeGreaterThan(0);
  });

  it("shows the Clear button when multiple categories are active", () => {
    mockSearch = "?category=Gadgets&category=Bags";
    setupMocks({ products: [] });
    renderPage();
    expect(screen.getAllByRole("button", { name: /clear/i }).length).toBeGreaterThan(0);
  });

  it("clicking Clear when multiple brands are active navigates to the bare path", () => {
    mockSearch = "?brand=Acme&brand=Nike";
    mockLocation = "/products?brand=Acme&brand=Nike";
    setupMocks({ products: [] });
    renderPage();

    const clearButton = screen.getAllByRole("button", { name: /clear/i })[0];
    fireEvent.click(clearButton);

    expect(mockNavigate).toHaveBeenCalledWith(
      "/products",
      expect.objectContaining({ replace: true }),
    );
  });

  it("clicking Clear when multiple categories are active navigates to the bare path", () => {
    mockSearch = "?category=Gadgets&category=Bags";
    mockLocation = "/products?category=Gadgets&category=Bags";
    setupMocks({ products: [] });
    renderPage();

    const clearButton = screen.getAllByRole("button", { name: /clear/i })[0];
    fireEvent.click(clearButton);

    expect(mockNavigate).toHaveBeenCalledWith(
      "/products",
      expect.objectContaining({ replace: true }),
    );
  });

  it("clicking Clear when both multi-brand and multi-category filters are active navigates to the bare path", () => {
    mockSearch = "?brand=Acme&brand=Nike&category=Gadgets&category=Bags";
    mockLocation = "/products?brand=Acme&brand=Nike&category=Gadgets&category=Bags";
    setupMocks({ products: [] });
    renderPage();

    const clearButton = screen.getAllByRole("button", { name: /clear/i })[0];
    fireEvent.click(clearButton);

    expect(mockNavigate).toHaveBeenCalledWith(
      "/products",
      expect.objectContaining({ replace: true }),
    );
  });
});

// ---------------------------------------------------------------------------
// Tests: sessionStorage filter persistence — full navigation roundtrip
// ---------------------------------------------------------------------------

const PRODUCTS_FILTER_KEY = "products_filter_state";

describe("ProductsPage — filter persistence across a navigation roundtrip", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sessionStorage.clear();
    mockSearch = "";
    mockLocation = "/products";
    mockNavigate.mockReset();
  });

  it("saves Status + Brand + Category to sessionStorage, then restores them into the URL after navigating away and returning", () => {
    // ── Step 1: land on Products with active filters ────────────────────────
    mockSearch = "?status=available&brand=Acme&category=Gadgets";
    mockLocation = "/products?status=available&brand=Acme&category=Gadgets";
    setupMocks({ products: [] });
    const { unmount } = renderPage();

    // Verify all filter dimensions were persisted to sessionStorage
    const savedOnPage = JSON.parse(sessionStorage.getItem(PRODUCTS_FILTER_KEY) ?? "null");
    expect(savedOnPage).not.toBeNull();
    expect(savedOnPage.status).toContain("available");
    expect(savedOnPage.brand).toContain("Acme");
    expect(savedOnPage.category).toContain("Gadgets");

    // ── Step 2: navigate away — unmount simulates leaving the page ──────────
    unmount();

    // sessionStorage survives the unmount (it persists for the browser session)
    const savedAfterLeave = JSON.parse(sessionStorage.getItem(PRODUCTS_FILTER_KEY) ?? "null");
    expect(savedAfterLeave.status).toContain("available");
    expect(savedAfterLeave.brand).toContain("Acme");
    expect(savedAfterLeave.category).toContain("Gadgets");

    // ── Step 3: return to Products with a clean URL ─────────────────────────
    mockSearch = "";
    mockLocation = "/products";
    mockNavigate.mockReset();
    setupMocks({ products: [] });
    renderPage();

    // Restore effect must have called navigate with all saved filter dimensions
    const restoredCall = mockNavigate.mock.calls.find(([url]) =>
      typeof url === "string" &&
      url.includes("status=available") &&
      url.includes("brand=Acme") &&
      url.includes("category=Gadgets"),
    );
    expect(restoredCall).toBeDefined();
    expect(restoredCall![1]).toEqual(expect.objectContaining({ replace: true }));
  });

  it("does not restore stale sessionStorage after navigating to Products with fresh URL params", () => {
    // ── Step 1: land on Products with one set of filters ────────────────────
    mockSearch = "?status=out_of_stock&brand=OldBrand";
    mockLocation = "/products?status=out_of_stock&brand=OldBrand";
    setupMocks({ products: [] });
    const { unmount } = renderPage();

    // Confirm stale state is in sessionStorage
    const stale = JSON.parse(sessionStorage.getItem(PRODUCTS_FILTER_KEY) ?? "null");
    expect(stale.status).toContain("out_of_stock");

    // ── Step 2: navigate away ───────────────────────────────────────────────
    unmount();

    // ── Step 3: return with a different, explicit URL filter ────────────────
    mockSearch = "?brand=NewBrand";
    mockLocation = "/products?brand=NewBrand";
    mockNavigate.mockReset();
    setupMocks({ products: [] });
    renderPage();

    // Restore effect must NOT overwrite the incoming URL with stale sessionStorage
    const staleNavCalls = mockNavigate.mock.calls.filter(([url]) =>
      typeof url === "string" && (url.includes("out_of_stock") || url.includes("OldBrand")),
    );
    expect(staleNavCalls).toHaveLength(0);

    // The incoming URL param must have been saved to sessionStorage instead
    const updated = JSON.parse(sessionStorage.getItem(PRODUCTS_FILTER_KEY) ?? "null");
    expect(updated.brand).toContain("NewBrand");
    expect(updated.status).not.toContain("out_of_stock");
  });
});

// ---------------------------------------------------------------------------
// Tests: sessionStorage filter persistence — save and restore
// ---------------------------------------------------------------------------

describe("ProductsPage — sessionStorage filter save behaviour", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sessionStorage.clear();
    mockSearch = "";
    mockLocation = "/products";
    mockNavigate.mockReset();
  });

  it("saves the active status filter to sessionStorage on render", () => {
    mockSearch = "?status=available";
    setupMocks({ products: [] });
    renderPage();

    const saved = JSON.parse(sessionStorage.getItem(PRODUCTS_FILTER_KEY) ?? "null");
    expect(saved).not.toBeNull();
    expect(saved.status).toContain("available");
  });

  it("saves the active brand filter to sessionStorage on render", () => {
    mockSearch = "?brand=Acme";
    setupMocks({ products: [] });
    renderPage();

    const saved = JSON.parse(sessionStorage.getItem(PRODUCTS_FILTER_KEY) ?? "null");
    expect(saved).not.toBeNull();
    expect(saved.brand).toContain("Acme");
  });

  it("saves the active category filter to sessionStorage on render", () => {
    mockSearch = "?category=Gadgets";
    setupMocks({ products: [] });
    renderPage();

    const saved = JSON.parse(sessionStorage.getItem(PRODUCTS_FILTER_KEY) ?? "null");
    expect(saved).not.toBeNull();
    expect(saved.category).toContain("Gadgets");
  });

  it("saves multiple brands to sessionStorage", () => {
    mockSearch = "?brand=Acme&brand=Nike";
    setupMocks({ products: [] });
    renderPage();

    const saved = JSON.parse(sessionStorage.getItem(PRODUCTS_FILTER_KEY) ?? "null");
    expect(saved.brand).toEqual(expect.arrayContaining(["Acme", "Nike"]));
    expect(saved.brand).toHaveLength(2);
  });

  it("saves multiple categories to sessionStorage", () => {
    mockSearch = "?category=Gadgets&category=Bags";
    setupMocks({ products: [] });
    renderPage();

    const saved = JSON.parse(sessionStorage.getItem(PRODUCTS_FILTER_KEY) ?? "null");
    expect(saved.category).toEqual(expect.arrayContaining(["Gadgets", "Bags"]));
    expect(saved.category).toHaveLength(2);
  });

  it("saves a combined Status + Brand + Category filter state to sessionStorage", () => {
    mockSearch = "?status=out_of_stock&brand=Acme&category=Gadgets";
    setupMocks({ products: [] });
    renderPage();

    const saved = JSON.parse(sessionStorage.getItem(PRODUCTS_FILTER_KEY) ?? "null");
    expect(saved.status).toContain("out_of_stock");
    expect(saved.brand).toContain("Acme");
    expect(saved.category).toContain("Gadgets");
  });

  it("removes the sessionStorage key when no filters are active", () => {
    setupMocks({ products: [] });
    renderPage();

    expect(sessionStorage.getItem(PRODUCTS_FILTER_KEY)).toBeNull();
  });
});

describe("ProductsPage — sessionStorage filter restore behaviour", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sessionStorage.clear();
    mockSearch = "";
    mockLocation = "/products";
    mockNavigate.mockReset();
  });

  it("does not call navigate when sessionStorage is empty and URL has no params", () => {
    setupMocks({ products: [] });
    renderPage();

    const filterNavCalls = mockNavigate.mock.calls.filter(([url]) =>
      typeof url === "string" && url.includes("?"),
    );
    expect(filterNavCalls).toHaveLength(0);
  });

  it("calls navigate with the saved status filter when URL has no params", () => {
    sessionStorage.setItem(
      PRODUCTS_FILTER_KEY,
      JSON.stringify({ q: "", status: ["available"], brand: [], category: [] }),
    );
    setupMocks({ products: [] });
    renderPage();

    const restoredCall = mockNavigate.mock.calls.find(([url]) =>
      typeof url === "string" && url.includes("status=available"),
    );
    expect(restoredCall).toBeDefined();
    expect(restoredCall![1]).toEqual(expect.objectContaining({ replace: true }));
  });

  it("calls navigate with the saved brand filter when URL has no params", () => {
    sessionStorage.setItem(
      PRODUCTS_FILTER_KEY,
      JSON.stringify({ q: "", status: [], brand: ["Acme"], category: [] }),
    );
    setupMocks({ products: [] });
    renderPage();

    const restoredCall = mockNavigate.mock.calls.find(([url]) =>
      typeof url === "string" && url.includes("brand=Acme"),
    );
    expect(restoredCall).toBeDefined();
    expect(restoredCall![1]).toEqual(expect.objectContaining({ replace: true }));
  });

  it("calls navigate with the saved category filter when URL has no params", () => {
    sessionStorage.setItem(
      PRODUCTS_FILTER_KEY,
      JSON.stringify({ q: "", status: [], brand: [], category: ["Gadgets"] }),
    );
    setupMocks({ products: [] });
    renderPage();

    const restoredCall = mockNavigate.mock.calls.find(([url]) =>
      typeof url === "string" && url.includes("category=Gadgets"),
    );
    expect(restoredCall).toBeDefined();
    expect(restoredCall![1]).toEqual(expect.objectContaining({ replace: true }));
  });

  it("restores all saved filter dimensions together in a single navigate call", () => {
    sessionStorage.setItem(
      PRODUCTS_FILTER_KEY,
      JSON.stringify({ q: "", status: ["out_of_stock"], brand: ["Acme"], category: ["Gadgets"] }),
    );
    setupMocks({ products: [] });
    renderPage();

    const restoredCall = mockNavigate.mock.calls.find(([url]) =>
      typeof url === "string" &&
      url.includes("status=out_of_stock") &&
      url.includes("brand=Acme") &&
      url.includes("category=Gadgets"),
    );
    expect(restoredCall).toBeDefined();
    expect(restoredCall![1]).toEqual(expect.objectContaining({ replace: true }));
  });

  it("does not navigate when saved state has only empty arrays and empty q", () => {
    sessionStorage.setItem(
      PRODUCTS_FILTER_KEY,
      JSON.stringify({ q: "", status: [], brand: [], category: [] }),
    );
    setupMocks({ products: [] });
    renderPage();

    const filterNavCalls = mockNavigate.mock.calls.filter(([url]) =>
      typeof url === "string" && url.includes("?"),
    );
    expect(filterNavCalls).toHaveLength(0);
  });
});

describe("ProductsPage — URL params take priority over sessionStorage on arrival", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sessionStorage.clear();
    mockSearch = "";
    mockLocation = "/products";
    mockNavigate.mockReset();
  });

  it("does not navigate to saved sessionStorage params when URL already has a status param", () => {
    sessionStorage.setItem(
      PRODUCTS_FILTER_KEY,
      JSON.stringify({ q: "", status: ["out_of_stock"], brand: ["OldBrand"], category: [] }),
    );
    mockSearch = "?status=available";
    mockLocation = "/products?status=available";
    setupMocks({ products: [] });
    renderPage();

    const sessionNavCalls = mockNavigate.mock.calls.filter(([url]) =>
      typeof url === "string" && (url.includes("out_of_stock") || url.includes("OldBrand")),
    );
    expect(sessionNavCalls).toHaveLength(0);
  });

  it("does not navigate to saved sessionStorage params when URL already has a brand param", () => {
    sessionStorage.setItem(
      PRODUCTS_FILTER_KEY,
      JSON.stringify({ q: "", status: [], brand: ["StoredBrand"], category: [] }),
    );
    mockSearch = "?brand=LiveBrand";
    mockLocation = "/products?brand=LiveBrand";
    setupMocks({ products: [] });
    renderPage();

    const sessionNavCalls = mockNavigate.mock.calls.filter(([url]) =>
      typeof url === "string" && url.includes("StoredBrand"),
    );
    expect(sessionNavCalls).toHaveLength(0);
  });

  it("does not navigate to saved sessionStorage params when URL already has a category param", () => {
    sessionStorage.setItem(
      PRODUCTS_FILTER_KEY,
      JSON.stringify({ q: "", status: [], brand: [], category: ["StoredCat"] }),
    );
    mockSearch = "?category=LiveCat";
    mockLocation = "/products?category=LiveCat";
    setupMocks({ products: [] });
    renderPage();

    const sessionNavCalls = mockNavigate.mock.calls.filter(([url]) =>
      typeof url === "string" && url.includes("StoredCat"),
    );
    expect(sessionNavCalls).toHaveLength(0);
  });

  it("preserves the URL params and saves them to sessionStorage when URL already has params", () => {
    sessionStorage.setItem(
      PRODUCTS_FILTER_KEY,
      JSON.stringify({ q: "", status: ["out_of_stock"], brand: [], category: [] }),
    );
    mockSearch = "?status=available";
    setupMocks({ products: [] });
    renderPage();

    const saved = JSON.parse(sessionStorage.getItem(PRODUCTS_FILTER_KEY) ?? "null");
    expect(saved.status).toContain("available");
    expect(saved.status).not.toContain("out_of_stock");
  });
});

// ---------------------------------------------------------------------------
// Component integration test: name duplicate warning in the create-product form
// ---------------------------------------------------------------------------

describe("ProductsPage – name duplicate warning in create form", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSearch = "";
    mockLocation = "/products";
    mockNavigate.mockReset();
    setupMocks({
      products: [makeProduct({ id: 1, name: "Widget Pro" })],
    });
  });

  function openCreateDialog() {
    renderPage();
    fireEvent.click(screen.getByRole("button", { name: /new product/i }));
  }

  it("shows no warning when the name field is empty", () => {
    openCreateDialog();
    expect(screen.queryByTestId("name-warning-exact")).toBeNull();
    expect(screen.queryByTestId("name-warning-similar")).toBeNull();
  });

  it("shows an exact-match warning when the typed name matches an existing product exactly", async () => {
    openCreateDialog();
    const nameInput = document.getElementById("prod-name") as HTMLInputElement;
    fireEvent.change(nameInput, { target: { value: "Widget Pro" } });
    await waitFor(() => {
      expect(screen.getByTestId("name-warning-exact")).toHaveTextContent("Widget Pro");
    });
    expect(screen.queryByTestId("name-warning-similar")).toBeNull();
  });

  it("is case-insensitive when detecting an exact match", async () => {
    openCreateDialog();
    const nameInput = document.getElementById("prod-name") as HTMLInputElement;
    fireEvent.change(nameInput, { target: { value: "WIDGET PRO" } });
    await waitFor(() => {
      expect(screen.getByTestId("name-warning-exact")).toBeTruthy();
    });
  });

  it("shows a similar-match warning when the typed name is a substring of an existing product name", async () => {
    openCreateDialog();
    const nameInput = document.getElementById("prod-name") as HTMLInputElement;
    fireEvent.change(nameInput, { target: { value: "Widget" } });
    await waitFor(() => {
      expect(screen.getByTestId("name-warning-similar")).toHaveTextContent("Widget Pro");
    });
    expect(screen.queryByTestId("name-warning-exact")).toBeNull();
  });

  it("clears the warning when the name is changed to something unrelated", async () => {
    openCreateDialog();
    const nameInput = document.getElementById("prod-name") as HTMLInputElement;
    fireEvent.change(nameInput, { target: { value: "Widget Pro" } });
    await waitFor(() => {
      expect(screen.getByTestId("name-warning-exact")).toBeTruthy();
    });
    fireEvent.change(nameInput, { target: { value: "Completely Different" } });
    await waitFor(() => {
      expect(screen.queryByTestId("name-warning-exact")).toBeNull();
      expect(screen.queryByTestId("name-warning-similar")).toBeNull();
    });
  });
});

// ---------------------------------------------------------------------------
// Tests: name duplicate warning in the edit-product dialog (self-match exclusion)
// ---------------------------------------------------------------------------

describe("ProductsPage – name duplicate warning in edit dialog (self-match exclusion)", () => {
  const PRODUCT_WIDGET = makeProduct({ id: 1, name: "Widget Pro", brand: "Acme" });
  const PRODUCT_BADGE = makeProduct({ id: 2, name: "Badge Holder", brand: "Acme" });

  beforeEach(() => {
    vi.clearAllMocks();
    mockSearch = "";
    mockLocation = "/products";
    mockNavigate.mockReset();
    setupMocks({
      products: [PRODUCT_WIDGET, PRODUCT_BADGE],
      brands: [{ id: 1, name: "Acme" }],
    });
  });

  async function openEditDialog() {
    const user = userEvent.setup();
    renderPage();
    // Edit is inside a three-dot dropdown — open the trigger first
    const actionTriggers = screen.getAllByRole("button", { name: /product actions/i });
    await user.click(actionTriggers[0]);
    const editItem = await screen.findByTestId("button-edit-product-1");
    await user.click(editItem);
  }

  it("shows no warning when the dialog first opens (own name pre-filled, excluded from check)", async () => {
    await openEditDialog();
    expect(screen.queryByTestId("name-warning-exact")).toBeNull();
    expect(screen.queryByTestId("name-warning-similar")).toBeNull();
  });

  it("shows an exact-match warning when the name is changed to match another product", async () => {
    await openEditDialog();
    fireEvent.change(screen.getByTestId("input-product-name"), {
      target: { value: "Badge Holder" },
    });
    await waitFor(() => {
      expect(screen.getByTestId("name-warning-exact")).toHaveTextContent("Badge Holder");
    });
    expect(screen.queryByTestId("name-warning-similar")).toBeNull();
  });

  it("is case-insensitive when detecting an exact match in the edit dialog", async () => {
    await openEditDialog();
    fireEvent.change(screen.getByTestId("input-product-name"), {
      target: { value: "BADGE HOLDER" },
    });
    await waitFor(() => {
      expect(screen.getByTestId("name-warning-exact")).toBeTruthy();
    });
  });

  it("suppresses the warning when typing the product's own current name (self-match exclusion)", async () => {
    await openEditDialog();
    fireEvent.change(screen.getByTestId("input-product-name"), {
      target: { value: "Badge Holder" },
    });
    await waitFor(() => {
      expect(screen.getByTestId("name-warning-exact")).toBeTruthy();
    });
    fireEvent.change(screen.getByTestId("input-product-name"), {
      target: { value: "Widget Pro" },
    });
    await waitFor(() => {
      expect(screen.queryByTestId("name-warning-exact")).toBeNull();
      expect(screen.queryByTestId("name-warning-similar")).toBeNull();
    });
  });

  it("shows a similar-match warning when the typed name overlaps with another product name", async () => {
    await openEditDialog();
    fireEvent.change(screen.getByTestId("input-product-name"), {
      target: { value: "Badge" },
    });
    await waitFor(() => {
      expect(screen.getByTestId("name-warning-similar")).toHaveTextContent("Badge Holder");
    });
    expect(screen.queryByTestId("name-warning-exact")).toBeNull();
  });

  it("clears the warning when the name is changed to something unrelated", async () => {
    await openEditDialog();
    fireEvent.change(screen.getByTestId("input-product-name"), {
      target: { value: "Badge Holder" },
    });
    await waitFor(() => {
      expect(screen.getByTestId("name-warning-exact")).toBeTruthy();
    });
    fireEvent.change(screen.getByTestId("input-product-name"), {
      target: { value: "Completely Different" },
    });
    await waitFor(() => {
      expect(screen.queryByTestId("name-warning-exact")).toBeNull();
      expect(screen.queryByTestId("name-warning-similar")).toBeNull();
    });
  });
});

describe("ProductsPage — edit save outcomes", () => {
  const product = makeProduct({ id: 1, name: "Widget Pro", brand: "Acme" });

  beforeEach(() => {
    vi.clearAllMocks();
    mockSearch = "";
    mockLocation = "/products";
    mockNavigate.mockReset();
    setupMocks({
      products: [product],
      brands: [{ id: 1, name: "Acme" }],
    });
    mockUseMutation.mockImplementation((opts) => ({
      isPending: false,
      mutate: (variables: unknown) => {
        void opts.mutationFn(variables)
          .then((result: unknown) => opts.onSuccess?.(result, variables))
          .catch((err: unknown) =>opts.onError?.(err, variables));
      },
    }));
  });

  async function openAndSave() {
    const user = userEvent.setup();
    renderPage();
    await user.click(screen.getByRole("button", { name: /product actions/i }));
    await user.click(await screen.findByTestId("button-edit-product-1"));
    expect(screen.getByRole("heading", { name: "Edit Product" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Save" }));
  }

  it("closes the dialog, refreshes products, and confirms a successful edit", async () => {
    mockApiFetch.mockImplementation(async (url) => {
      if (url === "/api/products/1") {
        return { product: { ...product, name: "Widget Pro" }, warnings: [] };
      }
      return { success: true };
    });

    await openAndSave();

    await waitFor(() => {
      expect(screen.queryByRole("heading", { name: "Edit Product" })).not.toBeInTheDocument();
    });
    expect(mockInvalidateQueries).toHaveBeenCalledWith({ queryKey: ["products"] });
    expect(mockInvalidateQueries).toHaveBeenCalledWith({ queryKey: ["products-summary"] });
    expect(mockToast).toHaveBeenCalledWith({ title: "Product updated" });
    expect(mockToast).not.toHaveBeenCalledWith(
      expect.objectContaining({ title: "Failed to update product" }),
    );
  });

  it("does not report a core update failure when only availability fails", async () => {
    mockProductCountryAvailability = {
      countries: [{
        country_code: "AE",
        country_name: "United Arab Emirates",
        flag_emoji: "🇦🇪",
        is_available: true,
      }],
    };
    mockProductCityAvailability = {
      cities: [{
        city_id: 10,
        city_name: "Dubai",
        country_code: "AE",
        city_is_active: true,
        is_available: true,
      }],
    };
    mockApiFetch.mockImplementation(async (url) => {
      if (url === "/api/products/1") {
        return { product: { ...product, name: "Widget Pro" }, warnings: [] };
      }
      if (url === "/api/products/1/country-availability") {
        throw new Error("HTTP 500");
      }
      return { success: true };
    });

    await openAndSave();

    await waitFor(() => {
      expect(screen.queryByRole("heading", { name: "Edit Product" })).not.toBeInTheDocument();
    });
    expect(mockToast).toHaveBeenCalledWith({ title: "Product updated" });
    expect(mockToast).toHaveBeenCalledWith(expect.objectContaining({
      title: "Product updated with a warning",
      description: expect.stringContaining("country availability"),
    }));
    expect(mockApiFetch).toHaveBeenCalledWith(
      "/api/products/1/city-availability",
      expect.objectContaining({ method: "PUT" }),
    );
    expect(mockToast).not.toHaveBeenCalledWith(
      expect.objectContaining({ title: "Failed to update product" }),
    );
  });

  it("keeps the dialog open and shows the core error when the product patch fails", async () => {
    mockApiFetch.mockRejectedValueOnce(new Error("Name is required"));

    await openAndSave();

    await waitFor(() => {
      expect(mockToast).toHaveBeenCalledWith({
        variant: "destructive",
        title: "Failed to update product",
        description: "Name is required",
      });
    });
    expect(screen.getByRole("heading", { name: "Edit Product" })).toBeInTheDocument();
  });
});

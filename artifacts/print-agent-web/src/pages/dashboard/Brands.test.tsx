import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, within, fireEvent, waitFor, act } from "@testing-library/react";
import BrandsPage from "./Brands";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock("wouter", () => ({
  Link: ({ href, children }: { href: string; children: React.ReactNode }) => (
    <a href={href}>{children}</a>
  ),
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, opts?: { count?: number }) =>
      opts?.count !== undefined ? `${opts.count} ${key}` : key,
  }),
}));

const mockUseQuery = vi.fn();
const mockUseMutation = vi.fn();

vi.mock("@tanstack/react-query", () => ({
  useQuery: (...args: unknown[]) => mockUseQuery(...args),
  useMutation: (...args: unknown[]) => mockUseMutation(...args),
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
}));

vi.mock("@/lib/queryClient", () => ({
  apiFetch: vi.fn(),
}));

vi.mock("@/hooks/use-toast", () => ({
  useToast: () => ({ toast: vi.fn() }),
}));

const mockUseWorkspaceRole = vi.fn();
vi.mock("@/hooks/use-workspace-role", () => ({
  useWorkspaceRole: () => mockUseWorkspaceRole(),
}));

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeBrand(overrides: Partial<{
  id: number;
  name: string;
  description: string | null;
  target_cogs: string | null;
  created_at: string;
  updated_at: string | null;
  sticker_count: string;
  product_count: string;
  has_logo: boolean;
}> = {}) {
  return {
    id: 1,
    name: "Test Brand",
    description: null,
    target_cogs: null,
    created_at: "2024-01-01T00:00:00Z",
    updated_at: null,
    sticker_count: "3",
    product_count: "5",
    has_logo: false,
    ...overrides,
  };
}

const noop = { mutate: vi.fn(), mutateAsync: vi.fn(), isPending: false };

function setupMocks({
  brands = [makeBrand()],
  allowedPages = null as string[] | null,
  isOwner = false,
  role = "member",
} = {}) {
  mockUseMutation.mockReturnValue(noop);
  mockUseWorkspaceRole.mockReturnValue({ isOwner, role, allowedPages });
  mockUseQuery.mockImplementation((opts: { queryKey: unknown[] }) => {
    if (opts.queryKey[0] === "brands") {
      return { data: { brands, workspaceJobCount: 0 }, isLoading: false };
    }
    return { data: undefined, isLoading: false };
  });
}

function renderBrands() {
  return render(<BrandsPage />);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("BrandsPage – brand card count label by role", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("project manager role", () => {
    it("shows '5 brands.productCount_other' for a brand with 5 products", () => {
      setupMocks({
        brands: [makeBrand({ sticker_count: "3", product_count: "5" })],
        allowedPages: ["project-manager-dashboard"],
      });
      renderBrands();
      expect(screen.getByText("5 brands.productCount_other")).toBeInTheDocument();
    });

    it("shows '1 brands.productCount_one' for a brand with exactly 1 product", () => {
      setupMocks({
        brands: [makeBrand({ sticker_count: "3", product_count: "1" })],
        allowedPages: ["project-manager-dashboard"],
      });
      renderBrands();
      expect(screen.getByText("1 brands.productCount_one")).toBeInTheDocument();
    });

    it("does not show any sticker count label for a project manager", () => {
      setupMocks({
        brands: [makeBrand({ sticker_count: "3", product_count: "5" })],
        allowedPages: ["project-manager-dashboard"],
      });
      renderBrands();
      expect(screen.queryByText(/brands\.stickerCount/)).not.toBeInTheDocument();
    });
  });

  describe("owner role", () => {
    it("shows '3 brands.stickerCount_other' for a brand with 3 stickers", () => {
      setupMocks({
        brands: [makeBrand({ sticker_count: "3", product_count: "5" })],
        isOwner: true,
        role: "owner",
        allowedPages: null,
      });
      renderBrands();
      expect(screen.getByText("3 brands.stickerCount_other")).toBeInTheDocument();
    });

    it("shows '1 brands.stickerCount_one' for a brand with exactly 1 sticker", () => {
      setupMocks({
        brands: [makeBrand({ sticker_count: "1", product_count: "5" })],
        isOwner: true,
        role: "owner",
        allowedPages: null,
      });
      renderBrands();
      expect(screen.getByText("1 brands.stickerCount_one")).toBeInTheDocument();
    });

    it("does not show any product count label for an owner", () => {
      setupMocks({
        brands: [makeBrand({ sticker_count: "3", product_count: "5" })],
        isOwner: true,
        role: "owner",
        allowedPages: null,
      });
      renderBrands();
      expect(screen.queryByText(/brands\.productCount/)).not.toBeInTheDocument();
    });
  });

  describe("designer role", () => {
    it("shows '4 brands.stickerCount_other' for a brand with 4 stickers", () => {
      setupMocks({
        brands: [makeBrand({ sticker_count: "4", product_count: "2" })],
        isOwner: false,
        role: "designer",
        allowedPages: null,
      });
      renderBrands();
      expect(screen.getByText("4 brands.stickerCount_other")).toBeInTheDocument();
    });

    it("shows '1 brands.stickerCount_one' for a brand with exactly 1 sticker", () => {
      setupMocks({
        brands: [makeBrand({ sticker_count: "1", product_count: "2" })],
        isOwner: false,
        role: "designer",
        allowedPages: null,
      });
      renderBrands();
      expect(screen.getByText("1 brands.stickerCount_one")).toBeInTheDocument();
    });

    it("does not show any product count label for a designer", () => {
      setupMocks({
        brands: [makeBrand({ sticker_count: "4", product_count: "2" })],
        isOwner: false,
        role: "designer",
        allowedPages: null,
      });
      renderBrands();
      expect(screen.queryByText(/brands\.productCount/)).not.toBeInTheDocument();
    });
  });

  describe("multiple brands – per-row count labels (table layout)", () => {
    it("shows the correct product count in each row when user is a project manager", () => {
      setupMocks({
        brands: [
          makeBrand({ id: 1, name: "Brand A", sticker_count: "2", product_count: "3" }),
          makeBrand({ id: 2, name: "Brand B", sticker_count: "5", product_count: "1" }),
        ],
        allowedPages: ["project-manager-dashboard"],
      });
      renderBrands();

      const rowA = screen.getByTestId("brand-row-1");
      const rowB = screen.getByTestId("brand-row-2");
      expect(within(rowA).getByText("3 brands.productCount_other")).toBeInTheDocument();
      expect(within(rowB).getByText("1 brands.productCount_one")).toBeInTheDocument();
    });

    it("shows the correct sticker count in each row when user is an owner", () => {
      setupMocks({
        brands: [
          makeBrand({ id: 1, name: "Brand A", sticker_count: "2", product_count: "3" }),
          makeBrand({ id: 2, name: "Brand B", sticker_count: "1", product_count: "4" }),
        ],
        isOwner: true,
        role: "owner",
        allowedPages: null,
      });
      renderBrands();

      const rowA = screen.getByTestId("brand-row-1");
      const rowB = screen.getByTestId("brand-row-2");
      expect(within(rowA).getByText("2 brands.stickerCount_other")).toBeInTheDocument();
      expect(within(rowB).getByText("1 brands.stickerCount_one")).toBeInTheDocument();
    });
  });
});

// ---------------------------------------------------------------------------
// Component integration test: name duplicate warning in the create-brand form
// ---------------------------------------------------------------------------

describe("BrandsPage – name duplicate warning in create form", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setupMocks({
      brands: [makeBrand({ id: 1, name: "Acme" })],
      isOwner: true,
      role: "owner",
    });
  });

  function openCreateDialog() {
    renderBrands();
    const btn = screen.getAllByRole("button").find((b) =>
      b.textContent?.includes("brands.newBrand"),
    );
    fireEvent.click(btn!);
  }

  it("shows no warning when the name field is empty", () => {
    openCreateDialog();
    expect(screen.queryByTestId("name-warning-exact")).toBeNull();
    expect(screen.queryByTestId("name-warning-similar")).toBeNull();
  });

  it("shows an exact-match warning when the typed name matches an existing brand exactly", async () => {
    openCreateDialog();
    fireEvent.change(screen.getByRole("textbox", { name: /brand name/i }), {
      target: { value: "Acme" },
    });
    await waitFor(() => {
      expect(screen.getByTestId("name-warning-exact")).toHaveTextContent("Acme");
    });
    expect(screen.queryByTestId("name-warning-similar")).toBeNull();
  });

  it("is case-insensitive when detecting an exact match", async () => {
    openCreateDialog();
    fireEvent.change(screen.getByRole("textbox", { name: /brand name/i }), {
      target: { value: "ACME" },
    });
    await waitFor(() => {
      expect(screen.getByTestId("name-warning-exact")).toBeTruthy();
    });
  });

  it("shows a similar-match warning when the typed name is a substring of an existing brand name", async () => {
    openCreateDialog();
    fireEvent.change(screen.getByRole("textbox", { name: /brand name/i }), {
      target: { value: "Ac" },
    });
    await waitFor(() => {
      expect(screen.getByTestId("name-warning-similar")).toHaveTextContent("Acme");
    });
    expect(screen.queryByTestId("name-warning-exact")).toBeNull();
  });

  it("clears the warning when the name is changed to something unrelated", async () => {
    openCreateDialog();
    fireEvent.change(screen.getByRole("textbox", { name: /brand name/i }), {
      target: { value: "Acme" },
    });
    await waitFor(() => {
      expect(screen.getByTestId("name-warning-exact")).toBeTruthy();
    });
    fireEvent.change(screen.getByRole("textbox", { name: /brand name/i }), {
      target: { value: "Completely Different" },
    });
    await waitFor(() => {
      expect(screen.queryByTestId("name-warning-exact")).toBeNull();
      expect(screen.queryByTestId("name-warning-similar")).toBeNull();
    });
  });
});

// ---------------------------------------------------------------------------
// Tests: whitespace-only name validation in create and rename forms
// ---------------------------------------------------------------------------

describe("BrandsPage – whitespace-only name validation in create form", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setupMocks({ isOwner: true, role: "owner" });
  });

  function openCreateDialog() {
    renderBrands();
    const btn = screen.getAllByRole("button").find((b) =>
      b.textContent?.includes("brands.newBrand"),
    );
    fireEvent.click(btn!);
  }

  it("shows no error when the name field is empty", () => {
    openCreateDialog();
    expect(screen.queryByTestId("name-error-whitespace")).toBeNull();
  });

  it("shows an error when the name is all spaces", async () => {
    openCreateDialog();
    fireEvent.change(screen.getByRole("textbox", { name: /brand name/i }), {
      target: { value: "   " },
    });
    await waitFor(() => {
      expect(screen.getByTestId("name-error-whitespace")).toHaveTextContent(
        "Brand name cannot be blank.",
      );
    });
  });

  it("clears the whitespace error when a non-blank name is entered", async () => {
    openCreateDialog();
    fireEvent.change(screen.getByRole("textbox", { name: /brand name/i }), {
      target: { value: "   " },
    });
    await waitFor(() => {
      expect(screen.getByTestId("name-error-whitespace")).toBeTruthy();
    });
    fireEvent.change(screen.getByRole("textbox", { name: /brand name/i }), {
      target: { value: "Real Name" },
    });
    await waitFor(() => {
      expect(screen.queryByTestId("name-error-whitespace")).toBeNull();
    });
  });

  it("disables the Create button when the name is all whitespace", async () => {
    openCreateDialog();
    fireEvent.change(screen.getByRole("textbox", { name: /brand name/i }), {
      target: { value: "   " },
    });
    await waitFor(() => {
      expect(screen.getByRole("button", { name: /^Create$/i })).toBeDisabled();
    });
  });
});

describe("BrandsPage – whitespace-only name validation in rename dialog", () => {
  const BRAND_ACME = makeBrand({ id: 1, name: "Acme" });

  beforeEach(() => {
    vi.clearAllMocks();
    setupMocks({ brands: [BRAND_ACME], isOwner: true, role: "owner" });
  });

  function openRenameDialog() {
    renderBrands();
    fireEvent.click(screen.getByTestId("button-rename-brand-1"));
  }

  it("shows no whitespace error when the dialog opens with the brand name pre-filled", () => {
    openRenameDialog();
    expect(screen.queryByTestId("rename-error-whitespace")).toBeNull();
  });

  it("shows an error when the rename field is cleared and then filled with spaces", async () => {
    openRenameDialog();
    fireEvent.change(screen.getByTestId("input-brand-rename"), {
      target: { value: "   " },
    });
    await waitFor(() => {
      expect(screen.getByTestId("rename-error-whitespace")).toHaveTextContent(
        "Brand name cannot be blank.",
      );
    });
  });

  it("disables the Save button when the rename field is all whitespace", async () => {
    openRenameDialog();
    fireEvent.change(screen.getByTestId("input-brand-rename"), {
      target: { value: "   " },
    });
    await waitFor(() => {
      expect(screen.getByRole("button", { name: /^Save$/i })).toBeDisabled();
    });
  });
});

// ---------------------------------------------------------------------------
// Tests: name duplicate warning in the rename-brand dialog (self-match exclusion)
// ---------------------------------------------------------------------------

describe("BrandsPage – name duplicate warning in rename dialog (self-match exclusion)", () => {
  const BRAND_ACME = makeBrand({ id: 1, name: "Acme" });
  const BRAND_NIKE = makeBrand({ id: 2, name: "Nike" });

  beforeEach(() => {
    vi.clearAllMocks();
    setupMocks({ brands: [BRAND_ACME, BRAND_NIKE], isOwner: true, role: "owner" });
  });

  function openRenameDialog() {
    renderBrands();
    fireEvent.click(screen.getByTestId("button-rename-brand-1"));
  }

  it("shows no warning when the rename dialog first opens (own name pre-filled, excluded from check)", () => {
    openRenameDialog();
    expect(screen.queryByTestId("name-warning-exact")).toBeNull();
    expect(screen.queryByTestId("name-warning-similar")).toBeNull();
  });

  it("shows an exact-match warning when the name is changed to match another brand", async () => {
    openRenameDialog();
    fireEvent.change(screen.getByTestId("input-brand-rename"), {
      target: { value: "Nike" },
    });
    await waitFor(() => {
      expect(screen.getByTestId("name-warning-exact")).toHaveTextContent("Nike");
    });
    expect(screen.queryByTestId("name-warning-similar")).toBeNull();
  });

  it("is case-insensitive when detecting an exact match in the rename dialog", async () => {
    openRenameDialog();
    fireEvent.change(screen.getByTestId("input-brand-rename"), {
      target: { value: "NIKE" },
    });
    await waitFor(() => {
      expect(screen.getByTestId("name-warning-exact")).toBeTruthy();
    });
  });

  it("suppresses the warning when typing the brand's own current name (self-match exclusion)", async () => {
    openRenameDialog();
    fireEvent.change(screen.getByTestId("input-brand-rename"), {
      target: { value: "Nike" },
    });
    await waitFor(() => {
      expect(screen.getByTestId("name-warning-exact")).toBeTruthy();
    });
    fireEvent.change(screen.getByTestId("input-brand-rename"), {
      target: { value: "Acme" },
    });
    await waitFor(() => {
      expect(screen.queryByTestId("name-warning-exact")).toBeNull();
      expect(screen.queryByTestId("name-warning-similar")).toBeNull();
    });
  });

  it("shows a similar-match warning when the typed name overlaps with another brand name", async () => {
    openRenameDialog();
    fireEvent.change(screen.getByTestId("input-brand-rename"), {
      target: { value: "Nik" },
    });
    await waitFor(() => {
      expect(screen.getByTestId("name-warning-similar")).toHaveTextContent("Nike");
    });
    expect(screen.queryByTestId("name-warning-exact")).toBeNull();
  });

  it("clears the warning when the name is changed to something unrelated", async () => {
    openRenameDialog();
    fireEvent.change(screen.getByTestId("input-brand-rename"), {
      target: { value: "Nike" },
    });
    await waitFor(() => {
      expect(screen.getByTestId("name-warning-exact")).toBeTruthy();
    });
    fireEvent.change(screen.getByTestId("input-brand-rename"), {
      target: { value: "Completely Different" },
    });
    await waitFor(() => {
      expect(screen.queryByTestId("name-warning-exact")).toBeNull();
      expect(screen.queryByTestId("name-warning-similar")).toBeNull();
    });
  });
});

// ---------------------------------------------------------------------------
// Tests: 409 server error → inline error on create form
// ---------------------------------------------------------------------------

describe("BrandsPage – 409 server error shows inline error in create form", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  function openCreateDialog() {
    renderBrands();
    const btn = screen.getAllByRole("button").find((b) =>
      b.textContent?.includes("brands.newBrand"),
    );
    fireEvent.click(btn!);
  }

  function setupWithCapture() {
    mockUseWorkspaceRole.mockReturnValue({ isOwner: true, role: "owner", allowedPages: null });
    mockUseQuery.mockImplementation((opts: { queryKey: unknown[] }) => {
      if (opts.queryKey[0] === "brands") {
        return { data: { brands: [], workspaceJobCount: 0 }, isLoading: false };
      }
      return { data: undefined, isLoading: false };
    });

    let capturedOnError: ((err: Error & { status?: number }) => void) | undefined;
    let callCount = 0;
    mockUseMutation.mockImplementation((opts: { onError?: (err: Error & { status?: number }) => void }) => {
      callCount++;
      if (callCount === 1) capturedOnError = opts.onError;
      return noop;
    });
    return () => capturedOnError;
  }

  it("shows the inline duplicate error when the mutation fails with status 409", async () => {
    const getOnError = setupWithCapture();

    openCreateDialog();

    const err = Object.assign(new Error("A brand with this name already exists"), { status: 409 });
    act(() => { getOnError()!(err); });

    await waitFor(() => {
      expect(screen.getByTestId("name-error-duplicate")).toHaveTextContent(
        "A brand with this name already exists",
      );
    });
  });

  it("clears the inline duplicate error when the user edits the name field", async () => {
    const getOnError = setupWithCapture();

    openCreateDialog();

    const err = Object.assign(new Error("A brand with this name already exists"), { status: 409 });
    act(() => { getOnError()!(err); });

    await waitFor(() => {
      expect(screen.getByTestId("name-error-duplicate")).toBeTruthy();
    });

    fireEvent.change(screen.getByRole("textbox", { name: /brand name/i }), {
      target: { value: "New Name" },
    });

    await waitFor(() => {
      expect(screen.queryByTestId("name-error-duplicate")).toBeNull();
    });
  });

  it("does not show a general error toast for a 409 error (only the inline message)", async () => {
    const getOnError = setupWithCapture();

    openCreateDialog();

    const err = Object.assign(new Error("A brand with this name already exists"), { status: 409 });
    act(() => { getOnError()!(err); });

    await waitFor(() => {
      expect(screen.getByTestId("name-error-duplicate")).toBeTruthy();
    });

    expect(screen.queryByText("Failed to create brand")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Tests: 409 server error → inline error on rename form
// ---------------------------------------------------------------------------

describe("BrandsPage – 409 server error shows inline error in rename dialog", () => {
  const BRAND_ACME = makeBrand({ id: 1, name: "Acme" });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  function openRenameDialog() {
    renderBrands();
    fireEvent.click(screen.getByTestId("button-rename-brand-1"));
  }

  function setupWithCapture() {
    mockUseWorkspaceRole.mockReturnValue({ isOwner: true, role: "owner", allowedPages: null });
    mockUseQuery.mockImplementation((opts: { queryKey: unknown[] }) => {
      if (opts.queryKey[0] === "brands") {
        return { data: { brands: [BRAND_ACME], workspaceJobCount: 0 }, isLoading: false };
      }
      return { data: undefined, isLoading: false };
    });

    let capturedOnError: ((err: Error & { status?: number }) => void) | undefined;
    let callCount = 0;
    mockUseMutation.mockImplementation((opts: { onError?: (err: Error & { status?: number }) => void }) => {
      callCount++;
      if (callCount === 2) capturedOnError = opts.onError;
      return noop;
    });
    return () => capturedOnError;
  }

  it("shows the inline duplicate error when the rename mutation fails with status 409", async () => {
    const getOnError = setupWithCapture();

    openRenameDialog();

    const err = Object.assign(new Error("A brand with this name already exists"), { status: 409 });
    act(() => { getOnError()!(err); });

    await waitFor(() => {
      expect(screen.getByTestId("rename-error-duplicate")).toHaveTextContent(
        "A brand with this name already exists",
      );
    });
  });

  it("clears the inline duplicate error when the user edits the rename field", async () => {
    const getOnError = setupWithCapture();

    openRenameDialog();

    const err = Object.assign(new Error("A brand with this name already exists"), { status: 409 });
    act(() => { getOnError()!(err); });

    await waitFor(() => {
      expect(screen.getByTestId("rename-error-duplicate")).toBeTruthy();
    });

    fireEvent.change(screen.getByTestId("input-brand-rename"), {
      target: { value: "New Name" },
    });

    await waitFor(() => {
      expect(screen.queryByTestId("rename-error-duplicate")).toBeNull();
    });
  });

  it("does not show a general error toast for a 409 error in the rename dialog (only the inline message)", async () => {
    const getOnError = setupWithCapture();

    openRenameDialog();

    const err = Object.assign(new Error("A brand with this name already exists"), { status: 409 });
    act(() => { getOnError()!(err); });

    await waitFor(() => {
      expect(screen.getByTestId("rename-error-duplicate")).toBeTruthy();
    });

    expect(screen.queryByText("Rename failed")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Tests: list view sort order
// ---------------------------------------------------------------------------

describe("BrandsPage – list view sort order", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders brands in alphabetical order by default (name A–Z) regardless of API response order", () => {
    setupMocks({
      brands: [
        makeBrand({ id: 3, name: "Zebra", sticker_count: "0", product_count: "0" }),
        makeBrand({ id: 1, name: "Aardvark", sticker_count: "0", product_count: "0" }),
        makeBrand({ id: 2, name: "Mango", sticker_count: "0", product_count: "0" }),
      ],
      isOwner: true,
      role: "owner",
      allowedPages: null,
    });
    renderBrands();

    const allRows = screen.getAllByRole("row");
    const dataRows = allRows.filter((r) => r.getAttribute("data-testid")?.startsWith("brand-row-"));
    const names = dataRows.map((r) => within(r).getAllByRole("link")[0].textContent ?? "");
    expect(names).toEqual(["Aardvark", "Mango", "Zebra"]);
  });
});

describe("BrandsPage – statement aliases tab", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.history.replaceState(null, "", "/brands");
  });

  it("does not expose aliases to a brand-only user, even when the URL requests the tab", async () => {
    window.history.replaceState(null, "", "/brands?tab=statement-aliases");
    setupMocks({ isOwner: false, role: "member", allowedPages: ["brands"] });

    renderBrands();

    await waitFor(() => {
      expect(screen.queryByTestId("statement-aliases-tab")).toBeNull();
      expect(screen.queryByTestId("statement-aliases-view")).toBeNull();
    });
  });
});

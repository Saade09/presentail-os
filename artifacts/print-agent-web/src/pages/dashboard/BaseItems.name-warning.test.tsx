import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, act } from "@testing-library/react";
import BaseItemsPage from "./BaseItems";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

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

vi.mock("@/components/BaseItemCategoryCombobox", () => ({
  BaseItemCategoryCombobox: () => null,
}));

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeItem(overrides: Partial<{
  id: number;
  name: string;
  code: string;
  image_url: string | null;
  category_id: number | null;
  main_category_name: string | null;
  sub_category_name: string | null;
  created_at: string;
}> = {}) {
  return {
    id: 1,
    name: "Red Roses",
    code: "ABC001",
    image_url: null,
    category_id: null,
    main_category_name: null,
    sub_category_name: null,
    created_at: "2024-01-01T00:00:00Z",
    ...overrides,
  };
}

const noop = { mutate: vi.fn(), mutateAsync: vi.fn(), isPending: false };

function setupMocks(items = [makeItem()]) {
  mockUseMutation.mockReturnValue(noop);
  mockUseQuery.mockImplementation((opts: { queryKey: unknown[] }) => {
    const key = opts.queryKey[0];
    if (key === "base-items") return { data: { items }, isLoading: false };
    if (key === "base-item-categories") return { data: { categories: [] }, isLoading: false };
    if (key === "base-items-summary") return { data: { total: items.length, with_image: 0, without_image: items.length }, isLoading: false };
    return { data: undefined, isLoading: false };
  });
}

// ---------------------------------------------------------------------------
// Tests: name duplicate warning in the edit dialog (self-match exclusion)
// ---------------------------------------------------------------------------

describe("BaseItemsPage – name duplicate warning in edit dialog (self-match exclusion)", () => {
  const ITEM_ROSES = makeItem({ id: 1, name: "Red Roses", code: "ABC001" });
  const ITEM_TULIPS = makeItem({ id: 2, name: "Blue Tulips", code: "ABC002" });

  beforeEach(() => {
    vi.clearAllMocks();
    setupMocks([ITEM_ROSES, ITEM_TULIPS]);
  });

  function openEditDialog() {
    render(<BaseItemsPage />);
    fireEvent.click(screen.getByTestId("button-edit-base-item-1"));
  }

  it("shows no warning when the dialog first opens (own name pre-filled, excluded from check)", () => {
    openEditDialog();

    expect(screen.queryByTestId("name-warning-exact")).toBeNull();
    expect(screen.queryByTestId("name-warning-similar")).toBeNull();
  });

  it("shows an exact-match warning when the name is changed to match another item", async () => {
    openEditDialog();

    fireEvent.change(screen.getByTestId("input-base-item-name"), {
      target: { value: "Blue Tulips" },
    });

    await waitFor(() => {
      expect(screen.getByTestId("name-warning-exact")).toHaveTextContent("Blue Tulips");
    });
    expect(screen.queryByTestId("name-warning-similar")).toBeNull();
  });

  it("suppresses the warning when typing the item's own current name (self-match exclusion)", async () => {
    openEditDialog();

    fireEvent.change(screen.getByTestId("input-base-item-name"), {
      target: { value: "Blue Tulips" },
    });

    await waitFor(() => {
      expect(screen.getByTestId("name-warning-exact")).toBeTruthy();
    });

    fireEvent.change(screen.getByTestId("input-base-item-name"), {
      target: { value: "Red Roses" },
    });

    await waitFor(() => {
      expect(screen.queryByTestId("name-warning-exact")).toBeNull();
      expect(screen.queryByTestId("name-warning-similar")).toBeNull();
    });
  });

  it("shows a similar-match warning when the typed name overlaps with another item name", async () => {
    openEditDialog();

    fireEvent.change(screen.getByTestId("input-base-item-name"), {
      target: { value: "Blue" },
    });

    await waitFor(() => {
      expect(screen.getByTestId("name-warning-similar")).toHaveTextContent("Blue Tulips");
    });
    expect(screen.queryByTestId("name-warning-exact")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Tests: name duplicate warning in the create dialog (server-side check)
//
// The create dialog debounces the name input by 300 ms before calling the
// check-name endpoint. waitFor's default timeout (1000 ms) is large enough
// to let the real timer fire without needing fake timers.
// ---------------------------------------------------------------------------

// The create dialog debounces name input by 300 ms. We use fake timers
// (setTimeout only) and `await act(async () => { vi.advanceTimersByTime(...) })`
// so React flushes all pending state updates triggered by the timer inside
// a single async act — no waitFor needed.
describe("BaseItemsPage – name duplicate warning in create dialog (server-side check)", () => {
  const ITEM_ROSES = makeItem({ id: 1, name: "Red Roses", code: "ABC001" });

  function setupWithCheckName() {
    mockUseMutation.mockReturnValue(noop);
    mockUseQuery.mockImplementation((opts: { queryKey: unknown[] }) => {
      const key = opts.queryKey[0];
      const name = (opts.queryKey[1] as string | undefined) ?? "";

      if (key === "base-items") return { data: { items: [ITEM_ROSES] }, isLoading: false };
      if (key === "base-item-categories") return { data: { categories: [] }, isLoading: false };
      if (key === "base-items-summary") return { data: { total: 1, with_image: 0, without_image: 1 }, isLoading: false };

      if (key === "base-items-check-name") {
        if (!name) return { data: undefined, isLoading: false };
        const lower = name.toLowerCase();
        const existingName = ITEM_ROSES.name;
        const existingLower = existingName.toLowerCase();
        if (existingLower === lower) {
          return { data: { exactMatch: existingName, similarMatches: [] }, isLoading: false };
        }
        if (existingLower.includes(lower) || lower.includes(existingLower)) {
          return { data: { exactMatch: null, similarMatches: [existingName] }, isLoading: false };
        }
        return { data: { exactMatch: null, similarMatches: [] }, isLoading: false };
      }

      return { data: undefined, isLoading: false };
    });
  }

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    vi.clearAllMocks();
    setupWithCheckName();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function openCreateDialog() {
    render(<BaseItemsPage />);
    fireEvent.click(screen.getByText("New Base Item"));
  }

  it("shows no warning when the create dialog first opens", () => {
    openCreateDialog();

    expect(screen.queryByTestId("name-warning-exact")).toBeNull();
    expect(screen.queryByTestId("name-warning-similar")).toBeNull();
  });

  it("shows an exact-match warning after debounce when the typed name matches an existing item", async () => {
    openCreateDialog();

    fireEvent.change(screen.getByTestId("input-base-item-name"), {
      target: { value: "Red Roses" },
    });
    await act(async () => { vi.advanceTimersByTime(400); });

    expect(screen.getByTestId("name-warning-exact")).toHaveTextContent("Red Roses");
    expect(screen.queryByTestId("name-warning-similar")).toBeNull();
  });

  it("shows a similar-match warning after debounce when the typed name partially overlaps", async () => {
    openCreateDialog();

    fireEvent.change(screen.getByTestId("input-base-item-name"), {
      target: { value: "Red" },
    });
    await act(async () => { vi.advanceTimersByTime(400); });

    expect(screen.getByTestId("name-warning-similar")).toHaveTextContent("Red Roses");
    expect(screen.queryByTestId("name-warning-exact")).toBeNull();
  });

  it("clears the warning when the name is changed to a non-matching value", async () => {
    openCreateDialog();

    fireEvent.change(screen.getByTestId("input-base-item-name"), {
      target: { value: "Red Roses" },
    });
    await act(async () => { vi.advanceTimersByTime(400); });

    expect(screen.getByTestId("name-warning-exact")).toBeTruthy();

    fireEvent.change(screen.getByTestId("input-base-item-name"), {
      target: { value: "Orchid" },
    });
    await act(async () => { vi.advanceTimersByTime(400); });

    expect(screen.queryByTestId("name-warning-exact")).toBeNull();
    expect(screen.queryByTestId("name-warning-similar")).toBeNull();
  });
});

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import BaseItemsPage from "./BaseItems";

beforeEach(() => {
  window.history.replaceState({}, "", "/");
});

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
  useWorkspaceRole: () => ({ isOwner: true, allowedPages: null }),
}));

// Mock wouter with a stateful useSearchParams that triggers React re-renders
// when params change, and resets to empty params before each test.
const wooterState = vi.hoisted(() => ({
  params: { current: new URLSearchParams() },
  listeners: { current: new Set<() => void>() },
}));

vi.mock("wouter", async () => {
  const React = await import("react");
  return {
    useSearchParams: () => {
      const [, forceUpdate] = React.useReducer((x: number) => x + 1, 0);
      React.useEffect(() => {
        wooterState.listeners.current.add(forceUpdate);
        return () => { wooterState.listeners.current.delete(forceUpdate); };
      }, []);
      return [
        wooterState.params.current,
        (fn: URLSearchParams | ((p: URLSearchParams) => URLSearchParams)) => {
          wooterState.params.current =
            typeof fn === "function" ? fn(wooterState.params.current) : fn;
          wooterState.listeners.current.forEach((l) => l());
        },
      ];
    },
    useLocation: () => ["/base-items", vi.fn()],
    Link: ({ href, children }: { href: string; children: React.ReactNode }) =>
      React.createElement("a", { href }, children),
  };
});

beforeEach(() => {
  wooterState.params.current = new URLSearchParams();
  wooterState.listeners.current.clear();
});

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const FLOWERS_MAIN = {
  id: 5,
  name: "Flowers",
  parent_id: null as null,
  subcategories: [
    { id: 10, name: "Spring", parent_id: 5 },
    { id: 11, name: "Summer", parent_id: 5 },
  ],
};

const FOLIAGE_MAIN = {
  id: 7,
  name: "Foliage",
  parent_id: null as null,
  subcategories: [],
};

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
    code: "A12345",
    image_url: null,
    category_id: 5,
    main_category_name: "Flowers",
    sub_category_name: null,
    created_at: "2024-01-01T00:00:00Z",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Test setup helpers
// ---------------------------------------------------------------------------

function setupMocks({
  items = [] as ReturnType<typeof makeItem>[],
  categories = [FLOWERS_MAIN, FOLIAGE_MAIN],
} = {}) {
  mockUseMutation.mockReturnValue({ mutate: vi.fn(), isPending: false });
  mockUseQuery.mockImplementation((opts: { queryKey: unknown[] }) => {
    const key = opts.queryKey[0];
    if (key === "base-items") return { data: { items }, isLoading: false };
    if (key === "base-item-categories") return { data: { categories }, isLoading: false };
    return { data: undefined, isLoading: false };
  });
}

function getLastBaseItemsQueryKey(): unknown[] | undefined {
  const calls = mockUseQuery.mock.calls as Array<[{ queryKey: unknown[] }]>;
  const baseItemsCalls = calls.filter((c) => c[0].queryKey[0] === "base-items");
  if (baseItemsCalls.length === 0) return undefined;
  return baseItemsCalls[baseItemsCalls.length - 1][0].queryKey;
}

// ---------------------------------------------------------------------------
// Helper: open a Radix Select and pick an option by visible label text
// ---------------------------------------------------------------------------

function openSelectAndPickOption(triggerEl: HTMLElement, optionLabel: string | RegExp) {
  fireEvent.click(triggerEl);
  const listbox = screen.getByRole("listbox");
  const option = within(listbox).getByText(optionLabel);
  fireEvent.click(option);
}

// ---------------------------------------------------------------------------
// Tests: category dropdown visibility
// ---------------------------------------------------------------------------

describe("BaseItemsPage – category filter dropdown visibility", () => {
  beforeEach(() => vi.clearAllMocks());

  it("renders the main-category dropdown when categories are available", () => {
    setupMocks({ categories: [FLOWERS_MAIN] });
    render(<BaseItemsPage />);

    // At least one combobox present (main_cat + image_status + sort = 3 total)
    const comboboxes = screen.getAllByRole("combobox");
    expect(comboboxes.length).toBeGreaterThan(0);
  });

  it("does not render a category dropdown when no categories exist", () => {
    setupMocks({ categories: [] });
    render(<BaseItemsPage />);

    // Status + Image + Sort dropdowns are always present, but no category dropdown.
    const comboboxes = screen.getAllByRole("combobox");
    expect(comboboxes).toHaveLength(3);
  });

  it("initially shows no subcategory dropdown until a main category is selected", () => {
    setupMocks({ categories: [FLOWERS_MAIN] });
    render(<BaseItemsPage />);

    // status + main_cat + image + sort = 4
    const comboboxes = screen.getAllByRole("combobox");
    expect(comboboxes).toHaveLength(4);
  });

  it("does not show the subcategory dropdown for a main category with no subcategories", async () => {
    setupMocks({ categories: [FOLIAGE_MAIN] });
    render(<BaseItemsPage />);

    const [, mainTrigger] = screen.getAllByRole("combobox");
    openSelectAndPickOption(mainTrigger, "Foliage");

    await waitFor(() => {
      const comboboxes = screen.getAllByRole("combobox");
      // status + main_cat + image + sort = 4 (no sub_cat added)
      expect(comboboxes).toHaveLength(4);
    });
  });
});

// ---------------------------------------------------------------------------
// Tests: main category selection changes query key
// ---------------------------------------------------------------------------

describe("BaseItemsPage – selecting a main category", () => {
  beforeEach(() => vi.clearAllMocks());

  it("adds main_category_id to the query key after selecting a main category", async () => {
    setupMocks({ categories: [FLOWERS_MAIN] });
    render(<BaseItemsPage />);

    const [, mainTrigger] = screen.getAllByRole("combobox");
    openSelectAndPickOption(mainTrigger, "Flowers");

    await waitFor(() => {
      const key = getLastBaseItemsQueryKey();
      expect(key).toBeDefined();
      expect(key![2]).toBe("5");
    });
  });

  it("keeps the subcategory part of the query key empty when only a main category is selected", async () => {
    setupMocks({ categories: [FLOWERS_MAIN] });
    render(<BaseItemsPage />);

    const [, mainTrigger] = screen.getAllByRole("combobox");
    openSelectAndPickOption(mainTrigger, "Flowers");

    await waitFor(() => {
      const key = getLastBaseItemsQueryKey();
      expect(key![3]).toBe("");
    });
  });

  it("reveals the subcategory dropdown after a main category with subcategories is selected", async () => {
    setupMocks({ categories: [FLOWERS_MAIN] });
    render(<BaseItemsPage />);

    const [, mainTrigger] = screen.getAllByRole("combobox");
    openSelectAndPickOption(mainTrigger, "Flowers");

    await waitFor(() => {
      const comboboxes = screen.getAllByRole("combobox");
      // status + main_cat + sub_cat + image + sort = 5
      expect(comboboxes).toHaveLength(5);
    });
  });

  it("shows the Clear button after a main category is selected", async () => {
    setupMocks({ categories: [FLOWERS_MAIN], items: [makeItem()] });
    render(<BaseItemsPage />);

    expect(screen.queryByRole("button", { name: /^clear$/i })).toBeNull();

    const [, mainTrigger] = screen.getAllByRole("combobox");
    openSelectAndPickOption(mainTrigger, "Flowers");

    await waitFor(() => {
      expect(screen.getByRole("button", { name: /^clear$/i })).toBeInTheDocument();
    });
  });
});

// ---------------------------------------------------------------------------
// Tests: subcategory selection further narrows the query
// ---------------------------------------------------------------------------

describe("BaseItemsPage – selecting a subcategory", () => {
  beforeEach(() => vi.clearAllMocks());

  it("sets category_id in the query key when a subcategory is selected", async () => {
    setupMocks({ categories: [FLOWERS_MAIN] });
    render(<BaseItemsPage />);

    const [, mainTrigger] = screen.getAllByRole("combobox");
    openSelectAndPickOption(mainTrigger, "Flowers");

    await waitFor(() => expect(screen.getAllByRole("combobox")).toHaveLength(5));

    const [,, subTrigger] = screen.getAllByRole("combobox");
    openSelectAndPickOption(subTrigger, "Spring");

    await waitFor(() => {
      const key = getLastBaseItemsQueryKey();
      expect(key![2]).toBe("5");
      expect(key![3]).toBe("10");
    });
  });

  it("replaces the subcategory selection when switching to a different subcategory", async () => {
    setupMocks({ categories: [FLOWERS_MAIN] });
    render(<BaseItemsPage />);

    const [, mainTrigger] = screen.getAllByRole("combobox");
    openSelectAndPickOption(mainTrigger, "Flowers");

    await waitFor(() => expect(screen.getAllByRole("combobox")).toHaveLength(5));

    const [,, subTrigger] = screen.getAllByRole("combobox");
    openSelectAndPickOption(subTrigger, "Spring");

    await waitFor(() => {
      const key = getLastBaseItemsQueryKey();
      expect(key![3]).toBe("10");
    });

    const [,, subTrigger2] = screen.getAllByRole("combobox");
    openSelectAndPickOption(subTrigger2, "Summer");

    await waitFor(() => {
      const key = getLastBaseItemsQueryKey();
      expect(key![3]).toBe("11");
    });
  });
});

// ---------------------------------------------------------------------------
// Tests: clearing the filters
// ---------------------------------------------------------------------------

describe("BaseItemsPage – clearing category filters", () => {
  beforeEach(() => vi.clearAllMocks());

  it("resets main category and subcategory in the query key after clicking Clear", async () => {
    setupMocks({ categories: [FLOWERS_MAIN], items: [makeItem()] });
    render(<BaseItemsPage />);

    const [, mainTrigger] = screen.getAllByRole("combobox");
    openSelectAndPickOption(mainTrigger, "Flowers");

    await waitFor(() => expect(screen.getAllByRole("combobox")).toHaveLength(5));

    const [,, subTrigger] = screen.getAllByRole("combobox");
    openSelectAndPickOption(subTrigger, "Spring");

    await waitFor(() => {
      const key = getLastBaseItemsQueryKey();
      expect(key![3]).toBe("10");
    });

    fireEvent.click(screen.getByRole("button", { name: /^clear$/i }));

    await waitFor(() => {
      const key = getLastBaseItemsQueryKey();
      expect(key![2]).toBe("");
      expect(key![3]).toBe("");
    });
  });

  it("hides the Clear button after clearing the filters", async () => {
    setupMocks({ categories: [FLOWERS_MAIN], items: [makeItem()] });
    render(<BaseItemsPage />);

    const [, mainTrigger] = screen.getAllByRole("combobox");
    openSelectAndPickOption(mainTrigger, "Flowers");

    await waitFor(() =>
      expect(screen.getByRole("button", { name: /^clear$/i })).toBeInTheDocument(),
    );

    fireEvent.click(screen.getByRole("button", { name: /^clear$/i }));

    await waitFor(() => {
      expect(screen.queryByRole("button", { name: /^clear$/i })).toBeNull();
    });
  });

  it("hides the subcategory dropdown after clearing the filters", async () => {
    setupMocks({ categories: [FLOWERS_MAIN], items: [makeItem()] });
    render(<BaseItemsPage />);

    const [, mainTrigger] = screen.getAllByRole("combobox");
    openSelectAndPickOption(mainTrigger, "Flowers");

    // status + main_cat + sub_cat + image + sort = 5
    await waitFor(() => expect(screen.getAllByRole("combobox")).toHaveLength(5));

    fireEvent.click(screen.getByRole("button", { name: /^clear$/i }));

    await waitFor(() => {
      // sub_cat gone; status + main_cat + image + sort = 4
      expect(screen.getAllByRole("combobox")).toHaveLength(4);
    });
  });

  it("switching back to 'All categories' in the main dropdown clears the subcategory filter", async () => {
    setupMocks({ categories: [FLOWERS_MAIN] });
    render(<BaseItemsPage />);

    const [, mainTrigger] = screen.getAllByRole("combobox");
    openSelectAndPickOption(mainTrigger, "Flowers");

    await waitFor(() => expect(screen.getAllByRole("combobox")).toHaveLength(5));

    const [,, subTrigger] = screen.getAllByRole("combobox");
    openSelectAndPickOption(subTrigger, "Spring");

    await waitFor(() => {
      const key = getLastBaseItemsQueryKey();
      expect(key![3]).toBe("10");
    });

    const [, mainTrigger2] = screen.getAllByRole("combobox");
    openSelectAndPickOption(mainTrigger2, "All categories");

    await waitFor(() => {
      const key = getLastBaseItemsQueryKey();
      expect(key![2]).toBe("");
      expect(key![3]).toBe("");
    });
  });
});

// ---------------------------------------------------------------------------
// Tests: filtered empty state message
// ---------------------------------------------------------------------------

describe("BaseItemsPage – filtered empty state", () => {
  beforeEach(() => vi.clearAllMocks());

  it("shows a 'no items match filters' message when filtered results are empty", async () => {
    setupMocks({ categories: [FLOWERS_MAIN], items: [] });
    render(<BaseItemsPage />);

    const [, mainTrigger] = screen.getAllByRole("combobox");
    openSelectAndPickOption(mainTrigger, "Flowers");

    await waitFor(() => {
      expect(screen.getByText(/no base items match your filters/i)).toBeInTheDocument();
    });
  });

  it("shows an unfiltered empty state when no category is active and there are no items", () => {
    setupMocks({ categories: [FLOWERS_MAIN], items: [] });
    render(<BaseItemsPage />);

    expect(screen.getByText(/no base items yet/i)).toBeInTheDocument();
  });
});

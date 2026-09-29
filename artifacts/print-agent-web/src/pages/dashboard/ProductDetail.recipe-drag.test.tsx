import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, act, waitFor, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import ProductDetail from "./ProductDetail";
import type { DragEndEvent } from "@dnd-kit/core";

// ---------------------------------------------------------------------------
// Mock data
// ---------------------------------------------------------------------------

const MOCK_PRODUCT = {
  id: 1,
  workspace_owner_id: "ws-1",
  name: "Test Product",
  price_usd: "10.00",
  price_aed: "36.70",
  main_image_url: null,
  additional_image_urls: [],
  description: null,
  status: "available",
  brand: null,
  tags: [],
  category: null,
  created_at: "2024-01-01T00:00:00.000Z",
};

const MOCK_RECIPE = [
  { base_item_id: 1, name: "Alpha", code: "A-01", image_url: null, quantity: "1" },
  { base_item_id: 2, name: "Beta", code: "B-02", image_url: null, quantity: "2" },
  { base_item_id: 3, name: "Gamma", code: "G-03", image_url: null, quantity: "3" },
];

// ---------------------------------------------------------------------------
// Captured drag handler
// ---------------------------------------------------------------------------

let capturedOnDragEnd: ((event: DragEndEvent) => void) | null = null;

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock("wouter", () => ({
  Link: ({
    href,
    children,
    ...props
  }: React.AnchorHTMLAttributes<HTMLAnchorElement> & { href: string }) => (
    <a href={href} {...props}>{children}</a>
  ),
  useParams: () => ({ id: "1" }),
  useLocation: () => ["/", vi.fn()],
}));

vi.mock("@tanstack/react-query", () => ({
  useQuery: (opts: { queryKey: unknown[]; enabled?: boolean }) => {
    const key = Array.isArray(opts.queryKey) ? opts.queryKey[0] : "";
    if (key === "product") {
      return {
        data: { product: MOCK_PRODUCT, recipe: MOCK_RECIPE },
        isLoading: false,
        isError: false,
      };
    }
    return { data: undefined, isLoading: false, isError: false };
  },
  useMutation: () => ({ mutate: vi.fn(), isPending: false }),
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
  useWorkspaceRole: () => ({
    role: "owner",
    isOwner: true,
    canManage: true,
    allowedPages: ["products.manage"],
  }),
}));

vi.mock("@dnd-kit/core", () => ({
  DndContext: ({
    children,
    onDragEnd,
  }: {
    children: React.ReactNode;
    onDragEnd?: (e: DragEndEvent) => void;
  }) => {
    capturedOnDragEnd = onDragEnd ?? null;
    return <>{children}</>;
  },
  closestCenter: vi.fn(),
  KeyboardSensor: class {},
  PointerSensor: class {},
  useSensor: vi.fn(),
  useSensors: vi.fn(() => []),
}));

vi.mock("@dnd-kit/sortable", () => ({
  SortableContext: ({ children }: { children: React.ReactNode }) => (
    <>{children}</>
  ),
  sortableKeyboardCoordinates: vi.fn(),
  useSortable: () => ({
    attributes: {},
    listeners: {},
    setNodeRef: vi.fn(),
    transform: null,
    transition: undefined,
    isDragging: false,
  }),
  horizontalListSortingStrategy: vi.fn(),
  verticalListSortingStrategy: vi.fn(),
  arrayMove: <T,>(arr: T[], from: number, to: number): T[] => {
    const result = [...arr];
    result.splice(to, 0, result.splice(from, 1)[0]);
    return result;
  },
}));

vi.mock("@dnd-kit/utilities", () => ({
  CSS: {
    Transform: { toString: () => "" },
  },
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeDragEvent(activeId: number, overId: number): DragEndEvent {
  return {
    active: {
      id: activeId,
      data: { current: undefined },
      rect: { current: { initial: null, translated: null } },
    },
    over: {
      id: overId,
      data: { current: undefined },
      rect: { width: 0, height: 0, top: 0, left: 0, bottom: 0, right: 0 },
    },
    activatorEvent: new Event("pointerdown"),
    collisions: [],
    delta: { x: 0, y: 0 },
  } as unknown as DragEndEvent;
}

async function navigateToRecipeEditTab() {
  const user = userEvent.setup();
  await waitFor(() => {
    expect(screen.getByTestId("button-edit-product")).toBeTruthy();
  });
  await user.click(screen.getByTestId("button-edit-product"));
  await waitFor(() => {
    expect(screen.getByRole("tab", { name: "Recipe" })).toBeTruthy();
  });
  await user.click(screen.getByRole("tab", { name: "Recipe" }));
  await waitFor(() => {
    expect(screen.getByRole("tab", { name: "Recipe" }).getAttribute("data-state")).toBe("active");
  });
}

function recipeRowOrder(): number[] {
  return Array.from(document.querySelectorAll("[data-testid^='recipe-row-']")).map(
    (el) => parseInt((el as HTMLElement).dataset.testid!.replace("recipe-row-", ""), 10),
  );
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("ProductDetail — recipe drag-to-reorder", () => {
  beforeEach(() => {
    capturedOnDragEnd = null;
    vi.clearAllMocks();
  });

  it("renders the three recipe rows in their initial order", async () => {
    render(<ProductDetail />);
    await navigateToRecipeEditTab();

    await waitFor(() => {
      expect(document.querySelector("[data-testid='recipe-row-1']")).toBeTruthy();
    });

    expect(recipeRowOrder()).toEqual([1, 2, 3]);
  });

  it("links each read-only recipe item identity to its matching base item", async () => {
    const user = userEvent.setup();
    render(<ProductDetail />);

    await user.click(screen.getByRole("tab", { name: "Recipe" }));

    await waitFor(() => {
      expect(screen.getByTestId("recipe-base-item-link-1")).toBeTruthy();
    });

    for (const item of MOCK_RECIPE) {
      const link = screen.getByTestId(`recipe-base-item-link-${item.base_item_id}`);
      expect(link).toHaveAttribute("href", `/base-items/${item.base_item_id}`);
      expect(link).toHaveTextContent(item.name);
      expect(link).toHaveClass("hover:bg-muted/60", "focus-visible:ring-2");
    }
  });

  it("links editable recipe item identities without taking over recipe controls", async () => {
    render(<ProductDetail />);
    await navigateToRecipeEditTab();

    await waitFor(() => {
      expect(screen.getByTestId("recipe-base-item-link-1")).toBeTruthy();
    });

    for (const item of MOCK_RECIPE) {
      expect(screen.getByTestId(`recipe-base-item-link-${item.base_item_id}`))
        .toHaveAttribute("href", `/base-items/${item.base_item_id}`);
    }
    expect(screen.getByTestId("recipe-drag-handle-1")).toBeTruthy();
    expect(screen.getByTestId("recipe-row-1").querySelector("input")).toBeTruthy();
    expect(screen.getByTestId("recipe-row-1").querySelector("button[title='Remove']")).toBeTruthy();
  });

  it("repositions a row correctly when dragged to a later position", async () => {
    render(<ProductDetail />);
    await navigateToRecipeEditTab();

    await waitFor(() => {
      expect(document.querySelector("[data-testid='recipe-row-1']")).toBeTruthy();
    });

    act(() => {
      capturedOnDragEnd!(makeDragEvent(1, 3));
    });

    expect(recipeRowOrder()).toEqual([2, 3, 1]);
  });

  it("repositions a row correctly when dragged to an earlier position", async () => {
    render(<ProductDetail />);
    await navigateToRecipeEditTab();

    await waitFor(() => {
      expect(document.querySelector("[data-testid='recipe-row-3']")).toBeTruthy();
    });

    act(() => {
      capturedOnDragEnd!(makeDragEvent(3, 1));
    });

    expect(recipeRowOrder()).toEqual([3, 1, 2]);
  });

  it("does not change row order when a row is dropped onto itself", async () => {
    render(<ProductDetail />);
    await navigateToRecipeEditTab();

    await waitFor(() => {
      expect(document.querySelector("[data-testid='recipe-row-1']")).toBeTruthy();
    });

    act(() => {
      capturedOnDragEnd!(makeDragEvent(2, 2));
    });

    expect(recipeRowOrder()).toEqual([1, 2, 3]);
  });

  it("enables the Save button after a row is dragged to a new position", async () => {
    render(<ProductDetail />);
    await navigateToRecipeEditTab();

    await waitFor(() => {
      expect(document.querySelector("[data-testid='recipe-row-1']")).toBeTruthy();
    });

    const saveButton = screen.getByRole("button", { name: "Save" });
    expect(saveButton).toBeDisabled();

    act(() => {
      capturedOnDragEnd!(makeDragEvent(1, 2));
    });

    expect(saveButton).not.toBeDisabled();
  });

  it("does not enable the Save button when a row is dropped on itself", async () => {
    render(<ProductDetail />);
    await navigateToRecipeEditTab();

    await waitFor(() => {
      expect(document.querySelector("[data-testid='recipe-row-1']")).toBeTruthy();
    });

    const saveButton = screen.getByRole("button", { name: "Save" });
    expect(saveButton).toBeDisabled();

    act(() => {
      capturedOnDragEnd!(makeDragEvent(1, 1));
    });

    expect(saveButton).toBeDisabled();
  });
});

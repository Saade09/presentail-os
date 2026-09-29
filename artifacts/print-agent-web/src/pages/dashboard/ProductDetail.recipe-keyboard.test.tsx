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

const INITIAL_RECIPE = [
  { base_item_id: 1, name: "Alpha", code: "A-01", image_url: null, quantity: "1" },
  { base_item_id: 2, name: "Beta", code: "B-02", image_url: null, quantity: "2" },
  { base_item_id: 3, name: "Gamma", code: "G-03", image_url: null, quantity: "3" },
];

// ---------------------------------------------------------------------------
// Captured drag handler + keyboard drag state machine
// ---------------------------------------------------------------------------

let capturedOnDragEnd: ((event: DragEndEvent) => void) | null = null;

/**
 * Keyboard drag state machine.
 * Mirrors what dnd-kit's KeyboardSensor does internally:
 *   Space → pick up the focused item
 *   ArrowDown / ArrowUp → shift the "over" position by one
 *   Space (again) → drop and emit onDragEnd
 *
 * `orderedIds` tracks the live sort order so ArrowDown always resolves to
 * the correct `over` id regardless of previous moves within the same render.
 */
let kbActiveId: number | null = null;
let kbOverIndex: number = -1;
let orderedIds: number[] = INITIAL_RECIPE.map((r) => r.base_item_id);

function resetKbState() {
  kbActiveId = null;
  kbOverIndex = -1;
  orderedIds = INITIAL_RECIPE.map((r) => r.base_item_id);
}

function makeKeyboardDragEvent(activeId: number, overId: number): DragEndEvent {
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
    activatorEvent: new KeyboardEvent("keydown", { code: "Space" }),
    collisions: [],
    delta: { x: 0, y: 0 },
  } as unknown as DragEndEvent;
}

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock("wouter", () => ({
  Link: ({ href, children }: { href: string; children: React.ReactNode }) => (
    <a href={href}>{children}</a>
  ),
  useParams: () => ({ id: "1" }),
  useLocation: () => ["/", vi.fn()],
}));

vi.mock("@tanstack/react-query", () => ({
  useQuery: (opts: { queryKey: unknown[]; enabled?: boolean }) => {
    const key = Array.isArray(opts.queryKey) ? opts.queryKey[0] : "";
    if (key === "product") {
      return {
        data: { product: MOCK_PRODUCT, recipe: INITIAL_RECIPE },
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
  SortableContext: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  sortableKeyboardCoordinates: vi.fn(),

  /**
   * useSortable mock with a real keyboard state machine.
   *
   * The `listeners` object returned here includes an `onKeyDown` handler that
   * simulates what dnd-kit's KeyboardSensor does:
   *   - Space on an idle handle  → set this item as the active drag item
   *   - ArrowDown while dragging → move the virtual "over" index one step down
   *   - ArrowUp while dragging   → move the virtual "over" index one step up
   *   - Space while dragging     → fire capturedOnDragEnd and reset state
   */
  useSortable: ({ id }: { id: number }) => ({
    attributes: { tabIndex: 0, role: "button", "aria-roledescription": "sortable" },
    listeners: {
      onKeyDown: (e: React.KeyboardEvent) => {
        if (e.code === "Space") {
          if (kbActiveId === null) {
            kbActiveId = id;
            kbOverIndex = orderedIds.indexOf(id);
            e.preventDefault();
          } else {
            const overId = orderedIds[kbOverIndex];
            capturedOnDragEnd?.(makeKeyboardDragEvent(kbActiveId, overId));
            resetKbState();
            e.preventDefault();
          }
        } else if (e.code === "ArrowDown" && kbActiveId !== null) {
          kbOverIndex = Math.min(kbOverIndex + 1, orderedIds.length - 1);
          e.preventDefault();
        } else if (e.code === "ArrowUp" && kbActiveId !== null) {
          kbOverIndex = Math.max(kbOverIndex - 1, 0);
          e.preventDefault();
        }
      },
    },
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

function recipeRowOrder(): number[] {
  return Array.from(
    document.querySelectorAll("[data-testid^='recipe-row-']"),
  ).map((el) =>
    parseInt((el as HTMLElement).dataset.testid!.replace("recipe-row-", ""), 10),
  );
}

function getDragHandle(itemId: number): HTMLElement {
  const el = document.querySelector(
    `[data-testid='recipe-drag-handle-${itemId}']`,
  ) as HTMLElement;
  if (!el) throw new Error(`Drag handle for item ${itemId} not found`);
  return el;
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

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("ProductDetail — keyboard-based drag reordering", () => {
  beforeEach(() => {
    capturedOnDragEnd = null;
    resetKbState();
    vi.clearAllMocks();
  });

  it("moves a row down one position via Space → ArrowDown → Space", async () => {
    render(<ProductDetail />);
    await navigateToRecipeEditTab();

    await waitFor(() => {
      expect(document.querySelector("[data-testid='recipe-row-1']")).toBeTruthy();
    });

    expect(recipeRowOrder()).toEqual([1, 2, 3]);

    const handle = getDragHandle(1);

    act(() => {
      handle.focus();
      fireEvent.keyDown(handle, { code: "Space" });
      fireEvent.keyDown(handle, { code: "ArrowDown" });
      fireEvent.keyDown(handle, { code: "Space" });
    });

    expect(recipeRowOrder()).toEqual([2, 1, 3]);
  });

  it("moves a row up one position via Space → ArrowUp → Space", async () => {
    render(<ProductDetail />);
    await navigateToRecipeEditTab();

    await waitFor(() => {
      expect(document.querySelector("[data-testid='recipe-row-3']")).toBeTruthy();
    });

    const handle = getDragHandle(3);

    act(() => {
      handle.focus();
      fireEvent.keyDown(handle, { code: "Space" });
      fireEvent.keyDown(handle, { code: "ArrowUp" });
      fireEvent.keyDown(handle, { code: "Space" });
    });

    expect(recipeRowOrder()).toEqual([1, 3, 2]);
  });

  it("moves a row two positions down via two ArrowDown presses", async () => {
    render(<ProductDetail />);
    await navigateToRecipeEditTab();

    await waitFor(() => {
      expect(document.querySelector("[data-testid='recipe-row-1']")).toBeTruthy();
    });

    const handle = getDragHandle(1);

    act(() => {
      handle.focus();
      fireEvent.keyDown(handle, { code: "Space" });
      fireEvent.keyDown(handle, { code: "ArrowDown" });
      fireEvent.keyDown(handle, { code: "ArrowDown" });
      fireEvent.keyDown(handle, { code: "Space" });
    });

    expect(recipeRowOrder()).toEqual([2, 3, 1]);
  });

  it("does not reorder when Space is pressed twice on the same position", async () => {
    render(<ProductDetail />);
    await navigateToRecipeEditTab();

    await waitFor(() => {
      expect(document.querySelector("[data-testid='recipe-row-2']")).toBeTruthy();
    });

    const handle = getDragHandle(2);

    act(() => {
      handle.focus();
      fireEvent.keyDown(handle, { code: "Space" });
      fireEvent.keyDown(handle, { code: "Space" });
    });

    expect(recipeRowOrder()).toEqual([1, 2, 3]);
  });

  it("enables Save button after keyboard drag moves a row", async () => {
    render(<ProductDetail />);
    await navigateToRecipeEditTab();

    await waitFor(() => {
      expect(document.querySelector("[data-testid='recipe-row-1']")).toBeTruthy();
    });

    const saveButton = screen.getByRole("button", { name: "Save" });
    expect(saveButton).toBeDisabled();

    const handle = getDragHandle(1);

    act(() => {
      handle.focus();
      fireEvent.keyDown(handle, { code: "Space" });
      fireEvent.keyDown(handle, { code: "ArrowDown" });
      fireEvent.keyDown(handle, { code: "Space" });
    });

    expect(saveButton).not.toBeDisabled();
  });

  it("ArrowDown at the last position does not move the row beyond the list", async () => {
    render(<ProductDetail />);
    await navigateToRecipeEditTab();

    await waitFor(() => {
      expect(document.querySelector("[data-testid='recipe-row-3']")).toBeTruthy();
    });

    const handle = getDragHandle(3);

    act(() => {
      handle.focus();
      fireEvent.keyDown(handle, { code: "Space" });
      fireEvent.keyDown(handle, { code: "ArrowDown" });
      fireEvent.keyDown(handle, { code: "Space" });
    });

    expect(recipeRowOrder()).toEqual([1, 2, 3]);
  });
});

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { useState } from "react";
import { SortableRecipeRow } from "./ProductDetail";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock("wouter", () => ({
  Link: ({ href, children }: { href: string; children: React.ReactNode }) => (
    <a href={href}>{children}</a>
  ),
  useParams: () => ({ workspaceSlug: "test-ws", productId: "1" }),
  useLocation: () => ["/", vi.fn()],
}));

vi.mock("@tanstack/react-query", () => ({
  useQuery: () => ({ data: undefined, isLoading: false }),
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
  useWorkspaceRole: () => ({ role: "owner", isOwner: true, canManage: true }),
}));

vi.mock("@dnd-kit/core", () => ({
  DndContext: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  closestCenter: vi.fn(),
  KeyboardSensor: class {},
  PointerSensor: class {},
  useSensor: vi.fn(),
  useSensors: vi.fn(() => []),
}));

vi.mock("@dnd-kit/sortable", () => ({
  SortableContext: ({ children }: { children: React.ReactNode }) => <>{children}</>,
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
  arrayMove: vi.fn(),
}));

vi.mock("@dnd-kit/utilities", () => ({
  CSS: {
    Transform: { toString: () => "" },
  },
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeItem(overrides: Partial<{
  base_item_id: number;
  name: string;
  code: string;
  image_url: string | null;
  quantity: string;
}> = {}) {
  return {
    base_item_id: 42,
    name: "Kraft Box",
    code: "KBX-01",
    image_url: null,
    quantity: "1",
    ...overrides,
  };
}

function RowWrapper({
  initialQty = "1",
  showError = false,
  canManage = true,
}: {
  initialQty?: string;
  showError?: boolean;
  canManage?: boolean;
}) {
  const [qty, setQty] = useState(initialQty);
  return (
    <table>
      <tbody>
        <SortableRecipeRow
          item={makeItem({ quantity: qty })}
          isLast={true}
          canManage={canManage}
          onQtyChange={setQty}
          onRemove={vi.fn()}
          showError={showError}
        />
      </tbody>
    </table>
  );
}

function MultiRowWrapper({
  rows,
  showError,
}: {
  rows: Array<{ id: number; qty: string }>;
  showError: boolean;
}) {
  const [items, setItems] = useState(
    rows.map((r) => makeItem({ base_item_id: r.id, quantity: r.qty })),
  );
  return (
    <table>
      <tbody>
        {items.map((item, idx) => (
          <SortableRecipeRow
            key={item.base_item_id}
            item={item}
            isLast={idx === items.length - 1}
            canManage={true}
            onQtyChange={(value) =>
              setItems((prev) =>
                prev.map((it, i) => (i === idx ? { ...it, quantity: value } : it)),
              )
            }
            onRemove={vi.fn()}
            showError={showError}
          />
        ))}
      </tbody>
    </table>
  );
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("SortableRecipeRow — quantity error message", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("does not show an error before the user has interacted with the field", () => {
    render(<RowWrapper initialQty="1" showError={false} />);
    expect(screen.queryByText("Must be greater than 0")).not.toBeInTheDocument();
  });

  it("does not show an error for a valid quantity even after the field is blurred", () => {
    render(<RowWrapper initialQty="5" showError={false} />);
    const input = screen.getByRole("spinbutton");
    fireEvent.blur(input);
    expect(screen.queryByText("Must be greater than 0")).not.toBeInTheDocument();
  });

  it("shows the error after blurring a field left blank", () => {
    render(<RowWrapper initialQty="" showError={false} />);
    const input = screen.getByRole("spinbutton");
    fireEvent.blur(input);
    expect(screen.getByText("Must be greater than 0")).toBeInTheDocument();
  });

  it("shows the error after blurring a field with a zero quantity", () => {
    render(<RowWrapper initialQty="0" showError={false} />);
    const input = screen.getByRole("spinbutton");
    fireEvent.blur(input);
    expect(screen.getByText("Must be greater than 0")).toBeInTheDocument();
  });

  it("shows the error after blurring a field with a negative quantity", () => {
    render(<RowWrapper initialQty="-3" showError={false} />);
    const input = screen.getByRole("spinbutton");
    fireEvent.blur(input);
    expect(screen.getByText("Must be greater than 0")).toBeInTheDocument();
  });

  it("shows the error immediately when showError is true (Save attempted) even without blurring", () => {
    render(<RowWrapper initialQty="0" showError={true} />);
    expect(screen.getByText("Must be greater than 0")).toBeInTheDocument();
  });

  it("shows the error for a blank quantity when showError is true, without requiring blur", () => {
    render(<RowWrapper initialQty="" showError={true} />);
    expect(screen.getByText("Must be greater than 0")).toBeInTheDocument();
  });

  it("does not show the error when showError is true but the quantity is valid", () => {
    render(<RowWrapper initialQty="2" showError={true} />);
    expect(screen.queryByText("Must be greater than 0")).not.toBeInTheDocument();
  });

  it("clears the error once a valid quantity is typed after blur", () => {
    render(<RowWrapper initialQty="0" showError={false} />);
    const input = screen.getByRole("spinbutton");

    fireEvent.blur(input);
    expect(screen.getByText("Must be greater than 0")).toBeInTheDocument();

    fireEvent.change(input, { target: { value: "3" } });
    expect(screen.queryByText("Must be greater than 0")).not.toBeInTheDocument();
  });

  it("clears the error once a valid quantity is typed even when showError is true", () => {
    render(<RowWrapper initialQty="-1" showError={true} />);
    expect(screen.getByText("Must be greater than 0")).toBeInTheDocument();

    const input = screen.getByRole("spinbutton");
    fireEvent.change(input, { target: { value: "5" } });
    expect(screen.queryByText("Must be greater than 0")).not.toBeInTheDocument();
  });

  it("does not show any error when canManage is false, even after blur with invalid quantity", () => {
    render(<RowWrapper initialQty="0" showError={false} canManage={false} />);
    const inputs = screen.queryAllByRole("spinbutton");
    if (inputs.length > 0) fireEvent.blur(inputs[0]);
    expect(screen.queryByText("Must be greater than 0")).not.toBeInTheDocument();
  });
});

describe("SortableRecipeRow — multi-row save-attempt error coverage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("shows an error on every invalid row when showError is true (all rows invalid)", () => {
    render(
      <MultiRowWrapper
        rows={[
          { id: 1, qty: "0" },
          { id: 2, qty: "" },
          { id: 3, qty: "-5" },
        ]}
        showError={true}
      />,
    );
    const errors = screen.getAllByText("Must be greater than 0");
    expect(errors).toHaveLength(3);
  });

  it("shows errors only on invalid rows and not on valid rows when showError is true", () => {
    render(
      <MultiRowWrapper
        rows={[
          { id: 1, qty: "0" },
          { id: 2, qty: "3" },
          { id: 3, qty: "-1" },
        ]}
        showError={true}
      />,
    );
    const errors = screen.getAllByText("Must be greater than 0");
    expect(errors).toHaveLength(2);
  });

  it("shows no errors when all rows are valid and showError is true", () => {
    render(
      <MultiRowWrapper
        rows={[
          { id: 1, qty: "1" },
          { id: 2, qty: "2.5" },
          { id: 3, qty: "10" },
        ]}
        showError={true}
      />,
    );
    expect(screen.queryByText("Must be greater than 0")).not.toBeInTheDocument();
  });

  it("shows no errors on any row before the user has interacted, even with invalid quantities", () => {
    render(
      <MultiRowWrapper
        rows={[
          { id: 1, qty: "0" },
          { id: 2, qty: "" },
        ]}
        showError={false}
      />,
    );
    expect(screen.queryByText("Must be greater than 0")).not.toBeInTheDocument();
  });
});

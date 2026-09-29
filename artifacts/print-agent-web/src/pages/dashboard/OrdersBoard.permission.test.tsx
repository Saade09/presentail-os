/**
 * Component-level coverage for the Board's drag permission gate.
 *
 * A full e2e "permission-blocked drag" scenario is unreachable through real
 * navigation: /orders itself is gated by PageGuard on the same "orders"
 * allowedPages flag that `canEditOrders` reads (see Orders.tsx), so any user
 * who can load the page already has drag permission. This test instead
 * verifies the actual mechanism directly: `useDraggable` receives
 * `disabled: true` for every card when `canEditOrders={false}`, and
 * `disabled: false` when `canEditOrders={true}` — matching the read-only
 * vs. editable split already used elsewhere on this page (e.g. the List
 * view's status cell).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render } from "@testing-library/react";
import { TooltipProvider } from "@/components/ui/tooltip";
import { OrdersBoard, type OrdersBoardQueryDeps } from "./OrdersBoard";
import type { OrderRow } from "./orderRowHelpers";

const MOCK_ORDER: OrderRow = {
  id: "ord-1",
  display_order_number: "1001",
  external_order_id: null,
  status: "processing",
  source: "native",
  channel: "website",
  ordered_at: "2026-08-26T08:00:00.000Z",
  delivery_type: "standard",
  window_start: "2026-08-26T10:00:00.000Z",
  window_end: "2026-08-26T12:00:00.000Z",
  created_at: "2026-08-26T08:00:00.000Z",
  delivery_address: { date: "2026-08-26", slot: "10:00 AM - 12:00 PM", district: "Achrafieh" },
  totals: { total: "80.00", currency: "USD" },
  contact_name: "Jane Doe",
  contact_email: null,
  contact_phone: null,
  payment_status: "paid",
  payment_method: "card",
  driver_first_name: null,
  driver_last_name: null,
  assignment_status: null,
  thumbnail_url: null,
  qr_link: null,
  delivery_date_review: null,
  workshop: null,
  delivered_at: null,
  delivery_timezone: "Asia/Beirut",
} as unknown as OrderRow;

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const capturedDraggableCalls: Array<{ id: string; disabled: boolean }> = [];

vi.mock("wouter", () => ({
  useLocation: () => ["/orders", vi.fn()],
}));

vi.mock("@tanstack/react-query", () => ({
  useQuery: () => ({
    data: { orders: [MOCK_ORDER], total: 1, limit: 200, offset: 0 },
    isLoading: false,
    isError: false,
    refetch: vi.fn(),
    isFetching: false,
  }),
  useMutation: () => ({ mutate: vi.fn(), isPending: false }),
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
}));

vi.mock("@/lib/queryClient", () => ({
  apiFetch: vi.fn(),
}));

vi.mock("@/hooks/use-toast", () => ({
  useToast: () => ({ toast: vi.fn() }),
}));

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

vi.mock("@dnd-kit/core", () => ({
  DndContext: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  DragOverlay: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  PointerSensor: class {},
  useSensor: vi.fn(),
  useSensors: vi.fn(() => []),
  useDraggable: ({ id, disabled }: { id: string; disabled?: boolean }) => {
    capturedDraggableCalls.push({ id: String(id), disabled: !!disabled });
    return {
      attributes: {},
      listeners: {},
      setNodeRef: vi.fn(),
      transform: null,
      isDragging: false,
    };
  },
  useDroppable: () => ({ setNodeRef: vi.fn(), isOver: false }),
}));

const baseProps = {
  isOwner: false,
  nowMs: new Date("2026-08-26T09:00:00.000Z").getTime(),
  queryDeps: {
    q: "",
    status: "all",
    source: "all",
    country: "all",
    attribution: "",
    deliveryDateKeys: [],
    tz: "UTC",
    slots: [],
  } satisfies OrdersBoardQueryDeps,
  matchesDriver: () => true,
  matchesChip: () => true,
  hasActiveFilters: false,
};

describe("OrdersBoard drag permission gate", () => {
  beforeEach(() => {
    capturedDraggableCalls.length = 0;
  });

  it("disables the draggable for every card when canEditOrders is false", () => {
    render(
      <TooltipProvider>
        <OrdersBoard {...baseProps} canEditOrders={false} />
      </TooltipProvider>,
    );
    expect(capturedDraggableCalls.length).toBeGreaterThan(0);
    expect(capturedDraggableCalls.every((c) => c.disabled === true)).toBe(true);
  });

  it("enables the draggable for cards when canEditOrders is true", () => {
    render(
      <TooltipProvider>
        <OrdersBoard {...baseProps} canEditOrders={true} />
      </TooltipProvider>,
    );
    expect(capturedDraggableCalls.length).toBeGreaterThan(0);
    expect(capturedDraggableCalls.every((c) => c.disabled === false)).toBe(true);
  });
});

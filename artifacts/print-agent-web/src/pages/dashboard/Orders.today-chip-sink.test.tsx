/**
 * Unit tests: finished orders sink to the bottom when the "Today" chip is
 * active, but the default server order is preserved without the chip.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock("wouter", () => ({
  Link: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  useSearch: () => "",
  useLocation: () => ["/orders", vi.fn()],
}));

vi.mock("@/lib/queryClient", () => ({
  apiFetch: vi.fn(),
}));

vi.mock("@clerk/react", () => ({
  useAuth: () => ({ userId: "test-user", isLoaded: true, isSignedIn: true }),
  useUser: () => ({ user: null, isLoaded: true }),
  ClerkProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

// Stub out the heavy create-order wizard – it has its own complex deps and
// isn't relevant to the ordering/grouping logic under test.
vi.mock("@/components/CreateOrderWizard", () => ({
  CreateOrderWizard: () => null,
}));

vi.mock("@/hooks/use-toast", () => ({
  useToast: () => ({ toast: vi.fn() }),
}));

vi.mock("@/hooks/use-workspace-role", () => ({
  useWorkspaceRole: () => ({ isOwner: true, allowedPages: null }),
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) => {
      if (key === "orders.paginationSummary" && opts) {
        return `Showing ${opts.from} to ${opts.to} of ${opts.total} orders`;
      }
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

let mockOrdersData: unknown = { orders: [], total: 0, limit: 50, offset: 0 };
type QueryCall = { queryKey: unknown[]; queryFn: () => Promise<unknown> };
const capturedQueryCalls: QueryCall[] = [];
vi.mock("@tanstack/react-query", () => ({
  useQuery: (opts: QueryCall) => {
    capturedQueryCalls.push(opts);
    return { data: mockOrdersData, isLoading: false };
  },
  useMutation: () => ({ mutate: vi.fn(), isPending: false }),
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
  keepPreviousData: (prev: unknown) => prev,
}));

import OrdersPage from "./Orders";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** ISO date string for today (local date, date-only, used by matchesChip). */
function todayDateString(): string {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function makeOrder(overrides: Record<string, unknown> = {}) {
  return {
    id: "order-1",
    display_order_number: "1001",
    external_order_id: null,
    status: "pending",
    source: "native",
    channel: null,
    ordered_at: "2025-01-05T00:00:00Z",
    window_start: null,
    window_end: null,
    created_at: "2025-01-01T00:00:00Z",
    totals: null,
    contact_name: "Jane Doe",
    contact_email: null,
    contact_phone: null,
    payment_status: null,
    driver_first_name: null,
    driver_last_name: null,
    assignment_status: null,
    delivery_address: null,
    ...overrides,
  };
}

function setOrders(orders: ReturnType<typeof makeOrder>[]) {
  mockOrdersData = { orders, total: orders.length, limit: 50, offset: 0 };
}

function lastOrdersQueryCall(): QueryCall | undefined {
  return capturedQueryCalls.findLast(
    (call) => Array.isArray(call.queryKey) && call.queryKey[0] === "orders",
  );
}

async function captureOrdersQueryParams(): Promise<URLSearchParams> {
  const { apiFetch } = await import("@/lib/queryClient");
  const mockApiFetch = vi.mocked(apiFetch);
  mockApiFetch.mockClear();
  await lastOrdersQueryCall()?.queryFn();
  const orderCall = mockApiFetch.mock.calls.find(
    ([url]) => typeof url === "string" && url.startsWith("/api/orders?"),
  );
  return new URLSearchParams(
    orderCall && typeof orderCall[0] === "string" ? orderCall[0].split("?")[1] : "",
  );
}

/**
 * Returns the top-to-bottom order of `data-testid="order-row-*"` elements as
 * an array of their id suffixes.
 */
function getRowOrder(): string[] {
  return Array.from(
    document.querySelectorAll("[data-testid^='order-row-']"),
  ).map((el) => el.getAttribute("data-testid")!.replace("order-row-", ""));
}

beforeEach(() => {
  vi.clearAllMocks();
  capturedQueryCalls.length = 0;
  localStorage.clear();
  mockOrdersData = { orders: [], total: 0, limit: 50, offset: 0 };
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("OrdersPage – Today chip sinks finished orders", () => {
  const today = todayDateString();
  const todaySchedule = { date: today, slot: "10:00 AM - 12:00 PM" };

  it("moves completed orders below active orders when the Today chip is on", async () => {
    const user = userEvent.setup();

    // Server returns: completed (index 0), then active (index 1) — server order
    // would put completed first.
    setOrders([
      makeOrder({
        id: "completed-1",
        display_order_number: "2001",
        status: "completed",
        delivery_address: todaySchedule,
      }),
      makeOrder({
        id: "active-1",
        display_order_number: "2002",
        status: "processing",
        delivery_address: todaySchedule,
      }),
    ]);

    render(<OrdersPage />);

    // Without any chip the server order is preserved (completed first).
    expect(getRowOrder()).toEqual(["completed-1", "active-1"]);

    // Activate the Today chip.
    await user.click(screen.getByRole("button", { name: "orders.chipToday" }));

    // Now active should precede completed.
    expect(getRowOrder()).toEqual(["active-1", "completed-1"]);
  });

  it("sinks all finished statuses (cancelled, refunded, delivered) below active ones", async () => {
    const user = userEvent.setup();

    setOrders([
      makeOrder({ id: "cancelled-1", status: "cancelled", delivery_address: todaySchedule }),
      makeOrder({ id: "refunded-1", status: "refunded", delivery_address: todaySchedule }),
      makeOrder({ id: "delivered-1", status: "delivered", delivery_address: todaySchedule }),
      makeOrder({ id: "active-1", status: "preparing", delivery_address: todaySchedule }),
      makeOrder({ id: "active-2", status: "out_for_delivery", delivery_address: todaySchedule }),
    ]);

    render(<OrdersPage />);
    await user.click(screen.getByRole("button", { name: "orders.chipToday" }));

    const order = getRowOrder();
    const activeIndexes = ["active-1", "active-2"].map((id) => order.indexOf(id));
    const finishedIndexes = ["cancelled-1", "refunded-1", "delivered-1"].map((id) =>
      order.indexOf(id),
    );

    // Every active order must appear before every finished order.
    expect(Math.max(...activeIndexes)).toBeLessThan(Math.min(...finishedIndexes));
  });

  it("preserves relative order within each group", async () => {
    const user = userEvent.setup();

    // Server order: active-2, completed-1, active-1, completed-2
    setOrders([
      makeOrder({ id: "active-2", status: "processing", delivery_address: todaySchedule }),
      makeOrder({ id: "completed-1", status: "completed", delivery_address: todaySchedule }),
      makeOrder({ id: "active-1", status: "preparing", delivery_address: todaySchedule }),
      makeOrder({ id: "completed-2", status: "completed", delivery_address: todaySchedule }),
    ]);

    render(<OrdersPage />);
    await user.click(screen.getByRole("button", { name: "orders.chipToday" }));

    // active group: server relative order preserved (active-2, active-1)
    // finished group: server relative order preserved (completed-1, completed-2)
    expect(getRowOrder()).toEqual(["active-2", "active-1", "completed-1", "completed-2"]);
  });

  it("restores server order when the Today chip is toggled off", async () => {
    const user = userEvent.setup();

    setOrders([
      makeOrder({ id: "completed-1", status: "completed", delivery_address: todaySchedule }),
      makeOrder({ id: "active-1", status: "processing", delivery_address: todaySchedule }),
    ]);

    render(<OrdersPage />);

    // Server order: completed first.
    expect(getRowOrder()).toEqual(["completed-1", "active-1"]);

    // Toggle chip on → active first.
    const chipBtn = screen.getByRole("button", { name: "orders.chipToday" });
    await user.click(chipBtn);
    expect(getRowOrder()).toEqual(["active-1", "completed-1"]);

    // Toggle chip off → back to server order.
    await user.click(chipBtn);
    expect(getRowOrder()).toEqual(["completed-1", "active-1"]);
  });

  it("sends Today to the server and uses its total for pagination", async () => {
    const user = userEvent.setup();
    const todayOrder = makeOrder({
      id: "today-match-after-page-one",
      delivery_address: todaySchedule,
    });
    mockOrdersData = { orders: [todayOrder], total: 101, limit: 50, offset: 0 };

    render(<OrdersPage />);

    // The server total enables pagination even though this fixture contains
    // only one row.
    await user.click(screen.getByRole("button", { name: "common.next" }));
    expect(lastOrdersQueryCall()?.queryKey.at(-1)).toBe(1);

    await user.click(screen.getByRole("button", { name: "orders.chipToday" }));
    expect(lastOrdersQueryCall()?.queryKey).toContain(true);
    expect(lastOrdersQueryCall()?.queryKey.at(-1)).toBe(0);

    const params = await captureOrdersQueryParams();
    expect(params.get("today")).toBe("true");
    expect(params.get("offset")).toBe("0");
    expect(screen.getByText("Showing 1 to 1 of 101 orders")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "common.next" })).toBeEnabled();

    await user.click(screen.getByRole("button", { name: "orders.chipToday" }));
    expect(lastOrdersQueryCall()?.queryKey).toContain(false);
    const clearedParams = await captureOrdersQueryParams();
    expect(clearedParams.has("today")).toBe(false);
  });

  it("preserves server order with no chip and no delivery-date filter active", () => {
    // No chip active → server order unchanged even if completed are first.
    setOrders([
      makeOrder({ id: "completed-1", status: "completed", window_start: new Date().toISOString() }),
      makeOrder({ id: "active-1", status: "processing", window_start: new Date().toISOString() }),
    ]);

    render(<OrdersPage />);

    expect(getRowOrder()).toEqual(["completed-1", "active-1"]);
  });
});

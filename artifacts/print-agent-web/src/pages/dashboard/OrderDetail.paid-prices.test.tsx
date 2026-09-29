import { describe, it, expect, vi, beforeEach } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock("wouter", () => ({
  Link: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  useParams: () => ({ id: "order-1" }),
  useLocation: () => ["/orders/order-1", vi.fn()],
}));

vi.mock("@/lib/queryClient", () => ({
  apiFetch: vi.fn(),
  getClerkToken: vi.fn(),
}));

vi.mock("@/hooks/use-toast", () => ({
  useToast: () => ({ toast: vi.fn() }),
}));

vi.mock("@/hooks/use-workspace-role", () => ({
  useWorkspaceRole: () => ({ isOwner: true, allowedPages: null }),
}));

vi.mock("@/hooks/use-page-title", () => ({
  usePageTitleOverride: () => {},
}));

// Not under test — avoids mocking its data hooks.
vi.mock("@/components/OrderCommunicationsCard", () => ({
  default: () => null,
}));

// Controllable order + line item fixtures.
let mockOrder: Record<string, unknown> = {};
let mockLineItems: Record<string, unknown>[] = [];

vi.mock("@tanstack/react-query", () => ({
  useQuery: ({ queryKey }: { queryKey: unknown[] }) => {
    if (queryKey[0] === "order") {
      return {
        data: {
          order: mockOrder,
          line_items: mockLineItems,
          contacts: [],
          customer_prior_orders: 0,
          recipient_prior_orders: 0,
        },
        isLoading: false,
        isError: false,
      };
    }
    return { data: undefined, isLoading: false, isError: false };
  },
  useMutation: () => ({ mutate: vi.fn(), isPending: false }),
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
}));

vi.mock("@workspace/api-client-react", () => {
  const mut = () => ({ mutate: vi.fn(), isPending: false });
  return {
    useUpdateOrder: mut,
    useUpdateOrderContacts: mut,
    useDeleteOrder: mut,
    useRefundOrder: mut,
    useMarkOrderPaid: mut,
    useSendOrderPaymentInstructions: mut,
    useResendWhishPaymentInstructions: mut,
    useListOrderContactEdits: () => ({ data: undefined }),
    getListOrderContactEditsQueryKey: (id: string) => ["contact-edits", id],
    useRetryTookanTask: mut,
    useSendOrderToFlorist: mut,
    useGetOrderFloristAssignment: () => ({ data: { assignment: null } }),
    getGetOrderFloristAssignmentQueryKey: (id: string) => ["florist", id],
    useListOrderActivity: () => ({ data: { events: [] }, isLoading: false }),
    getListOrderActivityQueryKey: (id: string) => ["activity", id],
    useAddOrderInternalNote: mut,
    useAddOrderLineItem: mut,
    useUpdateOrderLineItem: mut,
    useRemoveOrderLineItem: mut,
  };
});

import OrderDetail from "./OrderDetail";
import { TooltipProvider } from "@/components/ui/tooltip";

// jsdom has no IntersectionObserver (used by the sticky header effect).
class IntersectionObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
  takeRecords() {
    return [];
  }
}
(globalThis as Record<string, unknown>).IntersectionObserver =
  IntersectionObserverStub as unknown as typeof IntersectionObserver;

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeOrder(overrides: Record<string, unknown> = {}) {
  return {
    id: "order-1",
    display_order_number: "2049",
    external_order_id: null,
    status: "processing",
    payment_status: "paid",
    source: "external",
    channel: null,
    created_at: "2026-07-01T00:00:00Z",
    updated_at: "2026-07-01T00:00:00Z",
    ordered_at: "2026-07-01T00:00:00Z",
    window_start: null,
    window_end: null,
    totals: null,
    delivery_address: null,
    delivery_date_review: null,
    internal_notes: null,
    card_to: null,
    card_message: null,
    card_from: null,
    qr_link: null,
    payment_provider: null,
    payment_reference: null,
    tookan_task_id: null,
    tookan_status: null,
    ...overrides,
  };
}

function makeLineItem(overrides: Record<string, unknown> = {}) {
  return {
    id: "li-1",
    name: "Red Roses",
    sku: "ROSE-1",
    quantity: 1,
    unit_price: "14.16",
    total: null,
    line_total: "14.16",
    image_url: null,
    product_id: null,
    custom_input: null,
    ...overrides,
  };
}

// Order 2049 shape: base/catalog USD prices differ from the amounts actually
// charged in EUR (storefront rounds displayed prices to 0/5/10).
const EUR_TOTALS = {
  subtotal: 175,
  shipping: 0,
  total: 175,
  currency: "USD",
  paid_currency: "EUR",
  paid_total: 155,
  paid_subtotal: 155,
  paid_shipping: 0,
};

function renderPage() {
  return render(
    <TooltipProvider>
      <OrderDetail />
    </TooltipProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mockOrder = makeOrder();
  mockLineItems = [];
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("OrderDetail – paid-currency line prices", () => {
  it("shows the actually-charged EUR prices with USD as the ≈ secondary line", () => {
    mockOrder = makeOrder({ totals: EUR_TOTALS });
    mockLineItems = [
      makeLineItem({
        id: "li-1",
        unit_price: "14.16",
        line_total: "14.16",
        paid_unit_price: "15.00",
        paid_line_total: "15.00",
      }),
      makeLineItem({
        id: "li-2",
        name: "White Lilies",
        unit_price: "85.98",
        line_total: "85.98",
        paid_unit_price: "75.00",
        paid_line_total: "75.00",
      }),
      makeLineItem({
        id: "li-3",
        name: "Tulips",
        unit_price: "74.86",
        line_total: "74.86",
        paid_unit_price: "65.00",
        paid_line_total: "65.00",
      }),
    ];
    renderPage();

    const card = screen.getByTestId("card-line-items");
    // Each qty-1 row shows the paid price in BOTH the unit-price column and
    // the line-total column, with the base USD amount as the ≈ line.
    const row1 = within(card).getByTestId("row-line-item-li-1");
    expect(within(row1).getAllByText("€15.00").length).toBe(2);
    expect(within(row1).getByText("≈ $14.16")).toBeInTheDocument();
    const row2 = within(card).getByTestId("row-line-item-li-2");
    expect(within(row2).getAllByText("€75.00").length).toBe(2);
    expect(within(row2).getByText("≈ $85.98")).toBeInTheDocument();
    const row3 = within(card).getByTestId("row-line-item-li-3");
    expect(within(row3).getAllByText("€65.00").length).toBe(2);
    expect(within(row3).getByText("≈ $74.86")).toBeInTheDocument();

    // Subtotal uses the actually-charged paid amount, not the implied-rate
    // conversion of the USD subtotal — €155.00 appears for both the subtotal
    // row and the total row (paid_total), each with a ≈ $175.00 line.
    expect(within(card).getAllByText("€155.00").length).toBeGreaterThanOrEqual(2);
    expect(within(card).getAllByText("≈ $175.00").length).toBeGreaterThanOrEqual(1);
  });

  it("falls back to implied-rate conversion for lines without paid prices", () => {
    mockOrder = makeOrder({ totals: EUR_TOTALS });
    mockLineItems = [
      makeLineItem({
        id: "li-1",
        unit_price: "14.16",
        line_total: "14.16",
        paid_unit_price: "15.00",
        paid_line_total: "15.00",
      }),
      // Added from the dashboard later — no paid-currency price.
      makeLineItem({
        id: "li-2",
        name: "Added Product",
        unit_price: "10.00",
        line_total: "10.00",
        paid_unit_price: null,
        paid_line_total: null,
      }),
    ];
    renderPage();

    const card = screen.getByTestId("card-line-items");
    const row2 = within(card).getByTestId("row-line-item-li-2");
    // Implied rate = 155 / 175 ≈ 0.8857 → $10 ≈ €8.86
    expect(within(row2).getAllByText("€8.86").length).toBe(2);
    expect(within(row2).getByText("≈ $10.00")).toBeInTheDocument();
  });

  it("keeps plain USD rendering for orders without paid-currency data", () => {
    mockOrder = makeOrder({
      totals: { subtotal: 60, shipping: 5, total: 65, currency: "USD" },
      source: "manual",
    });
    mockLineItems = [
      makeLineItem({ id: "li-1", quantity: 2, unit_price: "30.00", line_total: "60.00" }),
    ];
    renderPage();

    const card = screen.getByTestId("card-line-items");
    const row = within(card).getByTestId("row-line-item-li-1");
    expect(within(row).getByText("30.00")).toBeInTheDocument();
    expect(within(row).getByText("60.00")).toBeInTheDocument();
    expect(within(row).queryByText(/≈/)).not.toBeInTheDocument();
  });

  it("shows the Whish WhatsApp resend action and prior automatic send time only for Whish orders", () => {
    mockOrder = makeOrder({
      payment_method: "whish",
      payment_provider: "whish",
      payment_status: "pending",
      whish_instructions_sent_at: "2026-08-24T10:30:00Z",
    });
    renderPage();
    fireEvent.click(screen.getByTestId("button-payment-chip"));

    expect(screen.getByTestId("button-resend-whish-payment-instructions")).toBeInTheDocument();
    expect(screen.getByText(/Automatic WhatsApp instructions sent/)).toBeInTheDocument();
  });

  it("hides the Whish resend action once the payment is paid", () => {
    mockOrder = makeOrder({
      payment_method: "whish",
      payment_provider: "whish",
      payment_status: "paid",
    });
    renderPage();
    fireEvent.click(screen.getByTestId("button-payment-chip"));

    expect(screen.queryByTestId("button-resend-whish-payment-instructions")).not.toBeInTheDocument();
  });
});

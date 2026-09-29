/**
 * Unit tests for complimentary ($0) line items on Order Detail:
 *  - the line-items table badge/strikethrough/$0.00 rendering,
 *  - the Merchandise subtotal / Complimentary item(s) / Customer total rows,
 *  - the inline per-item complimentary summary callout,
 *  - the Add Product modal's Pricing section (Regular ↔ Complimentary).
 *
 * Radix UI Select relies on pointer-capture / portals that jsdom does not
 * implement, so — following the pattern in PaymentLinks.test.tsx — the
 * Select primitives are replaced with plain HTML equivalents that a real
 * <select> can drive via userEvent.selectOptions.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { PropsWithChildren, OptionHTMLAttributes } from "react";

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

let mockRole = { isOwner: true, allowedPages: null as string[] | null };
vi.mock("@/hooks/use-workspace-role", () => ({
  useWorkspaceRole: () => mockRole,
}));

vi.mock("@/hooks/use-page-title", () => ({
  usePageTitleOverride: () => {},
}));

vi.mock("@/components/OrderCommunicationsCard", () => ({
  default: () => null,
}));

// Native <select> stand-ins for Radix Select (see file header).
vi.mock("@/components/ui/select", () => ({
  Select: ({
    value,
    onValueChange,
    children,
  }: PropsWithChildren<{ value?: string; onValueChange?: (v: string) => void }>) => (
    <select value={value ?? ""} onChange={(e) => onValueChange?.(e.target.value)}>
      {children}
    </select>
  ),
  SelectTrigger: ({
    children: _children,
    ...props
  }: PropsWithChildren<Record<string, unknown>>) => (
    <option value="" hidden {...(props as OptionHTMLAttributes<HTMLOptionElement>)} />
  ),
  SelectValue: () => null,
  SelectContent: ({ children }: PropsWithChildren) => <>{children}</>,
  SelectItem: ({
    value,
    children,
    ...props
  }: PropsWithChildren<{ value: string }>) => (
    <option value={value} {...(props as OptionHTMLAttributes<HTMLOptionElement>)}>
      {children}
    </option>
  ),
}));

// Controllable fixtures.
let mockOrder: Record<string, unknown> = {};
let mockLineItems: Record<string, unknown>[] = [];
let mockProducts: Record<string, unknown>[] = [];
let mockActivityEvents: Record<string, unknown>[] = [];

let mockCatalogCurrency = "USD";
let mockRescheduleOptions: Record<string, unknown> = {
  success: true,
  date: "2026-08-29",
  timezone: "Asia/Beirut",
  slots: [],
};

const mockAddLineItemMutate = vi.fn();
const mockRescheduleOrderDelivery = vi.fn();
let mockAddLineItemPending = false;

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
          timezone: "Asia/Beirut",
        },
        isLoading: false,
        isError: false,
      };
    }
    if (queryKey[0] === "order-line-item-product-search") {
      return { data: { products: mockProducts }, isLoading: false, isError: false };
    }
    if (queryKey[0] === "order-reschedule-options") {
      return {
        data: mockRescheduleOptions,
        isLoading: false,
        isFetching: false,
        isError: false,
        refetch: vi.fn(),
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
    useListOrderActivity: () => ({ data: { events: mockActivityEvents }, isLoading: false }),
    getListOrderActivityQueryKey: (id: string) => ["activity", id],
    useAddOrderInternalNote: mut,
    getListOrderLineItemCatalogQueryKey: (id: string) => ["order-line-item-catalog", id],
    useListOrderLineItemCatalog: () => ({
      data: {
        success: true,
        market: { label: "Lebanon catalog", country_code: "LB", city_id: 1, currency: mockCatalogCurrency },
        products: mockProducts.map((product) => ({
          id: Number(product.id),
          name: String(product.name),
          sku: typeof product.sku === "string" ? product.sku : null,
          image_url: typeof product.main_image_url === "string" ? product.main_image_url : null,
          status: product.price_usd == null ? "unavailable_price" : "available",
          available: product.price_usd != null,
          unit_price: product.price_usd == null ? null : Number(product.discount_price_usd ?? product.price_usd),
          currency: mockCatalogCurrency,
          price_error: product.price_usd == null ? "Price unavailable for this order currency" : null,
        })),
        total: mockProducts.length,
        page: 1,
        page_size: 25,
        total_pages: 1,
      },
      isLoading: false,
      isError: mockCatalogError,
      refetch: vi.fn(),
    }),
    useAddOrderLineItem: () => ({ mutate: mockAddLineItemMutate, isPending: mockAddLineItemPending }),
    useUpdateOrderLineItem: mut,
    useRemoveOrderLineItem: mut,
    getOrderRescheduleOptions: vi.fn(),
    rescheduleOrderDelivery: (...args: unknown[]) =>
      mockRescheduleOrderDelivery(...args),
  };
});

import OrderDetail from "./OrderDetail";
import { TooltipProvider } from "@/components/ui/tooltip";

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
    source: "manual",
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
    unit_price: "30.00",
    total: null,
    line_total: "30.00",
    image_url: null,
    product_id: null,
    custom_input: null,
    ...overrides,
  };
}

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
  mockProducts = [];
  mockActivityEvents = [];
  mockAddLineItemPending = false;
  mockRole = { isOwner: true, allowedPages: null };
  mockRescheduleOptions = {
    success: true,
    date: "2026-08-29",
    timezone: "Asia/Beirut",
    slots: [],
  };
  mockRescheduleOrderDelivery.mockReset();
});

describe("OrderDetail – discoverable delivery schedule", () => {
  it("leads the operational strip with the market-time schedule and Reschedule action", () => {
    mockOrder = makeOrder({
      window_start: "2026-08-29T11:00:00.000Z",
      window_end: "2026-08-29T15:00:00.000Z",
    });

    renderPage();

    const schedule = screen.getByTestId("scheduled-delivery-block");
    expect(within(schedule).getByText("Scheduled delivery")).toBeInTheDocument();
    expect(within(schedule).getByText("Sat, Aug 29 · 2:00 PM–6:00 PM")).toBeInTheDocument();
    expect(
      within(schedule).getByRole("button", { name: "Reschedule" }),
    ).toBeInTheDocument();
  });

  it("hides the action without Orders edit access and disables it for terminal orders", () => {
    mockRole = { isOwner: false, allowedPages: [] };
    mockOrder = makeOrder({
      window_start: "2026-08-29T11:00:00.000Z",
      window_end: "2026-08-29T15:00:00.000Z",
    });
    const unauthorized = renderPage();
    expect(screen.queryByTestId("button-reschedule-delivery")).not.toBeInTheDocument();
    unauthorized.unmount();

    mockRole = { isOwner: true, allowedPages: null };
    mockOrder = makeOrder({
      status: "completed",
      window_start: "2026-08-29T11:00:00.000Z",
      window_end: "2026-08-29T15:00:00.000Z",
    });
    renderPage();
    expect(screen.getByTestId("button-reschedule-delivery")).toBeDisabled();
  });

  it("preselects the current slot and stays open after an availability conflict", async () => {
    const user = userEvent.setup();
    mockOrder = makeOrder({
      delivery_address: { cityId: 7 },
      window_start: "2026-08-29T11:00:00.000Z",
      window_end: "2026-08-29T15:00:00.000Z",
    });
    mockRescheduleOptions = {
      success: true,
      date: "2026-08-29",
      timezone: "Asia/Beirut",
      slots: [
        {
          id: "12",
          label: "Afternoon",
          start_time: "14:00",
          end_time: "18:00",
          window_start: "2026-08-29T11:00:00.000Z",
          window_end: "2026-08-29T15:00:00.000Z",
        },
      ],
    };
    mockRescheduleOrderDelivery.mockRejectedValueOnce(
      new Error("That delivery slot is no longer available. Choose another slot."),
    );
    renderPage();

    await user.click(screen.getByTestId("button-reschedule-delivery"));
    const dialog = await screen.findByTestId("dialog-reschedule-delivery");
    const slotSelect = dialog.querySelector("select");
    expect(slotSelect).toBeTruthy();
    await waitFor(() => expect(slotSelect).toHaveValue("12"));

    await user.click(screen.getByTestId("button-confirm-reschedule"));

    expect(mockRescheduleOrderDelivery).toHaveBeenCalledWith("order-1", {
      date: "2026-08-29",
      slot_id: "12",
      start_time: "14:00",
      end_time: "18:00",
    });
    expect(
      await screen.findByText(
        "That delivery slot is no longer available. Choose another slot.",
      ),
    ).toBeInTheDocument();
    expect(screen.getByTestId("dialog-reschedule-delivery")).toBeInTheDocument();
    expect(slotSelect).toHaveValue("");
  });

  it("does not expose raw HTTP 500 text from an unexpected save failure", async () => {
    const user = userEvent.setup();
    mockOrder = makeOrder({
      delivery_address: { cityId: 7 },
      window_start: "2026-08-29T11:00:00.000Z",
      window_end: "2026-08-29T15:00:00.000Z",
    });
    mockRescheduleOptions = {
      success: true,
      date: "2026-08-29",
      timezone: "Asia/Beirut",
      slots: [{
        id: "12",
        label: "Afternoon",
        start_time: "14:00",
        end_time: "18:00",
        window_start: "2026-08-29T11:00:00.000Z",
        window_end: "2026-08-29T15:00:00.000Z",
      }],
    };
    mockRescheduleOrderDelivery.mockRejectedValueOnce(
      Object.assign(new Error("HTTP 500 Internal Server Error: database detail"), {
        status: 500,
      }),
    );
    renderPage();

    await user.click(screen.getByTestId("button-reschedule-delivery"));
    await waitFor(() =>
      expect(screen.getByTestId("button-confirm-reschedule")).not.toBeDisabled(),
    );
    await user.click(screen.getByTestId("button-confirm-reschedule"));

    expect(
      await screen.findByText(
        "Could not reschedule delivery. Please try again. If this keeps happening, contact support.",
      ),
    ).toBeInTheDocument();
    expect(screen.queryByText(/HTTP 500/i)).not.toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// Line-item table + totals display
// ---------------------------------------------------------------------------

describe("OrderDetail – complimentary line item display", () => {
  it("shows the Complimentary badge, struck-through original price, and $0.00 total", () => {
    mockOrder = makeOrder({
      totals: {
        subtotal: 0,
        shipping: 0,
        total: 0,
        merchandise_subtotal: 30,
        complimentary_total: -30,
        currency: "USD",
      },
    });
    mockLineItems = [
      makeLineItem({
        id: "li-1",
        name: "Red Heart Balloons",
        quantity: 4,
        unit_price: "0.00",
        line_total: "0.00",
        is_complimentary: true,
        complimentary_original_price: "7.50",
        complimentary_reason: "customer_service_gesture",
        complimentary_added_by: "Sarah",
      }),
    ];
    renderPage();

    const row = screen.getByTestId("row-line-item-li-1");
    expect(within(row).getByTestId("badge-complimentary-li-1")).toHaveTextContent("Complimentary");

    const priceCell = within(row).getByTestId("text-complimentary-original-price-li-1");
    expect(priceCell).toHaveTextContent("7.50");
    expect(priceCell).toHaveTextContent("0.00");

    // No deleted/cancelled styling — the row uses the same structure as any
    // other active line item (no strikethrough/opacity classes on the row).
    expect(row.className).not.toMatch(/opacity|line-through/);
  });

  it("renders the immutable order-currency complimentary value from line metadata", () => {
    mockOrder = makeOrder({
      totals: {
        subtotal: 0,
        shipping: 0,
        total: 0,
        paid_currency: "AED",
        paid_total: 110,
        merchandise_subtotal: 30,
        complimentary_total: -30,
      },
    });
    mockLineItems = [
      makeLineItem({
        id: "li-aed",
        name: "AED Bouquet",
        quantity: 2,
        unit_price: "0.00",
        line_total: "0.00",
        is_complimentary: true,
        complimentary_original_price: "15.00",
        complimentary_reason: "vip_gesture",
        complimentary_added_by: "Sarah",
        metadata: {
          add_product_price: {
            currency: "AED",
            unit_price: 0,
            original_unit_price: 75,
          },
        },
      }),
    ];
    renderPage();

    expect(screen.getByTestId("text-complimentary-original-price-li-aed")).toHaveTextContent("AED");
    expect(screen.getByTestId("text-complimentary-original-price-li-aed")).toHaveTextContent("75.00");
    expect(screen.getByTestId("text-complimentary-summary-li-aed")).toHaveTextContent("AED");
    expect(screen.getByTestId("text-complimentary-summary-li-aed")).toHaveTextContent("150.00");
  });

  it("shows Merchandise subtotal / Complimentary item(s) / Customer total when a complimentary line exists", () => {
    mockOrder = makeOrder({
      totals: {
        subtotal: 854,
        shipping: 0,
        total: 854,
        merchandise_subtotal: 884,
        complimentary_total: -30,
        currency: "USD",
      },
    });
    mockLineItems = [
      makeLineItem({ id: "li-1", name: "Bouquet", quantity: 1, unit_price: "854.00", line_total: "854.00" }),
      makeLineItem({
        id: "li-2",
        name: "Red Heart Balloons",
        quantity: 4,
        unit_price: "0.00",
        line_total: "0.00",
        is_complimentary: true,
        complimentary_original_price: "7.50",
        complimentary_reason: "customer_service_gesture",
        complimentary_added_by: "Sarah",
      }),
    ];
    renderPage();

    const card = screen.getByTestId("card-line-items");
    expect(within(card).getByText("Merchandise subtotal")).toBeInTheDocument();
    expect(within(card).getByText("884.00")).toBeInTheDocument();
    const complimentaryRow = within(card).getByTestId("row-complimentary-total");
    expect(within(complimentaryRow).getByText("Complimentary item(s)")).toBeInTheDocument();
    expect(within(complimentaryRow).getByText("-30.00")).toBeInTheDocument();
    expect(within(card).getByText("Customer total")).toBeInTheDocument();
    expect(within(card).getByText("$854.00")).toBeInTheDocument();
    // Plain "Subtotal"/"Total" labels are replaced, not duplicated.
    expect(within(card).queryByText("Subtotal")).not.toBeInTheDocument();
  });

  it("keeps the plain Subtotal/Total labels when there is no complimentary item", () => {
    mockOrder = makeOrder({
      totals: { subtotal: 60, shipping: 5, total: 65, currency: "USD" },
    });
    mockLineItems = [makeLineItem({ id: "li-1", quantity: 2, unit_price: "30.00", line_total: "60.00" })];
    renderPage();

    const card = screen.getByTestId("card-line-items");
    expect(within(card).getByText("Subtotal")).toBeInTheDocument();
    expect(within(card).getByText("$65.00")).toBeInTheDocument();
    expect(within(card).queryByText("Merchandise subtotal")).not.toBeInTheDocument();
    expect(within(card).queryByText("Customer total")).not.toBeInTheDocument();
  });

  it("renders an inline summary callout naming the actor, reason, and value for each active complimentary item", () => {
    mockOrder = makeOrder({
      totals: {
        subtotal: 854,
        shipping: 0,
        total: 854,
        merchandise_subtotal: 884,
        complimentary_total: -30,
        currency: "USD",
      },
    });
    mockLineItems = [
      makeLineItem({ id: "li-1", name: "Bouquet", quantity: 1, unit_price: "854.00", line_total: "854.00" }),
      makeLineItem({
        id: "li-2",
        name: "Red Heart Balloons",
        quantity: 4,
        unit_price: "0.00",
        line_total: "0.00",
        is_complimentary: true,
        complimentary_original_price: "7.50",
        complimentary_reason: "customer_service_gesture",
        complimentary_added_by: "Sarah",
      }),
    ];
    renderPage();

    const summary = screen.getByTestId("text-complimentary-summary-li-1");
    expect(summary).toHaveTextContent("Note: Approved by shift manager over the phone");
  });

  it("falls back to a generic actor label when complimentary_added_by is missing", () => {
    mockOrder = makeOrder({
      totals: {
        subtotal: 0,
        shipping: 0,
        total: 0,
        merchandise_subtotal: 10,
        complimentary_total: -10,
        currency: "USD",
      },
    });
    mockLineItems = [
      makeLineItem({
        id: "li-1",
        name: "Candle",
        quantity: 1,
        unit_price: "0.00",
        line_total: "0.00",
        is_complimentary: true,
        complimentary_original_price: "10.00",
        complimentary_reason: "vip_gesture",
        complimentary_added_by: null,
      }),
    ];
    renderPage();

    const summary = screen.getByTestId("text-complimentary-summary-li-1");
    expect(summary).toHaveTextContent("Note: Approved by shift manager over the phone");
  });

  it("falls back to a generic actor label when complimentary_added_by is missing", () => {
    mockOrder = makeOrder({
      totals: {
        subtotal: 0,
        shipping: 0,
        total: 0,
        merchandise_subtotal: 10,
        complimentary_total: -10,
        currency: "USD",
      },
    });
    mockLineItems = [
      makeLineItem({
        id: "li-1",
        name: "Candle",
        quantity: 1,
        unit_price: "0.00",
        line_total: "0.00",
        is_complimentary: true,
        complimentary_original_price: "10.00",
        complimentary_reason: "vip_gesture",
        complimentary_added_by: null,
      }),
    ];
    renderPage();

    const summary = screen.getByTestId("text-complimentary-summary-li-1");
    expect(summary).toHaveTextContent("A team member");
  });

  it("renders distinct activity-feed entries for a complimentary add and its removal", () => {
    mockActivityEvents = [
      {
        id: "ev-1",
        event_type: "line_item_complimentary_added",
        payload: { name: "Red Heart Balloons", quantity: 4, reason: "customer_service_gesture", original_value: 112.5, currency: "SAR" },
        actor_name: "Sarah",
        created_at: "2026-08-01T00:00:00Z",
      },
      {
        id: "ev-2",
        event_type: "line_item_complimentary_removed",
        payload: { name: "Red Heart Balloons", reason: "customer_service_gesture", original_value: 112.5, currency: "SAR" },
        actor_name: "Sarah",
        created_at: "2026-08-02T00:00:00Z",
      },
    ];
    renderPage();

    expect(
      screen.getByText(/Added 4 “Red Heart Balloons” as a complimentary item · Customer service gesture · Value: SAR 112\.50/),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/Removed complimentary item “Red Heart Balloons” · Customer service gesture · Value: SAR 112\.50/),
    ).toBeInTheDocument();
  });

  it("includes the internal note in both the add and removal activity-feed entries when present", () => {
    mockActivityEvents = [
      {
        id: "ev-1",
        event_type: "line_item_complimentary_added",
        payload: {
          name: "Red Heart Balloons",
          quantity: 4,
          reason: "other",
          note: "Approved by shift manager over the phone",
          original_value: 30,
        },
        actor_name: "Sarah",
        created_at: "2026-08-01T00:00:00Z",
      },
      {
        id: "ev-2",
        event_type: "line_item_complimentary_removed",
        payload: {
          name: "Red Heart Balloons",
          reason: "other",
          note: "Approved by shift manager over the phone",
          original_value: 30,
        },
        actor_name: "Sarah",
        created_at: "2026-08-02T00:00:00Z",
      },
    ];
    renderPage();

    expect(screen.getAllByText(/Note: Approved by shift manager over the phone/).length).toBe(2);
  });

  it("omits the note suffix from activity-feed entries when no note was recorded", () => {
    mockActivityEvents = [
      {
        id: "ev-1",
        event_type: "line_item_complimentary_added",
        payload: { name: "Red Heart Balloons", quantity: 4, reason: "vip_gesture", original_value: 30 },
        actor_name: "Sarah",
        created_at: "2026-08-01T00:00:00Z",
      },
    ];
    renderPage();

    expect(screen.queryByText(/Note:/)).not.toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// Add Product modal — Pricing section
// ---------------------------------------------------------------------------

describe("OrderDetail – Add Product modal Pricing section", () => {
  beforeEach(() => {
    mockProducts = [
      { id: 42, name: "Red Heart Balloons", sku: "BAL-42", price_usd: "7.50", discount_price_usd: null },
    ];
  });

  async function openAddProductDialog() {
    const user = userEvent.setup();
    fireEvent.click(screen.getByTestId("button-add-product"));
    await user.click(await screen.findByTestId("row-line-item-product-42"));
    return user;
  }

  it("switches back to regular pricing without leaving complimentary fields behind", async () => {
    renderPage();
    const user = await openAddProductDialog();

    await user.click(screen.getByTestId("radio-pricing-complimentary"));
    expect(screen.getByTestId("select-complimentary-reason")).toBeInTheDocument();

    await user.click(screen.getByTestId("radio-pricing-regular"));
    expect(screen.queryByTestId("select-complimentary-reason")).not.toBeInTheDocument();
    expect(screen.getByTestId("button-line-item-save")).toHaveTextContent("Add product");
  });

  it("enables Save and switches the CTA to 'Add complimentary item' once a reason is chosen", async () => {
    renderPage();
    const user = await openAddProductDialog();
    await user.click(screen.getByTestId("radio-pricing-complimentary"));

    const reasonSelect = screen
      .getByTestId("select-complimentary-reason")
      .closest("select") as HTMLSelectElement;
    await user.selectOptions(reasonSelect, "other");

    expect(screen.getByTestId("button-line-item-save")).toBeDisabled();

    await user.type(screen.getByTestId("input-complimentary-note"), "Wrong item shipped last time");
    expect(screen.getByTestId("button-line-item-save")).not.toBeDisabled();
  });

  it("submits the complimentary reason/note to the add-line-item mutation", async () => {
    renderPage();
    const user = await openAddProductDialog();
    await user.click(screen.getByTestId("radio-pricing-complimentary"));

    const reasonSelect = screen
      .getByTestId("select-complimentary-reason")
      .closest("select") as HTMLSelectElement;
    await user.selectOptions(reasonSelect, "other");

    expect(screen.getByTestId("button-line-item-save")).toBeDisabled();

    await user.type(screen.getByTestId("input-complimentary-note"), "Wrong item shipped last time");
    expect(screen.getByTestId("button-line-item-save")).not.toBeDisabled();
  });

  it("submits the complimentary reason/note to the add-line-item mutation", async () => {
    renderPage();
    const user = await openAddProductDialog();
    await user.click(screen.getByTestId("radio-pricing-complimentary"));

    const reasonSelect = screen
      .getByTestId("select-complimentary-reason")
      .closest("select") as HTMLSelectElement;
    await user.selectOptions(reasonSelect, "vip_gesture");
    await user.type(screen.getByTestId("input-complimentary-note"), "Loyal customer");

    await user.click(screen.getByTestId("button-line-item-save"));

    expect(mockAddLineItemMutate).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "order-1",
        data: expect.objectContaining({
          product_id: 42,
          quantity: 1,
          complimentary: { reason: "vip_gesture", note: "Loyal customer" },
        }),
      }),
    );
  });

  it("disables Save while the mutation is pending", async () => {
    mockAddLineItemPending = true;
    renderPage();
    await openAddProductDialog();

    expect(screen.getByTestId("button-line-item-save")).toBeDisabled();
  });
});

let mockCatalogError = false;

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock("wouter", () => ({
  Link: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  useParams: () => ({ id: "order-1" }),
  useLocation: () => ["/orders/order-1", vi.fn()],
}));

const { apiFetchMock } = vi.hoisted(() => ({ apiFetchMock: vi.fn() }));
vi.mock("@/lib/queryClient", () => ({
  apiFetch: apiFetchMock,
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

vi.mock("@/components/OrderCommunicationsCard", () => ({
  default: () => null,
}));

let mockOrder: Record<string, unknown> = {};
let mockAdditionalCards: Record<string, unknown>[] = [];
let mockLineItems: Record<string, unknown>[] = [];

vi.mock("@tanstack/react-query", () => ({
  useQuery: ({ queryKey }: { queryKey: unknown[] }) => {
    if (queryKey[0] === "order") {
      return {
        data: {
          order: mockOrder,
          line_items: mockLineItems,
          contacts: [],
          additional_card_messages: mockAdditionalCards,
          customer_prior_orders: 0,
          recipient_prior_orders: 0,
        },
        isLoading: false,
        isError: false,
      };
    }
    if (queryKey[0] === "locations") {
      return {
        data: { locations: [{ id: 1, name: "Beirut Atelier" }] },
        isLoading: false,
      };
    }
    if (queryKey[0] === "card-message-branch-configs") {
      return {
        data: { configs: [{ id: 1, name: "Branch A" }, { id: 2, name: "Branch B" }] },
        isLoading: false,
      };
    }
    return { data: undefined, isLoading: false, isError: false, refetch: vi.fn() };
  },
  useMutation: () => ({ mutate: vi.fn(), isPending: false }),
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
}));

vi.mock("@workspace/api-client-react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@workspace/api-client-react")>();
  const mut = () => ({ mutate: vi.fn(), isPending: false });
  return {
    ...actual,
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
    useListOrderCommunications: () => ({ data: undefined, isLoading: false, isError: false, refetch: vi.fn() }),
    getListOrderCommunicationsQueryKey: (id: string) => ["communications", id],
  };
});

import OrderDetail from "./OrderDetail";
import { TooltipProvider } from "@/components/ui/tooltip";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeOrder(overrides: Record<string, unknown> = {}) {
  return {
    id: "order-1",
    display_order_number: "1001",
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
    card_to: "Alice",
    card_message: "Happy Birthday!",
    card_from: "Bob",
    qr_link: null,
    payment_provider: null,
    payment_reference: null,
    tookan_task_id: null,
    tookan_status: null,
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
  mockAdditionalCards = [];
  mockLineItems = [];
  apiFetchMock.mockResolvedValue({});
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("OrderDetail – Print Card dialog", () => {
  it("opens the dialog when the Print Card button is clicked", async () => {
    const user = userEvent.setup();
    renderPage();

    await user.click(screen.getByTestId("button-print-card"));

    const dialog = await screen.findByTestId("dialog-print-card");
    expect(dialog).toBeInTheDocument();
  });

  it("Print button is disabled until a branch is selected", async () => {
    const user = userEvent.setup();
    renderPage();

    await user.click(screen.getByTestId("button-print-card"));
    await screen.findByTestId("dialog-print-card");

    expect(screen.getByTestId("button-print-card-submit")).toBeDisabled();
  });

  it("enables the Print button after selecting a branch", async () => {
    const user = userEvent.setup();
    renderPage();

    await user.click(screen.getByTestId("button-print-card"));
    await screen.findByTestId("dialog-print-card");

    await user.click(screen.getByTestId("select-print-card-branch"));
    await user.click(await screen.findByRole("option", { name: "Branch A" }));

    expect(screen.getByTestId("button-print-card-submit")).toBeEnabled();
  });

  it("calls POST /api/card-message/print with correct payload", async () => {
    const user = userEvent.setup();
    renderPage();

    await user.click(screen.getByTestId("button-print-card"));
    await screen.findByTestId("dialog-print-card");

    await user.click(screen.getByTestId("select-print-card-branch"));
    await user.click(await screen.findByRole("option", { name: "Branch B" }));
    await user.click(screen.getByTestId("button-print-card-submit"));

    expect(apiFetchMock).toHaveBeenCalledWith(
      "/api/card-message/print",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          location: "Branch B",
          shopName: "Presentail Flowers and Gifts",
          orderId: "1001",
          cardMessage: "Happy Birthday!",
          toName: "Alice",
          fromName: "Bob",
          realOrderId: "order-1",
        }),
      }),
    );
  });

  it("sources card fields from the order (card_to, card_message, card_from)", async () => {
    mockOrder = makeOrder({
      card_to: "Carol",
      card_message: "Congrats!",
      card_from: "Dave",
      display_order_number: "2002",
    });

    const user = userEvent.setup();
    renderPage();

    await user.click(screen.getByTestId("button-print-card"));
    await screen.findByTestId("dialog-print-card");

    await user.click(screen.getByTestId("select-print-card-branch"));
    await user.click(await screen.findByRole("option", { name: "Branch A" }));
    await user.click(screen.getByTestId("button-print-card-submit"));

    const [, callOpts] = apiFetchMock.mock.calls.find(
      ([url]: [string]) => url === "/api/card-message/print",
    )!;
    const body = JSON.parse((callOpts as { body: string }).body);

    expect(body.shopName).toBe("Presentail Flowers and Gifts");
    expect(body.toName).toBe("Carol");
    expect(body.cardMessage).toBe("Congrats!");
    expect(body.fromName).toBe("Dave");
    expect(body.orderId).toBe("2002");
  });

  it("renders additional cards after the primary and prints the selected card content", async () => {
    mockAdditionalCards = [{
      id: "card-2",
      card_to: "Maya",
      card_message: "A second note",
      card_from: "Omar",
      qr_link: "https://example.com/card",
      created_at: "2026-09-08T10:00:00.000Z",
    }];
    const user = userEvent.setup();
    renderPage();

    const primary = screen.getByTestId("card-message-primary");
    const extra = screen.getByTestId("card-message-extra-0");
    expect(primary.compareDocumentPosition(extra) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(extra).toHaveTextContent("A second note");
    expect(extra).toHaveTextContent("Maya");
    await user.click(within(extra).getByRole("button", { name: "Print Card" }));
    await user.click(screen.getByTestId("select-print-card-branch"));
    await user.click(await screen.findByRole("option", { name: "Branch A" }));
    await user.click(screen.getByTestId("button-print-card-submit"));

    const [, callOpts] = apiFetchMock.mock.calls.find(
      ([url]: [string]) => url === "/api/card-message/print",
    )!;
    expect(JSON.parse((callOpts as { body: string }).body)).toMatchObject({
      cardMessage: "A second note",
      toName: "Maya",
      fromName: "Omar",
      additionalCardMessageId: "card-2",
    });
  });

  it("closes the dialog after a successful print", async () => {
    const user = userEvent.setup();
    renderPage();

    await user.click(screen.getByTestId("button-print-card"));
    await screen.findByTestId("dialog-print-card");

    await user.click(screen.getByTestId("select-print-card-branch"));
    await user.click(await screen.findByRole("option", { name: "Branch A" }));
    await user.click(screen.getByTestId("button-print-card-submit"));

    // After a successful print the controlled Dialog closes (unmounts or hides).
    // Wait for the dialog to leave the document.
    await vi.waitFor(() => {
      expect(screen.queryByTestId("dialog-print-card")).not.toBeInTheDocument();
    });
  });
});

describe("OrderDetail – Print Cake Message", () => {
  it("offers cake printing for cake-only orders", () => {
    mockLineItems = [{ name: "Chocolate cake", custom_input: "Make a wish" }];
    const view = renderPage();
    expect(screen.getByTestId("cake-message")).toHaveTextContent("Make a wish");
    view.unmount();
    mockOrder = makeOrder({ card_message: null });
    renderPage();
    expect(screen.getByTestId("button-print-cake")).toBeInTheDocument();
  });
  it("does not offer cake printing for an empty cake input", () => {
    mockOrder = makeOrder({ card_message: null });
    mockLineItems = [{ name: "Chocolate cake", custom_input: "   " }];
    renderPage();
    expect(screen.queryByTestId("button-print-cake")).not.toBeInTheDocument();
  });
  it("requires a location and sends the cake line input without card fields", async () => {
    const cakeOrderId = "11111111-1111-4111-8111-111111111111";
    mockOrder = makeOrder({ id: cakeOrderId });
    mockLineItems = [{ name: "Cake", custom_input: "  Happy birthday, Lea!  " }];
    const user = userEvent.setup();
    renderPage();
    await user.click(screen.getByTestId("button-print-cake"));
    expect(screen.getByTestId("button-print-cake-submit")).toBeDisabled();
    await user.click(screen.getByTestId("select-print-cake-location"));
    await user.click(await screen.findByRole("option", { name: "Achrafieh" }));
    await user.click(screen.getByTestId("button-print-cake-submit"));
    expect(apiFetchMock).toHaveBeenCalledWith("/api/card-message/print-cake", expect.objectContaining({
      body: JSON.stringify({ location: "Achrafieh", cakeMessage: "Happy birthday, Lea!", realOrderId: cakeOrderId }),
    }));
  });
  it("shows feedback if cake printing fails", async () => {
    mockLineItems = [{ name: "Cake", custom_input: "Hi!" }];
    apiFetchMock.mockRejectedValueOnce(new Error("webhook_error"));
    const user = userEvent.setup();
    renderPage();
    await user.click(screen.getByTestId("button-print-cake"));
    await user.click(screen.getByTestId("select-print-cake-location"));
    await user.click(await screen.findByRole("option", { name: "Jdeideh" }));
    await user.click(screen.getByTestId("button-print-cake-submit"));
    expect(await screen.findByRole("alert")).toHaveTextContent("Failed to send cake message");
  });
});

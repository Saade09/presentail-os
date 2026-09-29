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

vi.mock("@/lib/queryClient", () => ({
  apiFetch: vi.fn(),
  getClerkToken: vi.fn(),
}));

vi.mock("@/hooks/use-toast", () => ({
  useToast: () => ({ toast: vi.fn() }),
}));

const { mockUseWorkspaceRole } = vi.hoisted(() => ({
  mockUseWorkspaceRole: vi.fn(),
}));

vi.mock("@/hooks/use-workspace-role", () => ({
  useWorkspaceRole: () => mockUseWorkspaceRole(),
}));

vi.mock("@/hooks/use-page-title", () => ({
  usePageTitleOverride: () => {},
}));

vi.mock("@/components/OrderCommunicationsCard", () => ({
  default: () => null,
}));

// Controllable order + assignment fixtures.
let mockOrder: Record<string, unknown> = {};
let mockAssignment: Record<string, unknown> | null = null;
let mockContacts: Record<string, unknown>[] = [];

const advanceMutate = vi.fn();
const invalidateQueries = vi.fn();
vi.mock("@tanstack/react-query", () => ({
  useQuery: ({ queryKey }: { queryKey: unknown[] }) => {
    if (queryKey[0] === "order") {
      return {
        data: {
          order: mockOrder,
          line_items: [],
          contacts: mockContacts,
          customer_prior_orders: 0,
          recipient_prior_orders: 0,
        },
        isLoading: false,
        isError: false,
      };
    }
    if (queryKey[0] === "locations") {
      return {
        data: {
          locations: [
            { id: 1, name: "Beirut Atelier" },
            { id: 2, name: "Dubai Studio" },
          ],
        },
        isLoading: false,
      };
    }
    if (queryKey[0] === "roles") {
      return {
        data: {
          roles: [{ id: 42, name: "Ops 2" }],
        },
        isLoading: false,
      };
    }
    return { data: undefined, isLoading: false, isError: false };
  },
  useMutation: () => ({ mutate: advanceMutate, isPending: false }),
  useQueryClient: () => ({ invalidateQueries }),
}));

const sendToFloristMutate = vi.fn();
const unassignFloristMutate = vi.fn();
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
    useSendOrderToFlorist: () => ({
      mutate: sendToFloristMutate,
      isPending: false,
    }),
    useRemoveOrderFloristAssignment: () => ({
      mutate: unassignFloristMutate,
      isPending: false,
    }),
    useUpdateOrderFloristPublication: mut,
    useGetOrderFloristAssignment: () => ({
      data: { assignment: mockAssignment },
    }),
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

function renderPage() {
  return render(
    <TooltipProvider>
      <OrderDetail />
    </TooltipProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mockUseWorkspaceRole.mockReturnValue({
    isOwner: true,
    role: "owner",
    allowedPages: null,
    customRoleIds: [],
  });
  mockOrder = makeOrder();
  mockAssignment = null;
  mockContacts = [];
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("OrderDetail – Mark as Preparing asks for florist location", () => {
  it("opens the linked recipient profile in Respond.io", () => {
    mockContacts = [
      {
        role: "recipient",
        contact_id: "contact-1",
        display_name: "Recipient",
        first_name: null,
        last_name: null,
        email: null,
        phone: "+961 70 123 456",
        respondio_contact_id: "respondio-42",
        respondio_url: "https://app.respond.io/space/12345/inbox/respondio-42",
      },
    ];

    renderPage();

    const link = screen.getByTestId("button-whatsapp-recipient");
    expect(link).toHaveAttribute(
      "href",
      "https://app.respond.io/space/12345/inbox/respondio-42",
    );
    expect(link).toHaveAttribute("target", "_blank");
    expect(document.querySelector('a[href*="wa.me"]')).not.toBeInTheDocument();
  });

  it("shows a disabled unavailable state when Respond.io is not linked", () => {
    mockContacts = [
      {
        role: "recipient",
        contact_id: "contact-1",
        display_name: "Recipient",
        first_name: null,
        last_name: null,
        email: null,
        phone: "+961 70 123 456",
        respondio_contact_id: null,
        respondio_url: null,
      },
    ];

    renderPage();

    expect(screen.getByTestId("button-whatsapp-recipient-unavailable")).toBeDisabled();
    expect(screen.queryByTestId("button-whatsapp-recipient")).not.toBeInTheDocument();
    expect(document.querySelector('a[href*="wa.me"]')).not.toBeInTheDocument();
  });

  it("opens the florist-location dialog instead of PATCHing the status", async () => {
    const user = userEvent.setup();
    renderPage();

    await user.click(screen.getByTestId("button-advance-status"));

    // No bare status change was fired.
    expect(advanceMutate).not.toHaveBeenCalled();
    // The florist dialog opened, in "Mark as Preparing" mode.
    const dialog = await screen.findByTestId("dialog-send-to-florist");
    expect(dialog).toBeInTheDocument();
    expect(within(dialog).getByText("Mark as Preparing")).toBeInTheDocument();
    // Confirm is disabled until a location is chosen.
    expect(screen.getByTestId("button-confirm-send-to-florist")).toBeDisabled();
  });

  it("lets the user pick a location and confirms via send-to-florist", async () => {
    const user = userEvent.setup();
    renderPage();

    await user.click(screen.getByTestId("button-advance-status"));
    await user.click(screen.getByTestId("select-florist-location"));
    await user.click(await screen.findByRole("option", { name: "Dubai Studio" }));
    await user.click(screen.getByTestId("button-confirm-send-to-florist"));

    expect(sendToFloristMutate).toHaveBeenCalledTimes(1);
    expect(sendToFloristMutate.mock.calls[0][0]).toEqual({
      id: "order-1",
      data: { locationId: 2 },
    });
    expect(advanceMutate).not.toHaveBeenCalled();
  });

  it("pre-selects the current florist assignment", async () => {
    mockAssignment = {
      id: 9,
      order_id: "order-1",
      location_id: 1,
      location_name: "Beirut Atelier",
      status: "pending",
    };
    const user = userEvent.setup();
    renderPage();

    await user.click(screen.getByTestId("button-advance-status"));

    // With the assignment pre-selected the confirm button is enabled and
    // confirming re-sends to the same location.
    const confirm = screen.getByTestId("button-confirm-send-to-florist");
    expect(confirm).toBeEnabled();
    await user.click(confirm);
    expect(sendToFloristMutate).toHaveBeenCalledTimes(1);
    expect(sendToFloristMutate.mock.calls[0][0]).toEqual({
      id: "order-1",
      data: { locationId: 1 },
    });
  });

  it("confirms florist unassignment and refreshes assignment, order, list, and activity", async () => {
    mockAssignment = {
      id: 9,
      order_id: "order-1",
      location_id: 1,
      location_name: "Beirut Atelier",
      status: "in_progress",
    };
    unassignFloristMutate.mockImplementation(
      (
        _variables: unknown,
        options?: { onSuccess?: () => void },
      ) => options?.onSuccess?.(),
    );
    const user = userEvent.setup();
    renderPage();

    await user.click(screen.getByTestId("button-unassign-florist"));
    expect(screen.getByTestId("dialog-unassign-florist")).toBeInTheDocument();
    expect(unassignFloristMutate).not.toHaveBeenCalled();

    await user.click(screen.getByTestId("button-confirm-unassign-florist"));

    expect(unassignFloristMutate).toHaveBeenCalledWith(
      { id: "order-1" },
      expect.objectContaining({
        onSuccess: expect.any(Function),
        onError: expect.any(Function),
      }),
    );
    expect(invalidateQueries).toHaveBeenCalledWith({
      queryKey: ["florist", "order-1"],
    });
    expect(invalidateQueries).toHaveBeenCalledWith({
      queryKey: ["order", "order-1"],
    });
    expect(invalidateQueries).toHaveBeenCalledWith({ queryKey: ["orders"] });
    expect(invalidateQueries).toHaveBeenCalledWith({
      queryKey: ["activity", "order-1"],
    });
  });

  it("advances other transitions directly without a dialog", async () => {
    mockOrder = makeOrder({ status: "preparing" });
    const user = userEvent.setup();
    renderPage();

    await user.click(screen.getByTestId("button-advance-status"));

    expect(advanceMutate).toHaveBeenCalledWith("ready_for_delivery");
    expect(
      screen.queryByTestId("dialog-send-to-florist"),
    ).not.toBeInTheDocument();
  });

  it("lets an authorized user choose any status for a refunded order", async () => {
    mockOrder = makeOrder({ status: "refunded", payment_status: "refunded" });
    const user = userEvent.setup();
    renderPage();

    await user.click(screen.getByTestId("select-refunded-order-status"));
    await user.click(
      await screen.findByRole("option", { name: /completed/i }),
    );

    expect(advanceMutate).toHaveBeenCalledWith("completed");
  });

  it("shows the delete action to an Ops 2 member with Orders-page access", async () => {
    mockUseWorkspaceRole.mockReturnValue({
      isOwner: false,
      role: "member",
      allowedPages: ["orders"],
      customRoleIds: [42],
    });
    const user = userEvent.setup();
    renderPage();

    await user.click(screen.getByTestId("button-more-actions"));

    expect(
      await screen.findByRole("menuitem", { name: /delete order/i }),
    ).toBeInTheDocument();
  });
});

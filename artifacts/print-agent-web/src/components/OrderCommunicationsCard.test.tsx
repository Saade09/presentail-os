import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock("@/hooks/use-toast", () => ({
  useToast: () => ({ toast: vi.fn() }),
}));

vi.mock("@/hooks/use-authed-sse", () => ({
  useAuthedSse: vi.fn(),
}));

let mockListResult: {
  data: unknown;
  isLoading: boolean;
  isError: boolean;
  refetch: () => void;
} = { data: undefined, isLoading: false, isError: false, refetch: vi.fn() };

const sendMutate = vi.fn();

vi.mock("@tanstack/react-query", () => ({
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
}));

vi.mock("@workspace/api-client-react", () => ({
  useListOrderCommunications: () => mockListResult,
  getListOrderCommunicationsQueryKey: (id: string) => ["comms", id],
  useSendOrderCommunication: () => ({ mutate: sendMutate, isPending: false }),
  useListOrderActivity: () => ({ data: { events: [] }, isLoading: false }),
  getListOrderActivityQueryKey: (id: string) => ["activity", id],
}));

import OrderCommunicationsCard, {
  commStatusBadgeClass,
} from "./OrderCommunicationsCard";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeComm(overrides: Record<string, unknown> = {}) {
  return {
    id: "c1",
    templateType: "order_confirmation",
    templateName: null,
    channel: "email",
    recipientRole: "customer",
    recipientName: "Jane",
    recipientEmail: "jane@example.com",
    recipientPhone: null,
    subject: "Your order",
    provider: "resend",
    providerMessageId: "re_1",
    status: "delivered",
    attempt: 1,
    failureReason: null,
    triggeredByName: null,
    createdAt: "2026-07-17T09:00:00Z",
    sentAt: "2026-07-17T09:00:01Z",
    deliveredAt: "2026-07-17T09:00:05Z",
    openedAt: null,
    clickedAt: null,
    lastEventAt: "2026-07-17T09:00:05Z",
    events: [
      { eventType: "sent", rawType: "email.sent", occurredAt: "2026-07-17T09:00:01Z" },
      { eventType: "delivered", rawType: "email.delivered", occurredAt: "2026-07-17T09:00:05Z" },
    ],
    ...overrides,
  };
}

function setData(
  communications: unknown[],
  customerEmail: string | null = "jane@example.com",
  whatsappEligible = false,
) {
  mockListResult = {
    data: {
      success: true,
      customerEmail,
      customerName: "Jane",
      customerPhone: "+96170123456",
      whatsappEligible,
      communications,
    },
    isLoading: false,
    isError: false,
    refetch: vi.fn(),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  setData([]);
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("commStatusBadgeClass", () => {
  it("uses green for sent/delivered/opened/clicked", () => {
    expect(commStatusBadgeClass("sent")).toContain("green");
    expect(commStatusBadgeClass("delivered")).toContain("green");
    expect(commStatusBadgeClass("opened")).toContain("green");
    expect(commStatusBadgeClass("clicked")).toContain("green");
  });
  it("uses red for failure states", () => {
    for (const s of ["failed", "bounced", "dropped", "suppressed"]) {
      expect(commStatusBadgeClass(s)).toContain("red");
    }
  });
  it("uses amber for deferred and neutral otherwise", () => {
    expect(commStatusBadgeClass("deferred")).toContain("amber");
    expect(commStatusBadgeClass("not_sent")).toContain("secondary");
  });
});

describe("OrderCommunicationsCard", () => {
  it("shows the empty state when there are no communications", () => {
    render(<OrderCommunicationsCard orderId="o1" canEdit={true} />);
    expect(screen.getByTestId("comms-empty")).toBeInTheDocument();
  });

  it("shows loading state", () => {
    mockListResult = { data: undefined, isLoading: true, isError: false, refetch: vi.fn() };
    render(<OrderCommunicationsCard orderId="o1" canEdit={true} />);
    expect(screen.queryByTestId("comms-empty")).not.toBeInTheDocument();
  });

  it("shows error state", () => {
    mockListResult = { data: undefined, isLoading: false, isError: true, refetch: vi.fn() };
    render(<OrderCommunicationsCard orderId="o1" canEdit={true} />);
    expect(screen.getByTestId("comms-error")).toBeInTheDocument();
  });

  it("renders rows with recipient email and status badge", () => {
    setData([makeComm()]);
    render(<OrderCommunicationsCard orderId="o1" canEdit={true} />);
    expect(screen.getByTestId("row-comm-c1")).toBeInTheDocument();
    expect(screen.getByTestId("badge-comm-status-c1")).toBeInTheDocument();
    expect(screen.getAllByText("jane@example.com").length).toBeGreaterThan(0);
  });

  it("renders an accepted WhatsApp row with phone and approved template on desktop and mobile", () => {
    setData([
      makeComm({
        id: "wa-ready",
        channel: "whatsapp",
        templateType: "status_update",
        templateName: "order_ready",
        recipientEmail: null,
        recipientPhone: "+96170123456",
        provider: "respondio",
        providerMessageId: "rio-42",
        status: "accepted",
        subject: null,
        triggeredByName: "Maya",
      }),
    ]);

    render(<OrderCommunicationsCard orderId="o1" canEdit={true} />);

    expect(screen.getByTestId("row-comm-wa-ready")).toHaveTextContent("WhatsApp");
    expect(screen.getByTestId("row-comm-wa-ready")).toHaveTextContent("+96170123456");
    expect(screen.getByTestId("row-comm-wa-ready")).toHaveTextContent("Accepted by respond.io");
    expect(screen.getAllByTestId("text-comm-whatsapp-template-wa-ready")).toHaveLength(2);
  });

  it("shows each status update subject in desktop and mobile views with attempt context", () => {
    setData([
      makeComm({
        id: "c-status-out",
        templateType: "status_update",
        subject: "Your order is out for delivery",
      }),
      makeComm({
        id: "c-status-ready",
        templateType: "status_update",
        subject: "Your order is ready for delivery",
        attempt: 2,
      }),
    ]);
    render(<OrderCommunicationsCard orderId="o1" canEdit={true} />);

    for (const id of ["c-status-out", "c-status-ready"]) {
      const contexts = screen.getAllByTestId(`text-comm-context-${id}`);
      expect(contexts).toHaveLength(2);
      const subject =
        id === "c-status-out"
          ? "Your order is out for delivery"
          : "Your order is ready for delivery";
      expect(contexts.map((context) => context.textContent)).toEqual([subject, subject]);
    }
    expect(screen.getByTestId("row-comm-c-status-ready")).toHaveTextContent(/attempt 2/i);
  });

  it("uses a clear fallback for status updates without a recorded subject", () => {
    setData([
      makeComm({
        id: "c-status-no-subject",
        templateType: "status_update",
        subject: null,
      }),
    ]);
    render(<OrderCommunicationsCard orderId="o1" canEdit={true} />);

    const contexts = screen.getAllByTestId("text-comm-context-c-status-no-subject");
    expect(contexts).toHaveLength(2);
    expect(contexts[0]).toHaveTextContent("Status update email");
    expect(screen.getByTestId("row-comm-c-status-no-subject")).toHaveTextContent("Status update");
  });

  it("shows header counts when communications exist", () => {
    setData([
      makeComm(),
      makeComm({ id: "c2", status: "failed", templateType: "refund" }),
    ]);
    render(<OrderCommunicationsCard orderId="o1" canEdit={true} />);
    expect(screen.getByTestId("text-comms-accepted-count")).toBeInTheDocument();
    expect(screen.getByTestId("text-comms-problem-count")).toBeInTheDocument();
  });

  it("hides the send button when canEdit is false", () => {
    setData([makeComm()]);
    render(<OrderCommunicationsCard orderId="o1" canEdit={false} />);
    expect(screen.queryByTestId("button-comms-send-message")).not.toBeInTheDocument();
  });

  it("sends directly from the Send message menu when an email is on file", async () => {
    const user = userEvent.setup();
    setData([makeComm()]);
    render(<OrderCommunicationsCard orderId="o1" canEdit={true} />);
    await user.click(screen.getByTestId("button-comms-send-message"));
    await user.click(await screen.findByTestId("menu-send-payment_received"));
    expect(sendMutate).toHaveBeenCalledTimes(1);
    const args = sendMutate.mock.calls[0][0];
    expect(args).toEqual({
      id: "o1",
      data: { templateType: "payment_received" },
    });
  });

  it("sends only the approved WhatsApp template to the linked opted-in customer", async () => {
    const user = userEvent.setup();
    setData([makeComm()], "jane@example.com", true);
    render(
      <OrderCommunicationsCard
        orderId="o1"
        canEdit={true}
        orderStatus="ready_for_delivery"
      />,
    );

    await user.click(screen.getByTestId("button-comms-send-message"));
    await user.click(await screen.findByTestId("menu-send-whatsapp-status_update"));

    expect(sendMutate.mock.calls[0][0]).toEqual({
      id: "o1",
      data: { templateType: "status_update", channel: "whatsapp" },
    });
  });

  it("opens the add-email dialog instead when no email is on file", async () => {
    const user = userEvent.setup();
    setData([makeComm({ recipientEmail: null, status: "not_sent" })], null);
    render(<OrderCommunicationsCard orderId="o1" canEdit={true} />);
    await user.click(screen.getByTestId("button-comms-send-message"));
    await user.click(await screen.findByTestId("menu-send-order_confirmation"));
    expect(sendMutate).not.toHaveBeenCalled();
    expect(await screen.findByTestId("input-comm-add-email")).toBeInTheDocument();
    await user.type(screen.getByTestId("input-comm-add-email"), "new@x.com");
    await user.click(screen.getByTestId("button-comm-add-email-send"));
    expect(sendMutate).toHaveBeenCalledTimes(1);
    expect(sendMutate.mock.calls[0][0]).toEqual({
      id: "o1",
      data: { templateType: "order_confirmation", email: "new@x.com" },
    });
  });

  it("resends with communicationId from the row actions menu", async () => {
    const user = userEvent.setup();
    setData([makeComm()]);
    render(<OrderCommunicationsCard orderId="o1" canEdit={true} />);
    await user.click(screen.getByTestId("button-comm-actions-c1"));
    await user.click(await screen.findByTestId("menu-resend-c1"));
    expect(sendMutate).toHaveBeenCalledTimes(1);
    expect(sendMutate.mock.calls[0][0]).toEqual({
      id: "o1",
      data: {
        templateType: "order_confirmation",
        communicationId: "c1",
        channel: "email",
      },
    });
  });

  it("opens the details drawer with event history on row click", async () => {
    const user = userEvent.setup();
    setData([makeComm()]);
    render(<OrderCommunicationsCard orderId="o1" canEdit={true} />);
    await user.click(screen.getByTestId("row-comm-c1"));
    expect(await screen.findByTestId("button-drawer-resend")).toBeInTheDocument();
    expect(screen.getByText("re_1")).toBeInTheDocument();
    expect(screen.getByText("Your order")).toBeInTheDocument();
  });
});

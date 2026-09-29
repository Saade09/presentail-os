import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import i18n from "@/i18n";
import FloristOrdersPage from "./FloristOrders";
import { apiFetch } from "@/lib/queryClient";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockSetQueriesData = vi.fn();
const mockInvalidateQueries = vi.fn();

vi.mock("@tanstack/react-query", () => ({
  useQuery: () => ({ data: undefined }),
  useQueryClient: () => ({
    invalidateQueries: mockInvalidateQueries,
    setQueriesData: mockSetQueriesData,
  }),
}));

vi.mock("@/lib/queryClient", () => ({
  apiFetch: vi.fn(),
  getClerkToken: vi.fn().mockResolvedValue(null),
}));

const mockToast = vi.fn();
vi.mock("@/hooks/use-toast", () => ({
  useToast: () => ({ toast: mockToast }),
}));

const mockUseWorkspaceRole = vi.fn();
vi.mock("@/hooks/use-workspace-role", () => ({
  useWorkspaceRole: () => mockUseWorkspaceRole(),
}));

const mockListFloristOrders = vi.fn();
const mockListFloristManualReviews = vi.fn();
const mockApproveMutate = vi.fn();
const mockUnassignMutate = vi.fn();

vi.mock("@workspace/api-client-react", () => ({
  useListFloristOrders: (...args: unknown[]) => mockListFloristOrders(...args),
  getListFloristOrdersQueryKey: () => ["florist-orders"],
  useListFloristManualReviews: (...args: unknown[]) => mockListFloristManualReviews(...args),
  getListFloristManualReviewsQueryKey: () => ["florist-manual-reviews"],
  getGetFloristManualReviewCountQueryKey: () => ["florist-manual-reviews", "count"],
  useApproveFloristManualReview: () => ({ mutate: mockApproveMutate, isPending: false }),
  useSetFloristOrderPhoto: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useRemoveFloristOrderPhoto: () => ({ mutate: vi.fn(), isPending: false }),
  useVerifyFloristOrder: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useStartFloristOrder: () => ({ mutate: vi.fn(), isPending: false }),
  usePauseFloristOrder: () => ({ mutate: vi.fn(), isPending: false }),
  useCompleteFloristOrder: () => ({ mutate: vi.fn(), isPending: false }),
  useRemoveOrderFloristAssignment: () => ({
    mutate: mockUnassignMutate,
    isPending: false,
  }),
  getGetOrderFloristAssignmentQueryKey: (id: string) => [
    "florist-assignment",
    id,
  ],
  getListOrderActivityQueryKey: (id: string) => ["order-activity", id],
}));

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeReview(overrides: Record<string, unknown> = {}) {
  return {
    id: 101,
    order_id: "ord-1",
    order_number: "M-101",
    location_id: 1,
    location_name: "Main Branch",
    status: "pending",
    photo_items_path: "items.jpg",
    photo_card_path: "card.jpg",
    photo_set_rev: 2,
    verification_reason_code: "unclear_photo",
    ...overrides,
  };
}

function makeFloristOrder(overrides: Record<string, unknown> = {}) {
  return {
    id: 301,
    order_id: "order-no-card",
    order_number: "M-301",
    location_id: 1,
    location_name: "Main Branch",
    status: "in_progress",
    has_card: false,
    has_cake: false,
    items: [{ name: "Rose bouquet", quantity: 1 }],
    photo_items_path: "items.jpg",
    photo_card_path: null,
    photo_card_on_box_path: null,
    verification_status: "none",
    card_printed_at: null,
    ...overrides,
  };
}

beforeEach(async () => {
  vi.clearAllMocks();
  await i18n.changeLanguage("en");
  
  mockListFloristOrders.mockReturnValue({
    data: { florist_orders: [] },
    isLoading: false,
    isError: false,
    error: null,
  });
  
  mockListFloristManualReviews.mockReturnValue({
    data: { manual_reviews: [] },
    isLoading: false,
    isError: false,
    error: null,
  });
});

describe("Florist cake printing", () => {
  const cakeOrder = (location_name: string) => makeFloristOrder({
    order_id: "11111111-1111-4111-8111-111111111111",
    location_name,
    has_card: true,
    has_cake: true,
    items: [{ name: "Chocolate Cake", custom_input: "Happy birthday!", quantity: 1 }],
  });
  it("prints the cake at the assigned location without changing card verification", async () => {
    mockUseWorkspaceRole.mockReturnValue({ isOwner: false, floristLocationId: 1, allowedPages: ["florist_orders"] });
    mockListFloristOrders.mockReturnValue({
      data: { florist_orders: [cakeOrder("Achrafieh")] }, isLoading: false, isError: false,
    });
    vi.mocked(apiFetch).mockResolvedValue({ ok: true });
    const user = userEvent.setup();
    render(<FloristOrdersPage />);
    await user.click(screen.getByTestId("tab-in-progress"));
    expect(screen.getByTestId("button-print-card-301")).toBeInTheDocument();
    expect(screen.queryByTestId("button-complete-301")).not.toBeInTheDocument();
    await user.click(screen.getByTestId("button-print-cake-301"));
    await waitFor(() => expect(apiFetch).toHaveBeenCalledWith("/api/card-message/print-cake", expect.objectContaining({
      body: JSON.stringify({
        location: "Achrafieh", cakeMessage: "Happy birthday!",
        floristOrderId: "11111111-1111-4111-8111-111111111111",
      }),
    })));
    expect(screen.queryByTestId("button-complete-301")).not.toBeInTheDocument();
  });
  it("rejects an unsupported assigned location and does not call the webhook", async () => {
    mockUseWorkspaceRole.mockReturnValue({ isOwner: false, floristLocationId: 1, allowedPages: ["florist_orders"] });
    mockListFloristOrders.mockReturnValue({
      data: { florist_orders: [cakeOrder("Beirut")] }, isLoading: false, isError: false,
    });
    render(<FloristOrdersPage />);
    await userEvent.setup().click(screen.getByTestId("tab-in-progress"));
    await userEvent.setup().click(screen.getByTestId("button-print-cake-301"));
    expect(apiFetch).not.toHaveBeenCalledWith("/api/card-message/print-cake", expect.anything());
    expect(mockToast).toHaveBeenCalledWith(expect.objectContaining({ title: expect.stringContaining("Achrafieh") }));
  });
  it("shows a failure without unlocking florist completion", async () => {
    mockUseWorkspaceRole.mockReturnValue({ isOwner: false, floristLocationId: 1, allowedPages: ["florist_orders"] });
    mockListFloristOrders.mockReturnValue({
      data: { florist_orders: [cakeOrder("Jdeideh")] }, isLoading: false, isError: false,
    });
    vi.mocked(apiFetch).mockRejectedValueOnce(new Error("webhook_error"));
    const user = userEvent.setup();
    render(<FloristOrdersPage />);
    await user.click(screen.getByTestId("tab-in-progress"));
    await user.click(screen.getByTestId("button-print-cake-301"));
    await waitFor(() => expect(mockToast).toHaveBeenCalledWith(expect.objectContaining({
      title: "Failed to send cake message to printer.", variant: "destructive",
    })));
    expect(screen.queryByTestId("button-complete-301")).not.toBeInTheDocument();
  });
  it("offers cake printing even when the order has no card", async () => {
    mockUseWorkspaceRole.mockReturnValue({ isOwner: false, floristLocationId: 1, allowedPages: ["florist_orders"] });
    mockListFloristOrders.mockReturnValue({
      data: { florist_orders: [{ ...cakeOrder("Jdeideh"), has_card: false }] },
      isLoading: false, isError: false,
    });
    vi.mocked(apiFetch).mockResolvedValue({ ok: true });
    const user = userEvent.setup();
    render(<FloristOrdersPage />);
    await user.click(screen.getByTestId("tab-in-progress"));
    expect(screen.queryByTestId("button-print-card-301")).not.toBeInTheDocument();
    await user.click(screen.getByTestId("button-print-cake-301"));
    await waitFor(() => expect(apiFetch).toHaveBeenCalledWith("/api/card-message/print-cake", expect.anything()));
  });
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("FloristOrders manual review", () => {
  it("hides manual review controls for ordinary florists", () => {
    mockUseWorkspaceRole.mockReturnValue({
      isOwner: false,
      allowedPages: ["florist_orders"],
    });
    render(<FloristOrdersPage />);

    expect(screen.queryByTestId("manual-review-section")).not.toBeInTheDocument();
  });

  it("shows the manual review section for owners", () => {
    mockUseWorkspaceRole.mockReturnValue({ isOwner: true, allowedPages: [] });
    render(<FloristOrdersPage />);

    expect(screen.getByTestId("manual-review-section")).toBeInTheDocument();
  });

  it("shows only the review workflow for members with Orders access", () => {
    mockUseWorkspaceRole.mockReturnValue({ isOwner: false, allowedPages: ["orders"] });
    render(<FloristOrdersPage />);

    expect(screen.getByTestId("manual-review-section")).toBeInTheDocument();
    expect(screen.queryByTestId("tab-new")).not.toBeInTheDocument();
    expect(mockListFloristOrders).toHaveBeenCalledWith(
      undefined,
      expect.objectContaining({
        query: expect.objectContaining({ enabled: false }),
      }),
    );
  });

  it("displays a manual review card correctly", async () => {
    const user = userEvent.setup();
    mockUseWorkspaceRole.mockReturnValue({ isOwner: true, allowedPages: [] });
    mockListFloristManualReviews.mockReturnValue({
      data: { manual_reviews: [makeReview()] },
      isLoading: false,
    });
    
    render(<FloristOrdersPage />);

    expect(await screen.findByTestId("manual-review-101")).toBeInTheDocument();
    expect(screen.getByText("#M-101")).toBeInTheDocument();
    expect(screen.getByText("Main Branch")).toBeInTheDocument();
    
    // Shows reason
    expect(screen.getByTestId("review-reason-101")).toHaveTextContent("Unclear or dark photo");
    
    // Photos
    expect(screen.getByTestId("review-items-img-101")).toBeInTheDocument();
    expect(screen.getByTestId("review-card-img-101")).toBeInTheDocument();
  });

  it("keeps items-only no-card evidence visible without an empty card image", async () => {
    mockUseWorkspaceRole.mockReturnValue({ isOwner: true, allowedPages: [] });
    mockListFloristManualReviews.mockReturnValue({
      data: { manual_reviews: [makeReview({ photo_card_path: null })] },
      isLoading: false,
    });

    render(<FloristOrdersPage />);

    expect(await screen.findByTestId("review-items-img-101")).toBeInTheDocument();
    expect(screen.queryByTestId("review-card-img-101")).not.toBeInTheDocument();
    expect(screen.queryByAltText("Card message")).not.toBeInTheDocument();
  });

  it("requires only the order-items photo for a no-card florist order", async () => {
    const user = userEvent.setup();
    mockUseWorkspaceRole.mockReturnValue({
      isOwner: false,
      allowedPages: ["florist_orders"],
    });
    mockListFloristOrders.mockReturnValue({
      data: { florist_orders: [makeFloristOrder()] },
      isLoading: false,
    });

    render(<FloristOrdersPage />);

    await user.click(screen.getByTestId("tab-in-progress"));
    expect(await screen.findByTestId("input-photo-camera-items-301")).toBeInTheDocument();
    expect(screen.queryByTestId("input-photo-camera-card-301")).not.toBeInTheDocument();
    expect(screen.getByTestId("button-verify-301")).toBeEnabled();
  });

  it("shows unassign only to queue users with Orders access and confirms removal", async () => {
    mockUseWorkspaceRole.mockReturnValue({
      isOwner: false,
      allowedPages: ["florist_orders", "orders"],
    });
    mockListFloristOrders.mockReturnValue({
      data: {
        florist_orders: [
          makeFloristOrder({ status: "pending", order_id: "order-301" }),
        ],
      },
      isLoading: false,
      isError: false,
      error: null,
    });
    mockUnassignMutate.mockImplementation(
      (
        _variables: unknown,
        options?: { onSuccess?: () => void },
      ) => options?.onSuccess?.(),
    );
    const user = userEvent.setup();
    render(<FloristOrdersPage />);

    await user.click(screen.getByTestId("button-unassign-301"));
    expect(
      screen.getByTestId("dialog-unassign-florist-order"),
    ).toBeInTheDocument();
    await user.click(
      screen.getByTestId("button-confirm-unassign-florist-order"),
    );

    expect(mockUnassignMutate).toHaveBeenCalledWith(
      { id: "order-301" },
      expect.objectContaining({
        onSuccess: expect.any(Function),
        onError: expect.any(Function),
      }),
    );
    expect(mockSetQueriesData).toHaveBeenCalled();
  });

  it("does not expose unassign to florist-only members", async () => {
    mockUseWorkspaceRole.mockReturnValue({
      isOwner: false,
      allowedPages: ["florist_orders"],
    });
    mockListFloristOrders.mockReturnValue({
      data: {
        florist_orders: [
          makeFloristOrder({ status: "pending", order_id: "order-301" }),
        ],
      },
      isLoading: false,
      isError: false,
      error: null,
    });
    render(<FloristOrdersPage />);

    expect(screen.queryByTestId("button-unassign-301")).not.toBeInTheDocument();
  });

  it("approves a review and shows a success toast", async () => {
    const user = userEvent.setup();
    mockUseWorkspaceRole.mockReturnValue({ isOwner: true, allowedPages: [] });
    mockListFloristManualReviews.mockReturnValue({
      data: { manual_reviews: [makeReview()] },
      isLoading: false,
    });
    
    mockApproveMutate.mockImplementation((_vars: unknown, options: { onSuccess: () => void }) => {
      options.onSuccess();
    });
    
    render(<FloristOrdersPage />);
    
    await user.click(await screen.findByTestId("button-approve-review-101"));
    expect(await screen.findByTestId("dialog-approve-review-101")).toBeInTheDocument();
    
    await user.click(screen.getByTestId("button-confirm-approve"));
    
    expect(mockApproveMutate).toHaveBeenCalledWith(
      { id: 101, data: { photo_set_rev: 2 } },
      expect.any(Object)
    );
    
    await waitFor(() => {
      expect(mockToast).toHaveBeenCalledWith(expect.objectContaining({
        title: expect.stringContaining("M-101"),
      }));
    });
  });
});

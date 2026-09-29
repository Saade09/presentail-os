import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import i18n from "@/i18n";
import FloristOrdersPage from "./FloristOrders";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock("@tanstack/react-query", () => ({
  useQuery: () => ({ data: undefined }),
  useQueryClient: () => ({
    invalidateQueries: vi.fn(),
    setQueriesData: vi.fn(),
  }),
}));

vi.mock("@/lib/queryClient", () => ({
  apiFetch: vi.fn(),
  getClerkToken: vi.fn().mockResolvedValue(null),
}));

vi.mock("@/hooks/use-toast", () => ({
  useToast: () => ({ toast: vi.fn() }),
}));

vi.mock("@/hooks/use-workspace-role", () => ({
  useWorkspaceRole: () => ({
    isOwner: false,
    allowedPages: ["florist_orders"],
  }),
}));

const mockListFloristOrders = vi.fn();
vi.mock("@workspace/api-client-react", () => ({
  useListFloristOrders: (...args: unknown[]) => mockListFloristOrders(...args),
  getListFloristOrdersQueryKey: () => ["florist-orders"],
  useListFloristManualReviews: () => ({
    data: { manual_reviews: [] },
    isLoading: false,
    isError: false,
    error: null,
  }),
  getListFloristManualReviewsQueryKey: () => ["florist-manual-reviews"],
  getGetFloristManualReviewCountQueryKey: () => [
    "florist-manual-reviews",
    "count",
  ],
  useApproveFloristManualReview: () => ({
    mutate: vi.fn(),
    isPending: false,
  }),
  useStartFloristOrder: () => ({ mutate: vi.fn(), isPending: false }),
  usePauseFloristOrder: () => ({ mutate: vi.fn(), isPending: false }),
  useCompleteFloristOrder: () => ({ mutate: vi.fn(), isPending: false }),
  useSetFloristOrderPhoto: () => ({
    mutate: vi.fn(),
    mutateAsync: vi.fn(),
    isPending: false,
  }),
  useRemoveFloristOrderPhoto: () => ({ mutate: vi.fn(), isPending: false }),
  useVerifyFloristOrder: () => ({ mutate: vi.fn(), isPending: false }),
}));

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const RECIPE = [
  { base_item_name: "Red Rose", base_item_image_url: null, quantity: "12" },
  { base_item_name: "Ribbon", base_item_image_url: null, quantity: "1" },
];

function makeItem(overrides: Record<string, unknown> = {}) {
  return {
    name: "Rose Bouquet",
    quantity: 1,
    image_url: null,
    custom_input: null,
    product_id: 7,
    description: "A lovely bouquet",
    description_ar: "باقة جميلة",
    recipe: RECIPE,
    ...overrides,
  };
}

function makeOrder(
  item: ReturnType<typeof makeItem>,
  overrides: Record<string, unknown> = {},
) {
  return {
    id: 1,
    order_number: "M-1001",
    status: "pending",
    location_name: "Main",
    has_card: false,
    window_start: null,
    window_end: null,
    completed_at: null,
    items: [item],
    ...overrides,
  };
}

function setOrders(
  item: ReturnType<typeof makeItem>,
  overrides: Record<string, unknown> = {},
) {
  mockListFloristOrders.mockReturnValue({
    data: { florist_orders: [makeOrder(item, overrides)] },
    isLoading: false,
    isError: false,
    error: null,
  });
}

async function selectStatusTab(
  user: ReturnType<typeof userEvent.setup>,
  status: "in_progress" | "completed",
) {
  await user.click(
    screen.getByTestId(
      status === "in_progress" ? "tab-in-progress" : "tab-completed",
    ),
  );
}

beforeEach(async () => {
  vi.clearAllMocks();
  await i18n.changeLanguage("en");
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("FloristOrders delivery window", () => {
  it("shows one readable date followed by both times for a same-day window", () => {
    setOrders(makeItem(), {
      window_start: "2026-08-21T14:00:00",
      window_end: "2026-08-21T18:00:00",
    });
    render(<FloristOrdersPage />);

    const deliveryWindow = screen.getByTestId("delivery-window-1");
    expect(deliveryWindow).toHaveTextContent(
      "Delivery window: Aug 21, 2026 · 2:00 PM – 6:00 PM",
    );
    expect(deliveryWindow.textContent?.match(/Aug 21, 2026/g)).toHaveLength(1);
  });

  it("shows a clean date and time when only one endpoint exists", () => {
    setOrders(makeItem(), {
      window_start: "2026-08-21T14:00:00",
    });
    render(<FloristOrdersPage />);

    expect(screen.getByTestId("delivery-window-1")).toHaveTextContent(
      "Delivery window: Aug 21, 2026 · 2:00 PM",
    );
  });

  it("hides the delivery window row when both endpoints are missing", () => {
    setOrders(makeItem());
    render(<FloristOrdersPage />);

    expect(screen.queryByTestId("delivery-window-1")).not.toBeInTheDocument();
  });

  it("formats the delivery window using the active Arabic locale", async () => {
    await i18n.changeLanguage("ar");
    setOrders(makeItem(), {
      window_start: "2026-08-21T14:00:00",
      window_end: "2026-08-21T18:00:00",
    });
    render(<FloristOrdersPage />);

    const date = new Intl.DateTimeFormat("ar", {
      month: "short",
      day: "numeric",
      year: "numeric",
    }).format(new Date("2026-08-21T14:00:00"));
    const startTime = new Intl.DateTimeFormat("ar", {
      hour: "numeric",
      minute: "2-digit",
    }).format(new Date("2026-08-21T14:00:00"));
    const endTime = new Intl.DateTimeFormat("ar", {
      hour: "numeric",
      minute: "2-digit",
    }).format(new Date("2026-08-21T18:00:00"));

    expect(screen.getByTestId("delivery-window-1")).toHaveTextContent(
      `فترة التوصيل: ${date} · ${startTime} – ${endTime}`,
    );
  });
});

describe("FloristOrders product dialog pager", () => {
  it("shows the pager with description + base-items panes when a recipe exists", () => {
    setOrders(makeItem());
    render(<FloristOrdersPage />);

    fireEvent.click(screen.getByTestId("button-view-product-1-0"));

    expect(screen.getByTestId("product-pager")).toBeInTheDocument();
    expect(screen.getByTestId("pane-description")).toBeInTheDocument();
    expect(screen.getByTestId("pane-recipe")).toBeInTheDocument();
    expect(screen.getByTestId("pane-indicator")).toBeInTheDocument();
    expect(screen.getByTestId("text-product-description")).toHaveTextContent(
      "A lovely bouquet",
    );
    expect(screen.getByTestId("list-recipe")).toBeInTheDocument();
    expect(screen.getByTestId("recipe-entry-0")).toHaveTextContent("Red Rose");
    expect(screen.getByTestId("recipe-entry-1")).toHaveTextContent("×1");
  });

  it("omits the recipe pane and indicator when the product has no base items", () => {
    setOrders(makeItem({ recipe: [] }));
    render(<FloristOrdersPage />);

    fireEvent.click(screen.getByTestId("button-view-product-1-0"));

    expect(screen.getByTestId("pane-description")).toBeInTheDocument();
    expect(screen.queryByTestId("pane-recipe")).not.toBeInTheDocument();
    expect(screen.queryByTestId("pane-indicator")).not.toBeInTheDocument();
  });

  it("switches panes via the toggle button and dots", () => {
    setOrders(makeItem());
    render(<FloristOrdersPage />);

    fireEvent.click(screen.getByTestId("button-view-product-1-0"));

    const toggle = screen.getByTestId("button-pane-toggle");
    expect(toggle).toHaveTextContent("Base items");
    expect(screen.getByTestId("button-pane-dot-0")).toHaveAttribute(
      "aria-current",
      "true",
    );

    fireEvent.click(toggle);
    expect(screen.getByTestId("button-pane-dot-1")).toHaveAttribute(
      "aria-current",
      "true",
    );
    expect(screen.getByTestId("button-pane-toggle")).toHaveTextContent(
      "Description",
    );

    fireEvent.click(screen.getByTestId("button-pane-dot-0"));
    expect(screen.getByTestId("button-pane-dot-0")).toHaveAttribute(
      "aria-current",
      "true",
    );
  });

  it("shows the Arabic description when the UI language is Arabic", async () => {
    setOrders(makeItem());
    render(<FloristOrdersPage />);

    fireEvent.click(screen.getByTestId("button-lang-ar"));
    fireEvent.click(screen.getByTestId("button-view-product-1-0"));

    expect(screen.getByTestId("text-product-description")).toHaveTextContent(
      "باقة جميلة",
    );
  });

  it("falls back to English when no Arabic description exists", () => {
    setOrders(makeItem({ description_ar: null }));
    render(<FloristOrdersPage />);

    fireEvent.click(screen.getByTestId("button-lang-ar"));
    fireEvent.click(screen.getByTestId("button-view-product-1-0"));

    expect(screen.getByTestId("text-product-description")).toHaveTextContent(
      "A lovely bouquet",
    );
  });
});

describe("FloristOrders card printing visibility", () => {
  it("shows Print Card for a card-bearing order in progress", async () => {
    const user = userEvent.setup();
    setOrders(makeItem(), {
      status: "in_progress",
      has_card: true,
      card_message: "Happy Birthday!",
    });
    render(<FloristOrdersPage />);

    await selectStatusTab(user, "in_progress");

    expect(screen.getByTestId("button-print-card-1")).toBeInTheDocument();
  });

  it.each(["pending", "paused", "completed"] as const)(
    "hides Print Card for a card-bearing %s order",
    async (status) => {
      const user = userEvent.setup();
      setOrders(makeItem(), {
        status,
        has_card: true,
        card_message: "Happy Birthday!",
      });
      render(<FloristOrdersPage />);

      if (status === "paused") {
        await selectStatusTab(user, "in_progress");
      } else if (status === "completed") {
        await selectStatusTab(user, "completed");
      }

      expect(screen.queryByTestId("button-print-card-1")).not.toBeInTheDocument();
    },
  );

  it.each(["pending", "in_progress", "paused", "completed"] as const)(
    "hides Print Card for a cardless %s order",
    async (status) => {
      const user = userEvent.setup();
      setOrders(makeItem(), { status, has_card: false });
      render(<FloristOrdersPage />);

      if (status === "in_progress" || status === "paused") {
        await selectStatusTab(user, "in_progress");
      } else if (status === "completed") {
        await selectStatusTab(user, "completed");
      }

      expect(screen.queryByTestId("button-print-card-1")).not.toBeInTheDocument();
    },
  );
});

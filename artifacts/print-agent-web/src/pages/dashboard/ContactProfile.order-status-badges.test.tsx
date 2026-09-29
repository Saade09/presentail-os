/**
 * Component-level render tests for the order status badge in the Contact
 * Profile order history table.
 *
 * These guard the rendering path at ContactProfile.tsx ~line 714:
 *
 *   <Badge variant="secondary" className={ORDER_STATUS_COLORS[o.status] ?? ""}>
 *     {t(ORDER_STATUS_LABEL_KEYS[o.status as OrderStatus] ?? "orders.statusPending")}
 *   </Badge>
 *
 * A future refactor that, e.g., drops the lookup tables, renders raw
 * `o.status`, or breaks i18n wiring will fail these tests before shipping.
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen } from "@testing-library/react";
import i18n from "@/i18n";

// ---------------------------------------------------------------------------
// Module mocks (must be top-level vi.mock calls)
// ---------------------------------------------------------------------------

vi.mock("wouter", () => ({
  Link: ({
    href,
    children,
    className,
    onClick,
    "data-testid": testId,
  }: {
    href: string;
    children: React.ReactNode;
    className?: string;
    onClick?: (e: React.MouseEvent) => void;
    "data-testid"?: string;
  }) => (
    <a href={href} className={className} onClick={onClick} data-testid={testId}>
      {children}
    </a>
  ),
  useRoute: () => [true, { id: "contact-abc" }],
}));

vi.mock("@clerk/react", () => ({
  useAuth: () => ({ userId: "user_test" }),
}));

vi.mock("@/lib/queryClient", () => ({
  apiFetch: vi.fn().mockResolvedValue({}),
  getClerkToken: vi.fn().mockResolvedValue("tok"),
}));

vi.mock("@/hooks/use-toast", () => ({
  useToast: () => ({ toast: vi.fn() }),
}));

vi.mock("@/hooks/use-workspace-role", () => ({
  useWorkspaceRole: () => ({ isOwner: false, allowedPages: null }),
}));

vi.mock("@/lib/orderLink", () => ({
  orderDetailPath: (o: { id: string }) => `/orders/${o.id}`,
}));

vi.mock("@/components/CreateOrderWizard", () => ({
  CreateOrderWizard: () => null,
}));

const mockInvalidateQueries = vi.fn();

vi.mock("@tanstack/react-query", () => ({
  useQueryClient: () => ({ invalidateQueries: mockInvalidateQueries }),
}));

// Controllable API hook responses.
const mockGetContact = vi.fn();
const mockListContactOrders = vi.fn();
const mockListContactActivity = vi.fn();
const mockListContactDuplicates = vi.fn();
const mockMutation = () => ({ mutate: vi.fn(), isPending: false });

vi.mock("@workspace/api-client-react", () => ({
  useGetContact: (...args: unknown[]) => mockGetContact(...args),
  useListContactOrders: (...args: unknown[]) => mockListContactOrders(...args),
  useListContactActivity: (...args: unknown[]) => mockListContactActivity(...args),
  useListContactDuplicates: (...args: unknown[]) => mockListContactDuplicates(...args),
  useAddContactTag: () => mockMutation(),
  useRemoveContactTag: () => mockMutation(),
  useUpdateContact: () => mockMutation(),
  useCreateContactNote: () => mockMutation(),
  useUpdateContactNote: () => mockMutation(),
  useDeleteContactNote: () => mockMutation(),
  useMergeContact: () => mockMutation(),
  useArchiveContact: () => mockMutation(),
  useUnarchiveContact: () => mockMutation(),
  useRespondIoSyncContact: () => mockMutation(),
  useDeleteRespondIoSyncContact: () => mockMutation(),
  useUpdateContactConsent: () => mockMutation(),
  getGetContactQueryKey: (id: string) => [`/api/contacts/${id}`],
  getListContactsQueryKey: () => ["/api/contacts"],
  getListContactOrdersQueryKey: (id: string) => [`/api/contacts/${id}/orders`],
  getListContactActivityQueryKey: (id: string) => [`/api/contacts/${id}/activity`],
  getListContactDuplicatesQueryKey: (id: string) => [`/api/contacts/${id}/duplicates`],
}));

// Import component after all mocks are in place.
import ContactProfile from "./ContactProfile";

// ---------------------------------------------------------------------------
// Minimal fixture data
// ---------------------------------------------------------------------------

const BASE_CONTACT = {
  id: "contact-abc",
  display_name: "Test User",
  first_name: "Test",
  last_name: "User",
  email: "test@example.com",
  phone: "+1234567890",
  tags: [],
  is_customer: true,
  is_recipient: false,
  orders_placed: 3,
  last_order_at: "2026-07-01T00:00:00.000Z",
  customer_id: null,
  total_spent_usd: 150,
  country: null,
  is_repeat: false,
  is_vip: false,
  created_at: "2026-01-01T00:00:00.000Z",
  gifts_received: 1,
  last_gift_at: null,
  last_activity_at: "2026-07-20T00:00:00.000Z",
  source: null,
  preferred_language: null,
  gender: undefined,
  gender_source: null,
  gender_confidence: null,
  archived_at: null,
  updated_at: "2026-07-20T00:00:00.000Z",
  duplicate_count: 0,
  respondio_contact_id: null,
  whatsapp_consent: false,
  relationships: [],
  customer: null,
};

function makeOrder(id: string, status: string) {
  return {
    id,
    display_order_number: `#${id.toUpperCase()}`,
    status,
    source: "web",
    ordered_at: "2026-07-15T10:00:00.000Z",
    created_at: "2026-07-15T10:00:00.000Z",
    totals: { total: "50.00", currency: "USD" },
    roles: ["customer" as const],
  };
}

function setupHooks(orders: ReturnType<typeof makeOrder>[]) {
  mockGetContact.mockReturnValue({
    data: { contact: BASE_CONTACT },
    isLoading: false,
    error: null,
  });
  mockListContactOrders.mockReturnValue({
    data: { orders, total: orders.length, page: 1, limit: 10 },
    isLoading: false,
  });
  mockListContactActivity.mockReturnValue({
    data: { items: [], total: 0, page: 1, limit: 15 },
    isLoading: false,
  });
  mockListContactDuplicates.mockReturnValue({
    data: { duplicates: [], total: 0 },
    isLoading: false,
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("ContactProfile — order history status badge rendering", () => {
  afterEach(async () => {
    vi.clearAllMocks();
    await i18n.changeLanguage("en");
  });

  describe("English locale", () => {
    it.each([
      ["ready_for_delivery", "Ready for delivery", "bg-[#FEF3C7]"],
      ["out_for_delivery", "Out for delivery", "bg-[#DBEAFE]"],
      ["on_hold", "On hold", "bg-orange-100"],
    ] as [string, string, string][])(
      'renders "%s" badge with human-readable label and correct color class',
      (status, expectedLabel, expectedClass) => {
        setupHooks([makeOrder("ord1", status)]);
        render(<ContactProfile />);

        const badge = screen.getByText(expectedLabel);
        expect(badge).toBeTruthy();
        expect(badge.className).toContain(expectedClass);
      },
    );

    it("does not render raw snake_case status strings", () => {
      const statuses = ["ready_for_delivery", "out_for_delivery", "on_hold"];
      setupHooks(statuses.map((s, i) => makeOrder(`ord${i}`, s)));
      render(<ContactProfile />);

      for (const status of statuses) {
        expect(screen.queryByText(status)).toBeNull();
      }
    });

    it("renders a badge with a non-empty className for each order", () => {
      const statuses = ["ready_for_delivery", "out_for_delivery", "on_hold"];
      setupHooks(statuses.map((s, i) => makeOrder(`ord${i}`, s)));
      const { container } = render(<ContactProfile />);

      const badges = container.querySelectorAll("[data-testid^='row-contact-order'] td:nth-child(3) .inline-flex");
      expect(badges.length).toBeGreaterThanOrEqual(statuses.length);
      for (const badge of badges) {
        expect((badge as HTMLElement).className.length).toBeGreaterThan(0);
      }
    });
  });

  describe("Arabic locale", () => {
    it.each([
      ["ready_for_delivery", "جاهز للتوصيل"],
      ["out_for_delivery", "قيد التوصيل"],
      ["on_hold", "في الانتظار"],
    ] as [string, string][])(
      'renders "%s" badge with Arabic label after language switch',
      async (status, expectedArabicLabel) => {
        await i18n.changeLanguage("ar");
        setupHooks([makeOrder("ord1", status)]);
        render(<ContactProfile />);

        const badge = screen.getByText(expectedArabicLabel);
        expect(badge).toBeTruthy();
        expect(screen.queryByText(status)).toBeNull();
      },
    );
  });
});

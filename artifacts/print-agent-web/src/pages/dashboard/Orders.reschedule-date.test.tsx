import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { OptionHTMLAttributes, PropsWithChildren } from "react";

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

vi.mock("@/hooks/use-toast", () => ({
  useToast: () => ({ toast: mockToast }),
}));

vi.mock("@clerk/react", () => ({
  useAuth: () => ({ userId: "user-1" }),
}));

let mockRole = { isOwner: true, allowedPages: null as string[] | null };
vi.mock("@/hooks/use-workspace-role", () => ({
  useWorkspaceRole: () => mockRole,
}));

// Controllable orders query payload — lets a test simulate the post-reschedule
// refetch returning an updated delivery window.
let mockOrdersData: unknown = { orders: [], total: 0, limit: 50, offset: 0 };
let mockRescheduleOptions: unknown = {
  success: true,
  date: "2025-03-20",
  timezone: "UTC",
  slots: [],
};
let mockRescheduleOptionsByDate = new Map<string, {
  data?: unknown;
  isLoading?: boolean;
  isFetching?: boolean;
  isError?: boolean;
  error?: unknown;
}>();
const mockRefetchOptions = vi.fn();
const mockInvalidateQueries = vi.fn();
const mockToast = vi.fn();
vi.mock("@tanstack/react-query", () => ({
  useQuery: ({ queryKey }: { queryKey: unknown[] }) => {
    const dateState = mockRescheduleOptionsByDate.get(String(queryKey[2] ?? ""));
    return queryKey[0] === "order-reschedule-options"
      ? {
          data: dateState?.data ?? mockRescheduleOptions,
          isLoading: dateState?.isLoading ?? false,
          isFetching: dateState?.isFetching ?? false,
          isError: dateState?.isError ?? false,
          error: dateState?.error,
          refetch: mockRefetchOptions,
        }
      : { data: mockOrdersData, isLoading: false, isError: false };
  },
  useMutation: () => ({ mutate: vi.fn(), isPending: false }),
  useQueryClient: () => ({ invalidateQueries: mockInvalidateQueries }),
  // Sentinel used as `placeholderData` in the orders query; identity is enough.
  keepPreviousData: (prev: unknown) => prev,
}));

vi.mock("@/components/ui/calendar", () => ({
  Calendar: ({ onSelect }: { onSelect?: (date: Date) => void }) => (
    <button type="button" onClick={() => onSelect?.(new Date(2099, 0, 2))}>
      Choose Jan 2, 2099
    </button>
  ),
}));

vi.mock("@/components/ui/select", () => ({
  Select: ({
    value,
    onValueChange,
    children,
  }: PropsWithChildren<{ value?: string; onValueChange?: (value: string) => void }>) => (
    <select
      value={value ?? ""}
      onChange={(event) => onValueChange?.(event.target.value)}
    >
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
  }: PropsWithChildren<{ value: string }>) => <option value={value}>{children}</option>,
}));

import OrdersPage from "./Orders";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

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
    ...overrides,
  };
}

function setOrders(orders: ReturnType<typeof makeOrder>[]) {
  mockOrdersData = { orders, total: orders.length, limit: 50, offset: 0 };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockRole = { isOwner: true, allowedPages: null };
  localStorage.clear();
  mockRescheduleOptions = {
    success: true,
    date: "2025-03-20",
    timezone: "UTC",
    slots: [],
  };
  mockRescheduleOptionsByDate = new Map();
  mockRefetchOptions.mockResolvedValue({ data: mockRescheduleOptions });
  mockInvalidateQueries.mockResolvedValue(undefined);
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("OrdersPage – delivery window in the date column", () => {
  it("shows the delivery window date (window_start), not the ordered/created date", () => {
    setOrders([
      makeOrder({
        window_start: "2025-03-20T10:00:00Z",
        ordered_at: "2025-01-05T00:00:00Z",
      }),
    ]);

    render(<OrdersPage />);

    // The delivery window month must be visible; the ordered-date month must not
    // be used in place of it.
    expect(screen.getByText(/Mar/)).toBeInTheDocument();
    expect(screen.queryByText(/Jan 5/)).not.toBeInTheDocument();
  });

  it("reflects an updated delivery window after a reschedule refetch", () => {
    setOrders([makeOrder({ window_start: "2025-03-20T10:00:00Z" })]);
    const { rerender } = render(<OrdersPage />);
    expect(screen.getByText(/Mar/)).toBeInTheDocument();

    // Simulate the orders query refetching with the rescheduled window.
    setOrders([makeOrder({ window_start: "2025-09-09T15:30:00Z" })]);
    rerender(<OrdersPage />);

    expect(screen.getByText(/Sep/)).toBeInTheDocument();
    expect(screen.queryByText(/Mar/)).not.toBeInTheDocument();
  });

  it("shows the neutral state when there is no delivery schedule", () => {
    setOrders([
      makeOrder({ window_start: null, ordered_at: "2025-07-04T00:00:00Z" }),
    ]);

    render(<OrdersPage />);

    expect(screen.queryByText(/Jul/)).not.toBeInTheDocument();
    expect(screen.getAllByText("—").length).toBeGreaterThan(0);
  });

  it("hides the reschedule action for users without orders access", () => {
    mockRole = { isOwner: false, allowedPages: [] };
    setOrders([makeOrder({ window_start: "2025-03-20T10:00:00Z" })]);

    render(<OrdersPage />);

    expect(
      screen.queryByRole("button", { name: /Reschedule/i }),
    ).not.toBeInTheDocument();
  });
});

describe("OrdersPage – server-backed reschedule slots", () => {
  async function openRescheduleDialog() {
    const user = userEvent.setup();
    const rendered = render(<OrdersPage />);
    // Reschedule now lives inside the per-row actions kebab menu.
    await user.click(screen.getByRole("button", { name: /Actions/i }));
    await user.click(await screen.findByRole("menuitem", { name: /Reschedule/i }));
    const dialog = await screen.findByRole("dialog");
    return { user, dialog, ...rendered };
  }

  it("shows a single day picker plus server-provided slots, not free-form time inputs", async () => {
    mockRescheduleOptions = {
      success: true,
      date: "2025-03-20",
      timezone: "UTC",
      slots: [{
        id: "slot-12",
        label: "Morning",
        start_time: "10:00",
        end_time: "12:00",
        window_start: "2025-03-20T10:00:00.000Z",
        window_end: "2025-03-20T12:00:00.000Z",
      }],
    };
    setOrders([
      makeOrder({
        window_start: "2025-03-20T10:00:00",
        window_end: "2025-03-20T12:00:00",
      }),
    ]);

    const { dialog } = await openRescheduleDialog();

    // No native datetime-local inputs remain.
    expect(
      dialog.querySelectorAll('input[type="datetime-local"]').length,
    ).toBe(0);

    // A single delivery-day picker is shown (no per-field second date picker).
    expect(
      dialog.querySelector('[data-testid="reschedule-day"]'),
    ).toBeInTheDocument();
    expect(
      dialog.querySelector('[data-testid="reschedule-start-date"]'),
    ).not.toBeInTheDocument();
    expect(
      dialog.querySelector('[data-testid="reschedule-end-date"]'),
    ).not.toBeInTheDocument();

    expect(dialog.querySelector("select")).toBeInTheDocument();
    expect(dialog.querySelector('[data-testid="reschedule-start-time"]')).not.toBeInTheDocument();
    expect(dialog.querySelector('[data-testid="reschedule-end-time"]')).not.toBeInTheDocument();
  });

  it("pre-fills the day and selects the matching server slot", async () => {
    mockRescheduleOptions = {
      success: true,
      date: "2025-03-20",
      timezone: "UTC",
      slots: [{
        id: "slot-12",
        label: "Morning",
        start_time: "10:30",
        end_time: "12:30",
        window_start: "2025-03-20T10:30:00.000Z",
        window_end: "2025-03-20T12:30:00.000Z",
      }],
    };
    setOrders([
      makeOrder({
        window_start: "2025-03-20T10:30:00",
        window_end: "2025-03-20T12:30:00",
      }),
    ]);

    const { dialog } = await openRescheduleDialog();

    const dayTrigger = dialog.querySelector(
      '[data-testid="reschedule-day"]',
    ) as HTMLElement;
    expect(dayTrigger).toHaveTextContent("Mar 20, 2025");

    const slotSelect = dialog.querySelector("select");
    expect(slotSelect).toBeTruthy();
    await waitFor(() => expect(slotSelect).toHaveValue("slot-12"));
  });

  it("submits exactly the selected server slot identity and times", async () => {
    const { apiFetch } = await import("@/lib/queryClient");
    const apiFetchMock = vi.mocked(apiFetch);
    apiFetchMock.mockResolvedValue({ assignment: null } as never);
    mockRescheduleOptions = {
      success: true,
      date: "2025-03-20",
      timezone: "UTC",
      slots: [
        {
          id: "slot-12",
          label: "Morning",
          start_time: "10:00",
          end_time: "12:00",
          window_start: "2025-03-20T10:00:00.000Z",
          window_end: "2025-03-20T12:00:00.000Z",
        },
        {
          id: "slot-13",
          label: "Afternoon",
          start_time: "14:00",
          end_time: "18:00",
          window_start: "2025-03-20T14:00:00.000Z",
          window_end: "2025-03-20T18:00:00.000Z",
        },
      ],
    };

    setOrders([
      makeOrder({
        window_start: "2025-03-20T10:00:00",
        window_end: "2025-03-20T12:00:00",
      }),
    ]);

    const { user, dialog } = await openRescheduleDialog();

    const slotSelect = dialog.querySelector("select");
    expect(slotSelect).toBeTruthy();
    await user.selectOptions(slotSelect!, "slot-13");

    await user.click(screen.getByRole("button", { name: /Save changes/i }));

    const rescheduleCall = apiFetchMock.mock.calls.find(
      ([url, opts]) =>
        url === "/api/orders/order-1/reschedule" &&
        (opts as RequestInit | undefined)?.method === "POST",
    );
    expect(rescheduleCall).toBeTruthy();
    const body = JSON.parse(
      (rescheduleCall![1] as RequestInit).body as string,
    ) as {
      date: string;
      slot_id: string;
      start_time: string;
      end_time: string;
    };
    expect(body.date).toBe("2025-03-20");
    expect(body.slot_id).toBe("slot-13");
    expect(body.start_time).toBe("14:00");
    expect(body.end_time).toBe("18:00");
    expect(mockInvalidateQueries).toHaveBeenCalledWith({ queryKey: ["orders"] });
  });

  it("hides the slot picker and disables save when no day is chosen", async () => {
    const { apiFetch } = await import("@/lib/queryClient");
    const apiFetchMock = vi.mocked(apiFetch);
    apiFetchMock.mockResolvedValue({ assignment: null } as never);

    // Order with no delivery window at all.
    setOrders([makeOrder({ window_start: null, window_end: null })]);

    const { user, dialog } = await openRescheduleDialog();

    expect(dialog.querySelector("select")).not.toBeInTheDocument();

    expect(screen.getByRole("button", { name: /Save changes/i })).toBeDisabled();
    expect(apiFetchMock).not.toHaveBeenCalled();
  });

  it("keeps the dialog open, clears the stale slot, and refreshes options on conflict", async () => {
    const { apiFetch } = await import("@/lib/queryClient");
    vi.mocked(apiFetch).mockRejectedValueOnce(
      Object.assign(
        new Error("That delivery slot is no longer available. Choose another slot."),
        { status: 409, code: "slot_no_longer_available" },
      ),
    );
    mockRescheduleOptions = {
      success: true,
      date: "2025-03-20",
      timezone: "UTC",
      slots: [{
        id: "slot-12",
        label: "Morning",
        start_time: "10:00",
        end_time: "12:00",
        window_start: "2025-03-20T10:00:00.000Z",
        window_end: "2025-03-20T12:00:00.000Z",
      }],
    };
    setOrders([makeOrder({
      window_start: "2025-03-20T10:00:00Z",
      window_end: "2025-03-20T12:00:00Z",
      delivery_timezone: "UTC",
    })]);

    const { user, dialog } = await openRescheduleDialog();
    const slotSelect = dialog.querySelector("select");
    expect(slotSelect).toBeTruthy();
    await waitFor(() => expect(slotSelect).toHaveValue("slot-12"));
    await user.click(screen.getByRole("button", { name: /Save changes/i }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "That delivery slot is no longer available. Choose another slot.",
    );
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(slotSelect).toHaveValue("");
    expect(mockRefetchOptions).toHaveBeenCalledOnce();
  });

  it("replaces a past-date error with the newly selected date's slots", async () => {
    const pastError = Object.assign(new Error("Choose a future delivery date"), {
      status: 409,
      code: "delivery_date_in_past",
    });
    mockRescheduleOptionsByDate.set("2025-03-20", {
      isError: true,
      error: pastError,
    });
    mockRescheduleOptionsByDate.set("2099-01-02", {
      data: {
        success: true,
        date: "2099-01-02",
        timezone: "UTC",
        slots: [{
          id: "express",
          label: "Express",
          start_time: "14:00",
          end_time: "18:00",
          window_start: "2099-01-02T14:00:00.000Z",
          window_end: "2099-01-02T18:00:00.000Z",
        }],
      },
    });
    setOrders([makeOrder({
      window_start: "2025-03-20T10:00:00Z",
      window_end: "2025-03-20T12:00:00Z",
      delivery_timezone: "UTC",
    })]);

    const { user, dialog } = await openRescheduleDialog();
    expect(screen.getByText("Choose a future delivery date")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Save changes/i })).toBeDisabled();

    await user.click(dialog.querySelector('[data-testid="reschedule-day"]')!);
    await user.click(screen.getByRole("button", { name: "Choose Jan 2, 2099" }));

    expect(screen.queryByText("Choose a future delivery date")).not.toBeInTheDocument();
    expect(dialog.querySelector("select")).toHaveTextContent("Express · 14:00–18:00");
    expect(screen.getByRole("button", { name: /Save changes/i })).toBeDisabled();
  });

  it("does not render retained slots from the previous date while the new date loads", async () => {
    const oldDateResponse = {
      success: true,
      date: "2025-03-20",
      timezone: "UTC",
      slots: [{
        id: "old-slot",
        label: "Old date",
        start_time: "10:00",
        end_time: "12:00",
        window_start: "2025-03-20T10:00:00.000Z",
        window_end: "2025-03-20T12:00:00.000Z",
      }],
    };
    const newDateResponse = {
      success: true,
      date: "2099-01-02",
      timezone: "UTC",
      slots: [{
        id: "express",
        label: "Express",
        start_time: "14:00",
        end_time: "18:00",
        window_start: "2099-01-02T14:00:00.000Z",
        window_end: "2099-01-02T18:00:00.000Z",
      }],
    };
    mockRescheduleOptions = oldDateResponse;
    mockRescheduleOptionsByDate.set("2099-01-02", {
      data: oldDateResponse,
      isFetching: true,
    });
    setOrders([makeOrder({
      window_start: "2025-03-20T10:00:00Z",
      window_end: "2025-03-20T12:00:00Z",
      delivery_timezone: "UTC",
    })]);

    const { user, dialog, rerender } = await openRescheduleDialog();
    await user.click(dialog.querySelector('[data-testid="reschedule-day"]')!);
    await user.click(screen.getByRole("button", { name: "Choose Jan 2, 2099" }));

    expect(dialog.querySelector("select")).not.toBeInTheDocument();
    expect(screen.queryByText(/Old date/)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Save changes/i })).toBeDisabled();

    mockRescheduleOptionsByDate.set("2099-01-02", { data: newDateResponse });
    rerender(<OrdersPage />);

    expect(dialog.querySelector("select")).toHaveTextContent("Express · 14:00–18:00");
    expect(screen.queryByText(/Old date/)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Save changes/i })).toBeDisabled();
  });
});

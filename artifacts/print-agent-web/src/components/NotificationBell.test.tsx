import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, act, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock("wouter", () => ({
  useLocation: () => ["/", vi.fn()],
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) => {
      if (key === "notifications.accessRequest") return `Access request from ${opts?.name ?? ""}`;
      return key;
    },
  }),
}));

const mockApiFetch = vi.fn();
vi.mock("@/lib/queryClient", () => ({
  apiFetch: (...args: unknown[]) => mockApiFetch(...args),
  queryClient: new (require("@tanstack/react-query").QueryClient)(),
}));

const mockToast = vi.fn();
vi.mock("@/hooks/use-toast", () => ({
  useToast: () => ({ toast: mockToast }),
}));

const mockReviewMutateAsync = vi.fn();
vi.mock("@workspace/api-client-react", () => ({
  useReviewTimeOffRequest: () => ({ mutateAsync: mockReviewMutateAsync }),
  getGetTimeOffBalanceQueryKey: () => ["/api/time-off/balance"],
  getListTimeOffRequestsQueryKey: () => ["/api/time-off/requests"],
}));

// Lightweight DropdownMenu shim: renders children and delegates open/close
// to a simple button so tests can trigger it without Radix pointer-event quirks.
let onOpenChangeCb: ((open: boolean) => void) | undefined;

vi.mock("@/components/ui/dropdown-menu", () => ({
  DropdownMenu: ({
    open,
    onOpenChange,
    children,
  }: {
    open: boolean;
    onOpenChange: (v: boolean) => void;
    children: React.ReactNode;
  }) => {
    onOpenChangeCb = onOpenChange;
    return <div data-open={open}>{children}</div>;
  },
  DropdownMenuTrigger: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  DropdownMenuContent: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="dropdown-content">{children}</div>
  ),
  DropdownMenuLabel: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  DropdownMenuSeparator: () => <hr />,
  DropdownMenuItem: ({
    children,
    onClick,
    ...rest
  }: {
    children: React.ReactNode;
    onClick?: () => void;
    [key: string]: unknown;
  }) => (
    <div role="menuitem" onClick={onClick} {...rest}>
      {children}
    </div>
  ),
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRequest(id: number) {
  return {
    id,
    requester_name: `User ${id}`,
    requester_email: `user${id}@example.com`,
    requested_at: new Date().toISOString(),
  };
}

function makeQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0, staleTime: 0 },
      mutations: { retry: false },
    },
  });
}

function renderWithClient(
  ui: React.ReactElement,
  queryClient: QueryClient,
  seenIds: number[] = [],
) {
  queryClient.setQueryData(["notification-seen-ids"], { seenIds });
  return render(
    <QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>,
  );
}

function openDropdown() {
  act(() => {
    onOpenChangeCb?.(true);
  });
}

function closeDropdown() {
  act(() => {
    onOpenChangeCb?.(false);
  });
}

// ---------------------------------------------------------------------------
// Import component under test AFTER mocks are set up
// ---------------------------------------------------------------------------

import { NotificationBell } from "./NotificationBell";

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

beforeEach(() => {
  onOpenChangeCb = undefined;
  vi.clearAllMocks();
  localStorage.clear();
  mockApiFetch.mockResolvedValue({ ok: true });
});

describe("NotificationBell – badge visibility", () => {
  it("shows the badge when there are unseen requests", () => {
    const qc = makeQueryClient();
    renderWithClient(
      <NotificationBell requests={[makeRequest(1), makeRequest(2)]} />,
      qc,
    );
    expect(screen.getByTestId("notification-badge")).toBeInTheDocument();
    expect(screen.getByTestId("notification-badge")).toHaveTextContent("2");
  });

  it("does not show the badge when there are no requests", () => {
    const qc = makeQueryClient();
    renderWithClient(<NotificationBell requests={[]} />, qc);
    expect(screen.queryByTestId("notification-badge")).not.toBeInTheDocument();
  });

  it("does not show the badge when all requests were previously seen", () => {
    const qc = makeQueryClient();
    const requests = [makeRequest(10), makeRequest(11)];
    renderWithClient(<NotificationBell requests={requests} />, qc, [10, 11]);
    expect(screen.queryByTestId("notification-badge")).not.toBeInTheDocument();
  });

  it("shows the badge for unseen requests even when some are already seen", () => {
    const qc = makeQueryClient();
    const requests = [makeRequest(1), makeRequest(2), makeRequest(3)];
    renderWithClient(<NotificationBell requests={requests} />, qc, [1]);
    const badge = screen.getByTestId("notification-badge");
    expect(badge).toBeInTheDocument();
    expect(badge).toHaveTextContent("2");
  });
});

describe("NotificationBell – opening the dropdown clears the badge", () => {
  it("hides the badge after the dropdown is opened", async () => {
    const qc = makeQueryClient();
    renderWithClient(
      <NotificationBell requests={[makeRequest(1), makeRequest(2)]} />,
      qc,
    );
    expect(screen.getByTestId("notification-badge")).toBeInTheDocument();

    openDropdown();

    expect(screen.queryByTestId("notification-badge")).not.toBeInTheDocument();
  });

  it("calls the API to mark IDs as seen when the dropdown is opened", async () => {
    const qc = makeQueryClient();
    renderWithClient(
      <NotificationBell requests={[makeRequest(5), makeRequest(6)]} />,
      qc,
    );

    openDropdown();

    await waitFor(() => {
      expect(mockApiFetch).toHaveBeenCalledWith(
        "/api/notifications/seen",
        expect.objectContaining({ method: "POST" }),
      );
    });
  });

  it("does not call the mark-seen API when opening with no requests", async () => {
    const qc = makeQueryClient();
    renderWithClient(<NotificationBell requests={[]} />, qc);

    openDropdown();

    await act(async () => {});

    expect(mockApiFetch).not.toHaveBeenCalledWith(
      "/api/notifications/seen",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("only sends unseen IDs to the API when some are already seen", async () => {
    const qc = makeQueryClient();
    renderWithClient(
      <NotificationBell requests={[makeRequest(1), makeRequest(2)]} />,
      qc,
      [1],
    );

    openDropdown();

    await waitFor(() => {
      const call = mockApiFetch.mock.calls.find(
        ([url, opts]) =>
          url === "/api/notifications/seen" && opts?.method === "POST",
      );
      expect(call).toBeDefined();
      const body = JSON.parse(call![1].body as string) as { ids: number[] };
      expect(body.ids).toEqual([2]);
      expect(body.ids).not.toContain(1);
    });
  });
});

describe("NotificationBell – reading seen IDs from server on mount", () => {
  it("treats pre-seeded IDs as seen on mount", () => {
    const qc = makeQueryClient();
    renderWithClient(
      <NotificationBell requests={[makeRequest(42), makeRequest(43)]} />,
      qc,
      [42, 43],
    );
    expect(screen.queryByTestId("notification-badge")).not.toBeInTheDocument();
  });

  it("treats IDs not in the server response as unseen on mount", () => {
    const qc = makeQueryClient();
    renderWithClient(
      <NotificationBell requests={[makeRequest(42), makeRequest(99)]} />,
      qc,
      [42],
    );
    const badge = screen.getByTestId("notification-badge");
    expect(badge).toHaveTextContent("1");
  });
});

describe("NotificationBell – new unseen request re-shows badge after prior seen", () => {
  it("re-shows the badge when a new unseen request arrives after prior ones were marked seen", () => {
    const qc = makeQueryClient();
    const { rerender } = renderWithClient(
      <NotificationBell requests={[makeRequest(1)]} />,
      qc,
    );

    openDropdown();
    expect(screen.queryByTestId("notification-badge")).not.toBeInTheDocument();

    closeDropdown();
    rerender(
      <QueryClientProvider client={qc}>
        <NotificationBell requests={[makeRequest(1), makeRequest(2)]} />
      </QueryClientProvider>,
    );

    const badge = screen.getByTestId("notification-badge");
    expect(badge).toBeInTheDocument();
    expect(badge).toHaveTextContent("1");
  });

  it("keeps the badge hidden when the new request was already in a prior seen batch", () => {
    const qc = makeQueryClient();
    const { rerender } = renderWithClient(
      <NotificationBell requests={[makeRequest(1), makeRequest(2)]} />,
      qc,
    );

    openDropdown();

    rerender(
      <QueryClientProvider client={qc}>
        <NotificationBell requests={[makeRequest(1), makeRequest(2)]} />
      </QueryClientProvider>,
    );

    expect(screen.queryByTestId("notification-badge")).not.toBeInTheDocument();
  });
});

describe("NotificationBell – time-off approve/deny actions", () => {
  function makeTimeOffNotif(id: number, entityId: number | null = id * 10) {
    return {
      id,
      type: "TIME_OFF_REQUEST",
      title: `New Vacation request`,
      body: "Alice requested vacation from 2026-06-01 to 2026-06-03.",
      entity_id: entityId,
      is_read: false,
      created_at: new Date().toISOString(),
      actor_name: "Alice Anderson",
      actor_email: "alice@example.com",
    };
  }

  it("renders actor_name as primary identifier with email as secondary", () => {
    const qc = makeQueryClient();
    renderWithClient(
      <NotificationBell requests={[]} timeOffNotifications={[makeTimeOffNotif(101)]} />,
      qc,
    );
    expect(screen.getByText("Alice Anderson")).toBeInTheDocument();
    expect(screen.getByText("(alice@example.com)")).toBeInTheDocument();
  });

  it("falls back to actor_email when actor_name is null", () => {
    const qc = makeQueryClient();
    const notif = { ...makeTimeOffNotif(102), actor_name: null };
    renderWithClient(
      <NotificationBell requests={[]} timeOffNotifications={[notif]} />,
      qc,
    );
    expect(screen.getByText("alice@example.com")).toBeInTheDocument();
    expect(screen.queryByText("(alice@example.com)")).not.toBeInTheDocument();
  });

  it("renders Approve and Deny buttons for time-off request notifications", () => {
    const qc = makeQueryClient();
    renderWithClient(
      <NotificationBell requests={[]} timeOffNotifications={[makeTimeOffNotif(1)]} />,
      qc,
    );
    expect(screen.getByTestId("notification-approve-1")).toBeInTheDocument();
    expect(screen.getByTestId("notification-deny-1")).toBeInTheDocument();
  });

  it("calls reviewTimeOffRequest with APPROVED after confirming the inline note form", async () => {
    mockReviewMutateAsync.mockResolvedValue({ ok: true });
    const qc = makeQueryClient();
    renderWithClient(
      <NotificationBell requests={[]} timeOffNotifications={[makeTimeOffNotif(7, 70)]} />,
      qc,
    );

    await act(async () => {
      screen.getByTestId("notification-approve-7").click();
    });

    expect(screen.getByTestId("notification-note-7")).toBeInTheDocument();
    expect(mockReviewMutateAsync).not.toHaveBeenCalled();

    await act(async () => {
      screen.getByTestId("notification-confirm-7").click();
    });

    await waitFor(() => {
      expect(mockReviewMutateAsync).toHaveBeenCalledWith({
        id: 70,
        data: { status: "APPROVED", managerNote: null },
      });
    });
    expect(mockToast).toHaveBeenCalledWith(
      expect.objectContaining({ title: "notifications.timeOffApproved" }),
    );
  });

  it("calls reviewTimeOffRequest with DECLINED after confirming the inline note form", async () => {
    mockReviewMutateAsync.mockResolvedValue({ ok: true });
    const qc = makeQueryClient();
    renderWithClient(
      <NotificationBell requests={[]} timeOffNotifications={[makeTimeOffNotif(8, 80)]} />,
      qc,
    );

    await act(async () => {
      screen.getByTestId("notification-deny-8").click();
    });

    expect(screen.getByTestId("notification-note-8")).toBeInTheDocument();
    expect(mockReviewMutateAsync).not.toHaveBeenCalled();

    await act(async () => {
      screen.getByTestId("notification-confirm-8").click();
    });

    await waitFor(() => {
      expect(mockReviewMutateAsync).toHaveBeenCalledWith({
        id: 80,
        data: { status: "DECLINED", managerNote: null },
      });
    });
    expect(mockToast).toHaveBeenCalledWith(
      expect.objectContaining({ title: "notifications.timeOffDeclined" }),
    );
  });

  it("passes the typed managerNote when confirming after typing in the note field", async () => {
    mockReviewMutateAsync.mockResolvedValue({ ok: true });
    const qc = makeQueryClient();
    renderWithClient(
      <NotificationBell requests={[]} timeOffNotifications={[makeTimeOffNotif(13, 130)]} />,
      qc,
    );

    await act(async () => {
      screen.getByTestId("notification-deny-13").click();
    });

    const textarea = screen.getByTestId(
      "notification-note-13",
    ) as HTMLTextAreaElement;
    await act(async () => {
      textarea.focus();
      // Use the React testing-library fireEvent equivalent for change events.
      const setter = Object.getOwnPropertyDescriptor(
        window.HTMLTextAreaElement.prototype,
        "value",
      )?.set;
      setter?.call(textarea, "Conflicts with sprint launch");
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
    });

    await act(async () => {
      screen.getByTestId("notification-confirm-13").click();
    });

    await waitFor(() => {
      expect(mockReviewMutateAsync).toHaveBeenCalledWith({
        id: 130,
        data: {
          status: "DECLINED",
          managerNote: "Conflicts with sprint launch",
        },
      });
    });
  });

  it("returns to the Approve/Deny buttons without calling the API when Cancel is clicked", async () => {
    const qc = makeQueryClient();
    renderWithClient(
      <NotificationBell requests={[]} timeOffNotifications={[makeTimeOffNotif(14, 140)]} />,
      qc,
    );

    await act(async () => {
      screen.getByTestId("notification-approve-14").click();
    });

    expect(screen.getByTestId("notification-note-14")).toBeInTheDocument();

    await act(async () => {
      screen.getByTestId("notification-cancel-14").click();
    });

    expect(screen.queryByTestId("notification-note-14")).not.toBeInTheDocument();
    expect(screen.getByTestId("notification-approve-14")).toBeInTheDocument();
    expect(screen.getByTestId("notification-deny-14")).toBeInTheDocument();
    expect(mockReviewMutateAsync).not.toHaveBeenCalled();
  });

  it("shows an error toast when the review API call fails", async () => {
    mockReviewMutateAsync.mockRejectedValue(new Error("boom"));
    const qc = makeQueryClient();
    renderWithClient(
      <NotificationBell requests={[]} timeOffNotifications={[makeTimeOffNotif(9, 90)]} />,
      qc,
    );

    await act(async () => {
      screen.getByTestId("notification-approve-9").click();
    });
    await act(async () => {
      screen.getByTestId("notification-confirm-9").click();
    });

    await waitFor(() => {
      expect(mockToast).toHaveBeenCalledWith(
        expect.objectContaining({
          title: "notifications.timeOffActionFailed",
          variant: "destructive",
        }),
      );
    });
  });

  it("does not render Approve/Deny buttons for non-TIME_OFF_REQUEST notifications", () => {
    const qc = makeQueryClient();
    const notif = { ...makeTimeOffNotif(2), type: "OTHER" };
    renderWithClient(
      <NotificationBell requests={[]} timeOffNotifications={[notif]} />,
      qc,
    );
    expect(screen.queryByTestId("notification-approve-2")).not.toBeInTheDocument();
    expect(screen.queryByTestId("notification-deny-2")).not.toBeInTheDocument();
  });

  it("does not render Approve/Deny buttons when entity_id is null", () => {
    const qc = makeQueryClient();
    renderWithClient(
      <NotificationBell
        requests={[]}
        timeOffNotifications={[makeTimeOffNotif(3, null)]}
      />,
      qc,
    );
    expect(screen.queryByTestId("notification-approve-3")).not.toBeInTheDocument();
    expect(screen.queryByTestId("notification-deny-3")).not.toBeInTheDocument();
  });

  it("does NOT auto-mark actionable time-off notifications as seen when the bell opens", () => {
    mockApiFetch.mockResolvedValue({ ok: true });
    const qc = makeQueryClient();
    renderWithClient(
      <NotificationBell
        requests={[]}
        timeOffNotifications={[makeTimeOffNotif(11, 110), makeTimeOffNotif(12, 120)]}
      />,
      qc,
    );

    openDropdown();

    const seenCalls = mockApiFetch.mock.calls.filter(
      ([url]) => typeof url === "string" && url === "/api/time-off/notifications/seen",
    );
    expect(seenCalls).toHaveLength(0);
  });

  it("DOES auto-mark non-actionable time-off notifications as seen when the bell opens", async () => {
    mockApiFetch.mockResolvedValue({ ok: true });
    const qc = makeQueryClient();
    const nonActionable = { ...makeTimeOffNotif(20, null), type: "TIME_OFF_INFO" };
    renderWithClient(
      <NotificationBell requests={[]} timeOffNotifications={[nonActionable]} />,
      qc,
    );

    openDropdown();

    await waitFor(() => {
      const seenCalls = mockApiFetch.mock.calls.filter(
        ([url]) => typeof url === "string" && url === "/api/time-off/notifications/seen",
      );
      expect(seenCalls.length).toBeGreaterThan(0);
      const body = JSON.parse((seenCalls[0]?.[1] as { body: string }).body);
      expect(body).toEqual({ ids: [20] });
    });
  });
});

describe("NotificationBell – badge count display", () => {
  it("shows 99+ when there are more than 99 unseen requests", () => {
    const qc = makeQueryClient();
    const requests = Array.from({ length: 100 }, (_, i) => makeRequest(i + 1));
    renderWithClient(<NotificationBell requests={requests} />, qc);
    expect(screen.getByTestId("notification-badge")).toHaveTextContent("99+");
  });

  it("shows exactly 99 when there are 99 unseen requests", () => {
    const qc = makeQueryClient();
    const requests = Array.from({ length: 99 }, (_, i) => makeRequest(i + 1));
    renderWithClient(<NotificationBell requests={requests} />, qc);
    expect(screen.getByTestId("notification-badge")).toHaveTextContent("99");
  });
});

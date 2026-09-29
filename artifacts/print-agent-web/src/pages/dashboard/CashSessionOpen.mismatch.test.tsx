import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock("wouter", () => ({
  useLocation: () => ["/cash-sessions/open", vi.fn()],
}));

vi.mock("@/lib/queryClient", () => ({
  apiFetch: vi.fn(),
}));

vi.mock("@/hooks/use-toast", () => ({
  useToast: () => ({ toast: vi.fn() }),
}));

// Controllable query payloads — useQuery is keyed off the query key so the
// drawers list and the previous-session lookup can be driven independently.
let drawersData: unknown = { drawers: [] };
let prevSessionsData: unknown = { sessions: [] };

vi.mock("@tanstack/react-query", () => ({
  useQuery: ({ queryKey }: { queryKey: unknown[] }) => {
    if (queryKey[0] === "cash-drawers") return { data: drawersData };
    if (queryKey[0] === "cash-sessions") return { data: prevSessionsData };
    return { data: undefined };
  },
  // A functional mutation mock: calling mutate() actually invokes the
  // mutationFn (which fires apiFetch), so tests can assert the POST happens.
  useMutation: ({
    mutationFn,
    onSuccess,
    onError,
  }: {
    mutationFn: (vars?: unknown) => Promise<unknown>;
    onSuccess?: (res: unknown) => void;
    onError?: (err: unknown) => void;
  }) => ({
    mutate: async (vars?: unknown) => {
      try {
        const res = await mutationFn(vars);
        onSuccess?.(res);
      } catch (err) {
        onError?.(err);
      }
    },
    isPending: false,
  }),
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
}));

import CashSessionOpen from "./CashSessionOpen";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeDrawer(overrides: Record<string, unknown> = {}) {
  return {
    id: 1,
    name: "Front",
    code: "FRT",
    currency: "USD",
    secondary_currency: null,
    is_active: true,
    location_name: null,
    open_session_id: null,
    ...overrides,
  };
}

function makeSession(overrides: Record<string, unknown> = {}) {
  return {
    id: 10,
    status: "closed",
    currency: "USD",
    secondary_currency: null,
    actual_cash: "100.00",
    actual_cash_secondary: null,
    ...overrides,
  };
}

async function selectDrawer(user: ReturnType<typeof userEvent.setup>) {
  const trigger = screen.getByRole("combobox");
  await user.click(trigger);
  const option = await screen.findByRole("option", { name: /Front/ });
  await user.click(option);
}

beforeEach(() => {
  vi.clearAllMocks();
  drawersData = { drawers: [makeDrawer()] };
  prevSessionsData = { sessions: [] };
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("CashSessionOpen – opening-cash mismatch guard", () => {
  it("blocks opening when the entered cash doesn't match the previous closing cash", async () => {
    const { apiFetch } = await import("@/lib/queryClient");
    const apiFetchMock = vi.mocked(apiFetch);
    apiFetchMock.mockResolvedValue({ session: { id: 99 } } as never);

    prevSessionsData = {
      sessions: [makeSession()],
    };

    const user = userEvent.setup();
    render(<CashSessionOpen />);

    await selectDrawer(user);
    await user.type(screen.getByPlaceholderText("0.00"), "50");

    // The destructive mismatch warning is shown.
    expect(
      screen.getByText(/Opening cash doesn't match/i),
    ).toBeInTheDocument();

    // The Open Session button is disabled, so a mismatched session cannot open.
    const openButton = screen.getByRole("button", { name: /Open Session/i });
    expect(openButton).toBeDisabled();

    await user.click(openButton);

    // No POST to create a session fires.
    const postCall = apiFetchMock.mock.calls.find(
      ([url, opts]) =>
        url === "/api/cash-sessions" &&
        (opts as RequestInit | undefined)?.method === "POST",
    );
    expect(postCall).toBeUndefined();
  });

  it("allows opening when the entered cash matches the previous closing cash", async () => {
    const { apiFetch } = await import("@/lib/queryClient");
    const apiFetchMock = vi.mocked(apiFetch);
    apiFetchMock.mockResolvedValue({ session: { id: 99 } } as never);

    prevSessionsData = {
      sessions: [makeSession()],
    };

    const user = userEvent.setup();
    render(<CashSessionOpen />);

    await selectDrawer(user);
    await user.type(screen.getByPlaceholderText("0.00"), "100");

    // No mismatch warning for a matching amount.
    expect(
      screen.queryByText(/Opening cash doesn't match/i),
    ).not.toBeInTheDocument();

    const openButton = screen.getByRole("button", { name: /Open Session/i });
    expect(openButton).not.toBeDisabled();

    await user.click(openButton);

    // The session-create POST fires with the entered opening cash.
    const postCall = apiFetchMock.mock.calls.find(
      ([url, opts]) =>
        url === "/api/cash-sessions" &&
        (opts as RequestInit | undefined)?.method === "POST",
    );
    expect(postCall).toBeTruthy();
    const body = JSON.parse((postCall![1] as RequestInit).body as string) as {
      drawer_id: number;
      opening_cash: number;
    };
    expect(body.drawer_id).toBe(1);
    expect(body.opening_cash).toBe(100);
  });

  it("opens without any warning when the drawer has no previous closed session", async () => {
    const { apiFetch } = await import("@/lib/queryClient");
    const apiFetchMock = vi.mocked(apiFetch);
    apiFetchMock.mockResolvedValue({ session: { id: 99 } } as never);

    prevSessionsData = { sessions: [] };

    const user = userEvent.setup();
    render(<CashSessionOpen />);

    await selectDrawer(user);
    await user.type(screen.getByPlaceholderText("0.00"), "75");

    // No previous closing cash → no mismatch warning regardless of amount.
    expect(
      screen.queryByText(/Opening cash doesn't match/i),
    ).not.toBeInTheDocument();

    const openButton = screen.getByRole("button", { name: /Open Session/i });
    expect(openButton).not.toBeDisabled();

    await user.click(openButton);

    const postCall = apiFetchMock.mock.calls.find(
      ([url, opts]) =>
        url === "/api/cash-sessions" &&
        (opts as RequestInit | undefined)?.method === "POST",
    );
    expect(postCall).toBeTruthy();
  });

  it("dual drawer: shows two opening inputs, checks carry-over per currency, and sends both amounts", async () => {
    const { apiFetch } = await import("@/lib/queryClient");
    const apiFetchMock = vi.mocked(apiFetch);
    apiFetchMock.mockResolvedValue({ session: { id: 99 } } as never);

    drawersData = { drawers: [makeDrawer({ secondary_currency: "LBP" })] };
    prevSessionsData = {
      sessions: [
        makeSession({
          secondary_currency: "LBP",
          actual_cash: "100.00",
          actual_cash_secondary: "500000.00",
        }),
      ],
    };

    const user = userEvent.setup();
    render(<CashSessionOpen />);

    await selectDrawer(user);

    const inputs = screen.getAllByPlaceholderText("0.00");
    expect(inputs).toHaveLength(2);

    // Matching main, mismatching secondary → mismatch warning + disabled button.
    await user.type(inputs[0], "100");
    await user.type(inputs[1], "400000");
    expect(screen.getByText(/Opening cash doesn't match/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Open Session/i })).toBeDisabled();

    // Correct the secondary amount → warning clears, POST includes both amounts.
    await user.clear(inputs[1]);
    await user.type(inputs[1], "500000");
    expect(screen.queryByText(/Opening cash doesn't match/i)).not.toBeInTheDocument();

    const openButton = screen.getByRole("button", { name: /Open Session/i });
    expect(openButton).not.toBeDisabled();
    await user.click(openButton);

    const postCall = apiFetchMock.mock.calls.find(
      ([url, opts]) =>
        url === "/api/cash-sessions" &&
        (opts as RequestInit | undefined)?.method === "POST",
    );
    expect(postCall).toBeTruthy();
    const body = JSON.parse((postCall![1] as RequestInit).body as string) as {
      opening_cash: number;
      opening_cash_secondary: number;
    };
    expect(body.opening_cash).toBe(100);
    expect(body.opening_cash_secondary).toBe(500000);
  });
});

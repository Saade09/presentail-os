import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const EMPTY_KPIS = {
  openCount: 0,
  pendingCount: 0,
  flaggedCount: 0,
  overdueCount: 0,
  openHeldByCurrency: [],
  flaggedDiffByCurrency: [],
  differenceByCurrency: [],
  attentionSessions: [],
  myOpenSession: null,
  filterOptions: { drawers: [], currencies: [], operators: [] },
};

const { kpisState, sessionsState, refetchKpis, refetchSessions } = vi.hoisted(() => ({
  kpisState: {
    data: {
      openCount: 0,
      pendingCount: 0,
      flaggedCount: 0,
      overdueCount: 0,
      openHeldByCurrency: [],
      flaggedDiffByCurrency: [],
      differenceByCurrency: [],
      attentionSessions: [],
      myOpenSession: null,
      filterOptions: { drawers: [], currencies: [], operators: [] },
    },
    isLoading: false,
    isError: false,
    error: null as unknown,
  },
  sessionsState: {
    data: { sessions: [], total_count: 0, page: 1, page_size: 20 },
    isLoading: false,
    isError: false,
    error: null as unknown,
  },
  refetchKpis: vi.fn(),
  refetchSessions: vi.fn(),
}));

vi.mock("wouter", () => ({
  useSearch: () => "",
  useLocation: () => ["/cash-sessions", vi.fn()],
}));

vi.mock("@/lib/queryClient", () => ({
  apiFetch: vi.fn(),
  isAccessRequestError: (error: unknown) =>
    [401, 403].includes((error as { status?: number } | null)?.status ?? 0),
}));

vi.mock("@/hooks/use-workspace-role", () => ({
  useWorkspaceRole: () => ({
    isOwner: false,
    allowedPages: ["cash-sessions"],
  }),
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, options?: { count?: number }) =>
      options?.count === undefined ? key : `${key}:${options.count}`,
  }),
}));

vi.mock("@tanstack/react-query", () => ({
  useQuery: ({ queryKey }: { queryKey: unknown[] }) =>
    queryKey[0] === "cash-sessions-kpis"
      ? { ...kpisState, refetch: refetchKpis }
      : { ...sessionsState, refetch: refetchSessions },
}));

import CashSessions from "./CashSessions";

beforeEach(() => {
  vi.clearAllMocks();
  Object.assign(kpisState, {
    data: EMPTY_KPIS,
    isLoading: false,
    isError: false,
    error: null,
  });
  Object.assign(sessionsState, {
    data: { sessions: [], total_count: 0, page: 1, page_size: 20 },
    isLoading: false,
    isError: false,
    error: null,
  });
});

describe("Cash Sessions page load states", () => {
  it("keeps the genuine empty state for successful empty responses", () => {
    render(<CashSessions />);

    expect(screen.getByText("cashSessions.emptyTitle")).toBeInTheDocument();
    expect(screen.queryByTestId("cash-sessions-load-error")).not.toBeInTheDocument();
  });

  it("shows a transient load error and retries both dashboard requests", async () => {
    sessionsState.isError = true;
    sessionsState.error = Object.assign(new Error("unavailable"), { status: 500 });
    const user = userEvent.setup();

    render(<CashSessions />);

    expect(screen.getByText("cashSessions.loadError")).toBeInTheDocument();
    expect(screen.queryByText("cashSessions.emptyTitle")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "cashSessions.retry" }));
    expect(refetchKpis).toHaveBeenCalledOnce();
    expect(refetchSessions).toHaveBeenCalledOnce();
  });

  it("shows access guidance when either protected request is rejected", () => {
    kpisState.isError = true;
    kpisState.error = Object.assign(new Error("no_access"), { status: 403 });

    render(<CashSessions />);

    expect(screen.getByText("cashSessions.accessError")).toBeInTheDocument();
    expect(screen.getByText("cashSessions.accessErrorHint")).toBeInTheDocument();
    expect(screen.queryByText("cashSessions.emptyTitle")).not.toBeInTheDocument();
  });
});
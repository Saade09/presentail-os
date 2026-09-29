import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const { ordersState, refetchOrders, workspaceRole } = vi.hoisted(() => ({
  ordersState: {
    data: { orders: [], total: 0, limit: 50, offset: 0 },
    isLoading: false,
    isError: false,
    error: null as unknown,
  },
  refetchOrders: vi.fn(),
  workspaceRole: {
    isOwner: false,
    allowedPages: ["orders"] as string[] | null,
  },
}));

vi.mock("wouter", () => ({
  Link: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  useSearch: () => "",
  useLocation: () => ["/orders", vi.fn()],
}));

vi.mock("@/lib/queryClient", () => ({
  apiFetch: vi.fn(),
  isAccessRequestError: (error: unknown) =>
    [401, 403].includes((error as { status?: number } | null)?.status ?? 0),
}));

vi.mock("@/components/CreateOrderWizard", () => ({
  CreateOrderWizard: () => null,
}));

vi.mock("@/hooks/use-toast", () => ({
  useToast: () => ({ toast: vi.fn() }),
}));

vi.mock("@/hooks/use-workspace-role", () => ({
  useWorkspaceRole: () => workspaceRole,
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock("@tanstack/react-query", () => ({
  useQuery: ({ queryKey }: { queryKey: unknown[] }) =>
    queryKey[0] === "orders"
      ? { ...ordersState, refetch: refetchOrders }
      : { data: queryKey[0] === "orders-delivery-slots" ? { slots: [] } : { drivers: [] } },
  useMutation: () => ({ mutate: vi.fn(), isPending: false }),
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
  keepPreviousData: (previous: unknown) => previous,
}));

import OrdersPage from "./Orders";

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  ordersState.data = { orders: [], total: 0, limit: 50, offset: 0 };
  ordersState.isLoading = false;
  ordersState.isError = false;
  ordersState.error = null;
  workspaceRole.isOwner = false;
  workspaceRole.allowedPages = ["orders"];
});

describe("Orders page load states", () => {
  it("shows the true empty state only after a successful empty response", () => {
    render(<OrdersPage />);

    expect(screen.getByText("orders.empty")).toBeInTheDocument();
    expect(screen.queryByTestId("orders-load-error")).not.toBeInTheDocument();
  });

  it("keeps Create Order for editors without showing the bulk Tookan action", () => {
    render(<OrdersPage />);

    expect(screen.getByTestId("button-open-create-order")).toBeInTheDocument();
    expect(screen.queryByTestId("button-backfill-tookan")).not.toBeInTheDocument();
    expect(screen.queryByText("orders.tookanSendAll")).not.toBeInTheDocument();
  });

  it("does not show either header action to users who cannot edit orders", () => {
    workspaceRole.allowedPages = [];

    render(<OrdersPage />);

    expect(screen.queryByTestId("button-open-create-order")).not.toBeInTheDocument();
    expect(screen.queryByTestId("button-backfill-tookan")).not.toBeInTheDocument();
  });

  it("shows a load error instead of zero orders and retries the failed request", async () => {
    ordersState.isError = true;
    ordersState.error = Object.assign(new Error("server failed"), { status: 500 });
    const user = userEvent.setup();

    render(<OrdersPage />);

    expect(screen.getByText("orders.loadError")).toBeInTheDocument();
    expect(screen.queryByText("orders.empty")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "orders.retry" }));
    expect(refetchOrders).toHaveBeenCalledOnce();
  });

  it("shows actionable access guidance for rejected requests", () => {
    ordersState.isError = true;
    ordersState.error = Object.assign(new Error("no_access"), { status: 403 });

    render(<OrdersPage />);

    expect(screen.getByText("orders.accessError")).toBeInTheDocument();
    expect(screen.getByText("orders.accessErrorHint")).toBeInTheDocument();
    expect(screen.queryByText("orders.empty")).not.toBeInTheDocument();
  });
});
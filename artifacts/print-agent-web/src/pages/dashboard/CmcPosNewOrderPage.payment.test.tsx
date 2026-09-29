import { describe, expect, it, beforeEach, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const mocks = vi.hoisted(() => ({
  createManualOrder: vi.fn(),
  navigate: vi.fn(),
  toast: vi.fn(),
  apiFetch: vi.fn(),
}));

vi.mock("@clerk/react", () => ({
  useAuth: () => ({ userId: "staff-test" }),
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, fallback?: string) => fallback ?? key,
  }),
}));

vi.mock("@/hooks/use-toast", () => ({
  useToast: () => ({ toast: mocks.toast }),
}));

vi.mock("@/hooks/use-workspace-role", () => ({
  useWorkspaceRole: () => ({
    isOwner: true,
    realIsOwner: true,
    role: "owner",
    allowedPages: null,
    customRoleId: null,
    customRoleIds: [],
    floristLocationId: null,
    loaded: true,
  }),
}));

vi.mock("@workspace/api-client-react", () => ({
  useCreateManualOrder: () => ({
    mutate: mocks.createManualOrder,
    isPending: false,
  }),
}));

vi.mock("@/components/ContactSearchPicker", () => ({
  ContactSearchPicker: () => null,
  contactDisplayName: (contact: { display_name?: string | null }) =>
    contact.display_name ?? "",
}));

vi.mock("@/lib/queryClient", () => ({
  apiFetch: (...args: unknown[]) => mocks.apiFetch(...args),
}));

vi.mock("wouter", () => ({
  Link: ({ children }: { children: React.ReactNode }) => <span>{children}</span>,
  useLocation: () => ["/cmc-pos/new-order", mocks.navigate],
}));

import CmcPosNewOrderPage, { CatalogSheet } from "./CmcPosNewOrderPage";

const DRAFT_KEY = "cmc-pos-new-order-draft:staff-test";

const completeDraft = {
  cart: [
    {
      kind: "custom",
      id: "custom-1",
      name: "Test bouquet",
      unit_price: 25,
      quantity: 1,
      production_instructions: "Make it bright",
      image_url: null,
    },
  ],
  selectedCustomer: {
    id: "customer-1",
    display_name: "Customer One",
    first_name: "Customer",
    last_name: "One",
    email: "customer@example.com",
    phone: "+961 70123456",
  },
  selectedRecipient: {
    id: "recipient-1",
    display_name: "Recipient One",
    first_name: "Recipient",
    last_name: "One",
    email: null,
    phone: "+961 70987654",
  },
  deliveryDay: "2030-01-02T00:00:00.000Z",
  deliveryStartTime: "09:00",
  deliveryEndTime: "11:00",
  paymentMethod: "cash",
};

function renderPage() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <CmcPosNewOrderPage />
    </QueryClientProvider>,
  );
}

function renderCatalogSheet() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <CatalogSheet
        open
        onClose={vi.fn()}
        onAdd={vi.fn()}
        cartItems={[]}
      />
    </QueryClientProvider>,
  );
}

describe("CMC new-order payment methods", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.createManualOrder.mockReset();
    mocks.apiFetch.mockResolvedValue({ products: [], total: 0 });
    localStorage.clear();
  });

  it("renders Cash, Card, and Whish with Cash selected by default", () => {
    renderPage();

    expect(screen.getByTestId("new-order-payment-cash")).toHaveTextContent("Cash");
    expect(screen.getByTestId("new-order-payment-card")).toHaveTextContent("Card");
    expect(screen.getByTestId("new-order-payment-whish")).toHaveTextContent("Whish");
    expect(screen.getByTestId("new-order-payment-cash")).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByTestId("new-order-payment-card")).toHaveAttribute("aria-pressed", "false");
    expect(screen.getByTestId("new-order-payment-whish")).toHaveAttribute("aria-pressed", "false");
  });

  it("loads the product picker through the restricted order catalog", async () => {
    mocks.apiFetch.mockResolvedValue({
      products: [
        {
          id: 77,
          name: "CMC Catalog Bouquet",
          price_usd: "25.00",
          price_aed: "91.75",
          main_image_url: null,
          status: "available",
          sku: "CMC-77",
          has_input_field: false,
          letter_input_enabled: false,
        },
      ],
      total: 1,
      page: 1,
      totalPages: 2,
    });
    renderCatalogSheet();

    await waitFor(() => {
      expect(mocks.apiFetch).toHaveBeenCalledWith(
        expect.stringMatching(/^\/api\/order-catalog\/products\?.*page=1.*pageSize=50/),
      );
    });
    expect(await screen.findByText("CMC Catalog Bouquet")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    await waitFor(() => {
      expect(mocks.apiFetch).toHaveBeenCalledWith(
        expect.stringMatching(/^\/api\/order-catalog\/products\?.*page=2.*pageSize=50/),
      );
    });
  });

  it("shows a loading error instead of an empty catalog when the request fails", async () => {
    mocks.apiFetch.mockRejectedValue(new Error("Forbidden"));
    renderCatalogSheet();

    expect(
      await screen.findByText("Could not load products. Please try again."),
    ).toBeInTheDocument();
    expect(screen.queryByText("No products found")).not.toBeInTheDocument();
  });

  it("selects Whish and presents its human-readable label in the review", async () => {
    renderPage();

    fireEvent.click(screen.getByTestId("new-order-payment-whish"));

    expect(screen.getByTestId("new-order-payment-whish")).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByTestId("new-order-payment-cash")).toHaveAttribute("aria-pressed", "false");
    expect(screen.getByText("Payment method").parentElement).toHaveTextContent("Whish");
    await waitFor(() => {
      expect(JSON.parse(localStorage.getItem(DRAFT_KEY) ?? "{}")).toMatchObject({
        paymentMethod: "whish",
      });
    });
  });

  it("restores Whish from the saved new-order draft", async () => {
    localStorage.setItem(DRAFT_KEY, JSON.stringify({ paymentMethod: "whish" }));

    renderPage();

    await waitFor(() => {
      expect(screen.getByTestId("new-order-payment-whish")).toHaveAttribute("aria-pressed", "true");
    });
    expect(screen.getByText("Payment method").parentElement).toHaveTextContent("Whish");
  });

  it("submits Whish with the existing pending USD payment contract", async () => {
    localStorage.setItem(
      DRAFT_KEY,
      JSON.stringify({ ...completeDraft, paymentMethod: "whish" }),
    );

    renderPage();

    await waitFor(() => {
      expect(screen.getAllByRole("button", { name: /Create order/ })[0]).toBeEnabled();
    });
    fireEvent.click(screen.getAllByRole("button", { name: /Create order/ })[0]);

    expect(mocks.createManualOrder).toHaveBeenCalledTimes(1);
    expect(mocks.createManualOrder.mock.calls[0]?.[0]).toMatchObject({
      data: {
        source: "cmc-pos",
        status: "pending",
        payment: {
          method: "whish",
          status: "pending",
          currency: "USD",
        },
      },
    });
  });

  it("surfaces the API error and keeps the draft when creation fails", async () => {
    localStorage.setItem(DRAFT_KEY, JSON.stringify(completeDraft));
    mocks.createManualOrder.mockImplementation(
      (
        _variables: unknown,
        options?: { onError?: (error: Error) => void },
      ) => {
        options?.onError?.(new Error("Selected customer is no longer available"));
      },
    );

    renderPage();

    await waitFor(() => {
      expect(screen.getAllByRole("button", { name: /Create order/ })[0]).toBeEnabled();
    });
    fireEvent.click(screen.getAllByRole("button", { name: /Create order/ })[0]);

    expect(mocks.toast).toHaveBeenCalledWith({
      title: "orders.co.createError",
      description: "Selected customer is no longer available",
      variant: "destructive",
    });
    expect(JSON.parse(localStorage.getItem(DRAFT_KEY) ?? "{}")).toMatchObject(completeDraft);
    expect(mocks.navigate).not.toHaveBeenCalled();
  });

  it("clears the draft and opens order detail only after creation succeeds", async () => {
    localStorage.setItem(DRAFT_KEY, JSON.stringify(completeDraft));
    mocks.createManualOrder.mockImplementation(
      (
        _variables: unknown,
        options?: { onSuccess?: (data: { id: string }) => void },
      ) => {
        options?.onSuccess?.({ id: "created-order-id" });
      },
    );

    renderPage();

    await waitFor(() => {
      expect(screen.getAllByRole("button", { name: /Create order/ })[0]).toBeEnabled();
    });
    fireEvent.click(screen.getAllByRole("button", { name: /Create order/ })[0]);

    expect(localStorage.getItem(DRAFT_KEY)).toBeNull();
    expect(mocks.navigate).toHaveBeenCalledWith("/orders/created-order-id");
  });
});
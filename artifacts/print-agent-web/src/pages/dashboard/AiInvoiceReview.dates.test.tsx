import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import AiInvoiceReviewPage from "./AiInvoiceReview";

const { apiFetch, getClerkToken } = vi.hoisted(() => ({
  apiFetch: vi.fn(),
  getClerkToken: vi.fn(),
}));

vi.mock("@/lib/queryClient", () => ({ apiFetch, getClerkToken }));
vi.mock("wouter", () => ({
  useLocation: () => ["/ai-invoice-import/21/review", vi.fn()],
  useRoute: () => [true, { id: "21" }],
}));
vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast: vi.fn() }) }));

const invoice = {
  id: 21,
  version: 3,
  review_version: 3,
  entity_id: 2,
  entity_legal_name: "Acme Trading LLC",
  vendor_name: "Acme Supplies",
  invoice_number: "AC-100",
  invoice_date: "2025-03-01T23:00:00.000Z",
  due_date: "2025-03-31T00:00:00.000Z",
  currency: "USD",
  subtotal: "100",
  tax_amount: "5",
  total_amount: "105",
  line_items: [],
};

describe("AiInvoiceReviewPage date fields", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getClerkToken.mockResolvedValue(null);
    let persistedInvoice = invoice;
    apiFetch.mockImplementation((url: string, options?: { method?: string; body?: string }) => {
      if (url.endsWith("/neighbors")) return Promise.resolve({});
      if (url.endsWith("/draft") && options?.method === "PATCH") {
        const body = JSON.parse(options.body ?? "{}");
        persistedInvoice = { ...persistedInvoice, ...body, review_version: 4 };
        return Promise.resolve({
          invoice: persistedInvoice,
          validation: { issues: [] },
        });
      }
      return Promise.resolve({
        invoice: persistedInvoice,
        permissions: { can_edit: true },
      });
    });
  });

  it("renders extracted date-only values and preserves edited days through save and refresh", async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<QueryClientProvider client={client}><AiInvoiceReviewPage /></QueryClientProvider>);

    const invoiceDate = await screen.findByTestId("input-review-invoice_date");
    const dueDate = screen.getByTestId("input-review-due_date");
    expect(invoiceDate).toHaveValue("2025-03-01");
    expect(dueDate).toHaveValue("2025-03-31");

    fireEvent.change(invoiceDate, { target: { value: "2025-03-02" } });
    fireEvent.change(dueDate, { target: { value: "2025-04-01" } });
    fireEvent.click(screen.getByTestId("button-save-review"));

    await waitFor(() => {
      const saveCall = apiFetch.mock.calls.find(([url]) => String(url).endsWith("/draft"));
      expect(JSON.parse(saveCall?.[1]?.body ?? "{}")).toMatchObject({
        invoice_date: "2025-03-02",
        due_date: "2025-04-01",
      });
    });
    await waitFor(() => {
      expect(apiFetch.mock.calls.filter(([url]) => url === "/api/finance/invoice-review/21")).toHaveLength(2);
      expect(invoiceDate).toHaveValue("2025-03-02");
      expect(dueDate).toHaveValue("2025-04-01");
    });
  });

  it("leaves missing and invalid extracted dates empty", async () => {
    apiFetch.mockImplementation((url: string) => url.endsWith("/neighbors")
      ? Promise.resolve({})
      : Promise.resolve({
        invoice: { ...invoice, invoice_date: null, due_date: "not-a-date" },
        permissions: { can_edit: true },
      }));
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<QueryClientProvider client={client}><AiInvoiceReviewPage /></QueryClientProvider>);

    expect(await screen.findByTestId("input-review-invoice_date")).toHaveValue("");
    expect(screen.getByTestId("input-review-due_date")).toHaveValue("");
  });
});
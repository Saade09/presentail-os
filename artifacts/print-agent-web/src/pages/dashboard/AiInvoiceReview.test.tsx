import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import AiInvoiceReviewPage, { displayApprovedCurrency, isNonActionableOdooReviewWarning, normalizeApprovedCurrency } from "./AiInvoiceReview";

const { apiFetch, getClerkToken, setLocation, toast, routeState } = vi.hoisted(() => ({
  apiFetch: vi.fn(),
  getClerkToken: vi.fn(),
  setLocation: vi.fn(),
  toast: vi.fn(),
  routeState: { location: "/ai-invoice-import/21/review", id: "21" },
}));

vi.mock("@/lib/queryClient", () => ({ apiFetch, getClerkToken }));
vi.mock("wouter", () => ({
  useLocation: () => [routeState.location, setLocation],
  useRoute: () => [true, { id: routeState.id }],
}));
vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast }) }));

function review(overrides: Record<string, unknown> = {}) {
  const {
    invoice: invoiceOverrides,
    ...responseOverrides
  } = overrides;
  return {
    entity: { legal_name: "Acme Trading LLC", accounting_system: "wafeq" },
    invoice: {
      id: 21,
      version: 3,
      review_version: 3,
      entity_id: 2,
      entity_legal_name: "Acme Trading LLC",
      original_filename: "acme-invoice.png",
      vendor_name: "Acme Supplies",
      invoice_number: "AC-100",
      invoice_date: "2025-03-01",
      due_date: "2025-03-31",
      currency: "USD",
      subtotal: "100",
      tax_amount: "5",
      total_amount: "105",
      wafeq_supplier_id: "supp_123",
      wafeq_tax_id: "tax_5",
      line_items: [{ description: "Paper", quantity: 2, unit_price: 50, total: 100, wafeq_account_id: "acc_1" }],
      ...((invoiceOverrides as Record<string, unknown>) ?? {}),
    },
    permissions: { can_edit: true, can_approve: true, can_sync: true, can_reject: true, can_delete: true, can_upload_source: true },
    navigation: { previous: 20, next: 22 },
    ...responseOverrides,
  };
}

function renderReview(client = new QueryClient({ defaultOptions: { queries: { retry: false } } })) {
  return render(<QueryClientProvider client={client}><AiInvoiceReviewPage /></QueryClientProvider>);
}

describe("AiInvoiceReviewPage", () => {
  let response: Record<string, unknown>;

  beforeEach(() => {
    vi.clearAllMocks();
    routeState.location = "/ai-invoice-import/21/review";
    routeState.id = "21";
    response = review();
    getClerkToken.mockResolvedValue("review-token");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      blob: () => Promise.resolve(new Blob(["image"], { type: "image/png" })),
    }));
    Object.defineProperty(URL, "createObjectURL", {
      configurable: true,
      value: vi.fn().mockReturnValue("blob:invoice-source"),
    });
    Object.defineProperty(URL, "revokeObjectURL", {
      configurable: true,
      value: vi.fn(),
    });
    vi.spyOn(window, "confirm").mockReturnValue(true);
    apiFetch.mockImplementation((url: string) => {
      if (url.startsWith("/api/suppliers")) return Promise.resolve({ suppliers: [] });
      if (url.includes("/wafeq/suppliers")) return Promise.resolve({ suppliers: [{ id: "supp_14", external_id: "14", name: "Raidan", tax_registration_number: "123", country: "LB" }, { id: "supp_15", external_id: "15", name: "Black Tulip", tax_registration_number: "456", country: "AE" }] });
      if (url.includes("/wafeq/accounts")) return Promise.resolve({ accounts: [{ id: "acc_1", name_en: "Office Supplies", account_code: "6000" }] });
      if (url.includes("/wafeq/tax-rates")) return Promise.resolve({ tax_rates: [{ id: "tax_5", name: "Standard 5%", rate: 5 }] });
      if (url.endsWith("/neighbors")) return Promise.resolve({ previous_id: 20, next_id: 22 });
      if (url.includes("/acknowledge")) return Promise.resolve({ ok: true });
      if (url.includes("/draft") || url.includes("/approve") || url.includes("/retry-sync") || url.endsWith("/sync")) return Promise.resolve({ ok: true });
      return Promise.resolve(response);
    });
  });

  it("normalizes and displays all Lebanese Pound aliases consistently", () => {
    expect(normalizeApprovedCurrency("LBP")).toBe("LBP");
    expect(normalizeApprovedCurrency("Lebanese Pound")).toBe("LBP");
    expect(normalizeApprovedCurrency("ل.ل")).toBe("LBP");
    expect(displayApprovedCurrency("LBP")).toBe("Lebanese Pound / ل.ل");
  });

  it("keeps an approved supplier VAT/TRN mismatch in details without showing it as a review action", async () => {
    response = review({
      entity: { legal_name: "Acme", accounting_system: "odoo" },
      invoice: { review_status: "approved", supplier_id: 100, vendor_tax_number: "OCR-TRN" },
      candidates: [{ id: 100, name: "Approved Supplier" }],
      issues: [{
        issue_key: "supplier_vat_mismatch",
        field: "vendor_tax_number",
        message: "Selected Odoo supplier VAT/TRN conflicts with the reviewed invoice",
        severity: "blocking",
        blocking: true,
      }],
    });
    renderReview();

    await waitFor(() => expect(screen.queryByTestId("banner-review-exceptions")).not.toBeInTheDocument());
    expect(isNonActionableOdooReviewWarning({
      issue_key: "supplier_vat_mismatch",
      field: "vendor_tax_number",
      message: "Selected Odoo supplier VAT/TRN conflicts with the reviewed invoice",
      severity: "warning",
      blocking: false,
    }, "odoo")).toBe(true);
  });

  it("hides Odoo line/subtotal reconciliation warnings but keeps Wafeq and blocking issues actionable", async () => {
    response = review({
      entity: { legal_name: "Presentail SAL", accounting_system: "odoo" },
      issues: [{
        issue_key: "totals.lines",
        field: "subtotal",
        message: "Line items do not reconcile to subtotal",
        severity: "warning",
        blocking: false,
      }],
    });
    renderReview();
    await waitFor(() => expect(screen.queryByTestId("banner-review-exceptions")).not.toBeInTheDocument());
    expect(isNonActionableOdooReviewWarning({
      issue_key: "totals.lines",
      field: "subtotal",
      message: "Line items do not reconcile to subtotal",
      severity: "warning",
      blocking: false,
    }, "odoo")).toBe(true);
    expect(isNonActionableOdooReviewWarning({
      issue_key: "totals.lines",
      field: "subtotal",
      message: "Line items do not reconcile to subtotal",
      severity: "warning",
      blocking: false,
    }, "wafeq")).toBe(false);
    expect(isNonActionableOdooReviewWarning({
      issue_key: "totals.lines",
      field: "subtotal",
      message: "Line items do not reconcile to subtotal",
      severity: "blocking",
      blocking: true,
    }, "odoo")).toBe(false);
  });

  it("renders invoice detail and explains when source coordinates are unavailable", async () => {
    response = review({ source_document: { url: "/source/acme.png", content_type: "image/png", page_count: 1, coordinates_available: false } });
    renderReview();

    expect(await screen.findByTestId("text-detected-supplier")).toHaveTextContent("Detected on invoice: Acme Supplies");
    await waitFor(() =>
      expect(screen.getByTestId("viewer-image")).toHaveAttribute("src", "blob:invoice-source"),
    );
    expect(screen.getByTestId("text-no-coordinates")).toHaveTextContent("Source coordinates are not available");
  });

  it("renders Wafeq-only selection without local ID and disables approval while current blocking issues remain", async () => {
    response = review({ invoice: { wafeq_supplier_id: null, supplier_id: null } });
    renderReview();

    expect(await screen.findByTestId("banner-review-exceptions")).toHaveTextContent("Review unresolved errors before approval");
    expect(screen.getByTestId("button-approve-invoice")).toBeDisabled();

    fireEvent.click(screen.getByTestId("input-resolve-supplier"));
    fireEvent.change(await screen.findByPlaceholderText("Search Wafeq suppliers..."), { target: { value: "Raidan" } });
    fireEvent.click(await screen.findByTestId("button-supplier-candidate-supp_14"));

    await waitFor(() => expect(screen.getByTestId("button-approve-invoice")).toBeEnabled());
  });

  it("renders non-Wafeq provider without wafeq blocker and supports local supplier mapping", async () => {
    response = review({
      entity: { legal_name: "Acme", accounting_system: "other" },
      invoice: { wafeq_supplier_id: null, supplier_id: null, wafeq_tax_id: null, line_items: [{ description: "Paper", quantity: 2, unit_price: 50, total: 100 }] },
      candidates: [{ id: 100, name: "Local Acme Supplies" }]
    });
    renderReview();

    await waitFor(() => expect(screen.getByTestId("button-approve-invoice")).toBeEnabled());

    expect(screen.getByText("Accounting supplier")).toBeInTheDocument();

    // Wafeq supplier mapping should not be rendered
    expect(screen.queryByText("Wafeq Supplier Mapping")).not.toBeInTheDocument();

    fireEvent.click(screen.getByTestId("input-resolve-supplier"));
    fireEvent.change(await screen.findByPlaceholderText("Search suppliers..."), { target: { value: "Local Acme" } });
    fireEvent.click(await screen.findByTestId("button-supplier-candidate-100"));

    expect(screen.getByTestId("input-resolve-supplier")).toHaveTextContent("Local Acme Supplies");
  });

  it("opens Add supplier with extracted supplier fields prefilled", async () => {
    response = review({
      entity: { legal_name: "Acme", accounting_system: "other", country: "LB" },
      invoice: {
        vendor_name: "Extracted Vendor SAL",
        vendor_tax_number: "LB-123",
        billing_country: "AE",
        supplier_id: null,
      },
    });
    renderReview();

    fireEvent.click(await screen.findByTestId("button-add-supplier"));

    expect(screen.getByTestId("input-new-supplier-name")).toHaveValue("Extracted Vendor SAL");
    expect(screen.getByTestId("input-new-supplier-tax_number")).toHaveValue("LB-123");
    expect(screen.getByTestId("input-new-supplier-country")).toHaveValue("AE");
    expect(screen.getByTestId("input-new-supplier-billing_address")).toBeInTheDocument();
    expect(screen.getByTestId("input-new-supplier-contact_phone")).toBeInTheDocument();
    expect(screen.getByTestId("input-new-supplier-contact_email")).toBeInTheDocument();
  });

  it("creates and links a supplier, then PATCHes the current review version", async () => {
    response = review({
      entity: { legal_name: "Acme", accounting_system: "other" },
      invoice: { supplier_id: null },
    });
    const calls: Array<[string, RequestInit?]> = [];
    apiFetch.mockImplementation((url: string, options?: RequestInit) => {
      calls.push([url, options]);
      if (url === "/api/suppliers" && options?.method === "POST") {
        return Promise.reject(Object.assign(new Error("A supplier already exists"), {
          status: 409,
          body: { existingId: 702 },
        }));
      }
      if (url.includes("/draft")) {
        const savedInvoice = { ...((response.invoice as Record<string, unknown>) ?? {}), supplier_id: 702, review_version: 4 };
        response = { ...response, invoice: savedInvoice };
        return Promise.resolve({ invoice: savedInvoice });
      }
      if (url.startsWith("/api/suppliers")) return Promise.resolve({ suppliers: [] });
      return Promise.resolve(response);
    });
    renderReview();
    fireEvent.click(await screen.findByTestId("button-add-supplier"));
    fireEvent.change(screen.getByTestId("input-new-supplier-name"), { target: { value: "Acme Supplies" } });
    fireEvent.click(screen.getByTestId("button-create-supplier"));

    await waitFor(() => expect(screen.getByTestId("input-resolve-supplier")).toHaveTextContent("Acme Supplies"));
    const draftCall = calls.find(([url, options]) => url.includes("/draft") && options?.method === "PATCH");
    expect(draftCall).toBeDefined();
    expect(JSON.parse(String(draftCall?.[1]?.body))).toMatchObject({ supplier_id: 702, version: 3 });
  });

  it("reuses an exact supplier returned by the canonical create endpoint without duplicating it", async () => {
    response = review({
      entity: { legal_name: "Acme", accounting_system: "other" },
      invoice: { supplier_id: null },
    });
    const calls: Array<[string, RequestInit?]> = [];
    apiFetch.mockImplementation((url: string, options?: RequestInit) => {
      calls.push([url, options]);
      if (url === "/api/suppliers" && options?.method === "POST") {
        return Promise.reject(Object.assign(new Error("A supplier already exists"), {
          status: 409,
          body: { existingId: 702 },
        }));
      }
      if (url.includes("/draft")) {
        const savedInvoice = { ...((response.invoice as Record<string, unknown>) ?? {}), supplier_id: 702, review_version: 4 };
        response = { ...response, invoice: savedInvoice };
        return Promise.resolve({ invoice: savedInvoice });
      }
      if (url.startsWith("/api/suppliers")) return Promise.resolve({ suppliers: [] });
      return Promise.resolve(response);
    });
    renderReview();
    fireEvent.click(await screen.findByTestId("button-add-supplier"));
    fireEvent.click(screen.getByTestId("button-create-supplier"));

    await waitFor(() => expect(screen.getByTestId("input-resolve-supplier")).toHaveTextContent("Acme Supplies"));
    expect(calls.filter(([url, options]) => url === "/api/suppliers" && options?.method === "POST")).toHaveLength(1);
    expect(calls.some(([url, options]) => url.includes("/draft") && options?.method === "PATCH")).toBe(true);
  });

  it("uses server-side supplier search results beyond the initial invoice candidates", async () => {
    response = review({
      entity: { legal_name: "Acme", accounting_system: "other" },
      invoice: { supplier_id: null },
      supplier_candidates: [{ id: 100, name: "Initial Candidate" }],
    });
    const searchUrls: string[] = [];
    apiFetch.mockImplementation((url: string) => {
      if (url.includes("/finance/suppliers/search")) {
        searchUrls.push(url);
        return Promise.resolve({ suppliers: [{ id: 999, name: "Archived Candidate's Active Alias" }] });
      }
      if (url.startsWith("/api/suppliers")) return Promise.resolve({ suppliers: [] });
      return Promise.resolve(response);
    });
    renderReview();
    fireEvent.click(await screen.findByTestId("input-resolve-supplier"));
    fireEvent.change(await screen.findByPlaceholderText("Search suppliers..."), { target: { value: "Alias" } });

    expect(await screen.findByTestId("button-supplier-candidate-999")).toBeInTheDocument();
    expect(searchUrls.some(url => url.includes("q=Alias") && url.includes("entity_id=2"))).toBe(true);
  });

  it("hides an Odoo line-total arithmetic mismatch while keeping approval enabled", async () => {
    response = review({
      entity: { legal_name: "Acme", accounting_system: "odoo" },
      invoice: {
        supplier_id: 100,
        subtotal: 100,
        tax_amount: 5,
        total_amount: 105,
        line_items: [{ description: "Paper", quantity: 2, unit_price: 60, total: 120 }],
      },
      candidates: [{ id: 100, name: "Local Supplier" }],
      issues: [],
    });
    renderReview();

    await waitFor(() => expect(screen.getByTestId("button-approve-invoice")).toBeEnabled());
    expect(screen.queryByTestId("banner-review-exceptions")).not.toBeInTheDocument();
  });

  it("does not leak a created supplier into the next invoice review", async () => {
    response = review({
      entity: { legal_name: "Acme", accounting_system: "other" },
      invoice: { supplier_id: null },
    });
    apiFetch.mockImplementation((url: string) => {
      if (url.includes("/api/finance/invoice-review/22")) {
        return Promise.resolve(review({
          entity: { legal_name: "Second Entity", accounting_system: "other" },
          invoice: { id: 22, vendor_name: "Second Vendor", supplier_id: null },
          candidates: [],
        }));
      }
      if (url.startsWith("/api/suppliers")) {
        return Promise.resolve({ supplier: { id: 703, name: "First Invoice Supplier", display_name: "First Invoice Supplier" } });
      }
      if (url.includes("/draft")) return Promise.resolve({ ok: true });
      return Promise.resolve(response);
    });
    const rendered = renderReview();
    fireEvent.click(await screen.findByTestId("button-add-supplier"));
    fireEvent.change(screen.getByTestId("input-new-supplier-name"), { target: { value: "First Invoice Supplier" } });
    fireEvent.click(screen.getByTestId("button-create-supplier"));
    await waitFor(() => expect(screen.getByTestId("input-resolve-supplier")).toHaveTextContent("First Invoice Supplier"));

    routeState.id = "22";
    routeState.location = "/ai-invoice-import/22/review";
    rendered.rerender(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><AiInvoiceReviewPage /></QueryClientProvider>);

    await waitFor(() => expect(screen.getByTestId("text-detected-supplier")).toHaveTextContent("Second Vendor"));
    expect(screen.getByTestId("input-resolve-supplier")).toHaveTextContent("Search supplier...");
    expect(screen.getByTestId("input-resolve-supplier")).not.toHaveTextContent("First Invoice Supplier");
  });

  it("replaces a superseded review URL with the canonical invoice ID", async () => {
    response = review({
      requested_invoice_id: 21,
      canonical_invoice_id: 22,
      invoice: { id: 22 },
    });
    renderReview();

    await waitFor(() => expect(setLocation).toHaveBeenCalledWith(
      "/ai-invoice-import/22/review",
      { replace: true },
    ));
    expect(screen.queryByText("Unable to load this invoice.")).not.toBeInTheDocument();
  });

  it("computes tax automatically for Wafeq and keeps tax/total readonly", async () => {
    response = review({
      entity: { legal_name: "Acme Wafeq", accounting_system: "wafeq" },
      invoice: { wafeq_supplier_id: "supp_14", supplier_id: null, wafeq_tax_id: "tax_5", wafeq_account_id: "acc_1", subtotal: 100, tax_amount: 5, total_amount: 105, line_items: [{ description: "Paper", quantity: 2, unit_price: 50, total: 100, wafeq_account_id: "acc_1" }] }
    });
    renderReview();

    await waitFor(() => expect(screen.getByTestId("button-approve-invoice")).toBeEnabled());

    const taxInput = screen.getByTestId("input-review-tax_amount");
    const totalInput = screen.getByTestId("input-review-total_amount");

    expect(taxInput).toHaveAttribute("readonly");
    expect(totalInput).toHaveAttribute("readonly");

    // Add a line to bump subtotal
    fireEvent.click(screen.getByTestId("button-add-line"));

    await waitFor(() => {
      expect(screen.getByTestId("input-review-subtotal")).toHaveValue(100);
    });

    const quantityInputs = screen.getAllByRole("spinbutton").filter(i => (i as HTMLInputElement).value === "2");
    fireEvent.change(quantityInputs[0], { target: { value: "10" } });
    const priceInputs = screen.getAllByRole("spinbutton").filter(i => (i as HTMLInputElement).value === "0");
    fireEvent.change(priceInputs[0], { target: { value: "5" } });

    await waitFor(() => {
      // 100 + (10 * 50) + (1 * 5) = 505 subtotal
      expect(screen.getByTestId("input-review-subtotal")).toHaveValue(505);
      // Tax should recalculate (5% of 505 = 25.25)
      expect(screen.getByTestId("input-review-tax_amount")).toHaveValue(25.25);
      // Total should be 530.25
      expect(screen.getByTestId("input-review-total_amount")).toHaveValue(530.25);
    });
  });

  it("blocks approval on malformed Wafeq tax rates and clears stale server mismatch issues on recomputation", async () => {
    // We intercept tax rates to return a malformed rate for tax_5
    apiFetch.mockImplementation(async (url: string) => {
      if (url.includes("/wafeq/tax-rates")) return { tax_rates: [{ id: "tax_5", name: "Standard 5%", rate: "not a number" }, { id: "tax_good", name: "Good", rate: 10 }] };
      if (url.startsWith("/api/suppliers")) return { suppliers: [] };
      if (url.includes("/wafeq/suppliers")) return { suppliers: [{ id: "supp_14", name: "Raidan", tax_registration_number: "123", country: "LB" }] };
      if (url.includes("/wafeq/accounts")) return { accounts: [{ id: "acc_1", name_en: "Office Supplies", account_code: "6000" }] };
      return review({
        entity: { legal_name: "Acme Wafeq", accounting_system: "wafeq" },
        invoice: { wafeq_supplier_id: "supp_14", wafeq_tax_id: "tax_5", subtotal: 100, tax_amount: 1, total_amount: 101, line_items: [{ description: "Paper", quantity: 2, unit_price: 50, total: 100, wafeq_account_id: "acc_1" }] },
        issues: [
          { id: "mismatch1", issue_key: "wafeq.tax.amount_mismatch", field: "tax_amount", message: "Tax mismatch", severity: "blocking", blocking: true },
          { id: "mismatch2", issue_key: "wafeq.total.amount_mismatch", field: "total_amount", message: "Total mismatch", severity: "blocking", blocking: true }
        ]
      });
    });

    renderReview();

    expect(await screen.findByTestId("banner-review-exceptions")).toHaveTextContent("Review unresolved errors before approval");
    expect(screen.getByTestId("button-approve-invoice")).toBeDisabled();

    // Verify blocking issue is shown for malformed tax
    expect(screen.getByText("Selected tax rate configuration is invalid")).toBeInTheDocument();

    // Server issues should still be visible because we haven't recomputed successfully (or maybe we did, but tax is 0 now and doesn't match 1)

    // Now switch to a good tax rate to clear the invalid config blocker
    const taxTrigger = screen.getByRole("combobox", { name: "VAT / Tax treatment" });
    fireEvent.click(taxTrigger);
    fireEvent.click(await screen.findByText(/Good \(/));

    // Tax recalculates based on 10% rate: subtotal 100 -> tax 10, total 110.
    await waitFor(() => {
      expect(screen.getByTestId("input-review-tax_amount")).toHaveValue(10);
      expect(screen.getByTestId("input-review-total_amount")).toHaveValue(110);
    });

    // The mismatches should disappear and approval should become enabled
    await waitFor(() => expect(screen.getByTestId("button-approve-invoice")).toBeEnabled());
    expect(screen.queryByText("Tax mismatch")).not.toBeInTheDocument();
    expect(screen.queryByText("Total mismatch")).not.toBeInTheDocument();
    expect(screen.queryByText("Selected tax rate configuration is invalid")).not.toBeInTheDocument();
  });

  it("preserves tax across line edit/add/remove for non-Wafeq providers", async () => {
    response = review({
      entity: { legal_name: "Acme", accounting_system: "other" },
      invoice: { wafeq_supplier_id: null, supplier_id: null, wafeq_tax_id: null, subtotal: 100, tax_amount: 15, total_amount: 115, line_items: [{ description: "Paper", quantity: 2, unit_price: 50, total: 100 }] }
    });
    renderReview();

    await waitFor(() => expect(screen.getByTestId("button-approve-invoice")).toBeEnabled());

    // Original tax is 15. We add a line, subtotal goes up, but tax should remain 15.
    fireEvent.click(screen.getByTestId("button-add-line"));

    await waitFor(() => {
      // Find the one for subtotal (should be 100 still because new line has 0 total)
      expect(screen.getByTestId("input-review-subtotal")).toHaveValue(100);
      expect(screen.getByTestId("input-review-tax_amount")).toHaveValue(15);
    });

    // update line quantity
    const quantityInputs = screen.getAllByRole("spinbutton").filter(i => (i as HTMLInputElement).value === "2");
    fireEvent.change(quantityInputs[0], { target: { value: "3" } });

    await waitFor(() => {
      expect(screen.getByTestId("input-review-subtotal")).toHaveValue(150); // 3 * 50 = 150
      expect(screen.getByTestId("input-review-tax_amount")).toHaveValue(15);
    });
  });

  it("leaves semantic server blockers visible until resolved or saved", async () => {
    response = review({
      invoice: { wafeq_supplier_id: "supp_123" },
      issues: [{ id: "dup", issue_key: "dup", field: "invoice_number", message: "Duplicate invoice", severity: "blocking", blocking: true }]
    });
    renderReview();

    expect(await screen.findByTestId("banner-review-exceptions")).toHaveTextContent("Review unresolved errors before approval");
    expect(screen.getByText("Duplicate invoice")).toBeInTheDocument();
    expect(screen.getByTestId("button-approve-invoice")).toBeDisabled();

    // Changing a different field should NOT remove the server blocker for invoice_number
    fireEvent.change(screen.getByTestId("input-review-currency"), { target: { value: "EUR" } });
    expect(screen.getByText("Duplicate invoice")).toBeInTheDocument();

    // Actually fixing it should NOT remove the server blocker either since it's a semantic blocker until saved!
    // But since our test logic for exact mapping was updated, let's verify it remains disabled.
    fireEvent.change(screen.getByTestId("input-review-invoice_number"), { target: { value: "NEW-100" } });
    expect(screen.getByText("Duplicate invoice")).toBeInTheDocument();
    expect(screen.getByTestId("button-approve-invoice")).toBeDisabled();
  });

  it("permanently deletes an invoice entry and returns to the queue", async () => {
    const user = userEvent.setup();
    renderReview();
    await user.click(await screen.findByTestId("button-options"));
    await user.click(await screen.findByTestId("menu-item-delete"));
    await user.click(await screen.findByTestId("button-delete-invoice-confirm"));

    await waitFor(() => expect(apiFetch).toHaveBeenCalledWith(
      "/api/finance/ai-invoice-import/imports/21",
      { method: "DELETE" },
    ));
    expect(toast).toHaveBeenCalledWith({ title: "Invoice entry deleted" });
    expect(setLocation).toHaveBeenCalledWith("/ai-invoice-import");
  });

  it("loads an available scanner PDF with auth and embeds the stored source", async () => {
    response = review({
      invoice: { original_filename: "scanner-invoice.pdf" },
      source_document: {
        available: true,
        url: "/api/finance/invoice-review/21/source",
        content_type: "application/pdf",
        filename: "scanner-invoice.pdf",
        coordinates_available: false,
      },
    });
    const sourceFetch = vi.fn().mockResolvedValue({
      ok: true,
      blob: () => Promise.resolve(new Blob(["%PDF-1.4"], { type: "application/pdf" })),
    });

    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    apiFetch.mockImplementation((url: string, options?: any) => {
      if (url.endsWith("/source") && options?.method === "PUT") {
        const body = options.body as FormData;
        expect(body.get("version")).toBe("3");
        expect(body.get("file")).toEqual(expect.objectContaining({ name: "restored.pdf", type: "application/pdf" }));
        return Promise.resolve({
          source_document: { available: true, url: "/api/finance/invoice-review/21/source", content_type: "application/pdf", filename: "restored.pdf", byte_size: 8 },
          review_version: 4,
        });
      }
      return Promise.resolve(response);
    });
    renderReview();
    const input = await screen.findByTestId("input-upload-source");
    fireEvent.change(input, { target: { files: [new File(["%PDF-1.4"], "restored.pdf", { type: "application/pdf" })] } });

    expect(await screen.findByTestId("viewer-pdf")).toBeInTheDocument();
    expect(screen.queryByTestId("source-unavailable")).not.toBeInTheDocument();
    expect(toast).toHaveBeenCalledWith({ title: expect.stringMatching(/Source attachment (restored|replaced)/) });
  });

  it("opens the source picker from the accessible button for click and keyboard activation", async () => {
    const user = userEvent.setup();
    response = review({ source_document: { available: false, url: null }, permissions: { can_edit: false, can_approve: false, can_delete: false, can_upload_source: true } });
    renderReview();
    const input = await screen.findByTestId("input-upload-source");
    const clickPicker = vi.spyOn(input, "click");
    const button = await screen.findByTestId("button-upload-source");

    await user.click(button);
    expect(clickPicker).toHaveBeenCalledTimes(1);
    button.focus();
    await user.keyboard("{Enter}");
    expect(clickPicker).toHaveBeenCalledTimes(2);
  });

  it("explains why source upload is unavailable", async () => {
    response = review({ source_document: { available: false, url: null }, permissions: { can_edit: false, can_approve: false, can_delete: false, can_upload_source: false } });
    renderReview();

    expect(await screen.findByTestId("button-upload-source")).toBeDisabled();
    expect(await screen.findByTestId("text-source-upload-unavailable")).toHaveTextContent("do not have access");
  });

  it("offers source replacement after a load error and reports upload failure", async () => {
    response = review({ source_document: { available: true, url: "/api/finance/invoice-review/21/source", content_type: "application/pdf" } });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false }));
    apiFetch.mockImplementation((url: string, options?: any) => {
      if (url.endsWith("/neighbors")) return Promise.resolve({});
      if (url.endsWith("/source") && options?.method === "PUT") return Promise.reject(new Error("Only PDF, JPG, PNG, or WEBP files are allowed"));
      return Promise.resolve(response);
    });
    renderReview();
    const replaceButton = await screen.findByTestId("button-replace-source");
    const input = await screen.findByTestId("input-upload-source");
    const clickPicker = vi.spyOn(input, "click");
    fireEvent.click(replaceButton);
    expect(clickPicker).toHaveBeenCalled();
    fireEvent.change(input, { target: { files: [new File(["bad"], "bad.txt", { type: "text/plain" })] } });

    await waitFor(() => expect(toast).toHaveBeenCalledWith(expect.objectContaining({
      title: "Could not replace source attachment",
      description: "Only PDF, JPG, PNG, or WEBP files are allowed",
      variant: "destructive",
    })));
  });

  it("explains that replacement is blocked after accounting sync starts", async () => {
    response = review({
      invoice: { sync_status: "succeeded" },
      source_document: { available: true, url: "/api/finance/invoice-review/21/source", content_type: "application/pdf" },
    });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false }));
    renderReview();

    expect(await screen.findByTestId("button-replace-source")).toBeDisabled();
    expect(await screen.findByTestId("text-source-upload-unavailable")).toHaveTextContent("after accounting sync has started");
  });

  it("keeps a missing source visible and actionable when storage fails", async () => {
    response = review({ source_document: { available: false, url: null } });
    apiFetch.mockImplementation((url: string, options?: any) => {
      if (url.endsWith("/neighbors")) return Promise.resolve({});
      if (url.endsWith("/source") && options?.method === "PUT") return Promise.reject(new Error("Storage is temporarily unavailable; retry."));
      return Promise.resolve(response);
    });
    renderReview();
    const input = await screen.findByTestId("input-upload-source");
    fireEvent.change(input, {
      target: { files: [new File(["%PDF-1.4"], "restored.pdf", { type: "application/pdf" })] },
    });

    await waitFor(() => expect(toast).toHaveBeenCalledWith(expect.objectContaining({
      title: "Could not store source attachment",
      description: "Storage is temporarily unavailable; retry.",
      variant: "destructive",
    })));
    expect(screen.getByTestId("source-unavailable")).toBeInTheDocument();
    expect(screen.getByText("Upload source")).toBeInTheDocument();
  });

  it("does not report storage failure when refresh fails after a successful upload", async () => {
    response = review({ source_document: { available: false, url: null } });
    let detailReads = 0;
    apiFetch.mockImplementation((url: string, options?: any) => {
      if (url.endsWith("/neighbors")) return Promise.resolve({});
      if (url.endsWith("/source") && options?.method === "PUT") return Promise.resolve({
        source_document: { available: true, url: "/api/finance/invoice-review/21/source", content_type: "application/pdf", filename: "restored.pdf" },
        review_version: 4,
      });
      if (url === "/api/finance/invoice-review/21") {
        detailReads++;
        return detailReads === 1 ? Promise.resolve(response) : Promise.reject(new Error("Transient refresh failure"));
      }
      return Promise.resolve(response);
    });
    renderReview();
    const input = await screen.findByTestId("input-upload-source");
    fireEvent.change(input, {
      target: { files: [new File(["%PDF-1.4"], "restored.pdf", { type: "application/pdf" })] },
    });

    await waitFor(() => expect(toast).toHaveBeenCalledWith({ title: "Source attachment restored" }));
    expect(toast).not.toHaveBeenCalledWith(expect.objectContaining({ title: "Could not store source attachment" }));
  });

  it("shows a recoverable error instead of loading forever for an incomplete response", async () => {
    response = {};
    renderReview();

    expect(await screen.findByRole("alert")).toHaveTextContent("The invoice review response was incomplete.");
    expect(screen.getByTestId("button-retry-review")).toBeInTheDocument();
    expect(screen.queryByTestId("status-review-loading")).not.toBeInTheDocument();
  });

  it("loads invoices whose extraction evidence contains null line entries", async () => {
    response = review({
      extraction_provenance: {
        coordinates_available: true,
        fields: {},
        lines: [null, null],
      },
    });
    renderReview();

    expect(await screen.findByTestId("invoice-review-workspace")).toBeInTheDocument();
    expect(await screen.findByTestId("text-detected-supplier")).toHaveTextContent("Acme Supplies");
    expect(screen.queryByTestId("status-review-loading")).not.toBeInTheDocument();
  });

  it("selects extraction evidence overlays", async () => {
    response = review({
      source_document: { url: "/source/acme.png", content_type: "image/png", coordinates_available: true },
      extraction_provenance: { coordinates_available: true, regions: { invoice_number: { x: 10, y: 20, width: 30, height: 8 } } },
    });
    renderReview();

    const overlay = await screen.findByTestId("overlay-region-invoice_number");
    fireEvent.click(overlay);
    expect(overlay.className).toContain("border-emerald-500");
    expect(screen.getByTestId("input-review-invoice_number")).toBeInTheDocument();
  });

  it("protects dirty review navigation until the user confirms", async () => {
    renderReview();
    await screen.findByTestId("input-review-invoice_number");
    fireEvent.change(screen.getByTestId("input-review-invoice_number"), { target: { value: "Changed INV" } });
    vi.mocked(window.confirm).mockReturnValueOnce(false);
    fireEvent.click(screen.getByTestId("button-next-invoice"));
    expect(setLocation).not.toHaveBeenCalled();

    vi.mocked(window.confirm).mockReturnValueOnce(true);
    fireEvent.click(screen.getByTestId("button-next-invoice"));
    expect(setLocation).toHaveBeenCalledWith("/ai-invoice-import/22/review");
  });

  it("shows filtered queue position, preserves context, and disables boundary navigation", async () => {
    routeState.location = "/ai-invoice-import/21/review?entity_id=2&review_status=needs_review&sync_status=not_requested&search=Acme&date_from=2026-01-01&date_to=2026-12-31&limit=50&offset=50&order=created_at_desc";
    apiFetch.mockImplementation((url: string) => {
      if (url.includes("/neighbors")) return Promise.resolve({ previous_id: null, next_id: 22, position: 51, total: 73 });
      if (url.includes("/wafeq/tax-rates")) return Promise.resolve({ tax_rates: [{ id: "tax_5", name: "Standard 5%", rate: 5 }] });
      if (url.includes("/wafeq/accounts")) return Promise.resolve({ accounts: [{ id: "acc_1", name_en: "Office Supplies", account_code: "6000" }] });
      if (url.includes("/wafeq/suppliers")) return Promise.resolve({ suppliers: [] });
      if (url.startsWith("/api/suppliers")) return Promise.resolve({ suppliers: [] });
      return Promise.resolve(response);
    });
    renderReview();

    expect(await screen.findByTestId("text-bill-position")).toHaveTextContent("Bill 51 of 73");
    expect(screen.getByTestId("button-previous-invoice")).toBeDisabled();
    fireEvent.click(screen.getByTestId("button-next-invoice"));
    expect(setLocation).toHaveBeenCalledWith(expect.stringContaining("/ai-invoice-import/22/review?entity_id=2"));
    expect(setLocation).toHaveBeenCalledWith(expect.stringContaining("search=Acme"));
    expect(setLocation).toHaveBeenCalledWith(expect.stringContaining("offset=50"));
  });

  it("uses left and right arrows for bills only outside editable controls", async () => {
    apiFetch.mockImplementation((url: string) => {
      if (url.includes("/neighbors")) return Promise.resolve({ previous_id: 20, next_id: 22, position: 2, total: 3 });
      if (url.includes("/wafeq/tax-rates")) return Promise.resolve({ tax_rates: [{ id: "tax_5", name: "Standard 5%", rate: 5 }] });
      if (url.includes("/wafeq/accounts")) return Promise.resolve({ accounts: [{ id: "acc_1", name_en: "Office Supplies", account_code: "6000" }] });
      if (url.includes("/wafeq/suppliers")) return Promise.resolve({ suppliers: [] });
      if (url.startsWith("/api/suppliers")) return Promise.resolve({ suppliers: [] });
      return Promise.resolve(response);
    });
    renderReview();
    await screen.findByText("Bill 2 of 3");

    fireEvent.keyDown(window, { key: "ArrowRight" });
    expect(setLocation).toHaveBeenCalledWith("/ai-invoice-import/22/review");
    setLocation.mockClear();

    const invoiceNumber = screen.getByTestId("input-review-invoice_number");
    invoiceNumber.focus();
    fireEvent.keyDown(invoiceNumber, { key: "ArrowLeft" });
    expect(setLocation).not.toHaveBeenCalled();
  });

  it("shows immediate lifecycle readiness while informational warnings remain visible", async () => {
    response = review({
      invoice: { review_status: "needs_review", sync_status: "not_requested" },
      issues: [{ issue_key: "info", field: "custom_warning", message: "Optional coding note", severity: "warning", blocking: false }],
    });
    renderReview();

    expect(await screen.findByTestId("badge-invoice-lifecycle")).toHaveTextContent("Ready to sync");
    expect(screen.getByTestId("banner-ready-to-sync")).toHaveTextContent("All required checks passed. This bill is ready to sync with Wafeq.");
    expect(screen.getByText("Optional coding note")).toBeInTheDocument();
    expect(screen.getByTestId("button-approve-invoice")).toBeEnabled();
  });

  it("does not expose per-line account coding fields, columns, or warnings", async () => {
    response = review({
      entity: { legal_name: "Presentail SAL", accounting_system: "odoo" },
      invoice: {
        line_items: [{ description: "Flowers", quantity: 1, unit_price: 100, total: 100 }],
      },
      issues: [{
        issue_key: "account.unmapped.0",
        field: "line_items.0.account_code",
        message: "Line 1 needs an account code",
        severity: "warning",
        blocking: false,
      }],
    });
    renderReview();

    await screen.findByTestId("button-approve-invoice");
    expect(screen.queryByText("Account Code")).not.toBeInTheDocument();
    expect(screen.queryByText("Wafeq Account")).not.toBeInTheDocument();
    expect(screen.queryByPlaceholderText("Account code...")).not.toBeInTheDocument();
    expect(screen.queryByText("Line 1 needs an account code")).not.toBeInTheDocument();
  });

  it("keeps Wafeq per-line account mapping and its required warning", async () => {
    response = review({
      entity: { legal_name: "Acme Wafeq", accounting_system: "wafeq" },
      invoice: {
        wafeq_account_id: null,
        line_items: [{ description: "Flowers", quantity: 1, unit_price: 100, total: 100, wafeq_account_id: null }],
      },
      issues: [],
    });
    renderReview();

    expect(await screen.findByTestId("button-approve-invoice")).toBeDisabled();
    expect(screen.getByText("Wafeq Account")).toBeInTheDocument();
    expect(screen.getByTitle("Account mapping required")).toBeInTheDocument();
    expect(screen.getAllByText("Select account...")).toHaveLength(2);
  });

  it("keeps Odoo-resolvable local mapping issues as warnings while preserving true blockers", async () => {
    response = review({
      entity: { legal_name: "Presentail SAL", accounting_system: "odoo" },
      invoice: {
        review_status: "needs_review",
        sync_status: "not_requested",
        supplier_id: null,
        line_items: [{ description: "Flowers", quantity: 1, unit_price: 100, total: 100, tax_rate: .11 }],
      },
      issues: [
        { issue_key: "supplier.unresolved", field: "supplier_id", message: "Supplier will be resolved from Odoo", severity: "warning", blocking: false },
        { issue_key: "account.unmapped.0", field: "line_items.0.account_code", message: "Account will be resolved from Odoo", severity: "warning", blocking: false },
      ],
    });
    renderReview();

    expect(await screen.findByTestId("badge-invoice-lifecycle")).toHaveTextContent("Ready to sync");
    expect(screen.getByTestId("button-approve-invoice")).toBeEnabled();
    expect(screen.getByText("Supplier will be resolved from Odoo")).toBeInTheDocument();
    expect(screen.queryByText("Account will be resolved from Odoo")).not.toBeInTheDocument();

    response = review({
      entity: { legal_name: "Presentail SAL", accounting_system: "odoo" },
      issues: [{ issue_key: "totals.invoice", field: "total_amount", message: "Subtotal and tax do not reconcile to total", severity: "error", blocking: true }],
    });
    const second = renderReview();
    expect(await screen.findByText("Subtotal and tax do not reconcile to total")).toBeInTheDocument();
    expect(screen.getAllByTestId("button-approve-invoice").at(-1)).toBeDisabled();
    second.unmount();
  });

  it("shows sync failure details and a dedicated retry without enabling approval", async () => {
    response = review({ invoice: { review_status: "approved", sync_status: "failed", error_message: "Wafeq rejected account 6000" } });
    renderReview();

    expect(await screen.findByTestId("badge-invoice-lifecycle")).toHaveTextContent("Sync failed");
    expect(screen.getByTestId("banner-sync-failed")).toHaveTextContent("Wafeq rejected account 6000");
    expect(screen.getByTestId("button-retry-sync")).toBeEnabled();
    expect(screen.getByTestId("button-approve-invoice")).toBeDisabled();
  });

  it("shows syncing immediately and stays on the current bill after successful sync", async () => {
    let finishApproval!: (value: unknown) => void;
    const approval = new Promise((resolve) => { finishApproval = resolve; });
    apiFetch.mockImplementation((url: string) => {
      if (url.includes("/neighbors")) return Promise.resolve({ previous_id: null, next_id: 22, position: 1, total: 2 });
      if (url.includes("/wafeq/tax-rates")) return Promise.resolve({ tax_rates: [{ id: "tax_5", name: "Standard 5%", rate: 5 }] });
      if (url.includes("/wafeq/accounts")) return Promise.resolve({ accounts: [{ id: "acc_1", name_en: "Office Supplies", account_code: "6000" }] });
      if (url.includes("/wafeq/suppliers")) return Promise.resolve({ suppliers: [] });
      if (url.startsWith("/api/suppliers")) return Promise.resolve({ suppliers: [] });
      if (url.includes("/approve")) return approval;
      return Promise.resolve(response);
    });
    renderReview();

    fireEvent.click(await screen.findByTestId("button-approve-invoice"));
    expect(await screen.findByTestId("badge-invoice-lifecycle")).toHaveTextContent("Syncing");
    finishApproval({ invoice: { ...review().invoice, review_status: "approved", review_version: 4 }, sync: { status: "succeeded" } });

    await waitFor(() => expect(screen.getByTestId("badge-invoice-lifecycle")).toHaveTextContent("Synced"));
    expect(setLocation).not.toHaveBeenCalled();
    expect(screen.getByTestId("text-bill-position")).toHaveTextContent("Bill 1 of 2");
  });

  it("acknowledges warnings and then submits approval", async () => {
    response = review({ issues: [{ id: "tax-warning", issue_key: "tax", field: "custom_warning", message: "Tax needs confirmation", severity: "warning" }] });
    renderReview();
    fireEvent.click(await screen.findByTestId("button-acknowledge-issue-tax"));
    await waitFor(() => expect(apiFetch).toHaveBeenCalledWith(expect.stringContaining("/acknowledge"), expect.objectContaining({ method: "POST" })));

    fireEvent.click(screen.getByTestId("button-approve-invoice"));
    await waitFor(() => expect(apiFetch).toHaveBeenCalledWith(expect.stringContaining("/approve"), expect.objectContaining({ method: "POST" })));
  });

  it("allows a page-authorized non-editor to approve and sync without granting rejection", async () => {
    response = review({
      permissions: {
        can_edit: false,
        can_approve: true,
        can_sync: true,
        can_reject: false,
        can_delete: false,
        can_upload_source: true,
      },
    });
    renderReview();

    const approve = await screen.findByTestId("button-approve-invoice");
    expect(approve).toBeEnabled();
    expect(screen.getByTestId("button-reject-invoice")).toBeDisabled();
    fireEvent.click(approve);

    await waitFor(() => expect(apiFetch).toHaveBeenCalledWith(
      expect.stringContaining("/approve"),
      expect.objectContaining({ method: "POST" }),
    ));
  });

  it("disables approval when there are blocking validation issues", async () => {
    response = review({
      invoice: { wafeq_supplier_id: null, supplier_id: null },
      issues: [{ id: "custom", issue_key: "custom", field: "custom_field", message: "Custom field is required", severity: "blocking", blocking: true }]
    });
    renderReview();
    expect(await screen.findByTestId("banner-review-exceptions")).toHaveTextContent("Review unresolved errors before approval");
    expect(await screen.findByText("Custom field is required")).toBeInTheDocument();

    const approve = await screen.findByTestId("button-approve-invoice");
    expect(approve).toBeDisabled();
  });

  it("uses live validation issues when persisted issues are empty", async () => {
    response = review({
      issues: [],
      invoice: {
        invoice_date: null,
      },
      validation: {
        issues: [{
          issue_key: "required.invoice_date",
          field: "invoice_date",
          message: "Invoice date is required",
          severity: "error",
          blocking: true,
        }],
      },
    });
    renderReview();

    expect(await screen.findByText("Invoice date is required")).toBeInTheDocument();
    expect(screen.getByTestId("button-approve-invoice")).toBeDisabled();
  });

  it("makes optimistic conflict errors visible to the reviewer", async () => {
    apiFetch.mockImplementation((url: string) => {
      if (url.endsWith("/neighbors")) return Promise.resolve({});
      if (url.includes("/approve")) return Promise.reject(new Error("Review version conflict; refresh and try again"));
      return Promise.resolve(response);
    });
    renderReview();
    fireEvent.click(await screen.findByTestId("button-approve-invoice"));
    await waitFor(() => expect(toast).toHaveBeenCalledWith(expect.objectContaining({
      title: "Action could not be completed",
      description: "Review version conflict; refresh and try again",
      variant: "destructive",
    })));
  });

  it("retries failed accounting sync using the retry endpoint", async () => {
    response = review({ invoice: { review_status: "approved", sync_status: "failed" } });
    apiFetch.mockImplementation((url: string) => {
      if (url.endsWith("/neighbors")) return Promise.resolve({});
      if (url.includes("/retry-sync")) {
        return Promise.resolve({
          success: true,
          destination: "odoo",
          sync: { status: "succeeded", destination: "odoo", external_reference: "odoo-retry-21" },
        });
      }
      return Promise.resolve(response);
    });
    renderReview();
    const retry = await screen.findByTestId("button-retry-sync");
    expect(retry).toHaveTextContent("Retry");
    expect(screen.getByTestId("button-approve-invoice")).toBeDisabled();
    fireEvent.click(retry);
    await waitFor(() => expect(apiFetch).toHaveBeenCalledWith(expect.stringContaining("/retry-sync"), expect.objectContaining({ method: "POST" })));
    expect(toast).toHaveBeenCalledWith({ title: "Invoice synced with Odoo" });
  });

  it("returns an unapproved failed invoice to approve and sync", async () => {
    response = review({ invoice: { review_status: "needs_review", sync_status: "failed" } });
    renderReview();

    const approve = await screen.findByTestId("button-approve-invoice");
    expect(approve).toHaveTextContent("Approve & sync");
    fireEvent.click(approve);

    await waitFor(() => expect(apiFetch).toHaveBeenCalledWith(
      expect.stringContaining("/approve"),
      expect.objectContaining({ method: "POST" }),
    ));
    expect(apiFetch).not.toHaveBeenCalledWith(
      expect.stringContaining("/retry-sync"),
      expect.anything(),
    );
  });

  it("syncs an already-approved invoice that has not been submitted", async () => {
    response = review({ invoice: { review_status: "approved", sync_status: "not_requested" } });
    renderReview();

    const sync = await screen.findByTestId("button-sync-now");
    expect(sync).toHaveTextContent("Sync now");
    fireEvent.click(sync);

    await waitFor(() => expect(apiFetch).toHaveBeenCalledWith(
      "/api/finance/invoice-review/21/sync",
      expect.objectContaining({ method: "POST" }),
    ));
  });

  it("recalculates total based on bill-level tax and preserves extracted reconciliation", async () => {
    response = review({ invoice: { subtotal: "100", tax_amount: "5", total_amount: "105", wafeq_tax_id: "tax_5", line_items: [{ description: "Item", quantity: 1, unit_price: 100, total: 100, wafeq_account_id: "acc_1" }] } });
    renderReview();

    const inputs = await screen.findAllByDisplayValue("1");
    fireEvent.change(inputs[0], { target: { value: "2" } });

    expect(screen.getByTestId("input-review-subtotal")).toHaveValue(200);
    expect(screen.getByTestId("input-review-tax_amount")).toHaveValue(10);
    expect(screen.getByTestId("input-review-total_amount")).toHaveValue(210);

    expect(screen.getByText("100.00")).toBeInTheDocument();
  });

  it("applies the configured bill-level rate uniformly and supports No VAT", async () => {
    response = review({
      invoice: {
        subtotal: "81",
        tax_amount: "0",
        total_amount: "81",
        wafeq_tax_id: null,
        line_items: [{ description: "Item", quantity: 1, unit_price: 81, total: 81, wafeq_account_id: "acc_1" }],
      },
    });
    apiFetch.mockImplementation((url: string) => {
      if (url.includes("/wafeq/tax-rates")) return Promise.resolve({ tax_rates: [{ id: "tax_11", name: "Configured Lebanon VAT", rate: 11 }] });
      if (url.endsWith("/neighbors")) return Promise.resolve({ previous_id: 20, next_id: 22 });
      if (url.includes("/wafeq/accounts")) return Promise.resolve({ accounts: [{ id: "acc_1", name_en: "Office Supplies", account_code: "6000" }] });
      return Promise.resolve(response);
    });
    renderReview();

    fireEvent.click(await screen.findByTestId("input-review-wafeq_tax_id"));
    fireEvent.click(await screen.findByText("Configured Lebanon VAT (11%)"));
    expect(screen.getByTestId("input-review-subtotal")).toHaveValue(81);
    expect(screen.getByTestId("input-review-tax_amount")).toHaveValue(8.91);
    expect(screen.getByTestId("input-review-total_amount")).toHaveValue(89.91);

    fireEvent.click(screen.getByTestId("input-review-wafeq_tax_id"));
    fireEvent.click(await screen.findByText("No VAT (0%)"));
    expect(screen.getByTestId("input-review-tax_amount")).toHaveValue(0);
    expect(screen.getByTestId("input-review-total_amount")).toHaveValue(81);
  });

  it("groups supplier, metadata, bill VAT, and optional reference inside Bill Details", async () => {
    response = review({
      invoice: {
        manual_accounting_reference: "PO-42",
        wafeq_supplier_id: "supp_14",
        wafeq_tax_id: "tax_5",
      },
    });
    renderReview();

    expect(await screen.findByTestId("bill-accounting-supplier")).toHaveTextContent("Accounting supplier");
    expect(screen.getByTestId("bill-accounting-supplier")).toHaveTextContent("Matched");
    expect(screen.getByTestId("bill-metadata-row")).toContainElement(screen.getByTestId("input-review-invoice_number"));
    expect(screen.getByTestId("bill-metadata-row")).toContainElement(screen.getByTestId("input-review-invoice_date"));
    expect(screen.getByTestId("bill-metadata-row")).toContainElement(screen.getByTestId("input-review-due_date"));
    expect(screen.getByTestId("bill-currency-vat-row")).toContainElement(screen.getByTestId("input-review-currency"));
    expect(screen.getByTestId("bill-currency-vat-row")).toContainElement(screen.getByTestId("input-review-wafeq_tax_id"));
    expect(screen.getByText("Applies to the entire bill.")).toBeInTheDocument();
    expect(screen.getByTestId("bill-reference-row")).toContainElement(screen.getByTestId("input-review-manual_accounting_reference"));
  });


});

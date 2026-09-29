import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, within } from "@testing-library/react";
import AiInvoiceImportPage from "./AiInvoiceImport";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

type Supplier = {
  id: number;
  name: string;
  display_name: string | null;
  tax_number: string | null;
  billing_address: string | null;
};

let suppliersFixture: Supplier[] = [];

const mockUseQuery = vi.fn();
const mockUseMutation = vi.fn();
const mockInvalidateQueries = vi.fn();

vi.mock("@tanstack/react-query", () => ({
  QueryClient: class QueryClient {
    getQueryData() { return undefined; }
    setQueryData() {}
    invalidateQueries() {}
    getQueryCache() { return { subscribe: () => () => {} }; }
  },
  QueryCache: class QueryCache {
    subscribe() { return () => {}; }
  },
  useQuery: (opts: { queryKey: unknown[] }) => mockUseQuery(opts),
  useMutation: (opts: { mutationFn: () => Promise<unknown>; onSuccess?: unknown; onError?: unknown }) =>
    mockUseMutation(opts),
  useQueryClient: () => ({ invalidateQueries: mockInvalidateQueries }),
}));

let stubIsOwner = true;
vi.mock("@/hooks/use-workspace-role", () => ({
  useWorkspaceRole: () => ({ isOwner: stubIsOwner, allowedPages: null }),
}));

vi.mock("@/hooks/use-toast", () => ({
  useToast: () => ({ toast: vi.fn() }),
}));

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const ENTITY = {
  id: 3,
  legal_name: "My Company Ltd",
  display_name: "My Company",
  country: "US",
  tax_registration_number: null,
  accounting_system: "odoo",
  odoo_base_url: "https://odoo.example.com",
  odoo_company_name: "My Company",
  odoo_company_id: 1,
  odoo_database: "mycompany",
  default_currency: "USD",
  is_active: true,
  odoo_integration_configured: true,
};

function makeInvoice() {
  return {
    id: 7,
    entity_id: 3,
    status: "extracted",
    original_filename: "invoice.pdf",
    vendor_name: "Acme Corp",
    invoice_number: "INV-001",
    invoice_date: "2026-01-15",
    due_date: "2026-02-15",
    currency: "USD",
    total_amount: "105.00",
    subtotal: "100.00",
    tax_amount: "5.00",
    confidence: "0.95",
    company_validation_status: "matched",
    company_validation_notes: null,
    odoo_bill_url: null,
    odoo_bill_id: null,
    error_message: null,
    created_at: "2026-01-15T08:00:00Z",
    entity_legal_name: "My Company Ltd",
    entity_accounting_system: "odoo",
    line_items: [],
    vendor_address: null,
    vendor_tax_number: null,
    manually_entered_at: null,
    manual_accounting_reference: null,
    is_reviewed: false,
    reviewed_at: null,
    processing_step: "extract",
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const noop = { mutate: vi.fn(), isPending: false };

function setupMocks() {
  stubIsOwner = true;
  mockUseMutation.mockReturnValue(noop);

  mockUseQuery.mockImplementation((opts: { queryKey: unknown[] }) => {
    const key = opts.queryKey[0];
    if (key === "finance-entities") {
      return { data: [ENTITY], isLoading: false, refetch: vi.fn() };
    }
    if (key === "finance-imports") {
      return { data: { imports: [makeInvoice()], total: 1 }, isLoading: false, refetch: vi.fn() };
    }
    if (key === "suppliers-combobox") {
      const search = String(opts.queryKey[1] ?? "").trim().toLowerCase();
      const filtered = search
        ? suppliersFixture.filter((s) =>
            (s.display_name || s.name).toLowerCase().includes(search),
          )
        : suppliersFixture;
      return { data: { suppliers: filtered }, isFetching: false, refetch: vi.fn() };
    }
    return { data: undefined, isLoading: false, isFetching: false, refetch: vi.fn() };
  });
}

function openVendorPicker() {
  const row = screen.getByText("Acme Corp").closest("tr");
  if (!row) throw new Error("Import row not found");
  fireEvent.click(row);
  fireEvent.click(screen.getByRole("button", { name: /edit fields/i }));
  fireEvent.click(screen.getByRole("combobox", { name: /vendor name/i }));
}

function typeSearch(text: string) {
  const input = screen.getByPlaceholderText(/search or type a vendor/i);
  fireEvent.change(input, { target: { value: text } });
  return input;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("AiInvoiceImportPage – Vendor supplier picker", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    suppliersFixture = [
      { id: 1, name: "Acme Inc", display_name: null, tax_number: "TRN-ACME", billing_address: "1 Acme Way" },
      { id: 2, name: "Beta LLC", display_name: "Beta Supplies", tax_number: "TRN-BETA", billing_address: "100 Beta St" },
      { id: 3, name: "Gamma Co", display_name: null, tax_number: "TRN-GAMMA", billing_address: "200 Gamma Rd" },
    ];
    setupMocks();
  });

  it("typing filters the supplier list and selecting one auto-fills TRN + address", () => {
    render(<AiInvoiceImportPage />);
    openVendorPicker();

    // All suppliers visible before filtering
    expect(screen.getByText("Beta Supplies")).toBeInTheDocument();
    expect(screen.getByText("Gamma Co")).toBeInTheDocument();

    // Typing filters the list down to the matching supplier
    typeSearch("Beta");
    expect(screen.getByText("Beta Supplies")).toBeInTheDocument();
    expect(screen.queryByText("Gamma Co")).toBeNull();

    // Selecting the supplier sets vendor_name and auto-fills TRN + address
    fireEvent.click(screen.getByText("Beta Supplies"));

    expect(screen.getByRole("combobox", { name: /vendor name/i })).toHaveTextContent("Beta Supplies");
    expect(screen.getByDisplayValue("TRN-BETA")).toBeInTheDocument();
    expect(screen.getByDisplayValue("100 Beta St")).toBeInTheDocument();
  });

  it("allows free-form entry when the typed name matches no supplier", () => {
    render(<AiInvoiceImportPage />);
    openVendorPicker();

    typeSearch("Zeta Supplies");
    // No matching supplier rows
    expect(screen.queryByText("Beta Supplies")).toBeNull();

    // The "Use …" affordance commits the typed text as a free-form vendor name
    fireEvent.click(screen.getByText(/use\s*[“"]?Zeta Supplies/i));

    expect(screen.getByRole("combobox", { name: /vendor name/i })).toHaveTextContent("Zeta Supplies");
    // TRN + address are left untouched (no supplier was selected)
    expect(screen.queryByDisplayValue("TRN-BETA")).toBeNull();
  });

  it("accepts free text gracefully when the suppliers list is empty", () => {
    suppliersFixture = [];
    render(<AiInvoiceImportPage />);
    openVendorPicker();

    expect(screen.getByText(/no suppliers found/i)).toBeInTheDocument();

    typeSearch("Brand New Vendor");
    fireEvent.click(screen.getByText(/use\s*[“"]?Brand New Vendor/i));

    expect(screen.getByRole("combobox", { name: /vendor name/i })).toHaveTextContent("Brand New Vendor");
  });
});

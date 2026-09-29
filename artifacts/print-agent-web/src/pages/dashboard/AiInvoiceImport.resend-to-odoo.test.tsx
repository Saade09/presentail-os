import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import AiInvoiceImportPage from "./AiInvoiceImport";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

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

function makeInvoice(overrides: Partial<{
  id: number;
  status: string;
  is_reviewed: boolean;
  entity_accounting_system: string;
}> = {}) {
  return {
    id: 7,
    entity_id: 3,
    status: "sent_to_odoo",
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
    odoo_bill_url: "https://odoo.example.com/bills/42",
    odoo_bill_id: "bill_42",
    error_message: null,
    created_at: "2026-01-15T08:00:00Z",
    entity_legal_name: "My Company Ltd",
    entity_accounting_system: "odoo",
    line_items: [],
    vendor_address: null,
    vendor_tax_number: null,
    manually_entered_at: null,
    manual_accounting_reference: null,
    is_reviewed: true,
    reviewed_at: "2026-01-20T10:00:00Z",
    processing_step: "send_to_odoo",
    ...overrides,
  };
}

const INVOICE = makeInvoice();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const noop = { mutate: vi.fn(), isPending: false };

function setupMocks(options: { isOwner?: boolean } = {}) {
  stubIsOwner = options.isOwner ?? true;

  mockUseMutation.mockReturnValue(noop);

  mockUseQuery.mockImplementation((opts: { queryKey: unknown[] }) => {
    const key = opts.queryKey[0];
    if (key === "finance-entities") {
      return { data: [ENTITY], isLoading: false, refetch: vi.fn() };
    }
    if (key === "finance-imports") {
      return { data: { imports: [INVOICE], total: 1 }, isLoading: false, refetch: vi.fn() };
    }
    return { data: undefined, isLoading: false, refetch: vi.fn() };
  });
}

function clickImportRow() {
  const row = screen.getByText("Acme Corp").closest("tr");
  if (!row) throw new Error("Import row not found");
  fireEvent.click(row);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("AiInvoiceImportPage – Resend to Odoo button visibility", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setupMocks();
  });

  it("shows the 'Resend to Odoo' button when owner, is_reviewed=true, status=sent_to_odoo, entity odoo configured", () => {
    render(<AiInvoiceImportPage />);

    clickImportRow();

    expect(screen.getByRole("button", { name: /resend to odoo/i })).toBeInTheDocument();
  });

  it("does NOT show 'Resend to Odoo' for a non-owner even with all conditions met", () => {
    setupMocks({ isOwner: false });

    render(<AiInvoiceImportPage />);

    clickImportRow();

    expect(screen.queryByRole("button", { name: /resend to odoo/i })).toBeNull();
  });

  it("does NOT show 'Resend to Odoo' when invoice status is not sent_to_odoo", () => {
    mockUseQuery.mockImplementation((opts: { queryKey: unknown[] }) => {
      const key = opts.queryKey[0];
      if (key === "finance-entities") {
        return { data: [ENTITY], isLoading: false, refetch: vi.fn() };
      }
      if (key === "finance-imports") {
        const invoice = makeInvoice({ status: "extracted" });
        return { data: { imports: [invoice], total: 1 }, isLoading: false, refetch: vi.fn() };
      }
      return { data: undefined, isLoading: false, refetch: vi.fn() };
    });

    render(<AiInvoiceImportPage />);

    clickImportRow();

    expect(screen.queryByRole("button", { name: /resend to odoo/i })).toBeNull();
  });

  it("does NOT show 'Resend to Odoo' when invoice is not yet reviewed", () => {
    mockUseQuery.mockImplementation((opts: { queryKey: unknown[] }) => {
      const key = opts.queryKey[0];
      if (key === "finance-entities") {
        return { data: [ENTITY], isLoading: false, refetch: vi.fn() };
      }
      if (key === "finance-imports") {
        const invoice = makeInvoice({ is_reviewed: false });
        return { data: { imports: [invoice], total: 1 }, isLoading: false, refetch: vi.fn() };
      }
      return { data: undefined, isLoading: false, refetch: vi.fn() };
    });

    render(<AiInvoiceImportPage />);

    clickImportRow();

    expect(screen.queryByRole("button", { name: /resend to odoo/i })).toBeNull();
  });

  it("does NOT show 'Resend to Odoo' when entity accounting system is not odoo", () => {
    const manualEntity = { ...ENTITY, accounting_system: "manual", odoo_integration_configured: false };
    mockUseQuery.mockImplementation((opts: { queryKey: unknown[] }) => {
      const key = opts.queryKey[0];
      if (key === "finance-entities") {
        return { data: [manualEntity], isLoading: false, refetch: vi.fn() };
      }
      if (key === "finance-imports") {
        const invoice = makeInvoice({ entity_accounting_system: "manual" });
        return { data: { imports: [invoice], total: 1 }, isLoading: false, refetch: vi.fn() };
      }
      return { data: undefined, isLoading: false, refetch: vi.fn() };
    });

    render(<AiInvoiceImportPage />);

    clickImportRow();

    expect(screen.queryByRole("button", { name: /resend to odoo/i })).toBeNull();
  });
});

describe("AiInvoiceImportPage – Resend to Odoo button click", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setupMocks();
  });

  it("clicking 'Resend to Odoo' triggers the send-to-odoo mutation", () => {
    const mockMutate = vi.fn();
    mockUseMutation.mockReturnValue({ mutate: mockMutate, isPending: false });

    render(<AiInvoiceImportPage />);

    clickImportRow();

    const button = screen.getByRole("button", { name: /resend to odoo/i });
    fireEvent.click(button);

    expect(mockMutate).toHaveBeenCalled();
  });

  it("the send-to-odoo mutationFn calls the correct endpoint URL", async () => {
    let capturedMutationFn: (() => Promise<unknown>) | null = null;

    mockUseMutation.mockImplementation((opts: { mutationFn: () => Promise<unknown> }) => {
      if (!capturedMutationFn) {
        capturedMutationFn = opts.mutationFn;
      }
      return { mutate: vi.fn(), isPending: false };
    });

    render(<AiInvoiceImportPage />);

    clickImportRow();

    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ success: true, bill_id: "bill_99" }),
    });
    vi.stubGlobal("fetch", mockFetch);

    try {
      expect(capturedMutationFn).not.toBeNull();
      await capturedMutationFn!();

      const [[url]] = mockFetch.mock.calls;
      expect(String(url)).toMatch(/\/api\/finance\/ai-invoice-import\/imports\/7\/send-to-odoo/);
      expect(mockFetch.mock.calls[0][1]).toMatchObject({ method: "POST" });
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

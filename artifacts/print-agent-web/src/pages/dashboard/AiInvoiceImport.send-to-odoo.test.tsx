import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import AiInvoiceImportPage from "./AiInvoiceImport";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockUseQuery = vi.fn();
const mockUseMutation = vi.fn();
const mockInvalidateQueries = vi.fn();
const mockUseAuthedSse = vi.fn();

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

vi.mock("@/hooks/use-authed-sse", () => ({
  useAuthedSse: (...args: unknown[]) => mockUseAuthedSse(...args),
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
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const noop = { mutate: vi.fn(), isPending: false };

function setupMocks(options: { isOwner?: boolean; entity?: typeof ENTITY } = {}) {
  stubIsOwner = options.isOwner ?? true;
  const entity = options.entity ?? ENTITY;

  mockUseMutation.mockReturnValue(noop);

  mockUseQuery.mockImplementation((opts: { queryKey: unknown[] }) => {
    const key = opts.queryKey[0];
    if (key === "finance-entities") {
      return { data: [entity], isLoading: false, refetch: vi.fn() };
    }
    if (key === "finance-imports") {
      return { data: { imports: [makeInvoice()], total: 1 }, isLoading: false, refetch: vi.fn() };
    }
    return { data: undefined, isLoading: false, refetch: vi.fn() };
  });
}

function setupMocksWithInvoice(invoice: ReturnType<typeof makeInvoice>, entity = ENTITY) {
  stubIsOwner = true;
  mockUseMutation.mockReturnValue(noop);

  mockUseQuery.mockImplementation((opts: { queryKey: unknown[] }) => {
    const key = opts.queryKey[0];
    if (key === "finance-entities") {
      return { data: [entity], isLoading: false, refetch: vi.fn() };
    }
    if (key === "finance-imports") {
      return { data: { imports: [invoice], total: 1 }, isLoading: false, refetch: vi.fn() };
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
// Tests – visibility
// ---------------------------------------------------------------------------

describe("AiInvoiceImportPage – Send to Odoo button visibility", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setupMocks();
  });

  it("shows 'Send to Odoo' when entity accounting_system=odoo, odoo_integration_configured=true, status=extracted", () => {
    render(<AiInvoiceImportPage />);
    clickImportRow();
    expect(screen.getByRole("button", { name: /send to odoo/i })).toBeInTheDocument();
  });

  it("shows 'Send to Odoo' when status=needs_review", () => {
    setupMocksWithInvoice(makeInvoice({ status: "needs_review" }));
    render(<AiInvoiceImportPage />);
    clickImportRow();
    expect(screen.getByRole("button", { name: /send to odoo/i })).toBeInTheDocument();
  });

  it("shows 'Retry in Odoo' label when invoice status=failed", () => {
    setupMocksWithInvoice(makeInvoice({ status: "failed" }));
    render(<AiInvoiceImportPage />);
    clickImportRow();
    expect(screen.getByRole("button", { name: /retry in odoo/i })).toBeInTheDocument();
  });

  it("shows 'Send to Odoo' for a non-owner (button is not owner-gated)", () => {
    setupMocks({ isOwner: false });
    render(<AiInvoiceImportPage />);
    clickImportRow();
    expect(screen.getByRole("button", { name: /send to odoo/i })).toBeInTheDocument();
  });

  it("does NOT show 'Send to Odoo' when entity odoo_integration_configured=false", () => {
    const noOdooEntity = { ...ENTITY, odoo_integration_configured: false };
    setupMocksWithInvoice(makeInvoice(), noOdooEntity);
    render(<AiInvoiceImportPage />);
    clickImportRow();
    expect(screen.queryByRole("button", { name: /send to odoo/i })).toBeNull();
  });

  it("does NOT show 'Send to Odoo' when entity accounting_system is not odoo", () => {
    const manualEntity = { ...ENTITY, accounting_system: "manual", odoo_integration_configured: false };
    setupMocksWithInvoice(
      makeInvoice({ entity_accounting_system: "manual" }),
      manualEntity,
    );
    render(<AiInvoiceImportPage />);
    clickImportRow();
    expect(screen.queryByRole("button", { name: /send to odoo/i })).toBeNull();
  });

  it("does NOT show 'Send to Odoo' when status=sent_to_odoo", () => {
    setupMocksWithInvoice(makeInvoice({ status: "sent_to_odoo", is_reviewed: true }));
    render(<AiInvoiceImportPage />);
    clickImportRow();
    expect(screen.queryByRole("button", { name: /^send to odoo$/i })).toBeNull();
  });

  it("does NOT show 'Send to Odoo' when status=uploaded", () => {
    setupMocksWithInvoice(makeInvoice({ status: "uploaded" }));
    render(<AiInvoiceImportPage />);
    clickImportRow();
    expect(screen.queryByRole("button", { name: /send to odoo/i })).toBeNull();
  });

  it("does NOT show 'Send to Odoo' when status=processing", () => {
    setupMocksWithInvoice(makeInvoice({ status: "processing" }));
    render(<AiInvoiceImportPage />);
    clickImportRow();
    expect(screen.queryByRole("button", { name: /send to odoo/i })).toBeNull();
  });
});

describe("AiInvoiceImportPage – scanner import updates", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setupMocks();
  });

  it("refreshes the selected entity's imports when a scanner upload is accepted", () => {
    render(<AiInvoiceImportPage />);

    expect(mockUseAuthedSse).toHaveBeenCalledWith(
      expect.stringContaining("/api/events"),
      true,
      expect.objectContaining({
        "finance.scanner_import.created": expect.any(Function),
      }),
    );

    const handlers = mockUseAuthedSse.mock.calls[0][2] as Record<string, () => void>;
    handlers["finance.scanner_import.created"]();

    expect(mockInvalidateQueries).toHaveBeenCalledWith({
      queryKey: ["finance-imports"],
    });
  });
});

// ---------------------------------------------------------------------------
// Tests – button click and mutation
// ---------------------------------------------------------------------------

describe("AiInvoiceImportPage – Send to Odoo button click", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setupMocks();
  });

  it("clicking 'Send to Odoo' triggers the send-to-odoo mutation", () => {
    const mockMutate = vi.fn();
    mockUseMutation.mockReturnValue({ mutate: mockMutate, isPending: false });

    render(<AiInvoiceImportPage />);
    clickImportRow();

    const button = screen.getByRole("button", { name: /send to odoo/i });
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
      json: async () => ({ success: true, bill_id: "bill_99", bill_url: "https://odoo.example.com/bills/99" }),
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

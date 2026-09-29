import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import AiInvoiceImportPage from "./AiInvoiceImport";

const mockUseQuery = vi.fn();
const mockUseMutation = vi.fn();
const mockInvalidateQueries = vi.fn();
const mockSetQueryData = vi.fn();
const mockUseAuthedSse = vi.fn();
const mockToast = vi.fn();
const setLocation = vi.fn();
const routeState = { location: "/ai-invoice-import?entity_id=3" };
const queryOptions: Array<{ queryKey: unknown[]; queryFn?: () => Promise<unknown> }> = [];
const mutationOptions: Array<{
  mutationFn: () => Promise<unknown>;
  onSuccess?: (data: unknown) => void;
  onError?: (error: unknown) => void;
}> = [];

vi.mock("@tanstack/react-query", () => ({
  QueryClient: class QueryClient {
    getQueryData() { return undefined; }
    setQueryData(...args: unknown[]) { mockSetQueryData(...args); }
    invalidateQueries() {}
    getQueryCache() { return { subscribe: () => () => {} }; }
  },
  QueryCache: class QueryCache {
    subscribe() { return () => {}; }
  },
  useQuery: (options: { queryKey: unknown[]; queryFn?: () => Promise<unknown> }) => {
    queryOptions.push(options);
    return mockUseQuery(options);
  },
  useMutation: (options: {
    mutationFn: () => Promise<unknown>;
    onSuccess?: (data: unknown) => void;
    onError?: (error: unknown) => void;
  }) => {
    mutationOptions.push(options);
    return {
      isPending: false,
      mutate: () => {
        void options.mutationFn()
          .then((result) => options.onSuccess?.(result))
          .catch((error) => options.onError?.(error));
      },
    };
  },
  useQueryClient: () => ({ invalidateQueries: mockInvalidateQueries, setQueryData: mockSetQueryData }),
}));

vi.mock("@/hooks/use-authed-sse", () => ({
  useAuthedSse: (...args: unknown[]) => mockUseAuthedSse(...args),
}));

vi.mock("@/hooks/use-workspace-role", () => ({
  useWorkspaceRole: () => ({ isOwner: true, allowedPages: null }),
}));

vi.mock("@/hooks/use-toast", () => ({
  useToast: () => ({ toast: mockToast }),
}));

vi.mock("wouter", () => ({
  useLocation: () => [routeState.location, setLocation],
}));

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

const INVOICE = {
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
  odoo_bill_id: "42",
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
};

const APPROVABLE_INVOICE = {
  ...INVOICE,
  review_status: "needs_review",
  sync_status: "not_requested",
  review_version: 1,
  odoo_bill_id: null,
  odoo_bill_url: null,
  issue_count: 0,
  blocking_issue_count: 0,
  warning_issue_count: 0,
};

const SYNCED_INVOICE = {
  ...INVOICE,
  review_status: "approved",
  sync_status: "succeeded",
  issue_count: 0,
  blocking_issue_count: 0,
  warning_issue_count: 0,
};

function setupQueries(imports = [INVOICE]) {
  mockUseQuery.mockImplementation((options: { queryKey: unknown[] }) => {
    if (options.queryKey[0] === "finance-entities") {
      return { data: [ENTITY], isLoading: false, refetch: vi.fn() };
    }
    if (options.queryKey[0] === "finance-imports") {
      return { data: { imports, total: imports.length }, isLoading: false, refetch: vi.fn() };
    }
    return { data: undefined, isLoading: false, refetch: vi.fn() };
  });
}

function installFetchResponses(responses: unknown[]) {
  const fetchMock = vi.fn().mockImplementation(async () => ({
    ok: true,
    status: 200,
    json: async () => responses.shift(),
  }));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("AiInvoiceImportPage – Odoo audit and historical sync reports", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mutationOptions.length = 0;
    queryOptions.length = 0;
    routeState.location = "/ai-invoice-import?entity_id=3";
    setupQueries();
    vi.spyOn(window, "confirm").mockReturnValue(true);
  });

  it("runs the read-only audit over cursor pages, renders its breakdown, and never calls create", async () => {
    const fetchMock = installFetchResponses([
      {
        read_only: true,
        audited: 100,
        audit_complete: false,
        next_after_id: 100,
        counts: { verified_existing_bill: 98, eligible_create: 2 },
        results: [],
      },
      {
        read_only: true,
        audited: 2,
        audit_complete: true,
        next_after_id: 102,
        counts: { recovered_bill: 1, source_unavailable: 1 },
        results: [],
      },
    ]);

    render(<AiInvoiceImportPage />);
    fireEvent.click(screen.getByTestId("button-audit-historical-odoo"));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    const urls = fetchMock.mock.calls.map(([url]) => String(url));
    expect(urls[0]).toContain("audit-approved-to-odoo");
    expect(urls[0]).toContain("after_id=0");
    expect(urls[1]).toContain("after_id=100");
    expect(fetchMock.mock.calls.every(([, options]) => options?.method !== "POST")).toBe(true);
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes("/create"))).toBe(false);

    expect(await screen.findByText("Read-only Odoo audit")).toBeInTheDocument();
    expect(screen.getByText("102 records")).toBeInTheDocument();
    expect(screen.getByText("verified existing bill: 98")).toBeInTheDocument();
    expect(screen.getByText("eligible create: 2")).toBeInTheDocument();
    expect(screen.getByText("recovered bill: 1")).toBeInTheDocument();
    expect(screen.getByText("source unavailable: 1")).toBeInTheDocument();
  });

  it("shows exact per-invoice failures and stale-repair messaging in the bulk report", async () => {
    const fetchMock = installFetchResponses([{
      success: false,
      selected: 2,
      synced: 1,
      failed: 1,
      skipped: 0,
      created: 0,
      recovered: 1,
      verified_existing: 0,
      stale_repaired: 1,
      reason_breakdown: { recovered_bill: 1, provider_failed: 1 },
      has_more: false,
      next_after_id: 42,
      results: [
        { invoice_id: 41, status: "succeeded", outcome: "recovered", stale_local_state: true },
        { invoice_id: 42, status: "failed", error: "Odoo supplier/tax lookup failed: supplier mapping is ambiguous", reason_code: "provider_failed" },
      ],
    }]);

    render(<AiInvoiceImportPage />);
    fireEvent.click(screen.getByTestId("button-sync-historical-odoo"));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(await screen.findByText("recovered: 1")).toBeInTheDocument();
    expect(screen.getByText("stale repaired: 1")).toBeInTheDocument();
    expect(screen.getByText("Invoice #42: Odoo supplier/tax lookup failed: supplier mapping is ambiguous")).toBeInTheDocument();
    expect(screen.getByText("recovered bill: 1")).toBeInTheDocument();
  });

  it("reports verified records and zero creates on a second bulk run", async () => {
    const fetchMock = installFetchResponses([
      {
        success: true,
        selected: 1,
        synced: 1,
        failed: 0,
        skipped: 0,
        created: 1,
        recovered: 0,
        verified_existing: 0,
        stale_repaired: 0,
        reason_breakdown: { eligible_create: 1 },
        has_more: false,
        next_after_id: 7,
        results: [{ invoice_id: 7, status: "succeeded", outcome: "created" }],
      },
      {
        success: true,
        selected: 1,
        synced: 1,
        failed: 0,
        skipped: 0,
        created: 0,
        recovered: 0,
        verified_existing: 1,
        stale_repaired: 0,
        reason_breakdown: { verified_existing_bill: 1 },
        has_more: false,
        next_after_id: 7,
        results: [{ invoice_id: 7, status: "succeeded", outcome: "verified_existing" }],
      },
    ]);

    render(<AiInvoiceImportPage />);
    const syncButton = screen.getByTestId("button-sync-historical-odoo");
    fireEvent.click(syncButton);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    fireEvent.click(syncButton);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));

    const secondRequest = fetchMock.mock.calls[1][1] as RequestInit;
    expect(secondRequest.method).toBe("POST");
    expect(JSON.parse(String(secondRequest.body))).toEqual({ entity_id: 3, after_id: 0 });
    expect(secondRequest.body).not.toContain("create");
    expect(screen.getByText("created: 0")).toBeInTheDocument();
    expect(screen.getByText("verified: 1")).toBeInTheDocument();
  });
});

describe("AiInvoiceImportPage – queue search", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mutationOptions.length = 0;
    queryOptions.length = 0;
    routeState.location = "/ai-invoice-import?entity_id=3&review_status=needs_review&sync_status=not_requested&date_from=2026-01-01&date_to=2026-12-31&search=Acme&offset=50";
    setupQueries();
  });

  it("restores search, sends it with all filters, and preserves it when opening a review", async () => {
    const fetchMock = installFetchResponses([{ imports: [INVOICE], total: 1 }]);
    render(<AiInvoiceImportPage />);

    expect(screen.getByLabelText("Search invoices")).toHaveValue("Acme");
    const importsQuery = queryOptions.find((options) => options.queryKey[0] === "finance-imports");
    await importsQuery?.queryFn?.();

    const requestUrl = String(fetchMock.mock.calls[0]?.[0]);
    expect(requestUrl).toContain("search=Acme");
    expect(requestUrl).toContain("entity_id=3");
    expect(requestUrl).toContain("review_status=needs_review");
    expect(requestUrl).toContain("sync_status=not_requested");
    expect(requestUrl).toContain("date_from=2026-01-01");
    expect(requestUrl).toContain("date_to=2026-12-31");
    expect(requestUrl).toContain("offset=50");

    fireEvent.click(screen.getByTestId("button-review-invoice-7"));
    expect(setLocation).toHaveBeenCalledWith(expect.stringContaining("/ai-invoice-import/7/review?"));
    expect(setLocation).toHaveBeenCalledWith(expect.stringContaining("search=Acme"));
    expect(setLocation).toHaveBeenCalledWith(expect.stringContaining("offset=50"));
  });

  it("resets pagination when search changes and includes search in the query cache key", () => {
    render(<AiInvoiceImportPage />);
    fireEvent.change(screen.getByTestId("input-invoice-search"), { target: { value: "INV-001" } });

    const importsQueries = queryOptions.filter((options) => options.queryKey[0] === "finance-imports");
    const latestKey = importsQueries.at(-1)?.queryKey;
    expect(latestKey).toContain("INV-001");
    expect(latestKey?.at(-1)).toBe(0);
  });

  it("shows a search-specific empty result instead of the new-workspace message", () => {
    mockUseQuery.mockImplementation((options: { queryKey: unknown[] }) => {
      if (options.queryKey[0] === "finance-entities") return { data: [ENTITY], isLoading: false, refetch: vi.fn() };
      if (options.queryKey[0] === "finance-imports") return { data: { imports: [], total: 0 }, isLoading: false, refetch: vi.fn() };
      return { data: undefined, isLoading: false, refetch: vi.fn() };
    });

    render(<AiInvoiceImportPage />);

    expect(screen.getByTestId("invoice-search-empty")).toHaveTextContent("No invoices match “Acme”");
    expect(screen.queryByText(/No invoices imported yet/)).not.toBeInTheDocument();
  });
});

describe("AiInvoiceImportPage – sync status badges", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mutationOptions.length = 0;
    queryOptions.length = 0;
    routeState.location = "/ai-invoice-import?entity_id=3";
    setupQueries([SYNCED_INVOICE]);
  });

  it("renders succeeded invoices with the green Synced badge styling", () => {
    render(<AiInvoiceImportPage />);

    const syncedRow = screen.getByRole("row", { name: /Acme Corp.*INV-001.*Synced/ });
    const syncedBadge = within(syncedRow).getByText("Synced");
    expect(syncedBadge).toBeInTheDocument();
    expect(syncedBadge).toHaveClass("border-green-200", "bg-green-50", "text-green-800");
  });
});

describe("AiInvoiceImportPage – invoice approval actions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mutationOptions.length = 0;
    queryOptions.length = 0;
    routeState.location = "/ai-invoice-import?entity_id=3";
    mockUseQuery.mockImplementation((options: { queryKey: unknown[] }) => {
      if (options.queryKey[0] === "finance-entities") return { data: [ENTITY], isLoading: false, refetch: vi.fn() };
      if (options.queryKey[0] === "finance-imports") return {
        data: { imports: [APPROVABLE_INVOICE], total: 1 },
        isLoading: false,
        refetch: vi.fn(),
      };
      return { data: undefined, isLoading: false, refetch: vi.fn() };
    });
  });

  it("approves one ready invoice through the canonical endpoint without starting sync", async () => {
    const fetchMock = installFetchResponses([{ invoice: { review_version: 2 }, sync: { status: "not_requested", deferred: true } }]);
    render(<AiInvoiceImportPage />);

    fireEvent.click(screen.getByTestId("button-approve-invoice-7"));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(String(fetchMock.mock.calls[0][0])).toContain("/finance/invoice-review/7/approve");
    expect(JSON.parse(String((fetchMock.mock.calls[0][1] as RequestInit).body))).toEqual({ version: 1, sync: false });
    expect(mockSetQueryData).toHaveBeenCalled();
    expect(mockToast).toHaveBeenCalledWith(expect.objectContaining({ title: "Invoice approved" }));
  });

  it("shows warning reasons, acknowledges them, then approves without sync", async () => {
    const fetchMock = installFetchResponses([
      {
        invoice: { review_version: 1 },
        validation: { issues: [{ issue_key: "supplier.unresolved", message: "Supplier mapping is unresolved", severity: "warning", blocking: false }] },
        acknowledgements: [],
      },
      { success: true },
      { invoice: { review_version: 2 }, sync: { status: "not_requested", deferred: true } },
    ]);
    mockUseQuery.mockImplementation((options: { queryKey: unknown[] }) => {
      if (options.queryKey[0] === "finance-entities") return { data: [ENTITY], isLoading: false, refetch: vi.fn() };
      if (options.queryKey[0] === "finance-imports") return {
        data: { imports: [{ ...APPROVABLE_INVOICE, warning_issue_count: 1, issue_count: 1 }], total: 1 },
        isLoading: false,
        refetch: vi.fn(),
      };
      return { data: undefined, isLoading: false, refetch: vi.fn() };
    });
    render(<AiInvoiceImportPage />);

    fireEvent.click(screen.getByTestId("button-approve-invoice-7"));
    expect(await screen.findByText("Supplier mapping is unresolved")).toBeInTheDocument();
    fireEvent.click(screen.getByTestId("button-acknowledge-and-approve"));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
    expect(JSON.parse(String((fetchMock.mock.calls[1][1] as RequestInit).body))).toEqual({
      issue_key: "supplier.unresolved",
      version: 1,
    });
    expect(JSON.parse(String((fetchMock.mock.calls[2][1] as RequestInit).body))).toEqual({ version: 1, sync: false });
  });

  it("keeps blocked invoices on Review and shows the exact blocking reason", () => {
    mockUseQuery.mockImplementation((options: { queryKey: unknown[] }) => {
      if (options.queryKey[0] === "finance-entities") return { data: [ENTITY], isLoading: false, refetch: vi.fn() };
      if (options.queryKey[0] === "finance-imports") return {
        data: {
          imports: [{ ...APPROVABLE_INVOICE, blocking_issue_count: 1, issue_count: 1, blocking_issue_messages: ["Invoice date is required"] }],
          total: 1,
        },
        isLoading: false,
        refetch: vi.fn(),
      };
      return { data: undefined, isLoading: false, refetch: vi.fn() };
    });
    render(<AiInvoiceImportPage />);

    expect(screen.getByTestId("text-blocked-reason-7")).toHaveTextContent("Invoice date is required");
    expect(screen.queryByTestId("button-approve-invoice-7")).not.toBeInTheDocument();
    expect(screen.getByTestId("button-review-invoice-7")).toBeInTheDocument();
  });

  it("sends one batched approval request even when a selected invoice has warnings", async () => {
    const second = {
      ...APPROVABLE_INVOICE,
      id: 8,
      invoice_number: "INV-002",
      review_version: 4,
      warning_issue_count: 1,
      issue_count: 1,
    };
    mockUseQuery.mockImplementation((options: { queryKey: unknown[] }) => {
      if (options.queryKey[0] === "finance-entities") return { data: [ENTITY], isLoading: false, refetch: vi.fn() };
      if (options.queryKey[0] === "finance-imports") return { data: { imports: [APPROVABLE_INVOICE, second], total: 2 }, isLoading: false, refetch: vi.fn() };
      return { data: undefined, isLoading: false, refetch: vi.fn() };
    });
    const fetchMock = installFetchResponses([{
      approved: 2,
      blocked: 0,
      skipped: 0,
      results: [{ invoice_id: 7, status: "approved" }, { invoice_id: 8, status: "approved" }],
    }]);
    render(<AiInvoiceImportPage />);

    fireEvent.click(screen.getByLabelText("Select invoice INV-001"));
    fireEvent.click(screen.getByLabelText("Select invoice INV-002"));
    fireEvent.click(screen.getByTestId("button-approve-selected"));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(String(fetchMock.mock.calls[0][0])).toContain("/finance/invoice-review/approve-selected");
    const body = JSON.parse(String((fetchMock.mock.calls[0][1] as RequestInit).body));
    expect(body.invoice_ids).toEqual([7, 8]);
    expect(body).not.toHaveProperty("sync");
  });
});
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import AiInvoiceImportPage, { buildInvoiceQueueQuery } from "./AiInvoiceImport";

const mockUseQuery = vi.fn();
const mockUseMutation = vi.fn();
vi.mock("@tanstack/react-query", () => ({
  QueryClient: class QueryClient {},
  QueryCache: class QueryCache {},
  useQuery: (opts: { queryKey: unknown[] }) => mockUseQuery(opts),
  useMutation: (opts: { mutationFn: () => Promise<unknown> }) => mockUseMutation(opts),
  useQueryClient: () => ({ invalidateQueries: vi.fn(), setQueryData: vi.fn() }),
}));
vi.mock("@/hooks/use-authed-sse", () => ({ useAuthedSse: vi.fn() }));
vi.mock("@/hooks/use-workspace-role", () => ({ useWorkspaceRole: () => ({ isOwner: true, allowedPages: null }) }));
vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast: vi.fn() }) }));
vi.mock("wouter", () => ({ useLocation: () => ["/ai-invoice-import?entity_id=3", vi.fn()] }));

const entity = {
  id: 3, legal_name: "My Company Ltd", display_name: "My Company", country: "US",
  tax_registration_number: null, accounting_system: "odoo", odoo_base_url: null,
  odoo_company_name: null, odoo_company_id: 1, odoo_database: null, default_currency: "USD",
  is_active: true, odoo_integration_configured: true, odoo_default_expense_account_id: null,
};

beforeEach(() => {
  vi.clearAllMocks();
  mockUseQuery.mockImplementation((opts: { queryKey: unknown[] }) => {
    if (opts.queryKey[0] === "finance-entities") return { data: [entity], isLoading: false, refetch: vi.fn() };
    if (opts.queryKey[0] === "finance-imports") return { data: { imports: [], total: 0 }, isLoading: false, refetch: vi.fn() };
    return { data: undefined, isLoading: false, refetch: vi.fn() };
  });
  mockUseMutation.mockImplementation((opts: { mutationFn: () => Promise<unknown> }) => ({
    mutate: vi.fn(), isPending: false, mutationFn: opts.mutationFn,
  }));
  vi.spyOn(window, "confirm").mockReturnValue(true);
});

describe("AiInvoiceImportPage – approved bulk Odoo sync", () => {
  it("exposes the current Sync All action instead of per-invoice Send/Resend actions", () => {
    render(<AiInvoiceImportPage />);
    expect(screen.getByTestId("button-sync-historical-odoo")).toHaveTextContent("Sync approved invoices to Odoo");
    expect(screen.getByTestId("button-sync-historical-odoo")).toBeDisabled();
    expect(screen.getByTestId("odoo-expense-account-warning")).toHaveTextContent("Default expense account not configured");
    expect(screen.getByRole("button", { name: "Entity Settings" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /send to odoo|resend to odoo/i })).toBeNull();
  });

  it("posts approved bulk sync to the current endpoint", async () => {
    let mutationFn: (() => Promise<unknown>) | undefined;
    mockUseMutation.mockImplementation((opts: { mutationFn: () => Promise<unknown> }) => {
      mutationFn ??= opts.mutationFn;
      return { mutate: vi.fn(), isPending: false };
    });
    render(<AiInvoiceImportPage />);
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ success: true, selected: 1, synced: 1, failed: 0, skipped: 0, has_more: false, next_after_id: 7 }),
    });
    vi.stubGlobal("fetch", mockFetch);
    fireEvent.click(screen.getByTestId("button-sync-historical-odoo"));
    await mutationFn?.();
    expect(String(mockFetch.mock.calls[0]?.[0])).toContain("/api/finance/invoice-review/sync-approved-to-odoo");
    expect(mockFetch.mock.calls[0]?.[1]).toMatchObject({ method: "POST" });
    vi.unstubAllGlobals();
  });

  it("maps the visible status filters to authoritative queue params and preserves pagination/search", () => {
    const ready = buildInvoiceQueueQuery({
      entityId: 3,
      reviewStatus: "failed",
      syncStatus: "ready_to_sync",
      dateFrom: "2026-09-01",
      dateTo: "2026-09-30",
      search: "SM242",
      page: 2,
    });
    expect(Object.fromEntries(ready)).toEqual({
      limit: "50",
      offset: "100",
      entity_id: "3",
      review_status: "approved",
      sync_status: "not_requested",
      date_from: "2026-09-01",
      date_to: "2026-09-30",
      search: "SM242",
    });

    const blocked = buildInvoiceQueueQuery({
      entityId: 3,
      reviewStatus: "approved",
      syncStatus: "blocked",
      search: "Raidan",
      page: 1,
    });
    expect(blocked.get("review_status")).toBe("approved");
    expect(blocked.get("sync_status")).toBe("blocked");
    expect(blocked.get("search")).toBe("Raidan");
    expect(blocked.get("offset")).toBe("50");
  });

  it("opens Entity Settings from the single missing-default warning", () => {
    render(<AiInvoiceImportPage />);
    fireEvent.click(screen.getByRole("button", { name: "Entity Settings" }));
    expect(screen.getByText("Entity Settings — My Company Ltd")).toBeInTheDocument();
    expect(screen.getByTestId("input-entity-odoo-default-expense-account")).toBeInTheDocument();
  });
});
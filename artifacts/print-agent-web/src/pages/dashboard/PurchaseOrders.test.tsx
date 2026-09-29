import { describe, it, expect, vi, beforeEach } from "vitest";
import { render } from "@testing-library/react";
import PurchaseOrders from "./PurchaseOrders";
import React from "react";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockNavigate = vi.fn();
let mockSearch = "";

vi.mock("wouter", () => ({
  useLocation: () => ["/purchase-orders", mockNavigate],
  useSearch: () => mockSearch,
  Link: ({ children, href }: { children: React.ReactNode; href: string }) =>
    React.createElement("a", { href }, children),
}));

vi.mock("@tanstack/react-query", () => ({
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
  useQuery: vi.fn().mockReturnValue({ data: undefined, isLoading: false }),
}));

vi.mock("@/hooks/use-toast", () => ({
  useToast: () => ({ toast: vi.fn() }),
}));

vi.mock("@/hooks/use-workspace-role", () => ({
  useWorkspaceRole: () => ({ isOwner: true, allowedPages: null }),
}));

vi.mock("@/lib/queryClient", () => ({
  apiFetch: vi.fn().mockResolvedValue({}),
  getQueryClient: vi.fn(),
  queryClient: {},
}));

const mockUseListPurchaseOrders = vi.fn();

vi.mock("@workspace/api-client-react", () => ({
  useListPurchaseOrders: (...args: unknown[]) => mockUseListPurchaseOrders(...args),
  useDeletePurchaseOrder: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useAcceptPurchaseOrder: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useListSuppliers: () => ({ data: { suppliers: [] }, isLoading: false }),
  getListPurchaseOrdersQueryKey: (params?: unknown) => ["/api/purchase-orders", params],
}));

vi.mock("@/components/CreatePoWizard", () => ({
  PO_STATUS_MAP: {},
  PoStatusBadge: () => null,
  LocationCombobox: () => null,
  CreatePoWizard: () => null,
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function setupEmptyList() {
  mockUseListPurchaseOrders.mockReturnValue({
    data: { purchase_orders: [], total: 0 },
    isLoading: false,
    isError: false,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockSearch = "";
  setupEmptyList();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("PurchaseOrders — invoice status filter", () => {
  it("renders without throwing with no query params", () => {
    mockSearch = "";
    expect(() => render(<PurchaseOrders />)).not.toThrow();
  });

  it("renders without throwing with ?invoice_status=awaiting_invoice", () => {
    mockSearch = "?invoice_status=awaiting_invoice";
    expect(() => render(<PurchaseOrders />)).not.toThrow();

    // The valid value should be forwarded to the API hook
    expect(mockUseListPurchaseOrders).toHaveBeenCalledWith(
      expect.objectContaining({ invoice_status: "awaiting_invoice" }),
    );
  });

  it("renders without throwing and does not forward invalid invoice_status to the API", () => {
    mockSearch = "?invoice_status=invalid_value";
    expect(() => render(<PurchaseOrders />)).not.toThrow();

    // No call should have forwarded the invalid value
    for (const [params] of mockUseListPurchaseOrders.mock.calls) {
      expect((params as Record<string, unknown>).invoice_status).not.toBe("invalid_value");
    }
  });
});

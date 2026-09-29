import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { apiFetch } from "@/lib/queryClient";
import { MerchantReconciliationPanel } from "./MerchantReconciliationPanel";

vi.mock("@/lib/queryClient", () => ({
  apiFetch: vi.fn(),
  queryClient: { invalidateQueries: vi.fn() },
}));

vi.mock("@/hooks/use-toast", () => ({
  useToast: () => ({ toast: vi.fn() }),
}));

const mockApiFetch = vi.mocked(apiFetch);

function renderPanel() {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
    },
  });

  const result = render(
    <QueryClientProvider client={queryClient}>
      <MerchantReconciliationPanel open onOpenChange={vi.fn()} />
    </QueryClientProvider>,
  );

  return { ...result, queryClient };
}

describe("MerchantReconciliationPanel migration gate", () => {
  beforeEach(() => {
    mockApiFetch.mockImplementation((path: string) => {
      if (path.endsWith("/latest")) {
        return Promise.resolve({
          runs: { LB: {
            id: 71,
            country: "LB",
            content_language: "en",
            status: "APPROVED",
            summary: { CREATE: 1, UPDATE: 0, DELETE: 4, NOOP: 0, ACTION_REQUIRED: 0 },
            created_at: "2026-03-01T10:00:00.000Z",
            approved_at: "2026-03-01T10:01:00.000Z",
            applied_at: null,
          } },
        });
      }

      return Promise.resolve({
        executionEnabled: false,
        run: {
          id: 71,
          country: "LB",
          content_language: "en",
          status: "APPROVED",
          summary: { CREATE: 1, UPDATE: 0, DELETE: 4, NOOP: 0, ACTION_REQUIRED: 0 },
          created_at: "2026-03-01T10:00:00.000Z",
          approved_at: "2026-03-01T10:01:00.000Z",
          applied_at: null,
        },
        items: [
          {
            id: 1, product_id: 101, country: "LB", content_language: "en", offer_id: "new-1",
            action: "CREATE", reason: null, state_identity: {}, delete_approved: false, last_offer_approved: false,
            replacement_approval_status: "APPROVED", replacement_approval_checked_at: "2026-03-01T10:03:00.000Z",
          },
          {
            id: 2, product_id: 102, country: "LB", content_language: "en", offer_id: "old-2",
            action: "DELETE", reason: "Replaced", state_identity: {}, delete_approved: false, last_offer_approved: false,
            replacement_approval_status: "PENDING", replacement_approval_deadline: "2026-03-02T10:00:00.000Z",
          },
          {
            id: 3, product_id: 103, country: "LB", content_language: "en", offer_id: "old-3",
            action: "DELETE", reason: "Replaced", state_identity: {}, delete_approved: false, last_offer_approved: false,
            replacement_approval_status: "DISAPPROVED", replacement_approval_error: "Replacement was rejected",
          },
          {
            id: 4, product_id: 104, country: "LB", content_language: "en", offer_id: "old-4",
            action: "DELETE", reason: "Replaced", state_identity: {}, delete_approved: false, last_offer_approved: false,
            replacement_approval_status: "TIMED_OUT",
          },
        ],
      });
    });
  });

  afterEach(() => {
    mockApiFetch.mockReset();
  });

  it("shows replacement evidence and prevents applying while backend execution is disabled", async () => {
    const { queryClient } = renderPanel();

    expect(await screen.findByTestId("two-phase-migration-gate")).toHaveTextContent(
      /created first.*approval evidence is verified.*then.*deleted/i,
    );
    expect(screen.getByTestId("execution-disabled-alert")).toHaveTextContent(/execution disabled/i);
    expect(screen.getByTestId("btn-apply-run")).toBeDisabled();

    for (const [id, status] of [[1, "APPROVED"], [2, "PENDING"], [3, "DISAPPROVED"], [4, "TIMED_OUT"]]) {
      expect(screen.getByTestId(`replacement-approval-${id}`)).toHaveTextContent(status);
    }
    expect(screen.getByTestId("replacement-approval-deadline-2")).toHaveTextContent(/evidence deadline/i);
    expect(screen.getByTestId("replacement-approval-error-3")).toHaveTextContent("Replacement was rejected");

    queryClient.clear();
  });
});

describe("MerchantReconciliationPanel market choices", () => {
  beforeEach(() => {
    mockApiFetch.mockImplementation((path: string) => {
      if (path.endsWith("/latest")) return Promise.resolve({ runs: {} });
      if (path.endsWith("/dry-run")) {
        return Promise.resolve({
          results: [
            { country: "AE", ok: true, runId: 81, summary: { CREATE: 2 }, blocked: null },
            { country: "LB", ok: false, error: "LB account access is missing" },
          ],
        });
      }
      return Promise.resolve({ run: null, items: [] });
    });
  });

  afterEach(() => mockApiFetch.mockReset());

  it("offers UAE, Lebanon, and both, then keeps partial results separate", async () => {
    const user = userEvent.setup();
    renderPanel();

    await user.click(await screen.findByTestId("select-merchant-target"));
    await user.click(screen.getByText("Both markets"));
    await user.click(screen.getByTestId("btn-run-dry-run"));

    await waitFor(() => {
      const call = mockApiFetch.mock.calls.find(([path]) => path === "/api/products/merchant-reconciliation/dry-run");
      expect(JSON.parse(String(call?.[1]?.body))).toEqual({
        countries: ["AE", "LB"],
        contentLanguage: "en",
        includeGoogle: true,
      });
    });
    expect(await screen.findByTestId("market-result-AE")).toHaveTextContent("UAE");
    expect(screen.getByTestId("market-result-LB")).toHaveTextContent("LB account access is missing");
  });
});
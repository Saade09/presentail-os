import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import SalesHistoryTab from "./SalesHistoryTab";

// ---------------------------------------------------------------------------
// Module-level mocks
// ---------------------------------------------------------------------------

const mockUseQuery = vi.fn();

vi.mock("@tanstack/react-query", () => ({
  useQuery: (...args: unknown[]) => mockUseQuery(...args),
}));

vi.mock("@/lib/queryClient", () => ({
  apiFetch: vi.fn(),
  getClerkToken: vi.fn().mockResolvedValue("mock-token"),
}));

const mockToast = vi.fn();

vi.mock("@/hooks/use-toast", () => ({
  useToast: () => ({ toast: mockToast }),
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const EMPTY_DATA = {
  items: [],
  totals: { total_quantity: 0, revenue_by_currency: [] },
  page: 1,
  pageSize: 25,
  total: 0,
  totalPages: 1,
  matchKey: "name" as const,
};

function setupQueryWithData() {
  mockUseQuery.mockReturnValue({
    data: EMPTY_DATA,
    isLoading: false,
    isError: false,
    error: null,
    refetch: vi.fn(),
    isFetching: false,
  });
}

function getExportButton() {
  return screen.getByTestId("sales-history-export-csv");
}

// ---------------------------------------------------------------------------
// Tests: Export CSV button toast notifications
// ---------------------------------------------------------------------------

describe("SalesHistoryTab — Export CSV toast notifications", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal("URL", {
      ...URL,
      createObjectURL: vi.fn(() => "blob:mock-url"),
      revokeObjectURL: vi.fn(),
    });
    setupQueryWithData();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("shows the 'Export complete' success toast and re-enables the button when fetch succeeds", async () => {
    const csvBlob = new Blob(["store,order\nA,1"], { type: "text/csv" });
    const headers = new Headers({
      "Content-Disposition": 'attachment; filename="sales-history.csv"',
    });
    vi.spyOn(global, "fetch").mockResolvedValue(
      new Response(csvBlob, { status: 200, headers }),
    );

    const appendSpy = vi.spyOn(document.body, "appendChild");

    render(<SalesHistoryTab productId={1} />);

    const button = getExportButton();
    expect(button).not.toBeDisabled();

    fireEvent.click(button);

    // Loading state: button is disabled and shows a spinner
    expect(button).toBeDisabled();
    expect(button.querySelector(".animate-spin")).toBeInTheDocument();

    // After fetch resolves: button is re-enabled and spinner is gone
    await waitFor(() => expect(button).not.toBeDisabled());
    expect(button.querySelector(".animate-spin")).not.toBeInTheDocument();

    // A download anchor was programmatically clicked
    expect(
      appendSpy.mock.calls.some(([node]) => (node as Element).tagName === "A"),
    ).toBe(true);

    // Success toast fired with the correct title
    expect(mockToast).toHaveBeenCalledOnce();
    expect(mockToast).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Export complete" }),
    );
  });

  it("shows the 'Export failed' error toast and re-enables the button when fetch returns a non-ok response", async () => {
    vi.spyOn(global, "fetch").mockResolvedValue(
      new Response(null, { status: 500, statusText: "Internal Server Error" }),
    );

    render(<SalesHistoryTab productId={1} />);

    const button = getExportButton();
    expect(button).not.toBeDisabled();

    fireEvent.click(button);

    // Loading state: button is disabled
    expect(button).toBeDisabled();

    // After fetch resolves with an error: button is re-enabled
    await waitFor(() => expect(button).not.toBeDisabled());
    expect(button.querySelector(".animate-spin")).not.toBeInTheDocument();

    // Error toast fired with the correct title
    expect(mockToast).toHaveBeenCalledOnce();
    expect(mockToast).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Export failed" }),
    );
  });
});

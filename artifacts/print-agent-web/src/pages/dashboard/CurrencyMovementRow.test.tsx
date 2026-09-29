/**
 * Unit tests for the CurrencyMovementRow component exported from CashSessionDetail.
 *
 * Covers:
 *   - Renders amount input and currency select with testId attributes
 *   - onChange fires with the correct updated MovementRow value
 *   - onRemove fires when the X button is clicked
 *   - Exchange-rate label appears only when the row currency differs from documentCurrency
 *   - Exchange-rate label shows the correct session rate
 *   - Override rate input present for cross-currency rows
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import React from "react";

// ---------------------------------------------------------------------------
// Mocks — must come before the module import
// ---------------------------------------------------------------------------

vi.mock("wouter", () => ({
  useParams: () => ({ id: "1" }),
  useLocation: () => ["/cash-sessions/1", vi.fn()],
}));

vi.mock("@/lib/queryClient", () => ({
  apiFetch: vi.fn(),
  getClerkToken: vi.fn().mockResolvedValue("tok"),
}));

vi.mock("@tanstack/react-query", () => ({
  useQuery: vi.fn().mockReturnValue({ data: undefined, isLoading: false }),
  useMutation: vi.fn().mockReturnValue({ mutate: vi.fn(), isPending: false }),
  useQueryClient: vi.fn().mockReturnValue({ invalidateQueries: vi.fn() }),
}));

vi.mock("@/hooks/use-toast", () => ({
  useToast: () => ({ toast: vi.fn() }),
}));

vi.mock("@/hooks/use-workspace-role", () => ({
  useWorkspaceRole: () => ({ isOwner: true, allowedPages: null }),
}));

vi.mock("@/lib/imageUrl", () => ({
  imageUrl: vi.fn((url: string) => url),
}));

// ---------------------------------------------------------------------------
// Import the component AFTER mocks
// ---------------------------------------------------------------------------

import { CurrencyMovementRow } from "./CashSessionDetail";
import type { MovementRow } from "./CashSessionDetail";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRow(overrides: Partial<MovementRow> = {}): MovementRow {
  return { id: "row1", amount: "100", currency: "USD", rateOverride: "", ...overrides };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("CurrencyMovementRow", () => {
  // Cast vi.fn() to the exact callback types expected by CurrencyMovementRow props.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let onChange: (updated: MovementRow) => void;
  let onRemove: () => void;
  // Retained references so we can inspect .mock.calls in assertions.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let onChangeMock: ReturnType<typeof vi.fn>;
  let onRemoveMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    onChangeMock = vi.fn();
    onRemoveMock = vi.fn();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    onChange = onChangeMock as unknown as (updated: MovementRow) => void;
    onRemove = onRemoveMock as unknown as () => void;
  });

  // ── renders inputs correctly ──────────────────────────────────────────────

  it("renders amount input with the correct value and testId", () => {
    render(
      <CurrencyMovementRow
        row={makeRow({ amount: "250" })}
        currencies={["USD", "LBP"]}
        documentCurrency="USD"
        sessionRates={{}}
        onChange={onChange}
        onRemove={onRemove}
        testIdPrefix="pay-0"
      />,
    );

    const amtInput = screen.getByTestId("pay-0-amount") as HTMLInputElement;
    expect(amtInput).toBeInTheDocument();
    expect(amtInput.value).toBe("250");
  });

  it("renders the currency select trigger with the correct testId", () => {
    render(
      <CurrencyMovementRow
        row={makeRow({ currency: "USD" })}
        currencies={["USD", "LBP"]}
        documentCurrency="USD"
        sessionRates={{}}
        onChange={onChange}
        onRemove={onRemove}
        testIdPrefix="pay-0"
      />,
    );

    const trigger = screen.getByTestId("pay-0-currency");
    expect(trigger).toBeInTheDocument();
    // SelectTrigger shows the current currency value
    expect(trigger).toHaveTextContent("USD");
  });

  it("renders the remove button with the correct testId", () => {
    render(
      <CurrencyMovementRow
        row={makeRow()}
        currencies={["USD", "LBP"]}
        documentCurrency="USD"
        sessionRates={{}}
        onChange={onChange}
        onRemove={onRemove}
        testIdPrefix="pay-0"
      />,
    );

    const removeBtn = screen.getByTestId("pay-0-remove");
    expect(removeBtn).toBeInTheDocument();
  });

  // ── onChange fires ─────────────────────────────────────────────────────────

  it("onChange fires with the updated amount when the input changes", () => {
    // The component is controlled (row prop drives the value), so we use
    // fireEvent.change which fires a single synthetic event with the full value.
    render(
      <CurrencyMovementRow
        row={makeRow({ amount: "100" })}
        currencies={["USD", "LBP"]}
        documentCurrency="USD"
        sessionRates={{}}
        onChange={onChange}
        onRemove={onRemove}
        testIdPrefix="pay-0"
      />,
    );

    const amtInput = screen.getByTestId("pay-0-amount");
    fireEvent.change(amtInput, { target: { value: "500" } });

    expect(onChangeMock).toHaveBeenCalledTimes(1);
    const callArg = onChangeMock.mock.calls[0][0] as MovementRow;
    expect(callArg.amount).toBe("500");
    expect(callArg.id).toBe("row1"); // id preserved
    expect(callArg.currency).toBe("USD"); // other fields preserved
  });

  // ── onRemove fires ─────────────────────────────────────────────────────────

  it("onRemove fires when the remove (X) button is clicked", async () => {
    const user = userEvent.setup();

    render(
      <CurrencyMovementRow
        row={makeRow()}
        currencies={["USD", "LBP"]}
        documentCurrency="USD"
        sessionRates={{}}
        onChange={onChange}
        onRemove={onRemove}
        testIdPrefix="pay-0"
      />,
    );

    await user.click(screen.getByTestId("pay-0-remove"));
    expect(onRemoveMock).toHaveBeenCalledTimes(1);
  });

  // ── exchange-rate label ───────────────────────────────────────────────────

  it("does NOT show exchange-rate label when row currency equals documentCurrency", () => {
    render(
      <CurrencyMovementRow
        row={makeRow({ currency: "USD" })}
        currencies={["USD", "LBP"]}
        documentCurrency="USD"
        sessionRates={{ LBP: 90_000 }}
        onChange={onChange}
        onRemove={onRemove}
        testIdPrefix="pay-0"
      />,
    );

    expect(screen.queryByText(/Rate:/i)).not.toBeInTheDocument();
  });

  it("shows exchange-rate label when row currency differs from documentCurrency", () => {
    render(
      <CurrencyMovementRow
        row={makeRow({ currency: "LBP" })}
        currencies={["USD", "LBP"]}
        documentCurrency="USD"
        sessionRates={{ LBP: 90_000 }}
        onChange={onChange}
        onRemove={onRemove}
        testIdPrefix="pay-0"
      />,
    );

    expect(screen.getByText(/Rate:/i)).toBeInTheDocument();
    // Should display the session rate: "1 USD = 90,000 LBP"
    expect(screen.getByText(/90,000/)).toBeInTheDocument();
  });

  it("shows '?' when no session rate is available for the foreign currency", () => {
    render(
      <CurrencyMovementRow
        row={makeRow({ currency: "EUR" })}
        currencies={["USD", "EUR"]}
        documentCurrency="USD"
        sessionRates={{}} // no EUR rate
        onChange={onChange}
        onRemove={onRemove}
        testIdPrefix="pay-0"
      />,
    );

    expect(screen.getByText(/Rate:.*\?/)).toBeInTheDocument();
  });

  it("shows override rate input for cross-currency rows", () => {
    render(
      <CurrencyMovementRow
        row={makeRow({ currency: "LBP" })}
        currencies={["USD", "LBP"]}
        documentCurrency="USD"
        sessionRates={{ LBP: 90_000 }}
        onChange={onChange}
        onRemove={onRemove}
        testIdPrefix="pay-0"
      />,
    );

    const overrideInput = screen.getByPlaceholderText(/Override rate/i);
    expect(overrideInput).toBeInTheDocument();
  });

  it("does NOT show override rate input for same-currency rows", () => {
    render(
      <CurrencyMovementRow
        row={makeRow({ currency: "USD" })}
        currencies={["USD", "LBP"]}
        documentCurrency="USD"
        sessionRates={{ LBP: 90_000 }}
        onChange={onChange}
        onRemove={onRemove}
        testIdPrefix="pay-0"
      />,
    );

    expect(screen.queryByPlaceholderText(/Override rate/i)).not.toBeInTheDocument();
  });

  // ── works without testIdPrefix ────────────────────────────────────────────

  it("renders without errors when testIdPrefix is omitted", () => {
    render(
      <CurrencyMovementRow
        row={makeRow()}
        currencies={["USD"]}
        documentCurrency="USD"
        sessionRates={{}}
        onChange={onChange}
        onRemove={onRemove}
      />,
    );

    // Amount input still present — no testId on it in this case
    const inputs = screen.getAllByRole("spinbutton");
    expect(inputs.length).toBeGreaterThanOrEqual(1);
  });
});

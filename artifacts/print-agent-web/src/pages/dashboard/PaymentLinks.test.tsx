/**
 * Unit tests for PaymentLinksPage.
 *
 * Radix UI Select relies on pointer-capture / ResizeObserver / portals that
 * jsdom does not implement.  We replace all <Select*> components with plain
 * HTML equivalents (following the same pattern used in Settings.language.test.tsx)
 * so tests can interact through standard userEvent.selectOptions calls while
 * still exercising the real PaymentLinks logic.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { PropsWithChildren, OptionHTMLAttributes } from "react";
import PaymentLinksPage from "./PaymentLinks";

// ---------------------------------------------------------------------------
// Mock Radix UI Select with native HTML equivalents
// ---------------------------------------------------------------------------
vi.mock("@/components/ui/select", () => ({
  Select: ({
    value,
    onValueChange,
    children,
  }: PropsWithChildren<{
    value?: string;
    onValueChange?: (v: string) => void;
  }>) => (
    <select value={value ?? ""} onChange={(e) => onValueChange?.(e.target.value)}>
      {children}
    </select>
  ),
  SelectTrigger: ({
    children: _children,
    ...props
  }: PropsWithChildren<Record<string, unknown>>) => (
    <option value="" hidden {...(props as OptionHTMLAttributes<HTMLOptionElement>)} />
  ),
  SelectValue: () => null,
  SelectContent: ({ children }: PropsWithChildren) => <>{children}</>,
  SelectItem: ({
    value,
    children,
    disabled,
  }: PropsWithChildren<{ value: string; disabled?: boolean }>) => (
    <option value={value} disabled={disabled} aria-disabled={disabled ? "true" : undefined}>
      {children}
    </option>
  ),
}));

vi.mock("@tanstack/react-query", () => ({
  useQuery: vi.fn(({ queryKey }: { queryKey: readonly unknown[] }) => {
    if (queryKey[0] === "workspace-settings") {
      return {
        data: { available_countries: ["UAE", "UK", "USA"] },
        isLoading: false,
        isError: false,
      };
    }
    if (queryKey[0] === "payment-methods-status") {
      return {
        data: { stripe: true, paypal: true, mamo: true, mamo_enabled: true },
        isLoading: false,
        isError: false,
      };
    }
    return {
      data: { payment_links: [] },
      isLoading: false,
      isError: false,
      refetch: vi.fn(),
    };
  }),
  useMutation: vi.fn(() => ({ mutate: vi.fn(), isPending: false })),
  useQueryClient: vi.fn(() => ({ invalidateQueries: vi.fn() })),
}));

vi.mock("@/lib/queryClient", () => ({
  apiFetch: vi.fn(),
}));

vi.mock("@/hooks/use-toast", () => ({
  useToast: () => ({ toast: vi.fn() }),
}));

vi.mock("@/hooks/use-workspace-role", () => ({
  useWorkspaceRole: () => ({ isOwner: true, allowedPages: null, loaded: true }),
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Find the native <select> element that wraps the country trigger (identified
 * by data-testid="select-country" on its placeholder <option>) and choose the
 * given country via userEvent.selectOptions.
 */
async function selectCountry(
  user: ReturnType<typeof userEvent.setup>,
  country: string,
) {
  const placeholder = screen.getByTestId("select-country");
  const selectEl = placeholder.closest("select") as HTMLSelectElement;
  await user.selectOptions(selectEl, country);
}

/**
 * Find the native <select> element that wraps the currency trigger (identified
 * by id="pl-currency" on its placeholder <option>) and choose the given
 * currency via userEvent.selectOptions.
 */
async function selectCurrency(
  user: ReturnType<typeof userEvent.setup>,
  currency: string,
) {
  const placeholder = document.getElementById("pl-currency");
  const selectEl = (placeholder?.closest("select") ?? null) as HTMLSelectElement | null;
  if (!selectEl) throw new Error("Currency <select> not found");
  await user.selectOptions(selectEl, currency);
}

/**
 * Open the create dialog and select "UAE" as the country so that provider
 * buttons and the submit button are unlocked.
 */
async function openCreateDialog() {
  const user = userEvent.setup();
  render(<PaymentLinksPage />);
  await user.click(screen.getByTestId("button-create-payment-link"));
  await selectCountry(user, "UAE");
  return user;
}

/**
 * Open the create dialog WITHOUT selecting a country, so tests can verify the
 * "no country selected" disabled state.
 */
async function openCreateDialogNoCountry() {
  const user = userEvent.setup();
  render(<PaymentLinksPage />);
  await user.click(screen.getByTestId("button-create-payment-link"));
  return user;
}

// ---------------------------------------------------------------------------
// Tests: country dropdown visibility and required behaviour
// ---------------------------------------------------------------------------

describe("PaymentLinksPage — country dropdown", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("country dropdown is visible in the create dialog", async () => {
    await openCreateDialogNoCountry();
    expect(screen.getByTestId("select-country")).toBeInTheDocument();
  });

  it("country dropdown lists the countries returned by the settings API", async () => {
    await openCreateDialogNoCountry();
    const placeholder = screen.getByTestId("select-country");
    const selectEl = placeholder.closest("select") as HTMLSelectElement;
    expect(selectEl).toBeInTheDocument();
    expect(selectEl.querySelector('option[value="UAE"]')).toBeInTheDocument();
    expect(selectEl.querySelector('option[value="UK"]')).toBeInTheDocument();
    expect(selectEl.querySelector('option[value="USA"]')).toBeInTheDocument();
  });

  it("all provider buttons are disabled before a country is selected", async () => {
    await openCreateDialogNoCountry();
    expect(screen.getByTestId("button-provider-stripe")).toBeDisabled();
    expect(screen.getByTestId("button-provider-paypal")).toBeDisabled();
    expect(screen.getByTestId("button-provider-mamo")).toBeDisabled();
  });

  it("all provider buttons become enabled after a country is selected", async () => {
    const user = await openCreateDialogNoCountry();
    await selectCountry(user, "UAE");
    expect(screen.getByTestId("button-provider-stripe")).not.toBeDisabled();
  });

  it("submit button is disabled before a country is selected (even with a valid amount)", async () => {
    const user = await openCreateDialogNoCountry();
    await user.type(screen.getByTestId("input-payment-amount"), "10");
    expect(screen.getByTestId("button-create-submit")).toBeDisabled();
  });

  it("submit button is enabled after a country is selected and a valid amount is entered", async () => {
    const user = await openCreateDialogNoCountry();
    await user.type(screen.getByTestId("input-payment-amount"), "10");
    await selectCountry(user, "UK");
    expect(screen.getByTestId("button-create-submit")).not.toBeDisabled();
  });

  it("submit button remains disabled when country is selected but amount is empty", async () => {
    const user = await openCreateDialogNoCountry();
    await selectCountry(user, "USA");
    expect(screen.getByTestId("button-create-submit")).toBeDisabled();
  });
});

// ---------------------------------------------------------------------------
// Tests: unsupported currencies disable PayPal and show helper note
// ---------------------------------------------------------------------------

describe("PaymentLinksPage — PayPal disabled for unsupported currencies", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("disables the PayPal button when AED is selected", async () => {
    const user = await openCreateDialog();
    await selectCurrency(user, "AED");
    expect(screen.getByTestId("button-provider-paypal")).toBeDisabled();
  });

  it("disables the PayPal button when SAR is selected", async () => {
    const user = await openCreateDialog();
    await selectCurrency(user, "SAR");
    expect(screen.getByTestId("button-provider-paypal")).toBeDisabled();
  });

  it("shows LBP as a disabled option in the currency dropdown (no provider accepts it)", async () => {
    const user = await openCreateDialogNoCountry();
    const placeholder = document.getElementById("pl-currency");
    const selectEl = placeholder?.closest("select") as HTMLSelectElement;
    expect(selectEl).toBeInTheDocument();
    const lbpOption = selectEl.querySelector<HTMLOptionElement>('option[value="LBP"]');
    expect(lbpOption).toBeInTheDocument();
    expect(lbpOption).toHaveAttribute("aria-disabled", "true");
    expect(lbpOption).toHaveTextContent("(not supported)");
    // LBP option: suppress unused variable warning
    void user;
  });

  it("disables the PayPal button when DKK is selected", async () => {
    const user = await openCreateDialog();
    await selectCurrency(user, "DKK");
    expect(screen.getByTestId("button-provider-paypal")).toBeDisabled();
  });

  it("disables the PayPal button when QAR is selected", async () => {
    const user = await openCreateDialog();
    await selectCurrency(user, "QAR");
    expect(screen.getByTestId("button-provider-paypal")).toBeDisabled();
  });

  it("shows the PayPal unsupported helper note when AED is selected", async () => {
    const user = await openCreateDialog();
    await selectCurrency(user, "AED");
    expect(
      screen.getByText(/PayPal does not support this currency/i),
    ).toBeInTheDocument();
  });

  it("shows the PayPal unsupported helper note when SAR is selected", async () => {
    const user = await openCreateDialog();
    await selectCurrency(user, "SAR");
    expect(
      screen.getByText(/PayPal does not support this currency/i),
    ).toBeInTheDocument();
  });

  it("does not show the PayPal unsupported note when the default currency (USD) is active", async () => {
    await openCreateDialog();
    expect(
      screen.queryByText(/PayPal does not support this currency/i),
    ).not.toBeInTheDocument();
  });

  it("shows the PayPal and Mamo unsupported helper note when DKK is selected", async () => {
    const user = await openCreateDialog();
    await selectCurrency(user, "DKK");
    expect(
      screen.getByText(/PayPal and Mamo do not support this currency/i),
    ).toBeInTheDocument();
  });

  it("shows the PayPal unsupported helper note when QAR is selected", async () => {
    const user = await openCreateDialog();
    await selectCurrency(user, "QAR");
    expect(
      screen.getByText(/PayPal does not support this currency/i),
    ).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// Tests: supported currencies keep PayPal enabled
// ---------------------------------------------------------------------------

describe("PaymentLinksPage — PayPal enabled for supported currencies", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("PayPal button is not disabled for USD (the default currency)", async () => {
    await openCreateDialog();
    expect(screen.getByTestId("button-provider-paypal")).not.toBeDisabled();
  });

  it("PayPal button is not disabled when EUR is selected", async () => {
    const user = await openCreateDialog();
    await selectCurrency(user, "EUR");
    expect(screen.getByTestId("button-provider-paypal")).not.toBeDisabled();
  });

  it("PayPal button is not disabled when GBP is selected", async () => {
    const user = await openCreateDialog();
    await selectCurrency(user, "GBP");
    expect(screen.getByTestId("button-provider-paypal")).not.toBeDisabled();
  });

  it("does not show the unsupported note when a supported currency is selected", async () => {
    const user = await openCreateDialog();
    await selectCurrency(user, "EUR");
    expect(
      screen.queryByText(/PayPal does not support this currency/i),
    ).not.toBeInTheDocument();
  });

  it("re-enables PayPal after switching from an unsupported currency back to a supported one", async () => {
    const user = await openCreateDialog();

    await selectCurrency(user, "AED");
    expect(screen.getByTestId("button-provider-paypal")).toBeDisabled();

    await selectCurrency(user, "USD");
    expect(screen.getByTestId("button-provider-paypal")).not.toBeDisabled();
  });

  it("hides the helper note after switching from an unsupported currency back to a supported one", async () => {
    const user = await openCreateDialog();

    await selectCurrency(user, "QAR");
    expect(
      screen.getByText(/PayPal does not support this currency/i),
    ).toBeInTheDocument();

    await selectCurrency(user, "CAD");
    expect(
      screen.queryByText(/PayPal does not support this currency/i),
    ).not.toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// Tests: provider auto-resets to Stripe when PayPal is active and an
//        unsupported currency is selected
// ---------------------------------------------------------------------------

describe("PaymentLinksPage — provider auto-resets to Stripe on unsupported currency", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("switches provider back to Stripe when AED is chosen while PayPal is active", async () => {
    const user = await openCreateDialog();

    await user.click(screen.getByTestId("button-provider-paypal"));
    await selectCurrency(user, "AED");

    expect(screen.getByTestId("button-provider-paypal")).toBeDisabled();
    expect(screen.getByTestId("button-provider-stripe")).toHaveClass("border-primary");
  });

  it("switches provider back to Stripe when SAR is chosen while PayPal is active", async () => {
    const user = await openCreateDialog();

    await user.click(screen.getByTestId("button-provider-paypal"));
    await selectCurrency(user, "SAR");

    expect(screen.getByTestId("button-provider-paypal")).toBeDisabled();
    expect(screen.getByTestId("button-provider-stripe")).toHaveClass("border-primary");
  });

  it("does not reset provider when Stripe is active and an unsupported currency is chosen", async () => {
    const user = await openCreateDialog();

    await selectCurrency(user, "DKK");

    expect(screen.getByTestId("button-provider-stripe")).toHaveClass("border-primary");
    expect(screen.getByTestId("button-provider-paypal")).toBeDisabled();
  });

  it("keeps PayPal as the active provider when a supported currency is chosen", async () => {
    const user = await openCreateDialog();

    await user.click(screen.getByTestId("button-provider-paypal"));
    await selectCurrency(user, "EUR");

    expect(screen.getByTestId("button-provider-paypal")).not.toBeDisabled();
    expect(screen.getByTestId("button-provider-paypal")).toHaveClass("border-primary");
  });
});

// ---------------------------------------------------------------------------
// Tests: submit button disabled when amount is invalid
// ---------------------------------------------------------------------------

describe("PaymentLinksPage — submit button disabled for invalid amounts", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("submit button is disabled when amount field is empty (initial state)", async () => {
    await openCreateDialog();
    expect(screen.getByTestId("button-create-submit")).toBeDisabled();
  });

  it("submit button is disabled when amount is 0", async () => {
    const user = await openCreateDialog();
    await user.clear(screen.getByTestId("input-payment-amount"));
    await user.type(screen.getByTestId("input-payment-amount"), "0");
    expect(screen.getByTestId("button-create-submit")).toBeDisabled();
  });

  it("negative sign is filtered out, leaving the digit (e.g. '-5' → '5') and enabling submit", async () => {
    const user = await openCreateDialog();
    await user.clear(screen.getByTestId("input-payment-amount"));
    await user.type(screen.getByTestId("input-payment-amount"), "-5");
    expect(screen.getByTestId("input-payment-amount")).toHaveValue("5");
    expect(screen.getByTestId("button-create-submit")).not.toBeDisabled();
  });

  it("submit button is disabled when amount is purely alphabetic (e.g. 'abc')", async () => {
    const user = await openCreateDialog();
    await user.clear(screen.getByTestId("input-payment-amount"));
    await user.type(screen.getByTestId("input-payment-amount"), "abc");
    expect(screen.getByTestId("button-create-submit")).toBeDisabled();
  });

  it("submit button is disabled when amount contains only special characters (e.g. '$$')", async () => {
    const user = await openCreateDialog();
    await user.clear(screen.getByTestId("input-payment-amount"));
    await user.type(screen.getByTestId("input-payment-amount"), "$$");
    expect(screen.getByTestId("button-create-submit")).toBeDisabled();
  });

  it("submit button is disabled when amount is only whitespace", async () => {
    const user = await openCreateDialog();
    await user.clear(screen.getByTestId("input-payment-amount"));
    await user.type(screen.getByTestId("input-payment-amount"), "   ");
    expect(screen.getByTestId("button-create-submit")).toBeDisabled();
  });

  it("letters are filtered from mixed input (e.g. '12abc' → '12') and submit is enabled", async () => {
    const user = await openCreateDialog();
    await user.clear(screen.getByTestId("input-payment-amount"));
    await user.type(screen.getByTestId("input-payment-amount"), "12abc");
    expect(screen.getByTestId("input-payment-amount")).toHaveValue("12");
    expect(screen.getByTestId("button-create-submit")).not.toBeDisabled();
  });

  it("scientific notation 'e' is filtered (e.g. '1e5' → '15') and submit is enabled", async () => {
    const user = await openCreateDialog();
    await user.clear(screen.getByTestId("input-payment-amount"));
    await user.type(screen.getByTestId("input-payment-amount"), "1e5");
    expect(screen.getByTestId("input-payment-amount")).toHaveValue("15");
    expect(screen.getByTestId("button-create-submit")).not.toBeDisabled();
  });

  it("submit button is enabled when a valid positive amount is entered", async () => {
    const user = await openCreateDialog();
    await user.type(screen.getByTestId("input-payment-amount"), "10");
    expect(screen.getByTestId("button-create-submit")).not.toBeDisabled();
  });

  it("submit button is enabled when a valid decimal amount is entered (e.g. '10.50')", async () => {
    const user = await openCreateDialog();
    await user.type(screen.getByTestId("input-payment-amount"), "10.50");
    expect(screen.getByTestId("button-create-submit")).not.toBeDisabled();
  });
});

// ---------------------------------------------------------------------------
// Tests: decimal places are capped at 2
// ---------------------------------------------------------------------------

describe("PaymentLinksPage — amount field caps input at 2 decimal places", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("allows up to 2 decimal places (e.g. '9.99' stays as '9.99')", async () => {
    const user = await openCreateDialog();
    await user.type(screen.getByTestId("input-payment-amount"), "9.99");
    expect(screen.getByTestId("input-payment-amount")).toHaveValue("9.99");
  });

  it("blocks a third decimal digit (e.g. '10.999' is truncated to '10.99')", async () => {
    const user = await openCreateDialog();
    await user.type(screen.getByTestId("input-payment-amount"), "10.999");
    expect(screen.getByTestId("input-payment-amount")).toHaveValue("10.99");
  });

  it("blocks many extra decimal digits (e.g. '1.123456' is truncated to '1.12')", async () => {
    const user = await openCreateDialog();
    await user.type(screen.getByTestId("input-payment-amount"), "1.123456");
    expect(screen.getByTestId("input-payment-amount")).toHaveValue("1.12");
  });

  it("allows a trailing dot with no decimal digits (e.g. '5.')", async () => {
    const user = await openCreateDialog();
    await user.type(screen.getByTestId("input-payment-amount"), "5.");
    expect(screen.getByTestId("input-payment-amount")).toHaveValue("5.");
  });

  it("allows exactly one decimal digit (e.g. '5.5')", async () => {
    const user = await openCreateDialog();
    await user.type(screen.getByTestId("input-payment-amount"), "5.5");
    expect(screen.getByTestId("input-payment-amount")).toHaveValue("5.5");
  });
});

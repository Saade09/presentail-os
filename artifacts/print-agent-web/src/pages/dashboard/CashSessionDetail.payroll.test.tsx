import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock("wouter", () => ({
  useLocation: () => ["/cash-sessions/5", vi.fn()],
  useParams: () => ({ id: "5" }),
}));

const mockApiFetch = vi.fn();
vi.mock("@/lib/queryClient", () => ({
  apiFetch: (...args: unknown[]) => mockApiFetch(...args),
  getClerkToken: vi.fn().mockResolvedValue("tok"),
}));

vi.mock("@/hooks/use-toast", () => ({
  useToast: () => ({ toast: vi.fn() }),
}));

vi.mock("@/hooks/use-workspace-role", () => ({
  useWorkspaceRole: () => ({ isOwner: true, allowedPages: null }),
}));

vi.mock("@clerk/react", () => ({
  useUser: () => ({ user: { id: "user_test" } }),
}));

// ── Query state ─────────────────────────────────────────────────────────────
const EMPLOYEES = [
  { id: "tm_1", display_name: "Alice Smith", employee_code: "E001" },
  { id: "tm_2", display_name: "Bob Jones", employee_code: null },
];

vi.mock("@tanstack/react-query", () => ({
  useQuery: ({ queryKey }: { queryKey: unknown[] }) => {
    if (queryKey[0] === "cash-session-employees") return { data: EMPLOYEES };
    if (queryKey[0] === "payable-bills") return { data: { bills: [] } };
    return { data: undefined };
  },
  useMutation: ({
    mutationFn,
    onSuccess,
    onError,
  }: {
    mutationFn: (vars?: unknown) => Promise<unknown>;
    onSuccess?: (res: unknown) => void;
    onError?: (err: unknown) => void;
  }) => ({
    mutate: async (vars?: unknown) => {
      try {
        const res = await mutationFn(vars);
        onSuccess?.(res);
      } catch (err) {
        onError?.(err);
      }
    },
    isPending: false,
  }),
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
}));

import { QuickEntryPanel } from "./CashSessionDetail";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const DEFAULT_PROPS = {
  sessionId: "5",
  currencies: ["USD"],
  sessionRates: {},
  documentCurrency: "USD",
  thresholds: [],
  tab: "expense" as const,
  onTabChange: vi.fn(),
  onSaved: vi.fn(),
  currencySummary: [{ currency: "USD", expected_cash: 100, opening_cash: 100, sales_collected: 0, expenses_paid: 0, adjustments: 0 }],
};

async function switchToExpenseTab(user: ReturnType<typeof userEvent.setup>) {
  // Panel already starts on expense tab via DEFAULT_PROPS.tab
}

async function selectCategory(user: ReturnType<typeof userEvent.setup>, categoryLabel: string) {
  const trigger = screen.getByTestId("select-expense-category");
  await user.click(trigger);
  const option = screen.getByText(categoryLabel);
  await user.click(option);
}

async function switchModeToCashPurchase(user: ReturnType<typeof userEvent.setup>) {
  // Default mode is cash_purchase; click the button to ensure it
  const btn = screen.getByText("Cash purchase");
  await user.click(btn);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("QuickEntryPanel — payroll section", () => {
  let user: ReturnType<typeof userEvent.setup>;

  beforeEach(() => {
    user = userEvent.setup();
    mockApiFetch.mockReset();
    vi.clearAllMocks();
  });

  it("does not show payroll section for non-payroll categories", async () => {
    render(<QuickEntryPanel {...DEFAULT_PROPS} />);
    await selectCategory(user, "Supplies");
    expect(screen.queryByTestId("payroll-section")).toBeNull();
    // Payee and description fields appear instead
    expect(screen.getByTestId("input-expense-payee")).toBeInTheDocument();
    expect(screen.getByTestId("input-expense-description")).toBeInTheDocument();
  });

  it("shows payroll section when Salaries & wages is selected", async () => {
    render(<QuickEntryPanel {...DEFAULT_PROPS} />);
    await selectCategory(user, "Salaries & wages");
    expect(screen.getByTestId("payroll-section")).toBeInTheDocument();
    expect(screen.getByTestId("select-payroll-employee")).toBeInTheDocument();
    expect(screen.getByTestId("input-payroll-period")).toBeInTheDocument();
    expect(screen.getByTestId("select-payroll-payment-type")).toBeInTheDocument();
    expect(screen.getByTestId("input-payroll-notes")).toBeInTheDocument();
  });

  it("hides payee and description when payroll category is selected", async () => {
    render(<QuickEntryPanel {...DEFAULT_PROPS} />);
    await selectCategory(user, "Salaries & wages");
    expect(screen.queryByTestId("input-expense-payee")).toBeNull();
    expect(screen.queryByTestId("input-expense-description")).toBeNull();
  });

  it("lists employees from the employees endpoint in the employee dropdown", async () => {
    render(<QuickEntryPanel {...DEFAULT_PROPS} />);
    await selectCategory(user, "Salaries & wages");
    const employeeSelect = screen.getByTestId("select-payroll-employee");
    await user.click(employeeSelect);
    expect(screen.getByText("Alice Smith (E001)")).toBeInTheDocument();
    expect(screen.getByText("Bob Jones")).toBeInTheDocument();
  });

  it("resets payroll fields when category changes back to non-payroll", async () => {
    render(<QuickEntryPanel {...DEFAULT_PROPS} />);
    await selectCategory(user, "Salaries & wages");
    // Fill payroll period
    const periodInput = screen.getByTestId("input-payroll-period");
    await user.type(periodInput, "2025-03");
    // Switch to non-payroll category
    await selectCategory(user, "Supplies");
    expect(screen.queryByTestId("payroll-section")).toBeNull();
    // Switch back — fields should be empty
    await selectCategory(user, "Salaries & wages");
    const newPeriod = screen.getByTestId("input-payroll-period") as HTMLInputElement;
    expect(newPeriod.value).toBe("");
  });

  it("includes payroll fields in the submit payload", async () => {
    mockApiFetch.mockResolvedValueOnce({ transaction_id: 99 });

    render(<QuickEntryPanel {...DEFAULT_PROPS} />);
    await selectCategory(user, "Salaries & wages");

    // Fill amount
    const amountInput = screen.getByTestId("input-entry-amount");
    await user.type(amountInput, "500");

    // Select employee
    const employeeSelect = screen.getByTestId("select-payroll-employee");
    await user.click(employeeSelect);
    await user.click(screen.getByText("Alice Smith (E001)"));

    // Set period
    const periodInput = screen.getByTestId("input-payroll-period") as HTMLInputElement;
    await user.clear(periodInput);
    // Use fireEvent to set month input value directly (type="month" inputs have special behavior in jsdom)
    const { fireEvent } = await import("@testing-library/react");
    fireEvent.change(periodInput, { target: { value: "2025-03" } });

    // Select payment type
    const paymentTypeSelect = screen.getByTestId("select-payroll-payment-type");
    await user.click(paymentTypeSelect);
    await user.click(screen.getByText("Salary"));

    // Fill payment row (to make the form valid)
    const paymentInput = screen.getByTestId("expense-payment-0-amount");
    await user.type(paymentInput, "500");

    // Submit
    await user.click(screen.getByTestId("button-save-entry"));

    await waitFor(() => expect(mockApiFetch).toHaveBeenCalledTimes(1));

    const [url, opts] = mockApiFetch.mock.calls[0];
    expect(url).toBe("/api/cash-sessions/5/expense");
    const body = JSON.parse((opts as { body: string }).body);
    expect(body.expense_category).toBe("salaries_wages");
    expect(body.payroll_employee_id).toBe("tm_1");
    expect(body.payroll_period).toBe("2025-03");
    expect(body.payroll_payment_type).toBe("salary");
    expect(body).not.toHaveProperty("payee");
    expect(body).not.toHaveProperty("description");
  });

  it("renders field-level errors from the API next to each input", async () => {
    const fieldError = {
      status: 400,
      message: "Employee and payroll details are required.",
      body: {
        error: "Employee and payroll details are required.",
        fields: {
          payroll_employee_id: "Employee is required",
          payroll_period: "Payroll period is required (YYYY-MM)",
          payroll_payment_type: "Payment type is required",
        },
      },
    };
    mockApiFetch.mockRejectedValueOnce(fieldError);

    render(<QuickEntryPanel {...DEFAULT_PROPS} />);
    await selectCategory(user, "Salaries & wages");

    // Enter amount and payment to make basic validation pass
    const amountInput = screen.getByTestId("input-entry-amount");
    await user.type(amountInput, "200");
    const paymentInput = screen.getByTestId("expense-payment-0-amount");
    await user.type(paymentInput, "200");

    // Select employee, period, payment type (required for form validity)
    const employeeSelect = screen.getByTestId("select-payroll-employee");
    await user.click(employeeSelect);
    await user.click(screen.getByText("Alice Smith (E001)"));
    const { fireEvent } = await import("@testing-library/react");
    fireEvent.change(screen.getByTestId("input-payroll-period"), { target: { value: "2025-03" } });
    const ptSelect = screen.getByTestId("select-payroll-payment-type");
    await user.click(ptSelect);
    await user.click(screen.getByText("Salary"));

    await user.click(screen.getByTestId("button-save-entry"));

    await waitFor(() => {
      expect(screen.getByTestId("error-payroll-employee")).toBeInTheDocument();
      expect(screen.getByTestId("error-payroll-period")).toBeInTheDocument();
      expect(screen.getByTestId("error-payroll-payment-type")).toBeInTheDocument();
    });

    expect(screen.getByTestId("error-payroll-employee")).toHaveTextContent("Employee is required");
    expect(screen.getByTestId("error-payroll-period")).toHaveTextContent("Payroll period is required");
    expect(screen.getByTestId("error-payroll-payment-type")).toHaveTextContent("Payment type is required");
  });

  it("shows duplicate-payroll dialog on 409 response and resubmits with confirm_duplicate", async () => {
    const dupError = {
      status: 409,
      message: "Duplicate payroll expense detected.",
      body: {
        error: "Duplicate payroll expense detected. Submit again with confirm_duplicate: true to proceed.",
        duplicate: {
          transaction_id: 77,
          employee_name: "Alice Smith",
          period: "2025-03",
          payment_type: "salary",
        },
      },
    };
    // First call → 409 duplicate; second call (confirm) → success
    mockApiFetch
      .mockRejectedValueOnce(dupError)
      .mockResolvedValueOnce({ transaction_id: 88 });

    render(<QuickEntryPanel {...DEFAULT_PROPS} />);
    await selectCategory(user, "Salaries & wages");

    // Fill the form
    await user.type(screen.getByTestId("input-entry-amount"), "500");
    await user.click(screen.getByTestId("select-payroll-employee"));
    await user.click(screen.getByText("Alice Smith (E001)"));
    const { fireEvent } = await import("@testing-library/react");
    fireEvent.change(screen.getByTestId("input-payroll-period"), { target: { value: "2025-03" } });
    await user.click(screen.getByTestId("select-payroll-payment-type"));
    await user.click(screen.getByText("Salary"));
    await user.type(screen.getByTestId("expense-payment-0-amount"), "500");

    // Submit — expect duplicate dialog
    await user.click(screen.getByTestId("button-save-entry"));

    await waitFor(() =>
      expect(screen.getByTestId("button-confirm-duplicate")).toBeInTheDocument(),
    );

    // Confirm
    await user.click(screen.getByTestId("button-confirm-duplicate"));

    await waitFor(() => expect(mockApiFetch).toHaveBeenCalledTimes(2));

    const [, secondOpts] = mockApiFetch.mock.calls[1];
    const secondBody = JSON.parse((secondOpts as { body: string }).body);
    expect(secondBody.confirm_duplicate).toBe(true);

    // Dialog is closed after confirm
    expect(screen.queryByTestId("button-confirm-duplicate")).toBeNull();
  });

  it("cancelling the duplicate dialog does not resubmit", async () => {
    const dupError = {
      status: 409,
      message: "Duplicate payroll expense detected.",
      body: {
        error: "Duplicate payroll expense detected.",
        duplicate: {
          transaction_id: 77,
          employee_name: "Alice Smith",
          period: "2025-03",
          payment_type: "salary",
        },
      },
    };
    mockApiFetch.mockRejectedValueOnce(dupError);

    render(<QuickEntryPanel {...DEFAULT_PROPS} />);
    await selectCategory(user, "Salaries & wages");

    await user.type(screen.getByTestId("input-entry-amount"), "500");
    await user.click(screen.getByTestId("select-payroll-employee"));
    await user.click(screen.getByText("Alice Smith (E001)"));
    const { fireEvent } = await import("@testing-library/react");
    fireEvent.change(screen.getByTestId("input-payroll-period"), { target: { value: "2025-03" } });
    await user.click(screen.getByTestId("select-payroll-payment-type"));
    await user.click(screen.getByText("Salary"));
    await user.type(screen.getByTestId("expense-payment-0-amount"), "500");

    await user.click(screen.getByTestId("button-save-entry"));
    await waitFor(() => expect(screen.getByTestId("button-cancel-duplicate")).toBeInTheDocument());

    await user.click(screen.getByTestId("button-cancel-duplicate"));
    expect(mockApiFetch).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId("button-cancel-duplicate")).toBeNull();
  });
});

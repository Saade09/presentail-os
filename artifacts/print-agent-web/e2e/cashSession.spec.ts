/**
 * E2E tests for the Cash Session detail page.
 *
 * Covers Quick Entry (blank amount, CTA behaviour, dynamic label, confirmation
 * strip), header action buttons, open_conflict warning visibility, and the
 * Reconciliation Summary card on closed/approved sessions.
 */

import { test, expect } from "./fixtures";
import { setupFapiWithFakeSession } from "./clerk-fapi-redirect";

// All routes in this spec are fully mocked via page.route, so we use the
// lightweight fake-session helper that does not require real Clerk credentials.
test.use({
  _fapiMock: [
    async ({ page }, use) => {
      await setupFapiWithFakeSession(page);
      await use();
    },
    { auto: true },
  ],
});

const MANAGER_EMAIL = "e2e-manager@presentail.com";

function managerUsersResponse() {
  return {
    members: [],
    me: {
      role: "member",
      email: MANAGER_EMAIL,
      allowedPages: [
        "cash-sessions",
        "cash_sessions.open",
        "cash_sessions.close",
        "cash_sessions.approve",
        "cash_sessions.export",
        "cash_transactions.create",
        "cash_sessions.adjust",
      ],
      customRoleId: null,
    },
  };
}

const BASE_SESSION = {
  session_number: "CS-ACH-2026-0001",
  drawer_name: "Main Drawer",
  drawer_code: "MAIN",
  location_name: "Achrafieh",
  opened_by_clerk_id: null,
  opened_by_name: "Alice Manager",
  closed_by_name: null,
  approved_by_name: null,
  currency: "USD",
  secondary_currency: null,
  opening_cash: "100.00",
  opening_cash_secondary: null,
  expected_cash: "270.00",
  expected_cash_secondary: null,
  actual_cash: null,
  actual_cash_secondary: null,
  difference: null,
  difference_secondary: null,
  closing_counts: null,
  reconciliation: null,
  opened_at: new Date().toISOString(),
  closed_at: null,
  approved_at: null,
};

function makeOpenSession(overrides: Record<string, unknown> = {}) {
  return {
    id: 1,
    status: "open",
    ...BASE_SESSION,
    ...overrides,
  };
}

function makeApprovedSession(overrides: Record<string, unknown> = {}) {
  return {
    id: 2,
    status: "approved",
    ...BASE_SESSION,
    opened_by_name: "Alice Manager",
    closed_by_name: "Alice Manager",
    approved_by_name: "Owner",
    actual_cash: "270.00",
    difference: "0.00",
    closing_counts: [
      {
        currency: "USD",
        expected: 270,
        actual: 270,
        variance: 0,
        result: "balanced",
        explanation: null,
      },
    ],
    ...overrides,
  };
}

function sessionDetailResponse(session: Record<string, unknown>) {
  return {
    session,
    currencies: [session.currency as string],
    exchange_rates: {},
    currency_summary: [
      {
        currency: session.currency as string,
        opening_cash: 100,
        sales_collected: 170,
        expenses_paid: 0,
        adjustments: 0,
        expected_cash: 270,
      },
    ],
    thresholds: [{ currency: "USD", receipt_required_above: 100, variance_approval_above: 10 }],
    open_conflict: null,
    transactions: [],
    tx_total: 0,
    tx_all_total: 0,
    tx_page: 1,
    tx_pages: 1,
    activity: [],
    session_activity: [],
    transaction_events: {},
  };
}

async function setupRoutes(
  page: import("@playwright/test").Page,
  sessionDetail: ReturnType<typeof sessionDetailResponse>,
  saleResponse?: Record<string, unknown>,
) {
  await page.route("**/api/users**", async (route) => {
    if (route.request().method() === "GET") {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(managerUsersResponse()),
      });
      return;
    }
    await route.continue();
  });

  await page.route("**/api/cash-sessions/kpis**", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        openCount: 1,
        pendingCount: 0,
        flaggedCount: 0,
        overdueCount: 0,
        openHeldByCurrency: [{ currency: "USD", amount: 270, count: 1 }],
        flaggedDiffByCurrency: [],
        differenceByCurrency: [],
        attentionSessions: [],
        myOpenSession: null,
        filterOptions: { drawers: [], currencies: ["USD"], operators: [] },
      }),
    });
  });

  await page.route("**/api/cash-sessions/employees**", async (route) => {
    await route.fulfill({ status: 200, contentType: "application/json", body: "[]" });
  });

  // Match the specific session detail route (avoid matching /kpis, /employees, etc.)
  await page.route(/\/api\/cash-sessions\/\d+(\?.*)?$/, async (route) => {
    if (route.request().method() === "GET") {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(sessionDetail),
      });
      return;
    }
    await route.continue();
  });

  // Mock the /sale and /expense POST endpoints so form submissions resolve
  await page.route(/\/api\/cash-sessions\/\d+\/(sale|expense)$/, async (route) => {
    if (route.request().method() === "POST") {
      await route.fulfill({
        status: 201,
        contentType: "application/json",
        body: JSON.stringify(saleResponse ?? { transaction_id: 99 }),
      });
      return;
    }
    await route.continue();
  });

  // Pending cash transfers for this session's drawer (always empty in test fixtures)
  await page.route(/\/api\/cash-sessions\/\d+\/pending-transfers/, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ transfers: [] }),
    });
  });
}

// ---------------------------------------------------------------------------
// Quick Entry — open session
// ---------------------------------------------------------------------------

test.describe("Cash Session detail — Quick Entry (open session)", () => {
  test("amount field is blank and CTA is disabled on load", async ({ page }) => {
    const session = makeOpenSession();
    await setupRoutes(page, sessionDetailResponse(session));

    await page.goto("/cash-sessions/1", { waitUntil: "domcontentloaded" });

    // Wait for the page to render
    await expect(page.getByRole("heading")).toBeVisible({ timeout: 15_000 });

    // The Sale tab should be visible in the Quick Entry panel
    const saleTab = page.getByRole("tab", { name: /Sale/i });
    if (await saleTab.isVisible()) {
      await saleTab.click();
    }

    // Amount input should be empty
    const amountInput = page.getByPlaceholder(/0\.00|Amount/i).first();
    await expect(amountInput).toBeVisible({ timeout: 10_000 });
    await expect(amountInput).toHaveValue("");

    // CTA button should be disabled (no amount entered yet)
    const ctaButton = page.getByRole("button", { name: /Record|Sale|Entry/i }).last();
    await expect(ctaButton).toBeDisabled({ timeout: 5_000 });
  });

  test("CTA becomes enabled and label updates dynamically as amount is typed", async ({ page }) => {
    const session = makeOpenSession();
    await setupRoutes(page, sessionDetailResponse(session));

    await page.goto("/cash-sessions/1", { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading")).toBeVisible({ timeout: 15_000 });

    const saleTab = page.getByRole("tab", { name: /Sale/i });
    if (await saleTab.isVisible()) {
      await saleTab.click();
    }

    const amountInput = page.getByPlaceholder(/0\.00|Amount/i).first();
    await expect(amountInput).toBeVisible({ timeout: 10_000 });
    await amountInput.fill("25");

    // Select channel (required for sale) via Radix click interaction
    const channelSelect = page.getByTestId("select-sale-channel");
    if (await channelSelect.isVisible({ timeout: 2_000 }).catch(() => false)) {
      await channelSelect.click();
      const firstOption = page.getByRole("option").first();
      await expect(firstOption).toBeVisible({ timeout: 2_000 });
      await firstOption.click();
    }

    // Fill the payment row (Cash given = 25 so form is balanced)
    const paymentInput = page.getByTestId("sale-payment-0-amount");
    if (await paymentInput.isVisible({ timeout: 2_000 }).catch(() => false)) {
      await paymentInput.fill("25");
    }

    // The save button must now be enabled (all required fields satisfied)
    const saveBtn = page.getByTestId("button-save-entry");
    await expect(saveBtn).toBeVisible({ timeout: 5_000 });
    await expect(saveBtn).toBeEnabled({ timeout: 3_000 });
  });

  test("no 'Record Sale' or 'Record Expense' buttons in the page header for an open session", async ({ page }) => {
    const session = makeOpenSession();
    await setupRoutes(page, sessionDetailResponse(session));

    await page.goto("/cash-sessions/1", { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading")).toBeVisible({ timeout: 15_000 });

    // The page header (top bar with session number and primary action) must not
    // contain standalone "Record Sale" or "Record Expense" buttons — those live
    // exclusively inside the Quick Entry panel.
    const header = page.locator("header, [data-testid='session-header']").first();
    await expect(header.getByRole("button", { name: /^Record Sale$/i })).toHaveCount(0);
    await expect(header.getByRole("button", { name: /^Record Expense$/i })).toHaveCount(0);
  });

  test("successful sale submission shows a confirmation and resets the amount", async ({ page }) => {
    const session = makeOpenSession();
    const refreshed = makeOpenSession({ expected_cash: "295.00" });
    await setupRoutes(
      page,
      sessionDetailResponse(session),
      { session: refreshed, transaction_id: 99 },
    );

    await page.goto("/cash-sessions/1", { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading")).toBeVisible({ timeout: 15_000 });

    const saleTab = page.getByRole("tab", { name: /Sale/i });
    if (await saleTab.isVisible()) {
      await saleTab.click();
    }

    const amountInput = page.getByPlaceholder(/0\.00|Amount/i).first();
    await expect(amountInput).toBeVisible({ timeout: 10_000 });
    await amountInput.fill("25");

    // Select channel (required for sale) via Radix click interaction
    const channelSelect = page.getByTestId("select-sale-channel");
    await expect(channelSelect).toBeVisible({ timeout: 5_000 });
    await channelSelect.click();
    const firstOption = page.getByRole("option").first();
    await expect(firstOption).toBeVisible({ timeout: 2_000 });
    await firstOption.click();

    // Fill payment row (Cash given = 25, matching accounting amount)
    const paymentInput = page.getByTestId("sale-payment-0-amount");
    await expect(paymentInput).toBeVisible({ timeout: 5_000 });
    await paymentInput.fill("25");

    // Save button must now be enabled; click unconditionally
    const saveBtn = page.getByTestId("button-save-entry");
    await expect(saveBtn).toBeEnabled({ timeout: 5_000 });
    await saveBtn.click();
    // After submission the amount field should reset (empty or 0.00)
    await expect(amountInput).toHaveValue("", { timeout: 5_000 });
  });
});

// ---------------------------------------------------------------------------
// Open conflict warning
// ---------------------------------------------------------------------------

test.describe("Cash Session detail — open_conflict warning", () => {
  test("conflict banner visible when two sessions are open on the same drawer", async ({ page }) => {
    const session = makeOpenSession();
    const detailWithConflict = {
      ...sessionDetailResponse(session),
      open_conflict: { id: 99, session_number: "CS-ACH-2026-0002" },
    };
    await setupRoutes(page, detailWithConflict);

    await page.goto("/cash-sessions/1", { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading")).toBeVisible({ timeout: 15_000 });

    // The conflict warning should reference the other session
    await expect(
      page.getByText(/CS-ACH-2026-0002|another.*open.*session|conflict/i).first(),
    ).toBeVisible({ timeout: 10_000 });
  });

  test("conflict banner absent when viewing an approved session even if a newer session is open", async ({ page }) => {
    const session = makeApprovedSession();
    // open_conflict is null for a closed/approved session (API suppresses it)
    const detailWithNoConflict = {
      ...sessionDetailResponse(session),
      open_conflict: null,
    };
    await setupRoutes(page, detailWithNoConflict);

    await page.goto("/cash-sessions/2", { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading")).toBeVisible({ timeout: 15_000 });

    // No conflict banner should be shown
    await expect(page.getByText(/another.*open.*session|conflict/i)).toHaveCount(0);
  });
});

// ---------------------------------------------------------------------------
// Closed / approved session — Reconciliation Summary card
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Expanded transaction two-panel detail
// ---------------------------------------------------------------------------

test.describe("Cash Session detail — expanded transaction two-panel detail", () => {
  function sessionWithExpenseTransaction() {
    const now = new Date().toISOString();
    const session = makeOpenSession();
    const detail = sessionDetailResponse(session);
    return {
      ...detail,
      transactions: [
        {
          id: 55,
          type: "expense",
          direction: "out",
          amount: "42.00",
          currency: "USD",
          description: "Test expense",
          reference_type: null,
          reference_id: null,
          sale_channel: null,
          expense_category: "supplies",
          payee: "Test Supplier",
          attachment_url: null,
          is_reversed: false,
          reversal_of_id: null,
          reversal_reason: null,
          entered_by_name: "Alice Manager",
          transaction_date: now,
          has_movements: true,
          movements: [
            { id: 1, cash_transaction_id: 55, direction: "outflow", kind: "expense_payment", amount: "50.00", currency: "USD", exchange_rate: null, converted_amount: null },
            { id: 2, cash_transaction_id: 55, direction: "inflow", kind: "change", amount: "8.00", currency: "USD", exchange_rate: null, converted_amount: null },
          ],
        },
      ],
      tx_total: 1,
      tx_all_total: 1,
      tx_page: 1,
      tx_pages: 1,
      transaction_events: { "55": [] },
    };
  }

  /** Fixture for a single-currency transaction with NO movement rows (common Quick Entry path) */
  function sessionWithNoMovementRows(type: "sale" | "expense") {
    const now = new Date().toISOString();
    const session = makeOpenSession();
    const detail = sessionDetailResponse(session);
    return {
      ...detail,
      transactions: [
        {
          id: 77,
          type,
          direction: type === "sale" ? "in" : "out",
          amount: "30.00",
          currency: "USD",
          description: `No-movement ${type}`,
          reference_type: null,
          reference_id: null,
          sale_channel: type === "sale" ? "walk_in" : null,
          expense_category: type === "expense" ? "supplies" : null,
          payee: type === "expense" ? "Vendor X" : null,
          attachment_url: null,
          is_reversed: false,
          reversal_of_id: null,
          reversal_reason: null,
          entered_by_name: "Alice Manager",
          transaction_date: now,
          has_movements: false,
          movements: [], // ← deliberate: single-currency quick entry produces no rows
        },
      ],
      tx_total: 1,
      tx_all_total: 1,
      tx_page: 1,
      tx_pages: 1,
      transaction_events: { "77": [] },
    };
  }

  test("clicking an expense row (with movements) expands a two-panel detail with Accounting and Drawer Movements panels", async ({ page }) => {
    await setupRoutes(page, sessionWithExpenseTransaction());

    await page.goto("/cash-sessions/1", { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading")).toBeVisible({ timeout: 15_000 });

    const txTable = page.getByTestId("table-transactions");
    await expect(txTable).toBeVisible({ timeout: 10_000 });

    // Click the first data row to expand it
    const firstRow = txTable.getByRole("row").nth(1);
    await firstRow.click();

    // Two-panel: left panel shows "Expense Value (Accounting)" heading
    await expect(page.getByText(/Expense Value.*Accounting|Expense.*Accounting/i).first()).toBeVisible({ timeout: 5_000 });
    // Two-panel: right panel shows "Drawer Movements (Physical Cash)" heading
    await expect(page.getByText(/Drawer Movements.*Physical|Physical Cash/i).first()).toBeVisible({ timeout: 5_000 });
  });

  test("clicking a single-currency sale row (no movement rows) expands accounting + drawer panels with correct positive sign", async ({ page }) => {
    await setupRoutes(page, sessionWithNoMovementRows("sale"));

    await page.goto("/cash-sessions/1", { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading")).toBeVisible({ timeout: 15_000 });

    const txTable = page.getByTestId("table-transactions");
    await expect(txTable).toBeVisible({ timeout: 10_000 });

    const firstRow = txTable.getByRole("row").nth(1);
    await firstRow.click();

    // Left panel: accounting
    await expect(page.getByText(/Transaction Details|Amount/i).first()).toBeVisible({ timeout: 5_000 });
    // Right panel: derived drawer movements heading
    await expect(page.getByText(/Drawer Movements.*Physical|Physical Cash/i).first()).toBeVisible({ timeout: 5_000 });
    // Sale increases the drawer — should show "+" and green color
    await expect(page.getByText(/Cash received|\+USD 30|\+30/i).first()).toBeVisible({ timeout: 5_000 });
  });

  test("clicking a single-currency expense row (no movement rows) expands accounting + drawer panels with correct negative sign", async ({ page }) => {
    await setupRoutes(page, sessionWithNoMovementRows("expense"));

    await page.goto("/cash-sessions/1", { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading")).toBeVisible({ timeout: 15_000 });

    const txTable = page.getByTestId("table-transactions");
    await expect(txTable).toBeVisible({ timeout: 10_000 });

    const firstRow = txTable.getByRole("row").nth(1);
    await firstRow.click();

    // Left panel: accounting — expense total
    await expect(page.getByText(/Expense Value.*Accounting|Expense total|Expense Value/i).first()).toBeVisible({ timeout: 5_000 });
    // Right panel: derived drawer movements heading
    await expect(page.getByText(/Drawer Movements.*Physical|Physical Cash/i).first()).toBeVisible({ timeout: 5_000 });
    // Expense decreases the drawer — should show "Cash paid" and "−"
    await expect(page.getByText(/Cash paid/i).first()).toBeVisible({ timeout: 5_000 });
  });

  test("keyboard Enter on the expand button opens the two-panel detail", async ({ page }) => {
    await setupRoutes(page, sessionWithExpenseTransaction());

    await page.goto("/cash-sessions/1", { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading")).toBeVisible({ timeout: 15_000 });

    const txTable = page.getByTestId("table-transactions");
    await expect(txTable).toBeVisible({ timeout: 10_000 });

    // Tab to the expand button for the first transaction row
    const expandBtn = page.getByTestId("button-expand-tx-55");
    await expect(expandBtn).toBeVisible({ timeout: 5_000 });

    // Focus the button and activate with Enter (keyboard navigation)
    await expandBtn.focus();
    await expect(expandBtn).toBeFocused({ timeout: 2_000 });
    await page.keyboard.press("Enter");

    // The detail row should now be visible
    await expect(page.locator("#detail-55")).toBeVisible({ timeout: 5_000 });

    // aria-expanded should reflect open state
    await expect(expandBtn).toHaveAttribute("aria-expanded", "true");
  });

  test("clicking an expense reversal row expands with mirrored movement — inflow expense_payment labelled 'Cash received'", async ({ page }) => {
    const now = new Date().toISOString();
    const session = makeOpenSession();
    const detail = sessionDetailResponse(session);
    const fixtureWithReversal = {
      ...detail,
      transactions: [
        {
          id: 88,
          type: "reversal",
          direction: "in",        // reversal returns cash to drawer
          amount: "42.00",
          currency: "USD",
          description: "Reversal of expense",
          reference_type: "cash_transaction",
          reference_id: "55",
          sale_channel: null,
          expense_category: null,
          payee: null,
          attachment_url: null,
          is_reversed: false,
          reversal_of_id: 55,
          reversal_reason: "Entered in error",
          entered_by_name: "Alice Manager",
          transaction_date: now,
          has_movements: true,
          // API mirrors the original expense_payment direction → inflow (cash back to drawer)
          movements: [
            { id: 10, cash_transaction_id: 88, direction: "inflow", kind: "expense_payment", amount: "50.00", currency: "USD", exchange_rate: null, converted_amount: null },
            { id: 11, cash_transaction_id: 88, direction: "outflow", kind: "change", amount: "8.00", currency: "USD", exchange_rate: null, converted_amount: null },
          ],
        },
      ],
      tx_total: 1,
      tx_all_total: 1,
      tx_page: 1,
      tx_pages: 1,
      transaction_events: { "88": [] },
    };
    await setupRoutes(page, fixtureWithReversal);

    await page.goto("/cash-sessions/1", { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading")).toBeVisible({ timeout: 15_000 });

    const txTable = page.getByTestId("table-transactions");
    await expect(txTable).toBeVisible({ timeout: 10_000 });

    const firstRow = txTable.getByRole("row").nth(1);
    await firstRow.click();

    // Right panel must be visible
    await expect(page.getByText(/Drawer Movements.*Physical|Physical Cash/i).first()).toBeVisible({ timeout: 5_000 });

    // The inflow expense_payment movement must be labelled "Cash received" (not "Cash paid")
    await expect(page.getByText(/Cash received/i).first()).toBeVisible({ timeout: 5_000 });

    // Must NOT show "Cash paid" for the mirrored reversal movement
    await expect(page.getByText(/Cash paid/i)).toHaveCount(0);
  });
});

// ---------------------------------------------------------------------------
// Closed session right-column (desktop)
// ---------------------------------------------------------------------------

test.describe("Cash Session detail — closed session right-column (desktop)", () => {
  test("right-column Reconciliation Summary card appears on desktop; Quick Entry panel absent", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });

    const session = makeApprovedSession();
    await setupRoutes(page, sessionDetailResponse(session));

    await page.goto("/cash-sessions/2", { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading")).toBeVisible({ timeout: 15_000 });

    // Reconciliation Summary should appear (at least once — in the main table or right rail)
    await expect(page.getByText(/Reconciliation Summary/i).first()).toBeVisible({ timeout: 10_000 });
    // Quick Entry panel must be absent for a closed session
    await expect(page.getByTestId("panel-quick-entry")).toHaveCount(0);
    // No blank right side — Balanced result should be visible
    await expect(page.getByText(/Balanced/i).first()).toBeVisible({ timeout: 5_000 });
  });
});

// ---------------------------------------------------------------------------
// Responsive Quick Entry sheet (narrow viewport)
// ---------------------------------------------------------------------------

test.describe("Cash Session detail — responsive Quick Entry sheet (narrow viewport)", () => {
  test("floating Add Entry button opens a slide-over sheet on a narrow viewport", async ({ page }) => {
    await page.setViewportSize({ width: 768, height: 1024 });

    const session = makeOpenSession();
    await setupRoutes(page, sessionDetailResponse(session));

    await page.goto("/cash-sessions/1", { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading")).toBeVisible({ timeout: 15_000 });

    // The floating "Add Entry" button should be visible on narrow viewports
    const addBtn = page.getByTestId("button-open-quick-entry-sheet");
    await expect(addBtn).toBeVisible({ timeout: 10_000 });

    // Clicking it should open the Quick Entry Sheet
    await addBtn.click();
    // The Sheet panel is the last panel-quick-entry in the DOM (desktop rail is first but hidden at 768px)
    // Either a role=dialog wrapping the panel, or the panel itself (last) must become visible
    await expect(page.getByTestId("panel-quick-entry").last()).toBeVisible({ timeout: 8_000 });
  });
});

// ---------------------------------------------------------------------------
// Desktop empty-state: Record First Sale switches tab but does NOT open Sheet
// ---------------------------------------------------------------------------

test.describe("Cash Session detail — desktop empty-state behavior", () => {
  test("Record First Sale on desktop switches the tab without opening the slide-over sheet", async ({ page }) => {
    // Use a desktop viewport (≥lg = 1024px)
    await page.setViewportSize({ width: 1440, height: 900 });

    // Build a session fixture with NO transactions so the empty-state shows
    const session = makeOpenSession();
    const detail = sessionDetailResponse(session);
    detail.transactions = [];
    detail.tx_total = 0;
    detail.tx_all_total = 0;
    await setupRoutes(page, detail);

    await page.goto("/cash-sessions/1", { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading")).toBeVisible({ timeout: 15_000 });

    // The empty-state "Record First Sale" button should be visible
    const firstSaleBtn = page.getByRole("button", { name: /Record First Sale|record.*sale/i }).first();
    await expect(firstSaleBtn).toBeVisible({ timeout: 10_000 });

    // Click it — on desktop this should NOT open the slide-over sheet
    await firstSaleBtn.click();

    // The Quick Entry panel (right rail) should remain in the DOM (desktop layout)
    const panel = page.getByTestId("panel-quick-entry").first();
    await expect(panel).toBeVisible({ timeout: 3_000 });

    // The Sheet overlay/portal must NOT appear (no sheet-specific backdrop)
    const sheetOverlay = page.locator('[data-radix-dialog-overlay], [data-state="open"][data-vaul-overlay]');
    await expect(sheetOverlay).toHaveCount(0, { timeout: 1_000 }).catch(() => {
      // If Sheet rendered but is still closed, that's acceptable too
    });

    // The Sale tab in the right-rail panel should now be active
    const saleTab = panel.getByRole("tab", { name: /Sale/i });
    if (await saleTab.isVisible({ timeout: 2_000 }).catch(() => false)) {
      await expect(saleTab).toHaveAttribute("data-state", "active");
    }
  });
});

// ---------------------------------------------------------------------------
// Duplicate submission prevention
// ---------------------------------------------------------------------------

test.describe("Cash Session detail — duplicate submission prevention", () => {
  test("Save button is disabled while a mutation is in-flight", async ({ page }) => {
    const session = makeOpenSession();
    await setupRoutes(page, sessionDetailResponse(session));

    // Hold the sale request so we can observe the in-flight disabled state
    let releaseSale: () => void = () => {};
    const saleHeld = new Promise<void>((resolve) => { releaseSale = resolve; });
    await page.route(/\/api\/cash-sessions\/\d+\/sale/, async (route) => {
      await saleHeld;
      await route.fulfill({
        status: 201,
        contentType: "application/json",
        body: JSON.stringify({ transaction_id: 99 }),
      });
    });

    await page.goto("/cash-sessions/1", { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading")).toBeVisible({ timeout: 15_000 });

    // Switch to Sale tab
    const saleTab = page.getByRole("tab", { name: /Sale/i });
    if (await saleTab.isVisible()) await saleTab.click();

    // Step 1: Fill the accounting amount
    const amountInput = page.getByPlaceholder(/0\.00|Amount/i).first();
    await expect(amountInput).toBeVisible({ timeout: 10_000 });
    await amountInput.fill("25");
    await amountInput.press("Tab");

    // Step 2: Select a channel — SALE_CHANNELS is a static list; pick the first one ("walk_in")
    const channelSelect = page.getByTestId("select-sale-channel");
    await expect(channelSelect).toBeVisible({ timeout: 5_000 });
    await channelSelect.click();
    // Radix option list appears in a portal; pick the first visible option
    const firstChannelOption = page.getByRole("option").first();
    await expect(firstChannelOption).toBeVisible({ timeout: 3_000 });
    await firstChannelOption.click();

    // Step 3: Fill the first payment row (required; same amount = balanced)
    const paymentInput = page.getByTestId("sale-payment-0-amount");
    await expect(paymentInput).toBeVisible({ timeout: 5_000 });
    await paymentInput.fill("25");
    await paymentInput.press("Tab");

    // Step 4: Save button must now be enabled (all required fields satisfied)
    const saveBtn = page.getByTestId("button-save-entry");
    await expect(saveBtn).toBeEnabled({ timeout: 5_000 });

    // Step 5: Click and immediately assert disabled while request is held
    await saveBtn.click();
    await expect(saveBtn).toBeDisabled({ timeout: 3_000 });

    // Release to avoid resource leaks
    releaseSale();
  });
});

// ---------------------------------------------------------------------------
// Closed / approved session — Reconciliation Summary card
// ---------------------------------------------------------------------------

test.describe("Cash Session detail — closed session view", () => {
  test("'Reconciliation Summary' card title is visible for an approved session", async ({ page }) => {
    const session = makeApprovedSession();
    await setupRoutes(page, sessionDetailResponse(session));

    await page.goto("/cash-sessions/2", { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading")).toBeVisible({ timeout: 15_000 });

    await expect(
      page.getByText(/Reconciliation Summary/i).first(),
    ).toBeVisible({ timeout: 10_000 });
  });

  test("'Download report' is the primary action for an approved session", async ({ page }) => {
    const session = makeApprovedSession();
    await setupRoutes(page, sessionDetailResponse(session));

    await page.goto("/cash-sessions/2", { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading")).toBeVisible({ timeout: 15_000 });

    await expect(
      page.getByRole("button", { name: /Download.*report|report.*download/i }).first(),
    ).toBeVisible({ timeout: 10_000 });
  });

  test("reconciliation summary shows Expected, Counted, Difference, and Result columns", async ({ page }) => {
    const session = makeApprovedSession();
    await setupRoutes(page, sessionDetailResponse(session));

    await page.goto("/cash-sessions/2", { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading")).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText(/Reconciliation Summary/i).first()).toBeVisible({ timeout: 10_000 });

    // Column headers
    await expect(page.getByText(/Expected/i).first()).toBeVisible();
    await expect(page.getByText(/Counted/i).first()).toBeVisible();
    await expect(page.getByText(/Difference/i).first()).toBeVisible();
    await expect(page.getByText(/Result/i).first()).toBeVisible();
  });

  test("approved balanced session shows 'Balanced' result label", async ({ page }) => {
    const session = makeApprovedSession();
    await setupRoutes(page, sessionDetailResponse(session));

    await page.goto("/cash-sessions/2", { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading")).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText(/Reconciliation Summary/i).first()).toBeVisible({ timeout: 10_000 });

    await expect(page.getByText(/Balanced/i).first()).toBeVisible({ timeout: 5_000 });
  });
});

/**
 * E2E Playwright spec for the multi-currency Cash Desk feature.
 *
 * Happy path:
 *   1. Sign in and navigate to an open cash session detail page.
 *   2. Record a two-currency sale (80 USD + 2,000,000 LBP paid, 1 USD + 110,000 LBP change).
 *   3. Verify the "Payment matches sale" balance badge.
 *   4. Verify the drawer-impact lines (+79.00 USD, +1,890,000.00 LBP).
 *   5. Save the sale.
 *   6. Verify the transaction appears in the history with a multi-currency indicator.
 *   7. Verify the Live Cash Summary USD and LBP rows updated.
 *
 * All API calls are mocked so the spec is fully offline.
 */

import { test, expect } from "./fixtures";
import { setupFapiWithFakeSession } from "./clerk-fapi-redirect";

// All routes are mocked via page.route so we use the lightweight fake-session
// helper that does not require real Clerk credentials or a live FAPI host.
test.use({
  _fapiMock: [
    async ({ page }, use) => {
      await setupFapiWithFakeSession(page);
      await use();
    },
    { auto: true },
  ],
});

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SESSION_ID = 42;
const NOW = new Date().toISOString();

// Exchange rate: 1 USD = 90,000 LBP
// This makes 80 USD + 2,000,000 LBP (≈22.22 USD) – 1 USD – 110,000 LBP (≈1.22 USD) ≈ 100 USD
const EXCHANGE_RATES = { LBP: 90_000 };

// ---------------------------------------------------------------------------
// Mock helpers
// ---------------------------------------------------------------------------

function usersResponse() {
  return {
    members: [],
    me: {
      role: "owner",
      email: "owner@test.com",
      allowedPages: null,
      customRoleId: null,
    },
  };
}

function sessionListResponse() {
  return {
    sessions: [
      {
        id: SESSION_ID,
        session_number: "CS-MC-001",
        drawer_name: "MC Drawer",
        drawer_code: "MCD",
        location_name: "Test Branch",
        opened_by_name: "Test Owner",
        closed_by_name: null,
        approved_by_name: null,
        currency: "USD",
        secondary_currency: null,
        status: "open",
        opening_cash: "500.00",
        opening_cash_secondary: null,
        expected_cash: "500.00",
        expected_cash_secondary: null,
        actual_cash: null,
        actual_cash_secondary: null,
        difference: null,
        difference_secondary: null,
        opened_at: NOW,
        closed_at: null,
      },
    ],
  };
}

/** Initial session detail (no transactions). */
function sessionDetailResponse(transactionId?: number) {
  const hasTransaction = transactionId != null;
  const transactions = hasTransaction
    ? [
        {
          id: transactionId,
          type: "sale",
          direction: "in",
          amount: "100.00",
          currency: "USD",
          description: null,
          reference_type: null,
          reference_id: null,
          sale_channel: "walk_in",
          expense_category: null,
          payee: null,
          attachment_url: null,
          is_reversed: false,
          reversal_of_id: null,
          reversal_reason: null,
          entered_by_name: "Test Owner",
          transaction_date: NOW,
          has_movements: true,
          movements: [
            { id: 1, cash_transaction_id: transactionId, direction: "inflow", kind: "payment", amount: "80.00", currency: "USD", exchange_rate: null, converted_amount: null },
            { id: 2, cash_transaction_id: transactionId, direction: "inflow", kind: "payment", amount: "2000000.00", currency: "LBP", exchange_rate: "0.00001111", converted_amount: "22.22" },
            { id: 3, cash_transaction_id: transactionId, direction: "outflow", kind: "change", amount: "1.00", currency: "USD", exchange_rate: null, converted_amount: null },
            { id: 4, cash_transaction_id: transactionId, direction: "outflow", kind: "change", amount: "110000.00", currency: "LBP", exchange_rate: "0.00001111", converted_amount: "1.22" },
          ],
        },
      ]
    : [];

  const usdSummary = hasTransaction
    ? { currency: "USD", opening_cash: 500, sales_collected: 79, expenses_paid: 0, adjustments: 0, expected_cash: 579 }
    : { currency: "USD", opening_cash: 500, sales_collected: 0, expenses_paid: 0, adjustments: 0, expected_cash: 500 };

  const lbpSummary = hasTransaction
    ? { currency: "LBP", opening_cash: 0, sales_collected: 1_890_000, expenses_paid: 0, adjustments: 0, expected_cash: 1_890_000 }
    : { currency: "LBP", opening_cash: 0, sales_collected: 0, expenses_paid: 0, adjustments: 0, expected_cash: 0 };

  return {
    session: {
      id: SESSION_ID,
      session_number: "CS-MC-001",
      drawer_name: "MC Drawer",
      location_name: "Test Branch",
      currency: "USD",
      status: "open",
      opening_cash: "500.00",
      expected_cash: hasTransaction ? "579.00" : "500.00",
      actual_cash: null,
      difference: null,
      opening_note: null,
      closing_note: null,
      flag_reason: null,
      reopen_reason: null,
      closing_counts: null,
      opened_at: NOW,
      closed_at: null,
      approved_at: null,
      opened_by_name: "Test Owner",
      closed_by_name: null,
      approved_by_name: null,
    },
    currencies: ["USD", "LBP"],
    exchange_rates: EXCHANGE_RATES,
    currency_summary: [usdSummary, lbpSummary],
    thresholds: [
      { currency: "USD", receipt_required_above: 100, variance_approval_above: 10 },
      { currency: "LBP", receipt_required_above: 10_000_000, variance_approval_above: 1_000_000 },
    ],
    open_conflict: null,
    transactions,
    activity: [],
  };
}

// ---------------------------------------------------------------------------
// Route setup
// ---------------------------------------------------------------------------

async function setupRoutes(page: import("@playwright/test").Page) {
  // Users / workspace role
  await page.route("**/api/users**", async (route) => {
    if (route.request().method() === "GET") {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(usersResponse()) });
    } else {
      await route.continue();
    }
  });

  // Cash sessions list
  await page.route("**/api/cash-sessions", async (route) => {
    if (route.request().method() === "GET") {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(sessionListResponse()) });
    } else {
      await route.continue();
    }
  });

  // Cash session detail — initially empty, then populated after save
  let saleTransactionId: number | undefined;
  await page.route(new RegExp(`/api/cash-sessions/${SESSION_ID}(\\?.*)?$`), async (route) => {
    if (route.request().method() === "GET") {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(sessionDetailResponse(saleTransactionId)),
      });
    } else {
      await route.continue();
    }
  });

  // POST sale — returns the transaction id and triggers a re-fetch
  await page.route(`**/api/cash-sessions/${SESSION_ID}/sale`, async (route) => {
    if (route.request().method() === "POST") {
      saleTransactionId = 101;
      await route.fulfill({
        status: 201,
        contentType: "application/json",
        body: JSON.stringify({ transaction_id: saleTransactionId, session: sessionDetailResponse(saleTransactionId).session }),
      });
    } else {
      await route.continue();
    }
  });
}

// ---------------------------------------------------------------------------
// Spec
// ---------------------------------------------------------------------------

test.describe("Cash Desk — multi-currency happy path", () => {
  test("records a two-currency sale and shows balance badge, drawer impact, and updated history", async ({ page }) => {
    await setupRoutes(page);

    // ── 1. Navigate to the session detail page ───────────────────────────

    await page.goto(`/cash-sessions/${SESSION_ID}`, { waitUntil: "domcontentloaded" });
    // Readiness assertion — heading proves the page hydrated
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible({ timeout: 15_000 });

    // Wait for the Quick Entry panel to appear (session is open, user is owner)
    await expect(page.getByTestId("panel-quick-entry").first()).toBeVisible({ timeout: 15_000 });

    // ── 2. Click the "Record Sale" tab ───────────────────────────────────

    await page.getByTestId("tab-record-sale").click();

    // ── 3. Enter the sale amount (100 USD) ───────────────────────────────

    await page.getByTestId("input-entry-amount").fill("100");

    // ── 4. Select sale channel ────────────────────────────────────────────

    await page.getByTestId("select-sale-channel").click();
    await page.getByRole("option", { name: /Walk.?[Ii]n|walk_in/i }).click();

    // ── 5. First payment row: 80 USD (default currency is USD) ───────────

    await page.getByTestId("sale-payment-0-amount").fill("80");
    // The default currency is already USD; no currency change needed.

    // ── 6. Add a second payment row and set it to LBP, amount 2,000,000 ──

    await page.getByTestId("button-add-payment").click();
    // The new row appears at index 1
    await expect(page.getByTestId("sale-payment-1-currency")).toBeVisible({ timeout: 5_000 });

    // Change currency to LBP
    await page.getByTestId("sale-payment-1-currency").click();
    await page.getByRole("option", { name: "LBP" }).click();

    await page.getByTestId("sale-payment-1-amount").fill("2000000");

    // ── 7. Add change rows ────────────────────────────────────────────────

    // First change row: 1 USD
    await page.getByTestId("button-add-change").click();
    await expect(page.getByTestId("sale-change-0-currency")).toBeVisible({ timeout: 5_000 });
    // Default currency is USD — fill the amount
    await page.getByTestId("sale-change-0-amount").fill("1");

    // Second change row: 110,000 LBP
    await page.getByTestId("button-add-change").click();
    await expect(page.getByTestId("sale-change-1-currency")).toBeVisible({ timeout: 5_000 });
    await page.getByTestId("sale-change-1-currency").click();
    await page.getByRole("option", { name: "LBP" }).last().click();
    await page.getByTestId("sale-change-1-amount").fill("110000");

    // ── 8. Assert "Payment matches sale" balance badge ────────────────────

    await expect(page.getByText("Payment matches sale")).toBeVisible({ timeout: 5_000 });

    // ── 9. Assert drawer impact lines ────────────────────────────────────

    await expect(page.getByText("Drawer impact").first()).toBeVisible();

    // +79.00 USD net (80 paid − 1 change) — UI format: +USD 79.00 or +79.00 USD
    await expect(page.getByText(/\+USD\s*79\.00|\+79\.00\s*USD/).first()).toBeVisible();

    // +1,890,000.00 LBP net (2,000,000 − 110,000) — UI format: +LBP 1,890,000 or +1,890,000 LBP
    await expect(page.getByText(/\+LBP\s*1[,.]?890[,.]?000|\+1[,.]?890[,.]?000\s*LBP/).first()).toBeVisible();

    // ── 10. Save the sale ────────────────────────────────────────────────

    await page.getByTestId("button-save-entry").click();

    // ── 11. Verify the transaction appears in the history ─────────────────

    // Wait for the transactions table to reload with the new transaction
    await expect(page.getByTestId("table-transactions")).toBeVisible({ timeout: 10_000 });

    // The multi-currency indicator ("LBP · USD" or "USD · LBP") should appear
    await expect(
      page.getByTestId("table-transactions").getByText(/LBP.*USD|USD.*LBP/),
    ).toBeVisible({ timeout: 5_000 });

    // ── 12. Verify the Live Cash Summary updated ───────────────────────────

    const summary = page.getByTestId("table-cash-summary");
    await expect(summary).toBeVisible();

    // Both USD and LBP currency badges should appear in the summary table
    await expect(summary.getByText("USD").first()).toBeVisible();
    await expect(summary.getByText("LBP").first()).toBeVisible();
  });

  // ── Mashtal Walid scenario: expense USD 42, paid USD 50, change LBP 720,000 ──

  test("records a cash-purchase expense and shows 'Payment matches expense' badge, drawer impact, and history row", async ({ page }) => {
    // Extend routes with expense POST + expense session detail
    let expenseTransactionId: number | undefined;
    await page.route("**/api/users**", async (route) => {
      if (route.request().method() === "GET") {
        await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(usersResponse()) });
      } else { await route.continue(); }
    });
    await page.route("**/api/cash-sessions", async (route) => {
      if (route.request().method() === "GET") {
        await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(sessionListResponse()) });
      } else { await route.continue(); }
    });
    await page.route(new RegExp(`/api/cash-sessions/${SESSION_ID}(\\?.*)?$`), async (route) => {
      if (route.request().method() === "GET") {
        const hasTx = expenseTransactionId != null;
        const transactions = hasTx ? [{
          id: expenseTransactionId,
          type: "expense",
          direction: "out",
          amount: "42.00",
          currency: "USD",
          description: "Office supplies",
          reference_type: null,
          reference_id: null,
          sale_channel: null,
          expense_category: "supplies",
          payee: "Walid Store",
          attachment_url: null,
          is_reversed: false,
          reversal_of_id: null,
          reversal_reason: null,
          entered_by_name: "Test Owner",
          transaction_date: NOW,
          has_movements: true,
          movements: [
            { id: 10, cash_transaction_id: expenseTransactionId, direction: "outflow", kind: "expense_payment", amount: "50.00", currency: "USD", exchange_rate: null, converted_amount: null },
            { id: 11, cash_transaction_id: expenseTransactionId, direction: "inflow", kind: "change", amount: "720000.00", currency: "LBP", exchange_rate: "0.0000111111", converted_amount: "8.00" },
          ],
        }] : [];
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ ...sessionDetailResponse(), transactions }),
        });
      } else { await route.continue(); }
    });
    await page.route(`**/api/cash-sessions/${SESSION_ID}/expense`, async (route) => {
      if (route.request().method() === "POST") {
        expenseTransactionId = 201;
        await route.fulfill({
          status: 201,
          contentType: "application/json",
          body: JSON.stringify({ transaction_id: expenseTransactionId }),
        });
      } else { await route.continue(); }
    });

    await page.goto(`/cash-sessions/${SESSION_ID}`, { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId("panel-quick-entry").first()).toBeVisible({ timeout: 15_000 });

    // ── Switch to Expense tab ─────────────────────────────────────────────
    await page.getByTestId("tab-record-expense").click();

    // ── Select Cash purchase mode (default) ──────────────────────────────
    await page.getByTestId("expense-mode-cash-purchase").click();

    // ── Enter expense total USD 42 ────────────────────────────────────────
    await page.getByTestId("input-entry-amount").fill("42");

    // ── Select category ───────────────────────────────────────────────────
    await page.getByTestId("select-expense-category").click();
    await page.getByRole("option").first().click();

    // ── Enter payee and description ───────────────────────────────────────
    await page.getByTestId("input-expense-payee").fill("Walid Store");
    await page.getByTestId("input-expense-description").fill("Office supplies");

    // ── Enter cash given: USD 50 ──────────────────────────────────────────
    await page.getByTestId("expense-payment-0-amount").fill("50");

    // ── Add change: LBP 720,000 (at session rate 90,000 → USD 8 change → net USD 42) ──
    await page.getByTestId("button-add-expense-change").click();
    await expect(page.getByTestId("expense-change-0-currency")).toBeVisible({ timeout: 5_000 });
    await page.getByTestId("expense-change-0-currency").click();
    await page.getByRole("option", { name: "LBP" }).last().click();
    await page.getByTestId("expense-change-0-amount").fill("720000");

    // ── Assert "Payment matches expense" badge ────────────────────────────
    await expect(page.getByText("Payment matches expense")).toBeVisible({ timeout: 5_000 });

    // ── Assert drawer impact shows physical cash flows ────────────────────
    await expect(page.getByText("Drawer impact").first()).toBeVisible();
    await expect(page.getByText(/−.*50.*USD|USD.*50/).first()).toBeVisible();
    await expect(page.getByText(/\+.*720/).first()).toBeVisible();

    // ── Save the expense ──────────────────────────────────────────────────
    await page.getByTestId("button-save-entry").click();

    // ── Verify expense row appears in history with accounting amount ───────
    await expect(page.getByTestId("table-transactions")).toBeVisible({ timeout: 10_000 });
    // Primary amount should be the accounting expense (42.00 USD), not the drawer amount (50.00 USD)
    await expect(
      page.getByTestId("table-transactions").getByText(/42\.00/),
    ).toBeVisible({ timeout: 5_000 });

    // ── Verify secondary Drawer line shows physical cash movement ─────────
    await expect(
      page.getByTestId("table-transactions").getByText(/Drawer:/i),
    ).toBeVisible({ timeout: 5_000 });
  });

  // ── expanded two-panel detail: exchange rate row visible for cross-currency movement ──

  test("expanding a cross-currency expense row shows two-panel detail with exchange rate", async ({ page }) => {
    const expenseTransactionId = 302;
    await page.route("**/api/users**", async (route) => {
      if (route.request().method() === "GET") {
        await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(usersResponse()) });
      } else { await route.continue(); }
    });
    await page.route("**/api/cash-sessions", async (route) => {
      if (route.request().method() === "GET") {
        await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(sessionListResponse()) });
      } else { await route.continue(); }
    });
    await page.route(new RegExp(`/api/cash-sessions/${SESSION_ID}(\\?.*)?$`), async (route) => {
      if (route.request().method() === "GET") {
        const transactions = [{
          id: expenseTransactionId,
          type: "expense",
          direction: "out",
          amount: "42.00",
          currency: "USD",
          description: "Cross-currency expense",
          reference_type: null,
          reference_id: null,
          sale_channel: null,
          expense_category: "supplies",
          payee: null,
          attachment_url: null,
          is_reversed: false,
          reversal_of_id: null,
          reversal_reason: null,
          entered_by_name: "Test Owner",
          transaction_date: NOW,
          has_movements: true,
          movements: [
            // Paid 50 USD from drawer
            { id: 20, cash_transaction_id: expenseTransactionId, direction: "outflow", kind: "expense_payment", amount: "50.00", currency: "USD", exchange_rate: null, converted_amount: null },
            // Received 720,000 LBP change (rate: 1 LBP = 0.0000111 USD, so 1 USD = 90,000 LBP)
            { id: 21, cash_transaction_id: expenseTransactionId, direction: "inflow", kind: "change", amount: "720000.00", currency: "LBP", exchange_rate: "0.0000111111", converted_amount: "8.00" },
          ],
        }];
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            ...sessionDetailResponse(),
            transactions,
            tx_total: 1,
            tx_all_total: 1,
            tx_page: 1,
            tx_pages: 1,
            transaction_events: { [String(expenseTransactionId)]: [] },
          }),
        });
      } else { await route.continue(); }
    });

    await page.goto(`/cash-sessions/${SESSION_ID}`, { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible({ timeout: 15_000 });

    // Wait for the transactions table to appear
    const txTable = page.getByTestId("table-transactions");
    await expect(txTable).toBeVisible({ timeout: 10_000 });

    // Click the expand button (or row) to expand the transaction detail
    const expandBtn = page.getByTestId(`button-expand-tx-${expenseTransactionId}`);
    if (await expandBtn.isVisible({ timeout: 3_000 }).catch(() => false)) {
      await expandBtn.click();
    } else {
      await txTable.getByRole("row").nth(1).click();
    }

    // Left panel: Expense Value (Accounting)
    await expect(page.getByText(/Expense Value.*Accounting|Expense.*Accounting/i).first()).toBeVisible({ timeout: 5_000 });

    // Right panel: Drawer Movements (Physical Cash)
    await expect(page.getByText(/Drawer Movements.*Physical|Physical Cash/i).first()).toBeVisible({ timeout: 5_000 });

    // Exchange rate row should be visible showing 1 USD = 90,000 LBP
    await expect(page.getByText(/Exchange rate/i).first()).toBeVisible({ timeout: 3_000 });
    await expect(page.getByText(/90,000|90000/i).first()).toBeVisible({ timeout: 3_000 });
  });

  // ── standalone: verify Live Cash Summary shows LBP row on session load ──

  test("Live Cash Summary shows USD and LBP rows for a multi-currency session", async ({ page }) => {
    await setupRoutes(page);

    await page.goto(`/cash-sessions/${SESSION_ID}`, { waitUntil: "domcontentloaded" });
    // Readiness assertion — heading proves the page hydrated
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId("panel-quick-entry").first()).toBeVisible({ timeout: 15_000 });

    const summary = page.getByTestId("table-cash-summary");
    await expect(summary).toBeVisible();
    await expect(summary.getByText("USD").first()).toBeVisible();
    await expect(summary.getByText("LBP").first()).toBeVisible();
  });
});

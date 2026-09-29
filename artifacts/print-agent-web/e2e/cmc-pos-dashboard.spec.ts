import { test, expect } from "./fixtures";
import { setupClerkTestingToken } from "@clerk/testing/playwright";
import type { Page } from "@playwright/test";

/**
 * E2E tests for the redesigned CMC POS Dashboard (/cmc-pos).
 *
 * Uses page.route() to mock all CMC POS API responses so tests run without
 * a live backend. Auth is provided via setupClerkTestingToken (FAPI mock).
 */

const OWNER_EMAIL = "e2e-tester@presentail.com";

const MOCK_SHIFT = {
  id: 1,
  location_id: 42,
  location_name: "CMC Beirut",
  opened_at: new Date().toISOString(),
};

const MOCK_METRICS = {
  sales: {
    paid_count: "5",
    refunded_count: "0",
    voided_count: "0",
    gross_total: "250.00",
    total_discounts: "0.00",
    cash_total: "100.00",
    cash_count: "2",
    cash_refunds_total: "0",
    cash_refunds_count: "0",
    payment_issues: "0",
  },
  requests: {
    draft_count: "0",
    submitted_count: "1",
    accepted_count: "0",
    dispatched_count: "0",
    received_count: "0",
    cancelled_count: "0",
  },
  delivery_orders: { count: "2", revenue: "80.00" },
};

const MOCK_CASH_DRAWER = {
  session: {
    id: 7,
    status: "open",
    currency: "USD",
    secondary_currency: null,
    opening_cash: "50.00",
    opened_at: new Date().toISOString(),
    closed_at: null,
    reconciliation: null,
    location_name: "CMC Beirut",
  },
  currency_summary: [
    {
      currency: "USD",
      opening_cash: 50,
      sales_collected: 100,
      expenses_paid: 0,
      adjustments: 0,
      expected_cash: 150,
    },
  ],
  cash_refunds_total: 0,
  cash_refunds_count: 0,
};

const MOCK_RECENT_ACTIVITY = {
  items: [
    {
      id: "101",
      type: "sale",
      created_at: new Date().toISOString(),
      payment_method: "cash",
      amount: "45.00",
      currency: "USD",
      status: "paid",
      summary: "3 items",
    },
  ],
};

function usersResponse() {
  return {
    members: [
      {
        id: 1,
        email: OWNER_EMAIL,
        role: "owner",
        custom_role_id: null,
        role_name: null,
        joined: true,
        joined_at: new Date().toISOString(),
        invited_at: new Date().toISOString(),
        invited_by_email: null,
        manager_member_id: null,
        manager_email: null,
      },
    ],
    me: {
      role: "owner",
      email: OWNER_EMAIL,
      allowedPages: null,
      customRoleId: null,
    },
  };
}

async function setupCmcPosMocks(page: Page) {
  await setupClerkTestingToken({ page });

  await page.route("**/api/users**", async (route) => {
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(usersResponse()) });
  });
  await page.route("**/api/cmc-pos/shifts/active**", async (route) => {
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ shift: MOCK_SHIFT }) });
  });
  await page.route("**/api/cmc-pos/metrics**", async (route) => {
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(MOCK_METRICS) });
  });
  await page.route("**/api/cmc-pos/cash-drawer**", async (route) => {
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(MOCK_CASH_DRAWER) });
  });
  await page.route("**/api/cmc-pos/recent-activity**", async (route) => {
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(MOCK_RECENT_ACTIVITY) });
  });
  await page.route("**/api/cmc-pos/shelf-products**", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ products: [{ id: 1 }, { id: 2 }] }),
    });
  });
  // Suppress non-critical routes
  await page.route("**/api/notifications**", async (route) => route.fulfill({ status: 200, body: "[]" }));
}

// ── Page structure ────────────────────────────────────────────────────────

test.describe("CMC POS Dashboard — page structure", () => {
  test("shows the page title and subtitle", async ({ page }) => {
    await setupCmcPosMocks(page);
    await page.goto("/cmc-pos", { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading", { name: "CMC POS Dashboard" })).toBeVisible({ timeout: 15_000 });
    await page.waitForLoadState("networkidle");

    await expect(page.getByText("CMC POS Dashboard")).toBeVisible();
    await expect(page.getByText("CMC Beirut Hospital · Point of Sale")).toBeVisible();
  });

  test("shows Store Open badge when shift is active", async ({ page }) => {
    await setupCmcPosMocks(page);
    await page.goto("/cmc-pos", { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading", { name: "CMC POS Dashboard" })).toBeVisible({ timeout: 15_000 });
    await page.waitForLoadState("networkidle");

    const badge = page.getByTestId("badge-store-status");
    await expect(badge).toBeVisible();
    await expect(badge).toContainText("Store Open");
  });

  test("shows Shift Active badge with location name", async ({ page }) => {
    await setupCmcPosMocks(page);
    await page.goto("/cmc-pos", { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading", { name: "CMC POS Dashboard" })).toBeVisible({ timeout: 15_000 });
    await page.waitForLoadState("networkidle");

    const badge = page.getByTestId("badge-shift-status");
    await expect(badge).toBeVisible();
    await expect(badge).toContainText("Shift Active");
  });

  test("View Sales History button is visible", async ({ page }) => {
    await setupCmcPosMocks(page);
    await page.goto("/cmc-pos", { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading", { name: "CMC POS Dashboard" })).toBeVisible({ timeout: 15_000 });
    await page.waitForLoadState("networkidle");

    await expect(page.getByTestId("btn-view-sales-history")).toBeVisible();
  });

  test("KPI card labels are rendered", async ({ page }) => {
    await setupCmcPosMocks(page);
    await page.goto("/cmc-pos", { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading", { name: "CMC POS Dashboard" })).toBeVisible({ timeout: 15_000 });
    await page.waitForLoadState("networkidle");

    await expect(page.getByText("Today's Revenue")).toBeVisible();
    await expect(page.getByText("Orders")).toBeVisible();
    await expect(page.getByText("Cash Sales")).toBeVisible();
    await expect(page.getByText("Pending Requests")).toBeVisible();
  });

  test("shows Store Closed badge when no active shift", async ({ page }) => {
    await setupClerkTestingToken({ page });
    await page.route("**/api/users**", async (route) => {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(usersResponse()) });
    });
    await page.route("**/api/cmc-pos/shifts/active**", async (route) => {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ shift: null }) });
    });
    await page.route("**/api/cmc-pos/metrics**", async (route) => {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(MOCK_METRICS) });
    });
    await page.route("**/api/cmc-pos/cash-drawer**", async (route) => {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ session: null, currency_summary: [], cash_refunds_total: 0, cash_refunds_count: 0 }) });
    });
    await page.route("**/api/cmc-pos/recent-activity**", async (route) => {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ items: [] }) });
    });
    await page.route("**/api/cmc-pos/shelf-products**", async (route) => {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ products: [] }) });
    });
    await page.route("**/api/notifications**", async (route) => route.fulfill({ status: 200, body: "[]" }));

    await page.goto("/cmc-pos", { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading", { name: "CMC POS Dashboard" })).toBeVisible({ timeout: 15_000 });
    await page.waitForLoadState("networkidle");

    await expect(page.getByTestId("badge-store-status")).toContainText("Store Closed");
    await expect(page.getByTestId("badge-shift-status")).toContainText("No Shift");
  });
});

// ── Primary workflow ──────────────────────────────────────────────────────

test.describe("CMC POS Dashboard — primary workflow", () => {
  test("shows Start Shelf Sale CTA (always enabled, no shortcuts)", async ({ page }) => {
    await setupCmcPosMocks(page);
    await page.goto("/cmc-pos", { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading", { name: "CMC POS Dashboard" })).toBeVisible({ timeout: 15_000 });
    await page.waitForLoadState("networkidle");

    await expect(page.getByText("Start a Shelf Sale")).toBeVisible();
    const cta = page.getByTestId("btn-start-shelf-sale");
    await expect(cta).toBeVisible();
    // Shortcut buttons were removed
    await expect(page.getByTestId("btn-scan-barcode")).not.toBeVisible();
    await expect(page.getByTestId("btn-search-products")).not.toBeVisible();
  });

  test("clicking Start Shelf Sale navigates to /cmc-pos/sale", async ({ page }) => {
    await setupCmcPosMocks(page);
    await page.goto("/cmc-pos", { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading", { name: "CMC POS Dashboard" })).toBeVisible({ timeout: 15_000 });
    await page.waitForLoadState("networkidle");

    await page.getByTestId("btn-start-shelf-sale").click();
    await expect(page).toHaveURL(/\/cmc-pos\/sale/, { timeout: 5000 });
  });
});

// ── Secondary workflows ───────────────────────────────────────────────────

test.describe("CMC POS Dashboard — secondary workflows", () => {
  test("Request From Branch card routes to /cmc-pos/request", async ({ page }) => {
    await setupCmcPosMocks(page);
    await page.goto("/cmc-pos", { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading", { name: "CMC POS Dashboard" })).toBeVisible({ timeout: 15_000 });
    await page.waitForLoadState("networkidle");

    await page.getByTestId("btn-create-request").click();
    await expect(page).toHaveURL(/\/cmc-pos\/request/, { timeout: 5000 });
  });

  test("Create Delivery Order card routes to /cmc-pos/new-order", async ({ page }) => {
    await setupCmcPosMocks(page);
    await page.goto("/cmc-pos", { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading", { name: "CMC POS Dashboard" })).toBeVisible({ timeout: 15_000 });
    await page.waitForLoadState("networkidle");

    await page.getByTestId("btn-create-delivery").click();
    await expect(page).toHaveURL(/\/cmc-pos\/new-order/, { timeout: 5000 });
  });
});

// ── Health strip ──────────────────────────────────────────────────────────

test.describe("CMC POS Dashboard — health strip", () => {
  test("health strip is rendered", async ({ page }) => {
    await setupCmcPosMocks(page);
    await page.goto("/cmc-pos", { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading", { name: "CMC POS Dashboard" })).toBeVisible({ timeout: 15_000 });
    await page.waitForLoadState("networkidle");

    await expect(page.getByTestId("health-strip")).toBeVisible();
  });

  test("Open CMC Audit link is present in health strip", async ({ page }) => {
    await setupCmcPosMocks(page);
    await page.goto("/cmc-pos", { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading", { name: "CMC POS Dashboard" })).toBeVisible({ timeout: 15_000 });
    await page.waitForLoadState("networkidle");

    await expect(page.getByTestId("link-open-audit")).toBeVisible();
  });
});

// ── Recent activity ───────────────────────────────────────────────────────

test.describe("CMC POS Dashboard — recent activity", () => {
  test("recent activity section is rendered with View All link", async ({ page }) => {
    await setupCmcPosMocks(page);
    await page.goto("/cmc-pos", { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading", { name: "CMC POS Dashboard" })).toBeVisible({ timeout: 15_000 });
    await page.waitForLoadState("networkidle");

    await expect(page.getByText("Recent Activity")).toBeVisible();
    await expect(page.getByTestId("link-view-all-activity")).toBeVisible();
  });

  test("activity table shows mocked sale row", async ({ page }) => {
    await setupCmcPosMocks(page);
    await page.goto("/cmc-pos", { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading", { name: "CMC POS Dashboard" })).toBeVisible({ timeout: 15_000 });
    await page.waitForLoadState("networkidle");

    await expect(page.getByTestId("recent-activity-table")).toBeVisible();
    await expect(page.getByText("Shelf Sale")).toBeVisible();
    await expect(page.getByText("Completed")).toBeVisible();
  });
});

// ── Cash drawer ───────────────────────────────────────────────────────────

test.describe("CMC POS Dashboard — cash drawer", () => {
  test("cash drawer panel renders with expected balance", async ({ page }) => {
    await setupCmcPosMocks(page);
    await page.goto("/cmc-pos", { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading", { name: "CMC POS Dashboard" })).toBeVisible({ timeout: 15_000 });
    await page.waitForLoadState("networkidle");

    await expect(page.getByText("Current Cash Drawer")).toBeVisible();
    await expect(page.getByText("Expected USD Balance")).toBeVisible();
    await expect(page.getByText("$150.00")).toBeVisible();
  });

  test("Count Cash button links to cash session detail", async ({ page }) => {
    await setupCmcPosMocks(page);
    await page.goto("/cmc-pos", { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading", { name: "CMC POS Dashboard" })).toBeVisible({ timeout: 15_000 });
    await page.waitForLoadState("networkidle");

    const countBtn = page.getByTestId("btn-count-cash");
    await expect(countBtn).toBeVisible();
    await expect(countBtn).toHaveAttribute("href", "/cash-sessions/7");
  });

  test("Reconcile & Close Shift links to close route", async ({ page }) => {
    await setupCmcPosMocks(page);
    await page.goto("/cmc-pos", { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading", { name: "CMC POS Dashboard" })).toBeVisible({ timeout: 15_000 });
    await page.waitForLoadState("networkidle");

    const closeBtn = page.getByTestId("btn-reconcile-close");
    await expect(closeBtn).toBeVisible();
    await expect(closeBtn).toHaveAttribute("href", "/cash-sessions/7/close");
  });

  test("Open Cash Session uses /cash-sessions/new route when no session exists", async ({ page }) => {
    await setupClerkTestingToken({ page });
    await page.route("**/api/users**", async (route) => {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(usersResponse()) });
    });
    await page.route("**/api/cmc-pos/shifts/active**", async (route) => {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ shift: MOCK_SHIFT }) });
    });
    await page.route("**/api/cmc-pos/metrics**", async (route) => {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(MOCK_METRICS) });
    });
    await page.route("**/api/cmc-pos/cash-drawer**", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ session: null, currency_summary: [], cash_refunds_total: 0, cash_refunds_count: 0 }),
      });
    });
    await page.route("**/api/cmc-pos/recent-activity**", async (route) => {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ items: [] }) });
    });
    await page.route("**/api/cmc-pos/shelf-products**", async (route) => {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ products: [] }) });
    });
    await page.route("**/api/notifications**", async (route) => route.fulfill({ status: 200, body: "[]" }));

    await page.goto("/cmc-pos", { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading", { name: "CMC POS Dashboard" })).toBeVisible({ timeout: 15_000 });
    await page.waitForLoadState("networkidle");

    const openBtn = page.getByTestId("btn-open-cash-session");
    await expect(openBtn).toBeVisible();
    await expect(openBtn).toHaveAttribute("href", "/cash-sessions/new");
  });

  test("resolves and closes an overdue dual-currency shift without approval barriers", async ({ page }) => {
    await setupCmcPosMocks(page);
    let shiftClosed = false;
    let submittedBody: Record<string, unknown> | null = null;

    const overdueShift = {
      ...MOCK_SHIFT,
      opened_at: new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString(),
      location_timezone: "UTC",
      location_cutoff_time: "01:00",
      opening_cash: "50.00",
      currency: "USD",
      isOverdue: true,
    };
    const dualDrawer = {
      ...MOCK_CASH_DRAWER,
      session: {
        ...MOCK_CASH_DRAWER.session,
        secondary_currency: "LBP",
      },
      currency_summary: [
        ...MOCK_CASH_DRAWER.currency_summary,
        {
          currency: "LBP",
          opening_cash: 1_000_000,
          sales_collected: 0,
          expenses_paid: 100_000,
          adjustments: 0,
          expected_cash: 900_000,
        },
      ],
    };

    await page.route("**/api/cmc-pos/shifts/active**", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ shift: shiftClosed ? null : overdueShift }),
      });
    });
    await page.route("**/api/cmc-pos/cash-drawer**", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(
          shiftClosed
            ? { session: null, currency_summary: [], cash_refunds_total: 0, cash_refunds_count: 0 }
            : dualDrawer,
        ),
      });
    });
    await page.route("**/api/cmc-pos/shifts/resolve", async (route) => {
      submittedBody = route.request().postDataJSON() as Record<string, unknown>;
      shiftClosed = true;
      await route.fulfill({
        status: 201,
        contentType: "application/json",
        body: JSON.stringify({
          status: "closed",
          resolution: {
            id: 91,
            reason: "other",
            approval_required: false,
          },
        }),
      });
    });

    await page.goto("/cmc-pos", { waitUntil: "domcontentloaded" });
    await expect(page.getByTestId("badge-shift-status")).toContainText("Shift Overdue", { timeout: 15_000 });
    await page.getByTestId("btn-resolve-close-shift").click();

    await expect(page.getByRole("heading", { name: "Resolve & Close Shift" })).toBeVisible();
    await expect(page.getByLabel("Actual counted cash in drawer (LBP)")).toHaveValue("900000.00");
    await expect(page.getByText("Dual-currency cash sessions are not yet supported")).toHaveCount(0);

    await page.getByLabel("Actual counted cash in drawer (USD)").fill("145");
    await page.getByLabel("Actual counted cash in drawer (LBP)").fill("850000");
    await page.getByLabel("Other").click();
    await page.getByRole("button", { name: "Confirm & Close Session" }).click();

    await expect(page.getByRole("heading", { name: "Resolve & Close Shift" })).toHaveCount(0);
    await expect(page.getByTestId("badge-shift-status")).toContainText("No Shift");
    expect(submittedBody).toMatchObject({
      shiftId: overdueShift.id,
      countedBalance: 145,
      countedBalanceSecondary: 850_000,
      currency: "USD",
      reason: "other",
      note: null,
    });
    await expect(page.getByText("Waiting for manager approval")).toHaveCount(0);
    await expect(page.getByText("Resolution submitted — awaiting approval")).toHaveCount(0);
  });
});

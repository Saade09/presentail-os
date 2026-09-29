import { test, expect } from "./fixtures";
import { setupClerkTestingToken } from "@clerk/testing/playwright";

const MANAGER_EMAIL = "e2e-manager@presentail.com";

function managerUsersResponse() {
  return {
    members: [
      {
        id: 2,
        email: MANAGER_EMAIL,
        role: "member",
        custom_role_id: "role_cash",
        role_name: "Cash Manager",
        joined: true,
        joined_at: new Date().toISOString(),
        invited_at: new Date().toISOString(),
        invited_by_email: null,
        manager_member_id: null,
        manager_email: null,
      },
    ],
    me: {
      role: "member",
      email: MANAGER_EMAIL,
      allowedPages: [
        "cash_sessions",
        "cash_sessions.open",
        "cash_sessions.close",
        "cash_sessions.approve",
        "cash_sessions.export",
      ],
      customRoleId: "role_cash",
    },
  };
}

const NOW = new Date();
const ONE_HOUR_AGO = new Date(NOW.getTime() - 60 * 60 * 1000).toISOString();
const TWO_HOURS_AGO = new Date(NOW.getTime() - 2 * 60 * 60 * 1000).toISOString();
const YESTERDAY = new Date(NOW.getTime() - 24 * 60 * 60 * 1000).toISOString();
const THREE_DAYS_AGO = new Date(NOW.getTime() - 3 * 24 * 60 * 60 * 1000).toISOString();

const MOCK_SESSIONS = [
  {
    id: 1,
    session_number: "CS-0001",
    drawer_name: "Main Drawer",
    drawer_code: "MAIN",
    location_name: "Beirut Branch",
    opened_by_clerk_id: null,
    opened_by_name: "Alice Manager",
    closed_by_name: null,
    approved_by_name: null,
    currency: "USD",
    secondary_currency: null,
    status: "open",
    opening_cash: "500.00",
    opening_cash_secondary: null,
    expected_cash: "750.00",
    expected_cash_secondary: null,
    actual_cash: null,
    actual_cash_secondary: null,
    difference: null,
    difference_secondary: null,
    opened_at: ONE_HOUR_AGO,
    closed_at: null,
  },
  {
    id: 2,
    session_number: "CS-0002",
    drawer_name: "Cafe Drawer",
    drawer_code: "CAFE",
    location_name: "Cafe Branch",
    opened_by_clerk_id: null,
    opened_by_name: "Bob Cashier",
    closed_by_name: null,
    approved_by_name: null,
    currency: "USD",
    secondary_currency: null,
    status: "open",
    opening_cash: "300.00",
    opening_cash_secondary: null,
    expected_cash: "420.00",
    expected_cash_secondary: null,
    actual_cash: null,
    actual_cash_secondary: null,
    difference: null,
    difference_secondary: null,
    opened_at: TWO_HOURS_AGO,
    closed_at: null,
  },
  {
    id: 3,
    session_number: "CS-0003",
    drawer_name: "Main Drawer",
    drawer_code: "MAIN",
    location_name: "Beirut Branch",
    opened_by_clerk_id: null,
    opened_by_name: "Alice Manager",
    closed_by_name: "Alice Manager",
    approved_by_name: null,
    currency: "USD",
    secondary_currency: null,
    status: "pending_review",
    opening_cash: "400.00",
    opening_cash_secondary: null,
    expected_cash: "650.00",
    expected_cash_secondary: null,
    actual_cash: "640.00",
    actual_cash_secondary: null,
    difference: "-10.00",
    difference_secondary: null,
    opened_at: YESTERDAY,
    closed_at: YESTERDAY,
  },
  {
    id: 4,
    session_number: "CS-0004",
    drawer_name: "Cafe Drawer",
    drawer_code: "CAFE",
    location_name: "Cafe Branch",
    opened_by_clerk_id: null,
    opened_by_name: "Bob Cashier",
    closed_by_name: "Bob Cashier",
    approved_by_name: null,
    currency: "USD",
    secondary_currency: null,
    status: "flagged",
    opening_cash: "200.00",
    opening_cash_secondary: null,
    expected_cash: "350.00",
    expected_cash_secondary: null,
    actual_cash: "280.00",
    actual_cash_secondary: null,
    difference: "-70.00",
    difference_secondary: null,
    opened_at: THREE_DAYS_AGO,
    closed_at: THREE_DAYS_AGO,
  },
  {
    id: 5,
    session_number: "CS-0005",
    drawer_name: "Main Drawer",
    drawer_code: "MAIN",
    location_name: "Beirut Branch",
    opened_by_clerk_id: null,
    opened_by_name: "Alice Manager",
    closed_by_name: "Alice Manager",
    approved_by_name: "Owner User",
    currency: "USD",
    secondary_currency: null,
    status: "approved",
    opening_cash: "500.00",
    opening_cash_secondary: null,
    expected_cash: "820.00",
    expected_cash_secondary: null,
    actual_cash: "820.00",
    actual_cash_secondary: null,
    difference: "0.00",
    difference_secondary: null,
    opened_at: THREE_DAYS_AGO,
    closed_at: THREE_DAYS_AGO,
  },
];

async function setupCommonRoutes(page: import("@playwright/test").Page, sessions = MOCK_SESSIONS) {
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

  await page.route("**/api/cash-sessions**", async (route) => {
    if (route.request().method() === "GET") {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ sessions }),
      });
      return;
    }
    await route.continue();
  });
}

test.describe("Cash Sessions dashboard — manager view", () => {
  test("page heading, subtitle, and Start Session button are visible", async ({ page }) => {
    await setupClerkTestingToken({ page });
    await setupCommonRoutes(page);

    await page.goto("/cash-sessions", { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading", { level: 1 })).toContainText("Cash Sessions", { timeout: 15_000 });

    await expect(page.getByRole("button", { name: /Start Session/i })).toBeVisible({ timeout: 10_000 });
  });

  test("four KPI cards render with correct counts", async ({ page }) => {
    await setupClerkTestingToken({ page });
    await setupCommonRoutes(page);

    await page.goto("/cash-sessions", { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading", { level: 1 })).toContainText("Cash Sessions", { timeout: 15_000 });

    const kpiCards = page.getByRole("button", { name: /Open Sessions|Pending Review|Flagged|Total Difference/i });
    await expect(kpiCards.first()).toBeVisible({ timeout: 10_000 });

    const openCard = page.getByRole("button").filter({ hasText: /Open Sessions/i });
    await expect(openCard).toBeVisible();
    await expect(openCard).toContainText("2");

    const pendingCard = page.getByRole("button").filter({ hasText: /Pending Review/i });
    await expect(pendingCard).toBeVisible();
    await expect(pendingCard).toContainText("1");

    const flaggedCard = page.getByRole("button").filter({ hasText: /Flagged/i });
    await expect(flaggedCard).toBeVisible();
    await expect(flaggedCard).toContainText("1");
  });

  test("clicking a KPI card filters the table and syncs the URL", async ({ page }) => {
    await setupClerkTestingToken({ page });
    await setupCommonRoutes(page);

    await page.goto("/cash-sessions", { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading", { level: 1 })).toContainText("Cash Sessions", { timeout: 15_000 });

    const openCard = page.getByRole("button").filter({ hasText: /Open Sessions/i });
    await expect(openCard).toBeVisible({ timeout: 10_000 });

    await openCard.click();

    await expect(page).toHaveURL(/status=open/, { timeout: 5_000 });

    await expect(page.getByText("CS-0001")).toBeVisible();
    await expect(page.getByText("CS-0002")).toBeVisible();
    await expect(page.getByText("CS-0003")).not.toBeVisible();
    await expect(page.getByText("CS-0004")).not.toBeVisible();
    await expect(page.getByText("CS-0005")).not.toBeVisible();

    await openCard.click();
    await expect(page).not.toHaveURL(/status=open/, { timeout: 5_000 });
    await expect(page.getByText("CS-0004")).toBeVisible();
  });

  test("clicking the Pending Review KPI card filters to pending_review sessions", async ({ page }) => {
    await setupClerkTestingToken({ page });
    await setupCommonRoutes(page);

    await page.goto("/cash-sessions", { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading", { level: 1 })).toContainText("Cash Sessions", { timeout: 15_000 });

    const pendingCard = page.getByRole("button").filter({ hasText: /Pending Review/i });
    await expect(pendingCard).toBeVisible({ timeout: 10_000 });
    await pendingCard.click();

    await expect(page).toHaveURL(/status=pending_review/, { timeout: 5_000 });
    await expect(page.getByText("CS-0003")).toBeVisible();
    await expect(page.getByText("CS-0001")).not.toBeVisible();
  });

  test("all 5 sessions appear in the table by default", async ({ page }) => {
    await setupClerkTestingToken({ page });
    await setupCommonRoutes(page);

    await page.goto("/cash-sessions", { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading", { level: 1 })).toContainText("Cash Sessions", { timeout: 15_000 });

    await expect(page.getByText("CS-0001")).toBeVisible({ timeout: 10_000 });
    await expect(page.getByText("CS-0002")).toBeVisible();
    await expect(page.getByText("CS-0003")).toBeVisible();
    await expect(page.getByText("CS-0004")).toBeVisible();
    await expect(page.getByText("CS-0005")).toBeVisible();

    await expect(page.getByText("5 sessions")).toBeVisible();
  });

  test("status filter select filters the table and syncs the URL", async ({ page }) => {
    await setupClerkTestingToken({ page });
    await setupCommonRoutes(page);

    await page.goto("/cash-sessions", { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading", { level: 1 })).toContainText("Cash Sessions", { timeout: 15_000 });
    await expect(page.getByText("CS-0001")).toBeVisible({ timeout: 10_000 });

    const statusSelect = page.getByRole("combobox").filter({ hasText: /All Statuses|Open|Pending/i }).first();
    await statusSelect.click();
    await page.getByRole("option", { name: /^Open$/i }).click();

    await expect(page).toHaveURL(/status=open/, { timeout: 5_000 });
    await expect(page.getByText("CS-0001")).toBeVisible();
    await expect(page.getByText("CS-0003")).not.toBeVisible();

    const clearBtn = page.getByRole("button", { name: /Clear/i });
    await expect(clearBtn).toBeVisible();
    await clearBtn.click();

    await expect(page).not.toHaveURL(/status=open/, { timeout: 5_000 });
    await expect(page.getByText("CS-0003")).toBeVisible();
  });

  test("table sorting by Status column toggles sort direction", async ({ page }) => {
    await setupClerkTestingToken({ page });
    await setupCommonRoutes(page);

    await page.goto("/cash-sessions", { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading", { level: 1 })).toContainText("Cash Sessions", { timeout: 15_000 });
    await expect(page.getByText("CS-0001")).toBeVisible({ timeout: 10_000 });

    const statusSortBtn = page.getByRole("columnheader").filter({ hasText: /Status/i }).getByRole("button");
    await statusSortBtn.click();
    await expect(page).toHaveURL(/sort=status/, { timeout: 5_000 });

    await statusSortBtn.click();
    await expect(page).toHaveURL(/dir=asc/, { timeout: 5_000 });
  });

  test("table sorting by Difference column syncs the URL", async ({ page }) => {
    await setupClerkTestingToken({ page });
    await setupCommonRoutes(page);

    await page.goto("/cash-sessions", { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading", { level: 1 })).toContainText("Cash Sessions", { timeout: 15_000 });
    await expect(page.getByText("CS-0001")).toBeVisible({ timeout: 10_000 });

    const diffSortBtn = page.getByRole("columnheader").filter({ hasText: /Difference/i }).getByRole("button");
    await diffSortBtn.click();
    await expect(page).toHaveURL(/sort=difference/, { timeout: 5_000 });
  });

  test("search box filters table by session number", async ({ page }) => {
    await setupClerkTestingToken({ page });
    await setupCommonRoutes(page);

    await page.goto("/cash-sessions", { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading", { level: 1 })).toContainText("Cash Sessions", { timeout: 15_000 });
    await expect(page.getByText("CS-0001")).toBeVisible({ timeout: 10_000 });

    const searchInput = page.getByPlaceholder(/Search/i);
    await searchInput.fill("CS-0004");

    await expect(page.getByText("CS-0004")).toBeVisible({ timeout: 5_000 });
    await expect(page.getByText("CS-0001")).not.toBeVisible();
    await expect(page.getByText("CS-0002")).not.toBeVisible();

    await searchInput.clear();
    await expect(page.getByText("CS-0001")).toBeVisible({ timeout: 5_000 });
  });

  test("Needs Attention section shows flagged and pending_review sessions", async ({ page }) => {
    await setupClerkTestingToken({ page });
    await setupCommonRoutes(page);

    await page.goto("/cash-sessions", { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading", { level: 1 })).toContainText("Cash Sessions", { timeout: 15_000 });

    await expect(page.getByText(/Needs Attention/i)).toBeVisible({ timeout: 10_000 });
    await expect(page.getByText(/Flagged/i).first()).toBeVisible();

    await expect(page.getByText(/Shortage/i).first()).toBeVisible();
  });

  test("Cash Held by Currency card shows open session totals", async ({ page }) => {
    await setupClerkTestingToken({ page });
    await setupCommonRoutes(page);

    await page.goto("/cash-sessions", { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading", { level: 1 })).toContainText("Cash Sessions", { timeout: 15_000 });

    await expect(page.getByText(/Cash Held by Currency/i)).toBeVisible({ timeout: 10_000 });

    await expect(page.getByText("USD").first()).toBeVisible();

    await expect(page.getByText(/2 open drawer/i)).toBeVisible();
  });

  test("empty state renders when no sessions exist", async ({ page }) => {
    await setupClerkTestingToken({ page });
    await setupCommonRoutes(page, []);

    await page.goto("/cash-sessions", { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading", { level: 1 })).toContainText("Cash Sessions", { timeout: 15_000 });

    await expect(page.getByText(/No sessions/i)).toBeVisible({ timeout: 10_000 });

    const kpiCards = page.locator('[role="button"][aria-pressed]');
    await expect(kpiCards.first()).toBeVisible();
    const firstCard = kpiCards.first();
    await expect(firstCard).toContainText("0");
  });

  test("Export CSV button is visible for a manager with export permission", async ({ page }) => {
    await setupClerkTestingToken({ page });
    await setupCommonRoutes(page);

    await page.goto("/cash-sessions", { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading", { level: 1 })).toContainText("Cash Sessions", { timeout: 15_000 });

    await expect(page.getByRole("button", { name: /Export CSV/i })).toBeVisible({ timeout: 10_000 });
  });

  test("table row click navigates to the session detail page", async ({ page }) => {
    await setupClerkTestingToken({ page });
    await setupCommonRoutes(page);

    await page.goto("/cash-sessions", { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading", { level: 1 })).toContainText("Cash Sessions", { timeout: 15_000 });

    const sessionRow = page.locator("table tbody tr").first();
    await expect(sessionRow).toBeVisible({ timeout: 10_000 });
    await sessionRow.click();

    await expect(page).toHaveURL(/\/cash-sessions\/\d+/, { timeout: 5_000 });
  });

  test("status pills render with correct labels for each status type", async ({ page }) => {
    await setupClerkTestingToken({ page });
    await setupCommonRoutes(page);

    await page.goto("/cash-sessions", { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading", { level: 1 })).toContainText("Cash Sessions", { timeout: 15_000 });
    await expect(page.getByText("CS-0001")).toBeVisible({ timeout: 10_000 });

    const pills = page.locator("table tbody span.rounded-full");
    await expect(pills.filter({ hasText: /Open/i })).toHaveCount(2);
    await expect(pills.filter({ hasText: /Pending Review/i })).toHaveCount(1);
    await expect(pills.filter({ hasText: /Flagged/i })).toHaveCount(1);
    await expect(pills.filter({ hasText: /Approved/i })).toHaveCount(1);
  });
});

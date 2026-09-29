import { test, expect } from "./fixtures";
import { setupFapiWithFakeSession } from "./clerk-fapi-redirect";

const OWNER_EMAIL = "e2e-tester@presentail.com";

// Override the _fapiMock auto-fixture with setupFapiWithFakeSession for this
// spec.  All API routes are mocked via page.route, so the backend never
// validates the JWT — a fully static fake Clerk session is sufficient.
test.use({
  _fapiMock: [
    async ({ page }, use) => {
      await setupFapiWithFakeSession(page);
      await use();
    },
    { auto: true },
  ],
});

function ownerUsersResponse() {
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

const MOCK_ACTIVE_SUPPLIER = {
  id: 1,
  workspace_owner_id: "user_owner",
  name: "Alpha Supplies LLC",
  display_name: "Alpha Supplies",
  contact_name: null,
  contact_email: null,
  contact_phone: null,
  country: "United Arab Emirates",
  tax_number: null,
  supplier_code: null,
  payment_terms: null,
  currency_pref: null,
  lead_time_days: null,
  min_order_value: null,
  notes: null,
  is_archived: false,
  item_count: 2,
  invoice_count: 0,
  spend_ytd: "0",
  spend_ytd_currency: null,
  created_at: new Date().toISOString(),
  updated_at: null,
  created_by_clerk_id: null,
  updated_by_clerk_id: null,
};

const MOCK_ARCHIVED_SUPPLIER = {
  id: 2,
  workspace_owner_id: "user_owner",
  name: "Beta Goods Co",
  display_name: null,
  contact_name: null,
  contact_email: null,
  contact_phone: null,
  country: "Lebanon",
  tax_number: null,
  supplier_code: null,
  payment_terms: null,
  currency_pref: null,
  lead_time_days: null,
  min_order_value: null,
  notes: null,
  is_archived: true,
  item_count: 0,
  invoice_count: 0,
  spend_ytd: "0",
  spend_ytd_currency: null,
  created_at: new Date().toISOString(),
  updated_at: null,
  created_by_clerk_id: null,
  updated_by_clerk_id: null,
};

async function setupRoutes(page: import("@playwright/test").Page) {
  await page.route("**/api/**", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({}),
    }),
  );

  await page.route("**/api/users/failed-access-requests**", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ failedRequests: [] }),
    }),
  );

  await page.route("**/api/access-requests**", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ requests: [] }),
    }),
  );

  await page.route("**/api/users**", async (route) => {
    if (route.request().method() === "GET") {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(ownerUsersResponse()),
      });
      return;
    }
    await route.continue();
  });

  await page.route("**/api/suppliers**", async (route) => {
    const url = route.request().url();
    const isListEndpoint = /\/api\/suppliers(\?.*)?$/.test(url);
    if (route.request().method() === "GET" && isListEndpoint) {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          suppliers: [MOCK_ACTIVE_SUPPLIER, MOCK_ARCHIVED_SUPPLIER],
        }),
      });
      return;
    }
    await route.continue();
  });
}

async function gotoSuppliers(page: import("@playwright/test").Page) {
  await page.goto("/suppliers", { waitUntil: "domcontentloaded" });
  await expect(
    page.getByRole("heading", { name: "Suppliers", level: 1 }),
  ).toBeVisible({ timeout: 15_000 });
}

test.describe("Suppliers — filter and sort persistence across navigation", () => {
  test.beforeEach(async ({ page }) => {
    await setupRoutes(page);
    // Clear any leftover localStorage state from a previous test run
    await page.goto("/suppliers", { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading", { name: "Suppliers" })).toBeVisible({ timeout: 15_000 });
    await page.evaluate(() => {
      localStorage.removeItem("suppliers_sort_field");
      localStorage.removeItem("suppliers_sort_dir");
      localStorage.removeItem("suppliers_status_filter");
      localStorage.removeItem("suppliers_country_filter");
      localStorage.removeItem("suppliers_has_linked_items");
      localStorage.removeItem("suppliers_has_invoices");
    });
  });

  test("status filter and sort are restored after navigating away and back", async ({
    page,
  }) => {
    await gotoSuppliers(page);

    // Step 1: Switch status filter to "Archived"
    const archivedTab = page.getByRole("button", { name: "Archived", exact: true });
    await expect(archivedTab).toBeVisible({ timeout: 10_000 });
    await archivedTab.click();

    // Verify the "Archived" tab is now active (has primary background class)
    await expect(archivedTab).toHaveClass(/bg-primary/, { timeout: 5_000 });

    // Step 2: Sort by Country (first click activates ascending sort)
    const countryHeader = page.getByRole("button", { name: /^Country/ }).first();
    await expect(countryHeader).toBeVisible({ timeout: 5_000 });
    await countryHeader.click();

    // After clicking, Country sort becomes active — the sort button gains text-foreground
    await expect(countryHeader).toHaveClass(/text-foreground/, { timeout: 5_000 });

    // "Reset filters" button should now be visible (non-default state)
    await expect(
      page.getByRole("button", { name: "Reset filters" }),
    ).toBeVisible({ timeout: 5_000 });

    // Step 3: Navigate away to the home/dashboard page
    await page.goto("/", { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading", { level: 1, name: /Your entire operation,\s*under control/i })).toBeVisible({ timeout: 15_000 });

    // Step 4: Navigate back to /suppliers
    await gotoSuppliers(page);

    // Step 5: Assert the "Archived" tab is still active (state was restored from localStorage)
    const archivedTabRestored = page.getByRole("button", {
      name: "Archived",
      exact: true,
    });
    await expect(archivedTabRestored).toBeVisible({ timeout: 10_000 });
    await expect(archivedTabRestored).toHaveClass(/bg-primary/, {
      timeout: 5_000,
    });

    // Step 6: Assert the sort field was restored (Country sort is active)
    const sortField = await page.evaluate(() =>
      localStorage.getItem("suppliers_sort_field"),
    );
    expect(sortField).toBe("country");

    const countryHeaderRestored = page
      .getByRole("button", { name: /^Country/ })
      .first();
    await expect(countryHeaderRestored).toBeVisible({ timeout: 5_000 });
    await expect(countryHeaderRestored).toHaveClass(/text-foreground/, {
      timeout: 5_000,
    });

    // "Reset filters" button must still be visible after returning
    await expect(
      page.getByRole("button", { name: "Reset filters" }),
    ).toBeVisible({ timeout: 5_000 });
  });

  test("Reset filters clears state and hides the reset button", async ({
    page,
  }) => {
    await gotoSuppliers(page);

    // Set up a non-default state: switch to "Archived" and sort by Country
    const archivedTab = page.getByRole("button", { name: "Archived", exact: true });
    await expect(archivedTab).toBeVisible({ timeout: 10_000 });
    await archivedTab.click();
    await expect(archivedTab).toHaveClass(/bg-primary/, { timeout: 5_000 });

    const countryHeader = page.getByRole("button", { name: /^Country/ }).first();
    await countryHeader.click();
    await expect(countryHeader).toHaveClass(/text-foreground/, {
      timeout: 5_000,
    });

    // "Reset filters" button should be visible in this non-default state
    const resetBtn = page.getByRole("button", { name: "Reset filters" });
    await expect(resetBtn).toBeVisible({ timeout: 5_000 });

    // Click "Reset filters"
    await resetBtn.click();

    // The "Active" tab should now be selected again (default state)
    const activeTab = page.getByRole("button", { name: "Active", exact: true });
    await expect(activeTab).toHaveClass(/bg-primary/, { timeout: 5_000 });

    // The "Archived" tab should no longer be active
    await expect(archivedTab).not.toHaveClass(/bg-primary/, {
      timeout: 5_000,
    });

    // The Country sort header should no longer show as active
    await expect(countryHeader).not.toHaveClass(/text-foreground/, {
      timeout: 5_000,
    });

    // "Reset filters" button must disappear once state is back to defaults
    await expect(resetBtn).not.toBeVisible({ timeout: 5_000 });

    // Verify localStorage was cleared
    const sortFieldAfterReset = await page.evaluate(() =>
      localStorage.getItem("suppliers_sort_field"),
    );
    expect(sortFieldAfterReset).toBeNull();

    const statusFilterAfterReset = await page.evaluate(() =>
      localStorage.getItem("suppliers_status_filter"),
    );
    expect(statusFilterAfterReset).toBeNull();
  });
});

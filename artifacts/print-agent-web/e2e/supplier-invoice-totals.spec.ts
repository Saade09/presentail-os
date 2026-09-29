import { test, expect } from "./fixtures";
import { setupClerkTestingToken } from "@clerk/testing/playwright";
import { setupFapiWithFakeSession } from "./clerk-fapi-redirect";

const OWNER_EMAIL = "e2e-tester@presentail.com";

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

const SUPPLIER_WITH_INVOICES = {
  id: 1,
  workspace_owner_id: "user_owner",
  name: "Alpha Supplies LLC",
  display_name: "Alpha Supplies",
  contact_name: "Jane Doe",
  contact_email: "jane@alphasupplies.com",
  contact_phone: null,
  country: "United Arab Emirates",
  tax_number: "100123456789003",
  supplier_code: null,
  payment_terms: null,
  currency_pref: "AED",
  lead_time_days: null,
  min_order_value: null,
  notes: null,
  is_archived: false,
  item_count: 3,
  invoice_count: 5,
  spend_ytd: "12500.00",
  spend_ytd_currency: "AED",
  paid_count: 3,
  outstanding_count: 2,
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
  created_by_clerk_id: null,
  updated_by_clerk_id: null,
};

const SUPPLIER_NO_INVOICES = {
  id: 2,
  workspace_owner_id: "user_owner",
  name: "Beta Goods Co",
  display_name: null,
  contact_name: null,
  contact_email: null,
  contact_phone: null,
  country: null,
  tax_number: null,
  supplier_code: null,
  payment_terms: null,
  currency_pref: null,
  lead_time_days: null,
  min_order_value: null,
  notes: null,
  is_archived: false,
  item_count: 0,
  invoice_count: 0,
  spend_ytd: "0",
  spend_ytd_currency: null,
  paid_count: 0,
  outstanding_count: 0,
  created_at: new Date().toISOString(),
  updated_at: null,
  created_by_clerk_id: null,
  updated_by_clerk_id: null,
};

async function setupRoutes(page: import("@playwright/test").Page) {
  await page.route("**/api/users/failed-access-requests**", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ failedRequests: [] }),
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

  await page.route("**/api/access-requests**", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ requests: [] }),
    }),
  );

  await page.route("**/api/suppliers**", async (route) => {
    const url = route.request().url();
    const isListEndpoint = /\/api\/suppliers(\?.*)?$/.test(url);
    if (route.request().method() === "GET" && isListEndpoint) {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          suppliers: [SUPPLIER_WITH_INVOICES, SUPPLIER_NO_INVOICES],
        }),
      });
      return;
    }
    await route.continue();
  });

  await page.route(`**/api/suppliers/1`, async (route) => {
    if (route.request().method() === "GET") {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ supplier: SUPPLIER_WITH_INVOICES }),
      });
      return;
    }
    await route.continue();
  });

  await page.route(`**/api/suppliers/1/items**`, (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ items: [] }),
    }),
  );

  await page.route(`**/api/suppliers/1/documents**`, (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ documents: [] }),
    }),
  );
}

test.describe("Supplier detail — KPI breakdown", () => {
  test.use({
    _fapiMock: [
      async ({ page }, use) => {
        await setupFapiWithFakeSession(page);
        await use();
      },
      { auto: true },
    ],
  });

  test("shows paid / outstanding breakdown in the KPI cards for a supplier with invoices", async ({
    page,
  }) => {
    await setupRoutes(page);

    await page.goto("/suppliers/1", { waitUntil: "domcontentloaded" });

    await expect(page.getByRole("heading", { name: "Alpha Supplies" })).toBeVisible({
      timeout: 12_000,
    });

    // The "Paid / Outstanding" KPI card must show the breakdown
    await expect(page.getByText(/3\s+paid\s*\/\s*2\s+outstanding/i)).toBeVisible();
  });

  test("shows a dash for Paid / Outstanding when no invoices exist", async ({ page }) => {
    await setupRoutes(page);

    await page.goto("/suppliers/1", { waitUntil: "domcontentloaded" });

    await expect(page.getByRole("heading", { name: "Alpha Supplies" })).toBeVisible({
      timeout: 12_000,
    });

    // Override the detail route to return a no-invoice supplier
    await page.route("**/api/suppliers/2", async (route) => {
      if (route.request().method() === "GET") {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            supplier: {
              ...SUPPLIER_NO_INVOICES,
              supplier_id_label: "SUP-0002",
            },
          }),
        });
        return;
      }
      await route.continue();
    });

    // Revisit to trigger the new mock
    await page.goto("/suppliers/2", { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading", { name: "Beta Goods Co" })).toBeVisible({
      timeout: 12_000,
    });

    // The KPI card should show "—" for Paid / Outstanding
    const kpiCard = page.locator("div").filter({ hasText: /^Paid \/ Outstanding—$/ }).first();
    await expect(kpiCard).toBeVisible();
  });
});

test.describe("Supplier list — Invoices column", () => {
  test.use({ skipFapiMock: true });
  test("shows invoice count and non-zero YTD spend for a supplier with invoices", async ({
    page,
  }) => {
    await setupClerkTestingToken({ page });
    await setupRoutes(page);

    await page.goto("/suppliers", { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading", { name: "Suppliers" })).toBeVisible({ timeout: 15_000 });

    // Wait for the table to render
    await expect(page.getByText("Alpha Supplies")).toBeVisible({
      timeout: 12_000,
    });

    // Find the row for the supplier with invoices
    const supplierRow = page.getByRole("row", { name: /Alpha Supplies/i });
    await expect(supplierRow).toBeVisible();

    // Invoice count (5) must appear in the Invoices column cell
    await expect(supplierRow.getByText("5")).toBeVisible();

    // YTD spend must appear as "AED 12,500.00 YTD" (locale-formatted)
    await expect(supplierRow.getByText(/12[,.]?500\.00\s*YTD/i)).toBeVisible();
  });

  test("shows paid / outstanding breakdown for a supplier with invoices", async ({ page }) => {
    await setupClerkTestingToken({ page });
    await setupRoutes(page);

    await page.goto("/suppliers", { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading", { name: "Suppliers" })).toBeVisible({ timeout: 15_000 });

    await expect(page.getByText("Alpha Supplies")).toBeVisible({ timeout: 12_000 });

    const supplierRow = page.getByRole("row", { name: /Alpha Supplies/i });
    await expect(supplierRow).toBeVisible();

    // The breakdown "3 paid / 2 outstanding" must appear in the Invoices column cell
    await expect(supplierRow.getByText(/3\s+paid\s*\/\s*2\s+outstanding/i)).toBeVisible();
  });

  test("shows a dash for a supplier with zero invoices", async ({ page }) => {
    await setupClerkTestingToken({ page });
    await setupRoutes(page);

    await page.goto("/suppliers", { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading", { name: "Suppliers" })).toBeVisible({ timeout: 15_000 });

    // Wait for both rows
    await expect(page.getByText("Alpha Supplies")).toBeVisible({
      timeout: 12_000,
    });
    await expect(page.getByText("Beta Goods Co")).toBeVisible();

    // The zero-invoice supplier's Invoices cell should show "—"
    const betaRow = page.getByRole("row", { name: /Beta Goods Co/i });
    await expect(betaRow).toBeVisible();
    // The Invoices column for zero invoices renders a single "—" span.
    // We scope the lookup to the row to avoid collisions with other dash cells.
    await expect(betaRow.locator("td").filter({ hasText: /^—$/ }).first()).toBeVisible();
  });

  test("Invoices column header is visible in the table", async ({ page }) => {
    await setupClerkTestingToken({ page });
    await setupRoutes(page);

    await page.goto("/suppliers", { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading", { name: "Suppliers" })).toBeVisible({ timeout: 15_000 });

    await expect(page.getByText("Alpha Supplies")).toBeVisible({
      timeout: 12_000,
    });

    // The Invoices column header button should be present
    await expect(
      page.getByRole("button", { name: /^Invoices$/i }),
    ).toBeVisible();
  });

  test("spend_ytd_currency label prefixes the YTD amount", async ({ page }) => {
    await setupClerkTestingToken({ page });
    await setupRoutes(page);

    await page.goto("/suppliers", { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading", { name: "Suppliers" })).toBeVisible({ timeout: 15_000 });

    await expect(page.getByText("Alpha Supplies")).toBeVisible({
      timeout: 12_000,
    });

    // The currency prefix "AED" must appear together with the spend line
    const supplierRow = page.getByRole("row", { name: /Alpha Supplies/i });
    await expect(supplierRow.getByText(/AED/)).toBeVisible();
  });
});

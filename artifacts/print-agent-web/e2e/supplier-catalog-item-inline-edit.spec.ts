import { test, expect } from "./fixtures";
import { setupFapiWithFakeSession } from "./clerk-fapi-redirect";

test.use({
  _fapiMock: [
    async ({ page }, use) => {
      await setupFapiWithFakeSession(page);
      await use();
    },
    { auto: true },
  ],
});

const OWNER_EMAIL = "e2e-tester@presentail.com";
const SUPPLIER_ID = 1;
const CATALOG_ITEM_ID = 10;

const BASE_SUPPLIER = {
  id: SUPPLIER_ID,
  workspace_owner_id: "user_owner",
  name: "Alpha Supplies LLC",
  display_name: "Alpha Supplies",
  contact_name: "Jane Doe",
  contact_email: "jane@alphasupplies.com",
  contact_phone: null,
  country: "United Arab Emirates",
  tax_number: null,
  supplier_code: null,
  payment_terms: null,
  currency_pref: "AED",
  lead_time_days: null,
  min_order_value: null,
  notes: null,
  is_archived: false,
  item_count: 0,
  invoice_count: 0,
  spend_ytd: "0.00",
  spend_ytd_currency: "AED",
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
  created_by_clerk_id: null,
  updated_by_clerk_id: null,
};

function makeCatalogItem(overrides: Partial<typeof BASE_CATALOG_ITEM> = {}) {
  return { ...BASE_CATALOG_ITEM, ...overrides };
}

const BASE_CATALOG_ITEM = {
  id: CATALOG_ITEM_ID,
  supplier_id: SUPPLIER_ID,
  workspace_owner_id: "user_owner",
  name: "Paper A4",
  supplier_item_code: "PA4-001",
  category: "Paper",
  price: "25.00",
  currency: "AED",
  unit: "ream",
  current_stock: "5",
  par_level: "10",
  is_active: true,
  base_item_id: null,
  base_item_name: null,
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
};

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

test.describe("Supplier catalog items — inline stock editing", () => {
  test("clicking a stock cell, entering a new value, and pressing Enter fires PATCH and updates the cell", async ({
    page,
  }) => {
    let patchedBody: Record<string, unknown> | null = null;
    let currentItem = makeCatalogItem({ current_stock: "5", par_level: "10" });

    // Catch-all (registered first so specific routes below take priority)
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

    await page.route(/\/api\/suppliers\/1(\?.*)?$/, async (route) => {
      if (route.request().method() === "GET") {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ supplier: BASE_SUPPLIER }),
        });
        return;
      }
      await route.continue();
    });

    await page.route(/\/api\/suppliers(\?.*)?$/, async (route) => {
      if (route.request().method() === "GET") {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ suppliers: [BASE_SUPPLIER] }),
        });
        return;
      }
      await route.continue();
    });

    // PATCH catalog item — capture body and update in-memory state
    await page.route(
      new RegExp(`/api/suppliers/${SUPPLIER_ID}/catalog-items/${CATALOG_ITEM_ID}(\\?.*)?$`),
      async (route) => {
        if (route.request().method() === "PATCH") {
          patchedBody = JSON.parse(route.request().postData() ?? "{}") as Record<string, unknown>;
          currentItem = { ...currentItem, ...patchedBody };
          await route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify({ catalog_item: currentItem }),
          });
          return;
        }
        await route.continue();
      },
    );

    // Catalog items list — returns current in-memory state so re-fetches reflect the update
    await page.route(
      new RegExp(`/api/suppliers/${SUPPLIER_ID}/catalog-items(\\?.*)?$`),
      async (route) => {
        if (route.request().method() === "GET") {
          await route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify({ catalog_items: [currentItem] }),
          });
          return;
        }
        await route.continue();
      },
    );

    await page.goto(`/suppliers/${SUPPLIER_ID}`, { waitUntil: "domcontentloaded" });

    await expect(page.getByRole("heading", { name: "Alpha Supplies" })).toBeVisible({
      timeout: 15_000,
    });

    // Open the Catalog Items tab
    await page.getByRole("button", { name: "Catalog Items" }).click();

    // The item row should appear
    await expect(page.getByText("Paper A4")).toBeVisible({ timeout: 8_000 });

    // Stock (5) < par (10): the reorder badge should be visible before editing
    await expect(page.getByLabel("Stock below par level — reorder needed")).toBeVisible();

    // Click the stock button to enter inline edit mode
    await page.getByTitle("Click to edit stock").click();

    // A number input should appear pre-filled with the current stock value
    const inlineInput = page.locator('input[type="number"]');
    await expect(inlineInput).toBeVisible({ timeout: 3_000 });
    await expect(inlineInput).toHaveValue("5");

    // Enter a new stock value that exceeds par (10) so the reorder badge disappears
    await inlineInput.fill("15");
    await inlineInput.press("Enter");

    // The inline input should close
    await expect(inlineInput).not.toBeVisible({ timeout: 5_000 });

    // The PATCH should have been fired with the new stock value
    expect(patchedBody).not.toBeNull();
    expect(patchedBody).toMatchObject({ current_stock: "15" });

    // The stock button should be visible again showing the updated value
    await expect(page.getByTitle("Click to edit stock")).toBeVisible({ timeout: 5_000 });

    // Stock (15) >= par (10): the reorder badge should be gone
    await expect(page.getByLabel("Stock below par level — reorder needed")).not.toBeVisible();
  });
});

test.describe("Supplier catalog items — inline par level editing", () => {
  test("clicking a par cell, entering a new value, and blurring fires PATCH and updates the reorder badge", async ({
    page,
  }) => {
    let patchedBody: Record<string, unknown> | null = null;
    // Stock well above par initially — no reorder badge
    let currentItem = makeCatalogItem({ current_stock: "20", par_level: "10" });

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

    await page.route(/\/api\/suppliers\/1(\?.*)?$/, async (route) => {
      if (route.request().method() === "GET") {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ supplier: BASE_SUPPLIER }),
        });
        return;
      }
      await route.continue();
    });

    await page.route(/\/api\/suppliers(\?.*)?$/, async (route) => {
      if (route.request().method() === "GET") {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ suppliers: [BASE_SUPPLIER] }),
        });
        return;
      }
      await route.continue();
    });

    await page.route(
      new RegExp(`/api/suppliers/${SUPPLIER_ID}/catalog-items/${CATALOG_ITEM_ID}(\\?.*)?$`),
      async (route) => {
        if (route.request().method() === "PATCH") {
          patchedBody = JSON.parse(route.request().postData() ?? "{}") as Record<string, unknown>;
          currentItem = { ...currentItem, ...patchedBody };
          await route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify({ catalog_item: currentItem }),
          });
          return;
        }
        await route.continue();
      },
    );

    await page.route(
      new RegExp(`/api/suppliers/${SUPPLIER_ID}/catalog-items(\\?.*)?$`),
      async (route) => {
        if (route.request().method() === "GET") {
          await route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify({ catalog_items: [currentItem] }),
          });
          return;
        }
        await route.continue();
      },
    );

    await page.goto(`/suppliers/${SUPPLIER_ID}`, { waitUntil: "domcontentloaded" });

    await expect(page.getByRole("heading", { name: "Alpha Supplies" })).toBeVisible({
      timeout: 15_000,
    });

    await page.getByRole("button", { name: "Catalog Items" }).click();

    await expect(page.getByText("Paper A4")).toBeVisible({ timeout: 8_000 });

    // Stock (20) >= par (10): no reorder badge initially
    await expect(page.getByLabel("Stock below par level — reorder needed")).not.toBeVisible();

    // Click the par level button
    await page.getByTitle("Click to edit par level").click();

    const inlineInput = page.locator('input[type="number"]');
    await expect(inlineInput).toBeVisible({ timeout: 3_000 });
    await expect(inlineInput).toHaveValue("10");

    // Set par level above the current stock (20) so the reorder badge should appear after save
    await inlineInput.fill("25");

    // Blur the input to commit (instead of pressing Enter)
    await inlineInput.blur();

    // The inline input should close
    await expect(inlineInput).not.toBeVisible({ timeout: 5_000 });

    // The PATCH should have been fired with the new par level
    expect(patchedBody).not.toBeNull();
    expect(patchedBody).toMatchObject({ par_level: "25" });

    // Stock (20) < new par (25): the reorder badge should now be visible
    await expect(page.getByLabel("Stock below par level — reorder needed")).toBeVisible({
      timeout: 5_000,
    });
  });
});

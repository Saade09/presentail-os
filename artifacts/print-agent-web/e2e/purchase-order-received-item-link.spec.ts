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
const PO_ID = 42;
const BASE_ITEM_ID = 5;

const MOCK_PO = {
  id: PO_ID,
  workspace_owner_id: "user_owner",
  supplier_id: 7,
  supplier_name: "Alpha Supplier",
  po_number: "PO-0042",
  po_number_label: "PO-0042",
  status: "partial",
  currency: "AED",
  total_amount: null,
  total_amount_manual_override: false,
  expected_delivery_date: null,
  notes: null,
  effective_total: "250.00",
  calculated_total: "250.00",
  sent_at: null,
  line_items_count: 1,
  received_items_count: 3,
  outstanding_units: 2,
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
  created_by_clerk_id: null,
  updated_by_clerk_id: null,
};

const MOCK_LINE_ITEM = {
  id: 101,
  purchase_order_id: PO_ID,
  base_item_id: BASE_ITEM_ID,
  base_item_name: "Red Roses",
  description: "Red Roses",
  quantity: "5",
  unit_price: "50.00",
  currency: "AED",
  received_quantity: "3",
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
};

const MOCK_HISTORY_ITEM = {
  id: 201,
  base_item_id: BASE_ITEM_ID,
  base_item_name: "Red Roses",
  quantity_change: 3,
  stock_after: 3,
  location_id: 3,
  location_name: "Main Warehouse",
  note: null,
  created_at: new Date().toISOString(),
};

const MOCK_BASE_ITEM = {
  id: BASE_ITEM_ID,
  workspace_owner_id: "user_owner",
  name: "Red Roses",
  code: "BI0005",
  image_url: null,
  category_id: null,
  alternate_name: null,
  accounting_category: null,
  tax_rate: null,
  main_category_name: null,
  sub_category_name: null,
  created_at: new Date().toISOString(),
  stock: 3,
  low_stock_threshold: 0,
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

async function setupPoRoutes(page: import("@playwright/test").Page) {
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

  await page.route("**/api/locations**", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        locations: [{ id: 3, name: "Main Warehouse" }],
      }),
    }),
  );

  await page.route(/\/api\/purchase-orders(\?.*)?$/, async (route) => {
    if (route.request().method() === "GET") {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ purchase_orders: [], total: 0 }),
      });
      return;
    }
    await route.continue();
  });

  await page.route(/\/api\/purchase-orders\/42(\?.*)?$/, async (route) => {
    if (route.request().method() === "GET") {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ purchase_order: MOCK_PO }),
      });
      return;
    }
    await route.continue();
  });

  await page.route(`**/api/purchase-orders/${PO_ID}/line-items**`, async (route) => {
    if (route.request().method() === "GET") {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          line_items: [MOCK_LINE_ITEM],
          calculated_total: "250.00",
        }),
      });
      return;
    }
    await route.continue();
  });

  await page.route(`**/api/purchase-orders/${PO_ID}/receive-history**`, async (route) => {
    if (route.request().method() === "GET") {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ history: [MOCK_HISTORY_ITEM] }),
      });
      return;
    }
    await route.continue();
  });
}

async function setupBaseItemRoutes(page: import("@playwright/test").Page) {
  await page.route("**/api/base-item-categories**", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ categories: [] }),
    }),
  );

  await page.route(`**/api/base-items/${BASE_ITEM_ID}/location-statuses**`, (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ locationStatuses: [] }),
    }),
  );

  await page.route(`**/api/base-items/${BASE_ITEM_ID}/products**`, (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ products: [] }),
    }),
  );

  await page.route(`**/api/base-items/${BASE_ITEM_ID}/packages**`, (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ packages: [] }),
    }),
  );

  await page.route(`**/api/base-items/${BASE_ITEM_ID}/suppliers**`, (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ suppliers: [] }),
    }),
  );

  await page.route(/\/api\/base-items\/5\/adjustments/, (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ adjustments: [] }),
    }),
  );

  await page.route(/\/api\/base-items\/5(\?|$)/, (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ item: MOCK_BASE_ITEM }),
    }),
  );
}

async function gotoPurchaseOrderDetail(page: import("@playwright/test").Page) {
  await page.goto(`/purchase-orders/${PO_ID}`, { waitUntil: "domcontentloaded" });
  await expect(page.getByRole("heading", { name: "PO-0042" })).toBeVisible({
    timeout: 15_000,
  });
}

test.describe("Purchase Order Detail — Received Items base item link", () => {
  /**
   * Verifies the complete link click → URL navigation chain.
   *
   * The link href is /dashboard/base-items/:id?tab=inventory. The app's
   * /dashboard/:rest* route redirects this to /base-items/:id?tab=inventory.
   * We assert the URL confirms both the base-item path and the inventory tab
   * query param after the click and redirect settle.
   */
  test("clicking the base item name navigates to the base item inventory tab URL", async ({
    page,
  }) => {
    await setupPoRoutes(page);
    await gotoPurchaseOrderDetail(page);

    const receivedSection = page.locator("table").last();
    const baseItemLink = receivedSection.getByRole("link", { name: "Red Roses" });
    await expect(baseItemLink).toBeVisible({ timeout: 8_000 });

    await baseItemLink.click();

    await expect(page).toHaveURL(/\/base-items\/5/, { timeout: 10_000 });
    await expect(page).toHaveURL(/tab=inventory/, { timeout: 5_000 });
  });

  /**
   * Verifies the link's href attribute is constructed correctly before any
   * navigation occurs.
   */
  test("base item link has the correct href pointing to the inventory tab", async ({ page }) => {
    await setupPoRoutes(page);
    await gotoPurchaseOrderDetail(page);

    const receivedSection = page.locator("table").last();
    const baseItemLink = receivedSection.getByRole("link", { name: "Red Roses" });
    await expect(baseItemLink).toBeVisible({ timeout: 8_000 });

    const href = await baseItemLink.getAttribute("href");
    expect(href).toContain(`/base-items/${BASE_ITEM_ID}`);
    expect(href).toContain("tab=inventory");
  });

  /**
   * Verifies that navigating directly to /base-items/:id?tab=inventory (the
   * destination the link resolves to) renders the base item page with the
   * Inventory tab selected as the active tab.
   */
  test("the inventory tab is active when the base item page is opened with tab=inventory", async ({
    page,
  }) => {
    await setupPoRoutes(page);
    await setupBaseItemRoutes(page);
    await page.goto(`/base-items/${BASE_ITEM_ID}?tab=inventory`, {
      waitUntil: "domcontentloaded",
    });

    await expect(page.getByRole("heading", { name: "Red Roses" })).toBeVisible({
      timeout: 15_000,
    });
    await expect(page.getByRole("tab", { name: "Inventory" })).toHaveAttribute(
      "data-state",
      "active",
      { timeout: 8_000 },
    );
  });
});

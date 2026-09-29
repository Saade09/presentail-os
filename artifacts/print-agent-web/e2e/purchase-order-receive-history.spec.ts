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

const MOCK_PO = {
  id: PO_ID,
  workspace_owner_id: "user_owner",
  supplier_id: 7,
  supplier_name: "Alpha Supplier",
  po_number: "PO-0042",
  po_number_label: "PO-0042",
  status: "confirmed",
  currency: "AED",
  total_amount: null,
  total_amount_manual_override: false,
  expected_delivery_date: null,
  notes: null,
  effective_total: "250.00",
  calculated_total: "250.00",
  sent_at: null,
  line_items_count: 1,
  received_items_count: 0,
  outstanding_units: 5,
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
  created_by_clerk_id: null,
  updated_by_clerk_id: null,
};

const MOCK_LINE_ITEM = {
  id: 101,
  purchase_order_id: PO_ID,
  base_item_id: 5,
  base_item_name: "Red Roses",
  description: "Red Roses",
  quantity: "5",
  unit_price: "50.00",
  currency: "AED",
  received_quantity: null,
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
};

const MOCK_LOCATION = { id: 3, name: "Main Warehouse" };

const RECEIVE_DATE = "2026-05-31T10:00:00.000Z";

const MOCK_BASE_ITEM = {
  id: 5,
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

function buildHistoryItem(qty: number) {
  return {
    id: 201,
    base_item_id: MOCK_LINE_ITEM.base_item_id,
    base_item_name: MOCK_LINE_ITEM.base_item_name,
    quantity_change: qty,
    stock_after: qty,
    location_id: MOCK_LOCATION.id,
    location_name: MOCK_LOCATION.name,
    note: null,
    created_at: RECEIVE_DATE,
  };
}

async function setupRoutes(page: import("@playwright/test").Page) {
  let historyItems: ReturnType<typeof buildHistoryItem>[] = [];

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
      body: JSON.stringify({ locations: [MOCK_LOCATION] }),
    }),
  );

  // PO list — broad catch-all (registered first so specific routes take priority)
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

  // PO detail — anchored to avoid matching sub-paths
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

  // Line-items sub-route
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

  // Receive history sub-route — returns the current in-memory list
  await page.route(`**/api/purchase-orders/${PO_ID}/receive-history**`, async (route) => {
    if (route.request().method() === "GET") {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ history: historyItems }),
      });
      return;
    }
    await route.continue();
  });

  // Receive sub-route — records a history entry on POST
  await page.route(`**/api/purchase-orders/${PO_ID}/receive`, async (route) => {
    if (route.request().method() === "POST") {
      const body = JSON.parse(route.request().postData() ?? "{}") as {
        receipts?: Array<{ line_item_id: number; quantity: number }>;
      };
      const receipts = Array.isArray(body.receipts) ? body.receipts : [];
      const totalQty = receipts.reduce((sum, r) => sum + r.quantity, 0);
      historyItems = [buildHistoryItem(totalQty)];
      const received = receipts.map((r) => ({
        base_item_id: MOCK_LINE_ITEM.base_item_id,
        base_item_name: MOCK_LINE_ITEM.base_item_name,
        line_item_id: r.line_item_id,
        quantity_received: r.quantity,
      }));
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ received, location_name: MOCK_LOCATION.name }),
      });
      return;
    }
    await route.continue();
  });
}

async function gotoPurchaseOrderDetail(page: import("@playwright/test").Page) {
  await page.goto(`/purchase-orders/${PO_ID}`, { waitUntil: "domcontentloaded" });
  await expect(page.getByRole("heading", { name: "PO-0042" })).toBeVisible({
    timeout: 15_000,
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

  await page.route(`**/api/base-items/5/location-statuses**`, (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ locationStatuses: [] }),
    }),
  );

  await page.route(`**/api/base-items/5/products**`, (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ products: [] }),
    }),
  );

  await page.route(`**/api/base-items/5/packages**`, (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ packages: [] }),
    }),
  );

  await page.route(`**/api/base-items/5/suppliers**`, (route) =>
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

test.describe("Purchase Order Detail — Received Items section", () => {
  test("shows empty state when no stock has been received yet", async ({ page }) => {
    await setupRoutes(page);
    await gotoPurchaseOrderDetail(page);

    await expect(
      page.getByText("No stock receipts recorded against this purchase order yet."),
    ).toBeVisible({ timeout: 8_000 });
  });

  test("populates with base item name, quantity, location, and date after a receive", async ({
    page,
  }) => {
    await setupRoutes(page);
    await gotoPurchaseOrderDetail(page);

    // Confirm empty state first
    await expect(
      page.getByText("No stock receipts recorded against this purchase order yet."),
    ).toBeVisible({ timeout: 8_000 });

    // Perform a stock receipt
    await page.getByRole("button", { name: "Receive stock" }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible({ timeout: 8_000 });

    await dialog.locator("select").selectOption(String(MOCK_LOCATION.id));
    await dialog.locator('input[type="number"]').fill("5");
    await dialog.getByRole("button", { name: /Receive stock/i }).click();

    // Wait for success toast and dialog to close
    await expect(page.getByText("Stock received", { exact: true })).toBeVisible({
      timeout: 8_000,
    });
    await expect(dialog).not.toBeVisible({ timeout: 8_000 });

    // The Received Items section should now show a row
    const receivedSection = page.locator("table").last();
    await expect(receivedSection.getByText("Red Roses")).toBeVisible({ timeout: 8_000 });
    await expect(receivedSection.getByText("+5")).toBeVisible({ timeout: 5_000 });
    await expect(receivedSection.getByText("Main Warehouse")).toBeVisible({ timeout: 5_000 });

    // Date should match the mocked created_at (May 31, 2026)
    await expect(receivedSection.getByText(/May 31, 2026/)).toBeVisible({ timeout: 5_000 });
  });

  test("Received Items table header columns are visible", async ({ page }) => {
    await setupRoutes(page);
    await gotoPurchaseOrderDetail(page);

    // Perform a receive so the table renders
    await page.getByRole("button", { name: "Receive stock" }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible({ timeout: 8_000 });

    await dialog.locator("select").selectOption(String(MOCK_LOCATION.id));
    await dialog.locator('input[type="number"]').fill("3");
    await dialog.getByRole("button", { name: /Receive stock/i }).click();
    await expect(page.getByText("Stock received", { exact: true })).toBeVisible({
      timeout: 8_000,
    });
    await expect(dialog).not.toBeVisible({ timeout: 8_000 });

    const receivedSection = page.locator("table").last();
    await expect(receivedSection.getByText("Base Item")).toBeVisible({ timeout: 5_000 });
    await expect(receivedSection.getByText("Qty Received")).toBeVisible({ timeout: 5_000 });
    await expect(receivedSection.getByText("Location")).toBeVisible({ timeout: 5_000 });
    await expect(receivedSection.getByText("Date")).toBeVisible({ timeout: 5_000 });
  });

  test("note column shows dash when note is absent", async ({ page }) => {
    await setupRoutes(page);
    await gotoPurchaseOrderDetail(page);

    await page.getByRole("button", { name: "Receive stock" }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible({ timeout: 8_000 });

    await dialog.locator("select").selectOption(String(MOCK_LOCATION.id));
    await dialog.locator('input[type="number"]').fill("2");
    await dialog.getByRole("button", { name: /Receive stock/i }).click();
    await expect(page.getByText("Stock received", { exact: true })).toBeVisible({
      timeout: 8_000,
    });
    await expect(dialog).not.toBeVisible({ timeout: 8_000 });

    // Note is null in the mock, so the cell should render "—"
    const receivedSection = page.locator("table").last();
    // The "—" dash appears in both the Location column (if null) and Note column.
    // Our mock has location set, so the "—" here is from the null note.
    const dashes = receivedSection.getByText("—");
    await expect(dashes.first()).toBeVisible({ timeout: 5_000 });
  });

  test("clicking the base item link after a stock receipt navigates to the inventory tab", async ({
    page,
  }) => {
    await setupRoutes(page);
    await setupBaseItemRoutes(page);
    await gotoPurchaseOrderDetail(page);

    // Confirm empty state first
    await expect(
      page.getByText("No stock receipts recorded against this purchase order yet."),
    ).toBeVisible({ timeout: 8_000 });

    // Perform a stock receipt
    await page.getByRole("button", { name: "Receive stock" }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible({ timeout: 8_000 });

    await dialog.locator("select").selectOption(String(MOCK_LOCATION.id));
    await dialog.locator('input[type="number"]').fill("5");
    await dialog.getByRole("button", { name: /Receive stock/i }).click();

    // Wait for success toast and dialog to close
    await expect(page.getByText("Stock received", { exact: true })).toBeVisible({
      timeout: 8_000,
    });
    await expect(dialog).not.toBeVisible({ timeout: 8_000 });

    // The Received Items section should now show the base item link
    const receivedSection = page.locator("table").last();
    const baseItemLink = receivedSection.getByRole("link", { name: "Red Roses" });
    await expect(baseItemLink).toBeVisible({ timeout: 8_000 });

    // Click the link and verify navigation to the inventory tab
    await baseItemLink.click();
    await expect(page).toHaveURL(/\/base-items\/5/, { timeout: 10_000 });
    await expect(page).toHaveURL(/tab=inventory/, { timeout: 5_000 });
  });
});

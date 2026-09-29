import { test, expect } from "./fixtures";
import { setupFapiWithFakeSession } from "./clerk-fapi-redirect";

// Override the _fapiMock auto-fixture with setupFapiWithFakeSession for this
// spec. All API routes are mocked via page.route, so the backend never
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

const SUPPLIER_ID = 1;
const OWNER_EMAIL = "e2e-tester@presentail.com";

// Enough catalog items that, once added to the cart, the "Review order"
// body (selected-items table + cost adjustments + order details +
// attachments) comfortably overflows a 1440x900 viewport.
const ITEM_COUNT = 12;

const MOCK_SUPPLIER = {
  id: SUPPLIER_ID,
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
  currency_pref: "AED",
  default_vat_treatment: null,
  default_vat_rate: null,
  lead_time_days: null,
  min_order_value: null,
  notes: null,
  is_archived: false,
  item_count: ITEM_COUNT,
  invoice_count: 0,
  spend_ytd: "0",
  spend_ytd_currency: null,
  created_at: new Date().toISOString(),
  updated_at: null,
  created_by_clerk_id: null,
  updated_by_clerk_id: null,
};

const CATALOG_ITEMS = Array.from({ length: ITEM_COUNT }, (_, i) => ({
  id: 100 + i,
  workspace_owner_id: "user_owner",
  supplier_id: SUPPLIER_ID,
  base_item_id: null,
  base_item_name: null,
  supplier_item_code: `SKU-${100 + i}`,
  name: `Catalog Item ${i + 1}`,
  category: "General",
  unit: "pcs",
  package_size: null,
  price: "12.50",
  currency: "AED",
  min_order_quantity: "1",
  par_level: null,
  current_stock: null,
  lead_time_days: null,
  is_active: true,
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
}));

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

async function setupRoutes(page: import("@playwright/test").Page) {
  // ── Catch-all: registered FIRST (lowest LIFO priority) ──
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
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(ownerUsersResponse()),
      });
    }
    await route.continue();
  });

  await page.route("**/api/locations**", async (route) => {
    if (route.request().method() === "GET") {
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          locations: [{ id: 1, name: "Main Warehouse" }],
        }),
      });
    }
    await route.continue();
  });

  // Supplier catalog items (must be registered before the broad suppliers
  // route so the more specific pattern wins under LIFO).
  await page.route(
    new RegExp(`/api/suppliers/${SUPPLIER_ID}/catalog-items(\\?.*)?$`),
    async (route) => {
      if (route.request().method() === "GET") {
        return route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ catalog_items: CATALOG_ITEMS }),
        });
      }
      await route.continue();
    },
  );

  await page.route(/\/api\/suppliers(\?.*)?$/, async (route) => {
    if (route.request().method() === "GET") {
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ suppliers: [MOCK_SUPPLIER] }),
      });
    }
    await route.continue();
  });

  await page.route(/\/api\/purchase-orders(\?.*)?$/, async (route) => {
    if (route.request().method() === "GET") {
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ purchase_orders: [], total: 0 }),
      });
    }
    await route.continue();
  });
}

test.describe("Purchase Order — Review order scrolling", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test("review body scrolls while header and footer stay pinned", async ({
    page,
  }) => {
    // The dashboard shell can take ~15s to boot in CI before the page content
    // renders, and the wizard interaction (selecting a supplier, filling many
    // quantity inputs) adds more, so give this flow a generous budget.
    test.setTimeout(120_000);

    await setupRoutes(page);

    await page.goto("/purchase-orders", { waitUntil: "domcontentloaded" });
    await expect(
      page.getByRole("heading", { name: "Purchase Orders", level: 1 }),
    ).toBeVisible({ timeout: 30_000 });

    // Open the wizard.
    await page
      .getByRole("button", { name: "New Purchase Order" })
      .first()
      .click();
    await expect(
      page.getByRole("heading", { name: "New Purchase Order" }),
    ).toBeVisible({ timeout: 8_000 });

    // Select the supplier so its catalog loads.
    await page.getByRole("button", { name: /Alpha Supplies/ }).first().click();

    // Add every catalog item to the cart by setting a quantity, so the review
    // step has enough rows to overflow.
    for (let i = 0; i < ITEM_COUNT; i++) {
      const qtyInput = page.getByLabel(`Quantity for Catalog Item ${i + 1}`, {
        exact: true,
      });
      await qtyInput.fill("2");
    }

    // Advance to the Review step.
    await page.getByRole("button", { name: /Review Order/ }).click();
    await expect(
      page.getByRole("heading", { name: "Review order" }),
    ).toBeVisible({ timeout: 8_000 });

    const dialog = page.getByRole("dialog");
    const reviewHeader = page.getByRole("heading", { name: "Review order" });
    const createButton = page.getByRole("button", {
      name: /Create purchase order/,
    });
    const grandTotalLabel = dialog.getByText("Grand total").last();

    // The scrollable review body is the single overflow-y-auto container
    // inside the dialog at the review step.
    const scrollBody = dialog.locator(".overflow-y-auto");
    await expect(scrollBody).toHaveCount(1);

    // 1. The body content is taller than its visible area → it is scrollable.
    const metrics = await scrollBody.evaluate((el) => ({
      scrollHeight: el.scrollHeight,
      clientHeight: el.clientHeight,
    }));
    expect(metrics.scrollHeight).toBeGreaterThan(metrics.clientHeight + 1);

    // 2. Header and footer are visible before scrolling.
    await expect(reviewHeader).toBeVisible();
    await expect(createButton).toBeVisible();
    await expect(grandTotalLabel).toBeVisible();

    // 3. Scroll the body to the bottom and confirm it actually scrolled.
    const scrolledTop = await scrollBody.evaluate((el) => {
      el.scrollTop = el.scrollHeight;
      return el.scrollTop;
    });
    expect(scrolledTop).toBeGreaterThan(0);

    // 4. After scrolling the body, the header stays at the top and the footer
    //    (Create button + Grand total) stays pinned at the bottom — i.e. they
    //    live outside the scroll container.
    await expect(reviewHeader).toBeVisible();
    await expect(createButton).toBeVisible();
    await expect(grandTotalLabel).toBeVisible();

    // The footer's Create button must sit below the bottom edge of the
    // scrollable body (pinned beneath it), confirming it is not scrolled away.
    const bodyBox = await scrollBody.boundingBox();
    const footerBox = await createButton.boundingBox();
    const headerBox = await reviewHeader.boundingBox();
    expect(bodyBox).not.toBeNull();
    expect(footerBox).not.toBeNull();
    expect(headerBox).not.toBeNull();
    // Footer is below the scroll body.
    expect(footerBox!.y).toBeGreaterThanOrEqual(
      bodyBox!.y + bodyBox!.height - 2,
    );
    // Header is above the scroll body.
    expect(headerBox!.y + headerBox!.height).toBeLessThanOrEqual(
      bodyBox!.y + 2,
    );
  });
});

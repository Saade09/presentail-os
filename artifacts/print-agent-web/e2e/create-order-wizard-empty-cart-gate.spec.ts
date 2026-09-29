/**
 * E2E: Create Order wizard — empty-cart gate (step 4)
 *
 * Verifies that the wizard's Next button on step 4 (Products) is disabled
 * while the cart is empty, and becomes enabled once at least one product is
 * added to the cart.
 */

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

const MOCK_CONTACT = {
  id: "con-wizard-001",
  display_name: "Alice Tester",
  first_name: "Alice",
  last_name: "Tester",
  email: "alice@example.com",
  phone: "+971501234567",
  orders_placed: 0,
  last_order_at: null,
  deliveries_count: 0,
  recipient_last_delivery_address: null,
};

const MOCK_PRODUCT = {
  id: 42,
  name: "Red Roses Bouquet",
  price_usd: "25.00",
  price_aed: "92.00",
  main_image_url: null,
  status: "available",
  sku: "RRB-001",
  has_input_field: false,
  letter_input_enabled: false,
};

async function setupRoutes(page: import("@playwright/test").Page) {
  // Catch-all for unhandled API routes (SSE, etc.)
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
        body: JSON.stringify({
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
        }),
      });
      return;
    }
    await route.continue();
  });

  await page.route(/\/api\/orders(\?.*)?$/, async (route) => {
    if (route.request().method() === "GET") {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          success: true,
          orders: [],
          total: 0,
          limit: 50,
          offset: 0,
        }),
      });
      return;
    }
    await route.continue();
  });

  // Wizard contact search — return a single mock contact
  await page.route("**/api/contacts/wizard-search**", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ results: [MOCK_CONTACT] }),
    }),
  );

  // Cities for step 3
  await page.route("**/api/cities**", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        cities: [{ slug: "dubai", name: "Dubai", country: "UAE", country_code: "AE" }],
        countries: ["UAE"],
      }),
    }),
  );

  // Products for step 4
  await page.route("**/api/order-catalog/products**", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ products: [MOCK_PRODUCT], total: 1 }),
    }),
  );

  // Catalog attributes for step 4 filters
  await page.route("**/api/catalog-attributes/**", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify([]),
    }),
  );
}

/**
 * Navigate to the Orders page, open the Create Order wizard, complete steps
 * 1–3, and land on step 4 (Products).
 */
async function openWizardAtStep4(page: import("@playwright/test").Page) {
  await page.goto("/orders", { waitUntil: "domcontentloaded" });
  await expect(page.getByRole("heading", { name: "Orders", level: 1 })).toBeVisible({
    timeout: 15_000,
  });

  // Open the wizard
  await page.getByTestId("button-open-create-order").click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible({ timeout: 8_000 });
  await expect(dialog.getByText("Create Order")).toBeVisible();

  // Step 1 — Customer: search and select the mock contact
  const customerSearch = page.getByTestId("create-order-customer-search");
  await customerSearch.fill("Alice");
  const contactResult = page.getByTestId(`create-order-customer-result-${MOCK_CONTACT.id}`);
  await expect(contactResult).toBeVisible({ timeout: 6_000 });
  await contactResult.click();

  const nextBtn = page.getByTestId("button-create-order-next");
  await expect(nextBtn).toBeEnabled({ timeout: 3_000 });
  await nextBtn.click();

  // Step 2 — Recipient: check "same as customer" so the step becomes valid
  const checkbox = page.getByTestId("checkbox-create-order-same-as-customer");
  await expect(checkbox).toBeVisible({ timeout: 5_000 });
  await checkbox.check();
  await expect(nextBtn).toBeEnabled({ timeout: 2_000 });
  await nextBtn.click();

  // Step 3 — Delivery city (always valid): just click Next
  await expect(page.getByText("Collect address later")).toBeVisible({ timeout: 5_000 });
  await expect(nextBtn).toBeEnabled({ timeout: 2_000 });
  await nextBtn.click();

  // Confirm we are on step 4 — the product search input should be visible
  await expect(page.getByTestId("input-create-order-product-search")).toBeVisible({
    timeout: 8_000,
  });
}

test.describe("Create Order wizard — empty-cart gate (step 4)", () => {
  test("Next button is disabled when cart is empty", async ({ page }) => {
    await setupRoutes(page);
    await openWizardAtStep4(page);

    // With an empty cart the Next/subtotal button must be disabled
    const nextBtn = page.getByTestId("button-create-order-next");
    await expect(nextBtn).toBeDisabled();
  });

  test("Next button becomes enabled after adding a product to the cart", async ({ page }) => {
    await setupRoutes(page);
    await openWizardAtStep4(page);

    const nextBtn = page.getByTestId("button-create-order-next");
    await expect(nextBtn).toBeDisabled();

    // Add the mock product to the cart
    const addBtn = page.getByTestId(`button-add-product-${MOCK_PRODUCT.id}`);
    await expect(addBtn).toBeVisible({ timeout: 6_000 });
    await addBtn.click();

    // The Next button should now be enabled and show the item count
    await expect(nextBtn).toBeEnabled({ timeout: 3_000 });
    await expect(nextBtn).toContainText("1");
  });
});

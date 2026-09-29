/**
 * E2E: Create Order wizard — recipient step gate
 *
 * Verifies that the wizard cannot advance past step 2 (Recipient) when no
 * recipient is chosen and the "same as customer" checkbox is unchecked, and
 * that checking the checkbox allows normal progression to step 3 (Delivery).
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
  id: 901,
  name: "Wizard Test Bouquet",
  price_usd: "35.00",
  price_aed: "128.55",
  main_image_url: null,
  status: "available",
  sku: "WIZ-901",
  has_input_field: false,
  letter_input_enabled: false,
};

async function setupRoutes(page: import("@playwright/test").Page) {
  // Catch-all for any unhandled API routes (SSE, etc.)
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

  // Wizard contact search — return a single mock contact for any query
  await page.route("**/api/contacts/wizard-search**", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ results: [MOCK_CONTACT] }),
    }),
  );

  // Return the submitted contact so both create-contact flows can continue
  // through the wizard while the test inspects the exact request payload.
  await page.route("**/api/contacts/wizard-create", async (route) => {
    if (route.request().method() !== "POST") {
      await route.continue();
      return;
    }
    const body = route.request().postDataJSON() as {
      display_name?: string | null;
      email?: string | null;
      phone?: string | null;
    };
    await route.fulfill({
      status: 201,
      contentType: "application/json",
      body: JSON.stringify({
        existing: false,
        contact: {
          ...MOCK_CONTACT,
          id: `created-${body.display_name ?? "contact"}`,
          display_name: body.display_name ?? "Created contact",
          first_name: null,
          last_name: null,
          email: body.email ?? null,
          phone: body.phone ?? null,
        },
      }),
    });
  });

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

  await page.route("**/api/order-catalog/products**", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ products: [MOCK_PRODUCT], total: 1 }),
    }),
  );

  await page.route("**/api/catalog-attributes/**", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify([]),
    }),
  );

  await page.route("**/api/payment-links**", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ payment_links: [] }),
    }),
  );
}

/**
 * Navigate to the Orders page, open the Create Order wizard, complete
 * step 1 by selecting a customer, and advance to step 2 (Recipient).
 */
async function openWizardAtStep2(page: import("@playwright/test").Page) {
  await page.goto("/orders", { waitUntil: "domcontentloaded" });
  await expect(page.getByRole("heading", { name: "Orders", level: 1 })).toBeVisible({
    timeout: 15_000,
  });

  // Open the Create Order wizard
  await page.getByTestId("button-open-create-order").click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible({ timeout: 8_000 });
  await expect(dialog.getByText("Create Order")).toBeVisible();

  // Step 1 — Customer: type a query so the picker returns search results,
  // then select the mock contact to make customerValid = true.
  const customerSearch = page.getByTestId("create-order-customer-search");
  await customerSearch.fill("Alice");
  const contactResult = page.getByTestId(`create-order-customer-result-${MOCK_CONTACT.id}`);
  await expect(contactResult).toBeVisible({ timeout: 6_000 });
  await contactResult.click();

  // The Next button on step 1 should now be enabled (customer is selected)
  const nextBtn = page.getByTestId("button-create-order-next");
  await expect(nextBtn).toBeEnabled({ timeout: 3_000 });
  await nextBtn.click();

  // Verify we are on step 2: the "same as customer" label is visible
  await expect(
    dialog.getByText("Recipient is the same as the customer"),
  ).toBeVisible({ timeout: 5_000 });
}

test.describe("Create Order wizard — recipient step gate", () => {
  test("Next button is disabled when no recipient is selected and checkbox is unchecked", async ({
    page,
  }) => {
    await setupRoutes(page);
    await openWizardAtStep2(page);

    // The "same as customer" checkbox should be unchecked by default
    const checkbox = page.getByTestId("checkbox-create-order-same-as-customer");
    await expect(checkbox).not.toBeChecked();

    // With no recipient chosen and the checkbox unchecked, the wizard blocks
    // progression: the Next button must be disabled.
    const nextBtn = page.getByTestId("button-create-order-next");
    await expect(nextBtn).toBeDisabled();

    // The dialog/wizard must still be showing the Recipient step (step 2 heading
    // or the "same as customer" label remains visible, confirming no advance).
    await expect(
      page.getByText("Recipient is the same as the customer"),
    ).toBeVisible();
  });

  test("wizard advances to step 3 when 'Recipient is the same as the customer' is checked", async ({
    page,
  }) => {
    await setupRoutes(page);
    await openWizardAtStep2(page);

    // Check the "Recipient is the same as the customer" checkbox
    const checkbox = page.getByTestId("checkbox-create-order-same-as-customer");
    await checkbox.check();
    await expect(checkbox).toBeChecked();

    // The Next button should now be enabled
    const nextBtn = page.getByTestId("button-create-order-next");
    await expect(nextBtn).toBeEnabled({ timeout: 2_000 });

    // Click Next — the wizard should advance to step 3 (Delivery)
    await nextBtn.click();

    // Step 3 is identified by the "Collect address later" toggle that is
    // unique to the Delivery step.
    await expect(page.getByText("Collect address later")).toBeVisible({
      timeout: 5_000,
    });

    // The Recipient step label must no longer be the active step content
    await expect(
      page.getByText("Recipient is the same as the customer"),
    ).not.toBeVisible();
  });

  test("new customer can choose a non-default country and submits its E.164 phone", async ({
    page,
  }) => {
    await setupRoutes(page);
    await page.goto("/orders", { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading", { name: "Orders", level: 1 })).toBeVisible({
      timeout: 15_000,
    });
    await page.getByTestId("button-open-create-order").click();

    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible({ timeout: 8_000 });
    await page.getByTestId("create-order-customer-show-create").click();

    const countrySelect = page.getByTestId("create-order-customer-new-phone-country");
    await expect(countrySelect).toBeVisible();
    await expect(countrySelect.locator("option")).toHaveCount(244);
    await expect(
      countrySelect.locator("option", { hasText: "United Arab Emirates (+971)" }),
    ).toBeAttached();
    await expect(countrySelect.locator("option", { hasText: "Israel" })).toHaveCount(0);
    await countrySelect.selectOption("AE");
    await page.getByTestId("create-order-customer-new-name").fill("UAE Customer");
    await page.getByTestId("create-order-customer-new-phone").fill("501234567");

    const createRequest = page.waitForRequest(
      (request) =>
        request.url().includes("/api/contacts/wizard-create") &&
        request.method() === "POST",
    );
    await page.getByTestId("create-order-customer-create-submit").click();
    expect((await createRequest).postDataJSON()).toEqual({
      display_name: "UAE Customer",
      email: null,
      phone: "+971501234567",
    });
  });

  test("new recipient can choose a non-default country and submits its E.164 phone", async ({
    page,
  }) => {
    await setupRoutes(page);
    await openWizardAtStep2(page);
    await page.getByTestId("create-order-recipient-show-create").click();

    const countrySelect = page.getByTestId("create-order-recipient-new-phone-country");
    await expect(countrySelect).toBeVisible();
    await expect(countrySelect.locator("option")).toHaveCount(244);
    await expect(
      countrySelect.locator("option", { hasText: "United Arab Emirates (+971)" }),
    ).toBeAttached();
    await expect(countrySelect.locator("option", { hasText: "Israel" })).toHaveCount(0);
    await countrySelect.selectOption("AE");
    await page.getByTestId("create-order-recipient-new-name").fill("UAE Recipient");
    await page.getByTestId("create-order-recipient-new-phone").fill("501234567");

    const createRequest = page.waitForRequest(
      (request) =>
        request.url().includes("/api/contacts/wizard-create") &&
        request.method() === "POST",
    );
    await page.getByTestId("create-order-recipient-create-submit").click();
    expect((await createRequest).postDataJSON()).toEqual({
      display_name: "UAE Recipient",
      email: null,
      phone: "+971501234567",
    });
  });

  test("created contact stays selected through all six stages and is linked on submit", async ({
    page,
  }) => {
    await setupRoutes(page);
    let submittedOrder: Record<string, unknown> | null = null;
    await page.route("**/api/orders/manual", async (route) => {
      submittedOrder = route.request().postDataJSON() as Record<string, unknown>;
      await route.fulfill({
        status: 201,
        contentType: "application/json",
        body: JSON.stringify({ success: true, id: "order-wizard-001" }),
      });
    });

    await page.goto("/orders", { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading", { name: "Orders", level: 1 })).toBeVisible({
      timeout: 15_000,
    });
    await page.getByTestId("button-open-create-order").click();
    const nextButton = page.getByTestId("button-create-order-next");

    await page.getByTestId("create-order-customer-show-create").click();
    await page.getByTestId("create-order-customer-new-phone-country").selectOption("AE");
    await page.getByTestId("create-order-customer-new-name").fill("UAE Customer");
    await page.getByTestId("create-order-customer-new-phone").fill("501234567");
    await page.getByTestId("create-order-customer-new-email").fill("uae-customer@example.test");
    await page.getByTestId("create-order-customer-create-submit").click();
    await expect(page.getByTestId("create-order-customer-selected")).toContainText("Uae Customer");
    await nextButton.click();

    await page.getByTestId("checkbox-create-order-same-as-customer").check();
    await nextButton.click();
    await expect(page.getByText("Collect address later")).toBeVisible();
    await nextButton.click();

    const addProduct = page.getByTestId(`button-add-product-${MOCK_PRODUCT.id}`);
    await expect(addProduct).toBeVisible({ timeout: 8_000 });
    await addProduct.click();
    await expect(nextButton).toBeEnabled();
    await nextButton.click();

    await expect(page.getByText("Payment Link (optional)")).toBeVisible();
    await nextButton.click();
    await expect(page.getByText("All fields are optional.")).toBeVisible();

    const orderRequest = page.waitForRequest(
      (request) => request.url().includes("/api/orders/manual") && request.method() === "POST",
    );
    await page.getByTestId("button-create-order-submit").click();
    await orderRequest;

    expect(submittedOrder).toMatchObject({
      customer: { contact_id: "created-UAE Customer" },
      recipient: { contact_id: "created-UAE Customer" },
      line_items: [{ product_id: MOCK_PRODUCT.id, quantity: 1 }],
    });
  });

  test("resolved duplicate is selected immediately from a 200 success response", async ({ page }) => {
    await setupRoutes(page);
    await page.route("**/api/contacts/wizard-create", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ existing: true, contact: MOCK_CONTACT }),
      }),
    );

    await page.goto("/orders", { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading", { name: "Orders", level: 1 })).toBeVisible({
      timeout: 15_000,
    });
    await page.getByTestId("button-open-create-order").click();
    await page.getByTestId("create-order-customer-show-create").click();
    await page.getByTestId("create-order-customer-new-phone-country").selectOption("AE");
    await page.getByTestId("create-order-customer-new-name").fill("Alice Tester");
    await page.getByTestId("create-order-customer-new-phone").fill("501234567");
    await page.getByTestId("create-order-customer-create-submit").click();

    await expect(page.getByTestId("create-order-customer-selected")).toContainText("Alice Tester");
    await expect(page.getByTestId("button-create-order-next")).toBeEnabled();
  });

  test("genuine persistence failure keeps the form open with retry guidance", async ({ page }) => {
    await setupRoutes(page);
    await page.route("**/api/contacts/wizard-create", (route) =>
      route.fulfill({
        status: 500,
        contentType: "application/json",
        body: JSON.stringify({
          error: "contact_persistence_failed",
          message: "The contact could not be saved. Please retry.",
        }),
      }),
    );

    await page.goto("/orders", { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading", { name: "Orders", level: 1 })).toBeVisible({
      timeout: 15_000,
    });
    await page.getByTestId("button-open-create-order").click();
    await page.getByTestId("create-order-customer-show-create").click();
    await page.getByTestId("create-order-customer-new-phone-country").selectOption("AE");
    await page.getByTestId("create-order-customer-new-name").fill("Retry Customer");
    await page.getByTestId("create-order-customer-new-phone").fill("501234567");
    await page.getByTestId("create-order-customer-create-submit").click();

    await expect(page.getByText("Could not save the contact. Please try again.")).toBeVisible();
    await expect(page.getByTestId("create-order-customer-create-submit")).toBeVisible();
    await expect(page.getByTestId("create-order-customer-selected")).toHaveCount(0);
  });
});

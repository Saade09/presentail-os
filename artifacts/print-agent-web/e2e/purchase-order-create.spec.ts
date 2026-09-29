import { test, expect } from "./fixtures";
import { setupFapiWithFakeSession } from "./clerk-fapi-redirect";

// Use a fully-mocked Clerk session so all API routes can be controlled via
// page.route without needing a real backend or live FAPI host.
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

const MOCK_SUPPLIER = {
  id: 7,
  workspace_owner_id: "user_owner",
  name: "Beta Materials Co",
  display_name: "Beta Materials",
  contact_name: "Ali Hassan",
  contact_email: "ali@betamaterials.com",
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
  spend_ytd: "0",
  spend_ytd_currency: null,
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
  created_by_clerk_id: null,
  updated_by_clerk_id: null,
};

const CREATED_PO = {
  id: 42,
  workspace_owner_id: "user_owner",
  supplier_id: MOCK_SUPPLIER.id,
  supplier_name: MOCK_SUPPLIER.name,
  po_number: "PO-2026-042",
  po_number_label: "PO-2026-042",
  status: "draft",
  currency: "AED",
  total_amount: null,
  expected_delivery_date: null,
  notes: null,
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
  line_items: [],
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

async function setupRoutes(page: import("@playwright/test").Page) {
  // Catch-all for unhandled API routes
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

  await page.route(/\/api\/suppliers(\?.*)?$/, async (route) => {
    if (route.request().method() === "GET") {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ suppliers: [MOCK_SUPPLIER] }),
      });
      return;
    }
    await route.continue();
  });

  // Purchase orders list — always returns empty so the page renders quickly
  await page.route(/\/api\/purchase-orders(\?.*)?$/, async (route) => {
    if (route.request().method() === "GET") {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ purchase_orders: [] }),
      });
      return;
    }

    if (route.request().method() === "POST") {
      // Artificial delay so we can inspect the in-flight disabled state
      await new Promise<void>((resolve) => setTimeout(resolve, 3000));
      await route.fulfill({
        status: 201,
        contentType: "application/json",
        body: JSON.stringify({ purchase_order: CREATED_PO }),
      });
      return;
    }

    await route.continue();
  });
}

test.describe("Purchase Order create form — double-submit guard", () => {
  test("submit button and form fields are disabled while the POST is in-flight", async ({
    page,
  }) => {
    await setupRoutes(page);

    await page.goto("/purchase-orders", { waitUntil: "domcontentloaded" });

    // Open the create dialog
    await page.getByRole("button", { name: "New Purchase Order" }).first().click();

    const dialog = page.getByRole("alertdialog");
    await expect(dialog).toBeVisible({ timeout: 8_000 });
    await expect(
      dialog.getByRole("heading", { name: "New Purchase Order" }),
    ).toBeVisible();

    // Open the supplier combobox and select the mock supplier.
    // The supplier trigger is a <button role="combobox">, distinct from the
    // <select> elements (Status, Currency) which also carry role="combobox".
    const supplierTrigger = dialog.locator('button[role="combobox"]');
    await supplierTrigger.click();
    await page.getByText("Beta Materials").click();

    // Verify the supplier was selected (trigger now shows the name)
    await expect(supplierTrigger).toContainText("Beta Materials");

    // Click the submit button — the POST will be delayed by 3 s
    await dialog.getByRole("button", { name: /Create Purchase Order/i }).click();

    // Once isSaving = true the button label changes to "Creating…".
    // Verify both the visual feedback and the disabled attribute.
    const creatingBtn = dialog.getByRole("button", { name: /Creating/i });
    await expect(creatingBtn).toBeVisible({ timeout: 2_000 });
    await expect(creatingBtn).toBeDisabled({ timeout: 2_000 });

    // The Cancel button should also be disabled
    const cancelBtn = dialog.getByRole("button", { name: "Cancel" });
    await expect(cancelBtn).toBeDisabled({ timeout: 2_000 });

    // The PO Number input field should be disabled
    await expect(
      dialog.locator('input[placeholder="e.g. PO-2026-001"]'),
    ).toBeDisabled({ timeout: 2_000 });

    // The Notes input field should be disabled
    await expect(
      dialog.locator('input[placeholder="Optional notes…"]'),
    ).toBeDisabled({ timeout: 2_000 });

    // The supplier combobox trigger should be disabled
    await expect(supplierTrigger).toBeDisabled({ timeout: 2_000 });

    // The Status select should be disabled
    await expect(dialog.locator("select").first()).toBeDisabled({ timeout: 2_000 });

    // Wait for the delayed POST to complete and the dialog to close
    await expect(dialog).not.toBeVisible({ timeout: 10_000 });
  });

  test("Add item button is disabled while the POST is in-flight", async ({
    page,
  }) => {
    await setupRoutes(page);

    await page.goto("/purchase-orders", { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading", { name: "Purchase Orders" })).toBeVisible({ timeout: 15_000 });

    await page.getByRole("button", { name: "New Purchase Order" }).first().click();

    const dialog = page.getByRole("alertdialog");
    await expect(dialog).toBeVisible({ timeout: 8_000 });

    // Select a supplier (use button[role="combobox"] to avoid matching selects)
    await dialog.locator('button[role="combobox"]').click();
    await page.getByText("Beta Materials").click();

    // Submit
    await dialog.getByRole("button", { name: /Create Purchase Order/i }).click();

    // The "Add item" button inside the dialog should be disabled in-flight
    await expect(
      dialog.getByRole("button", { name: /Add item/i }),
    ).toBeDisabled({ timeout: 2_000 });

    // Wait for completion
    await expect(dialog).not.toBeVisible({ timeout: 10_000 });
  });
});

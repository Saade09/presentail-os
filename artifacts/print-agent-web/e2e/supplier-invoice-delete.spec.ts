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
const INVOICE_ID = 101;

const BASE_SUPPLIER = {
  id: SUPPLIER_ID,
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
  item_count: 0,
  invoice_count: 1,
  spend_ytd: "1500.00",
  spend_ytd_currency: "AED",
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
  created_by_clerk_id: null,
  updated_by_clerk_id: null,
};

const EXISTING_INVOICE = {
  id: INVOICE_ID,
  supplier_id: SUPPLIER_ID,
  workspace_owner_id: "user_owner",
  amount: "1500.00",
  currency: "AED",
  status: "issued",
  invoice_number: "INV-0101",
  issued_at: "2026-05-01T00:00:00.000Z",
  paid_at: null,
  notes: null,
  reference_type: null,
  reference_id: null,
  reference_name: null,
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

async function setupCommonRoutes(page: import("@playwright/test").Page) {
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

  await page.route(/\/api\/suppliers\/1\/invoices(\?.*)?$/, async (route) => {
    if (route.request().method() === "GET") {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ invoices: [EXISTING_INVOICE], invoice_count: 1 }),
      });
      return;
    }
    await route.continue();
  });

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
}

test.describe("Supplier detail — delete invoice", () => {
  test("deleting an invoice fires DELETE and removes the row from the table", async ({
    page,
  }) => {
    let deleted = false;
    let deleteRequestUrl: string | null = null;

    // Catch-all so any unhandled API call gets an empty-but-valid JSON response
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

    // DELETE /api/suppliers/1/invoices/101 — record the call and mark as deleted
    await page.route(
      /\/api\/suppliers\/1\/invoices\/101(\?.*)?$/,
      async (route) => {
        if (route.request().method() === "DELETE") {
          deleteRequestUrl = route.request().url();
          deleted = true;
          await route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify({ success: true }),
          });
          return;
        }
        await route.continue();
      },
    );

    // Invoices list — returns the invoice until it is deleted, then returns empty
    await page.route(
      /\/api\/suppliers\/1\/invoices(\?.*)?$/,
      async (route) => {
        if (route.request().method() === "GET") {
          const invoices = deleted ? [] : [EXISTING_INVOICE];
          await route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify({
              invoices,
              invoice_count: deleted ? 0 : 1,
            }),
          });
          return;
        }
        await route.continue();
      },
    );

    // Single supplier detail
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

    // Supplier list endpoint
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

    // --- Navigate to the supplier detail page ---
    await page.goto(`/suppliers/${SUPPLIER_ID}`, { waitUntil: "domcontentloaded" });

    await expect(page.getByRole("heading", { name: "Alpha Supplies" })).toBeVisible({
      timeout: 15_000,
    });

    // Open the Invoices tab
    await page.getByRole("button", { name: "Invoices" }).click();

    // The existing invoice row should be visible
    await expect(page.getByText("INV-0101")).toBeVisible({ timeout: 8_000 });

    // Click the Delete (X) button on the invoice row
    const invoiceRow = page.getByRole("row").filter({ hasText: "INV-0101" });
    await invoiceRow.getByTitle("Delete").click();

    // The confirmation dialog should open
    const dialog = page.getByRole("alertdialog");
    await expect(dialog).toBeVisible({ timeout: 5_000 });
    await expect(
      dialog.getByRole("heading", { name: "Delete invoice?" }),
    ).toBeVisible();

    // Confirm the deletion
    await dialog.getByRole("button", { name: "Delete" }).click();

    // Dialog should close after successful deletion
    await expect(dialog).not.toBeVisible({ timeout: 8_000 });

    // Verify the DELETE request was fired to the correct endpoint
    expect(deleteRequestUrl).not.toBeNull();
    expect(deleteRequestUrl).toMatch(
      /\/api\/suppliers\/1\/invoices\/101/,
    );

    // The invoice row should no longer be visible in the table
    await expect(page.getByText("INV-0101")).not.toBeVisible({ timeout: 8_000 });
  });

  test("Deleting… button and Cancel button are both disabled while the DELETE is in-flight", async ({
    page,
  }) => {
    let resolveDelete!: () => void;
    const deleteInflight = new Promise<void>((resolve) => {
      resolveDelete = resolve;
    });

    await setupCommonRoutes(page);

    // Override the DELETE route with an artificial delay
    await page.route(/\/api\/suppliers\/1\/invoices\/101(\?.*)?$/, async (route) => {
      if (route.request().method() === "DELETE") {
        // Signal that the request has arrived, then hold it open
        resolveDelete();
        // Wait before fulfilling so React Query stays in isPending state
        await new Promise<void>((r) => setTimeout(r, 3_000));
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ success: true }),
        });
        return;
      }
      await route.continue();
    });

    await page.goto(`/suppliers/${SUPPLIER_ID}`, { waitUntil: "domcontentloaded" });

    await expect(page.getByRole("heading", { name: "Alpha Supplies" })).toBeVisible({
      timeout: 15_000,
    });

    // Open the Invoices tab
    await page.getByRole("button", { name: "Invoices" }).click();

    await expect(page.getByText("INV-0101")).toBeVisible({ timeout: 8_000 });

    // Click the Delete (X) button on the invoice row
    const invoiceRow = page.getByRole("row").filter({ hasText: "INV-0101" });
    await invoiceRow.getByTitle("Delete").click();

    // The confirmation dialog should open
    const dialog = page.getByRole("alertdialog");
    await expect(dialog).toBeVisible({ timeout: 5_000 });
    await expect(
      dialog.getByRole("heading", { name: "Delete invoice?" }),
    ).toBeVisible();

    // Confirm the deletion — this kicks off the DELETE which we have delayed
    await dialog.getByRole("button", { name: "Delete" }).click();

    // Wait until the interceptor confirms the request arrived
    await deleteInflight;

    // While the request is still pending the action button must be disabled and show "Deleting…"
    await expect(dialog.getByRole("button", { name: /deleting/i })).toBeDisabled({ timeout: 3_000 });

    // The Cancel button must also be disabled while deletion is in progress
    await expect(dialog.getByRole("button", { name: "Cancel" })).toBeDisabled();
  });
});

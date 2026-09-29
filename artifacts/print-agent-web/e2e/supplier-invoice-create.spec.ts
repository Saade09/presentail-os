import { test, expect } from "./fixtures";
import { setupFapiWithFakeSession } from "./clerk-fapi-redirect";

// Override the _fapiMock auto-fixture with setupFapiWithFakeSession for this
// spec. All API routes are mocked via page.route, so the backend never
// validates the JWT — a fully static fake Clerk session is sufficient and
// avoids any dependency on the live FAPI host or a real .auth-session.json
// written by global-setup.
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
  invoice_count: 0,
  spend_ytd: "0",
  spend_ytd_currency: null,
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
  created_by_clerk_id: null,
  updated_by_clerk_id: null,
};

const CREATED_INVOICE = {
  id: 101,
  supplier_id: SUPPLIER_ID,
  workspace_owner_id: "user_owner",
  amount: "1500.00",
  currency: "AED",
  status: "issued",
  invoice_number: null,
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

test.describe("Supplier detail — create invoice updates count", () => {
  test("opens a historical AI-linked invoice scan when its stored source is available", async ({ page }) => {
    await page.route("**/api/**", (route) => route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({}),
    }));
    await page.route("**/api/users**", (route) => route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(ownerUsersResponse()),
    }));
    await page.route(/\/api\/suppliers\/1\/invoices(\?.*)?$/, (route) => route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        invoices: [
          { ...CREATED_INVOICE, id: 201, invoice_number: "AI-201", ai_import_id: 701, ai_import_source_available: true },
          { ...CREATED_INVOICE, id: 202, invoice_number: "AI-202", ai_import_id: 702, ai_import_source_available: false },
          { ...CREATED_INVOICE, id: 203, invoice_number: "MANUAL-203" },
        ],
      }),
    }));
    await page.route(/\/api\/suppliers\/1(\?.*)?$/, (route) => route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ supplier: BASE_SUPPLIER }),
    }));
    await page.route(/\/api\/finance\/invoice-review\/701\/source$/, (route) => route.fulfill({
      status: 200,
      contentType: "application/pdf",
      headers: { "Content-Disposition": 'inline; filename="historical-invoice.pdf"' },
      body: Buffer.from("%PDF-1.4 historical invoice"),
    }));

    await page.goto(`/suppliers/${SUPPLIER_ID}`, { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading", { name: "Alpha Supplies" })).toBeVisible({ timeout: 15_000 });
    await page.getByRole("button", { name: "Invoices" }).click();
    await expect(page.getByTestId("link-view-invoice-source-201")).toHaveAttribute(
      "href",
      "/api/finance/invoice-review/701/source",
    );
    await expect(page.getByTestId("link-view-invoice-source-202")).toHaveCount(0);
    await expect(page.getByTestId("link-view-invoice-source-203")).toHaveCount(0);
    const sourcePagePromise = page.waitForEvent("popup");
    await page.getByTestId("link-view-invoice-source-201").click();
    const sourcePage = await sourcePagePromise;
    await sourcePage.waitForURL(/\/api\/finance\/invoice-review\/701\/source$/);
  });

  test("creating an invoice increments the invoice count on the supplier list", async ({
    page,
  }) => {
    let invoiceCount = 0;

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

    // Invoices sub-resource — registered before the single-supplier route so
    // it takes precedence for /api/suppliers/1/invoices
    await page.route(
      /\/api\/suppliers\/1\/invoices(\?.*)?$/,
      async (route) => {
        const method = route.request().method();
        if (method === "GET") {
          const invoices = invoiceCount > 0 ? [CREATED_INVOICE] : [];
          await route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify({ invoices, invoice_count: invoiceCount }),
          });
          return;
        }
        if (method === "POST") {
          invoiceCount += 1;
          await route.fulfill({
            status: 201,
            contentType: "application/json",
            body: JSON.stringify({ invoice: CREATED_INVOICE }),
          });
          return;
        }
        await route.continue();
      },
    );

    // Single supplier detail — reflects the latest invoiceCount so that
    // react-query invalidation after creation shows the updated badge
    await page.route(/\/api\/suppliers\/1(\?.*)?$/, async (route) => {
      if (route.request().method() === "GET") {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            supplier: { ...BASE_SUPPLIER, invoice_count: invoiceCount },
          }),
        });
        return;
      }
      await route.continue();
    });

    // Supplier list endpoint — reflects the latest invoiceCount
    await page.route(/\/api\/suppliers(\?.*)?$/, async (route) => {
      if (route.request().method() === "GET") {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            suppliers: [{ ...BASE_SUPPLIER, invoice_count: invoiceCount }],
          }),
        });
        return;
      }
      await route.continue();
    });

    // --- Navigate to the supplier detail page ---
    await page.goto(`/suppliers/${SUPPLIER_ID}`, { waitUntil: "domcontentloaded" });

    // Wait for the supplier page heading to appear
    await expect(page.getByRole("heading", { name: "Alpha Supplies" })).toBeVisible({
      timeout: 15_000,
    });

    // Click the Invoices tab (tabs are plain <button> elements, not role="tab")
    await page.getByRole("button", { name: "Invoices" }).click();

    // Click "Add Invoice" to open the dialog
    await page.getByRole("button", { name: "Add Invoice" }).first().click();

    // The dialog should appear
    const dialog = page.getByRole("alertdialog");
    await expect(dialog).toBeVisible({ timeout: 5_000 });
    await expect(
      dialog.getByRole("heading", { name: "Add Invoice" }),
    ).toBeVisible();

    // Fill in the required fields
    await dialog.getByPlaceholder("0.00").fill("1500");

    // Currency defaults to AED (supplier.currency_pref) — no change needed

    // Issue Date — first date input in the dialog (issued_at; paid_at is second)
    await dialog.locator('input[type="date"]').first().fill("2026-05-01");

    // Submit via the dialog action button
    await dialog.getByRole("button", { name: "Add Invoice" }).click();

    // Dialog should close after successful creation
    await expect(dialog).not.toBeVisible({ timeout: 8_000 });

    // --- Navigate to the supplier list page ---
    await page.goto("/suppliers", { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading", { name: "Suppliers" })).toBeVisible({ timeout: 15_000 });

    // Wait for the list to render — match the display_name cell exactly
    await expect(page.getByText("Alpha Supplies", { exact: true })).toBeVisible({
      timeout: 12_000,
    });

    // The invoice count for this supplier should now show "1"
    const supplierRow = page.getByRole("row", { name: /Alpha Supplies/i });
    await expect(supplierRow).toBeVisible();
    await expect(supplierRow.getByText("1", { exact: true })).toBeVisible();
  });
});

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
  id: 101,
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

test.describe("Supplier detail — add invoice", () => {
  test("Add Invoice button and form fields are disabled while the POST is in-flight", async ({
    page,
  }) => {
    let resolvePost!: () => void;
    const postInflight = new Promise<void>((resolve) => {
      resolvePost = resolve;
    });

    await setupCommonRoutes(page);

    // Override the POST route with an artificial delay
    await page.route(/\/api\/suppliers\/1\/invoices(\?.*)?$/, async (route) => {
      if (route.request().method() === "POST") {
        // Signal that the request has arrived, then hold it open
        resolvePost();
        // Wait before fulfilling so React Query stays in isPending state
        await new Promise<void>((r) => setTimeout(r, 3_000));
        const newInvoice = {
          ...EXISTING_INVOICE,
          id: 201,
          invoice_number: "INV-0202",
          amount: "500.00",
          currency: "AED",
          status: "issued",
        };
        await route.fulfill({
          status: 201,
          contentType: "application/json",
          body: JSON.stringify({ invoice: newInvoice }),
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

    // Click the "Add Invoice" button to open the create dialog
    await page.getByRole("button", { name: "Add Invoice" }).click();

    const dialog = page.getByRole("alertdialog");
    await expect(dialog).toBeVisible({ timeout: 5_000 });
    await expect(dialog.getByRole("heading", { name: "Add Invoice" })).toBeVisible();

    // Fill in required fields
    await dialog.getByPlaceholder("0.00").fill("500");
    await dialog.getByPlaceholder(/INV-/).fill("INV-0202");

    // Submit — kicks off the POST which we have delayed
    await dialog.getByRole("button", { name: "Add Invoice" }).click();

    // Wait until the interceptor confirms the request arrived
    await postInflight;

    // While the request is still pending the action button must be disabled and show "Creating…"
    await expect(dialog.getByRole("button", { name: /creating/i })).toBeDisabled({ timeout: 3_000 });

    // The amount input must also be disabled while creating
    await expect(dialog.getByPlaceholder("0.00")).toBeDisabled();

    // The invoice number input must also be disabled
    await expect(dialog.getByPlaceholder("INV-001")).toBeDisabled();

    // The currency select (first <select> in the dialog) must be disabled
    await expect(dialog.locator("select").first()).toBeDisabled();

    // The Cancel button must be disabled too
    await expect(dialog.getByRole("button", { name: "Cancel" })).toBeDisabled();
  });
});

test.describe("Supplier detail — delete invoice", () => {
  test("Delete button and Cancel are disabled while the DELETE is in-flight", async ({
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
        // Hold the request open so React Query stays in isPending state
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

    // Click the Delete (trash) button for the invoice row to open the confirm dialog
    const invoiceRow = page.getByRole("row").filter({ hasText: "INV-0101" });
    await invoiceRow.getByTitle("Delete").click();

    // The delete confirmation dialog should open
    const dialog = page.getByRole("alertdialog");
    await expect(dialog).toBeVisible({ timeout: 5_000 });
    await expect(dialog.getByRole("heading", { name: "Delete invoice?" })).toBeVisible();

    // Confirm the deletion — this kicks off the DELETE request which we have delayed
    await dialog.getByRole("button", { name: "Delete" }).click();

    // Wait until the interceptor confirms the request arrived
    await deleteInflight;

    // While the request is still pending the Delete action button must be disabled and show "Deleting…"
    await expect(dialog.getByRole("button", { name: /deleting/i })).toBeDisabled({
      timeout: 3_000,
    });

    // The Cancel button must also be disabled while the delete is in-flight
    await expect(dialog.getByRole("button", { name: "Cancel" })).toBeDisabled();
  });
});

test.describe("Supplier detail — edit invoice", () => {
  test("editing an invoice fires PATCH and reflects the updated row in the table", async ({
    page,
  }) => {
    let patchedBody: Record<string, unknown> | null = null;
    let currentInvoice = { ...EXISTING_INVOICE };

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

    // PATCH /api/suppliers/1/invoices/101 — capture the request body and
    // update the in-memory invoice so subsequent GETs reflect the change
    await page.route(/\/api\/suppliers\/1\/invoices\/101(\?.*)?$/, async (route) => {
      if (route.request().method() === "PATCH") {
        patchedBody = JSON.parse(route.request().postData() ?? "{}") as Record<string, unknown>;
        currentInvoice = { ...currentInvoice, ...patchedBody };
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ invoice: currentInvoice }),
        });
        return;
      }
      await route.continue();
    });

    // Invoices list — registered before the single-supplier route so it takes
    // precedence for /api/suppliers/1/invoices
    await page.route(/\/api\/suppliers\/1\/invoices(\?.*)?$/, async (route) => {
      if (route.request().method() === "GET") {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ invoices: [currentInvoice], invoice_count: 1 }),
        });
        return;
      }
      await route.continue();
    });

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

    // Click the Edit (pencil) button for that invoice row.
    // The button uses title="Edit" (no visible text), so scope the click to
    // the specific row to avoid matching the supplier-level "Edit" text buttons.
    const invoiceRow = page.getByRole("row").filter({ hasText: "INV-0101" });
    await invoiceRow.getByTitle("Edit").click();

    // The "Edit Invoice" dialog should open with pre-filled values
    const dialog = page.getByRole("alertdialog");
    await expect(dialog).toBeVisible({ timeout: 5_000 });
    await expect(dialog.getByRole("heading", { name: "Edit Invoice" })).toBeVisible();

    // Verify the amount field is pre-filled with the existing value
    await expect(dialog.getByPlaceholder("0.00")).toHaveValue("1500.00");

    // Change the amount to a new value
    await dialog.getByPlaceholder("0.00").fill("2000");

    // Change the status from "issued" to "paid"
    await dialog.locator("select").nth(1).selectOption("paid");

    // Submit via the "Save changes" action button
    await dialog.getByRole("button", { name: "Save changes" }).click();

    // Dialog should close after a successful update
    await expect(dialog).not.toBeVisible({ timeout: 8_000 });

    // Verify the PATCH request fired with the updated values
    expect(patchedBody).not.toBeNull();
    expect(patchedBody).toMatchObject({
      amount: "2000",
      status: "paid",
    });

    // The updated amount should be reflected in the invoice table row
    await expect(page.getByText("2,000.00")).toBeVisible({ timeout: 8_000 });
  });

  test("Save changes button and form fields are disabled while the PATCH is in-flight", async ({
    page,
  }) => {
    let resolvePatch!: () => void;
    const patchInflight = new Promise<void>((resolve) => {
      resolvePatch = resolve;
    });

    await setupCommonRoutes(page);

    // Override the PATCH route with an artificial delay
    await page.route(/\/api\/suppliers\/1\/invoices\/101(\?.*)?$/, async (route) => {
      if (route.request().method() === "PATCH") {
        // Signal that the request has arrived, then hold it open
        resolvePatch();
        // Wait before fulfilling so React Query stays in isPending state
        await new Promise<void>((r) => setTimeout(r, 3_000));
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ invoice: { ...EXISTING_INVOICE, amount: "2000.00" } }),
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

    // Click the Edit button for the invoice row
    const invoiceRow = page.getByRole("row").filter({ hasText: "INV-0101" });
    await invoiceRow.getByTitle("Edit").click();

    const dialog = page.getByRole("alertdialog");
    await expect(dialog).toBeVisible({ timeout: 5_000 });

    // Change the amount so there is something to submit
    await dialog.getByPlaceholder("0.00").fill("2000");

    // Submit — this kicks off the PATCH which we have delayed
    await dialog.getByRole("button", { name: "Save changes" }).click();

    // Wait until the interceptor confirms the request arrived
    await patchInflight;

    // While the request is still pending the button must be disabled
    await expect(dialog.getByRole("button", { name: /saving/i })).toBeDisabled({ timeout: 3_000 });

    // The amount input must also be disabled while saving
    await expect(dialog.getByPlaceholder("0.00")).toBeDisabled();

    // The Cancel button must be disabled too
    await expect(dialog.getByRole("button", { name: "Cancel" })).toBeDisabled();
  });
});

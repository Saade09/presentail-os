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
const DOCUMENT_ID = 201;

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
  spend_ytd: "0.00",
  spend_ytd_currency: "AED",
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
  created_by_clerk_id: null,
  updated_by_clerk_id: null,
};

const EXISTING_DOCUMENT = {
  id: DOCUMENT_ID,
  supplier_id: SUPPLIER_ID,
  workspace_owner_id: "user_owner",
  file_name: "contract-2026.pdf",
  file_url: "/objects/contract-2026.pdf",
  uploaded_by_clerk_id: null,
  created_at: new Date().toISOString(),
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

  await page.route(/\/api\/suppliers\/1\/documents(\?.*)?$/, async (route) => {
    if (route.request().method() === "GET") {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ documents: [EXISTING_DOCUMENT] }),
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

test.describe("Supplier detail — delete document", () => {
  test("delete button is disabled (spinner visible) while DELETE is in-flight", async ({
    page,
  }) => {
    let resolveDelete!: () => void;
    const deleteInflight = new Promise<void>((resolve) => {
      resolveDelete = resolve;
    });

    await setupCommonRoutes(page);

    // Override the DELETE route with an artificial delay so React Query stays in isPending
    await page.route(
      /\/api\/suppliers\/1\/documents\/201(\?.*)?$/,
      async (route) => {
        if (route.request().method() === "DELETE") {
          resolveDelete();
          await new Promise<void>((r) => setTimeout(r, 3_000));
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

    await page.goto(`/suppliers/${SUPPLIER_ID}`, { waitUntil: "domcontentloaded" });

    await expect(
      page.getByRole("heading", { name: "Alpha Supplies" }),
    ).toBeVisible({ timeout: 15_000 });

    // Open the Documents tab
    await page.getByRole("button", { name: "Documents" }).click();

    // The document row should be visible
    await expect(page.getByText("contract-2026.pdf")).toBeVisible({
      timeout: 8_000,
    });

    // Click the Delete button on the document row — this fires the mutation directly (no dialog)
    const docRow = page.getByRole("row").filter({ hasText: "contract-2026.pdf" });
    await docRow.getByTitle("Delete").click();

    // Wait until the interceptor confirms the DELETE request has arrived
    await deleteInflight;

    // While the request is still in-flight the delete button must be disabled
    await expect(docRow.getByTitle("Delete")).toBeDisabled({ timeout: 3_000 });

    // The spinner (Loader2) should replace the X icon — verify via the animate-spin class
    await expect(
      docRow.locator("svg.animate-spin"),
    ).toBeVisible({ timeout: 3_000 });
  });
});

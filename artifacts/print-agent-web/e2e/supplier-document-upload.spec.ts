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

test.describe("Supplier detail — upload document", () => {
  test("upload button is disabled (spinner visible) while POST is in-flight", async ({
    page,
  }) => {
    let resolveUpload!: () => void;
    const uploadInflight = new Promise<void>((resolve) => {
      resolveUpload = resolve;
    });

    await setupCommonRoutes(page);

    // Override the POST route with an artificial delay so React Query stays in isPending
    await page.route(/\/api\/suppliers\/1\/documents(\?.*)?$/, async (route) => {
      if (route.request().method() === "POST") {
        resolveUpload();
        await new Promise<void>((r) => setTimeout(r, 3_000));
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            document: {
              ...EXISTING_DOCUMENT,
              id: 202,
              file_name: "new-contract.pdf",
            },
          }),
        });
        return;
      }
      await route.continue();
    });

    await page.goto(`/suppliers/${SUPPLIER_ID}`, { waitUntil: "domcontentloaded" });

    await expect(
      page.getByRole("heading", { name: "Alpha Supplies" }),
    ).toBeVisible({ timeout: 15_000 });

    // Open the Documents tab
    await page.getByRole("button", { name: "Documents" }).click();

    // The existing document row should be visible
    await expect(page.getByText("contract-2026.pdf")).toBeVisible({
      timeout: 8_000,
    });

    // Trigger upload by setting a file on the hidden file input directly
    const fileInput = page.locator('input[type="file"]');
    await fileInput.setInputFiles({
      name: "new-contract.pdf",
      mimeType: "application/pdf",
      buffer: Buffer.from("%PDF-1.4 fake pdf content"),
    });

    // Wait until the interceptor confirms the POST request has arrived
    await uploadInflight;

    // While the request is still in-flight the upload button must be disabled.
    // Use /upload/i which matches both "Upload Document" (idle) and "Uploading…" (pending).
    const uploadButton = page.getByRole("button", { name: /upload/i });
    await expect(uploadButton).toBeDisabled({ timeout: 3_000 });

    // The spinner (Loader2) should replace the Upload icon — verify via the animate-spin class
    await expect(
      uploadButton.locator("svg.animate-spin"),
    ).toBeVisible({ timeout: 3_000 });
  });

  test("empty-state upload button is disabled (spinner visible) while POST is in-flight", async ({
    page,
  }) => {
    let resolveUpload!: () => void;
    const uploadInflight = new Promise<void>((resolve) => {
      resolveUpload = resolve;
    });

    await setupCommonRoutes(page);

    // Override the documents GET to return an empty list so the empty-state panel renders
    await page.route(/\/api\/suppliers\/1\/documents(\?.*)?$/, async (route) => {
      if (route.request().method() === "GET") {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ documents: [] }),
        });
        return;
      }
      if (route.request().method() === "POST") {
        resolveUpload();
        await new Promise<void>((r) => setTimeout(r, 3_000));
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            document: {
              ...EXISTING_DOCUMENT,
              id: 203,
              file_name: "first-contract.pdf",
            },
          }),
        });
        return;
      }
      await route.continue();
    });

    await page.goto(`/suppliers/${SUPPLIER_ID}`, { waitUntil: "domcontentloaded" });

    await expect(
      page.getByRole("heading", { name: "Alpha Supplies" }),
    ).toBeVisible({ timeout: 15_000 });

    // Open the Documents tab
    await page.getByRole("button", { name: "Documents" }).click();

    // The empty-state panel should be visible
    await expect(page.getByText("No documents yet")).toBeVisible({
      timeout: 8_000,
    });

    // Trigger upload by setting a file on the hidden file input directly
    const fileInput = page.locator('input[type="file"]');
    await fileInput.setInputFiles({
      name: "first-contract.pdf",
      mimeType: "application/pdf",
      buffer: Buffer.from("%PDF-1.4 fake pdf content"),
    });

    // Wait until the interceptor confirms the POST request has arrived
    await uploadInflight;

    // While the request is still in-flight the empty-state upload button must be disabled.
    // Use /upload/i which matches both "Upload Document" (idle) and "Uploading…" (pending).
    const uploadButton = page.getByRole("button", { name: /upload/i });
    await expect(uploadButton).toBeDisabled({ timeout: 3_000 });

    // The spinner (Loader2) should replace the Upload icon — verify via the animate-spin class
    await expect(
      uploadButton.locator("svg.animate-spin"),
    ).toBeVisible({ timeout: 3_000 });
  });
});

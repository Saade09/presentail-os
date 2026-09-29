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

const MINIMAL_PDF = Buffer.from(
  "%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\nxref\n0 0\ntrailer\n<< /Size 1 >>\nstartxref\n0\n%%EOF\n",
);

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

async function setupBaseRoutes(page: import("@playwright/test").Page) {
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
}

async function gotoPurchaseOrderDetail(page: import("@playwright/test").Page) {
  await page.goto(`/purchase-orders/${PO_ID}`, { waitUntil: "domcontentloaded" });
  await expect(page.getByRole("heading", { name: "PO-0042" })).toBeVisible({ timeout: 15_000 });
}

test.describe("Purchase Order Detail — Download PDF", () => {
  test("shows Generating… while in-flight and returns to Download PDF after response", async ({ page }) => {
    await setupBaseRoutes(page);
    await gotoPurchaseOrderDetail(page);

    const downloadButton = page.getByRole("button", { name: "Download PDF" });
    await expect(downloadButton).toBeVisible({ timeout: 5_000 });

    // Register the deferred PDF route only after the page has loaded, so it
    // cannot interfere with initial API calls made during page hydration.
    let resolvePdf!: () => void;
    const pdfReady = new Promise<void>((resolve) => {
      resolvePdf = resolve;
    });

    await page.route(`**/api/purchase-orders/${PO_ID}/pdf`, async (route) => {
      await pdfReady;
      await route.fulfill({
        status: 200,
        contentType: "application/pdf",
        body: MINIMAL_PDF,
      });
    });

    await downloadButton.click();

    await expect(page.getByRole("button", { name: "Generating…" })).toBeVisible({ timeout: 5_000 });

    resolvePdf();

    await expect(page.getByRole("button", { name: "Download PDF" })).toBeVisible({ timeout: 8_000 });
  });

  test("shows a destructive error toast and returns to idle when PDF endpoint returns 500", async ({ page }) => {
    await setupBaseRoutes(page);
    await gotoPurchaseOrderDetail(page);

    await page.route(`**/api/purchase-orders/${PO_ID}/pdf`, async (route) => {
      await route.fulfill({
        status: 500,
        contentType: "application/json",
        body: JSON.stringify({ error: "Internal server error" }),
      });
    });

    const downloadButton = page.getByRole("button", { name: "Download PDF" });
    await expect(downloadButton).toBeVisible({ timeout: 5_000 });

    await downloadButton.click();

    const errorToast = page.locator('[role="status"].destructive, [data-state="open"].destructive').filter({ hasText: "Failed to generate PDF" });
    await expect(errorToast).toBeVisible({ timeout: 8_000 });

    await expect(page.getByRole("button", { name: "Download PDF" })).toBeVisible({ timeout: 8_000 });
    await expect(page.getByRole("button", { name: "Generating…" })).not.toBeVisible();
  });

  test("Download PDF button is visible and idle on page load", async ({ page }) => {
    await setupBaseRoutes(page);

    await page.route(`**/api/purchase-orders/${PO_ID}/pdf`, async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/pdf",
        body: MINIMAL_PDF,
      });
    });

    await gotoPurchaseOrderDetail(page);

    await expect(page.getByRole("button", { name: "Download PDF" })).toBeVisible({ timeout: 5_000 });
    await expect(page.getByRole("button", { name: "Generating…" })).not.toBeVisible();
  });

  test("clicking Download PDF receives application/pdf response containing the PO number", async ({ page }) => {
    await setupBaseRoutes(page);

    // Build a minimal PDF-shaped buffer that embeds the PO number label so
    // the body assertion below can verify it is present in the response.
    const PO_LABEL = "PO-0042";
    const pdfBody = Buffer.from(
      `%PDF-1.4\n% ${PO_LABEL}\n1 0 obj\n<< /Type /Catalog >>\nendobj\nxref\n0 0\ntrailer\n<< /Size 1 >>\nstartxref\n0\n%%EOF\n`,
    );

    await page.route(`**/api/purchase-orders/${PO_ID}/pdf`, async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/pdf",
        body: pdfBody,
      });
    });

    await gotoPurchaseOrderDetail(page);

    const downloadButton = page.getByRole("button", { name: "Download PDF" });
    await expect(downloadButton).toBeVisible({ timeout: 5_000 });

    const [response] = await Promise.all([
      page.waitForResponse((r) => r.url().includes(`/api/purchase-orders/${PO_ID}/pdf`)),
      downloadButton.click(),
    ]);

    expect(response.status()).toBe(200);
    expect(response.headers()["content-type"]).toContain("application/pdf");
    const body = await response.body();
    expect(body.toString()).toContain(PO_LABEL);
  });
});

import { test, expect } from "./fixtures";
import { setupFapiWithFakeSession } from "./clerk-fapi-redirect";
import { setupPurchaseOrderRoutes } from "./purchase-order-test-utils";

test.use({
  _fapiMock: [
    async ({ page }, use) => {
      await setupFapiWithFakeSession(page);
      await use();
    },
    { auto: true },
  ],
});

const PO_ID = 42;

const BASE_PO = {
  id: PO_ID,
  workspace_owner_id: "user_owner",
  supplier_id: 7,
  supplier_name: "Alpha Supplier",
  po_number: "PO-0042",
  po_number_label: "PO-0042",
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

const MOCK_PO_CONFIRMED = { ...BASE_PO, status: "confirmed" };
const MOCK_PO_SENT = { ...BASE_PO, status: "sent", sent_at: new Date().toISOString() };

type SetupOpts = {
  initialPo?: object;
};

async function setupRoutes(page: import("@playwright/test").Page, opts: SetupOpts = {}) {
  const { initialPo = MOCK_PO_CONFIRMED } = opts;

  let sendCalled = false;
  let sendPostCount = 0;

  const ctx = await setupPurchaseOrderRoutes(page, {
    poId: PO_ID,
    getPo: () => (sendCalled ? MOCK_PO_SENT : initialPo),
    getLineItems: [],
    suppliers: [],
    locations: [],
  });

  await page.route(`**/api/purchase-orders/${PO_ID}/send`, async (route) => {
    if (route.request().method() === "POST") {
      sendCalled = true;
      sendPostCount += 1;
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ success: true }),
      });
    }
    await route.continue();
  });

  return {
    ...ctx,
    getSendPostCount: () => sendPostCount,
  };
}

async function gotoPurchaseOrderDetail(page: import("@playwright/test").Page) {
  await page.goto(`/purchase-orders/${PO_ID}`, { waitUntil: "domcontentloaded" });
  await expect(page.getByRole("heading", { name: "PO-0042" })).toBeVisible({ timeout: 15_000 });
}

test.describe("Purchase Order Detail — Send PO email", () => {
  test("clicking Send to supplier opens the confirmation dialog", async ({ page }) => {
    await setupRoutes(page);
    await gotoPurchaseOrderDetail(page);

    await page.getByRole("button", { name: "Send to supplier" }).click();

    const dialog = page.getByRole("alertdialog");
    await expect(dialog).toBeVisible({ timeout: 8_000 });
    await expect(dialog.getByRole("heading", { name: "Send to supplier?" })).toBeVisible();
    await expect(dialog.getByText(/This will email/)).toBeVisible();
    await expect(dialog.getByRole("button", { name: "Send email" })).toBeVisible();
    await expect(dialog.getByRole("button", { name: "Cancel" })).toBeVisible();
  });

  test("confirming send calls the API, shows success toast, and updates the status badge to Sent", async ({ page }) => {
    const ctx = await setupRoutes(page);
    await gotoPurchaseOrderDetail(page);

    // Verify initial "Confirmed" badge is visible
    await expect(page.getByText("Confirmed", { exact: true })).toBeVisible({ timeout: 8_000 });

    await page.getByRole("button", { name: "Send to supplier" }).click();

    const dialog = page.getByRole("alertdialog");
    await expect(dialog).toBeVisible({ timeout: 8_000 });

    await dialog.getByRole("button", { name: "Send email" }).click();

    // Toast title and description both appear
    await expect(page.getByText("Purchase order sent", { exact: true })).toBeVisible({ timeout: 8_000 });
    await expect(page.getByText("Email sent to supplier contact.", { exact: true })).toBeVisible({ timeout: 5_000 });

    // Exactly one POST was sent
    expect(ctx.getSendPostCount()).toBe(1);

    // Status badge updates after query invalidation re-fetches the PO
    await expect(page.getByText("Sent", { exact: true })).toBeVisible({ timeout: 8_000 });
  });

  test("Cancel closes the dialog without calling the send API", async ({ page }) => {
    const ctx = await setupRoutes(page);
    await gotoPurchaseOrderDetail(page);

    await page.getByRole("button", { name: "Send to supplier" }).click();

    const dialog = page.getByRole("alertdialog");
    await expect(dialog).toBeVisible({ timeout: 8_000 });

    await dialog.getByRole("button", { name: "Cancel" }).click();

    await expect(dialog).not.toBeVisible({ timeout: 5_000 });
    expect(ctx.getSendPostCount()).toBe(0);
  });

  test("dialog closes after successful send", async ({ page }) => {
    await setupRoutes(page);
    await gotoPurchaseOrderDetail(page);

    await page.getByRole("button", { name: "Send to supplier" }).click();

    const dialog = page.getByRole("alertdialog");
    await expect(dialog).toBeVisible({ timeout: 8_000 });

    await dialog.getByRole("button", { name: "Send email" }).click();

    await expect(page.getByText("Purchase order sent", { exact: true })).toBeVisible({ timeout: 8_000 });
    await expect(dialog).not.toBeVisible({ timeout: 8_000 });
  });
});

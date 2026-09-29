import { test, expect } from "./fixtures";
import { setupFapiWithFakeSession } from "./clerk-fapi-redirect";
import { setupPurchaseOrderRoutes } from "./purchase-order-test-utils";
import type { SetupResult } from "./purchase-order-test-utils";

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

/**
 * Builds all route mocks needed for the PO detail page.
 *
 * Delegates to `setupPurchaseOrderRoutes` from the shared utils, which
 * registers routes in the correct LIFO order by construction:
 *   catch-all first (lowest priority) → PO list → PO detail →
 *   line-items → receive (last = highest priority).
 *
 * This prevents the "catch-all shadows specific route" bug that occurred
 * when handlers were registered in arbitrary order.
 */
async function setupRoutes(
  page: import("@playwright/test").Page,
  lineItems: typeof MOCK_LINE_ITEM[] = [MOCK_LINE_ITEM],
): Promise<SetupResult> {
  let currentLineItems: object[] = [...lineItems];

  return setupPurchaseOrderRoutes(page, {
    poId: PO_ID,
    getPo: MOCK_PO,
    getLineItems: () => currentLineItems,
    locations: [MOCK_LOCATION],
    suppliers: [],
    onReceive: (body) => {
      const receipts = Array.isArray(body.receipts)
        ? (body.receipts as Array<{ line_item_id: number; quantity: number }>)
        : [];
      const received = receipts.map((r) => ({
        base_item_id: MOCK_LINE_ITEM.base_item_id,
        base_item_name: MOCK_LINE_ITEM.base_item_name,
        line_item_id: r.line_item_id,
        quantity_received: r.quantity,
      }));
      currentLineItems = currentLineItems.map((li) => {
        const receipt = receipts.find((r) => r.line_item_id === li.id);
        if (!receipt) return li;
        const prev = parseFloat(String(li.received_quantity ?? "0")) || 0;
        return { ...li, received_quantity: String(prev + receipt.quantity) };
      });
      return { received, location_name: MOCK_LOCATION.name };
    },
  });
}

async function gotoPurchaseOrderDetail(page: import("@playwright/test").Page) {
  // Use "domcontentloaded" instead of "networkidle": Clerk.js loads chunks from
  // the jsdelivr CDN and SSE endpoints retry constantly, so networkidle never
  // fires.  The heading assertion's 15-second timeout is enough for Clerk to
  // initialise and React to render the PO detail page.
  await page.goto(`/purchase-orders/${PO_ID}`, { waitUntil: "domcontentloaded" });
  await expect(page.getByRole("heading", { name: "PO-0042" })).toBeVisible({ timeout: 15_000 });
}

test.describe("Purchase Order Detail — Receive stock", () => {
  test("Receive stock button opens the dialog with location picker and line items", async ({ page }) => {
    await setupRoutes(page);
    await gotoPurchaseOrderDetail(page);

    await page.getByRole("button", { name: "Receive stock" }).click();

    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible({ timeout: 8_000 });
    await expect(dialog.getByRole("heading", { name: "Receive Stock" })).toBeVisible();

    await expect(dialog.locator("select")).toBeVisible({ timeout: 5_000 });
    await expect(dialog.locator("select")).toContainText("Main Warehouse");

    await expect(dialog.getByText("Red Roses")).toBeVisible();
    await expect(dialog.getByRole("button", { name: /Receive stock/i })).toBeVisible();
  });

  test("submits receive request with selected location and quantity, shows success toast", async ({ page }) => {
    const ctx = await setupRoutes(page);
    await gotoPurchaseOrderDetail(page);

    await page.getByRole("button", { name: "Receive stock" }).click();

    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible({ timeout: 8_000 });

    await dialog.locator("select").selectOption(String(MOCK_LOCATION.id));

    const qtyInput = dialog.locator('input[type="number"]');
    await qtyInput.fill("5");

    await dialog.getByRole("button", { name: /Receive stock/i }).click();

    await expect(page.getByText("Stock received", { exact: true })).toBeVisible({ timeout: 8_000 });
    // Use exact match with the trailing period to avoid strict-mode collision with
    // the accessibility live-region which concatenates the toast title + description.
    await expect(
      page.getByText("1 item added to inventory at Main Warehouse.", { exact: true }),
    ).toBeVisible({ timeout: 5_000 });

    expect(ctx.getReceivePostCount()).toBe(1);
    const body = ctx.getLastReceiveBody();
    expect(body).not.toBeNull();
    expect((body as Record<string, unknown>).location_id).toBe(MOCK_LOCATION.id);
    const receipts = (body as { receipts: Array<{ line_item_id: number; quantity: number }> }).receipts;
    expect(receipts).toHaveLength(1);
    expect(receipts[0].line_item_id).toBe(MOCK_LINE_ITEM.id);
    expect(receipts[0].quantity).toBe(5);
  });

  test("dialog closes after successful submission", async ({ page }) => {
    await setupRoutes(page);
    await gotoPurchaseOrderDetail(page);

    await page.getByRole("button", { name: "Receive stock" }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible({ timeout: 8_000 });

    await dialog.locator("select").selectOption(String(MOCK_LOCATION.id));
    await dialog.locator('input[type="number"]').fill("3");
    await dialog.getByRole("button", { name: /Receive stock/i }).click();

    await expect(dialog).not.toBeVisible({ timeout: 8_000 });
  });

  test("Received column updates after successful stock receipt", async ({ page }) => {
    await setupRoutes(page);
    await gotoPurchaseOrderDetail(page);

    const lineItemsTable = page.locator("table").first();
    // exact: true avoids matching the secondary "(Red Roses)" span shown next to the description.
    await expect(lineItemsTable.getByText("Red Roses", { exact: true })).toBeVisible({ timeout: 8_000 });

    await page.getByRole("button", { name: "Receive stock" }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible({ timeout: 8_000 });

    await dialog.locator("select").selectOption(String(MOCK_LOCATION.id));
    await dialog.locator('input[type="number"]').fill("5");
    await dialog.getByRole("button", { name: /Receive stock/i }).click();

    await expect(page.getByText("Stock received", { exact: true })).toBeVisible({ timeout: 8_000 });

    await expect(dialog).not.toBeVisible({ timeout: 8_000 });

    await expect(page.getByText("5 / 5")).toBeVisible({ timeout: 8_000 });
  });

  test("shows empty state when no line items are linked to a base item", async ({ page }) => {
    const unlinkedLineItem = { ...MOCK_LINE_ITEM, base_item_id: null, base_item_name: null };
    await setupRoutes(page, [unlinkedLineItem as typeof MOCK_LINE_ITEM]);
    await gotoPurchaseOrderDetail(page);

    await page.getByRole("button", { name: "Receive stock" }).click();

    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible({ timeout: 8_000 });

    await expect(
      dialog.getByText(/No line items are linked to a base item/i),
    ).toBeVisible({ timeout: 5_000 });

    await expect(dialog.getByRole("button", { name: /Receive stock/i })).not.toBeVisible();
  });

  test("Cancel button closes the dialog without submitting", async ({ page }) => {
    const ctx = await setupRoutes(page);
    await gotoPurchaseOrderDetail(page);

    await page.getByRole("button", { name: "Receive stock" }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible({ timeout: 8_000 });

    await dialog.getByRole("button", { name: "Cancel" }).click();

    await expect(dialog).not.toBeVisible({ timeout: 5_000 });
    expect(ctx.getReceivePostCount()).toBe(0);
  });

  test("shows validation toast when no location is selected", async ({ page }) => {
    await setupRoutes(page);
    await gotoPurchaseOrderDetail(page);

    await page.getByRole("button", { name: "Receive stock" }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible({ timeout: 8_000 });

    await dialog.locator('input[type="number"]').fill("5");
    await dialog.getByRole("button", { name: /Receive stock/i }).click();

    await expect(page.getByText("Please select a location", { exact: true })).toBeVisible({
      timeout: 5_000,
    });
  });

  test("shows validation toast when no quantity is entered", async ({ page }) => {
    await setupRoutes(page);
    await gotoPurchaseOrderDetail(page);

    await page.getByRole("button", { name: "Receive stock" }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible({ timeout: 8_000 });

    await dialog.locator("select").selectOption(String(MOCK_LOCATION.id));

    await dialog.locator('input[type="number"]').clear();

    await dialog.getByRole("button", { name: /Receive stock/i }).click();

    await expect(
      page.getByText("Enter a quantity for at least one item", { exact: true }),
    ).toBeVisible({ timeout: 5_000 });
  });

  test.describe("over-receipt flow", () => {
    test("entering a quantity that exceeds the ordered amount shows the amber warning banner and checkbox", async ({ page }) => {
      await setupRoutes(page);
      await gotoPurchaseOrderDetail(page);

      await page.getByRole("button", { name: "Receive stock" }).click();
      const dialog = page.getByRole("dialog");
      await expect(dialog).toBeVisible({ timeout: 8_000 });

      // MOCK_LINE_ITEM has quantity "5"; entering 6 triggers over-receipt
      await dialog.locator('input[type="number"]').fill("6");

      // Amber warning banner appears
      await expect(
        dialog.getByText("One item exceeds the ordered quantity", { exact: true }),
      ).toBeVisible({ timeout: 5_000 });

      // Descriptive copy is visible
      await expect(
        dialog.getByText(/Receiving more than ordered is unusual/),
      ).toBeVisible({ timeout: 3_000 });

      // Acknowledgement checkbox is visible
      await expect(
        dialog.getByRole("checkbox"),
      ).toBeVisible({ timeout: 3_000 });

      // Checkbox label text is present
      await expect(
        dialog.getByText("I understand — proceed with over-receipt", { exact: true }),
      ).toBeVisible({ timeout: 3_000 });
    });

    test("submit button stays disabled until the over-receipt checkbox is checked", async ({ page }) => {
      await setupRoutes(page);
      await gotoPurchaseOrderDetail(page);

      await page.getByRole("button", { name: "Receive stock" }).click();
      const dialog = page.getByRole("dialog");
      await expect(dialog).toBeVisible({ timeout: 8_000 });

      await dialog.locator("select").selectOption(String(MOCK_LOCATION.id));
      await dialog.locator('input[type="number"]').fill("6");

      // Warning must be visible before checking button state
      await expect(
        dialog.getByText("One item exceeds the ordered quantity", { exact: true }),
      ).toBeVisible({ timeout: 5_000 });

      const submitBtn = dialog.getByRole("button", { name: /Receive stock/i });

      // Disabled while checkbox is unchecked
      await expect(submitBtn).toBeDisabled();

      // Checking the box enables the submit button
      await dialog.getByRole("checkbox").check();
      await expect(submitBtn).toBeEnabled({ timeout: 3_000 });
    });

    test("checking the acknowledgement checkbox and submitting sends allow_over_receipt: true", async ({ page }) => {
      const ctx = await setupRoutes(page);
      await gotoPurchaseOrderDetail(page);

      await page.getByRole("button", { name: "Receive stock" }).click();
      const dialog = page.getByRole("dialog");
      await expect(dialog).toBeVisible({ timeout: 8_000 });

      await dialog.locator("select").selectOption(String(MOCK_LOCATION.id));
      await dialog.locator('input[type="number"]').fill("6");

      // Wait for warning to appear before interacting with checkbox
      await expect(
        dialog.getByText("One item exceeds the ordered quantity", { exact: true }),
      ).toBeVisible({ timeout: 5_000 });

      await dialog.getByRole("checkbox").check();
      await dialog.getByRole("button", { name: /Receive stock/i }).click();

      await expect(page.getByText("Stock received", { exact: true })).toBeVisible({ timeout: 8_000 });

      expect(ctx.getReceivePostCount()).toBe(1);
      const body = ctx.getLastReceiveBody();
      expect(body).not.toBeNull();
      expect((body as Record<string, unknown>).allow_over_receipt).toBe(true);
      const receipts = (body as { receipts: Array<{ line_item_id: number; quantity: number }> }).receipts;
      expect(receipts).toHaveLength(1);
      expect(receipts[0].quantity).toBe(6);
    });

    test("warning disappears and submit re-enables when quantity is reduced back to ordered amount", async ({ page }) => {
      await setupRoutes(page);
      await gotoPurchaseOrderDetail(page);

      await page.getByRole("button", { name: "Receive stock" }).click();
      const dialog = page.getByRole("dialog");
      await expect(dialog).toBeVisible({ timeout: 8_000 });

      await dialog.locator("select").selectOption(String(MOCK_LOCATION.id));
      const qtyInput = dialog.locator('input[type="number"]');
      await qtyInput.fill("6");

      // Warning appears
      await expect(
        dialog.getByText("One item exceeds the ordered quantity", { exact: true }),
      ).toBeVisible({ timeout: 5_000 });

      // Reduce to ordered quantity — warning should disappear
      await qtyInput.fill("5");

      await expect(
        dialog.getByText("One item exceeds the ordered quantity", { exact: true }),
      ).not.toBeVisible({ timeout: 3_000 });

      // Submit button must be enabled without needing the checkbox
      await expect(
        dialog.getByRole("button", { name: /Receive stock/i }),
      ).toBeEnabled({ timeout: 3_000 });
    });
  });
});

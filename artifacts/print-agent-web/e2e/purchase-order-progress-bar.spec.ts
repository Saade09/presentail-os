import { test, expect } from "./fixtures";
import { setupFapiWithFakeSession } from "./clerk-fapi-redirect";
import { setupCommonPurchaseOrderRoutes } from "./purchase-order-test-utils";

test.use({
  _fapiMock: [
    async ({ page }, use) => {
      await setupFapiWithFakeSession(page);
      await use();
    },
    { auto: true },
  ],
});

const MOCK_SUPPLIER = {
  id: 7,
  workspace_owner_id: "user_owner",
  name: "Alpha Supplies Ltd",
  display_name: "Alpha Supplies",
  contact_name: null,
  contact_email: null,
  contact_phone: null,
  country: null,
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

const PARTIAL_PO = {
  id: 99,
  workspace_owner_id: "user_owner",
  supplier_id: MOCK_SUPPLIER.id,
  supplier_name: MOCK_SUPPLIER.name,
  po_number: "PO-2026-099",
  po_number_label: "PO-2026-099",
  status: "partial",
  currency: "AED",
  total_amount: "300.00",
  effective_total: "300.00",
  calculated_total: "300.00",
  total_amount_manual_override: false,
  expected_delivery_date: null,
  notes: null,
  line_items_count: 3,
  received_items_count: 1,
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
  line_items: [],
};

const MOCK_LINE_ITEM = {
  id: 201,
  purchase_order_id: 99,
  description: "Widget A",
  quantity: "3",
  unit_price: "100.00",
  currency: "AED",
  received_quantity: "1",
  base_item_id: null,
  base_item_name: null,
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
};

/**
 * Registers the shared infrastructure routes for purchase-order pages.
 * Delegates to setupCommonPurchaseOrderRoutes which encodes the LIFO-safe
 * registration order: catch-all first, more-specific routes last.
 */
async function setupCommonRoutes(page: import("@playwright/test").Page) {
  await setupCommonPurchaseOrderRoutes(page, { suppliers: [MOCK_SUPPLIER] });
}

// ─── Data shared by the auto-advance describe block ──────────────────────────

const PARTIAL_PO_2ITEMS = {
  id: 100,
  workspace_owner_id: "user_owner",
  supplier_id: MOCK_SUPPLIER.id,
  supplier_name: MOCK_SUPPLIER.name,
  po_number: "PO-2026-100",
  po_number_label: "PO-2026-100",
  status: "partial",
  currency: "AED",
  total_amount: "200.00",
  effective_total: "200.00",
  total_amount_manual_override: false,
  expected_delivery_date: null,
  notes: null,
  line_items_count: 2,
  received_items_count: 1,
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
  line_items: [],
};

const RECEIVED_PO_2ITEMS = {
  ...PARTIAL_PO_2ITEMS,
  status: "received",
  received_items_count: 2,
};

// Item already received — has base_item_id so it appears in the dialog
const LINKED_ITEM_RECEIVED = {
  id: 301,
  purchase_order_id: 100,
  description: "Gadget Alpha",
  quantity: "5",
  unit_price: "50.00",
  currency: "AED",
  received_quantity: "5",
  base_item_id: 42,
  base_item_name: "Gadget Alpha",
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
};

// Item still pending — also has base_item_id so it appears in the dialog
const LINKED_ITEM_PENDING = {
  id: 302,
  purchase_order_id: 100,
  description: "Gadget Beta",
  quantity: "3",
  unit_price: "50.00",
  currency: "AED",
  received_quantity: null,
  base_item_id: 43,
  base_item_name: "Gadget Beta",
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
};

const LINKED_ITEM_PENDING_AFTER_RECEIVE = {
  ...LINKED_ITEM_PENDING,
  received_quantity: "3",
};

const MOCK_LOCATION = { id: 1, name: "Main Warehouse" };

// ─────────────────────────────────────────────────────────────────────────────

test.describe("Purchase Order progress bar — partial status", () => {
  test("progress bar and item count appear on the list page for a partial PO", async ({
    page,
  }) => {
    await setupCommonRoutes(page);

    await page.route(/\/api\/purchase-orders(\?.*)?$/, async (route) => {
      if (route.request().method() === "GET") {
        return route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ purchase_orders: [PARTIAL_PO], total: 1 }),
        });
      }
      await route.continue();
    });

    await page.goto("/purchase-orders", { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading", { name: "Purchase Orders" })).toBeVisible({ timeout: 15_000 });

    // The status badge should show "Partially Received".
    // The list page fetches suppliers, users, and purchase orders before rendering,
    // so it can take longer than the detail page — use a 15 s timeout.
    await expect(page.getByText("Partially Received").first()).toBeVisible({
      timeout: 15_000,
    });

    // The progress bar container (the outer track) should be visible
    const progressTrack = page.locator(".rounded-full.bg-muted.overflow-hidden").first();
    await expect(progressTrack).toBeVisible({ timeout: 8_000 });

    // The filled portion of the bar should be visible and yellow (partial)
    const progressFill = progressTrack.locator(".bg-yellow-400");
    await expect(progressFill).toBeVisible();

    // The "received/ordered" item count label should be visible
    // received_items_count=1, line_items_count=3 → "1/3 items"
    await expect(page.getByText("1/3 items")).toBeVisible();
  });

  test("received / ordered text and mini progress bar appear on the detail page for a partial line item", async ({
    page,
  }) => {
    await setupCommonRoutes(page);
    await setupPartialPo99Routes(page);
    await setupPoDetailSupportRoutes(page);

    await page.goto("/purchase-orders/99", { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading", { name: "PO-2026-099" })).toBeVisible({ timeout: 15_000 });

    // Page should load and show the PO number
    await expect(page.getByRole("heading", { name: "PO-2026-099" })).toBeVisible({ timeout: 8_000 });

    // The line item description should appear
    await expect(page.getByText("Widget A")).toBeVisible({ timeout: 8_000 });

    // The "received / ordered" ratio text should appear (1 / 3)
    // The component renders recStr / ordStr where recStr = "1" and ordStr = "3"
    await expect(page.getByText("1 / 3", { exact: true })).toBeVisible({ timeout: 8_000 });

    // The mini progress bar fill on the detail page should be yellow (partial).
    // bg-yellow-400 is used exclusively for the partial-receipt fill in this page.
    const detailProgressFill = page.locator(".bg-yellow-400").first();
    await expect(detailProgressFill).toBeVisible({ timeout: 8_000 });
  });
});

// ─── Cancelled PO ────────────────────────────────────────────────────────────

const CANCELLED_PO = {
  id: 101,
  workspace_owner_id: "user_owner",
  supplier_id: MOCK_SUPPLIER.id,
  supplier_name: MOCK_SUPPLIER.name,
  po_number: "PO-2026-101",
  po_number_label: "PO-2026-101",
  status: "cancelled",
  currency: "AED",
  total_amount: "150.00",
  effective_total: "150.00",
  total_amount_manual_override: false,
  expected_delivery_date: null,
  notes: null,
  line_items_count: 2,
  received_items_count: 0,
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
  line_items: [],
};

async function setupCancelledPo101Routes(
  page: import("@playwright/test").Page,
) {
  await page.route(/\/api\/purchase-orders\/101(\?.*)?$/, async (route) => {
    if (route.request().method() === "GET") {
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ purchase_order: CANCELLED_PO }),
      });
    }
    await route.continue();
  });

  await page.route(
    /\/api\/purchase-orders\/101\/line-items(\?.*)?$/,
    async (route) => {
      if (route.request().method() === "GET") {
        return route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ line_items: [] }),
        });
      }
      await route.continue();
    },
  );

  await page.route(
    /\/api\/suppliers\/\d+\/invoices(\?.*)?$/,
    async (route) => {
      if (route.request().method() === "GET") {
        return route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ invoices: [] }),
        });
      }
      await route.continue();
    },
  );

  await page.route(/\/api\/base-items(\?.*)?$/, async (route) => {
    if (route.request().method() === "GET") {
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ base_items: [] }),
      });
    }
    await route.continue();
  });
}

// ─── Shared detail-page support routes ───────────────────────────────────────

// Registers the three static "support" routes needed by every PO detail page
// that includes the Receive Stock dialog: supplier invoices, base items, and
// locations.  The stateful PO-specific routes (detail + line-items) are
// registered by the per-PO helpers below.
async function setupPoDetailSupportRoutes(page: import("@playwright/test").Page) {
  await page.route(
    /\/api\/suppliers\/\d+\/invoices(\?.*)?$/,
    async (route) => {
      if (route.request().method() === "GET") {
        return route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ invoices: [] }),
        });
      }
      await route.continue();
    },
  );

  await page.route(/\/api\/base-items(\?.*)?$/, async (route) => {
    if (route.request().method() === "GET") {
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ base_items: [] }),
      });
    }
    await route.continue();
  });

  await page.route(/\/api\/locations(\?.*)?$/, async (route) => {
    if (route.request().method() === "GET") {
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ locations: [MOCK_LOCATION] }),
      });
    }
    await route.continue();
  });
}

// Registers the PO 99 (PARTIAL_PO) detail and line-item stubs.
async function setupPartialPo99Routes(page: import("@playwright/test").Page) {
  await page.route(/\/api\/purchase-orders\/99(\?.*)?$/, async (route) => {
    if (route.request().method() === "GET") {
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ purchase_order: PARTIAL_PO }),
      });
    }
    await route.continue();
  });

  await page.route(
    /\/api\/purchase-orders\/99\/line-items(\?.*)?$/,
    async (route) => {
      if (route.request().method() === "GET") {
        return route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ line_items: [MOCK_LINE_ITEM] }),
        });
      }
      await route.continue();
    },
  );
}

// Registers the PO 102 (PARTIAL_PO_LINKED) detail and line-item stubs.
async function setupPo102Routes(page: import("@playwright/test").Page) {
  await page.route(/\/api\/purchase-orders\/102(\?.*)?$/, async (route) => {
    if (route.request().method() === "GET") {
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ purchase_order: PARTIAL_PO_LINKED }),
      });
    }
    await route.continue();
  });

  await page.route(
    /\/api\/purchase-orders\/102\/line-items(\?.*)?$/,
    async (route) => {
      if (route.request().method() === "GET") {
        return route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ line_items: [LINKED_ITEM_102] }),
        });
      }
      await route.continue();
    },
  );
}

// ─────────────────────────────────────────────────────────────────────────────

test.describe("Purchase Order detail — cancelled status", () => {
  test("status badge shows Cancelled and Receive stock button is absent", async ({
    page,
  }) => {
    await setupCommonRoutes(page);
    await setupCancelledPo101Routes(page);

    await page.goto("/purchase-orders/101", { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading", { name: "PO-2026-101" })).toBeVisible({ timeout: 15_000 });

    // The PO number should appear so we know the page loaded
    await expect(page.getByRole("heading", { name: "PO-2026-101" })).toBeVisible({ timeout: 8_000 });

    // The status badge must show "Cancelled"
    await expect(page.getByText("Cancelled").first()).toBeVisible({ timeout: 8_000 });

    // The "Receive stock" button must NOT be present in the DOM for a cancelled PO
    await expect(
      page.getByRole("button", { name: /receive stock/i }),
    ).not.toBeAttached();
  });

  test("Edit and Send to supplier buttons are absent for a cancelled PO", async ({
    page,
  }) => {
    await setupCommonRoutes(page);
    await setupCancelledPo101Routes(page);

    await page.goto("/purchase-orders/101", { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading", { name: "PO-2026-101" })).toBeVisible({ timeout: 15_000 });

    // Wait for the page to finish loading
    await expect(page.getByRole("heading", { name: "PO-2026-101" })).toBeVisible({ timeout: 8_000 });

    // The "Edit" (pencil) button must NOT be present — cancelled POs are read-only
    await expect(
      page.getByRole("button", { name: /^edit$/i }),
    ).not.toBeAttached();

    // "Send to supplier" is owner-only and explicitly gated on po.status !== "cancelled"
    await expect(
      page.getByRole("button", { name: /send to supplier/i }),
    ).not.toBeAttached();
  });

  test("header fields are truly read-only and no Cancel PO action is available for a cancelled PO", async ({
    page,
  }) => {
    await setupCommonRoutes(page);
    await setupCancelledPo101Routes(page);

    await page.goto("/purchase-orders/101", { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading", { name: "PO-2026-101" })).toBeVisible({ timeout: 15_000 });

    // Page must load and show the PO number
    await expect(page.getByRole("heading", { name: "PO-2026-101" })).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText("Cancelled").first()).toBeVisible({ timeout: 8_000 });

    // The "Order Details" card renders fields as plain text in view mode.
    // Locate the card by its heading text so assertions are scoped to it.
    const orderDetailsCard = page.locator("text=Order Details").locator("../..");

    // No <input> elements should be present inside the Order Details card — the
    // read-only view uses <span> elements only, not form controls.
    await expect(orderDetailsCard.locator("input")).toHaveCount(0);

    // No <textarea> elements either — the Notes field is a <p> tag in view mode.
    await expect(orderDetailsCard.locator("textarea")).toHaveCount(0);

    // No <select> elements — Status and Currency are displayed as badges/text.
    await expect(orderDetailsCard.locator("select")).toHaveCount(0);

    // There must be no "Cancel PO" action button anywhere on the page.
    // Cancelling an already-cancelled PO is nonsensical and must be prevented
    // at the UI level (the Edit button that would allow a status change is also absent).
    await expect(
      page.getByRole("button", { name: /cancel po/i }),
    ).not.toBeAttached();

    // The "Save changes" button that appears in edit mode must also be absent,
    // confirming the form was never activated for this cancelled PO.
    await expect(
      page.getByRole("button", { name: /save changes/i }),
    ).not.toBeAttached();
  });
});

// ─── Receive Stock dialog — no linked base items ──────────────────────────────

test.describe("Receive Stock dialog — empty state when no base items linked", () => {
  test("shows 'No line items are linked to a base item' and hides the submit button", async ({
    page,
  }) => {
    await setupCommonRoutes(page);
    await setupPartialPo99Routes(page);
    await setupPoDetailSupportRoutes(page);

    await page.goto("/purchase-orders/99", { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading", { name: "PO-2026-099" })).toBeVisible({ timeout: 15_000 });

    // Page should load and show the PO number
    await expect(page.getByRole("heading", { name: "PO-2026-099" })).toBeVisible({ timeout: 8_000 });

    // Open the Receive Stock dialog
    await page.getByRole("button", { name: /receive stock/i }).first().click();

    // The empty-state message must be visible
    await expect(
      page.getByText("No line items are linked to a base item"),
    ).toBeVisible({ timeout: 8_000 });

    // The "Receive stock" submit button inside the dialog must NOT be rendered
    // in the empty-state branch. Assert directly on the dialog scope so we are
    // not affected by the trigger button's ARIA state changing when the dialog
    // is open.
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible({ timeout: 5_000 });
    await expect(
      dialog.getByRole("button", { name: /receive stock/i }),
    ).toHaveCount(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────

test.describe("Purchase Order auto-advance — partial → received", () => {
  test("status badge turns 'Received' and progress bar turns green after receiving the last item", async ({
    page,
  }) => {
    await setupCommonRoutes(page);

    // Track whether the receive mutation has been submitted so the PO
    // detail route can return the updated "received" status on re-fetch.
    let receivedPosted = false;

    // PO detail: return partial initially, received after the mutation fires
    await page.route(/\/api\/purchase-orders\/100(\?.*)?$/, async (route) => {
      if (route.request().method() === "GET") {
        const po = receivedPosted ? RECEIVED_PO_2ITEMS : PARTIAL_PO_2ITEMS;
        return route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ purchase_order: po }),
        });
      }
      await route.continue();
    });

    // Line items: return both items (one received, one pending initially;
    // both fully received after the mutation fires)
    await page.route(
      /\/api\/purchase-orders\/100\/line-items(\?.*)?$/,
      async (route) => {
        if (route.request().method() === "GET") {
          const pendingItem = receivedPosted
            ? LINKED_ITEM_PENDING_AFTER_RECEIVE
            : LINKED_ITEM_PENDING;
          return route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify({
              line_items: [LINKED_ITEM_RECEIVED, pendingItem],
            }),
          });
        }
        await route.continue();
      },
    );

    // Receive stock endpoint
    await page.route(
      /\/api\/purchase-orders\/100\/receive(\?.*)?$/,
      async (route) => {
        if (route.request().method() === "POST") {
          receivedPosted = true;
          return route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify({
              received: [{ line_item_id: LINKED_ITEM_PENDING.id, quantity_received: 3 }],
              location_name: MOCK_LOCATION.name,
            }),
          });
        }
        await route.continue();
      },
    );

    await setupPoDetailSupportRoutes(page);

    await page.goto("/purchase-orders/100", { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading", { name: "PO-2026-100" })).toBeVisible({ timeout: 15_000 });

    // Page should load with the partial status badge
    await expect(page.getByRole("heading", { name: "PO-2026-100" })).toBeVisible({ timeout: 8_000 });
    await expect(page.getByText("Partially Received").first()).toBeVisible({
      timeout: 8_000,
    });

    // Progress bar fill should be yellow before receiving
    const progressFillBefore = page.locator(".bg-yellow-400").first();
    await expect(progressFillBefore).toBeVisible({ timeout: 8_000 });

    // Open the Receive Stock dialog
    await page.getByRole("button", { name: /receive stock/i }).first().click();

    // Wait for the dialog to appear and the location select to be ready
    await expect(page.getByText("Destination location")).toBeVisible({
      timeout: 8_000,
    });

    // Select the warehouse location
    await page.selectOption("select", { label: MOCK_LOCATION.name });

    // Fill in the quantity for "Gadget Beta" (the pending item).
    // remaining = quantity − already received = 3 − 0 = 3.
    // The component shows this as a placeholder suggestion, not a pre-filled value,
    // so we fill it in explicitly before submitting.
    const qtyInput = page.locator("input[type='number']").last();
    await qtyInput.fill("3");

    // Submit
    await page.getByRole("button", { name: /receive stock/i }).last().click();

    // After the mutation succeeds the dialog closes and queries are re-fetched.
    // The status badge should now show "Received".
    await expect(page.getByText("Received").first()).toBeVisible({ timeout: 8_000 });

    // The status badge should NOT still show "Partially Received"
    await expect(page.getByText("Partially Received").first()).not.toBeVisible();

    // All line items are now fully received — the progress bar fill should be green
    const progressFillAfter = page.locator(".bg-green-500").first();
    await expect(progressFillAfter).toBeVisible({ timeout: 8_000 });
  });
});

// ─── Receive Stock dialog — location guard ────────────────────────────────────

const PARTIAL_PO_LINKED = {
  id: 102,
  workspace_owner_id: "user_owner",
  supplier_id: MOCK_SUPPLIER.id,
  supplier_name: MOCK_SUPPLIER.name,
  po_number: "PO-2026-102",
  po_number_label: "PO-2026-102",
  status: "partial",
  currency: "AED",
  total_amount: "150.00",
  effective_total: "150.00",
  total_amount_manual_override: false,
  expected_delivery_date: null,
  notes: null,
  line_items_count: 1,
  received_items_count: 0,
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
  line_items: [],
};

// Has base_item_id so it appears as a linked item inside the dialog
const LINKED_ITEM_102 = {
  id: 401,
  purchase_order_id: 102,
  description: "Widget Linked",
  quantity: "5",
  unit_price: "30.00",
  currency: "AED",
  received_quantity: null,
  base_item_id: 55,
  base_item_name: "Widget Linked",
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
};

test.describe("Receive Stock dialog — location guard", () => {
  test("submit is blocked by a missing location and unblocked after one is selected", async ({
    page,
  }) => {
    await setupCommonRoutes(page);
    await setupPoDetailSupportRoutes(page);
    await setupPo102Routes(page);

    // Track whether the receive API was called (it must NOT be called without a location)
    let receiveCalled = false;
    await page.route(
      /\/api\/purchase-orders\/102\/receive(\?.*)?$/,
      async (route) => {
        receiveCalled = true;
        await route.continue();
      },
    );

    await page.goto("/purchase-orders/102", { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading", { name: "PO-2026-102" })).toBeVisible({ timeout: 15_000 });

    await expect(page.getByRole("heading", { name: "PO-2026-102" })).toBeVisible({ timeout: 15_000 });

    // Open the Receive Stock dialog
    await page.getByRole("button", { name: /receive stock/i }).first().click();

    // The dialog should show the linked item and the submit button
    await expect(page.getByText("Destination location")).toBeVisible({
      timeout: 8_000,
    });
    await expect(page.getByText("Widget Linked").first()).toBeVisible({ timeout: 8_000 });

    // The submit button must be present (linked items exist)
    const submitBtn = page.getByRole("button", { name: /receive stock/i }).last();
    await expect(submitBtn).toBeVisible({ timeout: 8_000 });

    // ── Guard: no location selected ─────────────────────────────────────────
    // The location select shows the placeholder "Select a location…" — value is ""
    const locationSelect = page.locator("select");
    await expect(locationSelect).toHaveValue("");

    // Click submit without a location — the handler returns early and shows a toast
    await submitBtn.click();

    // A toast with "Please select a location" must appear
    await expect(
      page.getByText("Please select a location", { exact: true }),
    ).toBeVisible({ timeout: 6_000 });

    // The receive API endpoint must NOT have been called
    expect(receiveCalled).toBe(false);

    // ── Unblocked: select a location ────────────────────────────────────────
    await page.selectOption("select", { label: MOCK_LOCATION.name });
    await expect(locationSelect).toHaveValue(String(MOCK_LOCATION.id));

    // After selecting a location the submit button must still be present and enabled
    await expect(submitBtn).toBeVisible();
    await expect(submitBtn).toBeEnabled();

    // The "Please select a location" toast must be gone (dismissed or superseded)
    await expect(
      page.getByText("Please select a location", { exact: true }),
    ).not.toBeVisible({ timeout: 6_000 });
  });
});

// ─── Base item link in PO line items ─────────────────────────────────────────

test.describe("Purchase Order detail — base item link in line items", () => {
  test("no base item link appears when the line item has no linked base item", async ({
    page,
  }) => {
    await setupCommonRoutes(page);
    await setupPoDetailSupportRoutes(page);
    await setupPartialPo99Routes(page);

    await page.goto("/purchase-orders/99", { waitUntil: "domcontentloaded" });
    await expect(
      page.getByRole("heading", { name: "PO-2026-099" }),
    ).toBeVisible({ timeout: 15_000 });

    // The line item description should appear (MOCK_LINE_ITEM.description)
    await expect(page.getByText("Widget A")).toBeVisible({ timeout: 8_000 });

    // There must be no anchor element whose accessible name looks like "(…)"
    // — the base item link is always rendered as "(base_item_name)".
    // When base_item_id is null, the conditional branch is skipped entirely.
    await expect(page.getByRole("link", { name: /^\(.*\)$/ })).not.toBeAttached();
  });

  test("clicking the base item link navigates to the base item inventory tab", async ({
    page,
  }) => {
    await setupCommonRoutes(page);
    await setupPoDetailSupportRoutes(page);
    await setupPo102Routes(page);

    // Stub the base item detail API so the destination page does not error
    await page.route(/\/api\/base-items\/55(\?.*)?$/, async (route) => {
      if (route.request().method() === "GET") {
        return route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            base_item: {
              id: 55,
              workspace_owner_id: "user_owner",
              name: "Widget Linked",
              code: "WL-055",
              status: "active",
              image_url: null,
              alternate_name: null,
              accounting_category: null,
              tax_rate: null,
              created_at: new Date().toISOString(),
              updated_at: new Date().toISOString(),
            },
          }),
        });
      }
      await route.continue();
    });

    await page.goto("/purchase-orders/102", { waitUntil: "domcontentloaded" });
    await expect(
      page.getByRole("heading", { name: "PO-2026-102" }),
    ).toBeVisible({ timeout: 15_000 });

    // The line item description ("Widget Linked") should be visible
    await expect(page.getByText("Widget Linked").first()).toBeVisible({
      timeout: 8_000,
    });

    // The base item link is rendered as "(Widget Linked)" next to the description
    const baseItemLink = page.getByRole("link", { name: "(Widget Linked)" });
    await expect(baseItemLink).toBeVisible({ timeout: 8_000 });

    // Clicking the link should navigate to the base item detail inventory tab
    await baseItemLink.click();

    await page.waitForURL(/\/dashboard\/base-items\/55/, { timeout: 8_000 });
    expect(page.url()).toContain("/dashboard/base-items/55");
    expect(page.url()).toContain("tab=inventory");
  });
});

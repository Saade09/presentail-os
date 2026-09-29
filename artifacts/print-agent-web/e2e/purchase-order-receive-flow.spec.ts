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
const PO_ID = 150;

const MOCK_LOCATION = { id: 8, name: "Central Warehouse" };

// A PO with 1 of 2 items already received → status "partial"
const PARTIAL_PO = {
  id: PO_ID,
  workspace_owner_id: "user_owner",
  supplier_id: 12,
  supplier_name: "Beta Supplies",
  po_number: "PO-2026-150",
  po_number_label: "PO-2026-150",
  status: "partial",
  currency: "AED",
  total_amount: "400.00",
  effective_total: "400.00",
  total_amount_manual_override: false,
  expected_delivery_date: null,
  notes: null,
  line_items_count: 2,
  received_items_count: 1,
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
  line_items: [],
};

// Same PO after receiving the remaining item
const RECEIVED_PO = {
  ...PARTIAL_PO,
  status: "received",
  received_items_count: 2,
};

// A PO in "confirmed" status with zero receipts — unstarted receive flow
const CONFIRMED_PO = {
  ...PARTIAL_PO,
  status: "confirmed",
  received_items_count: 0,
};

// Already-received item (has base_item_id so it shows up in the dialog)
const LINE_ITEM_DONE = {
  id: 501,
  purchase_order_id: PO_ID,
  description: "Canvas Bag",
  quantity: "4",
  unit_price: "50.00",
  currency: "AED",
  received_quantity: "4",
  base_item_id: 71,
  base_item_name: "Canvas Bag",
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
};

// Pending item (has base_item_id so it appears in the receive dialog)
const LINE_ITEM_PENDING = {
  id: 502,
  purchase_order_id: PO_ID,
  description: "Paper Wrap",
  quantity: "6",
  unit_price: "16.67",
  currency: "AED",
  received_quantity: null,
  base_item_id: 72,
  base_item_name: "Paper Wrap",
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
};

const LINE_ITEM_PENDING_AFTER_RECEIVE = {
  ...LINE_ITEM_PENDING,
  received_quantity: "6",
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
  let receivePosted = false;

  // Catch-all fallback (lowest priority — registered first in LIFO order)
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
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(ownerUsersResponse()),
      });
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

  await page.route(/\/api\/suppliers\/\d+\/invoices(\?.*)?$/, async (route) => {
    if (route.request().method() === "GET") {
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ invoices: [] }),
      });
    }
    await route.continue();
  });

  // PO list catch-all
  await page.route(/\/api\/purchase-orders(\?.*)?$/, async (route) => {
    if (route.request().method() === "GET") {
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ purchase_orders: [], total: 0 }),
      });
    }
    await route.continue();
  });

  // Receive sub-route (registered before PO detail so it wins via LIFO)
  await page.route(
    /\/api\/purchase-orders\/150\/receive(\?.*)?$/,
    async (route) => {
      if (route.request().method() === "POST") {
        receivePosted = true;
        return route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            received: [
              {
                base_item_id: LINE_ITEM_PENDING.base_item_id,
                base_item_name: LINE_ITEM_PENDING.base_item_name,
                line_item_id: LINE_ITEM_PENDING.id,
                quantity_received: 6,
              },
            ],
            location_name: MOCK_LOCATION.name,
          }),
        });
      }
      await route.continue();
    },
  );

  // Line-items sub-route — returns updated items after receive
  await page.route(
    /\/api\/purchase-orders\/150\/line-items(\?.*)?$/,
    async (route) => {
      if (route.request().method() === "GET") {
        const pendingItem = receivePosted
          ? LINE_ITEM_PENDING_AFTER_RECEIVE
          : LINE_ITEM_PENDING;
        return route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            line_items: [LINE_ITEM_DONE, pendingItem],
            calculated_total: "400.00",
          }),
        });
      }
      await route.continue();
    },
  );

  // PO detail — returns updated PO after receive (registered last → highest priority)
  await page.route(/\/api\/purchase-orders\/150(\?.*)?$/, async (route) => {
    if (route.request().method() === "GET") {
      const po = receivePosted ? RECEIVED_PO : PARTIAL_PO;
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ purchase_order: po }),
      });
    }
    await route.continue();
  });
}

async function gotoPurchaseOrderDetail(page: import("@playwright/test").Page) {
  // Use "domcontentloaded" instead of "networkidle": Clerk.js loads chunks from
  // the jsdelivr CDN and SSE endpoints retry constantly, so networkidle never
  // fires.  The heading assertion's 15-second timeout is enough for Clerk to
  // initialise and React to render the PO detail page.
  await page.goto(`/purchase-orders/${PO_ID}`, { waitUntil: "domcontentloaded" });
  await expect(page.getByRole("heading", { name: "PO-2026-150" })).toBeVisible({
    timeout: 15_000,
  });
}

test.describe("Purchase Order receive flow — header progress bar", () => {
  test("header shows correct item count and yellow bar for a partial PO", async ({ page }) => {
    await setupRoutes(page);
    await gotoPurchaseOrderDetail(page);

    // The status badge must read "Partially Received" — use .first() because the badge
    // may appear both in the PO header and in individual line item rows.
    await expect(page.getByText("Partially Received").first()).toBeVisible({ timeout: 8_000 });

    // The header renders "{received_items_count} / {line_items_count} items received"
    // For this PO: 1 / 2 items received
    await expect(page.getByText("1 / 2 items received")).toBeVisible({ timeout: 8_000 });

    // The progress bar fill must be yellow (partial)
    const progressFill = page.locator(".bg-yellow-400").first();
    await expect(progressFill).toBeVisible({ timeout: 8_000 });
  });

  test("header item count and bar color update after receiving remaining stock", async ({ page }) => {
    await setupRoutes(page);
    await gotoPurchaseOrderDetail(page);

    // Confirm partial state before receiving — use .first() because the badge may
    // appear in both the PO header and individual line item rows.
    await expect(page.getByText("Partially Received").first()).toBeVisible({ timeout: 8_000 });
    await expect(page.getByText("1 / 2 items received")).toBeVisible({ timeout: 8_000 });
    await expect(page.locator(".bg-yellow-400").first()).toBeVisible({ timeout: 8_000 });

    // Open the Receive Stock dialog
    await page.getByRole("button", { name: /receive stock/i }).first().click();

    // Wait for the dialog and location picker
    await expect(page.getByText("Destination location")).toBeVisible({ timeout: 8_000 });

    // Select the warehouse location
    await page.selectOption("select", { label: MOCK_LOCATION.name });

    // Fill in the quantity for the pending line item (Paper Wrap — 6 units outstanding)
    const qtyInput = page.locator("input[type='number']").last();
    await qtyInput.fill("6");

    // Submit the receive
    await page.getByRole("button", { name: /receive stock/i }).last().click();

    // Success toast must appear
    await expect(page.getByText("Stock received", { exact: true })).toBeVisible({
      timeout: 8_000,
    });

    // Dialog must close
    await expect(page.getByRole("dialog")).not.toBeVisible({ timeout: 8_000 });

    // Status badge must now show "Received" — target the badge span directly
    // to avoid strict-mode collisions with the "Received Items" section heading
    // and the "items received" counter text.
    await expect(page.locator("span.bg-green-100").first()).toBeVisible({ timeout: 8_000 });

    // "Partially Received" badges must be gone entirely
    await expect(page.getByText("Partially Received")).toHaveCount(0, { timeout: 8_000 });

    // Header item count must update to 2 / 2 items received
    await expect(page.getByText("2 / 2 items received")).toBeVisible({ timeout: 8_000 });

    // Progress bar fill must be green (fully received)
    const greenFill = page.locator(".bg-green-500").first();
    await expect(greenFill).toBeVisible({ timeout: 8_000 });
  });

  test("header progress bar is shown green with full count for a fully received PO opened directly", async ({
    page,
  }) => {
    // Mount the PO already in "received" status from the start
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
        return route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify(ownerUsersResponse()),
        });
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

    await page.route(/\/api\/purchase-orders\/150\/line-items(\?.*)?$/, async (route) => {
      if (route.request().method() === "GET") {
        return route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            line_items: [LINE_ITEM_DONE, LINE_ITEM_PENDING_AFTER_RECEIVE],
            calculated_total: "400.00",
          }),
        });
      }
      await route.continue();
    });

    await page.route(/\/api\/suppliers\/\d+\/invoices(\?.*)?$/, async (route) => {
      if (route.request().method() === "GET") {
        return route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ invoices: [] }),
        });
      }
      await route.continue();
    });

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

    await page.route(/\/api\/purchase-orders\/150(\?.*)?$/, async (route) => {
      if (route.request().method() === "GET") {
        return route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ purchase_order: RECEIVED_PO }),
        });
      }
      await route.continue();
    });

    await page.goto(`/purchase-orders/${PO_ID}`, { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading", { name: "PO-2026-150" })).toBeVisible({
      timeout: 15_000,
    });

    // Status badge must show "Received" — target the badge span directly to
    // avoid strict-mode collisions with "Received Items" and "items received".
    await expect(page.locator("span.bg-green-100").first()).toBeVisible({ timeout: 8_000 });

    // The header still renders the progress section for "received" status
    // (condition: status === "partial" || status === "received")
    // All 2 items received → text reads "2 / 2 items received"
    await expect(page.getByText("2 / 2 items received")).toBeVisible({ timeout: 8_000 });

    // Bar fill must be green (received_items_count >= line_items_count)
    const greenFill = page.locator(".bg-green-500").first();
    await expect(greenFill).toBeVisible({ timeout: 8_000 });
  });

  test("header progress bar is absent for a confirmed PO with zero receipts", async ({ page }) => {
    // Mount the PO in "confirmed" status with no received items
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
        return route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify(ownerUsersResponse()),
        });
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

    await page.route(/\/api\/purchase-orders\/150\/line-items(\?.*)?$/, async (route) => {
      if (route.request().method() === "GET") {
        return route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            line_items: [LINE_ITEM_PENDING, LINE_ITEM_DONE],
            calculated_total: "400.00",
          }),
        });
      }
      await route.continue();
    });

    await page.route(/\/api\/suppliers\/\d+\/invoices(\?.*)?$/, async (route) => {
      if (route.request().method() === "GET") {
        return route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ invoices: [] }),
        });
      }
      await route.continue();
    });

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

    await page.route(/\/api\/purchase-orders\/150(\?.*)?$/, async (route) => {
      if (route.request().method() === "GET") {
        return route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ purchase_order: CONFIRMED_PO }),
        });
      }
      await route.continue();
    });

    await page.goto(`/purchase-orders/${PO_ID}`, { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading", { name: "PO-2026-150" })).toBeVisible({
      timeout: 15_000,
    });

    // Status badge must show "Confirmed"
    await expect(page.getByText("Confirmed").first()).toBeVisible({ timeout: 8_000 });

    // The progress bar and item count must NOT be present for "confirmed" status
    await expect(page.getByText(/\d+ \/ \d+ items received/)).toHaveCount(0, { timeout: 8_000 });
    // The progress bar container (w-40 h-2 rounded-full bg-muted) must not be rendered
    const progressBarContainer = page.locator(".w-40.h-2.rounded-full.bg-muted");
    await expect(progressBarContainer).toHaveCount(0, { timeout: 8_000 });

    // The "Receive stock" button should still be visible so owners can start receiving
    await expect(page.getByRole("button", { name: /receive stock/i })).toBeVisible({ timeout: 8_000 });
  });
});

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

const PO_ID = 42;
const SUPPLIER_ID = 7;
const LINE_ITEM_ID = 501;
const CREATED_LINE_ITEM_ID = 502;

const MOCK_PO = {
  id: PO_ID,
  workspace_owner_id: "user_owner",
  supplier_id: SUPPLIER_ID,
  supplier_name: "Beta Materials Co",
  po_number: "PO-2026-042",
  po_number_label: "PO-2026-042",
  status: "draft",
  currency: "AED",
  total_amount: "120.00",
  effective_total: "120.00",
  total_amount_manual_override: false,
  expected_delivery_date: null,
  notes: null,
  line_items_count: 1,
  received_items_count: 0,
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
  line_items: [],
};

const INITIAL_LINE_ITEM = {
  id: LINE_ITEM_ID,
  purchase_order_id: PO_ID,
  description: "Plain Wrap",
  quantity: "4",
  unit_price: "30.00",
  currency: "AED",
  received_quantity: null,
  base_item_id: null,
  base_item_name: null,
  supplier_catalog_item_id: null,
  supplier_item_code: null,
  supplier_item_unit: null,
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
};

const CATALOG_ITEM = {
  id: 101,
  name: "Premium Canvas",
  price: "25.50",
  currency: "AED",
  unit: "pcs",
  supplier_item_code: "SKU-101",
  base_item_id: null,
  active: true,
};

const UPDATED_LINE_ITEM = {
  ...INITIAL_LINE_ITEM,
  description: "Premium Canvas",
  unit_price: "25.50",
  supplier_catalog_item_id: CATALOG_ITEM.id,
};

const PRESET_LINE_ITEM = {
  ...INITIAL_LINE_ITEM,
  description: "Premium Canvas",
  unit_price: "25.50",
  supplier_catalog_item_id: CATALOG_ITEM.id,
};

const CLEARED_LINE_ITEM = {
  ...PRESET_LINE_ITEM,
  supplier_catalog_item_id: null,
};

async function setupRoutes(page: import("@playwright/test").Page) {
  let patchBody: Record<string, unknown> | null = null;
  let lineItemsVersion = 0;

  // ── Catch-all: registered FIRST (lowest LIFO priority) ──────────────────────
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
        body: JSON.stringify({
          members: [
            {
              id: 1,
              email: "e2e-tester@presentail.com",
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
            email: "e2e-tester@presentail.com",
            allowedPages: null,
            customRoleId: null,
          },
        }),
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

  await page.route(/\/api\/suppliers(\?.*)?$/, async (route) => {
    if (route.request().method() === "GET") {
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ suppliers: [] }),
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

  // ── PO list ─────────────────────────────────────────────────────────────────
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

  // ── Supplier catalog items ───────────────────────────────────────────────────
  await page.route(
    new RegExp(`\\/api\\/suppliers\\/${SUPPLIER_ID}\\/catalog-items(\\?.*)?$`),
    async (route) => {
      if (route.request().method() === "GET") {
        return route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ catalog_items: [CATALOG_ITEM] }),
        });
      }
      await route.continue();
    },
  );

  // ── Line-item PATCH (update) — registered before line-items GET so it wins ──
  await page.route(
    new RegExp(
      `\\/api\\/purchase-orders\\/${PO_ID}\\/line-items\\/${LINE_ITEM_ID}(\\?.*)?$`,
    ),
    async (route) => {
      if (route.request().method() === "PATCH") {
        patchBody = JSON.parse(
          route.request().postData() ?? "{}",
        ) as Record<string, unknown>;
        lineItemsVersion = 1;
        return route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ line_item: UPDATED_LINE_ITEM }),
        });
      }
      await route.continue();
    },
  );

  // ── Line-items GET — returns updated item after PATCH ────────────────────────
  await page.route(
    new RegExp(`\\/api\\/purchase-orders\\/${PO_ID}\\/line-items(\\?.*)?$`),
    async (route) => {
      if (route.request().method() === "GET") {
        const item = lineItemsVersion === 0 ? INITIAL_LINE_ITEM : UPDATED_LINE_ITEM;
        return route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            line_items: [item],
            calculated_total: lineItemsVersion === 0 ? "120.00" : "102.00",
          }),
        });
      }
      await route.continue();
    },
  );

  // ── PO detail — registered last (highest LIFO priority) ─────────────────────
  await page.route(
    new RegExp(`\\/api\\/purchase-orders\\/${PO_ID}(\\?.*)?$`),
    async (route) => {
      if (route.request().method() === "GET") {
        return route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ purchase_order: MOCK_PO }),
        });
      }
      await route.continue();
    },
  );

  return {
    getPatchBody: () => patchBody,
  };
}

const MOCK_PO_EMPTY = {
  ...MOCK_PO,
  line_items_count: 0,
  total_amount: "0.00",
  effective_total: "0.00",
};

const CREATED_LINE_ITEM = {
  id: CREATED_LINE_ITEM_ID,
  purchase_order_id: PO_ID,
  description: "Premium Canvas",
  quantity: "1",
  unit_price: "25.50",
  currency: "AED",
  received_quantity: null,
  base_item_id: null,
  supplier_catalog_item_id: CATALOG_ITEM.id,
  supplier_item_code: null,
  supplier_item_unit: null,
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
};

async function setupAddRoutes(page: import("@playwright/test").Page) {
  let postBody: Record<string, unknown> | null = null;
  let lineItemsCreated = false;

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
        body: JSON.stringify({
          members: [
            {
              id: 1,
              email: "e2e-tester@presentail.com",
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
            email: "e2e-tester@presentail.com",
            allowedPages: null,
            customRoleId: null,
          },
        }),
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

  await page.route(/\/api\/suppliers(\?.*)?$/, async (route) => {
    if (route.request().method() === "GET") {
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ suppliers: [] }),
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

  await page.route(
    new RegExp(`\\/api\\/suppliers\\/${SUPPLIER_ID}\\/catalog-items(\\?.*)?$`),
    async (route) => {
      if (route.request().method() === "GET") {
        return route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ catalog_items: [CATALOG_ITEM] }),
        });
      }
      await route.continue();
    },
  );

  // ── Line-item POST (create) ───────────────────────────────────────────────
  await page.route(
    new RegExp(`\\/api\\/purchase-orders\\/${PO_ID}\\/line-items(\\?.*)?$`),
    async (route) => {
      if (route.request().method() === "POST") {
        postBody = JSON.parse(
          route.request().postData() ?? "{}",
        ) as Record<string, unknown>;
        lineItemsCreated = true;
        return route.fulfill({
          status: 201,
          contentType: "application/json",
          body: JSON.stringify({ line_item: CREATED_LINE_ITEM }),
        });
      }
      if (route.request().method() === "GET") {
        return route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            line_items: lineItemsCreated ? [CREATED_LINE_ITEM] : [],
            calculated_total: lineItemsCreated ? "25.50" : "0.00",
          }),
        });
      }
      await route.continue();
    },
  );

  // ── PO detail ─────────────────────────────────────────────────────────────
  await page.route(
    new RegExp(`\\/api\\/purchase-orders\\/${PO_ID}(\\?.*)?$`),
    async (route) => {
      if (route.request().method() === "GET") {
        return route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ purchase_order: MOCK_PO_EMPTY }),
        });
      }
      await route.continue();
    },
  );

  return {
    getPostBody: () => postBody,
  };
}

async function setupClearRoutes(page: import("@playwright/test").Page) {
  let patchBody: Record<string, unknown> | null = null;
  let lineItemsVersion = 0;

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
        body: JSON.stringify({
          members: [
            {
              id: 1,
              email: "e2e-tester@presentail.com",
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
            email: "e2e-tester@presentail.com",
            allowedPages: null,
            customRoleId: null,
          },
        }),
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

  await page.route(/\/api\/suppliers(\?.*)?$/, async (route) => {
    if (route.request().method() === "GET") {
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ suppliers: [] }),
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

  await page.route(
    new RegExp(`\\/api\\/suppliers\\/${SUPPLIER_ID}\\/catalog-items(\\?.*)?$`),
    async (route) => {
      if (route.request().method() === "GET") {
        return route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ catalog_items: [CATALOG_ITEM] }),
        });
      }
      await route.continue();
    },
  );

  await page.route(
    new RegExp(
      `\\/api\\/purchase-orders\\/${PO_ID}\\/line-items\\/${LINE_ITEM_ID}(\\?.*)?$`,
    ),
    async (route) => {
      if (route.request().method() === "PATCH") {
        patchBody = JSON.parse(
          route.request().postData() ?? "{}",
        ) as Record<string, unknown>;
        lineItemsVersion = 1;
        return route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ line_item: CLEARED_LINE_ITEM }),
        });
      }
      await route.continue();
    },
  );

  await page.route(
    new RegExp(`\\/api\\/purchase-orders\\/${PO_ID}\\/line-items(\\?.*)?$`),
    async (route) => {
      if (route.request().method() === "GET") {
        const item = lineItemsVersion === 0 ? PRESET_LINE_ITEM : CLEARED_LINE_ITEM;
        return route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            line_items: [item],
            calculated_total: "102.00",
          }),
        });
      }
      await route.continue();
    },
  );

  await page.route(
    new RegExp(`\\/api\\/purchase-orders\\/${PO_ID}(\\?.*)?$`),
    async (route) => {
      if (route.request().method() === "GET") {
        return route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ purchase_order: MOCK_PO }),
        });
      }
      await route.continue();
    },
  );

  return {
    getPatchBody: () => patchBody,
  };
}

test.describe("PO line item edit — catalog item combobox", () => {
  test("selecting a catalog item pre-fills description and unit_price, and saving sends supplier_catalog_item_id", async ({
    page,
  }) => {
    const { getPatchBody } = await setupRoutes(page);

    await page.goto(`/purchase-orders/${PO_ID}`, {
      waitUntil: "domcontentloaded",
    });
    await expect(
      page.getByRole("heading", { name: "PO-2026-042" }),
    ).toBeVisible({ timeout: 15_000 });

    // Wait for line items to load — the initial description must appear in the table
    await expect(page.getByText("Plain Wrap")).toBeVisible({ timeout: 8_000 });

    // Hover the display row so the hidden action buttons become visible
    const displayRow = page
      .locator("tbody tr")
      .filter({ hasText: "Plain Wrap" })
      .first();
    await displayRow.hover();

    // Click the pencil (edit) button — it is the first button in the last cell of
    // the display row (Pencil first, Trash second inside the opacity-0 div)
    await displayRow.locator("td").last().locator("button").first().click();

    // ── Edit row is now active ────────────────────────────────────────────────
    // Scope all further locators to the edit row, identified by the presence of
    // the description text input (unique to the inline edit form)
    const editRow = page
      .locator("tbody tr")
      .filter({ has: page.locator('input[placeholder="Description"]') });

    // The CatalogItemCombobox trigger shows "Pick from catalog…" when no item is
    // selected — it is the first button[role="combobox"] inside the edit row
    const catalogTrigger = editRow
      .locator('button[role="combobox"]')
      .filter({ hasText: "Pick from catalog" });
    await expect(catalogTrigger).toBeVisible({ timeout: 5_000 });

    // Open the catalog popover
    await catalogTrigger.click();

    // The popover renders a CommandItem with the catalog item name
    await expect(page.getByRole("option", { name: "Premium Canvas" })).toBeVisible({
      timeout: 5_000,
    });

    // Select the catalog item
    await page.getByRole("option", { name: "Premium Canvas" }).click();

    // After selection the popover closes and the edit row state updates:
    // description input should be pre-filled with the item name
    const descriptionInput = editRow.locator('input[placeholder="Description"]');
    await expect(descriptionInput).toHaveValue("Premium Canvas", {
      timeout: 3_000,
    });

    // The unit_price input (type=number) in the edit row should show the catalog
    // item price. The edit row has three number inputs: qty (index 0), unit_price
    // (index 1), received_qty (index 2).
    const unitPriceInput = editRow.locator('input[type="number"]').nth(1);
    await expect(unitPriceInput).toHaveValue("25.50", { timeout: 3_000 });

    // Click the save (Check ✓) button — the last button in the edit row's action cell
    const saveBtn = editRow.locator("td").last().locator("button").last();
    await saveBtn.click();

    // Verify the PATCH was sent with the correct fields
    await expect.poll(() => getPatchBody(), { timeout: 5_000 }).toMatchObject({
      supplier_catalog_item_id: CATALOG_ITEM.id,
      description: "Premium Canvas",
      unit_price: "25.50",
    });

    // After the mutation succeeds the line items are refetched; the table should
    // now show the updated description "Premium Canvas"
    await expect(page.getByText("Premium Canvas")).toBeVisible({
      timeout: 8_000,
    });
  });

  test("clearing a previously-set catalog item resets the combobox and saves supplier_catalog_item_id: null", async ({
    page,
  }) => {
    const { getPatchBody } = await setupClearRoutes(page);

    await page.goto(`/purchase-orders/${PO_ID}`, {
      waitUntil: "domcontentloaded",
    });
    await expect(
      page.getByRole("heading", { name: "PO-2026-042" }),
    ).toBeVisible({ timeout: 15_000 });

    // Wait for line items to load — the preset item description must appear
    await expect(page.getByText("Premium Canvas")).toBeVisible({ timeout: 8_000 });

    // Hover the display row so the hidden action buttons become visible
    const displayRow = page
      .locator("tbody tr")
      .filter({ hasText: "Premium Canvas" })
      .first();
    await displayRow.hover();

    // Click the pencil (edit) button
    await displayRow.locator("td").last().locator("button").first().click();

    // ── Edit row is now active ────────────────────────────────────────────────
    const editRow = page
      .locator("tbody tr")
      .filter({ has: page.locator('input[placeholder="Description"]') });

    // The CatalogItemCombobox trigger should show the existing catalog item name
    // because supplier_catalog_item_id is already set and the item appears in the
    // fetched catalog list
    const catalogTrigger = editRow
      .locator('button[role="combobox"]')
      .filter({ hasText: "Premium Canvas" });
    await expect(catalogTrigger).toBeVisible({ timeout: 5_000 });

    // Open the catalog popover
    await catalogTrigger.click();

    // The "— Clear —" option is rendered only when a value is set
    await expect(page.getByRole("option", { name: "— Clear —" })).toBeVisible({
      timeout: 5_000,
    });

    // Click "— Clear —" to null the supplier_catalog_item_id
    await page.getByRole("option", { name: "— Clear —" }).click();

    // After clearing, the combobox trigger reverts to the placeholder text
    const clearedTrigger = editRow
      .locator('button[role="combobox"]')
      .filter({ hasText: "Pick from catalog" });
    await expect(clearedTrigger).toBeVisible({ timeout: 3_000 });

    // Click the save (Check ✓) button — the last button in the edit row's action cell
    const saveBtn = editRow.locator("td").last().locator("button").last();
    await saveBtn.click();

    // Verify the PATCH body carries supplier_catalog_item_id: null
    await expect
      .poll(() => getPatchBody(), { timeout: 5_000 })
      .toMatchObject({ supplier_catalog_item_id: null });

    // After the mutation the refetched line items still show the description but
    // the cleared row is returned without a catalog item link
    await expect(page.getByText("Premium Canvas")).toBeVisible({
      timeout: 8_000,
    });
  });
});

test.describe("PO line item add — catalog item combobox", () => {
  test("selecting a catalog item in the add row pre-fills description and unit_price, and saving sends supplier_catalog_item_id in the POST", async ({
    page,
  }) => {
    const { getPostBody } = await setupAddRoutes(page);

    await page.goto(`/purchase-orders/${PO_ID}`, {
      waitUntil: "domcontentloaded",
    });
    await expect(
      page.getByRole("heading", { name: "PO-2026-042" }),
    ).toBeVisible({ timeout: 15_000 });

    // PO has no line items — click "Add line item" to open the add row
    const addBtn = page.getByRole("button", { name: /add line item/i });
    await expect(addBtn).toBeVisible({ timeout: 8_000 });
    await addBtn.click();

    // ── Add row is now active ─────────────────────────────────────────────────
    // Scope locators to the add row, identified by the description input
    const addRow = page
      .locator("tbody tr")
      .filter({ has: page.locator('input[placeholder="Item description"]') });

    // The CatalogItemCombobox trigger shows "Pick from catalog…" when nothing is selected
    const catalogTrigger = addRow
      .locator('button[role="combobox"]')
      .filter({ hasText: "Pick from catalog" });
    await expect(catalogTrigger).toBeVisible({ timeout: 5_000 });

    // Open the catalog popover
    await catalogTrigger.click();

    // The popover renders a CommandItem with the catalog item name
    await expect(page.getByRole("option", { name: "Premium Canvas" })).toBeVisible({
      timeout: 5_000,
    });

    // Select the catalog item
    await page.getByRole("option", { name: "Premium Canvas" }).click();

    // After selection: description input should be pre-filled with the item name
    const descriptionInput = addRow.locator('input[placeholder="Item description"]');
    await expect(descriptionInput).toHaveValue("Premium Canvas", {
      timeout: 3_000,
    });

    // The unit_price input in the add row — qty (index 0), unit_price (index 1),
    // received_qty (index 2)
    const unitPriceInput = addRow.locator('input[type="number"]').nth(1);
    await expect(unitPriceInput).toHaveValue("25.50", { timeout: 3_000 });

    // Click the save (Check ✓) button — the last button in the action cell
    const saveBtn = addRow.locator("td").last().locator("button").last();
    await saveBtn.click();

    // Verify the POST was sent with supplier_catalog_item_id
    await expect.poll(() => getPostBody(), { timeout: 5_000 }).toMatchObject({
      supplier_catalog_item_id: CATALOG_ITEM.id,
      description: "Premium Canvas",
      unit_price: "25.50",
    });

    // After the mutation succeeds the line items are refetched; the table should
    // show the newly created item
    await expect(page.getByText("Premium Canvas")).toBeVisible({
      timeout: 8_000,
    });
  });
});

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

// ---------------------------------------------------------------------------
// Shared types / helpers
// ---------------------------------------------------------------------------

type MockBaseItem = {
  id: number;
  workspace_owner_id: string;
  name: string;
  code: string;
  image_url: string | null;
  category_id: number | null;
  alternate_name: string | null;
  accounting_category: string | null;
  tax_rate: string | null;
  main_category_name: string | null;
  sub_category_name: string | null;
  created_at: string;
  stock: number;
  low_stock_threshold: number;
};

type MockMovement = {
  id: number;
  created_at: string;
  quantity_change: string;
  running_balance: string;
  reason: string;
  note: string | null;
  movement_type: string | null;
  location_id: number | null;
  location_name: string | null;
  created_by_user_id: string | null;
  source_display_name: string | null;
  order_id: string | null;
  order_line_item_id: string | null;
  product_id: number | null;
  product_name: string | null;
  purchase_order_id: number | null;
  transfer_id: number | null;
  reversal_of_id: number | null;
  recipe_snapshot: Record<string, unknown> | null;
  cutover_baseline: boolean;
  idempotency_key: string | null;
  reference_label: string | null;
  display_order_number: string | null;
  po_label: string | null;
  transfer_label: string | null;
};

function makeItem(overrides: Partial<MockBaseItem> = {}): MockBaseItem {
  return {
    id: 42,
    workspace_owner_id: "user_test",
    name: "Red Roses",
    code: "BI0001",
    image_url: null,
    category_id: null,
    alternate_name: null,
    accounting_category: null,
    tax_rate: null,
    main_category_name: null,
    sub_category_name: null,
    created_at: new Date().toISOString(),
    stock: 0,
    low_stock_threshold: 0,
    ...overrides,
  };
}

function makeMovement(overrides: Partial<MockMovement> = {}): MockMovement {
  return {
    id: 1,
    created_at: new Date(Date.now() - 86400_000).toISOString(),
    quantity_change: "10.00",
    running_balance: "10.00",
    reason: "received",
    note: null,
    movement_type: "purchase_order_receipt",
    location_id: 1,
    location_name: "Main Warehouse",
    created_by_user_id: null,
    source_display_name: "System",
    order_id: null,
    order_line_item_id: null,
    product_id: null,
    product_name: null,
    purchase_order_id: null,
    transfer_id: null,
    reversal_of_id: null,
    recipe_snapshot: null,
    cutover_baseline: false,
    idempotency_key: null,
    reference_label: "PO-001",
    display_order_number: null,
    po_label: "PO-001",
    transfer_label: null,
    ...overrides,
  };
}

type SetupOptions = {
  item?: MockBaseItem;
  movements?: MockMovement[];
  total?: number;
  locationStatuses?: Array<{
    location_id: number;
    location_name: string;
    is_active?: boolean;
    country?: string;
    stock?: number;
    low_stock_threshold?: number;
  }>;
  exportStatus?: number;
  exportBody?: string;
};

async function setupPage(
  page: import("@playwright/test").Page,
  opts: SetupOptions = {},
) {
  const {
    item = makeItem(),
    movements = [],
    total = movements.length,
    locationStatuses = [
      { location_id: 1, location_name: "Main Warehouse", is_active: true, country: "AE", stock: 0, low_stock_threshold: 0 },
    ],
    exportStatus = 200,
    exportBody = "id,date,type\n1,2024-01-01,purchase_order_receipt",
  } = opts;

  // Catch-all fallback
  await page.route("**/api/**", async (route) => {
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({}) });
  });

  await page.route("**/api/users**", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        members: [],
        me: { role: "owner", email: "e2e-tester@presentail.com", allowedPages: null, customRoleId: null },
      }),
    });
  });

  await page.route("**/api/base-item-categories**", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ categories: [] }),
    });
  });

  await page.route("**/api/base-items/42/location-statuses**", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ locationStatuses }),
    });
  });

  await page.route("**/api/base-items/42/products**", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ products: [] }),
    });
  });

  await page.route("**/api/base-items/42/packages**", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ packages: [] }),
    });
  });

  await page.route("**/api/base-items/42/suppliers**", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ suppliers: [] }),
    });
  });

  await page.route("**/api/base-items/42/adjustments**", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ adjustments: [] }),
    });
  });

  await page.route(/\/api\/base-items\/42\/stock-movements\/export/, async (route) => {
    if (exportStatus !== 200) {
      await route.fulfill({
        status: exportStatus,
        contentType: "application/json",
        body: JSON.stringify({ error: "Export failed: server error" }),
      });
    } else {
      await route.fulfill({
        status: 200,
        contentType: "text/csv",
        body: exportBody,
        headers: { "Content-Disposition": "attachment; filename=stock-movements-42.csv" },
      });
    }
  });

  await page.route(/\/api\/base-items\/42\/stock-movements(\?|$)/, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        movements,
        total,
        page: 1,
        limit: 50,
        summary: {
          openingBalance: 0,
          received: total > 0 ? parseFloat(movements[0]?.quantity_change ?? "0") : 0,
          consumed: 0,
          closingBalance: total > 0 ? parseFloat(movements[0]?.running_balance ?? "0") : 0,
        },
      }),
    });
  });

  await page.route(/\/api\/base-items\/42(\?|$)/, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ item }),
    });
  });
}

async function gotoAndWait(page: import("@playwright/test").Page) {
  await page.goto("/base-items/42", { waitUntil: "domcontentloaded" });
  await expect(page.getByRole("heading", { name: "Red Roses" })).toBeVisible({ timeout: 15_000 });
}

// ---------------------------------------------------------------------------
// Tab placement
// ---------------------------------------------------------------------------

test.describe("Stock Movements tab — placement", () => {
  test("Stock Movements tab appears after Inventory and before Products/History", async ({ page }) => {
    await setupPage(page);
    await gotoAndWait(page);

    const tabs = page.getByRole("tab");
    const tabTexts = await tabs.allTextContents();

    const invIdx = tabTexts.findIndex((t) => /inventory/i.test(t));
    const smIdx = tabTexts.findIndex((t) => /stock movements/i.test(t));
    const prodIdx = tabTexts.findIndex((t) => /products/i.test(t));
    const histIdx = tabTexts.findIndex((t) => /history/i.test(t));

    expect(smIdx).toBeGreaterThan(invIdx);
    expect(prodIdx).toBeGreaterThan(smIdx);
    expect(histIdx).toBeGreaterThan(smIdx);
  });

  test("Stock Movements tab is clickable and renders the table", async ({ page }) => {
    await setupPage(page);
    await gotoAndWait(page);

    await page.getByRole("tab", { name: /stock movements/i }).click();
    await expect(page.getByTestId("movements-table")).toBeVisible({ timeout: 5_000 });
  });
});

// ---------------------------------------------------------------------------
// Empty vs no-results states
// ---------------------------------------------------------------------------

test.describe("Stock Movements — empty states", () => {
  test("genuinely empty ledger shows 'no movements yet' message (no filters)", async ({ page }) => {
    await setupPage(page, { movements: [] });
    await gotoAndWait(page);
    await page.getByRole("tab", { name: /stock movements/i }).click();

    await expect(page.getByTestId("empty-message")).toContainText(/no stock movements yet/i, { timeout: 5_000 });
  });

  test("filter-caused empty shows 'no movements match filters' message", async ({ page }) => {
    await setupPage(page, { movements: [] });
    await gotoAndWait(page);
    await page.getByRole("tab", { name: /stock movements/i }).click();

    // Change a filter to make it a filter-caused empty
    await page.getByTestId("filter-search").fill("NONEXISTENT-REF-XYZ");
    await expect(page.getByTestId("empty-message")).toContainText(/no movements match your filters/i, { timeout: 5_000 });
  });
});

// ---------------------------------------------------------------------------
// Default date range
// ---------------------------------------------------------------------------

test.describe("Stock Movements — default date range", () => {
  test("from-date input defaults to 30 days ago (local date)", async ({ page }) => {
    await setupPage(page);
    await gotoAndWait(page);
    await page.getByRole("tab", { name: /stock movements/i }).click();

    const fromValue = await page.getByTestId("filter-from-date").inputValue();
    const toValue = await page.getByTestId("filter-to-date").inputValue();

    expect(fromValue).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(toValue).toMatch(/^\d{4}-\d{2}-\d{2}$/);

    const fromDate = new Date(fromValue);
    const toDate = new Date(toValue);
    const diffMs = toDate.getTime() - fromDate.getTime();
    const diffDays = Math.round(diffMs / (1000 * 60 * 60 * 24));

    // Should be approximately 30 days
    expect(diffDays).toBeGreaterThanOrEqual(29);
    expect(diffDays).toBeLessThanOrEqual(31);
  });

  test("clear filters restores default date range", async ({ page }) => {
    await setupPage(page);
    await gotoAndWait(page);
    await page.getByRole("tab", { name: /stock movements/i }).click();

    // Capture the defaults
    const defaultFrom = await page.getByTestId("filter-from-date").inputValue();
    const defaultTo = await page.getByTestId("filter-to-date").inputValue();

    // Change them
    await page.getByTestId("filter-from-date").fill("2020-01-01");
    await page.getByTestId("filter-to-date").fill("2020-01-31");

    // Clear
    await page.getByTestId("clear-filters").click();

    // Restored
    await expect(page.getByTestId("filter-from-date")).toHaveValue(defaultFrom);
    await expect(page.getByTestId("filter-to-date")).toHaveValue(defaultTo);
  });
});

// ---------------------------------------------------------------------------
// Country cascade
// ---------------------------------------------------------------------------

test.describe("Stock Movements — country/location cascade", () => {
  test("location filter shows only locations for selected country", async ({ page }) => {
    await setupPage(page, {
      locationStatuses: [
        { location_id: 1, location_name: "Dubai HQ", is_active: true, country: "AE", stock: 0, low_stock_threshold: 0 },
        { location_id: 2, location_name: "Abu Dhabi Branch", is_active: true, country: "AE", stock: 0, low_stock_threshold: 0 },
        { location_id: 3, location_name: "Riyadh Store", is_active: true, country: "SA", stock: 0, low_stock_threshold: 0 },
      ],
    });
    await gotoAndWait(page);
    await page.getByRole("tab", { name: /stock movements/i }).click();

    // Select AE country
    await page.getByTestId("filter-country").click();
    await page.getByRole("option", { name: "AE" }).click();

    // Location dropdown should only show AE locations
    await page.getByTestId("filter-location").click();
    await expect(page.getByRole("option", { name: "Dubai HQ" })).toBeVisible();
    await expect(page.getByRole("option", { name: "Abu Dhabi Branch" })).toBeVisible();
    await expect(page.getByRole("option", { name: "Riyadh Store" })).not.toBeVisible();
  });

  test("switching country resets location to 'all' when current selection is outside new country", async ({ page }) => {
    await setupPage(page, {
      locationStatuses: [
        { location_id: 1, location_name: "Dubai HQ", is_active: true, country: "AE", stock: 0, low_stock_threshold: 0 },
        { location_id: 3, location_name: "Riyadh Store", is_active: true, country: "SA", stock: 0, low_stock_threshold: 0 },
      ],
    });
    await gotoAndWait(page);
    await page.getByRole("tab", { name: /stock movements/i }).click();

    // Select SA country then pick Riyadh
    await page.getByTestId("filter-country").click();
    await page.getByRole("option", { name: "SA" }).click();
    await page.getByTestId("filter-location").click();
    await page.getByRole("option", { name: "Riyadh Store" }).click();

    // Now switch to AE — location should reset
    await page.getByTestId("filter-country").click();
    await page.getByRole("option", { name: "AE" }).click();

    // Riyadh should no longer be selected; location shows "all locations"
    const locationTrigger = page.getByTestId("filter-location");
    await expect(locationTrigger).toContainText(/all locations/i);
  });
});

// ---------------------------------------------------------------------------
// Pagination
// ---------------------------------------------------------------------------

test.describe("Stock Movements — pagination", () => {
  test("pagination controls appear when there are multiple pages", async ({ page }) => {
    const movements = Array.from({ length: 50 }, (_, i) =>
      makeMovement({ id: i + 1, reference_label: `REF-${i + 1}` }),
    );
    // total > 50 triggers pagination
    await setupPage(page, { movements, total: 120 });
    await gotoAndWait(page);
    await page.getByRole("tab", { name: /stock movements/i }).click();

    await expect(page.getByTestId("pagination")).toBeVisible({ timeout: 5_000 });
    await expect(page.getByTestId("pagination-prev")).toBeDisabled();
    await expect(page.getByTestId("pagination-next")).toBeEnabled();
  });

  test("clicking next page sends page=2 to API", async ({ page }) => {
    const movements = Array.from({ length: 50 }, (_, i) =>
      makeMovement({ id: i + 1 }),
    );
    await setupPage(page, { movements, total: 120 });
    await gotoAndWait(page);
    await page.getByRole("tab", { name: /stock movements/i }).click();

    const [request] = await Promise.all([
      page.waitForRequest(/\/api\/base-items\/42\/stock-movements/),
      page.getByTestId("pagination-next").click(),
    ]);

    expect(new URL(request.url()).searchParams.get("page")).toBe("2");
  });

  test("pagination does not appear when total fits on one page", async ({ page }) => {
    const movements = [makeMovement({ id: 1 })];
    await setupPage(page, { movements, total: 1 });
    await gotoAndWait(page);
    await page.getByRole("tab", { name: /stock movements/i }).click();

    await expect(page.getByTestId("movements-table")).toBeVisible({ timeout: 5_000 });
    await expect(page.getByTestId("pagination")).not.toBeVisible();
  });
});

// ---------------------------------------------------------------------------
// Sorting
// ---------------------------------------------------------------------------

test.describe("Stock Movements — sorting", () => {
  test("clicking Date sort header sends sortBy=date and toggles direction", async ({ page }) => {
    await setupPage(page, { movements: [makeMovement()] });
    await gotoAndWait(page);
    await page.getByRole("tab", { name: /stock movements/i }).click();

    // First click toggles the default date direction from desc to asc.
    const [req1] = await Promise.all([
      page.waitForRequest((request) => {
        const url = new URL(request.url());
        return url.pathname.endsWith("/api/base-items/42/stock-movements")
          && url.searchParams.get("sortBy") === "date"
          && url.searchParams.get("sortDirection") === "asc";
      }),
      page.getByTestId("sort-date").click(),
    ]);
    const url1 = new URL(req1.url());
    expect(url1.searchParams.get("sortBy")).toBe("date");
    expect(url1.searchParams.get("sortDirection")).toBe("asc");
    await expect(page.getByTestId("sort-date")).toHaveAttribute("aria-sort", "ascending");

    // Second click toggles back to desc. React Query may satisfy this cached
    // state without a network request, so assert the accessible sort state.
    await page.getByTestId("sort-date").click();
    await expect(page.getByTestId("sort-date")).toHaveAttribute("aria-sort", "descending");
  });

  test("clicking Type sort header sends sortBy=type", async ({ page }) => {
    await setupPage(page, { movements: [makeMovement()] });
    await gotoAndWait(page);
    await page.getByRole("tab", { name: /stock movements/i }).click();

    const [req] = await Promise.all([
      page.waitForRequest(/\/api\/base-items\/42\/stock-movements/),
      page.getByTestId("sort-type").click(),
    ]);
    expect(new URL(req.url()).searchParams.get("sortBy")).toBe("type");
  });

  test("clicking Change sort header sends the API quantity sort field", async ({ page }) => {
    await setupPage(page, { movements: [makeMovement()] });
    await gotoAndWait(page);
    await page.getByRole("tab", { name: /stock movements/i }).click();

    const [req] = await Promise.all([
      page.waitForRequest(/\/api\/base-items\/42\/stock-movements/),
      page.getByTestId("sort-change").click(),
    ]);
    expect(new URL(req.url()).searchParams.get("sortBy")).toBe("quantity");
  });
});

// ---------------------------------------------------------------------------
// Reference links
// ---------------------------------------------------------------------------

test.describe("Stock Movements — reference links", () => {
  test("order movement links to /orders/:id", async ({ page }) => {
    const m = makeMovement({
      id: 10,
      movement_type: "product_consumption",
      order_id: "ORD-999",
      reference_label: "Order #ORD-999",
    });
    await setupPage(page, { movements: [m] });
    await gotoAndWait(page);
    await page.getByRole("tab", { name: /stock movements/i }).click();

    const link = page.getByTestId("ref-link-10");
    await expect(link).toBeVisible({ timeout: 5_000 });
    await expect(link).toHaveAttribute("href", "/orders/ORD-999");
  });

  test("purchase order movement links to /purchase-orders/:id", async ({ page }) => {
    const m = makeMovement({
      id: 11,
      movement_type: "purchase_order_receipt",
      purchase_order_id: 77,
      reference_label: "PO-077",
    });
    await setupPage(page, { movements: [m] });
    await gotoAndWait(page);
    await page.getByRole("tab", { name: /stock movements/i }).click();

    const link = page.getByTestId("ref-link-11");
    await expect(link).toBeVisible({ timeout: 5_000 });
    await expect(link).toHaveAttribute("href", "/purchase-orders/77");
  });

  test("product link renders for rows with product_id", async ({ page }) => {
    const m = makeMovement({
      id: 12,
      product_id: 55,
      product_name: "Rose Bouquet",
      reference_label: "Recipe use",
    });
    await setupPage(page, { movements: [m] });
    await gotoAndWait(page);
    await page.getByRole("tab", { name: /stock movements/i }).click();

    const link = page.getByTestId("product-link-12");
    await expect(link).toBeVisible({ timeout: 5_000 });
    await expect(link).toHaveAttribute("href", "/products/55");
  });

  test("transfer movement deep-links to stock-movements tab with transfer label query", async ({ page }) => {
    const m = makeMovement({
      id: 13,
      movement_type: "transfer_in",
      transfer_id: 5,
      transfer_label: "T-0005",
      reference_label: "Transfer T-0005",
    });
    await setupPage(page, { movements: [m] });
    await gotoAndWait(page);
    await page.getByRole("tab", { name: /stock movements/i }).click();

    const link = page.getByTestId("ref-link-13");
    await expect(link).toBeVisible({ timeout: 5_000 });
    const href = await link.getAttribute("href");
    expect(href).toContain("tab=stock-movements");
    expect(href).toContain("T-0005");
  });

  test("reversal movement links back to stock-movements with reversal_of_id", async ({ page }) => {
    const m = makeMovement({
      id: 14,
      movement_type: "reversal",
      reversal_of_id: 7,
      reference_label: "Reversal of #7",
    });
    await setupPage(page, { movements: [m] });
    await gotoAndWait(page);
    await page.getByRole("tab", { name: /stock movements/i }).click();

    const link = page.getByTestId("reversal-link-14");
    await expect(link).toBeVisible({ timeout: 5_000 });
    const href = await link.getAttribute("href");
    expect(href).toContain("tab=stock-movements");
    expect(href).toContain("7");
  });
});

// ---------------------------------------------------------------------------
// In/Out labels in cells
// ---------------------------------------------------------------------------

test.describe("Stock Movements — In/Out labels", () => {
  test("positive quantity shows 'In' text label", async ({ page }) => {
    const m = makeMovement({ id: 20, quantity_change: "5.00", running_balance: "5.00" });
    await setupPage(page, { movements: [m] });
    await gotoAndWait(page);
    await page.getByRole("tab", { name: /stock movements/i }).click();

    const row = page.getByTestId("movement-row-20");
    await expect(row).toBeVisible({ timeout: 5_000 });
    await expect(row.getByText("In", { exact: true })).toBeVisible();
  });

  test("negative quantity shows 'Out' text label", async ({ page }) => {
    const m = makeMovement({
      id: 21,
      movement_type: "product_consumption",
      quantity_change: "-3.00",
      running_balance: "2.00",
    });
    await setupPage(page, { movements: [m] });
    await gotoAndWait(page);
    await page.getByRole("tab", { name: /stock movements/i }).click();

    const row = page.getByTestId("movement-row-21");
    await expect(row).toBeVisible({ timeout: 5_000 });
    await expect(row.getByText("Out", { exact: true })).toBeVisible();
  });
});

// ---------------------------------------------------------------------------
// Recipe snapshot dialog
// ---------------------------------------------------------------------------

test.describe("Stock Movements — recipe snapshot dialog", () => {
  test("recipe button is visible for movements with recipe_snapshot", async ({ page }) => {
    const m = makeMovement({
      id: 30,
      movement_type: "product_consumption",
      recipe_snapshot: { stem_count: 5, unit: "stems", version: "2024-01" },
    });
    await setupPage(page, { movements: [m] });
    await gotoAndWait(page);
    await page.getByRole("tab", { name: /stock movements/i }).click();

    await expect(page.getByTestId("recipe-btn-30")).toBeVisible({ timeout: 5_000 });
  });

  test("clicking recipe button opens dialog with historical snapshot wording", async ({ page }) => {
    const m = makeMovement({
      id: 31,
      movement_type: "product_consumption",
      recipe_snapshot: { stem_count: 3, unit: "pcs" },
    });
    await setupPage(page, { movements: [m] });
    await gotoAndWait(page);
    await page.getByRole("tab", { name: /stock movements/i }).click();

    await page.getByTestId("recipe-btn-31").click();

    const dialog = page.getByTestId("recipe-snapshot-dialog");
    await expect(dialog).toBeVisible({ timeout: 5_000 });
    await expect(dialog).toContainText(/historical snapshot/i);
    await expect(dialog).toContainText(/immutable/i);
  });

  test("recipe dialog shows key-value pairs from snapshot", async ({ page }) => {
    const m = makeMovement({
      id: 32,
      movement_type: "product_consumption",
      recipe_snapshot: { stem_count: 7, unit: "stems", product: "Rose" },
    });
    await setupPage(page, { movements: [m] });
    await gotoAndWait(page);
    await page.getByRole("tab", { name: /stock movements/i }).click();

    await page.getByTestId("recipe-btn-32").click();

    const dialog = page.getByTestId("recipe-snapshot-dialog");
    await expect(dialog).toContainText("stem_count");
    await expect(dialog).toContainText("7");
    await expect(dialog).toContainText("stems");
    await expect(dialog).toContainText("Rose");
  });

  test("recipe dialog closes when dismissed", async ({ page }) => {
    const m = makeMovement({
      id: 33,
      movement_type: "product_consumption",
      recipe_snapshot: { qty: 1 },
    });
    await setupPage(page, { movements: [m] });
    await gotoAndWait(page);
    await page.getByRole("tab", { name: /stock movements/i }).click();

    await page.getByTestId("recipe-btn-33").click();
    await expect(page.getByTestId("recipe-snapshot-dialog")).toBeVisible({ timeout: 5_000 });

    // Close via the dialog's X button
    await page.getByRole("button", { name: /close/i }).click();
    await expect(page.getByTestId("recipe-snapshot-dialog")).not.toBeVisible();
  });

  test("recipe button is absent for movements without recipe_snapshot", async ({ page }) => {
    const m = makeMovement({ id: 34, recipe_snapshot: null });
    await setupPage(page, { movements: [m] });
    await gotoAndWait(page);
    await page.getByRole("tab", { name: /stock movements/i }).click();

    await expect(page.getByTestId("movements-table")).toBeVisible({ timeout: 5_000 });
    await expect(page.getByTestId("recipe-btn-34")).not.toBeVisible();
  });
});

// ---------------------------------------------------------------------------
// CSV export
// ---------------------------------------------------------------------------

test.describe("Stock Movements — CSV export", () => {
  test("CSV export button is visible on the Stock Movements tab", async ({ page }) => {
    await setupPage(page);
    await gotoAndWait(page);
    await page.getByRole("tab", { name: /stock movements/i }).click();

    await expect(page.getByTestId("export-csv")).toBeVisible({ timeout: 5_000 });
  });

  test("successful CSV export shows success toast", async ({ page }) => {
    await setupPage(page, { exportStatus: 200 });
    await gotoAndWait(page);
    await page.getByRole("tab", { name: /stock movements/i }).click();

    await page.getByTestId("export-csv").click();

    // Success toast text matches locale string
    await expect(page.getByText(/csv downloaded|تم تنزيل/i).first()).toBeVisible({ timeout: 8_000 });
  });

  test("failed CSV export shows error toast with server message", async ({ page }) => {
    await setupPage(page, { exportStatus: 500 });
    await gotoAndWait(page);
    await page.getByRole("tab", { name: /stock movements/i }).click();

    await page.getByTestId("export-csv").click();

    // Error toast — shows server message or generic failure
    await expect(
      page.getByText(/export failed|server error|فشل التصدير/i).first(),
    ).toBeVisible({ timeout: 8_000 });
  });
});

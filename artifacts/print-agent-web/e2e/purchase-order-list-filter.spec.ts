/**
 * E2E tests for the Purchase Order list page — supplier filter combobox and
 * the resulting empty state when no POs match the active filter.
 *
 * Route-registration follows the LIFO pattern documented in
 * purchase-order-test-utils.ts: catch-all first, broad routes next,
 * more-specific routes last so that the most-specific handler wins.
 */

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

// ─── Shared fixtures ──────────────────────────────────────────────────────────

const SUPPLIER_ALPHA = {
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

const SUPPLIER_BETA = {
  ...SUPPLIER_ALPHA,
  id: 8,
  name: "Beta Corp Ltd",
  display_name: "Beta Corp",
};

function makePo(overrides: Record<string, unknown>) {
  return {
    workspace_owner_id: "user_owner",
    po_number_label: "PO-2026-001",
    status: "draft",
    currency: "AED",
    total_amount: "100.00",
    effective_total: "100.00",
    calculated_total: "100.00",
    total_amount_manual_override: false,
    expected_delivery_date: null,
    notes: null,
    line_items_count: 0,
    received_items_count: 0,
    outstanding_units: 0,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    line_items: [],
    ...overrides,
  };
}

const PO_ALPHA = makePo({
  id: 11,
  supplier_id: SUPPLIER_ALPHA.id,
  supplier_name: SUPPLIER_ALPHA.name,
  po_number: "PO-2026-011",
  po_number_label: "PO-2026-011",
});

const PO_BETA = makePo({
  id: 12,
  supplier_id: SUPPLIER_BETA.id,
  supplier_name: SUPPLIER_BETA.name,
  po_number: "PO-2026-012",
  po_number_label: "PO-2026-012",
  status: "sent",
  currency: "USD",
  total_amount: "750.00",
  effective_total: "750.00",
  calculated_total: "750.00",
});

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Registers the PO list route with supplier-aware response logic.
 *
 * When the request URL contains `supplier_id=<supplierId>`, the mock returns
 * `filteredOrders`; otherwise it returns `allOrders`.  Must be called AFTER
 * `setupCommonPurchaseOrderRoutes` so this handler wins (LIFO).
 */
async function setupPoListRoute(
  page: import("@playwright/test").Page,
  {
    allOrders,
    filteredOrders,
    filteredSupplierId,
  }: {
    allOrders: object[];
    filteredOrders: object[];
    filteredSupplierId: number;
  },
) {
  await page.route(/\/api\/purchase-orders(\?.*)?$/, async (route) => {
    if (route.request().method() !== "GET") {
      await route.continue();
      return;
    }
    const url = new URL(route.request().url());
    const supplierId = url.searchParams.get("supplier_id");
    const orders =
      supplierId === String(filteredSupplierId) ? filteredOrders : allOrders;
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ purchase_orders: orders, total: orders.length }),
    });
  });
}

/**
 * Registers a paginated PO list mock.
 *
 * The mock inspects the `page` query param:
 *  - page 1 (or absent) → `page1Orders`, total = `overallTotal`
 *  - page 2             → `page2Orders`, total = `overallTotal`
 *
 * Optionally also filters by `supplier_id` when `filteredSupplierId` is
 * provided, returning `filteredOrders` (with `filteredTotal`) instead of the
 * page-based sets whenever that supplier filter is active.
 *
 * Must be called AFTER `setupCommonPurchaseOrderRoutes` (LIFO).
 */
async function setupPaginatedPoListRoute(
  page: import("@playwright/test").Page,
  {
    page1Orders,
    page2Orders,
    overallTotal,
    filteredSupplierId,
    filteredOrders,
    filteredTotal,
  }: {
    page1Orders: object[];
    page2Orders: object[];
    overallTotal: number;
    filteredSupplierId?: number;
    filteredOrders?: object[];
    filteredTotal?: number;
  },
) {
  await page.route(/\/api\/purchase-orders(\?.*)?$/, async (route) => {
    if (route.request().method() !== "GET") {
      await route.continue();
      return;
    }
    const url = new URL(route.request().url());
    const supplierId = url.searchParams.get("supplier_id");
    const pageNum = parseInt(url.searchParams.get("page") ?? "1", 10);

    if (
      filteredSupplierId != null &&
      supplierId === String(filteredSupplierId)
    ) {
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          purchase_orders: filteredOrders ?? [],
          total: filteredTotal ?? (filteredOrders?.length ?? 0),
          page: 1,
          limit: 20,
        }),
      });
    }

    const orders = pageNum === 2 ? page2Orders : page1Orders;
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        purchase_orders: orders,
        total: overallTotal,
        page: pageNum,
        limit: 20,
      }),
    });
  });
}

// ─── Tests ────────────────────────────────────────────────────────────────────

test.describe("Purchase Order list — supplier filter combobox", () => {
  test("selecting a supplier in the filter combobox shows only that supplier's POs", async ({
    page,
  }) => {
    // Step 1 (LIFO lowest priority): catch-all + users + suppliers
    await setupCommonPurchaseOrderRoutes(page, {
      suppliers: [SUPPLIER_ALPHA, SUPPLIER_BETA],
    });

    // Step 2 (LIFO higher priority): PO list — registered after common routes
    await setupPoListRoute(page, {
      allOrders: [PO_ALPHA, PO_BETA],
      filteredOrders: [PO_ALPHA],
      filteredSupplierId: SUPPLIER_ALPHA.id,
    });

    await page.goto("/purchase-orders", { waitUntil: "domcontentloaded" });
    await expect(
      page.getByRole("heading", { name: "Purchase Orders" }),
    ).toBeVisible({ timeout: 15_000 });

    // Both POs should be visible initially (no filter active)
    await expect(page.getByText("PO-2026-011")).toBeVisible({ timeout: 10_000 });
    await expect(page.getByText("PO-2026-012")).toBeVisible({ timeout: 5_000 });

    // Open the supplier filter combobox (labelled "Filter by supplier" to
    // distinguish it from other comboboxes present in the sidebar / layout)
    const filterCombobox = page.getByRole("combobox", {
      name: "Filter by supplier",
    });
    await filterCombobox.click();

    // Wait for the dropdown search input to appear
    await expect(
      page.getByPlaceholder("Search suppliers…").first(),
    ).toBeVisible({ timeout: 8_000 });

    // Select Alpha Supplies from the dropdown (CommandItem renders with role="option")
    await page.getByRole("option", { name: /Alpha Supplies/ }).click();

    // After selection the combobox trigger should show the chosen supplier name
    await expect(filterCombobox).toContainText("Alpha Supplies", {
      timeout: 5_000,
    });

    // The PO list is re-fetched with supplier_id=7 — only Alpha's PO should be visible
    await expect(page.getByText("PO-2026-011")).toBeVisible({ timeout: 10_000 });

    // Beta's PO must no longer be visible
    await expect(page.getByText("PO-2026-012")).not.toBeVisible();
  });

  test("clearing the supplier filter restores the unfiltered PO list", async ({
    page,
  }) => {
    await setupCommonPurchaseOrderRoutes(page, {
      suppliers: [SUPPLIER_ALPHA, SUPPLIER_BETA],
    });

    await setupPoListRoute(page, {
      allOrders: [PO_ALPHA, PO_BETA],
      filteredOrders: [PO_ALPHA],
      filteredSupplierId: SUPPLIER_ALPHA.id,
    });

    await page.goto("/purchase-orders", { waitUntil: "domcontentloaded" });
    await expect(
      page.getByRole("heading", { name: "Purchase Orders" }),
    ).toBeVisible({ timeout: 15_000 });

    // Wait for the initial full list to load
    await expect(page.getByText("PO-2026-011")).toBeVisible({ timeout: 10_000 });
    await expect(page.getByText("PO-2026-012")).toBeVisible({ timeout: 5_000 });

    // Apply the filter
    await page.getByRole("combobox", { name: "Filter by supplier" }).click();
    await expect(
      page.getByPlaceholder("Search suppliers…").first(),
    ).toBeVisible({ timeout: 8_000 });
    await page.getByRole("option", { name: /Alpha Supplies/ }).click();

    // Filtered: only Alpha's PO
    await expect(page.getByText("PO-2026-011")).toBeVisible({ timeout: 10_000 });
    await expect(page.getByText("PO-2026-012")).not.toBeVisible();

    // Clear the filter using the "Clear" button
    await page.getByRole("button", { name: "Clear" }).click();

    // After clearing the filter both POs should be visible again
    await expect(page.getByText("PO-2026-011")).toBeVisible({ timeout: 10_000 });
    await expect(page.getByText("PO-2026-012")).toBeVisible({ timeout: 10_000 });
  });

  test("empty state appears when no POs match the selected supplier filter", async ({
    page,
  }) => {
    await setupCommonPurchaseOrderRoutes(page, {
      suppliers: [SUPPLIER_ALPHA, SUPPLIER_BETA],
    });

    // Initial list has one PO (Beta's); filtering by Alpha returns nothing
    await setupPoListRoute(page, {
      allOrders: [PO_BETA],
      filteredOrders: [],
      filteredSupplierId: SUPPLIER_ALPHA.id,
    });

    await page.goto("/purchase-orders", { waitUntil: "domcontentloaded" });
    await expect(
      page.getByRole("heading", { name: "Purchase Orders" }),
    ).toBeVisible({ timeout: 15_000 });

    // Beta's PO is visible before filtering
    await expect(page.getByText("PO-2026-012")).toBeVisible({ timeout: 10_000 });

    // Apply the Alpha supplier filter
    await page.getByRole("combobox", { name: "Filter by supplier" }).click();
    await expect(
      page.getByPlaceholder("Search suppliers…").first(),
    ).toBeVisible({ timeout: 8_000 });
    await page.getByRole("option", { name: /Alpha Supplies/ }).click();

    // The supplier-specific empty-state message should appear because Alpha has no POs
    await expect(
      page.getByText("No purchase orders found for this supplier"),
    ).toBeVisible({ timeout: 10_000 });

    // Beta's PO must no longer be visible
    await expect(page.getByText("PO-2026-012")).not.toBeVisible();

    // A "Clear filter" button should be visible inside the empty state
    const clearFilterBtn = page.getByRole("button", { name: "Clear filter" });
    await expect(clearFilterBtn).toBeVisible({ timeout: 5_000 });

    // Clicking it should restore the unfiltered list (Beta's PO reappears)
    await clearFilterBtn.click();
    await expect(page.getByText("PO-2026-012")).toBeVisible({ timeout: 10_000 });
    await expect(
      page.getByText("No purchase orders found for this supplier"),
    ).not.toBeVisible();
  });

  test("pagination — Next page shows a different set of POs; Previous page returns to page 1", async ({
    page,
  }) => {
    // PO on page 2 only
    const PO_GAMMA = makePo({
      id: 13,
      supplier_id: SUPPLIER_BETA.id,
      supplier_name: SUPPLIER_BETA.name,
      po_number: "PO-2026-013",
      po_number_label: "PO-2026-013",
    });

    await setupCommonPurchaseOrderRoutes(page, {
      suppliers: [SUPPLIER_ALPHA, SUPPLIER_BETA],
    });

    // overallTotal=25 → totalPages=ceil(25/20)=2 → pagination controls appear
    await setupPaginatedPoListRoute(page, {
      page1Orders: [PO_ALPHA, PO_BETA],
      page2Orders: [PO_GAMMA],
      overallTotal: 25,
    });

    await page.goto("/purchase-orders", { waitUntil: "domcontentloaded" });
    await expect(
      page.getByRole("heading", { name: "Purchase Orders" }),
    ).toBeVisible({ timeout: 15_000 });

    // Page 1: both POs visible, PO_GAMMA not yet shown
    await expect(page.getByText("PO-2026-011")).toBeVisible({ timeout: 10_000 });
    await expect(page.getByText("PO-2026-012")).toBeVisible({ timeout: 5_000 });
    await expect(page.getByText("PO-2026-013")).not.toBeVisible();

    // Pagination controls should appear with page indicator
    await expect(page.getByLabel("Pagination")).toBeVisible({ timeout: 5_000 });
    await expect(page.getByText(/Page 1 of 2/)).toBeVisible();

    // Previous should be disabled on page 1
    await expect(page.getByRole("button", { name: "Previous page" })).toBeDisabled();

    // Navigate to page 2
    await page.getByRole("button", { name: "Next page" }).click();

    // Page 2: PO_GAMMA visible; page 1 POs no longer shown
    await expect(page.getByText("PO-2026-013")).toBeVisible({ timeout: 10_000 });
    await expect(page.getByText("PO-2026-011")).not.toBeVisible();
    await expect(page.getByText("PO-2026-012")).not.toBeVisible();
    await expect(page.getByText(/Page 2 of 2/)).toBeVisible();

    // Next should be disabled on last page
    await expect(page.getByRole("button", { name: "Next page" })).toBeDisabled();

    // Navigate back to page 1
    await page.getByRole("button", { name: "Previous page" }).click();

    await expect(page.getByText("PO-2026-011")).toBeVisible({ timeout: 10_000 });
    await expect(page.getByText("PO-2026-012")).toBeVisible({ timeout: 5_000 });
    await expect(page.getByText("PO-2026-013")).not.toBeVisible();
    await expect(page.getByText(/Page 1 of 2/)).toBeVisible();
  });

  test("applying a supplier filter while on page 2 resets to page 1", async ({
    page,
  }) => {
    // PO on page 2 only
    const PO_GAMMA = makePo({
      id: 13,
      supplier_id: SUPPLIER_BETA.id,
      supplier_name: SUPPLIER_BETA.name,
      po_number: "PO-2026-013",
      po_number_label: "PO-2026-013",
    });

    await setupCommonPurchaseOrderRoutes(page, {
      suppliers: [SUPPLIER_ALPHA, SUPPLIER_BETA],
    });

    // Unfiltered list has 2 pages (total=25); filtered by Alpha returns 1 PO
    await setupPaginatedPoListRoute(page, {
      page1Orders: [PO_ALPHA, PO_BETA],
      page2Orders: [PO_GAMMA],
      overallTotal: 25,
      filteredSupplierId: SUPPLIER_ALPHA.id,
      filteredOrders: [PO_ALPHA],
      filteredTotal: 1,
    });

    await page.goto("/purchase-orders", { waitUntil: "domcontentloaded" });
    await expect(
      page.getByRole("heading", { name: "Purchase Orders" }),
    ).toBeVisible({ timeout: 15_000 });

    // Start on page 1, advance to page 2
    await expect(page.getByText("PO-2026-011")).toBeVisible({ timeout: 10_000 });
    await page.getByRole("button", { name: "Next page" }).click();
    await expect(page.getByText("PO-2026-013")).toBeVisible({ timeout: 10_000 });
    await expect(page.getByText(/Page 2 of 2/)).toBeVisible();

    // Apply the supplier filter → component must reset page to 1
    await page.getByRole("combobox", { name: "Filter by supplier" }).click();
    await expect(
      page.getByPlaceholder("Search suppliers…").first(),
    ).toBeVisible({ timeout: 8_000 });
    await page.getByRole("option", { name: /Alpha Supplies/ }).click();

    // After filtering: only Alpha's PO visible, PO_GAMMA gone,
    // and pagination controls no longer shown (filteredTotal=1 → 1 page)
    await expect(page.getByText("PO-2026-011")).toBeVisible({ timeout: 10_000 });
    await expect(page.getByText("PO-2026-013")).not.toBeVisible();
    await expect(page.getByLabel("Pagination")).not.toBeVisible();
  });
});

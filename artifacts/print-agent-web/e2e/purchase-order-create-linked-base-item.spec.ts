import { test, expect } from "./fixtures";
import { setupFapiWithFakeSession } from "./clerk-fapi-redirect";

// Use a fully-mocked Clerk session so all API routes can be controlled via
// page.route without needing a real backend or live FAPI host.
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
const SUPPLIER_ID = 7;
const LOCATION_ID = 3;
const BASE_ITEM_ID = 88;
// The base_item_suppliers row id — this is the catalog item's own `id`, which
// must NOT be sent as supplier_catalog_item_id for a linked base item.
const LINK_ROW_ID = 901;

const MOCK_SUPPLIER = {
  id: SUPPLIER_ID,
  workspace_owner_id: "user_owner",
  name: "Beta Materials Co",
  display_name: "Beta Materials",
  contact_name: null,
  contact_email: null,
  contact_phone: null,
  country: "United Arab Emirates",
  tax_number: null,
  supplier_code: null,
  payment_terms: null,
  currency_pref: "AED",
  default_vat_treatment: null,
  default_vat_rate: null,
  lead_time_days: null,
  min_order_value: null,
  notes: null,
  is_archived: false,
  item_count: 1,
  invoice_count: 0,
  spend_ytd: "0",
  spend_ytd_currency: null,
  created_at: new Date().toISOString(),
  updated_at: null,
  created_by_clerk_id: null,
  updated_by_clerk_id: null,
};

// A catalog item derived from a base item linked to the supplier. The critical
// fields are source="linked_base_item" and base_item_id set — the wizard must
// submit supplier_catalog_item_id=null and base_item_id for this row.
const LINKED_CATALOG_ITEM = {
  id: LINK_ROW_ID,
  workspace_owner_id: "user_owner",
  supplier_id: SUPPLIER_ID,
  base_item_id: BASE_ITEM_ID,
  base_item_name: "House Flour",
  internal_item_code: "BI-FLOUR",
  internal_item_name: "House Flour",
  supplier_item_code: "SUP-FLOUR-01",
  name: "House Flour",
  category: null,
  unit: "kg",
  package_size: null,
  price: "15.00",
  currency: "AED",
  min_order_quantity: "1",
  par_level: null,
  current_stock: null,
  lead_time_days: null,
  is_active: true,
  is_preferred: false,
  source: "linked_base_item",
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
};

const CREATED_PO = {
  id: 42,
  workspace_owner_id: "user_owner",
  supplier_id: SUPPLIER_ID,
  supplier_name: MOCK_SUPPLIER.name,
  po_number: "PO-2026-042",
  po_number_label: "PO-2026-042",
  status: "pending_approval",
  currency: "AED",
  total_amount: "45.00",
  expected_delivery_date: null,
  notes: null,
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
  line_items: [],
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
  let postBody: Record<string, unknown> | null = null;

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

  await page.route("**/api/locations**", async (route) => {
    if (route.request().method() === "GET") {
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          locations: [{ id: LOCATION_ID, name: "Main Warehouse" }],
        }),
      });
    }
    await route.continue();
  });

  // Supplier catalog items — registered before the broad suppliers route so the
  // more-specific pattern wins under LIFO.
  await page.route(
    new RegExp(`/api/suppliers/${SUPPLIER_ID}/catalog-items(\\?.*)?$`),
    async (route) => {
      if (route.request().method() === "GET") {
        return route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ catalog_items: [LINKED_CATALOG_ITEM] }),
        });
      }
      await route.continue();
    },
  );

  await page.route(/\/api\/suppliers(\?.*)?$/, async (route) => {
    if (route.request().method() === "GET") {
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ suppliers: [MOCK_SUPPLIER] }),
      });
    }
    await route.continue();
  });

  // Purchase orders — list returns empty; POST captures the submitted body.
  await page.route(/\/api\/purchase-orders(\?.*)?$/, async (route) => {
    if (route.request().method() === "GET") {
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ purchase_orders: [], total: 0 }),
      });
    }
    if (route.request().method() === "POST") {
      postBody = JSON.parse(
        route.request().postData() ?? "{}",
      ) as Record<string, unknown>;
      return route.fulfill({
        status: 201,
        contentType: "application/json",
        body: JSON.stringify({ purchase_order: CREATED_PO }),
      });
    }
    await route.continue();
  });

  return { getPostBody: () => postBody };
}

test.describe("Purchase Order create — linked base item end-to-end", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test("supplier → add linked base item → review → place order submits supplier_catalog_item_id null + base_item_id", async ({
    page,
  }) => {
    // The dashboard shell + wizard interactions can take a while to boot in CI.
    test.setTimeout(120_000);

    const { getPostBody } = await setupRoutes(page);

    await page.goto("/purchase-orders", { waitUntil: "domcontentloaded" });
    await expect(
      page.getByRole("heading", { name: "Purchase Orders", level: 1 }),
    ).toBeVisible({ timeout: 30_000 });

    // ── Open the wizard ─────────────────────────────────────────────────────
    await page
      .getByRole("button", { name: "New Purchase Order" })
      .first()
      .click();

    const dialog = page.getByRole("dialog");
    await expect(
      dialog.getByRole("heading", { name: "New Purchase Order" }),
    ).toBeVisible({ timeout: 8_000 });

    // ── Select the supplier so its catalog (with the linked base item) loads ──
    await page.getByRole("button", { name: /Beta Materials/ }).first().click();

    // The linked base item appears in the catalog table.
    await expect(dialog.getByText("House Flour").first()).toBeVisible({
      timeout: 8_000,
    });

    // ── Add the linked base item to the cart (set quantity to 3) ─────────────
    const qtyInput = dialog.getByLabel("Quantity for House Flour", {
      exact: true,
    });
    await qtyInput.fill("3");

    // The sticky cart bar should reflect one item selected.
    await expect(dialog.getByText("1 item", { exact: true })).toBeVisible({
      timeout: 5_000,
    });

    // ── Proceed to the review step ──────────────────────────────────────────
    await dialog.getByRole("button", { name: /Review Order/ }).click();
    await expect(
      dialog.getByRole("heading", { name: "Review order" }),
    ).toBeVisible({ timeout: 8_000 });

    // The selected linked item is shown in the review table.
    await expect(dialog.getByText("House Flour").first()).toBeVisible();

    // ── Pick the required delivery location ─────────────────────────────────
    const locationTrigger = dialog
      .locator('button[role="combobox"]')
      .filter({ hasText: "Select location" });
    await locationTrigger.click();
    await page.getByRole("option", { name: "Main Warehouse" }).click();
    await expect(locationTrigger).toContainText("Main Warehouse");

    // ── Place the order ─────────────────────────────────────────────────────
    const createBtn = dialog.getByRole("button", {
      name: /Create purchase order/i,
    });
    await expect(createBtn).toBeEnabled({ timeout: 5_000 });
    await createBtn.click();

    // ── Assert the submitted payload carries the linked line item shape ──────
    await expect.poll(() => getPostBody(), { timeout: 8_000 }).not.toBeNull();
    const body = getPostBody()!;
    expect(body.supplier_id).toBe(SUPPLIER_ID);
    expect(body.location_id).toBe(LOCATION_ID);

    const lineItems = body.line_items as Array<Record<string, unknown>>;
    expect(Array.isArray(lineItems)).toBe(true);
    expect(lineItems).toHaveLength(1);

    const linkedLine = lineItems[0];
    // The defining assertion for a linked base item: no supplier catalog id,
    // but the base_item_id is carried through.
    expect(linkedLine.supplier_catalog_item_id).toBeNull();
    expect(linkedLine.base_item_id).toBe(BASE_ITEM_ID);
    expect(linkedLine.description).toBe("House Flour");
    expect(linkedLine.quantity).toBe("3");
    expect(linkedLine.unit_price).toBe("15.00");

    // ── The wizard closes and a success toast confirms creation ─────────────
    await expect(dialog).not.toBeVisible({ timeout: 10_000 });
    await expect(page.getByText("Purchase order created")).toBeVisible({
      timeout: 8_000,
    });
  });
});

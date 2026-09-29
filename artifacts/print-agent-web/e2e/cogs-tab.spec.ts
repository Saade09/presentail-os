import { test, expect } from "./fixtures";
import { setupClerkTestingToken } from "@clerk/testing/playwright";

const OWNER_EMAIL = "e2e-tester@presentail.com";

const MOCK_PRODUCT = {
  id: 42,
  workspace_owner_id: "user_1",
  name: "Test Product",
  price_usd: "10.00",
  price_aed: "36.72",
  main_image_url: null,
  additional_image_urls: [],
  description: null,
  status: "available",
  brand: null,
  tags: [],
  category: null,
  sku: null,
  created_at: new Date().toISOString(),
};

const MOCK_RECIPE = [
  { base_item_id: 1, name: "Item Alpha", code: "A01", image_url: null, quantity: "2" },
  { base_item_id: 2, name: "Item Beta", code: "B01", image_url: null, quantity: "1" },
];

// Priced + missing-pricing rows. Item Alpha: 1.50 USD × 2 = 3.00. Item Beta has
// no preferred supplier price, so it should be flagged and excluded from total.
const MOCK_COGS_PARTIAL = {
  items: [
    {
      base_item_id: 1,
      name: "Item Alpha",
      code: "A01",
      image_url: null,
      quantity: 2,
      unit_price: 1.5,
      currency: "USD",
      pricing_uom: "sheet",
      line_cost: 3,
    },
    {
      base_item_id: 2,
      name: "Item Beta",
      code: "B01",
      image_url: null,
      quantity: 1,
      unit_price: null,
      currency: null,
      pricing_uom: null,
      line_cost: null,
    },
  ],
  totals: {
    total_cogs: 3,
    currency: "USD",
    missing_pricing_count: 1,
    mixed_currencies: false,
    totals_by_currency: [{ currency: "USD", total: 3 }],
  },
};

function usersResponse() {
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

async function setupBaseRoutes(
  page: import("@playwright/test").Page,
  cogsBody: unknown,
) {
  await page.route("**/api/users**", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(usersResponse()),
    });
  });

  await page.route("**/api/brands**", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ brands: [] }),
    });
  });

  await page.route("**/api/products/42/recipe", async (route) => {
    await route.continue();
  });

  await page.route("**/api/products/42/cogs", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(cogsBody),
    });
  });

  await page.route("**/api/products/42", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ product: MOCK_PRODUCT, recipe: MOCK_RECIPE }),
    });
  });

  await page.route("**/api/products/42/location-statuses", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ statuses: [] }),
    });
  });
}

test.describe("COGS tab", () => {
  test("renders ingredient table, total COGS, and gross margin from seeded recipe + supplier prices", async ({
    page,
  }) => {
    await setupClerkTestingToken({ page });
    await setupBaseRoutes(page, MOCK_COGS_PARTIAL);

    await page.goto("/products/42", { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading", { name: "Test Product" })).toBeVisible({ timeout: 15_000 });
    await page.getByRole("tab", { name: "COGS" }).click();

    // Ingredient rows render with name + line cost.
    await expect(page.getByText("Item Alpha")).toBeVisible({ timeout: 10_000 });
    await expect(page.getByText("Item Beta")).toBeVisible();

    // Priced row shows the formatted unit and line cost.
    await expect(page.getByRole("cell", { name: "$1.50 USD" })).toBeVisible();
    await expect(page.getByRole("cell", { name: "$3.00 USD" })).toBeVisible();

    // Missing-pricing warning banner is visible and counts the unpriced row.
    await expect(
      page.getByText(/1 ingredient without supplier pricing/i),
    ).toBeVisible();

    // The unpriced row shows the "No pricing" badge.
    await expect(page.getByText("No pricing")).toBeVisible();

    // Total COGS row shows $3.00 USD (excludes the unpriced row).
    const totalRow = page.getByText("Total COGS", { exact: true }).locator("..");
    await expect(totalRow).toContainText("$3.00 USD");

    // Selling price (10.00 USD) and gross margin (10 - 3 = 7 USD, 70.0%).
    const sellingRow = page.getByText("Selling price", { exact: true }).locator("..");
    await expect(sellingRow).toContainText("$10.00");

    const marginRow = page.getByText("Gross margin", { exact: true }).locator("..");
    await expect(marginRow).toContainText("$7.00 USD");
    await expect(marginRow).toContainText("70.0%");
  });

  test("shows the empty state when the product has no recipe", async ({ page }) => {
    await setupClerkTestingToken({ page });
    await setupBaseRoutes(page, {
      items: [],
      totals: {
        total_cogs: null,
        currency: null,
        missing_pricing_count: 0,
        mixed_currencies: false,
        totals_by_currency: [],
      },
    });

    await page.goto("/products/42", { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading", { name: "Test Product" })).toBeVisible({ timeout: 15_000 });
    await page.getByRole("tab", { name: "COGS" }).click();

    await expect(page.getByText(/No recipe to cost/i)).toBeVisible({
      timeout: 10_000,
    });
  });

  test("renders the mixed-currencies warning and per-currency totals", async ({
    page,
  }) => {
    await setupClerkTestingToken({ page });
    await setupBaseRoutes(page, {
      items: [
        {
          base_item_id: 1,
          name: "Item Alpha",
          code: "A01",
          image_url: null,
          quantity: 2,
          unit_price: 1.5,
          currency: "USD",
          pricing_uom: "sheet",
          line_cost: 3,
        },
        {
          base_item_id: 2,
          name: "Item Beta",
          code: "B01",
          image_url: null,
          quantity: 1,
          unit_price: 10,
          currency: "AED",
          pricing_uom: "ml",
          line_cost: 10,
        },
      ],
      totals: {
        total_cogs: null,
        currency: null,
        missing_pricing_count: 0,
        mixed_currencies: true,
        totals_by_currency: [
          { currency: "USD", total: 3 },
          { currency: "AED", total: 10 },
        ],
      },
    });

    await page.goto("/products/42", { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading", { name: "Test Product" })).toBeVisible({ timeout: 15_000 });
    await page.getByRole("tab", { name: "COGS" }).click();

    await expect(page.getByText(/Mixed currencies/i).first()).toBeVisible({
      timeout: 10_000,
    });

    const totalRow = page.getByText("Total COGS").locator("..");
    await expect(totalRow.getByText("3.00 USD")).toBeVisible();
    await expect(totalRow.getByText("10.00 AED")).toBeVisible();
  });
});

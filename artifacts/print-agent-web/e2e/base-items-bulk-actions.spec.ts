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

const MOCK_CATEGORIES = { categories: [] };
const MOCK_SUMMARY = { total: 2, flower: 0, packaging: 0, uncategorized: 2 };

const MOCK_ITEMS = {
  items: [
    {
      id: 1,
      name: "Rose Stem",
      code: "RS0001",
      image_url: null,
      category_id: null,
      alternate_name: null,
      accounting_category: null,
      tax_rate: null,
      main_category_name: null,
      sub_category_name: null,
      created_at: new Date().toISOString(),
      stock: 10,
      low_stock_threshold: 2,
      status: "active",
    },
    {
      id: 2,
      name: "Blue Tulip",
      code: "BT0002",
      image_url: null,
      category_id: null,
      alternate_name: null,
      accounting_category: null,
      tax_rate: null,
      main_category_name: null,
      sub_category_name: null,
      created_at: new Date().toISOString(),
      stock: 5,
      low_stock_threshold: 1,
      status: "active",
    },
  ],
  total: 2,
  page: 1,
  pageSize: 10,
};

async function setupPage(page: import("@playwright/test").Page) {
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
      body: JSON.stringify(MOCK_CATEGORIES),
    });
  });

  await page.route(/\/api\/base-items\/summary/, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(MOCK_SUMMARY),
    });
  });

  await page.route(/\/api\/base-items\b/, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(MOCK_ITEMS),
    });
  });
}

/**
 * Navigate to the base-items list and wait until the page shell is fully
 * rendered.  `waitUntil: "domcontentloaded"` avoids hangs caused by Clerk FAPI
 * calls (all mocked) before we assert on anything, and the heading check
 * confirms the component has mounted and Clerk's session is settled.
 */
async function gotoBaseItems(page: import("@playwright/test").Page, path = "/base-items") {
  await page.goto(path, { waitUntil: "domcontentloaded" });
  await expect(page.getByRole("heading", { name: "Base Items", level: 1 })).toBeVisible({
    timeout: 15_000,
  });
}

// ---------------------------------------------------------------------------
// Status filter
// ---------------------------------------------------------------------------

test.describe("Base Items — status filter", () => {
  test("selecting 'Archived' sends status=archived to the API", async ({ page }) => {
    await setupPage(page);
    await gotoBaseItems(page);
    await expect(page.getByText("Rose Stem")).toBeVisible({ timeout: 5_000 });

    const [request] = await Promise.all([
      page.waitForRequest((req) =>
        req.url().includes("/api/base-items") &&
        !req.url().includes("/summary") &&
        req.url().includes("status=archived"),
      ),
      (async () => {
        const trigger = page.getByRole("combobox").filter({ hasText: "Active" }).first();
        await trigger.click();
        await page.getByRole("option", { name: "Archived" }).click();
      })(),
    ]);

    const url = new URL(request.url());
    expect(url.searchParams.get("status")).toBe("archived");
  });

  test("selecting 'All statuses' sends status=all to the API", async ({ page }) => {
    await setupPage(page);
    await gotoBaseItems(page);
    await expect(page.getByText("Rose Stem")).toBeVisible({ timeout: 5_000 });

    const [request] = await Promise.all([
      page.waitForRequest((req) =>
        req.url().includes("/api/base-items") &&
        !req.url().includes("/summary") &&
        req.url().includes("status=all"),
      ),
      (async () => {
        const trigger = page.getByRole("combobox").filter({ hasText: "Active" }).first();
        await trigger.click();
        await page.getByRole("option", { name: "All statuses" }).click();
      })(),
    ]);

    const url = new URL(request.url());
    expect(url.searchParams.get("status")).toBe("all");
  });

  test("selecting 'Merged' adds status=merged to the URL", async ({ page }) => {
    await setupPage(page);
    await gotoBaseItems(page);
    await expect(page.getByText("Rose Stem")).toBeVisible({ timeout: 5_000 });

    const trigger = page.getByRole("combobox").filter({ hasText: "Active" }).first();
    await trigger.click();
    await page.getByRole("option", { name: "Merged" }).click();

    await expect(page).toHaveURL(/[?&]status=merged/, { timeout: 5_000 });
  });

  test("navigating to /base-items?status=archived pre-selects the Archived option", async ({ page }) => {
    await setupPage(page);
    await gotoBaseItems(page, "/base-items?status=archived");

    const trigger = page.getByRole("combobox").filter({ hasText: "Archived" }).first();
    await expect(trigger).toBeVisible({ timeout: 5_000 });
  });
});

// ---------------------------------------------------------------------------
// Bulk archive
// ---------------------------------------------------------------------------

test.describe("Base Items — bulk archive", () => {
  test("selecting items reveals the bulk action bar", async ({ page }) => {
    await setupPage(page);
    await gotoBaseItems(page);
    await expect(page.getByText("Rose Stem")).toBeVisible({ timeout: 5_000 });

    const checkboxes = page.getByRole("checkbox");
    await checkboxes.first().click();

    await expect(page.getByText("1 item selected")).toBeVisible({ timeout: 3_000 });
  });

  test("selecting 2 items and clicking Archive Items shows confirmation dialog", async ({ page }) => {
    await setupPage(page);

    await page.route("**/api/base-items/bulk-archive", async (route) => {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true, archived: 2 }) });
    });

    await gotoBaseItems(page);
    await expect(page.getByRole("button", { name: "Rose Stem", exact: true })).toBeVisible({ timeout: 5_000 });

    await page.getByRole("checkbox", { name: "Select Rose Stem" }).click();
    await checkboxes.nth(1).click();

    await expect(page.getByText("2 items selected")).toBeVisible({ timeout: 3_000 });

    await page.getByRole("button", { name: "More Actions" }).click();
    await page.getByRole("menuitem", { name: "Archive Items" }).click();

    await expect(page.getByRole("alertdialog")).toBeVisible({ timeout: 5_000 });
    await expect(page.getByText("Archive 2 items?")).toBeVisible({ timeout: 3_000 });
  });

  test("confirming bulk archive fires POST /api/base-items/bulk-archive with selected ids", async ({ page }) => {
    await setupPage(page);

    let capturedBody: unknown = null;
    await page.route("**/api/base-items/bulk-archive", async (route) => {
      capturedBody = JSON.parse(route.request().postData() ?? "{}");
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true, archived: 2 }) });
    });

    await gotoBaseItems(page);
    await expect(page.getByRole("button", { name: "Rose Stem", exact: true })).toBeVisible({ timeout: 5_000 });

    await page.getByRole("checkbox", { name: "Select Rose Stem" }).click();
    await page.getByRole("checkbox", { name: "Select Blue Tulip" }).click();

    await page.getByRole("button", { name: "More Actions" }).click();
    await page.getByRole("menuitem", { name: "Archive Items" }).click();

    await expect(page.getByRole("alertdialog")).toBeVisible({ timeout: 5_000 });
    await page.getByRole("button", { name: /^Archive 2 items/ }).click();

    await expect(async () => {
      expect(capturedBody).not.toBeNull();
    }).toPass({ timeout: 5_000 });

    expect(capturedBody).toMatchObject({ ids: expect.arrayContaining([1, 2]) });
  });
});

// ---------------------------------------------------------------------------
// Bulk update category (opens dialog with items selected)
// ---------------------------------------------------------------------------

test.describe("Base Items — bulk update category", () => {
  const categories = {
    categories: [
      {
        id: 10,
        name: "Floral",
        parent_id: null,
        status: "active",
        subcategories: [
          { id: 11, name: "Roses", parent_id: 10, status: "active" },
          { id: 12, name: "Archived Stems", parent_id: 10, status: "archived" },
        ],
      },
      {
        id: 20,
        name: "Inactive Supplies",
        parent_id: null,
        status: "archived",
        subcategories: [],
      },
    ],
  };

  test("selecting items and clicking Update Category shows the category dialog", async ({ page }) => {
    await setupPage(page);
    await page.route("**/api/base-item-categories**", async (route) => {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(categories) });
    });

    await gotoBaseItems(page);
    await expect(page.getByRole("button", { name: "Rose Stem", exact: true })).toBeVisible({ timeout: 5_000 });

    await page.getByRole("checkbox", { name: "Select Rose Stem" }).click();

    await expect(page.getByText("1 item selected")).toBeVisible({ timeout: 3_000 });
    await page.getByRole("button", { name: "Update Category" }).click();

    const dialog = page.getByRole("dialog", { name: "Update Category" });
    await expect(dialog).toBeVisible({ timeout: 5_000 });
    await expect(dialog.getByRole("heading", { name: "Update Category" })).toBeVisible();
  });

  test("submits numeric item and category IDs, refreshes the table, closes, clears selection, and shows success", async ({ page }) => {
    await setupPage(page);
    await page.route("**/api/base-item-categories**", async (route) => {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(categories) });
    });

    let capturedBody: { ids?: unknown; category_id?: unknown } | null = null;
    let updated = false;
    await page.route(/\/api\/base-items(?:\?.*)?$/, async (route) => {
      const responseItems = updated
        ? {
            ...MOCK_ITEMS,
            items: MOCK_ITEMS.items.map((item) => ({
              ...item,
              category_id: 11,
              main_category_name: "Floral",
              sub_category_name: "Roses",
            })),
          }
        : MOCK_ITEMS;
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(responseItems),
      });
    });
    await page.route("**/api/base-items/bulk-update-category", async (route) => {
      capturedBody = JSON.parse(route.request().postData() ?? "{}");
      updated = true;
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ ok: true, updated: 2 }),
      });
    });

    await gotoBaseItems(page);
    await expect(page.getByRole("button", { name: "Rose Stem", exact: true })).toBeVisible({ timeout: 5_000 });
    await page.getByRole("checkbox", { name: "Select Rose Stem" }).click();
    await page.getByRole("checkbox", { name: "Select Blue Tulip" }).click();
    await expect(page.getByText("2 items selected")).toBeVisible();

    await page.getByRole("button", { name: "Update Category" }).click();
    await page.getByTestId("base-item-category-combobox-trigger").click();
    await expect(page.getByText("Inactive Supplies", { exact: true })).toHaveCount(0);
    await expect(page.getByText("Archived Stems", { exact: true })).toHaveCount(0);
    await page.getByText("Roses", { exact: true }).click();
    await page.getByRole("dialog", { name: "Update Category" }).getByRole("button", { name: "Update Category" }).click();

    await expect.poll(() => capturedBody).toEqual({ ids: [1, 2], category_id: 11 });
    expect(typeof capturedBody?.category_id).toBe("number");
    expect((capturedBody?.ids as unknown[]).every((id) => typeof id === "number")).toBe(true);
    await expect(page.getByRole("dialog", { name: "Update Category" })).toHaveCount(0);
    await expect(page.getByText("2 items selected")).toHaveCount(0);
    await expect(page.getByText("Category updated for 2 items", { exact: true })).toBeVisible();
    await expect(page.getByTestId("base-item-row-1").getByRole("cell", { name: "Floral › Roses", exact: true })).toBeVisible();
    await expect(page.getByTestId("base-item-row-2").getByRole("cell", { name: "Floral › Roses", exact: true })).toBeVisible();
  });

  test("keeps the dialog selection and shows the server error when the update fails", async ({ page }) => {
    await setupPage(page);
    await page.route("**/api/base-item-categories**", async (route) => {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(categories) });
    });
    await page.route("**/api/base-items/bulk-update-category", async (route) => {
      await route.fulfill({
        status: 400,
        contentType: "application/json",
        body: JSON.stringify({ error: "The selected category is no longer active" }),
      });
    });

    await gotoBaseItems(page);
    await expect(page.getByRole("button", { name: "Rose Stem", exact: true })).toBeVisible({ timeout: 5_000 });
    await page.getByRole("checkbox", { name: "Select Rose Stem" }).click();
    await page.getByRole("button", { name: "Update Category" }).click();
    await page.getByTestId("base-item-category-combobox-trigger").click();
    await page.getByText("Roses", { exact: true }).click();
    await page.getByRole("dialog", { name: "Update Category" }).getByRole("button", { name: "Update Category" }).click();

    await expect(page.getByRole("dialog", { name: "Update Category" })).toBeVisible();
    await expect(page.getByTestId("base-item-category-combobox-trigger")).toContainText("Floral › Roses");
    await expect(page.getByText("The selected category is no longer active", { exact: true })).toBeVisible();
    await expect(page.getByText("1 item selected")).toBeVisible();
  });

  test("the existing row-level category action still submits the single Base Item ID", async ({ page }) => {
    await setupPage(page);
    await page.route("**/api/base-item-categories**", async (route) => {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(categories) });
    });

    let capturedBody: { ids?: unknown; category_id?: unknown } | null = null;
    await page.route("**/api/base-items/bulk-update-category", async (route) => {
      capturedBody = JSON.parse(route.request().postData() ?? "{}");
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ ok: true, updated: 1 }),
      });
    });

    await gotoBaseItems(page);
    const roseRow = page.getByRole("row").filter({ hasText: "Rose Stem" });
    await roseRow.getByRole("button", { name: "More actions" }).click();
    await page.getByRole("menuitem", { name: "Update Category" }).click();
    await page.getByTestId("base-item-category-combobox-trigger").click();
    await page.getByText("Roses", { exact: true }).click();
    await page.getByRole("dialog", { name: "Update Category" }).getByRole("button", { name: "Update Category" }).click();

    await expect.poll(() => capturedBody).toEqual({ ids: [1], category_id: 11 });
    await expect(page.getByRole("dialog", { name: "Update Category" })).toHaveCount(0);
    await expect(page.getByText("Category updated for 1 item", { exact: true })).toBeVisible();
  });
});

// ---------------------------------------------------------------------------
// Merge flow
// ---------------------------------------------------------------------------

test.describe("Base Items — merge flow", () => {
  test("selecting 2 items shows enabled Merge Base Items button", async ({ page }) => {
    await setupPage(page);
    await gotoBaseItems(page);
    await expect(page.getByText("Rose Stem")).toBeVisible({ timeout: 5_000 });

    const checkboxes = page.getByRole("checkbox");
    await checkboxes.nth(0).click();
    await checkboxes.nth(1).click();

    const mergeButton = page.getByRole("button", { name: "Merge Base Items" });
    await expect(mergeButton).toBeVisible({ timeout: 3_000 });
    await expect(mergeButton).not.toBeDisabled();
  });

  test("selecting only 1 item shows disabled Merge Base Items button", async ({ page }) => {
    await setupPage(page);
    await gotoBaseItems(page);
    await expect(page.getByText("Rose Stem")).toBeVisible({ timeout: 5_000 });

    const checkboxes = page.getByRole("checkbox");
    await checkboxes.nth(0).click();

    const mergeButton = page.getByRole("button", { name: "Merge Base Items" });
    await expect(mergeButton).toBeVisible({ timeout: 3_000 });
    await expect(mergeButton).toBeDisabled();
  });

  test("clicking Merge Base Items opens the merge dialog with item list", async ({ page }) => {
    await setupPage(page);
    await gotoBaseItems(page);
    await expect(page.getByText("Rose Stem")).toBeVisible({ timeout: 5_000 });

    const checkboxes = page.getByRole("checkbox");
    await checkboxes.nth(0).click();
    await checkboxes.nth(1).click();

    await page.getByRole("button", { name: "Merge Base Items" }).click();

    await expect(page.getByRole("dialog")).toBeVisible({ timeout: 5_000 });
    await expect(page.getByText("Merge Base Items")).toBeVisible({ timeout: 3_000 });
    await expect(page.getByText("Select master item")).toBeVisible({ timeout: 3_000 });
    await expect(page.getByText("Rose Stem")).toBeVisible({ timeout: 3_000 });
    await expect(page.getByText("Blue Tulip")).toBeVisible({ timeout: 3_000 });
  });

  test("confirming merge fires POST /api/base-items/merge with ids and master_id", async ({ page }) => {
    await setupPage(page);

    let capturedBody: unknown = null;
    await page.route("**/api/base-items/merge", async (route) => {
      capturedBody = JSON.parse(route.request().postData() ?? "{}");
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true, master_id: 1, merged: [2] }) });
    });

    await gotoBaseItems(page);
    await expect(page.getByText("Rose Stem")).toBeVisible({ timeout: 5_000 });

    const checkboxes = page.getByRole("checkbox");
    await checkboxes.nth(0).click();
    await checkboxes.nth(1).click();

    await page.getByRole("button", { name: "Merge Base Items" }).click();
    await expect(page.getByRole("dialog")).toBeVisible({ timeout: 5_000 });

    const confirmCheckbox = page.locator("#merge-confirm");
    await confirmCheckbox.check();

    await page.getByRole("button", { name: "Merge Items" }).click();

    await expect(async () => {
      expect(capturedBody).not.toBeNull();
    }).toPass({ timeout: 5_000 });

    const body = capturedBody as { ids: number[]; master_id: number };
    expect(body.ids).toEqual(expect.arrayContaining([1, 2]));
    expect(typeof body.master_id).toBe("number");
  });
});

// ---------------------------------------------------------------------------
// Row-level duplicate
// ---------------------------------------------------------------------------

test.describe("Base Items — row-level duplicate", () => {
  test("clicking Duplicate in the row menu fires POST /api/base-items/:id/duplicate", async ({ page }) => {
    await setupPage(page);

    let duplicateUrl = "";
    await page.route(/\/api\/base-items\/\d+\/duplicate/, async (route) => {
      duplicateUrl = route.request().url();
      await route.fulfill({
        status: 201,
        contentType: "application/json",
        body: JSON.stringify({ item: { id: 99, name: "Copy of Rose Stem", code: "XXXXXX" } }),
      });
    });

    await gotoBaseItems(page);
    await expect(page.getByText("Rose Stem")).toBeVisible({ timeout: 5_000 });

    const roseRow = page.getByRole("row").filter({ hasText: "Rose Stem" });
    await roseRow.getByRole("button", { name: "More actions" }).click();

    await page.getByRole("menuitem", { name: "Duplicate" }).click();

    await expect(async () => {
      expect(duplicateUrl).toMatch(/\/api\/base-items\/1\/duplicate/);
    }).toPass({ timeout: 5_000 });
  });
});

// ---------------------------------------------------------------------------
// Row-level view usage
// ---------------------------------------------------------------------------

test.describe("Base Items — row-level view usage", () => {
  test("clicking View Usage opens a dialog showing product usage", async ({ page }) => {
    await setupPage(page);

    await page.route(/\/api\/base-items\/\d+\/usage/, async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          products: [
            { product_id: 10, product_name: "Red Rose Bouquet", quantity: 5, brand: "Florist Co", status: "available" },
          ],
        }),
      });
    });

    await gotoBaseItems(page);
    await expect(page.getByText("Rose Stem")).toBeVisible({ timeout: 5_000 });

    const roseRow = page.getByRole("row").filter({ hasText: "Rose Stem" });
    await roseRow.getByRole("button", { name: "More actions" }).click();

    await page.getByRole("menuitem", { name: "View Usage" }).click();

    await expect(page.getByRole("dialog")).toBeVisible({ timeout: 5_000 });
    await expect(page.getByText("Usage — Rose Stem")).toBeVisible({ timeout: 3_000 });
    await expect(page.getByText("Red Rose Bouquet")).toBeVisible({ timeout: 5_000 });
  });

  test("clicking View Usage for an item with no recipes shows empty state", async ({ page }) => {
    await setupPage(page);

    await page.route(/\/api\/base-items\/\d+\/usage/, async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ products: [] }),
      });
    });

    await gotoBaseItems(page);
    await expect(page.getByText("Rose Stem")).toBeVisible({ timeout: 5_000 });

    const roseRow = page.getByRole("row").filter({ hasText: "Rose Stem" });
    await roseRow.getByRole("button", { name: "More actions" }).click();

    await page.getByRole("menuitem", { name: "View Usage" }).click();

    await expect(page.getByRole("dialog")).toBeVisible({ timeout: 5_000 });
    await expect(page.getByText("Not used in any product recipes")).toBeVisible({ timeout: 5_000 });
  });
});

// ---------------------------------------------------------------------------
// Row-level archive
// ---------------------------------------------------------------------------

test.describe("Base Items — row-level archive", () => {
  test("clicking Archive in the row menu shows a confirmation dialog for a single item", async ({ page }) => {
    await setupPage(page);

    await page.route("**/api/base-items/bulk-archive", async (route) => {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true, archived: 1 }) });
    });

    await gotoBaseItems(page);
    await expect(page.getByText("Rose Stem")).toBeVisible({ timeout: 5_000 });

    const roseRow = page.getByRole("row").filter({ hasText: "Rose Stem" });
    await roseRow.getByRole("button", { name: "More actions" }).click();

    await page.getByRole("menuitem", { name: "Archive" }).click();

    await expect(page.getByRole("alertdialog")).toBeVisible({ timeout: 5_000 });
    await expect(page.getByText("Archive 1 item?")).toBeVisible({ timeout: 3_000 });
  });

  test("confirming row-level archive fires bulk-archive with a single id", async ({ page }) => {
    await setupPage(page);

    let capturedBody: unknown = null;
    await page.route("**/api/base-items/bulk-archive", async (route) => {
      capturedBody = JSON.parse(route.request().postData() ?? "{}");
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true, archived: 1 }) });
    });

    await gotoBaseItems(page);
    await expect(page.getByText("Rose Stem")).toBeVisible({ timeout: 5_000 });

    const roseRow = page.getByRole("row").filter({ hasText: "Rose Stem" });
    await roseRow.getByRole("button", { name: "More actions" }).click();

    await page.getByRole("menuitem", { name: "Archive" }).click();
    await expect(page.getByRole("alertdialog")).toBeVisible({ timeout: 5_000 });

    await page.getByRole("button", { name: /^Archive 1 item/ }).click();

    await expect(async () => {
      expect(capturedBody).not.toBeNull();
    }).toPass({ timeout: 5_000 });

    expect(capturedBody).toMatchObject({ ids: [1] });
  });
});

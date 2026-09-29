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

const MOCK_CATEGORIES = {
  categories: [
    {
      id: 1,
      name: "Floral",
      parent_id: null,
      subcategories: [{ id: 10, name: "Roses", parent_id: 1 }],
    },
  ],
};

type MockBaseItem = {
  id: number;
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
};

function makeItem(overrides: Partial<MockBaseItem> = {}): MockBaseItem {
  return {
    id: 42,
    name: "Red Roses",
    code: "BI0001",
    image_url: "/uploads/red-roses.jpg",
    category_id: 10,
    alternate_name: "Rosa Rouge",
    accounting_category: "Cost of Goods",
    tax_rate: "10",
    main_category_name: "Floral",
    sub_category_name: "Roses",
    created_at: new Date().toISOString(),
    ...overrides,
  };
}

function ownerUsersResponse() {
  return {
    members: [],
    me: {
      role: "owner",
      email: OWNER_EMAIL,
      allowedPages: null,
      customRoleId: null,
    },
  };
}

type SetupOptions = {
  initialItem?: MockBaseItem;
};

type SetupResult = {
  getCurrentItem: () => MockBaseItem;
  getLastPatchBody: () => Record<string, unknown> | null;
  getPatchCallCount: () => number;
};

async function setupPage(
  page: import("@playwright/test").Page,
  options: SetupOptions = {},
): Promise<SetupResult> {
  let currentItem: MockBaseItem = options.initialItem ?? makeItem();
  let lastPatchBody: Record<string, unknown> | null = null;
  let patchCallCount = 0;

  await page.route("**/api/**", async (route) => {
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({}) });
  });

  await page.route("**/api/users**", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(ownerUsersResponse()),
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
      body: JSON.stringify({ total: 1, flower: 0, packaging: 0, uncategorized: 1 }),
    });
  });

  await page.route(/\/api\/base-items\b/, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ items: [currentItem], total: 1, page: 1, pageSize: 10 }),
    });
  });

  await page.route(`**/api/base-items/${(options.initialItem ?? currentItem).id}`, async (route) => {
    if (route.request().method() === "PATCH") {
      patchCallCount += 1;
      const body = JSON.parse(route.request().postData() ?? "{}") as Record<string, unknown>;
      lastPatchBody = body;
      currentItem = {
        ...currentItem,
        name: typeof body.name === "string" ? body.name : currentItem.name,
        image_url:
          body.image_url === null || typeof body.image_url === "string"
            ? (body.image_url as string | null)
            : currentItem.image_url,
        category_id:
          body.category_id === null || typeof body.category_id === "number"
            ? (body.category_id as number | null)
            : currentItem.category_id,
        alternate_name:
          body.alternate_name === null || typeof body.alternate_name === "string"
            ? (body.alternate_name as string | null)
            : currentItem.alternate_name,
        accounting_category:
          body.accounting_category === null || typeof body.accounting_category === "string"
            ? (body.accounting_category as string | null)
            : currentItem.accounting_category,
        tax_rate:
          body.tax_rate === null || typeof body.tax_rate === "string"
            ? (body.tax_rate as string | null)
            : currentItem.tax_rate,
      };
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ item: currentItem }),
      });
    } else {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ item: currentItem }),
      });
    }
  });

  return {
    getCurrentItem: () => currentItem,
    getLastPatchBody: () => lastPatchBody,
    getPatchCallCount: () => patchCallCount,
  };
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

test.describe("Base Items list edit dialog: optional fields", () => {
  test("opens with optional fields pre-populated and persists edits", async ({ page }) => {
    const ctx = await setupPage(page);
    await gotoBaseItems(page);

    const editButton = page.getByTestId("button-edit-base-item-42");
    await expect(editButton).toBeVisible({ timeout: 5_000 });
    await editButton.click();

    const altInput = page.getByTestId("input-base-item-alternate-name");
    const accountingInput = page.getByTestId("input-base-item-accounting-category");
    const taxRateInput = page.getByTestId("input-base-item-tax-rate");

    await expect(altInput).toBeVisible({ timeout: 5_000 });
    await expect(altInput).toHaveValue("Rosa Rouge");
    await expect(accountingInput).toHaveValue("Cost of Goods");
    await expect(taxRateInput).toHaveValue("10");

    await altInput.fill("Rote Rosen");
    await accountingInput.fill("Raw Materials");
    await taxRateInput.fill("7.5");

    await page.getByRole("button", { name: /^Save$/ }).click();

    await expect(page.getByRole("dialog")).toHaveCount(0, { timeout: 8_000 });

    expect(ctx.getPatchCallCount()).toBe(1);
    const body = ctx.getLastPatchBody();
    expect(body).not.toBeNull();
    expect((body as Record<string, unknown>).name).toBe("Red Roses");
    expect((body as Record<string, unknown>).alternate_name).toBe("Rote Rosen");
    expect((body as Record<string, unknown>).accounting_category).toBe("Raw Materials");
    expect((body as Record<string, unknown>).tax_rate).toBe("7.5");

    await page.getByTestId("button-edit-base-item-42").click();
    await expect(page.getByTestId("input-base-item-alternate-name")).toHaveValue(
      "Rote Rosen",
      { timeout: 5_000 },
    );
    await expect(page.getByTestId("input-base-item-accounting-category")).toHaveValue(
      "Raw Materials",
    );
    await expect(page.getByTestId("input-base-item-tax-rate")).toHaveValue("7.5");
  });

  test("editing only the name preserves the existing optional fields", async ({ page }) => {
    const ctx = await setupPage(page);
    await gotoBaseItems(page);

    const editButton = page.getByTestId("button-edit-base-item-42");
    await expect(editButton).toBeVisible({ timeout: 5_000 });
    await editButton.click();

    const nameInput = page.getByTestId("input-base-item-name");
    await expect(nameInput).toBeVisible({ timeout: 5_000 });
    await expect(page.getByTestId("input-base-item-alternate-name")).toHaveValue("Rosa Rouge");
    await expect(page.getByTestId("input-base-item-accounting-category")).toHaveValue(
      "Cost of Goods",
    );
    await expect(page.getByTestId("input-base-item-tax-rate")).toHaveValue("10");

    await nameInput.fill("Crimson Roses");

    await page.getByRole("button", { name: /^Save$/ }).click();

    await expect(page.getByRole("dialog")).toHaveCount(0, { timeout: 8_000 });

    expect(ctx.getPatchCallCount()).toBe(1);
    const body = ctx.getLastPatchBody();
    expect(body).not.toBeNull();
    expect((body as Record<string, unknown>).name).toBe("Crimson Roses");
    expect((body as Record<string, unknown>).alternate_name).toBe("Rosa Rouge");
    expect((body as Record<string, unknown>).accounting_category).toBe("Cost of Goods");
    expect((body as Record<string, unknown>).tax_rate).toBe("10");

    const updated = ctx.getCurrentItem();
    expect(updated.alternate_name).toBe("Rosa Rouge");
    expect(updated.accounting_category).toBe("Cost of Goods");
    expect(updated.tax_rate).toBe("10");

    await page.getByTestId("button-edit-base-item-42").click();
    await expect(page.getByTestId("input-base-item-name")).toHaveValue(
      "Crimson Roses",
      { timeout: 5_000 },
    );
    await expect(page.getByTestId("input-base-item-alternate-name")).toHaveValue("Rosa Rouge");
    await expect(page.getByTestId("input-base-item-accounting-category")).toHaveValue(
      "Cost of Goods",
    );
    await expect(page.getByTestId("input-base-item-tax-rate")).toHaveValue("10");
  });
});

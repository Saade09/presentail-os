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

type MockAuditEntry = {
  id: number;
  action: string;
  actor_name: string | null;
  affected_ids: number[];
  previous_values: unknown | null;
  new_values: unknown | null;
  created_at: string;
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

async function setupPage(
  page: import("@playwright/test").Page,
  item: MockBaseItem,
  auditEntries: MockAuditEntry[] = [],
) {
  await page.route("**/api/**", async (route) => {
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({}) });
  });

  await page.route("**/api/users**", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        members: [],
        me: { role: "owner", email: OWNER_EMAIL, allowedPages: null, customRoleId: null },
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
      body: JSON.stringify({ locationStatuses: [] }),
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

  await page.route(/\/api\/base-items\/42\/audit-log/, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        entries: auditEntries,
        total: auditEntries.length,
        page: 1,
        limit: 25,
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

test.describe("Base Item Detail — History tab", () => {
  test("History tab is visible and shows empty-state message when no audit events exist", async ({ page }) => {
    await setupPage(page, makeItem());
    await page.goto("/base-items/42", { waitUntil: "domcontentloaded" });

    await expect(page.getByRole("heading", { name: "Red Roses" })).toBeVisible({ timeout: 20_000 });

    await page.getByRole("tab", { name: "History" }).click();

    await expect(page.getByRole("heading", { name: "Audit Log" })).toBeVisible({ timeout: 5_000 });
    await expect(page.getByText("No audit log entries for this item yet.")).toBeVisible({ timeout: 5_000 });
  });

  test("History tab shows audit entries when they exist", async ({ page }) => {
    const entry: MockAuditEntry = {
      id: 1,
      action: "bulk_archive",
      actor_name: "Alice Admin",
      affected_ids: [42],
      previous_values: null,
      new_values: null,
      created_at: new Date(Date.now() - 3_600_000).toISOString(),
    };

    await setupPage(page, makeItem(), [entry]);
    await page.goto("/base-items/42", { waitUntil: "domcontentloaded" });

    await expect(page.getByRole("heading", { name: "Red Roses" })).toBeVisible({ timeout: 20_000 });

    await page.getByRole("tab", { name: "History" }).click();

    await expect(page.getByText("Archived")).toBeVisible({ timeout: 5_000 });
    await expect(page.getByText(/Alice Admin/)).toBeVisible({ timeout: 5_000 });
    await expect(page.getByText("1 event")).toBeVisible({ timeout: 5_000 });
  });

  test("History tab shows entry with multiple affected items badge", async ({ page }) => {
    const entry: MockAuditEntry = {
      id: 2,
      action: "bulk_update_category",
      actor_name: "Bob Owner",
      affected_ids: [42, 7, 9],
      previous_values: null,
      new_values: null,
      created_at: new Date(Date.now() - 7_200_000).toISOString(),
    };

    await setupPage(page, makeItem(), [entry]);
    await page.goto("/base-items/42", { waitUntil: "domcontentloaded" });

    await expect(page.getByRole("heading", { name: "Red Roses" })).toBeVisible({ timeout: 20_000 });

    await page.getByRole("tab", { name: "History" }).click();

    await expect(page.getByText("Category updated")).toBeVisible({ timeout: 5_000 });
    await expect(page.getByText("3 items")).toBeVisible({ timeout: 5_000 });
    await expect(page.getByText(/Bob Owner/)).toBeVisible({ timeout: 5_000 });
  });

  test("Audit log pagination: Prev/Next buttons appear and Next sends page=2", async ({ page }) => {
    const makeEntry = (id: number): MockAuditEntry => ({
      id,
      action: "bulk_archive",
      actor_name: "Alice Admin",
      affected_ids: [42],
      previous_values: null,
      new_values: null,
      created_at: new Date(Date.now() - id * 60_000).toISOString(),
    });

    const page1Entries = Array.from({ length: 25 }, (_, i) => makeEntry(i + 1));
    const page2Entries = [makeEntry(26)];

    await setupPage(page, makeItem(), page1Entries);

    await page.route(/\/api\/base-items\/42\/audit-log/, async (route) => {
      const url = new URL(route.request().url());
      const pageParam = parseInt(url.searchParams.get("page") ?? "1", 10);
      const entries = pageParam === 2 ? page2Entries : page1Entries;
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ entries, total: 26, page: pageParam, limit: 25 }),
      });
    });

    await page.goto("/base-items/42", { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading", { name: "Red Roses" })).toBeVisible({ timeout: 20_000 });

    await page.getByRole("tab", { name: "History" }).click();

    await expect(page.getByText("Page 1 of 2")).toBeVisible({ timeout: 5_000 });
    await expect(page.getByRole("button", { name: /Prev/i })).toBeDisabled();
    await expect(page.getByRole("button", { name: /Next/i })).toBeEnabled();

    const [request] = await Promise.all([
      page.waitForRequest(/\/api\/base-items\/42\/audit-log/),
      page.getByRole("button", { name: /Next/i }).click(),
    ]);

    expect(request.url()).toContain("page=2");
    await expect(page.getByText("Page 2 of 2")).toBeVisible({ timeout: 5_000 });
    await expect(page.getByRole("button", { name: /Next/i })).toBeDisabled();
    await expect(page.getByRole("button", { name: /Prev/i })).toBeEnabled();
  });
});

import { test, expect } from "./fixtures";

const MOCK_ALERT = {
  base_item_id: 7,
  base_item_name: "Red Roses",
  base_item_code: "BI0007",
  location_id: 3,
  location_name: "Main Warehouse",
  country: "🇱🇧",
  stock: 0,
  effective_threshold: 20,
  deficit: 20,
  dismissed: false,
  expires_at: null,
};

const MOCK_ITEMS = { items: [], total: 0, page: 1, pageSize: 10 };
const MOCK_SUMMARY = { total: 0, flower: 0, packaging: 0, uncategorized: 0 };
const MOCK_CATEGORIES = { categories: [] };

async function setupPage(
  page: import("@playwright/test").Page,
  getAlerts: () => { alerts: typeof MOCK_ALERT[]; total: number },
  onDismissPost?: (body: unknown) => void,
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

  await page.route(/\/api\/base-items\/stock-alerts\/dismiss/, async (route) => {
    const body = route.request().postDataJSON() as unknown;
    onDismissPost?.(body);
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ success: true }) });
  });

  await page.route(/\/api\/base-items\/stock-alerts/, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(getAlerts()),
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

async function gotoBaseItems(page: import("@playwright/test").Page) {
  await page.goto("/base-items", { waitUntil: "domcontentloaded" });
  await expect(page.getByRole("heading", { name: "Base Items", level: 1 })).toBeVisible({ timeout: 15_000 });
}

test.describe("Stock Alerts — snooze dropdown", () => {
  test("preset snooze (3 days) updates the snoozed badge in the panel header", async ({ page }) => {
    let snoozed = false;
    const dismissBody: unknown[] = [];

    await setupPage(
      page,
      () => ({
        alerts: [{ ...MOCK_ALERT, dismissed: snoozed, expires_at: snoozed ? new Date(Date.now() + 72 * 60 * 60 * 1000).toISOString() : null }],
        total: 1,
      }),
      (body) => {
        dismissBody.push(body);
        snoozed = true;
      },
    );

    await gotoBaseItems(page);

    await expect(page.getByText("Stock Alerts")).toBeVisible({ timeout: 10_000 });
    await expect(page.getByText("Red Roses")).toBeVisible({ timeout: 5_000 });

    const alertRow = page.locator(".group").filter({ hasText: "Red Roses" }).first();
    await alertRow.hover();

    const snoozeBtn = alertRow.getByTitle("Snooze alert");
    await expect(snoozeBtn).toBeVisible({ timeout: 3_000 });
    await snoozeBtn.click();

    const threeDaysItem = page.getByRole("menuitem", { name: /3 days/i });
    await expect(threeDaysItem).toBeVisible({ timeout: 3_000 });
    await threeDaysItem.click();

    await expect(page.getByText(/1 snoozed/)).toBeVisible({ timeout: 5_000 });

    expect(dismissBody).toHaveLength(1);
    expect(dismissBody[0]).toMatchObject({
      base_item_id: 7,
      location_id: 3,
      stock: 0,
      duration_hours: 72,
    });
  });

  test("custom date snooze opens a date dialog and fires the dismiss mutation with expires_at", async ({ page }) => {
    let snoozed = false;
    const dismissBody: unknown[] = [];

    const futureDate = new Date();
    futureDate.setDate(futureDate.getDate() + 5);
    const futureDateStr = futureDate.toISOString().slice(0, 10);

    await setupPage(
      page,
      () => ({
        alerts: [{ ...MOCK_ALERT, dismissed: snoozed, expires_at: snoozed ? futureDate.toISOString() : null }],
        total: 1,
      }),
      (body) => {
        dismissBody.push(body);
        snoozed = true;
      },
    );

    await gotoBaseItems(page);

    await expect(page.getByText("Stock Alerts")).toBeVisible({ timeout: 10_000 });
    await expect(page.getByText("Red Roses")).toBeVisible({ timeout: 5_000 });

    const alertRow = page.locator(".group").filter({ hasText: "Red Roses" }).first();
    await alertRow.hover();

    const snoozeBtn = alertRow.getByTitle("Snooze alert");
    await expect(snoozeBtn).toBeVisible({ timeout: 3_000 });
    await snoozeBtn.click();

    const customItem = page.getByRole("menuitem", { name: /custom date/i });
    await expect(customItem).toBeVisible({ timeout: 3_000 });
    await customItem.click();

    await expect(page.getByRole("dialog")).toBeVisible({ timeout: 3_000 });
    await expect(page.getByText("Snooze until…")).toBeVisible({ timeout: 3_000 });

    const dateInput = page.getByRole("dialog").locator('input[type="date"]');
    await dateInput.fill(futureDateStr);

    const confirmBtn = page.getByRole("dialog").getByRole("button", { name: "Snooze" });
    await confirmBtn.click();

    await expect(page.getByRole("dialog")).not.toBeVisible({ timeout: 3_000 });

    await expect(page.getByText(/1 snoozed/)).toBeVisible({ timeout: 5_000 });

    expect(dismissBody).toHaveLength(1);
    const payload = dismissBody[0] as Record<string, unknown>;
    expect(payload.base_item_id).toBe(7);
    expect(payload.location_id).toBe(3);
    expect(payload.stock).toBe(0);
    expect(typeof payload.expires_at).toBe("string");
    const parsedDate = new Date(payload.expires_at as string);
    expect(parsedDate.toISOString().slice(0, 10)).toBe(futureDateStr);
  });
});

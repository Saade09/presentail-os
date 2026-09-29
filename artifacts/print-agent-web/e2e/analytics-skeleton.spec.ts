import { test, expect } from "./fixtures";
import { setupClerkTestingToken } from "@clerk/testing/playwright";

const MOCK_ANALYTICS = {
  summary: { total: 99, completed: 88, failed: 11, pages_printed: 177 },
  previous_summary: { total: 60, completed: 55, failed: 5, pages_printed: 130 },
  daily: [
    { date: "2025-04-20", count: 15 },
    { date: "2025-04-21", count: 22 },
    { date: "2025-04-22", count: 18 },
    { date: "2025-04-23", count: 10 },
    { date: "2025-04-24", count: 34 },
  ],
  devices: [
    {
      id: 1,
      name: "Test Printer",
      last_seen_at: new Date().toISOString(),
      online: true,
    },
  ],
  offline_alert_threshold_minutes: 5,
};

test.describe("Analytics loading skeleton", () => {
  test(
    "skeleton is visible while analytics loads and disappears when data arrives",
    async ({ page }) => {
      await setupClerkTestingToken({ page });

      await page.route("**/api/users**", async (route) => {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            members: [
              {
                id: "test-user",
                email: "e2e-tester@presentail.com",
                role: "owner",
              },
            ],
            me: { role: "owner", email: "e2e-tester@presentail.com" },
          }),
        });
      });

      let releaseAnalytics!: () => void;
      const analyticsGate = new Promise<void>((resolve) => {
        releaseAnalytics = resolve;
      });

      await page.route("**/api/analytics**", async (route) => {
        await analyticsGate;
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify(MOCK_ANALYTICS),
        });
      });

      await page.goto("/analytics", { waitUntil: "domcontentloaded" });
      await expect(page.getByRole("heading", { name: "Analytics" })).toBeVisible({ timeout: 15_000 });

      await expect(
        page.getByTestId("stat-value-skeleton").first(),
      ).toBeVisible({ timeout: 12_000 });

      await expect(
        page.getByTestId("stat-trend-skeleton").first(),
      ).toBeVisible();

      await expect(page.getByTestId("chart-skeleton")).toBeVisible();

      releaseAnalytics();

      await expect(
        page.getByTestId("stat-value-skeleton").first(),
      ).not.toBeVisible({ timeout: 8_000 });

      await expect(page.getByTestId("chart-skeleton")).not.toBeVisible();

      await expect(
        page.getByRole("heading", { name: "Analytics" }),
      ).toBeVisible();

      const valueTexts = await page.getByRole("paragraph").allTextContents();
      expect(valueTexts.some((t) => t.includes("99"))).toBe(true);
      expect(valueTexts.some((t) => t.includes("88"))).toBe(true);
    },
  );
});

import { test, expect } from "./fixtures";
import { setupClerkTestingToken } from "@clerk/testing/playwright";

const OWNER_EMAIL = "e2e-tester@presentail.com";

const MOCK_USERS = {
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

const MOCK_ROLES = {
  roles: [
    { id: 10, name: "Staff", allowed_pages: null },
    { id: 20, name: "Admin", allowed_pages: null },
  ],
};

const INITIAL_PROFILE = {
  phone: null,
  job_title: null,
  birthday: null,
  gender: null,
};

async function setupRoutes(page: import("@playwright/test").Page) {
  await page.route("**/api/users**", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(MOCK_USERS),
    });
  });
  await page.route("**/api/roles**", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(MOCK_ROLES),
    });
  });
  await page.route("**/api/profile**", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(INITIAL_PROFILE),
    });
  });
}

test.describe("Sidebar role-switcher visibility", () => {
  for (const viewport of [
    { width: 1280, height: 600 },
    { width: 1280, height: 900 },
  ]) {
    test(`stays pinned to bottom of sidebar at ${viewport.width}x${viewport.height}`, async ({
      page,
    }) => {
      await setupClerkTestingToken({ page });
      await setupRoutes(page);

      await page.setViewportSize(viewport);
      await page.goto("/profile", { waitUntil: "domcontentloaded" });

      await expect(page.getByRole("heading", { name: "Profile" })).toBeVisible({
        timeout: 15_000,
      });

      const switcher = page.getByTestId("view-as-select");
      await expect(switcher).toBeVisible({ timeout: 10_000 });
      await expect(switcher).toBeInViewport();

      const initialBox = await switcher.boundingBox();
      expect(initialBox).not.toBeNull();

      // Find the dashboard's main scroll container — it's the only md:overflow-y-auto
      // descendant of the layout root. Scroll it to the bottom and assert the
      // sidebar role switcher hasn't moved.
      const scrolled = await page.evaluate(() => {
        const candidates = Array.from(
          document.querySelectorAll<HTMLElement>("div"),
        ).filter((el) => {
          const style = window.getComputedStyle(el);
          return (
            style.overflowY === "auto" &&
            el.scrollHeight > el.clientHeight + 10
          );
        });
        const main = candidates.find((el) => el.querySelector("main")) ??
          candidates[0];
        if (!main) return false;
        main.scrollTop = main.scrollHeight;
        return true;
      });
      expect(scrolled).toBe(true);

      // Give the browser a tick to settle the scroll.
      await page.waitForTimeout(100);

      await expect(switcher).toBeVisible();
      await expect(switcher).toBeInViewport();

      const afterBox = await switcher.boundingBox();
      expect(afterBox).not.toBeNull();
      expect(Math.abs(afterBox!.y - initialBox!.y)).toBeLessThan(2);

      // Ensure the trigger is clickable without further scrolling — the
      // dropdown should open and present the mocked role options.
      await switcher.click();
      await expect(page.getByRole("option", { name: "Staff" })).toBeVisible({
        timeout: 5_000,
      });
      await expect(page.getByRole("option", { name: "Admin" })).toBeVisible();
    });
  }
});

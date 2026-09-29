// e2e-unauthenticated
import { test, expect } from "@playwright/test";

test.describe("Sign-in page — expired / invalid ticket", () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  test(
    "navigating to /sign-in?__clerk_ticket=invalid shows the expired error banner and keeps sign-in methods accessible",
    async ({ page }) => {
      await page.goto("/sign-in?__clerk_ticket=invalid", { waitUntil: "domcontentloaded" });

      const errorBanner = page.getByRole("alert").filter({
        hasText: /sign-in link has expired or is invalid/i,
      });

      await expect(errorBanner).toBeVisible({ timeout: 15_000 });

      await expect(
        page.getByText("Continue with Google"),
      ).toBeVisible({ timeout: 5_000 });

      await expect(
        page.getByText("Continue with Email + Password"),
      ).toBeVisible();

      await expect(
        page.getByText("Continue with Email (One-Time Code)"),
      ).toBeVisible();
    },
  );
});

test.describe("Sign-in page — already-used ticket", () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  test(
    "navigating to /sign-in?__clerk_ticket=used shows the already-accepted error banner and keeps sign-in methods accessible",
    async ({ page }) => {
      await page.route("**/client/sign_ins**", async (route) => {
        if (route.request().method() === "POST") {
          await route.fulfill({
            status: 422,
            contentType: "application/json",
            body: JSON.stringify({
              errors: [
                {
                  code: "invitation_already_accepted",
                  message: "Invitation already accepted",
                  longMessage: "This invitation has already been accepted.",
                  meta: {},
                },
              ],
              clerk_trace_id: "test-trace-id",
            }),
          });
        } else {
          await route.continue();
        }
      });

      await page.goto("/sign-in?__clerk_ticket=used", { waitUntil: "domcontentloaded" });

      const errorBanner = page.getByRole("alert").filter({
        hasText: /invitation has already been accepted/i,
      });

      await expect(errorBanner).toBeVisible({ timeout: 15_000 });

      await expect(
        page.getByText("Continue with Google"),
      ).toBeVisible({ timeout: 5_000 });

      await expect(
        page.getByText("Continue with Email + Password"),
      ).toBeVisible();

      await expect(
        page.getByText("Continue with Email (One-Time Code)"),
      ).toBeVisible();
    },
  );
});

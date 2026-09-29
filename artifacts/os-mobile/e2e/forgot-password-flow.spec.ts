/** Regression coverage for the retained password-reset information route. */
import { test, expect } from "@playwright/test";
import { mockClerkNoSession } from "./clerk-no-session-mock";

test.describe("Forgot-password information", () => {
  test("direct reset route explains the web reset path without exposing registration", async ({
    page,
  }) => {
    await mockClerkNoSession(page);
    await page.goto("/forgot-password");

    await expect(page.getByTestId("forgot-password-title")).toBeVisible({
      timeout: 20_000,
    });
    await expect(
      page.getByText(/password resets are managed through the presentail os web dashboard/i),
    ).toBeVisible();

    await expect(page.getByRole("link", { name: /sign up/i })).toHaveCount(0);
  });
});
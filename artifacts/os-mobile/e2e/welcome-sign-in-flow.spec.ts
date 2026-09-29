/** Regression coverage for the remaining unauthenticated mobile routes. */
import { test, expect } from "@playwright/test";
import { mockClerkNoSession } from "./clerk-no-session-mock";

test.describe("Unauthenticated sign-in flow", () => {
  test("sign-in exposes supported methods without public registration", async ({ page }) => {
    await mockClerkNoSession(page);
    await page.goto("/sign-in");

    await expect(page.getByText("Welcome back")).toBeVisible({
      timeout: 20_000,
    });
    await expect(page.getByText("Email address")).toBeVisible();
    await expect(page.getByTestId("email-input")).toBeVisible();
    await expect(page.getByText("Send me a code", { exact: true })).toBeVisible();
    await expect(page.getByText("Sign in with password", { exact: true })).toBeVisible();
    // Apple authentication is deliberately native-iOS-only; the web bundle
    // must remain usable and must not render a lookalike Apple button.
    await expect(page.getByTestId("apple-sign-in-button")).toHaveCount(0);

    await page.getByTestId("email-input").fill("member@example.com");
    await page.getByText("Sign in with password", { exact: true }).click();
    await expect(page.getByText("Password", { exact: true })).toBeVisible();
    await expect(page.getByTestId("password-input")).toBeVisible();

    await expect(page.getByRole("link", { name: /sign up/i })).toHaveCount(0);
    await expect(page.getByText(/create account/i)).toHaveCount(0);
  });

  test("legacy sign-up URL does not expose a registration screen", async ({ page }) => {
    await mockClerkNoSession(page);
    await page.goto("/sign-up");

    await expect(page.getByText("This screen doesn't exist.")).toBeVisible({
      timeout: 10_000,
    });
    await expect(page.getByTestId("signup-title")).toHaveCount(0);
    await expect(page.getByText(/create account/i)).toHaveCount(0);
  });
});

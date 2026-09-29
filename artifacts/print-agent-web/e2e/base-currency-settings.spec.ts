import { test, expect } from "./fixtures";
import { setupFapiWithFakeSession } from "./clerk-fapi-redirect";

// All API routes are mocked via page.route, so a fully static fake Clerk
// session is sufficient and avoids any dependency on the live FAPI host
// (clerk.presentail.com).
test.use({
  _fapiMock: [
    async ({ page }, use) => {
      await setupFapiWithFakeSession(page);
      await use();
    },
    { auto: true },
  ],
});

const OWNER_EMAIL = "e2e-tester+clerk_test@presentail.com";

function ownerUsersResponse() {
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

function exchangeRatesResponse(baseCurrency: string) {
  const otherCurrency = baseCurrency === "AED" ? "USD" : "AED";
  return {
    base_currency: baseCurrency,
    rates: [
      {
        base_currency: baseCurrency,
        target_currency: otherCurrency,
        rate: baseCurrency === "AED" ? 0.2723 : 3.6725,
        fetched_at: new Date().toISOString(),
      },
    ],
    last_fetched_at: new Date().toISOString(),
  };
}

function exchangeRateSettingsResponse(baseCurrency: string) {
  return {
    base_currency: baseCurrency,
    default_markup_percentage: 0,
    rounding_rule: "round_up_whole",
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
}

test.describe("Base Currency setting in Settings → Exchange Rates card", () => {
  test(
    "changing base currency to AED, saving, and reloading persists the selection and updates the rates label",
    async ({ page }) => {
      let savedBaseCurrency = "USD";

      await page.route("**/api/users**", async (route) => {
        if (route.request().method() === "GET") {
          await route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify(ownerUsersResponse()),
          });
          return;
        }
        await route.continue();
      });

      await page.route("**/api/settings**", async (route) => {
        if (route.request().method() === "GET") {
          await route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify({ available_countries: ["UAE"] }),
          });
          return;
        }
        await route.continue();
      });

      await page.route("**/api/admin/settings/countries**", async (route) => {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ countries: [] }),
        });
      });

      await page.route("**/api/exchange-rates", async (route) => {
        if (
          route.request().method() === "GET" &&
          !route.request().url().includes("convert")
        ) {
          await route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify(exchangeRatesResponse(savedBaseCurrency)),
          });
          return;
        }
        await route.continue();
      });

      await page.route("**/api/exchange-rate-settings**", async (route) => {
        const method = route.request().method();
        if (method === "GET") {
          await route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify(
              exchangeRateSettingsResponse(savedBaseCurrency),
            ),
          });
          return;
        }
        if (method === "PATCH") {
          const body = JSON.parse(
            route.request().postData() ?? "{}",
          ) as Record<string, unknown>;
          if (typeof body.base_currency === "string") {
            savedBaseCurrency = body.base_currency;
          }
          await route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify(
              exchangeRateSettingsResponse(savedBaseCurrency),
            ),
          });
          return;
        }
        await route.continue();
      });

      await page.goto("/settings", { waitUntil: "domcontentloaded" });
      await expect(page.getByRole("heading", { name: "Settings" })).toBeVisible({ timeout: 15_000 });

      const exchangeRatesCard = page.getByTestId("card-exchange-rates");
      await expect(exchangeRatesCard).toBeVisible({ timeout: 12_000 });

      await expect(
        page.getByText(/Current rates \(base: USD\)/i),
      ).toBeVisible();

      const baseCurrencySelect = page.getByTestId("select-base-currency");
      await expect(baseCurrencySelect).toBeVisible();

      await baseCurrencySelect.click();
      await page.getByRole("option", { name: /AED/i }).click();

      const saveButton = page.getByTestId("button-save-er-settings");
      await expect(saveButton).toBeEnabled({ timeout: 3_000 });
      await saveButton.click();

      await expect(
        page.getByText("Exchange rate settings saved"),
      ).toBeVisible({ timeout: 6_000 });

      await page.reload();

      await expect(exchangeRatesCard).toBeVisible({ timeout: 12_000 });

      await expect(baseCurrencySelect).toContainText("AED");

      await expect(
        page.getByText(/Current rates \(base: AED\)/i),
      ).toBeVisible({ timeout: 6_000 });
    },
  );
});

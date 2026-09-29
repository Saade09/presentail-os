import { test, expect } from "./fixtures";
import { setupClerkTestingToken } from "@clerk/testing/playwright";

const OWNER_EMAIL = "e2e-tester@presentail.com";

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

function usdBasedRatesResponse() {
  return {
    base_currency: "USD",
    rates: [
      { base_currency: "USD", target_currency: "AED", rate: 3.6725, fetched_at: new Date().toISOString() },
      { base_currency: "USD", target_currency: "EUR", rate: 0.921, fetched_at: new Date().toISOString() },
    ],
    last_fetched_at: new Date().toISOString(),
  };
}

function aedBasedRatesResponse() {
  return {
    base_currency: "AED",
    rates: [
      { base_currency: "AED", target_currency: "USD", rate: 0.2723, fetched_at: new Date().toISOString() },
      { base_currency: "AED", target_currency: "EUR", rate: 0.2508, fetched_at: new Date().toISOString() },
    ],
    last_fetched_at: new Date().toISOString(),
  };
}

test.describe("Exchange rate auto-refresh when base currency changes", () => {
  test(
    "changing base currency from USD to AED and saving triggers auto-refresh of rates",
    async ({ page }) => {
      await setupClerkTestingToken({ page });

      let exchangeRatesGetCount = 0;
      let refreshCallCount = 0;

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

      await page.route("**/api/exchange-rate-settings**", async (route) => {
        const method = route.request().method();
        if (method === "GET") {
          await route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify({
              base_currency: "USD",
              default_markup_percentage: 2,
              rounding_rule: "round_up_whole",
              created_at: new Date().toISOString(),
              updated_at: new Date().toISOString(),
            }),
          });
          return;
        }
        if (method === "PATCH") {
          await route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify({
              base_currency: "AED",
              default_markup_percentage: 2,
              rounding_rule: "round_up_whole",
              created_at: new Date().toISOString(),
              updated_at: new Date().toISOString(),
            }),
          });
          return;
        }
        await route.continue();
      });

      await page.route("**/api/exchange-rates**", async (route) => {
        const method = route.request().method();
        const url = route.request().url();
        if (method === "GET" && !url.includes("convert")) {
          exchangeRatesGetCount++;
          const body =
            exchangeRatesGetCount <= 2 ? usdBasedRatesResponse() : aedBasedRatesResponse();
          await route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify(body),
          });
          return;
        }
        if (method === "POST" && url.includes("/refresh")) {
          refreshCallCount++;
          await new Promise((r) => setTimeout(r, 600));
          await route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify(aedBasedRatesResponse()),
          });
          return;
        }
        await route.continue();
      });

      await page.goto("/settings", { waitUntil: "domcontentloaded" });
      await expect(page.getByRole("heading", { name: "Settings" })).toBeVisible({ timeout: 15_000 });

      const exchangeRatesCard = page.getByTestId("card-exchange-rates");
      await expect(exchangeRatesCard).toBeVisible({ timeout: 12_000 });

      await expect(page.getByText(/Current rates \(base: USD\)/)).toBeVisible({ timeout: 5_000 });

      await expect(page.getByText("AED")).toBeVisible();
      await expect(page.getByText("3.6725")).toBeVisible();

      const baseCurrencySelect = page.getByTestId("select-base-currency");
      await expect(baseCurrencySelect).toBeVisible();
      await baseCurrencySelect.click();

      await page.getByRole("option", { name: /AED/i }).click();

      const saveButton = page.getByTestId("button-save-er-settings");
      await expect(saveButton).toBeEnabled();
      await saveButton.click();

      await expect(saveButton).toContainText("Refreshing rates…", { timeout: 5_000 });

      await expect(page.getByText("Exchange rate settings saved")).toBeVisible({ timeout: 8_000 });

      await expect(page.getByText("Exchange rates refreshed successfully")).toBeVisible({
        timeout: 8_000,
      });

      await expect(page.getByText(/Current rates \(base: AED\)/)).toBeVisible({ timeout: 8_000 });

      expect(refreshCallCount).toBe(1);
    },
  );

  test(
    "Save settings button is disabled while refresh is in flight and cannot trigger a second refresh",
    async ({ page }) => {
      await setupClerkTestingToken({ page });

      let refreshCallCount = 0;

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

      await page.route("**/api/exchange-rate-settings**", async (route) => {
        const method = route.request().method();
        if (method === "GET") {
          await route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify({
              base_currency: "USD",
              default_markup_percentage: 2,
              rounding_rule: "round_up_whole",
              created_at: new Date().toISOString(),
              updated_at: new Date().toISOString(),
            }),
          });
          return;
        }
        if (method === "PATCH") {
          await route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify({
              base_currency: "AED",
              default_markup_percentage: 2,
              rounding_rule: "round_up_whole",
              created_at: new Date().toISOString(),
              updated_at: new Date().toISOString(),
            }),
          });
          return;
        }
        await route.continue();
      });

      let exchangeRatesGetCount = 0;
      await page.route("**/api/exchange-rates**", async (route) => {
        const method = route.request().method();
        const url = route.request().url();
        if (method === "GET" && !url.includes("convert")) {
          exchangeRatesGetCount++;
          const body =
            exchangeRatesGetCount <= 2 ? usdBasedRatesResponse() : aedBasedRatesResponse();
          await route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify(body),
          });
          return;
        }
        if (method === "POST" && url.includes("/refresh")) {
          refreshCallCount++;
          await new Promise((r) => setTimeout(r, 1_200));
          await route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify(aedBasedRatesResponse()),
          });
          return;
        }
        await route.continue();
      });

      await page.goto("/settings", { waitUntil: "domcontentloaded" });
      await expect(page.getByRole("heading", { name: "Settings" })).toBeVisible({ timeout: 15_000 });

      const exchangeRatesCard = page.getByTestId("card-exchange-rates");
      await expect(exchangeRatesCard).toBeVisible({ timeout: 12_000 });

      const baseCurrencySelect = page.getByTestId("select-base-currency");
      await expect(baseCurrencySelect).toBeVisible();
      await baseCurrencySelect.click();
      await page.getByRole("option", { name: /AED/i }).click();

      const saveButton = page.getByTestId("button-save-er-settings");
      await expect(saveButton).toBeEnabled();
      await saveButton.click();

      await expect(saveButton).toContainText("Refreshing rates…", { timeout: 5_000 });

      await expect(saveButton).toBeDisabled();

      await saveButton.click({ force: true });

      await expect(page.getByText("Exchange rates refreshed successfully")).toBeVisible({
        timeout: 10_000,
      });

      expect(refreshCallCount).toBe(1);
    },
  );

  test(
    "Save settings button shows Saving… and is disabled while the PATCH is in flight and prevents double-submission",
    async ({ page }) => {
      await setupClerkTestingToken({ page });

      let patchCallCount = 0;

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

      await page.route("**/api/exchange-rate-settings**", async (route) => {
        const method = route.request().method();
        if (method === "GET") {
          await route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify({
              base_currency: "USD",
              default_markup_percentage: 2,
              rounding_rule: "round_up_whole",
              created_at: new Date().toISOString(),
              updated_at: new Date().toISOString(),
            }),
          });
          return;
        }
        if (method === "PATCH") {
          patchCallCount++;
          await new Promise((r) => setTimeout(r, 1_200));
          await route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify({
              base_currency: "USD",
              default_markup_percentage: 5,
              rounding_rule: "round_up_whole",
              created_at: new Date().toISOString(),
              updated_at: new Date().toISOString(),
            }),
          });
          return;
        }
        await route.continue();
      });

      await page.route("**/api/exchange-rates**", async (route) => {
        const method = route.request().method();
        const url = route.request().url();
        if (method === "GET" && !url.includes("convert")) {
          await route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify(usdBasedRatesResponse()),
          });
          return;
        }
        await route.continue();
      });

      await page.goto("/settings", { waitUntil: "domcontentloaded" });
      await expect(page.getByRole("heading", { name: "Settings" })).toBeVisible({ timeout: 15_000 });

      const exchangeRatesCard = page.getByTestId("card-exchange-rates");
      await expect(exchangeRatesCard).toBeVisible({ timeout: 12_000 });

      const markupInput = page.getByTestId("input-exchange-markup");
      await expect(markupInput).toBeVisible({ timeout: 5_000 });
      await markupInput.fill("5");

      const saveButton = page.getByTestId("button-save-er-settings");
      await expect(saveButton).toBeEnabled();
      await saveButton.click();

      await expect(saveButton).toContainText("Saving…", { timeout: 5_000 });

      await expect(saveButton).toBeDisabled();

      await saveButton.click({ force: true });

      await expect(page.getByText("Exchange rate settings saved")).toBeVisible({ timeout: 8_000 });

      expect(patchCallCount).toBe(1);
    },
  );

  test(
    "saving settings without changing base currency does NOT trigger rate auto-refresh",
    async ({ page }) => {
      await setupClerkTestingToken({ page });

      let refreshCallCount = 0;

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

      await page.route("**/api/exchange-rate-settings**", async (route) => {
        const method = route.request().method();
        if (method === "GET") {
          await route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify({
              base_currency: "USD",
              default_markup_percentage: 2,
              rounding_rule: "round_up_whole",
              created_at: new Date().toISOString(),
              updated_at: new Date().toISOString(),
            }),
          });
          return;
        }
        if (method === "PATCH") {
          await route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify({
              base_currency: "USD",
              default_markup_percentage: 5,
              rounding_rule: "round_up_whole",
              created_at: new Date().toISOString(),
              updated_at: new Date().toISOString(),
            }),
          });
          return;
        }
        await route.continue();
      });

      await page.route("**/api/exchange-rates**", async (route) => {
        const method = route.request().method();
        const url = route.request().url();
        if (method === "GET" && !url.includes("convert")) {
          await route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify(usdBasedRatesResponse()),
          });
          return;
        }
        if (method === "POST" && url.includes("/refresh")) {
          refreshCallCount++;
          await route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify(usdBasedRatesResponse()),
          });
          return;
        }
        await route.continue();
      });

      await page.goto("/settings", { waitUntil: "domcontentloaded" });
      await expect(page.getByRole("heading", { name: "Settings" })).toBeVisible({ timeout: 15_000 });

      const exchangeRatesCard = page.getByTestId("card-exchange-rates");
      await expect(exchangeRatesCard).toBeVisible({ timeout: 12_000 });

      const markupInput = page.getByTestId("input-exchange-markup");
      await expect(markupInput).toBeVisible({ timeout: 5_000 });
      await markupInput.fill("5");

      const saveButton = page.getByTestId("button-save-er-settings");
      await expect(saveButton).toBeEnabled();
      await saveButton.click();

      await expect(page.getByText("Exchange rate settings saved")).toBeVisible({ timeout: 8_000 });

      await page.waitForTimeout(1_500);

      expect(refreshCallCount).toBe(0);
      await expect(page.getByText("Exchange rates refreshed successfully")).not.toBeVisible();
    },
  );
});

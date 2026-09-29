import { test, expect } from "./fixtures";

/**
 * Task #232 — Show a warning before saving if the new base currency has no stored rates yet.
 *
 * This spec stubs every relevant API call so it can verify the warning banner
 * purely in the UI without depending on database state or a live Clerk FAPI.
 *
 * Two scenarios are exercised:
 * (a) Selected base has NO stored rates  → warning banner appears.
 * (b) Selected base ALREADY has stored rates → warning banner does NOT appear.
 */

const OWNER_EMAIL = "e2e-tester+clerk_test@presentail.com";

function usersResponse(role: "owner" | "member") {
  return {
    members: [
      {
        id: 1,
        email: OWNER_EMAIL,
        role,
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
      role,
      email: OWNER_EMAIL,
      allowedPages: null,
      customRoleId: null,
    },
  };
}

async function setupCommonRoutes(page: import("@playwright/test").Page) {
  await page.route("**/api/users**", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(usersResponse("owner")),
    });
  });

  await page.route("**/api/settings*", async (route) => {
    if (route.request().method() !== "GET") { await route.continue(); return; }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        offline_alert_threshold_minutes: 5,
        offline_alert_email_enabled: false,
        available_countries: ["United Arab Emirates"],
        available_country_details: [],
        country_catalogue: [],
        undo_duration_seconds: 5,
      }),
    });
  });

  await page.route("**/api/admin/settings/countries**", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ countries: [] }),
    });
  });

  await page.route("**/api/exchange-rates/refresh**", async (route) => {
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ base_currency: "USD", rates: [], last_fetched_at: null }) });
  });

  await page.route("**/api/exchange-rate-settings**", async (route) => {
    if (route.request().method() !== "GET") { await route.continue(); return; }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        default_markup_percentage: 0,
        rounding_rule: "round_up_whole",
        base_currency: "USD",
        updated_at: "2026-05-05T00:00:00Z",
      }),
    });
  });
}

test.describe("Exchange Rates — no-rates-stored warning banner", () => {
  test("(a) shows warning when selected base differs and has no stored rates; hides when reverted", async ({ page }) => {
    await setupCommonRoutes(page);

    // Rates exist only for USD as base — AED has no stored rates as a base.
    await page.route("**/api/exchange-rates**", async (route) => {
      if (route.request().method() !== "GET") { await route.continue(); return; }
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          base_currency: "USD",
          rates: [
            { base_currency: "USD", target_currency: "AED", rate: 3.6725, fetched_at: "2026-05-05T00:00:00Z" },
            { base_currency: "USD", target_currency: "EUR", rate: 0.9123, fetched_at: "2026-05-05T00:00:00Z" },
          ],
          last_fetched_at: "2026-05-05T00:00:00Z",
        }),
      });
    });

    await page.goto("/settings", { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading", { name: "Settings" })).toBeVisible({ timeout: 15_000 });

    const card = page.getByTestId("card-exchange-rates");
    await expect(card).toBeVisible({ timeout: 15_000 });

    const warning = page.getByTestId("no-rates-warning");

    // Initially (baseCurrency === activeBase === "USD") — no warning.
    await expect(warning).not.toBeVisible();

    // Change base currency to AED (no stored AED-based rates → warning shows).
    await page.getByTestId("select-base-currency").click();
    await page.getByRole("option", { name: /AED/i }).click();

    await expect(warning).toBeVisible({ timeout: 3_000 });
    await expect(warning).toContainText("No rates stored yet for");
    await expect(warning).toContainText("AED");
    await expect(warning).toContainText("they will be fetched automatically on save");

    // Revert back to USD → warning disappears.
    await page.getByTestId("select-base-currency").click();
    await page.getByRole("option", { name: /USD/i }).click();

    await expect(warning).not.toBeVisible({ timeout: 3_000 });
  });

  test("(b) no warning when selected base already has stored rates", async ({ page }) => {
    await setupCommonRoutes(page);

    // Rates exist for USD (active) AND for EUR (previously stored).
    await page.route("**/api/exchange-rates**", async (route) => {
      if (route.request().method() !== "GET") { await route.continue(); return; }
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          base_currency: "USD",
          rates: [
            { base_currency: "USD", target_currency: "AED", rate: 3.6725, fetched_at: "2026-05-05T00:00:00Z" },
            { base_currency: "EUR", target_currency: "USD", rate: 1.0961, fetched_at: "2026-05-05T00:00:00Z" },
            { base_currency: "EUR", target_currency: "AED", rate: 4.0232, fetched_at: "2026-05-05T00:00:00Z" },
          ],
          last_fetched_at: "2026-05-05T00:00:00Z",
        }),
      });
    });

    await page.goto("/settings", { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading", { name: "Settings" })).toBeVisible({ timeout: 15_000 });

    const card = page.getByTestId("card-exchange-rates");
    await expect(card).toBeVisible({ timeout: 15_000 });

    const warning = page.getByTestId("no-rates-warning");

    // Switch to EUR — EUR already has stored rates in ratesData, so no warning.
    await page.getByTestId("select-base-currency").click();
    await page.getByRole("option", { name: /EUR/i }).click();

    await expect(warning).not.toBeVisible({ timeout: 3_000 });
  });
});

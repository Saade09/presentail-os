import { test, expect } from "./fixtures";
import { setupClerkTestingToken } from "@clerk/testing/playwright";

/**
 * Task #83 — Delivery Cities Management.
 *
 * This spec stubs every relevant API call so it can verify the Settings UI
 * end-to-end without depending on database state. It exercises the new
 * delivery toggle and "Manage Cities" modal that admins use to mark which
 * available countries are delivery-active and curate their city lists.
 */

test.describe("Delivery Cities Management", () => {
  test("owner toggles delivery, opens Manage Cities, creates and deletes a city", async ({ page }) => {
    await setupClerkTestingToken({ page });

    // ── Stub /api/settings (existing settings endpoint) ─────────────────────
    await page.route("**/api/settings", async (route) => {
      if (route.request().method() === "GET") {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            offline_alert_threshold_minutes: 5,
            offline_alert_email_enabled: false,
            available_countries: ["United Arab Emirates"],
            available_country_details: [
              { name: "United Arab Emirates", code: "ae", flagImageUrl: "/flags/ae.svg" },
            ],
            country_catalogue: [
              { name: "United Arab Emirates", code: "ae", flagImageUrl: "/flags/ae.svg" },
              { name: "Lebanon", code: "lb", flagImageUrl: "/flags/lb.svg" },
            ],
            undo_duration_seconds: 5,
          }),
        });
        return;
      }
      await route.continue();
    });

    // Track in-memory state so the UI sees consistent data after mutations.
    let deliveryActive = false;
    const cities: Array<{
      id: number;
      workspace_owner_id: string;
      country_code: string;
      name: string;
      slug: string;
      sort_order: number;
      is_active: boolean;
      created_at: string;
      updated_at: string;
    }> = [
      {
        id: 1,
        workspace_owner_id: "owner_e2e",
        country_code: "AE",
        name: "Dubai",
        slug: "dubai",
        sort_order: 1,
        is_active: true,
        created_at: "2026-01-01T00:00:00Z",
        updated_at: "2026-01-01T00:00:00Z",
      },
    ];
    let nextId = 2;

    await page.route("**/api/admin/settings/countries", async (route) => {
      if (route.request().method() !== "GET") {
        await route.continue();
        return;
      }
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          countries: [
            {
              name: "United Arab Emirates",
              code: "AE",
              flag_emoji: "🇦🇪",
              currency: "AED",
              delivery_active: deliveryActive,
              delivery_sort_order: 0,
              active_cities_count: cities.filter((c) => c.is_active).length,
            },
          ],
        }),
      });
    });

    await page.route("**/api/admin/settings/countries/AE/delivery", async (route) => {
      const body = JSON.parse(route.request().postData() ?? "{}");
      deliveryActive = !!body.delivery_active;
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          country_code: "AE",
          delivery_active: deliveryActive,
          delivery_sort_order: 0,
        }),
      });
    });

    await page.route("**/api/admin/settings/countries/AE/cities*", async (route) => {
      if (route.request().method() === "GET") {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ cities }),
        });
        return;
      }
      // POST = create
      const body = JSON.parse(route.request().postData() ?? "{}");
      const newCity = {
        id: nextId++,
        workspace_owner_id: "owner_e2e",
        country_code: "AE",
        name: String(body.name),
        slug: String(body.name).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, ""),
        sort_order: cities.length + 1,
        is_active: true,
        created_at: "2026-01-01T00:00:00Z",
        updated_at: "2026-01-01T00:00:00Z",
      };
      cities.push(newCity);
      await route.fulfill({
        status: 201,
        contentType: "application/json",
        body: JSON.stringify({ city: newCity }),
      });
    });

    await page.route(/\/api\/admin\/settings\/cities\/\d+$/, async (route) => {
      const url = route.request().url();
      const id = parseInt(url.split("/").pop() ?? "0", 10);
      if (route.request().method() === "DELETE") {
        const idx = cities.findIndex((c) => c.id === id);
        if (idx >= 0) cities.splice(idx, 1);
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ ok: true }),
        });
        return;
      }
      await route.continue();
    });

    await page.goto("/settings", { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading", { name: "Settings" })).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId("country-checklist")).toBeVisible({ timeout: 15_000 });

    // The delivery toggle is rendered for the checked country (UAE).
    const toggle = page.getByTestId("delivery-toggle-AE");
    await expect(toggle).toBeVisible();
    await expect(toggle).toHaveAttribute("data-state", "unchecked");

    // Toggle delivery on.
    await toggle.click();
    await expect(toggle).toHaveAttribute("data-state", "checked", { timeout: 5_000 });

    // Open the Manage Cities dialog.
    await page.getByTestId("manage-cities-AE").click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    await expect(dialog.getByText("Dubai")).toBeVisible({ timeout: 5_000 });

    // Add a city — slug auto-fills from name.
    await page.getByTestId("city-add-name").fill("Sharjah");
    await expect(page.getByTestId("city-add-slug")).toHaveValue("sharjah");
    await page.getByTestId("city-add-submit").click();
    await expect(dialog.getByText("Sharjah")).toBeVisible({ timeout: 5_000 });

    // Search filter narrows the list.
    await page.getByTestId("city-search-input").fill("dub");
    await expect(dialog.getByText("Dubai")).toBeVisible();
    await expect(dialog.getByText("Sharjah")).not.toBeVisible();
    await page.getByTestId("city-search-input").clear();

    // Delete it again.
    await page.getByTestId(`city-delete-${nextId - 1}`).click();
    await page.getByTestId("city-delete-confirm").click();
    await expect(dialog.getByText("Sharjah")).not.toBeVisible({ timeout: 5_000 });
  });
});

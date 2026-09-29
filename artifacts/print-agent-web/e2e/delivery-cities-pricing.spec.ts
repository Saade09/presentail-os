import { test, expect } from "./fixtures";
import { setupClerkTestingToken } from "@clerk/testing/playwright";
import type { Page } from "@playwright/test";

/**
 * Task #422 — Delivery Cities pricing configuration e2e tests.
 *
 * All API calls are stubbed so the tests run without live DB state.
 * Tests cover:
 *  - Creating a city with all delivery pricing fields
 *  - Conditional visibility of free-delivery threshold input
 *  - Conditional visibility of express-delivery fee + cutoff inputs
 *  - Inline card toggles firing PATCH and updating the UI optimistically
 *  - Summary stat cards reflecting the correct counts
 */

const OWNER_EMAIL = "e2e-tester+clerk_test@presentail.com";

type City = {
  id: number;
  country: string;
  name: string;
  slug: string;
  is_active: boolean;
  sort_order: number;
  delivery_fee: string | null;
  free_delivery_enabled: boolean;
  free_delivery_threshold: string | null;
  express_delivery_enabled: boolean;
  express_delivery_fee: string | null;
  express_delivery_cutoff_time: string | null;
  created_at: string;
};

function usersResponse(role: "owner" | "member" = "owner") {
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

function makeCity(overrides: Partial<City> & { id: number; name: string }): City {
  return {
    country: "Lebanon",
    slug: overrides.name.toLowerCase().replace(/[^a-z0-9]+/g, "-"),
    is_active: true,
    sort_order: overrides.id,
    delivery_fee: "5.00",
    free_delivery_enabled: false,
    free_delivery_threshold: null,
    express_delivery_enabled: false,
    express_delivery_fee: null,
    express_delivery_cutoff_time: null,
    created_at: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

/**
 * Registers all route mocks for the /cities page with a mutable in-memory
 * cities store. Returns a reference to the cities array so callers can
 * inspect or modify state after navigating.
 */
async function setupCitiesPage(
  page: Page,
  opts: {
    initialCities?: City[];
    countries?: string[];
    role?: "owner" | "member";
  } = {},
): Promise<{ cities: City[]; patchRequests: Array<{ id: number; body: Record<string, unknown> }> }> {
  await setupClerkTestingToken({ page });

  const cities: City[] = [...(opts.initialCities ?? [])];
  const countries = opts.countries ?? ["Lebanon"];
  const patchRequests: Array<{ id: number; body: Record<string, unknown> }> = [];
  let nextId = (cities.reduce((m, c) => Math.max(m, c.id), 0) || 0) + 1;
  const role = opts.role ?? "owner";

  await page.route("**/api/users/failed-access-requests**", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ failedRequests: [] }),
    }),
  );

  await page.route("**/api/users**", async (route) => {
    if (route.request().method() === "GET") {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(usersResponse(role)),
      });
      return;
    }
    await route.continue();
  });

  await page.route("**/api/access-requests**", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ requests: [] }),
    }),
  );

  await page.route("**/api/notifications**", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ notifications: [] }),
    }),
  );

  // GET + POST /api/cities
  await page.route(
    (url) => url.pathname === "/api/cities",
    async (route) => {
      const method = route.request().method();

      if (method === "GET") {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ cities, countries }),
        });
        return;
      }

      if (method === "POST") {
        const body = route.request().postDataJSON() as Partial<City>;
        const newCity: City = {
          id: nextId++,
          country: body.country ?? countries[0],
          name: String(body.name),
          slug:
            String(body.name)
              .toLowerCase()
              .replace(/[^a-z0-9]+/g, "-")
              .replace(/^-+|-+$/g, "") || "city",
          is_active: body.is_active ?? true,
          sort_order: body.sort_order ?? cities.length + 1,
          delivery_fee: body.delivery_fee != null ? String(body.delivery_fee) : "0.00",
          free_delivery_enabled: body.free_delivery_enabled ?? false,
          free_delivery_threshold:
            body.free_delivery_threshold != null
              ? String(body.free_delivery_threshold)
              : null,
          express_delivery_enabled: body.express_delivery_enabled ?? false,
          express_delivery_fee:
            body.express_delivery_fee != null
              ? String(body.express_delivery_fee)
              : null,
          express_delivery_cutoff_time: body.express_delivery_cutoff_time ?? null,
          created_at: new Date().toISOString(),
        };
        cities.push(newCity);
        await route.fulfill({
          status: 201,
          contentType: "application/json",
          body: JSON.stringify({ city: newCity }),
        });
        return;
      }

      await route.fulfill({ status: 405, body: "" });
    },
  );

  // PATCH + DELETE /api/cities/:id
  await page.route(
    (url) => /\/api\/cities\/\d+$/.test(url.pathname),
    async (route) => {
      const method = route.request().method();
      const idMatch = new URL(route.request().url()).pathname.match(/\/(\d+)$/);
      const id = idMatch ? parseInt(idMatch[1], 10) : NaN;
      const idx = cities.findIndex((c) => c.id === id);

      if (method === "PATCH") {
        const body = route.request().postDataJSON() as Record<string, unknown>;
        patchRequests.push({ id, body });
        if (idx >= 0) {
          cities[idx] = { ...cities[idx], ...(body as Partial<City>) };
        }
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ city: idx >= 0 ? cities[idx] : { id } }),
        });
        return;
      }

      if (method === "DELETE") {
        if (idx >= 0) cities.splice(idx, 1);
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ ok: true }),
        });
        return;
      }

      await route.fulfill({ status: 405, body: "" });
    },
  );

  await page.goto("/cities", { waitUntil: "domcontentloaded" });
  await expect(page.getByRole("heading", { name: "Delivery Cities" })).toBeVisible({ timeout: 15_000 });

  return { cities, patchRequests };
}

// ────────────────────────────────────────────────────────────────────────────
// Test suite
// ────────────────────────────────────────────────────────────────────────────

test.describe("Delivery Cities – pricing configuration", () => {
  test("creates a city with all delivery pricing fields and verifies the card", async ({
    page,
  }) => {
    const { cities } = await setupCitiesPage(page, {
      initialCities: [],
      countries: ["Lebanon"],
    });

    // Page loads with empty state
    await expect(
      page.getByText("No delivery cities yet"),
    ).toBeVisible({ timeout: 12_000 });

    // Open the create dialog via the empty-state button
    await page.getByRole("button", { name: /New city/i }).first().click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();

    // Fill city name
    await page.getByTestId("input-city-name").fill("Beirut");

    // Standard delivery fee
    await page.getByTestId("input-delivery-fee").fill("4.5");

    // Enable free delivery and set a threshold
    await page.getByTestId("switch-free-delivery").click();
    await expect(page.getByTestId("input-free-threshold")).toBeVisible();
    await page.getByTestId("input-free-threshold").fill("50");

    // Enable express delivery, set fee and cutoff
    await page.getByTestId("switch-express-delivery").click();
    await expect(page.getByTestId("input-express-fee")).toBeVisible();
    await expect(page.getByTestId("input-express-cutoff")).toBeVisible();
    await page.getByTestId("input-express-fee").fill("8");
    // Select hour 14 via the time picker
    await page.getByTestId("input-express-cutoff-hour").click();
    await page.getByRole("option", { name: "14" }).click();
    // Select minute 00 via the time picker
    await page.getByTestId("input-express-cutoff-minute").click();
    await page.getByRole("option", { name: "00" }).click();

    // Submit
    await page.getByTestId("button-confirm-city").click();

    // Dialog closes and city card appears
    await expect(dialog).not.toBeVisible({ timeout: 8_000 });

    const newCity = cities.find((c) => c.name === "Beirut");
    expect(newCity).toBeDefined();

    const card = page.getByTestId(`city-card-${newCity!.id}`);
    await expect(card).toBeVisible({ timeout: 8_000 });

    // Verify standard delivery fee shown on card
    await expect(card.getByText("$4.50")).toBeVisible();

    // Free delivery toggle is on and shows threshold
    const freeSwitch = card.getByTestId(`switch-free-${newCity!.id}`);
    await expect(freeSwitch).toBeVisible();
    await expect(freeSwitch).toHaveAttribute("data-state", "checked");
    await expect(card.getByText(/Above \$50\.00/)).toBeVisible();

    // Express delivery toggle is on and shows fee + cutoff
    const expressSwitch = card.getByTestId(`switch-express-${newCity!.id}`);
    await expect(expressSwitch).toBeVisible();
    await expect(expressSwitch).toHaveAttribute("data-state", "checked");
    await expect(card.getByText(/\$8\.00/)).toBeVisible();
    await expect(card.getByText(/14:00/)).toBeVisible();
  });

  test("free delivery threshold input appears only when the free delivery toggle is on", async ({
    page,
  }) => {
    await setupCitiesPage(page, {
      initialCities: [],
      countries: ["Lebanon"],
    });

    await expect(page.getByText("No delivery cities yet")).toBeVisible({
      timeout: 12_000,
    });

    // Open create dialog
    await page.getByRole("button", { name: /New city/i }).first().click();
    await expect(page.getByRole("dialog")).toBeVisible();

    // Threshold input should NOT be visible while toggle is off
    await expect(page.getByTestId("input-free-threshold")).not.toBeVisible();

    // Toggle ON → threshold appears
    await page.getByTestId("switch-free-delivery").click();
    await expect(page.getByTestId("input-free-threshold")).toBeVisible();

    // Toggle OFF → threshold disappears
    await page.getByTestId("switch-free-delivery").click();
    await expect(page.getByTestId("input-free-threshold")).not.toBeVisible();
  });

  test("express delivery inputs appear only when the express delivery toggle is on", async ({
    page,
  }) => {
    await setupCitiesPage(page, {
      initialCities: [],
      countries: ["Lebanon"],
    });

    await expect(page.getByText("No delivery cities yet")).toBeVisible({
      timeout: 12_000,
    });

    // Open create dialog
    await page.getByRole("button", { name: /New city/i }).first().click();
    await expect(page.getByRole("dialog")).toBeVisible();

    // Fee + cutoff inputs should NOT be visible while toggle is off
    await expect(page.getByTestId("input-express-fee")).not.toBeVisible();
    await expect(page.getByTestId("input-express-cutoff")).not.toBeVisible();

    // Toggle ON → both appear
    await page.getByTestId("switch-express-delivery").click();
    await expect(page.getByTestId("input-express-fee")).toBeVisible();
    await expect(page.getByTestId("input-express-cutoff")).toBeVisible();

    // Toggle OFF → both disappear
    await page.getByTestId("switch-express-delivery").click();
    await expect(page.getByTestId("input-express-fee")).not.toBeVisible();
    await expect(page.getByTestId("input-express-cutoff")).not.toBeVisible();
  });

  test("inline free/express delivery toggles on city cards fire PATCH and update the UI optimistically", async ({
    page,
  }) => {
    const cityId = 10;
    const { patchRequests } = await setupCitiesPage(page, {
      initialCities: [
        makeCity({
          id: cityId,
          name: "Sidon",
          free_delivery_enabled: false,
          express_delivery_enabled: false,
        }),
      ],
      countries: ["Lebanon"],
    });

    const card = page.getByTestId(`city-card-${cityId}`);
    await expect(card).toBeVisible({ timeout: 12_000 });

    const freeSwitch = page.getByTestId(`switch-free-${cityId}`);
    const expressSwitch = page.getByTestId(`switch-express-${cityId}`);

    // Both toggles start unchecked
    await expect(freeSwitch).toHaveAttribute("data-state", "unchecked");
    await expect(expressSwitch).toHaveAttribute("data-state", "unchecked");

    // Toggle free delivery ON — should flip immediately (optimistic update)
    await freeSwitch.click();
    await expect(freeSwitch).toHaveAttribute("data-state", "checked", {
      timeout: 5_000,
    });

    // A PATCH request for free_delivery_enabled should have been sent
    await page.waitForFunction(
      () => true,
      undefined,
      { timeout: 3_000 },
    );
    const freePatch = patchRequests.find(
      (r) => r.id === cityId && "free_delivery_enabled" in r.body,
    );
    expect(freePatch).toBeDefined();
    expect(freePatch?.body.free_delivery_enabled).toBe(true);

    // Toggle express delivery ON — should flip immediately
    await expressSwitch.click();
    await expect(expressSwitch).toHaveAttribute("data-state", "checked", {
      timeout: 5_000,
    });

    const expressPatch = patchRequests.find(
      (r) => r.id === cityId && "express_delivery_enabled" in r.body,
    );
    expect(expressPatch).toBeDefined();
    expect(expressPatch?.body.express_delivery_enabled).toBe(true);

    // Toggle free delivery OFF — should flip back
    await freeSwitch.click();
    await expect(freeSwitch).toHaveAttribute("data-state", "unchecked", {
      timeout: 5_000,
    });

    const freeOffPatch = patchRequests
      .filter((r) => r.id === cityId && "free_delivery_enabled" in r.body)
      .pop();
    expect(freeOffPatch?.body.free_delivery_enabled).toBe(false);
  });

  test("summary stat cards reflect the correct counts", async ({ page }) => {
    const initialCities: City[] = [
      makeCity({
        id: 1,
        name: "Beirut",
        is_active: true,
        free_delivery_enabled: true,
        express_delivery_enabled: true,
      }),
      makeCity({
        id: 2,
        name: "Tripoli",
        is_active: true,
        free_delivery_enabled: false,
        express_delivery_enabled: true,
      }),
      makeCity({
        id: 3,
        name: "Sidon",
        is_active: false,
        free_delivery_enabled: false,
        express_delivery_enabled: false,
      }),
    ];

    await setupCitiesPage(page, { initialCities, countries: ["Lebanon"] });

    // Wait for the page to load by checking one of the city cards
    await expect(page.getByTestId("city-card-1")).toBeVisible({
      timeout: 12_000,
    });

    // Total Cities: 3 cities across 1 country
    const totalCard = page.getByText("Total Cities").locator("..");
    await expect(totalCard.getByText("3")).toBeVisible();
    await expect(totalCard.getByText(/Across 1 country/)).toBeVisible();

    // Active Cities: 2 active (Beirut + Tripoli)
    const activeCard = page.getByText("Active Cities").locator("..");
    await expect(activeCard.getByText("2")).toBeVisible();
    await expect(activeCard.getByText(/67% of total/)).toBeVisible();

    // Free Delivery: 1 city (Beirut)
    const freeCard = page.getByText("Free Delivery").locator("..");
    await expect(freeCard.getByText("1")).toBeVisible();
    await expect(freeCard.getByText(/33% of cities/)).toBeVisible();

    // Express Delivery: 2 cities (Beirut + Tripoli)
    const expressCard = page.getByText("Express Delivery").locator("..");
    await expect(expressCard.getByText("2")).toBeVisible();
    await expect(expressCard.getByText(/67% of cities/)).toBeVisible();
  });

  test("edit dialog pre-fills existing values, saves changes, and card reflects updated pricing", async ({
    page,
  }) => {
    const cityId = 20;
    const { patchRequests } = await setupCitiesPage(page, {
      initialCities: [
        makeCity({
          id: cityId,
          name: "Jounieh",
          delivery_fee: "5.00",
          express_delivery_enabled: true,
          express_delivery_fee: "10.00",
          express_delivery_cutoff_time: "12:00",
        }),
      ],
      countries: ["Lebanon"],
    });

    const card = page.getByTestId(`city-card-${cityId}`);
    await expect(card).toBeVisible({ timeout: 12_000 });

    // Open the edit dialog
    await page.getByTestId(`button-edit-city-${cityId}`).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();

    // Delivery fee input should be pre-filled with the existing value
    await expect(page.getByTestId("input-delivery-fee")).toHaveValue("5");

    // Change the delivery fee
    await page.getByTestId("input-delivery-fee").fill("7.5");

    // Express delivery toggle should be pre-checked — turn it off
    const expressSwitch = page.getByTestId("switch-express-delivery");
    await expect(expressSwitch).toHaveAttribute("data-state", "checked");
    await expressSwitch.click();
    await expect(expressSwitch).toHaveAttribute("data-state", "unchecked");

    // Express fee and cutoff inputs should disappear after toggle off
    await expect(page.getByTestId("input-express-fee")).not.toBeVisible();
    await expect(page.getByTestId("input-express-cutoff")).not.toBeVisible();

    // Save
    await page.getByTestId("button-confirm-city").click();
    await expect(dialog).not.toBeVisible({ timeout: 8_000 });

    // Verify PATCH was sent with updated values
    const patch = patchRequests.find(
      (r) => r.id === cityId && "delivery_fee" in r.body,
    );
    expect(patch).toBeDefined();
    expect(patch?.body.delivery_fee).toBe(7.5);
    expect(patch?.body.express_delivery_enabled).toBe(false);

    // City card should show updated delivery fee
    await expect(card.getByText("$7.50")).toBeVisible({ timeout: 8_000 });

    // Express delivery toggle on the card should now be off
    const cardExpressSwitch = card.getByTestId(`switch-express-${cityId}`);
    await expect(cardExpressSwitch).toHaveAttribute("data-state", "unchecked");
  });

  test("turning off free delivery in the edit form hides threshold and sends null in PATCH", async ({
    page,
  }) => {
    const cityId = 30;
    const { patchRequests } = await setupCitiesPage(page, {
      initialCities: [
        makeCity({
          id: cityId,
          name: "Byblos",
          free_delivery_enabled: true,
          free_delivery_threshold: "40.00",
        }),
      ],
      countries: ["Lebanon"],
    });

    const card = page.getByTestId(`city-card-${cityId}`);
    await expect(card).toBeVisible({ timeout: 12_000 });

    // Open edit dialog
    await page.getByTestId(`button-edit-city-${cityId}`).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();

    // Free delivery toggle should be pre-checked and threshold should be visible
    const freeSwitch = page.getByTestId("switch-free-delivery");
    await expect(freeSwitch).toHaveAttribute("data-state", "checked");
    await expect(page.getByTestId("input-free-threshold")).toBeVisible();
    await expect(page.getByTestId("input-free-threshold")).toHaveValue("40");

    // Turn off free delivery
    await freeSwitch.click();
    await expect(freeSwitch).toHaveAttribute("data-state", "unchecked");

    // Threshold input should be hidden once toggle is off
    await expect(page.getByTestId("input-free-threshold")).not.toBeVisible();

    // Save
    await page.getByTestId("button-confirm-city").click();
    await expect(dialog).not.toBeVisible({ timeout: 8_000 });

    // PATCH body must contain free_delivery_enabled: false and free_delivery_threshold: null
    const patch = patchRequests.find(
      (r) => r.id === cityId && "free_delivery_enabled" in r.body,
    );
    expect(patch).toBeDefined();
    expect(patch?.body.free_delivery_enabled).toBe(false);
    expect(patch?.body.free_delivery_threshold).toBeNull();

    // Card inline free toggle should reflect the updated state
    const cardFreeSwitch = card.getByTestId(`switch-free-${cityId}`);
    await expect(cardFreeSwitch).toHaveAttribute("data-state", "unchecked", {
      timeout: 8_000,
    });
  });

  test("summary stat cards update after adding a new city with free and express delivery", async ({
    page,
  }) => {
    await setupCitiesPage(page, {
      initialCities: [
        makeCity({ id: 1, name: "Beirut", is_active: true }),
      ],
      countries: ["Lebanon"],
    });

    await expect(page.getByTestId("city-card-1")).toBeVisible({
      timeout: 12_000,
    });

    // Before: Total = 1, Active = 1, Free = 0, Express = 0
    const totalCard = page.getByText("Total Cities").locator("..");
    await expect(totalCard.getByText("1", { exact: true })).toBeVisible();

    const freeCard = page.getByText("Free Delivery").locator("..");
    await expect(freeCard.getByText("0", { exact: true })).toBeVisible();

    const expressCard = page.getByText("Express Delivery").locator("..");
    await expect(expressCard.getByText("0", { exact: true })).toBeVisible();

    // Add a new city with free + express enabled
    await page.getByTestId("button-new-city").click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();

    await page.getByTestId("input-city-name").fill("Tripoli");
    await page.getByTestId("input-delivery-fee").fill("3");
    await page.getByTestId("switch-free-delivery").click();
    await page.getByTestId("switch-express-delivery").click();
    await page.getByTestId("button-confirm-city").click();

    await expect(dialog).not.toBeVisible({ timeout: 8_000 });

    // After: Total = 2, Free = 1, Express = 1
    await expect(totalCard.getByText("2")).toBeVisible({ timeout: 8_000 });
    await expect(freeCard.getByText("1")).toBeVisible();
    await expect(expressCard.getByText("1")).toBeVisible();
  });

  test("deleting a city removes its card and decrements the stat cards", async ({
    page,
  }) => {
    const cityWithFeatures = makeCity({
      id: 1,
      name: "Beirut",
      is_active: true,
      free_delivery_enabled: true,
      express_delivery_enabled: true,
    });
    const cityPlain = makeCity({
      id: 2,
      name: "Tripoli",
      is_active: true,
      free_delivery_enabled: false,
      express_delivery_enabled: false,
    });

    await setupCitiesPage(page, {
      initialCities: [cityWithFeatures, cityPlain],
      countries: ["Lebanon"],
    });

    // Wait for both cards to load
    await expect(page.getByTestId("city-card-1")).toBeVisible({
      timeout: 12_000,
    });
    await expect(page.getByTestId("city-card-2")).toBeVisible();

    // Before: Total = 2, Active = 2, Free = 1, Express = 1
    const totalCard = page.getByText("Total Cities").locator("..");
    await expect(totalCard.getByText("2", { exact: true })).toBeVisible();

    const activeCard = page.getByText("Active Cities").locator("..");
    await expect(activeCard.getByText("2", { exact: true })).toBeVisible();

    const freeCard = page.getByText("Free Delivery").locator("..");
    await expect(freeCard.getByText("1", { exact: true })).toBeVisible();

    const expressCard = page.getByText("Express Delivery").locator("..");
    await expect(expressCard.getByText("1", { exact: true })).toBeVisible();

    // Open the delete dialog for city 1 (the one with free + express)
    await page.getByTestId("button-delete-city-1").click();

    const deleteDialog = page.getByTestId("dialog-delete-city");
    await expect(deleteDialog).toBeVisible({ timeout: 5_000 });

    // Confirm the deletion
    await page.getByTestId("button-confirm-delete-city").click();

    // The dialog should close and the city card should disappear
    await expect(deleteDialog).not.toBeVisible({ timeout: 8_000 });
    await expect(page.getByTestId("city-card-1")).not.toBeVisible({
      timeout: 8_000,
    });

    // City 2 card must still be visible
    await expect(page.getByTestId("city-card-2")).toBeVisible();

    // After: Total = 1, Active = 1, Free = 0, Express = 0
    await expect(totalCard.getByText("1", { exact: true })).toBeVisible({
      timeout: 8_000,
    });
    await expect(activeCard.getByText("1", { exact: true })).toBeVisible();
    await expect(freeCard.getByText("0", { exact: true })).toBeVisible();
    await expect(expressCard.getByText("0", { exact: true })).toBeVisible();
  });

  test("toggling a city's active switch decrements and increments the Active Cities stat card", async ({
    page,
  }) => {
    await setupCitiesPage(page, {
      initialCities: [
        makeCity({ id: 1, name: "Beirut", is_active: true }),
        makeCity({ id: 2, name: "Tripoli", is_active: true }),
      ],
      countries: ["Lebanon"],
    });

    // Wait for both city cards to load
    await expect(page.getByTestId("city-card-1")).toBeVisible({
      timeout: 12_000,
    });
    await expect(page.getByTestId("city-card-2")).toBeVisible();

    const activeCard = page.getByText("Active Cities").locator("..");

    // Initial state: Active Cities = 2
    await expect(activeCard.getByText("2", { exact: true })).toBeVisible();

    // Flip city 1 to inactive — Active Cities should decrement to 1
    const activeSwitch = page.getByTestId("switch-active-1");
    await expect(activeSwitch).toHaveAttribute("data-state", "checked");
    await activeSwitch.click();
    await expect(activeSwitch).toHaveAttribute("data-state", "unchecked", {
      timeout: 5_000,
    });
    await expect(activeCard.getByText("1", { exact: true })).toBeVisible({
      timeout: 5_000,
    });

    // Flip city 1 back to active — Active Cities should increment back to 2
    await activeSwitch.click();
    await expect(activeSwitch).toHaveAttribute("data-state", "checked", {
      timeout: 5_000,
    });
    await expect(activeCard.getByText("2", { exact: true })).toBeVisible({
      timeout: 5_000,
    });
  });

  test("deleting the only remaining city is blocked with a warning in the dialog", async ({
    page,
  }) => {
    const onlyCity = makeCity({ id: 99, name: "Batroun", is_active: true });

    await setupCitiesPage(page, {
      initialCities: [onlyCity],
      countries: ["Lebanon"],
    });

    // Confirm the single city card is visible
    const card = page.getByTestId("city-card-99");
    await expect(card).toBeVisible({ timeout: 12_000 });

    // Stats show exactly 1 city
    const totalCard = page.getByText("Total Cities").locator("..");
    await expect(totalCard.getByText("1", { exact: true })).toBeVisible();

    // Open the delete dialog for the only city
    await page.getByTestId("button-delete-city-99").click();
    const deleteDialog = page.getByTestId("dialog-delete-city");
    await expect(deleteDialog).toBeVisible({ timeout: 5_000 });

    // The confirmation button must be DISABLED — last-city guard is active
    const confirmBtn = page.getByTestId("button-confirm-delete-city");
    await expect(confirmBtn).toBeDisabled();

    // The inline warning message must be visible
    await expect(page.getByTestId("warning-last-city")).toBeVisible();
    await expect(
      page.getByText("You cannot delete the last city"),
    ).toBeVisible();

    // The city card must still be present — nothing was deleted
    await expect(card).toBeVisible();

    // Stat card still reflects 1 city
    await expect(totalCard.getByText("1", { exact: true })).toBeVisible();
  });
});

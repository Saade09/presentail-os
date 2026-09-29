import { test, expect } from "./fixtures";
import { setupClerkTestingToken } from "@clerk/testing/playwright";

// Regression coverage for the "Manage City Availability" panel. The panel
// previously shipped broken (showed "0 of 0 cities") because the backend
// city-availability endpoint 500'd and no e2e test exercised the panel through
// the real dashboard UI. This test opens the panel for an occasion, asserts the
// workspace delivery cities load (not the empty state), toggles a city OFF,
// saves, reopens the panel, and asserts the toggle persisted and the
// "X of Y cities enabled" counter updates correctly.

const OWNER_EMAIL = "e2e-tester+clerk_test@presentail.com";

type Occasion = {
  id: number;
  workspace_owner_id: string;
  name: string;
  slug: string;
  description: string | null;
  image_url: string | null;
  sort_order: number;
  is_active: boolean;
  product_count: number;
  enabled_city_count: number;
  created_at: string;
  updated_at: string;
};

type CityRow = {
  city_id: number;
  city_name: string;
  country_code: string;
  city_slug: string;
  city_is_active: boolean;
  is_enabled: boolean;
  updated_at: string | null;
};

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

function makeOccasion(
  id: number,
  name: string,
  overrides: Partial<Occasion> = {},
): Occasion {
  return {
    id,
    workspace_owner_id: "owner_e2e",
    name,
    slug: name.toLowerCase().replace(/[^a-z0-9]+/g, "-"),
    description: null,
    image_url: null,
    sort_order: 0,
    is_active: true,
    product_count: 0,
    enabled_city_count: 0,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    ...overrides,
  };
}

// Two workspace delivery cities, both enabled to start so the test can toggle
// one OFF and assert the change persists.
const ENABLED_CITIES: CityRow[] = [
  {
    city_id: 10,
    city_name: "Dubai",
    country_code: "AE",
    city_slug: "dubai",
    city_is_active: true,
    is_enabled: true,
    updated_at: null,
  },
  {
    city_id: 11,
    city_name: "Beirut",
    country_code: "LB",
    city_slug: "beirut",
    city_is_active: true,
    is_enabled: true,
    updated_at: null,
  },
];

/**
 * Sets up routes for the Occasions admin page with an in-memory store that
 * persists city-availability toggles across GET/PUT, so reopening the panel
 * reflects the saved state.
 */
async function setupOccasionsPage(
  page: import("@playwright/test").Page,
  initialOccasions: Occasion[],
) {
  const occasions: Occasion[] = [...initialOccasions];

  // City availability state keyed by occasion id (persists across PUT/GET).
  const cityAvailability: Record<number, CityRow[]> = {};
  for (const o of occasions) {
    cityAvailability[o.id] = ENABLED_CITIES.map((c) => ({ ...c }));
  }

  await setupClerkTestingToken({ page });

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

  // List occasions
  await page.route(
    (url) => url.pathname === "/api/occasions",
    async (route) => {
      if (route.request().method() === "GET") {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            items: occasions,
            total: occasions.length,
            page: 1,
            pageSize: 25,
            totalPages: 1,
          }),
        });
        return;
      }
      await route.fulfill({ status: 405, body: "" });
    },
  );

  // City availability — GET + PUT with persistence.
  await page.route(
    (url) => /\/api\/occasions\/\d+\/city-availability$/.test(url.pathname),
    async (route) => {
      const method = route.request().method();
      const idMatch = new URL(route.request().url()).pathname.match(
        /\/(\d+)\/city-availability$/,
      );
      const id = idMatch ? parseInt(idMatch[1], 10) : NaN;
      const cities =
        cityAvailability[id] ?? ENABLED_CITIES.map((c) => ({ ...c }));

      if (method === "GET") {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            cities,
            enabled_count: cities.filter((c) => c.is_enabled).length,
            total_cities: cities.length,
          }),
        });
        return;
      }

      if (method === "PUT") {
        const updates = route.request().postDataJSON() as {
          city_id: number;
          is_enabled: boolean;
        }[];
        for (const u of updates) {
          const row = cities.find((c) => c.city_id === u.city_id);
          if (row) row.is_enabled = u.is_enabled;
        }
        cityAvailability[id] = cities;
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

  await page.goto("/catalog-attributes/occasions", {
    waitUntil: "domcontentloaded",
  });
  await expect(page.getByRole("heading", { name: "Occasions" })).toBeVisible({
    timeout: 15_000,
  });
}

test.describe("City Availability panel – loads and saves", () => {
  test("opens an occasion's city panel, loads delivery cities, toggles one off, saves, and the change persists on reopen", async ({
    page,
  }) => {
    const existing = makeOccasion(55, "Anniversary");
    await setupOccasionsPage(page, [existing]);

    await expect(
      page.getByRole("cell", { name: "Anniversary", exact: true }),
    ).toBeVisible({ timeout: 12_000 });

    // Open the city panel for the Anniversary row.
    const row = page.getByRole("row", { name: /Anniversary/ });
    await row.getByTitle("Manage city availability").click();

    await expect(
      page.getByRole("heading", { name: "Manage City Availability" }),
    ).toBeVisible({ timeout: 5_000 });

    // The workspace delivery cities load — NOT the empty state.
    await expect(page.getByText("Dubai")).toBeVisible({ timeout: 5_000 });
    await expect(page.getByText("Beirut")).toBeVisible();
    await expect(page.getByText("No cities found")).toHaveCount(0);

    // Counter starts at 2 of 2 (both cities enabled) and both switches are on.
    await expect(page.getByText("2 of 2 cities enabled")).toBeVisible();
    const switches = page.getByRole("switch");
    await expect(switches.nth(0)).toBeChecked();
    await expect(switches.nth(1)).toBeChecked();

    // Save Changes starts disabled (no changes yet).
    const saveBtn = page.getByRole("button", { name: "Save Changes" });
    await expect(saveBtn).toBeDisabled();

    // Toggle the first city (Dubai) OFF.
    await switches.nth(0).click();
    await expect(switches.nth(0)).not.toBeChecked();

    // The counter updates immediately to reflect the local change.
    await expect(page.getByText("1 of 2 cities enabled")).toBeVisible();

    // Save persists the change to the backend.
    await expect(saveBtn).toBeEnabled({ timeout: 3_000 });
    const putReqPromise = page.waitForRequest(
      (req) =>
        /\/api\/occasions\/\d+\/city-availability$/.test(
          new URL(req.url()).pathname,
        ) && req.method() === "PUT",
    );
    await saveBtn.click();
    await putReqPromise;

    await expect(
      page.getByText("City availability saved", { exact: true }),
    ).toBeVisible({ timeout: 8_000 });

    // Close the panel.
    await page.getByRole("button", { name: "Cancel" }).click();
    await expect(
      page.getByRole("heading", { name: "Manage City Availability" }),
    ).toHaveCount(0, { timeout: 5_000 });

    // Reopen the panel — the saved toggle must persist.
    await row.getByTitle("Manage city availability").click();
    await expect(
      page.getByRole("heading", { name: "Manage City Availability" }),
    ).toBeVisible({ timeout: 5_000 });

    await expect(page.getByText("Dubai")).toBeVisible({ timeout: 5_000 });

    // The counter now reflects the saved state, and Dubai's switch is off while
    // Beirut's remains on.
    await expect(page.getByText("1 of 2 cities enabled")).toBeVisible({
      timeout: 5_000,
    });
    const reopenedSwitches = page.getByRole("switch");
    await expect(reopenedSwitches.nth(0)).not.toBeChecked();
    await expect(reopenedSwitches.nth(1)).toBeChecked();
  });
});

import { test, expect } from "./fixtures";
import { setupClerkTestingToken } from "@clerk/testing/playwright";

const OWNER_EMAIL = "e2e-tester+clerk_test@presentail.com";

type AttributeItem = {
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

const MOCK_CITIES: CityRow[] = [
  {
    city_id: 10,
    city_name: "Dubai",
    country_code: "AE",
    city_slug: "dubai",
    city_is_active: true,
    is_enabled: false,
    updated_at: null,
  },
];

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

function makeItem(
  id: number,
  name: string,
  overrides: Partial<AttributeItem> = {},
): AttributeItem {
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

async function setupCategoryPage(
  page: import("@playwright/test").Page,
  initialItems: AttributeItem[] = [],
) {
  const items: AttributeItem[] = [...initialItems];
  const cityAvailability: Record<number, CityRow[]> = {};
  for (const item of items) {
    cityAvailability[item.id] = MOCK_CITIES.map((c) => ({ ...c }));
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

  const apiBase = "/api/catalog_categories";

  await page.route(
    (url) => url.pathname === apiBase,
    async (route) => {
      const method = route.request().method();

      if (method === "GET") {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            items,
            total: items.length,
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

  await page.route(
    (url) => new RegExp(`^${apiBase}/\\d+$`).test(url.pathname),
    async (route) => {
      const method = route.request().method();
      const idMatch = new URL(route.request().url()).pathname.match(/\/(\d+)$/);
      const id = idMatch ? parseInt(idMatch[1], 10) : NaN;
      const idx = items.findIndex((o) => o.id === id);

      if (idx === -1) {
        await route.fulfill({
          status: 404,
          contentType: "application/json",
          body: JSON.stringify({ error: "Not found" }),
        });
        return;
      }

      if (method === "PATCH") {
        const body = route.request().postDataJSON() as Partial<AttributeItem>;
        items[idx] = {
          ...items[idx],
          ...body,
          updated_at: new Date().toISOString(),
        };
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ item: items[idx] }),
        });
        return;
      }

      await route.fulfill({ status: 405, body: "" });
    },
  );

  await page.route(
    (url) =>
      new RegExp(`^${apiBase}/\\d+/city-availability$`).test(url.pathname),
    async (route) => {
      const idMatch = new URL(route.request().url()).pathname.match(
        /\/(\d+)\/city-availability$/,
      );
      const id = idMatch ? parseInt(idMatch[1], 10) : NaN;
      const cities =
        cityAvailability[id] ?? MOCK_CITIES.map((c) => ({ ...c }));

      if (route.request().method() === "GET") {
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

      await route.fulfill({ status: 405, body: "" });
    },
  );

  await page.goto("/catalog-attributes/categories", {
    waitUntil: "domcontentloaded",
  });
  await expect(
    page.getByRole("heading", { name: "Categories" }),
  ).toBeVisible({ timeout: 15_000 });
}

test.describe("Catalog Categories – description field in edit form", () => {
  test("edit form pre-fills description from the existing item", async ({
    page,
  }) => {
    const existing = makeItem(10, "Birthday Gifts", {
      description: "Gifts for birthday celebrations",
    });
    await setupCategoryPage(page, [existing]);

    await expect(
      page.getByRole("cell", { name: "Birthday Gifts", exact: true }),
    ).toBeVisible({ timeout: 12_000 });

    const row = page.getByRole("row", { name: /Birthday Gifts/ });
    await row.getByRole("button").last().click();

    await page.getByRole("menuitem", { name: "Edit" }).click();
    await expect(
      page.locator("h2").filter({ hasText: "Edit Category" }),
    ).toBeVisible({ timeout: 5_000 });

    const descField = page.locator("#attr-description");
    await expect(descField).toHaveValue("Gifts for birthday celebrations");
  });

  test("changing the description sends the new value in the PATCH body", async ({
    page,
  }) => {
    const existing = makeItem(11, "Wedding Gifts", {
      description: "Original description",
    });
    await setupCategoryPage(page, [existing]);

    await expect(
      page.getByRole("cell", { name: "Wedding Gifts", exact: true }),
    ).toBeVisible({ timeout: 12_000 });

    const row = page.getByRole("row", { name: /Wedding Gifts/ });
    await row.getByRole("button").last().click();

    await page.getByRole("menuitem", { name: "Edit" }).click();
    await expect(
      page.locator("h2").filter({ hasText: "Edit Category" }),
    ).toBeVisible({ timeout: 5_000 });

    const descField = page.locator("#attr-description");
    await descField.clear();
    await descField.fill("Updated description text");

    const patchReqPromise = page.waitForRequest(
      (req) =>
        new RegExp(`^/api/catalog_categories/\\d+$`).test(
          new URL(req.url()).pathname,
        ) && req.method() === "PATCH",
    );

    await page.getByRole("button", { name: "Save Changes" }).click();

    const patchReq = await patchReqPromise;
    const body = patchReq.postDataJSON() as Record<string, unknown>;
    expect(body.description).toBe("Updated description text");
  });

  test("clearing the description entirely sends null in the PATCH body", async ({
    page,
  }) => {
    const existing = makeItem(12, "Anniversary Gifts", {
      description: "Description to be cleared",
    });
    await setupCategoryPage(page, [existing]);

    await expect(
      page.getByRole("cell", { name: "Anniversary Gifts", exact: true }),
    ).toBeVisible({ timeout: 12_000 });

    const row = page.getByRole("row", { name: /Anniversary Gifts/ });
    await row.getByRole("button").last().click();

    await page.getByRole("menuitem", { name: "Edit" }).click();
    await expect(
      page.locator("h2").filter({ hasText: "Edit Category" }),
    ).toBeVisible({ timeout: 5_000 });

    const descField = page.locator("#attr-description");
    await expect(descField).toHaveValue("Description to be cleared");

    await descField.clear();

    const patchReqPromise = page.waitForRequest(
      (req) =>
        new RegExp(`^/api/catalog_categories/\\d+$`).test(
          new URL(req.url()).pathname,
        ) && req.method() === "PATCH",
    );

    await page.getByRole("button", { name: "Save Changes" }).click();

    const patchReq = await patchReqPromise;
    const body = patchReq.postDataJSON() as Record<string, unknown>;
    expect(body.description).toBeNull();
  });
});

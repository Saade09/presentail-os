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
  {
    city_id: 11,
    city_name: "Beirut",
    country_code: "LB",
    city_slug: "beirut",
    city_is_active: true,
    is_enabled: false,
    updated_at: null,
  },
];

type AttributeTypeConfig = {
  /** URL path segment used in the API, e.g. "catalog_categories" */
  apiPath: string;
  /** Browser route, e.g. "/catalog-attributes/catalog_categories" */
  route: string;
  /** Page heading / title shown in the UI */
  title: string;
  /** Singular form used in button / sheet labels */
  singular: string;
  /** Empty-state text shown when the list is empty */
  emptyText: string;
};

const ATTRIBUTE_TYPES: AttributeTypeConfig[] = [
  {
    apiPath: "catalog_categories",
    route: "/catalog-attributes/categories",
    title: "Categories",
    singular: "Category",
    emptyText: "No categories found",
  },
  {
    apiPath: "catalog_brands",
    route: "/catalog-attributes/brands",
    title: "Brands",
    singular: "Brand",
    emptyText: "No brands found",
  },
  {
    apiPath: "recipients",
    route: "/catalog-attributes/recipients",
    title: "Recipients",
    singular: "Recipient",
    emptyText: "No recipients found",
  },
];

async function setupAttributePage(
  page: import("@playwright/test").Page,
  config: AttributeTypeConfig,
  initialItems: AttributeItem[] = [],
) {
  const items: AttributeItem[] = [...initialItems];
  let nextId = (items.reduce((m, o) => Math.max(m, o.id), 0) || 0) + 1;

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

  const apiBase = `/api/${config.apiPath}`;

  // List + Create
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

      if (method === "POST") {
        const body = route.request().postDataJSON() as Partial<AttributeItem>;
        const name = (body.name ?? "").trim();
        const created = makeItem(nextId++, name, {
          slug:
            typeof body.slug === "string"
              ? body.slug
              : name.toLowerCase().replace(/[^a-z0-9]+/g, "-"),
          description: body.description ?? null,
          sort_order: typeof body.sort_order === "number" ? body.sort_order : 0,
          is_active: body.is_active ?? true,
        });
        items.push(created);
        cityAvailability[created.id] = MOCK_CITIES.map((c) => ({ ...c }));
        await route.fulfill({
          status: 201,
          contentType: "application/json",
          body: JSON.stringify({ item: created }),
        });
        return;
      }

      await route.fulfill({ status: 405, body: "" });
    },
  );

  // Update + Delete single item by id
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

      if (method === "DELETE") {
        items.splice(idx, 1);
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

  // City availability — GET + PUT
  await page.route(
    (url) =>
      new RegExp(`^${apiBase}/\\d+/city-availability$`).test(url.pathname),
    async (route) => {
      const method = route.request().method();
      const idMatch = new URL(route.request().url()).pathname.match(
        /\/(\d+)\/city-availability$/,
      );
      const id = idMatch ? parseInt(idMatch[1], 10) : NaN;
      const cities =
        cityAvailability[id] ?? MOCK_CITIES.map((c) => ({ ...c }));

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

  await page.goto(config.route, { waitUntil: "domcontentloaded" });
  await expect(page.getByRole("heading", { name: config.title })).toBeVisible({ timeout: 15_000 });
}

for (const cfg of ATTRIBUTE_TYPES) {
  test.describe(`${cfg.title} admin – sort_order and image_url fields`, () => {
    test(`owner creates a ${cfg.singular.toLowerCase()} with a custom sort_order and it appears in the POST body`, async ({
      page,
    }) => {
      await setupAttributePage(page, cfg);

      await expect(
        page.getByRole("heading", { name: cfg.title }),
      ).toBeVisible({ timeout: 12_000 });

      await page
        .getByRole("button", { name: `New ${cfg.singular}` })
        .first()
        .click();
      await expect(
        page.locator("h2").filter({ hasText: `New ${cfg.singular}` }),
      ).toBeVisible({ timeout: 5_000 });

      await page.getByLabel("Name").fill(`Sorted ${cfg.singular}`);

      const sortInput = page.getByLabel("Sort Order");
      await sortInput.clear();
      await sortInput.fill("7");

      const postReqPromise = page.waitForRequest(
        (req) =>
          new URL(req.url()).pathname === `/api/${cfg.apiPath}` &&
          req.method() === "POST",
      );

      await page
        .getByRole("button", { name: `Create ${cfg.singular}` })
        .click();

      const postReq = await postReqPromise;
      const body = postReq.postDataJSON() as Record<string, unknown>;
      expect(body.sort_order).toBe(7);

      await expect(
        page.getByRole("cell", {
          name: `Sorted ${cfg.singular}`,
          exact: true,
        }),
      ).toBeVisible({ timeout: 8_000 });
    });

    test(`owner edits a ${cfg.singular.toLowerCase()}'s sort_order and the new value is sent in the PATCH body`, async ({
      page,
    }) => {
      const existing = makeItem(42, `Order Test ${cfg.singular}`, {
        sort_order: 4,
      });
      await setupAttributePage(page, cfg, [existing]);

      await expect(
        page.getByRole("cell", {
          name: `Order Test ${cfg.singular}`,
          exact: true,
        }),
      ).toBeVisible({ timeout: 12_000 });

      const row = page.getByRole("row", {
        name: new RegExp(`Order Test ${cfg.singular}`),
      });
      await row.getByRole("button").last().click();

      await page.getByRole("menuitem", { name: "Edit" }).click();
      await expect(
        page.getByText(`Edit ${cfg.singular}`),
      ).toBeVisible({ timeout: 5_000 });

      const sortInput = page.getByLabel("Sort Order");
      await expect(sortInput).toHaveValue("4");

      await sortInput.clear();
      await sortInput.fill("12");

      const patchReqPromise = page.waitForRequest(
        (req) =>
          new RegExp(`^/api/${cfg.apiPath}/\\d+$`).test(
            new URL(req.url()).pathname,
          ) && req.method() === "PATCH",
      );

      await page.getByRole("button", { name: "Save Changes" }).click();

      const patchReq = await patchReqPromise;
      const body = patchReq.postDataJSON() as Record<string, unknown>;
      expect(body.sort_order).toBe(12);

      await expect(
        page.getByRole("cell", {
          name: `Order Test ${cfg.singular}`,
          exact: true,
        }),
      ).toBeVisible({ timeout: 8_000 });

      // The Sort column cell in that row now shows the updated value.
      const updatedRow = page.getByRole("row", {
        name: new RegExp(`Order Test ${cfg.singular}`),
      });
      await expect(
        updatedRow.getByRole("cell", { name: "12", exact: true }),
      ).toBeVisible({ timeout: 8_000 });
    });

    test(`owner uploads an image when creating a ${cfg.singular.toLowerCase()} and image_url is sent in the POST body`, async ({
      page,
    }) => {
      await page.route(
        "**/api/storage/uploads/request-url",
        async (route) => {
          await route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify({
              uploadURL:
                "https://mock-storage.example.com/upload/attr.jpg",
              objectPath: "/objects/attr-abc123.jpg",
              metadata: {
                name: "attr.jpg",
                size: 512,
                contentType: "image/jpeg",
              },
            }),
          });
        },
      );
      await page.route("**/mock-storage.example.com/**", async (route) => {
        await route.fulfill({ status: 200, body: "" });
      });

      await setupAttributePage(page, cfg);

      await expect(
        page.getByRole("heading", { name: cfg.title }),
      ).toBeVisible({ timeout: 12_000 });

      await page
        .getByRole("button", { name: `New ${cfg.singular}` })
        .first()
        .click();
      await expect(
        page.locator("h2").filter({ hasText: `New ${cfg.singular}` }),
      ).toBeVisible({ timeout: 5_000 });

      await page.getByLabel("Name").fill(`Image ${cfg.singular}`);

      const fileInput = page.locator('input[type="file"][accept*="image"]');
      await fileInput.setInputFiles({
        name: "attr.jpg",
        mimeType: "image/jpeg",
        buffer: Buffer.from("fake-image-data"),
      });

      await expect(
        page.getByRole("button", { name: /replace/i }),
      ).toBeVisible({ timeout: 10_000 });

      const postReqPromise = page.waitForRequest(
        (req) =>
          new URL(req.url()).pathname === `/api/${cfg.apiPath}` &&
          req.method() === "POST",
      );

      await page
        .getByRole("button", { name: `Create ${cfg.singular}` })
        .click();

      const postReq = await postReqPromise;
      const body = postReq.postDataJSON() as Record<string, unknown>;
      expect(body.image_url).toBe("/objects/attr-abc123.jpg");
    });

    test(`owner removes an image from an existing ${cfg.singular.toLowerCase()} and image_url null is sent in the PATCH body`, async ({
      page,
    }) => {
      const existing = makeItem(42, `Image Remove ${cfg.singular}`, {
        image_url: "/objects/existing.jpg",
      });
      await setupAttributePage(page, cfg, [existing]);

      // When image_url is set the Name cell renders an <img>, which can affect
      // ARIA accessible-name computation. Use a text match instead.
      await expect(
        page.getByRole("heading", { name: cfg.title }),
      ).toBeVisible({ timeout: 12_000 });
      await expect(
        page
          .locator("td")
          .filter({ hasText: new RegExp(`^Image Remove ${cfg.singular}$`) }),
      ).toBeVisible({ timeout: 8_000 });

      const row = page.getByRole("row", {
        name: new RegExp(`Image Remove ${cfg.singular}`),
      });
      await row.getByRole("button").last().click();

      await page.getByRole("menuitem", { name: "Edit" }).click();
      await expect(
        page.getByText(`Edit ${cfg.singular}`),
      ).toBeVisible({ timeout: 5_000 });

      await expect(
        page.getByRole("button", { name: /replace/i }),
      ).toBeVisible({ timeout: 5_000 });

      await page.getByRole("button", { name: /remove/i }).click();

      await expect(
        page.getByText(/click to upload image/i),
      ).toBeVisible({ timeout: 5_000 });

      const patchReqPromise = page.waitForRequest(
        (req) =>
          new RegExp(`^/api/${cfg.apiPath}/\\d+$`).test(
            new URL(req.url()).pathname,
          ) && req.method() === "PATCH",
      );

      await page.getByRole("button", { name: "Save Changes" }).click();

      const patchReq = await patchReqPromise;
      const body = patchReq.postDataJSON() as Record<string, unknown>;
      expect(body.image_url).toBeNull();
    });
  });

  test.describe(`${cfg.title} admin – create, edit, city availability, delete`, () => {
    test(`owner creates a new ${cfg.singular.toLowerCase()} and it appears in the list`, async ({
      page,
    }) => {
      await setupAttributePage(page, cfg);

      await expect(
        page.getByRole("heading", { name: cfg.title }),
      ).toBeVisible({ timeout: 12_000 });
      await expect(page.getByText(cfg.emptyText)).toBeVisible({
        timeout: 8_000,
      });

      // Open the create form sheet via the top-right button.
      // The empty state also renders a "New <Singular>" button, so use .first().
      await page
        .getByRole("button", { name: `New ${cfg.singular}` })
        .first()
        .click();

      await expect(
        page.locator("h2").filter({ hasText: `New ${cfg.singular}` }),
      ).toBeVisible({ timeout: 5_000 });

      await page.getByLabel("Name").fill(`Test ${cfg.singular}`);

      await page
        .getByRole("button", { name: `Create ${cfg.singular}` })
        .click();

      await expect(
        page.getByRole("cell", {
          name: `Test ${cfg.singular}`,
          exact: true,
        }),
      ).toBeVisible({ timeout: 8_000 });

      await expect(page.getByText(cfg.emptyText)).toHaveCount(0);
    });

    test(`owner edits an existing ${cfg.singular.toLowerCase()}'s name`, async ({
      page,
    }) => {
      const existing = makeItem(42, `Original ${cfg.singular}`);
      await setupAttributePage(page, cfg, [existing]);

      await expect(
        page.getByRole("cell", {
          name: `Original ${cfg.singular}`,
          exact: true,
        }),
      ).toBeVisible({ timeout: 12_000 });

      const row = page.getByRole("row", {
        name: new RegExp(`Original ${cfg.singular}`),
      });
      await row.getByRole("button").last().click();

      const editItem = page.getByRole("menuitem", { name: "Edit" });
      await expect(editItem).toBeVisible({ timeout: 5_000 });
      await editItem.click();

      await expect(
        page.getByText(`Edit ${cfg.singular}`),
      ).toBeVisible({ timeout: 5_000 });

      const nameInput = page.getByLabel("Name");
      await nameInput.clear();
      await nameInput.fill(`Updated ${cfg.singular}`);

      await page.getByRole("button", { name: "Save Changes" }).click();

      await expect(
        page.getByRole("cell", {
          name: `Updated ${cfg.singular}`,
          exact: true,
        }),
      ).toBeVisible({ timeout: 8_000 });

      await expect(
        page.getByRole("cell", {
          name: `Original ${cfg.singular}`,
          exact: true,
        }),
      ).toHaveCount(0);
    });

    test(`owner toggles city availability for a ${cfg.singular.toLowerCase()} and saves`, async ({
      page,
    }) => {
      const existing = makeItem(55, `City Test ${cfg.singular}`);
      await setupAttributePage(page, cfg, [existing]);

      await expect(
        page.getByRole("cell", {
          name: `City Test ${cfg.singular}`,
          exact: true,
        }),
      ).toBeVisible({ timeout: 12_000 });

      const row = page.getByRole("row", {
        name: new RegExp(`City Test ${cfg.singular}`),
      });
      await row.getByTitle("Manage city availability").click();

      await expect(
        page.getByRole("heading", { name: "Manage City Availability" }),
      ).toBeVisible({ timeout: 5_000 });

      await expect(
        page
          .getByRole("paragraph")
          .filter({ hasText: `City Test ${cfg.singular}` }),
      ).toBeVisible();

      await expect(page.getByText("Dubai")).toBeVisible({ timeout: 5_000 });
      await expect(page.getByText("Beirut")).toBeVisible();

      const saveBtn = page.getByRole("button", { name: "Save Changes" });
      await expect(saveBtn).toBeDisabled();

      await page.getByRole("switch").first().click();

      await expect(saveBtn).toBeEnabled({ timeout: 3_000 });

      await saveBtn.click();

      await expect(
        page.getByText("City availability saved", { exact: true }),
      ).toBeVisible({ timeout: 8_000 });

      await expect(
        page.getByRole("heading", { name: "Manage City Availability" }),
      ).toBeVisible();
    });

    test(`owner deletes a ${cfg.singular.toLowerCase()} via the confirmation dialog`, async ({
      page,
    }) => {
      const existing = makeItem(77, `Delete Me ${cfg.singular}`, {
        product_count: 0,
      });
      await setupAttributePage(page, cfg, [existing]);

      await expect(
        page.getByRole("cell", {
          name: `Delete Me ${cfg.singular}`,
          exact: true,
        }),
      ).toBeVisible({ timeout: 12_000 });

      const row = page.getByRole("row", {
        name: new RegExp(`Delete Me ${cfg.singular}`),
      });
      await row.getByRole("button").last().click();

      const deleteItem = page.getByRole("menuitem", { name: "Delete" });
      await expect(deleteItem).toBeVisible({ timeout: 5_000 });
      await deleteItem.click();

      const dialog = page.getByRole("alertdialog");
      await expect(dialog).toBeVisible({ timeout: 5_000 });
      await expect(
        dialog.getByText(new RegExp(`Delete ${cfg.singular}`, "i")),
      ).toBeVisible();

      await dialog.getByRole("button", { name: "Delete" }).click();

      await expect(
        page.getByRole("cell", {
          name: `Delete Me ${cfg.singular}`,
          exact: true,
        }),
      ).toHaveCount(0, { timeout: 8_000 });

      await expect(page.getByText(cfg.emptyText)).toBeVisible({
        timeout: 8_000,
      });
    });
  });
}

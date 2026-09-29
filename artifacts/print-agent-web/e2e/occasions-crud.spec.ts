import { test, expect } from "./fixtures";
import { setupClerkTestingToken } from "@clerk/testing/playwright";

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

/**
 * Sets up routes for the Occasions admin page with an in-memory store.
 * Supports list, create (POST), update (PATCH), delete (DELETE), and
 * city-availability GET + PUT.
 */
async function setupOccasionsPage(
  page: import("@playwright/test").Page,
  initialOccasions: Occasion[] = [],
) {
  const occasions: Occasion[] = [...initialOccasions];
  let nextId = (occasions.reduce((m, o) => Math.max(m, o.id), 0) || 0) + 1;

  // City availability state keyed by occasion id.
  const cityAvailability: Record<number, CityRow[]> = {};
  for (const o of occasions) {
    cityAvailability[o.id] = MOCK_CITIES.map((c) => ({ ...c }));
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

  // List + Create occasions
  await page.route(
    (url) => url.pathname === "/api/occasions",
    async (route) => {
      const method = route.request().method();

      if (method === "GET") {
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

      if (method === "POST") {
        const body = route.request().postDataJSON() as Partial<Occasion>;
        const name = (body.name ?? "").trim();
        const created = makeOccasion(nextId++, name, {
          slug: typeof body.slug === "string" ? body.slug : name.toLowerCase().replace(/[^a-z0-9]+/g, "-"),
          description: body.description ?? null,
          sort_order: typeof body.sort_order === "number" ? body.sort_order : 0,
          is_active: body.is_active ?? true,
        });
        occasions.push(created);
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

  // Update + Delete a single occasion by id
  await page.route(
    (url) => /\/api\/occasions\/\d+$/.test(url.pathname),
    async (route) => {
      const method = route.request().method();
      const idMatch = new URL(route.request().url()).pathname.match(/\/(\d+)$/);
      const id = idMatch ? parseInt(idMatch[1], 10) : NaN;
      const idx = occasions.findIndex((o) => o.id === id);

      if (idx === -1) {
        await route.fulfill({
          status: 404,
          contentType: "application/json",
          body: JSON.stringify({ error: "Not found" }),
        });
        return;
      }

      if (method === "PATCH") {
        const body = route.request().postDataJSON() as Partial<Occasion>;
        occasions[idx] = {
          ...occasions[idx],
          ...body,
          updated_at: new Date().toISOString(),
        };
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ item: occasions[idx] }),
        });
        return;
      }

      if (method === "DELETE") {
        occasions.splice(idx, 1);
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
    (url) => /\/api\/occasions\/\d+\/city-availability$/.test(url.pathname),
    async (route) => {
      const method = route.request().method();
      const idMatch = new URL(route.request().url()).pathname.match(
        /\/(\d+)\/city-availability$/,
      );
      const id = idMatch ? parseInt(idMatch[1], 10) : NaN;
      const cities = cityAvailability[id] ?? MOCK_CITIES.map((c) => ({ ...c }));

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

  await page.goto("/catalog-attributes/occasions", { waitUntil: "domcontentloaded" });
  await expect(page.getByRole("heading", { name: "Occasions" })).toBeVisible({ timeout: 15_000 });
}

test.describe("Occasions admin – sort_order and image_url fields", () => {
  test("owner creates an occasion with a custom sort_order and it appears in the POST body", async ({
    page,
  }) => {
    await setupOccasionsPage(page);

    await expect(
      page.getByRole("heading", { name: "Occasions" }),
    ).toBeVisible({ timeout: 12_000 });

    await page.getByRole("button", { name: "New Occasion" }).first().click();
    await expect(
      page.locator("h2").filter({ hasText: "New Occasion" }),
    ).toBeVisible({ timeout: 5_000 });

    await page.getByLabel("Name").fill("Spring Fest");

    // Set a non-zero sort order.
    const sortInput = page.getByLabel("Sort Order");
    await sortInput.clear();
    await sortInput.fill("5");

    // Capture the outgoing POST request.
    const postReqPromise = page.waitForRequest(
      (req) =>
        new URL(req.url()).pathname === "/api/occasions" &&
        req.method() === "POST",
    );

    await page.getByRole("button", { name: "Create Occasion" }).click();

    const postReq = await postReqPromise;
    const body = postReq.postDataJSON() as Record<string, unknown>;
    expect(body.sort_order).toBe(5);

    // Row appears in the table.
    await expect(
      page.getByRole("cell", { name: "Spring Fest", exact: true }),
    ).toBeVisible({ timeout: 8_000 });
  });

  test("owner edits an occasion's sort_order and the new value is sent in the PATCH body", async ({
    page,
  }) => {
    const existing = makeOccasion(42, "Summer Bash", { sort_order: 3 });
    await setupOccasionsPage(page, [existing]);

    await expect(
      page.getByRole("cell", { name: "Summer Bash", exact: true }),
    ).toBeVisible({ timeout: 12_000 });

    const row = page.getByRole("row", { name: /Summer Bash/ });
    await row.getByRole("button").last().click();

    await page.getByRole("menuitem", { name: "Edit" }).click();
    await expect(page.getByText("Edit Occasion")).toBeVisible({ timeout: 5_000 });

    // The existing sort_order value should be pre-filled.
    const sortInput = page.getByLabel("Sort Order");
    await expect(sortInput).toHaveValue("3");

    // Change it to 10.
    await sortInput.clear();
    await sortInput.fill("10");

    const patchReqPromise = page.waitForRequest(
      (req) =>
        /\/api\/occasions\/\d+$/.test(new URL(req.url()).pathname) &&
        req.method() === "PATCH",
    );

    await page.getByRole("button", { name: "Save Changes" }).click();

    const patchReq = await patchReqPromise;
    const body = patchReq.postDataJSON() as Record<string, unknown>;
    expect(body.sort_order).toBe(10);

    // Sheet closes and the name still appears in the table.
    await expect(
      page.getByRole("cell", { name: "Summer Bash", exact: true }),
    ).toBeVisible({ timeout: 8_000 });

    // The Sort column cell in that row now shows the updated value.
    const updatedRow = page.getByRole("row", { name: /Summer Bash/ });
    await expect(
      updatedRow.getByRole("cell", { name: "10", exact: true }),
    ).toBeVisible({ timeout: 8_000 });
  });

  test("owner uploads an image when creating an occasion and image_url is sent in the POST body", async ({
    page,
  }) => {
    // Mock the two-step presigned upload.
    await page.route("**/api/storage/uploads/request-url", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          uploadURL: "https://mock-storage.example.com/upload/occ.jpg",
          objectPath: "/objects/occ-abc123.jpg",
          metadata: { name: "occ.jpg", size: 512, contentType: "image/jpeg" },
        }),
      });
    });
    await page.route("**/mock-storage.example.com/**", async (route) => {
      await route.fulfill({ status: 200, body: "" });
    });

    await setupOccasionsPage(page);

    await expect(
      page.getByRole("heading", { name: "Occasions" }),
    ).toBeVisible({ timeout: 12_000 });

    await page.getByRole("button", { name: "New Occasion" }).first().click();
    await expect(
      page.locator("h2").filter({ hasText: "New Occasion" }),
    ).toBeVisible({ timeout: 5_000 });

    await page.getByLabel("Name").fill("Photo Occasion");

    // Upload a fake image via the hidden file input.
    const fileInput = page.locator('input[type="file"][accept*="image"]');
    await fileInput.setInputFiles({
      name: "occ.jpg",
      mimeType: "image/jpeg",
      buffer: Buffer.from("fake-image-data"),
    });

    // Wait for the Replace button — upload succeeded.
    await expect(
      page.getByRole("button", { name: /replace/i }),
    ).toBeVisible({ timeout: 10_000 });

    const postReqPromise = page.waitForRequest(
      (req) =>
        new URL(req.url()).pathname === "/api/occasions" &&
        req.method() === "POST",
    );

    await page.getByRole("button", { name: "Create Occasion" }).click();

    const postReq = await postReqPromise;
    const body = postReq.postDataJSON() as Record<string, unknown>;
    expect(body.image_url).toBe("/objects/occ-abc123.jpg");
  });

  test("owner removes an image from an existing occasion and image_url null is sent in the PATCH body", async ({
    page,
  }) => {
    const existing = makeOccasion(42, "Floral Fest", {
      image_url: "/objects/floral.jpg",
    });
    await setupOccasionsPage(page, [existing]);

    // When image_url is set the Name cell renders an <img>, which can affect
    // ARIA accessible-name computation. Use a text match instead.
    await expect(
      page.getByRole("heading", { name: "Occasions" }),
    ).toBeVisible({ timeout: 12_000 });
    await expect(page.locator("td").filter({ hasText: /^Floral Fest$/ })).toBeVisible({
      timeout: 8_000,
    });

    const row = page.getByRole("row", { name: /Floral Fest/ });
    await row.getByRole("button").last().click();

    await page.getByRole("menuitem", { name: "Edit" }).click();
    await expect(page.getByText("Edit Occasion")).toBeVisible({ timeout: 5_000 });

    // The form shows Replace and Remove buttons for the existing image.
    await expect(
      page.getByRole("button", { name: /replace/i }),
    ).toBeVisible({ timeout: 5_000 });

    // Remove the image.
    await page.getByRole("button", { name: /remove/i }).click();

    // The dashed placeholder is restored.
    await expect(
      page.getByText(/click to upload image/i),
    ).toBeVisible({ timeout: 5_000 });

    const patchReqPromise = page.waitForRequest(
      (req) =>
        /\/api\/occasions\/\d+$/.test(new URL(req.url()).pathname) &&
        req.method() === "PATCH",
    );

    await page.getByRole("button", { name: "Save Changes" }).click();

    const patchReq = await patchReqPromise;
    const body = patchReq.postDataJSON() as Record<string, unknown>;
    expect(body.image_url).toBeNull();
  });
});

test.describe("Occasions admin – create, edit, city availability, delete", () => {
  test("owner creates a new occasion and it appears in the list", async ({
    page,
  }) => {
    await setupOccasionsPage(page);

    // The Occasions heading is visible and the empty-state copy is shown.
    await expect(
      page.getByRole("heading", { name: "Occasions" }),
    ).toBeVisible({ timeout: 12_000 });
    await expect(page.getByText("No occasions found")).toBeVisible({
      timeout: 8_000,
    });

    // Open the create form sheet via the top-right button.
    // The empty state also renders a "New Occasion" button, so use .first().
    await page.getByRole("button", { name: "New Occasion" }).first().click();

    // The slide-in form is visible — look for the h2 heading.
    await expect(
      page.locator("h2").filter({ hasText: "New Occasion" }),
    ).toBeVisible({ timeout: 5_000 });

    // Fill in the name; the slug is auto-generated.
    await page.getByLabel("Name").fill("Birthday");

    // Submit the form.
    await page.getByRole("button", { name: "Create Occasion" }).click();

    // The sheet closes and the new row appears in the table.
    // Use exact: true so the slug cell ("birthday") is not matched.
    await expect(
      page.getByRole("cell", { name: "Birthday", exact: true }),
    ).toBeVisible({ timeout: 8_000 });

    // Empty-state copy is gone.
    await expect(page.getByText("No occasions found")).toHaveCount(0);
  });

  test("owner edits an existing occasion's name", async ({ page }) => {
    const existing = makeOccasion(42, "Graduation");
    await setupOccasionsPage(page, [existing]);

    // The initial name is shown in the table.
    // Use exact: true so the slug cell ("graduation") is not matched.
    await expect(
      page.getByRole("cell", { name: "Graduation", exact: true }),
    ).toBeVisible({ timeout: 12_000 });

    // The actions column has a Globe button and a ⋯ dropdown button per row.
    // The ⋯ button is the last button inside the row.
    const row = page.getByRole("row", { name: /Graduation/ });
    await row.getByRole("button").last().click();

    // Click Edit in the dropdown.
    const editItem = page.getByRole("menuitem", { name: "Edit" });
    await expect(editItem).toBeVisible({ timeout: 5_000 });
    await editItem.click();

    // The edit form sheet is visible.
    await expect(page.getByText("Edit Occasion")).toBeVisible({ timeout: 5_000 });

    // Clear the name field and type a new value.
    const nameInput = page.getByLabel("Name");
    await nameInput.clear();
    await nameInput.fill("Graduation Party");

    // Submit.
    await page.getByRole("button", { name: "Save Changes" }).click();

    // The updated name is now shown in the list.
    await expect(
      page.getByRole("cell", { name: "Graduation Party", exact: true }),
    ).toBeVisible({ timeout: 8_000 });

    // The old name is gone.
    await expect(
      page.getByRole("cell", { name: "Graduation", exact: true }),
    ).toHaveCount(0);
  });

  test("owner toggles city availability for an occasion and saves", async ({
    page,
  }) => {
    const existing = makeOccasion(55, "Anniversary");
    await setupOccasionsPage(page, [existing]);

    await expect(
      page.getByRole("cell", { name: "Anniversary", exact: true }),
    ).toBeVisible({ timeout: 12_000 });

    // Click the Globe button on the Anniversary row to open the city panel.
    // The button has title="Manage city availability".
    const row = page.getByRole("row", { name: /Anniversary/ });
    await row.getByTitle("Manage city availability").click();

    // The city availability panel slides in.
    await expect(
      page.getByRole("heading", { name: "Manage City Availability" }),
    ).toBeVisible({ timeout: 5_000 });

    // The occasion name is shown in the panel subtitle (a paragraph element).
    await expect(page.getByRole("paragraph").filter({ hasText: "Anniversary" })).toBeVisible();

    // Both mock cities are listed.
    await expect(page.getByText("Dubai")).toBeVisible({ timeout: 5_000 });
    await expect(page.getByText("Beirut")).toBeVisible();

    // The "Save Changes" button starts disabled (no changes yet).
    const saveBtn = page.getByRole("button", { name: "Save Changes" });
    await expect(saveBtn).toBeDisabled();

    // Toggle Dubai's switch (first switch in the panel) to enabled.
    // Dubai is the first city in our mock, so it corresponds to the first switch.
    await page.getByRole("switch").first().click();

    // Now the Save Changes button should be enabled (dirty state).
    await expect(saveBtn).toBeEnabled({ timeout: 3_000 });

    // Save the changes.
    await saveBtn.click();

    // A success toast appears (exact: true excludes the ARIA live region
    // which contains the prefix "Notification ").
    await expect(
      page.getByText("City availability saved", { exact: true }),
    ).toBeVisible({ timeout: 8_000 });

    // The panel remains open after saving (no automatic close).
    await expect(
      page.getByRole("heading", { name: "Manage City Availability" }),
    ).toBeVisible();
  });

  test("owner deletes an occasion via the confirmation dialog", async ({
    page,
  }) => {
    const existing = makeOccasion(77, "Valentine's Day", { product_count: 0 });
    await setupOccasionsPage(page, [existing]);

    await expect(
      page.getByRole("cell", { name: "Valentine's Day", exact: true }),
    ).toBeVisible({ timeout: 12_000 });

    // Open the ⋯ dropdown for the row and click Delete.
    const row = page.getByRole("row", { name: /Valentine/ });
    await row.getByRole("button").last().click();

    const deleteItem = page.getByRole("menuitem", { name: "Delete" });
    await expect(deleteItem).toBeVisible({ timeout: 5_000 });
    await deleteItem.click();

    // A confirmation alert dialog appears.
    const dialog = page.getByRole("alertdialog");
    await expect(dialog).toBeVisible({ timeout: 5_000 });
    await expect(dialog.getByText(/Delete Occasion/i)).toBeVisible();

    // Confirm the deletion.
    await dialog.getByRole("button", { name: "Delete" }).click();

    // The row disappears from the table.
    await expect(
      page.getByRole("cell", { name: "Valentine's Day", exact: true }),
    ).toHaveCount(0, { timeout: 8_000 });

    // The empty-state copy returns.
    await expect(page.getByText("No occasions found")).toBeVisible({
      timeout: 8_000,
    });
  });
});

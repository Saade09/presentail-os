import { test, expect } from "./fixtures";
import { setupClerkTestingToken } from "@clerk/testing/playwright";

const OWNER_ID = 1;
const MEMBER_ID = 2;
const OWNER_EMAIL = "e2e-tester@presentail.com";
const MEMBER_EMAIL = "new-teammate@example.com";
const ROLE_ID = 10;
const ROLE_NAME = "Staff";
const LOC_A_ID = 101;
const LOC_A_NAME = "Downtown";
const LOC_B_ID = 102;
const LOC_B_NAME = "Airport";

const MOCK_ROLES = { roles: [{ id: ROLE_ID, name: ROLE_NAME }] };

const MOCK_LOCATIONS_LIST = {
  locations: [
    { id: LOC_A_ID, name: LOC_A_NAME, location_type: "Point of Sale" },
    { id: LOC_B_ID, name: LOC_B_NAME, location_type: "Point of Sale" },
  ],
};

function makeMember(assignedLocations: { id: number; name: string }[]) {
  return {
    id: MEMBER_ID,
    email: MEMBER_EMAIL,
    role: "member",
    custom_role_id: ROLE_ID,
    role_name: ROLE_NAME,
    joined: true,
    joined_at: new Date().toISOString(),
    invited_at: new Date().toISOString(),
    invited_by_email: OWNER_EMAIL,
    manager_member_id: null,
    manager_email: null,
    image_url: null,
    invite_token: null,
    assigned_locations: assignedLocations,
  };
}

function makeOwner() {
  return {
    id: OWNER_ID,
    email: OWNER_EMAIL,
    role: "owner" as const,
    custom_role_id: null,
    role_name: null,
    joined: true,
    joined_at: new Date().toISOString(),
    invited_at: new Date().toISOString(),
    invited_by_email: null,
    manager_member_id: null,
    manager_email: null,
    image_url: null,
    invite_token: null,
    assigned_locations: [],
  };
}

function usersResponse(assignedLocations: { id: number; name: string }[]) {
  return {
    members: [makeOwner(), makeMember(assignedLocations)],
    me: {
      role: "owner",
      email: OWNER_EMAIL,
      allowedPages: null,
      customRoleId: null,
    },
  };
}

test.describe("Member location assignment — Members page", () => {
  test(
    "open Change Locations dialog, assign a location, verify badge appears on member row",
    async ({ page }) => {
      await setupClerkTestingToken({ page });

      let locationsAssigned = false;
      const capturedPutBodies: unknown[] = [];

      await page.route("**/api/roles**", async (route) => {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify(MOCK_ROLES),
        });
      });

      await page.route("**/api/access-requests**", async (route) => {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ requests: [] }),
        });
      });

      await page.route("**/api/users/failed-access-requests**", async (route) => {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ failedRequests: [] }),
        });
      });

      await page.route("**/api/locations**", async (route) => {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify(MOCK_LOCATIONS_LIST),
        });
      });

      await page.route("**/api/users**", async (route) => {
        const method = route.request().method();
        const url = route.request().url();

        if (method === "PUT" && url.match(/\/api\/users\/\d+\/locations/)) {
          const body = JSON.parse(route.request().postData() ?? "{}");
          capturedPutBodies.push(body);
          locationsAssigned = true;
          await route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify({ ok: true }),
          });
          return;
        }

        if (method === "GET") {
          const assigned = locationsAssigned
            ? [{ id: LOC_A_ID, name: LOC_A_NAME }]
            : [];
          await route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify(usersResponse(assigned)),
          });
          return;
        }

        await route.continue();
      });

      await page.goto("/users", { waitUntil: "domcontentloaded" });
      await expect(page.getByRole("heading", { name: "Members" })).toBeVisible({ timeout: 15_000 });

      const memberRow = page.getByTestId(`member-${MEMBER_ID}`);
      await expect(memberRow).toBeVisible({ timeout: 12_000 });

      // No location badges should be present yet
      const locationsDisplay = page.getByTestId(`locations-display-${MEMBER_ID}`);
      await expect(locationsDisplay).not.toBeVisible();

      // Open the Change Locations dialog
      const changeLocationsButton = page.getByTestId(`button-change-locations-${MEMBER_ID}`);
      await expect(changeLocationsButton).toBeVisible({ timeout: 5_000 });
      await expect(changeLocationsButton).toContainText("Assign locations");
      await changeLocationsButton.click();

      const dialog = page.getByTestId("dialog-change-locations");
      await expect(dialog).toBeVisible({ timeout: 5_000 });
      await expect(dialog).toContainText(MEMBER_EMAIL);
      await expect(dialog).toContainText(LOC_A_NAME);
      await expect(dialog).toContainText(LOC_B_NAME);

      // Check the first location checkbox
      const checkboxA = page.getByTestId(`checkbox-location-${LOC_A_ID}`);
      await expect(checkboxA).not.toBeChecked();
      await checkboxA.click();
      await expect(checkboxA).toBeChecked();

      // Save the assignment
      const saveButton = page.getByTestId("button-confirm-location-change");
      await saveButton.click();

      // Dialog should close
      await expect(dialog).not.toBeVisible({ timeout: 8_000 });

      // Location badge should now appear on the member row
      await expect(locationsDisplay).toBeVisible({ timeout: 8_000 });
      await expect(locationsDisplay).toContainText(LOC_A_NAME);

      // The change-locations button text should update to reflect the count
      await expect(changeLocationsButton).toContainText("1 location");

      // Verify the PUT request sent the correct payload
      expect(capturedPutBodies.length).toBeGreaterThan(0);
      const lastPut = capturedPutBodies[capturedPutBodies.length - 1] as Record<string, unknown>;
      expect(Array.isArray(lastPut.locationIds)).toBe(true);
      expect((lastPut.locationIds as number[]).includes(LOC_A_ID)).toBe(true);
    },
  );

  test(
    "500 error from PUT /locations — dialog closes, toast appears, assignment unchanged",
    async ({ page }) => {
      await setupClerkTestingToken({ page });

      await page.route("**/api/roles**", async (route) => {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify(MOCK_ROLES),
        });
      });

      await page.route("**/api/access-requests**", async (route) => {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ requests: [] }),
        });
      });

      await page.route("**/api/users/failed-access-requests**", async (route) => {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ failedRequests: [] }),
        });
      });

      await page.route("**/api/locations**", async (route) => {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify(MOCK_LOCATIONS_LIST),
        });
      });

      await page.route("**/api/users**", async (route) => {
        const method = route.request().method();
        const url = route.request().url();

        if (method === "PUT" && url.match(/\/api\/users\/\d+\/locations/)) {
          await route.fulfill({
            status: 500,
            contentType: "application/json",
            body: JSON.stringify({ error: "Internal Server Error" }),
          });
          return;
        }

        if (method === "GET") {
          await route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify(usersResponse([])),
          });
          return;
        }

        await route.continue();
      });

      await page.goto("/users", { waitUntil: "domcontentloaded" });
      await expect(page.getByRole("heading", { name: "Members" })).toBeVisible({ timeout: 15_000 });

      const memberRow = page.getByTestId(`member-${MEMBER_ID}`);
      await expect(memberRow).toBeVisible({ timeout: 12_000 });

      // No location badges should be present yet
      const locationsDisplay = page.getByTestId(`locations-display-${MEMBER_ID}`);
      await expect(locationsDisplay).not.toBeVisible();

      // Open the Change Locations dialog
      const changeLocationsButton = page.getByTestId(`button-change-locations-${MEMBER_ID}`);
      await expect(changeLocationsButton).toBeVisible({ timeout: 5_000 });
      await changeLocationsButton.click();

      const dialog = page.getByTestId("dialog-change-locations");
      await expect(dialog).toBeVisible({ timeout: 5_000 });

      // Check the first location checkbox
      const checkboxA = page.getByTestId(`checkbox-location-${LOC_A_ID}`);
      await checkboxA.click();
      await expect(checkboxA).toBeChecked();

      // Attempt to save — the PUT will return 500
      const saveButton = page.getByTestId("button-confirm-location-change");
      await saveButton.click();

      // Dialog should close despite the error
      await expect(dialog).not.toBeVisible({ timeout: 8_000 });

      // Error toast should appear
      await expect(page.getByText("Could not update locations")).toBeVisible({ timeout: 8_000 });

      // Assignment should remain unchanged — no location badge on the member row
      await expect(locationsDisplay).not.toBeVisible();
      await expect(changeLocationsButton).toContainText("Assign locations");
    },
  );

  test(
    "clear all location assignments and verify badge row disappears",
    async ({ page }) => {
      await setupClerkTestingToken({ page });

      let locationsCleared = false;
      const capturedPutBodies: unknown[] = [];

      await page.route("**/api/roles**", async (route) => {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify(MOCK_ROLES),
        });
      });

      await page.route("**/api/access-requests**", async (route) => {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ requests: [] }),
        });
      });

      await page.route("**/api/users/failed-access-requests**", async (route) => {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ failedRequests: [] }),
        });
      });

      await page.route("**/api/locations**", async (route) => {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify(MOCK_LOCATIONS_LIST),
        });
      });

      await page.route("**/api/users**", async (route) => {
        const method = route.request().method();
        const url = route.request().url();

        if (method === "PUT" && url.match(/\/api\/users\/\d+\/locations/)) {
          const body = JSON.parse(route.request().postData() ?? "{}");
          capturedPutBodies.push(body);
          locationsCleared = true;
          await route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify({ ok: true }),
          });
          return;
        }

        if (method === "GET") {
          const assigned = locationsCleared
            ? []
            : [{ id: LOC_A_ID, name: LOC_A_NAME }];
          await route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify(usersResponse(assigned)),
          });
          return;
        }

        await route.continue();
      });

      await page.goto("/users", { waitUntil: "domcontentloaded" });
      await expect(page.getByRole("heading", { name: "Members" })).toBeVisible({ timeout: 15_000 });

      const memberRow = page.getByTestId(`member-${MEMBER_ID}`);
      await expect(memberRow).toBeVisible({ timeout: 12_000 });

      // Badge should start showing the pre-assigned location
      const locationsDisplay = page.getByTestId(`locations-display-${MEMBER_ID}`);
      await expect(locationsDisplay).toBeVisible({ timeout: 5_000 });
      await expect(locationsDisplay).toContainText(LOC_A_NAME);

      // Open the dialog; it should start with the location checked
      const changeLocationsButton = page.getByTestId(`button-change-locations-${MEMBER_ID}`);
      await expect(changeLocationsButton).toContainText("1 location");
      await changeLocationsButton.click();

      const dialog = page.getByTestId("dialog-change-locations");
      await expect(dialog).toBeVisible({ timeout: 5_000 });

      const checkboxA = page.getByTestId(`checkbox-location-${LOC_A_ID}`);
      await expect(checkboxA).toBeChecked();

      // Uncheck to clear the assignment
      await checkboxA.click();
      await expect(checkboxA).not.toBeChecked();

      const saveButton = page.getByTestId("button-confirm-location-change");
      await saveButton.click();

      await expect(dialog).not.toBeVisible({ timeout: 8_000 });

      // Badges row should disappear now that no locations are assigned
      await expect(locationsDisplay).not.toBeVisible({ timeout: 8_000 });

      // Button text should revert to "Assign locations"
      await expect(changeLocationsButton).toContainText("Assign locations");

      // Verify the PUT was called with an empty array
      expect(capturedPutBodies.length).toBeGreaterThan(0);
      const lastPut = capturedPutBodies[capturedPutBodies.length - 1] as Record<string, unknown>;
      expect(lastPut.locationIds).toEqual([]);
    },
  );
});

test.describe("Member location assignment — Location detail page", () => {
  const LOCATION_ID = LOC_A_ID;
  const LOCATION_NAME = LOC_A_NAME;

  const baseLocationDetail = {
    location: {
      id: LOCATION_ID,
      name: LOCATION_NAME,
      country: "US",
      location_type: "Warehouse",
      annual_rent: null,
      rent_currency: null,
      payments_per_year: null,
    },
    devices: [],
  };

  const baseStats = { stats: { total_jobs: 0, total_pages: 0, recent_errors: 0 } };

  function mockLocationRoutes(
    page: import("@playwright/test").Page,
    locationMembers: { id: number; email: string; role: string; role_name: string | null }[],
    opts: { removedMemberId?: number } = {},
  ) {
    let currentMembers = [...locationMembers];

    page.route(`**/api/locations/${LOCATION_ID}/devices**`, async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(baseLocationDetail),
      });
    });

    page.route(`**/api/locations/${LOCATION_ID}/stats**`, async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(baseStats),
      });
    });

    page.route(`**/api/locations/${LOCATION_ID}/brands**`, async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ brands: [] }),
      });
    });

    page.route(`**/api/locations/${LOCATION_ID}/members**`, async (route) => {
      const method = route.request().method();
      const url = route.request().url();

      if (method === "POST") {
        const body = JSON.parse(route.request().postData() ?? "{}") as { member_id: number };
        const newMember = { id: body.member_id, email: MEMBER_EMAIL, role: "member", role_name: ROLE_NAME };
        currentMembers = [...currentMembers, newMember];
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ ok: true }),
        });
        return;
      }

      if (method === "DELETE" && opts.removedMemberId !== undefined) {
        const match = url.match(/\/members\/(\d+)/);
        if (match) {
          const removedId = parseInt(match[1], 10);
          currentMembers = currentMembers.filter((m) => m.id !== removedId);
        }
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ ok: true }),
        });
        return;
      }

      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ members: currentMembers }),
      });
    });

    page.route("**/api/devices**", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ devices: [] }),
      });
    });

    page.route("**/api/users**", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          members: [makeOwner(), makeMember([{ id: LOCATION_ID, name: LOCATION_NAME }])],
          me: { role: "owner", email: OWNER_EMAIL, allowedPages: null, customRoleId: null },
        }),
      });
    });

    page.route("**/api/brands**", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ brands: [] }),
      });
    });
  }

  test(
    "Location detail Members section shows assigned member",
    async ({ page }) => {
      await setupClerkTestingToken({ page });

      mockLocationRoutes(
        page,
        [{ id: MEMBER_ID, email: MEMBER_EMAIL, role: "member", role_name: ROLE_NAME }],
      );

      await page.goto(`/locations/${LOCATION_ID}`, { waitUntil: "domcontentloaded" });
      await expect(page.getByRole("heading", { name: LOCATION_NAME })).toBeVisible({ timeout: 15_000 });

      // Members section heading should appear
      await expect(page.getByText(/Members\s*\(\d+\)/)).toBeVisible({ timeout: 12_000 });

      // The member row should be visible
      const memberCard = page.getByTestId(`location-member-${MEMBER_ID}`);
      await expect(memberCard).toBeVisible({ timeout: 8_000 });
      await expect(memberCard).toContainText(MEMBER_EMAIL);
    },
  );

  test(
    "Location detail Members section — add member via dialog then remove them",
    async ({ page }) => {
      await setupClerkTestingToken({ page });

      mockLocationRoutes(page, [], { removedMemberId: MEMBER_ID });

      await page.goto(`/locations/${LOCATION_ID}`, { waitUntil: "domcontentloaded" });
      await expect(page.getByRole("heading", { name: LOCATION_NAME })).toBeVisible({ timeout: 15_000 });

      // Members section heading should appear
      await expect(page.getByText(/Members\s*\(\d+\)/)).toBeVisible({ timeout: 12_000 });

      // No members assigned yet
      await expect(page.getByTestId(`location-member-${MEMBER_ID}`)).not.toBeVisible();
      await expect(page.getByText("No members assigned to this location.")).toBeVisible();

      // Open add member dialog
      const addMemberButton = page.getByTestId("button-add-member-to-location");
      await expect(addMemberButton).toBeVisible({ timeout: 5_000 });
      await addMemberButton.click();

      const addDialog = page.getByTestId("dialog-add-member-to-location");
      await expect(addDialog).toBeVisible({ timeout: 5_000 });
      await expect(addDialog).toContainText(LOCATION_NAME);

      // Select the member from the dropdown
      const memberSelect = page.getByTestId("select-member-to-add");
      await memberSelect.click();
      const memberOption = page.getByRole("option", { name: new RegExp(MEMBER_EMAIL) });
      await expect(memberOption).toBeVisible({ timeout: 5_000 });
      await memberOption.click();

      // Confirm the addition
      const confirmAddButton = page.getByTestId("button-confirm-add-member");
      await expect(confirmAddButton).toBeEnabled();
      await confirmAddButton.click();

      await expect(addDialog).not.toBeVisible({ timeout: 8_000 });

      // Member card should appear
      const memberCard = page.getByTestId(`location-member-${MEMBER_ID}`);
      await expect(memberCard).toBeVisible({ timeout: 8_000 });
      await expect(memberCard).toContainText(MEMBER_EMAIL);

      // Now remove the member
      const removeButton = page.getByTestId(`button-remove-member-${MEMBER_ID}`);
      await expect(removeButton).toBeVisible();
      await removeButton.click();

      // Member card should disappear
      await expect(memberCard).not.toBeVisible({ timeout: 8_000 });

      // Empty state should re-appear
      await expect(page.getByText("No members assigned to this location.")).toBeVisible({ timeout: 5_000 });
    },
  );
});

test.describe("Member location assignment — location-restricted member view", () => {
  test(
    "a member with location assignments only sees their assigned location in the locations list",
    async ({ page }) => {
      await setupClerkTestingToken({ page });

      // Simulate what the API returns for a location-restricted member:
      // - /api/locations returns only their assigned location
      // - /api/users returns me.role as "member"
      await page.route("**/api/locations**", async (route) => {
        const url = route.request().url();
        // Pass through location-detail sub-paths
        if (url.match(/\/api\/locations\/\d+\//)) {
          await route.continue();
          return;
        }
        // Only return LOC_A (the member's assigned location)
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            locations: [
              { id: LOC_A_ID, name: LOC_A_NAME, location_type: "Point of Sale" },
            ],
          }),
        });
      });

      await page.route("**/api/users**", async (route) => {
        if (route.request().method() !== "GET") {
          await route.continue();
          return;
        }
        // Return current user as a non-owner member with LOC_A assigned
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            members: [makeMember([{ id: LOC_A_ID, name: LOC_A_NAME }])],
            me: {
              role: "member",
              email: MEMBER_EMAIL,
              allowedPages: null,
              customRoleId: ROLE_ID,
            },
          }),
        });
      });

      await page.goto("/locations", { waitUntil: "domcontentloaded" });
      await expect(page.getByRole("heading", { name: "Locations" })).toBeVisible({ timeout: 15_000 });

      // Only LOC_A should be present; LOC_B should not appear
      await expect(page.getByText(LOC_A_NAME)).toBeVisible({ timeout: 12_000 });
      await expect(page.getByText(LOC_B_NAME)).not.toBeVisible();
    },
  );
});

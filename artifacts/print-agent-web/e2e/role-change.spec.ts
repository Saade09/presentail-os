import { test, expect } from "./fixtures";
import { setupClerkTestingToken } from "@clerk/testing/playwright";

const OWNER_ID = 1;
const MEMBER_ID = 2;
const OWNER_EMAIL = "e2e-tester@presentail.com";
const MEMBER_EMAIL = "member@example.com";

const ROLE_STAFF_ID = 10;
const ROLE_STAFF_NAME = "Staff";
const ROLE_ADMIN_ID = 20;
const ROLE_ADMIN_NAME = "Admin";

const MOCK_ROLES = {
  roles: [
    { id: ROLE_STAFF_ID, name: ROLE_STAFF_NAME },
    { id: ROLE_ADMIN_ID, name: ROLE_ADMIN_NAME },
  ],
};

function membersResponse(roleId: number, roleName: string) {
  return {
    members: [
      {
        id: OWNER_ID,
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
        first_name: null,
        last_name: null,
        image_url: null,
        invite_token: null,
        assigned_locations: [],
      },
      {
        id: MEMBER_ID,
        email: MEMBER_EMAIL,
        role: "member",
        custom_role_id: roleId,
        role_name: roleName,
        joined: true,
        joined_at: new Date().toISOString(),
        invited_at: new Date().toISOString(),
        invited_by_email: OWNER_EMAIL,
        manager_member_id: null,
        manager_email: null,
        first_name: null,
        last_name: null,
        image_url: null,
        invite_token: null,
        assigned_locations: [],
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

test.describe("Role-change confirmation dialog", () => {
  test(
    "selecting a new role, confirming the dialog updates the role badge in the member row",
    async ({ page }) => {
      await setupClerkTestingToken({ page });

      let roleChanged = false;
      const capturedPatchBodies: unknown[] = [];

      await page.route("**/api/roles**", async (route) => {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify(MOCK_ROLES),
        });
      });

      await page.route("**/api/locations**", async (route) => {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ locations: [] }),
        });
      });

      await page.route("**/api/users**", async (route) => {
        const method = route.request().method();
        const url = route.request().url();

        if (method === "PATCH" && url.match(/\/api\/users\/\d+/)) {
          const body = JSON.parse(route.request().postData() ?? "{}");
          capturedPatchBodies.push(body);
          roleChanged = true;
          await route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify({
              member: {
                id: MEMBER_ID,
                email: MEMBER_EMAIL,
                role: "member",
                custom_role_id: ROLE_ADMIN_ID,
                role_name: ROLE_ADMIN_NAME,
                joined: true,
                joined_at: new Date().toISOString(),
                invited_at: new Date().toISOString(),
                invited_by_email: OWNER_EMAIL,
                manager_member_id: null,
                manager_email: null,
                first_name: null,
                last_name: null,
                image_url: null,
                invite_token: null,
                assigned_locations: [],
              },
            }),
          });
          return;
        }

        if (method === "GET") {
          const currentRoleId = roleChanged ? ROLE_ADMIN_ID : ROLE_STAFF_ID;
          const currentRoleName = roleChanged ? ROLE_ADMIN_NAME : ROLE_STAFF_NAME;
          await route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify(membersResponse(currentRoleId, currentRoleName)),
          });
          return;
        }

        await route.continue();
      });

      await page.goto("/users", { waitUntil: "domcontentloaded" });
      await expect(page.getByRole("heading", { name: "Members" })).toBeVisible({ timeout: 15_000 });

      const memberRow = page.getByTestId(`member-${MEMBER_ID}`);
      await expect(memberRow).toBeVisible({ timeout: 12_000 });

      // Initial role badge should show "Staff"
      await expect(memberRow).toContainText(ROLE_STAFF_NAME);

      // Open the role dropdown and select "Admin"
      const roleSelect = page.getByTestId(`select-role-${MEMBER_ID}`);
      await roleSelect.click();

      const adminOption = page.getByRole("option", { name: ROLE_ADMIN_NAME });
      await expect(adminOption).toBeVisible({ timeout: 5_000 });
      await adminOption.click();

      // Confirmation dialog should appear with the member email and new role
      const confirmDialog = page.getByTestId("dialog-confirm-role-change");
      await expect(confirmDialog).toBeVisible({ timeout: 5_000 });
      await expect(confirmDialog).toContainText(MEMBER_EMAIL);
      await expect(confirmDialog).toContainText(ROLE_ADMIN_NAME);

      // Confirm the change
      const confirmButton = page.getByTestId("button-confirm-role-change");
      await confirmButton.click();

      await expect(confirmDialog).not.toBeVisible({ timeout: 8_000 });

      // Member row should now show the new role badge "Admin"
      await expect(memberRow).toContainText(ROLE_ADMIN_NAME, { timeout: 8_000 });

      // Verify the PATCH request was sent with the correct roleId
      expect(capturedPatchBodies.length).toBeGreaterThan(0);
      const lastPatch = capturedPatchBodies[capturedPatchBodies.length - 1] as Record<string, unknown>;
      expect(lastPatch.roleId).toBe(ROLE_ADMIN_ID);
    },
  );

  test(
    "a server error during role change dismisses the dialog and leaves the role badge unchanged",
    async ({ page }) => {
      await setupClerkTestingToken({ page });

      let patchCalled = false;

      await page.route("**/api/roles**", async (route) => {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify(MOCK_ROLES),
        });
      });

      await page.route("**/api/locations**", async (route) => {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ locations: [] }),
        });
      });

      await page.route("**/api/users**", async (route) => {
        const method = route.request().method();
        const url = route.request().url();

        if (method === "PATCH" && url.match(/\/api\/users\/\d+/)) {
          patchCalled = true;
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
            body: JSON.stringify(membersResponse(ROLE_STAFF_ID, ROLE_STAFF_NAME)),
          });
          return;
        }

        await route.continue();
      });

      await page.goto("/users", { waitUntil: "domcontentloaded" });
      await expect(page.getByRole("heading", { name: "Members" })).toBeVisible({ timeout: 15_000 });

      const memberRow = page.getByTestId(`member-${MEMBER_ID}`);
      await expect(memberRow).toBeVisible({ timeout: 12_000 });

      // Initial role badge shows "Staff"
      await expect(memberRow).toContainText(ROLE_STAFF_NAME);

      // Open the role dropdown and pick "Admin"
      const roleSelect = page.getByTestId(`select-role-${MEMBER_ID}`);
      await roleSelect.click();

      const adminOption = page.getByRole("option", { name: ROLE_ADMIN_NAME });
      await expect(adminOption).toBeVisible({ timeout: 5_000 });
      await adminOption.click();

      // Confirmation dialog appears
      const confirmDialog = page.getByTestId("dialog-confirm-role-change");
      await expect(confirmDialog).toBeVisible({ timeout: 5_000 });

      // Confirm — triggers the failing PATCH
      const confirmButton = page.getByTestId("button-confirm-role-change");
      await confirmButton.click();

      // Dialog should be dismissed even though the request failed
      await expect(confirmDialog).not.toBeVisible({ timeout: 8_000 });

      // An error toast should appear
      await expect(page.getByText("Could not change role", { exact: true })).toBeVisible({ timeout: 5_000 });

      // Role badge must still show the original "Staff" — not "Admin"
      await expect(memberRow).toContainText(ROLE_STAFF_NAME);
      await expect(memberRow).not.toContainText(ROLE_ADMIN_NAME);

      // The PATCH was indeed sent (confirming the mutation ran)
      expect(patchCalled).toBe(true);
    },
  );

  test(
    "cancelling the role-change dialog leaves the role badge unchanged",
    async ({ page }) => {
      await setupClerkTestingToken({ page });

      let patchCalled = false;

      await page.route("**/api/roles**", async (route) => {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify(MOCK_ROLES),
        });
      });

      await page.route("**/api/locations**", async (route) => {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ locations: [] }),
        });
      });

      await page.route("**/api/users**", async (route) => {
        const method = route.request().method();
        const url = route.request().url();

        if (method === "PATCH" && url.match(/\/api\/users\/\d+/)) {
          patchCalled = true;
          await route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify({}),
          });
          return;
        }

        if (method === "GET") {
          await route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify(membersResponse(ROLE_STAFF_ID, ROLE_STAFF_NAME)),
          });
          return;
        }

        await route.continue();
      });

      await page.goto("/users", { waitUntil: "domcontentloaded" });
      await expect(page.getByRole("heading", { name: "Members" })).toBeVisible({ timeout: 15_000 });

      const memberRow = page.getByTestId(`member-${MEMBER_ID}`);
      await expect(memberRow).toBeVisible({ timeout: 12_000 });

      // Initial role badge shows "Staff"
      await expect(memberRow).toContainText(ROLE_STAFF_NAME);

      // Open the role dropdown and pick "Admin"
      const roleSelect = page.getByTestId(`select-role-${MEMBER_ID}`);
      await roleSelect.click();

      const adminOption = page.getByRole("option", { name: ROLE_ADMIN_NAME });
      await expect(adminOption).toBeVisible({ timeout: 5_000 });
      await adminOption.click();

      // Confirmation dialog appears
      const confirmDialog = page.getByTestId("dialog-confirm-role-change");
      await expect(confirmDialog).toBeVisible({ timeout: 5_000 });

      // Cancel instead of confirming
      const cancelButton = page.getByTestId("button-cancel-role-change");
      await cancelButton.click();

      await expect(confirmDialog).not.toBeVisible({ timeout: 5_000 });

      // Role badge should still show "Staff" — no change made
      await expect(memberRow).toContainText(ROLE_STAFF_NAME);
      await expect(memberRow).not.toContainText(ROLE_ADMIN_NAME);

      // No PATCH request should have been sent
      expect(patchCalled).toBe(false);
    },
  );
});

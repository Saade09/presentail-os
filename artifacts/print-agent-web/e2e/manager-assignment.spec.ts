import { test, expect } from "./fixtures";
import { setupClerkTestingToken } from "@clerk/testing/playwright";

const OWNER_ID = 1;
const MEMBER_ID = 2;
const OWNER_EMAIL = "e2e-tester@presentail.com";
const MEMBER_EMAIL = "new-teammate@example.com";
const ROLE_ID = 10;
const ROLE_NAME = "Staff";

const MOCK_ROLES = {
  roles: [{ id: ROLE_ID, name: ROLE_NAME }],
};

function ownerOnlyResponse() {
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

function twoMembersResponse(managerMemberId: number | null, managerEmail: string | null) {
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
      },
      {
        id: MEMBER_ID,
        email: MEMBER_EMAIL,
        role: "member",
        custom_role_id: ROLE_ID,
        role_name: ROLE_NAME,
        joined: true,
        joined_at: new Date().toISOString(),
        invited_at: new Date().toISOString(),
        invited_by_email: OWNER_EMAIL,
        manager_member_id: managerMemberId,
        manager_email: managerEmail,
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

test.describe("Manager assignment flow", () => {
  test(
    "invite a member, assign a manager, confirm the dialog, and verify the display updates",
    async ({ page }) => {
      await setupClerkTestingToken({ page });

      let memberInvited = false;
      let managerAssigned = false;
      const capturedPatchBodies: unknown[] = [];

      await page.route("**/api/roles**", async (route) => {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify(MOCK_ROLES),
        });
      });

      await page.route("**/api/users**", async (route) => {
        const method = route.request().method();
        const url = route.request().url();

        if (method === "POST") {
          memberInvited = true;
          await route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify({
              member: {
                id: MEMBER_ID,
                email: MEMBER_EMAIL,
                role: "member",
                custom_role_id: ROLE_ID,
                role_name: ROLE_NAME,
                joined: false,
                joined_at: null,
                invited_at: new Date().toISOString(),
                invited_by_email: OWNER_EMAIL,
                manager_member_id: null,
                manager_email: null,
              },
            }),
          });
          return;
        }

        if (method === "PATCH" && url.match(/\/api\/users\/\d+/)) {
          const body = JSON.parse(route.request().postData() ?? "{}");
          capturedPatchBodies.push(body);
          managerAssigned = true;
          await route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify({
              member: {
                id: MEMBER_ID,
                email: MEMBER_EMAIL,
                role: "member",
                custom_role_id: ROLE_ID,
                role_name: ROLE_NAME,
                joined: false,
                joined_at: null,
                invited_at: new Date().toISOString(),
                invited_by_email: OWNER_EMAIL,
                manager_member_id: OWNER_ID,
                manager_email: OWNER_EMAIL,
              },
            }),
          });
          return;
        }

        if (method === "GET") {
          if (!memberInvited) {
            await route.fulfill({
              status: 200,
              contentType: "application/json",
              body: JSON.stringify(ownerOnlyResponse()),
            });
          } else {
            const managerMemberId = managerAssigned ? OWNER_ID : null;
            const managerEmail = managerAssigned ? OWNER_EMAIL : null;
            await route.fulfill({
              status: 200,
              contentType: "application/json",
              body: JSON.stringify(twoMembersResponse(managerMemberId, managerEmail)),
            });
          }
          return;
        }

        await route.continue();
      });

      await page.goto("/users", { waitUntil: "domcontentloaded" });
      await expect(page.getByRole("heading", { name: "Members" })).toBeVisible({ timeout: 15_000 });

      // --- Invite a member ---
      const emailInput = page.getByTestId("input-invite-email");
      await expect(emailInput).toBeVisible({ timeout: 12_000 });
      await emailInput.fill(MEMBER_EMAIL);

      const roleTrigger = page.getByTestId("select-trigger-invite-role");
      await roleTrigger.click();
      const roleOption = page.getByRole("option", { name: ROLE_NAME });
      await expect(roleOption).toBeVisible({ timeout: 5_000 });
      await roleOption.click();

      const inviteButton = page.getByTestId("button-invite");
      await inviteButton.click();

      // Member row should appear after invite
      const memberRow = page.getByTestId(`member-${MEMBER_ID}`);
      await expect(memberRow).toBeVisible({ timeout: 10_000 });

      // Manager display starts as "—"
      const managerDisplay = page.getByTestId(`manager-display-${MEMBER_ID}`);
      await expect(managerDisplay).toContainText("Manager: —");

      // --- Assign a manager ---
      const managerSelect = page.getByTestId(`select-manager-${MEMBER_ID}`);
      await managerSelect.click();

      const ownerOption = page.getByRole("option", { name: OWNER_EMAIL });
      await expect(ownerOption).toBeVisible({ timeout: 5_000 });
      await ownerOption.click();

      // Confirmation dialog appears and shows both emails
      const confirmDialog = page.getByTestId("dialog-confirm-manager-change");
      await expect(confirmDialog).toBeVisible({ timeout: 5_000 });
      await expect(confirmDialog).toContainText(MEMBER_EMAIL);
      await expect(confirmDialog).toContainText(OWNER_EMAIL);

      const confirmButton = page.getByTestId("button-confirm-manager-change");
      await confirmButton.click();

      await expect(confirmDialog).not.toBeVisible({ timeout: 8_000 });

      // Manager display updates to show the owner's email
      await expect(managerDisplay).toContainText(OWNER_EMAIL, { timeout: 8_000 });

      // Verify the PATCH request sent the correct payload
      expect(capturedPatchBodies.length).toBeGreaterThan(0);
      const lastPatch = capturedPatchBodies[capturedPatchBodies.length - 1] as Record<string, unknown>;
      expect(lastPatch.managerMemberId).toBe(OWNER_ID);
    },
  );

  test(
    "a server error during manager change dismisses the dialog and leaves the manager unchanged",
    async ({ page }) => {
      await setupClerkTestingToken({ page });

      let patchCalled = false;
      let capturedPatchBody: Record<string, unknown> | null = null;

      await page.route("**/api/roles**", async (route) => {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify(MOCK_ROLES),
        });
      });

      await page.route("**/api/users**", async (route) => {
        const method = route.request().method();
        const url = route.request().url();

        if (method === "PATCH" && url.match(/\/api\/users\/\d+/)) {
          patchCalled = true;
          capturedPatchBody = JSON.parse(route.request().postData() ?? "{}");
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
            body: JSON.stringify(twoMembersResponse(OWNER_ID, OWNER_EMAIL)),
          });
          return;
        }

        await route.continue();
      });

      await page.goto("/users", { waitUntil: "domcontentloaded" });
      await expect(page.getByRole("heading", { name: "Members" })).toBeVisible({ timeout: 15_000 });

      const memberRow = page.getByTestId(`member-${MEMBER_ID}`);
      await expect(memberRow).toBeVisible({ timeout: 12_000 });

      const managerDisplay = page.getByTestId(`manager-display-${MEMBER_ID}`);
      await expect(managerDisplay).toContainText(OWNER_EMAIL);

      // Open manager dropdown and pick "No manager" — triggers the confirmation dialog
      const managerSelect = page.getByTestId(`select-manager-${MEMBER_ID}`);
      await managerSelect.click();

      const noManagerOption = page.getByRole("option", { name: "No manager" });
      await expect(noManagerOption).toBeVisible({ timeout: 5_000 });
      await noManagerOption.click();

      // Confirmation dialog should appear
      const confirmDialog = page.getByTestId("dialog-confirm-manager-change");
      await expect(confirmDialog).toBeVisible({ timeout: 5_000 });

      // Confirming triggers the PATCH, which returns 500
      const confirmButton = page.getByTestId("button-confirm-manager-change");
      await confirmButton.click();

      // Dialog should be dismissed even though the request failed
      await expect(confirmDialog).not.toBeVisible({ timeout: 8_000 });

      // An error toast should appear
      await expect(page.getByText("Could not update manager", { exact: true })).toBeVisible({ timeout: 5_000 });

      // Manager display must still show the original manager — not "—"
      await expect(managerDisplay).toContainText(OWNER_EMAIL);
      await expect(managerDisplay).not.toContainText("—");

      // The PATCH was sent with the correct payload (managerMemberId: null to clear)
      expect(patchCalled).toBe(true);
      expect(capturedPatchBody).not.toBeNull();
      expect((capturedPatchBody as Record<string, unknown>).managerMemberId).toBeNull();
    },
  );

  test(
    "clear a manager and verify the display reverts to dash",
    async ({ page }) => {
      await setupClerkTestingToken({ page });

      let patchCalled = false;
      const capturedPatchBodies: unknown[] = [];

      await page.route("**/api/roles**", async (route) => {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify(MOCK_ROLES),
        });
      });

      await page.route("**/api/users**", async (route) => {
        const method = route.request().method();
        const url = route.request().url();

        if (method === "PATCH" && url.match(/\/api\/users\/\d+/)) {
          const body = JSON.parse(route.request().postData() ?? "{}");
          capturedPatchBodies.push(body);
          patchCalled = true;
          await route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify({
              member: {
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
              },
            }),
          });
          return;
        }

        if (method === "GET") {
          const managerMemberId = patchCalled ? null : OWNER_ID;
          const managerEmail = patchCalled ? null : OWNER_EMAIL;
          await route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify(twoMembersResponse(managerMemberId, managerEmail)),
          });
          return;
        }

        await route.continue();
      });

      await page.goto("/users", { waitUntil: "domcontentloaded" });
      await expect(page.getByRole("heading", { name: "Members" })).toBeVisible({ timeout: 15_000 });

      const memberRow = page.getByTestId(`member-${MEMBER_ID}`);
      await expect(memberRow).toBeVisible({ timeout: 12_000 });

      const managerDisplay = page.getByTestId(`manager-display-${MEMBER_ID}`);
      await expect(managerDisplay).toContainText(OWNER_EMAIL);

      const managerSelect = page.getByTestId(`select-manager-${MEMBER_ID}`);
      await managerSelect.click();

      const noManagerOption = page.getByRole("option", { name: "No manager" });
      await expect(noManagerOption).toBeVisible({ timeout: 5_000 });
      await noManagerOption.click();

      const confirmDialog = page.getByTestId("dialog-confirm-manager-change");
      await expect(confirmDialog).toBeVisible({ timeout: 5_000 });
      await expect(confirmDialog).toContainText(MEMBER_EMAIL);

      const confirmButton = page.getByTestId("button-confirm-manager-change");
      await confirmButton.click();

      await expect(confirmDialog).not.toBeVisible({ timeout: 8_000 });

      // Manager display reverts to "—"
      await expect(managerDisplay).toContainText("—", { timeout: 8_000 });

      // Verify the PATCH request sent null for managerMemberId
      expect(capturedPatchBodies.length).toBeGreaterThan(0);
      const lastPatch = capturedPatchBodies[capturedPatchBodies.length - 1] as Record<string, unknown>;
      expect(lastPatch.managerMemberId).toBeNull();
    },
  );

  test(
    "cancelling the manager-change confirmation dialog sends no PATCH and leaves the manager unchanged",
    async ({ page }) => {
      await setupClerkTestingToken({ page });

      let patchCount = 0;

      await page.route("**/api/roles**", async (route) => {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify(MOCK_ROLES),
        });
      });

      await page.route("**/api/users**", async (route) => {
        const method = route.request().method();
        const url = route.request().url();

        if (method === "PATCH" && url.match(/\/api\/users\/\d+/)) {
          patchCount += 1;
          await route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify({ member: null }),
          });
          return;
        }

        if (method === "GET") {
          await route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify(twoMembersResponse(OWNER_ID, OWNER_EMAIL)),
          });
          return;
        }

        await route.continue();
      });

      await page.goto("/users", { waitUntil: "domcontentloaded" });
      await expect(page.getByRole("heading", { name: "Members" })).toBeVisible({ timeout: 15_000 });

      const memberRow = page.getByTestId(`member-${MEMBER_ID}`);
      await expect(memberRow).toBeVisible({ timeout: 12_000 });

      const managerDisplay = page.getByTestId(`manager-display-${MEMBER_ID}`);
      await expect(managerDisplay).toContainText(OWNER_EMAIL);
      const originalManagerText = (await managerDisplay.textContent()) ?? "";

      // Open manager dropdown and pick "No manager" — opens confirmation dialog
      const managerSelect = page.getByTestId(`select-manager-${MEMBER_ID}`);
      await managerSelect.click();

      const noManagerOption = page.getByRole("option", { name: "No manager" });
      await expect(noManagerOption).toBeVisible({ timeout: 5_000 });
      await noManagerOption.click();

      const confirmDialog = page.getByTestId("dialog-confirm-manager-change");
      await expect(confirmDialog).toBeVisible({ timeout: 5_000 });

      // Click Cancel
      const cancelButton = page.getByTestId("button-cancel-manager-change");
      await cancelButton.click();

      // Dialog dismisses
      await expect(confirmDialog).not.toBeVisible({ timeout: 8_000 });

      // Give any in-flight request a chance to fire, then assert none did
      await page.waitForTimeout(500);
      expect(patchCount).toBe(0);

      // Manager display unchanged
      await expect(managerDisplay).toHaveText(originalManagerText);
      await expect(managerDisplay).toContainText(OWNER_EMAIL);
    },
  );
});

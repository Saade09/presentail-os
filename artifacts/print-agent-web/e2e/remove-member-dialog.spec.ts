import { test, expect } from "./fixtures";
import { setupClerkTestingToken } from "@clerk/testing/playwright";

const OWNER_ID = 1;
const MEMBER_ID = 2;
const INVITE_ID = 3;
const OWNER_EMAIL = "e2e-tester@presentail.com";
const MEMBER_EMAIL = "joined-member@example.com";
const INVITE_EMAIL = "pending-invite@example.com";

const MOCK_ROLES = { roles: [{ id: 10, name: "Staff" }] };

function makeMember(overrides: Record<string, unknown>) {
  return {
    id: 0,
    email: "",
    role: "member",
    custom_role_id: 10,
    role_name: "Staff",
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
    job_title: null,
    department: null,
    employment_status: "active",
    employment_type: "full_time",
    start_date: null,
    location: null,
    working_days: null,
    ...overrides,
  };
}

const MOCK_MEMBERS = {
  members: [
    makeMember({
      id: OWNER_ID,
      email: OWNER_EMAIL,
      role: "owner",
      custom_role_id: null,
      role_name: null,
      invited_by_email: null,
    }),
    makeMember({
      id: MEMBER_ID,
      email: MEMBER_EMAIL,
    }),
    makeMember({
      id: INVITE_ID,
      email: INVITE_EMAIL,
      joined: false,
      joined_at: null,
      invite_token: "tok_abc123",
    }),
  ],
  me: {
    role: "owner",
    email: OWNER_EMAIL,
    allowedPages: null,
    customRoleId: null,
  },
};

async function setupCommonMocks(page: import("@playwright/test").Page) {
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

  await page.route("**/api/users/role-audit-log**", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ entries: [] }),
    });
  });

  await page.route("**/api/users/failed-access-requests**", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ failedRequests: [] }),
    });
  });

  await page.route("**/api/access-requests**", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ accessRequests: [] }),
    });
  });

  await page.route("**/api/users**", async (route) => {
    if (route.request().method() === "GET") {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(MOCK_MEMBERS),
      });
      return;
    }
    await route.continue();
  });
}

test.describe("Remove-member confirmation flow", () => {
  test(
    "clicking Confirm sends DELETE /api/users/:id for a joined member and closes the dialog",
    async ({ page }) => {
      await setupClerkTestingToken({ page });
      await setupCommonMocks(page);

      let deleteCalledUrl: string | null = null;
      await page.route(`**/api/users/${MEMBER_ID}`, async (route) => {
        if (route.request().method() === "DELETE") {
          deleteCalledUrl = route.request().url();
          await route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify({ success: true }),
          });
          return;
        }
        await route.continue();
      });

      await page.goto("/users", { waitUntil: "domcontentloaded" });
      await expect(page.getByRole("heading", { name: "Members" })).toBeVisible({ timeout: 15_000 });

      const memberRow = page.getByTestId(`member-${MEMBER_ID}`);
      await expect(memberRow).toBeVisible({ timeout: 12_000 });

      const menuTrigger = page.getByTestId(`button-member-menu-${MEMBER_ID}`);
      await menuTrigger.click();

      const removeButton = page.getByTestId(`button-remove-${MEMBER_ID}`);
      await expect(removeButton).toBeVisible({ timeout: 5_000 });
      await removeButton.click();

      const dialog = page.getByTestId("dialog-confirm-remove");
      await expect(dialog).toBeVisible({ timeout: 5_000 });

      const deleteRequestPromise = page.waitForRequest(
        (req) =>
          req.url().includes(`/api/users/${MEMBER_ID}`) &&
          req.method() === "DELETE",
      );

      await page.getByTestId("button-confirm-remove").click();

      await deleteRequestPromise;

      expect(deleteCalledUrl).toMatch(`/api/users/${MEMBER_ID}`);

      await expect(dialog).not.toBeVisible({ timeout: 8_000 });
    },
  );

  test(
    "clicking Confirm sends DELETE /api/users/:id for a pending invite and removes the invite row",
    async ({ page }) => {
      await setupClerkTestingToken({ page });
      await setupCommonMocks(page);

      let deleteCalledUrl: string | null = null;
      let getUsersCallCount = 0;

      const membersWithoutInvite = {
        ...MOCK_MEMBERS,
        members: MOCK_MEMBERS.members.filter((m) => m.id !== INVITE_ID),
      };

      await page.route("**/api/users**", async (route) => {
        if (route.request().method() === "GET") {
          getUsersCallCount += 1;
          const body =
            getUsersCallCount === 1 ? MOCK_MEMBERS : membersWithoutInvite;
          await route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify(body),
          });
          return;
        }
        await route.continue();
      });

      await page.route(`**/api/users/${INVITE_ID}`, async (route) => {
        if (route.request().method() === "DELETE") {
          deleteCalledUrl = route.request().url();
          await route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify({ success: true }),
          });
          return;
        }
        await route.continue();
      });

      await page.goto("/users", { waitUntil: "domcontentloaded" });
      await expect(page.getByRole("heading", { name: "Members" })).toBeVisible({ timeout: 15_000 });

      const inviteRow = page.getByTestId(`member-${INVITE_ID}`);
      await expect(inviteRow).toBeVisible({ timeout: 12_000 });

      const revokeButton = page.getByTestId(`button-revoke-invite-${INVITE_ID}`);
      await expect(revokeButton).toBeVisible({ timeout: 5_000 });
      await revokeButton.click();

      const dialog = page.getByTestId("dialog-confirm-remove");
      await expect(dialog).toBeVisible({ timeout: 5_000 });

      const deleteRequestPromise = page.waitForRequest(
        (req) =>
          req.url().includes(`/api/users/${INVITE_ID}`) &&
          req.method() === "DELETE",
      );

      await page.getByTestId("button-confirm-remove").click();

      await deleteRequestPromise;

      expect(deleteCalledUrl).toMatch(`/api/users/${INVITE_ID}`);

      await expect(dialog).not.toBeVisible({ timeout: 8_000 });
      await expect(inviteRow).not.toBeVisible({ timeout: 8_000 });
    },
  );
});

test.describe("Remove-member warning dialog", () => {
  test(
    "shows the permanent-deletion warning for a joined member",
    async ({ page }) => {
      await setupClerkTestingToken({ page });
      await setupCommonMocks(page);

      await page.goto("/users", { waitUntil: "domcontentloaded" });
      await expect(page.getByRole("heading", { name: "Members" })).toBeVisible({ timeout: 15_000 });

      const memberRow = page.getByTestId(`member-${MEMBER_ID}`);
      await expect(memberRow).toBeVisible({ timeout: 12_000 });

      // Open the three-dot dropdown for the joined member
      const menuTrigger = page.getByTestId(`button-member-menu-${MEMBER_ID}`);
      await expect(menuTrigger).toBeVisible({ timeout: 5_000 });
      await menuTrigger.click();

      const removeButton = page.getByTestId(`button-remove-${MEMBER_ID}`);
      await expect(removeButton).toBeVisible({ timeout: 5_000 });
      await removeButton.click();

      const dialog = page.getByTestId("dialog-confirm-remove");
      await expect(dialog).toBeVisible({ timeout: 5_000 });

      // Permanent-deletion warning must be present
      await expect(dialog).toContainText("permanently remove");
      await expect(dialog).toContainText("delete their Presentail OS login");
      await expect(dialog).toContainText(MEMBER_EMAIL);

      // Invite-revocation text must NOT appear
      await expect(dialog).not.toContainText("invite will be revoked");

      await page.getByTestId("button-cancel-remove").click();
      await expect(dialog).not.toBeVisible({ timeout: 5_000 });
    },
  );

  test(
    "shows the invite-revocation message for a pending invite (no login-deletion warning)",
    async ({ page }) => {
      await setupClerkTestingToken({ page });
      await setupCommonMocks(page);

      await page.goto("/users", { waitUntil: "domcontentloaded" });
      await expect(page.getByRole("heading", { name: "Members" })).toBeVisible({ timeout: 15_000 });

      const inviteRow = page.getByTestId(`member-${INVITE_ID}`);
      await expect(inviteRow).toBeVisible({ timeout: 12_000 });

      // The pending section has a direct "Revoke" button — no dropdown needed
      const revokeButton = page.getByTestId(`button-revoke-invite-${INVITE_ID}`);
      await expect(revokeButton).toBeVisible({ timeout: 5_000 });
      await revokeButton.click();

      const dialog = page.getByTestId("dialog-confirm-remove");
      await expect(dialog).toBeVisible({ timeout: 5_000 });

      // Invite-revocation text must be present
      await expect(dialog).toContainText("invite will be revoked");
      await expect(dialog).toContainText("no Presentail OS login will be created");
      await expect(dialog).toContainText(INVITE_EMAIL);

      // Permanent-deletion warning must NOT appear
      await expect(dialog).not.toContainText("permanently remove");
      await expect(dialog).not.toContainText("delete their Presentail OS login");

      await page.getByTestId("button-cancel-remove").click();
      await expect(dialog).not.toBeVisible({ timeout: 5_000 });
    },
  );
});

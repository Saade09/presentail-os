import { test, expect } from "./fixtures";
import { setupClerkTestingToken } from "@clerk/testing/playwright";

const OWNER_ID = 1;
const MEMBER_ID = 2;
const OWNER_EMAIL = "e2e-tester@presentail.com";
const MEMBER_EMAIL = "member-to-remove@example.com";

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
  ],
  me: {
    role: "owner",
    email: OWNER_EMAIL,
    allowedPages: null,
    customRoleId: null,
  },
};

test.describe("Removed-member lockout", () => {
  test(
    "after the owner deletes a member the subsequent GET /api/users returns 401 and the session-expired banner appears",
    async ({ page }) => {
      await setupClerkTestingToken({ page });

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

      // Track how many times GET /api/users has been called so we can switch
      // from success → 401 after the DELETE has completed.
      let getUsersCallCount = 0;
      let deleteCompleted = false;

      await page.route("**/api/users**", async (route) => {
        if (route.request().method() === "GET") {
          getUsersCallCount += 1;

          if (deleteCompleted) {
            // Simulate what the removed member's browser sees once their
            // Clerk session has been revoked: every protected API call
            // returns 401 Unauthorized.
            await route.fulfill({
              status: 401,
              contentType: "application/json",
              body: JSON.stringify({ error: "Unauthorized" }),
            });
            return;
          }

          await route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify(MOCK_MEMBERS),
          });
          return;
        }

        await route.continue();
      });

      // Mock the DELETE call that the owner triggers.
      await page.route(`**/api/users/${MEMBER_ID}`, async (route) => {
        if (route.request().method() === "DELETE") {
          await route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify({ ok: true }),
          });
          deleteCompleted = true;
          return;
        }
        await route.continue();
      });

      await page.goto("/users", { waitUntil: "domcontentloaded" });
      await expect(page.getByRole("heading", { name: "Members" })).toBeVisible({ timeout: 15_000 });

      // Confirm the member row is visible before we remove them.
      const memberRow = page.getByTestId(`member-${MEMBER_ID}`);
      await expect(memberRow).toBeVisible({ timeout: 12_000 });

      // Owner opens the three-dot menu for the member and clicks Remove.
      const menuTrigger = page.getByTestId(`button-member-menu-${MEMBER_ID}`);
      await menuTrigger.click();

      const removeButton = page.getByTestId(`button-remove-${MEMBER_ID}`);
      await expect(removeButton).toBeVisible({ timeout: 5_000 });
      await removeButton.click();

      // Confirm-remove dialog must appear.
      const dialog = page.getByTestId("dialog-confirm-remove");
      await expect(dialog).toBeVisible({ timeout: 5_000 });

      // Capture the DELETE request promise before clicking Confirm so we can
      // await its completion.
      const deleteRequestPromise = page.waitForRequest(
        (req) =>
          req.url().includes(`/api/users/${MEMBER_ID}`) &&
          req.method() === "DELETE",
      );

      await page.getByTestId("button-confirm-remove").click();

      // Ensure the DELETE was actually sent.
      await deleteRequestPromise;

      // After the DELETE the page refetches GET /api/users (React Query
      // invalidation on mutation success).  That refetch now returns 401,
      // which the queryClient's onError listener catches and converts into a
      // "session expired" event — causing the session-expired-banner to mount.
      await expect(
        page.getByTestId("session-expired-banner"),
      ).toBeVisible({ timeout: 10_000 });

      await expect(
        page.getByTestId("session-expired-banner"),
      ).toContainText("Your session expired. Reload to continue.");

      // The DELETE call must have been the only request to /api/users/:id —
      // verify by asserting deleteCompleted flipped to true.
      expect(deleteCompleted).toBe(true);

      // At least two GET /api/users calls must have occurred:
      //  1. Initial page load
      //  2. Refetch after DELETE succeeded (the one that returned 401)
      expect(getUsersCallCount).toBeGreaterThanOrEqual(2);
    },
  );
});

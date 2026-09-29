import { test, expect } from "./fixtures";
import { setupClerkTestingToken } from "@clerk/testing/playwright";

const OWNER_ID = 1;
const OWNER_EMAIL = "e2e-tester@presentail.com";
const REQUEST_ID = 42;
const REQUESTER_EMAIL = "requester@example.com";
const REQUESTER_NAME = "Jane Requester";
const ROLE_ID = 10;
const ROLE_NAME = "Staff";

const MOCK_ROLES = {
  roles: [{ id: ROLE_ID, name: ROLE_NAME }],
};

function ownerUsersResponse() {
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

function pendingAccessRequest() {
  return {
    id: REQUEST_ID,
    requester_clerk_id: "user_abc123",
    requester_email: REQUESTER_EMAIL,
    requester_name: REQUESTER_NAME,
    status: "pending",
    requested_at: new Date().toISOString(),
    resolved_at: null,
  };
}

async function setupCommonRoutes(page: import("@playwright/test").Page) {
  await page.route("**/api/roles**", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(MOCK_ROLES),
    });
  });

  await page.route("**/api/users/failed-access-requests**", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ failedRequests: [] }),
    });
  });

  await page.route("**/api/users**", async (route) => {
    const method = route.request().method();
    const url = route.request().url();
    if (method === "GET" && !url.includes("failed")) {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(ownerUsersResponse()),
      });
      return;
    }
    await route.continue();
  });
}

test.describe("Access request approval flow", () => {
  test(
    "pending request section appears and invite form is pre-filled when owner clicks Approve",
    async ({ page }) => {
      await setupClerkTestingToken({ page });

      let approveCallCount = 0;
      let approveCapturedBody: unknown = null;

      await setupCommonRoutes(page);

      await page.route("**/api/access-requests/**", async (route) => {
        const method = route.request().method();
        const url = route.request().url();

        if (method === "POST" && url.includes("/approve")) {
          approveCapturedBody = JSON.parse(route.request().postData() ?? "{}");
          approveCallCount++;
          await route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify({ ok: true }),
          });
          return;
        }

        await route.continue();
      });

      await page.route("**/api/access-requests", async (route) => {
        const requestsToReturn = approveCallCount > 0 ? [] : [pendingAccessRequest()];
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ requests: requestsToReturn }),
        });
      });

      await page.goto("/users", { waitUntil: "domcontentloaded" });
      await expect(page.getByRole("heading", { name: "Members" })).toBeVisible({ timeout: 15_000 });

      // Access Requests section should be visible with the requester's details
      const requestItem = page.getByTestId(`access-request-${REQUEST_ID}`);
      await expect(requestItem).toBeVisible({ timeout: 12_000 });
      await expect(requestItem).toContainText(REQUESTER_EMAIL);
      await expect(requestItem).toContainText(REQUESTER_NAME);

      // Click the Approve button
      const approveButton = page.getByTestId(`button-approve-request-${REQUEST_ID}`);
      await approveButton.click();

      // The approval dialog should appear showing the requester's email
      const approveDialog = page.getByTestId("dialog-approve-request");
      await expect(approveDialog).toBeVisible({ timeout: 5_000 });
      await expect(approveDialog).toContainText(REQUESTER_EMAIL);

      // The invite form email input should now be pre-filled with the requester's email
      const emailInput = page.getByTestId("input-invite-email");
      await expect(emailInput).toHaveValue(REQUESTER_EMAIL);

      // The "from access request" checkbox should be checked
      const fromAccessRequestCheckbox = page.getByTestId("checkbox-from-access-request");
      await expect(fromAccessRequestCheckbox).toBeChecked();

      // Complete the approval via the dialog: select a role and confirm
      const roleTrigger = page.getByTestId("select-trigger-approve-role");
      await roleTrigger.click();

      const roleOption = page.getByRole("option", { name: ROLE_NAME });
      await expect(roleOption).toBeVisible({ timeout: 5_000 });
      await roleOption.click();

      const confirmButton = page.getByTestId("button-confirm-approve-request");
      await expect(confirmButton).toBeEnabled();
      await confirmButton.click();

      // Dialog should close and the access request row should disappear
      await expect(approveDialog).not.toBeVisible({ timeout: 8_000 });
      await expect(requestItem).not.toBeVisible({ timeout: 8_000 });

      // Verify the approve API was called with the correct payload
      expect(approveCallCount).toBe(1);
      expect(approveCapturedBody).toMatchObject({ roleId: ROLE_ID });
    },
  );

  test(
    "owner rejects a request and request disappears from the list",
    async ({ page }) => {
      await setupClerkTestingToken({ page });

      let rejectCallCount = 0;

      await setupCommonRoutes(page);

      await page.route("**/api/access-requests/**", async (route) => {
        const method = route.request().method();
        const url = route.request().url();

        if (method === "POST" && url.includes("/reject")) {
          rejectCallCount++;
          await route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify({ ok: true }),
          });
          return;
        }

        await route.continue();
      });

      await page.route("**/api/access-requests", async (route) => {
        const requestsToReturn = rejectCallCount > 0 ? [] : [pendingAccessRequest()];
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ requests: requestsToReturn }),
        });
      });

      await page.goto("/users", { waitUntil: "domcontentloaded" });
      await expect(page.getByRole("heading", { name: "Members" })).toBeVisible({ timeout: 15_000 });

      const requestItem = page.getByTestId(`access-request-${REQUEST_ID}`);
      await expect(requestItem).toBeVisible({ timeout: 12_000 });
      await expect(requestItem).toContainText(REQUESTER_EMAIL);

      const rejectButton = page.getByTestId(`button-reject-request-${REQUEST_ID}`);
      await rejectButton.click();

      // The access request item should disappear after rejection
      await expect(requestItem).not.toBeVisible({ timeout: 8_000 });

      // Verify the reject API was called
      expect(rejectCallCount).toBe(1);
    },
  );

  test(
    "closing the approve dialog without confirming leaves the request intact",
    async ({ page }) => {
      await setupClerkTestingToken({ page });

      let approveCallCount = 0;

      await setupCommonRoutes(page);

      await page.route("**/api/access-requests/**", async (route) => {
        const method = route.request().method();
        const url = route.request().url();

        if (method === "POST" && url.includes("/approve")) {
          approveCallCount++;
          await route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify({ ok: true }),
          });
          return;
        }

        await route.continue();
      });

      await page.route("**/api/access-requests", async (route) => {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ requests: [pendingAccessRequest()] }),
        });
      });

      await page.goto("/users", { waitUntil: "domcontentloaded" });
      await expect(page.getByRole("heading", { name: "Members" })).toBeVisible({ timeout: 15_000 });

      const requestItem = page.getByTestId(`access-request-${REQUEST_ID}`);
      await expect(requestItem).toBeVisible({ timeout: 12_000 });

      // Open the approval dialog
      const approveButton = page.getByTestId(`button-approve-request-${REQUEST_ID}`);
      await approveButton.click();

      const approveDialog = page.getByTestId("dialog-approve-request");
      await expect(approveDialog).toBeVisible({ timeout: 5_000 });

      // Click Cancel without confirming
      const cancelButton = page.getByTestId("button-cancel-approve-request");
      await cancelButton.click();

      // Dialog should close
      await expect(approveDialog).not.toBeVisible({ timeout: 5_000 });

      // The access request item should still be visible
      await expect(requestItem).toBeVisible();

      // The approve API must not have been called
      expect(approveCallCount).toBe(0);
    },
  );

  test(
    "access requests section is hidden when there are no pending requests",
    async ({ page }) => {
      await setupClerkTestingToken({ page });

      await setupCommonRoutes(page);

      await page.route("**/api/access-requests", async (route) => {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ requests: [] }),
        });
      });

      await page.goto("/users", { waitUntil: "domcontentloaded" });
      await expect(page.getByRole("heading", { name: "Members" })).toBeVisible({ timeout: 15_000 });

      // The invite section should be visible (user is owner)
      const emailInput = page.getByTestId("input-invite-email");
      await expect(emailInput).toBeVisible({ timeout: 12_000 });

      // No access request items should be present
      const requestItem = page.getByTestId(`access-request-${REQUEST_ID}`);
      await expect(requestItem).not.toBeVisible();
    },
  );
});

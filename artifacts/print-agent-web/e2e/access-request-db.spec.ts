import { test, expect } from "./fixtures";
import { setupClerkTestingToken } from "@clerk/testing/playwright";

const OWNER_EMAIL = "e2e-tester+clerk_test@presentail.com";
const REQUESTER_CLERK_ID = "e2e_ar_db_test_001";
const REQUESTER_EMAIL = "e2e-ar-db-requester@example.com";
const REQUESTER_NAME = "E2E DB Requester";
const TEST_ROLE_NAME = "E2E AR DB Test Role";

const API_BASE = process.env.API_SERVER_URL ?? "http://localhost:8080";

let testRequestId: number;
let testRoleId: number;

async function apiPost(path: string, body: unknown): Promise<unknown> {
  const res = await fetch(`${API_BASE}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`POST ${path} failed (${res.status}): ${text}`);
  }
  return res.json();
}

async function apiDelete(path: string): Promise<void> {
  const res = await fetch(`${API_BASE}${path}`, { method: "DELETE" });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`DELETE ${path} failed (${res.status}): ${text}`);
  }
}

test.describe("Access request approval – DB-backed integration", () => {
  test.beforeAll(async () => {
    const roleData = (await apiPost("/api/test/role", {
      ownerEmail: OWNER_EMAIL,
      name: TEST_ROLE_NAME,
    })) as { id: number };
    testRoleId = roleData.id;

    const arData = (await apiPost("/api/test/access-request", {
      ownerEmail: OWNER_EMAIL,
      requesterClerkId: REQUESTER_CLERK_ID,
      requesterEmail: REQUESTER_EMAIL,
      requesterName: REQUESTER_NAME,
    })) as { id: number };
    testRequestId = arData.id;
  });

  test.afterAll(async () => {
    await apiDelete(
      `/api/test/access-request/${REQUESTER_CLERK_ID}?ownerEmail=${encodeURIComponent(OWNER_EMAIL)}`,
    ).catch(() => {});
    await apiDelete(`/api/test/role/${testRoleId}`).catch(() => {});
  });

  test(
    "seeded access request is visible, invite form pre-fills on Approve, and request disappears after confirmation",
    async ({ page }) => {
      await setupClerkTestingToken({ page });

      await page.goto("/users", { waitUntil: "domcontentloaded" });
      await expect(page.getByRole("heading", { name: "Members" })).toBeVisible({ timeout: 15_000 });

      const requestItem = page.getByTestId(`access-request-${testRequestId}`);
      await expect(requestItem).toBeVisible({ timeout: 15_000 });
      await expect(requestItem).toContainText(REQUESTER_EMAIL);
      await expect(requestItem).toContainText(REQUESTER_NAME);

      const approveButton = page.getByTestId(
        `button-approve-request-${testRequestId}`,
      );
      await approveButton.click();

      const approveDialog = page.getByTestId("dialog-approve-request");
      await expect(approveDialog).toBeVisible({ timeout: 5_000 });
      await expect(approveDialog).toContainText(REQUESTER_EMAIL);

      const emailInput = page.getByTestId("input-invite-email");
      await expect(emailInput).toHaveValue(REQUESTER_EMAIL);

      const fromAccessRequestCheckbox = page.getByTestId(
        "checkbox-from-access-request",
      );
      await expect(fromAccessRequestCheckbox).toBeChecked();

      const roleTrigger = page.getByTestId("select-trigger-approve-role");
      await roleTrigger.click();
      const roleOption = page.getByRole("option", { name: TEST_ROLE_NAME });
      await expect(roleOption).toBeVisible({ timeout: 5_000 });
      await roleOption.click();

      const confirmButton = page.getByTestId("button-confirm-approve-request");
      await expect(confirmButton).toBeEnabled();
      await confirmButton.click();

      await expect(approveDialog).not.toBeVisible({ timeout: 8_000 });
      await expect(requestItem).not.toBeVisible({ timeout: 8_000 });
    },
  );
});

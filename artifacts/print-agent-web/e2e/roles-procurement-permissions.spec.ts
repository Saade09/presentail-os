import { test, expect } from "./fixtures";
import { setupClerkTestingToken } from "@clerk/testing/playwright";
import type { Page } from "@playwright/test";

const OWNER_EMAIL = "e2e-tester+clerk_test@presentail.com";

const ROLE_ID = 42;

const BASE_ROLE = {
  id: ROLE_ID,
  name: "Procurement Manager",
  description: "Manages procurement workflows",
  channel_ids: [] as number[],
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
};

function mockRolesResponse(allowedPages: string[]) {
  return { roles: [{ ...BASE_ROLE, allowed_pages: allowedPages }] };
}

function mockUsersResponse() {
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

async function setupRolesPage(page: Page, allowedPages: string[]) {
  await setupClerkTestingToken({ page });

  await page.route("**/api/users**", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(mockUsersResponse()),
    });
  });

  await page.route("**/api/channels**", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ channels: [] }),
    });
  });

  await page.route("**/api/roles**", async (route) => {
    if (route.request().method() === "GET") {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(mockRolesResponse(allowedPages)),
      });
      return;
    }
    await route.continue();
  });

  await page.goto("/roles", { waitUntil: "domcontentloaded" });

  await expect(page.getByTestId(`role-row-${ROLE_ID}`)).toBeVisible({ timeout: 15_000 });

  await page.getByTestId(`button-edit-role-${ROLE_ID}`).click();

  await expect(page.getByRole("heading", { name: "Edit role" })).toBeVisible({ timeout: 8_000 });
}

test.describe("Roles – Procurement permission group", () => {
  test("Procurement section is visible in the permissions editor", async ({ page }) => {
    await setupRolesPage(page, []);

    await expect(page.getByTestId("checkbox-group-procurement")).toBeVisible({ timeout: 8_000 });
    await expect(page.getByText("Procurement", { exact: true })).toBeVisible();
    await expect(
      page.getByText(
        "Purchase orders, supplier management, procurement workflows, and inventory receiving",
      ),
    ).toBeVisible();
  });

  test("Suppliers and Purchase Orders appear under Procurement, not Catalog or Finance", async ({
    page,
  }) => {
    await setupRolesPage(page, []);

    const procurementGroup = page.locator(".border.rounded-md.overflow-hidden").filter({
      has: page.locator('[data-testid="checkbox-group-procurement"]'),
    });
    const catalogGroup = page.locator(".border.rounded-md.overflow-hidden").filter({
      has: page.locator('[data-testid="checkbox-group-catalog"]'),
    });
    const financeGroup = page.locator(".border.rounded-md.overflow-hidden").filter({
      has: page.locator('[data-testid="checkbox-group-finance"]'),
    });

    await expect(procurementGroup).toBeVisible({ timeout: 8_000 });
    await expect(catalogGroup).toBeVisible();
    await expect(financeGroup).toBeVisible();

    await expect(
      procurementGroup.locator('[data-testid="checkbox-page-suppliers"]'),
    ).toBeVisible();
    await expect(
      procurementGroup.locator('[data-testid="checkbox-page-purchase-orders"]'),
    ).toBeVisible();

    await expect(
      catalogGroup.locator('[data-testid="checkbox-page-suppliers"]'),
    ).toHaveCount(0);
    await expect(
      catalogGroup.locator('[data-testid="checkbox-page-purchase-orders"]'),
    ).toHaveCount(0);

    await expect(
      financeGroup.locator('[data-testid="checkbox-page-suppliers"]'),
    ).toHaveCount(0);
    await expect(
      financeGroup.locator('[data-testid="checkbox-page-purchase-orders"]'),
    ).toHaveCount(0);
  });

  test("toggling a Procurement sub-permission updates the group badge count", async ({ page }) => {
    await setupRolesPage(page, ["suppliers"]);

    const procurementGroup = page.locator(".border.rounded-md.overflow-hidden").filter({
      has: page.locator('[data-testid="checkbox-group-procurement"]'),
    });

    await expect(procurementGroup).toBeVisible({ timeout: 8_000 });

    await expect(procurementGroup.getByText("1", { exact: true })).toBeVisible();

    const suppliersCreateCheckbox = page.getByTestId("checkbox-page-suppliers.create");
    await expect(suppliersCreateCheckbox).toBeVisible({ timeout: 5_000 });
    await suppliersCreateCheckbox.click();

    await expect(procurementGroup.getByText("2", { exact: true })).toBeVisible({ timeout: 5_000 });
    await expect(procurementGroup.getByText("1", { exact: true })).toHaveCount(0);
  });
});

import { test, expect } from "./fixtures";
import { setupClerkTestingToken } from "@clerk/testing/playwright";
import { setupTimeOffCommonRoutes } from "./helpers/timeOffCommonRoutes";

type Policy = {
  id: number;
  workspace_owner_id: string;
  name: string;
  description: string | null;
  vacation_days_per_year: number;
  sick_leave_days_per_year: number | null;
  accrual_type: string;
  annual_grant_month: number;
  carryover_allowed: boolean;
  max_carryover_days: number | null;
  applies_after_months_of_employment: number;
  is_active: boolean;
  created_at: string;
  updated_at: string;
};

function makePolicy(overrides: Partial<Policy> = {}): Policy {
  const now = new Date().toISOString();
  return {
    id: 101,
    workspace_owner_id: "owner-1",
    name: "Standard Full-Time",
    description: null,
    vacation_days_per_year: 25,
    sick_leave_days_per_year: 10,
    accrual_type: "ANNUAL_GRANT",
    annual_grant_month: 1,
    carryover_allowed: false,
    max_carryover_days: null,
    applies_after_months_of_employment: 0,
    is_active: true,
    created_at: now,
    updated_at: now,
    ...overrides,
  };
}

test.describe("Admin time-off policy creation and assignment", () => {
  test.beforeEach(async ({ page }) => {
    await setupClerkTestingToken({ page });
    await setupTimeOffCommonRoutes(page);
  });

  test("admin creates a policy then assigns it to all members", async ({
    page,
  }) => {
    const policies: Policy[] = [];
    type Assignee = {
      member_id: number;
      member_email: string;
      member_user_id: string;
      location_id: number | null;
      location_name: string | null;
      manager_member_id: number | null;
      manager_name: string | null;
      effective_from: string | null;
      vacation_remaining: number | null;
    };
    const assignees: Assignee[] = [];
    let createBody: Record<string, unknown> | null = null;
    let assignBody: Record<string, unknown> | null = null;
    let assignPolicyId: number | null = null;

    await page.route("**/api/time-off/policies", async (route) => {
      const method = route.request().method();
      if (method === "POST") {
        createBody = JSON.parse(route.request().postData() ?? "{}");
        const created = makePolicy({
          id: 101,
          name: (createBody?.name as string) ?? "New Policy",
          description: (createBody?.description as string | null) ?? null,
          vacation_days_per_year:
            (createBody?.vacation_days_per_year as number) ?? 20,
          sick_leave_days_per_year:
            (createBody?.sick_leave_days_per_year as number | null) ?? null,
        });
        policies.push(created);
        await route.fulfill({
          status: 201,
          contentType: "application/json",
          body: JSON.stringify({ policy: created }),
        });
        return;
      }
      // GET list
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ policies }),
      });
    });

    await page.route("**/api/time-off/policies/*/assign", async (route) => {
      if (route.request().method() !== "POST") {
        await route.continue();
        return;
      }
      const m = route.request().url().match(/\/policies\/(\d+)\/assign/);
      assignPolicyId = m ? Number(m[1]) : null;
      assignBody = JSON.parse(route.request().postData() ?? "{}");
      // Server side: scope:"all" assigns the policy to every workspace member.
      // Reflect that on the assignees endpoint so the UI can render them.
      assignees.length = 0;
      assignees.push({
        member_id: OWNER_ID,
        member_email: OWNER_EMAIL,
        member_user_id: "user_owner",
        location_id: null,
        location_name: null,
        manager_member_id: null,
        manager_name: null,
        effective_from: (assignBody?.effectiveFrom as string | null) ?? null,
        vacation_remaining: (createBody?.vacation_days_per_year as number) ?? 25,
      });
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ ok: true }),
      });
    });

    await page.route("**/api/time-off/policies/*/assignees", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ assignees }),
      }),
    );

    await page.goto("/admin/time-off/policies", { waitUntil: "domcontentloaded" });

    await expect(
      page.getByRole("heading", { name: /Time-Off Policies/i }),
    ).toBeVisible({ timeout: 12_000 });

    // Empty state
    await expect(page.getByText(/No policies yet/i)).toBeVisible({
      timeout: 8_000,
    });

    // Open the create dialog
    await page.getByRole("button", { name: /^New Policy$/ }).click();
    const createDialog = page.getByRole("dialog");
    await expect(createDialog).toBeVisible({ timeout: 5_000 });
    await expect(createDialog.getByText("Create Policy")).toBeVisible();

    await createDialog
      .getByLabel("Policy name *")
      .fill("Standard Full-Time");
    await createDialog
      .getByLabel("Vacation days / year")
      .fill("25");

    await createDialog.getByRole("button", { name: /^Save Policy$/ }).click();

    // POST captured
    await expect.poll(() => createBody).not.toBeNull();
    expect(createBody).toMatchObject({
      name: "Standard Full-Time",
      vacation_days_per_year: 25,
    });

    // Dialog closes; the new policy card renders.
    await expect(createDialog).not.toBeVisible({ timeout: 8_000 });
    await expect(page.getByText("Standard Full-Time")).toBeVisible({
      timeout: 8_000,
    });
    await expect(page.getByText(/25 vacation days\/yr/i)).toBeVisible();

    // Open the Assign dialog and confirm.
    await page.getByRole("button", { name: /^Assign$/ }).click();
    const assignDialog = page.getByRole("dialog");
    await expect(assignDialog).toBeVisible({ timeout: 5_000 });
    await expect(assignDialog.getByText("Assign Policy")).toBeVisible();

    await assignDialog.getByRole("button", { name: /^Assign$/ }).click();

    // POST .../assign captured with scope:"all" and a YYYY-MM-DD effectiveFrom.
    await expect.poll(() => assignPolicyId).toBe(101);
    expect(assignBody).toMatchObject({ scope: "all" });
    expect(typeof assignBody?.effectiveFrom).toBe("string");
    expect(assignBody?.effectiveFrom as string).toMatch(/^\d{4}-\d{2}-\d{2}$/);

    // Toast confirms success.
    await expect(
      page.getByText(/Policy assigned successfully/i).first(),
    ).toBeVisible({ timeout: 8_000 });

    // The server-side assignment is now reflected on the assignees endpoint.
    expect(assignees).toHaveLength(1);
    expect(assignees[0]).toMatchObject({
      member_id: OWNER_ID,
      member_email: OWNER_EMAIL,
    });

    // Expand the policy card and verify the assigned member appears in
    // the Assignees panel — proving the assignment is reflected in the UI,
    // not just dispatched.
    await page.getByText("Standard Full-Time").click();
    await expect(
      page.getByRole("cell", { name: OWNER_EMAIL }).first(),
    ).toBeVisible({ timeout: 8_000 });
    // The vacation_remaining (25.0d) for the assigned member is rendered.
    await expect(page.getByText(/25\.0d/).first()).toBeVisible();
  });
});

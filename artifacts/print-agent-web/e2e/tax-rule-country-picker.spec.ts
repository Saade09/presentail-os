import { test, expect } from "./fixtures";
import { setupClerkTestingToken } from "@clerk/testing/playwright";
import type { Page } from "@playwright/test";

const OWNER_ID = 1;
const OWNER_EMAIL = "e2e-tester@presentail.com";

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

async function setupCommonRoutes(page: Page) {
  await page.route("**/api/users/failed-access-requests**", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ failedRequests: [] }),
    }),
  );

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

  await page.route("**/api/access-requests**", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ requests: [] }),
    }),
  );

  await page.route("**/api/notifications/seen**", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ ok: true }),
    }),
  );

  await page.route("**/api/time-off/notifications/events**", (route) =>
    route.fulfill({
      status: 200,
      contentType: "text/event-stream",
      body: "",
    }),
  );

  await page.route("**/api/time-off/notifications/seen**", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ ok: true }),
    }),
  );

  await page.route("**/api/time-off/notifications**", async (route) => {
    const url = route.request().url();
    if (url.includes("/seen") || url.includes("/events")) {
      await route.continue();
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ notifications: [] }),
    });
  });
}

type TaxRule = {
  id: string;
  workspace_owner_id: string;
  country_code: string;
  location_id: number | null;
  tax_category: string;
  rate_percent: number;
  effective_from: string;
  effective_to: string | null;
  is_active: boolean;
  description: string | null;
  created_at: string;
};

test.describe("Tax Rule country picker", () => {
  test("owner searches the country combobox, selects Lebanon, and the rule saves with ISO code LB", async ({
    page,
  }) => {
    await setupClerkTestingToken({ page });
    await setupCommonRoutes(page);

    const rules: TaxRule[] = [];
    let createBody: Record<string, unknown> | null = null;

    await page.route("**/api/tax-rules", async (route) => {
      const method = route.request().method();
      if (method === "POST") {
        createBody = JSON.parse(route.request().postData() ?? "{}");
        const now = new Date().toISOString();
        const created: TaxRule = {
          id: "tr-1",
          workspace_owner_id: "owner-1",
          country_code: (createBody?.country_code as string) ?? "",
          location_id: null,
          tax_category: (createBody?.tax_category as string) ?? "standard_taxable",
          rate_percent: Number(createBody?.rate_percent ?? 0),
          effective_from:
            (createBody?.effective_from as string) ??
            new Date().toISOString().slice(0, 10),
          effective_to: (createBody?.effective_to as string | null) ?? null,
          is_active: (createBody?.is_active as boolean | undefined) ?? true,
          description: (createBody?.description as string | null) ?? null,
          created_at: now,
        };
        rules.push(created);
        await route.fulfill({
          status: 201,
          contentType: "application/json",
          body: JSON.stringify({ tax_rule: created }),
        });
        return;
      }
      // GET list
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ tax_rules: rules }),
      });
    });

    await page.goto("/tax-rules", { waitUntil: "domcontentloaded" });

    await expect(
      page.getByRole("heading", { name: "Tax Rules" }),
    ).toBeVisible({ timeout: 15_000 });

    // No rules yet.
    await expect(page.getByText(/No tax rules defined yet/i)).toBeVisible({
      timeout: 8_000,
    });

    // Open the New Rule dialog.
    await page.getByRole("button", { name: /New Rule/i }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible({ timeout: 5_000 });
    await expect(dialog.getByText("New Tax Rule")).toBeVisible();

    // Open the country combobox (the only button[role="combobox"]; the tax
    // category control is a native <select>).
    const countryTrigger = dialog.locator('button[role="combobox"]');
    await expect(countryTrigger).toHaveText(/Select country/i);
    await countryTrigger.click();

    // Search for Lebanon and pick it.
    const searchInput = page.getByPlaceholder("Search countries…");
    await expect(searchInput).toBeVisible({ timeout: 5_000 });
    await searchInput.fill("Leb");

    await page.getByRole("option", { name: /Lebanon/i }).click();

    // The trigger now reflects the selected country.
    await expect(countryTrigger).toContainText("Lebanon");

    // Fill the remaining required fields.
    await dialog.getByLabel(/Rate/i).fill("11");

    // Submit.
    await dialog.getByRole("button", { name: /^Create Rule$/ }).click();

    // The POST carried the uppercase ISO code.
    await expect.poll(() => createBody).not.toBeNull();
    expect(createBody).toMatchObject({
      country_code: "LB",
      tax_category: "standard_taxable",
      rate_percent: 11,
      is_active: true,
    });

    // Dialog closes and the new rule appears with the uppercase code badge.
    await expect(dialog).not.toBeVisible({ timeout: 8_000 });
    await expect(page.getByText("LB", { exact: true })).toBeVisible({
      timeout: 8_000,
    });
  });
});

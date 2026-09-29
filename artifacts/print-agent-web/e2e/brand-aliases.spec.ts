import { test, expect } from "./fixtures";
import { setupClerkTestingToken } from "@clerk/testing/playwright";
import { setupBrandsCommonRoutes } from "./helpers/brandsCommonRoutes";

const BRAND = {
  id: 1,
  name: "Presentail Flowers & Gifts",
  description: null,
  target_cogs: null,
  created_at: new Date().toISOString(),
  updated_at: null,
  sticker_count: "0",
  product_count: "0",
  has_logo: false,
  failed_import_count: 0,
};

function alias(id: number, aliasName: string) {
  return {
    id,
    marketplace: "Toters",
    alias_name: aliasName,
    brand_id: BRAND.id,
    brand_name: BRAND.name,
    location_id: null,
    location_name: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    last_used_at: null,
    workspace_owner_id: "e2e-workspace",
  };
}

async function setupAliasesRoutes(page: import("@playwright/test").Page) {
  let aliases: ReturnType<typeof alias>[] = [];
  let nextId = 42;
  let patchId: number | null = null;

  await setupBrandsCommonRoutes(page);
  await page.route(/\/api\/brands(\?.*)?$/, async (route) => {
    if (route.request().method() === "GET") {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ brands: [BRAND], workspaceJobCount: 0 }),
      });
      return;
    }
    await route.continue();
  });
  await page.route("**/api/locations**", (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({ locations: [] }),
  }));
  await page.route(/\/api\/marketplace-brand-aliases(\?.*)?$/, async (route) => {
    if (route.request().method() === "GET") {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ success: true, aliases }),
      });
      return;
    }
    if (route.request().method() === "POST") {
      const input = route.request().postDataJSON();
      const created = alias(nextId++, input.alias_name.toLowerCase());
      aliases = [...aliases, created];
      await route.fulfill({
        status: 201,
        contentType: "application/json",
        body: JSON.stringify({ success: true, alias: created }),
      });
      return;
    }
    await route.continue();
  });
  await page.route(/\/api\/marketplace-brand-aliases\/\d+$/, async (route) => {
    const id = Number(route.request().url().split("/").pop());
    if (route.request().method() === "PATCH") {
      patchId = id;
      const input = route.request().postDataJSON();
      aliases = aliases.map((current) => current.id === id ? { ...current, alias_name: input.alias_name.toLowerCase() } : current);
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ success: true, alias: aliases.find((current) => current.id === id) }),
      });
      return;
    }
    if (route.request().method() === "DELETE") {
      aliases = aliases.filter((current) => current.id !== id);
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ success: true }) });
      return;
    }
    await route.continue();
  });

  return { getPatchId: () => patchId };
}

test.describe("Statement aliases in Brands", () => {
  test("owner can create, edit in place, search, and delete an alias", async ({ page }) => {
    await setupClerkTestingToken({ page });
    const aliases = await setupAliasesRoutes(page);

    await page.goto("/brands?tab=statement-aliases", { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading", { name: "Statement Aliases" })).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId("statement-aliases-empty")).toBeVisible();

    await page.getByTestId("new-statement-alias").click();
    await page.getByTestId("statement-alias-name").fill("Presentail Flowers & Gifts");
    await page.getByTestId("statement-alias-brand").click();
    await page.getByRole("option", { name: BRAND.name }).click();
    await page.getByTestId("save-statement-alias").click();

    const row = page.getByTestId("statement-alias-row-42");
    await expect(row).toContainText("presentail flowers & gifts");
    await page.getByTestId("statement-aliases-search").fill("toters");
    await expect(row).toBeVisible();

    await row.getByRole("button", { name: /Edit presentail flowers/i }).click();
    await page.getByTestId("statement-alias-name").fill("Presentail Flowers Achrafieh");
    await page.getByTestId("save-statement-alias").click();
    await expect(row).toContainText("presentail flowers achrafieh");
    expect(aliases.getPatchId()).toBe(42);

    await row.getByRole("button", { name: /Delete presentail flowers achrafieh/i }).click();
    await page.getByRole("button", { name: "Delete" }).click();
    await expect(page.getByTestId("statement-aliases-empty")).toBeVisible();
  });

  test("legacy aliases route redirects an owner to the consolidated tab", async ({ page }) => {
    await setupClerkTestingToken({ page });
    await setupAliasesRoutes(page);

    await page.goto("/brand-aliases", { waitUntil: "domcontentloaded" });
    await expect(page).toHaveURL(/\/brands\?tab=statement-aliases/);
    await expect(page.getByRole("heading", { name: "Statement Aliases" })).toBeVisible({ timeout: 15_000 });
  });
});
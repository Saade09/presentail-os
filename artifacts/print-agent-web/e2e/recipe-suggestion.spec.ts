/**
 * E2E tests for the Recipe Suggestion Review UI in the Product Detail → Recipe tab.
 *
 * Tests cover:
 * - Generate Recipe Suggestion button appears for managers when no suggestion exists
 * - Pending suggestion panel is shown when a suggestion is awaiting review
 * - Confidence badges are displayed correctly
 * - Low-confidence warnings are shown
 * - No-match warnings are shown
 * - Approve action opens confirmation dialog
 * - Reject action opens confirmation dialog
 * - Read-only users do NOT see the suggestion panel
 * - Live recipe section is always visible and labeled separately from suggestions
 */
import { test, expect } from "./fixtures";
import { setupClerkTestingToken } from "@clerk/testing/playwright";

const OWNER_EMAIL = "e2e-tester@presentail.com";

const MOCK_PRODUCT = {
  id: 42,
  workspace_owner_id: "user_1",
  name: "Test Product",
  price_usd: "10.00",
  price_aed: "36.72",
  main_image_url: null,
  additional_image_urls: [],
  description: null,
  status: "available",
  brand: null,
  tags: [],
  category: null,
  sku: null,
  created_at: new Date().toISOString(),
};

const MOCK_RECIPE = [
  { base_item_id: 1, name: "Item Alpha", code: "A01", image_url: null, quantity: "2" },
];

const MOCK_SUGGESTION_GENERATED = {
  id: 101,
  product_id: 42,
  version: 1,
  status: "generated",
  confidence: 0.72,
  rationale: "Generated from deterministic rules and AI analysis.",
  created_at: new Date().toISOString(),
};

const MOCK_SUGGESTION_DETAIL = {
  suggestion: MOCK_SUGGESTION_GENERATED,
  lines: [
    {
      id: 1001,
      line_order: 0,
      extracted_requirement: "Balloon base 12-inch",
      selected_base_item: { id: 10, name: "Balloon Base 12in", code: "BB12" },
      quantity: 1,
      unit_context: "pcs",
      confidence: "high",
      source_type: "rule",
      source_rule_id: 5,
      sources: [],
      rationale: "Matched by balloon rule #5.",
      created_at: new Date().toISOString(),
    },
    {
      id: 1002,
      line_order: 1,
      extracted_requirement: "Ribbon (unknown color)",
      selected_base_item: null,
      quantity: 1,
      unit_context: null,
      confidence: "no_match",
      source_type: "ai",
      source_rule_id: null,
      sources: [],
      rationale: "No matching base item found in catalog.",
      created_at: new Date().toISOString(),
    },
    {
      id: 1003,
      line_order: 2,
      extracted_requirement: "Gift tag",
      selected_base_item: { id: 20, name: "Gift Tag Standard", code: "GT01" },
      quantity: 1,
      unit_context: null,
      confidence: "low",
      source_type: "ai",
      source_rule_id: null,
      sources: [],
      rationale: "Low confidence match from AI.",
      created_at: new Date().toISOString(),
    },
  ],
  actions: [
    {
      id: 9001,
      action: "generated",
      actor_user_id: "user_1",
      note: null,
      created_at: new Date().toISOString(),
    },
  ],
};

function usersResponse(role: "owner" | "member" = "owner", allowedPages: string[] | null = null) {
  return {
    members: [
      {
        id: 1,
        email: OWNER_EMAIL,
        role,
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
      role,
      email: OWNER_EMAIL,
      allowedPages,
      customRoleId: null,
    },
  };
}

async function setupBaseRoutes(
  page: import("@playwright/test").Page,
  opts: {
    suggestions?: unknown[];
    suggestionDetail?: unknown;
    role?: "owner" | "member";
    allowedPages?: string[] | null;
    onGeneratePost?: () => void;
    onApprovePost?: () => void;
    onRejectPost?: () => void;
  } = {},
) {
  const {
    suggestions = [],
    suggestionDetail = null,
    role = "owner",
    allowedPages = null,
    onGeneratePost,
    onApprovePost,
    onRejectPost,
  } = opts;

  await page.route("**/api/users**", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(usersResponse(role, allowedPages)),
    });
  });

  await page.route("**/api/brands**", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ brands: [] }),
    });
  });

  await page.route("**/api/products/42/recipe", async (route) => {
    if (route.request().method() === "PUT") {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ recipe: MOCK_RECIPE }),
      });
      return;
    }
    await route.continue();
  });

  await page.route("**/api/products/42", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ product: MOCK_PRODUCT, recipe: MOCK_RECIPE }),
    });
  });

  await page.route("**/api/products/42/location-statuses", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ statuses: [] }),
    });
  });

  await page.route("**/api/products/42/recipe-suggestions", async (route) => {
    if (route.request().method() === "POST") {
      onGeneratePost?.();
      await route.fulfill({
        status: 201,
        contentType: "application/json",
        body: JSON.stringify(suggestionDetail ?? {
          suggestion: MOCK_SUGGESTION_GENERATED,
          lines: [],
          actions: [],
          live_recipe_changed: false,
        }),
      });
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ suggestions }),
    });
  });

  if (suggestionDetail) {
    await page.route("**/api/recipe-suggestions/101", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(suggestionDetail),
      });
    });
  }

  await page.route("**/api/recipe-suggestions/101/approve", async (route) => {
    onApprovePost?.();
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        suggestion: { ...MOCK_SUGGESTION_GENERATED, status: "approved" },
        recipe: [],
        live_recipe_changed: true,
      }),
    });
  });

  await page.route("**/api/recipe-suggestions/101/reject", async (route) => {
    onRejectPost?.();
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ ok: true }),
    });
  });
}

async function goToRecipeTab(page: import("@playwright/test").Page) {
  await page.goto("/products/42?tab=recipe", { waitUntil: "domcontentloaded" });
  await expect(page.getByRole("heading", { name: "Test Product" })).toBeVisible({
    timeout: 15_000,
  });
  await page.getByRole("tab", { name: "Recipe" }).click();
}

test.describe("Recipe Suggestion Panel", () => {
  test("shows 'Generate' button for manager when no suggestion exists", async ({ page }) => {
    await setupClerkTestingToken({ page });
    await setupBaseRoutes(page, { suggestions: [] });

    await goToRecipeTab(page);

    await expect(
      page.getByTestId("btn-generate-recipe-suggestion"),
    ).toBeVisible({ timeout: 10_000 });
    await expect(page.getByText("Generate Recipe Suggestion")).toBeVisible();
  });

  test("clicking Generate calls POST /recipe-suggestions", async ({ page }) => {
    await setupClerkTestingToken({ page });

    let generateCalled = false;
    await setupBaseRoutes(page, {
      suggestions: [],
      onGeneratePost: () => {
        generateCalled = true;
      },
    });

    await goToRecipeTab(page);
    await expect(page.getByTestId("btn-generate-recipe-suggestion")).toBeVisible({ timeout: 10_000 });
    await page.getByTestId("btn-generate-recipe-suggestion").click();

    await expect(async () => {
      expect(generateCalled).toBe(true);
    }).toPass({ timeout: 8_000 });
  });

  test("shows pending suggestion panel when a suggestion is awaiting review", async ({
    page,
  }) => {
    await setupClerkTestingToken({ page });
    await setupBaseRoutes(page, {
      suggestions: [MOCK_SUGGESTION_GENERATED],
      suggestionDetail: MOCK_SUGGESTION_DETAIL,
    });

    await goToRecipeTab(page);

    await expect(page.getByTestId("recipe-suggestion-panel")).toBeVisible({ timeout: 10_000 });
    await expect(page.getByText("Recipe Suggestion")).toBeVisible();
    await expect(page.getByText("Awaiting review")).toBeVisible();
  });

  test("live recipe section is labeled and always visible", async ({ page }) => {
    await setupClerkTestingToken({ page });
    await setupBaseRoutes(page, {
      suggestions: [MOCK_SUGGESTION_GENERATED],
      suggestionDetail: MOCK_SUGGESTION_DETAIL,
    });

    await goToRecipeTab(page);

    // Live recipe header
    await expect(page.getByText("Live Recipe")).toBeVisible({ timeout: 10_000 });
    await expect(page.getByText("Active · COGS tied to this")).toBeVisible();
    // Live recipe content (Item Alpha)
    await expect(page.getByTestId("recipe-base-item-link-1")).toBeVisible();
  });

  test("displays confidence badges for suggestion lines", async ({ page }) => {
    await setupClerkTestingToken({ page });
    await setupBaseRoutes(page, {
      suggestions: [MOCK_SUGGESTION_GENERATED],
      suggestionDetail: MOCK_SUGGESTION_DETAIL,
    });

    await goToRecipeTab(page);

    await expect(page.getByTestId("recipe-suggestion-panel")).toBeVisible({ timeout: 10_000 });

    // High confidence line
    await expect(page.getByTestId("suggestion-line-1001")).toBeVisible({ timeout: 10_000 });

    // Low confidence warning should appear
    await expect(page.getByText(/low confidence/i)).toBeVisible({ timeout: 10_000 });
  });

  test("displays no-match warning for lines without a selected base item", async ({ page }) => {
    await setupClerkTestingToken({ page });
    await setupBaseRoutes(page, {
      suggestions: [MOCK_SUGGESTION_GENERATED],
      suggestionDetail: MOCK_SUGGESTION_DETAIL,
    });

    await goToRecipeTab(page);

    await expect(page.getByTestId("recipe-suggestion-panel")).toBeVisible({ timeout: 10_000 });
    // The no-match warning banner should appear at the top
    await expect(page.getByText(/no matching base item found/i)).toBeVisible({ timeout: 10_000 });
  });

  test("Approve button opens confirmation dialog", async ({ page }) => {
    await setupClerkTestingToken({ page });
    await setupBaseRoutes(page, {
      suggestions: [MOCK_SUGGESTION_GENERATED],
      suggestionDetail: MOCK_SUGGESTION_DETAIL,
    });

    await goToRecipeTab(page);
    await expect(page.getByTestId("btn-approve-suggestion")).toBeVisible({ timeout: 10_000 });
    await page.getByTestId("btn-approve-suggestion").click();

    await expect(
      page.getByRole("dialog").getByText(/approve recipe suggestion/i),
    ).toBeVisible({ timeout: 5_000 });
    await expect(page.getByTestId("btn-confirm-approve")).toBeVisible();
  });

  test("confirming Approve calls POST /recipe-suggestions/:id/approve", async ({ page }) => {
    await setupClerkTestingToken({ page });

    let approveCalled = false;
    await setupBaseRoutes(page, {
      suggestions: [MOCK_SUGGESTION_GENERATED],
      suggestionDetail: MOCK_SUGGESTION_DETAIL,
      onApprovePost: () => {
        approveCalled = true;
      },
    });

    await goToRecipeTab(page);
    await expect(page.getByTestId("btn-approve-suggestion")).toBeVisible({ timeout: 10_000 });
    await page.getByTestId("btn-approve-suggestion").click();
    await page.getByTestId("btn-confirm-approve").click();

    await expect(async () => {
      expect(approveCalled).toBe(true);
    }).toPass({ timeout: 8_000 });
  });

  test("Reject button opens confirmation dialog", async ({ page }) => {
    await setupClerkTestingToken({ page });
    await setupBaseRoutes(page, {
      suggestions: [MOCK_SUGGESTION_GENERATED],
      suggestionDetail: MOCK_SUGGESTION_DETAIL,
    });

    await goToRecipeTab(page);
    await expect(page.getByTestId("btn-reject-suggestion")).toBeVisible({ timeout: 10_000 });
    await page.getByTestId("btn-reject-suggestion").click();

    await expect(
      page.getByRole("dialog").getByText(/reject recipe suggestion/i),
    ).toBeVisible({ timeout: 5_000 });
    await expect(page.getByTestId("btn-confirm-reject")).toBeVisible();
  });

  test("confirming Reject calls POST /recipe-suggestions/:id/reject", async ({ page }) => {
    await setupClerkTestingToken({ page });

    let rejectCalled = false;
    await setupBaseRoutes(page, {
      suggestions: [MOCK_SUGGESTION_GENERATED],
      suggestionDetail: MOCK_SUGGESTION_DETAIL,
      onRejectPost: () => {
        rejectCalled = true;
      },
    });

    await goToRecipeTab(page);
    await expect(page.getByTestId("btn-reject-suggestion")).toBeVisible({ timeout: 10_000 });
    await page.getByTestId("btn-reject-suggestion").click();
    await page.getByTestId("btn-confirm-reject").click();

    await expect(async () => {
      expect(rejectCalled).toBe(true);
    }).toPass({ timeout: 8_000 });
  });

  test("read-only member does NOT see the suggestion panel", async ({ page }) => {
    await setupClerkTestingToken({ page });
    await setupBaseRoutes(page, {
      suggestions: [MOCK_SUGGESTION_GENERATED],
      suggestionDetail: MOCK_SUGGESTION_DETAIL,
      role: "member",
      allowedPages: ["products"],
    });

    await goToRecipeTab(page);

    // The suggestion panel should not be present for read-only members
    await page.waitForTimeout(2_000);
    await expect(page.getByTestId("recipe-suggestion-panel")).not.toBeVisible();
    await expect(page.getByTestId("btn-generate-recipe-suggestion")).not.toBeVisible();
  });

  test("shows previously approved/rejected suggestion history below generate button", async ({
    page,
  }) => {
    await setupClerkTestingToken({ page });
    await setupBaseRoutes(page, {
      suggestions: [
        { ...MOCK_SUGGESTION_GENERATED, id: 100, status: "approved", version: 1 },
      ],
    });

    await goToRecipeTab(page);

    // No pending suggestion → should show generate button
    await expect(page.getByTestId("btn-generate-recipe-suggestion")).toBeVisible({ timeout: 10_000 });
    // Show "Version 1 approved"
    await expect(page.getByText(/version 1 approved/i)).toBeVisible();
  });
});

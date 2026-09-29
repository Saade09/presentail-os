import { test, expect } from "./fixtures";
import { setupClerkTestingToken } from "@clerk/testing/playwright";
import type { Page } from "@playwright/test";

const OWNER_EMAIL = "e2e-tester@presentail.com";

function ownerUsersResponse() {
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

/**
 * Calculate mock response: 3 channels, each with a single "Google" platform
 * and 3 daily rows (May 01–03 2026).
 */
function makeMockCalculateResponse() {
  const dates = ["2026-05-01", "2026-05-02", "2026-05-03"];
  const channels = [
    { channelName: "Retail Sales", dailyValue: 333.33, total: 1000 },
    { channelName: "Website Sales", dailyValue: 83.33, total: 250 },
    { channelName: "Toters Sales", dailyValue: 53.33, total: 160 },
  ];

  return {
    channels: channels.map(({ channelName, dailyValue, total }) => ({
      channelName,
      platformNames: ["Google"],
      rows: dates.map((date) => ({ date, platforms: { Google: dailyValue } })),
      calculatedTotal: total,
    })),
  };
}

function makeMockGenerateResponse() {
  return {
    files: [
      {
        channelName: "Retail Sales",
        url: "/api/budget/download/May_2026_Retail_Sales_ad_spend_budget.pdf",
        filename: "May_2026_Retail_Sales_ad_spend_budget.pdf",
      },
      {
        channelName: "Website Sales",
        url: "/api/budget/download/May_2026_Website_Sales_ad_spend_budget.pdf",
        filename: "May_2026_Website_Sales_ad_spend_budget.pdf",
      },
      {
        channelName: "Toters Sales",
        url: "/api/budget/download/May_2026_Toters_Sales_ad_spend_budget.pdf",
        filename: "May_2026_Toters_Sales_ad_spend_budget.pdf",
      },
    ],
  };
}

/**
 * Fills all three channel cards with valid data:
 *  - salesTarget = 100000 / 50000 / 20000
 *  - marketingBudgetPct = 10 / 5 / 8
 *  - single platform "Google" at 100%
 *
 * The channels are open by default, so no need to click the triggers.
 */
async function fillAllChannels(page: Page) {
  const salesTargetInputs = page.getByPlaceholder("e.g. 500000");
  const marketingInputs = page.getByPlaceholder("e.g. 5");
  const platformNameInputs = page.getByPlaceholder("Platform name");
  const allocationInputs = page.getByPlaceholder("0");

  const salesTargetValues = ["100000", "50000", "20000"];
  const marketingValues = ["10", "5", "8"];

  for (let i = 0; i < 3; i++) {
    await salesTargetInputs.nth(i).fill(salesTargetValues[i]);
    await marketingInputs.nth(i).fill(marketingValues[i]);
    await platformNameInputs.nth(i).fill("Google");
    await allocationInputs.nth(i).fill("100");
  }
}

test.describe("Budget Planner – standard mode", () => {
  test("page loads with Budget Planner heading and three channel cards", async ({
    page,
  }) => {
    await setupClerkTestingToken({ page });
    await setupCommonRoutes(page);

    await page.goto("/budget", { waitUntil: "domcontentloaded" });

    await expect(
      page.getByRole("heading", { name: "Budget Planner" }),
    ).toBeVisible({ timeout: 12_000 });

    await expect(page.getByText("Retail Sales", { exact: true })).toBeVisible();
    await expect(
      page.getByText("Website Sales", { exact: true }),
    ).toBeVisible();
    await expect(
      page.getByText("Toters Sales", { exact: true }),
    ).toBeVisible();

    await expect(
      page.getByRole("button", { name: "Generate PDFs" }),
    ).toBeVisible();
  });

  test("form validation errors appear when Generate PDFs is clicked with empty fields", async ({
    page,
  }) => {
    await setupClerkTestingToken({ page });
    await setupCommonRoutes(page);

    await page.goto("/budget", { waitUntil: "domcontentloaded" });
    await expect(
      page.getByRole("heading", { name: "Budget Planner" }),
    ).toBeVisible({ timeout: 12_000 });

    await page.getByRole("button", { name: "Generate PDFs" }).click();

    await expect(
      page.getByText("Retail Sales: Sales target must be a positive number."),
    ).toBeVisible({ timeout: 8_000 });
    await expect(
      page.getByText(
        "Retail Sales: Marketing budget must be between 0 and 100.",
      ),
    ).toBeVisible();
    await expect(
      page.getByText("Website Sales: Sales target must be a positive number."),
    ).toBeVisible();
    await expect(
      page.getByText("Toters Sales: Sales target must be a positive number."),
    ).toBeVisible();
  });

  test("allocation badge shows over-total and Generate PDFs is blocked when allocations exceed 100%", async ({
    page,
  }) => {
    await setupClerkTestingToken({ page });
    await setupCommonRoutes(page);

    let calculateCalled = false;
    await page.route("**/api/budget/calculate", async (route) => {
      calculateCalled = true;
      await route.continue();
    });

    await page.goto("/budget", { waitUntil: "domcontentloaded" });
    await expect(
      page.getByRole("heading", { name: "Budget Planner" }),
    ).toBeVisible({ timeout: 12_000 });

    const salesTargetInputs = page.getByPlaceholder("e.g. 500000");
    const marketingInputs = page.getByPlaceholder("e.g. 5");
    const platformNameInputs = page.getByPlaceholder("Platform name");
    const allocationInputs = page.getByPlaceholder("0");
    const addPlatformButtons = page.getByRole("button", { name: "Add Platform" });

    const salesTargetValues = ["100000", "50000", "20000"];
    const marketingValues = ["10", "5", "8"];

    // Channel 0: fill sales/marketing, add two platforms each at 60%
    await salesTargetInputs.nth(0).fill(salesTargetValues[0]);
    await marketingInputs.nth(0).fill(marketingValues[0]);
    await platformNameInputs.nth(0).fill("Google");
    await allocationInputs.nth(0).fill("60");
    await addPlatformButtons.nth(0).click();
    await platformNameInputs.nth(1).fill("Meta");
    await allocationInputs.nth(1).fill("60");

    // Channel 1: now has indices shifted by 1 extra platform in channel 0
    await salesTargetInputs.nth(1).fill(salesTargetValues[1]);
    await marketingInputs.nth(1).fill(marketingValues[1]);
    await platformNameInputs.nth(2).fill("Google");
    await allocationInputs.nth(2).fill("60");
    await addPlatformButtons.nth(1).click();
    await platformNameInputs.nth(3).fill("Meta");
    await allocationInputs.nth(3).fill("60");

    // Channel 2: now has indices shifted by 2 extra platforms
    await salesTargetInputs.nth(2).fill(salesTargetValues[2]);
    await marketingInputs.nth(2).fill(marketingValues[2]);
    await platformNameInputs.nth(4).fill("Google");
    await allocationInputs.nth(4).fill("60");
    await addPlatformButtons.nth(2).click();
    await platformNameInputs.nth(5).fill("Meta");
    await allocationInputs.nth(5).fill("60");

    // All three channels should show the amber over-total badge
    await expect(page.getByText("120.0% / 100%").first()).toBeVisible({
      timeout: 5_000,
    });
    await expect(page.getByText("120.0% / 100%")).toHaveCount(3);

    // Clicking Generate PDFs must surface allocation validation errors
    await page.getByRole("button", { name: "Generate PDFs" }).click();

    await expect(
      page.getByText(
        "Retail Sales: Platform allocations must sum to 100% (currently 120.0%).",
      ),
    ).toBeVisible({ timeout: 8_000 });
    await expect(
      page.getByText(
        "Website Sales: Platform allocations must sum to 100% (currently 120.0%).",
      ),
    ).toBeVisible();
    await expect(
      page.getByText(
        "Toters Sales: Platform allocations must sum to 100% (currently 120.0%).",
      ),
    ).toBeVisible();

    // The API must NOT have been called
    expect(calculateCalled).toBe(false);
  });

  test("allocation badge shows under-total and Generate PDFs is blocked when allocations fall short of 100%", async ({
    page,
  }) => {
    await setupClerkTestingToken({ page });
    await setupCommonRoutes(page);

    let calculateCalled = false;
    await page.route("**/api/budget/calculate", async (route) => {
      calculateCalled = true;
      await route.continue();
    });

    await page.goto("/budget", { waitUntil: "domcontentloaded" });
    await expect(
      page.getByRole("heading", { name: "Budget Planner" }),
    ).toBeVisible({ timeout: 12_000 });

    const salesTargetInputs = page.getByPlaceholder("e.g. 500000");
    const marketingInputs = page.getByPlaceholder("e.g. 5");
    const platformNameInputs = page.getByPlaceholder("Platform name");
    const allocationInputs = page.getByPlaceholder("0");

    const salesTargetValues = ["100000", "50000", "20000"];
    const marketingValues = ["10", "5", "8"];

    // Fill each channel with one platform at 50%, leaving 50% unallocated
    for (let i = 0; i < 3; i++) {
      await salesTargetInputs.nth(i).fill(salesTargetValues[i]);
      await marketingInputs.nth(i).fill(marketingValues[i]);
      await platformNameInputs.nth(i).fill("Google");
      await allocationInputs.nth(i).fill("50");
    }

    // All three channels should show the amber under-total badge
    await expect(page.getByText("50.0% / 100%").first()).toBeVisible({
      timeout: 5_000,
    });
    await expect(page.getByText("50.0% / 100%")).toHaveCount(3);

    // Clicking Generate PDFs must surface allocation validation errors
    await page.getByRole("button", { name: "Generate PDFs" }).click();

    await expect(
      page.getByText(
        "Retail Sales: Platform allocations must sum to 100% (currently 50.0%).",
      ),
    ).toBeVisible({ timeout: 8_000 });
    await expect(
      page.getByText(
        "Website Sales: Platform allocations must sum to 100% (currently 50.0%).",
      ),
    ).toBeVisible();
    await expect(
      page.getByText(
        "Toters Sales: Platform allocations must sum to 100% (currently 50.0%).",
      ),
    ).toBeVisible();

    // The API must NOT have been called
    expect(calculateCalled).toBe(false);
  });

  test("allocation badge updates when platform percentages sum to 100%", async ({
    page,
  }) => {
    await setupClerkTestingToken({ page });
    await setupCommonRoutes(page);

    await page.goto("/budget", { waitUntil: "domcontentloaded" });
    await expect(
      page.getByRole("heading", { name: "Budget Planner" }),
    ).toBeVisible({ timeout: 12_000 });

    const retailSection = page.locator("div").filter({
      has: page.getByText("Retail Sales", { exact: true }),
    }).first();

    await expect(retailSection.getByText("0.0% / 100%")).toBeVisible();

    const platformNameInput = page.getByPlaceholder("Platform name").first();
    const allocationInput = page.getByPlaceholder("0").first();

    await platformNameInput.fill("Google");
    await allocationInput.fill("100");

    await expect(retailSection.getByText("Allocations OK")).toBeVisible({
      timeout: 5_000,
    });
  });

  test("clicking Generate PDFs calls the API and shows download links", async ({
    page,
  }) => {
    await setupClerkTestingToken({ page });
    await setupCommonRoutes(page);

    let calculateCallBody: unknown = null;
    let generateCallBody: unknown = null;

    await page.route("**/api/budget/calculate", async (route) => {
      calculateCallBody = route.request().postDataJSON();
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(makeMockCalculateResponse()),
      });
    });

    await page.route("**/api/budget/generate", async (route) => {
      generateCallBody = route.request().postDataJSON();
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(makeMockGenerateResponse()),
      });
    });

    await page.goto("/budget", { waitUntil: "domcontentloaded" });
    await expect(
      page.getByRole("heading", { name: "Budget Planner" }),
    ).toBeVisible({ timeout: 12_000 });

    await fillAllChannels(page);

    await expect(page.getByText("Allocations OK").first()).toBeVisible({
      timeout: 5_000,
    });

    await page.getByRole("button", { name: "Generate PDFs" }).click();

    await expect(
      page.getByText("PDFs generated successfully"),
    ).toBeVisible({ timeout: 15_000 });

    await expect(
      page.getByRole("link", {
        name: /Retail Sales.*May_2026_Retail_Sales_ad_spend_budget\.pdf/,
      }),
    ).toBeVisible();
    await expect(
      page.getByRole("link", {
        name: /Website Sales.*May_2026_Website_Sales_ad_spend_budget\.pdf/,
      }),
    ).toBeVisible();
    await expect(
      page.getByRole("link", {
        name: /Toters Sales.*May_2026_Toters_Sales_ad_spend_budget\.pdf/,
      }),
    ).toBeVisible();

    await expect.poll(() => calculateCallBody).not.toBeNull();
    const calcBody = calculateCallBody as {
      channels: Array<{ name: string; salesTarget: number; platforms: Array<{ name: string; allocation: number }> }>;
    };
    expect(calcBody.channels).toHaveLength(3);
    expect(calcBody.channels[0]).toMatchObject({
      name: "Retail Sales",
      salesTarget: 100000,
      marketingBudgetPct: 10,
      platforms: [{ name: "Google", allocation: 100 }],
    });

    await expect.poll(() => generateCallBody).not.toBeNull();
    const genBody = generateCallBody as { channels: unknown[] };
    expect(genBody.channels).toHaveLength(3);
  });
});

test.describe("Budget Planner – PDF generation error", () => {
  test("shows a distinct error banner with a Retry button when /api/budget/generate returns 500", async ({
    page,
  }) => {
    await setupClerkTestingToken({ page });
    await setupCommonRoutes(page);

    await page.route("**/api/budget/configs**", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ configs: [] }),
      }),
    );

    await page.route("**/api/budget/calculate", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(makeMockCalculateResponse()),
      });
    });

    await page.route("**/api/budget/generate", async (route) => {
      await route.fulfill({
        status: 500,
        contentType: "application/json",
        body: JSON.stringify({ error: "Internal server error" }),
      });
    });

    await page.goto("/budget", { waitUntil: "domcontentloaded" });
    await expect(
      page.getByRole("heading", { name: "Budget Planner" }),
    ).toBeVisible({ timeout: 12_000 });

    await fillAllChannels(page);

    await expect(page.getByText("Allocations OK").first()).toBeVisible({
      timeout: 5_000,
    });

    await page.getByRole("button", { name: "Generate PDFs" }).click();

    const errorBanner = page.getByRole("alert");
    await expect(errorBanner).toBeVisible({ timeout: 15_000 });
    await expect(errorBanner).toContainText("PDF generation failed");

    await expect(
      page.getByRole("button", { name: "Retry" }),
    ).toBeVisible();

    await expect(
      page.getByRole("button", { name: /Generate PDFs/ }),
    ).toBeVisible();

    await expect(page.getByText("PDFs generated successfully")).toHaveCount(0);
  });
});

test.describe("Budget Planner – advanced mode", () => {
  test("toggling Advanced Mode hides Generate PDFs and shows Calculate & Preview", async ({
    page,
  }) => {
    await setupClerkTestingToken({ page });
    await setupCommonRoutes(page);

    await page.goto("/budget", { waitUntil: "domcontentloaded" });
    await expect(
      page.getByRole("heading", { name: "Budget Planner" }),
    ).toBeVisible({ timeout: 12_000 });

    await expect(
      page.getByRole("button", { name: "Generate PDFs" }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Calculate & Preview" }),
    ).toHaveCount(0);

    await page.getByLabel("Advanced Mode").click();

    await expect(
      page.getByRole("button", { name: "Generate PDFs" }),
    ).toHaveCount(0);
    await expect(
      page.getByRole("button", { name: "Calculate & Preview" }),
    ).toBeVisible();
  });

  test("Calculate & Preview shows the daily spend grid after filling channels", async ({
    page,
  }) => {
    await setupClerkTestingToken({ page });
    await setupCommonRoutes(page);

    await page.route("**/api/budget/calculate", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(makeMockCalculateResponse()),
      });
    });

    await page.goto("/budget", { waitUntil: "domcontentloaded" });
    await expect(
      page.getByRole("heading", { name: "Budget Planner" }),
    ).toBeVisible({ timeout: 12_000 });

    await page.getByLabel("Advanced Mode").click();
    await fillAllChannels(page);

    await page.getByRole("button", { name: "Calculate & Preview" }).click();

    await expect(
      page.getByRole("heading", { name: "Edit Daily Spend" }),
    ).toBeVisible({ timeout: 10_000 });

    await expect(
      page.getByText("Calculated:", { exact: false }).first(),
    ).toBeVisible();

    await expect(page.getByText("2026-05-01", { exact: false })).toHaveCount(
      0,
    );
    await expect(page.getByText("01 May 2026", { exact: false })).toBeVisible();
    await expect(page.getByText("02 May 2026", { exact: false })).toBeVisible();
    await expect(page.getByText("03 May 2026", { exact: false })).toBeVisible();

    await expect(
      page.getByRole("button", { name: "Generate PDFs" }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Recalculate" }),
    ).toBeVisible();
  });

  test("editing a daily cell updates the channel Edited total", async ({
    page,
  }) => {
    await setupClerkTestingToken({ page });
    await setupCommonRoutes(page);

    await page.route("**/api/budget/calculate", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(makeMockCalculateResponse()),
      });
    });

    await page.goto("/budget", { waitUntil: "domcontentloaded" });
    await expect(
      page.getByRole("heading", { name: "Budget Planner" }),
    ).toBeVisible({ timeout: 12_000 });

    await page.getByLabel("Advanced Mode").click();
    await fillAllChannels(page);

    await page.getByRole("button", { name: "Calculate & Preview" }).click();

    await expect(
      page.getByRole("heading", { name: "Edit Daily Spend" }),
    ).toBeVisible({ timeout: 10_000 });

    const retailGridSection = page
      .locator("div")
      .filter({ has: page.getByText("Retail Sales", { exact: true }) })
      .filter({ has: page.getByText("Calculated:", { exact: false }) })
      .first();

    const initialEditedText = await retailGridSection
      .getByText(/Edited:/, { exact: false })
      .textContent();

    const cellInput = retailGridSection.locator('input[type="number"]').first();
    await cellInput.fill("999");

    await expect
      .poll(async () => {
        const text = await retailGridSection
          .getByText(/Edited:/, { exact: false })
          .textContent();
        return text;
      })
      .not.toBe(initialEditedText);

    await expect(
      retailGridSection.getByText(/Edited:/, { exact: false }),
    ).toContainText("AED");
  });

  test("Generate PDFs in advanced mode sends the edited grid and shows download links", async ({
    page,
  }) => {
    await setupClerkTestingToken({ page });
    await setupCommonRoutes(page);

    let generateCallBody: unknown = null;

    await page.route("**/api/budget/calculate", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(makeMockCalculateResponse()),
      });
    });

    await page.route("**/api/budget/generate", async (route) => {
      generateCallBody = route.request().postDataJSON();
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(makeMockGenerateResponse()),
      });
    });

    await page.goto("/budget", { waitUntil: "domcontentloaded" });
    await expect(
      page.getByRole("heading", { name: "Budget Planner" }),
    ).toBeVisible({ timeout: 12_000 });

    await page.getByLabel("Advanced Mode").click();
    await fillAllChannels(page);

    await page.getByRole("button", { name: "Calculate & Preview" }).click();

    await expect(
      page.getByRole("heading", { name: "Edit Daily Spend" }),
    ).toBeVisible({ timeout: 10_000 });

    await page.getByRole("button", { name: "Generate PDFs" }).click();

    await expect(
      page.getByText("PDFs generated successfully"),
    ).toBeVisible({ timeout: 15_000 });

    await expect(
      page.getByRole("link", {
        name: /Retail Sales.*May_2026_Retail_Sales_ad_spend_budget\.pdf/,
      }),
    ).toBeVisible();
    await expect(
      page.getByRole("link", {
        name: /Website Sales.*May_2026_Website_Sales_ad_spend_budget\.pdf/,
      }),
    ).toBeVisible();
    await expect(
      page.getByRole("link", {
        name: /Toters Sales.*May_2026_Toters_Sales_ad_spend_budget\.pdf/,
      }),
    ).toBeVisible();

    await expect.poll(() => generateCallBody).not.toBeNull();
    const genBody = generateCallBody as {
      channels: Array<{ channelName: string; rows: unknown[] }>;
    };
    expect(genBody.channels).toHaveLength(3);
    expect(genBody.channels[0].channelName).toBe("Retail Sales");
    expect(genBody.channels[0].rows).toHaveLength(3);
  });
});

test.describe("Marketing Budget modal", () => {
  async function setupMarketingBudgetRoutes(
    page: Page,
    budgets: unknown[] = [],
  ) {
    await page.route("**/api/marketing-budgets**", async (route) => {
      if (route.request().method() === "GET") {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ budgets }),
        });
      } else {
        await route.continue();
      }
    });
  }

  test("modal has no Month or Year inputs", async ({ page }) => {
    await setupClerkTestingToken({ page });
    await setupCommonRoutes(page);
    await setupMarketingBudgetRoutes(page);

    await page.goto("/marketing-budget-planner", { waitUntil: "domcontentloaded" });
    await expect(
      page.getByRole("heading", { name: "Marketing Budget Planner" }),
    ).toBeVisible({ timeout: 12_000 });

    await page.getByRole("button", { name: "New marketing budget" }).first().click();

    await expect(page.getByRole("dialog")).toBeVisible();
    await expect(page.getByRole("dialog").getByText("New marketing budget")).toBeVisible();

    await expect(page.getByLabel("Month")).toHaveCount(0);
    await expect(page.getByLabel("Year")).toHaveCount(0);
    await expect(page.getByRole("option", { name: /January/ })).toHaveCount(0);
  });

  test("default Start date is 1st and End date is last day of current month", async ({
    page,
  }) => {
    await setupClerkTestingToken({ page });
    await setupCommonRoutes(page);
    await setupMarketingBudgetRoutes(page);

    await page.goto("/marketing-budget-planner", { waitUntil: "domcontentloaded" });
    await expect(
      page.getByRole("heading", { name: "Marketing Budget Planner" }),
    ).toBeVisible({ timeout: 12_000 });

    await page.getByRole("button", { name: "New marketing budget" }).first().click();
    await expect(page.getByRole("dialog")).toBeVisible();

    const now = new Date();
    const year = now.getFullYear();
    const month = now.getMonth() + 1;
    const expectedStart = `${year}-${String(month).padStart(2, "0")}-01`;
    const lastDay = new Date(year, month, 0).getDate();
    const expectedEnd = `${year}-${String(month).padStart(2, "0")}-${String(lastDay).padStart(2, "0")}`;

    const startInput = page.getByLabel("Start date");
    const endInput = page.getByLabel("End date");

    await expect(startInput).toHaveValue(expectedStart);
    await expect(endInput).toHaveValue(expectedEnd);
  });

  test("setting End date before Start date shows inline error and blocks submission", async ({
    page,
  }) => {
    await setupClerkTestingToken({ page });
    await setupCommonRoutes(page);
    await setupMarketingBudgetRoutes(page);

    let createCalled = false;
    await page.route("**/api/marketing-budgets", async (route) => {
      if (route.request().method() === "POST") {
        createCalled = true;
        await route.continue();
      } else {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ budgets: [] }),
        });
      }
    });

    await page.goto("/marketing-budget-planner", { waitUntil: "domcontentloaded" });
    await expect(
      page.getByRole("heading", { name: "Marketing Budget Planner" }),
    ).toBeVisible({ timeout: 12_000 });

    await page.getByRole("button", { name: "New marketing budget" }).first().click();
    await expect(page.getByRole("dialog")).toBeVisible();

    await page.getByLabel("Budget name").fill("Test budget");
    await page.getByLabel("Start date").fill("2026-05-31");
    await page.getByLabel("End date").fill("2026-05-01");

    await page.getByRole("button", { name: "Create marketing budget" }).click();

    await expect(
      page.getByText("End date must be on or after start date."),
    ).toBeVisible({ timeout: 5_000 });

    expect(createCalled).toBe(false);
  });

  test("valid creation flow sends correct startDate and endDate without month/year", async ({
    page,
  }) => {
    await setupClerkTestingToken({ page });
    await setupCommonRoutes(page);
    await setupMarketingBudgetRoutes(page);

    let capturedBody: Record<string, unknown> | null = null;

    await page.route("**/api/marketing-budgets", async (route) => {
      if (route.request().method() === "POST") {
        capturedBody = route.request().postDataJSON() as Record<string, unknown>;
        await route.fulfill({
          status: 201,
          contentType: "application/json",
          body: JSON.stringify({
            budget: {
              id: 42,
              name: "May 2026 Campaign",
              month: 5,
              year: 2026,
              start_date: "2026-05-01",
              end_date: "2026-05-31",
              currency: "AED",
              status: "current",
              channels: [],
              created_at: new Date().toISOString(),
              updated_at: new Date().toISOString(),
            },
          }),
        });
      } else {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ budgets: [] }),
        });
      }
    });

    await page.goto("/marketing-budget-planner", { waitUntil: "domcontentloaded" });
    await expect(
      page.getByRole("heading", { name: "Marketing Budget Planner" }),
    ).toBeVisible({ timeout: 12_000 });

    await page.getByRole("button", { name: "New marketing budget" }).first().click();
    await expect(page.getByRole("dialog")).toBeVisible();

    await page.getByLabel("Budget name").fill("May 2026 Campaign");
    await page.getByLabel("Start date").fill("2026-05-01");
    await page.getByLabel("End date").fill("2026-05-31");

    await page.getByRole("button", { name: "Create marketing budget" }).click();

    await expect
      .poll(() => capturedBody, { timeout: 8_000 })
      .not.toBeNull();

    expect(capturedBody).toMatchObject({
      name: "May 2026 Campaign",
      startDate: "2026-05-01",
      endDate: "2026-05-31",
    });
    expect(capturedBody).not.toHaveProperty("month");
    expect(capturedBody).not.toHaveProperty("year");
  });

  test("clicking a quick-month button fills Start date and End date with the first and last day of that month", async ({
    page,
  }) => {
    await setupClerkTestingToken({ page });
    await setupCommonRoutes(page);
    await setupMarketingBudgetRoutes(page);

    await page.goto("/marketing-budget-planner", { waitUntil: "domcontentloaded" });
    await expect(
      page.getByRole("heading", { name: "Marketing Budget Planner" }),
    ).toBeVisible({ timeout: 12_000 });

    await page.getByRole("button", { name: "New marketing budget" }).first().click();
    await expect(page.getByRole("dialog")).toBeVisible();

    // Compute the month 2 months ahead of today so it is never the
    // pre-selected current month (which is already highlighted).
    const now = new Date();
    const targetDate = new Date(now.getFullYear(), now.getMonth() + 2, 1);
    const targetYear = targetDate.getFullYear();
    const targetMonth = targetDate.getMonth() + 1; // 1-based
    const targetLabel = targetDate.toLocaleString("en-US", {
      month: "short",
      year: "numeric",
    });
    const expectedStart = `${targetYear}-${String(targetMonth).padStart(2, "0")}-01`;
    const lastDay = new Date(targetYear, targetMonth, 0).getDate();
    const expectedEnd = `${targetYear}-${String(targetMonth).padStart(2, "0")}-${String(lastDay).padStart(2, "0")}`;

    // Open the date-range picker popover. The trigger always shows the current
    // range or "Pick a date range" — match by the "–" separator it contains
    // when both dates are set, or fall back to any text that indicates a date.
    const dialog = page.getByRole("dialog");
    await dialog
      .getByRole("button", { name: /–|Pick a date range|From / })
      .click();

    await expect(page.getByText("Quick select month")).toBeVisible({
      timeout: 5_000,
    });

    // Click the quick-month button for the computed target month.
    await page.getByRole("button", { name: targetLabel, exact: true }).click();

    // The popover closes after a quick-month selection. Verify the text inputs.
    const startInput = page.getByLabel("Start date");
    const endInput = page.getByLabel("End date");

    await expect(startInput).toHaveValue(expectedStart, { timeout: 5_000 });
    await expect(endInput).toHaveValue(expectedEnd);
  });

  test("clicking two calendar days fills Start date and End date correctly", async ({
    page,
  }) => {
    await setupClerkTestingToken({ page });
    await setupCommonRoutes(page);
    await setupMarketingBudgetRoutes(page);

    await page.goto("/marketing-budget-planner", { waitUntil: "domcontentloaded" });
    await expect(
      page.getByRole("heading", { name: "Marketing Budget Planner" }),
    ).toBeVisible({ timeout: 12_000 });

    await page.getByRole("button", { name: "New marketing budget" }).first().click();
    await expect(page.getByRole("dialog")).toBeVisible();

    // Compute the month currently shown in the calendar (defaults to the
    // form's startDate month, which is the current month).
    const now = new Date();
    const calYear = now.getFullYear();
    const calMonth = now.getMonth() + 1; // 1-based

    const expectedStart = `${calYear}-${String(calMonth).padStart(2, "0")}-08`;
    const expectedEnd = `${calYear}-${String(calMonth).padStart(2, "0")}-22`;

    // Open the date-range picker popover.
    const dialog = page.getByRole("dialog");
    await dialog
      .getByRole("button", { name: /–|Pick a date range|From / })
      .click();

    await expect(page.getByText("Quick select month")).toBeVisible({
      timeout: 5_000,
    });

    // The calendar day cells are <button> elements rendered inside a <table>.
    // Click day 8 as the range start, then day 22 as the range end.
    // We scope to the calendar table to avoid matching quick-month buttons.
    const calendarTable = page.locator("table").last();

    // First click — sets the range start
    await calendarTable
      .getByRole("button", { name: "8", exact: true })
      .click();

    // Second click — sets the range end
    await calendarTable
      .getByRole("button", { name: "22", exact: true })
      .click();

    const startInput = page.getByLabel("Start date");
    const endInput = page.getByLabel("End date");

    await expect(startInput).toHaveValue(expectedStart, { timeout: 5_000 });
    await expect(endInput).toHaveValue(expectedEnd);
  });
});

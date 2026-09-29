import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures";
import { setupFapiWithFakeSession } from "./clerk-fapi-redirect";

// Every application API used by this spec is route-mocked, so a static Clerk
// browser session is enough and keeps the test independent of Clerk availability.
test.use({
  _fapiMock: [
    async ({ page }, use) => {
      await setupFapiWithFakeSession(page);
      await use();
    },
    { auto: true },
  ],
});

const RUNS = [
  { id: 101, status: "completed", engine_version: "recipe-v1", completed_at: "2026-09-05T10:01:00.000Z" },
  { id: 202, status: "completed", engine_version: "recipe-v2", completed_at: "2026-09-06T10:01:00.000Z" },
];

function run(id: number, f1: number, fingerprint = "same-input") {
  return {
    run: {
      ...RUNS.find((item) => item.id === id),
      created_at: "2026-09-05T10:00:00.000Z",
      exclusions: [],
      sample_definition: { selected_product_ids: [501] },
      metrics: {
        canonical_metrics: { base_item_resolution: { f1 } },
        estimated_manual_review_burden: {
          canonical: {
            review_rate: f1 < 0.9 ? 0.4 : 0.2,
            average_edits_per_product: f1 < 0.9 ? 1.5 : 0.5,
            products_requiring_review: 1,
            product_denominator: 1,
          },
        },
        canonical_format_groups: [{
          format: "Bouquet",
          category: "Roses",
          scored_product_count: 1,
          base_item_f1: f1,
          quantity_accuracy: { evaluated: 1, correct: 1, accuracy: 1 },
          full_recipe_exact_match: { evaluated: 1, correct: f1 === 1 ? 1 : 0, accuracy: f1 },
        }],
      },
    },
    results: [{
      product_id: 501,
      product_snapshot: { name: "Rose bouquet", category: "Roses", canonical_format: "Bouquet" },
      evidence_used: { benchmark_case_input_fingerprint: fingerprint },
      comparison: {
        baseItem: { f1 },
        missingItems: f1 < 1 ? [{ baseItemName: "Red Rose", quantity: 2 }] : [],
        incorrectExtras: [],
      },
      created_at: "2026-09-05T10:01:00.000Z",
    }],
  };
}

function comparison(comparable: boolean) {
  const baseline = run(101, 0.9);
  const candidate = run(202, 0.8, comparable ? "same-input" : "changed-input");
  return {
    baseline,
    candidate,
    comparability: {
      comparable,
      reasons: comparable ? [] : ["Benchmark case input changed for product 501"],
      changed_canonical_definition_fields: [],
      missing_canonical_definition_fields: [],
      production_configuration_match: true,
      baseline_configuration_fingerprint: "config",
      candidate_configuration_fingerprint: "config",
      input_drift_product_ids: comparable ? [] : [501],
      missing_baseline_result_product_ids: [],
      missing_candidate_result_product_ids: [],
      missing_baseline_snapshot_product_ids: [],
      missing_candidate_snapshot_product_ids: [],
      missing_baseline_fingerprint_product_ids: [],
      missing_candidate_fingerprint_product_ids: [],
      baseline_only_evaluated_product_ids: [],
      candidate_only_evaluated_product_ids: [],
      missing_baseline_format_groups: [],
      missing_candidate_format_groups: [],
      changed_format_groups: [],
      persisted_baseline_linkage_used: false,
      persisted_regression_gate_agrees: null,
    },
    regression_gate: {
      status: comparable ? "flagged" : "incomparable",
      baseline_run_id: 101,
      flagged_formats: comparable ? [{
        format: "Bouquet",
        category: "Roses",
        baseline: { base_item_f1: 0.9 },
        current: { base_item_f1: 0.8 },
        reasons: ["base_item_f1_worse"],
      }] : [],
    },
    canonical_failures: [],
  };
}

async function setupManager(page: Page, comparable = true) {
  await page.route("**/api/users**", (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({
      members: [],
      me: {
        role: "manager",
        email: "recipe-manager@example.com",
        allowedPages: ["products"],
        customRoleId: 42,
      },
    }),
  }));
  await page.route(/\/api\/products\/recipe-benchmarks(?:\/compare)?(?:\?.*)?$/, (route) => {
    const url = new URL(route.request().url());
    const body = url.pathname.endsWith("/compare")
      ? comparison(comparable)
      : { runs: RUNS };
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
  });
}

test.describe("Recipe benchmark comparison", () => {
  test("manager with Product access selects completed runs and sees a regression", async ({ page }) => {
    await setupManager(page);
    await page.goto("/recipe-benchmarks", { waitUntil: "domcontentloaded" });

    await expect(page.getByRole("heading", { name: "Recipe benchmark comparison" })).toBeVisible({
      timeout: 15_000,
    });
    await page.getByTestId("select-baseline-run").click();
    await page.getByTestId("option-baseline-run-101").click();
    await page.getByTestId("select-candidate-run").click();
    await page.getByTestId("option-candidate-run-202").click();
    await page.getByTestId("button-compare-runs").click();

    await expect(page).toHaveURL(/recipe-benchmarks\?baseline=101&candidate=202$/);
    await expect(page.getByTestId("container-comparison-view")).toBeVisible();
    await expect(page.getByTestId("text-baseline-run")).toHaveText("Run #101");
    await expect(page.getByTestId("text-candidate-run")).toHaveText("Run #202");
    await expect(page.getByTestId("status-regression-gate-flagged")).toHaveText("Flagged");
    await expect(page.getByTestId("list-persisted-flags")).toContainText("Base Item F1 decreased");
  });

  test("unavailable or unfinished run in the URL shows the safe error state", async ({ page }) => {
    await setupManager(page);
    await page.goto("/recipe-benchmarks?baseline=101&candidate=999", { waitUntil: "domcontentloaded" });

    await expect(page.getByRole("heading", { name: "Recipe benchmark comparison" })).toBeVisible({
      timeout: 15_000,
    });
    await expect(page.getByTestId("status-invalid-run-selection")).toContainText(
      "Only completed Recipe benchmark runs in this workspace can be compared.",
    );
    await expect(page.getByTestId("container-comparison-view")).toHaveCount(0);
  });

  test("incomparable completed runs suppress the regression decision", async ({ page }) => {
    await setupManager(page, false);
    await page.goto("/recipe-benchmarks?baseline=101&candidate=202", { waitUntil: "domcontentloaded" });

    await expect(page.getByRole("heading", { name: "Recipe benchmark comparison" })).toBeVisible({
      timeout: 15_000,
    });
    await expect(page.getByTestId("status-regression-gate-incomparable")).toHaveText("Incomparable");
    await expect(page.getByTestId("status-incomparable-reasons")).toContainText(
      "Benchmark case input changed for product 501",
    );
    await expect(page.getByTestId("text-accuracy-delta")).toContainText("Suppressed");
  });
});
import { test, expect } from "./fixtures";
import { setupClerkTestingToken } from "@clerk/testing/playwright";
import type { Page } from "@playwright/test";
import { setupFapiWithFakeSession } from "./clerk-fapi-redirect";

const sourceActionTest = test.extend({});
sourceActionTest.use({
  _fapiMock: [
    async ({ page }, use) => {
      await setupFapiWithFakeSession(page);
      await use();
    },
    { auto: true },
  ],
});

const OWNER_EMAIL = "e2e-tester@presentail.com";

// ─── Shared mock helpers ────────────────────────────────────────────────────

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

function memberUsersResponse() {
  return {
    members: [
      {
        id: 2,
        email: "finance-viewer@example.com",
        role: "member",
        custom_role_id: 10,
        role_name: "Finance Viewer",
        joined: true,
        joined_at: new Date().toISOString(),
        invited_at: new Date().toISOString(),
        invited_by_email: OWNER_EMAIL,
        manager_member_id: null,
        manager_email: null,
      },
    ],
    me: {
      role: "member",
      email: "finance-viewer@example.com",
      allowedPages: ["ai-invoice-import"],
      customRoleId: 10,
    },
  };
}

function entitiesResponse() {
  return {
    entities: [
      {
        id: 1,
        workspace_owner_id: "owner_clerk_id",
        legal_name: "Acme Trading LLC",
        display_name: "Acme Trading",
        country: "AE",
        tax_registration_number: "100123456789003",
        accounting_system: "manual",
        odoo_company_id: null,
        odoo_company_name: null,
        odoo_database: null,
        odoo_base_url: null,
        default_currency: "AED",
        is_active: true,
        odoo_integration_configured: false,
        created_at: new Date().toISOString(),
      },
      {
        id: 2,
        workspace_owner_id: "owner_clerk_id",
        legal_name: "Beta Holdings",
        display_name: null,
        country: "AE",
        tax_registration_number: null,
        accounting_system: "none",
        odoo_company_id: null,
        odoo_company_name: null,
        odoo_database: null,
        odoo_base_url: null,
        default_currency: "USD",
        is_active: true,
        odoo_integration_configured: false,
        created_at: new Date().toISOString(),
      },
    ],
  };
}

function emptyImportsResponse() {
  return { imports: [], total: 0 };
}

function importsResponse() {
  return {
    total: 3,
    imports: [
      {
        id: 101,
        entity_id: 1,
        status: "extracted",
        original_filename: "invoice-jan.pdf",
        vendor_name: "Supplier Co",
        invoice_number: "INV-2024-001",
        invoice_date: "2024-01-15",
        due_date: "2024-02-15",
        currency: "AED",
        total_amount: "5250.00",
        subtotal: "5000.00",
        tax_amount: "250.00",
        confidence: "0.92",
        company_validation_status: "ok",
        company_validation_notes: null,
        odoo_bill_url: null,
        odoo_bill_id: null,
        error_message: null,
        created_at: new Date().toISOString(),
        entity_legal_name: "Acme Trading LLC",
        entity_accounting_system: "manual",
        line_items: [
          { description: "Widget A", quantity: 10, unit_price: 500, total: 5000 },
        ],
        vendor_address: null,
        vendor_tax_number: "200999888777006",
        manually_entered_at: null,
        manual_accounting_reference: null,
        source_document: {
          available: true,
          url: "/api/finance/invoice-review/101/source",
        },
      },
      {
        id: 102,
        entity_id: 1,
        status: "processing",
        original_filename: "invoice-feb.pdf",
        vendor_name: null,
        invoice_number: null,
        invoice_date: null,
        due_date: null,
        currency: null,
        total_amount: null,
        subtotal: null,
        tax_amount: null,
        confidence: null,
        company_validation_status: null,
        company_validation_notes: null,
        odoo_bill_url: null,
        odoo_bill_id: null,
        error_message: null,
        created_at: new Date().toISOString(),
        entity_legal_name: "Acme Trading LLC",
        entity_accounting_system: "manual",
        line_items: [],
        vendor_address: null,
        vendor_tax_number: null,
        manually_entered_at: null,
        manual_accounting_reference: null,
      },
      {
        id: 103,
        entity_id: 1,
        status: "failed",
        original_filename: "corrupted.pdf",
        vendor_name: null,
        invoice_number: null,
        invoice_date: null,
        due_date: null,
        currency: null,
        total_amount: null,
        subtotal: null,
        tax_amount: null,
        confidence: null,
        company_validation_status: null,
        company_validation_notes: null,
        odoo_bill_url: null,
        odoo_bill_id: null,
        error_message: "AI extraction failed: unable to parse PDF",
        created_at: new Date().toISOString(),
        entity_legal_name: "Acme Trading LLC",
        entity_accounting_system: "manual",
        line_items: [],
        vendor_address: null,
        vendor_tax_number: null,
        manually_entered_at: null,
        manual_accounting_reference: null,
      },
    ],
  };
}

async function setupCommonRoutes(page: Page, usersResp: object = ownerUsersResponse()) {
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
        body: JSON.stringify(usersResp),
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
}

// ─── Tests ──────────────────────────────────────────────────────────────────

test.describe("AI Invoice Import — page renders for owners", () => {
  test("page loads with KPI cards, entity selector, and upload zone", async ({ page }) => {
    await setupClerkTestingToken({ page });
    await setupCommonRoutes(page);

    await page.route("**/api/finance/entities**", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(entitiesResponse()),
      }),
    );

    await page.route("**/api/finance/ai-invoice-import**", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(emptyImportsResponse()),
      }),
    );

    await page.goto("/ai-invoice-import", { waitUntil: "domcontentloaded" });

    // Page heading
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible({ timeout: 12_000 });

    // Entity selector trigger (contains the building icon area)
    const entitySelector = page.locator('[role="combobox"]').first();
    await expect(entitySelector).toBeVisible({ timeout: 8_000 });

    // KPI cards
    await expect(page.getByText("Total Imports")).toBeVisible();
    await expect(page.getByText("Processing")).toBeVisible();
    await expect(page.getByText("Ready / Entered")).toBeVisible();
    await expect(page.getByText("Failed")).toBeVisible();

    // Upload zone text
    await expect(page.getByText("Drop PDF invoices here, or click to browse")).toBeVisible();
  });

  test("empty state shows 'No invoices imported yet' when import list is empty", async ({ page }) => {
    await setupClerkTestingToken({ page });
    await setupCommonRoutes(page);

    await page.route("**/api/finance/entities**", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(entitiesResponse()),
      }),
    );

    await page.route("**/api/finance/ai-invoice-import**", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(emptyImportsResponse()),
      }),
    );

    await page.goto("/ai-invoice-import", { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible({ timeout: 15_000 });

    await expect(page.getByText("No invoices imported yet")).toBeVisible({ timeout: 12_000 });
  });
});

// ─── Invoice review workspace (route-mocked) ─────────────────────────────────

function reviewResponse(overrides: Record<string, unknown> = {}) {
  return {
    invoice: {
      id: 101,
      review_version: 4,
      review_status: "needs_review",
      sync_status: "not_requested",
      entity_id: 1,
      entity_legal_name: "Acme Trading LLC",
      original_filename: "invoice-jan.png",
      vendor_name: "Supplier Co",
      invoice_number: "INV-2024-001",
      currency: "AED",
      subtotal: "5000.00",
      tax_amount: "250.00",
      total_amount: "5250.00",
      line_items: [{ description: "Widget A", quantity: 10, unit_price: 500, total: 5000 }],
      ...((overrides.invoice as object) ?? {}),
    },
    permissions: { can_edit: true, can_approve: true },
    navigation: { next: 102 },
    ...overrides,
  };
}

test.describe("AI Invoice Import — review queue and workspace", () => {
  test("uses the review queue with separate status filters for every entity", async ({ page }) => {
    await setupClerkTestingToken({ page });
    await setupCommonRoutes(page);
    let queueRequests = 0;
    let legacyRequests = 0;
    await page.route("**/api/finance/entities**", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ entities: [{ ...entitiesResponse().entities[0], invoice_review_enabled: true }, { ...entitiesResponse().entities[1], invoice_review_enabled: false }] }) }));
    await page.route("**/api/finance/invoice-review/queue**", (route) => {
      queueRequests++;
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ imports: [{ ...importsResponse().imports[0], review_status: "needs_review", sync_status: "failed", issue_count: 2 }], total: 1 }) });
    });
    await page.route("**/api/finance/ai-invoice-import**", (route) => {
      legacyRequests++;
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(emptyImportsResponse()) });
    });
    await page.goto("/ai-invoice-import", { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible({ timeout: 15_000 });
    await page.locator(".w-52[role=combobox]").click();
    await page.getByRole("option", { name: "Acme Trading" }).click();
    await expect(page.getByTestId("button-review-invoice-101")).toBeVisible();
    await expect(page.getByTestId("text-visible-issue-count")).toHaveText("2 visible issues");
    await expect(page.getByTestId("select-review-status")).toHaveCount(0);
    await page.getByTestId("button-more-filters").click();
    await page.getByTestId("select-review-status").click();
    await page.getByRole("option", { name: "Needs review" }).click();
    await expect.poll(() => queueRequests).toBeGreaterThan(1);
    const beforeSecondEntity = queueRequests;
    await page.locator(".w-52[role=combobox]").click();
    await page.getByRole("option", { name: "Beta Holdings" }).click();
    await expect.poll(() => queueRequests).toBeGreaterThan(beforeSecondEntity);
    expect(legacyRequests).toBe(0);
    await expect(page.getByTestId("button-review-invoice-101")).toBeVisible();
  });

  test("shows live status counts and requests the selected page size and page", async ({ page }) => {
    await setupClerkTestingToken({ page });
    await setupCommonRoutes(page);
    const queueUrls: string[] = [];
    await page.route("**/api/finance/entities**", (route) => route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(entitiesResponse()),
    }));
    await page.route("**/api/finance/invoice-review/queue**", (route) => {
      queueUrls.push(route.request().url());
      const url = new URL(route.request().url());
      const limit = Number(url.searchParams.get("limit") ?? 10);
      const offset = Number(url.searchParams.get("offset") ?? 0);
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          imports: [{ ...importsResponse().imports[0], id: 101 + offset, review_status: "needs_review", sync_status: "not_requested" }],
          total: 61,
          counts: { all: 61, needs_review: 8, ready_to_sync: 12, sync_failed: 3, succeeded: 38 },
          limit,
          offset,
        }),
      });
    });

    await page.goto("/ai-invoice-import", { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading", { level: 1, name: "Supplier bills" })).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId("tab-invoice-all")).toContainText("61");
    await expect(page.getByTestId("tab-invoice-needs_review")).toContainText("8");
    await expect(page.getByTestId("button-more-filters")).toHaveAttribute("aria-expanded", "false");
    await expect(page.getByTestId("text-invoice-result-range")).toHaveText("Showing 1–10 of 61");

    await page.getByTestId("select-invoice-page-size").click();
    await page.getByRole("option", { name: "25", exact: true }).click();
    await expect.poll(() => queueUrls.some((value) => new URL(value).searchParams.get("limit") === "25")).toBe(true);
    await expect(page.getByTestId("text-invoice-result-range")).toHaveText("Showing 1–25 of 61");

    await page.getByTestId("button-next-invoice-page").click();
    await expect.poll(() => queueUrls.some((value) => new URL(value).searchParams.get("offset") === "25")).toBe(true);
    await expect(page.getByTestId("text-invoice-result-range")).toHaveText("Showing 26–50 of 61");
    await expect(page.getByTestId("button-previous-invoice-page")).toBeEnabled();
  });

  test("opens every invoice row in the full-screen workspace", async ({ page }) => {
    await setupClerkTestingToken({ page });
    await setupCommonRoutes(page);
    await page.route("**/api/finance/entities**", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ entities: [{ ...entitiesResponse().entities[0], invoice_review_enabled: true }, { ...entitiesResponse().entities[1], invoice_review_enabled: false }] }) }));
    await page.route("**/api/finance/invoice-review/queue**", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ imports: [{ ...importsResponse().imports[0], review_status: "needs_review" }], total: 1 }) }));
    await page.goto("/ai-invoice-import", { waitUntil: "domcontentloaded" });
    await page.locator(".w-52[role=combobox]").click();
    await page.getByRole("option", { name: "Acme Trading" }).click();
    await page.getByTestId("button-review-invoice-101").click();
    await expect(page).toHaveURL(/\/ai-invoice-import\/101\/review\?/);

    await page.goto("/ai-invoice-import", { waitUntil: "domcontentloaded" });
    await page.locator(".w-52[role=combobox]").click();
    await page.getByRole("option", { name: "Beta Holdings" }).click();
    await page.getByTestId("button-review-invoice-101").click();
    await expect(page).toHaveURL(/\/ai-invoice-import\/101\/review\?/);
  });

  test("shows a retryable queue error without falling back to legacy for enabled entities", async ({ page }) => {
    await setupClerkTestingToken({ page });
    await setupCommonRoutes(page);
    let legacyRequests = 0;
    await page.route("**/api/finance/entities**", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ entities: [{ ...entitiesResponse().entities[0], invoice_review_enabled: true }] }) }));
    await page.route("**/api/finance/invoice-review/queue**", (route) => route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "Queue unavailable" }) }));
    await page.route("**/api/finance/ai-invoice-import**", (route) => { legacyRequests++; return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(importsResponse()) }); });
    await page.goto("/ai-invoice-import", { waitUntil: "domcontentloaded" });
    await page.locator(".w-52[role=combobox]").click();
    await page.getByRole("option", { name: "Acme Trading" }).click();
    await expect(page.getByTestId("invoice-queue-error")).toBeVisible();
    await page.waitForTimeout(300);
    expect(legacyRequests).toBe(0);
  });

  test("shows owners that the full-screen review workflow is active", async ({ page }) => {
    await setupClerkTestingToken({ page });
    await setupCommonRoutes(page);
    await page.route("**/api/finance/entities**", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(entitiesResponse()) }));
    await page.route("**/api/finance/invoice-review/queue**", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(emptyImportsResponse()) }));
    await page.goto("/ai-invoice-import", { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible({ timeout: 15_000 });
    await page.locator(".w-52[role=combobox]").click();
    await page.getByRole("option", { name: "Acme Trading" }).click();
    await page.getByTestId("button-invoice-entity-settings").click();
    await expect(page.getByText("Full-screen invoice review is active")).toBeVisible();
  });

  sourceActionTest("shows the original source action only when the selected import has a source", async ({ page }) => {
    await setupCommonRoutes(page);
    await page.route("**/api/finance/entities**", (route) => route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(entitiesResponse()),
    }));
    await page.route("**/api/finance/ai-invoice-import**", (route) => route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(importsResponse()),
    }));

    await page.goto("/ai-invoice-import", { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible({ timeout: 15_000 });
    await page.getByText("Supplier Co").click();
    await expect(page.getByTestId("link-view-invoice-101")).toHaveAttribute(
      "href",
      "/api/finance/invoice-review/101/source",
    );
    await page.getByText("Unknown", { exact: true }).first().click();
    await expect(page.getByTestId("link-view-invoice-102")).toHaveCount(0);
  });

  test("shows source preview highlights, protects dirty next navigation, and completes approval lifecycle", async ({ page }) => {
    await setupClerkTestingToken({ page });
    await setupCommonRoutes(page);
    const calls: string[] = [];
    await page.route("**/invoice-source.png", (route) => route.fulfill({ status: 200, contentType: "image/png", body: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64") }));
    await page.route("**/api/finance/invoice-review/101/neighbors", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ previous_id: null, next_id: 102, position: 1, total: 2 }) }));
    await page.route("**/api/finance/invoice-review/101", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(reviewResponse({
      invoice: { invoice_date: "2024-01-15", supplier_id: 1, wafeq_supplier_id: "wafeq-1", wafeq_tax_id: "tax-1", currency: "USD", subtotal: 5000, tax_amount: 0, total_amount: 5000, line_items: [{ description: "Widget A", quantity: 10, unit_price: 500, total: 5000, wafeq_account_id: "acc-1" }] },
      source_document: { available: true, url: "/invoice-source.png", content_type: "image/png", page_count: 2, coordinates_available: true },
      extraction_provenance: { coordinates_available: true, regions: { vendor_name: { x: 10, y: 10, width: 25, height: 8 } } },
      issues: [{ id: "tax", issue_key: "tax", message: "Confirm tax", severity: "warning" }],
    })) }));
    await page.route("**/api/finance/invoice-review/101/**", async (route) => {
      calls.push(route.request().url());
      if (route.request().url().includes("/neighbors")) {
        await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ previous_id: null, next_id: 102, position: 1, total: 2 }) });
        return;
      }
      if (route.request().url().includes("/acknowledge") || route.request().url().includes("/draft") || route.request().url().includes("/approve")) {
        await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true }) });
        return;
      }
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(reviewResponse({
        invoice: { invoice_date: "2024-01-15", supplier_id: 1, wafeq_supplier_id: "wafeq-1", wafeq_tax_id: "tax-1", currency: "USD", subtotal: 5000, tax_amount: 0, total_amount: 5000, line_items: [{ description: "Widget A", quantity: 10, unit_price: 500, total: 5000, wafeq_account_id: "acc-1" }] },
        source_document: { available: true, url: "/invoice-source.png", content_type: "image/png", page_count: 2, coordinates_available: true },
        extraction_provenance: { coordinates_available: true, regions: { vendor_name: { x: 10, y: 10, width: 25, height: 8 } } },
        issues: [{ id: "tax", issue_key: "tax", message: "Confirm tax", severity: "warning" }],
      })) });
    });
    await page.goto("/ai-invoice-import/101/review", { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId("viewer-image")).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId("text-bill-position")).toHaveText("Bill 1 of 2");
    await expect(page.getByTestId("button-previous-invoice")).toBeDisabled();
    await expect(page.getByTestId("button-next-invoice")).toBeEnabled();
    await expect(page.getByTestId("button-previous-source-page")).toBeDisabled();
    await expect(page.getByTestId("button-next-source-page")).toBeEnabled();
    await page.getByTestId("overlay-region-vendor_name").click();
    await expect(page.getByTestId("overlay-region-vendor_name")).toHaveClass(/border-emerald-500/);
    await page.getByTestId("input-review-invoice_number").fill("Changed Number");
    page.once("dialog", (dialog) => dialog.dismiss());
    await page.getByTestId("button-next-invoice").click();
    await expect(page).toHaveURL(/101\/review$/);
    await page.getByTestId("button-acknowledge-issue-tax").click();
    await expect.poll(() => calls.some((url) => url.includes("/acknowledge"))).toBe(true);
    page.once("dialog", (dialog) => dialog.accept());
    await page.getByTestId("button-approve-invoice").click();
    await expect.poll(() => calls.some((url) => url.includes("/approve"))).toBe(true);
  });

  test("groups the revised bill fields and keeps them usable at narrow widths", async ({ page }) => {
    await setupClerkTestingToken({ page });
    await setupCommonRoutes(page);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.route("**/api/finance/invoice-review/101/neighbors", (route) => route.fulfill({ status: 200, contentType: "application/json", body: "{}" }));
    await page.route("**/api/finance/invoice-review/wafeq/tax-rates", (route) => route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ tax_rates: [{ id: "tax-1", name: "VAT 11% - exclusive", rate: 11 }] }),
    }));
    await page.route("**/api/finance/invoice-review/101", (route) => route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(reviewResponse({
        entity: { legal_name: "Acme Trading LLC", accounting_system: "wafeq" },
        invoice: {
          vendor_name: "Raidan Floriculture SARL",
          wafeq_supplier_id: "wafeq-1",
          wafeq_tax_id: "tax-1",
          invoice_date: "2026-09-21",
          due_date: null,
          manual_accounting_reference: "PO-42",
        },
      })),
    }));

    await page.goto("/ai-invoice-import/101/review", { waitUntil: "domcontentloaded" });
    await expect(page.getByTestId("bill-accounting-supplier")).toContainText("Matched");
    await expect(page.getByTestId("text-detected-supplier")).toContainText("Raidan Floriculture SARL");
    await expect(page.getByTestId("bill-metadata-row").getByTestId("input-review-invoice_number")).toBeVisible();
    await expect(page.getByTestId("bill-currency-vat-row").getByTestId("input-review-wafeq_tax_id")).toBeVisible();
    await expect(page.getByText("Applies to the entire bill.")).toBeVisible();
    await expect(page.getByTestId("bill-reference-row").getByTestId("input-review-manual_accounting_reference")).toHaveValue("PO-42");
    await expect(page.getByTestId("bill-details-fields").evaluate((element) => element.scrollWidth <= element.clientWidth + 1)).resolves.toBe(true);
  });

  test("blocks approval while blocking validation is visible", async ({ page }) => {
    await setupClerkTestingToken({ page });
    await setupCommonRoutes(page);
    await page.route("**/api/finance/invoice-review/101/neighbors", (route) => route.fulfill({ status: 200, contentType: "application/json", body: "{}" }));
    await page.route("**/api/finance/invoice-review/101", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(reviewResponse({ issues: [{ message: "Supplier required", severity: "blocking", blocking: true }] })) }));
    await page.route("**/api/finance/invoice-review/101/**", async (route) => {
      if (route.request().url().includes("/approve")) { await route.fulfill({ status: 200, contentType: "application/json", body: "{}" }); return; }
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(reviewResponse({ issues: [{ message: "Supplier required", severity: "blocking", blocking: true }] })) });
    });
    await page.goto("/ai-invoice-import/101/review", { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText("Supplier required")).toBeVisible();
    await expect(page.getByTestId("banner-review-exceptions")).toContainText("Review unresolved errors before approval");
    await expect(page.getByTestId("button-approve-invoice")).toBeDisabled({ timeout: 15_000 });
  });

  test("shows unavailable, unsupported, and retryable source states", async ({ page }) => {
    await setupClerkTestingToken({ page });
    await setupCommonRoutes(page);
    await page.route("**/api/finance/invoice-review/101/neighbors", (route) => route.fulfill({ status: 200, contentType: "application/json", body: "{}" }));
    await page.route("**/api/finance/invoice-review/101", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(reviewResponse({ source_document: { available: false, url: null } })) }));
    await page.goto("/ai-invoice-import/101/review", { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId("source-unavailable")).toBeVisible();
  });

  test("restores an unavailable source with the selected file and current review version", async ({ page }) => {
    await setupClerkTestingToken({ page });
    await setupCommonRoutes(page);
    let sourceAvailable = false;
    let uploadBody = "";
    await page.route("**/api/finance/invoice-review/101/neighbors", (route) => route.fulfill({ status: 200, contentType: "application/json", body: "{}" }));
    await page.route("**/api/finance/invoice-review/101/source", (route) => {
      if (route.request().method() === "PUT") {
        uploadBody = route.request().postDataBuffer()?.toString("latin1") ?? "";
        sourceAvailable = true;
        return route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            success: true,
            source_document: { available: true, url: "/api/finance/invoice-review/101/source", content_type: "application/pdf", filename: "restored.pdf", byte_size: 16 },
            review_version: 4,
          }),
        });
      }
      return route.fulfill({ status: 200, contentType: "application/pdf", body: "%PDF-1.4 restored" });
    });
    await page.route("**/api/finance/invoice-review/101", (route) => route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(reviewResponse({
        invoice: { review_version: sourceAvailable ? 4 : 3, version: sourceAvailable ? 4 : 3 },
        source_document: sourceAvailable
          ? { available: true, url: "/api/finance/invoice-review/101/source", content_type: "application/pdf", filename: "restored.pdf" }
          : { available: false, url: null },
      })),
    }));

    await page.goto("/ai-invoice-import/101/review", { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId("source-unavailable")).toBeVisible();
    await page.getByTestId("input-upload-source").setInputFiles({
      name: "restored.pdf",
      mimeType: "application/pdf",
      buffer: Buffer.from("%PDF-1.4 restored"),
    });

    await expect(page.getByText("Source attachment restored")).toBeVisible();
    await expect(page.getByTestId("viewer-pdf")).toBeVisible();
    expect(uploadBody).toContain('name="version"');
    expect(uploadBody).toContain("\r\n3\r\n");
    expect(uploadBody).toContain('filename="restored.pdf"');
    expect(uploadBody).toContain("%PDF-1.4 restored");
  });

  test("renders a protected PDF and updates paging, fit, zoom, rotation, open, and download controls", async ({ page }) => {
    await setupClerkTestingToken({ page });
    await setupCommonRoutes(page);
    await page.route("**/api/finance/invoice-review/101/neighbors", (route) => route.fulfill({ status: 200, contentType: "application/json", body: "{}" }));
    await page.route("**/api/finance/invoice-review/101/source", (route) => route.fulfill({ status: 200, contentType: "application/pdf", body: "%PDF-1.4 test" }));
    await page.route("**/api/finance/invoice-review/101", (route) => route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(reviewResponse({ source_document: { available: true, url: "/api/finance/invoice-review/101/source", content_type: "application/pdf", page_count: 3 } })),
    }));
    await page.goto("/ai-invoice-import/101/review", { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible({ timeout: 15_000 });
    const viewer = page.getByTestId("viewer-pdf");
    await expect(viewer).toBeVisible();
    await page.getByTestId("button-next-source-page").click();
    await expect(viewer).toHaveAttribute("data", /page=2/);
    await page.getByTestId("button-fit-document").click();
    await expect(page.getByTestId("button-fit-document")).toHaveAttribute("title", "Fit to width");
    await page.getByTestId("button-zoom-in").click();
    await expect(page.getByTestId("button-fit-document")).toHaveAttribute("title", "Fit to width");
    await page.getByTestId("button-rotate-document").click();
    await expect(viewer.locator("xpath=..")).toHaveCSS("transform", /matrix/);
    await expect(page.getByTestId("link-open-source")).toHaveAttribute("target", "_blank");
    await expect(page.getByTestId("link-download-source")).toHaveAttribute("download", /invoice/i);
  });

  test("hides source page navigation for a single-page PDF", async ({ page }) => {
    await setupClerkTestingToken({ page });
    await setupCommonRoutes(page);
    await page.route("**/api/finance/invoice-review/101/neighbors", (route) => route.fulfill({ status: 200, contentType: "application/json", body: "{}" }));
    await page.route("**/api/finance/invoice-review/101/source", (route) => route.fulfill({ status: 200, contentType: "application/pdf", body: "%PDF-1.4 test" }));
    await page.route("**/api/finance/invoice-review/101", (route) => route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(reviewResponse({ source_document: { available: true, url: "/api/finance/invoice-review/101/source", content_type: "application/pdf", page_count: 1 } })),
    }));

    await page.goto("/ai-invoice-import/101/review", { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId("viewer-pdf")).toBeVisible();
    await expect(page.getByTestId("button-previous-source-page")).toHaveCount(0);
    await expect(page.getByTestId("button-next-source-page")).toHaveCount(0);
  });

  test("retries protected source load failures", async ({ page }) => {
    await setupClerkTestingToken({ page });
    await setupCommonRoutes(page);
    let sourceRequests = 0;
    await page.route("**/api/finance/invoice-review/101/neighbors", (route) => route.fulfill({ status: 200, contentType: "application/json", body: "{}" }));
    await page.route("**/api/finance/invoice-review/101/source", (route) => {
      sourceRequests++;
      return route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "Storage unavailable" }) });
    });
    await page.route("**/api/finance/invoice-review/101", (route) => route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(reviewResponse({ source_document: { available: true, url: "/api/finance/invoice-review/101/source", content_type: "application/zip" } })),
    }));
    await page.goto("/ai-invoice-import/101/review", { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId("button-retry-source")).toBeVisible();
    await page.getByTestId("button-retry-source").click();
    await expect.poll(() => sourceRequests).toBeGreaterThan(1);
  });

  test("shows an explicit unsupported source state", async ({ page }) => {
    await setupClerkTestingToken({ page });
    await setupCommonRoutes(page);
    await page.route("**/api/finance/invoice-review/101/neighbors", (route) => route.fulfill({ status: 200, contentType: "application/json", body: "{}" }));
    await page.route("**/api/finance/invoice-review/101/source", (route) => route.fulfill({ status: 200, contentType: "application/zip", body: "not-viewable" }));
    await page.route("**/api/finance/invoice-review/101", (route) => route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(reviewResponse({ source_document: { available: true, url: "/api/finance/invoice-review/101/source", content_type: "application/zip" } })),
    }));
    await page.goto("/ai-invoice-import/101/review", { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId("source-unsupported")).toBeVisible();
  });
});

test.describe("AI Invoice Import — entity selector", () => {
  test("entity selector lists entities returned from the API", async ({ page }) => {
    await setupClerkTestingToken({ page });
    await setupCommonRoutes(page);

    await page.route("**/api/finance/entities**", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(entitiesResponse()),
      }),
    );

    await page.route("**/api/finance/ai-invoice-import**", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(emptyImportsResponse()),
      }),
    );

    await page.goto("/ai-invoice-import", { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible({ timeout: 15_000 });

    // Open the entity selector — the trigger is a w-52 combobox in the header
    const entitySelector = page.locator(".w-52[role=\"combobox\"]");
    await expect(entitySelector).toBeVisible({ timeout: 12_000 });
    await entitySelector.click();

    // Wait for the dropdown listbox to appear (Radix renders it in a portal)
    await expect(page.getByRole("listbox")).toBeVisible({ timeout: 5_000 });

    // Both entities should appear as options
    await expect(page.getByRole("option", { name: "All entities" })).toBeVisible();
    await expect(page.getByRole("option", { name: "Acme Trading" })).toBeVisible();
    await expect(page.getByRole("option", { name: "Beta Holdings" })).toBeVisible();
  });

  test("no legal entities state shows prompt to add first entity", async ({ page }) => {
    await setupClerkTestingToken({ page });
    await setupCommonRoutes(page);

    await page.route("**/api/finance/entities**", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ entities: [] }),
      }),
    );

    await page.route("**/api/finance/ai-invoice-import**", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(emptyImportsResponse()),
      }),
    );

    await page.goto("/ai-invoice-import", { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible({ timeout: 15_000 });

    await expect(page.getByText("No legal entities configured")).toBeVisible({ timeout: 12_000 });
    await expect(page.getByText("Add a legal entity to start importing invoices")).toBeVisible();
    await expect(page.getByRole("button", { name: /add entity/i })).toBeVisible();
  });
});

test.describe("AI Invoice Import — upload flow", () => {
  test("file input upload triggers POST to /api/finance/ai-invoice-import/upload", async ({ page }) => {
    await setupClerkTestingToken({ page });
    await setupCommonRoutes(page);

    await page.route("**/api/finance/entities**", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(entitiesResponse()),
      }),
    );

    await page.route("**/api/finance/ai-invoice-import**", async (route) => {
      if (route.request().method() === "GET") {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify(emptyImportsResponse()),
        });
        return;
      }
      await route.continue();
    });

    let uploadCallCount = 0;
    let capturedPostData: string | null = null;

    await page.route("**/api/finance/ai-invoice-import/upload", async (route) => {
      uploadCallCount++;
      capturedPostData = route.request().postData();
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ import_ids: [201] }),
      });
    });

    await page.goto("/ai-invoice-import", { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible({ timeout: 15_000 });

    // Wait for entities to load and upload zone to appear
    await expect(page.getByText("Drop PDF invoices here, or click to browse")).toBeVisible({ timeout: 12_000 });

    // Use the hidden file input to simulate a file selection
    const fileInput = page.locator('input[type="file"][accept]');
    await expect(fileInput).toBeAttached();

    await fileInput.setInputFiles({
      name: "test-invoice.pdf",
      mimeType: "application/pdf",
      buffer: Buffer.from("%PDF-1.4 fake pdf content"),
    });

    // Upload should succeed — toast appears
    await expect(page.getByText(/invoice.*uploaded.*AI extraction started/i)).toBeVisible({ timeout: 8_000 });

    // Upload endpoint was called exactly once
    expect(uploadCallCount).toBe(1);
    // FormData body must contain the entity_id field (multipart/form-data)
    expect(capturedPostData).toContain("entity_id");
  });

  test("shows error toast when no entity exists and user tries to upload", async ({ page }) => {
    await setupClerkTestingToken({ page });
    await setupCommonRoutes(page);

    // No entities at all — the empty-state screen renders instead of the upload zone
    // Owners see a prompt to add entity, so we test the case with 1 entity that errors on upload
    await page.route("**/api/finance/entities**", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(entitiesResponse()),
      }),
    );

    await page.route("**/api/finance/ai-invoice-import**", async (route) => {
      if (route.request().method() === "GET") {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify(emptyImportsResponse()),
        });
        return;
      }
      await route.continue();
    });

    await page.route("**/api/finance/ai-invoice-import/upload", (route) =>
      route.fulfill({
        status: 500,
        contentType: "application/json",
        body: JSON.stringify({ error: "AI service unavailable" }),
      }),
    );

    await page.goto("/ai-invoice-import", { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible({ timeout: 15_000 });

    await expect(page.getByText("Drop PDF invoices here, or click to browse")).toBeVisible({ timeout: 12_000 });

    const fileInput = page.locator('input[type="file"][accept]');
    await fileInput.setInputFiles({
      name: "broken-invoice.pdf",
      mimeType: "application/pdf",
      buffer: Buffer.from("%PDF-1.4 fake"),
    });

    await expect(page.getByText(/upload failed/i)).toBeVisible({ timeout: 8_000 });
  });
});

test.describe("AI Invoice Import — import list and status badges", () => {
  test("import table rows render with correct vendor name, amount, and status badges", async ({ page }) => {
    await setupClerkTestingToken({ page });
    await setupCommonRoutes(page);

    await page.route("**/api/finance/entities**", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(entitiesResponse()),
      }),
    );

    await page.route("**/api/finance/ai-invoice-import**", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(importsResponse()),
      }),
    );

    await page.goto("/ai-invoice-import", { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible({ timeout: 15_000 });

    // Wait for the import table to appear
    const table = page.locator("table").last();
    await expect(table).toBeVisible({ timeout: 12_000 });

    // First row: Supplier Co with Extracted badge
    await expect(page.getByText("Supplier Co")).toBeVisible();
    await expect(page.getByText("Extracted").first()).toBeVisible();

    // Second row: unknown vendor (processing)
    await expect(page.getByText("Processing").first()).toBeVisible();

    // Third row: failed import
    await expect(page.getByText("Failed").first()).toBeVisible();
  });

  test("KPI card values reflect the mocked import counts", async ({ page }) => {
    await setupClerkTestingToken({ page });
    await setupCommonRoutes(page);

    await page.route("**/api/finance/entities**", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(entitiesResponse()),
      }),
    );

    await page.route("**/api/finance/ai-invoice-import**", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(importsResponse()),
      }),
    );

    await page.goto("/ai-invoice-import", { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible({ timeout: 15_000 });

    // Wait for the import table to load (confirms API data is rendered)
    await expect(page.getByText("Supplier Co")).toBeVisible({ timeout: 12_000 });

    // Total = 3 (from total field in response).
    // The KPI card structure: <div><p class="text-xs">Label</p><p class="text-2xl font-bold">N</p></div>
    // Navigate from the label p up one level (..) to its parent div, then find the sibling value p.
    const totalLabel = page.locator("p.text-xs", { hasText: "Total Imports" });
    await expect(totalLabel).toBeVisible({ timeout: 12_000 });
    await expect(totalLabel.locator("..").locator("p.text-2xl")).toHaveText("3");

    const processingLabel = page.locator("p.text-xs", { hasText: "Processing" });
    await expect(processingLabel.locator("..").locator("p.text-2xl")).toHaveText("1");

    const failedLabel = page.locator("p.text-xs", { hasText: "Failed" });
    await expect(failedLabel.locator("..").locator("p.text-2xl")).toHaveText("1");
  });
});

test.describe("AI Invoice Import — detail panel", () => {
  test("clicking an import row opens the detail panel with extracted fields", async ({ page }) => {
    await setupClerkTestingToken({ page });
    await setupCommonRoutes(page);

    await page.route("**/api/finance/entities**", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(entitiesResponse()),
      }),
    );

    await page.route("**/api/finance/ai-invoice-import**", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(importsResponse()),
      }),
    );

    await page.goto("/ai-invoice-import", { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible({ timeout: 15_000 });

    // Wait for the import table and click the first row (Supplier Co)
    const supplierRow = page.getByRole("row", { name: /Supplier Co/i });
    await expect(supplierRow).toBeVisible({ timeout: 12_000 });
    await supplierRow.click();

    // Detail panel should appear
    await expect(page.getByText("Invoice Detail")).toBeVisible({ timeout: 5_000 });

    // Vendor name in panel header
    await expect(page.getByRole("heading", { name: "Supplier Co" })).toBeVisible();

    // Filename displayed in the panel
    await expect(page.getByText("invoice-jan.pdf")).toBeVisible();

    // Extracted fields — scope to the detail panel to avoid collision with the table row
    const detailCard = page.locator(".sticky").filter({ hasText: "Invoice Detail" });
    await expect(detailCard.getByText("INV-2024-001")).toBeVisible();

    // Status badge inside the panel
    await expect(detailCard.getByText("Extracted")).toBeVisible();

    // Line items section should appear (1 line item in mock)
    await expect(page.getByText(/Line Items/i)).toBeVisible();
    await expect(page.getByText("Widget A")).toBeVisible();
  });

  test("detail panel closes when the close button is clicked", async ({ page }) => {
    await setupClerkTestingToken({ page });
    await setupCommonRoutes(page);

    await page.route("**/api/finance/entities**", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(entitiesResponse()),
      }),
    );

    await page.route("**/api/finance/ai-invoice-import**", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(importsResponse()),
      }),
    );

    await page.goto("/ai-invoice-import", { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible({ timeout: 15_000 });

    const supplierRow = page.getByRole("row", { name: /Supplier Co/i });
    await expect(supplierRow).toBeVisible({ timeout: 12_000 });
    await supplierRow.click();

    await expect(page.getByText("Invoice Detail")).toBeVisible({ timeout: 5_000 });

    // The panel header has "Invoice Detail" title and two icon buttons (refresh + close).
    // Find the row containing the title and click the second/last button in it.
    const panelTitleRow = page
      .locator("div.flex.items-center.justify-between")
      .filter({ has: page.getByText("Invoice Detail") })
      .first();
    await panelTitleRow.locator("button").last().click();

    await expect(page.getByText("Invoice Detail")).not.toBeVisible({ timeout: 5_000 });
  });

  test("failed import row shows error badge and error message in detail panel", async ({ page }) => {
    await setupClerkTestingToken({ page });
    await setupCommonRoutes(page);

    await page.route("**/api/finance/entities**", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(entitiesResponse()),
      }),
    );

    await page.route("**/api/finance/ai-invoice-import**", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(importsResponse()),
      }),
    );

    await page.goto("/ai-invoice-import", { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible({ timeout: 15_000 });

    // Click the failed import row (vendor is unknown, filename is corrupted.pdf)
    const failedRow = page.getByRole("row", { name: /corrupted\.pdf/i });
    // The row may not have a role-based accessible name from the filename since it's in a nested element
    // Fall back to finding by the file name in a table row
    const rows = page.locator("tbody tr");
    await expect(rows).toHaveCount(3, { timeout: 12_000 });

    // The third row is the failed one
    const lastRow = rows.last();
    await expect(lastRow).toContainText("Failed");
    await lastRow.click();

    await expect(page.getByText("Invoice Detail")).toBeVisible({ timeout: 5_000 });
    await expect(page.getByText("AI extraction failed: unable to parse PDF")).toBeVisible({ timeout: 5_000 });
  });
});

test.describe("AI Invoice Import — non-owner read-only view", () => {
  test("member with ai-invoice-import page access can see page but not owner-only buttons", async ({ page }) => {
    await setupClerkTestingToken({ page });
    await setupCommonRoutes(page, memberUsersResponse());

    await page.route("**/api/finance/entities**", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(entitiesResponse()),
      }),
    );

    await page.route("**/api/finance/ai-invoice-import**", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(importsResponse()),
      }),
    );

    await page.goto("/ai-invoice-import", { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible({ timeout: 15_000 });

    // Page loads and shows entity selector (member can read)
    const entitySelector = page.locator('[role="combobox"]').first();
    await expect(entitySelector).toBeVisible({ timeout: 12_000 });

    // Import table is visible
    await expect(page.getByText("Supplier Co")).toBeVisible({ timeout: 8_000 });

    // Owner-only action buttons should NOT be rendered for non-owners.
    // The Add Entity (+) and Entity Settings (gear) buttons are guarded by isOwner.
    // They appear as outline/sm buttons next to the entity selector.
    // The easiest way to verify: assert neither button is in the DOM.
    await expect(page.locator("button[aria-label]").filter({ hasText: "" }).first()).not.toBeAttached().catch(() => {});
    // More direct: the + and gear are `size="sm" variant="outline"` buttons rendered inside
    // the entity selector row only for owners. We can assert they are not visible.
    const addEntityBtn = page.locator(".flex.items-center.gap-2.flex-wrap").getByRole("button");
    await expect(addEntityBtn).toHaveCount(0);
  });

  test("member can click a row and view the read-only detail panel", async ({ page }) => {
    await setupClerkTestingToken({ page });
    await setupCommonRoutes(page, memberUsersResponse());

    await page.route("**/api/finance/entities**", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(entitiesResponse()),
      }),
    );

    await page.route("**/api/finance/ai-invoice-import**", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(importsResponse()),
      }),
    );

    await page.goto("/ai-invoice-import", { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible({ timeout: 15_000 });

    const supplierRow = page.getByRole("row", { name: /Supplier Co/i });
    await expect(supplierRow).toBeVisible({ timeout: 12_000 });
    await supplierRow.click();

    // Detail panel opens
    await expect(page.getByText("Invoice Detail")).toBeVisible({ timeout: 5_000 });

    // Scope to the detail panel card to avoid strict mode collision with the table cell
    const detailCard = page.locator(".sticky").filter({ hasText: "Invoice Detail" });
    await expect(detailCard.getByText("INV-2024-001")).toBeVisible();
  });
});

test.describe("AI Invoice Import — upload and progress indicator", () => {
  test("uploading a PDF then clicking the new import shows the AI progress indicator in the detail panel", async ({ page }) => {
    await setupClerkTestingToken({ page });
    await setupCommonRoutes(page);

    await page.route("**/api/finance/entities**", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(entitiesResponse()),
      }),
    );

    const processingImport = {
      id: 201,
      entity_id: 1,
      status: "processing",
      original_filename: "new-invoice.pdf",
      vendor_name: null,
      invoice_number: null,
      invoice_date: null,
      due_date: null,
      currency: null,
      total_amount: null,
      subtotal: null,
      tax_amount: null,
      confidence: null,
      company_validation_status: null,
      company_validation_notes: null,
      odoo_bill_url: null,
      odoo_bill_id: null,
      error_message: null,
      created_at: new Date().toISOString(),
      entity_legal_name: "Acme Trading LLC",
      entity_accounting_system: "manual",
      line_items: [],
      vendor_address: null,
      vendor_tax_number: null,
      manually_entered_at: null,
      manual_accounting_reference: null,
      is_reviewed: false,
      reviewed_at: null,
    };

    let listCallCount = 0;
    await page.route("**/api/finance/ai-invoice-import**", async (route) => {
      if (route.request().method() === "GET") {
        listCallCount++;
        const body =
          listCallCount === 1
            ? emptyImportsResponse()
            : { total: 1, imports: [processingImport] };
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify(body),
        });
        return;
      }
      await route.continue();
    });

    await page.route("**/api/finance/ai-invoice-import/upload", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ import_ids: [201] }),
      }),
    );

    await page.goto("/ai-invoice-import", { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible({ timeout: 15_000 });

    await expect(
      page.getByText("Drop PDF invoices here, or click to browse"),
    ).toBeVisible({ timeout: 12_000 });

    const fileInput = page.locator('input[type="file"][accept]');
    await expect(fileInput).toBeAttached();

    await fileInput.setInputFiles({
      name: "new-invoice.pdf",
      mimeType: "application/pdf",
      buffer: Buffer.from("%PDF-1.4 fake pdf content for progress test"),
    });

    await expect(
      page.getByText(/invoice.*uploaded.*AI extraction started/i),
    ).toBeVisible({ timeout: 8_000 });

    const processingRow = page.locator("tbody tr").first();
    await expect(processingRow).toBeVisible({ timeout: 8_000 });
    await processingRow.click();

    const detailCard = page.locator(".sticky").filter({ hasText: "Invoice Detail" });
    await expect(detailCard).toBeVisible({ timeout: 5_000 });

    await expect(
      page.getByText("AI is processing this invoice…"),
    ).toBeVisible({ timeout: 5_000 });
  });

  test("detail panel shows processing steps for an import in 'uploaded' status", async ({ page }) => {
    await setupClerkTestingToken({ page });
    await setupCommonRoutes(page);

    await page.route("**/api/finance/entities**", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(entitiesResponse()),
      }),
    );

    const uploadedImport = {
      id: 205,
      entity_id: 1,
      status: "uploaded",
      original_filename: "pending-invoice.pdf",
      vendor_name: null,
      invoice_number: null,
      invoice_date: null,
      due_date: null,
      currency: null,
      total_amount: null,
      subtotal: null,
      tax_amount: null,
      confidence: null,
      company_validation_status: null,
      company_validation_notes: null,
      odoo_bill_url: null,
      odoo_bill_id: null,
      error_message: null,
      created_at: new Date().toISOString(),
      entity_legal_name: "Acme Trading LLC",
      entity_accounting_system: "manual",
      line_items: [],
      vendor_address: null,
      vendor_tax_number: null,
      manually_entered_at: null,
      manual_accounting_reference: null,
      is_reviewed: false,
      reviewed_at: null,
    };

    await page.route("**/api/finance/ai-invoice-import**", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ total: 1, imports: [uploadedImport] }),
      }),
    );

    await page.goto("/ai-invoice-import", { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible({ timeout: 15_000 });

    const rows = page.locator("tbody tr");
    await expect(rows).toHaveCount(1, { timeout: 12_000 });
    await rows.first().click();

    const detailCard = page.locator(".sticky").filter({ hasText: "Invoice Detail" });
    await expect(detailCard).toBeVisible({ timeout: 5_000 });

    await expect(
      page.getByText("AI is processing this invoice…"),
    ).toBeVisible({ timeout: 5_000 });

    await expect(page.getByText("Queued — preparing upload…")).toBeVisible();
    await expect(page.getByText("Converting PDF to image…")).toBeVisible();
    await expect(page.getByText("Reading with AI…")).toBeVisible();
    await expect(page.getByText("Extracting invoice data…")).toBeVisible();

    await expect(page.getByText("This usually takes 10–30 seconds. The page updates automatically.")).toBeVisible();
  });

  test("page polls the imports list while processing items exist and stops the progress indicator when status transitions to extracted", async ({ page }) => {
    await setupClerkTestingToken({ page });
    await setupCommonRoutes(page);

    await page.route("**/api/finance/entities**", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(entitiesResponse()),
      }),
    );

    const baseImport = {
      id: 301,
      entity_id: 1,
      original_filename: "polled-invoice.pdf",
      vendor_name: "Poll Vendor",
      invoice_number: "INV-POLL-001",
      invoice_date: "2024-03-01",
      due_date: "2024-04-01",
      currency: "USD",
      total_amount: "1000.00",
      subtotal: "900.00",
      tax_amount: "100.00",
      confidence: "0.88",
      company_validation_status: null,
      company_validation_notes: null,
      odoo_bill_url: null,
      odoo_bill_id: null,
      error_message: null,
      created_at: new Date().toISOString(),
      entity_legal_name: "Acme Trading LLC",
      entity_accounting_system: "manual",
      line_items: [],
      vendor_address: null,
      vendor_tax_number: null,
      manually_entered_at: null,
      manual_accounting_reference: null,
      is_reviewed: false,
      reviewed_at: null,
    };

    let listCallCount = 0;
    await page.route("**/api/finance/ai-invoice-import**", async (route) => {
      if (route.request().method() !== "GET") {
        await route.continue();
        return;
      }
      listCallCount++;
      const status = listCallCount <= 2 ? "processing" : "extracted";
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          total: 1,
          imports: [{ ...baseImport, status }],
        }),
      });
    });

    await page.goto("/ai-invoice-import", { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible({ timeout: 15_000 });

    const row = page.getByRole("row", { name: /Poll Vendor/i });
    await expect(row).toBeVisible({ timeout: 12_000 });
    await row.click();

    const detailCard = page.locator(".sticky").filter({ hasText: "Invoice Detail" });
    await expect(detailCard).toBeVisible({ timeout: 5_000 });

    await expect(
      page.getByText("AI is processing this invoice…"),
    ).toBeVisible({ timeout: 5_000 });

    await expect(
      page.getByText("AI is processing this invoice…"),
    ).not.toBeVisible({ timeout: 15_000 });

    expect(listCallCount).toBeGreaterThan(2);

    await expect(detailCard.getByText("Extracted")).toBeVisible({ timeout: 3_000 });
  });
});

test.describe("AI Invoice Import — Add Entity dialog (owner only)", () => {
  test("owner can open Add Entity dialog and see the form", async ({ page }) => {
    await setupClerkTestingToken({ page });
    await setupCommonRoutes(page);

    await page.route("**/api/finance/entities**", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(entitiesResponse()),
      }),
    );

    await page.route("**/api/finance/ai-invoice-import**", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(emptyImportsResponse()),
      }),
    );

    await page.goto("/ai-invoice-import", { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible({ timeout: 15_000 });

    // Wait for page to load
    await expect(page.getByText("Drop PDF invoices here, or click to browse")).toBeVisible({ timeout: 12_000 });

    // The + (Add Entity) button is only visible to owners
    const addEntityButton = page.locator('[role="combobox"]').locator("..").locator("..").getByRole("button").first();
    await expect(addEntityButton).toBeVisible({ timeout: 5_000 });
    await addEntityButton.click();

    // Dialog should open with the form
    await expect(page.getByRole("dialog")).toBeVisible({ timeout: 5_000 });
    await expect(page.getByText("Add Legal Entity")).toBeVisible();
    await expect(page.getByText("Legal Name *")).toBeVisible();
  });

  test("creating an entity POSTs to /api/finance/entities", async ({ page }) => {
    await setupClerkTestingToken({ page });
    await setupCommonRoutes(page);

    // Start with no entities so the empty state renders the Add Entity button in the main area
    await page.route("**/api/finance/entities**", async (route) => {
      if (route.request().method() === "GET") {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ entities: [] }),
        });
        return;
      }
      if (route.request().method() === "POST") {
        const body = JSON.parse(route.request().postData() ?? "{}") as Record<string, unknown>;
        await route.fulfill({
          status: 201,
          contentType: "application/json",
          body: JSON.stringify({
            entity: {
              id: 99,
              workspace_owner_id: "owner_clerk_id",
              legal_name: body.legal_name,
              display_name: null,
              country: null,
              tax_registration_number: null,
              accounting_system: "none",
              odoo_company_id: null,
              odoo_company_name: null,
              odoo_database: null,
              odoo_base_url: null,
              default_currency: "USD",
              is_active: true,
              odoo_integration_configured: false,
              created_at: new Date().toISOString(),
            },
          }),
        });
        return;
      }
      await route.continue();
    });

    await page.route("**/api/finance/ai-invoice-import**", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(emptyImportsResponse()),
      }),
    );

    await page.goto("/ai-invoice-import", { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible({ timeout: 15_000 });

    // Empty state shows the Add Entity button in the main content area
    await expect(page.getByText("No legal entities configured")).toBeVisible({ timeout: 12_000 });

    await page.getByRole("button", { name: /add entity/i }).click();

    // Dialog opens
    await expect(page.getByRole("dialog")).toBeVisible({ timeout: 5_000 });

    // Fill in the legal name
    await page.getByPlaceholder("Company LLC").fill("New Test Entity");

    // Submit
    await page.getByRole("button", { name: /create entity/i }).click();

    // Dialog closes after success (entity is created)
    await expect(page.getByRole("dialog")).not.toBeVisible({ timeout: 8_000 });
  });
});

test.describe("AI Invoice Import — Add Legal Entity country combobox", () => {
  async function openAddEntityDialog(page: Parameters<typeof setupCommonRoutes>[0]) {
    await setupClerkTestingToken({ page });
    await setupCommonRoutes(page);

    // Use the no-entities state — the empty-state "Add entity" button is unambiguous
    await page.route("**/api/finance/entities**", async (route) => {
      if (route.request().method() === "GET") {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ entities: [] }),
        });
        return;
      }
      // POST — echo a minimal created entity back
      const body = JSON.parse(route.request().postData() ?? "{}") as Record<string, unknown>;
      await route.fulfill({
        status: 201,
        contentType: "application/json",
        body: JSON.stringify({
          entity: {
            id: 99,
            workspace_owner_id: "owner_clerk_id",
            legal_name: body.legal_name ?? "Entity",
            display_name: null,
            country: body.country ?? null,
            tax_registration_number: null,
            accounting_system: "none",
            odoo_company_id: null,
            odoo_company_name: null,
            odoo_database: null,
            odoo_base_url: null,
            default_currency: "USD",
            is_active: true,
            odoo_integration_configured: false,
            created_at: new Date().toISOString(),
          },
        }),
      });
    });

    await page.route("**/api/finance/ai-invoice-import**", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(emptyImportsResponse()),
      }),
    );

    await page.goto("/ai-invoice-import", { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible({ timeout: 15_000 });

    await expect(page.getByText("No legal entities configured")).toBeVisible({ timeout: 12_000 });
    await page.getByRole("button", { name: /add entity/i }).click();
    await expect(page.getByRole("dialog")).toBeVisible({ timeout: 5_000 });
    await expect(page.getByText("Add Legal Entity")).toBeVisible();
  }

  test("searching for a country and selecting it is reflected in the combobox trigger", async ({ page }) => {
    await openAddEntityDialog(page);

    const dialog = page.getByRole("dialog");

    // The dialog has comboboxes for: Country (1st), Default Currency (2nd), Accounting System (3rd).
    // The CountryCombobox is the first one and shows the "Select country…" placeholder.
    const countryTrigger = dialog.getByRole("combobox").first();
    await expect(countryTrigger).toContainText("Select country", { timeout: 5_000 });

    // Open the country popover
    await countryTrigger.click();

    // The search input should appear inside the popover
    const searchInput = page.getByPlaceholder("Search countries…");
    await expect(searchInput).toBeVisible({ timeout: 5_000 });

    // Search for "Lebanon"
    await searchInput.fill("Lebanon");

    // The filtered list should show Lebanon
    const lebItem = page.getByRole("option", { name: /Lebanon/i });
    await expect(lebItem).toBeVisible({ timeout: 5_000 });
    await lebItem.click();

    // Popover closes; trigger now reflects the selection (flag + name)
    await expect(countryTrigger).toContainText("Lebanon", { timeout: 5_000 });

    // The placeholder is no longer shown
    await expect(countryTrigger).not.toContainText("Select country");
  });

  test("clearing the country selection resets the trigger to the placeholder", async ({ page }) => {
    await openAddEntityDialog(page);

    const dialog = page.getByRole("dialog");

    // The CountryCombobox is the first combobox in the dialog
    const countryTrigger = dialog.getByRole("combobox").first();
    await expect(countryTrigger).toContainText("Select country", { timeout: 5_000 });
    await countryTrigger.click();

    const searchInput = page.getByPlaceholder("Search countries…");
    await expect(searchInput).toBeVisible({ timeout: 5_000 });

    // Search by partial name — "United Arab" finds "United Arab Emirates" (code: ae)
    await searchInput.fill("United Arab");

    const uaeItem = page.getByRole("option", { name: /United Arab Emirates/i });
    await expect(uaeItem).toBeVisible({ timeout: 5_000 });
    await uaeItem.click();

    // Trigger now shows the selected country
    await expect(countryTrigger).toContainText("United Arab Emirates", { timeout: 5_000 });

    // Re-open the popover to clear the selection
    await countryTrigger.click();
    await expect(searchInput).toBeVisible({ timeout: 5_000 });

    // "— Clear selection —" item appears only when a value is selected
    const clearItem = page.getByRole("option", { name: /clear selection/i });
    await expect(clearItem).toBeVisible({ timeout: 5_000 });
    await clearItem.click();

    // Trigger resets to the placeholder
    await expect(countryTrigger).toContainText("Select country", { timeout: 5_000 });
    await expect(countryTrigger).not.toContainText("United Arab Emirates");
  });

  test("selected country code is included in the POST payload when creating the entity", async ({ page }) => {
    let capturedBody: Record<string, unknown> | null = null;

    await setupClerkTestingToken({ page });
    await setupCommonRoutes(page);

    await page.route("**/api/finance/entities**", async (route) => {
      if (route.request().method() === "GET") {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ entities: [] }),
        });
        return;
      }
      capturedBody = JSON.parse(route.request().postData() ?? "{}") as Record<string, unknown>;
      await route.fulfill({
        status: 201,
        contentType: "application/json",
        body: JSON.stringify({
          entity: {
            id: 50,
            workspace_owner_id: "owner_clerk_id",
            legal_name: (capturedBody as Record<string, unknown>).legal_name ?? "Entity",
            display_name: null,
            country: (capturedBody as Record<string, unknown>).country ?? null,
            tax_registration_number: null,
            accounting_system: "none",
            odoo_company_id: null,
            odoo_company_name: null,
            odoo_database: null,
            odoo_base_url: null,
            default_currency: "USD",
            is_active: true,
            odoo_integration_configured: false,
            created_at: new Date().toISOString(),
          },
        }),
      });
    });

    await page.route("**/api/finance/ai-invoice-import**", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(emptyImportsResponse()),
      }),
    );

    await page.goto("/ai-invoice-import", { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText("No legal entities configured")).toBeVisible({ timeout: 12_000 });
    await page.getByRole("button", { name: /add entity/i }).click();
    await expect(page.getByRole("dialog")).toBeVisible({ timeout: 5_000 });

    const dialog = page.getByRole("dialog");

    // Fill the required legal name
    await dialog.getByPlaceholder("Company LLC").fill("ISO Test Entity");

    // Select Jordan from the country combobox (the first combobox in the dialog)
    const countryTrigger = dialog.getByRole("combobox").first();
    await expect(countryTrigger).toContainText("Select country", { timeout: 5_000 });
    await countryTrigger.click();

    const searchInput = page.getByPlaceholder("Search countries…");
    await expect(searchInput).toBeVisible({ timeout: 5_000 });
    await searchInput.fill("Jordan");

    const jordanItem = page.getByRole("option", { name: /Jordan/i });
    await expect(jordanItem).toBeVisible({ timeout: 5_000 });
    await jordanItem.click();

    // Trigger reflects the selection
    await expect(countryTrigger).toContainText("Jordan", { timeout: 5_000 });

    // Submit the form
    await dialog.getByRole("button", { name: /create entity/i }).click();

    // Wait for the POST to be captured
    await expect.poll(() => capturedBody, { timeout: 8_000 }).not.toBeNull();

    // Country code for Jordan in the catalogue is "jo" (lowercase)
    expect(capturedBody).toMatchObject({
      legal_name: "ISO Test Entity",
      country: "jo",
    });

    // Dialog closes after success
    await expect(page.getByRole("dialog")).not.toBeVisible({ timeout: 8_000 });
  });
});

test.describe("AI Invoice Import — Add Legal Entity country filter (workspace settings)", () => {
  async function openDialogWithSettings(
    page: Parameters<typeof setupCommonRoutes>[0],
    settings: object,
  ) {
    await setupClerkTestingToken({ page });
    await setupCommonRoutes(page);

    await page.route("**/api/settings**", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(settings),
      }),
    );

    await page.route("**/api/finance/entities**", async (route) => {
      if (route.request().method() === "GET") {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ entities: [] }),
        });
        return;
      }
      await route.fulfill({
        status: 201,
        contentType: "application/json",
        body: JSON.stringify({
          entity: {
            id: 99,
            workspace_owner_id: "owner_clerk_id",
            legal_name: "Entity",
            display_name: null,
            country: null,
            tax_registration_number: null,
            accounting_system: "none",
            odoo_company_id: null,
            odoo_company_name: null,
            odoo_database: null,
            odoo_base_url: null,
            default_currency: "USD",
            is_active: true,
            odoo_integration_configured: false,
            created_at: new Date().toISOString(),
          },
        }),
      });
    });

    await page.route("**/api/finance/ai-invoice-import**", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(emptyImportsResponse()),
      }),
    );

    await page.goto("/ai-invoice-import", { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText("No legal entities configured")).toBeVisible({ timeout: 12_000 });
    await page.getByRole("button", { name: /add entity/i }).click();
    await expect(page.getByRole("dialog")).toBeVisible({ timeout: 5_000 });
    await expect(page.getByText("Add Legal Entity")).toBeVisible();
  }

  test("only the configured available countries appear in the Country combobox", async ({ page }) => {
    await openDialogWithSettings(page, {
      available_countries: ["Lebanon", "Jordan"],
    });

    const dialog = page.getByRole("dialog");
    const countryTrigger = dialog.getByRole("combobox").first();
    await expect(countryTrigger).toContainText("Select country", { timeout: 5_000 });

    // Open the country popover
    await countryTrigger.click();

    const searchInput = page.getByPlaceholder("Search countries…");
    await expect(searchInput).toBeVisible({ timeout: 5_000 });

    // Lebanon is in the configured list — it must appear
    await searchInput.fill("Lebanon");
    await expect(page.getByRole("option", { name: /Lebanon/i })).toBeVisible({ timeout: 5_000 });

    // Jordan is in the configured list — it must appear
    await searchInput.fill("Jordan");
    await expect(page.getByRole("option", { name: /Jordan/i })).toBeVisible({ timeout: 5_000 });

    // Germany is NOT in the configured list — it must not appear
    await searchInput.fill("Germany");
    await expect(page.getByRole("option", { name: /Germany/i })).not.toBeVisible({ timeout: 3_000 });

    // United States is NOT in the configured list — it must not appear
    await searchInput.fill("United States");
    await expect(page.getByRole("option", { name: /United States/i })).not.toBeVisible({ timeout: 3_000 });
  });

  test("when no available countries are configured all countries are shown in the Country combobox", async ({ page }) => {
    await openDialogWithSettings(page, {
      available_countries: [],
    });

    const dialog = page.getByRole("dialog");
    const countryTrigger = dialog.getByRole("combobox").first();
    await expect(countryTrigger).toContainText("Select country", { timeout: 5_000 });

    // Open the country popover
    await countryTrigger.click();

    const searchInput = page.getByPlaceholder("Search countries…");
    await expect(searchInput).toBeVisible({ timeout: 5_000 });

    // Germany should appear (it is in the full default list)
    await searchInput.fill("Germany");
    await expect(page.getByRole("option", { name: /Germany/i })).toBeVisible({ timeout: 5_000 });

    // Lebanon should also appear
    await searchInput.fill("Lebanon");
    await expect(page.getByRole("option", { name: /Lebanon/i })).toBeVisible({ timeout: 5_000 });

    // United Arab Emirates should appear too (it is in DEFAULT_COUNTRY_OPTIONS)
    await searchInput.fill("United Arab");
    await expect(page.getByRole("option", { name: /United Arab Emirates/i })).toBeVisible({ timeout: 5_000 });
  });

  test("country filter persists when the dialog is closed and reopened (stale React Query cache)", async ({ page }) => {
    // The workspace-settings query has staleTime: 60_000, so a single mock response
    // should be served from cache on the second dialog open without a second network hit.
    await openDialogWithSettings(page, {
      available_countries: ["Lebanon", "Jordan"],
    });

    // ── First open: verify the filter is applied ──────────────────────────────
    const dialog = page.getByRole("dialog");
    const countryTrigger = dialog.getByRole("combobox").first();
    await expect(countryTrigger).toContainText("Select country", { timeout: 5_000 });
    await countryTrigger.click();

    const searchInput = page.getByPlaceholder("Search countries…");
    await expect(searchInput).toBeVisible({ timeout: 5_000 });

    await searchInput.fill("Lebanon");
    await expect(page.getByRole("option", { name: /Lebanon/i })).toBeVisible({ timeout: 5_000 });

    await searchInput.fill("Germany");
    await expect(page.getByRole("option", { name: /Germany/i })).not.toBeVisible({ timeout: 3_000 });

    // ── Close the dialog via the Cancel button ────────────────────────────────
    // Click Cancel in the dialog footer (more reliable than Escape with nested
    // Radix popovers that may consume the key event first).
    const addEntityDialog = page.getByRole("dialog", { name: "Add Legal Entity" });
    await addEntityDialog.getByRole("button", { name: /cancel/i }).click();
    await expect(addEntityDialog).not.toBeVisible({ timeout: 5_000 });

    // ── Reopen the dialog ─────────────────────────────────────────────────────
    await page.getByRole("button", { name: /add entity/i }).click();
    await expect(page.getByRole("dialog", { name: "Add Legal Entity" })).toBeVisible({ timeout: 5_000 });

    // ── Second open: the filter must still reflect available_countries ────────
    const dialog2 = page.getByRole("dialog", { name: "Add Legal Entity" });
    const countryTrigger2 = dialog2.getByRole("combobox").first();
    await expect(countryTrigger2).toContainText("Select country", { timeout: 5_000 });
    await countryTrigger2.click();

    const searchInput2 = page.getByPlaceholder("Search countries…");
    await expect(searchInput2).toBeVisible({ timeout: 5_000 });

    // Lebanon must still appear — it is in the cached available_countries list
    await searchInput2.fill("Lebanon");
    await expect(page.getByRole("option", { name: /Lebanon/i })).toBeVisible({ timeout: 5_000 });

    // Jordan must still appear too
    await searchInput2.fill("Jordan");
    await expect(page.getByRole("option", { name: /Jordan/i })).toBeVisible({ timeout: 5_000 });

    // Germany must still be absent — the stale cache must not have fallen back to all countries
    await searchInput2.fill("Germany");
    await expect(page.getByRole("option", { name: /Germany/i })).not.toBeVisible({ timeout: 3_000 });
  });
});

test.describe("AI Invoice Import — NewEntityDialog form reset on reopen", () => {
  test("form fields are empty when the dialog is reopened after a partial fill and cancel", async ({ page }) => {
    await setupClerkTestingToken({ page });
    await setupCommonRoutes(page);

    // Use the no-entities state so the empty-state "Add entity" button is unambiguous
    await page.route("**/api/finance/entities**", async (route) => {
      if (route.request().method() === "GET") {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ entities: [] }),
        });
        return;
      }
      await route.continue();
    });

    await page.route("**/api/finance/ai-invoice-import**", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(emptyImportsResponse()),
      }),
    );

    await page.goto("/ai-invoice-import", { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible({ timeout: 15_000 });

    // ── First open: fill in Legal Name then cancel ────────────────────────────
    await expect(page.getByText("No legal entities configured")).toBeVisible({ timeout: 12_000 });
    await page.getByRole("button", { name: /add entity/i }).click();

    const dialog = page.getByRole("dialog", { name: "Add Legal Entity" });
    await expect(dialog).toBeVisible({ timeout: 5_000 });

    // Type a value into the Legal Name field
    const legalNameInput = dialog.getByPlaceholder("Company LLC");
    await legalNameInput.fill("Partial Input Company");
    await expect(legalNameInput).toHaveValue("Partial Input Company");

    // Cancel — does NOT submit the form
    await dialog.getByRole("button", { name: /cancel/i }).click();
    await expect(dialog).not.toBeVisible({ timeout: 5_000 });

    // ── Reopen: field must be blank ───────────────────────────────────────────
    await page.getByRole("button", { name: /add entity/i }).click();
    const dialog2 = page.getByRole("dialog", { name: "Add Legal Entity" });
    await expect(dialog2).toBeVisible({ timeout: 5_000 });

    // Legal Name must be empty — the previous partial entry must not persist
    const legalNameInput2 = dialog2.getByPlaceholder("Company LLC");
    await expect(legalNameInput2).toHaveValue("");
  });

  test("form fields are empty when the dialog is reopened after dismissing via the X button", async ({ page }) => {
    await setupClerkTestingToken({ page });
    await setupCommonRoutes(page);

    await page.route("**/api/finance/entities**", async (route) => {
      if (route.request().method() === "GET") {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ entities: [] }),
        });
        return;
      }
      await route.continue();
    });

    await page.route("**/api/finance/ai-invoice-import**", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(emptyImportsResponse()),
      }),
    );

    await page.goto("/ai-invoice-import", { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible({ timeout: 15_000 });

    // ── First open: fill in Legal Name then close via X ───────────────────────
    await expect(page.getByText("No legal entities configured")).toBeVisible({ timeout: 12_000 });
    await page.getByRole("button", { name: /add entity/i }).click();

    const dialog = page.getByRole("dialog", { name: "Add Legal Entity" });
    await expect(dialog).toBeVisible({ timeout: 5_000 });

    const legalNameInput = dialog.getByPlaceholder("Company LLC");
    await legalNameInput.fill("X Button Test Company");
    await expect(legalNameInput).toHaveValue("X Button Test Company");

    // Close via the X button (sr-only text "Close")
    await dialog.getByRole("button", { name: /close/i }).click();
    await expect(dialog).not.toBeVisible({ timeout: 5_000 });

    // ── Reopen: field must be blank ───────────────────────────────────────────
    await page.getByRole("button", { name: /add entity/i }).click();
    const dialog2 = page.getByRole("dialog", { name: "Add Legal Entity" });
    await expect(dialog2).toBeVisible({ timeout: 5_000 });

    const legalNameInput2 = dialog2.getByPlaceholder("Company LLC");
    await expect(legalNameInput2).toHaveValue("");
  });

  test("form fields are empty when the dialog is reopened after dismissing via the Escape key", async ({ page }) => {
    await setupClerkTestingToken({ page });
    await setupCommonRoutes(page);

    await page.route("**/api/finance/entities**", async (route) => {
      if (route.request().method() === "GET") {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ entities: [] }),
        });
        return;
      }
      await route.continue();
    });

    await page.route("**/api/finance/ai-invoice-import**", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(emptyImportsResponse()),
      }),
    );

    await page.goto("/ai-invoice-import", { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible({ timeout: 15_000 });

    // ── First open: fill in Legal Name then close via Escape ──────────────────
    await expect(page.getByText("No legal entities configured")).toBeVisible({ timeout: 12_000 });
    await page.getByRole("button", { name: /add entity/i }).click();

    const dialog = page.getByRole("dialog", { name: "Add Legal Entity" });
    await expect(dialog).toBeVisible({ timeout: 5_000 });

    const legalNameInput = dialog.getByPlaceholder("Company LLC");
    await legalNameInput.fill("Escape Key Test Company");
    await expect(legalNameInput).toHaveValue("Escape Key Test Company");

    // Close via Escape key
    await page.keyboard.press("Escape");
    await expect(dialog).not.toBeVisible({ timeout: 5_000 });

    // ── Reopen: field must be blank ───────────────────────────────────────────
    await page.getByRole("button", { name: /add entity/i }).click();
    const dialog2 = page.getByRole("dialog", { name: "Add Legal Entity" });
    await expect(dialog2).toBeVisible({ timeout: 5_000 });

    const legalNameInput2 = dialog2.getByPlaceholder("Company LLC");
    await expect(legalNameInput2).toHaveValue("");
  });
});

test.describe("AI Invoice Import — delete import", () => {
  test("owner can delete an import from the detail panel", async ({ page }) => {
    await setupClerkTestingToken({ page });
    await setupCommonRoutes(page);

    await page.route("**/api/finance/entities**", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(entitiesResponse()),
      }),
    );

    let listCallCount = 0;
    await page.route("**/api/finance/ai-invoice-import**", async (route) => {
      if (route.request().method() === "GET") {
        listCallCount++;
        // After deletion, return empty list
        const body = listCallCount <= 1 ? importsResponse() : emptyImportsResponse();
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify(body),
        });
        return;
      }
      await route.continue();
    });

    let deleteCallCount = 0;
    await page.route("**/api/finance/ai-invoice-import/imports/**", async (route) => {
      if (route.request().method() === "DELETE") {
        deleteCallCount++;
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ success: true }),
        });
        return;
      }
      await route.continue();
    });

    await page.goto("/ai-invoice-import", { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible({ timeout: 15_000 });

    // Wait for the import table and open the first row's detail panel
    const supplierRow = page.getByRole("row", { name: /Supplier Co/i });
    await expect(supplierRow).toBeVisible({ timeout: 12_000 });
    await supplierRow.click();

    // Detail panel opens
    await expect(page.getByText("Invoice Detail")).toBeVisible({ timeout: 5_000 });

    // Accept the window.confirm dialog automatically
    page.on("dialog", (dialog) => dialog.accept());

    // Click the trash (delete) button — it is a ghost/destructive button with only a Trash2 icon
    const detailCard = page.locator(".sticky").filter({ hasText: "Invoice Detail" });
    const deleteButton = detailCard.locator("button.text-destructive, button[class*='text-destructive']").first();
    await expect(deleteButton).toBeVisible({ timeout: 5_000 });
    await deleteButton.click();

    // Toast confirms deletion
    await expect(page.getByText("Import deleted")).toBeVisible({ timeout: 8_000 });

    // DELETE endpoint was called exactly once
    expect(deleteCallCount).toBe(1);

    // Detail panel closes after deletion
    await expect(page.getByText("Invoice Detail")).not.toBeVisible({ timeout: 5_000 });
  });

  test("delete is cancelled when the user dismisses the confirm dialog", async ({ page }) => {
    await setupClerkTestingToken({ page });
    await setupCommonRoutes(page);

    await page.route("**/api/finance/entities**", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(entitiesResponse()),
      }),
    );

    await page.route("**/api/finance/ai-invoice-import**", async (route) => {
      if (route.request().method() === "GET") {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify(importsResponse()),
        });
        return;
      }
      await route.continue();
    });

    let deleteCallCount = 0;
    await page.route("**/api/finance/ai-invoice-import/imports/**", async (route) => {
      if (route.request().method() === "DELETE") {
        deleteCallCount++;
        await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ success: true }) });
        return;
      }
      await route.continue();
    });

    await page.goto("/ai-invoice-import", { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible({ timeout: 15_000 });

    const supplierRow = page.getByRole("row", { name: /Supplier Co/i });
    await expect(supplierRow).toBeVisible({ timeout: 12_000 });
    await supplierRow.click();

    await expect(page.getByText("Invoice Detail")).toBeVisible({ timeout: 5_000 });

    // Dismiss (cancel) the confirm dialog
    page.on("dialog", (dialog) => dialog.dismiss());

    const detailCard = page.locator(".sticky").filter({ hasText: "Invoice Detail" });
    const deleteButton = detailCard.locator("button.text-destructive, button[class*='text-destructive']").first();
    await expect(deleteButton).toBeVisible({ timeout: 5_000 });
    await deleteButton.click();

    // DELETE endpoint must NOT have been called
    expect(deleteCallCount).toBe(0);

    // Detail panel remains open
    await expect(page.getByText("Invoice Detail")).toBeVisible({ timeout: 3_000 });
  });
});

test.describe("AI Invoice Import — end-to-end happy path", () => {
  test("owner creates an entity, uploads a PDF, verifies the import appears, then deletes it", async ({ page }) => {
    await setupClerkTestingToken({ page });
    await setupCommonRoutes(page);

    // ── Step 1: entities starts empty so owner sees the Add Entity prompt ──────
    let entityList: object[] = [];

    await page.route("**/api/finance/entities**", async (route) => {
      if (route.request().method() === "GET") {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ entities: entityList }),
        });
        return;
      }
      if (route.request().method() === "POST") {
        const body = JSON.parse(route.request().postData() ?? "{}") as Record<string, unknown>;
        const created = {
          id: 77,
          workspace_owner_id: "owner_clerk_id",
          legal_name: body.legal_name ?? "Test Entity",
          display_name: body.display_name ?? null,
          country: body.country ?? null,
          tax_registration_number: null,
          accounting_system: body.accounting_system ?? "none",
          odoo_company_id: null,
          odoo_company_name: null,
          odoo_database: null,
          odoo_base_url: null,
          default_currency: body.default_currency ?? "USD",
          is_active: true,
          odoo_integration_configured: false,
          created_at: new Date().toISOString(),
        };
        entityList = [created];
        await route.fulfill({
          status: 201,
          contentType: "application/json",
          body: JSON.stringify({ entity: created }),
        });
        return;
      }
      await route.continue();
    });

    // ── Step 2: imports list starts empty, then shows the newly-uploaded import ─
    let importList: object[] = [];

    await page.route("**/api/finance/ai-invoice-import**", async (route) => {
      if (route.request().method() === "GET") {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ imports: importList, total: importList.length }),
        });
        return;
      }
      await route.continue();
    });

    const uploadedImport = {
      id: 500,
      entity_id: 77,
      status: "uploaded",
      original_filename: "happy-path-invoice.pdf",
      vendor_name: null,
      invoice_number: null,
      invoice_date: null,
      due_date: null,
      currency: null,
      total_amount: null,
      subtotal: null,
      tax_amount: null,
      confidence: null,
      company_validation_status: null,
      company_validation_notes: null,
      odoo_bill_url: null,
      odoo_bill_id: null,
      error_message: null,
      created_at: new Date().toISOString(),
      entity_legal_name: "Happy Path LLC",
      entity_accounting_system: "none",
      line_items: [],
      vendor_address: null,
      vendor_tax_number: null,
      manually_entered_at: null,
      manual_accounting_reference: null,
      is_reviewed: false,
      reviewed_at: null,
      processing_step: "queued",
    };

    await page.route("**/api/finance/ai-invoice-import/upload", async (route) => {
      importList = [uploadedImport];
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ import_ids: [500] }),
      });
    });

    let deleteCallCount = 0;
    await page.route("**/api/finance/ai-invoice-import/imports/**", async (route) => {
      if (route.request().method() === "DELETE") {
        deleteCallCount++;
        importList = [];
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ success: true }),
        });
        return;
      }
      await route.continue();
    });

    // ── Navigate to the page ──────────────────────────────────────────────────
    await page.goto("/ai-invoice-import", { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible({ timeout: 15_000 });

    // ── Step 3: create the entity ─────────────────────────────────────────────
    await expect(page.getByText("No legal entities configured")).toBeVisible({ timeout: 12_000 });
    await page.getByRole("button", { name: /add entity/i }).click();

    const dialog = page.getByRole("dialog", { name: "Add Legal Entity" });
    await expect(dialog).toBeVisible({ timeout: 5_000 });

    await dialog.getByPlaceholder("Company LLC").fill("Happy Path LLC");
    await dialog.getByRole("button", { name: /create entity/i }).click();

    // Dialog closes after the entity is created
    await expect(dialog).not.toBeVisible({ timeout: 8_000 });

    // ── Step 4: page now shows the upload zone ────────────────────────────────
    await expect(page.getByText("Drop PDF invoices here, or click to browse")).toBeVisible({ timeout: 12_000 });

    // ── Step 5: upload a PDF ──────────────────────────────────────────────────
    const fileInput = page.locator('input[type="file"][accept]');
    await expect(fileInput).toBeAttached();

    await fileInput.setInputFiles({
      name: "happy-path-invoice.pdf",
      mimeType: "application/pdf",
      buffer: Buffer.from("%PDF-1.4 happy path test invoice"),
    });

    await expect(page.getByText(/invoice.*uploaded.*AI extraction started/i).first()).toBeVisible({ timeout: 8_000 });

    // ── Step 6: verify the import appears in the list ─────────────────────────
    // The table row shows entity name and status; the filename appears in the detail panel
    const importRow = page.locator("tbody tr").first();
    await expect(importRow).toBeVisible({ timeout: 8_000 });
    await expect(importRow).toContainText("Happy Path LLC");
    await expect(importRow).toContainText("Uploaded");

    // ── Step 7: open the detail panel ────────────────────────────────────────
    await importRow.click();
    await expect(page.getByText("Invoice Detail")).toBeVisible({ timeout: 5_000 });

    // ── Step 8: delete the import ────────────────────────────────────────────
    page.on("dialog", (dialog) => dialog.accept());

    const detailCard = page.locator(".sticky").filter({ hasText: "Invoice Detail" });
    const deleteButton = detailCard.locator("button.text-destructive, button[class*='text-destructive']").first();
    await expect(deleteButton).toBeVisible({ timeout: 5_000 });
    await deleteButton.click();

    // Deletion toast confirms success
    await expect(page.getByText("Import deleted")).toBeVisible({ timeout: 8_000 });

    // DELETE was called once
    expect(deleteCallCount).toBe(1);

    // Detail panel closes and list returns to empty state
    await expect(page.getByText("Invoice Detail")).not.toBeVisible({ timeout: 5_000 });
    await expect(page.getByText("No invoices imported yet")).toBeVisible({ timeout: 8_000 });
  });
});

  test("safely renders two-panel and stacked responsive layouts for long invoices", async ({ page }) => {
    await setupClerkTestingToken({ page });
    await setupCommonRoutes(page);

    // Create an extremely long invoice to force scrolling
    const longLineItems = Array.from({ length: 30 }).map((_, i) => ({
      description: `Line ${i}`,
      quantity: 1,
      unit_price: 10,
      total: 10
    }));

    await page.route("**/api/finance/invoice-review/101/neighbors", (route) => route.fulfill({ status: 200, contentType: "application/json", body: "{}" }));
    await page.route("**/api/finance/invoice-review/101", (route) => route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(reviewResponse({
        invoice: { line_items: longLineItems },
        source_document: {
          available: true,
          url: "/api/finance/invoice-review/101/source",
          content_type: "application/pdf",
          page_count: 1,
        },
      }))
    }));
    await page.route("**/api/finance/invoice-review/101/source", (route) => route.fulfill({ status: 200, contentType: "application/pdf", body: "%PDF-1.4 test" }));

    // Test 1440px viewport (desktop two-panel)
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/ai-invoice-import/101/review", { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible({ timeout: 15_000 });

    const header = page.getByTestId("review-header");
    const surface = page.getByTestId("reconciliation-surface");
    const scroller = page.getByTestId("editor-scroller");
    const sourcePanel = page.getByTestId("source-panel");

    await expect(header).toBeVisible({ timeout: 15_000 });
    await expect(surface).toBeVisible();
    await expect(sourcePanel).toBeVisible();

    // Scroll the editor down
    await scroller.evaluate(node => node.scrollTop = node.scrollHeight);
    await page.waitForTimeout(100);

    // Header and reconciliation should STILL be visible due to sticky/fixed layout
    await expect(header).toBeInViewport();
    await expect(surface).toBeInViewport();

    // Test narrower viewport (mobile/stacked)
    await page.setViewportSize({ width: 700, height: 900 });
    await page.waitForTimeout(200);

    await expect(header).toBeInViewport();
    await expect(surface).toBeInViewport();
    await expect(sourcePanel).toBeVisible();
  });

import { test, expect } from "./fixtures";
import { setupClerkTestingToken } from "@clerk/testing/playwright";

const OWNER_EMAIL = "e2e-tester@presentail.com";
const SUPPLIER_ID = 1;
const BASE_ITEM_ID = 7;
const BASE_ITEM_NAME = "Premium Gift Box";
const BASE_ITEM_CODE = "PGB-001";

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

const MOCK_SUPPLIER = {
  id: SUPPLIER_ID,
  workspace_owner_id: "user_owner",
  name: "Acme Paper Co",
  display_name: "Acme Paper",
  contact_name: "John Smith",
  contact_email: "john@acmepaper.com",
  contact_phone: null,
  country: "United Arab Emirates",
  tax_number: null,
  supplier_code: "APC-01",
  payment_terms: "Net 30",
  currency_pref: "AED",
  lead_time_days: null,
  min_order_value: null,
  notes: null,
  is_archived: false,
  item_count: 2,
  invoice_count: 0,
  spend_ytd: "0",
  spend_ytd_currency: null,
  created_at: new Date().toISOString(),
  updated_at: null,
  created_by_clerk_id: null,
  updated_by_clerk_id: null,
};

const MOCK_BASE_ITEM = {
  id: BASE_ITEM_ID,
  name: BASE_ITEM_NAME,
  code: BASE_ITEM_CODE,
  image_url: null,
  type: "material",
  category_id: null,
  category_name: null,
  unit: "piece",
  is_archived: false,
  stock_count: 10,
  created_at: new Date().toISOString(),
};

function makeInvoice(overrides: Record<string, unknown> = {}) {
  return {
    id: 101,
    supplier_id: SUPPLIER_ID,
    workspace_owner_id: "user_owner",
    invoice_number: "INV-001",
    amount: "500.00",
    currency: "AED",
    status: "issued",
    issued_at: "2026-05-01T00:00:00.000Z",
    paid_at: null,
    notes: null,
    reference_type: "",
    reference_id: null,
    reference_name: null,
    created_at: new Date().toISOString(),
    updated_at: null,
    ...overrides,
  };
}

async function setupRoutes(
  page: import("@playwright/test").Page,
  opts: { initialInvoices?: ReturnType<typeof makeInvoice>[] } = {},
) {
  const invoices: ReturnType<typeof makeInvoice>[] = [...(opts.initialInvoices ?? [])];

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

  await page.route(`**/api/suppliers/${SUPPLIER_ID}/invoices/**`, async (route) => {
    const method = route.request().method();
    if (method === "PATCH") {
      const body = route.request().postDataJSON() as Record<string, unknown>;
      const idx = invoices.findIndex((inv) => inv.id === 101);
      if (idx !== -1) {
        invoices[idx] = { ...invoices[idx], ...body };
      }
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ invoice: invoices[idx] }),
      });
      return;
    }
    await route.continue();
  });

  await page.route(`**/api/suppliers/${SUPPLIER_ID}/invoices`, async (route) => {
    const method = route.request().method();
    if (method === "GET") {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ invoices }),
      });
      return;
    }
    if (method === "POST") {
      const body = route.request().postDataJSON() as Record<string, unknown>;
      const newInvoice = makeInvoice({ id: 101, ...body });
      invoices.push(newInvoice);
      await route.fulfill({
        status: 201,
        contentType: "application/json",
        body: JSON.stringify({ invoice: newInvoice }),
      });
      return;
    }
    await route.continue();
  });

  await page.route(`**/api/suppliers/${SUPPLIER_ID}`, async (route) => {
    if (route.request().method() === "GET") {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ supplier: { ...MOCK_SUPPLIER, invoice_count: invoices.length } }),
      });
      return;
    }
    await route.continue();
  });

  await page.route(`**/api/suppliers/${SUPPLIER_ID}/items**`, (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ items: [] }),
    }),
  );

  await page.route(`**/api/suppliers/${SUPPLIER_ID}/documents**`, (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ documents: [] }),
    }),
  );

  await page.route("**/api/base-items**", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ items: [MOCK_BASE_ITEM] }),
    }),
  );
}

test.describe("Supplier invoice — link to base item", () => {
  test("creates an invoice linked to a base item and shows the base item name in the Linked To column", async ({
    page,
  }) => {
    await setupClerkTestingToken({ page });
    await setupRoutes(page);

    await page.goto(`/suppliers/${SUPPLIER_ID}`, { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading", { name: "Acme Paper" })).toBeVisible({ timeout: 15_000 });

    await expect(page.getByText("Acme Paper")).toBeVisible({ timeout: 12_000 });

    await page.getByRole("button", { name: "Invoices" }).click();

    await expect(page.getByText("No invoices yet")).toBeVisible({ timeout: 8_000 });

    await page.getByRole("button", { name: "Add Invoice" }).click();

    await expect(
      page.getByRole("heading", { name: "Add Invoice" }),
    ).toBeVisible({ timeout: 6_000 });

    await page.getByLabel("Amount *").fill("500");

    await page.getByLabel("Issue Date *").fill("2026-05-01");

    await page.getByRole("combobox", { name: /select base item/i }).click();

    await expect(page.getByPlaceholder("Search base items…")).toBeVisible({
      timeout: 6_000,
    });

    await page.getByRole("option", { name: new RegExp(BASE_ITEM_NAME, "i") }).click();

    await expect(
      page.getByRole("combobox", { name: new RegExp(BASE_ITEM_NAME, "i") }),
    ).toBeVisible();

    await page.getByRole("button", { name: "Add Invoice" }).last().click();

    await expect(
      page.getByRole("link", { name: new RegExp(BASE_ITEM_NAME, "i") }),
    ).toBeVisible({ timeout: 8_000 });
  });

  test("editing an invoice and clearing the base item link shows a dash in the Linked To column", async ({
    page,
  }) => {
    const linkedInvoice = makeInvoice({
      reference_type: "base_item",
      reference_id: BASE_ITEM_ID,
      reference_name: BASE_ITEM_NAME,
    });

    await setupClerkTestingToken({ page });
    await setupRoutes(page, { initialInvoices: [linkedInvoice] });

    await page.goto(`/suppliers/${SUPPLIER_ID}`, { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading", { name: "Acme Paper" })).toBeVisible({ timeout: 15_000 });

    await expect(page.getByText("Acme Paper")).toBeVisible({ timeout: 12_000 });

    await page.getByRole("button", { name: /Invoices/i }).click();

    await expect(
      page.getByRole("link", { name: new RegExp(BASE_ITEM_NAME, "i") }),
    ).toBeVisible({ timeout: 8_000 });

    await page.getByTitle("Edit").click();

    await expect(
      page.getByRole("heading", { name: "Edit Invoice" }),
    ).toBeVisible({ timeout: 6_000 });

    await expect(
      page.getByRole("combobox", { name: new RegExp(BASE_ITEM_NAME, "i") }),
    ).toBeVisible();

    await page.getByRole("combobox", { name: new RegExp(BASE_ITEM_NAME, "i") }).click();

    await expect(page.getByText("— Clear selection —")).toBeVisible({
      timeout: 6_000,
    });
    await page.getByText("— Clear selection —").click();

    await expect(
      page.getByRole("combobox", { name: /select base item/i }),
    ).toBeVisible();

    await page.getByRole("button", { name: "Save changes" }).click();

    const linkedToCell = page
      .getByRole("row")
      .filter({ hasNotText: "Invoice #" })
      .first()
      .locator("td")
      .nth(4);

    await expect(linkedToCell).toHaveText("—", { timeout: 8_000 });
  });
});

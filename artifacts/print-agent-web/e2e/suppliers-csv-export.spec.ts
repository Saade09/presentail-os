import { test, expect } from "./fixtures";
import { setupFapiWithFakeSession } from "./clerk-fapi-redirect";

// Override the _fapiMock auto-fixture with setupFapiWithFakeSession for this
// spec. All API routes are mocked via page.route, so the backend never
// validates the JWT — a fully static fake Clerk session is sufficient.
test.use({
  _fapiMock: [
    async ({ page }, use) => {
      await setupFapiWithFakeSession(page);
      await use();
    },
    { auto: true },
  ],
});

const OWNER_EMAIL = "e2e-tester@presentail.com";

const MOCK_SUPPLIER = {
  id: 1,
  workspace_owner_id: "user_owner",
  name: "Alpha Supplies LLC",
  display_name: "Alpha Supplies",
  contact_name: null,
  contact_email: null,
  contact_phone: null,
  country: "United Arab Emirates",
  tax_number: "100123456789003",
  supplier_code: null,
  payment_terms: null,
  currency_pref: null,
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
        id: 1,
        email: OWNER_EMAIL,
        role: "member",
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
      role: "member",
      email: OWNER_EMAIL,
      allowedPages: null,
      customRoleId: null,
    },
  };
}

async function setupCommonRoutes(page: import("@playwright/test").Page) {
  await page.route("**/api/**", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({}),
    }),
  );

  await page.route("**/api/users/failed-access-requests**", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ failedRequests: [] }),
    }),
  );

  await page.route("**/api/access-requests**", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ requests: [] }),
    }),
  );

  await page.route("**/api/suppliers**", async (route) => {
    const url = route.request().url();
    const isListEndpoint = /\/api\/suppliers(\?.*)?$/.test(url);
    if (route.request().method() === "GET" && isListEndpoint) {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          suppliers: [MOCK_SUPPLIER],
        }),
      });
      return;
    }
    await route.continue();
  });
}

async function setupOwnerRoutes(page: import("@playwright/test").Page) {
  await setupCommonRoutes(page);

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
}

async function setupMemberRoutes(page: import("@playwright/test").Page) {
  await setupCommonRoutes(page);

  await page.route("**/api/users**", async (route) => {
    if (route.request().method() === "GET") {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(memberUsersResponse()),
      });
      return;
    }
    await route.continue();
  });
}

async function gotoSuppliers(page: import("@playwright/test").Page) {
  await page.goto("/suppliers", { waitUntil: "domcontentloaded" });
  await expect(
    page.getByRole("heading", { name: "Suppliers", level: 1 }),
  ).toBeVisible({ timeout: 15_000 });
}

test.describe("Suppliers — CSV Export", () => {
  test("owner sees Export CSV button and clicking it downloads a CSV with correct headers", async ({
    page,
  }) => {
    // Intercept CSV blob creation so we can read the generated content after
    // the client-side export.  The export function revokes the blob URL
    // immediately, so we keep the blob alive in a side Map.
    await page.addInitScript(() => {
      const origCreateObjectURL = URL.createObjectURL;
      const origRevokeObjectURL = URL.revokeObjectURL;
      const csvBlobs = new Map<string, Blob>();

      URL.createObjectURL = function (blob) {
        const url = origCreateObjectURL(blob);
        if (blob.type === "text/csv;charset=utf-8;") {
          csvBlobs.set(url, blob);
        }
        return url;
      };

      URL.revokeObjectURL = function (url) {
        if (csvBlobs.has(url)) {
          return;
        }
        origRevokeObjectURL(url);
      };

      (window as any).__getCsvBlobs = () => csvBlobs;
    });

    await setupOwnerRoutes(page);
    await gotoSuppliers(page);

    const exportButton = page.getByRole("button", { name: "Export CSV" });
    await expect(exportButton).toBeVisible({ timeout: 8_000 });
    await exportButton.click();

    // Read the captured CSV blob(s)
    const csvResult = await page.evaluate(async () => {
      const blobs = (window as any).__getCsvBlobs() as Map<string, Blob>;
      for (const [url, blob] of blobs.entries()) {
        const text = await blob.text();
        return { url, text };
      }
      return null;
    });

    expect(csvResult).not.toBeNull();
    expect(csvResult!.url).toMatch(/^blob:/);

    const lines = csvResult!.text.split("\n");
    expect(lines[0]).toBe(
      "Name,Country,TRN / Tax ID,Items,Invoices,YTD Spend,Status",
    );
    expect(lines[1]).toBe(
      "Alpha Supplies,United Arab Emirates,100123456789003,2,0,0,Active",
    );
  });

  test("non-owner does not see Export CSV button", async ({ page }) => {
    await setupMemberRoutes(page);
    await gotoSuppliers(page);

    const exportButton = page.getByRole("button", { name: "Export CSV" });
    await expect(exportButton).not.toBeVisible({ timeout: 8_000 });
  });
});

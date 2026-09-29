import { test, expect } from "./fixtures";
import { setupFapiWithFakeSession } from "./clerk-fapi-redirect";

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

const QR_LINK_URL = "https://qr.example.com/gift/abc123";

function makeOrderRow(overrides: {
  id?: string;
  display_order_number?: string | null;
  qr_link?: string | null;
}) {
  return {
    id: overrides.id ?? "ord-qr-001",
    display_order_number: overrides.display_order_number ?? "9001",
    external_order_id: null,
    status: "processing",
    source: "native",
    channel: "website",
    ordered_at: new Date().toISOString(),
    created_at: new Date().toISOString(),
    totals: { total: "99.00", currency: "USD" },
    contact_name: "Test Customer",
    contact_email: "test@example.com",
    contact_phone: "+10000000000",
    payment_status: "pending",
    driver_first_name: null,
    driver_last_name: null,
    assignment_status: null,
    thumbnail_url: null,
    qr_link: overrides.qr_link ?? null,
  };
}

function makeOrderDetail(overrides: {
  id?: string;
  display_order_number?: string | null;
  qr_link?: string | null;
  card_message?: string | null;
}) {
  const id = overrides.id ?? "ord-qr-001";
  return {
    success: true,
    order: {
      id,
      display_order_number: overrides.display_order_number ?? "9001",
      external_order_id: null,
      status: "processing",
      source: "native",
      channel: "website",
      ordered_at: new Date().toISOString(),
      delivery_type: "same_day",
      delivery_address: {
        address_1: "1 Test Ave",
        city: "Test City",
        postcode: "00000",
        country: "US",
      },
      delivery_instructions: null,
      window_start: null,
      window_end: null,
      totals: { total: "99.00", currency: "USD" },
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      payment_status: "pending",
      payment_method: "credit_card",
      payment_provider: "stripe",
      payment_reference: "pi_test",
      paid_at: null,
      customer_note: null,
      florist_note: null,
      driver_note: null,
      internal_note: null,
      card_message: overrides.card_message ?? null,
      card_from: null,
      card_to: null,
      qr_link: overrides.qr_link ?? null,
    },
    line_items: [],
    contacts: [
      {
        role: "customer",
        contact_id: "con-qr-001",
        first_name: "Test",
        last_name: "Customer",
        display_name: "Test Customer",
        email: "test@example.com",
        phone: "+10000000000",
      },
    ],
    assignment: null,
  };
}

async function setupUsersRoute(page: import("@playwright/test").Page) {
  await page.route("**/api/users**", async (route) => {
    if (route.request().method() === "GET") {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
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
        }),
      });
      return;
    }
    await route.continue();
  });
}

// ---------------------------------------------------------------------------
// Orders list — qr_link icon indicator
// ---------------------------------------------------------------------------

test.describe("Orders list QR link indicator", () => {
  test("shows link icon on list row for an order with qr_link", async ({ page }) => {
    await setupUsersRoute(page);

    const ORDER_ID = "ord-qr-icon";

    await page.route("**/api/orders**", async (route) => {
      if (route.request().method() === "GET") {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            success: true,
            orders: [makeOrderRow({ id: ORDER_ID, display_order_number: "8001", qr_link: QR_LINK_URL })],
            total: 1,
            limit: 50,
            offset: 0,
          }),
        });
        return;
      }
      await route.continue();
    });

    await page.goto("/orders", { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading", { name: "Orders", level: 1 })).toBeVisible({ timeout: 15_000 });

    // The order number should appear
    await expect(page.getByText("#8001")).toBeVisible({ timeout: 12_000 });

    // The small Link2 icon should be present inside the order number cell
    // It renders as an SVG with a title attribute (via the tooltip span)
    const qrIconSpan = page.locator(`[title]`).filter({ hasText: "" }).and(
      page.locator("span.inline-flex.text-teal-600"),
    ).first();
    await expect(qrIconSpan).toBeVisible({ timeout: 10_000 });
  });

  test("does NOT show link icon on list row for an order without qr_link", async ({ page }) => {
    await setupUsersRoute(page);

    const ORDER_ID = "ord-no-qr-icon";

    await page.route("**/api/orders**", async (route) => {
      if (route.request().method() === "GET") {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            success: true,
            orders: [makeOrderRow({ id: ORDER_ID, display_order_number: "7001", qr_link: null })],
            total: 1,
            limit: 50,
            offset: 0,
          }),
        });
        return;
      }
      await route.continue();
    });

    await page.goto("/orders", { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading", { name: "Orders", level: 1 })).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText("#7001")).toBeVisible({ timeout: 12_000 });

    // No teal link icon should appear in the orders list when qr_link is null
    const qrIconSpan = page.locator("span.inline-flex.text-teal-600");
    await expect(qrIconSpan).toHaveCount(0);
  });
});

// ---------------------------------------------------------------------------
// Order detail — QR Code Link row in Card Message section
// ---------------------------------------------------------------------------

test.describe("Order detail QR Code Link row", () => {
  test("shows QR Code Link row with clickable anchor when qr_link is set", async ({ page }) => {
    await setupUsersRoute(page);

    const ORDER_ID = "ord-qr-detail";

    await page.route("**/api/orders**", async (route) => {
      if (route.request().method() === "GET") {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            success: true,
            orders: [],
            total: 0,
            limit: 50,
            offset: 0,
          }),
        });
        return;
      }
      await route.continue();
    });

    await page.route(`**/api/orders/${ORDER_ID}`, async (route) => {
      if (route.request().method() === "GET") {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify(
            makeOrderDetail({ id: ORDER_ID, display_order_number: "6001", qr_link: QR_LINK_URL }),
          ),
        });
        return;
      }
      await route.continue();
    });

    await page.goto(`/orders/${ORDER_ID}`, { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading", { name: /Order #6001/i })).toBeVisible({ timeout: 15_000 });

    // The QR Code Link anchor should be visible with the correct href
    const qrAnchor = page.getByRole("link", { name: QR_LINK_URL });
    await expect(qrAnchor).toBeVisible({ timeout: 10_000 });
    await expect(qrAnchor).toHaveAttribute("href", QR_LINK_URL);
    await expect(qrAnchor).toHaveAttribute("target", "_blank");
  });

  test("does NOT show QR Code Link row when qr_link is absent", async ({ page }) => {
    await setupUsersRoute(page);

    const ORDER_ID = "ord-no-qr-detail";

    await page.route("**/api/orders**", async (route) => {
      if (route.request().method() === "GET") {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            success: true,
            orders: [],
            total: 0,
            limit: 50,
            offset: 0,
          }),
        });
        return;
      }
      await route.continue();
    });

    await page.route(`**/api/orders/${ORDER_ID}`, async (route) => {
      if (route.request().method() === "GET") {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify(
            makeOrderDetail({ id: ORDER_ID, display_order_number: "5001", qr_link: null }),
          ),
        });
        return;
      }
      await route.continue();
    });

    await page.goto(`/orders/${ORDER_ID}`, { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading", { name: /Order #5001/i })).toBeVisible({ timeout: 15_000 });

    // No QR Code Link row should appear
    await expect(page.getByRole("link", { name: /qr\.example\.com/i })).toHaveCount(0);
    // Specifically no teal anchor text matching the QR URL pattern
    await expect(page.locator("a.text-teal-600")).toHaveCount(0);
  });

  test("copy button writes qr_link URL to clipboard and shows a toast", async ({
    page,
    context,
  }) => {
    await setupUsersRoute(page);

    const ORDER_ID = "ord-qr-copy";

    await page.route("**/api/orders**", async (route) => {
      if (route.request().method() === "GET") {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            success: true,
            orders: [],
            total: 0,
            limit: 50,
            offset: 0,
          }),
        });
        return;
      }
      await route.continue();
    });

    await page.route(`**/api/orders/${ORDER_ID}`, async (route) => {
      if (route.request().method() === "GET") {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify(
            makeOrderDetail({ id: ORDER_ID, display_order_number: "4001", qr_link: QR_LINK_URL }),
          ),
        });
        return;
      }
      await route.continue();
    });

    // Grant clipboard permissions so the copy actually works
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);

    await page.goto(`/orders/${ORDER_ID}`, { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading", { name: /Order #4001/i })).toBeVisible({ timeout: 15_000 });

    // Wait for the QR link to appear
    const qrAnchor = page.getByRole("link", { name: QR_LINK_URL });
    await expect(qrAnchor).toBeVisible({ timeout: 10_000 });

    // Click the copy button (the small Copy icon button next to the link)
    const copyButton = page.locator("button[title]").filter({
      has: page.locator("svg"),
    }).last();
    await copyButton.click();

    // Verify: either a success toast appears, or the clipboard contains the URL
    const toastVisible = await page
      .locator("[role='status'], [data-sonner-toast], .toast, [data-radix-collection-item]")
      .filter({ hasText: /copied|link/i })
      .isVisible()
      .catch(() => false);

    if (!toastVisible) {
      // Fall back: verify clipboard directly
      const clipboardText = await page.evaluate(() => navigator.clipboard.readText());
      expect(clipboardText).toBe(QR_LINK_URL);
    }
  });

  test("sanitizes a qr_link that has no protocol by prepending https://", async ({ page }) => {
    await setupUsersRoute(page);

    const ORDER_ID = "ord-qr-no-proto";
    const RAW_LINK = "qr.example.com/noproto/xyz";
    const SANITIZED = `https://${RAW_LINK}`;

    await page.route("**/api/orders**", async (route) => {
      if (route.request().method() === "GET") {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            success: true,
            orders: [],
            total: 0,
            limit: 50,
            offset: 0,
          }),
        });
        return;
      }
      await route.continue();
    });

    await page.route(`**/api/orders/${ORDER_ID}`, async (route) => {
      if (route.request().method() === "GET") {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify(
            makeOrderDetail({ id: ORDER_ID, display_order_number: "3001", qr_link: RAW_LINK }),
          ),
        });
        return;
      }
      await route.continue();
    });

    await page.goto(`/orders/${ORDER_ID}`, { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading", { name: /Order #3001/i })).toBeVisible({ timeout: 15_000 });

    // The anchor should be rendered with the sanitized https:// URL
    const qrAnchor = page.getByRole("link", { name: SANITIZED });
    await expect(qrAnchor).toBeVisible({ timeout: 10_000 });
    await expect(qrAnchor).toHaveAttribute("href", SANITIZED);
  });
});

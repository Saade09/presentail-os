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

function makeOrderRow(overrides: {
  id?: string;
  display_order_number?: string | null;
  external_order_id?: string | null;
  status?: string;
  source?: string;
  channel?: string | null;
  contact_name?: string | null;
  contact_email?: string | null;
  contact_phone?: string | null;
  payment_status?: string | null;
  totals?: Record<string, unknown> | null;
  delivery_address?: Record<string, unknown> | null;
  window_start?: string | null;
  window_end?: string | null;
  delivery_timezone?: string;
}) {
  return {
    id: overrides.id ?? "ord-001",
    display_order_number: overrides.display_order_number ?? "1001",
    external_order_id: overrides.external_order_id ?? null,
    status: overrides.status ?? "processing",
    source: overrides.source ?? "native",
    channel: overrides.channel ?? "website",
    ordered_at: new Date().toISOString(),
    created_at: new Date().toISOString(),
    window_start: overrides.window_start ?? null,
    window_end: overrides.window_end ?? null,
    delivery_address: overrides.delivery_address ?? null,
    delivery_timezone: overrides.delivery_timezone ?? "UTC",
    totals: overrides.totals ?? { total: "149.99", currency: "USD" },
    contact_name: overrides.contact_name ?? "Jane Doe",
    contact_email: overrides.contact_email ?? "jane@example.com",
    contact_phone: overrides.contact_phone ?? "+1234567890",
    payment_status: overrides.payment_status ?? "pending",
    driver_first_name: null,
    driver_last_name: null,
    assignment_status: null,
  };
}

function makeOrderDetail(overrides: {
  id?: string;
  display_order_number?: string | null;
  status?: string;
  source?: string;
  channel?: string | null;
  contact_name?: string;
  contact_email?: string;
  contact_phone?: string;
  delivery_address?: Record<string, unknown> | null;
  window_start?: string | null;
  window_end?: string | null;
}) {
  const id = overrides.id ?? "ord-001";
  return {
    success: true,
    order: {
      id,
      display_order_number: overrides.display_order_number ?? "1001",
      external_order_id: null,
      status: overrides.status ?? "processing",
      source: overrides.source ?? "native",
      channel: overrides.channel ?? "website",
      ordered_at: new Date().toISOString(),
      delivery_type: "same_day",
      delivery_address: overrides.delivery_address ?? {
        address_1: "123 Main St",
        city: "New York",
        postcode: "10001",
        country: "US",
      },
      delivery_instructions: "Leave at front door",
      window_start: overrides.window_start ?? null,
      window_end: overrides.window_end ?? null,
      totals: { total: "149.99", currency: "USD" },
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      payment_status: "pending",
      payment_method: "credit_card",
      payment_provider: "stripe",
      payment_reference: "pi_123456",
      paid_at: null,
      customer_note: null,
      florist_note: null,
      driver_note: null,
      internal_note: null,
    },
    line_items: [
      {
        id: "li-001",
        name: "Red Roses Bouquet",
        sku: "RB-001",
        quantity: 1,
        unit_price: "99.99",
        total: "99.99",
        image_url: null,
      },
      {
        id: "li-002",
        name: "Gift Box",
        sku: "GB-001",
        quantity: 1,
        unit_price: "50.00",
        total: "50.00",
        image_url: null,
      },
    ],
    contacts: [
      {
        role: "customer",
        contact_id: "con-001",
        first_name: "Jane",
        last_name: "Doe",
        display_name: overrides.contact_name ?? "Jane Doe",
        email: overrides.contact_email ?? "jane@example.com",
        phone: overrides.contact_phone ?? "+1234567890",
      },
    ],
    assignment: null,
  };
}

async function setupUsersRoute(
  page: import("@playwright/test").Page,
  options: {
    role?: "owner" | "admin";
    allowedPages?: string[] | null;
  } = {},
) {
  const role = options.role ?? "owner";
  const allowedPages = options.allowedPages ?? null;
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
        }),
      });
      return;
    }
    await route.continue();
  });
}

async function gotoOrders(page: import("@playwright/test").Page) {
  await page.goto("/orders", { waitUntil: "domcontentloaded" });
  await expect(page.getByRole("heading", { name: "Orders", level: 1 })).toBeVisible({
    timeout: 15_000,
  });
}

// ---------------------------------------------------------------------------
// Orders list — empty state
// ---------------------------------------------------------------------------

test.describe("Orders list page", () => {
  test("shows empty state when no orders exist", async ({ page }) => {
    await setupUsersRoute(page);

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

    await gotoOrders(page);

    await expect(page.getByText("No orders found")).toBeVisible({ timeout: 12_000 });
    await expect(page.getByText("Orders ingested via the API will appear here.")).toBeVisible();
  });

  test("renders a seeded order and navigates to detail page", async ({ page }) => {
    await setupUsersRoute(page);

    const ORDER_ID = "ord-001";
    const ORDER_NUMBER = "1001";

    await page.route("**/api/orders**", async (route) => {
      if (route.request().method() === "GET") {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            success: true,
            orders: [makeOrderRow({ id: ORDER_ID, display_order_number: ORDER_NUMBER })],
            total: 1,
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
          body: JSON.stringify(makeOrderDetail({ id: ORDER_ID, display_order_number: ORDER_NUMBER })),
        });
        return;
      }
      await route.continue();
    });
    await gotoOrders(page);

    await expect(page.getByText("#1001")).toBeVisible({ timeout: 12_000 });
    await expect(page.getByText("Jane Doe")).toBeVisible();
    await expect(page.getByText("jane@example.com")).toBeVisible();
    await expect(page.getByText("processing")).toBeVisible();

    const detailButton = page.getByRole("link", { name: /Go to order details/i }).or(
      page.locator(`a[href="/orders/${ORDER_ID}"]`).first(),
    );
    await expect(detailButton).toBeVisible();
    await detailButton.click();

    await expect(page.getByRole("heading", { name: /Order #1001/i })).toBeVisible({
      timeout: 15_000,
    });
  });

  test("keeps a legacy-only delivery schedule identical on list and detail", async ({ page }) => {
    await setupUsersRoute(page);

    const ORDER_ID = "ord-legacy-schedule";
    const legacyAddress = {
      address_1: "123 Main St",
      city: "Beirut",
      date: "2099-08-29",
      slot: "11:00 PM - 1:00 AM",
    };
    await page.route("**/api/orders**", async (route) => {
      if (route.request().method() === "GET") {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            success: true,
            orders: [
              makeOrderRow({
                id: ORDER_ID,
                display_order_number: "1099",
                delivery_address: legacyAddress,
                delivery_timezone: "Asia/Beirut",
              }),
            ],
            total: 1,
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
            makeOrderDetail({
              id: ORDER_ID,
              display_order_number: "1099",
              delivery_address: legacyAddress,
            }),
          ),
        });
        return;
      }
      await route.continue();
    });

    await gotoOrders(page);
    const listRow = page.getByRole("row").filter({ hasText: "#1099" });
    await expect(listRow).toContainText("Sat, Aug 29");
    await expect(listRow).toContainText("11:00 PM - 1:00 AM");

    await listRow.getByRole("link").first().click();
    await expect(page.getByTestId("scheduled-delivery-block")).toContainText("Sat, Aug 29");
    await expect(page.getByTestId("scheduled-delivery-block")).toContainText("11:00 PM - 1:00 AM");
    await expect(page.getByTestId("scheduled-delivery-block")).not.toContainText("No delivery date");
  });
});

// ---------------------------------------------------------------------------
// Order detail page
// ---------------------------------------------------------------------------

test.describe("Order detail page", () => {
  test("adds, reloads, validates, and prints an additional card message", async ({ page }) => {
    await setupUsersRoute(page);
    const ORDER_ID = "ord-extra-card";
    const detail = makeOrderDetail({ id: ORDER_ID, display_order_number: "4021" });
    Object.assign(detail.order, {
      card_to: "Primary recipient",
      card_message: "Primary message",
      card_from: "Primary sender",
      qr_link: null,
    });
    let extraCards: Array<Record<string, unknown>> = [];
    let printedBody: Record<string, unknown> | null = null;

    await page.route(`**/api/orders/${ORDER_ID}/card-messages`, async (route) => {
      if (route.request().method() !== "POST") return route.continue();
      const input = route.request().postDataJSON();
      const card = {
        id: "extra-1",
        ...input,
        created_at: "2026-09-08T10:00:00.000Z",
      };
      extraCards = [card];
      await route.fulfill({
        status: 201,
        contentType: "application/json",
        body: JSON.stringify({ success: true, card_message: card }),
      });
    });
    await page.route(`**/api/orders/${ORDER_ID}`, async (route) => {
      if (route.request().method() !== "GET") return route.continue();
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ ...detail, additional_card_messages: extraCards }),
      });
    });
    await page.route("**/api/card-message/branch-configs", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ configs: [{ id: 1, name: "Branch A" }] }),
      }),
    );
    await page.route("**/api/card-message/print", async (route) => {
      printedBody = route.request().postDataJSON();
      await route.fulfill({ status: 200, contentType: "application/json", body: "{}" });
    });
    await page.route("**/api/card-message/order-print-logs/**", (route) =>
      route.fulfill({ status: 200, contentType: "application/json", body: "{\"logs\":[]}" }),
    );
    await page.route(`**/api/orders/${ORDER_ID}/florist-assignment`, (route) =>
      route.fulfill({ status: 200, contentType: "application/json", body: "{\"assignment\":null}" }),
    );

    await page.goto(`/orders/${ORDER_ID}`, { waitUntil: "domcontentloaded" });
    await page.getByTestId("button-add-card-message").click();
    await page.getByLabel("Message").fill("Second card message");
    await page.getByLabel("QR Link").fill("javascript:alert(1)");
    await page.getByTestId("button-save-additional-card").click();
    await expect(page.getByText(/valid link starting with http/i)).toBeVisible();
    await page.getByLabel("To").last().fill("Second recipient");
    await page.getByLabel("From").last().fill("Second sender");
    await page.getByLabel("QR Link").fill("https://example.com/second");
    await page.getByTestId("button-save-additional-card").click();
    await expect(page.getByTestId("card-message-extra-0")).toContainText("Second card message");

    await page.reload({ waitUntil: "domcontentloaded" });
    const extra = page.getByTestId("card-message-extra-0");
    await expect(extra).toContainText("Second recipient");
    await extra.getByRole("button", { name: "Print Card" }).click();
    await page.getByTestId("select-print-card-branch").click();
    await page.getByRole("option", { name: "Branch A" }).click();
    await page.getByTestId("button-print-card-submit").click();
    await expect.poll(() => printedBody).toMatchObject({
      cardMessage: "Second card message",
      toName: "Second recipient",
      fromName: "Second sender",
      qrLink: "https://example.com/second",
      additionalCardMessageId: "extra-1",
    });
  });

  test("keeps the compact desktop header actionable while the OS scrollport is scrolled", async ({
    page,
  }) => {
    // 960 CSS pixels is representative of a desktop laptop at 150% zoom.
    await page.setViewportSize({ width: 960, height: 720 });
    await setupUsersRoute(page);

    const ORDER_ID = "ord-sticky";
    const detail = makeOrderDetail({
      id: ORDER_ID,
      display_order_number: "3815",
      status: "preparing",
    });
    detail.order.delivery_address = {
      date: "2026-08-20",
      slot: "09:00–12:00",
    };
    // A long order guarantees that the dashboard shell, rather than window,
    // has a meaningful scroll range.
    detail.line_items = Array.from({ length: 36 }, (_, index) => ({
      id: `line-${index}`,
      name: `Long order item ${index + 1}`,
      sku: `LONG-${index + 1}`,
      quantity: 1,
      unit_price: "10.00",
      total: "10.00",
      image_url: null,
    }));

    let advanceRequests = 0;
    await page.route(`**/api/orders/${ORDER_ID}/status`, async (route) => {
      if (route.request().method() === "PATCH") {
        advanceRequests += 1;
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ success: true }),
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
          body: JSON.stringify(detail),
        });
        return;
      }
      await route.continue();
    });
    await page.route(`**/api/orders/${ORDER_ID}/florist-assignment`, async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ success: true, assignment: null }),
      });
    });
    await page.route("**/api/print-agent/branches**", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ branches: [] }),
      });
    });

    await page.goto(`/orders/${ORDER_ID}`, { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading", { name: /Order #3815/i })).toBeVisible({
      timeout: 15_000,
    });

    const scrollport = page.getByTestId("dashboard-content-scroll");
    const compactHeader = page.getByTestId("compact-order-header");
    await expect(compactHeader).toHaveCount(0);
    await expect
      .poll(() =>
        scrollport.evaluate((element) => element.scrollHeight > element.clientHeight),
      )
      .toBe(true);

    await scrollport.evaluate((element) => {
      element.scrollTop = element.scrollHeight;
      element.dispatchEvent(new Event("scroll"));
    });

    await expect(compactHeader).toBeVisible();
    await expect(compactHeader).toContainText("Order #3815");
    await expect(compactHeader).toContainText("Window");
    await expect(compactHeader).toContainText("09:00–12:00");
    // The full header remains in the DOM for the scroll-back transition, but
    // its controls must not be reachable while the compact header is active.
    await expect(page.getByTestId("button-advance-status")).toHaveAttribute(
      "tabindex",
      "-1",
    );
    await expect(page.getByTestId("button-more-actions")).toHaveAttribute(
      "tabindex",
      "-1",
    );
    await expect(page.getByTestId("button-edit-order")).toHaveAttribute(
      "tabindex",
      "-1",
    );
    await expect(
      page.getByTestId("button-compact-advance-status"),
    ).toHaveAttribute("tabindex", "0");
    await expect(
      page.getByTestId("button-compact-overflow-actions"),
    ).toHaveAttribute("tabindex", "0");

    await page.getByTestId("button-compact-advance-status").click();
    await expect.poll(() => advanceRequests).toBe(1);

    // At this zoom-equivalent width Edit lives in the compact More menu.
    await page.getByTestId("button-compact-overflow-actions").click();
    await page.getByRole("menuitem", { name: "Edit" }).click();
    await expect(page.getByRole("dialog")).toContainText("Status");
    await page.getByRole("dialog").getByRole("button", { name: "Cancel" }).click();
    await expect(page.getByRole("dialog")).toHaveCount(0);

    await page.getByTestId("button-compact-overflow-actions").click();
    await page.getByRole("menuitem", { name: "Print Card" }).click();
    await expect(page.getByRole("dialog")).toContainText("Print Card");
    await page.keyboard.press("Escape");

    await scrollport.evaluate((element) => {
      element.scrollTop = 0;
      element.dispatchEvent(new Event("scroll"));
    });
    await expect(compactHeader).toHaveCount(0);
    await expect(page.getByRole("heading", { name: /Order #3815/i })).toBeVisible();
  });

  test("shows a no-window compact header without edit controls for a restricted user", async ({
    page,
  }) => {
    // An admin can open the page (allowedPages is unrestricted) but does not
    // receive the owner-only order mutation controls.
    await page.setViewportSize({ width: 1080, height: 720 });
    await setupUsersRoute(page, { role: "admin", allowedPages: null });

    const ORDER_ID = "ord-sticky-restricted";
    const detail = makeOrderDetail({
      id: ORDER_ID,
      display_order_number: "3816",
      status: "completed",
    });
    detail.line_items = Array.from({ length: 36 }, (_, index) => ({
      id: `restricted-line-${index}`,
      name: `Restricted long order item ${index + 1}`,
      sku: `RESTRICTED-${index + 1}`,
      quantity: 1,
      unit_price: "10.00",
      total: "10.00",
      image_url: null,
    }));
    await page.route(`**/api/orders/${ORDER_ID}`, async (route) => {
      if (route.request().method() === "GET") {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify(detail),
        });
        return;
      }
      await route.continue();
    });
    await page.route(`**/api/orders/${ORDER_ID}/florist-assignment`, async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ success: true, assignment: null }),
      });
    });

    await page.goto(`/orders/${ORDER_ID}`, { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading", { name: /Order #3816/i })).toBeVisible({
      timeout: 15_000,
    });
    const scrollport = page.getByTestId("dashboard-content-scroll");
    await scrollport.evaluate((element) => {
      element.scrollTop = element.scrollHeight;
      element.dispatchEvent(new Event("scroll"));
    });

    const compactHeader = page.getByTestId("compact-order-header");
    await expect(compactHeader).toBeVisible();
    await expect(compactHeader).toContainText("Window");
    await expect(compactHeader).toContainText("No delivery date");
    await expect(page.getByTestId("button-compact-advance-status")).toHaveCount(0);
    await expect(page.getByTestId("button-compact-edit-order")).toHaveCount(0);
    await expect(page.getByTestId("button-compact-more-actions")).toBeVisible();
  });

  test("shows order number, status badge, and contact info", async ({ page }) => {
    await setupUsersRoute(page);

    const ORDER_ID = "ord-002";
    const ORDER_NUMBER = "2002";

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
            makeOrderDetail({
              id: ORDER_ID,
              display_order_number: ORDER_NUMBER,
              status: "completed",
              contact_name: "Alice Smith",
              contact_email: "alice@example.com",
              contact_phone: "+9876543210",
            }),
          ),
        });
        return;
      }
      await route.continue();
    });
    await page.route(`**/api/orders/${ORDER_ID}/florist-assignment`, async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ success: true, assignment: null }),
      });
    });

    await page.goto(`/orders/${ORDER_ID}`, { waitUntil: "domcontentloaded" });

    await expect(page.getByRole("heading", { name: /Order #2002/i })).toBeVisible({
      timeout: 15_000,
    });

    await expect(page.getByText("completed")).toBeVisible();

    await expect(page.getByText("Alice Smith")).toBeVisible();
    await expect(page.getByText("alice@example.com")).toBeVisible();
    await expect(page.getByText("+9876543210")).toBeVisible();
    await expect(page.getByTestId("card-florist-verification-photos")).toHaveCount(0);
  });

  test("keeps florist verification photos visible after completing the order", async ({ page }) => {
    await setupUsersRoute(page);

    const ORDER_ID = "ord-003";
    let orderStatus = "ready_for_delivery";
    let assignmentRequests = 0;
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
            makeOrderDetail({
              id: ORDER_ID,
              display_order_number: "2003",
              status: orderStatus,
            }),
          ),
        });
        return;
      }
      await route.continue();
    });
    await page.route(`**/api/orders/${ORDER_ID}/status`, async (route) => {
      if (route.request().method() === "PATCH") {
        orderStatus = "completed";
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ success: true }),
        });
        return;
      }
      await route.continue();
    });
    await page.route(`**/api/orders/${ORDER_ID}/florist-assignment`, async (route) => {
      assignmentRequests += 1;
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          success: true,
          assignment: {
            id: 42,
            order_id: ORDER_ID,
            location_id: 7,
            location_name: "Florist A",
            status: "completed",
            photo_items_path: "/objects/private/items.jpg",
            photo_card_path: "/objects/private/card.jpg",
          },
        }),
      });
    });

    await page.goto(`/orders/${ORDER_ID}`, { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading", { name: /Order #2003/i })).toBeVisible({
      timeout: 15_000,
    });

    const card = page.getByTestId("card-florist-verification-photos");
    await expect(card).toBeVisible({ timeout: 15_000 });
    await expect(card).toContainText("Florist verification photos");
    await expect(card).toContainText("Prepared order items");
    await expect(card).toContainText("Card message");
    await expect(page.getByTestId("image-florist-verification-items")).toHaveAttribute(
      "src",
      "/api/storage/objects/private/items.jpg",
    );
    await expect(page.getByTestId("image-florist-verification-card")).toHaveAttribute(
      "src",
      "/api/storage/objects/private/card.jpg",
    );

    await page.getByTestId("button-advance-status").click();
    await expect(page.getByText("completed", { exact: true })).toBeVisible();
    await expect(page.getByTestId("card-florist-verification-photos")).toBeVisible();
    await expect(page.getByTestId("image-florist-verification-items")).toHaveAttribute(
      "src",
      "/api/storage/objects/private/items.jpg",
    );
    await expect(page.getByTestId("image-florist-verification-card")).toHaveAttribute(
      "src",
      "/api/storage/objects/private/card.jpg",
    );
    await expect.poll(() => assignmentRequests).toBeGreaterThanOrEqual(2);
  });

  test("shows the approved prepared-order photo when no card photo is required", async ({ page }) => {
    await setupUsersRoute(page);

    const ORDER_ID = "ord-004";
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
          body: JSON.stringify(makeOrderDetail({ id: ORDER_ID, display_order_number: "2004" })),
        });
        return;
      }
      await route.continue();
    });
    await page.route(`**/api/orders/${ORDER_ID}/florist-assignment`, async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          success: true,
          assignment: {
            id: 43,
            order_id: ORDER_ID,
            location_id: 7,
            location_name: "Florist A",
            status: "completed",
            photo_items_path: "/objects/private/items-only.jpg",
            photo_card_path: null,
          },
        }),
      });
    });

    await page.goto(`/orders/${ORDER_ID}`, { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading", { name: /Order #2004/i })).toBeVisible({
      timeout: 15_000,
    });

    const card = page.getByTestId("card-florist-verification-photos");
    await expect(card).toBeVisible({ timeout: 15_000 });
    await expect(card).toContainText("Florist verification photos");
    await expect(card).toContainText("Prepared order items");
    await expect(card).not.toContainText("Card message");
    await expect(page.getByTestId("image-florist-verification-items")).toHaveAttribute(
      "src",
      "/api/storage/objects/private/items-only.jpg",
    );
    await expect(page.getByTestId("image-florist-verification-card")).toHaveCount(0);
  });

  test("requests a missing address, refreshes the card, and deep-links to its collector request", async ({
    page,
  }) => {
    await setupUsersRoute(page);

    const ORDER_ID = "ord-address-request";
    const REQUEST_ID = "11111111-1111-1111-1111-111111111111";
    let requestCreated = false;
    let createCalls = 0;
    const detail = makeOrderDetail({ id: ORDER_ID, display_order_number: "2004" });
    detail.order.delivery_address = { city: "Beirut", country: "LB" };
    detail.contacts.push({
      role: "recipient",
      contact_id: "con-recipient",
      first_name: "Maya",
      last_name: "Khalil",
      display_name: "Maya Khalil",
      email: null,
      phone: "+96181865589",
    });

    await page.route(`**/api/orders/${ORDER_ID}/address-collector`, async (route) => {
      if (route.request().method() === "POST") {
        createCalls += 1;
        requestCreated = true;
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ success: true, created: true, requestId: REQUEST_ID }),
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
          body: JSON.stringify({
            ...detail,
            order: {
              ...detail.order,
              address_collector_request: requestCreated
                ? { id: REQUEST_ID, status: "scheduled", risk_level: "normal", submitted_address: null }
                : null,
            },
          }),
        });
        return;
      }
      await route.continue();
    });
    await page.route("**/api/address-collector?*", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          kpis: { awaiting: 1, scheduled: 1, atRisk: 0, collectedAutomatically: 0 },
          requests: [{
            id: REQUEST_ID,
            order_id: ORDER_ID,
            recipient_name: "Maya Khalil",
            recipient_phone: "+9618•••589",
            preferred_language: "en",
            status: "scheduled",
            risk_level: "normal",
            window_start: null,
            window_end: null,
            delivery_timezone: "Asia/Beirut",
            last_contact_at: null,
            last_contact_channel: null,
            address_received_at: null,
            link_first_opened_at: null,
            created_at: new Date().toISOString(),
            next_action_at: null,
            next_action_type: null,
            messages_sent: 0,
          }],
          total: 1,
        }),
      });
    });
    await page.route(`**/api/address-collector/${REQUEST_ID}`, async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          request: {
            id: REQUEST_ID,
            order_id: ORDER_ID,
            recipient_name: "Maya Khalil",
            recipient_phone: "+96181865589",
            preferred_language: "en",
            status: "scheduled",
            risk_level: "normal",
            window_start: null,
            window_end: null,
            delivery_timezone: "Asia/Beirut",
            submitted_address: null,
            submitted_lat: null,
            submitted_lng: null,
            token_expires_at: null,
            address_deadline: null,
            compliance_state: null,
            sms_opt_out: false,
          },
          events: [],
          actions: [],
        }),
      });
    });

    await page.goto(`/orders/${ORDER_ID}`, { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading", { name: /Order #2004/i })).toBeVisible({
      timeout: 15_000,
    });
    await expect(page.getByTestId("card-delivery")).toContainText("Address needed");

    await page.getByTestId("button-request-address").click();
    await expect.poll(() => createCalls).toBe(1);
    await expect(page.getByTestId("delivery-address-request")).toContainText("Address request in progress");

    await page.getByTestId("link-view-address-collector").click();
    await expect(page).toHaveURL(new RegExp(`/address-collector\\?requestId=${REQUEST_ID}`));
    await expect(page.getByTestId("address-collector-detail")).toContainText("Maya Khalil");
  });

  test("shows not found state for missing order", async ({ page }) => {
    await setupUsersRoute(page);

    const MISSING_ORDER_ID = "ord-missing";

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

    await page.route(`**/api/orders/${MISSING_ORDER_ID}`, async (route) => {
      if (route.request().method() === "GET") {
        await route.fulfill({
          status: 404,
          contentType: "application/json",
          body: JSON.stringify({ success: false, error: "Order not found" }),
        });
        return;
      }
      await route.continue();
    });

    await page.goto(`/orders/${MISSING_ORDER_ID}`, { waitUntil: "domcontentloaded" });
    await expect(page).toHaveURL(new RegExp(`/orders/${MISSING_ORDER_ID}`));
    await expect(page.getByText("Order not found")).toBeVisible({ timeout: 15_000 });
    await expect(page.getByRole("button", { name: "Back to orders" })).toBeVisible();
  });
});

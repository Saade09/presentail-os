import { test, expect, type Page } from "./fixtures";
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

function makeBoardOrder(overrides: {
  id: string;
  display_order_number: string;
  status: string;
  window_start?: string | null;
  window_end?: string | null;
  workshop?: { location_id: number; location_name: string; status: string } | null;
  driver_first_name?: string | null;
  driver_last_name?: string | null;
  delivered_at?: string | null;
  district?: string;
}) {
  return {
    id: overrides.id,
    display_order_number: overrides.display_order_number,
    external_order_id: null,
    status: overrides.status,
    source: "native",
    channel: "website",
    ordered_at: new Date().toISOString(),
    delivery_type: "standard",
    window_start: overrides.window_start ?? "2026-08-26T10:00:00.000Z",
    window_end: overrides.window_end ?? "2026-08-26T12:00:00.000Z",
    created_at: new Date().toISOString(),
    delivery_address: {
      date: "2026-08-26",
      slot: "10:00 AM - 12:00 PM",
      district: overrides.district ?? "Achrafieh",
    },
    totals: { total: "80.00", currency: "USD" },
    contact_name: "Jane Doe",
    contact_email: "jane@example.com",
    contact_phone: "+1234567890",
    payment_status: "paid",
    payment_method: "card",
    driver_first_name: overrides.driver_first_name ?? null,
    driver_last_name: overrides.driver_last_name ?? null,
    assignment_status: null,
    thumbnail_url: null,
    qr_link: null,
    delivery_date_review: null,
    workshop: overrides.workshop ?? null,
    delivered_at: overrides.delivered_at ?? null,
    delivery_timezone: "Asia/Beirut",
  };
}

async function setupUsersRoute(page: Page) {
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
          me: { role: "owner", email: OWNER_EMAIL, allowedPages: null, customRoleId: null },
        }),
      });
      return;
    }
    await route.continue();
  });
}

/**
 * Mocks the orders list endpoint from a mutable in-memory array, and a
 * matching PATCH .../status route that flips the stored order's status so
 * the *next* GET reflects it. This mirrors the real backend and exercises
 * the app's actual "optimistic update -> invalidate -> refetch" flow rather
 * than only the transient client-side override.
 */
async function setupOrdersBoardApi(
  page: Page,
  initialOrders: Array<Record<string, unknown>>,
  options: { patchStatus?: number; patchBody?: unknown } = {},
) {
  const orders = initialOrders.map((o) => ({ ...o }));
  const patched: { calls: Array<{ id: string; status: string }> } = { calls: [] };

  await page.route("**/api/orders?**", async (route) => {
    if (route.request().method() === "GET") {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ success: true, orders, total: orders.length, limit: 200, offset: 0 }),
      });
      return;
    }
    await route.continue();
  });

  await page.route("**/api/orders/*/status", async (route) => {
    if (route.request().method() !== "PATCH") {
      await route.continue();
      return;
    }
    const url = route.request().url();
    const id = decodeURIComponent(url.split("/api/orders/")[1].split("/status")[0]);
    const body = JSON.parse(route.request().postData() ?? "{}");
    patched.calls.push({ id, status: body.status });

    if (options.patchStatus && options.patchStatus >= 400) {
      await route.fulfill({
        status: options.patchStatus,
        contentType: "application/json",
        body: JSON.stringify(options.patchBody ?? { success: false, error: "Failed" }),
      });
      return;
    }

    const order = orders.find((o) => o.id === id);
    if (order) order.status = body.status;
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ success: true }),
    });
  });

  return patched;
}

async function gotoOrders(page: Page) {
  await page.goto("/orders", { waitUntil: "domcontentloaded" });
  await expect(page.getByRole("heading", { name: "Orders", level: 1 })).toBeVisible({ timeout: 15_000 });
}

/** Simulates a real pointer drag past dnd-kit's 8px activation distance. */
async function dragCardToColumn(page: Page, orderId: string, columnKey: string) {
  const card = page.getByTestId(`board-card-${orderId}`);
  const column = page.getByTestId(`board-column-${columnKey}`);
  const cardBox = await card.boundingBox();
  const columnBox = await column.boundingBox();
  if (!cardBox || !columnBox) throw new Error("Missing bounding box for drag");

  await page.mouse.move(cardBox.x + cardBox.width / 2, cardBox.y + cardBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(cardBox.x + cardBox.width / 2 + 20, cardBox.y + cardBox.height / 2 + 20, {
    steps: 5,
  });
  // Aim toward the lower part of the column so the drop lands in the
  // droppable content area rather than the sticky, non-droppable header.
  await page.mouse.move(columnBox.x + columnBox.width / 2, columnBox.y + columnBox.height - 30, {
    steps: 10,
  });
  await page.mouse.up();
}

test.describe("Orders board view", () => {
  test("switches to Board, preserves the active status filter, and remembers the view on reload", async ({
    page,
  }) => {
    await setupUsersRoute(page);
    await setupOrdersBoardApi(page, [
      makeBoardOrder({ id: "ord-b1", display_order_number: "5001", status: "processing" }),
      makeBoardOrder({ id: "ord-b2", display_order_number: "5002", status: "preparing" }),
    ]);

    await gotoOrders(page);
    await page.getByTestId("button-view-board").click();
    await expect(page.getByTestId("orders-board")).toBeVisible({ timeout: 10_000 });
    await expect(page.getByTestId("board-card-ord-b1")).toBeVisible();
    await expect(page.getByTestId("board-card-ord-b2")).toBeVisible();

    // Apply a status filter — Board should keep sending it to the API and
    // only render the columns it still matches.
    let lastUrl = "";
    page.on("request", (req) => {
      if (req.url().includes("/api/orders?")) lastUrl = req.url();
    });
    // Combobox order on this page: 0 = saved-view picker, 1 = status filter,
    // 2 = source, 3 = country, 4 = driver.
    await page.getByRole("combobox").nth(1).click();
    await page.getByRole("option", { name: "Preparing" }).click();
    await expect.poll(() => lastUrl).toContain("status=preparing");

    // Reload — the last-selected view (Board) should persist via localStorage.
    await page.reload({ waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading", { name: "Orders", level: 1 })).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId("orders-board")).toBeVisible({ timeout: 10_000 });
  });

  test("drags a card to a new column, saves via the status endpoint, and updates counts", async ({
    page,
  }) => {
    await setupUsersRoute(page);
    const patched = await setupOrdersBoardApi(page, [
      makeBoardOrder({
        id: "ord-drag-ok",
        display_order_number: "6001",
        status: "processing",
        workshop: null,
      }),
    ]);

    await gotoOrders(page);
    await page.getByTestId("button-view-board").click();
    await expect(page.getByTestId("board-card-ord-drag-ok")).toBeVisible({ timeout: 10_000 });
    await expect(page.getByTestId("board-column-count-processing")).toHaveText("1");
    await expect(page.getByTestId("board-column-count-preparing")).toHaveText("0");

    await dragCardToColumn(page, "ord-drag-ok", "preparing");

    await expect.poll(() => patched.calls.at(-1)?.status).toBe("preparing");
    await expect(page.getByTestId("board-column-count-processing")).toHaveText("0");
    await expect(page.getByTestId("board-column-count-preparing")).toHaveText("1");
    await expect(page.getByTestId("board-card-ord-drag-ok")).toBeVisible();
  });

  test("rolls back a card and shows an error when the status update fails", async ({ page }) => {
    await setupUsersRoute(page);
    await setupOrdersBoardApi(
      page,
      [makeBoardOrder({ id: "ord-drag-fail", display_order_number: "6002", status: "processing" })],
      {
        patchStatus: 409,
        patchBody: { success: false, code: "payment_not_paid", error: "Payment required" },
      },
    );

    await gotoOrders(page);
    await page.getByTestId("button-view-board").click();
    await expect(page.getByTestId("board-card-ord-drag-fail")).toBeVisible({ timeout: 10_000 });

    await dragCardToColumn(page, "ord-drag-fail", "preparing");

    // Rolled back: the card returns to Processing, not Preparing.
    await expect(page.getByTestId("board-column-processing")).toContainText("#6002");
    await expect(page.getByTestId("board-column-count-processing")).toHaveText("1");
    await expect(page.getByTestId("board-column-count-preparing")).toHaveText("0");
    await expect(page.getByText("Could not move order", { exact: true }).first()).toBeVisible({
      timeout: 10_000,
    });
  });

  // A "permission-blocked drag" scenario cannot be reached through real
  // navigation: the /orders route itself is gated by PageGuard on the same
  // "orders" allowedPages flag that OrdersBoard's `canEditOrders` prop reads
  // (see Orders.tsx), so any user who can load this page already has drag
  // permission. The gating is instead covered at the component level in
  // OrdersBoard.permission.test.tsx, which asserts the draggable is disabled
  // (and no status mutation can fire) when `canEditOrders={false}`.

  test("advances a pending order to processing via the in-card action (no drag target exists within one column)", async ({
    page,
  }) => {
    await setupUsersRoute(page);
    const patched = await setupOrdersBoardApi(page, [
      makeBoardOrder({ id: "ord-pending", display_order_number: "7001", status: "pending" }),
    ]);

    await gotoOrders(page);
    await page.getByTestId("button-view-board").click();
    await expect(page.getByTestId("board-card-ord-pending")).toBeVisible({ timeout: 10_000 });
    await expect(page.getByTestId("board-column-count-processing")).toHaveText("1");

    await page.getByTestId("button-board-start-processing-ord-pending").click();

    await expect.poll(() => patched.calls.at(-1)?.status).toBe("processing");
    // Still in the same (Processing) column — pending and processing share it.
    await expect(page.getByTestId("board-column-count-processing")).toHaveText("1");
    // Once processing, the action is no longer offered.
    await expect(page.getByTestId("button-board-start-processing-ord-pending")).toHaveCount(0);
  });

  test("paginates past the API's 200-row page cap so a busy day's counts and cards stay complete", async ({
    page,
  }) => {
    await setupUsersRoute(page);

    // 220 processing orders — one more page than the API's 200-row cap. The
    // mock honors limit/offset like the real backend so the board's fetch
    // loop is genuinely exercised (unlike setupOrdersBoardApi's single-page
    // helper, which always returns everything regardless of paging params).
    const total = 220;
    const allOrders = Array.from({ length: total }, (_, i) =>
      makeBoardOrder({ id: `ord-page-${i}`, display_order_number: String(9000 + i), status: "processing" }),
    );
    await page.route("**/api/orders?**", async (route) => {
      if (route.request().method() !== "GET") {
        await route.continue();
        return;
      }
      const url = new URL(route.request().url());
      const limit = Number(url.searchParams.get("limit") ?? "50");
      const offset = Number(url.searchParams.get("offset") ?? "0");
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          success: true,
          orders: allOrders.slice(offset, offset + limit),
          total,
          limit,
          offset,
        }),
      });
    });

    await gotoOrders(page);
    await page.getByTestId("button-view-board").click();
    // All 220 are represented in the live count, not just the first page's 200.
    await expect(page.getByTestId("board-column-count-processing")).toHaveText("220");
    await expect(page.getByTestId("board-card-ord-page-0")).toBeVisible({ timeout: 10_000 });
    // A card from beyond the first 200-row page is present too.
    await expect(page.getByTestId("board-card-ord-page-210")).toBeVisible();
    await expect(page.getByTestId("board-partial-data-banner")).toHaveCount(0);
  });
});

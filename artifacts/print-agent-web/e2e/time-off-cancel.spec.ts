import { test, expect } from "./fixtures";
import { setupClerkTestingToken } from "@clerk/testing/playwright";
import { setupTimeOffCommonRoutes } from "./helpers/timeOffCommonRoutes";

const OWNER_ID = 1;
const CURRENT_YEAR = new Date().getFullYear();

const PENDING_ID = 701;
const APPROVED_ID = 702;
const PENDING_DAYS = 2;

function makeBalance(overrides: Record<string, unknown> = {}) {
  return {
    id: 1,
    member_id: OWNER_ID,
    policy_id: 1,
    policy_year: CURRENT_YEAR,
    vacation_entitled: 20,
    vacation_used: 2,
    vacation_pending: PENDING_DAYS,
    vacation_carryover: 0,
    vacation_remaining: 16,
    sick_leave_entitled: 10,
    sick_leave_used: 0,
    sick_leave_pending: 0,
    updated_at: new Date().toISOString(),
    ...overrides,
  };
}

function makePendingRequest(overrides: Record<string, unknown> = {}) {
  return {
    id: PENDING_ID,
    type_id: 1,
    type_code: "VACATION",
    type_name: "Vacation",
    type_color: "#10b981",
    start_date: `${CURRENT_YEAR}-07-14`,
    end_date: `${CURRENT_YEAR}-07-15`,
    total_days: String(PENDING_DAYS) + ".0",
    half_day: false,
    half_day_period: null,
    reason: "Family trip",
    status: "PENDING",
    manager_note: null,
    reviewed_by_name: null,
    reviewed_at: null,
    cancelled_at: null,
    cancelled_by: null,
    cancelled_by_name: null,
    cancelled_by_self: null,
    cancellation_reason: null,
    created_at: new Date(Date.now() - 3_600_000).toISOString(),
    ...overrides,
  };
}

function makeApprovedFutureRequest() {
  return {
    id: APPROVED_ID,
    type_id: 1,
    type_code: "VACATION",
    type_name: "Vacation",
    type_color: "#10b981",
    start_date: `${CURRENT_YEAR}-09-01`,
    end_date: `${CURRENT_YEAR}-09-03`,
    total_days: "3.0",
    half_day: false,
    half_day_period: null,
    reason: null,
    status: "APPROVED",
    manager_note: null,
    reviewed_by_name: "Manager",
    reviewed_at: new Date(Date.now() - 86_400_000).toISOString(),
    cancelled_at: null,
    cancelled_by: null,
    cancelled_by_name: null,
    cancelled_by_self: null,
    cancellation_reason: null,
    created_at: new Date(Date.now() - 86_400_000 * 2).toISOString(),
  };
}

test.describe("Time-off leave cancellation flow", () => {
  test.beforeEach(async ({ page }) => {
    await setupClerkTestingToken({ page });
    await setupTimeOffCommonRoutes(page);
  });

  test(
    "cancelling a PENDING VACATION request changes status to Cancelled and restores the balance",
    async ({ page }) => {
      let balance = makeBalance();
      const requests: ReturnType<typeof makePendingRequest>[] = [
        makePendingRequest(),
        makeApprovedFutureRequest() as ReturnType<typeof makePendingRequest>,
      ];

      let cancelCallCount = 0;
      let cancelledId: string | null = null;

      await page.route("**/api/time-off/balance**", async (route) => {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ balance }),
        });
      });

      // Register the broad list handler FIRST so the more specific /cancel
      // handler (registered next) takes LIFO priority and intercepts cancel
      // POSTs before this handler can shadow them.
      await page.route("**/api/time-off/requests**", async (route) => {
        const method = route.request().method();
        const url = route.request().url();
        // Let the specific cancel handler below take over for cancel POSTs.
        if (method === "POST" && url.includes("/cancel")) {
          await route.continue();
          return;
        }
        // GET /api/time-off/requests — return current request list.
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ requests }),
        });
      });

      // Specific cancel handler — registered after (LIFO: matched first).
      await page.route("**/api/time-off/requests/*/cancel", async (route) => {
        if (route.request().method() !== "POST") {
          await route.continue();
          return;
        }
        const match = route
          .request()
          .url()
          .match(/\/api\/time-off\/requests\/(\d+)\/cancel/);
        cancelledId = match?.[1] ?? null;
        cancelCallCount++;

        const idNum = Number(cancelledId);
        const target = requests.find((r) => r.id === idNum);
        if (target && target.type_code === "VACATION") {
          const days = Number(target.total_days);
          target.status = "CANCELLED";
          target.cancelled_by = "user_test";
          target.cancelled_by_self = true;
          target.cancelled_at = new Date().toISOString();
          balance = makeBalance({
            vacation_pending: Math.max(0, balance.vacation_pending - days),
            vacation_remaining: balance.vacation_remaining + days,
          });
        }

        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ ok: true }),
        });
      });

      await page.goto("/time-off/my", { waitUntil: "domcontentloaded" });

      await expect(page.getByRole("heading", { name: "Time Off" })).toBeVisible({
        timeout: 12_000,
      });

      // Balance cards are visible with the initial balance: 16.0 remaining.
      await expect(page.getByText("Vacation Left")).toBeVisible();
      await expect(page.getByText("16.0", { exact: true }).first()).toBeVisible();

      // The pending request Cancel button should be visible.
      const cancelBtn = page.getByTestId(`cancel-request-${PENDING_ID}`);
      await expect(cancelBtn).toBeVisible({ timeout: 8_000 });

      // No Cancel button for the APPROVED request (only PENDING shows it).
      await expect(
        page.getByTestId(`cancel-request-${APPROVED_ID}`),
      ).toHaveCount(0);

      // Cancel the pending request.
      await cancelBtn.click();

      // The cancel POST was called for the correct request ID.
      await expect.poll(() => cancelCallCount, { timeout: 8_000 }).toBe(1);
      expect(cancelledId).toBe(String(PENDING_ID));

      // The Cancel button disappears — status is no longer PENDING.
      await expect(cancelBtn).not.toBeVisible({ timeout: 8_000 });

      // Status badge changes to "Cancelled" (mock returns CANCELLED on next GET).
      await expect(
        page.getByText("Cancelled").first(),
      ).toBeVisible({ timeout: 8_000 });

      // "Cancelled by you" label appears on the row.
      await expect(page.getByText("Cancelled by you")).toBeVisible();

      // Balance is restored: vacation_remaining goes from 16.0 → 18.0.
      await expect(
        page.getByText("18.0", { exact: true }).first(),
      ).toBeVisible({ timeout: 5_000 });
    },
  );

  test(
    "cancel button does not appear on APPROVED, DECLINED, or CANCELLED requests",
    async ({ page }) => {
      const requests = [
        makePendingRequest({ id: 703, status: "APPROVED" }),
        makePendingRequest({ id: 704, status: "DECLINED" }),
        makePendingRequest({ id: 705, status: "CANCELLED" }),
      ];

      await page.route("**/api/time-off/balance**", async (route) => {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ balance: makeBalance() }),
        });
      });

      await page.route("**/api/time-off/requests**", async (route) => {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ requests }),
        });
      });

      await page.goto("/time-off/my", { waitUntil: "domcontentloaded" });
      await expect(page.getByRole("heading", { name: "Time Off" })).toBeVisible({
        timeout: 12_000,
      });

      // No cancel buttons should appear for non-PENDING requests.
      await expect(page.getByTestId("cancel-request-703")).toHaveCount(0);
      await expect(page.getByTestId("cancel-request-704")).toHaveCount(0);
      await expect(page.getByTestId("cancel-request-705")).toHaveCount(0);

      // Correct status badges are visible for each request.
      await expect(page.getByText("Approved").first()).toBeVisible();
      await expect(page.getByText("Declined").first()).toBeVisible();
      await expect(page.getByText("Cancelled").first()).toBeVisible();
    },
  );

  test(
    "shows an error toast and keeps the request PENDING when the cancel API returns an error",
    async ({ page }) => {
      await page.route("**/api/time-off/balance**", async (route) => {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ balance: makeBalance() }),
        });
      });

      // Broad list handler first (LIFO: cancel route below wins for /cancel).
      await page.route("**/api/time-off/requests**", async (route) => {
        const method = route.request().method();
        const url = route.request().url();
        if (method === "POST" && url.includes("/cancel")) {
          await route.continue();
          return;
        }
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ requests: [makePendingRequest()] }),
        });
      });

      // Cancel route registered after — matched first by LIFO.
      await page.route("**/api/time-off/requests/*/cancel", async (route) => {
        await route.fulfill({
          status: 500,
          contentType: "application/json",
          body: JSON.stringify({ error: "Internal server error" }),
        });
      });

      await page.goto("/time-off/my", { waitUntil: "domcontentloaded" });
      await expect(page.getByRole("heading", { name: "Time Off" })).toBeVisible({
        timeout: 12_000,
      });

      const cancelBtn = page.getByTestId(`cancel-request-${PENDING_ID}`);
      await expect(cancelBtn).toBeVisible({ timeout: 8_000 });

      await cancelBtn.click();

      // Error toast appears.
      await expect(
        page.getByText("Failed to cancel").first(),
      ).toBeVisible({ timeout: 8_000 });

      await expect(
        page.getByText(/could not cancel the request/i).first(),
      ).toBeVisible({ timeout: 5_000 });

      // The cancel button is still present — the request stayed PENDING.
      await expect(cancelBtn).toBeVisible();
    },
  );
});

import { test, expect } from "./fixtures";
import { setupClerkTestingToken } from "@clerk/testing/playwright";
import { setupTimeOffCommonRoutes } from "./helpers/timeOffCommonRoutes";

const PENDING_REQUEST_ID = 501;

const CURRENT_YEAR = new Date().getFullYear();

function makeBalance(overrides: Record<string, unknown> = {}) {
  return {
    id: 1,
    member_id: OWNER_ID,
    policy_id: 1,
    policy_year: CURRENT_YEAR,
    vacation_entitled: 20,
    vacation_used: 2,
    vacation_pending: 0,
    vacation_carryover: 0,
    vacation_remaining: 18,
    sick_leave_entitled: 10,
    sick_leave_used: 1,
    sick_leave_pending: 0,
    updated_at: new Date().toISOString(),
    ...overrides,
  };
}

function makePendingRequest(overrides: Record<string, unknown> = {}) {
  return {
    id: PENDING_REQUEST_ID,
    type_id: 1,
    type_code: "VACATION",
    type_name: "Vacation",
    type_color: "#10b981",
    start_date: `${CURRENT_YEAR}-06-15`,
    end_date: `${CURRENT_YEAR}-06-15`,
    total_days: "1.0",
    half_day: false,
    half_day_period: null,
    reason: null,
    status: "PENDING",
    manager_note: null,
    created_at: new Date().toISOString(),
    ...overrides,
  };
}

function makeApprovedRequest() {
  return {
    id: 502,
    type_id: 1,
    type_code: "VACATION",
    type_name: "Vacation",
    type_color: "#10b981",
    start_date: `${CURRENT_YEAR}-02-10`,
    end_date: `${CURRENT_YEAR}-02-12`,
    total_days: "3.0",
    half_day: false,
    half_day_period: null,
    reason: null,
    status: "APPROVED",
    manager_note: null,
    created_at: new Date(Date.now() - 86400_000 * 30).toISOString(),
  };
}

test.describe("Time-off request flow", () => {
  test.beforeEach(async ({ page }) => {
    await setupClerkTestingToken({ page });
    await setupTimeOffCommonRoutes(page);
    // Default balance route — tests that need a different balance register their own
    // route which takes priority via Playwright's LIFO matching order.
    await page.route("**/api/time-off/balance**", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ balance: makeBalance() }),
      });
    });
  });

  test(
    "user views balance cards, submits a request, sees it in history, and cancels it",
    async ({ page }) => {
      // Mutable state: the list of requests returned by GET /api/time-off/requests.
      // Starts with one approved request; a newly-submitted one will be appended;
      // a cancelled one will be filtered out.
      const requests: ReturnType<typeof makePendingRequest>[] = [
        makeApprovedRequest(),
      ];

      let balance = makeBalance();

      let createCallCount = 0;
      let createCapturedBody: unknown = null;
      let cancelCallCount = 0;
      let cancelCapturedId: string | null = null;

      await page.route("**/api/time-off/balance**", async (route) => {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ balance }),
        });
      });

      await page.route("**/api/time-off/requests**", async (route) => {
        const method = route.request().method();
        const url = route.request().url();

        // DELETE /api/time-off/requests/{id}
        if (method === "DELETE") {
          const match = url.match(/\/api\/time-off\/requests\/(\d+)/);
          cancelCapturedId = match?.[1] ?? null;
          cancelCallCount++;
          // Remove the cancelled request from the in-memory list and update balance.
          const idNum = Number(cancelCapturedId);
          const idx = requests.findIndex((r) => r.id === idNum);
          if (idx !== -1) {
            const removed = requests.splice(idx, 1)[0];
            if (removed.type_code === "VACATION" && removed.status === "PENDING") {
              const days = Number(removed.total_days);
              balance = makeBalance({
                vacation_pending: Math.max(0, balance.vacation_pending - days),
                vacation_remaining: balance.vacation_remaining + days,
                vacation_used: balance.vacation_used,
              });
            }
          }
          await route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify({ ok: true }),
          });
          return;
        }

        // POST /api/time-off/requests — create
        if (method === "POST") {
          createCallCount++;
          createCapturedBody = JSON.parse(route.request().postData() ?? "{}");
          const body = createCapturedBody as {
            typeCode: string;
            startDate: string;
            endDate: string;
            halfDay?: boolean;
            reason?: string | null;
          };
          const newId = PENDING_REQUEST_ID;
          requests.unshift(
            makePendingRequest({
              id: newId,
              type_code: body.typeCode,
              type_name: body.typeCode === "VACATION" ? "Vacation" : "Sick Leave",
              start_date: body.startDate,
              end_date: body.endDate,
              total_days: body.halfDay ? "0.5" : "1.0",
              half_day: !!body.halfDay,
              reason: body.reason ?? null,
            }),
          );
          if (body.typeCode === "VACATION") {
            const days = body.halfDay ? 0.5 : 1.0;
            balance = makeBalance({
              vacation_pending: balance.vacation_pending + days,
              vacation_remaining: balance.vacation_remaining - days,
              vacation_used: balance.vacation_used,
            });
          }
          await route.fulfill({
            status: 201,
            contentType: "application/json",
            body: JSON.stringify({
              request: { id: newId, status: "PENDING", totalDays: body.halfDay ? 0.5 : 1.0 },
            }),
          });
          return;
        }

        // GET /api/time-off/requests — list
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ requests }),
        });
      });

      // Navigate to the time-off page.
      await page.goto("/time-off/my", { waitUntil: "domcontentloaded" });

      // Heading and balance cards visible.
      await expect(page.getByRole("heading", { name: "Time Off" })).toBeVisible({
        timeout: 12_000,
      });
      await expect(page.getByText("Vacation Left")).toBeVisible();
      await expect(page.getByText("Vacation Used")).toBeVisible();
      await expect(page.getByText("Sick Used")).toBeVisible();
      // Initial vacation_remaining is 18.0
      await expect(page.getByText("18.0", { exact: true }).first()).toBeVisible();

      // The approved historical request should be in the list.
      await expect(page.getByText("Approved")).toBeVisible();

      // Open the request dialog.
      await page.getByTestId("request-time-off-btn").click();

      const dialog = page.getByRole("dialog");
      await expect(dialog).toBeVisible({ timeout: 5_000 });
      await expect(dialog.getByText("Request Time Off")).toBeVisible();

      // Fill in start/end dates within the same year so it stays in the default
      // year filter. Use a Wednesday so it counts as 1 working day.
      const startDate = `${CURRENT_YEAR}-06-17`;
      const endDate = `${CURRENT_YEAR}-06-17`;
      await dialog.locator("#tor-start").fill(startDate);
      await dialog.locator("#tor-end").fill(endDate);
      await dialog.locator("#tor-reason").fill("Family event");

      // Estimated days message should appear.
      await expect(dialog.getByText(/working day/)).toBeVisible();

      // Submit the request.
      await dialog.getByRole("button", { name: "Submit Request" }).click();

      // Dialog closes after success.
      await expect(dialog).not.toBeVisible({ timeout: 8_000 });

      // The create endpoint was called with the correct payload.
      expect(createCallCount).toBe(1);
      expect(createCapturedBody).toMatchObject({
        typeCode: "VACATION",
        startDate,
        endDate,
        halfDay: false,
        reason: "Family event",
      });

      // The new pending request appears in the history with a Cancel button.
      // The cancel button is only rendered when the request status is PENDING,
      // so its visibility is sufficient evidence of the new pending request.
      const pendingRow = page.getByTestId(`cancel-request-${PENDING_REQUEST_ID}`);
      await expect(pendingRow).toBeVisible({ timeout: 8_000 });

      // Vacation_remaining should now be 17.0 after pending decrement.
      await expect(page.getByText("17.0", { exact: true }).first()).toBeVisible();

      // Cancel the pending request.
      await pendingRow.click();

      // The cancel API was called with the correct id, and the row disappears.
      await expect(pendingRow).not.toBeVisible({ timeout: 8_000 });
      expect(cancelCallCount).toBe(1);
      expect(cancelCapturedId).toBe(String(PENDING_REQUEST_ID));

      // Vacation_remaining should be back to 18.0 after the pending request is gone.
      await expect(page.getByText("18.0", { exact: true }).first()).toBeVisible();
    },
  );

  test(
    "shows the 'exceeds balance' warning when requested days exceed vacation_remaining",
    async ({ page }) => {
      // Low remaining balance so any multi-week range will trip the warning.
      const lowBalance = makeBalance({
        vacation_entitled: 5,
        vacation_used: 4,
        vacation_pending: 0,
        vacation_remaining: 1,
      });

      await page.route("**/api/time-off/balance**", async (route) => {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ balance: lowBalance }),
        });
      });

      await page.route("**/api/time-off/requests**", async (route) => {
        // Should never be called in this test — we never submit.
        if (route.request().method() === "POST") {
          await route.fulfill({
            status: 500,
            contentType: "application/json",
            body: JSON.stringify({ message: "Should not have been called" }),
          });
          return;
        }
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ requests: [] }),
        });
      });

      await page.goto("/time-off/my", { waitUntil: "domcontentloaded" });
      await expect(page.getByRole("heading", { name: "Time Off" })).toBeVisible({
        timeout: 12_000,
      });

      // Open the request dialog.
      await page.getByTestId("request-time-off-btn").click();
      const dialog = page.getByRole("dialog");
      await expect(dialog).toBeVisible({ timeout: 5_000 });

      // Pick a 30-day calendar range. June 1 → June 30 always contains
      // at least 22 working days regardless of year — comfortably more
      // than the 1 remaining vacation day.
      const startDate = `${CURRENT_YEAR}-06-01`;
      const endDate = `${CURRENT_YEAR}-06-30`;
      await dialog.locator("#tor-start").fill(startDate);
      await dialog.locator("#tor-end").fill(endDate);

      // The exceeds-balance warning copy from RequestTimeOffDialog.tsx.
      await expect(
        dialog.getByText(
          /this request will put you over your balance/i,
        ),
      ).toBeVisible({ timeout: 5_000 });
      await expect(
        dialog.getByText(/vacation days remaining/i),
      ).toBeVisible();

      // Sanity: the warning should NOT appear when the same low-balance
      // user picks a single working day (within remaining balance).
      // Use Jan 5, which is reliably a weekday-ish date but to be safe
      // pick a date and select morning-only (always 0.5 ≤ 1).
      await dialog.locator("#tor-start").fill(`${CURRENT_YEAR}-01-05`);
      await dialog.locator("#tor-end").fill(`${CURRENT_YEAR}-01-05`);
      // Force half-day via partial day dropdown so estimatedDays = 0.5 < 1 regardless of weekday.
      await dialog.locator("#tor-day-partial").selectOption("morning");
      await expect(
        dialog.getByText(/this request will put you over your balance/i),
      ).not.toBeVisible();
    },
  );

  test(
    "disables Submit Request and blocks POST when requested days exceed vacation_remaining",
    async ({ page }) => {
      const lowBalance = makeBalance({
        vacation_entitled: 5,
        vacation_used: 4,
        vacation_pending: 0,
        vacation_remaining: 1,
      });

      await page.route("**/api/time-off/balance**", async (route) => {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ balance: lowBalance }),
        });
      });

      let createCallCount = 0;
      await page.route("**/api/time-off/requests**", async (route) => {
        if (route.request().method() === "POST") {
          createCallCount++;
          await route.fulfill({
            status: 500,
            contentType: "application/json",
            body: JSON.stringify({ message: "Should not have been called" }),
          });
          return;
        }
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ requests: [] }),
        });
      });

      await page.goto("/time-off/my", { waitUntil: "domcontentloaded" });
      await expect(page.getByRole("heading", { name: "Time Off" })).toBeVisible({
        timeout: 12_000,
      });

      await page.getByTestId("request-time-off-btn").click();
      const dialog = page.getByRole("dialog");
      await expect(dialog).toBeVisible({ timeout: 5_000 });

      // Multi-week range comfortably exceeds the 1 remaining vacation day.
      await dialog.locator("#tor-start").fill(`${CURRENT_YEAR}-06-01`);
      await dialog.locator("#tor-end").fill(`${CURRENT_YEAR}-06-30`);

      const submitBtn = dialog.getByRole("button", { name: "Submit Request" });
      await expect(submitBtn).toBeDisabled();

      // Click should be a no-op — no POST is fired.
      await submitBtn.click({ force: true });
      await page.waitForTimeout(300);
      expect(createCallCount).toBe(0);

      // Narrow the range + morning-only so estimatedDays = 0.5 ≤ 1; button re-enables.
      await dialog.locator("#tor-start").fill(`${CURRENT_YEAR}-01-05`);
      await dialog.locator("#tor-end").fill(`${CURRENT_YEAR}-01-05`);
      await dialog.locator("#tor-day-partial").selectOption("morning");
      await expect(submitBtn).toBeEnabled();
    },
  );

  test(
    "shows an error toast and keeps the dialog open when the API returns 409 (overlapping request)",
    async ({ page }) => {
      let createCallCount = 0;
      await page.route("**/api/time-off/requests**", async (route) => {
        const method = route.request().method();
        if (method === "POST") {
          createCallCount++;
          await route.fulfill({
            status: 409,
            contentType: "application/json",
            body: JSON.stringify({
              message: "This request overlaps with an existing one",
            }),
          });
          return;
        }
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ requests: [] }),
        });
      });

      await page.goto("/time-off/my", { waitUntil: "domcontentloaded" });
      await expect(page.getByRole("heading", { name: "Time Off" })).toBeVisible({
        timeout: 12_000,
      });

      await page.getByTestId("request-time-off-btn").click();
      const dialog = page.getByRole("dialog");
      await expect(dialog).toBeVisible({ timeout: 5_000 });

      // A safe single-day range that stays well within the default 18-day
      // remaining balance. Use half-day to guarantee a non-zero day count
      // even on weekends and avoid tripping the exceeds-balance branch.
      await dialog.locator("#tor-start").fill(`${CURRENT_YEAR}-06-15`);
      await dialog.locator("#tor-end").fill(`${CURRENT_YEAR}-06-15`);

      await dialog.getByRole("button", { name: "Submit Request" }).click();

      // Error toast appears with "Failed to submit" title and the 409 detail.
      // Both the visible toast and an SR-only status span render the text,
      // so use .first() to avoid strict-mode violations.
      await expect(page.getByText("Failed to submit").first()).toBeVisible({
        timeout: 8_000,
      });
      await expect(
        page.getByText(/overlaps with an existing one/i).first(),
      ).toBeVisible({ timeout: 5_000 });

      // Dialog stays open after the failure.
      await expect(dialog).toBeVisible();
      await expect(dialog.getByText("Request Time Off")).toBeVisible();

      // The POST was attempted exactly once.
      expect(createCallCount).toBe(1);
    },
  );

  test(
    "disables Submit Request and shows zero-working-days warning when the date range falls on weekend only",
    async ({ page }) => {
      let createCallCount = 0;
      await page.route("**/api/time-off/requests**", async (route) => {
        if (route.request().method() === "POST") {
          createCallCount++;
          await route.fulfill({
            status: 500,
            contentType: "application/json",
            body: JSON.stringify({ message: "Should not have been called" }),
          });
          return;
        }
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ requests: [] }),
        });
      });

      await page.goto("/time-off/my", { waitUntil: "domcontentloaded" });
      await expect(page.getByRole("heading", { name: "Time Off" })).toBeVisible({
        timeout: 12_000,
      });

      await page.getByTestId("request-time-off-btn").click();
      const dialog = page.getByRole("dialog");
      await expect(dialog).toBeVisible({ timeout: 5_000 });

      // Find the first Saturday in June of the current year — always a weekend
      // on the default Mon–Fri schedule, so estimatedDays will be 0.
      const sat = new Date(`${CURRENT_YEAR}-06-01`);
      while (sat.getDay() !== 6) sat.setDate(sat.getDate() + 1);
      const satStr = sat.toISOString().slice(0, 10);
      const sunStr = new Date(sat.getFullYear(), sat.getMonth(), sat.getDate() + 1)
        .toISOString()
        .slice(0, 10);

      await dialog.locator("#tor-start").fill(satStr);
      await dialog.locator("#tor-end").fill(sunStr);

      // The zero-working-days warning should appear.
      await expect(
        dialog.getByText(/no working days based on your work schedule/i),
      ).toBeVisible({ timeout: 5_000 });

      // Submit button must be disabled.
      const submitBtn = dialog.getByRole("button", { name: "Submit Request" });
      await expect(submitBtn).toBeDisabled();

      // Clicking it (forced) must not fire a POST.
      await submitBtn.click({ force: true });
      await page.waitForTimeout(300);
      expect(createCallCount).toBe(0);
    },
  );

  test(
    "shows a warning and disables Submit for a half-day request on a non-working day",
    async ({ page }) => {
      let createCallCount = 0;
      await page.route("**/api/time-off/requests**", async (route) => {
        if (route.request().method() === "POST") {
          createCallCount++;
          await route.fulfill({
            status: 500,
            contentType: "application/json",
            body: JSON.stringify({ message: "Should not have been called" }),
          });
          return;
        }
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ requests: [] }),
        });
      });

      await page.goto("/time-off/my", { waitUntil: "domcontentloaded" });
      await expect(page.getByRole("heading", { name: "Time Off" })).toBeVisible({
        timeout: 12_000,
      });

      await page.getByTestId("request-time-off-btn").click();
      const dialog = page.getByRole("dialog");
      await expect(dialog).toBeVisible({ timeout: 5_000 });

      // Find the first Saturday in June of the current year — a non-working day
      // on the default Mon–Fri schedule.
      const sat = new Date(`${CURRENT_YEAR}-06-01`);
      while (sat.getDay() !== 6) sat.setDate(sat.getDate() + 1);
      const satStr = sat.toISOString().slice(0, 10);

      // Set startDate to the Saturday, then enable a partial day option.
      await dialog.locator("#tor-start").fill(satStr);
      await dialog.locator("#tor-end").fill(satStr);
      await dialog.locator("#tor-day-partial").selectOption("morning");

      // The partial-day non-working-day warning should appear.
      await expect(
        dialog.getByText(/not a working day based on your work schedule/i),
      ).toBeVisible({ timeout: 5_000 });

      // Submit button must be disabled.
      const submitBtn = dialog.getByRole("button", { name: "Submit Request" });
      await expect(submitBtn).toBeDisabled();

      // Clicking it (forced) must not fire a POST.
      await submitBtn.click({ force: true });
      await page.waitForTimeout(300);
      expect(createCallCount).toBe(0);

      // Switch to a Monday — a working day. Warning should disappear and button re-enables.
      const mon = new Date(`${CURRENT_YEAR}-06-01`);
      while (mon.getDay() !== 1) mon.setDate(mon.getDate() + 1);
      const monStr = mon.toISOString().slice(0, 10);

      await dialog.locator("#tor-start").fill(monStr);
      await dialog.locator("#tor-end").fill(monStr);
      await expect(
        dialog.getByText(/not a working day based on your work schedule/i),
      ).not.toBeVisible();
      await expect(submitBtn).toBeEnabled();
    },
  );

  test(
    "balance cards show 'No time-off policy assigned' when balance is null",
    async ({ page }) => {
      await page.route("**/api/time-off/balance**", async (route) => {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ balance: null, message: "No policy assigned" }),
        });
      });

      await page.route("**/api/time-off/requests**", async (route) => {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ requests: [] }),
        });
      });

      await page.goto("/time-off/my", { waitUntil: "domcontentloaded" });

      await expect(page.getByRole("heading", { name: "Time Off" })).toBeVisible({
        timeout: 12_000,
      });
      await expect(page.getByText("No time-off policy assigned")).toBeVisible();
      await expect(page.getByText("No requests found for this period.")).toBeVisible();
    },
  );
});

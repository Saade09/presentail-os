import { test, expect } from "./fixtures";
import { setupClerkTestingToken } from "@clerk/testing/playwright";
import type { Page } from "@playwright/test";

const OWNER_ID = 1;
const OWNER_EMAIL = "e2e-tester@presentail.com";

function ownerUsersResponse() {
  return {
    members: [
      {
        id: OWNER_ID,
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

type Calendar = {
  id: number;
  workspace_owner_id: string;
  name: string;
  country_code: string | null;
  location_id: number | null;
  is_active: boolean;
  created_at: string;
  updated_at: string;
  location_name: string | null;
};

type Holiday = {
  id: number;
  calendar_id: number;
  workspace_owner_id: string;
  name: string;
  date: string;
  end_date: string | null;
  is_paid: boolean;
  description: string | null;
  created_by_member_id: number | null;
  created_at: string;
  updated_at: string;
};

test.describe("Admin public holiday calendar + holiday creation", () => {
  test("admin creates a calendar then adds a holiday to it", async ({
    page,
  }) => {
    await setupClerkTestingToken({ page });
    await setupCommonRoutes(page);

    const calendars: Calendar[] = [];
    const holidays: Holiday[] = [];
    let calendarBody: Record<string, unknown> | null = null;
    let holidayBody: Record<string, unknown> | null = null;
    let holidayCalendarId: number | null = null;

    await page.route("**/api/public-holidays/calendars", async (route) => {
      const method = route.request().method();
      if (method === "POST") {
        calendarBody = JSON.parse(route.request().postData() ?? "{}");
        const now = new Date().toISOString();
        const created: Calendar = {
          id: 201,
          workspace_owner_id: "owner-1",
          name: (calendarBody?.name as string) ?? "Calendar",
          country_code: (calendarBody?.country_code as string | null) ?? null,
          location_id: null,
          is_active: (calendarBody?.is_active as boolean | undefined) ?? true,
          created_at: now,
          updated_at: now,
          location_name: null,
        };
        calendars.push(created);
        await route.fulfill({
          status: 201,
          contentType: "application/json",
          body: JSON.stringify({ calendar: created }),
        });
        return;
      }
      // GET list
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ calendars }),
      });
    });

    await page.route(
      "**/api/public-holidays/calendars/*/holidays",
      async (route) => {
        const url = route.request().url();
        const method = route.request().method();
        const m = url.match(/\/calendars\/(\d+)\/holidays/);
        const calId = m ? Number(m[1]) : null;
        if (method === "POST") {
          holidayCalendarId = calId;
          holidayBody = JSON.parse(route.request().postData() ?? "{}");
          const now = new Date().toISOString();
          const created: Holiday = {
            id: 301,
            calendar_id: calId ?? 0,
            workspace_owner_id: "owner-1",
            name: (holidayBody?.name as string) ?? "Holiday",
            date: (holidayBody?.date as string) ?? "2026-01-01",
            end_date: (holidayBody?.end_date as string | null) ?? null,
            is_paid: (holidayBody?.is_paid as boolean | undefined) ?? true,
            description: null,
            created_by_member_id: OWNER_ID,
            created_at: now,
            updated_at: now,
          };
          holidays.push(created);
          await route.fulfill({
            status: 201,
            contentType: "application/json",
            body: JSON.stringify({ holiday: created }),
          });
          return;
        }
        // GET list of holidays for the calendar
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            holidays: holidays.filter((h) => h.calendar_id === calId),
          }),
        });
      },
    );

    await page.goto("/admin/public-holidays", { waitUntil: "domcontentloaded" });

    await expect(
      page.getByRole("heading", { name: /Public Holidays/i }),
    ).toBeVisible({ timeout: 12_000 });
    await expect(page.getByText(/No holiday calendars yet/i)).toBeVisible({
      timeout: 8_000,
    });

    // Create a calendar
    await page.getByRole("button", { name: /^New Calendar$/ }).click();
    const createDialog = page.getByRole("dialog");
    await expect(createDialog).toBeVisible({ timeout: 5_000 });
    await expect(createDialog.getByText("Create Holiday Calendar")).toBeVisible();

    await createDialog.getByLabel("Calendar name *").fill("US Federal Holidays");
    await createDialog.getByLabel("Country code").fill("US");
    await createDialog.getByRole("button", { name: /^Create$/ }).click();

    await expect.poll(() => calendarBody).not.toBeNull();
    expect(calendarBody).toMatchObject({
      name: "US Federal Holidays",
      country_code: "US",
      is_active: true,
    });

    await expect(createDialog).not.toBeVisible({ timeout: 8_000 });
    await expect(page.getByText("US Federal Holidays")).toBeVisible({
      timeout: 8_000,
    });

    // Expand the calendar card to reveal the Holidays panel.
    await page.getByText("US Federal Holidays").click();

    await expect(page.getByText(/No holidays added yet/i)).toBeVisible({
      timeout: 8_000,
    });

    // Add a holiday
    await page.getByRole("button", { name: /^Add holiday$/ }).click();
    const addDialog = page.getByRole("dialog");
    await expect(addDialog).toBeVisible({ timeout: 5_000 });
    await expect(addDialog.getByText("Add Holiday")).toBeVisible();

    await addDialog.getByLabel("Name *").fill("New Year's Day");
    await addDialog.locator('input[type="date"]').first().fill("2026-01-01");
    await addDialog.getByRole("button", { name: /^Add$/ }).click();

    await expect.poll(() => holidayBody).not.toBeNull();
    expect(holidayCalendarId).toBe(201);
    expect(holidayBody).toMatchObject({
      name: "New Year's Day",
      date: "2026-01-01",
      is_paid: true,
    });

    await expect(addDialog).not.toBeVisible({ timeout: 8_000 });

    // The new holiday is visible in the Holidays panel.
    await expect(page.getByText("New Year's Day")).toBeVisible({
      timeout: 8_000,
    });
    await expect(page.getByText(/Holidays \(1\)/i)).toBeVisible();
  });
});

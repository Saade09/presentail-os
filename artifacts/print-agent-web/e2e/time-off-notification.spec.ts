import { test, expect } from "./fixtures";
import { setupClerkTestingToken } from "@clerk/testing/playwright";
import type { Page } from "@playwright/test";
import { setupTimeOffCommonRoutes } from "./helpers/timeOffCommonRoutes";

const OWNER_ID = 1;
const OWNER_EMAIL = "e2e-tester@presentail.com";
const REQUESTER_ID = 2;
const REQUESTER_EMAIL = "teammate@example.com";
const REQUEST_ID = 711;
const CURRENT_YEAR = new Date().getFullYear();

type Notif = {
  id: number;
  type: string;
  title: string;
  body: string;
  entity_id: number | null;
  is_read: boolean;
  created_at: string;
  actor_email: string;
};

type Persona = "manager" | "requester";

function usersResponseFor(persona: Persona) {
  if (persona === "manager") {
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
        {
          id: REQUESTER_ID,
          email: REQUESTER_EMAIL,
          role: "member",
          custom_role_id: null,
          role_name: null,
          joined: true,
          joined_at: new Date().toISOString(),
          invited_at: new Date().toISOString(),
          invited_by_email: null,
          manager_member_id: OWNER_ID,
          manager_email: OWNER_EMAIL,
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
  return {
    members: [
      {
        id: REQUESTER_ID,
        email: REQUESTER_EMAIL,
        role: "member",
        custom_role_id: null,
        role_name: null,
        joined: true,
        joined_at: new Date().toISOString(),
        invited_at: new Date().toISOString(),
        invited_by_email: null,
        manager_member_id: OWNER_ID,
        manager_email: OWNER_EMAIL,
      },
    ],
    me: {
      role: "member",
      email: REQUESTER_EMAIL,
      // Grant access to /time-off/my so the requester can navigate there
      // and the dashboard Layout (with the notification bell) renders.
      allowedPages: ["time-off"],
      customRoleId: null,
    },
  };
}

function makePendingRequest() {
  return {
    id: REQUEST_ID,
    member_id: REQUESTER_ID,
    member_name: REQUESTER_EMAIL,
    member_email: REQUESTER_EMAIL,
    type_id: 1,
    type_code: "VACATION",
    type_name: "Vacation",
    type_color: "#10b981",
    start_date: `${CURRENT_YEAR}-08-10`,
    end_date: `${CURRENT_YEAR}-08-12`,
    total_days: "3.0",
    half_day: false,
    half_day_period: null,
    reason: "Family trip",
    status: "PENDING",
    manager_note: null,
    vacation_remaining: 15,
    created_at: new Date().toISOString(),
  };
}

async function setupCommonRoutes(
  page: Page,
  ctx: { persona: { current: Persona }; notifications: { current: Notif[] } },
) {
  await setupTimeOffCommonRoutes(page, {
    getUsersResponse: () => usersResponseFor(ctx.persona.current),
    // Only the requester (non-owner) actually fetches notifications;
    // the manager (owner) has the time-off bell disabled in app code.
    getNotifications: () =>
      ctx.persona.current === "requester" ? ctx.notifications.current : [],
    notificationsSeenGetBody: { seenIds: [] },
  });

  // Member-side endpoints required when the requester opens /time-off/my.
  await page.route("**/api/time-off/balance**", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        balance: {
          id: 1,
          member_id: REQUESTER_ID,
          policy_id: 1,
          policy_year: CURRENT_YEAR,
          vacation_entitled: 20,
          vacation_used: 0,
          vacation_pending: 0,
          vacation_carryover: 0,
          vacation_remaining: 20,
          sick_leave_entitled: 10,
          sick_leave_used: 0,
          sick_leave_pending: 0,
          updated_at: new Date().toISOString(),
        },
      }),
    }),
  );

  await page.route("**/api/time-off/requests**", (route) => {
    if (route.request().method() === "GET") {
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ requests: [] }),
      });
      return;
    }
    route.continue();
  });
}

test.describe("Time-off approval/decline notifies the requester", () => {
  test.beforeEach(async ({ page }) => {
    await setupClerkTestingToken({ page });
  });

  test("manager approves; requester sees TIME_OFF_APPROVED on their notification bell", async ({
    page,
  }) => {

    const persona = { current: "manager" as Persona };
    const notifications = { current: [] as Notif[] };
    await setupCommonRoutes(page, { persona, notifications });

    const teamRequests = [makePendingRequest()];
    let approvePostId: number | null = null;

    await page.route("**/api/time-off/team**", async (route) => {
      const url = route.request().url();
      if (url.includes("/team/balances")) {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ balances: [] }),
        });
        return;
      }
      if (route.request().method() !== "GET") {
        await route.continue();
        return;
      }
      const status = new URL(url).searchParams.get("status");
      const filtered = status
        ? teamRequests.filter((r) => r.status === status)
        : teamRequests;
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ requests: filtered }),
      });
    });

    await page.route("**/api/time-off/requests/*/approve", async (route) => {
      if (route.request().method() !== "POST") {
        await route.continue();
        return;
      }
      const m = route.request().url().match(/\/requests\/(\d+)\/approve/);
      approvePostId = m ? Number(m[1]) : null;
      const target = teamRequests.find((r) => r.id === approvePostId);
      if (target) target.status = "APPROVED";
      // Server-side side effect: insert a notification for the requester.
      notifications.current = [
        {
          id: 9001,
          type: "TIME_OFF_APPROVED",
          title: "Vacation request approved",
          body: `${OWNER_EMAIL} approved your vacation request.`,
          entity_id: REQUEST_ID,
          is_read: false,
          created_at: new Date().toISOString(),
          actor_email: OWNER_EMAIL,
        },
      ];
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ ok: true }),
      });
    });

    // --- Phase 1: manager approves ---
    await page.goto("/time-off/approvals", { waitUntil: "domcontentloaded" });
    await expect(
      page.getByRole("heading", { name: /Team Time-Off Approvals/i }),
    ).toBeVisible({ timeout: 12_000 });
    await expect(page.getByText(REQUESTER_EMAIL).first()).toBeVisible({
      timeout: 10_000,
    });

    await page.getByRole("button", { name: /^Approve$/ }).click();
    await expect.poll(() => approvePostId).toBe(REQUEST_ID);
    await expect.poll(() => notifications.current.length).toBe(1);

    // --- Phase 2: switch to requester persona and verify their bell ---
    persona.current = "requester";
    await page.goto("/time-off/my", { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading", { name: /Time Off/i })).toBeVisible({
      timeout: 12_000,
    });

    const bell = page.getByTestId("notification-bell");
    await expect(bell).toBeVisible({ timeout: 8_000 });
    // The unread badge is rendered for the new TIME_OFF_APPROVED notification.
    await expect(page.getByTestId("notification-badge")).toBeVisible({
      timeout: 8_000,
    });

    await bell.click();
    await expect(
      page.getByText(/Vacation request approved/i).first(),
    ).toBeVisible({ timeout: 8_000 });
    await expect(
      page
        .getByText(new RegExp(`${OWNER_EMAIL} approved your vacation request`, "i"))
        .first(),
    ).toBeVisible();
  });

  test("manager declines with note; requester sees TIME_OFF_DECLINED with the manager note on their bell", async ({
    page,
  }) => {
    const persona = { current: "manager" as Persona };
    const notifications = { current: [] as Notif[] };
    await setupCommonRoutes(page, { persona, notifications });

    const teamRequests = [makePendingRequest()];
    let declineBody: Record<string, unknown> | null = null;
    let declinePostId: number | null = null;

    await page.route("**/api/time-off/team**", async (route) => {
      const url = route.request().url();
      if (url.includes("/team/balances")) {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ balances: [] }),
        });
        return;
      }
      if (route.request().method() !== "GET") {
        await route.continue();
        return;
      }
      const status = new URL(url).searchParams.get("status");
      const filtered = status
        ? teamRequests.filter((r) => r.status === status)
        : teamRequests;
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ requests: filtered }),
      });
    });

    await page.route("**/api/time-off/requests/*/decline", async (route) => {
      if (route.request().method() !== "POST") {
        await route.continue();
        return;
      }
      const m = route.request().url().match(/\/requests\/(\d+)\/decline/);
      declinePostId = m ? Number(m[1]) : null;
      declineBody = JSON.parse(route.request().postData() ?? "{}");
      const note = (declineBody?.managerNote as string | null) ?? null;
      const target = teamRequests.find((r) => r.id === declinePostId);
      if (target) {
        target.status = "DECLINED";
        target.manager_note = note;
      }
      notifications.current = [
        {
          id: 9002,
          type: "TIME_OFF_DECLINED",
          title: "Vacation request declined",
          body: note
            ? `${OWNER_EMAIL} declined your vacation request: "${note}"`
            : `${OWNER_EMAIL} declined your vacation request.`,
          entity_id: REQUEST_ID,
          is_read: false,
          created_at: new Date().toISOString(),
          actor_email: OWNER_EMAIL,
        },
      ];
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ ok: true }),
      });
    });

    // --- Phase 1: manager declines ---
    await page.goto("/time-off/approvals", { waitUntil: "domcontentloaded" });
    await expect(
      page.getByRole("heading", { name: /Team Time-Off Approvals/i }),
    ).toBeVisible({ timeout: 12_000 });
    await expect(page.getByText(REQUESTER_EMAIL).first()).toBeVisible({
      timeout: 10_000,
    });

    await page.getByRole("button", { name: /^Decline$/ }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible({ timeout: 5_000 });
    await dialog.locator("#manager-note").fill("Conflicts with launch week");
    await dialog.getByRole("button", { name: /Confirm Decline/i }).click();

    await expect.poll(() => declinePostId).toBe(REQUEST_ID);
    expect(declineBody).toMatchObject({ managerNote: "Conflicts with launch week" });
    await expect.poll(() => notifications.current.length).toBe(1);

    // --- Phase 2: switch to requester persona and verify their bell ---
    persona.current = "requester";
    await page.goto("/time-off/my", { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading", { name: /Time Off/i })).toBeVisible({
      timeout: 12_000,
    });

    const bell = page.getByTestId("notification-bell");
    await expect(bell).toBeVisible({ timeout: 8_000 });
    await expect(page.getByTestId("notification-badge")).toBeVisible({
      timeout: 8_000,
    });

    await bell.click();
    await expect(
      page.getByText(/Vacation request declined/i).first(),
    ).toBeVisible({ timeout: 8_000 });
    await expect(
      page.getByText(/Conflicts with launch week/i).first(),
    ).toBeVisible();
  });
});

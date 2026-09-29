import { test, expect } from "./fixtures";
import { setupClerkTestingToken } from "@clerk/testing/playwright";
import type { Page } from "@playwright/test";
import { setupTimeOffCommonRoutes } from "./helpers/timeOffCommonRoutes";

const OWNER_ID = 1;
const OWNER_EMAIL = "e2e-tester@presentail.com";
const REQUESTER_ID = 2;
const REQUESTER_EMAIL = "teammate@example.com";
const REQUEST_ID = 8801;
const CURRENT_YEAR = new Date().getFullYear();

type Persona = "manager" | "requester";

type ProfileData = {
  phone: string | null;
  job_title: string | null;
  birthday: string | null;
  gender: string | null;
  notify_email_on_time_off_request: boolean;
  notify_email_on_time_off_decision: boolean;
};

type SentEmail = {
  toEmail: string;
  status: "APPROVED" | "DECLINED";
  requestId: number;
};

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
    start_date: `${CURRENT_YEAR}-09-10`,
    end_date: `${CURRENT_YEAR}-09-12`,
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

interface TestState {
  persona: { current: Persona };
  profile: ProfileData;
  sentEmails: SentEmail[];
  patchedProfileBodies: Array<Partial<ProfileData>>;
}

async function setupCommonRoutes(page: Page, state: TestState) {
  await setupTimeOffCommonRoutes(page, {
    getUsersResponse: () => usersResponseFor(state.persona.current),
    notificationsSeenGetBody: { seenIds: [] },
  });

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

  // Profile GET/PATCH for both personas. The PATCH simulates server-side
  // persistence so the Approve mock below can read the current value of the
  // employee's email opt-out preference.
  await page.route("**/api/profile**", async (route) => {
    const method = route.request().method();
    if (method === "GET") {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(state.profile),
      });
      return;
    }
    if (method === "PATCH") {
      const body = JSON.parse(route.request().postData() ?? "{}") as Partial<ProfileData>;
      state.patchedProfileBodies.push(body);
      state.profile = { ...state.profile, ...body };
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(state.profile),
      });
      return;
    }
    await route.continue();
  });

  // Member-side GET /time-off/requests returns empty.
  await page.route("**/api/time-off/requests**", (route) => {
    const url = route.request().url();
    // Don't intercept the POST /approve or /decline subpaths.
    if (url.includes("/approve") || url.includes("/decline")) {
      route.continue();
      return;
    }
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

async function setupManagerRoutes(
  page: Page,
  state: TestState,
  teamRequests: ReturnType<typeof makePendingRequest>[],
) {
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
    const id = m ? Number(m[1]) : null;
    const target = teamRequests.find((r) => r.id === id);
    if (target) target.status = "APPROVED";

    // Simulate the server-side opt-out branch in
    // PATCH /time-off/requests/:id/status (and the equivalent /approve route):
    // only "queue" a decision email when the target employee has not opted out.
    if (state.profile.notify_email_on_time_off_decision) {
      state.sentEmails.push({
        toEmail: REQUESTER_EMAIL,
        status: "APPROVED",
        requestId: id ?? -1,
      });
    }

    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ ok: true }),
    });
  });
}

test.describe("Employee opt-out skips time-off decision email", () => {
  test.beforeEach(async ({ page }) => {
    await setupClerkTestingToken({ page });
  });

  test("opting out prevents the decision email when the manager approves", async ({
    page,
  }) => {

    const state: TestState = {
      persona: { current: "requester" },
      profile: {
        phone: null,
        job_title: null,
        birthday: null,
        gender: null,
        notify_email_on_time_off_request: true,
        notify_email_on_time_off_decision: true,
      },
      sentEmails: [],
      patchedProfileBodies: [],
    };
    await setupCommonRoutes(page, state);

    const teamRequests = [makePendingRequest()];
    await setupManagerRoutes(page, state, teamRequests);

    // --- Phase 1: requester opts out of decision emails on Profile page. ---
    await page.goto("/profile", { waitUntil: "domcontentloaded" });
    await expect(
      page.getByRole("heading", { name: /^Profile$/ }),
    ).toBeVisible({ timeout: 15_000 });

    const toggle = page.getByTestId("toggle-notify-time-off-decision-email");
    await expect(toggle).toBeVisible({ timeout: 10_000 });
    await expect(toggle).toHaveAttribute("data-state", "checked");

    await toggle.click();

    await expect
      .poll(() =>
        state.patchedProfileBodies.some(
          (b) => b.notify_email_on_time_off_decision === false,
        ),
      )
      .toBe(true);
    expect(state.profile.notify_email_on_time_off_decision).toBe(false);
    await expect(toggle).toHaveAttribute("data-state", "unchecked");

    // --- Phase 2: switch to manager persona and approve the pending request. ---
    state.persona.current = "manager";
    await page.goto("/time-off/approvals", { waitUntil: "domcontentloaded" });
    await expect(
      page.getByRole("heading", { name: /Team Time-Off Approvals/i }),
    ).toBeVisible({ timeout: 12_000 });
    await expect(page.getByText(REQUESTER_EMAIL).first()).toBeVisible({
      timeout: 10_000,
    });

    await page.getByRole("button", { name: /^Approve$/ }).click();

    await expect
      .poll(() => teamRequests[0].status)
      .toBe("APPROVED");

    // No decision email should have been queued/sent for the opted-out employee.
    expect(state.sentEmails).toHaveLength(0);
  });

  test("with the toggle on (default), the decision email IS sent on approve", async ({
    page,
  }) => {
    const state: TestState = {
      persona: { current: "requester" },
      profile: {
        phone: null,
        job_title: null,
        birthday: null,
        gender: null,
        notify_email_on_time_off_request: true,
        notify_email_on_time_off_decision: true,
      },
      sentEmails: [],
      patchedProfileBodies: [],
    };
    await setupCommonRoutes(page, state);

    const teamRequests = [makePendingRequest()];
    await setupManagerRoutes(page, state, teamRequests);

    // --- Phase 1: requester visits Profile and confirms the toggle is on,
    // without changing it. ---
    await page.goto("/profile", { waitUntil: "domcontentloaded" });
    await expect(
      page.getByRole("heading", { name: /^Profile$/ }),
    ).toBeVisible({ timeout: 15_000 });
    const toggle = page.getByTestId("toggle-notify-time-off-decision-email");
    await expect(toggle).toBeVisible({ timeout: 10_000 });
    await expect(toggle).toHaveAttribute("data-state", "checked");
    expect(state.profile.notify_email_on_time_off_decision).toBe(true);

    // --- Phase 2: manager approves; decision email should be queued. ---
    state.persona.current = "manager";
    await page.goto("/time-off/approvals", { waitUntil: "domcontentloaded" });
    await expect(
      page.getByRole("heading", { name: /Team Time-Off Approvals/i }),
    ).toBeVisible({ timeout: 12_000 });
    await expect(page.getByText(REQUESTER_EMAIL).first()).toBeVisible({
      timeout: 10_000,
    });

    await page.getByRole("button", { name: /^Approve$/ }).click();

    await expect
      .poll(() => teamRequests[0].status)
      .toBe("APPROVED");

    await expect.poll(() => state.sentEmails.length).toBe(1);
    expect(state.sentEmails[0]).toMatchObject({
      toEmail: REQUESTER_EMAIL,
      status: "APPROVED",
      requestId: REQUEST_ID,
    });
  });
});

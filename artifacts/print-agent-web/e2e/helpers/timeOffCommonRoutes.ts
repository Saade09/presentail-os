import type { Page } from "@playwright/test";

export const DEFAULT_OWNER_ID = 1;
export const DEFAULT_OWNER_EMAIL = "e2e-tester@presentail.com";

export function ownerUsersResponse() {
  return {
    members: [
      {
        id: DEFAULT_OWNER_ID,
        email: DEFAULT_OWNER_EMAIL,
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
      email: DEFAULT_OWNER_EMAIL,
      allowedPages: null,
      customRoleId: null,
    },
  };
}

export interface TimeOffCommonRoutesOptions {
  /**
   * Called on GET /api/users.
   * Default: single-owner workspace (ownerUsersResponse()).
   */
  getUsersResponse?: () => unknown;
  /**
   * Called on GET /api/time-off/notifications (excluding /seen and /events sub-paths).
   * Default: returns an empty array.
   */
  getNotifications?: () => unknown[];
  /**
   * Body for GET /api/notifications/seen.
   * Default: { ok: true }.  Use { seenIds: [] } for tests that read the seen list.
   */
  notificationsSeenGetBody?: unknown;
  /**
   * When true, also mocks GET /api/time-off/team/balances with an empty balances list.
   * Required by approvals and reviewer pages that request team balance data.
   */
  includeTeamBalances?: boolean;
}

/**
 * Registers the route mocks that every time-off spec needs:
 *  - /api/users/failed-access-requests  → { failedRequests: [] }
 *  - GET /api/users                      → getUsersResponse() (default: single owner)
 *  - /api/access-requests                → { requests: [] }
 *  - /api/notifications/seen             → { ok: true } (POST) / notificationsSeenGetBody (GET)
 *  - /api/time-off/notifications/events  → empty event-stream
 *  - /api/time-off/notifications/seen    → { ok: true }
 *  - /api/time-off/notifications         → { notifications: getNotifications() }
 *  - /api/time-off/team/balances         → { balances: [] }  (only when includeTeamBalances)
 */
export async function setupTimeOffCommonRoutes(
  page: Page,
  opts: TimeOffCommonRoutesOptions = {},
): Promise<void> {
  const {
    getUsersResponse = ownerUsersResponse,
    getNotifications = () => [],
    notificationsSeenGetBody = { ok: true },
    includeTeamBalances = false,
  } = opts;

  await page.route("**/api/users**", async (route) => {
    const url = route.request().url();
    // Only intercept the exact /api/users endpoint, not sub-paths like
    // /api/users/failed-access-requests.  Playwright LIFO ordering means
    // this broad route can win over the more specific one below if we do
    // not guard the pathname.
    if (
      route.request().method() === "GET" &&
      (url.endsWith("/api/users") || url.endsWith("/api/users/"))
    ) {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(getUsersResponse()),
      });
      return;
    }
    await route.continue();
  });

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

  await page.route("**/api/notifications/seen**", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(
        route.request().method() === "POST" ? { ok: true } : notificationsSeenGetBody,
      ),
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
      body: JSON.stringify({ notifications: getNotifications() }),
    });
  });

  if (includeTeamBalances) {
    await page.route("**/api/time-off/team/balances**", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ balances: [] }),
      }),
    );
  }
}

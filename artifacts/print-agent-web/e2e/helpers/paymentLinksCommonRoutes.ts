import type { Page } from "@playwright/test";

export const DEFAULT_OWNER_EMAIL = "e2e-tester@presentail.com";
export const DEFAULT_SETTINGS_COUNTRIES = ["UAE", "UK", "USA"];

export function ownerUsersResponse(email = DEFAULT_OWNER_EMAIL) {
  return {
    members: [
      {
        id: 1,
        email,
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
      email,
      allowedPages: null,
      customRoleId: null,
    },
  };
}

export function memberUsersResponse() {
  return {
    members: [
      {
        id: 2,
        email: "member@presentail.com",
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
      email: "member@presentail.com",
      allowedPages: null,
      customRoleId: null,
    },
  };
}

export function emptyPaymentLinksResponse() {
  return { payment_links: [] };
}

export function settingsResponse(countries = DEFAULT_SETTINGS_COUNTRIES) {
  return { available_countries: countries };
}

export interface PaymentLinksCommonRoutesOptions {
  /**
   * Called on GET /api/users.
   * Default: single-owner workspace (ownerUsersResponse()).
   */
  getUsersResponse?: () => unknown;
  /**
   * Called on GET /api/settings.
   * Default: settingsResponse() with DEFAULT_SETTINGS_COUNTRIES.
   */
  getSettingsResponse?: () => unknown;
}

/**
 * Registers the route mocks that every payment-links spec needs:
 *  - GET /api/users    → getUsersResponse() (default: single-owner workspace)
 *  - GET /api/settings → getSettingsResponse() (default: UAE/UK/USA countries)
 */
export async function setupPaymentLinksCommonRoutes(
  page: Page,
  opts: PaymentLinksCommonRoutesOptions = {},
): Promise<void> {
  const {
    getUsersResponse = ownerUsersResponse,
    getSettingsResponse = settingsResponse,
  } = opts;

  await page.route("**/api/users**", async (route) => {
    if (route.request().method() === "GET") {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(getUsersResponse()),
      });
      return;
    }
    await route.continue();
  });

  await page.route("**/api/settings**", async (route) => {
    if (route.request().method() === "GET") {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(getSettingsResponse()),
      });
      return;
    }
    await route.continue();
  });
}

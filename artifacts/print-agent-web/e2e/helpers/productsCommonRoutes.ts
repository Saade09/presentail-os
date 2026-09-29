import type { Page } from "@playwright/test";

export const DEFAULT_OWNER_EMAIL = "e2e-tester@presentail.com";

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

export interface ProductsCommonRoutesOptions {
  /**
   * Called on GET /api/users.
   * Default: single-owner workspace (ownerUsersResponse()).
   */
  getUsersResponse?: () => unknown;
}

/**
 * Registers the route mock that every products spec needs:
 *  - GET /api/users → getUsersResponse() (default: single-owner workspace)
 */
export async function setupProductsCommonRoutes(
  page: Page,
  opts: ProductsCommonRoutesOptions = {},
): Promise<void> {
  const { getUsersResponse = ownerUsersResponse } = opts;

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
}

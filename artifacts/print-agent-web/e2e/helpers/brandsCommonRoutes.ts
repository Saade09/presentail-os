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

export const BRAND_DETAIL_DEFAULTS = {
  stickers: { stickers: [] as unknown[] },
  coverPhotos: { coverPhotos: [] as unknown[] },
  channels: { channels: [] as unknown[] },
  cogsSummary: { target_cogs: null, actual_cogs: null, completed_job_count: 0 },
  logos: { logos: [] as unknown[] },
  cogsTrend: { granularity: "month", target_cogs: null, periods: [] as unknown[] },
};

export interface BrandDetailSubRoutesOptions {
  /**
   * Brand ID to scope sub-routes to. Default: 1.
   */
  brandId?: number;
  /** Override for GET /api/brands/:id/stickers. Default: empty stickers list. */
  stickers?: object;
  /** Override for GET /api/brands/:id/cover-photos. Default: empty list. */
  coverPhotos?: object;
  /** Override for GET /api/channels. Default: empty channels list. */
  channels?: object;
  /** Override for GET /api/brands/:id/cogs-summary. Default: nulls + 0 count. */
  cogsSummary?: object;
  /** Override for GET /api/brands/:id/logos. Default: empty logos list. */
  logos?: object;
  /** Override for GET /api/brands/:id/cogs-trend. Default: empty periods. */
  cogsTrend?: object;
}

/**
 * Registers mock routes for the brand detail page sub-resources:
 *  - GET /api/brands/:brandId/stickers
 *  - GET /api/brands/:brandId/cover-photos
 *  - GET /api/channels
 *  - GET /api/brands/:brandId/cogs-summary
 *  - GET /api/brands/:brandId/logos
 *  - GET /api/brands/:brandId/cogs-trend
 *
 * The brand-level endpoint (/api/brands/:brandId) itself is intentionally
 * excluded because many tests need custom GET/PATCH handling.
 */
export async function setupBrandDetailSubRoutes(
  page: Page,
  opts: BrandDetailSubRoutesOptions = {},
): Promise<void> {
  const {
    brandId = 1,
    stickers = BRAND_DETAIL_DEFAULTS.stickers,
    coverPhotos = BRAND_DETAIL_DEFAULTS.coverPhotos,
    channels = BRAND_DETAIL_DEFAULTS.channels,
    cogsSummary = BRAND_DETAIL_DEFAULTS.cogsSummary,
    logos = BRAND_DETAIL_DEFAULTS.logos,
    cogsTrend = BRAND_DETAIL_DEFAULTS.cogsTrend,
  } = opts;

  await page.route(`**/api/brands/${brandId}/stickers**`, (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(stickers),
    }),
  );

  await page.route(`**/api/brands/${brandId}/cover-photos**`, (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(coverPhotos),
    }),
  );

  await page.route("**/api/channels**", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(channels),
    }),
  );

  await page.route(`**/api/brands/${brandId}/cogs-summary**`, (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(cogsSummary),
    }),
  );

  await page.route(`**/api/brands/${brandId}/logos**`, (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(logos),
    }),
  );

  await page.route(`**/api/brands/${brandId}/cogs-trend**`, (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(cogsTrend),
    }),
  );
}

export interface BrandsCommonRoutesOptions {
  /**
   * Called on GET /api/users.
   * Default: single-owner workspace (ownerUsersResponse()).
   */
  getUsersResponse?: () => unknown;
}

/**
 * Registers the route mock that every brands spec needs:
 *  - GET /api/users → getUsersResponse() (default: single-owner workspace)
 */
export async function setupBrandsCommonRoutes(
  page: Page,
  opts: BrandsCommonRoutesOptions = {},
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

/**
 * Single source of truth for post-login redirect destinations.
 *
 * HomeRedirect (App.tsx) and the e2e global setup (e2e/global-setup.ts) both
 * need to know which URLs a user may land on after signing in.  Keeping the
 * list here means adding a new role/redirect requires updating only this file.
 */

import { z } from "zod";

/** The allowedPages key that sends a member to the project-manager dashboard. */
export const PROJECT_MANAGER_PAGE_KEY = "project-manager-dashboard";
/** The allowedPages key that sends an explicitly permitted member to Ops. */
export const OPS_DASHBOARD_PAGE_KEY = "ops-dashboard";

/**
 * Every URL path that any role can be redirected to after a successful sign-in.
 * The first entry is the default destination (used as the fallback in HomeRedirect).
 */
export const POST_LOGIN_ROUTES = [
  "/devices",
  "/project-manager-dashboard",
  "/ops-dashboard",
] as const;

export function getDashboardLanding(
  allowedPages: readonly string[] | null,
): (typeof POST_LOGIN_ROUTES)[number] {
  if (allowedPages?.includes(OPS_DASHBOARD_PAGE_KEY)) {
    return `/${OPS_DASHBOARD_PAGE_KEY}`;
  }
  if (allowedPages?.includes(PROJECT_MANAGER_PAGE_KEY)) {
    return `/${PROJECT_MANAGER_PAGE_KEY}`;
  }
  return POST_LOGIN_ROUTES[0];
}

/**
 * The allowedPages keys that correspond to post-login redirect destinations,
 * derived from POST_LOGIN_ROUTES by stripping the leading "/".
 *
 * Using a Zod enum here means any new route added to POST_LOGIN_ROUTES
 * is automatically included in the schema — no separate list to maintain.
 */
const POST_LOGIN_PAGE_KEYS = POST_LOGIN_ROUTES.map((r) =>
  r.replace(/^\//, ""),
) as [string, ...string[]];

export const postLoginPageKeySchema = z.enum(POST_LOGIN_PAGE_KEYS);
export type PostLoginPageKey = z.infer<typeof postLoginPageKeySchema>;

/**
 * A RegExp that matches any of the post-login route paths.
 * Suitable for use with Playwright's `page.waitForURL()`.
 *
 * Example match: "https://example.com/devices?foo=bar"
 */
export const POST_LOGIN_URL_PATTERN = new RegExp(
  `/(${POST_LOGIN_ROUTES.map((r) => r.replace(/^\//, "")).join("|")})`,
);

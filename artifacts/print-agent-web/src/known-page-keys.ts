/**
 * Page key schema for the web frontend.
 *
 * The canonical data (ALL_PAGES, SUB_PERMISSION_LABELS, VALID_PAGE_KEYS, and
 * validateAllowedPages) lives in the shared @workspace/page-keys library, which
 * the API server also imports. All page key additions must be made in
 * lib/page-keys/src/index.ts — that is the single source of truth.
 *
 * This file's only job is to build the frontend-specific Zod schema that also
 * folds in the post-login redirect page keys from post-login-routes.ts.
 *
 * Rules for adding a new page:
 *  1. Add it to ALL_PAGES (top-level pages) or SUB_PERMISSION_LABELS (sub-permissions)
 *     inside lib/page-keys/src/index.ts — no changes needed here.
 *  2. If the page is also a post-login redirect destination, add the corresponding
 *     route to POST_LOGIN_ROUTES in post-login-routes.ts.
 *  3. The allowedPageKeySchema below is derived automatically — no separate
 *     list to maintain here.
 */

import { z } from "zod";
import {
  ALL_PAGES,
  SUB_PERMISSION_LABELS,
  isValidPageKey,
} from "@workspace/page-keys";
import { postLoginPageKeySchema } from "./post-login-routes";

export { ALL_PAGES, SUB_PERMISSION_LABELS, isValidPageKey };

/**
 * Zod schema that accepts every valid allowedPages item.
 *
 * The enum is derived from the two canonical lists in @workspace/page-keys plus
 * the post-login route page keys from post-login-routes.ts. Validating the
 * /api/users response against this schema surfaces any typo — such as
 * "project_manager_dashboard" instead of "project-manager-dashboard" — as a
 * parse error rather than a silent wrong redirect.
 */
const ALL_VALID_PAGE_KEYS = [
  ...ALL_PAGES.map((p) => p.key),
  ...Object.keys(SUB_PERMISSION_LABELS),
  ...postLoginPageKeySchema.options,
].filter((v, i, arr) => arr.indexOf(v) === i) as [string, ...string[]];

export const allowedPageKeySchema = z.enum(ALL_VALID_PAGE_KEYS);
export type AllowedPageKey = z.infer<typeof allowedPageKeySchema>;

/**
 * Page key validation for the API server.
 *
 * The canonical key data and validator live in the shared @workspace/page-keys
 * library, which the web frontend also imports. All page key additions must be
 * made in lib/page-keys/src/index.ts — that is the single source of truth.
 */

export {
  VALID_PAGE_KEYS,
  isValidPageKey,
  validateAllowedPages,
} from "@workspace/page-keys";

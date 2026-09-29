/**
 * E2E helper for testing authenticated tab screens without a real Clerk session.
 *
 * ## Strategy
 *
 * Attempting to return a synthetic signed-in Clerk FAPI response causes
 * "@clerk/react: Invalid state" — the SDK strictly validates session shapes.
 * Instead this helper:
 *
 *   1. Uses `mockClerkNoSession` (proven-safe) so Clerk initialises with
 *      `isSignedIn = false` and no errors.
 *   2. Injects `localStorage.__e2e_auth_bypass = "1"` via `page.addInitScript`
 *      before the first navigation.
 *
 * The tabs layout (`app/(tabs)/_layout.tsx`) checks **two independent guards**
 * before bypassing the auth redirect:
 *   • `EXPO_PUBLIC_E2E_HARNESS === "1"` — a compile-time env var baked into
 *     the Metro bundle by the Playwright webServer env.  Absent in production
 *     builds, so users can never enable the bypass at runtime.
 *   • `localStorage.__e2e_auth_bypass === "1"` — per-test opt-in set here.
 *     Existing auth-flow tests that don't call mockClerkSession never set this
 *     key and continue to redirect to the sign-in screen normally.
 *
 * Usage (call BEFORE page.goto):
 *   await mockClerkSession(page);
 *   await page.goto("/team");
 */
import { type Page } from "@playwright/test";
import { mockClerkNoSession } from "./clerk-no-session-mock";

/**
 * Sets up Clerk FAPI interceptors (no-session, safe initialisation) and
 * injects the per-test localStorage bypass key via `addInitScript`.
 */
export async function mockClerkSession(page: Page): Promise<void> {
  await mockClerkNoSession(page);

  await page.addInitScript(() => {
    try {
      window.localStorage.setItem("__e2e_auth_bypass", "1");
    } catch {
      // localStorage may be blocked in some contexts — fail silently.
    }
  });
}

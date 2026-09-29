/**
 * Clerk FAPI mock for unauthenticated e2e tests.
 *
 * The Expo app wraps everything in `<ClerkLoaded>`, which only renders its
 * children once Clerk has completed its initialization sequence (GET
 * /v1/environment + GET /v1/client).  Without a real Clerk FAPI connection,
 * the app renders nothing and every test times out waiting for elements.
 *
 * This helper intercepts all requests to Clerk domains BEFORE page.goto() is
 * called, returning minimal mock responses that let Clerk initialize quickly:
 *
 *   - GET /v1/client       → empty client (sessions: []) → isSignedIn: false
 *   - POST /v1/client/sign_ins → 422 Clerk error (triggers the app's catch
 *       block so "forgot-error-message" and similar error elements appear)
 *   - All other FAPI calls → {} (Clerk tolerates empty JSON for minor calls)
 *
 * With these mocks in place:
 *   - ClerkLoaded renders immediately
 *   - isSignedIn is false → auth layout shows sign-in screens
 *   - No real network call is made to Clerk's FAPI
 *   - Mutation calls (forgot-password submit) produce a visible error message
 *
 * Usage (call BEFORE page.goto):
 *   await mockClerkNoSession(page);
 *   await page.goto("/");
 *
 * Note on Playwright route ordering: routes registered last are evaluated
 * first (LIFO).  Using a single unified handler avoids ordering bugs where a
 * catch-all inadvertently intercepts more-specific paths.
 */
import { type Page } from "@playwright/test";

function buildEmptyClientResponse(): object {
  const nowMs = Date.now();
  return {
    response: {
      object: "client",
      id: "client_mock_empty",
      sessions: [],
      sign_in: null,
      sign_up: null,
      last_active_session_id: null,
      created_at: nowMs - 3_600_000,
      updated_at: nowMs,
    },
    client: {
      object: "client",
      id: "client_mock_empty",
      sessions: [],
      sign_in: null,
      sign_up: null,
      last_active_session_id: null,
      created_at: nowMs - 3_600_000,
      updated_at: nowMs,
    },
  };
}

/**
 * Clerk FAPI error shape returned for mutation calls.
 * The Clerk JS SDK throws ClerkAPIResponseError for 4xx responses; the app's
 * catch blocks call err.message which surfaces the first errors[].message.
 */
function buildClerkError(message: string, code = "form_identifier_not_found"): object {
  return {
    errors: [
      {
        code,
        message,
        long_message: message,
        meta: { param_name: "identifier" },
      },
    ],
    clerk_trace_id: "mock_trace_id",
  };
}

/**
 * Intercepts all Clerk FAPI requests in a single route handler to avoid LIFO
 * ordering bugs with multiple registered routes.
 */
export async function mockClerkNoSession(page: Page): Promise<void> {
  await page.route(
    (url) => url.hostname.includes("clerk") && url.pathname.startsWith("/v1/"),
    async (route) => {
      const reqUrl = route.request().url();
      const method = route.request().method();

      const isGetClient =
        method === "GET" && /\/v1\/client(\?|$)/.test(reqUrl);

      // POST to sign_ins is the password-reset / sign-in attempt endpoint.
      // Return a 422 so the app's catch block fires and shows an error message.
      const isPostSignIns =
        method === "POST" && /\/v1\/client\/sign_ins/.test(reqUrl);

      const origin = route.request().headers()["origin"] ?? "";
      const corsHeaders: Record<string, string> = origin
        ? {
            "access-control-allow-origin": origin,
            "access-control-allow-credentials": "true",
          }
        : {};

      if (isGetClient) {
        // Primary session-state endpoint — return empty client so ClerkLoaded
        // resolves with isSignedIn: false (shows welcome/sign-in screens).
        await route.fulfill({
          status: 200,
          headers: { "content-type": "application/json", ...corsHeaders },
          body: JSON.stringify(buildEmptyClientResponse()),
        });
      } else if (isPostSignIns) {
        // Mutation call for forgot-password / sign-in attempts.
        // A 422 with a Clerk-format error body causes the SDK to throw
        // ClerkAPIResponseError, which the app catches and displays.
        await route.fulfill({
          status: 422,
          headers: { "content-type": "application/json", ...corsHeaders },
          body: JSON.stringify(
            buildClerkError("Couldn't find your account."),
          ),
        });
      } else {
        // All other FAPI calls (environment, jwks, telemetry, …).
        // Return 200 {} — Clerk tolerates empty responses for secondary calls.
        await route.fulfill({
          status: 200,
          headers: { "content-type": "application/json", ...corsHeaders },
          body: JSON.stringify({}),
        });
      }
    },
  );
}

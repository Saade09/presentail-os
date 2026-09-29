import { clerkSetup } from "@clerk/testing/playwright";
import { createClerkClient } from "@clerk/backend";
import { isClerkAPIResponseError } from "@clerk/backend/errors";
import pg from "pg";
import path from "path";
import fs from "fs";
import { createServerSession } from "./clerk-fapi-redirect";
import { seedAndPersistProtectedRouteIds } from "./seed-protected-routes";

export const STORAGE_STATE_PATH = path.join(
  import.meta.dirname,
  ".auth-state.json",
);

// Must contain "+clerk_test" so Clerk's testing library accepts the
// email_code strategy with OTP "424242" (no real email delivery needed).
export const TEST_USER_EMAIL = "e2e-tester+clerk_test@presentail.com";

export default async function globalSetup() {
  // In Playwright mode the Vite dev server is started with
  // VITE_CLERK_PUBLISHABLE_KEY overridden to CLERK_PUBLISHABLE_KEY (a test
  // instance key, pk_test_…).  CLERK_SECRET_KEY (sk_test_…) belongs to the
  // same test Clerk instance.
  //
  // Authentication strategy:
  //
  //   1. Create a short-lived sign-in token for the test user (Backend API).
  //   2. Redeem it via a server-side fetch to FAPI (becoming-man-73) with
  //      __clerk_testing_token to bypass the dev-browser check.
  //      CRITICAL: Do NOT include an Origin header — that marks the request
  //      as a browser request and causes 401 dev_browser_unauthenticated
  //      even when __clerk_testing_token is present.
  //   3. Write the resulting sessionId to .auth-session.json so the
  //      setupFapiWithMockSession fixture can generate fresh JWTs.
  //
  // Each test gets a mocked GET /v1/client response (via the _fapiMock auto
  // fixture in fixtures.ts), so tests do not need real __session cookies.
  // Prefer the test-instance key (VITE_CLERK_PUBLISHABLE_KEY, pk_test_…) so
  // that the FAPI host resolves to the test Clerk instance rather than the
  // production custom domain (clerk.presentail.com).  CLERK_SECRET_KEY is
  // always the test secret key, so the sign-in tokens it issues are only valid
  // against the same test FAPI — using the live publishable key causes
  // "ticket_invalid_code" when global-setup tries to redeem them.
  const publishableKey =
    process.env.VITE_CLERK_PUBLISHABLE_KEY ?? process.env.CLERK_PUBLISHABLE_KEY;
  const secretKey = process.env.CLERK_SECRET_KEY;

  if (!secretKey || !publishableKey) {
    throw new Error(
      "CLERK_SECRET_KEY and (VITE_CLERK_PUBLISHABLE_KEY or CLERK_PUBLISHABLE_KEY) are required for e2e tests",
    );
  }

  // clerkSetup sets CLERK_TESTING_TOKEN via the @clerk/testing helpers.
  // We also obtain it directly from the API and explicitly set it so that
  // later code (setupFapiRedirect) always finds it — even if clerkSetup
  // sets it under a slightly different env-var name in some versions.
  await clerkSetup({ publishableKey });

  const testingTokenRes = await fetch("https://api.clerk.com/v1/testing_tokens", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${secretKey}`,
      "Content-Type": "application/json",
    },
  });
  if (!testingTokenRes.ok) {
    throw new Error(`Failed to get testing token: ${testingTokenRes.status}`);
  }
  const { token: testingToken } = (await testingTokenRes.json()) as { token: string };
  process.env.CLERK_TESTING_TOKEN = testingToken;
  console.log("[global-setup] Clerk testing token obtained");

  const clerkClient = createClerkClient({ secretKey });

  const existing = await clerkClient.users.getUserList({
    emailAddress: [TEST_USER_EMAIL],
  });

  let userId: string;
  if (existing.data.length > 0) {
    userId = existing.data[0].id;
  } else {
    const user = await clerkClient.users.createUser({
      emailAddress: [TEST_USER_EMAIL],
      firstName: "E2E",
      lastName: "Tester",
      skipPasswordRequirement: true,
      skipPasswordChecks: true,
    });
    userId = user.id;
  }

  try {
    await clerkClient.users.deleteUserProfileImage({ userId });
  } catch (err) {
    if (isClerkAPIResponseError(err) && err.status === 404) {
      // no-op: no profile image was set — nothing to clean up
    } else {
      throw err;
    }
  }

  if (process.env.DATABASE_URL) {
    const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
    try {
      await pool.query(
        `UPDATE workspace_members
            SET phone = NULL, job_title = NULL
          WHERE member_user_id = $1`,
        [userId],
      );
    } finally {
      await pool.end();
    }
  }

  // Seed a known set of records (one brand, location, product, base item,
  // customer) so the protected-route smoke tests in avatar-dropdown.spec.ts
  // navigate to URLs with real IDs instead of the literal "1". Skips
  // gracefully when DATABASE_URL is not set.
  await seedAndPersistProtectedRouteIds(userId);

  // Reuse the existing session file when it was written recently (within the
  // last 12 hours) AND contains a sessionId.  This avoids creating a new
  // server-side session on every run.
  const AUTH_SESSION_PATH = path.join(import.meta.dirname, ".auth-session.json");
  const AUTH_STATE_MAX_AGE_MS = 12 * 60 * 60 * 1000;
  let sessionIsRecent = false;
  try {
    const stat = fs.statSync(AUTH_SESSION_PATH);
    const raw = fs.readFileSync(AUTH_SESSION_PATH, "utf-8");
    const parsed = JSON.parse(raw) as { sessionId?: string; userId?: string };
    const cachedSessionId = parsed.sessionId;
    const cachedUserId = parsed.userId;
    if (
      typeof cachedSessionId === "string" &&
      cachedSessionId.length > 0 &&
      Date.now() - stat.mtimeMs < AUTH_STATE_MAX_AGE_MS
    ) {
      // Verify the cached session still exists server-side. Clerk expires
      // sessions independently of the file mtime (e.g. after a few days of
      // inactivity), and a stale sessionId causes every test to fail with
      // "Session not found" when setupFapiWithMockSession tries to mint a JWT.
      //
      // Also verify the cached session belongs to the user that the current
      // Clerk lookup resolves to. The Clerk test instance may have rotated
      // the user (delete + recreate with the same email gets a new userId),
      // and a session bound to the previous userId would still be "active"
      // but would authenticate the SPA as a non-existent user, leaving every
      // DB-backed spec unable to see seeded data.
      try {
        const session = await clerkClient.sessions.getSession(cachedSessionId);
        const userMatches = cachedUserId === userId && session.userId === userId;
        const expiresAtMs =
          typeof session.expireAt === "number"
            ? session.expireAt
            : new Date(session.expireAt).getTime();
        const hasUsableLifetime =
          Number.isFinite(expiresAtMs) && expiresAtMs > Date.now() + 60_000;
        sessionIsRecent =
          session.status === "active" && userMatches && hasUsableLifetime;
        if (!sessionIsRecent) {
          console.log("[global-setup] Cached session is not reusable — re-creating");
        }
      } catch (err) {
        if (isClerkAPIResponseError(err) && err.status === 404) {
          console.log("[global-setup] Cached session no longer exists — re-creating");
        } else {
          throw err;
        }
      }
    }
  } catch {
    // file doesn't exist yet or is malformed — fall through to sign-in
  }

  if (!sessionIsRecent) {
    // Delete the stale file proactively so a failure mid-create cannot leave
    // a previous, no-longer-valid session on disk for the fixture to pick up.
    try {
      fs.unlinkSync(AUTH_SESSION_PATH);
    } catch {
      // not present — fine
    }

    try {
      await createServerSession({
        userId,
        email: TEST_USER_EMAIL,
        testingToken,
        secretKey,
      });
      console.log("[global-setup] Session created (.auth-session.json written)");
    } catch (err) {
      // The FAPI custom domain may be unreachable (e.g. DNS misconfiguration
      // for clerk.presentail.com).  Rather than aborting the entire test suite,
      // write a placeholder .auth-session.json so the suite can start.
      //
      // Tests that use setupFapiWithFakeSession (fully route-mocked specs) will
      // work correctly — they never read the session file.
      //
      // Tests that use setupFapiWithMockSession (real-JWT specs) will fail
      // per-test with "session not found" when trying to mint a JWT from the
      // placeholder session, giving a clear per-test error rather than a
      // suite-wide abort.
      console.warn(
        "[global-setup] WARNING: Could not create a Clerk session.",
        "FAPI host (clerk.presentail.com) appears unreachable.",
        "Writing a degraded-mode placeholder .auth-session.json.",
        "Fully route-mocked specs (fleet, channel-dimensions) will still pass.",
        "Specs that require real JWTs will fail per-test until the Clerk custom domain is restored.",
        "\nUnderlying error:", String(err),
      );
      fs.writeFileSync(
        AUTH_SESSION_PATH,
        JSON.stringify(
          {
            userId,
            sessionId: "sess_placeholder_fapi_unreachable",
            email: TEST_USER_EMAIL,
          },
          null,
          2,
        ),
      );
    }
  }

  // Write an empty auth-state.json so Playwright can load the storageState
  // file.  Actual authentication is injected per-test by the _fapiMock
  // fixture in fixtures.ts via setupFapiWithMockSession().
  fs.writeFileSync(
    STORAGE_STATE_PATH,
    JSON.stringify({ cookies: [], origins: [] }),
  );
}

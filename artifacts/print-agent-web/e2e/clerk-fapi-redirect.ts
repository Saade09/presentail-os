import { type Page } from "@playwright/test";
import fs from "fs";
import path from "path";
import { createSessionJwtCache } from "./session-jwt-cache";

// ---------------------------------------------------------------------------
// Background
// ---------------------------------------------------------------------------
//
// With VITE_CLERK_PUBLISHABLE_KEY set to the test instance key (pk_test_…),
// Clerk.js resolves the FAPI host to becoming-man-73.clerk.accounts.dev and
// makes all FAPI calls there directly — no clerk.presentail.com proxy.
//
// In Playwright tests, browser requests to becoming-man-73 include
// Origin: http://localhost:<port> and User-Agent: Mozilla/…  which can cause
// Clerk to return 401 dev_browser_unauthenticated unless __clerk_testing_token
// is present.  setupFapiRedirect handles this by intercepting all
// becoming-man-73/v1/** requests, adding the testing token, and forwarding
// them via Node.js fetch (no browser User-Agent, no Origin header injected
// automatically by the browser CDP layer).
//
// setupFapiWithMockSession additionally mocks GET /v1/client to return a fake
// signed-in session, allowing tests to skip the full browser sign-in flow.
// All other FAPI calls (GET /v1/environment, GET /v1/jwks, etc.) are forwarded
// to becoming-man-73 with the testing token via Node.js fetch.
//
// Tests that rely on real session cookies (stored in auth-state.json by
// globalSetup) can use setupClerkTestingToken from @clerk/testing/playwright
// without any FAPI mocking — the session cookie is picked up by Clerk.js on
// direct requests to becoming-man-73.
// ---------------------------------------------------------------------------

export const AUTH_SESSION_PATH = path.join(
  import.meta.dirname,
  ".auth-session.json",
);

export interface AuthSessionInfo {
  userId: string;
  sessionId: string;
  email: string;
}

// ---------------------------------------------------------------------------
// createServerSession
//
// Mints a sign-in token via the Clerk Backend API, redeems it via FAPI with
// __clerk_testing_token, and writes the resulting sessionId to
// .auth-session.json.  Used by both globalSetup (on cold cache) and the
// _fapiMock fixture (when an existing cached session has been evicted by
// Clerk's per-user session limit and JWT minting fails with "Session not
// found").
//
// Centralising this logic ensures the fixture can self-heal a stale
// .auth-session.json mid-suite without forcing a re-run.
// ---------------------------------------------------------------------------
export async function createServerSession(args: {
  userId: string;
  email: string;
  testingToken: string;
  secretKey: string;
}): Promise<AuthSessionInfo> {
  const { userId, email, testingToken, secretKey } = args;
  const { createClerkClient } = await import("@clerk/backend");
  const clerkClient = createClerkClient({ secretKey });

  const signInToken = await clerkClient.signInTokens.createSignInToken({
    userId,
    expiresInSeconds: 120,
  });

  // IMPORTANT: Do NOT include an Origin header.  Including Origin marks the
  // request as a browser request and causes Clerk to return 401
  // dev_browser_unauthenticated, even when __clerk_testing_token is present.
  // Node.js fetch omits Origin automatically when not explicitly set.
  const signInRes = await fetch(
    `https://${FAPI_HOST}/v1/client/sign_ins?__clerk_testing_token=${testingToken}`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        strategy: "ticket",
        ticket: signInToken.token,
      }),
    },
  );

  const signInBodyText = await signInRes.text();

  let sessionId: string | undefined;

  if (!signInRes.ok || !signInRes.headers.get("content-type")?.includes("application/json")) {
    // Two common failure paths:
    // 1. FAPI returns non-JSON (e.g. custom domain redirects to marketing site).
    // 2. FAPI returns JSON with ticket_invalid_code (publishable key / secret key
    //    instance mismatch — sign-in token created by one Clerk instance is not
    //    accepted by the FAPI host derived from the other instance's key).
    //
    // In both cases, fall back to listing the user's existing active sessions
    // via the Clerk Backend API, which does not depend on the FAPI custom
    // domain being reachable and does not need sign-in tokens.
    const isTicketInvalid =
      signInRes.ok &&
      signInBodyText.includes("ticket_invalid_code");
    const isUnreachable = !signInRes.ok;
    console.warn(
      `[global-setup] FAPI sign-in failed (${signInRes.status})` +
      (isTicketInvalid
        ? ` — ticket_invalid_code (key instance mismatch).`
        : ` — FAPI host (${FAPI_HOST}) appears unreachable.`) +
      " Falling back to listing existing active sessions via api.clerk.com." +
      ` Body excerpt: ${signInBodyText.slice(0, 120)}`,
    );
    const listRes = await fetch(
      `https://api.clerk.com/v1/sessions?user_id=${encodeURIComponent(userId)}&status=active&limit=5`,
      {
        method: "GET",
        headers: {
          Authorization: `Bearer ${secretKey}`,
          "Content-Type": "application/json",
        },
      },
    );
    if (!listRes.ok) {
      const errText = await listRes.text();
      throw new Error(
        `Clerk Backend API session list failed (${listRes.status}): ${errText.slice(0, 500)}`,
      );
    }
    const listData = (await listRes.json()) as Array<{ id?: string; status?: string }> | { data?: Array<{ id?: string }> };
    const sessions = Array.isArray(listData) ? listData : (listData.data ?? []);
    const activeSession = sessions.find((s) => s.id);
    if (!activeSession?.id) {
      throw new Error(
        `FAPI host (${FAPI_HOST}) is unreachable and no active sessions found for user ${userId} via Backend API. ` +
        `Fix: restore the Clerk custom domain or set CLERK_PUBLISHABLE_KEY to a test instance key (pk_test_).`,
      );
    }
    sessionId = activeSession.id;
    console.log("[global-setup] Reusing an existing active session via Backend API fallback");
  } else {
    const signInData = JSON.parse(signInBodyText) as {
      response?: { created_session_id?: string };
    };
    sessionId = signInData.response?.created_session_id;
    if (!sessionId) {
      throw new Error("FAPI sign-in did not return a session ID");
    }
  }

  const info: AuthSessionInfo = { userId, sessionId, email };
  fs.writeFileSync(AUTH_SESSION_PATH, JSON.stringify(info, null, 2));
  return info;
}

// Derive the FAPI host from the test publishable key.
//
// Prefer VITE_CLERK_PUBLISHABLE_KEY (the test instance key, pk_test_…) over
// CLERK_PUBLISHABLE_KEY (the live production key, pk_live_…) so that the FAPI
// host resolves to the test Clerk instance (e.g. becoming-man-73.clerk.accounts.dev)
// rather than the production custom domain (clerk.presentail.com).  Sign-in
// tokens created with CLERK_SECRET_KEY (sk_test_…) are only valid against the
// same test instance — redeeming them against the live FAPI produces
// "ticket_invalid_code".
function deriveFapiHost(): string {
  const key =
    process.env.VITE_CLERK_PUBLISHABLE_KEY ?? process.env.CLERK_PUBLISHABLE_KEY;
  if (!key) {
    throw new Error(
      "VITE_CLERK_PUBLISHABLE_KEY or CLERK_PUBLISHABLE_KEY is required to derive the Clerk FAPI host",
    );
  }
  const parts = key.split("_");
  const encoded = parts[2];
  if (!encoded) {
    throw new Error(`Unexpected CLERK_PUBLISHABLE_KEY format: ${key.slice(0, 12)}…`);
  }
  const decoded = Buffer.from(encoded, "base64").toString("utf-8");
  // Decoded value typically ends with "$"; strip any trailing non-host chars.
  return decoded.replace(/\$+$/, "").trim();
}

export const FAPI_HOST = deriveFapiHost();

// Matches all Clerk FAPI v1 requests to the test instance.
const FAPI_PATTERN = new RegExp(
  `https://${FAPI_HOST.replace(/\./g, "\\.")}/v1/`,
);

// ---------------------------------------------------------------------------
// setupFapiRedirect
//
// Intercepts all Clerk FAPI requests to becoming-man-73.clerk.accounts.dev/v1/**
// and forwards them via Node.js fetch with __clerk_testing_token appended.
// Using Node.js fetch (not route.fetch / page.request.fetch) avoids the
// browser injecting Origin and User-Agent headers that trigger Clerk's
// dev_browser_unauthenticated 401.
//
// Also rewrites CORS headers so the browser accepts the proxied response.
// ---------------------------------------------------------------------------
export async function setupFapiRedirect(page: Page): Promise<void> {
  await page.route(FAPI_PATTERN, async (route) => {
    const originalHeaders = route.request().headers();
    const requestOrigin = originalHeaders["origin"];

    const url = new URL(route.request().url());

    const testingToken = process.env.CLERK_TESTING_TOKEN;
    if (testingToken) {
      url.searchParams.set("__clerk_testing_token", testingToken);
    }

    // Forward only the subset of headers that becoming-man-73 needs.
    // Omit User-Agent (which marks the request as a browser request and
    // triggers the dev_browser_unauthenticated check) and Origin (which
    // Node.js fetch doesn't send anyway).
    const forwardHeaders: Record<string, string> = {};
    if (originalHeaders["cookie"]) {
      const CLERK_COOKIE_PREFIXES = [
        "__session",
        "__client_uat",
        "__clerk_",
      ];
      const stripped = originalHeaders["cookie"]
        .split(";")
        .map((c) => c.trim())
        .filter((c) => CLERK_COOKIE_PREFIXES.some((p) => c.startsWith(p)))
        .join("; ");
      if (stripped) forwardHeaders["cookie"] = stripped;
    }
    if (originalHeaders["content-type"]) {
      forwardHeaders["content-type"] = originalHeaders["content-type"];
    }
    forwardHeaders["accept"] = "application/json, text/plain, */*";
    forwardHeaders["accept-language"] =
      originalHeaders["accept-language"] ?? "en-US,en;q=0.9";

    try {
      const postData = route.request().postDataBuffer();
      const nodeResponse = await fetch(url.toString(), {
        method: route.request().method(),
        headers: forwardHeaders,
        ...(postData && postData.length > 0 ? { body: postData } : {}),
        redirect: "follow",
      });

      const responseHeaders: Record<string, string> = {};
      for (const [name, value] of nodeResponse.headers.entries()) {
        if (name.toLowerCase() !== "set-cookie") {
          responseHeaders[name.toLowerCase()] = value;
        }
      }

      // Forward only Clerk session cookies; strip Cloudflare cookies.
      const rawSetCookies =
        "getSetCookie" in nodeResponse.headers
          ? (nodeResponse.headers as Headers & {
              getSetCookie(): string[];
            }).getSetCookie()
          : [];
      const sessionCookies = rawSetCookies.filter((c) =>
        /^(__session|__client_uat|__clerk_)/.test(c),
      );
      if (sessionCookies.length > 0) {
        responseHeaders["set-cookie"] = sessionCookies.join("\n");
      }

      if (requestOrigin) {
        responseHeaders["access-control-allow-origin"] = requestOrigin;
        responseHeaders["access-control-allow-credentials"] = "true";
      }

      let bodyBuffer: Buffer | null = null;
      let bodyObj: Record<string, unknown> | undefined;
      try {
        bodyObj = (await nodeResponse.json()) as Record<string, unknown>;
      } catch {
        const ab = await nodeResponse.arrayBuffer();
        bodyBuffer = Buffer.from(ab);
      }

      if (bodyObj !== undefined) {
        responseHeaders["content-type"] = "application/json";
        await route.fulfill({
          status: nodeResponse.status,
          headers: responseHeaders,
          body: JSON.stringify(bodyObj),
        });
      } else {
        await route.fulfill({
          status: nodeResponse.status,
          headers: responseHeaders,
          body: bodyBuffer ?? undefined,
        });
      }
    } catch (err) {
      console.error("[fapi-redirect] fetch failed:", String(err));
      await route.fallback();
    }
  });
}

// ---------------------------------------------------------------------------
// setupFapiWithMockSession
//
// For tests that mock ALL app API routes, this provides a simpler alternative
// to browser sign-in:
//
//   1. Register setupFapiRedirect for general FAPI forwarding (adds testing
//      token, strips browser headers).
//   2. Read .auth-session.json (written by globalSetup) for session info.
//   3. Obtain a fresh short-lived JWT via Clerk Backend SDK.
//   4. Register priority mock routes for GET /v1/client and the token-refresh
//      endpoint (registered last → evaluated first in Playwright).
//
// Always returns true on success.  Throws (fail-fast) when
// .auth-session.json is missing, when required env vars are unset, or when
// the JWT cannot be obtained even after attempting an in-place session
// recovery — silently returning false would leave tests running
// unauthenticated and cause confusing /sign-in redirects.
// ---------------------------------------------------------------------------
export async function setupFapiWithMockSession(page: Page): Promise<boolean> {
  await setupFapiRedirect(page);

  let sessionInfo: AuthSessionInfo;
  try {
    const raw = fs.readFileSync(AUTH_SESSION_PATH, "utf-8");
    sessionInfo = JSON.parse(raw) as AuthSessionInfo;
  } catch {
    throw new Error(
      "[fapi-mock] .auth-session.json not found — globalSetup did not run or failed to write the session file",
    );
  }

  const secretKey = process.env.CLERK_SECRET_KEY;
  const testingToken = process.env.CLERK_TESTING_TOKEN;
  if (!secretKey) throw new Error("CLERK_SECRET_KEY not set");
  if (!testingToken) throw new Error("CLERK_TESTING_TOKEN not set");

  const { createClerkClient } = await import("@clerk/backend");
  const { isClerkAPIResponseError } = await import("@clerk/backend/errors");
  const cc = createClerkClient({ secretKey });

  // Try to mint a fresh JWT for the cached session.  Clerk evicts older
  // sessions when the per-user active-session limit is reached (10 on dev
  // instances), so a session that was valid at globalSetup time can be gone
  // by the time a test runs partway through the suite.  When that happens
  // (404 / "Session not found"), regenerate the session in-place and retry
  // exactly once before giving up.
  //
  // Calling getToken() once per test also rapidly trips Clerk's Backend API
  // rate limit (HTTP 429 "Too Many Requests") on suites with dozens of tests.
  // The shared cache therefore (a) reuses a JWT across tests while its actual
  // exp claim still has safe lifetime, and (b) retries 429s with exponential
  // backoff.
  const jwtCache = createSessionJwtCache({
    source: { getToken: (sessionId) => cc.sessions.getToken(sessionId) },
    onRateLimit: (delayMs, attempt) => {
      console.warn(
        `[fapi-mock] Clerk Backend API rate-limited minting JWT; retrying in ${delayMs}ms (attempt ${attempt} of 4)`,
      );
    },
  });

  let sessionJwt: string;
  try {
    sessionJwt = await jwtCache.get(sessionInfo.sessionId);
  } catch (err) {
    const isMissing =
      isClerkAPIResponseError(err) &&
      (err.status === 404 ||
        /session.*not.*found/i.test(err.message ?? ""));
    if (!isMissing) {
      throw err;
    }
    console.warn("[fapi-mock] Cached session no longer exists — re-creating in-place");
    jwtCache.invalidate(sessionInfo.sessionId);
    sessionInfo = await createServerSession({
      userId: sessionInfo.userId,
      email: sessionInfo.email,
      testingToken,
      secretKey,
    });
    sessionJwt = await jwtCache.get(sessionInfo.sessionId);
    console.log("[fapi-mock] Recovered with a new session");
  }

  const { userId, sessionId, email } = sessionInfo;
  const nowMs = Date.now();
  const futureMs = nowMs + 7 * 24 * 60 * 60 * 1000;

  const mockUser = {
    object: "user",
    id: userId,
    external_id: null,
    username: null,
    first_name: "E2E",
    last_name: "Tester",
    image_url: "",
    has_image: false,
    primary_email_address_id: "idn_mock",
    primary_phone_number_id: null,
    primary_web3_wallet_id: null,
    password_enabled: false,
    two_factor_enabled: false,
    totp_enabled: false,
    backup_code_enabled: false,
    email_addresses: [
      {
        object: "email_address",
        id: "idn_mock",
        email_address: email,
        reserved: false,
        verification: { status: "verified", strategy: "email_code" },
        linked_to: [],
      },
    ],
    phone_numbers: [],
    web3_wallets: [],
    external_accounts: [],
    passkeys: [],
    saml_accounts: [],
    enterprise_accounts: [],
    organization_memberships: [],
    public_metadata: { userType: "team" },
    unsafe_metadata: {},
    created_at: nowMs - 86400000,
    updated_at: nowMs,
    last_sign_in_at: nowMs,
    banned: false,
    locked: false,
    lockout_expires_in_seconds: null,
    verification_attempts_remaining: 100,
    delete_self_enabled: true,
    create_organization_enabled: true,
    last_active_at: nowMs,
    profile_image_url: "",
  };

  const mockSession = {
    object: "session",
    id: sessionId,
    status: "active",
    expire_at: futureMs,
    abandon_at: futureMs + 86400000,
    last_active_at: nowMs,
    last_active_organization_id: null,
    actor: null,
    user: mockUser,
    public_user_data: {
      first_name: "E2E",
      last_name: "Tester",
      image_url: "",
      has_image: false,
      identifier: email,
      user_id: userId,
      profile_image_url: "",
    },
    created_at: nowMs - 3600000,
    updated_at: nowMs,
    last_active_token: { object: "token", jwt: sessionJwt },
  };

  const mockClientBody = {
    response: {
      object: "client",
      id: "client_mock",
      sessions: [mockSession],
      sign_in: null,
      sign_up: null,
      last_active_session_id: sessionId,
      created_at: nowMs - 3600000,
      updated_at: nowMs,
    },
    client: {
      object: "client",
      id: "client_mock",
      sessions: [mockSession],
      sign_in: null,
      sign_up: null,
      last_active_session_id: sessionId,
      created_at: nowMs - 3600000,
      updated_at: nowMs,
    },
  };

  const CLIENT_PATTERN = new RegExp(
    `https://${FAPI_HOST.replace(/\./g, "\\.")}/v1/client(?:\\?|$)`,
  );
  await page.route(CLIENT_PATTERN, async (route) => {
    if (route.request().method() !== "GET") {
      await route.fallback();
      return;
    }
    console.log("[fapi-mock] Serving mock GET /v1/client response");
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(mockClientBody),
    });
  });

  const TOKEN_PATTERN = new RegExp(
    `https://${FAPI_HOST.replace(/\./g, "\\.")}/v1/client/sessions/[^/]+/tokens`,
  );
  await page.route(TOKEN_PATTERN, async (route) => {
    console.log("[fapi-mock] Serving mock session token");
    const freshJwt = await jwtCache.get(sessionId);
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ object: "token", jwt: freshJwt }),
    });
  });

  return true;
}

// ---------------------------------------------------------------------------
// setupFapiWithFakeSession
//
// A lightweight alternative to setupFapiWithMockSession for specs that mock
// ALL API routes via page.route and therefore never send the JWT to the real
// server.  Unlike setupFapiWithMockSession, this helper:
//
//   • Does NOT require a real Clerk session or .auth-session.json
//   • Does NOT forward any FAPI calls to the live FAPI host
//   • Does NOT require CLERK_SECRET_KEY to mint a real JWT
//
// It creates a self-signed fake JWT and mocks all FAPI endpoints directly:
//   - GET /v1/client       → fake signed-in session
//   - /v1/client/.../tokens → fake token refresh
//   - all other FAPI calls  → empty JSON 200 (Clerk.js tolerates this when
//                             the session is already established)
//
// Use this when:
//   1. clerk.presentail.com (the live FAPI custom domain) is unreachable, AND
//   2. every API route the spec exercises is mocked via page.route.
// ---------------------------------------------------------------------------
export async function setupFapiWithFakeSession(page: Page): Promise<void> {
  const nowS = Math.floor(Date.now() / 1000);
  const nowMs = Date.now();
  const futureMs = nowMs + 7 * 24 * 60 * 60 * 1000;
  const userId = "user_fake_e2e";
  const sessionId = "sess_fake_e2e";
  const email = "e2e-tester@fake.local";

  const hdr = Buffer.from(
    JSON.stringify({ alg: "RS256", typ: "JWT", kid: "fake_kid" }),
  ).toString("base64url");
  const pay = Buffer.from(
    JSON.stringify({
      sub: userId,
      sid: sessionId,
      exp: nowS + 60,
      nbf: nowS - 5,
      iat: nowS - 5,
      iss: `https://${FAPI_HOST}`,
      azp: "http://localhost",
    }),
  ).toString("base64url");
  const fakeJwt = `${hdr}.${pay}.fakesignatureXXXXXXXXXXXXXXXXX`;

  const mockUser = {
    object: "user",
    id: userId,
    external_id: null,
    username: null,
    first_name: "E2E",
    last_name: "Tester",
    image_url: "",
    has_image: false,
    primary_email_address_id: "idn_mock",
    primary_phone_number_id: null,
    primary_web3_wallet_id: null,
    password_enabled: false,
    two_factor_enabled: false,
    totp_enabled: false,
    backup_code_enabled: false,
    email_addresses: [
      {
        object: "email_address",
        id: "idn_mock",
        email_address: email,
        reserved: false,
        verification: { status: "verified", strategy: "email_code" },
        linked_to: [],
      },
    ],
    phone_numbers: [],
    web3_wallets: [],
    external_accounts: [],
    passkeys: [],
    saml_accounts: [],
    enterprise_accounts: [],
    organization_memberships: [],
    public_metadata: { userType: "team" },
    unsafe_metadata: {},
    created_at: nowMs - 86400000,
    updated_at: nowMs,
    last_sign_in_at: nowMs,
    banned: false,
    locked: false,
    lockout_expires_in_seconds: null,
    verification_attempts_remaining: 100,
    delete_self_enabled: true,
    create_organization_enabled: true,
    last_active_at: nowMs,
    profile_image_url: "",
  };

  const mockSession = {
    object: "session",
    id: sessionId,
    status: "active",
    expire_at: futureMs,
    abandon_at: futureMs + 86400000,
    last_active_at: nowMs,
    last_active_organization_id: null,
    actor: null,
    user: mockUser,
    public_user_data: {
      first_name: "E2E",
      last_name: "Tester",
      image_url: "",
      has_image: false,
      identifier: email,
      user_id: userId,
      profile_image_url: "",
    },
    created_at: nowMs - 3600000,
    updated_at: nowMs,
    last_active_token: { object: "token", jwt: fakeJwt },
  };

  const mockClientBody = {
    response: {
      object: "client",
      id: "client_mock",
      sessions: [mockSession],
      sign_in: null,
      sign_up: null,
      last_active_session_id: sessionId,
      created_at: nowMs - 3600000,
      updated_at: nowMs,
    },
    client: {
      object: "client",
      id: "client_mock",
      sessions: [mockSession],
      sign_in: null,
      sign_up: null,
      last_active_session_id: sessionId,
      created_at: nowMs - 3600000,
      updated_at: nowMs,
    },
  };

  const escapedHost = FAPI_HOST.replace(/\./g, "\\.");

  // Catch-all: any FAPI request not covered by more specific routes below
  // gets a minimal 200 JSON response.  Clerk.js handles empty objects
  // gracefully when GET /v1/client has already established the session state.
  await page.route(FAPI_PATTERN, async (route) => {
    const origin = route.request().headers()["origin"];
    const headers: Record<string, string> = {
      "content-type": "application/json",
    };
    if (origin) {
      headers["access-control-allow-origin"] = origin;
      headers["access-control-allow-credentials"] = "true";
    }
    await route.fulfill({ status: 200, headers, body: JSON.stringify({}) });
  });

  // GET /v1/client — primary session-state endpoint read by Clerk.js on load.
  const CLIENT_PATTERN_FAKE = new RegExp(
    `https://${escapedHost}/v1/client(?:\\?|$)`,
  );
  await page.route(CLIENT_PATTERN_FAKE, async (route) => {
    if (route.request().method() !== "GET") {
      await route.fallback();
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(mockClientBody),
    });
  });

  // POST /v1/client/sessions/{id}/tokens — periodic JWT refresh by Clerk.js.
  const TOKEN_PATTERN_FAKE = new RegExp(
    `https://${escapedHost}/v1/client/sessions/[^/]+/tokens`,
  );
  await page.route(TOKEN_PATTERN_FAKE, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ object: "token", jwt: fakeJwt }),
    });
  });
}

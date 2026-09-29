#!/usr/bin/env node
/**
 * Post-deploy smoke test.
 *
 * Verifies the live production site (https://os.presentail.com) is healthy
 * by hitting the API health endpoint, key public pages, and an
 * authenticated-user-facing API route.
 *
 * Usage:
 *   pnpm --filter @workspace/scripts run smoke-test
 *
 * Optional env vars:
 *   BASE_URL               — override the default production base URL
 *   TIMEOUT_MS             — per-request timeout in milliseconds (default: 10000)
 *   SMOKE_TEST_API_KEY     — if set, used as a Bearer token to verify authenticated
 *                            access returns HTTP 200 instead of 401. Also enables
 *                            catalog city auto-discovery (see SMOKE_TEST_CITY_SLUG).
 *   SMOKE_TEST_CITY_SLUG        — city slug used for the public catalog occasions check;
 *                               when not set the test auto-discovers the first city that
 *                               has at least one active occasion by calling
 *                               GET /api/delivery-locations then probing each city via
 *                               GET /api/catalog-attributes/occasions?city_slug=<slug>.
 *                               Both requests use SMOKE_TEST_API_KEY for auth, so
 *                               SMOKE_TEST_API_KEY must also be set for discovery to work.
 *                               If no matching city is found, the check is skipped with a
 *                               warning (not a failure).
 *   SMOKE_TEST_ALERT_WEBHOOK_URL — if set, a Slack-compatible incoming webhook URL
 *                               that receives a POST with a JSON failure summary
 *                               whenever one or more checks fail
 *   NOTIFY_PREVIOUS_FAILURE     — set to "true" or "1" to indicate the previous run
 *                               failed; when all checks pass and this flag is set, a
 *                               green recovery notification is sent to
 *                               SMOKE_TEST_ALERT_WEBHOOK_URL
 *   SMOKE_TEST_SECRET           — shared secret that matches SMOKE_TEST_SECRET on the server;
 *                               when set, the run record is persisted via POST /api/smoke-test-runs
 *   SMOKE_TEST_LOG_URL          — base URL of the server that persists run records
 *                               (defaults to BASE_URL; override when testing a staging env
 *                               but logging to production)
 *
 * Exit codes:
 *   0 — all checks passed
 *   1 — one or more checks failed
 */

const BASE_URL = process.env["BASE_URL"]?.replace(/\/$/, "") ?? "https://os.presentail.com";
const TIMEOUT_MS = Number(process.env["TIMEOUT_MS"] ?? "10000");
const SMOKE_TEST_API_KEY = process.env["SMOKE_TEST_API_KEY"];
const SMOKE_TEST_CITY_SLUG = process.env["SMOKE_TEST_CITY_SLUG"];
const SMOKE_TEST_ALERT_WEBHOOK_URL = process.env["SMOKE_TEST_ALERT_WEBHOOK_URL"];
const NOTIFY_PREVIOUS_FAILURE = process.env["NOTIFY_PREVIOUS_FAILURE"] === "true" || process.env["NOTIFY_PREVIOUS_FAILURE"] === "1";
/**
 * Shared secret for the smoke-test-runs persistence endpoint.
 * Must match SMOKE_TEST_SECRET on the target server.
 * When unset, result persistence is silently skipped.
 */
const SMOKE_TEST_SECRET = process.env["SMOKE_TEST_SECRET"];
/**
 * URL of the server that stores smoke-test run records.
 * Defaults to BASE_URL (the same server being tested), but can be overridden
 * to point at a separate logging API when testing a staging/preview environment.
 * Example: SMOKE_TEST_LOG_URL=https://os.presentail.com
 */
const SMOKE_TEST_LOG_URL = (process.env["SMOKE_TEST_LOG_URL"] ?? BASE_URL).replace(/\/$/, "");

interface Check {
  name: string;
  url: string;
  /** HTTP method (default: GET) */
  method?: string;
  /** Request headers */
  headers?: Record<string, string>;
  /** Expected HTTP status code (default: 200). Ignored when allowedStatuses is set. */
  expectedStatus?: number;
  /**
   * When set, the check passes if the response status is any of these values.
   * Takes precedence over expectedStatus.
   */
  allowedStatuses?: number[];
  /** Optional field that must appear in the JSON response body */
  expectedJsonField?: { key: string; value: unknown };
  /**
   * When true, the response body must be a JSON array with at least one element.
   * Cannot be combined with expectedNonEmptyArrayField.
   */
  expectedNonEmptyJsonArray?: boolean;
  /**
   * When set, the response body must be a JSON object where `body[field]` is an
   * array with at least one element. Cannot be combined with expectedNonEmptyJsonArray.
   */
  expectedNonEmptyArrayField?: string;
}

interface CheckResult {
  name: string;
  passed: boolean;
  reason?: string;
}

// ---------------------------------------------------------------------------
// City slug discovery
// ---------------------------------------------------------------------------

/**
 * Tries to fetch a URL with a per-request timeout and the smoke-test user-agent.
 * Returns the Response or throws (includes AbortError on timeout).
 */
async function timedFetch(url: string, headers: Record<string, string>): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    return await fetch(url, {
      headers: { "User-Agent": "presentail-smoke-test/1.0", ...headers },
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Returns the city slug to use for the public catalog occasions check.
 *
 * Priority:
 *   1. SMOKE_TEST_CITY_SLUG env var (explicit override — no network calls made)
 *   2. Auto-discovery: requires SMOKE_TEST_API_KEY
 *      a. Calls GET /api/delivery-locations to list active city slugs
 *      b. For each city, calls GET /api/catalog-attributes/occasions?city_slug=<slug>
 *      c. Returns the first city that has at least one active occasion
 *   3. Returns null when discovery is unavailable or no city with occasions found.
 *      The caller logs a warning and skips the occasions check.
 *
 * Errors that indicate configuration gaps (no API key, transport failure on the
 * discovery endpoint) are logged distinctly from "no active city found" so the
 * operator can distinguish a real data absence from a misconfigured smoke test.
 */
async function discoverCitySlug(): Promise<string | null> {
  if (SMOKE_TEST_CITY_SLUG) {
    return SMOKE_TEST_CITY_SLUG;
  }

  if (!SMOKE_TEST_API_KEY) {
    console.log(
      "  City slug: SMOKE_TEST_API_KEY is not set — " +
        "city auto-discovery requires it. " +
        "Set SMOKE_TEST_CITY_SLUG to enable the public catalog occasions check.",
    );
    return null;
  }

  const authHeaders: Record<string, string> = {
    Authorization: `Bearer ${SMOKE_TEST_API_KEY}`,
  };

  // Step 1: Get active city slugs from the delivery-locations endpoint.
  let citySlugs: string[];
  try {
    const res = await timedFetch(`${BASE_URL}/api/delivery-locations`, authHeaders);
    if (!res.ok) {
      console.warn(
        `  City slug: /api/delivery-locations returned HTTP ${res.status} — skipping occasions check.`,
      );
      return null;
    }
    const body = (await res.json()) as {
      countries?: Array<{ cities?: Array<{ slug?: string }> }>;
    };
    citySlugs = (body.countries ?? [])
      .flatMap((c) => c.cities ?? [])
      .map((city) => city.slug ?? "")
      .filter(Boolean);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(
      `  City slug: /api/delivery-locations request failed (${message}) — skipping occasions check.`,
    );
    return null;
  }

  if (citySlugs.length === 0) {
    console.warn(
      "  City slug: no active cities found in /api/delivery-locations — skipping occasions check.",
    );
    return null;
  }

  // Step 2: Find the first city that has at least one active occasion.
  // This ensures the slug we pick is catalog-aware, not just delivery-active.
  for (const slug of citySlugs) {
    try {
      const res = await timedFetch(
        `${BASE_URL}/api/catalog-attributes/occasions?city_slug=${encodeURIComponent(slug)}`,
        authHeaders,
      );
      if (res.ok) {
        const body = (await res.json()) as { occasions?: unknown[] };
        if (Array.isArray(body.occasions) && body.occasions.length > 0) {
          return slug;
        }
      }
    } catch {
      // Network error for this city — try the next one.
    }
  }

  console.warn(
    `  City slug: checked ${citySlugs.length} active city(ies) — none had occasions data. ` +
      "Skipping public catalog occasions check.",
  );
  return null;
}

// ---------------------------------------------------------------------------
// Checks
// ---------------------------------------------------------------------------

function buildChecks(citySlug: string | null): Check[] {
  const checks: Check[] = [
    {
      name: "API health endpoint",
      url: `${BASE_URL}/api/healthz`,
      expectedStatus: 200,
      expectedJsonField: { key: "status", value: "ok" },
    },
    {
      name: "Web app root page",
      url: `${BASE_URL}/`,
      expectedStatus: 200,
    },
    {
      name: "OpenAPI spec",
      url: `${BASE_URL}/api/openapi.yaml`,
      expectedStatus: 200,
    },
    {
      name: "Download: Mac print agent",
      url: `${BASE_URL}/api/download/mac`,
      // Accepts a direct file response (200) or a redirect to a CDN/storage URL (301/302).
      allowedStatuses: [200, 301, 302],
    },
    {
      name: "Download: Windows print agent",
      url: `${BASE_URL}/api/download/windows`,
      allowedStatuses: [200, 301, 302],
    },
  ];

  if (citySlug !== null) {
    checks.push({
      name: `Public catalog occasions (city: ${citySlug})`,
      url: `${BASE_URL}/api/catalog-attributes/occasions?city_slug=${encodeURIComponent(citySlug)}`,
      expectedStatus: 200,
      expectedNonEmptyArrayField: "occasions",
    });
  }

  if (SMOKE_TEST_API_KEY) {
    // If a token is provided, verify the authenticated route returns 200.
    checks.push({
      name: "Authenticated route (products list) — with token",
      url: `${BASE_URL}/api/products`,
      headers: { Authorization: `Bearer ${SMOKE_TEST_API_KEY}` },
      expectedStatus: 200,
    });
  } else {
    // Without a token, the auth middleware must reject the request with 401.
    // This confirms the route is live and auth enforcement is working.
    checks.push({
      name: "Authenticated route (products list) — auth enforcement (401)",
      url: `${BASE_URL}/api/products`,
      expectedStatus: 401,
    });
  }

  return checks;
}

async function runCheck(check: Check): Promise<{ passed: boolean; reason?: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const res = await fetch(check.url, {
      method: check.method ?? "GET",
      // Use "manual" so redirect responses (301/302) are captured as-is rather
      // than automatically followed, allowing allowedStatuses to match them.
      redirect: check.allowedStatuses ? "manual" : "follow",
      signal: controller.signal,
      headers: {
        "User-Agent": "presentail-smoke-test/1.0",
        ...check.headers,
      },
    });

    // Status check — allowedStatuses takes precedence over expectedStatus.
    if (check.allowedStatuses) {
      if (!check.allowedStatuses.includes(res.status)) {
        return {
          passed: false,
          reason: `expected one of [${check.allowedStatuses.join(", ")}], got ${res.status}`,
        };
      }
      return { passed: true };
    }

    const expectedStatus = check.expectedStatus ?? 200;
    if (res.status !== expectedStatus) {
      return {
        passed: false,
        reason: `expected HTTP ${expectedStatus}, got ${res.status}`,
      };
    }

    if (check.expectedNonEmptyJsonArray) {
      const contentType = res.headers.get("content-type") ?? "";
      if (!contentType.includes("application/json")) {
        return {
          passed: false,
          reason: `expected JSON response but got content-type: ${contentType}`,
        };
      }
      let body: unknown;
      try {
        body = await res.json();
      } catch {
        return { passed: false, reason: "response body is not valid JSON" };
      }
      if (!Array.isArray(body)) {
        return { passed: false, reason: `expected a JSON array, got ${typeof body}` };
      }
      if (body.length === 0) {
        return { passed: false, reason: "expected a non-empty array, got []" };
      }
      return { passed: true };
    }

    if (check.expectedNonEmptyArrayField) {
      const field = check.expectedNonEmptyArrayField;
      const contentType = res.headers.get("content-type") ?? "";
      if (!contentType.includes("application/json")) {
        return {
          passed: false,
          reason: `expected JSON response but got content-type: ${contentType}`,
        };
      }
      let body: Record<string, unknown>;
      try {
        body = (await res.json()) as Record<string, unknown>;
      } catch {
        return { passed: false, reason: "response body is not valid JSON" };
      }
      const arr = body[field];
      if (!Array.isArray(arr)) {
        return {
          passed: false,
          reason: `expected body.${field} to be an array, got ${typeof arr}`,
        };
      }
      if (arr.length === 0) {
        return { passed: false, reason: `expected body.${field} to be non-empty, got []` };
      }
      return { passed: true };
    }

    if (check.expectedJsonField) {
      const contentType = res.headers.get("content-type") ?? "";
      if (!contentType.includes("application/json")) {
        return {
          passed: false,
          reason: `expected JSON response but got content-type: ${contentType}`,
        };
      }
      let body: Record<string, unknown>;
      try {
        body = (await res.json()) as Record<string, unknown>;
      } catch {
        return { passed: false, reason: "response body is not valid JSON" };
      }
      const { key, value } = check.expectedJsonField;
      if (body[key] !== value) {
        return {
          passed: false,
          reason: `expected body.${key} === ${JSON.stringify(value)}, got ${JSON.stringify(body[key])}`,
        };
      }
    }

    return { passed: true };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    const isTimeout = err instanceof Error && err.name === "AbortError";
    return {
      passed: false,
      reason: isTimeout ? `timed out after ${TIMEOUT_MS}ms` : `fetch error: ${message}`,
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Persists the run record to the server's smoke_test_runs table via
 * POST /api/smoke-test-runs.  Requires SMOKE_TEST_SECRET to be set on both
 * the script side and the server side.  Never throws — a persistence failure
 * is logged but does not affect the script's exit code.
 */
async function persistRun(results: CheckResult[], durationMs: number): Promise<void> {
  if (!SMOKE_TEST_SECRET) return;

  const passed = results.every((r) => r.passed);
  const passedCount = results.filter((r) => r.passed).length;
  const failedCount = results.length - passedCount;

  const payload = {
    base_url: BASE_URL,
    passed,
    total: results.length,
    passed_count: passedCount,
    failed_count: failedCount,
    checks: results.map((r) => ({
      name: r.name,
      passed: r.passed,
      ...(r.reason !== undefined ? { reason: r.reason } : {}),
    })),
    duration_ms: durationMs,
  };

  try {
    const res = await fetch(`${SMOKE_TEST_LOG_URL}/api/smoke-test-runs`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-smoke-test-secret": SMOKE_TEST_SECRET,
        "User-Agent": "presentail-smoke-test/1.0",
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      console.error(`  Warning: run persistence returned HTTP ${res.status}${text ? ` — ${text}` : ""}`);
    } else {
      const data = (await res.json().catch(() => null)) as { id?: number; ran_at?: string } | null;
      console.log(`  Run record saved (id=${data?.id ?? "?"}, ran_at=${data?.ran_at ?? "?"}).`);
    }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`  Warning: could not persist run record — ${message}`);
  }
}

/**
 * Sends a Slack-compatible incoming webhook notification summarising the
 * failed checks. Never throws — a notification failure is logged but does
 * not affect the script's exit code.
 */
async function notifyFailures(failed: CheckResult[]): Promise<void> {
  if (!SMOKE_TEST_ALERT_WEBHOOK_URL) return;

  const failLines = failed
    .map((r) => `• *${r.name}*: ${r.reason ?? "unknown reason"}`)
    .join("\n");

  const payload = {
    text: `:rotating_light: *Smoke test failed for ${BASE_URL}*`,
    blocks: [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `:rotating_light: *Smoke test failed for <${BASE_URL}|${BASE_URL}>*\n${failed.length} check(s) did not pass:`,
        },
      },
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: failLines,
        },
      },
      {
        type: "context",
        elements: [
          {
            type: "mrkdwn",
            text: `Ran at ${new Date().toISOString()}`,
          },
        ],
      },
    ],
  };

  try {
    const res = await fetch(SMOKE_TEST_ALERT_WEBHOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      console.error(`  Warning: webhook notification returned HTTP ${res.status}`);
    } else {
      console.log("  Failure notification sent to SMOKE_TEST_ALERT_WEBHOOK_URL.");
    }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`  Warning: could not send webhook notification — ${message}`);
  }
}

/**
 * Sends a Slack-compatible recovery notification when the site returns to a
 * healthy state after a previous failure. Never throws — a notification failure
 * is logged but does not affect the script's exit code.
 */
async function notifyRecovery(totalChecks: number): Promise<void> {
  if (!SMOKE_TEST_ALERT_WEBHOOK_URL) return;

  const payload = {
    text: `:white_check_mark: *Smoke test recovered for ${BASE_URL}*`,
    blocks: [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `:white_check_mark: *Site recovered — <${BASE_URL}|${BASE_URL}>*\nAll ${totalChecks} check(s) are passing again.`,
        },
      },
      {
        type: "context",
        elements: [
          {
            type: "mrkdwn",
            text: `Ran at ${new Date().toISOString()}`,
          },
        ],
      },
    ],
  };

  try {
    const res = await fetch(SMOKE_TEST_ALERT_WEBHOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      console.error(`  Warning: recovery webhook notification returned HTTP ${res.status}`);
    } else {
      console.log("  Recovery notification sent to SMOKE_TEST_ALERT_WEBHOOK_URL.");
    }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`  Warning: could not send recovery webhook notification — ${message}`);
  }
}


async function main() {
  console.log(`Smoke test against: ${BASE_URL}`);
  if (SMOKE_TEST_API_KEY) {
    console.log("  Auth mode: using SMOKE_TEST_API_KEY for authenticated check");
  } else {
    console.log("  Auth mode: no token supplied — verifying 401 enforcement on protected route");
    console.log("  Tip: set SMOKE_TEST_API_KEY to a valid print-agent API key for a full authenticated check");
  }
  if (SMOKE_TEST_ALERT_WEBHOOK_URL) {
    console.log("  Notifications: SMOKE_TEST_ALERT_WEBHOOK_URL is set — failures will trigger a webhook POST");
    if (NOTIFY_PREVIOUS_FAILURE) {
      console.log("  Recovery mode: NOTIFY_PREVIOUS_FAILURE is set — a passing run will also send a recovery notification");
    }
  }
  if (SMOKE_TEST_SECRET) {
    const logTarget = SMOKE_TEST_LOG_URL !== BASE_URL ? SMOKE_TEST_LOG_URL : BASE_URL;
    console.log(`  Persistence: SMOKE_TEST_SECRET is set — run record will be saved to ${logTarget}/api/smoke-test-runs`);
  } else {
    console.log("  Persistence: SMOKE_TEST_SECRET not set — run record will not be saved");
    console.log("  Tip: set SMOKE_TEST_SECRET (server env) and SMOKE_TEST_SECRET (script env) to enable run history");
  }
  console.log("");

  // Discover a valid city slug before building checks so the occasions check
  // always targets a city that is both delivery-active and has catalog data.
  if (SMOKE_TEST_CITY_SLUG) {
    console.log(`  City slug: using SMOKE_TEST_CITY_SLUG override ("${SMOKE_TEST_CITY_SLUG}")`);
  } else {
    console.log(
      "  City slug: auto-discovering (requires SMOKE_TEST_API_KEY) ...",
    );
  }
  const citySlug = await discoverCitySlug();
  if (citySlug === null) {
    if (!SMOKE_TEST_CITY_SLUG) {
      console.log("  City slug: none discoverable — public catalog occasions check will be skipped.");
    }
  } else if (!SMOKE_TEST_CITY_SLUG) {
    console.log(`  City slug: using auto-discovered slug "${citySlug}"`);
  }
  console.log("");

  const checks = buildChecks(citySlug);
  const results: CheckResult[] = [];

  const startedAt = Date.now();

  for (const check of checks) {
    process.stdout.write(`  ${check.name} ... `);
    const result = await runCheck(check);
    results.push({ name: check.name, ...result });
    if (result.passed) {
      console.log("PASS");
    } else {
      console.log(`FAIL — ${result.reason}`);
    }
  }

  const durationMs = Date.now() - startedAt;

  console.log("");

  const failed = results.filter((r) => !r.passed);

  // Always persist the run record (pass or fail) when SMOKE_TEST_SECRET is set.
  await persistRun(results, durationMs);

  if (failed.length > 0) {
    console.error(`${failed.length} check(s) failed. The site may be unhealthy.`);
    await notifyFailures(failed);
    process.exit(1);
  } else {
    console.log(`All ${checks.length} checks passed.`);
  }
}

main().catch((err: unknown) => {
  console.error("Unexpected error:", err);
  process.exit(1);
});

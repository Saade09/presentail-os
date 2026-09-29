import { defineConfig, devices } from "@playwright/test";
import path from "path";

const E2E_PORT = 5174;

// Always use a local Vite dev server started by Playwright on a dedicated test
// port (5174). This avoids two problems that occur when pointing at the public
// REPLIT_DEV_DOMAIN:
//
// 1. The web-app workflow is not running during isolated e2e test workflows, so
//    the Replit proxy has nothing to serve and shows a "not started" banner.
//
// 2. Even if the workflow were running, Vite loads @replit/vite-plugin-dev-banner
//    whenever REPL_ID is set, which renders the banner before the React app and
//    causes Playwright to see only the banner in its page snapshots.
//
// Using http://localhost:5174 and telling Vite NODE_ENV=test sidesteps both.

const baseURL =
  process.env.PLAYWRIGHT_BASE_URL ?? `http://localhost:${E2E_PORT}`;

const storageState = path.join(import.meta.dirname, "e2e/.auth-state.json");

const BROWSER_ARGS = [
  "--no-sandbox",
  "--disable-setuid-sandbox",
  "--disable-dev-shm-usage",
  "--disable-gpu",
  "--disable-software-rasterizer",
  "--no-zygote",
  "--enable-unsafe-swiftshader",
];

// The Replit container's headless shell binary fails with a fatal V8 snapshot
// error before any test can run.  The full Chromium binary (installed alongside
// the headless shell by `playwright install chromium`) does not have this
// problem, so we point Playwright at it explicitly.
const CHROMIUM_EXECUTABLE = path.resolve(
  import.meta.dirname,
  "../../.cache/ms-playwright/chromium-1217/chrome-linux64/chrome",
);

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  // When PLAYWRIGHT_HTML_REPORT=1 (set by the all-e2e workflow) the run also
  // produces a browsable HTML report at artifacts/print-agent-web/playwright-report/
  // Open it locally with: npx playwright show-report artifacts/print-agent-web/playwright-report
  reporter: process.env.PLAYWRIGHT_HTML_REPORT
    ? [["list"], ["html", { open: "never", outputFolder: "playwright-report" }]]
    : "list",
  globalSetup: "./e2e/global-setup.ts",
  webServer: {
    command: "pnpm dev",
    url: baseURL,
    // reuseExistingServer=true is essential when multiple e2e workflows run in
    // parallel (each starts its own playwright process).  Without it, the
    // second+ processes try to bind a NEW Vite server on the same port 5174,
    // fail with EADDRINUSE, and then cannot connect — producing
    // net::ERR_CONNECTION_REFUSED.  With reuseExistingServer=true, subsequent
    // processes simply connect to the already-running server.
    reuseExistingServer: true,
    timeout: 120_000,
    env: {
      PORT: String(E2E_PORT),
      BASE_PATH: "/",
      // Setting NODE_ENV=test prevents Vite from loading
      // @replit/vite-plugin-dev-banner and @replit/vite-plugin-cartographer,
      // which would otherwise intercept the page because REPL_ID is set in the
      // Replit environment.  NODE_ENV=test also disables the Clerk proxy URL in
      // vite.config.ts so Clerk.js talks to the test instance's FAPI host
      // directly (where the e2e fixtures intercept /v1/** calls) instead of
      // routing through /api/__clerk on the API server, which is not running
      // during isolated e2e workflows.  Clerk.js itself loads from the public
      // Clerk CDN via the standard <ClerkProvider>.
      NODE_ENV: "test",
      // Point the app at the TEST Clerk instance (pk_test_) rather than the live
      // production instance (pk_live_).  Prefer VITE_CLERK_PUBLISHABLE_KEY (the
      // test instance key) over CLERK_PUBLISHABLE_KEY (the live production key)
      // so that the FAPI host resolves to the test Clerk instance, directly
      // reachable from the Replit sandbox without geo-blocking.  CLERK_SECRET_KEY
      // must belong to this same test instance, or the sign-in tokens it mints
      // are rejected ("ticket is invalid") by the test FAPI.
      VITE_CLERK_PUBLISHABLE_KEY:
        process.env.VITE_CLERK_PUBLISHABLE_KEY ??
        process.env.CLERK_PUBLISHABLE_KEY ??
        "",
    },
  },
  use: {
    baseURL,
    storageState,
    trace: "on-first-retry",
    launchOptions: {
      executablePath: CHROMIUM_EXECUTABLE,
      args: BROWSER_ARGS,
    },
  },
  projects: [
    {
      name: "chromium",
      use: {
        ...devices["Desktop Chrome"],
        launchOptions: {
          executablePath: CHROMIUM_EXECUTABLE,
          args: BROWSER_ARGS,
        },
      },
    },
  ],
});

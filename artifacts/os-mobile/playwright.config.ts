import { defineConfig, devices } from "@playwright/test";
import path from "path";

const E2E_PORT = 8085;
const baseURL = `http://localhost:${E2E_PORT}`;

// Same Chromium binary used by print-agent-web e2e tests.
// The headless-shell binary in this Replit environment fails with a V8
// snapshot error; the full Chromium build does not.
//
// Use __dirname (CJS-compatible) instead of import.meta.dirname — the
// os-mobile package is CJS and Playwright loads this config via require(),
// so import.meta is not available.
/* eslint-disable @typescript-eslint/no-var-requires */
const CHROMIUM_EXECUTABLE = path.resolve(
  // eslint-disable-next-line no-undef
  __dirname,
  "../../.cache/ms-playwright/chromium-1217/chrome-linux64/chrome",
);

const BROWSER_ARGS = [
  "--no-sandbox",
  "--disable-setuid-sandbox",
  "--disable-dev-shm-usage",
  "--disable-gpu",
  "--disable-software-rasterizer",
  "--no-zygote",
  "--enable-unsafe-swiftshader",
];

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  reporter: "list",
  // Pre-warm the Metro bundle before any browser is launched.
  // Metro compiles the JS bundle on-demand; the first compile can take
  // 60–120 s.  The global setup fetches the bundle via Node.js fetch so
  // the bundle is cached before any test page.goto() runs.
  globalSetup: "./e2e/global-setup",
  // Per-test timeout: 90 s so tests that run immediately after pre-warm
  // still have headroom if something is slow.
  timeout: 90_000,
  // Start the Expo web dev server before running tests.
  // CI=1 prevents Metro from trying to open a browser tab.
  // reuseExistingServer lets multiple local runs share the same server.
  webServer: {
    command: "npx expo start --web --port 8085 --non-interactive",
    url: baseURL,
    reuseExistingServer: true,
    // Allow up to 3 min for Metro to start (rare slow-start on cold container).
    timeout: 180_000,
    env: {
      CI: "1",
      // REQUIRED: metro.config.js only adds the pnpm virtual store
      // (.pnpm/) to Metro's watchFolders when this is set.  Without it,
      // Metro returns 404 for the bundle because the bundle path
      // (/node_modules/.pnpm/expo-router@.../entry.bundle) lives inside
      // the pnpm store, which is outside Metro's default watchFolders.
      METRO_WATCH_PNPM: "1",
      EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY:
        process.env.CLERK_PUBLISHABLE_KEY ?? "",
      EXPO_PUBLIC_DOMAIN: "",
      // Enables the dual-key auth bypass used by clerk-session-mock.ts so
      // Playwright tests can reach authenticated tab screens without a real
      // Clerk session.  Never set this in production deployment environments.
      EXPO_PUBLIC_E2E_HARNESS: "1",
    },
  },
  use: {
    baseURL,
    // Wait for the full page load event (deferred script included) on every
    // navigation.  After pre-warm, the bundle is cached so this completes
    // in < 5 s.  We allow 60 s here to tolerate edge-case cache misses.
    navigationTimeout: 60_000,
    trace: "on-first-retry",
    // Mobile viewport so React Native for Web renders in the expected layout.
    viewport: { width: 390, height: 844 },
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
        viewport: { width: 390, height: 844 },
        launchOptions: {
          executablePath: CHROMIUM_EXECUTABLE,
          args: BROWSER_ARGS,
        },
      },
    },
  ],
});

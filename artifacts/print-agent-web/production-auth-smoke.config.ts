import { defineConfig, devices } from "@playwright/test";
import path from "node:path";

const baseURL = process.env.PRODUCTION_SMOKE_BASE_URL?.replace(/\/$/, "");
if (!baseURL) {
  throw new Error(
    "PRODUCTION_SMOKE_BASE_URL is required. Use the published URL, not the development URL.",
  );
}

const storageState = process.env.PRODUCTION_SMOKE_STORAGE_STATE;
if (!storageState) {
  throw new Error(
    "PRODUCTION_SMOKE_STORAGE_STATE is required. It must point to an authenticated production browser state.",
  );
}

const browserArgs = [
  "--no-sandbox",
  "--disable-setuid-sandbox",
  "--disable-dev-shm-usage",
  "--disable-gpu",
  "--no-zygote",
  "--enable-unsafe-swiftshader",
];

const chromiumExecutable = path.resolve(
  import.meta.dirname,
  "../../.cache/ms-playwright/chromium-1217/chrome-linux64/chrome",
);

export default defineConfig({
  testDir: "./e2e",
  testMatch: "production-auth-smoke.spec.ts",
  fullyParallel: false,
  workers: 1,
  forbidOnly: true,
  reporter: process.env.PLAYWRIGHT_HTML_REPORT
    ? [["list"], ["html", { open: "never", outputFolder: "playwright-report-production-auth" }]]
    : "list",
  use: {
    baseURL,
    storageState,
    trace: "retain-on-failure",
    launchOptions: {
      executablePath: chromiumExecutable,
      args: browserArgs,
    },
    ...devices["Desktop Chrome"],
  },
});
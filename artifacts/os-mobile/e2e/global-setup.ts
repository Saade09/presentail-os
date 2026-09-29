/**
 * Playwright globalSetup — Metro bundle pre-warm via headless browser
 *
 * Metro (Expo's bundler) compiles the JavaScript bundle on-demand on the FIRST
 * HTTP request from a real browser.  That first compile takes 60–120 s for a
 * large Expo app.  Subsequent requests hit Metro's file-system cache (< 1 s).
 *
 * Node.js `fetch` requests return 404 because Metro checks the `platform` query
 * parameter and browser-specific request properties before serving the bundle.
 * We therefore use a real Chromium browser for the pre-warm step.
 *
 * This runs ONCE before any test browser is launched.  Playwright guarantees
 * the webServer is started before globalSetup, so localhost:8085 is reachable.
 */
import { chromium } from "@playwright/test";
import path from "path";
import fs from "fs";

// global-setup.ts lives in e2e/ (one level deeper than playwright.config.ts),
// so we need THREE levels up to reach the workspace root, not two.
const CHROMIUM_EXECUTABLE = path.resolve(
  __dirname,
  "../../../.cache/ms-playwright/chromium-1217/chrome-linux64/chrome",
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

const BASE_URL = "http://localhost:8085";
// Metro's cold-compile can take 90–120 s on a fresh container.
const WARM_TIMEOUT_MS = 150_000;

export default async function globalSetup(): Promise<void> {
  console.log(
    "[global-setup] Launching Chromium to pre-warm Metro bundle\n" +
      "               (cold compile can take 60–120 s — please be patient)…",
  );

  const browser = await chromium.launch({
    executablePath: CHROMIUM_EXECUTABLE,
    args: BROWSER_ARGS,
    headless: true,
  });

  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
  });
  const page = await context.newPage();

  // Log console errors from the app during pre-warm.
  page.on("console", (msg) => {
    if (msg.type() === "error") {
      console.log("[global-setup] APP CONSOLE ERROR:", msg.text().substring(0, 200));
    }
  });

  const start = Date.now();
  try {
    // waitUntil:"load" waits for the deferred bundle script to download +
    // execute.  This is where Metro does the compilation work.
    await page.goto(BASE_URL + "/", {
      waitUntil: "load",
      timeout: WARM_TIMEOUT_MS,
    });
    const elapsed = Date.now() - start;
    console.log(`[global-setup] Bundle load event fired in ${elapsed} ms`);

    // Wait a few more seconds for React to mount and any lazy chunks to settle.
    await page.waitForTimeout(3_000);

    // Capture diagnostic screenshot (useful when debugging CI failures).
    try {
      const screenshotPath = "/tmp/global-setup-screenshot.png";
      await page.screenshot({ path: screenshotPath });
      console.log(`[global-setup] Diagnostic screenshot saved to ${screenshotPath}`);
    } catch {
      // Screenshot is informational only — ignore failures.
    }

    // Log what testID elements (if any) are already visible.
    const testIds = await page.evaluate(() => {
      const els = document.querySelectorAll("[data-testid]");
      return Array.from(els).map((e) => e.getAttribute("data-testid"));
    });
    console.log("[global-setup] Visible testIDs after pre-warm:", JSON.stringify(testIds));

    // Also log DOM body text to help diagnose blank-page issues.
    const bodyText = await page.evaluate(
      () => document.body.innerText?.trim().substring(0, 300),
    );
    console.log("[global-setup] Page body text (first 300 chars):", JSON.stringify(bodyText));
  } catch (err: unknown) {
    const elapsed = Date.now() - start;
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(
      `[global-setup] Pre-warm navigation failed after ${elapsed} ms: ${msg.substring(0, 200)}`,
    );
    // Non-fatal: tests may still run (just slower on the first page load).
  } finally {
    await browser.close();
  }
}

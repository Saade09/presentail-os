import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { chromium, type Browser } from "playwright-core";
import QRCode from "qrcode";
import { logger } from "./logger";

export interface GiftCardData {
  cardTo?: string | null;
  cardMessage?: string | null;
  cardFrom?: string | null;
  qrLink?: string | null;
}

const INK = "#00414e";

// The stationery image is 1536x1024; the card is composed and printed at these
// exact pixel dimensions so the design maps 1:1 to the output.
const CARD_WIDTH = 1536;
const CARD_HEIGHT = 1024;
const QR_SIZE = 56;
const QR_RENDER_SIZE = 224;
const QR_SIDE_INSET = 12;
const QR_BOTTOM_INSET = 8;

/** Only absolute HTTP(S) links are printable as QR codes. */
export function normalizePrintableQrLink(value: string | null | undefined): string | null {
  const trimmed = (value ?? "").trim();
  return /^https?:\/\/.+/i.test(trimmed) ? trimmed : null;
}

/** Arabic and Hebrew card content uses the RTL footer layout. */
export function isRtlCardContent(...values: string[]): boolean {
  return /[\u0590-\u08ff]/u.test(values.join(" "));
}

/** Build a print-sharp transparent SVG QR data URL, or null for non-printable input. */
export async function buildPrintableQrDataUrl(
  value: string | null | undefined,
): Promise<string | null> {
  const qrLink = normalizePrintableQrLink(value);
  if (!qrLink) return null;
  const svg = await QRCode.toString(qrLink, {
    type: "svg",
    margin: 0,
    width: QR_RENDER_SIZE,
    color: { dark: INK, light: "#00000000" },
  });
  return `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`;
}

/**
 * Resolve the bundled gift-card asset directory. At runtime the server is
 * always executed from the esbuild bundle in `dist/` (the dev script does
 * `build && start`), where `build.mjs` copies the assets to `dist/assets`. In
 * tests/tsx the module runs from `src/lib`, so the source asset dir applies.
 */
function findAssetDir(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.join(here, "assets", "giftcard"), // dist/assets/giftcard (bundled)
    path.resolve(here, "../assets/giftcard"), // dist/../assets/giftcard
    path.resolve(here, "../../assets/giftcard"), // src/lib -> artifacts/api-server/assets/giftcard
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return candidates[0];
}

const ASSET_DIR = findAssetDir();
const FONTS_DIR = path.join(ASSET_DIR, "fonts");
// The stationery is referenced as PNG: the bundled Chromium cannot decode the
// source AVIF (returns a 0x0 image), so a PNG copy is shipped alongside it.
const STATIONERY_PNG = path.join(ASSET_DIR, "stationery.png");

const FONT_LATIN = path.join(FONTS_DIR, "NotoSans.ttf");
const FONT_ARABIC = path.join(FONTS_DIR, "NotoSansArabic.ttf");
const FONT_EMOJI = path.join(FONTS_DIR, "NotoColorEmoji.ttf");

const fileUrl = (p: string): string => pathToFileURL(p).href;

// The stationery is inlined as a base64 data URL so it is guaranteed painted
// before the PDF/screenshot is captured (a `file://` background can still be
// fetching at capture time). Read once and cache.
let stationeryDataUrl: string | null = null;
function getStationeryDataUrl(): string {
  if (!stationeryDataUrl) {
    const buf = fs.readFileSync(STATIONERY_PNG);
    stationeryDataUrl = `data:image/png;base64,${buf.toString("base64")}`;
  }
  return stationeryDataUrl;
}

/** Escape user-provided text for safe interpolation into HTML. */
function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Find the full Chromium build (`chrome-linux64/chrome`) inside a Playwright
 * browser cache directory. We must prefer this over `chromium.executablePath()`
 * because recent playwright-core defaults to the `chrome-headless-shell` build,
 * which is NOT downloaded in production (only the full `chromium-<rev>` build is
 * installed by the post-merge / CI step). When the headless shell is absent,
 * `chromium.executablePath()` points at a path that doesn't exist and Chromium
 * fails to launch. Searching for the full build keeps dev and prod consistent.
 */
function findFullChromiumInCache(cacheDir: string): string | undefined {
  let entries: string[];
  try {
    entries = fs.readdirSync(cacheDir);
  } catch {
    return undefined;
  }
  // Only the full Chromium build, never the `chromium_headless_shell-*` dirs.
  const chromiumDirs = entries
    .filter((e) => e.startsWith("chromium-"))
    .sort()
    .reverse();
  // Layout differs by source: ms-playwright downloads use `chrome-linux64`,
  // some Nix-provided builds use `chrome-linux`.
  const subdirs = ["chrome-linux64", "chrome-linux"];
  for (const dir of chromiumDirs) {
    for (const sub of subdirs) {
      const candidate = path.join(cacheDir, dir, sub, "chrome");
      if (fs.existsSync(candidate)) return candidate;
    }
  }
  return undefined;
}

/**
 * Find a Chromium executable on PATH as a compatibility fallback. Production's
 * primary browser source is the pinned Playwright cache prepared by the API
 * artifact build.
 */
export function findChromiumOnPath(): string | undefined {
  const names = ["chromium", "chromium-browser", "google-chrome", "google-chrome-stable"];
  const dirs = (process.env.PATH ?? "").split(path.delimiter).filter(Boolean);
  for (const dir of dirs) {
    for (const name of names) {
      const candidate = path.join(dir, name);
      try {
        if (fs.existsSync(candidate)) return candidate;
      } catch {
        // Unreadable PATH entry; skip it.
      }
    }
  }
  return undefined;
}

/**
 * Resolve a usable Chromium executable. Prefer explicit env overrides, then the
 * full Chromium build found in a Playwright cache, then a Chromium on PATH (the
 * system browser fallback), then playwright-core's own resolved
 * binary, then typical system install locations. Returns `undefined` to let
 * playwright fall back to a bundled download if one happens to be present.
 */
export function resolveChromiumPath(): string | undefined {
  const envCandidates = [
    process.env.REPLIT_PLAYWRIGHT_CHROMIUM_EXECUTABLE,
    process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
    process.env.PUPPETEER_EXECUTABLE_PATH,
    process.env.CHROME_PATH,
  ];
  for (const c of envCandidates) {
    if (c && fs.existsSync(c)) return c;
  }
  // Prefer the full Chromium build in the Playwright cache. This is the canonical
  // install in both dev and production; the headless-shell build that
  // `chromium.executablePath()` points to is often missing in production.
  const cacheDirs = [
    process.env.PLAYWRIGHT_BROWSERS_PATH,
    path.join(process.cwd(), ".cache", "ms-playwright"),
    "/home/runner/workspace/.cache/ms-playwright",
    path.join(os.homedir(), ".cache", "ms-playwright"),
  ];
  const seen = new Set<string>();
  for (const dir of cacheDirs) {
    if (!dir || seen.has(dir)) continue;
    seen.add(dir);
    const found = findFullChromiumInCache(dir);
    if (found) return found;
  }
  // Optional system Chromium: on PATH but outside /usr/bin and any Playwright
  // cache. Preferred over playwright-core's own executablePath()
  // because that points at the headless-shell build which is not installed.
  const onPath = findChromiumOnPath();
  if (onPath) return onPath;
  try {
    const p = chromium.executablePath();
    if (p && fs.existsSync(p)) return p;
  } catch {
    // playwright-core throws when no browser is registered; ignore and continue.
  }
  const systemCandidates = [
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
  ];
  for (const c of systemCandidates) {
    if (fs.existsSync(c)) return c;
  }
  return undefined;
}

// A single Chromium instance is shared across requests. It is launched lazily on
// first use, reused while connected, and transparently relaunched if it crashes.
let browserPromise: Promise<Browser> | null = null;

async function launchBrowser(): Promise<Browser> {
  const executablePath = resolveChromiumPath();
  // In production there is no bundled Playwright download to fall back on, and
  // `chromium.launch()` with no executablePath points at the headless-shell
  // build which is not installed — the launch would fail with a cryptic
  // "Executable doesn't exist at .../chrome-headless-shell". Fail loudly with an
  // actionable message instead of silently falling through to that path.
  if (!executablePath && process.env.NODE_ENV === "production") {
    throw new Error(
      "No Chromium executable found. Production expects a full chromium-* " +
        "Playwright build installed by scripts/deploy-build-api-server.sh under " +
        `PLAYWRIGHT_BROWSERS_PATH (${process.env.PLAYWRIGHT_BROWSERS_PATH ?? "unset"}). ` +
        "Verify that the build and runtime use the same explicit cache path.",
    );
  }
  logger.info(
    { executablePath: executablePath ?? "(playwright default)" },
    "Launching Chromium for gift-card PDF rendering",
  );
  const browser = await chromium.launch({
    executablePath,
    args: ["--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu"],
  });
  browser.on("disconnected", () => {
    browserPromise = null;
  });
  return browser;
}

async function getBrowser(): Promise<Browser> {
  if (browserPromise) {
    const existing = await browserPromise.catch(() => null);
    if (existing && existing.isConnected()) return existing;
    browserPromise = null;
  }
  browserPromise = launchBrowser();
  return browserPromise;
}

/** Compose the gift-card HTML document. Exported for unit testing. */
export function buildHtml(opts: {
  to: string;
  from: string;
  message: string;
  qrDataUrl: string | null;
  rtl?: boolean;
}): string {
  const { to, from, message, qrDataUrl, rtl = false } = opts;

  const blocks: string[] = [];
  // To and From blocks are only rendered when a card message is present.
  // Without a message these fields have no context and must not appear.
  if (to && message) {
    blocks.push(
      `<div class="labeled"><div class="value" dir="auto">${escapeHtml(
        to,
      )}</div></div>`,
    );
  }
  if (message) {
    blocks.push(
      `<div id="msg" class="message" dir="auto">${escapeHtml(message)}</div>`,
    );
  }
  if (from && message) {
    blocks.push(
      `<div class="labeled"><div class="value" dir="auto">${escapeHtml(
        from,
      )}</div></div>`,
    );
  }

  const qr = qrDataUrl
    ? `<img class="qr ${rtl ? "qr-rtl" : "qr-ltr"}" src="${qrDataUrl}" alt="" />`
    : "";

  return `<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<style>
  @font-face {
    font-family: 'Noto Sans';
    src: url('${fileUrl(FONT_LATIN)}') format('truetype');
    font-weight: 100 900;
    font-display: block;
  }
  @font-face {
    font-family: 'Noto Sans Arabic';
    src: url('${fileUrl(FONT_ARABIC)}') format('truetype');
    font-weight: 100 900;
    font-display: block;
  }
  @font-face {
    font-family: 'Noto Color Emoji';
    src: url('${fileUrl(FONT_EMOJI)}') format('truetype');
    font-display: block;
  }
  * { margin: 0; padding: 0; box-sizing: border-box; }
  html, body {
    width: ${CARD_WIDTH}px;
    height: ${CARD_HEIGHT}px;
  }
  body {
    position: relative;
    background-image: url('${getStationeryDataUrl()}');
    background-size: ${CARD_WIDTH}px ${CARD_HEIGHT}px;
    background-repeat: no-repeat;
    color: ${INK};
    font-family: 'Noto Sans', 'Noto Sans Arabic', 'Noto Color Emoji',
      'Segoe UI Emoji', 'Apple Color Emoji', sans-serif;
    -webkit-print-color-adjust: exact;
    print-color-adjust: exact;
  }
  /* Writing area: inset inside the teal border, below the baked-in header and
     above the bottom border line / QR corner. */
  #area {
    position: absolute;
    left: 150px;
    right: 150px;
    top: 230px;
    bottom: 130px;
    display: flex;
    flex-direction: column;
    justify-content: center;
    align-items: stretch;
    row-gap: 40px;
    text-align: center;
    overflow: hidden;
  }
  .labeled { flex: 0 0 auto; }
  .value {
    font-size: 44px;
    font-weight: 500;
    line-height: 1.2;
    overflow-wrap: break-word;
    word-break: break-word;
  }
  .message {
    flex: 0 1 auto;
    font-size: 48px;
    font-style: italic;
    line-height: 1.32;
    white-space: pre-wrap;
    overflow-wrap: break-word;
    word-break: break-word;
    overflow: hidden;
    display: flex;
    align-items: center;
    justify-content: center;
  }
  /* Proportional card layout: 56/1024 card-height QR with 12px side and 8px
     bottom insets on the 1536x1024 reference canvas.
     RTL cards mirror the QR into the bottom-left footer corner. */
  .qr {
    position: absolute;
    bottom: ${(QR_BOTTOM_INSET / CARD_HEIGHT) * 100}%;
    width: ${(QR_SIZE / CARD_HEIGHT) * 100}%;
    height: auto;
    aspect-ratio: 1;
  }
  .qr-ltr { right: ${(QR_SIDE_INSET / CARD_WIDTH) * 100}%; }
  .qr-rtl { left: ${(QR_SIDE_INSET / CARD_WIDTH) * 100}%; }
</style>
</head>
<body>
  <div id="area">
    ${blocks.join("\n    ")}
  </div>
  ${qr}
</body>
</html>`;
}

const MIN_MSG_FONT = 20;
const MAX_MSG_FONT = 84;

/**
 * Auto-fit the message: grow short messages and shrink long ones so the text
 * fills as much of its available area as possible without ever overflowing.
 * Runs inside the browser page (binary search on font size against the space
 * left by the recipient/sender name blocks).
 */
function autoFitMessage(arg: { minFont: number; maxFont: number }): void {
  const { minFont, maxFont } = arg;
  const area = document.getElementById("area");
  const msg = document.getElementById("msg") as HTMLElement | null;
  if (!area || !msg) return;

  const style = window.getComputedStyle(area);
  const rowGap = parseFloat(style.rowGap) || 0;
  const children = Array.from(area.children) as HTMLElement[];
  const gapTotal = rowGap * Math.max(0, children.length - 1);
  const othersHeight = children
    .filter((c) => c !== msg)
    .reduce((sum, c) => sum + c.offsetHeight, 0);

  const available = Math.max(0, area.clientHeight - othersHeight - gapTotal);
  msg.style.maxHeight = `${available}px`;

  let lo = minFont;
  let hi = maxFont;
  let best = minFont;
  while (lo <= hi) {
    const mid = Math.floor((lo + hi) / 2);
    msg.style.fontSize = `${mid}px`;
    if (msg.scrollHeight <= available) {
      best = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  msg.style.fontSize = `${best}px`;
}

/**
 * Render the card HTML to a single-page PDF buffer using the shared Chromium
 * instance. Retries once if the browser was disconnected mid-flight.
 */
async function renderPdf(html: string, attempt = 0): Promise<Buffer> {
  let browser: Browser;
  try {
    browser = await getBrowser();
  } catch (err) {
    browserPromise = null;
    throw err;
  }

  const context = await browser.newContext({
    viewport: { width: CARD_WIDTH, height: CARD_HEIGHT },
    deviceScaleFactor: 1,
  });
  try {
    const page = await context.newPage();
    await page.setContent(html, { waitUntil: "load" });
    await page.evaluate(() => document.fonts.ready.then(() => undefined));
    await page.evaluate(autoFitMessage, {
      minFont: MIN_MSG_FONT,
      maxFont: MAX_MSG_FONT,
    });
    const pdf = await page.pdf({
      width: `${CARD_WIDTH}px`,
      height: `${CARD_HEIGHT}px`,
      printBackground: true,
      pageRanges: "1",
    });
    return pdf;
  } catch (err) {
    // A crashed/closed browser surfaces as a target/connection error; relaunch
    // once and retry before giving up.
    if (attempt === 0) {
      browserPromise = null;
      await context.close().catch(() => {});
      return renderPdf(html, attempt + 1);
    }
    throw err;
  } finally {
    await context.close().catch(() => {});
  }
}

/**
 * Build a styled Presentail gift-card PDF and resolve with the rendered Buffer.
 * The card is drawn as an HTML document on top of the branded stationery image
 * and printed to PDF with headless Chromium, giving proper Arabic shaping,
 * color emoji, and browser-measured text fitting. The exported signature and
 * output dimensions are unchanged from the previous pdfkit implementation.
 */
export async function buildGiftCardPdf(data: GiftCardData): Promise<Buffer> {
  const message = (data.cardMessage ?? "").replace(/\r\n/g, "\n").trim();
  // Only include recipient/sender names when a card message is present.
  // The storefront sends cardTo regardless of whether the sender wrote a
  // message; without this guard the PDF would show a stray "To:" line.
  const to = message ? (data.cardTo ?? "").trim() : "";
  const from = message ? (data.cardFrom ?? "").trim() : "";

  const qrDataUrl = await buildPrintableQrDataUrl(data.qrLink);

  const html = buildHtml({
    to,
    from,
    message,
    qrDataUrl,
    rtl: isRtlCardContent(to, message, from),
  });

  return renderPdf(html);
}

/** Close the shared browser (best-effort) — useful for tests and shutdown. */
export async function closeGiftCardBrowser(): Promise<void> {
  const current = browserPromise;
  browserPromise = null;
  if (!current) return;
  try {
    const browser = await current;
    await browser.close();
  } catch {
    // ignore
  }
}

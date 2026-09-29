import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { chromium } from "playwright-core";
import {
  buildGiftCardPdf,
  buildHtml,
  buildPrintableQrDataUrl,
  closeGiftCardBrowser,
  findChromiumOnPath,
  isRtlCardContent,
  normalizePrintableQrLink,
  resolveChromiumPath,
  type GiftCardData,
} from "./giftCardPdf";

/**
 * Resolve a usable Chromium executable the same way the renderer does. When none
 * is available (e.g. a CI image without the Playwright browser), the rendering
 * tests are skipped rather than failing — there is no way to produce a PDF
 * without a headless browser.
 */
function isFullChromium(p: string): boolean {
  // Exclude chrome-headless-shell — it cannot render full pages / PDFs
  return !p.includes("headless_shell") && !p.includes("headless-shell");
}

function chromiumAvailable(): boolean {
  const envCandidates = [
    process.env.REPLIT_PLAYWRIGHT_CHROMIUM_EXECUTABLE,
    process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
    process.env.PUPPETEER_EXECUTABLE_PATH,
    process.env.CHROME_PATH,
  ];
  for (const c of envCandidates) {
    if (c && fs.existsSync(c) && isFullChromium(c)) return true;
  }
  try {
    const p = chromium.executablePath();
    if (p && fs.existsSync(p) && isFullChromium(p)) return true;
  } catch {
    // playwright-core throws when no browser is registered.
  }
  for (const c of [
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
  ]) {
    if (fs.existsSync(c) && isFullChromium(c)) return true;
  }
  return false;
}

const HAS_CHROMIUM = chromiumAvailable();

function isPdf(buf: Buffer): boolean {
  return buf.length > 4 && buf.subarray(0, 5).toString("latin1") === "%PDF-";
}

describe.skipIf(!HAS_CHROMIUM)("buildGiftCardPdf", () => {
  afterAll(async () => {
    await closeGiftCardBrowser();
  });

  const cases: Array<{ name: string; data: GiftCardData }> = [
    {
      name: "short English message with QR",
      data: {
        cardTo: "Sarah",
        cardMessage: "Happy Birthday!",
        cardFrom: "John",
        qrLink: "https://presentail.com/x",
      },
    },
    {
      name: "long English message (auto-shrunk)",
      data: {
        cardTo: "Alexander",
        cardMessage:
          "Wishing you the happiest of birthdays today and always. May this year bring you joy, laughter, good health, and every success you've been dreaming of.",
        cardFrom: "The Whole Family",
      },
    },
    {
      name: "Arabic RTL message",
      data: {
        cardTo: "سارة",
        cardMessage: "عيد ميلاد سعيد! أتمنى لك عاماً مليئاً بالفرح والسعادة.",
        cardFrom: "محمد",
        qrLink: "https://presentail.com/y",
      },
    },
    {
      name: "mixed LTR/RTL with color emoji",
      data: {
        cardTo: "Layla ليلى",
        cardMessage: "Congratulations! 🎉❤️ مبروك 🌹",
        cardFrom: "Omar & Nour",
      },
    },
    {
      name: "recipient only (no message, from, or QR)",
      data: { cardTo: "Grandma" },
    },
    {
      name: "empty data",
      data: {},
    },
  ];

  it.each(cases)("renders a valid PDF for $name", async ({ data }) => {
    const buf = await buildGiftCardPdf(data);
    expect(Buffer.isBuffer(buf)).toBe(true);
    expect(isPdf(buf)).toBe(true);
    expect(buf.length).toBeGreaterThan(1000);
  });
});

/**
 * The card-pdf route 500'd in the deployed autoscale app because Chromium was
 * only installed into the gitignored `.cache/ms-playwright`, which does not ship
 * into the run image. The durable fix resolves Chromium from PATH (the Nix
 * `pkgs.chromium` lives there in production). These tests pin the resolver's
 * behaviour — especially the PATH branch that dev's Playwright cache would
 * otherwise mask.
 */
/**
 * `buildHtml` is a pure function (no browser, no I/O) so these tests run in
 * every environment, regardless of Chromium availability.
 */
describe("buildHtml — card-message guard", () => {
  it("omits the To block when message is empty", () => {
    const html = buildHtml({ to: "Ahmad", from: "", message: "", qrDataUrl: null });
    // No "To:" content should appear when there is no message.
    expect(html).not.toContain("Ahmad");
    expect(html).not.toContain('class="labeled"');
  });

  it("omits the From block when message is empty", () => {
    const html = buildHtml({ to: "", from: "Sarah", message: "", qrDataUrl: null });
    expect(html).not.toContain("Sarah");
    expect(html).not.toContain('class="labeled"');
  });

  it("omits both To and From blocks when message is empty even if both are set", () => {
    const html = buildHtml({ to: "Ahmad", from: "Sarah", message: "", qrDataUrl: null });
    expect(html).not.toContain("Ahmad");
    expect(html).not.toContain("Sarah");
    expect(html).not.toContain('class="labeled"');
  });

  it("renders To and From blocks when message is present", () => {
    const html = buildHtml({
      to: "Ahmad",
      from: "Sarah",
      message: "Happy Birthday!",
      qrDataUrl: null,
    });
    expect(html).toContain("Ahmad");
    expect(html).toContain("Sarah");
    expect(html).toContain("Happy Birthday!");
    expect(html).toContain('class="labeled"');
  });

  it("renders message-only when to and from are empty", () => {
    const html = buildHtml({ to: "", from: "", message: "Congrats!", qrDataUrl: null });
    expect(html).toContain("Congrats!");
    expect(html).not.toContain('class="labeled"');
  });
});

describe("printable QR rendering", () => {
  it.each([
    [" https://example.com/card ", "https://example.com/card"],
    ["http://example.com/card", "http://example.com/card"],
    ["", null],
    ["   ", null],
    ["example.com/card", null],
    ["javascript:alert(1)", null],
    ["https://", null],
  ])("normalizes %j to %j", (input, expected) => {
    expect(normalizePrintableQrLink(input)).toBe(expected);
  });

  it("places LTR and RTL QR images in opposite proportional footer corners", () => {
    const ltr = buildHtml({
      to: "Sarah",
      from: "John",
      message: "Happy birthday",
      qrDataUrl: "data:image/png;base64,abc",
    });
    const rtl = buildHtml({
      to: "سارة",
      from: "محمد",
      message: "عيد ميلاد سعيد",
      qrDataUrl: "data:image/png;base64,abc",
      rtl: true,
    });
    expect(ltr).toContain('class="qr qr-ltr"');
    expect(rtl).toContain('class="qr qr-rtl"');
    expect(ltr).toContain("bottom: 0.78125%");
    expect(ltr).toContain("width: 5.46875%");
    expect(ltr).toContain("right: 0.78125%");
    expect(rtl).toContain("left: 0.78125%");
  });

  it("detects RTL card content and omits the image when no QR exists", () => {
    expect(isRtlCardContent("Sarah", "Hello", "John")).toBe(false);
    expect(isRtlCardContent("سارة", "Hello", "John")).toBe(true);
    expect(buildHtml({ to: "", from: "", message: "", qrDataUrl: null })).not.toContain(
      'class="qr ',
    );
  });

  it("generates a dark-teal transparent SVG and omits invalid links", async () => {
    const dataUrl = await buildPrintableQrDataUrl(" https://example.com/card ");
    expect(dataUrl).toMatch(/^data:image\/svg\+xml;base64,/);
    const svg = Buffer.from(dataUrl!.split(",")[1], "base64").toString("utf8");
    expect(svg).toContain("<svg");
    expect(svg.toLowerCase()).toContain("#00414e");
    expect(svg.toLowerCase()).not.toContain("#ffffff");
    expect(svg.match(/<path\b/g)).toHaveLength(1);
    await expect(buildPrintableQrDataUrl("example.com/card")).resolves.toBeNull();
    await expect(buildPrintableQrDataUrl("   ")).resolves.toBeNull();
  });
});

describe("findChromiumOnPath", () => {
  const ORIGINAL_PATH = process.env.PATH;

  afterEach(() => {
    process.env.PATH = ORIGINAL_PATH;
  });

  it("finds a chromium binary living on PATH (the Nix production layout)", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "chromium-path-"));
    const exe = path.join(dir, "chromium");
    fs.writeFileSync(exe, "#!/bin/sh\n");
    process.env.PATH = `${dir}${path.delimiter}/nonexistent-dir-xyz`;
    try {
      expect(findChromiumOnPath()).toBe(exe);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("also recognises chromium-browser / google-chrome names", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "chromium-path-"));
    const exe = path.join(dir, "google-chrome-stable");
    fs.writeFileSync(exe, "#!/bin/sh\n");
    process.env.PATH = dir;
    try {
      expect(findChromiumOnPath()).toBe(exe);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns undefined when no chromium is on PATH", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "chromium-path-empty-"));
    process.env.PATH = dir;
    try {
      expect(findChromiumOnPath()).toBeUndefined();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("resolveChromiumPath", () => {
  const SAVED = {
    PATH: process.env.PATH,
    REPLIT_PLAYWRIGHT_CHROMIUM_EXECUTABLE: process.env.REPLIT_PLAYWRIGHT_CHROMIUM_EXECUTABLE,
    PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
    PUPPETEER_EXECUTABLE_PATH: process.env.PUPPETEER_EXECUTABLE_PATH,
    CHROME_PATH: process.env.CHROME_PATH,
    PLAYWRIGHT_BROWSERS_PATH: process.env.PLAYWRIGHT_BROWSERS_PATH,
  };

  function restore(key: keyof typeof SAVED): void {
    const v = SAVED[key];
    if (v === undefined) delete process.env[key];
    else process.env[key] = v;
  }

  afterEach(() => {
    (Object.keys(SAVED) as Array<keyof typeof SAVED>).forEach(restore);
  });

  it("prefers a valid explicit env override over everything else", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "chromium-env-"));
    const exe = path.join(dir, "chromium");
    fs.writeFileSync(exe, "#!/bin/sh\n");
    // Clear the higher-priority env candidates so PUPPETEER_EXECUTABLE_PATH is
    // the first one that resolves (they may be preset in this environment).
    delete process.env.REPLIT_PLAYWRIGHT_CHROMIUM_EXECUTABLE;
    delete process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH;
    process.env.PUPPETEER_EXECUTABLE_PATH = exe;
    try {
      expect(resolveChromiumPath()).toBe(exe);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("resolves SOME executable in this environment (never undefined here)", () => {
    // Both dev (Playwright cache) and the Nix/PATH production layout must yield
    // a path. A regression that returns undefined would reproduce the prod 500.
    const resolved = resolveChromiumPath();
    expect(resolved, "no Chromium resolvable — card PDF would 500").toBeTruthy();
    expect(fs.existsSync(resolved as string)).toBe(true);
  });

  it("falls back to a Chromium on PATH when no env/cache path is available", () => {
    // Reproduce the production condition: no env override and an EMPTY Playwright
    // cache (the deployed run image ships no `.cache/ms-playwright`). Spy on
    // readdirSync so every cache dir looks empty, forcing the resolver down to
    // the PATH branch — the exact Nix production resolution path.
    delete process.env.REPLIT_PLAYWRIGHT_CHROMIUM_EXECUTABLE;
    delete process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH;
    delete process.env.PUPPETEER_EXECUTABLE_PATH;
    delete process.env.CHROME_PATH;
    delete process.env.PLAYWRIGHT_BROWSERS_PATH;

    const onPath = findChromiumOnPath();
    if (!onPath) {
      // No system Chromium on PATH in this environment; the isolated
      // findChromiumOnPath tests above already pin that branch.
      return;
    }

    const spy = vi.spyOn(fs, "readdirSync").mockReturnValue([] as never);
    try {
      expect(resolveChromiumPath()).toBe(onPath);
    } finally {
      spy.mockRestore();
    }
  });
});

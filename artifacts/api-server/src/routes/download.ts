import { Router } from "express";
import type { Request, Response } from "express";
import archiver from "archiver";
import path from "path";
import fs from "fs";
import { execFile } from "child_process";
import { promisify } from "util";
import { fileURLToPath } from "url";
import { getAuth } from "@clerk/express";
import { db } from "../lib/db";
import { logger } from "../lib/logger";

const execFileAsync = promisify(execFile);
const downloadRouter = Router();

// ── Download tracking ─────────────────────────────────────────────────────────
// The download routes are public (no requireAuth), but when the requester has a
// valid Clerk session we attribute the download to their workspace owner so the
// Downloads page can show per-workspace counts. Recording is best-effort: any
// failure is logged and swallowed so it never breaks the actual download.

async function recordDownloadEvent(
  userId: string,
  platform: string,
): Promise<void> {
  try {
    const r = await db.query<{ workspace_owner_id: string }>(
      `SELECT workspace_owner_id FROM workspace_members
        WHERE member_user_id = $1 AND joined_at IS NOT NULL
        LIMIT 1`,
      [userId],
    );
    const ownerId = r.rows[0]?.workspace_owner_id;
    if (!ownerId) return;
    await db.query(
      `INSERT INTO download_events (user_id, platform) VALUES ($1, $2)`,
      [ownerId, platform],
    );
  } catch (err) {
    logger.warn({ err, platform }, "[download] failed to record download event");
  }
}

/**
 * Attaches a one-shot `finish` listener that records a download event once the
 * response completes successfully (statusCode < 400). Resolves the Clerk user
 * up front so an unauthenticated download is simply not counted.
 */
function trackDownload(req: Request, res: Response, platform: string): void {
  const auth = getAuth(req);
  const userId =
    (auth?.sessionClaims as { userId?: string })?.userId || auth?.userId;
  if (!userId) return;
  res.on("finish", () => {
    if (res.statusCode >= 400) return;
    void recordDownloadEvent(userId, platform);
  });
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Built output: artifacts/api-server/dist/ → go 3 levels up to workspace root.
// The source module is also imported directly by unit tests, so prefer the
// first candidate that contains the checked-in packaging script.
const workspaceCandidates = [
  path.resolve(__dirname, "..", "..", ".."),
  path.resolve(__dirname, "..", "..", "..", ".."),
  path.resolve(process.cwd()),
];
const WORKSPACE_DIR =
  workspaceCandidates.find((candidate) =>
    fs.existsSync(path.join(candidate, "scripts", "build-mac-zip.sh")),
  ) ?? workspaceCandidates[0];
const AGENT_DIR = path.join(WORKSPACE_DIR, "print-agent");
const SCRIPTS_DIR = path.join(WORKSPACE_DIR, "scripts");
const CHROME_EXT_DIR = path.join(WORKSPACE_DIR, "extensions", "presentail-order-capture");

const CHROME_EXT_FILES = [
  "manifest.json",
  "content.js",
  "popup.html",
  "popup.css",
  "popup.js",
  "README.md",
];
const MAC_ZIP_CACHE = "/tmp/PrintAgent.zip";
export const MAC_BUILD_SCRIPT = path.join(SCRIPTS_DIR, "build-mac-zip.sh");

const WINDOWS_FILES = [
  "print-agent-windows.py",
  "install-windows.ps1",
  "uninstall-windows.ps1",
  "README.md",
];

const SCANNER_AGENT_FILENAME_RE =
  /^Presentail-Scanner-Agent-\d+\.\d+\.\d+-x64\.exe$/;
const MIN_CONFIGURABLE_INBOX_VERSION = [1, 0, 3] as const;

export type ScannerAgentRelease = {
  available: boolean;
  version: string | null;
  filename: string | null;
  sha256: string | null;
  downloadUrl: string | null;
  reason?: string;
};

function parseScannerAgentVersion(version: string): [number, number, number] | null {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  return match
    ? [Number(match[1]), Number(match[2]), Number(match[3])]
    : null;
}

function isOlderThanConfigurableInboxRelease(version: string): boolean {
  const parsed = parseScannerAgentVersion(version);
  if (!parsed) return false;
  for (let index = 0; index < parsed.length; index += 1) {
    if (parsed[index] !== MIN_CONFIGURABLE_INBOX_VERSION[index]) {
      return parsed[index] < MIN_CONFIGURABLE_INBOX_VERSION[index];
    }
  }
  return false;
}

/**
 * The installer is published by the Windows release workflow, not bundled
 * with the API deployment. Keeping the release URL in environment config
 * allows the API to serve the same durable release from every autoscale
 * instance and makes an unpublished release fail explicitly.
 */
export function getScannerAgentRelease(): ScannerAgentRelease {
  const downloadUrl = process.env.SCANNER_AGENT_RELEASE_URL?.trim() || null;
  const version = process.env.SCANNER_AGENT_RELEASE_VERSION?.trim() || null;
  const filename = process.env.SCANNER_AGENT_RELEASE_FILENAME?.trim() || null;
  const sha256 = process.env.SCANNER_AGENT_RELEASE_SHA256?.trim().toLowerCase() || null;

  if (!downloadUrl) {
    return {
      available: false,
      version,
      filename,
      sha256,
      downloadUrl: null,
      reason: "The Windows Scanner Agent has not been published yet.",
    };
  }
  if (!/^https?:\/\//i.test(downloadUrl)) {
    return {
      available: false,
      version,
      filename,
      sha256,
      downloadUrl,
      reason: "The configured Scanner Agent release URL is invalid.",
    };
  }
  if (!version || !/^\d+\.\d+\.\d+$/.test(version)) {
    return {
      available: false,
      version,
      filename,
      sha256,
      downloadUrl,
      reason: "The published Scanner Agent version is missing or invalid.",
    };
  }
  if (isOlderThanConfigurableInboxRelease(version)) {
    return {
      available: false,
      version,
      filename,
      sha256,
      downloadUrl,
      reason:
        "The published Scanner Agent predates configurable inbox support. Publish version 1.0.3 or newer.",
    };
  }
  if (
    !filename ||
    !SCANNER_AGENT_FILENAME_RE.test(filename) ||
    filename !== `Presentail-Scanner-Agent-${version}-x64.exe`
  ) {
    return {
      available: false,
      version,
      filename,
      sha256,
      downloadUrl,
      reason: "The published Scanner Agent filename is missing or invalid.",
    };
  }
  try {
    const releaseUrl = new URL(downloadUrl);
    const urlFilename = decodeURIComponent(
      releaseUrl.pathname.split("/").pop() ?? "",
    );
    if (urlFilename !== filename) {
      return {
        available: false,
        version,
        filename,
        sha256,
        downloadUrl,
        reason: "The Scanner Agent release URL does not match its filename.",
      };
    }
    const immutableReleaseSuffix =
      `/scanner-agent-v${version}/${encodeURIComponent(filename)}`;
    if (!releaseUrl.pathname.endsWith(immutableReleaseSuffix)) {
      return {
        available: false,
        version,
        filename,
        sha256,
        downloadUrl,
        reason:
          "The Scanner Agent release URL does not match its immutable version tag.",
      };
    }
  } catch {
    return {
      available: false,
      version,
      filename,
      sha256,
      downloadUrl,
      reason: "The configured Scanner Agent release URL is invalid.",
    };
  }
  if (!sha256 || !/^[a-f0-9]{64}$/.test(sha256)) {
    return {
      available: false,
      version,
      filename,
      sha256,
      downloadUrl,
      reason: "The published Scanner Agent checksum is invalid.",
    };
  }

  return {
    available: true,
    version,
    filename,
    sha256,
    downloadUrl,
  };
}

// ── macOS .zip (Install.command + agent files) ────────────────────────────────

async function buildMacZip(): Promise<void> {
  if (!fs.existsSync(MAC_BUILD_SCRIPT)) {
    throw new Error(`Mac packaging script not found: ${MAC_BUILD_SCRIPT}`);
  }
  await execFileAsync("bash", [MAC_BUILD_SCRIPT, MAC_ZIP_CACHE], {
    timeout: 30_000,
  });
}

function latestSourceMtime(): number {
  const dirs = [AGENT_DIR, SCRIPTS_DIR];
  let latest = 0;
  for (const dir of dirs) {
    if (!fs.existsSync(dir)) continue;
    for (const name of fs.readdirSync(dir)) {
      const fpath = path.join(dir, name);
      try {
        const st = fs.statSync(fpath);
        if (st.isFile() && st.mtimeMs > latest) latest = st.mtimeMs;
      } catch {}
    }
  }
  return latest;
}

let macZipBuildPromise: Promise<void> | undefined;

async function ensureMacZip(): Promise<void> {
  if (fs.existsSync(MAC_ZIP_CACHE)) {
    const cacheMtime = fs.statSync(MAC_ZIP_CACHE).mtimeMs;
    if (cacheMtime >= latestSourceMtime()) return;
    // Source changed since last build → invalidate cache
    fs.unlinkSync(MAC_ZIP_CACHE);
  }
  // Startup prebuild and the first request can happen at the same time.
  // Share one build so they never overwrite the same ZIP concurrently.
  if (!macZipBuildPromise) {
    macZipBuildPromise = buildMacZip().finally(() => {
      macZipBuildPromise = undefined;
    });
  }
  await macZipBuildPromise;
}

// Force rebuild on startup so each new deployment ships the latest build
if (fs.existsSync(MAC_ZIP_CACHE)) {
  try {
    fs.unlinkSync(MAC_ZIP_CACHE);
  } catch {}
}

// Pre-build at startup (non-blocking)
ensureMacZip().catch((err) => {
  logger.error({ err }, "[download] Failed to pre-build Mac .zip");
});

downloadRouter.get("/download/mac", async (req, res) => {
  try {
    trackDownload(req, res, "mac");
    await ensureMacZip();
    res.setHeader("Content-Type", "application/zip");
    res.setHeader(
      "Content-Disposition",
      'attachment; filename="PrintAgent.zip"',
    );
    fs.createReadStream(MAC_ZIP_CACHE).pipe(res);
  } catch (err) {
    logger.error({ err }, "[download] mac zip build failed");
    res.status(500).json({ error: "Failed to build Mac installer" });
  }
});

// ── Windows .zip ──────────────────────────────────────────────────────────────

downloadRouter.get("/download/windows", (req, res) => {
  trackDownload(req, res, "windows");
  res.setHeader("Content-Type", "application/zip");
  res.setHeader(
    "Content-Disposition",
    'attachment; filename="PrintAgent-Windows.zip"',
  );

  const archive = archiver("zip", { zlib: { level: 9 } });
  archive.on("error", (err: Error) => {
    res.status(500).json({ error: err.message });
  });
  archive.pipe(res);

  for (const file of WINDOWS_FILES) {
    const filePath = path.join(AGENT_DIR, file);
    if (fs.existsSync(filePath)) {
      archive.file(filePath, { name: file });
    }
  }

  archive.finalize();
});

// ── Windows Scanner Agent installer ──────────────────────────────────────────

downloadRouter.get("/download/scanner-agent/version", (_req, res) => {
  const release = getScannerAgentRelease();
  res.json(release);
});

downloadRouter.get("/download/scanner-agent", (req, res) => {
  const release = getScannerAgentRelease();
  if (!release.available || !release.downloadUrl || !release.filename) {
    res.status(503).json({
      error: release.reason ?? "Windows Scanner Agent is unavailable.",
      code: "scanner_agent_unavailable",
    });
    return;
  }

  trackDownload(req, res, "scanner-agent");
  res.setHeader("Content-Type", "application/octet-stream");
  res.setHeader(
    "Content-Disposition",
    `attachment; filename="${release.filename}"`,
  );
  // The release workflow uploads this URL to durable release storage. A
  // redirect avoids buffering a large installer in the API process while the
  // response headers preserve the operator-facing filename.
  res.setHeader("Location", release.downloadUrl);
  res.status(302).end();
});

// ── Chrome Extension .zip ──────────────────────────────────────────────────────

downloadRouter.get("/download/chrome-extension", (req, res) => {
  trackDownload(req, res, "chrome");
  res.setHeader("Content-Type", "application/zip");
  res.setHeader(
    "Content-Disposition",
    'attachment; filename="presentail-order-capture.zip"',
  );

  const archive = archiver("zip", { zlib: { level: 9 } });
  archive.on("error", (err: Error) => {
    logger.error({ err }, "[download] chrome extension zip error");
    res.status(500).json({ error: err.message });
  });
  archive.pipe(res);

  for (const file of CHROME_EXT_FILES) {
    const filePath = path.join(CHROME_EXT_DIR, file);
    if (fs.existsSync(filePath)) {
      archive.file(filePath, { name: file });
    }
  }

  archive.finalize();
});

export default downloadRouter;

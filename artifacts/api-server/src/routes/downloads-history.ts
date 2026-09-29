import { Router } from "express";
import { db } from "../lib/db";
import { requireAuth } from "../lib/auth";
import { resolveWorkspace, workspace } from "../lib/workspace";

const router = Router();

const VERSIONS = [
  {
    platform: "mac",
    version: "1.0.0",
    label: "macOS Installer",
    extension: ".zip",
    downloadUrl: "/api/download/mac",
    releasedAt: "2026-04-26",
  },
  {
    platform: "windows",
    version: "1.0.0",
    label: "Windows Package",
    extension: ".zip",
    downloadUrl: "/api/download/windows",
    releasedAt: "2026-04-26",
  },
  {
    platform: "chrome",
    version: "1.0.0",
    label: "Chrome Extension",
    extension: ".zip",
    downloadUrl: "/api/download/chrome-extension",
    releasedAt: "2026-06-05",
  },
];

router.get(
  "/downloads/versions",
  requireAuth,
  resolveWorkspace,
  async (req, res) => {
    const ownerId = workspace(req).workspaceOwnerId;
    const stats = await db.query(
      `SELECT platform, COUNT(*)::int AS count, MAX(created_at) AS last_at
     FROM download_events WHERE user_id = $1 GROUP BY platform`,
      [ownerId],
    );
    const byPlatform = new Map<
      string,
      { count: number; last_at: string | null }
    >();
    for (const row of stats.rows) {
      byPlatform.set(row.platform, { count: row.count, last_at: row.last_at });
    }
    const versions = VERSIONS.map((v) => ({
      ...v,
      downloadCount: byPlatform.get(v.platform)?.count ?? 0,
      lastDownloadedAt: byPlatform.get(v.platform)?.last_at ?? null,
    }));
    res.json({ versions });
  },
);

export default router;

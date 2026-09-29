import { Router } from "express";
import { getAuth, clerkClient } from "@clerk/express";
import { requireAuth, authed } from "../lib/auth";
import { db } from "../lib/db";

const router = Router();

function maskIp(ip: string | null | undefined): string | null {
  if (!ip) return null;
  const v4 = ip.match(/^(\d+)\.(\d+)\.\d+\.\d+$/);
  if (v4) return `${v4[1]}.${v4[2]}.x.xxx`;
  const v6 = ip.match(/^([0-9a-f]{1,4}:[0-9a-f]{1,4}):/i);
  if (v6) return `${v6[1]}:xxxx:xxxx:xxxx`;
  return "x.x.x.x";
}

function deviceLabel(session: { latestActivity?: { browserName?: string | null; deviceType?: string | null } | null }): string {
  const activity = session.latestActivity;
  const browser = activity?.browserName;
  const device = activity?.deviceType;
  if (browser && device) return `${browser} on ${device}`;
  if (browser) return browser;
  if (device) return device;
  return "Unknown device";
}

function formatSession(
  session: {
    id: string;
    lastActiveAt?: number | Date | null;
    createdAt?: number | Date | null;
    expireAt?: number | Date | null;
    latestActivity?: {
      browserName?: string | null;
      deviceType?: string | null;
      ipAddress?: string | null;
      city?: string | null;
      country?: string | null;
    } | null;
  },
  currentSessionId: string,
) {
  const toIso = (val: number | Date | null | undefined): string | null => {
    if (!val) return null;
    return new Date(typeof val === "number" ? val : val).toISOString();
  };
  return {
    id: session.id,
    deviceLabel: deviceLabel(session),
    isCurrent: session.id === currentSessionId,
    lastActiveAt: toIso(session.lastActiveAt),
    createdAt: toIso(session.createdAt),
    expireAt: toIso(session.expireAt),
    ipAddress: maskIp(session.latestActivity?.ipAddress),
    city: session.latestActivity?.city ?? null,
    country: session.latestActivity?.country ?? null,
  };
}

router.get("/security/sessions", requireAuth, async (req, res) => {
  const auth = getAuth(req);
  const userId = authed(req).userId;
  const currentSessionId = auth?.sessionId ?? "";

  const result = await clerkClient.sessions.getSessionList({ userId, status: "active" });
  const sessions = result.data.map((s) => formatSession(s, currentSessionId));

  const sorted = [...sessions].sort((a, b) => {
    if (a.isCurrent) return -1;
    if (b.isCurrent) return 1;
    return (b.lastActiveAt ?? "").localeCompare(a.lastActiveAt ?? "");
  });

  res.json({ sessions: sorted });
});

router.post("/security/sessions/:sessionId/revoke", requireAuth, async (req, res) => {
  const auth = getAuth(req);
  const userId = authed(req).userId;
  const currentSessionId = auth?.sessionId ?? "";
  const sessionId = String(req.params["sessionId"]);

  if (sessionId === currentSessionId) {
    res.status(400).json({ error: "Cannot revoke the current session" });
    return;
  }

  const result = await clerkClient.sessions.getSessionList({ userId, status: "active" });
  const owned = result.data.find((s) => s.id === sessionId);
  if (!owned) {
    res.status(404).json({ error: "Session not found" });
    return;
  }

  await clerkClient.sessions.revokeSession(sessionId);
  res.json({ success: true });
});

router.post("/security/sessions/revoke-others", requireAuth, async (req, res) => {
  const auth = getAuth(req);
  const userId = authed(req).userId;
  const currentSessionId = auth?.sessionId ?? "";

  const result = await clerkClient.sessions.getSessionList({ userId, status: "active" });
  const others = result.data.filter((s) => s.id !== currentSessionId);

  await Promise.all(others.map((s) => clerkClient.sessions.revokeSession(s.id)));
  res.json({ success: true, revokedCount: others.length });
});

router.get("/security/alert-events", requireAuth, async (req, res) => {
  const userId = authed(req).userId;

  const result = await db.query<{
    id: number;
    kind: string;
    device_label: string | null;
    country: string | null;
    sent_at: Date;
  }>(
    `SELECT id, kind, device_label, country, sent_at
       FROM security_alert_events
      WHERE user_id = $1
      ORDER BY sent_at DESC
      LIMIT 50`,
    [userId],
  );

  const events = result.rows.map((row) => ({
    id: row.id,
    kind: row.kind,
    deviceLabel: row.device_label,
    country: row.country,
    sentAt: row.sent_at instanceof Date ? row.sent_at.toISOString() : String(row.sent_at),
  }));

  res.json({ events });
});

export default router;

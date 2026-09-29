import { Router } from "express";
import { requireAuth } from "../lib/auth";
import { resolveWorkspace, workspace } from "../lib/workspace";
import { COOKIE_NAME, issueWorkspaceToken } from "../lib/imageSign";

const router = Router();

/**
 * POST /api/workspace/image-token
 *
 * Issues a short-lived HMAC-signed workspace image token and stores it in an
 * HttpOnly cookie.  The public image endpoints (brand logos, channel logos,
 * sticker thumbnails, storage objects) validate this cookie to enforce tenant
 * isolation without requiring a Clerk session header — browsers send cookies
 * automatically for same-origin <img> requests.
 *
 * Auth is applied inline (not as router-level middleware) so that other routers
 * mounted after this one — such as the public GET /invite/:token endpoint —
 * are not inadvertently blocked by a blanket requireAuth guard.
 */
router.post("/workspace/image-token", requireAuth, resolveWorkspace, (req, res) => {
  const wreq = workspace(req);
  const { token, maxAgeSeconds } = issueWorkspaceToken(wreq.workspaceOwnerId);

  res.cookie(COOKIE_NAME, token, {
    httpOnly: true,
    sameSite: "strict",
    secure: process.env.NODE_ENV === "production",
    maxAge: maxAgeSeconds * 1000,
    path: "/",
  });

  res.json({ ok: true });
});

export default router;

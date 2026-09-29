import { Router } from "express";
import { requireAuth, setUserTypeForCurrentApp } from "../lib/auth";
import type { AuthedRequest, UserType } from "../lib/auth";
import { clerkClient } from "@clerk/express";
import { logger } from "../lib/logger";

const router = Router();

/**
 * POST /auth/set-user-type
 *
 * Assigns publicMetadata.userType to the signed-in user from the server-side
 * APP_USER_TYPE environment variable. Only sets the type if the user does not
 * already have one — checked against the Clerk Admin API (authoritative source,
 * not session claims which can be stale). Called automatically during the
 * onboarding flow so new Presentail OS users get userType: "team" without
 * any user input.
 *
 * NOTE: publicMetadata.userType is for coarse app-level routing only.
 * Sensitive business logic must still be verified against the application database.
 */
router.post("/auth/set-user-type", requireAuth, async (req, res) => {
  const { userId } = req as AuthedRequest;

  const appUserType = process.env.APP_USER_TYPE as UserType | undefined;
  if (!appUserType || !["customer", "driver", "team"].includes(appUserType)) {
    logger.error({ appUserType }, "APP_USER_TYPE env var is missing or invalid");
    res.status(500).json({ error: "Server misconfiguration: APP_USER_TYPE not set" });
    return;
  }

  try {
    // Read authoritative metadata from Clerk Admin API — session claims can be
    // stale and must not be used as the source of truth for this check.
    const clerkUser = await clerkClient.users.getUser(userId);
    const existingType = (clerkUser.publicMetadata as Record<string, unknown>)?.["userType"];

    if (existingType) {
      res.json({ userType: existingType, assigned: false });
      return;
    }

    await setUserTypeForCurrentApp(userId, appUserType);
    logger.info({ userId, userType: appUserType }, "Set userType for user");
    res.json({ userType: appUserType, assigned: true });
  } catch (err) {
    logger.error({ err, userId }, "Failed to set userType for user");
    res.status(500).json({ error: "Failed to assign user type" });
  }
});

export default router;

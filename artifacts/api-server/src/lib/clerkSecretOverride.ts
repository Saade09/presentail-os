/**
 * Workaround for a Replit deployment-secrets bug where the production value of
 * CLERK_SECRET_KEY cannot be updated (the pane reverts to a stale key from a
 * different Clerk instance after every publish, so token verification fails
 * with a JWKS kid mismatch).
 *
 * A FRESH key name has no stale pinned value to revert to, so operators can
 * set CLERK_SECRET_KEY_OVERRIDE_V2 in the deployment secrets instead. The V2
 * name takes precedence over the original override, which is retained for
 * compatibility. When present, the selected override wins over
 * CLERK_SECRET_KEY for everything (@clerk/express reads
 * process.env.CLERK_SECRET_KEY, so we overwrite it here, before anything else
 * touches it).
 *
 * This module must be imported FIRST in the server entrypoint. It never logs
 * key material.
 */
const override =
  process.env.CLERK_SECRET_KEY_OVERRIDE_V2?.trim() ||
  process.env.CLERK_SECRET_KEY_OVERRIDE?.trim();
if (override) {
  process.env.CLERK_SECRET_KEY = override;
  // logger not imported to keep this module dependency-free and first-loaded.
  // eslint-disable-next-line no-console
  console.log(
    JSON.stringify({
      level: "info",
      msg: "clerk secret key override active: override replaced CLERK_SECRET_KEY",
      overrideSource: process.env.CLERK_SECRET_KEY_OVERRIDE_V2?.trim()
        ? "CLERK_SECRET_KEY_OVERRIDE_V2"
        : "CLERK_SECRET_KEY_OVERRIDE",
    }),
  );
}

export {};

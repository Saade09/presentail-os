/**
 * The deployment environment can contain a stale VITE_CLERK_PUBLISHABLE_KEY.
 * Keep production authentication deterministic and use the same effective key
 * for both Clerk middleware and the Frontend API proxy.
 */
export const PROD_CLERK_PUBLISHABLE_KEY =
  "pk_live_Y2xlcmsucHJlc2VudGFpbC5jb20k";

export function getEffectiveClerkPublishableKey(
  nodeEnv = process.env.NODE_ENV,
  envPublishableKey = process.env.VITE_CLERK_PUBLISHABLE_KEY,
): string | undefined {
  return nodeEnv === "production"
    ? PROD_CLERK_PUBLISHABLE_KEY
    : envPublishableKey;
}
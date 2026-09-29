/**
 * Augment Clerk's TypeScript interfaces so that publicMetadata.userType
 * is fully type-safe across the print-agent-web codebase.
 *
 * NOTE: publicMetadata.userType is for coarse app-level routing only.
 * Sensitive permissions and business logic must still be verified against
 * the application database.
 */

export type UserType = "customer" | "driver" | "team";

declare global {
  interface UserPublicMetadata {
    userType?: UserType;
  }

  interface CustomJwtSessionClaims {
    publicMetadata?: {
      userType?: UserType;
    };
  }
}

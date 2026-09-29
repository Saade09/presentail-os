import type { Request, Response, NextFunction } from "express";
import { requireAuth } from "../../lib/auth";
import { resolveWorkspace } from "../../lib/workspace";
import type { WorkspaceRequest } from "../../lib/workspace";

// ---------------------------------------------------------------------------
// Omnichannel RBAC role definitions
// ---------------------------------------------------------------------------

export const OMNICHANNEL_ROLES = [
  "omnichannel:owner",
  "omnichannel:manager",
  "omnichannel:agent",
  "omnichannel:viewer",
] as const;

export type OmnichannelRole = (typeof OMNICHANNEL_ROLES)[number];

const ROLE_LEVEL: Record<OmnichannelRole, number> = {
  "omnichannel:owner": 40,
  "omnichannel:manager": 30,
  "omnichannel:agent": 20,
  "omnichannel:viewer": 10,
};

/**
 * Map a workspace role to an omnichannel role.
 *
 * Owners get full omnichannel:owner access.
 * All workspace members default to omnichannel:agent for Phase 1.
 * Later phases can store a finer-grained omnichannel role in the DB.
 */
function workspaceRoleToOmnichannelRole(workspaceRole: "owner" | "member"): OmnichannelRole {
  if (workspaceRole === "owner") return "omnichannel:owner";
  return "omnichannel:agent";
}

/**
 * Express middleware factory that gates a route behind an omnichannel role
 * check.  The authenticated user must have at least `minRole` permission.
 *
 * Applies `requireAuth` and `resolveWorkspace` internally — do NOT stack
 * them again on the same route.
 *
 * Usage:
 *   router.get("/omni/conversations", requireOmnichannelRole("omnichannel:agent"), handler);
 */
export function requireOmnichannelRole(minRole: OmnichannelRole) {
  return [
    requireAuth,
    resolveWorkspace,
    (req: Request, res: Response, next: NextFunction): void => {
      const wreq = req as WorkspaceRequest;
      const omnichannelRole = workspaceRoleToOmnichannelRole(wreq.workspaceRole);
      if (ROLE_LEVEL[omnichannelRole] >= ROLE_LEVEL[minRole]) {
        next();
        return;
      }
      res.status(403).json({
        error: "Forbidden: insufficient omnichannel role",
        required: minRole,
        actual: omnichannelRole,
      });
    },
  ];
}

/**
 * Read the resolved omnichannel role from a request that has already passed
 * through `requireOmnichannelRole`.
 */
export function getOmnichannelRole(req: Request): OmnichannelRole {
  const wreq = req as WorkspaceRequest;
  return workspaceRoleToOmnichannelRole(wreq.workspaceRole);
}

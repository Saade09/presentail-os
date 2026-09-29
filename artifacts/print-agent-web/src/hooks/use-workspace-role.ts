import { useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { useAuth } from "@clerk/react";
import { z } from "zod";
import { apiFetch } from "@/lib/queryClient";
import {
  dashboardStartupRetryDelay,
  retryDashboardStartup,
} from "@/lib/dashboardBootstrapRetry";
import { useSimulatedRole } from "@/contexts/simulated-role-context";
import type { WorkspaceRole } from "@/hooks/use-roles";
import { allowedPageKeySchema } from "@/known-page-keys";

/**
 * Zod schema for the /api/users response.
 *
 * Each item in `allowedPages` must be one of the recognised page keys defined
 * in known-page-keys.ts (which derives the post-login route keys from
 * post-login-routes.ts).  An unrecognised value — e.g. a DB typo such as
 * "project_manager_dashboard" — causes `usersResponseSchema.parse()` to throw,
 * which React Query records as a query error.  This surfaces the problem
 * immediately instead of silently falling through to the default redirect.
 */
const meInfoSchema = z.object({
  role: z.string(),
  email: z.string().nullable(),
  allowedPages: z.array(allowedPageKeySchema).nullable(),
  customRoleId: z.number().nullable(),
  // Optional so older API responses without the field still parse.
  customRoleIds: z.array(z.number()).optional(),
  floristLocationId: z.number().nullable().optional(),
});

export const usersResponseSchema = z.object({
  members: z.array(z.unknown()),
  me: meInfoSchema,
});

type UsersResponse = z.infer<typeof usersResponseSchema>;
const DASHBOARD_BOOTSTRAP_TIMEOUT_MS = 15_000;

function isNoAccessError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "status" in error &&
    (error as { status?: unknown }).status === 403 &&
    "message" in error &&
    (error as { message?: unknown }).message === "no_access"
  );
}

export function useWorkspaceRole(): {
  isOwner: boolean;
  realIsOwner: boolean;
  role: string | null;
  allowedPages: string[] | null;
  customRoleId: number | null;
  customRoleIds: number[];
  floristLocationId: number | null;
  loaded: boolean;
} {
  const { isSignedIn, getToken } = useAuth();
  const { data, status } = useQuery<UsersResponse>({
    queryKey: ["users"],
    queryFn: async () => {
      const loadUsers = async (forceFreshToken = false) => {
        // Do not rely solely on ClerkTokenSync's useEffect here. This query can
        // start during the same initial render, before that effect registers the
        // shared token getter. Supplying the token directly avoids falling back
        // to an old cookie left behind by a previously-open tab.
        const token =
          typeof getToken === "function"
            ? forceFreshToken
              ? await getToken({ skipCache: true })
              : await getToken()
            : null;
        const raw = await apiFetch("/api/users", {
          timeoutMs: DASHBOARD_BOOTSTRAP_TIMEOUT_MS,
          headers: token ? { Authorization: `Bearer ${token}` } : undefined,
        });
        try {
          return usersResponseSchema.parse(raw);
        } catch (err) {
          console.error(
            "[useWorkspaceRole] /api/users response contains an unrecognised allowedPages key. " +
              "Check the DB for a typo (e.g. underscores instead of hyphens).",
            err,
          );
          throw err;
        }
      };

      try {
        return await loadUsers();
      } catch (error) {
        // An already-open tab can make its first request after a deployment
        // with a stale cached session token. Refresh it once before treating
        // the server's no_access response as a real lack of membership.
        if (!isNoAccessError(error) || typeof getToken !== "function") {
          throw error;
        }
        return loadUsers(true);
      }
    },
    retry: retryDashboardStartup,
    retryDelay: dashboardStartupRetryDelay,
    enabled: !!isSignedIn,
  });

  const { simulatedRole, setSimulatedRole } = useSimulatedRole();

  // Resolve the simulated role's permissions LIVE from the current roles
  // data (same ["roles"] query the Roles page invalidates on save), so
  // permission edits are reflected immediately instead of a stale snapshot.
  const { data: rolesData } = useQuery<{ roles: WorkspaceRole[] }>({
    queryKey: ["roles"],
    queryFn: () => apiFetch("/api/roles"),
    retry: false,
    enabled: !!isSignedIn && !!simulatedRole,
  });

  const resolvedSimulatedRole = simulatedRole
    ? rolesData?.roles.find((r) => r.id === simulatedRole.id) ?? null
    : null;

  // If the simulated role was deleted, fall back to the user's own view.
  const simulatedRoleDeleted =
    !!simulatedRole && !!rolesData && !resolvedSimulatedRole;

  useEffect(() => {
    if (simulatedRoleDeleted) {
      setSimulatedRole(null);
    }
  }, [simulatedRoleDeleted, setSimulatedRole]);

  const simulating = !!simulatedRole && !simulatedRoleDeleted;

  const realIsOwner = data?.me?.role === "owner";
  const realAllowedPages = data?.me?.allowedPages ?? null;

  const effectiveAllowedPages = simulating
    ? resolvedSimulatedRole?.allowed_pages ?? []
    : realAllowedPages;

  return {
    isOwner: realIsOwner && !simulating,
    realIsOwner,
    role: data?.me?.role ?? null,
    allowedPages: effectiveAllowedPages,
    customRoleId: data?.me?.customRoleId ?? null,
    customRoleIds: data?.me?.customRoleIds ?? [],
    floristLocationId: data?.me?.floristLocationId ?? null,
    loaded: data !== undefined || status === "error",
  };
}

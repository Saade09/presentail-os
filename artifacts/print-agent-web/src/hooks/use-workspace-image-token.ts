import { useEffect, useRef, useState } from "react";
import { useAuth } from "@clerk/react";
import { apiFetch } from "@/lib/queryClient";

const TOKEN_REFRESH_MS = 60 * 60 * 1000; // refresh every hour (token TTL is 2h)

/**
 * Calls POST /api/workspace/image-token once the user is authenticated to
 * obtain a short-lived HMAC cookie.  Browser <img> tags automatically include
 * this cookie on same-origin requests, satisfying the workspace-scoped access
 * control enforced by the public image endpoints.
 *
 * Uses apiFetch so the Clerk bearer token is attached, matching the auth
 * mechanism used everywhere else in the app.
 *
 * Returns `{ ready: true }` once the first attempt completes (success or
 * error) so callers can render content regardless — on error only images
 * will be missing, not the whole page.
 */
export function useWorkspaceImageToken(): { ready: boolean } {
  const { isSignedIn } = useAuth();
  const [ready, setReady] = useState(false);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    if (!isSignedIn) return;

    let cancelled = false;

    async function issue() {
      try {
        await apiFetch("/api/workspace/image-token", { method: "POST" });
      } catch {
        // Network error or non-ok response — fail open so non-image content
        // still renders.
      } finally {
        if (!cancelled) setReady(true);
      }
    }

    issue();

    intervalRef.current = setInterval(issue, TOKEN_REFRESH_MS);

    return () => {
      cancelled = true;
      if (intervalRef.current != null) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
    };
  }, [isSignedIn]);

  return { ready };
}

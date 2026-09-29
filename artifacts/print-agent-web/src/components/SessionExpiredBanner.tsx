import { useCallback, useEffect, useRef, useState } from "react";
import { useAuth, useClerk } from "@clerk/react";
import { useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import {
  on401,
  type FailedRequestDetail,
} from "@/lib/queryClient";

const basePath = import.meta.env.BASE_URL.replace(/\/$/, "");
const SIGN_OUT_REDIRECT_TIMEOUT_MS = 1_500;

type ForcedRecoveryOptions = {
  signOut: (options: { redirectUrl: string }) => Promise<unknown>;
  clearUserData: () => void;
  redirect: (url: string) => void;
  redirectUrl: string;
};

export async function forceStaleSessionRecovery({
  signOut,
  clearUserData,
  redirect,
  redirectUrl,
}: ForcedRecoveryOptions): Promise<void> {
  clearUserData();

  let redirected = false;
  const redirectOnce = () => {
    if (redirected) return;
    redirected = true;
    redirect(redirectUrl);
  };

  // Clerk can occasionally resolve signOut without completing its redirect,
  // or hang while synchronizing an already-deleted session. Never leave the
  // browser on the rejected identity in either case.
  const fallback = window.setTimeout(
    redirectOnce,
    SIGN_OUT_REDIRECT_TIMEOUT_MS,
  );
  try {
    await signOut({ redirectUrl });
  } catch {
    // The API already expired the browser cookies. Navigation is still safe.
  } finally {
    window.clearTimeout(fallback);
    redirectOnce();
  }
}

/**
 * Recovers rejected browser sessions.
 *
 * Generic 401s retain the manual token-refresh path. The API emits
 * stale_clerk_session only after the configured Clerk Backend API explicitly
 * reports that the cookie's user no longer exists. Retrying that identity can
 * never work, so clear all user-scoped data and ask Clerk to destroy the local
 * session immediately.
 */
export function SessionExpiredBanner() {
  const { isSignedIn } = useAuth();
  const { session, signOut } = useClerk();
  const qc = useQueryClient();
  const forcedRecoveryStarted = useRef(false);
  const [show, setShow] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const [failedRequest, setFailedRequest] =
    useState<FailedRequestDetail | null>(null);

  useEffect(() => {
    // A later successful sign-in starts a new recovery lifecycle. Keep this
    // effect before the subscription effect so a replayed startup failure sets
    // the guard only after the initial reset.
    if (isSignedIn) {
      forcedRecoveryStarted.current = false;
    }
  }, [isSignedIn]);

  useEffect(() => {
    return on401((detail) => {
      if (detail.code === "stale_clerk_session") {
        // A deleted Clerk session can still arrive through an old same-origin
        // cookie even when the current Clerk frontend already reports signed
        // out. The backend's explicit stale-session code is authoritative.
        if (!forcedRecoveryStarted.current) {
          forcedRecoveryStarted.current = true;
          const redirectUrl = `${basePath}/sign-in?session-reset=1`;
          void forceStaleSessionRecovery({
            signOut,
            clearUserData: () => qc.clear(),
            redirect: (url) => window.location.replace(url),
            redirectUrl,
          });
        }
        // The global fetch observer and QueryCache can both report the same
        // response. Never downgrade a duplicate stale-session signal into the
        // generic manual-retry banner.
        return;
      }

      setFailedRequest(detail);
      setShow(true);
    });
  }, [isSignedIn, qc, signOut]);

  const handleRetry = useCallback(async () => {
    setRetrying(true);
    try {
      if (session) {
        await session.getToken({ skipCache: true });
      }
      await qc.invalidateQueries();
      setShow(false);
    } finally {
      setRetrying(false);
    }
  }, [session, qc]);

  if (!show || !isSignedIn) return null;

  return (
    <div
      role="alert"
      className="fixed bottom-4 left-1/2 -translate-x-1/2 z-50 flex items-center gap-3 rounded-lg border border-border bg-card px-4 py-3 shadow-lg text-sm"
      data-testid="session-expired-banner"
    >
      <span className="text-foreground">
        Your session was rejected
        {failedRequest ? (
          <span className="text-muted-foreground">
            {" "}
            ({failedRequest.url ? `${failedRequest.url} → ` : ""}
            {failedRequest.status})
          </span>
        ) : null}
        . Reload to continue.
      </span>
      <Button size="sm" onClick={handleRetry} disabled={retrying}>
        {retrying ? "Reloading…" : "Reload"}
      </Button>
    </div>
  );
}
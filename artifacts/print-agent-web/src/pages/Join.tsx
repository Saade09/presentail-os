import { useEffect, useRef, useState } from "react";
import { SignUp, useAuth } from "@clerk/react";
import { useLocation } from "wouter";
import { Spinner } from "@/components/ui/spinner";
import { Button } from "@/components/ui/button";
import { ShieldOff, MailCheck, MailX, Clock } from "lucide-react";

const basePath = import.meta.env.BASE_URL.replace(/\/$/, "");
const INVITE_TOKEN_KEY = "presentail_invite_token";

type InviteInfo = {
  email: string;
  invitedBy: string | null;
  workspaceName: string | null;
};

type InviteStatus =
  | { state: "loading" }
  | { state: "valid"; info: InviteInfo }
  | { state: "invalid" }
  | { state: "used" }
  | { state: "expired" }
  | { state: "error" };

type ClaimStatus =
  | "idle"
  | "claiming"
  | "claimed"
  | "already_member"
  | "wrong_email"
  | "failed"
  | "session_not_ready";

function PageLoader() {
  return (
    <div className="flex min-h-[100dvh] items-center justify-center">
      <Spinner className="size-8 text-primary" />
    </div>
  );
}

function ErrorCard({
  icon,
  title,
  description,
  children,
}: {
  icon: React.ReactNode;
  title: string;
  description: string;
  children?: React.ReactNode;
}) {
  return (
    <div className="min-h-[100dvh] flex flex-col items-center justify-center bg-background px-4">
      <div className="w-full max-w-md rounded-2xl border border-border bg-card shadow-xl overflow-hidden">
        <div className="h-1.5 w-full" style={{ background: "#0A404E" }} />
        <div className="px-10 py-10 flex flex-col items-center text-center gap-6">
          <div
            className="w-16 h-16 rounded-2xl flex items-center justify-center"
            style={{ background: "#0A404E" }}
          >
            {icon}
          </div>
          <div className="space-y-2">
            <h1 className="text-2xl font-bold tracking-tight text-foreground">{title}</h1>
            <p className="text-sm text-muted-foreground leading-relaxed">{description}</p>
          </div>
          {children}
        </div>
      </div>
      <p className="mt-6 text-xs text-muted-foreground">
        Presentail OS &nbsp;·&nbsp; os.presentail.com
      </p>
    </div>
  );
}

export default function JoinPage() {
  const [, navigate] = useLocation();
  const { isLoaded, isSignedIn, getToken } = useAuth();
  // Stable ref so the claim effect can call getToken() without adding it to deps.
  const getTokenRef = useRef(getToken);
  getTokenRef.current = getToken;

  const params = new URLSearchParams(window.location.search);
  const urlToken = params.get("token") ?? "";
  const token = urlToken || sessionStorage.getItem(INVITE_TOKEN_KEY) || "";

  if (urlToken) {
    sessionStorage.setItem(INVITE_TOKEN_KEY, urlToken);
  }

  const [inviteStatus, setInviteStatus] = useState<InviteStatus>({ state: "loading" });
  const [claimStatus, setClaimStatus] = useState<ClaimStatus>("idle");
  const [claimError, setClaimError] = useState<string | null>(null);
  // retrySignal increments each time the user clicks Retry so the claim
  // effect re-fires without needing claimStatus in the dependency array
  // (keeping claimStatus in deps would cause the effect cleanup to abort the
  // in-flight fetch every time setClaimStatus("claiming") is called).
  const [retrySignal, setRetrySignal] = useState(0);
  // Ref that mirrors claimStatus — lets the effect read the current status
  // without adding it to deps, avoiding the abort race condition.
  const claimStatusRef = useRef<ClaimStatus>("idle");
  claimStatusRef.current = claimStatus;

  useEffect(() => {
    if (!token) {
      setInviteStatus({ state: "invalid" });
      return;
    }

    let cancelled = false;
    fetch(`${basePath}/api/invite/${encodeURIComponent(token)}`, {
      credentials: "include",
    })
      .then(async (res) => {
        if (cancelled) return;
        if (res.status === 404) {
          sessionStorage.removeItem(INVITE_TOKEN_KEY);
          setInviteStatus({ state: "invalid" });
          return;
        }
        if (res.status === 410) {
          sessionStorage.removeItem(INVITE_TOKEN_KEY);
          const body = await res.json().catch(() => ({})) as { error?: string };
          if (body.error === "Invite expired") {
            setInviteStatus({ state: "expired" });
          } else {
            setInviteStatus({ state: "used" });
          }
          return;
        }
        if (!res.ok) {
          setInviteStatus({ state: "error" });
          return;
        }
        const data = (await res.json()) as InviteInfo;
        setInviteStatus({ state: "valid", info: data });
      })
      .catch(() => {
        if (!cancelled) setInviteStatus({ state: "error" });
      });

    return () => {
      cancelled = true;
    };
  }, [token]);

  useEffect(() => {
    if (!isLoaded || !isSignedIn) return;
    if (inviteStatus.state !== "valid") return;
    // Use the ref so this guard does NOT add claimStatus to the dep array —
    // adding claimStatus to deps would re-run the cleanup (aborting the
    // in-flight fetch) every time setClaimStatus("claiming") is called.
    if (claimStatusRef.current !== "idle") return;

    const CLAIM_TIMEOUT_MS = 15_000;
    // Retry up to MAX_RETRIES times on 401 (Clerk JWT not yet propagated)
    // using exponential back-off: 500 ms, 1 000 ms, 2 000 ms.
    const MAX_RETRIES = 3;
    let cancelled = false;

    setClaimStatus("claiming");

    async function attempt(retryNum: number): Promise<void> {
      if (cancelled) return;

      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), CLAIM_TIMEOUT_MS);

      try {
        // Explicitly fetch a fresh Clerk JWT and send it as a Bearer token.
        // This avoids the cookie-propagation race that occurs immediately after
        // sign-up, where isSignedIn is true but the session cookie hasn't
        // reached the backend yet.
        const jwt = await getTokenRef.current();
        if (cancelled) { clearTimeout(timeoutId); return; }

        const authHeaders: Record<string, string> = {
          "Content-Type": "application/json",
        };
        if (jwt) authHeaders["Authorization"] = `Bearer ${jwt}`;

        const res = await fetch(`${basePath}/api/invite/claim`, {
          method: "POST",
          credentials: "include",
          headers: authHeaders,
          body: JSON.stringify({ token }),
          signal: controller.signal,
        });
        clearTimeout(timeoutId);

        if (cancelled) return;

        const data = await res.json().catch(() => ({})) as Record<string, unknown>;

        if (res.ok) {
          sessionStorage.removeItem(INVITE_TOKEN_KEY);
          if (data.alreadyMember) {
            setClaimStatus("already_member");
          } else {
            setClaimStatus("claimed");
          }
        } else if (res.status === 401) {
          // Clerk session may not have propagated yet — silently retry.
          if (retryNum < MAX_RETRIES) {
            const delay = 500 * Math.pow(2, retryNum); // 500, 1000, 2000 ms
            await new Promise<void>((resolve) => setTimeout(resolve, delay));
            return attempt(retryNum + 1);
          }
          setClaimStatus("session_not_ready");
        } else if (res.status === 403) {
          sessionStorage.removeItem(INVITE_TOKEN_KEY);
          setClaimError(typeof data.error === "string" ? data.error : null);
          setClaimStatus("wrong_email");
        } else {
          setClaimStatus("failed");
        }
      } catch (err: unknown) {
        clearTimeout(timeoutId);
        if (cancelled) return;
        const isAbort = err instanceof Error && err.name === "AbortError";
        setClaimStatus(isAbort ? "session_not_ready" : "failed");
      }
    }

    void attempt(0);

    return () => {
      cancelled = true;
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isLoaded, isSignedIn, inviteStatus.state, token, retrySignal]);

  useEffect(() => {
    if (claimStatus === "claimed" || claimStatus === "already_member") {
      navigate("/devices");
    }
  }, [claimStatus, navigate]);

  if (!isLoaded || inviteStatus.state === "loading") {
    return <PageLoader />;
  }

  if (inviteStatus.state === "invalid") {
    return (
      <ErrorCard
        icon={<ShieldOff size={28} className="text-white" />}
        title="Invalid invite link"
        description="This invite link is not valid. It may have been mistyped or the invitation was revoked."
      >
        <div className="w-full flex flex-col gap-2">
          <Button
            className="w-full"
            style={{ background: "#0A404E" }}
            onClick={() => navigate("/sign-in")}
          >
            Go to sign in
          </Button>
          <p className="text-xs text-muted-foreground">
            Don&apos;t have an invite?{" "}
            <button
              className="underline underline-offset-2 hover:text-foreground transition-colors"
              onClick={() => navigate("/sign-in")}
            >
              Sign in and request access
            </button>
          </p>
        </div>
      </ErrorCard>
    );
  }

  if (inviteStatus.state === "used") {
    return (
      <ErrorCard
        icon={<MailCheck size={28} className="text-white" />}
        title="Invite already used"
        description="This invite link has already been claimed. If you already have an account, sign in to access your workspace."
      >
        <div className="w-full flex flex-col gap-2">
          <Button
            className="w-full"
            style={{ background: "#0A404E" }}
            onClick={() => navigate("/sign-in")}
          >
            Sign in
          </Button>
          <p className="text-xs text-muted-foreground">
            Don&apos;t have access?{" "}
            <button
              className="underline underline-offset-2 hover:text-foreground transition-colors"
              onClick={() => navigate("/sign-in")}
            >
              Sign in and request access
            </button>
          </p>
        </div>
      </ErrorCard>
    );
  }

  if (inviteStatus.state === "expired") {
    return (
      <ErrorCard
        icon={<Clock size={28} className="text-white" />}
        title="Invite link expired"
        description="This invite link has expired. Please contact your workspace owner to send you a new invitation."
      >
        <div className="w-full flex flex-col gap-2">
          <Button
            className="w-full"
            style={{ background: "#0A404E" }}
            onClick={() => navigate("/sign-in")}
          >
            Go to sign in
          </Button>
        </div>
      </ErrorCard>
    );
  }

  if (inviteStatus.state === "error") {
    return (
      <ErrorCard
        icon={<ShieldOff size={28} className="text-white" />}
        title="Something went wrong"
        description="We couldn't verify your invite link. Please try again or request access from your workspace owner."
      >
        <div className="w-full flex flex-col gap-2">
          <Button
            variant="outline"
            className="w-full"
            onClick={() => window.location.reload()}
          >
            Try again
          </Button>
          <Button
            className="w-full"
            style={{ background: "#0A404E" }}
            onClick={() => navigate("/sign-in")}
          >
            Sign in to request access
          </Button>
        </div>
      </ErrorCard>
    );
  }

  if (claimStatus === "wrong_email") {
    return (
      <ErrorCard
        icon={<MailX size={28} className="text-white" />}
        title="Wrong email address"
        description={
          claimError ??
          "This invite was sent to a different email address. Please sign in with the email address that received the invitation."
        }
      >
        <div className="w-full flex flex-col gap-2">
          <Button
            className="w-full"
            style={{ background: "#0A404E" }}
            onClick={() => navigate("/sign-in")}
          >
            Sign in with the correct account
          </Button>
        </div>
      </ErrorCard>
    );
  }

  if (claimStatus === "failed") {
    return (
      <ErrorCard
        icon={<ShieldOff size={28} className="text-white" />}
        title="Invite already used"
        description="This invite link has already been claimed by another account. If you believe this is a mistake, please contact your workspace owner."
      >
        <div className="w-full flex flex-col gap-2">
          <Button
            className="w-full"
            style={{ background: "#0A404E" }}
            onClick={() => navigate("/sign-in")}
          >
            Sign in to request access
          </Button>
        </div>
      </ErrorCard>
    );
  }

  if (claimStatus === "claiming") {
    return <PageLoader />;
  }

  if (claimStatus === "session_not_ready") {
    return (
      <ErrorCard
        icon={<Clock size={28} className="text-white" />}
        title="Session not ready"
        description="Your sign-in session is still being set up. Please wait a moment and try again."
      >
        <div className="w-full flex flex-col gap-2">
          <Button
            className="w-full"
            style={{ background: "#0A404E" }}
            onClick={() => {
              setClaimStatus("idle");
              setRetrySignal((s) => s + 1);
            }}
          >
            Retry
          </Button>
        </div>
      </ErrorCard>
    );
  }

  const { info } = inviteStatus as { state: "valid"; info: InviteInfo };
  const currentUrl = `${basePath}/join?token=${encodeURIComponent(token)}`;

  return (
    <div className="flex min-h-[100dvh] flex-col items-center justify-center bg-background px-4 gap-6">
      <div className="w-full max-w-[440px] space-y-3 text-center">
        <div
          className="inline-flex items-center gap-2 rounded-full px-4 py-1.5 text-sm font-medium text-white"
          style={{ background: "#0A404E" }}
        >
          You&apos;re invited
        </div>
        <h1 className="text-2xl font-bold tracking-tight">
          Join{info.workspaceName ? ` ${info.workspaceName}` : " Presentail OS"}
        </h1>
        <p className="text-sm text-muted-foreground">
          {info.invitedBy ? (
            <>
              <span className="font-medium text-foreground">{info.invitedBy}</span>{" "}
              has invited you to collaborate on Presentail OS.
            </>
          ) : (
            "You have been invited to collaborate on Presentail OS."
          )}
        </p>
        <p className="text-xs text-muted-foreground">
          Sign up with{" "}
          <span className="font-medium text-foreground">{info.email}</span> to accept.
        </p>
      </div>

      <SignUp
        routing="path"
        path={`${basePath}/join`}
        signInUrl={`${basePath}/sign-in`}
        forceRedirectUrl={currentUrl}
        fallbackRedirectUrl={currentUrl}
        initialValues={{ emailAddress: info.email }}
        appearance={{
          elements: {
            formFieldInput__emailAddress:
              "pointer-events-none select-none opacity-60 cursor-not-allowed bg-muted",
            formFieldAction__emailAddress: "hidden",
          },
        }}
      />
    </div>
  );
}

import { useClerk } from "@clerk/react";
import { ShieldOff, Loader2 } from "lucide-react";
import { useState, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

const basePath = import.meta.env.BASE_URL.replace(/\/$/, "");

type RequestState = "idle" | "loading" | "sent" | "already_requested" | "error";

export default function NoAccessPage() {
  const { signOut } = useClerk();
  const [requestState, setRequestState] = useState<RequestState>("idle");
  const initialWorkspace =
    new URLSearchParams(window.location.search).get("workspace")?.trim() ?? "";
  const [workspace, setWorkspace] = useState(initialWorkspace);

  // On mount, check whether this user has already submitted a request so the
  // button stays disabled across page refreshes and new sessions.
  useEffect(() => {
    async function checkStatus() {
      try {
        if (!initialWorkspace) return;
        const params = new URLSearchParams({ workspace: initialWorkspace });
        const res = await fetch(`${basePath}/api/request-access/status?${params}`, {
          credentials: "include",
        });
        if (res.ok) {
          const data = await res.json();
          if (data.requested) {
            setRequestState("sent");
          }
        }
      } catch {
        // Silently ignore — worst case the button is enabled and the POST will
        // return 409 which we handle gracefully.
      }
    }
    checkStatus();
  }, [initialWorkspace]);

  async function handleRequestAccess() {
    setRequestState("loading");
    try {
      const res = await fetch(`${basePath}/api/request-access`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ workspace }),
      });
      if (res.status === 409) {
        setRequestState("already_requested");
        return;
      }
      if (!res.ok) {
        throw new Error("Request failed");
      }
      setRequestState("sent");
    } catch {
      setRequestState("error");
    }
  }

  const buttonDisabled =
    requestState === "loading" ||
    requestState === "sent" ||
    requestState === "already_requested" ||
    !workspace;

  return (
    <div className="min-h-[100dvh] flex flex-col items-center justify-center bg-background px-4">
      {/* Card */}
      <div className="w-full max-w-md rounded-2xl border border-border bg-card shadow-xl overflow-hidden">
        {/* Top accent */}
        <div className="h-1.5 w-full" style={{ background: "#0A404E" }} />

        <div className="px-10 py-10 flex flex-col items-center text-center gap-6">
          {/* Icon */}
          <div
            className="w-16 h-16 rounded-2xl flex items-center justify-center"
            style={{ background: "#0A404E" }}
          >
            <ShieldOff size={28} className="text-white" />
          </div>

          {/* Heading */}
          <div className="space-y-2">
            <h1 className="text-2xl font-bold tracking-tight text-foreground">
              Access restricted
            </h1>
            <p className="text-sm text-muted-foreground leading-relaxed">
              Your account doesn't have permission to access this workspace.
              Ask a workspace owner to invite your email address, then sign in
              again.
            </p>
          </div>

          {/* Divider + detail */}
          <div className="w-full rounded-xl bg-secondary/60 px-5 py-4 text-left space-y-1">
            <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              How to get access
            </p>
            <p className="text-sm text-foreground">
              Have a workspace owner go to{" "}
              <span className="font-medium">Dashboard → Users</span> and invite
              your email address.
            </p>
          </div>

          {/* Request Access */}
          <div className="w-full flex flex-col gap-2">
            <Input
              aria-label="Workspace slug"
              placeholder="Workspace slug"
              value={workspace}
              disabled={requestState === "loading" || requestState === "sent"}
              onChange={(event) => {
                setWorkspace(event.target.value.trim().toLowerCase());
                setRequestState("idle");
              }}
            />
            <Button
              variant="outline"
              className="w-full"
              disabled={buttonDisabled}
              onClick={handleRequestAccess}
            >
              {requestState === "loading" ? (
                <>
                  <Loader2 size={16} className="mr-2 animate-spin" />
                  Sending…
                </>
              ) : requestState === "sent" ? (
                "Request sent!"
              ) : requestState === "already_requested" ? (
                "Request sent!"
              ) : (
                "Request Access"
              )}
            </Button>
            {requestState === "already_requested" && (
              <p className="text-sm text-muted-foreground">
                You've already requested access. Please wait for an admin to review your request.
              </p>
            )}
            {requestState === "error" && (
              <p className="text-sm text-destructive">
                Something went wrong. Please try again.
              </p>
            )}
            <p className="text-sm text-muted-foreground">
              Enter the workspace slug provided by your workspace owner.
            </p>
          </div>

          {/* Sign out */}
          <Button
            className="w-full"
            style={{ background: "#0A404E" }}
            onClick={() => signOut({ redirectUrl: `${basePath}/` })}
          >
            Sign out
          </Button>
        </div>
      </div>

      {/* Footer */}
      <p className="mt-6 text-xs text-muted-foreground">
        Presentail OS &nbsp;·&nbsp; os.presentail.com
      </p>
    </div>
  );
}

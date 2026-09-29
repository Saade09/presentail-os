import { useEffect, useState } from "react";
import { Link, useLocation } from "wouter";
import { Show, useUser } from "@clerk/react";
import {
  Printer,
  CheckCircle2,
  XCircle,
  Loader2,
  Download,
  ArrowRight,
} from "lucide-react";
import { apiFetch, queryClient } from "@/lib/queryClient";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
} from "@/components/ui/card";

const AGENT_URL = "http://127.0.0.1:9191";
const AGENT_PROBE_TIMEOUT_MS = 3000;

type AgentHealth = {
  status: string;
  version: string;
  configured: boolean;
  machine_id: string;
  device_name: string;
};

type ProbeState =
  | { kind: "checking" }
  | { kind: "found"; health: AgentHealth }
  | { kind: "not-found" };

type ConnectState =
  | { kind: "idle" }
  | { kind: "connecting" }
  | { kind: "success"; deviceName: string }
  | { kind: "error"; message: string };

async function probeAgent(): Promise<AgentHealth | null> {
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), AGENT_PROBE_TIMEOUT_MS);
    const res = await fetch(`${AGENT_URL}/health`, { signal: ctrl.signal });
    clearTimeout(timer);
    if (!res.ok) return null;
    return (await res.json()) as AgentHealth;
  } catch {
    return null;
  }
}

export default function ConnectPage() {
  const { isSignedIn, user, isLoaded } = useUser();
  const [, setLocation] = useLocation();
  const [probe, setProbe] = useState<ProbeState>({ kind: "checking" });
  const [connect, setConnect] = useState<ConnectState>({ kind: "idle" });

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const health = await probeAgent();
      if (cancelled) return;
      setProbe(
        health ? { kind: "found", health } : { kind: "not-found" },
      );
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const recheck = async () => {
    setProbe({ kind: "checking" });
    const health = await probeAgent();
    setProbe(health ? { kind: "found", health } : { kind: "not-found" });
  };

  const handleConnect = async () => {
    if (probe.kind !== "found") return;
    // If the agent is already paired, ask before overwriting — this protects
    // against accidentally re-linking someone else's Mac to your account.
    if (probe.health.configured) {
      const ok = window.confirm(
        `"${probe.health.device_name}" is already linked to a Presentail account. ` +
          `Replace that link with your account (${user?.primaryEmailAddress?.emailAddress ?? "current user"})?`,
      );
      if (!ok) return;
    }
    setConnect({ kind: "connecting" });
    try {
      // 1. Create a fresh API key tied to this Mac's hostname.
      const keyName = `${probe.health.device_name} (auto-paired ${new Date().toLocaleDateString()})`;
      const created = await apiFetch<{ plaintext: string }>("/api/api-keys", {
        method: "POST",
        body: JSON.stringify({ name: keyName }),
        headers: { "Content-Type": "application/json" },
      });

      // 2. Push the key into the locally-running agent. This call also
      // registers the device with the cloud and returns its name.
      const res = await fetch(`${AGENT_URL}/configure`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          api_key: created.plaintext,
          api_url: window.location.origin,
        }),
      });

      if (!res.ok) {
        const err = (await res.json().catch(() => ({}))) as {
          error?: string;
        };
        setConnect({
          kind: "error",
          message: err.error ?? `Could not connect (status ${res.status})`,
        });
        return;
      }

      const body = (await res.json()) as { device_name: string };
      queryClient.invalidateQueries({ queryKey: ["devices"] });
      setConnect({ kind: "success", deviceName: body.device_name });
    } catch (e) {
      setConnect({
        kind: "error",
        message:
          e instanceof Error ? e.message : "Unexpected error while connecting",
      });
    }
  };

  return (
    <div className="min-h-[100dvh] bg-background flex items-center justify-center p-6">
      <div className="w-full max-w-xl space-y-6">
        <div className="flex items-center gap-3">
          <img src="/logo.svg" alt="" className="w-10 h-10" />
          <div>
            <h1 className="text-2xl font-bold tracking-tight">
              Connect this Mac
            </h1>
            <p className="text-muted-foreground text-sm">
              Link Presentail OS on this computer to your account.
            </p>
          </div>
        </div>

        {!isLoaded && (
          <Card>
            <CardContent className="py-8 flex items-center justify-center gap-2 text-muted-foreground">
              <Loader2 size={18} className="animate-spin" />
              <span>Checking sign-in status…</span>
            </CardContent>
          </Card>
        )}

        <Show when="signed-out">
          <Card>
            <CardHeader>
              <CardTitle>Sign in first</CardTitle>
              <CardDescription>
                You need to be signed in to connect a device.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <Button
                onClick={() => setLocation("/sign-in")}
                data-testid="button-sign-in"
              >
                Sign in
                <ArrowRight size={16} className="ml-1" />
              </Button>
            </CardContent>
          </Card>
        </Show>

        <Show when="signed-in">
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Printer size={20} />
                Presentail OS on this Mac
              </CardTitle>
              <CardDescription>
                {isSignedIn && user?.primaryEmailAddress
                  ? `Connecting as ${user.primaryEmailAddress.emailAddress}`
                  : ""}
              </CardDescription>
            </CardHeader>

            <CardContent className="space-y-4">
              {probe.kind === "checking" && (
                <div className="flex items-center gap-2 text-muted-foreground">
                  <Loader2 size={16} className="animate-spin" />
                  Looking for Presentail OS on this computer…
                </div>
              )}

              {probe.kind === "not-found" && (
                <div className="space-y-3">
                  <div className="flex items-start gap-2 text-destructive">
                    <XCircle size={18} className="mt-0.5" />
                    <div>
                      <div className="font-medium">
                        Presentail OS not detected
                      </div>
                      <div className="text-sm text-muted-foreground">
                        Make sure you've installed the agent on this Mac. After
                        installing, you may need to wait a few seconds.
                      </div>
                    </div>
                  </div>
                  <div className="flex gap-2">
                    <Button onClick={recheck} variant="outline" data-testid="button-recheck">
                      Try again
                    </Button>
                    <Link href="/downloads">
                      <Button data-testid="button-go-downloads">
                        <Download size={16} className="mr-1" />
                        Download installer
                      </Button>
                    </Link>
                  </div>
                </div>
              )}

              {probe.kind === "found" && connect.kind !== "success" && (
                <>
                  <div className="flex items-start gap-2 text-green-600 dark:text-green-500">
                    <CheckCircle2 size={18} className="mt-0.5" />
                    <div>
                      <div className="font-medium text-foreground">
                        Found "{probe.health.device_name}"
                      </div>
                      <div className="text-sm text-muted-foreground">
                        Agent v{probe.health.version} is running.
                        {probe.health.configured
                          ? " It's already linked to an account — clicking Connect will re-link it to your account."
                          : ""}
                      </div>
                    </div>
                  </div>

                  {connect.kind === "error" && (
                    <div className="text-sm text-destructive bg-destructive/10 rounded-md p-3">
                      {connect.message}
                    </div>
                  )}

                  <Button
                    onClick={handleConnect}
                    disabled={connect.kind === "connecting"}
                    size="lg"
                    className="w-full"
                    data-testid="button-connect"
                  >
                    {connect.kind === "connecting" ? (
                      <>
                        <Loader2 size={16} className="mr-2 animate-spin" />
                        Connecting…
                      </>
                    ) : (
                      <>Connect this Mac</>
                    )}
                  </Button>
                </>
              )}

              {connect.kind === "success" && (
                <div className="space-y-4">
                  <div className="flex items-start gap-2">
                    <CheckCircle2
                      size={20}
                      className="mt-0.5 text-green-600 dark:text-green-500"
                    />
                    <div>
                      <div className="font-medium">
                        "{connect.deviceName}" is now connected.
                      </div>
                      <div className="text-sm text-muted-foreground">
                        It will stay online as long as your Mac is on, and will
                        re-connect automatically when you log in.
                      </div>
                    </div>
                  </div>
                  <Link href="/devices">
                    <Button className="w-full" data-testid="button-go-devices">
                      Open Devices
                      <ArrowRight size={16} className="ml-1" />
                    </Button>
                  </Link>
                </div>
              )}
            </CardContent>
          </Card>
        </Show>

        <p className="text-center text-xs text-muted-foreground">
          The Print Agent only listens on this computer (127.0.0.1). Your API
          key is sent directly to it and never leaves your machine.
        </p>
      </div>
    </div>
  );
}

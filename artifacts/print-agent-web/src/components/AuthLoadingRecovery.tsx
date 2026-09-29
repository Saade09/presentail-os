import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";

export function AuthLoadingRecovery() {
  const [timedOut, setTimedOut] = useState(false);

  useEffect(() => {
    const timeout = window.setTimeout(() => setTimedOut(true), 15_000);
    return () => window.clearTimeout(timeout);
  }, []);

  if (!timedOut) {
    return (
      <div className="flex min-h-[100dvh] items-center justify-center">
        <Spinner className="size-8 text-primary" />
      </div>
    );
  }

  return (
    <div
      className="flex min-h-[100dvh] flex-col items-center justify-center gap-4 bg-background p-6 text-center"
      role="alert"
      data-testid="dashboard-loading-recovery"
    >
      <div className="max-w-md space-y-2">
        <h1 className="text-lg font-semibold text-foreground">
          Sign-in is taking longer than expected
        </h1>
        <p className="text-sm text-muted-foreground">
          Reload the page to reconnect to your session.
        </p>
      </div>
      <Button type="button" onClick={() => window.location.reload()}>
        Reload page
      </Button>
    </div>
  );
}

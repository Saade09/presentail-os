import { useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { WifiOff, WifiIcon, RefreshCw, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { apiFetch } from "@/lib/queryClient";
import { useIsSlowConnection } from "@/hooks/use-slow-connection";

const RESTORED_DISMISS_MS = 1500;

const PREFETCH_QUERIES = [
  { queryKey: ["users"], url: "/api/users" },
  { queryKey: ["devices"], url: "/api/devices" },
  { queryKey: ["api-keys"], url: "/api/api-keys" },
  { queryKey: ["print-jobs"], url: "/api/print-jobs" },
  { queryKey: ["stickers"], url: "/api/stickers" },
  { queryKey: ["downloads-versions"], url: "/api/downloads/versions" },
] as const;

export function DataSaverBanner() {
  const queryClient = useQueryClient();
  const isPaused = useIsSlowConnection();
  const prevIsPausedRef = useRef(isPaused);
  const [dismissed, setDismissed] = useState(false);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [restoredRefreshing, setRestoredRefreshing] = useState(false);
  const autoRefreshTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const wasSlow = prevIsPausedRef.current;
    prevIsPausedRef.current = isPaused;

    if (wasSlow && !isPaused) {
      setDismissed(false);
      triggerAutoRefresh();
    }
  }, [isPaused]);

  useEffect(() => {
    return () => {
      if (autoRefreshTimeoutRef.current) {
        clearTimeout(autoRefreshTimeoutRef.current);
      }
    };
  }, []);

  async function triggerAutoRefresh() {
    setRestoredRefreshing(true);
    try {
      await Promise.allSettled(
        PREFETCH_QUERIES.map(({ queryKey, url }) =>
          queryClient.invalidateQueries({ queryKey })
            .then(() => queryClient.fetchQuery({
              queryKey,
              queryFn: () => apiFetch(url),
            }))
        )
      );
    } finally {
      autoRefreshTimeoutRef.current = setTimeout(() => {
        setRestoredRefreshing(false);
        setDismissed(true);
      }, RESTORED_DISMISS_MS);
    }
  }

  async function handleRefreshNow() {
    setIsRefreshing(true);
    try {
      await Promise.allSettled(
        PREFETCH_QUERIES.map(({ queryKey, url }) =>
          queryClient.invalidateQueries({ queryKey })
            .then(() => queryClient.fetchQuery({
              queryKey,
              queryFn: () => apiFetch(url),
            }))
        )
      );
    } finally {
      setIsRefreshing(false);
      setDismissed(true);
    }
  }

  if (restoredRefreshing) {
    return (
      <div
        role="status"
        aria-live="polite"
        className="flex items-center gap-3 bg-green-50 border-b border-green-200 px-4 py-2.5 text-sm text-green-900"
        data-testid="data-saver-banner-restored"
      >
        <WifiIcon size={15} className="shrink-0 text-green-600" />
        <span className="flex-1 flex items-center gap-2">
          Connection restored — refreshing…
          <RefreshCw size={13} className="animate-spin text-green-600" />
        </span>
      </div>
    );
  }

  if (!isPaused || dismissed) return null;

  return (
    <div
      role="status"
      aria-live="polite"
      className="flex items-center gap-3 bg-amber-50 border-b border-amber-200 px-4 py-2.5 text-sm text-amber-900"
      data-testid="data-saver-banner"
    >
      <WifiOff size={15} className="shrink-0 text-amber-600" />
      <span className="flex-1">
        Auto-refresh is paused on your current connection. Data may be out of
        date.
      </span>
      <Button
        variant="ghost"
        size="sm"
        className="h-7 gap-1.5 px-2.5 text-amber-900 hover:bg-amber-100 hover:text-amber-900"
        onClick={handleRefreshNow}
        disabled={isRefreshing}
        data-testid="data-saver-banner-refresh"
      >
        <RefreshCw size={13} className={isRefreshing ? "animate-spin" : ""} />
        {isRefreshing ? "Refreshing…" : "Refresh now"}
      </Button>
      <Button
        variant="ghost"
        size="icon"
        className="h-7 w-7 text-amber-700 hover:bg-amber-100 hover:text-amber-900"
        onClick={() => setDismissed(true)}
        aria-label="Dismiss"
        data-testid="data-saver-banner-dismiss"
      >
        <X size={13} />
      </Button>
    </div>
  );
}

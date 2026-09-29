import { useState } from "react";
import { RefreshCw } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { apiFetch } from "@/lib/queryClient";
import { useIsSlowConnection } from "@/hooks/use-slow-connection";

type QuerySpec = {
  queryKey: string[];
  url: string;
};

type Props = {
  queries: QuerySpec[];
  "data-testid"?: string;
};

export function StaleDataBadge({ queries, "data-testid": testId }: Props) {
  const isSlow = useIsSlowConnection();
  const queryClient = useQueryClient();
  const [isRefreshing, setIsRefreshing] = useState(false);

  if (!isSlow) return null;

  async function handleRefresh() {
    setIsRefreshing(true);
    try {
      await Promise.allSettled(
        queries.map(({ queryKey, url }) =>
          queryClient
            .invalidateQueries({ queryKey })
            .then(() =>
              queryClient.fetchQuery({
                queryKey,
                queryFn: () => apiFetch(url),
              })
            )
        )
      );
    } finally {
      setIsRefreshing(false);
    }
  }

  return (
    <button
      onClick={handleRefresh}
      disabled={isRefreshing}
      data-testid={testId ?? "stale-data-badge"}
      className="inline-flex items-center gap-1.5 text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-full px-3 py-1 hover:bg-amber-100 disabled:opacity-60 disabled:cursor-not-allowed transition-colors"
    >
      <RefreshCw
        size={11}
        className={isRefreshing ? "animate-spin" : ""}
        aria-hidden
      />
      {isRefreshing ? "Refreshing…" : "Data may be stale — Refresh now"}
    </button>
  );
}

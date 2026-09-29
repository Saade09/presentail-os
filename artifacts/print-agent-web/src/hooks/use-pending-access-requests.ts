import { useQuery } from "@tanstack/react-query";
import { apiFetch, queryClient } from "@/lib/queryClient";
import { useAuthedSse } from "@/hooks/use-authed-sse";

type AccessRequest = {
  id: number;
  requester_clerk_id: string;
  requester_email: string;
  requester_name: string;
  status: string;
  requested_at: string;
  resolved_at: string | null;
};

export function usePendingAccessRequests(enabled: boolean) {
  useAuthedSse("/api/access-requests/events", enabled, {
    changed: () => {
      queryClient.invalidateQueries({ queryKey: ["access-requests"] });
    },
  });

  return useQuery<{ requests: AccessRequest[] }>({
    queryKey: ["access-requests"],
    queryFn: () => apiFetch("/api/access-requests"),
    enabled,
    refetchInterval: 31_000,
    retry: false,
  });
}

export function usePendingAccessRequestCount(enabled: boolean): number {
  const { data } = usePendingAccessRequests(enabled);
  return data?.requests?.length ?? 0;
}

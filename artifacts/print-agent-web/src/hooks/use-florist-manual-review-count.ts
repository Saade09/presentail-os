import { useQuery } from "@tanstack/react-query";
import { getGetFloristManualReviewCountQueryKey } from "@workspace/api-client-react";
import { apiFetch } from "@/lib/queryClient";

export function useFloristManualReviewCount(enabled: boolean): number {
  const { data } = useQuery<{ success: boolean; count: number }>({
    queryKey: getGetFloristManualReviewCountQueryKey(),
    queryFn: () => apiFetch("/api/florist-orders/manual-review/count"),
    enabled,
    staleTime: 30_000,
    refetchInterval: 30_000,
    retry: false,
  });
  return data?.count ?? 0;
}
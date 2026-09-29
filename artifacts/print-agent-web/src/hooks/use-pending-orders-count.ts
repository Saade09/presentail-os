import { useQuery } from "@tanstack/react-query";
import { apiFetch } from "@/lib/queryClient";

export function usePendingOrdersCount(): number {
  const { data } = useQuery<{ success: boolean; count: number }>({
    queryKey: ["orders", "pending-count"],
    queryFn: () => apiFetch("/api/orders/pending-count"),
    staleTime: 30_000,
    refetchInterval: 30_000,
    retry: false,
  });
  return data?.count ?? 0;
}

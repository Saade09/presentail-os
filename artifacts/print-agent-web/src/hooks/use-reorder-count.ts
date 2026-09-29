import { useQuery } from "@tanstack/react-query";
import { apiFetch } from "@/lib/queryClient";

export function useReorderCount(): number {
  const { data } = useQuery<{ items: unknown[] }>({
    queryKey: ["suppliers", "reorder-needed"],
    queryFn: () => apiFetch("/api/suppliers/reorder-needed"),
    staleTime: 60_000,
    refetchInterval: 60_000,
    retry: false,
  });
  return data?.items?.length ?? 0;
}

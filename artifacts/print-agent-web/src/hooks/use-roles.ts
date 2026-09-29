import { useQuery } from "@tanstack/react-query";
import { apiFetch } from "@/lib/queryClient";

export type WorkspaceRole = {
  id: number;
  name: string;
  description: string | null;
  allowed_pages: string[];
  channel_ids: number[];
  created_at: string;
  updated_at: string;
};

export function useRoles() {
  return useQuery<{ roles: WorkspaceRole[] }>({
    queryKey: ["roles"],
    queryFn: () => apiFetch("/api/roles"),
    retry: false,
  });
}

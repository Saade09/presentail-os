import { useQuery } from "@tanstack/react-query";
import { apiFetch, queryClient } from "@/lib/queryClient";
import { useAuthedSse } from "@/hooks/use-authed-sse";

export type TimeOffNotification = {
  id: number;
  type: string;
  title: string;
  body: string;
  entity_id: number | null;
  is_read: boolean;
  created_at: string;
  actor_name: string | null;
  actor_email: string;
};

const QUERY_KEY = ["time-off-notifications"];

export function getTimeOffNotificationsQueryKey() {
  return QUERY_KEY;
}

/**
 * Fetches unread time-off notifications for the current member (acting as a manager).
 * Opens a token-authenticated SSE connection to receive real-time pushes.
 * @param enabled Pass true for any logged-in member (non-owners who are managers will receive these).
 */
export function useTimeOffNotifications(enabled: boolean) {
  useAuthedSse("/api/time-off/notifications/events", enabled, {
    changed: () => {
      queryClient.invalidateQueries({ queryKey: QUERY_KEY });
    },
  });

  return useQuery<{ notifications: TimeOffNotification[] }>({
    queryKey: QUERY_KEY,
    queryFn: () => apiFetch("/api/time-off/notifications"),
    enabled,
    refetchInterval: 34_000,
    retry: false,
  });
}

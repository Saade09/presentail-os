import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { apiFetch, queryClient } from "@/lib/queryClient";
import { useAuthedSse } from "@/hooks/use-authed-sse";

export type AttendanceCorrectionRequest = {
  id: number;
  employee_id: number;
  employee_name: string | null;
  request_type: string;
  reason: string | null;
  status: string;
  is_read: boolean;
  created_at: string;
};

const QUERY_KEY = ["admin-attendance-correction-requests-pending"];
const LS_SEEN_KEY = "attendance_correction_seen_ids";

export function getAttendanceCorrectionNotificationsQueryKey() {
  return QUERY_KEY;
}

function readSeenIdsFromStorage(): Set<number> {
  try {
    const raw = localStorage.getItem(LS_SEEN_KEY);
    if (!raw) return new Set();
    return new Set(JSON.parse(raw) as number[]);
  } catch {
    return new Set();
  }
}

export function writeAttendanceCorrectionSeenIds(ids: Set<number>): void {
  try {
    localStorage.setItem(LS_SEEN_KEY, JSON.stringify([...ids]));
  } catch {}
}

/**
 * Fetches pending attendance correction requests for owners/managers and
 * opens an SSE connection to receive real-time pushes when new requests arrive.
 * Only enabled when the caller has manager/owner access.
 */
export function useAttendanceCorrectionNotifications(enabled: boolean) {
  const [localSeenIds, setLocalSeenIds] = useState<Set<number>>(readSeenIdsFromStorage);
  const prevPendingIds = useRef<Set<number>>(new Set());

  useAuthedSse("/api/admin/attendance/requests/events", enabled, {
    changed: () => {
      queryClient.invalidateQueries({ queryKey: QUERY_KEY });
    },
  });

  const query = useQuery<{ requests: AttendanceCorrectionRequest[] }>({
    queryKey: QUERY_KEY,
    queryFn: () => apiFetch("/api/admin/attendance/requests?status=pending&limit=50"),
    enabled,
    refetchInterval: 33_000,
    retry: false,
  });

  const requests = query.data?.requests ?? [];

  useEffect(() => {
    if (requests.length === 0) return;
    const currentIds = new Set(requests.map((r) => r.id));

    const newIds: number[] = [];
    for (const id of currentIds) {
      if (!prevPendingIds.current.has(id)) {
        newIds.push(id);
      }
    }
    prevPendingIds.current = currentIds;

    if (newIds.length === 0) return;
    setLocalSeenIds((prev) => {
      const alreadySeen = newIds.every((id) => prev.has(id));
      if (alreadySeen) return prev;
      return prev;
    });
  }, [requests]);

  const markSeenMutation = useMutation({
    mutationFn: (ids: number[]) =>
      apiFetch("/api/admin/attendance/requests/seen", {
        method: "POST",
        body: JSON.stringify({ ids }),
      }),
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: QUERY_KEY });
    },
  });

  const markSeen = (ids: number[]) => {
    setLocalSeenIds((prev) => {
      const next = new Set(prev);
      for (const id of ids) next.add(id);
      writeAttendanceCorrectionSeenIds(next);
      return next;
    });
    markSeenMutation.mutate(ids);
  };

  // Seed from server is_read flag so the badge stays clear after navigation.
  const serverReadIds = new Set(requests.filter((r) => r.is_read).map((r) => r.id));
  const seenIds = new Set([...serverReadIds, ...localSeenIds]);

  const unseenCount = requests.filter((r) => !seenIds.has(r.id)).length;

  return { requests, unseenCount, seenIds, markSeen, isLoading: query.isLoading };
}

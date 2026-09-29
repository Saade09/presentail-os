import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiFetch } from "@/lib/queryClient";

export type SalaryDecisionNotification = {
  id: number;
  cash_session_id: number | null;
  session_number: string | null;
  amount: string;
  currency: string;
  transaction_currency: string | null;
  payee: string | null;
  approval_status: "confirmed" | "declined";
  approval_decline_reason: string | null;
  approval_decided_at: string | null;
};

const QUERY_KEY = ["salary-approval-decisions"];

/**
 * The current user's approved/declined salary expense requests that they have
 * not acknowledged yet — feeds the notification bell. Acknowledging removes
 * them server-side (approval_requester_ack_at).
 */
export function useSalaryApprovalNotifications(enabled: boolean) {
  const queryClient = useQueryClient();

  const { data } = useQuery<{ decisions: SalaryDecisionNotification[] }>({
    queryKey: QUERY_KEY,
    queryFn: () => apiFetch("/api/cash-approvals/my-decisions"),
    enabled,
    refetchInterval: 60_000,
    staleTime: 30_000,
  });

  const ackMutation = useMutation({
    mutationFn: (ids: number[]) =>
      apiFetch("/api/cash-approvals/my-decisions/ack", {
        method: "POST",
        body: JSON.stringify({ ids }),
      }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: QUERY_KEY }),
  });

  return {
    salaryDecisions: data?.decisions ?? [],
    ackSalaryDecisions: (ids: number[]) => {
      if (ids.length > 0) ackMutation.mutate(ids);
    },
  };
}

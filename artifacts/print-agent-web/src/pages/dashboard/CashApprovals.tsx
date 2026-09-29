import { useEffect, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Link, useSearch } from "wouter";
import { useTranslation } from "react-i18next";
import { BadgeCheck, Ban, Loader2, Wallet } from "lucide-react";
import { apiFetch } from "@/lib/queryClient";
import { formatCashMoney } from "@/lib/cashMoney";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useToast } from "@/hooks/use-toast";

type ApprovalRequest = {
  id: number;
  cash_session_id: number | null;
  session_number: string | null;
  amount: string;
  currency: string;
  transaction_currency: string | null;
  payee: string | null;
  description: string | null;
  payroll_payment_type: string | null;
  payroll_period: string | null;
  requested_by_name: string | null;
  transaction_date: string;
};

const QUERY_KEY = ["cash-approvals"];

/**
 * Salary expense approval queue. Gated server-side to Business Development
 * role holders and workspace owners; the Slack DM link deep-links here with
 * ?tx=<id> to highlight one request.
 */
export default function CashApprovalsPage() {
  const { t } = useTranslation();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const search = useSearch();
  const highlightedTx = (() => {
    const v = new URLSearchParams(search).get("tx");
    const n = v ? parseInt(v, 10) : NaN;
    return Number.isFinite(n) ? n : null;
  })();

  const { data, isLoading, error } = useQuery<{ requests: ApprovalRequest[] }>({
    queryKey: QUERY_KEY,
    queryFn: () => apiFetch("/api/cash-approvals"),
    retry: false,
  });

  const [declineTarget, setDeclineTarget] = useState<ApprovalRequest | null>(null);
  const [declineReason, setDeclineReason] = useState("");

  useEffect(() => {
    if (highlightedTx != null && data?.requests.some((r) => r.id === highlightedTx)) {
      document.getElementById(`approval-${highlightedTx}`)?.scrollIntoView({ block: "center" });
    }
  }, [highlightedTx, data]);

  const invalidate = () => queryClient.invalidateQueries({ queryKey: QUERY_KEY });

  const approveMutation = useMutation({
    mutationFn: (txId: number) => apiFetch(`/api/cash-approvals/${txId}/approve`, { method: "POST" }),
    onSuccess: () => {
      toast({ title: t("cashApprovals.approved", "Salary expense approved") });
      invalidate();
    },
    onError: (err: Error) => toast({ title: err.message, variant: "destructive" }),
  });

  const declineMutation = useMutation({
    mutationFn: ({ txId, reason }: { txId: number; reason: string }) =>
      apiFetch(`/api/cash-approvals/${txId}/decline`, {
        method: "POST",
        body: JSON.stringify({ reason: reason.trim() || undefined }),
      }),
    onSuccess: () => {
      toast({ title: t("cashApprovals.declined", "Salary expense declined") });
      setDeclineTarget(null);
      setDeclineReason("");
      invalidate();
    },
    onError: (err: Error) => toast({ title: err.message, variant: "destructive" }),
  });

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-20 text-muted-foreground">
        <Loader2 className="h-6 w-6 animate-spin" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="p-6">
        <Card>
          <CardContent className="py-10 text-center text-sm text-muted-foreground" data-testid="text-approvals-error">
            {(error as Error).message ||
              t("cashApprovals.noAccess", "You do not have permission to review salary expense approvals.")}
          </CardContent>
        </Card>
      </div>
    );
  }

  const requests = data?.requests ?? [];

  return (
    <div className="space-y-4 p-4 md:p-6">
      <div>
        <h1 className="text-xl font-semibold" data-testid="text-approvals-title">
          {t("cashApprovals.title", "Salary Expense Approvals")}
        </h1>
        <p className="text-sm text-muted-foreground">
          {t(
            "cashApprovals.subtitle",
            "Pending Salaries & Wages cash expenses. Approving deducts the drawer balance; declining discards the expense.",
          )}
        </p>
      </div>

      {requests.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center gap-2 py-12 text-center text-sm text-muted-foreground" data-testid="text-no-pending">
            <Wallet className="h-8 w-8 opacity-40" />
            {t("cashApprovals.empty", "No pending salary expense requests.")}
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-3">
          {requests.map((r) => {
            const currency = r.transaction_currency ?? r.currency;
            const highlighted = r.id === highlightedTx;
            return (
              <Card
                key={r.id}
                id={`approval-${r.id}`}
                className={highlighted ? "border-amber-400 ring-1 ring-amber-300" : undefined}
                data-testid={`card-approval-${r.id}`}
              >
                <CardHeader className="flex-row items-center justify-between space-y-0 pb-2">
                  <CardTitle className="text-base">
                    {r.payee ?? "—"}
                    <span className="ms-2 font-normal text-muted-foreground">
                      {formatCashMoney(r.amount, currency)}
                    </span>
                  </CardTitle>
                  <Badge variant="outline" className="text-amber-700 border-amber-300 bg-amber-50">
                    {t("cashApprovals.pending", "Pending approval")}
                  </Badge>
                </CardHeader>
                <CardContent className="space-y-3">
                  <div className="grid gap-1 text-sm text-muted-foreground">
                    {r.description && <span>{r.description}</span>}
                    <span>
                      {t("cashApprovals.requestedBy", "Requested by")}: {r.requested_by_name ?? "—"} ·{" "}
                      {new Date(r.transaction_date).toLocaleString()}
                    </span>
                    {r.session_number && r.cash_session_id != null && (
                      <span>
                        {t("cashApprovals.session", "Cash session")}:{" "}
                        <Link href={`/cash-sessions/${r.cash_session_id}`} className="underline">
                          {r.session_number}
                        </Link>
                      </span>
                    )}
                  </div>
                  <div className="flex gap-2">
                    <Button
                      size="sm"
                      className="gap-1.5"
                      data-testid={`button-approve-${r.id}`}
                      disabled={approveMutation.isPending || declineMutation.isPending}
                      onClick={() => approveMutation.mutate(r.id)}
                    >
                      <BadgeCheck className="h-4 w-4" />
                      {t("cashApprovals.approve", "Approve")}
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      className="gap-1.5 text-destructive"
                      data-testid={`button-decline-${r.id}`}
                      disabled={approveMutation.isPending || declineMutation.isPending}
                      onClick={() => {
                        setDeclineReason("");
                        setDeclineTarget(r);
                      }}
                    >
                      <Ban className="h-4 w-4" />
                      {t("cashApprovals.decline", "Decline")}
                    </Button>
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}

      <Dialog open={declineTarget !== null} onOpenChange={(o) => !o && setDeclineTarget(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("cashApprovals.declineTitle", "Decline salary expense")}</DialogTitle>
          </DialogHeader>
          {declineTarget && (
            <p className="text-sm text-muted-foreground">
              {declineTarget.payee ?? "—"} ·{" "}
              {formatCashMoney(declineTarget.amount, declineTarget.transaction_currency ?? declineTarget.currency)}
            </p>
          )}
          <div className="space-y-1.5">
            <Label htmlFor="decline-reason">{t("cashApprovals.reasonOptional", "Reason (optional)")}</Label>
            <Textarea
              id="decline-reason"
              rows={2}
              value={declineReason}
              onChange={(e) => setDeclineReason(e.target.value)}
              data-testid="input-decline-reason"
            />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeclineTarget(null)}>
              {t("common.cancel", "Cancel")}
            </Button>
            <Button
              variant="destructive"
              data-testid="button-confirm-decline"
              disabled={declineMutation.isPending}
              onClick={() =>
                declineTarget && declineMutation.mutate({ txId: declineTarget.id, reason: declineReason })
              }
            >
              {t("cashApprovals.confirmDecline", "Decline request")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

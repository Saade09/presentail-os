import React, { useMemo, useRef, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Link, useLocation, useParams } from "wouter";
import { useTranslation } from "react-i18next";
import {
  ArrowLeft,
  ArrowLeftRight,
  ArrowRight,
  ArrowRightLeft,
  Building2,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Clock,
  Copy,
  ExternalLink,
  Flag,
  Loader2,
  Lock,
  Minus,
  MoreHorizontal,
  Paperclip,
  Plus,
  RotateCcw,
  Search,
  SlidersHorizontal,
  Undo2,
  FileText,
  X,
  AlertTriangle,
  Info,
  Download,
} from "lucide-react";
import { TransferCashModal } from "./TransferCashModal";
import { TransferDetailPanel } from "./TransferDetailPanel";
import { apiFetch, getClerkToken } from "@/lib/queryClient";
import { formatCashMoney, DASH } from "@/lib/cashMoney";
import { imageUrl } from "@/lib/imageUrl";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useToast } from "@/hooks/use-toast";
import { useWorkspaceRole } from "@/hooks/use-workspace-role";
import { canManageCashSessionLifecycle } from "@/lib/cashSessionsDashboard";

const TEAL_DARK = "#064E5A";
const TEAL_PALE = "#E6F4F6";

export const SALE_CHANNELS = [
  "walk_in",
  "whatsapp",
  "website",
  "phone_order",
  "toters",
  "deliveroo",
  "careem",
  "talabat",
  "other",
] as const;

export const EXPENSE_CATEGORIES = [
  "supplies",
  "flowers",
  "packaging",
  "delivery",
  "fuel",
  "utilities",
  "maintenance",
  "food_beverage",
  "salaries_wages",
  "other",
] as const;

export const PAYROLL_PAYMENT_TYPES = [
  "salary",
  "salary_advance",
  "bonus",
  "other_payroll",
] as const;
type Session = {
  id: number;
  session_number: string;
  drawer_id: number | null;
  drawer_name: string | null;
  location_name: string | null;
  currency: string;
  status: string;
  opening_cash: string;
  expected_cash: string | null;
  actual_cash: string | null;
  difference: string | null;
  opening_note: string | null;
  closing_note: string | null;
  flag_reason: string | null;
  reopen_reason: string | null;
  closing_counts: ClosingCount[] | null;
  opened_at: string;
  closed_at: string | null;
  approved_at: string | null;
  opened_by_name: string | null;
  closed_by_name: string | null;
  approved_by_name: string | null;
};

type ClosingCount = {
  currency: string;
  expected: number;
  actual: number | null;
  variance: number;
  explanation: string | null;
  result?: "balanced" | "shortage" | "overage" | "awaiting_count";
};

type TransactionMovement = {
  id: number;
  cash_transaction_id: number;
  direction: string; // "inflow" | "outflow"
  kind: string; // "payment" | "change" | "expense_payment" | etc.
  amount: string;
  currency: string;
  exchange_rate: string | null;
  converted_amount: string | null;
};

type Transaction = {
  id: number;
  type: string;
  direction: string;
  amount: string;
  currency: string;
  description: string | null;
  reference_type: string | null;
  reference_id: string | null;
  sale_channel: string | null;
  expense_category: string | null;
  payee: string | null;
  attachment_url: string | null;
  is_reversed: boolean;
  reversal_of_id: number | null;
  reversal_reason: string | null;
  entered_by_name: string | null;
  transaction_date: string;
  has_movements: boolean;
  movements: TransactionMovement[];
  // salary approval lifecycle
  approval_status?: string | null;
  approval_decline_reason?: string | null;
  requested_by_me?: boolean;
  // payroll fields
  payroll_employee_name_snapshot: string | null;
  payroll_period: string | null;
  payroll_payment_type: string | null;
  payroll_notes: string | null;
  // bill_payment fields (populated by backend for bill_payment type)
  supplier_name: string | null;
  invoice_number: string | null;
};

type PayableBill = {
  id: number;
  supplier_name: string;
  bill_reference: string;
  due_date: string | null;
  bill_total: number;
  outstanding_balance: number;
  currency: string;
};

type Activity = {
  id: number;
  action: string;
  actor_name: string | null;
  detail: string | null;
  created_at: string;
};

export type CurrencySummary = {
  currency: string;
  opening_cash: number;
  sales_collected: number;
  expenses_paid: number;
  adjustments: number;
  expected_cash: number;
  transfers_in_total?: number;
  transfers_out_total?: number;
};

type Threshold = {
  currency: string;
  receipt_required_above: number;
  variance_approval_above: number;
};

export type SessionDetailResponse = {
  session: Session;
  currencies: string[];
  /** exchange_rates: foreign-currency code → units of that currency per 1 document-currency unit */
  exchange_rates?: Record<string, number>;
  currency_summary: CurrencySummary[];
  thresholds: Threshold[];
  open_conflict: { id: number; session_number: string } | null;
  /** Count of salary expenses awaiting Business Development approval. */
  pending_salary_approvals?: number;
  /** Display names of the members who can approve pending salary expenses. */
  salary_approver_names?: string[];
  transactions: Transaction[];
  /** Pagination metadata for the transactions array. */
  tx_total: number;
  tx_all_total: number;
  tx_page: number;
  tx_pages: number;
  /** Full activity log (kept for backward-compat). */
  activity: Activity[];
  /** Session-lifecycle events only (no per-transaction noise). */
  session_activity: Activity[];
  /** Per-transaction audit events keyed by transaction id (string). */
  transaction_events: Record<string, Activity[]>;
  /** Active outgoing transfers from this session's drawer. */
  active_transfers?: Array<{
    id: number;
    transfer_number: string;
    status: string;
    currency: string;
    amount: string;
    destination_location_name: string | null;
    destination_drawer_name: string | null;
  }>;
};

// ── Pending cash transfer type ─────────────────────────────────────────────

export type PendingTransfer = {
  id: number;
  transfer_number: string;
  status: "IN_TRANSIT" | "DISPUTED";
  currency_code: string;
  sent_amount: string;
  source_drawer_name: string | null;
  source_location_name: string | null;
  destination_drawer_name: string | null;
  destination_location_name: string | null;
  /** The session this transfer should be received into */
  destination_session_id: number | null;
  handed_over_at: string | null;
  handed_over_by_name: string | null;
  intended_receiver_name: string | null;
  external_carrier_name: string | null;
  note: string | null;
  dispute_reason: string | null;
};

// ── Multi-currency movement types ──────────────────────────────────────────

export type MovementRow = {
  id: string;
  amount: string;
  currency: string;
  rateOverride: string;
};

function newRow(currency: string): MovementRow {
  return {
    id: Math.random().toString(36).slice(2, 10),
    amount: "",
    currency,
    rateOverride: "",
  };
}

/** Shared row component: amount input + currency select + optional rate label + remove button */
export function CurrencyMovementRow({
  row,
  currencies,
  documentCurrency,
  sessionRates,
  onChange,
  onRemove,
  testIdPrefix,
}: {
  row: MovementRow;
  currencies: string[];
  documentCurrency: string;
  sessionRates: Record<string, number>;
  onChange: (updated: MovementRow) => void;
  onRemove: () => void;
  testIdPrefix?: string;
}) {
  const isForeign = row.currency !== documentCurrency;
  const defaultRate = isForeign ? (sessionRates[row.currency] ?? 0) : 0;
  const displayRate = row.rateOverride ? parseFloat(row.rateOverride) : defaultRate;

  return (
    <div className="space-y-1">
      <div className="flex items-center gap-2">
        <Input
          type="number"
          min="0"
          step="0.01"
          placeholder="0.00"
          value={row.amount}
          onChange={(e) => onChange({ ...row, amount: e.target.value })}
          className="min-w-0 flex-1"
          data-testid={testIdPrefix ? `${testIdPrefix}-amount` : undefined}
        />
        <Select
          value={row.currency}
          onValueChange={(v) => onChange({ ...row, currency: v, rateOverride: "" })}
        >
          <SelectTrigger className="w-24 shrink-0" data-testid={testIdPrefix ? `${testIdPrefix}-currency` : undefined}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {currencies.map((c) => (
              <SelectItem key={c} value={c}>{c}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-8 w-8 shrink-0 p-0 text-muted-foreground hover:text-foreground"
          onClick={onRemove}
          data-testid={testIdPrefix ? `${testIdPrefix}-remove` : undefined}
        >
          <X className="h-3.5 w-3.5" />
        </Button>
      </div>
      {isForeign && (
        <div className="flex items-center gap-2 ps-0">
          <span className="flex-1 text-xs text-muted-foreground">
            {displayRate > 0
              ? `Rate: 1 ${documentCurrency} = ${displayRate.toLocaleString()} ${row.currency}`
              : `Rate: 1 ${documentCurrency} = ? ${row.currency}`}
          </span>
          <Input
            type="number"
            min="0"
            step="any"
            placeholder="Override rate"
            value={row.rateOverride}
            onChange={(e) => onChange({ ...row, rateOverride: e.target.value })}
            className="h-7 w-32 text-xs"
          />
        </div>
      )}
    </div>
  );
}

/** Compute live settlement status given doc amount, payment rows, change rows, and a rates map. */
export function useCashSettlementCalc({
  docAmount,
  docCurrency,
  payments,
  change,
  rates,
  mode = "sale",
}: {
  docAmount: string;
  docCurrency: string;
  payments: MovementRow[];
  change: MovementRow[];
  rates: Record<string, number>;
  /** "sale" (default): payments +, change −. "expense": payments −, change +. */
  mode?: "sale" | "expense";
}) {
  return useMemo(() => {
    const SCALE = 100;
    const TOLERANCE_CENTS = 1; // within 1 cent = balanced

    const docCents = Math.round(parseFloat(docAmount || "0") * SCALE);
    if (isNaN(docCents) || docCents <= 0) {
      return { status: "balanced" as const, difference: 0, drawerImpact: new Map<string, number>(), paidDocTotal: 0, changeDocTotal: 0 };
    }

    function toDocCents(row: MovementRow): number {
      const rawAmt = parseFloat(row.amount || "0");
      if (isNaN(rawAmt) || rawAmt <= 0) return 0;
      const amtCents = Math.round(rawAmt * SCALE);
      if (row.currency === docCurrency) return amtCents;
      const rate = row.rateOverride ? parseFloat(row.rateOverride) : (rates[row.currency] ?? 0);
      if (!rate) return 0;
      return Math.round(amtCents / rate);
    }

    const drawerImpact = new Map<string, number>();

    function addImpact(currency: string, rawAmt: number, sign: 1 | -1) {
      if (isNaN(rawAmt) || rawAmt <= 0) return;
      drawerImpact.set(currency, (drawerImpact.get(currency) ?? 0) + sign * rawAmt);
    }

    // For a sale: payments flow into drawer (+), change flows out (−).
    // For an expense: payments leave the drawer (−), change returns to drawer (+).
    const paymentSign: 1 | -1 = mode === "expense" ? -1 : 1;
    const changeSign: 1 | -1 = mode === "expense" ? 1 : -1;

    let paymentDocCents = 0;
    for (const row of payments) {
      paymentDocCents += toDocCents(row);
      addImpact(row.currency, parseFloat(row.amount || "0"), paymentSign);
    }

    let changeDocCents = 0;
    for (const row of change) {
      changeDocCents += toDocCents(row);
      addImpact(row.currency, parseFloat(row.amount || "0"), changeSign);
    }

    const netCents = paymentDocCents - changeDocCents;
    const diffCents = netCents - docCents;

    const status: "balanced" | "underpaid" | "overpaid" =
      Math.abs(diffCents) <= TOLERANCE_CENTS
        ? "balanced"
        : diffCents < 0
          ? "underpaid"
          : "overpaid";

    return { status, difference: diffCents / SCALE, drawerImpact, paidDocTotal: paymentDocCents / SCALE, changeDocTotal: changeDocCents / SCALE };
  }, [docAmount, docCurrency, payments, change, rates]);
}

const STATUS_LABELS: Record<string, string> = {
  open: "Open",
  pending_review: "Pending Review",
  approved: "Approved",
  flagged: "Flagged",
};

function statusVariant(status: string): "default" | "secondary" | "destructive" | "outline" {
  if (status === "open") return "default";
  if (status === "approved") return "secondary";
  if (status === "flagged") return "destructive";
  return "outline";
}


export default function CashSessionDetail() {
  const params = useParams();
  const id = params.id;
  const [, navigate] = useLocation();
  const { t, i18n } = useTranslation();
  const { toast } = useToast();
  const qc = useQueryClient();
  const { isOwner, allowedPages } = useWorkspaceRole();
  const can = (perm: string) => isOwner || (allowedPages?.includes(perm) ?? false);
  const canCloseCashSession = canManageCashSessionLifecycle(
    isOwner,
    allowedPages,
    "close",
  );

  const [entryTab, setEntryTab] = useState<"sale" | "expense">("sale");
  const [reasonDialog, setReasonDialog] = useState<null | "flag" | "reopen">(null);
  const [reason, setReason] = useState("");
  const [adjOpen, setAdjOpen] = useState(false);
  const [adj, setAdj] = useState({ amount: "", direction: "in", description: "", currency: "" });
  const [reverseTx, setReverseTx] = useState<Transaction | null>(null);
  const [reverseReason, setReverseReason] = useState("");
  const [confirmTransfer, setConfirmTransfer] = useState<PendingTransfer | null>(null);
  const [disputeTransfer, setDisputeTransfer] = useState<PendingTransfer | null>(null);
  const [transferOpen, setTransferOpen] = useState(false);
  const [viewTransferId, setViewTransferId] = useState<number | null>(null);
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [typeFilter, setTypeFilter] = useState("all");
  const [currencyFilter, setCurrencyFilter] = useState("all");
  const [txPage, setTxPage] = useState(1);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [expandedTxIds, setExpandedTxIds] = useState<Set<number>>(new Set());
  const [expandedHistoryIds, setExpandedHistoryIds] = useState<Set<number>>(new Set());
  const [previewAttachmentUrl, setPreviewAttachmentUrl] = useState<string | null>(null);
  const [quickEntrySheetOpen, setQuickEntrySheetOpen] = useState(false);
  const searchTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const txCardRef = useRef<HTMLDivElement>(null);

  function handleSearchChange(val: string) {
    setSearch(val);
    clearTimeout(searchTimerRef.current);
    searchTimerRef.current = setTimeout(() => {
      setDebouncedSearch(val.trim());
      setTxPage(1);
    }, 300);
  }

  function handleTypeFilterChange(val: string) {
    setTypeFilter(val);
    setTxPage(1);
  }

  function handleCurrencyFilterChange(val: string) {
    setCurrencyFilter(val);
    setTxPage(1);
  }

  function toggleExpand(txId: number) {
    const el = txCardRef.current;
    const scrollTop = el?.scrollTop ?? 0;
    setExpandedTxIds((prev) => {
      const next = new Set(prev);
      if (next.has(txId)) next.delete(txId);
      else next.add(txId);
      return next;
    });
    requestAnimationFrame(() => { if (el) el.scrollTop = scrollTop; });
  }

  function toggleHistoryExpand(logId: number) {
    setExpandedHistoryIds((prev) => {
      const next = new Set(prev);
      if (next.has(logId)) next.delete(logId);
      else next.add(logId);
      return next;
    });
  }

  const { data, isLoading } = useQuery<SessionDetailResponse>({
    queryKey: ["cash-session", id, { page: txPage, type: typeFilter, currency: currencyFilter, q: debouncedSearch }],
    queryFn: () => {
      const params = new URLSearchParams();
      params.set("tx_page", String(txPage));
      params.set("tx_page_size", "50");
      if (typeFilter !== "all") params.set("tx_type", typeFilter);
      if (currencyFilter !== "all") params.set("tx_currency", currencyFilter);
      if (debouncedSearch) params.set("tx_q", debouncedSearch);
      return apiFetch(`/api/cash-sessions/${id}?${params.toString()}`);
    },
    enabled: !!id,
  });

  const { data: pendingTransfersData } = useQuery<{ transfers: PendingTransfer[] }>({
    queryKey: ["cash-session-pending-transfers", id],
    queryFn: () => apiFetch(`/api/cash-sessions/${id}/pending-transfers`),
    enabled: !!id,
    retry: 2,
    refetchInterval: 30_000,
  });
  const pendingTransfers = pendingTransfersData?.transfers ?? [];

  const session = data?.session;
  const currencies = data?.currencies ?? [];
  const summary = data?.currency_summary ?? [];
  const thresholds = data?.thresholds ?? [];
  const transactions = useMemo(() => data?.transactions ?? [], [data?.transactions]);
  const sessionActivity = data?.session_activity ?? [];
  const transactionEvents = data?.transaction_events ?? {};
  const txTotal = data?.tx_total ?? 0;
  const txAllTotal = data?.tx_all_total ?? 0;
  const txPageCount = data?.tx_pages ?? 1;
  const hasActiveFilters = typeFilter !== "all" || currencyFilter !== "all" || debouncedSearch !== "";

  function invalidate() {
    qc.invalidateQueries({ queryKey: ["cash-session", id] });
    qc.invalidateQueries({ queryKey: ["cash-sessions"] });
    qc.invalidateQueries({ queryKey: ["cash-session-pending-transfers", id] });
    qc.invalidateQueries({ queryKey: ["cash-transfers"] });
  }

  const action = useMutation({
    mutationFn: ({ path, body }: { path: string; body?: Record<string, unknown> }) =>
      apiFetch(`/api/cash-sessions/${id}/${path}`, { method: "POST", body: body ? JSON.stringify(body) : undefined }),
    onSuccess: () => {
      toast({ title: t("common.done", "Done") });
      setReasonDialog(null);
      setReason("");
      invalidate();
    },
    onError: (err: Error) => toast({ title: err.message || "Action failed", variant: "destructive" }),
  });

  const adjMutation = useMutation({
    mutationFn: () =>
      apiFetch(`/api/cash-sessions/${id}/adjustment`, {
        method: "POST",
        body: JSON.stringify({
          amount: Number(adj.amount),
          direction: adj.direction,
          description: adj.description.trim(),
        }),
      }),
    onSuccess: () => {
      toast({ title: t("cashSessions.adjustments") });
      setAdjOpen(false);
      setAdj({ amount: "", direction: "in", description: "", currency: "" });
      invalidate();
    },
    onError: (err: Error) => toast({ title: err.message, variant: "destructive" }),
  });

  const cancelApprovalMutation = useMutation({
    mutationFn: (txId: number) =>
      apiFetch(`/api/cash-approvals/${txId}/cancel`, { method: "POST" }),
    onSuccess: () => {
      toast({ title: t("cashSessions.approvalRequestCancelled", "Approval request cancelled") });
      invalidate();
    },
    onError: (err: Error) => toast({ title: err.message, variant: "destructive" }),
  });

  const reverseMutation = useMutation({
    mutationFn: () =>
      apiFetch(`/api/cash-sessions/${id}/transactions/${reverseTx?.id}/reverse`, {
        method: "POST",
        body: JSON.stringify({ reason: reverseReason.trim() }),
      }),
    onSuccess: () => {
      toast({ title: t("cashSessions.transactionReversed") });
      setReverseTx(null);
      setReverseReason("");
      invalidate();
    },
    onError: (err: Error) => toast({ title: err.message, variant: "destructive" }),
  });

  function copyRef() {
    if (!session) return;
    navigator.clipboard.writeText(session.session_number).then(() =>
      toast({ title: t("cashSessions.refCopied") }),
    );
  }

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-20 text-muted-foreground">
        <Loader2 className="h-6 w-6 animate-spin" />
      </div>
    );
  }
  if (!session) {
    return <div className="p-6 text-sm text-muted-foreground">Session not found.</div>;
  }

  const isOpen = session.status === "open";

  async function downloadReconciliationReport() {
    try {
      const token = await getClerkToken();
      const resp = await fetch(`/api/cash-sessions/${id}/reconciliation/report`, {
        headers: token ? { Authorization: `Bearer ${token}` } : undefined,
      });
      if (!resp.ok) {
        const body = (await resp.json().catch(() => null)) as { error?: string } | null;
        throw new Error(body?.error ?? `HTTP ${resp.status}`);
      }
      const blob = await resp.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `reconciliation-${session?.session_number ?? id}.txt`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      toast({ title: (err as Error).message, variant: "destructive" });
    }
  }

  const activeTransfers = data?.active_transfers ?? [];
  const canEnter = isOpen && can("cash_transactions.create");
  const canAdjust = isOpen && can("cash_sessions.adjust");
  const canTransfer = isOpen && can("cash_sessions.transfer") && currencies.length > 0;
  const lastSessionActivity = sessionActivity.length > 0 ? sessionActivity[sessionActivity.length - 1] : null;
  const locale = i18n.language?.startsWith("ar") ? "ar" : undefined;

  return (
    <div className="space-y-4 p-4 md:p-6">
      <Button variant="ghost" size="sm" onClick={() => navigate("/cash-sessions")} className="gap-1.5 -ms-2">
        <ArrowLeft className="h-4 w-4 rtl:rotate-180" /> {t("cashSessions.backToSessions")}
      </Button>

      {/* Header */}
      <div className="flex flex-wrap items-start justify-between gap-3" data-testid="session-header">
        <div className="space-y-1.5">
          <h1 className="flex flex-wrap items-center gap-2 text-2xl font-bold" data-testid="text-session-title">
            {t("cashSessions.cashSessionTitle", { drawer: session.drawer_name ?? session.session_number })}
            <Badge variant={statusVariant(session.status)}>
              {STATUS_LABELS[session.status] ?? session.status}
            </Badge>
            {!isOpen && (
              <span className="inline-flex items-center gap-1 text-sm font-normal text-muted-foreground">
                <Lock className="h-3.5 w-3.5" /> {t("cashSessions.readOnly", "Read-only")}
              </span>
            )}
            {session.flag_reason && !isOpen && (
              <Badge variant="destructive" className="text-xs font-normal">
                <Flag className="me-1 h-3 w-3" /> {t("cashSessions.flaggedForReview", "Flagged for review")}
              </Badge>
            )}
          </h1>
          <p className="text-sm text-muted-foreground">
            {session.location_name ?? ""}
            {session.location_name ? " — " : ""}
            {t("cashSessions.openedAtBy", {
              date: new Date(session.opened_at).toLocaleString(locale, { year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }),
              name: session.opened_by_name ?? "—",
            })}
          </p>
          {/* Lifecycle strip — shown only for non-open sessions */}
          {!isOpen && (
            <div className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
              <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-emerald-500" />
              <span>
                {t("cashSessions.lifecycle.opened", "Opened")}
                {session.opened_by_name ? ` · ${session.opened_by_name}` : ""}
                {" · "}
                {new Date(session.opened_at).toLocaleString(locale, { year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}
              </span>
              {session.closed_at && (
                <>
                  <ChevronRight className="h-3.5 w-3.5 shrink-0" />
                  <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-emerald-500" />
                  <span>
                    {t("cashSessions.lifecycle.closed", "Closed")}
                    {session.closed_by_name ? ` · ${session.closed_by_name}` : ""}
                    {" · "}
                    {new Date(session.closed_at).toLocaleString(locale, { year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}
                  </span>
                  {session.status === "approved" && session.approved_at ? (
                    <>
                      <ChevronRight className="h-3.5 w-3.5 shrink-0" />
                      <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-emerald-500" />
                      <span>
                        {t("cashSessions.lifecycle.approved", "Approved")}
                        {session.approved_by_name ? ` · ${session.approved_by_name}` : ""}
                        {" · "}
                        {new Date(session.approved_at).toLocaleString(locale, { year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}
                      </span>
                    </>
                  ) : (session.status === "pending_review" || session.status === "flagged") ? (
                    <>
                      <ChevronRight className="h-3.5 w-3.5 shrink-0" />
                      <Clock className="h-3.5 w-3.5 shrink-0 text-amber-500" />
                      <span className="text-amber-700">
                        {t("cashSessions.lifecycle.awaitingApproval", "Awaiting approval")}
                      </span>
                    </>
                  ) : null}
                </>
              )}
            </div>
          )}
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={copyRef}
              className="inline-flex items-center gap-1.5 rounded-md border px-2 py-1 font-mono text-xs text-muted-foreground hover:bg-muted"
              title={t("cashSessions.copyRef")}
              data-testid="button-copy-ref"
            >
              {session.session_number}
              <Copy className="h-3 w-3" />
            </button>
            {currencies.map((c) => (
              <span
                key={c}
                className="rounded-md px-2 py-1 text-xs font-semibold"
                style={{ backgroundColor: TEAL_PALE, color: TEAL_DARK }}
              >
                {c}
              </span>
            ))}
          </div>
        </div>

        {/* Action row */}
        <div className="flex flex-wrap gap-2">
          {(canAdjust || canTransfer) && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button size="sm" variant="outline" className="gap-1.5" data-testid="button-cash-actions">
                  Cash actions <ChevronDown className="h-3.5 w-3.5" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start">
                {canAdjust && (
                  <DropdownMenuItem onClick={() => setAdjOpen(true)} className="gap-2" data-testid="menu-item-adjust-cash">
                    <SlidersHorizontal className="h-4 w-4" /> {t("cashSessions.adjustCash")}
                  </DropdownMenuItem>
                )}
                {canTransfer && (
                  <DropdownMenuItem onClick={() => setTransferOpen(true)} className="gap-2" data-testid="menu-item-transfer-cash">
                    <ArrowLeftRight className="h-4 w-4" /> Transfer cash
                  </DropdownMenuItem>
                )}
              </DropdownMenuContent>
            </DropdownMenu>
          )}
          {isOpen && canCloseCashSession && (
            <Button size="sm" variant="outline" onClick={() => navigate(`/cash-sessions/${id}/close`)} className="gap-1.5 border-2" style={{ borderColor: TEAL_DARK, color: TEAL_DARK }} data-testid="button-reconcile-close">
              <Lock className="h-3.5 w-3.5" /> {t("cashSessions.reconcileClose")}
            </Button>
          )}
          {!isOpen && session.closing_counts && session.closing_counts.length > 0 && (
            <Button size="sm" onClick={downloadReconciliationReport} className="gap-1.5" data-testid="button-download-report">
              <Download className="h-3.5 w-3.5" /> {t("cashSessions.reconcile.downloadReport")}
            </Button>
          )}
          {(session.status === "pending_review" || session.status === "flagged") && can("cash_sessions.approve") && (
            <Button size="sm" variant="outline" onClick={() => action.mutate({ path: "approve" })} disabled={action.isPending} className="gap-1.5">
              <CheckCircle2 className="h-3.5 w-3.5" /> Approve
            </Button>
          )}
          {!isOpen && (can("cash_sessions.flag") || can("cash_sessions.reopen")) && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button size="sm" variant="outline" className="gap-1.5" aria-label="More actions">
                  <MoreHorizontal className="h-4 w-4" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                {can("cash_sessions.flag") && (
                  <DropdownMenuItem onClick={() => { setReason(""); setReasonDialog("flag"); }} className="gap-2">
                    <Flag className="h-4 w-4" /> Flag
                  </DropdownMenuItem>
                )}
                {can("cash_sessions.reopen") && (
                  <DropdownMenuItem onClick={() => { setReason(""); setReasonDialog("reopen"); }} className="gap-2">
                    <RotateCcw className="h-4 w-4" /> Reopen
                  </DropdownMenuItem>
                )}
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        </div>
      </div>

      {(data?.pending_salary_approvals ?? 0) > 0 && session.status === "open" && (
        <div className="flex flex-wrap items-center gap-2 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-800" data-testid="banner-pending-salary-approvals">
          <AlertTriangle className="h-4 w-4 shrink-0" />
          <span>
            {(data?.salary_approver_names?.length ?? 0) > 0
              ? t(
                  "cashSessions.pendingSalaryApprovalsBannerNamed",
                  "{{count}} salary expense(s) pending approval from {{names}} — the session cannot be closed until they are resolved.",
                  {
                    count: data?.pending_salary_approvals ?? 0,
                    names: (data?.salary_approver_names ?? []).join(", "),
                  },
                )
              : t(
                  "cashSessions.pendingSalaryApprovalsBanner",
                  "{{count}} salary expense(s) awaiting Business Development approval — the session cannot be closed until they are resolved.",
                  { count: data?.pending_salary_approvals ?? 0 },
                )}
          </span>
          <Link href="/cash-approvals" className="font-medium underline">
            {t("cashSessions.viewApprovals", "View approvals")}
          </Link>
        </div>
      )}

      {data?.open_conflict && session.status === "open" && (
        <div className="flex items-center gap-2 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-800">
          <AlertTriangle className="h-4 w-4 shrink-0" />
          {t("cashSessions.openConflictWarning", { ref: data.open_conflict.session_number })}
        </div>
      )}

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[1fr_320px]">
        {/* Left column */}
        <div className="min-w-0 space-y-4">
          {/* Summary card — open: Live Cash Summary, closed: Reconciliation Summary */}
          {isOpen ? (
            <Card>
              <CardHeader className="flex-row items-center justify-between space-y-0 pb-3">
                <CardTitle className="text-base">{t("cashSessions.liveCashSummary")}</CardTitle>
                <span className="flex items-center gap-1 text-xs text-muted-foreground">
                  <span className="inline-block h-1.5 w-1.5 rounded-full bg-emerald-500" />
                  {t("cashSessions.updatedJustNow")}
                </span>
              </CardHeader>
              <CardContent>
                <div className="overflow-x-auto">
                  <table className="w-full text-sm" data-testid="table-cash-summary">
                    <thead>
                      <tr className="border-b text-start text-xs uppercase text-muted-foreground">
                        <th className="py-2 pe-4 text-start">{t("cashSessions.currency")}</th>
                        <th className="py-2 pe-4 text-end">{t("cashSessions.openingCash")}</th>
                        <th className="py-2 pe-4 text-end">{t("cashSessions.salesCollected")}</th>
                        <th className="py-2 pe-4 text-end">{t("cashSessions.expensesPaid")}</th>
                        <th className="py-2 pe-4 text-end">Net Transfers</th>
                        <th className="py-2 pe-4 text-end">{t("cashSessions.adjustments")}</th>
                        <th className="py-2 text-end">{t("cashSessions.expectedCash")}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {summary.map((row) => {
                        const netTransfers =
                          (row.transfers_in_total ?? 0) - (row.transfers_out_total ?? 0);
                        return (
                        <tr key={row.currency} className="border-b last:border-0">
                          <td className="py-3 pe-4">
                            <span className="rounded px-2 py-0.5 text-xs font-semibold text-white" style={{ backgroundColor: TEAL_DARK }}>
                              {row.currency}
                            </span>
                          </td>
                          <td className="py-3 pe-4 text-end tabular-nums">{formatCashMoney(row.opening_cash, row.currency)}</td>
                          <td className={`py-3 pe-4 text-end tabular-nums ${row.sales_collected !== 0 ? "text-emerald-600" : ""}`}>
                            {row.sales_collected !== 0 ? <>+{formatCashMoney(row.sales_collected, row.currency)}</> : DASH}
                          </td>
                          <td className={`py-3 pe-4 text-end tabular-nums ${row.expenses_paid !== 0 ? "text-red-600" : ""}`}>
                            {row.expenses_paid !== 0 ? <>−{formatCashMoney(row.expenses_paid, row.currency)}</> : DASH}
                          </td>
                          <td className="py-3 pe-4 text-end tabular-nums" style={netTransfers !== 0 ? { color: "#0e7490" } : undefined}>
                            {netTransfers !== 0
                              ? <>
                                  {netTransfers < 0 ? "−" : ""}{formatCashMoney(Math.abs(netTransfers), row.currency)}
                                </>
                              : DASH}
                          </td>
                          <td className="py-3 pe-4 text-end tabular-nums">{row.adjustments !== 0 ? formatCashMoney(row.adjustments, row.currency) : DASH}</td>
                          <td className="py-3 text-end">
                            <span className="rounded-md px-2 py-1 font-semibold tabular-nums" style={{ backgroundColor: TEAL_PALE, color: TEAL_DARK }}>
                              {formatCashMoney(row.expected_cash, row.currency)}
                            </span>
                          </td>
                        </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </CardContent>
            </Card>
          ) : (
            <Card>
              <CardHeader className="space-y-0 pb-3">
                <CardTitle className="text-base">{t("cashSessions.reconciliationSummary", "Reconciliation Summary")}</CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                {/* Reconciliation table */}
                <div className="overflow-x-auto">
                  <table className="w-full text-sm" data-testid="table-reconciliation-summary">
                    <thead>
                      <tr className="border-b text-xs uppercase text-muted-foreground">
                        <th className="py-2 pe-4 text-start">{t("cashSessions.currency")}</th>
                        <th className="py-2 pe-4 text-end">{t("cashSessions.expected", "Expected")}</th>
                        <th className="py-2 pe-4 text-end">{t("cashSessions.counted", "Counted")}</th>
                        <th className="py-2 pe-4 text-end">{t("cashSessions.difference", "Difference")}</th>
                        <th className="py-2 text-end">{t("cashSessions.result", "Result")}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {summary.map((row) => {
                        const count = session.closing_counts?.find((c) => c.currency === row.currency) ?? null;
                        const result = count?.result ?? (count ? (count.actual === null ? "awaiting_count" : count.variance === 0 ? "balanced" : count.variance < 0 ? "shortage" : "overage") : null);
                        const hasCount = count !== null && count.actual !== null;
                        return (
                          <tr key={row.currency} className="border-b last:border-0">
                            <td className="py-3 pe-4">
                              <span className="rounded px-2 py-0.5 text-xs font-semibold text-white" style={{ backgroundColor: TEAL_DARK }}>
                                {row.currency}
                              </span>
                            </td>
                            <td className="py-3 pe-4 text-end tabular-nums">
                              <span className="rounded-md px-2 py-0.5 font-semibold tabular-nums" style={{ backgroundColor: TEAL_PALE, color: TEAL_DARK }}>
                                {formatCashMoney(count?.expected ?? row.expected_cash, row.currency)}
                              </span>
                            </td>
                            <td className="py-3 pe-4 text-end tabular-nums">
                              {hasCount ? formatCashMoney(count!.actual, row.currency) : <span className="text-muted-foreground">{DASH}</span>}
                            </td>
                            <td className="py-3 pe-4 text-end tabular-nums">
                              {hasCount ? (
                                <span className={count!.variance === 0 ? "text-emerald-600" : count!.variance < 0 ? "text-amber-700 font-semibold" : "text-amber-600 font-semibold"}>
                                  {formatCashMoney(count!.variance, row.currency, { signed: true })}
                                </span>
                              ) : (
                                <span className="text-muted-foreground">{DASH}</span>
                              )}
                            </td>
                            <td className="py-3 text-end">
                              {result === "balanced" && (
                                <span className="inline-flex items-center gap-1 rounded-full bg-emerald-50 px-2 py-0.5 text-xs font-semibold text-emerald-700">
                                  <CheckCircle2 className="h-3 w-3" /> {t("cashSessions.close.balanced", "Balanced")}
                                </span>
                              )}
                              {result === "shortage" && (
                                <span className="inline-flex items-center gap-1 rounded-full bg-amber-50 px-2 py-0.5 text-xs font-semibold text-amber-700">
                                  <AlertTriangle className="h-3 w-3" /> {t("cashSessions.close.shortage", "Shortage")}
                                </span>
                              )}
                              {result === "overage" && (
                                <span className="inline-flex items-center gap-1 rounded-full bg-amber-50 px-2 py-0.5 text-xs font-semibold text-amber-600">
                                  <Info className="h-3 w-3" /> {t("cashSessions.close.overage", "Overage")}
                                </span>
                              )}
                              {(result === "awaiting_count" || result === null) && (
                                <span className="text-xs text-muted-foreground">{t("cashSessions.close.awaitingCount", "Awaiting count")}</span>
                              )}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>

                {/* View cash calculation disclosure */}
                <Collapsible>
                  <CollapsibleTrigger className="flex w-full items-center justify-between gap-2 rounded-md px-1 py-1.5 text-sm text-muted-foreground hover:text-foreground">
                    <span className="font-medium">{t("cashSessions.viewCashCalculation", "View cash calculation")}</span>
                    <ChevronDown className="h-4 w-4 transition-transform [[data-state=open]_&]:rotate-180" />
                  </CollapsibleTrigger>
                  <CollapsibleContent className="mt-2">
                    <div className="space-y-3 rounded-md border bg-muted/30 p-3">
                      {summary.map((row) => (
                        <div key={row.currency} className="space-y-1.5">
                          <div className="flex items-center gap-1.5 text-xs font-semibold uppercase text-muted-foreground">
                            <span className="rounded px-1.5 py-0.5 text-white" style={{ backgroundColor: TEAL_DARK }}>{row.currency}</span>
                          </div>
                          <div className="space-y-1 text-sm">
                            <div className="flex items-center justify-between gap-4">
                              <span className="text-muted-foreground">{t("cashSessions.openingCash")}</span>
                              <span className="tabular-nums">{formatCashMoney(row.opening_cash, row.currency)}</span>
                            </div>
                            <div className="flex items-center justify-between gap-4">
                              <span className="text-muted-foreground">+ {t("cashSessions.salesCollected")}</span>
                              <span className={`tabular-nums ${row.sales_collected !== 0 ? "text-emerald-600" : "text-muted-foreground"}`}>
                                {row.sales_collected !== 0 ? formatCashMoney(row.sales_collected, row.currency) : DASH}
                              </span>
                            </div>
                            <div className="flex items-center justify-between gap-4">
                              <span className="text-muted-foreground">− {t("cashSessions.expensesPaid")}</span>
                              <span className={`tabular-nums ${row.expenses_paid !== 0 ? "text-red-600" : "text-muted-foreground"}`}>
                                {row.expenses_paid !== 0 ? formatCashMoney(row.expenses_paid, row.currency) : DASH}
                              </span>
                            </div>
                            <div className="flex items-center justify-between gap-4">
                              <span className="text-muted-foreground">± {t("cashSessions.adjustments")}</span>
                              <span className="tabular-nums text-muted-foreground">
                                {row.adjustments !== 0 ? formatCashMoney(row.adjustments, row.currency) : DASH}
                              </span>
                            </div>
                            <div className="flex items-center justify-between gap-4 border-t pt-1">
                              <span className="font-semibold">= {t("cashSessions.expectedCash")}</span>
                              <span className="font-semibold tabular-nums" style={{ color: TEAL_DARK }}>
                                {formatCashMoney(row.expected_cash, row.currency)}
                              </span>
                            </div>
                          </div>
                        </div>
                      ))}
                    </div>
                  </CollapsibleContent>
                </Collapsible>

                {/* Approval footer note */}
                {session.status === "approved" && session.approved_by_name && session.approved_at && (
                  <p className="border-t pt-3 text-xs text-muted-foreground">
                    {t("cashSessions.approvedByOn", {
                      name: session.approved_by_name,
                      date: new Date(session.approved_at).toLocaleDateString(locale, { year: "numeric", month: "short", day: "numeric" }),
                    })}
                  </p>
                )}
              </CardContent>
            </Card>
          )}

          {/* Incoming cash transfer cards */}
          {pendingTransfers.map((transfer) => (
            <IncomingTransferCard
              key={transfer.id}
              transfer={transfer}
              sessionId={Number(id)}
              currentExpectedCash={summary.find((s) => s.currency === transfer.currency_code)?.expected_cash ?? null}
              onConfirm={() => setConfirmTransfer(transfer)}
              onDispute={() => setDisputeTransfer(transfer)}
            />
          ))}

          {/* Outgoing cash transfer in-progress cards (source session) */}
          {activeTransfers.map((transfer) => (
            <OutgoingTransferCard
              key={transfer.id}
              transfer={transfer}
              onView={() => setViewTransferId(transfer.id)}
            />
          ))}

          {/* Mobile/tablet Quick Entry — slide-over Sheet below lg breakpoint */}
          {canEnter && (
            <>
              {/* Floating "Add Entry" button — visible only below lg */}
              <div className="fixed bottom-6 end-6 z-30 lg:hidden">
                <Button
                  size="sm"
                  className="gap-1.5 rounded-full px-4 py-3 shadow-lg text-white"
                  style={{ backgroundColor: TEAL_DARK }}
                  onClick={() => setQuickEntrySheetOpen(true)}
                  aria-label={t("cashSessions.openQuickEntry", "Add Entry")}
                  data-testid="button-open-quick-entry-sheet"
                >
                  <Plus className="h-4 w-4" />
                  {t("cashSessions.addEntry", "Add Entry")}
                </Button>
              </div>

              {/* Quick Entry slide-over Sheet */}
              <Sheet open={quickEntrySheetOpen} onOpenChange={setQuickEntrySheetOpen}>
                <SheetContent side="right" className="w-full sm:w-[380px] overflow-y-auto p-0">
                  <SheetHeader className="px-4 pt-4 pb-2">
                    <SheetTitle>{t("cashSessions.quickEntry", "Quick Entry")}</SheetTitle>
                  </SheetHeader>
                  <div className="px-0">
                    <QuickEntryPanel
                      sessionId={id!}
                      currencies={currencies}
                      sessionRates={data?.exchange_rates ?? {}}
                      documentCurrency={session.currency}
                      thresholds={thresholds}
                      tab={entryTab}
                      onTabChange={setEntryTab}
                      onSaved={() => { invalidate(); setQuickEntrySheetOpen(false); }}
                      currencySummary={summary}
                    />
                  </div>
                </SheetContent>
              </Sheet>
            </>
          )}

          {/* Transactions */}
          <Card>
            <CardHeader className="space-y-3 pb-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <CardTitle className="text-base">
                  {txTotal > 0
                    ? t("cashSessions.transactions", { count: txTotal })
                    : t("cashSessions.transactions", { count: txAllTotal })}
                </CardTitle>
                <div className="flex flex-wrap items-center gap-2">
                  <div className="relative">
                    <Search className="absolute start-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
                    <Input
                      value={search}
                      onChange={(e) => handleSearchChange(e.target.value)}
                      placeholder={t("cashSessions.searchTransactions")}
                      className="h-8 w-44 ps-8 text-sm"
                      data-testid="input-search-transactions"
                    />
                  </div>
                  <Select value={typeFilter} onValueChange={handleTypeFilterChange}>
                    <SelectTrigger className="h-8 w-32 text-sm" data-testid="select-type-filter">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="all">{t("cashSessions.allTypes")}</SelectItem>
                      {["sale", "expense", "bill_payment", "bill", "adjustment", "reversal"].map((ty) => (
                        <SelectItem key={ty} value={ty}>{t(`cashSessions.types.${ty}`, ty)}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <Select value={currencyFilter} onValueChange={handleCurrencyFilterChange}>
                    <SelectTrigger className="h-8 w-36 text-sm" data-testid="select-currency-filter">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="all">{t("cashSessions.allCurrencies")}</SelectItem>
                      {currencies.map((c) => (
                        <SelectItem key={c} value={c}>{c}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </div>
              {/* Active filter chips */}
              {hasActiveFilters && (
                <div className="flex flex-wrap items-center gap-1.5">
                  {typeFilter !== "all" && (
                    <span className="inline-flex items-center gap-1 rounded-full border bg-muted px-2 py-0.5 text-xs">
                      {t(`cashSessions.types.${typeFilter}`, typeFilter)}
                      <button type="button" onClick={() => handleTypeFilterChange("all")} className="text-muted-foreground hover:text-foreground"><X className="h-3 w-3" /></button>
                    </span>
                  )}
                  {currencyFilter !== "all" && (
                    <span className="inline-flex items-center gap-1 rounded-full border bg-muted px-2 py-0.5 text-xs">
                      {currencyFilter}
                      <button type="button" onClick={() => handleCurrencyFilterChange("all")} className="text-muted-foreground hover:text-foreground"><X className="h-3 w-3" /></button>
                    </span>
                  )}
                  {debouncedSearch && (
                    <span className="inline-flex items-center gap-1 rounded-full border bg-muted px-2 py-0.5 text-xs">
                      &ldquo;{debouncedSearch}&rdquo;
                      <button type="button" onClick={() => { setSearch(""); setDebouncedSearch(""); setTxPage(1); }} className="text-muted-foreground hover:text-foreground"><X className="h-3 w-3" /></button>
                    </span>
                  )}
                  <button
                    type="button"
                    className="text-xs text-muted-foreground underline hover:text-foreground"
                    onClick={() => { handleTypeFilterChange("all"); handleCurrencyFilterChange("all"); setSearch(""); setDebouncedSearch(""); setTxPage(1); }}
                  >
                    Clear all
                  </button>
                </div>
              )}
            </CardHeader>
            <CardContent ref={txCardRef}>
              {transactions.length === 0 ? (
                <div className="flex flex-col items-center gap-3 py-10 text-center">
                  <div className="flex h-12 w-12 items-center justify-center rounded-full" style={{ backgroundColor: TEAL_PALE }}>
                    <FileText className="h-5 w-5" style={{ color: TEAL_DARK }} />
                  </div>
                  <div>
                    <p className="text-sm font-medium">{t("cashSessions.noTransactionsYet")}</p>
                    <p className="text-xs text-muted-foreground">{t("cashSessions.newEntriesAppear")}</p>
                  </div>
                  {canEnter && transactions.length === 0 && (
                    <div className="flex gap-2">
                      <Button size="sm" style={{ backgroundColor: TEAL_DARK }} className="text-white hover:opacity-90" onClick={() => { setEntryTab("sale"); if (window.matchMedia("(max-width: 1023px)").matches) setQuickEntrySheetOpen(true); }}>
                        {t("cashSessions.recordFirstSale")}
                      </Button>
                      <Button size="sm" variant="outline" style={{ borderColor: TEAL_DARK, color: TEAL_DARK }} onClick={() => { setEntryTab("expense"); if (window.matchMedia("(max-width: 1023px)").matches) setQuickEntrySheetOpen(true); }}>
                        {t("cashSessions.recordFirstExpense")}
                      </Button>
                    </div>
                  )}
                </div>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-sm" data-testid="table-transactions">
                    <thead>
                      <tr className="border-b text-xs uppercase text-muted-foreground">
                        <th className="py-2 pe-4 text-start">{t("cashSessions.time")}</th>
                        <th className="py-2 pe-4 text-start">{t("cashSessions.type")}</th>
                        <th className="py-2 pe-4 text-start">{t("cashSessions.descriptionLabel")}</th>
                        <th className="py-2 pe-4 text-start">{t("cashSessions.reference")}</th>
                        <th className="py-2 pe-4 text-start">{t("cashSessions.enteredBy")}</th>
                        <th className="py-2 text-end">{t("cashSessions.amount")}</th>
                        {canAdjust && <th className="py-2 ps-2" />}
                      </tr>
                    </thead>
                    <tbody>
                      {transactions.map((tx) => {
                        const invoiceHref = imageUrl(tx.attachment_url);
                        const isTransferIn = tx.type === "transfer_in";
                        const isTransferOut = tx.type === "transfer_out";
                        const negative = !isTransferIn && !isTransferOut && tx.direction === "out";
                        const isExpanded = expandedTxIds.has(tx.id);
                        const movements = tx.movements ?? [];
                        const events = transactionEvents[String(tx.id)] ?? [];
                        // Expandable if there are events, movement rows, OR accounting detail (amount > 0)
                        const hasAccountingDetail = Number(tx.amount) > 0;
                        const isExpandable = events.length > 0 || movements.length > 0 || hasAccountingDetail;
                        const physicalCurrencies = movements.length > 0
                          ? [...new Set(movements.map((m) => m.currency))]
                          : [];
                        const isMultiCurrency = physicalCurrencies.length > 1 ||
                          (physicalCurrencies.length === 1 && physicalCurrencies[0] !== tx.currency);
                        const isExpenseTx = tx.type === "expense";
                        // For expense transactions show a signed per-currency drawer summary
                        // ("Drawer: −USD 50.00 · +LBP 720,000") instead of the plain currency list.
                        const drawerMovementSummary = isExpenseTx && movements.length > 0
                          ? (() => {
                              const netMap = new Map<string, number>();
                              for (const m of movements) {
                                const sign = m.direction === "inflow" ? 1 : -1;
                                const amt = parseFloat(m.amount);
                                if (!isNaN(amt) && amt > 0) {
                                  netMap.set(m.currency, (netMap.get(m.currency) ?? 0) + sign * amt);
                                }
                              }
                              return [...netMap.entries()]
                                .filter(([, v]) => v !== 0)
                                .map(([c, v]) => `${v > 0 ? "+" : "−"}${formatCashMoney(Math.abs(v), c)}`)
                                .join(" · ");
                            })()
                          : null;
                        const colSpan = canAdjust ? 7 : 6;
                        return (
                          <React.Fragment key={tx.id}>
                            <tr
                              id={`tx-${tx.id}`}
                              className={`border-b ${isExpandable && isExpanded ? "" : "last:border-0"} ${tx.is_reversed ? "opacity-60" : ""} ${isExpandable ? "cursor-pointer hover:bg-muted/30" : ""}`}
                              onClick={isExpandable ? () => toggleExpand(tx.id) : undefined}
                            >
                              <td className="whitespace-nowrap py-2.5 pe-4 text-xs text-muted-foreground">
                                <div className="flex items-center gap-1">
                                  {isExpandable ? (
                                    <button
                                      type="button"
                                      aria-expanded={isExpanded}
                                      aria-controls={`detail-${tx.id}`}
                                      aria-label={isExpanded ? t("cashSessions.collapseRow", "Collapse details") : t("cashSessions.expandRow", "Expand details")}
                                      data-testid={`button-expand-tx-${tx.id}`}
                                      className="flex items-center gap-1 rounded focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                                      onClick={(e) => { e.stopPropagation(); toggleExpand(tx.id); }}
                                      onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); toggleExpand(tx.id); } }}
                                    >
                                      <ChevronDown className={`h-3 w-3 shrink-0 text-muted-foreground transition-transform ${isExpanded ? "rotate-180" : ""}`} />
                                    </button>
                                  ) : null}
                                  {new Date(tx.transaction_date).toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit" })}
                                </div>
                              </td>
                              <td className="py-2.5 pe-4">
                                <div className="flex flex-wrap items-center gap-1">
                                  {isTransferIn ? (
                                    <span
                                      className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-semibold"
                                      style={{ backgroundColor: "#E0F2FE", color: "#0369A1" }}
                                    >
                                      <ArrowRightLeft className="h-3 w-3" /> Transfer in
                                    </span>
                                  ) : isTransferOut ? (
                                    <span
                                      className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-semibold"
                                      style={{ backgroundColor: "#E0F2FE", color: "#0369A1" }}
                                    >
                                      <ArrowRightLeft className="h-3 w-3" /> Transfer out
                                    </span>
                                  ) : tx.type === "bill_payment" ? (
                                    <span
                                      className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-semibold"
                                      style={{ backgroundColor: "#F3E8FF", color: "#6B21A8" }}
                                    >
                                      <Building2 className="h-3 w-3" />
                                      {t("cashSessions.types.bill_payment", "Bill payment")}
                                    </span>
                                  ) : (
                                    <Badge variant={tx.type === "reversal" ? "outline" : negative ? "secondary" : "default"}>
                                      {t(`cashSessions.types.${tx.type}`, tx.type)}
                                    </Badge>
                                  )}
                                  {tx.sale_channel && (
                                    <span className="text-xs text-muted-foreground">
                                      {t(`cashSessions.channels.${tx.sale_channel}`, tx.sale_channel)}
                                    </span>
                                  )}
                                  {tx.type !== "bill_payment" && tx.expense_category && (
                                    <span className="text-xs text-muted-foreground">
                                      {t(`cashSessions.categories.${tx.expense_category}`, tx.expense_category)}
                                    </span>
                                  )}
                                  {isPayrollCategory(tx.expense_category ?? "") && tx.payroll_employee_name_snapshot && (
                                    <span className="text-xs text-muted-foreground">
                                      {tx.payroll_employee_name_snapshot}
                                      {tx.payroll_period && ` · ${tx.payroll_period.replace(/^(\d{4})-(\d{2})$/, (_, y, m) => new Date(parseInt(y), parseInt(m) - 1).toLocaleString("en-US", { month: "short", year: "numeric" }))}`}
                                    </span>
                                  )}
                                  {tx.is_reversed && (
                                    <Badge variant="destructive" className="text-[10px]">{t("cashSessions.reversed")}</Badge>
                                  )}
                                  {tx.approval_status === "pending" && (
                                    <span
                                      className="inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-semibold"
                                      style={{ backgroundColor: "#FEF3C7", color: "#92400E" }}
                                      data-testid={`badge-pending-approval-${tx.id}`}
                                    >
                                      {(data?.salary_approver_names?.length ?? 0) > 0
                                        ? t("cashSessions.pendingApprovalFrom", "Pending approval from {{names}}", {
                                            names: (data?.salary_approver_names ?? []).join(", "),
                                          })
                                        : t("cashSessions.pendingApproval", "Pending approval")}
                                    </span>
                                  )}
                                  {tx.approval_status === "declined" && (
                                    <Badge variant="outline" className="text-[10px] text-destructive border-destructive/40" data-testid={`badge-declined-${tx.id}`}>
                                      {t("cashSessions.approvalDeclined", "Declined")}
                                      {tx.approval_decline_reason ? ` — ${tx.approval_decline_reason}` : ""}
                                    </Badge>
                                  )}
                                  {tx.approval_status === "cancelled" && (
                                    <Badge variant="outline" className="text-[10px] text-muted-foreground" data-testid={`badge-cancelled-${tx.id}`}>
                                      {t("cashSessions.approvalCancelled", "Cancelled")}
                                    </Badge>
                                  )}
                                  {tx.approval_status === "pending" && tx.requested_by_me && isOpen && (
                                    <Button
                                      size="sm"
                                      variant="ghost"
                                      className="h-5 px-1.5 text-[10px] text-muted-foreground"
                                      data-testid={`button-cancel-approval-${tx.id}`}
                                      disabled={cancelApprovalMutation.isPending}
                                      onClick={(e) => { e.stopPropagation(); cancelApprovalMutation.mutate(tx.id); }}
                                    >
                                      {t("cashSessions.cancelRequest", "Cancel request")}
                                    </Button>
                                  )}
                                </div>
                              </td>
                              <td className="max-w-[220px] py-2.5 pe-4">
                                {tx.type === "bill_payment" ? (
                                  <span className={tx.is_reversed ? "line-through" : ""}>
                                    {tx.supplier_name && (
                                      <span className="font-medium">{tx.supplier_name}</span>
                                    )}
                                    {tx.invoice_number && (
                                      <span className="block font-mono text-xs text-muted-foreground">{tx.invoice_number}</span>
                                    )}
                                    {!tx.supplier_name && !tx.invoice_number && (tx.description ?? "—")}
                                  </span>
                                ) : (
                                  <>
                                    <span className={tx.is_reversed ? "line-through" : ""}>
                                      {isTransferIn
                                        ? tx.description ?? t("cashSessions.types.transfer_in", "Transfer in")
                                        : tx.description ?? "—"}
                                    </span>
                                    {tx.payee && <span className="block text-xs text-muted-foreground">{tx.payee}</span>}
                                    {isTransferIn && tx.reference_id && (
                                      <span className="block font-mono text-xs text-muted-foreground">
                                        {tx.reference_id}
                                      </span>
                                    )}
                                  </>
                                )}
                              </td>
                              <td className="py-2.5 pe-4 text-xs text-muted-foreground">
                                <div className="flex items-center gap-1.5">
                                  {!isTransferIn && <span>{tx.reference_id ?? "—"}</span>}
                                  {events.length > 0 && (
                                    <span className="rounded-full bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
                                      {events.length} {events.length === 1 ? "event" : "events"}
                                    </span>
                                  )}
                                  {invoiceHref && (
                                    <button
                                      type="button"
                                      className="inline-flex align-middle text-primary"
                                      onClick={(e) => { e.stopPropagation(); setPreviewAttachmentUrl(invoiceHref); }}
                                      aria-label={t("cashSessions.viewAttachment", "View attachment")}
                                    >
                                      <Paperclip className="h-3.5 w-3.5" />
                                    </button>
                                  )}
                                </div>
                              </td>
                              <td className="py-2.5 pe-4 text-xs text-muted-foreground">{tx.entered_by_name ?? "—"}</td>
                              <td
                                className={`py-2.5 text-end tabular-nums ${
                                  isTransferIn || isTransferOut
                                    ? ""
                                    : negative
                                      ? "text-red-600"
                                      : "text-emerald-600"
                                }`}
                                style={isTransferIn || isTransferOut ? { color: "#0369A1" } : undefined}
                              >
                                <div className="flex flex-col items-end gap-0.5">
                                  <span>{negative ? "−" : "+"}{formatCashMoney(tx.amount, tx.currency)}</span>
                                  {isExpenseTx && drawerMovementSummary ? (
                                    <span className="text-[10px] font-medium text-muted-foreground">
                                      {t("cashSessions.drawerPrefix", "Drawer:")} {drawerMovementSummary}
                                    </span>
                                  ) : isMultiCurrency ? (
                                    <span className="text-[10px] font-medium text-muted-foreground">
                                      {physicalCurrencies.join(" · ")}
                                    </span>
                                  ) : null}
                                </div>
                              </td>
                              {canAdjust && (
                                <td className="py-2.5 ps-2 text-end" onClick={(e) => e.stopPropagation()}>
                                  {!isTransferIn && !isTransferOut && tx.type !== "reversal" && !tx.is_reversed && (
                                    <Button
                                      variant="ghost"
                                      size="sm"
                                      className="h-7 gap-1 px-2 text-xs"
                                      onClick={() => { setReverseReason(""); setReverseTx(tx); }}
                                      data-testid={`button-reverse-${tx.id}`}
                                    >
                                      <Undo2 className="h-3.5 w-3.5" /> {t("cashSessions.reverse")}
                                    </Button>
                                  )}
                                </td>
                              )}
                            </tr>
                            {isExpandable && isExpanded && (
                              <tr key={`${tx.id}-expanded`} id={`detail-${tx.id}`} className="border-b last:border-0 bg-muted/20">
                                <td colSpan={colSpan} className="px-4 pb-3 pt-1 space-y-2">
                                  {events.length > 0 && (
                                    <div className="rounded-md border bg-background p-3">
                                      <p className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                                        Audit trail
                                      </p>
                                      <ul className="space-y-1.5">
                                        {events.map((ev) => (
                                          <li key={ev.id} className="flex items-start justify-between gap-3 text-xs">
                                            <span className="font-medium capitalize text-foreground">
                                              {ev.action.replace(/_/g, " ")}
                                            </span>
                                            <div className="flex shrink-0 items-center gap-2 text-muted-foreground">
                                              {ev.actor_name && <span>{ev.actor_name}</span>}
                                              <span>{new Date(ev.created_at).toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit" })}</span>
                                            </div>
                                          </li>
                                        ))}
                                      </ul>
                                    </div>
                                  )}
                                  {(movements.length > 0 || hasAccountingDetail) && (
                                    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                                      {/* Left panel: Accounting details */}
                                      <div className="rounded-md border bg-background p-3">
                                        <p className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                                          {isExpenseTx
                                            ? t("cashSessions.expenseValueAccounting", "Expense Value (Accounting)")
                                            : isTransferIn || isTransferOut
                                              ? t("cashSessions.transferDetails", "Transfer Details")
                                              : t("cashSessions.transactionDetails", "Transaction Details")}
                                        </p>
                                        <div className="space-y-1.5 text-xs">
                                          {/* Accounting amount — sign always from tx.direction so transfer_out shows − */}
                                          {(() => {
                                            const acctNeg = tx.direction === "out";
                                            const amtLabel = isExpenseTx
                                              ? t("cashSessions.expenseAmount", "Expense total")
                                              : isTransferOut ? t("cashSessions.amountSent", "Amount sent")
                                              : isTransferIn ? t("cashSessions.amountReceived", "Amount received")
                                              : tx.type === "adjustment" ? t("cashSessions.adjustmentAmount", "Adjustment")
                                              : tx.type === "reversal" ? t("cashSessions.reversalAmount", "Reversed amount")
                                              : t("cashSessions.amount", "Amount");
                                            return (
                                              <div className="flex items-center justify-between gap-2">
                                                <span className="text-muted-foreground">{amtLabel}</span>
                                                <span className={`font-semibold tabular-nums ${acctNeg ? "text-red-600" : "text-emerald-600"}`}>
                                                  {acctNeg ? "−" : "+"}{formatCashMoney(tx.amount, tx.currency)}
                                                </span>
                                              </div>
                                            );
                                          })()}
                                          {tx.expense_category && (
                                            <div className="flex items-center justify-between gap-2">
                                              <span className="text-muted-foreground">{t("cashSessions.expenseCategory", "Category")}</span>
                                              <span className="font-medium capitalize">{t(`cashSessions.categories.${tx.expense_category}`, tx.expense_category)}</span>
                                            </div>
                                          )}
                                          {tx.payee && (
                                            <div className="flex items-center justify-between gap-2">
                                              <span className="text-muted-foreground">{t("cashSessions.payee", "Supplier")}</span>
                                              <span className="font-medium">{tx.payee}</span>
                                            </div>
                                          )}
                                          {tx.sale_channel && (
                                            <div className="flex items-center justify-between gap-2">
                                              <span className="text-muted-foreground">{t("cashSessions.saleChannel", "Channel")}</span>
                                              <span className="font-medium">{t(`cashSessions.channels.${tx.sale_channel}`, tx.sale_channel)}</span>
                                            </div>
                                          )}
                                          {tx.description && (
                                            <div className="flex items-start justify-between gap-2">
                                              <span className="text-muted-foreground shrink-0">{t("cashSessions.descriptionLabel", "Description")}</span>
                                              <span className="font-medium text-right">{tx.description}</span>
                                            </div>
                                          )}
                                          {tx.entered_by_name && (
                                            <div className="flex items-center justify-between gap-2 border-t pt-1.5">
                                              <span className="text-muted-foreground">{t("cashSessions.enteredBy", "Entered by")}</span>
                                              <span className="font-medium">{tx.entered_by_name}</span>
                                            </div>
                                          )}
                                        </div>
                                      </div>
                                      {/* Right panel: Drawer Movements */}
                                      <div className="rounded-md border bg-background p-3">
                                        <p className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                                          {t("cashSessions.drawerMovementsPhysical", "Drawer Movements (Physical Cash)")}
                                        </p>
                                        <div className="space-y-1.5 text-xs">
                                          {movements.length === 0 && hasAccountingDetail ? (() => {
                                            // Fallback: derive single-currency drawer impact from tx fields
                                            const isDebit = tx.direction === "out";
                                            const drawerLabel = isDebit
                                              ? t("cashSessions.cashPaid", "Cash paid")
                                              : t("cashSessions.cashReceived", "Cash received");
                                            return (
                                              <div className="flex items-center justify-between gap-2">
                                                <span className="text-muted-foreground">{drawerLabel}</span>
                                                <span className={`tabular-nums font-medium ${isDebit ? "text-red-600" : "text-emerald-600"}`}>
                                                  {isDebit ? "−" : "+"}{formatCashMoney(tx.amount, tx.currency)}
                                                </span>
                                              </div>
                                            );
                                          })() : (() => {
                                            // Full path: compute from movement rows
                                            const netMap = new Map<string, number>();
                                            for (const m of movements) {
                                              const sign = m.direction === "inflow" ? 1 : -1;
                                              const amt = parseFloat(m.amount);
                                              if (!isNaN(amt)) netMap.set(m.currency, (netMap.get(m.currency) ?? 0) + sign * amt);
                                            }
                                            // Group by kind: primary (non-change) vs secondary (change)
                                            const primaryMovements = movements.filter((m) => m.kind !== "change");
                                            const changeMovements = movements.filter((m) => m.kind === "change");
                                            // Detect cross-rate movements
                                            const foreignMovements = movements.filter((m) => m.exchange_rate != null && m.currency !== tx.currency);
                                            const showRate = foreignMovements.length > 0;
                                            // Kind-aware label for a primary movement
                                            const movLabel = (m: { kind: string; direction: string }) => {
                                              if (m.kind === "expense_payment") {
                                                // Reversals mirror direction: inflow means cash returned to drawer
                                                return m.direction === "inflow"
                                                  ? t("cashSessions.cashReceived", "Cash received")
                                                  : t("cashSessions.cashPaid", "Cash paid");
                                              }
                                              if (m.kind === "payment") {
                                                return isTransferIn ? t("cashSessions.received", "Received")
                                                  : tx.type === "sale" ? t("cashSessions.cashReceived", "Cash received")
                                                  : m.direction === "inflow" ? t("cashSessions.cashIn", "Cash in") : t("cashSessions.cashOut", "Cash out");
                                              }
                                              // Transfers and other kinds: use direction
                                              return m.direction === "inflow" ? t("cashSessions.cashIn", "Cash in") : t("cashSessions.cashOut", "Cash out");
                                            };
                                            const changeLabel = (m: { direction: string }) =>
                                              m.direction === "inflow"
                                                ? t("cashSessions.cashChangeReceived", "Change received")
                                                : t("cashSessions.cashChangeGiven", "Change given");
                                            return (
                                              <>
                                                {primaryMovements.length > 0 && (
                                                  <div className="space-y-1">
                                                    {primaryMovements.map((m) => (
                                                      <div key={m.id} className="flex items-center justify-between gap-2">
                                                        <span className="text-muted-foreground">{movLabel(m)}</span>
                                                        <span className={`tabular-nums font-medium ${m.direction === "outflow" ? "text-red-600" : "text-emerald-600"}`}>
                                                          {m.direction === "outflow" ? "−" : "+"}{formatCashMoney(m.amount, m.currency)}
                                                        </span>
                                                      </div>
                                                    ))}
                                                  </div>
                                                )}
                                                {changeMovements.length > 0 && (
                                                  <div className="space-y-1 mt-1">
                                                    {changeMovements.map((m) => (
                                                      <div key={m.id} className="flex items-center justify-between gap-2">
                                                        <span className="text-muted-foreground">{changeLabel(m)}</span>
                                                        <span className={`tabular-nums font-medium ${m.direction === "outflow" ? "text-red-600" : "text-emerald-600"}`}>
                                                          {m.direction === "outflow" ? "−" : "+"}{formatCashMoney(m.amount, m.currency)}
                                                        </span>
                                                      </div>
                                                    ))}
                                                  </div>
                                                )}
                                                {showRate && (
                                                  <div className="mt-1 pt-1 border-t space-y-0.5">
                                                    {foreignMovements.map((m) => (
                                                      <div key={m.id} className="flex items-center justify-between gap-2">
                                                        <span className="text-muted-foreground">{t("cashSessions.movement.rate", "Exchange rate")}</span>
                                                        <span className="tabular-nums text-muted-foreground">
                                                          {(() => {
                                                             const r = Number(m.exchange_rate);
                                                             if (!r) return '?';
                                                             if (r < 1) {
                                                               const d1 = 1 / r; const dec1 = d1 >= 1000 ? 0 : d1 >= 10 ? 1 : 4;
                                                               return `1 ${tx.currency} = ${d1.toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: dec1 })} ${m.currency}`;
                                                             } else {
                                                               const dec2 = r >= 1000 ? 0 : r >= 10 ? 1 : 4;
                                                               return `1 ${m.currency} = ${r.toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: dec2 })} ${tx.currency}`;
                                                             }
                                                           })()}
                                                        </span>
                                                      </div>
                                                    ))}
                                                  </div>
                                                )}
                                                <div className="mt-1 pt-1.5 border-t space-y-0.5">
                                                  {[...netMap.entries()].filter(([, v]) => v !== 0).map(([c, v]) => (
                                                    <div key={c} className="flex items-center justify-between gap-2">
                                                      <span className="text-muted-foreground">
                                                        {t("cashSessions.drawerPrefix", "Drawer")} ({c})
                                                      </span>
                                                      <span className={`tabular-nums font-semibold ${v > 0 ? "text-emerald-600" : "text-red-600"}`}>
                                                        {v > 0 ? "+" : "−"}{formatCashMoney(Math.abs(v), c)}
                                                      </span>
                                                    </div>
                                                  ))}
                                                </div>
                                              </>
                                            );
                                          })()}
                                        </div>
                                      </div>
                                    </div>
                                  )}
                                </td>
                              </tr>
                            )}
                          </React.Fragment>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
              {/* Pagination */}
              {txPageCount > 1 && (
                <div className="mt-3 flex items-center justify-between border-t pt-3 text-xs text-muted-foreground">
                  <span>
                    Showing {((txPage - 1) * 50) + 1}–{Math.min(txPage * 50, txTotal)} of {txTotal}
                  </span>
                  <div className="flex items-center gap-1">
                    <Button
                      variant="outline"
                      size="sm"
                      className="h-7 px-2 text-xs"
                      disabled={txPage <= 1}
                      onClick={() => setTxPage((p) => Math.max(1, p - 1))}
                    >
                      Previous
                    </Button>
                    <span className="px-2">
                      {txPage} / {txPageCount}
                    </span>
                    <Button
                      variant="outline"
                      size="sm"
                      className="h-7 px-2 text-xs"
                      disabled={txPage >= txPageCount}
                      onClick={() => setTxPage((p) => Math.min(txPageCount, p + 1))}
                    >
                      Next
                    </Button>
                  </div>
                </div>
              )}
              <p className="mt-3 flex items-center gap-1.5 border-t pt-3 text-xs text-muted-foreground">
                <Info className="h-3.5 w-3.5 shrink-0" /> {t("cashSessions.cannotDelete")}
              </p>
            </CardContent>
          </Card>

          {/* Session history (collapsed) — session-lifecycle events only */}
          <Collapsible open={historyOpen} onOpenChange={setHistoryOpen}>
            <Card>
              <CollapsibleTrigger asChild>
                <CardHeader className="cursor-pointer flex-row items-center justify-between space-y-0 py-4">
                  <CardTitle className="flex items-center gap-2 text-base">
                    <ChevronDown className={`h-4 w-4 transition-transform ${historyOpen ? "rotate-180" : ""}`} />
                    {t("cashSessions.sessionHistoryWithCount", {
                      count: sessionActivity.length + (txAllTotal > 0 ? 1 : 0),
                    })}
                  </CardTitle>
                  {lastSessionActivity && !historyOpen && (
                    <span className="text-xs text-muted-foreground">
                      {t("cashSessions.lastActivity", {
                        action: lastSessionActivity.action.replace(/_/g, " "),
                        time: new Date(lastSessionActivity.created_at).toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit" }),
                      })}
                    </span>
                  )}
                </CardHeader>
              </CollapsibleTrigger>
              <CollapsibleContent>
                <CardContent>
                  {sessionActivity.length === 0 && txAllTotal === 0 ? (
                    <p className="py-2 text-sm text-muted-foreground">—</p>
                  ) : (
                    <ul className="space-y-2 text-sm">
                      {sessionActivity.map((a) => {
                        const isHistExpanded = expandedHistoryIds.has(a.id);
                        return (
                          <li key={a.id} className="border-b pb-2 last:border-0">
                            <div
                              className={`flex items-start justify-between gap-3 ${a.detail ? "cursor-pointer" : ""}`}
                              onClick={a.detail ? () => toggleHistoryExpand(a.id) : undefined}
                            >
                              <div className="flex items-center gap-1.5">
                                {a.detail && (
                                  <ChevronDown className={`h-3 w-3 shrink-0 text-muted-foreground transition-transform ${isHistExpanded ? "rotate-180" : ""}`} />
                                )}
                                <div>
                                  <span className="font-medium capitalize">{a.action.replace(/_/g, " ")}</span>
                                  {a.actor_name && <span className="text-muted-foreground"> · {a.actor_name}</span>}
                                </div>
                              </div>
                              <span className="whitespace-nowrap text-xs text-muted-foreground">
                                {new Date(a.created_at).toLocaleString(locale)}
                              </span>
                            </div>
                            {a.detail && isHistExpanded && (
                              <div className="ms-4 mt-1 rounded bg-muted/40 px-2 py-1.5 text-xs text-muted-foreground">
                                <pre className="whitespace-pre-wrap break-all font-sans">
                                  {(() => {
                                    try { return JSON.stringify(JSON.parse(a.detail), null, 2); }
                                    catch { return a.detail; }
                                  })()}
                                </pre>
                              </div>
                            )}
                          </li>
                        );
                      })}
                      {/* Transaction-activity summary row */}
                      {txAllTotal > 0 && (
                        <li className="flex items-center justify-between gap-3 pb-2 text-sm">
                          <span className="text-muted-foreground">
                            {txAllTotal} transaction{txAllTotal !== 1 ? "s" : ""} recorded
                          </span>
                          <button
                            type="button"
                            className="flex items-center gap-1 text-xs text-primary underline-offset-2 hover:underline"
                            onClick={() => {
                              setHistoryOpen(false);
                              txCardRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
                            }}
                          >
                            View transactions ↗
                          </button>
                        </li>
                      )}
                    </ul>
                  )}
                </CardContent>
              </CollapsibleContent>
            </Card>
          </Collapsible>
        </div>

        {/* Right column: Quick Entry (open session) or Closure Summary (closed session) */}
        {canEnter ? (
          <div className="hidden lg:block">
            <QuickEntryPanel
              sessionId={id!}
              currencies={currencies}
              sessionRates={data?.exchange_rates ?? {}}
              documentCurrency={session.currency}
              thresholds={thresholds}
              tab={entryTab}
              onTabChange={setEntryTab}
              onSaved={invalidate}
              currencySummary={summary}
            />
          </div>
        ) : summary.length > 0 && (
          <div className="hidden lg:block">
            <Card className="h-fit lg:sticky lg:top-4">
              <CardHeader className="pb-3">
                <CardTitle className="text-base">{t("cashSessions.reconciliationSummary", "Reconciliation Summary")}</CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                {summary.map((row) => {
                  const count = session.closing_counts?.find((c) => c.currency === row.currency) ?? null;
                  const result = count?.result ?? (count ? (count.actual === null ? "awaiting_count" : count.variance === 0 ? "balanced" : count.variance < 0 ? "shortage" : "overage") : null);
                  const hasCount = count !== null && count.actual !== null;
                  return (
                    <div key={row.currency} className="rounded-md border p-3 space-y-2">
                      <div className="flex items-center justify-between">
                        <span className="rounded px-2 py-0.5 text-xs font-semibold text-white" style={{ backgroundColor: TEAL_DARK }}>
                          {row.currency}
                        </span>
                        {result === "balanced" && (
                          <span className="inline-flex items-center gap-1 rounded-full bg-emerald-50 px-2 py-0.5 text-xs font-semibold text-emerald-700">
                            <CheckCircle2 className="h-3 w-3" /> {t("cashSessions.close.balanced", "Balanced")}
                          </span>
                        )}
                        {result === "shortage" && (
                          <span className="inline-flex items-center gap-1 rounded-full bg-red-50 px-2 py-0.5 text-xs font-semibold text-red-700">
                            <AlertTriangle className="h-3 w-3" /> {t("cashSessions.close.shortage", "Shortage")}
                          </span>
                        )}
                        {result === "overage" && (
                          <span className="inline-flex items-center gap-1 rounded-full bg-amber-50 px-2 py-0.5 text-xs font-semibold text-amber-600">
                            <Info className="h-3 w-3" /> {t("cashSessions.close.overage", "Overage")}
                          </span>
                        )}
                      </div>
                      <div className="grid grid-cols-2 gap-x-2 gap-y-1 text-xs">
                        <span className="text-muted-foreground">{t("cashSessions.expected", "Expected")}</span>
                        <span className="text-right tabular-nums font-medium" style={{ color: TEAL_DARK }}>
                          {formatCashMoney(count?.expected ?? row.expected_cash, row.currency)}
                        </span>
                        {hasCount && (
                          <>
                            <span className="text-muted-foreground">{t("cashSessions.counted", "Counted")}</span>
                            <span className="text-right tabular-nums font-medium">
                              {formatCashMoney(count!.actual, row.currency)}
                            </span>
                            <span className="text-muted-foreground">{t("cashSessions.difference", "Difference")}</span>
                            <span className={`text-right tabular-nums font-semibold ${count!.variance === 0 ? "text-emerald-600" : count!.variance < 0 ? "text-red-600" : "text-amber-600"}`}>
                              {formatCashMoney(count!.variance, row.currency, { signed: true })}
                            </span>
                          </>
                        )}
                      </div>
                    </div>
                  );
                })}
                {session.status === "approved" && session.approved_by_name && (
                  <p className="text-xs text-muted-foreground pt-1 border-t">
                    {t("cashSessions.approvedByOn", {
                      name: session.approved_by_name,
                      date: session.approved_at ? new Date(session.approved_at).toLocaleDateString(locale, { year: "numeric", month: "short", day: "numeric" }) : "—",
                    })}
                  </p>
                )}
              </CardContent>
            </Card>
          </div>
        )}
      </div>

      {/* Flag / Reopen dialog */}
      <Dialog open={reasonDialog !== null} onOpenChange={(o) => !o && setReasonDialog(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{reasonDialog === "flag" ? "Flag Session" : "Reopen Session"}</DialogTitle>
          </DialogHeader>
          <div className="space-y-1.5">
            <Label>Reason</Label>
            <Textarea value={reason} onChange={(e) => setReason(e.target.value)} rows={3} placeholder="Required" />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setReasonDialog(null)}>Cancel</Button>
            <Button
              disabled={!reason.trim() || action.isPending}
              onClick={() =>
                action.mutate(
                  reasonDialog === "flag"
                    ? { path: "flag", body: { flag_reason: reason.trim() } }
                    : { path: "reopen", body: { reopen_reason: reason.trim() } },
                )
              }
            >
              {action.isPending && <Loader2 className="me-1.5 h-4 w-4 animate-spin" />}
              Confirm
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Adjustment dialog */}
      <Dialog open={adjOpen} onOpenChange={setAdjOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("cashSessions.adjustCash")}</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-1.5">
              <Label>{t("cashSessions.type")}</Label>
              <Select value={adj.direction} onValueChange={(v) => setAdj((a) => ({ ...a, direction: v }))}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="in">Cash In (+)</SelectItem>
                  <SelectItem value="out">Cash Out (−)</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label>{t("cashSessions.amount")} ({session.currency})</Label>
              <Input type="number" min="0" step="0.01" value={adj.amount} onChange={(e) => setAdj((a) => ({ ...a, amount: e.target.value }))} placeholder="0.00" />
            </div>
            <div className="space-y-1.5">
              <Label>{t("cashSessions.descriptionLabel")}</Label>
              <Textarea value={adj.description} onChange={(e) => setAdj((a) => ({ ...a, description: e.target.value }))} rows={2} />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setAdjOpen(false)}>Cancel</Button>
            <Button
              disabled={adjMutation.isPending || !adj.amount || Number(adj.amount) <= 0 || !adj.description.trim()}
              onClick={() => adjMutation.mutate()}
            >
              {adjMutation.isPending && <Loader2 className="me-1.5 h-4 w-4 animate-spin" />}
              {t("cashSessions.adjustCash")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Reverse dialog */}
      <Dialog open={reverseTx !== null} onOpenChange={(o) => !o && setReverseTx(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("cashSessions.reverseTransaction")}</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">{t("cashSessions.reverseExplain")}</p>
          {reverseTx && (
            <div className="rounded-md border bg-muted/30 px-3 py-2 text-sm">
              {t(`cashSessions.types.${reverseTx.type}`, reverseTx.type)} · {formatCashMoney(reverseTx.amount, reverseTx.currency)}
              {reverseTx.description ? ` — ${reverseTx.description}` : ""}
            </div>
          )}
          <div className="space-y-1.5">
            <Label>{t("cashSessions.reverseReason")}</Label>
            <Textarea value={reverseReason} onChange={(e) => setReverseReason(e.target.value)} rows={2} data-testid="input-reverse-reason" />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setReverseTx(null)}>Cancel</Button>
            <Button
              disabled={!reverseReason.trim() || reverseMutation.isPending}
              onClick={() => reverseMutation.mutate()}
              data-testid="button-confirm-reverse"
            >
              {reverseMutation.isPending && <Loader2 className="me-1.5 h-4 w-4 animate-spin" />}
              {t("cashSessions.reverseConfirm")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Attachment preview dialog */}
      <Dialog open={previewAttachmentUrl !== null} onOpenChange={(o) => { if (!o) setPreviewAttachmentUrl(null); }}>
        <DialogContent className="max-w-3xl">
          <DialogHeader>
            <DialogTitle>Receipt</DialogTitle>
          </DialogHeader>
          {previewAttachmentUrl && (
            <AttachmentViewer url={previewAttachmentUrl} />
          )}
        </DialogContent>
      </Dialog>

      {/* Transfer cash out modal */}
      {transferOpen && (
        <TransferCashModal
          open={transferOpen}
          onClose={() => setTransferOpen(false)}
          sessionId={id!}
          sessionNumber={session.session_number}
          sourceLocationName={session.location_name}
          sourceDrawerName={session.drawer_name}
          sourceDrawerId={session.drawer_id ?? null}
          currencies={currencies}
          currencySummary={summary}
          onSuccess={invalidate}
        />
      )}

      {/* Confirm Transfer Receipt Modal */}
      {confirmTransfer && (
        <ConfirmTransferReceiptModal
          transfer={confirmTransfer}
          open={true}
          onClose={() => setConfirmTransfer(null)}
          onSuccess={() => {
            setConfirmTransfer(null);
            invalidate();
          }}
        />
      )}

      {/* Report Difference Modal */}
      {disputeTransfer && (
        <ReportTransferDifferenceModal
          transfer={disputeTransfer}
          open={true}
          onClose={() => setDisputeTransfer(null)}
          onSuccess={() => {
            setDisputeTransfer(null);
            invalidate();
          }}
        />
      )}

      {/* Transfer detail side panel */}
      <TransferDetailPanel
        transferId={viewTransferId}
        open={viewTransferId != null}
        onClose={() => setViewTransferId(null)}
      />
    </div>
  );
}

/**
 * Fetches an attachment via authenticated fetch, detects the MIME type from the
 * response blob, then renders it inline: an <iframe> for PDFs, an <img> for
 * everything else. Falls back to an inline error message on failure.
 */
function AttachmentViewer({ url }: { url: string }) {
  const [objectUrl, setObjectUrl] = React.useState<string | null>(null);
  const [isPdf, setIsPdf] = React.useState(false);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    let revoked = false;
    let created: string | null = null;
    setLoading(true);
    setError(null);
    setObjectUrl(null);
    setIsPdf(false);
    (async () => {
      try {
        const token = await getClerkToken();
        const res = await fetch(url, {
          credentials: "include",
          headers: token ? { Authorization: `Bearer ${token}` } : {},
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const blob = await res.blob();
        if (!revoked) {
          created = URL.createObjectURL(blob);
          setIsPdf(blob.type === "application/pdf");
          setObjectUrl(created);
        }
      } catch (e) {
        if (!revoked) setError(e instanceof Error ? e.message : "Failed to load receipt.");
      } finally {
        if (!revoked) setLoading(false);
      }
    })();
    return () => {
      revoked = true;
      if (created) URL.revokeObjectURL(created);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url]);

  if (loading) return <div className="flex items-center justify-center py-12"><Loader2 className="h-6 w-6 animate-spin text-muted-foreground" /></div>;
  if (error) return <p className="py-6 text-center text-sm text-destructive">{error}</p>;
  if (isPdf) return <iframe src={objectUrl!} title="Receipt PDF" className="w-full h-[75vh] rounded border" />;
  return (
    <img
      src={objectUrl!}
      alt="Receipt"
      className="max-h-[75vh] w-full object-contain"
      onError={() => setError("Receipt image couldn't be rendered.")}
    />
  );
}

function TransactionSettlementBreakdown({
  movements,
  docCurrency,
  isExpense,
}: {
  movements: TransactionMovement[];
  docCurrency: string;
  isExpense?: boolean;
}) {
  const { t } = useTranslation();

  const kindLabel = (kind: string) => {
    const map: Record<string, string> = {
      payment: t("cashSessions.movement.payment", "Payment"),
      change: t("cashSessions.movement.change", "Change"),
      expense_payment: t("cashSessions.movement.expensePayment", "Expense payment"),
    };
    return map[kind] ?? kind.replace(/_/g, " ");
  };

  const isCrossRate = (m: TransactionMovement) =>
    m.exchange_rate != null && m.currency !== docCurrency;

  return (
    <div className="mt-1.5 rounded-md border bg-background p-3">
      <p className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
        {isExpense
          ? t("cashSessions.drawerMovementsPhysical", "Drawer movements (physical cash)")
          : t("cashSessions.settlementBreakdown", "Settlement breakdown")}
      </p>
      <table className="w-full text-xs">
        <thead>
          <tr className="border-b text-muted-foreground">
            <th className="pb-1 pe-3 text-start font-medium">{t("cashSessions.movement.kind", "Kind")}</th>
            <th className="pb-1 pe-3 text-end font-medium">{t("cashSessions.amount", "Amount")}</th>
            <th className="pb-1 pe-3 text-end font-medium">{t("cashSessions.movement.rate", "Rate")}</th>
            <th className="pb-1 text-end font-medium">{t("cashSessions.movement.converted", "Converted")}</th>
          </tr>
        </thead>
        <tbody>
          {movements.map((m) => {
            const isOut = m.direction === "outflow";
            return (
              <tr key={m.id} className="border-b last:border-0">
                <td className="py-1.5 pe-3">
                  <span
                    className={`inline-flex items-center rounded-full px-1.5 py-0.5 text-[10px] font-semibold ${
                      isOut ? "bg-red-100 text-red-700" : "bg-emerald-100 text-emerald-700"
                    }`}
                  >
                    {kindLabel(m.kind)}
                  </span>
                </td>
                <td className={`py-1.5 pe-3 text-end tabular-nums font-medium ${isOut ? "text-red-600" : "text-emerald-600"}`}>
                  {isOut ? "−" : "+"}{formatCashMoney(m.amount, m.currency)}
                </td>
                <td className="py-1.5 pe-3 text-end tabular-nums text-muted-foreground">
                  {isCrossRate(m) ? `1 ${m.currency} = ${Number(m.exchange_rate).toLocaleString(undefined, { maximumFractionDigits: 6 })} ${docCurrency}` : "—"}
                </td>
                <td className="py-1.5 text-end tabular-nums text-muted-foreground">
                  {isCrossRate(m) && m.converted_amount != null
                    ? formatCashMoney(m.converted_amount, docCurrency)
                    : "—"}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

export function QuickEntryPanel({
  sessionId,
  currencies,
  sessionRates,
  documentCurrency,
  thresholds,
  tab,
  onTabChange,
  onSaved,
  currencySummary,
}: {
  sessionId: string;
  currencies: string[];
  sessionRates: Record<string, number>;
  documentCurrency: string;
  thresholds: Threshold[];
  tab: "sale" | "expense";
  onTabChange: (t: "sale" | "expense") => void;
  onSaved: () => void;
  currencySummary: CurrencySummary[];
}) {
  const { t } = useTranslation();
  const { toast } = useToast();
  const fileRef = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);

  // ── Idempotency / submission safety state ─────────────────────────────────
  const idempotencyKeyRef = useRef<string>(crypto.randomUUID());
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [sessionClosed, setSessionClosed] = useState(false);
  const [lastSuccess, setLastSuccess] = useState<{
    amount: number;
    currency: string;
    type: "sale" | "expense" | "bill_payment";
    expectedCash: number | null;
    transactionId: number;
    billReference?: string;
  } | null>(null);
  const successTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const defaultCurrency = currencies[0] ?? "USD";

  // ── Sale state ────────────────────────────────────────────────────────────
  const [sale, setSale] = useState({
    amount: "",
    currency: documentCurrency || defaultCurrency,
    channel: "",
    reference: "",
    note: "",
  });
  const [salePayments, setSalePayments] = useState<MovementRow[]>([newRow(defaultCurrency)]);
  const [saleChange, setSaleChange] = useState<MovementRow[]>([]);
  const [saleBalanceDiffKind, setSaleBalanceDiffKind] = useState("");

  // ── Expense mode state ────────────────────────────────────────────────────
  const [expenseMode, setExpenseMode] = useState<"cash_purchase" | "bill_payment">("cash_purchase");

  // ── Expense state ─────────────────────────────────────────────────────────
  const [expense, setExpense] = useState({
    amount: "",
    currency: documentCurrency || defaultCurrency,
    category: "",
    payee: "",
    description: "",
  });
  const [expensePayments, setExpensePayments] = useState<MovementRow[]>([newRow(defaultCurrency)]);
  const [expenseChange, setExpenseChange] = useState<MovementRow[]>([]);

  // ── Payroll state ─────────────────────────────────────────────────────────
  const [payroll, setPayroll] = useState({
    employee_id: "",
    period: "",
    payment_type: "",
    notes: "",
  });
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [duplicatePayrollDialog, setDuplicatePayrollDialog] = useState<{
    employee_name: string;
    period: string;
    payment_type: string;
  } | null>(null);
  const confirmDuplicateRef = useRef(false);

  // ── Bill payment state ────────────────────────────────────────────────────
  const [selectedBill, setSelectedBill] = useState<PayableBill | null>(null);
  const [billSearchQuery, setBillSearchQuery] = useState("");
  const [debouncedBillSearch, setDebouncedBillSearch] = useState("");
  const [billPaymentAmount, setBillPaymentAmount] = useState("");
  const billSearchTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  function handleBillSearchChange(val: string) {
    setBillSearchQuery(val);
    setSelectedBill(null);
    clearTimeout(billSearchTimerRef.current);
    billSearchTimerRef.current = setTimeout(() => setDebouncedBillSearch(val.trim()), 300);
  }

  // ── Settlement calculations ───────────────────────────────────────────────
  const saleCalc = useCashSettlementCalc({
    docAmount: sale.amount,
    docCurrency: sale.currency,
    payments: salePayments,
    change: saleChange,
    rates: sessionRates,
  });

  const expenseCalc = useCashSettlementCalc({
    docAmount: expense.amount,
    docCurrency: expense.currency,
    payments: expensePayments,
    change: expenseChange,
    rates: sessionRates,
    mode: "expense",
  });

  const billPaymentCalc = useCashSettlementCalc({
    docAmount: billPaymentAmount,
    docCurrency: selectedBill?.currency ?? documentCurrency,
    payments: expensePayments,
    change: expenseChange,
    rates: sessionRates,
    mode: "expense",
  });

  const calc =
    tab === "sale"
      ? saleCalc
      : expenseMode === "bill_payment"
        ? billPaymentCalc
        : expenseCalc;

  // ── Employees query (for payroll expense) ────────────────────────────────
  const { data: employeesData } = useQuery<{ id: string; display_name: string; employee_code: string | null }[]>({
    queryKey: ["cash-session-employees"],
    queryFn: () => apiFetch("/api/cash-sessions/employees"),
    staleTime: 60_000,
    enabled: tab === "expense" && expenseMode === "cash_purchase",
  });
  const employees = employeesData ?? [];

  // ── Payable bills query (bill_payment mode) ───────────────────────────────
  const { data: payableBillsData } = useQuery<{ bills: PayableBill[] }>({
    queryKey: ["payable-bills", sessionId, debouncedBillSearch],
    queryFn: () => {
      const params = new URLSearchParams();
      if (debouncedBillSearch) params.set("q", debouncedBillSearch);
      return apiFetch(`/api/cash-sessions/${sessionId}/payable-bills?${params.toString()}`);
    },
    enabled: tab === "expense" && expenseMode === "bill_payment",
    staleTime: 30_000,
  });
  const payableBills = payableBillsData?.bills ?? [];

  // ── Threshold / receipt hint logic ───────────────────────────────────────
  const threshold = thresholds.find(
    (th) => th.currency === (tab === "expense" && expenseMode === "cash_purchase" ? expense.currency : ""),
  );

  // ── Helpers ───────────────────────────────────────────────────────────────
  function updateSalePaymentRow(id: string, updated: MovementRow) {
    setSalePayments((rows) => rows.map((r) => (r.id === id ? updated : r)));
  }
  function removeSalePaymentRow(id: string) {
    setSalePayments((rows) => rows.filter((r) => r.id !== id));
  }
  function updateSaleChangeRow(id: string, updated: MovementRow) {
    setSaleChange((rows) => rows.map((r) => (r.id === id ? updated : r)));
  }
  function removeSaleChangeRow(id: string) {
    setSaleChange((rows) => rows.filter((r) => r.id !== id));
  }
  function updateExpensePaymentRow(id: string, updated: MovementRow) {
    setExpensePayments((rows) => rows.map((r) => (r.id === id ? updated : r)));
  }
  function removeExpensePaymentRow(id: string) {
    setExpensePayments((rows) => rows.filter((r) => r.id !== id));
  }
  function updateExpenseChangeRow(id: string, updated: MovementRow) {
    setExpenseChange((rows) => rows.map((r) => (r.id === id ? updated : r)));
  }
  function removeExpenseChangeRow(id: string) {
    setExpenseChange((rows) => rows.filter((r) => r.id !== id));
  }

  async function uploadReceipt(): Promise<string | undefined> {
    if (!file) return undefined;
    const fd = new FormData();
    fd.append("invoice", file);
    const uploaded = await apiFetch<{ url: string }>(
      `/api/cash-sessions/${sessionId}/bill/invoice`,
      { method: "POST", body: fd },
    );
    return uploaded.url;
  }

  function buildPaymentsPayload(rows: MovementRow[], docCurrency: string) {
    return rows
      .filter((r) => r.amount !== "" && Number(r.amount) > 0)
      .map((r) => {
        if (r.currency === docCurrency) {
          return { amount: Number(r.amount), currency: r.currency };
        }
        // sessionRates stores "foreign per 1 doc" (display rate).
        // API expects exchange_rate = "doc per 1 foreign" = 1 / displayRate.
        const isOverride = r.rateOverride !== "";
        const displayRate = isOverride
          ? parseFloat(r.rateOverride)
          : (sessionRates[r.currency] ?? undefined);
        const apiRate = displayRate && displayRate > 0 ? 1 / displayRate : undefined;
        return {
          amount: Number(r.amount),
          currency: r.currency,
          ...(apiRate != null ? { exchange_rate: apiRate } : {}),
          ...(isOverride ? { is_rate_override: true } : {}),
        };
      });
  }

  // ── Field reset (called after 4-second confirmation strip) ──────────────
  function doReset() {
    setSale((s) => ({ ...s, amount: "", reference: "", note: "" }));
    setSalePayments([newRow(defaultCurrency)]);
    setSaleChange([]);
    setSaleBalanceDiffKind("");
    setExpense((e) => ({ ...e, amount: "", payee: "", description: "" }));
    setExpensePayments([newRow(defaultCurrency)]);
    setExpenseChange([]);
    setPayroll({ employee_id: "", period: "", payment_type: "", notes: "" });
    setFieldErrors({});
    setFile(null);
    if (fileRef.current) fileRef.current.value = "";
    // Reset bill payment state and mode
    setExpenseMode("cash_purchase");
    setSelectedBill(null);
    setBillSearchQuery("");
    setDebouncedBillSearch("");
    setBillPaymentAmount("");
  }

  const saveMutation = useMutation({
    mutationFn: async () => {
      setSubmitError(null);
      setFieldErrors({});
      const iKey = idempotencyKeyRef.current;
      const extraHeaders: Record<string, string> = { "X-Idempotency-Key": iKey };
      const attachmentUrl = await uploadReceipt();

      if (tab === "sale") {
        const paymentsPayload = buildPaymentsPayload(salePayments, sale.currency);
        const changePayload = buildPaymentsPayload(saleChange, sale.currency);
        const isSingleCurrency =
          paymentsPayload.length === 1 &&
          paymentsPayload[0].currency === sale.currency &&
          changePayload.length === 0;
        try {
          return await apiFetch(`/api/cash-sessions/${sessionId}/sale`, {
            method: "POST",
            headers: extraHeaders,
            body: JSON.stringify({
              amount: Number(sale.amount),
              currency: sale.currency,
              sale_channel: sale.channel,
              reference: sale.reference.trim() || null,
              note: sale.note.trim() || null,
              ...(attachmentUrl ? { attachment_url: attachmentUrl } : {}),
              ...(!isSingleCurrency && { payments: paymentsPayload }),
              ...(!isSingleCurrency && changePayload.length > 0 && { change: changePayload }),
              ...(saleCalc.status !== "balanced" && saleBalanceDiffKind
                ? { balance_difference_kind: saleBalanceDiffKind }
                : {}),
            }),
          });
        } catch (err) {
          const e = err as { status?: number; body?: Record<string, unknown> };
          if (e.status === 409 && e.body && typeof e.body.transaction_id === "number") {
            // Idempotency replay — same key was already processed; de-duplicate silently.
            return { __idempotencyReplay: true };
          }
          if (e.status === 409 || e.status === 423) setSessionClosed(true);
          throw err;
        }
      }

      // ── Bill payment submission ────────────────────────────────────────
      if (expenseMode === "bill_payment") {
        if (!selectedBill) throw new Error("No bill selected");
        const billPayCurrency = selectedBill.currency;
        const billPaymentsPayload = buildPaymentsPayload(expensePayments, billPayCurrency);
        const billChangePayload = buildPaymentsPayload(expenseChange, billPayCurrency);
        const billIsSingleCurrency =
          billPaymentsPayload.length === 1 &&
          billPaymentsPayload[0].currency === billPayCurrency &&
          billChangePayload.length === 0;
        try {
          return await apiFetch(`/api/cash-sessions/${sessionId}/bill-payment`, {
            method: "POST",
            headers: extraHeaders,
            body: JSON.stringify({
              supplier_invoice_id: selectedBill.id,
              payment_amount: Number(billPaymentAmount),
              currency: billPayCurrency,
              ...(!billIsSingleCurrency && { payments: billPaymentsPayload }),
              ...(!billIsSingleCurrency && billChangePayload.length > 0 && { change: billChangePayload }),
            }),
          });
        } catch (err) {
          const e = err as { status?: number; body?: Record<string, unknown> };
          if (e.status === 409 && e.body && typeof e.body.transaction_id === "number") {
            return { __idempotencyReplay: true };
          }
          if (e.status === 409 || e.status === 423) setSessionClosed(true);
          throw err;
        }
      }

      // ── Cash purchase submission ───────────────────────────────────────
      const expPaymentsPayload = buildPaymentsPayload(expensePayments, expense.currency);
      const expChangePayload = buildPaymentsPayload(expenseChange, expense.currency);
      const expIsSingleCurrency =
        expPaymentsPayload.length === 1 &&
        expPaymentsPayload[0].currency === expense.currency &&
        expChangePayload.length === 0;
      const expIsPayroll = isPayrollCategory(expense.category);
      try {
        const result = await apiFetch(`/api/cash-sessions/${sessionId}/expense`, {
          method: "POST",
          headers: extraHeaders,
          body: JSON.stringify({
            amount: Number(expense.amount),
            currency: expense.currency,
            expense_category: expense.category,
            ...(expIsPayroll
              ? {
                  payroll_employee_id: payroll.employee_id,
                  payroll_period: payroll.period,
                  payroll_payment_type: payroll.payment_type,
                  ...(payroll.notes ? { payroll_notes: payroll.notes } : {}),
                  ...(confirmDuplicateRef.current ? { confirm_duplicate: true } : {}),
                }
              : {
                  payee: expense.payee.trim(),
                  description: expense.description.trim(),
                }),
            ...(attachmentUrl ? { attachment_url: attachmentUrl } : {}),
            ...(!expIsSingleCurrency && { payments: expPaymentsPayload }),
            ...(!expIsSingleCurrency && expChangePayload.length > 0 && { change: expChangePayload }),
          }),
        });
        confirmDuplicateRef.current = false;
        return result;
      } catch (err) {
        const e = err as { status?: number; body?: Record<string, unknown> };
        if (e.status === 409 && e.body && typeof e.body.transaction_id === "number") {
          confirmDuplicateRef.current = false;
          return { __idempotencyReplay: true };
        }
        // Duplicate payroll — surface confirm dialog
        if (e.status === 409 && e.body && e.body.duplicate) {
          const dup = e.body.duplicate as { employee_name: string; period: string; payment_type: string };
          setDuplicatePayrollDialog({ employee_name: dup.employee_name, period: dup.period, payment_type: dup.payment_type });
          return { __duplicatePayrollPending: true };
        }
        // Field-level errors from payroll validation
        if (e.status === 400 && e.body && e.body.fields) {
          setFieldErrors(e.body.fields as Record<string, string>);
        }
        confirmDuplicateRef.current = false;
        if (e.status === 409 || e.status === 423) setSessionClosed(true);
        throw err;
      }
    },
    onSuccess: (data) => {
      const replay = (data as Record<string, unknown>)?.__idempotencyReplay === true;
      const dupPending = (data as Record<string, unknown>)?.__duplicatePayrollPending === true;
      // Duplicate payroll dialog is already shown; skip reset/toast until user confirms/cancels.
      if (dupPending) return;
      if (!replay) {
        // Rotate idempotency key so the next genuine submission uses a fresh UUID.
        idempotencyKeyRef.current = crypto.randomUUID();
      }
      setSubmitError(null);

      if (!replay) {
        const respData = data as { transaction_id: number; pending_approval?: boolean; approver_names?: string[] };
        const isBillPayment = tab === "expense" && expenseMode === "bill_payment";
        const currentAmount = tab === "sale"
          ? Number(sale.amount)
          : isBillPayment
            ? Number(billPaymentAmount)
            : Number(expense.amount);
        const currentCurrency = tab === "sale"
          ? sale.currency
          : isBillPayment
            ? (selectedBill?.currency ?? documentCurrency)
            : expense.currency;
        const successType: "sale" | "expense" | "bill_payment" = tab === "sale"
          ? "sale"
          : isBillPayment
            ? "bill_payment"
            : "expense";
        const summaryEntry = currencySummary.find((c) => c.currency === currentCurrency);
        const projectedExpected =
          summaryEntry != null
            ? summaryEntry.expected_cash + (tab === "sale" ? currentAmount : -currentAmount)
            : null;

        setLastSuccess({
          amount: currentAmount,
          currency: currentCurrency,
          type: successType,
          expectedCash: projectedExpected,
          transactionId: respData.transaction_id,
          ...(isBillPayment && selectedBill ? { billReference: selectedBill.bill_reference } : {}),
        });

        if (successTimerRef.current) clearTimeout(successTimerRef.current);
        successTimerRef.current = setTimeout(() => {
          setLastSuccess(null);
          doReset();
        }, 4000);

        onSaved();
        toast({
          title:
            tab === "sale"
              ? t("cashSessions.saleRecorded")
              : isBillPayment
                ? t("cashSessions.billPayment.billPaid", "Bill payment recorded")
                : respData.pending_approval
                  ? (respData.approver_names?.length ?? 0) > 0
                    ? t("cashSessions.expensePendingApprovalFrom", "Expense submitted — pending approval from {{names}}", {
                        names: (respData.approver_names ?? []).join(", "),
                      })
                    : t("cashSessions.expensePendingApproval", "Expense submitted — pending approval")
                  : t("cashSessions.expenseRecorded"),
        });
      }
    },
    onError: (err: Error) => {
      setSubmitError(err.message);
      toast({ title: err.message, variant: "destructive" });
    },
  });

  // ── Validation ────────────────────────────────────────────────────────────
  const saleBalanced =
    saleCalc.status === "balanced" || !!saleBalanceDiffKind;
  const saleValid =
    sale.amount !== "" &&
    Number(sale.amount) > 0 &&
    !!sale.channel &&
    salePayments.some((r) => r.amount !== "" && Number(r.amount) > 0) &&
    saleBalanced;

  const isPayrollExpense = isPayrollCategory(expense.category);
  const cashPurchaseValid =
    expense.amount !== "" &&
    Number(expense.amount) > 0 &&
    !!expense.category &&
    (isPayrollExpense
      ? !!payroll.employee_id && !!payroll.period && !!payroll.payment_type
      : !!expense.payee.trim() && !!expense.description.trim()) &&
    expensePayments.some((r) => r.amount !== "" && Number(r.amount) > 0) &&
    expenseCalc.status === "balanced";

  const billAlreadyFullyPaid =
    selectedBill != null && selectedBill.outstanding_balance === 0;

  const billPaymentOverBalance =
    selectedBill != null &&
    billPaymentAmount !== "" &&
    Number(billPaymentAmount) > selectedBill.outstanding_balance;

  const billPaymentValid =
    selectedBill != null &&
    !billAlreadyFullyPaid &&
    billPaymentAmount !== "" &&
    Number(billPaymentAmount) > 0 &&
    !billPaymentOverBalance &&
    billPaymentCalc.status === "balanced";

  const expenseValid = expenseMode === "bill_payment" ? billPaymentValid : cashPurchaseValid;

  // ── Balance badge ─────────────────────────────────────────────────────────
  function BalanceBadge({ forCurrency, matchedLabel }: { forCurrency: string; matchedLabel?: string }) {
    if (!calc.status || calc.difference === 0 && calc.status === "balanced") {
      const hasAnyPayment =
        tab === "sale"
          ? salePayments.some((r) => r.amount !== "" && Number(r.amount) > 0)
          : expensePayments.some((r) => r.amount !== "" && Number(r.amount) > 0);
      if (!hasAnyPayment) return null;
    }
    if (calc.status === "balanced") {
      return (
        <div className="flex items-center gap-1.5 rounded-md border border-emerald-200 bg-emerald-50 px-2.5 py-1.5 text-xs font-medium text-emerald-700">
          <CheckCircle2 className="h-3.5 w-3.5 shrink-0" />
          {matchedLabel ?? t("cashSessions.balanceMatched")}
        </div>
      );
    }
    if (calc.status === "underpaid") {
      return (
        <div className="flex items-center gap-1.5 rounded-md border border-blue-200 bg-blue-50 px-2.5 py-1.5 text-xs font-medium text-blue-700">
          <Info className="h-3.5 w-3.5 shrink-0" />
          {t("cashSessions.balanceUnderpaid", {
            amount: formatCashMoney(Math.abs(calc.difference), forCurrency),
          })}
        </div>
      );
    }
    return (
      <div className="flex items-center gap-1.5 rounded-md border border-amber-200 bg-amber-50 px-2.5 py-1.5 text-xs font-medium text-amber-700">
        <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
        {t("cashSessions.balanceOverpaid", {
          amount: formatCashMoney(Math.abs(calc.difference), forCurrency),
        })}
      </div>
    );
  }

  // ── Drawer impact preview ─────────────────────────────────────────────────
  function DrawerImpact() {
    const lines: { currency: string; net: number }[] = [];
    calc.drawerImpact.forEach((net, currency) => {
      if (net !== 0) lines.push({ currency, net });
    });
    if (lines.length === 0) return null;
    return (
      <div className="space-y-1.5 rounded-md border bg-muted/40 px-3 py-2.5">
        <p className="text-xs font-medium text-muted-foreground">
          {t("cashSessions.drawerImpact")}
        </p>
        {lines.map(({ currency, net }) => (
          <div key={currency} className="flex items-center justify-between gap-2">
            <span
              className="rounded px-1.5 py-0.5 text-xs font-semibold text-white"
              style={{ backgroundColor: TEAL_DARK }}
            >
              {currency}
            </span>
            <span
              className={`text-xs font-semibold tabular-nums ${net > 0 ? "text-emerald-600" : "text-red-600"}`}
            >
              {net > 0 ? "+" : ""}
              {formatCashMoney(net, currency)}
            </span>
          </div>
        ))}
        <p className="text-xs text-muted-foreground">{t("cashSessions.drawerImpactHint")}</p>
      </div>
    );
  }

  return (
    <Card className="h-fit lg:sticky lg:top-4" data-testid="panel-quick-entry">
      <CardHeader className="pb-3">
        <CardTitle className="text-base">{t("cashSessions.quickEntry")}</CardTitle>
        <div className="mt-2 grid grid-cols-2 gap-1 rounded-lg bg-muted p-1">
          <button
            type="button"
            onClick={() => onTabChange("sale")}
            className={`rounded-md px-3 py-1.5 text-sm font-medium transition-colors ${tab === "sale" ? "text-white" : "text-muted-foreground"}`}
            style={tab === "sale" ? { backgroundColor: TEAL_DARK } : undefined}
            data-testid="tab-record-sale"
          >
            {t("cashSessions.types.sale")}
          </button>
          <button
            type="button"
            onClick={() => onTabChange("expense")}
            className={`rounded-md px-3 py-1.5 text-sm font-medium transition-colors ${tab === "expense" ? "text-white" : "text-muted-foreground"}`}
            style={tab === "expense" ? { backgroundColor: TEAL_DARK } : undefined}
            data-testid="tab-record-expense"
          >
            {t("cashSessions.types.expense")}
          </button>
        </div>
      </CardHeader>

      <CardContent className="space-y-4">
        {tab === "sale" ? (
          <>
            {/* Sale amount (document currency) */}
            <div className="space-y-1.5">
              <Label data-testid="label-sale-amount">{t("cashSessions.saleAmount")}</Label>
              <div className="flex gap-2">
                <Input
                  type="number"
                  min="0"
                  step="0.01"
                  placeholder="0.00"
                  value={sale.amount}
                  onChange={(e) => setSale((s) => ({ ...s, amount: e.target.value }))}
                  data-testid="input-entry-amount"
                />
                <Select
                  value={sale.currency}
                  onValueChange={(v) => setSale((s) => ({ ...s, currency: v }))}
                >
                  <SelectTrigger className="w-24 shrink-0" data-testid="select-entry-currency">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {currencies.map((c) => (
                      <SelectItem key={c} value={c}>{c}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>

            {/* Sales channel */}
            <div className="space-y-1.5">
              <Label htmlFor="select-sale-channel">{t("cashSessions.saleChannel")}</Label>
              <Select value={sale.channel} onValueChange={(v) => setSale((s) => ({ ...s, channel: v }))}>
                <SelectTrigger id="select-sale-channel" aria-required="true" data-testid="select-sale-channel">
                  <SelectValue placeholder={t("cashSessions.selectChannel")} />
                </SelectTrigger>
                <SelectContent>
                  {SALE_CHANNELS.map((c) => (
                    <SelectItem key={c} value={c}>{t(`cashSessions.channels.${c}`)}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            {/* Payment received rows */}
            <div className="space-y-2">
              <Label>{t("cashSessions.paymentReceived")}</Label>
              {salePayments.map((row, idx) => (
                <CurrencyMovementRow
                  key={row.id}
                  row={row}
                  currencies={currencies}
                  documentCurrency={sale.currency}
                  sessionRates={sessionRates}
                  onChange={(updated) => updateSalePaymentRow(row.id, updated)}
                  onRemove={() => removeSalePaymentRow(row.id)}
                  testIdPrefix={`sale-payment-${idx}`}
                />
              ))}
              <button
                type="button"
                className="flex items-center gap-1 text-xs font-medium hover:underline"
                style={{ color: TEAL_DARK }}
                onClick={() => setSalePayments((rows) => [...rows, newRow(defaultCurrency)])}
                data-testid="button-add-payment"
              >
                <Plus className="h-3.5 w-3.5" /> {t("cashSessions.addPayment")}
              </button>
            </div>

            {/* Change returned rows */}
            <div className="space-y-2">
              <Label>{t("cashSessions.changeReturned")}</Label>
              {saleChange.map((row, idx) => (
                <CurrencyMovementRow
                  key={row.id}
                  row={row}
                  currencies={currencies}
                  documentCurrency={sale.currency}
                  sessionRates={sessionRates}
                  onChange={(updated) => updateSaleChangeRow(row.id, updated)}
                  onRemove={() => removeSaleChangeRow(row.id)}
                  testIdPrefix={`sale-change-${idx}`}
                />
              ))}
              <button
                type="button"
                className="flex items-center gap-1 text-xs font-medium hover:underline"
                style={{ color: TEAL_DARK }}
                onClick={() => setSaleChange((rows) => [...rows, newRow(defaultCurrency)])}
                data-testid="button-add-change"
              >
                <Plus className="h-3.5 w-3.5" /> {t("cashSessions.addChangeCurrency")}
              </button>
            </div>

            {/* Balance badge */}
            <BalanceBadge forCurrency={sale.currency} />

            {/* Difference-kind selector — only when unbalanced */}
            {saleCalc.status !== "balanced" &&
              salePayments.some((r) => r.amount !== "" && Number(r.amount) > 0) && (
                <div className="space-y-1.5">
                  <Label>{t("cashSessions.balanceDifferenceKind")}</Label>
                  <Select value={saleBalanceDiffKind} onValueChange={setSaleBalanceDiffKind}>
                    <SelectTrigger data-testid="select-balance-diff-kind">
                      <SelectValue placeholder={t("cashSessions.selectDifferenceKind")} />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="rounding">{t("cashSessions.differenceKindRounding")}</SelectItem>
                      <SelectItem value="fx_difference">{t("cashSessions.differenceKindFx")}</SelectItem>
                      <SelectItem value="overpayment">{t("cashSessions.differenceKindOverpayment")}</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              )}

            {/* Order reference + note */}
            <div className="space-y-1.5">
              <Label className="flex items-center gap-1">
                {t("cashSessions.orderReference")}
                <span className="text-xs font-normal text-muted-foreground">
                  {t("cashSessions.optionalFieldSuffix")}
                </span>
              </Label>
              <Input
                value={sale.reference}
                onChange={(e) => setSale((s) => ({ ...s, reference: e.target.value }))}
                placeholder={t("cashSessions.optional")}
                data-testid="input-sale-reference"
              />
            </div>
            <div className="space-y-1.5">
              <Label className="flex items-center gap-1">
                {t("cashSessions.note")}
                <span className="text-xs font-normal text-muted-foreground">
                  {t("cashSessions.optionalFieldSuffix")}
                </span>
              </Label>
              <Input
                value={sale.note}
                onChange={(e) => setSale((s) => ({ ...s, note: e.target.value }))}
                placeholder={t("cashSessions.addShortNote")}
                data-testid="input-sale-note"
              />
            </div>
          </>
        ) : (
          <>
            {/* ── Mode selector ────────────────────────────────────────── */}
            <div className="space-y-2">
              <p className="text-xs font-medium text-muted-foreground">
                {t("cashSessions.expenseMode.prompt", "What are you recording?")}
              </p>
              <div className="grid grid-cols-2 gap-2">
                <button
                  type="button"
                  onClick={() => setExpenseMode("cash_purchase")}
                  className={`flex flex-col gap-0.5 rounded-lg border-2 p-2.5 text-start text-sm transition-colors ${
                    expenseMode === "cash_purchase"
                      ? "border-teal-700 bg-teal-50"
                      : "border-border hover:border-muted-foreground/60"
                  }`}
                  data-testid="expense-mode-cash-purchase"
                >
                  <span className="font-semibold text-foreground">
                    {t("cashSessions.expenseMode.cashPurchase", "Cash purchase")}
                  </span>
                  <span className="text-[11px] leading-snug text-muted-foreground">
                    {t("cashSessions.expenseMode.cashPurchaseHint", "New expense paid directly from this drawer")}
                  </span>
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setExpenseMode("bill_payment");
                    setExpensePayments([newRow(defaultCurrency)]);
                    setExpenseChange([]);
                  }}
                  className={`flex flex-col gap-0.5 rounded-lg border-2 p-2.5 text-start text-sm transition-colors ${
                    expenseMode === "bill_payment"
                      ? "border-teal-700 bg-teal-50"
                      : "border-border hover:border-muted-foreground/60"
                  }`}
                  data-testid="expense-mode-bill-payment"
                >
                  <span className="font-semibold text-foreground">
                    {t("cashSessions.expenseMode.billPayment", "Bill payment")}
                  </span>
                  <span className="text-[11px] leading-snug text-muted-foreground">
                    {t("cashSessions.expenseMode.billPaymentHint", "Pay an existing supplier bill")}
                  </span>
                </button>
              </div>
            </div>

            {expenseMode === "cash_purchase" ? (
              <>
                {/* ── Section 1: Expense details ───────────────────────────── */}
                <div className="space-y-3 rounded-md border p-3">
                  <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                    {t("cashSessions.expenseDetailsSection", "Expense details")}
                  </p>

                  {/* Expense total */}
                  <div className="space-y-1.5">
                    <Label>{t("cashSessions.expenseAmount")}</Label>
                    <div className="flex gap-2">
                      <Input
                        type="number"
                        min="0"
                        step="0.01"
                        placeholder="0.00"
                        value={expense.amount}
                        onChange={(e) => setExpense((x) => ({ ...x, amount: e.target.value }))}
                        data-testid="input-entry-amount"
                      />
                      <Select
                        value={expense.currency}
                        onValueChange={(v) => setExpense((x) => ({ ...x, currency: v }))}
                      >
                        <SelectTrigger className="w-24 shrink-0" data-testid="select-entry-currency">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {currencies.map((c) => (
                            <SelectItem key={c} value={c}>{c}</SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                  </div>

                  {/* Category */}
                  <div className="space-y-1.5">
                    <Label htmlFor="select-expense-category">{t("cashSessions.expenseCategory")}</Label>
                    <Select
                      value={expense.category}
                      onValueChange={(v) => {
                        setExpense((x) => ({ ...x, category: v }));
                        // Reset payroll fields when category changes
                        setPayroll({ employee_id: "", period: "", payment_type: "", notes: "" });
                        setFieldErrors({});
                      }}
                    >
                      <SelectTrigger id="select-expense-category" aria-required="true" data-testid="select-expense-category">
                        <SelectValue placeholder={t("cashSessions.selectCategory")} />
                      </SelectTrigger>
                      <SelectContent>
                        {EXPENSE_CATEGORIES.map((c) => (
                          <SelectItem key={c} value={c}>{t(`cashSessions.categories.${c}`)}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>

                  {/* Payroll fields — visible when Salaries & wages is selected */}
                  {isPayrollExpense ? (
                    <div className="space-y-3 rounded-md border border-blue-100 bg-blue-50/40 p-3" data-testid="payroll-section">
                      <p className="text-xs font-medium text-muted-foreground">
                        {t("cashSessions.payrollFieldsHint")}
                      </p>

                      {/* Employee */}
                      <div className="space-y-1.5">
                        <Label htmlFor="select-payroll-employee">{t("cashSessions.payrollEmployee")}</Label>
                        <Select
                          value={payroll.employee_id}
                          onValueChange={(v) => {
                            setPayroll((p) => ({ ...p, employee_id: v }));
                            setFieldErrors((fe) => ({ ...fe, payroll_employee_id: "" }));
                          }}
                        >
                          <SelectTrigger id="select-payroll-employee" data-testid="select-payroll-employee">
                            <SelectValue placeholder={t("cashSessions.searchEmployee")} />
                          </SelectTrigger>
                          <SelectContent>
                            {employees.length === 0 ? (
                              <div className="px-3 py-2 text-sm text-muted-foreground">
                                {t("cashSessions.noEmployeesFound")}
                              </div>
                            ) : (
                              employees.map((emp) => (
                                <SelectItem key={emp.id} value={emp.id}>
                                  {emp.display_name}
                                  {emp.employee_code ? ` (${emp.employee_code})` : ""}
                                </SelectItem>
                              ))
                            )}
                          </SelectContent>
                        </Select>
                        {fieldErrors.payroll_employee_id && (
                          <p className="text-xs text-red-600" data-testid="error-payroll-employee">
                            {fieldErrors.payroll_employee_id}
                          </p>
                        )}
                      </div>

                      {/* Payroll period */}
                      <div className="space-y-1.5">
                        <Label htmlFor="input-payroll-period">{t("cashSessions.payrollPeriod")}</Label>
                        <Input
                          id="input-payroll-period"
                          type="month"
                          value={payroll.period}
                          onChange={(e) => {
                            setPayroll((p) => ({ ...p, period: e.target.value }));
                            setFieldErrors((fe) => ({ ...fe, payroll_period: "" }));
                          }}
                          data-testid="input-payroll-period"
                        />
                        {fieldErrors.payroll_period && (
                          <p className="text-xs text-red-600" data-testid="error-payroll-period">
                            {fieldErrors.payroll_period}
                          </p>
                        )}
                      </div>

                      {/* Payment type */}
                      <div className="space-y-1.5">
                        <Label htmlFor="select-payroll-payment-type">{t("cashSessions.payrollPaymentType")}</Label>
                        <Select
                          value={payroll.payment_type}
                          onValueChange={(v) => {
                            setPayroll((p) => ({ ...p, payment_type: v }));
                            setFieldErrors((fe) => ({ ...fe, payroll_payment_type: "" }));
                          }}
                        >
                          <SelectTrigger id="select-payroll-payment-type" data-testid="select-payroll-payment-type">
                            <SelectValue placeholder={t("cashSessions.selectPaymentType")} />
                          </SelectTrigger>
                          <SelectContent>
                            {PAYROLL_PAYMENT_TYPES.map((pt) => (
                              <SelectItem key={pt} value={pt}>
                                {t(`cashSessions.payrollTypes.${pt}`)}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                        {fieldErrors.payroll_payment_type && (
                          <p className="text-xs text-red-600" data-testid="error-payroll-payment-type">
                            {fieldErrors.payroll_payment_type}
                          </p>
                        )}
                      </div>

                      {/* Notes (optional) */}
                      <div className="space-y-1.5">
                        <Label htmlFor="input-payroll-notes" className="flex items-center gap-1">
                          {t("cashSessions.payrollNotes")}
                          <span className="text-xs font-normal text-muted-foreground">
                            {t("cashSessions.optionalFieldSuffix")}
                          </span>
                        </Label>
                        <Input
                          id="input-payroll-notes"
                          value={payroll.notes}
                          onChange={(e) => setPayroll((p) => ({ ...p, notes: e.target.value }))}
                          placeholder={t("cashSessions.payrollNotesPlaceholder")}
                          data-testid="input-payroll-notes"
                        />
                      </div>
                    </div>
                  ) : (
                    <>
                      {/* Supplier / Payee */}
                      <div className="space-y-1.5">
                        <Label htmlFor="input-expense-payee">{t("cashSessions.payee")}</Label>
                        <Input
                          id="input-expense-payee"
                          aria-required="true"
                          value={expense.payee}
                          onChange={(e) => setExpense((x) => ({ ...x, payee: e.target.value }))}
                          placeholder={t("cashSessions.payeePlaceholder")}
                          data-testid="input-expense-payee"
                        />
                      </div>

                      {/* Description */}
                      <div className="space-y-1.5">
                        <Label htmlFor="input-expense-description">{t("cashSessions.descriptionLabel")}</Label>
                        <Textarea
                          id="input-expense-description"
                          aria-required="true"
                          value={expense.description}
                          onChange={(e) => setExpense((x) => ({ ...x, description: e.target.value }))}
                          rows={2}
                          placeholder={t("cashSessions.describeExpense")}
                          data-testid="input-expense-description"
                        />
                      </div>
                    </>
                  )}
                </div>

                {/* ── Section 2: Payment from drawer ───────────────────────── */}
                <div className="space-y-3 rounded-md border p-3">
                  <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                    {t("cashSessions.paymentFromDrawerSection", "Payment from drawer")}
                  </p>

                  {/* Cash given rows */}
                  <div className="space-y-2">
                    <Label className="text-xs text-muted-foreground">
                      {t("cashSessions.paidFromDrawerRows")}
                    </Label>
                    {expensePayments.map((row, idx) => (
                      <CurrencyMovementRow
                        key={row.id}
                        row={row}
                        currencies={currencies}
                        documentCurrency={expense.currency}
                        sessionRates={sessionRates}
                        onChange={(updated) => updateExpensePaymentRow(row.id, updated)}
                        onRemove={() => removeExpensePaymentRow(row.id)}
                        testIdPrefix={`expense-payment-${idx}`}
                      />
                    ))}
                    <button
                      type="button"
                      className="flex items-center gap-1 text-xs font-medium hover:underline"
                      style={{ color: TEAL_DARK }}
                      onClick={() => setExpensePayments((rows) => [...rows, newRow(defaultCurrency)])}
                      data-testid="button-add-expense-payment"
                    >
                      <Plus className="h-3.5 w-3.5" /> {t("cashSessions.addPayment")}
                    </button>
                  </div>

                  {/* Cash change received rows */}
                  <div className="space-y-2">
                    <Label className="text-xs text-muted-foreground">
                      {t("cashSessions.cashChangeReceived", "Cash change received")}
                    </Label>
                    {expenseChange.map((row, idx) => (
                      <CurrencyMovementRow
                        key={row.id}
                        row={row}
                        currencies={currencies}
                        documentCurrency={expense.currency}
                        sessionRates={sessionRates}
                        onChange={(updated) => updateExpenseChangeRow(row.id, updated)}
                        onRemove={() => removeExpenseChangeRow(row.id)}
                        testIdPrefix={`expense-change-${idx}`}
                      />
                    ))}
                    <button
                      type="button"
                      className="flex items-center gap-1 text-xs font-medium hover:underline"
                      style={{ color: TEAL_DARK }}
                      onClick={() => setExpenseChange((rows) => [...rows, newRow(defaultCurrency)])}
                      data-testid="button-add-expense-change"
                    >
                      <Plus className="h-3.5 w-3.5" /> {t("cashSessions.addChangeFromSupplier")}
                    </button>
                  </div>

                  {/* ── Live reconciliation summary ─────────────────────────── */}
                  {expensePayments.some((r) => r.amount !== "" && Number(r.amount) > 0) && (
                    <div className="space-y-1.5 rounded-md border bg-muted/30 px-3 py-2.5 text-xs">
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-muted-foreground">{t("cashSessions.expenseAmount")}</span>
                        <span className="tabular-nums font-medium">
                          {expense.amount ? formatCashMoney(Number(expense.amount), expense.currency) : "—"}
                        </span>
                      </div>
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-muted-foreground">{t("cashSessions.paidFromDrawerRows")}</span>
                        <span className="tabular-nums font-medium text-red-600">
                          {expenseCalc.paidDocTotal > 0
                            ? `−${formatCashMoney(expenseCalc.paidDocTotal, expense.currency)}`
                            : "—"}
                        </span>
                      </div>
                      {expenseCalc.changeDocTotal > 0 && (
                        <div className="flex items-center justify-between gap-2">
                          <span className="text-muted-foreground">
                            {t("cashSessions.cashChangeReceived", "Cash change received")}
                          </span>
                          <span className="tabular-nums font-medium text-emerald-600">
                            +{formatCashMoney(expenseCalc.changeDocTotal, expense.currency)}
                          </span>
                        </div>
                      )}
                      <div className="flex items-center justify-between gap-2 border-t pt-1.5">
                        <span className="text-muted-foreground">{t("cashSessions.reconDifference", "Difference")}</span>
                        <span
                          className={`tabular-nums font-semibold ${
                            expenseCalc.status === "balanced" ? "text-emerald-600" : "text-amber-600"
                          }`}
                        >
                          {expenseCalc.difference === 0
                            ? formatCashMoney(0, expense.currency)
                            : `${expenseCalc.difference > 0 ? "+" : "−"}${formatCashMoney(Math.abs(expenseCalc.difference), expense.currency)}`}
                        </span>
                      </div>
                      <BalanceBadge
                        forCurrency={expense.currency}
                        matchedLabel={t("cashSessions.balanceMatchedExpense", "Payment matches expense")}
                      />
                    </div>
                  )}

                  {threshold && (
                    <p className="text-xs text-muted-foreground">
                      {t("cashSessions.receiptRecommendedAbove", {
                        currency: expense.currency,
                        amount: formatCashMoney(threshold.receipt_required_above, expense.currency),
                      })}
                    </p>
                  )}
                </div>
              </>
            ) : (
              <>
                {/* ── Bill Payment fields ───────────────────────────── */}
                {/* Bill search */}
                <div className="space-y-1.5">
                  <Label>{t("cashSessions.billPayment.billLabel", "Bill")}</Label>
                  {!selectedBill ? (
                    <>
                      <div className="relative">
                        <Search className="absolute start-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
                        <Input
                          className="ps-8"
                          value={billSearchQuery}
                          onChange={(e) => handleBillSearchChange(e.target.value)}
                          placeholder={t("cashSessions.billPayment.searchPlaceholder", "Search supplier or bill number…")}
                          data-testid="input-bill-search"
                        />
                      </div>
                      {payableBills.length > 0 && (
                        <div className="max-h-48 overflow-y-auto rounded-md border bg-background shadow-sm">
                          {payableBills.map((bill) => (
                            <button
                              key={bill.id}
                              type="button"
                              className="flex w-full items-center justify-between gap-2 px-3 py-2 text-sm hover:bg-muted/50 border-b last:border-0 text-start"
                              onClick={() => {
                                setSelectedBill(bill);
                                setBillSearchQuery(bill.bill_reference);
                                setBillPaymentAmount(String(bill.outstanding_balance));
                                setExpensePayments([newRow(bill.currency)]);
                              }}
                            >
                              <div>
                                <span className="font-medium">{bill.supplier_name}</span>
                                <span className="ms-2 font-mono text-xs text-muted-foreground">{bill.bill_reference}</span>
                              </div>
                              <span className="shrink-0 tabular-nums text-xs font-medium text-amber-700">
                                {formatCashMoney(bill.outstanding_balance, bill.currency)}
                              </span>
                            </button>
                          ))}
                        </div>
                      )}
                      {debouncedBillSearch !== "" && payableBills.length === 0 && (
                        <p className="text-xs text-muted-foreground px-1">
                          {t("cashSessions.billPayment.noResults", "No payable bills found.")}
                        </p>
                      )}
                    </>
                  ) : (
                    <div className="rounded-md border bg-muted/30 px-3 py-2.5">
                      <div className="mb-1.5 flex items-center justify-between gap-2">
                        <div className="flex items-center gap-1.5">
                          <Building2 className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                          <span className="text-sm font-semibold">{selectedBill.supplier_name}</span>
                        </div>
                        <button
                          type="button"
                          onClick={() => {
                            setSelectedBill(null);
                            setBillSearchQuery("");
                            setBillPaymentAmount("");
                            setExpensePayments([newRow(defaultCurrency)]);
                          }}
                          className="shrink-0 text-muted-foreground hover:text-foreground"
                          aria-label="Clear bill selection"
                          data-testid="button-clear-bill"
                        >
                          <X className="h-3.5 w-3.5" />
                        </button>
                      </div>
                      <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs">
                        <div>
                          <span className="text-muted-foreground">{t("cashSessions.billPayment.billRef", "Ref")}: </span>
                          <span className="font-mono font-medium">{selectedBill.bill_reference}</span>
                        </div>
                        {selectedBill.due_date && (
                          <div>
                            <span className="text-muted-foreground">{t("cashSessions.billPayment.dueDate", "Due")}: </span>
                            <span className="font-medium">{selectedBill.due_date}</span>
                          </div>
                        )}
                        <div>
                          <span className="text-muted-foreground">{t("cashSessions.billPayment.billTotal", "Total")}: </span>
                          <span className="font-medium">{formatCashMoney(selectedBill.bill_total, selectedBill.currency)}</span>
                        </div>
                        <div>
                          <span className="text-muted-foreground">{t("cashSessions.billPayment.outstanding", "Outstanding")}: </span>
                          <span className="font-medium text-amber-700">{formatCashMoney(selectedBill.outstanding_balance, selectedBill.currency)}</span>
                        </div>
                      </div>
                    </div>
                  )}
                </div>

                {/* Already-paid warning */}
                {billAlreadyFullyPaid && (
                  <div
                    className="flex items-center gap-2 rounded-md border border-amber-200 bg-amber-50 px-3 py-2.5 text-sm text-amber-800"
                    data-testid="warning-bill-already-paid"
                  >
                    <AlertTriangle className="h-4 w-4 shrink-0 text-amber-600" />
                    {t(
                      "cashSessions.billPayment.alreadyFullyPaid",
                      "This bill has already been fully paid.",
                    )}
                  </div>
                )}

                {/* Payment amount */}
                <div className="space-y-1.5">
                  <Label>{t("cashSessions.billPayment.paymentAmount", "Payment amount")}</Label>
                  <div className="flex gap-2">
                    <Input
                      type="number"
                      min="0"
                      step="0.01"
                      placeholder="0.00"
                      value={billPaymentAmount}
                      onChange={(e) => setBillPaymentAmount(e.target.value)}
                      data-testid="input-bill-payment-amount"
                      disabled={billAlreadyFullyPaid}
                    />
                    <div className="flex h-9 w-24 shrink-0 items-center justify-center rounded-md border bg-muted px-3 text-sm font-medium text-muted-foreground">
                      {selectedBill?.currency ?? documentCurrency}
                    </div>
                  </div>
                  {billPaymentOverBalance && (
                    <p className="text-xs text-red-600" data-testid="error-exceeds-balance">
                      {t("cashSessions.billPayment.exceedsBalance", "Payment exceeds the outstanding balance.")}
                    </p>
                  )}
                  {selectedBill && billPaymentAmount && Number(billPaymentAmount) > 0 && !billPaymentOverBalance && (
                    <p className="text-xs text-muted-foreground">
                      {t("cashSessions.billPayment.remainingAfter", "Remaining balance after payment:")}
                      {" "}
                      <span className="font-semibold">
                        {formatCashMoney(
                          Math.max(0, selectedBill.outstanding_balance - Number(billPaymentAmount)),
                          selectedBill.currency,
                        )}
                      </span>
                    </p>
                  )}
                </div>

                {/* Cash given rows */}
                <div className="space-y-2">
                  <Label className="text-xs text-muted-foreground">
                    {t("cashSessions.paidFromDrawerRows")}
                  </Label>
                  {expensePayments.map((row, idx) => (
                    <CurrencyMovementRow
                      key={row.id}
                      row={row}
                      currencies={currencies}
                      documentCurrency={selectedBill?.currency ?? documentCurrency}
                      sessionRates={sessionRates}
                      onChange={(updated) => updateExpensePaymentRow(row.id, updated)}
                      onRemove={() => removeExpensePaymentRow(row.id)}
                      testIdPrefix={`bill-payment-${idx}`}
                    />
                  ))}
                  <button
                    type="button"
                    className="flex items-center gap-1 text-xs font-medium hover:underline"
                    style={{ color: TEAL_DARK }}
                    onClick={() => setExpensePayments((rows) => [...rows, newRow(selectedBill?.currency ?? defaultCurrency)])}
                    data-testid="button-add-bill-payment"
                  >
                    <Plus className="h-3.5 w-3.5" /> {t("cashSessions.addPayment")}
                  </button>
                </div>

                {/* Change rows */}
                <div className="space-y-2">
                  <Label className="text-xs text-muted-foreground">
                    {t("cashSessions.changeFromSupplier")}
                  </Label>
                  {expenseChange.map((row, idx) => (
                    <CurrencyMovementRow
                      key={row.id}
                      row={row}
                      currencies={currencies}
                      documentCurrency={selectedBill?.currency ?? documentCurrency}
                      sessionRates={sessionRates}
                      onChange={(updated) => updateExpenseChangeRow(row.id, updated)}
                      onRemove={() => removeExpenseChangeRow(row.id)}
                      testIdPrefix={`bill-change-${idx}`}
                    />
                  ))}
                  <button
                    type="button"
                    className="flex items-center gap-1 text-xs font-medium hover:underline"
                    style={{ color: TEAL_DARK }}
                    onClick={() => setExpenseChange((rows) => [...rows, newRow(selectedBill?.currency ?? defaultCurrency)])}
                    data-testid="button-add-bill-change"
                  >
                    <Plus className="h-3.5 w-3.5" /> {t("cashSessions.addChangeFromSupplier")}
                  </button>
                </div>

                <BalanceBadge forCurrency={selectedBill?.currency ?? documentCurrency} />
              </>
            )}
          </>
        )}

        {/* Drawer impact preview (above save button) */}
        <DrawerImpact />

        {/* Receipt attach */}
        <input
          ref={fileRef}
          type="file"
          accept="image/jpeg,image/png,image/webp,application/pdf"
          className="hidden"
          onChange={(e) => setFile(e.target.files?.[0] ?? null)}
        />
        {file ? (
          <div className="flex items-center justify-between gap-2 rounded-md border px-3 py-2 text-sm">
            <span className="flex min-w-0 items-center gap-1.5">
              <Paperclip className="h-3.5 w-3.5 shrink-0" />
              <span className="truncate">{file.name}</span>
            </span>
            <Button
              variant="ghost"
              size="sm"
              className="h-6 w-6 p-0"
              onClick={() => {
                setFile(null);
                if (fileRef.current) fileRef.current.value = "";
              }}
            >
              <X className="h-3.5 w-3.5" />
            </Button>
          </div>
        ) : (
          <button
            type="button"
            onClick={() => fileRef.current?.click()}
            className="flex items-center gap-1.5 text-sm font-medium hover:underline"
            style={{ color: TEAL_DARK }}
            data-testid="button-attach-receipt"
          >
            <Paperclip className="h-3.5 w-3.5" /> {t("cashSessions.attachReceipt")}
          </button>
        )}

        {/* Session-closed guard */}
        {sessionClosed && (
          <div className="rounded-md border border-red-200 bg-red-50 p-3 text-sm" data-testid="session-closed-banner">
            <p className="font-medium text-red-800">{t("cashSessions.sessionClosedEntry")}</p>
            <button
              type="button"
              className="mt-1 text-xs font-medium text-red-700 underline"
              onClick={() => window.location.reload()}
            >
              {t("cashSessions.refreshPage")}
            </button>
          </div>
        )}

        {/* Inline submission error with dismiss + retry */}
        {submitError && !sessionClosed && (
          <div className="flex items-start gap-2 rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-800" data-testid="submit-error-banner">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
            <div className="flex-1">
              <p>{submitError}</p>
              <button
                type="button"
                className="mt-1 text-xs font-medium underline"
                onClick={() => saveMutation.mutate()}
              >
                {t("cashSessions.retry")}
              </button>
            </div>
            <button type="button" onClick={() => setSubmitError(null)} className="shrink-0 text-red-600 hover:text-red-800">
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        )}

        {/* Success confirmation strip OR submit button */}
        {lastSuccess ? (
          <div className="rounded-md border border-emerald-200 bg-emerald-50 p-3 text-sm" data-testid="success-strip">
            <p className="font-medium text-emerald-800">
              {lastSuccess.type === "sale"
                ? t("cashSessions.saleConfirmStrip", {
                    amount: formatCashMoney(lastSuccess.amount, lastSuccess.currency),
                    expected: lastSuccess.expectedCash != null
                      ? formatCashMoney(lastSuccess.expectedCash, lastSuccess.currency)
                      : "—",
                  })
                : lastSuccess.type === "bill_payment"
                  ? t("cashSessions.billPayment.successStrip", {
                      amount: formatCashMoney(lastSuccess.amount, lastSuccess.currency),
                      ref: lastSuccess.billReference ?? "—",
                    })
                  : t("cashSessions.expenseConfirmStrip", {
                      amount: formatCashMoney(lastSuccess.amount, lastSuccess.currency),
                      expected: lastSuccess.expectedCash != null
                        ? formatCashMoney(lastSuccess.expectedCash, lastSuccess.currency)
                        : "—",
                    })}
            </p>
            <button
              type="button"
              className="mt-1 text-xs font-medium underline"
              style={{ color: TEAL_DARK }}
              onClick={() =>
                document
                  .getElementById(`tx-${lastSuccess.transactionId}`)
                  ?.scrollIntoView({ behavior: "smooth", block: "center" })
              }
            >
              {t("cashSessions.viewTransaction")} ↗
            </button>
          </div>
        ) : (
          <>
            {/* Dynamic CTA label */}
            {(() => {
              const isBillPay = tab === "expense" && expenseMode === "bill_payment";
              const rawAmt = tab === "sale"
                ? sale.amount
                : isBillPay
                  ? billPaymentAmount
                  : expense.amount;
              const cur = tab === "sale"
                ? sale.currency
                : isBillPay
                  ? (selectedBill?.currency ?? documentCurrency)
                  : expense.currency;
              const n = parseFloat(rawAmt);
              const isValid = tab === "sale" ? saleValid : expenseValid;

              let ctaLabel: string;
              if (tab === "sale") {
                ctaLabel = Number.isFinite(n) && n > 0
                  ? t("cashSessions.recordCtaSale", { amount: formatCashMoney(n, cur) })
                  : t("cashSessions.saveSale");
              } else if (isBillPay) {
                ctaLabel = t("cashSessions.billPayment.payBillCta", "Pay bill from drawer");
              } else {
                ctaLabel = Number.isFinite(n) && n > 0
                  ? t("cashSessions.recordCtaExpense", { amount: formatCashMoney(n, cur) })
                  : t("cashSessions.saveExpense");
              }

              const summaryEntry = currencySummary.find((c) => c.currency === cur);
              const projectedCash = !isBillPay && summaryEntry != null && Number.isFinite(n) && n > 0
                ? summaryEntry.expected_cash + (tab === "sale" ? n : -n)
                : null;

              // Helper copy below the button
              let helperCopy: string | null = null;
              if (tab === "expense") {
                if (isBillPay) {
                  helperCopy = t("cashSessions.billPayment.helperCopy", {
                    ref: selectedBill?.bill_reference ?? "…",
                    defaultValue: "This records payment against {{ref}} and reduces accounts payable.",
                  });
                } else {
                  helperCopy = t("cashSessions.cashPurchase.helperCopy", "This creates a new expense and records cash leaving the drawer.");
                }
              }

              return (
                <>
                  <Button
                    className="w-full text-white hover:opacity-90"
                    style={{ backgroundColor: TEAL_DARK }}
                    disabled={saveMutation.isPending || sessionClosed || !isValid}
                    onClick={() => saveMutation.mutate()}
                    data-testid="button-save-entry"
                  >
                    {saveMutation.isPending && <Loader2 className="me-1.5 h-4 w-4 animate-spin" />}
                    {ctaLabel}
                  </Button>
                  {projectedCash != null && (
                    <p className="text-center text-xs text-muted-foreground" data-testid="projection-line">
                      {t("cashSessions.projectionLine", {
                        currency: cur,
                        amount: formatCashMoney(projectedCash, cur),
                      })}
                    </p>
                  )}
                  {helperCopy && (
                    <p className="text-center text-xs text-muted-foreground" data-testid="cta-helper-copy">
                      {helperCopy}
                    </p>
                  )}
                </>
              );
            })()}
          </>
        )}
      </CardContent>

      {/* Duplicate payroll confirmation dialog */}
      <Dialog open={duplicatePayrollDialog !== null} onOpenChange={(open) => { if (!open) setDuplicatePayrollDialog(null); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("cashSessions.duplicatePayrollTitle")}</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">
            {t("cashSessions.duplicatePayrollWarning")}
          </p>
          {duplicatePayrollDialog && (
            <div className="rounded-md border bg-muted/40 px-3 py-2 text-sm space-y-1">
              <div className="flex gap-2">
                <span className="text-muted-foreground">{t("cashSessions.payrollEmployee")}:</span>
                <span className="font-medium">{duplicatePayrollDialog.employee_name}</span>
              </div>
              <div className="flex gap-2">
                <span className="text-muted-foreground">{t("cashSessions.payrollPeriod")}:</span>
                <span className="font-medium">{duplicatePayrollDialog.period}</span>
              </div>
              <div className="flex gap-2">
                <span className="text-muted-foreground">{t("cashSessions.payrollPaymentType")}:</span>
                <span className="font-medium">{t(`cashSessions.payrollTypes.${duplicatePayrollDialog.payment_type}`, duplicatePayrollDialog.payment_type)}</span>
              </div>
            </div>
          )}
          <DialogFooter className="flex-col gap-2 sm:flex-row">
            <Button
              variant="outline"
              onClick={() => setDuplicatePayrollDialog(null)}
              data-testid="button-cancel-duplicate"
            >
              {t("cashSessions.close.cancel", "Cancel")}
            </Button>
            <Button
              className="text-white hover:opacity-90"
              style={{ backgroundColor: TEAL_DARK }}
              onClick={() => {
                confirmDuplicateRef.current = true;
                setDuplicatePayrollDialog(null);
                saveMutation.mutate();
              }}
              data-testid="button-confirm-duplicate"
            >
              {t("cashSessions.confirmDuplicate")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}


export function isPayrollCategory(cat: string): boolean {
  return cat === "salaries_wages";
}

// ── Incoming Transfer Card ─────────────────────────────────────────────────

function IncomingTransferCard({
  transfer,
  sessionId,
  currentExpectedCash,
  onConfirm,
  onDispute,
}: {
  transfer: PendingTransfer;
  sessionId: number;
  currentExpectedCash: number | null;
  onConfirm: () => void;
  onDispute: () => void;
}) {
  const { t, i18n } = useTranslation();
  const locale = i18n.language?.startsWith("ar") ? "ar" : undefined;

  const isDisputed = transfer.status === "DISPUTED";
  const sentAmount = Number(transfer.sent_amount);
  const expectedAfter =
    currentExpectedCash != null ? currentExpectedCash + sentAmount : null;

  // Session mismatch guard — the backend may have bound a different session
  const sessionMismatch =
    transfer.destination_session_id != null &&
    transfer.destination_session_id !== sessionId;

  const sourceLabel = [transfer.source_drawer_name, transfer.source_location_name]
    .filter(Boolean)
    .join(" · ");
  const destLabel = [transfer.destination_drawer_name, transfer.destination_location_name]
    .filter(Boolean)
    .join(" · ");

  return (
    <Card
      className="border-2"
      style={{
        borderColor: isDisputed ? "#F97316" : "#0369A1",
        backgroundColor: isDisputed ? "#FFF7ED" : "#EFF6FF",
      }}
    >
      <CardContent className="pt-4">
        {/* Header row */}
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <ArrowRightLeft
              className="h-4 w-4 shrink-0"
              style={{ color: isDisputed ? "#EA580C" : "#0369A1" }}
            />
            <span className="text-sm font-semibold" style={{ color: isDisputed ? "#C2410C" : "#0C4A6E" }}>
              Incoming cash transfer
            </span>
          </div>
          <span
            className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-semibold ${
              isDisputed
                ? "bg-orange-100 text-orange-700"
                : "bg-blue-100 text-blue-700"
            }`}
          >
            {isDisputed && <AlertTriangle className="h-3 w-3" />}
            {isDisputed ? "Disputed" : "In transit"}
          </span>
        </div>

        {/* Route + amount */}
        <div className="mb-3 flex flex-wrap items-center gap-2 text-sm">
          <span className="font-medium">{sourceLabel || "Unknown source"}</span>
          <ArrowRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          <span className="font-medium">{destLabel || "This drawer"}</span>
          <span
            className="ms-1 rounded-md px-2 py-0.5 text-sm font-bold"
            style={{ backgroundColor: isDisputed ? "#FED7AA" : "#BFDBFE", color: isDisputed ? "#9A3412" : "#1E3A5F" }}
          >
            {formatCashMoney(sentAmount, transfer.currency_code)}
          </span>
        </div>

        {/* Metadata grid */}
        <div className="mb-3 grid grid-cols-2 gap-x-4 gap-y-1.5 text-xs sm:grid-cols-3">
          {transfer.handed_over_by_name && (
            <div>
              <span className="block text-muted-foreground">Sent by</span>
              <span className="font-medium">{transfer.handed_over_by_name}</span>
            </div>
          )}
          {transfer.handed_over_at && (
            <div>
              <span className="block text-muted-foreground">Handover time</span>
              <span className="font-medium">
                {new Date(transfer.handed_over_at).toLocaleString(locale)}
              </span>
            </div>
          )}
          {transfer.intended_receiver_name && (
            <div>
              <span className="block text-muted-foreground">Intended receiver</span>
              <span className="font-medium">{transfer.intended_receiver_name}</span>
            </div>
          )}
          {transfer.external_carrier_name && (
            <div>
              <span className="block text-muted-foreground">Carrier</span>
              <span className="font-medium">{transfer.external_carrier_name}</span>
            </div>
          )}
          <div>
            <span className="block text-muted-foreground">Transfer ID</span>
            <span className="font-mono font-medium">{transfer.transfer_number}</span>
          </div>
        </div>

        {/* Dispute reason */}
        {isDisputed && transfer.dispute_reason && (
          <div className="mb-3 rounded-md border border-orange-200 bg-orange-50 px-3 py-2 text-xs text-orange-800">
            <span className="font-semibold">Dispute note: </span>
            {transfer.dispute_reason}
          </div>
        )}

        {/* Session mismatch warning */}
        {sessionMismatch && (
          <div className="mb-3 flex items-start gap-2 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <span>
              This transfer is bound to a different session. Navigate to the correct open session
              before confirming receipt.
            </span>
          </div>
        )}

        {/* Helper + CTAs */}
        {!sessionMismatch && (
          <>
            {expectedAfter != null && (
              <p className="mb-3 text-xs text-muted-foreground">
                Expected {transfer.currency_code} cash will become{" "}
                <span className="font-semibold">{formatCashMoney(expectedAfter, transfer.currency_code)}</span>{" "}
                after confirmation.
              </p>
            )}
            <div className="flex flex-wrap gap-2">
              <Button
                size="sm"
                style={{ backgroundColor: "#0369A1" }}
                className="text-white hover:opacity-90"
                onClick={onConfirm}
              >
                Confirm {transfer.currency_code} {formatCashMoney(sentAmount, transfer.currency_code)} received
              </Button>
              <Button
                size="sm"
                variant="outline"
                style={{ borderColor: isDisputed ? "#F97316" : "#0369A1", color: isDisputed ? "#EA580C" : "#0369A1" }}
                onClick={onDispute}
              >
                {isDisputed ? "Update dispute" : "Report a difference"}
              </Button>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}

// ── Outgoing Transfer Card (source session) ────────────────────────────────

function OutgoingTransferCard({
  transfer,
  onView,
}: {
  transfer: {
    id: number;
    transfer_number: string;
    status: string;
    currency: string;
    amount: string;
    destination_location_name: string | null;
    destination_drawer_name: string | null;
  };
  onView: () => void;
}) {
  const destLabel = [transfer.destination_drawer_name, transfer.destination_location_name]
    .filter(Boolean)
    .join(" · ");

  return (
    <Card className="border-2" style={{ borderColor: "#0369A1", backgroundColor: "#EFF6FF" }}>
      <CardContent className="pt-4">
        {/* Header */}
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <ArrowRightLeft className="h-4 w-4 shrink-0" style={{ color: "#0369A1" }} />
            <span className="text-sm font-semibold" style={{ color: "#0C4A6E" }}>
              Cash transfer in progress
            </span>
          </div>
          <span className="inline-flex items-center gap-1 rounded-full bg-blue-100 px-2 py-0.5 text-xs font-semibold text-blue-700">
            <Clock className="h-3 w-3" /> In transit
          </span>
        </div>

        {/* Route + amount */}
        <div className="mb-3 flex flex-wrap items-center gap-2 text-sm">
          <span className="font-medium">This drawer</span>
          <ArrowRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          <span className="font-medium">{destLabel || "Unknown destination"}</span>
          <span
            className="ms-1 rounded-md px-2 py-0.5 text-sm font-bold"
            style={{ backgroundColor: "#BFDBFE", color: "#1E3A5F" }}
          >
            {formatCashMoney(Number(transfer.amount), transfer.currency)}
          </span>
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between gap-2">
          <span className="text-xs text-muted-foreground">#{transfer.transfer_number}</span>
          <Button
            size="sm"
            variant="outline"
            style={{ borderColor: "#0369A1", color: "#0369A1" }}
            className="gap-1.5 hover:opacity-90"
            onClick={onView}
          >
            <ExternalLink className="h-3.5 w-3.5" /> View transfer
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

// ── Confirm Transfer Receipt Modal ─────────────────────────────────────────

function ConfirmTransferReceiptModal({
  transfer,
  open,
  onClose,
  onSuccess,
}: {
  transfer: PendingTransfer;
  open: boolean;
  onClose: () => void;
  onSuccess: () => void;
}) {
  const { toast } = useToast();
  const [confirmed, setConfirmed] = useState(false);
  const [alreadyConfirmedError, setAlreadyConfirmedError] = useState(false);

  const { i18n } = useTranslation();
  const locale = i18n.language?.startsWith("ar") ? "ar" : undefined;

  const sentAmount = Number(transfer.sent_amount);
  const sourceLabel = [transfer.source_drawer_name, transfer.source_location_name]
    .filter(Boolean)
    .join(" · ");
  const destLabel = [transfer.destination_drawer_name, transfer.destination_location_name]
    .filter(Boolean)
    .join(" · ");

  // The API always books sent_amount — no amount override accepted.
  const mutation = useMutation({
    mutationFn: () =>
      apiFetch(`/api/cash-transfers/${transfer.id}/confirm-receipt`, {
        method: "POST",
        body: "{}",
      }),
    onSuccess: () => {
      toast({ title: "Transfer receipt confirmed" });
      onSuccess();
    },
    onError: (err: Error & { status?: number }) => {
      if (err.status === 409) {
        setAlreadyConfirmedError(true);
      } else {
        toast({ title: err.message || "Failed to confirm receipt", variant: "destructive" });
      }
    },
  });

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v) onClose(); }}>
      <DialogContent className="max-w-md" aria-labelledby="confirm-receipt-title">
        <DialogHeader>
          <DialogTitle id="confirm-receipt-title">Confirm Cash Receipt</DialogTitle>
        </DialogHeader>

        {alreadyConfirmedError ? (
          <div className="space-y-4">
            <div className="flex items-start gap-2 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
              <span>This transfer has already been confirmed by another user.</span>
            </div>
            <DialogFooter>
              <Button onClick={onClose}>Close</Button>
            </DialogFooter>
          </div>
        ) : (
          <div className="space-y-4">
            {/* Transfer context */}
            <div className="rounded-md border bg-muted/30 px-3 py-2.5 text-sm space-y-1.5">
              <div className="flex items-center justify-between gap-2">
                <span className="text-muted-foreground">Transfer ID</span>
                <span className="font-mono font-medium">{transfer.transfer_number}</span>
              </div>
              <div className="flex items-center justify-between gap-2">
                <span className="text-muted-foreground">From</span>
                <span className="font-medium">{sourceLabel || "—"}</span>
              </div>
              <div className="flex items-center justify-between gap-2">
                <span className="text-muted-foreground">To</span>
                <span className="font-medium">{destLabel || "—"}</span>
              </div>
              <div className="flex items-center justify-between gap-2">
                <span className="text-muted-foreground">Sent by</span>
                <span className="font-medium">{transfer.handed_over_by_name ?? "—"}</span>
              </div>
              {transfer.external_carrier_name && (
                <div className="flex items-center justify-between gap-2">
                  <span className="text-muted-foreground">Carrier</span>
                  <span className="font-medium">{transfer.external_carrier_name}</span>
                </div>
              )}
              {transfer.handed_over_at && (
                <div className="flex items-center justify-between gap-2">
                  <span className="text-muted-foreground">Handover time</span>
                  <span className="font-medium">{new Date(transfer.handed_over_at).toLocaleString(locale)}</span>
                </div>
              )}
              <div className="flex items-center justify-between gap-2 border-t pt-1.5">
                <span className="text-muted-foreground">Amount to receive</span>
                <span
                  className="rounded-md px-2 py-0.5 font-semibold tabular-nums"
                  style={{ backgroundColor: "#BFDBFE", color: "#1E3A5F" }}
                >
                  {formatCashMoney(sentAmount, transfer.currency_code)}
                </span>
              </div>
            </div>

            {/* Confirmation checkbox */}
            <label className="flex items-start gap-2.5 text-sm cursor-pointer">
              <Checkbox
                checked={confirmed}
                onCheckedChange={(v) => setConfirmed(v === true)}
                id="confirm-counted-checkbox"
                aria-required="true"
              />
              <span>
                I confirm the cash has been physically counted and the amount matches the transfer.
              </span>
            </label>

            <p className="text-xs text-muted-foreground">
              If you counted a different amount, use <strong>Report a difference</strong> instead.
            </p>

            <DialogFooter>
              <Button variant="outline" onClick={onClose}>Cancel</Button>
              <Button
                disabled={!confirmed || mutation.isPending}
                onClick={() => mutation.mutate()}
                style={{ backgroundColor: "#0369A1" }}
                className="text-white hover:opacity-90"
              >
                {mutation.isPending && <Loader2 className="me-1.5 h-4 w-4 animate-spin" />}
                Confirm {transfer.currency_code} {formatCashMoney(sentAmount, transfer.currency_code)} received
              </Button>
            </DialogFooter>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

// ── Report Difference Modal ────────────────────────────────────────────────

function ReportTransferDifferenceModal({
  transfer,
  open,
  onClose,
  onSuccess,
}: {
  transfer: PendingTransfer;
  open: boolean;
  onClose: () => void;
  onSuccess: () => void;
}) {
  const { toast } = useToast();
  const [actualAmount, setActualAmount] = useState(transfer.sent_amount);
  const [explanation, setExplanation] = useState("");

  const { i18n } = useTranslation();
  const locale = i18n.language?.startsWith("ar") ? "ar" : undefined;

  const sentAmount = Number(transfer.sent_amount);
  const actualNum = parseFloat(actualAmount) || 0;
  const difference = actualNum - sentAmount;
  const sourceLabel = [transfer.source_drawer_name, transfer.source_location_name]
    .filter(Boolean)
    .join(" · ");

  const mutation = useMutation({
    mutationFn: () =>
      apiFetch(`/api/cash-transfers/${transfer.id}/report-difference`, {
        method: "POST",
        body: JSON.stringify({
          actual_received_amount: actualNum,
          explanation: explanation.trim(),
        }),
      }),
    onSuccess: () => {
      toast({ title: "Difference reported. A supervisor will review the dispute." });
      onSuccess();
    },
    onError: (err: Error) =>
      toast({ title: err.message || "Failed to report difference", variant: "destructive" }),
  });

  const isValid = actualNum > 0 && explanation.trim().length > 0;

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v) onClose(); }}>
      <DialogContent className="max-w-md" aria-labelledby="report-diff-title">
        <DialogHeader>
          <DialogTitle id="report-diff-title">Report a Difference</DialogTitle>
        </DialogHeader>

        <div className="space-y-4">
          {/* Transfer context summary */}
          <div className="rounded-md border bg-muted/30 px-3 py-2.5 text-sm space-y-1.5">
            <div className="flex items-center justify-between gap-2">
              <span className="text-muted-foreground">Transfer ID</span>
              <span className="font-mono font-medium">{transfer.transfer_number}</span>
            </div>
            <div className="flex items-center justify-between gap-2">
              <span className="text-muted-foreground">From</span>
              <span className="font-medium">{sourceLabel || "—"}</span>
            </div>
            {transfer.handed_over_at && (
              <div className="flex items-center justify-between gap-2">
                <span className="text-muted-foreground">Handover time</span>
                <span className="font-medium">{new Date(transfer.handed_over_at).toLocaleString(locale)}</span>
              </div>
            )}
            <div className="flex items-center justify-between gap-2 border-t pt-1.5">
              <span className="text-muted-foreground">Amount sent</span>
              <span className="font-semibold">{formatCashMoney(sentAmount, transfer.currency_code)}</span>
            </div>
          </div>

          {/* Actual amount received */}
          <div className="space-y-1.5">
            <Label htmlFor="actual-diff-amount">
              Actual amount received ({transfer.currency_code})
            </Label>
            <Input
              id="actual-diff-amount"
              type="number"
              min="0"
              step="0.01"
              value={actualAmount}
              onChange={(e) => setActualAmount(e.target.value)}
              autoFocus
            />
          </div>

          {/* Difference display */}
          {actualNum > 0 && (
            <div
              className={`flex items-center justify-between rounded-md border px-3 py-2 text-sm font-semibold ${
                difference === 0
                  ? "border-emerald-200 bg-emerald-50 text-emerald-700"
                  : difference < 0
                    ? "border-red-200 bg-red-50 text-red-700"
                    : "border-amber-200 bg-amber-50 text-amber-700"
              }`}
            >
              <span>Difference</span>
              <span>
                {difference >= 0 ? "+" : ""}
                {formatCashMoney(difference, transfer.currency_code)}
              </span>
            </div>
          )}

          {/* Explanation */}
          <div className="space-y-1.5">
            <Label htmlFor="diff-explanation" className="flex items-center gap-1">
              Explanation
              <span className="text-xs font-normal text-muted-foreground">(required)</span>
            </Label>
            <Textarea
              id="diff-explanation"
              aria-required="true"
              value={explanation}
              onChange={(e) => setExplanation(e.target.value)}
              rows={3}
              placeholder="Describe what you counted and any observations about the discrepancy…"
            />
          </div>

          <p className="text-xs text-muted-foreground">
            A supervisor will be notified and will resolve the dispute. The transfer will remain
            pending until resolved.
          </p>

          <DialogFooter>
            <Button variant="outline" onClick={onClose}>Cancel</Button>
            <Button
              disabled={!isValid || mutation.isPending}
              onClick={() => mutation.mutate()}
              variant="destructive"
            >
              {mutation.isPending && <Loader2 className="me-1.5 h-4 w-4 animate-spin" />}
              Report difference
            </Button>
          </DialogFooter>
        </div>
      </DialogContent>
    </Dialog>
  );
}

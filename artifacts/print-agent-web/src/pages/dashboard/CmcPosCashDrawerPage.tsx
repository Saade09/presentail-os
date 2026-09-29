import { useState, useEffect } from "react";
import { Link, useLocation } from "wouter";
import {
  AlertTriangle, ArrowLeft, CheckCircle2, CreditCard, DollarSign,
  Loader2, Plus, Send, X, ArrowLeftRight, Lock,
} from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from "@/components/ui/dialog";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { apiFetch } from "@/lib/queryClient";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "@/hooks/use-toast";
import { formatUsd } from "./cmc-pos/cmcPosDashboard.helpers";
import { useWorkspaceRole } from "@/hooks/use-workspace-role";

// ── Types ──────────────────────────────────────────────────────────────────

type ActiveShift = {
  id: number;
  location_id: number;
  location_name: string;
  location_timezone: string;
  opened_at: string;
  opening_cash?: string;
  cash_session_id?: number | null;
};

type CurrencySummary = {
  currency: string;
  opening_cash: number;
  sales_collected: number;
  expenses_paid: number;
  adjustments: number;
  expected_cash: number;
};

type DrawerStatus = {
  session: {
    id: number;
    status: string;
    currency: string;
    secondary_currency: string | null;
    opening_cash: string;
    opened_at: string;
    closed_at: string | null;
    reconciliation: unknown;
    location_name: string | null;
  } | null;
  currency_summary: CurrencySummary[];
  cash_sales_total: number;
  expected_balance: number;
  cash_refunds_total: number;
  cash_refunds_count: number;
  /** Previous closed session's cash_kept — shown in StartShiftPanel as reference */
  previous_closing_balance: number | null;
  previous_location_name: string | null;
};

type TxRow = {
  id: number;
  type: string;
  direction: string;
  amount: string;
  currency: string;
  description: string | null;
  reference_type: string | null;
  reference_id: string | null;
  is_reversed: boolean;
  reversal_of_id: number | null;
  entered_by_name: string | null;
  transaction_date: string;
  status: string | null;
  note: string | null;
  sale_channel: string | null;
};

type TxResponse = {
  transactions: TxRow[];
  total: number;
  page: number;
  pages: number;
};

type Location = { id: number; name: string; currency: string; secondary_currency: string | null };

// ── Helpers ────────────────────────────────────────────────────────────────

function fmtCurrency(amount: number, currency?: string): string {
  if (!currency || currency === "USD") return formatUsd(amount);
  if (currency === "LBP") return `${Math.round(amount).toLocaleString()} L.L.`;
  return `${currency} ${amount.toFixed(2)}`;
}

function fmtDate(iso: string): string {
  return new Date(iso).toLocaleString([], { dateStyle: "medium", timeStyle: "short" });
}

function txTypeLabel(type: string, direction: string): string {
  const labels: Record<string, string> = {
    cash_sale: "Cash Sale",
    cash_sale_reversal: "Sale Reversal",
    adjustment: direction === "in" ? "Cash In" : "Cash Out",
    transfer_out: "Transfer Out",
    transfer_in: "Transfer In",
    expense: "Expense",
  };
  return labels[type] ?? type.replace(/_/g, " ");
}

function txDirectionColor(type: string, direction: string): string {
  if (type === "cash_sale_reversal" || (type === "adjustment" && direction === "out") || type === "transfer_out" || type === "expense") {
    return "text-red-600";
  }
  return "text-emerald-600";
}

// ── Sub-components ─────────────────────────────────────────────────────────

function InfoRow({ label, value, bold, highlight }: {
  label: string; value: string; bold?: boolean; highlight?: "warning" | "ok" | "error";
}) {
  const textClass =
    highlight === "warning" ? "text-amber-700 font-semibold" :
    highlight === "ok" ? "text-emerald-700 font-semibold" :
    highlight === "error" ? "text-red-700 font-semibold" :
    bold ? "font-bold text-gray-900" : "text-gray-700";
  return (
    <div className="flex items-baseline justify-between gap-3 py-1.5 border-b border-gray-100 last:border-0">
      <span className="text-xs text-gray-500">{label}</span>
      <span className={`text-sm tabular-nums ${textClass}`}>{value}</span>
    </div>
  );
}

// ── Record Cash In Dialog ──────────────────────────────────────────────────

function RecordCashInDialog({
  currency,
  open,
  onClose,
}: {
  currency: string;
  open: boolean;
  onClose: () => void;
}) {
  const [amount, setAmount] = useState("");
  const [description, setDescription] = useState("");
  const qc = useQueryClient();

  const mutation = useMutation({
    mutationFn: () =>
      apiFetch("/api/cmc-pos/cash-drawer/adjustment", {
        method: "POST",
        body: JSON.stringify({
          amount: Number(amount),
          direction: "in",
          description: description.trim() || "Manual cash in",
          currency,
        }),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["cmc-pos-cash-drawer"] });
      qc.invalidateQueries({ queryKey: ["cmc-pos-cash-drawer-transactions"] });
      toast({ title: "Cash recorded successfully" });
      setAmount("");
      setDescription("");
      onClose();
    },
    onError: (err: Error) => {
      toast({ title: err.message || "Failed to record cash", variant: "destructive" });
    },
  });

  const valid = amount !== "" && Number(amount) > 0;

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Plus className="h-4 w-4" /> Record Cash In
          </DialogTitle>
        </DialogHeader>
        <div className="space-y-4 py-2">
          <div className="space-y-1.5">
            <Label>Amount ({currency})</Label>
            <Input
              type="number"
              min="0.01"
              step="0.01"
              placeholder="0.00"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              autoFocus
            />
          </div>
          <div className="space-y-1.5">
            <Label>Note (optional)</Label>
            <Textarea
              rows={2}
              placeholder="Reason or source of cash…"
              value={description}
              className="resize-none"
              onChange={(e) => setDescription(e.target.value)}
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={mutation.isPending}>
            Cancel
          </Button>
          <Button
            disabled={!valid || mutation.isPending}
            onClick={() => mutation.mutate()}
            style={{ background: "#00414e" }}
          >
            {mutation.isPending && <Loader2 className="h-4 w-4 animate-spin mr-1" />}
            Record Cash In
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ── Send Cash Dialog ───────────────────────────────────────────────────────

function SendCashDialog({
  locationId,
  currency,
  expectedBalance,
  open,
  onClose,
}: {
  locationId: number;
  currency: string;
  expectedBalance: number;
  open: boolean;
  onClose: () => void;
}) {
  const [amount, setAmount] = useState("");
  const [destLocationId, setDestLocationId] = useState("");
  const [note, setNote] = useState("");
  const qc = useQueryClient();

  const { data: locData } = useQuery<{ locations: Location[] }>({
    queryKey: ["locations"],
    queryFn: () => apiFetch("/api/locations"),
    staleTime: 60_000,
  });
  const locations = (locData?.locations ?? []).filter((l) => l.id !== locationId);

  const mutation = useMutation({
    mutationFn: () =>
      apiFetch("/api/cmc-pos/cash-drawer/transfer", {
        method: "POST",
        body: JSON.stringify({
          amount: Number(amount),
          destination_location_id: Number(destLocationId),
          source_location_id: locationId,
          note: note.trim() || null,
        }),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["cmc-pos-cash-drawer"] });
      qc.invalidateQueries({ queryKey: ["cmc-pos-cash-drawer-transactions"] });
      toast({ title: "Transfer initiated successfully" });
      setAmount("");
      setDestLocationId("");
      setNote("");
      onClose();
    },
    onError: (err: Error) => {
      toast({ title: err.message || "Failed to initiate transfer", variant: "destructive" });
    },
  });

  const amtNum = Number(amount) || 0;
  const overBalance = amtNum > expectedBalance;
  const valid = amtNum > 0 && !!destLocationId && !overBalance;

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <ArrowLeftRight className="h-4 w-4" /> Send Cash
          </DialogTitle>
        </DialogHeader>
        <div className="space-y-4 py-2">
          <div className="rounded-lg bg-gray-50 border border-gray-200 px-4 py-3">
            <InfoRow label="Available Balance" value={fmtCurrency(expectedBalance, currency)} bold />
          </div>
          <div className="space-y-1.5">
            <Label>Amount to Send ({currency})</Label>
            <Input
              type="number"
              min="0.01"
              step="0.01"
              placeholder="0.00"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              autoFocus
            />
            {overBalance && (
              <p className="text-xs text-red-600 flex items-center gap-1">
                <AlertTriangle className="h-3 w-3" />
                Amount exceeds available balance
              </p>
            )}
          </div>
          <div className="space-y-1.5">
            <Label>Destination Location <span className="text-red-500">*</span></Label>
            <Select value={destLocationId} onValueChange={setDestLocationId}>
              <SelectTrigger>
                <SelectValue placeholder="Select destination…" />
              </SelectTrigger>
              <SelectContent>
                {locations.map((l) => (
                  <SelectItem key={l.id} value={String(l.id)}>{l.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label>Note (optional)</Label>
            <Textarea
              rows={2}
              placeholder="Transfer reason…"
              value={note}
              className="resize-none"
              onChange={(e) => setNote(e.target.value)}
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={mutation.isPending}>
            Cancel
          </Button>
          <Button
            disabled={!valid || mutation.isPending}
            onClick={() => mutation.mutate()}
            className="bg-gray-900 hover:bg-gray-800 text-white"
          >
            {mutation.isPending && <Loader2 className="h-4 w-4 animate-spin mr-1" />}
            Send Cash
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ── Transaction Row ────────────────────────────────────────────────────────

function TxRow({ tx }: { tx: TxRow }) {
  const amtNum = Number(tx.amount);
  const isOut = tx.direction === "out" || tx.type === "transfer_out" || tx.type === "expense";
  const colorClass = tx.is_reversed
    ? "text-gray-400 line-through"
    : txDirectionColor(tx.type, tx.direction);

  return (
    <div className="px-4 py-3 flex flex-wrap items-start justify-between gap-2 border-b border-gray-100 last:border-0 hover:bg-gray-50/50">
      <div className="space-y-0.5 min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-sm font-medium text-gray-800">
            {txTypeLabel(tx.type, tx.direction)}
          </span>
          {tx.is_reversed && (
            <span className="text-[10px] font-medium rounded-full px-1.5 py-0.5 bg-gray-100 text-gray-500">
              Reversed
            </span>
          )}
          {tx.reference_id && tx.reference_type === "cmc_sale" && (
            <span className="text-[10px] text-gray-400 font-mono">#{tx.reference_id}</span>
          )}
        </div>
        {tx.sale_channel && (
          <p className="text-xs text-muted-foreground">
            {tx.sale_channel === "walk_in" ? "Walk-in"
              : tx.sale_channel === "whatsapp" ? "WhatsApp"
              : tx.sale_channel === "website" ? "Website"
              : tx.sale_channel === "phone_order" ? "Phone order"
              : tx.sale_channel === "toters" ? "Toters"
              : tx.sale_channel === "deliveroo" ? "Deliveroo"
              : tx.sale_channel === "careem" ? "Careem"
              : tx.sale_channel === "talabat" ? "Talabat"
              : tx.sale_channel === "other" ? "Other"
              : tx.sale_channel}
          </p>
        )}
        {tx.description && (
          <p className="text-xs text-gray-500 truncate max-w-xs">{tx.description}</p>
        )}
        <p className="text-xs text-gray-400">
          {fmtDate(tx.transaction_date)}
          {tx.entered_by_name && ` · ${tx.entered_by_name}`}
        </p>
      </div>
      <div className="text-right shrink-0">
        <span className={`text-sm font-semibold tabular-nums ${colorClass}`}>
          {isOut ? "−" : "+"}{fmtCurrency(amtNum, tx.currency)}
        </span>
      </div>
    </div>
  );
}

// ── Transactions Table ─────────────────────────────────────────────────────

function TransactionsTable({ sessionId, wsId }: { sessionId: number; wsId?: string }) {
  const { data, isLoading } = useQuery<TxResponse>({
    queryKey: ["cmc-pos-cash-drawer-transactions", sessionId],
    queryFn: () => apiFetch(`/api/cmc-pos/cash-drawer/transactions?session_id=${sessionId}`),
    staleTime: 30_000,
    refetchInterval: 60_000,
  });

  const txs = data?.transactions ?? [];

  if (isLoading) {
    return (
      <div className="px-4 py-3 space-y-2">
        {[1, 2, 3].map((i) => <Skeleton key={i} className="h-12 w-full" />)}
      </div>
    );
  }

  if (txs.length === 0) {
    return (
      <div className="px-4 py-8 text-center text-sm text-gray-400">
        No transactions yet this shift
      </div>
    );
  }

  return (
    <div>
      {txs.map((tx) => <TxRow key={tx.id} tx={tx} />)}
      {(data?.total ?? 0) > txs.length && (
        <p className="px-4 py-2 text-xs text-gray-400 text-center">
          Showing {txs.length} of {data?.total} transactions
        </p>
      )}
    </div>
  );
}

// ── Start Shift Panel ──────────────────────────────────────────────────────

function StartShiftPanel({
  previousClosingBalance,
  previousLocationName,
  onSuccess,
}: {
  previousClosingBalance: number | null;
  previousLocationName: string | null;
  onSuccess: () => void;
}) {
  const [openingCash, setOpeningCash] = useState("0");
  const [selectedCurrency, setSelectedCurrency] = useState<string>("");
  const qc = useQueryClient();

  // Fetch only locations that have an active CMC cash drawer — typically just
  // one (CMC Beirut Hospital). Auto-select it; no dropdown shown.
  const { data: locData, isLoading: locLoading } = useQuery<{ locations: Location[] }>({
    queryKey: ["cmc-pos-locations"],
    queryFn: () => apiFetch("/api/cmc-pos/locations"),
    staleTime: 300_000,
  });
  const cmcLocations = locData?.locations ?? [];
  const autoLocation = cmcLocations.length === 1 ? cmcLocations[0] : null;
  const locationId = autoLocation ? String(autoLocation.id) : "";
  const isDualCurrency = !!(autoLocation?.secondary_currency);

  // Auto-set currency when location resolves (single-currency: set it immediately;
  // dual-currency: leave empty so the user must pick)
  useEffect(() => {
    if (autoLocation && !isDualCurrency && !selectedCurrency) {
      setSelectedCurrency(autoLocation.currency);
    }
  }, [autoLocation, isDualCurrency, selectedCurrency]);

  const openingNum = Number(openingCash) || 0;
  // Integer-cent comparison to avoid floating-point rounding noise
  const diffCents =
    previousClosingBalance !== null
      ? Math.round(openingNum * 100) - Math.round(previousClosingBalance * 100)
      : null;

  const mutation = useMutation({
    mutationFn: () =>
      apiFetch("/api/cmc-pos/shifts", {
        method: "POST",
        body: JSON.stringify({
          location_id: Number(locationId),
          opening_cash: openingNum,
          currency: selectedCurrency || undefined,
        }),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["cmc-pos-active-shift"] });
      qc.invalidateQueries({ queryKey: ["cmc-pos-cash-drawer"] });
      qc.invalidateQueries({ queryKey: ["cmc-pos-cash-drawer-transactions"] });
      qc.invalidateQueries({ queryKey: ["cmc-pos-metrics"] });
      qc.invalidateQueries({ queryKey: ["cmc-pos-shifts"] });
      qc.invalidateQueries({ queryKey: ["cash-drawers-dialog"] });
      onSuccess();
    },
    onError: (err: Error) => {
      const code = (err as Error & { code?: string }).code;
      const msg = err.message || "Failed to start shift";
      if (msg.includes("already have an open shift") || code === "DUPLICATE_USER_SHIFT") {
        toast({ title: "You already have an open shift", variant: "destructive" });
        qc.invalidateQueries({ queryKey: ["cmc-pos-active-shift"] });
      } else if (code === "NO_ACTIVE_DRAWER") {
        toast({
          title: "No cash drawer at this location",
          description: "Ask a manager to set up an active cash drawer before starting a shift here.",
          variant: "destructive",
        });
      } else {
        toast({ title: msg, variant: "destructive" });
      }
    },
  });

  const valid = !!locationId && openingCash !== "" && openingNum >= 0 && !!selectedCurrency;

  return (
    <div className="rounded-xl border border-gray-200 bg-white shadow-sm overflow-hidden max-w-md mx-auto">
      <div className="px-5 py-4 border-b border-gray-100 bg-gray-50 flex items-center gap-2">
        <DollarSign className="h-4 w-4" style={{ color: "#00414e" }} />
        <h2 className="text-sm font-semibold text-gray-900">Start Shift — Open Cash Drawer</h2>
      </div>
      <div className="px-5 py-5 space-y-4">
        <p className="text-sm text-gray-500">
          Enter the opening cash to begin your shift.
        </p>

        {/* Location — read-only badge; auto-selected from active CMC drawers */}
        <div className="flex items-center gap-2 rounded-lg bg-gray-50 border border-gray-200 px-3 py-2">
          <CreditCard className="h-3.5 w-3.5 text-gray-400 shrink-0" />
          {locLoading ? (
            <span className="text-xs text-gray-400">Loading location…</span>
          ) : autoLocation ? (
            <span className="text-xs font-medium text-gray-700">{autoLocation.name}</span>
          ) : (
            <span className="text-xs text-red-500">No CMC cash drawer location found — contact a manager.</span>
          )}
        </div>

        {/* Currency picker — shown only for dual-currency drawers */}
        {isDualCurrency && autoLocation && (
          <div className="space-y-2">
            <Label className="text-xs font-semibold">Transaction Currency <span className="text-red-500">*</span></Label>
            <p className="text-xs text-gray-400">
              This drawer accepts {autoLocation.currency} and {autoLocation.secondary_currency}. Choose one for this shift.
            </p>
            <div className="flex gap-3">
              {[autoLocation.currency, autoLocation.secondary_currency!].map((cur) => (
                <label
                  key={cur}
                  className={`flex flex-1 cursor-pointer items-center justify-center gap-2 rounded-lg border px-3 py-2.5 text-sm font-medium transition ${
                    selectedCurrency === cur
                      ? "border-teal-600 bg-teal-50 text-teal-700 ring-1 ring-teal-500"
                      : "border-gray-200 text-gray-600 hover:border-teal-300"
                  }`}
                >
                  <input
                    type="radio"
                    name="shift-currency"
                    className="sr-only"
                    value={cur}
                    checked={selectedCurrency === cur}
                    onChange={() => setSelectedCurrency(cur)}
                  />
                  {cur}
                </label>
              ))}
            </div>
          </div>
        )}

        {/* Previous session carry-forward reference */}
        {previousClosingBalance !== null && (
          <div className="rounded-lg bg-blue-50 border border-blue-200 px-3 py-2.5 space-y-0.5">
            <p className="text-xs text-blue-700 font-medium">
              Previous shift left{previousLocationName ? ` at ${previousLocationName}` : ""}
            </p>
            <p className="text-sm font-bold tabular-nums text-blue-900">
              ${previousClosingBalance.toFixed(2)}
            </p>
            {diffCents !== null && Math.abs(diffCents) >= 1 && (
              <p className={`text-xs font-medium ${diffCents > 0 ? "text-emerald-700" : "text-amber-700"}`}>
                {diffCents > 0 ? "+" : ""}${(diffCents / 100).toFixed(2)} vs. previous closing balance
              </p>
            )}
          </div>
        )}

        <div className="space-y-1.5">
          <Label className="text-xs">Opening Cash (physical count)</Label>
          <div className="relative">
            <span className="absolute left-3 top-1/2 -translate-y-1/2 text-xs text-gray-400">$</span>
            <Input
              type="number"
              min="0"
              step="0.01"
              className="pl-6 h-9 text-sm"
              placeholder="0.00"
              value={openingCash}
              onChange={(e) => setOpeningCash(e.target.value)}
            />
          </div>
          <p className="text-xs text-gray-400">Amount of cash physically in the drawer right now</p>
        </div>

        <Button
          className="w-full"
          style={{ background: "#00414e" }}
          disabled={!valid || mutation.isPending || locLoading}
          onClick={() => mutation.mutate()}
        >
          {mutation.isPending && <Loader2 className="h-4 w-4 animate-spin mr-1" />}
          Start Shift & Open Drawer
        </Button>
      </div>
    </div>
  );
}

// ── Close Shift Panel ──────────────────────────────────────────────────────

function CloseShiftPanel({
  locationId,
  expectedBalance,
  cashSalesTotal,
  openingCash,
  currency,
  onSuccess,
  onCancel,
}: {
  locationId: number;
  expectedBalance: number;
  cashSalesTotal: number;
  openingCash: number;
  currency: string;
  onSuccess: () => void;
  onCancel: () => void;
}) {
  const [cashKept, setCashKept] = useState(expectedBalance.toFixed(2));
  const [cashTransferred, setCashTransferred] = useState("0");
  const [destLocationId, setDestLocationId] = useState("");
  const [discrepancyNote, setDiscrepancyNote] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const qc = useQueryClient();

  // Use integer-cent arithmetic throughout to avoid floating-point drift.
  const keptCents = Math.round((parseFloat(cashKept) || 0) * 100);
  const transferredCents = Math.round((parseFloat(cashTransferred) || 0) * 100);
  const expectedCents = Math.round(expectedBalance * 100);
  const kept = keptCents / 100;
  const transferred = transferredCents / 100;
  const totalOut = (keptCents + transferredCents) / 100;
  const discrepancyCents = keptCents + transferredCents - expectedCents;
  const discrepancy = discrepancyCents / 100;
  const hasDiscrepancy = Math.abs(discrepancyCents) >= 1; // ≥ 1 cent
  const showTransfer = transferredCents > 0;

  const { data: locData } = useQuery<{ locations: Location[] }>({
    queryKey: ["locations"],
    queryFn: () => apiFetch("/api/locations"),
    staleTime: 60_000,
  });
  const locations = (locData?.locations ?? []).filter((l) => l.id !== locationId);

  const mutation = useMutation({
    mutationFn: () =>
      apiFetch<{ drawerless?: boolean }>("/api/cmc-pos/shifts/close", {
        method: "POST",
        body: JSON.stringify({
          cash_kept: kept,
          cash_transferred: transferred,
          destination_location_id: destLocationId ? Number(destLocationId) : null,
          discrepancy_note: discrepancyNote.trim() || null,
          location_id: locationId || undefined,
        }),
      }),
    onSuccess: (data) => {
      qc.invalidateQueries({ queryKey: ["cmc-pos-active-shift"] });
      qc.invalidateQueries({ queryKey: ["cmc-pos-cash-drawer"] });
      qc.invalidateQueries({ queryKey: ["cmc-pos-cash-drawer-transactions"] });
      qc.invalidateQueries({ queryKey: ["cmc-pos-metrics"] });
      qc.invalidateQueries({ queryKey: ["cmc-pos-shifts"] });
      qc.invalidateQueries({ queryKey: ["cash-drawers-dialog"] });
      toast({
        title: "Shift closed successfully",
        ...(data?.drawerless
          ? { description: "No cash session was linked, so cash reconciliation was skipped." }
          : {}),
      });
      onSuccess();
    },
    onError: (err: Error) => {
      toast({ title: err.message || "Failed to close shift", variant: "destructive" });
    },
  });

  const valid =
    cashKept !== "" &&
    kept >= 0 &&
    (!showTransfer || !!destLocationId) &&
    (!hasDiscrepancy || discrepancyNote.trim().length > 0) &&
    confirmed;

  return (
    <div className="rounded-xl border border-amber-200 bg-white shadow-sm overflow-hidden">
      <div className="px-5 py-4 border-b border-amber-100 bg-amber-50 flex items-center gap-2">
        <Lock className="h-4 w-4 text-amber-700" />
        <h2 className="text-sm font-semibold text-amber-900">Close Shift — Reconciliation</h2>
      </div>
      <div className="px-5 py-5 space-y-4">
        {/* Summary */}
        <div className="rounded-lg border border-gray-200 bg-gray-50 px-4 py-3 space-y-0">
          <InfoRow label="Opening Float" value={fmtCurrency(openingCash, currency)} />
          <InfoRow label="Cash Sales" value={fmtCurrency(cashSalesTotal, currency)} bold />
          <InfoRow label="Expected Balance" value={fmtCurrency(expectedBalance, currency)} bold />
        </div>

        <div className="space-y-1.5">
          <Label className="text-xs">Cash Kept at This Location ({currency})</Label>
          <Input
            type="number"
            min="0"
            step="0.01"
            className="h-9 text-sm"
            placeholder="0.00"
            value={cashKept}
            onChange={(e) => setCashKept(e.target.value)}
          />
        </div>

        <div className="space-y-1.5">
          <Label className="text-xs">Cash Sent to Another Location ({currency})</Label>
          <Input
            type="number"
            min="0"
            step="0.01"
            className="h-9 text-sm"
            placeholder="0.00"
            value={cashTransferred}
            onChange={(e) => setCashTransferred(e.target.value)}
          />
        </div>

        {showTransfer && (
          <div className="space-y-1.5">
            <Label className="text-xs">Destination Location <span className="text-red-500">*</span></Label>
            <Select value={destLocationId} onValueChange={setDestLocationId}>
              <SelectTrigger className="h-9 text-sm">
                <SelectValue placeholder="Select destination…" />
              </SelectTrigger>
              <SelectContent>
                {locations.map((l) => (
                  <SelectItem key={l.id} value={String(l.id)}>{l.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        )}

        {/* Discrepancy indicator */}
        <div className={`rounded-lg px-4 py-3 border ${
          hasDiscrepancy ? "bg-amber-50 border-amber-200" :
          Math.abs(totalOut - expectedBalance) < 0.005 ? "bg-emerald-50 border-emerald-200" :
          "bg-gray-50 border-gray-200"
        }`}>
          <div className="flex items-center justify-between">
            <span className="text-xs text-gray-500">Total Out (kept + sent)</span>
            <span className="text-sm font-semibold tabular-nums">{fmtCurrency(totalOut, currency)}</span>
          </div>
          <div className="flex items-center justify-between mt-1">
            <span className="text-xs font-medium">
              {hasDiscrepancy ? (
                <span className="text-amber-700 flex items-center gap-1">
                  <AlertTriangle className="h-3 w-3" /> Discrepancy
                </span>
              ) : (
                <span className="text-emerald-700 flex items-center gap-1">
                  <CheckCircle2 className="h-3 w-3" /> Balanced
                </span>
              )}
            </span>
            <span className={`text-sm font-bold tabular-nums ${hasDiscrepancy ? "text-amber-700" : "text-emerald-700"}`}>
              {discrepancy > 0 ? "+" : ""}{fmtCurrency(discrepancy, currency)}
            </span>
          </div>
        </div>

        {hasDiscrepancy && (
          <div className="space-y-1.5">
            <Label className="text-xs">Discrepancy Note <span className="text-red-500">*</span></Label>
            <Textarea
              rows={2}
              className="text-sm resize-none"
              placeholder="Explain the discrepancy…"
              value={discrepancyNote}
              onChange={(e) => setDiscrepancyNote(e.target.value)}
            />
          </div>
        )}

        <label className="flex items-start gap-2 cursor-pointer">
          <input
            type="checkbox"
            checked={confirmed}
            onChange={(e) => setConfirmed(e.target.checked)}
            className="mt-0.5"
          />
          <span className="text-xs text-gray-600">
            I confirm this is the final cash count and the shift can be closed.
          </span>
        </label>

        <div className="flex gap-2">
          <Button
            variant="outline"
            size="sm"
            className="flex-1"
            onClick={onCancel}
            disabled={mutation.isPending}
          >
            Cancel
          </Button>
          <Button
            size="sm"
            className="flex-1 bg-gray-900 hover:bg-gray-800 text-white"
            disabled={!valid || mutation.isPending}
            onClick={() => mutation.mutate()}
          >
            {mutation.isPending && <Loader2 className="h-3.5 w-3.5 animate-spin mr-1" />}
            Close Shift
          </Button>
        </div>
      </div>
    </div>
  );
}

// ── Main Page ──────────────────────────────────────────────────────────────

export default function CmcPosCashDrawerPage() {
  const [, navigate] = useLocation();
  const [showCashIn, setShowCashIn] = useState(false);
  const [showSendCash, setShowSendCash] = useState(false);
  const [showCloseFlow, setShowCloseFlow] = useState(false);
  const { isOwner } = useWorkspaceRole();

  // Active shift
  const { data: shiftData, isLoading: shiftLoading } = useQuery<{ shift: ActiveShift | null }>({
    queryKey: ["cmc-pos-active-shift"],
    queryFn: () => apiFetch<{ shift: ActiveShift | null }>("/api/cmc-pos/shifts/active"),
    staleTime: 30_000,
  });
  const activeShift = shiftData?.shift ?? null;
  const isShiftActive = activeShift !== null;
  const locationId = activeShift?.location_id ?? null;

  // Cash drawer status — always fetched so StartShiftPanel gets the previous
  // session's closing balance even when no shift is active yet.
  const { data: drawerData, isLoading: drawerLoading } = useQuery<DrawerStatus>({
    queryKey: ["cmc-pos-cash-drawer", locationId],
    queryFn: () =>
      apiFetch<DrawerStatus>(
        `/api/cmc-pos/cash-drawer${locationId ? `?location_id=${locationId}` : ""}`,
      ),
    staleTime: 30_000,
    refetchInterval: 60_000,
  });

  const session = drawerData?.session ?? null;
  const currencySummary = drawerData?.currency_summary ?? [];
  const cashSalesTotal = drawerData?.cash_sales_total ?? 0;
  const expectedBalance = drawerData?.expected_balance ?? 0;
  const openingCash = session ? Number(session.opening_cash) : Number(activeShift?.opening_cash ?? 0);
  const currency = session?.currency ?? "USD";
  const previousClosingBalance = drawerData?.previous_closing_balance ?? null;
  const previousLocationName = drawerData?.previous_location_name ?? null;

  const isLoading = shiftLoading || drawerLoading;

  if (isLoading) {
    return (
      <div className="min-h-full bg-gray-50/40 p-4 sm:p-6 space-y-5">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-48 w-full" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }

  return (
    <div className="min-h-full bg-gray-50/40 p-4 sm:p-6 space-y-5">
      {/* Header */}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex items-center gap-3">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => navigate("/cmc-pos")}
            className="gap-1.5 -ml-2 text-muted-foreground"
          >
            <ArrowLeft className="h-4 w-4" /> CMC POS
          </Button>
        </div>
        <div className="flex items-center gap-2">
          <span className={`inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-xs font-medium ${
            isShiftActive ? "bg-emerald-100 text-emerald-800" : "bg-gray-200 text-gray-600"
          }`}>
            {isShiftActive ? "Shift Active" : "No Active Shift"}
          </span>
        </div>
      </div>

      {/* Page title */}
      <div className="flex items-center gap-3">
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl" style={{ background: "#e0eff0" }}>
          <CreditCard className="h-5 w-5" style={{ color: "#00414e" }} />
        </div>
        <div>
          <h1 className="text-xl font-bold text-gray-900 sm:text-2xl">Cash Drawer</h1>
          <p className="text-xs text-gray-500 mt-0.5">
            {activeShift ? `${activeShift.location_name} · CMC POS` : "CMC POS · Cash Drawer"}
          </p>
        </div>
      </div>

      {/* No active shift */}
      {!isShiftActive && !showCloseFlow && (
        <StartShiftPanel
          previousClosingBalance={previousClosingBalance}
          previousLocationName={previousLocationName}
          onSuccess={() => {}}
        />
      )}

      {/* Active shift */}
      {isShiftActive && session && !showCloseFlow && (
        <div className="grid grid-cols-1 gap-5 lg:grid-cols-[1fr_320px]">
          {/* Left: Transactions */}
          <div className="space-y-5">
            {/* Session summary card */}
            <div className="rounded-xl border border-gray-200 bg-white shadow-sm overflow-hidden">
              <div className="px-5 py-4 border-b border-gray-100 bg-gray-50 flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <DollarSign className="h-4 w-4" style={{ color: "#00414e" }} />
                  <h2 className="text-sm font-semibold text-gray-900">Session Summary</h2>
                </div>
                <span className="inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium bg-emerald-100 text-emerald-800">
                  {session.status === "open" ? "Open" : session.status}
                </span>
              </div>
              <div className="px-5 py-4 space-y-0">
                <InfoRow label="Location" value={session.location_name ?? "—"} />
                <InfoRow label="Opened" value={fmtDate(session.opened_at)} />
                <InfoRow label="Currency" value={session.currency} />
                <InfoRow label="Opening Float" value={fmtCurrency(openingCash, currency)} />
                <InfoRow label="Cash Sales" value={fmtCurrency(cashSalesTotal, currency)} bold />
                <InfoRow
                  label="Expected Balance"
                  value={fmtCurrency(expectedBalance, currency)}
                  bold
                  highlight={expectedBalance > 0 ? "ok" : undefined}
                />
              </div>
            </div>

            {/* Transactions */}
            <div className="rounded-xl border border-gray-200 bg-white shadow-sm overflow-hidden">
              <div className="px-5 py-4 border-b border-gray-100 bg-gray-50">
                <h2 className="text-sm font-semibold text-gray-900">Transactions</h2>
                <p className="text-xs text-gray-400 mt-0.5">All cash movements this shift</p>
              </div>
              <TransactionsTable sessionId={session.id} />
            </div>
          </div>

          {/* Right: Actions */}
          <div className="space-y-4 lg:self-start lg:sticky lg:top-6">
            <div className="rounded-xl border border-gray-200 bg-white shadow-sm overflow-hidden">
              <div className="px-5 py-4 border-b border-gray-100 bg-gray-50">
                <h2 className="text-sm font-semibold text-gray-900">Actions</h2>
              </div>
              <div className="px-5 py-4 space-y-3">
                <Button
                  className="w-full justify-start gap-2"
                  variant="outline"
                  onClick={() => setShowCashIn(true)}
                >
                  <Plus className="h-4 w-4 text-emerald-600" />
                  Record Cash In
                </Button>
                <Button
                  className="w-full justify-start gap-2"
                  variant="outline"
                  onClick={() => setShowSendCash(true)}
                >
                  <Send className="h-4 w-4 text-blue-600" />
                  Send Cash
                </Button>
                <div className="pt-2 border-t border-gray-100">
                  <Button
                    className="w-full justify-start gap-2 text-amber-700 border-amber-200 hover:bg-amber-50"
                    variant="outline"
                    onClick={() => setShowCloseFlow(true)}
                  >
                    <Lock className="h-4 w-4" />
                    End Shift &amp; Close Drawer
                  </Button>
                </div>
              </div>
            </div>

            {/* Currency summary */}
            {currencySummary.length > 0 && (
              <div className="rounded-xl border border-gray-200 bg-white shadow-sm overflow-hidden">
                <div className="px-5 py-3 border-b border-gray-100 bg-gray-50">
                  <h3 className="text-xs font-semibold text-gray-500 uppercase tracking-wide">Currency Breakdown</h3>
                </div>
                <div className="px-5 py-3">
                  {currencySummary.map((cs) => (
                    <div key={cs.currency} className="space-y-0">
                      <InfoRow label="Sales" value={fmtCurrency(cs.sales_collected, cs.currency)} />
                      <InfoRow label="Adjustments" value={fmtCurrency(cs.adjustments, cs.currency)} />
                      <InfoRow label="Expected" value={fmtCurrency(cs.expected_cash, cs.currency)} bold />
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Active shift but no linked cash session — shift opened without a drawer */}
      {isShiftActive && !session && !showCloseFlow && (
        <div className="rounded-xl border border-amber-200 bg-amber-50 px-5 py-6 text-center space-y-2">
          <AlertTriangle className="h-8 w-8 text-amber-500 mx-auto" />
          <p className="text-sm font-medium text-amber-800">
            {activeShift?.cash_session_id === null
              ? "Shift opened without a linked cash session"
              : "No cash session linked to this shift"}
          </p>
          <p className="text-xs text-amber-600">
            {activeShift?.cash_session_id === null
              ? "This shift was started but no cash session could be linked — cash drawer tracking is unavailable. " +
                "Close this shift and contact a manager to ensure the location has an active cash drawer."
              : "This shift location has no cash drawer, or the session hasn't been created yet. " +
                "Contact a manager if this is unexpected."}
          </p>
          <Button
            variant="outline"
            className="mt-1 gap-2 text-amber-800 border-amber-300 hover:bg-amber-100"
            onClick={() => setShowCloseFlow(true)}
          >
            <Lock className="h-4 w-4" />
            End Shift
          </Button>
        </div>
      )}

      {/* Close shift flow */}
      {showCloseFlow && isShiftActive && (
        <CloseShiftPanel
          locationId={locationId!}
          expectedBalance={expectedBalance}
          cashSalesTotal={cashSalesTotal}
          openingCash={openingCash}
          currency={currency}
          onSuccess={() => setShowCloseFlow(false)}
          onCancel={() => setShowCloseFlow(false)}
        />
      )}

      {/* Modals */}
      {session && (
        <>
          <RecordCashInDialog
            currency={currency}
            open={showCashIn}
            onClose={() => setShowCashIn(false)}
          />
          <SendCashDialog
            locationId={locationId!}
            currency={currency}
            expectedBalance={expectedBalance}
            open={showSendCash}
            onClose={() => setShowSendCash(false)}
          />
        </>
      )}
    </div>
  );
}

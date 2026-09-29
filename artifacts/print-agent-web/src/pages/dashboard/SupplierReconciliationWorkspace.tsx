import React, { useState, useMemo } from "react";
import { useParams, useSearch, useLocation } from "wouter";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
  DialogDescription,
} from "@/components/ui/dialog";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  Download,
  Upload,
  AlertTriangle,
  CheckCircle2,
  Clock,
  RefreshCw,
  XCircle,
  AlertCircle,
  ChevronLeft,
  FileText,
  ArrowRight,
  Info,
  CheckCircle,
  History,
  RotateCcw,
  ExternalLink,
  LinkIcon,
  Plus,
  Pencil,
  CreditCard,
  MinusCircle,
  X,
} from "lucide-react";
import { apiFetch } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { useWorkspaceRole } from "@/hooks/use-workspace-role";
import { cn } from "@/lib/utils";

// ── Types ─────────────────────────────────────────────────────────────────────

type SessionStatus =
  | "statement_needed"
  | "processing"
  | "needs_review"
  | "reconciled"
  | "ready_to_sync"
  | "syncing"
  | "synced"
  | "sync_failed";

type ReconciliationSession = {
  id: number;
  supplier_id: number;
  accounting_entity_month_id: number;
  status: SessionStatus;
  statement_balance: string | null;
  os_balance: string | null;
  balance_difference: string | null;
  open_exceptions_count: number;
  prepared_by: string | null;
  prepared_at: string | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
  difference_accepted_reason?: string | null;
  approved_by?: string | null;
  approved_at?: string | null;
  reopen_reason?: string | null;
  last_reopened_at?: string | null;
};

type StatementInfo = {
  id: string;
  original_file_name: string;
  mime_type: string | null;
  file_size_bytes: number | null;
  extraction_status: string;
  uploaded_by_member_id: number | null;
  created_at: string;
  replaced_by: string | null;
  replacement_reason: string | null;
  uploader_email: string | null;
};

type BalanceSummary = {
  statement_balance: number | null;
  os_balance: number | null;
  balance_difference: number | null;
  open_exceptions_count: number;
};

type ReconciliationException = {
  id: number;
  session_id: number;
  match_id: number | null;
  exception_type: string;
  status: "open" | "resolved";
  statement_data: Record<string, unknown> | null;
  os_data: Record<string, unknown> | null;
  match_type: string | null;
  match_confidence: number | null;
  entry_reference: string | null;
  entry_amount: string | null;
  entry_date: string | null;
  resolution_action: string | null;
  resolution_note: string | null;
  resolved_by: string | null;
  resolved_at: string | null;
  linked_os_record_type: string | null;
  linked_os_record_id: number | null;
};

type ReconciliationMatch = {
  id: number;
  session_id: number;
  statement_entry_id: number | null;
  os_record_type: string | null;
  os_record_id: number | null;
  match_type: string;
  match_confidence: number | null;
  match_signals: unknown;
  entry_reference: string | null;
  entry_amount: string | null;
  entry_date: string | null;
  entry_type: string | null;
  entry_currency: string | null;
  description: string | null;
  resolved_by: string | null;
  resolved_at: string | null;
};

type AuditEvent = {
  id: number;
  session_id: number;
  actor: string;
  action: string;
  detail: Record<string, unknown>;
  created_at: string;
};

type SessionPayload = {
  session: ReconciliationSession;
  statement: StatementInfo | null;
  statement_history: StatementInfo[];
  balance_summary: BalanceSummary;
  exceptions: ReconciliationException[];
  matches: ReconciliationMatch[];
};

// ── Helpers ──────────────────────────────────────────────────────────────────

function formatAmount(
  value: number | string | null | undefined,
  currency = "USD",
): string {
  if (value === null || value === undefined || value === "") return "—";
  const num = typeof value === "string" ? parseFloat(value) : value;
  if (isNaN(num)) return "—";
  try {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency,
      maximumFractionDigits: currency === "LBP" ? 0 : 2,
    }).format(num);
  } catch {
    return `${currency} ${num.toFixed(2)}`;
  }
}

function formatDate(dateStr: string | null | undefined): string {
  if (!dateStr) return "—";
  try {
    return new Date(dateStr).toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
      year: "numeric",
    });
  } catch {
    return dateStr.substring(0, 10);
  }
}

function formatDateTime(dateStr: string | null | undefined): string {
  if (!dateStr) return "—";
  try {
    return new Date(dateStr).toLocaleString("en-US", {
      month: "short",
      day: "numeric",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return dateStr.substring(0, 16);
  }
}

function monthLabel(year: number, month: number): string {
  return new Date(year, month - 1, 1).toLocaleString("en-US", {
    month: "long",
    year: "numeric",
  });
}

function exceptionLabel(type: string): string {
  const labels: Record<string, string> = {
    missing_in_os: "Missing in OS",
    missing_in_statement: "Missing in Statement",
    amount_mismatch: "Amount Mismatch",
    vat_mismatch: "VAT Mismatch",
    currency_mismatch: "Currency Mismatch",
    date_mismatch: "Date Mismatch",
    duplicate_statement: "Duplicate on Statement",
  };
  return labels[type] ?? type.replace(/_/g, " ");
}

function exceptionExplanation(type: string): string {
  const explanations: Record<string, string> = {
    missing_in_os:
      "This entry appears on the supplier statement but no matching OS bill was found. Create a bill in OS or link an existing one to resolve this.",
    missing_in_statement:
      "An OS bill exists for this supplier but no corresponding entry was found on the supplier statement. Mark as timing difference or investigate with the supplier.",
    amount_mismatch:
      "The amount on the supplier statement differs from the OS bill amount. Review both sides and either edit the OS bill or mark the difference as a supplier error or timing difference.",
    vat_mismatch:
      "The VAT amount on the statement does not match the OS record. Verify the tax treatment on both sides.",
    currency_mismatch:
      "The currency on the supplier statement differs from the OS bill. Confirm the correct currency and update accordingly.",
    date_mismatch:
      "The invoice date on the statement differs from the OS record date by more than a few days. This may be a timing difference.",
    duplicate_statement:
      "This entry appears to be a duplicate on the supplier statement — a similar amount and reference appear more than once.",
  };
  return (
    explanations[type] ??
    "Review the statement data and OS data below to determine the correct resolution."
  );
}

function renderUnknown(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  return JSON.stringify(v);
}

function resolutionActionLabel(action: string): string {
  const labels: Record<string, string> = {
    create_bill: "Created bill in OS",
    link_bill: "Linked existing OS bill",
    edit_bill: "Edited OS bill",
    create_credit_note: "Created credit note",
    link_payment: "Linked payment",
    timing_difference: "Marked as timing difference",
    supplier_error: "Marked as supplier error",
    excluded: "Excluded",
  };
  return labels[action] ?? action.replace(/_/g, " ");
}

// ── Status Badge ─────────────────────────────────────────────────────────────

function SessionStatusBadge({ status }: { status: SessionStatus | string }) {
  const variants: Record<string, string> = {
    statement_needed: "bg-amber-100 text-amber-800 border-amber-200",
    processing: "bg-blue-100 text-blue-800 border-blue-200",
    needs_review: "bg-amber-100 text-amber-800 border-amber-200",
    reconciled: "bg-green-100 text-green-800 border-green-200",
    ready_to_sync: "bg-teal-100 text-teal-800 border-teal-200",
    syncing: "bg-blue-100 text-blue-800 border-blue-200",
    synced: "bg-green-100 text-green-800 border-green-200",
    sync_failed: "bg-red-100 text-red-800 border-red-200",
  };
  const icons: Record<string, React.ReactNode> = {
    statement_needed: <AlertTriangle size={10} />,
    processing: <RefreshCw size={10} className="animate-spin" />,
    needs_review: <AlertCircle size={10} />,
    reconciled: <CheckCircle2 size={10} />,
    ready_to_sync: <CheckCircle size={10} />,
    syncing: <RefreshCw size={10} className="animate-spin" />,
    synced: <CheckCircle2 size={10} />,
    sync_failed: <XCircle size={10} />,
  };
  const labels: Record<string, string> = {
    statement_needed: "Statement Needed",
    processing: "Processing",
    needs_review: "Needs Review",
    reconciled: "Reconciled",
    ready_to_sync: "Ready to Sync",
    syncing: "Syncing",
    synced: "Synced",
    sync_failed: "Sync Failed",
  };
  const cls = variants[status] ?? "bg-gray-100 text-gray-600 border-gray-200";
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full border px-2.5 py-0.5 text-xs font-medium ${cls}`}
    >
      {icons[status]}
      {labels[status] ?? status.replace(/_/g, " ")}
    </span>
  );
}

// ── Match Result Badge ────────────────────────────────────────────────────────

function MatchResultBadge({
  matchType,
  exceptionStatus,
}: {
  matchType: string;
  exceptionStatus?: "open" | "resolved" | null;
}) {
  if (exceptionStatus === "open") {
    return (
      <Badge
        variant="outline"
        className="border-red-300 text-red-700 bg-red-50 gap-1"
      >
        <AlertCircle size={10} />
        Exception
      </Badge>
    );
  }
  if (exceptionStatus === "resolved" || matchType === "manually_resolved") {
    return (
      <Badge
        variant="outline"
        className="border-gray-300 text-gray-600 bg-gray-50 gap-1"
      >
        <CheckCircle size={10} />
        Resolved
      </Badge>
    );
  }
  if (matchType === "matched") {
    return (
      <Badge
        variant="outline"
        className="border-green-300 text-green-700 bg-green-50 gap-1"
      >
        <CheckCircle2 size={10} />
        Matched
      </Badge>
    );
  }
  if (matchType === "possible") {
    return (
      <Badge
        variant="outline"
        className="border-amber-300 text-amber-700 bg-amber-50 gap-1"
      >
        <AlertTriangle size={10} />
        Possible
      </Badge>
    );
  }
  if (matchType === "duplicate_statement") {
    return (
      <Badge
        variant="outline"
        className="border-orange-300 text-orange-700 bg-orange-50 gap-1"
      >
        <AlertTriangle size={10} />
        Duplicate
      </Badge>
    );
  }
  // unmatched
  return (
    <Badge
      variant="outline"
      className="border-red-300 text-red-700 bg-red-50 gap-1"
    >
      <XCircle size={10} />
      Unmatched
    </Badge>
  );
}

// ── Summary Cards ─────────────────────────────────────────────────────────────

function SummaryCards({
  balanceSummary,
  currency,
}: {
  balanceSummary: BalanceSummary;
  currency: string;
}) {
  const diff = balanceSummary.balance_difference;
  const diffColor =
    diff === null || diff === undefined
      ? ""
      : Math.abs(diff) < 0.01
        ? "text-green-600"
        : Math.abs(diff) > 100
          ? "text-red-600"
          : "text-amber-600";
  const diffCardBg =
    diff === null || diff === undefined
      ? "bg-muted"
      : Math.abs(diff) < 0.01
        ? "bg-green-100 text-green-700"
        : Math.abs(diff) > 100
          ? "bg-red-100 text-red-700"
          : "bg-amber-100 text-amber-700";

  const cards = [
    {
      title: "Statement Balance",
      value: formatAmount(balanceSummary.statement_balance, currency),
      icon: FileText,
      iconClass: "bg-muted text-muted-foreground",
    },
    {
      title: "OS Bills Balance",
      value: formatAmount(balanceSummary.os_balance, currency),
      icon: CheckCircle,
      iconClass: "bg-muted text-muted-foreground",
    },
    {
      title: "Remaining Difference",
      value:
        diff === null || diff === undefined
          ? "—"
          : formatAmount(diff, currency),
      icon: diff !== null && Math.abs(diff) < 0.01 ? CheckCircle : AlertTriangle,
      iconClass: diffCardBg,
      valueClass: diffColor,
    },
    {
      title: "Open Exceptions",
      value: String(balanceSummary.open_exceptions_count),
      icon: balanceSummary.open_exceptions_count > 0 ? AlertCircle : CheckCircle,
      iconClass:
        balanceSummary.open_exceptions_count > 0
          ? "bg-red-100 text-red-700"
          : "bg-green-100 text-green-700",
      valueClass:
        balanceSummary.open_exceptions_count > 0
          ? "text-red-600"
          : "text-green-600",
    },
  ];

  return (
    <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
      {cards.map((card) => {
        const Icon = card.icon;
        return (
          <Card key={card.title} className="min-w-0">
            <CardContent className="pt-5 pb-4">
              <div className="flex items-start justify-between gap-2">
                <div className="flex-1 min-w-0">
                  <p className="text-xs text-muted-foreground uppercase tracking-wide mb-1 truncate">
                    {card.title}
                  </p>
                  <p
                    className={cn(
                      "text-xl font-semibold truncate",
                      card.valueClass,
                    )}
                  >
                    {card.value}
                  </p>
                </div>
                <div className={`rounded-full p-2 shrink-0 ${card.iconClass}`}>
                  <Icon size={16} />
                </div>
              </div>
            </CardContent>
          </Card>
        );
      })}
    </div>
  );
}

// ── Investigation Panel ────────────────────────────────────────────────────────

function DataCard({
  title,
  data,
  currency,
}: {
  title: string;
  data: Record<string, unknown> | null | undefined;
  currency?: string;
}) {
  if (!data) {
    return (
      <div className="rounded-lg border border-dashed border-muted-foreground/30 p-4">
        <p className="text-xs font-medium text-muted-foreground mb-1">{title}</p>
        <p className="text-sm text-muted-foreground italic">No record found</p>
      </div>
    );
  }

  const fields = Object.entries(data).filter(
    ([, v]) => v !== null && v !== undefined && v !== "",
  );

  return (
    <div className="rounded-lg border border-muted bg-muted/30 p-4 space-y-2">
      <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        {title}
      </p>
      {fields.map(([key, value]) => (
        <div key={key} className="flex items-start justify-between gap-2 text-xs">
          <span className="text-muted-foreground capitalize shrink-0">
            {key.replace(/_/g, " ")}
          </span>
          <span className="font-medium text-right break-words max-w-[60%]">
            {key === "amount" || key === "total"
              ? formatAmount(value as number, currency)
              : renderUnknown(value)}
          </span>
        </div>
      ))}
    </div>
  );
}

type ResolutionSectionProps = {
  exception: ReconciliationException;
  sessionId: number;
  currency: string;
  onResolved: () => void;
};

function ResolutionSection({
  exception,
  sessionId,
  currency,
  onResolved,
}: ResolutionSectionProps) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [action, setAction] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const [linkedId, setLinkedId] = useState<string>("");

  const sessionQueryKey = ["supplier-recon-session", sessionId];

  const resolveMutation = useMutation({
    mutationFn: (body: {
      resolution_action: string;
      resolution_note?: string;
      linked_os_record_id?: number;
    }) =>
      apiFetch(
        `/api/accounting/supplier-reconciliation/exceptions/${exception.id}/resolve`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        },
      ),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: sessionQueryKey });
      toast({ title: "Exception resolved" });
      onResolved();
    },
    onError: (err) => {
      toast({
        title: "Failed to resolve exception",
        description: err instanceof Error ? err.message : "Unknown error",
        variant: "destructive",
      });
    },
  });

  function submit() {
    if (!action) return;
    const body: Parameters<typeof resolveMutation.mutate>[0] = {
      resolution_action: action,
    };
    if (note.trim()) body.resolution_note = note.trim();
    if (linkedId.trim()) {
      const parsedId = parseInt(linkedId, 10);
      if (!isNaN(parsedId)) body.linked_os_record_id = parsedId;
    }
    resolveMutation.mutate(body);
  }

  const exType = exception.exception_type;
  const availableActions: { value: string; label: string; icon: React.ReactNode; requiresLink?: boolean; hint?: string }[] = [];

  if (exType === "missing_in_os" || exType === "duplicate_statement") {
    availableActions.push({
      value: "create_bill",
      label: "Create bill in OS",
      icon: <Plus size={13} />,
      hint: "Creates a new OS bill pre-populated from statement data.",
    });
    availableActions.push({
      value: "link_bill",
      label: "Link existing OS bill",
      icon: <LinkIcon size={13} />,
      requiresLink: true,
      hint: "Enter the OS bill ID to link.",
    });
  }
  if (exType === "missing_in_statement") {
    availableActions.push({
      value: "link_payment",
      label: "Link payment",
      icon: <CreditCard size={13} />,
      requiresLink: true,
      hint: "Enter the payment ID.",
    });
  }
  if (exType === "amount_mismatch" || exType === "vat_mismatch") {
    availableActions.push({
      value: "edit_bill",
      label: "Edit OS bill",
      icon: <Pencil size={13} />,
      requiresLink: true,
      hint: "Enter the OS bill ID to update.",
    });
    availableActions.push({
      value: "create_credit_note",
      label: "Create credit note",
      icon: <MinusCircle size={13} />,
      requiresLink: true,
      hint: "Enter the OS bill ID for the credit note.",
    });
  }
  // Always offer timing difference, supplier error, exclude
  availableActions.push({
    value: "timing_difference",
    label: "Mark as timing difference",
    icon: <Clock size={13} />,
  });
  availableActions.push({
    value: "supplier_error",
    label: "Mark as supplier error",
    icon: <AlertTriangle size={13} />,
  });
  availableActions.push({
    value: "excluded",
    label: "Exclude",
    icon: <X size={13} />,
    hint: "A note is required when excluding.",
  });

  const selectedAction = availableActions.find((a) => a.value === action);

  return (
    <div className="space-y-4">
      <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        Resolution
      </p>
      {/* Action buttons */}
      <div className="flex flex-wrap gap-2">
        {availableActions.map((a) => (
          <button
            key={a.value}
            onClick={() => setAction(a.value === action ? null : a.value)}
            className={cn(
              "inline-flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-xs font-medium transition-colors",
              action === a.value
                ? "border-primary bg-primary text-primary-foreground"
                : "border-border bg-background text-foreground hover:bg-muted",
            )}
          >
            {a.icon}
            {a.label}
          </button>
        ))}
      </div>

      {/* Contextual hint */}
      {selectedAction?.hint && (
        <p className="text-xs text-muted-foreground flex items-start gap-1.5">
          <Info size={12} className="mt-0.5 shrink-0" />
          {selectedAction.hint}
        </p>
      )}

      {/* Linked OS record ID field */}
      {selectedAction?.requiresLink && (
        <div>
          <Label className="text-xs">OS Record ID</Label>
          <Input
            value={linkedId}
            onChange={(e) => setLinkedId(e.target.value)}
            placeholder="Enter OS bill/payment ID"
            className="h-8 text-sm mt-1"
          />
        </div>
      )}

      {/* Note */}
      <div>
        <Label className="text-xs">
          Resolution note{action === "excluded" ? " (required)" : " (optional)"}
        </Label>
        <Textarea
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder="Add a note explaining the resolution…"
          rows={3}
          className="text-sm mt-1"
        />
      </div>

      {/* Submit */}
      <Button
        onClick={submit}
        disabled={
          !action ||
          resolveMutation.isPending ||
          (action === "excluded" && !note.trim()) ||
          (selectedAction?.requiresLink && !linkedId.trim())
        }
        className="w-full gap-2"
        size="sm"
      >
        {resolveMutation.isPending && (
          <RefreshCw size={13} className="animate-spin" />
        )}
        Resolve exception
      </Button>
    </div>
  );
}

type InvestigationPanelProps = {
  exception: ReconciliationException;
  match: ReconciliationMatch | null;
  sessionId: number;
  currency: string;
  isViewMode: boolean;
  onClose: () => void;
  onResolved: () => void;
};

function InvestigationPanel({
  exception,
  match,
  sessionId,
  currency,
  isViewMode,
  onClose,
  onResolved,
}: InvestigationPanelProps) {
  return (
    <div className="flex flex-col h-full">
      {/* Panel header */}
      <div className="flex items-center justify-between px-4 py-3 border-b shrink-0">
        <div className="flex items-center gap-2">
          <AlertCircle size={16} className="text-amber-600 shrink-0" />
          <div>
            <p className="text-sm font-semibold">
              {exceptionLabel(exception.exception_type)}
            </p>
            <p className="text-xs text-muted-foreground">
              {exception.status === "resolved" ? "Resolved" : "Open exception"}
            </p>
          </div>
        </div>
        <button
          onClick={onClose}
          className="rounded-sm opacity-70 hover:opacity-100 transition-opacity p-1"
          aria-label="Close panel"
        >
          <X size={16} />
        </button>
      </div>

      {/* Scrollable content */}
      <div className="flex-1 overflow-y-auto px-4 py-4 space-y-5">
        {/* Explanation */}
        <div className="rounded-lg border border-blue-200 bg-blue-50 px-4 py-3">
          <p className="text-xs text-blue-800 leading-relaxed">
            {exceptionExplanation(exception.exception_type)}
          </p>
        </div>

        {/* Statement data */}
        <DataCard
          title="Statement Data"
          data={exception.statement_data}
          currency={currency}
        />

        {/* OS data */}
        <DataCard
          title="OS Record"
          data={exception.os_data}
          currency={currency}
        />

        {/* Match signals (if available) */}
        {match?.match_signals != null && typeof match.match_signals === "object" && (
          (() => {
            const signals = match.match_signals as Record<string, unknown>;
            const entries = Object.entries(signals);
            if (entries.length === 0) return null;
            return (
              <div className="rounded-lg border border-muted bg-muted/20 p-4">
                <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-2">
                  Match Signals
                </p>
                {entries.map(([k, v]) => (
                  <div key={k} className="flex justify-between text-xs mb-1">
                    <span className="text-muted-foreground capitalize">{k.replace(/_/g, " ")}</span>
                    <span className="font-medium">{renderUnknown(v)}</span>
                  </div>
                ))}
              </div>
            );
          })()
        )}

        {/* Resolution section */}
        {exception.status === "resolved" ? (
          <div className="space-y-3">
            <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              Resolution Details
            </p>
            <div className="rounded-lg border border-green-200 bg-green-50 p-4 space-y-2">
              <div className="flex items-center gap-2 text-sm font-medium text-green-800">
                <CheckCircle2 size={14} />
                {exception.resolution_action
                  ? resolutionActionLabel(exception.resolution_action)
                  : "Resolved"}
              </div>
              {exception.resolution_note && (
                <p className="text-xs text-green-700">{exception.resolution_note}</p>
              )}
              {exception.linked_os_record_id && (
                <p className="text-xs text-muted-foreground">
                  Linked OS record ID: {exception.linked_os_record_id}
                </p>
              )}
              {exception.resolved_at && (
                <p className="text-xs text-muted-foreground">
                  {formatDateTime(exception.resolved_at)}
                </p>
              )}
            </div>
          </div>
        ) : !isViewMode ? (
          <ResolutionSection
            exception={exception}
            sessionId={sessionId}
            currency={currency}
            onResolved={onResolved}
          />
        ) : null}
      </div>
    </div>
  );
}

// ── Matching Table ────────────────────────────────────────────────────────────

type MatchRow = ReconciliationMatch & {
  exception?: ReconciliationException;
};

type MatchingTableProps = {
  matches: ReconciliationMatch[];
  exceptions: ReconciliationException[];
  selectedExceptionId: number | null;
  isViewMode: boolean;
  onSelectException: (exc: ReconciliationException, match: ReconciliationMatch) => void;
  sessionId: number;
  currency: string;
};

function MatchingTable({
  matches,
  exceptions,
  selectedExceptionId,
  isViewMode,
  onSelectException,
  sessionId,
  currency,
}: MatchingTableProps) {
  const [tab, setTab] = useState<"all" | "exceptions" | "matched">("all");
  const [page, setPage] = useState(0);
  const PAGE_SIZE = 50;

  const queryClient = useQueryClient();
  const { toast } = useToast();

  // Build exception map keyed by match_id
  const exceptionByMatchId = useMemo(() => {
    const map = new Map<number, ReconciliationException>();
    for (const exc of exceptions) {
      if (exc.match_id !== null) {
        // Prefer open exceptions over resolved
        const existing = map.get(exc.match_id);
        if (!existing || exc.status === "open") {
          map.set(exc.match_id, exc);
        }
      }
    }
    return map;
  }, [exceptions]);

  const rows: MatchRow[] = useMemo(() => {
    return matches.map((m) => ({
      ...m,
      exception: exceptionByMatchId.get(m.id),
    }));
  }, [matches, exceptionByMatchId]);

  const openExceptionsCount = exceptions.filter((e) => e.status === "open").length;

  const filteredRows = useMemo(() => {
    switch (tab) {
      case "exceptions":
        return rows.filter(
          (r) => r.exception && r.exception.status === "open",
        );
      case "matched":
        return rows.filter(
          (r) => r.match_type === "matched" && !r.exception?.status,
        );
      default:
        return rows;
    }
  }, [rows, tab]);

  const pageCount = Math.ceil(filteredRows.length / PAGE_SIZE);
  const pageRows = filteredRows.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);

  // Confirm possible match mutation
  const confirmMutation = useMutation({
    mutationFn: (matchId: number) =>
      apiFetch(
        `/api/accounting/supplier-reconciliation/matches/${matchId}/confirm`,
        { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ confirmed: true }) },
      ),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["supplier-recon-session", sessionId] });
      toast({ title: "Match confirmed" });
    },
    onError: (err) => {
      toast({
        title: "Failed to confirm match",
        description: err instanceof Error ? err.message : "Unknown error",
        variant: "destructive",
      });
    },
  });

  function rowClass(row: MatchRow): string {
    if (row.exception?.status === "open") return "bg-red-50/40";
    if (row.exception?.status === "resolved" || row.match_type === "manually_resolved")
      return "bg-muted/20";
    if (row.match_type === "matched") return "bg-green-50/30";
    if (row.match_type === "possible") return "bg-amber-50/30";
    return "";
  }

  return (
    <div className="space-y-3">
      {/* Tab bar */}
      <div className="flex items-center gap-0 rounded-lg border w-fit overflow-hidden">
        {[
          { id: "all" as const, label: "All", count: rows.length },
          {
            id: "exceptions" as const,
            label: "Exceptions",
            count: openExceptionsCount,
          },
          {
            id: "matched" as const,
            label: "Matched",
            count: rows.filter(
              (r) => r.match_type === "matched" && !r.exception,
            ).length,
          },
        ].map((t) => (
          <button
            key={t.id}
            onClick={() => { setTab(t.id); setPage(0); }}
            className={cn(
              "flex items-center gap-1.5 px-4 py-2 text-sm font-medium border-r last:border-r-0 transition-colors",
              tab === t.id
                ? "bg-primary text-primary-foreground"
                : "bg-background text-foreground hover:bg-muted",
            )}
          >
            {t.label}
            <span
              className={cn(
                "rounded-full px-1.5 py-0.5 text-xs font-semibold",
                tab === t.id
                  ? "bg-white/20 text-white"
                  : t.id === "exceptions" && t.count > 0
                    ? "bg-red-100 text-red-700"
                    : "bg-muted text-muted-foreground",
              )}
            >
              {t.count}
            </span>
          </button>
        ))}
      </div>

      {/* Table */}
      <div className="rounded-lg border overflow-hidden">
        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow className="bg-muted/40">
                <TableHead className="text-xs py-2 w-[180px]">Statement Entry</TableHead>
                <TableHead className="text-xs py-2 w-[90px]">Date</TableHead>
                <TableHead className="text-xs py-2 text-right w-[120px]">Stmt Amount</TableHead>
                <TableHead className="text-xs py-2 w-[160px]">OS Record</TableHead>
                <TableHead className="text-xs py-2 text-right w-[120px]">OS Amount</TableHead>
                <TableHead className="text-xs py-2 w-[120px]">Result</TableHead>
                <TableHead className="text-xs py-2 w-[100px]">Action</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {pageRows.length === 0 ? (
                <TableRow>
                  <TableCell
                    colSpan={7}
                    className="text-center text-muted-foreground text-sm py-12"
                  >
                    No entries in this view.
                  </TableCell>
                </TableRow>
              ) : (
                pageRows.map((row) => {
                  const isSelected =
                    row.exception?.id === selectedExceptionId;
                  return (
                    <TableRow
                      key={row.id}
                      className={cn(
                        "cursor-pointer transition-colors",
                        rowClass(row),
                        isSelected && "ring-2 ring-primary ring-inset",
                      )}
                      onClick={() => {
                        if (row.exception) {
                          onSelectException(row.exception, row);
                        }
                      }}
                    >
                      {/* Statement entry */}
                      <TableCell className="py-2 text-xs">
                        <div className="font-medium truncate max-w-[160px]">
                          {row.entry_reference ?? "—"}
                        </div>
                        {row.description && (
                          <div className="text-muted-foreground truncate max-w-[160px]">
                            {row.description}
                          </div>
                        )}
                      </TableCell>
                      {/* Date */}
                      <TableCell className="py-2 text-xs whitespace-nowrap">
                        {row.entry_date
                          ? new Date(row.entry_date).toLocaleDateString("en-US", {
                              month: "short",
                              day: "numeric",
                            })
                          : "—"}
                      </TableCell>
                      {/* Statement amount */}
                      <TableCell className="py-2 text-right text-xs tabular-nums">
                        {formatAmount(row.entry_amount, row.entry_currency ?? currency)}
                      </TableCell>
                      {/* OS record */}
                      <TableCell className="py-2 text-xs">
                        {row.os_record_id ? (
                          <div className="flex items-center gap-1">
                            <span className="text-xs text-muted-foreground capitalize">
                              {row.os_record_type ?? "bill"}
                            </span>
                            <span className="font-medium">#{row.os_record_id}</span>
                          </div>
                        ) : (
                          <span className="text-muted-foreground">—</span>
                        )}
                      </TableCell>
                      {/* OS amount */}
                      <TableCell className="py-2 text-right text-xs tabular-nums">
                        {row.exception?.os_data &&
                        typeof (row.exception.os_data as Record<string, unknown>).amount === "number"
                          ? formatAmount(
                              (row.exception.os_data as Record<string, unknown>).amount as number,
                              currency,
                            )
                          : "—"}
                      </TableCell>
                      {/* Match result */}
                      <TableCell className="py-2">
                        <MatchResultBadge
                          matchType={row.match_type}
                          exceptionStatus={row.exception?.status}
                        />
                      </TableCell>
                      {/* Action */}
                      <TableCell className="py-2">
                        {row.exception?.status === "open" && !isViewMode ? (
                          <Button
                            size="sm"
                            variant="outline"
                            className="h-6 text-xs px-2 gap-1"
                            onClick={(e) => {
                              e.stopPropagation();
                              onSelectException(row.exception!, row);
                            }}
                          >
                            Resolve
                          </Button>
                        ) : row.match_type === "possible" && !isViewMode ? (
                          <Button
                            size="sm"
                            variant="outline"
                            className="h-6 text-xs px-2 gap-1"
                            disabled={confirmMutation.isPending}
                            onClick={(e) => {
                              e.stopPropagation();
                              confirmMutation.mutate(row.id);
                            }}
                          >
                            Confirm
                          </Button>
                        ) : row.os_record_id ? (
                          <Button
                            size="sm"
                            variant="ghost"
                            className="h-6 text-xs px-2 gap-1 text-muted-foreground"
                            onClick={(e) => {
                              e.stopPropagation();
                              // Placeholder: link to OS bill detail if route exists
                            }}
                          >
                            <ExternalLink size={11} />
                            View
                          </Button>
                        ) : null}
                      </TableCell>
                    </TableRow>
                  );
                })
              )}
            </TableBody>
          </Table>
        </div>
      </div>

      {/* Pagination */}
      {pageCount > 1 && (
        <div className="flex items-center justify-between text-sm">
          <span className="text-muted-foreground text-xs">
            {page * PAGE_SIZE + 1}–
            {Math.min((page + 1) * PAGE_SIZE, filteredRows.length)} of{" "}
            {filteredRows.length}
          </span>
          <div className="flex gap-2">
            <Button
              variant="outline"
              size="sm"
              disabled={page === 0}
              onClick={() => setPage((p) => p - 1)}
              className="h-7 text-xs"
            >
              Previous
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={page >= pageCount - 1}
              onClick={() => setPage((p) => p + 1)}
              className="h-7 text-xs"
            >
              Next
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Audit Trail ───────────────────────────────────────────────────────────────

function AuditTrail({ sessionId }: { sessionId: number }) {
  const { data, isLoading } = useQuery<{ audit: AuditEvent[] }>({
    queryKey: ["supplier-recon-audit", sessionId],
    queryFn: () =>
      apiFetch(
        `/api/accounting/supplier-reconciliation/sessions/${sessionId}/audit`,
      ),
    staleTime: 30_000,
  });

  if (isLoading) {
    return (
      <div className="space-y-2">
        {Array.from({ length: 3 }).map((_, i) => (
          <Skeleton key={i} className="h-10 w-full" />
        ))}
      </div>
    );
  }

  const events = data?.audit ?? [];
  if (events.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">No audit events recorded.</p>
    );
  }

  const actionLabels: Record<string, string> = {
    session_completed: "Session completed",
    session_approved: "Approved for Odoo sync",
    session_reopened: "Session reopened",
    exception_resolved: "Exception resolved",
    difference_accepted: "Balance difference accepted",
    statement_uploaded: "Statement uploaded",
    statement_extracted: "Statement extracted",
    matching_completed: "Matching completed",
  };

  return (
    <div className="space-y-3">
      {events.map((event) => (
        <div key={event.id} className="flex gap-3 items-start">
          <div className="w-2 h-2 rounded-full bg-border mt-1.5 shrink-0" />
          <div className="flex-1 min-w-0">
            <div className="flex items-center justify-between gap-2">
              <p className="text-sm font-medium">
                {actionLabels[event.action] ?? event.action.replace(/_/g, " ")}
              </p>
              <p className="text-xs text-muted-foreground whitespace-nowrap">
                {formatDateTime(event.created_at)}
              </p>
            </div>
            <p className="text-xs text-muted-foreground truncate">
              by {event.actor}
            </p>
          </div>
        </div>
      ))}
    </div>
  );
}

// ── Replace Statement Modal ───────────────────────────────────────────────────

function ReplaceStatementModal({
  open,
  sessionId,
  onClose,
  onSuccess,
}: {
  open: boolean;
  sessionId: number;
  onClose: () => void;
  onSuccess: () => void;
}) {
  const { toast } = useToast();
  const [file, setFile] = useState<File | null>(null);
  const [reason, setReason] = useState("");
  const [uploading, setUploading] = useState(false);

  async function handleUpload() {
    if (!file) return;
    setUploading(true);
    try {
      // Get session to find supplier_id / entity_month_id
      const sessionData = await apiFetch(
        `/api/accounting/supplier-reconciliation/sessions/${sessionId}`,
      ) as SessionPayload;
      const { supplier_id, accounting_entity_month_id } = sessionData.session;

      const formData = new FormData();
      formData.append("file", file);
      if (reason.trim()) formData.append("replacement_reason", reason.trim());

      await apiFetch(
        `/api/accounting/entity-months/${accounting_entity_month_id}/supplier-reconciliation/${supplier_id}/statement`,
        { method: "POST", body: formData },
      );
      toast({ title: "Statement replaced successfully" });
      onSuccess();
      onClose();
    } catch (err) {
      toast({
        title: "Upload failed",
        description: err instanceof Error ? err.message : "Unknown error",
        variant: "destructive",
      });
    } finally {
      setUploading(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Replace Statement</DialogTitle>
          <DialogDescription>
            Upload a new statement to replace the current one. The previous
            statement will be retained in the history.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4 py-2">
          <div>
            <Label className="text-xs mb-1 block">New statement file</Label>
            <input
              type="file"
              accept=".pdf,.xls,.xlsx,.csv"
              className="block w-full text-sm file:mr-3 file:py-1.5 file:px-3 file:rounded file:border-0 file:text-xs file:font-medium file:bg-primary file:text-primary-foreground hover:file:bg-primary/90 text-muted-foreground"
              onChange={(e) => setFile(e.target.files?.[0] ?? null)}
            />
          </div>
          <div>
            <Label className="text-xs mb-1 block">Reason for replacement (optional)</Label>
            <Textarea
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="e.g. Supplier sent a corrected statement"
              rows={2}
              className="text-sm"
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={uploading}>
            Cancel
          </Button>
          <Button
            onClick={() => void handleUpload()}
            disabled={!file || uploading}
            className="gap-2"
          >
            {uploading && <RefreshCw size={13} className="animate-spin" />}
            <Upload size={13} />
            Replace statement
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ── Complete Dialog ───────────────────────────────────────────────────────────

function CompleteDialog({
  open,
  sessionId,
  openExceptionsCount,
  balanceDiff,
  differenceAccepted,
  isFinanceManager,
  onClose,
  onComplete,
}: {
  open: boolean;
  sessionId: number;
  openExceptionsCount: number;
  balanceDiff: number | null;
  differenceAccepted: boolean;
  isFinanceManager: boolean;
  onClose: () => void;
  onComplete: () => void;
}) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [acceptReason, setAcceptReason] = useState("");
  const sessionQueryKey = ["supplier-recon-session", sessionId];

  const acceptDiffMutation = useMutation({
    mutationFn: (reason: string) =>
      apiFetch(
        `/api/accounting/supplier-reconciliation/sessions/${sessionId}/accept-difference`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ reason }),
        },
      ),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: sessionQueryKey });
    },
    onError: (err) => {
      toast({
        title: "Failed to accept difference",
        description: err instanceof Error ? err.message : "Unknown error",
        variant: "destructive",
      });
    },
  });

  const completeMutation = useMutation({
    mutationFn: () =>
      apiFetch(
        `/api/accounting/supplier-reconciliation/sessions/${sessionId}/complete`,
        { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({}) },
      ),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: sessionQueryKey });
      toast({ title: "Reconciliation completed" });
      onComplete();
      onClose();
    },
    onError: (err) => {
      toast({
        title: "Failed to complete reconciliation",
        description: err instanceof Error ? err.message : "Unknown error",
        variant: "destructive",
      });
    },
  });

  const hasDiff = balanceDiff !== null && Math.abs(balanceDiff) > 0.01;

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Complete Reconciliation</DialogTitle>
          <DialogDescription>
            Review the following before completing.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4 py-2">
          {openExceptionsCount > 0 && (
            <div className="flex items-start gap-3 rounded-lg border border-red-300 bg-red-50 px-4 py-3">
              <AlertCircle size={16} className="shrink-0 mt-0.5 text-red-600" />
              <p className="text-sm text-red-800">
                {openExceptionsCount} open exception
                {openExceptionsCount !== 1 ? "s" : ""} remain
                {openExceptionsCount === 1 ? "s" : ""}. All exceptions must be
                resolved before completing.
              </p>
            </div>
          )}
          {hasDiff && !differenceAccepted && isFinanceManager && (
            <div className="space-y-3">
              <div className="flex items-start gap-3 rounded-lg border border-amber-300 bg-amber-50 px-4 py-3">
                <AlertTriangle
                  size={16}
                  className="shrink-0 mt-0.5 text-amber-600"
                />
                <p className="text-sm text-amber-800">
                  A balance difference of {balanceDiff !== null ? Math.abs(balanceDiff).toFixed(2) : "?"} remains.
                  Provide a reason to accept it and continue.
                </p>
              </div>
              <div>
                <Label className="text-xs mb-1 block">Reason for accepting difference</Label>
                <Textarea
                  value={acceptReason}
                  onChange={(e) => setAcceptReason(e.target.value)}
                  placeholder="e.g. Rounding difference, confirmed with supplier"
                  rows={2}
                  className="text-sm"
                />
                <Button
                  size="sm"
                  variant="outline"
                  className="mt-2"
                  disabled={!acceptReason.trim() || acceptDiffMutation.isPending}
                  onClick={() => acceptDiffMutation.mutate(acceptReason.trim())}
                >
                  {acceptDiffMutation.isPending && (
                    <RefreshCw size={13} className="animate-spin mr-1" />
                  )}
                  Accept difference
                </Button>
              </div>
            </div>
          )}
          {hasDiff && differenceAccepted && (
            <div className="flex items-center gap-2 text-sm text-green-700">
              <CheckCircle size={14} />
              Balance difference accepted.
            </div>
          )}
          {!hasDiff && openExceptionsCount === 0 && (
            <div className="flex items-center gap-2 text-sm text-green-700">
              <CheckCircle2 size={14} />
              All exceptions resolved and balances match. Ready to complete.
            </div>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button
            onClick={() => completeMutation.mutate()}
            disabled={
              completeMutation.isPending ||
              openExceptionsCount > 0 ||
              (hasDiff && !differenceAccepted)
            }
            className="gap-2"
          >
            {completeMutation.isPending && (
              <RefreshCw size={13} className="animate-spin" />
            )}
            Complete reconciliation
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ── Reopen Dialog ─────────────────────────────────────────────────────────────

function ReopenDialog({
  open,
  sessionId,
  currentStatus,
  onClose,
  onReopened,
}: {
  open: boolean;
  sessionId: number;
  currentStatus: string;
  onClose: () => void;
  onReopened: () => void;
}) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [reason, setReason] = useState("");
  const isSynced = currentStatus === "synced";

  const reopenMutation = useMutation({
    mutationFn: () =>
      apiFetch(
        `/api/accounting/supplier-reconciliation/sessions/${sessionId}/reopen`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ reason: reason.trim(), force: isSynced }),
        },
      ),
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: ["supplier-recon-session", sessionId],
      });
      toast({ title: "Session reopened for editing" });
      onReopened();
      onClose();
    },
    onError: (err) => {
      toast({
        title: "Failed to reopen session",
        description: err instanceof Error ? err.message : "Unknown error",
        variant: "destructive",
      });
    },
  });

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) { setReason(""); onClose(); } }}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Reopen Reconciliation</DialogTitle>
          <DialogDescription>
            This will move the session back to "Needs Review" status and reset
            the preparer/approver info.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4 py-2">
          {isSynced && (
            <div className="flex items-start gap-3 rounded-lg border border-amber-300 bg-amber-50 px-4 py-3">
              <AlertTriangle
                size={16}
                className="shrink-0 mt-0.5 text-amber-600"
              />
              <p className="text-sm text-amber-800">
                This session has already been synced to Odoo. Reopening will not
                reverse existing Odoo bills — you must reverse them manually in
                Odoo.
              </p>
            </div>
          )}
          <div>
            <Label className="text-xs mb-1 block">Reason for reopening (required)</Label>
            <Textarea
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="e.g. Supplier provided a corrected statement"
              rows={3}
              className="text-sm"
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => { setReason(""); onClose(); }}>
            Cancel
          </Button>
          <Button
            variant="destructive"
            onClick={() => reopenMutation.mutate()}
            disabled={!reason.trim() || reopenMutation.isPending}
            className="gap-2"
          >
            {reopenMutation.isPending && (
              <RefreshCw size={13} className="animate-spin" />
            )}
            <RotateCcw size={13} />
            Reopen
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ── Approve Dialog ────────────────────────────────────────────────────────────

function ApproveAndSyncSection({
  sessionId,
  sessionStatus,
}: {
  sessionId: number;
  sessionStatus: string;
}) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [syncing, setSyncing] = useState(false);
  const sessionQueryKey = ["supplier-recon-session", sessionId];

  const approveMutation = useMutation({
    mutationFn: () =>
      apiFetch(
        `/api/accounting/supplier-reconciliation/sessions/${sessionId}/approve`,
        { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({}) },
      ),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: sessionQueryKey });
      toast({ title: "Session approved for Odoo sync" });
      // Trigger sync
      void triggerSync();
    },
    onError: (err) => {
      toast({
        title: "Approval failed",
        description: err instanceof Error ? err.message : "Unknown error",
        variant: "destructive",
      });
    },
  });

  async function triggerSync() {
    setSyncing(true);
    try {
      await apiFetch(
        `/api/accounting/supplier-reconciliation/sessions/${sessionId}/sync-to-odoo`,
        { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({}) },
      );
      await queryClient.invalidateQueries({ queryKey: sessionQueryKey });
      toast({ title: "Odoo sync initiated" });
    } catch (err) {
      toast({
        title: "Sync failed",
        description: err instanceof Error ? err.message : "Unknown error",
        variant: "destructive",
      });
    } finally {
      setSyncing(false);
    }
  }

  if (sessionStatus === "ready_to_sync") {
    return (
      <Button
        onClick={() => void triggerSync()}
        disabled={syncing}
        className="gap-2"
      >
        {syncing ? (
          <RefreshCw size={14} className="animate-spin" />
        ) : (
          <ArrowRight size={14} />
        )}
        {syncing ? "Syncing to Odoo…" : "Sync to Odoo"}
      </Button>
    );
  }

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span>
          <Button
            onClick={() => approveMutation.mutate()}
            disabled={
              approveMutation.isPending ||
              syncing ||
              sessionStatus !== "reconciled"
            }
            className="gap-2"
          >
            {approveMutation.isPending || syncing ? (
              <RefreshCw size={14} className="animate-spin" />
            ) : (
              <CheckCircle size={14} />
            )}
            Approve for Odoo sync
          </Button>
        </span>
      </TooltipTrigger>
      {sessionStatus !== "reconciled" && (
        <TooltipContent>
          Session must be in "Reconciled" status before approving.
        </TooltipContent>
      )}
    </Tooltip>
  );
}

// ── Main Page ─────────────────────────────────────────────────────────────────

export default function SupplierReconciliationWorkspace() {
  const { sessionId: sessionIdParam } = useParams<{ sessionId: string }>();
  const search = useSearch();
  const [, navigate] = useLocation();
  const { isOwner, allowedPages } = useWorkspaceRole();
  // finance_manager sub-permission gates approve, sync, accept-difference, and reopen
  const isFinanceManager = isOwner || (allowedPages?.includes("finance_manager") ?? false);

  const sessionId = parseInt(sessionIdParam ?? "", 10);

  // Parse URL params for display context
  const params = new URLSearchParams(search);
  const supplierName = params.get("supplier") ?? "";
  const entityName = params.get("entity") ?? "";
  const yearParam = parseInt(params.get("year") ?? "0", 10);
  const monthParam = parseInt(params.get("month") ?? "0", 10);
  const currency = params.get("currency") ?? "USD";

  // Local state
  const [selectedExceptionId, setSelectedExceptionId] = useState<number | null>(null);
  const [selectedMatch, setSelectedMatch] = useState<ReconciliationMatch | null>(null);
  const [showCompleteDialog, setShowCompleteDialog] = useState(false);
  const [showReopenDialog, setShowReopenDialog] = useState(false);
  const [showReplaceModal, setShowReplaceModal] = useState(false);

  const queryClient = useQueryClient();

  const sessionQueryKey = ["supplier-recon-session", sessionId];

  const {
    data,
    isLoading,
    isError,
    error,
  } = useQuery<SessionPayload>({
    queryKey: sessionQueryKey,
    queryFn: () =>
      apiFetch(
        `/api/accounting/supplier-reconciliation/sessions/${sessionId}?view=all`,
      ),
    enabled: !isNaN(sessionId),
    staleTime: 20_000,
  });

  const session = data?.session;
  const statement = data?.statement ?? null;
  const balanceSummary = data?.balance_summary;
  const exceptions = data?.exceptions ?? [];
  const matches = data?.matches ?? [];

  // Determine view mode
  const viewOnlyStatuses = [
    "reconciled",
    "ready_to_sync",
    "syncing",
    "synced",
    "sync_failed",
  ];
  const isViewMode = !!session && viewOnlyStatuses.includes(session.status);

  // Derive display info
  const displaySupplierName =
    supplierName || `Supplier #${session?.supplier_id ?? "…"}`;
  const displayEntityName = entityName || "";
  const displayPeriod =
    yearParam && monthParam ? monthLabel(yearParam, monthParam) : "";

  // Find selected exception
  const selectedExc = exceptions.find((e) => e.id === selectedExceptionId) ?? null;

  // Download statement
  async function handleDownload() {
    if (!statement) return;
    try {
      const res = await fetch(
        `/api/accounting/supplier-reconciliation/statements/${statement.id}/download`,
        { credentials: "include" },
      );
      if (!res.ok) throw new Error("Download failed");
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = statement.original_file_name;
      a.click();
      URL.revokeObjectURL(url);
    } catch {
      // silent; toast handled elsewhere
    }
  }

  if (isNaN(sessionId)) {
    return (
      <div className="flex items-center justify-center h-64 text-muted-foreground">
        Invalid session ID.
      </div>
    );
  }

  if (isLoading) {
    return (
      <div className="max-w-[1400px] mx-auto px-6 py-6 space-y-6">
        <Skeleton className="h-6 w-80" />
        <Skeleton className="h-20 w-full" />
        <div className="grid grid-cols-4 gap-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-24 rounded-xl" />
          ))}
        </div>
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }

  if (isError || !session) {
    return (
      <div className="max-w-[1400px] mx-auto px-6 py-6">
        <button
          onClick={() => navigate("/finance/accounting/monthly-closing")}
          className="flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground mb-4"
        >
          <ChevronLeft size={14} />
          Back to Supplier Bills
        </button>
        <div className="flex flex-col items-center justify-center h-64 gap-3 text-center">
          <AlertCircle size={32} className="text-muted-foreground" />
          <p className="text-muted-foreground text-sm">
            {error instanceof Error
              ? error.message
              : "Could not load reconciliation session."}
          </p>
          <Button
            variant="outline"
            size="sm"
            onClick={() => void queryClient.invalidateQueries({ queryKey: sessionQueryKey })}
          >
            <RefreshCw size={13} className="mr-1" />
            Retry
          </Button>
        </div>
      </div>
    );
  }

  // Empty state: no statement
  const noStatement = !statement;
  // Extraction failed
  const extractionFailed = statement?.extraction_status === "failed";
  // Sync failed
  const syncFailed = session.status === "sync_failed";

  return (
    <div className="max-w-[1400px] mx-auto px-6 py-6 space-y-5">
      {/* Breadcrumb */}
      <nav className="flex items-center gap-1.5 text-sm text-muted-foreground">
        <button
          onClick={() => navigate("/finance/accounting/monthly-closing")}
          className="hover:text-foreground transition-colors"
        >
          Monthly Closing
        </button>
        <ChevronLeft size={12} className="rotate-180" />
        <button
          onClick={() => navigate("/finance/accounting/monthly-closing")}
          className="hover:text-foreground transition-colors"
        >
          Supplier Bills
        </button>
        <ChevronLeft size={12} className="rotate-180" />
        <span className="text-foreground font-medium truncate max-w-xs">
          {displaySupplierName}
        </span>
      </nav>

      {/* Page Header */}
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div className="space-y-1">
          <div className="flex items-center gap-3 flex-wrap">
            <h1 className="text-2xl font-semibold">{displaySupplierName}</h1>
            <SessionStatusBadge status={session.status} />
          </div>
          {(displayEntityName || displayPeriod) && (
            <p className="text-sm text-muted-foreground">
              {[displayEntityName, displayPeriod].filter(Boolean).join(" · ")}
            </p>
          )}
        </div>

        {/* Header actions */}
        <div className="flex items-center gap-2 flex-wrap">
          {statement && (
            <Button
              variant="outline"
              size="sm"
              className="gap-2"
              onClick={() => void handleDownload()}
            >
              <Download size={14} />
              Download statement
            </Button>
          )}
          {!isViewMode && (
            <Button
              variant="outline"
              size="sm"
              className="gap-2"
              onClick={() => setShowReplaceModal(true)}
            >
              <Upload size={14} />
              Replace statement
            </Button>
          )}
          {/* Primary action */}
          {!isViewMode && session.status === "needs_review" && (
            <Tooltip>
              <TooltipTrigger asChild>
                <span>
                  <Button
                    size="sm"
                    className="gap-2"
                    disabled={balanceSummary ? balanceSummary.open_exceptions_count > 0 : true}
                    onClick={() => setShowCompleteDialog(true)}
                  >
                    <CheckCircle size={14} />
                    Complete reconciliation
                  </Button>
                </span>
              </TooltipTrigger>
              {balanceSummary && balanceSummary.open_exceptions_count > 0 && (
                <TooltipContent>
                  {balanceSummary.open_exceptions_count} open exception
                  {balanceSummary.open_exceptions_count !== 1 ? "s" : ""} must
                  be resolved first.
                </TooltipContent>
              )}
            </Tooltip>
          )}
          {isFinanceManager &&
            (session.status === "reconciled" ||
              session.status === "ready_to_sync") && (
              <ApproveAndSyncSection
                sessionId={sessionId}
                sessionStatus={session.status}
              />
            )}
          {isViewMode && isFinanceManager && session.status !== "syncing" && (
            <Button
              variant="outline"
              size="sm"
              className="gap-2"
              onClick={() => setShowReopenDialog(true)}
            >
              <RotateCcw size={14} />
              Reopen reconciliation
            </Button>
          )}
        </div>
      </div>

      {/* Statement meta bar */}
      {statement ? (
        <div className="flex items-center gap-4 rounded-lg border bg-muted/30 px-4 py-2.5 text-sm flex-wrap">
          <div className="flex items-center gap-2">
            <FileText size={14} className="text-muted-foreground shrink-0" />
            <span className="font-medium">{statement.original_file_name}</span>
          </div>
          {statement.uploader_email && (
            <span className="text-muted-foreground">
              by {statement.uploader_email}
            </span>
          )}
          <span className="text-muted-foreground">
            {formatDateTime(statement.created_at)}
          </span>
          <span
            className={cn(
              "rounded-full border px-2 py-0.5 text-xs font-medium",
              statement.extraction_status === "extracted"
                ? "border-green-300 text-green-700"
                : statement.extraction_status === "failed"
                  ? "border-red-300 text-red-700"
                  : "border-amber-300 text-amber-700",
            )}
          >
            {statement.extraction_status ?? "pending"}
          </span>
        </div>
      ) : (
        <div className="rounded-lg border border-dashed border-muted-foreground/30 px-4 py-3 text-sm text-muted-foreground">
          No statement uploaded yet.
        </div>
      )}

      {/* Error banners */}
      {extractionFailed && (
        <div className="flex items-start gap-3 rounded-lg border border-red-300 bg-red-50 px-4 py-3">
          <XCircle size={16} className="shrink-0 mt-0.5 text-red-600" />
          <div className="flex-1">
            <p className="text-sm font-medium text-red-800">
              Extraction failed
            </p>
            <p className="text-sm text-red-700 mt-0.5">
              The uploaded statement could not be extracted. Please replace with
              a different file format (PDF, XLSX, or CSV).
            </p>
          </div>
        </div>
      )}
      {syncFailed && (
        <div className="flex items-start gap-3 rounded-lg border border-red-300 bg-red-50 px-4 py-3">
          <XCircle size={16} className="shrink-0 mt-0.5 text-red-600" />
          <div className="flex-1">
            <p className="text-sm font-medium text-red-800">Odoo sync failed</p>
            <p className="text-sm text-red-700 mt-0.5">
              One or more bills could not be synced to Odoo. Retry the sync from
              the header or contact support.
            </p>
            {isFinanceManager && (
              <Button
                size="sm"
                variant="outline"
                className="mt-2 gap-1 text-red-700 border-red-300"
                onClick={async () => {
                  try {
                    await apiFetch(
                      `/api/accounting/supplier-reconciliation/sessions/${sessionId}/sync-to-odoo`,
                      { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({}) },
                    );
                    await queryClient.invalidateQueries({ queryKey: sessionQueryKey });
                  } catch {
                    // toast handled inside
                  }
                }}
              >
                <RefreshCw size={12} />
                Retry sync
              </Button>
            )}
          </div>
        </div>
      )}

      {/* Summary cards */}
      {balanceSummary && (
        <SummaryCards balanceSummary={balanceSummary} currency={currency} />
      )}

      {/* No statement empty state */}
      {noStatement && (
        <div className="flex flex-col items-center justify-center h-48 gap-4 rounded-xl border border-dashed border-muted-foreground/30">
          <FileText size={36} className="text-muted-foreground" />
          <div className="text-center">
            <p className="text-sm font-medium">No statement uploaded</p>
            <p className="text-xs text-muted-foreground mt-1">
              Upload a supplier statement to begin reconciliation.
            </p>
          </div>
          {!isViewMode && (
            <Button
              size="sm"
              className="gap-2"
              onClick={() => setShowReplaceModal(true)}
            >
              <Upload size={13} />
              Upload statement
            </Button>
          )}
        </div>
      )}

      {/* Main content: table + investigation panel */}
      {!noStatement && !extractionFailed && matches.length > 0 && (
        <div
          className={cn(
            "flex gap-0 relative",
            selectedExc ? "items-start" : "",
          )}
        >
          {/* Matching table */}
          <div
            className={cn(
              "min-w-0 transition-all duration-200",
              selectedExc ? "flex-1" : "w-full",
            )}
          >
            <MatchingTable
              matches={matches}
              exceptions={exceptions}
              selectedExceptionId={selectedExceptionId}
              isViewMode={isViewMode}
              onSelectException={(exc, match) => {
                setSelectedExceptionId(exc.id);
                setSelectedMatch(match);
              }}
              sessionId={sessionId}
              currency={currency}
            />
          </div>

          {/* Investigation panel — slide-in right */}
          {selectedExc && (
            <div className="w-[420px] shrink-0 border-l bg-background sticky top-4 self-start max-h-[calc(100vh-8rem)] overflow-hidden flex flex-col rounded-r-lg border border-l-0">
              <InvestigationPanel
                exception={selectedExc}
                match={selectedMatch}
                sessionId={sessionId}
                currency={currency}
                isViewMode={isViewMode}
                onClose={() => {
                  setSelectedExceptionId(null);
                  setSelectedMatch(null);
                }}
                onResolved={() => {
                  // After resolving, stay open so user can review next
                  void queryClient.invalidateQueries({ queryKey: sessionQueryKey });
                }}
              />
            </div>
          )}
        </div>
      )}

      {/* No matches yet (statement uploaded but not matched) */}
      {!noStatement && !extractionFailed && matches.length === 0 && (
        <div className="flex flex-col items-center justify-center h-48 gap-3 rounded-xl border border-dashed border-muted-foreground/30">
          <RefreshCw size={28} className="text-muted-foreground" />
          <div className="text-center">
            <p className="text-sm font-medium">Matching in progress</p>
            <p className="text-xs text-muted-foreground mt-1">
              Statement entries are being matched against OS bills.
            </p>
          </div>
          <Button
            size="sm"
            variant="outline"
            onClick={() => void queryClient.invalidateQueries({ queryKey: sessionQueryKey })}
            className="gap-1"
          >
            <RefreshCw size={12} />
            Refresh
          </Button>
        </div>
      )}

      {/* View mode: audit + preparer/approver info */}
      {isViewMode && (
        <div className="rounded-xl border bg-muted/20 p-5 space-y-5">
          <div className="flex items-center gap-2">
            <History size={16} className="text-muted-foreground" />
            <p className="text-sm font-semibold">Audit Trail</p>
          </div>

          {/* Preparer / Approver */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            {session.prepared_by && (
              <div className="space-y-0.5">
                <p className="text-xs text-muted-foreground uppercase tracking-wide">
                  Prepared by
                </p>
                <p className="text-sm font-medium">{session.prepared_by}</p>
                <p className="text-xs text-muted-foreground">
                  {formatDateTime(session.prepared_at)}
                </p>
              </div>
            )}
            {session.approved_by && (
              <div className="space-y-0.5">
                <p className="text-xs text-muted-foreground uppercase tracking-wide">
                  Approved by
                </p>
                <p className="text-sm font-medium">{session.approved_by}</p>
                <p className="text-xs text-muted-foreground">
                  {formatDateTime(session.approved_at)}
                </p>
              </div>
            )}
          </div>

          {/* Sync status */}
          {session.status === "synced" && (
            <div className="flex items-center gap-2 text-sm text-green-700">
              <CheckCircle2 size={14} />
              Synced to Odoo
            </div>
          )}
          {session.status === "sync_failed" && (
            <div className="flex items-center gap-2 text-sm text-red-700">
              <XCircle size={14} />
              Odoo sync failed — see banner above
            </div>
          )}

          <div className="border-t pt-4">
            <AuditTrail sessionId={sessionId} />
          </div>
        </div>
      )}

      {/* Dialogs */}
      {showCompleteDialog && balanceSummary && (
        <CompleteDialog
          open={showCompleteDialog}
          sessionId={sessionId}
          openExceptionsCount={balanceSummary.open_exceptions_count}
          balanceDiff={balanceSummary.balance_difference}
          differenceAccepted={!!session.difference_accepted_reason}
          isFinanceManager={isFinanceManager}
          onClose={() => setShowCompleteDialog(false)}
          onComplete={() => {
            void queryClient.invalidateQueries({ queryKey: sessionQueryKey });
          }}
        />
      )}
      {showReopenDialog && (
        <ReopenDialog
          open={showReopenDialog}
          sessionId={sessionId}
          currentStatus={session.status}
          onClose={() => setShowReopenDialog(false)}
          onReopened={() => {
            void queryClient.invalidateQueries({ queryKey: sessionQueryKey });
          }}
        />
      )}
      {showReplaceModal && (
        <ReplaceStatementModal
          open={showReplaceModal}
          sessionId={sessionId}
          onClose={() => setShowReplaceModal(false)}
          onSuccess={() => {
            void queryClient.invalidateQueries({ queryKey: sessionQueryKey });
          }}
        />
      )}
    </div>
  );
}

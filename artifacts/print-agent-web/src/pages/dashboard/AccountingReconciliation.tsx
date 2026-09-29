import React, { useState } from "react";
import { useLocation } from "wouter";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Progress } from "@/components/ui/progress";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  AlertTriangle,
  Building2,
  CheckCircle2,
  CircleAlert,
  FileUp,
  Link2Off,
  MoreHorizontal,
  RefreshCw,
  Search,
  Settings2,
  Upload,
  WifiOff,
  XCircle,
} from "lucide-react";
import { apiFetch } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";
import UploadStatementModal from "@/components/lb-bank-recon/UploadStatementModal";
import { useWorkspaceRole } from "@/hooks/use-workspace-role";

// ── Constants ──────────────────────────────────────────────────────────────

const MONTHS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];
const CURRENT_YEAR = new Date().getFullYear();
const YEARS = [CURRENT_YEAR, CURRENT_YEAR - 1, CURRENT_YEAR - 2];

function getMonthLabel(month: number): string {
  return new Date(2000, month - 1, 1).toLocaleString("en-US", { month: "long" });
}

function formatLbp(raw: string | number | null | undefined): string {
  if (raw == null) return "—";
  const n = typeof raw === "string" ? parseFloat(raw) : raw;
  if (isNaN(n)) return "—";
  return (
    new Intl.NumberFormat("en-US", {
      style: "decimal",
      maximumFractionDigits: 0,
    }).format(n) + " LBP"
  );
}

function formatDateShort(dateStr: string | null | undefined): string {
  if (!dateStr) return "—";
  try {
    return new Date(dateStr).toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return dateStr.substring(0, 10);
  }
}

// ── API Response Types (snake_case — exactly matching server responses) ───

type SummaryResponse = {
  month: number;
  year: number;
  total_bank_accounts: number;
  statements_imported: number;
  total_transactions: number;
  matched_count: number;
  synced_count: number;
  unresolved_count: number;
  reconciled_statements: number;
};

/** Row returned by GET /lb-bank-recon/accounts?year=Y&month=M */
type AccountRow = {
  id: number;
  bank_name: string;
  account_name: string;
  masked_account_number: string | null;
  currency: string;
  is_active: boolean;
  is_required_for_close: boolean;
  odoo_journal_id: number | null;
  odoo_journal_name: string | null;
  created_at: string;
  updated_at: string;
  // Lateral-joined statement fields (null when no statement for the period)
  statement_id: number | null;
  original_filename: string | null;
  statement_status: string | null;
  odoo_sync_status: string | null;
  reconciliation_status: string | null;
  reconciled_at: string | null;
  period_start: string | null;
  period_end: string | null;
  total_lines: string | null;
  matched_count: string | null;
  unmatched_count: string | null;
  unclassified_count: string | null;
  synced_count: string | null;
  last_sync_at: string | null;
};

type AccountsResponse = {
  accounts: AccountRow[];
  month?: number;
  year?: number;
};

type OdooConnectionResponse = {
  entity_id: number | null;
  connected: boolean;
  configured: boolean;
  accounting_system?: string;
  legal_name?: string;
  display_name?: string | null;
  odoo_base_url?: string;
  odoo_database?: string | null;
  odoo_company_id?: number | null;
  odoo_company_name?: string | null;
  error: string | null;
  last_sync_at: string | null;
  // JSON-2 health responses can include safe, non-secret diagnostics. Keep
  // these optional so older connection responses remain backwards compatible.
  diagnostics?: Record<string, unknown> | string | null;
  api_version?: string | null;
  api_mode?: string | null;
  protocol?: string | null;
  endpoint?: string | null;
  http_status?: number | null;
  request_id?: string | null;
};

export type OdooJournal = {
  id: number;
  name: string;
  code: string;
  type: string;
  company_id: number;
  company_name: string;
  currency_id: number | null;
  currency_name: string | null;
  default_account_id: number | null;
  default_account_name: string | null;
  bank_account_id: number | null;
  bank_account_name: string | null;
};

type OdooJournalsResponse = {
  journals: OdooJournal[];
  count: number;
};

// ── Derived UI status from DB fields ──────────────────────────────────────

type ReconStatus =
  | "missing"
  | "uploaded"
  | "parsed"
  | "ready_to_sync"
  | "synced"
  | "needs_review"
  | "reconciled";

type OdooSyncStatus = "not_synced" | "partial" | "synced" | "failed" | "n_a";

function deriveReconStatus(row: AccountRow): ReconStatus {
  if (!row.statement_id) return "missing";
  if (row.reconciliation_status === "reconciled") return "reconciled";
  const unclassified = parseInt(row.unclassified_count ?? "0", 10);
  if (unclassified > 0) return "needs_review";
  const sync = row.odoo_sync_status ?? "not_synced";
  if (sync === "synced") return "synced";
  if (sync === "partial" || sync === "failed") return "needs_review";
  const stmtStatus = row.statement_status ?? "";
  if (stmtStatus === "parsed" || stmtStatus === "processing_complete") return "ready_to_sync";
  if (stmtStatus === "uploaded" || stmtStatus === "uploading") return "uploaded";
  return "parsed";
}

function deriveOdooSyncStatus(row: AccountRow): OdooSyncStatus {
  if (!row.statement_id) return "n_a";
  const s = row.odoo_sync_status ?? "not_synced";
  if (s === "synced") return "synced";
  if (s === "partial") return "partial";
  if (s === "failed") return "failed";
  return "not_synced";
}

// ── API Hooks ──────────────────────────────────────────────────────────────

function useLbReconSummary(year: number, month: number) {
  return useQuery<SummaryResponse>({
    queryKey: ["lb-bank-recon-summary", year, month],
    queryFn: () =>
      apiFetch(`/api/lb-bank-recon/summary?year=${year}&month=${month}`),
    staleTime: 30_000,
    retry: 1,
  });
}

function useLbReconAccounts(year: number, month: number) {
  return useQuery<AccountsResponse>({
    queryKey: ["lb-bank-recon-accounts", year, month],
    queryFn: () =>
      apiFetch(`/api/lb-bank-recon/accounts?year=${year}&month=${month}`),
    staleTime: 30_000,
    retry: 1,
  });
}

function useOdooConnection() {
  return useQuery<OdooConnectionResponse>({
    queryKey: ["lb-bank-recon-odoo-connection"],
    queryFn: () => apiFetch("/api/lb-bank-recon/odoo-connection"),
    staleTime: 60_000,
    retry: 1,
  });
}

function useOdooJournals(enabled: boolean) {
  return useQuery<OdooJournalsResponse>({
    queryKey: ["lb-bank-recon-odoo-journals"],
    queryFn: () => apiFetch("/api/lb-bank-recon/odoo-journals"),
    enabled,
    staleTime: 60_000,
    retry: 1,
  });
}

function normalizedMatchValue(value: string | null | undefined): string {
  return (value ?? "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

const NON_DISTINCTIVE_BANK_TOKENS = new Set([
  "account",
  "bank",
  "current",
  "journal",
  "number",
  "statement",
]);

function meaningfulBankTokens(value: string | null | undefined): string[] {
  return normalizedMatchValue(value)
    .split(" ")
    .filter((token) => token.length >= 2 && !NON_DISTINCTIVE_BANK_TOKENS.has(token));
}

function currenciesMatch(accountCurrency: string, journal: OdooJournal): boolean {
  const account = normalizedMatchValue(accountCurrency);
  const journalValues = [journal.currency_name, String(journal.currency_id ?? "")]
    .map(normalizedMatchValue)
    .filter(Boolean);
  if (!account || journalValues.includes(account)) return Boolean(account);

  // Odoo may return a currency's display name while the bank account stores
  // its ISO code. These aliases cover the currencies used by Lebanon banks.
  const aliases: Record<string, string[]> = {
    usd: ["us dollar", "dollar", "840"],
    lbp: ["lebanese pound", "lebanese lira", "422"],
    eur: ["euro", "978"],
  };
  const accountAliases = new Set([account, ...(aliases[account] ?? [])]);
  return journalValues.some((value) => accountAliases.has(value));
}

/**
 * Return a journal only when the bank name and currency identify exactly one
 * candidate. In particular, never silently choose between two same-bank
 * journals in the same currency.
 */
export function findUnambiguousJournalMatch(
  account: Pick<AccountRow, "bank_name" | "currency">,
  journals: OdooJournal[],
): OdooJournal | null {
  const bankName = normalizedMatchValue(account.bank_name);
  if (!bankName) return null;
  const accountBankTokens = meaningfulBankTokens(account.bank_name);

  const candidates = journals.filter((journal) => {
    const journalBankName = journal.bank_account_name || journal.name;
    const journalBankTokens = meaningfulBankTokens(journalBankName);
    const bankMatches =
      normalizedMatchValue(journalBankName) === bankName ||
      (accountBankTokens.length > 0 &&
        accountBankTokens.every((token) => journalBankTokens.includes(token)));
    return bankMatches && currenciesMatch(account.currency, journal);
  });
  return candidates.length === 1 ? candidates[0] : null;
}

// ── Badge Components ───────────────────────────────────────────────────────

const STATUS_CONFIG: Record<ReconStatus, { label: string; className: string }> = {
  missing: {
    label: "Statement missing",
    className: "bg-slate-100 text-slate-600 border-slate-200",
  },
  uploaded: {
    label: "Uploaded",
    className: "bg-blue-50 text-blue-700 border-blue-200",
  },
  parsed: {
    label: "Parsed",
    className: "bg-indigo-50 text-indigo-700 border-indigo-200",
  },
  ready_to_sync: {
    label: "Ready to sync",
    className: "bg-violet-50 text-violet-700 border-violet-200",
  },
  synced: {
    label: "Synced",
    className: "bg-teal-50 text-teal-700 border-teal-200",
  },
  needs_review: {
    label: "Needs review",
    className: "bg-amber-50 text-amber-700 border-amber-200",
  },
  reconciled: {
    label: "Reconciled",
    className: "bg-green-50 text-green-700 border-green-200",
  },
};

const ODOO_SYNC_CONFIG: Record<OdooSyncStatus, { label: string; className: string }> = {
  not_synced: {
    label: "Not synced",
    className: "bg-slate-100 text-slate-600 border-slate-200",
  },
  synced: {
    label: "Synced",
    className: "bg-green-50 text-green-700 border-green-200",
  },
  partial: {
    label: "Partial",
    className: "bg-amber-50 text-amber-700 border-amber-200",
  },
  failed: {
    label: "Failed",
    className: "bg-red-50 text-red-700 border-red-200",
  },
  n_a: {
    label: "N/A",
    className: "bg-slate-50 text-slate-400 border-slate-100",
  },
};

function ReconStatusBadge({ status }: { status: ReconStatus }) {
  const cfg = STATUS_CONFIG[status];
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium whitespace-nowrap",
        cfg.className,
      )}
    >
      {cfg.label}
    </span>
  );
}

function OdooSyncBadge({ status }: { status: OdooSyncStatus }) {
  const cfg = ODOO_SYNC_CONFIG[status];
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium whitespace-nowrap",
        cfg.className,
      )}
    >
      {cfg.label}
    </span>
  );
}

// ── Row Action Menu ────────────────────────────────────────────────────────

function RowActionMenu({
  row,
  reconStatus,
  odooSyncStatus,
  onAction,
}: {
  row: AccountRow;
  reconStatus: ReconStatus;
  odooSyncStatus: OdooSyncStatus;
  onAction: (row: AccountRow, actionKey: string) => void;
}) {
  type Action = { label: string; icon: React.ElementType; key: string };
  const actions: Action[] = [];

  if (reconStatus === "missing") {
    actions.push({ label: "Upload Statement", icon: Upload, key: "upload" });
  } else if (reconStatus === "uploaded" || reconStatus === "parsed") {
    actions.push({ label: "Review Import", icon: Search, key: "review_import" });
  } else if (reconStatus === "ready_to_sync") {
    actions.push({ label: "Review Import", icon: Search, key: "review_import" });
    if (row.statement_id) {
      actions.push({ label: "Sync to Odoo", icon: RefreshCw, key: "sync" });
    }
  } else if (odooSyncStatus === "partial" || odooSyncStatus === "failed") {
    actions.push({ label: "Retry Sync", icon: RefreshCw, key: "retry_sync" });
    actions.push({ label: "View Reconciliation", icon: Search, key: "view_recon" });
  } else if (reconStatus === "needs_review") {
    actions.push({ label: "Review Exceptions", icon: CircleAlert, key: "review_exceptions" });
  } else if (reconStatus === "synced") {
    actions.push({ label: "View Reconciliation", icon: Search, key: "view_recon" });
  } else if (reconStatus === "reconciled") {
    actions.push({ label: "View Reconciliation", icon: Search, key: "view_recon" });
  } else {
    actions.push({ label: "View Details", icon: Search, key: "view" });
  }

  const [primary, ...rest] = actions;
  const PrimaryIcon = primary.icon;

  return (
    <div className="flex items-center gap-1 justify-end">
      <Button
        variant="outline"
        size="sm"
        className="h-7 px-2.5 text-xs gap-1.5"
        onClick={() => onAction(row, primary.key)}
      >
        <PrimaryIcon size={12} />
        {primary.label}
      </Button>
      {rest.length > 0 && (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="outline" size="sm" className="h-7 w-7 p-0">
              <MoreHorizontal size={14} />
              <span className="sr-only">More actions</span>
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            {rest.map((action) => {
              const Icon = action.icon;
              return (
                <DropdownMenuItem
                  key={action.key}
                  className="gap-2"
                  onClick={() => onAction(row, action.key)}
                >
                  <Icon size={14} />
                  {action.label}
                </DropdownMenuItem>
              );
            })}
          </DropdownMenuContent>
        </DropdownMenu>
      )}
    </div>
  );
}

// ── Summary Cards ──────────────────────────────────────────────────────────

function SummaryCard({
  title,
  value,
  subtitle,
  icon: Icon,
  iconClass,
}: {
  title: string;
  value: string;
  subtitle?: string;
  icon?: React.ElementType;
  iconClass?: string;
}) {
  return (
    <Card>
      <CardContent className="pt-5 pb-4">
        <div className="flex items-start justify-between gap-2">
          <div className="flex-1 min-w-0">
            <p className="text-xs text-muted-foreground uppercase tracking-wide mb-1">{title}</p>
            <p className="text-2xl font-semibold truncate">{value}</p>
            {subtitle && (
              <p className="text-xs text-muted-foreground mt-0.5">{subtitle}</p>
            )}
          </div>
          {Icon && (
            <div className={cn("rounded-full p-2 shrink-0", iconClass ?? "bg-muted")}>
              <Icon size={16} />
            </div>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

function SummaryCardSkeleton() {
  return (
    <Card>
      <CardContent className="pt-5 pb-4">
        <Skeleton className="h-3 w-24 mb-2" />
        <Skeleton className="h-8 w-16 mb-1" />
        <Skeleton className="h-3 w-20" />
      </CardContent>
    </Card>
  );
}

// ── Account Table Skeleton ─────────────────────────────────────────────────

function AccountTableSkeleton() {
  return (
    <div className="overflow-x-auto rounded-md border">
      <Table>
        <TableHeader>
          <TableRow>
            {[
              "Account", "Currency", "Statement Period",
              "Odoo Journal", "Imported", "Matched", "Difference",
              "Odoo Sync", "Status", "",
            ].map((h) => (
              <TableHead key={h} className="whitespace-nowrap">{h}</TableHead>
            ))}
          </TableRow>
        </TableHeader>
        <TableBody>
          {Array.from({ length: 4 }).map((_, i) => (
            <TableRow key={i}>
              {Array.from({ length: 10 }).map((_, j) => (
                <TableCell key={j}><Skeleton className="h-4 w-full" /></TableCell>
              ))}
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

// ── Derived Close Checklist from Summary Data ──────────────────────────────

type ChecklistItem = { id: string; label: string; passed: boolean };

function buildCloseChecklist(
  summary: SummaryResponse,
  totalAccounts: number,
): ChecklistItem[] {
  const allStatementsIn = summary.statements_imported >= totalAccounts;
  const allMatched =
    summary.total_transactions > 0 &&
    summary.matched_count >= summary.total_transactions;
  const nothingUnresolved = summary.unresolved_count === 0;
  const allSynced =
    summary.total_transactions > 0 &&
    summary.synced_count >= summary.total_transactions;
  const allReconciled =
    summary.statements_imported > 0 &&
    summary.reconciled_statements >= summary.statements_imported;

  return [
    {
      id: "statements_in",
      label: `All bank statements imported (${summary.statements_imported} / ${totalAccounts})`,
      passed: allStatementsIn,
    },
    {
      id: "transactions_matched",
      label: `All transactions matched (${summary.matched_count} / ${summary.total_transactions})`,
      passed: allMatched,
    },
    {
      id: "no_unresolved",
      label: `No unresolved exceptions (${summary.unresolved_count} outstanding)`,
      passed: nothingUnresolved,
    },
    {
      id: "synced_to_odoo",
      label: `All transactions synced to Odoo (${summary.synced_count} / ${summary.total_transactions})`,
      passed: allSynced,
    },
    {
      id: "reconciled",
      label: `All statements reconciled (${summary.reconciled_statements} / ${summary.statements_imported})`,
      passed: allReconciled,
    },
  ];
}

// ── Close Progress Panel ───────────────────────────────────────────────────

function CloseProgressPanel({
  monthLabel,
  checklist,
}: {
  monthLabel: string;
  checklist: ChecklistItem[];
}) {
  const passed = checklist.filter((c) => c.passed).length;
  const total = checklist.length;
  const pct = total > 0 ? Math.round((passed / total) * 100) : 0;

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-sm font-semibold">{monthLabel} close progress</CardTitle>
        <div className="flex items-center justify-between text-xs text-muted-foreground mt-0.5">
          <span>{passed} / {total} complete</span>
          <span className={pct === 100 ? "text-green-600 font-medium" : ""}>{pct}%</span>
        </div>
        <Progress value={pct} className="h-1.5 mt-2" />
      </CardHeader>
      <CardContent className="pt-0 space-y-2.5">
        {checklist.map((item) => (
          <div key={item.id} className="flex items-start gap-2">
            {item.passed ? (
              <CheckCircle2 size={15} className="text-green-600 mt-0.5 shrink-0" />
            ) : (
              <XCircle size={15} className="text-muted-foreground/40 mt-0.5 shrink-0" />
            )}
            <span
              className={cn(
                "text-xs leading-relaxed",
                item.passed ? "text-muted-foreground line-through" : "",
              )}
            >
              {item.label}
            </span>
          </div>
        ))}
      </CardContent>
    </Card>
  );
}

function CloseProgressPanelSkeleton() {
  return (
    <Card>
      <CardHeader className="pb-3">
        <Skeleton className="h-4 w-40 mb-2" />
        <Skeleton className="h-1.5 w-full mt-2" />
      </CardHeader>
      <CardContent className="pt-0 space-y-2.5">
        {Array.from({ length: 5 }).map((_, i) => (
          <Skeleton key={i} className="h-4 w-full" />
        ))}
      </CardContent>
    </Card>
  );
}

// ── Odoo Connection Panel ──────────────────────────────────────────────────

function safeConnectionError(error: string | null | undefined): string | null {
  if (!error) return null;
  // Older deployments returned an implementation detail about a custom
  // addon. The JSON-2 connection is no longer addon-dependent, so do not
  // surface that obsolete guidance in this screen.
  if (/custom addon|bank reconciliation addon|install or enable.*addon/i.test(error)) {
    return "Odoo JSON-2 connection check failed. Review the diagnostics below.";
  }
  return error;
}

function formatDiagnosticValue(value: unknown): string {
  if (value == null) return "—";
  if (typeof value === "string") {
    return safeConnectionError(value) ?? "—";
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  try {
    return safeConnectionError(JSON.stringify(value)) ?? "—";
  } catch {
    return "Unavailable";
  }
}

function connectionDiagnostics(connection: OdooConnectionResponse): Array<[string, string]> {
  const direct: Array<[string, unknown]> = [
    ["API", connection.api_version ?? connection.api_mode],
    ["Protocol", connection.protocol],
    ["Endpoint", connection.endpoint],
    ["HTTP status", connection.http_status],
    ["Request ID", connection.request_id],
  ];
  const entries = direct
    .filter(([, value]) => value != null && value !== "")
    .map(([label, value]) => [label, formatDiagnosticValue(value)] as [string, string]);

  if (typeof connection.diagnostics === "string" && connection.diagnostics.trim()) {
    entries.push(["Details", connection.diagnostics]);
  } else if (connection.diagnostics && typeof connection.diagnostics === "object") {
    for (const [key, value] of Object.entries(connection.diagnostics)) {
      if (/token|secret|password|credential/i.test(key) || value == null || value === "") continue;
      const label = key.replace(/[_-]+/g, " ").replace(/\b\w/g, (char) => char.toUpperCase());
      if (!entries.some(([existing]) => existing.toLowerCase() === label.toLowerCase())) {
        entries.push([label, formatDiagnosticValue(value)]);
      }
    }
  }
  return entries;
}

export function OdooConnectionPanel({
  connection,
  onRefresh,
  onConfigure,
  canConfigure,
  isRefreshing,
  isError = false,
}: {
  connection: OdooConnectionResponse | undefined;
  onRefresh: () => Promise<void>;
  onConfigure: () => void;
  canConfigure: boolean;
  isRefreshing: boolean;
  isError?: boolean;
}) {
  if (!connection) {
    if (isError) {
      return (
        <Card>
          <CardContent className="pt-5 pb-4">
            <p className="text-xs text-muted-foreground uppercase tracking-wide mb-1">
              Odoo connection
            </p>
            <p className="text-sm font-medium text-red-600">Unable to load connection diagnostics.</p>
            <p className="text-xs text-muted-foreground mt-1">
              Refresh the page or check the Odoo JSON-2 configuration.
            </p>
          </CardContent>
        </Card>
      );
    }
    return (
      <Card>
        <CardContent className="pt-5 pb-4">
          <Skeleton className="h-3 w-32 mb-2" />
          <Skeleton className="h-5 w-24 mb-2" />
          <Skeleton className="h-3 w-48 mb-3" />
          <Skeleton className="h-8 w-28" />
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardContent className="pt-5 pb-4">
        <div className="mb-3">
          <p className="text-xs text-muted-foreground uppercase tracking-wide mb-1">
            Odoo connection
          </p>
          <div className="flex items-center gap-1.5 mb-1">
            {connection.connected ? (
              <>
                <span className="inline-block w-2 h-2 rounded-full bg-green-500 shrink-0" />
                <span className="text-sm font-medium text-green-700">Connected</span>
              </>
            ) : (
              <>
                <WifiOff size={14} className="text-red-500 shrink-0" />
                <span className="text-sm font-medium text-red-600">
                  {connection.configured ? "Disconnected" : "Not configured"}
                </span>
              </>
            )}
          </div>
          {connection.odoo_company_name && (
            <p className="text-xs text-muted-foreground">
              {connection.odoo_company_name}
            </p>
          )}
          {connection.odoo_base_url && (
            <p className="text-xs text-muted-foreground truncate max-w-[220px]">
              {connection.odoo_base_url}
            </p>
          )}
          {safeConnectionError(connection.error) && (
            <p className="text-xs text-red-500 mt-1 line-clamp-2">{safeConnectionError(connection.error)}</p>
          )}
          {connectionDiagnostics(connection).length > 0 && (
            <div className="mt-2 space-y-1 border-t pt-2" data-testid="odoo-json2-diagnostics">
              <p className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                JSON-2 diagnostics
              </p>
              {connectionDiagnostics(connection).map(([label, value]) => (
                <div key={label} className="flex items-start justify-between gap-2 text-[11px]">
                  <span className="text-muted-foreground">{label}</span>
                  <span className="text-right break-all" data-testid={`odoo-diagnostic-${label.toLowerCase().replace(/\s+/g, "-")}`}>
                    {value}
                  </span>
                </div>
              ))}
            </div>
          )}
          {connection.last_sync_at && (
            <p className="text-xs text-muted-foreground mt-1">
              Last sync: {formatDateShort(connection.last_sync_at)}
            </p>
          )}
        </div>
        <div className="flex flex-wrap gap-2">
          <Button
            size="sm"
            className="h-7 px-3 text-xs gap-1.5"
            onClick={onConfigure}
            disabled={!canConfigure}
          >
            <Settings2 size={12} />
            {connection.configured ? "Edit Odoo settings" : "Configure Odoo"}
          </Button>
          <Button
            variant="outline"
            size="sm"
            className="h-7 px-3 text-xs gap-1.5"
            onClick={() => void onRefresh()}
            disabled={isRefreshing || !connection.configured}
          >
            <RefreshCw size={12} className={isRefreshing ? "animate-spin" : ""} />
            {isRefreshing ? "Checking…" : "Check connection"}
          </Button>
        </div>
        {!canConfigure && (
          <p className="text-xs text-muted-foreground mt-2">
            Only workspace owners can create or change Odoo credentials.
          </p>
        )}
      </CardContent>
    </Card>
  );
}

type OdooConfigurationForm = {
  legal_name: string;
  display_name: string;
  odoo_base_url: string;
  odoo_database: string;
  odoo_company_id: string;
  odoo_company_name: string;
};

const EMPTY_ODOO_CONFIGURATION: OdooConfigurationForm = {
  legal_name: "Presentail SAL",
  display_name: "Presentail Lebanon",
  odoo_base_url: "",
  odoo_database: "",
  odoo_company_id: "",
  odoo_company_name: "",
};

function formFromConnection(connection: OdooConnectionResponse | undefined): OdooConfigurationForm {
  return {
    legal_name: connection?.legal_name ?? EMPTY_ODOO_CONFIGURATION.legal_name,
    display_name: connection?.display_name ?? EMPTY_ODOO_CONFIGURATION.display_name,
    odoo_base_url: connection?.odoo_base_url ?? "",
    odoo_database: connection?.odoo_database ?? "",
    odoo_company_id: connection?.odoo_company_id != null ? String(connection.odoo_company_id) : "",
    odoo_company_name: connection?.odoo_company_name ?? "",
  };
}

export function OdooConfigurationDialog({
  open,
  onOpenChange,
  connection,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  connection: OdooConnectionResponse | undefined;
  onSaved: () => Promise<void>;
}) {
  const [form, setForm] = useState<OdooConfigurationForm>(() => formFromConnection(connection));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  React.useEffect(() => {
    if (open) {
      setForm(formFromConnection(connection));
      setError(null);
    }
  }, [open, connection]);

  function setField<K extends keyof OdooConfigurationForm>(
    field: K,
    value: OdooConfigurationForm[K],
  ) {
    setForm((current) => ({ ...current, [field]: value }));
  }

  async function handleSave() {
    const requiredFields: Array<[string, string]> = [
      [form.legal_name, "Legal name"],
      [form.display_name, "Display name"],
      [form.odoo_base_url, "Odoo base URL"],
      [form.odoo_database, "Database name"],
      [form.odoo_company_id, "Company ID"],
      [form.odoo_company_name, "Company name"],
    ];
    const missing = requiredFields.find(([value]) => !value.trim());
    if (missing) {
      setError(`${missing[1]} is required.`);
      return;
    }
    let parsedUrl: URL;
    try {
      parsedUrl = new URL(form.odoo_base_url.trim());
      if (parsedUrl.protocol !== "https:") throw new Error("invalid protocol");
    } catch {
      setError("Enter a valid public Odoo URL beginning with https://.");
      return;
    }

    const companyId = Number(form.odoo_company_id);
    if (!Number.isInteger(companyId) || companyId <= 0) {
      setError("Company ID must be a positive whole number.");
      return;
    }

    setSaving(true);
    setError(null);
    try {
      const payload: Record<string, unknown> = {
        legal_name: form.legal_name.trim(),
        display_name: form.display_name.trim(),
        country: "LB",
        accounting_system: "odoo",
        odoo_base_url: parsedUrl.toString().replace(/\/$/, ""),
        odoo_database: form.odoo_database.trim(),
        odoo_company_id: companyId,
        odoo_company_name: form.odoo_company_name.trim(),
        default_currency: "USD",
        is_active: true,
      };
      const entityId = connection?.entity_id;
      await apiFetch(
        entityId ? `/api/finance/entities/${entityId}` : "/api/finance/entities",
        {
          method: entityId ? "PATCH" : "POST",
          body: JSON.stringify(payload),
        },
      );
      await onSaved();
      onOpenChange(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to save the Odoo configuration.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(nextOpen) => !saving && onOpenChange(nextOpen)}>
      <DialogContent className="sm:max-w-lg max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{connection?.configured ? "Edit Odoo settings" : "Configure Odoo"}</DialogTitle>
          <DialogDescription>
            These settings are stored on the active Lebanon finance entity and checked through Odoo’s
            supported JSON-2 API.
          </DialogDescription>
        </DialogHeader>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 py-2">
          <div className="sm:col-span-2">
            <Label htmlFor="odoo-legal-name">Legal name *</Label>
            <Input
              id="odoo-legal-name"
              value={form.legal_name}
              onChange={(event) => setField("legal_name", event.target.value)}
            />
          </div>
          <div className="sm:col-span-2">
            <Label htmlFor="odoo-display-name">Display name *</Label>
            <Input
              id="odoo-display-name"
              value={form.display_name}
              onChange={(event) => setField("display_name", event.target.value)}
            />
          </div>
          <div>
            <Label htmlFor="odoo-country">Country</Label>
            <Input id="odoo-country" value="Lebanon (LB)" disabled />
          </div>
          <div>
            <Label htmlFor="odoo-system">Accounting system</Label>
            <Input id="odoo-system" value="Odoo" disabled />
          </div>
          <div className="sm:col-span-2">
            <Label htmlFor="odoo-base-url">Odoo base URL *</Label>
            <Input
              id="odoo-base-url"
              type="url"
              placeholder="https://odoo.example.com"
              value={form.odoo_base_url}
              onChange={(event) => setField("odoo_base_url", event.target.value)}
            />
          </div>
          <div>
            <Label htmlFor="odoo-database">Database name *</Label>
            <Input
              id="odoo-database"
              value={form.odoo_database}
              onChange={(event) => setField("odoo_database", event.target.value)}
            />
          </div>
          <div>
            <Label htmlFor="odoo-company-id">Company ID *</Label>
            <Input
              id="odoo-company-id"
              type="number"
              min={1}
              step={1}
              value={form.odoo_company_id}
              onChange={(event) => setField("odoo_company_id", event.target.value)}
            />
          </div>
          <div className="sm:col-span-2">
            <Label htmlFor="odoo-company-name">Company name *</Label>
            <Input
              id="odoo-company-name"
              value={form.odoo_company_name}
              onChange={(event) => setField("odoo_company_name", event.target.value)}
            />
          </div>
        </div>

        {error && (
          <div role="alert" className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
            {error}
          </div>
        )}

        <DialogFooter className="gap-2 sm:gap-0">
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>
            Cancel
          </Button>
          <Button onClick={() => void handleSave()} disabled={saving}>
            {saving ? "Saving and checking…" : "Save and check connection"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

type JournalMappingValue = {
  id: number;
  name: string;
} | null;

function JournalMappingSelect({
  account,
  journals,
  isLoading,
  isError,
  isEmpty,
  selected,
  suggested,
  onSaved,
}: {
  account: AccountRow;
  journals: OdooJournal[];
  isLoading: boolean;
  isError: boolean;
  isEmpty: boolean;
  selected: JournalMappingValue | undefined;
  suggested: OdooJournal | null;
  onSaved: (value: JournalMappingValue) => void;
}) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const effective = selected !== undefined ? selected : suggested;
  const mutation = useMutation({
    mutationFn: (value: JournalMappingValue) =>
      apiFetch(`/api/lb-bank-recon/accounts/${account.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          odoo_journal_id: value?.id ?? null,
          odoo_journal_name: value?.name ?? null,
        }),
      }),
    onSuccess: (_, value) => {
      onSaved(value);
      void queryClient.invalidateQueries({ queryKey: ["lb-bank-recon-accounts"] });
      toast({ title: value ? "Journal mapping updated" : "Journal mapping cleared" });
    },
    onError: (error: Error) => {
      toast({
        title: "Failed to update journal mapping",
        description: error.message,
        variant: "destructive",
      });
    },
  });

  if (isLoading) {
    return <Skeleton className="h-8 w-[190px]" data-testid={`journal-loading-${account.id}`} />;
  }
  if (isError) {
    return (
      <span className="text-xs text-red-600" data-testid={`journal-error-${account.id}`}>
        Unable to load Odoo journals
      </span>
    );
  }
  if (isEmpty && !effective) {
    return (
      <span className="text-xs text-muted-foreground" data-testid={`journal-empty-${account.id}`}>
        No Odoo bank journals available
      </span>
    );
  }

  const currentValue = effective ? String(effective.id) : "none";
  const hasCurrentJournal = effective
    ? journals.some((journal) => journal.id === effective.id)
    : false;
  const isSuggested = selected === undefined && suggested !== null;

  return (
    <div className="space-y-1">
      <Select
        value={currentValue}
        onValueChange={(value) => {
          if (value === "none") {
            mutation.mutate(null);
            return;
          }
          const journal = journals.find((candidate) => String(candidate.id) === value);
          if (journal) mutation.mutate({ id: journal.id, name: journal.name });
        }}
        disabled={mutation.isPending}
      >
        <SelectTrigger
          className="h-8 min-w-[190px] max-w-[240px] text-xs"
          data-testid={`select-journal-${account.id}`}
          aria-label={`Odoo journal for ${account.bank_name}`}
        >
          <SelectValue placeholder="Select Odoo journal" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="none">Not mapped</SelectItem>
          {effective && !hasCurrentJournal && (
            <SelectItem value={String(effective.id)}>{effective.name}</SelectItem>
          )}
          {journals.map((journal) => (
            <SelectItem key={journal.id} value={String(journal.id)}>
              {journal.name} ({journal.code})
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {isSuggested && (
        <p
          className="text-[10px] text-muted-foreground"
          data-testid={`journal-suggestion-${account.id}`}
        >
          Suggested match · not saved
        </p>
      )}
    </div>
  );
}

// ── Main Page ──────────────────────────────────────────────────────────────

export default function AccountingReconciliationPage() {
  const [, navigate] = useLocation();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const { realIsOwner } = useWorkspaceRole();

  const now = new Date();
  const [selectedYear, setSelectedYear] = useState(now.getFullYear());
  const [selectedMonth, setSelectedMonth] = useState(now.getMonth() + 1);
  const [uploadOpen, setUploadOpen] = useState(false);
  const [odooConfigOpen, setOdooConfigOpen] = useState(false);
  const [preselectedAccountId, setPreselectedAccountId] = useState<number | null>(null);
  const [journalOverrides, setJournalOverrides] = useState<
    Record<number, JournalMappingValue>
  >({});

  const summaryQuery = useLbReconSummary(selectedYear, selectedMonth);
  const accountsQuery = useLbReconAccounts(selectedYear, selectedMonth);
  const odooQuery = useOdooConnection();

  const summary = summaryQuery.data;
  const accounts = accountsQuery.data?.accounts ?? [];
  const odooConnection = odooQuery.data;
  const canLoadJournals = Boolean(odooConnection?.configured && odooConnection.connected);
  const journalsQuery = useOdooJournals(canLoadJournals);
  // The endpoint is scoped to Presentail's Odoo company 2. Filtering here as
  // well protects the mapping UI if a deployment returns other companies.
  const journals = (journalsQuery.data?.journals ?? []).filter(
    (journal) => journal.company_id === 2,
  );
  const selectedMonthLabel = getMonthLabel(selectedMonth);

  // Compute missing statement count from summary data
  const missingStatements = summary
    ? Math.max(0, summary.total_bank_accounts - summary.statements_imported)
    : 0;

  // Build the close checklist from summary data
  const closeChecklist =
    summary ? buildCloseChecklist(summary, summary.total_bank_accounts) : [];

  async function handleRefreshOdoo() {
    const result = await odooQuery.refetch();
    if (result.data?.connected) {
      toast({ title: "Odoo connection successful" });
    } else {
      toast({
        title: result.data?.configured ? "Odoo connection failed" : "Odoo is not configured",
        description: safeConnectionError(result.data?.error) ?? "Check the saved Odoo settings.",
        variant: "destructive",
      });
    }
  }

  async function handleOdooSaved() {
    await queryClient.invalidateQueries({ queryKey: ["finance-entities"] });
    const result = await odooQuery.refetch();
    if (result.data?.connected) {
      toast({
        title: "Odoo configured and connected",
        description: "New bank-statement syncs will use these production settings.",
      });
    } else {
      toast({
        title: "Odoo settings saved, but the connection failed",
        description: safeConnectionError(result.data?.error) ?? "Check the saved endpoint and credentials.",
        variant: "destructive",
      });
    }
  }

  function handleOpenUpload() {
    setPreselectedAccountId(null);
    setUploadOpen(true);
  }

  function handleUploadSuccess(statementId: number) {
    void queryClient.invalidateQueries({
      queryKey: ["lb-bank-recon-accounts", selectedYear, selectedMonth],
    });
    void queryClient.invalidateQueries({
      queryKey: ["lb-bank-recon-summary", selectedYear, selectedMonth],
    });
    navigate(`/finance/accounting/reconciliation/review/${statementId}`);
  }

  function handleRowAction(row: AccountRow, actionKey: string) {
    if (actionKey === "upload") {
      setPreselectedAccountId(row.id);
      setUploadOpen(true);
    } else if (row.statement_id) {
      // review_import, view_recon, review_exceptions, sync, retry_sync, view
      navigate(`/finance/accounting/reconciliation/review/${row.statement_id}`);
    }
  }

  return (
    <div className="flex flex-col gap-6 p-6 max-w-[1600px] mx-auto">
      {/* ── Page Header ── */}
      <div className="flex flex-col gap-1 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h1 className="text-xl font-semibold">Lebanon Bank Reconciliation</h1>
          <p className="text-sm text-muted-foreground mt-0.5">
            Import bank statements, match transactions, and sync reconciled activity to Odoo.
          </p>
        </div>
        <div className="flex items-center gap-2 flex-wrap mt-2 sm:mt-0 shrink-0">
          {/* Year dropdown */}
          <Select
            value={String(selectedYear)}
            onValueChange={(v) => setSelectedYear(Number(v))}
          >
            <SelectTrigger className="h-8 w-[90px] text-sm">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {YEARS.map((y) => (
                <SelectItem key={y} value={String(y)}>{y}</SelectItem>
              ))}
            </SelectContent>
          </Select>

          {/* Month dropdown */}
          <Select
            value={String(selectedMonth)}
            onValueChange={(v) => setSelectedMonth(Number(v))}
          >
            <SelectTrigger className="h-8 w-[120px] text-sm">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {MONTHS.map((m) => (
                <SelectItem key={m} value={String(m)}>{getMonthLabel(m)}</SelectItem>
              ))}
            </SelectContent>
          </Select>

          <Button variant="outline" size="sm" className="h-8 text-sm">
            View Monthly Close
          </Button>
          <Button size="sm" className="h-8 text-sm gap-1.5" onClick={handleOpenUpload}>
            <FileUp size={14} />
            Upload Statement
          </Button>
        </div>
      </div>

      {/* ── Odoo disconnected warning ── */}
      {odooQuery.isSuccess && !odooConnection?.connected && (
        <div className="flex items-start gap-3 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm">
          <Link2Off size={16} className="text-red-600 mt-0.5 shrink-0" />
          <div>
            <p className="font-medium text-red-700">Odoo is not connected</p>
            <p className="text-red-600 text-xs mt-0.5">
              {safeConnectionError(odooConnection?.error) ??
                "Bank reconciliation data cannot be synced until the Odoo connection is restored."}
            </p>
          </div>
        </div>
      )}

      {/* ── Missing statements warning banner ── */}
      {summary && missingStatements > 0 && (
        <div className="flex items-start gap-3 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm">
          <AlertTriangle size={16} className="text-amber-600 mt-0.5 shrink-0" />
          <p className="text-amber-800">
            <span className="font-medium">
              {missingStatements} bank statement
              {missingStatements !== 1 ? "s are" : " is"} still required
            </span>{" "}
            before {selectedMonthLabel} can be closed.
          </p>
        </div>
      )}

      {/* ── Summary Cards ── */}
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        {summaryQuery.isLoading ? (
          <>
            <SummaryCardSkeleton />
            <SummaryCardSkeleton />
            <SummaryCardSkeleton />
            <SummaryCardSkeleton />
          </>
        ) : summaryQuery.isError ? (
          <div className="col-span-4 text-sm text-muted-foreground">
            Failed to load summary.
          </div>
        ) : summary ? (
          <>
            <SummaryCard
              title="Bank Accounts"
              value={String(summary.total_bank_accounts)}
              subtitle="Configured for Lebanon"
              icon={Building2}
              iconClass="bg-blue-50 text-blue-600"
            />
            <SummaryCard
              title="Statements Imported"
              value={`${summary.statements_imported} / ${summary.total_bank_accounts}`}
              subtitle={
                summary.statements_imported >= summary.total_bank_accounts
                  ? "All statements received"
                  : `${missingStatements} outstanding`
              }
              icon={FileUp}
              iconClass="bg-indigo-50 text-indigo-600"
            />
            <SummaryCard
              title="Transactions Matched"
              value={`${summary.matched_count} / ${summary.total_transactions}`}
              subtitle={
                summary.total_transactions > 0
                  ? `${Math.round((summary.matched_count / summary.total_transactions) * 100)}% matched`
                  : "No transactions yet"
              }
              icon={CheckCircle2}
              iconClass="bg-teal-50 text-teal-600"
            />
            <SummaryCard
              title="Unresolved"
              value={String(summary.unresolved_count)}
              subtitle={
                summary.unresolved_count === 0
                  ? "Nothing outstanding"
                  : "Require attention"
              }
              icon={summary.unresolved_count > 0 ? CircleAlert : CheckCircle2}
              iconClass={
                summary.unresolved_count > 0
                  ? "bg-amber-50 text-amber-600"
                  : "bg-green-50 text-green-600"
              }
            />
          </>
        ) : null}
      </div>

      {/* ── Main content: table + right panels ── */}
      <div className="grid grid-cols-1 gap-6 xl:grid-cols-[1fr_280px]">
        {/* Account table */}
        <div className="min-w-0">
          {accountsQuery.isLoading ? (
            <AccountTableSkeleton />
          ) : accountsQuery.isError ? (
            <div className="rounded-md border p-8 text-center text-sm text-muted-foreground">
              Failed to load accounts. Please refresh.
            </div>
          ) : accounts.length === 0 ? (
            <div className="rounded-md border p-12 text-center">
              <Building2 className="mx-auto mb-3 text-muted-foreground" size={32} />
              <p className="font-medium text-sm">No bank accounts configured</p>
              <p className="text-xs text-muted-foreground mt-1">
                Contact your system administrator to set up Lebanese bank account connections.
              </p>
            </div>
          ) : (
            <div className="overflow-x-auto rounded-md border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="min-w-[200px]">Account</TableHead>
                    <TableHead className="whitespace-nowrap">Currency</TableHead>
                    <TableHead className="whitespace-nowrap min-w-[120px]">
                      Statement Period
                    </TableHead>
                    <TableHead className="whitespace-nowrap min-w-[220px]">
                      Odoo Journal
                    </TableHead>
                    <TableHead className="whitespace-nowrap text-right">Imported</TableHead>
                    <TableHead className="whitespace-nowrap text-right">Matched</TableHead>
                    <TableHead className="whitespace-nowrap text-right min-w-[140px]">
                      Difference
                    </TableHead>
                    <TableHead className="whitespace-nowrap">Odoo Sync</TableHead>
                    <TableHead className="whitespace-nowrap">Status</TableHead>
                    <TableHead className="text-right min-w-[160px]">Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {accounts.map((row) => {
                    const reconStatus = deriveReconStatus(row);
                    const odooSyncStatus = deriveOdooSyncStatus(row);
                    const totalLines = row.total_lines
                      ? parseInt(row.total_lines, 10)
                      : null;
                    const matchedCount = row.matched_count
                      ? parseInt(row.matched_count, 10)
                      : null;
                    // Difference = unmatched LBP lines total; we represent as
                    // unmatched_count for now (raw DB has no pre-computed LBP diff)
                    const unmatchedCount = row.unmatched_count
                      ? parseInt(row.unmatched_count, 10)
                      : null;

                    return (
                      <TableRow key={row.id}>
                        {/* Account */}
                        <TableCell>
                          <div className="flex flex-col gap-0.5">
                            <span className="font-medium text-sm">{row.bank_name}</span>
                            <div className="flex items-center gap-1.5 flex-wrap">
                              <span className="font-mono text-xs text-muted-foreground">
                                {row.account_name}
                                {row.masked_account_number
                                  ? ` · ${row.masked_account_number}`
                                  : ""}
                              </span>
                              <Badge
                                variant="outline"
                                className="text-[10px] px-1.5 py-0 h-4 border-violet-200 text-violet-700 bg-violet-50"
                              >
                                Presentail SAL
                              </Badge>
                            </div>
                          </div>
                        </TableCell>

                        {/* Currency */}
                        <TableCell className="text-sm font-mono">
                          {row.currency}
                        </TableCell>

                        {/* Statement Period */}
                        <TableCell className="text-sm text-muted-foreground whitespace-nowrap">
                          {row.period_start && row.period_end ? (
                            <>
                              {new Date(row.period_start).toLocaleDateString("en-US", {
                                month: "short",
                                day: "numeric",
                              })}
                              {" – "}
                              {new Date(row.period_end).toLocaleDateString("en-US", {
                                month: "short",
                                day: "numeric",
                              })}
                            </>
                          ) : (
                            <span className="text-slate-400 italic text-xs">Not set</span>
                          )}
                        </TableCell>

                        {/* Odoo Journal mapping */}
                        <TableCell>
                          <JournalMappingSelect
                            account={row}
                            journals={journals}
                            isLoading={
                              odooQuery.isLoading ||
                              journalsQuery.isLoading ||
                              journalsQuery.isFetching
                            }
                            isError={odooQuery.isError || (odooQuery.isSuccess && journalsQuery.isError)}
                            isEmpty={
                              odooQuery.isSuccess &&
                              (!canLoadJournals ||
                                (journalsQuery.isSuccess && journals.length === 0))
                            }
                            selected={(() => {
                              if (Object.prototype.hasOwnProperty.call(journalOverrides, row.id)) {
                                return journalOverrides[row.id];
                              }
                              return row.odoo_journal_id != null
                                ? {
                                    id: row.odoo_journal_id,
                                    name: row.odoo_journal_name ?? `Journal ${row.odoo_journal_id}`,
                                  }
                                : undefined;
                            })()}
                            suggested={
                              row.odoo_journal_id == null &&
                              !Object.prototype.hasOwnProperty.call(journalOverrides, row.id)
                                ? findUnambiguousJournalMatch(row, journals)
                                : null
                            }
                            onSaved={(value) =>
                              setJournalOverrides((current) => ({
                                ...current,
                                [row.id]: value,
                              }))
                            }
                          />
                        </TableCell>

                        {/* Imported (total posted lines) */}
                        <TableCell className="text-right tabular-nums text-sm">
                          {totalLines ?? "—"}
                        </TableCell>

                        {/* Matched */}
                        <TableCell className="text-right tabular-nums text-sm">
                          {matchedCount != null && totalLines != null ? (
                            <span
                              className={cn(
                                "tabular-nums",
                                matchedCount < totalLines
                                  ? "text-amber-600"
                                  : "text-green-700",
                              )}
                            >
                              {matchedCount}
                            </span>
                          ) : (
                            "—"
                          )}
                        </TableCell>

                        {/* Difference — unmatched count in LBP context */}
                        <TableCell className="text-right tabular-nums text-sm font-mono text-muted-foreground">
                          {unmatchedCount != null
                            ? unmatchedCount === 0
                              ? "0 LBP"
                              : `${unmatchedCount.toLocaleString("en-US")} unmatched`
                            : "—"}
                        </TableCell>

                        {/* Odoo Sync */}
                        <TableCell>
                          <OdooSyncBadge status={odooSyncStatus} />
                        </TableCell>

                        {/* Status */}
                        <TableCell>
                          <ReconStatusBadge status={reconStatus} />
                        </TableCell>

                        {/* Actions */}
                        <TableCell>
                          <RowActionMenu
                            row={row}
                            reconStatus={reconStatus}
                            odooSyncStatus={odooSyncStatus}
                            onAction={handleRowAction}
                          />
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </div>
          )}
        </div>

        {/* Right panels */}
        <div className="flex flex-col gap-4 min-w-0">
          {/* Close progress */}
          {summaryQuery.isLoading ? (
            <CloseProgressPanelSkeleton />
          ) : summary ? (
            <CloseProgressPanel
              monthLabel={selectedMonthLabel}
              checklist={closeChecklist}
            />
          ) : null}

          {/* Odoo connection */}
          <OdooConnectionPanel
            connection={odooConnection}
            onRefresh={handleRefreshOdoo}
            onConfigure={() => setOdooConfigOpen(true)}
            canConfigure={realIsOwner}
            isRefreshing={odooQuery.isFetching}
            isError={odooQuery.isError}
          />
        </div>
      </div>

      {/* ── Upload Statement Modal ── */}
      <UploadStatementModal
        open={uploadOpen}
        onOpenChange={(v) => {
          setUploadOpen(v);
          if (!v) setPreselectedAccountId(null);
        }}
        onSuccess={handleUploadSuccess}
        preselectedAccountId={preselectedAccountId}
      />
      <OdooConfigurationDialog
        open={odooConfigOpen}
        onOpenChange={setOdooConfigOpen}
        connection={odooConnection}
        onSaved={handleOdooSaved}
      />
    </div>
  );
}

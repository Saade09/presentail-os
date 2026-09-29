import { useState, useCallback } from "react";
import { useParams, useLocation } from "wouter";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Skeleton } from "@/components/ui/skeleton";
import { Alert, AlertDescription } from "@/components/ui/alert";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { apiFetch } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import {
  CheckCircle2,
  AlertTriangle,
  ArrowLeft,
  Info,
  AlertCircle,
} from "lucide-react";
import { cn } from "@/lib/utils";

// ── Types ─────────────────────────────────────────────────────────────────────

interface StatementLinePreview {
  id: number;
  businessDate: string;
  valueDate: string;
  narrative: string;
  details: string;
  transactionRef: string;
  debitAmount: string | null;
  creditAmount: string | null;
  balance: string | null;
  currency: string;
  lineType: string; // "posted" | "excluded"
  fingerprint: string | null;
  sourceRowIndex: number;
}

interface ParsedStatementPreview {
  statementId: number;
  accountId: number;
  bankName: string;
  accountName: string;
  currency: string;
  originalFilename: string;
  periodStart: string;
  periodEnd: string;
  accountType: string;
  maskedAccountNumber: string;
  openingBalance: number;
  closingBalance: number;
  moneyReceived: number;
  moneyPaid: number;
  balanceDifference: number;
  balanceCheckPassed: boolean;
  postedCount: number;
  pendingCount: number;
  lines: StatementLinePreview[];
}

type SyncResult = {
  line_id: number;
  success: boolean;
  odoo_record_id: string | null;
  error: string | null;
};

type SyncResponse = {
  success: boolean;
  synced_count: number;
  failed_count: number;
  total_attempted: number;
  results: SyncResult[];
};

// ── Formatters ────────────────────────────────────────────────────────────────

function formatLbp(amount: number): string {
  return new Intl.NumberFormat("en-US", {
    maximumFractionDigits: 0,
    minimumFractionDigits: 0,
  }).format(Math.abs(amount));
}

function formatPeriod(start: string, end: string): string {
  if (!start || !end) return "—";
  try {
    const s = new Date(start);
    const e = new Date(end);
    const sDay = s.getUTCDate();
    const eDay = e.getUTCDate();
    const month = e.toLocaleString("en-US", { month: "long", timeZone: "UTC" });
    const year = e.getUTCFullYear();
    return `${sDay}–${eDay} ${month} ${year}`;
  } catch {
    return `${start} – ${end}`;
  }
}

function formatDate(dateStr: string): string {
  if (!dateStr) return "—";
  try {
    return new Date(dateStr).toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
      year: "numeric",
      timeZone: "UTC",
    });
  } catch {
    return dateStr.slice(0, 10);
  }
}

function lineAmount(line: StatementLinePreview): {
  display: string;
  isCredit: boolean;
  isZero: boolean;
} {
  if (line.creditAmount && parseFloat(line.creditAmount) !== 0) {
    const val = parseFloat(line.creditAmount);
    return {
      display: `+${formatLbp(val)}`,
      isCredit: true,
      isZero: false,
    };
  }
  if (line.debitAmount && parseFloat(line.debitAmount) !== 0) {
    const val = parseFloat(line.debitAmount);
    return {
      display: `−${formatLbp(val)}`,
      isCredit: false,
      isZero: false,
    };
  }
  return { display: "0", isCredit: false, isZero: true };
}

// ── Sub-components ────────────────────────────────────────────────────────────

function BalanceCard({
  label,
  amount,
  currency,
  highlight,
}: {
  label: string;
  amount: number;
  currency: string;
  highlight?: boolean;
}) {
  return (
    <Card className={cn(highlight && "ring-1 ring-primary/20")}>
      <CardHeader className="pb-1 pt-4 px-4">
        <CardTitle className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
          {label}
        </CardTitle>
      </CardHeader>
      <CardContent className="pb-4 px-4">
        <p className="text-xl font-semibold tabular-nums">
          <span className="text-xs font-normal text-muted-foreground mr-1">{currency}</span>
          {formatLbp(amount)}
        </p>
      </CardContent>
    </Card>
  );
}

type ImportStatusValue = "Ready" | "Excluded" | "Synced" | "Failed";

function ImportStatusBadge({
  status,
}: {
  status: ImportStatusValue;
}) {
  const styles: Record<ImportStatusValue, string> = {
    Ready: "bg-blue-50 text-blue-700 border-blue-200",
    Excluded: "bg-gray-100 text-gray-500 border-gray-200",
    Synced: "bg-green-50 text-green-700 border-green-200",
    Failed: "bg-red-50 text-red-700 border-red-200",
  };
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium",
        styles[status],
      )}
    >
      {status}
    </span>
  );
}

function TransactionTable({
  lines,
  syncResults,
  currency,
}: {
  lines: StatementLinePreview[];
  syncResults: Map<number, SyncResult>;
  currency: string;
}) {
  const lineStatusMap = syncResults;

  const getImportStatus = (line: StatementLinePreview): ImportStatusValue => {
    const result = lineStatusMap.get(line.id);
    if (result) return result.success ? "Synced" : "Failed";
    return line.lineType === "excluded" ? "Excluded" : "Ready";
  };

  if (lines.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-16 text-center gap-2">
        <Info className="w-8 h-8 text-muted-foreground/50" />
        <p className="text-sm text-muted-foreground">No transactions in this category.</p>
      </div>
    );
  }

  return (
    <div className="overflow-x-auto">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead className="whitespace-nowrap">Business Date</TableHead>
            <TableHead className="whitespace-nowrap">Value Date</TableHead>
            <TableHead>Narrative</TableHead>
            <TableHead className="text-right whitespace-nowrap">
              Amount ({currency})
            </TableHead>
            <TableHead className="text-right whitespace-nowrap">Balance</TableHead>
            <TableHead className="whitespace-nowrap">Transaction Ref.</TableHead>
            <TableHead>Import Status</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {lines.map((line) => {
            const { display, isCredit, isZero } = lineAmount(line);
            const status = getImportStatus(line);
            return (
              <TableRow key={line.id}>
                <TableCell className="text-sm whitespace-nowrap">
                  {formatDate(line.businessDate)}
                </TableCell>
                <TableCell className="text-sm whitespace-nowrap text-muted-foreground">
                  {formatDate(line.valueDate)}
                </TableCell>
                <TableCell className="text-sm max-w-[240px]">
                  <p className="truncate" title={line.narrative}>
                    {line.narrative || "—"}
                  </p>
                  {line.details && line.details !== line.narrative && (
                    <p className="text-xs text-muted-foreground truncate" title={line.details}>
                      {line.details}
                    </p>
                  )}
                </TableCell>
                <TableCell
                  className={cn(
                    "text-right font-mono text-sm whitespace-nowrap",
                    isCredit && "text-foreground",
                    !isCredit && !isZero && "text-foreground",
                    isZero && "text-muted-foreground",
                  )}
                >
                  {display}
                </TableCell>
                <TableCell className="text-right font-mono text-sm whitespace-nowrap text-muted-foreground">
                  {line.balance ? formatLbp(parseFloat(line.balance)) : "—"}
                </TableCell>
                <TableCell className="text-sm font-mono text-xs text-muted-foreground whitespace-nowrap">
                  {line.transactionRef || "—"}
                </TableCell>
                <TableCell>
                  <ImportStatusBadge status={status} />
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </div>
  );
}

// ── Change Journal Dialog ─────────────────────────────────────────────────────

function ChangeJournalDialog({
  open,
  onOpenChange,
  accountId,
  currentJournal,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  accountId: number;
  currentJournal: string;
  onSaved: (name: string) => void;
}) {
  const [journalId, setJournalId] = useState("");
  const [journalName, setJournalName] = useState(currentJournal);
  const { toast } = useToast();

  const mutation = useMutation({
    mutationFn: () =>
      apiFetch(`/api/lb-bank-recon/accounts/${accountId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          odoo_journal_id: journalId ? parseInt(journalId, 10) : null,
          odoo_journal_name: journalName.trim() || null,
        }),
      }),
    onSuccess: () => {
      toast({ title: "Journal mapping updated" });
      onSaved(journalName.trim());
      onOpenChange(false);
    },
    onError: (err: Error) => {
      toast({ title: "Failed to update journal", description: err.message, variant: "destructive" });
    },
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[400px]">
        <DialogHeader>
          <DialogTitle>Change Odoo Journal Mapping</DialogTitle>
        </DialogHeader>
        <div className="space-y-4 py-2">
          <div className="space-y-1.5">
            <Label htmlFor="journal-id">Odoo Journal ID</Label>
            <Input
              id="journal-id"
              placeholder="e.g. 42"
              value={journalId}
              onChange={(e) => setJournalId(e.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="journal-name">Journal Name</Label>
            <Input
              id="journal-name"
              placeholder="e.g. BLOM LBP Bank Journal"
              value={journalName}
              onChange={(e) => setJournalName(e.target.value)}
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            onClick={() => mutation.mutate()}
            disabled={mutation.isPending || (!journalId && !journalName.trim())}
          >
            {mutation.isPending ? "Saving…" : "Save"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ── Main Page ─────────────────────────────────────────────────────────────────

export default function ReviewBankStatement() {
  const { statementId } = useParams<{ statementId: string }>();
  const [, navigate] = useLocation();
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const [activeTab, setActiveTab] = useState("posted");
  const [syncResults, setSyncResults] = useState<Map<number, SyncResult>>(new Map());
  const [syncDone, setSyncDone] = useState(false);
  const [changeJournalOpen, setChangeJournalOpen] = useState(false);
  const [localJournalName, setLocalJournalName] = useState<string | null>(null);

  const id = statementId ? parseInt(statementId, 10) : NaN;

  const queryKey = ["lb-bank-recon-preview", id];
  const { data, isLoading, isError, error } = useQuery<{
    preview: ParsedStatementPreview;
  }>({
    queryKey,
    queryFn: () => apiFetch(`/api/lb-bank-recon/statements/${id}/preview`),
    enabled: !isNaN(id),
    staleTime: 30_000,
  });

  // Also fetch the account to get journal info
  const preview = data?.preview;
  const accountQueryKey = ["lb-bank-recon-account", preview?.accountId];
  const { data: accountData } = useQuery<{
    account: {
      id: number;
      odoo_journal_id: number | null;
      odoo_journal_name: string | null;
    };
  }>({
    queryKey: accountQueryKey,
    queryFn: () => apiFetch(`/api/lb-bank-recon/accounts/${preview?.accountId}`),
    enabled: !!preview?.accountId,
    staleTime: 60_000,
  });

  const journalName =
    localJournalName ?? accountData?.account?.odoo_journal_name ?? null;
  const journalId = accountData?.account?.odoo_journal_id ?? null;

  const syncMutation = useMutation({
    mutationFn: () =>
      apiFetch(`/api/lb-bank-recon/statements/${id}/sync`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
      }) as Promise<SyncResponse>,
    onSuccess: (result) => {
      const map = new Map<number, SyncResult>();
      for (const r of result.results ?? []) {
        map.set(r.line_id, r);
      }
      setSyncResults(map);
      setSyncDone(true);

      if (result.failed_count === 0) {
        toast({
          title: `Synced ${result.synced_count} transaction${result.synced_count !== 1 ? "s" : ""} to Odoo`,
        });
      } else {
        toast({
          title: `Partial sync: ${result.synced_count} synced, ${result.failed_count} failed`,
          variant: "destructive",
        });
      }

      void queryClient.invalidateQueries({ queryKey });
    },
    onError: (err: Error) => {
      toast({
        title: "Sync failed",
        description: err.message,
        variant: "destructive",
      });
    },
  });

  const handleSync = useCallback(() => {
    syncMutation.mutate();
  }, [syncMutation]);

  if (isNaN(id)) {
    return (
      <div className="p-8 text-center">
        <p className="text-muted-foreground">Invalid statement ID.</p>
      </div>
    );
  }

  if (isLoading) {
    return (
      <div className="max-w-7xl mx-auto px-4 py-8 space-y-6">
        <Skeleton className="h-8 w-64" />
        <div className="grid grid-cols-4 gap-4">
          {[0, 1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-24 rounded-lg" />
          ))}
        </div>
        <Skeleton className="h-64 rounded-lg" />
      </div>
    );
  }

  if (isError || !preview) {
    return (
      <div className="max-w-7xl mx-auto px-4 py-8">
        <Alert variant="destructive">
          <AlertCircle className="h-4 w-4" />
          <AlertDescription>
            {(error as Error)?.message ?? "Failed to load statement. Please try again."}
          </AlertDescription>
        </Alert>
        <Button
          variant="ghost"
          className="mt-4 gap-2"
          onClick={() => navigate("/finance/accounting/reconciliation")}
        >
          <ArrowLeft className="w-4 h-4" />
          Back to Reconciliation
        </Button>
      </div>
    );
  }

  const postedLines = preview.lines.filter((l) => l.lineType === "posted");
  const pendingLines = preview.lines.filter((l) => l.lineType === "excluded");

  // Sync CTA blocking conditions
  const odooNotMapped = !journalId;
  const balanceFailed = !preview.balanceCheckPassed;
  const syncDisabled =
    odooNotMapped || balanceFailed || syncMutation.isPending || syncDone;

  return (
    <div className="max-w-7xl mx-auto px-4 py-6 space-y-6">
      {/* Back link */}
      <button
        type="button"
        className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors"
        onClick={() => navigate("/finance/accounting/reconciliation")}
      >
        <ArrowLeft className="w-4 h-4" />
        Back to Reconciliation
      </button>

      {/* ── Header ────────────────────────────────────────────────────────── */}
      <div className="flex flex-wrap items-start gap-4 justify-between">
        <div className="space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-2xl font-semibold">{preview.bankName}</h1>
            <Badge className="bg-green-100 text-green-700 border-green-200 hover:bg-green-100">
              Parsed
            </Badge>
          </div>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-muted-foreground">
            {preview.accountType && <span>{preview.accountType}</span>}
            {preview.maskedAccountNumber && (
              <>
                <span className="text-border">·</span>
                <span className="font-mono">{preview.maskedAccountNumber}</span>
              </>
            )}
            <span className="text-border">·</span>
            <span>{preview.currency}</span>
            <span className="text-border">·</span>
            <span>{formatPeriod(preview.periodStart, preview.periodEnd)}</span>
            <span className="text-border">·</span>
            <span className="truncate max-w-[200px]" title={preview.originalFilename}>
              {preview.originalFilename}
            </span>
          </div>
        </div>
      </div>

      {/* ── Balance summary cards ──────────────────────────────────────────── */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
        <BalanceCard label="Opening Balance" amount={preview.openingBalance} currency={preview.currency} />
        <BalanceCard label="Money Received" amount={preview.moneyReceived} currency={preview.currency} />
        <BalanceCard label="Money Paid" amount={preview.moneyPaid} currency={preview.currency} />
        <BalanceCard label="Closing Balance" amount={preview.closingBalance} currency={preview.currency} highlight />
      </div>

      {/* ── Balance check banner ───────────────────────────────────────────── */}
      {preview.balanceCheckPassed ? (
        <div className="flex items-center gap-3 rounded-lg border border-green-200 bg-green-50 px-4 py-3 text-sm text-green-800">
          <CheckCircle2 className="w-4 h-4 shrink-0 text-green-600" />
          Balance check passed: opening balance + net activity equals closing balance.
        </div>
      ) : (
        <Alert className="border-amber-200 bg-amber-50 text-amber-900 [&>svg]:text-amber-600">
          <AlertTriangle className="h-4 w-4" />
          <AlertDescription>
            Balance check failed. The difference is{" "}
            <span className="font-semibold">
              {preview.currency} {formatLbp(Math.abs(preview.balanceDifference))}
            </span>
            . Review the statement before syncing.
          </AlertDescription>
        </Alert>
      )}

      {/* ── Main content: tabs + right panel ──────────────────────────────── */}
      <div className="flex flex-col lg:flex-row gap-6">
        {/* Left: tabs + table */}
        <div className="flex-1 min-w-0 space-y-4">
          <p className="text-sm text-muted-foreground">
            Only posted transactions from this statement period will be synced.
          </p>

          <Tabs value={activeTab} onValueChange={setActiveTab}>
            <TabsList>
              <TabsTrigger value="posted">
                Posted Transactions
                <span className="ml-1.5 rounded-full bg-muted px-1.5 py-0.5 text-xs font-medium">
                  {preview.postedCount}
                </span>
              </TabsTrigger>
              <TabsTrigger value="pending">
                Pending Transactions
                <span className="ml-1.5 rounded-full bg-muted px-1.5 py-0.5 text-xs font-medium">
                  {preview.pendingCount}
                </span>
              </TabsTrigger>
            </TabsList>

            <TabsContent value="posted" className="mt-0 border rounded-lg overflow-hidden">
              <TransactionTable
                lines={postedLines}
                syncResults={syncResults}
                currency={preview.currency}
              />
            </TabsContent>

            <TabsContent value="pending" className="mt-0 border rounded-lg overflow-hidden">
              <TransactionTable
                lines={pendingLines}
                syncResults={new Map(pendingLines.map((l) => [l.id, { line_id: l.id, success: false, odoo_record_id: null, error: null }]))}
                currency={preview.currency}
              />
            </TabsContent>
          </Tabs>
        </div>

        {/* Right: import summary + Odoo config + CTA */}
        <div className="w-full lg:w-80 shrink-0 space-y-4">
          {/* Import summary */}
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-sm font-semibold">Import Summary</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3 text-sm pb-4">
              <div className="flex justify-between items-center">
                <span className="text-muted-foreground">Posted → Will sync</span>
                <span className="font-semibold">{preview.postedCount}</span>
              </div>
              <div className="flex justify-between items-center">
                <span className="text-muted-foreground">Pending → Excluded</span>
                <span className="font-semibold">{preview.pendingCount}</span>
              </div>
              <div className="flex justify-between items-center">
                <span className="text-muted-foreground">Duplicates found</span>
                <span className="font-semibold">0</span>
              </div>
              <div className="flex justify-between items-center">
                <span className="text-muted-foreground">Balance difference</span>
                <span
                  className={cn(
                    "font-semibold tabular-nums",
                    preview.balanceDifference !== 0 && "text-red-600",
                  )}
                >
                  {preview.currency} {formatLbp(preview.balanceDifference)}
                </span>
              </div>
            </CardContent>
          </Card>

          {/* Odoo destination */}
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-sm font-semibold">Odoo Destination</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3 text-sm pb-4">
              {odooNotMapped ? (
                <Alert variant="destructive" className="py-2">
                  <AlertCircle className="h-4 w-4" />
                  <AlertDescription className="text-xs">
                    No Odoo journal configured. Set one to enable sync.
                  </AlertDescription>
                </Alert>
              ) : (
                <div className="flex items-start justify-between gap-2">
                  <span className="text-muted-foreground shrink-0">Journal</span>
                  <span className="font-medium text-right">{journalName ?? "—"}</span>
                </div>
              )}
              <button
                type="button"
                className="text-xs text-primary hover:underline"
                onClick={() => setChangeJournalOpen(true)}
              >
                Change journal mapping
              </button>
            </CardContent>
          </Card>

          {/* Date mapping */}
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-sm font-semibold">Date Mapping</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2 text-sm pb-4 text-muted-foreground">
              <div className="flex justify-between">
                <span>Business Date</span>
                <span className="font-medium text-foreground">→ Odoo transaction date</span>
              </div>
              <div className="flex justify-between">
                <span>Value Date</span>
                <span className="font-medium text-foreground">→ Supporting data</span>
              </div>
            </CardContent>
          </Card>

          {/* Sync CTA */}
          <div className="space-y-2">
            {syncDone ? (
              <Button className="w-full bg-green-600 hover:bg-green-700 text-white" disabled>
                <CheckCircle2 className="w-4 h-4 mr-2" />
                Synced
              </Button>
            ) : (
              <Button
                className="w-full"
                disabled={syncDisabled}
                onClick={handleSync}
              >
                {syncMutation.isPending
                  ? "Syncing…"
                  : `Sync ${preview.postedCount} transaction${preview.postedCount !== 1 ? "s" : ""} to Odoo`}
              </Button>
            )}

            {odooNotMapped && (
              <p className="text-xs text-muted-foreground text-center">
                Set an Odoo journal to enable sync.
              </p>
            )}
            {balanceFailed && !odooNotMapped && (
              <p className="text-xs text-amber-700 text-center">
                Resolve balance mismatch before syncing.
              </p>
            )}

            <p className="text-xs text-muted-foreground text-center">
              Pending transactions will not be imported.
            </p>

            <div className="text-center">
              <button
                type="button"
                className="text-xs text-muted-foreground hover:text-foreground transition-colors underline-offset-2 hover:underline"
                onClick={() => navigate("/finance/accounting/reconciliation")}
              >
                Cancel, return to workspace
              </button>
            </div>
          </div>
        </div>
      </div>

      {/* Change Journal Dialog */}
      {preview && (
        <ChangeJournalDialog
          open={changeJournalOpen}
          onOpenChange={setChangeJournalOpen}
          accountId={preview.accountId}
          currentJournal={journalName ?? ""}
          onSaved={(name) => {
            setLocalJournalName(name);
            void queryClient.invalidateQueries({ queryKey: accountQueryKey });
          }}
        />
      )}
    </div>
  );
}

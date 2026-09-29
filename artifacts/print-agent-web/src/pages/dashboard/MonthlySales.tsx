import React, { useState, useCallback, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { useLocation, useSearch } from "wouter";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from "@/components/ui/sheet";
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
} from "@/components/ui/dialog";
import { Checkbox } from "@/components/ui/checkbox";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Download, Lock, Upload, AlertTriangle, CheckCircle, CheckCircle2, Clock, Info, RefreshCw, ExternalLink, AlertCircle, XCircle, Users, FileSpreadsheet, ThumbsUp, Settings2, ChevronDown, Search } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { useWorkspaceRole } from "@/hooks/use-workspace-role";
import { apiFetch } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { ImportStatementDrawer, type AccountingSource } from "@/components/ImportStatementDrawer";
import { cn } from "@/lib/utils";
import {
  useGetAccountingSourceMonths,
  useSyncAccountingSourceMonth,
  useGetAccountingSourceMonthLines,
  getGetAccountingSourceMonthsQueryKey,
  getGetAccountingSourceMonthLinesQueryKey,
  useReconcileAccountingSourceMonth,
  useGetAccountingExceptions,
  usePatchAccountingException,
  useBulkAssignAccountingExceptions,
  getGetAccountingExceptionsQueryKey,
  useGenerateJournalEntry,
  useGetJournalEntry,
  useApproveJournalEntry,
  useGenerateVatSummary,
  useGetVatSummary,
  useGetAccountingSourceConfig,
  usePatchAccountingSourceConfig,
  getGetJournalEntryQueryKey,
  getGetVatSummaryQueryKey,
  getGetAccountingSourceConfigQueryKey,
  useCloseAccountingEntityMonth,
  useReopenAccountingEntityMonth,
  useGetAccountingEntityMonthAudit,
  getGetAccountingEntityMonthAuditQueryKey,
  useGetAccountingDocuments,
  getGetAccountingDocumentsQueryKey,
  useUploadAccountingDocument,
  useDeleteAccountingDocument,
} from "@workspace/api-client-react";
import type {
  AccountingDocument,
  AccountingAuditEvent,
} from "@workspace/api-client-react";
import type {
  AccountingSourceMonth,
  AccountingStatementLine,
  AccountingException,
  JournalEntryLine,
  VatSummaryRow,
} from "@workspace/api-client-react";

const MONTHS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];
const CURRENT_YEAR = new Date().getFullYear();
const YEARS = [CURRENT_YEAR, CURRENT_YEAR - 1, CURRENT_YEAR - 2];

const AUTO_SYNC_TYPES = ["retail_cash", "card_terminal"];

function monthLabel(month: number, locale: string): string {
  return new Date(2000, month - 1, 1).toLocaleString(locale, { month: "long" });
}

function centsToDisplay(cents: number | null | undefined, currency = "USD"): string {
  if (cents === null || cents === undefined) return "—";
  const amount = cents / 100;
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency,
    maximumFractionDigits: 0,
  }).format(amount);
}

type SalesStatus = string | null;
type PayoutStatus = string | null;

function SalesStatusBadge({ status }: { status: SalesStatus }) {
  const { t } = useTranslation();
  if (!status) {
    return (
      <Badge variant="outline" className="gap-1 text-muted-foreground border-muted-foreground/30">
        <Clock size={10} />
        {t("accounting.import.status.pending")}
      </Badge>
    );
  }
  const variants: Record<string, string> = {
    reconciled: "bg-green-100 text-green-800 border-green-200",
    review_required: "bg-amber-100 text-amber-800 border-amber-200",
    in_review: "bg-amber-100 text-amber-800 border-amber-200",
    pending: "bg-amber-100 text-amber-800 border-amber-200",
    exception: "bg-red-100 text-red-800 border-red-200",
    failed: "bg-red-100 text-red-800 border-red-200",
    not_started: "bg-gray-100 text-gray-600 border-gray-200",
  };
  const cls = variants[status] ?? variants.not_started;
  return (
    <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium ${cls}`}>
      {t(`accounting.overview.salesStatus.${status}`, { defaultValue: status })}
    </span>
  );
}

function PayoutStatusBadge({ status }: { status: PayoutStatus }) {
  const { t } = useTranslation();
  if (!status) return <span className="text-muted-foreground text-xs">—</span>;
  const variants: Record<string, string> = {
    paid: "bg-green-100 text-green-800 border-green-200",
    partial: "bg-amber-100 text-amber-800 border-amber-200",
    pending: "bg-amber-100 text-amber-800 border-amber-200",
    failed: "bg-red-100 text-red-800 border-red-200",
  };
  const cls = variants[status] ?? "bg-gray-100 text-gray-600 border-gray-200";
  return (
    <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium ${cls}`}>
      {t(`accounting.overview.payoutStatus.${status}`, { defaultValue: status })}
    </span>
  );
}

type SourceRow = {
  sourceId: number;
  sourceMonthId: number | null;
  sourceName: string;
  isIntercompany: boolean;
  osSalesCents: number | null;
  externalSourceCents: number | null;
  totalAmountCents: number | null;
  varianceCents: number | null;
  differenceCents: number | null;
  refundsCents: number | null;
  feesCents: number | null;
  netActivityCents: number | null;
  salesStatus: string;
  payoutStatus: string | null;
  lastSyncedAt: string | null;
};

type EntityOverview = {
  entityId: number;
  entityName: string;
  status: string;
  entityMonthId: number | null;
  sources: SourceRow[];
};

type MonthOverview = {
  monthId: number;
  year: number;
  month: number;
  status: string;
  combinedSalesCents: number | null;
  sourcesCount: number;
  sourcesSyncedCount: number;
  openExceptionsCount: number;
  openExceptionsEvaluated: boolean;
  entitiesReadyCount: number;
  entities: EntityOverview[];
  insights: string[];
};

type ChecklistItem = {
  id: number;
  label: string;
  isChecked: boolean;
  checkedBy: string | null;
  checkedAt: string | null;
  sortOrder: number;
};

type Checklist = {
  entityMonthId: number;
  entityId: number;
  items: ChecklistItem[];
  completedCount: number;
  totalCount: number;
};

type AccountingMonthRecord = {
  id: number;
  year: number;
  month: number;
  status: string;
};

function EntityChecklistPanel({
  entityMonthId,
  entityName,
}: {
  entityMonthId: number;
  entityName: string;
}) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const queryKey = ["accounting-checklist", entityMonthId];

  const { data, isLoading } = useQuery<{ checklist: Checklist }>({
    queryKey,
    queryFn: () => apiFetch(`/api/accounting/entity-months/${entityMonthId}/checklist`),
    staleTime: 30_000,
  });

  const toggleMutation = useMutation({
    mutationFn: (itemId: number) =>
      apiFetch(`/api/accounting/entity-months/${entityMonthId}/checklist/${itemId}`, {
        method: "PATCH",
      }),
    onMutate: async (itemId: number) => {
      await queryClient.cancelQueries({ queryKey });
      const previous = queryClient.getQueryData<{ checklist: Checklist }>(queryKey);
      queryClient.setQueryData<{ checklist: Checklist }>(queryKey, (old) => {
        if (!old) return old;
        const updatedItems = old.checklist.items.map((item) =>
          item.id === itemId ? { ...item, isChecked: !item.isChecked } : item,
        );
        const completedCount = updatedItems.filter((i) => i.isChecked).length;
        return {
          checklist: { ...old.checklist, items: updatedItems, completedCount },
        };
      });
      return { previous };
    },
    onError: (_err, _itemId, context) => {
      if (context?.previous) {
        queryClient.setQueryData(queryKey, context.previous);
      }
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey });
    },
  });

  const checklist = data?.checklist;

  return (
    <div className="mb-4 last:mb-0">
      <div className="flex items-center justify-between mb-2">
        <p className="text-sm font-medium">{entityName}</p>
        {checklist && (
          <span className="text-xs text-muted-foreground">
            {t("accounting.overview.checklist.progress", {
              done: checklist.completedCount,
              total: checklist.totalCount,
            })}
          </span>
        )}
      </div>
      {checklist && (
        <Progress
          value={(checklist.completedCount / Math.max(checklist.totalCount, 1)) * 100}
          className="h-1.5 mb-3"
        />
      )}
      {isLoading ? (
        <div className="space-y-2">
          {Array.from({ length: 5 }).map((_, i) => (
            <Skeleton key={i} className="h-4 w-full" />
          ))}
        </div>
      ) : checklist ? (
        <div className="space-y-2">
          {checklist.items.map((item) => (
            <div key={item.id} className="flex items-start gap-2">
              <Checkbox
                checked={item.isChecked}
                disabled={toggleMutation.isPending}
                onCheckedChange={() => toggleMutation.mutate(item.id)}
                className="mt-0.5 shrink-0"
              />
              <span
                className={`text-xs leading-relaxed ${
                  item.isChecked ? "text-muted-foreground line-through" : ""
                }`}
              >
                {item.label}
              </span>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function formatCents(cents: number | null | undefined, currency = "USD"): string {
  if (cents == null) return "—";
  const amount = cents / 100;
  try {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency,
      maximumFractionDigits: currency === "LBP" ? 0 : 2,
    }).format(amount);
  } catch {
    return `${currency} ${amount.toFixed(currency === "LBP" ? 0 : 2)}`;
  }
}

function formatDollars(amount: number | null | undefined, currency = "USD"): string {
  if (amount == null) return "—";
  try {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency,
      maximumFractionDigits: currency === "LBP" ? 0 : 2,
    }).format(amount);
  } catch {
    return `${currency} ${amount.toFixed(currency === "LBP" ? 0 : 2)}`;
  }
}

function formatDateShort(dateStr: string | null | undefined): string {
  if (!dateStr) return "—";
  try {
    return new Date(dateStr).toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return dateStr.substring(0, 10);
  }
}

// ── Cash Session Detail View ──────────────────────────────────────────────────

interface CashLineMetadata {
  session_id?: number;
  session_number?: string;
  drawer_name?: string;
  drawer_code?: string;
  location_id?: number;
  location_name?: string;
  status?: string;
  opened_at?: string;
  closed_at?: string;
  opening_cash?: string;
  cash_in_total?: string;
  cash_out_total?: string;
  adjustments_total?: string;
  expected_cash?: string;
  actual_cash?: string;
  difference?: string;
  is_primary?: boolean;
}

interface CardLineMetadata {
  order_id?: string;
  display_order_number?: string;
  payment_id?: string;
  method?: string;
  provider?: string;
  amount?: string;
  currency?: string;
  amount_usd?: string;
  refunded_amount?: string;
  refunded_amount_usd?: string;
  location_id?: number;
  location_name?: string;
}

function CashLinesTable({ lines }: { lines: AccountingStatementLine[] }) {
  const { t } = useTranslation();
  return (
    <div className="overflow-x-auto">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>{t("accounting.sources.sessionNumber")}</TableHead>
            <TableHead>{t("accounting.sources.location")}</TableHead>
            <TableHead>{t("accounting.sources.drawer")}</TableHead>
            <TableHead>{t("accounting.sources.openedAt")}</TableHead>
            <TableHead className="text-right">{t("accounting.sources.cashIn")}</TableHead>
            <TableHead className="text-right">{t("accounting.sources.cashOut")}</TableHead>
            <TableHead className="text-right">{t("accounting.sources.difference")}</TableHead>
            <TableHead>{t("accounting.sources.sessionStatus")}</TableHead>
            <TableHead></TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {lines.map((line) => {
            const meta = line.metadata as CashLineMetadata;
            const diff = parseFloat(meta.difference ?? "0");
            const diffColor =
              diff > 0 ? "text-green-600" : diff < 0 ? "text-red-600" : "text-muted-foreground";
            return (
              <TableRow key={line.id}>
                <TableCell className="font-mono text-xs">{meta.session_number ?? "—"}</TableCell>
                <TableCell className="text-sm">{meta.location_name ?? "—"}</TableCell>
                <TableCell className="text-sm">{meta.drawer_name ?? "—"}</TableCell>
                <TableCell className="text-sm whitespace-nowrap">
                  {formatDateShort(meta.opened_at)}
                </TableCell>
                <TableCell className="text-right font-mono text-sm">
                  {meta.cash_in_total
                    ? `${line.currency} ${parseFloat(meta.cash_in_total).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
                    : "—"}
                </TableCell>
                <TableCell className="text-right font-mono text-sm">
                  {meta.cash_out_total
                    ? `${line.currency} ${parseFloat(meta.cash_out_total).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
                    : "—"}
                </TableCell>
                <TableCell className={`text-right font-mono text-sm ${diffColor}`}>
                  {meta.difference != null
                    ? `${line.currency} ${Math.abs(diff).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
                    : "—"}
                </TableCell>
                <TableCell>
                  <Badge
                    variant="outline"
                    className={
                      meta.status === "approved"
                        ? "border-green-300 text-green-700"
                        : meta.status === "open"
                          ? "border-orange-300 text-orange-700"
                          : "border-muted text-muted-foreground"
                    }
                  >
                    {meta.status ?? "—"}
                  </Badge>
                </TableCell>
                <TableCell>
                  {meta.session_id && (
                    <a
                      href={`/cash-sessions?session=${meta.session_id}`}
                      className="inline-flex items-center gap-1 text-xs text-primary hover:underline"
                    >
                      <ExternalLink size={12} />
                    </a>
                  )}
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </div>
  );
}

function KpiCard({
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
    <Card className="flex-1 min-w-0">
      <CardContent className="pt-5 pb-4">
        <div className="flex items-start justify-between gap-2">
          <div className="flex-1 min-w-0">
            <p className="text-xs text-muted-foreground uppercase tracking-wide mb-1">{title}</p>
            <p className="text-2xl font-semibold truncate">{value}</p>
            {subtitle && <p className="text-xs text-muted-foreground mt-0.5">{subtitle}</p>}
          </div>
          {Icon && (
            <div className={`rounded-full p-2 ${iconClass ?? "bg-muted"}`}>
              <Icon size={16} className="shrink-0" />
            </div>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

function EntityReconciliationCard({
  entity,
}: {
  entity: EntityOverview;
}) {
  const { t } = useTranslation();

  const saleSources = entity.sources.filter((s) => !s.isIntercompany);
  const intercomparySources = entity.sources.filter((s) => s.isIntercompany);

  // Determine section label: Cyprus/LTD entities use "Sales & Settlement Sources"
  const isCyprus =
    entity.entityName.includes("Cyprus") || entity.entityName.includes("LTD");
  const sourceLabel = isCyprus
    ? t("accounting.overview.salesAndSettlementSources")
    : t("accounting.overview.salesSources");

  const totalAmountCents = saleSources.reduce<number | null>((sum, s) => {
    if (s.totalAmountCents == null) return sum;
    return (sum ?? 0) + s.totalAmountCents;
  }, null);

  const varianceCents = saleSources.reduce<number | null>((sum, s) => {
    if (s.varianceCents == null) return sum;
    return (sum ?? 0) + s.varianceCents;
  }, null);

  const hasVariance = varianceCents !== null && varianceCents !== 0;

  return (
    <Card>
      <CardHeader className="pb-2">
        <div className="flex items-start justify-between gap-3">
          <CardTitle className="text-base flex items-center gap-2 flex-wrap">
            {entity.entityName}
            <Badge
              variant="outline"
              className={`text-xs capitalize ${
                entity.status === "closed"
                  ? "border-green-300 text-green-700"
                  : entity.status === "in_progress"
                    ? "border-amber-300 text-amber-700"
                    : "border-gray-300 text-gray-600"
              }`}
            >
              {t(`accounting.monthlySales.status.${entity.status}`, {
                defaultValue: entity.status,
              })}
            </Badge>
          </CardTitle>
          {(totalAmountCents !== null || varianceCents !== null) && (
            <div className="flex items-center gap-4 shrink-0 text-right">
              {totalAmountCents !== null && (
                <div>
                  <p className="text-xs text-muted-foreground">{t("accounting.overview.entityTotal")}</p>
                  <p className="text-sm font-semibold tabular-nums">{centsToDisplay(totalAmountCents)}</p>
                </div>
              )}
              {varianceCents !== null && (
                <div>
                  <p className="text-xs text-muted-foreground">{t("accounting.overview.entityVariance")}</p>
                  <p className={`text-sm font-semibold tabular-nums ${hasVariance ? (Math.abs(varianceCents) > 100 ? "text-red-600" : "text-amber-600") : "text-green-600"}`}>
                    {centsToDisplay(varianceCents)}
                  </p>
                </div>
              )}
            </div>
          )}
        </div>
      </CardHeader>
      <CardContent className="p-0">
        {saleSources.length === 0 && intercomparySources.length === 0 ? (
          <div className="px-6 py-4 text-sm text-muted-foreground">
            {t("accounting.overview.noSources")}
          </div>
        ) : (
          <>
            {saleSources.length > 0 && (
              <>
                <div className="px-6 pt-3 pb-1">
                  <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">
                    {sourceLabel}
                  </p>
                </div>
                <div className="overflow-x-auto">
                  <Table>
                    <TableHeader>
                      <TableRow className="bg-muted/40">
                        <TableHead className="text-xs py-2">{t("accounting.overview.table.source")}</TableHead>
                        <TableHead className="text-xs py-2 text-right">{t("accounting.overview.table.osSales")}</TableHead>
                        <TableHead className="text-xs py-2 text-right">{t("accounting.overview.table.external")}</TableHead>
                        <TableHead className="text-xs py-2 text-right">{t("accounting.overview.table.difference")}</TableHead>
                        <TableHead className="text-xs py-2 text-right">{t("accounting.overview.table.refunds")}</TableHead>
                        <TableHead className="text-xs py-2 text-right">{t("accounting.overview.table.fees")}</TableHead>
                        <TableHead className="text-xs py-2 text-right">{t("accounting.overview.table.netActivity")}</TableHead>
                        <TableHead className="text-xs py-2">{t("accounting.overview.table.salesStatus")}</TableHead>
                        <TableHead className="text-xs py-2">{t("accounting.overview.table.payoutStatus")}</TableHead>
                        <TableHead className="text-xs py-2">{t("accounting.overview.table.lastSynced")}</TableHead>
                        <TableHead className="text-xs py-2"></TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {saleSources.map((source) => (
                        <TableRow key={source.sourceId} className="hover:bg-muted/20">
                          <TableCell className="py-2 font-medium text-xs">{source.sourceName}</TableCell>
                          <TableCell className="py-2 text-right text-xs tabular-nums">
                            {centsToDisplay(source.osSalesCents)}
                          </TableCell>
                          <TableCell className="py-2 text-right text-xs tabular-nums">
                            {centsToDisplay(source.externalSourceCents)}
                          </TableCell>
                          <TableCell
                            className={`py-2 text-right text-xs tabular-nums ${
                              source.differenceCents !== null && source.differenceCents !== 0
                                ? Math.abs(source.differenceCents) > 100
                                  ? "text-red-600 font-medium"
                                  : "text-amber-600"
                                : ""
                            }`}
                          >
                            {centsToDisplay(source.differenceCents)}
                          </TableCell>
                          <TableCell className="py-2 text-right text-xs tabular-nums">
                            {centsToDisplay(source.refundsCents)}
                          </TableCell>
                          <TableCell className="py-2 text-right text-xs tabular-nums">
                            {centsToDisplay(source.feesCents)}
                          </TableCell>
                          <TableCell className="py-2 text-right text-xs tabular-nums font-medium">
                            {centsToDisplay(source.netActivityCents)}
                          </TableCell>
                          <TableCell className="py-2">
                            <SalesStatusBadge status={source.salesStatus} />
                          </TableCell>
                          <TableCell className="py-2">
                            <PayoutStatusBadge status={source.payoutStatus} />
                          </TableCell>
                          <TableCell className="py-2 text-xs text-muted-foreground whitespace-nowrap">
                            {source.lastSyncedAt
                              ? new Date(source.lastSyncedAt).toLocaleDateString()
                              : "—"}
                          </TableCell>
                          <TableCell className="py-2">
                            <Button variant="ghost" size="sm" className="h-6 text-xs px-2" disabled>
                              {t("accounting.overview.table.review")}
                            </Button>
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              </>
            )}

            {intercomparySources.length > 0 && (
              <div className="border-t mt-2">
                <div className="px-6 pt-3 pb-1">
                  <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">
                    {t("accounting.overview.otherReconciliation")}
                  </p>
                </div>
                <div className="px-6 pb-4 space-y-3">
                  {intercomparySources.map((source) => (
                    <div key={source.sourceId} className="flex items-center justify-between gap-4 py-2 border rounded-lg px-3 bg-muted/20">
                      <div className="min-w-0">
                        <p className="text-xs font-medium truncate">{source.sourceName}</p>
                        <p className="text-xs text-muted-foreground mt-0.5">
                          {t("accounting.overview.intercompanyNote")}
                        </p>
                      </div>
                      <Button variant="ghost" size="sm" className="h-6 text-xs px-2 shrink-0" disabled>
                        {t("accounting.overview.table.review")}
                      </Button>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}

// ── Lebanon Bank Reconciliation compact widget ─────────────────────────────
// Shows reconciliation progress for the Presentail Lebanon entity on the
// Monthly Close overview. Returns null silently for non-Lebanon workspaces
// (API returns 403, which we catch and swallow).

function LbBankReconWidget({ year, month }: { year: number; month: number }) {
  const { t } = useTranslation();

  const { data: summaryData, isLoading: summaryLoading } = useQuery<{
    total_bank_accounts: number;
    reconciled_statements: number;
    statements_imported: number;
    unresolved_count: number;
  } | null>({
    queryKey: ["lb-bank-recon-summary", year, month],
    queryFn: async () => {
      try {
        return await apiFetch<{
          total_bank_accounts: number;
          reconciled_statements: number;
          statements_imported: number;
          unresolved_count: number;
        }>(`/api/lb-bank-recon/summary?month=${month}&year=${year}`);
      } catch {
        // 403 means this is not a Lebanon workspace — hide widget.
        return null;
      }
    },
    staleTime: 30_000,
  });

  const { data: accountsData } = useQuery<{
    accounts: Array<{
      id: number;
      account_name: string;
      bank_name: string;
      is_required_for_close: boolean;
      reconciliation_status: string | null;
      statement_id: number | null;
    }>;
  } | null>({
    queryKey: ["lb-bank-recon-accounts-overview", year, month],
    queryFn: async () => {
      try {
        return await apiFetch<{
          accounts: Array<{
            id: number;
            account_name: string;
            bank_name: string;
            is_required_for_close: boolean;
            reconciliation_status: string | null;
            statement_id: number | null;
          }>;
        }>(`/api/lb-bank-recon/accounts?month=${month}&year=${year}`);
      } catch {
        return null;
      }
    },
    enabled: summaryData !== undefined && summaryData !== null,
    staleTime: 30_000,
  });

  // Not a Lebanon workspace (or still loading the first time — stay quiet).
  if (!summaryLoading && summaryData === null) return null;
  if (!summaryLoading && summaryData === undefined) return null;

  const reconciled = summaryData?.reconciled_statements ?? 0;
  const total = summaryData?.total_bank_accounts ?? 0;
  const allReconciled = total > 0 && reconciled >= total;

  const unreconciledRequired =
    accountsData?.accounts.filter(
      (a) => a.is_required_for_close && a.reconciliation_status !== "reconciled",
    ) ?? [];

  const deepLink = `/finance/accounting/reconciliation?month=${month}&year=${year}`;

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between gap-2">
          <CardTitle className="text-sm font-medium">
            {t("accounting.monthlySales.bankRecon.title")}
          </CardTitle>
          {summaryLoading ? (
            <Skeleton className="h-5 w-24" />
          ) : total === 0 ? (
            <span className="text-xs text-muted-foreground">
              {t("accounting.monthlySales.bankRecon.noAccountsRequired")}
            </span>
          ) : (
            <span
              className={`text-xs font-medium px-2 py-0.5 rounded-full ${
                allReconciled
                  ? "bg-green-100 text-green-700"
                  : "bg-amber-100 text-amber-700"
              }`}
            >
              {allReconciled
                ? t("accounting.monthlySales.bankRecon.allReconciled")
                : t("accounting.monthlySales.bankRecon.progress", {
                    reconciled,
                    total,
                  })}
            </span>
          )}
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        {unreconciledRequired.length > 0 && (
          <div className="space-y-1.5">
            {unreconciledRequired.map((account) => (
              <div
                key={account.id}
                className="flex items-center justify-between text-sm"
              >
                <span className="text-muted-foreground truncate text-xs">
                  {account.bank_name} — {account.account_name}
                </span>
                <a
                  href={`/finance/accounting/reconciliation?month=${month}&year=${year}&account=${account.id}`}
                  className="text-xs text-teal-700 hover:underline ml-2 shrink-0 flex items-center gap-1"
                >
                  {t("accounting.monthlySales.bankRecon.accountLink")}
                  <ExternalLink size={10} />
                </a>
              </div>
            ))}
          </div>
        )}
        <a
          href={deepLink}
          className="inline-flex items-center gap-1.5 text-xs text-teal-700 hover:underline"
        >
          {t("accounting.monthlySales.bankRecon.deepLink")}
          <ExternalLink size={12} />
        </a>
      </CardContent>
    </Card>
  );
}

function OverviewTab({
  monthId,
  entityFilter,
  year,
  month,
}: {
  monthId: number;
  entityFilter: string;
  year: number;
  month: number;
}) {
  const { t } = useTranslation();

  const { data: overviewData, isLoading: overviewLoading, isError } = useQuery<{
    overview: MonthOverview;
  }>({
    queryKey: ["accounting-overview", monthId],
    queryFn: () => apiFetch(`/api/accounting/months/${monthId}/overview`),
    staleTime: 30_000,
  });

  const overview = overviewData?.overview;

  if (overviewLoading) {
    return (
      <div className="space-y-6">
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-24 rounded-xl" />
          ))}
        </div>
        <Skeleton className="h-48 rounded-xl" />
        <Skeleton className="h-48 rounded-xl" />
      </div>
    );
  }

  if (isError || !overview) {
    return (
      <div className="flex items-center justify-center h-40 text-muted-foreground text-sm">
        {t("accounting.monthlySales.emptyState")}
      </div>
    );
  }

  const filteredEntities =
    entityFilter === "all"
      ? overview.entities
      : overview.entities.filter((e) => String(e.entityId) === entityFilter);

  const entitiesWithMonthId = filteredEntities.filter(
    (e) => e.entityMonthId !== null,
  ) as (EntityOverview & { entityMonthId: number })[];

  return (
    <div className="space-y-6">
      {overview.insights.length > 0 && (
        <div className="rounded-lg border border-teal-200 bg-teal-50 px-4 py-3 space-y-1.5">
          {overview.insights.map((insight, i) => (
            <div key={i} className="flex items-start gap-2 text-sm text-teal-800">
              <Info size={14} className="mt-0.5 shrink-0 text-teal-600" />
              <span>{insight}</span>
            </div>
          ))}
        </div>
      )}

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <KpiCard
          title={t("accounting.overview.kpi.combinedSales")}
          value={centsToDisplay(overview.combinedSalesCents)}
          subtitle={t("accounting.overview.kpi.combinedSalesHint")}
        />
        <KpiCard
          title={t("accounting.overview.kpi.sourcesSynced")}
          value={`${overview.sourcesSyncedCount} / ${overview.sourcesCount}`}
          subtitle={t("accounting.overview.kpi.sourcesSyncedHint")}
          icon={CheckCircle}
          iconClass={
            overview.sourcesSyncedCount === overview.sourcesCount && overview.sourcesCount > 0
              ? "bg-green-100 text-green-600"
              : "bg-muted"
          }
        />
        <KpiCard
          title={t("accounting.overview.kpi.openExceptions")}
          value={
            overview.openExceptionsEvaluated
              ? String(overview.openExceptionsCount)
              : t("accounting.overview.kpi.openExceptionsNotEvaluated")
          }
          subtitle={
            overview.openExceptionsEvaluated
              ? t("accounting.overview.kpi.openExceptionsHint")
              : t("accounting.overview.kpi.openExceptionsNotEvaluatedHint")
          }
          icon={
            overview.openExceptionsEvaluated
              ? overview.openExceptionsCount > 0
                ? AlertTriangle
                : CheckCircle
              : Clock
          }
          iconClass={
            overview.openExceptionsEvaluated
              ? overview.openExceptionsCount > 0
                ? "bg-red-100 text-red-600"
                : "bg-green-100 text-green-600"
              : "bg-gray-100 text-gray-500"
          }
        />
        <KpiCard
          title={t("accounting.overview.kpi.entitiesReady")}
          value={`${overview.entitiesReadyCount} / ${overview.entities.length}`}
          subtitle={t("accounting.overview.kpi.entitiesReadyHint")}
          icon={Clock}
          iconClass={
            overview.entitiesReadyCount === overview.entities.length && overview.entities.length > 0
              ? "bg-green-100 text-green-600"
              : "bg-muted"
          }
        />
      </div>

      <div className="flex flex-col lg:flex-row gap-6">
        <div className="flex-1 min-w-0 space-y-4">
          {filteredEntities.length === 0 ? (
            <div className="flex items-center justify-center h-40 text-muted-foreground text-sm">
              {t("accounting.monthlySales.emptyState")}
            </div>
          ) : (
            filteredEntities.map((entity) => (
              <EntityReconciliationCard key={entity.entityId} entity={entity} />
            ))
          )}
          <LbBankReconWidget year={year} month={month} />
        </div>

        {entitiesWithMonthId.length > 0 && (
          <div className="w-full lg:w-72 shrink-0">
            <Card className="sticky top-4">
              <CardHeader className="pb-3">
                <CardTitle className="text-sm">
                  {t("accounting.overview.checklist.title")}
                </CardTitle>
              </CardHeader>
              <CardContent className="divide-y">
                {entitiesWithMonthId.map((entity) => (
                  <div key={entity.entityId} className="py-4 first:pt-0 last:pb-0">
                    <EntityChecklistPanel
                      entityMonthId={entity.entityMonthId}
                      entityName={entity.entityName}
                    />
                  </div>
                ))}
              </CardContent>
            </Card>
          </div>
        )}
      </div>
    </div>
  );
}

function SourceSyncStatusBadge({ status }: { status: string | null }) {
  const { t } = useTranslation();
  if (!status || status === "pending") {
    return (
      <Badge variant="outline" className="gap-1 text-muted-foreground border-muted-foreground/30">
        <Clock size={10} />
        {t("accounting.import.status.pending")}
      </Badge>
    );
  }
  if (status === "synced") {
    return (
      <Badge variant="outline" className="gap-1 text-green-700 border-green-300">
        <CheckCircle2 size={10} />
        {t("accounting.import.status.synced")}
      </Badge>
    );
  }
  return (
    <Badge variant="outline" className="gap-1 text-amber-700 border-amber-300">
      <AlertCircle size={10} />
      {status}
    </Badge>
  );
}

function SourcesTab({
  sources,
  onImport,
}: {
  year: number;
  month: number;
  sources: AccountingSource[];
  onImport: (source: AccountingSource) => void;
}) {
  const { t } = useTranslation();

  if (sources.length === 0) {
    return (
      <div className="flex items-center justify-center h-40 text-muted-foreground text-sm">
        {t("accounting.monthlySales.emptyState")}
      </div>
    );
  }


  let lastEntityId: number | null = null;

  return (
    <div className="flex flex-col gap-1">
      {sources.map((src) => {
        const showEntityDivider = src.entity_id !== lastEntityId;
        lastEntityId = src.entity_id;
        return (
          <div key={src.id}>
            {showEntityDivider && (
              <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider px-1 pt-3 pb-1">
                {t("accounting.import.entity")} {src.entity_id}
              </p>
            )}
            <div
              className={cn(
                "flex items-center justify-between gap-3 px-4 py-3 rounded-lg border bg-card hover:bg-accent/30 transition-colors",
              )}
            >
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <span className="font-medium text-sm">{src.name}</span>
                  {src.is_auto_sync && (
                    <Badge variant="secondary" className="text-xs">
                      {t("accounting.import.autoSync")}
                    </Badge>
                  )}
                </div>
                <div className="flex items-center gap-3 mt-0.5">
                  <SourceSyncStatusBadge status={src.sales_status} />
                  {src.last_synced_at && (
                    <span className="text-xs text-muted-foreground">
                      {t("accounting.import.lastSynced")}{" "}
                      {new Date(src.last_synced_at).toLocaleDateString()}
                    </span>
                  )}
                  {src.rows_count != null && src.rows_count > 0 && (
                    <span className="text-xs text-muted-foreground">
                      {src.rows_count} {t("accounting.import.lines")}
                    </span>
                  )}
                </div>
              </div>
              {!src.is_auto_sync && (
                <Button
                  variant="outline"
                  size="sm"
                  className="gap-2 shrink-0"
                  onClick={() => onImport(src)}
                >
                  <Upload size={13} />
                  {t("accounting.import.importStatement")}
                </Button>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}

type StripeSummary = {
  stripeChargesCount: number;
  stripeChargesAmountCents: number;
  refundsCents: number;
  feesCents: number;
  disputesCents: number;
  adjustmentsCents: number;
  payoutsCents: number;
  openingBalanceCents: number;
  closingBalanceCents: number;
  osOrdersCount: number;
  osGrossSalesCents: number;
  matchedCount: number;
  unmatchedStripeCount: number;
  unmatchedOsCount: number;
};

type PaypalSummary = {
  paypalTransactionsCount: number;
  paypalTotalCents: number;
  osOrdersCount: number;
  osOrdersAmountCents: number;
  matchedCount: number;
  unmatchedPaypalCount: number;
  unmatchedOsCount: number;
};

type CashSummary = {
  sessionsCount: number;
  closedSessionsCount: number;
  osOrdersCount: number;
  osOrdersAmountCents: number;
  cashSessionsTotalCents: number;
};

type SourceMonthRow = {
  id: number;
  source_name: string;
  source_type: string;
  status: string;
  total_amount_cents: number | null;
  variance_cents: number | null;
  sales_reconciliation_status: string | null;
  payout_reconciliation_status: string | null;
  stripe_summary: StripeSummary | null;
  updated_at: string;
};

type StatementLine = {
  id: number;
  external_ref: string | null;
  line_date: string | null;
  description: string | null;
  amount_cents: number;
  currency: string;
  line_type: string | null;
  is_matched: boolean;
  matched_order_id: string | null;
  match_confidence: string | null;
};

type SyncRun = {
  id: number;
  status: string;
  started_at: string;
  completed_at: string | null;
  error_message: string | null;
  records_synced: number;
};

type SourceMonthDetail = {
  sourceMonth: SourceMonthRow;
  syncRuns: SyncRun[];
  lines: StatementLine[];
};

function StatusBadge({ status }: { status: string }) {
  const { t } = useTranslation();
  const label = t(`accounting.stripe.status.${status}`, { defaultValue: status });
  const cls =
    status === "matched"
      ? "bg-green-100 text-green-800 border-green-200"
      : status === "partial"
        ? "bg-yellow-100 text-yellow-800 border-yellow-200"
        : status === "unmatched" || status === "error"
          ? "bg-red-100 text-red-800 border-red-200"
          : status === "synced"
            ? "bg-blue-100 text-blue-800 border-blue-200"
            : "bg-gray-100 text-gray-700 border-gray-200";
  return (
    <Badge variant="outline" className={`text-xs font-medium ${cls}`}>
      {label}
    </Badge>
  );
}

function ReconciliationIcon({ status }: { status: string | null }) {
  if (status === "matched") return <CheckCircle2 className="w-4 h-4 text-green-600 shrink-0" />;
  if (status === "unmatched") return <XCircle className="w-4 h-4 text-red-500 shrink-0" />;
  if (status === "partial") return <AlertCircle className="w-4 h-4 text-yellow-500 shrink-0" />;
  return null;
}

function StripeDetailDrawer({
  open,
  onClose,
  detail,
}: {
  open: boolean;
  onClose: () => void;
  detail: SourceMonthDetail | null;
}) {
  const { t } = useTranslation();

  if (!detail) return null;
  const { sourceMonth, syncRuns, lines } = detail;
  const summary = sourceMonth.stripe_summary;
  const lastRun = syncRuns[0] ?? null;

  const rollForwardRows = summary
    ? [
        { label: t("accounting.stripe.rollForward.opening"), cents: summary.openingBalanceCents, bold: false },
        { label: t("accounting.stripe.rollForward.grossCharges"), cents: summary.stripeChargesAmountCents, bold: false },
        { label: t("accounting.stripe.rollForward.refunds"), cents: -summary.refundsCents, bold: false },
        { label: t("accounting.stripe.rollForward.fees"), cents: -summary.feesCents, bold: false },
        { label: t("accounting.stripe.rollForward.disputes"), cents: -summary.disputesCents, bold: false },
        { label: t("accounting.stripe.rollForward.adjustments"), cents: summary.adjustmentsCents, bold: false },
        { label: t("accounting.stripe.rollForward.payouts"), cents: -summary.payoutsCents, bold: false },
        { label: t("accounting.stripe.rollForward.closing"), cents: summary.closingBalanceCents, bold: true },
      ]
    : [];

  return (
    <Sheet open={open} onOpenChange={(v) => { if (!v) onClose(); }}>
      <SheetContent side="right" className="w-full sm:max-w-2xl overflow-y-auto">
        <SheetHeader className="mb-6">
          <SheetTitle>{t("accounting.stripe.detailTitle")}</SheetTitle>
          <SheetDescription>{t("accounting.stripe.detailSubtitle")}</SheetDescription>
        </SheetHeader>

        {lastRun?.status === "failed" && (
          <div className="mb-4 rounded-md border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">
            {t("accounting.stripe.syncFailed")}: {lastRun.error_message}
          </div>
        )}

        <div className="flex flex-col gap-6">
          <div className="flex gap-4 flex-wrap">
            <div className="flex items-center gap-1.5 text-sm">
              <span className="text-muted-foreground">{t("accounting.stripe.reconciliationStatus")}:</span>
              <ReconciliationIcon status={sourceMonth.sales_reconciliation_status} />
              <StatusBadge status={sourceMonth.sales_reconciliation_status ?? "pending"} />
            </div>
            <div className="flex items-center gap-1.5 text-sm">
              <span className="text-muted-foreground">{t("accounting.stripe.payoutStatus")}:</span>
              <ReconciliationIcon status={sourceMonth.payout_reconciliation_status} />
              <StatusBadge status={sourceMonth.payout_reconciliation_status ?? "unknown"} />
            </div>
          </div>

          {summary && (
            <>
              <div>
                <h3 className="text-sm font-semibold mb-3">{t("accounting.stripe.summary.title")}</h3>
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead></TableHead>
                      <TableHead className="text-right">{t("accounting.stripe.summary.count")}</TableHead>
                      <TableHead className="text-right">{t("accounting.stripe.summary.amount")}</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    <TableRow>
                      <TableCell className="font-medium">{t("accounting.stripe.summary.osOrders")}</TableCell>
                      <TableCell className="text-right">{summary.osOrdersCount}</TableCell>
                      <TableCell className="text-right">{formatCents(summary.osGrossSalesCents)}</TableCell>
                    </TableRow>
                    <TableRow>
                      <TableCell className="font-medium">{t("accounting.stripe.summary.stripeCharges")}</TableCell>
                      <TableCell className="text-right">{summary.stripeChargesCount}</TableCell>
                      <TableCell className="text-right">{formatCents(summary.stripeChargesAmountCents)}</TableCell>
                    </TableRow>
                    <TableRow className="bg-green-50/40">
                      <TableCell className="font-medium text-green-700">{t("accounting.stripe.summary.matched")}</TableCell>
                      <TableCell className="text-right text-green-700">{summary.matchedCount}</TableCell>
                      <TableCell className="text-right">—</TableCell>
                    </TableRow>
                    <TableRow className={summary.unmatchedStripeCount > 0 ? "bg-red-50/40" : ""}>
                      <TableCell className={summary.unmatchedStripeCount > 0 ? "font-medium text-red-700" : "font-medium text-muted-foreground"}>
                        {t("accounting.stripe.summary.unmatchedStripe")}
                      </TableCell>
                      <TableCell className={`text-right ${summary.unmatchedStripeCount > 0 ? "text-red-700" : ""}`}>
                        {summary.unmatchedStripeCount}
                      </TableCell>
                      <TableCell className="text-right">—</TableCell>
                    </TableRow>
                    <TableRow className={summary.unmatchedOsCount > 0 ? "bg-red-50/40" : ""}>
                      <TableCell className={summary.unmatchedOsCount > 0 ? "font-medium text-red-700" : "font-medium text-muted-foreground"}>
                        {t("accounting.stripe.summary.unmatchedOs")}
                      </TableCell>
                      <TableCell className={`text-right ${summary.unmatchedOsCount > 0 ? "text-red-700" : ""}`}>
                        {summary.unmatchedOsCount}
                      </TableCell>
                      <TableCell className="text-right">—</TableCell>
                    </TableRow>
                  </TableBody>
                </Table>
              </div>

              <div>
                <h3 className="text-sm font-semibold mb-3">{t("accounting.stripe.rollForward.title")}</h3>
                <Table>
                  <TableBody>
                    {rollForwardRows.map((row, i) => (
                      <TableRow key={i} className={row.bold ? "border-t-2 font-semibold" : ""}>
                        <TableCell className={row.bold ? "font-semibold" : ""}>{row.label}</TableCell>
                        <TableCell className={`text-right font-mono ${row.cents < 0 ? "text-red-600" : ""} ${row.bold ? "font-semibold" : ""}`}>
                          {row.cents >= 0 ? "+" : ""}{formatCents(row.cents)}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            </>
          )}

          {lines.length > 0 && (
            <div>
              <h3 className="text-sm font-semibold mb-3">{t("accounting.stripe.transactions.title")}</h3>
              <div className="max-h-96 overflow-y-auto border rounded-md">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>{t("accounting.stripe.transactions.date")}</TableHead>
                      <TableHead>{t("accounting.stripe.transactions.type")}</TableHead>
                      <TableHead>{t("accounting.stripe.transactions.description")}</TableHead>
                      <TableHead className="text-right">{t("accounting.stripe.transactions.amount")}</TableHead>
                      <TableHead>{t("accounting.stripe.transactions.status")}</TableHead>
                      <TableHead>{t("accounting.stripe.transactions.osOrder")}</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {lines.map((line) => (
                      <TableRow key={line.id}>
                        <TableCell className="text-xs text-muted-foreground whitespace-nowrap">
                          {line.line_date ?? "—"}
                        </TableCell>
                        <TableCell>
                          <Badge variant="outline" className="text-xs">
                            {line.line_type
                              ? t(`accounting.stripe.lineType.${line.line_type}`, { defaultValue: line.line_type })
                              : "—"}
                          </Badge>
                        </TableCell>
                        <TableCell className="text-xs max-w-[160px] truncate">
                          {line.description ?? "—"}
                        </TableCell>
                        <TableCell className={`text-right text-xs font-mono ${line.amount_cents < 0 ? "text-red-600" : ""}`}>
                          {formatCents(line.amount_cents, line.currency)}
                        </TableCell>
                        <TableCell>
                          {line.is_matched ? (
                            <div className="flex items-center gap-1">
                              <CheckCircle2 className="w-3 h-3 text-green-600 shrink-0" />
                              <span className="text-xs text-green-700">
                                {t(`accounting.stripe.confidence.${line.match_confidence ?? "high"}`, {
                                  defaultValue: line.match_confidence ?? "",
                                })}
                              </span>
                            </div>
                          ) : (
                            <span className="text-xs text-muted-foreground">
                              {t("accounting.stripe.confidence.none")}
                            </span>
                          )}
                        </TableCell>
                        <TableCell>
                          {line.matched_order_id ? (
                            <a
                              href={`/orders/${line.matched_order_id}`}
                              target="_blank"
                              rel="noreferrer"
                              className="flex items-center gap-1 text-xs text-primary hover:underline"
                            >
                              <ExternalLink className="w-3 h-3" />
                              {line.matched_order_id.slice(0, 8)}…
                            </a>
                          ) : (
                            <span className="text-xs text-muted-foreground">—</span>
                          )}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
              <p className="text-xs text-muted-foreground mt-1">
                {lines.length >= 500
                  ? "Showing first 500 transactions"
                  : `${lines.length} transaction${lines.length !== 1 ? "s" : ""}`}
              </p>
            </div>
          )}

          {syncRuns.length > 0 && (
            <div>
              <h3 className="text-sm font-semibold mb-2">Sync History</h3>
              <div className="flex flex-col gap-1.5">
                {syncRuns.slice(0, 5).map((run) => (
                  <div
                    key={run.id}
                    className="flex items-start justify-between text-xs text-muted-foreground border rounded px-3 py-2 gap-2"
                  >
                    <span>
                      {new Date(run.started_at).toLocaleString()} — {run.status}
                      {run.records_synced > 0 ? ` (${run.records_synced} records)` : ""}
                    </span>
                    {run.status === "failed" && (
                      <span className="text-red-600 max-w-[200px] truncate shrink-0">
                        {run.error_message}
                      </span>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}

function CardLinesTable({ lines }: { lines: AccountingStatementLine[] }) {
  const { t } = useTranslation();
  return (
    <div className="overflow-x-auto">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>{t("accounting.sources.lineDate")}</TableHead>
            <TableHead>{t("accounting.sources.lineRef")}</TableHead>
            <TableHead>{t("accounting.sources.location")}</TableHead>
            <TableHead>{t("accounting.sources.processor")}</TableHead>
            <TableHead className="text-right">{t("accounting.sources.lineAmount")} (USD)</TableHead>
            <TableHead className="text-right">{t("accounting.sources.refunds")} (USD)</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {lines.map((line) => {
            const meta = line.metadata as CardLineMetadata;
            return (
              <TableRow key={line.id}>
                <TableCell className="text-sm whitespace-nowrap">
                  {line.line_date?.substring(0, 10) ?? "—"}
                </TableCell>
                <TableCell className="text-sm font-mono">
                  {meta.display_order_number ?? line.reference ?? "—"}
                </TableCell>
                <TableCell className="text-sm">{meta.location_name ?? "—"}</TableCell>
                <TableCell className="text-sm">{meta.provider ?? meta.method ?? "card"}</TableCell>
                <TableCell className="text-right font-mono text-sm">
                  {meta.amount_usd
                    ? `$${parseFloat(meta.amount_usd).toFixed(2)}`
                    : formatCents(line.amount_cents, "USD")}
                </TableCell>
                <TableCell className="text-right font-mono text-sm text-red-600">
                  {meta.refunded_amount_usd && parseFloat(meta.refunded_amount_usd) > 0
                    ? `$${parseFloat(meta.refunded_amount_usd).toFixed(2)}`
                    : "—"}
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </div>
  );
}

// ── Source Detail Drawer ──────────────────────────────────────────────────────

function SourceDetailDrawer({
  sourceMonth,
  open,
  onClose,
}: {
  sourceMonth: AccountingSourceMonth | null;
  open: boolean;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const linesId = sourceMonth?.id ?? 0;
  const { data, isLoading } = useGetAccountingSourceMonthLines(linesId, {
    query: {
      queryKey: getGetAccountingSourceMonthLinesQueryKey(linesId),
      enabled: open && sourceMonth != null,
    },
  });

  const lines = data?.lines ?? [];
  const summary = data?.summary;

  return (
    <Sheet open={open} onOpenChange={(v) => !v && onClose()}>
      <SheetContent
        side="right"
        className="w-full sm:max-w-3xl flex flex-col overflow-hidden p-0"
      >
        <SheetHeader className="px-6 py-4 border-b">
          <SheetTitle className="flex items-center justify-between pr-8">
            <div className="flex flex-col gap-1">
              <span>{sourceMonth?.source_name}</span>
              <span className="text-xs font-normal text-muted-foreground uppercase tracking-wider">
                {sourceMonth?.source_type}
              </span>
            </div>
            {summary && summary.by_currency.length > 0 && (
              <div className="flex gap-4">
                {summary.by_currency.map((s) => (
                  <div key={s.currency} className="text-right">
                    <p className="text-[10px] text-muted-foreground uppercase tracking-tight leading-none mb-1">
                      {s.currency} {t("accounting.sources.total")}
                    </p>
                    <p className="text-sm font-mono font-semibold leading-none">
                      {formatCents(s.total_cents, s.currency)}
                    </p>
                  </div>
                ))}
              </div>
            )}
          </SheetTitle>
        </SheetHeader>

        <div className="flex-1 overflow-y-auto">
          {isLoading ? (
            <div className="p-12 space-y-4">
              <Skeleton className="h-8 w-full" />
              <Skeleton className="h-32 w-full" />
              <Skeleton className="h-32 w-full" />
            </div>
          ) : lines.length === 0 ? (
            <div className="p-12 text-center text-muted-foreground">
              {t("accounting.sources.noLines")}
            </div>
          ) : sourceMonth?.source_type === "retail_cash" ? (
            <CashLinesTable lines={lines} />
          ) : (
            <CardLinesTable lines={lines} />
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}

function StripeSourceCard({ accountingMonthId }: { accountingMonthId: number | null }) {
  const { t } = useTranslation();
  const { toast } = useToast();
  const [sourceMonth, setSourceMonth] = useState<SourceMonthRow | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [loadingDetail, setLoadingDetail] = useState(false);
  const [detail, setDetail] = useState<SourceMonthDetail | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);

  const fetchDetail = useCallback(async (smId: number): Promise<SourceMonthDetail> => {
    return apiFetch<SourceMonthDetail>(`/api/accounting/source-months/${smId}`);
  }, []);

  const handleSync = useCallback(async () => {
    if (!accountingMonthId) return;
    setSyncing(true);
    try {
      let smId = sourceMonth?.id ?? null;

      if (smId == null) {
        const ensureData = await apiFetch<{ sourceMonth: SourceMonthRow }>(
          "/api/accounting/source-months/ensure",
          {
            method: "POST",
            body: JSON.stringify({ accounting_month_id: accountingMonthId, source_type: "stripe" }),
          },
        );
        setSourceMonth(ensureData.sourceMonth);
        smId = ensureData.sourceMonth.id;
      }

      await apiFetch<{ ok: boolean }>(`/api/accounting/source-months/${smId}/sync`, {
        method: "POST",
      });

      toast({ title: t("accounting.stripe.syncSuccess") });

      const d = await fetchDetail(smId);
      setSourceMonth(d.sourceMonth);
      setDetail(d);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      toast({ title: t("accounting.stripe.syncFailed"), description: msg, variant: "destructive" });
    } finally {
      setSyncing(false);
    }
  }, [accountingMonthId, sourceMonth, t, toast, fetchDetail]);

  const handleViewDetail = useCallback(async () => {
    if (!sourceMonth) return;
    setLoadingDetail(true);
    try {
      const d = await fetchDetail(sourceMonth.id);
      setDetail(d);
      setDrawerOpen(true);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      toast({ title: "Error", description: msg, variant: "destructive" });
    } finally {
      setLoadingDetail(false);
    }
  }, [sourceMonth, fetchDetail, toast]);

  const hasSynced = sourceMonth && sourceMonth.status !== "pending";
  const lastSyncedStr = sourceMonth?.updated_at
    ? new Date(sourceMonth.updated_at).toLocaleString()
    : null;

  return (
    <>
      <div className="rounded-lg border bg-card p-4 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div className="flex flex-col gap-1">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="font-semibold text-sm">{t("accounting.stripe.sourceName")}</span>
            {sourceMonth && <StatusBadge status={sourceMonth.status} />}
            {sourceMonth?.sales_reconciliation_status && (
              <div className="flex items-center gap-1">
                <ReconciliationIcon status={sourceMonth.sales_reconciliation_status} />
                <StatusBadge status={sourceMonth.sales_reconciliation_status} />
              </div>
            )}
          </div>
          <p className="text-xs text-muted-foreground">
            {hasSynced && lastSyncedStr
              ? `${t("accounting.stripe.lastSynced")}: ${lastSyncedStr}`
              : t("accounting.stripe.neverSynced")}
          </p>
          {sourceMonth?.stripe_summary && (
            <p className="text-xs text-muted-foreground">
              {sourceMonth.stripe_summary.stripeChargesCount} charges ·{" "}
              {sourceMonth.stripe_summary.matchedCount} matched ·{" "}
              {formatCents(sourceMonth.stripe_summary.stripeChargesAmountCents)}
            </p>
          )}
        </div>

        <div className="flex items-center gap-2 shrink-0">
          {hasSynced && (
            <Button
              variant="outline"
              size="sm"
              onClick={handleViewDetail}
              disabled={loadingDetail}
            >
              {t("accounting.stripe.viewDetails")}
            </Button>
          )}
          <Button
            size="sm"
            onClick={handleSync}
            disabled={syncing || !accountingMonthId}
            className="gap-2"
          >
            <RefreshCw size={14} className={syncing ? "animate-spin" : ""} />
            {syncing ? t("accounting.stripe.syncing") : t("accounting.stripe.sync")}
          </Button>
        </div>
      </div>

      <StripeDetailDrawer
        open={drawerOpen}
        onClose={() => setDrawerOpen(false)}
        detail={detail}
      />
    </>
  );
}

function PayPalDetailDrawer({
  open,
  onClose,
  detail,
}: {
  open: boolean;
  onClose: () => void;
  detail: SourceMonthDetail | null;
}) {
  const { t } = useTranslation();

  if (!detail) return null;
  const { sourceMonth, syncRuns, lines } = detail;
  const summary = sourceMonth.stripe_summary as PaypalSummary | null;
  const lastRun = syncRuns[0] ?? null;

  return (
    <Sheet open={open} onOpenChange={(v) => { if (!v) onClose(); }}>
      <SheetContent side="right" className="w-full sm:max-w-2xl overflow-y-auto">
        <SheetHeader className="mb-6">
          <SheetTitle>{t("accounting.paypal.detailTitle")}</SheetTitle>
          <SheetDescription>{t("accounting.paypal.detailSubtitle")}</SheetDescription>
        </SheetHeader>

        {lastRun?.status === "failed" && (
          <div className="mb-4 rounded-md border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">
            {t("accounting.paypal.syncFailed")}: {lastRun.error_message}
          </div>
        )}

        <div className="flex flex-col gap-6">
          <div className="flex gap-4 flex-wrap">
            <div className="flex items-center gap-1.5 text-sm">
              <span className="text-muted-foreground">{t("accounting.paypal.reconciliationStatus")}:</span>
              <ReconciliationIcon status={sourceMonth.sales_reconciliation_status} />
              <StatusBadge status={sourceMonth.sales_reconciliation_status ?? "pending"} />
            </div>
          </div>

          {summary && (
            <div>
              <h3 className="text-sm font-semibold mb-3">{t("accounting.paypal.summary.title")}</h3>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead></TableHead>
                    <TableHead className="text-right">{t("accounting.paypal.summary.count")}</TableHead>
                    <TableHead className="text-right">{t("accounting.paypal.summary.amount")}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  <TableRow>
                    <TableCell className="font-medium">{t("accounting.paypal.summary.osOrders")}</TableCell>
                    <TableCell className="text-right">{summary.osOrdersCount}</TableCell>
                    <TableCell className="text-right">{formatCents(summary.osOrdersAmountCents)}</TableCell>
                  </TableRow>
                  <TableRow>
                    <TableCell className="font-medium">{t("accounting.paypal.summary.paypalTransactions")}</TableCell>
                    <TableCell className="text-right">{summary.paypalTransactionsCount}</TableCell>
                    <TableCell className="text-right">{formatCents(summary.paypalTotalCents)}</TableCell>
                  </TableRow>
                  <TableRow className="bg-green-50/40">
                    <TableCell className="font-medium text-green-700">{t("accounting.paypal.summary.matched")}</TableCell>
                    <TableCell className="text-right text-green-700">{summary.matchedCount}</TableCell>
                    <TableCell className="text-right">—</TableCell>
                  </TableRow>
                  <TableRow className={summary.unmatchedPaypalCount > 0 ? "bg-red-50/40" : ""}>
                    <TableCell className={summary.unmatchedPaypalCount > 0 ? "font-medium text-red-700" : "font-medium text-muted-foreground"}>
                      {t("accounting.paypal.summary.unmatchedPaypal")}
                    </TableCell>
                    <TableCell className={`text-right ${summary.unmatchedPaypalCount > 0 ? "text-red-700" : ""}`}>
                      {summary.unmatchedPaypalCount}
                    </TableCell>
                    <TableCell className="text-right">—</TableCell>
                  </TableRow>
                  <TableRow className={summary.unmatchedOsCount > 0 ? "bg-red-50/40" : ""}>
                    <TableCell className={summary.unmatchedOsCount > 0 ? "font-medium text-red-700" : "font-medium text-muted-foreground"}>
                      {t("accounting.paypal.summary.unmatchedOs")}
                    </TableCell>
                    <TableCell className={`text-right ${summary.unmatchedOsCount > 0 ? "text-red-700" : ""}`}>
                      {summary.unmatchedOsCount}
                    </TableCell>
                    <TableCell className="text-right">—</TableCell>
                  </TableRow>
                </TableBody>
              </Table>
            </div>
          )}

          {lines.length > 0 && (
            <div>
              <h3 className="text-sm font-semibold mb-3">{t("accounting.paypal.transactions.title")}</h3>
              <div className="max-h-96 overflow-y-auto border rounded-md">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>{t("accounting.paypal.transactions.date")}</TableHead>
                      <TableHead>{t("accounting.paypal.transactions.description")}</TableHead>
                      <TableHead className="text-right">{t("accounting.paypal.transactions.amount")}</TableHead>
                      <TableHead>{t("accounting.paypal.transactions.status")}</TableHead>
                      <TableHead>{t("accounting.paypal.transactions.osOrder")}</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {lines.map((line) => (
                      <TableRow key={line.id}>
                        <TableCell className="text-xs text-muted-foreground whitespace-nowrap">
                          {line.line_date ?? "—"}
                        </TableCell>
                        <TableCell className="text-xs max-w-[200px] truncate">
                          {line.description ?? "—"}
                        </TableCell>
                        <TableCell className={`text-right text-xs font-mono ${line.amount_cents < 0 ? "text-red-600" : ""}`}>
                          {formatCents(line.amount_cents, line.currency)}
                        </TableCell>
                        <TableCell>
                          {line.is_matched ? (
                            <div className="flex items-center gap-1">
                              <CheckCircle2 className="w-3 h-3 text-green-600 shrink-0" />
                              <span className="text-xs text-green-700">{t("accounting.stripe.confidence.high")}</span>
                            </div>
                          ) : (
                            <span className="text-xs text-muted-foreground">{t("accounting.stripe.confidence.none")}</span>
                          )}
                        </TableCell>
                        <TableCell>
                          {line.matched_order_id ? (
                            <a
                              href={`/orders/${line.matched_order_id}`}
                              target="_blank"
                              rel="noreferrer"
                              className="flex items-center gap-1 text-xs text-primary hover:underline"
                            >
                              <ExternalLink className="w-3 h-3" />
                              {line.matched_order_id.slice(0, 8)}…
                            </a>
                          ) : (
                            <span className="text-xs text-muted-foreground">—</span>
                          )}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
              <p className="text-xs text-muted-foreground mt-1">
                {lines.length >= 500
                  ? "Showing first 500 transactions"
                  : `${lines.length} transaction${lines.length !== 1 ? "s" : ""}`}
              </p>
            </div>
          )}

          {syncRuns.length > 0 && (
            <div>
              <h3 className="text-sm font-semibold mb-2">Sync History</h3>
              <div className="flex flex-col gap-1.5">
                {syncRuns.slice(0, 5).map((run) => (
                  <div
                    key={run.id}
                    className="flex items-start justify-between text-xs text-muted-foreground border rounded px-3 py-2 gap-2"
                  >
                    <span>
                      {new Date(run.started_at).toLocaleString()} — {run.status}
                      {run.records_synced > 0 ? ` (${run.records_synced} records)` : ""}
                    </span>
                    {run.status === "failed" && (
                      <span className="text-red-600 max-w-[200px] truncate shrink-0">
                        {run.error_message}
                      </span>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}

function CashDetailDrawer({
  open,
  onClose,
  detail,
}: {
  open: boolean;
  onClose: () => void;
  detail: SourceMonthDetail | null;
}) {
  const { t } = useTranslation();

  if (!detail) return null;
  const { sourceMonth, syncRuns, lines } = detail;
  const summary = sourceMonth.stripe_summary as CashSummary | null;
  const lastRun = syncRuns[0] ?? null;

  const sessionLines = lines.filter((l) => l.line_type === "cash_session");
  const orderLines = lines.filter((l) => l.line_type === "cash_payment");

  return (
    <Sheet open={open} onOpenChange={(v) => { if (!v) onClose(); }}>
      <SheetContent side="right" className="w-full sm:max-w-2xl overflow-y-auto">
        <SheetHeader className="mb-6">
          <SheetTitle>{t("accounting.cash.detailTitle")}</SheetTitle>
          <SheetDescription>{t("accounting.cash.detailSubtitle")}</SheetDescription>
        </SheetHeader>

        {lastRun?.status === "failed" && (
          <div className="mb-4 rounded-md border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">
            {t("accounting.cash.syncFailed")}: {lastRun.error_message}
          </div>
        )}

        <div className="flex flex-col gap-6">
          <div className="flex gap-4 flex-wrap">
            <div className="flex items-center gap-1.5 text-sm">
              <span className="text-muted-foreground">{t("accounting.cash.reconciliationStatus")}:</span>
              <ReconciliationIcon status={sourceMonth.sales_reconciliation_status} />
              <StatusBadge status={sourceMonth.sales_reconciliation_status ?? "pending"} />
            </div>
            <a
              href="/cash-sessions"
              target="_blank"
              rel="noreferrer"
              className="flex items-center gap-1 text-xs text-primary hover:underline"
            >
              <ExternalLink className="w-3 h-3" />
              {t("accounting.cash.viewSessions")}
            </a>
          </div>

          {summary && (
            <div>
              <h3 className="text-sm font-semibold mb-3">{t("accounting.cash.summary.title")}</h3>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead></TableHead>
                    <TableHead className="text-right">{t("accounting.cash.summary.count")}</TableHead>
                    <TableHead className="text-right">{t("accounting.cash.summary.amount")}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  <TableRow>
                    <TableCell className="font-medium">{t("accounting.cash.summary.sessions")}</TableCell>
                    <TableCell className="text-right">{summary.sessionsCount}</TableCell>
                    <TableCell className="text-right">{formatCents(summary.cashSessionsTotalCents)}</TableCell>
                  </TableRow>
                  <TableRow>
                    <TableCell className="font-medium text-muted-foreground ps-6">
                      {t("accounting.cash.summary.closedSessions")}
                    </TableCell>
                    <TableCell className="text-right text-muted-foreground">{summary.closedSessionsCount}</TableCell>
                    <TableCell className="text-right">—</TableCell>
                  </TableRow>
                  <TableRow>
                    <TableCell className="font-medium">{t("accounting.cash.summary.osOrders")}</TableCell>
                    <TableCell className="text-right">{summary.osOrdersCount}</TableCell>
                    <TableCell className="text-right">{formatCents(summary.osOrdersAmountCents)}</TableCell>
                  </TableRow>
                </TableBody>
              </Table>
            </div>
          )}

          {sessionLines.length > 0 && (
            <div>
              <h3 className="text-sm font-semibold mb-3">{t("accounting.cash.sessions.title")}</h3>
              <div className="max-h-80 overflow-y-auto border rounded-md">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>{t("accounting.cash.sessions.date")}</TableHead>
                      <TableHead>{t("accounting.cash.sessions.session")}</TableHead>
                      <TableHead>{t("accounting.cash.sessions.status")}</TableHead>
                      <TableHead className="text-right">{t("accounting.cash.sessions.total")}</TableHead>
                      <TableHead></TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {sessionLines.map((line) => {
                      const meta = (line as { metadata?: { session_id?: number; status?: string; difference?: string | null } } & typeof line).metadata as { session_id?: number; status?: string; difference?: string | null } | undefined;
                      return (
                        <TableRow key={line.id}>
                          <TableCell className="text-xs text-muted-foreground whitespace-nowrap">
                            {line.line_date ?? "—"}
                          </TableCell>
                          <TableCell className="text-xs">{line.description ?? "—"}</TableCell>
                          <TableCell>
                            <Badge variant="outline" className="text-xs capitalize">
                              {meta?.status ?? "—"}
                            </Badge>
                          </TableCell>
                          <TableCell className="text-right text-xs font-mono">
                            {formatCents(line.amount_cents, line.currency)}
                          </TableCell>
                          <TableCell>
                            {meta?.session_id && (
                              <a
                                href={`/cash-sessions?session=${meta.session_id}`}
                                target="_blank"
                                rel="noreferrer"
                                className="flex items-center gap-1 text-xs text-primary hover:underline"
                              >
                                <ExternalLink className="w-3 h-3" />
                              </a>
                            )}
                          </TableCell>
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
              </div>
            </div>
          )}

          {orderLines.length > 0 && (
            <div>
              <h3 className="text-sm font-semibold mb-3">{t("accounting.cash.summary.osOrders")}</h3>
              <div className="max-h-64 overflow-y-auto border rounded-md">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>{t("accounting.cash.sessions.date")}</TableHead>
                      <TableHead className="text-right">{t("accounting.cash.sessions.total")}</TableHead>
                      <TableHead>{t("accounting.paypal.transactions.osOrder")}</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {orderLines.map((line) => (
                      <TableRow key={line.id}>
                        <TableCell className="text-xs text-muted-foreground">{line.line_date ?? "—"}</TableCell>
                        <TableCell className="text-right text-xs font-mono">
                          {formatCents(line.amount_cents, line.currency)}
                        </TableCell>
                        <TableCell>
                          {line.matched_order_id ? (
                            <a
                              href={`/orders/${line.matched_order_id}`}
                              target="_blank"
                              rel="noreferrer"
                              className="flex items-center gap-1 text-xs text-primary hover:underline"
                            >
                              <ExternalLink className="w-3 h-3" />
                              {line.matched_order_id.slice(0, 8)}…
                            </a>
                          ) : (
                            <span className="text-xs text-muted-foreground">—</span>
                          )}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            </div>
          )}

          {syncRuns.length > 0 && (
            <div>
              <h3 className="text-sm font-semibold mb-2">Sync History</h3>
              <div className="flex flex-col gap-1.5">
                {syncRuns.slice(0, 5).map((run) => (
                  <div
                    key={run.id}
                    className="flex items-start justify-between text-xs text-muted-foreground border rounded px-3 py-2 gap-2"
                  >
                    <span>
                      {new Date(run.started_at).toLocaleString()} — {run.status}
                      {run.records_synced > 0 ? ` (${run.records_synced} records)` : ""}
                    </span>
                    {run.status === "failed" && (
                      <span className="text-red-600 max-w-[200px] truncate shrink-0">
                        {run.error_message}
                      </span>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}

function PayPalSourceCard({ accountingMonthId }: { accountingMonthId: number | null }) {
  const { t } = useTranslation();
  const { toast } = useToast();
  const [sourceMonth, setSourceMonth] = useState<SourceMonthRow | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [loadingDetail, setLoadingDetail] = useState(false);
  const [detail, setDetail] = useState<SourceMonthDetail | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);

  const fetchDetail = useCallback(async (smId: number): Promise<SourceMonthDetail> => {
    return apiFetch<SourceMonthDetail>(`/api/accounting/source-months/${smId}`);
  }, []);

  const handleSync = useCallback(async () => {
    if (!accountingMonthId) return;
    setSyncing(true);
    try {
      let smId = sourceMonth?.id ?? null;

      if (smId == null) {
        const ensureData = await apiFetch<{ sourceMonth: SourceMonthRow }>(
          "/api/accounting/source-months/ensure",
          {
            method: "POST",
            body: JSON.stringify({ accounting_month_id: accountingMonthId, source_type: "paypal" }),
          },
        );
        setSourceMonth(ensureData.sourceMonth);
        smId = ensureData.sourceMonth.id;
      }

      await apiFetch<{ ok: boolean }>(`/api/accounting/source-months/${smId}/sync`, {
        method: "POST",
      });

      toast({ title: t("accounting.paypal.syncSuccess") });

      const d = await fetchDetail(smId);
      setSourceMonth(d.sourceMonth);
      setDetail(d);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      toast({ title: t("accounting.paypal.syncFailed"), description: msg, variant: "destructive" });
    } finally {
      setSyncing(false);
    }
  }, [accountingMonthId, sourceMonth, t, toast, fetchDetail]);

  const handleViewDetail = useCallback(async () => {
    if (!sourceMonth) return;
    setLoadingDetail(true);
    try {
      const d = await fetchDetail(sourceMonth.id);
      setDetail(d);
      setDrawerOpen(true);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      toast({ title: "Error", description: msg, variant: "destructive" });
    } finally {
      setLoadingDetail(false);
    }
  }, [sourceMonth, fetchDetail, toast]);

  const hasSynced = sourceMonth && sourceMonth.status !== "pending";
  const lastSyncedStr = sourceMonth?.updated_at
    ? new Date(sourceMonth.updated_at).toLocaleString()
    : null;
  const paypalSummary = sourceMonth?.stripe_summary as PaypalSummary | null;

  return (
    <>
      <div className="rounded-lg border bg-card p-4 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div className="flex flex-col gap-1">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="font-semibold text-sm">{t("accounting.paypal.sourceName")}</span>
            {sourceMonth && <StatusBadge status={sourceMonth.status} />}
            {sourceMonth?.sales_reconciliation_status && (
              <div className="flex items-center gap-1">
                <ReconciliationIcon status={sourceMonth.sales_reconciliation_status} />
                <StatusBadge status={sourceMonth.sales_reconciliation_status} />
              </div>
            )}
          </div>
          <p className="text-xs text-muted-foreground">
            {hasSynced && lastSyncedStr
              ? `${t("accounting.paypal.lastSynced")}: ${lastSyncedStr}`
              : t("accounting.paypal.neverSynced")}
          </p>
          {paypalSummary && (
            <p className="text-xs text-muted-foreground">
              {paypalSummary.paypalTransactionsCount} transactions ·{" "}
              {paypalSummary.matchedCount} matched ·{" "}
              {formatCents(paypalSummary.paypalTotalCents)}
            </p>
          )}
        </div>

        <div className="flex items-center gap-2 shrink-0">
          {hasSynced && (
            <Button
              variant="outline"
              size="sm"
              onClick={handleViewDetail}
              disabled={loadingDetail}
            >
              {t("accounting.paypal.viewDetails")}
            </Button>
          )}
          <Button
            size="sm"
            onClick={handleSync}
            disabled={syncing || !accountingMonthId}
            className="gap-2"
          >
            <RefreshCw size={14} className={syncing ? "animate-spin" : ""} />
            {syncing ? t("accounting.paypal.syncing") : t("accounting.paypal.sync")}
          </Button>
        </div>
      </div>

      <PayPalDetailDrawer
        open={drawerOpen}
        onClose={() => setDrawerOpen(false)}
        detail={detail}
      />
    </>
  );
}

function CashSourceCard({ accountingMonthId }: { accountingMonthId: number | null }) {
  const { t } = useTranslation();
  const { toast } = useToast();
  const [sourceMonth, setSourceMonth] = useState<SourceMonthRow | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [loadingDetail, setLoadingDetail] = useState(false);
  const [detail, setDetail] = useState<SourceMonthDetail | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);

  const fetchDetail = useCallback(async (smId: number): Promise<SourceMonthDetail> => {
    return apiFetch<SourceMonthDetail>(`/api/accounting/source-months/${smId}`);
  }, []);

  const handleSync = useCallback(async () => {
    if (!accountingMonthId) return;
    setSyncing(true);
    try {
      let smId = sourceMonth?.id ?? null;

      if (smId == null) {
        const ensureData = await apiFetch<{ sourceMonth: SourceMonthRow }>(
          "/api/accounting/source-months/ensure",
          {
            method: "POST",
            body: JSON.stringify({ accounting_month_id: accountingMonthId, source_type: "cash" }),
          },
        );
        setSourceMonth(ensureData.sourceMonth);
        smId = ensureData.sourceMonth.id;
      }

      await apiFetch<{ ok: boolean }>(`/api/accounting/source-months/${smId}/sync`, {
        method: "POST",
      });

      toast({ title: t("accounting.cash.syncSuccess") });

      const d = await fetchDetail(smId);
      setSourceMonth(d.sourceMonth);
      setDetail(d);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      toast({ title: t("accounting.cash.syncFailed"), description: msg, variant: "destructive" });
    } finally {
      setSyncing(false);
    }
  }, [accountingMonthId, sourceMonth, t, toast, fetchDetail]);

  const handleViewDetail = useCallback(async () => {
    if (!sourceMonth) return;
    setLoadingDetail(true);
    try {
      const d = await fetchDetail(sourceMonth.id);
      setDetail(d);
      setDrawerOpen(true);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      toast({ title: "Error", description: msg, variant: "destructive" });
    } finally {
      setLoadingDetail(false);
    }
  }, [sourceMonth, fetchDetail, toast]);

  const hasSynced = sourceMonth && sourceMonth.status !== "pending";
  const lastSyncedStr = sourceMonth?.updated_at
    ? new Date(sourceMonth.updated_at).toLocaleString()
    : null;
  const cashSummary = sourceMonth?.stripe_summary as CashSummary | null;

  return (
    <>
      <div className="rounded-lg border bg-card p-4 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div className="flex flex-col gap-1">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="font-semibold text-sm">{t("accounting.cash.sourceName")}</span>
            {sourceMonth && <StatusBadge status={sourceMonth.status} />}
            {sourceMonth?.sales_reconciliation_status && (
              <div className="flex items-center gap-1">
                <ReconciliationIcon status={sourceMonth.sales_reconciliation_status} />
                <StatusBadge status={sourceMonth.sales_reconciliation_status} />
              </div>
            )}
          </div>
          <p className="text-xs text-muted-foreground">
            {hasSynced && lastSyncedStr
              ? `${t("accounting.cash.lastSynced")}: ${lastSyncedStr}`
              : t("accounting.cash.neverSynced")}
          </p>
          {cashSummary && (
            <p className="text-xs text-muted-foreground">
              {cashSummary.sessionsCount} sessions ·{" "}
              {cashSummary.osOrdersCount} OS orders ·{" "}
              {formatCents(cashSummary.cashSessionsTotalCents)}
            </p>
          )}
        </div>

        <div className="flex items-center gap-2 shrink-0">
          {hasSynced && (
            <Button
              variant="outline"
              size="sm"
              onClick={handleViewDetail}
              disabled={loadingDetail}
            >
              {t("accounting.cash.viewDetails")}
            </Button>
          )}
          <Button
            size="sm"
            onClick={handleSync}
            disabled={syncing || !accountingMonthId}
            className="gap-2"
          >
            <RefreshCw size={14} className={syncing ? "animate-spin" : ""} />
            {syncing ? t("accounting.cash.syncing") : t("accounting.cash.sync")}
          </Button>
        </div>
      </div>

      <CashDetailDrawer
        open={drawerOpen}
        onClose={() => setDrawerOpen(false)}
        detail={detail}
      />
    </>
  );
}

// ── Exceptions Tab ────────────────────────────────────────────────────────────

type WorkspaceMember = { id: string; clerkUserId: string; fullName: string | null; email: string };

const EXCEPTION_STATUSES = ["open", "assigned", "investigating", "resolved", "accepted_difference", "deferred"];

function ExceptionStatusBadge({ status }: { status: string }) {
  const { t } = useTranslation();
  const variants: Record<string, string> = {
    open: "bg-red-100 text-red-800 border-red-200",
    assigned: "bg-blue-100 text-blue-800 border-blue-200",
    investigating: "bg-amber-100 text-amber-800 border-amber-200",
    resolved: "bg-green-100 text-green-800 border-green-200",
    accepted_difference: "bg-purple-100 text-purple-800 border-purple-200",
    deferred: "bg-gray-100 text-gray-600 border-gray-200",
  };
  const cls = variants[status] ?? variants.open;
  return (
    <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium ${cls}`}>
      {t(`accounting.exceptions.status.${status}`, { defaultValue: status })}
    </span>
  );
}

function ExceptionsTab({ monthId, sourceMonthIds }: { monthId: number; sourceMonthIds: number[] }) {
  const { t } = useTranslation();
  const { toast } = useToast();
  const queryClient = useQueryClient();

  // Filters
  const [typeFilter, setTypeFilter] = useState("all");
  const [statusFilter, setStatusFilter] = useState("all");
  const [sourceFilter, setSourceFilter] = useState("all");
  const [assigneeFilter, setAssigneeFilter] = useState("all");
  const [page, setPage] = useState(1);

  // Selection
  const [selected, setSelected] = useState<Set<number>>(new Set());

  // Detail sheet
  const [detailException, setDetailException] = useState<AccountingException | null>(null);
  const [detailNotes, setDetailNotes] = useState("");
  const [detailResolution, setDetailResolution] = useState("");
  const [detailSaving, setDetailSaving] = useState(false);

  // Accept difference modal
  const [acceptDiffException, setAcceptDiffException] = useState<AccountingException | null>(null);
  const [acceptDiffReason, setAcceptDiffReason] = useState("");

  // Bulk assign
  const [bulkAssignOpen, setBulkAssignOpen] = useState(false);
  const [bulkAssignTarget, setBulkAssignTarget] = useState("");

  // Workspace members for assignee picker
  const { data: membersData } = useQuery<{ members: WorkspaceMember[] }>({
    queryKey: ["users"],
    queryFn: () => apiFetch("/api/users"),
    staleTime: 60_000,
  });
  const members = membersData?.members ?? [];

  // Exceptions query params
  const queryParams = {
    ...(typeFilter !== "all" ? { type: typeFilter } : {}),
    ...(statusFilter !== "all" ? { status: statusFilter } : {}),
    ...(sourceFilter !== "all" ? { source: Number(sourceFilter) } : {}),
    ...(assigneeFilter !== "all" ? { assignee: assigneeFilter } : {}),
    page,
    pageSize: 50,
  };

  const { data: exceptionsData, isLoading } = useGetAccountingExceptions(monthId, queryParams);

  const exceptions = exceptionsData?.exceptions ?? [];
  const pagination = exceptionsData?.pagination;

  // Reconcile mutation (runs per source month)
  const [reconciling, setReconciling] = useState(false);
  const reconcileMut = useReconcileAccountingSourceMonth();

  async function handleReconcileAll() {
    if (sourceMonthIds.length === 0) {
      toast({ title: t("accounting.exceptions.reconcileError"), variant: "destructive" });
      return;
    }
    setReconciling(true);
    let totalMatched = 0;
    let totalExceptions = 0;
    let anyError = false;
    for (const smId of sourceMonthIds) {
      try {
        const res = await reconcileMut.mutateAsync({ id: smId });
        totalMatched += res.reconciliation.linesMatched;
        totalExceptions += res.reconciliation.exceptionsRaised;
      } catch {
        anyError = true;
      }
    }
    setReconciling(false);
    if (anyError) {
      toast({ title: t("accounting.exceptions.reconcileError"), variant: "destructive" });
    } else {
      toast({
        title: t("accounting.exceptions.reconcileSuccess", {
          matched: totalMatched,
          exceptions: totalExceptions,
        }),
      });
    }
    void queryClient.invalidateQueries({ queryKey: getGetAccountingExceptionsQueryKey(monthId) });
    void queryClient.invalidateQueries({ queryKey: ["accounting-overview", monthId] });
  }

  // Patch mutation
  const patchMut = usePatchAccountingException();

  function handleStatusChange(ex: AccountingException, newStatus: string) {
    if (newStatus === "accepted_difference") {
      setAcceptDiffException(ex);
      setAcceptDiffReason("");
      return;
    }
    patchMut.mutate(
      { id: ex.id, data: { status: newStatus } },
      {
        onSuccess: () => {
          void queryClient.invalidateQueries({ queryKey: getGetAccountingExceptionsQueryKey(monthId) });
        },
        onError: () => {
          toast({ title: t("accounting.exceptions.reconcileError"), variant: "destructive" });
        },
      },
    );
  }

  function handleAcceptDiff() {
    if (!acceptDiffException || !acceptDiffReason.trim()) return;
    patchMut.mutate(
      {
        id: acceptDiffException.id,
        data: { status: "accepted_difference", accepted_difference_reason: acceptDiffReason.trim() },
      },
      {
        onSuccess: () => {
          setAcceptDiffException(null);
          setAcceptDiffReason("");
          void queryClient.invalidateQueries({ queryKey: getGetAccountingExceptionsQueryKey(monthId) });
        },
        onError: () => {
          toast({ title: t("accounting.exceptions.reconcileError"), variant: "destructive" });
        },
      },
    );
  }

  // Detail sheet save
  async function handleDetailSave() {
    if (!detailException) return;
    setDetailSaving(true);
    try {
      await patchMut.mutateAsync({
        id: detailException.id,
        data: {
          notes: detailNotes || null,
          resolution: detailResolution || null,
        },
      });
      void queryClient.invalidateQueries({ queryKey: getGetAccountingExceptionsQueryKey(monthId) });
      toast({ title: t("accounting.exceptions.detail.save") });
    } catch {
      toast({ title: t("accounting.exceptions.reconcileError"), variant: "destructive" });
    } finally {
      setDetailSaving(false);
    }
  }

  // Bulk assign mutation
  const bulkAssignMut = useBulkAssignAccountingExceptions();

  function handleBulkAssign() {
    if (!bulkAssignTarget || selected.size === 0) return;
    bulkAssignMut.mutate(
      { data: { exception_ids: Array.from(selected), assigned_to: bulkAssignTarget } },
      {
        onSuccess: () => {
          setBulkAssignOpen(false);
          setSelected(new Set());
          setBulkAssignTarget("");
          toast({
            title: t("accounting.exceptions.bulkAssignSuccess", { count: selected.size }),
          });
          void queryClient.invalidateQueries({ queryKey: getGetAccountingExceptionsQueryKey(monthId) });
        },
        onError: () => {
          toast({ title: t("accounting.exceptions.bulkAssignError"), variant: "destructive" });
        },
      },
    );
  }

  // Selection helpers
  function toggleSelect(id: number) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function toggleSelectAll() {
    if (selected.size === exceptions.length && exceptions.length > 0) {
      setSelected(new Set());
    } else {
      setSelected(new Set(exceptions.map((e) => e.id)));
    }
  }

  function resetFilters() {
    setTypeFilter("all");
    setStatusFilter("all");
    setSourceFilter("all");
    setAssigneeFilter("all");
    setPage(1);
    setSelected(new Set());
  }

  function formatAmount(amountCents: number | null | undefined, currency: string | null | undefined) {
    if (amountCents == null) return "—";
    const cur = currency ?? "USD";
    return `${cur} ${(amountCents / 100).toFixed(2)}`;
  }

  const allPageSelected = exceptions.length > 0 && selected.size === exceptions.length;
  const someSelected = selected.size > 0 && !allPageSelected;

  return (
    <div className="space-y-4">
      {/* Header row */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
          {/* Type filter */}
          <Select value={typeFilter} onValueChange={(v) => { setTypeFilter(v); setPage(1); }}>
            <SelectTrigger className="h-8 w-[160px] text-xs">
              <SelectValue placeholder={t("accounting.exceptions.filters.allTypes")} />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">{t("accounting.exceptions.filters.allTypes")}</SelectItem>
              {[
                "os_order_without_external_payment",
                "external_payment_without_os_order",
                "amount_mismatch",
                "currency_mismatch",
                "duplicate_payment",
                "missing_statement_transaction",
                "missing_os_transaction",
                "unrecorded_refund",
                "partial_refund_mismatch",
                "dispute",
                "chargeback",
                "missing_fee",
                "missing_payout",
                "payout_mismatch",
                "cash_over_short",
                "unclosed_cash_session",
                "marketplace_adjustment_without_order",
                "missing_supporting_document",
                "failed_sync",
              ].map((type) => (
                <SelectItem key={type} value={type}>
                  {t(`accounting.exceptions.type.${type}`, { defaultValue: type })}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>

          {/* Status filter */}
          <Select value={statusFilter} onValueChange={(v) => { setStatusFilter(v); setPage(1); }}>
            <SelectTrigger className="h-8 w-[140px] text-xs">
              <SelectValue placeholder={t("accounting.exceptions.filters.allStatuses")} />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">{t("accounting.exceptions.filters.allStatuses")}</SelectItem>
              {EXCEPTION_STATUSES.map((s) => (
                <SelectItem key={s} value={s}>
                  {t(`accounting.exceptions.status.${s}`, { defaultValue: s })}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>

          {/* Assignee filter */}
          <Select value={assigneeFilter} onValueChange={(v) => { setAssigneeFilter(v); setPage(1); }}>
            <SelectTrigger className="h-8 w-[140px] text-xs">
              <SelectValue placeholder={t("accounting.exceptions.filters.allAssignees")} />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">{t("accounting.exceptions.filters.allAssignees")}</SelectItem>
              <SelectItem value="unassigned">{t("accounting.exceptions.filters.unassigned")}</SelectItem>
              {members.map((m) => (
                <SelectItem key={m.clerkUserId} value={m.clerkUserId}>
                  {m.fullName ?? m.email}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>

          {(typeFilter !== "all" || statusFilter !== "all" || sourceFilter !== "all" || assigneeFilter !== "all") && (
            <Button variant="ghost" size="sm" onClick={resetFilters} className="h-8 text-xs">
              {t("accounting.exceptions.clearSelection")}
            </Button>
          )}
        </div>

        <div className="flex items-center gap-2">
          {selected.size > 0 && (
            <Button
              variant="outline"
              size="sm"
              className="h-8 text-xs gap-1"
              onClick={() => setBulkAssignOpen(true)}
            >
              <Users size={12} />
              {t("accounting.exceptions.bulkAssign")} ({selected.size})
            </Button>
          )}
          <Button
            variant="outline"
            size="sm"
            className="h-8 text-xs gap-1"
            onClick={handleReconcileAll}
            disabled={reconciling || sourceMonthIds.length === 0}
          >
            <RefreshCw size={12} className={reconciling ? "animate-spin" : ""} />
            {reconciling ? t("accounting.exceptions.reconciling") : t("accounting.exceptions.reconcile")}
          </Button>
        </div>
      </div>

      {/* Table */}
      {isLoading ? (
        <div className="space-y-2">
          {Array.from({ length: 5 }).map((_, i) => (
            <Skeleton key={i} className="h-12 rounded-lg" />
          ))}
        </div>
      ) : exceptions.length === 0 ? (
        <div className="flex flex-col items-center justify-center h-40 gap-2 text-muted-foreground">
          <AlertCircle size={20} className="opacity-40" />
          <p className="text-sm">
            {typeFilter !== "all" || statusFilter !== "all" || assigneeFilter !== "all"
              ? t("accounting.exceptions.noResults")
              : t("accounting.exceptions.empty")}
          </p>
        </div>
      ) : (
        <div className="rounded-xl border overflow-hidden">
          <Table>
            <TableHeader>
              <TableRow className="bg-muted/40">
                <TableHead className="w-8 px-3">
                  <Checkbox
                    checked={allPageSelected ? true : someSelected ? "indeterminate" : false}
                    onCheckedChange={toggleSelectAll}
                    aria-label={t("accounting.exceptions.selectAll")}
                  />
                </TableHead>
                <TableHead className="text-xs font-medium">{t("accounting.exceptions.table.type")}</TableHead>
                <TableHead className="text-xs font-medium">{t("accounting.exceptions.table.description")}</TableHead>
                <TableHead className="text-xs font-medium text-end">{t("accounting.exceptions.table.amount")}</TableHead>
                <TableHead className="text-xs font-medium">{t("accounting.exceptions.table.status")}</TableHead>
                <TableHead className="text-xs font-medium">{t("accounting.exceptions.table.assignee")}</TableHead>
                <TableHead className="text-xs font-medium text-end">{t("accounting.exceptions.table.actions")}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {exceptions.map((ex) => (
                <TableRow
                  key={ex.id}
                  className="cursor-pointer hover:bg-muted/30"
                  onClick={() => {
                    setDetailException(ex);
                    setDetailNotes(ex.notes ?? "");
                    setDetailResolution(ex.resolution ?? "");
                  }}
                >
                  <TableCell className="px-3" onClick={(e) => e.stopPropagation()}>
                    <Checkbox
                      checked={selected.has(ex.id)}
                      onCheckedChange={() => toggleSelect(ex.id)}
                    />
                  </TableCell>
                  <TableCell className="text-xs max-w-[160px]">
                    <span className="font-medium truncate block">
                      {t(`accounting.exceptions.type.${ex.exceptionType}`, { defaultValue: ex.exceptionType })}
                    </span>
                    {ex.sourceName && (
                      <span className="text-muted-foreground text-[10px]">{ex.sourceName}</span>
                    )}
                  </TableCell>
                  <TableCell className="text-xs max-w-[260px]">
                    <p className="truncate text-muted-foreground">{ex.description}</p>
                    {ex.relatedOrderId && (
                      <a
                        href={`/orders/${ex.relatedOrderId}`}
                        className="text-[10px] text-primary hover:underline"
                        onClick={(e) => e.stopPropagation()}
                        target="_blank"
                        rel="noreferrer"
                      >
                        <ExternalLink size={9} className="inline me-0.5" />
                        {ex.relatedOrderId.slice(0, 8)}…
                      </a>
                    )}
                  </TableCell>
                  <TableCell className="text-xs text-end font-mono">
                    {formatAmount(ex.amountCents, ex.currency)}
                  </TableCell>
                  <TableCell>
                    <ExceptionStatusBadge status={ex.status} />
                  </TableCell>
                  <TableCell className="text-xs text-muted-foreground">
                    {ex.assignedName ?? ex.assignedTo ?? "—"}
                  </TableCell>
                  <TableCell className="text-end" onClick={(e) => e.stopPropagation()}>
                    <div className="flex items-center justify-end gap-1">
                      {ex.status === "open" || ex.status === "assigned" ? (
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-6 text-[10px] px-2"
                          onClick={() => handleStatusChange(ex, "investigating")}
                        >
                          {t("accounting.exceptions.actions.markInvestigating")}
                        </Button>
                      ) : null}
                      {ex.status !== "resolved" && ex.status !== "accepted_difference" ? (
                        <>
                          <Button
                            variant="ghost"
                            size="sm"
                            className="h-6 text-[10px] px-2 text-green-700 hover:text-green-800"
                            onClick={() => handleStatusChange(ex, "resolved")}
                          >
                            {t("accounting.exceptions.actions.markResolved")}
                          </Button>
                          <Button
                            variant="ghost"
                            size="sm"
                            className="h-6 text-[10px] px-2 text-purple-700 hover:text-purple-800"
                            onClick={() => handleStatusChange(ex, "accepted_difference")}
                          >
                            {t("accounting.exceptions.actions.acceptDifference")}
                          </Button>
                        </>
                      ) : (
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-6 text-[10px] px-2"
                          onClick={() => handleStatusChange(ex, "open")}
                        >
                          {t("accounting.exceptions.actions.reopen")}
                        </Button>
                      )}
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}

      {/* Pagination */}
      {pagination && pagination.totalPages > 1 && (
        <div className="flex items-center justify-between text-xs text-muted-foreground">
          <span>
            {t("accounting.exceptions.pagination.showing", {
              from: (pagination.page - 1) * pagination.pageSize + 1,
              to: Math.min(pagination.page * pagination.pageSize, pagination.total),
              total: pagination.total,
            })}
          </span>
          <div className="flex items-center gap-1">
            <Button
              variant="outline"
              size="sm"
              className="h-7 text-xs"
              disabled={page <= 1}
              onClick={() => setPage((p) => Math.max(1, p - 1))}
            >
              ‹
            </Button>
            <span className="px-2">{page} / {pagination.totalPages}</span>
            <Button
              variant="outline"
              size="sm"
              className="h-7 text-xs"
              disabled={page >= pagination.totalPages}
              onClick={() => setPage((p) => Math.min(pagination.totalPages, p + 1))}
            >
              ›
            </Button>
          </div>
        </div>
      )}

      {/* Exception detail sheet */}
      <Sheet open={!!detailException} onOpenChange={(open) => { if (!open) setDetailException(null); }}>
        <SheetContent className="w-full sm:max-w-lg overflow-y-auto">
          {detailException && (
            <>
              <SheetHeader className="pb-4">
                <SheetTitle>{t("accounting.exceptions.detail.title")}</SheetTitle>
                <SheetDescription>
                  {t(`accounting.exceptions.type.${detailException.exceptionType}`, { defaultValue: detailException.exceptionType })}
                </SheetDescription>
              </SheetHeader>

              <div className="space-y-4">
                {/* Meta */}
                <div className="grid grid-cols-2 gap-3 text-sm">
                  <div>
                    <p className="text-xs text-muted-foreground mb-0.5">{t("accounting.exceptions.detail.description")}</p>
                    <p>{detailException.description}</p>
                  </div>
                  <div>
                    <p className="text-xs text-muted-foreground mb-0.5">{t("accounting.exceptions.table.status")}</p>
                    <ExceptionStatusBadge status={detailException.status} />
                  </div>
                  {detailException.amountCents != null && (
                    <div>
                      <p className="text-xs text-muted-foreground mb-0.5">{t("accounting.exceptions.detail.amount")}</p>
                      <p className="font-mono">{formatAmount(detailException.amountCents, detailException.currency)}</p>
                    </div>
                  )}
                  {detailException.sourceName && (
                    <div>
                      <p className="text-xs text-muted-foreground mb-0.5">{t("accounting.exceptions.detail.source")}</p>
                      <p>{detailException.sourceName}</p>
                    </div>
                  )}
                  {detailException.entityName && (
                    <div>
                      <p className="text-xs text-muted-foreground mb-0.5">{t("accounting.exceptions.detail.entity")}</p>
                      <p>{detailException.entityName}</p>
                    </div>
                  )}
                  {detailException.relatedOrderId && (
                    <div>
                      <p className="text-xs text-muted-foreground mb-0.5">{t("accounting.exceptions.detail.relatedOrder")}</p>
                      <a
                        href={`/orders/${detailException.relatedOrderId}`}
                        className="text-primary hover:underline text-sm"
                        target="_blank"
                        rel="noreferrer"
                      >
                        {detailException.relatedOrderId.slice(0, 8)}…
                      </a>
                    </div>
                  )}
                  {detailException.externalRef && (
                    <div>
                      <p className="text-xs text-muted-foreground mb-0.5">{t("accounting.exceptions.detail.externalRef")}</p>
                      <p className="font-mono text-xs">{detailException.externalRef}</p>
                    </div>
                  )}
                </div>

                {/* Assignee */}
                <div>
                  <Label className="text-xs text-muted-foreground mb-1.5 block">{t("accounting.exceptions.detail.assignee")}</Label>
                  <Select
                    value={detailException.assignedTo ?? "unassigned"}
                    onValueChange={(v) => {
                      const newAssignee = v === "unassigned" ? null : v;
                      patchMut.mutate(
                        { id: detailException.id, data: { assigned_to: newAssignee } },
                        {
                          onSuccess: (res) => {
                            setDetailException((prev) =>
                              prev ? { ...prev, ...res.exception } : prev,
                            );
                            void queryClient.invalidateQueries({ queryKey: getGetAccountingExceptionsQueryKey(monthId) });
                          },
                        },
                      );
                    }}
                  >
                    <SelectTrigger className="h-8 text-xs">
                      <SelectValue placeholder={t("accounting.exceptions.assignToPlaceholder")} />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="unassigned">{t("accounting.exceptions.filters.unassigned")}</SelectItem>
                      {members.map((m) => (
                        <SelectItem key={m.clerkUserId} value={m.clerkUserId}>
                          {m.fullName ?? m.email}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>

                {/* Notes */}
                <div>
                  <Label className="text-xs text-muted-foreground mb-1.5 block">{t("accounting.exceptions.detail.notes")}</Label>
                  <Textarea
                    value={detailNotes}
                    onChange={(e) => setDetailNotes(e.target.value)}
                    placeholder={t("accounting.exceptions.detail.notesPlaceholder")}
                    className="text-sm min-h-[80px] resize-none"
                  />
                </div>

                {/* Resolution */}
                <div>
                  <Label className="text-xs text-muted-foreground mb-1.5 block">{t("accounting.exceptions.detail.resolution")}</Label>
                  <Textarea
                    value={detailResolution}
                    onChange={(e) => setDetailResolution(e.target.value)}
                    placeholder={t("accounting.exceptions.detail.resolutionPlaceholder")}
                    className="text-sm min-h-[80px] resize-none"
                  />
                </div>

                <Button
                  onClick={handleDetailSave}
                  disabled={detailSaving}
                  size="sm"
                  className="w-full"
                >
                  {detailSaving ? t("accounting.exceptions.detail.saving") : t("accounting.exceptions.detail.save")}
                </Button>

                {/* Audit trail */}
                {detailException.auditTrail && detailException.auditTrail.length > 0 && (
                  <div>
                    <p className="text-xs font-medium mb-2">{t("accounting.exceptions.detail.auditTrail")}</p>
                    <div className="space-y-2">
                      {(detailException.auditTrail as Array<{ at: string; changed_by: string; from_status?: string; to_status?: string; action?: string }>).map((entry, i) => (
                        <div key={i} className="flex items-start gap-2 text-xs text-muted-foreground">
                          <Clock size={10} className="mt-0.5 shrink-0" />
                          <div>
                            <span>
                              {entry.action === "bulk_assign" ? "Bulk assigned" : (
                                entry.from_status !== entry.to_status
                                  ? `${entry.from_status} → ${entry.to_status}`
                                  : "Updated"
                              )}
                            </span>
                            <span className="block text-[10px]">{new Date(entry.at).toLocaleString()}</span>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            </>
          )}
        </SheetContent>
      </Sheet>

      {/* Accept difference modal */}
      <Dialog open={!!acceptDiffException} onOpenChange={(open) => { if (!open) setAcceptDiffException(null); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("accounting.exceptions.acceptDifferenceModal.title")}</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">{t("accounting.exceptions.acceptDifferenceModal.body")}</p>
          <div className="space-y-2">
            <Label className="text-xs">{t("accounting.exceptions.acceptDifferenceModal.reasonLabel")}</Label>
            <Textarea
              value={acceptDiffReason}
              onChange={(e) => setAcceptDiffReason(e.target.value)}
              placeholder={t("accounting.exceptions.acceptDifferenceModal.reasonPlaceholder")}
              className="text-sm min-h-[80px] resize-none"
            />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setAcceptDiffException(null)}>
              {t("accounting.exceptions.acceptDifferenceModal.cancel")}
            </Button>
            <Button onClick={handleAcceptDiff} disabled={!acceptDiffReason.trim() || patchMut.isPending}>
              {t("accounting.exceptions.acceptDifferenceModal.confirm")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Bulk assign dialog */}
      <Dialog open={bulkAssignOpen} onOpenChange={setBulkAssignOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("accounting.exceptions.assignTo")}</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">
            {t("accounting.exceptions.selected", { count: selected.size })}
          </p>
          <Select value={bulkAssignTarget} onValueChange={setBulkAssignTarget}>
            <SelectTrigger>
              <SelectValue placeholder={t("accounting.exceptions.assignToPlaceholder")} />
            </SelectTrigger>
            <SelectContent>
              {members.map((m) => (
                <SelectItem key={m.clerkUserId} value={m.clerkUserId}>
                  {m.fullName ?? m.email}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <DialogFooter>
            <Button variant="outline" onClick={() => setBulkAssignOpen(false)}>
              {t("accounting.exceptions.cancel")}
            </Button>
            <Button
              onClick={handleBulkAssign}
              disabled={!bulkAssignTarget || bulkAssignMut.isPending}
            >
              {bulkAssignMut.isPending
                ? t("accounting.exceptions.bulkAssigning")
                : t("accounting.exceptions.confirm")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

// ── Journal Entries Tab ───────────────────────────────────────────────────────

type EntityOption = { entityMonthId: number; entityName: string; entityId: number };

function JournalEntriesTab({ entities }: { entities: EntityOption[] }) {
  const { t } = useTranslation();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const { isOwner } = useWorkspaceRole();

  // Entity selector
  const [selectedEntityMonthId, setSelectedEntityMonthId] = useState<number | null>(
    entities.length === 1 ? entities[0].entityMonthId : null,
  );

  const entityMonthId = selectedEntityMonthId;

  // Active sub-panel: "journal" | "vat" | "config"
  const [panel, setPanel] = useState<"journal" | "vat" | "config">("journal");

  // Source config: selected source id
  const [configSourceId, setConfigSourceId] = useState<number | null>(null);
  const [configVatRate, setConfigVatRate] = useState<string>("0");
  const [configVatInclusive, setConfigVatInclusive] = useState(true);
  const [configAccounts, setConfigAccounts] = useState<Record<string, string>>({});

  // --- Journal Entry ---
  const { data: jeData, isLoading: jeLoading } = useGetJournalEntry(entityMonthId ?? 0, {
    query: { enabled: !!entityMonthId, queryKey: getGetJournalEntryQueryKey(entityMonthId ?? 0) },
  });

  const generateJe = useGenerateJournalEntry({
    mutation: {
      onSuccess: () => {
        if (entityMonthId) void queryClient.invalidateQueries({ queryKey: getGetJournalEntryQueryKey(entityMonthId) });
        toast({ title: t("accounting.journalEntries.generate") });
      },
      onError: (err: unknown) => {
        const msg = (err as { response?: { data?: { error?: string } } })?.response?.data?.error ?? "";
        toast({ title: msg || t("accounting.journalEntries.approveError"), variant: "destructive" });
      },
    },
  });

  const approveJe = useApproveJournalEntry({
    mutation: {
      onSuccess: () => {
        if (entityMonthId) void queryClient.invalidateQueries({ queryKey: getGetJournalEntryQueryKey(entityMonthId) });
        toast({ title: t("accounting.journalEntries.approveSuccess") });
      },
      onError: () => {
        toast({ title: t("accounting.journalEntries.approveError"), variant: "destructive" });
      },
    },
  });

  const entry = jeData?.journalEntry ?? null;
  const lines: JournalEntryLine[] = jeData?.lines ?? [];
  const totalDebit = lines.reduce((s, l) => s + (l.debitCents ?? 0), 0);
  const totalCredit = lines.reduce((s, l) => s + (l.creditCents ?? 0), 0);
  const imbalance = Math.abs(totalDebit - totalCredit);

  function handleExportJe(format: "xlsx" | "csv") {
    if (!entry) return;
    const url = `/api/accounting/journal-entries/${entry.id}/export?format=${format}`;
    const a = document.createElement("a");
    a.href = url;
    a.download = `journal-entry-${entry.id}.${format}`;
    a.click();
  }

  // --- VAT Summary ---
  const { data: vatData, isLoading: vatLoading } = useGetVatSummary(entityMonthId ?? 0, {
    query: { enabled: !!entityMonthId && panel === "vat", queryKey: getGetVatSummaryQueryKey(entityMonthId ?? 0) },
  });

  const generateVat = useGenerateVatSummary({
    mutation: {
      onSuccess: () => {
        if (entityMonthId) void queryClient.invalidateQueries({ queryKey: getGetVatSummaryQueryKey(entityMonthId) });
        toast({ title: t("accounting.journalEntries.vatSummary.generate") });
      },
      onError: () => {
        toast({ title: "VAT summary generation failed.", variant: "destructive" });
      },
    },
  });

  const vatRows: VatSummaryRow[] = vatData?.vatSummary ?? [];
  const vatTotals = vatData?.totals;

  // --- Source Config ---
  const sourcesForConfig = entities.length > 0
    ? (jeData?.lines ?? [])
        .filter((l) => l.sourceId != null)
        .reduce<{ id: number; name: string }[]>((acc, l) => {
          if (!acc.some((s) => s.id === l.sourceId)) acc.push({ id: l.sourceId!, name: l.sourceName ?? String(l.sourceId) });
          return acc;
        }, [])
    : [];

  const { data: sourceConfigData } = useGetAccountingSourceConfig(configSourceId ?? 0, {
    query: { enabled: !!configSourceId, queryKey: getGetAccountingSourceConfigQueryKey(configSourceId ?? 0) },
  });

  useEffect(() => {
    if (!sourceConfigData) return;
    setConfigVatRate(String(sourceConfigData.vatRate ?? 0));
    setConfigVatInclusive(Boolean(sourceConfigData.vatInclusive ?? true));
    setConfigAccounts((sourceConfigData.accounts ?? {}) as Record<string, string>);
  }, [sourceConfigData]);

  const patchConfig = usePatchAccountingSourceConfig({
    mutation: {
      onSuccess: () => {
        if (configSourceId) void queryClient.invalidateQueries({ queryKey: ["accounting-source-config", configSourceId] });
        toast({ title: t("accounting.journalEntries.sourceConfig.saveSuccess") });
      },
      onError: () => {
        toast({ title: t("accounting.journalEntries.sourceConfig.saveError"), variant: "destructive" });
      },
    },
  });

  const ACCOUNT_KEYS = [
    "sales_revenue", "output_vat", "refunds", "receivable", "cash", "fees", "fx_gains_losses", "over_short",
  ] as const;

  function fmt(cents: number, currency = "USD") {
    return new Intl.NumberFormat("en-US", { style: "currency", currency, maximumFractionDigits: 2 }).format(cents / 100);
  }

  if (!entityMonthId) {
    return (
      <div className="space-y-4">
        {entities.length > 1 && (
          <div>
            <Label className="mb-2 block text-sm">{t("accounting.overview.entityLabel")}</Label>
            <Select onValueChange={(v) => setSelectedEntityMonthId(Number(v))}>
              <SelectTrigger className="w-64">
                <SelectValue placeholder={t("accounting.overview.allEntities")} />
              </SelectTrigger>
              <SelectContent>
                {entities.map((e) => (
                  <SelectItem key={e.entityMonthId} value={String(e.entityMonthId)}>
                    {e.entityName}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        )}
        {entities.length === 0 && (
          <div className="flex items-center justify-center h-40 text-muted-foreground text-sm">
            {t("accounting.journalEntries.noEntry")}
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Entity selector (multi-entity workspaces) */}
      {entities.length > 1 && (
        <div className="flex items-center gap-3">
          <Label className="text-sm">{t("accounting.overview.entityLabel")}:</Label>
          <Select value={String(entityMonthId)} onValueChange={(v) => setSelectedEntityMonthId(Number(v))}>
            <SelectTrigger className="w-56">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {entities.map((e) => (
                <SelectItem key={e.entityMonthId} value={String(e.entityMonthId)}>
                  {e.entityName}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      )}

      {/* Sub-panel tabs */}
      <div className="flex gap-2 border-b pb-0">
        {(["journal", "vat", "config"] as const).map((p) => (
          <button
            key={p}
            onClick={() => setPanel(p)}
            className={cn(
              "px-4 py-2 text-sm font-medium border-b-2 -mb-px transition-colors",
              panel === p
                ? "border-teal-600 text-teal-700"
                : "border-transparent text-muted-foreground hover:text-foreground",
            )}
          >
            {p === "journal" && t("accounting.journalEntries.title")}
            {p === "vat" && t("accounting.journalEntries.vatSummary.title")}
            {p === "config" && t("accounting.journalEntries.sourceConfig.title")}
          </button>
        ))}
      </div>

      {/* ── Journal Entry panel ── */}
      {panel === "journal" && (
        <div className="space-y-4">
          {/* Header: generate + approve + export */}
          <div className="flex items-center justify-between gap-3 flex-wrap">
            <div className="flex items-center gap-2 flex-wrap">
              {entry && (
                <Badge
                  variant="outline"
                  className={cn(
                    "gap-1 text-xs",
                    entry.status === "approved"
                      ? "border-green-400 text-green-700"
                      : "text-muted-foreground",
                  )}
                >
                  {entry.status === "approved" ? <CheckCircle size={12} /> : <Clock size={12} />}
                  {entry.status === "approved"
                    ? t("accounting.journalEntries.approved")
                    : t("accounting.journalEntries.draft")}
                </Badge>
              )}
              {entry && (
                <Badge
                  variant="outline"
                  className={cn(
                    "gap-1 text-xs",
                    entry.isBalanced
                      ? "border-teal-400 text-teal-700"
                      : "border-orange-400 text-orange-700",
                  )}
                >
                  {entry.isBalanced ? <CheckCircle2 size={12} /> : <AlertTriangle size={12} />}
                  {entry.isBalanced
                    ? t("accounting.journalEntries.balanced")
                    : t("accounting.journalEntries.unbalanced")}
                </Badge>
              )}
            </div>
            <div className="flex items-center gap-2">
              <Button
                size="sm"
                variant="outline"
                className="gap-2"
                disabled={generateJe.isPending}
                onClick={() => generateJe.mutate({ id: entityMonthId })}
              >
                <RefreshCw size={14} className={generateJe.isPending ? "animate-spin" : ""} />
                {generateJe.isPending
                  ? t("accounting.journalEntries.generating")
                  : entry
                  ? t("accounting.journalEntries.regenerate")
                  : t("accounting.journalEntries.generate")}
              </Button>
              {entry && isOwner && entry.status !== "approved" && (
                <Button
                  size="sm"
                  variant="outline"
                  className="gap-2 border-teal-400 text-teal-700 hover:bg-teal-50"
                  disabled={approveJe.isPending || !entry.isBalanced}
                  onClick={() => approveJe.mutate({ id: entry.id })}
                >
                  <ThumbsUp size={14} />
                  {approveJe.isPending
                    ? t("accounting.journalEntries.approving")
                    : t("accounting.journalEntries.approve")}
                </Button>
              )}
              {entry && (
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button size="sm" variant="outline" className="gap-2">
                      <FileSpreadsheet size={14} />
                      {t("accounting.journalEntries.export")}
                      <ChevronDown size={12} />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    <DropdownMenuItem onClick={() => handleExportJe("xlsx")}>
                      {t("accounting.journalEntries.exportExcel")}
                    </DropdownMenuItem>
                    <DropdownMenuItem onClick={() => handleExportJe("csv")}>
                      {t("accounting.journalEntries.exportCsv")}
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              )}
            </div>
          </div>

          {/* Imbalance warning */}
          {entry && !entry.isBalanced && (
            <div className="flex items-start gap-2 rounded-md border border-orange-200 bg-orange-50 p-3 text-sm text-orange-800">
              <AlertTriangle size={16} className="shrink-0 mt-0.5" />
              {t("accounting.journalEntries.imbalanceWarning", { amount: fmt(imbalance) })}
            </div>
          )}

          {/* No entry yet */}
          {!jeLoading && !entry && (
            <div className="flex items-center justify-center h-40 text-muted-foreground text-sm">
              {t("accounting.journalEntries.noEntry")}
            </div>
          )}

          {/* Loading skeleton */}
          {jeLoading && (
            <div className="space-y-2">
              {[...Array(5)].map((_, i) => <Skeleton key={i} className="h-8 w-full" />)}
            </div>
          )}

          {/* Debit / Credit table */}
          {entry && lines.length > 0 && (
            <div className="border rounded-lg overflow-hidden">
              <Table>
                <TableHeader>
                  <TableRow className="bg-muted/40">
                    <TableHead className="text-xs">{t("accounting.journalEntries.table.accountCode")}</TableHead>
                    <TableHead className="text-xs">{t("accounting.journalEntries.table.accountName")}</TableHead>
                    <TableHead className="text-xs">{t("accounting.journalEntries.table.type")}</TableHead>
                    <TableHead className="text-xs">{t("accounting.journalEntries.table.source")}</TableHead>
                    <TableHead className="text-xs">{t("accounting.journalEntries.table.description")}</TableHead>
                    <TableHead className="text-xs text-right">{t("accounting.journalEntries.table.debit")}</TableHead>
                    <TableHead className="text-xs text-right">{t("accounting.journalEntries.table.credit")}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {lines.map((l) => (
                    <TableRow key={l.id}>
                      <TableCell className="font-mono text-xs text-muted-foreground">{l.accountCode}</TableCell>
                      <TableCell className="text-sm">{l.accountName}</TableCell>
                      <TableCell className="text-xs text-muted-foreground">
                        {l.lineType ? t(`accounting.journalEntries.lineTypes.${l.lineType}`, l.lineType) : ""}
                      </TableCell>
                      <TableCell className="text-xs text-muted-foreground">{l.sourceName ?? "—"}</TableCell>
                      <TableCell className="text-xs text-muted-foreground max-w-48 truncate">{l.description ?? ""}</TableCell>
                      <TableCell className="text-right font-mono text-sm">
                        {l.debitCents ? fmt(l.debitCents) : ""}
                      </TableCell>
                      <TableCell className="text-right font-mono text-sm">
                        {l.creditCents ? fmt(l.creditCents) : ""}
                      </TableCell>
                    </TableRow>
                  ))}
                  {/* Totals row */}
                  <TableRow className="bg-muted/40 font-semibold">
                    <TableCell colSpan={5} className="text-sm">
                      {t("accounting.journalEntries.totalsRow.label")}
                    </TableCell>
                    <TableCell className="text-right font-mono text-sm">{fmt(totalDebit)}</TableCell>
                    <TableCell className="text-right font-mono text-sm">{fmt(totalCredit)}</TableCell>
                  </TableRow>
                </TableBody>
              </Table>
            </div>
          )}

          {/* Approval metadata */}
          {entry?.status === "approved" && entry.approvedBy && (
            <div className="flex items-center gap-4 text-xs text-muted-foreground pt-1">
              <span className="flex items-center gap-1">
                <CheckCircle size={12} className="text-green-600" />
                {t("accounting.journalEntries.approval.approvedBy")}: {entry.approvedBy}
              </span>
              {entry.approvedAt && (
                <span>
                  {t("accounting.journalEntries.approval.approvedAt")}: {new Date(entry.approvedAt).toLocaleString()}
                </span>
              )}
            </div>
          )}
        </div>
      )}

      {/* ── VAT Summary panel ── */}
      {panel === "vat" && (
        <div className="space-y-4">
          <div className="flex items-center justify-between gap-3">
            <p className="text-sm text-muted-foreground">{t("accounting.journalEntries.vatSummary.noSummary")}</p>
            <Button
              size="sm"
              variant="outline"
              className="gap-2"
              disabled={generateVat.isPending}
              onClick={() => generateVat.mutate({ id: entityMonthId })}
            >
              <RefreshCw size={14} className={generateVat.isPending ? "animate-spin" : ""} />
              {generateVat.isPending
                ? t("accounting.journalEntries.vatSummary.generating")
                : vatRows.length > 0
                ? t("accounting.journalEntries.vatSummary.regenerate")
                : t("accounting.journalEntries.vatSummary.generate")}
            </Button>
          </div>

          {vatLoading && (
            <div className="space-y-2">
              {[...Array(3)].map((_, i) => <Skeleton key={i} className="h-8 w-full" />)}
            </div>
          )}

          {!vatLoading && vatRows.length === 0 && (
            <div className="flex items-center justify-center h-32 text-muted-foreground text-sm">
              {t("accounting.journalEntries.vatSummary.noSummary")}
            </div>
          )}

          {vatRows.length > 0 && (
            <div className="border rounded-lg overflow-hidden">
              <Table>
                <TableHeader>
                  <TableRow className="bg-muted/40">
                    <TableHead className="text-xs">{t("accounting.journalEntries.vatSummary.source")}</TableHead>
                    <TableHead className="text-xs">{t("accounting.journalEntries.vatSummary.currency")}</TableHead>
                    <TableHead className="text-xs">{t("accounting.journalEntries.vatSummary.vatRate")}</TableHead>
                    <TableHead className="text-xs text-right">{t("accounting.journalEntries.vatSummary.grossInclVat")}</TableHead>
                    <TableHead className="text-xs text-right">{t("accounting.journalEntries.vatSummary.grossExclVat")}</TableHead>
                    <TableHead className="text-xs text-right">{t("accounting.journalEntries.vatSummary.vatAmount")}</TableHead>
                    <TableHead className="text-xs text-right">{t("accounting.journalEntries.vatSummary.refundVat")}</TableHead>
                    <TableHead className="text-xs text-right">{t("accounting.journalEntries.vatSummary.netVat")}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {vatRows.map((r) => (
                    <TableRow key={r.id}>
                      <TableCell className="text-sm">{r.sourceName ?? "—"}</TableCell>
                      <TableCell className="text-xs font-mono">{r.currency}</TableCell>
                      <TableCell className="text-xs">{r.vatRate}%</TableCell>
                      <TableCell className="text-right font-mono text-sm">{fmt(r.grossInclVatCents, r.currency)}</TableCell>
                      <TableCell className="text-right font-mono text-sm">{fmt(r.grossExclVatCents, r.currency)}</TableCell>
                      <TableCell className="text-right font-mono text-sm">{fmt(r.vatAmountCents, r.currency)}</TableCell>
                      <TableCell className="text-right font-mono text-sm text-orange-700">
                        {r.refundVatCents > 0 ? `(${fmt(r.refundVatCents, r.currency)})` : "—"}
                      </TableCell>
                      <TableCell className="text-right font-mono text-sm font-semibold">
                        {fmt(r.vatAmountCents - r.refundVatCents, r.currency)}
                      </TableCell>
                    </TableRow>
                  ))}
                  {vatTotals && (
                    <TableRow className="bg-muted/40 font-semibold">
                      <TableCell colSpan={5} className="text-sm">{t("accounting.journalEntries.vatSummary.totals")}</TableCell>
                      <TableCell className="text-right font-mono text-sm">{fmt(vatTotals.totalVatCents + vatTotals.totalRefundVatCents)}</TableCell>
                      <TableCell className="text-right font-mono text-sm text-orange-700">
                        {vatTotals.totalRefundVatCents > 0 ? `(${fmt(vatTotals.totalRefundVatCents)})` : "—"}
                      </TableCell>
                      <TableCell className="text-right font-mono text-sm">{fmt(vatTotals.totalNetVatCents)}</TableCell>
                    </TableRow>
                  )}
                </TableBody>
              </Table>
            </div>
          )}
        </div>
      )}

      {/* ── Source Config panel ── */}
      {panel === "config" && (
        <div className="space-y-6">
          <p className="text-sm text-muted-foreground">{t("accounting.journalEntries.sourceConfig.subtitle")}</p>

          {sourcesForConfig.length === 0 ? (
            <div className="flex items-center justify-center h-32 text-muted-foreground text-sm">
              {t("accounting.journalEntries.sourceConfig.selectSource")}
            </div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-4 gap-6">
              {/* Source list sidebar */}
              <div className="md:col-span-1 space-y-1">
                {sourcesForConfig.map((s) => (
                  <button
                    key={s.id}
                    onClick={() => setConfigSourceId(s.id)}
                    className={cn(
                      "w-full text-left px-3 py-2 rounded-md text-sm transition-colors",
                      configSourceId === s.id
                        ? "bg-teal-50 text-teal-800 font-medium"
                        : "hover:bg-muted text-muted-foreground",
                    )}
                  >
                    {s.name}
                  </button>
                ))}
              </div>

              {/* Config form */}
              <div className="md:col-span-3">
                {!configSourceId ? (
                  <div className="flex items-center justify-center h-40 text-muted-foreground text-sm">
                    {t("accounting.journalEntries.sourceConfig.selectSource")}
                  </div>
                ) : (
                  <div className="space-y-6">
                    {/* VAT settings */}
                    <Card>
                      <CardHeader className="pb-3">
                        <CardTitle className="text-sm">{t("accounting.journalEntries.sourceConfig.vatRate")}</CardTitle>
                      </CardHeader>
                      <CardContent className="space-y-4">
                        <div className="flex items-center gap-4">
                          <div className="w-32">
                            <Label className="text-xs mb-1 block">{t("accounting.journalEntries.sourceConfig.vatRate")}</Label>
                            <Input
                              type="number"
                              min="0"
                              max="100"
                              step="0.01"
                              value={configVatRate}
                              onChange={(e) => setConfigVatRate(e.target.value)}
                              className="h-8 text-sm"
                            />
                          </div>
                          <div className="flex items-center gap-2 mt-4">
                            <Switch
                              checked={configVatInclusive}
                              onCheckedChange={setConfigVatInclusive}
                            />
                            <Label className="text-sm">{t("accounting.journalEntries.sourceConfig.vatInclusive")}</Label>
                          </div>
                        </div>
                        <p className="text-xs text-muted-foreground">{t("accounting.journalEntries.sourceConfig.vatInclusiveHint")}</p>
                      </CardContent>
                    </Card>

                    {/* Account codes */}
                    <Card>
                      <CardHeader className="pb-3">
                        <CardTitle className="text-sm">{t("accounting.journalEntries.sourceConfig.accounts")}</CardTitle>
                      </CardHeader>
                      <CardContent>
                        <div className="space-y-3">
                          {ACCOUNT_KEYS.map((key) => (
                            <div key={key} className="flex items-center gap-3">
                              <Label className="w-44 shrink-0 text-sm">
                                {t(`accounting.journalEntries.sourceConfig.accountLabels.${key}`, key)}
                              </Label>
                              <Input
                                placeholder={`e.g. 4000`}
                                value={configAccounts[key] ?? ""}
                                onChange={(e) =>
                                  setConfigAccounts((prev) => ({ ...prev, [key]: e.target.value }))
                                }
                                className="h-8 text-sm font-mono"
                              />
                            </div>
                          ))}
                        </div>
                      </CardContent>
                    </Card>

                    {/* Save button (owner only) */}
                    {isOwner && (
                      <Button
                        size="sm"
                        className="gap-2"
                        disabled={patchConfig.isPending}
                        onClick={() => {
                          patchConfig.mutate({
                            id: configSourceId,
                            data: {
                              vat_rate: parseFloat(configVatRate) || 0,
                              vat_inclusive: configVatInclusive,
                              accounts: configAccounts,
                            },
                          });
                        }}
                      >
                        <Settings2 size={14} />
                        {patchConfig.isPending
                          ? t("accounting.journalEntries.sourceConfig.saving")
                          : t("accounting.journalEntries.sourceConfig.save")}
                      </Button>
                    )}
                  </div>
                )}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ── Sales Sources Tab ─────────────────────────────────────────────────────────
// All syncable sources (retail_cash, card_terminal, stripe, paypal, cash) are
// shown in a unified table. Stripe/PayPal/Cash rows open type-specific detail
// drawers; retail_cash/card_terminal open the generic SourceDetailDrawer.

const ALL_SYNC_TYPES = new Set(["retail_cash", "card_terminal", "stripe", "paypal", "cash"]);

function SalesSourcesTab({ year, month }: { year: number; month: number }) {
  const { t } = useTranslation();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [syncingIds, setSyncingIds] = useState<Set<number>>(new Set());

  // Generic drawer for retail_cash / card_terminal
  const [drawerSource, setDrawerSource] = useState<AccountingSourceMonth | null>(null);

  // Type-specific drawers for stripe / paypal / cash (need fetched detail)
  const [stripeDetail, setStripeDetail] = useState<SourceMonthDetail | null>(null);
  const [stripeDrawerOpen, setStripeDrawerOpen] = useState(false);
  const [paypalDetail, setPaypalDetail] = useState<SourceMonthDetail | null>(null);
  const [paypalDrawerOpen, setPaypalDrawerOpen] = useState(false);
  const [cashDetail, setCashDetail] = useState<SourceMonthDetail | null>(null);
  const [cashDrawerOpen, setCashDrawerOpen] = useState(false);

  const { data, isLoading, isError } = useGetAccountingSourceMonths({ year, month });

  const syncMutation = useSyncAccountingSourceMonth({
    mutation: {
      onSuccess: () => {
        toast({
          title: t("accounting.sources.syncSuccess"),
          description: t("accounting.sources.syncSuccessDesc"),
        });
        queryClient.invalidateQueries({
          queryKey: getGetAccountingSourceMonthsQueryKey({ year, month }),
        });
      },
      onError: (err: any) => {
        toast({
          title: t("accounting.sources.syncError"),
          description: err?.response?.data?.error ?? err.message,
          variant: "destructive",
        });
      },
      onSettled: (_, __, variables) => {
        setSyncingIds((prev) => {
          const next = new Set(prev);
          next.delete(variables.id);
          return next;
        });
      },
    },
  });

  function handleSync(sm: AccountingSourceMonth) {
    setSyncingIds((prev) => new Set(prev).add(sm.id));
    syncMutation.mutate({ id: sm.id });
  }

  async function handleRowClick(sm: AccountingSourceMonth) {
    if (sm.source_type === "stripe" || sm.source_type === "paypal" || sm.source_type === "cash") {
      try {
        const detail = await apiFetch<SourceMonthDetail>(`/api/accounting/source-months/${sm.id}`);
        if (sm.source_type === "stripe") {
          setStripeDetail(detail);
          setStripeDrawerOpen(true);
        } else if (sm.source_type === "paypal") {
          setPaypalDetail(detail);
          setPaypalDrawerOpen(true);
        } else {
          setCashDetail(detail);
          setCashDrawerOpen(true);
        }
      } catch {
        toast({ title: t("accounting.sources.syncError"), variant: "destructive" });
      }
    } else {
      setDrawerSource(sm);
    }
  }

  const sources = data?.sources ?? [];

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-40 text-muted-foreground text-sm">
        {t("common.loading", "Loading…")}
      </div>
    );
  }

  if (isError) {
    return (
      <div className="flex items-center justify-center h-40 text-muted-foreground text-sm">
        {t("accounting.monthlySales.emptyState")}
      </div>
    );
  }

  if (sources.length === 0) {
    return (
      <div className="flex items-center justify-center h-40 text-muted-foreground text-sm">
        {t("accounting.sources.noSources")}
      </div>
    );
  }

  return (
    <>
      <div className="border rounded-lg overflow-hidden">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t("accounting.sources.sourceName")}</TableHead>
              <TableHead>{t("accounting.sources.syncTypeBadge")}</TableHead>
              <TableHead>{t("accounting.sources.status")}</TableHead>
              <TableHead className="text-right">{t("accounting.sources.sales")}</TableHead>
              <TableHead className="text-right">{t("accounting.sources.refunds")}</TableHead>
              <TableHead className="text-right">{t("accounting.sources.netActivity")}</TableHead>
              <TableHead>{t("accounting.sources.lastSyncedHeader")}</TableHead>
              <TableHead></TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {sources.map((sm) => {
              const isSyncable = ALL_SYNC_TYPES.has(sm.source_type);
              const isAutoSync = AUTO_SYNC_TYPES.includes(sm.source_type);
              const isSyncing = syncingIds.has(sm.id);
              const primaryCurrency = sm.source_type === "card_terminal" ? "USD" : "AED";

              return (
                <TableRow
                  key={sm.id}
                  className="cursor-pointer hover:bg-muted/40"
                  onClick={() => { void handleRowClick(sm); }}
                >
                  <TableCell className="font-medium">{sm.source_name}</TableCell>
                  <TableCell>
                    {isAutoSync ? (
                      <Badge variant="outline" className="border-teal-300 text-teal-700 text-xs">
                        {t("accounting.sources.syncType.automatic")}
                      </Badge>
                    ) : (
                      <Badge variant="outline" className="text-muted-foreground text-xs">
                        {t("accounting.sources.syncType.manual")}
                      </Badge>
                    )}
                  </TableCell>
                  <TableCell>
                    <Badge
                      variant="outline"
                      className={
                        sm.status === "synced"
                          ? "border-green-300 text-green-700 text-xs"
                          : "text-muted-foreground text-xs"
                      }
                    >
                      {t(`accounting.sources.statusLabel.${sm.status}`, sm.status)}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-right font-mono text-sm">
                    {sm.sales_amount_cents != null
                      ? formatCents(sm.sales_amount_cents, primaryCurrency)
                      : "—"}
                  </TableCell>
                  <TableCell className="text-right font-mono text-sm">
                    {sm.refunds_amount_cents != null
                      ? formatCents(sm.refunds_amount_cents, primaryCurrency)
                      : "—"}
                  </TableCell>
                  <TableCell className="text-right font-mono text-sm">
                    {sm.net_activity_cents != null
                      ? formatCents(sm.net_activity_cents, primaryCurrency)
                      : "—"}
                  </TableCell>
                  <TableCell className="text-sm text-muted-foreground whitespace-nowrap">
                    {sm.last_synced_at
                      ? formatDateShort(sm.last_synced_at)
                      : t("accounting.sources.neverSynced")}
                  </TableCell>
                  <TableCell onClick={(e) => e.stopPropagation()}>
                    <div className="flex items-center gap-1.5">
                      {(sm.source_type === "retail_cash" || sm.source_type === "cash") && (
                        <a
                          href={`/finance/accounting/cash-activity?month=${year}-${String(month).padStart(2, "0")}`}
                          className="inline-flex items-center gap-1 text-xs text-primary hover:underline whitespace-nowrap"
                        >
                          {t("cashActivity.viewCashActivity")}
                          <ExternalLink size={11} />
                        </a>
                      )}
                      {isSyncable && (
                        <Button
                          size="sm"
                          variant="outline"
                          className="gap-1.5 h-7 text-xs"
                          disabled={isSyncing}
                          onClick={() => handleSync(sm)}
                        >
                          <RefreshCw size={12} className={isSyncing ? "animate-spin" : ""} />
                          {isSyncing
                            ? t("accounting.sources.syncing")
                            : t("accounting.sources.sync")}
                        </Button>
                      )}
                    </div>
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </div>

      {/* Generic drawer for retail_cash / card_terminal */}
      <SourceDetailDrawer
        sourceMonth={drawerSource}
        open={drawerSource != null}
        onClose={() => setDrawerSource(null)}
      />

      {/* Type-specific drawers for stripe / paypal / cash */}
      <StripeDetailDrawer
        open={stripeDrawerOpen}
        onClose={() => setStripeDrawerOpen(false)}
        detail={stripeDetail}
      />
      <PayPalDetailDrawer
        open={paypalDrawerOpen}
        onClose={() => setPaypalDrawerOpen(false)}
        detail={paypalDetail}
      />
      <CashDetailDrawer
        open={cashDrawerOpen}
        onClose={() => setCashDrawerOpen(false)}
        detail={cashDetail}
      />
    </>
  );
}


type EntityMonthEntry = { entityMonthId: number; entityName: string };

function EntityDocumentsSection({ entityMonthId, entityName }: EntityMonthEntry) {
  const { t } = useTranslation();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const queryKey = getGetAccountingDocumentsQueryKey(entityMonthId);

  const { data, isLoading } = useGetAccountingDocuments(entityMonthId);
  const documents = data?.documents ?? [];

  const uploadMutation = useUploadAccountingDocument();
  const deleteMutation = useDeleteAccountingDocument();

  const fileInputRef = React.useRef<HTMLInputElement>(null);
  const [docType, setDocType] = React.useState("other");

  const DOC_TYPES = ["trial_balance", "bank_statement", "reconciliation", "journal_entry", "other"];

  function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    uploadMutation.mutate(
      { id: entityMonthId, data: { file, document_type: docType } },
      {
        onSuccess: () => {
          toast({ title: t("accounting.journalEntries.documents.uploadSuccess", { defaultValue: t("accounting.documents.uploadSuccess") }) });
          void queryClient.invalidateQueries({ queryKey });
        },
        onError: () => toast({ title: t("accounting.documents.uploadError"), variant: "destructive" }),
      },
    );
    e.target.value = "";
  }

  function handleDelete(doc: AccountingDocument) {
    if (!window.confirm(t("accounting.documents.deleteConfirm"))) return;
    deleteMutation.mutate(
      { id: doc.id },
      {
        onSuccess: () => {
          toast({ title: t("accounting.documents.deleteSuccess") });
          void queryClient.invalidateQueries({ queryKey });
        },
        onError: () => toast({ title: t("accounting.documents.deleteError"), variant: "destructive" }),
      },
    );
  }

  return (
    <div className="mb-6">
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-sm font-semibold">{entityName}</h3>
        <div className="flex items-center gap-2">
          <Select value={docType} onValueChange={setDocType}>
            <SelectTrigger className="w-[150px] h-8 text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {DOC_TYPES.map((dt) => (
                <SelectItem key={dt} value={dt} className="text-xs">
                  {t(`accounting.documents.documentType.${dt}`, { defaultValue: dt })}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <input ref={fileInputRef} type="file" className="hidden" onChange={handleFileChange} />
          <Button
            size="sm"
            variant="outline"
            className="gap-1 h-8 text-xs"
            disabled={uploadMutation.isPending}
            onClick={() => fileInputRef.current?.click()}
          >
            <Upload size={12} />
            {uploadMutation.isPending ? t("accounting.documents.uploading") : t("accounting.documents.upload")}
          </Button>
        </div>
      </div>
      {isLoading ? (
        <div className="space-y-2">
          {Array.from({ length: 2 }).map((_, i) => <Skeleton key={i} className="h-10 w-full" />)}
        </div>
      ) : documents.length === 0 ? (
        <p className="text-xs text-muted-foreground py-2">{t("accounting.documents.empty")}</p>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="text-xs">{t("accounting.documents.name")}</TableHead>
              <TableHead className="text-xs">{t("accounting.documents.type")}</TableHead>
              <TableHead className="text-xs">{t("accounting.documents.uploadedBy")}</TableHead>
              <TableHead className="text-xs">{t("accounting.documents.uploadedAt")}</TableHead>
              <TableHead className="text-xs"></TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {documents.map((doc) => (
              <TableRow key={doc.id}>
                <TableCell className="text-xs font-medium">{doc.name}</TableCell>
                <TableCell className="text-xs">
                  {t(`accounting.documents.documentType.${doc.documentType}`, { defaultValue: doc.documentType })}
                </TableCell>
                <TableCell className="text-xs">{doc.uploaderName ?? doc.uploadedBy ?? "—"}</TableCell>
                <TableCell className="text-xs">{new Date(doc.createdAt).toLocaleDateString()}</TableCell>
                <TableCell className="text-xs">
                  <div className="flex items-center gap-1">
                    <a
                      href={doc.viewUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-teal-700 hover:underline inline-flex items-center gap-1"
                    >
                      <Download size={12} />
                      {t("accounting.documents.download")}
                    </a>
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-6 px-1 text-red-600 hover:text-red-700"
                      disabled={deleteMutation.isPending}
                      onClick={() => handleDelete(doc)}
                    >
                      {t("accounting.documents.delete")}
                    </Button>
                  </div>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </div>
  );
}

function DocumentsTab({ entities }: { entities: EntityMonthEntry[] }) {
  const { t } = useTranslation();
  if (entities.length === 0) {
    return (
      <div className="flex items-center justify-center h-40 text-muted-foreground text-sm">
        {t("accounting.documents.empty")}
      </div>
    );
  }
  return (
    <div className="space-y-4">
      {entities.map((e) => (
        <EntityDocumentsSection key={e.entityMonthId} entityMonthId={e.entityMonthId} entityName={e.entityName} />
      ))}
    </div>
  );
}

function CloseHistoryTab({ entityMonthId }: { entityMonthId: number | null }) {
  const { t } = useTranslation();
  const { data, isLoading } = useGetAccountingEntityMonthAudit(
    entityMonthId ?? 0,
    { query: { enabled: entityMonthId != null, queryKey: getGetAccountingEntityMonthAuditQueryKey(entityMonthId ?? 0) } },
  );
  const events: AccountingAuditEvent[] = data?.events ?? [];

  if (entityMonthId == null) {
    return (
      <div className="flex items-center justify-center h-40 text-muted-foreground text-sm">
        {t("accounting.overview.noRecord")}
      </div>
    );
  }

  return (
    <div>
      <h3 className="text-sm font-semibold mb-4">{t("accounting.audit.title")}</h3>
      {isLoading ? (
        <div className="space-y-2">
          {Array.from({ length: 3 }).map((_, i) => <Skeleton key={i} className="h-10 w-full" />)}
        </div>
      ) : events.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t("accounting.audit.empty")}</p>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="text-xs">{t("accounting.audit.date")}</TableHead>
              <TableHead className="text-xs">{t("accounting.audit.description")}</TableHead>
              <TableHead className="text-xs">{t("accounting.audit.actor")}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {events.map((ev) => (
              <TableRow key={ev.id}>
                <TableCell className="text-xs whitespace-nowrap">
                  {new Date(ev.createdAt).toLocaleString()}
                </TableCell>
                <TableCell className="text-xs">
                  <span className="font-medium">
                    {t(`accounting.audit.eventType.${ev.eventType}`, { defaultValue: ev.eventType })}
                  </span>
                  {" — "}
                  {ev.description}
                </TableCell>
                <TableCell className="text-xs">{ev.actorName ?? ev.actorUserId ?? "—"}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </div>
  );
}

function CloseEntityDialog({
  entity,
  open,
  onClose,
  onSuccess,
}: {
  entity: EntityMonthEntry & { status: string };
  open: boolean;
  onClose: () => void;
  onSuccess: () => void;
}) {
  const { t } = useTranslation();
  const { toast } = useToast();
  const closeMutation = useCloseAccountingEntityMonth();

  function handleConfirm() {
    closeMutation.mutate(
      { id: entity.entityMonthId },
      {
        onSuccess: () => {
          toast({ title: t("accounting.monthlySales.closeSuccess") });
          onSuccess();
          onClose();
        },
        onError: (err: unknown) => {
          const e = err as { body?: { error?: string; blockers?: string[] } };
          const msg = e?.body?.blockers?.join(", ") ?? e?.body?.error ?? t("accounting.monthlySales.closeError");
          toast({ title: msg, variant: "destructive" });
        },
      },
    );
  }

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("accounting.close.title")}</DialogTitle>
        </DialogHeader>
        <div className="space-y-3 text-sm text-muted-foreground">
          <p>{t("accounting.close.description")}</p>
          <p className="font-medium text-foreground">{entity.entityName}</p>
          <p className="text-xs">{t("accounting.close.snapshot")}</p>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>{t("accounting.close.cancel")}</Button>
          <Button
            onClick={handleConfirm}
            disabled={closeMutation.isPending}
            className="bg-teal-700 hover:bg-teal-800 text-white"
          >
            {closeMutation.isPending ? t("accounting.monthlySales.closing") : t("accounting.close.confirm")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ReopenEntityDialog({
  entity,
  open,
  onClose,
  onSuccess,
}: {
  entity: EntityMonthEntry;
  open: boolean;
  onClose: () => void;
  onSuccess: () => void;
}) {
  const { t } = useTranslation();
  const { toast } = useToast();
  const [reason, setReason] = React.useState("");
  const reopenMutation = useReopenAccountingEntityMonth();

  function handleConfirm() {
    reopenMutation.mutate(
      { id: entity.entityMonthId, data: { reason } },
      {
        onSuccess: () => {
          toast({ title: t("accounting.monthlySales.reopenSuccess") });
          onSuccess();
          onClose();
          setReason("");
        },
        onError: (err: unknown) => {
          const e = err as { body?: { error?: string } };
          const msg = e?.body?.error ?? t("accounting.monthlySales.reopenError");
          toast({ title: msg, variant: "destructive" });
        },
      },
    );
  }

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v) { onClose(); setReason(""); } }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("accounting.close.reopenTitle")}</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <p className="text-sm text-muted-foreground">{t("accounting.close.reopenDescription")}</p>
          <p className="text-sm font-medium">{entity.entityName}</p>
          <div>
            <Label className="text-xs">{t("accounting.close.reopenReason")}</Label>
            <Textarea
              className="mt-1 text-sm"
              rows={3}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder={t("accounting.close.reopenReasonPlaceholder")}
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => { onClose(); setReason(""); }}>{t("accounting.close.cancel")}</Button>
          <Button
            onClick={handleConfirm}
            disabled={reopenMutation.isPending || reason.trim().length < 10}
          >
            {reopenMutation.isPending ? t("accounting.monthlySales.reopening") : t("accounting.close.reopenConfirm")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

type SupplierStatus =
  | "statement_needed"
  | "processing"
  | "needs_review"
  | "reconciled"
  | "ready_to_sync"
  | "syncing"
  | "synced"
  | "sync_failed";
export default function MonthlySalesPage() {
  const { t, i18n } = useTranslation();
  const [location, setLocation] = useLocation();
  const search = useSearch();
  const params = new URLSearchParams(search);
  const { isOwner } = useWorkspaceRole();
  const queryClient = useQueryClient();
  const [accountingMonthId, setAccountingMonthId] = useState<number | null>(null);
  const [creatingMonth, setCreatingMonth] = useState(false);
  const [importSource, setImportSource] = useState<AccountingSource | null>(null);
  const [importDrawerOpen, setImportDrawerOpen] = useState(false);
  const [closeDialogEntity, setCloseDialogEntity] = useState<(EntityMonthEntry & { status: string }) | null>(null);
  const [reopenDialogEntity, setReopenDialogEntity] = useState<EntityMonthEntry | null>(null);

  const selectedYear = params.get("year") || String(CURRENT_YEAR);
  const selectedMonth = params.get("month") || String(new Date().getMonth() + 1);
  const selectedEntity = params.get("entity") || "all";
  const selectedTab = params.get("tab") || "overview";

  const year = parseInt(selectedYear, 10);
  const month = parseInt(selectedMonth, 10);

  const { data: sourcesData, refetch: refetchSources } = useQuery<{ sources: AccountingSource[] }>({
    queryKey: ["accounting-sources", year, month],
    queryFn: () => apiFetch(`/api/accounting/sources?year=${year}&month=${month}`),
  });
  const sources = sourcesData?.sources ?? [];

  const { data: monthsData, isLoading } = useQuery<{ months: AccountingMonthRecord[] }>({
    queryKey: ["accounting-months", selectedYear],
    queryFn: () => apiFetch(`/api/accounting/months?year=${selectedYear}`),
    staleTime: 60_000,
  });

  const monthRecord = monthsData?.months.find(
    (m) => m.year === year && m.month === month,
  ) ?? null;
  const status = monthRecord?.status || "not_started";

  const updateParams = (updates: Record<string, string>) => {
    const newParams = new URLSearchParams(search);
    Object.entries(updates).forEach(([k, v]) => newParams.set(k, v));
    setLocation(`${location}?${newParams.toString()}`);
  };

  const ensureAccountingMonth = useCallback(async () => {
    const year = parseInt(selectedYear, 10);
    const month = parseInt(selectedMonth, 10);
    setCreatingMonth(true);
    try {
      let id: number | null = null;
      try {
        const data = await apiFetch<{ month: { id: number } }>("/api/accounting/months", {
          method: "POST",
          body: JSON.stringify({ year, month }),
        });
        id = data.month.id;
      } catch (err) {
        const e = err as { status?: number; id?: number; body?: { month?: { id?: number } } };
        if (e.status === 409) {
          id = (e.body?.month?.id as number | undefined) ?? null;
          if (!id) {
            const listData = await apiFetch<{ months: { id: number; year: number; month: number }[] }>(
              `/api/accounting/months?year=${year}`,
            );
            id = listData.months.find((m) => m.year === year && m.month === month)?.id ?? null;
          }
        }
      }
      if (id) {
        setAccountingMonthId(id);
        void queryClient.invalidateQueries({ queryKey: ["accounting-months", selectedYear] });
      }
    } finally {
      setCreatingMonth(false);
    }
  }, [selectedYear, selectedMonth, queryClient]);

  const handleTabChange = useCallback(
    (tab: string) => {
      if (tab === "sales-sources" && accountingMonthId === null) {
        void ensureAccountingMonth();
      }
    },
    [accountingMonthId, ensureAccountingMonth],
  );
  function handleImport(src: AccountingSource) {
    setImportSource(src);
    setImportDrawerOpen(true);
  }

  function handleImportComplete() {
    void refetchSources();
  }

  const { data: overviewData } = useQuery<{ overview: MonthOverview }>({
    queryKey: ["accounting-overview", monthRecord?.id],
    queryFn: () => apiFetch(`/api/accounting/months/${monthRecord!.id}/overview`),
    enabled: !!monthRecord,
    staleTime: 30_000,
  });

  const entityOptions = overviewData?.overview.entities ?? [];

  return (
    <div className="p-6 max-w-7xl mx-auto space-y-6">
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">
            {t("accounting.monthlySales.title")}
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            {t("accounting.monthlySales.subtitle")}
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <Select
            value={selectedYear}
            onValueChange={(v) => updateParams({ year: v, month: selectedMonth })}
          >
            <SelectTrigger className="w-[100px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {YEARS.map((y) => (
                <SelectItem key={y} value={String(y)}>
                  {y}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>

          <Select
            value={selectedMonth}
            onValueChange={(v) => updateParams({ year: selectedYear, month: v })}
          >
            <SelectTrigger className="w-[140px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {MONTHS.map((m) => (
                <SelectItem key={m} value={String(m)}>
                  {monthLabel(m, i18n.language)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>

          <Select
            value={selectedEntity}
            onValueChange={(v) => updateParams({ entity: v })}
          >
            <SelectTrigger className="w-[160px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">{t("accounting.monthlySales.allEntities")}</SelectItem>
              {entityOptions.map((e) => (
                <SelectItem key={e.entityId} value={String(e.entityId)}>
                  {e.entityName}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>

          <Badge
            variant="outline"
            className="capitalize text-muted-foreground border-muted-foreground/30"
          >
            {t(`accounting.monthlySales.status.${status}`, { defaultValue: status })}
          </Badge>

          <Button variant="outline" size="sm" className="gap-2">
            <Download size={14} />
            {t("accounting.monthlySales.export")}
          </Button>

          {(() => {
            const entityList = (overviewData?.overview.entities ?? [])
              .filter((e): e is typeof e & { entityMonthId: number } => e.entityMonthId != null);
            const closedEntities = entityList.filter((e) => e.status === "closed");
            const openEntities = entityList.filter((e) => e.status !== "closed");
            if (closedEntities.length > 0 && isOwner) {
              return (
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button size="sm" variant="outline" className="gap-2">
                      <Lock size={14} />
                      {t("accounting.monthlySales.closeMonth")}
                      <ChevronDown size={12} />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    {openEntities.map((e) => (
                      <DropdownMenuItem key={e.entityMonthId} onClick={() => setCloseDialogEntity({ entityMonthId: e.entityMonthId, entityName: e.entityName, status: e.status })}>
                        <Lock size={12} className="mr-2" />
                        {t("accounting.monthlySales.closeMonth")}: {e.entityName}
                      </DropdownMenuItem>
                    ))}
                    {closedEntities.map((e) => (
                      <DropdownMenuItem key={e.entityMonthId} onClick={() => setReopenDialogEntity({ entityMonthId: e.entityMonthId, entityName: e.entityName })}>
                        <RefreshCw size={12} className="mr-2" />
                        {t("accounting.monthlySales.reopenMonth")}: {e.entityName}
                      </DropdownMenuItem>
                    ))}
                  </DropdownMenuContent>
                </DropdownMenu>
              );
            }
            if (openEntities.length > 0) {
              return openEntities.length === 1 ? (
                <Button size="sm" className="gap-2 bg-teal-700 hover:bg-teal-800" onClick={() => setCloseDialogEntity({ entityMonthId: openEntities[0].entityMonthId, entityName: openEntities[0].entityName, status: openEntities[0].status })}>
                  <Lock size={14} />
                  {t("accounting.monthlySales.closeMonth")}
                </Button>
              ) : (
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button size="sm" className="gap-2 bg-teal-700 hover:bg-teal-800">
                      <Lock size={14} />
                      {t("accounting.monthlySales.closeMonth")}
                      <ChevronDown size={12} />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    {openEntities.map((e) => (
                      <DropdownMenuItem key={e.entityMonthId} onClick={() => setCloseDialogEntity({ entityMonthId: e.entityMonthId, entityName: e.entityName, status: e.status })}>
                        {e.entityName}
                      </DropdownMenuItem>
                    ))}
                  </DropdownMenuContent>
                </DropdownMenu>
              );
            }
            return null;
          })()}
        </div>
      </div>

      <Tabs
        value={selectedTab}
        onValueChange={(v) => { updateParams({ tab: v }); handleTabChange(v); }}
      >
        <TabsList className="w-full justify-start overflow-x-auto">
          <TabsTrigger value="overview">
            {t("accounting.monthlySales.tabs.overview")}
          </TabsTrigger>
          <TabsTrigger value="sales-sources">
            {t("accounting.monthlySales.tabs.salesSources")}
          </TabsTrigger>
          <TabsTrigger value="bank-accounts">
            {t("accounting.monthlySales.tabs.bankAccounts")}
          </TabsTrigger>
          <TabsTrigger value="supplier-bills">
            {t("accounting.monthlySales.tabs.supplierBills")}
          </TabsTrigger>
          <TabsTrigger value="exceptions">
            {t("accounting.monthlySales.tabs.exceptions")}
          </TabsTrigger>
          <TabsTrigger value="journal-entries">
            {t("accounting.monthlySales.tabs.journalEntries")}
          </TabsTrigger>
          <TabsTrigger value="documents">
            {t("accounting.monthlySales.tabs.documents")}
          </TabsTrigger>
          <TabsTrigger value="close-history">
            {t("accounting.monthlySales.tabs.closeHistory")}
          </TabsTrigger>
        </TabsList>

        <TabsContent value="overview" className="mt-6">
          {isLoading ? (
            <div className="space-y-6">
              <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
                {Array.from({ length: 4 }).map((_, i) => (
                  <Skeleton key={i} className="h-24 rounded-xl" />
                ))}
              </div>
              <Skeleton className="h-48 rounded-xl" />
              <Skeleton className="h-48 rounded-xl" />
            </div>
          ) : monthRecord ? (
            <OverviewTab monthId={monthRecord.id} entityFilter={selectedEntity} year={year} month={month} />
          ) : (
            <div className="flex flex-col items-center justify-center h-48 gap-3 text-muted-foreground">
              <p className="text-sm">{t("accounting.overview.noRecord")}</p>
              <Button
                size="sm"
                className="gap-2 bg-teal-700 hover:bg-teal-800 text-white"
                onClick={() => void ensureAccountingMonth()}
                disabled={creatingMonth}
              >
                {creatingMonth ? (
                  <RefreshCw size={14} className="animate-spin" />
                ) : (
                  <Lock size={14} />
                )}
                {t("accounting.monthlySales.startClose")}
              </Button>
            </div>
          )}
        </TabsContent>

        <TabsContent value="sales-sources" className="mt-6">
          <SalesSourcesTab
            year={parseInt(selectedYear, 10)}
            month={parseInt(selectedMonth, 10)}
          />
        </TabsContent>

        <TabsContent value="bank-accounts" className="mt-6">
          <div className="flex items-center justify-center h-48 text-muted-foreground text-sm">
            {t("accounting.monthlySales.supplierBills.bankAccountsPlaceholder")}
          </div>
        </TabsContent>

        <TabsContent value="supplier-bills" className="mt-6">
          <SupplierBillsTab
            entities={
              (overviewData?.overview.entities ?? [])
                .filter((e): e is typeof e & { entityMonthId: number } => e.entityMonthId != null)
                .map((e) => ({ entityMonthId: e.entityMonthId, entityName: e.entityName, entityId: e.entityId }))
            }
            year={parseInt(selectedYear, 10)}
            month={parseInt(selectedMonth, 10)}
          />
        </TabsContent>

        <TabsContent value="exceptions" className="mt-6">
          {monthRecord ? (
            <ExceptionsTab
              monthId={monthRecord.id}
              sourceMonthIds={
                (overviewData?.overview.entities ?? [])
                  .flatMap((e) => e.sources)
                  .map((s) => s.sourceMonthId)
                  .filter((id): id is number => id != null)
              }
            />
          ) : (
            <div className="flex flex-col items-center justify-center h-48 gap-3 text-muted-foreground">
              <p className="text-sm">{t("accounting.overview.noRecord")}</p>
            </div>
          )}
        </TabsContent>

        <TabsContent value="journal-entries" className="mt-6">
          <JournalEntriesTab
            entities={
              (overviewData?.overview.entities ?? [])
                .filter((e): e is typeof e & { entityMonthId: number } => e.entityMonthId != null)
                .map((e) => ({ entityMonthId: e.entityMonthId, entityName: e.entityName, entityId: e.entityId }))
            }
          />
        </TabsContent>

        <TabsContent value="documents" className="mt-6">
          <DocumentsTab
            entities={
              (overviewData?.overview.entities ?? [])
                .filter((e): e is typeof e & { entityMonthId: number } => e.entityMonthId != null)
                .map((e) => ({ entityMonthId: e.entityMonthId, entityName: e.entityName }))
            }
          />
        </TabsContent>

        <TabsContent value="close-history" className="mt-6">
          <CloseHistoryTab
            entityMonthId={
              (overviewData?.overview.entities ?? [])
                .find((e) => e.entityMonthId != null)?.entityMonthId ?? null
            }
          />
        </TabsContent>
      </Tabs>

      {closeDialogEntity && (
        <CloseEntityDialog
          entity={closeDialogEntity}
          open={!!closeDialogEntity}
          onClose={() => setCloseDialogEntity(null)}
          onSuccess={() => {
            void queryClient.invalidateQueries({ queryKey: ["accounting-overview", monthRecord?.id] });
            void queryClient.invalidateQueries({ queryKey: ["accounting-month", selectedYear, selectedMonth] });
          }}
        />
      )}

      {reopenDialogEntity && (
        <ReopenEntityDialog
          entity={reopenDialogEntity}
          open={!!reopenDialogEntity}
          onClose={() => setReopenDialogEntity(null)}
          onSuccess={() => {
            void queryClient.invalidateQueries({ queryKey: ["accounting-overview", monthRecord?.id] });
            void queryClient.invalidateQueries({ queryKey: ["accounting-month", selectedYear, selectedMonth] });
          }}
        />
      )}

      <ImportStatementDrawer
        open={importDrawerOpen}
        onOpenChange={setImportDrawerOpen}
        source={importSource}
        sourceMonthId={importSource?.source_month_id ?? null}
        year={year}
        month={month}
        onImportComplete={handleImportComplete}
      />
    </div>
  );
}

type SupplierReconciliationRow = {
  supplierId: number;
  supplierName: string;
  sessionId: number | null;
  sessionStatus: SupplierStatus;
  statementBalance: number | null;
  osBalance: number | null;
  balanceDifference: number | null;
  openExceptionsCount: number;
  latestStatementId: string | null;
};

type ApiOverviewSummary = {
  suppliers_total: number;
  suppliers_with_statements: number;
  suppliers_reconciled: number;
  total_open_exceptions: number;
  total_balance_difference: number;
};

type SupplierReconciliationOverview = {
  suppliers: SupplierReconciliationRow[];
  summary: ApiOverviewSummary;
};

type UploadProgress = "idle" | "uploading" | "extracting" | "matching" | "done" | "error";

function SupplierStatusBadge({ status }: { status: SupplierStatus }) {
  const { t } = useTranslation();
  const label = t(`accounting.monthlySales.supplierBills.status.${status}`, { defaultValue: status });
  const variants: Record<SupplierStatus, string> = {
    statement_needed: "bg-amber-100 text-amber-800 border-amber-200",
    processing: "bg-blue-100 text-blue-800 border-blue-200",
    needs_review: "bg-amber-100 text-amber-800 border-amber-200",
    reconciled: "bg-green-100 text-green-800 border-green-200",
    ready_to_sync: "bg-teal-100 text-teal-800 border-teal-200",
    syncing: "bg-blue-100 text-blue-800 border-blue-200",
    synced: "bg-green-100 text-green-800 border-green-200",
    sync_failed: "bg-red-100 text-red-800 border-red-200",
  };
  const icons: Record<SupplierStatus, React.ReactNode> = {
    statement_needed: <AlertTriangle size={10} />,
    processing: <RefreshCw size={10} className="animate-spin" />,
    needs_review: <AlertCircle size={10} />,
    reconciled: <CheckCircle2 size={10} />,
    ready_to_sync: <CheckCircle size={10} />,
    syncing: <RefreshCw size={10} className="animate-spin" />,
    synced: <CheckCircle2 size={10} />,
    sync_failed: <XCircle size={10} />,
  };
  const cls = variants[status] ?? "bg-gray-100 text-gray-700 border-gray-200";
  return (
    <span className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-medium ${cls}`}>
      {icons[status]}
      {label}
    </span>
  );
}

function StatementUploadModal({
  open,
  supplierName,
  entityMonthId,
  supplierId,
  year,
  month,
  onClose,
  onSuccess,
}: {
  open: boolean;
  supplierName: string;
  entityMonthId: number;
  supplierId: number;
  year: number;
  month: number;
  onClose: () => void;
  onSuccess: () => void;
}) {
  const { t, i18n } = useTranslation();
  const [file, setFile] = useState<File | null>(null);
  const [progress, setProgress] = useState<UploadProgress>("idle");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const { toast } = useToast();

  function reset() {
    setFile(null);
    setProgress("idle");
    setErrorMessage(null);
  }

  async function handleUpload() {
    if (!file) return;
    setProgress("uploading");
    setErrorMessage(null);
    try {
      const formData = new FormData();
      formData.append("file", file);
      await apiFetch(
        `/api/accounting/entity-months/${entityMonthId}/supplier-reconciliation/${supplierId}/statement`,
        { method: "POST", body: formData },
      );
      setProgress("extracting");
      await new Promise((r) => setTimeout(r, 800));
      setProgress("matching");
      await apiFetch(
        `/api/accounting/entity-months/${entityMonthId}/supplier-reconciliation/${supplierId}/extract`,
        { method: "POST" },
      ).catch(() => null); // best-effort extract trigger
      setProgress("done");
      onSuccess();
    } catch (err) {
      setProgress("error");
      setErrorMessage(err instanceof Error ? err.message : "Upload failed");
      toast({ title: t("accounting.monthlySales.supplierBills.uploadModal.error"), variant: "destructive" });
    }
  }

  const progressLabels: Record<UploadProgress, string> = {
    idle: "",
    uploading: t("accounting.monthlySales.supplierBills.uploadModal.uploading"),
    extracting: t("accounting.monthlySales.supplierBills.uploadModal.extracting"),
    matching: t("accounting.monthlySales.supplierBills.uploadModal.matching"),
    done: t("accounting.monthlySales.supplierBills.uploadModal.done"),
    error: errorMessage ?? t("accounting.monthlySales.supplierBills.uploadModal.error"),
  };

  const periodLabel = `${new Date(year, month - 1, 1).toLocaleString(i18n.language, { month: "long" })} ${year}`;

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) { reset(); onClose(); } }}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{t("accounting.monthlySales.supplierBills.uploadModal.title")}</DialogTitle>
        </DialogHeader>
        <div className="space-y-4 py-2">
          <div className="grid grid-cols-2 gap-4 text-sm">
            <div>
              <p className="text-xs text-muted-foreground mb-0.5">
                {t("accounting.monthlySales.supplierBills.uploadModal.supplierLabel")}
              </p>
              <p className="font-medium">{supplierName}</p>
            </div>
            <div>
              <p className="text-xs text-muted-foreground mb-0.5">
                {t("accounting.monthlySales.supplierBills.uploadModal.periodLabel")}
              </p>
              <p className="font-medium">{periodLabel}</p>
            </div>
          </div>
          <div>
            <Label htmlFor="supplier-statement-file" className="text-xs text-muted-foreground mb-1 block">
              {t("accounting.monthlySales.supplierBills.uploadModal.fileLabel")}
            </Label>
            <input
              id="supplier-statement-file"
              type="file"
              accept=".pdf,.xls,.xlsx,.csv"
              className="block w-full text-sm file:mr-3 file:py-1.5 file:px-3 file:rounded file:border-0 file:text-xs file:font-medium file:bg-primary file:text-primary-foreground hover:file:bg-primary/90 text-muted-foreground"
              onChange={(e) => setFile(e.target.files?.[0] ?? null)}
              disabled={progress !== "idle"}
            />
            <p className="text-xs text-muted-foreground mt-1">
              {t("accounting.monthlySales.supplierBills.uploadModal.fileHint")}
            </p>
          </div>
          {progress !== "idle" && (
            <div className={`rounded-md px-3 py-2 text-sm font-medium ${
              progress === "done"
                ? "bg-green-50 text-green-800"
                : progress === "error"
                  ? "bg-red-50 text-red-800"
                  : "bg-blue-50 text-blue-800"
            }`}>
              <div className="flex items-center gap-2">
                {progress !== "done" && progress !== "error" && (
                  <RefreshCw size={13} className="animate-spin shrink-0" />
                )}
                {progress === "done" && <CheckCircle2 size={13} className="shrink-0 text-green-700" />}
                {progress === "error" && <XCircle size={13} className="shrink-0 text-red-700" />}
                {progressLabels[progress]}
              </div>
            </div>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => { reset(); onClose(); }} disabled={progress !== "idle" && progress !== "done" && progress !== "error"}>
            {t("accounting.monthlySales.supplierBills.uploadModal.cancel")}
          </Button>
          {progress === "done" ? (
            <Button onClick={() => { reset(); onClose(); }}>
              {t("accounting.monthlySales.supplierBills.uploadModal.done")}
            </Button>
          ) : (
            <Button
              onClick={() => void handleUpload()}
              disabled={!file || (progress !== "idle" && progress !== "error")}
              className="gap-2"
            >
              {progress !== "idle" && progress !== "error" && <RefreshCw size={13} className="animate-spin" />}
              <Upload size={13} />
              {t("accounting.monthlySales.supplierBills.uploadModal.confirm")}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function SupplierCloseChecklist({
  overview,
  entityMonthId,
}: {
  overview: SupplierReconciliationOverview | null;
  entityMonthId: number;
}) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const manualCheckKey = ["supplier-close-checklist-manual", entityMonthId];

  const [manualChecks, setManualChecks] = useState<Record<number, boolean>>({});

  // Derive auto-checkable states from data
  const allStatementsUploaded = overview
    ? overview.summary.suppliers_with_statements >= overview.summary.suppliers_total &&
      overview.summary.suppliers_total > 0
    : false;

  const allReconciled = overview
    ? overview.suppliers.length > 0 &&
      overview.suppliers.every((s) =>
        ["reconciled", "ready_to_sync", "syncing", "synced"].includes(s.sessionStatus),
      )
    : false;

  const noMissingBillExceptions = overview ? overview.summary.total_open_exceptions === 0 : false;
  const noDuplicateExceptions = noMissingBillExceptions; // same source for now
  const allApApproved = overview
    ? overview.suppliers.length > 0 &&
      overview.suppliers.every((s) =>
        ["ready_to_sync", "syncing", "synced"].includes(s.sessionStatus),
      )
    : false;

  const items = [
    {
      id: 0,
      label: t("accounting.monthlySales.supplierBills.checklist.statementsUploaded"),
      checked: allStatementsUploaded,
      auto: true,
    },
    {
      id: 1,
      label: t("accounting.monthlySales.supplierBills.checklist.balancesReconciled"),
      checked: allReconciled,
      auto: true,
    },
    {
      id: 2,
      label: t("accounting.monthlySales.supplierBills.checklist.missingBillsRecorded"),
      checked: noMissingBillExceptions || (manualChecks[2] ?? false),
      auto: noMissingBillExceptions,
    },
    {
      id: 3,
      label: t("accounting.monthlySales.supplierBills.checklist.duplicatesResolved"),
      checked: noDuplicateExceptions || (manualChecks[3] ?? false),
      auto: noDuplicateExceptions,
    },
    {
      id: 4,
      label: t("accounting.monthlySales.supplierBills.checklist.apBalanceApproved"),
      checked: allApApproved || (manualChecks[4] ?? false),
      auto: allApApproved,
    },
  ];

  const completedCount = items.filter((i) => i.checked).length;

  return (
    <Card className="sticky top-4">
      <CardHeader className="pb-3">
        <CardTitle className="text-sm">
          {t("accounting.monthlySales.supplierBills.checklist.title")}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-1 pb-4">
        <Progress
          value={(completedCount / items.length) * 100}
          className="h-1.5 mb-3"
        />
        <p className="text-xs text-muted-foreground mb-3">
          {completedCount} / {items.length}
        </p>
        <div className="space-y-2.5">
          {items.map((item) => (
            <div key={item.id} className="flex items-start gap-2">
              <Checkbox
                checked={item.checked}
                disabled={item.auto}
                onCheckedChange={(checked) => {
                  if (!item.auto) {
                    setManualChecks((prev) => ({ ...prev, [item.id]: !!checked }));
                  }
                }}
                className="mt-0.5 shrink-0"
              />
              <span
                className={`text-xs leading-relaxed ${
                  item.checked ? "text-muted-foreground line-through" : ""
                }`}
              >
                {item.label}
              </span>
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}

function SupplierBillsTab({
  entities,
  year,
  month,
}: {
  entities: Array<{ entityMonthId: number; entityName: string; entityId: number }>;
  year: number;
  month: number;
}) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [, setLocation] = useLocation();
  const [selectedEntityMonthId, setSelectedEntityMonthId] = useState<number | null>(
    entities[0]?.entityMonthId ?? null,
  );
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [uploadModal, setUploadModal] = useState<{ supplierId: number; supplierName: string } | null>(null);

  // Keep selected entity in sync if entities list changes
  React.useEffect(() => {
    if (selectedEntityMonthId === null && entities.length > 0) {
      setSelectedEntityMonthId(entities[0].entityMonthId);
    }
  }, [entities, selectedEntityMonthId]);

  const overviewQueryKey = ["supplier-reconciliation-overview", selectedEntityMonthId];

  const { data, isLoading, isError } = useQuery<SupplierReconciliationOverview>({
    queryKey: overviewQueryKey,
    queryFn: () => apiFetch(`/api/accounting/entity-months/${selectedEntityMonthId}/supplier-reconciliation`),
    enabled: selectedEntityMonthId !== null,
    staleTime: 30_000,
  });

  const missingStatementsCount = data
    ? Math.max(0, data.summary.suppliers_total - data.summary.suppliers_with_statements)
    : 0;

  const filteredSuppliers = (data?.suppliers ?? []).filter((s) => {
    const matchesSearch = search.trim() === "" || s.supplierName.toLowerCase().includes(search.toLowerCase());
    const matchesStatus = statusFilter === "all" || s.sessionStatus === statusFilter;
    return matchesSearch && matchesStatus;
  });

  // Currency is not returned by the overview API; the workspace page reads it from the session.
  const currency = "USD";

  if (entities.length === 0) {
    return (
      <div className="flex items-center justify-center h-48 text-muted-foreground text-sm">
        {t("accounting.monthlySales.supplierBills.noEntities")}
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Entity picker — only shown when more than one entity */}
      {entities.length > 1 && (
        <div className="flex items-center gap-3">
          <Select
            value={String(selectedEntityMonthId ?? "")}
            onValueChange={(v) => setSelectedEntityMonthId(Number(v))}
          >
            <SelectTrigger className="w-[220px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {entities.map((e) => (
                <SelectItem key={e.entityMonthId} value={String(e.entityMonthId)}>
                  {e.entityName}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      )}

      {/* Missing-statement amber banner */}
      {!isLoading && data && missingStatementsCount > 0 && (
        <div className="flex items-start gap-3 rounded-lg border border-amber-300 bg-amber-50 px-4 py-3">
          <AlertTriangle size={16} className="shrink-0 mt-0.5 text-amber-600" />
          <p className="text-sm text-amber-800">
            {t("accounting.monthlySales.supplierBills.missingStatementBanner", { count: missingStatementsCount })}
          </p>
        </div>
      )}

      {/* Summary cards */}
      {isLoading ? (
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-24 rounded-xl" />
          ))}
        </div>
      ) : isError ? (
        <div className="flex items-center justify-center h-24 text-muted-foreground text-sm">
          {t("accounting.monthlySales.supplierBills.loadError")}
        </div>
      ) : data ? (
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
          <KpiCard
            title={t("accounting.monthlySales.supplierBills.suppliersReviewed")}
            value={`${data.summary.suppliers_reconciled} / ${data.summary.suppliers_total}`}
            icon={CheckCircle}
            iconClass={
              data.summary.suppliers_reconciled === data.summary.suppliers_total && data.summary.suppliers_total > 0
                ? "bg-green-100 text-green-600"
                : "bg-muted"
            }
          />
          <KpiCard
            title={t("accounting.monthlySales.supplierBills.statementsUploaded")}
            value={`${data.summary.suppliers_with_statements} / ${data.summary.suppliers_total}`}
            icon={FileSpreadsheet}
            iconClass={
              data.summary.suppliers_with_statements >= data.summary.suppliers_total && data.summary.suppliers_total > 0
                ? "bg-green-100 text-green-600"
                : "bg-amber-100 text-amber-600"
            }
          />
          <KpiCard
            title={t("accounting.monthlySales.supplierBills.openExceptions")}
            value={String(data.summary.total_open_exceptions)}
            icon={data.summary.total_open_exceptions > 0 ? AlertTriangle : CheckCircle}
            iconClass={
              data.summary.total_open_exceptions > 0
                ? "bg-red-100 text-red-600"
                : "bg-green-100 text-green-600"
            }
          />
          <KpiCard
            title={t("accounting.monthlySales.supplierBills.totalBalanceDiff")}
            value={formatDollars(data.summary.total_balance_difference, currency)}
            iconClass={
              data.summary.total_balance_difference === 0
                ? "bg-green-100 text-green-600"
                : "bg-amber-100 text-amber-600"
            }
          />
        </div>
      ) : null}

      {/* Main content: table + checklist sidebar */}
      <div className="flex flex-col lg:flex-row gap-6">
        <div className="flex-1 min-w-0 space-y-4">
          {/* Search + filter */}
          <div className="flex items-center gap-3 flex-wrap">
            <div className="relative flex-1 min-w-[200px]">
              <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder={t("accounting.monthlySales.supplierBills.searchPlaceholder")}
                className="pl-8 h-8 text-sm"
              />
            </div>
            <Select value={statusFilter} onValueChange={setStatusFilter}>
              <SelectTrigger className="w-[170px] h-8 text-sm">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">
                  {t("accounting.monthlySales.supplierBills.filterAll")}
                </SelectItem>
                {(
                  [
                    "statement_needed",
                    "processing",
                    "needs_review",
                    "reconciled",
                    "ready_to_sync",
                    "syncing",
                    "synced",
                    "sync_failed",
                  ] as SupplierStatus[]
                ).map((s) => (
                  <SelectItem key={s} value={s}>
                    {t(`accounting.monthlySales.supplierBills.status.${s}`)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {/* Supplier table */}
          {isLoading ? (
            <Skeleton className="h-48 rounded-xl" />
          ) : (
            <div className="rounded-lg border overflow-hidden">
              <div className="overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow className="bg-muted/40">
                      <TableHead className="text-xs py-2">
                        {t("accounting.monthlySales.supplierBills.table.supplier")}
                      </TableHead>
                      <TableHead className="text-xs py-2 text-right">
                        {t("accounting.monthlySales.supplierBills.table.statementBalance")}
                      </TableHead>
                      <TableHead className="text-xs py-2 text-right">
                        {t("accounting.monthlySales.supplierBills.table.osBillsBalance")}
                      </TableHead>
                      <TableHead className="text-xs py-2 text-right">
                        {t("accounting.monthlySales.supplierBills.table.difference")}
                      </TableHead>
                      <TableHead className="text-xs py-2 text-right">
                        {t("accounting.monthlySales.supplierBills.table.exceptions")}
                      </TableHead>
                      <TableHead className="text-xs py-2">
                        {t("accounting.monthlySales.supplierBills.table.status")}
                      </TableHead>
                      <TableHead className="text-xs py-2">
                        {t("accounting.monthlySales.supplierBills.table.action")}
                      </TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {filteredSuppliers.length === 0 ? (
                      <TableRow>
                        <TableCell colSpan={7} className="text-center text-muted-foreground text-sm py-12">
                          {t("accounting.monthlySales.emptyState")}
                        </TableCell>
                      </TableRow>
                    ) : (
                      filteredSuppliers.map((supplier) => {
                        const diff = supplier.balanceDifference;
                        const diffColor =
                          diff === null
                            ? ""
                            : diff === 0
                              ? "text-green-600"
                              : Math.abs(diff) > 100
                                ? "text-red-600 font-medium"
                                : "text-amber-600";

                        let actionLabel: string;
                        let actionVariant: "outline" | "default" = "outline";
                        if (supplier.sessionStatus === "statement_needed") {
                          actionLabel = t("accounting.monthlySales.supplierBills.actions.upload");
                          actionVariant = "default";
                        } else if (
                          supplier.sessionStatus === "reconciled" ||
                          supplier.sessionStatus === "ready_to_sync" ||
                          supplier.sessionStatus === "synced"
                        ) {
                          actionLabel = t("accounting.monthlySales.supplierBills.actions.view");
                        } else {
                          actionLabel = t("accounting.monthlySales.supplierBills.actions.review");
                        }

                        function handleAction() {
                          if (supplier.sessionStatus === "statement_needed") {
                            setUploadModal({ supplierId: supplier.supplierId, supplierName: supplier.supplierName });
                          } else if (supplier.sessionId) {
                            const selectedEntity = entities.find(
                              (e) => e.entityMonthId === selectedEntityMonthId,
                            );
                            const searchParams = new URLSearchParams({
                              supplier: supplier.supplierName,
                              year: String(year),
                              month: String(month),
                              currency,
                              ...(selectedEntity ? { entity: selectedEntity.entityName } : {}),
                            });
                            setLocation(
                              `/finance/accounting/monthly-closing/supplier-recon/${supplier.sessionId}?${searchParams.toString()}`,
                            );
                          }
                        }

                        return (
                          <TableRow key={supplier.supplierId} className="hover:bg-muted/20">
                            <TableCell className="py-2 font-medium text-xs">
                              {supplier.supplierName}
                            </TableCell>
                            <TableCell className="py-2 text-right text-xs tabular-nums">
                              {formatDollars(supplier.statementBalance, currency)}
                            </TableCell>
                            <TableCell className="py-2 text-right text-xs tabular-nums">
                              {formatDollars(supplier.osBalance, currency)}
                            </TableCell>
                            <TableCell className={`py-2 text-right text-xs tabular-nums ${diffColor}`}>
                              {formatDollars(diff, currency)}
                            </TableCell>
                            <TableCell className="py-2 text-right text-xs">
                              {supplier.openExceptionsCount > 0 ? (
                                <Badge variant="outline" className="border-amber-300 text-amber-700 text-xs">
                                  {supplier.openExceptionsCount}
                                </Badge>
                              ) : (
                                <span className="text-muted-foreground">0</span>
                              )}
                            </TableCell>
                            <TableCell className="py-2">
                              <SupplierStatusBadge status={supplier.sessionStatus} />
                            </TableCell>
                            <TableCell className="py-2">
                              <Button
                                size="sm"
                                variant={actionVariant}
                                className="h-7 text-xs px-2.5 gap-1"
                                onClick={handleAction}
                              >
                                {supplier.sessionStatus === "statement_needed" && <Upload size={11} />}
                                {actionLabel}
                              </Button>
                            </TableCell>
                          </TableRow>
                        );
                      })
                    )}
                  </TableBody>
                </Table>
              </div>
            </div>
          )}
        </div>

        {/* Checklist sidebar */}
        {selectedEntityMonthId !== null && (
          <div className="w-full lg:w-72 shrink-0">
            <SupplierCloseChecklist
              overview={data ?? null}
              entityMonthId={selectedEntityMonthId}
            />
          </div>
        )}
      </div>

      {/* Upload modal */}
      {uploadModal && selectedEntityMonthId !== null && (
        <StatementUploadModal
          open={true}
          supplierName={uploadModal.supplierName}
          entityMonthId={selectedEntityMonthId}
          supplierId={uploadModal.supplierId}
          year={year}
          month={month}
          onClose={() => setUploadModal(null)}
          onSuccess={() => {
            setUploadModal(null);
            void queryClient.invalidateQueries({ queryKey: overviewQueryKey });
          }}
        />
      )}
    </div>
  );
}

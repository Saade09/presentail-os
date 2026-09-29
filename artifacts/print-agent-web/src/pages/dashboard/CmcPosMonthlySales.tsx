import { useState } from "react";
import { Link } from "wouter";
import {
  TrendingUp,
  Download,
  RefreshCw,
  CheckCircle,
  AlertTriangle,
  Clock,
  FileText,
  ChevronLeft,
  ChevronRight,
  AlertCircle,
  ChevronDown,
  ChevronUp,
} from "lucide-react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiFetch, getClerkToken } from "@/lib/queryClient";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { toast } from "@/hooks/use-toast";
import { useTranslation } from "react-i18next";
import { useWorkspaceRole } from "@/hooks/use-workspace-role";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface MonthlySalesRow {
  month: string;
  gross: number;
  net: number;
  commission: number;
  commissionVat: number;
  payable: number;
  status: "unpaid" | "paid";
  paidAt: string | null;
  dueDate: string;
}

interface SalesVerification {
  qualifyingCount: number;
  refundsExcluded: number;
  unmatchedCount: number;
  lastRefreshed: string;
}

interface AnnualSummary {
  statementCount: number;
  grossYtd: number;
  paidToDate: number;
  outstanding: number;
}

interface MonthlySalesResult {
  months: MonthlySalesRow[];
  totals: {
    gross: number;
    net: number;
    commission: number;
    commissionVat: number;
    payable: number;
  };
  currency: string;
  fromMonth: string | null;
  toMonth: string | null;
  salesVerification?: SalesVerification;
  annualSummary?: AnnualSummary;
}

type ViewTab = "statements" | "payment_summary";
type DisplayStatus = "paid" | "due_soon" | "overdue" | "draft";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function previousMonthLabel(): string {
  const now = new Date();
  const year = now.getFullYear();
  const month = now.getMonth();
  if (month === 0) return `${year - 1}-12`;
  return `${year}-${String(month).padStart(2, "0")}`;
}

function currentMonthLabel(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
}

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

/** Always show two decimal places for finance-grade clarity */
function fmtMoney(n: number | undefined): string {
  const num = n === undefined || n === null ? 0 : Number(n);
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(num);
}

/** Format "2026-08-10" → "Aug 10, 2026" */
function fmtDueDate(d: string | null | undefined): string {
  if (!d) return "—";
  const parts = d.split("-");
  if (parts.length !== 3) return d;
  const dt = new Date(
    parseInt(parts[0], 10),
    parseInt(parts[1], 10) - 1,
    parseInt(parts[2], 10),
  );
  return dt.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

/** Format "2026-08-10" → "Aug 10" (no year, for KPI card labels) */
function fmtDueDateShort(d: string): string {
  const parts = d.split("-");
  if (parts.length !== 3) return d;
  const dt = new Date(
    parseInt(parts[0], 10),
    parseInt(parts[1], 10) - 1,
    parseInt(parts[2], 10),
  );
  return dt.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

/** Days until due date (negative = overdue) */
function daysUntilDue(dueDate: string): number {
  const todayMs = new Date(todayIso() + "T00:00:00").getTime();
  const dueMs = new Date(dueDate + "T00:00:00").getTime();
  return Math.round((dueMs - todayMs) / (1000 * 60 * 60 * 24));
}

function formatMonth(m: string): string {
  const [year, month] = m.split("-");
  return new Date(parseInt(year, 10), parseInt(month, 10) - 1, 1).toLocaleDateString("en-US", {
    month: "long",
    year: "numeric",
  });
}

function getDisplayStatus(row: MonthlySalesRow): DisplayStatus {
  const today = todayIso();
  const currMonth = currentMonthLabel();
  if (row.status === "paid") return "paid";
  if (row.month >= currMonth) return "draft";
  if (row.dueDate && row.dueDate < today) return "overdue";
  return "due_soon";
}

// ---------------------------------------------------------------------------
// Status badge — 4 clear states
// ---------------------------------------------------------------------------

function StatusBadge({ status, dueDate }: { status: DisplayStatus; dueDate?: string }) {
  if (status === "paid") {
    return (
      <Badge
        variant="outline"
        className="bg-green-50 text-green-700 border-green-200 gap-1 whitespace-nowrap"
      >
        <CheckCircle className="w-3 h-3" />
        Paid
      </Badge>
    );
  }
  if (status === "overdue") {
    return (
      <Badge
        variant="outline"
        className="bg-red-50 text-red-700 border-red-200 gap-1 whitespace-nowrap"
      >
        <AlertCircle className="w-3 h-3" />
        Overdue
      </Badge>
    );
  }
  if (status === "draft") {
    return (
      <Badge
        variant="outline"
        className="bg-gray-100 text-gray-600 border-gray-200 gap-1 whitespace-nowrap"
      >
        <FileText className="w-3 h-3" />
        Draft
      </Badge>
    );
  }
  // due_soon
  const days = dueDate ? daysUntilDue(dueDate) : null;
  return (
    <Badge
      variant="outline"
      className="bg-amber-50 text-amber-700 border-amber-200 gap-1 whitespace-nowrap"
    >
      <Clock className="w-3 h-3" />
      {days !== null && days >= 0 ? `Due soon` : "Due soon"}
    </Badge>
  );
}

// ---------------------------------------------------------------------------
// KPI Card component
// ---------------------------------------------------------------------------

function KpiCard({
  label,
  value,
  sub,
  accent,
  accentBorder,
}: {
  label: string;
  value: string;
  sub?: string;
  accent?: boolean;
  accentBorder?: boolean;
}) {
  return (
    <Card className={accentBorder ? "border-teal-300 bg-teal-50/40" : ""}>
      <CardContent className="pt-4 pb-4">
        <p className="text-xs text-muted-foreground">{label}</p>
        <p
          className={`text-2xl font-bold mt-1 tabular-nums ${
            accent ? "text-teal-700" : ""
          }`}
        >
          {value}
        </p>
        {sub && (
          <p
            className={`text-xs mt-0.5 ${
              accent ? "text-teal-600" : "text-muted-foreground"
            }`}
          >
            {sub}
          </p>
        )}
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Calculation explanation accordion
// ---------------------------------------------------------------------------

function CalcExplanation() {
  const [open, setOpen] = useState(false);
  return (
    <div className="border rounded-lg bg-gray-50/60">
      <button
        className="w-full flex items-center justify-between px-4 py-3 text-sm font-medium text-gray-700 hover:bg-gray-100/60 rounded-lg transition-colors"
        onClick={() => setOpen((v) => !v)}
        type="button"
      >
        <span className="flex items-center gap-2">
          <TrendingUp className="w-4 h-4 text-teal-700" />
          How the amount due is calculated
        </span>
        {open ? (
          <ChevronUp className="w-4 h-4 text-muted-foreground" />
        ) : (
          <ChevronDown className="w-4 h-4 text-muted-foreground" />
        )}
      </button>
      {open && (
        <div className="px-4 pb-3 pt-0">
          <p className="text-sm text-muted-foreground">
            <span className="text-gray-700">Gross sales</span>
            {" "}−{" "}
            <span className="text-gray-700">sales VAT</span>
            {" "}={" "}
            <span className="font-medium text-gray-800">Net sales</span>
            {"  •  "}
            <span className="font-medium text-gray-800">Net sales</span>
            {" "}×{" "}
            <span className="text-gray-700">20%</span>
            {" "}={" "}
            <span className="font-medium text-gray-800">Commission</span>
            {"  •  "}
            <span className="font-medium text-gray-800">Commission</span>
            {" "}+{" "}
            <span className="text-gray-700">11% VAT</span>
            {" "}={" "}
            <span className="font-semibold text-teal-700">Amount due to CMC</span>
          </p>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Calculation breakdown table (used in Payment summary view)
// ---------------------------------------------------------------------------

function CalcRow({
  label,
  value,
  indent,
  bold,
  divider,
  positive,
}: {
  label: string;
  value: string;
  indent?: boolean;
  bold?: boolean;
  divider?: boolean;
  positive?: boolean;
}) {
  return (
    <>
      {divider && (
        <tr>
          <td colSpan={2}>
            <div className="border-t border-gray-200 my-1" />
          </td>
        </tr>
      )}
      <tr>
        <td
          className={`py-1 text-sm pr-6 ${indent ? "pl-4 text-muted-foreground" : ""} ${bold ? "font-semibold" : ""}`}
        >
          {label}
        </td>
        <td
          className={`py-1 text-sm text-right font-mono tabular-nums ${bold ? "font-bold" : ""} ${positive ? "text-teal-700" : ""}`}
        >
          {value}
        </td>
      </tr>
    </>
  );
}

// ---------------------------------------------------------------------------
// Record Payment Dialog
// ---------------------------------------------------------------------------

interface RecordPaymentDialogProps {
  month: string | null;
  payable: number;
  open: boolean;
  onClose: () => void;
  onSuccess: () => void;
}

function RecordPaymentDialog({
  month,
  payable,
  open,
  onClose,
  onSuccess,
}: RecordPaymentDialogProps) {
  const [pmDate, setPmDate] = useState(todayIso());
  const [pmAmount, setPmAmount] = useState(String(payable.toFixed(2)));
  const [pmMethod, setPmMethod] = useState("bank_transfer");
  const [pmRef, setPmRef] = useState("");
  const [pmNote, setPmNote] = useState("");

  const amountNum = parseFloat(pmAmount) || 0;
  const amountDiffers = Math.abs(amountNum - payable) > 0.005;

  const queryClient = useQueryClient();

  const mutation = useMutation({
    mutationFn: async () => {
      return apiFetch<{ settlement: unknown }>(
        `/api/cmc-pos/monthly-sales/${month}/payment`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            paidAt: pmDate ? new Date(pmDate).toISOString() : undefined,
            amount: amountNum,
            paymentMethod: pmMethod,
            referenceNumber: pmRef || undefined,
            note: pmNote || undefined,
          }),
        },
      );
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["cmc-monthly-sales"] });
      toast({ title: "Payment recorded" });
      onSuccess();
      onClose();
    },
    onError: () => {
      toast({ title: "Failed to record payment", variant: "destructive" });
    },
  });

  const canSubmit = pmDate && pmAmount && parseFloat(pmAmount) > 0 && pmMethod;

  const handleOpenChange = (v: boolean) => {
    if (v) {
      setPmDate(todayIso());
      setPmAmount(String(payable.toFixed(2)));
      setPmMethod("bank_transfer");
      setPmRef("");
      setPmNote("");
    } else {
      onClose();
    }
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-[480px]">
        <DialogHeader>
          <DialogTitle>Record payment</DialogTitle>
          {month && (
            <p className="text-sm text-muted-foreground mt-0.5">
              {formatMonth(month)}
            </p>
          )}
        </DialogHeader>

        <div className="space-y-4 py-2">
          <div className="space-y-1.5">
            <Label>Payment date</Label>
            <Input
              type="date"
              value={pmDate}
              onChange={(e) => setPmDate(e.target.value)}
            />
          </div>

          <div className="space-y-1.5">
            <Label>Amount</Label>
            <Input
              type="number"
              step="0.01"
              min="0"
              value={pmAmount}
              onChange={(e) => setPmAmount(e.target.value)}
            />
            {amountDiffers && (
              <div className="flex items-start gap-2 rounded-md bg-amber-50 border border-amber-200 px-3 py-2 text-sm text-amber-800">
                <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" />
                <span>
                  Amount differs from the amount due to CMC (
                  {fmtMoney(payable)})
                </span>
              </div>
            )}
          </div>

          <div className="space-y-1.5">
            <Label>Payment method</Label>
            <Select value={pmMethod} onValueChange={setPmMethod}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="bank_transfer">Bank transfer</SelectItem>
                <SelectItem value="cash">Cash</SelectItem>
                <SelectItem value="cheque">Cheque</SelectItem>
                <SelectItem value="other">Other</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-1.5">
            <Label>
              Reference{" "}
              <span className="text-muted-foreground text-xs">(optional)</span>
            </Label>
            <Input
              placeholder="e.g. TRF-20260810"
              value={pmRef}
              onChange={(e) => setPmRef(e.target.value)}
            />
          </div>

          <div className="space-y-1.5">
            <Label>
              Note{" "}
              <span className="text-muted-foreground text-xs">(optional)</span>
            </Label>
            <textarea
              className="flex min-h-[72px] w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 resize-none"
              placeholder="Any notes about this payment"
              value={pmNote}
              onChange={(e) => setPmNote(e.target.value)}
            />
          </div>
        </div>

        <DialogFooter>
          <Button
            variant="outline"
            onClick={onClose}
            disabled={mutation.isPending}
          >
            Cancel
          </Button>
          <Button
            className="bg-teal-700 hover:bg-teal-800 text-white"
            disabled={!canSubmit || mutation.isPending}
            onClick={() => mutation.mutate()}
          >
            {mutation.isPending ? "Confirming…" : "Confirm payment"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Payment summary view (single month detail)
// ---------------------------------------------------------------------------

interface PaymentSummaryViewProps {
  month: string;
  data: MonthlySalesResult | undefined;
  isLoading: boolean;
  isError: boolean;
  isOwner: boolean;
  onRecordPayment: (m: string) => void;
  onExportPdf: () => void;
  isPdfExporting: boolean;
  allData: MonthlySalesResult | undefined;
}

function PaymentSummaryView({
  month,
  data,
  isLoading,
  isError,
  isOwner,
  onRecordPayment,
  onExportPdf,
  isPdfExporting,
  allData,
}: PaymentSummaryViewProps) {
  const row = data?.months[0];
  const displayStatus = row ? getDisplayStatus(row) : "draft";
  const verification = data?.salesVerification;

  const [yearStr, monthStr] = month.split("-");
  const year = parseInt(yearStr, 10);
  const monthNum = parseInt(monthStr, 10);
  const lastDay = new Date(year, monthNum, 0).getDate();
  const salesHref = `/cmc-pos/sales?from=${month}-01&to=${month}-${String(lastDay).padStart(2, "0")}`;

  if (isLoading) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-48 w-full" />
        <div className="grid grid-cols-4 gap-3">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-20" />
          ))}
        </div>
        <Skeleton className="h-24 w-full" />
      </div>
    );
  }

  if (isError) {
    return (
      <p className="text-sm text-destructive py-8 text-center">
        Failed to load data. Please try refreshing.
      </p>
    );
  }

  if (!row) {
    return (
      <div className="text-center py-16 text-muted-foreground">
        <TrendingUp className="w-10 h-10 mx-auto mb-3 opacity-30" />
        <p className="text-sm">No sales data for this month.</p>
      </div>
    );
  }

  const lessVat = row.gross - row.net;

  return (
    <div className="space-y-4">
      {/* Summary card */}
      <Card className="border-2 border-teal-100 bg-gradient-to-br from-white to-teal-50/30">
        <CardContent className="p-0">
          <div className="flex flex-col md:flex-row divide-y md:divide-y-0 md:divide-x divide-gray-100">
            {/* Left: payable + status + actions */}
            <div className="flex-1 p-6 space-y-4">
              <div>
                <p className="text-xs font-medium text-teal-700 uppercase tracking-wider">
                  Payment summary
                </p>
                <p className="text-sm text-muted-foreground mt-0.5">
                  {formatMonth(month)}
                </p>
              </div>

              <div>
                <p className="text-xs text-muted-foreground mb-1">
                  Amount due to CMC
                </p>
                <p className="text-4xl font-extrabold text-teal-800 tabular-nums">
                  {fmtMoney(row.payable)}
                </p>
              </div>

              <div className="flex flex-wrap items-center gap-2">
                <StatusBadge status={displayStatus} dueDate={row.dueDate} />
                {row.dueDate && (
                  <span className="text-xs text-muted-foreground flex items-center gap-1">
                    <Clock className="w-3 h-3" />
                    Due: {fmtDueDate(row.dueDate)}
                  </span>
                )}
                {row.paidAt && displayStatus === "paid" && (
                  <span className="text-xs text-green-700">
                    Paid {new Date(row.paidAt).toLocaleDateString()}
                  </span>
                )}
              </div>

              {isOwner && displayStatus !== "paid" && displayStatus !== "draft" && (
                <div className="flex flex-wrap gap-2 pt-1">
                  <Button
                    className="bg-teal-700 hover:bg-teal-800 text-white"
                    onClick={() => onRecordPayment(month)}
                  >
                    Record payment
                  </Button>
                  <Link href={salesHref}>
                    <Button variant="outline" size="sm">
                      View transactions
                    </Button>
                  </Link>
                </div>
              )}
              {(displayStatus === "paid" || displayStatus === "draft" || !isOwner) && (
                <Link href={salesHref}>
                  <Button variant="outline" size="sm">
                    View transactions
                  </Button>
                </Link>
              )}
            </div>

            {/* Right: calculation breakdown */}
            <div className="flex-1 p-6">
              <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider mb-3">
                How it&apos;s calculated
              </p>
              <table className="w-full">
                <tbody>
                  <CalcRow label="Gross sales" value={fmtMoney(row.gross)} />
                  <CalcRow
                    label="Less sales VAT"
                    value={`(${fmtMoney(lessVat)})`}
                    indent
                  />
                  <CalcRow
                    label="Net sales"
                    value={fmtMoney(row.net)}
                    divider
                  />
                  <CalcRow
                    label="Commission (20%)"
                    value={fmtMoney(row.commission)}
                    indent
                  />
                  <CalcRow
                    label="VAT on commission (11%)"
                    value={fmtMoney(row.commissionVat)}
                    indent
                  />
                  <CalcRow
                    label="Amount due to CMC"
                    value={fmtMoney(row.payable)}
                    bold
                    divider
                    positive
                  />
                </tbody>
              </table>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* 4 KPI cards */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <KpiCard label="Gross sales" value={fmtMoney(row.gross)} sub="VAT incl." />
        <KpiCard label="Net sales" value={fmtMoney(row.net)} sub="VAT excl." />
        <KpiCard
          label="Commission"
          value={fmtMoney(row.commission)}
          sub="20% of net"
        />
        <KpiCard
          label="VAT on commission"
          value={fmtMoney(row.commissionVat)}
          sub="11% of commission"
        />
      </div>

      {/* Sales Verification panel */}
      {verification && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm flex items-center justify-between">
              <span>Sales verification</span>
              {verification.unmatchedCount === 0 ? (
                <span className="text-xs font-normal text-green-700 flex items-center gap-1">
                  <CheckCircle className="w-3.5 h-3.5" />
                  All reconciled
                </span>
              ) : (
                <span className="text-xs font-normal text-amber-700 flex items-center gap-1">
                  <AlertTriangle className="w-3.5 h-3.5" />
                  Issues found
                </span>
              )}
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div
              className={`rounded-lg p-3 mb-3 text-sm ${
                verification.unmatchedCount === 0
                  ? "bg-green-50 border border-green-100"
                  : "bg-amber-50 border border-amber-100"
              }`}
            >
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-x-6 gap-y-1">
                <div>
                  <p className="text-xs text-muted-foreground">Qualifying</p>
                  <p className="font-semibold">{verification.qualifyingCount}</p>
                </div>
                <div>
                  <p className="text-xs text-muted-foreground">Refunds excluded</p>
                  <p className="font-semibold">{verification.refundsExcluded}</p>
                </div>
                <div>
                  <p className="text-xs text-muted-foreground">Unmatched</p>
                  <p
                    className={`font-semibold ${verification.unmatchedCount > 0 ? "text-amber-700" : ""}`}
                  >
                    {verification.unmatchedCount}
                  </p>
                </div>
                <div>
                  <p className="text-xs text-muted-foreground">Last refreshed</p>
                  <p className="font-medium text-xs">
                    {new Date(verification.lastRefreshed).toLocaleTimeString()}
                  </p>
                </div>
              </div>
            </div>
            {verification.unmatchedCount > 0 && (
              <Link href={salesHref}>
                <Button
                  size="sm"
                  variant="outline"
                  className="border-amber-300 text-amber-700 hover:bg-amber-50"
                >
                  Review sales
                </Button>
              </Link>
            )}
          </CardContent>
        </Card>
      )}

      {/* Recent statements */}
      {allData && allData.months.length > 0 && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">Recent statements</CardTitle>
          </CardHeader>
          <CardContent className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Month</TableHead>
                  <TableHead className="text-right">Gross sales</TableHead>
                  <TableHead className="text-right">Net sales</TableHead>
                  <TableHead className="text-right">Amount due to CMC</TableHead>
                  <TableHead>Due date</TableHead>
                  <TableHead className="text-center">Status</TableHead>
                  {isOwner && <TableHead />}
                </TableRow>
              </TableHeader>
              <TableBody>
                {allData.months.slice(0, 12).map((r) => {
                  const ds = getDisplayStatus(r);
                  return (
                    <TableRow key={r.month}>
                      <TableCell className="font-medium">
                        {formatMonth(r.month)}
                      </TableCell>
                      <TableCell className="text-right text-sm tabular-nums">
                        {fmtMoney(r.gross)}
                      </TableCell>
                      <TableCell className="text-right text-sm tabular-nums">
                        {fmtMoney(r.net)}
                      </TableCell>
                      <TableCell className="text-right font-semibold text-teal-700 tabular-nums">
                        {fmtMoney(r.payable)}
                      </TableCell>
                      <TableCell className="text-sm text-muted-foreground whitespace-nowrap">
                        {fmtDueDate(r.dueDate)}
                      </TableCell>
                      <TableCell className="text-center">
                        <StatusBadge status={ds} dueDate={r.dueDate} />
                      </TableCell>
                      {isOwner && (
                        <TableCell>
                          {ds !== "paid" && ds !== "draft" ? (
                            <Button
                              variant="ghost"
                              size="sm"
                              className="text-xs text-teal-700"
                              onClick={() => onRecordPayment(r.month)}
                            >
                              Record payment
                            </Button>
                          ) : null}
                        </TableCell>
                      )}
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Statements view (all statements table — default view)
// ---------------------------------------------------------------------------

const PAGE_SIZE = 12;

interface StatementsViewProps {
  data: MonthlySalesResult | undefined;
  isLoading: boolean;
  isError: boolean;
  isOwner: boolean;
  onRecordPayment: (m: string) => void;
  onExportPdf: (month: string) => void;
}

function StatementsView({
  data,
  isLoading,
  isError,
  isOwner,
  onRecordPayment,
  onExportPdf,
}: StatementsViewProps) {
  const [page, setPage] = useState(1);
  const [yearFilter, setYearFilter] = useState("all");
  const [statusFilter, setStatusFilter] = useState("all");
  const [search, setSearch] = useState("");

  if (isLoading) {
    return (
      <div className="space-y-4">
        <div className="grid grid-cols-2 sm:grid-cols-5 gap-3">
          {Array.from({ length: 5 }).map((_, i) => (
            <Skeleton key={i} className="h-20" />
          ))}
        </div>
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }

  if (isError) {
    return (
      <p className="text-sm text-destructive py-8 text-center">
        Failed to load data. Please try refreshing.
      </p>
    );
  }

  const months = data?.months ?? [];
  const annualSummary = data?.annualSummary;

  // Derive due / upcoming from months (exclude drafts from "currently due")
  const actionableRows = months
    .filter((r) => {
      const ds = getDisplayStatus(r);
      return ds === "due_soon" || ds === "overdue";
    })
    .sort((a, b) => (a.dueDate ?? "").localeCompare(b.dueDate ?? ""));

  const dueRow = actionableRows[0] ?? null;
  const upcomingRow = (() => {
    // Upcoming = draft (current/future) month with smallest due date
    const drafts = months
      .filter((r) => getDisplayStatus(r) === "draft")
      .sort((a, b) => (a.dueDate ?? "").localeCompare(b.dueDate ?? ""));
    return drafts[0] ?? null;
  })();

  // Derive available years
  const years = Array.from(
    new Set(months.map((m) => m.month.slice(0, 4))),
  ).sort((a, b) => b.localeCompare(a));

  // Filter rows
  const filtered = months.filter((r) => {
    if (yearFilter !== "all" && !r.month.startsWith(yearFilter)) return false;
    if (statusFilter !== "all") {
      const ds = getDisplayStatus(r);
      // Map filter value to display status
      const mapped =
        statusFilter === "due_soon"
          ? "due_soon"
          : (statusFilter as DisplayStatus);
      if (ds !== mapped) return false;
    }
    if (search) {
      const q = search.toLowerCase();
      if (
        !r.month.includes(q) &&
        !formatMonth(r.month).toLowerCase().includes(q)
      )
        return false;
    }
    return true;
  });

  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const safePage = Math.min(page, totalPages);
  const pageStart = (safePage - 1) * PAGE_SIZE;
  const pageRows = filtered.slice(pageStart, pageStart + PAGE_SIZE);
  const showFrom = filtered.length > 0 ? pageStart + 1 : 0;
  const showTo = Math.min(pageStart + PAGE_SIZE, filtered.length);

  return (
    <div className="space-y-4">
      {/* 5 KPI summary cards */}
      {annualSummary && (
        <div className="grid grid-cols-2 sm:grid-cols-5 gap-3">
          <KpiCard
            label="Statements"
            value={String(annualSummary.statementCount)}
          />
          <KpiCard
            label="Gross Sales YTD"
            value={fmtMoney(annualSummary.grossYtd)}
          />
          <KpiCard
            label="Paid to CMC YTD"
            value={fmtMoney(annualSummary.paidToDate)}
          />

          {/* Due card — only shows when there's an actionable (non-draft) statement */}
          {dueRow ? (
            <Card className="border-teal-300 bg-teal-50/40">
              <CardContent className="pt-4 pb-4">
                <p className="text-xs text-teal-700 font-medium">
                  Due {dueRow.dueDate ? fmtDueDateShort(dueRow.dueDate) : "—"}
                </p>
                <p className="text-2xl font-bold mt-1 tabular-nums text-teal-700">
                  {fmtMoney(dueRow.payable)}
                </p>
                {dueRow.dueDate && (() => {
                  const days = daysUntilDue(dueRow.dueDate);
                  return (
                    <p className="text-xs text-teal-600 mt-0.5">
                      {days >= 0
                        ? `${days} day${days === 1 ? "" : "s"} remaining`
                        : `${Math.abs(days)} day${Math.abs(days) === 1 ? "" : "s"} overdue`}
                    </p>
                  );
                })()}
              </CardContent>
            </Card>
          ) : (
            <Card>
              <CardContent className="pt-4 pb-4">
                <p className="text-xs text-muted-foreground">Currently due</p>
                <p className="text-2xl font-bold mt-1 tabular-nums text-muted-foreground">
                  —
                </p>
                <p className="text-xs text-muted-foreground mt-0.5">
                  Nothing due
                </p>
              </CardContent>
            </Card>
          )}

          {/* Upcoming card — next draft/future statement */}
          {upcomingRow ? (
            <Card>
              <CardContent className="pt-4 pb-4">
                <p className="text-xs text-muted-foreground">Upcoming</p>
                <p className="text-2xl font-bold mt-1 tabular-nums">
                  {fmtMoney(upcomingRow.payable)}
                </p>
                {upcomingRow.dueDate && (
                  <p className="text-xs text-muted-foreground mt-0.5">
                    Due {fmtDueDateShort(upcomingRow.dueDate)}
                  </p>
                )}
              </CardContent>
            </Card>
          ) : (
            <Card>
              <CardContent className="pt-4 pb-4">
                <p className="text-xs text-muted-foreground">Upcoming</p>
                <p className="text-2xl font-bold mt-1 tabular-nums text-muted-foreground">
                  —
                </p>
              </CardContent>
            </Card>
          )}
        </div>
      )}

      {/* Filters + table */}
      <Card>
        <CardHeader className="pb-3">
          <div className="flex flex-wrap items-end gap-3">
            <div className="space-y-1">
              <Label className="text-xs text-muted-foreground">Year</Label>
              <Select
                value={yearFilter}
                onValueChange={(v) => {
                  setYearFilter(v);
                  setPage(1);
                }}
              >
                <SelectTrigger className="w-28 h-8 text-sm">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All years</SelectItem>
                  {years.map((y) => (
                    <SelectItem key={y} value={y}>
                      {y}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <Label className="text-xs text-muted-foreground">Status</Label>
              <Select
                value={statusFilter}
                onValueChange={(v) => {
                  setStatusFilter(v);
                  setPage(1);
                }}
              >
                <SelectTrigger className="w-36 h-8 text-sm">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All statuses</SelectItem>
                  <SelectItem value="paid">Paid</SelectItem>
                  <SelectItem value="due_soon">Due soon</SelectItem>
                  <SelectItem value="overdue">Overdue</SelectItem>
                  <SelectItem value="draft">Draft</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="flex-1 min-w-[160px] space-y-1">
              <Label className="text-xs text-muted-foreground invisible">
                Search
              </Label>
              <div className="relative">
                <svg
                  className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth={2}
                  viewBox="0 0 24 24"
                >
                  <circle cx={11} cy={11} r={8} />
                  <path d="m21 21-4.35-4.35" />
                </svg>
                <Input
                  className="h-8 text-sm pl-8"
                  placeholder="Search statements"
                  value={search}
                  onChange={(e) => {
                    setSearch(e.target.value);
                    setPage(1);
                  }}
                />
              </div>
            </div>
          </div>
        </CardHeader>
        <CardContent className="overflow-x-auto p-0">
          {filtered.length === 0 ? (
            <p className="text-sm text-muted-foreground py-12 text-center">
              No statements found.
            </p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow className="bg-gray-50/60">
                  <TableHead>Month</TableHead>
                  <TableHead className="text-right">Gross sales</TableHead>
                  <TableHead className="text-right">Net sales</TableHead>
                  <TableHead className="text-right">Commission</TableHead>
                  <TableHead className="text-right">VAT on commission</TableHead>
                  <TableHead className="text-right">Amount due to CMC</TableHead>
                  <TableHead>Due date</TableHead>
                  <TableHead className="text-center">Status</TableHead>
                  <TableHead>Statement</TableHead>
                  {isOwner && <TableHead>Action</TableHead>}
                </TableRow>
              </TableHeader>
              <TableBody>
                {pageRows.map((r) => {
                  const ds = getDisplayStatus(r);
                  return (
                    <TableRow key={r.month}>
                      <TableCell className="font-medium whitespace-nowrap">
                        {formatMonth(r.month)}
                      </TableCell>
                      <TableCell className="text-right text-sm tabular-nums">
                        {fmtMoney(r.gross)}
                      </TableCell>
                      <TableCell className="text-right text-sm tabular-nums">
                        {fmtMoney(r.net)}
                      </TableCell>
                      <TableCell className="text-right text-sm tabular-nums">
                        {fmtMoney(r.commission)}
                      </TableCell>
                      <TableCell className="text-right text-sm tabular-nums">
                        {fmtMoney(r.commissionVat)}
                      </TableCell>
                      <TableCell className="text-right font-semibold text-teal-700 tabular-nums">
                        {fmtMoney(r.payable)}
                      </TableCell>
                      <TableCell className="text-sm text-muted-foreground whitespace-nowrap">
                        {fmtDueDate(r.dueDate)}
                      </TableCell>
                      <TableCell className="text-center">
                        <StatusBadge status={ds} dueDate={r.dueDate} />
                      </TableCell>
                      {/* Statement column — PDF download */}
                      <TableCell>
                        <Button
                          variant="ghost"
                          size="sm"
                          className="text-xs text-muted-foreground h-7 px-2 gap-1"
                          onClick={() => onExportPdf(r.month)}
                        >
                          <FileText className="w-3.5 h-3.5" />
                          PDF
                        </Button>
                      </TableCell>
                      {/* Action column */}
                      {isOwner && (
                        <TableCell>
                          {ds === "draft" ? (
                            <Button
                              variant="outline"
                              size="sm"
                              className="text-xs h-7"
                              onClick={() => onExportPdf(r.month)}
                            >
                              View
                            </Button>
                          ) : ds !== "paid" ? (
                            <Button
                              size="sm"
                              className="text-xs bg-teal-700 hover:bg-teal-800 text-white h-7"
                              onClick={() => onRecordPayment(r.month)}
                            >
                              Record payment
                            </Button>
                          ) : ds === "paid" ? (
                            <span className="text-xs text-muted-foreground">
                              {r.paidAt
                                ? new Date(r.paidAt).toLocaleDateString(
                                    "en-US",
                                    { month: "short", day: "numeric", year: "numeric" },
                                  )
                                : "Paid"}
                            </span>
                          ) : null}
                        </TableCell>
                      )}
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          )}
        </CardContent>

        {/* Pagination */}
        {filtered.length > 0 && (
          <div className="flex items-center justify-between px-4 py-3 border-t">
            <p className="text-sm text-muted-foreground">
              Showing {showFrom}–{showTo} of {filtered.length} statement
              {filtered.length !== 1 ? "s" : ""}
            </p>
            <div className="flex items-center gap-1">
              <Button
                variant="outline"
                size="icon"
                className="h-7 w-7"
                disabled={safePage <= 1}
                onClick={() => setPage((p) => Math.max(1, p - 1))}
              >
                <ChevronLeft className="w-4 h-4" />
              </Button>
              <span className="text-sm px-2">
                {safePage} / {totalPages}
              </span>
              <Button
                variant="outline"
                size="icon"
                className="h-7 w-7"
                disabled={safePage >= totalPages}
                onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
              >
                <ChevronRight className="w-4 h-4" />
              </Button>
            </div>
          </div>
        )}
      </Card>

      {/* Calculation explanation */}
      <CalcExplanation />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main page
// ---------------------------------------------------------------------------

export default function CmcPosMonthlySales() {
  const { i18n } = useTranslation();
  const dir = i18n.dir();
  const { isOwner } = useWorkspaceRole();

  // Default to "statements" view
  const [viewTab, setViewTab] = useState<ViewTab>("statements");
  const [month, setMonth] = useState(previousMonthLabel());
  const [isPdfExporting, setIsPdfExporting] = useState(false);
  const [recordPaymentFor, setRecordPaymentFor] = useState<string | null>(null);

  const queryClient = useQueryClient();

  // Single-month query (for Payment summary view)
  const singleQuery = useQuery<MonthlySalesResult>({
    queryKey: ["cmc-monthly-sales", "single", month],
    queryFn: () =>
      apiFetch<MonthlySalesResult>(
        `/api/cmc-pos/monthly-sales?mode=single&month=${month}`,
      ),
    staleTime: 30_000,
  });

  // All-time query (used by Statements view)
  const allQuery = useQuery<MonthlySalesResult>({
    queryKey: ["cmc-monthly-sales", "all_time"],
    queryFn: () =>
      apiFetch<MonthlySalesResult>(`/api/cmc-pos/monthly-sales?mode=all_time`),
    staleTime: 30_000,
  });

  const payableForModal = recordPaymentFor
    ? (allQuery.data?.months.find((m) => m.month === recordPaymentFor)
        ?.payable ??
      singleQuery.data?.months[0]?.payable ??
      0)
    : 0;

  async function handlePdfExport(targetMonth?: string) {
    setIsPdfExporting(true);
    try {
      const token = await getClerkToken();
      let url: string;
      if (targetMonth) {
        url = `/api/cmc-pos/monthly-sales/pdf?mode=single&month=${targetMonth}`;
      } else if (viewTab === "payment_summary") {
        url = `/api/cmc-pos/monthly-sales/pdf?mode=single&month=${month}`;
      } else {
        url = `/api/cmc-pos/monthly-sales/pdf?mode=all_time`;
      }
      const response = await fetch(url, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!response.ok) throw new Error("PDF generation failed");
      const blob = await response.blob();
      const objectUrl = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = objectUrl;
      a.download = `cmc-commission-${targetMonth ?? (viewTab === "payment_summary" ? month : "all-time")}.pdf`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(objectUrl);
    } catch {
      toast({ title: "Failed to generate report", variant: "destructive" });
    } finally {
      setIsPdfExporting(false);
    }
  }

  function handleRefresh() {
    void singleQuery.refetch();
    void allQuery.refetch();
  }

  return (
    <div className="p-6 max-w-6xl mx-auto space-y-5" dir={dir}>
      {/* Page header */}
      <div className="flex flex-wrap items-start gap-3">
        <div className="flex-1 min-w-0">
          <h1 className="text-xl font-semibold text-gray-900">
            CMC Commission Statements
          </h1>
          <p className="text-sm text-muted-foreground mt-0.5">
            Review monthly sales, commission, VAT, and amounts payable to CMC.
          </p>
        </div>

        <div className="flex items-center gap-2 flex-wrap">
          {/* Tab toggle: Payment summary | Statements */}
          <div className="flex rounded-lg border border-gray-200 overflow-hidden">
            <button
              type="button"
              className={`px-3 py-1.5 text-sm font-medium transition-colors ${
                viewTab === "payment_summary"
                  ? "bg-white text-gray-900 shadow-sm"
                  : "bg-gray-50 text-gray-500 hover:text-gray-700"
              }`}
              onClick={() => setViewTab("payment_summary")}
            >
              Payment summary
            </button>
            <button
              type="button"
              className={`px-3 py-1.5 text-sm font-medium transition-colors ${
                viewTab === "statements"
                  ? "bg-teal-700 text-white"
                  : "bg-gray-50 text-gray-500 hover:text-gray-700"
              }`}
              onClick={() => setViewTab("statements")}
            >
              Statements
            </button>
          </div>

          <Button
            variant="outline"
            size="sm"
            onClick={handleRefresh}
            className="gap-1.5"
          >
            <RefreshCw className="w-3.5 h-3.5" />
            Refresh
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => void handlePdfExport()}
            disabled={isPdfExporting}
            className="gap-1.5"
          >
            <Download className="w-3.5 h-3.5" />
            {isPdfExporting ? "Generating…" : "Download report"}
          </Button>
        </div>
      </div>

      {/* Month selector (Payment summary view only) */}
      {viewTab === "payment_summary" && (
        <div className="flex items-center gap-3">
          <Label className="text-sm whitespace-nowrap text-muted-foreground">
            Month
          </Label>
          <Input
            type="month"
            value={month}
            onChange={(e) => setMonth(e.target.value)}
            className="w-44"
          />
        </div>
      )}

      {/* View content */}
      {viewTab === "payment_summary" ? (
        <PaymentSummaryView
          month={month}
          data={singleQuery.data}
          isLoading={singleQuery.isLoading}
          isError={singleQuery.isError}
          isOwner={isOwner}
          onRecordPayment={(m) => setRecordPaymentFor(m)}
          onExportPdf={() => void handlePdfExport()}
          isPdfExporting={isPdfExporting}
          allData={allQuery.data}
        />
      ) : (
        <StatementsView
          data={allQuery.data}
          isLoading={allQuery.isLoading}
          isError={allQuery.isError}
          isOwner={isOwner}
          onRecordPayment={(m) => setRecordPaymentFor(m)}
          onExportPdf={(m) => void handlePdfExport(m)}
        />
      )}

      {/* Record Payment Dialog */}
      <RecordPaymentDialog
        month={recordPaymentFor}
        payable={payableForModal}
        open={recordPaymentFor !== null}
        onClose={() => setRecordPaymentFor(null)}
        onSuccess={() => {
          void queryClient.invalidateQueries({ queryKey: ["cmc-monthly-sales"] });
        }}
      />
    </div>
  );
}

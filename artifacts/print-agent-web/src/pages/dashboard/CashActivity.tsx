/**
 * Cash Activity page — Finance & Accounting.
 *
 * URL filter params: ?month=YYYY-MM, ?entity=<id>, ?location=<id>,
 *                   ?drawer=<id>, ?currency=<code>
 *
 * API contract (all params use camelCase server names):
 *   GET /api/cash-activity/summary          { summary: CashActivitySummary }
 *   GET /api/cash-activity/chart            { series: DailyChartPoint[] }
 *   GET /api/cash-activity/transactions     { rows, total, page, pageSize, totalPages }
 *   GET /api/cash-activity/months/:ym/status { status: "OPEN"|"FINALIZED", canFinalize, blockers }
 *   POST /api/cash-activity/match           { transactionIds, yearMonth, note? }
 *   DELETE /api/cash-activity/match/:groupId { reason }
 */
import { useState, useCallback, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { useSearch, useLocation } from "wouter";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ComposedChart,
  Bar,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ResponsiveContainer,
} from "recharts";
import {
  Download,
  AlertCircle,
  ChevronDown,
  ChevronUp,
  Search,
  MoreHorizontal,
  ExternalLink,
  CheckCircle2,
  AlertTriangle,
  Eye,
  Edit3,
  Copy,
  XCircle,
  Trash2,
  ChevronLeft,
  ChevronRight,
  Lock,
  RotateCcw,
  Info,
  X,
  Link2Off,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Checkbox } from "@/components/ui/checkbox";
import { Spinner } from "@/components/ui/spinner";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
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
import {
  Tooltip as UITooltip,
  TooltipContent as UITooltipContent,
  TooltipProvider as UITooltipProvider,
  TooltipTrigger as UITooltipTrigger,
} from "@/components/ui/tooltip";
import { formatCashMoney, decimalPlaces } from "@/lib/cashMoney";
import { useToast } from "@/hooks/use-toast";
import { useWorkspaceRole } from "@/hooks/use-workspace-role";
import {
  FinalizeMonthModal,
  ReopenMonthModal,
} from "./CashActivityFinalization";

// ─── Types matching the real API response shapes ──────────────────────────────

interface CashActivitySummary {
  cashSalesTotal: string;
  refundsTotal: string;
  cashExpensesTotal: string;
  netCashActivity: string;
  needsReviewCount: number;
  totalTransactions: number;
  expectedCash: string;
  deposited: string;
  transferred: string;
  cashPositionDifference: string;
  balanced: boolean;
}

interface DailyChartPoint {
  date: string;
  cashIn: string;
  cashOut: string;
  net: string;
}

interface TransactionRow {
  id: number;
  transactionDate: string;
  type: string;
  direction: string;
  referenceId: string | null;
  description: string | null;
  entityId: number | null;
  entityName: string | null;
  locationId: number | null;
  locationName: string | null;
  drawerId: number | null;
  drawerName: string | null;
  expenseCategory: string | null;
  currency: string;
  amount: string;
  cashIn: string | null;
  cashOut: string | null;
  hasReceipt: boolean;
  attachmentUrl: string | null;
  status: string;
  approvalStatus: string;
  isReversed: boolean;
  matchGroupId: number | null;
  matchedBy: string | null;
  matchedAt: string | null;
  saleChannel: string | null;
}

interface MonthStatus {
  yearMonth: string;
  status: "OPEN" | "FINALIZED";
  canFinalize: boolean;
  blockers: string[];
  finalizedBy: string | null;
  finalizedAt: string | null;
}

// Tab values as they appear in the UI (internal) vs API
type TabKey = "unmatched" | "matched" | "needs_review";
const TAB_TO_API: Record<TabKey, string> = {
  unmatched: "unmatched",
  matched: "matched",
  needs_review: "needs-review",
};

// ─── URL filter state ──────────────────────────────────────────────────────────

interface FilterState {
  month: string;
  entity: string;
  location: string;
  drawer: string;
  currency: string;
}

function useFilterState() {
  const search = useSearch();
  const [, navigate] = useLocation();

  const params = new URLSearchParams(search);
  const filters: FilterState = {
    month: params.get("month") ?? defaultYearMonth(),
    entity: params.get("entity") ?? "",
    location: params.get("location") ?? "",
    drawer: params.get("drawer") ?? "",
    currency: params.get("currency") ?? "",
  };

  const setFilter = useCallback(
    (key: keyof FilterState, value: string) => {
      const next = new URLSearchParams(search);
      if (value) {
        next.set(key, value);
      } else {
        next.delete(key);
      }
      // Preserve the current path
      const currentPath =
        window.location.pathname.replace(/^\/finance\/accounting\/cash-activity/, "") || "";
      navigate(
        `/finance/accounting/cash-activity${currentPath}?${next.toString()}`,
        { replace: true },
      );
    },
    [search, navigate],
  );

  /** Maps the human-readable URL params to the API's camelCase query params. */
  const apiParams = {
    yearMonth: filters.month,
    entityId: filters.entity || undefined,
    locationId: filters.location || undefined,
    drawerId: filters.drawer || undefined,
    currency: filters.currency || undefined,
  };

  return { filters, setFilter, apiParams };
}

function defaultYearMonth(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
}

function formatYearMonthLabel(ym: string): string {
  if (!ym || !/^\d{4}-\d{2}$/.test(ym)) return ym;
  const [y, m] = ym.split("-").map(Number);
  return new Date(y, m - 1, 1).toLocaleString("default", { month: "long", year: "numeric" });
}

// ─── Data hooks ────────────────────────────────────────────────────────────────

function buildQS(obj: Record<string, string | number | undefined>): string {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined && v !== null && v !== "") p.set(k, String(v));
  }
  return p.toString() ? `?${p.toString()}` : "";
}

function useMonthStatus(yearMonth: string, entityId?: string) {
  return useQuery<MonthStatus>({
    queryKey: ["cash-activity-month-status", yearMonth, entityId],
    queryFn: async () => {
      const qs = buildQS({ entityId });
      const res = await fetch(`/api/cash-activity/months/${yearMonth}/status${qs}`, {
        credentials: "include",
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    },
    enabled: !!yearMonth,
  });
}

function useSummary(apiParams: ReturnType<typeof useFilterState>["apiParams"]) {
  return useQuery<{ summary: CashActivitySummary }>({
    queryKey: ["cash-activity-summary", apiParams],
    queryFn: async () => {
      const qs = buildQS(apiParams as Record<string, string | undefined>);
      const res = await fetch(`/api/cash-activity/summary${qs}`, { credentials: "include" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    },
    enabled: !!apiParams.yearMonth,
  });
}

function useChart(apiParams: ReturnType<typeof useFilterState>["apiParams"]) {
  return useQuery<{ series: DailyChartPoint[] }>({
    queryKey: ["cash-activity-chart", apiParams],
    queryFn: async () => {
      const qs = buildQS(apiParams as Record<string, string | undefined>);
      const res = await fetch(`/api/cash-activity/chart${qs}`, { credentials: "include" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    },
    enabled: !!apiParams.yearMonth,
  });
}

function useTransactions(
  apiParams: ReturnType<typeof useFilterState>["apiParams"],
  tab: TabKey,
  search: string,
  typeFilter: string,
  page: number,
  pageSize = 20,
) {
  return useQuery<{ rows: TransactionRow[]; total: number; page: number; pageSize: number; totalPages: number }>({
    queryKey: ["cash-activity-transactions", apiParams, tab, search, typeFilter, page, pageSize],
    queryFn: async () => {
      const qs = buildQS({
        ...(apiParams as Record<string, string | undefined>),
        tab: TAB_TO_API[tab],
        search: search || undefined,
        type: typeFilter || undefined,
        page,
        pageSize,
      });
      const res = await fetch(`/api/cash-activity/transactions${qs}`, { credentials: "include" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    },
    enabled: !!apiParams.yearMonth,
  });
}

interface ValidationResult {
  valid: boolean;
  reason?: string;
  shortfall?: number;
  direction?: "need-cash-in" | "need-cash-out";
}
interface CashActivityFiltersProps {
  filters: FilterState;
  setFilter: (key: keyof FilterState, value: string) => void;
}

function CashActivityFilters({ filters, setFilter }: CashActivityFiltersProps) {
  const { t } = useTranslation();

  const { data: locationsData } = useQuery<{ locations: { id: number; name: string }[] }>({
    queryKey: ["locations-list"],
    queryFn: async () => {
      const res = await fetch("/api/locations", { credentials: "include" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    },
  });

  const { data: entitiesData } = useQuery<{ entities: { id: number; name: string }[] }>({
    queryKey: ["accounting-entities"],
    queryFn: async () => {
      const res = await fetch("/api/accounting/entities", { credentials: "include" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    },
  });

  const { data: drawersData } = useQuery<{ drawers: { id: number; name: string }[] }>({
    queryKey: ["cash-drawers-list"],
    queryFn: async () => {
      const res = await fetch("/api/cash-drawers", { credentials: "include" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    },
  });

  // Build month options: current month + 11 previous months
  const monthOptions: { value: string; label: string }[] = [];
  const now = new Date();
  for (let i = 0; i < 12; i++) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    const value = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
    monthOptions.push({ value, label: formatYearMonthLabel(value) });
  }

  const CURRENCIES = ["AED", "USD", "EUR", "GBP", "LBP"];

  return (
    <div className="flex flex-wrap gap-2">
      {/* Month */}
      <Select value={filters.month} onValueChange={(v) => setFilter("month", v)}>
        <SelectTrigger className="h-8 text-xs w-40">
          <SelectValue placeholder="Month" />
        </SelectTrigger>
        <SelectContent>
          {monthOptions.map((o) => (
            <SelectItem key={o.value} value={o.value} className="text-xs">
              {o.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      {/* Entity */}
      <Select
        value={filters.entity || "__all__"}
        onValueChange={(v) => setFilter("entity", v === "__all__" ? "" : v)}
      >
        <SelectTrigger className="h-8 text-xs w-40">
          <SelectValue placeholder={t("cashActivity.filter.allEntities")} />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="__all__" className="text-xs">
            {t("cashActivity.filter.allEntities")}
          </SelectItem>
          {entitiesData?.entities?.map((e) => (
            <SelectItem key={e.id} value={String(e.id)} className="text-xs">
              {e.name}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      {/* Location */}
      <Select
        value={filters.location || "__all__"}
        onValueChange={(v) => setFilter("location", v === "__all__" ? "" : v)}
      >
        <SelectTrigger className="h-8 text-xs w-40">
          <SelectValue placeholder={t("cashActivity.filter.allLocations")} />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="__all__" className="text-xs">
            {t("cashActivity.filter.allLocations")}
          </SelectItem>
          {locationsData?.locations?.map((l) => (
            <SelectItem key={l.id} value={String(l.id)} className="text-xs">
              {l.name}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      {/* Drawer */}
      <Select
        value={filters.drawer || "__all__"}
        onValueChange={(v) => setFilter("drawer", v === "__all__" ? "" : v)}
      >
        <SelectTrigger className="h-8 text-xs w-40">
          <SelectValue placeholder={t("cashActivity.filter.allDrawers")} />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="__all__" className="text-xs">
            {t("cashActivity.filter.allDrawers")}
          </SelectItem>
          {drawersData?.drawers?.map((d) => (
            <SelectItem key={d.id} value={String(d.id)} className="text-xs">
              {d.name}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      {/* Currency */}
      <Select
        value={filters.currency || "__all__"}
        onValueChange={(v) => setFilter("currency", v === "__all__" ? "" : v)}
      >
        <SelectTrigger className="h-8 text-xs w-32">
          <SelectValue placeholder={t("cashActivity.filter.allCurrencies")} />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="__all__" className="text-xs">
            {t("cashActivity.filter.allCurrencies")}
          </SelectItem>
          {CURRENCIES.map((c) => (
            <SelectItem key={c} value={c} className="text-xs">
              {c}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

// ─── Summary cards ─────────────────────────────────────────────────────────────

interface SummaryCardsProps {
  summary: CashActivitySummary | undefined;
  loading: boolean;
  currency: string;
}

function SummaryCards({ summary, loading, currency }: SummaryCardsProps) {
  const { t } = useTranslation();
  const cur = currency || "AED";

  const cards = [
    {
      label: t("cashActivity.summary.cashSales"),
      value: summary ? formatCashMoney(parseFloat(summary.cashSalesTotal), cur) : "—",
    },
    {
      label: t("cashActivity.summary.refunds"),
      value: summary ? formatCashMoney(parseFloat(summary.refundsTotal), cur) : "—",
    },
    {
      label: t("cashActivity.summary.cashExpenses"),
      value: summary ? formatCashMoney(parseFloat(summary.cashExpensesTotal), cur) : "—",
    },
    {
      label: t("cashActivity.summary.netCashActivity"),
      value: summary ? formatCashMoney(parseFloat(summary.netCashActivity), cur) : "—",
      highlight: true,
    },
    {
      label: t("cashActivity.summary.needsReview"),
      value: summary ? String(summary.needsReviewCount) : "—",
      isCount: true,
    },
  ];

  return (
    <div className="flex flex-wrap gap-3">
      {cards.map((card) => (
        <div
          key={card.label}
          className="flex-1 min-w-[160px] rounded-lg border bg-card p-4"
        >
          {loading ? (
            <>
              <Skeleton className="h-3 w-20 mb-2" />
              <Skeleton className="h-6 w-28" />
            </>
          ) : (
            <>
              <p className="text-xs text-muted-foreground mb-1">{card.label}</p>
              <p
                className={`text-lg font-semibold tabular-nums ${
                  card.isCount && summary && summary.needsReviewCount > 0
                    ? "text-amber-600"
                    : card.highlight
                      ? "text-foreground"
                      : "text-foreground"
                }`}
              >
                {card.value}
              </p>
            </>
          )}
        </div>
      ))}
    </div>
  );
}

// ─── Chart ─────────────────────────────────────────────────────────────────────

interface ChartProps {
  series: DailyChartPoint[] | undefined;
  loading: boolean;
}

function CashInOutChart({ series, loading }: ChartProps) {
  const { t } = useTranslation();
  const [grouping, setGrouping] = useState<"daily" | "weekly">("daily");

  // Aggregate weekly when requested
  const chartData = (() => {
    if (!series) return [];
    if (grouping === "daily") {
      return series.map((p) => ({
        label: p.date.slice(5), // MM-DD
        cashIn: parseFloat(p.cashIn),
        cashOut: parseFloat(p.cashOut),
        net: parseFloat(p.net),
      }));
    }
    // Weekly: group by ISO week
    const byWeek: Record<string, { cashIn: number; cashOut: number; net: number; first: string }> =
      {};
    for (const p of series) {
      const d = new Date(p.date);
      const week = `W${Math.ceil(d.getDate() / 7)}`;
      const key = `${p.date.slice(0, 7)}-${week}`;
      if (!byWeek[key]) byWeek[key] = { cashIn: 0, cashOut: 0, net: 0, first: p.date };
      byWeek[key].cashIn += parseFloat(p.cashIn);
      byWeek[key].cashOut += parseFloat(p.cashOut);
      byWeek[key].net += parseFloat(p.net);
    }
    return Object.entries(byWeek).map(([k, v]) => ({
      label: k.slice(-3),
      cashIn: v.cashIn,
      cashOut: v.cashOut,
      net: v.net,
    }));
  })();

  return (
    <div className="rounded-lg border bg-card p-4 flex-1 min-w-0">
      <div className="flex items-center justify-between mb-4">
        <h3 className="text-sm font-medium">{t("cashActivity.chart.title")}</h3>
        <div className="flex rounded-md border overflow-hidden">
          {(["daily", "weekly"] as const).map((g) => (
            <button
              key={g}
              className={`px-3 py-1 text-xs ${
                grouping === g
                  ? "bg-primary text-primary-foreground"
                  : "bg-background text-muted-foreground hover:bg-muted"
              }`}
              onClick={() => setGrouping(g)}
            >
              {t(`cashActivity.chart.${g}`)}
            </button>
          ))}
        </div>
      </div>
      {loading ? (
        <Skeleton className="h-48 w-full" />
      ) : chartData.length === 0 ? (
        <div className="h-48 flex items-center justify-center text-sm text-muted-foreground">
          {t("cashActivity.chart.empty")}
        </div>
      ) : (
        <ResponsiveContainer width="100%" height={200}>
          <ComposedChart data={chartData} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
            <XAxis
              dataKey="label"
              tick={{ fontSize: 10 }}
              tickLine={false}
              axisLine={false}
            />
            <YAxis tick={{ fontSize: 10 }} tickLine={false} axisLine={false} width={48} />
            <Tooltip
              contentStyle={{
                fontSize: 11,
                borderRadius: 6,
                border: "1px solid hsl(var(--border))",
                background: "hsl(var(--card))",
                color: "hsl(var(--foreground))",
              }}
            />
            <Legend
              wrapperStyle={{ fontSize: 11, paddingTop: 8 }}
              formatter={(value: string) =>
                t(`cashActivity.chart.legend.${value}`, { defaultValue: value })
              }
            />
            <Bar dataKey="cashIn" name="cashIn" fill="hsl(174, 72%, 40%)" radius={[3, 3, 0, 0]} />
            <Bar
              dataKey="cashOut"
              name="cashOut"
              fill="hsl(0, 72%, 51%)"
              radius={[3, 3, 0, 0]}
            />
            <Line
              type="monotone"
              dataKey="net"
              name="net"
              stroke="hsl(var(--primary))"
              dot={false}
              strokeWidth={1.5}
            />
          </ComposedChart>
        </ResponsiveContainer>
      )}
    </div>
  );
}

// ─── Cash position card ────────────────────────────────────────────────────────

interface CashPositionCardProps {
  summary: CashActivitySummary | undefined;
  loading: boolean;
  currency: string;
}

function CashPositionCard({ summary, loading, currency }: CashPositionCardProps) {
  const { t } = useTranslation();
  const cur = currency || "AED";

  return (
    <div className="rounded-lg border bg-card p-4 w-64 shrink-0">
      <div className="flex items-center justify-between mb-4">
        <h3 className="text-sm font-medium">{t("cashActivity.position.title")}</h3>
        {!loading && summary && (
          <Badge
            className={`text-xs ${
              summary.balanced
                ? "bg-green-100 text-green-700 border-green-200"
                : "bg-amber-100 text-amber-700 border-amber-200"
            }`}
          >
            {summary.balanced
              ? t("cashActivity.position.balanced")
              : t("cashActivity.position.attention")}
          </Badge>
        )}
      </div>
      {loading ? (
        <div className="space-y-3">
          {[...Array(4)].map((_, i) => (
            <div key={i} className="flex justify-between">
              <Skeleton className="h-3 w-24" />
              <Skeleton className="h-3 w-16" />
            </div>
          ))}
        </div>
      ) : !summary ? (
        <p className="text-xs text-muted-foreground">{t("cashActivity.position.empty")}</p>
      ) : (
        <div className="space-y-3 text-xs">
          {[
            { label: t("cashActivity.position.expected"), value: summary.expectedCash },
            { label: t("cashActivity.position.deposited"), value: summary.deposited },
            { label: t("cashActivity.position.transferred"), value: summary.transferred },
            {
              label: t("cashActivity.position.difference"),
              value: summary.cashPositionDifference,
              highlight: true,
            },
          ].map(({ label, value, highlight }) => (
            <div key={label} className="flex justify-between">
              <span className="text-muted-foreground">{label}</span>
              <span
                className={`tabular-nums font-medium ${
                  highlight && !summary.balanced ? "text-amber-600" : ""
                }`}
              >
                {formatCashMoney(parseFloat(value), cur)}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

interface CashSelectionBarProps {
  selected: Map<number, TransactionRow>;
  monthStatus: MonthStatus | undefined;
  selectedMonth: string;
  onClear: () => void;
  onMatchClick: () => void;
}
interface CashActivityTableProps {
  apiParams: ReturnType<typeof useFilterState>["apiParams"];
  needsReviewCount: number;
  isFinalized?: boolean;
  isFinanceAdmin?: boolean;
  onReopenClick?: () => void;
  monthStatus: MonthStatus | undefined;
  selectedMonth: string;
}

function CashActivityTable({
  apiParams,
  needsReviewCount,
  isFinalized = false,
  isFinanceAdmin = false,
  onReopenClick,
  monthStatus,
  selectedMonth,
}: CashActivityTableProps) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();

  const [tab, setTab] = useState<TabKey>("unmatched");
  const [search, setSearch] = useState("");
  const [typeFilter, setTypeFilter] = useState("");
  const [page, setPage] = useState(1);

  // Cross-page selection: Map<id, row>
  const [selected, setSelected] = useState<Map<number, TransactionRow>>(new Map());
  const [matchDialogOpen, setMatchDialogOpen] = useState(false);
  const [unmatchGroupId, setUnmatchGroupId] = useState<number | null>(null);

  const isMonthOpen = monthStatus?.status === "OPEN";

  const { data, isLoading, error } = useTransactions(
    apiParams,
    tab,
    search,
    typeFilter,
    page,
  );

  const tabs: { key: TabKey; label: string; count?: number }[] = [
    { key: "unmatched", label: t("cashActivity.table.tabs.unmatched") },
    { key: "matched", label: t("cashActivity.table.tabs.matched") },
    {
      key: "needs_review",
      label: t("cashActivity.table.tabs.needsReview"),
      count: needsReviewCount,
    },
  ];

  function handleTabChange(key: TabKey) {
    setTab(key);
    setPage(1);
    // Clear selection when switching tabs
    setSelected(new Map());
  }

  // Reset selection when filters change
  const filterKey = JSON.stringify(apiParams);
  // Use a ref to detect filter changes without adding hooks
  const [prevFilterKey, setPrevFilterKey] = useState(filterKey);
  if (filterKey !== prevFilterKey) {
    setPrevFilterKey(filterKey);
    setSelected(new Map());
  }

  const rows = data?.rows ?? [];
  const total = data?.total ?? 0;
  const totalPages = data?.totalPages ?? 1;
  const start = total === 0 ? 0 : (page - 1) * (data?.pageSize ?? 20) + 1;
  const end = Math.min(page * (data?.pageSize ?? 20), total);

  // Checkbox helpers
  const currentPageIds = rows.map((r) => r.id);
  const allOnPageSelected =
    currentPageIds.length > 0 && currentPageIds.every((id) => selected.has(id));
  const someOnPageSelected = currentPageIds.some((id) => selected.has(id));

  function toggleRow(row: TransactionRow) {
    setSelected((prev) => {
      const next = new Map(prev);
      if (next.has(row.id)) next.delete(row.id);
      else next.set(row.id, row);
      return next;
    });
  }

  function toggleAll() {
    if (allOnPageSelected) {
      // Deselect all on page
      setSelected((prev) => {
        const next = new Map(prev);
        for (const id of currentPageIds) next.delete(id);
        return next;
      });
    } else {
      // Select all on page
      setSelected((prev) => {
        const next = new Map(prev);
        for (const row of rows) next.set(row.id, row);
        return next;
      });
    }
  }

  function clearSelection() {
    setSelected(new Map());
  }

  function handleMatchSuccess() {
    clearSelection();
    setMatchDialogOpen(false);
    queryClient.invalidateQueries({ queryKey: ["cash-activity-transactions"] });
    queryClient.invalidateQueries({ queryKey: ["cash-activity-summary"] });
    queryClient.invalidateQueries({ queryKey: ["cash-activity-month-status"] });
  }

  function handleUnmatchSuccess() {
    setUnmatchGroupId(null);
    queryClient.invalidateQueries({ queryKey: ["cash-activity-transactions"] });
    queryClient.invalidateQueries({ queryKey: ["cash-activity-summary"] });
    queryClient.invalidateQueries({ queryKey: ["cash-activity-month-status"] });
  }

  // Column definitions for unmatched tab (with checkbox col)
  const UNMATCHED_COLS = [
    "datetime",
    "type",
    "reference",
    "location",
    "category",
    "cashIn",
    "cashOut",
    "taxTreatment",
    "evidence",
    "status",
    "",
  ];

  return (
    <>
      <div className="rounded-lg border bg-card" style={{ paddingBottom: selected.size > 0 ? "64px" : 0 }}>
        {/* Locked month banner */}
        {isFinalized && (
          <div className="flex items-center justify-between gap-3 px-4 py-3 bg-sky-50 border-b border-sky-200">
            <div className="flex items-center gap-2 text-sm text-sky-800">
              <Lock className="w-4 h-4 shrink-0" />
              {t("cashActivity.lockedBanner")}
            </div>
            {isFinanceAdmin && onReopenClick && (
              <button
                onClick={onReopenClick}
                className="text-xs font-medium text-sky-700 hover:text-sky-900 underline underline-offset-2"
              >
                {t("cashActivity.reopenOption")}
              </button>
            )}
          </div>
        )}

        {/* Tab bar */}
        <div className="flex items-center border-b px-4 gap-1">
          {tabs.map((tb) => (
            <button
              key={tb.key}
              onClick={() => handleTabChange(tb.key)}
              className={`flex items-center gap-1.5 py-3 px-3 text-xs font-medium border-b-2 transition-colors ${
                tab === tb.key
                  ? "border-primary text-primary"
                  : "border-transparent text-muted-foreground hover:text-foreground"
              }`}
            >
              {tb.label}
              {tb.count != null && tb.count > 0 && (
                <span className="inline-flex items-center justify-center rounded-full bg-amber-100 text-amber-700 text-[10px] px-1.5 min-w-[18px] h-[18px]">
                  {tb.count}
                </span>
              )}
            </button>
          ))}
        </div>

        {/* Toolbar */}
        <div className="flex items-center gap-2 p-3 border-b">
          <div className="relative flex-1 max-w-xs">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground w-3.5 h-3.5" />
            <Input
              placeholder={t("cashActivity.table.searchPlaceholder")}
              className="h-8 pl-8 text-xs"
              value={search}
              onChange={(e) => { setSearch(e.target.value); setPage(1); }}
            />
          </div>

          {/* Type filter */}
          <Select
            value={typeFilter || "__all__"}
            onValueChange={(v) => { setTypeFilter(v === "__all__" ? "" : v); setPage(1); }}
          >
            <SelectTrigger className="h-8 text-xs w-32">
              <SelectValue placeholder={t("cashActivity.filter.allTypes")} />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="__all__" className="text-xs">
                {t("cashActivity.filter.allTypes")}
              </SelectItem>
              <SelectItem value="sale" className="text-xs">
                {t("cashActivity.table.typeSale")}
              </SelectItem>
              <SelectItem value="expense" className="text-xs">
                {t("cashActivity.table.typeExpense")}
              </SelectItem>
            </SelectContent>
          </Select>

          {/* Selection count chip */}
          {selected.size > 0 && (
            <span className="text-xs text-muted-foreground">
              {t("cashActivity.match.barSelected", { count: selected.size })}
            </span>
          )}
        </div>

        {/* Error banner */}
        {error && (
          <div className="flex items-center gap-2 px-4 py-3 bg-destructive/10 text-destructive text-xs border-b">
            <AlertCircle className="w-3.5 h-3.5 shrink-0" />
            {t("cashActivity.error.transactionsLoad")}
          </div>
        )}

        {/* Matched tab: grouped view */}
        {tab === "matched" && (
          <MatchedGroupTable
            rows={rows}
            isLoading={isLoading}
            isMonthOpen={isMonthOpen}
            isFinanceAdmin={isFinanceAdmin}
            onUnmatch={(groupId) => setUnmatchGroupId(groupId)}
          />
        )}

        {/* Unmatched / Needs Review: flat table with checkboxes on unmatched */}
        {tab !== "matched" && (
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  {/* Checkbox column header — only for unmatched when month is open */}
                  {tab === "unmatched" && isMonthOpen && (
                    <TableHead className="text-xs font-medium h-9 w-10">
                      <Checkbox
                        checked={allOnPageSelected ? true : someOnPageSelected ? "indeterminate" : false}
                        onCheckedChange={toggleAll}
                        aria-label="Select all on page"
                      />
                    </TableHead>
                  )}
                  {UNMATCHED_COLS.map((col) => (
                    <TableHead key={col} className="text-xs font-medium h-9 whitespace-nowrap">
                      {col ? t(`cashActivity.table.col.${col}`) : ""}
                    </TableHead>
                  ))}
                </TableRow>
              </TableHeader>
              <TableBody>
                {isLoading ? (
                  [...Array(5)].map((_, i) => (
                    <TableRow key={i}>
                      {tab === "unmatched" && isMonthOpen && (
                        <TableCell>
                          <Skeleton className="h-3 w-4" />
                        </TableCell>
                      )}
                      {[...Array(11)].map((__, j) => (
                        <TableCell key={j}>
                          <Skeleton className="h-3 w-full" />
                        </TableCell>
                      ))}
                    </TableRow>
                  ))
                ) : rows.length === 0 ? (
                  <TableRow>
                    <TableCell
                      colSpan={tab === "unmatched" && isMonthOpen ? 12 : 11}
                      className="h-32 text-center text-sm text-muted-foreground"
                    >
                      {t("cashActivity.table.empty")}
                    </TableCell>
                  </TableRow>
                ) : (
                  rows.map((row) => (
                    <TableRow
                      key={row.id}
                      className={`text-xs ${
                        tab === "unmatched" && isMonthOpen && selected.has(row.id)
                          ? "bg-primary/5"
                          : ""
                      }`}
                    >
                      {/* Row checkbox */}
                      {tab === "unmatched" && isMonthOpen && (
                        <TableCell className="w-10">
                          <Checkbox
                            checked={selected.has(row.id)}
                            onCheckedChange={() => toggleRow(row)}
                            aria-label={`Select transaction ${row.id}`}
                          />
                        </TableCell>
                      )}

                      {/* Date/time */}
                      <TableCell className="whitespace-nowrap text-muted-foreground">
                        {new Date(row.transactionDate).toLocaleString("default", {
                          day: "2-digit",
                          month: "short",
                          hour: "2-digit",
                          minute: "2-digit",
                        })}
                      </TableCell>

                      {/* Type badge */}
                      <TableCell>
                        <Badge
                          className={`text-[10px] ${
                            row.type === "expense"
                              ? "bg-orange-100 text-orange-700 border-orange-200"
                              : "bg-teal-100 text-teal-700 border-teal-200"
                          }`}
                        >
                          {row.type === "expense"
                            ? t("cashActivity.table.typeExpense")
                            : t("cashActivity.table.typeSale")}
                        </Badge>
                      </TableCell>

                      {/* Reference */}
                      <TableCell>
                        {row.referenceId ? (
                          <button className="text-primary hover:underline flex items-center gap-1">
                            {row.referenceId}
                            <ExternalLink className="w-2.5 h-2.5" />
                          </button>
                        ) : (
                          <span className="text-muted-foreground">
                            {row.description ?? "—"}
                          </span>
                        )}
                      </TableCell>

                      {/* Location */}
                      <TableCell className="text-muted-foreground">
                        {row.locationName ?? "—"}
                      </TableCell>

                      {/* Category */}
                      <TableCell className="text-muted-foreground">
                        {row.expenseCategory ?? "—"}
                      </TableCell>

                      {/* Cash In */}
                      <TableCell className="tabular-nums text-teal-700 font-medium">
                        {row.cashIn
                          ? formatCashMoney(parseFloat(row.cashIn), row.currency)
                          : "—"}
                      </TableCell>

                      {/* Cash Out */}
                      <TableCell className="tabular-nums text-red-700 font-medium">
                        {row.cashOut
                          ? formatCashMoney(parseFloat(row.cashOut), row.currency)
                          : "—"}
                      </TableCell>

                      {/* Tax treatment */}
                      <TableCell className="text-muted-foreground">—</TableCell>

                      {/* Evidence */}
                      <TableCell>
                        {row.attachmentUrl ? (
                          <a
                            href={row.attachmentUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-primary hover:underline text-[10px] flex items-center gap-1"
                          >
                            {t("cashActivity.table.evidenceView")}
                            <ExternalLink className="w-2.5 h-2.5" />
                          </a>
                        ) : row.hasReceipt ? (
                          <span className="text-[10px] text-teal-700 flex items-center gap-1">
                            <CheckCircle2 className="w-3 h-3" />
                            {t("cashActivity.table.evidenceView")}
                          </span>
                        ) : (
                          <Badge className="text-[10px] bg-amber-100 text-amber-700 border-amber-200">
                            {t("cashActivity.table.evidenceMissing")}
                          </Badge>
                        )}
                      </TableCell>

                      {/* Status */}
                      <TableCell>
                        <span className="text-[10px] text-muted-foreground capitalize">
                          {row.matchGroupId
                            ? t("cashActivity.table.status.matched")
                            : row.approvalStatus === "pending"
                              ? t("cashActivity.table.status.needs_review")
                              : t("cashActivity.table.status.unmatched")}
                        </span>
                      </TableCell>

                      {/* Row actions */}
                      <TableCell>
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <Button variant="ghost" size="sm" className="h-7 w-7 p-0">
                              <MoreHorizontal className="w-3.5 h-3.5" />
                            </Button>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end" className="text-xs">
                            <DropdownMenuItem className="gap-2 text-xs">
                              <Eye className="w-3 h-3" />
                              {t("cashActivity.table.actions.viewDetails")}
                            </DropdownMenuItem>
                            <DropdownMenuItem className="gap-2 text-xs">
                              <Edit3 className="w-3 h-3" />
                              {t("cashActivity.table.actions.editTransaction")}
                            </DropdownMenuItem>
                            <DropdownMenuItem className="gap-2 text-xs">
                              <Copy className="w-3 h-3" />
                              {t("cashActivity.table.actions.markDuplicate")}
                            </DropdownMenuItem>
                            <DropdownMenuItem className="gap-2 text-xs">
                              <XCircle className="w-3 h-3" />
                              {t("cashActivity.table.actions.voidTransaction")}
                            </DropdownMenuItem>
                            {row.approvalStatus === "draft" && (
                              <DropdownMenuItem className="gap-2 text-xs text-destructive">
                                <Trash2 className="w-3 h-3" />
                                {t("cashActivity.table.actions.deleteDraft")}
                              </DropdownMenuItem>
                            )}
                          </DropdownMenuContent>
                        </DropdownMenu>
                      </TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          </div>
        )}

        {/* Pagination */}
        {total > 0 && (
          <div className="flex items-center justify-between px-4 py-3 border-t text-xs text-muted-foreground">
            <span>
              {t("cashActivity.table.showing", { start, end, total })}
            </span>
            <div className="flex items-center gap-1">
              <Button
                variant="outline"
                size="sm"
                className="h-7 w-7 p-0"
                disabled={page <= 1}
                onClick={() => setPage((p) => Math.max(1, p - 1))}
              >
                <ChevronLeft className="w-3.5 h-3.5" />
              </Button>
              <span className="px-2">
                {t("cashActivity.table.pageOf", { page, total: totalPages })}
              </span>
              <Button
                variant="outline"
                size="sm"
                className="h-7 w-7 p-0"
                disabled={page >= totalPages}
                onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
              >
                <ChevronRight className="w-3.5 h-3.5" />
              </Button>
            </div>
          </div>
        )}
      </div>

      {/* Selection bar — only on unmatched tab with an open month */}
      {tab === "unmatched" && isMonthOpen && selected.size > 0 && (
        <CashSelectionBar
          selected={selected}
          monthStatus={monthStatus}
          selectedMonth={selectedMonth}
          onClear={clearSelection}
          onMatchClick={() => setMatchDialogOpen(true)}
        />
      )}

      {/* Match & Clear dialog */}
      <MatchClearDialog
        open={matchDialogOpen}
        onOpenChange={setMatchDialogOpen}
        selected={selected}
        monthStatus={monthStatus}
        selectedMonth={selectedMonth}
        onSuccess={handleMatchSuccess}
      />

      {/* Unmatch dialog */}
      <UnmatchGroupDialog
        open={unmatchGroupId !== null}
        onOpenChange={(v) => { if (!v) setUnmatchGroupId(null); }}
        groupId={unmatchGroupId}
        onSuccess={handleUnmatchSuccess}
      />
    </>
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function CashActivity() {
  const { t } = useTranslation();
  const { filters, setFilter, apiParams } = useFilterState();
  const queryClient = useQueryClient();

  const statusQuery = useMonthStatus(filters.month, filters.entity || undefined);
  const summaryQuery = useSummary(apiParams);
  const chartQuery = useChart(apiParams);

  const { isOwner } = useWorkspaceRole();
  // Finance Admin = workspace owner (full access). Non-admin finance users can
  // view but cannot initiate finalization or reopen.
  const isFinanceAdmin = isOwner;

  const monthStatus = statusQuery.data;
  const summary = summaryQuery.data?.summary;
  const series = chartQuery.data?.series;

  const isFinalized = monthStatus?.status === "FINALIZED";
  const monthLabel = formatYearMonthLabel(filters.month);

  const [finalizeOpen, setFinalizeOpen] = useState(false);
  const [reopenOpen, setReopenOpen] = useState(false);

  function handleFinalizeSuccess() {
    queryClient.invalidateQueries({ queryKey: ["cash-activity-month-status"] });
    queryClient.invalidateQueries({ queryKey: ["cash-activity-summary"] });
    queryClient.invalidateQueries({ queryKey: ["cash-activity-transactions"] });
    queryClient.invalidateQueries({ queryKey: ["cash-activity-chart"] });
  }

  function handleReopenSuccess() {
    queryClient.invalidateQueries({ queryKey: ["cash-activity-month-status"] });
    queryClient.invalidateQueries({ queryKey: ["cash-activity-summary"] });
    queryClient.invalidateQueries({ queryKey: ["cash-activity-transactions"] });
    queryClient.invalidateQueries({ queryKey: ["cash-activity-chart"] });
  }

  // Format finalized-at timestamp for the tooltip
  const finalizedAtLabel = monthStatus?.finalizedAt
    ? new Date(monthStatus.finalizedAt).toLocaleString("default", {
        day: "2-digit",
        month: "short",
        year: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      })
    : null;

  return (
    <UITooltipProvider>
      <div className="flex flex-col gap-5 p-6 max-w-[1600px] mx-auto">
        {/* Header */}
        <div className="flex flex-col gap-3">
          <div className="flex flex-wrap items-center gap-3">
            <div className="flex items-center gap-2">
              <h1 className="text-xl font-semibold">{t("cashActivity.title")}</h1>
              {monthStatus && (
                isFinalized && (monthStatus.finalizedBy || finalizedAtLabel) ? (
                  <UITooltip>
                    <UITooltipTrigger asChild>
                      <Badge
                        className="text-xs bg-green-100 text-green-700 border-green-200 cursor-default select-none flex items-center gap-1"
                      >
                        {t("cashActivity.statusFinalized")}
                        <Info className="w-3 h-3 opacity-60" />
                      </Badge>
                    </UITooltipTrigger>
                    <UITooltipContent side="bottom" className="max-w-[220px] text-center leading-snug">
                      {monthStatus.finalizedBy && finalizedAtLabel
                        ? t("cashActivity.finalizedTooltip", {
                            user: monthStatus.finalizedBy,
                            date: finalizedAtLabel,
                          })
                        : finalizedAtLabel
                          ? t("cashActivity.finalizedTooltipNoUser", { date: finalizedAtLabel })
                          : t("cashActivity.statusFinalized")}
                    </UITooltipContent>
                  </UITooltip>
                ) : (
                  <Badge
                    className={`text-xs ${
                      isFinalized
                        ? "bg-green-100 text-green-700 border-green-200"
                        : "bg-sky-100 text-sky-700 border-sky-200"
                    }`}
                  >
                    {isFinalized
                      ? t("cashActivity.statusFinalized")
                      : t("cashActivity.statusOpen")}
                  </Badge>
                )
              )}
            </div>
            <div className="flex items-center gap-2 ml-auto">
              <Button variant="outline" size="sm" className="gap-1.5 h-8 text-xs" disabled>
                <Download className="w-3.5 h-3.5" />
                {t("cashActivity.actions.export")}
              </Button>
              <Button variant="outline" size="sm" className="gap-1.5 h-8 text-xs" disabled>
                <AlertTriangle className="w-3.5 h-3.5" />
                {t("cashActivity.actions.reviewExceptions")}
              </Button>

              {/* Reopen option for Finance Admins when month is finalized */}
              {isFinalized && isFinanceAdmin && (
                <Button
                  variant="outline"
                  size="sm"
                  className="gap-1.5 h-8 text-xs text-amber-700 border-amber-300 hover:bg-amber-50"
                  onClick={() => setReopenOpen(true)}
                >
                  <RotateCcw className="w-3.5 h-3.5" />
                  {t("cashActivity.reopenOption")}
                </Button>
              )}

              {/* Finalize button — Finance Admins only, hidden when already finalized */}
              {!isFinalized && isFinanceAdmin && (
                <Button
                  size="sm"
                  className="h-8 text-xs"
                  onClick={() => setFinalizeOpen(true)}
                >
                  {t("cashActivity.actions.finalize", { month: monthLabel })}
                </Button>
              )}
            </div>
          </div>

          {/* Filters */}
          <CashActivityFilters filters={filters} setFilter={setFilter} />
        </div>

        {/* Summary error */}
        {summaryQuery.error && (
          <div className="flex items-center gap-2 rounded-md px-4 py-3 bg-destructive/10 text-destructive text-xs">
            <AlertCircle className="w-3.5 h-3.5 shrink-0" />
            {t("cashActivity.error.summaryLoad")}
          </div>
        )}

        {/* Summary cards */}
        <SummaryCards
          summary={summary}
          loading={summaryQuery.isLoading}
          currency={filters.currency}
        />

        {/* Chart + position row */}
        <div className="flex flex-wrap gap-4" style={{ alignItems: "stretch" }}>
          <CashInOutChart series={series} loading={chartQuery.isLoading} />
          <CashPositionCard
            summary={summary}
            loading={summaryQuery.isLoading}
            currency={filters.currency}
          />
        </div>

        {/* Transactions table */}
        <CashActivityTable
          apiParams={apiParams}
          needsReviewCount={summary?.needsReviewCount ?? 0}
          isFinalized={isFinalized}
          isFinanceAdmin={isFinanceAdmin}
          onReopenClick={() => setReopenOpen(true)}
          monthStatus={monthStatus}
          selectedMonth={filters.month}
        />

        {/* Finalization modal */}
        {isFinanceAdmin && (
          <FinalizeMonthModal
            open={finalizeOpen}
            onOpenChange={setFinalizeOpen}
            yearMonth={filters.month}
            monthLabel={monthLabel}
            entityId={filters.entity || undefined}
            apiParams={apiParams}
            summary={summary}
            currency={filters.currency}
            onSuccess={handleFinalizeSuccess}
          />
        )}

        {/* Reopen modal */}
        {isFinanceAdmin && (
          <ReopenMonthModal
            open={reopenOpen}
            onOpenChange={setReopenOpen}
            yearMonth={filters.month}
            monthLabel={monthLabel}
            entityId={filters.entity || undefined}
            onSuccess={handleReopenSuccess}
          />
        )}
      </div>
    </UITooltipProvider>
  );
}

function CashSelectionBar({
  selected,
  monthStatus,
  selectedMonth,
  onClear,
  onMatchClick,
}: CashSelectionBarProps) {
  const { t } = useTranslation();

  const rows = useMemo(() => Array.from(selected.values()), [selected]);
  const count = rows.length;

  const currency = rows[0]?.currency ?? "AED";

  const totalIn = rows.reduce((sum, r) => sum + (r.cashIn ? parseFloat(r.cashIn) : 0), 0);
  const totalOut = rows.reduce((sum, r) => sum + (r.cashOut ? parseFloat(r.cashOut) : 0), 0);
  const difference = totalIn - totalOut;

  const validation = useMemo(
    () => validateMatchSelection(rows, monthStatus, selectedMonth),
    [rows, monthStatus, selectedMonth],
  );

  if (count === 0) return null;

  const diffColor =
    Math.abs(difference) < 0.001
      ? "text-teal-700"
      : "text-amber-600";

  return (
    <div className="fixed bottom-0 left-0 right-0 z-40 border-t bg-card shadow-lg">
      <div className="max-w-[1600px] mx-auto flex flex-wrap items-center gap-4 px-6 py-3">
        {/* Count */}
        <span className="text-sm font-medium text-foreground">
          {t("cashActivity.match.barSelected", { count })}
        </span>

        <div className="h-4 w-px bg-border" />

        {/* Totals */}
        <div className="flex items-center gap-4 text-xs">
          <div>
            <span className="text-muted-foreground mr-1">{t("cashActivity.match.barCashIn")}</span>
            <span className="font-medium tabular-nums text-teal-700">
              {formatCashMoney(totalIn, currency)}
            </span>
          </div>
          <div>
            <span className="text-muted-foreground mr-1">{t("cashActivity.match.barCashOut")}</span>
            <span className="font-medium tabular-nums text-red-700">
              {formatCashMoney(totalOut, currency)}
            </span>
          </div>
          <div>
            <span className="text-muted-foreground mr-1">{t("cashActivity.match.barDifference")}</span>
            <span className={`font-medium tabular-nums ${diffColor}`}>
              {formatCashMoney(difference, currency, { signed: true })}
            </span>
          </div>
        </div>

        {/* Validation message */}
        <div className="flex-1 min-w-0">
          {!validation.valid && (
            <div className="flex items-center gap-1.5 text-xs text-amber-600">
              <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
              <span className="truncate">
                {validation.reason === "validationImbalanced" && validation.shortfall != null
                  ? validation.direction === "need-cash-in"
                    ? t("cashActivity.match.needMoreCashIn", {
                        amount: formatCashMoney(validation.shortfall, currency),
                      })
                    : t("cashActivity.match.needMoreCashOut", {
                        amount: formatCashMoney(validation.shortfall, currency),
                      })
                  : t(`cashActivity.match.${validation.reason}`)}
              </span>
            </div>
          )}
          {validation.valid && (
            <div className="flex items-center gap-1.5 text-xs text-teal-700">
              <CheckCircle2 className="w-3.5 h-3.5 shrink-0" />
              <span>{t("cashActivity.match.balanced")}</span>
            </div>
          )}
        </div>

        {/* Actions */}
        <div className="flex items-center gap-2">
          <Button variant="ghost" size="sm" className="h-8 text-xs gap-1.5" onClick={onClear}>
            <X className="w-3.5 h-3.5" />
            {t("cashActivity.match.barClearSelection")}
          </Button>
          <Button
            size="sm"
            className="h-8 text-xs"
            disabled={!validation.valid}
            onClick={onMatchClick}
          >
            {t("cashActivity.match.barMatchClear")}
          </Button>
        </div>
      </div>
    </div>
  );
}

interface UnmatchGroupDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  groupId: number | null;
  onSuccess: () => void;
}

function MatchClearDialog({
  open,
  onOpenChange,
  selected,
  monthStatus,
  selectedMonth,
  onSuccess,
}: MatchClearDialogProps) {
  const { t } = useTranslation();
  const { toast } = useToast();
  const [note, setNote] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [concurrencyError, setConcurrencyError] = useState<string | null>(null);

  const rows = useMemo(() => Array.from(selected.values()), [selected]);
  const currency = rows[0]?.currency ?? "AED";

  const totalIn = rows.reduce((sum, r) => sum + (r.cashIn ? parseFloat(r.cashIn) : 0), 0);
  const totalOut = rows.reduce((sum, r) => sum + (r.cashOut ? parseFloat(r.cashOut) : 0), 0);

  // representative row for entity/location/drawer labels
  const rep = rows[0];

  async function handleConfirm() {
    setSubmitting(true);
    setConcurrencyError(null);
    try {
      const res = await fetch("/api/cash-activity/match", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          transactionIds: rows.map((r) => r.id),
          yearMonth: selectedMonth,
          note: note.trim() || undefined,
        }),
      });

      if (res.status === 409) {
        // Concurrency conflict
        const body = await res.json().catch(() => ({}));
        const msg =
          body?.error ??
          body?.message ??
          t("cashActivity.match.concurrencyError");
        setConcurrencyError(msg);
        return;
      }

      if (!res.ok) {
        toast({
          title: t("cashActivity.match.genericError"),
          variant: "destructive",
        });
        return;
      }

      toast({ title: t("cashActivity.match.successToast") });
      onOpenChange(false);
      onSuccess();
    } catch {
      toast({
        title: t("cashActivity.match.genericError"),
        variant: "destructive",
      });
    } finally {
      setSubmitting(false);
    }
  }

  // Reset state when dialog closes
  function handleOpenChange(v: boolean) {
    if (!v) {
      setNote("");
      setConcurrencyError(null);
    }
    onOpenChange(v);
  }

  const summaryFields = [
    { label: t("cashActivity.match.dialogCount"), value: String(rows.length) },
    { label: t("cashActivity.match.dialogCashIn"), value: formatCashMoney(totalIn, currency) },
    { label: t("cashActivity.match.dialogCashOut"), value: formatCashMoney(totalOut, currency) },
    {
      label: t("cashActivity.match.dialogDifference"),
      value: formatCashMoney(0, currency),
      highlight: true,
    },
    ...(rep?.entityName ? [{ label: t("cashActivity.match.dialogEntity"), value: rep.entityName }] : []),
    ...(rep?.locationName ? [{ label: t("cashActivity.match.dialogLocation"), value: rep.locationName }] : []),
    ...(rep?.drawerName ? [{ label: t("cashActivity.match.dialogDrawer"), value: rep.drawerName }] : []),
    { label: t("cashActivity.match.dialogCurrency"), value: currency },
    { label: t("cashActivity.match.dialogMonth"), value: formatYearMonthLabel(selectedMonth) },
  ];

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t("cashActivity.match.dialogTitle")}</DialogTitle>
        </DialogHeader>

        <div className="space-y-3 py-2">
          {/* Summary grid */}
          <div className="rounded-md border bg-muted/30 p-3 space-y-2 text-xs">
            {summaryFields.map(({ label, value, highlight }) => (
              <div key={label} className="flex justify-between">
                <span className="text-muted-foreground">{label}</span>
                <span className={`font-medium tabular-nums ${highlight ? "text-teal-700" : ""}`}>
                  {value}
                </span>
              </div>
            ))}
          </div>

          {/* Note field */}
          <div>
            <label className="text-xs font-medium mb-1 block">
              {t("cashActivity.match.dialogNote")}
            </label>
            <Textarea
              placeholder={t("cashActivity.match.dialogNotePlaceholder")}
              className="text-xs min-h-[60px] resize-none"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              disabled={submitting}
            />
          </div>

          {/* Concurrency error */}
          {concurrencyError && (
            <div className="flex items-start gap-2 rounded-md bg-destructive/10 text-destructive px-3 py-2 text-xs">
              <AlertCircle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
              <span>{concurrencyError}</span>
            </div>
          )}
        </div>

        <DialogFooter>
          <Button
            variant="outline"
            size="sm"
            className="text-xs"
            onClick={() => handleOpenChange(false)}
            disabled={submitting}
          >
            {t("cashActivity.match.dialogCancel")}
          </Button>
          <Button
            size="sm"
            className="text-xs gap-1.5"
            onClick={handleConfirm}
            disabled={submitting}
          >
            {submitting && <Spinner className="w-3 h-3" />}
            {submitting
              ? t("cashActivity.match.dialogMatching")
              : t("cashActivity.match.dialogConfirm")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function MatchedGroupTable({ rows, isLoading, isMonthOpen, isFinanceAdmin, onUnmatch }: MatchedGroupTableProps) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState<Set<number>>(new Set());

  const groups = useMemo(() => groupMatchedRows(rows), [rows]);

  function toggleExpand(groupId: number) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(groupId)) next.delete(groupId);
      else next.add(groupId);
      return next;
    });
  }

  if (isLoading) {
    return (
      <div className="space-y-2 p-4">
        {[...Array(3)].map((_, i) => (
          <Skeleton key={i} className="h-10 w-full" />
        ))}
      </div>
    );
  }

  if (groups.length === 0) {
    return (
      <div className="h-32 flex items-center justify-center text-sm text-muted-foreground">
        {t("cashActivity.table.empty")}
      </div>
    );
  }

  return (
    <div className="overflow-x-auto">
      <Table>
        <TableHeader>
          <TableRow className="hover:bg-transparent">
            <TableHead className="text-xs font-medium h-9 w-8" />
            <TableHead className="text-xs font-medium h-9 whitespace-nowrap">
              {t("cashActivity.matchedTab.groupCashIn")}
            </TableHead>
            <TableHead className="text-xs font-medium h-9 whitespace-nowrap">
              {t("cashActivity.matchedTab.groupCashOut")}
            </TableHead>
            <TableHead className="text-xs font-medium h-9 whitespace-nowrap">
              {t("cashActivity.matchedTab.groupDifference")}
            </TableHead>
            <TableHead className="text-xs font-medium h-9 whitespace-nowrap">
              {t("cashActivity.matchedTab.groupTransactions")}
            </TableHead>
            <TableHead className="text-xs font-medium h-9 whitespace-nowrap">
              {t("cashActivity.matchedTab.groupMatchedBy")}
            </TableHead>
            <TableHead className="text-xs font-medium h-9 whitespace-nowrap">
              {t("cashActivity.matchedTab.groupMatchedAt")}
            </TableHead>
            {isMonthOpen && isFinanceAdmin && <TableHead className="text-xs font-medium h-9 w-24" />}
          </TableRow>
        </TableHeader>
        <TableBody>
          {groups.map((group) => {
            const isOpen = expanded.has(group.groupId);
            const diff = group.cashIn - group.cashOut;
            return (
              <>
                {/* Group summary row */}
                <TableRow
                  key={`group-${group.groupId}`}
                  className="text-xs cursor-pointer hover:bg-muted/50 bg-muted/20"
                  onClick={() => toggleExpand(group.groupId)}
                >
                  <TableCell className="w-8">
                    {isOpen ? (
                      <ChevronUp className="w-3.5 h-3.5 text-muted-foreground" />
                    ) : (
                      <ChevronDown className="w-3.5 h-3.5 text-muted-foreground" />
                    )}
                  </TableCell>
                  <TableCell className="tabular-nums text-teal-700 font-medium">
                    {formatCashMoney(group.cashIn, group.currency)}
                  </TableCell>
                  <TableCell className="tabular-nums text-red-700 font-medium">
                    {formatCashMoney(group.cashOut, group.currency)}
                  </TableCell>
                  <TableCell className="tabular-nums font-medium text-teal-700">
                    {formatCashMoney(diff, group.currency, { signed: true })}
                  </TableCell>
                  <TableCell className="text-muted-foreground">{group.count}</TableCell>
                  <TableCell className="text-muted-foreground">{group.matchedBy ?? "—"}</TableCell>
                  <TableCell className="text-muted-foreground whitespace-nowrap">
                    {group.matchedAt
                      ? new Date(group.matchedAt).toLocaleString("default", {
                          day: "2-digit",
                          month: "short",
                          hour: "2-digit",
                          minute: "2-digit",
                        })
                      : "—"}
                  </TableCell>
                  {isMonthOpen && isFinanceAdmin && (
                    <TableCell onClick={(e) => e.stopPropagation()}>
                      {group.groupId > 0 && (
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-7 text-xs text-destructive hover:text-destructive gap-1"
                          onClick={() => onUnmatch(group.groupId)}
                        >
                          <Link2Off className="w-3 h-3" />
                          {t("cashActivity.unmatch.buttonLabel")}
                        </Button>
                      )}
                    </TableCell>
                  )}
                </TableRow>

                {/* Expanded individual rows */}
                {isOpen &&
                  group.rows.map((row) => (
                    <TableRow key={`row-${row.id}`} className="text-xs bg-background">
                      <TableCell className="w-8" />
                      <TableCell className="tabular-nums text-teal-700">
                        {row.cashIn ? formatCashMoney(parseFloat(row.cashIn), row.currency) : "—"}
                      </TableCell>
                      <TableCell className="tabular-nums text-red-700">
                        {row.cashOut ? formatCashMoney(parseFloat(row.cashOut), row.currency) : "—"}
                      </TableCell>
                      <TableCell />
                      <TableCell className="text-muted-foreground whitespace-nowrap" colSpan={2}>
                        {new Date(row.transactionDate).toLocaleString("default", {
                          day: "2-digit",
                          month: "short",
                          hour: "2-digit",
                          minute: "2-digit",
                        })}
                        {row.referenceId && (
                          <span className="ml-2 text-primary">#{row.referenceId}</span>
                        )}
                        {row.description && (
                          <span className="ml-2">{row.description}</span>
                        )}
                      </TableCell>
                      <TableCell className="text-muted-foreground">
                        {row.locationName ?? "—"}
                      </TableCell>
                      {isMonthOpen && <TableCell />}
                    </TableRow>
                  ))}
              </>
            );
          })}
        </TableBody>
      </Table>
    </div>
  );
}

interface MatchedGroupTableProps {
  rows: TransactionRow[];
  isLoading: boolean;
  isMonthOpen: boolean;
  isFinanceAdmin: boolean;
  onUnmatch: (groupId: number) => void;
}

interface MatchedGroup {
  groupId: number;
  rows: TransactionRow[];
  cashIn: number;
  cashOut: number;
  currency: string;
  matchedBy: string | null;
  matchedAt: string | null;
  count: number;
}

interface MatchClearDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  selected: Map<number, TransactionRow>;
  monthStatus: MonthStatus | undefined;
  selectedMonth: string;
  onSuccess: () => void;
}

function groupMatchedRows(rows: TransactionRow[]): MatchedGroup[] {
  const byGroup = new Map<number, TransactionRow[]>();
  for (const row of rows) {
    const gid = row.matchGroupId ?? -row.id; // ungrouped rows get a synthetic key
    if (!byGroup.has(gid)) byGroup.set(gid, []);
    byGroup.get(gid)!.push(row);
  }
  return Array.from(byGroup.entries()).map(([groupId, groupRows]) => ({
    groupId,
    rows: groupRows,
    cashIn: groupRows.reduce((s, r) => s + (r.cashIn ? parseFloat(r.cashIn) : 0), 0),
    cashOut: groupRows.reduce((s, r) => s + (r.cashOut ? parseFloat(r.cashOut) : 0), 0),
    currency: groupRows[0].currency,
    matchedBy: groupRows[0].matchedBy,
    matchedAt: groupRows[0].matchedAt,
    count: groupRows.length,
  }));
}

/**
 * Pure function that checks all 8 eligibility rules for Match & Clear.
 * Returns { valid, reason, shortfall, direction }.
 */
function validateMatchSelection(
  rows: TransactionRow[],
  monthStatus: MonthStatus | undefined,
  selectedMonth: string,
): ValidationResult {
  if (!monthStatus || monthStatus.status !== "OPEN") {
    return { valid: false, reason: "validationOpenMonth" };
  }

  if (rows.length === 0) {
    return { valid: false, reason: "validationNeedCashIn" };
  }

  // Rule: none already matched/voided/reversed/locked
  const anyBad = rows.some(
    (r) => r.matchGroupId !== null || r.isReversed || r.status === "voided" || r.status === "locked",
  );
  if (anyBad) {
    return { valid: false, reason: "validationAlreadyMatched" };
  }

  // Rule: same currency
  const currencies = new Set(rows.map((r) => r.currency));
  if (currencies.size > 1) {
    return { valid: false, reason: "validationMixedCurrency" };
  }

  const currency = rows[0].currency;

  // Rule: same entity
  const entityIds = new Set(rows.map((r) => r.entityId));
  if (entityIds.size > 1) {
    return { valid: false, reason: "validationMixedEntity" };
  }

  // Rule: same location
  const locationIds = new Set(rows.map((r) => r.locationId));
  if (locationIds.size > 1) {
    return { valid: false, reason: "validationMixedLocation" };
  }

  // Rule: same drawer
  const drawerIds = new Set(rows.map((r) => r.drawerId));
  if (drawerIds.size > 1) {
    return { valid: false, reason: "validationMixedDrawer" };
  }

  // Rule: all within selected accounting month
  const outsideMonth = rows.some((r) => {
    const ym = r.transactionDate.slice(0, 7);
    return ym !== selectedMonth;
  });
  if (outsideMonth) {
    return { valid: false, reason: "validationMonthMismatch" };
  }

  // Rule: at least one cash-in and one cash-out
  const hasCashIn = rows.some((r) => r.cashIn && parseFloat(r.cashIn) > 0);
  const hasCashOut = rows.some((r) => r.cashOut && parseFloat(r.cashOut) > 0);

  if (!hasCashIn) {
    return { valid: false, reason: "validationNeedCashIn" };
  }
  if (!hasCashOut) {
    return { valid: false, reason: "validationNeedCashOut" };
  }

  // Rule: Cash In === Cash Out (within currency precision)
  const digits = decimalPlaces(currency);
  const factor = Math.pow(10, digits);
  const totalIn = Math.round(
    rows.reduce((sum, r) => sum + (r.cashIn ? parseFloat(r.cashIn) : 0), 0) * factor,
  );
  const totalOut = Math.round(
    rows.reduce((sum, r) => sum + (r.cashOut ? parseFloat(r.cashOut) : 0), 0) * factor,
  );

  if (totalIn !== totalOut) {
    const shortfall = Math.abs(totalIn - totalOut) / factor;
    const direction: "need-cash-in" | "need-cash-out" = totalIn < totalOut ? "need-cash-in" : "need-cash-out";
    return { valid: false, reason: "validationImbalanced", shortfall, direction };
  }

  return { valid: true };
}

function UnmatchGroupDialog({
  open,
  onOpenChange,
  groupId,
  onSuccess,
}: UnmatchGroupDialogProps) {
  const { t } = useTranslation();
  const { toast } = useToast();
  const [reason, setReason] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleConfirm() {
    if (!reason.trim()) {
      setError(t("cashActivity.unmatch.reasonRequired"));
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch(`/api/cash-activity/match/${groupId}`, {
        method: "DELETE",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reason: reason.trim() }),
      });

      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setError(body?.error ?? body?.message ?? t("cashActivity.unmatch.genericError"));
        return;
      }

      toast({ title: t("cashActivity.unmatch.successToast") });
      onOpenChange(false);
      onSuccess();
    } catch {
      setError(t("cashActivity.unmatch.genericError"));
    } finally {
      setSubmitting(false);
    }
  }

  function handleOpenChange(v: boolean) {
    if (!v) {
      setReason("");
      setError(null);
    }
    onOpenChange(v);
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>{t("cashActivity.unmatch.dialogTitle")}</DialogTitle>
        </DialogHeader>

        <div className="space-y-3 py-2">
          <p className="text-xs text-muted-foreground">{t("cashActivity.unmatch.dialogDesc")}</p>

          <div>
            <label className="text-xs font-medium mb-1 block">
              {t("cashActivity.unmatch.dialogReason")}
              <span className="text-destructive ml-1">*</span>
            </label>
            <Textarea
              placeholder={t("cashActivity.unmatch.dialogReasonPlaceholder")}
              className="text-xs min-h-[80px] resize-none"
              value={reason}
              onChange={(e) => {
                setReason(e.target.value);
                if (error) setError(null);
              }}
              disabled={submitting}
            />
          </div>

          {error && (
            <div className="flex items-start gap-2 rounded-md bg-destructive/10 text-destructive px-3 py-2 text-xs">
              <AlertCircle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
              <span>{error}</span>
            </div>
          )}
        </div>

        <DialogFooter>
          <Button
            variant="outline"
            size="sm"
            className="text-xs"
            onClick={() => handleOpenChange(false)}
            disabled={submitting}
          >
            {t("cashActivity.unmatch.dialogCancel")}
          </Button>
          <Button
            variant="destructive"
            size="sm"
            className="text-xs gap-1.5"
            onClick={handleConfirm}
            disabled={submitting || !reason.trim()}
          >
            {submitting && <Spinner className="w-3 h-3" />}
            {submitting
              ? t("cashActivity.unmatch.dialogUnmatching")
              : t("cashActivity.unmatch.dialogConfirm")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

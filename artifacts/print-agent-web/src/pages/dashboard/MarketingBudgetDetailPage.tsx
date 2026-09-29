import { useState, useEffect, useRef } from "react";
import { useParams, useLocation } from "wouter";
import { useQueryClient } from "@tanstack/react-query";
import { apiFetch } from "@/lib/queryClient";
import {
  useGetMarketingBudget,
  usePatchMarketingBudget,
  useDeleteMarketingBudget,
  getGetMarketingBudgetQueryKey,
  getListMarketingBudgetsQueryKey,
  type MarketingBudget as ApiMarketingBudget,
} from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { useToast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";
import {
  ChevronDown,
  ChevronUp,
  Plus,
  Trash2,
  Download,
  AlertTriangle,
  CheckCircle2,
  ArrowLeft,
  Pencil,
  X,
  Check,
} from "lucide-react";

const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

const CHANNEL_NAMES = ["Retail Sales", "Website Sales", "Toters Sales"];

const CURRENCIES = [
  { code: "AED", label: "AED — UAE Dirham" },
  { code: "USD", label: "USD — US Dollar" },
  { code: "EUR", label: "EUR — Euro" },
  { code: "GBP", label: "GBP — British Pound" },
  { code: "SAR", label: "SAR — Saudi Riyal" },
  { code: "QAR", label: "QAR — Qatari Riyal" },
  { code: "KWD", label: "KWD — Kuwaiti Dinar" },
  { code: "BHD", label: "BHD — Bahraini Dinar" },
  { code: "OMR", label: "OMR — Omani Rial" },
  { code: "EGP", label: "EGP — Egyptian Pound" },
  { code: "INR", label: "INR — Indian Rupee" },
  { code: "PKR", label: "PKR — Pakistani Rupee" },
  { code: "CAD", label: "CAD — Canadian Dollar" },
  { code: "AUD", label: "AUD — Australian Dollar" },
  { code: "JPY", label: "JPY — Japanese Yen" },
  { code: "CNY", label: "CNY — Chinese Yuan" },
];

type Platform = {
  id: string;
  name: string;
  allocation: string;
};

type ChannelConfig = {
  name: string;
  salesTarget: string;
  marketingBudgetPct: string;
  platforms: Platform[];
  open: boolean;
};

type DailyRow = {
  date: string;
  platforms: Record<string, number>;
};

type ChannelGrid = {
  channelName: string;
  platformNames: string[];
  rows: DailyRow[];
  calculatedTotal: number;
};

type DownloadFile = {
  channelName: string;
  url: string;
  filename: string;
};

type MarketingBudget = ApiMarketingBudget;

function newPlatform(): Platform {
  return { id: crypto.randomUUID(), name: "", allocation: "" };
}

function defaultChannel(name: string): ChannelConfig {
  return {
    name,
    salesTarget: "",
    marketingBudgetPct: "",
    platforms: [newPlatform()],
    open: true,
  };
}

function getAllocTotal(platforms: Platform[]): number {
  return platforms.reduce((sum, p) => sum + (parseFloat(p.allocation) || 0), 0);
}

function formatCurrency(val: number, currency: string): string {
  return `${currency} ${val.toFixed(2)}`;
}

function StatusBadge({ status }: { status: "planned" | "current" | "past" }) {
  if (status === "current") {
    return (
      <Badge className="bg-green-100 text-green-800 border-green-200 hover:bg-green-100">
        Current
      </Badge>
    );
  }
  if (status === "planned") {
    return (
      <Badge className="bg-blue-100 text-blue-800 border-blue-200 hover:bg-blue-100">
        Planned
      </Badge>
    );
  }
  return (
    <Badge className="bg-gray-100 text-gray-600 border-gray-200 hover:bg-gray-100">
      Past
    </Badge>
  );
}

function channelsFromBudget(
  budget: MarketingBudget,
): ChannelConfig[] {
  if (budget.channels && budget.channels.length > 0) {
    return budget.channels.map((ch) => ({
      name: ch.name,
      salesTarget: String(ch.salesTarget),
      marketingBudgetPct: String(ch.marketingBudgetPct),
      platforms: ch.platforms.map((p) => ({
        id: crypto.randomUUID(),
        name: p.name,
        allocation: String(p.allocation),
      })),
      open: true,
    }));
  }
  return CHANNEL_NAMES.map(defaultChannel);
}

export default function MarketingBudgetDetailPage() {
  const { budgetId } = useParams<{ budgetId: string }>();
  const [, setLocation] = useLocation();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const basePath = (import.meta.env.BASE_URL as string).replace(/\/$/, "");

  const {
    data: budgetData,
    isLoading,
    isError,
  } = useGetMarketingBudget(Number(budgetId) || 0);

  const budget = budgetData?.budget;

  const [month, setMonth] = useState<number | null>(null);
  const [year, setYear] = useState<number | null>(null);
  const [currency, setCurrency] = useState<string>("AED");
  const [startDate, setStartDate] = useState<string>("");
  const [endDate, setEndDate] = useState<string>("");
  const [channels, setChannels] = useState<ChannelConfig[]>(
    CHANNEL_NAMES.map(defaultChannel),
  );
  const [initialized, setInitialized] = useState(false);

  const [advancedMode, setAdvancedMode] = useState(false);
  const [grids, setGrids] = useState<ChannelGrid[] | null>(null);
  const [editedGrids, setEditedGrids] = useState<ChannelGrid[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [errors, setErrors] = useState<string[]>([]);
  const [generateError, setGenerateError] = useState<string | null>(null);
  const [downloadFiles, setDownloadFiles] = useState<DownloadFile[] | null>(null);

  const [renaming, setRenaming] = useState(false);
  const [renameValue, setRenameValue] = useState("");
  const renameInputRef = useRef<HTMLInputElement>(null);
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);

  useEffect(() => {
    if (budget && !initialized) {
      setMonth(budget.month);
      setYear(budget.year);
      setCurrency(budget.currency ?? "AED");
      setStartDate(budget.start_date);
      setEndDate(budget.end_date);
      setChannels(channelsFromBudget(budget));
      setInitialized(true);
    }
  }, [budget, initialized]);

  const saveMutation = usePatchMarketingBudget({
    mutation: {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getGetMarketingBudgetQueryKey(Number(budgetId)) });
        queryClient.invalidateQueries({ queryKey: getListMarketingBudgetsQueryKey() });
        toast({ title: "Budget saved" });
      },
      onError: (e: Error) => {
        toast({ title: "Failed to save", description: e.message, variant: "destructive" });
      },
    },
  });

  const renameMutation = usePatchMarketingBudget({
    mutation: {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getGetMarketingBudgetQueryKey(Number(budgetId)) });
        queryClient.invalidateQueries({ queryKey: getListMarketingBudgetsQueryKey() });
        toast({ title: "Budget renamed" });
        setRenaming(false);
      },
      onError: (e: Error) => {
        toast({ title: "Failed to rename", description: e.message, variant: "destructive" });
      },
    },
  });

  const deleteMutation = useDeleteMarketingBudget({
    mutation: {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getListMarketingBudgetsQueryKey() });
        toast({ title: "Budget deleted" });
        setLocation("/marketing-budget-planner");
      },
      onError: (e: Error) => {
        toast({ title: "Failed to delete", description: e.message, variant: "destructive" });
      },
    },
  });

  function startRenaming() {
    if (!budget) return;
    setRenameValue(budget.name);
    setRenaming(true);
    setTimeout(() => renameInputRef.current?.focus(), 0);
  }

  function cancelRenaming() {
    setRenaming(false);
    setRenameValue("");
  }

  function commitRename() {
    const trimmed = renameValue.trim();
    if (!trimmed) return;
    if (budget && trimmed === budget.name) {
      setRenaming(false);
      return;
    }
    renameMutation.mutate({ id: Number(budgetId), data: { name: trimmed } });
  }

  function updateChannel(idx: number, partial: Partial<ChannelConfig>) {
    setChannels((prev) => prev.map((c, i) => (i === idx ? { ...c, ...partial } : c)));
  }

  function addPlatform(chIdx: number) {
    setChannels((prev) =>
      prev.map((c, i) =>
        i === chIdx ? { ...c, platforms: [...c.platforms, newPlatform()] } : c,
      ),
    );
  }

  function removePlatform(chIdx: number, pId: string) {
    setChannels((prev) =>
      prev.map((c, i) =>
        i === chIdx
          ? { ...c, platforms: c.platforms.filter((p) => p.id !== pId) }
          : c,
      ),
    );
  }

  function updatePlatform(
    chIdx: number,
    pId: string,
    partial: Partial<Platform>,
  ) {
    setChannels((prev) =>
      prev.map((c, i) =>
        i === chIdx
          ? {
              ...c,
              platforms: c.platforms.map((p) =>
                p.id === pId ? { ...p, ...partial } : p,
              ),
            }
          : c,
      ),
    );
  }

  function buildChannelPayload() {
    return channels.map((ch) => ({
      name: ch.name,
      salesTarget: parseFloat(ch.salesTarget),
      marketingBudgetPct: parseFloat(ch.marketingBudgetPct),
      platforms: ch.platforms.map((p) => ({
        name: p.name.trim(),
        allocation: parseFloat(p.allocation),
      })),
    }));
  }

  const dateRangeError: string | null =
    startDate && endDate && new Date(startDate) > new Date(endDate)
      ? "End date must be on or after start date."
      : null;

  function handleSave() {
    if (!budget) return;
    if (dateRangeError) {
      toast({ title: "Invalid date range", description: dateRangeError, variant: "destructive" });
      return;
    }
    saveMutation.mutate({
      id: Number(budgetId),
      data: {
        name: budget.name,
        month: month ?? budget.month,
        year: year ?? budget.year,
        startDate,
        endDate,
        currency,
        channels: buildChannelPayload(),
      },
    });
  }

  function validateForm(): string[] {
    const errs: string[] = [];
    if (!startDate || !endDate) errs.push("Date range is required.");
    if (new Date(startDate) > new Date(endDate))
      errs.push("Start date must be before or equal to end date.");

    channels.forEach((ch) => {
      if (
        !ch.salesTarget ||
        isNaN(parseFloat(ch.salesTarget)) ||
        parseFloat(ch.salesTarget) <= 0
      )
        errs.push(`${ch.name}: Sales target must be a positive number.`);
      if (
        ch.marketingBudgetPct === "" ||
        isNaN(parseFloat(ch.marketingBudgetPct)) ||
        parseFloat(ch.marketingBudgetPct) < 0 ||
        parseFloat(ch.marketingBudgetPct) > 100
      )
        errs.push(
          `${ch.name}: Marketing budget must be between 0 and 100.`,
        );
      if (ch.platforms.length === 0)
        errs.push(`${ch.name}: At least one platform is required.`);
      ch.platforms.forEach((p, pi) => {
        if (!p.name.trim())
          errs.push(`${ch.name} Platform #${pi + 1}: Name is required.`);
        if (p.allocation === "" || isNaN(parseFloat(p.allocation)))
          errs.push(
            `${ch.name} Platform #${pi + 1}: Allocation is required.`,
          );
      });
      const allocTotal = getAllocTotal(ch.platforms);
      if (Math.abs(allocTotal - 100) > 0.01)
        errs.push(
          `${ch.name}: Platform allocations must sum to 100% (currently ${allocTotal.toFixed(1)}%).`,
        );
    });

    return errs;
  }

  async function handleCalculate(): Promise<ChannelGrid[] | null> {
    const errs = validateForm();
    if (errs.length > 0) {
      setErrors(errs);
      return null;
    }
    setErrors([]);
    setLoading(true);
    try {
      const body = {
        month,
        year,
        startDate,
        endDate,
        channels: channels.map((ch) => ({
          name: ch.name,
          salesTarget: parseFloat(ch.salesTarget),
          marketingBudgetPct: parseFloat(ch.marketingBudgetPct),
          platforms: ch.platforms.map((p) => ({
            name: p.name.trim(),
            allocation: parseFloat(p.allocation),
          })),
        })),
      };
      const data = await apiFetch<{ channels: ChannelGrid[] }>(
        "/api/budget/calculate",
        { method: "POST", body: JSON.stringify(body) },
      );
      return data.channels;
    } catch (err) {
      setErrors([
        err instanceof Error ? err.message : "Calculation failed",
      ]);
      return null;
    } finally {
      setLoading(false);
    }
  }

  async function handleGenerate(gridData: ChannelGrid[]) {
    setGenerating(true);
    setGenerateError(null);
    try {
      const data = await apiFetch<{ files: DownloadFile[] }>(
        "/api/budget/generate",
        {
          method: "POST",
          body: JSON.stringify({
            month,
            year,
            currency,
            channels: gridData,
          }),
        },
      );
      setDownloadFiles(data.files);
    } catch (err) {
      setGenerateError(
        err instanceof Error ? err.message : "PDF generation failed",
      );
    } finally {
      setGenerating(false);
    }
  }

  async function handleStandardSubmit() {
    setDownloadFiles(null);
    setGenerateError(null);
    const calcResult = await handleCalculate();
    if (!calcResult) return;
    await handleGenerate(calcResult);
  }

  async function handleAdvancedCalculate() {
    setDownloadFiles(null);
    const calcResult = await handleCalculate();
    if (!calcResult) return;
    setGrids(calcResult);
    setEditedGrids(JSON.parse(JSON.stringify(calcResult)));
  }

  function updateEditedCell(
    chIdx: number,
    rowIdx: number,
    platform: string,
    value: string,
  ) {
    setEditedGrids((prev) => {
      if (!prev) return prev;
      const next = JSON.parse(JSON.stringify(prev)) as ChannelGrid[];
      const num = parseFloat(value);
      next[chIdx].rows[rowIdx].platforms[platform] = isNaN(num) ? 0 : num;
      return next;
    });
  }

  function getEditedChannelTotal(grid: ChannelGrid): number {
    return grid.rows.reduce((sum, row) => {
      return sum + Object.values(row.platforms).reduce((s, v) => s + v, 0);
    }, 0);
  }

  function handleMonthYearChange(newMonth: number, newYear: number) {
    setMonth(newMonth);
    setYear(newYear);
    const start = `${newYear}-${String(newMonth).padStart(2, "0")}-01`;
    const end = new Date(newYear, newMonth, 0).toISOString().split("T")[0];
    setStartDate(start);
    setEndDate(end);
    setGrids(null);
    setEditedGrids(null);
    setDownloadFiles(null);
  }

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-16 text-muted-foreground">
        Loading…
      </div>
    );
  }

  if (isError || !budget) {
    return (
      <div className="space-y-4">
        <Button variant="ghost" size="sm" className="gap-1.5" onClick={() => setLocation("/marketing-budget-planner")}>
          <ArrowLeft size={14} />
          Back to Marketing Budget Planner
        </Button>
        <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-4 text-sm text-destructive">
          Budget not found or failed to load.
        </div>
      </div>
    );
  }

  const activeMonth = month ?? budget.month;
  const activeYear = year ?? budget.year;

  return (
    <div className="space-y-6 max-w-5xl mx-auto">
      <div className="flex items-start gap-3">
        <Button
          variant="ghost"
          size="sm"
          className="gap-1.5 mt-0.5 flex-shrink-0"
          onClick={() => setLocation("/marketing-budget-planner")}
        >
          <ArrowLeft size={14} />
          Back
        </Button>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            {renaming ? (
              <div className="flex items-center gap-2">
                <Input
                  ref={renameInputRef}
                  value={renameValue}
                  onChange={(e) => setRenameValue(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") commitRename();
                    if (e.key === "Escape") cancelRenaming();
                  }}
                  className="text-xl font-bold h-9 w-64"
                  disabled={renameMutation.isPending}
                />
                <Button
                  size="icon"
                  variant="ghost"
                  className="h-8 w-8 text-green-600 hover:text-green-700"
                  onClick={commitRename}
                  disabled={renameMutation.isPending || !renameValue.trim()}
                >
                  <Check size={15} />
                </Button>
                <Button
                  size="icon"
                  variant="ghost"
                  className="h-8 w-8"
                  onClick={cancelRenaming}
                  disabled={renameMutation.isPending}
                >
                  <X size={15} />
                </Button>
              </div>
            ) : (
              <>
                <h1 className="text-2xl font-bold tracking-tight">{budget.name}</h1>
                <Button
                  size="icon"
                  variant="ghost"
                  className="h-7 w-7 text-muted-foreground hover:text-foreground"
                  onClick={startRenaming}
                  title="Rename budget"
                >
                  <Pencil size={14} />
                </Button>
              </>
            )}
            <StatusBadge status={budget.status} />
          </div>
          <p className="text-muted-foreground text-sm mt-1">
            Marketing Budget Planner · {MONTH_NAMES[budget.month - 1]} {budget.year}
          </p>
        </div>
        <div className="flex items-center gap-3 flex-shrink-0">
          <Button
            variant="ghost"
            size="sm"
            className="gap-1.5 text-destructive hover:text-destructive hover:bg-destructive/10"
            onClick={() => setDeleteConfirmOpen(true)}
            title="Delete budget"
          >
            <Trash2 size={15} />
            Delete
          </Button>
          <Label htmlFor="advanced-toggle" className="text-sm font-medium">
            Advanced Mode
          </Label>
          <Switch
            id="advanced-toggle"
            checked={advancedMode}
            onCheckedChange={(v) => {
              setAdvancedMode(v);
              setGrids(null);
              setEditedGrids(null);
              setDownloadFiles(null);
            }}
          />
        </div>
      </div>

      <Dialog open={deleteConfirmOpen} onOpenChange={(v) => { if (!v) setDeleteConfirmOpen(false); }}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>Delete budget?</DialogTitle>
            <DialogDescription>
              This will permanently delete{" "}
              <span className="font-medium text-foreground">{budget.name}</span>.
              This action cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setDeleteConfirmOpen(false)}
              disabled={deleteMutation.isPending}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              disabled={deleteMutation.isPending}
              onClick={() => deleteMutation.mutate({ id: Number(budgetId) })}
            >
              {deleteMutation.isPending ? "Deleting…" : "Delete"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <div className="border border-border rounded-xl bg-card p-5 space-y-4">
        <h2 className="text-base font-semibold">Budget Period</h2>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-4">
          <div className="space-y-1.5">
            <Label>Month</Label>
            <select
              className="w-full border border-border rounded-md px-3 py-2 text-sm bg-background"
              value={activeMonth}
              onChange={(e) =>
                handleMonthYearChange(parseInt(e.target.value), activeYear)
              }
            >
              {MONTH_NAMES.map((m, i) => (
                <option key={m} value={i + 1}>
                  {m}
                </option>
              ))}
            </select>
          </div>
          <div className="space-y-1.5">
            <Label>Year</Label>
            <Input
              type="number"
              value={activeYear}
              min={2000}
              max={2100}
              onChange={(e) => {
                const y = parseInt(e.target.value);
                if (!isNaN(y)) handleMonthYearChange(activeMonth, y);
              }}
            />
          </div>
          <div className="space-y-1.5">
            <Label>Currency</Label>
            <select
              className="w-full border border-border rounded-md px-3 py-2 text-sm bg-background"
              value={currency}
              onChange={(e) => setCurrency(e.target.value)}
            >
              {CURRENCIES.map((c) => (
                <option key={c.code} value={c.code}>
                  {c.label}
                </option>
              ))}
            </select>
          </div>
          <div className="space-y-1.5">
            <Label>Start Date</Label>
            <Input
              type="date"
              value={startDate}
              onChange={(e) => {
                setStartDate(e.target.value);
                setGrids(null);
                setEditedGrids(null);
                setDownloadFiles(null);
              }}
            />
          </div>
          <div className="space-y-1.5">
            <Label>End Date</Label>
            <Input
              type="date"
              value={endDate}
              className={cn(dateRangeError ? "border-destructive focus-visible:ring-destructive" : "")}
              onChange={(e) => {
                setEndDate(e.target.value);
                setGrids(null);
                setEditedGrids(null);
                setDownloadFiles(null);
              }}
            />
            {dateRangeError && (
              <p className="text-xs text-destructive flex items-center gap-1">
                <AlertTriangle size={11} className="flex-shrink-0" />
                {dateRangeError}
              </p>
            )}
          </div>
        </div>
      </div>

      <div className="space-y-4">
        {channels.map((ch, chIdx) => {
          const allocTotal = getAllocTotal(ch.platforms);
          const allocOk = Math.abs(allocTotal - 100) < 0.01;
          return (
            <Collapsible
              key={ch.name}
              open={ch.open}
              onOpenChange={(open) => updateChannel(chIdx, { open })}
            >
              <div className="border border-border rounded-xl bg-card overflow-hidden">
                <CollapsibleTrigger asChild>
                  <button className="w-full flex items-center justify-between px-5 py-4 text-left hover:bg-secondary/50 transition-colors">
                    <div className="flex items-center gap-3">
                      <span className="font-semibold text-sm">{ch.name}</span>
                      {allocOk ? (
                        <Badge
                          variant="secondary"
                          className="text-xs text-green-700 bg-green-50 border-green-200"
                        >
                          <CheckCircle2 size={11} className="mr-1" />
                          Allocations OK
                        </Badge>
                      ) : (
                        <Badge
                          variant="secondary"
                          className="text-xs text-amber-700 bg-amber-50 border-amber-200"
                        >
                          <AlertTriangle size={11} className="mr-1" />
                          {allocTotal.toFixed(1)}% / 100%
                        </Badge>
                      )}
                    </div>
                    {ch.open ? (
                      <ChevronUp size={16} className="text-muted-foreground" />
                    ) : (
                      <ChevronDown size={16} className="text-muted-foreground" />
                    )}
                  </button>
                </CollapsibleTrigger>
                <CollapsibleContent>
                  <div className="px-5 pb-5 space-y-5">
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                      <div className="space-y-1.5">
                        <Label>Sales Target ({currency})</Label>
                        <Input
                          type="number"
                          min={0}
                          placeholder="e.g. 500000"
                          value={ch.salesTarget}
                          onChange={(e) =>
                            updateChannel(chIdx, { salesTarget: e.target.value })
                          }
                        />
                      </div>
                      <div className="space-y-1.5">
                        <Label>Marketing Budget (%)</Label>
                        <Input
                          type="number"
                          min={0}
                          max={100}
                          step={0.1}
                          placeholder="e.g. 5"
                          value={ch.marketingBudgetPct}
                          onChange={(e) =>
                            updateChannel(chIdx, {
                              marketingBudgetPct: e.target.value,
                            })
                          }
                        />
                      </div>
                    </div>

                    <div className="space-y-3">
                      <div className="flex items-center justify-between">
                        <Label className="text-sm font-medium">
                          Ad Platforms
                        </Label>
                        <span
                          className={cn(
                            "text-xs font-medium",
                            allocOk ? "text-green-600" : "text-amber-600",
                          )}
                        >
                          Total: {allocTotal.toFixed(1)}%
                        </span>
                      </div>

                      {ch.platforms.map((p) => (
                        <div key={p.id} className="flex items-center gap-2">
                          <Input
                            placeholder="Platform name"
                            value={p.name}
                            onChange={(e) =>
                              updatePlatform(chIdx, p.id, {
                                name: e.target.value,
                              })
                            }
                            className="flex-1"
                          />
                          <div className="relative w-28 flex-shrink-0">
                            <Input
                              type="number"
                              min={0}
                              max={100}
                              step={0.1}
                              placeholder="0"
                              value={p.allocation}
                              onChange={(e) =>
                                updatePlatform(chIdx, p.id, {
                                  allocation: e.target.value,
                                })
                              }
                              className="pr-7"
                            />
                            <span className="absolute right-2.5 top-1/2 -translate-y-1/2 text-muted-foreground text-xs pointer-events-none">
                              %
                            </span>
                          </div>
                          <Button
                            variant="ghost"
                            size="icon"
                            className="text-destructive hover:text-destructive flex-shrink-0"
                            onClick={() => removePlatform(chIdx, p.id)}
                            disabled={ch.platforms.length === 1}
                          >
                            <Trash2 size={15} />
                          </Button>
                        </div>
                      ))}

                      <Button
                        variant="outline"
                        size="sm"
                        className="gap-1.5"
                        onClick={() => addPlatform(chIdx)}
                      >
                        <Plus size={14} />
                        Add Platform
                      </Button>
                    </div>
                  </div>
                </CollapsibleContent>
              </div>
            </Collapsible>
          );
        })}
      </div>

      {errors.length > 0 && (
        <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-4 space-y-1">
          {errors.map((e, i) => (
            <p
              key={i}
              className="text-sm text-destructive flex items-start gap-2"
            >
              <AlertTriangle size={14} className="mt-0.5 flex-shrink-0" />
              {e}
            </p>
          ))}
        </div>
      )}

      <div className="flex items-center gap-3 flex-wrap">
        <Button
          variant="outline"
          onClick={handleSave}
          disabled={saveMutation.isPending}
          className="gap-2"
        >
          {saveMutation.isPending ? "Saving…" : "Save budget"}
        </Button>

        {!advancedMode && (
          <Button
            onClick={handleStandardSubmit}
            disabled={loading || generating}
            className="gap-2"
          >
            {loading
              ? "Calculating…"
              : generating
                ? "Generating PDFs…"
                : "Generate PDFs"}
          </Button>
        )}

        {advancedMode && !grids && (
          <Button
            onClick={handleAdvancedCalculate}
            disabled={loading}
            className="gap-2"
          >
            {loading ? "Calculating…" : "Calculate & Preview"}
          </Button>
        )}
      </div>

      {advancedMode && grids && editedGrids && (
        <div className="space-y-6">
          <div className="flex items-center justify-between flex-wrap gap-3">
            <h2 className="text-base font-semibold">Edit Daily Spend</h2>
            <div className="flex items-center gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={handleAdvancedCalculate}
                disabled={loading}
              >
                Recalculate
              </Button>
              <Button
                onClick={() => handleGenerate(editedGrids)}
                disabled={generating}
                className="gap-2"
              >
                <Download size={15} />
                {generating ? "Generating PDFs…" : "Generate PDFs"}
              </Button>
            </div>
          </div>

          {editedGrids.map((grid, chIdx) => {
            const editedTotal = getEditedChannelTotal(grid);
            const calcTotal = grids[chIdx].calculatedTotal;
            const divergePct =
              calcTotal > 0
                ? Math.abs(editedTotal - calcTotal) / calcTotal
                : 0;
            const isDiverging = divergePct > 0.05;

            return (
              <div
                key={grid.channelName}
                className="border border-border rounded-xl overflow-hidden"
              >
                <div className="px-5 py-3 bg-secondary/30 flex items-center justify-between flex-wrap gap-2">
                  <span className="font-semibold text-sm">
                    {grid.channelName}
                  </span>
                  <div className="flex items-center gap-3 text-sm">
                    <span className="text-muted-foreground">
                      Calculated:{" "}
                      <strong>{formatCurrency(calcTotal, currency)}</strong>
                    </span>
                    <span
                      className={cn(
                        "font-medium",
                        isDiverging ? "text-amber-600" : "text-green-600",
                      )}
                    >
                      {isDiverging && (
                        <AlertTriangle size={13} className="inline mr-1" />
                      )}
                      Edited:{" "}
                      <strong>{formatCurrency(editedTotal, currency)}</strong>
                      {isDiverging && (
                        <span className="ml-1 text-xs">
                          ({(divergePct * 100).toFixed(1)}% off)
                        </span>
                      )}
                    </span>
                  </div>
                </div>

                <div className="overflow-x-auto">
                  <table className="w-full text-xs border-collapse">
                    <thead>
                      <tr className="bg-muted/50">
                        <th className="text-left px-3 py-2 font-medium border-b border-border sticky left-0 bg-muted/50">
                          Date
                        </th>
                        {grid.platformNames.map((pName) => (
                          <th
                            key={pName}
                            className="text-right px-3 py-2 font-medium border-b border-border whitespace-nowrap min-w-[110px]"
                          >
                            {pName}
                          </th>
                        ))}
                        <th className="text-right px-3 py-2 font-medium border-b border-border">
                          Row Total
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {grid.rows.map((row, rowIdx) => {
                        const rowTotal = Object.values(
                          row.platforms,
                        ).reduce((s, v) => s + v, 0);
                        return (
                          <tr
                            key={row.date}
                            className={cn(
                              "border-b border-border/50",
                              rowIdx % 2 === 1 ? "bg-secondary/20" : "",
                            )}
                          >
                            <td className="px-3 py-1.5 font-medium text-muted-foreground sticky left-0 bg-inherit whitespace-nowrap">
                              {new Date(
                                row.date + "T00:00:00Z",
                              ).toLocaleDateString("en-GB", {
                                day: "2-digit",
                                month: "short",
                                year: "numeric",
                                timeZone: "UTC",
                              })}
                            </td>
                            {grid.platformNames.map((pName) => (
                              <td
                                key={pName}
                                className="px-2 py-1 text-right"
                              >
                                <Input
                                  type="number"
                                  min={0}
                                  step={0.01}
                                  value={row.platforms[pName] ?? 0}
                                  onChange={(e) =>
                                    updateEditedCell(
                                      chIdx,
                                      rowIdx,
                                      pName,
                                      e.target.value,
                                    )
                                  }
                                  className="h-7 text-xs text-right w-24 ml-auto"
                                />
                              </td>
                            ))}
                            <td className="px-3 py-1.5 text-right font-medium whitespace-nowrap">
                              {formatCurrency(rowTotal, currency)}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                    <tfoot>
                      <tr className="bg-blue-50 border-t-2 border-blue-200 font-semibold">
                        <td className="px-3 py-2 sticky left-0 bg-blue-50 text-blue-700">
                          Total Budget
                        </td>
                        {grid.platformNames.map((pName) => {
                          const colTotal = grid.rows.reduce(
                            (sum, row) =>
                              sum + (row.platforms[pName] ?? 0),
                            0,
                          );
                          return (
                            <td
                              key={pName}
                              className="px-3 py-2 text-right text-blue-700 whitespace-nowrap"
                            >
                              {formatCurrency(colTotal, currency)}
                            </td>
                          );
                        })}
                        <td className="px-3 py-2 text-right text-blue-700 whitespace-nowrap">
                          {formatCurrency(editedTotal, currency)}
                        </td>
                      </tr>
                    </tfoot>
                  </table>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {generateError && (
        <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-4">
          <p className="text-sm text-destructive flex items-start gap-2">
            <AlertTriangle size={14} className="mt-0.5 flex-shrink-0" />
            {generateError}
          </p>
        </div>
      )}

      {downloadFiles && downloadFiles.length > 0 && (
        <div className="border border-border rounded-xl bg-card p-5 space-y-3">
          <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide">
            Download PDFs
          </h2>
          <div className="flex flex-wrap gap-2">
            {downloadFiles.map((f) => (
              <a
                key={f.filename}
                href={`${basePath}${f.url}`}
                download={f.filename}
                className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-secondary px-3 py-2 text-sm font-medium hover:bg-secondary/70 transition-colors"
              >
                <Download size={14} />
                {f.channelName}
              </a>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

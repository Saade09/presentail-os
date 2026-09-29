import { useState, useCallback, useEffect } from "react";
import { apiFetch } from "@/lib/queryClient";
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
import { cn } from "@/lib/utils";
import {
  ChevronDown,
  ChevronUp,
  Plus,
  Trash2,
  Download,
  AlertTriangle,
  CheckCircle2,
  Save,
  FolderOpen,
  X,
  RefreshCw,
  Copy,
  Pencil,
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

type SavedConfig = {
  id: number;
  name: string;
  month: number;
  year: number;
  start_date: string;
  end_date: string;
  channels: Array<{
    name: string;
    salesTarget: number;
    marketingBudgetPct: number;
    platforms: Array<{ name: string; allocation: number }>;
  }>;
  created_at: string;
  updated_at: string;
};

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

function getMonthEnd(year: number, month: number): string {
  return new Date(year, month, 0).toISOString().split("T")[0];
}

function getCurrentYM(): { year: number; month: number } {
  const now = new Date();
  return { year: now.getFullYear(), month: now.getMonth() + 1 };
}

function formatConfigDate(iso: string): string {
  return new Date(iso).toLocaleDateString("en-GB", {
    day: "2-digit", month: "short", year: "numeric",
  });
}

export default function BudgetPlanner() {
  const { year: curYear, month: curMonth } = getCurrentYM();

  const [month, setMonth] = useState(curMonth);
  const [year, setYear] = useState(curYear);
  const [currency, setCurrency] = useState<string>(
    () => localStorage.getItem("budgetPlanner.currency") ?? "AED"
  );
  const [startDate, setStartDate] = useState(
    `${curYear}-${String(curMonth).padStart(2, "0")}-01`
  );
  const [endDate, setEndDate] = useState(getMonthEnd(curYear, curMonth));

  const [channels, setChannels] = useState<ChannelConfig[]>(
    CHANNEL_NAMES.map(defaultChannel)
  );

  const [advancedMode, setAdvancedMode] = useState(false);

  const [grids, setGrids] = useState<ChannelGrid[] | null>(null);
  const [editedGrids, setEditedGrids] = useState<ChannelGrid[] | null>(null);

  const [loading, setLoading] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [errors, setErrors] = useState<string[]>([]);
  const [generateError, setGenerateError] = useState<string | null>(null);
  const [lastGeneratedGrid, setLastGeneratedGrid] = useState<ChannelGrid[] | null>(null);
  const [downloadFiles, setDownloadFiles] = useState<DownloadFile[] | null>(null);

  const [savedConfigs, setSavedConfigs] = useState<SavedConfig[]>([]);
  const [configsLoading, setConfigsLoading] = useState(false);
  const [showSavedConfigs, setShowSavedConfigs] = useState(false);
  const [saveMode, setSaveMode] = useState<"none" | "new" | "update">("none");
  const [saveName, setSaveName] = useState("");
  const [activeConfigId, setActiveConfigId] = useState<number | null>(null);
  const [activeConfigName, setActiveConfigName] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<number | null>(null);
  const [duplicatingId, setDuplicatingId] = useState<number | null>(null);
  const [renamingId, setRenamingId] = useState<number | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [renameSaving, setRenameSaving] = useState(false);

  const loadConfigs = useCallback(async () => {
    setConfigsLoading(true);
    try {
      const data = await apiFetch<{ configs: SavedConfig[] }>("/api/budget/configs");
      setSavedConfigs(data.configs);
    } catch {
      // silently ignore
    } finally {
      setConfigsLoading(false);
    }
  }, []);

  useEffect(() => {
    loadConfigs();
  }, [loadConfigs]);

  function handleMonthYearChange(newMonth: number, newYear: number) {
    setMonth(newMonth);
    setYear(newYear);
    const start = `${newYear}-${String(newMonth).padStart(2, "0")}-01`;
    const end = getMonthEnd(newYear, newMonth);
    setStartDate(start);
    setEndDate(end);
    setGrids(null);
    setEditedGrids(null);
    setDownloadFiles(null);
  }

  function updateChannel(idx: number, partial: Partial<ChannelConfig>) {
    setChannels((prev) => prev.map((c, i) => (i === idx ? { ...c, ...partial } : c)));
  }

  function addPlatform(chIdx: number) {
    setChannels((prev) =>
      prev.map((c, i) =>
        i === chIdx ? { ...c, platforms: [...c.platforms, newPlatform()] } : c
      )
    );
  }

  function removePlatform(chIdx: number, pId: string) {
    setChannels((prev) =>
      prev.map((c, i) =>
        i === chIdx
          ? { ...c, platforms: c.platforms.filter((p) => p.id !== pId) }
          : c
      )
    );
  }

  function updatePlatform(chIdx: number, pId: string, partial: Partial<Platform>) {
    setChannels((prev) =>
      prev.map((c, i) =>
        i === chIdx
          ? {
              ...c,
              platforms: c.platforms.map((p) =>
                p.id === pId ? { ...p, ...partial } : p
              ),
            }
          : c
      )
    );
  }

  function loadConfig(cfg: SavedConfig) {
    handleMonthYearChange(cfg.month, cfg.year);
    setStartDate(cfg.start_date);
    setEndDate(cfg.end_date);
    setChannels(
      cfg.channels.map((ch) => ({
        name: ch.name,
        salesTarget: String(ch.salesTarget),
        marketingBudgetPct: String(ch.marketingBudgetPct),
        platforms: ch.platforms.map((p) => ({
          id: crypto.randomUUID(),
          name: p.name,
          allocation: String(p.allocation),
        })),
        open: true,
      }))
    );
    setActiveConfigId(cfg.id);
    setActiveConfigName(cfg.name);
    setShowSavedConfigs(false);
    setGrids(null);
    setEditedGrids(null);
    setDownloadFiles(null);
    setErrors([]);
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

  async function handleSaveNew() {
    if (!saveName.trim()) {
      setSaveError("Please enter a name for this configuration.");
      return;
    }
    setSaving(true);
    setSaveError(null);
    try {
      const data = await apiFetch<{ config: SavedConfig }>("/api/budget/configs", {
        method: "POST",
        body: JSON.stringify({
          name: saveName.trim(),
          month,
          year,
          startDate,
          endDate,
          channels: buildChannelPayload(),
        }),
      });
      setSavedConfigs((prev) => [data.config, ...prev]);
      setActiveConfigId(data.config.id);
      setActiveConfigName(data.config.name);
      setSaveMode("none");
      setSaveName("");
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : "Failed to save configuration.");
    } finally {
      setSaving(false);
    }
  }

  async function handleUpdateExisting() {
    if (!activeConfigId) return;
    setSaving(true);
    setSaveError(null);
    try {
      const data = await apiFetch<{ config: SavedConfig }>(`/api/budget/configs/${activeConfigId}`, {
        method: "PUT",
        body: JSON.stringify({
          name: activeConfigName ?? saveName.trim(),
          month,
          year,
          startDate,
          endDate,
          channels: buildChannelPayload(),
        }),
      });
      setSavedConfigs((prev) =>
        prev.map((c) => (c.id === data.config.id ? data.config : c))
      );
      setSaveMode("none");
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : "Failed to update configuration.");
    } finally {
      setSaving(false);
    }
  }

  async function handleDeleteConfig(id: number) {
    setDeletingId(id);
    try {
      await apiFetch(`/api/budget/configs/${id}`, { method: "DELETE" });
      setSavedConfigs((prev) => prev.filter((c) => c.id !== id));
      if (activeConfigId === id) {
        setActiveConfigId(null);
        setActiveConfigName(null);
      }
    } catch {
      // silently ignore
    } finally {
      setDeletingId(null);
    }
  }

  async function handleDuplicateConfig(cfg: SavedConfig) {
    setDuplicatingId(cfg.id);
    try {
      const copyName = `Copy of ${cfg.name}`;
      const data = await apiFetch<{ config: SavedConfig }>("/api/budget/configs", {
        method: "POST",
        body: JSON.stringify({
          name: copyName,
          month: cfg.month,
          year: cfg.year,
          startDate: cfg.start_date,
          endDate: cfg.end_date,
          channels: cfg.channels,
        }),
      });
      const newConfig = data.config;
      setSavedConfigs((prev) => [newConfig, ...prev]);
      handleMonthYearChange(newConfig.month, newConfig.year);
      setStartDate(newConfig.start_date);
      setEndDate(newConfig.end_date);
      setChannels(
        newConfig.channels.map((ch) => ({
          name: ch.name,
          salesTarget: String(ch.salesTarget),
          marketingBudgetPct: String(ch.marketingBudgetPct),
          platforms: ch.platforms.map((p) => ({
            id: crypto.randomUUID(),
            name: p.name,
            allocation: String(p.allocation),
          })),
          open: true,
        }))
      );
      setActiveConfigId(newConfig.id);
      setActiveConfigName(newConfig.name);
      setSaveMode("none");
      setSaveName(copyName);
    } catch {
      // silently ignore
    } finally {
      setDuplicatingId(null);
    }
  }

  async function handleRenameConfig(id: number) {
    const trimmed = renameValue.trim();
    if (!trimmed) return;
    setRenameSaving(true);
    try {
      const data = await apiFetch<{ config: SavedConfig }>(`/api/budget/configs/${id}`, {
        method: "PATCH",
        body: JSON.stringify({ name: trimmed }),
      });
      setSavedConfigs((prev) =>
        prev.map((c) => (c.id === data.config.id ? { ...c, name: data.config.name, updated_at: data.config.updated_at } : c))
      );
      if (activeConfigId === id) {
        setActiveConfigName(data.config.name);
      }
      setRenamingId(null);
      setRenameValue("");
    } catch {
      // silently ignore
    } finally {
      setRenameSaving(false);
    }
  }

  function validateForm(): string[] {
    const errs: string[] = [];
    if (!startDate || !endDate) errs.push("Date range is required.");
    if (new Date(startDate) > new Date(endDate))
      errs.push("Start date must be before or equal to end date.");

    channels.forEach((ch) => {
      if (!ch.salesTarget || isNaN(parseFloat(ch.salesTarget)) || parseFloat(ch.salesTarget) <= 0)
        errs.push(`${ch.name}: Sales target must be a positive number.`);
      if (
        ch.marketingBudgetPct === "" ||
        isNaN(parseFloat(ch.marketingBudgetPct)) ||
        parseFloat(ch.marketingBudgetPct) < 0 ||
        parseFloat(ch.marketingBudgetPct) > 100
      )
        errs.push(`${ch.name}: Marketing budget must be between 0 and 100.`);
      if (ch.platforms.length === 0)
        errs.push(`${ch.name}: At least one platform is required.`);
      ch.platforms.forEach((p, pi) => {
        if (!p.name.trim())
          errs.push(`${ch.name} Platform #${pi + 1}: Name is required.`);
        if (p.allocation === "" || isNaN(parseFloat(p.allocation)))
          errs.push(`${ch.name} Platform #${pi + 1}: Allocation is required.`);
      });
      const allocTotal = getAllocTotal(ch.platforms);
      if (Math.abs(allocTotal - 100) > 0.01)
        errs.push(`${ch.name}: Platform allocations must sum to 100% (currently ${allocTotal.toFixed(1)}%).`);
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
      const data = await apiFetch<{ channels: ChannelGrid[] }>("/api/budget/calculate", {
        method: "POST",
        body: JSON.stringify(body),
      });
      return data.channels;
    } catch (err) {
      setErrors([err instanceof Error ? err.message : "Calculation failed"]);
      return null;
    } finally {
      setLoading(false);
    }
  }

  async function handleGenerate(gridData: ChannelGrid[]) {
    setGenerating(true);
    setGenerateError(null);
    setLastGeneratedGrid(gridData);
    try {
      const data = await apiFetch<{ files: DownloadFile[] }>("/api/budget/generate", {
        method: "POST",
        body: JSON.stringify({ month, year, currency, channels: gridData }),
      });
      setDownloadFiles(data.files);
    } catch (err) {
      setGenerateError(err instanceof Error ? err.message : "PDF generation failed");
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
    value: string
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

  const basePath = (import.meta.env.BASE_URL as string).replace(/\/$/, "");

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between flex-wrap gap-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Budget Planner</h1>
          <p className="text-muted-foreground text-sm mt-1">
            Configure monthly ad spend budgets and generate per-channel PDFs.
          </p>
          {activeConfigName && (
            <p className="text-sm text-blue-600 mt-1 font-medium flex items-center gap-1.5">
              <FolderOpen size={13} />
              Loaded: {activeConfigName}
            </p>
          )}
        </div>
        <div className="flex items-center gap-3">
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

      {/* Saved Configurations Panel */}
      <div className="border border-border rounded-xl bg-card overflow-hidden">
        <button
          className="w-full flex items-center justify-between px-5 py-3.5 text-left hover:bg-secondary/50 transition-colors"
          onClick={() => {
            setShowSavedConfigs((v) => !v);
            if (!showSavedConfigs) loadConfigs();
          }}
        >
          <div className="flex items-center gap-2">
            <FolderOpen size={15} className="text-muted-foreground" />
            <span className="text-sm font-medium">Saved Configurations</span>
            {savedConfigs.length > 0 && (
              <Badge variant="secondary" className="text-xs">
                {savedConfigs.length}
              </Badge>
            )}
          </div>
          {showSavedConfigs ? (
            <ChevronUp size={16} className="text-muted-foreground" />
          ) : (
            <ChevronDown size={16} className="text-muted-foreground" />
          )}
        </button>

        {showSavedConfigs && (
          <div className="border-t border-border px-5 py-4 space-y-3">
            <div className="flex items-center justify-between">
              <p className="text-xs text-muted-foreground">
                {savedConfigs.length === 0
                  ? "No saved configurations yet. Save the current form below."
                  : "Click Load to restore a configuration into the form."}
              </p>
              <Button
                variant="ghost"
                size="sm"
                className="h-7 gap-1.5 text-xs"
                onClick={loadConfigs}
                disabled={configsLoading}
              >
                <RefreshCw size={12} className={configsLoading ? "animate-spin" : ""} />
                Refresh
              </Button>
            </div>

            {configsLoading && (
              <p className="text-sm text-muted-foreground py-2">Loading…</p>
            )}

            {!configsLoading && savedConfigs.length > 0 && (
              <div className="space-y-2 max-h-64 overflow-y-auto pr-1">
                {savedConfigs.map((cfg) => (
                  <div
                    key={cfg.id}
                    className={cn(
                      "flex items-center justify-between gap-3 rounded-lg border px-4 py-2.5",
                      activeConfigId === cfg.id
                        ? "border-blue-300 bg-blue-50"
                        : "border-border bg-background"
                    )}
                  >
                    <div className="min-w-0 flex-1">
                      {renamingId === cfg.id ? (
                        <div className="flex items-center gap-1.5">
                          <Input
                            autoFocus
                            value={renameValue}
                            onChange={(e) => setRenameValue(e.target.value)}
                            onKeyDown={(e) => {
                              if (e.key === "Enter") handleRenameConfig(cfg.id);
                              if (e.key === "Escape") {
                                setRenamingId(null);
                                setRenameValue("");
                              }
                            }}
                            className="h-7 text-sm px-2 py-0"
                            disabled={renameSaving}
                          />
                          <Button
                            size="sm"
                            variant="ghost"
                            className="h-7 w-7 p-0 text-green-600 hover:text-green-700"
                            title="Save name"
                            onClick={() => handleRenameConfig(cfg.id)}
                            disabled={renameSaving || !renameValue.trim()}
                          >
                            {renameSaving ? (
                              <RefreshCw size={11} className="animate-spin" />
                            ) : (
                              <Check size={11} />
                            )}
                          </Button>
                          <Button
                            size="sm"
                            variant="ghost"
                            className="h-7 w-7 p-0 text-muted-foreground hover:text-foreground"
                            title="Cancel"
                            onClick={() => {
                              setRenamingId(null);
                              setRenameValue("");
                            }}
                            disabled={renameSaving}
                          >
                            <X size={11} />
                          </Button>
                        </div>
                      ) : (
                        <>
                          <p className="text-sm font-medium truncate">{cfg.name}</p>
                          <p className="text-xs text-muted-foreground">
                            {MONTH_NAMES[cfg.month - 1]} {cfg.year} · Updated {formatConfigDate(cfg.updated_at)}
                          </p>
                        </>
                      )}
                    </div>
                    {renamingId !== cfg.id && (
                      <div className="flex items-center gap-1.5 flex-shrink-0">
                        <Button
                          size="sm"
                          variant={activeConfigId === cfg.id ? "default" : "outline"}
                          className="h-7 text-xs gap-1"
                          onClick={() => loadConfig(cfg)}
                        >
                          <FolderOpen size={11} />
                          {activeConfigId === cfg.id ? "Loaded" : "Load"}
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          className="h-7 w-7 p-0 text-muted-foreground hover:text-foreground"
                          title="Rename"
                          onClick={() => {
                            setRenamingId(cfg.id);
                            setRenameValue(cfg.name);
                          }}
                        >
                          <Pencil size={12} />
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          className="h-7 w-7 p-0 text-muted-foreground hover:text-foreground"
                          title="Duplicate"
                          onClick={() => handleDuplicateConfig(cfg)}
                          disabled={duplicatingId === cfg.id}
                        >
                          {duplicatingId === cfg.id ? (
                            <RefreshCw size={12} className="animate-spin" />
                          ) : (
                            <Copy size={12} />
                          )}
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          className="h-7 w-7 p-0 text-destructive hover:text-destructive"
                          onClick={() => handleDeleteConfig(cfg.id)}
                          disabled={deletingId === cfg.id}
                        >
                          {deletingId === cfg.id ? (
                            <RefreshCw size={12} className="animate-spin" />
                          ) : (
                            <Trash2 size={12} />
                          )}
                        </Button>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>

      <div className="border border-border rounded-xl bg-card p-5 space-y-4">
        <h2 className="text-base font-semibold">Budget Period</h2>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-4">
          <div className="space-y-1.5">
            <Label>Month</Label>
            <select
              className="w-full border border-border rounded-md px-3 py-2 text-sm bg-background"
              value={month}
              onChange={(e) => handleMonthYearChange(parseInt(e.target.value), year)}
            >
              {MONTH_NAMES.map((m, i) => (
                <option key={m} value={i + 1}>{m}</option>
              ))}
            </select>
          </div>
          <div className="space-y-1.5">
            <Label>Year</Label>
            <Input
              type="number"
              value={year}
              min={2000}
              max={2100}
              onChange={(e) => {
                const y = parseInt(e.target.value);
                if (!isNaN(y)) handleMonthYearChange(month, y);
              }}
            />
          </div>
          <div className="space-y-1.5">
            <Label>Currency</Label>
            <select
              className="w-full border border-border rounded-md px-3 py-2 text-sm bg-background"
              value={currency}
              onChange={(e) => {
                setCurrency(e.target.value);
                localStorage.setItem("budgetPlanner.currency", e.target.value);
              }}
            >
              {CURRENCIES.map((c) => (
                <option key={c.code} value={c.code}>{c.label}</option>
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
              onChange={(e) => {
                setEndDate(e.target.value);
                setGrids(null);
                setEditedGrids(null);
                setDownloadFiles(null);
              }}
            />
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
                        <Badge variant="secondary" className="text-xs text-green-700 bg-green-50 border-green-200">
                          <CheckCircle2 size={11} className="mr-1" />
                          Allocations OK
                        </Badge>
                      ) : (
                        <Badge variant="secondary" className="text-xs text-amber-700 bg-amber-50 border-amber-200">
                          <AlertTriangle size={11} className="mr-1" />
                          {allocTotal.toFixed(1)}% / 100%
                        </Badge>
                      )}
                    </div>
                    {ch.open ? <ChevronUp size={16} className="text-muted-foreground" /> : <ChevronDown size={16} className="text-muted-foreground" />}
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
                          onChange={(e) => updateChannel(chIdx, { salesTarget: e.target.value })}
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
                          onChange={(e) => updateChannel(chIdx, { marketingBudgetPct: e.target.value })}
                        />
                      </div>
                    </div>

                    <div className="space-y-3">
                      <div className="flex items-center justify-between">
                        <Label className="text-sm font-medium">Ad Platforms</Label>
                        <span
                          className={cn(
                            "text-xs font-medium",
                            allocOk ? "text-green-600" : "text-amber-600"
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
                              updatePlatform(chIdx, p.id, { name: e.target.value })
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
                                updatePlatform(chIdx, p.id, { allocation: e.target.value })
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
            <p key={i} className="text-sm text-destructive flex items-start gap-2">
              <AlertTriangle size={14} className="mt-0.5 flex-shrink-0" />
              {e}
            </p>
          ))}
        </div>
      )}

      {/* Save / Update Configuration */}
      <div className="border border-border rounded-xl bg-card p-5 space-y-3">
        <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide">
          Save Configuration
        </h2>

        {saveMode === "none" && (
          <div className="flex flex-wrap gap-2">
            {activeConfigId && (
              <Button
                variant="outline"
                size="sm"
                className="gap-1.5"
                onClick={handleUpdateExisting}
                disabled={saving}
              >
                <Save size={13} />
                {saving ? "Saving…" : `Update "${activeConfigName}"`}
              </Button>
            )}
            <Button
              variant="outline"
              size="sm"
              className="gap-1.5"
              onClick={() => {
                setSaveMode("new");
                setSaveName("");
                setSaveError(null);
              }}
            >
              <Save size={13} />
              Save as New…
            </Button>
          </div>
        )}

        {saveMode === "new" && (
          <div className="space-y-2">
            <div className="flex items-center gap-2">
              <Input
                placeholder="Configuration name (e.g. May 2026 Q2 Plan)"
                value={saveName}
                onChange={(e) => setSaveName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") handleSaveNew();
                  if (e.key === "Escape") setSaveMode("none");
                }}
                autoFocus
                className="flex-1"
              />
              <Button
                size="sm"
                onClick={handleSaveNew}
                disabled={saving || !saveName.trim()}
                className="gap-1.5"
              >
                <Save size={13} />
                {saving ? "Saving…" : "Save"}
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => setSaveMode("none")}
                disabled={saving}
              >
                <X size={14} />
              </Button>
            </div>
            {saveError && (
              <p className="text-sm text-destructive flex items-center gap-1.5">
                <AlertTriangle size={13} />
                {saveError}
              </p>
            )}
          </div>
        )}
      </div>

      {!advancedMode && (
        <div className="flex items-center gap-3">
          <Button
            onClick={handleStandardSubmit}
            disabled={loading || generating}
            className="gap-2"
          >
            {loading ? "Calculating…" : generating ? "Generating PDFs…" : "Generate PDFs"}
          </Button>
        </div>
      )}

      {advancedMode && !grids && (
        <div className="flex items-center gap-3">
          <Button
            onClick={handleAdvancedCalculate}
            disabled={loading}
            className="gap-2"
          >
            {loading ? "Calculating…" : "Calculate & Preview"}
          </Button>
        </div>
      )}

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
              <div key={grid.channelName} className="border border-border rounded-xl overflow-hidden">
                <div className="px-5 py-3 bg-secondary/30 flex items-center justify-between flex-wrap gap-2">
                  <span className="font-semibold text-sm">{grid.channelName}</span>
                  <div className="flex items-center gap-3 text-sm">
                    <span className="text-muted-foreground">
                      Calculated: <strong>{formatCurrency(calcTotal, currency)}</strong>
                    </span>
                    <span className={cn("font-medium", isDiverging ? "text-amber-600" : "text-green-600")}>
                      {isDiverging && <AlertTriangle size={13} className="inline mr-1" />}
                      Edited: <strong>{formatCurrency(editedTotal, currency)}</strong>
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
                          <th key={pName} className="text-right px-3 py-2 font-medium border-b border-border whitespace-nowrap min-w-[110px]">
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
                        const rowTotal = Object.values(row.platforms).reduce(
                          (s, v) => s + v,
                          0
                        );
                        return (
                          <tr
                            key={row.date}
                            className={cn(
                              "border-b border-border/50",
                              rowIdx % 2 === 1 ? "bg-secondary/20" : ""
                            )}
                          >
                            <td className="px-3 py-1.5 font-medium text-muted-foreground sticky left-0 bg-inherit whitespace-nowrap">
                              {new Date(row.date + "T00:00:00Z").toLocaleDateString("en-GB", {
                                day: "2-digit", month: "short", year: "numeric", timeZone: "UTC",
                              })}
                            </td>
                            {grid.platformNames.map((pName) => (
                              <td key={pName} className="px-2 py-1 text-right">
                                <Input
                                  type="number"
                                  min={0}
                                  step={0.01}
                                  value={row.platforms[pName] ?? 0}
                                  onChange={(e) =>
                                    updateEditedCell(chIdx, rowIdx, pName, e.target.value)
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
                            (sum, row) => sum + (row.platforms[pName] ?? 0),
                            0
                          );
                          return (
                            <td key={pName} className="px-3 py-2 text-right text-blue-700 whitespace-nowrap">
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
        <div className="rounded-xl border border-red-200 bg-red-50 p-5 space-y-3" role="alert">
          <div className="flex items-center gap-2 text-red-700 font-semibold text-sm">
            <AlertTriangle size={17} />
            PDF generation failed
          </div>
          <p className="text-sm text-red-600">{generateError}</p>
          <Button
            variant="outline"
            size="sm"
            className="gap-1.5 border-red-300 text-red-700 hover:bg-red-100"
            onClick={() => lastGeneratedGrid && handleGenerate(lastGeneratedGrid)}
            disabled={generating}
          >
            <RefreshCw size={13} />
            Retry
          </Button>
        </div>
      )}

      {downloadFiles && downloadFiles.length > 0 && (
        <div className="rounded-xl border border-green-200 bg-green-50 p-5 space-y-3">
          <div className="flex items-center gap-2 text-green-700 font-semibold text-sm">
            <CheckCircle2 size={17} />
            PDFs generated successfully
          </div>
          <div className="space-y-2">
            {downloadFiles.map((f) => (
              <a
                key={f.filename}
                href={`${basePath}${f.url}`}
                download={f.filename}
                className="flex items-center gap-2 text-sm text-blue-700 hover:underline"
              >
                <Download size={14} />
                {f.channelName} — {f.filename}
              </a>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

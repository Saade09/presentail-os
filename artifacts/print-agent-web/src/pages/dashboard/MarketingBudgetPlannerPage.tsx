import { useState, useEffect, useRef } from "react";
import { useQueryClient, useQuery } from "@tanstack/react-query";
import { useLocation } from "wouter";
import {
  useListMarketingBudgets,
  useCreateMarketingBudget,
  useDeleteMarketingBudget,
  usePatchMarketingBudget,
  getListMarketingBudgetsQueryKey,
  type MarketingBudget,
  type CreateMarketingBudget as CreateMarketingBudgetPayload,
  type PatchMarketingBudget as PatchMarketingBudgetPayload,
} from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Calendar } from "@/components/ui/calendar";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { useToast } from "@/hooks/use-toast";
import { apiFetch } from "@/lib/queryClient";
import { CalendarIcon, Plus, PieChart, AlertTriangle, ExternalLink, Trash2, Pencil } from "lucide-react";
import { cn } from "@/lib/utils";
import type { DateRange } from "react-day-picker";

const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

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

function getCurrentYM(): { year: number; month: number } {
  const now = new Date();
  return { year: now.getFullYear(), month: now.getMonth() + 1 };
}

function getMonthEnd(year: number, month: number): string {
  const d = new Date(year, month, 0);
  return localDateStr(d);
}

function localDateStr(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function toYMD(d: Date): string {
  return localDateStr(d);
}

function monthStart(year: number, month: number): Date {
  return new Date(year, month - 1, 1);
}

function monthEnd(year: number, month: number): Date {
  return new Date(year, month, 0);
}

function formatDateDisplay(dateStr: string): string {
  if (!dateStr) return "";
  const d = new Date(dateStr + "T00:00:00Z");
  if (isNaN(d.getTime())) return dateStr;
  return d.toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric", timeZone: "UTC" });
}

function buildQuickMonths(): { label: string; year: number; month: number }[] {
  const now = new Date();
  const results: { label: string; year: number; month: number }[] = [];
  for (let offset = -1; offset <= 4; offset++) {
    const d = new Date(now.getFullYear(), now.getMonth() + offset, 1);
    results.push({
      label: d.toLocaleString("en-US", { month: "short", year: "numeric" }),
      year: d.getFullYear(),
      month: d.getMonth() + 1,
    });
  }
  return results;
}

const QUICK_MONTHS = buildQuickMonths();

function buildNext6Months(): { label: string; shortLabel: string; year: number; month: number }[] {
  const now = new Date();
  const results: { label: string; shortLabel: string; year: number; month: number }[] = [];
  for (let offset = 0; offset < 6; offset++) {
    const d = new Date(now.getFullYear(), now.getMonth() + offset, 1);
    results.push({
      label: d.toLocaleString("en-US", { month: "long", year: "numeric" }),
      shortLabel: d.toLocaleString("en-US", { month: "short" }),
      year: d.getFullYear(),
      month: d.getMonth() + 1,
    });
  }
  return results;
}

const NEXT_6_MONTHS = buildNext6Months();

function CreateBudgetModal({
  open,
  onClose,
  onCreated,
  existingBudgets = [],
}: {
  open: boolean;
  onClose: () => void;
  onCreated: (id: number) => void;
  existingBudgets?: MarketingBudget[];
}) {
  const { year: curYear, month: curMonth } = getCurrentYM();

  type Mode = "monthly" | "custom";
  const [mode, setMode] = useState<Mode>("monthly");
  const [selMonth, setSelMonth] = useState<{ year: number; month: number } | null>({
    year: curYear,
    month: curMonth,
  });
  const [name, setName] = useState("");
  const lastAutoSuggest = useRef("");
  const [customStart, setCustomStart] = useState("");
  const [customEnd, setCustomEnd] = useState("");
  const [currency, setCurrency] = useState("AED");
  const [nameError, setNameError] = useState("");
  const [periodError, setPeriodError] = useState("");
  const [endDateError, setEndDateError] = useState("");
  const [submitError, setSubmitError] = useState("");
  const [startCalOpen, setStartCalOpen] = useState(false);
  const [endCalOpen, setEndCalOpen] = useState(false);
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const { data: erSettingsData } = useQuery({
    queryKey: ["exchange-rate-settings"],
    queryFn: () =>
      apiFetch<{ base_currency?: string }>("/api/exchange-rates/settings").catch(() => null),
    staleTime: 5 * 60 * 1000,
  });

  const workspaceCurrencyRef = useRef("AED");
  useEffect(() => {
    const bc = erSettingsData?.base_currency;
    workspaceCurrencyRef.current =
      bc && CURRENCIES.some((c) => c.code === bc) ? bc : "AED";
  }, [erSettingsData]);

  function buildAutoName(year: number, month: number) {
    const monthName = new Date(year, month - 1, 1).toLocaleString("en-US", { month: "long" });
    return `${monthName} ${year} Marketing Budget`;
  }

  useEffect(() => {
    if (open) {
      setMode("monthly");
      setSelMonth({ year: curYear, month: curMonth });
      const autoName = buildAutoName(curYear, curMonth);
      setName(autoName);
      lastAutoSuggest.current = autoName;
      setCustomStart("");
      setCustomEnd("");
      setCurrency(workspaceCurrencyRef.current);
      setNameError("");
      setPeriodError("");
      setEndDateError("");
      setSubmitError("");
      setStartCalOpen(false);
      setEndCalOpen(false);
    }
  }, [open]);

  const mutation = useCreateMarketingBudget({
    mutation: {
      onSuccess: (data) => {
        queryClient.invalidateQueries({ queryKey: getListMarketingBudgetsQueryKey() });
        toast({ title: "Marketing budget created" });
        onCreated(data.budget.id);
      },
      onError: (e: Error) => {
        setSubmitError(e.message || "Failed to create budget");
      },
    },
  });

  const startDate =
    mode === "monthly" && selMonth
      ? toYMD(monthStart(selMonth.year, selMonth.month))
      : customStart;
  const endDate =
    mode === "monthly" && selMonth
      ? toYMD(monthEnd(selMonth.year, selMonth.month))
      : customEnd;

  function handleMonthSelect(year: number, month: number) {
    setSelMonth({ year, month });
    const autoName = buildAutoName(year, month);
    setName((prev) => {
      if (!prev || prev === lastAutoSuggest.current) {
        return autoName;
      }
      return prev;
    });
    lastAutoSuggest.current = autoName;
    setPeriodError("");
  }

  function handleModeChange(newMode: Mode) {
    setMode(newMode);
    setPeriodError("");
    setEndDateError("");
  }

  function handleNameChange(val: string) {
    setName(val);
    if (nameError && val.trim()) setNameError("");
  }

  function handleCustomStartChange(val: string) {
    setCustomStart(val);
    setPeriodError("");
    if (val && customEnd && new Date(val) <= new Date(customEnd)) setEndDateError("");
  }

  function handleCustomEndChange(val: string) {
    setCustomEnd(val);
    if (customStart && val) {
      if (new Date(customStart) > new Date(val)) {
        setEndDateError("End date must be on or after start date.");
      } else {
        setEndDateError("");
      }
    }
  }

  const isMonthlyValid = mode === "monthly" && selMonth != null;
  const isCustomValid =
    mode === "custom" &&
    !!customStart &&
    !!customEnd &&
    new Date(customStart) <= new Date(customEnd);
  const isPeriodValid = mode === "monthly" ? isMonthlyValid : isCustomValid;
  const isFormValid = !!name.trim() && isPeriodValid && !!currency;

  const isDuplicate =
    isPeriodValid &&
    existingBudgets.some(
      (b) => b.start_date === startDate && b.end_date === endDate && b.currency === currency
    );

  function handleSubmit() {
    let hasError = false;
    if (!name.trim()) {
      setNameError("Budget name is required.");
      hasError = true;
    }
    if (mode === "monthly" && !selMonth) {
      setPeriodError("Please select a month.");
      hasError = true;
    }
    if (mode === "custom") {
      if (!customStart || !customEnd) {
        setPeriodError("Both start and end dates are required.");
        hasError = true;
      } else if (new Date(customStart) > new Date(customEnd)) {
        setEndDateError("End date must be on or after start date.");
        hasError = true;
      }
    }
    if (hasError) return;
    setSubmitError("");
    mutation.mutate({
      data: {
        name: name.trim(),
        startDate,
        endDate,
        currency,
      } satisfies CreateMarketingBudgetPayload,
    });
  }

  function handleClose() {
    onClose();
  }

  const summaryPeriod =
    mode === "monthly" && selMonth
      ? `${new Date(selMonth.year, selMonth.month - 1, 1).toLocaleString("en-US", { month: "long" })} ${selMonth.year}`
      : startDate && endDate
      ? `${formatDateDisplay(startDate)} – ${formatDateDisplay(endDate)}`
      : "—";

  const currencyObj = CURRENCIES.find((c) => c.code === currency);

  return (
    <Dialog open={open} onOpenChange={(v) => !v && handleClose()}>
      <DialogContent
        className="sm:max-w-2xl max-h-[90vh] overflow-y-auto"
        onInteractOutside={(e) => e.preventDefault()}
        onEscapeKeyDown={(e) => e.preventDefault()}
      >
        <DialogHeader>
          <DialogTitle>New marketing budget</DialogTitle>
          <DialogDescription>
            Set up a new marketing budget by choosing a period and currency.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-5">
          {/* Budget details */}
          <div className="space-y-3">
            <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Budget details</p>
            <div className="space-y-1.5">
              <Label htmlFor="budget-name">Budget name</Label>
              <Input
                id="budget-name"
                placeholder="e.g. May 2026 Marketing Budget"
                value={name}
                onChange={(e) => handleNameChange(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") handleSubmit(); }}
                autoFocus
              />
              {nameError && (
                <p className="text-xs text-destructive flex items-center gap-1">
                  <AlertTriangle size={12} className="shrink-0" />
                  {nameError}
                </p>
              )}
            </div>
          </div>

          <div className="border-t border-border" />

          {/* Budget period */}
          <div className="space-y-3">
            <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Budget period</p>

            <div className="inline-flex rounded-lg border border-border bg-secondary/30 p-1 gap-1">
              <button
                type="button"
                onClick={() => handleModeChange("monthly")}
                className={cn(
                  "px-4 py-1.5 rounded-md text-sm font-medium transition-colors",
                  mode === "monthly"
                    ? "bg-background text-foreground shadow-sm"
                    : "text-muted-foreground hover:text-foreground"
                )}
              >
                Monthly budget
              </button>
              <button
                type="button"
                onClick={() => handleModeChange("custom")}
                className={cn(
                  "px-4 py-1.5 rounded-md text-sm font-medium transition-colors",
                  mode === "custom"
                    ? "bg-background text-foreground shadow-sm"
                    : "text-muted-foreground hover:text-foreground"
                )}
              >
                Custom range
              </button>
            </div>

            {mode === "monthly" && (
              <div className="grid grid-cols-3 gap-2">
                {NEXT_6_MONTHS.map(({ label, shortLabel, year, month }) => {
                  const isSelected = selMonth?.year === year && selMonth?.month === month;
                  const isCurrent = year === curYear && month === curMonth;
                  return (
                    <button
                      key={label}
                      type="button"
                      onClick={() => handleMonthSelect(year, month)}
                      className={cn(
                        "relative flex flex-col items-center justify-center rounded-lg border px-3 py-3 text-sm font-medium transition-colors",
                        isSelected
                          ? "border-primary bg-primary text-primary-foreground"
                          : "border-border bg-background hover:bg-secondary/60 text-foreground"
                      )}
                    >
                      <span className="font-semibold">{shortLabel}</span>
                      <span
                        className={cn(
                          "text-xs mt-0.5",
                          isSelected ? "text-primary-foreground/70" : "text-muted-foreground"
                        )}
                      >
                        {year}
                      </span>
                      {isCurrent && !isSelected && (
                        <span className="absolute top-1.5 right-2 text-[10px] text-primary font-semibold leading-none">
                          Now
                        </span>
                      )}
                    </button>
                  );
                })}
              </div>
            )}

            {mode === "custom" && (
              <div className="space-y-3">
                <div className="grid grid-cols-2 gap-3">
                  <div className="space-y-1.5">
                    <Label>Start date</Label>
                    <Button
                      type="button"
                      variant="outline"
                      className={cn(
                        "w-full justify-start text-left font-normal gap-2",
                        !customStart && "text-muted-foreground"
                      )}
                      onClick={() => {
                        setStartCalOpen((v) => !v);
                        setEndCalOpen(false);
                      }}
                    >
                      <CalendarIcon size={14} className="shrink-0 text-muted-foreground" />
                      {customStart ? formatDateDisplay(customStart) : "Pick start date"}
                    </Button>
                  </div>
                  <div className="space-y-1.5">
                    <Label>End date</Label>
                    <Button
                      type="button"
                      variant="outline"
                      className={cn(
                        "w-full justify-start text-left font-normal gap-2",
                        !customEnd && "text-muted-foreground"
                      )}
                      onClick={() => {
                        setEndCalOpen((v) => !v);
                        setStartCalOpen(false);
                      }}
                    >
                      <CalendarIcon size={14} className="shrink-0 text-muted-foreground" />
                      {customEnd ? formatDateDisplay(customEnd) : "Pick end date"}
                    </Button>
                    {endDateError && (
                      <p className="text-xs text-destructive flex items-center gap-1">
                        <AlertTriangle size={12} className="shrink-0" />
                        {endDateError}
                      </p>
                    )}
                  </div>
                </div>
                {startCalOpen && (
                  <div className="flex justify-start">
                    <div className="rounded-lg border border-border bg-popover shadow-sm">
                      <Calendar
                        mode="single"
                        selected={customStart ? new Date(customStart + "T00:00:00") : undefined}
                        onSelect={(date) => {
                          handleCustomStartChange(date ? toYMD(date) : "");
                          setStartCalOpen(false);
                        }}
                      />
                    </div>
                  </div>
                )}
                {endCalOpen && (
                  <div className="flex justify-end">
                    <div className="rounded-lg border border-border bg-popover shadow-sm">
                      <Calendar
                        mode="single"
                        selected={customEnd ? new Date(customEnd + "T00:00:00") : undefined}
                        onSelect={(date) => {
                          handleCustomEndChange(date ? toYMD(date) : "");
                          setEndCalOpen(false);
                        }}
                        fromDate={customStart ? new Date(customStart + "T00:00:00") : undefined}
                      />
                    </div>
                  </div>
                )}
              </div>
            )}

            {periodError && (
              <p className="text-xs text-destructive flex items-center gap-1">
                <AlertTriangle size={12} className="shrink-0" />
                {periodError}
              </p>
            )}
          </div>

          <div className="border-t border-border" />

          {/* Currency */}
          <div className="space-y-3">
            <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Currency</p>
            <select
              className="w-full border border-border rounded-md px-3 py-2 text-sm bg-background"
              value={currency}
              onChange={(e) => setCurrency(e.target.value)}
            >
              {CURRENCIES.map((c) => (
                <option key={c.code} value={c.code}>{c.label}</option>
              ))}
            </select>
          </div>

          <div className="border-t border-border" />

          {/* Budget summary */}
          <div className="space-y-3">
            <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Budget summary</p>
            <div className="rounded-lg border border-border bg-secondary/20 px-4 py-3 grid grid-cols-2 gap-x-4 gap-y-2.5 text-sm">
              <div>
                <p className="text-xs text-muted-foreground mb-0.5">Period</p>
                <p className="font-medium">{summaryPeriod}</p>
              </div>
              <div>
                <p className="text-xs text-muted-foreground mb-0.5">Currency</p>
                <p className="font-medium">{currencyObj?.label ?? currency}</p>
              </div>
              {startDate && endDate && (
                <div className="col-span-2">
                  <p className="text-xs text-muted-foreground mb-0.5">Date range</p>
                  <p className="font-medium">
                    {formatDateDisplay(startDate)} – {formatDateDisplay(endDate)}
                  </p>
                </div>
              )}
            </div>
          </div>

          {isDuplicate && (
            <div className="rounded-lg border border-amber-200 bg-amber-50 dark:border-amber-900 dark:bg-amber-950/30 p-3 flex items-start gap-2">
              <AlertTriangle size={14} className="text-amber-600 dark:text-amber-400 mt-0.5 shrink-0" />
              <p className="text-sm text-amber-700 dark:text-amber-300">
                A budget with this period and currency already exists. You can still create it, but it may be a duplicate.
              </p>
            </div>
          )}

          {submitError && (
            <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-3">
              <p className="text-sm text-destructive flex items-start gap-2">
                <AlertTriangle size={13} className="mt-0.5 flex-shrink-0" />
                {submitError}
              </p>
            </div>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={handleClose} disabled={mutation.isPending}>
            Cancel
          </Button>
          <Button onClick={handleSubmit} disabled={mutation.isPending || !isFormValid}>
            {mutation.isPending ? "Creating…" : "Create marketing budget"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

type EditBudgetForm = {
  name: string;
  startDate: string;
  endDate: string;
  currency: string;
};

function EditBudgetModal({
  open,
  budget,
  onClose,
  onSaved,
}: {
  open: boolean;
  budget: MarketingBudget | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [form, setForm] = useState<EditBudgetForm>({
    name: "",
    startDate: "",
    endDate: "",
    currency: "AED",
  });
  const [errors, setErrors] = useState<string[]>([]);
  const [calendarOpen, setCalendarOpen] = useState(false);
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const mutation = usePatchMarketingBudget({
    mutation: {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getListMarketingBudgetsQueryKey() });
        toast({ title: "Marketing budget updated" });
        onSaved();
      },
      onError: (e: Error) => {
        setErrors([e.message || "Failed to update budget"]);
      },
    },
  });

  useEffect(() => {
    if (open && budget) {
      setForm({
        name: budget.name,
        startDate: budget.start_date,
        endDate: budget.end_date,
        currency: budget.currency,
      });
      setErrors([]);
      setCalendarOpen(false);
    }
  }, [open, budget?.id]);

  function validate(): string[] {
    const errs: string[] = [];
    if (!form.name.trim()) errs.push("Budget name is required.");
    if (!form.startDate) errs.push("Start date is required.");
    if (!form.endDate) errs.push("End date is required.");
    if (form.startDate && form.endDate && new Date(form.startDate) > new Date(form.endDate)) {
      errs.push("End date must be on or after start date.");
    }
    if (!form.currency) errs.push("Currency is required.");
    return errs;
  }

  function handleSubmit() {
    if (!budget) return;
    const errs = validate();
    if (errs.length > 0) {
      setErrors(errs);
      return;
    }
    setErrors([]);
    mutation.mutate({
      id: budget.id,
      data: {
        name: form.name.trim(),
        startDate: form.startDate,
        endDate: form.endDate,
        currency: form.currency,
      } satisfies PatchMarketingBudgetPayload,
    });
  }

  function handleClose() {
    setErrors([]);
    setCalendarOpen(false);
    onClose();
  }

  const calendarRange: DateRange | undefined =
    form.startDate || form.endDate
      ? {
          from: form.startDate ? new Date(form.startDate + "T00:00:00") : undefined,
          to: form.endDate ? new Date(form.endDate + "T00:00:00") : undefined,
        }
      : undefined;

  function handleRangeSelect(range: DateRange | undefined) {
    setForm((prev) => ({
      ...prev,
      startDate: range?.from ? toYMD(range.from) : "",
      endDate: range?.to ? toYMD(range.to) : "",
    }));
  }

  function handleQuickMonth(year: number, month: number) {
    setForm((prev) => ({
      ...prev,
      startDate: toYMD(monthStart(year, month)),
      endDate: toYMD(monthEnd(year, month)),
    }));
    setCalendarOpen(false);
  }

  const rangeLabel =
    form.startDate && form.endDate
      ? `${formatDateDisplay(form.startDate)} – ${formatDateDisplay(form.endDate)}`
      : form.startDate
      ? `From ${formatDateDisplay(form.startDate)}`
      : "Pick a date range";

  return (
    <Dialog open={open} onOpenChange={(v) => !v && handleClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Edit marketing budget</DialogTitle>
          <DialogDescription>
            Update the name, period, or currency for this budget.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="edit-budget-name">Budget name</Label>
            <Input
              id="edit-budget-name"
              placeholder="e.g. May 2026 Q2 Campaign"
              value={form.name}
              onChange={(e) => setForm((prev) => ({ ...prev, name: e.target.value }))}
              onKeyDown={(e) => { if (e.key === "Enter") handleSubmit(); }}
              autoFocus
            />
          </div>

          <div className="space-y-1.5">
            <Label>Budget period</Label>
            <Popover open={calendarOpen} onOpenChange={setCalendarOpen}>
              <PopoverTrigger asChild>
                <Button
                  variant="outline"
                  className={cn(
                    "w-full justify-start text-left font-normal gap-2",
                    !form.startDate && !form.endDate && "text-muted-foreground"
                  )}
                >
                  <CalendarIcon size={15} className="text-muted-foreground shrink-0" />
                  <span className="truncate">{rangeLabel}</span>
                </Button>
              </PopoverTrigger>
              <PopoverContent className="w-auto p-0" align="start">
                <div className="p-3 border-b border-border">
                  <p className="text-xs text-muted-foreground mb-2 font-medium uppercase tracking-wide">Quick select month</p>
                  <div className="flex flex-wrap gap-1.5">
                    {QUICK_MONTHS.map(({ label, year, month }) => {
                      const isSelected =
                        form.startDate === toYMD(monthStart(year, month)) &&
                        form.endDate === toYMD(monthEnd(year, month));
                      return (
                        <Button
                          key={label}
                          size="sm"
                          variant={isSelected ? "default" : "outline"}
                          className="h-7 text-xs px-2.5"
                          onClick={() => handleQuickMonth(year, month)}
                        >
                          {label}
                        </Button>
                      );
                    })}
                  </div>
                </div>
                <Calendar
                  mode="range"
                  selected={calendarRange}
                  onSelect={handleRangeSelect}
                  numberOfMonths={1}
                  defaultMonth={form.startDate ? new Date(form.startDate + "T00:00:00") : new Date()}
                />
              </PopoverContent>
            </Popover>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="edit-budget-start">Start date</Label>
              <Input
                id="edit-budget-start"
                type="date"
                value={form.startDate}
                onChange={(e) => setForm((prev) => ({ ...prev, startDate: e.target.value }))}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="edit-budget-end">End date</Label>
              <Input
                id="edit-budget-end"
                type="date"
                value={form.endDate}
                onChange={(e) => setForm((prev) => ({ ...prev, endDate: e.target.value }))}
              />
            </div>
          </div>

          <div className="space-y-1.5">
            <Label>Currency</Label>
            <select
              className="w-full border border-border rounded-md px-3 py-2 text-sm bg-background"
              value={form.currency}
              onChange={(e) => setForm((prev) => ({ ...prev, currency: e.target.value }))}
            >
              {CURRENCIES.map((c) => (
                <option key={c.code} value={c.code}>{c.label}</option>
              ))}
            </select>
          </div>

          {errors.length > 0 && (
            <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-3 space-y-1">
              {errors.map((e, i) => (
                <p key={i} className="text-sm text-destructive flex items-start gap-2">
                  <AlertTriangle size={13} className="mt-0.5 flex-shrink-0" />
                  {e}
                </p>
              ))}
            </div>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={handleClose} disabled={mutation.isPending}>
            Cancel
          </Button>
          <Button onClick={handleSubmit} disabled={mutation.isPending}>
            {mutation.isPending ? "Saving…" : "Save changes"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export default function MarketingBudgetPlannerPage() {
  const [, setLocation] = useLocation();
  const [createOpen, setCreateOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<MarketingBudget | null>(null);
  const [editTarget, setEditTarget] = useState<MarketingBudget | null>(null);

  const { data, isLoading, isError } = useListMarketingBudgets();
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const budgets = data?.budgets ?? [];

  const deleteMutation = useDeleteMarketingBudget({
    mutation: {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getListMarketingBudgetsQueryKey() });
        toast({ title: "Budget deleted" });
        setDeleteTarget(null);
      },
      onError: (e: Error) => {
        toast({ title: "Failed to delete", description: e.message, variant: "destructive" });
      },
    },
  });

  function handleCreated(id: number) {
    setCreateOpen(false);
    setLocation(`/marketing-budget-planner/${id}`);
  }

  function formatPeriod(b: MarketingBudget): string {
    if (b.start_date && b.end_date) {
      const startFmt = new Date(b.start_date + "T00:00:00Z").toLocaleDateString("en-GB", {
        day: "2-digit", month: "short", year: "numeric", timeZone: "UTC",
      });
      const endFmt = new Date(b.end_date + "T00:00:00Z").toLocaleDateString("en-GB", {
        day: "2-digit", month: "short", year: "numeric", timeZone: "UTC",
      });
      if (startFmt !== "Invalid Date" && endFmt !== "Invalid Date") {
        return `${startFmt} – ${endFmt}`;
      }
    }
    const monthName = MONTH_NAMES[b.month - 1];
    return `${monthName} ${b.year}`;
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between flex-wrap gap-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Marketing Budget Planner</h1>
          <p className="text-muted-foreground text-sm mt-1">
            Plan and manage monthly ad spend budgets across channels.
          </p>
        </div>
        <Button onClick={() => setCreateOpen(true)} className="gap-2">
          <Plus size={16} />
          New marketing budget
        </Button>
      </div>

      {isLoading && (
        <div className="flex items-center justify-center py-16 text-muted-foreground">
          Loading…
        </div>
      )}

      {isError && (
        <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-4 text-sm text-destructive">
          Failed to load marketing budgets. Please refresh and try again.
        </div>
      )}

      {!isLoading && !isError && budgets.length === 0 && (
        <div className="flex flex-col items-center justify-center py-20 text-center border border-dashed border-border rounded-xl bg-secondary/20">
          <PieChart size={36} className="text-muted-foreground/40 mb-3" />
          <p className="font-medium text-foreground">No marketing budgets yet</p>
          <p className="text-sm text-muted-foreground mt-1 mb-4">
            Create your first marketing budget to start planning ad spend.
          </p>
          <Button onClick={() => setCreateOpen(true)} className="gap-2">
            <Plus size={15} />
            Create marketing budget
          </Button>
        </div>
      )}

      {!isLoading && !isError && budgets.length > 0 && (
        <div className="border border-border rounded-xl overflow-hidden bg-card">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-secondary/40 border-b border-border">
                <th className="text-left px-5 py-3 font-medium">Name</th>
                <th className="text-left px-5 py-3 font-medium">Period</th>
                <th className="text-left px-5 py-3 font-medium">Currency</th>
                <th className="text-left px-5 py-3 font-medium">Status</th>
                <th className="px-5 py-3" />
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {budgets.map((b) => (
                <tr
                  key={b.id}
                  className={cn(
                    "hover:bg-secondary/20 transition-colors cursor-pointer",
                  )}
                  onClick={() => setLocation(`/marketing-budget-planner/${b.id}`)}
                >
                  <td className="px-5 py-3.5 font-medium">{b.name}</td>
                  <td className="px-5 py-3.5 text-muted-foreground whitespace-nowrap">
                    {formatPeriod(b)}
                  </td>
                  <td className="px-5 py-3.5 text-muted-foreground">{b.currency}</td>
                  <td className="px-5 py-3.5">
                    <StatusBadge status={b.status} />
                  </td>
                  <td className="px-5 py-3.5 text-right">
                    <div className="flex items-center justify-end gap-1">
                      <Button
                        variant="ghost"
                        size="sm"
                        className="gap-1.5 text-xs"
                        onClick={(e) => {
                          e.stopPropagation();
                          setLocation(`/marketing-budget-planner/${b.id}`);
                        }}
                      >
                        <ExternalLink size={13} />
                        Open
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="gap-1.5 text-xs"
                        onClick={(e) => {
                          e.stopPropagation();
                          setEditTarget(b);
                        }}
                      >
                        <Pencil size={13} />
                        Edit
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="text-destructive hover:text-destructive hover:bg-destructive/10"
                        onClick={(e) => {
                          e.stopPropagation();
                          setDeleteTarget(b);
                        }}
                      >
                        <Trash2 size={14} />
                      </Button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <CreateBudgetModal
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        onCreated={handleCreated}
        existingBudgets={budgets}
      />

      <EditBudgetModal
        open={!!editTarget}
        budget={editTarget}
        onClose={() => setEditTarget(null)}
        onSaved={() => setEditTarget(null)}
      />

      <Dialog open={!!deleteTarget} onOpenChange={(v) => { if (!v) setDeleteTarget(null); }}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>Delete budget?</DialogTitle>
            <DialogDescription>
              This will permanently delete{" "}
              <span className="font-medium text-foreground">{deleteTarget?.name}</span>.
              This action cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setDeleteTarget(null)}
              disabled={deleteMutation.isPending}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              disabled={deleteMutation.isPending}
              onClick={() => {
                if (deleteTarget) deleteMutation.mutate({ id: deleteTarget.id });
              }}
            >
              {deleteMutation.isPending ? "Deleting…" : "Delete"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

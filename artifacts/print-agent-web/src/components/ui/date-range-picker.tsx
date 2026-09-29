import { useId, useMemo, useRef, useState } from "react";
import { CalendarIcon, X } from "lucide-react";
import type { DateRange, Matcher } from "react-day-picker";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Calendar } from "@/components/ui/calendar";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  Drawer,
  DrawerContent,
  DrawerDescription,
  DrawerHeader,
  DrawerTitle,
  DrawerTrigger,
} from "@/components/ui/drawer";
import { useIsMobile } from "@/hooks/use-mobile";
import { useTranslation } from "react-i18next";
import { ar, enUS } from "date-fns/locale";

export type DateRangeValue = { from: string; to: string };
export type DateRangeDraft = Partial<DateRangeValue>;
export type DateRangePresetKey =
  | "today"
  | "yesterday"
  | "this_week"
  | "this_month"
  | "last_month"
  | "custom";

export type DateRangePreset = {
  key: DateRangePresetKey;
  label?: string;
};

export type DateRangePickerLabels = Partial<{
  trigger: string;
  title: string;
  description: string;
  startDate: string;
  endDate: string;
  chooseStart: string;
  chooseEnd: string;
  selectedRange: string;
  incompleteRange: string;
  invalidRange: string;
  cancel: string;
  apply: string;
  clear: string;
  custom: string;
  previousMonth: string;
  nextMonth: string;
  clearRange: string;
  rangeStartState: string;
  rangeEndState: string;
  inRangeState: string;
  todayState: string;
  unavailableState: string;
  outsideMonthState: string;
}>;

type DateRangePickerProps = {
  /** The committed range. Draft calendar changes never mutate this value. */
  value: DateRangeDraft;
  /** Legacy callback: when onApply is absent, this remains an auto-apply picker. */
  onChange?: (range: DateRangeDraft) => void;
  /** Explicit apply mode used by filters that must not fetch until Apply. */
  onApply?: (range: DateRangeValue) => void;
  onCancel?: () => void;
  placeholder?: string;
  className?: string;
  disabled?: boolean;
  timezone?: string;
  weekStartsOn?: 0 | 1 | 6;
  minDate?: string;
  maxDate?: string;
  presets?: DateRangePreset[];
  labels?: DateRangePickerLabels;
  allowClear?: boolean;
  /** Use the compact quick-select + calendar presentation on desktop. */
  compact?: boolean;
  "data-testid"?: string;
};

const DEFAULT_TIMEZONE = "UTC";
const DEFAULT_PRESETS: DateRangePreset[] = [
  { key: "today" },
  { key: "yesterday" },
  { key: "this_week" },
  { key: "this_month" },
  { key: "last_month" },
  { key: "custom" },
];

const DEFAULT_LABELS: Required<DateRangePickerLabels> = {
  trigger: "Select date range",
  title: "Date range",
  description: "Choose a reporting period.",
  startDate: "From",
  endDate: "To",
  chooseStart: "Select a start date",
  chooseEnd: "Select an end date",
  selectedRange: "Selected range",
  incompleteRange: "Select an end date to complete the range.",
  invalidRange: "The end date cannot be before the start date.",
  cancel: "Cancel",
  apply: "Apply",
  clear: "Clear",
  custom: "Custom range",
  previousMonth: "Previous month",
  nextMonth: "Next month",
  clearRange: "Clear date range",
  rangeStartState: "selected range start",
  rangeEndState: "selected range end",
  inRangeState: "in selected range",
  todayState: "today",
  unavailableState: "unavailable",
  outsideMonthState: "outside current month",
};

const pad = (n: number) => String(n).padStart(2, "0");

function parseDateString(value: string): Date | undefined {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return undefined;
  return new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
}

function dateString(date: Date): string {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function startOfMonth(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), 1);
}

function addMonths(date: Date, amount: number): Date {
  return new Date(date.getFullYear(), date.getMonth() + amount, 1);
}

/**
 * react-day-picker's controlled month is the first (left) month. Anchor the
 * pair from the range end so the selected period is visible on the right.
 */
export function getPickerStartMonth(
  range: DateRangeDraft,
  options: { timezone?: string; now?: Date } = {},
): Date {
  const rightMonth = startOfMonth(
    parseDateString(range.to || "") ??
      parseDateString(todayInTimezone(options.timezone ?? DEFAULT_TIMEZONE, options.now)) ??
      new Date(),
  );
  return addMonths(rightMonth, -1);
}

function addDays(value: string, amount: number): string {
  const date = parseDateString(value) ?? new Date();
  date.setDate(date.getDate() + amount);
  return dateString(date);
}

function datePartsInTimezone(now: Date, timezone: string): { year: number; month: number; day: number } {
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      year: "numeric",
      month: "numeric",
      day: "numeric",
    }).formatToParts(now);
    return {
      year: Number(parts.find((part) => part.type === "year")?.value),
      month: Number(parts.find((part) => part.type === "month")?.value),
      day: Number(parts.find((part) => part.type === "day")?.value),
    };
  } catch {
    const local = new Date(now);
    return { year: local.getFullYear(), month: local.getMonth() + 1, day: local.getDate() };
  }
}

export function todayInTimezone(timezone = DEFAULT_TIMEZONE, now = new Date()): string {
  const parts = datePartsInTimezone(now, timezone);
  return `${parts.year}-${pad(parts.month)}-${pad(parts.day)}`;
}

export function getPresetDates(
  preset: Exclude<DateRangePresetKey, "custom">,
  options: { timezone?: string; weekStartsOn?: 0 | 1 | 6; now?: Date } = {},
): DateRangeValue {
  const timezone = options.timezone ?? DEFAULT_TIMEZONE;
  const weekStartsOn = options.weekStartsOn ?? 0;
  const today = todayInTimezone(timezone, options.now);
  const todayDate = parseDateString(today) ?? new Date();

  if (preset === "today") return { from: today, to: today };
  if (preset === "yesterday") {
    const yesterday = addDays(today, -1);
    return { from: yesterday, to: yesterday };
  }
  if (preset === "this_month") {
    const monthStart = `${todayDate.getFullYear()}-${pad(todayDate.getMonth() + 1)}-01`;
    return { from: monthStart, to: today };
  }
  if (preset === "last_month") {
    const monthStart = new Date(todayDate.getFullYear(), todayDate.getMonth() - 1, 1);
    const monthEnd = new Date(todayDate.getFullYear(), todayDate.getMonth(), 0);
    return { from: dateString(monthStart), to: dateString(monthEnd) };
  }

  const dayOfWeek = todayDate.getDay();
  const offset = (dayOfWeek - weekStartsOn + 7) % 7;
  return { from: addDays(today, -offset), to: today };
}

export function detectDateRangePreset(
  range: DateRangeDraft,
  options: { timezone?: string; weekStartsOn?: 0 | 1 | 6; now?: Date } = {},
): DateRangePresetKey {
  if (!range.from || !range.to) return "custom";
  const presetKeys: Exclude<DateRangePresetKey, "custom">[] = [
    "today", "yesterday", "this_week", "this_month", "last_month",
  ];
  return presetKeys.find((key) => {
    const expected = getPresetDates(key, options);
    return expected.from === range.from && expected.to === range.to;
  }) ?? "custom";
}

function formatCalendarDate(
  value: string,
  locale: string,
  options: Intl.DateTimeFormatOptions = { day: "numeric", month: "short", year: "numeric" },
): string {
  const date = parseDateString(value);
  if (!date) return value;
  return new Intl.DateTimeFormat(locale || "en-US", {
    timeZone: "UTC",
    ...options,
  }).format(new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate())));
}

export function formatDateRangeLabel(
  range: DateRangeDraft,
  locale = "en-US",
  incompleteLabel = "Select an end date",
): string {
  if (!range.from && !range.to) return "";
  if (!range.from || !range.to) {
    return `${formatCalendarDate(range.from || range.to || "", locale)} – ${incompleteLabel}`;
  }
  if (range.from === range.to) return formatCalendarDate(range.from, locale);
  const from = parseDateString(range.from);
  const to = parseDateString(range.to);
  if (from && to && from.getFullYear() === to.getFullYear()) {
    return `${formatCalendarDate(range.from, locale, { day: "numeric", month: "short" })} – ${formatCalendarDate(range.to, locale)}`;
  }
  return `${formatCalendarDate(range.from, locale)} – ${formatCalendarDate(range.to, locale)}`;
}

function getPresetLabel(
  preset: DateRangePreset,
  labels: Required<DateRangePickerLabels>,
  t: (key: string, options?: { defaultValue?: string }) => string,
): string {
  if (preset.label) return preset.label;
  if (preset.key === "custom") return labels.custom;
  return t(`dateRangePicker.presets.${preset.key}`, { defaultValue: preset.key.replace("_", " ") });
}

function DateRangePanel({
  pending,
  onPendingChange,
  onCancel,
  onApply,
  timezone,
  weekStartsOn,
  minDate,
  maxDate,
  presets,
  labels,
  mobile,
  compact,
  titleId,
}: {
  pending: DateRangeDraft;
  onPendingChange: (range: DateRangeDraft) => void;
  onCancel: () => void;
  onApply: () => void;
  timezone: string;
  weekStartsOn: 0 | 1 | 6;
  minDate?: string;
  maxDate?: string;
  presets: DateRangePreset[];
  labels: Required<DateRangePickerLabels>;
  mobile: boolean;
  compact: boolean;
  titleId: string;
}) {
  const { t, i18n } = useTranslation();
  const [month, setMonth] = useState<Date>(() => {
    return getPickerStartMonth(pending, { timezone });
  });
  const startRef = useRef<HTMLButtonElement>(null);
  const calendarRef = useRef<HTMLDivElement>(null);
  const currentPreset = detectDateRangePreset(pending, { timezone, weekStartsOn });
  const valid = !!pending.from && !!pending.to && pending.from <= pending.to;
  const dateRange = pending.from && pending.to
    ? `${pending.from} – ${pending.to}`
    : pending.from
      ? labels.incompleteRange
      : labels.chooseStart;
  const selected: DateRange | undefined = pending.from
    ? {
        from: parseDateString(pending.from),
        to: pending.to ? parseDateString(pending.to) : undefined,
      }
    : undefined;

  const disabled: Matcher[] = useMemo(() => {
    const matchers: Matcher[] = [];
    const minimum = minDate ? parseDateString(minDate) : undefined;
    const maximum = maxDate ? parseDateString(maxDate) : undefined;
    if (minimum) matchers.push({ before: minimum });
    if (maximum) matchers.push({ after: maximum });
    if (pending.from && !pending.to) {
      const start = parseDateString(pending.from);
      if (start) matchers.push({ before: start });
    }
    // Keep outside days visible for a stable grid, but never let filler dates
    // participate in selection or range interactions.
    const visibleMonthCount = mobile ? 1 : 2;
    matchers.push((date) => {
      const dateMonth = date.getFullYear() * 12 + date.getMonth();
      const firstMonth = month.getFullYear() * 12 + month.getMonth();
      return dateMonth < firstMonth || dateMonth >= firstMonth + visibleMonthCount;
    });
    return matchers;
  }, [maxDate, minDate, mobile, month, pending.from, pending.to]);

  function handleSelect(range: DateRange | undefined) {
    if (!range?.from) {
      onPendingChange({});
      return;
    }
    if (!pending.from || pending.to) {
      onPendingChange({ from: dateString(range.from), to: undefined });
      return;
    }
    const end = range.to ?? range.from;
    const endString = dateString(end);
    if (endString < pending.from) return;
    onPendingChange({ from: pending.from, to: endString });
  }

  function choosePreset(key: DateRangePresetKey) {
    if (key === "custom") {
      onPendingChange({ from: undefined, to: undefined });
      requestAnimationFrame(() => {
        (startRef.current ?? calendarRef.current?.querySelector<HTMLButtonElement>("button:not([disabled])"))?.focus();
      });
      return;
    }
    const nextRange = getPresetDates(key, { timezone, weekStartsOn });
    onPendingChange(nextRange);
    setMonth(getPickerStartMonth(nextRange, { timezone }));
  }

  return (
    <div
      className={cn("text-foreground", mobile ? "flex min-h-0 flex-1 flex-col" : "")}
    >
      {compact ? (
        <div className="sr-only">
          <h2 id={titleId}>{labels.title}</h2>
          <p id={`${titleId}-description`}>
            {pending.from && !pending.to ? labels.chooseEnd : labels.description}
          </p>
        </div>
      ) : (
        <div className="border-b px-4 py-3" data-testid="date-range-picker-header">
          <h2 id={titleId} className="text-sm font-semibold">{labels.title}</h2>
          <p id={`${titleId}-description`} className="mt-0.5 text-xs text-muted-foreground">
            {pending.from && !pending.to ? labels.chooseEnd : labels.description}
          </p>
        </div>
      )}
      <p className="sr-only" aria-live="polite">{dateRange}</p>

      <div className={cn(
        "flex min-h-0",
        mobile ? "flex-1 flex-col overflow-y-auto" : "flex-row",
      )}>
        <div className={cn(
          "shrink-0 border-e bg-muted/20 p-3",
          mobile ? "border-b border-e-0" : compact ? "w-28 p-2" : "w-36",
        )}>
          <p className="mb-2 text-[11px] font-semibold text-muted-foreground">
            {t("dateRangePicker.quickSelect", { defaultValue: "Quick select" })}
          </p>
          <div className={cn(mobile ? "flex gap-1.5 overflow-x-auto pb-1" : "space-y-0.5")}>
            {presets.map((preset) => {
              const active = currentPreset === preset.key;
              return (
                <button
                  key={preset.key}
                  type="button"
                  data-testid={`button-date-preset-${preset.key}`}
                  aria-pressed={active}
                  onClick={() => choosePreset(preset.key)}
                  className={cn(
                    "flex min-h-9 items-center gap-2 rounded-md px-2.5 text-start text-sm transition-colors",
                    "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal-600",
                    mobile ? "shrink-0 whitespace-nowrap" : "w-full",
                    compact && "min-h-8 gap-1.5 px-2 text-xs",
                    active
                      ? "bg-teal-100 font-medium text-teal-900"
                      : "text-foreground hover:bg-muted",
                  )}
                >
                  {getPresetLabel(preset, labels, t)}
                </button>
              );
            })}
          </div>
        </div>

        <div className={cn("min-w-0 flex-1", mobile ? "p-2" : compact ? "p-2" : "p-3")}>
          {!compact && (
            <div className="mb-2 grid grid-cols-2 gap-2" data-testid="date-range-picker-fields">
              <button
                ref={startRef}
                type="button"
                data-testid="button-date-range-start"
                onClick={() => onPendingChange({ from: undefined, to: undefined })}
                aria-label={`${labels.startDate}: ${pending.from ? formatCalendarDate(pending.from, i18n.language) : labels.chooseStart}`}
                className={cn(
                  "rounded-md border px-2.5 py-1.5 text-start text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal-600",
                  pending.from ? "border-teal-600 bg-teal-50" : "border-border",
                )}
              >
                <span className="block text-muted-foreground">{labels.startDate}</span>
                <span className="font-medium">{pending.from ? formatCalendarDate(pending.from, i18n.language) : "—"}</span>
              </button>
              <button
                type="button"
                data-testid="button-date-range-end"
                disabled={!pending.from}
                onClick={() => onPendingChange({ from: pending.from, to: undefined })}
                aria-label={`${labels.endDate}: ${pending.to ? formatCalendarDate(pending.to, i18n.language) : labels.chooseEnd}`}
                className={cn(
                  "rounded-md border px-2.5 py-1.5 text-start text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal-600",
                  pending.to ? "border-teal-600 bg-teal-50" : "border-border",
                  "disabled:cursor-not-allowed disabled:opacity-50",
                )}
              >
                <span className="block text-muted-foreground">{labels.endDate}</span>
                <span className="font-medium">{pending.to ? formatCalendarDate(pending.to, i18n.language) : "—"}</span>
              </button>
            </div>
          )}
          <div ref={calendarRef}>
            <Calendar
              mode="range"
              selected={selected}
              onSelect={handleSelect}
              month={month}
              onMonthChange={setMonth}
              numberOfMonths={mobile ? 1 : 2}
              weekStartsOn={weekStartsOn}
              disabled={disabled}
              initialFocus
              className={cn(
                mobile
                  ? "mx-auto w-full [--cell-size:2.45rem]"
                  : compact
                     ? "mx-auto [--cell-size:2rem] p-1 [&_.rdp-months]:gap-4"
                    : "[--cell-size:2rem]",
              )}
               showOutsideDays
              aria-label={labels.selectedRange}
              labels={{
                labelPrevious: () => labels.previousMonth,
                labelNext: () => labels.nextMonth,
              }}
              dayStateLabels={{
                rangeStart: labels.rangeStartState,
                rangeEnd: labels.rangeEndState,
                inRange: labels.inRangeState,
                today: labels.todayState,
                unavailable: labels.unavailableState,
                outsideMonth: labels.outsideMonthState,
              }}
              locale={i18n.language.startsWith("ar") ? ar : enUS}
              accessibilityLocale={i18n.language}
            />
          </div>
          {!valid && pending.from && pending.to && (
            <p className="px-2 text-xs text-destructive" role="alert">{labels.invalidRange}</p>
          )}
        </div>
      </div>

      <div className={cn(
        "flex items-center justify-between gap-3 border-t bg-background px-4 py-3",
        compact ? "px-3 py-2" : "",
        mobile ? "sticky bottom-0 pb-[max(0.75rem,env(safe-area-inset-bottom))]" : "",
      )}>
        <div className="min-w-0 text-xs text-muted-foreground">
          <span className="sr-only">{labels.selectedRange}: </span>
          <span className="truncate" data-testid="date-range-picker-selected-range">
            {formatDateRangeLabel(pending, i18n.language, labels.chooseEnd) || labels.chooseStart}
          </span>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Button type="button" variant="outline" size="sm" onClick={onCancel} data-testid="button-date-range-cancel">{labels.cancel}</Button>
          <Button
            type="button"
            size="sm"
            onClick={onApply}
            disabled={!valid}
            data-testid="button-date-range-apply"
            className="bg-teal-700 text-white hover:bg-teal-800 disabled:opacity-50"
          >
            {labels.apply}
          </Button>
        </div>
      </div>
    </div>
  );
}

export function DateRangePicker({
  value,
  onChange,
  onApply,
  onCancel,
  placeholder,
  className,
  disabled,
  timezone = DEFAULT_TIMEZONE,
  weekStartsOn = 0,
  minDate,
  maxDate,
  presets = DEFAULT_PRESETS,
  labels: labelOverrides,
  allowClear = true,
  compact = false,
  "data-testid": testId,
}: DateRangePickerProps) {
  const { t, i18n } = useTranslation();
  const isMobile = useIsMobile();
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState<DateRangeDraft>(value);
  const justApplied = useRef(false);
  const triggerId = useId();
  const panelId = `${triggerId}-panel`;
  const titleId = `${triggerId}-title`;
  const translatedLabels: Required<DateRangePickerLabels> = {
    trigger: t("dateRangePicker.trigger", { defaultValue: DEFAULT_LABELS.trigger }),
    title: t("dateRangePicker.title", { defaultValue: DEFAULT_LABELS.title }),
    description: t("dateRangePicker.description", { defaultValue: DEFAULT_LABELS.description }),
    startDate: t("dateRangePicker.startDate", { defaultValue: DEFAULT_LABELS.startDate }),
    endDate: t("dateRangePicker.endDate", { defaultValue: DEFAULT_LABELS.endDate }),
    chooseStart: t("dateRangePicker.chooseStart", { defaultValue: DEFAULT_LABELS.chooseStart }),
    chooseEnd: t("dateRangePicker.chooseEnd", { defaultValue: DEFAULT_LABELS.chooseEnd }),
    selectedRange: t("dateRangePicker.selectedRange", { defaultValue: DEFAULT_LABELS.selectedRange }),
    incompleteRange: t("dateRangePicker.incompleteRange", { defaultValue: DEFAULT_LABELS.incompleteRange }),
    invalidRange: t("dateRangePicker.invalidRange", { defaultValue: DEFAULT_LABELS.invalidRange }),
    cancel: t("dateRangePicker.cancel", { defaultValue: DEFAULT_LABELS.cancel }),
    apply: t("dateRangePicker.apply", { defaultValue: DEFAULT_LABELS.apply }),
    clear: t("dateRangePicker.clear", { defaultValue: DEFAULT_LABELS.clear }),
    custom: t("dateRangePicker.presets.custom", { defaultValue: DEFAULT_LABELS.custom }),
    previousMonth: t("dateRangePicker.previousMonth", { defaultValue: DEFAULT_LABELS.previousMonth }),
    nextMonth: t("dateRangePicker.nextMonth", { defaultValue: DEFAULT_LABELS.nextMonth }),
    clearRange: t("dateRangePicker.clearRange", { defaultValue: DEFAULT_LABELS.clearRange }),
    rangeStartState: t("dateRangePicker.dayStates.rangeStart", { defaultValue: DEFAULT_LABELS.rangeStartState }),
    rangeEndState: t("dateRangePicker.dayStates.rangeEnd", { defaultValue: DEFAULT_LABELS.rangeEndState }),
    inRangeState: t("dateRangePicker.dayStates.inRange", { defaultValue: DEFAULT_LABELS.inRangeState }),
    todayState: t("dateRangePicker.dayStates.today", { defaultValue: DEFAULT_LABELS.todayState }),
    unavailableState: t("dateRangePicker.dayStates.unavailable", { defaultValue: DEFAULT_LABELS.unavailableState }),
    outsideMonthState: t("dateRangePicker.dayStates.outsideMonth", { defaultValue: DEFAULT_LABELS.outsideMonthState }),
  };
  const labels = { ...translatedLabels, ...labelOverrides };
  const explicitApply = !!onApply;
  const hasRange = !!(value.from || value.to);
  const displayText = value.from && value.to
    ? formatDateRangeLabel(value, i18n.language, labels.chooseEnd)
    : value.from
      ? formatDateRangeLabel(value, i18n.language, labels.chooseEnd)
      : placeholder || labels.trigger;
  const triggerLabel = value.from && value.to
    ? displayText
    : value.from
      ? `${displayText}. ${labels.chooseEnd}`
      : placeholder || labels.trigger;

  function openPicker() {
    justApplied.current = false;
    setPending(value);
    setOpen(true);
  }

  function closeWithoutApplying() {
    setPending(value);
    setOpen(false);
    onCancel?.();
  }

  function handleOpenChange(nextOpen: boolean) {
    if (nextOpen) {
      openPicker();
      return;
    }
    if (justApplied.current) {
      justApplied.current = false;
      setOpen(false);
      return;
    }
    closeWithoutApplying();
  }

  function applyPending() {
    if (!pending.from || !pending.to || pending.from > pending.to) return;
    const next = { from: pending.from, to: pending.to };
    if (explicitApply) {
      justApplied.current = true;
      onApply(next);
      setOpen(false);
    } else {
      onChange?.(next);
      setOpen(false);
    }
  }

  const trigger = (
    <button
      id={triggerId}
      type="button"
      disabled={disabled}
      aria-haspopup="dialog"
      aria-expanded={open}
      aria-controls={open ? panelId : undefined}
      aria-label={triggerLabel}
      data-testid={testId}
      className={cn(
        "inline-flex min-h-9 items-center gap-2 rounded-md border bg-background px-3 py-1.5 text-sm shadow-sm transition-colors",
        "hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal-600 focus-visible:ring-offset-1",
        "disabled:pointer-events-none disabled:opacity-50",
        !hasRange && "text-muted-foreground",
        className,
      )}
    >
      <CalendarIcon className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
      <span className="truncate text-start">{displayText}</span>
    </button>
  );

  const panel = (
    <DateRangePanel
      pending={pending}
      onPendingChange={(next) => {
        setPending(next);
        if (!explicitApply) onChange?.(next);
      }}
      onCancel={closeWithoutApplying}
      onApply={applyPending}
      timezone={timezone}
      weekStartsOn={weekStartsOn}
      minDate={minDate}
      maxDate={maxDate}
      presets={presets}
      labels={labels}
      mobile={isMobile}
      compact={compact && !isMobile}
      titleId={titleId}
    />
  );

  return (
    <div className="inline-flex items-center gap-1">
      {isMobile ? (
        <Drawer open={open} onOpenChange={handleOpenChange}>
          <DrawerTrigger asChild>{trigger}</DrawerTrigger>
          <DrawerContent
            id={panelId}
            aria-labelledby={titleId}
            aria-describedby={`${titleId}-description`}
            className="max-h-[92dvh] overflow-hidden rounded-t-2xl p-0"
          >
            <DrawerHeader className="sr-only">
              <DrawerTitle>{labels.title}</DrawerTitle>
              <DrawerDescription>{labels.description}</DrawerDescription>
            </DrawerHeader>
            {panel}
          </DrawerContent>
        </Drawer>
      ) : (
        <Popover open={open} onOpenChange={handleOpenChange}>
          <PopoverTrigger asChild>{trigger}</PopoverTrigger>
          <PopoverContent
            id={panelId}
            aria-labelledby={titleId}
            aria-describedby={`${titleId}-description`}
            align="start"
            sideOffset={6}
            collisionPadding={8}
            className={cn(
              compact
                ? "w-auto max-w-[calc(100vw-1rem)]"
                : "w-[min(47rem,calc(100vw-1rem))]",
              "overflow-hidden p-0",
            )}
          >
            {panel}
          </PopoverContent>
        </Popover>
      )}
      {allowClear && hasRange && (
        <button
          type="button"
          aria-label={labels.clearRange}
          data-testid="button-date-range-clear-trigger"
          onClick={() => {
            setPending({});
            onChange?.({});
          }}
          className="inline-flex h-7 w-7 items-center justify-center rounded-full text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal-600"
        >
          <X className="h-3.5 w-3.5" aria-hidden="true" />
        </button>
      )}
    </div>
  );
}
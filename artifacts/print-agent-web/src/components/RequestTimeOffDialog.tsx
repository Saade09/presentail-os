import { useState, useEffect, useMemo } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/hooks/use-toast";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  useCreateTimeOffRequest,
  getGetTimeOffBalanceQueryKey,
  getListTimeOffRequestsQueryKey,
} from "@workspace/api-client-react";
import type { TimeOffBalance, PublicHolidayItem } from "@workspace/api-client-react";
import { AlertCircle, CalendarIcon, OctagonX, TriangleAlert, Info } from "lucide-react";
import type { DateRange } from "react-day-picker";
import { Calendar, CalendarDayButton } from "@/components/ui/calendar";
import { cn } from "@/lib/utils";
import { apiFetch } from "@/lib/queryClient";

type WorkingDaysConfig = {
  monday: boolean;
  tuesday: boolean;
  wednesday: boolean;
  thursday: boolean;
  friday: boolean;
  saturday: boolean;
  sunday: boolean;
};

type BlackoutDate = {
  id: number;
  name: string;
  start_date: string;
  end_date: string;
  restriction_type: "blocking" | "warning_only" | "manager_approval";
  employee_message: string | null;
};

const DEFAULT_WORKING_DAYS: WorkingDaysConfig = {
  monday: true,
  tuesday: true,
  wednesday: true,
  thursday: true,
  friday: true,
  saturday: false,
  sunday: false,
};

const DAY_KEYS: (keyof WorkingDaysConfig)[] = [
  "sunday",
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
];

type PartialDayOption = "full" | "morning" | "afternoon";

function toLocalDateString(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function todayLocal(): Date {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
}

function formatShortDate(dateStr: string): string {
  return new Date(dateStr + "T00:00:00").toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
}

function formatFullDate(dateStr: string): string {
  return new Date(dateStr + "T00:00:00").toLocaleDateString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
  });
}

function isValidDateString(s: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(s + "T00:00:00");
  return !isNaN(d.getTime());
}

interface RequestTimeOffDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  balance: TimeOffBalance | null;
  workingDays?: WorkingDaysConfig | null;
  publicHolidays?: PublicHolidayItem[] | null;
  approverName?: string | null;
}

export function RequestTimeOffDialog({
  open,
  onOpenChange,
  balance,
  workingDays,
  publicHolidays,
  approverName,
}: RequestTimeOffDialogProps) {
  const schedule = workingDays ?? DEFAULT_WORKING_DAYS;
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const todayStr = toLocalDateString(todayLocal());

  const [typeCode, setTypeCode] = useState<"VACATION" | "SICK_LEAVE">("VACATION");
  const [startInput, setStartInput] = useState(todayStr);
  const [endInput, setEndInput] = useState(todayStr);
  const [selectedRange, setSelectedRange] = useState<DateRange | undefined>(() => {
    const t = todayLocal();
    return { from: t, to: t };
  });
  const [startPartial, setStartPartial] = useState<PartialDayOption>("full");
  const [endPartial, setEndPartial] = useState<PartialDayOption>("full");
  const [reason, setReason] = useState("");
  const [calendarMonth, setCalendarMonth] = useState<Date>(() => {
    const t = todayLocal();
    return new Date(t.getFullYear(), t.getMonth(), 1);
  });

  useEffect(() => {
    if (open) {
      setTypeCode("VACATION");
      setStartInput(todayStr);
      setEndInput(todayStr);
      const t = todayLocal();
      setSelectedRange({ from: t, to: t });
      setCalendarMonth(new Date(t.getFullYear(), t.getMonth(), 1));
      setStartPartial("full");
      setEndPartial("full");
      setReason("");
    }
  }, [open, todayStr]);

  function syncCalendarFromInputs(newStart: string, newEnd: string) {
    if (isValidDateString(newStart) && isValidDateString(newEnd)) {
      const from = new Date(newStart + "T00:00:00");
      const to = new Date(newEnd + "T00:00:00");
      setSelectedRange({ from, to: to >= from ? to : from });
      setCalendarMonth(new Date(from.getFullYear(), from.getMonth(), 1));
    } else if (isValidDateString(newStart)) {
      const from = new Date(newStart + "T00:00:00");
      setSelectedRange({ from, to: from });
      setCalendarMonth(new Date(from.getFullYear(), from.getMonth(), 1));
    }
  }

  function handleStartInputChange(val: string) {
    setStartInput(val);
    if (isValidDateString(val)) {
      const newEnd = isValidDateString(endInput) && endInput >= val ? endInput : val;
      setEndInput(newEnd);
      syncCalendarFromInputs(val, newEnd);
      setStartPartial("full");
      setEndPartial("full");
    }
  }

  function handleEndInputChange(val: string) {
    setEndInput(val);
    if (isValidDateString(val)) {
      const newStart = isValidDateString(startInput) && startInput <= val ? startInput : val;
      setStartInput(newStart);
      syncCalendarFromInputs(newStart, val);
      setStartPartial("full");
      setEndPartial("full");
    }
  }

  function handleCalendarSelect(range: DateRange | undefined) {
    if (!range) return;
    setSelectedRange(range);
    if (range.from) setStartInput(toLocalDateString(range.from));
    if (range.to) setEndInput(toLocalDateString(range.to));
    else if (range.from) setEndInput(toLocalDateString(range.from));
    setStartPartial("full");
    setEndPartial("full");
  }

  const startDate = isValidDateString(startInput) ? startInput : "";
  const endDate = isValidDateString(endInput) ? endInput : startDate;

  const isSingleDay = !!startDate && startDate === endDate;

  const holidayDateSet = useMemo(() => {
    const set = new Set<string>();
    for (const h of publicHolidays ?? []) {
      const start = new Date(h.date + "T00:00:00");
      const end = h.end_date ? new Date(h.end_date + "T00:00:00") : new Date(h.date + "T00:00:00");
      const cursor = new Date(start);
      while (cursor <= end) {
        set.add(toLocalDateString(cursor));
        cursor.setDate(cursor.getDate() + 1);
      }
    }
    return set;
  }, [publicHolidays]);

  const hasPublicHolidays = holidayDateSet.size > 0;

  // Fetch all upcoming blackout dates for calendar visualization
  const { data: allBlackoutsData } = useQuery({
    queryKey: ["blackout-dates-upcoming"],
    queryFn: () =>
      apiFetch<{ success: boolean; blackout_dates: BlackoutDate[] }>(
        `/api/blackout-dates?date_from=${toLocalDateString(todayLocal())}`,
      ),
    staleTime: 5 * 60_000,
  });

  const blackoutDateSet = useMemo(() => {
    const set = new Set<string>();
    for (const b of allBlackoutsData?.blackout_dates ?? []) {
      const start = new Date(b.start_date + "T00:00:00");
      const end = new Date(b.end_date + "T00:00:00");
      const cursor = new Date(start);
      while (cursor <= end) {
        set.add(toLocalDateString(cursor));
        cursor.setDate(cursor.getDate() + 1);
      }
    }
    return set;
  }, [allBlackoutsData]);

  // Check blackout overlap for the selected date range (inline date-order check to avoid forward reference)
  const shouldCheckBlackout = !!startDate && !!endDate && startDate <= endDate;
  const { data: blackoutCheckData, isFetching: isCheckingBlackout } = useQuery({
    queryKey: ["blackout-check", startDate, endDate],
    queryFn: () =>
      apiFetch<{ success: boolean; overlapping: BlackoutDate[]; has_overlap: boolean }>(
        `/api/blackout-dates/check?start_date=${startDate}&end_date=${endDate}`,
      ),
    enabled: shouldCheckBlackout,
    staleTime: 60_000,
  });

  const overlappingBlackouts: BlackoutDate[] = blackoutCheckData?.overlapping ?? [];
  const blockingBlackouts = overlappingBlackouts.filter((b) => b.restriction_type === "blocking");
  const warningBlackouts = overlappingBlackouts.filter((b) => b.restriction_type === "warning_only");
  const approvalBlackouts = overlappingBlackouts.filter((b) => b.restriction_type === "manager_approval");
  const hasBlockingBlackout = blockingBlackouts.length > 0;

  const { mutateAsync: createRequest, isPending } = useCreateTimeOffRequest();

  const estimatedDays = useMemo(() => {
    if (!startDate || !endDate) return 0;
    const start = new Date(startDate + "T00:00:00");
    const end = new Date(endDate + "T00:00:00");
    if (start > end) return 0;
    let count = 0;
    const cursor = new Date(start);
    while (cursor <= end) {
      const dayKey = DAY_KEYS[cursor.getDay()];
      const dateStr = toLocalDateString(cursor);
      if (schedule[dayKey] && !holidayDateSet.has(dateStr)) count++;
      cursor.setDate(cursor.getDate() + 1);
    }
    if (isSingleDay) {
      if (startPartial !== "full" && count > 0) return 0.5;
      return count;
    }
    const startIsWorking =
      schedule[DAY_KEYS[new Date(startDate + "T00:00:00").getDay()]] &&
      !holidayDateSet.has(startDate);
    const endIsWorking =
      schedule[DAY_KEYS[new Date(endDate + "T00:00:00").getDay()]] &&
      !holidayDateSet.has(endDate);
    if (startPartial !== "full" && startIsWorking) count -= 0.5;
    if (endPartial !== "full" && endIsWorking) count -= 0.5;
    return Math.max(0, count);
  }, [startDate, endDate, isSingleDay, startPartial, endPartial, schedule, holidayDateSet]);

  const hasCustomSchedule = Object.keys(DEFAULT_WORKING_DAYS).some(
    (k) => schedule[k as keyof WorkingDaysConfig] !== DEFAULT_WORKING_DAYS[k as keyof WorkingDaysConfig],
  );

  const exceedsVacation =
    typeCode === "VACATION" &&
    balance != null &&
    estimatedDays > balance.vacation_remaining;

  const dateError =
    startDate && endDate && new Date(startDate + "T00:00:00") > new Date(endDate + "T00:00:00")
      ? "Start date must be before end date"
      : null;

  const zeroWorkingDays =
    !!startDate &&
    !!endDate &&
    !dateError &&
    estimatedDays === 0;

  const startDayKey = startDate ? DAY_KEYS[new Date(startDate + "T00:00:00").getDay()] : null;
  const endDayKey = endDate ? DAY_KEYS[new Date(endDate + "T00:00:00").getDay()] : null;

  const startIsWorking = !!startDayKey && schedule[startDayKey];
  const endIsWorking = !!endDayKey && schedule[endDayKey];

  const partialOnNonWorkingDay =
    (startPartial !== "full" && !!startDate && !startIsWorking) ||
    (!isSingleDay && endPartial !== "full" && !!endDate && !endIsWorking);

  const canSubmit =
    !dateError &&
    !!startDate &&
    !!endDate &&
    !isPending &&
    !exceedsVacation &&
    !zeroWorkingDays &&
    !partialOnNonWorkingDay &&
    !isCheckingBlackout &&
    !hasBlockingBlackout;

  const halfDayForApi = isSingleDay && startPartial !== "full";
  const halfDayPeriodForApi = halfDayForApi
    ? startPartial === "morning"
      ? "AM"
      : "PM"
    : undefined;
  // For multi-day ranges, pass start/end partial selections so the backend can
  // record what the user chose (backend will use these for duration in a future update).
  const startPartialForApi = !isSingleDay ? startPartial : undefined;
  const endPartialForApi = !isSingleDay ? endPartial : undefined;

  async function handleSubmit() {
    if (!canSubmit) return;
    try {
      const result = await createRequest({
        data: {
          typeCode,
          startDate,
          endDate,
          halfDay: halfDayForApi,
          halfDayPeriod: halfDayPeriodForApi,
          startPartial: startPartialForApi,
          endPartial: endPartialForApi,
          reason: reason.trim() || null,
        },
      });
      await queryClient.invalidateQueries({ queryKey: getGetTimeOffBalanceQueryKey() });
      await queryClient.invalidateQueries({ queryKey: getListTimeOffRequestsQueryKey() });
      if (result.autoApproved) {
        toast({ title: "Request approved", description: "Your time-off request has been automatically approved." });
      } else {
        toast({ title: "Request submitted", description: "Your time-off request has been sent to your manager." });
      }
      onOpenChange(false);
    } catch (err: unknown) {
      const msg =
        err instanceof Error
          ? err.message
          : "Could not submit request. Please try again.";
      toast({ title: "Failed to submit", description: msg, variant: "destructive" });
    }
  }

  const vacationAvailable = balance?.vacation_remaining ?? null;
  const vacationRemaining =
    vacationAvailable != null ? vacationAvailable - estimatedDays : null;

  const dateSummary = startDate && endDate
    ? isSingleDay
      ? formatFullDate(startDate)
      : `${formatShortDate(startDate)} – ${formatShortDate(endDate)}`
    : null;

  const dayCountLabel =
    estimatedDays === 0.5
      ? "0.5 days"
      : estimatedDays === 1
      ? "1 day"
      : `${estimatedDays} days`;

  const partialOptions: { value: PartialDayOption; label: string }[] = [
    { value: "full", label: "Full day" },
    { value: "morning", label: "Morning only" },
    { value: "afternoon", label: "Afternoon only" },
  ];

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="max-w-xl p-0 flex flex-col gap-0 overflow-hidden"
        style={{ maxHeight: "min(calc(100vh - 48px), calc(100svh - 48px))" }}
      >
        <DialogHeader className="px-5 pt-5 pb-4 shrink-0 border-b border-border">
          <DialogTitle className="text-base font-semibold">Request Time Off</DialogTitle>
        </DialogHeader>

        <div className="overflow-y-auto px-5 py-3 space-y-3" style={{ flex: "1 1 0%", minHeight: 0 }}>
          {/* Type dropdown */}
          <div className="space-y-1.5">
            <Label htmlFor="tor-type" className="text-xs font-medium text-muted-foreground">Type</Label>
            <select
              id="tor-type"
              value={typeCode}
              onChange={(e) => setTypeCode(e.target.value as "VACATION" | "SICK_LEAVE")}
              className="flex h-9 w-full appearance-none rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm focus:outline-none focus:ring-1 focus:ring-ring"
            >
              <option value="VACATION">Vacation</option>
              <option value="SICK_LEAVE">Sick Leave</option>
            </select>
          </div>

          {/* PTO Balance Summary */}
          {typeCode === "VACATION" && balance != null && (
            <div className="grid grid-cols-3 gap-px rounded-md border border-border overflow-hidden text-center text-sm">
              <div className="bg-muted/30 px-2 py-2">
                <p className="text-[10px] font-medium text-muted-foreground uppercase tracking-wide mb-0.5">Available</p>
                <p className="font-semibold text-foreground">{Number(balance.vacation_remaining).toFixed(1)}</p>
              </div>
              <div className="bg-muted/30 px-2 py-2 border-x border-border">
                <p className="text-[10px] font-medium text-muted-foreground uppercase tracking-wide mb-0.5">This request</p>
                <p className={cn("font-semibold", exceedsVacation ? "text-amber-600" : "text-foreground")}>
                  {estimatedDays > 0 ? `−${estimatedDays % 1 === 0 ? estimatedDays : estimatedDays.toFixed(1)}` : "—"}
                </p>
              </div>
              <div className="bg-muted/30 px-2 py-2">
                <p className="text-[10px] font-medium text-muted-foreground uppercase tracking-wide mb-0.5">Remaining</p>
                <p className={cn("font-semibold", exceedsVacation ? "text-amber-600" : "text-foreground")}>
                  {vacationRemaining != null && estimatedDays > 0
                    ? vacationRemaining.toFixed(1)
                    : "—"}
                </p>
              </div>
            </div>
          )}

          {/* Date fields + calendar */}
          <div className="space-y-2">
            <div className="grid grid-cols-2 gap-2">
              <div className="space-y-1">
                <Label htmlFor="tor-start" className="text-xs font-medium text-muted-foreground">Start date</Label>
                <input
                  id="tor-start"
                  type="date"
                  value={startInput}
                  onChange={(e) => handleStartInputChange(e.target.value)}
                  className="flex h-8 w-full rounded-md border border-input bg-background px-2 py-1 text-sm focus:outline-none focus:ring-1 focus:ring-ring"
                  aria-label="Start date"
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor="tor-end" className="text-xs font-medium text-muted-foreground">End date</Label>
                <input
                  id="tor-end"
                  type="date"
                  value={endInput}
                  onChange={(e) => handleEndInputChange(e.target.value)}
                  min={startInput}
                  className="flex h-8 w-full rounded-md border border-input bg-background px-2 py-1 text-sm focus:outline-none focus:ring-1 focus:ring-ring"
                  aria-label="End date"
                />
              </div>
            </div>

            {/* Calendar */}
            <div className="rounded-md border border-input bg-background">
              <Calendar
                mode="range"
                selected={selectedRange}
                month={calendarMonth}
                onMonthChange={setCalendarMonth}
                weekStartsOn={1}
                startMonth={new Date(new Date().getFullYear(), 0, 1)}
                onSelect={handleCalendarSelect}
                modifiers={{
                  notWorkingDay: (date: Date) => !schedule[DAY_KEYS[date.getDay()]],
                  publicHoliday: (date: Date) => holidayDateSet.has(toLocalDateString(date)),
                  blackoutDate: (date: Date) => blackoutDateSet.has(toLocalDateString(date)),
                }}
                classNames={{
                  month: "flex w-full flex-col gap-2",
                  week: "flex w-full",
                  month_caption: "flex h-8 w-full items-center justify-center px-[--cell-size]",
                  weekday: "text-muted-foreground flex-1 select-none rounded-md text-[0.75rem] font-normal",
                  day: "group/day relative h-10 w-full select-none p-0 text-center [&:first-child[data-selected=true]_button]:rounded-l-md [&:last-child[data-selected=true]_button]:rounded-r-md",
                }}
                components={{
                  DayButton: ({ className, day, modifiers: mods, ...props }) => {
                    const m = mods as unknown as Record<string, boolean>;
                    const isInRange = m.range_start || m.range_end || m.range_middle || m.selected;
                    return (
                      <CalendarDayButton
                        className={cn(
                          className,
                          "aspect-auto! h-10 w-full",
                          !isInRange && m.notWorkingDay &&
                            "bg-muted/70 text-muted-foreground hover:bg-muted",
                          !isInRange && m.publicHoliday &&
                            "bg-blue-50 text-blue-700 hover:bg-blue-100",
                          !isInRange && m.blackoutDate &&
                            "bg-orange-50 text-orange-700 hover:bg-orange-100",
                        )}
                        day={day}
                        modifiers={mods}
                        aria-label={
                          m.range_start
                            ? `${day.date.toLocaleDateString()}, range start`
                            : m.range_end
                            ? `${day.date.toLocaleDateString()}, range end`
                            : m.range_middle
                            ? `${day.date.toLocaleDateString()}, in range`
                            : m.notWorkingDay
                            ? `${day.date.toLocaleDateString()}, not a working day`
                            : m.publicHoliday
                            ? `${day.date.toLocaleDateString()}, public holiday`
                            : m.blackoutDate
                            ? `${day.date.toLocaleDateString()}, blackout period`
                            : `${day.date.toLocaleDateString()}, working day`
                        }
                        {...props}
                      />
                    );
                  },
                }}
                className="w-full p-1"
                style={{ "--cell-size": "2rem" } as React.CSSProperties}
              />
            </div>

            {/* Calendar legend */}
            <div
              className="flex items-center gap-3 flex-wrap text-xs text-muted-foreground"
              aria-label="Calendar legend"
            >
              <div className="flex items-center gap-1.5">
                <div className="w-3 h-3 rounded-sm bg-primary" aria-hidden="true" />
                <span>Selected</span>
              </div>
              <div className="flex items-center gap-1.5">
                <div className="w-3 h-3 rounded-sm bg-accent border border-border" aria-hidden="true" />
                <span>In range</span>
              </div>
              <div className="flex items-center gap-1.5">
                <div className="w-3 h-3 rounded-sm bg-muted border border-border" aria-hidden="true" />
                <span>Non-working</span>
              </div>
              {hasPublicHolidays && (
                <div className="flex items-center gap-1.5">
                  <div className="w-3 h-3 rounded-sm bg-blue-100 border border-blue-200" aria-hidden="true" />
                  <span>Public holiday</span>
                </div>
              )}
              {blackoutDateSet.size > 0 && (
                <div className="flex items-center gap-1.5">
                  <div className="w-3 h-3 rounded-sm bg-orange-100 border border-orange-200" aria-hidden="true" />
                  <span>Blackout period</span>
                </div>
              )}
            </div>
          </div>

          {/* Partial days */}
          {isSingleDay ? (
            <div className="space-y-1.5">
              <Label htmlFor="tor-day-partial" className="text-xs font-medium text-muted-foreground">Day</Label>
              <select
                id="tor-day-partial"
                value={startPartial}
                onChange={(e) => setStartPartial(e.target.value as PartialDayOption)}
                className="flex h-9 w-full appearance-none rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm focus:outline-none focus:ring-1 focus:ring-ring"
                aria-label="Partial day option"
              >
                {partialOptions.map((o) => (
                  <option key={o.value} value={o.value}>{o.label}</option>
                ))}
              </select>
            </div>
          ) : (
            startDate && endDate && (
              <div className="space-y-2">
                <p className="text-xs font-medium text-muted-foreground">Partial days</p>
                <div className="grid grid-cols-2 gap-2">
                  <div className="space-y-1">
                    <Label htmlFor="tor-start-partial" className="text-xs text-muted-foreground">Start day</Label>
                    <select
                      id="tor-start-partial"
                      value={startPartial}
                      onChange={(e) => setStartPartial(e.target.value as PartialDayOption)}
                      className="flex h-8 w-full appearance-none rounded-md border border-input bg-transparent px-2 py-1 text-sm shadow-sm focus:outline-none focus:ring-1 focus:ring-ring"
                      aria-label="Start day partial option"
                    >
                      {partialOptions.map((o) => (
                        <option key={o.value} value={o.value}>{o.label}</option>
                      ))}
                    </select>
                  </div>
                  <div className="space-y-1">
                    <Label htmlFor="tor-end-partial" className="text-xs text-muted-foreground">End day</Label>
                    <select
                      id="tor-end-partial"
                      value={endPartial}
                      onChange={(e) => setEndPartial(e.target.value as PartialDayOption)}
                      className="flex h-8 w-full appearance-none rounded-md border border-input bg-transparent px-2 py-1 text-sm shadow-sm focus:outline-none focus:ring-1 focus:ring-ring"
                      aria-label="End day partial option"
                    >
                      {partialOptions.map((o) => (
                        <option key={o.value} value={o.value}>{o.label}</option>
                      ))}
                    </select>
                  </div>
                </div>
              </div>
            )
          )}

          {/* Reason field */}
          <div className="space-y-1.5">
            <Label htmlFor="tor-reason" className="text-xs font-medium text-muted-foreground">Reason (optional)</Label>
            <Textarea
              id="tor-reason"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="Add a note for your manager…"
              className="resize-none text-sm"
              rows={2}
              maxLength={1000}
            />
            <p className="text-xs text-muted-foreground">
              This request will be sent to{" "}
              <span className="font-medium text-foreground">
                {approverName ?? "your manager"}
              </span>{" "}
              for approval.
            </p>
          </div>

          {/* Validation messages */}
          {dateError && (
            <div className="rounded-md border border-destructive/50 bg-destructive/10 px-3 py-2 text-sm flex items-start gap-2 text-destructive">
              <AlertCircle size={14} className="shrink-0 mt-0.5" />
              <span>{dateError}</span>
            </div>
          )}

          {zeroWorkingDays && (
            <div className="rounded-md border border-destructive/50 bg-destructive/10 px-3 py-2 text-sm flex items-start gap-2 text-destructive">
              <AlertCircle size={14} className="shrink-0 mt-0.5" />
              <span>
                The selected date range contains no working days based on your work schedule. Please choose different dates.
              </span>
            </div>
          )}

          {partialOnNonWorkingDay && (
            <div className="rounded-md border border-destructive/50 bg-destructive/10 px-3 py-2 text-sm flex items-start gap-2 text-destructive">
              <AlertCircle size={14} className="shrink-0 mt-0.5" />
              <span>
                The selected date is not a working day based on your work schedule. Please choose a working day for your partial-day request.
              </span>
            </div>
          )}

          {!zeroWorkingDays && estimatedDays > 0 && (
            <div
              className={cn(
                "rounded-md border px-3 py-2 text-sm flex items-start gap-2",
                exceedsVacation
                  ? "border-amber-300 bg-amber-50 text-amber-800"
                  : "border-border bg-muted/40 text-muted-foreground",
              )}
            >
              {exceedsVacation && <AlertCircle size={14} className="shrink-0 mt-0.5 text-amber-600" />}
              <span>
                This request uses <strong>{estimatedDays}</strong> working{" "}
                {estimatedDays === 1 ? "day" : "days"}.
                {hasCustomSchedule && (
                  <> Calculated based on your custom work schedule.</>
                )}
                {exceedsVacation && balance != null && (
                  <> You have <strong>{balance.vacation_remaining}</strong> vacation days remaining — this request will put you over your balance.</>
                )}
              </span>
            </div>
          )}

          {/* Blackout date banners — shown once check result is available */}
          {!isCheckingBlackout && blockingBlackouts.length > 0 && (
            <div
              className="rounded-md border border-destructive/50 bg-destructive/10 px-3 py-2 text-sm flex items-start gap-2 text-destructive"
              data-testid="blackout-blocking-banner"
            >
              <OctagonX size={14} className="shrink-0 mt-0.5" />
              <div className="space-y-1">
                <p className="font-medium">Leave requests are not allowed during this period.</p>
                {blockingBlackouts.map((b) => (
                  <p key={b.id} className="text-xs">
                    <strong>{b.name}</strong>
                    {" "}({formatShortDate(b.start_date)}
                    {b.start_date !== b.end_date ? ` – ${formatShortDate(b.end_date)}` : ""})
                    {b.employee_message ? ` — ${b.employee_message}` : ""}
                  </p>
                ))}
              </div>
            </div>
          )}

          {!isCheckingBlackout && approvalBlackouts.length > 0 && (
            <div
              className="rounded-md border border-blue-300 bg-blue-50 px-3 py-2 text-sm flex items-start gap-2 text-blue-800"
              data-testid="blackout-approval-banner"
            >
              <Info size={14} className="shrink-0 mt-0.5" />
              <div className="space-y-1">
                <p className="font-medium">This request will require additional manager approval.</p>
                {approvalBlackouts.map((b) => (
                  <p key={b.id} className="text-xs">
                    <strong>{b.name}</strong>
                    {" "}({formatShortDate(b.start_date)}
                    {b.start_date !== b.end_date ? ` – ${formatShortDate(b.end_date)}` : ""})
                    {b.employee_message ? ` — ${b.employee_message}` : ""}
                  </p>
                ))}
              </div>
            </div>
          )}

          {!isCheckingBlackout && warningBlackouts.length > 0 && (
            <div
              className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm flex items-start gap-2 text-amber-800"
              data-testid="blackout-warning-banner"
            >
              <TriangleAlert size={14} className="shrink-0 mt-0.5" />
              <div className="space-y-1">
                <p className="font-medium">Your selected dates fall within a restricted period.</p>
                {warningBlackouts.map((b) => (
                  <p key={b.id} className="text-xs">
                    <strong>{b.name}</strong>
                    {" "}({formatShortDate(b.start_date)}
                    {b.start_date !== b.end_date ? ` – ${formatShortDate(b.end_date)}` : ""})
                    {b.employee_message ? ` — ${b.employee_message}` : ""}
                  </p>
                ))}
                <p className="text-xs">You may still submit this request, but it may be declined.</p>
              </div>
            </div>
          )}
        </div>

        {/* Sticky footer */}
        <div className="border-t border-border px-5 py-3 shrink-0 flex items-center justify-between gap-3">
          <div className="flex items-center gap-2 text-sm text-muted-foreground min-w-0">
            <CalendarIcon size={14} className="shrink-0" aria-hidden="true" />
            <span className="truncate">
              {dateSummary ? (
                <>
                  {dateSummary}
                  {estimatedDays > 0 && (
                    <span className="text-foreground font-medium"> · {dayCountLabel}</span>
                  )}
                </>
              ) : (
                "No dates selected"
              )}
            </span>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <Button
              variant="outline"
              size="sm"
              onClick={() => onOpenChange(false)}
              disabled={isPending}
            >
              Cancel
            </Button>
            <Button
              size="sm"
              onClick={handleSubmit}
              disabled={!canSubmit}
            >
              {isPending ? "Submitting…" : "Submit Request"}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

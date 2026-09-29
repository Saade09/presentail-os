import { useState, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { useGetTimeOffCalendar } from "@workspace/api-client-react";
import { apiFetch } from "@/lib/queryClient";
import {
  CalendarDays,
  ChevronLeft,
  ChevronRight,
  Star,
  Ban,
} from "lucide-react";
import { cn } from "@/lib/utils";

const DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

type CalendarEvent = {
  id: number;
  type: "request" | "holiday";
  title: string;
  start_date: string;
  end_date: string;
  status: string | null;
  color: string;
  member_name: string | null;
  is_paid: boolean | null;
};

type BlackoutDate = {
  id: number;
  name: string;
  start_date: string;
  end_date: string;
  restriction_type: string;
  status: string;
};

function dateKey(y: number, m: number, d: number) {
  return `${y}-${String(m + 1).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

function isBetween(date: string, start: string, end: string) {
  return date >= start && date <= end;
}

function EventPill({ event }: { event: CalendarEvent }) {
  const isHoliday = event.type === "holiday";
  return (
    <div
      className={cn(
        "text-xs rounded px-1 py-0.5 truncate leading-tight",
        isHoliday
          ? "bg-amber-100 text-amber-800 border border-amber-200"
          : "text-white",
      )}
      style={!isHoliday ? { backgroundColor: event.color ?? "#6b7280" } : undefined}
      title={event.title}
    >
      {isHoliday && <Star size={9} className="inline mr-0.5 mb-0.5" />}
      {event.title}
    </div>
  );
}

export default function TimeOffCalendarPage() {
  const now = new Date();
  const [year, setYear] = useState(now.getFullYear());
  const [month, setMonth] = useState(now.getMonth());

  const { data, isLoading } = useGetTimeOffCalendar({ year, month: month + 1 });
  const events: CalendarEvent[] = (data?.events ?? []) as CalendarEvent[];

  // Calculate first/last day of visible month for blackout query
  const monthStart = `${year}-${String(month + 1).padStart(2, "0")}-01`;
  const monthEnd = new Date(year, month + 1, 0).toISOString().slice(0, 10);

  const { data: blackoutData } = useQuery({
    queryKey: ["blackout-dates", { date_from: monthStart, date_to: monthEnd }],
    queryFn: () =>
      apiFetch(`/api/blackout-dates?date_from=${monthStart}&date_to=${monthEnd}`),
  });
  const blackoutDates: BlackoutDate[] = ((blackoutData as { blackout_dates?: BlackoutDate[] })?.blackout_dates ?? []).filter(
    (b) => b.status !== "cancelled",
  );

  const blackoutByDate = useMemo(() => {
    const set = new Set<string>();
    const firstDay = new Date(year, month, 1);
    const lastDay = new Date(year, month + 1, 0);
    blackoutDates.forEach((b) => {
      const d = new Date(firstDay);
      while (d <= lastDay) {
        const key = d.toISOString().slice(0, 10);
        if (isBetween(key, b.start_date, b.end_date)) set.add(key);
        d.setDate(d.getDate() + 1);
      }
    });
    return set;
  }, [blackoutDates, year, month]);

  const blackoutByDateInfo = useMemo(() => {
    const map = new Map<string, BlackoutDate[]>();
    const firstDay = new Date(year, month, 1);
    const lastDay = new Date(year, month + 1, 0);
    blackoutDates.forEach((b) => {
      const d = new Date(firstDay);
      while (d <= lastDay) {
        const key = d.toISOString().slice(0, 10);
        if (isBetween(key, b.start_date, b.end_date)) {
          if (!map.has(key)) map.set(key, []);
          map.get(key)!.push(b);
        }
        d.setDate(d.getDate() + 1);
      }
    });
    return map;
  }, [blackoutDates, year, month]);

  const eventsByDate = useMemo(() => {
    const map = new Map<string, CalendarEvent[]>();
    const firstDay = new Date(year, month, 1);
    const lastDay = new Date(year, month + 1, 0);

    events.forEach((evt) => {
      const evtStart = evt.start_date;
      const evtEnd = evt.end_date ?? evt.start_date;
      const d = new Date(firstDay);
      while (d <= lastDay) {
        const key = d.toISOString().slice(0, 10);
        if (isBetween(key, evtStart, evtEnd)) {
          if (!map.has(key)) map.set(key, []);
          map.get(key)!.push(evt);
        }
        d.setDate(d.getDate() + 1);
      }
    });
    return map;
  }, [events, year, month]);

  function prevMonth() {
    if (month === 0) { setMonth(11); setYear((y) => y - 1); }
    else setMonth((m) => m - 1);
  }

  function nextMonth() {
    if (month === 11) { setMonth(0); setYear((y) => y + 1); }
    else setMonth((m) => m + 1);
  }

  const firstDayOfMonth = (new Date(year, month, 1).getDay() + 6) % 7;
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const today = now.toISOString().slice(0, 10);

  const cells: Array<{ day: number | null; key: string | null }> = [];
  for (let i = 0; i < firstDayOfMonth; i++) cells.push({ day: null, key: null });
  for (let d = 1; d <= daysInMonth; d++) cells.push({ day: d, key: dateKey(year, month, d) });
  while (cells.length % 7 !== 0) cells.push({ day: null, key: null });

  const holidayCount = events.filter((e) => e.type === "holiday").length;
  const requestCount = events.filter((e) => e.type === "request").length;
  const blackoutCount = blackoutDates.length;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <CalendarDays size={22} />
            Team Calendar
          </h1>
          <p className="text-muted-foreground text-sm mt-1">
            View approved time-off requests, public holidays, and blackout periods.
          </p>
        </div>
      </div>

      <Card>
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between flex-wrap gap-2">
            <div className="flex items-center gap-3">
              <Button variant="ghost" size="icon" onClick={prevMonth} className="h-8 w-8">
                <ChevronLeft size={16} />
              </Button>
              <CardTitle className="text-lg">
                {MONTHS[month]} {year}
              </CardTitle>
              <Button variant="ghost" size="icon" onClick={nextMonth} className="h-8 w-8">
                <ChevronRight size={16} />
              </Button>
            </div>
            <div className="flex items-center gap-3 text-xs text-muted-foreground flex-wrap">
              {requestCount > 0 && (
                <span className="flex items-center gap-1.5">
                  <span className="w-2 h-2 rounded-full bg-blue-500 inline-block" />
                  {requestCount} leave event{requestCount !== 1 ? "s" : ""}
                </span>
              )}
              {holidayCount > 0 && (
                <span className="flex items-center gap-1.5">
                  <span className="w-2 h-2 rounded-full bg-amber-400 inline-block" />
                  {holidayCount} holiday{holidayCount !== 1 ? "s" : ""}
                </span>
              )}
              {blackoutCount > 0 && (
                <span className="flex items-center gap-1.5">
                  <Ban size={11} className="text-red-400" />
                  {blackoutCount} blackout period{blackoutCount !== 1 ? "s" : ""}
                </span>
              )}
            </div>
          </div>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <div className="h-96 flex items-center justify-center text-muted-foreground">
              Loading calendar…
            </div>
          ) : (
            <div className="overflow-x-auto">
              <div className="min-w-[560px]">
                <div className="grid grid-cols-7 mb-1">
                  {DAYS.map((day) => (
                    <div
                      key={day}
                      className="text-center text-xs font-medium text-muted-foreground py-2"
                    >
                      {day}
                    </div>
                  ))}
                </div>
                <div className="grid grid-cols-7 border-l border-t">
                  {cells.map((cell, idx) => {
                    const isToday = cell.key === today;
                    const dayEvents = cell.key ? (eventsByDate.get(cell.key) ?? []) : [];
                    const isBlackout = cell.key ? blackoutByDate.has(cell.key) : false;
                    const blackoutsForDay = cell.key ? (blackoutByDateInfo.get(cell.key) ?? []) : [];
                    const maxVisible = 3;
                    const overflow = dayEvents.length - maxVisible;

                    return (
                      <div
                        key={idx}
                        className={cn(
                          "border-r border-b min-h-[90px] p-1.5 flex flex-col gap-0.5 relative",
                          !cell.day && "bg-muted/30",
                          isBlackout && cell.day && "bg-red-50/60",
                        )}
                        title={isBlackout ? blackoutsForDay.map((b) => `Blackout: ${b.name}`).join("; ") : undefined}
                      >
                        {isBlackout && cell.day && (
                          <div className="absolute inset-0 border-t-2 border-red-300/50 pointer-events-none" />
                        )}
                        {cell.day && (
                          <>
                            <div className="flex items-center justify-between mb-0.5">
                              <span className="text-[10px] leading-none text-red-400">
                                {isBlackout && <Ban size={9} className="inline" />}
                              </span>
                              <span
                                className={cn(
                                  "text-xs font-medium leading-none w-5 h-5 flex items-center justify-center rounded-full",
                                  isToday
                                    ? "bg-primary text-primary-foreground"
                                    : "text-muted-foreground",
                                )}
                              >
                                {cell.day}
                              </span>
                            </div>
                            {dayEvents.slice(0, maxVisible).map((evt) => (
                              <EventPill key={`${evt.type}-${evt.id}`} event={evt} />
                            ))}
                            {overflow > 0 && (
                              <span className="text-xs text-muted-foreground px-1">
                                +{overflow} more
                              </span>
                            )}
                          </>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      {blackoutDates.length > 0 && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-semibold text-muted-foreground uppercase tracking-wide flex items-center gap-1.5">
              <Ban size={13} className="text-red-400" />
              Blackout Periods this month
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            {blackoutDates.map((b) => (
              <div key={b.id} className="flex items-start gap-3 text-sm">
                <div className="w-2.5 h-2.5 rounded-full mt-1 flex-shrink-0 bg-red-300" />
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="font-medium truncate">{b.name}</span>
                    <Badge variant="secondary" className="text-xs py-0 h-4 bg-red-100 text-red-700">
                      {b.restriction_type === "blocking" ? "Blocking" : b.restriction_type === "manager_approval" ? "Manager approval" : "Warning"}
                    </Badge>
                  </div>
                  <p className="text-xs text-muted-foreground mt-0.5">
                    {new Date(b.start_date + "T00:00:00").toLocaleDateString(undefined, { month: "short", day: "numeric" })}
                    {b.end_date !== b.start_date && (
                      <> – {new Date(b.end_date + "T00:00:00").toLocaleDateString(undefined, { month: "short", day: "numeric" })}</>
                    )}
                  </p>
                </div>
              </div>
            ))}
          </CardContent>
        </Card>
      )}

      {events.length > 0 && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-semibold text-muted-foreground uppercase tracking-wide">
              Events this month
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            {events.map((evt) => (
              <div key={`${evt.type}-${evt.id}`} className="flex items-start gap-3 text-sm">
                <div
                  className="w-2.5 h-2.5 rounded-full mt-1 flex-shrink-0"
                  style={{ backgroundColor: evt.type === "holiday" ? "#f59e0b" : (evt.color ?? "#6b7280") }}
                />
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="font-medium truncate">{evt.title}</span>
                    {evt.type === "request" && evt.status && (
                      <Badge
                        variant="secondary"
                        className={cn(
                          "text-xs py-0 h-4",
                          evt.status === "PENDING" && "text-amber-700 bg-amber-100",
                          evt.status === "APPROVED" && "text-emerald-700 bg-emerald-100",
                        )}
                      >
                        {evt.status.toLowerCase()}
                      </Badge>
                    )}
                    {evt.type === "holiday" && (
                      <Badge variant="secondary" className="text-xs py-0 h-4 text-amber-700 bg-amber-100">
                        public holiday
                      </Badge>
                    )}
                  </div>
                  <p className="text-xs text-muted-foreground mt-0.5">
                    {new Date(String(evt.start_date).slice(0, 10) + "T00:00:00").toLocaleDateString(undefined, { month: "short", day: "numeric" })}
                    {evt.end_date !== evt.start_date && (
                      <>
                        {" – "}
                        {new Date(String(evt.end_date).slice(0, 10) + "T00:00:00").toLocaleDateString(undefined, { month: "short", day: "numeric" })}
                      </>
                    )}
                  </p>
                </div>
              </div>
            ))}
          </CardContent>
        </Card>
      )}
    </div>
  );
}

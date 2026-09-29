/**
 * Pure helpers for the Cash Sessions cash-control dashboard.
 * All derivations (KPIs, per-currency cash held, needs-attention detection,
 * filtering, sorting) run on the same session rows the detail view uses.
 */

export type SessionRow = {
  id: number;
  session_number: string;
  drawer_name: string | null;
  drawer_code: string | null;
  location_name: string | null;
  opened_by_clerk_id?: string | null;
  opened_by_name: string | null;
  closed_by_name: string | null;
  approved_by_name: string | null;
  currency: string;
  secondary_currency?: string | null;
  status: string;
  opening_cash: string;
  opening_cash_secondary?: string | null;
  expected_cash: string | null;
  expected_cash_secondary?: string | null;
  actual_cash: string | null;
  actual_cash_secondary?: string | null;
  difference: string | null;
  difference_secondary?: string | null;
  opened_at: string;
  closed_at: string | null;
  /** Location's daily-close cutoff time ("HH:MM"), supplied by the server. */
  same_day_cutoff_time?: string | null;
  /** Location's IANA timezone, supplied by the server. */
  location_timezone?: string | null;
  /** Server-computed overdue flag (attention sessions). */
  isOverdue?: boolean;
  /** Minutes past the cutoff+grace that the session is overdue (attention sessions). */
  overdueByMinutes?: number;
  /**
   * ID of the linked cash_session_resolutions row when this session was resolved
   * via the overdue reconciliation flow. Null for sessions closed normally.
   */
  resolution_id?: number | null;
};

export type DatePreset = "all" | "today" | "yesterday" | "this_week" | "this_month" | "custom";

export type Filters = {
  preset: DatePreset;
  from: string; // yyyy-mm-dd (custom)
  to: string; // yyyy-mm-dd (custom)
  drawer: string; // drawer name or "all"
  operator: string; // opener name or "all"
  status: string; // status or "all" or "attention"
  currency: string; // currency or "all"
  q: string;
};

export const DEFAULT_FILTERS: Filters = {
  preset: "all",
  from: "",
  to: "",
  drawer: "all",
  operator: "all",
  status: "all",
  currency: "all",
  q: "",
};

export type SortKey = "opened_at" | "status" | "difference";
export type SortDir = "asc" | "desc";

/**
 * The Cash Sessions page grants the core lifecycle actions. Explicit action
 * permissions are retained for legacy roles, while approval and other
 * elevated controls remain separate.
 */
export function canManageCashSessionLifecycle(
  isOwner: boolean,
  allowedPages: string[] | null | undefined,
  action: "open" | "close",
): boolean {
  return (
    isOwner ||
    allowedPages?.includes("cash-sessions") === true ||
    allowedPages?.includes(`cash_sessions.${action}`) === true
  );
}

/** Fixed expected shift duration; sessions open longer need attention. */
export const LONG_OPEN_THRESHOLD_MS = 8 * 60 * 60 * 1000;

/**
 * Client-side overdue check for session list rows.
 * Uses the location's cutoff time + timezone from the session row, and
 * defaults to 120-minute grace when no explicit grace is provided.
 * Mirrors the server-side `isSessionOverdue` helper in cashDesk.ts.
 */
export function computeIsOverdue(
  s: Pick<SessionRow, "opened_at" | "status" | "isOverdue" | "same_day_cutoff_time" | "location_timezone">,
  graceMinutes = 120,
  now: Date = new Date(),
): boolean {
  if (s.status !== "open") return false;
  // Trust server-supplied flag if present
  if (s.isOverdue !== undefined) return Boolean(s.isOverdue);
  const cutoffTime = s.same_day_cutoff_time;
  const timezone = s.location_timezone;
  if (!cutoffTime || !timezone) return false;
  try {
    const openedDate = new Date(s.opened_at);
    if (isNaN(openedDate.getTime())) return false;
    const [hStr, mStr = "0"] = cutoffTime.split(":");
    const ch = parseInt(hStr, 10);
    const cm = parseInt(mStr, 10);
    if (!Number.isFinite(ch) || !Number.isFinite(cm)) return false;
    const localDateStr = new Intl.DateTimeFormat("en-CA", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(openedDate);
    const [y, mo, d] = localDateStr.split("-").map(Number);
    const probeMs = Date.UTC(y, mo - 1, d, ch, cm, 0);
    const tzParts = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit",
      hour12: false,
    }).formatToParts(new Date(probeMs));
    const get = (type: string) => Number(tzParts.find((p) => p.type === type)?.value ?? "0");
    const tzAsMs = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), 0);
    const cutoffUtcMs = probeMs + (probeMs - tzAsMs);
    const cutoffWithGraceMs = cutoffUtcMs + graceMinutes * 60_000;
    return now.getTime() > cutoffWithGraceMs;
  } catch {
    return false;
  }
}

/** Reporting window for the Total Difference KPI. */
export const DIFFERENCE_PERIOD_DAYS = 30;

function num(v: string | null | undefined): number {
  if (v == null) return 0;
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

/** Cash currently held by an open session (expected balance so far). */
export function heldAmount(s: SessionRow): number {
  return num(s.expected_cash ?? s.opening_cash);
}

/** Secondary-currency cash held by an open dual-currency session. */
export function heldAmountSecondary(s: SessionRow): number {
  if (!s.secondary_currency) return 0;
  return num(s.expected_cash_secondary ?? s.opening_cash_secondary);
}

export { formatCashMoney as formatMoney } from "./cashMoney";

/** "16 Jul 2026, 3:16 PM" */
export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "—";
  const date = d.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
  const time = d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", hour12: true });
  return `${date}, ${time}`;
}

/** "8h 42m" style duration between opened_at and now. */
export function formatOpenDuration(openedAt: string, now: Date = new Date()): string {
  const ms = now.getTime() - new Date(openedAt).getTime();
  if (!Number.isFinite(ms) || ms < 0) return "0m";
  const totalMinutes = Math.floor(ms / 60000);
  const h = Math.floor(totalMinutes / 60);
  const m = totalMinutes % 60;
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

// ---------------------------------------------------------------------------
// KPI summaries
// ---------------------------------------------------------------------------

export type CurrencyAmount = { currency: string; amount: number; count: number };

export type KpiSummary = {
  openCount: number;
  openHeldByCurrency: CurrencyAmount[];
  pendingCount: number;
  flaggedCount: number;
  flaggedDiffByCurrency: CurrencyAmount[];
  /** Net difference over the last DIFFERENCE_PERIOD_DAYS days, per currency. */
  differenceByCurrency: CurrencyAmount[];
};

function addToCurrencyMap(map: Map<string, CurrencyAmount>, currency: string, amount: number) {
  const e = map.get(currency) ?? { currency, amount: 0, count: 0 };
  e.amount += amount;
  e.count += 1;
  map.set(currency, e);
}

function sortedCurrencyList(map: Map<string, CurrencyAmount>): CurrencyAmount[] {
  return [...map.values()].sort((a, b) => a.currency.localeCompare(b.currency));
}

export function computeKpis(sessions: SessionRow[], now: Date = new Date()): KpiSummary {
  const openHeld = new Map<string, CurrencyAmount>();
  const flaggedDiff = new Map<string, CurrencyAmount>();
  const diff30 = new Map<string, CurrencyAmount>();
  let openCount = 0;
  let pendingCount = 0;
  let flaggedCount = 0;
  const cutoff = now.getTime() - DIFFERENCE_PERIOD_DAYS * 24 * 60 * 60 * 1000;

  for (const s of sessions) {
    if (s.status === "open") {
      openCount++;
      addToCurrencyMap(openHeld, s.currency, heldAmount(s));
      if (s.secondary_currency) addToCurrencyMap(openHeld, s.secondary_currency, heldAmountSecondary(s));
    } else if (s.status === "pending_review") {
      pendingCount++;
    } else if (s.status === "flagged") {
      flaggedCount++;
      if (s.difference != null) addToCurrencyMap(flaggedDiff, s.currency, num(s.difference));
      if (s.secondary_currency && s.difference_secondary != null) {
        addToCurrencyMap(flaggedDiff, s.secondary_currency, num(s.difference_secondary));
      }
    }
    if (s.difference != null && s.closed_at && new Date(s.closed_at).getTime() >= cutoff) {
      addToCurrencyMap(diff30, s.currency, num(s.difference));
      if (s.secondary_currency && s.difference_secondary != null) {
        addToCurrencyMap(diff30, s.secondary_currency, num(s.difference_secondary));
      }
    }
  }

  return {
    openCount,
    openHeldByCurrency: sortedCurrencyList(openHeld),
    pendingCount,
    flaggedCount,
    flaggedDiffByCurrency: sortedCurrencyList(flaggedDiff),
    differenceByCurrency: sortedCurrencyList(diff30),
  };
}

/** Per-currency cash held across open sessions (one row per currency). */
export function computeCashHeldByCurrency(sessions: SessionRow[]): CurrencyAmount[] {
  const map = new Map<string, CurrencyAmount>();
  for (const s of sessions) {
    if (s.status === "open") {
      addToCurrencyMap(map, s.currency, heldAmount(s));
      if (s.secondary_currency) addToCurrencyMap(map, s.secondary_currency, heldAmountSecondary(s));
    }
  }
  return sortedCurrencyList(map);
}

// ---------------------------------------------------------------------------
// Needs attention
// ---------------------------------------------------------------------------

export type AttentionKind =
  | "shortage"
  | "overage"
  | "flagged"
  | "pending_review"
  | "overdue"
  | "long_open"
  | "closed_no_count";

export type AttentionItem = {
  kind: AttentionKind;
  severity: number; // lower = more urgent
  session: SessionRow;
};

/**
 * Classify sessions that need operational action, most urgent first.
 * A session appears at most once, under its most urgent issue.
 * Overdue (severity 2.5) is ranked above long_open (severity 3).
 */
export function computeNeedsAttention(sessions: SessionRow[], now: Date = new Date()): AttentionItem[] {
  const items: AttentionItem[] = [];
  for (const s of sessions) {
    const diff = s.difference != null ? num(s.difference) : null;
    if (s.status === "flagged") {
      if (diff != null && diff < 0) items.push({ kind: "shortage", severity: 0, session: s });
      else if (diff != null && diff > 0) items.push({ kind: "overage", severity: 1, session: s });
      else items.push({ kind: "flagged", severity: 1, session: s });
    } else if (s.status === "pending_review") {
      if (diff != null && diff < 0) items.push({ kind: "shortage", severity: 0, session: s });
      else if (diff != null && diff > 0) items.push({ kind: "overage", severity: 1, session: s });
      else items.push({ kind: "pending_review", severity: 2, session: s });
    } else if (s.status === "open") {
      // Server-supplied isOverdue takes priority; fall back to client-side check.
      const serverOverdue = s.isOverdue === true;
      if (serverOverdue) {
        items.push({ kind: "overdue", severity: 2.5, session: s });
      } else {
        const openMs = now.getTime() - new Date(s.opened_at).getTime();
        if (Number.isFinite(openMs) && openMs > LONG_OPEN_THRESHOLD_MS) {
          items.push({ kind: "long_open", severity: 3, session: s });
        }
      }
    } else if (s.closed_at && s.actual_cash == null) {
      items.push({ kind: "closed_no_count", severity: 2, session: s });
    }
  }
  return items.sort(
    (a, b) =>
      a.severity - b.severity ||
      new Date(b.session.opened_at).getTime() - new Date(a.session.opened_at).getTime(),
  );
}

// ---------------------------------------------------------------------------
// Filtering / sorting
// ---------------------------------------------------------------------------

function startOfDay(d: Date): Date {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
}

function addDays(d: Date, n: number): Date {
  const x = new Date(d);
  x.setDate(x.getDate() + n);
  return x;
}

/** Monday-based start of the week containing `d`. */
function startOfWeek(d: Date): Date {
  const x = startOfDay(d);
  const dow = (x.getDay() + 6) % 7;
  return addDays(x, -dow);
}

/** Resolve preset to an inclusive-start / exclusive-end pair, or null for "all". */
export function resolvePresetRange(
  preset: DatePreset,
  customFrom: string,
  customTo: string,
  now: Date = new Date(),
): { from: Date | null; to: Date | null } {
  switch (preset) {
    case "today": {
      const from = startOfDay(now);
      return { from, to: addDays(from, 1) };
    }
    case "yesterday": {
      const from = addDays(startOfDay(now), -1);
      return { from, to: addDays(from, 1) };
    }
    case "this_week":
      return { from: startOfWeek(now), to: addDays(startOfDay(now), 1) };
    case "this_month": {
      const from = startOfDay(now);
      from.setDate(1);
      return { from, to: addDays(startOfDay(now), 1) };
    }
    case "custom": {
      const from = customFrom ? startOfDay(new Date(`${customFrom}T00:00:00`)) : null;
      const to = customTo ? addDays(startOfDay(new Date(`${customTo}T00:00:00`)), 1) : null;
      return {
        from: from && !isNaN(from.getTime()) ? from : null,
        to: to && !isNaN(to.getTime()) ? to : null,
      };
    }
    default:
      return { from: null, to: null };
  }
}

/** True when the session is currently actionable (drives the "attention" pseudo-status). */
export function isAttentionSession(s: SessionRow, now: Date = new Date()): boolean {
  return computeNeedsAttention([s], now).length > 0;
}

export function applyFilters(sessions: SessionRow[], f: Filters, now: Date = new Date()): SessionRow[] {
  const { from, to } = resolvePresetRange(f.preset, f.from, f.to, now);
  const q = f.q.trim().toLowerCase();
  return sessions.filter((s) => {
    const opened = new Date(s.opened_at).getTime();
    if (from && opened < from.getTime()) return false;
    if (to && opened >= to.getTime()) return false;
    if (f.drawer !== "all" && (s.drawer_name ?? "") !== f.drawer) return false;
    if (f.operator !== "all" && (s.opened_by_name ?? "") !== f.operator) return false;
    if (f.status !== "all") {
      if (f.status === "attention") {
        if (!isAttentionSession(s, now)) return false;
      } else if (f.status === "difference") {
        if (s.difference == null || num(s.difference) === 0) return false;
      } else if (s.status !== f.status) {
        return false;
      }
    }
    if (f.currency !== "all" && s.currency !== f.currency) return false;
    if (q) {
      const hay = [s.session_number, s.drawer_name, s.location_name, s.opened_by_name]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });
}

const STATUS_ORDER: Record<string, number> = {
  open: 0,
  pending_review: 1,
  flagged: 2,
  approved: 3,
};

export function sortSessions(sessions: SessionRow[], key: SortKey, dir: SortDir): SessionRow[] {
  const mul = dir === "asc" ? 1 : -1;
  return [...sessions].sort((a, b) => {
    let cmp = 0;
    if (key === "opened_at") {
      cmp = new Date(a.opened_at).getTime() - new Date(b.opened_at).getTime();
    } else if (key === "status") {
      cmp = (STATUS_ORDER[a.status] ?? 99) - (STATUS_ORDER[b.status] ?? 99);
    } else {
      const da = a.difference == null ? Number.NEGATIVE_INFINITY : num(a.difference);
      const dbv = b.difference == null ? Number.NEGATIVE_INFINITY : num(b.difference);
      cmp = da - dbv;
    }
    if (cmp === 0) cmp = new Date(b.opened_at).getTime() - new Date(a.opened_at).getTime();
    return cmp * mul;
  });
}

/** Primary contextual row action by status. */
export type RowAction = "close" | "review" | "investigate" | "view";

export function primaryAction(status: string, canClose: boolean, canApprove: boolean): RowAction {
  if (status === "open" && canClose) return "close";
  if (status === "pending_review" && canApprove) return "review";
  if (status === "flagged" && canApprove) return "investigate";
  return "view";
}

/** The logged-in user's currently open session, if any (most recent first). */
export function findMyOpenSession(sessions: SessionRow[], clerkUserId: string | null | undefined): SessionRow | null {
  if (!clerkUserId) return null;
  const mine = sessions
    .filter((s) => s.status === "open" && s.opened_by_clerk_id === clerkUserId)
    .sort((a, b) => new Date(b.opened_at).getTime() - new Date(a.opened_at).getTime());
  return mine[0] ?? null;
}

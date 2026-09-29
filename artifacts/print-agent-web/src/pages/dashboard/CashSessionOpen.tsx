import { useState, useEffect, useId } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useLocation } from "wouter";
import { ArrowLeft, Loader2, MapPin, Monitor, User, Banknote, Clock, CheckCircle2, AlertCircle } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useUser } from "@clerk/react";
import { apiFetch } from "@/lib/queryClient";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { AlertTriangle } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { useToast } from "@/hooks/use-toast";
import { formatCashMoney, decimalPlaces } from "@/lib/cashMoney";
import { cn } from "@/lib/utils";

/** True when a location name refers to the CMC Beirut Hospital location. */
function isCmcLocation(name: string | null | undefined): boolean {
  if (!name) return false;
  return name.toLowerCase().includes("cmc beirut hospital");
}

type Location = {
  id: number;
  name: string;
};

type CashDrawer = {
  id: number;
  name: string;
  code: string;
  currency: string;
  secondary_currency: string | null;
  is_active: boolean;
  location_name: string | null;
  location_id: number | null;
  open_session_id: number | null;
  open_session_opened_at: string | null;
  open_session_operator_name: string | null;
};

type CashSession = {
  id: number;
  status: string;
  currency: string;
  secondary_currency: string | null;
  actual_cash: string | null;
  actual_cash_secondary: string | null;
};

function roundCents(value: number): number {
  return Math.round(value * 100) / 100;
}

function previousClosingFor(sessions: CashSession[], cur: string): number | null {
  for (const s of sessions) {
    if (s.status === "open") continue;
    if (s.currency === cur && s.actual_cash != null) return Number(s.actual_cash);
    if (s.secondary_currency === cur && s.actual_cash_secondary != null)
      return Number(s.actual_cash_secondary);
  }
  return null;
}

/** Format a relative time like "3 h ago" or "12 min ago" from an ISO date string. */
function relativeTime(isoStr: string): string {
  const diff = Date.now() - new Date(isoStr).getTime();
  const mins = Math.floor(diff / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} min ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs} h ago`;
  return new Date(isoStr).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

/** Format current time as "8 Aug 2026, 12:48 PM" */
function formatOpeningAt(): string {
  return new Date().toLocaleString("en-US", {
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

export default function CashSessionOpen() {
  const [, navigate] = useLocation();
  const { toast } = useToast();
  const { t } = useTranslation();
  const qc = useQueryClient();
  const { user } = useUser();

  // Generate a stable idempotency key for this page load / form session.
  const [idempotencyKey] = useState(() => crypto.randomUUID());

  const [locationId, setLocationId] = useState<string>("");
  const [drawerId, setDrawerId] = useState("");
  const [openingCash, setOpeningCash] = useState("");
  const [openingCashSecondary, setOpeningCashSecondary] = useState("");
  const [note, setNote] = useState("");
  const [openingAt, setOpeningAt] = useState(formatOpeningAt);
  const [conflictError, setConflictError] = useState<string | null>(null);

  // Update "Opening at" every minute.
  useEffect(() => {
    const timer = setInterval(() => setOpeningAt(formatOpeningAt()), 60_000);
    return () => clearInterval(timer);
  }, []);

  // Fetch locations for the location selector.
  const { data: locationsData } = useQuery<{ locations: Location[] }>({
    queryKey: ["locations-list"],
    queryFn: () => apiFetch("/api/locations"),
  });
  // Exclude the CMC Beirut Hospital location — its sessions must be opened
  // through the CMC POS Start Shift flow, not the generic page.
  const locations = (locationsData?.locations ?? []).filter(
    (l) => !isCmcLocation(l.name),
  );

  // Fetch all drawers, optionally filtered by location.
  const { data: drawersData, isLoading: drawersLoading } = useQuery<{ drawers: CashDrawer[] }>({
    queryKey: ["cash-drawers", locationId || null],
    queryFn: () =>
      apiFetch(`/api/cash-drawers${locationId ? `?location_id=${locationId}` : ""}`),
  });
  // Also filter out drawers that belong to the CMC Beirut Hospital location
  // (they appear under "All locations" if no location filter is selected).
  const allDrawers = (drawersData?.drawers ?? []).filter(
    (d) => d.is_active && !isCmcLocation(d.location_name),
  );
  const availableDrawers = allDrawers.filter((d) => !d.open_session_id);
  const occupiedDrawers = allDrawers.filter((d) => d.open_session_id);
  const selectedDrawer = allDrawers.find((d) => String(d.id) === drawerId) ?? null;
  const hasTwoCurrencies = Boolean(selectedDrawer?.secondary_currency);
  const mainCurrency = selectedDrawer?.currency ?? "";
  const secondaryCurrency = selectedDrawer?.secondary_currency ?? null;

  function selectLocation(v: string) {
    // "all" is the sentinel for "no location filter"
    setLocationId(v === "all" ? "" : v);
    setDrawerId(""); // reset drawer when location changes
    setOpeningCash("");
    setOpeningCashSecondary("");
    setConflictError(null);
  }

  function selectDrawer(id: string) {
    setDrawerId(id);
    setOpeningCash("");
    setOpeningCashSecondary("");
    setConflictError(null);
  }

  // Fetch previous sessions for mismatch warning.
  const { data: prevData } = useQuery<{ sessions: CashSession[] }>({
    queryKey: ["cash-sessions", "previous", drawerId],
    queryFn: () => apiFetch(`/api/cash-sessions?drawer_id=${drawerId}`),
    enabled: !!drawerId,
  });
  const prevSessions = prevData?.sessions ?? [];
  const previousClosingCash = selectedDrawer
    ? previousClosingFor(prevSessions, mainCurrency)
    : null;
  const previousClosingCashSecondary =
    selectedDrawer && secondaryCurrency
      ? previousClosingFor(prevSessions, secondaryCurrency)
      : null;

  const openMutation = useMutation({
    mutationFn: () =>
      apiFetch<{ session: { id: number } }>("/api/cash-sessions", {
        method: "POST",
        headers: { "X-Idempotency-Key": idempotencyKey },
        body: JSON.stringify({
          drawer_id: Number(drawerId),
          opening_cash: Number(openingCash),
          opening_note: note.trim() || null,
          ...(hasTwoCurrencies
            ? { opening_cash_secondary: Number(openingCashSecondary) }
            : {}),
        }),
      }),
    onSuccess: (res) => {
      toast({ title: "Cash session opened" });
      qc.invalidateQueries({ queryKey: ["cash-sessions"] });
      qc.invalidateQueries({ queryKey: ["cash-drawers"] });
      navigate(`/cash-sessions/${res.session.id}`);
    },
    onError: (err: Error & { status?: number }) => {
      if (err.message && (err.message.includes("opened this drawer") || err.message.includes("drawer already"))) {
        setConflictError(err.message);
        qc.invalidateQueries({ queryKey: ["cash-drawers"] });
      } else {
        toast({ title: err.message || "Failed to open session", variant: "destructive" });
      }
    },
  });

  // Validation
  const mainCashNum = openingCash === "" ? null : Number(openingCash);
  const secondaryCashNum = openingCashSecondary === "" ? null : Number(openingCashSecondary);

  const enteredCash = mainCashNum;
  const enteredCashSecondary = secondaryCashNum;

  const mismatchMain =
    previousClosingCash != null &&
    enteredCash != null &&
    Number.isFinite(enteredCash) &&
    roundCents(enteredCash) !== roundCents(previousClosingCash);
  const mismatchSecondary =
    hasTwoCurrencies &&
    previousClosingCashSecondary != null &&
    enteredCashSecondary != null &&
    Number.isFinite(enteredCashSecondary) &&
    roundCents(enteredCashSecondary) !== roundCents(previousClosingCashSecondary);
  const mismatch = mismatchMain || mismatchSecondary;

  const noAvailableDrawers = allDrawers.length > 0 && availableDrawers.length === 0;

  const valid =
    !!drawerId &&
    !selectedDrawer?.open_session_id && // selected drawer must be available
    openingCash !== "" &&
    mainCashNum !== null &&
    Number.isFinite(mainCashNum) &&
    mainCashNum >= 0 &&
    (!hasTwoCurrencies ||
      (openingCashSecondary !== "" &&
        secondaryCashNum !== null &&
        Number.isFinite(secondaryCashNum) &&
        secondaryCashNum >= 0));

  const formatAmount = (amount: number, cur: string) => formatCashMoney(amount, cur);
  const formatCash = (amount: number) => formatCashMoney(amount, selectedDrawer?.currency);

  const mismatchParts: string[] = [];
  if (mismatchMain && previousClosingCash != null && enteredCash != null) {
    mismatchParts.push(
      `${formatAmount(previousClosingCash, mainCurrency)} (you entered ${formatAmount(enteredCash, mainCurrency)})`,
    );
  }
  if (
    mismatchSecondary &&
    previousClosingCashSecondary != null &&
    enteredCashSecondary != null &&
    secondaryCurrency
  ) {
    mismatchParts.push(
      `${formatAmount(previousClosingCashSecondary, secondaryCurrency)} (you entered ${formatAmount(enteredCashSecondary, secondaryCurrency)})`,
    );
  }

  const handleOpen = () => {
    if (mismatch) {
      toast({
        title: "Opening cash doesn't match",
        description: `The previous session for this drawer closed with ${mismatchParts.join(
          " and ",
        )}. Cash carries over between shifts — please re-check the drawer and enter the matching amount before opening.`,
        variant: "destructive",
      });
      return;
    }
    setConflictError(null);
    openMutation.mutate();
  };

  const operatorName =
    user
      ? ([user.firstName, user.lastName].filter(Boolean).join(" ") ||
          user.primaryEmailAddress?.emailAddress ||
          "")
      : "";

  // Opening cash amounts for the summary card
  const summaryAmounts: { currency: string; value: string }[] = [];
  if (selectedDrawer) {
    const mainVal =
      openingCash !== "" && mainCashNum !== null && Number.isFinite(mainCashNum)
        ? formatAmount(mainCashNum, mainCurrency)
        : "—";
    summaryAmounts.push({ currency: mainCurrency, value: mainVal });
    if (hasTwoCurrencies && secondaryCurrency) {
      const secVal =
        openingCashSecondary !== "" && secondaryCashNum !== null && Number.isFinite(secondaryCashNum)
          ? formatAmount(secondaryCashNum, secondaryCurrency)
          : "—";
      summaryAmounts.push({ currency: secondaryCurrency, value: secVal });
    }
  }

  const selectedLocationName =
    locationId
      ? (locations.find((l) => String(l.id) === locationId)?.name ?? selectedDrawer?.location_name ?? "")
      : (selectedDrawer?.location_name ?? "");

  return (
    <div className="mx-auto max-w-5xl space-y-6 p-4 md:p-6">
      {/* Page chrome */}
      <div className="space-y-1">
        <Button
          variant="ghost"
          size="sm"
          onClick={() => navigate("/cash-sessions")}
          className="gap-1.5 -ml-2 text-muted-foreground"
        >
          <ArrowLeft className="h-4 w-4" />
          Cash Sessions
        </Button>
        <div className="flex items-start justify-between gap-4">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">Start Cash Session</h1>
            <p className="text-sm text-muted-foreground mt-0.5">
              Select an available drawer and record the opening cash.
            </p>
          </div>
          <div className="flex items-center gap-1.5 text-xs text-muted-foreground pt-1">
            <AlertCircle className="h-3.5 w-3.5 shrink-0" />
            A drawer can only have one open session at a time.
          </div>
        </div>
      </div>

      {/* Two-column layout */}
      <div className="grid gap-6 md:grid-cols-[1fr_340px]">
        {/* Left: Session details */}
        <Card>
          <CardHeader className="pb-4">
            <CardTitle className="text-base">Session details</CardTitle>
          </CardHeader>
          <CardContent className="space-y-5">
            {/* Location + Operator row */}
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-1.5">
                <Label>Location</Label>
                <Select value={locationId || "all"} onValueChange={selectLocation}>
                  <SelectTrigger>
                    <SelectValue placeholder="All locations" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All locations</SelectItem>
                    {locations.map((l) => (
                      <SelectItem key={l.id} value={String(l.id)}>
                        {l.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label>Operator</Label>
                <div className="flex h-9 w-full items-center rounded-md border border-input bg-muted/40 px-3 text-sm text-muted-foreground">
                  {operatorName || "—"}
                  <span className="ml-1.5 text-xs text-muted-foreground">(you)</span>
                </div>
              </div>
            </div>

            {/* Drawer list */}
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <Label>Drawer</Label>
                {allDrawers.length > 0 && (
                  <span className="text-xs text-muted-foreground">
                    {availableDrawers.length} of {allDrawers.length} drawer
                    {allDrawers.length !== 1 ? "s" : ""} available
                  </span>
                )}
              </div>

              {drawersLoading ? (
                <div className="flex items-center gap-2 py-3 text-sm text-muted-foreground">
                  <Loader2 className="h-4 w-4 animate-spin" />
                  Loading drawers…
                </div>
              ) : allDrawers.length === 0 ? (
                <p className="text-sm text-muted-foreground py-2">
                  No drawers found{locationId ? " for this location" : ""}.
                </p>
              ) : (
                <div className="space-y-2">
                  {allDrawers.map((drawer) => {
                    const isOccupied = Boolean(drawer.open_session_id);
                    const isSelected = String(drawer.id) === drawerId;
                    return (
                      <button
                        key={drawer.id}
                        type="button"
                        disabled={isOccupied}
                        onClick={() => !isOccupied && selectDrawer(String(drawer.id))}
                        className={cn(
                          "w-full rounded-md border px-4 py-3 text-left transition-colors",
                          isOccupied
                            ? "cursor-not-allowed bg-muted/30 opacity-70"
                            : isSelected
                            ? "border-primary bg-primary/5 ring-1 ring-primary"
                            : "hover:border-primary/40 hover:bg-accent/50",
                        )}
                      >
                        <div className="flex items-center justify-between gap-3">
                          <div className="flex items-center gap-2.5 min-w-0">
                            {/* Radio indicator */}
                            <div
                              className={cn(
                                "h-4 w-4 shrink-0 rounded-full border-2 flex items-center justify-center",
                                isSelected && !isOccupied
                                  ? "border-primary"
                                  : "border-muted-foreground/40",
                              )}
                            >
                              {isSelected && !isOccupied && (
                                <div className="h-2 w-2 rounded-full bg-primary" />
                              )}
                            </div>
                            <div className="min-w-0">
                              <span className="font-medium text-sm">{drawer.name}</span>
                              <span className="ml-1.5 text-xs text-muted-foreground">
                                ({drawer.code})
                              </span>
                              <span className="ml-1.5 text-xs text-muted-foreground">
                                ·{" "}
                                {drawer.secondary_currency
                                  ? `${drawer.currency} / ${drawer.secondary_currency}`
                                  : drawer.currency}
                              </span>
                            </div>
                          </div>
                          {isOccupied ? (
                            <div className="flex items-center gap-2 shrink-0">
                              <Badge variant="secondary" className="text-xs font-normal">
                                In use
                              </Badge>
                              <div className="text-right text-xs text-muted-foreground leading-tight">
                                {drawer.open_session_operator_name && (
                                  <div className="font-medium text-foreground/70">
                                    {drawer.open_session_operator_name}
                                  </div>
                                )}
                                {drawer.open_session_opened_at && (
                                  <div>{relativeTime(drawer.open_session_opened_at)}</div>
                                )}
                              </div>
                            </div>
                          ) : (
                            <Badge className="text-xs bg-emerald-100 text-emerald-800 dark:bg-emerald-900/30 dark:text-emerald-400 font-normal shrink-0">
                              Available
                            </Badge>
                          )}
                        </div>
                      </button>
                    );
                  })}

                  {occupiedDrawers.length > 0 && (
                    <p className="text-xs text-muted-foreground flex items-center gap-1.5 pt-1">
                      <AlertCircle className="h-3 w-3 shrink-0" />
                      Occupied drawers cannot start another session.
                    </p>
                  )}

                  {noAvailableDrawers && (
                    <Alert variant="destructive" className="mt-2">
                      <AlertTriangle className="h-4 w-4" />
                      <AlertTitle>All drawers are occupied</AlertTitle>
                      <AlertDescription>
                        Close one of the open sessions above before starting a new one.
                      </AlertDescription>
                    </Alert>
                  )}
                </div>
              )}
            </div>

            {/* Opening cash */}
            {selectedDrawer && (
              <div className="space-y-2">
                <div>
                  <Label>Opening cash</Label>
                  <p className="text-xs text-muted-foreground mt-0.5">
                    Enter the amount physically counted in each currency.
                  </p>
                </div>
                <div className={cn("grid gap-3", hasTwoCurrencies ? "grid-cols-2" : "grid-cols-1 max-w-[200px]")}>
                  {/* Main currency */}
                  <CurrencyInput
                    currency={mainCurrency}
                    value={openingCash}
                    onChange={setOpeningCash}
                    previousClosing={previousClosingCash}
                    formatAmount={formatAmount}
                    formatCash={formatCash}
                  />
                  {/* Secondary currency */}
                  {hasTwoCurrencies && secondaryCurrency && (
                    <CurrencyInput
                      currency={secondaryCurrency}
                      value={openingCashSecondary}
                      onChange={setOpeningCashSecondary}
                      previousClosing={previousClosingCashSecondary}
                      formatAmount={formatAmount}
                      formatCash={(v) => formatCashMoney(v, secondaryCurrency)}
                    />
                  )}
                </div>
                <p className="text-xs text-muted-foreground">
                  These amounts become the expected starting balance.
                </p>
              </div>
            )}

            {/* Mismatch warning */}
            {mismatch && (
              <Alert variant="destructive">
                <AlertTriangle className="h-4 w-4" />
                <AlertTitle>Opening cash doesn't match</AlertTitle>
                <AlertDescription>
                  This drawer's previous session closed with {mismatchParts.join(" and ")}. Cash
                  carries over between shifts — please re-check the drawer and enter the matching
                  amount before opening.
                </AlertDescription>
              </Alert>
            )}

            {/* Conflict error (409) */}
            {conflictError && (
              <Alert variant="destructive">
                <AlertTriangle className="h-4 w-4" />
                <AlertTitle>Drawer no longer available</AlertTitle>
                <AlertDescription>{conflictError}</AlertDescription>
              </Alert>
            )}

            {/* Opening note */}
            <div className="space-y-1.5">
              <Label>Opening note</Label>
              <Textarea
                value={note}
                onChange={(e) => setNote(e.target.value)}
                rows={2}
                placeholder="Optional note about the handover or cash count"
              />
            </div>

            {/* Actions */}
            <div className="flex justify-end gap-2 pt-1">
              <Button
                variant="outline"
                onClick={() => navigate("/cash-sessions")}
              >
                Cancel
              </Button>
              <Button
                disabled={!valid || mismatch || noAvailableDrawers || openMutation.isPending}
                onClick={handleOpen}
                className="gap-1.5"
              >
                {openMutation.isPending && <Loader2 className="h-4 w-4 animate-spin" />}
                Open cash session
              </Button>
            </div>
          </CardContent>
        </Card>

        {/* Right: Session summary */}
        <Card className="h-fit">
          <CardHeader className="pb-4">
            <CardTitle className="text-base">Session summary</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <SummaryRow icon={<MapPin className="h-4 w-4" />} label="Location">
              {selectedLocationName || <span className="text-muted-foreground italic">Not selected</span>}
            </SummaryRow>
            <SummaryRow icon={<Monitor className="h-4 w-4" />} label="Drawer">
              {selectedDrawer
                ? `${selectedDrawer.name} · ${selectedDrawer.code}`
                : <span className="text-muted-foreground italic">Not selected</span>}
            </SummaryRow>
            <SummaryRow icon={<User className="h-4 w-4" />} label="Operator">
              {operatorName || <span className="text-muted-foreground italic">Unknown</span>}
            </SummaryRow>
            <SummaryRow icon={<Banknote className="h-4 w-4" />} label="Opening cash">
              {summaryAmounts.length > 0 ? (
                <div className="space-y-0.5">
                  {summaryAmounts.map((a) => (
                    <div key={a.currency} className="font-medium">
                      {a.value}
                    </div>
                  ))}
                </div>
              ) : (
                <span className="text-muted-foreground italic">—</span>
              )}
            </SummaryRow>

            <div className="border-t pt-4 space-y-3">
              {valid && !mismatch ? (
                <div className="flex items-center gap-2 rounded-md bg-emerald-50 dark:bg-emerald-900/20 border border-emerald-200 dark:border-emerald-800 px-3 py-2">
                  <CheckCircle2 className="h-4 w-4 text-emerald-600 dark:text-emerald-400 shrink-0" />
                  <span className="text-sm font-medium text-emerald-700 dark:text-emerald-300">
                    Ready to open
                  </span>
                </div>
              ) : (
                <div className="flex items-center gap-2 rounded-md bg-muted/50 border border-border/60 px-3 py-2">
                  <div className="h-4 w-4 rounded-full border-2 border-muted-foreground/30 shrink-0" />
                  <span className="text-sm text-muted-foreground">Fill in all required fields</span>
                </div>
              )}

              <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <Clock className="h-3.5 w-3.5 shrink-0" />
                Opening at {openingAt}
              </div>
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

// Sub-components

type CurrencyInputProps = {
  currency: string;
  value: string;
  onChange: (v: string) => void;
  previousClosing: number | null;
  formatAmount: (amount: number, cur: string) => string;
  formatCash: (amount: number) => string;
};

function CurrencyInput({ currency, value, onChange, previousClosing, formatAmount, formatCash }: CurrencyInputProps) {
  const isZeroDecimal = decimalPlaces(currency) === 0;
  const labelId = useId();

  const handleBlur = () => {
    if (!value) return;
    const num = Number(value);
    if (!Number.isFinite(num) || num < 0) return;
    if (isZeroDecimal) {
      // Snap to integer for zero-decimal currencies
      onChange(String(Math.round(num)));
    } else {
      onChange(num.toFixed(2));
    }
  };

  return (
    <div className="space-y-1.5">
      <Label htmlFor={labelId}>{currency}</Label>
      <div className="flex items-center gap-1.5">
        <span className="text-xs font-medium text-muted-foreground w-8 shrink-0">{currency}</span>
        <Input
          id={labelId}
          type="number"
          min="0"
          step={isZeroDecimal ? "1" : "0.01"}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onBlur={handleBlur}
          placeholder={isZeroDecimal ? "0" : "0.00"}
          className="flex-1"
        />
      </div>
      {previousClosing != null && (
        <p className="text-xs text-muted-foreground">
          Previous closed with {formatAmount(previousClosing, currency)}. Cash should carry over.
        </p>
      )}
    </div>
  );
}

type SummaryRowProps = {
  icon: React.ReactNode;
  label: string;
  children: React.ReactNode;
};

function SummaryRow({ icon, label, children }: SummaryRowProps) {
  return (
    <div className="flex items-start justify-between gap-3">
      <div className="flex items-center gap-2 text-muted-foreground shrink-0 min-w-[100px]">
        {icon}
        <span className="text-sm">{label}</span>
      </div>
      <div className="text-sm font-medium text-right">{children}</div>
    </div>
  );
}

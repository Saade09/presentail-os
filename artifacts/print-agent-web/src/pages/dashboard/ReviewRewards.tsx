import { useState, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { useQuery, useMutation } from "@tanstack/react-query";
import { apiFetch, queryClient } from "@/lib/queryClient";
import { useWorkspaceRole } from "@/hooks/use-workspace-role";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  ChartLegend,
  ChartLegendContent,
  type ChartConfig,
} from "@/components/ui/chart";
import { CartesianGrid, Line, LineChart, XAxis, YAxis } from "recharts";
import {
  Star,
  QrCode,
  Plus,
  Download,
  Link2,
  Pencil,
  PauseCircle,
  PlayCircle,
  Info,
  CheckCircle2,
  XCircle,
  ScanLine,
  TrendingUp,
  TrendingDown,
  DollarSign,
  MessageSquare,
  Clock,
  Loader2,
  KeyRound,
  MapPin,
  ChevronsUpDown,
  CircleAlert,
} from "lucide-react";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";

// ── API types ─────────────────────────────────────────────────────────────────

type GbpStatus = {
  enabled: boolean;
  connected: boolean;
  credentialsSaved?: boolean;
  credentialsFromEnv?: boolean;
  credentialSource?: "workspace" | "environment" | "none";
  clientId?: string | null;
  credentialError?: string | null;
  locationSelected: boolean;
  locationTitle: string | null;
  connectedLocationCount?: number;
  lastSyncedAt: string | null;
  lastError: string | null;
  enabledCount?: number;
};

// Matches GET /api/review-rewards/locations/performance response shape exactly.
type LocationPerformance = {
  locationId: number;
  locationTitle: string | null;
  /** Neighbourhood/city from GBP storefrontAddress (e.g. "Achrafieh", "Jdeideh"). */
  locationLocality?: string | null;
  /** Country name from gbp_location_connections.country (e.g. "Lebanon", "UAE"). */
  country?: string | null;
  syncStatus: string | null;
  lastSyncedAt: string | null;
  /** Contains the last_error string from the DB; null means no error (healthy). */
  googleStatus: string | null;
  reviewCount: number;
  scanCount: number;
  /** Fraction 0–1 (already computed by the API). */
  conversionRate: number;
  rewardsEarned: number | string;
};

/** Maps a GBP location country name to its payout currency code. */
function getLocationCurrency(country: string | null | undefined): "USD" | "AED" {
  const map: Record<string, "USD" | "AED"> = {
    Lebanon: "USD",
    UAE: "AED",
  };
  return (country && map[country]) || "USD";
}

type Profile = {
  id: number;
  employeeName: string;
  role: string | null;
  rewardAmount: number;
  code: string;
  trackingUrl: string;
  trackingPath: string;
  isActive: boolean;
  gbpLocationId?: number | null;
  teamMemberId?: number | null;
  workspaceMemberId?: number | null;
  rewardCurrency?: string;
  createdAt: string;
  updatedAt: string;
};

type OverviewMetrics = {
  days: number;
  scans: number;
  flaggedScans: number;
  newReviews: number;
  matchedReviews: number;
  needsReview: number;
  conversionRate: number;
  rewardsByStatus: Record<string, { count: number; totalAmount: number }>;
};

type TrendPoint = { day: string; scans: number; matchedReviews: number };

type EmployeeMetric = {
  id: number;
  employee_name: string;
  role: string | null;
  is_active: boolean;
  scans: number;
  matched_reviews: number;
  pending_amount: number | string;
  approved_amount: number | string;
  paid_amount: number | string;
};

type LatestMatch = {
  id: number;
  reviewer_name: string | null;
  rating: number | null;
  comment: string | null;
  review_created_at: string;
  match_status: string;
  match_resolved_at: string | null;
  employee_name: string | null;
};

type Review = {
  id: number;
  reviewer_name: string | null;
  rating: number | null;
  comment: string | null;
  review_created_at: string;
  match_status: string;
  matched_employee_name: string | null;
  matched_scan_id: number | null;
};

type Reward = {
  id: number;
  amount: number | string;
  status: string;
  pending_until: string;
  approved_at: string | null;
  paid_at: string | null;
  created_at: string;
  employee_name: string;
  reviewer_name: string | null;
  rating: number | null;
};

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Return a human-readable label for a location entry.
 * When a locality (neighbourhood/city) is present it is appended with an em-dash
 * so branches that share the same title become distinguishable at a glance.
 * e.g. "Presentail — Achrafieh", "Presentail — Jdeideh".
 */
function formatLocationLabel(loc: {
  locationId: number;
  locationTitle?: string | null;
  locationLocality?: string | null;
}): string {
  const title = loc.locationTitle ?? String(loc.locationId);
  return loc.locationLocality ? `${title} — ${loc.locationLocality}` : title;
}

function num(v: number | string | null | undefined): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function errorMessage(error: unknown): string {
  return error instanceof Error && error.message
    ? error.message
    : "Please check your access and try again.";
}

function QueryErrorAlert({
  error,
  testId = "review-rewards-load-error",
}: {
  error: unknown;
  testId?: string;
}) {
  return (
    <div
      role="alert"
      className="rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive"
      data-testid={testId}
    >
      Couldn&apos;t load all Review Rewards data. Please check your access and try again.
      <span className="ml-1">{errorMessage(error)}</span>
    </div>
  );
}

function formatAmount(v: number | string | null | undefined): string {
  return `$${num(v).toFixed(2)}`;
}

function formatDate(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

function formatDateTime(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function RatingStars({ rating }: { rating: number | null }) {
  if (rating == null) return <span className="text-muted-foreground">—</span>;
  return (
    <span className="inline-flex items-center gap-0.5" aria-label={`${rating}/5`}>
      {Array.from({ length: 5 }).map((_, i) => (
        <Star
          key={i}
          size={13}
          className={i < rating ? "fill-amber-400 text-amber-400" : "text-muted-foreground/30"}
        />
      ))}
    </span>
  );
}

function MatchStatusChip({ status }: { status: string }) {
  const { t } = useTranslation();
  if (status === "auto_matched" || status === "matched") {
    return (
      <Badge variant="outline" className="bg-green-50 text-green-700 border-green-200" data-testid={`chip-match-${status}`}>
        {t("reviewRewards.matchStatus.autoMatched")}
      </Badge>
    );
  }
  if (status === "manually_matched") {
    return (
      <Badge variant="outline" className="bg-green-50 text-green-700 border-green-200" data-testid={`chip-match-${status}`}>
        {t("reviewRewards.matchStatus.manuallyMatched")}
      </Badge>
    );
  }
  if (status === "needs_review" || status === "pending") {
    return (
      <Badge variant="outline" className="bg-amber-50 text-amber-700 border-amber-200" data-testid={`chip-match-${status}`}>
        {t("reviewRewards.matchStatus.needsReview")}
      </Badge>
    );
  }
  if (status === "rejected") {
    return (
      <Badge variant="outline" className="bg-red-50 text-red-700 border-red-200" data-testid={`chip-match-${status}`}>
        {t("reviewRewards.matchStatus.rejected")}
      </Badge>
    );
  }
  return (
    <Badge variant="outline" className="bg-gray-50 text-gray-600 border-gray-200" data-testid={`chip-match-${status}`}>
      {t("reviewRewards.matchStatus.organic")}
    </Badge>
  );
}

function RewardStatusChip({ status }: { status: string }) {
  const { t } = useTranslation();
  const map: Record<string, { cls: string; label: string }> = {
    pending: { cls: "bg-amber-50 text-amber-700 border-amber-200", label: t("reviewRewards.rewardStatus.pending") },
    approved: { cls: "bg-blue-50 text-blue-700 border-blue-200", label: t("reviewRewards.rewardStatus.approved") },
    paid: { cls: "bg-green-50 text-green-700 border-green-200", label: t("reviewRewards.rewardStatus.paid") },
    voided: { cls: "bg-gray-50 text-gray-600 border-gray-200", label: t("reviewRewards.rewardStatus.voided") },
  };
  const cfg = map[status] ?? { cls: "bg-gray-50 text-gray-600 border-gray-200", label: status };
  return (
    <Badge variant="outline" className={cfg.cls} data-testid={`chip-reward-${status}`}>
      {cfg.label}
    </Badge>
  );
}

/**
 * The API returns `googleStatus` as the raw `last_error` column value:
 * null means the location is healthy/connected; a non-null string is an error.
 */
function LocationStatusBadge({ googleStatus }: { googleStatus: string | null }) {
  const { t } = useTranslation();
  if (!googleStatus) {
    return (
      <Badge variant="outline" className="text-[10px] bg-green-50 text-green-700 border-green-200">
        {t("reviewRewards.locationStatus.connected")}
      </Badge>
    );
  }
  return (
    <Badge variant="outline" className="text-[10px] bg-amber-50 text-amber-700 border-amber-200" title={googleStatus}>
      {t("reviewRewards.locationStatus.needsAttention")}
    </Badge>
  );
}

function StatCard({
  icon: Icon,
  label,
  value,
  hint,
  testId,
}: {
  icon: React.ElementType;
  label: string;
  value: string;
  hint?: string;
  testId?: string;
}) {
  return (
    <Card data-testid={testId}>
      <CardContent className="p-4">
        <div className="flex items-center justify-between">
          <span className="text-sm text-muted-foreground">{label}</span>
          <Icon size={16} className="text-muted-foreground" />
        </div>
        <div className="mt-2 text-2xl font-semibold tracking-tight">{value}</div>
        {hint && <div className="mt-1 text-xs text-muted-foreground">{hint}</div>}
      </CardContent>
    </Card>
  );
}

function AttributionNote() {
  const { t } = useTranslation();
  return (
    <div
      className="flex items-start gap-2 rounded-lg border border-border bg-muted/40 px-3 py-2 text-xs text-muted-foreground"
      data-testid="attribution-note"
    >
      <Info size={14} className="mt-0.5 shrink-0" />
      <span>{t("reviewRewards.attributionNote")}</span>
    </div>
  );
}

type GbpConnectionStatus = "connected" | "available" | "needs_attention" | "not_connected";

type GbpLocation = {
  name: string;
  title: string | null;
  address?: string | null;
  /** Neighbourhood/city from the GBP storefront address, used to disambiguate
   *  branches that share the same title (e.g. "Presentail — Achrafieh"). */
  locality?: string | null;
  /** Null means Google's current response did not include verification metadata. */
  verified: boolean | null;
  accountName: string;
  accountLabel: string | null;
  selected: boolean;
  /** Legacy snake_case field from API */
  is_enabled?: boolean;
  /** camelCase alias — preferred by newer API responses */
  isEnabled?: boolean;
  /** Unified connection status from newer API */
  connectionStatus?: GbpConnectionStatus;
  /** Legacy status alias (may be present in older responses) */
  status?: string;
  locationId?: number | null;
  connectionId?: number | null;
  lastSyncedAt?: string | null;
  lastError?: string | null;
  syncStatus?: string | null;
  googleStatus?: string | null;
  /** Per-location Google review URL */
  reviewUrl?: string | null;
  /** False when this stored location is absent from Google's current listing. */
  availableInGoogle?: boolean;
};

type GbpAccountContext = {
  name: string;
  accountName: string | null;
  type: string | null;
};

type GbpCredentialStatus = {
  saved: boolean;
  credentialsFromEnv: boolean;
  credentialSource: "workspace" | "environment" | "none";
  clientId: string | null;
  credentialError: string | null;
};

// ── GBP location connection status badge ──────────────────────────────────────


function GbpLocationStatusBadge({ status }: { status?: GbpConnectionStatus | string }) {
  if (status === "connected") {
    return (
      <Badge variant="outline" className="bg-green-50 text-green-700 border-green-200 text-[10px] shrink-0">
        Connected
      </Badge>
    );
  }
  if (status === "available") {
    return (
      <Badge variant="outline" className="bg-blue-50 text-blue-700 border-blue-200 text-[10px] shrink-0">
        Available
      </Badge>
    );
  }
  if (status === "needs_attention") {
    return (
      <Badge variant="outline" className="bg-amber-50 text-amber-700 border-amber-200 text-[10px] shrink-0">
        Needs attention
      </Badge>
    );
  }
  return (
    <Badge variant="outline" className="bg-gray-50 text-gray-500 border-gray-200 text-[10px] shrink-0">
      Not connected
    </Badge>
  );
}
function GoogleStatusPill({
  isOwner,
  onOpenManageLocations,
  onRequestDisconnect,
}: {
  isOwner: boolean;
  onOpenManageLocations: () => void;
  onRequestDisconnect: () => void;
}) {
  const { t } = useTranslation();
  const { toast } = useToast();
  const [connecting, setConnecting] = useState(false);

  const { data, isLoading, isError, error } = useQuery({
    queryKey: ["gbp-status"],
    queryFn: () => apiFetch<GbpStatus>("/api/reviews/google/status"),
    retry: false,
  });

  const handleConnect = async () => {
    setConnecting(true);
    try {
      const result = await apiFetch<{ url: string }>("/api/reviews/google/auth-url");
      window.location.href = result.url;
    } catch (err) {
      toast({
        title: t("reviewRewards.connectFailed"),
        description: (err as Error).message,
        variant: "destructive",
      });
      setConnecting(false);
    }
  };

  if (isLoading) {
    return <Skeleton className="h-6 w-32 rounded-full" data-testid="google-status-loading" />;
  }

  if (isError) {
    return (
      <div
        role="alert"
        className="rounded-md border border-destructive/30 bg-destructive/5 px-2 py-1 text-xs text-destructive"
        data-testid="google-status-error"
      >
        Google status unavailable: {errorMessage(error)}
      </div>
    );
  }

  // Prefer enabledCount; fall back to connectedLocationCount (legacy) then locationSelected (oldest)
  const locationCount =
    data?.enabledCount ?? data?.connectedLocationCount ?? (data?.locationSelected ? 1 : 0);

  // Connected with at least one location tracked
  if (data?.connected && locationCount > 0) {
    return (
      <div className="flex items-center gap-2">
        <Badge variant="outline" className="bg-green-50 text-green-700 border-green-200 gap-1" data-testid="google-status-connected">
          <CheckCircle2 size={12} />
          {t("reviewRewards.googleConnected")}
          {` · ${locationCount} ${locationCount === 1 ? "location" : "locations"}`}
        </Badge>
        {isOwner && (
          <>
            <Button
              variant="ghost"
              size="sm"
              className="h-6 px-2 text-xs text-muted-foreground hover:text-foreground"
              onClick={onOpenManageLocations}
              data-testid="button-gbp-manage-locations"
            >
              {t("reviewRewards.manageLocations")}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className="h-6 px-2 text-xs text-muted-foreground hover:text-destructive"
              onClick={onRequestDisconnect}
              data-testid="button-gbp-disconnect"
            >
              {t("reviewRewards.disconnect")}
            </Button>
          </>
        )}
      </div>
    );
  }

  // Connected but no locations selected → incomplete/amber state
  if (data?.connected && locationCount === 0) {
    return (
      <div className="flex items-center gap-2">
        <Badge variant="outline" className="bg-amber-50 text-amber-700 border-amber-200 gap-1" data-testid="google-status-connected">
          <XCircle size={12} />
          {t("reviewRewards.googleLocationNotSet")}
        </Badge>
        {isOwner && (
          <>
            <Button
              variant="outline"
              size="sm"
              className="h-6 px-2 text-xs"
              onClick={onOpenManageLocations}
              data-testid="button-gbp-manage-locations"
            >
              {t("reviewRewards.manageLocations")}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className="h-6 px-2 text-xs text-muted-foreground hover:text-destructive"
              onClick={onRequestDisconnect}
              data-testid="button-gbp-disconnect"
            >
              {t("reviewRewards.disconnect")}
            </Button>
          </>
        )}
      </div>
    );
  }

  // Not connected
  return (
    <div className="flex items-center gap-2">
      <Badge variant="outline" className="bg-amber-50 text-amber-700 border-amber-200 gap-1" data-testid="google-status-disconnected">
        <XCircle size={12} />
        {t("reviewRewards.googleNotConnected")}
      </Badge>
      {isOwner && (
        <Button
          variant="outline"
          size="sm"
          className="h-6 px-2 text-xs"
          onClick={handleConnect}
          disabled={connecting}
          data-testid="button-gbp-connect"
        >
          {connecting && <Loader2 size={10} className="mr-1 animate-spin" />}
          {connecting ? t("reviewRewards.connecting") : t("reviewRewards.connectGoogle")}
        </Button>
      )}
    </div>
  );
}

// ── Manage locations dialog (multi-select) ─────────────────────────────────────

function GbpManageLocationsDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { t } = useTranslation();
  const { toast } = useToast();
  const [checkedNames, setCheckedNames] = useState<Set<string>>(new Set());
  const [reconnecting, setReconnecting] = useState(false);

  const { data, isLoading, isError, error } = useQuery({
    queryKey: ["gbp-locations"],
    queryFn: () => apiFetch<{
      locations: GbpLocation[];
      accounts?: GbpAccountContext[];
      connectedAccount?: { name: string | null; label: string | null };
    }>("/api/reviews/google/locations"),
    enabled: open,
    retry: false,
  });

  const locations = data?.locations ?? [];
  const selectableLocations = locations.filter(
    (l) => l.verified !== false && l.availableInGoogle !== false,
  );
  const unavailableSelected = locations.some(
    (l) => l.availableInGoogle === false && checkedNames.has(l.name),
  );

  // Pre-select currently connected/enabled locations when dialog opens
  useEffect(() => {
    if (open && locations.length > 0) {
      setCheckedNames(
        new Set(
          locations
             .filter((l) => l.isEnabled ?? l.is_enabled ?? l.selected ?? (l.connectionStatus === "connected" || l.status === "connected"))
            .map((l) => l.name),
        ),
      );
    }
  }, [open, locations]);

  const allSelectableSelected =
    selectableLocations.length > 0 && selectableLocations.every((l) => checkedNames.has(l.name));
  const someSelectableSelected = selectableLocations.some((l) => checkedNames.has(l.name));

  const toggleSelectAll = () => {
    if (allSelectableSelected) {
      setCheckedNames(new Set());
    } else {
      setCheckedNames(new Set(selectableLocations.map((l) => l.name)));
    }
  };

  const toggleLocation = (name: string) => {
    setCheckedNames((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else {
        const location = locations.find((l) => l.name === name);
        if (location?.availableInGoogle !== false && location?.verified !== false) next.add(name);
      }
      return next;
    });
  };

  const reconnectGoogle = async () => {
    setReconnecting(true);
    try {
      const result = await apiFetch<{ url: string }>("/api/reviews/google/auth-url");
      window.location.href = result.url;
    } catch (err) {
      toast({
        title: t("reviewRewards.connectFailed"),
        description: errorMessage(err),
        variant: "destructive",
      });
      setReconnecting(false);
    }
  };

  const saveMutation = useMutation({
    mutationFn: () =>
      apiFetch("/api/reviews/google/locations", {
        method: "POST",
        body: JSON.stringify({ locationNames: Array.from(checkedNames) }),
      }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["gbp-status"] });
      await queryClient.invalidateQueries({ queryKey: ["gbp-locations"] });
      await queryClient.invalidateQueries({ queryKey: ["review-rewards-locations-performance"] });
      onOpenChange(false);
      toast({ title: t("reviewRewards.locationSaved") });
    },
    onError: (err: Error) => {
      toast({ title: err.message, variant: "destructive" });
    },
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg" data-testid="gbp-location-dialog">
        <DialogHeader>
          <DialogTitle>{t("reviewRewards.gbpLocationDialog.manageTitle")}</DialogTitle>
          <DialogDescription>{t("reviewRewards.gbpLocationDialog.manageDescription")}</DialogDescription>
        </DialogHeader>

        <div className="min-h-[120px]">
          {isLoading && (
            <div className="flex items-center justify-center py-8">
              <Loader2 size={20} className="animate-spin text-muted-foreground" />
            </div>
          )}
          {isError && (
            <div className="space-y-3 py-4 text-center">
              <p className="text-sm text-destructive" role="alert">
                {errorMessage(error)}
              </p>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={reconnectGoogle}
                disabled={reconnecting}
                data-testid="button-gbp-load-error-reconnect"
              >
                {reconnecting && <Loader2 size={12} className="mr-1.5 animate-spin" />}
                Reconnect Google Business Profile
              </Button>
            </div>
          )}
          {!isLoading && !isError && locations.length === 0 && (
            <div className="space-y-3 py-4" data-testid="gbp-no-locations">
              <p className="text-center text-sm text-muted-foreground">
                {t("reviewRewards.gbpLocationDialog.noLocations")}
              </p>
              {(data?.accounts?.length ?? 0) > 0 ? (
                <div
                  className="rounded-md border border-border bg-muted/30 p-3"
                  data-testid="gbp-account-context"
                >
                  <p className="mb-2 text-xs font-medium">
                    {t("reviewRewards.gbpLocationDialog.accountsChecked")}
                  </p>
                  <ul className="space-y-1">
                    {data!.accounts!.map((account) => (
                      <li key={account.name} className="flex flex-wrap items-baseline gap-x-2 text-xs">
                        <span>{account.accountName || account.name}</span>
                        <code className="text-[10px] text-muted-foreground">{account.name}</code>
                        {account.type && (
                          <span className="text-[10px] text-muted-foreground">{account.type}</span>
                        )}
                      </li>
                    ))}
                  </ul>
                </div>
              ) : data?.connectedAccount?.name ? (
                <div
                  className="rounded-md border border-border bg-muted/30 p-3 text-xs"
                  data-testid="gbp-account-context"
                >
                  <span>{t("reviewRewards.gbpLocationDialog.lastLinkedAccount")}: </span>
                  <span>{data.connectedAccount.label || data.connectedAccount.name}</span>
                  <code className="ml-2 text-[10px] text-muted-foreground">
                    {data.connectedAccount.name}
                  </code>
                </div>
              ) : (
                <p className="text-center text-xs text-muted-foreground">
                  {t("reviewRewards.gbpLocationDialog.noAccountsReturned")}
                </p>
              )}
              <p className="text-center text-xs text-muted-foreground">
                {t("reviewRewards.gbpLocationDialog.noLocationsHint")}
              </p>
              <div className="flex justify-center">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={reconnectGoogle}
                  disabled={reconnecting}
                  data-testid="button-gbp-reconnect"
                >
                  {reconnecting && <Loader2 size={14} className="mr-1.5 animate-spin" />}
                  {t("reviewRewards.gbpLocationDialog.reconnect")}
                </Button>
              </div>
            </div>
          )}
          {!isLoading && !isError && locations.length > 0 && (
            <div className="space-y-2">
              {/* Select all shortcut */}
              <div
                className="flex items-center gap-3 rounded-lg border border-border p-3 cursor-pointer hover:bg-muted/50"
                onClick={toggleSelectAll}
              >
                <span onClick={(e) => e.stopPropagation()}>
                  <Checkbox
                    checked={
                      allSelectableSelected ? true : someSelectableSelected ? "indeterminate" : false
                    }
                    onCheckedChange={toggleSelectAll}
                    data-testid="checkbox-select-all-locations"
                  />
                </span>
                <Label className="cursor-pointer font-medium">
                  {t("reviewRewards.gbpLocationDialog.selectAll")}
                </Label>
              </div>

              {/* Location rows */}
              {locations.map((loc) => (
                <div
                  key={loc.name}
                  className={`flex items-start gap-3 rounded-lg border p-3 ${
                    loc.availableInGoogle === false
                      ? "border-amber-300 bg-amber-50/50"
                      : loc.verified !== false
                      ? "cursor-pointer hover:bg-muted/50"
                      : "opacity-50 cursor-not-allowed bg-muted/30"
                  }`}
                  onClick={() =>
                    (loc.verified !== false || checkedNames.has(loc.name)) &&
                    toggleLocation(loc.name)
                  }
                >
                  <span onClick={(e) => e.stopPropagation()}>
                    <Checkbox
                      checked={checkedNames.has(loc.name)}
                      disabled={loc.verified === false && !checkedNames.has(loc.name)}
                      onCheckedChange={() =>
                        (loc.verified !== false || checkedNames.has(loc.name)) &&
                        toggleLocation(loc.name)
                      }
                      data-testid={`checkbox-location-${loc.name.split("/").pop() ?? loc.name}`}
                    />
                  </span>
                  <Label
                    className={`flex-1 ${loc.verified === false ? "cursor-not-allowed" : "cursor-pointer"}`}
                  >
                    <div className="font-medium">
                      {loc.title
                        ? loc.locality
                          ? `${loc.title} — ${loc.locality}`
                          : loc.title
                        : t("reviewRewards.gbpLocationDialog.untitledLocation")}
                    </div>
                    <div className="text-xs text-muted-foreground">
                      {loc.address || loc.accountLabel || t("reviewRewards.gbpLocationDialog.locationId", {
                        id: loc.name.split("/").pop() ?? loc.name,
                      })}
                    </div>
                    {loc.address && (
                      <div className="mt-0.5 text-[10px] font-mono text-muted-foreground/70">
                        {t("reviewRewards.gbpLocationDialog.locationId", {
                          id: loc.name.split("/").pop() ?? loc.name,
                        })}
                      </div>
                    )}
                    {loc.availableInGoogle === false && (
                      <div
                        className="mt-2 rounded-md bg-amber-100 px-2 py-1.5 text-xs font-normal text-amber-900"
                        data-testid={`location-attention-${loc.name.split("/").pop() ?? loc.name}`}
                      >
                        {t("reviewRewards.gbpLocationDialog.missingFromGoogle")}
                        {loc.lastError && <div className="mt-1">{loc.lastError}</div>}
                      </div>
                    )}
                  </Label>
                  <GbpLocationStatusBadge
                    status={
                      loc.connectionStatus ??
                      loc.status ??
                      (loc.verified === false ? "not_connected" : "available")
                    }
                  />
                </div>
              ))}
            </div>
          )}
        </div>

        <DialogFooter>
          {unavailableSelected && (
            <div className="mr-auto max-w-xs space-y-2">
              <p className="text-xs text-amber-700" role="alert">
                {t("reviewRewards.gbpLocationDialog.resolveBeforeSaving")}
              </p>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={reconnectGoogle}
                disabled={reconnecting}
                data-testid="button-gbp-reconnect"
              >
                {reconnecting && <Loader2 size={14} className="mr-1.5 animate-spin" />}
                {t("reviewRewards.gbpLocationDialog.reconnect")}
              </Button>
            </div>
          )}
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {t("common.cancel")}
          </Button>
          <Button
            onClick={() => saveMutation.mutate()}
            disabled={
              locations.length === 0 ||
              unavailableSelected ||
              saveMutation.isPending ||
              isLoading
            }
            data-testid="button-gbp-location-save"
          >
            {saveMutation.isPending && <Loader2 size={14} className="mr-1.5 animate-spin" />}
            {saveMutation.isPending
              ? t("reviewRewards.gbpLocationDialog.saving")
              : t("reviewRewards.gbpLocationDialog.save")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function GbpCredentialsDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { t } = useTranslation();
  const { toast } = useToast();
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  const [error, setError] = useState<string | null>(null);
  const { data } = useQuery({
    queryKey: ["gbp-credentials"],
    queryFn: () => apiFetch<GbpCredentialStatus>("/api/reviews/google/credentials"),
    enabled: open,
    retry: false,
  });

  useEffect(() => {
    if (open) {
      setClientId("");
      setClientSecret("");
      setError(null);
    }
  }, [open]);

  const saveMutation = useMutation({
    mutationFn: () =>
      apiFetch<{ reauthorizationRequired: boolean }>("/api/reviews/google/credentials", {
        method: "POST",
        body: JSON.stringify({ clientId: clientId.trim(), clientSecret: clientSecret.trim() }),
      }),
    onSuccess: async (result) => {
      await queryClient.invalidateQueries({ queryKey: ["gbp-status"] });
      await queryClient.invalidateQueries({ queryKey: ["gbp-credentials"] });
      onOpenChange(false);
      toast({
        title: result.reauthorizationRequired
          ? t("reviewRewards.credentials.reconnectRequired")
          : t("reviewRewards.credentials.saved"),
      });
    },
    onError: (err: Error) => setError(err.message),
  });
  const clearMutation = useMutation({
    mutationFn: () =>
      apiFetch<{ reauthorizationRequired: boolean }>("/api/reviews/google/credentials", {
        method: "DELETE",
      }),
    onSuccess: async (result) => {
      await queryClient.invalidateQueries({ queryKey: ["gbp-status"] });
      await queryClient.invalidateQueries({ queryKey: ["gbp-credentials"] });
      onOpenChange(false);
      toast({
        title: result.reauthorizationRequired
          ? t("reviewRewards.credentials.reconnectRequired")
          : t("reviewRewards.credentials.cleared"),
      });
    },
    onError: (err: Error) => setError(err.message),
  });

  const busy = saveMutation.isPending || clearMutation.isPending;
  const handleSave = () => {
    if (!clientId.trim() || !clientSecret.trim()) {
      setError(t("reviewRewards.credentials.required"));
      return;
    }
    setError(null);
    saveMutation.mutate();
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md" data-testid="gbp-credentials-dialog">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <KeyRound size={18} className="text-teal-600" />
            {t("reviewRewards.credentials.title")}
          </DialogTitle>
          <DialogDescription>{t("reviewRewards.credentials.description")}</DialogDescription>
        </DialogHeader>

        {data?.clientId && (
          <div className="rounded-md border border-teal-200 bg-teal-50/60 px-3 py-2 text-sm dark:border-teal-800 dark:bg-teal-950/30">
            <span className="font-medium text-teal-800 dark:text-teal-300">
              {t(`reviewRewards.credentials.source.${data.credentialSource}`)}
            </span>
            <span className="ml-2 font-mono text-xs text-muted-foreground">
              {data.clientId}
            </span>
          </div>
        )}
        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="gbp-client-id">{t("reviewRewards.credentials.clientId")}</Label>
            <Input
              id="gbp-client-id"
              value={clientId}
              onChange={(event) => setClientId(event.target.value)}
              placeholder={data?.clientId ?? t("reviewRewards.credentials.clientIdPlaceholder")}
              autoComplete="off"
              data-testid="input-gbp-client-id"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="gbp-client-secret">{t("reviewRewards.credentials.clientSecret")}</Label>
            <Input
              id="gbp-client-secret"
              type="password"
              value={clientSecret}
              onChange={(event) => setClientSecret(event.target.value)}
              placeholder={t("reviewRewards.credentials.clientSecretPlaceholder")}
              autoComplete="new-password"
              data-testid="input-gbp-client-secret"
            />
          </div>
          {(error ?? data?.credentialError) && (
            <p className="text-sm text-destructive">{error ?? data?.credentialError}</p>
          )}
        </div>

        <DialogFooter className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-between sm:gap-0">
          <div>
            {data?.saved && (
              <Button
                variant="ghost"
                size="sm"
                className="text-destructive hover:text-destructive"
                onClick={() => clearMutation.mutate()}
                disabled={busy}
                data-testid="button-gbp-clear-credentials"
              >
                {clearMutation.isPending && <Loader2 size={14} className="mr-1.5 animate-spin" />}
                {t("reviewRewards.credentials.clear")}
              </Button>
            )}
          </div>
          <div className="flex gap-2">
            <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>
              {t("common.cancel")}
            </Button>
            <Button onClick={handleSave} disabled={busy} data-testid="button-gbp-save-credentials">
              {saveMutation.isPending && <Loader2 size={14} className="mr-1.5 animate-spin" />}
              {t("common.save")}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ── Employee dialog ───────────────────────────────────────────────────────────

function EmployeeDialog({
  open,
  onOpenChange,
  profile,
  trackedLocations,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  profile: Profile | null;
  /** Derived from the locations-performance endpoint (empty = single-location workspace). */
  trackedLocations: Array<{ locationId: number; locationTitle: string | null; locationLocality?: string | null; country?: string | null }>;
}) {
  const { t } = useTranslation();
  const { toast } = useToast();
  const [name, setName] = useState(profile?.employeeName ?? "");
  const [role, setRole] = useState(profile?.role ?? "");
  const [amount, setAmount] = useState(profile ? String(profile.rewardAmount) : "5");
  const [active, setActive] = useState(profile?.isActive ?? true);
  const [gbpLocationId, setGbpLocationId] = useState<string>(
    profile?.gbpLocationId ? String(profile.gbpLocationId) : "",
  );
  const [teamMemberId, setTeamMemberId] = useState<number | null>(profile?.teamMemberId ?? null);
  const [workspaceMemberId, setWorkspaceMemberId] = useState<number | null>(
    profile?.workspaceMemberId ?? null,
  );
  const [employeePopoverOpen, setEmployeePopoverOpen] = useState(false);
  const [employeeSearch, setEmployeeSearch] = useState("");
  const [duplicateError, setDuplicateError] = useState<string | null>(null);

  // Use the unified People Directory so employees do not need a separate HR
  // record to receive a QR profile.
  const { data: peopleData } = useQuery({
    queryKey: ["review-rewards-people"],
    queryFn: () =>
      apiFetch<{
        people: Array<{
          id: string;
          first_name: string | null;
          last_name: string | null;
          email: string | null;
          job_title: string | null;
          member_id: number | null;
          team_member_id: number | null;
          source: "member" | "team_member" | "both" | "external";
          access_type: string;
          archived_at: string | null;
        }>;
      }>("/api/people"),
    enabled: !profile,
    staleTime: 60_000,
  });
  const people = (peopleData?.people ?? []).filter(
    (person) =>
      person.source !== "external" &&
      (person.team_member_id !== null ||
        person.access_type === "user" ||
        person.access_type === "owner"),
  );
  const filteredMembers = employeeSearch
    ? people.filter((person) =>
        `${person.first_name ?? ""} ${person.last_name ?? ""} ${person.email ?? ""}`
          .toLowerCase()
          .includes(employeeSearch.toLowerCase()),
      )
    : people;

  // Derive the payout currency from the selected location's country.
  const selectedLocation = trackedLocations.find((l) => l.locationId === Number(gbpLocationId));
  const currency = getLocationCurrency(selectedLocation?.country);

  // Clear the duplicate error whenever the employee or location selection changes.
  useEffect(() => {
    setDuplicateError(null);
  }, [teamMemberId, workspaceMemberId, gbpLocationId]);

  const saveMutation = useMutation({
    mutationFn: () => {
      const body = {
        employeeName: name.trim(),
        role: role.trim() || null,
        rewardAmount: Number(amount),
        rewardCurrency: currency,
        ...(gbpLocationId ? { gbpLocationId: Number(gbpLocationId) } : {}),
        // People Directory references link the QR to the selected employee.
        ...(!profile && teamMemberId ? { teamMemberId } : {}),
        ...(!profile && workspaceMemberId ? { workspaceMemberId } : {}),
        ...(profile ? { isActive: active } : {}),
      };
      return profile
        ? apiFetch(`/api/review-rewards/profiles/${profile.id}`, {
            method: "PATCH",
            body: JSON.stringify(body),
          })
        : apiFetch("/api/review-rewards/profiles", {
            method: "POST",
            body: JSON.stringify(body),
          });
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["review-rewards-profiles"] });
      await queryClient.invalidateQueries({ queryKey: ["review-rewards-employees"] });
      onOpenChange(false);
      toast({ title: profile ? t("reviewRewards.employeeUpdated") : t("reviewRewards.employeeAdded") });
    },
    onError: (err: Error) => {
      const apiErr = err as Error & { status?: number; body?: Record<string, unknown> };
      if (apiErr.status === 409 && apiErr.body?.error === "duplicate") {
        setDuplicateError(
          String(apiErr.body.message ?? t("reviewRewards.form.duplicateEmployeeLocation")),
        );
        return;
      }
      toast({ title: err.message, variant: "destructive" });
    },
  });

  // For create: a People Directory employee must be selected. A location is
  // required whenever enabled tracked locations are available.
  const canSave =
    !!name.trim() &&
    (!!profile || teamMemberId !== null || workspaceMemberId !== null) &&
    (trackedLocations.length === 0 || gbpLocationId !== "") &&
    !saveMutation.isPending &&
    !duplicateError;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent data-testid="employee-dialog">
        <DialogHeader>
          <DialogTitle>
            {profile ? t("reviewRewards.editEmployee") : t("reviewRewards.addEmployeeQr")}
          </DialogTitle>
          <DialogDescription>{t("reviewRewards.employeeDialogDescription")}</DialogDescription>
        </DialogHeader>
        <div className="space-y-4">

          {/* Employee name — combobox in create mode, read-only in edit mode */}
          {!profile ? (
            <div className="space-y-1.5">
              <Label>{t("reviewRewards.form.employeeName")}</Label>
              <Popover open={employeePopoverOpen} onOpenChange={setEmployeePopoverOpen}>
                <PopoverTrigger asChild>
                  <Button
                    variant="outline"
                    role="combobox"
                    aria-expanded={employeePopoverOpen}
                    className="w-full justify-between font-normal"
                    data-testid="combobox-employee"
                  >
                    <span className={name ? undefined : "text-muted-foreground"}>
                      {name || t("reviewRewards.form.selectEmployee")}
                    </span>
                    <ChevronsUpDown size={14} className="ml-2 shrink-0 opacity-50" />
                  </Button>
                </PopoverTrigger>
                <PopoverContent className="w-[--radix-popover-trigger-width] p-0" align="start">
                  <Command shouldFilter={false}>
                    <CommandInput
                      placeholder={t("reviewRewards.form.searchEmployees")}
                      value={employeeSearch}
                      onValueChange={setEmployeeSearch}
                    />
                    <CommandList>
                      <CommandEmpty>{t("common.noResults", "No employees found.")}</CommandEmpty>
                      <CommandGroup>
                        {filteredMembers.map((m) => (
                          <CommandItem
                            key={m.id}
                            value={String(m.id)}
                            onSelect={() => {
                              setTeamMemberId(m.team_member_id);
                              setWorkspaceMemberId(m.member_id);
                              setName(
                                `${m.first_name ?? ""} ${m.last_name ?? ""}`.trim() ||
                                  m.email ||
                                  "",
                              );
                              setRole(m.job_title ?? "");
                              setEmployeePopoverOpen(false);
                              setEmployeeSearch("");
                            }}
                          >
                            <div>
                              <div className="font-medium">
                                  {`${m.first_name ?? ""} ${m.last_name ?? ""}`.trim() || m.email}
                              </div>
                              {m.job_title && (
                                <div className="text-xs text-muted-foreground">{m.job_title}</div>
                              )}
                            </div>
                          </CommandItem>
                        ))}
                      </CommandGroup>
                    </CommandList>
                  </Command>
                </PopoverContent>
              </Popover>
            </div>
          ) : (
            <div className="space-y-1.5">
              <Label>{t("reviewRewards.form.employeeName")}</Label>
              <p className="text-sm" data-testid="employee-name-readonly">
                {profile.employeeName}
              </p>
            </div>
          )}

          {/* Role — auto-filled (read-only) in create mode, read-only in edit mode */}
          <div className="space-y-1.5">
            <Label>
              {!profile
                ? t("reviewRewards.form.roleAutoFilled")
                : t("reviewRewards.form.role")}
            </Label>
            <p
              className="text-sm text-muted-foreground min-h-[20px]"
              data-testid={!profile ? "role-autofill" : "employee-role-readonly"}
            >
              {role || "—"}
            </p>
          </div>

          {/* Reward amount — label driven by location country */}
          <div className="space-y-1.5">
            <Label htmlFor="rr-amount">
              {t("reviewRewards.form.rewardAmount", { currency })}
            </Label>
            <Input
              id="rr-amount"
              type="number"
              min="0"
              step="0.5"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              data-testid="input-reward-amount"
            />
          </div>

          {/* Reassigning a profile updates only its location and payout currency.
              Its stable code, tracking URL, and QR barcode remain unchanged. */}
          {trackedLocations.length > 0 && (
            <div className="space-y-1.5">
              <Label htmlFor="rr-location">
                {t("reviewRewards.form.location")}
                <span className="text-destructive ml-0.5">*</span>
              </Label>
              <Select value={gbpLocationId} onValueChange={setGbpLocationId}>
                <SelectTrigger id="rr-location" data-testid="select-employee-location">
                  <SelectValue placeholder={t("reviewRewards.form.selectLocation")} />
                </SelectTrigger>
                <SelectContent>
                  {trackedLocations.map((loc) => (
                    <SelectItem key={loc.locationId} value={String(loc.locationId)}>
                      {formatLocationLabel(loc)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {profile && (
                <p className="text-xs text-muted-foreground" data-testid="employee-location-barcode-note">
                  {t("reviewRewards.form.locationBarcodeUnchanged")}
                </p>
              )}
            </div>
          )}
          {profile && trackedLocations.length === 0 && profile.gbpLocationId && (
            <div className="space-y-1.5">
              <Label>{t("reviewRewards.form.location")}</Label>
              <p className="text-sm text-muted-foreground" data-testid="employee-location-readonly">
                {(() => {
                  const found = trackedLocations.find((l) => l.locationId === profile.gbpLocationId);
                  return found ? formatLocationLabel(found) : (profile.gbpLocationId ? String(profile.gbpLocationId) : "—");
                })()}
              </p>
            </div>
          )}
          {profile && (
            <div className="flex items-center gap-2">
              <Checkbox
                id="rr-active"
                checked={active}
                onCheckedChange={(v) => setActive(v === true)}
                data-testid="checkbox-employee-active"
              />
              <Label htmlFor="rr-active">{t("reviewRewards.form.active")}</Label>
            </div>
          )}

          {/* Inline duplicate-employee error — shown above the Save button */}
          {duplicateError && (
            <p className="text-sm text-destructive" data-testid="error-duplicate-employee">
              {duplicateError}
            </p>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {t("common.cancel")}
          </Button>
          <Button
            onClick={() => saveMutation.mutate()}
            disabled={!canSave}
            data-testid="button-save-employee"
          >
            {t("common.save")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ── Resolve dialog ────────────────────────────────────────────────────────────

function ResolveDialog({
  review,
  profiles,
  onOpenChange,
}: {
  review: Review | null;
  profiles: Profile[];
  onOpenChange: (open: boolean) => void;
}) {
  const { t } = useTranslation();
  const { toast } = useToast();
  const [profileId, setProfileId] = useState<string>("");
  const [note, setNote] = useState("");

  const resolveMutation = useMutation({
    mutationFn: (action: "assign" | "reject") =>
      apiFetch(`/api/review-rewards/reviews/${review!.id}/resolve`, {
        method: "POST",
        body: JSON.stringify(
          action === "assign"
            ? { action, profileId: Number(profileId), note: note.trim() || null }
            : { action, note: note.trim() || null },
        ),
      }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["review-rewards-reviews"] });
      await queryClient.invalidateQueries({ queryKey: ["review-rewards-rewards"] });
      await queryClient.invalidateQueries({ queryKey: ["review-rewards-overview"] });
      onOpenChange(false);
      toast({ title: t("reviewRewards.reviewResolved") });
    },
    onError: (err: Error) => {
      toast({ title: err.message, variant: "destructive" });
    },
  });

  return (
    <Dialog open={!!review} onOpenChange={onOpenChange}>
      <DialogContent data-testid="resolve-dialog">
        <DialogHeader>
          <DialogTitle>{t("reviewRewards.resolveTitle")}</DialogTitle>
          <DialogDescription>{t("reviewRewards.resolveDescription")}</DialogDescription>
        </DialogHeader>
        {review && (
          <div className="space-y-4">
            <div className="rounded-lg border border-border p-3 text-sm">
              <div className="flex items-center justify-between">
                <span className="font-medium">{review.reviewer_name ?? t("reviewRewards.anonymous")}</span>
                <RatingStars rating={review.rating} />
              </div>
              {review.comment && (
                <p className="mt-1 text-muted-foreground line-clamp-3">{review.comment}</p>
              )}
              <div className="mt-1 text-xs text-muted-foreground">
                {formatDateTime(review.review_created_at)}
              </div>
            </div>
            <div className="space-y-1.5">
              <Label>{t("reviewRewards.form.assignToEmployee")}</Label>
              <Select value={profileId} onValueChange={setProfileId}>
                <SelectTrigger data-testid="select-resolve-employee">
                  <SelectValue placeholder={t("reviewRewards.form.selectEmployee")} />
                </SelectTrigger>
                <SelectContent>
                  {profiles.map((p) => (
                    <SelectItem key={p.id} value={String(p.id)}>
                      {p.employeeName}
                      {p.role ? ` · ${p.role}` : ""}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="rr-note">{t("reviewRewards.form.note")}</Label>
              <Input
                id="rr-note"
                value={note}
                onChange={(e) => setNote(e.target.value)}
                data-testid="input-resolve-note"
              />
            </div>
          </div>
        )}
        <DialogFooter className="gap-2">
          <Button
            variant="outline"
            className="text-red-600"
            onClick={() => resolveMutation.mutate("reject")}
            disabled={resolveMutation.isPending}
            data-testid="button-reject-review"
          >
            {t("reviewRewards.rejectReview")}
          </Button>
          <Button
            onClick={() => resolveMutation.mutate("assign")}
            disabled={!profileId || resolveMutation.isPending}
            data-testid="button-assign-review"
          >
            {t("reviewRewards.assignReward")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ── QR preview ────────────────────────────────────────────────────────────────

function QrPreview({ profileId }: { profileId: number }) {
  const { data, isError, error } = useQuery({
    queryKey: ["review-rewards-qr", profileId],
    queryFn: () =>
      apiFetch<{ trackingUrl: string; qrDataUrl: string }>(
        `/api/review-rewards/profiles/${profileId}/qr`,
      ),
    staleTime: Infinity,
  });
  if (isError) {
    return (
      <div
        role="alert"
        className="w-12 h-12 rounded-md border border-destructive/30 bg-destructive/5 flex items-center justify-center text-destructive"
        title={`QR unavailable: ${errorMessage(error)}`}
        data-testid={`qr-error-${profileId}`}
      >
        <CircleAlert size={18} />
      </div>
    );
  }
  if (!data) {
    return (
      <div className="w-12 h-12 rounded-md border border-border bg-muted flex items-center justify-center">
        <QrCode size={18} className="text-muted-foreground" />
      </div>
    );
  }
  return (
    <img
      src={data.qrDataUrl}
      alt="QR"
      className="w-12 h-12 rounded-md border border-border"
      data-testid={`qr-preview-${profileId}`}
    />
  );
}

function LocationPerformanceRow({
  location,
  onViewLocation,
}: {
  location: GbpLocation;
  onViewLocation: (connectionId: number) => void;
}) {
  const { data: metrics } = useQuery({
    queryKey: ["review-rewards-overview", location.connectionId],
    queryFn: () =>
      apiFetch<OverviewMetrics>(
        `/api/review-rewards/metrics/overview?days=30&locationId=${location.connectionId}`,
      ),
    enabled: location.connectionId != null,
  });

  const rewardsByStatus = metrics?.rewardsByStatus ?? {};
  const earned =
    num(rewardsByStatus.pending?.totalAmount) +
    num(rewardsByStatus.approved?.totalAmount) +
    num(rewardsByStatus.paid?.totalAmount);

  return (
    <tr
      className="border-b last:border-0"
      data-testid={`loc-perf-row-${location.connectionId ?? location.name}`}
    >
      <td className="p-3">
        <div className="font-medium">{location.title}</div>
        {location.address && (
          <div className="text-xs text-muted-foreground">{location.address}</div>
        )}
      </td>
      <td className="p-3">
        <GbpLocationStatusBadge
          status={location.connectionStatus ?? (location.verified ? "available" : "not_connected")}
        />
      </td>
      <td className="p-3 text-right tabular-nums">{metrics?.newReviews ?? "—"}</td>
      <td className="p-3 text-right tabular-nums">{metrics?.scans ?? "—"}</td>
      <td className="p-3 text-right tabular-nums">
        {metrics ? `${(metrics.conversionRate * 100).toFixed(1)}%` : "—"}
      </td>
      <td className="p-3 text-right tabular-nums">{metrics ? formatAmount(earned) : "—"}</td>
      <td className="p-3 text-right">
        {location.connectionId && (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => onViewLocation(location.connectionId!)}
            data-testid={`button-view-location-${location.connectionId}`}
          >
            View
          </Button>
        )}
        {!location.connectionId && location.connectionStatus === "needs_attention" && (
          <Button
            variant="ghost"
            size="sm"
            className="text-destructive hover:text-destructive"
          >
            Fix
          </Button>
        )}
        {!location.connectionId && location.connectionStatus !== "needs_attention" && (
          <Button variant="ghost" size="sm">
            Connect
          </Button>
        )}
      </td>
    </tr>
  );
}

// ── Locations performance table (shared between Overview and Locations tab) ───

function LocationsPerformanceTable({
  locations,
  onViewLocation,
  onManageLocations,
  limit,
}: {
  locations: LocationPerformance[];
  onViewLocation: (id: number) => void;
  onManageLocations?: () => void;
  limit?: number;
}) {
  const { t } = useTranslation();
  const displayed = limit ? locations.slice(0, limit) : locations;

  if (locations.length === 0) {
    return (
      <div className="py-8 text-center text-sm text-muted-foreground">
        {t("reviewRewards.noLocationsTracked")}
      </div>
    );
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b text-xs text-muted-foreground">
            <th className="p-3 text-left font-medium">{t("reviewRewards.table.location")}</th>
            <th className="p-3 text-left font-medium">{t("reviewRewards.table.googleStatus")}</th>
            <th className="p-3 text-right font-medium">{t("reviewRewards.table.reviews")}</th>
            <th className="p-3 text-right font-medium">{t("reviewRewards.table.scans")}</th>
            <th className="p-3 text-right font-medium">{t("reviewRewards.table.conversion")}</th>
            <th className="p-3 text-right font-medium">{t("reviewRewards.table.earned")}</th>
            <th className="p-3 text-center font-medium">{t("reviewRewards.table.trend")}</th>
            <th className="p-3 text-right font-medium">{t("reviewRewards.table.actions")}</th>
          </tr>
        </thead>
        <tbody>
          {displayed.map((loc) => (
            <tr key={loc.locationId} className="border-b last:border-0" data-testid={`location-row-${loc.locationId}`}>
              <td className="p-3">
                <div className="flex items-center gap-2">
                  <MapPin size={13} className="text-muted-foreground shrink-0" />
                  <div>
                    <div className="font-medium">{formatLocationLabel(loc)}</div>
                  </div>
                </div>
              </td>
              <td className="p-3">
                <LocationStatusBadge googleStatus={loc.googleStatus} />
              </td>
              <td className="p-3 text-right tabular-nums">{loc.reviewCount}</td>
              <td className="p-3 text-right tabular-nums">{loc.scanCount}</td>
              <td className="p-3 text-right tabular-nums">{(loc.conversionRate * 100).toFixed(1)}%</td>
              <td className="p-3 text-right tabular-nums">{formatAmount(loc.rewardsEarned)}</td>
              <td className="p-3 text-center">
                <span className="text-muted-foreground">—</span>
              </td>
              <td className="p-3 text-right">
                <div className="flex items-center justify-end gap-1">
                  {!loc.googleStatus && (
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-7 px-2 text-xs"
                      onClick={() => onViewLocation(loc.locationId)}
                      data-testid={`button-view-location-${loc.locationId}`}
                    >
                      {t("reviewRewards.viewLocation")}
                    </Button>
                  )}
                  {loc.googleStatus && onManageLocations && (
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-7 px-2 text-xs text-amber-700"
                      onClick={onManageLocations}
                      data-testid={`button-fix-location-${loc.locationId}`}
                    >
                      {t("reviewRewards.fixLocation")}
                    </Button>
                  )}
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────────

export default function ReviewRewardsPage() {
  const { t } = useTranslation();
  const { toast } = useToast();
  const { isOwner } = useWorkspaceRole();

  const [activeTab, setActiveTab] = useState("overview");
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingProfile, setEditingProfile] = useState<Profile | null>(null);
  const [resolvingReview, setResolvingReview] = useState<Review | null>(null);
  const [payingReward, setPayingReward] = useState<Reward | null>(null);
  const [manageLocationsOpen, setManageLocationsOpen] = useState(false);
  const [credentialsOpen, setCredentialsOpen] = useState(false);
  const [disconnectConfirmOpen, setDisconnectConfirmOpen] = useState(false);
  const [selectedLocationId, setSelectedLocationId] = useState<number | null>(null);

  // Handle OAuth callback URL params
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const connected = params.get("gbp_connected");
    const error = params.get("gbp_error");

    if (connected === "1" || error) {
      const cleanUrl = window.location.pathname + window.location.hash;
      window.history.replaceState(null, "", cleanUrl);
    }

    if (connected === "1") {
      setManageLocationsOpen(true);
    } else if (error) {
      const errorMessages: Record<string, string> = {
        access_denied: t("reviewRewards.gbpError.access_denied"),
        state_missing: t("reviewRewards.gbpError.state_missing"),
        state_mismatch: t("reviewRewards.gbpError.state_mismatch"),
        no_accounts: t("reviewRewards.gbpError.no_accounts"),
        api_disabled: t("reviewRewards.gbpError.api_disabled"),
        quota_exceeded: t("reviewRewards.gbpError.quota_exceeded"),
        token_exchange_failed: t("reviewRewards.gbpError.token_exchange_failed"),
        callback_failed: t("reviewRewards.gbpError.callback_failed"),
      };
      toast({
        title: errorMessages[error] ?? t("reviewRewards.gbpError.callback_failed"),
        variant: "destructive",
      });
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const disconnectMutation = useMutation({
    mutationFn: () =>
      apiFetch("/api/reviews/google/connection", { method: "DELETE" }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["gbp-status"] });
      setDisconnectConfirmOpen(false);
      toast({ title: t("reviewRewards.disconnected") });
    },
    onError: (err: Error) => {
      toast({ title: err.message, variant: "destructive" });
    },
  });

  const locationParam = selectedLocationId ? `&locationId=${selectedLocationId}` : "";

  const {
    data: overview,
    isLoading: overviewLoading,
    isError: overviewIsError,
    error: overviewError,
  } = useQuery({
    queryKey: ["review-rewards-overview", selectedLocationId],
    queryFn: () => apiFetch<OverviewMetrics>(`/api/review-rewards/metrics/overview?days=30${locationParam}`),
  });
  const { data: trend, isError: trendIsError, error: trendError } = useQuery({
    queryKey: ["review-rewards-trend", selectedLocationId],
    queryFn: () => apiFetch<{ series: TrendPoint[] }>(`/api/review-rewards/metrics/trend?days=30${locationParam}`),
  });
  const { data: employeeMetrics, isError: employeeIsError, error: employeeError } = useQuery({
    queryKey: ["review-rewards-employees", selectedLocationId],
    queryFn: () =>
      apiFetch<{ employees: EmployeeMetric[] }>(`/api/review-rewards/metrics/employees?days=30${locationParam}`),
  });
  const { data: latestMatches, isError: latestMatchesIsError, error: latestMatchesError } = useQuery({
    queryKey: ["review-rewards-latest-matches", selectedLocationId],
    queryFn: () =>
      apiFetch<{ matches: LatestMatch[] }>(
        `/api/review-rewards/metrics/latest-matches${selectedLocationId ? `?locationId=${selectedLocationId}` : ""}`,
      ),
  });
  const { data: profilesData, isError: profilesIsError, error: profilesError } = useQuery({
    queryKey: ["review-rewards-profiles", selectedLocationId],
    queryFn: () => apiFetch<{ profiles: Profile[] }>(`/api/review-rewards/profiles${selectedLocationId ? `?locationId=${selectedLocationId}` : ""}`),
  });
  const { data: reviewsData, isError: reviewsIsError, error: reviewsError } = useQuery({
    queryKey: ["review-rewards-reviews", selectedLocationId],
    queryFn: () => apiFetch<{ reviews: Review[] }>(`/api/review-rewards/reviews${selectedLocationId ? `?locationId=${selectedLocationId}` : ""}`),
    enabled: activeTab === "activity",
  });
  const { data: rewardsData, isError: rewardsIsError, error: rewardsError } = useQuery({
    queryKey: ["review-rewards-rewards", selectedLocationId],
    queryFn: () => apiFetch<{ rewards: Reward[] }>(`/api/review-rewards/rewards${selectedLocationId ? `?locationId=${selectedLocationId}` : ""}`),
    enabled: activeTab === "payouts",
  });

  // Locations performance — always fetch when connected; used for the filter dropdown,
  // EmployeeDialog location list, Locations tab, and Overview performance card.
  // There is no separate /api/review-rewards/locations endpoint; we derive tracked
  // locations from the performance data.
  const {
    data: locationsPerformanceData,
    isLoading: locationsLoading,
    isError: locationsIsError,
    error: locationsError,
  } = useQuery({
    queryKey: ["review-rewards-locations-performance"],
    queryFn: () =>
      apiFetch<{ locations: LocationPerformance[] }>("/api/review-rewards/locations/performance"),
    // Always enabled — cheap endpoint, used for filter dropdown + EmployeeDialog + tabs.
  });

  const profiles = profilesData?.profiles ?? [];
  const locationsPerformance = locationsPerformanceData?.locations ?? [];
  // Derive the tracked-location list from the performance endpoint.
  const trackedLocations = locationsPerformance;
  const pageLoadError = [
    overviewIsError ? overviewError : null,
    trendIsError ? trendError : null,
    employeeIsError ? employeeError : null,
    latestMatchesIsError ? latestMatchesError : null,
    profilesIsError ? profilesError : null,
    reviewsIsError ? reviewsError : null,
    rewardsIsError ? rewardsError : null,
    locationsIsError ? locationsError : null,
  ].find((value) => value !== null);

  const pauseMutation = useMutation({
    mutationFn: ({ id, pause }: { id: number; pause: boolean }) =>
      apiFetch(`/api/review-rewards/profiles/${id}/${pause ? "pause" : "reactivate"}`, {
        method: "POST",
      }),
    onSuccess: async (_data, vars) => {
      await queryClient.invalidateQueries({ queryKey: ["review-rewards-profiles"] });
      toast({
        title: vars.pause ? t("reviewRewards.employeePaused") : t("reviewRewards.employeeReactivated"),
      });
    },
    onError: (err: Error) => toast({ title: err.message, variant: "destructive" }),
  });

  const payMutation = useMutation({
    mutationFn: (id: number) =>
      apiFetch(`/api/review-rewards/rewards/${id}/pay`, { method: "POST" }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["review-rewards-rewards"] });
      await queryClient.invalidateQueries({ queryKey: ["review-rewards-overview"] });
      setPayingReward(null);
      toast({ title: t("reviewRewards.rewardPaid") });
    },
    onError: (err: Error) => toast({ title: err.message, variant: "destructive" }),
  });

  const downloadQr = async (profile: Profile) => {
    try {
      const data = await apiFetch<{ qrDataUrl: string }>(
        `/api/review-rewards/profiles/${profile.id}/qr`,
      );
      const a = document.createElement("a");
      a.href = data.qrDataUrl;
      a.download = `qr-${profile.code}.png`;
      a.click();
    } catch (err) {
      toast({ title: (err as Error).message, variant: "destructive" });
    }
  };

  const copyLink = async (profile: Profile) => {
    try {
      await navigator.clipboard.writeText(profile.trackingUrl);
      toast({ title: t("reviewRewards.linkCopied") });
    } catch {
      toast({ title: t("reviewRewards.copyFailed"), variant: "destructive" });
    }
  };

  const rewardsByStatus = overview?.rewardsByStatus ?? {};
  const earnedTotal =
    num(rewardsByStatus.pending?.totalAmount) +
    num(rewardsByStatus.approved?.totalAmount) +
    num(rewardsByStatus.paid?.totalAmount);

  const trendConfig = {
    scans: { label: t("reviewRewards.chart.scans"), color: "hsl(190, 90%, 35%)" },
    matchedReviews: { label: t("reviewRewards.chart.matchedReviews"), color: "hsl(160, 84%, 39%)" },
  } satisfies ChartConfig;

  const monthStart = new Date();
  monthStart.setDate(1);
  monthStart.setHours(0, 0, 0, 0);
  const rewards = rewardsData?.rewards ?? [];
  const monthlyTotal = rewards
    .filter((r) => r.status !== "voided" && new Date(r.created_at) >= monthStart)
    .reduce((sum, r) => sum + num(r.amount), 0);

  return (
    <div className="space-y-6 p-4 sm:p-6">
      {/* Header */}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex flex-wrap items-center gap-3">
            <h1 className="text-2xl font-semibold tracking-tight" data-testid="page-title">
              {t("reviewRewards.title")}
            </h1>
            <GoogleStatusPill
              isOwner={isOwner}
              onOpenManageLocations={() => setManageLocationsOpen(true)}
              onRequestDisconnect={() => setDisconnectConfirmOpen(true)}
            />
            {isOwner && (
              <Button
                variant="ghost"
                size="sm"
                className="h-7 gap-1.5 px-2 text-xs text-muted-foreground hover:text-foreground"
                onClick={() => setCredentialsOpen(true)}
                data-testid="button-gbp-manage-credentials"
              >
                <KeyRound size={13} />
                {t("reviewRewards.credentials.manage")}
              </Button>
            )}
          </div>
          <p className="text-sm text-muted-foreground mt-1">{t("reviewRewards.subtitle")}</p>
        </div>
        {isOwner && (
          <Button
            onClick={() => {
              setEditingProfile(null);
              setDialogOpen(true);
            }}
            className="gap-2"
            // Disable while location data is still loading so we don't open
            // the create dialog with an empty trackedLocations list and allow
            // an unscoped profile to be created in a multi-location workspace.
            disabled={locationsLoading}
            data-testid="button-add-employee-qr"
          >
            {locationsLoading ? <Loader2 size={16} className="animate-spin" /> : <Plus size={16} />}
            {t("reviewRewards.addEmployeeQr")}
          </Button>
        )}
      </div>

      {/* Location filter dropdown */}
      {trackedLocations.length > 0 && (
        <div className="flex items-center gap-2">
          <Select
            value={selectedLocationId ? String(selectedLocationId) : "all"}
            onValueChange={(v) => setSelectedLocationId(v === "all" ? null : Number(v))}
          >
            <SelectTrigger className="w-[220px]" data-testid="select-location-filter">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">{t("reviewRewards.allLocations")}</SelectItem>
              {trackedLocations.map((loc) => (
                <SelectItem key={loc.locationId} value={String(loc.locationId)}>
                  {formatLocationLabel(loc)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      )}

      <AttributionNote />

      {pageLoadError && <QueryErrorAlert error={pageLoadError} />}

      <Tabs value={activeTab} onValueChange={setActiveTab}>
        <TabsList className="flex w-full flex-wrap h-auto sm:w-auto">
          <TabsTrigger value="overview" data-testid="tab-overview">
            {t("reviewRewards.tabs.overview")}
          </TabsTrigger>
          <TabsTrigger value="locations" data-testid="tab-locations">
            {t("reviewRewards.tabs.locations")}
          </TabsTrigger>
          <TabsTrigger value="employees" data-testid="tab-employees">
            {t("reviewRewards.tabs.employees")}
          </TabsTrigger>
          <TabsTrigger value="activity" data-testid="tab-activity">
            {t("reviewRewards.tabs.activity")}
          </TabsTrigger>
          <TabsTrigger value="payouts" data-testid="tab-payouts">
            {t("reviewRewards.tabs.payouts")}
          </TabsTrigger>
        </TabsList>

        {/* ── Overview ── */}
        <TabsContent value="overview" className="space-y-6 mt-4">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {overviewLoading && !overview ? (
              Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-[104px]" />)
            ) : (
              <>
                <StatCard
                  icon={MessageSquare}
                  label={t("reviewRewards.stats.newReviews")}
                  value={String(overview?.newReviews ?? 0)}
                  hint={t("reviewRewards.stats.last30Days")}
                  testId="stat-new-reviews"
                />
                <StatCard
                  icon={ScanLine}
                  label={t("reviewRewards.stats.qrScans")}
                  value={String(overview?.scans ?? 0)}
                  hint={
                    overview && overview.flaggedScans > 0
                      ? t("reviewRewards.stats.flaggedScans", { count: overview.flaggedScans })
                      : t("reviewRewards.stats.last30Days")
                  }
                  testId="stat-qr-scans"
                />
                <StatCard
                  icon={TrendingUp}
                  label={t("reviewRewards.stats.conversion")}
                  value={`${(overview?.conversionRate ?? 0).toFixed(1)}%`}
                  hint={t("reviewRewards.stats.conversionHint")}
                  testId="stat-conversion"
                />
                <StatCard
                  icon={DollarSign}
                  label={t("reviewRewards.stats.rewardsEarned")}
                  value={formatAmount(earnedTotal)}
                  hint={t("reviewRewards.stats.last30Days")}
                  testId="stat-rewards-earned"
                />
              </>
            )}
          </div>

          <Card>
            <CardHeader>
              <CardTitle className="text-base">{t("reviewRewards.chart.title")}</CardTitle>
            </CardHeader>
            <CardContent>
              {trend && trend.series.length > 0 ? (
                <ChartContainer config={trendConfig} className="h-[260px] w-full">
                  <LineChart data={trend.series} margin={{ left: 8, right: 8 }}>
                    <CartesianGrid vertical={false} strokeDasharray="3 3" />
                    <XAxis
                      dataKey="day"
                      tickLine={false}
                      axisLine={false}
                      fontSize={11}
                      tickFormatter={(v: string) => formatDate(v)}
                    />
                    <YAxis tickLine={false} axisLine={false} fontSize={11} width={32} allowDecimals={false} />
                    <ChartTooltip content={<ChartTooltipContent />} />
                    <ChartLegend content={<ChartLegendContent />} />
                    <Line type="monotone" dataKey="scans" stroke="var(--color-scans)" strokeWidth={2} dot={false} />
                    <Line
                      type="monotone"
                      dataKey="matchedReviews"
                      stroke="var(--color-matchedReviews)"
                      strokeWidth={2}
                      dot={false}
                    />
                  </LineChart>
                </ChartContainer>
              ) : (
                <div className="flex h-[200px] items-center justify-center text-sm text-muted-foreground">
                  {t("reviewRewards.noData")}
                </div>
              )}
            </CardContent>
          </Card>

          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            {/* Latest matched reviews */}
            <Card>
              <CardHeader>
                <CardTitle className="text-base">{t("reviewRewards.latestMatches")}</CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                {(latestMatches?.matches ?? []).length === 0 ? (
                  <div className="py-6 text-center text-sm text-muted-foreground">
                    {t("reviewRewards.noMatchesYet")}
                  </div>
                ) : (
                  latestMatches!.matches.map((m) => (
                    <div
                      key={m.id}
                      className="flex items-start justify-between gap-3 rounded-lg border border-border p-3"
                      data-testid={`latest-match-${m.id}`}
                    >
                      <div className="min-w-0">
                        <div className="flex items-center gap-2">
                          <span className="text-sm font-medium truncate">
                            {m.reviewer_name ?? t("reviewRewards.anonymous")}
                          </span>
                          <RatingStars rating={m.rating} />
                        </div>
                        {m.comment && (
                          <p className="mt-0.5 text-xs text-muted-foreground line-clamp-2">{m.comment}</p>
                        )}
                        <div className="mt-1 text-xs text-muted-foreground">
                          {m.employee_name
                            ? t("reviewRewards.matchedTo", { name: m.employee_name })
                            : ""}
                          {" · "}
                          {formatDateTime(m.review_created_at)}
                        </div>
                      </div>
                      <MatchStatusChip status={m.match_status} />
                    </div>
                  ))
                )}
              </CardContent>
            </Card>

            {/* Employee performance */}
            <Card>
              <CardHeader>
                <CardTitle className="text-base">{t("reviewRewards.employeePerformance")}</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b text-xs text-muted-foreground">
                        <th className="py-2 pr-3 text-left font-medium">{t("reviewRewards.table.employee")}</th>
                        <th className="py-2 pr-3 text-right font-medium">{t("reviewRewards.table.scans")}</th>
                        <th className="py-2 pr-3 text-right font-medium">{t("reviewRewards.table.matched")}</th>
                        <th className="py-2 pr-3 text-right font-medium">{t("reviewRewards.table.conversion")}</th>
                        <th className="py-2 text-right font-medium">{t("reviewRewards.table.earned")}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {(employeeMetrics?.employees ?? []).length === 0 ? (
                        <tr>
                          <td colSpan={5} className="py-6 text-center text-muted-foreground">
                            {t("reviewRewards.noEmployeesYet")}
                          </td>
                        </tr>
                      ) : (
                        employeeMetrics!.employees.map((e) => {
                          const conv = e.scans > 0 ? (e.matched_reviews / e.scans) * 100 : 0;
                          const earned =
                            num(e.pending_amount) + num(e.approved_amount) + num(e.paid_amount);
                          return (
                            <tr key={e.id} className="border-b last:border-0" data-testid={`perf-row-${e.id}`}>
                              <td className="py-2 pr-3">
                                <span className="font-medium">{e.employee_name}</span>
                                {e.role && (
                                  <span className="ml-1 text-xs text-muted-foreground">{e.role}</span>
                                )}
                              </td>
                              <td className="py-2 pr-3 text-right tabular-nums">{e.scans}</td>
                              <td className="py-2 pr-3 text-right tabular-nums">{e.matched_reviews}</td>
                              <td className="py-2 pr-3 text-right tabular-nums">{conv.toFixed(1)}%</td>
                              <td className="py-2 text-right tabular-nums">{formatAmount(earned)}</td>
                            </tr>
                          );
                        })
                      )}
                    </tbody>
                  </table>
                </div>
              </CardContent>
            </Card>
          </div>

          {/* Locations performance table — only when 2+ locations tracked */}
          {locationsPerformance.length >= 2 && (
            <Card>
              <CardHeader className="flex flex-row items-center justify-between pb-2">
                <CardTitle className="text-base">{t("reviewRewards.locationsPerformance")}</CardTitle>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-7 px-2 text-xs"
                  onClick={() => setActiveTab("locations")}
                  data-testid="button-see-all-locations"
                >
                  {t("reviewRewards.seeAllLocations")}
                </Button>
              </CardHeader>
              <CardContent className="p-0">
                <LocationsPerformanceTable
                  locations={locationsPerformance}
                  onViewLocation={(id) => setSelectedLocationId(id)}
                  onManageLocations={isOwner ? () => setManageLocationsOpen(true) : undefined}
                  limit={5}
                />
              </CardContent>
            </Card>
          )}
        </TabsContent>

        {/* ── Locations ── */}
        <TabsContent value="locations" className="mt-4">
          <Card>
            <CardHeader className="flex flex-row items-center justify-between">
              <CardTitle className="text-base">{t("reviewRewards.locationsTab")}</CardTitle>
              {isOwner && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setManageLocationsOpen(true)}
                  data-testid="button-manage-locations-tab"
                >
                  {t("reviewRewards.manageLocations")}
                </Button>
              )}
            </CardHeader>
            <CardContent className="p-0">
              <LocationsPerformanceTable
                locations={locationsPerformance}
                onViewLocation={(id) => {
                  setSelectedLocationId(id);
                  setActiveTab("overview");
                }}
                onManageLocations={isOwner ? () => setManageLocationsOpen(true) : undefined}
              />
            </CardContent>
          </Card>
        </TabsContent>

        {/* ── Employee QR codes ── */}
        <TabsContent value="employees" className="mt-4">
          <Card>
            <CardContent className="p-0">
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b text-xs text-muted-foreground">
                      <th className="p-3 text-left font-medium">{t("reviewRewards.table.employee")}</th>
                      <th className="p-3 text-left font-medium">{t("reviewRewards.table.code")}</th>
                      <th className="p-3 text-left font-medium">{t("reviewRewards.table.qr")}</th>
                      <th className="p-3 text-left font-medium">{t("reviewRewards.table.status")}</th>
                      {trackedLocations.length > 1 && (
                        <th className="p-3 text-left font-medium">{t("reviewRewards.table.location")}</th>
                      )}
                      <th className="p-3 text-right font-medium">{t("reviewRewards.table.reward")}</th>
                      <th className="p-3 text-right font-medium">{t("reviewRewards.table.actions")}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {profiles.length === 0 ? (
                      <tr>
                        <td colSpan={7} className="p-8 text-center text-muted-foreground">
                          {t("reviewRewards.noEmployeesYet")}
                        </td>
                      </tr>
                    ) : (
                      profiles.map((p) => (
                        <tr key={p.id} className="border-b last:border-0" data-testid={`employee-row-${p.id}`}>
                          <td className="p-3">
                            <span className="font-medium">{p.employeeName}</span>
                            {p.role && <div className="text-xs text-muted-foreground">{p.role}</div>}
                          </td>
                          <td className="p-3 font-mono text-xs">{p.code}</td>
                          <td className="p-3">
                            <QrPreview profileId={p.id} />
                          </td>
                          <td className="p-3">
                            {p.isActive ? (
                              <Badge variant="outline" className="bg-green-50 text-green-700 border-green-200">
                                {t("reviewRewards.active")}
                              </Badge>
                            ) : (
                              <Badge variant="outline" className="bg-amber-50 text-amber-700 border-amber-200">
                                {t("reviewRewards.paused")}
                              </Badge>
                            )}
                          </td>
                          {trackedLocations.length > 1 && (
                            <td className="p-3 text-xs text-muted-foreground">
                              {(() => {
                                const found = trackedLocations.find((l) => l.locationId === p.gbpLocationId);
                                return found ? formatLocationLabel(found) : "—";
                              })()}
                            </td>
                          )}
                          <td className="p-3 text-right tabular-nums">{formatAmount(p.rewardAmount)}</td>
                          <td className="p-3">
                            <div className="flex items-center justify-end gap-1">
                              <Button
                                variant="ghost"
                                size="icon"
                                title={t("reviewRewards.downloadQr")}
                                onClick={() => downloadQr(p)}
                                data-testid={`button-download-qr-${p.id}`}
                              >
                                <Download size={15} />
                              </Button>
                              <Button
                                variant="ghost"
                                size="icon"
                                title={t("reviewRewards.copyLink")}
                                onClick={() => copyLink(p)}
                                data-testid={`button-copy-link-${p.id}`}
                              >
                                <Link2 size={15} />
                              </Button>
                              {isOwner && (
                                <>
                                  <Button
                                    variant="ghost"
                                    size="icon"
                                    title={t("common.edit")}
                                    onClick={() => {
                                      setEditingProfile(p);
                                      setDialogOpen(true);
                                    }}
                                    data-testid={`button-edit-employee-${p.id}`}
                                  >
                                    <Pencil size={15} />
                                  </Button>
                                  <Button
                                    variant="ghost"
                                    size="icon"
                                    title={p.isActive ? t("reviewRewards.pause") : t("reviewRewards.reactivate")}
                                    onClick={() => pauseMutation.mutate({ id: p.id, pause: p.isActive })}
                                    data-testid={`button-toggle-employee-${p.id}`}
                                  >
                                    {p.isActive ? <PauseCircle size={15} /> : <PlayCircle size={15} />}
                                  </Button>
                                </>
                              )}
                            </div>
                          </td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        {/* ── Review activity ── */}
        <TabsContent value="activity" className="space-y-4 mt-4">
          <Card>
            <CardContent className="p-0">
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b text-xs text-muted-foreground">
                      <th className="p-3 text-left font-medium">{t("reviewRewards.table.reviewer")}</th>
                      <th className="p-3 text-left font-medium">{t("reviewRewards.table.rating")}</th>
                      <th className="p-3 text-left font-medium">{t("reviewRewards.table.comment")}</th>
                      <th className="p-3 text-left font-medium">{t("reviewRewards.table.time")}</th>
                      <th className="p-3 text-left font-medium">{t("reviewRewards.table.matchedEmployee")}</th>
                      <th className="p-3 text-left font-medium">{t("reviewRewards.table.matchStatus")}</th>
                      {isOwner && <th className="p-3 text-right font-medium">{t("reviewRewards.table.actions")}</th>}
                    </tr>
                  </thead>
                  <tbody>
                    {(reviewsData?.reviews ?? []).length === 0 ? (
                      <tr>
                        <td colSpan={isOwner ? 7 : 6} className="p-8 text-center text-muted-foreground">
                          {t("reviewRewards.noReviewsYet")}
                        </td>
                      </tr>
                    ) : (
                      reviewsData!.reviews.map((r) => (
                        <tr key={r.id} className="border-b last:border-0" data-testid={`review-row-${r.id}`}>
                          <td className="p-3 font-medium">
                            {r.reviewer_name ?? t("reviewRewards.anonymous")}
                          </td>
                          <td className="p-3">
                            <RatingStars rating={r.rating} />
                          </td>
                          <td className="p-3 max-w-[240px]">
                            <span className="line-clamp-2 text-muted-foreground">{r.comment ?? "—"}</span>
                          </td>
                          <td className="p-3 whitespace-nowrap text-muted-foreground">
                            {formatDateTime(r.review_created_at)}
                          </td>
                          <td className="p-3">{r.matched_employee_name ?? "—"}</td>
                          <td className="p-3">
                            <MatchStatusChip status={r.match_status} />
                          </td>
                          {isOwner && (
                            <td className="p-3 text-right">
                              {["needs_review", "unmatched", "pending"].includes(r.match_status) && (
                                <Button
                                  variant="outline"
                                  size="sm"
                                  onClick={() => setResolvingReview(r)}
                                  data-testid={`button-resolve-${r.id}`}
                                >
                                  {t("reviewRewards.resolve")}
                                </Button>
                              )}
                            </td>
                          )}
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        {/* ── Reward payouts ── */}
        <TabsContent value="payouts" className="space-y-4 mt-4">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
            <StatCard
              icon={Clock}
              label={t("reviewRewards.stats.pendingVerification")}
              value={formatAmount(rewardsByStatus.pending?.totalAmount ?? 0)}
              hint={t("reviewRewards.stats.verificationHint")}
              testId="stat-pending-amount"
            />
            <StatCard
              icon={CheckCircle2}
              label={t("reviewRewards.stats.approved")}
              value={formatAmount(rewardsByStatus.approved?.totalAmount ?? 0)}
              testId="stat-approved-amount"
            />
            <StatCard
              icon={DollarSign}
              label={t("reviewRewards.stats.monthlyTotal")}
              value={formatAmount(monthlyTotal)}
              hint={t("reviewRewards.stats.monthlyTotalHint")}
              testId="stat-monthly-total"
            />
          </div>

          <Card>
            <CardContent className="p-0">
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b text-xs text-muted-foreground">
                      <th className="p-3 text-left font-medium">{t("reviewRewards.table.employee")}</th>
                      <th className="p-3 text-left font-medium">{t("reviewRewards.table.review")}</th>
                      <th className="p-3 text-right font-medium">{t("reviewRewards.table.amount")}</th>
                      <th className="p-3 text-left font-medium">{t("reviewRewards.table.verificationDate")}</th>
                      <th className="p-3 text-left font-medium">{t("reviewRewards.table.status")}</th>
                      {isOwner && <th className="p-3 text-right font-medium">{t("reviewRewards.table.actions")}</th>}
                    </tr>
                  </thead>
                  <tbody>
                    {rewards.length === 0 ? (
                      <tr>
                        <td colSpan={isOwner ? 6 : 5} className="p-8 text-center text-muted-foreground">
                          {t("reviewRewards.noRewardsYet")}
                        </td>
                      </tr>
                    ) : (
                      rewards.map((r) => (
                        <tr key={r.id} className="border-b last:border-0" data-testid={`reward-row-${r.id}`}>
                          <td className="p-3 font-medium">{r.employee_name}</td>
                          <td className="p-3">
                            <div className="flex items-center gap-2">
                              <span className="text-muted-foreground">
                                {r.reviewer_name ?? t("reviewRewards.anonymous")}
                              </span>
                              <RatingStars rating={r.rating} />
                            </div>
                          </td>
                          <td className="p-3 text-right tabular-nums">{formatAmount(r.amount)}</td>
                          <td className="p-3 whitespace-nowrap text-muted-foreground">
                            {formatDate(r.pending_until)}
                          </td>
                          <td className="p-3">
                            <RewardStatusChip status={r.status} />
                          </td>
                          {isOwner && (
                            <td className="p-3 text-right">
                              {r.status === "approved" && (
                                <Button
                                  size="sm"
                                  onClick={() => setPayingReward(r)}
                                  data-testid={`button-pay-${r.id}`}
                                >
                                  {t("reviewRewards.markPaid")}
                                </Button>
                              )}
                            </td>
                          )}
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>

      {/* Dialogs */}
      <GbpManageLocationsDialog
        open={manageLocationsOpen}
        onOpenChange={setManageLocationsOpen}
      />
      <GbpCredentialsDialog
        open={credentialsOpen}
        onOpenChange={setCredentialsOpen}
      />

      <AlertDialog open={disconnectConfirmOpen} onOpenChange={setDisconnectConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("reviewRewards.disconnectTitle")}</AlertDialogTitle>
            <AlertDialogDescription>{t("reviewRewards.disconnectDescription")}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={disconnectMutation.isPending}>
              {t("common.cancel")}
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={() => disconnectMutation.mutate()}
              disabled={disconnectMutation.isPending}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              data-testid="button-gbp-disconnect-confirm"
            >
              {disconnectMutation.isPending && <Loader2 size={14} className="mr-1.5 animate-spin" />}
              {t("reviewRewards.disconnectConfirm")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {dialogOpen && (
        <EmployeeDialog
          key={editingProfile?.id ?? "new"}
          open={dialogOpen}
          onOpenChange={setDialogOpen}
          profile={editingProfile}
          trackedLocations={trackedLocations}
        />
      )}
      <ResolveDialog
        review={resolvingReview}
        profiles={profiles.filter((p) => p.isActive)}
        onOpenChange={(open) => {
          if (!open) setResolvingReview(null);
        }}
      />

      {/* Pay confirmation */}
      <Dialog open={!!payingReward} onOpenChange={(open) => !open && setPayingReward(null)}>
        <DialogContent data-testid="pay-dialog">
          <DialogHeader>
            <DialogTitle>{t("reviewRewards.confirmPayTitle")}</DialogTitle>
            <DialogDescription>
              {payingReward &&
                t("reviewRewards.confirmPayDescription", {
                  amount: formatAmount(payingReward.amount),
                  name: payingReward.employee_name,
                })}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setPayingReward(null)}>
              {t("common.cancel")}
            </Button>
            <Button
              onClick={() => payingReward && payMutation.mutate(payingReward.id)}
              disabled={payMutation.isPending}
              data-testid="button-confirm-pay"
            >
              {t("reviewRewards.markPaid")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

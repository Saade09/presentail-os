import { useState, useCallback, useEffect, useRef } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { useLocation, useSearchParams } from "wouter";
import {
  MapPin,
  Search,
  Plus,
  Upload,
  MoreHorizontal,
  CheckCircle2,
  AlertCircle,
  Clock,
  Eye,
  Pencil,
  Tag,
  Users,
  GitMerge,
  Archive,
  MapPinned,
  Building2,
  RefreshCw,
  ShoppingBag,
} from "lucide-react";
import { apiFetch, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { useWorkspaceRole } from "@/hooks/use-workspace-role";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Spinner } from "@/components/ui/spinner";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { formatDistanceToNow } from "date-fns";
import {
  formatPlaceType,
  PLACE_TYPE_OPTIONS,
} from "@workspace/api-zod/place-types";
import { AddLocationDialog } from "./AddLocationDialog";

// ─── Types ─────────────────────────────────────────────────────────────────────

type VerificationState =
  | "unverified"
  | "estimated"
  | "ai_verified"
  | "staff_verified"
  | "delivery_verified";

type TabKey = "all" | "needs_review" | "possible_duplicates" | "recently_delivered";

interface Place {
  id: string;
  canonical_name: string;
  place_type: string;
  area: string | null;
  city_id: number | null;
  city_name: string | null;
  canonical_address: string | null;
  verification_state: VerificationState;
  ai_invalid: boolean;
  alias_count: number;
  contact_count: number;
  delivery_count: number;
  checkout_ready: boolean;
  location_conflict: boolean;
  last_delivered_at: string | null;
  verified_at: string | null;
  updated_at: string | null;
}

interface PlacesResponse {
  success: boolean;
  places: Place[];
  total: number;
  selected: number;
  outstanding: number;
  terminal: number;
  snapshot_place_count: number;
  snapshot_eligible_count: number;
  excluded: number;
  reused?: boolean;
  summary: {
    verified_count: number;
    checkout_ready_count: number;
    checkout_eligible_count: number;
    ai_reverification_count: number;
    needs_review_count: number;
    linked_deliveries_count: number;
    possible_duplicates_count: number;
    missing_coordinates_count: number;
  };
}

interface AreasResponse {
  success: boolean;
  areas: string[];
}

type AccuracyAuditResult = {
  place_id: string;
  canonical_name: string;
  classification: string;
  requires_owner_review: boolean;
  current_pin: { latitude: number; longitude: number } | null;
  selected_candidate: {
    latitude: number;
    longitude: number;
    matched_location: string;
    precision: string;
    provider: string;
    query: string;
  } | null;
  distance_km: number | null;
  reason: string | null;
  candidate_evidence: Array<Record<string, unknown>>;
};

interface AccuracyAuditReport {
  dry_run: true;
  generated_at: string;
  metrics: {
    existing_ai_verified_reviewed: number;
    still_supported: number;
    materially_different_coordinate: number;
    locality_contradiction: number;
    ambiguous: number;
    insufficient_precision: number;
    provider_failure: number;
    protected_coordinate: number;
    requires_owner_review: number;
  };
  results: AccuracyAuditResult[];
}

interface ReverificationRun {
  id: string;
  status: "PENDING" | "RUNNING" | "PAUSED_PROVIDER_OUTAGE" | "COMPLETED";
  paused_reason: string | null;
  paused_until: string | null;
  outage_provider: string | null;
  outage_failure_type: string | null;
  queued: number;
  running: number;
  succeeded: number;
  verified: number;
  repaired: number;
  cleared: number;
  invalid: number;
  unresolved: number;
  failed: number;
  provider_failures: number;
  application_failures?: number;
  failure_reason: string | null;
  protected: number;
  skipped: number;
  exact: number;
  landmark: number;
  street: number;
  locality: number;
  total: number;
  selected: number;
  outstanding: number;
  terminal: number;
  snapshot_place_count: number;
  snapshot_eligible_count: number;
  excluded: number;
  reused?: boolean;
  created_at?: string;
  provider_health?: Partial<Record<"google_places" | "nominatim", {
    status: string;
    httpStatus: number | null;
    errorCategory: string | null;
    providerMessage: string | null;
    lastChecked: string;
  }>>;
}

interface ProviderDiagnostic {
  provider: "google_places" | "nominatim";
  endpoint: string;
  credentialSource: string;
  credentialFingerprint: string | null;
  configured: boolean;
  reachable: boolean;
  httpStatus: number | null;
  errorCategory: string | null;
  providerMessage: string | null;
  providerResponseBody: string | null;
  minimalTextSearch?: {
    attempted: boolean;
    method: "POST";
    endpoint: string;
    authHeader: "X-Goog-Api-Key";
    fieldMask: string;
    textQuery: string;
    httpStatus: number | null;
    errorCategory: string | null;
    providerMessage: string | null;
    providerResponseBody: string | null;
  };
  lastChecked: string;
}

interface BulkCheckoutActivationResponse {
  success: boolean;
  activated: number;
  already_active: number;
  skipped: number;
  blockers: {
    verification_state: number;
    location_conflict: number;
    coordinates: number;
  };
}

// ─── Constants ──────────────────────────────────────────────────────────────────

const VERIFICATION_LABELS: Record<VerificationState, string> = {
  unverified: "Unverified",
  estimated: "Legacy estimate",
  ai_verified: "AI verified",
  staff_verified: "Staff verified",
  delivery_verified: "Delivery verified",
};

const TABS: { key: TabKey; label: string }[] = [
  { key: "all", label: "All places" },
  { key: "needs_review", label: "Needs review" },
  { key: "possible_duplicates", label: "Possible duplicates" },
  { key: "recently_delivered", label: "Recently delivered" },
];

const VERIFICATION_STATES: VerificationState[] = [
  "unverified",
  "ai_verified",
  "staff_verified",
  "delivery_verified",
];

const ADDRESS_BOOK_PAGE_SIZE = 50;

// ─── Helpers ────────────────────────────────────────────────────────────────────

function parseAddressBookPage(value: string | null): number {
  if (!value || !/^[1-9]\d*$/.test(value)) return 1;
  const page = Number(value);
  return Number.isSafeInteger(page) ? page : 1;
}

function verificationBadge(state: VerificationState) {
  switch (state) {
    case "delivery_verified":
      return (
        <Badge className="bg-green-100 text-green-800 border-green-200 hover:bg-green-100">
          <CheckCircle2 className="w-3 h-3 mr-1" />
          {VERIFICATION_LABELS[state]}
        </Badge>
      );
    case "staff_verified":
      return (
        <Badge className="bg-blue-100 text-blue-800 border-blue-200 hover:bg-blue-100">
          <CheckCircle2 className="w-3 h-3 mr-1" />
          {VERIFICATION_LABELS[state]}
        </Badge>
      );
    case "ai_verified":
      return (
        <Badge className="bg-violet-100 text-violet-800 border-violet-200 hover:bg-violet-100">
          <CheckCircle2 className="w-3 h-3 mr-1" />
          {VERIFICATION_LABELS[state]}
        </Badge>
      );
    case "estimated":
      return (
        <Badge className="bg-amber-100 text-amber-800 border-amber-200 hover:bg-amber-100">
          <Clock className="w-3 h-3 mr-1" />
          {VERIFICATION_LABELS[state]}
        </Badge>
      );
    case "unverified":
    default:
      return (
        <Badge variant="outline" className="text-muted-foreground">
          {VERIFICATION_LABELS[state]}
        </Badge>
      );
  }
}

// ─── Skeleton ────────────────────────────────────────────────────────────────────

function TableSkeleton() {
  return (
    <div className="space-y-2 animate-pulse">
      {Array.from({ length: 8 }).map((_, i) => (
        <div key={i} className="flex items-center gap-4 px-4 py-3 border rounded-md">
          <div className="flex-1 space-y-1.5">
            <div className="h-4 bg-muted rounded w-1/3" />
            <div className="h-3 bg-muted rounded w-1/2" />
          </div>
          <div className="h-4 bg-muted rounded w-16" />
          <div className="h-5 bg-muted rounded-full w-24" />
          <div className="h-4 bg-muted rounded w-8" />
          <div className="h-4 bg-muted rounded w-8" />
          <div className="h-4 bg-muted rounded w-20" />
          <div className="h-7 bg-muted rounded w-7" />
        </div>
      ))}
    </div>
  );
}

// ─── Import Dialog ────────────────────────────────────────────────────────────────

function ImportDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { toast } = useToast();
  const [dryRun, setDryRun] = useState(true);
  const [file, setFile] = useState<File | null>(null);
  const [result, setResult] = useState<{
    imported?: number;
    skipped?: number;
    errors?: string[];
  } | null>(null);
  const [isPending, setIsPending] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const handleUpload = async () => {
    if (!file) return;
    setIsPending(true);
    setResult(null);
    try {
      const formData = new FormData();
      formData.append("file", file);
      formData.append("dry_run", String(dryRun));
      const res = await apiFetch("/api/address-book/places/import", {
        method: "POST",
        body: formData,
      });
      setResult(res as { imported?: number; skipped?: number; errors?: string[] });
      if (!dryRun) {
        queryClient.invalidateQueries({ queryKey: ["address-book-places"] });
        toast({ title: "Import complete" });
      }
    } catch {
      toast({ title: "Import failed", variant: "destructive" });
    } finally {
      setIsPending(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Import addresses</DialogTitle>
          <DialogDescription>
            Upload a CSV file to bulk-import places into the address book.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4 py-2">
          <div className="border-2 border-dashed border-border rounded-lg p-6 text-center space-y-2">
            <Upload className="w-8 h-8 text-muted-foreground mx-auto" />
            <p className="text-sm text-muted-foreground">
              {file ? file.name : "Select a CSV file to upload"}
            </p>
            <Button
              variant="outline"
              size="sm"
              onClick={() => fileRef.current?.click()}
            >
              Browse
            </Button>
            <input
              ref={fileRef}
              type="file"
              accept=".csv"
              className="hidden"
              onChange={(e) => setFile(e.target.files?.[0] ?? null)}
            />
          </div>
          <div className="flex items-center gap-2">
            <input
              id="ab-dry-run"
              type="checkbox"
              checked={dryRun}
              onChange={(e) => setDryRun(e.target.checked)}
              className="h-4 w-4"
            />
            <Label htmlFor="ab-dry-run" className="cursor-pointer font-normal">
              Dry run (preview only, no changes saved)
            </Label>
          </div>
          {result && (
            <div className="rounded-md bg-muted p-3 text-sm space-y-1">
              {result.imported !== undefined && (
                <p className="text-green-700">✓ {result.imported} places {dryRun ? "would be" : ""} imported</p>
              )}
              {result.skipped !== undefined && (
                <p className="text-muted-foreground">↩ {result.skipped} skipped (duplicates)</p>
              )}
              {result.errors && result.errors.length > 0 && (
                <div className="text-destructive space-y-0.5">
                  {result.errors.map((e, i) => (
                    <p key={i}>✗ {e}</p>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={isPending}>
            Cancel
          </Button>
          <Button onClick={handleUpload} disabled={!file || isPending}>
            {isPending ? "Processing…" : dryRun ? "Run dry-run" : "Import"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ─── Archive Confirm Dialog ────────────────────────────────────────────────────

function ArchiveDialog({
  place,
  onClose,
}: {
  place: Place | null;
  onClose: () => void;
}) {
  const { toast } = useToast();
  const { mutate, isPending } = useMutation({
    mutationFn: () =>
      apiFetch(`/api/address-book/places/${place!.id}/archive`, {
        method: "PUT",
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["address-book-places"] });
      toast({ title: "Place archived", description: `${place!.canonical_name} has been archived.` });
      onClose();
    },
    onError: () => {
      toast({ title: "Failed to archive place", variant: "destructive" });
    },
  });

  return (
    <Dialog open={!!place} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>Archive place?</DialogTitle>
          <DialogDescription>
            <strong>{place?.canonical_name}</strong> will be archived and hidden from the active
            address book. This can be undone by an administrator.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={isPending}>
            Cancel
          </Button>
          <Button variant="destructive" onClick={() => mutate()} disabled={isPending}>
            {isPending ? "Archiving…" : "Archive place"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ─── Review Queue Panel ────────────────────────────────────────────────────────

function ReviewQueuePanel({
  summary,
  onGoToNeedsReview,
}: {
  summary: PlacesResponse["summary"] | undefined;
  onGoToNeedsReview: () => void;
}) {
  return (
    <aside className="hidden xl:flex flex-col w-72 shrink-0">
      <Card className="sticky top-4">
        <CardHeader className="pb-3">
          <CardTitle className="text-sm font-semibold flex items-center gap-2">
            <AlertCircle className="w-4 h-4 text-amber-500" />
            Review queue
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2">
            <div className="flex items-center justify-between text-sm">
              <span className="text-muted-foreground">Possible duplicates</span>
              <Badge variant="secondary">
                {summary?.possible_duplicates_count ?? "—"}
              </Badge>
            </div>
            <div className="flex items-center justify-between text-sm">
              <span className="text-muted-foreground">Missing coordinates</span>
              <Badge variant="secondary">
                {summary?.missing_coordinates_count ?? "—"}
              </Badge>
            </div>
          </div>
          {/* Mini map placeholder */}
          <div className="rounded-md bg-muted h-28 flex items-center justify-center border">
            <div className="text-center space-y-1">
              <MapPinned className="w-6 h-6 text-muted-foreground mx-auto" />
              <p className="text-xs text-muted-foreground">Map preview</p>
            </div>
          </div>
          <Button className="w-full" size="sm" onClick={onGoToNeedsReview}>
            Review addresses
          </Button>
        </CardContent>
      </Card>
    </aside>
  );
}

// ─── Main Page ───────────────────────────────────────────────────────────────────

export default function AddressBookPage() {
  const [, setLocation] = useLocation();
  const [searchParams, setSearchParams] = useSearchParams();
  const { toast } = useToast();
  const { realIsOwner } = useWorkspaceRole();

  // State
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [areaFilter, setAreaFilter] = useState("all");
  const [verificationFilter, setVerificationFilter] = useState("all");
  const [typeFilter, setTypeFilter] = useState("all");
  const [activeTab, setActiveTab] = useState<TabKey>("all");
  const [addOpen, setAddOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [archivePlace, setArchivePlace] = useState<Place | null>(null);
  const [reverifyOpen, setReverifyOpen] = useState(false);
  const [activateCheckoutOpen, setActivateCheckoutOpen] = useState(false);
  const [accuracyAuditOpen, setAccuracyAuditOpen] = useState(false);
  const [accuracyAuditReport, setAccuracyAuditReport] = useState<AccuracyAuditReport | null>(null);
  const [accuracyAuditPending, setAccuracyAuditPending] = useState(false);
  const [providerDiagnostics, setProviderDiagnostics] = useState<{
    checked_at: string;
    providers: ProviderDiagnostic[];
  } | null>(null);
  const [providerDiagnosticPending, setProviderDiagnosticPending] = useState(false);

  const page = parseAddressBookPage(searchParams.get("page"));
  const searchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const setPage = useCallback((nextPage: number) => {
    setSearchParams(
      (previousParams: URLSearchParams) => {
        const nextParams = new URLSearchParams(previousParams);
        nextParams.set("page", String(Math.max(1, Math.floor(nextPage))));
        return nextParams;
      },
      { replace: true },
    );
  }, [setSearchParams]);

  const handleSearchChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const val = e.target.value;
    setSearch(val);
    setPage(1);
    if (searchTimerRef.current) clearTimeout(searchTimerRef.current);
    searchTimerRef.current = setTimeout(() => {
      setDebouncedSearch(val);
    }, 300);
  };

  const handleTabChange = useCallback((tab: TabKey) => {
    setActiveTab(tab);
    setPage(1);
  }, [setPage]);

  // Build query params
  const params = new URLSearchParams({ page: String(page) });
  if (debouncedSearch) params.set("q", debouncedSearch);
  if (areaFilter !== "all") params.set("area", areaFilter);
  if (verificationFilter !== "all") params.set("verification", verificationFilter);
  if (typeFilter !== "all") params.set("type", typeFilter);
  if (activeTab !== "all") params.set("tab", activeTab);

  // Data queries
  const {
    data,
    isLoading,
    isError,
    refetch,
  } = useQuery<PlacesResponse>({
    queryKey: ["address-book-places", debouncedSearch, areaFilter, verificationFilter, typeFilter, activeTab, page],
    queryFn: () => apiFetch(`/api/address-book/places?${params}`),
    retry: 1,
  });

  const { data: areasData } = useQuery<AreasResponse>({
    queryKey: ["address-book-areas"],
    queryFn: () => apiFetch("/api/address-book/areas"),
    staleTime: 5 * 60 * 1000,
  });

  const { data: reverifyData } = useQuery<{ run: ReverificationRun }>({
    queryKey: ["address-book-reverification-run"],
    queryFn: () => apiFetch("/api/address-book/reverification-runs/latest"),
    enabled: realIsOwner,
    retry: false,
    refetchOnMount: "always",
    refetchInterval: (query) => {
      const run = query.state.data?.run;
      return run && run.status !== "COMPLETED" ? 3_000 : false;
    },
  });

  const startReverification = useMutation({
    mutationFn: () =>
      apiFetch<{ run: ReverificationRun }>("/api/address-book/reverification-runs", {
        method: "POST",
      }),
    onSuccess: ({ run }) => {
      setReverifyOpen(false);
      queryClient.setQueryData(["address-book-reverification-run"], { run });
      queryClient.invalidateQueries({ queryKey: ["address-book-places"] });
      toast({
        title: run.selected ? (run.reused ? "Existing reverification run resumed" : "AI address reverification queued") : "No eligible AI addresses to reverify",
        description: run.selected
          ? `${run.selected.toLocaleString()} addresses are selected in this run snapshot.`
          : undefined,
      });
    },
    onError: () => {
      toast({ title: "Unable to start reverification", variant: "destructive" });
    },
  });

  const activateVerifiedCheckout = useMutation({
    mutationFn: () =>
      apiFetch<BulkCheckoutActivationResponse>("/api/address-book/places/activate-checkout", {
        method: "POST",
      }),
    onSuccess: (result) => {
      setActivateCheckoutOpen(false);
      queryClient.invalidateQueries({ queryKey: ["address-book-places"] });
      toast({
        title: "Checkout activation complete",
        description: `${result.activated} activated · ${result.already_active} already active · ${result.skipped} skipped because a safety condition was not met.`,
      });
    },
    onError: () => {
      toast({
        title: "Unable to activate checkout",
        description: "No places were changed. Please try again.",
        variant: "destructive",
      });
    },
  });

  const runAccuracyAudit = async () => {
    setAccuracyAuditPending(true);
    try {
      const report = await apiFetch<AccuracyAuditReport>("/api/address-book/accuracy-audit", {
        method: "POST",
        body: JSON.stringify({ limit: 500 }),
      });
      setAccuracyAuditReport(report);
      setAccuracyAuditOpen(true);
    } catch {
      toast({
        title: "Unable to run accuracy audit",
        description: "No Address Book records were changed.",
        variant: "destructive",
      });
    } finally {
      setAccuracyAuditPending(false);
    }
  };

  const checkProviderDiagnostics = async () => {
    setProviderDiagnosticPending(true);
    try {
      const result = await apiFetch<{
        checked_at: string;
        providers: ProviderDiagnostic[];
      }>("/api/address-book/provider-diagnostics", { method: "POST" });
      setProviderDiagnostics(result);
    } catch {
      toast({
        title: "Unable to check map providers",
        description: "No Address Book records were changed. Try again shortly.",
        variant: "destructive",
      });
    } finally {
      setProviderDiagnosticPending(false);
    }
  };

  const summary = data?.summary;
  const places = data?.places ?? [];
  const total = data?.total ?? 0;
  const totalPages = Math.ceil(total / ADDRESS_BOOK_PAGE_SIZE);
  const runSelected = reverifyData?.run.selected ?? reverifyData?.run.total ?? 0;
  const runOutstanding = reverifyData?.run.outstanding ??
    ((reverifyData?.run.queued ?? 0) + (reverifyData?.run.running ?? 0));
  const runTerminal = reverifyData?.run.terminal ?? Math.max(0, runSelected - runOutstanding);
  const runExcluded = reverifyData?.run.excluded ?? 0;
  const googleRunHealth = reverifyData?.run.provider_health?.google_places;
  const googleRunConfigurationFailure = googleRunHealth?.status === "configuration_failure" ||
    googleRunHealth?.status === "disabled_unconfigured";
  const googleDiagnostic = providerDiagnostics?.providers.find(
    (provider) => provider.provider === "google_places",
  );
  const googlePlacesUnavailable = googleDiagnostic?.reachable === false || googleRunConfigurationFailure;

  useEffect(() => {
    if (!data) return;
    const lastPage = Math.max(1, Math.ceil(data.total / ADDRESS_BOOK_PAGE_SIZE));
    if (page > lastPage) setPage(lastPage);
  }, [data, page, setPage]);

  useEffect(() => {
    if (!reverifyData?.run || reverifyData.run.status === "COMPLETED") return;
    queryClient.invalidateQueries({ queryKey: ["address-book-places"] });
  }, [
    reverifyData?.run?.status,
    reverifyData?.run?.outstanding,
    reverifyData?.run?.terminal,
  ]);

  // ─── Render ──────────────────────────────────────────────────────────────────

  return (
    <div className="p-6 space-y-6 max-w-full">
      {/* Header */}
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2">
            <MapPin className="w-6 h-6" />
            Address Book
          </h1>
          <p className="text-muted-foreground text-sm mt-0.5">
            Searchable database of all delivery places and locations
          </p>
        </div>
        <div className="flex gap-2">
          {realIsOwner && (
            <>
              <Button variant="outline" size="sm" onClick={() => setActivateCheckoutOpen(true)}>
                <ShoppingBag className="w-4 h-4 mr-1.5" />
                Activate checkout for verified places
              </Button>
              <Button variant="outline" size="sm" onClick={() => setReverifyOpen(true)}>
                <RefreshCw className="w-4 h-4 mr-1.5" />
                Reverify eligible AI addresses
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={() => void runAccuracyAudit()}
                disabled={accuracyAuditPending}
              >
                <Eye className="w-4 h-4 mr-1.5" />
                {accuracyAuditPending ? "Auditing old AI pins…" : "Audit old AI pins"}
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={() => void checkProviderDiagnostics()}
                disabled={providerDiagnosticPending}
                data-testid="address-book-provider-diagnostics"
              >
                {providerDiagnosticPending
                  ? "Checking providers…"
                  : providerDiagnostics
                    ? "Retry map provider diagnostics"
                    : "Check map providers"}
              </Button>
            </>
          )}
          <Button variant="outline" size="sm" onClick={() => setImportOpen(true)}>
            <Upload className="w-4 h-4 mr-1.5" />
            Import addresses
          </Button>
          <Button size="sm" onClick={() => setAddOpen(true)}>
            <Plus className="w-4 h-4 mr-1.5" />
            Add location
          </Button>
        </div>
      </div>

      {realIsOwner && googlePlacesUnavailable && (
        <div
          className="flex items-start gap-3 rounded-md border border-amber-300 bg-amber-50 p-3 text-amber-950 dark:border-amber-900 dark:bg-amber-950/30 dark:text-amber-100"
          data-testid="address-book-google-places-warning"
          role="status"
        >
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
          <div className="space-y-1">
            <p className="text-sm font-medium">
              {googleDiagnostic?.reachable === true && googleRunConfigurationFailure
                ? "Google Places is unavailable for this run"
                : "Google Places (New) is unavailable"}
            </p>
            <p className="text-xs">
              {googleDiagnostic?.httpStatus
                ? `Latest diagnostic: HTTP ${googleDiagnostic.httpStatus}. `
                : ""}
              {googleRunConfigurationFailure
                ? "This run will skip Google Places after its configuration failure. "
                : "Owners can retry the provider diagnostic above. "}
              Reverification can continue through Nominatim when it is healthy. Existing accuracy safeguards and
              checkout_ready rules are unchanged.
            </p>
          </div>
        </div>
      )}

      {realIsOwner && reverifyData?.run && (
        <Card data-testid="address-reverification-progress">
          <CardContent className="py-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <p className="text-sm font-medium">
                  AI address reverification {reverifyData.run.status === "COMPLETED"
                    ? "previous run complete"
                    : reverifyData.run.status === "PAUSED_PROVIDER_OUTAGE"
                      ? "paused — provider outage"
                      : "in progress"}
                </p>
                {reverifyData.run.status === "COMPLETED" && reverifyData.run.created_at && (
                  <p className="text-xs text-muted-foreground mt-1">
                    Historical run · {new Date(reverifyData.run.created_at).toLocaleString()}
                  </p>
                )}
                {reverifyData.run.status === "PAUSED_PROVIDER_OUTAGE" && (
                  <p className="text-xs text-amber-700 mt-1">
                    Remaining addresses are safely queued. {reverifyData.run.outage_provider ?? "Map provider"}:{" "}
                    {reverifyData.run.paused_reason ?? "temporarily unavailable"}
                    {reverifyData.run.paused_until
                      ? ` · automatic retry ${new Date(reverifyData.run.paused_until).toLocaleString()}`
                      : " · configuration must be fixed before retrying"}
                  </p>
                )}
                <p className="text-xs text-muted-foreground mt-1">
                  Run snapshot: {runSelected} selected · {runOutstanding} outstanding ·{" "}
                  {runTerminal} completed · {runExcluded} not selected
                  {reverifyData.run.reused ? " · existing run reused" : ""}
                </p>
                <p className="text-xs text-muted-foreground mt-1">
                  {reverifyData.run.verified ?? 0} verified · {reverifyData.run.exact ?? 0} exact pins ·{" "}
                  {reverifyData.run.landmark ?? 0} landmark pins ·{" "}
                  {reverifyData.run.street ?? 0} street review · {reverifyData.run.locality ?? 0} locality review ·{" "}
                  {reverifyData.run.repaired ?? 0} repaired ·{" "}
                  {reverifyData.run.cleared ?? 0} cleared · {reverifyData.run.invalid} invalid ·{" "}
                  {reverifyData.run.unresolved} unresolved ·{" "}
                  {reverifyData.run.protected ?? 0} protected · {reverifyData.run.provider_failures ?? reverifyData.run.failed} provider failures
                  {(reverifyData.run.application_failures ?? 0) > 0
                    ? ` · ${reverifyData.run.application_failures} application errors`
                    : ""}
                </p>
                {reverifyData.run.provider_health && (
                  <p className="text-xs text-muted-foreground mt-1">
                    Providers this run:{" "}
                    {(["google_places", "nominatim"] as const).map((provider, index) => {
                      const health = reverifyData.run.provider_health?.[provider];
                      const label = provider === "google_places" ? "Google Places" : "Nominatim";
                      return (
                        <span key={provider}>
                          {index ? " · " : ""}
                          {label}: {health?.status ?? "not checked"}
                          {health?.httpStatus ? ` (HTTP ${health.httpStatus})` : ""}
                          {health?.errorCategory ? ` · ${health.errorCategory}` : ""}
                        </span>
                      );
                    })}
                  </p>
                )}
                 {reverifyData.run.status === "COMPLETED" && reverifyData.run.failed > 0 && (
                   <p className="text-xs text-destructive mt-1">
                     {reverifyData.run.failed} failed
                     {reverifyData.run.failure_reason ? ` · ${reverifyData.run.failure_reason}` : ""}
                   </p>
                 )}
              </div>
              <Badge variant={reverifyData.run.status === "COMPLETED" ? "secondary" : "outline"}>
                {reverifyData.run.status === "COMPLETED"
                  ? `${runTerminal} completed`
                  : reverifyData.run.status === "PAUSED_PROVIDER_OUTAGE"
                    ? `${runOutstanding} safely queued`
                  : `${runOutstanding} remaining`}
              </Badge>
            </div>
          </CardContent>
        </Card>
      )}

      {realIsOwner && providerDiagnostics && (
        <Card data-testid="address-book-provider-diagnostics-result">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">Map provider diagnostics</CardTitle>
            <p className="text-xs text-muted-foreground">
              Checked {new Date(providerDiagnostics.checked_at).toLocaleString()}. Uses fixed test queries only;
              no customer addresses, coordinates, or credentials are displayed, and no Address Book records are changed.
            </p>
          </CardHeader>
          <CardContent className="grid gap-3 sm:grid-cols-2">
            {providerDiagnostics.providers.map((provider) => (
              <div key={provider.provider} className="rounded-md border p-3 text-sm">
                <div className="flex items-center justify-between gap-2">
                  <span className="font-medium">
                    {provider.provider === "google_places" ? "Google Places (New)" : "Nominatim"}
                  </span>
                  <Badge variant={provider.reachable ? "secondary" : "destructive"}>
                    {provider.reachable ? "Reachable" : provider.configured ? "Unavailable" : "Not configured"}
                  </Badge>
                </div>
                <p className="mt-1 text-xs text-muted-foreground">
                  {provider.endpoint} · {provider.credentialSource}
                </p>
                {provider.credentialFingerprint && (
                  <p className="mt-1 font-mono text-[11px] text-muted-foreground">
                    Runtime key fingerprint (SHA-256): {provider.credentialFingerprint}
                  </p>
                )}
                <p className="mt-1 text-xs text-muted-foreground">
                  {provider.configured ? "Configured" : "Not configured"}
                  {provider.httpStatus ? ` · HTTP ${provider.httpStatus}` : ""}
                  {provider.errorCategory ? ` · ${provider.errorCategory}` : ""}
                </p>
                {provider.providerMessage && (
                  <p className="mt-1 text-xs text-muted-foreground">{provider.providerMessage}</p>
                )}
                {provider.providerResponseBody && (
                  <pre className="mt-2 max-h-36 overflow-auto whitespace-pre-wrap break-all rounded bg-muted p-2 text-[11px]">
                    {provider.providerResponseBody}
                  </pre>
                )}
                {provider.minimalTextSearch && (
                  <div
                    className="mt-3 space-y-1 rounded-md border border-dashed p-2 text-xs"
                    data-testid="address-book-minimal-text-search-control"
                  >
                    <p className="font-medium">Minimal Text Search control</p>
                    <p>
                      {provider.minimalTextSearch.attempted
                        ? provider.minimalTextSearch.httpStatus == null
                          ? "No HTTP response"
                          : `HTTP ${provider.minimalTextSearch.httpStatus}`
                        : "Not attempted"}
                      {provider.minimalTextSearch.errorCategory
                        ? ` · ${provider.minimalTextSearch.errorCategory}`
                        : ""}
                    </p>
                    <p className="break-all">
                      {provider.minimalTextSearch.method} {provider.minimalTextSearch.endpoint}
                    </p>
                    <p>Auth header: {provider.minimalTextSearch.authHeader} (value hidden)</p>
                    <p className="break-all">Field mask: {provider.minimalTextSearch.fieldMask}</p>
                    <p>Body: {JSON.stringify({ textQuery: provider.minimalTextSearch.textQuery })}</p>
                    {provider.minimalTextSearch.providerMessage && (
                      <p className="text-muted-foreground">
                        {provider.minimalTextSearch.providerMessage}
                      </p>
                    )}
                    {provider.minimalTextSearch.providerResponseBody && (
                      <pre className="max-h-36 overflow-auto whitespace-pre-wrap break-all rounded bg-muted p-2 text-[11px]">
                        {provider.minimalTextSearch.providerResponseBody}
                      </pre>
                    )}
                  </div>
                )}
                <p className="mt-1 text-xs text-muted-foreground">
                  Checked {new Date(provider.lastChecked).toLocaleString()}
                </p>
              </div>
            ))}
          </CardContent>
        </Card>
      )}

      {/* Summary stat cards */}
      <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
        Current Address Book totals · {(summary?.verified_count ?? 0).toLocaleString()} verified +{" "}
        {(summary?.needs_review_count ?? 0).toLocaleString()} needing review ={" "}
        {((summary?.verified_count ?? 0) + (summary?.needs_review_count ?? 0)).toLocaleString()} places
      </p>
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <Card>
          <CardContent className="pt-5 pb-4">
            <div className="flex items-center gap-3">
              <div className="rounded-full bg-green-100 p-2">
                <CheckCircle2 className="w-4 h-4 text-green-700" />
              </div>
              <div>
                <p className="text-2xl font-bold">
                  {isLoading ? (
                    <span className="inline-block w-10 h-6 bg-muted rounded animate-pulse" />
                  ) : (
                    (summary?.verified_count ?? 0).toLocaleString()
                  )}
                </p>
                <p className="text-xs text-muted-foreground">Verified places</p>
              </div>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-5 pb-4">
            <div className="flex items-center gap-3">
              <div className="rounded-full bg-emerald-100 p-2">
                <ShoppingBag className="w-4 h-4 text-emerald-700" />
              </div>
              <div>
                <p className="text-2xl font-bold">
                  {isLoading ? (
                    <span className="inline-block w-10 h-6 bg-muted rounded animate-pulse" />
                  ) : (
                    (summary?.checkout_ready_count ?? 0).toLocaleString()
                  )}
                </p>
                <p className="text-xs text-muted-foreground">Checkout ready</p>
                <p className="text-[11px] text-muted-foreground">
                  {(summary?.checkout_eligible_count ?? 0).toLocaleString()} eligible to activate
                </p>
              </div>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-5 pb-4">
            <div className="flex items-center gap-3">
              <div className="rounded-full bg-amber-100 p-2">
                <AlertCircle className="w-4 h-4 text-amber-700" />
              </div>
              <div>
                <p className="text-2xl font-bold">
                  {isLoading ? (
                    <span className="inline-block w-10 h-6 bg-muted rounded animate-pulse" />
                  ) : (
                    (summary?.needs_review_count ?? 0).toLocaleString()
                  )}
                </p>
                <p className="text-xs text-muted-foreground">Needs review</p>
              </div>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-5 pb-4">
            <div className="flex items-center gap-3">
              <div className="rounded-full bg-blue-100 p-2">
                <Building2 className="w-4 h-4 text-blue-700" />
              </div>
              <div>
                <p className="text-2xl font-bold">
                  {isLoading ? (
                    <span className="inline-block w-10 h-6 bg-muted rounded animate-pulse" />
                  ) : (
                    (summary?.linked_deliveries_count ?? 0).toLocaleString()
                  )}
                </p>
                <p className="text-xs text-muted-foreground">Linked delivery records</p>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Main content + review panel */}
      <div className="flex gap-6 items-start">
        <div className="flex-1 min-w-0 space-y-4">

          {/* Search + Filters */}
          <div className="flex flex-wrap gap-2">
            <div className="relative flex-1 min-w-[200px] max-w-sm">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
              <Input
                placeholder="Search name, alias, area, contact…"
                value={search}
                onChange={handleSearchChange}
                className="pl-9"
              />
            </div>
            <Select value={areaFilter} onValueChange={(v) => { setAreaFilter(v); setPage(1); }}>
              <SelectTrigger className="w-[160px]">
                <SelectValue placeholder="All areas" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All areas</SelectItem>
                {(areasData?.areas ?? []).map((a) => (
                  <SelectItem key={a} value={a}>{a}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select value={verificationFilter} onValueChange={(v) => { setVerificationFilter(v); setPage(1); }}>
              <SelectTrigger className="w-[180px]">
                <SelectValue placeholder="All verification" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All verification</SelectItem>
                {VERIFICATION_STATES.map((s) => (
                  <SelectItem key={s} value={s}>{VERIFICATION_LABELS[s]}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select value={typeFilter} onValueChange={(v) => { setTypeFilter(v); setPage(1); }}>
              <SelectTrigger className="w-[140px]">
                <SelectValue placeholder="All types" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All types</SelectItem>
                {PLACE_TYPE_OPTIONS.map(({ value, label }) => (
                  <SelectItem key={value} value={value}>{label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {/* Tabs */}
          <div className="flex gap-1 border-b">
            {TABS.map((tab) => (
              <button
                key={tab.key}
                onClick={() => handleTabChange(tab.key)}
                className={`px-4 py-2 text-sm font-medium transition-colors -mb-px border-b-2 ${
                  activeTab === tab.key
                    ? "border-primary text-foreground"
                    : "border-transparent text-muted-foreground hover:text-foreground"
                }`}
              >
                {tab.label}
                {tab.key === "needs_review" && summary?.needs_review_count ? (
                  <span className="ml-1.5 inline-flex items-center justify-center rounded-full bg-amber-100 text-amber-800 text-[10px] font-bold px-1.5 min-w-[18px] h-[18px]">
                    {summary.needs_review_count}
                  </span>
                ) : null}
                {tab.key === "possible_duplicates" && summary?.possible_duplicates_count ? (
                  <span className="ml-1.5 inline-flex items-center justify-center rounded-full bg-muted text-muted-foreground text-[10px] font-bold px-1.5 min-w-[18px] h-[18px]">
                    {summary.possible_duplicates_count}
                  </span>
                ) : null}
              </button>
            ))}
          </div>

          {/* Table */}
          {isLoading && <TableSkeleton />}

          {isError && (
            <Card>
              <CardContent className="py-12 text-center space-y-3">
                <AlertCircle className="w-10 h-10 text-destructive mx-auto" />
                <p className="text-sm text-muted-foreground">Failed to load places.</p>
                <Button variant="outline" size="sm" onClick={() => refetch()}>
                  <RefreshCw className="w-4 h-4 mr-1.5" />
                  Retry
                </Button>
              </CardContent>
            </Card>
          )}

          {!isLoading && !isError && places.length === 0 && (
            <Card>
              <CardContent className="py-16 text-center space-y-3">
                <MapPin className="w-10 h-10 text-muted-foreground mx-auto" />
                {debouncedSearch || areaFilter !== "all" || verificationFilter !== "all" || typeFilter !== "all" ? (
                  <>
                    <p className="text-sm font-medium">No places match your search</p>
                    <p className="text-xs text-muted-foreground">Try adjusting your filters or search term.</p>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => {
                        setSearch(""); setDebouncedSearch("");
                        setAreaFilter("all"); setVerificationFilter("all"); setTypeFilter("all");
                        setPage(1);
                      }}
                    >
                      Clear filters
                    </Button>
                  </>
                ) : activeTab !== "all" ? (
                  <>
                    <p className="text-sm font-medium">Nothing in this queue</p>
                    <p className="text-xs text-muted-foreground">This tab is empty — great work!</p>
                  </>
                ) : (
                  <>
                    <p className="text-sm font-medium">No places yet</p>
                    <p className="text-xs text-muted-foreground">Add your first delivery place to get started.</p>
                    <Button size="sm" onClick={() => setAddOpen(true)}>
                      <Plus className="w-4 h-4 mr-1.5" />
                      Add place
                    </Button>
                  </>
                )}
              </CardContent>
            </Card>
          )}

          {!isLoading && !isError && places.length > 0 && (
            <>
              <div className="border rounded-md overflow-hidden">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Place</TableHead>
                      <TableHead>Area</TableHead>
                      <TableHead>Verification</TableHead>
                      <TableHead className="text-right">Contacts</TableHead>
                      <TableHead className="text-right">Deliveries</TableHead>
                      <TableHead>Last delivered</TableHead>
                      <TableHead className="w-10" />
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {places.map((place) => (
                      <TableRow key={place.id} className="hover:bg-muted/30">
                        <TableCell className="max-w-[240px]">
                          <div className="flex items-center gap-1.5 flex-wrap">
                            <p className="font-medium truncate">{place.canonical_name}</p>
                            {place.ai_invalid && (
                              <Badge className="bg-amber-100 text-amber-800 border-amber-300 hover:bg-amber-100 text-[10px] px-1.5 py-0 h-4 shrink-0">
                                AI: Invalid
                              </Badge>
                            )}
                          </div>
                          {(place.alias_count ?? 0) > 0 && (
                            <p className="text-xs text-muted-foreground truncate mt-0.5">
                              {place.alias_count} {place.alias_count === 1 ? "alias" : "aliases"}
                            </p>
                          )}
                          <p className="text-xs text-muted-foreground mt-0.5 capitalize">
                            {formatPlaceType(place.place_type)}
                          </p>
                        </TableCell>
                        <TableCell className="text-sm text-muted-foreground">
                          {place.area ?? "—"}
                        </TableCell>
                        <TableCell>
                          <div className="flex flex-wrap items-center gap-1.5">
                            {verificationBadge(place.verification_state)}
                            <Badge
                              variant={place.checkout_ready ? "default" : "outline"}
                              className={place.checkout_ready ? "bg-emerald-600 hover:bg-emerald-600" : ""}
                            >
                              {place.checkout_ready ? "Checkout ready" : "Checkout off"}
                            </Badge>
                          </div>
                        </TableCell>
                        <TableCell className="text-right text-sm text-muted-foreground">
                          {place.contact_count ?? 0}
                        </TableCell>
                        <TableCell className="text-right text-sm text-muted-foreground">
                          {place.delivery_count ?? 0}
                        </TableCell>
                        <TableCell className="text-sm text-muted-foreground whitespace-nowrap">
                          <span
                            data-testid={`address-book-last-delivered-${place.id}`}
                            title={place.last_delivered_at ?? undefined}
                          >
                            {place.last_delivered_at
                              ? formatDistanceToNow(new Date(place.last_delivered_at), { addSuffix: true })
                              : "Never"}
                          </span>
                        </TableCell>
                        <TableCell>
                          <DropdownMenu>
                            <DropdownMenuTrigger asChild>
                              <Button variant="ghost" size="icon" className="h-8 w-8">
                                <MoreHorizontal className="w-4 h-4" />
                                <span className="sr-only">Actions</span>
                              </Button>
                            </DropdownMenuTrigger>
                            <DropdownMenuContent align="end" className="w-48">
                              <DropdownMenuItem
                                onClick={() => setLocation(`/address-book/${place.id}`)}
                              >
                                <Eye className="w-4 h-4 mr-2" />
                                View place
                              </DropdownMenuItem>
                              <DropdownMenuItem
                                onClick={() =>
                                  setLocation(`/address-book/${place.id}?panel=edit`)
                                }
                              >
                                <Pencil className="w-4 h-4 mr-2" />
                                Edit details
                              </DropdownMenuItem>
                              <DropdownMenuItem
                                onClick={() => {
                                  toast({
                                    title: "Edit map pin",
                                    description: "Map pin editing is coming soon.",
                                  });
                                }}
                              >
                                <MapPin className="w-4 h-4 mr-2" />
                                Edit map pin
                              </DropdownMenuItem>
                              <DropdownMenuItem
                                onClick={() =>
                                  setLocation(`/address-book/${place.id}?panel=aliases`)
                                }
                              >
                                <Tag className="w-4 h-4 mr-2" />
                                Add alias
                              </DropdownMenuItem>
                              <DropdownMenuItem
                                onClick={() =>
                                  setLocation(`/address-book/${place.id}?panel=contacts`)
                                }
                              >
                                <Users className="w-4 h-4 mr-2" />
                                View linked contacts
                              </DropdownMenuItem>
                              <DropdownMenuItem
                                onClick={() =>
                                  setLocation(`/address-book/${place.id}?panel=merge`)
                                }
                              >
                                <GitMerge className="w-4 h-4 mr-2" />
                                Merge duplicate
                              </DropdownMenuItem>
                              <DropdownMenuSeparator />
                              <DropdownMenuItem
                                className="text-destructive focus:text-destructive"
                                onClick={() => setArchivePlace(place)}
                              >
                                <Archive className="w-4 h-4 mr-2" />
                                Archive place
                              </DropdownMenuItem>
                            </DropdownMenuContent>
                          </DropdownMenu>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>

              {/* Pagination */}
              {totalPages > 1 && (
                <div className="flex items-center justify-between text-sm">
                  <span className="text-muted-foreground">
                    {((page - 1) * ADDRESS_BOOK_PAGE_SIZE) + 1}–{Math.min(page * ADDRESS_BOOK_PAGE_SIZE, total)} of {total.toLocaleString()} places
                  </span>
                  <div className="flex gap-2">
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={page === 1}
                      onClick={() => setPage(page - 1)}
                    >
                      Previous
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={page >= totalPages}
                      onClick={() => setPage(page + 1)}
                    >
                      Next
                    </Button>
                  </div>
                </div>
              )}
            </>
          )}
        </div>

        {/* Review queue panel */}
        <ReviewQueuePanel
          summary={summary}
          onGoToNeedsReview={() => handleTabChange("needs_review")}
        />
      </div>

      {/* Dialogs */}
      <AddLocationDialog open={addOpen} onClose={() => setAddOpen(false)} />
      <ImportDialog open={importOpen} onClose={() => setImportOpen(false)} />
      <ArchiveDialog place={archivePlace} onClose={() => setArchivePlace(null)} />
      <Dialog open={activateCheckoutOpen} onOpenChange={setActivateCheckoutOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Activate checkout for verified places?</DialogTitle>
            <DialogDescription>
              This will activate checkout only for active places verified by AI, staff, or delivery
              that have coordinates and no location conflict. Unsafe or incomplete places will
              remain off, and archived places will not be changed.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setActivateCheckoutOpen(false)}
              disabled={activateVerifiedCheckout.isPending}
            >
              Cancel
            </Button>
            <Button
              onClick={() => activateVerifiedCheckout.mutate()}
              disabled={activateVerifiedCheckout.isPending}
            >
              {activateVerifiedCheckout.isPending ? "Activating…" : "Activate checkout"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <Dialog open={reverifyOpen} onOpenChange={setReverifyOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Reverify eligible AI addresses?</DialogTitle>
            <DialogDescription>
              This queues {summary?.ai_reverification_count ?? 0} active unverified, AI-verified, legacy automated, and
              suspicious duplicate-pin addresses for address-specific map checks. Better supported automated pins may
              replace existing ones; unsupported automated pins will be cleared, returned to review, and removed from
              checkout. Staff-selected, manually pinned, and delivery/GPS-verified locations will not be changed.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setReverifyOpen(false)}>Cancel</Button>
            <Button
              onClick={() => startReverification.mutate()}
              disabled={startReverification.isPending}
            >
              {startReverification.isPending ? "Queueing…" : "Start reverification"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <Dialog open={accuracyAuditOpen} onOpenChange={setAccuracyAuditOpen}>
        <DialogContent className="max-w-3xl">
          <DialogHeader>
            <DialogTitle>Historical AI pin accuracy audit</DialogTitle>
            <DialogDescription>
              Dry-run only. No coordinates, verification states, checkout readiness, or audit rows
              were changed. Review every item marked for owner review before starting reverification.
            </DialogDescription>
          </DialogHeader>
          {accuracyAuditReport && (
            <div className="space-y-4">
              <div className="grid grid-cols-2 gap-2 text-sm sm:grid-cols-4">
                <AuditMetric label="Reviewed" value={accuracyAuditReport.metrics.existing_ai_verified_reviewed} />
                <AuditMetric label="Supported" value={accuracyAuditReport.metrics.still_supported} />
                <AuditMetric label="Changed pin" value={accuracyAuditReport.metrics.materially_different_coordinate} />
                <AuditMetric label="Needs review" value={accuracyAuditReport.metrics.requires_owner_review} />
                <AuditMetric label="Ambiguous" value={accuracyAuditReport.metrics.ambiguous} />
                <AuditMetric label="Contradiction" value={accuracyAuditReport.metrics.locality_contradiction} />
                <AuditMetric label="Low precision" value={accuracyAuditReport.metrics.insufficient_precision} />
                <AuditMetric label="Provider failure" value={accuracyAuditReport.metrics.provider_failure} />
              </div>
              <div className="max-h-[360px] overflow-y-auto rounded-md border divide-y">
                {accuracyAuditReport.results.filter((item) => item.requires_owner_review).map((item) => (
                  <div key={item.place_id} className="p-3 text-sm space-y-1">
                    <div className="flex items-center justify-between gap-3">
                      <span className="font-medium">{item.canonical_name}</span>
                      <Badge variant="outline">{item.classification.replaceAll("_", " ")}</Badge>
                    </div>
                    {item.distance_km != null && (
                      <p className="text-muted-foreground">
                        Candidate is {item.distance_km.toFixed(2)} km from the saved pin.
                      </p>
                    )}
                    {item.selected_candidate && (
                      <p className="text-muted-foreground truncate">
                        {item.selected_candidate.matched_location} · {item.selected_candidate.precision}
                      </p>
                    )}
                    {item.reason && <p className="text-muted-foreground">{item.reason}</p>}
                    {item.candidate_evidence?.slice(0, 3).map((evidence, index) => (
                      <p
                        key={`${String(evidence.candidate_id ?? "candidate")}-${index}`}
                        className="text-xs text-muted-foreground"
                      >
                        {typeof evidence.display_name === "string" ? `${evidence.display_name} · ` : ""}
                        {typeof evidence.rejection === "string"
                          ? evidence.rejection.replaceAll("_", " ")
                          : evidence.accepted === true
                            ? "candidate passed initial checks"
                            : "review evidence"}
                      </p>
                    ))}
                  </div>
                ))}
                {accuracyAuditReport.results.every((item) => !item.requires_owner_review) && (
                  <p className="p-4 text-sm text-muted-foreground">No historical AI pins require owner review.</p>
                )}
              </div>
            </div>
          )}
          <DialogFooter>
            <Button onClick={() => setAccuracyAuditOpen(false)}>Close</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function AuditMetric({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-md border p-2">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="text-lg font-semibold">{value.toLocaleString()}</div>
    </div>
  );
}

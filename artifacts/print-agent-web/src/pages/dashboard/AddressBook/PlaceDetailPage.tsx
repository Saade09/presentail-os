/**
 * Place Detail Page — /address-book/:id
 *
 * Shows all information about a single delivery Place:
 * - Header with name, verification badge, checkout badge, edit + overflow menu
 * - Conflict/checkout-unavailable warning banner
 * - Four summary stat tiles
 * - Location card (map placeholder, map-pin editor)
 * - Linked contacts table (expandable)
 * - Recent deliveries table
 * - Right panel: aliases (approved + pending), place details, verification activity timeline
 * - Edit place dialog
 * - Verify location comparison dialog
 * - Merge flow (multi-step dialog)
 * - Archive flow (confirmation dialog)
 * - Loading skeleton, error, and 404 states
 */
import { useState, useRef, useEffect } from "react";
import { useParams, Link, useLocation } from "wouter";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { format, formatDistanceToNow } from "date-fns";
import {
  ArrowLeft,
  MapPin,
  Building2,
  Users,
  Package,
  Tag,
  Calendar,
  MoreHorizontal,
  Pencil,
  Archive,
  GitMerge,
  Plus,
  X,
  Check,
  CheckCircle2,
  Clock,
  ShieldCheck,
  ShieldAlert,
  Info,
  RefreshCw,
  ChevronDown,
  ChevronUp,
  ExternalLink,
  Navigation,
  AlertTriangle,
  Sparkles,
  ShoppingBag,
  Ban,
  ScanSearch,
} from "lucide-react";
import { apiFetch } from "@/lib/queryClient";
import { useWorkspaceRole } from "@/hooks/use-workspace-role";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Spinner } from "@/components/ui/spinner";
import { GoogleMapsPinMap } from "@/components/GoogleMapsPinMap";
import { GoogleMapsLatLngLiteral, isValidGoogleMapsCoordinate } from "@/lib/googleMaps";
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
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
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
  formatPlaceType,
  PLACE_TYPE_OPTIONS,
  PLACE_TYPE_VALUES,
} from "@workspace/api-zod/place-types";
import { FindThisPlaceModal } from "@/components/FindThisPlaceModal";

// ─── Types ────────────────────────────────────────────────────────────────────

type VerificationState = "unverified" | "estimated" | "ai_verified" | "staff_verified" | "delivery_verified";

interface Place {
  id: string;
  canonical_name: string;
  place_type: string;
  area: string | null;
  city_id: number | null;
  city_name: string | null;
  canonical_address: string | null;
  latitude: number | null;
  longitude: number | null;
  entrance_notes: string | null;
  internal_notes: string | null;
  verification_state: VerificationState;
  ai_invalid: boolean | null;
  archived_at: string | null;
  created_at: string;
  updated_at: string;
  // Verification / checkout fields
  checkout_ready: boolean | null;
  verified_at: string | null;
  verified_by: string | null;
  coordinate_source: string | null;
  verification_precision: "exact" | "landmark" | "street" | "locality" | null;
  verification_method: string | null;
  verification_source: string | null;
  location_conflict: boolean | null;
  // ISO 2-letter country code from the city join — used for autocomplete biasing
  city_country_code: string | null;
}

interface Alias {
  id: string;
  alias_text: string;
  normalized_alias: string;
  language: string | null;
  created_at: string;
  approval_state: "pending" | "approved" | "rejected" | null;
  approved_by: string | null;
  approved_at: string | null;
}

interface LinkedContact {
  id: string;
  first_name: string | null;
  last_name: string | null;
  display_name: string | null;
  phone: string | null;
  email: string | null;
  address_label: string | null;
  address_id: string;
}

interface RecentDelivery {
  order_id: string;
  linked_at: string;
  display_order_number: string | null;
  ordered_at: string | null;
}

interface VerificationEvent {
  id: string;
  event_type: string;
  from_state: string | null;
  to_state: string | null;
  actor_user_id: string | null;
  actor_name: string | null;
  source: string | null;
  notes: string | null;
  metadata: {
    coordinates_before?: { latitude?: number | null; longitude?: number | null };
    coordinates_after?: { latitude?: number | null; longitude?: number | null };
    precision_before?: string | null;
    precision_after?: string | null;
    method_before?: string | null;
    method_after?: string | null;
    correction_reason?: string | null;
  } | null;
  created_at: string;
}

interface PlaceDetailResponse {
  place: Place;
  aliases: Alias[];
  contacts: {
    items: LinkedContact[];
    total: number;
    page: number;
    limit: number;
  };
  recent_deliveries: RecentDelivery[];
  verification_timeline: VerificationEvent[];
}

interface CompareProviderResult {
  current_pin: { latitude: number; longitude: number } | null;
  provider_suggestion: {
    latitude: number;
    longitude: number;
    matched_location: string | null;
    match_type: string | null;
    query: string | null;
  } | null;
  distance_km: number | null;
  locality_match: boolean | null;
  delivery_history: Array<{
    order_id: string;
    display_order_number: string;
    ordered_at: string | null;
    linked_at: string;
  }>;
}

function placeTypeLabel(placeType: string): string {
  return formatPlaceType(placeType);
}

function useAllContacts(placeId: string, enabled: boolean) {
  return useQuery<PlaceDetailResponse["contacts"]>({
    queryKey: ["place-contacts-all", placeId],
    queryFn: () =>
      apiFetch<{ contacts: PlaceDetailResponse["contacts"] }>(
        `/api/address-book/places/${placeId}?contact_page=1&contact_limit=50`,
      ).then((r) => r.contacts),
    enabled,
  });
}

function recentDeliveryOrderLabel(delivery: RecentDelivery): string {
  const displayOrderNumber =
    typeof delivery.display_order_number === "string" ? delivery.display_order_number.trim() : "";
  if (displayOrderNumber) return displayOrderNumber;

  const orderId = typeof delivery.order_id === "string" ? delivery.order_id.trim() : "";
  return orderId || "Unknown order";
}
const VERIFICATION_CONFIG: Record<
  VerificationState,
  { label: string; variant: "default" | "secondary" | "outline" | "destructive"; icon: React.ReactNode; color: string }
> = {
  unverified: {
    label: "Unverified",
    variant: "outline",
    icon: <ShieldAlert className="w-3.5 h-3.5" />,
    color: "text-amber-600",
  },
  estimated: {
    label: "Legacy estimate",
    variant: "secondary",
    icon: <Navigation className="w-3.5 h-3.5" />,
    color: "text-blue-600",
  },
  ai_verified: {
    label: "AI Verified",
    variant: "secondary",
    icon: <Sparkles className="w-3.5 h-3.5" />,
    color: "text-violet-700",
  },
  staff_verified: {
    label: "Staff Verified",
    variant: "default",
    icon: <ShieldCheck className="w-3.5 h-3.5" />,
    color: "text-green-600",
  },
  delivery_verified: {
    label: "Delivery Verified",
    variant: "default",
    icon: <CheckCircle2 className="w-3.5 h-3.5" />,
    color: "text-green-700",
  },
};

export function VerificationBadge({ state }: { state: VerificationState }) {
  const cfg = VERIFICATION_CONFIG[state] ?? VERIFICATION_CONFIG.unverified;
  return (
    <Badge
      variant={cfg.variant}
      className={`flex items-center gap-1 text-xs ${
        state === "staff_verified" || state === "delivery_verified"
          ? "bg-green-100 text-green-800 border-green-200"
          : state === "estimated" || state === "ai_verified"
          ? "bg-violet-50 text-violet-700 border-violet-200"
          : "bg-amber-50 text-amber-700 border-amber-200"
      }`}
    >
      {cfg.icon}
      {cfg.label}
    </Badge>
  );
}

export function CheckoutBadge({ checkoutReady }: { checkoutReady: boolean | null }) {
  if (checkoutReady == null) return null;
  if (checkoutReady) {
    return (
      <Badge className="flex items-center gap-1 text-xs bg-green-100 text-green-800 border-green-200 hover:bg-green-100">
        <ShoppingBag className="w-3.5 h-3.5" />
        Checkout ready
      </Badge>
    );
  }
  return (
    <Badge
      variant="outline"
      className="flex items-center gap-1 text-xs bg-gray-50 text-gray-500 border-gray-200"
    >
      <Ban className="w-3.5 h-3.5" />
      Checkout off
    </Badge>
  );
}

function verificationExplanation(place: Place, deliveryCount: number): string {
  if (place.verification_state === "delivery_verified") {
    return `Confirmed by ${deliveryCount} successful deliver${deliveryCount === 1 ? "y" : "ies"}`;
  }
  if (place.verification_state === "staff_verified") {
    return "Manually verified by a staff member";
  }
  if (place.verification_state === "estimated") {
    return "Legacy estimated coordinates — reverify with AI";
  }
  if (place.verification_state === "ai_verified") {
    if (place.verification_precision === "exact") return "Exact location verified";
    if (place.verification_precision === "landmark") return "Landmark location verified";
    if (place.verification_precision === "street") return "Street location verified";
    if (place.verification_precision === "locality") {
      const locality = place.area || place.city_name;
      return locality
        ? `Approximate location — using verified ${locality} locality coordinates. Exact building could not be located; the pin represents the verified locality.`
        : "Approximate location — exact building could not be located; the pin represents the verified locality.";
    }
    return "Verified using a validated map-provider result";
  }
  return "Location has not been verified yet";
}

function timelineEventLabel(event: VerificationEvent): string {
  switch (event.event_type) {
    case "created": return "Place created";
    case "state_change":
      if (event.to_state === "staff_verified") return "Staff verified";
      if (event.to_state === "delivery_verified") return "Delivery verified";
      if (event.to_state === "estimated") return "Coordinates estimated";
      if (event.to_state === "ai_verified") return "AI verified";
      if (event.to_state === "unverified") return "Reverted to unverified";
      return "Verification state changed";
    case "map_pin_updated":
      if (event.source === "ai" && event.notes?.includes("approximate map match:")) {
        return "Approximate map location AI verified";
      }
      if (event.source === "ai" && event.notes?.includes("exact map match:")) {
        return "Exact map location AI verified";
      }
      if (event.source === "ai") return "Coordinates set by AI geocoder";
      return "Map pin updated";
    case "ai_assessed": return "AI assessment";
    case "alias_approved": return "Alias approved";
    case "alias_rejected": return "Alias rejected";
    case "checkout_activated": return "Checkout activated";
    case "checkout_deactivated": return "Checkout deactivated";
    case "merge": return "Merged from another place";
    default: return event.event_type.replace(/_/g, " ");
  }
}

function timelineEventColor(event: VerificationEvent): string {
  if (event.event_type === "created") return "bg-gray-400";
  if (event.event_type === "merge") return "bg-purple-500";
  if (event.event_type === "ai_assessed") return "bg-amber-500";
  if (event.event_type === "checkout_activated") return "bg-green-600";
  if (event.event_type === "checkout_deactivated") return "bg-gray-500";
  if (event.event_type === "alias_approved") return "bg-blue-500";
  if (event.event_type === "alias_rejected") return "bg-red-400";
  if (event.event_type === "map_pin_updated" && event.source === "ai") return "bg-violet-500";
  if (event.event_type === "map_pin_updated") return "bg-blue-500";
  if (event.to_state === "delivery_verified") return "bg-green-600";
  if (event.to_state === "staff_verified") return "bg-green-500";
  if (event.to_state === "estimated") return "bg-blue-400";
  if (event.to_state === "ai_verified") return "bg-violet-500";
  return "bg-amber-500";
}

// ─── Skeleton ─────────────────────────────────────────────────────────────────

function Skeleton({ className }: { className?: string }) {
  return <div className={`animate-pulse bg-muted rounded ${className ?? ""}`} />;
}

function PlaceDetailSkeleton() {
  return (
    <div className="space-y-6 p-6 max-w-7xl mx-auto">
      <Skeleton className="h-4 w-40" />
      <div className="flex items-start justify-between gap-4">
        <div className="space-y-2 flex-1">
          <Skeleton className="h-8 w-64" />
          <Skeleton className="h-5 w-48" />
        </div>
        <Skeleton className="h-9 w-28" />
      </div>
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        {[...Array(4)].map((_, i) => (
          <Skeleton key={i} className="h-20" />
        ))}
      </div>
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <div className="lg:col-span-2 space-y-6">
          <Skeleton className="h-72" />
          <Skeleton className="h-48" />
          <Skeleton className="h-48" />
        </div>
        <div className="space-y-4">
          <Skeleton className="h-40" />
          <Skeleton className="h-32" />
          <Skeleton className="h-48" />
        </div>
      </div>
    </div>
  );
}

// ─── Verify Location Dialog ───────────────────────────────────────────────────

interface VerifyLocationDialogProps {
  place: Place;
  open: boolean;
  onClose: () => void;
}

export function VerifyLocationDialog({ place, open, onClose }: VerifyLocationDialogProps) {
  const { toast } = useToast();
  const qc = useQueryClient();

  const [mode, setMode] = useState<"compare" | "manual">("compare");
  const [actionError, setActionError] = useState<string | null>(null);

  // Manual pin state
  const [draftLat, setDraftLat] = useState(String(place.latitude ?? ""));
  const [draftLng, setDraftLng] = useState(String(place.longitude ?? ""));
  const [draftConfirmed, setDraftConfirmed] = useState(false);

  useEffect(() => {
    if (!open) return;
    setMode("compare");
    setActionError(null);
    setDraftLat(String(place.latitude ?? ""));
    setDraftLng(String(place.longitude ?? ""));
    setDraftConfirmed(false);
  }, [open, place.id, place.latitude, place.longitude]);

  // Fetch comparison on open
  const {
    data: comparison,
    isLoading: comparisonLoading,
    isError: comparisonError,
    refetch: retryComparison,
  } = useQuery<CompareProviderResult>({
    queryKey: ["place-compare-provider", place.id],
    queryFn: () =>
      apiFetch<CompareProviderResult>(`/api/address-book/places/${place.id}/compare-provider`, {
        method: "POST",
      }),
    enabled: open,
    retry: false,
    staleTime: 0,
  });

  const keepCurrentMutation = useMutation({
    mutationFn: () =>
      apiFetch(`/api/address-book/places/${place.id}/verify`, {
        method: "POST",
        body: JSON.stringify({
          state: "staff_verified",
          notes: "Verified: kept current pin after provider comparison",
          source: "manual",
        }),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["place-detail", place.id] });
      toast({ title: "Location verified — current pin kept" });
      onClose();
    },
    onError: () => {
      setActionError("Failed to verify location. Please try again.");
    },
  });

  const useSuggestedMutation = useMutation({
    mutationFn: async (suggestion: { latitude: number; longitude: number }) => {
      await apiFetch(`/api/address-book/places/${place.id}/map-pin`, {
        method: "PUT",
        body: JSON.stringify({
          latitude: suggestion.latitude,
          longitude: suggestion.longitude,
          source: "google_places",
          notes: "Verified: used provider suggestion from comparison",
        }),
      });
      await apiFetch(`/api/address-book/places/${place.id}/verify`, {
        method: "POST",
        body: JSON.stringify({
          state: "staff_verified",
          notes: "Verified: used provider suggestion from comparison",
          source: "google_places",
        }),
      });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["place-detail", place.id] });
      toast({ title: "Location updated to provider suggestion" });
      onClose();
    },
    onError: () => {
      setActionError("Failed to update pin. Please try again.");
    },
  });

  const manualPinMutation = useMutation({
    mutationFn: async (coords: { lat: number; lng: number }) => {
      await apiFetch(`/api/address-book/places/${place.id}/map-pin`, {
        method: "PUT",
        body: JSON.stringify({
          latitude: coords.lat,
          longitude: coords.lng,
          source: "manual",
          notes: "Verified: manual pin adjustment via provider comparison",
        }),
      });
      await apiFetch(`/api/address-book/places/${place.id}/verify`, {
        method: "POST",
        body: JSON.stringify({
          state: "staff_verified",
          notes: "Verified: manual pin adjustment via provider comparison",
          source: "manual",
        }),
      });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["place-detail", place.id] });
      toast({ title: "Map pin updated and location verified" });
      onClose();
    },
    onError: () => {
      setActionError("Failed to save manual pin. Please try again.");
    },
  });

  const anyPending =
    keepCurrentMutation.isPending ||
    useSuggestedMutation.isPending ||
    manualPinMutation.isPending;

  const currentPin =
    comparison?.current_pin ??
    (place.latitude != null && place.longitude != null
      ? { latitude: place.latitude, longitude: place.longitude }
      : null);

  const suggestion = comparison?.provider_suggestion ?? null;

  // Manual pin validation
  const draftLatNum = parseFloat(draftLat);
  const draftLngNum = parseFloat(draftLng);
  const isDraftValid =
    !isNaN(draftLatNum) && draftLatNum >= -90 && draftLatNum <= 90 &&
    !isNaN(draftLngNum) && draftLngNum >= -180 && draftLngNum <= 180;
  const draftValue = isDraftValid ? { lat: draftLatNum, lng: draftLngNum } : null;

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v && !anyPending) onClose(); }}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <ScanSearch className="w-4 h-4" />
            Verify location
          </DialogTitle>
          <DialogDescription>
            Compare the saved pin against the provider suggestion and confirm this location.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-1">
          {/* Action error */}
          {actionError && (
            <div className="flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
              <span>{actionError}</span>
            </div>
          )}

          {mode === "compare" && (
            <>
              {comparisonLoading && (
                <div className="flex flex-col items-center justify-center py-10 gap-3 text-muted-foreground">
                  <Spinner className="size-6 text-primary" />
                  <p className="text-sm">Fetching provider data…</p>
                </div>
              )}

              {comparisonError && (
                <div className="text-center py-6 space-y-2">
                  <AlertTriangle className="w-8 h-8 text-amber-500 mx-auto" />
                  <p className="text-sm text-muted-foreground">
                    Provider comparison unavailable. You can still keep the current pin or adjust it manually.
                  </p>
                  <Button variant="outline" size="sm" onClick={() => retryComparison()}>
                    <RefreshCw className="w-3 h-3 mr-1.5" /> Retry
                  </Button>
                </div>
              )}

              {!comparisonLoading && !comparisonError && comparison && (
                <div className="space-y-3">
                  {/* Current pin */}
                  <div className="rounded-lg border border-border overflow-hidden">
                    <div className="px-3 py-2 bg-muted/50 border-b border-border">
                      <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">
                        Current saved pin
                      </p>
                    </div>
                    {currentPin ? (
                      <GoogleMapsPinMap
                        center={{ lat: currentPin.latitude, lng: currentPin.longitude }}
                        value={{ lat: currentPin.latitude, lng: currentPin.longitude }}
                        className="h-36"
                      />
                    ) : (
                      <div className="h-24 flex items-center justify-center text-muted-foreground text-sm">
                        No pin saved
                      </div>
                    )}
                    {currentPin && (
                      <div className="px-3 py-1.5 text-xs text-muted-foreground font-mono">
                        {currentPin.latitude.toFixed(6)}, {currentPin.longitude.toFixed(6)}
                      </div>
                    )}
                  </div>

                  {/* Provider suggestion */}
                  <div className="rounded-lg border border-border overflow-hidden">
                    <div className="px-3 py-2 bg-muted/50 border-b border-border flex items-center justify-between">
                      <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">
                        Provider suggestion
                      </p>
                      {comparison.distance_km != null && (
                        <span className="text-xs text-muted-foreground">
                          {comparison.distance_km} km apart
                        </span>
                      )}
                    </div>
                    {suggestion ? (
                      <>
                        <GoogleMapsPinMap
                          center={{ lat: suggestion.latitude, lng: suggestion.longitude }}
                          value={{ lat: suggestion.latitude, lng: suggestion.longitude }}
                          className="h-36"
                        />
                        <div className="px-3 py-2 space-y-0.5">
                          <p className="text-xs font-mono text-muted-foreground">
                            {suggestion.latitude.toFixed(6)}, {suggestion.longitude.toFixed(6)}
                          </p>
                          {suggestion.matched_location && (
                            <p className="text-xs text-foreground">{suggestion.matched_location}</p>
                          )}
                          <div className="flex items-center gap-2 mt-1">
                            {comparison.locality_match != null && (
                              <Badge
                                variant="outline"
                                className={`text-[10px] ${
                                  comparison.locality_match
                                    ? "text-green-700 border-green-300 bg-green-50"
                                    : "text-red-700 border-red-300 bg-red-50"
                                }`}
                              >
                                {comparison.locality_match ? "Locality match ✓" : "Locality mismatch ⚠"}
                              </Badge>
                            )}
                            {suggestion.match_type && (
                              <Badge variant="outline" className="text-[10px]">
                                {suggestion.match_type}
                              </Badge>
                            )}
                          </div>
                        </div>
                      </>
                    ) : (
                      <div className="px-3 py-4 text-sm text-muted-foreground text-center">
                        No provider suggestion available for this address.
                      </div>
                    )}
                  </div>

                  {/* Delivery history */}
                  {comparison.delivery_history.length > 0 && (
                    <div className="rounded-lg border border-border px-3 py-2">
                      <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-1.5">
                        Prior successful deliveries
                      </p>
                      <div className="space-y-0.5">
                        {comparison.delivery_history.slice(0, 3).map((d) => (
                          <p key={d.order_id} className="text-xs text-muted-foreground">
                            Order{" "}
                            <Link href={`/orders/${d.order_id}`} className="hover:underline font-mono">
                              {d.display_order_number}
                            </Link>
                            {d.ordered_at && (
                              <> · {format(new Date(d.ordered_at), "MMM d, yyyy")}</>
                            )}
                          </p>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              )}

              {/* Manual adjustment option */}
              {!comparisonLoading && (
                <button
                  onClick={() => setMode("manual")}
                  className="text-xs text-primary hover:underline flex items-center gap-1"
                >
                  <Pencil className="w-3 h-3" /> Adjust pin manually instead
                </button>
              )}
            </>
          )}

          {mode === "manual" && (
            <div className="space-y-3">
              <button
                onClick={() => { setMode("compare"); setDraftConfirmed(false); }}
                className="text-xs text-muted-foreground hover:underline flex items-center gap-1"
              >
                <ArrowLeft className="w-3 h-3" /> Back to comparison
              </button>
              <GoogleMapsPinMap
                center={draftValue ?? DEFAULT_MAP_CENTER}
                value={draftValue}
                interactive
                className="h-52"
                onChange={(coordinate) => {
                  setDraftLat(coordinate.lat.toFixed(6));
                  setDraftLng(coordinate.lng.toFixed(6));
                  setDraftConfirmed(false);
                }}
              />
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <Label htmlFor="vld-lat">Latitude</Label>
                  <Input
                    id="vld-lat"
                    type="number"
                    step="0.000001"
                    value={draftLat}
                    onChange={(e) => { setDraftLat(e.target.value); setDraftConfirmed(false); }}
                    placeholder="e.g. 25.197525"
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="vld-lng">Longitude</Label>
                  <Input
                    id="vld-lng"
                    type="number"
                    step="0.000001"
                    value={draftLng}
                    onChange={(e) => { setDraftLng(e.target.value); setDraftConfirmed(false); }}
                    placeholder="e.g. 55.274288"
                  />
                </div>
              </div>
              {!isDraftValid && (draftLat.trim() || draftLng.trim()) && (
                <div className="flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">
                  <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                  <span>Enter a latitude from −90 to 90 and a longitude from −180 to 180.</span>
                </div>
              )}
              {!draftConfirmed && isDraftValid && (
                <Button
                  variant="outline"
                  className="w-full"
                  onClick={() => setDraftConfirmed(true)}
                >
                  <Check className="w-4 h-4 mr-1.5" />
                  Looks correct — proceed to save
                </Button>
              )}
            </div>
          )}
        </div>

        <DialogFooter className="flex-col sm:flex-row gap-2">
          <Button
            variant="outline"
            onClick={onClose}
            disabled={anyPending}
          >
            Cancel
          </Button>
          {mode === "compare" && (
            <>
              <Button
                variant="outline"
                onClick={() => {
                  setActionError(null);
                  keepCurrentMutation.mutate();
                }}
                disabled={anyPending || comparisonLoading}
              >
                {keepCurrentMutation.isPending ? (
                  <Spinner className="size-3 mr-1.5" />
                ) : (
                  <ShieldCheck className="w-3.5 h-3.5 mr-1.5" />
                )}
                Keep current pin
              </Button>
              {suggestion && (
                <Button
                  onClick={() => {
                    setActionError(null);
                    useSuggestedMutation.mutate({
                      latitude: suggestion.latitude,
                      longitude: suggestion.longitude,
                    });
                  }}
                  disabled={anyPending || comparisonLoading}
                >
                  {useSuggestedMutation.isPending ? (
                    <Spinner className="size-3 mr-1.5" />
                  ) : (
                    <MapPin className="w-3.5 h-3.5 mr-1.5" />
                  )}
                  Use suggested location
                </Button>
              )}
            </>
          )}
          {mode === "manual" && (
            <Button
              onClick={() => {
                if (!draftValue) return;
                setActionError(null);
                manualPinMutation.mutate(draftValue);
              }}
              disabled={!draftConfirmed || !isDraftValid || anyPending}
            >
              {manualPinMutation.isPending ? "Saving…" : "Confirm & save"}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ─── Edit Place Dialog ────────────────────────────────────────────────────────

interface EditPlaceDialogProps {
  place: Place;
  open: boolean;
  onClose: () => void;
}

function EditPlaceDialog({ place, open, onClose }: EditPlaceDialogProps) {
  const { toast } = useToast();
  const qc = useQueryClient();
  const [form, setForm] = useState({
    canonical_name: place.canonical_name,
    place_type: place.place_type,
    area: place.area ?? "",
    canonical_address: place.canonical_address ?? "",
    entrance_notes: place.entrance_notes ?? "",
  });

  useEffect(() => {
    if (!open) return;
    setForm({
      canonical_name: place.canonical_name,
      place_type: place.place_type,
      area: place.area ?? "",
      canonical_address: place.canonical_address ?? "",
      entrance_notes: place.entrance_notes ?? "",
    });
  }, [
    open,
    place.id,
    place.canonical_name,
    place.place_type,
    place.area,
    place.canonical_address,
    place.entrance_notes,
  ]);

  const { mutate, isPending } = useMutation({
    mutationFn: () =>
      apiFetch(`/api/address-book/places/${place.id}`, {
        method: "PUT",
        body: JSON.stringify({
          canonical_name: form.canonical_name.trim(),
          place_type: form.place_type.trim() || "residence",
          area: form.area.trim() || null,
          canonical_address: form.canonical_address.trim() || null,
          entrance_notes: form.entrance_notes.trim() || null,
        }),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["place-detail", place.id] });
      toast({ title: "Place updated successfully" });
      onClose();
    },
    onError: () => {
      toast({ title: "Failed to update place", variant: "destructive" });
    },
  });

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Edit place</DialogTitle>
          <DialogDescription>Update the canonical details for this place.</DialogDescription>
        </DialogHeader>
        <div className="space-y-4 py-2">
          <div className="space-y-1.5">
            <Label htmlFor="ep-name">Canonical name *</Label>
            <Input
              id="ep-name"
              value={form.canonical_name}
              onChange={(e) => setForm((f) => ({ ...f, canonical_name: e.target.value }))}
              placeholder="e.g. Emirates Hills Villa 24"
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label>Place type</Label>
              <Select value={form.place_type} onValueChange={(v) => setForm((f) => ({ ...f, place_type: v }))}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {PLACE_TYPE_OPTIONS.map(({ value, label }) => (
                    <SelectItem key={value} value={value}>
                      {label}
                    </SelectItem>
                  ))}
                  {!PLACE_TYPE_VALUES.includes(form.place_type as (typeof PLACE_TYPE_VALUES)[number]) &&
                    form.place_type.trim() && (
                      <SelectItem value={form.place_type}>
                        {placeTypeLabel(form.place_type)}
                      </SelectItem>
                    )}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="ep-area">Area</Label>
              <Input
                id="ep-area"
                value={form.area}
                onChange={(e) => setForm((f) => ({ ...f, area: e.target.value }))}
                placeholder="e.g. Jumeirah"
              />
            </div>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="ep-address">Canonical address</Label>
            <Textarea
              id="ep-address"
              value={form.canonical_address}
              onChange={(e) => setForm((f) => ({ ...f, canonical_address: e.target.value }))}
              placeholder="Full written address"
              rows={2}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="ep-notes">Entrance notes</Label>
            <Textarea
              id="ep-notes"
              value={form.entrance_notes}
              onChange={(e) => setForm((f) => ({ ...f, entrance_notes: e.target.value }))}
              placeholder="Gate code, parking info, etc."
              rows={2}
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={isPending}>
            Cancel
          </Button>
          <Button onClick={() => mutate()} disabled={isPending || !form.canonical_name.trim()}>
            {isPending ? "Saving…" : "Save changes"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ─── Map Pin Editor ───────────────────────────────────────────────────────────

interface MapPinEditorProps {
  place: Place;
  open: boolean;
  onClose: () => void;
}

export function MapPinEditor({ place, open, onClose }: MapPinEditorProps) {
  const { toast } = useToast();
  const qc = useQueryClient();
  const [lat, setLat] = useState(String(place.latitude ?? ""));
  const [lng, setLng] = useState(String(place.longitude ?? ""));
  const [confirmed, setConfirmed] = useState(false);

  useEffect(() => {
    if (!open) return;
    setLat(String(place.latitude ?? ""));
    setLng(String(place.longitude ?? ""));
    setConfirmed(false);
  }, [open, place.id, place.latitude, place.longitude]);

  const { mutate, isPending } = useMutation({
    mutationFn: () =>
      apiFetch(`/api/address-book/places/${place.id}/map-pin`, {
        method: "PUT",
        body: JSON.stringify({
          latitude: parseFloat(lat),
          longitude: parseFloat(lng),
          source: "manual",
          notes: "Updated via OS dashboard",
        }),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["place-detail", place.id] });
      toast({ title: "Map pin updated" });
      onClose();
    },
    onError: () => {
      toast({ title: "Failed to update map pin", variant: "destructive" });
    },
  });

  const latNum = parseFloat(lat);
  const lngNum = parseFloat(lng);
  const isValid =
    !isNaN(latNum) && latNum >= -90 && latNum <= 90 &&
    !isNaN(lngNum) && lngNum >= -180 && lngNum <= 180;
  const draftValue = isValid ? { lat: latNum, lng: lngNum } : null;
  const mapCenter = draftValue ?? DEFAULT_MAP_CENTER;

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v) { setConfirmed(false); onClose(); } }}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Edit map pin</DialogTitle>
          <DialogDescription>
            Click the map or drag the pin to choose a location. Changes are only saved when you click Confirm.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4 py-2">
          <GoogleMapsPinMap
            center={mapCenter}
            value={draftValue}
            interactive
            className="h-64"
            onChange={(coordinate) => {
              setLat(coordinate.lat.toFixed(6));
              setLng(coordinate.lng.toFixed(6));
              setConfirmed(false);
            }}
          />
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="mp-lat">Latitude</Label>
              <Input
                id="mp-lat"
                type="number"
                step="0.000001"
                value={lat}
                onChange={(e) => { setLat(e.target.value); setConfirmed(false); }}
                placeholder="e.g. 25.197525"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="mp-lng">Longitude</Label>
              <Input
                id="mp-lng"
                type="number"
                step="0.000001"
                value={lng}
                onChange={(e) => { setLng(e.target.value); setConfirmed(false); }}
                placeholder="e.g. 55.274288"
              />
            </div>
          </div>
          {!isValid && (lat.trim() || lng.trim()) && (
            <div className="flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
              <span>Enter a latitude from −90 to 90 and a longitude from −180 to 180.</span>
            </div>
          )}
          {!confirmed && isValid && (
            <div className="flex items-start gap-2 rounded-md bg-amber-50 border border-amber-200 px-3 py-2 text-sm text-amber-800">
              <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" />
              <span>Review the coordinates carefully before confirming.</span>
            </div>
          )}
          {!confirmed && isValid && (
            <Button
              variant="outline"
              className="w-full"
              onClick={() => setConfirmed(true)}
            >
              <Check className="w-4 h-4 mr-1.5" />
              Looks correct — proceed to save
            </Button>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={isPending}>
            Cancel
          </Button>
          <Button
            onClick={() => mutate()}
            disabled={!confirmed || !isValid || isPending}
          >
            {isPending ? "Saving…" : "Confirm & save"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ─── Archive Dialog ───────────────────────────────────────────────────────────

interface ArchiveDialogProps {
  place: Place;
  open: boolean;
  onClose: () => void;
}

function ArchiveDialog({ place, open, onClose }: ArchiveDialogProps) {
  const { toast } = useToast();
  const [, navigate] = useLocation();

  const { mutate, isPending } = useMutation({
    mutationFn: () =>
      apiFetch(`/api/address-book/places/${place.id}/archive`, { method: "PUT" }),
    onSuccess: () => {
      toast({ title: "Place archived", description: "Historical records are preserved." });
      navigate("/address-book");
    },
    onError: () => {
      toast({ title: "Failed to archive place", variant: "destructive" });
      onClose();
    },
  });

  return (
    <AlertDialog open={open} onOpenChange={(v) => !v && onClose()}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Archive this place?</AlertDialogTitle>
          <AlertDialogDescription>
            <strong>{place.canonical_name}</strong> will be hidden from the address book. All
            historical delivery records, contact links, and aliases are preserved — nothing is deleted.
            You can un-archive this place later if needed.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={isPending}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            onClick={() => mutate()}
            disabled={isPending}
            className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
          >
            {isPending ? "Archiving…" : "Archive place"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

// ─── Merge Flow ───────────────────────────────────────────────────────────────

interface MergeDialogProps {
  place: Place;
  open: boolean;
  onClose: () => void;
}

interface DuplicateCandidate {
  id: string;
  canonical_name: string;
  place_type: string;
  area: string | null;
  city_name: string | null;
  verification_state: string;
  delivery_count: number;
  created_at: string;
}

function MergeDialog({ place, open, onClose }: MergeDialogProps) {
  const { toast } = useToast();
  const [, navigate] = useLocation();
  const [step, setStep] = useState<1 | 2 | 3>(1);
  const [selectedId, setSelectedId] = useState<string>("");
  const [survivorId, setSurvivorId] = useState<string>("");

  const { data: dupData, isLoading: dupsLoading } = useQuery<{ duplicates: DuplicateCandidate[] }>({
    queryKey: ["place-duplicates", place.id],
    queryFn: () => apiFetch(`/api/address-book/places/${place.id}/duplicates`),
    enabled: open,
  });

  const candidates = dupData?.duplicates ?? [];
  const selected = candidates.find((c) => c.id === selectedId) ?? null;

  const { mutate, isPending } = useMutation({
    mutationFn: () =>
      apiFetch(`/api/address-book/places/${place.id}/merge`, {
        method: "POST",
        body: JSON.stringify({ survivor_id: survivorId }),
      }),
    onSuccess: (data: { survivor_id: string }) => {
      toast({ title: "Places merged successfully" });
      navigate(`/address-book/${data.survivor_id}`);
      onClose();
    },
    onError: () => {
      toast({ title: "Failed to merge places", variant: "destructive" });
    },
  });

  const reset = () => {
    setStep(1);
    setSelectedId("");
    setSurvivorId("");
    onClose();
  };

  return (
    <Dialog open={open} onOpenChange={(v) => !v && reset()}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Merge duplicate place</DialogTitle>
          <DialogDescription>
            Step {step} of 3 — {
              step === 1 ? "select the duplicate" :
              step === 2 ? "choose the surviving place" :
              "confirm the merge"
            }
          </DialogDescription>
        </DialogHeader>

        {step === 1 && (
          <div className="space-y-4 py-2">
            {dupsLoading ? (
              <div className="flex justify-center py-8"><Spinner className="size-6 text-primary" /></div>
            ) : candidates.length === 0 ? (
              <div className="text-center py-8 text-muted-foreground">
                <Info className="w-8 h-8 mx-auto mb-2 opacity-40" />
                <p className="text-sm">No duplicate candidates found with the same name.</p>
                <p className="text-xs mt-1">Duplicates are detected by matching canonical names.</p>
              </div>
            ) : (
              <div className="space-y-2">
                {candidates.map((c) => (
                  <label
                    key={c.id}
                    className={`flex items-start gap-3 p-3 rounded-lg border cursor-pointer transition-colors ${
                      selectedId === c.id ? "border-primary bg-primary/5" : "border-border hover:bg-muted/50"
                    }`}
                  >
                    <input
                      type="radio"
                      name="dup-candidate"
                      value={c.id}
                      checked={selectedId === c.id}
                      onChange={() => setSelectedId(c.id)}
                      className="mt-0.5"
                    />
                    <div>
                      <p className="font-medium text-sm">{c.canonical_name}</p>
                      <p className="text-xs text-muted-foreground">
                        {[placeTypeLabel(c.place_type), c.area, c.city_name].filter(Boolean).join(" · ")}
                        {" · "}{c.delivery_count} deliver{c.delivery_count === 1 ? "y" : "ies"}
                        {" · "}{c.verification_state.replace(/_/g, " ")}
                      </p>
                    </div>
                  </label>
                ))}
              </div>
            )}
            <DialogFooter>
              <Button variant="outline" onClick={reset}>Cancel</Button>
              <Button onClick={() => { setSurvivorId(place.id); setStep(2); }} disabled={!selectedId}>
                Next
              </Button>
            </DialogFooter>
          </div>
        )}

        {step === 2 && selected && (
          <div className="space-y-4 py-2">
            <p className="text-sm text-muted-foreground">
              Choose which record survives. The other will be archived and all its aliases,
              contacts, and deliveries will move to the survivor.
            </p>
            <div className="grid grid-cols-2 gap-4">
              {[place, selected].map((p) => (
                <label
                  key={p.id}
                  className={`p-4 rounded-lg border cursor-pointer transition-colors ${
                    survivorId === p.id ? "border-primary bg-primary/5" : "border-border hover:bg-muted/50"
                  }`}
                >
                  <input
                    type="radio"
                    name="survivor"
                    value={p.id}
                    checked={survivorId === p.id}
                    onChange={() => setSurvivorId(p.id)}
                    className="mb-2"
                  />
                  <p className="font-semibold text-sm">{p.canonical_name}</p>
                  <p className="text-xs text-muted-foreground mt-1">
                    Type: {placeTypeLabel(p.place_type)}
                  </p>
                  {p.area && <p className="text-xs text-muted-foreground">Area: {p.area}</p>}
                  <Badge
                    variant="outline"
                    className="mt-2 text-[10px]"
                  >
                    {p.verification_state?.replace(/_/g, " ")}
                  </Badge>
                  {p.id === place.id && (
                    <p className="text-[10px] text-primary font-medium mt-1">Current place</p>
                  )}
                </label>
              ))}
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => setStep(1)}>Back</Button>
              <Button onClick={() => setStep(3)} disabled={!survivorId}>Next</Button>
            </DialogFooter>
          </div>
        )}

        {step === 3 && selected && (
          <div className="space-y-4 py-2">
            <div className="rounded-lg bg-amber-50 border border-amber-200 p-3 text-sm text-amber-800 space-y-1">
              <p className="font-semibold flex items-center gap-1.5">
                <AlertTriangle className="w-4 h-4" /> This action cannot be undone
              </p>
              <p>
                All aliases, contact links, and delivery records from the non-surviving place
                will move to <strong>{
                  survivorId === place.id ? place.canonical_name : selected.canonical_name
                }</strong>.
              </p>
              <p>The other place will be archived and removed from the address book.</p>
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => setStep(2)} disabled={isPending}>Back</Button>
              <Button
                onClick={() => mutate()}
                disabled={isPending}
                className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              >
                {isPending ? "Merging…" : "Confirm merge"}
              </Button>
            </DialogFooter>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

// ─── Add Alias Form ───────────────────────────────────────────────────────────

interface AddAliasFormProps {
  placeId: string;
  onAdded: () => void;
}

function AddAliasForm({ placeId, onAdded }: AddAliasFormProps) {
  const { toast } = useToast();
  const [text, setText] = useState("");
  const [open, setOpen] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const { mutate, isPending } = useMutation({
    mutationFn: () =>
      apiFetch(`/api/address-book/places/${placeId}/aliases`, {
        method: "POST",
        body: JSON.stringify({ alias_text: text.trim() }),
      }),
    onSuccess: () => {
      onAdded();
      setText("");
      setOpen(false);
      toast({ title: "Alias added" });
    },
    onError: (err: unknown) => {
      const apiErr = err as { status?: number };
      if (apiErr.status === 409) {
        toast({ title: "This alias already exists", variant: "destructive" });
      } else {
        toast({ title: "Failed to add alias", variant: "destructive" });
      }
    },
  });

  if (!open) {
    return (
      <button
        onClick={() => { setOpen(true); setTimeout(() => inputRef.current?.focus(), 50); }}
        className="flex items-center gap-1 text-xs text-primary hover:underline"
      >
        <Plus className="w-3 h-3" /> Add alias
      </button>
    );
  }

  return (
    <form
      className="flex items-center gap-1.5 mt-1"
      onSubmit={(e) => { e.preventDefault(); if (text.trim()) mutate(); }}
    >
      <Input
        ref={inputRef}
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder="New alias…"
        className="h-7 text-xs"
      />
      <Button type="submit" size="sm" className="h-7 px-2 text-xs" disabled={isPending || !text.trim()}>
        {isPending ? <Spinner className="size-3" /> : <Check className="w-3 h-3" />}
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="h-7 px-1"
        onClick={() => { setOpen(false); setText(""); }}
        disabled={isPending}
      >
        <X className="w-3 h-3" />
      </Button>
    </form>
  );
}

// ─── Google Map ────────────────────────────────────────────────────────────────

const DEFAULT_MAP_CENTER: GoogleMapsLatLngLiteral = { lat: 25.2048, lng: 55.2708 };

function GoogleMapLocationCard({
  lat,
  lng,
  onEditPin,
  onFindLocation,
  canEdit,
}: {
  lat: number | null;
  lng: number | null;
  onEditPin: () => void;
  onFindLocation: () => void;
  canEdit: boolean;
}) {
  const hasCoords = lat !== null && lng !== null;
  const coordinateValue =
    hasCoords && isValidGoogleMapsCoordinate({ lat, lng }) ? { lat, lng } : null;
  const externalUrl = coordinateValue
    ? `https://www.google.com/maps/search/?api=1&query=${coordinateValue.lat},${coordinateValue.lng}`
    : undefined;

  return (
    <div className="relative rounded-lg overflow-hidden bg-muted border border-border">
      {hasCoords ? (
        <GoogleMapsPinMap
          center={coordinateValue ?? { lat: lat as number, lng: lng as number }}
          value={coordinateValue}
          externalUrl={externalUrl}
          className="h-44"
        />
      ) : (
        <div className="h-44 flex flex-col items-center justify-center text-muted-foreground gap-3 px-4 text-center">
          <MapPin className="w-8 h-8 opacity-30" />
          <div className="space-y-1">
            <p className="text-sm font-medium text-foreground">No location saved</p>
            <p className="text-xs text-muted-foreground">
              Search Google Maps or use a successful delivery pin.
            </p>
          </div>
          {canEdit && (
            <Button
              size="sm"
              className="bg-green-600 hover:bg-green-700 text-white h-8 text-xs gap-1.5"
              onClick={onFindLocation}
            >
              <MapPin className="w-3.5 h-3.5" />
              Find location
            </Button>
          )}
        </div>
      )}
      {canEdit && hasCoords && (
        <div className="px-3 py-2 border-t border-border flex justify-end gap-2">
          <Button variant="outline" size="sm" className="h-7 text-xs gap-1" onClick={onFindLocation}>
            <MapPin className="w-3 h-3" />
            Edit location
          </Button>
          <Button variant="ghost" size="sm" className="h-7 text-xs gap-1 text-muted-foreground" onClick={onEditPin}>
            <Pencil className="w-3 h-3" />
            Adjust map pin
          </Button>
        </div>
      )}
    </div>
  );
}

// ─── Main Page ────────────────────────────────────────────────────────────────

export default function PlaceDetailPage() {
  const params = useParams<{ id: string }>();
  const placeId = params.id ?? "";
  const { realIsOwner } = useWorkspaceRole();
  const { toast } = useToast();
  const qc = useQueryClient();

  // Dialog/panel state
  const [editOpen, setEditOpen] = useState(false);
  const [mapPinOpen, setMapPinOpen] = useState(false);
  const [findLocationOpen, setFindLocationOpen] = useState(false);
  const [archiveOpen, setArchiveOpen] = useState(false);
  const [mergeOpen, setMergeOpen] = useState(false);
  const [verifyOpen, setVerifyOpen] = useState(false);
  const [contactsExpanded, setContactsExpanded] = useState(false);
  const [historyExpanded, setHistoryExpanded] = useState(false);

  // Inline error for checkout activation blocking reasons
  const [checkoutBlockError, setCheckoutBlockError] = useState<string[] | null>(null);

  const { data, isLoading, isError, refetch } = useQuery<PlaceDetailResponse>({
    queryKey: ["place-detail", placeId],
    queryFn: () => apiFetch(`/api/address-book/places/${placeId}`),
    enabled: !!placeId,
    retry: (count, err) => {
      const apiErr = err as { status?: number };
      if (apiErr.status === 404) return false;
      return count < 2;
    },
  });

  const { data: allContactsData } = useAllContacts(placeId, contactsExpanded);

  const deleteAliasMutation = useMutation({
    mutationFn: (aliasId: string) =>
      apiFetch(`/api/address-book/places/${placeId}/aliases/${aliasId}`, { method: "DELETE" }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["place-detail", placeId] });
      toast({ title: "Alias removed" });
    },
    onError: () => {
      toast({ title: "Failed to remove alias", variant: "destructive" });
    },
  });

  const approveAliasMutation = useMutation({
    mutationFn: (aliasId: string) =>
      apiFetch(`/api/address-book/places/${placeId}/aliases/${aliasId}/approve`, { method: "POST" }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["place-detail", placeId] });
      toast({ title: "Alias approved" });
    },
    onError: () => {
      toast({ title: "Failed to approve alias", variant: "destructive" });
    },
  });

  const rejectAliasMutation = useMutation({
    mutationFn: (aliasId: string) =>
      apiFetch(`/api/address-book/places/${placeId}/aliases/${aliasId}/reject`, { method: "POST" }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["place-detail", placeId] });
      toast({ title: "Alias rejected" });
    },
    onError: () => {
      toast({ title: "Failed to reject alias", variant: "destructive" });
    },
  });

  const activateCheckoutMutation = useMutation({
    mutationFn: () =>
      apiFetch<{ success: boolean } | { error: string; blocking_reasons: string[] }>(
        `/api/address-book/places/${placeId}/activate-checkout`,
        { method: "POST" },
      ),
    onSuccess: (result) => {
      const r = result as { blocking_reasons?: string[] };
      if (r.blocking_reasons?.length) {
        setCheckoutBlockError(r.blocking_reasons);
        return;
      }
      setCheckoutBlockError(null);
      qc.invalidateQueries({ queryKey: ["place-detail", placeId] });
      toast({ title: "Checkout activated" });
    },
    onError: (err: unknown) => {
      const apiErr = err as { status?: number; body?: { blocking_reasons?: string[] } };
      if (apiErr.status === 422 && apiErr.body?.blocking_reasons?.length) {
        setCheckoutBlockError(apiErr.body.blocking_reasons);
        return;
      }
      toast({ title: "Failed to activate checkout", variant: "destructive" });
    },
  });

  const deactivateCheckoutMutation = useMutation({
    mutationFn: () =>
      apiFetch(`/api/address-book/places/${placeId}/deactivate-checkout`, { method: "POST" }),
    onSuccess: () => {
      setCheckoutBlockError(null);
      qc.invalidateQueries({ queryKey: ["place-detail", placeId] });
      toast({ title: "Checkout deactivated" });
    },
    onError: () => {
      toast({ title: "Failed to deactivate checkout", variant: "destructive" });
    },
  });

  const aiAssessMutation = useMutation({
    mutationFn: () =>
      apiFetch<{
        success: boolean;
        ai_invalid: boolean;
        latitude: number | null;
        longitude: number | null;
        assessment_status: "exact" | "approximate" | "invalid" | "unresolved";
        matched_location: string | null;
        coordinates_updated: boolean;
        preserved_verified_coordinates: boolean;
      }>(
        `/api/address-book/places/${placeId}/ai-assess`,
        { method: "POST" },
      ),
    onSuccess: (result) => {
      qc.invalidateQueries({ queryKey: ["place-detail", placeId] });
      if (result.ai_invalid) {
        toast({ title: "AI: address flagged as invalid", description: "This address doesn't look like a real delivery location." });
      } else if (result.preserved_verified_coordinates) {
        toast({
          title: "Map match found — verified pin preserved",
          description: result.matched_location
            ? `Matched: ${result.matched_location}. Existing verified coordinates were not changed.`
            : "Existing staff- or delivery-verified coordinates were not changed.",
        });
      } else if (result.assessment_status === "exact") {
        toast({
          title: "Address AI verified",
          description: result.matched_location
            ? `Matched: ${result.matched_location}`
            : "Coordinates were set from a matching map result.",
        });
      } else if (result.assessment_status === "approximate") {
        toast({
          title: "Address AI verified",
          description: result.matched_location
            ? `Validated approximate map match: ${result.matched_location}`
            : "Coordinates were set from a validated approximate map result.",
        });
      } else {
        toast({
          title: "Address remains unresolved",
          description: "It looks like a valid address, but no suitable map match was found.",
        });
      }
    },
    onError: () => {
      toast({ title: "AI assessment failed", description: "Try again in a moment.", variant: "destructive" });
    },
  });

  const syncContactsMutation = useMutation({
    mutationFn: () =>
      apiFetch<{ synced_contacts: number }>(
        `/api/address-book/places/${placeId}/sync-contacts`,
        { method: "POST" },
      ),
    onSuccess: (result) => {
      qc.invalidateQueries({ queryKey: ["place-detail", placeId] });
      toast({
        title: result.synced_contacts > 0
          ? `${result.synced_contacts} contact${result.synced_contacts === 1 ? "" : "s"} synced`
          : "Contacts already up to date",
      });
    },
    onError: () => {
      toast({ title: "Sync failed", description: "Could not sync contacts from deliveries.", variant: "destructive" });
    },
  });

  // ── Loading ──
  if (isLoading) return <PlaceDetailSkeleton />;

  // ── Error ──
  if (isError) {
    const err = (data as unknown) as { status?: number } | undefined;
    const is404 = (err as { status?: number })?.status === 404;
    return (
      <div className="p-6 max-w-2xl mx-auto">
        <Link href="/address-book">
          <Button variant="ghost" size="sm">
            <ArrowLeft className="size-4 mr-1.5" /> Back to Address Book
          </Button>
        </Link>
        <div className="mt-8 text-center space-y-4">
          {is404 ? (
            <>
              <MapPin className="w-12 h-12 text-muted-foreground mx-auto opacity-30" />
              <h2 className="text-xl font-semibold">Place not found</h2>
              <p className="text-muted-foreground text-sm">
                This place may have been archived or the link is incorrect.
              </p>
              <Link href="/address-book">
                <Button variant="outline">Go to Address Book</Button>
              </Link>
            </>
          ) : (
            <>
              <h2 className="text-xl font-semibold">Something went wrong</h2>
              <p className="text-muted-foreground text-sm">Failed to load place details.</p>
              <Button variant="outline" onClick={() => refetch()}>
                <RefreshCw className="w-4 h-4 mr-1.5" /> Try again
              </Button>
            </>
          )}
        </div>
      </div>
    );
  }

  // ── 404 ──
  if (!data) {
    return (
      <div className="p-6">
        <Link href="/address-book">
          <Button variant="ghost" size="sm">
            <ArrowLeft className="size-4 mr-1.5" /> Back to Address Book
          </Button>
        </Link>
        <div className="mt-8 text-center space-y-3">
          <MapPin className="w-12 h-12 text-muted-foreground mx-auto opacity-30" />
          <h2 className="text-xl font-semibold">Place not found</h2>
          <p className="text-muted-foreground text-sm">
            This place doesn't exist or has been removed.
          </p>
        </div>
      </div>
    );
  }

  const { place, aliases, contacts, recent_deliveries, verification_timeline } = data;

  const verificationCfg = VERIFICATION_CONFIG[place.verification_state] ?? VERIFICATION_CONFIG.unverified;

  // Computed states
  const needsVerification =
    place.verification_state === "unverified" || place.verification_state === "estimated";
  const hasConflict = place.location_conflict === true;
  const checkoutUnavailable = !place.checkout_ready && (hasConflict || needsVerification);
  const showWarningBanner = hasConflict || checkoutUnavailable;
  const showPrimaryVerifyButton = needsVerification || hasConflict;

  // Alias partition: approved | pending (rejected hidden)
  const approvedAliases = aliases.filter((a) => !a.approval_state || a.approval_state === "approved");
  const pendingAliases = aliases.filter((a) => a.approval_state === "pending");

  // Stat tiles
  const statTiles = [
    {
      label: "Linked contacts",
      value: contacts.total,
      icon: <Users className="w-4 h-4" />,
    },
    {
      label: "Successful deliveries",
      value: recent_deliveries.length,
      icon: <Package className="w-4 h-4" />,
    },
    {
      label: "Known aliases",
      value: aliases.filter((a) => !a.approval_state || a.approval_state === "approved").length,
      icon: <Tag className="w-4 h-4" />,
    },
    {
      label: "Last delivered",
      value: recent_deliveries[0]?.linked_at
        ? formatDistanceToNow(new Date(recent_deliveries[0].linked_at), { addSuffix: true })
        : "Never",
      icon: <Calendar className="w-4 h-4" />,
      isText: true,
    },
  ];

  const displayedContacts = contactsExpanded
    ? (allContactsData?.items ?? contacts.items)
    : contacts.items.slice(0, 3);

  const subtitle = [
    placeTypeLabel(place.place_type),
    place.area,
    place.city_name,
  ]
    .filter(Boolean)
    .join(" · ");

  // Place details rows (omit null/empty)
  const placeDetailRows: Array<{ label: string; value: string }> = [
    { label: "TYPE", value: placeTypeLabel(place.place_type) },
    ...(place.area ? [{ label: "AREA", value: place.area }] : []),
    { label: "CREATED", value: format(new Date(place.created_at), "MMM d, yyyy") },
    ...(place.city_name ? [{ label: "CITY", value: place.city_name }] : []),
    ...(place.coordinate_source ? [{ label: "COORD SRC", value: place.coordinate_source.replace(/_/g, " ") }] : []),
    ...(place.verified_at ? [{ label: "VERIFIED", value: format(new Date(place.verified_at), "MMM d, yyyy") }] : []),
    ...(place.checkout_ready != null ? [{ label: "CHECKOUT", value: place.checkout_ready ? "Ready" : "Off" }] : []),
  ];

  return (
    <div className="p-4 md:p-6 max-w-7xl mx-auto space-y-6">
      {/* ── Breadcrumb ── */}
      <Link href="/address-book">
        <Button variant="ghost" size="sm" className="gap-1.5 -ml-2 text-muted-foreground">
          <ArrowLeft className="size-4" /> Back to Address Book
        </Button>
      </Link>

      {/* ── Header ── */}
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div className="flex items-start gap-3 min-w-0">
          <div className="w-10 h-10 rounded-xl bg-primary/10 flex items-center justify-center shrink-0 mt-0.5">
            <Building2 className="w-5 h-5 text-primary" />
          </div>
          <div className="min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <h1 className="text-2xl font-bold tracking-tight leading-tight">
                {place.canonical_name}
              </h1>
              <VerificationBadge state={place.verification_state as VerificationState} />
              <CheckoutBadge checkoutReady={place.checkout_ready ?? null} />
              {place.ai_invalid && (
                <Badge className="bg-amber-100 text-amber-800 border-amber-300 hover:bg-amber-100 text-xs">
                  AI: Invalid
                </Badge>
              )}
            </div>
            {subtitle && (
              <p className="text-muted-foreground text-sm mt-0.5">{subtitle}</p>
            )}
          </div>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {/* Primary action: Verify location when attention needed */}
          {realIsOwner && showPrimaryVerifyButton && (
            <Button
              size="sm"
              onClick={() =>
                place.latitude == null ? setFindLocationOpen(true) : setVerifyOpen(true)
              }
            >
              <ShieldCheck className="w-3.5 h-3.5 mr-1.5" />
              Verify location
            </Button>
          )}
          {/* Edit place — primary when no verification needed, secondary otherwise */}
          {realIsOwner && (
            <Button
              variant={showPrimaryVerifyButton ? "outline" : "outline"}
              size="sm"
              onClick={() => setEditOpen(true)}
            >
              <Pencil className="w-3.5 h-3.5 mr-1.5" />
              Edit place
            </Button>
          )}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" size="icon" className="w-8 h-8">
                <MoreHorizontal className="w-4 h-4" />
                <span className="sr-only">More options</span>
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              {realIsOwner && !showPrimaryVerifyButton && (
                <DropdownMenuItem
                  onClick={() =>
                    place.latitude == null ? setFindLocationOpen(true) : setVerifyOpen(true)
                  }
                >
                  <ShieldCheck className="w-4 h-4 mr-2" />
                  Verify location…
                </DropdownMenuItem>
              )}
              {realIsOwner && (
                <DropdownMenuItem onClick={() => setMergeOpen(true)}>
                  <GitMerge className="w-4 h-4 mr-2" />
                  Merge duplicate…
                </DropdownMenuItem>
              )}
              <DropdownMenuItem
                onClick={() => {
                  const url = `https://www.google.com/maps/search/?api=1&query=${place.latitude},${place.longitude}`;
                  window.open(url, "_blank");
                }}
                disabled={!place.latitude || !place.longitude}
              >
                <ExternalLink className="w-4 h-4 mr-2" />
                Open in Google Maps
              </DropdownMenuItem>
              {realIsOwner && (
                <>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem
                    className="text-destructive focus:text-destructive"
                    onClick={() => setArchiveOpen(true)}
                  >
                    <Archive className="w-4 h-4 mr-2" />
                    Archive place…
                  </DropdownMenuItem>
                </>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>

      {/* ── Conflict / checkout-unavailable warning banner ── */}
      {showWarningBanner && (
        <div
          data-testid="checkout-warning-banner"
          className="flex items-start gap-3 rounded-lg border border-amber-300 bg-amber-50 px-4 py-3"
        >
          <AlertTriangle className="w-5 h-5 text-amber-600 shrink-0 mt-0.5" />
          <div className="flex-1 min-w-0">
            {hasConflict ? (
              <p className="text-sm text-amber-800 font-medium">
                Location conflict detected — checkout is unavailable until resolved.
              </p>
            ) : (
              <p className="text-sm text-amber-800 font-medium">
                Location not verified — checkout is unavailable until this place is verified.
              </p>
            )}
            <p className="text-xs text-amber-700 mt-0.5">
              {hasConflict
                ? "The saved coordinates appear to be outside the expected delivery area."
                : "Verify that the map pin is correct before activating checkout."}
            </p>
          </div>
          {realIsOwner && (
            <Button
              size="sm"
              variant="outline"
              className="shrink-0 border-amber-400 text-amber-800 hover:bg-amber-100"
              onClick={() => setVerifyOpen(true)}
            >
              <ShieldCheck className="w-3.5 h-3.5 mr-1.5" />
              Verify location
            </Button>
          )}
        </div>
      )}

      {/* ── Checkout blocking error banner ── */}
      {checkoutBlockError && (
        <div
          data-testid="checkout-block-error"
          className="flex items-start gap-3 rounded-lg border border-destructive/30 bg-destructive/5 px-4 py-3"
        >
          <AlertTriangle className="w-5 h-5 text-destructive shrink-0 mt-0.5" />
          <div className="flex-1 min-w-0">
            <p className="text-sm font-medium text-destructive">Cannot activate checkout</p>
            <ul className="mt-1 space-y-0.5">
              {checkoutBlockError.map((reason, i) => (
                <li key={i} className="text-xs text-destructive/80">• {reason}</li>
              ))}
            </ul>
          </div>
          <button
            onClick={() => setCheckoutBlockError(null)}
            className="text-destructive/60 hover:text-destructive mt-0.5"
            aria-label="Dismiss"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      )}

      {/* ── Stat tiles ── */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        {statTiles.map((tile) => (
          <Card key={tile.label} className="border">
            <CardContent className="p-4">
              <div className="flex items-center gap-2 text-muted-foreground mb-1">
                {tile.icon}
                <span className="text-xs font-medium uppercase tracking-wide">{tile.label}</span>
              </div>
              {tile.isText ? (
                <p className="text-sm font-semibold text-foreground">{tile.value}</p>
              ) : (
                <p className="text-2xl font-bold">{tile.value as number}</p>
              )}
            </CardContent>
          </Card>
        ))}
      </div>

      {/* ── Main content ── */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* ── Left/main column ── */}
        <div className="lg:col-span-2 space-y-6">

          {/* Location card */}
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-base flex items-center gap-2">
                <MapPin className="w-4 h-4" /> Location
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <GoogleMapLocationCard
                lat={place.latitude}
                lng={place.longitude}
                onEditPin={() => setMapPinOpen(true)}
                onFindLocation={() => setFindLocationOpen(true)}
                canEdit={realIsOwner}
              />

              <div className="space-y-2 text-sm">
                {place.canonical_address && (
                  <div className="flex gap-2">
                    <span className="text-muted-foreground w-24 shrink-0 text-xs uppercase font-medium pt-0.5">Address</span>
                    <span>{place.canonical_address}</span>
                  </div>
                )}
                {(place.latitude !== null || place.longitude !== null) && (
                  <div className="flex gap-2">
                    <span className="text-muted-foreground w-24 shrink-0 text-xs uppercase font-medium pt-0.5">Coordinates</span>
                    <span className="font-mono text-xs bg-muted px-1.5 py-0.5 rounded">
                      {place.latitude?.toFixed(6)}, {place.longitude?.toFixed(6)}
                    </span>
                  </div>
                )}
                {place.entrance_notes && (
                  <div className="flex gap-2">
                    <span className="text-muted-foreground w-24 shrink-0 text-xs uppercase font-medium pt-0.5">Entrance</span>
                    <span className="text-sm">{place.entrance_notes}</span>
                  </div>
                )}
                <div className="flex gap-2">
                  <span className="text-muted-foreground w-24 shrink-0 text-xs uppercase font-medium pt-0.5">Verification</span>
                  <span className={`text-sm ${verificationCfg.color}`}>
                    {verificationExplanation(place, recent_deliveries.length)}
                  </span>
                </div>
              </div>
            </CardContent>
          </Card>

          {/* Linked contacts */}
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-base flex items-center gap-2">
                <Users className="w-4 h-4" /> Linked contacts
                <div className="ml-auto flex items-center gap-2">
                  {realIsOwner && (
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-6 px-2 text-xs gap-1 text-muted-foreground font-normal"
                      onClick={() => syncContactsMutation.mutate()}
                      disabled={syncContactsMutation.isPending}
                    >
                      <RefreshCw className={`w-3 h-3 ${syncContactsMutation.isPending ? "animate-spin" : ""}`} />
                      {syncContactsMutation.isPending ? "Syncing…" : "Sync from deliveries"}
                    </Button>
                  )}
                  {contacts.total > 0 && (
                    <Badge variant="secondary" className="text-xs">{contacts.total}</Badge>
                  )}
                </div>
              </CardTitle>
            </CardHeader>
            <CardContent>
              {contacts.total === 0 ? (
                <p className="text-muted-foreground text-sm py-4 text-center">
                  No contacts linked to this place yet.
                </p>
              ) : (
                <>
                  <div className="divide-y divide-border">
                    {displayedContacts.map((contact) => (
                      <div key={contact.address_id} className="flex items-center py-3 gap-3">
                        <div className="flex-1 min-w-0">
                          <Link
                            href={`/omnichannel/contacts/${contact.id}`}
                            className="font-medium text-sm hover:underline text-foreground"
                          >
                            {contact.display_name ??
                              (`${contact.first_name ?? ""} ${contact.last_name ?? ""}`.trim() ||
                              "Unknown")}
                          </Link>
                          <p className="text-xs text-muted-foreground mt-0.5">
                            {contact.address_label && (
                              <span>{contact.address_label}</span>
                            )}
                            {contact.phone && (
                              <span className={contact.address_label ? " · " : ""}>{contact.phone}</span>
                            )}
                          </p>
                        </div>
                        <Link href={`/omnichannel/contacts/${contact.id}`}>
                          <Button variant="ghost" size="icon" className="w-7 h-7 shrink-0">
                            <ExternalLink className="w-3.5 h-3.5 text-muted-foreground" />
                          </Button>
                        </Link>
                      </div>
                    ))}
                  </div>
                  {contacts.total > 3 && (
                    <button
                      className="mt-2 text-sm text-primary hover:underline flex items-center gap-1"
                      onClick={() => setContactsExpanded((v) => !v)}
                    >
                      {contactsExpanded ? (
                        <><ChevronUp className="w-3.5 h-3.5" /> Show fewer contacts</>
                      ) : (
                        <><ChevronDown className="w-3.5 h-3.5" /> View all {contacts.total} contacts</>
                      )}
                    </button>
                  )}
                </>
              )}
            </CardContent>
          </Card>

          {/* Recent deliveries */}
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-base flex items-center gap-2">
                <Package className="w-4 h-4" /> Recent deliveries
              </CardTitle>
            </CardHeader>
            <CardContent>
              {recent_deliveries.length === 0 ? (
                <p className="text-muted-foreground text-sm py-4 text-center">
                  No deliveries linked to this place yet.
                </p>
              ) : (
                <div className="divide-y divide-border">
                  {recent_deliveries.slice(0, 5).map((delivery) => (
                    <div
                      key={`${delivery.order_id || "unknown"}-${delivery.linked_at}`}
                      className="flex items-center py-3 gap-3"
                    >
                      <div className="flex-1 min-w-0">
                        <Link
                          href={recentDeliveryOrderHref(delivery)}
                          className="font-medium text-sm font-mono hover:underline"
                        >
                          {recentDeliveryOrderLabel(delivery)}
                        </Link>
                        <p className="text-xs text-muted-foreground mt-0.5">
                          Linked {format(new Date(delivery.linked_at), "MMM d, yyyy")}
                        </p>
                      </div>
                      <Link href={recentDeliveryOrderHref(delivery)}>
                        <Button variant="ghost" size="icon" className="w-7 h-7 shrink-0">
                          <ExternalLink className="w-3.5 h-3.5 text-muted-foreground" />
                        </Button>
                      </Link>
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
        </div>

        {/* ── Right panel ── */}
        <div className="space-y-4">

          {/* Aliases */}
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-semibold flex items-center gap-2">
                <Tag className="w-4 h-4" /> Aliases
                {pendingAliases.length > 0 && (
                  <Badge variant="secondary" className="text-xs ml-auto">
                    {pendingAliases.length} pending
                  </Badge>
                )}
              </CardTitle>
              <p className="text-xs text-muted-foreground">
                Shared place names only. Delivery instructions and unit details stay with each order.
              </p>
            </CardHeader>
            <CardContent className="space-y-3">
              {/* Approved aliases */}
              {approvedAliases.length === 0 ? (
                <p className="text-xs text-muted-foreground">No approved aliases yet.</p>
              ) : (
                <div className="flex flex-wrap gap-1.5">
                  {approvedAliases.map((alias) => (
                    <span
                      key={alias.id}
                      className="inline-flex items-center gap-1 bg-secondary text-secondary-foreground text-xs rounded-full px-2.5 py-0.5"
                    >
                      {alias.alias_text}
                      {realIsOwner && (
                        <button
                          onClick={() => {
                            if (window.confirm(`Remove alias "${alias.alias_text}"?`)) {
                              deleteAliasMutation.mutate(alias.id);
                            }
                          }}
                          className="hover:text-destructive transition-colors ml-0.5"
                          aria-label={`Remove alias ${alias.alias_text}`}
                        >
                          <X className="w-2.5 h-2.5" />
                        </button>
                      )}
                    </span>
                  ))}
                </div>
              )}

              {/* Pending aliases (owner only) */}
              {realIsOwner && pendingAliases.length > 0 && (
                <div className="border-t border-border pt-3 space-y-2">
                  <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">
                    Pending approval
                  </p>
                  {pendingAliases.map((alias) => (
                    <div
                      key={alias.id}
                      data-testid={`pending-alias-${alias.id}`}
                      className="flex items-center justify-between gap-2 rounded-md border border-dashed border-border px-2.5 py-1.5"
                    >
                      <span className="text-xs truncate">{alias.alias_text}</span>
                      <div className="flex items-center gap-1 shrink-0">
                        <Button
                          size="sm"
                          variant="ghost"
                          className="h-6 px-2 text-xs text-green-700 hover:text-green-800 hover:bg-green-50"
                          onClick={() => approveAliasMutation.mutate(alias.id)}
                          disabled={approveAliasMutation.isPending || rejectAliasMutation.isPending}
                          aria-label={`Approve alias ${alias.alias_text}`}
                        >
                          <Check className="w-3 h-3 mr-0.5" /> Approve
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          className="h-6 px-2 text-xs text-destructive hover:text-destructive hover:bg-destructive/10"
                          onClick={() => rejectAliasMutation.mutate(alias.id)}
                          disabled={approveAliasMutation.isPending || rejectAliasMutation.isPending}
                          aria-label={`Reject alias ${alias.alias_text}`}
                        >
                          <X className="w-3 h-3 mr-0.5" /> Reject
                        </Button>
                      </div>
                    </div>
                  ))}
                </div>
              )}

              {realIsOwner && (
                <AddAliasForm
                  placeId={placeId}
                  onAdded={() => qc.invalidateQueries({ queryKey: ["place-detail", placeId] })}
                />
              )}
            </CardContent>
          </Card>

          {/* Place details */}
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-semibold flex items-center gap-2">
                <Info className="w-4 h-4" /> Place details
              </CardTitle>
            </CardHeader>
            <CardContent>
              <dl className="space-y-2.5 text-sm">
                {placeDetailRows.map(({ label, value }) => (
                  <div key={label} className="flex items-start gap-2">
                    <dt className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider w-20 shrink-0 pt-0.5">
                      {label}
                    </dt>
                    <dd className="text-sm capitalize">{value}</dd>
                  </div>
                ))}
              </dl>
            </CardContent>
          </Card>

          {/* Checkout activation (owner only) */}
          {realIsOwner && (
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm font-semibold flex items-center gap-2">
                  <ShoppingBag className="w-4 h-4" /> Checkout
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-2">
                <p className="text-xs text-muted-foreground">
                  {place.checkout_ready
                    ? "This place is available for checkout. Deactivate to remove it from the ordering flow."
                    : "Activate checkout to make this place available in the ordering flow."}
                </p>
                {place.checkout_ready ? (
                  <Button
                    variant="outline"
                    size="sm"
                    className="w-full text-destructive border-destructive/30 hover:bg-destructive/5"
                    onClick={() => deactivateCheckoutMutation.mutate()}
                    disabled={deactivateCheckoutMutation.isPending}
                    data-testid="deactivate-checkout-btn"
                  >
                    {deactivateCheckoutMutation.isPending ? (
                      <Spinner className="size-3 mr-1.5" />
                    ) : (
                      <Ban className="w-3.5 h-3.5 mr-1.5" />
                    )}
                    Deactivate checkout
                  </Button>
                ) : (
                  <Button
                    size="sm"
                    className="w-full"
                    onClick={() => {
                      setCheckoutBlockError(null);
                      activateCheckoutMutation.mutate();
                    }}
                    disabled={activateCheckoutMutation.isPending || checkoutUnavailable}
                    title={checkoutUnavailable ? "This place must be verified before checkout can be enabled" : undefined}
                    data-testid="activate-checkout-btn"
                  >
                    {activateCheckoutMutation.isPending ? (
                      <Spinner className="size-3 mr-1.5" />
                    ) : (
                      <ShoppingBag className="w-3.5 h-3.5 mr-1.5" />
                    )}
                    Activate checkout
                  </Button>
                )}
              </CardContent>
            </Card>
          )}

          {/* AI re-assess (moved to its own small card to keep it out of prominent position) */}
          {realIsOwner && (
            <div className="px-1">
              <button
                className="text-xs text-muted-foreground hover:text-foreground flex items-center gap-1.5 transition-colors"
                onClick={() => aiAssessMutation.mutate()}
                disabled={aiAssessMutation.isPending}
              >
                {aiAssessMutation.isPending ? (
                  <RefreshCw className="w-3 h-3 animate-spin" />
                ) : (
                  <Sparkles className="w-3 h-3" />
                )}
                {aiAssessMutation.isPending ? "Re-assessing with AI…" : "Re-assess with AI"}
              </button>
            </div>
          )}

          {/* Verification activity — collapsed by default */}
          <Card>
            <CardHeader className="pb-2">
              <button
                className="w-full flex items-center justify-between text-sm font-semibold text-left"
                onClick={() => setHistoryExpanded((v) => !v)}
                aria-expanded={historyExpanded}
                data-testid="verification-history-toggle"
              >
                <span className="flex items-center gap-2">
                  <Clock className="w-4 h-4" /> Verification activity
                </span>
                {historyExpanded ? (
                  <ChevronUp className="w-4 h-4 text-muted-foreground" />
                ) : (
                  <ChevronDown className="w-4 h-4 text-muted-foreground" />
                )}
              </button>
            </CardHeader>
            {historyExpanded && (
              <CardContent data-testid="verification-history-content">
                {verification_timeline.length === 0 ? (
                  <p className="text-xs text-muted-foreground">No activity yet.</p>
                ) : (
                  <ol className="space-y-3">
                    {verification_timeline.map((event, i) => (
                      <li key={event.id} className="flex gap-2.5">
                        <div className="flex flex-col items-center">
                          <div className={`w-2.5 h-2.5 rounded-full shrink-0 mt-1 ${timelineEventColor(event)}`} />
                          {i < verification_timeline.length - 1 && (
                            <div className="w-px flex-1 bg-border mt-1" />
                          )}
                        </div>
                        <div className="pb-2 min-w-0">
                          <p className="text-xs font-medium leading-snug">
                            {timelineEventLabel(event)}
                          </p>
                          {event.actor_name && (
                            <p className="text-[10px] text-muted-foreground">{event.actor_name}</p>
                          )}
                          <p className="text-[10px] text-muted-foreground">
                            {format(new Date(event.created_at), "MMM d, yyyy")}
                          </p>
                          {event.notes && (
                            <p className="text-[10px] text-muted-foreground italic mt-0.5">{event.notes}</p>
                          )}
                          {event.metadata && (
                            <div className="mt-2 rounded border bg-muted/40 p-2 text-[10px] text-muted-foreground space-y-1">
                              {(event.metadata.coordinates_before || event.metadata.coordinates_after) && (
                                <p>
                                  Pin: {event.metadata.coordinates_before?.latitude ?? "—"}, {event.metadata.coordinates_before?.longitude ?? "—"}
                                  {" → "}
                                  {event.metadata.coordinates_after?.latitude ?? "—"}, {event.metadata.coordinates_after?.longitude ?? "—"}
                                </p>
                              )}
                              {(event.metadata.precision_before || event.metadata.precision_after) && (
                                <p>
                                  Precision: {event.metadata.precision_before ?? "none"} → {event.metadata.precision_after ?? "none"}
                                </p>
                              )}
                              {(event.metadata.method_before || event.metadata.method_after) && (
                                <p>
                                  Method: {event.metadata.method_before ?? "none"} → {event.metadata.method_after ?? "none"}
                                </p>
                              )}
                            </div>
                          )}
                        </div>
                      </li>
                    ))}
                  </ol>
                )}
              </CardContent>
            )}
          </Card>
        </div>
      </div>

      {/* ── Dialogs ── */}
      {editOpen && (
        <EditPlaceDialog place={place} open={editOpen} onClose={() => setEditOpen(false)} />
      )}
      {mapPinOpen && (
        <MapPinEditor place={place} open={mapPinOpen} onClose={() => setMapPinOpen(false)} />
      )}
      {archiveOpen && (
        <ArchiveDialog place={place} open={archiveOpen} onClose={() => setArchiveOpen(false)} />
      )}
      {mergeOpen && (
        <MergeDialog place={place} open={mergeOpen} onClose={() => setMergeOpen(false)} />
      )}
      {verifyOpen && (
        <VerifyLocationDialog place={place} open={verifyOpen} onClose={() => setVerifyOpen(false)} />
      )}
      {findLocationOpen && (
        <FindThisPlaceModal
          place={place}
          open={findLocationOpen}
          onClose={() => setFindLocationOpen(false)}
        />
      )}
    </div>
  );
}

function recentDeliveryOrderHref(delivery: RecentDelivery): string {
  return typeof delivery.order_id === "string" && delivery.order_id
    ? `/orders/${delivery.order_id}`
    : "#";
}

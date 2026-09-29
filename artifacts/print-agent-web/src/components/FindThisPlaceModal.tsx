/**
 * FindThisPlaceModal — staff-friendly location picker for Address Book places.
 *
 * Sources (in priority order):
 *  1. Google Places autocomplete search
 *  2. Delivery pins from linked completed orders (place's saved coordinates)
 *  3. Advanced: manual lat/lng entry
 *
 * After a valid source is selected, an interactive map preview is shown.
 * Saving calls PUT /api/address-book/places/:id/map-pin.
 */
import { useState, useEffect, useCallback, useRef } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Link } from "wouter";
import {
  Search,
  Loader2,
  MapPin,
  Check,
  ChevronDown,
  ChevronUp,
  AlertTriangle,
  Package,
  X,
} from "lucide-react";
import { apiFetch } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
  DialogDescription,
} from "@/components/ui/dialog";
import { GoogleMapsPinMap } from "@/components/GoogleMapsPinMap";
import {
  isValidGoogleMapsCoordinate,
  type GoogleMapsLatLngLiteral,
} from "@/lib/googleMaps";
import { format } from "date-fns";

// ─── Analytics helper (no-op if no tracking library is attached) ──────────────

function trackLocationEvent(name: string, props?: Record<string, unknown>) {
  if (import.meta.env.DEV) {
    console.info("[location-finder]", name, props ?? {});
  }
  // Wire a real analytics library here if one is ever added.
}

// ─── Types ────────────────────────────────────────────────────────────────────

interface Place {
  id: string;
  canonical_name: string;
  latitude: number | null;
  longitude: number | null;
  canonical_address: string | null;
  city_name: string | null;
  /** ISO 2-letter country code from the city join — used for autocomplete biasing. */
  city_country_code: string | null;
}

interface GoogleSuggestion {
  placeId: string;
  displayName: string;
  formattedAddress: string;
  types: string[];
}

interface GoogleDetails {
  placeId: string | null;
  displayName: string | null;
  formattedAddress: string | null;
  location: { latitude: number | null; longitude: number | null } | null;
  types: string[];
  primaryType: string | null;
  addressComponents: Array<{ longText?: string; shortText?: string; types?: string[] }>;
}

interface DeliveryPinRow {
  order_id: string;
  display_order_number: string;
  ordered_at: string | null;
  linked_at: string;
  coordinates: { latitude: number; longitude: number } | null;
}

type SelectedSource =
  | { kind: "google"; details: GoogleDetails; coordinate: GoogleMapsLatLngLiteral }
  | { kind: "delivery"; row: DeliveryPinRow; coordinate: GoogleMapsLatLngLiteral }
  | { kind: "manual"; coordinate: GoogleMapsLatLngLiteral };

interface ConflictInfo {
  existing_place: { id: string; title: string; url: string };
}

export interface FindThisPlaceModalProps {
  place: Place;
  open: boolean;
  onClose: () => void;
}

// ─── Default center (Dubai) ───────────────────────────────────────────────────

const DEFAULT_CENTER: GoogleMapsLatLngLiteral = { lat: 25.2048, lng: 55.2708 };

// ─── Sub-components ───────────────────────────────────────────────────────────

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground mb-1.5">
      {children}
    </p>
  );
}

// ─── Google Autocomplete search input (internal) ──────────────────────────────

interface AutocompleteInputProps {
  countryBias: string | null;
  /** Place's existing coordinates — passed to Google for geographic location bias. */
  locationBias: { lat: number; lng: number } | null;
  onSelect: (suggestion: GoogleSuggestion) => void;
  onSearchFailed: () => void;
}

function AutocompleteInput({ countryBias, locationBias, onSelect, onSearchFailed }: AutocompleteInputProps) {
  const [query, setQuery] = useState("");
  const [suggestions, setSuggestions] = useState<GoogleSuggestion[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [isOpen, setIsOpen] = useState(false);
  const [noResults, setNoResults] = useState(false);
  const [isUnavailable, setIsUnavailable] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  const search = useCallback(
    async (q: string) => {
      if (!q.trim()) {
        setSuggestions([]);
        setIsOpen(false);
        setIsLoading(false);
        setNoResults(false);
        setIsUnavailable(false);
        return;
      }
      setIsLoading(true);
      setNoResults(false);
      setIsUnavailable(false);
      try {
        let url = `/api/address-book/places/google-autocomplete?q=${encodeURIComponent(q)}`;
        if (countryBias) url += `&countryCode=${encodeURIComponent(countryBias)}`;
        if (locationBias) {
          url += `&lat=${locationBias.lat}&lng=${locationBias.lng}`;
        }
        // Track locally so the post-await code sees the synchronous result of the catch.
        let unavailable = false;
        const res = await apiFetch<{ suggestions: GoogleSuggestion[] }>(url).catch(
          (err: unknown) => {
            const status = (err as { status?: number }).status;
            if (status === 503 || status === 502) {
              unavailable = true;
              setIsUnavailable(true);
              onSearchFailed();
            }
            return { suggestions: [] as GoogleSuggestion[] };
          },
        );
        const items = res.suggestions ?? [];
        setSuggestions(items);
        if (!unavailable) {
          setNoResults(items.length === 0 && q.trim().length >= 2);
        }
        setIsOpen(true);
      } finally {
        setIsLoading(false);
      }
    },
    [countryBias, locationBias, onSearchFailed],
  );

  useEffect(() => {
    if (timerRef.current) clearTimeout(timerRef.current);
    if (!query.trim()) {
      setSuggestions([]);
      setIsOpen(false);
      setIsLoading(false);
      setNoResults(false);
      setIsUnavailable(false);
      return;
    }
    setIsLoading(true);
    timerRef.current = setTimeout(() => search(query), 300);
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [query, search]);

  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setIsOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, []);

  return (
    <div ref={containerRef} className="relative">
      <div className="relative">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground pointer-events-none" />
        {isLoading && (
          <Loader2 className="absolute right-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground animate-spin" />
        )}
        <Input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onFocus={() => { if (suggestions.length > 0) setIsOpen(true); }}
          placeholder="Search by hotel, building or landmark…"
          className="pl-9 pr-9"
          autoComplete="off"
          aria-label="Search Google Maps for this place"
        />
      </div>

      {isOpen && (
        <div className="absolute z-50 mt-1 w-full rounded-md border border-border bg-background shadow-lg overflow-hidden">
          {isUnavailable ? (
            <div className="flex items-center gap-2 px-3 py-3 text-sm text-amber-700 bg-amber-50 dark:bg-amber-950/30 dark:text-amber-400">
              <AlertTriangle className="h-4 w-4 shrink-0" />
              <span>Google search is currently unavailable — contact support.</span>
            </div>
          ) : suggestions.length > 0 ? (
            suggestions.map((s) => (
              <button
                key={s.placeId}
                className="w-full flex items-start gap-3 px-3 py-2.5 text-left hover:bg-accent transition-colors focus:outline-none focus:bg-accent"
                onClick={() => {
                  setQuery(s.displayName);
                  setIsOpen(false);
                  onSelect(s);
                }}
              >
                <MapPin className="h-4 w-4 text-blue-500 mt-0.5 shrink-0" />
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium truncate">{s.displayName}</p>
                  <p className="text-xs text-muted-foreground truncate">{s.formattedAddress}</p>
                </div>
                <Badge
                  variant="outline"
                  className="shrink-0 text-[10px] border-blue-300 text-blue-600"
                >
                  Google
                </Badge>
              </button>
            ))
          ) : noResults ? (
            <p className="px-3 py-3 text-sm text-muted-foreground">
              No Google results found. Try a different name or use a delivery pin below.
            </p>
          ) : null}
        </div>
      )}
    </div>
  );
}

// ─── Main modal ───────────────────────────────────────────────────────────────

export function FindThisPlaceModal({ place, open, onClose }: FindThisPlaceModalProps) {
  const { toast } = useToast();
  const qc = useQueryClient();

  // Selection state
  const [selected, setSelected] = useState<SelectedSource | null>(null);
  const [loadingDetails, setLoadingDetails] = useState(false);
  const [detailsError, setDetailsError] = useState<string | null>(null);

  // Conflict (duplicate google_place_id in another place) — blocks saving until resolved
  const [conflict, setConflict] = useState<ConflictInfo | null>(null);

  // Out-of-country warning
  const [outOfCountry, setOutOfCountry] = useState(false);
  const [outOfCountryConfirmed, setOutOfCountryConfirmed] = useState(false);

  // Advanced manual entry
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [manualLat, setManualLat] = useState("");
  const [manualLng, setManualLng] = useState("");

  // Analytics: fire on open
  useEffect(() => {
    if (open) {
      setSelected(null);
      setLoadingDetails(false);
      setDetailsError(null);
      setConflict(null);
      setOutOfCountry(false);
      setOutOfCountryConfirmed(false);
      setAdvancedOpen(false);
      setManualLat("");
      setManualLng("");
      trackLocationEvent("location_finder_opened", { place_id: place.id });
    }
  }, [open, place.id]);

  // Delivery history (for "From delivery" section)
  const { data: deliveryData } = useQuery<{
    deliveries: DeliveryPinRow[];
    place_coordinates: { latitude: number; longitude: number } | null;
  }>({
    queryKey: ["place-delivery-history", place.id],
    queryFn: () =>
      apiFetch(`/api/address-book/places/${place.id}/delivery-history?limit=20`),
    enabled: open,
    staleTime: 30_000,
  });

  const usableDeliveries = (deliveryData?.deliveries ?? []).filter(
    (d) => d.coordinates != null,
  );

  // ISO 2-letter country code used to restrict Google autocomplete results
  const countryBias = place.city_country_code ?? null;

  // Geographic bias: use the place's existing pin so autocomplete suggestions
  // are ranked toward the same area (hotel corridors, compound clusters, etc.)
  const locationBias: { lat: number; lng: number } | null =
    place.latitude != null && place.longitude != null
      ? { lat: place.latitude, lng: place.longitude }
      : null;

  // Derive current map center
  const mapCenter: GoogleMapsLatLngLiteral =
    selected?.coordinate ??
    (place.latitude != null && place.longitude != null
      ? { lat: place.latitude, lng: place.longitude }
      : DEFAULT_CENTER);

  // ── Google suggestion selected ──

  async function handleGoogleSuggestion(suggestion: GoogleSuggestion) {
    setSelected(null);
    setDetailsError(null);
    setConflict(null);
    setOutOfCountry(false);
    setOutOfCountryConfirmed(false);
    setLoadingDetails(true);

    try {
      const details = await apiFetch<GoogleDetails>(
        `/api/address-book/places/google-details?placeId=${encodeURIComponent(suggestion.placeId)}`,
      );

      const lat = details.location?.latitude ?? null;
      const lng = details.location?.longitude ?? null;

      if (lat == null || lng == null || !isValidGoogleMapsCoordinate({ lat, lng })) {
        setDetailsError("Google didn't return coordinates for this place. Try another result.");
        trackLocationEvent("location_search_failed", {
          place_id: place.id,
          reason: "no_coordinates",
        });
        return;
      }

      const coordinate: GoogleMapsLatLngLiteral = { lat, lng };
      setSelected({ kind: "google", details, coordinate });
      trackLocationEvent("google_place_selected", {
        place_id: place.id,
        google_place_id: details.placeId,
      });

      // Check out-of-country
      if (countryBias && details.addressComponents) {
        const countryComponent = details.addressComponents.find((ac) =>
          ac.types?.includes("country"),
        );
        const resultCountry = countryComponent?.shortText?.toUpperCase();
        if (resultCountry && resultCountry !== countryBias) {
          setOutOfCountry(true);
        }
      }
    } catch {
      setDetailsError("Could not load location details. Please try again.");
      trackLocationEvent("location_search_failed", {
        place_id: place.id,
        reason: "api_error",
      });
    } finally {
      setLoadingDetails(false);
    }
  }

  // ── Delivery pin selected ──

  function handleDeliveryPin(row: DeliveryPinRow) {
    if (!row.coordinates) return;
    const coordinate: GoogleMapsLatLngLiteral = {
      lat: row.coordinates.latitude,
      lng: row.coordinates.longitude,
    };
    setSelected({ kind: "delivery", row, coordinate });
    setConflict(null);
    setOutOfCountry(false);
    setOutOfCountryConfirmed(false);
    trackLocationEvent("delivery_pin_selected", {
      place_id: place.id,
      order_id: row.order_id,
    });
  }

  // ── Manual coordinate change ──

  const manualLatNum = parseFloat(manualLat);
  const manualLngNum = parseFloat(manualLng);
  const manualValid =
    !isNaN(manualLatNum) &&
    manualLatNum >= -90 &&
    manualLatNum <= 90 &&
    !isNaN(manualLngNum) &&
    manualLngNum >= -180 &&
    manualLngNum <= 180;

  function applyManualCoords() {
    if (!manualValid) return;
    const coordinate: GoogleMapsLatLngLiteral = { lat: manualLatNum, lng: manualLngNum };
    setSelected({ kind: "manual", coordinate });
    setConflict(null);
    setOutOfCountry(false);
    setOutOfCountryConfirmed(false);
    trackLocationEvent("manual_pin_selected", { place_id: place.id });
  }

  // ── Map pin drag ──

  function handleMapPinMove(coordinate: GoogleMapsLatLngLiteral) {
    if (!selected) return;
    setSelected({ ...selected, coordinate });
    if (selected.kind === "manual") {
      setManualLat(coordinate.lat.toFixed(6));
      setManualLng(coordinate.lng.toFixed(6));
    }
  }

  // ── Save ──

  const saveMutation = useMutation({
    mutationFn: async () => {
      if (!selected) throw new Error("No location selected");

      let body: Record<string, unknown> = {
        latitude: selected.coordinate.lat,
        longitude: selected.coordinate.lng,
      };

      if (selected.kind === "google") {
        const d = selected.details;
        body = {
          ...body,
          source: "google_places",
          google_place_id: d.placeId,
          google_formatted_address: d.formattedAddress,
          google_place_type: d.primaryType,
          google_country:
            d.addressComponents
              .find((ac) => ac.types?.includes("country"))
              ?.longText ?? null,
          google_city:
            d.addressComponents
              .find((ac) =>
                ac.types?.includes("locality") ||
                ac.types?.includes("administrative_area_level_2"),
              )
              ?.longText ?? null,
          google_original_lat: d.location?.latitude ?? null,
          google_original_lng: d.location?.longitude ?? null,
          // Deep-link URL so staff can open the exact Google Maps listing
          google_maps_url: d.placeId
            ? `https://www.google.com/maps/place/?q=place_id:${encodeURIComponent(d.placeId)}`
            : null,
          notes: `Location set via Google Maps: ${d.displayName ?? ""}`,
        };
      } else if (selected.kind === "delivery") {
        body = {
          ...body,
          source: "linked_delivery",
          source_order_id: selected.row.order_id,
          notes: `Reused pin from delivery ${selected.row.display_order_number}`,
        };
      } else {
        body = {
          ...body,
          source: "manual",
          notes: "Manual coordinates entered via Find This Place",
        };
        trackLocationEvent("manual_coordinates_used", { place_id: place.id });
      }

      return apiFetch<{ success: boolean }>(
        `/api/address-book/places/${place.id}/map-pin`,
        { method: "PUT", body: JSON.stringify(body) },
      );
    },
    onSuccess: () => {
      trackLocationEvent("location_saved", {
        place_id: place.id,
        source: selected?.kind,
      });
      qc.invalidateQueries({ queryKey: ["place-detail", place.id] });
      toast({ title: "Location saved" });
      onClose();
    },
    onError: (err: unknown) => {
      // apiFetch throws with err.status and err.body (already parsed JSON) on non-2xx
      const apiErr = err as { status?: number; body?: Record<string, unknown> };
      if (apiErr.status === 409 && apiErr.body?.conflict === "duplicate_google_place_id") {
        const existing = apiErr.body.existing_place as ConflictInfo["existing_place"] | undefined;
        if (existing) {
          setConflict({ existing_place: existing });
          return;
        }
      }
      toast({ title: "Failed to save location", variant: "destructive" });
    },
  });

  // ── Derived UI states ──

  const needsOutOfCountryConfirm = outOfCountry && !outOfCountryConfirmed;
  const canSave =
    selected != null &&
    !loadingDetails &&
    !needsOutOfCountryConfirm &&
    // Block saving when a duplicate Google Place ID conflict exists — staff must
    // clear their selection or navigate to the existing place instead.
    conflict == null &&
    !saveMutation.isPending;

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v) onClose(); }}>
      <DialogContent className="sm:max-w-2xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Find this place</DialogTitle>
          <DialogDescription>
            Search Google Maps, reuse a confirmed delivery pin, or enter coordinates manually.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-5 py-1">

          {/* ── Google search ── */}
          <div>
            <SectionLabel>Search Google Maps</SectionLabel>
            <AutocompleteInput
              countryBias={countryBias}
              locationBias={locationBias}
              onSelect={handleGoogleSuggestion}
              onSearchFailed={() =>
                trackLocationEvent("location_search_failed", {
                  place_id: place.id,
                  reason: "google_unavailable",
                })
              }
            />
            {loadingDetails && (
              <div className="mt-2 flex items-center gap-2 text-sm text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" />
                Loading place details…
              </div>
            )}
            {detailsError && (
              <div className="mt-2 flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                {detailsError}
              </div>
            )}
          </div>

          {/* ── Recommended (Google result) ── */}
          {selected?.kind === "google" && (
            <div>
              <SectionLabel>Recommended · Google Maps</SectionLabel>
              <div className="rounded-lg border border-green-200 bg-green-50 px-4 py-3 flex items-start gap-3">
                <Check className="mt-0.5 h-4 w-4 text-green-600 shrink-0" />
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-semibold leading-snug">
                    {selected.details.displayName ?? "Unnamed location"}
                  </p>
                  {selected.details.formattedAddress && (
                    <p className="text-xs text-muted-foreground mt-0.5">
                      {selected.details.formattedAddress}
                    </p>
                  )}
                </div>
                <button
                  onClick={() => { setSelected(null); setOutOfCountry(false); setOutOfCountryConfirmed(false); }}
                  className="text-muted-foreground hover:text-foreground mt-0.5"
                  aria-label="Clear selection"
                >
                  <X className="h-4 w-4" />
                </button>
              </div>

              {/* Out-of-country warning */}
              {needsOutOfCountryConfirm && (
                <div className="mt-2 rounded-md border border-amber-300 bg-amber-50 px-3 py-2.5 space-y-2">
                  <div className="flex items-start gap-2">
                    <AlertTriangle className="mt-0.5 h-4 w-4 text-amber-600 shrink-0" />
                    <p className="text-sm text-amber-800">
                      This result appears to be outside the expected country. Confirm you want to use it.
                    </p>
                  </div>
                  <div className="flex gap-2">
                    <Button
                      size="sm"
                      variant="outline"
                      className="border-amber-400 text-amber-800 hover:bg-amber-100"
                      onClick={() => setOutOfCountryConfirmed(true)}
                    >
                      Use anyway
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => { setSelected(null); setOutOfCountry(false); }}
                    >
                      Choose another
                    </Button>
                  </div>
                </div>
              )}
            </div>
          )}

          {/* ── From delivery ── */}
          {usableDeliveries.length > 0 && (
            <div>
              <SectionLabel>From delivery</SectionLabel>
              <div className="space-y-1">
                {usableDeliveries.slice(0, 5).map((row) => {
                  const isActive =
                    selected?.kind === "delivery" &&
                    selected.row.order_id === row.order_id;
                  return (
                    <div
                      key={row.order_id}
                      className={`flex items-center gap-3 rounded-md border px-3 py-2.5 transition-colors ${
                        isActive
                          ? "border-green-300 bg-green-50"
                          : "border-border bg-background hover:bg-accent/50"
                      }`}
                    >
                      <Package className="h-4 w-4 text-muted-foreground shrink-0" />
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-medium">
                          Order {row.display_order_number}
                        </p>
                        <p className="text-xs text-muted-foreground">
                          Successful delivery location
                          {row.ordered_at
                            ? ` · ${format(new Date(row.ordered_at), "MMM d, yyyy")}`
                            : ""}
                        </p>
                      </div>
                      {isActive ? (
                        <Check className="h-4 w-4 text-green-600 shrink-0" />
                      ) : (
                        <Button
                          size="sm"
                          variant="outline"
                          className="h-7 text-xs shrink-0"
                          onClick={() => handleDeliveryPin(row)}
                        >
                          Use this pin
                        </Button>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* ── Map preview ── */}
          {selected && (
            <div>
              <SectionLabel>Preview — drag pin to adjust</SectionLabel>
              <GoogleMapsPinMap
                center={mapCenter}
                value={selected.coordinate}
                interactive
                onChange={handleMapPinMove}
                className="h-52 rounded-lg"
              />
              <p className="mt-1 text-center font-mono text-xs text-muted-foreground">
                {selected.coordinate.lat.toFixed(6)},{" "}
                {selected.coordinate.lng.toFixed(6)}
              </p>
            </div>
          )}

          {/* ── Conflict warning — saving is blocked; staff must clear or navigate away ── */}
          {conflict && (
            <div className="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-3 space-y-2">
              <div className="flex items-start gap-2">
                <AlertTriangle className="mt-0.5 h-4 w-4 text-destructive shrink-0" />
                <p className="text-sm text-destructive">
                  This Google place is already saved as{" "}
                  <Link
                    href={`/address-book/${conflict.existing_place.id}`}
                    className="underline font-medium"
                    onClick={onClose}
                  >
                    {conflict.existing_place.title}
                  </Link>
                  . Each Google place can only be linked to one address book entry. Please clear this selection or search for a different result.
                </p>
              </div>
              <Button
                size="sm"
                variant="outline"
                className="border-destructive/40 text-destructive hover:bg-destructive/10"
                onClick={() => { setSelected(null); setConflict(null); }}
              >
                Clear selection
              </Button>
            </div>
          )}

          {/* ── Advanced: manual coordinates ── */}
          <div className="border border-border rounded-md overflow-hidden">
            <button
              className="w-full flex items-center justify-between px-3 py-2.5 text-sm font-medium text-muted-foreground hover:bg-accent/50 transition-colors"
              onClick={() => setAdvancedOpen((v) => !v)}
              type="button"
            >
              <span>Advanced: enter coordinates manually</span>
              {advancedOpen ? (
                <ChevronUp className="h-4 w-4" />
              ) : (
                <ChevronDown className="h-4 w-4" />
              )}
            </button>

            {advancedOpen && (
              <div className="px-3 pb-3 pt-1 space-y-3 border-t border-border">
                <div className="grid grid-cols-2 gap-3">
                  <div className="space-y-1.5">
                    <Label htmlFor="ftpm-lat">Latitude</Label>
                    <Input
                      id="ftpm-lat"
                      type="number"
                      step="0.000001"
                      value={manualLat}
                      onChange={(e) => setManualLat(e.target.value)}
                      placeholder="e.g. 25.197525"
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="ftpm-lng">Longitude</Label>
                    <Input
                      id="ftpm-lng"
                      type="number"
                      step="0.000001"
                      value={manualLng}
                      onChange={(e) => setManualLng(e.target.value)}
                      placeholder="e.g. 55.274288"
                    />
                  </div>
                </div>
                {(manualLat.trim() || manualLng.trim()) && !manualValid && (
                  <div className="flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive">
                    <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                    Latitude must be −90 to 90 and longitude must be −180 to 180.
                  </div>
                )}
                <Button
                  size="sm"
                  variant="outline"
                  disabled={!manualValid}
                  onClick={applyManualCoords}
                  className="w-full"
                >
                  <MapPin className="h-3.5 w-3.5 mr-1.5" />
                  Use these coordinates
                </Button>
              </div>
            )}
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={saveMutation.isPending}>
            Cancel
          </Button>
          <Button
            onClick={() => saveMutation.mutate()}
            disabled={!canSave}
            className="bg-green-600 hover:bg-green-700 text-white"
          >
            {saveMutation.isPending ? (
              <>
                <Loader2 className="h-4 w-4 mr-1.5 animate-spin" />
                Saving…
              </>
            ) : (
              "Use this location"
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

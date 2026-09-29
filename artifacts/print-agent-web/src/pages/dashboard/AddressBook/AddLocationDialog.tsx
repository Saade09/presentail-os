/**
 * AddLocationDialog — search-first "Add location" experience for the Address Book.
 *
 * Flow:
 * 1. idle          — search input only
 * 2. loading       — fetching Google details + pre-check after a Google suggestion
 * 3. existing_ps   — Presentail place selected; show record card (no creation)
 * 4. duplicate     — exact Google Place ID match found; offer "Add delivery point"
 * 5. creation      — no duplicate; show full creation form with map
 * 6. dp_form       — "Add delivery point" sub-form
 * 7. manual        — manual-pin / manual-address mode (no Google data)
 */

import { useState, useEffect, useCallback, useRef } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { Link } from "wouter";
import {
  MapPin,
  Building2,
  ExternalLink,
  AlertCircle,
  CheckCircle2,
  Loader2,
  X,
  Plus,
} from "lucide-react";
import { apiFetch, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { GoogleMapsPinMap } from "@/components/GoogleMapsPinMap";
import { getGoogleMapsBrowserKey, isValidGoogleMapsCoordinate, type GoogleMapsLatLngLiteral } from "@/lib/googleMaps";
import { PlaceSearchCombobox, type PresentailPlaceResult, type GoogleSuggestion } from "@/components/PlaceSearchCombobox";
import { AliasChipInput } from "@/components/AliasChipInput";
import { PLACE_TYPE_OPTIONS, type PlaceType } from "@workspace/api-zod/place-types";

// ─── Types ────────────────────────────────────────────────────────────────────

interface CityRow {
  id: number;
  name: string;
  country_code: string;
  country: string;
  is_active: boolean;
}

interface GoogleDetails {
  placeId: string | null;
  displayName: string | null;
  formattedAddress: string | null;
  addressComponents: Array<{
    longText?: string;
    shortText?: string;
    types?: string[];
  }>;
  location: { latitude: number | null; longitude: number | null } | null;
  types: string[];
  primaryType: string | null;
  countryCode?: string | null;
}

interface PreCheckMatch {
  id: string;
  canonical_name: string;
  verification_state: string;
  delivery_count: number;
  match_type: "exact_google_id" | "exact_name" | "alias_match" | "nearby_coordinate";
}

type Phase =
  | "idle"
  | "loading"
  | "existing_ps"
  | "duplicate"
  | "creation"
  | "dp_form"
  | "manual";

interface CreationForm {
  cityId: string;
  placeType: PlaceType;
  entranceNotes: string;
  aliases: string[];
}

interface DpForm {
  name: string;
  entranceNotes: string;
  aliases: string[];
}

const EMPTY_CREATION: CreationForm = {
  cityId: "",
  placeType: "building",
  entranceNotes: "",
  aliases: [],
};

const EMPTY_DP: DpForm = { name: "", entranceNotes: "", aliases: [] };

// ─── Helpers ──────────────────────────────────────────────────────────────────

function staticMapUrl(lat: number, lng: number, key: string): string {
  return (
    `https://maps.googleapis.com/maps/api/staticmap` +
    `?center=${lat},${lng}&zoom=15&size=480x200` +
    `&markers=color:red%7C${lat},${lng}&key=${encodeURIComponent(key)}`
  );
}

function verificationBadgeColor(state: string): string {
  switch (state) {
    case "delivery_verified":
    case "staff_verified":
      return "bg-green-100 text-green-800 border-green-200";
    case "estimated":
      return "bg-amber-100 text-amber-800 border-amber-200";
    default:
      return "";
  }
}

function verificationLabel(state: string): string {
  return state.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

// ─── Sub-components ───────────────────────────────────────────────────────────

/** Card shown when a Presentail record is selected or an exact Google duplicate is found. */
function ExistingPlaceCard({
  placeId,
  name,
  verificationState,
  deliveryCount,
  isExactDuplicate,
  onAddDeliveryPoint,
}: {
  placeId: string;
  name: string;
  verificationState: string;
  deliveryCount: number;
  isExactDuplicate: boolean;
  onAddDeliveryPoint?: () => void;
}) {
  return (
    <div className="rounded-lg border border-border bg-muted/30 p-4 space-y-3">
      {/* Name + state */}
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-center gap-2 min-w-0">
          <Building2 className="h-4 w-4 text-muted-foreground shrink-0" />
          <p className="font-semibold text-sm truncate">{name}</p>
        </div>
        <Badge className="shrink-0 bg-blue-100 text-blue-800 border-blue-200 hover:bg-blue-100">
          Already in Address Book
        </Badge>
      </div>

      {/* Verification */}
      <div className="flex items-center gap-2">
        <CheckCircle2 className="h-3.5 w-3.5 text-muted-foreground" />
        <Badge
          variant="outline"
          className={`text-xs ${verificationBadgeColor(verificationState)}`}
        >
          {verificationLabel(verificationState)}
        </Badge>
        {deliveryCount > 0 && (
          <span className="text-xs text-muted-foreground">
            · {deliveryCount} deliver{deliveryCount === 1 ? "y" : "ies"}
          </span>
        )}
      </div>

      {isExactDuplicate && (
        <p className="text-sm text-muted-foreground flex items-center gap-1.5">
          <AlertCircle className="h-3.5 w-3.5 text-amber-500 shrink-0" />
          This location is already in Presentail OS.
        </p>
      )}

      {/* Actions */}
      <div className="flex items-center gap-2 flex-wrap">
        <Link href={`/address-book/${placeId}`}>
          <Button variant="outline" size="sm" className="gap-1.5" asChild>
            <a>
              <ExternalLink className="h-3.5 w-3.5" />
              View location
            </a>
          </Button>
        </Link>
        {!isExactDuplicate && (
          <Link href={`/address-book/${placeId}`}>
            <Button variant="outline" size="sm" className="gap-1.5" asChild>
              <a>Edit details</a>
            </Button>
          </Link>
        )}
        {isExactDuplicate && onAddDeliveryPoint && (
          <Button variant="default" size="sm" className="gap-1.5" onClick={onAddDeliveryPoint}>
            <Plus className="h-3.5 w-3.5" />
            Add delivery point
          </Button>
        )}
      </div>
    </div>
  );
}

/** Result card shown for a Google-sourced location before creation. */
function GoogleResultCard({
  details,
  coordinates,
  mapsKey,
}: {
  details: GoogleDetails;
  coordinates: GoogleMapsLatLngLiteral | null;
  mapsKey: string;
}) {
  const name = details.displayName ?? "Unnamed location";
  const address = details.formattedAddress ?? "";
  const hasCoords =
    isValidGoogleMapsCoordinate(coordinates) && coordinates !== null;

  return (
    <div className="rounded-lg border border-border bg-background overflow-hidden">
      {/* Static map thumbnail */}
      {hasCoords && mapsKey ? (
        <img
          src={staticMapUrl(coordinates.lat, coordinates.lng, mapsKey)}
          alt={`Map of ${name}`}
          className="w-full h-28 object-cover"
          onError={(e) => {
            (e.target as HTMLImageElement).style.display = "none";
          }}
        />
      ) : hasCoords ? (
        <div className="w-full h-16 bg-muted flex items-center justify-center text-xs text-muted-foreground font-mono">
          {coordinates.lat.toFixed(6)}, {coordinates.lng.toFixed(6)}
        </div>
      ) : null}

      {/* Info */}
      <div className="px-4 py-3 space-y-1">
        <div className="flex items-start justify-between gap-2">
          <p className="font-semibold text-sm leading-snug">{name}</p>
          <Badge variant="outline" className="shrink-0 text-[10px] border-blue-300 text-blue-600">
            From Google
          </Badge>
        </div>
        {address && <p className="text-xs text-muted-foreground">{address}</p>}
        {details.primaryType && (
          <p className="text-xs text-muted-foreground capitalize">
            {details.primaryType.replace(/_/g, " ")}
          </p>
        )}
      </div>
    </div>
  );
}

/** Delivery point creation sub-form. */
function DeliveryPointForm({
  parentId,
  parentName,
  onSuccess,
  onCancel,
}: {
  parentId: string;
  parentName: string;
  onSuccess: () => void;
  onCancel: () => void;
}) {
  const { toast } = useToast();
  const [form, setForm] = useState<DpForm>(EMPTY_DP);

  const { mutate, isPending } = useMutation({
    mutationFn: () =>
      apiFetch(`/api/address-book/places/${parentId}/delivery-points`, {
        method: "POST",
        body: JSON.stringify({
          canonical_name: form.name.trim(),
          entrance_notes: form.entranceNotes.trim() || null,
          aliases: form.aliases,
        }),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["address-book-places"] });
      toast({ title: "Delivery point added", description: `Added under ${parentName}.` });
      onSuccess();
    },
    onError: () => {
      toast({ title: "Failed to add delivery point", variant: "destructive" });
    },
  });

  return (
    <div className="space-y-4">
      <div className="rounded-md bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
        Adding a delivery point under <strong className="text-foreground">{parentName}</strong>
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="dp-name">Delivery point name *</Label>
        <Input
          id="dp-name"
          placeholder="e.g. Tower B Entrance, Parking Level 2"
          value={form.name}
          onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
        />
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="dp-notes">Entrance / delivery instructions</Label>
        <Textarea
          id="dp-notes"
          placeholder="E.g. Use gate B, ring the bell twice"
          rows={2}
          value={form.entranceNotes}
          onChange={(e) => setForm((f) => ({ ...f, entranceNotes: e.target.value }))}
        />
      </div>

      <div className="space-y-1.5">
        <Label>Aliases</Label>
        <AliasChipInput
          aliases={form.aliases}
          onChange={(aliases) => setForm((f) => ({ ...f, aliases }))}
          placeholder="Add an alias and press Enter"
        />
      </div>

      <div className="flex gap-2 justify-end pt-1">
        <Button variant="outline" onClick={onCancel} disabled={isPending}>
          Cancel
        </Button>
        <Button onClick={() => mutate()} disabled={!form.name.trim() || isPending}>
          {isPending ? (
            <>
              <Loader2 className="h-4 w-4 mr-1.5 animate-spin" />
              Adding…
            </>
          ) : (
            "Add delivery point"
          )}
        </Button>
      </div>
    </div>
  );
}

// ─── Main dialog ──────────────────────────────────────────────────────────────

interface AddLocationDialogProps {
  open: boolean;
  onClose: () => void;
}

export function AddLocationDialog({ open, onClose }: AddLocationDialogProps) {
  const { toast } = useToast();
  const mapsKey = getGoogleMapsBrowserKey();

  // Phase state machine
  const [phase, setPhase] = useState<Phase>("idle");

  // Selections
  const [selectedPresentail, setSelectedPresentail] = useState<PresentailPlaceResult | null>(null);
  const [googleDetails, setGoogleDetails] = useState<GoogleDetails | null>(null);
  const [preCheckMatches, setPreCheckMatches] = useState<PreCheckMatch[]>([]);
  const [isManualMode, setIsManualMode] = useState(false);
  const [selectionError, setSelectionError] = useState<string | null>(null);

  // Creation form
  const [form, setForm] = useState<CreationForm>(EMPTY_CREATION);
  const [pinCoordinate, setPinCoordinate] = useState<GoogleMapsLatLngLiteral | null>(null);

  // Pin re-check debounce
  const pinCheckTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Field-level errors
  const [errors, setErrors] = useState<{ cityId?: string; placeType?: string }>({});

  // Duplicate record found (for exact_google_id match — top match in pre-check)
  const exactDuplicate = preCheckMatches.find((m) => m.match_type === "exact_google_id") ?? null;

  // Nearby warning (matches that are not exact Google ID)
  const nearbyWarnings = preCheckMatches.filter((m) => m.match_type !== "exact_google_id");

  // Cities query
  const { data: citiesData } = useQuery<{ cities: CityRow[]; countries: string[] }>({
    queryKey: ["/api/cities"],
    queryFn: () => apiFetch("/api/cities"),
    staleTime: 5 * 60 * 1000,
  });

  const cities = citiesData?.cities ?? [];
  const lebaneseCities = cities.filter(
    (city) => city.is_active && city.country_code.trim().toUpperCase() === "LB",
  );

  // Reset all state when dialog opens/closes
  useEffect(() => {
    if (!open) {
      setPhase("idle");
      setSelectedPresentail(null);
      setGoogleDetails(null);
      setPreCheckMatches([]);
      setIsManualMode(false);
      setForm(EMPTY_CREATION);
      setPinCoordinate(null);
      setErrors({});
      setSelectionError(null);
    }
  }, [open]);

  // ── Handlers ─────────────────────────────────────────────────────────────────

  function handleSelectPresentail(place: PresentailPlaceResult) {
    setSelectedPresentail(place);
    setGoogleDetails(null);
    setPreCheckMatches([]);
    setSelectionError(null);
    setPhase("existing_ps");
  }

  async function handleSelectGoogle(suggestion: GoogleSuggestion) {
    // Fallback: manual modes
    if (
      suggestion.placeId === "__manual_pin__" ||
      suggestion.placeId === "__manual_address__"
    ) {
      setIsManualMode(true);
      setGoogleDetails(null);
      setPreCheckMatches([]);
      setForm(EMPTY_CREATION);
      setPinCoordinate(null);
      setSelectionError(null);
      setPhase("manual");
      return;
    }

    setPhase("loading");
    setSelectedPresentail(null);
    setSelectionError(null);

    try {
      // 1. Fetch Google details
      const details = await apiFetch<GoogleDetails>(
        `/api/address-book/places/google-details?placeId=${encodeURIComponent(suggestion.placeId)}`,
      );

      const countryComponent = (details.addressComponents ?? []).find((component) =>
        component.types?.includes("country"),
      );
      const countryCode =
        details.countryCode?.trim().toUpperCase() ??
        countryComponent?.shortText?.trim().toUpperCase() ??
        null;
      if (countryCode !== "LB") {
        setGoogleDetails(null);
        setPreCheckMatches([]);
        setPinCoordinate(null);
        setPhase("idle");
        setSelectionError(
          countryCode
            ? "Only locations in Lebanon can be added to the Address Book. Choose a Lebanese Google result."
            : "Google could not verify this location’s country. Choose a Lebanese result or enter the address manually.",
        );
        return;
      }

      setGoogleDetails(details);

      const lat = details.location?.latitude ?? null;
      const lng = details.location?.longitude ?? null;
      const coords: GoogleMapsLatLngLiteral | null =
        lat !== null && lng !== null ? { lat, lng } : null;
      setPinCoordinate(coords);

      // 2. Pre-check for duplicates
      const matches = await runPreCheck({
        google_place_id: suggestion.placeId,
        name: details.displayName ?? undefined,
        lat: lat ?? undefined,
        lng: lng ?? undefined,
      });
      setPreCheckMatches(matches);

      const hasExactDuplicate = matches.some((m) => m.match_type === "exact_google_id");
      setPhase(hasExactDuplicate ? "duplicate" : "creation");
    } catch {
      toast({
        title: "Could not load location details",
        description: "Please try again or enter the address manually.",
        variant: "destructive",
      });
      setSelectionError(null);
      setPhase("idle");
    }
  }

  async function runPreCheck(body: {
    google_place_id?: string;
    name?: string;
    lat?: number;
    lng?: number;
    proximity_m?: number;
  }): Promise<PreCheckMatch[]> {
    try {
      const res = await apiFetch<{ matches: PreCheckMatch[] }>(
        "/api/address-book/places/pre-check",
        { method: "POST", body: JSON.stringify(body) },
      );
      return res.matches ?? [];
    } catch {
      return [];
    }
  }

  // Re-run pre-check when pin is dragged (debounced)
  const handlePinChange = useCallback(
    (coord: GoogleMapsLatLngLiteral) => {
      setPinCoordinate(coord);
      if (pinCheckTimerRef.current) clearTimeout(pinCheckTimerRef.current);
      pinCheckTimerRef.current = setTimeout(async () => {
        const matches = await runPreCheck({
          google_place_id: googleDetails?.placeId ?? undefined,
          lat: coord.lat,
          lng: coord.lng,
        });
        setPreCheckMatches(matches);
        const hasExact = matches.some((m) => m.match_type === "exact_google_id");
        if (hasExact) setPhase("duplicate");
      }, 600);
    },
    [googleDetails],
  );

  // ── Submission ────────────────────────────────────────────────────────────────

  const { mutate: submitCreate, isPending: isSubmitting } = useMutation({
    mutationFn: () => {
      const isGoogle = googleDetails !== null && !isManualMode;
      const lat = pinCoordinate?.lat ?? null;
      const lng = pinCoordinate?.lng ?? null;

      const body: Record<string, unknown> = {
        canonical_name: (googleDetails?.displayName ?? "").trim() || "Unnamed location",
        place_type: form.placeType,
        city_id: form.cityId ? Number(form.cityId) : null,
        entrance_notes: form.entranceNotes.trim() || null,
        aliases: form.aliases,
        latitude: lat,
        longitude: lng,
      };

      if (isGoogle && googleDetails) {
        body.google_place_id = googleDetails.placeId;
        body.google_formatted_address = googleDetails.formattedAddress;
        body.google_place_type = googleDetails.primaryType;
        body.google_original_lat = googleDetails.location?.latitude ?? null;
        body.google_original_lng = googleDetails.location?.longitude ?? null;

        // Extract country and city from address components
        const components = googleDetails.addressComponents ?? [];
        const countryComp = components.find((c) => c.types?.includes("country"));
        const cityComp = components.find(
          (c) =>
            c.types?.includes("locality") ||
            c.types?.includes("administrative_area_level_1"),
        );
        body.google_country =
          countryComp?.shortText ?? googleDetails.countryCode ?? countryComp?.longText ?? null;
        body.google_city = cityComp?.longText ?? null;
      }

      return apiFetch("/api/address-book/places", {
        method: "POST",
        body: JSON.stringify(body),
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["address-book-places"] });
      toast({
        title: "Location added",
        description: `${googleDetails?.displayName ?? "Location"} has been added to the address book.`,
      });
      onClose();
    },
    onError: (err: unknown) => {
      const message = (err as { message?: string }).message ?? "Failed to add location";
      toast({ title: message, variant: "destructive" });
    },
  });

  function handleSubmitCreate() {
    const newErrors: typeof errors = {};
    if (!form.cityId) newErrors.cityId = "District is required";
    if (!form.placeType) newErrors.placeType = "Type is required";
    setErrors(newErrors);
    if (Object.keys(newErrors).length > 0) return;

    if (!pinCoordinate && phase === "creation") {
      toast({
        title: "Pin location required",
        description: "Please drag the map pin to confirm the location before saving.",
        variant: "destructive",
      });
      return;
    }

    submitCreate();
  }

  // ── Derived coords for map ────────────────────────────────────────────────────

  const mapCenter: GoogleMapsLatLngLiteral | null =
    pinCoordinate ??
    (googleDetails?.location?.latitude != null &&
    googleDetails?.location?.longitude != null
      ? {
          lat: googleDetails.location.latitude,
          lng: googleDetails.location.longitude,
        }
      : null);

  const hasPin = isValidGoogleMapsCoordinate(pinCoordinate);

  // ── Render ────────────────────────────────────────────────────────────────────

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-w-2xl w-full max-h-[90vh] flex flex-col">
        <DialogHeader className="shrink-0">
          <DialogTitle className="flex items-center gap-2">
            <MapPin className="h-5 w-5" />
            Add location
          </DialogTitle>
        </DialogHeader>

        {/* Keep search outside the scroll container so its results can expand
            over the rest of the dialog without being clipped. */}
        {phase !== "dp_form" && (
          <div className="relative z-50 shrink-0 bg-background pt-1">
            <p className="mb-2 text-xs text-muted-foreground">
              Address Book locations can only be added in Lebanon.
            </p>
            <PlaceSearchCombobox
              onSelectPresentail={handleSelectPresentail}
              onSelectGoogle={handleSelectGoogle}
              countryCode="LB"
              disabled={isSubmitting}
            />
          </div>
        )}

        <div className="min-h-0 flex-1 overflow-y-auto">
          <div className="space-y-5 py-1">
          {selectionError && (
            <div
              role="alert"
              className="flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2.5 text-sm text-destructive"
            >
              <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
              <span>{selectionError}</span>
            </div>
          )}
          {/* Loading indicator */}
          {phase === "loading" && (
            <div className="flex items-center gap-3 text-sm text-muted-foreground py-4 justify-center">
              <Loader2 className="h-4 w-4 animate-spin" />
              Looking up location details…
            </div>
          )}

          {/* Existing Presentail place selected */}
          {phase === "existing_ps" && selectedPresentail && (
            <ExistingPlaceCard
              placeId={selectedPresentail.id}
              name={selectedPresentail.canonical_name}
              verificationState={selectedPresentail.verification_state}
              deliveryCount={0}
              isExactDuplicate={false}
            />
          )}

          {/* Exact Google duplicate found */}
          {phase === "duplicate" && exactDuplicate && (
            <ExistingPlaceCard
              placeId={exactDuplicate.id}
              name={exactDuplicate.canonical_name}
              verificationState={exactDuplicate.verification_state}
              deliveryCount={exactDuplicate.delivery_count}
              isExactDuplicate={true}
              onAddDeliveryPoint={() => setPhase("dp_form")}
            />
          )}

          {/* Delivery point sub-form */}
          {phase === "dp_form" && exactDuplicate && (
            <>
              <div className="flex items-center gap-2 mb-1">
                <button
                  type="button"
                  className="text-sm text-muted-foreground hover:text-foreground flex items-center gap-1.5 focus:outline-none focus:underline"
                  onClick={() => setPhase("duplicate")}
                >
                  <X className="h-3.5 w-3.5" />
                  Back
                </button>
              </div>
              <DeliveryPointForm
                parentId={exactDuplicate.id}
                parentName={exactDuplicate.canonical_name}
                onSuccess={onClose}
                onCancel={() => setPhase("duplicate")}
              />
            </>
          )}

          {/* Creation form (Google-sourced or manual) */}
          {(phase === "creation" || phase === "manual") && (
            <>
              {/* Google result card */}
              {phase === "creation" && googleDetails && (
                <GoogleResultCard
                  details={googleDetails}
                  coordinates={mapCenter}
                  mapsKey={mapsKey}
                />
              )}

              {/* Nearby-match warning (non-blocking) */}
              {nearbyWarnings.length > 0 && (
                <div className="flex items-start gap-2 rounded-md bg-amber-50 border border-amber-200 px-3 py-2.5 text-sm text-amber-800">
                  <AlertCircle className="h-4 w-4 mt-0.5 shrink-0" />
                  <span>
                    A similar place named{" "}
                    <strong>{nearbyWarnings[0].canonical_name}</strong> already
                    exists. Review before adding to avoid duplicates.
                  </span>
                </div>
              )}

              {/* Delivery details */}
              <div className="space-y-3">
                <p className="text-sm font-semibold">Delivery details</p>
                <div className="grid grid-cols-2 gap-3">
                  {/* District (city_id) */}
                  <div className="space-y-1.5">
                    <Label htmlFor="loc-district">
                      District <span className="text-destructive">*</span>
                    </Label>
                    <Select
                      value={form.cityId}
                      onValueChange={(v) => {
                        setForm((f) => ({ ...f, cityId: v }));
                        setErrors((e) => ({ ...e, cityId: undefined }));
                      }}
                    >
                      <SelectTrigger
                        id="loc-district"
                        className={errors.cityId ? "border-destructive" : ""}
                        aria-label="Select district"
                      >
                        <SelectValue placeholder="Select district" />
                      </SelectTrigger>
                      <SelectContent>
                        {lebaneseCities.map((city) => (
                          <SelectItem key={city.id} value={String(city.id)}>
                            {city.name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    {errors.cityId && (
                      <p className="text-xs text-destructive">{errors.cityId}</p>
                    )}
                  </div>

                  {/* Place type */}
                  <div className="space-y-1.5">
                    <Label>
                      Type <span className="text-destructive">*</span>
                    </Label>
                    <Select
                      value={form.placeType}
                      onValueChange={(v) => {
                        setForm((f) => ({ ...f, placeType: v as PlaceType }));
                        setErrors((e) => ({ ...e, placeType: undefined }));
                      }}
                    >
                      <SelectTrigger
                        className={errors.placeType ? "border-destructive" : ""}
                        aria-label="Select place type"
                      >
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {PLACE_TYPE_OPTIONS.map(({ value, label }) => (
                          <SelectItem key={value} value={value}>
                            {label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    {errors.placeType && (
                      <p className="text-xs text-destructive">{errors.placeType}</p>
                    )}
                  </div>
                </div>
              </div>

              {/* Entrance / delivery instructions */}
              <div className="space-y-1.5">
                <Label htmlFor="loc-notes">Entrance / delivery instructions</Label>
                <Textarea
                  id="loc-notes"
                  placeholder="E.g. Use gate B, 3rd floor, ring bell twice"
                  rows={2}
                  value={form.entranceNotes}
                  onChange={(e) => setForm((f) => ({ ...f, entranceNotes: e.target.value }))}
                />
              </div>

              {/* Aliases */}
              <div className="space-y-1.5">
                <Label>Aliases</Label>
                <p className="text-xs text-muted-foreground">
                  Alternative names for this location. Press Enter or comma to add each.
                </p>
                <AliasChipInput
                  aliases={form.aliases}
                  onChange={(aliases) => setForm((f) => ({ ...f, aliases }))}
                  placeholder="Add an alias and press Enter"
                />
              </div>

              {/* Map preview */}
              <div className="space-y-1.5">
                <Label>Map pin</Label>
                {mapCenter ? (
                  <>
                    <GoogleMapsPinMap
                      center={mapCenter}
                      value={pinCoordinate}
                      onChange={handlePinChange}
                      interactive={true}
                      className="h-52"
                    />
                    {!hasPin && (
                      <p className="text-xs text-amber-600 flex items-center gap-1.5">
                        <AlertCircle className="h-3.5 w-3.5 shrink-0" />
                        Click the map or drag the pin to confirm the location. This is required.
                      </p>
                    )}
                  </>
                ) : (
                  <div className="h-36 rounded-lg border border-dashed border-border bg-muted flex flex-col items-center justify-center gap-2 text-muted-foreground">
                    <MapPin className="h-7 w-7 opacity-30" />
                    <p className="text-sm font-medium">No coordinates available</p>
                    <p className="text-xs text-center max-w-xs">
                      Coordinates could not be determined. You can still save — coordinates can be
                      added later on the location detail page.
                    </p>
                  </div>
                )}
              </div>
            </>
          )}
          </div>
        </div>

        {/* Footer */}
        {phase !== "dp_form" && (
          <DialogFooter className="shrink-0 gap-2 pt-4">
            <Button variant="outline" onClick={onClose} disabled={isSubmitting}>
              Cancel
            </Button>
            {(phase === "creation" || phase === "manual") && (
              <Button
                onClick={handleSubmitCreate}
                disabled={!form.cityId || !form.placeType || isSubmitting}
              >
                {isSubmitting ? (
                  <>
                    <Loader2 className="h-4 w-4 mr-1.5 animate-spin" />
                    Adding…
                  </>
                ) : (
                  "Add location"
                )}
              </Button>
            )}
          </DialogFooter>
        )}
      </DialogContent>
    </Dialog>
  );
}

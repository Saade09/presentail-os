import { useState, useRef, useEffect, useCallback } from "react";
import { Search, Loader2, Building2, MapPin } from "lucide-react";
import { apiFetch } from "@/lib/queryClient";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface PresentailPlaceResult {
  id: string;
  canonical_name: string;
  place_type: string;
  area: string | null;
  city_name: string | null;
  canonical_address: string | null;
  verification_state: string;
}

export interface GoogleSuggestion {
  placeId: string;
  displayName: string;
  formattedAddress: string;
  types: string[];
}

interface Props {
  onSelectPresentail: (place: PresentailPlaceResult) => void;
  onSelectGoogle: (suggestion: GoogleSuggestion) => void;
  /** ISO country code used by the server-side autocomplete restriction. */
  countryCode?: string | null;
  disabled?: boolean;
  defaultQuery?: string;
}

// ─── Component ────────────────────────────────────────────────────────────────

export function PlaceSearchCombobox({
  onSelectPresentail,
  onSelectGoogle,
  countryCode,
  disabled,
  defaultQuery = "",
}: Props) {
  const [query, setQuery] = useState(defaultQuery);
  const [presentailResults, setPresentailResults] = useState<PresentailPlaceResult[]>([]);
  const [googleResults, setGoogleResults] = useState<GoogleSuggestion[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [googleUnavailable, setGoogleUnavailable] = useState(false);
  const [isOpen, setIsOpen] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  const search = useCallback(
    async (q: string) => {
      if (!q.trim()) {
        setPresentailResults([]);
        setGoogleResults([]);
        setIsOpen(false);
        setIsLoading(false);
        return;
      }

      setGoogleUnavailable(false);
      setIsLoading(true);
      try {
        // 1. Presentail records first
        const presentailRes = await apiFetch<{ places: PresentailPlaceResult[] }>(
          `/api/address-book/places?q=${encodeURIComponent(q)}&limit=5`,
        ).catch(() => ({ places: [] as PresentailPlaceResult[] }));
        setPresentailResults(presentailRes.places ?? []);

        // 2. Google autocomplete
        const googleUrl =
          `/api/address-book/places/google-autocomplete?q=${encodeURIComponent(q)}` +
          (countryCode ? `&countryCode=${encodeURIComponent(countryCode)}` : "");
        try {
          const googleRes = await apiFetch<{ suggestions: GoogleSuggestion[] }>(googleUrl);
          // Real successful response — clear any prior unavailable state
          setGoogleUnavailable(false);
          setGoogleResults(googleRes.suggestions ?? []);
        } catch (err: unknown) {
          const status = (err as { status?: number }).status;
          if (status === 503 || status === 502) setGoogleUnavailable(true);
          setGoogleResults([]);
        }

        setIsOpen(true);
      } finally {
        setIsLoading(false);
      }
    },
    [countryCode],
  );

  // Debounce
  useEffect(() => {
    if (timerRef.current) clearTimeout(timerRef.current);
    if (!query.trim()) {
      setPresentailResults([]);
      setGoogleResults([]);
      setIsOpen(false);
      setIsLoading(false);
      return;
    }
    setIsLoading(true);
    timerRef.current = setTimeout(() => search(query), 300);
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [query, search]);

  // Close dropdown on outside click
  useEffect(() => {
    function handler(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setIsOpen(false);
      }
    }
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  const hasResults = presentailResults.length > 0 || googleResults.length > 0;
  const showFallback = isOpen && !isLoading && !hasResults && query.trim().length >= 2;

  function handleSelectPresentail(place: PresentailPlaceResult) {
    setQuery(place.canonical_name);
    setIsOpen(false);
    onSelectPresentail(place);
  }

  function handleSelectGoogle(s: GoogleSuggestion) {
    setQuery(s.displayName);
    setIsOpen(false);
    onSelectGoogle(s);
  }

  function handleManualPin() {
    setIsOpen(false);
    onSelectGoogle({ placeId: "__manual_pin__", displayName: query, formattedAddress: "", types: [] });
  }

  function handleManualAddress() {
    setIsOpen(false);
    onSelectGoogle({
      placeId: "__manual_address__",
      displayName: query,
      formattedAddress: "",
      types: [],
    });
  }

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
          onFocus={() => {
            if (hasResults) setIsOpen(true);
          }}
          placeholder="Search by landmark, building or address"
          className="pl-9 pr-9"
          aria-label="Search by landmark, building or address"
          aria-autocomplete="list"
          aria-expanded={isOpen}
          aria-haspopup="listbox"
          disabled={disabled}
          autoComplete="off"
        />
      </div>

      {isOpen && (
        <div
          className="absolute z-50 mt-1 w-full rounded-md border border-border bg-background shadow-lg overflow-hidden"
          role="listbox"
          aria-label="Location search results"
        >
          {googleUnavailable && (
            <div className="px-3 py-2 text-xs text-amber-700 bg-amber-50 border-b border-amber-100">
              Google Places is temporarily unavailable. Showing Presentail records only.
            </div>
          )}

          {/* Presentail results */}
          {presentailResults.length > 0 && (
            <div>
              <div className="px-3 py-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground bg-muted/50">
                In Presentail OS
              </div>
              {presentailResults.map((place) => (
                <button
                  key={place.id}
                  role="option"
                  aria-selected="false"
                  className="w-full flex items-start gap-3 px-3 py-2.5 text-left hover:bg-accent transition-colors focus:outline-none focus:bg-accent"
                  onClick={() => handleSelectPresentail(place)}
                >
                  <Building2 className="h-4 w-4 text-primary mt-0.5 shrink-0" />
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium truncate">{place.canonical_name}</p>
                    <p className="text-xs text-muted-foreground truncate">
                      {[place.city_name, place.area, place.canonical_address]
                        .filter(Boolean)
                        .join(" · ")}
                    </p>
                  </div>
                  <Badge
                    variant="outline"
                    className="shrink-0 text-[10px] border-primary/40 text-primary/70"
                  >
                    Presentail
                  </Badge>
                </button>
              ))}
            </div>
          )}

          {/* Google results */}
          {googleResults.length > 0 && (
            <div>
              <div
                className={`px-3 py-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground bg-muted/50 ${presentailResults.length > 0 ? "border-t" : ""}`}
              >
                Google Places
              </div>
              {googleResults.map((s) => (
                <button
                  key={s.placeId}
                  role="option"
                  aria-selected="false"
                  className="w-full flex items-start gap-3 px-3 py-2.5 text-left hover:bg-accent transition-colors focus:outline-none focus:bg-accent"
                  onClick={() => handleSelectGoogle(s)}
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
              ))}
            </div>
          )}

          {/* No-results fallback */}
          {showFallback && (
            <div>
              <div className="px-3 py-2 text-xs text-muted-foreground bg-muted/50">
                No results found. Try one of these options:
              </div>
              <button
                role="option"
                aria-selected="false"
                className="w-full flex items-center gap-3 px-3 py-2.5 text-left hover:bg-accent transition-colors focus:outline-none focus:bg-accent"
                onClick={handleManualPin}
              >
                <MapPin className="h-4 w-4 text-muted-foreground shrink-0" />
                <div>
                  <p className="text-sm font-medium">Pin location manually</p>
                  <p className="text-xs text-muted-foreground">Drag the map pin to set coordinates</p>
                </div>
              </button>
              <button
                role="option"
                aria-selected="false"
                className="w-full flex items-center gap-3 px-3 py-2.5 text-left hover:bg-accent transition-colors focus:outline-none focus:bg-accent border-t"
                onClick={handleManualAddress}
              >
                <Building2 className="h-4 w-4 text-muted-foreground shrink-0" />
                <div>
                  <p className="text-sm font-medium">Enter address manually</p>
                  <p className="text-xs text-muted-foreground">
                    Type the address and district directly
                  </p>
                </div>
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

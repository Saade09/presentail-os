import { useEffect, useRef, useState } from "react";
import {
  GoogleMapsApi,
  GoogleMapsLatLngLiteral,
  GoogleMapEvent,
  GoogleMapInstance,
  GoogleMarkerInstance,
  loadGoogleMaps,
  isValidGoogleMapsCoordinate,
} from "@/lib/googleMaps";
import { ExternalLink, MapPin, RefreshCw } from "lucide-react";

type Props = {
  center: GoogleMapsLatLngLiteral;
  value: GoogleMapsLatLngLiteral | null;
  onChange?: (coordinate: GoogleMapsLatLngLiteral) => void;
  interactive?: boolean;
  externalUrl?: string;
  className?: string;
};

type MapStatus = "loading" | "ready" | "unavailable";

function coordinateText(coordinate: GoogleMapsLatLngLiteral): string {
  return `${coordinate.lat.toFixed(6)}, ${coordinate.lng.toFixed(6)}`;
}

export function GoogleMapsPinMap({
  center,
  value,
  onChange,
  interactive = false,
  externalUrl,
  className = "h-56",
}: Props) {
  const mapElementRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<GoogleMapInstance | null>(null);
  const markerRef = useRef<GoogleMarkerInstance | null>(null);
  const listenersRef = useRef<GoogleMapEvent[]>([]);
  const onChangeRef = useRef(onChange);
  const [mapsApi, setMapsApi] = useState<GoogleMapsApi | null>(null);
  const [status, setStatus] = useState<MapStatus>("loading");
  const [errorMessage, setErrorMessage] = useState("Google Maps is unavailable.");

  onChangeRef.current = onChange;
  const hasValidCenter = isValidGoogleMapsCoordinate(center);
  const hasValidValue = isValidGoogleMapsCoordinate(value);

  useEffect(() => {
    let cancelled = false;
    if (!hasValidCenter) {
      setStatus("unavailable");
      setErrorMessage("The saved coordinates are invalid.");
      return () => {
        cancelled = true;
      };
    }

    setStatus("loading");
    loadGoogleMaps()
      .then((api) => {
        if (!cancelled) {
          setMapsApi(api);
          setStatus("ready");
        }
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setStatus("unavailable");
          setErrorMessage(error instanceof Error ? error.message : "Google Maps is unavailable.");
        }
      });

    return () => {
      cancelled = true;
    };
  }, [hasValidCenter]);

  useEffect(() => {
    if (!mapsApi || !mapElementRef.current || !hasValidCenter) return;

    const mapCenter = { lat: center.lat, lng: center.lng };
    if (!mapRef.current) {
      const map = new mapsApi.maps.Map(mapElementRef.current, {
        center: mapCenter,
        zoom: 16,
        mapTypeControl: false,
        streetViewControl: false,
        fullscreenControl: false,
        gestureHandling: interactive ? "greedy" : "cooperative",
      });
      mapRef.current = map;

      if (interactive) {
        listenersRef.current.push(
          map.addListener("click", (event) => {
            if (!event.latLng) return;
            const coordinate = { lat: event.latLng.lat(), lng: event.latLng.lng() };
            if (isValidGoogleMapsCoordinate(coordinate)) onChangeRef.current?.(coordinate);
          }),
        );
      }
    } else {
      mapRef.current.setCenter(mapCenter);
    }

    if (hasValidValue) {
      const markerPosition = { lat: value.lat, lng: value.lng };
      if (!markerRef.current) {
        const marker = new mapsApi.maps.Marker({
          map: mapRef.current,
          position: markerPosition,
          draggable: interactive,
          title: interactive ? "Drag to choose the location" : "Saved place location",
        });
        markerRef.current = marker;
        if (interactive) {
          listenersRef.current.push(
            marker.addListener("dragend", () => {
              const position = marker.getPosition();
              if (!position) return;
              const coordinate = { lat: position.lat(), lng: position.lng() };
              if (isValidGoogleMapsCoordinate(coordinate)) onChangeRef.current?.(coordinate);
            }),
          );
        }
      } else {
        markerRef.current.setPosition(markerPosition);
      }
    } else if (markerRef.current) {
      markerRef.current.setMap(null);
      markerRef.current = null;
    }

    return () => {
      // Map and marker instances are kept while this component is mounted so
      // draft coordinate changes do not recreate the Google map.
    };
  }, [
    mapsApi,
    center.lat,
    center.lng,
    value?.lat,
    value?.lng,
    hasValidCenter,
    hasValidValue,
    interactive,
  ]);

  useEffect(
    () => () => {
      listenersRef.current.forEach((listener) => listener.remove());
      listenersRef.current = [];
      markerRef.current?.setMap(null);
      markerRef.current = null;
      mapRef.current = null;
    },
    [],
  );

  if (status === "loading") {
    return (
      <div className={`relative flex ${className} w-full items-center justify-center rounded-lg border border-border bg-muted text-muted-foreground`} data-testid="google-map-loading">
        <div className="flex items-center gap-2 text-sm">
          <RefreshCw className="h-4 w-4 animate-spin" />
          Loading Google Maps…
        </div>
      </div>
    );
  }

  if (status === "unavailable") {
    return (
      <div className={`relative flex ${className} w-full flex-col items-center justify-center gap-2 rounded-lg border border-border bg-muted px-4 text-center text-muted-foreground`} data-testid="google-map-fallback">
        <MapPin className="h-8 w-8 opacity-30" />
        <p className="text-sm font-medium text-foreground">Google Maps is unavailable</p>
        <p className="max-w-md text-xs">{errorMessage.replace(/^Google Maps unavailable:\s*/i, "")}</p>
        {hasValidValue && (
          <p className="font-mono text-xs">{coordinateText(value)}</p>
        )}
        {externalUrl && (
          <a
            href={externalUrl}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1 text-xs font-medium text-primary hover:underline"
          >
            Open in Google Maps <ExternalLink className="h-3 w-3" />
          </a>
        )}
      </div>
    );
  }

  return (
    <div className={`relative ${className} w-full overflow-hidden rounded-lg border border-border`} data-testid="google-map">
      <div ref={mapElementRef} className="absolute inset-0" aria-label="Google map showing place location" />
      {interactive && (
        <div className="pointer-events-none absolute left-2 top-2 rounded bg-background/90 px-2 py-1 text-[11px] text-muted-foreground shadow-sm">
          Click the map or drag the pin to choose a location
        </div>
      )}
    </div>
  );
}
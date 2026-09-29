/**
 * Small, dependency-free loader for the Google Maps JavaScript API.
 *
 * The browser key is intentionally read from Vite's public env namespace. A
 * missing key is a normal unavailable state, not a startup error: the
 * Address Book can still show coordinates and its external Maps link.
 */

export interface GoogleLatLng {
  lat(): number;
  lng(): number;
}

export interface GoogleMapEvent {
  remove(): void;
}

export interface GoogleMapInstance {
  setCenter(center: GoogleMapsLatLngLiteral): void;
  addListener(eventName: string, handler: (event: { latLng: GoogleLatLng }) => void): GoogleMapEvent;
}

export interface GoogleMarkerInstance {
  setPosition(position: GoogleMapsLatLngLiteral): void;
  setMap(map: GoogleMapInstance | null): void;
  addListener(eventName: string, handler: () => void): GoogleMapEvent;
  getPosition(): GoogleLatLng | null;
}

export interface GoogleMapsApi {
  maps: {
    Map: new (
      element: HTMLElement,
      options: {
        center: GoogleMapsLatLngLiteral;
        zoom: number;
        mapTypeControl?: boolean;
        streetViewControl?: boolean;
        fullscreenControl?: boolean;
        gestureHandling?: "cooperative" | "greedy";
      },
    ) => GoogleMapInstance;
    Marker: new (options: {
      map: GoogleMapInstance;
      position: GoogleMapsLatLngLiteral;
      draggable?: boolean;
      title?: string;
    }) => GoogleMarkerInstance;
  };
}

export interface GoogleMapsLatLngLiteral {
  lat: number;
  lng: number;
}

declare global {
  interface Window {
    google?: GoogleMapsApi;
  }
}

const SCRIPT_ID = "presentail-google-maps-js";
const CALLBACK_NAME = "__presentailGoogleMapsReady";
let loaderPromise: Promise<GoogleMapsApi> | null = null;

export function getGoogleMapsBrowserKey(): string {
  return (import.meta.env.VITE_GOOGLE_MAPS_BROWSER_KEY as string | undefined)?.trim() ?? "";
}

function unavailable(message: string): Error {
  return new Error(`Google Maps unavailable: ${message}`);
}

/**
 * Loads Google Maps once per browser session. The script callback is used in
 * addition to onload because Google may finish executing the API just after
 * the script element's load event.
 */
export function loadGoogleMaps(): Promise<GoogleMapsApi> {
  if (loaderPromise) return loaderPromise;

  const key = getGoogleMapsBrowserKey();
  if (!key) {
    loaderPromise = Promise.reject(unavailable("browser key is not configured"));
    return loaderPromise;
  }

  loaderPromise = new Promise<GoogleMapsApi>((resolve, reject) => {
    const callbackWindow = window as unknown as Record<string, unknown>;
    const finish = () => {
      if (window.google?.maps) {
        delete callbackWindow[CALLBACK_NAME];
        resolve(window.google);
      } else {
        delete callbackWindow[CALLBACK_NAME];
        reject(unavailable("the API did not initialize"));
      }
    };
    const fail = () => {
      delete callbackWindow[CALLBACK_NAME];
      reject(unavailable("the API script could not be loaded"));
    };

    if (window.google?.maps) {
      resolve(window.google);
      return;
    }

    callbackWindow[CALLBACK_NAME] = finish;
    const existing = document.getElementById(SCRIPT_ID) as HTMLScriptElement | null;
    if (existing) {
      existing.addEventListener("load", finish, { once: true });
      existing.addEventListener("error", fail, { once: true });
      return;
    }

    const script = document.createElement("script");
    script.id = SCRIPT_ID;
    script.async = true;
    script.defer = true;
    script.src =
      `https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(key)}` +
      `&loading=async&callback=${CALLBACK_NAME}`;
    script.addEventListener("load", finish, { once: true });
    script.addEventListener("error", fail, { once: true });
    document.head.appendChild(script);
  });

  return loaderPromise;
}

export function isValidGoogleMapsCoordinate(
  coordinate: GoogleMapsLatLngLiteral | null | undefined,
): coordinate is GoogleMapsLatLngLiteral {
  return Boolean(
    coordinate &&
      Number.isFinite(coordinate.lat) &&
      coordinate.lat >= -90 &&
      coordinate.lat <= 90 &&
      Number.isFinite(coordinate.lng) &&
      coordinate.lng >= -180 &&
      coordinate.lng <= 180,
  );
}
import { useEffect, useMemo, useRef } from "react";
import { MapContainer, TileLayer, Marker, useMap, useMapEvents } from "react-leaflet";
import L from "leaflet";
import "leaflet/dist/leaflet.css";

// Leaflet's default marker icons are resolved via bundler URLs that break under
// Vite. Point them at CDN assets so the pin always renders.
const markerIcon = L.icon({
  iconUrl: "https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon.png",
  iconRetinaUrl: "https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon-2x.png",
  shadowUrl: "https://unpkg.com/leaflet@1.9.4/dist/images/marker-shadow.png",
  iconSize: [25, 41],
  iconAnchor: [12, 41],
  popupAnchor: [1, -34],
  shadowSize: [41, 41],
});

type LatLng = [number, number];

type Props = {
  center: LatLng;
  value: LatLng | null;
  onChange: (coords: LatLng) => void;
};

/** Recenters the map imperatively when the external center prop changes. */
function Recenter({ center }: { center: LatLng }) {
  const map = useMap();
  const key = `${center[0]},${center[1]}`;
  useEffect(() => {
    map.setView(center, map.getZoom());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return null;
}

/** Captures clicks on the map surface and reports the new pin position. */
function ClickCapture({ onChange }: { onChange: (coords: LatLng) => void }) {
  useMapEvents({
    click(e) {
      onChange([e.latlng.lat, e.latlng.lng]);
    },
  });
  return null;
}

export function LeafletPinMap({ center, value, onChange }: Props) {
  const markerRef = useRef<L.Marker | null>(null);

  const eventHandlers = useMemo(
    () => ({
      dragend() {
        const marker = markerRef.current;
        if (marker) {
          const pos = marker.getLatLng();
          onChange([pos.lat, pos.lng]);
        }
      },
    }),
    [onChange],
  );

  return (
    <div className="h-56 w-full" data-testid="address-collect-map">
      <MapContainer
        center={center}
        zoom={14}
        scrollWheelZoom={false}
        style={{ height: "100%", width: "100%" }}
      >
        <TileLayer
          attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
          url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
        />
        <Recenter center={center} />
        <ClickCapture onChange={onChange} />
        {value && (
          <Marker
            draggable
            position={value}
            icon={markerIcon}
            ref={(instance) => {
              markerRef.current = instance;
            }}
            eventHandlers={eventHandlers}
          />
        )}
      </MapContainer>
    </div>
  );
}

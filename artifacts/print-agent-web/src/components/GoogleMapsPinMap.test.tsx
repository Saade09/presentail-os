import { act, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { GoogleMapsPinMap } from "./GoogleMapsPinMap";

const { mockLoadGoogleMaps } = vi.hoisted(() => ({
  mockLoadGoogleMaps: vi.fn(),
}));

vi.mock("@/lib/googleMaps", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/googleMaps")>();
  return {
    ...actual,
    loadGoogleMaps: mockLoadGoogleMaps,
  };
});

let mapListeners: Record<string, (event: { latLng: { lat(): number; lng(): number } }) => void>;
let markerListeners: Record<string, () => void>;
let markerPosition = { lat: 25.2, lng: 55.3 };

class FakeMap {
  constructor(_element: HTMLElement, _options: unknown) {}

  setCenter = vi.fn();

  addListener(
    eventName: string,
    handler: (event: { latLng: { lat(): number; lng(): number } }) => void,
  ) {
    mapListeners[eventName] = handler;
    return { remove: vi.fn() };
  }
}

class FakeMarker {
  constructor(options: { position: { lat: number; lng: number } }) {
    markerPosition = options.position;
  }

  setPosition = vi.fn((position: { lat: number; lng: number }) => {
    markerPosition = position;
  });

  setMap = vi.fn();

  addListener(eventName: string, handler: () => void) {
    markerListeners[eventName] = handler;
    return { remove: vi.fn() };
  }

  getPosition() {
    return {
      lat: () => markerPosition.lat,
      lng: () => markerPosition.lng,
    };
  }
}

const fakeGoogleMaps = {
  maps: {
    Map: FakeMap,
    Marker: FakeMarker,
  },
};

describe("GoogleMapsPinMap", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mapListeners = {};
    markerListeners = {};
    markerPosition = { lat: 25.2, lng: 55.3 };
    mockLoadGoogleMaps.mockResolvedValue(fakeGoogleMaps);
  });

  it("renders a Google map with a saved pin", async () => {
    render(
      <GoogleMapsPinMap
        center={{ lat: 25.2, lng: 55.3 }}
        value={{ lat: 25.2, lng: 55.3 }}
      />,
    );

    await waitFor(() => expect(screen.getByTestId("google-map")).toBeInTheDocument());
    expect(mockLoadGoogleMaps).toHaveBeenCalledOnce();
  });

  it("falls back to coordinates and an external link when Maps cannot load", async () => {
    mockLoadGoogleMaps.mockRejectedValue(new Error("Google Maps unavailable: browser key is not configured"));

    render(
      <GoogleMapsPinMap
        center={{ lat: 25.2, lng: 55.3 }}
        value={{ lat: 25.2, lng: 55.3 }}
        externalUrl="https://www.google.com/maps/search/?api=1&query=25.2,55.3"
      />,
    );

    await waitFor(() => expect(screen.getByTestId("google-map-fallback")).toBeInTheDocument());
    expect(screen.getByText("browser key is not configured")).toBeInTheDocument();
    expect(screen.getByText("25.200000, 55.300000")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /open in google maps/i })).toHaveAttribute(
      "href",
      "https://www.google.com/maps/search/?api=1&query=25.2,55.3",
    );
  });

  it("reports map clicks and marker drags as local draft coordinates", async () => {
    const onChange = vi.fn();
    render(
      <GoogleMapsPinMap
        center={{ lat: 25.2, lng: 55.3 }}
        value={{ lat: 25.2, lng: 55.3 }}
        interactive
        onChange={onChange}
      />,
    );

    await waitFor(() => expect(screen.getByTestId("google-map")).toBeInTheDocument());

    act(() => {
      mapListeners.click({
        latLng: { lat: () => 24.11, lng: () => 54.22 },
      });
    });
    expect(onChange).toHaveBeenLastCalledWith({ lat: 24.11, lng: 54.22 });

    markerPosition = { lat: 24.33, lng: 54.44 };
    act(() => {
      markerListeners.dragend();
    });
    expect(onChange).toHaveBeenLastCalledWith({ lat: 24.33, lng: 54.44 });
  });

  it("shows an explicit fallback for invalid coordinates without loading Maps", () => {
    render(
      <GoogleMapsPinMap
        center={{ lat: 99, lng: 55.3 }}
        value={{ lat: 99, lng: 55.3 }}
      />,
    );

    expect(screen.getByTestId("google-map-fallback")).toHaveTextContent("saved coordinates are invalid");
    expect(mockLoadGoogleMaps).not.toHaveBeenCalled();
  });
});
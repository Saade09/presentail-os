import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MapPinEditor } from "./PlaceDetailPage";

const { mockApiFetch, mockInvalidateQueries, mockToast } = vi.hoisted(() => ({
  mockApiFetch: vi.fn(),
  mockInvalidateQueries: vi.fn(),
  mockToast: vi.fn(),
}));

vi.mock("@/lib/queryClient", () => ({
  apiFetch: mockApiFetch,
}));

vi.mock("@/hooks/use-toast", () => ({
  useToast: () => ({ toast: mockToast }),
}));

vi.mock("@tanstack/react-query", () => ({
  useMutation: (options: { mutationFn: () => Promise<unknown>; onSuccess?: () => void }) => ({
    isPending: false,
    mutate: () => options.mutationFn().then(() => options.onSuccess?.()),
  }),
  useQueryClient: () => ({ invalidateQueries: mockInvalidateQueries }),
  useQuery: vi.fn(),
}));

vi.mock("@/components/GoogleMapsPinMap", () => ({
  GoogleMapsPinMap: ({
    onChange,
  }: {
    onChange?: (coordinate: { lat: number; lng: number }) => void;
  }) => (
    <button
      type="button"
      data-testid="mock-google-map"
      onClick={() => onChange?.({ lat: 24.1234567, lng: 55.7654321 })}
    >
      Move draft pin
    </button>
  ),
}));

const place = {
  id: "b0aa6701-3c24-46f3-bc2f-84e672d360fd",
  canonical_name: "Test Place",
  place_type: "residence",
  area: null,
  city_id: null,
  city_name: null,
  canonical_address: null,
  latitude: 25.2,
  longitude: 55.3,
  entrance_notes: null,
  internal_notes: null,
  verification_state: "unverified" as const,
  ai_invalid: false,
  archived_at: null,
  created_at: "2026-01-01T00:00:00.000Z",
  updated_at: "2026-01-01T00:00:00.000Z",
  // New fields (Tasks #4468, #4469)
  checkout_ready: null as boolean | null,
  verified_at: null as string | null,
  verified_by: null as string | null,
  coordinate_source: null as string | null,
  location_conflict: null as boolean | null,
  city_country_code: null as string | null,
};

describe("MapPinEditor", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockApiFetch.mockResolvedValue({ success: true });
  });

  it("keeps visual draft pin movement local when canceled", () => {
    const onClose = vi.fn();
    render(<MapPinEditor place={place} open onClose={onClose} />);

    fireEvent.click(screen.getByTestId("mock-google-map"));

    expect(screen.getByLabelText("Latitude")).toHaveValue(24.123457);
    expect(screen.getByLabelText("Longitude")).toHaveValue(55.765432);
    expect(mockApiFetch).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onClose).toHaveBeenCalledOnce();
    expect(mockApiFetch).not.toHaveBeenCalled();
  });

  it("blocks invalid coordinate values before confirmation", () => {
    render(<MapPinEditor place={place} open onClose={vi.fn()} />);

    fireEvent.change(screen.getByLabelText("Latitude"), { target: { value: "91" } });

    expect(screen.getByText(/enter a latitude from/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /confirm & save/i })).toBeDisabled();
  });

  it("sends a manually confirmed draft through the existing map-pin endpoint", async () => {
    const onClose = vi.fn();
    render(<MapPinEditor place={place} open onClose={onClose} />);

    fireEvent.click(screen.getByTestId("mock-google-map"));
    fireEvent.click(screen.getByRole("button", { name: /looks correct/i }));
    fireEvent.click(screen.getByRole("button", { name: /confirm & save/i }));

    await waitFor(() => {
      expect(mockApiFetch).toHaveBeenCalledWith(
        `/api/address-book/places/${place.id}/map-pin`,
        expect.objectContaining({
          method: "PUT",
          body: JSON.stringify({
            latitude: 24.123457,
            longitude: 55.765432,
            source: "manual",
            notes: "Updated via OS dashboard",
          }),
        }),
      );
    });
    expect(mockInvalidateQueries).toHaveBeenCalledWith({ queryKey: ["place-detail", place.id] });
    expect(onClose).toHaveBeenCalledOnce();
  });
});
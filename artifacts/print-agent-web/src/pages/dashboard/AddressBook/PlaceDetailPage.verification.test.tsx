/**
 * Focused UI tests for the verification/checkout features added to PlaceDetailPage.
 *
 * Covers:
 * - CheckoutBadge rendering for each checkout state
 * - VerifyLocationDialog: comparison fetch, three action buttons, error recovery, manual mode
 * - Full-page header: verification + checkout badges, primary/secondary button placement
 * - Conflict/checkout-unavailable warning banner
 * - Alias governance: approved chips vs pending section, approve/reject calls
 * - Verification history collapsed/expanded toggle
 * - Activate/deactivate checkout buttons and blocking-error inline banner
 */

import { fireEvent, render, screen, waitFor, act } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  CheckoutBadge,
  VerificationBadge,
  VerifyLocationDialog,
} from "./PlaceDetailPage";
import PlaceDetailPage from "./PlaceDetailPage";

// ─── Hoisted mocks ────────────────────────────────────────────────────────────

const {
  mockApiFetch,
  mockInvalidateQueries,
  mockToast,
  mockUseQuery,
  mockUseMutation,
  mockIsOwner,
} = vi.hoisted(() => ({
  mockApiFetch: vi.fn(),
  mockInvalidateQueries: vi.fn(),
  mockToast: vi.fn(),
  mockUseQuery: vi.fn(),
  mockUseMutation: vi.fn(),
  mockIsOwner: vi.fn(() => ({ realIsOwner: true })),
}));

vi.mock("@/lib/queryClient", () => ({ apiFetch: mockApiFetch }));
vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast: mockToast }) }));
vi.mock("@/hooks/use-workspace-role", () => ({ useWorkspaceRole: mockIsOwner }));

vi.mock("@tanstack/react-query", () => ({
  useQuery: mockUseQuery,
  useMutation: mockUseMutation,
  useQueryClient: () => ({ invalidateQueries: mockInvalidateQueries }),
}));

vi.mock("@/components/GoogleMapsPinMap", () => ({
  GoogleMapsPinMap: ({
    onChange,
    className,
  }: {
    onChange?: (c: { lat: number; lng: number }) => void;
    className?: string;
  }) => (
    <div data-testid="mock-google-map" className={className}>
      <button
        type="button"
        onClick={() => onChange?.({ lat: 25.111, lng: 55.222 })}
      >
        Move pin
      </button>
    </div>
  ),
}));

vi.mock("wouter", () => ({
  useParams: () => ({ id: "place-abc" }),
  useLocation: () => ["/address-book/place-abc", vi.fn()],
  Link: ({ href, children }: { href: string; children: React.ReactNode }) => (
    <a href={href}>{children}</a>
  ),
}));

vi.mock("@workspace/api-zod/place-types", () => ({
  formatPlaceType: (t: string) => t,
  PLACE_TYPE_OPTIONS: [{ value: "residence", label: "Residence" }],
  PLACE_TYPE_VALUES: ["residence"],
}));

vi.mock("date-fns", () => ({
  format: (_d: Date, _f: string) => "Jan 1, 2026",
  formatDistanceToNow: () => "2 days ago",
}));

vi.mock("@/lib/googleMaps", () => ({
  isValidGoogleMapsCoordinate: () => true,
}));

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** A minimal but complete Place object. */
function makePlaceData(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: "place-abc",
    canonical_name: "Test Villa",
    place_type: "residence",
    area: "Jumeirah",
    city_id: 1,
    city_name: "Dubai",
    canonical_address: "123 Test St",
    latitude: 25.2,
    longitude: 55.3,
    entrance_notes: null,
    internal_notes: null,
    verification_state: "unverified",
    ai_invalid: false,
    archived_at: null,
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    checkout_ready: false,
    verified_at: null,
    verified_by: null,
    coordinate_source: null,
    location_conflict: false,
    ...overrides,
  };
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
  created_at: string;
}

function makePlaceResponse(
  placeOverrides: Parameters<typeof makePlaceData>[0] = {},
  aliasOverrides: Partial<{
    aliases: ReturnType<typeof makeAlias>[];
  }> = {},
) {
  return {
    place: makePlaceData(placeOverrides),
    aliases: aliasOverrides.aliases ?? [],
    contacts: { items: [], total: 0, page: 1, limit: 10 },
    recent_deliveries: [] as unknown[],
    verification_timeline: [] as VerificationEvent[],
  };
}

function makeAlias(
  id: string,
  text: string,
  approvalState: "approved" | "pending" | "rejected" | null = "approved",
) {
  return {
    id,
    alias_text: text,
    normalized_alias: text.toLowerCase(),
    language: null,
    created_at: "2026-01-01T00:00:00.000Z",
    approval_state: approvalState,
    approved_by: null,
    approved_at: null,
  };
}

/** Set up the standard no-op mutation mock. */
function makeNoopMutation() {
  return {
    mutate: vi.fn(),
    isPending: false,
    isError: false,
  };
}

/** Sets useQuery to return data on the first call (place detail). */
function setupPageWithData(
  data: ReturnType<typeof makePlaceResponse>,
  queryOverride: Record<string, unknown> = {},
) {
  mockUseQuery.mockImplementation(({ queryKey }: { queryKey: unknown[] }) => {
    // place-detail is the main query
    if (Array.isArray(queryKey) && queryKey[0] === "place-detail") {
      return { data, isLoading: false, isError: false, refetch: vi.fn(), ...queryOverride };
    }
    // all other queries (contacts, compare-provider, duplicates) return idle
    return { data: undefined, isLoading: false, isError: false, refetch: vi.fn() };
  });
  mockUseMutation.mockReturnValue(makeNoopMutation());
}

const basePlace = {
  id: "place-abc",
  canonical_name: "Test Villa",
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
  checkout_ready: null as boolean | null,
  verified_at: null,
  verified_by: null,
  coordinate_source: null,
  location_conflict: null as boolean | null,
  city_country_code: null as string | null,
};

// ─── CheckoutBadge ────────────────────────────────────────────────────────────

describe("CheckoutBadge", () => {
  it("renders nothing when checkoutReady is null", () => {
    const { container } = render(<CheckoutBadge checkoutReady={null} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("renders 'Checkout ready' badge when checkoutReady is true", () => {
    render(<CheckoutBadge checkoutReady={true} />);
    expect(screen.getByText("Checkout ready")).toBeInTheDocument();
  });

  it("renders 'Checkout off' badge when checkoutReady is false", () => {
    render(<CheckoutBadge checkoutReady={false} />);
    expect(screen.getByText("Checkout off")).toBeInTheDocument();
  });
});

// ─── VerificationBadge ────────────────────────────────────────────────────────

describe("VerificationBadge", () => {
  it.each([
    ["unverified", "Unverified"],
    ["estimated", "Legacy estimate"],
    ["ai_verified", "AI Verified"],
    ["staff_verified", "Staff Verified"],
    ["delivery_verified", "Delivery Verified"],
  ] as const)("renders label '%s'", (state, label) => {
    render(<VerificationBadge state={state} />);
    expect(screen.getByText(label)).toBeInTheDocument();
  });
});

// ─── VerifyLocationDialog ─────────────────────────────────────────────────────

describe("VerifyLocationDialog", () => {
  const onClose = vi.fn();

  const compareResult = {
    current_pin: { latitude: 25.2, longitude: 55.3 },
    provider_suggestion: {
      latitude: 25.25,
      longitude: 55.35,
      matched_location: "Test Match",
      match_type: "exact",
      query: "Test Villa Dubai",
    },
    distance_km: 7.2,
    locality_match: true,
    delivery_history: [],
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockApiFetch.mockResolvedValue({ success: true });
    onClose.mockReset();
  });

  function setupCompareMutation(overrides: Partial<ReturnType<typeof makeNoopMutation>> = {}) {
    // Forward mutate(arg) → mutationFn(arg) so parameterised mutations work correctly.
    mockUseMutation.mockImplementation((opts: {
      mutationFn: (arg?: unknown) => Promise<unknown>;
      onSuccess?: (data: unknown) => void;
      onError?: (err: unknown) => void;
    }) => ({
      mutate: (arg?: unknown) =>
        opts.mutationFn(arg).then(opts.onSuccess).catch(opts.onError),
      isPending: false,
      ...overrides,
    }));
  }

  it("shows loading spinner while comparison is fetching", () => {
    mockUseQuery.mockReturnValue({ data: undefined, isLoading: true, isError: false, refetch: vi.fn() });
    setupCompareMutation();
    render(<VerifyLocationDialog place={basePlace} open onClose={onClose} />);
    expect(screen.getByText(/fetching provider data/i)).toBeInTheDocument();
  });

  it("shows error message with retry button when comparison fails", () => {
    mockUseQuery.mockReturnValue({ data: undefined, isLoading: false, isError: true, refetch: vi.fn() });
    setupCompareMutation();
    render(<VerifyLocationDialog place={basePlace} open onClose={onClose} />);
    expect(screen.getByText(/provider comparison unavailable/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /retry/i })).toBeInTheDocument();
  });

  it("shows provider suggestion and distance when comparison succeeds", () => {
    mockUseQuery.mockReturnValue({ data: compareResult, isLoading: false, isError: false, refetch: vi.fn() });
    setupCompareMutation();
    render(<VerifyLocationDialog place={basePlace} open onClose={onClose} />);
    expect(screen.getByText("Test Match")).toBeInTheDocument();
    expect(screen.getByText(/7\.2 km apart/)).toBeInTheDocument();
    expect(screen.getByText(/locality match/i)).toBeInTheDocument();
  });

  it("shows 'No provider suggestion' when provider_suggestion is null", () => {
    mockUseQuery.mockReturnValue({
      data: { ...compareResult, provider_suggestion: null },
      isLoading: false,
      isError: false,
      refetch: vi.fn(),
    });
    setupCompareMutation();
    render(<VerifyLocationDialog place={basePlace} open onClose={onClose} />);
    expect(screen.getByText(/no provider suggestion available/i)).toBeInTheDocument();
    // "Use suggested location" button absent when no suggestion
    expect(screen.queryByRole("button", { name: /use suggested location/i })).not.toBeInTheDocument();
  });

  it("'Keep current pin' calls verify endpoint with staff_verified state", async () => {
    mockUseQuery.mockReturnValue({ data: compareResult, isLoading: false, isError: false, refetch: vi.fn() });
    setupCompareMutation();
    mockApiFetch.mockResolvedValue({ success: true, verification_state: "staff_verified" });

    render(<VerifyLocationDialog place={basePlace} open onClose={onClose} />);

    fireEvent.click(screen.getByRole("button", { name: /keep current pin/i }));

    await waitFor(() => {
      expect(mockApiFetch).toHaveBeenCalledWith(
        `/api/address-book/places/${basePlace.id}/verify`,
        expect.objectContaining({
          method: "POST",
          body: expect.stringContaining('"state":"staff_verified"'),
        }),
      );
    });
  });

  it("'Use suggested location' calls map-pin with google_places source then calls /verify", async () => {
    mockUseQuery.mockReturnValue({ data: compareResult, isLoading: false, isError: false, refetch: vi.fn() });
    setupCompareMutation();
    mockApiFetch.mockResolvedValue({ success: true });

    render(<VerifyLocationDialog place={basePlace} open onClose={onClose} />);

    fireEvent.click(screen.getByRole("button", { name: /use suggested location/i }));

    await waitFor(() => {
      expect(mockApiFetch).toHaveBeenCalledWith(
        `/api/address-book/places/${basePlace.id}/map-pin`,
        expect.objectContaining({
          method: "PUT",
          body: expect.stringContaining('"latitude":25.25'),
        }),
      );
    });

    // First call: map-pin PUT must use google_places source
    const pinBody = JSON.parse(
      (mockApiFetch.mock.calls[0][1] as { body: string }).body,
    );
    expect(pinBody.source).toBe("google_places");

    // Second call: verify POST must set staff_verified state
    await waitFor(() => {
      expect(mockApiFetch).toHaveBeenCalledWith(
        `/api/address-book/places/${basePlace.id}/verify`,
        expect.objectContaining({
          method: "POST",
          body: expect.stringContaining('"state":"staff_verified"'),
        }),
      );
    });

    // Dialog closes on success
    await waitFor(() => expect(onClose).toHaveBeenCalledOnce());
  });

  it("'Confirm & save' (manual pin) calls map-pin with manual source then calls /verify", async () => {
    mockUseQuery.mockReturnValue({ data: compareResult, isLoading: false, isError: false, refetch: vi.fn() });
    setupCompareMutation();
    mockApiFetch.mockResolvedValue({ success: true });

    render(<VerifyLocationDialog place={basePlace} open onClose={onClose} />);

    // Switch to manual mode
    fireEvent.click(screen.getByText(/adjust pin manually/i));

    // Trigger a map pin move via the mock map (sets lat=25.111, lng=55.222)
    fireEvent.click(screen.getByText("Move pin"));

    // Confirm the position looks correct (required before save is enabled)
    await waitFor(() => {
      expect(screen.getByRole("button", { name: /looks correct/i })).toBeInTheDocument();
    });
    fireEvent.click(screen.getByRole("button", { name: /looks correct/i }));

    // Submit
    fireEvent.click(screen.getByRole("button", { name: /confirm & save/i }));

    await waitFor(() => {
      expect(mockApiFetch).toHaveBeenCalledWith(
        `/api/address-book/places/${basePlace.id}/map-pin`,
        expect.objectContaining({
          method: "PUT",
          body: expect.stringContaining('"latitude":25.111'),
        }),
      );
    });

    // First call: map-pin PUT must use manual source
    const pinBody = JSON.parse(
      (mockApiFetch.mock.calls[0][1] as { body: string }).body,
    );
    expect(pinBody.source).toBe("manual");

    // Second call: verify POST must set staff_verified state
    await waitFor(() => {
      expect(mockApiFetch).toHaveBeenCalledWith(
        `/api/address-book/places/${basePlace.id}/verify`,
        expect.objectContaining({
          method: "POST",
          body: expect.stringContaining('"state":"staff_verified"'),
        }),
      );
    });

    // Dialog closes on success
    await waitFor(() => expect(onClose).toHaveBeenCalledOnce());
  });

  it("shows inline error when keep-current fails", async () => {
    mockUseQuery.mockReturnValue({ data: compareResult, isLoading: false, isError: false, refetch: vi.fn() });
    mockUseMutation.mockImplementation((opts: {
      mutationFn: () => Promise<unknown>;
      onError?: (err: unknown) => void;
    }) => ({
      mutate: () => opts.mutationFn().catch(opts.onError),
      isPending: false,
    }));
    mockApiFetch.mockRejectedValue(new Error("server error"));

    render(<VerifyLocationDialog place={basePlace} open onClose={onClose} />);
    fireEvent.click(screen.getByRole("button", { name: /keep current pin/i }));

    await waitFor(() => {
      expect(screen.getByText(/failed to verify location/i)).toBeInTheDocument();
    });
    // Dialog stays open
    expect(onClose).not.toHaveBeenCalled();
  });

  it("switches to manual mode and back", () => {
    mockUseQuery.mockReturnValue({ data: compareResult, isLoading: false, isError: false, refetch: vi.fn() });
    setupCompareMutation();

    render(<VerifyLocationDialog place={basePlace} open onClose={onClose} />);

    // Switch to manual mode
    fireEvent.click(screen.getByText(/adjust pin manually/i));
    expect(screen.getByLabelText("Latitude")).toBeInTheDocument();
    expect(screen.getByLabelText("Longitude")).toBeInTheDocument();

    // Back to comparison
    fireEvent.click(screen.getByText(/back to comparison/i));
    expect(screen.queryByLabelText("Latitude")).not.toBeInTheDocument();
    expect(screen.getByText(/current saved pin/i)).toBeInTheDocument();
  });

  it("validates coordinates in manual mode before allowing save", () => {
    mockUseQuery.mockReturnValue({ data: compareResult, isLoading: false, isError: false, refetch: vi.fn() });
    setupCompareMutation();

    render(<VerifyLocationDialog place={basePlace} open onClose={onClose} />);
    fireEvent.click(screen.getByText(/adjust pin manually/i));

    // Enter invalid latitude
    fireEvent.change(screen.getByLabelText("Latitude"), { target: { value: "999" } });
    expect(screen.getByText(/enter a latitude from/i)).toBeInTheDocument();
    // Button exists but must be disabled when coords are invalid
    expect(screen.getByRole("button", { name: /confirm & save/i })).toBeDisabled();
  });

  it("Cancel button calls onClose", () => {
    mockUseQuery.mockReturnValue({ data: compareResult, isLoading: false, isError: false, refetch: vi.fn() });
    setupCompareMutation();

    render(<VerifyLocationDialog place={basePlace} open onClose={onClose} />);
    fireEvent.click(screen.getByRole("button", { name: /cancel/i }));
    expect(onClose).toHaveBeenCalledOnce();
  });
});

// ─── Full PlaceDetailPage ─────────────────────────────────────────────────────

describe("PlaceDetailPage — header badges", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIsOwner.mockReturnValue({ realIsOwner: true });
  });

  it("shows both verification and checkout badges in the header", () => {
    const data = makePlaceResponse({
      verification_state: "staff_verified",
      checkout_ready: true,
    });
    setupPageWithData(data);

    render(<PlaceDetailPage />);

    expect(screen.getByText("Staff Verified")).toBeInTheDocument();
    expect(screen.getByText("Checkout ready")).toBeInTheDocument();
  });

  it("shows 'Checkout off' badge when checkout_ready is false", () => {
    const data = makePlaceResponse({
      verification_state: "staff_verified",
      checkout_ready: false,
    });
    setupPageWithData(data);

    render(<PlaceDetailPage />);

    expect(screen.getByText("Checkout off")).toBeInTheDocument();
  });

  it("shows primary 'Verify location' button when place is unverified", () => {
    const data = makePlaceResponse({ verification_state: "unverified" });
    setupPageWithData(data);

    render(<PlaceDetailPage />);

    // Both the header button and the warning banner contain "Verify location" — at least one must exist.
    const verifyBtns = screen.getAllByRole("button", { name: /verify location/i });
    expect(verifyBtns.length).toBeGreaterThanOrEqual(1);
    // Edit place still present
    expect(screen.getByRole("button", { name: /edit place/i })).toBeInTheDocument();
  });

  it("shows primary 'Verify location' button when location_conflict is true", () => {
    const data = makePlaceResponse({
      verification_state: "staff_verified",
      location_conflict: true,
    });
    setupPageWithData(data);

    render(<PlaceDetailPage />);

    const verifyBtns = screen.getAllByRole("button", { name: /verify location/i });
    expect(verifyBtns.length).toBeGreaterThanOrEqual(1);
  });

  it("does not show primary verify button when place is staff_verified with no conflict", () => {
    const data = makePlaceResponse({
      verification_state: "staff_verified",
      location_conflict: false,
      checkout_ready: true,
    });
    setupPageWithData(data);

    render(<PlaceDetailPage />);

    // Verify location is in the dropdown, not as a primary button
    expect(screen.queryByRole("button", { name: /^verify location$/i })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /edit place/i })).toBeInTheDocument();
  });
});

describe("PlaceDetailPage — conflict/checkout warning banner", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIsOwner.mockReturnValue({ realIsOwner: true });
  });

  it("renders conflict banner when location_conflict is true", () => {
    const data = makePlaceResponse({ location_conflict: true, checkout_ready: false });
    setupPageWithData(data);

    render(<PlaceDetailPage />);

    const banner = screen.getByTestId("checkout-warning-banner");
    expect(banner).toBeInTheDocument();
    expect(banner).toHaveTextContent(/location conflict detected/i);
    // Has Verify location action button inside the banner
    expect(banner).toHaveTextContent(/verify location/i);
  });

  it("renders unavailable banner when unverified and checkout_ready is false", () => {
    const data = makePlaceResponse({
      verification_state: "unverified",
      location_conflict: false,
      checkout_ready: false,
    });
    setupPageWithData(data);

    render(<PlaceDetailPage />);

    const banner = screen.getByTestId("checkout-warning-banner");
    expect(banner).toHaveTextContent(/not verified/i);
  });

  it("does not show banner when verified and checkout_ready is true", () => {
    const data = makePlaceResponse({
      verification_state: "staff_verified",
      location_conflict: false,
      checkout_ready: true,
    });
    setupPageWithData(data);

    render(<PlaceDetailPage />);

    expect(screen.queryByTestId("checkout-warning-banner")).not.toBeInTheDocument();
  });
});

describe("PlaceDetailPage — alias governance", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIsOwner.mockReturnValue({ realIsOwner: true });
  });

  it("renders approved aliases as chips with remove button", () => {
    const data = makePlaceResponse(
      {},
      { aliases: [makeAlias("a1", "Dubai Villa", "approved")] },
    );
    setupPageWithData(data);

    render(<PlaceDetailPage />);

    expect(screen.getByText("Dubai Villa")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /remove alias Dubai Villa/i })).toBeInTheDocument();
    // No approve/reject section for approved aliases
    expect(screen.queryByRole("button", { name: /^approve$/i })).not.toBeInTheDocument();
  });

  it("renders pending aliases in separate section with Approve and Reject buttons", () => {
    const data = makePlaceResponse(
      {},
      { aliases: [makeAlias("p1", "Jumeirah Palace", "pending")] },
    );
    setupPageWithData(data);

    render(<PlaceDetailPage />);

    expect(screen.getByText("Jumeirah Palace")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /approve alias Jumeirah Palace/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /reject alias Jumeirah Palace/i })).toBeInTheDocument();
    // Shows pending count badge
    expect(screen.getByText("1 pending")).toBeInTheDocument();
  });

  it("hides rejected aliases entirely", () => {
    const data = makePlaceResponse(
      {},
      { aliases: [makeAlias("r1", "Old Name", "rejected")] },
    );
    setupPageWithData(data);

    render(<PlaceDetailPage />);

    expect(screen.queryByText("Old Name")).not.toBeInTheDocument();
  });

  it("Approve button calls the correct alias endpoint", async () => {
    const data = makePlaceResponse(
      {},
      { aliases: [makeAlias("p1", "Palm Jumeirah", "pending")] },
    );

    let approveCallback: () => void = () => {};
    mockUseMutation.mockImplementation((opts: {
      mutationFn: (id: string) => Promise<unknown>;
      onSuccess?: () => void;
    }) => ({
      mutate: (id: string) => {
        approveCallback = () => opts.mutationFn(id).then(opts.onSuccess);
      },
      isPending: false,
    }));
    mockUseQuery.mockImplementation(({ queryKey }: { queryKey: unknown[] }) => {
      if (Array.isArray(queryKey) && queryKey[0] === "place-detail") {
        return { data, isLoading: false, isError: false, refetch: vi.fn() };
      }
      return { data: undefined, isLoading: false, isError: false, refetch: vi.fn() };
    });
    mockApiFetch.mockResolvedValue({ success: true });

    render(<PlaceDetailPage />);

    fireEvent.click(screen.getByRole("button", { name: /approve alias Palm Jumeirah/i }));

    await act(async () => { approveCallback(); });

    await waitFor(() => {
      expect(mockApiFetch).toHaveBeenCalledWith(
        "/api/address-book/places/place-abc/aliases/p1/approve",
        expect.objectContaining({ method: "POST" }),
      );
    });
  });

  it("Reject button calls the correct alias endpoint", async () => {
    const data = makePlaceResponse(
      {},
      { aliases: [makeAlias("p2", "Wrong Name", "pending")] },
    );

    let rejectCallback: () => void = () => {};
    mockUseMutation.mockImplementation((opts: {
      mutationFn: (id: string) => Promise<unknown>;
      onSuccess?: () => void;
    }) => ({
      mutate: (id: string) => {
        rejectCallback = () => opts.mutationFn(id).then(opts.onSuccess);
      },
      isPending: false,
    }));
    mockUseQuery.mockImplementation(({ queryKey }: { queryKey: unknown[] }) => {
      if (Array.isArray(queryKey) && queryKey[0] === "place-detail") {
        return { data, isLoading: false, isError: false, refetch: vi.fn() };
      }
      return { data: undefined, isLoading: false, isError: false, refetch: vi.fn() };
    });
    mockApiFetch.mockResolvedValue({ success: true });

    render(<PlaceDetailPage />);

    fireEvent.click(screen.getByRole("button", { name: /reject alias Wrong Name/i }));

    await act(async () => { rejectCallback(); });

    await waitFor(() => {
      expect(mockApiFetch).toHaveBeenCalledWith(
        "/api/address-book/places/place-abc/aliases/p2/reject",
        expect.objectContaining({ method: "POST" }),
      );
    });
  });

  it("does not render approve/reject buttons for non-owners", () => {
    mockIsOwner.mockReturnValue({ realIsOwner: false });
    const data = makePlaceResponse(
      {},
      { aliases: [makeAlias("p1", "Guest View", "pending")] },
    );
    setupPageWithData(data);

    render(<PlaceDetailPage />);

    // Pending section absent for non-owners
    expect(screen.queryByRole("button", { name: /approve alias/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /reject alias/i })).not.toBeInTheDocument();
  });
});

describe("PlaceDetailPage — verification history toggle", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIsOwner.mockReturnValue({ realIsOwner: true });
  });

  function setupWithTimeline() {
    const data = makePlaceResponse();
    data.verification_timeline = [
      {
        id: "evt1",
        event_type: "created",
        from_state: null,
        to_state: null,
        actor_user_id: null,
        actor_name: "admin@test.com",
        source: "manual",
        notes: null,
        created_at: "2026-01-01T00:00:00.000Z",
      },
    ];
    setupPageWithData(data);
  }

  it("verification history is collapsed by default", () => {
    setupWithTimeline();
    render(<PlaceDetailPage />);

    // History content hidden by default
    expect(screen.queryByTestId("verification-history-content")).not.toBeInTheDocument();
    // Toggle button present
    expect(screen.getByTestId("verification-history-toggle")).toBeInTheDocument();
  });

  it("expands verification history when toggle is clicked", () => {
    setupWithTimeline();
    render(<PlaceDetailPage />);

    fireEvent.click(screen.getByTestId("verification-history-toggle"));
    expect(screen.getByTestId("verification-history-content")).toBeInTheDocument();
    expect(screen.getByText("Place created")).toBeInTheDocument();
  });

  it("collapses again when toggle is clicked a second time", () => {
    setupWithTimeline();
    render(<PlaceDetailPage />);

    const toggle = screen.getByTestId("verification-history-toggle");
    fireEvent.click(toggle);
    expect(screen.getByTestId("verification-history-content")).toBeInTheDocument();

    fireEvent.click(toggle);
    expect(screen.queryByTestId("verification-history-content")).not.toBeInTheDocument();
  });

  it("shows empty state inside expanded history when timeline is empty", () => {
    const data = makePlaceResponse();
    data.verification_timeline = [];
    setupPageWithData(data);

    render(<PlaceDetailPage />);
    fireEvent.click(screen.getByTestId("verification-history-toggle"));
    expect(screen.getByText(/no activity yet/i)).toBeInTheDocument();
  });
});

describe("PlaceDetailPage — checkout activation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIsOwner.mockReturnValue({ realIsOwner: true });
  });

  it("shows Activate checkout button when checkout_ready is false", () => {
    const data = makePlaceResponse({ checkout_ready: false, verification_state: "staff_verified" });
    setupPageWithData(data);

    render(<PlaceDetailPage />);

    expect(screen.getByTestId("activate-checkout-btn")).toBeInTheDocument();
    expect(screen.queryByTestId("deactivate-checkout-btn")).not.toBeInTheDocument();
  });

  it("shows Deactivate checkout button when checkout_ready is true", () => {
    const data = makePlaceResponse({ checkout_ready: true, verification_state: "staff_verified" });
    setupPageWithData(data);

    render(<PlaceDetailPage />);

    expect(screen.getByTestId("deactivate-checkout-btn")).toBeInTheDocument();
    expect(screen.queryByTestId("activate-checkout-btn")).not.toBeInTheDocument();
  });

  it("does not show checkout card for non-owners", () => {
    mockIsOwner.mockReturnValue({ realIsOwner: false });
    const data = makePlaceResponse({ checkout_ready: false });
    setupPageWithData(data);

    render(<PlaceDetailPage />);

    expect(screen.queryByTestId("activate-checkout-btn")).not.toBeInTheDocument();
    expect(screen.queryByTestId("deactivate-checkout-btn")).not.toBeInTheDocument();
  });

  it("calls activate-checkout endpoint when Activate button is clicked", async () => {
    const data = makePlaceResponse({ checkout_ready: false, verification_state: "staff_verified" });

    let activateCallback: () => void = () => {};
    mockUseMutation.mockImplementation((opts: {
      mutationFn: () => Promise<unknown>;
      onSuccess?: (d: unknown) => void;
    }) => ({
      mutate: () => {
        activateCallback = () => opts.mutationFn().then(opts.onSuccess);
      },
      isPending: false,
    }));
    mockUseQuery.mockImplementation(({ queryKey }: { queryKey: unknown[] }) => {
      if (Array.isArray(queryKey) && queryKey[0] === "place-detail") {
        return { data, isLoading: false, isError: false, refetch: vi.fn() };
      }
      return { data: undefined, isLoading: false, isError: false, refetch: vi.fn() };
    });
    mockApiFetch.mockResolvedValue({ success: true });

    render(<PlaceDetailPage />);
    fireEvent.click(screen.getByTestId("activate-checkout-btn"));

    await act(async () => { activateCallback(); });

    await waitFor(() => {
      expect(mockApiFetch).toHaveBeenCalledWith(
        "/api/address-book/places/place-abc/activate-checkout",
        expect.objectContaining({ method: "POST" }),
      );
    });
  });

  it("shows blocking error banner when activate-checkout returns blocking_reasons", async () => {
    // Use staff_verified so the button is enabled (unverified would disable it via checkoutUnavailable)
    const data = makePlaceResponse({ checkout_ready: false, verification_state: "staff_verified" });

    const blockingReasons = [
      "location_conflict must be resolved before activating checkout",
    ];

    mockUseMutation.mockImplementation((opts: {
      mutationFn: () => Promise<unknown>;
      onSuccess?: (d: unknown) => void;
      onError?: (err: unknown) => void;
    }) => ({
      mutate: () => {
        opts.mutationFn()
          .then(opts.onSuccess)
          .catch(opts.onError);
      },
      isPending: false,
    }));
    mockUseQuery.mockImplementation(({ queryKey }: { queryKey: unknown[] }) => {
      if (Array.isArray(queryKey) && queryKey[0] === "place-detail") {
        return { data, isLoading: false, isError: false, refetch: vi.fn() };
      }
      return { data: undefined, isLoading: false, isError: false, refetch: vi.fn() };
    });

    // apiFetch attaches the parsed JSON body to err.body (not err.json)
    const err = Object.assign(new Error("422"), {
      status: 422,
      body: { error: "Place cannot be activated for checkout", blocking_reasons: blockingReasons },
    });
    mockApiFetch.mockRejectedValue(err);

    render(<PlaceDetailPage />);
    fireEvent.click(screen.getByTestId("activate-checkout-btn"));

    await waitFor(() => {
      expect(screen.getByTestId("checkout-block-error")).toBeInTheDocument();
      expect(screen.getByText(/location_conflict must be resolved/i)).toBeInTheDocument();
    });
  });

  it("dismisses blocking error banner with the X button", async () => {
    // Use staff_verified so the button is enabled (unverified would disable it via checkoutUnavailable)
    const data = makePlaceResponse({ checkout_ready: false, verification_state: "staff_verified" });
    // apiFetch attaches parsed JSON to err.body, not err.json
    const err = Object.assign(new Error("422"), {
      status: 422,
      body: {
        blocking_reasons: ["location_conflict must be resolved before activating checkout"],
      },
    });

    mockUseMutation.mockImplementation((opts: {
      mutationFn: () => Promise<unknown>;
      onError?: (err: unknown) => void;
    }) => ({
      mutate: () => opts.mutationFn().catch(opts.onError),
      isPending: false,
    }));
    mockUseQuery.mockImplementation(({ queryKey }: { queryKey: unknown[] }) => {
      if (Array.isArray(queryKey) && queryKey[0] === "place-detail") {
        return { data, isLoading: false, isError: false, refetch: vi.fn() };
      }
      return { data: undefined, isLoading: false, isError: false, refetch: vi.fn() };
    });
    mockApiFetch.mockRejectedValue(err);

    render(<PlaceDetailPage />);
    fireEvent.click(screen.getByTestId("activate-checkout-btn"));

    await waitFor(() => {
      expect(screen.getByTestId("checkout-block-error")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole("button", { name: /dismiss/i }));
    expect(screen.queryByTestId("checkout-block-error")).not.toBeInTheDocument();
  });
});

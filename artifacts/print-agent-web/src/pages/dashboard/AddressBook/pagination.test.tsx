import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const wouterState = vi.hoisted(() => ({
  params: { current: new URLSearchParams() },
  listeners: { current: new Set<() => void>() },
}));

const mockUseQuery = vi.fn();
type MockMutationOptions = {
  mutationFn: () => Promise<unknown>;
  onSuccess?: (value: unknown) => void;
  onError?: () => void;
};
type MockMutationResult = { mutate: () => void; isPending: boolean };
const mockUseMutation = vi.fn<(options: MockMutationOptions) => MockMutationResult>(() => ({
  mutate: vi.fn(),
  isPending: false,
}));
const queryCalls: Array<{ queryKey: unknown[] }> = [];
const uiState = vi.hoisted(() => ({
  realIsOwner: true,
  reverificationRun: null as null | Record<string, unknown>,
  verifiedCount: 1,
  needsReviewCount: 0,
}));
const mockApiFetch = vi.hoisted(() => vi.fn());
const mockToast = vi.hoisted(() => vi.fn());
const mockInvalidateQueries = vi.hoisted(() => vi.fn());

vi.mock("wouter", async () => {
  const React = await import("react");
  return {
    useLocation: () => ["/address-book", vi.fn()],
    useSearchParams: () => {
      const [, forceUpdate] = React.useReducer((value: number) => value + 1, 0);
      React.useEffect(() => {
        wouterState.listeners.current.add(forceUpdate);
        return () => {
          wouterState.listeners.current.delete(forceUpdate);
        };
      }, []);

      return [
        wouterState.params.current,
        (
          nextInit:
            | URLSearchParams
            | ((previous: URLSearchParams) => URLSearchParams),
          options?: { replace?: boolean },
        ) => {
          wouterState.params.current =
            typeof nextInit === "function"
              ? nextInit(wouterState.params.current)
              : nextInit;
          const query = wouterState.params.current.toString();
          window.history[options?.replace ? "replaceState" : "pushState"](
            {},
            "",
            query ? `/address-book?${query}` : "/address-book",
          );
          wouterState.listeners.current.forEach((listener) => listener());
        },
      ];
    },
  };
});

vi.mock("@tanstack/react-query", () => ({
  useQuery: (options: { queryKey: unknown[] }) => {
    queryCalls.push(options);
    if (options.queryKey[0] === "address-book-areas") {
      return {
        data: { success: true, areas: ["North"] },
        isLoading: false,
        isError: false,
      };
    }
    if (options.queryKey[0] === "address-book-reverification-run") {
      return {
        data: uiState.reverificationRun ? { run: uiState.reverificationRun } : undefined,
        isLoading: false,
        isError: false,
      };
    }
    return {
      data: {
        success: true,
        places: [
          {
            id: "place-1",
            canonical_name: "Place 1",
            place_type: "home",
            area: "North",
            city_id: null,
            city_name: null,
            canonical_address: "1 Main Street",
            verification_state: "staff_verified",
            ai_invalid: false,
            alias_count: 0,
            contact_count: 1,
            delivery_count: 2,
            checkout_ready: true,
            location_conflict: false,
            last_delivered_at: "2026-08-20T10:00:00.000Z",
            verified_at: "2026-08-19T10:00:00.000Z",
            updated_at: "2026-08-24T10:00:00.000Z",
          },
        ],
        total: 101,
        summary: {
          verified_count: uiState.verifiedCount,
          checkout_ready_count: 1,
          checkout_eligible_count: 0,
          ai_reverification_count: 4,
          needs_review_count: uiState.needsReviewCount,
          linked_deliveries_count: 2,
          possible_duplicates_count: 0,
          missing_coordinates_count: 0,
        },
      },
      isLoading: false,
      isError: false,
      refetch: vi.fn(),
    };
  },
  useMutation: (options: MockMutationOptions) => mockUseMutation(options),
}));

vi.mock("@/lib/queryClient", () => ({
  apiFetch: mockApiFetch,
  queryClient: { invalidateQueries: mockInvalidateQueries, setQueryData: vi.fn() },
}));

vi.mock("@/hooks/use-toast", () => ({
  useToast: () => ({ toast: mockToast }),
}));

vi.mock("@/hooks/use-workspace-role", () => ({
  useWorkspaceRole: () => ({ realIsOwner: uiState.realIsOwner }),
}));

import AddressBookPage from "./index";

function addressBookQueryKey(): unknown[] {
  return queryCalls.findLast(
    (call) => call.queryKey[0] === "address-book-places",
  )?.queryKey ?? [];
}

beforeEach(() => {
  queryCalls.length = 0;
  wouterState.params.current = new URLSearchParams();
  wouterState.listeners.current.clear();
  window.history.replaceState({}, "", "/address-book");
  uiState.realIsOwner = true;
  uiState.reverificationRun = null;
  uiState.verifiedCount = 1;
  uiState.needsReviewCount = 0;
  mockApiFetch.mockReset();
  mockToast.mockReset();
  mockInvalidateQueries.mockReset();
  mockUseMutation.mockReset();
  mockUseMutation.mockReturnValue({ mutate: vi.fn(), isPending: false });
});

describe("Address Book bulk reverification", () => {
  it("separates current 25/394 place totals from a 301-job run snapshot", () => {
    uiState.verifiedCount = 25;
    uiState.needsReviewCount = 394;
    uiState.reverificationRun = {
      id: "run-populations",
      status: "RUNNING",
      queued: 90,
      running: 1,
      succeeded: 200,
      verified: 20,
      repaired: 180,
      cleared: 0,
      invalid: 5,
      unresolved: 3,
      failed: 1,
      provider_failures: 1,
      protected: 1,
      skipped: 1,
      total: 301,
      selected: 301,
      outstanding: 91,
      terminal: 210,
      excluded: 118,
      snapshot_place_count: 419,
      snapshot_eligible_count: 301,
      reused: true,
    };
    render(<AddressBookPage />);
    expect(screen.getByText(/25 verified \+ 394 needing review = 419 places/i)).toBeInTheDocument();
    const progress = screen.getByTestId("address-reverification-progress");
    expect(progress).toHaveTextContent("301 selected");
    expect(progress).toHaveTextContent("91 outstanding");
    expect(progress).toHaveTextContent("210 completed");
    expect(progress).toHaveTextContent("118 not selected");
    expect(progress).toHaveTextContent("existing run reused");
  });
  it("shows the owner action and confirms the queued count without promising checkout activation", async () => {
    const user = userEvent.setup();
    render(<AddressBookPage />);

    await user.click(screen.getByRole("button", { name: "Reverify eligible AI addresses" }));

    expect(screen.getByRole("heading", { name: "Reverify eligible AI addresses?" })).toBeInTheDocument();
    expect(screen.getByText(/queues 4 active unverified, AI-verified, legacy automated, and/i)).toBeInTheDocument();
    expect(screen.getByText(/unsupported automated pins will be cleared/i)).toBeInTheDocument();
    expect(screen.getByText(/removed from checkout/i)).toBeInTheDocument();
  });

  it("hides the bulk action from non-owners", () => {
    uiState.realIsOwner = false;
    render(<AddressBookPage />);
    expect(screen.queryByRole("button", { name: "Reverify eligible AI addresses" })).not.toBeInTheDocument();
  });

  it("shows the minimal provider control request and complete sanitized error details", async () => {
    const user = userEvent.setup();
    mockApiFetch.mockResolvedValue({
      checked_at: "2026-09-24T08:00:00.000Z",
      providers: [
        {
          provider: "google_places",
          endpoint: "https://places.googleapis.com/v1/places:searchText",
          credentialSource: "GOOGLE_PLACES_SERVER_KEY (server-side secret)",
          credentialFingerprint: "0123456789abcdef",
          configured: true,
          reachable: false,
          httpStatus: 403,
          errorCategory: "permission_denied_unclassified",
          providerMessage: "The caller does not have permission",
          providerResponseBody: '{"error":{"status":"PERMISSION_DENIED","details":[]}}',
          minimalTextSearch: {
            attempted: true,
            method: "POST",
            endpoint: "https://places.googleapis.com/v1/places:searchText",
            authHeader: "X-Goog-Api-Key",
            fieldMask: "places.id,places.displayName,places.formattedAddress,places.location",
            textQuery: "Beirut, Lebanon",
            httpStatus: 403,
            errorCategory: "permission_denied_unclassified",
            providerMessage: "The caller does not have permission",
            providerResponseBody: '{"error":{"status":"PERMISSION_DENIED","details":[]}}',
          },
          lastChecked: "2026-09-24T08:00:00.000Z",
        },
        {
          provider: "nominatim",
          endpoint: "https://nominatim.openstreetmap.org/search",
          credentialSource: "No credential required",
          credentialFingerprint: null,
          configured: true,
          reachable: true,
          httpStatus: 200,
          errorCategory: null,
          providerMessage: null,
          providerResponseBody: null,
          lastChecked: "2026-09-24T08:00:00.000Z",
        },
      ],
    });
    render(<AddressBookPage />);

    await user.click(screen.getByRole("button", { name: "Check map providers" }));

    const control = await screen.findByTestId("address-book-minimal-text-search-control");
    expect(control).toHaveTextContent("HTTP 403");
    expect(control).toHaveTextContent("POST https://places.googleapis.com/v1/places:searchText");
    expect(control).toHaveTextContent("X-Goog-Api-Key (value hidden)");
    expect(control).toHaveTextContent("places.id,places.displayName,places.formattedAddress,places.location");
    expect(control).toHaveTextContent('{"textQuery":"Beirut, Lebanon"}');
    expect(control).toHaveTextContent('"details":[]');
    expect(screen.getByTestId("address-book-provider-diagnostics-result")).toHaveTextContent(
      "Runtime key fingerprint (SHA-256): 0123456789abcdef",
    );
    expect(screen.getByTestId("address-book-google-places-warning")).toHaveTextContent(
      "Google Places (New) is unavailable",
    );
    expect(screen.getByTestId("address-book-google-places-warning")).toHaveTextContent(
      "Reverification can continue through Nominatim when it is healthy",
    );

    await user.click(screen.getByRole("button", { name: "Retry map provider diagnostics" }));
    await waitFor(() => expect(mockApiFetch).toHaveBeenCalledTimes(2));
  });

  it("warns owners about a Google configuration failure recorded for the current run", () => {
    uiState.reverificationRun = {
      id: "run-google-unavailable",
      status: "RUNNING",
      queued: 2,
      running: 0,
      succeeded: 0,
      invalid: 0,
      unresolved: 0,
      failed: 0,
      provider_failures: 0,
      protected: 0,
      skipped: 0,
      total: 2,
      provider_health: {
        google_places: {
          status: "configuration_failure",
          httpStatus: 403,
          errorCategory: "permission_denied_unclassified",
          providerMessage: "The caller does not have permission",
          lastChecked: "2026-09-24T08:00:00.000Z",
        },
        nominatim: {
          status: "healthy",
          httpStatus: 200,
          errorCategory: null,
          providerMessage: null,
          lastChecked: "2026-09-24T08:00:01.000Z",
        },
      },
    };
    render(<AddressBookPage />);

    const warning = screen.getByTestId("address-book-google-places-warning");
    expect(warning).toHaveTextContent("Google Places (New) is unavailable");
    expect(warning).toHaveTextContent("skip Google Places after its configuration failure");
    expect(warning).toHaveTextContent("Nominatim when it is healthy");
    expect(warning).toHaveTextContent("checkout_ready rules are unchanged");
  });

  it("shows durable in-progress outcome totals", () => {
    uiState.reverificationRun = {
      id: "run-1",
      status: "RUNNING",
      queued: 4,
      running: 1,
      succeeded: 3,
      verified: 1,
      repaired: 2,
      cleared: 2,
      invalid: 2,
      unresolved: 1,
      failed: 1,
      provider_failures: 1,
      protected: 2,
      skipped: 2,
      total: 14,
    };
    render(<AddressBookPage />);

    const progress = screen.getByTestId("address-reverification-progress");
    expect(progress).toHaveTextContent("AI address reverification in progress");
    expect(progress).toHaveTextContent("1 verified");
    expect(progress).toHaveTextContent("2 repaired");
    expect(progress).toHaveTextContent("2 cleared");
    expect(progress).toHaveTextContent("2 invalid");
    expect(progress).toHaveTextContent("1 unresolved");
    expect(progress).toHaveTextContent("2 protected");
    expect(progress).toHaveTextContent("1 provider failures");
    expect(progress).toHaveTextContent("5 remaining");
  });

  it("shows the terminal failed count and latest failure reason", () => {
    uiState.reverificationRun = {
      id: "run-failed",
      status: "COMPLETED",
      queued: 0,
      running: 0,
      succeeded: 0,
      verified: 0,
      repaired: 0,
      cleared: 0,
      invalid: 0,
      unresolved: 0,
      failed: 1,
      provider_failures: 1,
      failure_reason: "Nominatim returned HTTP 503",
      protected: 0,
      skipped: 0,
      total: 1,
    };
    render(<AddressBookPage />);

    const progress = screen.getByTestId("address-reverification-progress");
    expect(progress).toHaveTextContent("AI address reverification previous run complete");
    expect(progress).toHaveTextContent("1 failed · Nominatim returned HTTP 503");
  });

  it("does not show a resolved historical outage while a run is active", () => {
    uiState.reverificationRun = {
      id: "run-2",
      status: "RUNNING",
      paused_reason: "could not determine data type of parameter $4",
      paused_until: null,
      outage_provider: "Map provider",
      queued: 1,
      running: 0,
      succeeded: 0,
      verified: 0,
      repaired: 0,
      cleared: 0,
      invalid: 0,
      unresolved: 0,
      failed: 0,
      provider_failures: 0,
      protected: 0,
      skipped: 0,
      total: 1,
    };
    render(<AddressBookPage />);

    const progress = screen.getByTestId("address-reverification-progress");
    expect(progress).toHaveTextContent("AI address reverification in progress");
    expect(progress).not.toHaveTextContent("could not determine data type");
    expect(progress).not.toHaveTextContent("provider outage");
  });
});

describe("Address Book bulk checkout activation", () => {
  it("shows the owner action and safe confirmation copy", async () => {
    const user = userEvent.setup();
    render(<AddressBookPage />);

    await user.click(screen.getByRole("button", { name: "Activate checkout for verified places" }));

    expect(screen.getByRole("heading", { name: "Activate checkout for verified places?" })).toBeInTheDocument();
    expect(screen.getByText(/only for active places verified by AI, staff, or delivery/i)).toBeInTheDocument();
    expect(screen.getByText(/coordinates and no location conflict/i)).toBeInTheDocument();
    expect(screen.getByText(/archived places will not be changed/i)).toBeInTheDocument();
  });

  it("hides the owner action from non-owners", () => {
    uiState.realIsOwner = false;
    render(<AddressBookPage />);

    expect(screen.queryByRole("button", { name: "Activate checkout for verified places" })).not.toBeInTheDocument();
  });

  it("reports the server totals and refreshes the Address Book after success", async () => {
    const user = userEvent.setup();
    mockApiFetch.mockResolvedValue({
      success: true,
      activated: 3,
      already_active: 4,
      skipped: 2,
      blockers: { verification_state: 1, location_conflict: 1, coordinates: 1 },
    });
    mockUseMutation.mockImplementation((options: MockMutationOptions) => ({
      mutate: () => {
        void options.mutationFn().then(options.onSuccess).catch(options.onError);
      },
      isPending: false,
    }));

    render(<AddressBookPage />);
    await user.click(screen.getByRole("button", { name: "Activate checkout for verified places" }));
    await user.click(screen.getByRole("button", { name: "Activate checkout" }));

    await waitFor(() => {
      expect(mockToast).toHaveBeenCalledWith(expect.objectContaining({
        title: "Checkout activation complete",
        description: "3 activated · 4 already active · 2 skipped because a safety condition was not met.",
      }));
    });
    expect(mockApiFetch).toHaveBeenCalledWith(
      "/api/address-book/places/activate-checkout",
      { method: "POST" },
    );
    expect(mockInvalidateQueries).toHaveBeenCalledWith({ queryKey: ["address-book-places"] });
  });

  it("keeps a failed request visible through the destructive toast", async () => {
    const user = userEvent.setup();
    mockApiFetch.mockRejectedValue(new Error("request failed"));
    mockUseMutation.mockImplementation((options: MockMutationOptions) => ({
      mutate: () => {
        void options.mutationFn().then(options.onSuccess).catch(options.onError);
      },
      isPending: false,
    }));

    render(<AddressBookPage />);
    await user.click(screen.getByRole("button", { name: "Activate checkout for verified places" }));
    await user.click(screen.getByRole("button", { name: "Activate checkout" }));

    await waitFor(() => {
      expect(mockToast).toHaveBeenCalledWith(expect.objectContaining({
        title: "Unable to activate checkout",
        variant: "destructive",
      }));
    });
    expect(mockInvalidateQueries).not.toHaveBeenCalled();
  });
});

describe("Address Book pagination URL state", () => {
  it("uses the workspace delivery timestamp instead of place updated_at", () => {
    render(<AddressBookPage />);

    expect(screen.getByTestId("address-book-last-delivered-place-1")).toHaveAttribute(
      "title",
      "2026-08-20T10:00:00.000Z",
    );
    expect(screen.getAllByText("Checkout ready")).toHaveLength(2);
  });

  it("loads the page from a deep link while preserving unrelated parameters", () => {
    wouterState.params.current = new URLSearchParams("page=2&source=review-queue");

    render(<AddressBookPage />);

    expect(addressBookQueryKey().at(-1)).toBe(2);
    expect(screen.getByText("51–100 of 101 places")).toBeInTheDocument();
  });

  it.each(["invalid", "0", "-1", "2.5", "1e2", "9007199254740992"])(
    "falls back to page 1 for invalid page=%s",
    (invalidPage) => {
      wouterState.params.current = new URLSearchParams(`page=${invalidPage}`);

      render(<AddressBookPage />);

      expect(addressBookQueryKey().at(-1)).toBe(1);
      expect(screen.getByText("Place 1")).toBeInTheDocument();
    },
  );

  it("normalizes a stale page to the last available page", async () => {
    wouterState.params.current = new URLSearchParams("page=99&source=shared-link");

    render(<AddressBookPage />);

    await waitFor(() => {
      expect(wouterState.params.current.get("page")).toBe("3");
    });
    expect(addressBookQueryKey().at(-1)).toBe(3);
    expect(wouterState.params.current.get("source")).toBe("shared-link");
  });

  it("updates only page in the URL when navigating between pages", async () => {
    wouterState.params.current = new URLSearchParams("page=2&source=shared-link");

    render(<AddressBookPage />);

    fireEvent.click(screen.getByRole("button", { name: "Previous" }));
    expect(window.location.pathname).toBe("/address-book");
    expect(window.location.search).toBe("?page=1&source=shared-link");
    expect(addressBookQueryKey().at(-1)).toBe(1);

    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    expect(window.location.search).toBe("?page=2&source=shared-link");
    expect(addressBookQueryKey().at(-1)).toBe(2);
  });

  it("resets to page 1 for search, tab, and dropdown filter changes", async () => {
    const user = userEvent.setup();
    wouterState.params.current = new URLSearchParams("page=2&source=shared-link");

    render(<AddressBookPage />);

    fireEvent.change(
      screen.getByPlaceholderText("Search name, alias, area, contact…"),
      { target: { value: "Main" } },
    );
    expect(wouterState.params.current.get("page")).toBe("1");
    expect(wouterState.params.current.get("source")).toBe("shared-link");

    await user.click(screen.getAllByRole("combobox")[0]);
    await user.click(screen.getByRole("option", { name: "North" }));
    expect(wouterState.params.current.get("page")).toBe("1");

    await user.click(screen.getAllByRole("combobox")[1]);
    await user.click(screen.getByRole("option", { name: "Unverified" }));
    expect(wouterState.params.current.get("page")).toBe("1");

    await user.click(screen.getAllByRole("combobox")[2]);
    await user.click(screen.getByRole("option", { name: "Residence" }));
    expect(wouterState.params.current.get("page")).toBe("1");

    await user.click(screen.getByRole("button", { name: "Needs review" }));
    expect(wouterState.params.current.get("page")).toBe("1");
    await waitFor(() => expect(addressBookQueryKey().at(-1)).toBe(1));
  });
});
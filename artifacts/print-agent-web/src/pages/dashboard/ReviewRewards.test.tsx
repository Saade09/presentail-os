import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, within, waitFor } from "@testing-library/react";

function clickTab(testId: string) {
  const trigger = screen.getByTestId(testId);
  // Radix Tabs activate on mousedown (jsdom has no PointerEvent support).
  fireEvent.mouseDown(trigger, { button: 0 });
  fireEvent.click(trigger);
}
import ReviewRewardsPage from "./ReviewRewards";
import { apiFetch } from "@/lib/queryClient";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockUseQuery = vi.fn();
const mockUseMutation = vi.fn();

vi.mock("@tanstack/react-query", () => ({
  useQuery: (opts: { queryKey: unknown[] }) => mockUseQuery(opts),
  useMutation: (opts: unknown) => mockUseMutation(opts),
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
}));

vi.mock("@/lib/queryClient", () => ({
  apiFetch: vi.fn(),
  queryClient: { invalidateQueries: vi.fn() },
}));

vi.mock("@/hooks/use-toast", () => ({
  useToast: () => ({ toast: vi.fn() }),
}));

const mockUseWorkspaceRole = vi.fn();
vi.mock("@/hooks/use-workspace-role", () => ({
  useWorkspaceRole: () => mockUseWorkspaceRole(),
}));

// Recharts renders nothing meaningful in jsdom; stub the chart container.
vi.mock("@/components/ui/chart", () => ({
  ChartContainer: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="chart-container">{children}</div>
  ),
  ChartTooltip: () => null,
  ChartTooltipContent: () => null,
  ChartLegend: () => null,
  ChartLegendContent: () => null,
}));
vi.mock("recharts", () => ({
  LineChart: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
  Line: () => null,
  CartesianGrid: () => null,
  XAxis: () => null,
  YAxis: () => null,
}));

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const overview = {
  days: 30,
  scans: 120,
  flaggedScans: 3,
  newReviews: 40,
  matchedReviews: 25,
  needsReview: 2,
  conversionRate: 20.8,
  rewardsByStatus: {
    pending: { count: 5, totalAmount: 25 },
    approved: { count: 4, totalAmount: 20 },
    paid: { count: 10, totalAmount: 50 },
  },
};

const profile = {
  id: 1,
  employeeName: "Layla",
  role: "Florist",
  rewardAmount: 5,
  code: "abc123",
  trackingUrl: "https://os.example.com/api/reviews/e/abc123",
  trackingPath: "/api/reviews/e/abc123",
  isActive: true,
  // Explicit cast so spread overrides (e.g. gbpLocationId: 42) are assignable.
  gbpLocationId: null as number | null,
  createdAt: "2026-08-01T00:00:00Z",
  updatedAt: "2026-08-01T00:00:00Z",
};

const pausedProfile = { ...profile, id: 2, employeeName: "Omar", isActive: false };

const review = {
  id: 11,
  reviewer_name: "Sara",
  rating: 5,
  comment: "Amazing flowers!",
  review_created_at: "2026-08-10T12:00:00Z",
  match_status: "needs_review",
  matched_employee_name: null,
  matched_scan_id: null,
};

const matchedReview = {
  ...review,
  id: 12,
  match_status: "auto_matched",
  matched_employee_name: "Layla",
};

const reward = {
  id: 21,
  amount: "5.00",
  status: "approved",
  pending_until: "2026-08-17T12:00:00Z",
  approved_at: "2026-08-17T12:00:00Z",
  paid_at: null,
  created_at: "2026-08-10T12:00:00Z",
  employee_name: "Layla",
  reviewer_name: "Sara",
  rating: 5,
};

const connectedLocation = {
  name: "locations/123456",
  title: "Presentail Hamra",
  address: "Hamra Street 12, Beirut",
  verified: true,
  accountName: "accounts/1",
  accountLabel: "Presentail",
  selected: true,
  connectionStatus: "connected" as const,
  connectionId: 7,
  isEnabled: true,
  lastSyncedAt: "2026-08-20T10:00:00Z",
  lastError: null,
};

function setupQueries({
  gbpConnected = true,
  connectedLocationCount = 1,
  profiles = [profile, pausedProfile],
  reviews = [review, matchedReview],
  rewards = [reward],
  accounts = [] as Array<{ name: string; accountName: string | null; type: string | null }>,
  connectedAccount = null as { name: string | null; label: string | null } | null,
  locations = [] as Array<{
    name: string;
    title: string;
    address?: string | null;
    locality?: string | null;
    verified: boolean | null;
    accountName: string;
    accountLabel: string;
    selected: boolean;
    is_enabled?: boolean;
    isEnabled?: boolean;
    status?: string;
    connectionStatus?: string;
    connectionId?: number | null;
    locationId?: number | null;
    lastSyncedAt?: string | null;
    lastError?: string | null;
    availableInGoogle?: boolean;
  }>,
  locationsPerformance = [] as Array<{
    locationId: number;
    locationTitle: string | null;
    locationLocality?: string | null;
    googleStatus: string | null;
    syncStatus: string | null;
    lastSyncedAt: string | null;
    reviewCount: number;
    scanCount: number;
    conversionRate: number;
    rewardsEarned: number;
  }>,
  locationsPerformanceLoading = false,
  errorKey = null as string | null,
} = {}) {
  mockUseMutation.mockReturnValue({ mutate: vi.fn(), isPending: false });
  mockUseQuery.mockImplementation((opts: { queryKey: unknown[] }) => {
    const key = opts.queryKey[0];
    const key2 = opts.queryKey[1];
    if (key === errorKey) {
      return {
        data: undefined,
        isLoading: false,
        isError: true,
        error: new Error("Forbidden"),
      };
    }
    switch (key) {
      case "gbp-status":
        return {
          data: {
            connected: gbpConnected,
            locationSelected: gbpConnected,
            locationTitle: gbpConnected ? "Presentail" : null,
            connectedLocationCount: gbpConnected ? connectedLocationCount : 0,
            enabledCount: gbpConnected ? connectedLocationCount : 0,
          },
          isLoading: false,
        };
      case "gbp-locations":
        return { data: { locations, accounts, connectedAccount }, isLoading: false, isError: false };
      case "review-rewards-overview":
        // Per-location row queries have a numeric locationId as key[1]
        if (key2 != null) {
          return { data: { ...overview, conversionRate: 0.5 }, isLoading: false };
        }
        return { data: overview, isLoading: false };
      case "review-rewards-trend":
        return {
          data: { series: [{ day: "2026-08-01", scans: 4, matchedReviews: 1 }] },
          isLoading: false,
        };
      case "review-rewards-employees":
        return {
          data: {
            employees: [
              {
                id: 1,
                employee_name: "Layla",
                role: "Florist",
                is_active: true,
                scans: 60,
                matched_reviews: 15,
                pending_amount: "10.00",
                approved_amount: "5.00",
                paid_amount: "25.00",
              },
            ],
          },
          isLoading: false,
        };
      case "review-rewards-latest-matches":
        return {
          data: {
            matches: [
              {
                id: 12,
                reviewer_name: "Sara",
                rating: 5,
                comment: "Amazing flowers!",
                review_created_at: "2026-08-10T12:00:00Z",
                match_status: "auto_matched",
                match_resolved_at: "2026-08-10T13:00:00Z",
                employee_name: "Layla",
              },
            ],
          },
          isLoading: false,
        };
      case "review-rewards-profiles":
        return { data: { profiles }, isLoading: false };
      case "review-rewards-reviews":
        return { data: { reviews }, isLoading: false };
      case "review-rewards-rewards":
        return { data: { rewards }, isLoading: false };
      case "review-rewards-qr":
        return {
          data: { trackingUrl: profile.trackingUrl, qrDataUrl: "data:image/png;base64,abc" },
          isLoading: false,
        };
      case "review-rewards-locations-performance":
        return {
          data: locationsPerformanceLoading ? undefined : { locations: locationsPerformance },
          isLoading: locationsPerformanceLoading,
        };
      default:
        return { data: undefined, isLoading: false };
    }
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockUseWorkspaceRole.mockReturnValue({ isOwner: true, allowedPages: null });
  setupQueries();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("ReviewRewardsPage — header", () => {
  it("renders the title, Google connected pill, and Add employee QR button", () => {
    render(<ReviewRewardsPage />);
    expect(screen.getByTestId("page-title")).toBeInTheDocument();
    expect(screen.getByTestId("google-status-connected")).toBeInTheDocument();
    expect(screen.getByTestId("button-add-employee-qr")).toBeInTheDocument();
  });

  it("shows a not-connected pill when Google is not connected", () => {
    setupQueries({ gbpConnected: false });
    render(<ReviewRewardsPage />);
    expect(screen.getByTestId("google-status-disconnected")).toBeInTheDocument();
  });

  it("shows an explicit Google status error instead of a not-connected state", () => {
    setupQueries({ errorKey: "gbp-status" });
    render(<ReviewRewardsPage />);
    expect(screen.getByTestId("google-status-error")).toHaveTextContent("Forbidden");
    expect(screen.queryByTestId("google-status-disconnected")).toBeNull();
  });

  it("disables Add employee QR while location data is loading to prevent unscoped creation", () => {
    setupQueries({ locationsPerformanceLoading: true });
    render(<ReviewRewardsPage />);
    expect(screen.getByTestId("button-add-employee-qr")).toBeDisabled();
  });

  it("shows the timing-based attribution disclaimer", () => {
    render(<ReviewRewardsPage />);
    expect(screen.getByTestId("attribution-note")).toBeInTheDocument();
  });

  it("hides the Add employee QR button for non-owners", () => {
    mockUseWorkspaceRole.mockReturnValue({ isOwner: false, allowedPages: ["review-rewards"] });
    render(<ReviewRewardsPage />);
    expect(screen.queryByTestId("button-add-employee-qr")).toBeNull();
  });

  it("lets owners open the masked Google credentials editor", () => {
    render(<ReviewRewardsPage />);
    fireEvent.click(screen.getByTestId("button-gbp-manage-credentials"));
    expect(screen.getByTestId("gbp-credentials-dialog")).toBeInTheDocument();
    expect(screen.getByTestId("input-gbp-client-id")).toBeInTheDocument();
    expect(screen.getByTestId("input-gbp-client-secret")).toHaveAttribute("type", "password");
  });

  it("does not expose Google credential management to non-owners", () => {
    mockUseWorkspaceRole.mockReturnValue({ isOwner: false, allowedPages: ["review-rewards"] });
    render(<ReviewRewardsPage />);
    expect(screen.queryByTestId("button-gbp-manage-credentials")).toBeNull();
  });

  it("shows each Google Business branch address in the manage locations dialog", () => {
    setupQueries({
      locations: [{
        name: "locations/123456",
        title: "Presentail",
        address: "Hamra Street 12, Beirut",
        verified: true,
        accountName: "accounts/1",
        accountLabel: "Presentail",
        selected: true,
        is_enabled: true,
      }],
    });
    render(<ReviewRewardsPage />);
    fireEvent.click(screen.getByTestId("button-gbp-manage-locations"));

    expect(screen.getByText("Hamra Street 12, Beirut")).toBeInTheDocument();
    expect(screen.getByText("Google location ID: 123456")).toBeInTheDocument();
  });

  it("shows account context and a reconnect action when Google returns no locations", () => {
    setupQueries({
      locations: [],
      accounts: [{
        name: "accounts/104558980916656984052",
        accountName: "Ahmad Saade",
        type: "PERSONAL",
      }],
      connectedAccount: {
        name: "accounts/104558980916656984052",
        label: "Ahmad Saade",
      },
    });
    render(<ReviewRewardsPage />);
    fireEvent.click(screen.getByTestId("button-gbp-manage-locations"));

    expect(screen.getByTestId("gbp-no-locations")).toHaveTextContent(
      "Google returned no accessible Business Profile locations",
    );
    expect(screen.getByTestId("gbp-account-context")).toHaveTextContent("Ahmad Saade");
    expect(screen.getByTestId("gbp-account-context")).toHaveTextContent(
      "accounts/104558980916656984052",
    );
    expect(screen.getByTestId("button-gbp-reconnect")).toBeInTheDocument();
    expect(screen.getByTestId("button-gbp-location-save")).toBeDisabled();
  });

  it("allows selection when Google omits verification metadata", () => {
    setupQueries({
      locations: [{
        ...connectedLocation,
        verified: null,
        selected: false,
        isEnabled: false,
        is_enabled: false,
        connectionStatus: "available",
      }],
    });
    render(<ReviewRewardsPage />);
    fireEvent.click(screen.getByTestId("button-gbp-manage-locations"));

    const checkbox = screen.getByTestId("checkbox-location-123456");
    expect(checkbox).not.toBeDisabled();
    fireEvent.click(checkbox);
    expect(checkbox).toBeChecked();
    expect(screen.getByTestId("button-gbp-location-save")).toBeEnabled();
  });

  it("shows the actionable server error when Google locations cannot be loaded", () => {
    setupQueries({ errorKey: "gbp-locations" });
    render(<ReviewRewardsPage />);
    fireEvent.click(screen.getByTestId("button-gbp-manage-locations"));

    expect(screen.getByRole("alert")).toHaveTextContent("Forbidden");
    expect(screen.getByTestId("button-gbp-load-error-reconnect")).toBeInTheDocument();
  });

  it("shows unavailable tracked locations and preserves healthy selections while resolving them", () => {
    setupQueries({
      connectedLocationCount: 3,
      locations: [
        connectedLocation,
        {
          ...connectedLocation,
          name: "locations/beirut",
          title: "Presentail",
          locality: "Beirut",
          address: null,
          verified: false,
          connectionId: 8,
          connectionStatus: "needs_attention",
          availableInGoogle: false,
          lastError: "Google location is unavailable",
        },
        {
          ...connectedLocation,
          name: "locations/dubai",
          title: "Presentail",
          locality: "Dubai",
          address: null,
          verified: false,
          connectionId: 9,
          connectionStatus: "needs_attention",
          availableInGoogle: false,
        },
      ],
    });
    render(<ReviewRewardsPage />);
    fireEvent.click(screen.getByTestId("button-gbp-manage-locations"));

    expect(screen.getByText("Presentail — Beirut")).toBeInTheDocument();
    expect(screen.getByText("Presentail — Dubai")).toBeInTheDocument();
    expect(screen.getAllByText(/Google no longer returns this tracked location/)).toHaveLength(2);
    expect(screen.getByTestId("checkbox-location-123456")).toBeChecked();
    expect(screen.getByTestId("checkbox-location-beirut")).toBeChecked();
    expect(screen.getByTestId("button-gbp-reconnect")).toBeInTheDocument();
    expect(screen.getByTestId("button-gbp-location-save")).toBeDisabled();

    fireEvent.click(screen.getByTestId("checkbox-location-beirut"));
    fireEvent.click(screen.getByTestId("checkbox-location-dubai"));

    expect(screen.getByTestId("checkbox-location-123456")).toBeChecked();
    expect(screen.getByTestId("button-gbp-location-save")).toBeEnabled();
  });

  it("lets owners remove the final unavailable tracked location", () => {
    setupQueries({
      connectedLocationCount: 1,
      locations: [{
        ...connectedLocation,
        name: "locations/beirut",
        title: "Presentail",
        locality: "Beirut",
        address: null,
        verified: false,
        connectionStatus: "needs_attention",
        availableInGoogle: false,
      }],
    });
    render(<ReviewRewardsPage />);
    fireEvent.click(screen.getByTestId("button-gbp-manage-locations"));

    expect(screen.getByTestId("button-gbp-location-save")).toBeDisabled();
    fireEvent.click(screen.getByTestId("checkbox-location-beirut"));
    expect(screen.getByTestId("button-gbp-location-save")).toBeEnabled();
  });

  it("shows the aggregate location count badge when connected", () => {
    setupQueries({ gbpConnected: true, connectedLocationCount: 6 });
    render(<ReviewRewardsPage />);
    const badge = screen.getByTestId("google-status-connected");
    expect(badge).toHaveTextContent("6 locations");
  });

  it("shows Manage locations button instead of Change location for owners", () => {
    render(<ReviewRewardsPage />);
    expect(screen.getByTestId("button-gbp-manage-locations")).toBeInTheDocument();
    expect(screen.queryByTestId("button-gbp-change-location")).toBeNull();
  });

  it("communicates a connected account with no tracked location to a permitted member", () => {
    mockUseWorkspaceRole.mockReturnValue({ isOwner: false, allowedPages: ["review-rewards"] });
    setupQueries({ gbpConnected: true, connectedLocationCount: 0, locationsPerformance: [] });
    render(<ReviewRewardsPage />);

    expect(screen.getByTestId("google-status-connected")).toHaveTextContent("Location not set");
    clickTab("tab-locations");
    expect(screen.getByText("No locations tracked — add locations via Manage locations.")).toBeInTheDocument();
    expect(screen.queryByTestId("button-manage-locations-tab")).toBeNull();
  });
});

describe("ReviewRewardsPage — overview tab", () => {
  it("shows an actionable load error instead of silently presenting failed data as empty", () => {
    setupQueries({ errorKey: "review-rewards-overview" });
    render(<ReviewRewardsPage />);
    expect(screen.getByTestId("review-rewards-load-error")).toHaveTextContent("Forbidden");
  });

  it("renders stat cards with metric values", () => {
    render(<ReviewRewardsPage />);
    expect(screen.getByTestId("stat-new-reviews")).toHaveTextContent("40");
    expect(screen.getByTestId("stat-qr-scans")).toHaveTextContent("120");
    expect(screen.getByTestId("stat-conversion")).toHaveTextContent("20.8%");
    // 25 pending + 20 approved + 50 paid = 95
    expect(screen.getByTestId("stat-rewards-earned")).toHaveTextContent("$95.00");
  });

  it("renders the trend chart, latest matches, and employee performance table", () => {
    render(<ReviewRewardsPage />);
    expect(screen.getByTestId("chart-container")).toBeInTheDocument();
    expect(screen.getByTestId("latest-match-12")).toHaveTextContent("Sara");
    const perfRow = screen.getByTestId("perf-row-1");
    expect(perfRow).toHaveTextContent("Layla");
    expect(perfRow).toHaveTextContent("60");
    expect(perfRow).toHaveTextContent("25.0%"); // 15/60 conversion
    expect(perfRow).toHaveTextContent("$40.00"); // 10 + 5 + 25
  });

  it("renders the Locations tab trigger", () => {
    render(<ReviewRewardsPage />);
    expect(screen.getByTestId("tab-locations")).toBeInTheDocument();
  });

  it("does not render locations performance table when fewer than 2 locations", () => {
    setupQueries({
      locationsPerformance: [{
        locationId: 1,
        locationTitle: "Presentail",
        googleStatus: null,
        syncStatus: null,
        lastSyncedAt: null,
        reviewCount: 10,
        scanCount: 50,
        conversionRate: 0.2,
        rewardsEarned: 25,
      }],
    });
    render(<ReviewRewardsPage />);
    expect(screen.queryByTestId("button-see-all-locations")).toBeNull();
  });

  it("renders the locations performance table when 2+ locations are tracked", () => {
    setupQueries({
      locationsPerformance: [
        {
          locationId: 1,
          locationTitle: "Branch A",
          googleStatus: null,
          syncStatus: null,
          lastSyncedAt: null,
          reviewCount: 10,
          scanCount: 50,
          conversionRate: 0.2,
          rewardsEarned: 25,
        },
        {
          locationId: 2,
          locationTitle: "Branch B",
          googleStatus: "Last sync error",
          syncStatus: null,
          lastSyncedAt: null,
          reviewCount: 5,
          scanCount: 20,
          conversionRate: 0.25,
          rewardsEarned: 10,
        },
      ],
    });
    render(<ReviewRewardsPage />);
    expect(screen.getByTestId("button-see-all-locations")).toBeInTheDocument();
    expect(screen.getByTestId("location-row-1")).toHaveTextContent("Branch A");
    expect(screen.getByTestId("location-row-2")).toHaveTextContent("Branch B");
  });

  it("uses location areas to distinguish repeated branch titles across shared surfaces", () => {
    setupQueries({
      locationsPerformance: [
        {
          locationId: 1,
          locationTitle: "Presentail",
          locationLocality: "Beirut",
          googleStatus: null,
          syncStatus: null,
          lastSyncedAt: null,
          reviewCount: 10,
          scanCount: 50,
          conversionRate: 0.2,
          rewardsEarned: 25,
        },
        {
          locationId: 2,
          locationTitle: "Presentail",
          locationLocality: "Dubai",
          googleStatus: null,
          syncStatus: null,
          lastSyncedAt: null,
          reviewCount: 5,
          scanCount: 20,
          conversionRate: 0.25,
          rewardsEarned: 10,
        },
      ],
    });
    render(<ReviewRewardsPage />);

    expect(screen.getByTestId("location-row-1")).toHaveTextContent("Presentail — Beirut");
    expect(screen.getByTestId("location-row-2")).toHaveTextContent("Presentail — Dubai");

    fireEvent.mouseDown(screen.getByTestId("select-location-filter"), { button: 0 });
    fireEvent.click(screen.getByTestId("select-location-filter"));
    expect(screen.getAllByText("Presentail — Beirut").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Presentail — Dubai").length).toBeGreaterThan(0);

    clickTab("tab-locations");
    expect(screen.getByTestId("location-row-1")).toHaveTextContent("Presentail — Beirut");
    expect(screen.getByTestId("location-row-2")).toHaveTextContent("Presentail — Dubai");

    fireEvent.click(screen.getByTestId("button-add-employee-qr"));
    fireEvent.mouseDown(screen.getByTestId("select-employee-location"), { button: 0 });
    fireEvent.click(screen.getByTestId("select-employee-location"));
    expect(screen.getAllByText("Presentail — Beirut").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Presentail — Dubai").length).toBeGreaterThan(0);
  });
});

describe("ReviewRewardsPage — locations tab", () => {
  it("is accessible via the locations tab trigger", () => {
    render(<ReviewRewardsPage />);
    expect(screen.getByTestId("tab-locations")).toBeInTheDocument();
  });
});

describe("ReviewRewardsPage — manage locations dialog", () => {
  it("uses checkboxes instead of radio buttons", () => {
    setupQueries({
      locations: [
        {
          name: "locations/1",
          title: "Branch A",
          verified: true,
          accountName: "accounts/1",
          accountLabel: "Branch A",
          selected: true,
          is_enabled: true,
        },
        {
          name: "locations/2",
          title: "Branch B",
          verified: true,
          accountName: "accounts/1",
          accountLabel: "Branch B",
          selected: false,
          is_enabled: false,
        },
      ],
    });
    render(<ReviewRewardsPage />);
    fireEvent.click(screen.getByTestId("button-gbp-manage-locations"));

    // Should have checkboxes (not radio buttons)
    expect(screen.getByTestId("checkbox-select-all-locations")).toBeInTheDocument();
    expect(screen.queryByRole("radio")).toBeNull();
  });
});

describe("ReviewRewardsPage — employee QR codes tab", () => {
  function openTab() {
    render(<ReviewRewardsPage />);
    clickTab("tab-employees");
  }

  function openAddDialog() {
    render(<ReviewRewardsPage />);
    fireEvent.click(screen.getByTestId("button-add-employee-qr"));
  }

  it("lists employee QR codes with name, code, QR preview, and status", () => {
    openTab();
    const row = screen.getByTestId("employee-row-1");
    expect(row).toHaveTextContent("Layla");
    expect(row).toHaveTextContent("abc123");
    expect(screen.getByTestId("qr-preview-1")).toBeInTheDocument();
    expect(screen.getByTestId("employee-row-2")).toHaveTextContent("Omar");
  });

  it("shows download, copy, edit, and pause/reactivate actions for owners", () => {
    openTab();
    expect(screen.getByTestId("button-download-qr-1")).toBeInTheDocument();
    expect(screen.getByTestId("button-copy-link-1")).toBeInTheDocument();
    expect(screen.getByTestId("button-edit-employee-1")).toBeInTheDocument();
    expect(screen.getByTestId("button-toggle-employee-1")).toBeInTheDocument();
  });

  it("keeps QR read actions visible but hides profile mutations for non-owners", () => {
    mockUseWorkspaceRole.mockReturnValue({ isOwner: false, allowedPages: ["review-rewards"] });
    openTab();
    expect(screen.getByTestId("button-download-qr-1")).toBeInTheDocument();
    expect(screen.getByTestId("button-copy-link-1")).toBeInTheDocument();
    expect(screen.queryByTestId("button-edit-employee-1")).toBeNull();
    expect(screen.queryByTestId("button-toggle-employee-1")).toBeNull();
  });

  it("shows an explicit error when a QR preview cannot be loaded", () => {
    setupQueries({ errorKey: "review-rewards-qr" });
    render(<ReviewRewardsPage />);
    clickTab("tab-employees");
    expect(screen.getByTestId("qr-error-1")).toHaveAttribute("title", expect.stringContaining("Forbidden"));
  });

  it("opens the Add/Edit dialog when clicking edit", () => {
    openTab();
    fireEvent.click(screen.getByTestId("button-edit-employee-1"));
    expect(screen.getByTestId("employee-dialog")).toBeInTheDocument();
    expect(screen.getByTestId("employee-name-readonly")).toHaveTextContent("Layla");
  });

  it("allows changing an employee location without replacing the QR barcode", async () => {
    // Profile assigned to location 42
    const profileWithLocation = {
      ...profile,
      gbpLocationId: 42,
    };
    setupQueries({
      profiles: [profileWithLocation],
      locationsPerformance: [
        {
          locationId: 42,
          locationTitle: "Downtown Branch",
          googleStatus: null,
          syncStatus: null,
          lastSyncedAt: null,
          reviewCount: 5,
          scanCount: 20,
          conversionRate: 0.25,
          rewardsEarned: 10,
        },
        {
          locationId: 43,
          locationTitle: "Uptown Branch",
          googleStatus: null,
          syncStatus: null,
          lastSyncedAt: null,
          reviewCount: 2,
          scanCount: 8,
          conversionRate: 0.25,
          rewardsEarned: 5,
        },
      ],
    });
    mockUseMutation.mockImplementation((opts: unknown) => ({
      mutate: () => void (opts as { mutationFn: () => unknown }).mutationFn(),
      isPending: false,
    }));
    render(<ReviewRewardsPage />);
    clickTab("tab-employees");
    fireEvent.click(screen.getByTestId("button-edit-employee-1"));
    expect(screen.getByTestId("employee-dialog")).toBeInTheDocument();
    expect(screen.getByTestId("select-employee-location")).toHaveTextContent("Downtown Branch");
    expect(screen.getByTestId("employee-location-barcode-note")).toHaveTextContent(
      "barcode will stay the same",
    );

    fireEvent.mouseDown(screen.getByTestId("select-employee-location"), { button: 0 });
    fireEvent.click(screen.getByTestId("select-employee-location"));
    fireEvent.click(await screen.findByText("Uptown Branch"));
    fireEvent.click(screen.getByTestId("button-save-employee"));

    await waitFor(() => {
      expect(vi.mocked(apiFetch)).toHaveBeenCalledWith(
        "/api/review-rewards/profiles/1",
        expect.objectContaining({
          method: "PATCH",
          body: expect.stringContaining('"gbpLocationId":43'),
        }),
      );
    });
    const patchCall = vi.mocked(apiFetch).mock.calls.find(
      ([url]) => url === "/api/review-rewards/profiles/1",
    );
    expect(patchCall?.[1]?.body).not.toContain("code");
    expect(profile.code).toBe("abc123");
  });

  it("shows an empty state when there are no employees", () => {
    setupQueries({ profiles: [] });
    openTab();
    expect(screen.getByText("No employee QR codes yet")).toBeInTheDocument();
  });
});

describe("ReviewRewardsPage — review activity tab", () => {
  function openTab() {
    render(<ReviewRewardsPage />);
    clickTab("tab-activity");
  }

  it("lists reviews with match status chips", () => {
    openTab();
    expect(screen.getByTestId("review-row-11")).toHaveTextContent("Sara");
    expect(screen.getByTestId("chip-match-needs_review")).toBeInTheDocument();
    expect(screen.getByTestId("chip-match-auto_matched")).toBeInTheDocument();
    expect(screen.getByTestId("review-row-12")).toHaveTextContent("Layla");
  });

  it("shows the resolve action only for needs-review rows and opens the dialog", () => {
    openTab();
    expect(screen.getByTestId("button-resolve-11")).toBeInTheDocument();
    expect(screen.queryByTestId("button-resolve-12")).toBeNull();
    fireEvent.click(screen.getByTestId("button-resolve-11"));
    expect(screen.getByTestId("resolve-dialog")).toBeInTheDocument();
    expect(screen.getByTestId("button-assign-review")).toBeDisabled();
    expect(screen.getByTestId("button-reject-review")).toBeEnabled();
  });

  it("hides the resolve action for non-owners", () => {
    mockUseWorkspaceRole.mockReturnValue({ isOwner: false, allowedPages: ["review-rewards"] });
    openTab();
    expect(screen.queryByTestId("button-resolve-11")).toBeNull();
  });
});

describe("ReviewRewardsPage — reward payouts tab", () => {
  function openTab() {
    render(<ReviewRewardsPage />);
    clickTab("tab-payouts");
  }

  it("shows payout summary cards and the rewards table with verification date", () => {
    openTab();
    expect(screen.getByTestId("stat-pending-amount")).toHaveTextContent("$25.00");
    expect(screen.getByTestId("stat-approved-amount")).toHaveTextContent("$20.00");
    expect(screen.getByTestId("stat-monthly-total")).toBeInTheDocument();
    const row = screen.getByTestId("reward-row-21");

  function openAddDialog() {
    render(<ReviewRewardsPage />);
    fireEvent.click(screen.getByTestId("button-add-employee-qr"));
  }
    expect(row).toHaveTextContent("Layla");
    expect(row).toHaveTextContent("$5.00");
    expect(screen.getByTestId("chip-reward-approved")).toBeInTheDocument();
  });

  it("shows a confirmation dialog before marking a reward paid", () => {
    openTab();
    fireEvent.click(screen.getByTestId("button-pay-21"));
    expect(screen.getByTestId("pay-dialog")).toBeInTheDocument();
    expect(screen.getByTestId("button-confirm-pay")).toBeEnabled();
  });

  it("hides the pay action for non-owners", () => {
    mockUseWorkspaceRole.mockReturnValue({ isOwner: false, allowedPages: ["review-rewards"] });
    openTab();
    expect(screen.queryByTestId("button-pay-21")).toBeNull();
  });
});

describe("ReviewRewardsPage — permitted member role matrix", () => {
  it("renders the complete read-only dataset and QR tools without owner-only controls", () => {
    mockUseWorkspaceRole.mockReturnValue({ isOwner: false, allowedPages: ["review-rewards"] });
    setupQueries({
      locationsPerformance: [
        {
          locationId: 1,
          locationTitle: "Branch A",
          googleStatus: "Sync needs attention",
          syncStatus: null,
          lastSyncedAt: null,
          reviewCount: 10,
          scanCount: 50,
          conversionRate: 0.2,
          rewardsEarned: 25,
        },
        {
          locationId: 2,
          locationTitle: "Branch B",
          googleStatus: null,
          syncStatus: null,
          lastSyncedAt: null,
          reviewCount: 5,
          scanCount: 20,
          conversionRate: 0.25,
          rewardsEarned: 10,
        },
      ],
    });
    render(<ReviewRewardsPage />);

    expect(screen.getByTestId("stat-new-reviews")).toHaveTextContent("40");
    expect(screen.getByTestId("chart-container")).toBeInTheDocument();
    expect(screen.getByTestId("latest-match-12")).toHaveTextContent("Sara");
    expect(screen.getByTestId("perf-row-1")).toHaveTextContent("Layla");
    expect(screen.getByTestId("location-row-1")).toHaveTextContent("Branch A");
    expect(screen.queryByTestId("button-fix-location-1")).toBeNull();
    expect(screen.queryByTestId("button-gbp-manage-locations")).toBeNull();
    expect(screen.queryByTestId("button-gbp-manage-credentials")).toBeNull();

    clickTab("tab-employees");
    expect(screen.getByTestId("employee-row-1")).toHaveTextContent("Layla");
    expect(screen.getByTestId("qr-preview-1")).toBeInTheDocument();
    expect(screen.getByTestId("button-download-qr-1")).toBeInTheDocument();
    expect(screen.getByTestId("button-copy-link-1")).toBeInTheDocument();
    expect(screen.queryByTestId("button-edit-employee-1")).toBeNull();
    expect(screen.queryByTestId("button-toggle-employee-1")).toBeNull();

    clickTab("tab-activity");
    expect(screen.getByTestId("review-row-11")).toHaveTextContent("Sara");
    expect(screen.queryByTestId("button-resolve-11")).toBeNull();

    clickTab("tab-payouts");
    expect(screen.getByTestId("reward-row-21")).toHaveTextContent("Layla");
    expect(screen.queryByTestId("button-pay-21")).toBeNull();
  });
});

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { TooltipProvider } from "@/components/ui/tooltip";
import DashboardLayout from "./Layout";
import i18n from "@/i18n";

const mockWouterLocation = vi.hoisted(() => ({ value: "/devices" }));
const mockApiFetch = vi.fn().mockResolvedValue({ seenIds: [] });
vi.mock("@/lib/queryClient", () => ({
  apiFetch: (...args: unknown[]) => mockApiFetch(...args),
  queryClient: new QueryClient(),
}));

const mockUseRecipeAttention = vi.fn().mockReturnValue({
  data: undefined,
  isError: false,
  isLoading: true,
});
vi.mock("@/hooks/use-recipe-attention", () => ({
  useRecipeAttention: (...args: unknown[]) => mockUseRecipeAttention(...args),
}));
const mockUsePendingOrdersCount = vi.fn().mockReturnValue(0);
vi.mock("@/hooks/use-pending-orders-count", () => ({
  usePendingOrdersCount: () => mockUsePendingOrdersCount(),
}));

const mockUseUser = vi.fn();
vi.mock("@clerk/react", () => ({
  useUser: () => mockUseUser(),
  useClerk: () => ({ signOut: vi.fn() }),
  useAuth: () => ({ getToken: vi.fn().mockResolvedValue("tok") }),
}));

vi.mock("wouter", () => ({
  useLocation: () => [mockWouterLocation.value, vi.fn()],
  Link: ({ href, children, ...rest }: { href: string; children: React.ReactNode; [key: string]: unknown }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

vi.mock("@/components/DataSaverBanner", () => ({
  DataSaverBanner: () => null,
}));

vi.mock("@/pages/omnichannel/useOmnichannelSSE", () => ({
  useOmnichannelSSE: () => ({ reconnecting: false, backOnline: false }),
}));

vi.mock("@/contexts/simulated-role-context", () => ({
  useSimulatedRole: () => ({ simulatedRole: null, setSimulatedRole: vi.fn() }),
}));

const mockUseWorkspaceRole = vi.fn();
vi.mock("@/hooks/use-workspace-role", () => ({
  useWorkspaceRole: () => mockUseWorkspaceRole(),
}));

const mockUseRoles = vi.fn();
vi.mock("@/hooks/use-roles", () => ({
  useRoles: () => mockUseRoles(),
}));

vi.mock("@/hooks/use-workspace-image-token", () => ({
  useWorkspaceImageToken: () => ({ ready: true }),
}));

const mockUsePendingAccessRequestCount = vi.fn().mockReturnValue(0);
vi.mock("@/hooks/use-pending-access-requests", () => ({
  usePendingAccessRequestCount: () => mockUsePendingAccessRequestCount(),
  usePendingAccessRequests: () => ({
    data: {
      requests: Array.from({ length: mockUsePendingAccessRequestCount() }, (_, i) => ({
        id: i + 1,
        requester_name: `User ${i + 1}`,
        requester_email: `user${i + 1}@example.com`,
        requester_clerk_id: `clerk_${i + 1}`,
        status: "pending",
        requested_at: new Date().toISOString(),
        resolved_at: null,
      })),
    },
  }),
}));

const mockUseFloristManualReviewCount = vi.fn().mockReturnValue(0);
vi.mock("@/hooks/use-florist-manual-review-count", () => ({
  useFloristManualReviewCount: (enabled: boolean) =>
    mockUseFloristManualReviewCount(enabled),
}));

const MOCK_USER = {
  id: "alice",
  firstName: "Alice",
  primaryEmailAddress: { emailAddress: "alice@example.com" },
};

function makeQueryClient() {
  return new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
}

function renderLayout() {
  const qc = makeQueryClient();
  const utils = render(
    <QueryClientProvider client={qc}>
      <TooltipProvider>
        <DashboardLayout>
          <div data-testid="children">content</div>
        </DashboardLayout>
      </TooltipProvider>
    </QueryClientProvider>,
  );
  const rerender = (children: React.ReactNode = <div data-testid="children">content</div>) =>
    utils.rerender(
      <QueryClientProvider client={qc}>
        <TooltipProvider>
          <DashboardLayout>{children}</DashboardLayout>
        </TooltipProvider>
      </QueryClientProvider>,
    );
  return { ...utils, rerender };
}

beforeEach(() => {
  delete (
    window as Window & {
      ReactNativeWebView?: { postMessage: (message: string) => void };
    }
  ).ReactNativeWebView;
  for (const userId of ["anonymous", "alice", "bob"]) {
    localStorage.removeItem(`sidebarCollapsed:${userId}`);
    localStorage.removeItem(`sidebarOpenGroups:${userId}`);
    localStorage.removeItem(`sidebarClosedGroups:${userId}`);
  }
});

describe("DashboardLayout – mobile handoff readiness", () => {
  it("notifies the native WebView after the authenticated layout mounts", () => {
    const postMessage = vi.fn();
    (
      window as Window & {
        ReactNativeWebView?: { postMessage: (message: string) => void };
      }
    ).ReactNativeWebView = { postMessage };
    mockUseUser.mockReturnValue({ user: MOCK_USER });
    mockUseRoles.mockReturnValue({ data: { roles: [] } });
    mockUseWorkspaceRole.mockReturnValue({
      isOwner: true,
      realIsOwner: true,
      allowedPages: null,
      customRoleId: null,
      customRoleIds: [],
      floristLocationId: null,
      loaded: true,
    });

    renderLayout();

    expect(postMessage).toHaveBeenCalledWith(
      JSON.stringify({ type: "presentail.dashboard.ready" }),
    );
  });
});

describe("DashboardLayout – View as role controls visibility", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUseUser.mockReturnValue({ user: null });
    mockUseRoles.mockReturnValue({ data: { roles: [] } });
  });

  it("does not show view-as-select or mobile-view-as-select for a designer", () => {
    mockUseWorkspaceRole.mockReturnValue({
      isOwner: false,
      realIsOwner: false,
      allowedPages: null,
      customRoleId: null,
      loaded: true,
    });

    renderLayout();

    expect(screen.queryByTestId("view-as-select")).not.toBeInTheDocument();
    expect(screen.queryByTestId("mobile-view-as-select")).not.toBeInTheDocument();
  });

  it("does not show view-as-select or mobile-view-as-select for a customer_service_agent", () => {
    mockUseWorkspaceRole.mockReturnValue({
      isOwner: false,
      realIsOwner: false,
      allowedPages: null,
      customRoleId: null,
      loaded: true,
    });

    renderLayout();

    expect(screen.queryByTestId("view-as-select")).not.toBeInTheDocument();
    expect(screen.queryByTestId("mobile-view-as-select")).not.toBeInTheDocument();
  });

  it("shows view-as-select and mobile-view-as-select for a real owner", () => {
    mockUseWorkspaceRole.mockReturnValue({
      isOwner: true,
      realIsOwner: true,
      allowedPages: null,
      customRoleId: null,
      loaded: true,
    });

    renderLayout();

    expect(screen.getByTestId("view-as-select")).toBeInTheDocument();
    expect(screen.getByTestId("mobile-view-as-select")).toBeInTheDocument();
  });

  it("shows 'Owner' role label for a real owner", () => {
    mockUseUser.mockReturnValue({ user: MOCK_USER });
    mockUseWorkspaceRole.mockReturnValue({
      isOwner: true,
      realIsOwner: true,
      allowedPages: null,
      customRoleId: null,
      loaded: true,
    });

    renderLayout();

    expect(screen.getByTestId("sidebar-role-label")).toHaveTextContent("Owner");
  });

  it("shows 'No role' when member has no assigned role", () => {
    mockUseUser.mockReturnValue({ user: MOCK_USER });
    mockUseWorkspaceRole.mockReturnValue({
      isOwner: false,
      realIsOwner: false,
      allowedPages: null,
      customRoleId: null,
      loaded: true,
    });

    renderLayout();

    expect(screen.getByTestId("sidebar-role-label")).toHaveTextContent("No role");
  });

  it("shows the custom role name when member has an assigned role", () => {
    mockUseUser.mockReturnValue({ user: MOCK_USER });
    mockUseRoles.mockReturnValue({
      data: { roles: [{ id: 5, name: "Designer", allowed_pages: [], created_at: "" }] },
    });
    mockUseWorkspaceRole.mockReturnValue({
      isOwner: false,
      realIsOwner: false,
      allowedPages: ["devices"],
      customRoleId: 5,
      loaded: true,
    });

    renderLayout();

    expect(screen.getByTestId("sidebar-role-label")).toHaveTextContent("Designer");
  });
});

describe("DashboardLayout – Sidebar avatar after photo removal", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUseRoles.mockReturnValue({ data: { roles: [] } });
    mockUseWorkspaceRole.mockReturnValue({
      isOwner: false,
      realIsOwner: false,
      allowedPages: null,
      customRoleId: null,
      loaded: true,
    });
  });

  it("shows the user's photo when hasImage is true", () => {
    mockUseUser.mockReturnValue({
      user: {
        ...MOCK_USER,
        imageUrl: "https://example.com/real-photo.jpg",
        hasImage: true,
      },
    });

    renderLayout();

    // Avatar appears in both mobile and desktop headers
    const avatars = screen.getAllByAltText("Avatar");
    expect(avatars.length).toBeGreaterThan(0);
    expect(avatars[0]).toHaveAttribute("src", "https://example.com/real-photo.jpg");
  });

  it("shows initials instead of an image when hasImage is false", () => {
    mockUseUser.mockReturnValue({
      user: {
        ...MOCK_USER,
        imageUrl: "https://img.clerk.com/eyJ0eXBlIjoiZGVmYXVsdCIsImluaXRpYWxzIjoiQUwifQ",
        hasImage: false,
      },
    });

    renderLayout();

    expect(screen.queryByAltText("Avatar")).not.toBeInTheDocument();
    // Initials appear in both mobile and desktop headers; verify at least one is present
    expect(screen.getAllByText("A").length).toBeGreaterThan(0);
  });

  it("shows initials instead of an image after photo removal (hasImage reverts to false)", () => {
    mockUseUser.mockReturnValue({
      user: {
        ...MOCK_USER,
        imageUrl: "https://img.clerk.com/eyJ0eXBlIjoiZGVmYXVsdCIsImluaXRpYWxzIjoiQUwifQ",
        hasImage: false,
      },
    });

    renderLayout();

    expect(screen.queryByAltText("Avatar")).not.toBeInTheDocument();
    expect(screen.getAllByText("A").length).toBeGreaterThan(0);
  });

  it("reverts the header avatar to initials when Clerk sets hasImage to false after photo removal", () => {
    mockUseUser.mockReturnValue({
      user: {
        ...MOCK_USER,
        imageUrl: "https://example.com/real-photo.jpg",
        hasImage: true,
      },
    });

    const { rerender } = renderLayout();

    expect(screen.getAllByAltText("Avatar").length).toBeGreaterThan(0);

    mockUseUser.mockReturnValue({
      user: {
        ...MOCK_USER,
        imageUrl: "https://img.clerk.com/eyJ0eXBlIjoiZGVmYXVsdCIsImluaXRpYWxzIjoiQUwifQ",
        hasImage: false,
      },
    });

    rerender();

    expect(screen.queryByAltText("Avatar")).not.toBeInTheDocument();
    expect(screen.getAllByText("A").length).toBeGreaterThan(0);
  });
});

describe("DashboardLayout – Pending access request badge on Users nav", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUseUser.mockReturnValue({ user: null });
    mockUseRoles.mockReturnValue({ data: { roles: [] } });
    mockUsePendingAccessRequestCount.mockReturnValue(0);
  });

  it("does not show badge when there are no pending requests", () => {
    mockUsePendingAccessRequestCount.mockReturnValue(0);
    mockUseWorkspaceRole.mockReturnValue({
      isOwner: true,
      realIsOwner: true,
      allowedPages: null,
      customRoleId: null,
      loaded: true,
    });

    renderLayout();

    expect(screen.queryByTestId("users-pending-badge")).not.toBeInTheDocument();
  });

  it("shows badge with count when there are pending requests and user is owner", () => {
    mockUsePendingAccessRequestCount.mockReturnValue(3);
    mockUseWorkspaceRole.mockReturnValue({
      isOwner: true,
      realIsOwner: true,
      allowedPages: null,
      customRoleId: null,
      loaded: true,
    });

    renderLayout();

    const badge = screen.getByTestId("users-pending-badge");
    expect(badge).toBeInTheDocument();
    expect(badge).toHaveTextContent("3");
  });

  it("shows 99+ when pending request count exceeds 99", () => {
    mockUsePendingAccessRequestCount.mockReturnValue(100);
    mockUseWorkspaceRole.mockReturnValue({
      isOwner: true,
      realIsOwner: true,
      allowedPages: null,
      customRoleId: null,
      loaded: true,
    });

    renderLayout();

    const badge = screen.getByTestId("users-pending-badge");
    expect(badge).toHaveTextContent("99+");
  });

  it("does not show badge for a non-owner even when count is > 0", () => {
    mockUsePendingAccessRequestCount.mockReturnValue(5);
    mockUseWorkspaceRole.mockReturnValue({
      isOwner: false,
      realIsOwner: false,
      allowedPages: ["users"],
      customRoleId: null,
      loaded: true,
    });

    renderLayout();

    expect(screen.queryByTestId("users-pending-badge")).not.toBeInTheDocument();
  });
});

describe("DashboardLayout – Collapsible sidebar", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.removeItem("sidebarCollapsed");
    mockUseUser.mockReturnValue({ user: null });
    mockUseRoles.mockReturnValue({ data: { roles: [] } });
    mockUseWorkspaceRole.mockReturnValue({
      isOwner: true,
      realIsOwner: true,
      allowedPages: null,
      customRoleId: null,
      loaded: true,
    });
  });

  it("renders expanded by default with a 'Collapse sidebar' toggle", () => {
    renderLayout();
    const sidebar = screen.getByTestId("dashboard-sidebar");
    expect(sidebar).toHaveAttribute("data-state", "expanded");
    expect(screen.getByTestId("sidebar-toggle")).toHaveAttribute(
      "aria-label",
      "Collapse sidebar",
    );
  });

  it("collapses on toggle click, persists to localStorage, and switches aria-label", () => {
    renderLayout();
    fireEvent.click(screen.getByTestId("sidebar-toggle"));
    expect(screen.getByTestId("dashboard-sidebar")).toHaveAttribute(
      "data-state",
      "collapsed",
    );
    expect(localStorage.getItem("sidebarCollapsed:anonymous")).toBe("1");
    expect(screen.getByTestId("sidebar-toggle")).toHaveAttribute(
      "aria-label",
      "Expand sidebar",
    );
  });

  it("restores the collapsed state from localStorage on mount", () => {
    localStorage.setItem("sidebarCollapsed", "1");
    renderLayout();
    expect(screen.getByTestId("dashboard-sidebar")).toHaveAttribute(
      "data-state",
      "collapsed",
    );
  });

  it("shows icon-only navigation groups with accessible labels when collapsed", () => {
    localStorage.setItem("sidebarCollapsed", "1");
    renderLayout();
    const sidebar = screen.getByTestId("dashboard-sidebar");
    const settingsGroup = within(sidebar).getByTestId("nav-settings");
    expect(settingsGroup).toHaveAttribute("aria-label", "Settings");
    expect(settingsGroup).not.toHaveTextContent("Settings");
  });

  it("expands again when the rail toggle is clicked", () => {
    localStorage.setItem("sidebarCollapsed", "1");
    renderLayout();
    fireEvent.click(screen.getByTestId("sidebar-toggle"));
    expect(screen.getByTestId("dashboard-sidebar")).toHaveAttribute(
      "data-state",
      "expanded",
    );
    expect(localStorage.getItem("sidebarCollapsed:anonymous")).toBe("0");
  });

  it("keeps the view-as control as an icon-only button when collapsed", () => {
    localStorage.setItem("sidebarCollapsed", "1");
    renderLayout();
    const sidebar = screen.getByTestId("dashboard-sidebar");
    const viewAs = within(sidebar).getByTestId("view-as-select");
    expect(viewAs.tagName).toBe("BUTTON");
    expect(viewAs).toHaveAttribute("aria-label", "View as role");
  });
});

describe("DashboardLayout – Florist manual-review badge", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.removeItem("sidebarCollapsed");
    mockUseUser.mockReturnValue({ user: null });
    mockUseRoles.mockReturnValue({ data: { roles: [] } });
    mockUseFloristManualReviewCount.mockReturnValue(0);
  });

  it("shows no badge when the reviewer queue is empty", () => {
    mockUseWorkspaceRole.mockReturnValue({
      isOwner: false,
      realIsOwner: false,
      allowedPages: ["orders"],
      customRoleId: null,
      customRoleIds: [],
      floristLocationId: null,
      loaded: true,
    });

    renderLayout();

    expect(screen.queryByTestId("florist-manual-review-badge")).not.toBeInTheDocument();
    expect(mockUseFloristManualReviewCount).toHaveBeenCalledWith(true);
  });

  it("shows the numeric badge for an Orders reviewer", () => {
    mockUseFloristManualReviewCount.mockReturnValue(4);
    mockUseWorkspaceRole.mockReturnValue({
      isOwner: false,
      realIsOwner: false,
      allowedPages: ["orders"],
      customRoleId: null,
      customRoleIds: [],
      floristLocationId: null,
      loaded: true,
    });

    renderLayout();

    fireEvent.click(screen.getByTestId("nav-orders-delivery"));
    expect(screen.getByTestId("florist-manual-review-badge")).toHaveTextContent("4");
  });

  it("shows the matching red dot when navigation is collapsed", () => {
    localStorage.setItem("sidebarCollapsed", "1");
    mockUseFloristManualReviewCount.mockReturnValue(2);
    mockUseWorkspaceRole.mockReturnValue({
      isOwner: true,
      realIsOwner: true,
      allowedPages: null,
      customRoleId: null,
      customRoleIds: [],
      floristLocationId: null,
      loaded: true,
    });

    renderLayout();

    expect(
      screen.getByTestId("orders-delivery-collapsed-dot"),
    ).toBeInTheDocument();
  });

  it("does not fetch or show the badge for florist-only members", () => {
    mockUseFloristManualReviewCount.mockReturnValue(5);
    mockUseWorkspaceRole.mockReturnValue({
      isOwner: false,
      realIsOwner: false,
      allowedPages: ["florist_orders"],
      customRoleId: null,
      customRoleIds: [],
      floristLocationId: 9,
      loaded: true,
    });

    renderLayout();

    expect(mockUseFloristManualReviewCount).toHaveBeenCalledWith(false);
    expect(screen.queryByTestId("florist-manual-review-badge")).not.toBeInTheDocument();
  });
});

describe("DashboardLayout – canonical sidebar sections", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.removeItem("sidebarCollapsed");
    localStorage.removeItem("sidebarOpenGroups");
    localStorage.removeItem("sidebarClosedGroups");
    mockWouterLocation.value = "/devices";
    mockUseUser.mockReturnValue({ user: null });
    mockUseRoles.mockReturnValue({ data: { roles: [] } });
    mockUseWorkspaceRole.mockReturnValue({
      isOwner: true,
      realIsOwner: true,
      allowedPages: null,
      customRoleId: null,
      customRoleIds: [],
      floristLocationId: null,
      loaded: true,
    });
  });

  it("renders section headers as ordered disclosure buttons", () => {
    renderLayout();
    const sidebar = screen.getByTestId("dashboard-sidebar");
    const sections = [
      "orders-delivery", "branches", "cash-desk", "our-brands", "catalog",
      "purchasing", "marketing", "website-seo", "analytics", "finance",
      "team", "me", "developer", "settings",
    ].map((id) => within(sidebar).getByTestId(`nav-${id}`));

    expect(sections.every((section) => section.tagName === "BUTTON")).toBe(true);
    for (let index = 1; index < sections.length; index += 1) {
      expect(
        sections[index - 1].compareDocumentPosition(sections[index]) &
          Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBeTruthy();
    }
  });

  it("auto-expands the active section even when persisted closed", () => {
    localStorage.setItem("sidebarOpenGroups", "[]");
    localStorage.setItem("sidebarClosedGroups", JSON.stringify(["catalog"]));
    mockWouterLocation.value = "/recipe-review";
    renderLayout();

    expect(screen.getByTestId("nav-catalog")).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByTestId("nav-product-recipes")).toHaveAttribute("aria-current", "page");
  });

  it("filters the canonical tree for a restricted role", () => {
    mockUseWorkspaceRole.mockReturnValue({
      isOwner: false,
      realIsOwner: false,
      allowedPages: ["products"],
      customRoleId: null,
      customRoleIds: [],
      floristLocationId: null,
      loaded: true,
    });
    renderLayout();

    expect(screen.getByTestId("nav-dashboard")).toBeInTheDocument();
    expect(screen.queryByTestId("nav-project-dashboard")).not.toBeInTheDocument();
    expect(screen.queryByTestId("nav-orders-delivery")).not.toBeInTheDocument();
    expect(screen.queryByTestId("nav-settings")).not.toBeInTheDocument();
    fireEvent.click(screen.getByTestId("nav-catalog"));
    expect(screen.getByTestId("nav-all-products")).toBeInTheDocument();
    expect(screen.getByTestId("nav-ai-product-generator")).toBeInTheDocument();
    expect(screen.queryByTestId("nav-product-recipes")).not.toBeInTheDocument();
  });

  it("uses namespaced persistence so two users do not share rail state", () => {
    mockUseUser.mockReturnValue({ user: { ...MOCK_USER, hasImage: false, imageUrl: "" } });
    const first = renderLayout();
    fireEvent.click(screen.getByTestId("sidebar-toggle"));
    expect(localStorage.getItem("sidebarCollapsed:alice")).toBe("1");
    first.unmount();

    mockUseUser.mockReturnValue({ user: { ...MOCK_USER, id: "bob", hasImage: false, imageUrl: "" } });
    renderLayout();
    expect(screen.getByTestId("dashboard-sidebar")).toHaveAttribute("data-state", "expanded");
  });

  it("does not apply a global legacy rail preference to an authenticated user", () => {
    localStorage.setItem("sidebarCollapsed", "1");
    mockUseUser.mockReturnValue({ user: { ...MOCK_USER, hasImage: false, imageUrl: "" } });
    renderLayout();
    expect(screen.getByTestId("dashboard-sidebar")).toHaveAttribute("data-state", "expanded");
    fireEvent.click(screen.getByTestId("sidebar-toggle"));
    expect(localStorage.getItem("sidebarCollapsed:alice")).toBe("1");
  });

  it("rehydrates persistence when identity changes and ignores global legacy state for users", () => {
    localStorage.setItem("sidebarCollapsed", "1");
    localStorage.setItem("sidebarCollapsed:alice", "0");
    localStorage.setItem("sidebarCollapsed:bob", "1");
    mockUseUser.mockReturnValue({ user: null });
    const { rerender } = renderLayout();
    expect(screen.getByTestId("dashboard-sidebar")).toHaveAttribute("data-state", "collapsed");

    mockUseUser.mockReturnValue({ user: { ...MOCK_USER, hasImage: false, imageUrl: "" } });
    rerender();
    expect(screen.getByTestId("dashboard-sidebar")).toHaveAttribute("data-state", "expanded");

    mockUseUser.mockReturnValue({ user: { ...MOCK_USER, id: "bob", hasImage: false, imageUrl: "" } });
    rerender();
    expect(screen.getByTestId("dashboard-sidebar")).toHaveAttribute("data-state", "collapsed");
  });

  it("renders the canonical Catalog disclosure in mobile navigation", () => {
    mockWouterLocation.value = "/recipe-review";
    renderLayout();
    const mobileCatalog = screen.getByTestId("nav-catalog-mobile");
    expect(mobileCatalog.tagName).toBe("BUTTON");
    expect(mobileCatalog).toHaveAttribute("aria-expanded", "true");
    expect(screen.getAllByRole("link", { name: "Product Recipes" }).some(
      (link) => link.getAttribute("aria-current") === "page",
    )).toBe(true);
  });

  it("keeps canonical section controls available in RTL", async () => {
    await i18n.changeLanguage("ar");
    renderLayout();
    expect(document.documentElement.dir).toBe("rtl");
    expect(screen.getByTestId("nav-orders-delivery")).toHaveAttribute("aria-expanded", "false");
    await i18n.changeLanguage("en");
  });

  it("renders only confirmed live badge values for Orders and both Catalog rows", () => {
    mockUsePendingOrdersCount.mockReturnValue(100);
    mockUseRecipeAttention.mockReturnValue({
      data: { attention_count: 100 },
      isError: false,
      isLoading: false,
    });
    renderLayout();

    expect(screen.getByTestId("orders-pending-badge")).toHaveTextContent("99+");
    fireEvent.click(screen.getByTestId("nav-catalog"));
    expect(screen.getByTestId("all-products-count-badge")).toHaveTextContent("99+");
    expect(screen.getByTestId("recipe-attention-badge")).toHaveTextContent("99+");
    // Re-renders may invoke hooks again, but the sidebar introduces no
    // additional badge-specific data source.
    expect(mockUsePendingOrdersCount).toHaveBeenCalled();
    expect(mockUseRecipeAttention).toHaveBeenCalledWith(true);
  });

  it("does not render an unconfirmed Catalog badge", () => {
    mockUseRecipeAttention.mockReturnValue({
      data: undefined,
      isError: false,
      isLoading: true,
    });
    renderLayout();
    fireEvent.click(screen.getByTestId("nav-catalog"));
    expect(screen.queryByTestId("all-products-count-badge")).not.toBeInTheDocument();
    expect(screen.queryByTestId("recipe-attention-badge")).not.toBeInTheDocument();
  });
});

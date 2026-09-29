import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { hasBrandsAccess } from "./lib/pageAccess";
import { PageGuard } from "./App";

// ---------------------------------------------------------------------------
// Mocks required by PageGuard (which calls useWorkspaceRole and may render
// a Redirect from wouter)
// ---------------------------------------------------------------------------

const mockUseWorkspaceRole = vi.fn();
vi.mock("@/hooks/use-workspace-role", () => ({
  useWorkspaceRole: () => mockUseWorkspaceRole(),
}));

const mockRedirectTo = vi.fn();
vi.mock("wouter", () => ({
  Redirect: ({ to }: { to: string }) => {
    mockRedirectTo(to);
    return <div data-testid="redirect" data-to={to} />;
  },
  useLocation: () => ["/brands", vi.fn()],
  Link: ({ href, children }: { href: string; children: React.ReactNode }) => (
    <a href={href}>{children}</a>
  ),
  Route: ({ component: Comp }: { component: React.ComponentType }) => <Comp />,
  Switch: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

// PageGuard also touches no other external modules, so the mocks above are
// sufficient for the component-level tests.

// ---------------------------------------------------------------------------
// 1. Pure unit tests for hasBrandsAccess
// ---------------------------------------------------------------------------

describe("hasBrandsAccess — pure helper", () => {
  it("returns true when pages includes the exact 'brands' string", () => {
    expect(hasBrandsAccess(["brands"])).toBe(true);
  });

  it("returns true for 'brands.edit' sub-permission", () => {
    expect(hasBrandsAccess(["brands.edit"])).toBe(true);
  });

  it("returns true for 'brands.create' sub-permission", () => {
    expect(hasBrandsAccess(["brands.create"])).toBe(true);
  });

  it("returns true for 'brands.manage-logos' sub-permission", () => {
    expect(hasBrandsAccess(["brands.manage-logos"])).toBe(true);
  });

  it("returns true for 'brands.manage-cover-photos' sub-permission", () => {
    expect(hasBrandsAccess(["brands.manage-cover-photos"])).toBe(true);
  });

  it("returns true for 'brands.manage-card-message' sub-permission", () => {
    expect(hasBrandsAccess(["brands.manage-card-message"])).toBe(true);
  });

  it("returns true when a brands.* permission is mixed with unrelated ones", () => {
    expect(hasBrandsAccess(["stickers", "brands.edit", "devices"])).toBe(true);
  });

  it("returns false for an empty array", () => {
    expect(hasBrandsAccess([])).toBe(false);
  });

  it("returns false when only unrelated pages are present", () => {
    expect(hasBrandsAccess(["stickers", "devices", "channels"])).toBe(false);
  });

  it("returns false for a page that starts with an unrelated prefix containing 'brand' as a substring", () => {
    // Ensures we don't accidentally match e.g. "co-brand" (doesn't start with "brands.")
    expect(hasBrandsAccess(["co-brand", "co-brand.edit"])).toBe(false);
  });

  it("returns false when only 'channels.manage' is present (regression guard)", () => {
    expect(hasBrandsAccess(["channels.manage"])).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 2. PageGuard component behaviour with matchFn={hasBrandsAccess}
// ---------------------------------------------------------------------------

function renderGuard(allowedPages: string[] | null, loaded = true) {
  mockUseWorkspaceRole.mockReturnValue({ allowedPages, loaded });
  return render(
    <PageGuard page="brands" matchFn={hasBrandsAccess}>
      <div data-testid="protected-content">brands content</div>
    </PageGuard>,
  );
}

describe("PageGuard with matchFn={hasBrandsAccess} — routing behaviour", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders children for owners (allowedPages === null)", () => {
    renderGuard(null);
    expect(screen.getByTestId("protected-content")).toBeInTheDocument();
    expect(screen.queryByTestId("redirect")).not.toBeInTheDocument();
  });

  it("renders children when allowedPages includes 'brands'", () => {
    renderGuard(["brands"]);
    expect(screen.getByTestId("protected-content")).toBeInTheDocument();
  });

  it("renders children when allowedPages includes 'brands.edit'", () => {
    renderGuard(["brands.edit"]);
    expect(screen.getByTestId("protected-content")).toBeInTheDocument();
  });

  it("renders children when allowedPages includes 'brands.create'", () => {
    renderGuard(["brands.create"]);
    expect(screen.getByTestId("protected-content")).toBeInTheDocument();
  });

  it("renders children when allowedPages includes 'brands.manage-logos'", () => {
    renderGuard(["brands.manage-logos"]);
    expect(screen.getByTestId("protected-content")).toBeInTheDocument();
  });

  it("renders children when allowedPages includes 'brands.manage-cover-photos'", () => {
    renderGuard(["brands.manage-cover-photos"]);
    expect(screen.getByTestId("protected-content")).toBeInTheDocument();
  });

  it("renders children when allowedPages includes 'brands.manage-card-message'", () => {
    renderGuard(["brands.manage-card-message"]);
    expect(screen.getByTestId("protected-content")).toBeInTheDocument();
  });

  it("renders children when a brands.* sub-permission is mixed with others", () => {
    renderGuard(["stickers", "brands.manage-logos", "devices"]);
    expect(screen.getByTestId("protected-content")).toBeInTheDocument();
  });

  it("redirects to /devices when allowedPages has no brands entry", () => {
    renderGuard(["stickers", "devices"]);
    expect(screen.queryByTestId("protected-content")).not.toBeInTheDocument();
    expect(mockRedirectTo).toHaveBeenCalledWith("/devices");
  });

  it("redirects to /project-manager-dashboard when allowedPages contains that page but no brands", () => {
    renderGuard(["project-manager-dashboard", "stickers"]);
    expect(screen.queryByTestId("protected-content")).not.toBeInTheDocument();
    expect(mockRedirectTo).toHaveBeenCalledWith("/project-manager-dashboard");
  });

  it("redirects to /ops-dashboard when the Ops permission is present", () => {
    renderGuard(["ops-dashboard", "stickers"]);
    expect(screen.queryByTestId("protected-content")).not.toBeInTheDocument();
    expect(mockRedirectTo).toHaveBeenCalledWith("/ops-dashboard");
  });

  it("gives the Ops fallback precedence over Project Manager", () => {
    renderGuard([
      "project-manager-dashboard",
      "ops-dashboard",
      "stickers",
    ]);
    expect(mockRedirectTo).toHaveBeenCalledWith("/ops-dashboard");
  });

  it("redirects to /devices when allowedPages is empty", () => {
    renderGuard([]);
    expect(screen.queryByTestId("protected-content")).not.toBeInTheDocument();
    expect(mockRedirectTo).toHaveBeenCalledWith("/devices");
  });

  it("renders nothing (null) while role data is still loading", () => {
    const { container } = renderGuard(null, false);
    expect(container).toBeEmptyDOMElement();
  });
});

describe("PageGuard — Invoice Scanners permission", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  function renderScannerGuard(allowedPages: string[] | null) {
    mockUseWorkspaceRole.mockReturnValue({ allowedPages, loaded: true });
    return render(
      <PageGuard page="invoice-scanners">
        <div data-testid="scanner-content">scanner content</div>
      </PageGuard>,
    );
  }

  it("allows a member with invoice-scanners", () => {
    renderScannerGuard(["invoice-scanners"]);
    expect(screen.getByTestId("scanner-content")).toBeInTheDocument();
  });

  it("denies a member with only devices", () => {
    renderScannerGuard(["devices"]);
    expect(screen.queryByTestId("scanner-content")).not.toBeInTheDocument();
    expect(mockRedirectTo).toHaveBeenCalledWith("/devices");
  });

  it("allows owners regardless of page keys", () => {
    renderScannerGuard(null);
    expect(screen.getByTestId("scanner-content")).toBeInTheDocument();
  });
});

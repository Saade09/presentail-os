/**
 * Regression test: ClerkProvider must receive VITE_CLERK_PUBLISHABLE_KEY
 * exactly as configured — never a key derived from window.location.hostname.
 *
 * Root cause of the original bug:
 *   publishableKeyFromHost("os.presentail.com", fallback)
 *   → buildPublishableKey("clerk.os.presentail.com")
 *   → pk_live_<base64("clerk.os.presentail.com$")>   ← stale instance
 *
 * The configured key has FAPI domain: clerk.presentail.com
 * The stale derived key has FAPI domain: clerk.os.presentail.com
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render } from "@testing-library/react";
import React from "react";

// The key publishableKeyFromHost("os.presentail.com") would have generated.
// base64("clerk.os.presentail.com$") = Y2xlcmsuby5wcmVzZW50YWlsLmNvbSQ=
const HOST_DERIVED_KEY = "pk_live_" + btoa("clerk.os.presentail.com$");

// The correctly configured key (FAPI domain: clerk.presentail.com).
// base64("clerk.presentail.com$") = Y2xlcmsucHJlc2VudGFpbC5jb20k
const CONFIGURED_KEY = "pk_live_" + btoa("clerk.presentail.com$");

describe("ClerkProvider publishable-key isolation from window.location.hostname", () => {
  let capturedPublishableKey: string | undefined;
  let publishableKeyFromHostSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.resetModules();
    capturedPublishableKey = undefined;
    publishableKeyFromHostSpy = vi.fn(() => HOST_DERIVED_KEY);

    // Simulate the production host. The old code derived a Clerk key from
    // this hostname, producing HOST_DERIVED_KEY (clerk.os.presentail.com).
    vi.stubGlobal("location", {
      hostname: "os.presentail.com",
      host: "os.presentail.com",
      origin: "https://os.presentail.com",
      href: "https://os.presentail.com/",
      protocol: "https:",
      pathname: "/",
      search: "",
      hash: "",
      assign: vi.fn(),
      replace: vi.fn(),
      reload: vi.fn(),
    });

    // The correctly configured env-var key (clerk.presentail.com domain).
    vi.stubEnv("VITE_CLERK_PUBLISHABLE_KEY", CONFIGURED_KEY);
    vi.stubEnv("VITE_CLERK_PROXY_URL", "");

    // Spy on publishableKeyFromHost — the fixed code must NEVER call it.
    vi.doMock("@clerk/react/internal", () => ({
      publishableKeyFromHost: publishableKeyFromHostSpy,
    }));

    // Capture what ClerkProvider receives as publishableKey.
    vi.doMock("@clerk/react", () => ({
      __esModule: true,
      ClerkProvider: ({
        publishableKey,
        children,
      }: {
        publishableKey: string;
        children: React.ReactNode;
      }) => {
        capturedPublishableKey = publishableKey;
        return React.createElement(React.Fragment, null, children);
      },
      useClerk: vi.fn(() => ({})),
      useUser: vi.fn(() => ({ isLoaded: false, isSignedIn: false, user: null })),
      useAuth: vi.fn(() => ({ isLoaded: false, isSignedIn: false, getToken: vi.fn() })),
      Show: ({ children }: { children: React.ReactNode }) => children,
      SignUp: () => null,
      HandleSSOCallback: () => null,
    }));

    // Stub all heavy App.tsx dependencies so the module can initialize cleanly.
    vi.doMock("@clerk/themes", () => ({ shadcn: {} }));
    vi.doMock("@/pages/SignIn", () => ({ default: () => null }));
    vi.doMock("@/lib/queryClient", () => ({
      queryClient: {
        getQueryData: vi.fn(),
        setQueryData: vi.fn(),
        invalidateQueries: vi.fn(),
        getQueryCache: vi.fn(() => ({ subscribe: vi.fn() })),
      },
      apiFetch: vi.fn(),
      on401: vi.fn(),
    }));
    vi.doMock("@workspace/api-client-react", () => ({ setAuthTokenGetter: vi.fn() }));
    vi.doMock("@/hooks/use-workspace-role", () => ({
      useWorkspaceRole: vi.fn(() => "admin"),
    }));
    vi.doMock("@/post-login-routes", () => ({
      getDashboardLanding: vi.fn(() => "/devices"),
      PROJECT_MANAGER_PAGE_KEY: "project-manager",
      POST_LOGIN_ROUTES: {},
    }));
    vi.doMock("@/pages/dashboard/nav", () => ({
      hasChannelsAccess: () => false,
      hasCmcPosDashboardAccess: () => false,
      hasCmcPosAccess: () => false,
      hasCmcPosNewOrderAccess: () => false,
      hasCmcPosSubAccess: () => false,
      hasFloristOrdersAccess: () => false,
    }));
    vi.doMock("@/lib/pageAccess", () => ({ hasBrandsAccess: () => false }));
    vi.doMock("@/contexts/simulated-role-context", () => ({
      SimulatedRoleProvider: ({ children }: { children: React.ReactNode }) => children,
    }));
    vi.doMock("@/hooks/use-page-title", () => ({
      PageTitleProvider: ({ children }: { children: React.ReactNode }) => children,
      usePageTitle: vi.fn(),
    }));
    vi.doMock("@/components/ui/toaster", () => ({ Toaster: () => null }));
    vi.doMock("@/components/ui/tooltip", () => ({
      TooltipProvider: ({ children }: { children: React.ReactNode }) => children,
    }));
    vi.doMock("@/components/ui/spinner", () => ({ Spinner: () => null }));
    vi.doMock("@/components/ui/button", () => ({ Button: () => null }));
    vi.doMock("@/components/ui/input", () => ({ Input: () => null }));
    vi.doMock("@/components/ui/label", () => ({ Label: () => null }));
    vi.doMock("react-i18next", () => ({
      useTranslation: () => ({ t: (k: string) => k, i18n: { changeLanguage: vi.fn() } }),
    }));
    vi.doMock("wouter", () => ({
      Switch: ({ children }: { children: React.ReactNode }) => children,
      Route: () => null,
      Redirect: () => null,
      useLocation: () => ["/", vi.fn()],
      Router: ({ children }: { children: React.ReactNode }) => children,
    }));
    vi.doMock("@tanstack/react-query", () => ({
      QueryClientProvider: ({ children }: { children: React.ReactNode }) => children,
      useQueryClient: vi.fn(() => ({
        getQueryData: vi.fn(),
        setQueryData: vi.fn(),
        invalidateQueries: vi.fn(),
      })),
      useQuery: vi.fn(() => ({ data: undefined, isLoading: false, isError: false })),
    }));
    vi.doMock("lucide-react", () => ({ LayoutDashboard: () => null }));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("passes VITE_CLERK_PUBLISHABLE_KEY directly to ClerkProvider", async () => {
    const { default: App } = await import("./App");
    render(React.createElement(App));

    // The key that ClerkProvider receives must be exactly what the env var specifies.
    expect(capturedPublishableKey).toBe(CONFIGURED_KEY);
  });

  it("ClerkProvider key is for clerk.presentail.com, never clerk.os.presentail.com", async () => {
    const { default: App } = await import("./App");
    render(React.createElement(App));

    // Decode the base64 payload of the pk_live_ key and verify the FAPI domain.
    expect(capturedPublishableKey).toBeDefined();
    const payload = capturedPublishableKey!.replace(/^pk_live_/, "");
    const decoded = atob(payload);
    expect(decoded).toContain("clerk.presentail.com");
    expect(decoded).not.toContain("clerk.os.presentail.com");
  });

  it("does not call publishableKeyFromHost (hostname-deriving function) at any point", async () => {
    const { default: App } = await import("./App");
    render(React.createElement(App));

    expect(publishableKeyFromHostSpy).not.toHaveBeenCalled();
  });

  it("configured key and hostname-derived key are provably different (confirms the old code was wrong)", () => {
    // Sanity-check: verify the two keys are distinct so the test is meaningful.
    expect(CONFIGURED_KEY).not.toBe(HOST_DERIVED_KEY);

    const configuredDomain = atob(CONFIGURED_KEY.replace(/^pk_live_/, ""));
    const derivedDomain = atob(HOST_DERIVED_KEY.replace(/^pk_live_/, ""));
    expect(configuredDomain).toBe("clerk.presentail.com$");
    expect(derivedDomain).toBe("clerk.os.presentail.com$");
  });
});

import { describe, it, expect, vi, beforeEach } from "vitest";
import { createElement } from "react";
import { renderHook, render, act } from "@testing-library/react";
import {
  usePageTitle,
  usePageTitleOverride,
  PageTitleProvider,
} from "./use-page-title";

const mockLocation = vi.fn<[], string>();

vi.mock("wouter", () => ({
  useLocation: () => [mockLocation(), vi.fn()],
}));

let mockLanguage = "en";

const TRANSLATIONS: Record<string, Record<string, string>> = {
  en: {
    "nav.devices": "Devices",
    "nav.analytics": "Analytics",
    "nav.printHistory": "Print History",
    "nav.settings": "Settings",
    "nav.paymentLinks": "Payment Links",
    "nav.stickers": "Stickers",
    "nav.locations": "Locations",
    "nav.brands": "Brands",
    "nav.products": "Products",
    "nav.apiKeys": "API keys",
    "nav.downloads": "Downloads",
    "nav.users": "Users",
    "nav.roles": "Roles",
    "nav.apiDocs": "API docs",
    "nav.profile": "Profile",
    "nav.orders": "Orders",
  },
  fr: {
    "nav.devices": "Appareils",
    "nav.analytics": "Analytiques",
    "nav.printHistory": "Historique d'impression",
    "nav.settings": "Paramètres",
    "nav.paymentLinks": "Liens de paiement",
    "nav.stickers": "Autocollants",
    "nav.locations": "Emplacements",
    "nav.brands": "Marques",
    "nav.products": "Produits",
    "nav.apiKeys": "Clés API",
    "nav.downloads": "Téléchargements",
    "nav.users": "Utilisateurs",
    "nav.roles": "Rôles",
    "nav.apiDocs": "Docs API",
    "nav.profile": "Profil",
  },
  de: {
    "nav.devices": "Geräte",
    "nav.analytics": "Analytik",
    "nav.printHistory": "Druckverlauf",
    "nav.settings": "Einstellungen",
    "nav.paymentLinks": "Zahlungslinks",
    "nav.stickers": "Aufkleber",
    "nav.locations": "Standorte",
    "nav.brands": "Marken",
    "nav.products": "Produkte",
    "nav.apiKeys": "API-Schlüssel",
    "nav.downloads": "Downloads",
    "nav.users": "Benutzer",
    "nav.roles": "Rollen",
    "nav.apiDocs": "API-Dokumente",
    "nav.profile": "Profil",
  },
};

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string) => TRANSLATIONS[mockLanguage]?.[key] ?? TRANSLATIONS.en[key] ?? key,
    i18n: { language: mockLanguage },
  }),
}));

const APP_NAME = "Presentail OS";

describe("usePageTitle – dashboard routes set a labelled tab title", () => {
  beforeEach(() => {
    document.title = "";
    mockLanguage = "en";
    vi.clearAllMocks();
  });

  it("sets title to 'Devices | Presentail OS' when on /devices", () => {
    mockLocation.mockReturnValue("/devices");
    renderHook(() => usePageTitle());
    expect(document.title).toBe(`Devices | ${APP_NAME}`);
  });

  it("sets title to 'Devices | Presentail OS' for the bare /dashboard path (redirect alias)", () => {
    mockLocation.mockReturnValue("/dashboard");
    renderHook(() => usePageTitle());
    expect(document.title).toBe(`Devices | ${APP_NAME}`);
  });

  it("sets title to 'Analytics | Presentail OS' when on /analytics", () => {
    mockLocation.mockReturnValue("/analytics");
    renderHook(() => usePageTitle());
    expect(document.title).toBe(`Analytics | ${APP_NAME}`);
  });

  it("sets title to 'Print History | Presentail OS' when on /print-history", () => {
    mockLocation.mockReturnValue("/print-history");
    renderHook(() => usePageTitle());
    expect(document.title).toBe(`Print History | ${APP_NAME}`);
  });

  it("sets title to 'Settings | Presentail OS' when on /settings", () => {
    mockLocation.mockReturnValue("/settings");
    renderHook(() => usePageTitle());
    expect(document.title).toBe(`Settings | ${APP_NAME}`);
  });

  it("sets title to 'Payment Links | Presentail OS' when on /payment-links", () => {
    mockLocation.mockReturnValue("/payment-links");
    renderHook(() => usePageTitle());
    expect(document.title).toBe(`Payment Links | ${APP_NAME}`);
  });

  it("sets title to 'Locations | Presentail OS' for a nested location path", () => {
    mockLocation.mockReturnValue("/locations/42");
    renderHook(() => usePageTitle());
    expect(document.title).toBe(`Locations | ${APP_NAME}`);
  });
});

describe("usePageTitle – non-dashboard routes keep the app name only", () => {
  beforeEach(() => {
    document.title = "";
    mockLanguage = "en";
    vi.clearAllMocks();
  });

  it("sets title to 'Presentail OS' when on the sign-in page", () => {
    mockLocation.mockReturnValue("/sign-in");
    renderHook(() => usePageTitle());
    expect(document.title).toBe(APP_NAME);
  });

  it("sets title to 'Presentail OS' when on the home page", () => {
    mockLocation.mockReturnValue("/");
    renderHook(() => usePageTitle());
    expect(document.title).toBe(APP_NAME);
  });

  it("sets title to 'Presentail OS' for an unknown route", () => {
    mockLocation.mockReturnValue("/some/unknown/path");
    renderHook(() => usePageTitle());
    expect(document.title).toBe(APP_NAME);
  });
});

describe("usePageTitle – title updates reactively when the location changes", () => {
  beforeEach(() => {
    document.title = "";
    mockLanguage = "en";
    vi.clearAllMocks();
  });

  it("updates the title when navigating from /devices to /analytics", () => {
    mockLocation.mockReturnValue("/devices");
    const { rerender } = renderHook(() => usePageTitle());
    expect(document.title).toBe(`Devices | ${APP_NAME}`);

    mockLocation.mockReturnValue("/analytics");
    rerender();
    expect(document.title).toBe(`Analytics | ${APP_NAME}`);
  });

  it("resets to app name only when navigating away from the dashboard", () => {
    mockLocation.mockReturnValue("/settings");
    const { rerender } = renderHook(() => usePageTitle());
    expect(document.title).toBe(`Settings | ${APP_NAME}`);

    mockLocation.mockReturnValue("/sign-in");
    rerender();
    expect(document.title).toBe(APP_NAME);
  });
});

describe("usePageTitle – title updates when the language changes (en → fr)", () => {
  beforeEach(() => {
    document.title = "";
    mockLanguage = "en";
    vi.clearAllMocks();
  });

  it("updates the Devices title from English to French when the language switches", () => {
    mockLocation.mockReturnValue("/devices");
    const { rerender } = renderHook(() => usePageTitle());
    expect(document.title).toBe(`Devices | ${APP_NAME}`);

    act(() => {
      mockLanguage = "fr";
    });
    rerender();
    expect(document.title).toBe(`Appareils | ${APP_NAME}`);
  });

  it("updates the Analytics title from English to French when the language switches", () => {
    mockLocation.mockReturnValue("/analytics");
    const { rerender } = renderHook(() => usePageTitle());
    expect(document.title).toBe(`Analytics | ${APP_NAME}`);

    act(() => {
      mockLanguage = "fr";
    });
    rerender();
    expect(document.title).toBe(`Analytiques | ${APP_NAME}`);
  });

  it("updates the Settings title from English to French when the language switches", () => {
    mockLocation.mockReturnValue("/settings");
    const { rerender } = renderHook(() => usePageTitle());
    expect(document.title).toBe(`Settings | ${APP_NAME}`);

    act(() => {
      mockLanguage = "fr";
    });
    rerender();
    expect(document.title).toBe(`Paramètres | ${APP_NAME}`);
  });

  it("keeps the app-name-only title (no label) after a language switch on a non-dashboard path", () => {
    mockLocation.mockReturnValue("/sign-in");
    const { rerender } = renderHook(() => usePageTitle());
    expect(document.title).toBe(APP_NAME);

    act(() => {
      mockLanguage = "fr";
    });
    rerender();
    expect(document.title).toBe(APP_NAME);
  });
});

describe("usePageTitle – title updates when the language changes (en → de)", () => {
  beforeEach(() => {
    document.title = "";
    mockLanguage = "en";
    vi.clearAllMocks();
  });

  it("updates the Devices title from English to German when the language switches", () => {
    mockLocation.mockReturnValue("/devices");
    const { rerender } = renderHook(() => usePageTitle());
    expect(document.title).toBe(`Devices | ${APP_NAME}`);

    act(() => {
      mockLanguage = "de";
    });
    rerender();
    expect(document.title).toBe(`Geräte | ${APP_NAME}`);
  });

  it("updates the Print History title from English to German when the language switches", () => {
    mockLocation.mockReturnValue("/print-history");
    const { rerender } = renderHook(() => usePageTitle());
    expect(document.title).toBe(`Print History | ${APP_NAME}`);

    act(() => {
      mockLanguage = "de";
    });
    rerender();
    expect(document.title).toBe(`Druckverlauf | ${APP_NAME}`);
  });

  it("reverts the title back to English when switching from German back to English", () => {
    mockLocation.mockReturnValue("/analytics");
    mockLanguage = "de";
    const { rerender } = renderHook(() => usePageTitle());
    expect(document.title).toBe(`Analytik | ${APP_NAME}`);

    act(() => {
      mockLanguage = "en";
    });
    rerender();
    expect(document.title).toBe(`Analytics | ${APP_NAME}`);
  });
});

describe("usePageTitleOverride – detail pages can set a custom tab title", () => {
  beforeEach(() => {
    document.title = "";
    mockLanguage = "en";
    vi.clearAllMocks();
  });

  function wrapper({ children }: { children: React.ReactNode }) {
    return createElement(PageTitleProvider, null, children);
  }

  it("applies the override (suffixed with the app name) instead of the nav title", () => {
    mockLocation.mockReturnValue("/orders/abc123");
    renderHook(
      () => {
        usePageTitle();
        usePageTitleOverride("Order #LB-1007");
      },
      { wrapper },
    );
    expect(document.title).toBe(`Order #LB-1007 | ${APP_NAME}`);
  });

  it("falls back to the nav-based title once the override is cleared (set to null)", () => {
    mockLocation.mockReturnValue("/orders/abc123");
    let override: string | null = "Order #LB-1007";
    const { rerender } = renderHook(
      () => {
        usePageTitle();
        usePageTitleOverride(override);
      },
      { wrapper },
    );
    expect(document.title).toBe(`Order #LB-1007 | ${APP_NAME}`);

    act(() => {
      override = null;
    });
    rerender();
    expect(document.title).toBe(`Orders | ${APP_NAME}`);
  });

  it("restores the nav title when the override component unmounts", () => {
    mockLocation.mockReturnValue("/devices");

    function TitleConsumer() {
      usePageTitle();
      return null;
    }
    function OverrideSetter() {
      usePageTitleOverride("Order #LB-1007");
      return null;
    }
    function Tree({ showOverride }: { showOverride: boolean }) {
      return createElement(
        PageTitleProvider,
        null,
        createElement(TitleConsumer),
        showOverride ? createElement(OverrideSetter) : null,
      );
    }

    const { rerender } = render(createElement(Tree, { showOverride: true }));
    expect(document.title).toBe(`Order #LB-1007 | ${APP_NAME}`);

    rerender(createElement(Tree, { showOverride: false }));
    expect(document.title).toBe(`Devices | ${APP_NAME}`);
  });
});

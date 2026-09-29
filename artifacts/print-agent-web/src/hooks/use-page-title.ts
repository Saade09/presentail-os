import {
  createContext,
  createElement,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react";
import { useLocation } from "wouter";
import { useTranslation } from "react-i18next";
import { NAV, PRODUCTS_GROUP } from "@/pages/dashboard/nav";

const APP_NAME = "Presentail OS";

type PageTitleContextValue = {
  override: string | null;
  setOverride: (title: string | null) => void;
};

const PageTitleContext = createContext<PageTitleContextValue>({
  override: null,
  setOverride: () => {},
});

export function PageTitleProvider({ children }: { children: ReactNode }) {
  const [override, setOverride] = useState<string | null>(null);
  return createElement(
    PageTitleContext.Provider,
    { value: { override, setOverride } },
    children,
  );
}

export function usePageTitle() {
  const { t, i18n } = useTranslation();
  const [location] = useLocation();
  const { override } = useContext(PageTitleContext);

  useEffect(() => {
    if (override) {
      document.title = `${override} | ${APP_NAME}`;
      return;
    }

    const normalizedPath = (() => {
      if (location === "/dashboard") return "/devices";
      if (location.startsWith("/locations/")) return "/locations";
      return location;
    })();

    const match = NAV.find(
      (item) =>
        normalizedPath === item.path ||
        normalizedPath.startsWith(item.path + "/"),
    );

    const productGroupMatch = PRODUCTS_GROUP.children.find(
      (item) =>
        normalizedPath === item.path ||
        normalizedPath.startsWith(item.path + "/"),
    );

    if (match || productGroupMatch) {
      document.title = `${t((match ?? productGroupMatch)!.labelKey)} | ${APP_NAME}`;
    } else {
      document.title = APP_NAME;
    }
  }, [location, t, i18n.language, override]);
}

/**
 * Lets a detail page override the browser tab title with a custom value
 * (still suffixed with "| Presentail OS"). Pass `null` while data is loading
 * to fall back to the default nav-based title. The override is cleared
 * automatically when the component unmounts.
 */
export function usePageTitleOverride(title: string | null) {
  const { setOverride } = useContext(PageTitleContext);

  useEffect(() => {
    setOverride(title);
    return () => setOverride(null);
  }, [title, setOverride]);
}

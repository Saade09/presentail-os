import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import LanguageDetector from "i18next-browser-languagedetector";
import en from "./locales/en.json";
import ar from "./locales/ar.json";

export const SUPPORTED_LANGUAGES = ["en", "ar"] as const;
export type SupportedLanguage = (typeof SUPPORTED_LANGUAGES)[number];

const STORAGE_KEY = "i18nextLng";

function applyDirection(lang: string) {
  const dir = lang === "ar" ? "rtl" : "ltr";
  document.documentElement.setAttribute("dir", dir);
  document.documentElement.setAttribute("lang", lang);
}

i18n
  .use(LanguageDetector)
  .use(initReactI18next)
  .init({
    resources: {
      en: { translation: en },
      ar: { translation: ar },
    },
    fallbackLng: "en",
    supportedLngs: SUPPORTED_LANGUAGES,
    detection: {
      order: ["localStorage", "navigator"],
      caches: ["localStorage"],
      lookupLocalStorage: STORAGE_KEY,
    },
    interpolation: {
      escapeValue: false,
    },
  });

i18n.on("languageChanged", applyDirection);

const stored = localStorage.getItem(STORAGE_KEY);
applyDirection(stored && SUPPORTED_LANGUAGES.includes(stored as SupportedLanguage) ? stored : "en");

export default i18n;

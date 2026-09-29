export type CountryEntry = {
  name: string;
  /** ISO 3166-1 alpha-2 code, lowercase. */
  code: string;
};

/**
 * Master catalogue of countries, keyed by ISO 3166-1 alpha-2 code (lowercase).
 * Israel is intentionally excluded (see EXCLUDED_COUNTRY_NAMES below).
 */
export const COUNTRY_CATALOGUE: readonly CountryEntry[] = [
  { name: "Afghanistan", code: "af" },
  { name: "Albania", code: "al" },
  { name: "Algeria", code: "dz" },
  { name: "Andorra", code: "ad" },
  { name: "Angola", code: "ao" },
  { name: "Antigua and Barbuda", code: "ag" },
  { name: "Argentina", code: "ar" },
  { name: "Armenia", code: "am" },
  { name: "Australia", code: "au" },
  { name: "Austria", code: "at" },
  { name: "Azerbaijan", code: "az" },
  { name: "Bahamas", code: "bs" },
  { name: "Bahrain", code: "bh" },
  { name: "Bangladesh", code: "bd" },
  { name: "Barbados", code: "bb" },
  { name: "Belarus", code: "by" },
  { name: "Belgium", code: "be" },
  { name: "Belize", code: "bz" },
  { name: "Benin", code: "bj" },
  { name: "Bhutan", code: "bt" },
  { name: "Bolivia", code: "bo" },
  { name: "Bosnia and Herzegovina", code: "ba" },
  { name: "Botswana", code: "bw" },
  { name: "Brazil", code: "br" },
  { name: "Brunei", code: "bn" },
  { name: "Bulgaria", code: "bg" },
  { name: "Burkina Faso", code: "bf" },
  { name: "Burundi", code: "bi" },
  { name: "Cabo Verde", code: "cv" },
  { name: "Cambodia", code: "kh" },
  { name: "Cameroon", code: "cm" },
  { name: "Canada", code: "ca" },
  { name: "Central African Republic", code: "cf" },
  { name: "Chad", code: "td" },
  { name: "Chile", code: "cl" },
  { name: "China", code: "cn" },
  { name: "Colombia", code: "co" },
  { name: "Comoros", code: "km" },
  { name: "Congo", code: "cg" },
  { name: "Costa Rica", code: "cr" },
  { name: "Croatia", code: "hr" },
  { name: "Cuba", code: "cu" },
  { name: "Cyprus", code: "cy" },
  { name: "Czech Republic", code: "cz" },
  { name: "Denmark", code: "dk" },
  { name: "Djibouti", code: "dj" },
  { name: "Dominica", code: "dm" },
  { name: "Dominican Republic", code: "do" },
  { name: "Ecuador", code: "ec" },
  { name: "Egypt", code: "eg" },
  { name: "El Salvador", code: "sv" },
  { name: "Equatorial Guinea", code: "gq" },
  { name: "Eritrea", code: "er" },
  { name: "Estonia", code: "ee" },
  { name: "Eswatini", code: "sz" },
  { name: "Ethiopia", code: "et" },
  { name: "Fiji", code: "fj" },
  { name: "Finland", code: "fi" },
  { name: "France", code: "fr" },
  { name: "Gabon", code: "ga" },
  { name: "Gambia", code: "gm" },
  { name: "Georgia", code: "ge" },
  { name: "Germany", code: "de" },
  { name: "Ghana", code: "gh" },
  { name: "Greece", code: "gr" },
  { name: "Grenada", code: "gd" },
  { name: "Guatemala", code: "gt" },
  { name: "Guinea", code: "gn" },
  { name: "Guinea-Bissau", code: "gw" },
  { name: "Guyana", code: "gy" },
  { name: "Haiti", code: "ht" },
  { name: "Honduras", code: "hn" },
  { name: "Hungary", code: "hu" },
  { name: "Iceland", code: "is" },
  { name: "India", code: "in" },
  { name: "Indonesia", code: "id" },
  { name: "Iran", code: "ir" },
  { name: "Iraq", code: "iq" },
  { name: "Ireland", code: "ie" },
  { name: "Italy", code: "it" },
  { name: "Jamaica", code: "jm" },
  { name: "Japan", code: "jp" },
  { name: "Jordan", code: "jo" },
  { name: "Kazakhstan", code: "kz" },
  { name: "Kenya", code: "ke" },
  { name: "Kiribati", code: "ki" },
  { name: "Kuwait", code: "kw" },
  { name: "Kyrgyzstan", code: "kg" },
  { name: "Laos", code: "la" },
  { name: "Latvia", code: "lv" },
  { name: "Lebanon", code: "lb" },
  { name: "Lesotho", code: "ls" },
  { name: "Liberia", code: "lr" },
  { name: "Libya", code: "ly" },
  { name: "Liechtenstein", code: "li" },
  { name: "Lithuania", code: "lt" },
  { name: "Luxembourg", code: "lu" },
  { name: "Madagascar", code: "mg" },
  { name: "Malawi", code: "mw" },
  { name: "Malaysia", code: "my" },
  { name: "Maldives", code: "mv" },
  { name: "Mali", code: "ml" },
  { name: "Malta", code: "mt" },
  { name: "Marshall Islands", code: "mh" },
  { name: "Mauritania", code: "mr" },
  { name: "Mauritius", code: "mu" },
  { name: "Mexico", code: "mx" },
  { name: "Micronesia", code: "fm" },
  { name: "Moldova", code: "md" },
  { name: "Monaco", code: "mc" },
  { name: "Mongolia", code: "mn" },
  { name: "Montenegro", code: "me" },
  { name: "Morocco", code: "ma" },
  { name: "Mozambique", code: "mz" },
  { name: "Myanmar", code: "mm" },
  { name: "Namibia", code: "na" },
  { name: "Nauru", code: "nr" },
  { name: "Nepal", code: "np" },
  { name: "Netherlands", code: "nl" },
  { name: "New Zealand", code: "nz" },
  { name: "Nicaragua", code: "ni" },
  { name: "Niger", code: "ne" },
  { name: "Nigeria", code: "ng" },
  { name: "North Korea", code: "kp" },
  { name: "North Macedonia", code: "mk" },
  { name: "Norway", code: "no" },
  { name: "Oman", code: "om" },
  { name: "Pakistan", code: "pk" },
  { name: "Palau", code: "pw" },
  { name: "Palestine", code: "ps" },
  { name: "Panama", code: "pa" },
  { name: "Papua New Guinea", code: "pg" },
  { name: "Paraguay", code: "py" },
  { name: "Peru", code: "pe" },
  { name: "Philippines", code: "ph" },
  { name: "Poland", code: "pl" },
  { name: "Portugal", code: "pt" },
  { name: "Qatar", code: "qa" },
  { name: "Romania", code: "ro" },
  { name: "Russia", code: "ru" },
  { name: "Rwanda", code: "rw" },
  { name: "Saint Kitts and Nevis", code: "kn" },
  { name: "Saint Lucia", code: "lc" },
  { name: "Saint Vincent and the Grenadines", code: "vc" },
  { name: "Samoa", code: "ws" },
  { name: "San Marino", code: "sm" },
  { name: "Sao Tome and Principe", code: "st" },
  { name: "Saudi Arabia", code: "sa" },
  { name: "Senegal", code: "sn" },
  { name: "Serbia", code: "rs" },
  { name: "Seychelles", code: "sc" },
  { name: "Sierra Leone", code: "sl" },
  { name: "Singapore", code: "sg" },
  { name: "Slovakia", code: "sk" },
  { name: "Slovenia", code: "si" },
  { name: "Solomon Islands", code: "sb" },
  { name: "Somalia", code: "so" },
  { name: "South Africa", code: "za" },
  { name: "South Korea", code: "kr" },
  { name: "South Sudan", code: "ss" },
  { name: "Spain", code: "es" },
  { name: "Sri Lanka", code: "lk" },
  { name: "Sudan", code: "sd" },
  { name: "Suriname", code: "sr" },
  { name: "Sweden", code: "se" },
  { name: "Switzerland", code: "ch" },
  { name: "Syria", code: "sy" },
  { name: "Taiwan", code: "tw" },
  { name: "Tajikistan", code: "tj" },
  { name: "Tanzania", code: "tz" },
  { name: "Thailand", code: "th" },
  { name: "Timor-Leste", code: "tl" },
  { name: "Togo", code: "tg" },
  { name: "Tonga", code: "to" },
  { name: "Trinidad and Tobago", code: "tt" },
  { name: "Tunisia", code: "tn" },
  { name: "Turkey", code: "tr" },
  { name: "Turkmenistan", code: "tm" },
  { name: "Tuvalu", code: "tv" },
  { name: "Uganda", code: "ug" },
  { name: "Ukraine", code: "ua" },
  { name: "United Arab Emirates", code: "ae" },
  { name: "United Kingdom", code: "gb" },
  { name: "United States", code: "us" },
  { name: "Uruguay", code: "uy" },
  { name: "Uzbekistan", code: "uz" },
  { name: "Vanuatu", code: "vu" },
  { name: "Vatican City", code: "va" },
  { name: "Venezuela", code: "ve" },
  { name: "Vietnam", code: "vn" },
  { name: "Yemen", code: "ye" },
  { name: "Zambia", code: "zm" },
  { name: "Zimbabwe", code: "zw" },
];

/**
 * Build the bundled flag URL for a given ISO alpha-2 code, served from the
 * artifact's own `/flags/<code>.svg` static directory. Honors Vite's BASE_URL.
 */
export function getDefaultFlagUrl(code: string): string {
  const base = (import.meta as ImportMeta & { env?: { BASE_URL?: string } }).env?.BASE_URL ?? "/";
  const normalizedBase = base.endsWith("/") ? base : `${base}/`;
  return `${normalizedBase}flags/${code.toLowerCase()}.svg`;
}

const BY_NAME = new Map<string, CountryEntry>(
  COUNTRY_CATALOGUE.map((c) => [c.name.toLowerCase(), c]),
);
const BY_CODE = new Map<string, CountryEntry>(
  COUNTRY_CATALOGUE.map((c) => [c.code.toLowerCase(), c]),
);

export function findCountryByName(name: string | null | undefined): CountryEntry | undefined {
  if (!name) return undefined;
  return BY_NAME.get(name.trim().toLowerCase());
}

export function findCountryByCode(code: string | null | undefined): CountryEntry | undefined {
  if (!code) return undefined;
  return BY_CODE.get(code.trim().toLowerCase());
}

/**
 * Back-compat: legacy code expects a string[] of country names.
 */
export const WORLD_COUNTRIES: string[] = COUNTRY_CATALOGUE.map((c) => c.name);

export const DEFAULT_COUNTRIES = ["Lebanon", "United Arab Emirates"];

/**
 * Country names that must be excluded from every selector and country-aware
 * code path. Names match the entries used by `WORLD_COUNTRIES`.
 */
export const EXCLUDED_COUNTRY_NAMES: readonly string[] = ["Israel"];

/**
 * ISO 3166-1 alpha-2 codes for countries that must be excluded from every
 * country-aware selector (e.g. the phone-number country picker which is keyed
 * off ISO codes). Kept in lockstep with `EXCLUDED_COUNTRY_NAMES`.
 */
export const EXCLUDED_COUNTRY_CODES: readonly string[] = ["IL"];

/**
 * Returns true when the given value (country name OR ISO 3166-1 alpha-2 code)
 * refers to an excluded country. Comparison is case-insensitive and trims
 * surrounding whitespace.
 */
export function isExcludedCountry(value: string | null | undefined): boolean {
  if (!value) return false;
  const trimmed = value.trim();
  if (!trimmed) return false;
  const upper = trimmed.toUpperCase();
  if (EXCLUDED_COUNTRY_CODES.some((c) => c.toUpperCase() === upper)) return true;
  const lower = trimmed.toLowerCase();
  return EXCLUDED_COUNTRY_NAMES.some((n) => n.toLowerCase() === lower);
}

const CURRENCY_BY_CODE: Readonly<Record<string, string>> = {
  af: "AFN", al: "ALL", dz: "DZD", ad: "EUR", ao: "AOA", ag: "XCD",
  ar: "ARS", am: "AMD", au: "AUD", at: "EUR", az: "AZN", bs: "BSD",
  bh: "BHD", bd: "BDT", bb: "BBD", by: "BYN", be: "EUR", bz: "BZD",
  bj: "XOF", bt: "BTN", bo: "BOB", ba: "BAM", bw: "BWP", br: "BRL",
  bn: "BND", bg: "BGN", bf: "XOF", bi: "BIF", cv: "CVE", kh: "KHR",
  cm: "XAF", ca: "CAD", cf: "XAF", td: "XAF", cl: "CLP", cn: "CNY",
  co: "COP", km: "KMF", cg: "XAF", cr: "CRC", hr: "EUR", cu: "CUP",
  cy: "EUR", cz: "CZK", dk: "DKK", dj: "DJF", dm: "XCD", do: "DOP",
  ec: "USD", eg: "EGP", sv: "USD", gq: "XAF", er: "ERN", ee: "EUR",
  sz: "SZL", et: "ETB", fj: "FJD", fi: "EUR", fr: "EUR", ga: "XAF",
  gm: "GMD", ge: "GEL", de: "EUR", gh: "GHS", gr: "EUR", gd: "XCD",
  gt: "GTQ", gn: "GNF", gw: "XOF", gy: "GYD", ht: "HTG", hn: "HNL",
  hu: "HUF", is: "ISK", in: "INR", id: "IDR", ir: "IRR", iq: "IQD",
  ie: "EUR", it: "EUR", jm: "JMD", jp: "JPY", jo: "JOD", kz: "KZT",
  ke: "KES", ki: "AUD", kw: "KWD", kg: "KGS", la: "LAK", lv: "EUR",
  lb: "LBP", ls: "LSL", lr: "LRD", ly: "LYD", li: "CHF", lt: "EUR",
  lu: "EUR", mg: "MGA", mw: "MWK", my: "MYR", mv: "MVR", ml: "XOF",
  mt: "EUR", mh: "USD", mr: "MRU", mu: "MUR", mx: "MXN", fm: "USD",
  md: "MDL", mc: "EUR", mn: "MNT", me: "EUR", ma: "MAD", mz: "MZN",
  mm: "MMK", na: "NAD", nr: "AUD", np: "NPR", nl: "EUR", nz: "NZD",
  ni: "NIO", ne: "XOF", ng: "NGN", kp: "KPW", mk: "MKD", no: "NOK",
  om: "OMR", pk: "PKR", pw: "USD", ps: "ILS", pa: "PAB", pg: "PGK",
  py: "PYG", pe: "PEN", ph: "PHP", pl: "PLN", pt: "EUR", qa: "QAR",
  ro: "RON", ru: "RUB", rw: "RWF", kn: "XCD", lc: "XCD", vc: "XCD",
  ws: "WST", sm: "EUR", st: "STN", sa: "SAR", sn: "XOF", rs: "RSD",
  sc: "SCR", sl: "SLE", sg: "SGD", sk: "EUR", si: "EUR", sb: "SBD",
  so: "SOS", za: "ZAR", kr: "KRW", ss: "SSP", es: "EUR", lk: "LKR",
  sd: "SDG", sr: "SRD", se: "SEK", ch: "CHF", sy: "SYP", tw: "TWD",
  tj: "TJS", tz: "TZS", th: "THB", tl: "USD", tg: "XOF", to: "TOP",
  tt: "TTD", tn: "TND", tr: "TRY", tm: "TMT", tv: "AUD", ug: "UGX",
  ua: "UAH", ae: "AED", gb: "GBP", us: "USD", uy: "UYU", uz: "UZS",
  vu: "VUV", va: "EUR", ve: "VES", vn: "VND", ye: "YER", zm: "ZMW",
  zw: "ZWG",
};

export function getCountryFlagEmoji(code: string | null | undefined): string {
  if (!code) return "";
  const upper = code.trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(upper)) return "";
  return (
    String.fromCodePoint(0x1f1e6 + upper.charCodeAt(0) - 65) +
    String.fromCodePoint(0x1f1e6 + upper.charCodeAt(1) - 65)
  );
}

const CURRENCY_TO_COUNTRY: Readonly<Record<string, string>> = {
  usd: "us", aed: "ae", lbp: "lb", sar: "sa", qar: "qa",
  kwd: "kw", omr: "om", bhd: "bh", jod: "jo", egp: "eg",
  gbp: "gb",
};

/** Flag emoji for a currency code (e.g. "USD" → 🇺🇸). Best-effort reverse of CURRENCY_BY_CODE. */
export function getCurrencyFlagEmoji(currency: string | null | undefined): string {
  if (!currency) return "";
  const c = currency.trim().toLowerCase();
  const country = CURRENCY_TO_COUNTRY[c] ?? findCountryCodeForCurrency(c);
  return getCountryFlagEmoji(country);
}

function findCountryCodeForCurrency(currency: string): string | null {
  for (const [code, cur] of Object.entries(CURRENCY_BY_CODE)) {
    if (cur.toLowerCase() === currency) return code;
  }
  return null;
}

export type CountryMetadata = {
  name: string;
  /** ISO 3166-1 alpha-2 code, lowercase. */
  code: string;
  /** Two-character flag emoji (regional indicator symbols). */
  flagEmoji: string;
  /** ISO 4217 currency code, or null when unknown. */
  currency: string | null;
};

export function getCountryMetadata(name: string | null | undefined): CountryMetadata | null {
  const entry = findCountryByName(name);
  if (!entry) return null;
  return {
    name: entry.name,
    code: entry.code,
    flagEmoji: getCountryFlagEmoji(entry.code),
    currency: CURRENCY_BY_CODE[entry.code] ?? null,
  };
}

export function getCountryMetadataByCode(code: string | null | undefined): CountryMetadata | null {
  const entry = findCountryByCode(code);
  if (!entry) return null;
  return {
    name: entry.name,
    code: entry.code,
    flagEmoji: getCountryFlagEmoji(entry.code),
    currency: CURRENCY_BY_CODE[entry.code] ?? null,
  };
}

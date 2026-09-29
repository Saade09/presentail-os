/**
 * Default country list used when a workspace has no configured available_countries.
 * Single source of truth — imported by both paymentLinks.ts and settings.ts.
 */
export const DEFAULT_COUNTRIES = ["Lebanon", "United Arab Emirates"];

/**
 * Country names that must be excluded from every selector and country-aware
 * code path on the server (settings, locations, payment links, order
 * ingestion, etc.).
 */
export const EXCLUDED_COUNTRY_NAMES: readonly string[] = ["Israel"];

/**
 * ISO 3166-1 alpha-2 codes for countries that must be excluded. Kept in
 * lockstep with `EXCLUDED_COUNTRY_NAMES`.
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

export type CountryEntry = {
  /** Display name (matches the strings stored in workspace_settings.available_countries). */
  name: string;
  /** ISO 3166-1 alpha-2 code, lowercase. */
  code: string;
};

/**
 * Master server-side catalogue. Mirrors the web `COUNTRY_CATALOGUE` (same
 * names + codes, kept in sync). Israel is intentionally excluded.
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
 * International dial-code prefix → ISO 3166-1 alpha-2 code (lowercase).
 *
 * Keys are digit-only prefixes (no "+"). Where several countries share a
 * short prefix (e.g. the +1 North American plan or +7), the shorter prefix
 * maps to the dominant country and the longer, more specific prefixes map to
 * the others — lookups always prefer the LONGEST matching prefix.
 * Kept in lockstep with `COUNTRY_CATALOGUE` (Israel intentionally absent).
 */
export const DIAL_CODE_TO_COUNTRY: Readonly<Record<string, string>> = {
  // NANP (+1): default to the US; islands get their specific area codes.
  "1": "us",
  "1242": "bs", "1246": "bb", "1268": "ag", "1473": "gd", "1758": "lc",
  "1767": "dm", "1784": "vc", "1809": "do", "1829": "do", "1849": "do",
  "1868": "tt", "1869": "kn", "1876": "jm", "1658": "jm",
  // +7: Russia by default; Kazakhstan uses 76x/77x.
  "7": "ru", "76": "kz", "77": "kz",
  "20": "eg", "211": "ss", "212": "ma", "213": "dz", "216": "tn", "218": "ly",
  "220": "gm", "221": "sn", "222": "mr", "223": "ml", "224": "gn",
  "226": "bf", "227": "ne", "228": "tg", "229": "bj", "230": "mu", "231": "lr",
  "232": "sl", "233": "gh", "234": "ng", "235": "td", "236": "cf", "237": "cm",
  "238": "cv", "239": "st", "240": "gq", "241": "ga", "242": "cg", "244": "ao",
  "245": "gw", "248": "sc", "249": "sd", "250": "rw", "251": "et", "252": "so",
  "253": "dj", "254": "ke", "255": "tz", "256": "ug", "257": "bi", "258": "mz",
  "260": "zm", "261": "mg", "263": "zw", "264": "na", "265": "mw", "266": "ls",
  "267": "bw", "268": "sz", "269": "km",
  "27": "za",
  "291": "er",
  "30": "gr", "31": "nl", "32": "be", "33": "fr", "34": "es",
  "351": "pt", "352": "lu", "353": "ie", "354": "is", "355": "al", "356": "mt",
  "357": "cy", "358": "fi", "359": "bg",
  "36": "hu",
  "370": "lt", "371": "lv", "372": "ee", "373": "md", "374": "am", "375": "by",
  "376": "ad", "377": "mc", "378": "sm", "379": "va", "380": "ua", "381": "rs",
  "382": "me", "385": "hr", "386": "si", "387": "ba", "389": "mk",
  "39": "it",
  "40": "ro", "41": "ch", "420": "cz", "421": "sk", "423": "li",
  "43": "at", "44": "gb", "45": "dk", "46": "se", "47": "no", "48": "pl",
  "49": "de",
  "501": "bz", "502": "gt", "503": "sv", "504": "hn", "505": "ni", "506": "cr",
  "507": "pa", "509": "ht",
  "51": "pe", "52": "mx", "53": "cu", "54": "ar", "55": "br", "56": "cl",
  "57": "co", "58": "ve",
  "591": "bo", "592": "gy", "593": "ec", "595": "py", "597": "sr", "598": "uy",
  "60": "my", "61": "au", "62": "id", "63": "ph", "64": "nz", "65": "sg",
  "66": "th",
  "670": "tl", "673": "bn", "674": "nr", "675": "pg", "676": "to", "677": "sb",
  "678": "vu", "679": "fj", "680": "pw", "685": "ws", "686": "ki", "688": "tv",
  "691": "fm", "692": "mh",
  "81": "jp", "82": "kr", "84": "vn", "850": "kp", "855": "kh", "856": "la", "86": "cn", "880": "bd", "886": "tw",
  "90": "tr", "91": "in", "92": "pk", "93": "af", "94": "lk", "95": "mm",
  "960": "mv", "961": "lb", "962": "jo", "963": "sy", "964": "iq", "965": "kw",
  "966": "sa", "967": "ye", "968": "om", "970": "ps", "971": "ae", "973": "bh",
  "974": "qa", "975": "bt", "976": "mn", "977": "np", "98": "ir",
  "992": "tj", "993": "tm", "994": "az", "995": "ge", "996": "kg", "998": "uz",
};

/** Longest dial-code prefix length present in the mapping. */
const MAX_DIAL_PREFIX = Math.max(
  ...Object.keys(DIAL_CODE_TO_COUNTRY).map((k) => k.length),
);

/** Minimum national-number digits required after the dial code to accept a match. */
const MIN_NATIONAL_DIGITS = 5;

/**
 * Normalize a raw phone string for dial-code classification. Returns the
 * digit string (with an international "00" prefix stripped) plus whether the
 * number was written in an explicit international format ("+" or leading 00).
 */
export function normalizePhoneForDialCode(
  phone: string | null | undefined,
): { digits: string; international: boolean } {
  const raw = (phone ?? "").trim();
  const allDigits = raw.replace(/[^0-9]/g, "");
  const hasPlus = raw.startsWith("+");
  const hasIdd = !hasPlus && allDigits.startsWith("00");
  const digits = hasIdd ? allDigits.slice(2) : allDigits;
  return { digits, international: hasPlus || hasIdd };
}

/**
 * Classify a phone number into a country by its international dial code.
 *
 * - Longest-prefix match (so +1242 → Bahamas, not the generic +1 → US).
 * - Accepts numbers with a leading "+", a leading "00", or bare digits.
 *   Bare-digit numbers are only classified when long enough to plausibly
 *   include a dial code (≥ 10 digits); shorter local-format numbers return
 *   undefined so callers can fall back.
 * - Requires at least a few national digits after the prefix to avoid
 *   matching junk.
 */
export function findCountryByPhone(
  phone: string | null | undefined,
): CountryEntry | undefined {
  const { digits, international } = normalizePhoneForDialCode(phone);
  if (!digits) return undefined;
  if (!international && digits.length < 10) return undefined;
  for (let len = Math.min(MAX_DIAL_PREFIX, digits.length); len >= 1; len--) {
    const code = DIAL_CODE_TO_COUNTRY[digits.slice(0, len)];
    if (!code) continue;
    if (digits.length - len < MIN_NATIONAL_DIGITS) return undefined;
    return findCountryByCode(code);
  }
  return undefined;
}

/**
 * SQL expression classifying a phone column/expression into a lowercase ISO
 * country code (or NULL) with the same semantics as `findCountryByPhone`.
 * The returned expression is a scalar subquery; `rawExpr` must be a trusted,
 * server-generated SQL fragment (e.g. `c.phone`), never user input.
 */
export function phoneCountrySql(rawExpr: string): string {
  const prefixes = Object.keys(DIAL_CODE_TO_COUNTRY)
    // Longest prefix first so specific codes win over shared short ones.
    .sort((a, b) => b.length - a.length || a.localeCompare(b));
  const cases = prefixes
    .map((p) => {
      const iso = DIAL_CODE_TO_COUNTRY[p];
      return `WHEN d.digits LIKE '${p}%' AND length(d.digits) >= ${p.length + MIN_NATIONAL_DIGITS} THEN '${iso}'`;
    })
    .join("\n      ");
  return `(
    SELECT CASE
      WHEN d.digits = '' THEN NULL
      WHEN NOT d.intl AND length(d.digits) < 10 THEN NULL
      ${cases}
      ELSE NULL
    END
    FROM (
      SELECT
        CASE WHEN NOT TRIM(COALESCE(${rawExpr}, '')) LIKE '+%'
                  AND regexp_replace(COALESCE(${rawExpr}, ''), '[^0-9]', '', 'g') LIKE '00%'
             THEN substring(regexp_replace(COALESCE(${rawExpr}, ''), '[^0-9]', '', 'g') FROM 3)
             ELSE regexp_replace(COALESCE(${rawExpr}, ''), '[^0-9]', '', 'g')
        END AS digits,
        (TRIM(COALESCE(${rawExpr}, '')) LIKE '+%'
         OR regexp_replace(COALESCE(${rawExpr}, ''), '[^0-9]', '', 'g') LIKE '00%') AS intl
    ) d
  )`;
}

/**
 * Bundled (default) flag URL for a country. The web app serves the SVGs from
 * `<BASE_URL>flags/<code>.svg`. The server-rendered URL is host-relative
 * (the app's reverse proxy routes `/flags/...` to the web artifact).
 */
export function getDefaultFlagUrl(code: string): string {
  return `/flags/${code.toLowerCase()}.svg`;
}

/**
 * ISO 4217 currency code for each ISO 3166-1 alpha-2 country code (lowercase).
 * Returns `null` from `getCountryMetadata` for codes not listed here.
 */
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

/**
 * Convert an ISO 3166-1 alpha-2 code to the corresponding pair of regional
 * indicator symbols (the "flag emoji"). Returns an empty string for invalid
 * input.
 */
export function getCountryFlagEmoji(code: string | null | undefined): string {
  if (!code) return "";
  const upper = code.trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(upper)) return "";
  return (
    String.fromCodePoint(0x1f1e6 + upper.charCodeAt(0) - 65) +
    String.fromCodePoint(0x1f1e6 + upper.charCodeAt(1) - 65)
  );
}

export type CountryMetadata = {
  /** Display name. */
  name: string;
  /** ISO 3166-1 alpha-2 code, lowercase. */
  code: string;
  /** Two-character flag emoji (regional indicator symbols). */
  flagEmoji: string;
  /** ISO 4217 currency code, or null when unknown. */
  currency: string | null;
};

/** Look up extended metadata for a country by display name. */
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

/** Look up extended metadata for a country by ISO 3166-1 alpha-2 code (any case). */
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

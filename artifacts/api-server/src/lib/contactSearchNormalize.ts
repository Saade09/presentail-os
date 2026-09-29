/**
 * Normalization helpers for the Create Order wizard contact search.
 *
 * Matching rules (mirrored on the client for duplicate hints):
 * - Phone: compared on digits only — spaces, hyphens, parentheses and dots are
 *   ignored. The search generates multiple normalized token forms (E.164 digits,
 *   national significant number, domestic form with trunk prefix) so that a
 *   local-format query like "03257" matches a stored "+9613257533".
 * - Email: trimmed + lowercased, partial (substring) match.
 * - Name: trimmed, internal whitespace collapsed, case-insensitive partial.
 */

import { parsePhoneNumber, isValidPhoneNumber } from "libphonenumber-js";

/** Digits-only form of a phone-ish string ("+961 70-123" → "96170123"). */
export function normalizePhoneDigits(raw: string | null | undefined): string {
  if (!raw) return "";
  return raw.replace(/[^0-9]/g, "");
}

/** Alias used in query normalization — strips all non-digit characters. */
export const normalizeQueryDigits = normalizePhoneDigits;

/** Trimmed + lowercased email-ish string. */
export function normalizeEmailQuery(raw: string | null | undefined): string {
  if (!raw) return "";
  return raw.trim().toLowerCase();
}

/** Trim + collapse internal whitespace for name comparison. */
export function collapseName(raw: string | null | undefined): string {
  if (!raw) return "";
  return raw.trim().replace(/\s+/g, " ");
}

/** Escape ILIKE metacharacters so user input is treated literally. */
export function escapeLike(raw: string): string {
  return raw.replace(/([%_\\])/g, "\\$1");
}

/**
 * Build all searchable digit tokens for a stored phone number.
 *
 * For a valid phone like "+9613257533" (Lebanon) this produces:
 *   - "9613257533"  — E.164 digits without "+"
 *   - "3257533"     — national significant number (no country code, no trunk 0)
 *   - "03257533"    — domestic form (national significant number with trunk "0")
 *
 * For numbers that can't be parsed (short local-only strings, unknown formats),
 * falls back to the single stripped-digit representation so nothing regresses.
 *
 * The country hint (e.g. "LB", "AE") is only used when the number has no
 * country-code prefix; most stored numbers are in E.164 so the hint is optional.
 */
export function buildPhoneSearchTokens(
  phone: string | null | undefined,
  countryHint?: string,
): string[] {
  if (!phone) return [];

  const rawDigits = normalizePhoneDigits(phone);
  if (!rawDigits) return [];

  try {
    const parsed = parsePhoneNumber(
      phone,
      countryHint as Parameters<typeof parsePhoneNumber>[1],
    );
    if (parsed && parsed.isValid()) {
      const e164Digits = parsed.number.replace(/^\+/, ""); // "9613257533"
      const nsn = parsed.nationalNumber; // "3257533" (string of digits)
      const domestic = "0" + nsn; // "03257533"
      const tokens = new Set<string>([e164Digits, nsn, domestic]);
      // Also include raw digits as a safety catch (e.g. stored with leading 0)
      tokens.add(rawDigits);
      return Array.from(tokens).filter((t) => t.length > 0);
    }
  } catch {
    // libphonenumber-js throws on completely unrecognizable input — fall through
  }

  // Fallback: single stripped-digit form
  return [rawDigits];
}

export type SearchTerms = {
  /** Digits-only phone fragment; empty when the query has fewer than 4 digits. */
  phoneDigits: string;
  /** Lowercased email fragment; empty unless the query contains "@". */
  emailQuery: string;
  /** Collapsed name fragment; empty when the query is only digits/punctuation. */
  nameQuery: string;
};

/**
 * Classify a raw search query into the phone/email/name fragments that should
 * participate in matching. A query can match on several axes at once (e.g.
 * "70" matches phones AND names containing "70").
 *
 * The minimum phone-digit threshold is 4 (raised from 3) to reduce noise from
 * the expanded multi-token match surface.
 */
export function buildSearchTerms(raw: string): SearchTerms {
  const trimmed = collapseName(raw);
  const digits = normalizePhoneDigits(trimmed);
  const looksEmailish = trimmed.includes("@");
  // Name matching applies whenever there is at least one letter.
  const hasLetter = /\p{L}/u.test(trimmed);
  return {
    phoneDigits: digits.length >= 4 ? digits : "",
    emailQuery: looksEmailish ? trimmed.toLowerCase() : "",
    nameQuery: hasLetter && !looksEmailish ? trimmed : "",
  };
}

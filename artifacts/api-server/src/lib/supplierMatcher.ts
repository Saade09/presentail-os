/**
 * Shared supplier name matching utilities.
 * Used by:
 *   - suppliers.ts (duplicate detection during create/update)
 *   - finance.ts (auto-match vendor name from AI extraction → existing supplier)
 */

const COMPANY_SUFFIXES_RE =
  /\b(llc|l\s*l\s*c|sal|s\s*a\s*l|sarl|s\s*a\s*r\s*l|ltd|l\s*t\s*d|limited|inc|i\s*n\s*c|co|company|trading|est|establishment)\b/gi;
const STOP_WORDS = new Set(["and", "the", "for", "of", "de", "le", "la", "el", "al"]);

export function normalizeSupplierName(name: string): string {
  return name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/\p{Diacritic}/gu, "")
    .trim()
    .replace(/[^\w\s]/g, " ")
    .replace(COMPANY_SUFFIXES_RE, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function levenshtein(a: string, b: string): number {
  const m = a.length,
    n = b.length;
  const prev = Array.from({ length: n + 1 }, (_, j) => j);
  const curr = new Array<number>(n + 1);
  for (let i = 1; i <= m; i++) {
    curr[0] = i;
    for (let j = 1; j <= n; j++) {
      curr[j] =
        a[i - 1] === b[j - 1]
          ? prev[j - 1]
          : 1 + Math.min(prev[j], curr[j - 1], prev[j - 1]);
    }
    for (let j = 0; j <= n; j++) prev[j] = curr[j];
  }
  return prev[n];
}

export function similarityScore(a: string, b: string): number {
  if (!a && !b) return 100;
  if (!a || !b) return 0;
  if (a === b) return 100;
  const dist = levenshtein(a, b);
  const maxLen = Math.max(a.length, b.length);
  return Math.round((1 - dist / maxLen) * 100);
}

export type SupplierCandidate = {
  id: number;
  name: string;
  display_name: string | null;
  aliases?: string[];
};

export type SupplierMatchCandidate = SupplierCandidate & {
  score: number;
  matchedBy?: "exact" | "token" | "fuzzy";
};

function supplierTokens(value: string): string[] {
  return [...new Set(
    normalizeSupplierName(value)
      .split(" ")
      .filter((token) => token.length >= 2 && !STOP_WORDS.has(token)),
  )];
}

function scoreSupplierCandidate(vendorName: string, candidate: SupplierCandidate): SupplierMatchCandidate {
  const normalizedVendor = normalizeSupplierName(vendorName);
  const names = [candidate.name, candidate.display_name ?? "", ...(candidate.aliases ?? [])]
    .map(normalizeSupplierName)
    .filter(Boolean);
  let best = 0;
  let matchedBy: SupplierMatchCandidate["matchedBy"] = "fuzzy";

  for (const name of names) {
    if (normalizedVendor === name) {
      best = 100;
      matchedBy = "exact";
      continue;
    }

    const vendorTokens = supplierTokens(normalizedVendor);
    const nameTokens = supplierTokens(name);
    const shared = vendorTokens.filter((token) => nameTokens.includes(token));
    const overlap = shared.length
      ? Math.round((shared.length / Math.max(vendorTokens.length, nameTokens.length)) * 100)
      : 0;
    const weightedOverlap = shared.length
      ? Math.round((shared.reduce((total, token) => total + Math.min(token.length, 10), 0) /
        Math.max(1, Math.max(
          vendorTokens.reduce((total, token) => total + Math.min(token.length, 10), 0),
          nameTokens.reduce((total, token) => total + Math.min(token.length, 10), 0),
        ))) * 100)
      : 0;
    const fuzzy = similarityScore(normalizedVendor, name);
    const tokenScore = Math.max(overlap, weightedOverlap);
    // A long shared token is useful evidence even when extraction includes
    // descriptive words that are not present in the legal supplier name.
    const distinctiveToken = shared.some((token) => token.length >= 5) ? 88 : 0;
    const score = Math.max(fuzzy, tokenScore, distinctiveToken);
    if (score > best) {
      best = score;
      matchedBy = score === distinctiveToken ? "token" : "fuzzy";
    }
  }

  return { ...candidate, score: best, matchedBy };
}

/**
 * Returns the best-matching supplier if score >= 90, otherwise null.
 * Used for silent auto-linking.
 */
export function matchSupplierByName(
  vendorName: string,
  suppliers: SupplierCandidate[],
): SupplierMatchCandidate | null {
  if (!vendorName || suppliers.length === 0) return null;

  const ranked = rankSupplierCandidates(vendorName, suppliers, suppliers.length);
  const best = ranked[0];
  const second = ranked[1];
  if (!best || best.score < 88) return null;
  // Exact names are deterministic. For inferred matches require a meaningful
  // lead so the nearest string is never chosen from a genuine tie.
  if (second && best.score === second.score) return null;
  if (best.matchedBy !== "exact" && second && best.score - second.score < 8) return null;
  return best;
}

/**
 * Returns all suppliers with score >= 60, sorted by score descending.
 * Used for the suggestion UI when no auto-match was found.
 */
export function rankSupplierCandidates(
  vendorName: string,
  suppliers: SupplierCandidate[],
  limit = 5,
): SupplierMatchCandidate[] {
  if (!vendorName || suppliers.length === 0) return [];

  return suppliers
    .map((supplier) => scoreSupplierCandidate(vendorName, supplier))
    .filter((candidate) => candidate.score >= 60)
    .sort((a, b) => b.score - a.score || a.id - b.id)
    .slice(0, limit);
}

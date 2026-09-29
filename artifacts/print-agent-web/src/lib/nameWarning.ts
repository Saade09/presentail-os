export type NameWarning = {
  exactMatch: string | null;
  similarMatches: string[];
};

export function checkNameWarning(typed: string, existingNames: string[]): NameWarning {
  const trimmed = typed.trim();
  if (!trimmed) return { exactMatch: null, similarMatches: [] };

  const lower = trimmed.toLowerCase();
  let exactMatch: string | null = null;
  const similarMatches: string[] = [];

  for (const name of existingNames) {
    const nameLower = name.trim().toLowerCase();
    if (nameLower === lower) {
      exactMatch = name;
    } else if (nameLower.includes(lower) || lower.includes(nameLower)) {
      similarMatches.push(name);
    }
  }

  return { exactMatch, similarMatches };
}

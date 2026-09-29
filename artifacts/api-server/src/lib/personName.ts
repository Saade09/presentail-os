/**
 * Normalize a person name for manual-order output.
 *
 * This deliberately operates only on name-like values. It trims and collapses
 * whitespace, lowercases cased letters within each component, and restores the
 * first cased letter. Punctuation stays in place, so names such as
 * "mary-jane" and "o'connor" become "Mary-Jane" and "O'Connor". Scripts
 * without casing (Arabic, Han, etc.) are returned safely without inventing
 * placeholder text.
 */
export function normalizePersonName(
  value: string | null | undefined,
): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim().replace(/\s+/g, " ");
  if (!trimmed) return null;

  return trimmed
    .split(" ")
    .map((component) => {
      const lower = component.toLocaleLowerCase();
      let capitalizeNext = true;
      return Array.from(lower)
        .map((char) => {
          const isWordCharacter = /[\p{L}\p{N}]/u.test(char);
          const isCased =
            char.toLocaleUpperCase() !== char.toLocaleLowerCase();
          const result =
            capitalizeNext && isCased ? char.toLocaleUpperCase() : char;
          capitalizeNext = !isWordCharacter;
          return result;
        })
        .join("");
    })
    .join(" ");
}
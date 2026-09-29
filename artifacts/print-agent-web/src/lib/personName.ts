/**
 * Client mirror of the server's manual-order person-name formatter.
 * Keep free-form card messages and non-name text untouched.
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
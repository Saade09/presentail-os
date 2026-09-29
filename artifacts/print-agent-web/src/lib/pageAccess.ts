export function hasBrandsAccess(pages: string[]): boolean {
  return pages.some((p) => p === "brands" || p.startsWith("brands."));
}

/**
 * Shared predicate for identifying the CMC Beirut Hospital location.
 *
 * The codebase convention is name-based identification (no structural flag).
 * This module is intentionally separate from lib/workspace so that route tests
 * that vi.mock("../lib/workspace") wholesale do not accidentally stub this out.
 */

/** True when the location name refers to the CMC Beirut Hospital location. */
export function isCmcLocation(locationName: string | null | undefined): boolean {
  if (!locationName) return false;
  return locationName.toLowerCase().includes("cmc beirut hospital");
}

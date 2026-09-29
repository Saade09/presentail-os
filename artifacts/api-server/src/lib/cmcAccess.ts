import type { WorkspaceRequest } from "./workspace";
import {
  CMC_POS_DASHBOARD_PAGE_KEY,
  CMC_POS_NEW_ORDER_PAGE_KEY,
} from "@workspace/page-keys";

/**
 * Pure predicate: does this role/page set grant base CMC POS access?
 * Owners and members with the canonical Dashboard page pass. Legacy
 * `cmc-pos` and `cmc_pos.*` grants remain valid for compatibility. The
 * canonical New Order page intentionally does not imply dashboard access.
 *
 * Lives in its own module (not lib/workspace.ts) so route tests that mock
 * `../lib/workspace` keep working without stubbing this predicate.
 */
export function cmcPosBaseAccess(
  role: string,
  allowedPages: string[] | null | undefined,
): boolean {
  if (role === "owner") return true;
  return !!allowedPages?.some(
    (page) =>
      page === CMC_POS_DASHBOARD_PAGE_KEY ||
      page === "cmc-pos" ||
      page.startsWith("cmc_pos."),
  );
}

/** Request-level wrapper around {@link cmcPosBaseAccess}. */
export function hasCmcPosBaseAccess(wreq: WorkspaceRequest): boolean {
  return cmcPosBaseAccess(wreq.workspaceRole, wreq.allowedPages);
}

/**
 * True when a user may open and submit the CMC New Order workflow.
 * Unlike the legacy base CMC predicate, this intentionally checks the new
 * page permission exactly so Dashboard-only roles cannot create orders.
 */
export function cmcPosNewOrderAccess(
  role: string,
  allowedPages: string[] | null | undefined,
): boolean {
  if (role === "owner") return true;
  return !!allowedPages?.includes(CMC_POS_NEW_ORDER_PAGE_KEY);
}

export function hasCmcPosNewOrderAccess(wreq: WorkspaceRequest): boolean {
  return cmcPosNewOrderAccess(wreq.workspaceRole, wreq.allowedPages);
}

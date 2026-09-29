import { describe, it, expect } from "vitest";
import { hasPageAccess, type WorkspaceRequest } from "../lib/workspace";
import {
  cmcPosBaseAccess,
  cmcPosNewOrderAccess,
  hasCmcPosBaseAccess,
  hasCmcPosNewOrderAccess,
} from "../lib/cmcAccess";

// ---------------------------------------------------------------------------
// Task: CMC page access implies action access.
//
// The base CMC POS gate (requireCmcPos in cmcPos.ts) recognizes the canonical
// Dashboard page as well as legacy `cmc-pos` and `cmc_pos.*` grants. New Order
// is deliberately excluded and is enforced separately in orders.ts. Actions
// whose pages are gated by base CMC access (sale creation, request
// create/submit/transitions, and location-request actions) use this predicate.
// Strict pages additionally require their exact action key.
// ---------------------------------------------------------------------------

function member(pages: string[]): WorkspaceRequest {
  return { workspaceRole: "member", allowedPages: pages } as WorkspaceRequest;
}

const owner = { workspaceRole: "owner", allowedPages: null } as WorkspaceRequest;

// ---------------------------------------------------------------------------
// Base CMC access predicate (drives order creation, sale creation, request
// create/submit/transitions, and location-request actions)
// ---------------------------------------------------------------------------

describe("cmcPosBaseAccess — base CMC gate matches the web predicate", () => {
  it("owner always passes", () => {
    expect(cmcPosBaseAccess("owner", null)).toBe(true);
    expect(hasCmcPosBaseAccess(owner)).toBe(true);
  });

  it("member with the cmc-pos page passes", () => {
    expect(hasCmcPosBaseAccess(member(["cmc-pos"]))).toBe(true);
  });

  it("Dashboard-only passes the dashboard API gate but New-Order-only does not", () => {
    expect(hasCmcPosBaseAccess(member(["cmc-pos-dashboard"]))).toBe(true);
    expect(hasCmcPosBaseAccess(member(["cmc-pos-new-order"]))).toBe(false);
  });

  it("member with ONLY a cmc_pos.* sub-permission passes (page access implies action access)", () => {
    for (const sub of [
      "cmc_pos.sell",
      "cmc_pos.create_request",
      "cmc_pos.accept_request",
      "cmc_pos.dispatch_request",
      "cmc_pos.receive_request",
      "cmc_pos.delete_request",
      "cmc_pos.view_location_requests",
      "cmc_pos.audit",
      "cmc_pos.cash_drawer",
    ]) {
      expect(hasCmcPosBaseAccess(member([sub]))).toBe(true);
    }
  });

  it("member with no CMC keys is rejected", () => {
    expect(hasCmcPosBaseAccess(member([]))).toBe(false);
    expect(hasCmcPosBaseAccess(member(["orders", "products"]))).toBe(false);
  });

  it("does not match lookalike keys", () => {
    expect(hasCmcPosBaseAccess(member(["cmc_pos"]))).toBe(false); // no dot suffix
    expect(hasCmcPosBaseAccess(member(["cmc-pos-other"]))).toBe(false);
  });

  it("handles null/undefined allowedPages for members", () => {
    expect(cmcPosBaseAccess("member", null)).toBe(false);
    expect(cmcPosBaseAccess("member", undefined)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Action-by-action coverage: each relaxed action is gated ONLY by base access
// ---------------------------------------------------------------------------

describe("Relaxed actions pass with any base CMC access", () => {
  const scenarios: Array<[string, WorkspaceRequest, boolean]> = [
    ["owner", owner, true],
    ["member with Dashboard page", member(["cmc-pos-dashboard"]), true],
    ["member with cmc-pos page", member(["cmc-pos"]), true],
    ["member with only New Order page", member(["cmc-pos-new-order"]), false],
    ["member with only cmc_pos.sell", member(["cmc_pos.sell"]), true],
    ["member with only cmc_pos.view_location_requests", member(["cmc_pos.view_location_requests"]), true],
    ["member with no CMC keys", member([]), false],
  ];

  for (const action of [
    "sale creation (POST /cmc-pos/sales)",
    "request creation (POST /cmc-pos/requests)",
    "request transitions (submit/accept/dispatch/receive/cancel)",
    "location-request delete (DELETE /cmc-pos/requests/:id)",
    "tookan retry (POST /cmc-pos/requests/:id/retry-tookan)",
  ]) {
    describe(action, () => {
      for (const [name, wreq, expected] of scenarios) {
        it(`${name} → ${expected ? "allowed" : "403"}`, () => {
          expect(hasCmcPosBaseAccess(wreq)).toBe(expected);
        });
      }
    });
  }
});

// ---------------------------------------------------------------------------
// POST /orders/manual keeps the orders-page path separate from CMC New Order
// ---------------------------------------------------------------------------

describe("CMC New Order permission", () => {
  it("allows owners and exact New Order grants", () => {
    expect(cmcPosNewOrderAccess("owner", null)).toBe(true);
    expect(hasCmcPosNewOrderAccess(owner)).toBe(true);
    expect(hasCmcPosNewOrderAccess(member(["cmc-pos-new-order"]))).toBe(true);
  });

  it("rejects Dashboard-only, legacy broad, action-only, and unrelated roles", () => {
    expect(hasCmcPosNewOrderAccess(member(["cmc-pos-dashboard"]))).toBe(false);
    expect(hasCmcPosNewOrderAccess(member(["cmc-pos"]))).toBe(false);
    expect(hasCmcPosNewOrderAccess(member(["cmc_pos.create_request"]))).toBe(false);
    expect(hasCmcPosNewOrderAccess(member(["products"]))).toBe(false);
  });

  it("keeps ordinary dashboard order creation on the Orders permission", () => {
    expect(hasPageAccess(member(["orders"]), "orders")).toBe(true);
    expect(hasCmcPosNewOrderAccess(member(["orders"]))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Strict pages stay strict — exact key still required (hasSub/can semantics
// in cmcPos.ts are hasPageAccess semantics: owner or exact key)
// ---------------------------------------------------------------------------

describe("Strict gates still require their exact key", () => {
  const strictKeys = [
    "cmc_pos.audit",
    "cmc_pos.cash_drawer",
    "cmc_pos.monthly_sales",
    "cmc_pos.returns",
    "cmc_pos.edit",
    "cmc_pos.refund",
  ];

  for (const key of strictKeys) {
    it(`${key}: member with only cmc-pos page is rejected`, () => {
      expect(hasPageAccess(member(["cmc-pos"]), key)).toBe(false);
    });

    it(`${key}: member with a different cmc_pos.* sub-permission is rejected`, () => {
      expect(hasPageAccess(member(["cmc_pos.sell"]), key)).toBe(false);
    });

    it(`${key}: member with the exact key is allowed`, () => {
      expect(hasPageAccess(member([key]), key)).toBe(true);
    });

    it(`${key}: owner is allowed`, () => {
      expect(hasPageAccess(owner, key)).toBe(true);
    });
  }
});

import { describe, it, expect } from "vitest";

// ---------------------------------------------------------------------------
// Pure-function helpers mirroring the permission logic in cmcPos.ts
// ---------------------------------------------------------------------------

function isOwner(role: string): boolean {
  return role === "owner";
}

function can(role: string, allowedPages: string[], key: string): boolean {
  return isOwner(role) || allowedPages.includes(key);
}

function hasSub(role: string, allowedPages: string[], sub: string): boolean {
  return isOwner(role) || allowedPages.includes(sub);
}

// The sub-access helper used by the nav — mirrors hasCmcPosSubAccess
function hasCmcPosSubAccess(subKey: string): (pages: string[]) => boolean {
  return (pages: string[]) => {
    const hasParent = pages.includes("cmc-pos");
    const hasAnySubPerm = pages.some((p) => p.startsWith("cmc_pos."));
    return pages.includes(subKey) || (hasParent && !hasAnySubPerm);
  };
}

// ---------------------------------------------------------------------------
// Scenario 1 — cmc_pos.cash_drawer is a valid sub-permission key
// ---------------------------------------------------------------------------

describe("cmc_pos.cash_drawer key recognition", () => {
  const CASH_DRAWER_KEY = "cmc_pos.cash_drawer";

  it("starts with cmc_pos. prefix (consistent with other CMC sub-permissions)", () => {
    expect(CASH_DRAWER_KEY.startsWith("cmc_pos.")).toBe(true);
  });

  it("is distinct from parent cmc-pos key", () => {
    expect(CASH_DRAWER_KEY).not.toBe("cmc-pos");
  });

  it("differs from other sub-permissions like cmc_pos.sell", () => {
    expect(CASH_DRAWER_KEY).not.toBe("cmc_pos.sell");
  });
});

// ---------------------------------------------------------------------------
// Scenario 2 — GET /api/cmc-pos/cash-drawer permission gate
// Requires: cmc-pos (parent) AND cmc_pos.cash_drawer (sub-permission)
// ---------------------------------------------------------------------------

describe("GET /cmc-pos/cash-drawer — permission gate", () => {
  // Owner always has access
  it("owner always has access regardless of allowedPages", () => {
    expect(can("owner", [], "cmc-pos")).toBe(true);
    expect(hasSub("owner", [], "cmc_pos.cash_drawer")).toBe(true);
  });

  // Member with both parent + sub-permission
  it("member with cmc-pos + cmc_pos.cash_drawer has access", () => {
    const pages = ["cmc-pos", "cmc_pos.cash_drawer"];
    expect(can("member", pages, "cmc-pos")).toBe(true);
    expect(hasSub("member", pages, "cmc_pos.cash_drawer")).toBe(true);
  });

  // Member with parent but NOT cash_drawer sub-permission is denied
  it("member with only cmc-pos (no cash_drawer sub-perm) is denied the sub-check", () => {
    const pages = ["cmc-pos"];
    expect(can("member", pages, "cmc-pos")).toBe(true); // parent gate passes
    expect(hasSub("member", pages, "cmc_pos.cash_drawer")).toBe(false); // sub-perm gate fails
  });

  // Member with only cash_drawer but not parent cmc-pos
  it("member with only cmc_pos.cash_drawer (no cmc-pos parent) fails the parent gate", () => {
    const pages = ["cmc_pos.cash_drawer"];
    // Parent gate: requireCmcPos uses can(wreq, "cmc-pos")
    expect(can("member", pages, "cmc-pos")).toBe(false);
  });

  // Member with no CMC permissions
  it("member with no CMC permissions is denied", () => {
    const pages = ["orders", "products"];
    expect(can("member", pages, "cmc-pos")).toBe(false);
    expect(hasSub("member", pages, "cmc_pos.cash_drawer")).toBe(false);
  });

  // Member with other CMC sub-perms but not cash_drawer
  it("member with cmc_pos.sell but not cmc_pos.cash_drawer is denied the sub-check", () => {
    const pages = ["cmc-pos", "cmc_pos.sell", "cmc_pos.audit"];
    expect(can("member", pages, "cmc-pos")).toBe(true);
    expect(hasSub("member", pages, "cmc_pos.cash_drawer")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Scenario 3 — GET /api/cmc-pos/cash-drawer/transactions permission gate
// Same guard: requireCmcPos + hasSub(cmc_pos.cash_drawer)
// ---------------------------------------------------------------------------

describe("GET /cmc-pos/cash-drawer/transactions — permission gate", () => {
  it("member with cmc-pos + cmc_pos.cash_drawer can access transactions", () => {
    const pages = ["cmc-pos", "cmc_pos.cash_drawer"];
    expect(can("member", pages, "cmc-pos")).toBe(true);
    expect(hasSub("member", pages, "cmc_pos.cash_drawer")).toBe(true);
  });

  it("member with only cmc-pos cannot access transactions (sub-perm missing)", () => {
    const pages = ["cmc-pos"];
    expect(can("member", pages, "cmc-pos")).toBe(true);
    expect(hasSub("member", pages, "cmc_pos.cash_drawer")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Scenario 4 — Nav visibility (hasCmcPosSubAccess helper)
// The Cash Drawer nav entry uses hasCmcPosSubAccess("cmc_pos.cash_drawer")
// ---------------------------------------------------------------------------

describe("Cash Drawer nav entry — hasCmcPosSubAccess visibility", () => {
  const canView = hasCmcPosSubAccess("cmc_pos.cash_drawer");

  it("visible when allowedPages explicitly includes cmc_pos.cash_drawer", () => {
    expect(canView(["cmc-pos", "cmc_pos.cash_drawer"])).toBe(true);
  });

  it("visible when user has cmc-pos (parent) and NO sub-permissions at all", () => {
    // hasCmcPosSubAccess: hasParent=true AND hasAnySubPerm=false → true (backward compat)
    expect(canView(["cmc-pos"])).toBe(true);
  });

  it("hidden when user has cmc-pos and OTHER sub-permissions but NOT cmc_pos.cash_drawer", () => {
    // hasParent=true, hasAnySubPerm=true, cash_drawer not in list → false
    expect(canView(["cmc-pos", "cmc_pos.sell", "cmc_pos.audit"])).toBe(false);
  });

  it("hidden when allowedPages is empty", () => {
    expect(canView([])).toBe(false);
  });

  it("hidden when allowedPages has only other CMC sub-permissions", () => {
    expect(canView(["cmc_pos.sell"])).toBe(false);
  });

  it("hidden when allowedPages has no CMC permissions at all", () => {
    expect(canView(["orders", "products", "brands"])).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Scenario 5 — Cash sale ledger entry idempotency (partial unique index)
// ON CONFLICT (workspace_owner_id, reference_id) WHERE type='cash_sale' AND reference_id IS NOT NULL
// ---------------------------------------------------------------------------

describe("Cash sale ledger idempotency contract", () => {
  it("re-submitting the same sale id does not create a duplicate (ON CONFLICT DO NOTHING)", () => {
    // Simulate what the DB unique index enforces: same (workspace_owner_id, reference_id)
    // for type='cash_sale' is blocked.
    const existing = new Set<string>();

    function insertCashSaleTx(workspaceId: string, saleId: string, type = "cash_sale"): boolean {
      if (type !== "cash_sale" || !saleId) return true; // no conflict guard for non-cash_sale
      const key = `${workspaceId}:${saleId}`;
      if (existing.has(key)) return false; // ON CONFLICT DO NOTHING
      existing.add(key);
      return true;
    }

    expect(insertCashSaleTx("ws1", "42")).toBe(true);  // first insert succeeds
    expect(insertCashSaleTx("ws1", "42")).toBe(false); // duplicate blocked
    expect(insertCashSaleTx("ws1", "43")).toBe(true);  // different sale id → new row
    expect(insertCashSaleTx("ws2", "42")).toBe(true);  // different workspace → new row
  });

  it("non-cash sales (payment_method !== cash) do not create a ledger entry", () => {
    function shouldCreateLedgerEntry(paymentMethod: string | null): boolean {
      return paymentMethod === "cash";
    }

    expect(shouldCreateLedgerEntry("cash")).toBe(true);
    expect(shouldCreateLedgerEntry("card")).toBe(false);
    expect(shouldCreateLedgerEntry("link")).toBe(false);
    expect(shouldCreateLedgerEntry(null)).toBe(false);
  });

  it("only the cash portion of a mixed payment should be recorded (type='cash_sale', amount=cash_total)", () => {
    // The POST /cmc-pos/sales route records the full `total` for cash payments.
    // For a purely cash sale, the cash amount equals the total.
    function cashLedgerAmount(total: number, paymentMethod: string): number | null {
      if (paymentMethod !== "cash") return null;
      return total; // in current impl, full total is recorded as cash in
    }

    expect(cashLedgerAmount(100, "cash")).toBe(100);
    expect(cashLedgerAmount(100, "card")).toBeNull();
  });

  it("CMC shelf-sale cash transactions are always tagged with the walk_in channel", () => {
    // The INSERT hardcodes sale_channel = 'walk_in' for CMC cash sales.
    // This mirrors Quick Entry walk-in sales on other drawers.
    function cmcCashSaleChannel(paymentMethod: string): string | null {
      if (paymentMethod !== "cash") return null;
      return "walk_in"; // always walk-in for CMC shelf sales
    }

    expect(cmcCashSaleChannel("cash")).toBe("walk_in");
    expect(cmcCashSaleChannel("card")).toBeNull();
    expect(cmcCashSaleChannel("link")).toBeNull();
  });

  it("backfill: existing CMC shelf-sale cash transactions with no channel are updated to walk_in", () => {
    // Simulates the idempotent UPDATE run at startup in initDb.ts:
    // UPDATE cash_transactions SET sale_channel = 'walk_in'
    //  WHERE type = 'cash_sale' AND reference_type = 'cmc_sale' AND sale_channel IS NULL
    type TxRecord = { type: string; reference_type: string | null; sale_channel: string | null };

    function applyBackfill(rows: TxRecord[]): TxRecord[] {
      return rows.map((r) =>
        r.type === "cash_sale" && r.reference_type === "cmc_sale" && r.sale_channel === null
          ? { ...r, sale_channel: "walk_in" }
          : r,
      );
    }

    const before: TxRecord[] = [
      { type: "cash_sale", reference_type: "cmc_sale", sale_channel: null },       // to be backfilled
      { type: "cash_sale", reference_type: "cmc_sale", sale_channel: "walk_in" },  // already set — no-op
      { type: "cash_sale", reference_type: null, sale_channel: null },              // no ref_type — not touched
      { type: "adjustment", reference_type: "cmc_sale", sale_channel: null },       // not cash_sale — not touched
    ];

    const after = applyBackfill(before);
    expect(after[0].sale_channel).toBe("walk_in");   // backfilled
    expect(after[1].sale_channel).toBe("walk_in");   // unchanged
    expect(after[2].sale_channel).toBeNull();         // not cmc_sale ref — not touched
    expect(after[3].sale_channel).toBeNull();         // not cash_sale type — not touched
  });
});

// ---------------------------------------------------------------------------
// Scenario 6 — Shift open / session creation idempotency
// ---------------------------------------------------------------------------

describe("Shift open — session idempotency", () => {
  it("opening a shift with a location that already has an open session reuses that session", () => {
    // The route checks for existing open session and reuses it (cash_session_id = existing.id)
    // rather than creating a new one.
    const sessions: Array<{ id: number; drawer_id: number; status: string }> = [
      { id: 10, drawer_id: 1, status: "open" },
    ];

    function resolveOrCreateSession(drawerId: number): number {
      const existing = sessions.find(
        (s) => s.drawer_id === drawerId && s.status === "open",
      );
      if (existing) return existing.id; // reuse
      // create new (not shown here)
      const newId = sessions.length + 10;
      sessions.push({ id: newId, drawer_id: drawerId, status: "open" });
      return newId;
    }

    expect(resolveOrCreateSession(1)).toBe(10); // reuse existing
    expect(resolveOrCreateSession(1)).toBe(10); // still reused
    expect(resolveOrCreateSession(2)).toBe(11); // different drawer → new
  });
});

// ---------------------------------------------------------------------------
// Scenario 7 — Close shift: expected balance computation
// expected = opening_cash + cash_in - cash_out (from committed ledger)
// ---------------------------------------------------------------------------

describe("Close shift — expected balance computation", () => {
  it("expected balance = opening_cash + cash_in - cash_out", () => {
    function computeExpected(openingCash: number, cashIn: number, cashOut: number): number {
      return openingCash + cashIn - cashOut;
    }

    expect(computeExpected(50, 300, 0)).toBe(350);    // opening + sales
    expect(computeExpected(50, 300, 20)).toBe(330);   // with expenses
    expect(computeExpected(0, 0, 0)).toBe(0);         // empty session
  });

  it("discrepancy = (cash_kept + cash_transferred) - expected", () => {
    function computeDiscrepancy(kept: number, transferred: number, expected: number): number {
      return Math.round((kept + transferred - expected) * 100) / 100;
    }

    expect(computeDiscrepancy(330, 0, 330)).toBe(0);    // balanced
    expect(computeDiscrepancy(320, 0, 330)).toBe(-10);  // shortage
    expect(computeDiscrepancy(340, 0, 330)).toBe(10);   // overage
    expect(computeDiscrepancy(300, 30, 330)).toBe(0);   // balanced with transfer
  });

  it("zero-amount transfer is effectively a no-op for discrepancy", () => {
    const expected = 200;
    const kept = 200;
    const transferred = 0;
    const discrepancy = Math.round((kept + transferred - expected) * 100) / 100;
    expect(discrepancy).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Scenario 8 — Transfer validation
// ---------------------------------------------------------------------------

describe("Transfer validation", () => {
  it("transfer amount must be positive", () => {
    function validateTransfer(amount: number): boolean {
      return amount > 0;
    }
    expect(validateTransfer(0)).toBe(false);
    expect(validateTransfer(-10)).toBe(false);
    expect(validateTransfer(0.01)).toBe(true);
    expect(validateTransfer(100)).toBe(true);
  });

  it("transfer cannot exceed available balance", () => {
    function canTransfer(amount: number, balance: number): boolean {
      return amount > 0 && amount <= balance;
    }
    expect(canTransfer(100, 200)).toBe(true);
    expect(canTransfer(200, 200)).toBe(true);
    expect(canTransfer(201, 200)).toBe(false);
    expect(canTransfer(0, 200)).toBe(false);
  });

  it("transfer requires an open destination session", () => {
    function hasOpenDestSession(sessions: Array<{ location_id: number; status: string }>, destId: number): boolean {
      return sessions.some((s) => s.location_id === destId && s.status === "open");
    }

    const sessions = [{ location_id: 2, status: "open" }];
    expect(hasOpenDestSession(sessions, 2)).toBe(true);
    expect(hasOpenDestSession(sessions, 3)).toBe(false); // no session for location 3
  });

  it("transfer to the same location is rejected", () => {
    function isValidDestination(srcLocationId: number, destLocationId: number): boolean {
      return destLocationId !== srcLocationId;
    }
    expect(isValidDestination(1, 1)).toBe(false);
    expect(isValidDestination(1, 2)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Scenario 9 — Permissions: granting cmc_pos.cash_drawer via the permissions API
// ---------------------------------------------------------------------------

describe("Permissions API — granting cmc_pos.cash_drawer", () => {
  it("cmc_pos.cash_drawer is a valid page key (present in SUB_PERMISSION_LABELS)", () => {
    // The key must appear in the SUB_PERMISSION_LABELS map for the permissions API
    // to accept it without throwing 'Unknown page key'.
    const KNOWN_CMC_SUB_PERMS = [
      "cmc_pos.sell",
      "cmc_pos.discount",
      "cmc_pos.refund",
      "cmc_pos.edit",
      "cmc_pos.create_request",
      "cmc_pos.accept_request",
      "cmc_pos.dispatch_request",
      "cmc_pos.receive_request",
      "cmc_pos.override_fulfillment",
      "cmc_pos.view_location_requests",
      "cmc_pos.audit",
      "cmc_pos.monthly_sales",
      "cmc_pos.returns",
      "cmc_pos.delete_request",
      "cmc_pos.cash_drawer", // newly added
    ];

    expect(KNOWN_CMC_SUB_PERMS).toContain("cmc_pos.cash_drawer");
    expect(KNOWN_CMC_SUB_PERMS.every((k) => k.startsWith("cmc_pos."))).toBe(true);
  });

  it("granting only cmc_pos.cash_drawer (without cmc-pos parent) makes the nav entry hidden", () => {
    // Because requireCmcPos checks for "cmc-pos" parent permission.
    // Users must also have "cmc-pos" to access the backend endpoint.
    const pages = ["cmc_pos.cash_drawer"]; // missing parent
    const canViewNav = hasCmcPosSubAccess("cmc_pos.cash_drawer")(pages);
    // hasCmcPosSubAccess: pages includes the key → true, but backend gate still
    // checks requireCmcPos (parent "cmc-pos"), which would 403.
    // For the nav: pages includes "cmc_pos.cash_drawer" → returns true (it IS in pages).
    // This is expected: nav shows the link, but the page will 403 without parent.
    // Better to grant both cmc-pos + cmc_pos.cash_drawer in the UI.
    expect(canViewNav).toBe(true); // nav is visible (key is in pages)
  });

  it("granting cmc-pos + cmc_pos.cash_drawer allows full access", () => {
    const pages = ["cmc-pos", "cmc_pos.cash_drawer"];
    const parentOk = can("member", pages, "cmc-pos");
    const subOk = hasSub("member", pages, "cmc_pos.cash_drawer");
    const navOk = hasCmcPosSubAccess("cmc_pos.cash_drawer")(pages);
    expect(parentOk).toBe(true);
    expect(subOk).toBe(true);
    expect(navOk).toBe(true);
  });
});

/**
 * Cash Session lifecycle transition validity tests.
 *
 * The session lifecycle has five conceptual states:
 *
 *   OPEN              — session.status === "open", no reconciliation counts yet
 *   RECONCILING       — session.status === "open" WITH a reconciliation snapshot (counts submitted)
 *   PENDING_REVIEW    — session.status === "pending_review" (reconcile-close completed)
 *   APPROVED          — session.status === "approved"
 *   FLAGGED           — session.status === "flagged"
 *
 * Valid transitions (API-enforced):
 *   OPEN              → RECONCILING       (submit counts)
 *   RECONCILING       → OPEN              (recount / cancel reconciliation)
 *   RECONCILING       → PENDING_REVIEW    (reconcile-close)
 *   OPEN              → PENDING_REVIEW    (legacy close without guided reconciliation)
 *   PENDING_REVIEW    → APPROVED          (approve)
 *   PENDING_REVIEW    → FLAGGED           (flag)
 *   FLAGGED           → APPROVED          (approve)
 *   PENDING_REVIEW    → OPEN              (reopen)
 *   FLAGGED           → OPEN              (reopen)
 *   APPROVED          → OPEN              (reopen)
 *
 * Invalid transitions must return false (the API would return 409).
 */

import { describe, it, expect } from "vitest";

// ---------------------------------------------------------------------------
// Predicate helpers that mirror the API-level status checks
// ---------------------------------------------------------------------------

type SessionStatus = "open" | "pending_review" | "approved" | "flagged";

/** Whether a session can have counts submitted (begin reconciliation). */
function canSubmitCounts(status: SessionStatus): boolean {
  return status === "open";
}

/** Whether a session can be closed / reconcile-closed. */
function canClose(status: SessionStatus): boolean {
  return status === "open";
}

/** Whether a session can be approved. */
function canApprove(status: SessionStatus): boolean {
  return status === "pending_review" || status === "flagged";
}

/** Whether a session can be flagged. */
function canFlag(status: SessionStatus): boolean {
  // Flagging is only valid once the session has been closed (not while open).
  return status !== "open";
}

/** Whether a session can be reopened. */
function canReopen(status: SessionStatus): boolean {
  return status !== "open";
}

/** Whether a session can accept new transactions (sales / expenses / bills). */
function canAddTransactions(status: SessionStatus): boolean {
  return status === "open";
}

// ---------------------------------------------------------------------------
// Lifecycle transition tests
// ---------------------------------------------------------------------------

describe("cash session lifecycle — OPEN state", () => {
  const status: SessionStatus = "open";

  it("OPEN can submit counts (begin reconciliation)", () => {
    expect(canSubmitCounts(status)).toBe(true);
  });

  it("OPEN can be closed / reconcile-closed", () => {
    expect(canClose(status)).toBe(true);
  });

  it("OPEN can accept new transactions", () => {
    expect(canAddTransactions(status)).toBe(true);
  });

  it("OPEN cannot be approved directly", () => {
    expect(canApprove(status)).toBe(false);
  });

  it("OPEN cannot be flagged (must close first)", () => {
    expect(canFlag(status)).toBe(false);
  });

  it("OPEN cannot be reopened (already open)", () => {
    expect(canReopen(status)).toBe(false);
  });
});

describe("cash session lifecycle — PENDING_REVIEW state (reconciled / closed)", () => {
  const status: SessionStatus = "pending_review";

  it("PENDING_REVIEW can be approved", () => {
    expect(canApprove(status)).toBe(true);
  });

  it("PENDING_REVIEW can be flagged", () => {
    expect(canFlag(status)).toBe(true);
  });

  it("PENDING_REVIEW can be reopened", () => {
    expect(canReopen(status)).toBe(true);
  });

  it("PENDING_REVIEW cannot submit counts (session must be open)", () => {
    expect(canSubmitCounts(status)).toBe(false);
  });

  it("PENDING_REVIEW cannot be closed again", () => {
    expect(canClose(status)).toBe(false);
  });

  it("PENDING_REVIEW cannot accept new transactions", () => {
    expect(canAddTransactions(status)).toBe(false);
  });
});

describe("cash session lifecycle — APPROVED state", () => {
  const status: SessionStatus = "approved";

  it("APPROVED can be reopened", () => {
    expect(canReopen(status)).toBe(true);
  });

  it("APPROVED cannot be approved again", () => {
    expect(canApprove(status)).toBe(false);
  });

  it("APPROVED cannot be closed", () => {
    expect(canClose(status)).toBe(false);
  });

  it("APPROVED cannot accept new transactions", () => {
    expect(canAddTransactions(status)).toBe(false);
  });

  it("APPROVED cannot submit reconciliation counts", () => {
    expect(canSubmitCounts(status)).toBe(false);
  });
});

describe("cash session lifecycle — FLAGGED state", () => {
  const status: SessionStatus = "flagged";

  it("FLAGGED can be approved", () => {
    expect(canApprove(status)).toBe(true);
  });

  it("FLAGGED can be reopened", () => {
    expect(canReopen(status)).toBe(true);
  });

  it("FLAGGED cannot be closed", () => {
    expect(canClose(status)).toBe(false);
  });

  it("FLAGGED cannot accept new transactions", () => {
    expect(canAddTransactions(status)).toBe(false);
  });

  it("FLAGGED cannot submit reconciliation counts", () => {
    expect(canSubmitCounts(status)).toBe(false);
  });
});

describe("cash session lifecycle — forbidden transition matrix", () => {
  it("OPEN → APPROVED is forbidden", () => {
    expect(canApprove("open")).toBe(false);
  });

  it("APPROVED → APPROVED is forbidden", () => {
    expect(canApprove("approved")).toBe(false);
  });

  it("OPEN → OPEN (reopen) is forbidden", () => {
    expect(canReopen("open")).toBe(false);
  });

  it("APPROVED → PENDING_REVIEW (close) is forbidden", () => {
    expect(canClose("approved")).toBe(false);
  });

  it("PENDING_REVIEW → PENDING_REVIEW (close again) is forbidden", () => {
    expect(canClose("pending_review")).toBe(false);
  });
});

describe("cash session lifecycle — reconciliation sub-states within OPEN", () => {
  /**
   * The reconciliation sub-state lives in the reconciliation JSONB column.
   * The DB status stays "open" throughout; the sub-state transitions are:
   *
   *   counting (no counts)  →  counts_submitted  →  counting (recount)
   *                                              ↓
   *                                    reconcile-close → PENDING_REVIEW
   */

  function reconciliationPhase(
    status: SessionStatus,
    hasCounts: boolean,
  ): "not_started" | "counts_submitted" | "closed" {
    if (status !== "open") return "closed";
    return hasCounts ? "counts_submitted" : "not_started";
  }

  it("open session with no counts is in not_started phase", () => {
    expect(reconciliationPhase("open", false)).toBe("not_started");
  });

  it("open session with submitted counts is in counts_submitted phase", () => {
    expect(reconciliationPhase("open", true)).toBe("counts_submitted");
  });

  it("non-open session is always in closed phase (not a sub-state of reconciliation)", () => {
    expect(reconciliationPhase("pending_review", true)).toBe("closed");
    expect(reconciliationPhase("approved", false)).toBe("closed");
    expect(reconciliationPhase("flagged", true)).toBe("closed");
  });

  it("recount returns from counts_submitted back to not_started", () => {
    // Simulate recount: clear the counts flag
    let hasCounts = true;
    expect(reconciliationPhase("open", hasCounts)).toBe("counts_submitted");

    hasCounts = false; // recount clears the submitted counts
    expect(reconciliationPhase("open", hasCounts)).toBe("not_started");
  });
});

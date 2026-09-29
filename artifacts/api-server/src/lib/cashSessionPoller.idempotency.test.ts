/**
 * Unit tests for the `markReminderSent` DB-idempotency helper exported from
 * cashSessionPoller.ts.
 *
 * The helper inserts a row into `cash_session_reminders` with
 * `ON CONFLICT DO NOTHING` so that each (sessionId, reminderType) pair is only
 * recorded and notified once. These tests verify that contract using a mocked DB.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Mocks must be declared before importing the module under test ─────────────

const mockDbQuery = vi.fn();

vi.mock("./db", () => ({
  db: { query: (...args: unknown[]) => mockDbQuery(...args) },
}));

vi.mock("./logger", () => ({
  logger: {
    info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
    child: vi.fn().mockReturnThis(),
  },
}));

// Notification side-effects are out of scope for this unit test.
vi.mock("./orderAlerts", () => ({
  notifyCashSessionLongOpenAlerts:        vi.fn().mockResolvedValue(undefined),
  notifyCashSessionClosingTimeAlert:      vi.fn().mockResolvedValue(undefined),
  notifyCashSessionOverdueAlerts:         vi.fn().mockResolvedValue(undefined),
  notifyCashSessionManagerEscalationAlerts: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("./eventsSse", () => ({
  broadcastEvent: vi.fn(),
}));

// Import AFTER vi.mock declarations (Vitest hoists vi.mock calls).
import { markReminderSent } from "./cashSessionPoller";

// ─────────────────────────────────────────────────────────────────────────────

beforeEach(() => {
  mockDbQuery.mockReset();
});

describe("markReminderSent — DB-level idempotency", () => {
  it("returns true when the row is newly inserted (first reminder for this session+type)", async () => {
    // Simulate INSERT … ON CONFLICT DO NOTHING → 1 row inserted
    mockDbQuery.mockResolvedValueOnce({ rowCount: 1 });

    const sent = await markReminderSent("ws_abc", 101, "overdue");

    expect(sent).toBe(true);
    expect(mockDbQuery).toHaveBeenCalledOnce();
    // Confirm the SQL uses ON CONFLICT DO NOTHING (idempotent upsert pattern)
    const [sql, params] = mockDbQuery.mock.calls[0] as [string, unknown[]];
    expect(sql).toMatch(/ON CONFLICT/i);
    expect(params).toEqual(["ws_abc", 101, "overdue"]);
  });

  it("returns false when ON CONFLICT DO NOTHING fires (reminder already sent)", async () => {
    // Simulate INSERT … ON CONFLICT DO NOTHING → 0 rows inserted (conflict)
    mockDbQuery.mockResolvedValueOnce({ rowCount: 0 });

    const sent = await markReminderSent("ws_abc", 101, "overdue");

    expect(sent).toBe(false);
  });

  it("returns false when rowCount is null (some DB drivers omit it on conflict)", async () => {
    mockDbQuery.mockResolvedValueOnce({ rowCount: null });
    const sent = await markReminderSent("ws_xyz", 55, "manager_escalation");
    expect(sent).toBe(false);
  });

  it("inserts exactly once when called twice for the same (sessionId, reminderType)", async () => {
    // First call → inserted; second call → conflict → not inserted
    mockDbQuery
      .mockResolvedValueOnce({ rowCount: 1 }) // first call: new row
      .mockResolvedValueOnce({ rowCount: 0 }); // second call: conflict

    const first  = await markReminderSent("ws_b", 7, "manager_escalation");
    const second = await markReminderSent("ws_b", 7, "manager_escalation");

    expect(first).toBe(true);   // notification should fire
    expect(second).toBe(false); // notification should NOT fire (already sent)
    // Exactly two DB calls — one per invocation
    expect(mockDbQuery).toHaveBeenCalledTimes(2);
  });

  it("uses separate reminder records for different reminderTypes on the same session", async () => {
    mockDbQuery
      .mockResolvedValueOnce({ rowCount: 1 }) // closing_time
      .mockResolvedValueOnce({ rowCount: 1 }); // overdue (different type)

    const r1 = await markReminderSent("ws_c", 200, "closing_time");
    const r2 = await markReminderSent("ws_c", 200, "overdue");

    expect(r1).toBe(true);
    expect(r2).toBe(true);
    // Each call passes the correct reminderType
    expect((mockDbQuery.mock.calls[0] as [string, unknown[]])[1][2]).toBe("closing_time");
    expect((mockDbQuery.mock.calls[1] as [string, unknown[]])[1][2]).toBe("overdue");
  });
});

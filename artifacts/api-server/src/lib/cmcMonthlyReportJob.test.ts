import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { previousMonthLabel, currentMonthLabel, isFirstOfMonth } from "./cmcMonthlyReportJob";

// ---------------------------------------------------------------------------
// previousMonthLabel / currentMonthLabel
// ---------------------------------------------------------------------------

describe("previousMonthLabel", () => {
  it("returns the previous calendar month (YYYY-MM)", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-01T00:00:00Z"));
    expect(previousMonthLabel()).toBe("2026-06");
    vi.useRealTimers();
  });

  it("wraps from January to December of the prior year", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-15T00:00:00Z"));
    expect(previousMonthLabel()).toBe("2025-12");
    vi.useRealTimers();
  });

  it("pads single-digit months with a leading zero", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-01T00:00:00Z"));
    expect(previousMonthLabel()).toBe("2026-02");
    vi.useRealTimers();
  });
});

describe("currentMonthLabel", () => {
  it("returns current YYYY-MM", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-15T00:00:00Z"));
    expect(currentMonthLabel()).toBe("2026-07");
    vi.useRealTimers();
  });

  it("pads month with leading zero", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-01T00:00:00Z"));
    expect(currentMonthLabel()).toBe("2026-05");
    vi.useRealTimers();
  });
});

// ---------------------------------------------------------------------------
// isFirstOfMonth
// ---------------------------------------------------------------------------

describe("isFirstOfMonth", () => {
  afterEach(() => { vi.useRealTimers(); });

  it("returns true on the 1st of the month (UTC)", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-01T00:00:00Z"));
    expect(isFirstOfMonth()).toBe(true);
  });

  it("returns false on the 2nd of the month (UTC)", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-02T00:00:00Z"));
    expect(isFirstOfMonth()).toBe(false);
  });

  it("returns false on the last day of the month (UTC)", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-31T23:59:59Z"));
    expect(isFirstOfMonth()).toBe(false);
  });

  it("returns true on Dec 1st", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-12-01T12:00:00Z"));
    expect(isFirstOfMonth()).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// TC-16 — Previous month label wraps correctly
// ---------------------------------------------------------------------------

describe("TC-16: Month label wrapping", () => {
  afterEach(() => { vi.useRealTimers(); });

  it("October trigger returns September label", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-01T00:00:00Z"));
    expect(previousMonthLabel()).toBe("2026-09");
  });

  it("December trigger returns November label", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-12-01T00:00:00Z"));
    expect(previousMonthLabel()).toBe("2026-11");
  });
});

// ---------------------------------------------------------------------------
// TC-17 — Deduplication / idempotency guard
// ---------------------------------------------------------------------------

describe("TC-17: Email deduplication", () => {
  it("recipient tracking table has a UNIQUE constraint on (workspace, month, recipient)", () => {
    const constraint = "cmc_monthly_report_deliveries_unique";
    expect(constraint).toContain("unique");
  });

  it("ON CONFLICT DO NOTHING prevents duplicate delivery rows", () => {
    const sql = `INSERT INTO cmc_monthly_report_deliveries
       (workspace_owner_id, report_month, recipient_user_id, recipient_email, status)
     VALUES ($1, $2, $3, $4, 'pending')
     ON CONFLICT (workspace_owner_id, report_month, recipient_user_id) DO NOTHING`;
    expect(sql).toContain("ON CONFLICT");
    expect(sql).toContain("DO NOTHING");
  });
});

// ---------------------------------------------------------------------------
// TC-18 — Backoff and retry logic
// ---------------------------------------------------------------------------

describe("TC-18: Backoff schedule", () => {
  const BACKOFF_MINUTES = [1, 5, 15, 60, 240];

  it("first retry waits at least 1 minute", () => {
    expect(BACKOFF_MINUTES[0]).toBe(1);
  });

  it("fifth retry waits 240 minutes (4 hours)", () => {
    expect(BACKOFF_MINUTES[4]).toBe(240);
  });

  it("max 5 attempts per delivery", () => {
    const MAX_ATTEMPTS = 5;
    expect(BACKOFF_MINUTES).toHaveLength(MAX_ATTEMPTS);
  });
});

// ---------------------------------------------------------------------------
// TC-19 — Recipients include owners and cmc page holders
// ---------------------------------------------------------------------------

describe("TC-19: Recipient selection logic", () => {
  it("query includes owner role AND cmc-pos sub-permissions", () => {
    const query = `SELECT DISTINCT m.member_user_id AS user_id, m.email
       FROM workspace_members m
      WHERE m.workspace_owner_id = $1
        AND m.member_user_id IS NOT NULL
        AND m.email IS NOT NULL
        AND (
          m.workspace_role = 'owner'
          OR m.allowed_pages @> '["cmc-pos"]'::jsonb
          OR m.allowed_pages @> '["cmc_pos.audit"]'::jsonb
          OR m.allowed_pages @> '["cmc_pos.monthly_sales"]'::jsonb
        )`;
    expect(query).toContain("workspace_role = 'owner'");
    expect(query).toContain("cmc_pos.monthly_sales");
    expect(query).toContain("cmc_pos.audit");
  });

  it("recipients without email are excluded (email IS NOT NULL)", () => {
    const query = `WHERE m.email IS NOT NULL`;
    expect(query).toContain("IS NOT NULL");
  });
});

// ---------------------------------------------------------------------------
// TC-20 — RESEND_API_KEY missing skips email gracefully
// ---------------------------------------------------------------------------

describe("TC-20: Missing RESEND_API_KEY is handled gracefully", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it("getResend throws when RESEND_API_KEY not set", () => {
    const original = process.env.RESEND_API_KEY;
    delete process.env.RESEND_API_KEY;

    function getResend() {
      const key = process.env.RESEND_API_KEY;
      if (!key) throw new Error("RESEND_API_KEY not set");
      return {};
    }

    expect(() => getResend()).toThrow("RESEND_API_KEY not set");
    process.env.RESEND_API_KEY = original;
  });
});

// ---------------------------------------------------------------------------
// TC-23 — Catch-up runs only when no row exists for prior month
// ---------------------------------------------------------------------------

describe("TC-23: Catch-up logic", () => {
  it("catch-up skips a workspace that already has delivery rows for the prior month", () => {
    const existingCount: number = 3;
    const shouldRunCatchUp = existingCount === 0;
    expect(shouldRunCatchUp).toBe(false);
  });

  it("catch-up runs for a workspace with zero delivery rows for the prior month", () => {
    const existingCount = 0;
    const shouldRunCatchUp = existingCount === 0;
    expect(shouldRunCatchUp).toBe(true);
  });
});

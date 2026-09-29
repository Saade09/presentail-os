import { describe, expect, it, vi } from "vitest";
import {
  applyNormalization,
  buildNormalizationReport,
  classifyLegacyOrder,
  parseNormalizationOptions,
  type LegacyOrderRow,
} from "./normalize-order-delivery-schedules";

function row(overrides: Partial<LegacyOrderRow> = {}): LegacyOrderRow {
  return {
    id: "00000000-0000-0000-0000-000000000001",
    workspace_owner_id: "owner-1",
    window_start: null,
    window_end: null,
    legacy_date: "2026-08-29",
    legacy_slot: "11:00 PM - 1:00 AM",
    city_matches: [{ id: 1, timezone: "Asia/Beirut", match_rank: 0 }],
    ...overrides,
  };
}

describe("order delivery schedule normalization", () => {
  it("defaults to a read-only dry run and supports explicit apply", () => {
    expect(parseNormalizationOptions([])).toEqual({ mode: "dry-run" });
    expect(parseNormalizationOptions(["apply", "--output", "/tmp/report.json"])).toEqual({
      mode: "apply",
      outputPath: "/tmp/report.json",
    });
    expect(parseNormalizationOptions(["--workspace-owner-id", "owner-1"])).toEqual({
      mode: "dry-run",
      workspaceOwnerId: "owner-1",
    });
  });

  it("converts an exact legacy range in the delivery city's timezone", () => {
    const decision = classifyLegacyOrder(row());
    expect(decision.classification).toBe("valid");
    expect(decision.window_start).toBe("2026-08-29T20:00:00.000Z");
    expect(decision.window_end).toBe("2026-08-29T22:00:00.000Z");
    expect(decision.reasons).toEqual([]);
  });

  it("preserves dates and reports named slots as ambiguous", () => {
    const decision = classifyLegacyOrder(row({ legacy_slot: "morning" }));
    expect(decision.classification).toBe("ambiguous");
    expect(decision.reasons).toContain("named_slot_has_no_exact_window");
    expect(decision.window_start).toBeNull();
  });

  it.each([
    ["2026-02-30", "10:00–12:00", "malformed_date"],
    ["2026-08-29", "not a slot", "malformed_or_ambiguous_slot"],
  ])("reports malformed legacy metadata without a change", (date, slot, reason) => {
    const decision = classifyLegacyOrder(row({ legacy_date: date, legacy_slot: slot }));
    expect(decision.classification).toBe("invalid");
    expect(decision.reasons).toContain(reason);
    expect(decision.window_start).toBeNull();
    expect(decision.window_end).toBeNull();
  });

  it("does not guess when the delivery city is missing or ambiguous", () => {
    expect(classifyLegacyOrder(row({ city_matches: null })).reasons).toContain(
      "delivery_city_not_resolved",
    );
    expect(
      classifyLegacyOrder(row({
        city_matches: [
          { id: 1, timezone: "UTC", match_rank: 0 },
          { id: 2, timezone: "UTC", match_rank: 0 },
        ],
      })).reasons,
    ).toContain("delivery_city_is_ambiguous");
    expect(
      classifyLegacyOrder(row({
        city_matches: [
          { id: 1, timezone: "UTC", match_rank: 0 },
          { id: 2, timezone: "UTC", match_rank: 3 },
        ],
      })).classification,
    ).toBe("valid");
  });

  it("builds a read-only report with valid and invalid classifications", async () => {
    const query = vi.fn()
      .mockResolvedValueOnce({
        rows: [
          {
            ...row(),
            city_matches: [{ id: 1, timezone: "UTC", match_rank: 0 }],
          },
          {
            ...row({
              id: "00000000-0000-0000-0000-000000000002",
              legacy_slot: "morning",
            }),
            city_matches: [{ id: 1, timezone: "UTC", match_rank: 0 }],
          },
        ],
      })
      .mockResolvedValueOnce({ rows: [] });
    const report = await buildNormalizationReport({ query }, { mode: "dry-run" });
    expect(report.summary).toMatchObject({
      candidate_rows: 2,
      valid_rows: 1,
      ambiguous_rows: 1,
      migrated_rows: 0,
    });
    expect(query).toHaveBeenCalledTimes(2);
    for (const [sql] of query.mock.calls) expect(String(sql).trim()).toMatch(/^SELECT\b/i);
  });

  it("updates only still-legacy rows and counts concurrent skips", async () => {
    const report = {
      report_version: 1 as const,
      generated_at: "2026-08-29T00:00:00.000Z",
      mode: "apply" as const,
      workspace_owner_id: null,
      summary: {
        candidate_rows: 2,
        valid_rows: 2,
        invalid_rows: 0,
        ambiguous_rows: 0,
        migrated_rows: 0,
        skipped_due_to_concurrent_change: 0,
      },
      decisions: [
        classifyLegacyOrder(row({ city_matches: [{ id: 1, timezone: "UTC", match_rank: 0 }] })),
        classifyLegacyOrder(row({
          id: "00000000-0000-0000-0000-000000000002",
          city_matches: [{ id: 1, timezone: "UTC", match_rank: 0 }],
        })),
      ],
    };
    const query = vi.fn()
      .mockResolvedValueOnce({ rowCount: 1, rows: [] })
      .mockResolvedValueOnce({ rowCount: 0, rows: [] });
    const applied = await applyNormalization({ query }, report);
    expect(applied.summary.migrated_rows).toBe(1);
    expect(applied.summary.skipped_due_to_concurrent_change).toBe(1);
    expect(query).toHaveBeenCalledTimes(2);
    expect(query.mock.calls[0][0]).toContain("window_start IS NULL");
  });
});
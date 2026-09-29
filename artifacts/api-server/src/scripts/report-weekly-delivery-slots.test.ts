import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildWeeklySlotReport,
  exportWeeklySlotCandidates,
  parseReportOptions,
} from "./report-weekly-delivery-slots";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("weekly delivery-slot evidence report", () => {
  it("bounds report pagination", () => {
    expect(parseReportOptions({ REPORT_LIMIT: "9999", REPORT_OFFSET: "-4" })).toEqual({
      limit: 500,
      offset: 0,
    });
  });

  it("uses only read-only statements", async () => {
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [{ duplicate_group_count: 1, repeated_row_count: "2" }] })
      .mockResolvedValueOnce({ rows: [{ city_id: 1 }] })
      .mockResolvedValueOnce({ rows: [{ city_id: 1, day_of_week: 1 }] })
      .mockResolvedValueOnce({ rows: [{ table_size: "1 MB" }] });

    const report = await buildWeeklySlotReport({ query } as never, { limit: 100, offset: 0 });

    expect(report.duplicate_groups).toEqual([{ city_id: 1 }]);
    expect(query).toHaveBeenCalledTimes(4);
    for (const [sql] of query.mock.calls) {
      expect(String(sql).trim()).toMatch(/^SELECT\b/i);
      expect(String(sql)).not.toMatch(/\b(?:INSERT|UPDATE|DELETE|ALTER|DROP|CREATE)\b/i);
    }
  });

  it("streams a complete NDJSON candidate export without overwriting", async () => {
    const directory = await mkdtemp(join(tmpdir(), "weekly-slots-"));
    temporaryDirectories.push(directory);
    const output = join(directory, "candidates.ndjson");
    const row = {
      id: 7,
      city_id: 2,
      workspace_owner_id: "owner",
      day_of_week: 1,
      label: "Morning",
      start_time: "09:00",
      end_time: "10:00",
    };
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [row] })
      .mockResolvedValueOnce({ rows: [] });

    await expect(exportWeeklySlotCandidates({ query } as never, output, 10)).resolves.toEqual({
      outputPath: output,
      rowCount: 1,
    });
    const lines = (await readFile(output, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    expect(lines[0]).toMatchObject({ export_version: 1, format: "ndjson" });
    expect(lines[1]).toEqual(row);
    expect(lines[2]).toEqual({
      export_summary: true,
      row_count: 1,
      last_id: 7,
      completed: true,
    });
    await expect(exportWeeklySlotCandidates({ query } as never, output, 10)).rejects.toMatchObject({
      code: "EEXIST",
    });
  });
});
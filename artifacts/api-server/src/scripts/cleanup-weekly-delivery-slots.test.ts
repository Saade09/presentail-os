import { describe, expect, it } from "vitest";
import { parseManifest, stableJson } from "./cleanup-weekly-delivery-slots";

const manifest = {
  manifest_version: 1,
  batch_id: "batch-1",
  workspace_owner_id: "owner-1",
  export_file: "candidates.ndjson",
  export_sha256: "abc",
  exported_row_count: 2,
  approved_by: "review-1",
  approved_at: "2026-08-29T00:00:00.000Z",
  removals: [{ original_id: 2, proposed_survivor_id: 1 }],
};

describe("weekly delivery-slot cleanup manifest", () => {
  it("accepts an explicit reviewed survivor mapping", () => {
    expect(parseManifest(manifest)).toEqual(manifest);
  });

  it("rejects self-survivors and duplicate removals", () => {
    expect(() => parseManifest({
      ...manifest,
      removals: [{ original_id: 2, proposed_survivor_id: 2 }],
    })).toThrow(/distinct positive/);
    expect(() => parseManifest({
      ...manifest,
      removals: [
        { original_id: 2, proposed_survivor_id: 1 },
        { original_id: 2, proposed_survivor_id: 3 },
      ],
    })).toThrow(/Duplicate removal/);
  });

  it("canonicalizes dates and object key order for immutable row comparisons", () => {
    expect(stableJson({ b: new Date("2026-08-29T00:00:00.000Z"), a: 1 })).toBe(
      '{"a":1,"b":"2026-08-29T00:00:00.000Z"}',
    );
  });
});
import { describe, it, expect } from "vitest";
import { STATUS_LABEL, formatStatusLabel } from "./SalesHistoryTab";

// ---------------------------------------------------------------------------
// Unit tests for STATUS_LABEL and formatStatusLabel
// ---------------------------------------------------------------------------

describe("formatStatusLabel — known statuses", () => {
  it.each(Object.entries(STATUS_LABEL))(
    'returns "%s" for status key "%s"',
    (key, expectedLabel) => {
      expect(formatStatusLabel(key)).toBe(expectedLabel);
    },
  );
});

describe("formatStatusLabel — unknown statuses (fallback)", () => {
  it("converts underscores to spaces and title-cases an unknown status", () => {
    expect(formatStatusLabel("awaiting_payment")).toBe("Awaiting Payment");
  });

  it("converts hyphens to spaces and title-cases an unknown status", () => {
    expect(formatStatusLabel("in-transit")).toBe("In Transit");
  });

  it("title-cases a single-word unknown status", () => {
    expect(formatStatusLabel("dispatched")).toBe("Dispatched");
  });
});

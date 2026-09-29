import { describe, it, expect } from "vitest";
import { checkNameWarning } from "./nameWarning";

describe("checkNameWarning", () => {
  describe("empty / whitespace input", () => {
    it("returns no matches for an empty string", () => {
      const result = checkNameWarning("", ["Alpha", "Beta"]);
      expect(result.exactMatch).toBeNull();
      expect(result.similarMatches).toHaveLength(0);
    });

    it("returns no matches for a whitespace-only string", () => {
      const result = checkNameWarning("   ", ["Alpha", "Beta"]);
      expect(result.exactMatch).toBeNull();
      expect(result.similarMatches).toHaveLength(0);
    });

    it("returns no matches when the existing names list is empty", () => {
      const result = checkNameWarning("Designer", []);
      expect(result.exactMatch).toBeNull();
      expect(result.similarMatches).toHaveLength(0);
    });
  });

  describe("exact match", () => {
    it("detects an exact match", () => {
      const result = checkNameWarning("Designer", ["Designer", "Manager"]);
      expect(result.exactMatch).toBe("Designer");
      expect(result.similarMatches).toHaveLength(0);
    });

    it("preserves the original casing of the matched name", () => {
      const result = checkNameWarning("designer", ["DESIGNER", "Manager"]);
      expect(result.exactMatch).toBe("DESIGNER");
    });

    it("trims leading and trailing whitespace before comparing", () => {
      const result = checkNameWarning("  Designer  ", ["Designer"]);
      expect(result.exactMatch).toBe("Designer");
    });
  });

  describe("case-insensitivity", () => {
    it("matches regardless of casing in the typed input", () => {
      const result = checkNameWarning("DESIGNER", ["Designer"]);
      expect(result.exactMatch).toBe("Designer");
    });

    it("matches regardless of casing in the existing names", () => {
      const result = checkNameWarning("designer", ["designer"]);
      expect(result.exactMatch).toBe("designer");
    });

    it("treats mixed-case input and mixed-case existing names as the same", () => {
      const result = checkNameWarning("DeSiGnEr", ["Designer"]);
      expect(result.exactMatch).toBe("Designer");
    });
  });

  describe("similar match", () => {
    it("detects a similar match when typed name is a substring of an existing name", () => {
      const result = checkNameWarning("Design", ["Designer", "Manager"]);
      expect(result.exactMatch).toBeNull();
      expect(result.similarMatches).toContain("Designer");
      expect(result.similarMatches).not.toContain("Manager");
    });

    it("detects a similar match when an existing name is a substring of the typed name", () => {
      const result = checkNameWarning("Senior Designer", ["Designer"]);
      expect(result.exactMatch).toBeNull();
      expect(result.similarMatches).toContain("Designer");
    });

    it("collects multiple similar matches", () => {
      const result = checkNameWarning("Design", ["Designer", "Design Lead", "Manager"]);
      expect(result.exactMatch).toBeNull();
      expect(result.similarMatches).toHaveLength(2);
      expect(result.similarMatches).toContain("Designer");
      expect(result.similarMatches).toContain("Design Lead");
    });

    it("is case-insensitive for similar matches", () => {
      const result = checkNameWarning("design", ["Designer"]);
      expect(result.similarMatches).toContain("Designer");
    });
  });

  describe("no match", () => {
    it("returns no match when the typed name is completely different from all existing names", () => {
      const result = checkNameWarning("Finance", ["Designer", "Manager"]);
      expect(result.exactMatch).toBeNull();
      expect(result.similarMatches).toHaveLength(0);
    });

    it("returns no match when none of the existing names contain the typed string", () => {
      const result = checkNameWarning("Xyz", ["Alpha", "Beta", "Gamma"]);
      expect(result.exactMatch).toBeNull();
      expect(result.similarMatches).toHaveLength(0);
    });
  });

  describe("exact match takes priority over similar", () => {
    it("does not also list an exact match in similarMatches", () => {
      const result = checkNameWarning("Design", ["Design", "Designer"]);
      expect(result.exactMatch).toBe("Design");
      expect(result.similarMatches).not.toContain("Design");
      expect(result.similarMatches).toContain("Designer");
    });
  });
});

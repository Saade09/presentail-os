import { describe, expect, it } from "vitest";
import { generateRecipeSuggestion } from "./recipeSuggestionEngine";
import { buildRecipeCompatibilityAuditReport, RECIPE_COMPATIBILITY_AUDIT_21 } from "./recipeCompatibilityAudit.fixture";

describe("independently authored 21-product compatibility audit", () => {
  it("is read-only and emits complete per-candidate diagnostics and summary", () => {
    expect(RECIPE_COMPATIBILITY_AUDIT_21).toHaveLength(21);
    const snapshots = RECIPE_COMPATIBILITY_AUDIT_21.map((fixture) => {
      const before = JSON.stringify(fixture);
      const suggestion = generateRecipeSuggestion(fixture.target, [], fixture.candidates, {
        flowerBoxSponge: false,
        balloonMetalRing: false,
      }, undefined, fixture.contextualRules);
      expect(JSON.stringify(fixture)).toBe(before);
      const requirement = suggestion.requirements.find((candidate) =>
        (candidate.candidateCompatibility?.length ?? 0) > 0,
      ) ?? suggestion.requirements[0];
      expect(requirement).toBeDefined();
      expect(requirement.candidateCompatibility).toHaveLength(fixture.candidates.length);
      for (const diagnostic of requirement.candidateCompatibility ?? []) {
        expect(diagnostic).toEqual(expect.objectContaining({
          baseItemId: expect.any(Number),
          attributes: expect.any(Object),
          comparisons: expect.any(Object),
          hardExclusions: expect.any(Array),
          survivor: expect.any(Boolean),
        }));
      }
      expect(suggestion.lines[0]?.baseItemId ?? null).toBe(fixture.expectedBaseItemId);
      return {
        auditId: fixture.auditId,
        requirementId: requirement.requirementId,
        phrase: requirement.phrase,
        quantity: requirement.quantity,
        explicitAttributes: requirement.attributes,
        candidates: requirement.candidateCompatibility,
        survivors: requirement.candidateBaseItemIds,
        resolution: requirement.resolution,
      };
    });
    const summary = {
      products: snapshots.length,
      hardExclusions: snapshots.flatMap(({ candidates }) => candidates ?? [])
        .filter(({ survivor }) => !survivor).length,
      automatic: snapshots.filter(({ resolution }) => resolution === "matched").length,
      saferReview: snapshots.filter(({ resolution }) => resolution !== "matched").length,
    };
    expect(summary).toEqual({
      products: 21,
      hardExclusions: expect.any(Number),
      automatic: 18,
      saferReview: 3,
    });
    expect(summary.hardExclusions).toBeGreaterThanOrEqual(19);

    const report = buildRecipeCompatibilityAuditReport();
    expect(report.products).toHaveLength(21);
    expect(report.summary).toMatchObject({
      unknownSurvivors: expect.any(Number),
      newAutomaticResolutions: expect.any(Array),
      saferOutcomes: expect.any(Array),
      accidentalRemovals: expect.any(Array),
      regressionsVsFrozenPhase1: expect.any(Array),
      hardRemovalsByAttribute: expect.any(Object),
      categorySpecificResults: expect.objectContaining({
        flowers: expect.any(Object),
        containers: expect.any(Object),
        balloons: expect.any(Object),
        "trusted-source": expect.any(Object),
        packages: expect.any(Object),
      }),
    });
  });
});
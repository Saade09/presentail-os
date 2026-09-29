import { createElement } from "react";
import { render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
  correctionDialogInitializer,
  correctRequirementPayload,
  lineRequirementFromSources,
  SuggestionLineRow,
  suggestionLineEvidenceView,
  type SuggestionLine,
} from "./RecipeSuggestionPanel";

describe("lineRequirementFromSources", () => {
  it("selects the clicked line requirement rather than suggestion-wide or another-line data", () => {
    const clicked = {
      requirementId: "requirement-a",
      phrase: "red roses",
      quantity: 12,
    };
    expect(lineRequirementFromSources([
      { type: "requirement", requirement_id: clicked.requirementId, requirement_provenance: clicked },
    ])).toEqual(clicked);
  });

  it("initializes and submits correction B from its provenance rather than suggestion-wide or extracted text", () => {
    const requirementA = {
      requirementId: "requirement-a",
      phrase: "suggestion-wide red roses",
      quantity: 12,
      unit: "stem",
      attributes: { color: "red", ingredientType: "rose" },
    };
    const requirementB = {
      requirementId: "requirement-b",
      phrase: "line B white lilies",
      quantity: 3,
      unit: "stem",
      attributes: { color: "white", ingredientType: "lily" },
    };
    const lineB: SuggestionLine = {
      id: 2, line_order: 1, extracted_requirement: "wrong extracted requirement",
      selected_base_item: null, quantity: 3, unit_context: "stem", confidence: "low",
      source_type: "unresolved", source_rule_id: null,
      sources: [{ requirement_id: requirementB.requirementId, requirement_provenance: requirementB }],
      rationale: null, resolution_status: "unresolved", exclusion_reason: null,
      exclusion_acknowledged: false, created_at: "2026-01-01T00:00:00Z",
    };

    const initializer = correctionDialogInitializer(lineB);
    expect(initializer.requirement).toEqual(requirementB);
    expect(initializer.phrase).toBe("line B white lilies");
    expect(initializer.phrase).not.toBe(requirementA.phrase);
    expect(initializer.phrase).not.toBe(lineB.extracted_requirement);
    expect(initializer.structuredDraft).toMatchObject({ color: "white", ingredientType: "lily", quantity: "3" });

    const payload = correctRequirementPayload(
      lineB,
      "ivory lilies",
      initializer.phrase,
      { ...initializer.structuredDraft, color: "ivory" },
      initializer.structuredDraft,
      {},
    );
    expect(payload).toEqual({
      phrase: "ivory lilies",
      attributes: { color: "ivory" },
    });
  });
});

describe("suggestionLineEvidenceView", () => {
  const line = (sources: unknown[], overrides: Partial<SuggestionLine> = {}): SuggestionLine => ({
    id: 1, line_order: 0, extracted_requirement: "fallback", selected_base_item: { id: 11, name: "Rose", code: null },
    quantity: 12, unit_context: "stem", confidence: "high", source_type: "deterministic_rule",
    source_rule_id: null, sources, rationale: null, resolution_status: "resolved",
    exclusion_reason: null, exclusion_acknowledged: false, created_at: "2026-01-01T00:00:00Z",
    ...overrides,
  });

  const semanticEvidence = ({
    requirementId = "req-rose",
    phrase = "12 red roses",
    resolution = "matched",
    preCandidateIds = [11],
    candidateIds = [11],
    compatibility = [{
      baseItemId: 11,
      survivor: true,
      hardExclusions: [],
      hasUnknownExplicitDiscriminator: false,
      attributes: {},
      comparisons: {},
    }],
    extra = {},
  }: {
    requirementId?: string;
    phrase?: string;
    resolution?: "matched" | "ambiguous" | "no_match";
    preCandidateIds?: number[];
    candidateIds?: number[];
    compatibility?: unknown;
    extra?: Record<string, unknown>;
  } = {}) => ({
    type: "deterministic_rule",
    requirement_id: requirementId,
    requirement_provenance: {
      requirementId,
      kind: "ingredient",
      phrase,
      quantity: 12,
      unit: "stem",
      attributes: { color: "red", ingredientType: "rose" },
      preCompatibilityCandidateBaseItemIds: preCandidateIds,
      candidateBaseItemIds: candidateIds,
      resolution,
      evidence: {
        sourceField: "description",
        sourceIndex: 0,
        lineIndex: 0,
        componentIndex: 0,
        occurrence: 0,
        exactPhrase: phrase,
        normalizedPhrase: phrase.toLowerCase(),
        span: { start: 5, end: 17 },
      },
      similarEvidence: [],
      candidateCompatibility: compatibility,
    },
    contextual_rule_provenance: null,
    hidden_rule_key: null,
    supporting_product_ids: [],
    ...extra,
  });

  function renderRows(rows: SuggestionLine[]) {
    render(createElement("table", null,
      createElement("tbody", null,
        rows.map((row, index) => createElement(SuggestionLineRow, {
          key: row.id,
          line: row,
          isLast: index === rows.length - 1,
          warning: null,
          isEditing: false,
          onQtyChange: vi.fn(),
          onCorrect: vi.fn(),
        })),
      ),
    ));
  }

  it("shows the stable Product phrase, source span, matched state, and compatible selected candidate", () => {
    const matched = line([semanticEvidence()]);
    const view = suggestionLineEvidenceView(matched);

    expect(view).toMatchObject({
      requirementId: "req-rose",
      phrase: "12 red roses",
      sourceLabel: "description",
      spanLabel: "characters 5–17",
      candidateState: "matched",
      candidateCount: 1,
      retrievedCandidateIds: [11],
      survivingCandidateIds: [11],
      candidateCompatibility: [{ baseItemId: 11, state: "compatible", reasons: [] }],
    });
    renderRows([matched]);
    expect(screen.getByText("Compatible · Base Item #11")).toBeVisible();
  });

  it("uses persisted hard exclusions and keeps unknown evidence distinct from incompatible", () => {
    const diagnosticLine = line([semanticEvidence({
      preCandidateIds: [11, 12, 13],
      candidateIds: [11, 12],
      compatibility: [
        { baseItemId: 11, survivor: true, hardExclusions: [], hasUnknownExplicitDiscriminator: false },
        { baseItemId: 12, survivor: true, hardExclusions: [], hasUnknownExplicitDiscriminator: true },
        { baseItemId: 13, survivor: false, hardExclusions: ["Required red; candidate is white"], hasUnknownExplicitDiscriminator: false },
      ],
    })]);
    const view = suggestionLineEvidenceView(diagnosticLine);

    expect(view.retrievedCandidateIds).toEqual([11, 12, 13]);
    expect(view.survivingCandidateIds).toEqual([11, 12]);
    expect(view.candidateCompatibility).toEqual([
      { baseItemId: 11, state: "compatible", reasons: [] },
      { baseItemId: 12, state: "unknown", reasons: ["Insufficient persisted evidence"] },
      { baseItemId: 13, state: "incompatible", reasons: ["Required red; candidate is white"] },
    ]);
    renderRows([diagnosticLine]);
    const unknown = screen.getByText(/Unknown evidence · Base Item #12/).closest("div");
    const incompatible = screen.getByText(/Hard excluded · Base Item #13/).closest("div");
    expect(unknown).toHaveClass("border-amber-300");
    expect(incompatible).toHaveClass("border-red-300");
    expect(unknown).not.toHaveClass("border-red-300");
  });

  it("distinguishes no retrieval from candidates that were all hard-excluded", () => {
    const noRetrieval = suggestionLineEvidenceView(line([semanticEvidence({
      resolution: "no_match", preCandidateIds: [], candidateIds: [], compatibility: [],
    })], { selected_base_item: null, resolution_status: "unresolved", confidence: "no_match" }));
    const allExcluded = suggestionLineEvidenceView(line([semanticEvidence({
      resolution: "no_match",
      preCandidateIds: [21],
      candidateIds: [],
      compatibility: [{ baseItemId: 21, survivor: false, hardExclusions: ["Wrong container"], hasUnknownExplicitDiscriminator: false }],
    })], { selected_base_item: null, resolution_status: "unresolved", confidence: "no_match" }));

    expect(noRetrieval.candidateSummary).toBe("No relevant candidate was retrieved");
    expect(allExcluded.candidateSummary).toBe("All retrieved candidates were hard-excluded");
  });

  it("does not invent candidate judgments for older persisted evidence", () => {
    const view = suggestionLineEvidenceView(line([{
      requirement_id: "req-rose",
      requirement_provenance: {
        requirementId: "req-rose",
        phrase: "12 red roses",
        resolution: "ambiguous",
        candidateBaseItemIds: [11, 12],
        evidence: { sourceField: "description", sourceIndex: 0, span: { start: 5, end: 17 } },
      },
    }], { selected_base_item: null, resolution_status: "unresolved" }));

    expect(view.candidateDiagnosticsAvailable).toBe(false);
    expect(view.candidateSummary).toBe("Candidate diagnostics unavailable");
  });

  it("distinguishes contextual-rule, Similar Recipe, and bounded-AI evidence", () => {
    const view = suggestionLineEvidenceView(line([semanticEvidence({
      extra: {
        type: "ai_assisted",
        candidate_base_item_ids: [11, 12],
        supporting_product_ids: [30, 31],
        contextual_rule_provenance: { canonicalFormat: "bouquet", resolverBaseItemId: 11 },
      },
    })], { source_type: "ai_assisted" }));

    expect(view.evidence.map(({ kind }) => kind)).toEqual([
      "contextual_rule",
      "similar_recipe",
      "bounded_ai",
    ]);
  });

  it("recognizes governed Sponge and Metal Ring keys but rejects arbitrary hidden keys", () => {
    const sponge = suggestionLineEvidenceView(line([{ hidden_rule_key: "flower_box_round_medium_sponge" }]));
    const ring = suggestionLineEvidenceView(line([{ hidden_rule_key: "balloon_metal_ring" }]));
    const fake = suggestionLineEvidenceView(line([{ hidden_rule_key: "fake_operational_rule" }]));

    expect(sponge.evidence.map(({ kind }) => kind)).toContain("hidden_operational_rule");
    expect(ring.evidence.map(({ kind }) => kind)).toContain("hidden_operational_rule");
    expect(fake.evidence.map(({ kind }) => kind)).not.toContain("hidden_operational_rule");
  });

  it("keeps explicit Helium as a semantic Product requirement", () => {
    const view = suggestionLineEvidenceView(line([semanticEvidence({
      requirementId: "req-helium",
      phrase: "helium-filled balloons",
      extra: { hidden_rule_key: null },
    })]));

    expect(view.phrase).toBe("helium-filled balloons");
    expect(view.requirementId).toBe("req-helium");
    expect(view.evidence.map(({ kind }) => kind)).not.toContain("hidden_operational_rule");
  });

  it("renders ambiguous and no-match semantic rows with Product source and candidate state", () => {
    const ambiguous = line([semanticEvidence({
      requirementId: "req-ambiguous",
      phrase: "red garden roses",
      resolution: "ambiguous",
      preCandidateIds: [11, 12],
      candidateIds: [11, 12],
      compatibility: [
        { baseItemId: 11, survivor: true, hardExclusions: [], hasUnknownExplicitDiscriminator: false },
        { baseItemId: 12, survivor: true, hardExclusions: [], hasUnknownExplicitDiscriminator: false },
      ],
    })], { id: 20, selected_base_item: null, resolution_status: "unresolved", confidence: "low" });
    const noMatch = line([semanticEvidence({
      requirementId: "req-missing",
      phrase: "rare blue orchid",
      resolution: "no_match",
      preCandidateIds: [31],
      candidateIds: [],
      compatibility: [{
        baseItemId: 31,
        survivor: false,
        hardExclusions: ["Required blue; candidate is purple"],
        hasUnknownExplicitDiscriminator: false,
      }],
    })], { id: 21, selected_base_item: null, resolution_status: "unresolved", confidence: "no_match" });

    renderRows([ambiguous, noMatch]);

    const ambiguousRow = screen.getByTestId("suggestion-line-20");
    expect(within(ambiguousRow).getByText("“red garden roses”")).toBeVisible();
    expect(within(ambiguousRow).getByText("Product description · characters 5–17")).toBeVisible();
    expect(within(ambiguousRow).getByText("Ambiguous · 2 candidates")).toBeVisible();
    expect(within(ambiguousRow).getByText("No match")).toBeVisible();

    const noMatchRow = screen.getByTestId("suggestion-line-21");
    expect(within(noMatchRow).getByText("“rare blue orchid”")).toBeVisible();
    expect(within(noMatchRow).getByText("Product description · characters 5–17")).toBeVisible();
    expect(within(noMatchRow).getByText("No candidate match")).toBeVisible();
    expect(within(noMatchRow).getByText("All retrieved candidates were hard-excluded")).toBeVisible();
    expect(within(noMatchRow).getByText(/Required blue; candidate is purple/)).toBeVisible();
  });
});

/**
 * RecipeSuggestionPanel
 *
 * Renders the recipe suggestion workflow within the Product Detail → Recipe tab.
 * - Shows a "Generate Recipe Suggestion" button when no pending suggestion exists (managers only)
 * - Displays a live-recipe vs suggestion separation clearly
 * - Shows per-line confidence badges, warnings, and evidence
 * - Provides Approve / Reject / Edit controls (managers only)
 * - Read-only users see suggestion info only (no action buttons)
 */
import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiFetch } from "@/lib/queryClient";
import { recipeAttentionQueryKey } from "@/hooks/use-recipe-attention";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { useToast } from "@/hooks/use-toast";
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { BaseItemImageThumbnail } from "@/components/BaseItemImageThumbnail";
import {
  Loader2,
  Sparkles,
  CheckCircle2,
  XCircle,
  AlertTriangle,
  HelpCircle,
  BookOpen,
  Users,
  Pencil,
  ChevronDown,
  ChevronUp,
  Info,
  Wand2,
  ThumbsUp,
  ThumbsDown,
} from "lucide-react";
import { Link } from "wouter";
import {
  defaultLearningScope,
  learningScopeOptions,
  type RecipeLearningKind,
  type RecipeLearningScope,
} from "./recipeLearningScopes";

// ─── Types ───────────────────────────────────────────────────────────────────

export type SuggestionConfidence = "high" | "medium" | "low" | "no_match";

export type SuggestionSelectedBaseItem = {
  id: number;
  name: string;
  code: string | null;
};

export type SuggestionLine = {
  id: number;
  line_order: number;
  extracted_requirement: string | null;
  selected_base_item: SuggestionSelectedBaseItem | null;
  quantity: number;
  unit_context: string | null;
  confidence: SuggestionConfidence;
  source_type: string;
  source_rule_id: number | null;
  sources: unknown[];
  rationale: string | null;
  resolution_status: "resolved" | "unresolved" | "excluded";
  exclusion_reason: string | null;
  exclusion_acknowledged: boolean;
  created_at: string;
};

type LineEvidenceKind = "contextual_rule" | "similar_recipe" | "bounded_ai" | "hidden_operational_rule";

export type CandidateCompatibilityView = {
  baseItemId: number;
  state: "compatible" | "incompatible" | "unknown";
  reasons: string[];
};

export type SuggestionLineEvidenceView = {
  requirementId: string | null;
  phrase: string | null;
  sourceLabel: string | null;
  spanLabel: string | null;
  candidateState: "matched" | "ambiguous" | "no_match" | null;
  candidateCount: number | null;
  candidateDiagnosticsAvailable: boolean;
  retrievedCandidateIds: number[] | null;
  survivingCandidateIds: number[] | null;
  candidateCompatibility: CandidateCompatibilityView[];
  candidateSummary: string | null;
  evidence: Array<{ kind: LineEvidenceKind; label: string; detail?: string }>;
};

type CorrectionRecord = {
  id: number;
  line_id: number | null;
  correction_type: string;
  extraction_error_type: string | null;
  reason: string;
  note: string | null;
  intent: "product_only" | "propose_learning";
  proposed_scope: string | null;
  original_line: Record<string, unknown>;
  corrected_line: Record<string, unknown>;
  created_at: string;
};

type RecipeComparisonLine = {
  baseItemId: number;
  baseItemName: string;
  baseItemCode: string | null;
  quantity: number;
};

export type SuggestionAction = {
  id: number;
  action: string;
  actor_user_id: string | null;
  note: string | null;
  created_at: string;
};

export type RecipeSuggestion = {
  id: number;
  product_id: number | null;
  version: number;
  status: string;
  confidence: string | number | null;
  rationale: string | null;
  created_at: string;
};

const ACTIONABLE_RECIPE_SUGGESTION_STATUSES = new Set([
  "draft",
  "generated",
  "under_review",
]);

export type SuggestionDetail = {
  suggestion: RecipeSuggestion;
  lines: SuggestionLine[];
  actions: SuggestionAction[];
  corrections: CorrectionRecord[];
  original_lines: Array<Record<string, unknown>>;
  live_recipe: RecipeComparisonLine[];
  live_recipe_version: number;
  structured_requirements?: Record<string, unknown>;
};

// ─── Helpers ─────────────────────────────────────────────────────────────────

export function lineRequirementFromSources(sources: unknown[] | undefined): Record<string, unknown> | undefined {
  return sources?.map((source) => source && typeof source === "object"
    ? (source as { requirement_provenance?: Record<string, unknown> }).requirement_provenance
    : undefined).find((requirement): requirement is Record<string, unknown> => !!requirement);
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? value as Record<string, unknown> : null;
}

function numericArray(value: unknown): number[] {
  return Array.isArray(value) ? value.filter((entry): entry is number => typeof entry === "number") : [];
}

function isGovernedOperationalHiddenRuleKey(value: unknown): value is string {
  return typeof value === "string"
    && (value === "balloon_metal_ring" || /^flower_box_(round|heart)_.+_sponge$/.test(value));
}

export function suggestionLineEvidenceView(line: Pick<SuggestionLine, "sources" | "source_type" | "resolution_status" | "selected_base_item">): SuggestionLineEvidenceView {
  const entries = line.sources.map(record).filter((entry): entry is Record<string, unknown> => entry != null);
  const requirement = lineRequirementFromSources(line.sources);
  const provenance = record(requirement?.evidence);
  const span = record(provenance?.span);
  const phrase = typeof requirement?.phrase === "string"
    ? requirement.phrase
    : typeof provenance?.exactPhrase === "string"
      ? provenance.exactPhrase
      : null;
  const sourceField = typeof provenance?.sourceField === "string" ? provenance.sourceField : null;
  const sourceIndex = typeof provenance?.sourceIndex === "number" ? provenance.sourceIndex : null;
  const retrievedCandidateIds = Array.isArray(requirement?.preCompatibilityCandidateBaseItemIds)
    ? numericArray(requirement.preCompatibilityCandidateBaseItemIds)
    : null;
  const survivingCandidateIds = Array.isArray(requirement?.candidateBaseItemIds)
    ? numericArray(requirement.candidateBaseItemIds)
    : null;
  const persistedCompatibility = Array.isArray(requirement?.candidateCompatibility)
    ? requirement.candidateCompatibility.map(record).filter((entry): entry is Record<string, unknown> => entry != null)
    : null;
  const candidateCompatibility = (persistedCompatibility ?? []).flatMap((diagnostic): CandidateCompatibilityView[] => {
    if (typeof diagnostic.baseItemId !== "number" || typeof diagnostic.survivor !== "boolean") return [];
    const hardExclusions = Array.isArray(diagnostic.hardExclusions)
      ? diagnostic.hardExclusions.filter((reason): reason is string => typeof reason === "string" && reason.trim().length > 0)
      : [];
    const hasUnknown = diagnostic.hasUnknownExplicitDiscriminator === true;
    if (!diagnostic.survivor || hardExclusions.length > 0) {
      return [{ baseItemId: diagnostic.baseItemId, state: "incompatible", reasons: hardExclusions }];
    }
    if (hasUnknown) {
      return [{ baseItemId: diagnostic.baseItemId, state: "unknown", reasons: ["Insufficient persisted evidence"] }];
    }
    return [{ baseItemId: diagnostic.baseItemId, state: "compatible", reasons: [] }];
  });
  const candidateIds = numericArray(requirement?.candidateBaseItemIds);
  const fallbackCandidateIds = entries.flatMap((entry) => numericArray(entry.candidate_base_item_ids));
  const candidates = candidateIds.length ? candidateIds : fallbackCandidateIds;
  const rawResolution = requirement?.resolution;
  const candidateState = rawResolution === "matched" || rawResolution === "ambiguous" || rawResolution === "no_match"
    ? rawResolution
    : line.selected_base_item
      ? "matched"
      : candidates.length > 1
        ? "ambiguous"
        : line.resolution_status === "unresolved"
          ? "no_match"
          : null;
  const evidence: SuggestionLineEvidenceView["evidence"] = [];
  const contextual = entries.find((entry) =>
    entry.type === "approved_contextual_rule" || record(entry.contextual_rule_provenance) != null);
  if (contextual) {
    const contextualProvenance = record(contextual.contextual_rule_provenance);
    const ruleKey = contextual.rule_key ?? contextualProvenance?.ruleKey ?? contextualProvenance?.rule_key;
    const canonicalFormat = contextual.canonical_format
      ?? contextualProvenance?.canonicalFormat
      ?? contextualProvenance?.canonical_format;
    const resolverBaseItemId = contextual.resolver_base_item_id
      ?? contextualProvenance?.resolverBaseItemId
      ?? contextualProvenance?.resolver_base_item_id;
    const contextualDetails = [
      typeof ruleKey === "string" ? ruleKey : null,
      typeof canonicalFormat === "string" ? canonicalFormat : null,
      typeof resolverBaseItemId === "number" ? `Base Item #${resolverBaseItemId}` : null,
    ].filter((detail): detail is string => detail != null);
    evidence.push({
      kind: "contextual_rule",
      label: "Contextual rule",
      detail: contextualDetails.length ? contextualDetails.join(" · ") : undefined,
    });
  }
  const supportingProductIds = entries.flatMap((entry) => numericArray(entry.supporting_product_ids));
  if (supportingProductIds.length) {
    evidence.push({
      kind: "similar_recipe",
      label: "Similar Recipe support",
      detail: [...new Set(supportingProductIds)].map((id) => `Product #${id}`).join(", "),
    });
  }
  if (line.source_type === "ai_assisted" || entries.some((entry) => entry.type === "ai_assisted")) {
    evidence.push({
      kind: "bounded_ai",
      label: "Bounded AI",
      detail: candidates.length ? `selected from ${candidates.length} governed ${candidates.length === 1 ? "candidate" : "candidates"}` : undefined,
    });
  }
  const hidden = entries.find((entry) => isGovernedOperationalHiddenRuleKey(entry.hidden_rule_key));
  if (hidden) {
    evidence.push({
      kind: "hidden_operational_rule",
      label: "Hidden operational rule",
      detail: String(hidden.hidden_rule_key).replaceAll("_", " "),
    });
  }
  return {
    requirementId: typeof requirement?.requirementId === "string"
      ? requirement.requirementId
      : typeof entries[0]?.requirement_id === "string"
        ? String(entries[0].requirement_id)
        : null,
    phrase,
    sourceLabel: sourceField === "descriptionAr"
      ? "Arabic description"
      : sourceField === "tag"
        ? `tag${sourceIndex != null ? ` #${sourceIndex + 1}` : ""}`
        : sourceField,
    spanLabel: typeof span?.start === "number" && typeof span.end === "number"
      ? `characters ${span.start}–${span.end}`
      : null,
    candidateState,
    candidateCount: candidates.length || (candidateState === "no_match" ? 0 : null),
    candidateDiagnosticsAvailable: persistedCompatibility != null,
    retrievedCandidateIds,
    survivingCandidateIds,
    candidateCompatibility,
    candidateSummary: requirement == null
      ? null
      : persistedCompatibility == null
      ? "Candidate diagnostics unavailable"
      : candidateState === "no_match" && retrievedCandidateIds?.length === 0
        ? "No relevant candidate was retrieved"
        : candidateState === "no_match"
          && (retrievedCandidateIds?.length ?? 0) > 0
          && (survivingCandidateIds?.length ?? 0) === 0
          && candidateCompatibility.length > 0
          && candidateCompatibility.every(({ state }) => state === "incompatible")
            ? "All retrieved candidates were hard-excluded"
            : null,
    evidence,
  };
}

function confidenceLabel(c: SuggestionConfidence): string {
  if (c === "high") return "High";
  if (c === "medium") return "Medium";
  if (c === "low") return "Low";
  return "No match";
}

function ConfidenceBadge({ confidence }: { confidence: SuggestionConfidence }) {
  const map: Record<SuggestionConfidence, string> = {
    high: "bg-emerald-100 text-emerald-700 border-emerald-300 dark:bg-emerald-950/60 dark:text-emerald-300 dark:border-emerald-700",
    medium: "bg-amber-100 text-amber-700 border-amber-300 dark:bg-amber-950/60 dark:text-amber-300 dark:border-amber-700",
    low: "bg-red-100 text-red-700 border-red-300 dark:bg-red-950/60 dark:text-red-300 dark:border-red-700",
    no_match: "bg-muted text-muted-foreground border-border",
  };
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-medium ${map[confidence]}`}
    >
      {confidence === "high" && <CheckCircle2 size={11} />}
      {confidence === "medium" && <AlertTriangle size={11} />}
      {confidence === "low" && <AlertTriangle size={11} />}
      {confidence === "no_match" && <HelpCircle size={11} />}
      {confidenceLabel(confidence)}
    </span>
  );
}

function SourceTypeBadge({ sourceType, sourceRuleId }: { sourceType: string; sourceRuleId: number | null }) {
  const isRule = sourceType === "rule" || sourceRuleId != null;
  const isAi = sourceType === "ai";
  const isSimilar = sourceType === "similar_product" || sourceType === "similar";
  return (
    <span className="inline-flex items-center gap-1 rounded-md bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
      {isRule && <BookOpen size={10} />}
      {isAi && <Wand2 size={10} />}
      {isSimilar && <Users size={10} />}
      {isRule ? "Rule" : isAi ? "AI" : isSimilar ? "Similar product" : sourceType}
      {isRule && sourceRuleId != null && <span className="font-mono">#{sourceRuleId}</span>}
    </span>
  );
}

function CandidateStateBadge({ state, count }: { state: SuggestionLineEvidenceView["candidateState"]; count: number | null }) {
  if (!state) return null;
  const styles = {
    matched: "border-emerald-300 bg-emerald-50 text-emerald-700 dark:border-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-300",
    ambiguous: "border-amber-300 bg-amber-50 text-amber-800 dark:border-amber-700 dark:bg-amber-950/40 dark:text-amber-300",
    no_match: "border-red-300 bg-red-50 text-red-700 dark:border-red-800 dark:bg-red-950/40 dark:text-red-300",
  };
  const labels = {
    matched: "Candidate matched",
    ambiguous: `Ambiguous${count != null ? ` · ${count} candidates` : ""}`,
    no_match: "No candidate match",
  };
  return <span className={`inline-flex rounded-full border px-2 py-0.5 text-[10px] font-medium ${styles[state]}`}>{labels[state]}</span>;
}

function EvidenceBadge({ kind, label, detail }: { kind: LineEvidenceKind; label: string; detail?: string }) {
  const styles: Record<LineEvidenceKind, string> = {
    contextual_rule: "border-blue-300 bg-blue-50 text-blue-700 dark:border-blue-800 dark:bg-blue-950/40 dark:text-blue-300",
    similar_recipe: "border-violet-300 bg-violet-50 text-violet-700 dark:border-violet-800 dark:bg-violet-950/40 dark:text-violet-300",
    bounded_ai: "border-fuchsia-300 bg-fuchsia-50 text-fuchsia-700 dark:border-fuchsia-800 dark:bg-fuchsia-950/40 dark:text-fuchsia-300",
    hidden_operational_rule: "border-slate-400 bg-slate-100 text-slate-700 dark:border-slate-600 dark:bg-slate-900 dark:text-slate-300",
  };
  return (
    <span className={`inline-flex rounded-md border px-1.5 py-0.5 text-[10px] font-medium ${styles[kind]}`} title={detail}>
      {label}{detail ? ` · ${detail}` : ""}
    </span>
  );
}

function CandidateDiagnostics({ view }: { view: SuggestionLineEvidenceView }) {
  if (!view.candidateSummary && !view.candidateDiagnosticsAvailable) return null;
  const list = (label: string, ids: number[]) => `${label}: ${ids.length ? ids.map((id) => `#${id}`).join(", ") : "none"}`;
  return (
    <div className="mt-1.5 space-y-1 text-[10px]" data-testid="candidate-diagnostics">
      {view.candidateSummary && (
        <div className="text-muted-foreground">{view.candidateSummary}</div>
      )}
      {view.candidateDiagnosticsAvailable && (
        <>
          {view.retrievedCandidateIds && (
            <div className="text-muted-foreground">{list("Retrieved before compatibility", view.retrievedCandidateIds)}</div>
          )}
          {view.survivingCandidateIds && (
            <div className="text-muted-foreground">{list("Survived compatibility", view.survivingCandidateIds)}</div>
          )}
          {view.candidateCompatibility.map((candidate) => {
            const styles = {
              compatible: "border-emerald-300 bg-emerald-50 text-emerald-700 dark:border-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-300",
              incompatible: "border-red-300 bg-red-50 text-red-700 dark:border-red-800 dark:bg-red-950/40 dark:text-red-300",
              unknown: "border-amber-300 bg-amber-50 text-amber-800 dark:border-amber-700 dark:bg-amber-950/40 dark:text-amber-300",
            };
            const label = candidate.state === "incompatible"
              ? "Hard excluded"
              : candidate.state === "unknown"
                ? "Unknown evidence"
                : "Compatible";
            return (
              <div key={candidate.baseItemId} className={`rounded border px-1.5 py-1 ${styles[candidate.state]}`}>
                <span className="font-medium">{label} · Base Item #{candidate.baseItemId}</span>
                {candidate.reasons.length > 0 && <span> · {candidate.reasons.join("; ")}</span>}
              </div>
            );
          })}
        </>
      )}
    </div>
  );
}

function lineWarning(line: SuggestionLine): string | null {
  if (line.resolution_status === "excluded") return null;
  if (line.confidence === "no_match") return "No matching base item found for this requirement";
  if (line.confidence === "low") return "Low confidence — review carefully before approving";
  if (line.selected_base_item == null) return "No Base Item selected — resolve or explicitly exclude this requirement before approval";
  return null;
}

// ─── Editable Line ───────────────────────────────────────────────────────────

type EditableLine = SuggestionLine & { _editedQty?: number };

const structuredRequirementFields = [
  ["ingredientFamily", "Ingredient family", "text"],
  ["ingredientType", "Ingredient / flower type", "text"],
  ["color", "Color", "text"],
  ["quantity", "Extracted quantity", "number"],
  ["productFormat", "Canonical Product format", "text"],
  ["stemLength", "Stem length", "text"],
  ["container", "Container type", "text"],
  ["shape", "Shape", "text"],
  ["material", "Material", "text"],
  ["height", "Height", "text"],
  ["width", "Width", "text"],
  ["diameter", "Diameter", "text"],
  ["packageCount", "Package count", "number"],
] as const;

type StructuredRequirementField = (typeof structuredRequirementFields)[number][0];
type StructuredRequirementDraft = Record<StructuredRequirementField, string>;

function structuredValue(value: unknown): string {
  if (value && typeof value === "object" && "value" in value) {
    const extracted = (value as { value?: unknown }).value;
    if (extracted && typeof extracted === "object" && "sourcePhrase" in extracted) {
      return String((extracted as { sourcePhrase?: unknown }).sourcePhrase ?? "");
    }
    return extracted == null ? "" : String(extracted);
  }
  if (value && typeof value === "object" && "sourcePhrase" in value) {
    return String((value as { sourcePhrase?: unknown }).sourcePhrase ?? "");
  }
  return value == null ? "" : String(value);
}

export function initialStructuredRequirementDraft(requirements?: Record<string, unknown>): StructuredRequirementDraft {
  const attributes = requirements?.attributes && typeof requirements.attributes === "object"
    ? requirements.attributes as Record<string, unknown> : {};
  const dimensions = Array.isArray(attributes.dimensions) ? attributes.dimensions : [];
  const dimensionValue = (kind: "height" | "width" | "diameter") => {
    const labelledDimension = dimensions.find((value) =>
      value && typeof value === "object" &&
      new RegExp(kind, "i").test(String((value as { sourcePhrase?: unknown }).sourcePhrase ?? "")),
    );
    return structuredValue(labelledDimension);
  };
  return {
    ingredientFamily: structuredValue(attributes.ingredientFamily),
    ingredientType: structuredValue(attributes.ingredientType),
    color: structuredValue(attributes.color),
    quantity: structuredValue(requirements?.quantity),
    productFormat: structuredValue(attributes.productFormat),
    stemLength: structuredValue(attributes.stemLength),
    container: structuredValue(attributes.container),
    shape: structuredValue(attributes.shape),
    material: structuredValue(attributes.material),
    height: dimensionValue("height"),
    width: dimensionValue("width"),
    diameter: dimensionValue("diameter"),
    packageCount: structuredValue(attributes.packageCount),
  };
}

function dimensionFromDraft(value: string, previous?: Record<string, unknown>, kind?: string): Record<string, unknown> | null {
  const match = value.trim().match(/(\d+(?:\.\d+)?)\s*(mm|cm|m|in|inch|inches)\b/i);
  if (!match) return null;
  const numeric = Number(match[1]);
  const rawUnit = match[2].toLowerCase();
  const unit = rawUnit === "mm" ? "mm" : rawUnit === "m" ? "m" : rawUnit.startsWith("in") ? "in" : "cm";
  return {
    ...previous,
    value: numeric,
    unit,
    centimeters: unit === "mm" ? numeric / 10 : unit === "m" ? numeric * 100 : unit === "in" ? numeric * 2.54 : numeric,
    sourcePhrase: kind && !new RegExp(kind, "i").test(value) ? `${kind}: ${value.trim()}` : value.trim(),
  };
}

export function structuredCorrectionPatch(
  requirements: Record<string, unknown> | undefined,
  draft: StructuredRequirementDraft,
  originalDraft: StructuredRequirementDraft,
  dimensionClassifications: Record<number, "unclassified" | "height" | "width" | "diameter" | "remove">,
): Record<string, unknown> {
  const changed = structuredRequirementFields.filter(([key]) => draft[key] !== originalDraft[key]);
  const patch: Record<string, unknown> = {};
  const attributes: Record<string, unknown> = {};
  for (const [key] of changed) {
    if (key === "height" || key === "width" || key === "diameter") continue;
    if (key === "quantity") {
      patch.quantity = draft[key] ? Number(draft[key]) : null;
      continue;
    }
    attributes[key] = key === "packageCount"
      ? (draft[key] ? Number(draft[key]) : null)
      : key === "stemLength"
        ? (draft[key] ? dimensionFromDraft(draft[key]) : null)
        : draft[key] || null;
  }
  const changedDimensions = changed.filter(([key]) => key === "height" || key === "width" || key === "diameter");
  if (changedDimensions.length || Object.keys(dimensionClassifications).length) {
    const requirementAttributes = requirements?.attributes && typeof requirements.attributes === "object"
      ? requirements.attributes as Record<string, unknown> : {};
    const dimensions = Array.isArray(requirementAttributes.dimensions)
      ? requirementAttributes.dimensions.map((dimension) => ({ ...(dimension as Record<string, unknown>) }))
      : [];
    for (const index of Object.keys(dimensionClassifications).map(Number).sort((a, b) => b - a)) {
      const classification = dimensionClassifications[index];
      if (classification === "remove") {
        dimensions.splice(index, 1);
      } else if (classification && classification !== "unclassified" && dimensions[index]) {
        dimensions[index] = {
          ...dimensions[index],
          dimensionKind: classification,
          sourcePhrase: `${classification}: ${String(dimensions[index].sourcePhrase ?? "").replace(/^(height|width|diameter):\s*/i, "")}`,
        };
      }
    }
    for (const [kind] of changedDimensions) {
      const labelledIndex = dimensions.findIndex((dimension) => new RegExp(kind, "i").test(String(dimension.sourcePhrase ?? "")));
      const next = draft[kind] ? dimensionFromDraft(draft[kind], undefined, kind) : null;
      if (labelledIndex >= 0 && !next) dimensions.splice(labelledIndex, 1);
      else if (labelledIndex >= 0 && next) dimensions[labelledIndex] = next;
      else if (next) dimensions.push(next);
    }
    attributes.dimensions = dimensions;
  }
  if (Object.keys(attributes).length) patch.attributes = attributes;
  return patch;
}

/** The correction dialog is deliberately initialized from the clicked line only. */
export function correctionDialogInitializer(line: SuggestionLine | null): {
  requirement: Record<string, unknown> | undefined;
  phrase: string;
  structuredDraft: StructuredRequirementDraft;
} {
  const requirement = lineRequirementFromSources(line?.sources);
  const phrase = typeof requirement?.phrase === "string"
    ? requirement.phrase
    : line?.extracted_requirement ?? "";
  return { requirement, phrase, structuredDraft: initialStructuredRequirementDraft(requirement) };
}

export function correctRequirementPayload(
  line: SuggestionLine | null,
  phrase: string,
  originalPhrase: string,
  draft: StructuredRequirementDraft,
  originalDraft: StructuredRequirementDraft,
  dimensionClassifications: Record<number, "unclassified" | "height" | "width" | "diameter" | "remove">,
): Record<string, unknown> {
  const corrected = structuredCorrectionPatch(
    lineRequirementFromSources(line?.sources), draft, originalDraft, dimensionClassifications,
  );
  if (phrase !== originalPhrase) corrected.phrase = phrase;
  return corrected;
}

function lineIsValid(line: EditableLine): boolean {
  const qty = line._editedQty ?? line.quantity;
  return line.selected_base_item != null && isFinite(qty) && qty > 0;
}

// ─── Main component ───────────────────────────────────────────────────────────

export function RecipeSuggestionPanel({
  productId,
  canManage,
}: {
  productId: number;
  canManage: boolean;
}) {
  const { toast } = useToast();
  const qc = useQueryClient();

  // Fetch suggestions list
  const {
    data: suggestionListData,
    isLoading: listLoading,
    isError: listError,
    refetch: refetchList,
  } = useQuery({
    queryKey: ["product-recipe-suggestions", productId],
    queryFn: () =>
      apiFetch<{ suggestions: RecipeSuggestion[] }>(
        `/api/products/${productId}/recipe-suggestions`,
      ),
    enabled: canManage,
  });

  const suggestions = suggestionListData?.suggestions ?? [];
  const pendingSuggestion = suggestions.find((s) =>
    ACTIONABLE_RECIPE_SUGGESTION_STATUSES.has(s.status),
  );
  const latestSuggestion = suggestions[0] ?? null;

  // Fetch suggestion detail when one is selected
  const activeSuggestionId = pendingSuggestion?.id ?? null;

  const { data: detailData, isLoading: detailLoading } = useQuery({
    queryKey: ["recipe-suggestion-detail", activeSuggestionId],
    queryFn: () =>
      apiFetch<SuggestionDetail>(`/api/recipe-suggestions/${activeSuggestionId}`),
    enabled: activeSuggestionId != null && canManage,
  });

  // ── Generate mutation ──
  const generateMutation = useMutation({
    mutationFn: () =>
      apiFetch<SuggestionDetail>(`/api/products/${productId}/recipe-suggestions`, {
        method: "POST",
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["product-recipe-suggestions", productId] });
      qc.invalidateQueries({ queryKey: recipeAttentionQueryKey });
      toast({ title: "Recipe suggestion generated" });
    },
    onError: (err: Error) => {
      toast({
        variant: "destructive",
        title: "Failed to generate suggestion",
        description: err.message,
      });
    },
  });

  // ── Approve dialog state ──
  const [showApproveDialog, setShowApproveDialog] = useState(false);
  const [approveNote, setApproveNote] = useState("");
  const [editedLines, setEditedLines] = useState<EditableLine[] | null>(null);
  const [showEditSection, setShowEditSection] = useState(false);
  const [correctionLine, setCorrectionLine] = useState<SuggestionLine | null>(null);
  const [showCorrectionDialog, setShowCorrectionDialog] = useState(false);
  const [correctionType, setCorrectionType] = useState("replace_base_item");
  const [correctionReason, setCorrectionReason] = useState("incorrect_base_item");
  const [correctionErrorType, setCorrectionErrorType] = useState("base_item_selection");
  const [correctionBaseItemId, setCorrectionBaseItemId] = useState("");
  const [correctionQuantity, setCorrectionQuantity] = useState("1");
  const [correctionRequirement, setCorrectionRequirement] = useState("");
  const [originalCorrectionRequirement, setOriginalCorrectionRequirement] = useState("");
  const [structuredRequirementDraft, setStructuredRequirementDraft] = useState<StructuredRequirementDraft>(
    () => initialStructuredRequirementDraft(),
  );
  const [originalStructuredRequirementDraft, setOriginalStructuredRequirementDraft] = useState<StructuredRequirementDraft>(
    () => initialStructuredRequirementDraft(),
  );
  const [correctionNote, setCorrectionNote] = useState("");
  const [correctionIntent, setCorrectionIntent] = useState<"product_only" | "propose_learning">("product_only");
  const [learningKind, setLearningKind] = useState<RecipeLearningKind>("alias");
  const [learningValue, setLearningValue] = useState("");
  const [learningScope, setLearningScope] = useState<RecipeLearningScope>("exact_phrase");
  const [learningMetadataAttribute, setLearningMetadataAttribute] = useState("flower_type");
  const [dimensionClassifications, setDimensionClassifications] = useState<
    Record<number, "unclassified" | "height" | "width" | "diameter" | "remove">
  >({});
  const [acknowledgeExclusion, setAcknowledgeExclusion] = useState(false);
  const [baseItemSearch, setBaseItemSearch] = useState("");

  const baseItemsQuery = useQuery({
    queryKey: ["recipe-correction-base-items", baseItemSearch],
    queryFn: () => apiFetch<{ items: Array<{ id: number; name: string; code: string | null }> }>(
      `/api/base-items?limit=100${baseItemSearch.trim() ? `&q=${encodeURIComponent(baseItemSearch.trim())}` : ""}`,
    ),
    enabled: showCorrectionDialog,
  });

  const correctionMutation = useMutation({
    mutationFn: (payload: Record<string, unknown>) =>
      apiFetch(`/api/recipe-suggestions/${activeSuggestionId}/corrections`, {
        method: "POST",
        body: JSON.stringify(payload),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["recipe-suggestion-detail", activeSuggestionId] });
      qc.invalidateQueries({ queryKey: ["product-recipe-suggestions", productId] });
      qc.invalidateQueries({ queryKey: recipeAttentionQueryKey });
      setShowCorrectionDialog(false);
      setCorrectionLine(null);
      toast({ title: "Recipe draft corrected", description: "The live Recipe was not changed." });
    },
    onError: (err: Error) => toast({
      variant: "destructive",
      title: "Correction could not be saved",
      description: err.message,
    }),
  });

  const approveMutation = useMutation({
    mutationFn: (payload: { note?: string; expected_live_recipe_version: number }) =>
      apiFetch(`/api/recipe-suggestions/${activeSuggestionId}/approve`, {
        method: "POST",
        body: JSON.stringify(payload),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["product-recipe-suggestions", productId] });
      qc.invalidateQueries({ queryKey: ["product", String(productId)] });
      qc.invalidateQueries({ queryKey: recipeAttentionQueryKey });
      setShowApproveDialog(false);
      setApproveNote("");
      setEditedLines(null);
      toast({ title: "Suggestion approved — live recipe updated" });
    },
    onError: (err: Error) => {
      toast({
        variant: "destructive",
        title: "Failed to approve suggestion",
        description: err.message,
      });
    },
  });

  // ── Reject dialog state ──
  const [showRejectDialog, setShowRejectDialog] = useState(false);
  const [rejectNote, setRejectNote] = useState("");

  const rejectMutation = useMutation({
    mutationFn: (note: string) =>
      apiFetch(`/api/recipe-suggestions/${activeSuggestionId}/reject`, {
        method: "POST",
        body: JSON.stringify({ note: note || undefined }),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["product-recipe-suggestions", productId] });
      qc.invalidateQueries({ queryKey: recipeAttentionQueryKey });
      setShowRejectDialog(false);
      setRejectNote("");
      toast({ title: "Suggestion rejected" });
    },
    onError: (err: Error) => {
      toast({
        variant: "destructive",
        title: "Failed to reject suggestion",
        description: err.message,
      });
    },
  });

  // ─ Not a manager: show nothing (recipe tab shows live recipe only) ──────
  if (!canManage) return null;

  // ─ Loading state ─────────────────────────────────────────────────────────
  if (listLoading) {
    return (
      <div className="flex items-center gap-2 text-sm text-muted-foreground py-2">
        <Loader2 size={14} className="animate-spin" />
        Checking for recipe suggestions…
      </div>
    );
  }

  if (listError) {
    return (
      <div className="flex items-center justify-between rounded-lg border border-dashed border-border p-4">
        <p className="text-sm text-muted-foreground">Could not load recipe suggestions.</p>
        <Button variant="ghost" size="sm" onClick={() => refetchList()}>
          Retry
        </Button>
      </div>
    );
  }

  // ─ No pending suggestion: show generate button ───────────────────────────
  if (!pendingSuggestion) {
    const lastApproved = suggestions.find((s) => s.status === "approved");
    const lastRejected = suggestions.find((s) => s.status === "rejected");
    return (
      <div className="space-y-3">
        <div className="flex items-center justify-between rounded-lg border border-dashed border-border p-4">
          <div className="flex items-center gap-2.5">
            <Sparkles size={18} className="text-muted-foreground shrink-0" />
            <div>
              <p className="text-sm font-medium">Generate Recipe Suggestion</p>
              <p className="text-xs text-muted-foreground mt-0.5">
                AI + deterministic rules analyse this product and propose a recipe draft for your review.
              </p>
            </div>
          </div>
          <Button
            size="sm"
            variant="outline"
            onClick={() => generateMutation.mutate()}
            disabled={generateMutation.isPending}
            data-testid="btn-generate-recipe-suggestion"
          >
            {generateMutation.isPending ? (
              <><Loader2 size={13} className="animate-spin mr-1.5" />Generating…</>
            ) : (
              <><Sparkles size={13} className="mr-1.5" />Generate</>
            )}
          </Button>
        </div>

        {(lastApproved || lastRejected) && (
          <div className="flex items-center gap-2 text-xs text-muted-foreground px-1">
            {lastApproved && (
              <span className="flex items-center gap-1">
                <CheckCircle2 size={11} className="text-emerald-600" />
                Version {lastApproved.version} approved
              </span>
            )}
            {lastApproved && lastRejected && <span>·</span>}
            {lastRejected && (
              <span className="flex items-center gap-1">
                <XCircle size={11} className="text-muted-foreground" />
                Version {lastRejected.version} rejected
              </span>
            )}
          </div>
        )}
      </div>
    );
  }

  // ─ Pending suggestion exists ──────────────────────────────────────────────
  const lines: EditableLine[] = (editedLines ?? detailData?.lines ?? []).map((l) => l);
  const overallConfidence = pendingSuggestion.confidence != null
    ? Number(pendingSuggestion.confidence)
    : null;
  const overallConfidenceLabel: SuggestionConfidence = overallConfidence == null
    ? "no_match"
    : overallConfidence >= 0.85
      ? "high"
      : overallConfidence >= 0.55
        ? "medium"
        : overallConfidence > 0
          ? "low"
          : "no_match";

  const hasLowConfidenceLines = lines.some(
    (l) => l.confidence === "low" || l.confidence === "no_match",
  );
  const hasNoMatchLines = lines.some((l) => l.confidence === "no_match");
  const hasUnresolved = lines.some((l) =>
    l.resolution_status !== "excluded" && (
      l.resolution_status !== "resolved" || l.selected_base_item == null
    ),
  );
  const hasLiveRecipeVersion = Number.isInteger(detailData?.live_recipe_version);
  const canApprove = !approveMutation.isPending && !hasUnresolved && hasLiveRecipeVersion;

  function initEditedLines() {
    if (!editedLines && detailData?.lines) {
      setEditedLines(detailData.lines.map((l) => ({ ...l })));
    }
    setShowEditSection(true);
  }

  function handleApprove() {
    const liveRecipeVersion = detailData?.live_recipe_version;
    if (typeof liveRecipeVersion !== "number" || !Number.isInteger(liveRecipeVersion)) return;
    const payload: { note?: string; expected_live_recipe_version: number } = {
      expected_live_recipe_version: liveRecipeVersion,
    };
    if (approveNote.trim()) payload.note = approveNote.trim();
    approveMutation.mutate(payload);
  }

  function openCorrection(line: SuggestionLine | null, type = "replace_base_item") {
    setCorrectionLine(line);
    setCorrectionType(type);
    setCorrectionReason(type === "add_line" ? "omitted_extraction" : "incorrect_base_item");
    setCorrectionErrorType(type === "add_line" ? "extraction" : "base_item_selection");
    setCorrectionBaseItemId(line?.selected_base_item?.id ? String(line.selected_base_item.id) : "");
    setCorrectionQuantity(String(line?.quantity ?? 1));
    const initializer = correctionDialogInitializer(line);
    setCorrectionRequirement(initializer.phrase);
    setOriginalCorrectionRequirement(initializer.phrase);
    setStructuredRequirementDraft(initializer.structuredDraft);
    setOriginalStructuredRequirementDraft(initializer.structuredDraft);
    setCorrectionNote("");
    setCorrectionIntent("product_only");
    setLearningKind("alias");
    setLearningValue("");
    setLearningScope(defaultLearningScope("alias"));
    setDimensionClassifications({});
    setAcknowledgeExclusion(false);
    setShowCorrectionDialog(true);
  }

  function submitCorrection() {
    const payload: Record<string, unknown> = {
      correction_type: correctionType,
      line_id: correctionLine?.id ?? null,
      extraction_error_type: correctionErrorType,
      reason: correctionType === "preserve_unresolved"
        ? "no_suitable_existing_base_item"
        : correctionReason,
      note: correctionNote || undefined,
      intent: correctionIntent,
      extracted_requirement: correctionRequirement || undefined,
    };
    if (["replace_base_item", "add_line"].includes(correctionType)) {
      payload.base_item_id = Number(correctionBaseItemId);
    }
    if (["change_quantity", "add_line"].includes(correctionType)) {
      payload.quantity = Number(correctionQuantity);
    }
    if (correctionType === "preserve_unresolved") {
      payload.acknowledge_exclusion = acknowledgeExclusion;
    }
    if (correctionType === "correct_requirement") {
      payload.corrected_structured_requirement = correctRequirementPayload(
        correctionLine,
        correctionRequirement,
        originalCorrectionRequirement,
        structuredRequirementDraft,
        originalStructuredRequirementDraft,
        dimensionClassifications,
      );
    }
    if (correctionIntent === "propose_learning") {
      if (learningKind === "alias") {
        payload.learning_proposal = {
          kind: "alias",
          scope: learningScope,
          base_item_id: Number(correctionBaseItemId || correctionLine?.selected_base_item?.id),
          alias: learningValue,
        };
      } else if (learningKind === "metadata") {
        payload.learning_proposal = {
          kind: "metadata",
          scope: learningScope,
          base_item_id: Number(correctionBaseItemId || correctionLine?.selected_base_item?.id),
          attribute_type: learningMetadataAttribute,
          proposed_value: learningValue,
          source_text: correctionRequirement,
        };
      } else {
        const definition = learningScope === "ingredient_color_combination"
          ? {
              ingredient: structuredRequirementDraft.ingredientType || structuredRequirementDraft.ingredientFamily,
              color: structuredRequirementDraft.color,
            }
          : learningScope === "canonical_product_format"
            ? { canonical_product_format: structuredRequirementDraft.productFormat }
            : learningScope === "dimension_pattern"
              ? {
                  dimensions: Object.fromEntries(
                    (["height", "width", "diameter"] as const)
                      .filter((kind) => structuredRequirementDraft[kind])
                      .map((kind) => [kind, structuredRequirementDraft[kind]]),
                  ),
                }
              : learningScope === "workspace_wide_rule"
                ? { workspace_wide: true }
                : { phrase: correctionRequirement };
        payload.learning_proposal = {
          kind: "contextual_rule",
          scope: learningScope,
          name: learningValue,
          definition: {
            ...definition,
            base_item_id: Number(correctionBaseItemId || correctionLine?.selected_base_item?.id) || null,
          },
          specificity: learningScope === "workspace_wide_rule" ? 0 : 100,
          priority: 0,
        };
      }
    }
    correctionMutation.mutate(payload);
  }

  function handleReject() {
    rejectMutation.mutate(rejectNote);
  }

  return (
    <div className="space-y-4" data-testid="recipe-suggestion-panel">
      {/* Header */}
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-center gap-2">
          <Sparkles size={16} className="text-primary shrink-0 mt-0.5" />
          <div>
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-sm font-semibold">Recipe Suggestion</span>
              <Badge variant="outline" className="text-[10px] px-1.5 py-0 font-medium">
                v{pendingSuggestion.version} · Awaiting review
              </Badge>
              <ConfidenceBadge confidence={overallConfidenceLabel} />
            </div>
            <p className="text-xs text-muted-foreground mt-0.5">
              {new Date(pendingSuggestion.created_at).toLocaleDateString(undefined, {
                month: "short",
                day: "numeric",
                year: "numeric",
              })}
              {pendingSuggestion.rationale && (
                <> · {pendingSuggestion.rationale}</>
              )}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => openCorrection(null, "add_line")}
            disabled={detailLoading}
            data-testid="btn-edit-suggestion"
          >
            <Pencil size={13} className="mr-1.5" />
            Add line
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => setShowRejectDialog(true)}
            data-testid="btn-reject-suggestion"
          >
            <ThumbsDown size={13} className="mr-1.5" />
            Reject
          </Button>
          <Button
            size="sm"
            onClick={() => setShowApproveDialog(true)}
            disabled={!canApprove || detailLoading}
            data-testid="btn-approve-suggestion"
          >
            <ThumbsUp size={13} className="mr-1.5" />
            Approve
          </Button>
        </div>
      </div>

      {/* Warnings */}
      {hasNoMatchLines && (
        <div className="flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/5 p-3 text-xs">
          <XCircle size={13} className="mt-0.5 shrink-0 text-destructive" />
          <span className="text-destructive">
            One or more requirements had no matching base item. Review these lines and either
            assign a base item manually or remove them before approving.
          </span>
        </div>
      )}
      {!hasNoMatchLines && hasLowConfidenceLines && (
        <div className="flex items-start gap-2 rounded-md border border-amber-300 bg-amber-50 p-3 text-xs dark:border-amber-700 dark:bg-amber-950/40">
          <AlertTriangle size={13} className="mt-0.5 shrink-0 text-amber-600" />
          <span className="text-amber-800 dark:text-amber-300">
            Some lines have low confidence. Review the rationale and evidence before approving.
          </span>
        </div>
      )}

      {/* Lines table */}
      {detailLoading ? (
        <div className="flex items-center gap-2 text-sm text-muted-foreground py-4">
          <Loader2 size={14} className="animate-spin" />
          Loading suggestion details…
        </div>
      ) : (
        <div className="rounded-lg border border-border overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border bg-muted/40">
                <th className="px-3 py-2 text-left font-medium text-xs text-muted-foreground uppercase tracking-wide">
                  Requirement
                </th>
                <th className="px-3 py-2 text-left font-medium text-xs text-muted-foreground uppercase tracking-wide">
                  Suggested Item
                </th>
                <th className="px-3 py-2 text-right font-medium text-xs text-muted-foreground uppercase tracking-wide">
                  Qty
                </th>
                <th className="px-3 py-2 text-left font-medium text-xs text-muted-foreground uppercase tracking-wide">
                  Confidence
                </th>
                <th className="px-3 py-2 text-left font-medium text-xs text-muted-foreground uppercase tracking-wide">
                  Source
                </th>
                <th className="px-3 py-2 text-right font-medium text-xs text-muted-foreground uppercase tracking-wide">
                  Review
                </th>
              </tr>
            </thead>
            <tbody>
              {lines.length === 0 ? (
                <tr>
                  <td colSpan={6} className="px-3 py-6 text-center text-sm text-muted-foreground">
                    No lines in this suggestion.
                  </td>
                </tr>
              ) : (
                lines.map((line, idx) => {
                  const warning = lineWarning(line);
                  return (
                    <SuggestionLineRow
                      key={line.id}
                      line={line}
                      isLast={idx === lines.length - 1}
                      warning={warning}
                      isEditing={showEditSection}
                      onQtyChange={(qty) => {
                        setEditedLines((prev) =>
                          (prev ?? lines).map((l) =>
                            l.id === line.id ? { ...l, _editedQty: qty } : l,
                          ),
                        );
                      }}
                      onCorrect={() => openCorrection(line)}
                    />
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      )}

      {(detailData?.corrections?.length ?? 0) > 0 && (
        <div className="rounded-lg border border-border p-3 space-y-2">
          <div className="flex items-center gap-2 text-sm font-medium">
            <BookOpen size={14} />
            Correction history
            <Badge variant="outline">{detailData!.corrections.length}</Badge>
          </div>
          {detailData!.corrections.map((correction) => (
            <div key={correction.id} className="rounded-md bg-muted/40 px-3 py-2 text-xs">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-medium">{correction.correction_type.replaceAll("_", " ")}</span>
                <Badge variant="outline">{correction.reason.replaceAll("_", " ")}</Badge>
                {correction.extraction_error_type && (
                  <span className="text-muted-foreground">
                    Classified as {correction.extraction_error_type.replaceAll("_", " ")}
                  </span>
                )}
                {correction.intent === "propose_learning" && (
                  <Badge variant="secondary">Candidate only · {correction.proposed_scope}</Badge>
                )}
              </div>
              {correction.note && <p className="text-muted-foreground mt-1">{correction.note}</p>}
              <p className="text-muted-foreground/70 mt-1">
                {new Date(correction.created_at).toLocaleString()} · immutable before/after snapshot retained
              </p>
            </div>
          ))}
        </div>
      )}

      {/* Approve dialog */}
      <Dialog open={showApproveDialog} onOpenChange={setShowApproveDialog}>
        <DialogContent className="sm:max-w-md">
          <DialogTitle className="flex items-center gap-2">
            <ThumbsUp size={18} className="text-emerald-600" />
            Approve recipe suggestion
          </DialogTitle>
          <DialogDescription>
            Approving will replace the live recipe with this suggestion's items.
            COGS calculations will update immediately. This action is recorded in the audit log.
          </DialogDescription>
          <div className="grid grid-cols-1 gap-2 text-xs">
            <RecipeComparison
              title={`Current live Recipe · version ${detailData?.live_recipe_version ?? 0}`}
              lines={(detailData?.live_recipe ?? []).map((line) => ({
                name: line.baseItemName,
                quantity: line.quantity,
              }))}
            />
            <RecipeComparison
              title="Original generated suggestion"
              lines={(detailData?.original_lines ?? []).map((line) => ({
                name: String(line.base_item_name ?? line.extracted_requirement ?? "Unresolved requirement"),
                quantity: Number(line.quantity ?? 1),
              }))}
            />
            <RecipeComparison
              title="Corrected draft to approve"
              lines={lines
                .filter((line) => line.resolution_status !== "excluded")
                .map((line) => ({
                  name: line.selected_base_item?.name ?? line.extracted_requirement ?? "Unresolved",
                  quantity: line.quantity,
                }))}
            />
          </div>
          {hasUnresolved && (
            <div className="flex items-start gap-2 rounded-md border border-amber-300 bg-amber-50 p-3 text-xs dark:border-amber-700 dark:bg-amber-950/40">
              <AlertTriangle size={13} className="mt-0.5 shrink-0 text-amber-600" />
              <span className="text-amber-800 dark:text-amber-300">
                Approval is blocked. Every unresolved requirement must be linked to a Base Item or
                explicitly marked “No suitable existing Base Item” with a reason and acknowledgement.
              </span>
            </div>
          )}
          <div className="space-y-1.5 mt-2">
            <Label htmlFor="approve-note">Note (optional)</Label>
            <Textarea
              id="approve-note"
              placeholder="Add a note about this approval…"
              value={approveNote}
              onChange={(e) => setApproveNote(e.target.value)}
              rows={2}
            />
          </div>
          <div className="flex justify-end gap-2 mt-2">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setShowApproveDialog(false)}
              disabled={approveMutation.isPending || hasUnresolved}
            >
              Cancel
            </Button>
            <Button
              size="sm"
              onClick={handleApprove}
              disabled={approveMutation.isPending}
              data-testid="btn-confirm-approve"
            >
              {approveMutation.isPending ? (
                <><Loader2 size={13} className="animate-spin mr-1.5" />Approving…</>
              ) : (
                "Approve & apply to live recipe"
              )}
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      <Dialog open={showCorrectionDialog} onOpenChange={setShowCorrectionDialog}>
        <DialogContent className="sm:max-w-2xl max-h-[90vh] overflow-y-auto">
          <DialogTitle>Correct Recipe draft line</DialogTitle>
          <DialogDescription>
            This changes only this Product’s suggestion draft. The live Recipe, inventory, COGS,
            stock consumption, and future matching remain unchanged.
          </DialogDescription>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <Field label="Correction">
              <select className="h-9 w-full rounded-md border bg-background px-3 text-sm" value={correctionType} onChange={(event) => setCorrectionType(event.target.value)}>
                <option value="replace_base_item">Replace incorrect Base Item</option>
                <option value="change_quantity">Change quantity</option>
                <option value="add_line">Add missing Recipe line</option>
                <option value="remove_line">Remove incorrect extra line</option>
                <option value="correct_requirement">Correct extracted requirement</option>
                <option value="preserve_unresolved">No suitable existing Base Item</option>
              </select>
            </Field>
            <Field label="Error classification">
              <select className="h-9 w-full rounded-md border bg-background px-3 text-sm" value={correctionErrorType} onChange={(event) => setCorrectionErrorType(event.target.value)}>
                {["extraction", "canonical_product_format", "candidate_retrieval", "base_item_selection", "quantity_extraction", "dimension_parsing", "contextual_rule_application", "hidden_item_rule_application"].map((value) => (
                  <option key={value} value={value}>{value.replaceAll("_", " ")}</option>
                ))}
              </select>
            </Field>
            {correctionType !== "preserve_unresolved" && (
              <Field label="Reason">
                <select className="h-9 w-full rounded-md border bg-background px-3 text-sm" value={correctionReason} onChange={(event) => setCorrectionReason(event.target.value)}>
                  {["hidden_packaging_rule", "format_requirement", "omitted_extraction", "incorrect_similar_product_pattern", "structured_data_only_ingredient", "product_specific_exception", "incorrect_ai_added_ingredient", "incorrect_base_item", "incorrect_quantity", "incorrect_structured_requirement"].map((value) => (
                    <option key={value} value={value}>{value.replaceAll("_", " ")}</option>
                  ))}
                </select>
              </Field>
            )}
            {["replace_base_item", "add_line"].includes(correctionType) && (
              <Field label="Existing Base Item">
                <Input value={baseItemSearch} onChange={(event) => setBaseItemSearch(event.target.value)} placeholder="Search Base Items…" className="mb-2" />
                <select className="h-9 w-full rounded-md border bg-background px-3 text-sm" value={correctionBaseItemId} onChange={(event) => setCorrectionBaseItemId(event.target.value)}>
                  <option value="">Select a Base Item</option>
                  {(baseItemsQuery.data?.items ?? []).map((item) => (
                    <option key={item.id} value={item.id}>{item.name}{item.code ? ` · ${item.code}` : ""}</option>
                  ))}
                </select>
              </Field>
            )}
            {["change_quantity", "add_line"].includes(correctionType) && (
              <Field label="Quantity">
                <Input type="number" min="0.0001" step="any" value={correctionQuantity} onChange={(event) => setCorrectionQuantity(event.target.value)} />
              </Field>
            )}
            {!["remove_line"].includes(correctionType) && (
              <Field label="Structured requirement">
                <Input value={correctionRequirement} onChange={(event) => setCorrectionRequirement(event.target.value)} placeholder="e.g. 12 red roses, 50 cm stems" />
              </Field>
            )}
          </div>
          {correctionType === "correct_requirement" && (
            <div className="rounded-md border border-border p-3 space-y-3">
              <div>
                <p className="text-sm font-medium">Correct structured fields</p>
                <p className="text-xs text-muted-foreground">
                  Values are initialized from generation. Only fields you change are submitted, so
                  unrelated generated requirements remain available to the API merge.
                </p>
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                {structuredRequirementFields.map(([key, label, type]) => (
                  <Field key={key} label={label}>
                    <Input
                      type={type}
                      value={structuredRequirementDraft[key]}
                      onChange={(event) => setStructuredRequirementDraft((previous) => ({
                        ...previous,
                        [key]: event.target.value,
                      }))}
                      placeholder={type === "number" ? "e.g. 12" : "Not specified"}
                      data-testid={`correct-structured-${key}`}
                    />
                  </Field>
                ))}
              </div>
              {(Array.isArray(detailData?.structured_requirements?.dimensions)
                ? detailData.structured_requirements.dimensions : [])
                .map((dimension, index) => ({ dimension: dimension as Record<string, unknown>, index }))
                .filter(({ dimension }) =>
                  !["height", "width", "diameter"].includes(String(dimension.dimensionKind ?? ""))
                  && !/\b(height|width|diameter)\b/i.test(String(dimension.sourcePhrase ?? "")))
                .map(({ dimension, index }) => (
                  <Field key={index} label={`Unclassified dimension: ${String(dimension.sourcePhrase ?? dimension.value ?? "")}`}>
                    <select
                      className="h-9 w-full rounded-md border bg-background px-2 text-sm"
                      value={dimensionClassifications[index] ?? "unclassified"}
                      onChange={(event) => setDimensionClassifications((previous) => ({
                        ...previous,
                        [index]: event.target.value as "unclassified" | "height" | "width" | "diameter" | "remove",
                      }))}
                    >
                      <option value="unclassified">Keep unclassified</option>
                      <option value="height">Classify as height</option>
                      <option value="width">Classify as width</option>
                      <option value="diameter">Classify as diameter</option>
                      <option value="remove">Remove this dimension</option>
                    </select>
                  </Field>
                ))}
            </div>
          )}
          {correctionType === "preserve_unresolved" && (
            <label className="flex items-start gap-2 rounded-md border border-amber-300 bg-amber-50 p-3 text-xs dark:bg-amber-950/30">
              <input type="checkbox" checked={acknowledgeExclusion} onChange={(event) => setAcknowledgeExclusion(event.target.checked)} />
              <span>I confirm no suitable existing Base Item exists and authorize excluding this unresolved requirement from complete-Recipe approval.</span>
            </label>
          )}
          <Field label="Reviewer note">
            <Textarea value={correctionNote} onChange={(event) => setCorrectionNote(event.target.value)} placeholder="Explain the evidence for this correction…" />
          </Field>
          <div className="rounded-md border border-border p-3 space-y-3">
            <label className="flex items-center justify-between gap-3">
              <span>
                <span className="block text-sm font-medium">Propose future learning</span>
                <span className="block text-xs text-muted-foreground">Separate, governed candidate action. It will not activate automatically.</span>
              </span>
              <input type="checkbox" checked={correctionIntent === "propose_learning"} onChange={(event) => setCorrectionIntent(event.target.checked ? "propose_learning" : "product_only")} />
            </label>
            {correctionIntent === "propose_learning" && (
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
                <select
                  className="h-9 rounded-md border bg-background px-2 text-sm"
                  value={learningKind}
                  onChange={(event) => {
                    const nextKind = event.target.value as RecipeLearningKind;
                    setLearningKind(nextKind);
                    setLearningScope(defaultLearningScope(nextKind));
                  }}
                >
                  <option value="alias">Candidate alias</option>
                  <option value="contextual_rule">Candidate contextual rule</option>
                  <option value="metadata">Candidate Base Item metadata</option>
                </select>
                <select
                  className="h-9 rounded-md border bg-background px-2 text-sm"
                  value={learningScope}
                  onChange={(event) => setLearningScope(event.target.value as RecipeLearningScope)}
                >
                  {learningScopeOptions(learningKind).map((option) => (
                    <option key={option.value} value={option.value}>{option.label}</option>
                  ))}
                </select>
                <Input value={learningValue} onChange={(event) => setLearningValue(event.target.value)} placeholder={learningKind === "alias" ? "Alias phrase" : "Proposed value or rule name"} />
                {learningKind === "metadata" && (
                  <select
                    className="h-9 rounded-md border bg-background px-2 text-sm sm:col-span-3"
                    value={learningMetadataAttribute}
                    onChange={(event) => setLearningMetadataAttribute(event.target.value)}
                  >
                    <option value="flower_type">Flower type</option>
                    <option value="color">Color</option>
                    <option value="stem_length_cm">Stem length</option>
                    <option value="container_type">Container type</option>
                    <option value="shape">Shape</option>
                    <option value="material">Material</option>
                    <option value="height_cm">Height</option>
                    <option value="width_cm">Width</option>
                    <option value="diameter_cm">Diameter</option>
                    <option value="package_count">Package count</option>
                    <option value="preferred_canonical_product_format">Preferred canonical Product format</option>
                  </select>
                )}
              </div>
            )}
          </div>
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setShowCorrectionDialog(false)}>Cancel</Button>
            <Button
              onClick={submitCorrection}
              disabled={
                correctionMutation.isPending
                || (["replace_base_item", "add_line"].includes(correctionType) && !correctionBaseItemId)
                || (correctionType === "preserve_unresolved" && !acknowledgeExclusion)
                || (correctionIntent === "propose_learning" && !learningValue.trim())
              }
            >
              {correctionMutation.isPending ? <Loader2 size={14} className="animate-spin mr-2" /> : null}
              Apply to draft only
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* Reject dialog */}
      <Dialog open={showRejectDialog} onOpenChange={setShowRejectDialog}>
        <DialogContent className="sm:max-w-md">
          <DialogTitle className="flex items-center gap-2">
            <ThumbsDown size={18} className="text-destructive" />
            Reject recipe suggestion
          </DialogTitle>
          <DialogDescription>
            Rejecting discards this draft. The live recipe is not changed.
            You can generate a new suggestion at any time.
          </DialogDescription>
          <div className="space-y-1.5 mt-2">
            <Label htmlFor="reject-note">Reason (optional)</Label>
            <Textarea
              id="reject-note"
              placeholder="Why are you rejecting this suggestion?"
              value={rejectNote}
              onChange={(e) => setRejectNote(e.target.value)}
              rows={2}
            />
          </div>
          <div className="flex justify-end gap-2 mt-2">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setShowRejectDialog(false)}
              disabled={rejectMutation.isPending}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              size="sm"
              onClick={handleReject}
              disabled={rejectMutation.isPending}
              data-testid="btn-confirm-reject"
            >
              {rejectMutation.isPending ? (
                <><Loader2 size={13} className="animate-spin mr-1.5" />Rejecting…</>
              ) : (
                "Reject suggestion"
              )}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}

// ─── Suggestion line row ──────────────────────────────────────────────────────

export function SuggestionLineRow({
  line,
  isLast,
  warning,
  isEditing,
  onQtyChange,
  onCorrect,
}: {
  line: EditableLine;
  isLast: boolean;
  warning: string | null;
  isEditing: boolean;
  onQtyChange: (qty: number) => void;
  onCorrect: () => void;
}) {
  const [showRationale, setShowRationale] = useState(false);
  const qty = line._editedQty ?? line.quantity;
  const evidenceView = suggestionLineEvidenceView(line);

  return (
    <tr
      className={`${!isLast ? "border-b border-border" : ""} ${warning ? "bg-amber-50/40 dark:bg-amber-950/10" : ""}`}
      data-testid={`suggestion-line-${line.id}`}
    >
      {/* Requirement */}
      <td className="px-3 py-2 align-top">
        <div className="text-xs font-medium text-foreground">
          {evidenceView.phrase ? `“${evidenceView.phrase}”` : line.extracted_requirement ?? <span className="italic">No Product phrase</span>}
        </div>
        {(evidenceView.sourceLabel || evidenceView.spanLabel) && (
          <div className="mt-0.5 text-[10px] text-muted-foreground">
            Product {evidenceView.sourceLabel ?? "source"}
            {evidenceView.spanLabel ? ` · ${evidenceView.spanLabel}` : ""}
          </div>
        )}
        {evidenceView.requirementId && (
          <div className="mt-0.5 truncate font-mono text-[9px] text-muted-foreground/70" title={evidenceView.requirementId}>
            Requirement {evidenceView.requirementId}
          </div>
        )}
        {line.unit_context && (
          <div className="text-[10px] text-muted-foreground/70 mt-0.5">{line.unit_context}</div>
        )}
      </td>

      {/* Suggested item */}
      <td className="px-3 py-2 align-top">
        {line.selected_base_item ? (
          <div className="flex items-center gap-1.5">
            <Link
              href={`/base-items/${line.selected_base_item.id}`}
              className="flex items-center gap-1.5 text-sm font-medium hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded-sm"
            >
              {line.selected_base_item.name}
            </Link>
          </div>
        ) : (
          <span className="inline-flex items-center gap-1 text-xs text-destructive">
            <XCircle size={12} />
            No match
          </span>
        )}
        {line.selected_base_item?.code && (
          <div className="font-mono text-[10px] text-muted-foreground mt-0.5">
            {line.selected_base_item.code}
          </div>
        )}
        {warning && (
          <div className="flex items-center gap-1 text-[10px] text-amber-700 dark:text-amber-400 mt-0.5">
            <AlertTriangle size={10} />
            {warning}
          </div>
        )}
        {line.rationale && (
          <button
            type="button"
            onClick={() => setShowRationale((v) => !v)}
            className="flex items-center gap-0.5 text-[10px] text-muted-foreground hover:text-foreground mt-0.5"
          >
            {showRationale ? <ChevronUp size={10} /> : <ChevronDown size={10} />}
            {showRationale ? "Hide rationale" : "Rationale"}
          </button>
        )}
        {showRationale && line.rationale && (
          <div className="mt-1 text-[10px] text-muted-foreground border-l-2 border-border pl-2">
            {line.rationale}
          </div>
        )}
      </td>

      {/* Quantity */}
      <td className="px-3 py-2 text-right align-top">
        {isEditing && line.selected_base_item ? (
          <Input
            type="number"
            min="0.001"
            step="any"
            value={qty}
            onChange={(e) => onQtyChange(Number(e.target.value))}
            className="w-16 h-7 text-right text-xs"
          />
        ) : (
          <span className="text-sm">{line.quantity}</span>
        )}
      </td>

      {/* Confidence */}
      <td className="px-3 py-2 align-top">
        <ConfidenceBadge confidence={line.confidence} />
      </td>

      {/* Source */}
      <td className="px-3 py-2 align-top">
        <SourceTypeBadge sourceType={line.source_type} sourceRuleId={line.source_rule_id} />
        <div className="mt-1">
          <CandidateStateBadge state={evidenceView.candidateState} count={evidenceView.candidateCount} />
        </div>
        <CandidateDiagnostics view={evidenceView} />
        {evidenceView.evidence.length > 0 && (
          <div className="mt-1 flex max-w-64 flex-wrap gap-1">
            {evidenceView.evidence.map((item, index) => (
              <EvidenceBadge key={`${item.kind}-${index}`} {...item} />
            ))}
          </div>
        )}
        {line.resolution_status === "excluded" && (
          <Badge variant="outline" className="mt-1 text-[10px]">Explicitly excluded</Badge>
        )}
      </td>
      <td className="px-3 py-2 text-right align-top">
        <Button variant="ghost" size="sm" onClick={onCorrect} className="h-7 text-xs">
          Correct
        </Button>
      </td>
    </tr>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1.5">
      <Label>{label}</Label>
      {children}
    </div>
  );
}

function RecipeComparison({
  title,
  lines,
}: {
  title: string;
  lines: Array<{ name: string; quantity: number }>;
}) {
  return (
    <div className="rounded-md border border-border p-2">
      <p className="font-medium mb-1">{title}</p>
      {lines.length === 0 ? (
        <p className="text-muted-foreground">No Recipe lines</p>
      ) : (
        <div className="flex flex-wrap gap-1">
          {lines.map((line, index) => (
            <Badge key={`${line.name}-${index}`} variant="secondary">
              {line.quantity} × {line.name}
            </Badge>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * RecipeReviewPage (/recipe-review)
 *
 * A focused queue that surfaces products needing recipe attention:
 * - Products with no recipe at all
 * - Products with a pending (generated) suggestion awaiting review
 *
 * Each row links directly into the product's Recipe tab for single-product review.
 */
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiFetch } from "@/lib/queryClient";
import { imageUrl } from "@/lib/imageUrl";
import { useRecipeAttention } from "@/hooks/use-recipe-attention";
import { useWorkspaceRole } from "@/hooks/use-workspace-role";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog";
import { Link } from "wouter";
import {
  Loader2,
  FlaskConical,
  Sparkles,
  Search,
  ArrowRight,
  CheckCircle2,
  XCircle,
  AlertTriangle,
  ShoppingBag,
  BookOpen,
  ShieldCheck,
} from "lucide-react";

export function contextualResolverBaseItemId(definition: Record<string, unknown>): unknown {
  return definition.resolver_base_item_id ?? definition.base_item_id ?? definition.baseItemId;
}

// ─── Types ───────────────────────────────────────────────────────────────────

type ProductListItem = {
  id: number;
  name: string;
  status: string;
  brand: string | null;
  category: string | null;
  main_image_url: string | null;
};

type RecipeSuggestion = {
  id: number;
  product_id: number | null;
  version: number;
  status: string;
  confidence: string | number | null;
  created_at: string;
};

type ProductWithRecipeInfo = ProductListItem & {
  recipeCount: number;
  suggestion: RecipeSuggestion | null;
};

type FilterKey = "all" | "no-recipe" | "pending-suggestion";

type ReviewQueue = {
  attention_lines: Array<{
    line_id: number;
    product_id: number;
    product_name: string;
    extracted_requirement: string | null;
    match_confidence: string;
    resolution_status: string;
  }>;
  submitted_corrections: Array<{
    id: number;
    product_id: number;
    product_name: string;
    correction_type: string;
    reason: string;
    intent: string;
    created_at: string;
  }>;
  learning_candidates: Array<{
    candidate_kind: "rule" | "alias" | "metadata";
    id: number;
    status: string;
    label: string;
    proposed_value: unknown;
    supporting_count: number;
    conflict_count: number;
    supporting_products: string[];
  }>;
};

type CandidateDetail = Record<string, unknown> & {
  id: number;
  status: string;
  base_item_name?: string | null;
  base_item_id?: number | null;
  alias?: string;
  attribute_type?: string;
  proposed_value?: unknown;
  source_text?: string | null;
  extraction_method?: string | null;
  source_type?: string | null;
  source_actor_user_id?: string | null;
  confidence?: string | number | null;
  definition?: Record<string, unknown>;
  description?: string | null;
  name?: string;
  rule_type?: string;
  source?: string;
  created_by_user_id?: string | null;
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

function overallConfidenceLabel(
  confidence: string | number | null,
): "high" | "medium" | "low" | "no_match" {
  if (confidence == null) return "no_match";
  const n = Number(confidence);
  if (n >= 0.85) return "high";
  if (n >= 0.55) return "medium";
  if (n > 0) return "low";
  return "no_match";
}

function ConfidencePip({
  confidence,
}: {
  confidence: "high" | "medium" | "low" | "no_match";
}) {
  const map = {
    high: "text-emerald-600",
    medium: "text-amber-600",
    low: "text-red-500",
    no_match: "text-muted-foreground",
  };
  const Icon =
    confidence === "high"
      ? CheckCircle2
      : confidence === "no_match"
        ? XCircle
        : AlertTriangle;
  return <Icon size={13} className={map[confidence]} />;
}

// ─── Page component ───────────────────────────────────────────────────────────

export default function RecipeReviewPage() {
  const qc = useQueryClient();
  const { isOwner, allowedPages, loaded: roleLoaded } = useWorkspaceRole();
  const canManageLearning = isOwner || (allowedPages?.includes("products.manage") ?? false);
  const [filter, setFilter] = useState<FilterKey>("all");
  const [search, setSearch] = useState("");

  // Fetch all products (paginated at server, we take what's returned)
  const {
    data: productsData,
    isLoading: productsLoading,
    isError: productsError,
  } = useQuery({
    queryKey: ["products", "recipe-review"],
    queryFn: () =>
      apiFetch<{ products: ProductListItem[] }>("/api/products?limit=500"),
  });

  // Fetch all pending suggestions across the workspace
  // We call the listing per-product lazily — but for the queue we fetch suggestions for visible products
  // by using a dedicated summary endpoint if available, else show navigation-only.
  // Since the API surfaces per-product, we show the queue filtered from product list.

  const products = productsData?.products ?? [];

  // Build enriched product list: fetch recipe info per product would be expensive.
  // Instead, we show counts based on what we have, and let the product detail show the suggestion.
  // We fetch recipe-suggestions list for products that are shown (up to ~50) to mark pending ones.
  const displayProducts = products.slice(0, 200);

  const { data: recipeSummaryData, isLoading: summaryLoading } = useRecipeAttention();
  const { data: reviewQueue, isLoading: queueLoading } = useQuery({
    queryKey: ["recipe-intelligence-review-queue"],
    queryFn: () => apiFetch<ReviewQueue>("/api/recipe-intelligence/review-queue"),
    enabled: canManageLearning,
  });
  const { data: rulesData } = useQuery({
    queryKey: ["recipe-intelligence-rules"],
    queryFn: () => apiFetch<{ rules: CandidateDetail[] }>("/api/recipe-intelligence/rules"),
    enabled: canManageLearning,
  });
  const { data: aliasesData } = useQuery({
    queryKey: ["recipe-intelligence-aliases"],
    queryFn: () => apiFetch<{ aliases: CandidateDetail[] }>("/api/recipe-intelligence/base-item-aliases"),
    enabled: canManageLearning,
  });
  const { data: metadataData } = useQuery({
    queryKey: ["recipe-intelligence-metadata"],
    queryFn: () => apiFetch<{ candidates: CandidateDetail[] }>("/api/recipe-intelligence/base-item-metadata-candidates"),
    enabled: canManageLearning,
  });
  const decisionMutation = useMutation({
    mutationFn: (input: {
      kind: "rule" | "alias" | "metadata";
      id: number;
      action: string;
      payload?: Record<string, unknown>;
    }) => {
      const path = input.kind === "rule"
        ? `/api/recipe-intelligence/rules/${input.id}/decision`
        : input.kind === "alias"
          ? `/api/recipe-intelligence/base-item-aliases/${input.id}/decision`
          : `/api/recipe-intelligence/base-item-metadata-candidates/${input.id}/decision`;
      return apiFetch(path, {
        method: "POST",
        body: JSON.stringify({ action: input.action, ...input.payload }),
      });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["recipe-intelligence-review-queue"] });
      qc.invalidateQueries({ queryKey: ["recipe-intelligence-rules"] });
      qc.invalidateQueries({ queryKey: ["recipe-intelligence-aliases"] });
      qc.invalidateQueries({ queryKey: ["recipe-intelligence-metadata"] });
    },
  });
  const candidateDetails = {
    rule: new Map((rulesData?.rules ?? []).map((candidate) => [candidate.id, candidate])),
    alias: new Map((aliasesData?.aliases ?? []).map((candidate) => [candidate.id, candidate])),
    metadata: new Map((metadataData?.candidates ?? []).map((candidate) => [candidate.id, candidate])),
  };

  // Fallback: if summary endpoint unavailable, show all products with unknown status
  const noRecipeIds = new Set<number>(recipeSummaryData?.products_without_recipe ?? []);
  const pendingByProductId = new Map<number, RecipeSuggestion>(
    (recipeSummaryData?.products_with_pending_suggestion ?? []).map((p) => [
      p.product_id,
      {
        id: p.suggestion_id,
        product_id: p.product_id,
        version: p.version,
        status: "generated",
        confidence: p.confidence,
        created_at: p.created_at,
      },
    ]),
  );

  const summaryAvailable = recipeSummaryData != null;

  // Enrich products with recipe info
  const enriched: ProductWithRecipeInfo[] = displayProducts.map((p) => ({
    ...p,
    recipeCount: noRecipeIds.has(p.id) ? 0 : summaryAvailable ? 1 : -1, // -1 = unknown
    suggestion: pendingByProductId.get(p.id) ?? null,
  }));

  // Filter
  const filtered = enriched.filter((p) => {
    const matchesSearch =
      !search ||
      p.name.toLowerCase().includes(search.toLowerCase()) ||
      (p.brand?.toLowerCase().includes(search.toLowerCase()) ?? false);
    if (!matchesSearch) return false;

    if (filter === "no-recipe") {
      return summaryAvailable ? noRecipeIds.has(p.id) : true;
    }
    if (filter === "pending-suggestion") {
      return p.suggestion != null;
    }
    return true;
  });

  // If summary is available, compute counts
  const noRecipeCount = summaryAvailable ? noRecipeIds.size : null;
  const pendingCount = summaryAvailable ? pendingByProductId.size : null;

  const isLoading = productsLoading || summaryLoading;

  return (
    <div className="space-y-6">
      {/* Page header */}
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Product Recipes</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Review products that need a recipe, or that have a suggestion awaiting approval.
        </p>
      </div>

      {/* Stat cards */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <StatCard
          icon={<ShoppingBag size={18} className="text-muted-foreground" />}
          label="Total products"
          value={isLoading ? null : products.length}
        />
        <StatCard
          icon={<FlaskConical size={18} className="text-amber-600" />}
          label="No recipe"
          value={noRecipeCount}
          loading={isLoading}
          unknown={!summaryAvailable && !isLoading}
        />
        <StatCard
          icon={<Sparkles size={18} className="text-primary" />}
          label="Pending suggestions"
          value={pendingCount}
          loading={isLoading}
          unknown={!summaryAvailable && !isLoading}
        />
      </div>

      {/* Filters + search */}
      <div className="flex flex-wrap items-center gap-3">
        <div className="relative flex-1 min-w-48">
          <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
          <Input
            placeholder="Search products…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="pl-8 h-8 text-sm"
          />
        </div>
        <div className="flex items-center gap-1.5">
          {(["all", "no-recipe", "pending-suggestion"] as FilterKey[]).map((f) => {
            const labels: Record<FilterKey, string> = {
              all: "All",
              "no-recipe": "No recipe",
              "pending-suggestion": "Pending suggestion",
            };
            return (
              <button
                key={f}
                type="button"
                onClick={() => setFilter(f)}
                className={`rounded-md px-3 py-1 text-xs font-medium transition-colors ${
                  filter === f
                    ? "bg-primary text-primary-foreground"
                    : "bg-muted text-muted-foreground hover:bg-muted/80"
                }`}
              >
                {labels[f]}
              </button>
            );
          })}
        </div>
      </div>

      {/* Table */}
      {isLoading ? (
        <div className="flex items-center justify-center py-16">
          <Loader2 size={24} className="animate-spin text-muted-foreground" />
        </div>
      ) : productsError ? (
        <div className="rounded-lg border border-destructive/50 bg-destructive/5 p-6 text-center">
          <p className="text-sm text-destructive font-medium">Failed to load products</p>
          <p className="text-xs text-muted-foreground mt-1">Please refresh the page.</p>
        </div>
      ) : filtered.length === 0 ? (
        <div className="rounded-lg border border-dashed border-border p-12 text-center">
          <FlaskConical size={28} className="mx-auto mb-2 text-muted-foreground" />
          <p className="font-medium text-sm">No products match this filter</p>
          <p className="text-xs text-muted-foreground mt-1">
            {filter === "no-recipe"
              ? "All products have a recipe — great!"
              : filter === "pending-suggestion"
                ? "No products have a pending suggestion right now."
                : "Try a different search or filter."}
          </p>
          {filter !== "all" && (
            <Button
              variant="outline"
              size="sm"
              className="mt-4"
              onClick={() => setFilter("all")}
            >
              Show all
            </Button>
          )}
        </div>
      ) : (
        <div className="rounded-lg border border-border overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border bg-muted/40">
                <th className="px-4 py-2.5 text-left font-medium text-xs text-muted-foreground uppercase tracking-wide">
                  Product
                </th>
                <th className="px-4 py-2.5 text-left font-medium text-xs text-muted-foreground uppercase tracking-wide">
                  Recipe
                </th>
                <th className="px-4 py-2.5 text-left font-medium text-xs text-muted-foreground uppercase tracking-wide">
                  Suggestion
                </th>
                <th className="px-4 py-2.5" />
              </tr>
            </thead>
            <tbody>
              {filtered.map((product, idx) => (
                <ProductReviewRow
                  key={product.id}
                  product={product}
                  isLast={idx === filtered.length - 1}
                  summaryAvailable={summaryAvailable}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Show "summary unavailable" note */}
      {!summaryAvailable && !isLoading && !productsError && (
        <div className="flex items-start gap-2 rounded-lg border border-amber-300 bg-amber-50 p-3 text-xs dark:border-amber-700 dark:bg-amber-950/40">
          <AlertTriangle size={13} className="mt-0.5 shrink-0 text-amber-600" />
          <span className="text-amber-800 dark:text-amber-300">
            Recipe status summary is not yet available. Open each product to check its recipe and suggestions.
            The "No recipe" and "Pending suggestion" filters are unavailable until the summary endpoint is deployed.
          </span>
        </div>
      )}

      <section className="space-y-4" data-testid="recipe-learning-review">
        <div>
          <h2 className="text-lg font-semibold flex items-center gap-2">
            <ShieldCheck size={18} />
            Structured learning review
          </h2>
          <p className="text-sm text-muted-foreground mt-1">
            Corrections apply to one Product draft. Learning stays inactive until an authorized reviewer approves a scoped candidate.
          </p>
        </div>
        {!roleLoaded ? (
          <Loader2 size={20} className="animate-spin text-muted-foreground" />
        ) : !canManageLearning ? (
          <div className="rounded-lg border border-border p-4 text-sm text-muted-foreground">
            Learning candidates are visible to owners and members with the manage products permission.
          </div>
        ) : queueLoading ? (
          <Loader2 size={20} className="animate-spin text-muted-foreground" />
        ) : (
          <div className="grid grid-cols-1 xl:grid-cols-3 gap-4">
            <ReviewCard title="Unresolved & low confidence" count={reviewQueue?.attention_lines.length ?? 0}>
              {(reviewQueue?.attention_lines ?? []).slice(0, 20).map((line) => (
                <Link key={line.line_id} href={`/products/${line.product_id}?tab=recipe`}>
                  <div className="rounded-md border p-2 hover:bg-muted/40">
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-sm font-medium truncate">{line.product_name}</span>
                      <Badge variant="outline">{line.resolution_status === "unresolved" ? "Unresolved" : line.match_confidence}</Badge>
                    </div>
                    <p className="text-xs text-muted-foreground mt-1 truncate">{line.extracted_requirement ?? "No extracted requirement"}</p>
                  </div>
                </Link>
              ))}
            </ReviewCard>
            <ReviewCard title="Submitted corrections" count={reviewQueue?.submitted_corrections.length ?? 0}>
              {(reviewQueue?.submitted_corrections ?? []).slice(0, 20).map((correction) => (
                <Link key={correction.id} href={`/products/${correction.product_id}?tab=recipe`}>
                  <div className="rounded-md border p-2 hover:bg-muted/40">
                    <p className="text-sm font-medium truncate">{correction.product_name}</p>
                    <p className="text-xs mt-1">{correction.correction_type.replaceAll("_", " ")}</p>
                    <p className="text-xs text-muted-foreground">{correction.reason.replaceAll("_", " ")} · {correction.intent.replaceAll("_", " ")}</p>
                  </div>
                </Link>
              ))}
            </ReviewCard>
              <ReviewCard title="Aliases, rules & metadata" count={reviewQueue?.learning_candidates.length ?? 0}>
              {(reviewQueue?.learning_candidates ?? []).slice(0, 30).map((candidate) => (
                  <LearningCandidateCard
                    key={`${candidate.candidate_kind}-${candidate.id}`}
                    candidate={candidate}
                    detail={candidateDetails[candidate.candidate_kind].get(candidate.id)}
                    onDecision={(action, payload) => decisionMutation.mutate({
                      kind: candidate.candidate_kind,
                      id: candidate.id,
                      action,
                      payload,
                    })}
                    pending={decisionMutation.isPending}
                  />
              ))}
            </ReviewCard>
          </div>
        )}
      </section>
    </div>
  );
}

function displayValue(value: unknown): string {
  if (value == null || value === "") return "—";
  return typeof value === "string" ? value : JSON.stringify(value);
}

function LearningCandidateCard({
  candidate,
  detail,
  onDecision,
  pending,
}: {
  candidate: ReviewQueue["learning_candidates"][number];
  detail?: CandidateDetail;
  onDecision: (action: string, payload?: Record<string, unknown>) => void;
  pending: boolean;
}) {
  const [showRuleEdit, setShowRuleEdit] = useState(false);
  const [showCandidateEdit, setShowCandidateEdit] = useState(false);
  const [candidateValue, setCandidateValue] = useState("");
  const [candidateSourceText, setCandidateSourceText] = useState("");
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [definition, setDefinition] = useState("");
  const [definitionError, setDefinitionError] = useState("");
  const { data: ruleDetail } = useQuery({
    queryKey: ["recipe-intelligence-rule", candidate.id],
    queryFn: () => apiFetch<{ rule: CandidateDetail; evidence: Array<Record<string, unknown>> }>(
      `/api/recipe-intelligence/rules/${candidate.id}`,
    ),
    enabled: candidate.candidate_kind === "rule",
  });
  const resolved = candidate.candidate_kind === "rule" ? ruleDetail?.rule ?? detail : detail;
  const ruleDefinition = resolved?.definition ?? (
    candidate.proposed_value && typeof candidate.proposed_value === "object"
      ? candidate.proposed_value as Record<string, unknown>
      : {}
  );
  const isRule = candidate.candidate_kind === "rule";
  const isAlias = candidate.candidate_kind === "alias";
  const isMetadata = candidate.candidate_kind === "metadata";
  const evidence = ruleDetail?.evidence ?? [];
  const detailsLoaded = isRule ? ruleDetail != null : detail != null;
  const conflictingEvidence = evidence.filter((item) => item.evidence_type === "conflicting");
  const supportingEvidence = evidence.filter((item) => item.evidence_type === "supporting");
  const openRuleEdit = () => {
    setName(resolved?.name ?? candidate.label);
    setDescription(resolved?.description ?? "");
    setDefinition(JSON.stringify(ruleDefinition, null, 2));
    setDefinitionError("");
    setShowRuleEdit(true);
  };
  const saveRuleEdit = () => {
    try {
      onDecision("edit", {
        name: name.trim() || undefined,
        description: description || null,
        definition: JSON.parse(definition),
      });
      setShowRuleEdit(false);
    } catch {
      setDefinitionError("Enter a valid JSON rule definition before saving.");
    }
  };
  const openCandidateEdit = () => {
    setCandidateValue(isAlias
      ? String(resolved?.alias ?? candidate.label)
      : displayValue(resolved?.proposed_value ?? candidate.proposed_value));
    setCandidateSourceText(String(resolved?.source_text ?? ""));
    setShowCandidateEdit(true);
  };
  const saveCandidateEdit = () => {
    if (isAlias) {
      onDecision("edit", { alias: candidateValue.trim() });
    } else {
      let proposedValue: unknown = candidateValue;
      try {
        proposedValue = JSON.parse(candidateValue);
      } catch {
        // Plain text is a valid metadata value; JSON values remain typed.
      }
      onDecision("edit", {
        proposed_value: proposedValue,
        source_text: candidateSourceText.trim() || null,
      });
    }
    setShowCandidateEdit(false);
  };
  return (
    <div className="rounded-md border p-3 space-y-2">
      <div className="flex items-center justify-between gap-2">
        <div className="min-w-0">
          <p className="text-sm font-medium truncate flex items-center gap-1">
            <BookOpen size={12} /> {candidate.label}
          </p>
          <p className="text-xs text-muted-foreground">
            {candidate.candidate_kind} · {candidate.supporting_count} evidence · {candidate.conflict_count} conflicts
          </p>
        </div>
        <Badge variant="outline">{candidate.status}</Badge>
      </div>

      {isRule && (
        <CandidateDetails rows={[
          ["Scope", ruleDefinition.proposed_scope ?? ruleDefinition.scope ?? ruleDefinition.rule_scope],
          ["Definition", ruleDefinition],
          ["Resolver Base Item", contextualResolverBaseItemId(ruleDefinition)],
          ["Specificity", ruleDefinition.specificity],
          ["Priority", ruleDefinition.priority],
          ["Provenance", resolved?.source ?? resolved?.created_by_user_id],
        ]} />
      )}
      {isAlias && (
        <CandidateDetails rows={[
          ["Phrase", resolved?.alias ?? candidate.label],
          ["Target Base Item", resolved?.base_item_name ?? resolved?.base_item_id ?? candidate.proposed_value],
          ["Source correction / Product", resolved?.source_type ?? "Not supplied"],
          ["Evidence / conflicts", `${candidate.supporting_count} / ${candidate.conflict_count}`],
          ["Provenance", resolved?.source_actor_user_id ?? "Not supplied"],
        ]} />
      )}
      {isMetadata && (
        <CandidateDetails rows={[
          ["Base Item", resolved?.base_item_name ?? resolved?.base_item_id],
          ["Attribute", resolved?.attribute_type ?? candidate.label],
          ["Value", resolved?.proposed_value ?? candidate.proposed_value],
          ["Source text", resolved?.source_text],
          ["Extraction method", resolved?.extraction_method],
          ["Confidence", resolved?.confidence],
          ["Provenance", resolved?.source_type ?? resolved?.source_actor_user_id],
        ]} />
      )}
      {isRule && supportingEvidence.length > 0 && (
        <div className="text-xs text-muted-foreground">
          <span className="font-medium text-foreground">Supporting Products: </span>
          {supportingEvidence.slice(0, 5).map((item) => String(item.product_name_snapshot ?? "Product")).join(", ")}
        </div>
      )}
      {isRule && (
        <div className="text-xs text-muted-foreground">
          <span className="font-medium text-foreground">Conflicting evidence: </span>
          {conflictingEvidence.length === 0
            ? "None"
            : conflictingEvidence.slice(0, 5).map((item) => String(item.product_name_snapshot ?? "Product")).join(", ")}
        </div>
      )}
      {!isRule && candidate.supporting_products.length > 0 && (
        <div className="text-xs text-muted-foreground">Evidence products: {candidate.supporting_products.join(", ")}</div>
      )}
      {candidate.status === "candidate" && (
        <div className="flex flex-wrap gap-1">
          {isRule && <Button size="sm" variant="outline" className="h-7 text-xs" onClick={openRuleEdit}>Edit before approval</Button>}
          {(isAlias || isMetadata) && <Button size="sm" variant="outline" className="h-7 text-xs" onClick={openCandidateEdit}>Edit before approval</Button>}
          <Button size="sm" className="h-7 text-xs" disabled={pending || !detailsLoaded} onClick={() => onDecision("approve")}>
            {detailsLoaded ? "Approve" : "Loading proposal…"}
          </Button>
          <Button size="sm" variant="outline" className="h-7 text-xs" disabled={pending} onClick={() => onDecision("reject")}>Reject</Button>
        </div>
      )}
      {candidate.status === "approved" && (
        <Button size="sm" variant="outline" className="h-7 text-xs" disabled={pending} onClick={() => onDecision("deactivate")}>Deactivate</Button>
      )}
      <Dialog open={showRuleEdit} onOpenChange={setShowRuleEdit}>
        <DialogContent className="sm:max-w-lg">
          <DialogTitle>Edit rule before approval</DialogTitle>
          <DialogDescription>Rule edits remain a candidate decision and are recorded before a separate approval.</DialogDescription>
          <div className="space-y-3">
            <div><Label>Rule name</Label><Input value={name} onChange={(event) => setName(event.target.value)} /></div>
            <div><Label>Description</Label><Textarea value={description} onChange={(event) => setDescription(event.target.value)} /></div>
            <div>
              <Label>Definition (scope, resolver, specificity, priority)</Label>
              <Textarea className="font-mono text-xs" rows={8} value={definition} onChange={(event) => setDefinition(event.target.value)} />
              {definitionError && <p className="text-xs text-destructive mt-1">{definitionError}</p>}
            </div>
          </div>
          <div className="flex justify-end gap-2"><Button variant="ghost" onClick={() => setShowRuleEdit(false)}>Cancel</Button><Button onClick={saveRuleEdit} disabled={!name.trim() || pending}>Save candidate edit</Button></div>
        </DialogContent>
      </Dialog>
      <Dialog open={showCandidateEdit} onOpenChange={setShowCandidateEdit}>
        <DialogContent className="sm:max-w-md">
          <DialogTitle>Edit {isAlias ? "alias" : "metadata"} before approval</DialogTitle>
          <DialogDescription>
            This appends a correction decision while keeping the proposal in Candidate state for separate approval.
          </DialogDescription>
          <div className="space-y-3">
            <div>
              <Label>{isAlias ? "Alias phrase" : "Proposed value"}</Label>
              <Input value={candidateValue} onChange={(event) => setCandidateValue(event.target.value)} />
            </div>
            {isMetadata && (
              <div>
                <Label>Source text</Label>
                <Textarea value={candidateSourceText} onChange={(event) => setCandidateSourceText(event.target.value)} />
              </div>
            )}
          </div>
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setShowCandidateEdit(false)}>Cancel</Button>
            <Button onClick={saveCandidateEdit} disabled={!candidateValue.trim() || pending}>Save candidate edit</Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function CandidateDetails({ rows }: { rows: Array<[string, unknown]> }) {
  return <dl className="grid grid-cols-[auto_1fr] gap-x-2 gap-y-1 text-xs">
    {rows.map(([label, value]) => <div key={label} className="contents"><dt className="text-muted-foreground">{label}</dt><dd className="break-words">{displayValue(value)}</dd></div>)}
  </dl>;
}

function ReviewCard({
  title,
  count,
  children,
}: {
  title: string;
  count: number;
  children: React.ReactNode;
}) {
  return (
    <div className="rounded-lg border border-border bg-card p-3">
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-sm font-semibold">{title}</h3>
        <Badge variant="secondary">{count}</Badge>
      </div>
      <div className="space-y-2 max-h-[34rem] overflow-y-auto">
        {count === 0 ? <p className="text-xs text-muted-foreground">Nothing waiting for review.</p> : children}
      </div>
    </div>
  );
}

// ─── Stat card ────────────────────────────────────────────────────────────────

function StatCard({
  icon,
  label,
  value,
  loading,
  unknown,
}: {
  icon: React.ReactNode;
  label: string;
  value: number | null;
  loading?: boolean;
  unknown?: boolean;
}) {
  return (
    <div className="rounded-lg border border-border bg-card p-4">
      <div className="flex items-center gap-2 mb-1">
        {icon}
        <span className="text-xs text-muted-foreground font-medium uppercase tracking-wide">{label}</span>
      </div>
      {loading ? (
        <Loader2 size={16} className="animate-spin text-muted-foreground mt-1" />
      ) : unknown ? (
        <span className="text-2xl font-bold text-muted-foreground">—</span>
      ) : (
        <span className="text-2xl font-bold">{value ?? "—"}</span>
      )}
    </div>
  );
}

// ─── Product row ──────────────────────────────────────────────────────────────

function ProductReviewRow({
  product,
  isLast,
  summaryAvailable,
}: {
  product: ProductWithRecipeInfo;
  isLast: boolean;
  summaryAvailable: boolean;
}) {
  const hasNoRecipe = product.recipeCount === 0;
  const pendingSuggestion = product.suggestion;
  const confidenceLevel = pendingSuggestion
    ? overallConfidenceLabel(pendingSuggestion.confidence)
    : null;
  const productImageUrl = imageUrl(product.main_image_url);

  return (
    <tr
      className={`group ${!isLast ? "border-b border-border" : ""}`}
      data-testid={`recipe-review-row-${product.id}`}
    >
      {/* Product name */}
      <td className="px-4 py-3 align-top">
        <div className="flex items-center gap-2">
          <div className="w-8 h-8 rounded border border-border bg-muted flex items-center justify-center shrink-0">
            {productImageUrl ? (
              <img
                src={productImageUrl}
                alt={product.name}
                className="w-full h-full object-cover rounded"
              />
            ) : (
              <ShoppingBag size={14} className="text-muted-foreground" />
            )}
          </div>
          <div className="min-w-0">
            <div className="font-medium truncate max-w-xs">{product.name}</div>
            {product.brand && (
              <div className="text-xs text-muted-foreground">{product.brand}</div>
            )}
          </div>
        </div>
      </td>

      {/* Recipe status */}
      <td className="px-4 py-3 align-top">
        {!summaryAvailable ? (
          <span className="text-xs text-muted-foreground italic">Unknown</span>
        ) : hasNoRecipe ? (
          <Badge variant="outline" className="text-amber-700 border-amber-300 text-[10px] dark:text-amber-300 dark:border-amber-700">
            No recipe
          </Badge>
        ) : (
          <Badge variant="outline" className="text-emerald-700 border-emerald-300 text-[10px] dark:text-emerald-300 dark:border-emerald-700">
            Recipe set
          </Badge>
        )}
      </td>

      {/* Suggestion status */}
      <td className="px-4 py-3 align-top">
        {pendingSuggestion ? (
          <div className="flex items-center gap-1.5 flex-wrap">
            <span className="inline-flex items-center gap-1 rounded-full bg-primary/10 text-primary px-2 py-0.5 text-[10px] font-medium">
              <Sparkles size={10} />
              v{pendingSuggestion.version} · Awaiting review
            </span>
            {confidenceLevel && (
              <span className="inline-flex items-center gap-0.5">
                <ConfidencePip confidence={confidenceLevel} />
                <span className="text-[10px] text-muted-foreground capitalize">{confidenceLevel}</span>
              </span>
            )}
          </div>
        ) : (
          <span className="text-xs text-muted-foreground">None</span>
        )}
      </td>

      {/* Action */}
      <td className="px-4 py-3 align-top text-right">
        <Link
          href={`/products/${product.id}?tab=recipe`}
          data-testid={`recipe-review-open-${product.id}`}
        >
          <Button variant="ghost" size="sm" className="gap-1.5 text-xs opacity-70 group-hover:opacity-100">
            {pendingSuggestion ? "Review suggestion" : "View recipe"}
            <ArrowRight size={12} />
          </Button>
        </Link>
      </td>
    </tr>
  );
}

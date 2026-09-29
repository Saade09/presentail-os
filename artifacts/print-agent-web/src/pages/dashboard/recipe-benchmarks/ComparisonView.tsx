import type {
  FormatMetric,
  RecipeBenchmarkComparisonResponse,
  RecipeBenchmarkResponse,
} from "@/hooks/use-recipe-benchmarks";
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from "@/components/ui/accordion";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import {
  AlertCircle,
  AlertTriangle,
  ArrowRight,
  CheckCircle2,
  Minus,
  ShieldCheck,
  TrendingDown,
  TrendingUp,
} from "lucide-react";

interface ComparisonViewProps {
  comparison: RecipeBenchmarkComparisonResponse;
}

type Trend = "up" | "down" | "flat" | "unknown";

function percentage(value: number | null | undefined) {
  return typeof value === "number" ? `${(value * 100).toFixed(1)}%` : "Not scored";
}

function decimalDelta(baseline: number | null | undefined, candidate: number | null | undefined) {
  if (typeof baseline !== "number" || typeof candidate !== "number") {
    return { trend: "unknown" as const, label: "Not comparable" };
  }
  const value = candidate - baseline;
  return {
    trend: value > 0 ? "up" as const : value < 0 ? "down" as const : "flat" as const,
    label: `${value > 0 ? "+" : ""}${(value * 100).toFixed(1)} pp`,
  };
}

function numberDelta(baseline: number | null | undefined, candidate: number | null | undefined) {
  if (typeof baseline !== "number" || typeof candidate !== "number") return "Not comparable";
  const value = candidate - baseline;
  return `${value > 0 ? "+" : ""}${value.toFixed(2)}`;
}

function formatGroups(response: RecipeBenchmarkResponse) {
  return response.run.metrics?.regression_gate_inputs?.canonical_format_groups
    ?? response.run.metrics?.canonical_format_groups
    ?? [];
}

function formatKey(metric: FormatMetric) {
  return `${metric.format ?? "Unspecified format"} / ${metric.category ?? "Uncategorized"}`;
}

function trendBadge(trend: Trend, lowerIsBetter = false) {
  if (trend === "unknown") return <Badge variant="outline">Not comparable</Badge>;
  if (trend === "flat") return <Badge variant="outline"><Minus className="mr-1 size-3" />No change</Badge>;
  const positive = lowerIsBetter ? trend === "down" : trend === "up";
  return (
    <Badge
      variant="outline"
      className={positive
        ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300"
        : "border-rose-500/30 bg-rose-500/10 text-rose-700 dark:text-rose-300"}
    >
      {trend === "up" ? <TrendingUp className="mr-1 size-3" /> : <TrendingDown className="mr-1 size-3" />}
      {positive ? "Improved" : "Regressed"}
    </Badge>
  );
}

function readableReason(reason: string) {
  const labels: Record<string, string> = {
    base_item_f1_worse: "Base Item F1 decreased",
    full_recipe_exact_match_worse: "Exact Recipe accuracy decreased",
    quantity_accuracy_worse: "Quantity accuracy decreased",
    missing_baseline_group: "Format is absent from the baseline",
    missing_current_group: "Format is absent from the candidate",
  };
  return labels[reason] ?? reason.replaceAll("_", " ");
}

export function ComparisonView({ comparison }: ComparisonViewProps) {
  const {
    baseline,
    candidate,
    comparability,
    regression_gate: regressionGate,
    canonical_failures: canonicalFailures,
  } = comparison;
  const baselineF1 = baseline.run.metrics?.canonical_metrics?.base_item_resolution?.f1;
  const candidateF1 = candidate.run.metrics?.canonical_metrics?.base_item_resolution?.f1;
  const f1Delta = decimalDelta(baselineF1, candidateF1);
  const baselineBurden = baseline.run.metrics?.estimated_manual_review_burden?.canonical;
  const candidateBurden = candidate.run.metrics?.estimated_manual_review_burden?.canonical;
  const burdenDelta = decimalDelta(baselineBurden?.review_rate, candidateBurden?.review_rate);
  const editsDelta = numberDelta(
    baselineBurden?.average_edits_per_product,
    candidateBurden?.average_edits_per_product,
  );

  const baselineFormats = new Map(formatGroups(baseline).map((metric) => [formatKey(metric), metric]));
  const candidateFormats = new Map(formatGroups(candidate).map((metric) => [formatKey(metric), metric]));
  const formatRows = [...new Set([...baselineFormats.keys(), ...candidateFormats.keys()])]
    .sort()
    .map((key) => {
      const before = baselineFormats.get(key);
      const after = candidateFormats.get(key);
      const f1 = decimalDelta(before?.base_item_f1, after?.base_item_f1);
      const exact = decimalDelta(before?.full_recipe_exact_match?.accuracy, after?.full_recipe_exact_match?.accuracy);
      const quantity = decimalDelta(before?.quantity_accuracy?.accuracy, after?.quantity_accuracy?.accuracy);
      const persistedFlag = (regressionGate.flagged_formats ?? []).find((flag) =>
        `${flag.format ?? "Unspecified format"} / ${flag.category ?? "Uncategorized"}` === key);
      const regressed = comparability.comparable
        && (persistedFlag?.reasons ?? []).some((reason) => reason.endsWith("_worse"));
      return { key, before, after, f1, exact, quantity, regressed };
    });

  const persistedFlags = regressionGate.flagged_formats ?? [];
  const gateStatus = comparability.comparable ? regressionGate.status : "incomparable";
  const candidateFailures = [...canonicalFailures]
    .sort((left, right) =>
      right.stages.reduce((sum, stage) => sum + stage.affected_requirements.length, 0)
      - left.stages.reduce((sum, stage) => sum + stage.affected_requirements.length, 0))
    .slice(0, 6);
  const exclusionKey = (exclusion: NonNullable<RecipeBenchmarkResponse["run"]["exclusions"]>[number]) =>
    `${exclusion.product_id ?? "unknown"}|${exclusion.reason ?? exclusion.classification ?? "Excluded"}`;
  const baselineExclusions = new Map((baseline.run.exclusions ?? []).map((exclusion) => [exclusionKey(exclusion), exclusion]));
  const candidateExclusions = new Map((candidate.run.exclusions ?? []).map((exclusion) => [exclusionKey(exclusion), exclusion]));
  const exclusionRows = [...new Set([...baselineExclusions.keys(), ...candidateExclusions.keys()])]
    .sort()
    .map((key) => ({
      key,
      before: baselineExclusions.get(key),
      after: candidateExclusions.get(key),
    }));

  return (
    <div className="mx-auto max-w-7xl space-y-5 pb-12 animate-in fade-in slide-in-from-bottom-2 duration-300" data-testid="container-comparison-view">
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border bg-card px-5 py-3 shadow-sm">
        <div className="flex items-center gap-3 text-sm">
          <Badge variant="outline" data-testid="text-baseline-run">Run #{baseline.run.id}</Badge>
          <ArrowRight className="size-4 text-muted-foreground" aria-hidden="true" />
          <Badge variant="outline" data-testid="text-candidate-run">Run #{candidate.run.id}</Badge>
          <span className="text-muted-foreground">
            {baseline.run.engine_version} → {candidate.run.engine_version}
          </span>
        </div>
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <ShieldCheck className="size-4 text-primary" aria-hidden="true" />
          Immutable reports · decision support only
        </div>
      </div>

      <div className="grid gap-4 md:grid-cols-3">
        <Card data-testid="card-regression-gate">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm text-muted-foreground">Regression gate</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="flex items-center gap-2" data-testid={`status-regression-gate-${gateStatus}`}>
              {gateStatus === "pass" ? (
                <><CheckCircle2 className="size-5 text-emerald-600" /><span className="text-xl font-bold text-emerald-700 dark:text-emerald-300">Passed</span></>
              ) : gateStatus === "flagged" ? (
                <><AlertCircle className="size-5 text-rose-600" /><span className="text-xl font-bold text-rose-700 dark:text-rose-300">Flagged</span></>
              ) : (
                <><AlertTriangle className="size-5 text-amber-600" /><span className="text-xl font-bold text-amber-700 dark:text-amber-300">Incomparable</span></>
              )}
            </div>
            <p className="mt-2 text-xs text-muted-foreground">
              {gateStatus === "pass"
                ? "No per-format regression was detected."
                : gateStatus === "flagged"
                  ? `${persistedFlags.length} format group(s) need review.`
                  : "Cohort or immutable-input drift prevents a valid gate decision."}
            </p>
          </CardContent>
        </Card>

        <Card data-testid="card-accuracy-f1">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm text-muted-foreground">Canonical Base Item F1</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="flex items-end gap-3">
              <span className="text-2xl font-bold" data-testid="text-accuracy-candidate">{percentage(candidateF1)}</span>
              <span className="mb-1 text-sm text-muted-foreground" data-testid="text-accuracy-baseline">from {percentage(baselineF1)}</span>
            </div>
            <div className="mt-2 flex items-center gap-2" data-testid="text-accuracy-delta">
              <span className="text-xs font-medium">{comparability.comparable ? f1Delta.label : "Suppressed"}</span>
              {comparability.comparable && trendBadge(f1Delta.trend)}
            </div>
          </CardContent>
        </Card>

        <Card data-testid="card-review-burden">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm text-muted-foreground">Estimated review burden</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="flex items-end gap-3">
              <span className="text-2xl font-bold" data-testid="text-burden-candidate">{percentage(candidateBurden?.review_rate)}</span>
              <span className="mb-1 text-sm text-muted-foreground" data-testid="text-burden-baseline">from {percentage(baselineBurden?.review_rate)}</span>
            </div>
            <div className="mt-2 flex items-center gap-2" data-testid="text-burden-delta">
              <span className="text-xs font-medium">{comparability.comparable ? burdenDelta.label : "Suppressed"}</span>
              {comparability.comparable && trendBadge(burdenDelta.trend, true)}
            </div>
            <p className="mt-2 text-xs text-muted-foreground" data-testid="text-edits-delta">
              Avg. edits: {candidateBurden?.average_edits_per_product ?? "—"} ({comparability.comparable ? editsDelta : "not comparable"})
            </p>
          </CardContent>
        </Card>
      </div>

      {!comparability.comparable && (
        <div className="rounded-xl border border-amber-500/30 bg-amber-500/10 p-4" role="alert" data-testid="status-incomparable-reasons">
          <div className="flex items-start gap-3">
            <AlertTriangle className="mt-0.5 size-5 shrink-0 text-amber-700 dark:text-amber-300" />
            <div>
              <h2 className="font-semibold text-amber-900 dark:text-amber-100">These runs cannot produce a valid regression decision</h2>
              <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-amber-900/80 dark:text-amber-100/80">
                {comparability.reasons.map((reason) => <li key={reason}>{reason}</li>)}
              </ul>
            </div>
          </div>
        </div>
      )}

      <Card className="overflow-hidden">
        <Accordion type="multiple" defaultValue={["formats", "confidence", "burden", "exclusions", "failures"]}>
          <AccordionItem value="formats">
            <AccordionTrigger className="px-6">Per-format performance</AccordionTrigger>
            <AccordionContent className="px-6 pb-6">
              {(comparability.missing_baseline_format_groups.length > 0
                || comparability.missing_candidate_format_groups.length > 0
                || comparability.changed_format_groups.length > 0) && (
                <div className="mb-4 rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-sm text-amber-900 dark:text-amber-100" data-testid="status-format-group-drift">
                  {comparability.missing_baseline_format_groups.length > 0 && (
                    <p>Missing from baseline: {comparability.missing_baseline_format_groups.join(", ")}</p>
                  )}
                  {comparability.missing_candidate_format_groups.length > 0 && (
                    <p>Missing from candidate: {comparability.missing_candidate_format_groups.join(", ")}</p>
                  )}
                  {comparability.changed_format_groups.length > 0 && (
                    <p>Changed format coverage: {comparability.changed_format_groups.join(", ")}</p>
                  )}
                </div>
              )}
              <div className="overflow-x-auto rounded-lg border">
                <Table>
                  <TableHeader className="bg-muted/40">
                    <TableRow>
                      <TableHead>Format / category</TableHead>
                      <TableHead>Products</TableHead>
                      <TableHead>Base Item F1</TableHead>
                      <TableHead>Exact Recipe</TableHead>
                      <TableHead>Quantity</TableHead>
                      <TableHead>Status</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {formatRows.map((row) => (
                      <TableRow key={row.key} className={row.regressed ? "bg-rose-500/5" : undefined} data-testid={`row-format-${row.key}`}>
                        <TableCell className="font-medium">{row.key}</TableCell>
                        <TableCell>{row.after?.scored_product_count ?? "—"}</TableCell>
                        <TableCell>{percentage(row.before?.base_item_f1)} → <strong>{percentage(row.after?.base_item_f1)}</strong></TableCell>
                        <TableCell>{percentage(row.before?.full_recipe_exact_match?.accuracy)} → <strong>{percentage(row.after?.full_recipe_exact_match?.accuracy)}</strong></TableCell>
                        <TableCell>{percentage(row.before?.quantity_accuracy?.accuracy)} → <strong>{percentage(row.after?.quantity_accuracy?.accuracy)}</strong></TableCell>
                        <TableCell>{comparability.comparable ? trendBadge(row.regressed ? "down" : row.f1.trend) : <Badge variant="outline">Incomparable</Badge>}</TableCell>
                      </TableRow>
                    ))}
                    {formatRows.length === 0 && (
                      <TableRow><TableCell colSpan={6} className="py-8 text-center text-muted-foreground">No canonical format groups were scored.</TableCell></TableRow>
                    )}
                  </TableBody>
                </Table>
              </div>
              {comparability.comparable && persistedFlags.length > 0 && (
                <div className="mt-4 space-y-2" data-testid="list-persisted-flags">
                  {persistedFlags.map((flag) => (
                    <div key={`${flag.format}/${flag.category}`} className="rounded-md border border-rose-500/20 bg-rose-500/5 px-3 py-2 text-sm">
                      <strong>{flag.format} / {flag.category}</strong>
                      <span className="ml-2 text-muted-foreground">{(flag.reasons ?? []).map(readableReason).join(" · ")}</span>
                    </div>
                  ))}
                </div>
              )}
            </AccordionContent>
          </AccordionItem>

          <AccordionItem value="confidence">
            <AccordionTrigger className="px-6">Confidence-band accuracy</AccordionTrigger>
            <AccordionContent className="px-6 pb-6">
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
                {["high", "medium", "low", "ambiguous", "no_match"].map((band) => {
                  const before = baseline.run.metrics?.confidence_calibration?.bands?.[band];
                  const after = candidate.run.metrics?.confidence_calibration?.bands?.[band];
                  if (!before && !after) return null;
                  const delta = decimalDelta(before?.accuracy, after?.accuracy);
                  return (
                    <div key={band} className="rounded-lg border bg-muted/20 p-4" data-testid={`card-confidence-${band}`}>
                      <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">{band.replace("_", " ")}</span>
                      <div className="mt-2 text-xl font-bold">{percentage(after?.accuracy)}</div>
                      <div className="mt-1 text-xs text-muted-foreground">from {percentage(before?.accuracy)} · n={after?.evaluated ?? 0}</div>
                      <div className="mt-2">{comparability.comparable && trendBadge(delta.trend)}</div>
                    </div>
                  );
                })}
              </div>
            </AccordionContent>
          </AccordionItem>

          <AccordionItem value="burden">
            <AccordionTrigger className="px-6">Review burden detail</AccordionTrigger>
            <AccordionContent className="px-6 pb-6">
              <Table>
                <TableHeader><TableRow><TableHead>Measure</TableHead><TableHead>Baseline</TableHead><TableHead>Candidate</TableHead><TableHead>Delta</TableHead></TableRow></TableHeader>
                <TableBody>
                  <TableRow>
                    <TableCell>Products requiring review</TableCell>
                    <TableCell>{baselineBurden?.products_requiring_review ?? "—"} / {baselineBurden?.product_denominator ?? "—"}</TableCell>
                    <TableCell>{candidateBurden?.products_requiring_review ?? "—"} / {candidateBurden?.product_denominator ?? "—"}</TableCell>
                    <TableCell>{comparability.comparable ? burdenDelta.label : "Suppressed"}</TableCell>
                  </TableRow>
                  <TableRow>
                    <TableCell>Average estimated edits per product</TableCell>
                    <TableCell>{baselineBurden?.average_edits_per_product ?? "—"}</TableCell>
                    <TableCell>{candidateBurden?.average_edits_per_product ?? "—"}</TableCell>
                    <TableCell>{comparability.comparable ? editsDelta : "Suppressed"}</TableCell>
                  </TableRow>
                </TableBody>
              </Table>
            </AccordionContent>
          </AccordionItem>

          <AccordionItem value="exclusions">
            <AccordionTrigger className="px-6">Exclusions</AccordionTrigger>
            <AccordionContent className="px-6 pb-6">
              <div className="mb-4 flex items-center gap-5 text-sm">
                <span>Baseline <strong>{baseline.run.exclusions?.length ?? 0}</strong></span>
                <ArrowRight className="size-4 text-muted-foreground" />
                <span>Candidate <strong>{candidate.run.exclusions?.length ?? 0}</strong></span>
              </div>
              {exclusionRows.length > 0 ? (
                <Table>
                  <TableHeader><TableRow><TableHead>Product</TableHead><TableHead>Reason</TableHead><TableHead>Baseline detail</TableHead><TableHead>Candidate detail</TableHead><TableHead>Change</TableHead></TableRow></TableHeader>
                  <TableBody>
                    {exclusionRows.map(({ key, before, after }) => (
                      <TableRow key={key} data-testid={`row-exclusion-${after?.product_id ?? before?.product_id ?? key}`}>
                        <TableCell>#{after?.product_id ?? before?.product_id ?? "—"}</TableCell>
                        <TableCell><Badge variant="secondary">{after?.reason ?? before?.reason ?? after?.classification ?? before?.classification ?? "Excluded"}</Badge></TableCell>
                        <TableCell className="text-muted-foreground">{before?.rationale ?? (before ? "No additional detail" : "Not excluded")}</TableCell>
                        <TableCell className="text-muted-foreground">{after?.rationale ?? (after ? "No additional detail" : "Not excluded")}</TableCell>
                        <TableCell>
                          {!before ? <Badge className="bg-amber-600">Added</Badge>
                            : !after ? <Badge variant="outline">Removed</Badge>
                              : <Badge variant="secondary">Unchanged</Badge>}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              ) : <p className="text-sm text-muted-foreground">Neither run recorded exclusions.</p>}
            </AccordionContent>
          </AccordionItem>

          <AccordionItem value="failures" className="border-b-0">
            <AccordionTrigger className="px-6">Representative failures</AccordionTrigger>
            <AccordionContent className="px-6 pb-6">
              {candidateFailures.length > 0 ? (
                <div className="grid gap-3 lg:grid-cols-2">
                  {candidateFailures.map((result) => (
                      <div key={result.product_id} className="rounded-lg border bg-muted/10 p-4" data-testid={`card-failure-${result.product_id}`}>
                      <div className="flex items-start justify-between gap-3">
                        <div>
                            <h3 className="font-semibold">{result.product_name ?? `Product #${result.product_id}`}</h3>
                            <p className="text-xs text-muted-foreground">{result.canonical_format ?? "Unknown format"} · {result.category ?? "Uncategorized"}</p>
                        </div>
                          <Badge variant="outline">Canonical semantic gold</Badge>
                      </div>
                        <div className="mt-3 space-y-2 text-sm">
                          {result.stages.map((stage) => (
                            <div key={stage.stage} className="flex flex-wrap items-center gap-2">
                              <Badge variant="secondary">{readableReason(stage.stage)}</Badge>
                              <span className="text-xs text-muted-foreground">
                                {stage.affected_requirements.length} affected requirement{stage.affected_requirements.length === 1 ? "" : "s"}
                              </span>
                            </div>
                          ))}
                        </div>
                    </div>
                  ))}
                </div>
              ) : <p className="text-sm text-muted-foreground">No persisted canonical semantic failures were recorded for this candidate run.</p>}
            </AccordionContent>
          </AccordionItem>
        </Accordion>
      </Card>
    </div>
  );
}
import { useEffect, useMemo, useState } from "react";
import { useLocation, useSearch } from "wouter";
import {
  useRecipeBenchmarkComparison,
  useRecipeBenchmarkRuns,
} from "@/hooks/use-recipe-benchmarks";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { AlertTriangle, ArrowRight, FlaskConical, Info } from "lucide-react";
import { ComparisonView } from "./recipe-benchmarks/ComparisonView";

function parseRunId(value: string | null) {
  const id = Number(value);
  return Number.isInteger(id) && id > 0 ? id : null;
}

function runLabel(id: number, completedAt: string | null, engineVersion: string) {
  const completed = completedAt
    ? new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(completedAt))
    : "Completion time unavailable";
  return `Run #${id} · ${completed} · ${engineVersion}`;
}

export default function RecipeBenchmarksPage() {
  const [, setLocation] = useLocation();
  const searchString = useSearch();
  const params = useMemo(() => new URLSearchParams(searchString), [searchString]);
  const baselineId = parseRunId(params.get("baseline"));
  const candidateId = parseRunId(params.get("candidate"));
  const [selectedBaseline, setSelectedBaseline] = useState(baselineId ? String(baselineId) : "");
  const [selectedCandidate, setSelectedCandidate] = useState(candidateId ? String(candidateId) : "");

  const runsQuery = useRecipeBenchmarkRuns();
  const runs = runsQuery.data?.runs ?? [];
  const completedRunIds = useMemo(() => new Set(runs.map((run) => run.id)), [runs]);
  const validatedBaselineId = runsQuery.data && baselineId && completedRunIds.has(baselineId) ? baselineId : null;
  const validatedCandidateId = runsQuery.data && candidateId && completedRunIds.has(candidateId) ? candidateId : null;
  const comparisonQuery = useRecipeBenchmarkComparison(validatedBaselineId, validatedCandidateId);
  const invalidUrlSelection = Boolean(
    runsQuery.data
    && ((baselineId && !validatedBaselineId) || (candidateId && !validatedCandidateId)),
  );

  useEffect(() => {
    setSelectedBaseline(baselineId ? String(baselineId) : "");
    setSelectedCandidate(candidateId ? String(candidateId) : "");
  }, [baselineId, candidateId]);

  const compare = () => {
    if (!selectedBaseline || !selectedCandidate || selectedBaseline === selectedCandidate) return;
    setLocation(`/recipe-benchmarks?baseline=${selectedBaseline}&candidate=${selectedCandidate}`);
  };

  const loadingReport = comparisonQuery.isLoading;
  const reportError = comparisonQuery.error;

  return (
    <div className="flex h-full flex-col bg-slate-50/70 dark:bg-zinc-950/50">
        <header className="sticky top-0 z-10 border-b bg-card px-6 py-4 shadow-sm">
          <div className="mx-auto flex max-w-7xl flex-wrap items-end justify-between gap-5">
            <div>
              <div className="mb-1 flex items-center gap-2 text-primary">
                <FlaskConical className="size-5" aria-hidden="true" />
                <span className="text-xs font-semibold uppercase tracking-[0.18em]">Read-only analysis</span>
              </div>
              <h1 className="text-xl font-semibold tracking-tight">Recipe benchmark comparison</h1>
              <p className="mt-1 text-sm text-muted-foreground">
                Compare immutable completed runs. This page cannot change rules or learning state.
              </p>
            </div>

            <div className="flex flex-wrap items-end gap-3" data-testid="form-compare-benchmarks">
              <div className="space-y-1.5">
                <label className="text-xs font-medium text-muted-foreground" htmlFor="baseline-run">
                  Baseline
                </label>
                <Select value={selectedBaseline} onValueChange={setSelectedBaseline}>
                  <SelectTrigger id="baseline-run" className="w-[290px] bg-background" data-testid="select-baseline-run">
                    <SelectValue placeholder="Select a completed run" />
                  </SelectTrigger>
                  <SelectContent>
                    {runs.map((run) => (
                      <SelectItem
                        key={run.id}
                        value={String(run.id)}
                        disabled={String(run.id) === selectedCandidate}
                        data-testid={`option-baseline-run-${run.id}`}
                      >
                        {runLabel(run.id, run.completed_at, run.engine_version)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <ArrowRight className="mb-2.5 size-4 text-muted-foreground" aria-hidden="true" />
              <div className="space-y-1.5">
                <label className="text-xs font-medium text-muted-foreground" htmlFor="candidate-run">
                  Candidate
                </label>
                <Select value={selectedCandidate} onValueChange={setSelectedCandidate}>
                  <SelectTrigger id="candidate-run" className="w-[290px] bg-background" data-testid="select-candidate-run">
                    <SelectValue placeholder="Select a completed run" />
                  </SelectTrigger>
                  <SelectContent>
                    {runs.map((run) => (
                      <SelectItem
                        key={run.id}
                        value={String(run.id)}
                        disabled={String(run.id) === selectedBaseline}
                        data-testid={`option-candidate-run-${run.id}`}
                      >
                        {runLabel(run.id, run.completed_at, run.engine_version)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <Button
                type="button"
                className="h-10 px-5"
                disabled={!selectedBaseline || !selectedCandidate || selectedBaseline === selectedCandidate}
                onClick={compare}
                data-testid="button-compare-runs"
              >
                Compare runs
              </Button>
            </div>
          </div>
        </header>

        <main className="flex-1 overflow-auto p-6">
          {runsQuery.isLoading ? (
            <div className="mx-auto mt-16 flex max-w-md flex-col items-center gap-3 text-muted-foreground" data-testid="status-runs-loading">
              <div className="size-6 animate-spin rounded-full border-2 border-primary border-t-transparent" />
              <span className="text-sm font-medium">Loading completed runs…</span>
            </div>
          ) : runsQuery.isError ? (
            <div className="mx-auto mt-12 flex max-w-2xl items-start gap-3 rounded-lg border border-destructive/20 bg-destructive/10 p-4 text-destructive" role="alert" data-testid="status-runs-error">
              <AlertTriangle className="mt-0.5 size-5" />
              <div>
                <h2 className="text-sm font-semibold">Could not load benchmark runs</h2>
                <p className="mt-1 text-sm opacity-90">Check your Product access and try again.</p>
              </div>
            </div>
          ) : runs.length < 2 ? (
            <div className="mx-auto mt-16 max-w-md rounded-xl border bg-card p-7 text-center shadow-sm" data-testid="status-insufficient-runs">
              <Info className="mx-auto mb-3 size-6 text-muted-foreground" />
              <h2 className="font-semibold">Two completed runs are required</h2>
              <p className="mt-2 text-sm text-muted-foreground">
                This read-only view will become available after another benchmark report is completed.
              </p>
            </div>
          ) : invalidUrlSelection ? (
            <div className="mx-auto mt-12 flex max-w-2xl items-start gap-3 rounded-lg border border-amber-500/30 bg-amber-500/10 p-4 text-amber-900 dark:text-amber-100" role="alert" data-testid="status-invalid-run-selection">
              <AlertTriangle className="mt-0.5 size-5" />
              <div>
                <h2 className="text-sm font-semibold">A selected report is not available</h2>
                <p className="mt-1 text-sm opacity-90">Only completed Recipe benchmark runs in this workspace can be compared.</p>
              </div>
            </div>
          ) : loadingReport ? (
            <div className="mx-auto mt-16 flex max-w-md flex-col items-center gap-3 text-muted-foreground" data-testid="status-comparison-loading">
              <div className="size-6 animate-spin rounded-full border-2 border-primary border-t-transparent" />
              <span className="text-sm font-medium">Loading comparison…</span>
            </div>
          ) : reportError ? (
            <div className="mx-auto mt-12 flex max-w-2xl items-start gap-3 rounded-lg border border-destructive/20 bg-destructive/10 p-4 text-destructive" role="alert" data-testid="status-comparison-error">
              <AlertTriangle className="mt-0.5 size-5" />
              <div>
                <h2 className="text-sm font-semibold">Could not load the selected reports</h2>
                <p className="mt-1 text-sm opacity-90">Choose two completed runs you are authorized to view.</p>
              </div>
            </div>
          ) : comparisonQuery.data ? (
            <ComparisonView comparison={comparisonQuery.data} />
          ) : (
            <div className="mx-auto mt-16 max-w-md rounded-xl border bg-card p-7 text-center shadow-sm" data-testid="status-no-selection">
              <Info className="mx-auto mb-3 size-6 text-muted-foreground" />
              <h2 className="font-semibold">Select two completed runs</h2>
              <p className="mt-2 text-sm text-muted-foreground">
                Pick a baseline and candidate above to inspect accuracy, review burden, drift, and failures.
              </p>
            </div>
          )}
        </main>
    </div>
  );
}
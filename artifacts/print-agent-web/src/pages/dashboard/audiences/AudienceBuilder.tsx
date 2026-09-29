import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useLocation } from "wouter";
import { useQueryClient } from "@tanstack/react-query";
import {
  useCreateAudience,
  useUpdateAudience,
  usePreviewAudience,
  usePreviewAudienceContacts,
  useGetAudienceFields,
  useListAudiences,
  useGenerateAudience,
  getListAudiencesQueryKey,
  getGetAudienceFieldsQueryKey,
  getGetAudiencesSummaryQueryKey,
  getGetAudienceQueryKey,
  type Audience,
  type AudienceMetrics,
  type AudienceMatchedContact,
  type AudienceRuleCondition,
  type AudienceRuleTree,
} from "@workspace/api-client-react";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Spinner } from "@/components/ui/spinner";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { useToast } from "@/hooks/use-toast";
import { AlertTriangle, ChevronDown, ChevronRight, RefreshCw, Sparkles, Zap } from "lucide-react";
import { cn } from "@/lib/utils";
import { RuleGroupEditor, type GroupOps } from "./RuleGroupEditor";
import {
  addCondition, addNestedGroup, createRequestTracker, defaultExclusions,
  describeTree, duplicateCondition, emptyTree, groupIsEmpty, moveCondition,
  newCondition, removeCondition, removeNestedGroup, replaceCondition,
  setGroupLogic, validateTree, type GroupPath,
} from "./ruleUtils";

export type BuilderState =
  | { mode: "create"; prefill?: { name?: string; description?: string; rules?: AudienceRuleTree } }
  | { mode: "edit"; audience: Audience };

type PreviewData = {
  metrics: AudienceMetrics;
  summary?: string;
  contacts: AudienceMatchedContact[];
};

function contactName(c: AudienceMatchedContact): string {
  return (
    (c.displayName ?? "").trim() ||
    `${c.firstName ?? ""} ${c.lastName ?? ""}`.trim() ||
    c.email ||
    c.phone ||
    "Unnamed contact"
  );
}

function WhyIncluded({ contact }: { contact: AudienceMatchedContact }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="text-xs">
      <button
        type="button"
        className="text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        data-testid={`button-why-included-${contact.id}`}
      >
        {open ? "Hide details" : "Why included?"}
      </button>
      {open && (
        <ul className="mt-1 space-y-0.5 text-muted-foreground" data-testid={`why-included-${contact.id}`}>
          {contact.evidence.map((ev, i) => (
            <li key={i} className={cn(ev.matched ? "text-emerald-700" : "text-muted-foreground")}>
              {ev.matched ? "✓" : "•"} {ev.field.replace(/_/g, " ")} {ev.operator.replace(/_/g, " ")}
              {ev.value != null ? ` ${Array.isArray(ev.value) ? ev.value.join(", ") : String(ev.value)}` : ""}
              {ev.actual != null ? ` (actual: ${String(ev.actual)})` : ""}
            </li>
          ))}
          {contact.nearMissExclusions.length > 0 && (
            <li className="text-amber-600">
              Close to exclusion: {contact.nearMissExclusions.map((e) => e.field.replace(/_/g, " ")).join(", ")}
            </li>
          )}
        </ul>
      )}
    </div>
  );
}

export function PreviewPanel({
  status,
  data,
  onRetry,
  invalidCount,
}: {
  status: "idle" | "loading" | "ready" | "error" | "invalid";
  data: PreviewData | null;
  onRetry: () => void;
  invalidCount?: number;
}) {
  return (
    <div className="rounded-lg border bg-card p-4 space-y-3" data-testid="preview-panel" aria-live="polite">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold">Live preview</h3>
        <span className="text-[11px] text-muted-foreground">Estimates — refreshed as you edit</span>
      </div>
      {status === "invalid" && (
        <p className="text-sm text-muted-foreground" data-testid="preview-invalid">
          {invalidCount
            ? `Fix ${invalidCount} rule issue${invalidCount === 1 ? "" : "s"} to see the preview.`
            : "Add at least one condition to see who matches."}
        </p>
      )}
      {status === "loading" && (
        <div className="flex items-center gap-2 text-sm text-muted-foreground" data-testid="preview-loading">
          <Spinner className="size-4" /> Calculating…
        </div>
      )}
      {status === "error" && (
        <div className="space-y-2" data-testid="preview-error">
          <p className="text-sm text-destructive">Could not calculate the preview.</p>
          <Button type="button" variant="outline" size="sm" onClick={onRetry}>
            <RefreshCw size={13} className="me-1.5" /> Retry
          </Button>
        </div>
      )}
      {status === "ready" && data && (
        <>
          <div className="grid grid-cols-2 gap-2">
            <div className="rounded-md bg-muted/50 p-2.5">
              <p className="text-[11px] text-muted-foreground">Matching contacts</p>
              <p className="text-xl font-bold" data-testid="preview-matched">
                {data.metrics.matched.toLocaleString()}
              </p>
            </div>
            <div className="rounded-md bg-muted/50 p-2.5">
              <p className="text-[11px] text-muted-foreground">Excluded</p>
              <p className="text-xl font-bold">{data.metrics.excluded.toLocaleString()}</p>
            </div>
          </div>
          <div className="grid grid-cols-3 gap-2 text-center">
            <div>
              <p className="text-sm font-semibold">{data.metrics.emailReachable.toLocaleString()}</p>
              <p className="text-[11px] text-muted-foreground">Email reachable</p>
            </div>
            <div>
              <p className="text-sm font-semibold">{data.metrics.whatsappReachable.toLocaleString()}</p>
              <p className="text-[11px] text-muted-foreground">WhatsApp reachable</p>
            </div>
            <div>
              <p className="text-sm font-semibold">{data.metrics.bothReachable.toLocaleString()}</p>
              <p className="text-[11px] text-muted-foreground">Both</p>
            </div>
          </div>
          {data.metrics.avgLifetimeSpendUsd != null && (
            <p className="text-xs text-muted-foreground">
              Average lifetime spend:{" "}
              <span className="font-medium text-foreground">
                ${data.metrics.avgLifetimeSpendUsd.toLocaleString(undefined, { maximumFractionDigits: 2 })}
              </span>
            </p>
          )}
          {data.metrics.matched === 0 ? (
            <p className="text-sm text-amber-600" data-testid="preview-zero-match">
              No contacts match these rules yet. You can still save this as a draft.
            </p>
          ) : (
            <div className="space-y-2 pt-1 border-t">
              <p className="text-xs font-medium text-muted-foreground">Sample contacts</p>
              {data.contacts.slice(0, 5).map((c) => (
                <div key={c.id} className="space-y-0.5" data-testid={`preview-contact-${c.id}`}>
                  <p className="text-sm font-medium">{contactName(c)}</p>
                  <WhyIncluded contact={c} />
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}

export default function AudienceBuilder({
  state,
  onClose,
  onSaved,
}: {
  state: BuilderState | null;
  onClose: () => void;
  onSaved?: (audience: Audience, action: "draft" | "save" | "campaign") => void;
}) {
  const open = state != null;
  const { toast } = useToast();
  const qc = useQueryClient();
  const [, setLocation] = useLocation();

  const { data: fieldsData } = useGetAudienceFields({ query: { enabled: open, queryKey: getGetAudienceFieldsQueryKey() } });
  const fields = useMemo(() => fieldsData?.fields ?? [], [fieldsData]);

  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [tree, setTree] = useState<AudienceRuleTree>(emptyTree);
  const [exclusionsOpen, setExclusionsOpen] = useState(false);
  const [zeroMatchConfirm, setZeroMatchConfirm] = useState<null | "save" | "campaign">(null);

  // ── AI generation ─────────────────────────────────────────────────────
  const [aiOpen, setAiOpen] = useState(false);
  const [aiPrompt, setAiPrompt] = useState("");
  const [aiError, setAiError] = useState<string | null>(null);
  const generateMutation = useGenerateAudience();

  const AI_PROMPT_MAX = 500;

  async function handleAiGenerate() {
    if (!aiPrompt.trim()) return;
    setAiError(null);
    try {
      const result = await generateMutation.mutateAsync({ data: { prompt: aiPrompt.trim() } });
      setTree((prev) => ({ ...prev, include: result.rules.include }));
      setAiOpen(false);
      setAiPrompt("");
    } catch (e) {
      setAiError(e instanceof Error ? e.message : "Failed to generate rules. Please try again.");
    }
  }

  // Reset form whenever the drawer opens with new state.
  useEffect(() => {
    if (!state) return;
    if (state.mode === "edit") {
      setName(state.audience.name);
      setDescription(state.audience.description ?? "");
      setTree(state.audience.rules ?? emptyTree());
    } else {
      setName(state.prefill?.name ?? "");
      setDescription(state.prefill?.description ?? "");
      setTree(state.prefill?.rules ?? emptyTree());
    }
    setExclusionsOpen(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state]);

  // Duplicate-name warning
  const nameSearchParams = { search: name.trim(), limit: 20 };
  const { data: existingList } = useListAudiences(nameSearchParams, {
    query: {
      enabled: open && name.trim().length > 1,
      queryKey: getListAudiencesQueryKey(nameSearchParams),
    },
  });
  const duplicateName = useMemo(() => {
    const n = name.trim().toLowerCase();
    if (!n) return false;
    return (existingList?.audiences ?? []).some(
      (a) =>
        a.name.trim().toLowerCase() === n &&
        (state?.mode !== "edit" || a.id !== state.audience.id),
    );
  }, [existingList, name, state]);

  const issues = useMemo(() => validateTree(tree, fields), [tree, fields]);
  const rulesValid = issues.length === 0 && !groupIsEmpty(tree.include);
  const summaryText = useMemo(() => describeTree(tree, fields), [tree, fields]);

  // ── Live preview with debounce + stale-response discarding ────────────
  const previewMutation = usePreviewAudience();
  const previewContactsMutation = usePreviewAudienceContacts();
  const trackerRef = useRef(createRequestTracker());
  const [previewStatus, setPreviewStatus] = useState<
    "idle" | "loading" | "ready" | "error" | "invalid"
  >("idle");
  const [previewData, setPreviewData] = useState<PreviewData | null>(null);

  const runPreview = useCallback(
    async (rules: AudienceRuleTree) => {
      const ticket = trackerRef.current.next();
      setPreviewStatus("loading");
      try {
        const [metricsRes, contactsRes] = await Promise.all([
          previewMutation.mutateAsync({ data: { rules } }),
          previewContactsMutation.mutateAsync({ data: { rules, page: 1, limit: 5 } }),
        ]);
        if (!trackerRef.current.isCurrent(ticket)) return;
        setPreviewData({
          metrics: metricsRes.metrics,
          summary: metricsRes.summary,
          contacts: contactsRes.contacts,
        });
        setPreviewStatus("ready");
      } catch {
        if (!trackerRef.current.isCurrent(ticket)) return;
        setPreviewStatus("error");
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  useEffect(() => {
    if (!open) return;
    if (fields.length === 0) return;
    if (!rulesValid) {
      trackerRef.current.next(); // invalidate in-flight responses
      setPreviewStatus("invalid");
      return;
    }
    const t = setTimeout(() => void runPreview(tree), 500);
    return () => clearTimeout(t);
  }, [open, tree, rulesValid, fields.length, runPreview]);

  // ── Group edit operations ──────────────────────────────────────────────
  const makeOps = useCallback(
    (which: "include" | "exclude"): GroupOps => {
      const apply = (fn: (g: NonNullable<AudienceRuleTree["exclude"]>) => NonNullable<AudienceRuleTree["exclude"]>) =>
        setTree((prev) => {
          const root = which === "include" ? prev.include : prev.exclude ?? defaultExclusions();
          const next = fn(root);
          return which === "include" ? { ...prev, include: next } : { ...prev, exclude: next };
        });
      return {
        onLogicChange: (path: GroupPath, logic) => apply((r) => setGroupLogic(r, path, logic)),
        onAddCondition: (path) => apply((r) => addCondition(r, path, newCondition())),
        onRemoveCondition: (path, i) => apply((r) => removeCondition(r, path, i)),
        onDuplicateCondition: (path, i) => apply((r) => duplicateCondition(r, path, i)),
        onMoveCondition: (path, i, dir) => apply((r) => moveCondition(r, path, i, dir)),
        onConditionChange: (path, i, c: AudienceRuleCondition) =>
          apply((r) => replaceCondition(r, path, i, c)),
        onAddGroup: (path) => apply((r) => addNestedGroup(r, path)),
        onRemoveGroup: (path, i) => apply((r) => removeNestedGroup(r, path, i)),
      };
    },
    [],
  );
  const includeOps = useMemo(() => makeOps("include"), [makeOps]);
  const excludeOps = useMemo(() => makeOps("exclude"), [makeOps]);

  // ── Saving ────────────────────────────────────────────────────────────
  const createMutation = useCreateAudience();
  const updateMutation = useUpdateAudience();
  const saving = createMutation.isPending || updateMutation.isPending;

  const invalidateLists = () => {
    void qc.invalidateQueries({ queryKey: [getListAudiencesQueryKey()[0]] });
    void qc.invalidateQueries({ queryKey: getGetAudiencesSummaryQueryKey() });
  };

  async function persist(status: "draft" | "active"): Promise<Audience | null> {
    if (!name.trim()) {
      toast({ title: "Give the audience a name first.", variant: "destructive" });
      return null;
    }
    if (!rulesValid) {
      toast({ title: "Fix the rule issues before saving.", variant: "destructive" });
      return null;
    }
    try {
      if (state?.mode === "edit") {
        const res = await updateMutation.mutateAsync({
          id: state.audience.id,
          data: { name: name.trim(), description: description.trim() || undefined, status, rules: tree },
        });
        invalidateLists();
        void qc.invalidateQueries({ queryKey: getGetAudienceQueryKey(state.audience.id) });
        return res.audience;
      }
      const res = await createMutation.mutateAsync({
        data: {
          name: name.trim(),
          description: description.trim() || undefined,
          kind: "dynamic",
          status,
          rules: tree,
        },
      });
      invalidateLists();
      return res.audience;
    } catch (e) {
      toast({ title: e instanceof Error ? e.message : "Failed to save audience", variant: "destructive" });
      return null;
    }
  }

  async function handleSave(action: "draft" | "save" | "campaign") {
    // Activating (or campaigning on) a zero-match audience gets a warning first.
    if (action !== "draft" && previewStatus === "ready" && previewData?.metrics.matched === 0) {
      setZeroMatchConfirm(action);
      return;
    }
    await doSave(action);
  }

  async function doSave(action: "draft" | "save" | "campaign") {
    const audience = await persist(action === "draft" ? "draft" : "active");
    if (!audience) return;
    toast({ title: action === "draft" ? "Draft saved" : "Audience saved" });
    onSaved?.(audience, action);
    onClose();
    if (action === "campaign") {
      setLocation(
        `/occasion-campaigns?tab=plans&create=1&audience_id=${encodeURIComponent(audience.id)}&audience_name=${encodeURIComponent(audience.name)}`,
      );
    }
  }

  return (
    <>
      <Sheet open={open} onOpenChange={(v) => !v && onClose()}>
        <SheetContent
          side="right"
          className="w-full sm:max-w-full lg:max-w-[1100px] overflow-y-auto p-0"
          data-testid="audience-builder"
        >
          <div className="p-6 space-y-5">
            <SheetHeader className="space-y-1 text-left">
              <div className="flex items-center gap-2">
                <SheetTitle>
                  {state?.mode === "edit" ? "Edit audience" : "New dynamic audience"}
                </SheetTitle>
                <Badge className="bg-teal-100 text-teal-800 hover:bg-teal-100 gap-1">
                  <Zap size={11} /> Updates automatically
                </Badge>
              </div>
              <SheetDescription>
                Dynamic audiences re-evaluate their rules automatically — contacts flow in and out
                as their data changes.
              </SheetDescription>
            </SheetHeader>

            <div className="grid grid-cols-1 lg:grid-cols-[1fr_340px] gap-6">
              <div className="space-y-5 min-w-0">
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <div className="space-y-1.5">
                    <Label htmlFor="audience-name">Name *</Label>
                    <Input
                      id="audience-name"
                      data-testid="input-audience-name"
                      placeholder="e.g. Lapsed high-value gift senders"
                      value={name}
                      onChange={(e) => setName(e.target.value)}
                    />
                    {duplicateName && (
                      <p className="text-xs text-amber-600 flex items-center gap-1" data-testid="warning-duplicate-name">
                        <AlertTriangle size={12} /> An audience with this name already exists.
                      </p>
                    )}
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="audience-description">Description</Label>
                    <Textarea
                      id="audience-description"
                      data-testid="input-audience-description"
                      placeholder="What is this audience for?"
                      value={description}
                      onChange={(e) => setDescription(e.target.value)}
                      rows={1}
                    />
                  </div>
                </div>

                <div className="space-y-2">
                  <div className="flex items-center justify-between">
                    <h3 className="text-sm font-semibold">Include contacts matching</h3>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="h-7 gap-1.5 text-xs text-muted-foreground hover:text-foreground"
                      onClick={() => { setAiOpen(true); setAiError(null); }}
                      data-testid="button-generate-with-ai"
                    >
                      <Sparkles size={13} className="text-violet-500" />
                      Generate with AI
                    </Button>
                  </div>
                  <RuleGroupEditor group={tree.include} fields={fields} ops={includeOps} />
                </div>

                <div className="rounded-lg border">
                  <button
                    type="button"
                    className="w-full flex items-center gap-2 px-3 py-2.5 text-sm font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded-lg"
                    aria-expanded={exclusionsOpen}
                    onClick={() => setExclusionsOpen((v) => !v)}
                    data-testid="button-toggle-exclusions"
                  >
                    {exclusionsOpen ? <ChevronDown size={15} /> : <ChevronRight size={15} />}
                    Exclusions
                    <span className="text-xs font-normal text-muted-foreground">
                      Globally unsubscribed and contacts without a valid email or phone are excluded
                      by default — expand to review or edit.
                    </span>
                  </button>
                  {exclusionsOpen && (
                    <div className="px-3 pb-3">
                      <RuleGroupEditor
                        group={tree.exclude ?? defaultExclusions()}
                        fields={fields}
                        ops={excludeOps}
                      />
                    </div>
                  )}
                </div>

                <div className="rounded-lg bg-muted/50 border p-3">
                  <p className="text-xs font-medium text-muted-foreground mb-1">In plain language</p>
                  <p className="text-sm" data-testid="rule-summary">{summaryText}</p>
                  {issues.length > 0 && !groupIsEmpty(tree.include) && (
                    <ul className="mt-2 space-y-0.5" data-testid="rule-issues">
                      {issues.slice(0, 4).map((iss, i) => (
                        <li key={i} className="text-xs text-destructive">{iss.message}</li>
                      ))}
                    </ul>
                  )}
                </div>
              </div>

              <div className="space-y-4 lg:sticky lg:top-6 self-start">
                <PreviewPanel
                  status={previewStatus}
                  data={previewData}
                  invalidCount={issues.length}
                  onRetry={() => void runPreview(tree)}
                />
                <div className="flex flex-col gap-2">
                  <Button
                    type="button"
                    onClick={() => void handleSave("save")}
                    disabled={saving}
                    data-testid="button-save-audience"
                  >
                    {saving ? "Saving…" : "Save audience"}
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => void handleSave("draft")}
                    disabled={saving}
                    data-testid="button-save-draft"
                  >
                    Save draft
                  </Button>
                  <Button
                    type="button"
                    variant="secondary"
                    onClick={() => void handleSave("campaign")}
                    disabled={saving}
                    data-testid="button-save-create-campaign"
                  >
                    Save &amp; create campaign
                  </Button>
                  <p className="text-[11px] text-muted-foreground">
                    Saving never sends anything — campaigns are planned separately.
                  </p>
                </div>
              </div>
            </div>
          </div>
        </SheetContent>
      </Sheet>

      {/* ── AI Generation Dialog ─────────────────────────────────────────── */}
      <Dialog open={aiOpen} onOpenChange={(v) => { if (!v && !generateMutation.isPending) { setAiOpen(false); setAiError(null); } }}>
        <DialogContent className="sm:max-w-md" data-testid="dialog-generate-ai">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Sparkles size={16} className="text-violet-500" />
              Generate with AI
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-3 py-1">
            <p className="text-sm text-muted-foreground">
              Describe the audience you want to target and AI will build the include rules for you.
            </p>
            <div className="space-y-1.5">
              <Textarea
                data-testid="input-ai-prompt"
                placeholder="e.g. VIP customers who sent gifts last Christmas but haven't ordered since"
                value={aiPrompt}
                onChange={(e) => setAiPrompt(e.target.value.slice(0, AI_PROMPT_MAX))}
                rows={3}
                autoFocus
                disabled={generateMutation.isPending}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) void handleAiGenerate();
                }}
              />
              <p className="text-[11px] text-muted-foreground text-right">
                {aiPrompt.length}/{AI_PROMPT_MAX}
              </p>
            </div>
            {aiError && (
              <p className="text-sm text-destructive" data-testid="ai-generate-error">{aiError}</p>
            )}
          </div>
          <DialogFooter className="gap-2">
            <Button
              type="button"
              variant="outline"
              onClick={() => { setAiOpen(false); setAiError(null); }}
              disabled={generateMutation.isPending}
            >
              Cancel
            </Button>
            <Button
              type="button"
              onClick={() => void handleAiGenerate()}
              disabled={!aiPrompt.trim() || generateMutation.isPending}
              data-testid="button-ai-generate-submit"
            >
              {generateMutation.isPending ? (
                <>
                  <Spinner className="size-4 me-1.5" /> Generating…
                </>
              ) : (
                <>
                  <Sparkles size={14} className="me-1.5" /> Generate
                </>
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <AlertDialog open={zeroMatchConfirm !== null} onOpenChange={(v) => !v && setZeroMatchConfirm(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>No contacts match yet</AlertDialogTitle>
            <AlertDialogDescription>
              This audience currently matches 0 contacts. You can save it as a draft, or activate it
              anyway — it will fill in automatically when contacts start matching.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep editing</AlertDialogCancel>
            <Button
              variant="outline"
              onClick={() => {
                setZeroMatchConfirm(null);
                void doSave("draft");
              }}
            >
              Save as draft
            </Button>
            <AlertDialogAction
              onClick={() => {
                const action = zeroMatchConfirm;
                setZeroMatchConfirm(null);
                if (action) void doSave(action);
              }}
            >
              Activate anyway
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

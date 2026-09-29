import { useState, useEffect } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useParams, useLocation } from "wouter";
import { ArrowLeft, Plus, X } from "lucide-react";
import { apiFetch } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { type Occasion, ALL_MARKETS } from "./OccasionCampaignCalendarPage";

type OccasionForm = {
  name: string;
  type: string;
  priority: "high" | "medium" | "low";
  status: "active" | "archived";
  markets: string[];
  product_focus: string;
  recommended_channels: string;
  campaign_start_days_before: string;
  month: string;
  day: string;
  notes: string;
  description: string;
  recurrence: "one_time" | "annual_fixed" | "annual_manual" | "religious_lunar";
  preparation_days: string;
  demand_level: string;
  tags: string;
};

const EMPTY_FORM: OccasionForm = {
  name: "", type: "seasonal", priority: "medium", status: "active",
  markets: [], product_focus: "", recommended_channels: "",
  campaign_start_days_before: "30", month: "", day: "",
  notes: "", description: "", recurrence: "annual_fixed",
  preparation_days: "", demand_level: "none", tags: "",
};

const RECURRENCE_OPTIONS = [
  { value: "annual_fixed", label: "Annual — fixed date" },
  { value: "annual_manual", label: "Annual — manual date" },
  { value: "religious_lunar", label: "Religious / Lunar calendar" },
  { value: "one_time", label: "One-time only" },
];

const PRIORITY_OPTIONS = [
  { value: "high", label: "High" },
  { value: "medium", label: "Medium" },
  { value: "low", label: "Low" },
];

const DEMAND_OPTIONS = ["very_high", "high", "medium", "low", "seasonal_peak"];
const OCCASION_TYPES = ["seasonal", "religious", "promotional", "personal", "corporate", "high_priority"];

export default function OccasionCampaignCreateEditPage() {
  const params = useParams<{ id?: string }>();
  const id = params.id ? parseInt(params.id, 10) : null;
  const isEdit = id !== null && !isNaN(id);
  const [, setLocation] = useLocation();
  const qc = useQueryClient();
  const { toast } = useToast();

  const [form, setForm] = useState<OccasionForm>(EMPTY_FORM);
  const [errors, setErrors] = useState<string[]>([]);
  const [tagInput, setTagInput] = useState("");

  const existingQuery = useQuery({
    queryKey: ["/api/occasion-campaigns/occasions", id],
    queryFn: () => apiFetch<{ occasion: Occasion }>(`/api/occasion-campaigns/occasions/${id!}`),
    enabled: isEdit,
  });

  useEffect(() => {
    if (existingQuery.data?.occasion) {
      const occ = existingQuery.data.occasion;
      setForm({
        name: occ.name,
        type: occ.type,
        priority: occ.priority as OccasionForm["priority"],
        status: occ.status as OccasionForm["status"],
        markets: occ.markets,
        product_focus: occ.product_focus ?? "",
        recommended_channels: occ.recommended_channels.join(", "),
        campaign_start_days_before: String(occ.campaign_start_days_before),
        month: occ.month ? String(occ.month) : "",
        day: occ.day ? String(occ.day) : "",
        notes: occ.notes ?? "",
        description: occ.description ?? "",
        recurrence: occ.recurrence as OccasionForm["recurrence"],
        preparation_days: occ.preparation_days ? String(occ.preparation_days) : "",
        demand_level: occ.demand_level ?? "none",
        tags: occ.tags.join(", "),
      });
    }
  }, [existingQuery.data]);

  const createMutation = useMutation({
    mutationFn: (data: object) =>
      apiFetch("/api/occasion-campaigns/occasions", { method: "POST", body: JSON.stringify(data) }),
    onSuccess: (data: { occasion: Occasion }) => {
      void qc.invalidateQueries({ queryKey: ["/api/occasion-campaigns/occasions"] });
      void qc.invalidateQueries({ queryKey: ["/api/occasion-campaigns/summary"] });
      toast({ title: "Occasion created" });
      setLocation(`/occasion-campaigns/occasions/${data.occasion.id}`);
    },
    onError: (e: Error) => setErrors([e.message]),
  });

  const updateMutation = useMutation({
    mutationFn: (data: object) =>
      apiFetch(`/api/occasion-campaigns/occasions/${id}`, { method: "PATCH", body: JSON.stringify(data) }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["/api/occasion-campaigns/occasions"] });
      void qc.invalidateQueries({ queryKey: ["/api/occasion-campaigns/occasions", id] });
      void qc.invalidateQueries({ queryKey: ["/api/occasion-campaigns/summary"] });
      toast({ title: "Occasion updated" });
      setLocation(`/occasion-campaigns/occasions/${id}`);
    },
    onError: (e: Error) => setErrors([e.message]),
  });

  function buildPayload() {
    const channels = form.recommended_channels
      .split(",").map((s) => s.trim()).filter(Boolean);
    const tags = form.tags
      .split(",").map((s) => s.trim()).filter(Boolean);
    return {
      name: form.name.trim(),
      type: form.type,
      priority: form.priority,
      status: form.status,
      markets: form.markets,
      product_focus: form.product_focus.trim() || null,
      recommended_channels: channels,
      campaign_start_days_before: parseInt(form.campaign_start_days_before, 10) || 30,
      month: form.month ? parseInt(form.month, 10) : null,
      day: form.day ? parseInt(form.day, 10) : null,
      notes: form.notes.trim() || null,
      description: form.description.trim() || null,
      recurrence: form.recurrence,
      preparation_days: form.preparation_days ? parseInt(form.preparation_days, 10) : null,
      demand_level: form.demand_level && form.demand_level !== "none" ? form.demand_level : null,
      tags,
    };
  }

  function handleSubmit() {
    const errs: string[] = [];
    if (!form.name.trim()) errs.push("Occasion name is required.");
    if (form.campaign_start_days_before && isNaN(parseInt(form.campaign_start_days_before, 10))) {
      errs.push("Campaign start days must be a number.");
    }
    if (errs.length > 0) { setErrors(errs); return; }
    setErrors([]);
    const payload = buildPayload();
    if (isEdit) updateMutation.mutate(payload);
    else createMutation.mutate(payload);
  }

  const isPending = createMutation.isPending || updateMutation.isPending;

  if (isEdit && existingQuery.isPending) {
    return (
      <div className="space-y-4">
        <div className="h-8 w-64 bg-muted animate-pulse rounded" />
        <div className="h-96 bg-muted animate-pulse rounded-lg" />
      </div>
    );
  }

  return (
    <div className="space-y-6 max-w-3xl">
      <div className="flex items-center gap-3">
        <Button variant="ghost" size="sm" onClick={() => setLocation("/occasion-campaigns")} className="-ml-2">
          <ArrowLeft size={14} className="mr-1.5" /> Occasion Campaigns
        </Button>
      </div>

      <div>
        <h1 className="text-2xl font-bold">{isEdit ? "Edit Occasion" : "Create Occasion"}</h1>
        <p className="text-muted-foreground mt-1 text-sm">
          {isEdit ? "Update occasion details." : "Add a new occasion to your campaign calendar."}
        </p>
      </div>

      <div className="space-y-6">
        {/* Core Info */}
        <Card>
          <CardHeader className="pb-2"><CardTitle className="text-base">Basic Information</CardTitle></CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="occ-name">Occasion name *</Label>
              <Input id="occ-name" placeholder="e.g. Mother's Day 2026"
                value={form.name} onChange={(e) => setForm((p) => ({ ...p, name: e.target.value }))} autoFocus />
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              <div className="space-y-1.5">
                <Label>Type</Label>
                <Select value={form.type} onValueChange={(v) => setForm((p) => ({ ...p, type: v }))}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {OCCASION_TYPES.map((t) => (
                      <SelectItem key={t} value={t}>{t.replace(/_/g, " ")}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label>Priority *</Label>
                <Select value={form.priority} onValueChange={(v) => setForm((p) => ({ ...p, priority: v as OccasionForm["priority"] }))}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {PRIORITY_OPTIONS.map((o) => <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label>Status</Label>
                <Select value={form.status} onValueChange={(v) => setForm((p) => ({ ...p, status: v as OccasionForm["status"] }))}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="active">Active</SelectItem>
                    <SelectItem value="archived">Archived</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div className="space-y-1.5">
              <Label>Description (optional)</Label>
              <Textarea placeholder="Describe this occasion…" value={form.description}
                onChange={(e) => setForm((p) => ({ ...p, description: e.target.value }))} rows={2} />
            </div>
          </CardContent>
        </Card>

        {/* Date & Recurrence */}
        <Card>
          <CardHeader className="pb-2"><CardTitle className="text-base">Date & Recurrence</CardTitle></CardHeader>
          <CardContent className="space-y-4">
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              <div className="space-y-1.5">
                <Label>Recurrence</Label>
                <Select value={form.recurrence} onValueChange={(v) => setForm((p) => ({ ...p, recurrence: v as OccasionForm["recurrence"] }))}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {RECURRENCE_OPTIONS.map((o) => <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="occ-month">Month (1–12)</Label>
                <Input id="occ-month" type="number" min="1" max="12" placeholder="e.g. 5"
                  value={form.month} onChange={(e) => setForm((p) => ({ ...p, month: e.target.value }))} />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="occ-day">Day (1–31)</Label>
                <Input id="occ-day" type="number" min="1" max="31" placeholder="e.g. 11"
                  value={form.day} onChange={(e) => setForm((p) => ({ ...p, day: e.target.value }))} />
              </div>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label htmlFor="occ-start-days">Campaign start (days before)</Label>
                <Input id="occ-start-days" type="number" min="1" placeholder="30"
                  value={form.campaign_start_days_before}
                  onChange={(e) => setForm((p) => ({ ...p, campaign_start_days_before: e.target.value }))} />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="occ-prep">Preparation days (optional)</Label>
                <Input id="occ-prep" type="number" min="1" placeholder="e.g. 7"
                  value={form.preparation_days}
                  onChange={(e) => setForm((p) => ({ ...p, preparation_days: e.target.value }))} />
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Markets */}
        <Card>
          <CardHeader className="pb-2"><CardTitle className="text-base">Markets</CardTitle></CardHeader>
          <CardContent>
            <div className="flex flex-wrap gap-2">
              {ALL_MARKETS.map((m) => (
                <button key={m} type="button"
                  onClick={() => setForm((p) => ({
                    ...p,
                    markets: p.markets.includes(m) ? p.markets.filter((x) => x !== m) : [...p.markets, m],
                  }))}
                  className={cn(
                    "px-3 py-1.5 rounded-full border text-sm font-medium transition-colors",
                    form.markets.includes(m)
                      ? "bg-primary text-primary-foreground border-primary"
                      : "border-border hover:bg-secondary",
                  )}>
                  {m}
                </button>
              ))}
            </div>
          </CardContent>
        </Card>

        {/* Campaign Details */}
        <Card>
          <CardHeader className="pb-2"><CardTitle className="text-base">Campaign Details</CardTitle></CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-1.5">
              <Label>Product focus (optional)</Label>
              <Input placeholder="e.g. Flowers, chocolates, gift sets"
                value={form.product_focus}
                onChange={(e) => setForm((p) => ({ ...p, product_focus: e.target.value }))} />
            </div>
            <div className="space-y-1.5">
              <Label>Recommended channels (comma-separated)</Label>
              <Input placeholder="e.g. Instagram, WhatsApp, Email"
                value={form.recommended_channels}
                onChange={(e) => setForm((p) => ({ ...p, recommended_channels: e.target.value }))} />
            </div>
            <div className="space-y-1.5">
              <Label>Demand level (optional)</Label>
              <Select value={form.demand_level} onValueChange={(v) => setForm((p) => ({ ...p, demand_level: v }))}>
                <SelectTrigger><SelectValue placeholder="Select demand level…" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">None</SelectItem>
                  {DEMAND_OPTIONS.map((o) => <SelectItem key={o} value={o}>{o.replace(/_/g, " ")}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label>Tags (comma-separated, optional)</Label>
              <Input placeholder="e.g. gifting, flowers, premium"
                value={form.tags}
                onChange={(e) => setForm((p) => ({ ...p, tags: e.target.value }))} />
            </div>
            <div className="space-y-1.5">
              <Label>Notes (optional)</Label>
              <Textarea placeholder="Additional notes about this occasion…"
                value={form.notes} onChange={(e) => setForm((p) => ({ ...p, notes: e.target.value }))} rows={3} />
            </div>
          </CardContent>
        </Card>

        {/* Error display */}
        {errors.length > 0 && (
          <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-4 space-y-1">
            {errors.map((e, i) => <p key={i} className="text-sm text-destructive">{e}</p>)}
          </div>
        )}

        {/* Actions */}
        <div className="flex items-center gap-3">
          <Button onClick={handleSubmit} disabled={isPending}>
            {isPending ? "Saving…" : isEdit ? "Save changes" : "Create occasion"}
          </Button>
          <Button variant="outline" onClick={() => setLocation("/occasion-campaigns")} disabled={isPending}>
            Cancel
          </Button>
        </div>
      </div>
    </div>
  );
}

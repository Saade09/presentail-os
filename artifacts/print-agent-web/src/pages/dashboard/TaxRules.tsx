import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Plus, Pencil, Trash2, ArrowLeft, Loader2, AlertCircle, Filter, Calculator } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { useToast } from "@/hooks/use-toast";
import { apiFetch } from "@/lib/queryClient";
import { Link } from "wouter";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Switch } from "@/components/ui/switch";
import { LocationCombobox } from "@/components/CreatePoWizard";
import { CountryCombobox } from "@/components/CountryCombobox";

type TaxRule = {
  id: string;
  workspace_owner_id: string;
  country_code: string;
  location_id: number | null;
  tax_category: string;
  rate_percent: number;
  effective_from: string;
  effective_to: string | null;
  is_active: boolean;
  description: string | null;
  created_at: string;
};

const TAX_CATEGORIES: { value: string; label: string }[] = [
  { value: "not_classified", label: "Not Classified" },
  { value: "standard_taxable", label: "Standard Taxable" },
  { value: "zero_rated", label: "Zero Rated" },
  { value: "exempt", label: "Exempt" },
  { value: "non_taxable", label: "Non-Taxable" },
  { value: "food_grocery", label: "Food & Grocery" },
  { value: "packaging", label: "Packaging" },
  { value: "service", label: "Service" },
  { value: "import_related", label: "Import-Related" },
];

type FormState = {
  country_code: string;
  tax_category: string;
  rate_percent: string;
  effective_from: string;
  effective_to: string;
  is_active: boolean;
  description: string;
};

const EMPTY_FORM: FormState = {
  country_code: "",
  tax_category: "standard_taxable",
  rate_percent: "",
  effective_from: new Date().toISOString().slice(0, 10),
  effective_to: "",
  is_active: true,
  description: "",
};

function taxCategoryLabel(code: string) {
  return TAX_CATEGORIES.find((c) => c.value === code)?.label ?? code;
}

const TAX_CATEGORY_VALUES = TAX_CATEGORIES.map((c) => c.value);

type FilterState = {
  country_code: string;
  tax_category: string;
  location_id: string;
};

const EMPTY_FILTERS: FilterState = {
  country_code: "",
  tax_category: "",
  location_id: "",
};

/**
 * Client-side mirror of the server's GET /tax-rules query-param validation.
 * Returns an inline error message so bad filters are caught before a request
 * is ever sent, instead of silently returning an empty list.
 */
function validateFilters(f: FilterState): string | null {
  const category = f.tax_category.trim();
  if (category && !TAX_CATEGORY_VALUES.includes(category)) {
    return `Tax category must be one of: ${TAX_CATEGORY_VALUES.join(", ")}`;
  }
  const locId = f.location_id.trim();
  if (locId && !/^\d+$/.test(locId)) {
    return "Location ID must be a whole number";
  }
  return null;
}

function buildFilterQuery(f: FilterState): string {
  const params = new URLSearchParams();
  if (f.country_code.trim()) params.set("country_code", f.country_code.trim().toUpperCase());
  if (f.tax_category.trim()) params.set("tax_category", f.tax_category.trim());
  if (f.location_id.trim()) params.set("location_id", f.location_id.trim());
  const qs = params.toString();
  return qs ? `?${qs}` : "";
}

type ResolveState = {
  tax_category: string;
  country_code: string;
  location_id: string;
  date: string;
};

const EMPTY_RESOLVE: ResolveState = {
  tax_category: "standard_taxable",
  country_code: "",
  location_id: "",
  date: "",
};

type ResolveResult = {
  rate_percent: string | null;
  resolved: boolean;
  location_id?: number | null;
};

/** Client-side mirror of GET /tax-rules/resolve param validation. */
function validateResolve(r: ResolveState): string | null {
  if (!r.tax_category.trim()) return "Tax category is required";
  if (!TAX_CATEGORY_VALUES.includes(r.tax_category.trim())) {
    return `Tax category must be one of: ${TAX_CATEGORY_VALUES.join(", ")}`;
  }
  if (!r.country_code.trim()) return "Country code is required";
  const locId = r.location_id.trim();
  if (locId && !/^\d+$/.test(locId)) return "Location ID must be a whole number";
  const date = r.date.trim();
  if (date && !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return "Date must be in YYYY-MM-DD format";
  }
  return null;
}

function buildResolveQuery(r: ResolveState): string {
  const params = new URLSearchParams();
  params.set("tax_category", r.tax_category.trim());
  params.set("country_code", r.country_code.trim().toUpperCase());
  if (r.location_id.trim()) params.set("location_id", r.location_id.trim());
  if (r.date.trim()) params.set("date", r.date.trim());
  return `?${params.toString()}`;
}

export default function TaxRulesPage() {
  const { toast } = useToast();
  const qc = useQueryClient();

  const [createOpen, setCreateOpen] = useState(false);
  const [editRule, setEditRule] = useState<TaxRule | null>(null);
  const [deleteRule, setDeleteRule] = useState<TaxRule | null>(null);
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [formError, setFormError] = useState<string | null>(null);

  const [filters, setFilters] = useState<FilterState>(EMPTY_FILTERS);
  const filterError = validateFilters(filters);
  const filtersActive = Boolean(
    filters.country_code.trim() || filters.tax_category.trim() || filters.location_id.trim(),
  );

  const { data, isLoading, isError, error } = useQuery<{ tax_rules: TaxRule[] }>({
    queryKey: ["tax-rules", filters],
    queryFn: () => apiFetch(`/api/tax-rules${buildFilterQuery(filters)}`),
    enabled: filterError === null,
  });

  const listServerError =
    isError && error instanceof Error ? error.message : null;

  const createMutation = useMutation({
    mutationFn: (body: object) =>
      apiFetch("/api/tax-rules", { method: "POST", body: JSON.stringify(body) }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["tax-rules"] });
      toast({ title: "Tax rule created" });
      setCreateOpen(false);
      setForm(EMPTY_FORM);
      setFormError(null);
    },
    onError: (err) => {
      setFormError(err instanceof Error ? err.message : "Failed to create rule");
    },
  });

  const updateMutation = useMutation({
    mutationFn: ({ id, body }: { id: string; body: object }) =>
      apiFetch(`/api/tax-rules/${id}`, { method: "PATCH", body: JSON.stringify(body) }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["tax-rules"] });
      toast({ title: "Tax rule updated" });
      setEditRule(null);
      setFormError(null);
    },
    onError: (err) => {
      setFormError(err instanceof Error ? err.message : "Failed to update rule");
    },
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) =>
      apiFetch(`/api/tax-rules/${id}`, { method: "DELETE" }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["tax-rules"] });
      toast({ title: "Tax rule deleted" });
      setDeleteRule(null);
    },
    onError: (err) => {
      toast({
        title: "Failed to delete",
        description: err instanceof Error ? err.message : undefined,
        variant: "destructive",
      });
    },
  });

  const [resolveForm, setResolveForm] = useState<ResolveState>(EMPTY_RESOLVE);
  const [resolveError, setResolveError] = useState<string | null>(null);
  const [resolveResult, setResolveResult] = useState<ResolveResult | null>(null);

  const resolveMutation = useMutation<ResolveResult, Error, ResolveState>({
    mutationFn: (r: ResolveState) => apiFetch(`/api/tax-rules/resolve${buildResolveQuery(r)}`),
    onSuccess: (result) => {
      setResolveResult(result);
      setResolveError(null);
    },
    onError: (err) => {
      setResolveResult(null);
      setResolveError(err instanceof Error ? err.message : "Failed to resolve tax rate");
    },
  });

  function handleResolve() {
    const err = validateResolve(resolveForm);
    if (err) {
      setResolveResult(null);
      setResolveError(err);
      return;
    }
    setResolveError(null);
    resolveMutation.mutate(resolveForm);
  }

  function openCreate() {
    setForm(EMPTY_FORM);
    setFormError(null);
    setCreateOpen(true);
  }

  function openEdit(rule: TaxRule) {
    setForm({
      country_code: rule.country_code.toLowerCase(),
      tax_category: rule.tax_category,
      rate_percent: String(rule.rate_percent),
      effective_from: rule.effective_from,
      effective_to: rule.effective_to ?? "",
      is_active: rule.is_active,
      description: rule.description ?? "",
    });
    setFormError(null);
    setEditRule(rule);
  }

  function validateForm(): string | null {
    if (!form.country_code.trim()) return "Country is required";
    if (!form.tax_category) return "Tax category is required";
    const rate = parseFloat(form.rate_percent);
    if (isNaN(rate) || rate < 0 || rate > 100) return "Rate must be a number between 0 and 100";
    if (!form.effective_from) return "Effective from date is required";
    return null;
  }

  function handleSubmitCreate() {
    const err = validateForm();
    if (err) { setFormError(err); return; }
    createMutation.mutate({
      country_code: form.country_code.trim().toUpperCase(),
      tax_category: form.tax_category,
      rate_percent: parseFloat(form.rate_percent),
      effective_from: form.effective_from,
      effective_to: form.effective_to || null,
      is_active: form.is_active,
      description: form.description.trim() || null,
    });
  }

  function handleSubmitEdit() {
    if (!editRule) return;
    const err = validateForm();
    if (err) { setFormError(err); return; }
    updateMutation.mutate({
      id: editRule.id,
      body: {
        country_code: form.country_code.trim().toUpperCase(),
        rate_percent: parseFloat(form.rate_percent),
        effective_from: form.effective_from,
        effective_to: form.effective_to || null,
        is_active: form.is_active,
        description: form.description.trim() || null,
      },
    });
  }

  const rules = data?.tax_rules ?? [];

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <Link href="/settings">
            <Button variant="ghost" size="sm" className="gap-1.5">
              <ArrowLeft size={14} />
              Settings
            </Button>
          </Link>
          <div>
            <h1 className="text-2xl font-bold tracking-tight">Tax Rules</h1>
            <p className="text-muted-foreground text-sm mt-0.5">
              Location-based tax rates applied to purchase orders and base item costs.
            </p>
          </div>
        </div>
        <Button onClick={openCreate} className="gap-1.5">
          <Plus size={15} />
          New Rule
        </Button>
      </div>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base flex items-center gap-1.5">
            <Filter size={15} />
            Filter rules
          </CardTitle>
          <CardDescription>
            Narrow the list by country, category, or location. Clear a field to remove its filter.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="filter-country">Country Code</Label>
              <Input
                id="filter-country"
                value={filters.country_code}
                onChange={(e) => setFilters((f) => ({ ...f, country_code: e.target.value.toUpperCase() }))}
                placeholder="All countries"
                maxLength={3}
                className="font-mono uppercase"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="filter-category">Tax Category</Label>
              <Input
                id="filter-category"
                value={filters.tax_category}
                onChange={(e) => setFilters((f) => ({ ...f, tax_category: e.target.value }))}
                placeholder="All categories"
                list="filter-category-options"
                aria-invalid={filterError?.startsWith("Tax category") ? true : undefined}
              />
              <datalist id="filter-category-options">
                {TAX_CATEGORIES.map((c) => (
                  <option key={c.value} value={c.value}>{c.label}</option>
                ))}
              </datalist>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="filter-location">Location</Label>
              <LocationCombobox
                value={filters.location_id.trim() ? Number(filters.location_id) : null}
                onChange={(id) =>
                  setFilters((f) => ({ ...f, location_id: id == null ? "" : String(id) }))
                }
                ariaLabel="Filter by location"
              />
            </div>
          </div>
          {filterError && (
            <p className="text-sm text-destructive flex items-center gap-1.5 mt-3">
              <AlertCircle size={13} />
              {filterError}
            </p>
          )}
        </CardContent>
      </Card>

      {isLoading && (
        <div className="flex items-center gap-2 text-sm text-muted-foreground py-8">
          <Loader2 size={16} className="animate-spin" />
          Loading tax rules…
        </div>
      )}

      {listServerError && (
        <div className="flex items-center gap-2 text-sm text-destructive py-4">
          <AlertCircle size={14} />
          {listServerError}
        </div>
      )}

      {!isLoading && !isError && !filterError && rules.length === 0 && (
        <Card>
          <CardContent className="py-12 text-center text-muted-foreground text-sm">
            {filtersActive
              ? "No tax rules match the current filters."
              : <>No tax rules defined yet. Click <strong>New Rule</strong> to add your first rule.</>}
          </CardContent>
        </Card>
      )}

      {rules.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">
              {rules.length} {rules.length === 1 ? "Rule" : "Rules"}
            </CardTitle>
            <CardDescription>
              Rules are matched by country and optionally by location. More specific (location-based) rules take precedence.
            </CardDescription>
          </CardHeader>
          <CardContent className="p-0">
            <div className="divide-y divide-border">
              {rules.map((rule) => (
                <div key={rule.id} className="flex items-start justify-between gap-4 px-6 py-4">
                  <div className="flex-1 min-w-0 space-y-1">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="font-medium text-sm">{taxCategoryLabel(rule.tax_category)}</span>
                      <Badge variant="outline" className="text-xs font-mono">{rule.country_code}</Badge>
                      {rule.location_id && (
                        <Badge variant="secondary" className="text-xs">Location #{rule.location_id}</Badge>
                      )}
                      {rule.is_active ? (
                        <Badge className="bg-green-100 text-green-700 border-0 text-xs">Active</Badge>
                      ) : (
                        <Badge variant="secondary" className="text-xs">Inactive</Badge>
                      )}
                    </div>
                    <p className="text-sm text-muted-foreground">
                      <span className="font-semibold text-foreground">{rule.rate_percent}%</span>
                      {" — "}
                      from {rule.effective_from}
                      {rule.effective_to ? ` to ${rule.effective_to}` : " (ongoing)"}
                    </p>
                    {rule.description && (
                      <p className="text-xs text-muted-foreground">{rule.description}</p>
                    )}
                  </div>
                  <div className="flex items-center gap-1 shrink-0">
                    <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => openEdit(rule)}>
                      <Pencil size={13} />
                    </Button>
                    <Button variant="ghost" size="icon" className="h-8 w-8 text-destructive hover:text-destructive" onClick={() => setDeleteRule(rule)}>
                      <Trash2 size={13} />
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base flex items-center gap-1.5">
            <Calculator size={15} />
            Resolve tax rate
          </CardTitle>
          <CardDescription>
            Preview which rate applies for a category, country, optional location, and date.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="resolve-category">Tax Category <span className="text-destructive">*</span></Label>
              <select
                id="resolve-category"
                value={resolveForm.tax_category}
                onChange={(e) => setResolveForm((r) => ({ ...r, tax_category: e.target.value }))}
                className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm focus:outline-none focus:ring-1 focus:ring-ring"
              >
                {TAX_CATEGORIES.map((c) => (
                  <option key={c.value} value={c.value}>{c.label}</option>
                ))}
              </select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="resolve-country">Country Code <span className="text-destructive">*</span></Label>
              <Input
                id="resolve-country"
                value={resolveForm.country_code}
                onChange={(e) => setResolveForm((r) => ({ ...r, country_code: e.target.value.toUpperCase() }))}
                placeholder="e.g. LB, AE, US"
                maxLength={3}
                className="font-mono uppercase"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="resolve-location">Location</Label>
              <LocationCombobox
                value={resolveForm.location_id.trim() ? Number(resolveForm.location_id) : null}
                onChange={(id) =>
                  setResolveForm((r) => ({ ...r, location_id: id == null ? "" : String(id) }))
                }
                ariaLabel="Resolve for location"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="resolve-date">As of date</Label>
              <Input
                id="resolve-date"
                type="date"
                value={resolveForm.date}
                onChange={(e) => setResolveForm((r) => ({ ...r, date: e.target.value }))}
                aria-invalid={resolveError?.startsWith("Date") ? true : undefined}
              />
            </div>
          </div>

          <div className="flex items-center gap-3">
            <Button onClick={handleResolve} disabled={resolveMutation.isPending} className="gap-1.5">
              {resolveMutation.isPending
                ? <><Loader2 size={14} className="animate-spin" />Resolving…</>
                : "Resolve"}
            </Button>
            {resolveResult && !resolveError && (
              resolveResult.resolved ? (
                <span className="text-sm">
                  Resolved rate:{" "}
                  <span className="font-semibold">{resolveResult.rate_percent}%</span>
                  {resolveResult.location_id != null
                    ? <> (Location #{resolveResult.location_id})</>
                    : <> (country-wide)</>}
                </span>
              ) : (
                <span className="text-sm text-muted-foreground">
                  No matching active rule for these inputs.
                </span>
              )
            )}
          </div>

          {resolveError && (
            <p className="text-sm text-destructive flex items-center gap-1.5">
              <AlertCircle size={13} />
              {resolveError}
            </p>
          )}
        </CardContent>
      </Card>

      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>New Tax Rule</DialogTitle>
          </DialogHeader>
          <TaxRuleForm form={form} setForm={setForm} formError={formError} />
          <DialogFooter>
            <Button variant="outline" onClick={() => setCreateOpen(false)}>Cancel</Button>
            <Button onClick={handleSubmitCreate} disabled={createMutation.isPending}>
              {createMutation.isPending ? <><Loader2 size={14} className="animate-spin mr-1.5" />Creating…</> : "Create Rule"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={editRule !== null} onOpenChange={(open) => { if (!open) setEditRule(null); }}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>Edit Tax Rule</DialogTitle>
          </DialogHeader>
          <TaxRuleForm form={form} setForm={setForm} formError={formError} editMode />
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditRule(null)}>Cancel</Button>
            <Button onClick={handleSubmitEdit} disabled={updateMutation.isPending}>
              {updateMutation.isPending ? <><Loader2 size={14} className="animate-spin mr-1.5" />Saving…</> : "Save Changes"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <AlertDialog open={deleteRule !== null} onOpenChange={(open) => { if (!open) setDeleteRule(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete Tax Rule?</AlertDialogTitle>
            <AlertDialogDescription>
              This will permanently delete the{" "}
              <strong>{deleteRule ? taxCategoryLabel(deleteRule.tax_category) : ""}</strong> rule
              for <strong>{deleteRule?.country_code}</strong>. This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={() => deleteRule && deleteMutation.mutate(deleteRule.id)}
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function TaxRuleForm({
  form,
  setForm,
  formError,
  editMode = false,
}: {
  form: FormState;
  setForm: React.Dispatch<React.SetStateAction<FormState>>;
  formError: string | null;
  editMode?: boolean;
}) {
  function set<K extends keyof FormState>(key: K, value: FormState[K]) {
    setForm((f) => ({ ...f, [key]: value }));
  }

  return (
    <div className="space-y-4">
      {!editMode && (
        <>
          <div className="space-y-1.5">
            <Label htmlFor="tr-country">Country <span className="text-destructive">*</span></Label>
            <CountryCombobox
              value={form.country_code.toLowerCase()}
              onChange={(code) => set("country_code", code)}
              placeholder="Select country…"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="tr-category">Tax Category <span className="text-destructive">*</span></Label>
            <select
              id="tr-category"
              value={form.tax_category}
              onChange={(e) => set("tax_category", e.target.value)}
              className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm focus:outline-none focus:ring-1 focus:ring-ring"
            >
              {TAX_CATEGORIES.map((c) => (
                <option key={c.value} value={c.value}>{c.label}</option>
              ))}
            </select>
          </div>
        </>
      )}

      {editMode && (
        <>
          <div className="space-y-1.5">
            <Label htmlFor="tr-country">Country <span className="text-destructive">*</span></Label>
            <CountryCombobox
              value={form.country_code.toLowerCase()}
              onChange={(code) => set("country_code", code)}
              placeholder="Select country…"
            />
          </div>
          <div className="rounded-md bg-muted px-4 py-3 text-sm space-y-1">
            <p className="font-medium">Tax category (read-only)</p>
            <p className="text-muted-foreground">
              {form.tax_category ? taxCategoryLabel(form.tax_category) : "—"}
            </p>
          </div>
        </>
      )}

      <div className="space-y-1.5">
        <Label htmlFor="tr-rate">Rate (%) <span className="text-destructive">*</span></Label>
        <Input
          id="tr-rate"
          type="number"
          min="0"
          max="100"
          step="0.01"
          value={form.rate_percent}
          onChange={(e) => set("rate_percent", e.target.value)}
          placeholder="e.g. 11"
        />
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-1.5">
          <Label htmlFor="tr-from">Effective From <span className="text-destructive">*</span></Label>
          <Input
            id="tr-from"
            type="date"
            value={form.effective_from}
            onChange={(e) => set("effective_from", e.target.value)}
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="tr-to">Effective To</Label>
          <Input
            id="tr-to"
            type="date"
            value={form.effective_to}
            onChange={(e) => set("effective_to", e.target.value)}
          />
        </div>
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="tr-desc">Description</Label>
        <Input
          id="tr-desc"
          value={form.description}
          onChange={(e) => set("description", e.target.value)}
          placeholder="Optional notes about this rule"
        />
      </div>

      <div className="flex items-center gap-3">
        <Switch
          id="tr-active"
          checked={form.is_active}
          onCheckedChange={(v) => set("is_active", v)}
        />
        <Label htmlFor="tr-active" className="cursor-pointer">Active</Label>
      </div>

      {formError && (
        <p className="text-sm text-destructive flex items-center gap-1.5">
          <AlertCircle size={13} />
          {formError}
        </p>
      )}
    </div>
  );
}

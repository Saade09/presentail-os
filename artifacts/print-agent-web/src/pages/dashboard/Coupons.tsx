import { useState, useMemo } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiFetch } from "@/lib/queryClient";
import { useWorkspaceRole } from "@/hooks/use-workspace-role";
import {
  useListOccasions,
  useListCatalogCategories,
  useListCatalogBrands,
  useListRecipients,
  getListOccasionsQueryKey,
  getListCatalogCategoriesQueryKey,
  getListCatalogBrandsQueryKey,
  getListRecipientsQueryKey,
} from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import { Ticket, Plus, Trash2, Pencil, Loader2 } from "lucide-react";
import { useTranslation } from "react-i18next";

type Coupon = {
  id: string;
  code: string;
  description: string | null;
  discountType: "percentage" | "fixed";
  discountValue: number;
  minOrderUsd: number | null;
  scope: "all" | "restricted";
  startsAt: string | null;
  expiresAt: string | null;
  perUserLimit: number | null;
  globalLimit: number | null;
  isActive: boolean;
  usedCount: number;
  productIds: number[];
  occasionIds: number[];
  categoryIds: number[];
  brandIds: number[];
  recipientIds: number[];
  excludedProductIds: number[];
  excludedOccasionIds: number[];
  excludedCategoryIds: number[];
  excludedBrandIds: number[];
  excludedRecipientIds: number[];
  createdAt: string;
  updatedAt: string;
};

type ProductLite = { id: number; name: string };

type FormState = {
  code: string;
  description: string;
  discountType: "percentage" | "fixed";
  discountValue: string;
  minOrderUsd: string;
  scope: "all" | "restricted";
  startsAt: string;
  expiresAt: string;
  perUserLimit: string;
  globalLimit: string;
  isActive: boolean;
  productIds: number[];
  occasionIds: number[];
  categoryIds: number[];
  brandIds: number[];
  recipientIds: number[];
  excludedProductIds: number[];
  excludedOccasionIds: number[];
  excludedCategoryIds: number[];
  excludedBrandIds: number[];
  excludedRecipientIds: number[];
};

function emptyForm(): FormState {
  return {
    code: "",
    description: "",
    discountType: "percentage",
    discountValue: "",
    minOrderUsd: "",
    scope: "all",
    startsAt: "",
    expiresAt: "",
    perUserLimit: "",
    globalLimit: "",
    isActive: true,
    productIds: [],
    occasionIds: [],
    categoryIds: [],
    brandIds: [],
    recipientIds: [],
    excludedProductIds: [],
    excludedOccasionIds: [],
    excludedCategoryIds: [],
    excludedBrandIds: [],
    excludedRecipientIds: [],
  };
}

function toLocalInput(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function fromLocalInput(local: string): string | null {
  if (!local) return null;
  const d = new Date(local);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString();
}

function formStateFromCoupon(c: Coupon): FormState {
  return {
    code: c.code,
    description: c.description ?? "",
    discountType: c.discountType,
    discountValue: String(c.discountValue),
    minOrderUsd: c.minOrderUsd != null ? String(c.minOrderUsd) : "",
    scope: c.scope,
    startsAt: toLocalInput(c.startsAt),
    expiresAt: toLocalInput(c.expiresAt),
    perUserLimit: c.perUserLimit != null ? String(c.perUserLimit) : "",
    globalLimit: c.globalLimit != null ? String(c.globalLimit) : "",
    isActive: c.isActive,
    productIds: [...c.productIds],
    occasionIds: [...c.occasionIds],
    categoryIds: [...c.categoryIds],
    brandIds: [...c.brandIds],
    recipientIds: [...c.recipientIds],
    excludedProductIds: [...(c.excludedProductIds ?? [])],
    excludedOccasionIds: [...(c.excludedOccasionIds ?? [])],
    excludedCategoryIds: [...(c.excludedCategoryIds ?? [])],
    excludedBrandIds: [...(c.excludedBrandIds ?? [])],
    excludedRecipientIds: [...(c.excludedRecipientIds ?? [])],
  };
}

type Option = { id: number; name: string };

function MultiSelectList({
  label,
  options,
  selected,
  onToggle,
}: {
  label: string;
  options: Option[];
  selected: number[];
  onToggle: (id: number) => void;
}) {
  const [q, setQ] = useState("");
  const filtered = useMemo(() => {
    const term = q.trim().toLowerCase();
    if (!term) return options;
    return options.filter((o) => o.name.toLowerCase().includes(term));
  }, [options, q]);
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <Label>{label}</Label>
        {selected.length > 0 && (
          <Badge variant="secondary">{selected.length}</Badge>
        )}
      </div>
      <Input
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder="Search…"
        className="h-8"
      />
      <div className="max-h-40 overflow-y-auto rounded-md border border-border divide-y divide-border">
        {filtered.length === 0 ? (
          <p className="px-3 py-2 text-xs text-muted-foreground">No options</p>
        ) : (
          filtered.map((o) => (
            <label
              key={o.id}
              className="flex items-center gap-2 px-3 py-2 text-sm cursor-pointer hover:bg-accent/50"
            >
              <input
                type="checkbox"
                checked={selected.includes(o.id)}
                onChange={() => onToggle(o.id)}
                className="h-4 w-4"
              />
              <span className="truncate">{o.name}</span>
            </label>
          ))
        )}
      </div>
    </div>
  );
}

export default function CouponsPage() {
  const { t } = useTranslation();
  const { toast } = useToast();
  const qc = useQueryClient();
  const { isOwner, allowedPages } = useWorkspaceRole();
  const canManage = isOwner || (allowedPages?.includes("coupons") ?? false);

  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<Coupon | null>(null);
  const [form, setForm] = useState<FormState>(emptyForm());
  const [deleteTarget, setDeleteTarget] = useState<Coupon | null>(null);

  const { data, isLoading } = useQuery({
    queryKey: ["coupons"],
    queryFn: () => apiFetch<{ coupons: Coupon[] }>("/api/coupons"),
    enabled: canManage,
  });
  const coupons = data?.coupons ?? [];

  const restricted = form.scope === "restricted";
  const { data: productsData } = useQuery({
    queryKey: ["coupons-products"],
    queryFn: () =>
      apiFetch<{ products: ProductLite[] }>("/api/products?pageSize=500"),
    enabled: canManage && dialogOpen,
  });
  const occasionsQ = useListOccasions(
    { pageSize: 100 },
    { query: { enabled: canManage && dialogOpen, queryKey: getListOccasionsQueryKey({ pageSize: 100 }) } },
  );
  const categoriesQ = useListCatalogCategories(
    { pageSize: 100 },
    { query: { enabled: canManage && dialogOpen, queryKey: getListCatalogCategoriesQueryKey({ pageSize: 100 }) } },
  );
  const brandsQ = useListCatalogBrands(
    { pageSize: 100 },
    { query: { enabled: canManage && dialogOpen, queryKey: getListCatalogBrandsQueryKey({ pageSize: 100 }) } },
  );
  const recipientsQ = useListRecipients(
    { pageSize: 100 },
    { query: { enabled: canManage && dialogOpen, queryKey: getListRecipientsQueryKey({ pageSize: 100 }) } },
  );

  const productOptions: Option[] = (productsData?.products ?? []).map((p) => ({ id: p.id, name: p.name }));
  const occasionOptions: Option[] = (occasionsQ.data?.items ?? []).map((o) => ({ id: o.id, name: o.name }));
  const categoryOptions: Option[] = (categoriesQ.data?.items ?? []).map((o) => ({ id: o.id, name: o.name }));
  const brandOptions: Option[] = (brandsQ.data?.items ?? []).map((o) => ({ id: o.id, name: o.name }));
  const recipientOptions: Option[] = (recipientsQ.data?.items ?? []).map((o) => ({ id: o.id, name: o.name }));

  const upsertMutation = useMutation({
    mutationFn: async () => {
      const discountValue = Number(form.discountValue);
      if (!form.code.trim()) throw new Error(t("coupons.errCodeRequired"));
      if (!Number.isFinite(discountValue) || discountValue <= 0) {
        throw new Error(t("coupons.errDiscountValue"));
      }
      if (form.discountType === "percentage" && discountValue > 100) {
        throw new Error(t("coupons.errPercentRange"));
      }
      const body: Record<string, unknown> = {
        code: form.code.trim(),
        description: form.description.trim() ? form.description.trim() : null,
        discountType: form.discountType,
        discountValue,
        minOrderUsd: form.minOrderUsd.trim() ? Number(form.minOrderUsd) : null,
        scope: form.scope,
        startsAt: fromLocalInput(form.startsAt),
        expiresAt: fromLocalInput(form.expiresAt),
        perUserLimit: form.perUserLimit.trim() ? Number(form.perUserLimit) : null,
        globalLimit: form.globalLimit.trim() ? Number(form.globalLimit) : null,
        isActive: form.isActive,
        productIds: restricted ? form.productIds : [],
        occasionIds: restricted ? form.occasionIds : [],
        categoryIds: restricted ? form.categoryIds : [],
        brandIds: restricted ? form.brandIds : [],
        recipientIds: restricted ? form.recipientIds : [],
        excludedProductIds: form.excludedProductIds,
        excludedOccasionIds: form.excludedOccasionIds,
        excludedCategoryIds: form.excludedCategoryIds,
        excludedBrandIds: form.excludedBrandIds,
        excludedRecipientIds: form.excludedRecipientIds,
      };
      if (editing) {
        return apiFetch<{ coupon: Coupon }>(`/api/coupons/${editing.id}`, {
          method: "PATCH",
          body: JSON.stringify(body),
        });
      }
      return apiFetch<{ coupon: Coupon }>("/api/coupons", {
        method: "POST",
        body: JSON.stringify(body),
      });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["coupons"] });
      setDialogOpen(false);
      setEditing(null);
      setForm(emptyForm());
      toast({
        title: editing ? t("coupons.updated") : t("coupons.created"),
      });
    },
    onError: (err: Error) => {
      toast({ title: t("coupons.saveFailed"), description: err.message, variant: "destructive" });
    },
  });

  const toggleMutation = useMutation({
    mutationFn: (c: Coupon) =>
      apiFetch<{ coupon: Coupon }>(`/api/coupons/${c.id}`, {
        method: "PATCH",
        body: JSON.stringify({ isActive: !c.isActive }),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["coupons"] }),
    onError: (err: Error) =>
      toast({ title: t("coupons.saveFailed"), description: err.message, variant: "destructive" }),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) =>
      apiFetch<{ success: boolean }>(`/api/coupons/${id}`, { method: "DELETE" }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["coupons"] });
      setDeleteTarget(null);
      toast({ title: t("coupons.deleted") });
    },
    onError: (err: Error) =>
      toast({ title: t("coupons.deleteFailed"), description: err.message, variant: "destructive" }),
  });

  function openCreate() {
    setEditing(null);
    setForm(emptyForm());
    setDialogOpen(true);
  }

  function openEdit(c: Coupon) {
    setEditing(c);
    setForm(formStateFromCoupon(c));
    setDialogOpen(true);
  }

  function toggleId(
    field: keyof Pick<FormState,
      | "productIds" | "occasionIds" | "categoryIds" | "brandIds" | "recipientIds"
      | "excludedProductIds" | "excludedOccasionIds" | "excludedCategoryIds" | "excludedBrandIds" | "excludedRecipientIds"
    >,
    id: number,
  ) {
    setForm((f) => {
      const set = new Set(f[field]);
      if (set.has(id)) set.delete(id);
      else set.add(id);
      return { ...f, [field]: Array.from(set) };
    });
  }

  function discountLabel(c: Coupon): string {
    return c.discountType === "percentage"
      ? `${c.discountValue}%`
      : `$${c.discountValue.toFixed(2)}`;
  }

  function fmtDate(iso: string | null): string | null {
    if (!iso) return null;
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return null;
    return d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
  }

  function validityLabel(c: Coupon): string {
    const from = fmtDate(c.startsAt);
    const until = fmtDate(c.expiresAt);
    if (from && until) return `${from} – ${until}`;
    if (from) return t("coupons.validityFrom", { date: from });
    if (until) return t("coupons.validityUntil", { date: until });
    return t("coupons.validityAlways");
  }

  if (!canManage) {
    return (
      <div className="p-6">
        <p className="text-sm text-muted-foreground">{t("coupons.noAccess")}</p>
      </div>
    );
  }

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold flex items-center gap-2">
            <Ticket className="h-6 w-6" />
            {t("coupons.title")}
          </h1>
          <p className="text-sm text-muted-foreground mt-1">{t("coupons.description")}</p>
        </div>
        <Button onClick={openCreate}>
          <Plus className="h-4 w-4 mr-2" />
          {t("coupons.create")}
        </Button>
      </div>

      {isLoading ? (
        <div className="flex items-center justify-center py-12">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </div>
      ) : coupons.length === 0 ? (
        <div className="rounded-lg border border-dashed border-border py-12 text-center">
          <p className="font-medium">{t("coupons.empty")}</p>
          <p className="text-sm text-muted-foreground mt-1">{t("coupons.emptyHint")}</p>
        </div>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-border">
          <table className="w-full text-sm">
            <thead className="bg-muted/50 text-left">
              <tr>
                <th className="px-4 py-3 font-medium">{t("coupons.colCode")}</th>
                <th className="px-4 py-3 font-medium">{t("coupons.colDiscount")}</th>
                <th className="px-4 py-3 font-medium">{t("coupons.colScope")}</th>
                <th className="px-4 py-3 font-medium">{t("coupons.colUsage")}</th>
                <th className="px-4 py-3 font-medium">{t("coupons.colValidity")}</th>
                <th className="px-4 py-3 font-medium">{t("coupons.colStatus")}</th>
                <th className="px-4 py-3 font-medium text-right">{t("coupons.colActions")}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {coupons.map((c) => (
                <tr key={c.id} className="hover:bg-accent/30">
                  <td className="px-4 py-3">
                    <div className="font-mono font-medium">{c.code}</div>
                    {c.description && (
                      <div className="text-xs text-muted-foreground">{c.description}</div>
                    )}
                  </td>
                  <td className="px-4 py-3">{discountLabel(c)}</td>
                  <td className="px-4 py-3">
                    <Badge variant={c.scope === "all" ? "secondary" : "outline"}>
                      {c.scope === "all" ? t("coupons.scopeAll") : t("coupons.scopeRestricted")}
                    </Badge>
                  </td>
                  <td className="px-4 py-3">
                    {c.usedCount}
                    {c.globalLimit != null ? ` / ${c.globalLimit}` : ""}
                  </td>
                  <td className="px-4 py-3 whitespace-nowrap text-xs">
                    {validityLabel(c)}
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-2">
                      <Switch
                        checked={c.isActive}
                        onCheckedChange={() => toggleMutation.mutate(c)}
                      />
                      <span className="text-xs text-muted-foreground">
                        {c.isActive ? t("coupons.statusActive") : t("coupons.statusInactive")}
                      </span>
                    </div>
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex items-center justify-end gap-2">
                      <Button variant="ghost" size="icon" onClick={() => openEdit(c)}>
                        <Pencil className="h-4 w-4" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        onClick={() => setDeleteTarget(c)}
                      >
                        <Trash2 className="h-4 w-4 text-destructive" />
                      </Button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>
              {editing ? t("coupons.editTitle") : t("coupons.createTitle")}
            </DialogTitle>
            <DialogDescription>{t("coupons.formDesc")}</DialogDescription>
          </DialogHeader>

          <div className="space-y-4">
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label>{t("coupons.fieldCode")}</Label>
                <Input
                  value={form.code}
                  onChange={(e) => setForm({ ...form, code: e.target.value })}
                  placeholder="WELCOME10"
                />
              </div>
              <div className="space-y-2 flex flex-col">
                <Label>{t("coupons.fieldActive")}</Label>
                <div className="flex items-center gap-2 h-9">
                  <Switch
                    checked={form.isActive}
                    onCheckedChange={(v) => setForm({ ...form, isActive: v })}
                  />
                  <span className="text-sm text-muted-foreground">
                    {form.isActive ? t("coupons.statusActive") : t("coupons.statusInactive")}
                  </span>
                </div>
              </div>
            </div>

            <div className="space-y-2">
              <Label>{t("coupons.fieldDescription")}</Label>
              <Textarea
                value={form.description}
                onChange={(e) => setForm({ ...form, description: e.target.value })}
                rows={2}
              />
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label>{t("coupons.fieldDiscountType")}</Label>
                <Select
                  value={form.discountType}
                  onValueChange={(v) =>
                    setForm({ ...form, discountType: v as "percentage" | "fixed" })
                  }
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="percentage">{t("coupons.typePercentage")}</SelectItem>
                    <SelectItem value="fixed">{t("coupons.typeFixed")}</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label>
                  {form.discountType === "percentage"
                    ? t("coupons.fieldPercent")
                    : t("coupons.fieldAmountUsd")}
                </Label>
                <Input
                  type="number"
                  value={form.discountValue}
                  onChange={(e) => setForm({ ...form, discountValue: e.target.value })}
                  min={0}
                  step="0.01"
                />
              </div>
            </div>

            <div className="grid grid-cols-3 gap-4">
              <div className="space-y-2">
                <Label>{t("coupons.fieldMinOrder")}</Label>
                <Input
                  type="number"
                  value={form.minOrderUsd}
                  onChange={(e) => setForm({ ...form, minOrderUsd: e.target.value })}
                  min={0}
                  step="0.01"
                  placeholder={t("coupons.optional")}
                />
              </div>
              <div className="space-y-2">
                <Label>{t("coupons.fieldPerUserLimit")}</Label>
                <Input
                  type="number"
                  value={form.perUserLimit}
                  onChange={(e) => setForm({ ...form, perUserLimit: e.target.value })}
                  min={1}
                  step="1"
                  placeholder={t("coupons.unlimited")}
                />
              </div>
              <div className="space-y-2">
                <Label>{t("coupons.fieldGlobalLimit")}</Label>
                <Input
                  type="number"
                  value={form.globalLimit}
                  onChange={(e) => setForm({ ...form, globalLimit: e.target.value })}
                  min={1}
                  step="1"
                  placeholder={t("coupons.unlimited")}
                />
              </div>
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label>{t("coupons.fieldStartsAt")}</Label>
                <Input
                  type="datetime-local"
                  value={form.startsAt}
                  onChange={(e) => setForm({ ...form, startsAt: e.target.value })}
                />
              </div>
              <div className="space-y-2">
                <Label>{t("coupons.fieldExpiresAt")}</Label>
                <Input
                  type="datetime-local"
                  value={form.expiresAt}
                  onChange={(e) => setForm({ ...form, expiresAt: e.target.value })}
                />
              </div>
            </div>

            <div className="space-y-2">
              <Label>{t("coupons.fieldScope")}</Label>
              <Select
                value={form.scope}
                onValueChange={(v) => setForm({ ...form, scope: v as "all" | "restricted" })}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">{t("coupons.scopeAll")}</SelectItem>
                  <SelectItem value="restricted">{t("coupons.scopeRestricted")}</SelectItem>
                </SelectContent>
              </Select>
            </div>

            {restricted && (
              <div className="space-y-4 rounded-lg border border-border p-4">
                <p className="text-sm font-medium">{t("coupons.inclusionsLabel")}</p>
                <p className="text-xs text-muted-foreground">{t("coupons.restrictedHint")}</p>
                <MultiSelectList
                  label={t("coupons.restrictProducts")}
                  options={productOptions}
                  selected={form.productIds}
                  onToggle={(id) => toggleId("productIds", id)}
                />
                <div className="grid grid-cols-2 gap-4">
                  <MultiSelectList
                    label={t("coupons.restrictOccasions")}
                    options={occasionOptions}
                    selected={form.occasionIds}
                    onToggle={(id) => toggleId("occasionIds", id)}
                  />
                  <MultiSelectList
                    label={t("coupons.restrictCategories")}
                    options={categoryOptions}
                    selected={form.categoryIds}
                    onToggle={(id) => toggleId("categoryIds", id)}
                  />
                  <MultiSelectList
                    label={t("coupons.restrictBrands")}
                    options={brandOptions}
                    selected={form.brandIds}
                    onToggle={(id) => toggleId("brandIds", id)}
                  />
                  <MultiSelectList
                    label={t("coupons.restrictRecipients")}
                    options={recipientOptions}
                    selected={form.recipientIds}
                    onToggle={(id) => toggleId("recipientIds", id)}
                  />
                </div>
              </div>
            )}

            <div className="space-y-4 rounded-lg border border-border p-4">
              <p className="text-sm font-medium">{t("coupons.exclusionsLabel")}</p>
              <p className="text-xs text-muted-foreground">{t("coupons.exclusionsHint")}</p>
              <MultiSelectList
                label={t("coupons.excludeProducts")}
                options={productOptions}
                selected={form.excludedProductIds}
                onToggle={(id) => toggleId("excludedProductIds", id)}
              />
              <div className="grid grid-cols-2 gap-4">
                <MultiSelectList
                  label={t("coupons.excludeOccasions")}
                  options={occasionOptions}
                  selected={form.excludedOccasionIds}
                  onToggle={(id) => toggleId("excludedOccasionIds", id)}
                />
                <MultiSelectList
                  label={t("coupons.excludeCategories")}
                  options={categoryOptions}
                  selected={form.excludedCategoryIds}
                  onToggle={(id) => toggleId("excludedCategoryIds", id)}
                />
                <MultiSelectList
                  label={t("coupons.excludeBrands")}
                  options={brandOptions}
                  selected={form.excludedBrandIds}
                  onToggle={(id) => toggleId("excludedBrandIds", id)}
                />
                <MultiSelectList
                  label={t("coupons.excludeRecipients")}
                  options={recipientOptions}
                  selected={form.excludedRecipientIds}
                  onToggle={(id) => toggleId("excludedRecipientIds", id)}
                />
              </div>
            </div>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setDialogOpen(false)}>
              {t("common.cancel")}
            </Button>
            <Button onClick={() => upsertMutation.mutate()} disabled={upsertMutation.isPending}>
              {upsertMutation.isPending && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
              {editing ? t("coupons.saveChanges") : t("coupons.createAction")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <AlertDialog open={!!deleteTarget} onOpenChange={(o) => !o && setDeleteTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("coupons.deleteTitle")}</AlertDialogTitle>
            <AlertDialogDescription>{t("coupons.deleteDesc")}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("common.cancel")}</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => deleteTarget && deleteMutation.mutate(deleteTarget.id)}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {t("coupons.deleteConfirm")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

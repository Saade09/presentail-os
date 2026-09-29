import { useState, useEffect } from "react";
import { Link } from "wouter";
import {
  useListBaseItemSuppliers,
  useCreateBaseItemSupplier,
  usePatchBaseItemSupplier,
  useDeleteBaseItemSupplier,
  useListBaseItemPackages,
  useListUoms,
  useListSuppliers,
  getListBaseItemSuppliersQueryKey,
} from "@workspace/api-client-react";
import type { BaseItemSupplier, BaseItemPackage, Supplier, Uom } from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, Check, ChevronsUpDown, Loader2, Plus, RotateCcw, Trash2, Store, Settings } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import { useWorkspaceRole } from "@/hooks/use-workspace-role";
import { taxNumberLabel } from "./Suppliers";
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

type RowEditState = {
  supplier_id: string;
  package_id: string;
  supplier_item_name: string;
  supplier_item_code: string;
  pricing_uom_code: string;
  pricing_uom_legacy: string;
  pricing_uom_touched: boolean;
  price: string;
  currency: string;
  is_preferred: boolean;
  is_default_order_unit: boolean;
  name_ar: string;
};

type NewRow = RowEditState & { _key: string };

function emptyRowState(): RowEditState {
  return {
    supplier_id: "",
    package_id: "",
    supplier_item_name: "",
    supplier_item_code: "",
    pricing_uom_code: "",
    pricing_uom_legacy: "",
    pricing_uom_touched: false,
    price: "",
    currency: "AED",
    is_preferred: false,
    is_default_order_unit: false,
    name_ar: "",
  };
}

export function normalizeUomAlias(value: string): string {
  return value.trim().toLocaleLowerCase().replace(/\s+/g, " ");
}

export function resolvePackagePricingUomCode(
  pkg: BaseItemPackage | undefined,
  uoms: Uom[],
): string | null {
  if (!pkg?.unit) return null;
  if (pkg.unit_uom_code && uoms.some((uom) => uom.code === pkg.unit_uom_code)) {
    return pkg.unit_uom_code;
  }
  const normalized = normalizeUomAlias(pkg.unit);
  const matches = new Set(
    uoms
      .filter((uom) =>
        uom.aliases.some((alias) => normalizeUomAlias(alias) === normalized),
      )
      .map((uom) => uom.code),
  );
  return matches.size === 1 ? [...matches][0] : null;
}

function PricingUomCombobox({
  value,
  legacyValue,
  uoms,
  isLoading,
  isError,
  onRetry,
  onChange,
  disabled,
}: {
  value: string;
  legacyValue: string;
  uoms: Uom[];
  isLoading: boolean;
  isError: boolean;
  onRetry: () => void;
  onChange: (code: string) => void;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const selected = uoms.find((uom) => uom.code === value);
  const hasLegacyValue = !value && Boolean(legacyValue);

  return (
    <div className="space-y-1">
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button
            type="button"
            variant="outline"
            role="combobox"
            aria-label="Pricing UOM"
            aria-expanded={open}
            aria-invalid={isError}
            disabled={disabled || isLoading}
            className="h-8 w-full justify-between px-3 text-sm font-normal"
          >
            <span
              className={
                hasLegacyValue
                  ? "min-w-0 truncate text-amber-700"
                  : selected
                    ? "min-w-0 truncate"
                    : "min-w-0 truncate text-muted-foreground"
              }
            >
              {hasLegacyValue
                ? `Legacy value: ${legacyValue} — needs review`
                : selected?.display_name
                  ?? (isLoading ? "Loading pricing UOMs…" : "Select pricing UOM…")}
            </span>
            {isLoading
              ? <Loader2 size={14} className="ml-2 shrink-0 animate-spin opacity-60" />
              : <ChevronsUpDown size={14} className="ml-2 shrink-0 opacity-50" />}
          </Button>
        </PopoverTrigger>
        <PopoverContent
          className="w-[--radix-popover-trigger-width] p-0"
          align="start"
        >
          <Command>
            <CommandInput placeholder="Search pricing UOM…" />
            <CommandList>
              <CommandEmpty>No matching pricing UOM.</CommandEmpty>
              {!hasLegacyValue && (
                <CommandGroup>
                  <CommandItem
                    value="__none__ no pricing uom"
                    onSelect={() => {
                      onChange("");
                      setOpen(false);
                    }}
                  >
                    <Check
                      size={14}
                      className={`mr-2 ${value ? "opacity-0" : "opacity-100"}`}
                    />
                    <span className="text-muted-foreground">No pricing UOM</span>
                  </CommandItem>
                </CommandGroup>
              )}
              <CommandGroup heading="Units">
                {uoms.map((uom) => (
                  <CommandItem
                    key={uom.code}
                    value={`${uom.display_name} ${uom.code} ${uom.aliases.join(" ")}`}
                    onSelect={() => {
                      onChange(uom.code);
                      setOpen(false);
                    }}
                  >
                    <Check
                      size={14}
                      className={`mr-2 ${value === uom.code ? "opacity-100" : "opacity-0"}`}
                    />
                    <span>{uom.display_name}</span>
                    <span className="ml-auto text-xs text-muted-foreground">{uom.code}</span>
                  </CommandItem>
                ))}
              </CommandGroup>
            </CommandList>
          </Command>
        </PopoverContent>
      </Popover>
      {isError && (
        <div className="flex items-center gap-1.5 text-xs text-destructive">
          <span>Could not load pricing UOMs.</span>
          <button
            type="button"
            className="inline-flex items-center gap-1 underline underline-offset-2"
            onClick={onRetry}
          >
            <RotateCcw size={11} />
            Retry
          </button>
        </div>
      )}
    </div>
  );
}

function SupplierRowEditor({
  row,
  onChange,
  suppliers,
  packages,
  uoms,
  uomsLoading,
  uomsError,
  onRetryUoms,
  onDelete,
  error,
  footer,
}: {
  row: RowEditState;
  onChange: (next: Partial<RowEditState>) => void;
  suppliers: Supplier[];
  packages: BaseItemPackage[];
  uoms: Uom[];
  uomsLoading: boolean;
  uomsError: boolean;
  onRetryUoms: () => void;
  onDelete: () => void;
  error?: string | null;
  footer?: React.ReactNode;
}) {
  return (
    <div className="border border-border rounded-lg p-3 space-y-3 bg-card">
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <div className="space-y-1">
          <p className="text-xs font-medium text-muted-foreground">Supplier *</p>
          <Select value={row.supplier_id || "none"} onValueChange={(v) => onChange({ supplier_id: v === "none" ? "" : v })}>
            <SelectTrigger className="h-8 text-sm">
              <SelectValue placeholder="Select supplier…" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="none"><span className="text-muted-foreground">Select supplier…</span></SelectItem>
              {suppliers.map((s) => (
                <SelectItem key={s.id} value={String(s.id)}>{s.name}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1">
          <p className="text-xs font-medium text-muted-foreground">Package</p>
          <Select
            value={row.package_id || "none"}
            onValueChange={(v) => {
              const packageId = v === "none" ? "" : v;
              const patch: Partial<RowEditState> = { package_id: packageId };
              if (!row.pricing_uom_code && !row.pricing_uom_legacy && packageId) {
                const code = resolvePackagePricingUomCode(
                  packages.find((pkg) => String(pkg.id) === packageId),
                  uoms,
                );
                if (code) {
                  patch.pricing_uom_code = code;
                  patch.pricing_uom_touched = true;
                }
              }
              onChange(patch);
            }}
          >
            <SelectTrigger className="h-8 text-sm">
              <SelectValue placeholder="Select package…" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="none"><span className="text-muted-foreground">Any / not specified</span></SelectItem>
              {packages.map((p) => (
                <SelectItem key={p.id} value={String(p.id)}>{p.name}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1">
          <p className="text-xs font-medium text-muted-foreground">Supplier Item Name</p>
          <Input className="h-8 text-sm" value={row.supplier_item_name} onChange={(e) => onChange({ supplier_item_name: e.target.value })} placeholder="Optional" />
        </div>
        <div className="space-y-1">
          <p className="text-xs font-medium text-muted-foreground">Supplier Item Code</p>
          <Input className="h-8 text-sm" value={row.supplier_item_code} onChange={(e) => onChange({ supplier_item_code: e.target.value })} placeholder="Optional" />
        </div>
        <div className="space-y-1">
          <p className="text-xs font-medium text-muted-foreground">Arabic Item Name</p>
          <Input
            className="h-8 text-sm text-right"
            dir="rtl"
            lang="ar"
            value={row.name_ar}
            onChange={(e) => onChange({ name_ar: e.target.value })}
            placeholder="الاسم بالعربية (اختياري)"
          />
        </div>
        <div className="space-y-1">
          <p className="text-xs font-medium text-muted-foreground">Pricing UOM</p>
          <PricingUomCombobox
            value={row.pricing_uom_code}
            legacyValue={row.pricing_uom_legacy}
            uoms={uoms}
            isLoading={uomsLoading}
            isError={uomsError}
            onRetry={onRetryUoms}
            onChange={(code) => onChange({
              pricing_uom_code: code,
              pricing_uom_legacy: code ? "" : row.pricing_uom_legacy,
              pricing_uom_touched: true,
            })}
          />
          {row.pricing_uom_legacy && !row.pricing_uom_code && (
            <p className="flex items-start gap-1 text-xs text-amber-700">
              <AlertTriangle size={12} className="mt-0.5 shrink-0" />
              Select a canonical UOM to replace this protected legacy value.
            </p>
          )}
        </div>
        <div className="space-y-1">
          <p className="text-xs font-medium text-muted-foreground">Price</p>
          <div className="flex gap-1.5">
            <Input
              className="h-8 text-sm flex-1"
              type="number"
              min="0"
              step="any"
              value={row.price}
              onChange={(e) => onChange({ price: e.target.value })}
              placeholder="0.00"
            />
            <Select value={row.currency} onValueChange={(v) => onChange({ currency: v })}>
              <SelectTrigger className="h-8 w-20 text-sm shrink-0">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="AED">AED</SelectItem>
                <SelectItem value="USD">USD</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>
      </div>
      <div className="flex items-center gap-4 flex-wrap">
        <label className="flex items-center gap-2 cursor-pointer select-none text-sm">
          <Checkbox
            checked={row.is_preferred}
            onCheckedChange={(v) => onChange({ is_preferred: v === true })}
          />
          Preferred supplier
        </label>
        <label className="flex items-center gap-2 cursor-pointer select-none text-sm">
          <Checkbox
            checked={row.is_default_order_unit}
            onCheckedChange={(v) => onChange({ is_default_order_unit: v === true })}
          />
          Default order unit
        </label>
        <div className="flex-1" />
        <Button
          type="button"
          size="sm"
          variant="ghost"
          className="text-destructive hover:text-destructive h-7"
          onClick={onDelete}
        >
          <Trash2 size={13} className="mr-1" />
          Remove
        </Button>
      </div>
      {error && <p className="text-xs text-destructive">{error}</p>}
      {footer && <div>{footer}</div>}
    </div>
  );
}

export function SuppliersTab({ baseItemId }: { baseItemId: number }) {
  const { toast } = useToast();
  const qc = useQueryClient();
  const { isOwner, allowedPages } = useWorkspaceRole();
  const canManage = isOwner || (allowedPages?.includes("base_items.manage") ?? false);

  const { data: suppliersData, isLoading: suppliersLoading } = useListBaseItemSuppliers(baseItemId);
  const { data: wsSupplierData, isLoading: wsLoading } = useListSuppliers({});
  const { data: pkgData } = useListBaseItemPackages(baseItemId);
  const {
    data: uomData,
    isLoading: uomsLoading,
    isError: uomsError,
    refetch: refetchUoms,
  } = useListUoms({ context: "supplier_pricing" });

  const existingLinks: BaseItemSupplier[] = suppliersData?.suppliers ?? [];
  const workspaceSuppliers: Supplier[] = (wsSupplierData?.suppliers ?? []).filter((s) => !s.is_archived);
  const packages: BaseItemPackage[] = pkgData?.packages ?? [];
  const uoms: Uom[] = uomData?.uoms ?? [];

  const [newRows, setNewRows] = useState<NewRow[]>([]);
  const [newRowErrors, setNewRowErrors] = useState<Record<string, string | null>>({});
  const [deleteTarget, setDeleteTarget] = useState<BaseItemSupplier | null>(null);

  const createMutation = useCreateBaseItemSupplier({
    mutation: {
      onSuccess: () => {
        qc.invalidateQueries({ queryKey: getListBaseItemSuppliersQueryKey(baseItemId) });
      },
    },
  });

  const deleteMutation = useDeleteBaseItemSupplier({
    mutation: {
      onSuccess: () => {
        qc.invalidateQueries({ queryKey: getListBaseItemSuppliersQueryKey(baseItemId) });
        toast({ title: "Supplier link removed" });
        setDeleteTarget(null);
      },
      onError: (err) => {
        const msg = err instanceof Error ? err.message : "Could not remove supplier link";
        toast({ title: "Failed to remove", description: msg, variant: "destructive" });
        setDeleteTarget(null);
      },
    },
  });

  function addNewRow() {
    const key = String(Date.now()) + Math.random();
    setNewRows((prev) => [...prev, { _key: key, ...emptyRowState() }]);
  }

  function updateNewRow(key: string, patch: Partial<RowEditState>) {
    setNewRows((prev) => prev.map((r) => r._key === key ? { ...r, ...patch } : r));
    setNewRowErrors((prev) => ({ ...prev, [key]: null }));
  }

  function removeNewRow(key: string) {
    setNewRows((prev) => prev.filter((r) => r._key !== key));
    setNewRowErrors((prev) => {
      const next = { ...prev };
      delete next[key];
      return next;
    });
  }

  async function saveNewRows() {
    const errors: Record<string, string | null> = {};
    let hasError = false;
    for (const row of newRows) {
      if (!row.supplier_id) {
        errors[row._key] = "Supplier is required";
        hasError = true;
      } else if (row.price !== "" && (isNaN(parseFloat(row.price)) || parseFloat(row.price) < 0)) {
        errors[row._key] = "Price must be a non-negative number";
        hasError = true;
      } else {
        errors[row._key] = null;
      }
    }
    setNewRowErrors(errors);
    if (hasError) return;

    for (const row of newRows) {
      await createMutation.mutateAsync({
        id: baseItemId,
        data: {
          supplier_id: parseInt(row.supplier_id, 10),
          package_id: row.package_id ? parseInt(row.package_id, 10) : null,
          supplier_item_name: row.supplier_item_name.trim() || null,
          supplier_item_code: row.supplier_item_code.trim() || null,
          pricing_uom_code: row.pricing_uom_code || null,
          price: row.price !== "" ? parseFloat(row.price) : null,
          currency: row.currency,
          is_preferred: row.is_preferred,
          is_default_order_unit: row.is_default_order_unit,
          name_ar: row.name_ar.trim() || undefined,
        },
      });
    }
    setNewRows([]);
    toast({ title: `${newRows.length} supplier link${newRows.length !== 1 ? "s" : ""} saved` });
  }

  const isLoading = suppliersLoading || wsLoading;

  if (isLoading) {
    return (
      <div className="flex items-center gap-2 text-sm text-muted-foreground py-4">
        <Loader2 size={14} className="animate-spin" />
        Loading suppliers…
      </div>
    );
  }

  if (workspaceSuppliers.length === 0 && existingLinks.length === 0) {
    return (
      <div className="rounded-lg border border-dashed border-border p-10 text-center space-y-3">
        <span className="sr-only">Suppliers data is not yet available.</span>
        <Store size={28} className="mx-auto text-muted-foreground" />
        <div>
          <p className="font-medium text-sm">No suppliers configured</p>
          <p className="text-xs text-muted-foreground mt-1">
            Create workspace suppliers in Settings first, then link them here.
          </p>
        </div>
        <Link href="/settings">
          <Button size="sm" variant="outline">
            <Settings size={13} className="mr-1.5" />
            Go to Settings
          </Button>
        </Link>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {existingLinks.length === 0 && newRows.length === 0 && (
        <div className="rounded-lg border border-dashed border-border p-6 text-center text-sm text-muted-foreground">
          No supplier links yet. Add one below.
        </div>
      )}

      {existingLinks.map((link) => (
        <ExistingSupplierRow
          key={link.id}
          link={link}
          baseItemId={baseItemId}
          suppliers={workspaceSuppliers}
          packages={packages}
          uoms={uoms}
          uomsLoading={uomsLoading}
          uomsError={uomsError}
          onRetryUoms={() => { void refetchUoms(); }}
          onDelete={() => setDeleteTarget(link)}
          canManage={canManage}
        />
      ))}

      {newRows.map((row) => (
        <SupplierRowEditor
          key={row._key}
          row={row}
          onChange={(patch) => updateNewRow(row._key, patch)}
          suppliers={workspaceSuppliers}
          packages={packages}
          uoms={uoms}
          uomsLoading={uomsLoading}
          uomsError={uomsError}
          onRetryUoms={() => { void refetchUoms(); }}
          onDelete={() => removeNewRow(row._key)}
          error={newRowErrors[row._key]}
        />
      ))}

      {canManage && (
        <div className="flex items-center gap-2">
          <Button size="sm" variant="outline" onClick={addNewRow}>
            <Plus size={14} className="mr-1.5" />
            Add Supplier
          </Button>
          {newRows.length > 0 && (
            <Button size="sm" onClick={saveNewRows} disabled={createMutation.isPending}>
              {createMutation.isPending ? <><Loader2 size={13} className="animate-spin mr-1.5" />Saving…</> : `Save ${newRows.length} row${newRows.length !== 1 ? "s" : ""}`}
            </Button>
          )}
          {newRows.length > 0 && (
            <Button size="sm" variant="ghost" onClick={() => setNewRows([])} disabled={createMutation.isPending}>
              Cancel
            </Button>
          )}
        </div>
      )}

      <AlertDialog open={deleteTarget !== null} onOpenChange={(v) => { if (!v) setDeleteTarget(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove supplier link?</AlertDialogTitle>
            <AlertDialogDescription>
              This will remove the link to "{deleteTarget?.supplier_name}" from this base item.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleteMutation.isPending}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              disabled={deleteMutation.isPending}
              onClick={() => {
                if (deleteTarget) {
                  deleteMutation.mutate({ id: baseItemId, supplierId: deleteTarget.id });
                }
              }}
            >
              {deleteMutation.isPending ? <><Loader2 size={13} className="animate-spin mr-1.5" />Removing…</> : "Remove"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function ExistingSupplierRow({
  link,
  baseItemId,
  suppliers,
  packages,
  uoms,
  uomsLoading,
  uomsError,
  onRetryUoms,
  onDelete,
  canManage,
}: {
  link: BaseItemSupplier;
  baseItemId: number;
  suppliers: Supplier[];
  packages: BaseItemPackage[];
  uoms: Uom[];
  uomsLoading: boolean;
  uomsError: boolean;
  onRetryUoms: () => void;
  onDelete: () => void;
  canManage: boolean;
}) {
  const { toast } = useToast();
  const qc = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState<RowEditState>({
    supplier_id: String(link.supplier_id),
    package_id: link.package_id ? String(link.package_id) : "",
    supplier_item_name: link.supplier_item_name ?? "",
    supplier_item_code: link.supplier_item_code ?? "",
    pricing_uom_code: link.pricing_uom_code ?? "",
    pricing_uom_legacy: link.pricing_uom_legacy ?? "",
    pricing_uom_touched: false,
    price: link.price != null ? String(link.price) : "",
    currency: link.currency,
    is_preferred: link.is_preferred,
    is_default_order_unit: link.is_default_order_unit,
    name_ar: link.name_ar ?? "",
  });
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setForm({
      supplier_id: String(link.supplier_id),
      package_id: link.package_id ? String(link.package_id) : "",
      supplier_item_name: link.supplier_item_name ?? "",
      supplier_item_code: link.supplier_item_code ?? "",
      pricing_uom_code: link.pricing_uom_code ?? "",
      pricing_uom_legacy: link.pricing_uom_legacy ?? "",
      pricing_uom_touched: false,
      price: link.price != null ? String(link.price) : "",
      currency: link.currency,
      is_preferred: link.is_preferred,
      is_default_order_unit: link.is_default_order_unit,
      name_ar: link.name_ar ?? "",
    });
  }, [link]);

  const patchMutation = usePatchBaseItemSupplier({
    mutation: {
      onSuccess: () => {
        qc.invalidateQueries({ queryKey: getListBaseItemSuppliersQueryKey(baseItemId) });
        toast({ title: "Supplier link updated" });
        setEditing(false);
      },
      onError: (err) => {
        const msg = err instanceof Error ? err.message : "Could not update supplier link";
        setError(msg);
      },
    },
  });

  function handleSave() {
    setError(null);
    if (!form.supplier_id) { setError("Supplier is required"); return; }
    if (form.price !== "" && (isNaN(parseFloat(form.price)) || parseFloat(form.price) < 0)) {
      setError("Price must be a non-negative number"); return;
    }
    patchMutation.mutate({
      id: baseItemId,
      supplierId: link.id,
      data: {
        supplier_id: parseInt(form.supplier_id, 10),
        package_id: form.package_id ? parseInt(form.package_id, 10) : null,
        supplier_item_name: form.supplier_item_name.trim() || null,
        supplier_item_code: form.supplier_item_code.trim() || null,
        ...(form.pricing_uom_touched
          ? { pricing_uom_code: form.pricing_uom_code || null }
          : {}),
        price: form.price !== "" ? parseFloat(form.price) : null,
        currency: form.currency,
        is_preferred: form.is_preferred,
        is_default_order_unit: form.is_default_order_unit,
        ...(form.name_ar.trim() ? { name_ar: form.name_ar.trim() } : {}),
      },
    });
  }

  const fullSupplier = suppliers.find((s) => s.id === link.supplier_id);

  if (!editing) {
    return (
      <div className="border border-border rounded-lg p-3 flex items-start gap-3 bg-card">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <p className="text-sm font-medium">{link.supplier_name}</p>
            {link.is_preferred && (
              <span className="text-xs text-purple-700 bg-purple-100 rounded px-1.5 py-0.5">Preferred</span>
            )}
            {link.is_default_order_unit && (
              <span className="text-xs text-blue-700 bg-blue-100 rounded px-1.5 py-0.5">Default Order Unit</span>
            )}
          </div>
          <div className="flex flex-wrap gap-x-4 gap-y-0.5 mt-1 text-xs text-muted-foreground">
            {link.package_name && <span>Package: {link.package_name}</span>}
            {link.supplier_item_name && <span>Item: {link.supplier_item_name}</span>}
            {link.supplier_item_code && <span>Code: {link.supplier_item_code}</span>}
            {link.pricing_uom_legacy ? (
              <span className="text-amber-700">
                Legacy value: {link.pricing_uom_legacy} — needs review
              </span>
            ) : (
              link.pricing_uom && <span>UOM: {link.pricing_uom}</span>
            )}
            {link.price != null && <span>Price: {link.currency} {parseFloat(String(link.price)).toFixed(2)}</span>}
            {fullSupplier?.tax_number && (
              <span>{taxNumberLabel(fullSupplier.country ?? "")}: {fullSupplier.tax_number}</span>
            )}
            {link.name_ar && (
              <span dir="rtl" lang="ar">
                {link.name_ar}
                {(() => {
                  const src = link.name_ar_source;
                  if (!src) return null;
                  const colors: Record<string, string> = {
                    manual: "bg-green-100 text-green-700",
                    migrated: "bg-blue-100 text-blue-700",
                    ai: "bg-purple-100 text-purple-700",
                  };
                  return (
                    <span className={`ml-1 rounded px-1 py-0.5 text-[10px] font-medium ${colors[src] ?? "bg-muted text-muted-foreground"}`}>
                      {src}
                    </span>
                  );
                })()}
              </span>
            )}
          </div>
        </div>
        {canManage && (
          <div className="flex items-center gap-1 shrink-0">
            <Button size="sm" variant="outline" className="h-7 text-xs" onClick={() => setEditing(true)}>Edit</Button>
            <Button size="icon" variant="ghost" className="h-7 w-7 text-muted-foreground hover:text-destructive" onClick={onDelete}>
              <Trash2 size={13} />
            </Button>
          </div>
        )}
      </div>
    );
  }

  return (
    <SupplierRowEditor
      row={form}
      onChange={(patch) => { setForm((f) => ({ ...f, ...patch })); setError(null); }}
      suppliers={suppliers}
      packages={packages}
      uoms={uoms}
      uomsLoading={uomsLoading}
      uomsError={uomsError}
      onRetryUoms={onRetryUoms}
      onDelete={onDelete}
      error={error}
      footer={
        <div className="flex gap-2">
          <Button size="sm" onClick={handleSave} disabled={patchMutation.isPending}>
            {patchMutation.isPending ? <><Loader2 size={13} className="animate-spin mr-1.5" />Saving…</> : "Save"}
          </Button>
          <Button size="sm" variant="outline" onClick={() => { setEditing(false); setError(null); }} disabled={patchMutation.isPending}>Cancel</Button>
        </div>
      }
    />
  );
}

import { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  useCreateMarketplaceBrandAlias,
  useDeleteMarketplaceBrandAlias,
  useListMarketplaceBrandAliases,
  useUpdateMarketplaceBrandAlias,
  getListMarketplaceBrandAliasesQueryKey,
} from "@workspace/api-client-react";
import type { MarketplaceBrandAlias } from "@workspace/api-client-react";
import {
  AlertCircle,
  Loader2,
  MapPin,
  Pencil,
  Plus,
  RefreshCw,
  Search,
  Tag,
  Trash2,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
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
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import { apiFetch } from "@/lib/queryClient";

export type BrandItem = { id: number; name: string };
export type LocationItem = { id: number; name: string };

const MARKETPLACE_OPTIONS = ["Toters", "Careem", "Talabat", "Deliveroo", "Zomato", "Other"];
const EMPTY_FORM = { marketplace: "Toters", alias_name: "", brand_id: "", location_id: "" };

type AliasForm = typeof EMPTY_FORM;

function getErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : "Please try again.";
}

export function BrandAliasesView() {
  const { toast } = useToast();
  const qc = useQueryClient();
  const [search, setSearch] = useState("");
  const [formOpen, setFormOpen] = useState(false);
  const [editingAlias, setEditingAlias] = useState<MarketplaceBrandAlias | null>(null);
  const [form, setForm] = useState<AliasForm>({ ...EMPTY_FORM });
  const [deleteTarget, setDeleteTarget] = useState<MarketplaceBrandAlias | null>(null);

  const aliasesQuery = useListMarketplaceBrandAliases();
  const aliases = aliasesQuery.data?.aliases ?? [];
  const { data: brandsData } = useQuery({
    queryKey: ["brands"],
    queryFn: () => apiFetch<{ brands: BrandItem[] }>("/api/brands"),
  });
  const { data: locationsData } = useQuery({
    queryKey: ["locations"],
    queryFn: () => apiFetch<{ locations: LocationItem[] }>("/api/locations"),
  });
  const brands = brandsData?.brands ?? [];
  const locations = locationsData?.locations ?? [];

  const filteredAliases = useMemo(() => {
    const query = search.trim().toLowerCase();
    if (!query) return aliases;
    return aliases.filter((alias) =>
      [alias.marketplace, alias.alias_name, alias.brand_name, alias.location_name]
        .some((value) => value?.toLowerCase().includes(query)),
    );
  }, [aliases, search]);

  const createMutation = useCreateMarketplaceBrandAlias({
    mutation: {
      onSuccess: () => {
        qc.invalidateQueries({ queryKey: getListMarketplaceBrandAliasesQueryKey() });
        toast({ title: "Statement alias created" });
        closeForm();
      },
      onError: (error) => toast({
        variant: "destructive",
        title: "Could not create statement alias",
        description: getErrorMessage(error),
      }),
    },
  });
  const updateMutation = useUpdateMarketplaceBrandAlias({
    mutation: {
      onSuccess: () => {
        qc.invalidateQueries({ queryKey: getListMarketplaceBrandAliasesQueryKey() });
        toast({ title: "Statement alias updated" });
        closeForm();
      },
      onError: (error) => toast({
        variant: "destructive",
        title: "Could not update statement alias",
        description: getErrorMessage(error),
      }),
    },
  });
  const deleteMutation = useDeleteMarketplaceBrandAlias({
    mutation: {
      onSuccess: () => {
        qc.invalidateQueries({ queryKey: getListMarketplaceBrandAliasesQueryKey() });
        toast({ title: "Statement alias deleted" });
        setDeleteTarget(null);
      },
      onError: (error) => toast({
        variant: "destructive",
        title: "Could not delete statement alias",
        description: getErrorMessage(error),
      }),
    },
  });

  const isBusy = createMutation.isPending || updateMutation.isPending || deleteMutation.isPending;
  const duplicate = form.alias_name.trim()
    ? aliases.find((alias) =>
      alias.id !== editingAlias?.id &&
      alias.marketplace === form.marketplace &&
      alias.alias_name.toLowerCase() === form.alias_name.trim().toLowerCase())
    : undefined;

  function closeForm() {
    setFormOpen(false);
    setEditingAlias(null);
    setForm({ ...EMPTY_FORM });
  }

  function openCreate() {
    setEditingAlias(null);
    setForm({ ...EMPTY_FORM });
    setFormOpen(true);
  }

  function openEdit(alias: MarketplaceBrandAlias) {
    setEditingAlias(alias);
    setForm({
      marketplace: alias.marketplace,
      alias_name: alias.alias_name,
      brand_id: alias.brand_id == null ? "" : String(alias.brand_id),
      location_id: alias.location_id == null ? "" : String(alias.location_id),
    });
    setFormOpen(true);
  }

  function submitForm() {
    if (!form.alias_name.trim() || !form.brand_id) {
      toast({ variant: "destructive", title: "Statement name and matched brand are required" });
      return;
    }
    if (duplicate) {
      toast({
        variant: "destructive",
        title: "Duplicate statement alias",
        description: `"${form.alias_name.trim()}" already exists for ${form.marketplace}.`,
      });
      return;
    }
    const data = {
      marketplace: form.marketplace,
      alias_name: form.alias_name.trim(),
      brand_id: Number(form.brand_id),
      location_id: form.location_id ? Number(form.location_id) : null,
    };
    if (editingAlias) {
      updateMutation.mutate({ id: editingAlias.id, data });
    } else {
      createMutation.mutate({ data });
    }
  }

  return (
    <div className="space-y-4" data-testid="statement-aliases-view">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2">
            <Tag size={18} className="text-muted-foreground" />
            <h2 className="text-xl font-semibold">Statement Aliases</h2>
            <Badge variant="secondary" data-testid="statement-aliases-count">{aliases.length}</Badge>
          </div>
          <p className="text-sm text-muted-foreground mt-2 max-w-2xl">
            Map marketplace statement names to the canonical brands and locations they belong to.
            These mappings help imported statements resolve to the right brand automatically.
          </p>
        </div>
        <Button size="sm" onClick={openCreate} data-testid="new-statement-alias">
          <Plus size={14} className="mr-1.5" />
          New Alias
        </Button>
      </div>

      {aliases.length > 0 && (
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="text-sm text-muted-foreground">
            {search.trim() ? `${filteredAliases.length} of ${aliases.length} aliases` : `${aliases.length} aliases`}
          </p>
          <div className="relative w-full sm:w-80">
            <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground pointer-events-none" />
            <Input
              type="search"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Search marketplace, statement name, brand, or location"
              aria-label="Search statement aliases"
              className="h-9 pl-8 pr-8"
              data-testid="statement-aliases-search"
            />
            {search && (
              <button
                type="button"
                aria-label="Clear statement alias search"
                onClick={() => setSearch("")}
                className="absolute right-1.5 top-1/2 inline-flex h-6 w-6 -translate-y-1/2 items-center justify-center rounded-md text-muted-foreground hover:bg-secondary hover:text-foreground"
              >
                <X size={14} />
              </button>
            )}
          </div>
        </div>
      )}

      <div className="rounded-xl border border-border bg-card shadow-sm overflow-hidden">
        {aliasesQuery.isLoading ? (
          <div className="flex items-center gap-2 p-8 text-sm text-muted-foreground" data-testid="statement-aliases-loading">
            <Loader2 size={15} className="animate-spin" />
            Loading statement aliases…
          </div>
        ) : aliasesQuery.isError ? (
          <div className="p-10 text-center" data-testid="statement-aliases-error">
            <AlertCircle size={28} className="mx-auto mb-3 text-destructive" />
            <p className="font-medium">Statement aliases could not be loaded</p>
            <p className="mt-1 text-sm text-muted-foreground">{getErrorMessage(aliasesQuery.error)}</p>
            <Button variant="outline" size="sm" className="mt-4" onClick={() => aliasesQuery.refetch()}>
              <RefreshCw size={13} className="mr-1.5" />
              Try again
            </Button>
          </div>
        ) : aliases.length === 0 ? (
          <div className="py-12 px-5 text-center" data-testid="statement-aliases-empty">
            <Tag size={30} className="mx-auto mb-3 text-muted-foreground/40" />
            <p className="font-medium">No statement aliases yet</p>
            <p className="mx-auto mt-1 max-w-md text-sm text-muted-foreground">
              Add a mapping when a marketplace uses a statement name that differs from your canonical brand name.
            </p>
            <Button size="sm" variant="outline" className="mt-4" onClick={openCreate}>
              <Plus size={13} className="mr-1.5" />
              Add Alias
            </Button>
          </div>
        ) : filteredAliases.length === 0 ? (
          <div className="py-12 px-5 text-center" data-testid="statement-aliases-no-results">
            <Search size={30} className="mx-auto mb-3 text-muted-foreground/40" />
            <p className="font-medium">No matching statement aliases</p>
            <p className="mt-1 text-sm text-muted-foreground">Try a different marketplace, name, brand, or location.</p>
            <Button size="sm" variant="outline" className="mt-4" onClick={() => setSearch("")}>Clear search</Button>
          </div>
        ) : (
          <div data-testid="statement-aliases-table">
            <div className="hidden md:grid grid-cols-[1fr_1.5fr_1.4fr_1fr_92px] gap-3 border-b border-border bg-muted/30 px-4 py-3 text-xs font-medium text-muted-foreground">
              <span>Marketplace</span>
              <span>Statement name</span>
              <span>Matched brand</span>
              <span>Location</span>
              <span />
            </div>
            <div className="divide-y divide-border">
              {filteredAliases.map((alias) => (
                <div key={alias.id} data-testid={`statement-alias-row-${alias.id}`} className="px-4 py-3 hover:bg-secondary/20 transition-colors">
                  <div className="hidden md:grid grid-cols-[1fr_1.5fr_1.4fr_1fr_92px] gap-3 items-center">
                    <span className="text-xs font-medium">{alias.marketplace}</span>
                    <span className="truncate font-mono text-xs" title={alias.alias_name}>{alias.alias_name}</span>
                    <span className="truncate text-xs">{alias.brand_name ?? "—"}</span>
                    <span className="truncate text-xs text-muted-foreground">{alias.location_name ?? "Any location"}</span>
                    <AliasActions alias={alias} onEdit={openEdit} onDelete={setDeleteTarget} disabled={isBusy} />
                  </div>
                  <div className="md:hidden space-y-2">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <p className="text-xs font-medium">{alias.marketplace}</p>
                        <p className="mt-1 truncate font-mono text-sm" title={alias.alias_name}>{alias.alias_name}</p>
                      </div>
                      <AliasActions alias={alias} onEdit={openEdit} onDelete={setDeleteTarget} disabled={isBusy} />
                    </div>
                    <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
                      <span>Matched brand: <strong className="font-medium text-foreground">{alias.brand_name ?? "—"}</strong></span>
                      <span className="inline-flex items-center gap-1"><MapPin size={11} /> {alias.location_name ?? "Any location"}</span>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      <Dialog open={formOpen} onOpenChange={(open) => !open && closeForm()}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>{editingAlias ? "Edit Statement Alias" : "New Statement Alias"}</DialogTitle>
            <DialogDescription>
              Connect the marketplace statement name to the canonical brand used in Presentail OS.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div className="space-y-1.5">
              <Label>Marketplace</Label>
              <Select value={form.marketplace} onValueChange={(value) => setForm((current) => ({ ...current, marketplace: value }))}>
                <SelectTrigger data-testid="statement-alias-marketplace"><SelectValue /></SelectTrigger>
                <SelectContent>{MARKETPLACE_OPTIONS.map((marketplace) => <SelectItem key={marketplace} value={marketplace}>{marketplace}</SelectItem>)}</SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label>Statement name</Label>
              <Input
                value={form.alias_name}
                onChange={(event) => setForm((current) => ({ ...current, alias_name: event.target.value }))}
                placeholder="e.g. Presentail Flowers & Gifts"
                data-testid="statement-alias-name"
              />
              {duplicate && <p className="text-xs text-destructive">That marketplace and statement name are already mapped.</p>}
            </div>
            <div className="space-y-1.5">
              <Label>Matched brand</Label>
              <Select value={form.brand_id} onValueChange={(value) => setForm((current) => ({ ...current, brand_id: value }))}>
                <SelectTrigger data-testid="statement-alias-brand"><SelectValue placeholder="Select canonical brand" /></SelectTrigger>
                <SelectContent>{brands.map((brand) => <SelectItem key={brand.id} value={String(brand.id)}>{brand.name}</SelectItem>)}</SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label>Location <span className="font-normal text-muted-foreground">(optional)</span></Label>
              <Select value={form.location_id || "__none__"} onValueChange={(value) => setForm((current) => ({ ...current, location_id: value === "__none__" ? "" : value }))}>
                <SelectTrigger data-testid="statement-alias-location"><SelectValue placeholder="Any location" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="__none__">Any location</SelectItem>
                  {locations.map((location) => <SelectItem key={location.id} value={String(location.id)}>{location.name}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={closeForm} disabled={isBusy}>Cancel</Button>
            <Button onClick={submitForm} disabled={isBusy || !!duplicate || !form.alias_name.trim() || !form.brand_id} data-testid="save-statement-alias">
              {isBusy && <Loader2 size={14} className="mr-1.5 animate-spin" />}
              {editingAlias ? "Save changes" : "Save alias"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <AlertDialog open={deleteTarget !== null} onOpenChange={(open) => !open && setDeleteTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete statement alias?</AlertDialogTitle>
            <AlertDialogDescription>
              The mapping for <span className="font-mono font-medium">{deleteTarget?.alias_name}</span> will be removed.
              Imported statements with that name will no longer auto-link to {deleteTarget?.brand_name ?? "the matched brand"}.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleteMutation.isPending}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              disabled={deleteMutation.isPending}
              onClick={() => deleteTarget && deleteMutation.mutate({ id: deleteTarget.id })}
            >
              {deleteMutation.isPending && <Loader2 size={14} className="mr-1.5 animate-spin" />}
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function AliasActions({
  alias,
  onEdit,
  onDelete,
  disabled,
}: {
  alias: MarketplaceBrandAlias;
  onEdit: (alias: MarketplaceBrandAlias) => void;
  onDelete: (alias: MarketplaceBrandAlias) => void;
  disabled: boolean;
}) {
  return (
    <div className="flex items-center justify-end gap-1 shrink-0">
      <Button size="sm" variant="ghost" className="h-8 w-8 p-0" onClick={() => onEdit(alias)} disabled={disabled} aria-label={`Edit ${alias.alias_name}`}>
        <Pencil size={13} />
      </Button>
      <Button size="sm" variant="ghost" className="h-8 w-8 p-0 text-muted-foreground hover:text-destructive" onClick={() => onDelete(alias)} disabled={disabled} aria-label={`Delete ${alias.alias_name}`}>
        <Trash2 size={13} />
      </Button>
    </div>
  );
}

export default function BrandAliasesPage() {
  return <BrandAliasesView />;
}
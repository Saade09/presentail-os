import { useState } from "react";
import {
  Plus, Pencil, Trash2, Search, Globe, Tag,
  CheckCircle, XCircle, MoreHorizontal, ImageIcon,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
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
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useToast } from "@/hooks/use-toast";
import { useWorkspaceRole } from "@/hooks/use-workspace-role";
import { queryClient } from "@/lib/queryClient";
import { imageUrl } from "@/lib/imageUrl";
import { AttributeFormSheet } from "./AttributeFormSheet";
import { CityAvailabilityPanel } from "./CityAvailabilityPanel";
import { AttributeProductsPanel, type AttributeProductFilter } from "./AttributeProductsPanel";
import type { AttributeHooksConfig } from "./attributeHooks";
import type { CatalogAttribute } from "@workspace/api-client-react";

type Props = {
  hooksConfig: AttributeHooksConfig;
  typeSingular: string;
  title: string;
  icon?: React.ReactNode;
  permissionKey: string;
  attributeType: AttributeProductFilter;
  showFeaturedToggle?: boolean;
  showDescription?: boolean;
};

function StatCard({ label, value, sub, icon }: { label: string; value: string | number; sub?: string; icon: React.ReactNode }) {
  return (
    <div className="bg-card border border-border rounded-xl p-5">
      <div className="flex items-start justify-between">
        <div>
          <p className="text-sm text-muted-foreground font-medium">{label}</p>
          <p className="text-2xl font-bold mt-1">{value}</p>
          {sub && <p className="text-xs text-muted-foreground mt-0.5">{sub}</p>}
        </div>
        <div className="p-2 bg-primary/10 rounded-lg text-primary">{icon}</div>
      </div>
    </div>
  );
}

export function AttributeListPage({ hooksConfig, typeSingular, title, permissionKey, attributeType, showFeaturedToggle, showDescription }: Props) {
  const { isOwner, allowedPages } = useWorkspaceRole();
  const canCreate = isOwner || (allowedPages ?? []).includes(`${permissionKey}.create`);
  const canEdit = isOwner || (allowedPages ?? []).includes(`${permissionKey}.edit`);
  const canDelete = isOwner || (allowedPages ?? []).includes(`${permissionKey}.delete`);
  const { toast } = useToast();
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [page, setPage] = useState(1);
  const [formItem, setFormItem] = useState<CatalogAttribute | null | undefined>(undefined);
  const [cityPanelItem, setCityPanelItem] = useState<CatalogAttribute | null>(null);
  const [productsPanelItem, setProductsPanelItem] = useState<CatalogAttribute | null>(null);
  const [cityPickerOpen, setCityPickerOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<CatalogAttribute | null>(null);

  const listParams = {
    ...(search.trim() ? { q: search.trim() } : {}),
    ...(statusFilter !== "all" ? { status: statusFilter as "active" | "inactive" } : {}),
    page,
    pageSize: 25 as const,
  };

  const { data, isLoading } = hooksConfig.useList(listParams);

  const deleteMutation = hooksConfig.useDelete();
  const updateMutation = hooksConfig.useUpdate();

  function handleFeaturedToggle(item: CatalogAttribute) {
    updateMutation.mutate(
      { id: item.id, data: { is_featured: !item.is_featured } },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: hooksConfig.getListQueryKey() });
        },
        onError: () => {
          toast({ title: "Failed to update featured status", variant: "destructive" });
        },
      },
    );
  }

  function handleDelete(id: number) {
    deleteMutation.mutate(
      { id },
      {
        onSuccess: () => {
          toast({ title: `${typeSingular} deleted` });
          queryClient.invalidateQueries({ queryKey: hooksConfig.getListQueryKey() });
          setDeleteTarget(null);
        },
        onError: (err: unknown) => {
          const msg = err instanceof Error ? err.message : "Delete failed";
          toast({ title: msg, variant: "destructive" });
          setDeleteTarget(null);
        },
      },
    );
  }

  const items = data?.items ?? [];
  const total = data?.total ?? 0;
  const totalPages = data?.totalPages ?? 1;
  const activeCount = items.filter((i: CatalogAttribute) => i.is_active).length;
  const totalEnabledCities = items.reduce((s: number, i: CatalogAttribute) => s + parseInt(String(i.enabled_city_count), 10), 0);
  const avgEnabledCities = items.length > 0 ? Math.round(totalEnabledCities / items.length) : 0;
  const inactiveCount = items.filter((i: CatalogAttribute) => !i.is_active).length;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">{title}</h1>
          <p className="text-muted-foreground text-sm mt-0.5">Manage {title.toLowerCase()} for your product catalog</p>
        </div>
        {canCreate && (
          <Button onClick={() => setFormItem(null)}>
            <Plus size={16} className="mr-2" />
            New {typeSingular}
          </Button>
        )}
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <StatCard label="Total" value={total || items.length} icon={<Tag size={18} />} />
        <StatCard label="Globally Active" value={activeCount} sub={`${items.length > 0 ? Math.round((activeCount / items.length) * 100) : 0}% of total`} icon={<CheckCircle size={18} />} />
        <StatCard label="Avg. Enabled Cities" value={avgEnabledCities} sub="per attribute" icon={<Globe size={18} />} />
        <StatCard label="Inactive Globally" value={inactiveCount} icon={<XCircle size={18} />} />
      </div>

      <div className="bg-card border border-border rounded-xl">
        <div className="flex flex-col sm:flex-row gap-3 p-4 border-b border-border">
          <div className="relative flex-1">
            <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
            <Input
              placeholder={`Search ${title.toLowerCase()}...`}
              value={search}
              onChange={(e) => { setSearch(e.target.value); setPage(1); }}
              className="pl-8"
            />
          </div>
          <Select value={statusFilter} onValueChange={(v) => { setStatusFilter(v); setPage(1); }}>
            <SelectTrigger className="w-[140px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Statuses</SelectItem>
              <SelectItem value="active">Active</SelectItem>
              <SelectItem value="inactive">Inactive</SelectItem>
            </SelectContent>
          </Select>
          {isOwner && (
            <Button
              variant="outline"
              disabled={items.length === 0}
              onClick={() => {
                if (items.length === 1) {
                  setCityPanelItem(items[0]);
                } else {
                  setCityPickerOpen(true);
                }
              }}
            >
              <Globe size={16} className="mr-2" />
              Manage City Availability
            </Button>
          )}
        </div>

        {isLoading ? (
          <div className="space-y-3 p-4">
            {Array.from({ length: 5 }).map((_, i) => (
              <Skeleton key={i} className="h-12 rounded-md" />
            ))}
          </div>
        ) : items.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-16 text-center">
            <Tag size={40} className="text-muted-foreground mb-3" />
            <p className="font-medium">No {title.toLowerCase()} found</p>
            <p className="text-sm text-muted-foreground mt-1">
              {search || statusFilter !== "all" ? "Try adjusting your filters" : `Create your first ${typeSingular.toLowerCase()}`}
            </p>
            {canCreate && !search && statusFilter === "all" && (
              <Button className="mt-4" onClick={() => setFormItem(null)}>
                <Plus size={16} className="mr-2" />
                New {typeSingular}
              </Button>
            )}
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border bg-muted/30">
                  <th className="text-left px-4 py-3 font-medium text-muted-foreground">Name</th>
                  <th className="text-left px-4 py-3 font-medium text-muted-foreground">Slug</th>
                  {showDescription && (
                    <th className="text-left px-4 py-3 font-medium text-muted-foreground">Description</th>
                  )}
                  <th className="text-left px-4 py-3 font-medium text-muted-foreground">Status</th>
                  {showFeaturedToggle && (
                    <th className="text-left px-4 py-3 font-medium text-muted-foreground">Featured</th>
                  )}
                  <th className="text-left px-4 py-3 font-medium text-muted-foreground">Enabled Cities</th>
                  <th className="text-left px-4 py-3 font-medium text-muted-foreground">Products</th>
                  <th className="text-left px-4 py-3 font-medium text-muted-foreground">Sort</th>
                  <th className="text-right px-4 py-3 font-medium text-muted-foreground">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {items.map((item: CatalogAttribute) => (
                  <tr key={item.id} className="hover:bg-muted/20 transition-colors">
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-3">
                        {item.image_url ? (
                          <img src={imageUrl(item.image_url) ?? item.image_url} alt="" className="w-8 h-8 rounded object-cover border border-border shrink-0" onError={(e) => { (e.target as HTMLImageElement).style.display = "none"; }} />
                        ) : (
                          <div className="w-8 h-8 rounded border border-border shrink-0 flex items-center justify-center bg-muted/40">
                            <ImageIcon size={14} className="text-muted-foreground" />
                          </div>
                        )}
                        <span className="font-medium">{item.name}</span>
                      </div>
                    </td>
                    <td className="px-4 py-3 text-muted-foreground font-mono text-xs">{item.slug}</td>
                    {showDescription && (
                      <td className="px-4 py-3 text-muted-foreground max-w-xs">
                        {item.description ? (
                          <span className="line-clamp-2">{item.description}</span>
                        ) : (
                          <span className="text-muted-foreground/50">—</span>
                        )}
                      </td>
                    )}
                    <td className="px-4 py-3">
                      <Badge variant={item.is_active ? "default" : "secondary"}>
                        {item.is_active ? "Active" : "Inactive"}
                      </Badge>
                    </td>
                    {showFeaturedToggle && (
                      <td className="px-4 py-3">
                        <div className="flex items-center gap-2">
                          <Switch
                            checked={!!item.is_featured}
                            disabled={!isOwner || updateMutation.isPending}
                            onCheckedChange={() => handleFeaturedToggle(item)}
                            aria-label="Featured in mega menu"
                          />
                          {item.is_featured && (
                            <span className="text-xs text-muted-foreground">Mega menu</span>
                          )}
                        </div>
                      </td>
                    )}
                    <td className="px-4 py-3 text-muted-foreground">{parseInt(String(item.enabled_city_count), 10)}</td>
                    <td className="px-4 py-3 text-muted-foreground">
                      {Number.isFinite(parseInt(String(item.product_count), 10)) ? (
                        <button
                          type="button"
                          className="font-medium text-primary hover:underline underline-offset-2"
                          onClick={() => setProductsPanelItem(item)}
                        >
                          {parseInt(String(item.product_count), 10)}
                        </button>
                      ) : (
                        parseInt(String(item.product_count), 10)
                      )}
                    </td>
                    <td className="px-4 py-3 text-muted-foreground">{item.sort_order}</td>
                    <td className="px-4 py-3">
                      <div className="flex items-center justify-end gap-2">
                        {isOwner && (
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-8 w-8"
                            title="Manage city availability"
                            onClick={() => setCityPanelItem(item)}
                          >
                            <Globe size={15} />
                          </Button>
                        )}
                        {(canEdit || canDelete) && (
                          <DropdownMenu>
                            <DropdownMenuTrigger asChild>
                              <Button variant="ghost" size="icon" className="h-8 w-8">
                                <MoreHorizontal size={15} />
                              </Button>
                            </DropdownMenuTrigger>
                            <DropdownMenuContent align="end">
                              {canEdit && (
                                <DropdownMenuItem onClick={() => setFormItem(item)}>
                                  <Pencil size={14} className="mr-2" />
                                  Edit
                                </DropdownMenuItem>
                              )}
                              {canDelete && (
                                <DropdownMenuItem
                                  className="text-destructive focus:text-destructive"
                                  onClick={() => setDeleteTarget(item)}
                                >
                                  <Trash2 size={14} className="mr-2" />
                                  Delete
                                </DropdownMenuItem>
                              )}
                            </DropdownMenuContent>
                          </DropdownMenu>
                        )}
                        {!isOwner && (
                          <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => setCityPanelItem(item)}>
                            <Globe size={15} />
                          </Button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {totalPages > 1 && (
          <div className="flex items-center justify-between px-4 py-3 border-t border-border">
            <p className="text-sm text-muted-foreground">Page {page} of {totalPages}</p>
            <div className="flex gap-2">
              <Button variant="outline" size="sm" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>Previous</Button>
              <Button variant="outline" size="sm" disabled={page >= totalPages} onClick={() => setPage((p) => p + 1)}>Next</Button>
            </div>
          </div>
        )}
      </div>

      {formItem !== undefined && (
        <AttributeFormSheet
          hooksConfig={hooksConfig}
          typeSingular={typeSingular}
          attributeType={attributeType}
          item={formItem}
          onClose={() => setFormItem(undefined)}
        />
      )}

      {cityPanelItem && (
        <CityAvailabilityPanel
          hooksConfig={hooksConfig}
          item={cityPanelItem}
          onClose={() => setCityPanelItem(null)}
        />
      )}

      {productsPanelItem && (
        <AttributeProductsPanel
          item={productsPanelItem}
          attributeType={attributeType}
          onClose={() => setProductsPanelItem(null)}
        />
      )}

      <Dialog open={cityPickerOpen} onOpenChange={setCityPickerOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Select {typeSingular}</DialogTitle>
            <DialogDescription>
              Choose which {typeSingular.toLowerCase()} to manage city availability for.
            </DialogDescription>
          </DialogHeader>
          <div className="mt-2 max-h-80 overflow-y-auto divide-y divide-border rounded-md border border-border">
            {items.map((item: CatalogAttribute) => (
              <button
                key={item.id}
                className="w-full flex items-center gap-3 px-4 py-3 text-left hover:bg-muted/40 transition-colors"
                onClick={() => {
                  setCityPickerOpen(false);
                  setCityPanelItem(item);
                }}
              >
                {item.image_url ? (
                  <img src={imageUrl(item.image_url) ?? item.image_url} alt="" className="w-8 h-8 rounded object-cover border border-border shrink-0" onError={(e) => { (e.target as HTMLImageElement).style.display = "none"; }} />
                ) : (
                  <div className="w-8 h-8 rounded border border-border shrink-0 flex items-center justify-center bg-muted/40">
                    <ImageIcon size={14} className="text-muted-foreground" />
                  </div>
                )}
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium truncate">{item.name}</p>
                  <p className="text-xs text-muted-foreground">{parseInt(String(item.enabled_city_count), 10)} cities enabled</p>
                </div>
                <Badge variant={item.is_active ? "default" : "secondary"} className="shrink-0">
                  {item.is_active ? "Active" : "Inactive"}
                </Badge>
              </button>
            ))}
          </div>
        </DialogContent>
      </Dialog>

      <AlertDialog open={!!deleteTarget} onOpenChange={(open) => { if (!open) setDeleteTarget(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete {typeSingular}</AlertDialogTitle>
            <AlertDialogDescription>
              Are you sure you want to delete &quot;{deleteTarget?.name}&quot;?
              {parseInt(String(deleteTarget?.product_count ?? 0), 10) > 0 && (
                <span className="block mt-1 text-destructive font-medium">
                  This {typeSingular.toLowerCase()} has {deleteTarget?.product_count} product(s) assigned and cannot be deleted.
                </span>
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={() => deleteTarget && handleDelete(deleteTarget.id)}
              disabled={deleteMutation.isPending || parseInt(String(deleteTarget?.product_count ?? 0), 10) > 0}
            >
              {deleteMutation.isPending ? "Deleting…" : "Delete"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

import { useState, useMemo } from "react";
import { imageUrl } from "@/lib/imageUrl";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  FlaskConical,
  Plus,
  Pencil,
  Trash2,
  ChevronDown,
  ChevronRight,
  AlertTriangle,
  Archive,
  GitMerge,
  ArrowUp,
  ArrowDown,
  Search,
  Box,
  Tag,
  BarChart2,
  ListTree,
  Activity,
} from "lucide-react";
import { apiFetch } from "@/lib/queryClient";
import { BaseItemImageThumbnail } from "@/components/BaseItemImageThumbnail";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
  DialogTrigger,
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
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import { useWorkspaceRole } from "@/hooks/use-workspace-role";
import { cn } from "@/lib/utils";
import type {
  BaseItemCategoryWithSubs,
  BaseItemCategoryRow,
  BaseItemCategoryStatsResponse,
  CategoryBaseItemsResponse,
} from "@workspace/api-client-react";

const MAX_CATEGORY_NAME = 100;
const QUERY_KEY = ["base-item-categories"];

function useStats() {
  return useQuery<BaseItemCategoryStatsResponse>({
    queryKey: ["base-item-categories-stats"],
    queryFn: () => apiFetch("/api/base-item-categories/stats"),
  });
}

function useCategories(search: string, status: string) {
  return useQuery<{ categories: BaseItemCategoryWithSubs[] }>({
    queryKey: [...QUERY_KEY, search, status],
    queryFn: () => {
      const p = new URLSearchParams();
      if (search) p.set("search", search);
      if (status && status !== "all") p.set("status", status);
      return apiFetch(`/api/base-item-categories${p.toString() ? `?${p}` : ""}`);
    },
  });
}

function useCategoryBaseItems(id: number | null) {
  return useQuery<CategoryBaseItemsResponse>({
    queryKey: ["base-item-category-items", id],
    queryFn: () => apiFetch(`/api/base-item-categories/${id}/base-items`),
    enabled: id !== null,
  });
}

interface StatCardProps {
  label: string;
  value: number;
  icon: React.ReactNode;
  variant?: "default" | "warning";
}

function StatCard({ label, value, icon, variant = "default" }: StatCardProps) {
  return (
    <Card className={cn(variant === "warning" && value > 0 && "border-amber-400")}>
      <CardContent className="p-4 flex items-center gap-3">
        <div
          className={cn(
            "flex items-center justify-center w-10 h-10 rounded-lg",
            variant === "warning" && value > 0
              ? "bg-amber-100 text-amber-600 dark:bg-amber-900/30 dark:text-amber-400"
              : "bg-secondary text-muted-foreground",
          )}
        >
          {icon}
        </div>
        <div>
          <p className="text-2xl font-bold leading-none">{value}</p>
          <p className="text-xs text-muted-foreground mt-0.5">{label}</p>
        </div>
      </CardContent>
    </Card>
  );
}

interface CreateCategoryDialogProps {
  parentId?: number | null;
  parentName?: string;
  onSuccess: () => void;
  trigger: React.ReactNode;
}

function CreateCategoryDialog({ parentId, parentName, onSuccess, trigger }: CreateCategoryDialogProps) {
  const { toast } = useToast();
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [categoryType, setCategoryType] = useState("");
  const [error, setError] = useState<string | null>(null);

  const mutation = useMutation({
    mutationFn: (body: object) =>
      apiFetch("/api/base-item-categories", { method: "POST", body: JSON.stringify(body) }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: QUERY_KEY });
      qc.invalidateQueries({ queryKey: ["base-item-categories-stats"] });
      setOpen(false);
      setName("");
      setDescription("");
      setCategoryType("");
      setError(null);
      toast({ title: parentId ? "Subcategory created" : "Category created" });
      onSuccess();
    },
    onError: (err: Error) => {
      const msg = err.message ?? "";
      if (msg.includes("already exists")) {
        setError(msg);
      } else {
        toast({ title: "Failed to create category", variant: "destructive" });
      }
    },
  });

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) { setError("Name is required"); return; }
    if (trimmed.length > MAX_CATEGORY_NAME) { setError(`Max ${MAX_CATEGORY_NAME} characters`); return; }
    setError(null);
    mutation.mutate({
      name: trimmed,
      ...(parentId != null ? { parent_id: parentId } : {}),
      ...(description.trim() ? { description: description.trim() } : {}),
      ...(categoryType.trim() ? { category_type: categoryType.trim() } : {}),
    });
  }

  return (
    <Dialog open={open} onOpenChange={(v) => { setOpen(v); if (!v) { setName(""); setDescription(""); setCategoryType(""); setError(null); } }}>
      <DialogTrigger asChild>{trigger}</DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{parentId ? `Add Subcategory to "${parentName}"` : "New Category"}</DialogTitle>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="cat-name">Name *</Label>
            <Input
              id="cat-name"
              autoFocus
              value={name}
              onChange={(e) => { setName(e.target.value); setError(null); }}
              placeholder="e.g. Packaging Materials"
              maxLength={MAX_CATEGORY_NAME}
              className={cn(error && "border-destructive focus-visible:ring-destructive")}
            />
            {error && <p className="text-xs text-destructive">{error}</p>}
            {!error && name.length > 80 && (
              <p className={cn("text-xs", name.length >= MAX_CATEGORY_NAME ? "text-destructive" : "text-muted-foreground")}>
                {name.length} / {MAX_CATEGORY_NAME}
              </p>
            )}
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="cat-desc">Description</Label>
            <Textarea
              id="cat-desc"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Optional description…"
              rows={2}
              className="resize-none"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="cat-type">Category Type</Label>
            <Input
              id="cat-type"
              value={categoryType}
              onChange={(e) => setCategoryType(e.target.value)}
              placeholder="e.g. Material, Consumable…"
            />
          </div>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => setOpen(false)}>Cancel</Button>
            <Button type="submit" disabled={mutation.isPending}>
              {mutation.isPending ? "Creating…" : "Create"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

interface EditCategoryDialogProps {
  category: BaseItemCategoryRow;
  onSuccess: () => void;
  trigger: React.ReactNode;
}

function EditCategoryDialog({ category, onSuccess, trigger }: EditCategoryDialogProps) {
  const { toast } = useToast();
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState(category.name);
  const [description, setDescription] = useState(category.description ?? "");
  const [categoryType, setCategoryType] = useState(category.category_type ?? "");
  const [error, setError] = useState<string | null>(null);

  function resetAndClose() {
    setOpen(false);
    setName(category.name);
    setDescription(category.description ?? "");
    setCategoryType(category.category_type ?? "");
    setError(null);
  }

  const mutation = useMutation({
    mutationFn: (body: object) =>
      apiFetch(`/api/base-item-categories/${category.id}`, { method: "PATCH", body: JSON.stringify(body) }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: QUERY_KEY });
      resetAndClose();
      toast({ title: "Category updated" });
      onSuccess();
    },
    onError: (err: Error) => {
      const msg = err.message ?? "";
      if (msg.includes("already exists")) {
        setError(msg);
      } else {
        toast({ title: "Failed to update category", variant: "destructive" });
      }
    },
  });

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) { setError("Name is required"); return; }
    if (trimmed.length > MAX_CATEGORY_NAME) { setError(`Max ${MAX_CATEGORY_NAME} characters`); return; }
    setError(null);
    mutation.mutate({
      name: trimmed,
      description: description.trim() || null,
      category_type: categoryType.trim() || null,
    });
  }

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v) resetAndClose(); else setOpen(true); }}>
      <DialogTrigger asChild>{trigger}</DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Edit Category</DialogTitle>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="edit-cat-name">Name *</Label>
            <Input
              id="edit-cat-name"
              autoFocus
              value={name}
              onChange={(e) => { setName(e.target.value); setError(null); }}
              maxLength={MAX_CATEGORY_NAME}
              className={cn(error && "border-destructive focus-visible:ring-destructive")}
            />
            {error && <p className="text-xs text-destructive">{error}</p>}
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="edit-cat-desc">Description</Label>
            <Textarea
              id="edit-cat-desc"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={2}
              className="resize-none"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="edit-cat-type">Category Type</Label>
            <Input
              id="edit-cat-type"
              value={categoryType}
              onChange={(e) => setCategoryType(e.target.value)}
              placeholder="e.g. Material, Consumable…"
            />
          </div>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={resetAndClose}>Cancel</Button>
            <Button type="submit" disabled={mutation.isPending}>
              {mutation.isPending ? "Saving…" : "Save Changes"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

interface MergeDialogProps {
  sourceCategory: BaseItemCategoryRow;
  allCategories: BaseItemCategoryWithSubs[];
  onSuccess: () => void;
  trigger: React.ReactNode;
}

function MergeDialog({ sourceCategory, allCategories, onSuccess, trigger }: MergeDialogProps) {
  const { toast } = useToast();
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [targetId, setTargetId] = useState<string>("");

  const mutation = useMutation({
    mutationFn: () =>
      apiFetch("/api/base-item-categories/merge", {
        method: "POST",
        body: JSON.stringify({ source_id: sourceCategory.id, target_id: parseInt(targetId, 10) }),
      }),
    onSuccess: (data: { moved_items: number; moved_children: number }) => {
      qc.invalidateQueries({ queryKey: QUERY_KEY });
      qc.invalidateQueries({ queryKey: ["base-item-categories-stats"] });
      setOpen(false);
      setTargetId("");
      toast({ title: `Merged: ${data.moved_items} items and ${data.moved_children} sub-categories moved.` });
      onSuccess();
    },
    onError: () => {
      toast({ title: "Failed to merge categories", variant: "destructive" });
    },
  });

  const targets = allCategories.filter((c) => c.id !== sourceCategory.id && c.status !== "archived");

  return (
    <Dialog open={open} onOpenChange={(v) => { setOpen(v); if (!v) setTargetId(""); }}>
      <DialogTrigger asChild>{trigger}</DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Merge "{sourceCategory.name}"</DialogTitle>
        </DialogHeader>
        <div className="space-y-4 py-1">
          <p className="text-sm text-muted-foreground">
            All base items and sub-categories will be moved to the target category. The source will be archived.
          </p>
          <div className="space-y-1.5">
            <Label>Move contents into…</Label>
            <Select value={targetId} onValueChange={setTargetId}>
              <SelectTrigger>
                <SelectValue placeholder="Select target category…" />
              </SelectTrigger>
              <SelectContent>
                {targets.map((c) => (
                  <SelectItem key={c.id} value={String(c.id)}>{c.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>
        <DialogFooter>
          <Button type="button" variant="ghost" onClick={() => setOpen(false)}>Cancel</Button>
          <Button
            variant="destructive"
            disabled={!targetId || mutation.isPending}
            onClick={() => mutation.mutate()}
          >
            {mutation.isPending ? "Merging…" : "Merge & Archive Source"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

interface CategoryTreeItemProps {
  cat: BaseItemCategoryWithSubs;
  selected: number | null;
  onSelect: (id: number) => void;
  expanded: boolean;
  onToggle: () => void;
  canEdit: boolean;
  canDelete: boolean;
  canCreate: boolean;
  allCategories: BaseItemCategoryWithSubs[];
}

function CategoryTreeItem({
  cat,
  selected,
  onSelect,
  expanded,
  onToggle,
  canEdit,
  canDelete,
  canCreate,
  allCategories,
}: CategoryTreeItemProps) {
  const { toast } = useToast();
  const qc = useQueryClient();

  const archiveMutation = useMutation({
    mutationFn: () => apiFetch(`/api/base-item-categories/${cat.id}/archive`, { method: "POST" }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: QUERY_KEY });
      toast({ title: "Category archived" });
    },
    onError: () => toast({ title: "Failed to archive", variant: "destructive" }),
  });

  const deleteMutation = useMutation({
    mutationFn: () => apiFetch(`/api/base-item-categories/${cat.id}`, { method: "DELETE" }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: QUERY_KEY });
      qc.invalidateQueries({ queryKey: ["base-item-categories-stats"] });
      toast({ title: "Category deleted" });
    },
    onError: (err: Error) => {
      const msg = err.message?.includes("base items are assigned")
        ? "Cannot delete: base items are assigned to this category."
        : "Failed to delete category.";
      toast({ title: msg, variant: "destructive" });
    },
  });

  const reorderMutation = useMutation({
    mutationFn: (direction: "up" | "down") =>
      apiFetch(`/api/base-item-categories/${cat.id}/reorder`, {
        method: "POST",
        body: JSON.stringify({ direction }),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: QUERY_KEY }),
    onError: () => toast({ title: "Failed to reorder", variant: "destructive" }),
  });

  const isSelected = selected === cat.id;
  const hasChildren = cat.subcategories.length > 0;
  const isArchived = cat.status === "archived";

  return (
    <div>
      <div
        className={cn(
          "flex items-center gap-1 px-2 py-1.5 rounded-md cursor-pointer group transition-colors text-sm",
          isSelected ? "bg-primary/10 text-primary font-medium" : "hover:bg-secondary/60",
          isArchived && "opacity-50",
        )}
        onClick={() => onSelect(cat.id)}
      >
        <button
          type="button"
          className="flex-shrink-0 text-muted-foreground hover:text-foreground w-4 h-4 flex items-center justify-center"
          onClick={(e) => { e.stopPropagation(); if (hasChildren) onToggle(); }}
        >
          {hasChildren ? (
            expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />
          ) : (
            <span className="w-3" />
          )}
        </button>
        <Tag size={13} className={cn("flex-shrink-0", isSelected ? "text-primary" : "text-muted-foreground")} />
        <span className="flex-1 truncate">{cat.name}</span>
        <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
          {cat.base_item_count > 0 && (
            <span className="text-xs text-muted-foreground mr-1">{cat.base_item_count}</span>
          )}
          {!isArchived && canEdit && (
            <button
              type="button"
              className="p-0.5 rounded hover:bg-secondary text-muted-foreground hover:text-foreground"
              title="Move up"
              onClick={(e) => { e.stopPropagation(); reorderMutation.mutate("up"); }}
            >
              <ArrowUp size={11} />
            </button>
          )}
          {!isArchived && canEdit && (
            <button
              type="button"
              className="p-0.5 rounded hover:bg-secondary text-muted-foreground hover:text-foreground"
              title="Move down"
              onClick={(e) => { e.stopPropagation(); reorderMutation.mutate("down"); }}
            >
              <ArrowDown size={11} />
            </button>
          )}
        </div>
        {isArchived && <Badge variant="outline" className="text-xs h-4 px-1">Archived</Badge>}
        {cat.subcategories.length > 0 && (
          <Badge variant="secondary" className="text-xs h-4 px-1">{cat.subcategories.length}</Badge>
        )}
      </div>
      {expanded && cat.subcategories.length > 0 && (
        <div className="ml-5 border-l border-border pl-2 mt-0.5 space-y-0.5">
          {cat.subcategories.map((sub) => (
            <div
              key={sub.id}
              className={cn(
                "flex items-center gap-1.5 px-2 py-1 rounded-md cursor-pointer group transition-colors text-sm",
                selected === sub.id ? "bg-primary/10 text-primary font-medium" : "hover:bg-secondary/60",
                sub.status === "archived" && "opacity-50",
              )}
              onClick={() => onSelect(sub.id)}
            >
              <Tag size={11} className={cn("flex-shrink-0", selected === sub.id ? "text-primary" : "text-muted-foreground")} />
              <span className="flex-1 truncate">{sub.name}</span>
              {sub.status === "archived" && (
                <Badge variant="outline" className="text-xs h-4 px-1">Archived</Badge>
              )}
              {sub.base_item_count > 0 && (
                <span className="text-xs text-muted-foreground">{sub.base_item_count}</span>
              )}
            </div>
          ))}
          {canCreate && (
            <div className="px-2 py-0.5">
              <CreateCategoryDialog
                parentId={cat.id}
                parentName={cat.name}
                onSuccess={() => {}}
                trigger={
                  <button
                    type="button"
                    className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
                  >
                    <Plus size={10} /> Add sub
                  </button>
                }
              />
            </div>
          )}
        </div>
      )}
    </div>
  );
}

interface OverviewTabProps {
  category: BaseItemCategoryWithSubs | BaseItemCategoryRow;
  canEdit: boolean;
  canDelete: boolean;
  allCategories: BaseItemCategoryWithSubs[];
  onDeleted: () => void;
}

function OverviewTab({ category, canEdit, canDelete, allCategories, onDeleted }: OverviewTabProps) {
  const { toast } = useToast();
  const qc = useQueryClient();

  const archiveMutation = useMutation({
    mutationFn: () => apiFetch(`/api/base-item-categories/${category.id}/archive`, { method: "POST" }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: QUERY_KEY });
      toast({ title: "Category archived" });
    },
    onError: () => toast({ title: "Failed to archive", variant: "destructive" }),
  });

  const deleteMutation = useMutation({
    mutationFn: () => apiFetch(`/api/base-item-categories/${category.id}`, { method: "DELETE" }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: QUERY_KEY });
      qc.invalidateQueries({ queryKey: ["base-item-categories-stats"] });
      toast({ title: "Category deleted" });
      onDeleted();
    },
    onError: (err: Error) => {
      const msg = err.message?.includes("base items are assigned")
        ? "Cannot delete: base items are assigned to this category."
        : "Failed to delete category.";
      toast({ title: msg, variant: "destructive" });
    },
  });

  const isArchived = category.status === "archived";

  return (
    <div className="space-y-5">
      <div className="flex items-start justify-between gap-4">
        <div className="flex-1 space-y-3">
          <div className="space-y-0.5">
            <p className="text-xs text-muted-foreground uppercase tracking-wide font-medium">Description</p>
            <p className="text-sm">
              {category.description || <span className="text-muted-foreground italic">No description</span>}
            </p>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-0.5">
              <p className="text-xs text-muted-foreground uppercase tracking-wide font-medium">Category Type</p>
              <p className="text-sm">{category.category_type || <span className="italic text-muted-foreground">—</span>}</p>
            </div>
            <div className="space-y-0.5">
              <p className="text-xs text-muted-foreground uppercase tracking-wide font-medium">Status</p>
              <Badge variant={isArchived ? "outline" : "secondary"} className={cn(!isArchived && "border-green-400 text-green-700 dark:text-green-400 bg-green-50 dark:bg-green-900/20")}>
                {isArchived ? "Archived" : "Active"}
              </Badge>
            </div>
            <div className="space-y-0.5">
              <p className="text-xs text-muted-foreground uppercase tracking-wide font-medium">Base Items</p>
              <p className="text-sm font-semibold">{category.base_item_count}</p>
            </div>
            <div className="space-y-0.5">
              <p className="text-xs text-muted-foreground uppercase tracking-wide font-medium">Sub-categories</p>
              <p className="text-sm font-semibold">{"child_count" in category ? category.child_count : ("subcategories" in category ? (category as BaseItemCategoryWithSubs).subcategories?.length ?? 0 : 0)}</p>
            </div>
            <div className="space-y-0.5">
              <p className="text-xs text-muted-foreground uppercase tracking-wide font-medium">Created</p>
              <p className="text-sm">{new Date(category.created_at).toLocaleDateString()}</p>
            </div>
            {category.updated_at && (
              <div className="space-y-0.5">
                <p className="text-xs text-muted-foreground uppercase tracking-wide font-medium">Last Updated</p>
                <p className="text-sm">{new Date(category.updated_at).toLocaleDateString()}</p>
              </div>
            )}
          </div>
        </div>
      </div>

      {canEdit && (
        <div className="flex flex-wrap items-center gap-2 pt-2 border-t border-border">
          <EditCategoryDialog
            category={category}
            onSuccess={() => {}}
            trigger={
              <Button size="sm" variant="outline">
                <Pencil size={13} className="mr-1.5" />
                Edit
              </Button>
            }
          />
          {!isArchived && (
            <AlertDialog>
              <AlertDialogTrigger asChild>
                <Button size="sm" variant="outline" disabled={archiveMutation.isPending}>
                  <Archive size={13} className="mr-1.5" />
                  Archive
                </Button>
              </AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>Archive "{category.name}"?</AlertDialogTitle>
                  <AlertDialogDescription>
                    The category will be hidden from active use but not deleted. You can restore it later via the status filter.
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel>Cancel</AlertDialogCancel>
                  <AlertDialogAction onClick={() => archiveMutation.mutate()}>Archive</AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          )}
          {!isArchived && (
            <MergeDialog
              sourceCategory={category}
              allCategories={allCategories}
              onSuccess={onDeleted}
              trigger={
                <Button size="sm" variant="outline">
                  <GitMerge size={13} className="mr-1.5" />
                  Merge Into…
                </Button>
              }
            />
          )}
          {canDelete && (
            <AlertDialog>
              <AlertDialogTrigger asChild>
                <Button size="sm" variant="outline" className="text-destructive hover:text-destructive border-destructive/30 hover:bg-destructive/5">
                  <Trash2 size={13} className="mr-1.5" />
                  Delete
                </Button>
              </AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>Delete "{category.name}"?</AlertDialogTitle>
                  <AlertDialogDescription>
                    This action cannot be undone. The category must have no base items assigned or sub-categories with items.
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel>Cancel</AlertDialogCancel>
                  <AlertDialogAction
                    className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                    onClick={() => deleteMutation.mutate()}
                  >
                    Delete
                  </AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          )}
        </div>
      )}
    </div>
  );
}

interface BaseItemsTabProps {
  categoryId: number;
}

function BaseItemsTab({ categoryId }: BaseItemsTabProps) {
  const { data, isLoading } = useCategoryBaseItems(categoryId);
  const items = data?.items ?? [];

  if (isLoading) {
    return <p className="text-sm text-muted-foreground py-4">Loading…</p>;
  }
  if (items.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center gap-2 py-10 text-center">
        <Box size={32} className="text-muted-foreground/40" />
        <p className="text-sm text-muted-foreground">No base items in this category</p>
      </div>
    );
  }
  return (
    <div className="space-y-1">
      {items.map((item) => (
        <div key={item.id} className="flex items-center gap-3 px-2 py-2 rounded-md hover:bg-secondary/40 group">
          <BaseItemImageThumbnail imageUrl={imageUrl(item.image_url)} name={item.name} size={8} />
          <div className="flex-1 min-w-0">
            <p className="text-sm font-medium truncate">{item.name}</p>
            <p className="text-xs text-muted-foreground">{item.code}{item.supplier_name ? ` · ${item.supplier_name}` : ""}</p>
          </div>
          <a
            href={`/dashboard/base-items/${item.id}`}
            className="text-xs text-primary opacity-0 group-hover:opacity-100 transition-opacity"
          >
            View →
          </a>
        </div>
      ))}
    </div>
  );
}

interface ActivityTabProps {
  category: BaseItemCategoryRow;
}

function ActivityTab({ category }: ActivityTabProps) {
  const events = useMemo(() => {
    const list = [];
    if (category.created_at) {
      list.push({
        type: "created",
        date: category.created_at,
        by: category.created_by,
        label: "Category created",
      });
    }
    if (category.updated_at && category.updated_at !== category.created_at) {
      list.push({
        type: "updated",
        date: category.updated_at,
        by: category.updated_by,
        label: "Category updated",
      });
    }
    if (category.status === "archived" && category.updated_at) {
      list.push({
        type: "archived",
        date: category.updated_at,
        by: category.updated_by,
        label: "Category archived",
      });
    }
    return list.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
  }, [category]);

  if (events.length === 0) {
    return <p className="text-sm text-muted-foreground py-4">No activity recorded.</p>;
  }

  return (
    <div className="space-y-3">
      {events.map((ev, i) => (
        <div key={i} className="flex items-start gap-3">
          <div className="flex-shrink-0 w-7 h-7 rounded-full bg-secondary flex items-center justify-center mt-0.5">
            <Activity size={12} className="text-muted-foreground" />
          </div>
          <div>
            <p className="text-sm font-medium">{ev.label}</p>
            <p className="text-xs text-muted-foreground">
              {new Date(ev.date).toLocaleString()}
              {ev.by ? ` by ${ev.by}` : ""}
            </p>
          </div>
        </div>
      ))}
    </div>
  );
}

function findCategoryById(
  categories: BaseItemCategoryWithSubs[],
  id: number,
): BaseItemCategoryWithSubs | BaseItemCategoryRow | null {
  for (const c of categories) {
    if (c.id === id) return c;
    const sub = c.subcategories?.find((s) => s.id === id);
    if (sub) return sub;
  }
  return null;
}

export default function BaseItemCategoriesPage() {
  const { isOwner, allowedPages } = useWorkspaceRole();
  const canCreate = isOwner || (allowedPages?.includes("base-item-categories.create") ?? false);
  const canEdit = isOwner || (allowedPages?.includes("base-item-categories.edit") ?? false);
  const canDelete = isOwner || (allowedPages?.includes("base-item-categories.delete") ?? false);

  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("active");
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [expandedIds, setExpandedIds] = useState<Set<number>>(new Set());

  const { data: statsData, isLoading: statsLoading } = useStats();
  const { data: listData, isLoading: listLoading } = useCategories(search, statusFilter);
  const categories = listData?.categories ?? [];

  const selected = selectedId !== null ? findCategoryById(categories, selectedId) : null;

  function toggleExpand(id: number) {
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function handleSelect(id: number) {
    setSelectedId((prev) => (prev === id ? null : id));
  }

  const stats = statsData ?? { total_categories: 0, total_assigned: 0, uncategorized: 0, need_review: 0 };

  return (
    <div className="space-y-6">
      {/* Page Header */}
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Base Item Categories</h1>
          <p className="text-muted-foreground mt-1">
            Organize and manage the hierarchical categories used to classify base inventory items.
          </p>
        </div>
        {canCreate && (
          <CreateCategoryDialog
            onSuccess={() => {}}
            trigger={
              <Button>
                <Plus size={15} className="mr-1.5" />
                New Category
              </Button>
            }
          />
        )}
      </div>

      {/* Stats Cards */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <StatCard
          label="Total Categories"
          value={statsLoading ? 0 : stats.total_categories}
          icon={<ListTree size={18} />}
        />
        <StatCard
          label="Items Assigned"
          value={statsLoading ? 0 : stats.total_assigned}
          icon={<Box size={18} />}
        />
        <StatCard
          label="Uncategorized Items"
          value={statsLoading ? 0 : stats.uncategorized}
          icon={<AlertTriangle size={18} />}
          variant="warning"
        />
        <StatCard
          label="Need Review"
          value={statsLoading ? 0 : stats.need_review}
          icon={<BarChart2 size={18} />}
        />
      </div>

      {/* Warning Banner */}
      {!statsLoading && stats.uncategorized > 0 && (
        <div className="flex items-center gap-3 px-4 py-3 rounded-lg bg-amber-50 border border-amber-200 dark:bg-amber-900/20 dark:border-amber-800 text-amber-800 dark:text-amber-300">
          <AlertTriangle size={16} className="flex-shrink-0" />
          <p className="text-sm font-medium">
            {stats.uncategorized} base item{stats.uncategorized !== 1 ? "s are" : " is"} not assigned to any category.
            Assign them to a category to improve organization.
          </p>
        </div>
      )}

      {/* Two-Panel Layout */}
      <div className="grid grid-cols-1 lg:grid-cols-[320px_1fr] gap-4 items-start">
        {/* Left Panel: Category Tree */}
        <Card className="lg:sticky lg:top-6">
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center justify-between text-base">
              <span className="flex items-center gap-2">
                <FlaskConical size={16} />
                Categories
              </span>
              {canCreate && (
                <CreateCategoryDialog
                  onSuccess={() => {}}
                  trigger={
                    <Button size="sm" variant="outline" className="h-7 px-2 text-xs">
                      <Plus size={12} className="mr-1" />
                      Add
                    </Button>
                  }
                />
              )}
            </CardTitle>
            {/* Search */}
            <div className="relative mt-1">
              <Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search categories…"
                className="h-8 pl-7 text-sm"
              />
            </div>
            {/* Status filter */}
            <div className="flex gap-1 mt-1">
              {(["active", "archived", "all"] as const).map((s) => (
                <button
                  key={s}
                  type="button"
                  onClick={() => setStatusFilter(s)}
                  className={cn(
                    "text-xs px-2.5 py-0.5 rounded-full border transition-colors",
                    statusFilter === s
                      ? "bg-primary text-primary-foreground border-primary"
                      : "border-border text-muted-foreground hover:text-foreground",
                  )}
                >
                  {s === "all" ? "All" : s.charAt(0).toUpperCase() + s.slice(1)}
                </button>
              ))}
            </div>
          </CardHeader>
          <CardContent className="pb-4">
            {listLoading ? (
              <div className="space-y-2">
                {[1, 2, 3].map((i) => (
                  <div key={i} className="h-7 bg-secondary/60 rounded-md animate-pulse" />
                ))}
              </div>
            ) : categories.length === 0 ? (
              <div className="flex flex-col items-center gap-2 py-8 text-center">
                <Tag size={28} className="text-muted-foreground/40" />
                <p className="text-sm text-muted-foreground">
                  {search ? "No categories match your search" : "No categories yet"}
                </p>
              </div>
            ) : (
              <div className="space-y-0.5">
                {categories.map((cat) => (
                  <CategoryTreeItem
                    key={cat.id}
                    cat={cat}
                    selected={selectedId}
                    onSelect={handleSelect}
                    expanded={expandedIds.has(cat.id)}
                    onToggle={() => toggleExpand(cat.id)}
                    canEdit={canEdit}
                    canDelete={canDelete}
                    canCreate={canCreate}
                    allCategories={categories}
                  />
                ))}
              </div>
            )}
          </CardContent>
        </Card>

        {/* Right Panel: Category Details */}
        {selected ? (
          <Card>
            <CardHeader className="pb-3">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <CardTitle className="text-lg flex items-center gap-2">
                    <Tag size={16} className="text-muted-foreground flex-shrink-0" />
                    <span className="truncate">{selected.name}</span>
                    <Badge
                      variant={selected.status === "archived" ? "outline" : "secondary"}
                      className={cn(
                        "text-xs flex-shrink-0",
                        selected.status !== "archived" && "border-green-400 text-green-700 dark:text-green-400 bg-green-50 dark:bg-green-900/20",
                      )}
                    >
                      {selected.status === "archived" ? "Archived" : "Active"}
                    </Badge>
                  </CardTitle>
                  {selected.parent_id != null && (
                    <p className="text-xs text-muted-foreground mt-0.5">
                      Sub-category · {selected.base_item_count} item{selected.base_item_count !== 1 ? "s" : ""}
                    </p>
                  )}
                </div>
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-7 w-7 p-0 flex-shrink-0"
                  onClick={() => setSelectedId(null)}
                  title="Close"
                >
                  ×
                </Button>
              </div>
            </CardHeader>
            <CardContent>
              <Tabs defaultValue="overview">
                <TabsList className="mb-4">
                  <TabsTrigger value="overview">Overview</TabsTrigger>
                  <TabsTrigger value="base-items">
                    Base Items
                    {selected.base_item_count > 0 && (
                      <Badge variant="secondary" className="ml-1.5 h-4 px-1 text-xs">{selected.base_item_count}</Badge>
                    )}
                  </TabsTrigger>
                  <TabsTrigger value="usage">Usage</TabsTrigger>
                  <TabsTrigger value="activity">Activity</TabsTrigger>
                </TabsList>

                <TabsContent value="overview">
                  <OverviewTab
                    category={selected}
                    canEdit={canEdit}
                    canDelete={canDelete}
                    allCategories={categories}
                    onDeleted={() => setSelectedId(null)}
                  />
                </TabsContent>

                <TabsContent value="base-items">
                  <BaseItemsTab categoryId={selected.id} />
                </TabsContent>

                <TabsContent value="usage">
                  <div className="space-y-4">
                    <div className="grid grid-cols-3 gap-3">
                      <div className="rounded-lg border border-border p-3 text-center">
                        <p className="text-2xl font-bold">{selected.base_item_count}</p>
                        <p className="text-xs text-muted-foreground mt-0.5">Base Items</p>
                      </div>
                      <div className="rounded-lg border border-border p-3 text-center">
                        <p className="text-2xl font-bold">{"child_count" in selected ? selected.child_count : ("subcategories" in selected ? (selected as BaseItemCategoryWithSubs).subcategories?.length ?? 0 : 0)}</p>
                        <p className="text-xs text-muted-foreground mt-0.5">Sub-categories</p>
                      </div>
                      <div className="rounded-lg border border-border p-3 text-center">
                        <p className="text-2xl font-bold">{selected.sort_order}</p>
                        <p className="text-xs text-muted-foreground mt-0.5">Sort Order</p>
                      </div>
                    </div>
                    <p className="text-sm text-muted-foreground">
                      This category is {selected.parent_id == null ? "a top-level" : "a sub-"} category
                      {selected.base_item_count > 0
                        ? ` with ${selected.base_item_count} base item${selected.base_item_count !== 1 ? "s" : ""} assigned.`
                        : " with no items assigned."}
                    </p>
                  </div>
                </TabsContent>

                <TabsContent value="activity">
                  <ActivityTab category={selected} />
                </TabsContent>
              </Tabs>
            </CardContent>
          </Card>
        ) : (
          <div className="flex flex-col items-center justify-center gap-3 py-16 text-center border border-dashed border-border rounded-xl">
            <FlaskConical size={36} className="text-muted-foreground/40" />
            <div>
              <p className="text-sm font-medium">Select a category</p>
              <p className="text-xs text-muted-foreground mt-0.5">Click any category on the left to view details</p>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

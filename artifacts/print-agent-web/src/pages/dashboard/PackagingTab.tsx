import { useState } from "react";
import {
  useListBaseItemPackages,
  useCreateBaseItemPackage,
  useDeleteBaseItemPackage,
  getListBaseItemPackagesQueryKey,
} from "@workspace/api-client-react";
import type { BaseItemPackage } from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Box, Lock, Plus, Trash2, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { useToast } from "@/hooks/use-toast";
import { useWorkspaceRole } from "@/hooks/use-workspace-role";
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

type AddPackagingModalProps = {
  baseItemId: number;
  open: boolean;
  onClose: () => void;
};

function AddPackagingModal({ baseItemId, open, onClose }: AddPackagingModalProps) {
  const { toast } = useToast();
  const qc = useQueryClient();
  const [name, setName] = useState("");
  const [unit, setUnit] = useState("");
  const [quantity, setQuantity] = useState("");
  const [barcode, setBarcode] = useState("");
  const [error, setError] = useState<string | null>(null);

  const createMutation = useCreateBaseItemPackage({
    mutation: {
      onSuccess: () => {
        qc.invalidateQueries({ queryKey: getListBaseItemPackagesQueryKey(baseItemId) });
        toast({ title: "Package added" });
        handleClose();
      },
      onError: (err) => {
        const msg = err instanceof Error ? err.message : "Could not add package";
        setError(msg);
      },
    },
  });

  function handleClose() {
    setName("");
    setUnit("");
    setQuantity("");
    setBarcode("");
    setError(null);
    onClose();
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    const trimmedName = name.trim();
    if (!trimmedName) { setError("Package name is required"); return; }
    const qty = parseInt(quantity, 10);
    if (isNaN(qty) || qty < 2) { setError("Quantity must be greater than 1 for additional packages"); return; }

    createMutation.mutate({
      id: baseItemId,
      data: {
        name: trimmedName,
        unit: unit.trim() || null,
        quantity: qty,
        barcode: barcode.trim() || null,
      },
    });
  }

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v) handleClose(); }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add Packaging</DialogTitle>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="pkg-name">Package Name <span className="text-destructive">*</span></Label>
            <Input
              id="pkg-name"
              value={name}
              onChange={(e) => { setName(e.target.value); setError(null); }}
              placeholder="e.g. Box of 12"
              autoFocus
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="pkg-unit">Unit</Label>
            <Input
              id="pkg-unit"
              value={unit}
              onChange={(e) => setUnit(e.target.value)}
              placeholder="e.g. piece, kg, L"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="pkg-qty">Quantity <span className="text-destructive">*</span></Label>
            <Input
              id="pkg-qty"
              type="number"
              min="2"
              step="1"
              value={quantity}
              onChange={(e) => { setQuantity(e.target.value); setError(null); }}
              placeholder="Must be greater than 1"
            />
            <p className="text-xs text-muted-foreground">Additional packages must contain more than 1 unit.</p>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="pkg-barcode">Barcode (optional)</Label>
            <Input
              id="pkg-barcode"
              value={barcode}
              onChange={(e) => setBarcode(e.target.value)}
              placeholder="e.g. 1234567890123"
            />
          </div>
          {error && <p className="text-sm text-destructive">{error}</p>}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={handleClose} disabled={createMutation.isPending}>Cancel</Button>
            <Button type="submit" disabled={createMutation.isPending}>
              {createMutation.isPending ? <><Loader2 size={14} className="animate-spin mr-1.5" />Adding…</> : "Add Package"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function PackagingTab({ baseItemId }: { baseItemId: number }) {
  const { toast } = useToast();
  const qc = useQueryClient();
  const { isOwner, allowedPages } = useWorkspaceRole();
  const canManage = isOwner || (allowedPages?.includes("base_items.manage") ?? false);

  const { data, isLoading } = useListBaseItemPackages(baseItemId);
  const packages: BaseItemPackage[] = data?.packages ?? [];

  const [showAddModal, setShowAddModal] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<BaseItemPackage | null>(null);

  const deleteMutation = useDeleteBaseItemPackage({
    mutation: {
      onSuccess: () => {
        qc.invalidateQueries({ queryKey: getListBaseItemPackagesQueryKey(baseItemId) });
        toast({ title: "Package removed" });
        setDeleteTarget(null);
      },
      onError: (err) => {
        const msg = err instanceof Error ? err.message : "Could not remove package";
        toast({ title: "Failed to remove package", description: msg, variant: "destructive" });
        setDeleteTarget(null);
      },
    },
  });

  if (isLoading) {
    return (
      <div className="flex items-center gap-2 text-sm text-muted-foreground py-4">
        <Loader2 size={14} className="animate-spin" />
        Loading packages…
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="rounded-lg border border-border overflow-hidden">
        <div className="px-4 py-3 bg-muted/30 border-b border-border flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Box size={14} className="text-muted-foreground" />
            <h3 className="text-sm font-semibold">Packaging Options</h3>
          </div>
          {canManage && (
            <Button size="sm" variant="outline" onClick={() => setShowAddModal(true)}>
              <Plus size={14} className="mr-1.5" />
              Add Packaging
            </Button>
          )}
        </div>

        {packages.length === 0 ? (
          <div className="p-6 text-center text-sm text-muted-foreground">
            <span className="sr-only">Packaging data is not yet available.</span>
            No packages configured yet.
          </div>
        ) : (
          <div className="divide-y divide-border">
            {packages.map((pkg) => (
              <div key={pkg.id} className="flex items-center gap-3 px-4 py-3">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <p className="text-sm font-medium truncate">{pkg.name}</p>
                    {pkg.is_default && (
                      <span className="inline-flex items-center gap-1 text-xs text-muted-foreground bg-muted rounded px-1.5 py-0.5 shrink-0">
                        <Lock size={10} />
                        Default
                      </span>
                    )}
                  </div>
                  <p className="text-xs text-muted-foreground mt-0.5">
                    Qty: {pkg.quantity}{pkg.unit ? ` · ${pkg.unit}` : ""}{pkg.barcode ? ` · Barcode: ${pkg.barcode}` : ""}
                  </p>
                </div>
                {canManage && !pkg.is_default && (
                  <Button
                    size="icon"
                    variant="ghost"
                    className="h-7 w-7 text-muted-foreground hover:text-destructive shrink-0"
                    onClick={() => setDeleteTarget(pkg)}
                  >
                    <Trash2 size={14} />
                  </Button>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      {canManage && (
        <AddPackagingModal
          baseItemId={baseItemId}
          open={showAddModal}
          onClose={() => setShowAddModal(false)}
        />
      )}

      <AlertDialog open={deleteTarget !== null} onOpenChange={(v) => { if (!v) setDeleteTarget(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove package?</AlertDialogTitle>
            <AlertDialogDescription>
              This will permanently remove "{deleteTarget?.name}" from this base item's packaging options.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleteMutation.isPending}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              disabled={deleteMutation.isPending}
              onClick={() => {
                if (deleteTarget) {
                  deleteMutation.mutate({ id: baseItemId, packageId: deleteTarget.id });
                }
              }}
            >
              {deleteMutation.isPending ? <><Loader2 size={14} className="animate-spin mr-1.5" />Removing…</> : "Remove"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

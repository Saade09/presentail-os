import { useState } from "react";
import { useLocation } from "wouter";
import { ShoppingCart, Package } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { StartShiftForm } from "./StartShiftForm";

type Props = {
  productCount?: number;
  isShiftActive: boolean;
  /** When true, the Start Shelf Sale button is disabled until the overdue session is resolved */
  isOverdue?: boolean;
};

export default function CmcPosPrimaryWorkflow({ productCount, isShiftActive, isOverdue }: Props) {
  const inventoryReady = (productCount ?? 0) > 0;
  const [, navigate] = useLocation();
  const [dialogOpen, setDialogOpen] = useState(false);

  function handleStartSale() {
    if (isOverdue) return; // blocked — tooltip explains why
    if (isShiftActive) {
      navigate("/cmc-pos/sale");
    } else {
      setDialogOpen(true);
    }
  }

  const startSaleButton = (
    <button
      type="button"
      data-testid="btn-start-shelf-sale"
      className="inline-flex h-11 items-center justify-center rounded-lg px-6 text-sm font-semibold text-white transition-opacity active:opacity-80 disabled:opacity-50 disabled:cursor-not-allowed"
      style={{ background: isOverdue ? "#6b7280" : "#00414e" }}
      onMouseEnter={(e) => {
        if (!isOverdue) (e.currentTarget as HTMLButtonElement).style.background = "#002d36";
      }}
      onMouseLeave={(e) => {
        if (!isOverdue) (e.currentTarget as HTMLButtonElement).style.background = "#00414e";
      }}
      onClick={handleStartSale}
      disabled={!!isOverdue}
      aria-disabled={!!isOverdue}
    >
      <ShoppingCart className="me-2 h-4 w-4" />
      Start Shelf Sale
    </button>
  );

  return (
    <>
      <div
        className="rounded-xl p-5 shadow-sm"
        style={{ border: "1px solid #b3d1d5", background: "rgba(0,65,78,0.04)" }}
      >
        {/* Label */}
        <p className="mb-2 text-[10px] font-semibold uppercase tracking-widest" style={{ color: "#00414e" }}>
          Primary Workflow
        </p>

        <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:gap-6">
          {/* Icon + title */}
          <div className="flex items-center gap-3 sm:flex-col sm:items-start sm:gap-2">
            <div
              className="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl"
              style={{ background: "#00414e" }}
            >
              <ShoppingCart className="h-6 w-6 text-white" />
            </div>
            <div>
              <h3 className="text-lg font-semibold text-gray-900">Start a Shelf Sale</h3>
              <p className="text-sm text-gray-600">Sell CMC-stocked products at the counter</p>
            </div>
          </div>

          {/* Actions */}
          <div className="flex flex-1 flex-col gap-3">
            {isOverdue ? (
              <TooltipProvider>
                <Tooltip>
                  <TooltipTrigger asChild>
                    {/* Wrap in span so tooltip works on a disabled button */}
                    <span className="inline-flex">
                      {startSaleButton}
                    </span>
                  </TooltipTrigger>
                  <TooltipContent side="top">
                    Resolve the overdue cash session before starting a new shelf sale.
                  </TooltipContent>
                </Tooltip>
              </TooltipProvider>
            ) : (
              startSaleButton
            )}

            {/* Inventory status */}
            <div className="flex items-center gap-2">
              <Package className="h-3.5 w-3.5 text-gray-400" />
              {productCount === undefined ? (
                <span className="text-xs text-gray-400">Checking inventory…</span>
              ) : inventoryReady ? (
                <span className="text-xs text-emerald-700">
                  {productCount} product{productCount !== 1 ? "s" : ""} available
                </span>
              ) : (
                <span className="text-xs text-amber-700">No shelf products available</span>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* Start Shift dialog — shown when no shift is active */}
      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="sm:max-w-md p-0 overflow-hidden">
          <DialogHeader className="px-5 pt-5 pb-0">
            <DialogTitle>Start Shift</DialogTitle>
          </DialogHeader>
          <StartShiftForm
            onSuccess={() => {
              setDialogOpen(false);
              navigate("/cmc-pos/sale");
            }}
            onCancel={() => setDialogOpen(false)}
          />
        </DialogContent>
      </Dialog>
    </>
  );
}

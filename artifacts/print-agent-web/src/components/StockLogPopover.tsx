import { useState } from "react";
import { History, Loader2, Clock } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  useGetSupplierCatalogItemStockLog,
  getGetSupplierCatalogItemStockLogQueryKey,
} from "@workspace/api-client-react";
import type { SupplierCatalogItemStockLogEntry } from "@workspace/api-client-react";
import { cn } from "@/lib/utils";

interface StockLogPopoverProps {
  supplierId: number;
  itemId: number;
  itemName: string;
}

export function StockLogPopover({ supplierId, itemId, itemName }: StockLogPopoverProps) {
  const [open, setOpen] = useState(false);
  const { data, isLoading } = useGetSupplierCatalogItemStockLog(supplierId, itemId, {
    query: { enabled: open, queryKey: getGetSupplierCatalogItemStockLogQueryKey(supplierId, itemId) },
  });
  const entries: SupplierCatalogItemStockLogEntry[] = data?.entries ?? [];

  function formatVal(v: string | null | undefined): string {
    if (v == null) return "—";
    const n = parseFloat(v);
    return isNaN(n) ? v : n.toLocaleString(undefined, { maximumFractionDigits: 4 });
  }

  function fieldLabel(f: string) {
    return f === "current_stock" ? "Stock" : f === "par_level" ? "Par Level" : f;
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          className="h-7 w-7 p-0 text-muted-foreground"
          title="View stock adjustment history"
        >
          <History size={13} />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-80 p-0" align="end">
        <div className="px-3 py-2 border-b border-border">
          <p className="text-xs font-semibold">Stock Adjustment History</p>
          <p className="text-[10px] text-muted-foreground truncate">{itemName}</p>
        </div>
        {isLoading ? (
          <div className="flex items-center gap-2 text-xs text-muted-foreground p-3">
            <Loader2 size={12} className="animate-spin" />
            Loading…
          </div>
        ) : entries.length === 0 ? (
          <div className="p-4 text-center">
            <Clock size={18} className="mx-auto mb-1.5 text-muted-foreground" />
            <p className="text-xs text-muted-foreground">No adjustments recorded yet.</p>
            <p className="text-[10px] text-muted-foreground mt-0.5">Changes to stock and par level will appear here.</p>
          </div>
        ) : (
          <div className="divide-y divide-border max-h-72 overflow-y-auto">
            {entries.map((e) => {
              const oldVal = formatVal(e.old_value);
              const newVal = formatVal(e.new_value);
              const isIncrease = e.old_value != null && e.new_value != null && parseFloat(e.new_value) > parseFloat(e.old_value);
              const isDecrease = e.old_value != null && e.new_value != null && parseFloat(e.new_value) < parseFloat(e.old_value);
              return (
                <div key={e.id} className="px-3 py-2 flex items-start justify-between gap-2">
                  <div className="min-w-0 flex-1">
                    <p className="text-[10px] font-medium text-foreground">
                      <span className="text-muted-foreground">{fieldLabel(e.field)}: </span>
                      <span className="font-mono">{oldVal}</span>
                      <span className="mx-1 text-muted-foreground">→</span>
                      <span
                        className={cn(
                          "font-mono font-semibold",
                          isIncrease && "text-green-600",
                          isDecrease && "text-amber-600",
                        )}
                      >
                        {newVal}
                      </span>
                    </p>
                    <p className="text-[10px] text-muted-foreground mt-0.5">
                      {e.changed_by_name ?? "Unknown"}
                      {" · "}
                      {new Date(e.created_at).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })}
                    </p>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
}

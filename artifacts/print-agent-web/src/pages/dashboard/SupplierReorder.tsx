import { Link } from "wouter";
import { useQuery } from "@tanstack/react-query";
import {
  AlertTriangle,
  ArrowLeft,
  Store,
  Loader2,
  ShoppingCart,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { getClerkToken, apiFetch } from "@/lib/queryClient";
import { cn } from "@/lib/utils";
import { StockLogPopover } from "@/components/StockLogPopover";

type ReorderItem = {
  id: number;
  supplier_id: number;
  supplier_name: string;
  supplier_display_name: string | null;
  name: string;
  supplier_item_code: string | null;
  category: string | null;
  unit: string | null;
  current_stock: string;
  par_level: string;
  min_order_quantity: string;
  price: string | null;
  currency: string;
};

type ReorderNeededResponse = {
  items: ReorderItem[];
};

function useReorderNeeded() {
  return useQuery<ReorderNeededResponse>({
    queryKey: ["/api/suppliers/reorder-needed"],
    queryFn: async ({ signal }) => {
      const token = await getClerkToken();
      return apiFetch<ReorderNeededResponse>("/api/suppliers/reorder-needed", {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
        signal: signal ?? undefined,
      });
    },
  });
}

type SupplierGroup = {
  supplierId: number;
  supplierName: string;
  supplierDisplayName: string | null;
  items: ReorderItem[];
};

function groupBySupplier(items: ReorderItem[]): SupplierGroup[] {
  const map = new Map<number, SupplierGroup>();
  for (const item of items) {
    const existing = map.get(item.supplier_id);
    if (existing) {
      existing.items.push(item);
    } else {
      map.set(item.supplier_id, {
        supplierId: item.supplier_id,
        supplierName: item.supplier_name,
        supplierDisplayName: item.supplier_display_name,
        items: [item],
      });
    }
  }
  return [...map.values()];
}

function shortfall(item: ReorderItem): number {
  const stock = parseFloat(item.current_stock);
  const par = parseFloat(item.par_level);
  return Math.max(0, par - stock);
}

export default function SupplierReorderPage() {
  const { data, isLoading, isError } = useReorderNeeded();
  const items = data?.items ?? [];
  const groups = groupBySupplier(items);

  return (
    <div className="max-w-4xl mx-auto px-4 py-6 space-y-6">
      <div className="flex items-center gap-3">
        <Link href="/suppliers">
          <Button variant="ghost" size="sm" className="gap-1.5 text-muted-foreground h-8 px-2">
            <ArrowLeft size={14} />
            Suppliers
          </Button>
        </Link>
      </div>

      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold flex items-center gap-2">
            <AlertTriangle size={20} className="text-amber-500" />
            Reorder Needed
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            Catalog items whose current stock is below their par level, grouped by supplier.
          </p>
        </div>
        {items.length > 0 && (
          <Badge variant="outline" className="shrink-0 bg-amber-50 text-amber-700 border-amber-200 text-sm px-2.5 py-1">
            {items.length} item{items.length !== 1 ? "s" : ""} below par
          </Badge>
        )}
      </div>

      {isLoading && (
        <div className="flex items-center gap-2 text-sm text-muted-foreground py-8">
          <Loader2 size={15} className="animate-spin" />
          Loading reorder alerts…
        </div>
      )}

      {isError && (
        <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-6 text-sm text-destructive">
          Failed to load reorder data. Please refresh and try again.
        </div>
      )}

      {!isLoading && !isError && items.length === 0 && (
        <div className="rounded-lg border border-dashed border-border p-12 text-center space-y-3">
          <ShoppingCart size={30} className="mx-auto text-muted-foreground" />
          <div>
            <p className="font-medium text-sm">All stock levels are at or above par</p>
            <p className="text-xs text-muted-foreground mt-1">
              No catalog items are currently below their par level.
            </p>
          </div>
          <Link href="/suppliers">
            <Button size="sm" variant="outline">View Suppliers</Button>
          </Link>
        </div>
      )}

      {groups.map((group) => {
        const displayName = group.supplierDisplayName || group.supplierName;
        return (
          <div key={group.supplierId} className="space-y-2">
            <div className="flex items-center gap-2">
              <Store size={14} className="text-muted-foreground" />
              <Link href={`/suppliers/${group.supplierId}?tab=catalog-items`}>
                <span className="font-semibold text-sm hover:underline cursor-pointer">
                  {displayName}
                </span>
              </Link>
              <span className="text-xs text-muted-foreground">
                — {group.items.length} item{group.items.length !== 1 ? "s" : ""} below par
              </span>
            </div>

            <div className="rounded-lg border border-border overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border bg-muted/50">
                    <th className="text-left px-3 py-2 font-medium text-muted-foreground text-xs">Item</th>
                    <th className="text-left px-3 py-2 font-medium text-muted-foreground text-xs">Code</th>
                    <th className="text-left px-3 py-2 font-medium text-muted-foreground text-xs">Category</th>
                    <th className="text-right px-3 py-2 font-medium text-muted-foreground text-xs whitespace-nowrap">Current Stock</th>
                    <th className="text-right px-3 py-2 font-medium text-muted-foreground text-xs">Par Level</th>
                    <th className="text-right px-3 py-2 font-medium text-muted-foreground text-xs">Shortfall</th>
                    <th className="text-right px-3 py-2 font-medium text-muted-foreground text-xs whitespace-nowrap">Min. Order</th>
                    <th className="text-right px-3 py-2 font-medium text-muted-foreground text-xs">Price</th>
                    <th className="px-3 py-2 font-medium text-muted-foreground text-xs"></th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {group.items.map((item) => {
                    const sf = shortfall(item);
                    const moq = parseFloat(item.min_order_quantity);
                    const suggestedQty = moq > 0 ? Math.ceil(sf / moq) * moq : sf;
                    return (
                      <tr key={item.id} className="hover:bg-muted/20 transition-colors">
                        <td className="px-3 py-2">
                          <div className="flex items-center gap-1.5">
                            <AlertTriangle size={11} className="text-amber-500 shrink-0" />
                            <span className="font-medium text-xs">{item.name}</span>
                          </div>
                          {item.unit && (
                            <span className="text-[10px] text-muted-foreground ml-4">{item.unit}</span>
                          )}
                        </td>
                        <td className="px-3 py-2 font-mono text-xs text-muted-foreground">
                          {item.supplier_item_code || "—"}
                        </td>
                        <td className="px-3 py-2 text-xs text-muted-foreground">
                          {item.category || "—"}
                        </td>
                        <td className="px-3 py-2 text-right">
                          <span className="text-xs font-medium text-amber-700">
                            {parseFloat(item.current_stock).toLocaleString()}
                          </span>
                        </td>
                        <td className="px-3 py-2 text-right text-xs text-muted-foreground">
                          {parseFloat(item.par_level).toLocaleString()}
                        </td>
                        <td className="px-3 py-2 text-right">
                          <span className={cn(
                            "inline-block rounded px-1.5 py-0.5 text-[10px] font-semibold",
                            "bg-amber-100 text-amber-700",
                          )}>
                            {sf.toLocaleString()}
                          </span>
                        </td>
                        <td className="px-3 py-2 text-right text-xs text-muted-foreground">
                          {suggestedQty > 0 ? suggestedQty.toLocaleString() : "—"}
                        </td>
                        <td className="px-3 py-2 text-right text-xs text-muted-foreground whitespace-nowrap">
                          {item.price
                            ? `${item.currency} ${parseFloat(item.price).toFixed(2)}`
                            : "—"}
                        </td>
                        <td className="px-3 py-2 text-right">
                          <StockLogPopover
                            supplierId={item.supplier_id}
                            itemId={item.id}
                            itemName={item.name}
                          />
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            <div className="flex justify-end">
              <Link href={`/purchase-orders`}>
                <Button size="sm" variant="outline" className="gap-1.5 text-xs h-7">
                  <ShoppingCart size={12} />
                  Create PO for {displayName}
                </Button>
              </Link>
            </div>
          </div>
        );
      })}
    </div>
  );
}

import { useParams, Link } from "wouter";
import {
  useGetSupplierCatalogItem,
  useGetSupplier,
  getGetSupplierCatalogItemQueryKey,
  getGetSupplierQueryKey,
} from "@workspace/api-client-react";
import {
  ArrowLeft,
  Package,
  Tag,
  Box,
  Layers,
  AlertTriangle,
  Clock,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/utils";

function DetailRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-start gap-3 py-2.5 border-b border-border last:border-0">
      <span className="w-36 shrink-0 text-xs text-muted-foreground font-medium pt-0.5">{label}</span>
      <span className="text-sm">{children}</span>
    </div>
  );
}

export default function SupplierCatalogItemDetail() {
  const params = useParams<{ supplierId: string; itemId: string }>();
  const supplierId = parseInt(params.supplierId ?? "", 10);
  const itemId = parseInt(params.itemId ?? "", 10);

  const { data: itemData, isLoading: itemLoading, isError: itemError } = useGetSupplierCatalogItem(
    supplierId,
    itemId,
    { query: { queryKey: getGetSupplierCatalogItemQueryKey(supplierId, itemId), enabled: !isNaN(supplierId) && !isNaN(itemId) } },
  );
  const { data: supplierData } = useGetSupplier(supplierId, {
    query: { queryKey: getGetSupplierQueryKey(supplierId), enabled: !isNaN(supplierId) },
  });

  const item = itemData?.catalog_item;
  const supplier = supplierData?.supplier;

  if (isNaN(supplierId) || isNaN(itemId)) {
    return (
      <div className="p-6 text-sm text-destructive">Invalid URL parameters.</div>
    );
  }

  if (itemLoading) {
    return (
      <div className="flex min-h-[40vh] items-center justify-center">
        <Spinner className="size-6 text-primary" />
      </div>
    );
  }

  if (itemError || !item) {
    return (
      <div className="p-6 space-y-3">
        <Link
          href={`/dashboard/suppliers/${supplierId}?tab=catalog`}
          className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors"
        >
          <ArrowLeft size={14} />
          Back to supplier
        </Link>
        <p className="text-sm text-destructive">Catalog item not found.</p>
      </div>
    );
  }

  const stockNum = item.current_stock != null ? parseFloat(item.current_stock) : null;
  const parNum = item.par_level != null ? parseFloat(item.par_level) : null;
  const needsReorder = stockNum != null && parNum != null && stockNum < parNum;

  return (
    <div className="max-w-2xl mx-auto p-6 space-y-6">
      <div className="flex items-center gap-3">
        <Link
          href={`/dashboard/suppliers/${supplierId}?tab=catalog`}
          className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors"
        >
          <ArrowLeft size={14} />
          {supplier ? supplier.name : "Supplier"}
        </Link>
      </div>

      <div className="flex items-start justify-between gap-3">
        <div className="flex items-center gap-2.5">
          <div className="rounded-lg bg-violet-50 p-2 shrink-0">
            <Tag size={18} className="text-violet-600" />
          </div>
          <div>
            <h1 className="text-xl font-semibold">{item.name}</h1>
            {item.category && (
              <p className="text-sm text-muted-foreground">{item.category}</p>
            )}
          </div>
        </div>
        <span
          className={cn(
            "inline-block rounded px-2 py-1 text-xs font-medium shrink-0 mt-0.5",
            item.is_active
              ? "bg-green-100 text-green-700"
              : "bg-gray-100 text-gray-500",
          )}
        >
          {item.is_active ? "Active" : "Inactive"}
        </span>
      </div>

      {needsReorder && (
        <div className="flex items-center gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-700">
          <AlertTriangle size={14} className="shrink-0" />
          Stock is below par level — reorder needed.
        </div>
      )}

      <Card className="shadow-none">
        <CardHeader className="pb-2 pt-4 px-4">
          <CardTitle className="text-sm font-semibold flex items-center gap-1.5">
            <Package size={14} className="text-muted-foreground" />
            Item Details
          </CardTitle>
        </CardHeader>
        <CardContent className="px-4 pb-4">
          <DetailRow label="Supplier Item Code">
            {item.supplier_item_code
              ? <span className="font-mono text-xs">{item.supplier_item_code}</span>
              : <span className="text-muted-foreground">—</span>}
          </DetailRow>
          <DetailRow label="Unit">
            {item.unit ?? <span className="text-muted-foreground">—</span>}
          </DetailRow>
          <DetailRow label="Package Size">
            {item.package_size ?? <span className="text-muted-foreground">—</span>}
          </DetailRow>
          <DetailRow label="Price">
            {item.price
              ? <span className="font-medium">{item.currency} {parseFloat(item.price).toFixed(2)}</span>
              : <span className="text-muted-foreground">—</span>}
          </DetailRow>
          <DetailRow label="Min. Order Qty">
            {item.min_order_quantity ?? <span className="text-muted-foreground">—</span>}
          </DetailRow>
          <DetailRow label="Category">
            {item.category ?? <span className="text-muted-foreground">—</span>}
          </DetailRow>
        </CardContent>
      </Card>

      <Card className="shadow-none">
        <CardHeader className="pb-2 pt-4 px-4">
          <CardTitle className="text-sm font-semibold flex items-center gap-1.5">
            <Layers size={14} className="text-muted-foreground" />
            Stock & Reorder
          </CardTitle>
        </CardHeader>
        <CardContent className="px-4 pb-4">
          <DetailRow label="Current Stock">
            {stockNum != null
              ? (
                <span className={cn("font-medium", needsReorder && "text-amber-600")}>
                  {stockNum.toLocaleString()}
                  {needsReorder && <AlertTriangle size={11} className="inline ml-1 mb-0.5 text-amber-500" />}
                </span>
              )
              : <span className="text-muted-foreground">—</span>}
          </DetailRow>
          <DetailRow label="Par Level">
            {parNum != null
              ? <span className="font-medium">{parNum.toLocaleString()}</span>
              : <span className="text-muted-foreground">—</span>}
          </DetailRow>
          <DetailRow label="Lead Time">
            {item.lead_time_days != null
              ? (
                <span className="inline-flex items-center gap-1">
                  <Clock size={12} className="text-muted-foreground" />
                  {item.lead_time_days} day{item.lead_time_days !== 1 ? "s" : ""}
                </span>
              )
              : <span className="text-muted-foreground">—</span>}
          </DetailRow>
        </CardContent>
      </Card>

      <Card className="shadow-none">
        <CardHeader className="pb-2 pt-4 px-4">
          <CardTitle className="text-sm font-semibold flex items-center gap-1.5">
            <Box size={14} className="text-muted-foreground" />
            Linked Base Item
          </CardTitle>
        </CardHeader>
        <CardContent className="px-4 pb-4">
          {item.base_item_id != null && item.base_item_name ? (
            <Link
              href={`/dashboard/base-items/${item.base_item_id}`}
              className="text-sm text-primary hover:underline"
            >
              {item.base_item_name}
            </Link>
          ) : (
            <p className="text-sm text-muted-foreground">
              No base item linked. When linked, receiving stock on a PO will automatically update the base item's inventory.
            </p>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

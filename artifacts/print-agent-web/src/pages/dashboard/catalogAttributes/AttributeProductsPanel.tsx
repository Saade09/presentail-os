import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { X, Package, AlertTriangle, ImageIcon, ChevronLeft, ChevronRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { apiFetch } from "@/lib/queryClient";
import { formatUSD } from "@/lib/utils";
import { imageUrl } from "@/lib/imageUrl";
import { useTranslation } from "react-i18next";
import type { CatalogAttribute } from "@workspace/api-client-react";

export type AttributeProductFilter = "occasion" | "category" | "brand" | "recipient";

type AttributeProductsPanelProps = {
  item: CatalogAttribute;
  attributeType: AttributeProductFilter;
  onClose: () => void;
};

type PanelProduct = {
  id: number;
  name: string;
  price_usd: string;
  main_image_url: string | null;
  status: string;
};

type ProductsResponse = {
  products: PanelProduct[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
};

const PAGE_SIZE = 25;

function buildFilterParam(attributeType: AttributeProductFilter, item: CatalogAttribute): string {
  switch (attributeType) {
    case "occasion":
      return `occasion_id=${item.id}`;
    case "recipient":
      return `recipient_id=${item.id}`;
    case "category":
      return `category=${encodeURIComponent(item.name)}`;
    case "brand":
      return `brand=${encodeURIComponent(item.name)}`;
  }
}

export function AttributeProductsPanel({ item, attributeType, onClose }: AttributeProductsPanelProps) {
  const { t } = useTranslation();
  const [page, setPage] = useState(1);

  const filterParam = buildFilterParam(attributeType, item);
  const url = `/api/products?${filterParam}&page=${page}&pageSize=${PAGE_SIZE}`;

  const { data, isLoading, isError, refetch, isRefetching } = useQuery({
    queryKey: ["attribute-products", attributeType, item.id, page],
    queryFn: () => apiFetch<ProductsResponse>(url),
  });

  const total = data?.total ?? 0;
  const totalPages = data?.totalPages ?? 1;

  function statusLabel(status: string): string {
    switch (status) {
      case "available":
        return t("attrProducts.statusAvailable");
      case "out_of_stock":
        return t("attrProducts.statusOutOfStock");
      case "not_available":
        return t("attrProducts.statusNotAvailable");
      default:
        return status;
    }
  }

  function statusVariant(status: string): "default" | "secondary" | "destructive" {
    if (status === "available") return "default";
    if (status === "out_of_stock") return "destructive";
    return "secondary";
  }

  return (
    <div className="fixed inset-0 z-50 flex">
      <div className="flex-1 bg-black/40" onClick={onClose} />
      <div className="w-full max-w-lg bg-background border-l border-border flex flex-col h-full shadow-2xl">
        <div className="flex items-center justify-between px-6 py-4 border-b border-border">
          <div className="min-w-0">
            <h2 className="text-lg font-semibold truncate">{t("attrProducts.title")}</h2>
            <p className="text-sm text-muted-foreground truncate">{item.name}</p>
          </div>
          <Button variant="ghost" size="icon" onClick={onClose}><X size={18} /></Button>
        </div>

        <div className="px-6 py-4 border-b border-border">
          <div className="flex items-center gap-3 p-3 bg-muted rounded-lg">
            <Package size={20} className="text-primary shrink-0" />
            <div>
              <p className="font-medium text-sm">
                {isLoading ? t("attrProducts.loading") : t("attrProducts.totalCount", { count: total })}
              </p>
              <p className="text-xs text-muted-foreground">{t("attrProducts.subtitle")}</p>
            </div>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto">
          {isLoading ? (
            <div className="space-y-3 p-4">
              {Array.from({ length: 6 }).map((_, i) => (
                <Skeleton key={i} className="h-14 rounded-md" />
              ))}
            </div>
          ) : isError ? (
            <div className="flex flex-col items-center justify-center py-16 text-center px-4">
              <AlertTriangle size={40} className="text-destructive mb-3" />
              <p className="text-sm font-medium">{t("attrProducts.errorTitle")}</p>
              <p className="text-xs text-muted-foreground mt-1 mb-4">{t("attrProducts.errorDesc")}</p>
              <Button variant="outline" size="sm" onClick={() => refetch()} disabled={isRefetching}>
                {isRefetching ? t("attrProducts.retrying") : t("attrProducts.retry")}
              </Button>
            </div>
          ) : !data || data.products.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-16 text-center px-4">
              <Package size={40} className="text-muted-foreground mb-3" />
              <p className="text-sm text-muted-foreground">{t("attrProducts.empty")}</p>
            </div>
          ) : (
            <div className="divide-y divide-border">
              {data.products.map((product) => (
                <div key={product.id} className="flex items-center gap-3 px-6 py-3 hover:bg-muted/30 transition-colors">
                  {product.main_image_url ? (
                    <img
                      src={imageUrl(product.main_image_url) ?? product.main_image_url}
                      alt=""
                      className="w-10 h-10 rounded object-cover border border-border shrink-0"
                      onError={(e) => { (e.target as HTMLImageElement).style.display = "none"; }}
                    />
                  ) : (
                    <div className="w-10 h-10 rounded border border-border shrink-0 flex items-center justify-center bg-muted/40">
                      <ImageIcon size={16} className="text-muted-foreground" />
                    </div>
                  )}
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium truncate">{product.name}</p>
                    <p className="text-xs text-muted-foreground">{formatUSD(product.price_usd)}</p>
                  </div>
                  <Badge variant={statusVariant(product.status)} className="shrink-0">
                    {statusLabel(product.status)}
                  </Badge>
                </div>
              ))}
            </div>
          )}
        </div>

        {!isLoading && !isError && data && data.products.length > 0 && totalPages > 1 && (
          <div className="px-6 py-4 border-t border-border flex items-center justify-between">
            <p className="text-xs text-muted-foreground">
              {t("attrProducts.pageInfo", { page: data.page, totalPages })}
            </p>
            <div className="flex gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={() => setPage((p) => Math.max(1, p - 1))}
                disabled={data.page <= 1}
              >
                <ChevronLeft size={14} className="mr-1" />
                {t("attrProducts.prev")}
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                disabled={data.page >= totalPages}
              >
                {t("attrProducts.next")}
                <ChevronRight size={14} className="ml-1" />
              </Button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

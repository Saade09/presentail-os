import { useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  Layers,
  MapPin,
  ShoppingBag,
  PackageX,
  PackageMinus,
  Tv2,
  TagIcon,
  Box,
  TrendingDown,
  AlertCircle,
} from "lucide-react";
import { apiFetch } from "@/lib/queryClient";
import { Card, CardContent } from "@/components/ui/card";
import { useTranslation } from "react-i18next";
import { useDocumentVisibility } from "@/hooks/use-document-visibility";

type DashboardSummary = {
  total_brands: number;
  total_locations: number;
  total_channels: number;
  products_available: number;
  products_out_of_stock: number;
  products_not_available: number;
  brands_without_products: number;
  total_base_items: number;
  low_stock_base_items: number;
  out_of_stock_base_items: number;
};

function StatCard({
  title,
  value,
  icon: Icon,
  iconClass,
  isLoading,
  testId,
}: {
  title: string;
  value: number;
  icon: React.ElementType;
  iconClass?: string;
  isLoading: boolean;
  testId: string;
}) {
  return (
    <Card>
      <CardContent className="pt-6">
        <div className="flex items-center justify-between">
          <div>
            <p className="text-sm text-muted-foreground">{title}</p>
            {isLoading ? (
              <div
                data-testid="pm-stat-skeleton"
                className="h-9 w-20 rounded bg-muted animate-pulse mt-1"
              />
            ) : (
              <p data-testid={testId} className="text-3xl font-bold mt-1">{value.toLocaleString()}</p>
            )}
          </div>
          <div className={`p-3 rounded-full bg-secondary ${iconClass ?? ""}`}>
            <Icon size={20} />
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

export default function ProjectManagerDashboard() {
  const { t } = useTranslation();
  const isVisible = useDocumentVisibility();

  const { data, isLoading, refetch } = useQuery({
    queryKey: ["dashboard-summary"],
    queryFn: () => apiFetch<DashboardSummary>("/api/dashboard/summary"),
    refetchInterval: isVisible ? 30_000 : false,
    refetchIntervalInBackground: false,
  });

  useEffect(() => {
    if (isVisible) {
      refetch();
    }
  }, [isVisible, refetch]);

  const summary: DashboardSummary = data ?? {
    total_brands: 0,
    total_locations: 0,
    total_channels: 0,
    products_available: 0,
    products_out_of_stock: 0,
    products_not_available: 0,
    brands_without_products: 0,
    total_base_items: 0,
    low_stock_base_items: 0,
    out_of_stock_base_items: 0,
  };

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">
          {t("projectManagerDashboard.title")}
        </h1>
        <p className="text-muted-foreground mt-2">
          {t("projectManagerDashboard.description")}
        </p>
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-3 gap-4">
        <StatCard
          title={t("projectManagerDashboard.brands")}
          value={summary.total_brands}
          icon={Layers}
          isLoading={isLoading}
          testId="pm-stat-brands"
        />
        <StatCard
          title={t("projectManagerDashboard.locations")}
          value={summary.total_locations}
          icon={MapPin}
          isLoading={isLoading}
          testId="pm-stat-locations"
        />
        <StatCard
          title={t("projectManagerDashboard.productsAvailable")}
          value={summary.products_available}
          icon={ShoppingBag}
          iconClass="text-green-600"
          isLoading={isLoading}
          testId="pm-stat-products-available"
        />
        <StatCard
          title={t("projectManagerDashboard.productsOutOfStock")}
          value={summary.products_out_of_stock}
          icon={PackageMinus}
          iconClass="text-amber-600"
          isLoading={isLoading}
          testId="pm-stat-products-out-of-stock"
        />
        <StatCard
          title={t("projectManagerDashboard.productsNotAvailable")}
          value={summary.products_not_available}
          icon={PackageX}
          iconClass="text-destructive"
          isLoading={isLoading}
          testId="pm-stat-products-not-available"
        />
        <StatCard
          title={t("projectManagerDashboard.channels")}
          value={summary.total_channels}
          icon={Tv2}
          isLoading={isLoading}
          testId="pm-stat-channels"
        />
        <StatCard
          title={t("projectManagerDashboard.brandsWithoutProducts")}
          value={summary.brands_without_products}
          icon={TagIcon}
          iconClass="text-amber-600"
          isLoading={isLoading}
          testId="pm-stat-brands-without-products"
        />
        <StatCard
          title={t("projectManagerDashboard.totalBaseItems")}
          value={summary.total_base_items}
          icon={Box}
          isLoading={isLoading}
          testId="pm-stat-total-base-items"
        />
        <StatCard
          title={t("projectManagerDashboard.lowStockBaseItems")}
          value={summary.low_stock_base_items}
          icon={TrendingDown}
          iconClass="text-amber-600"
          isLoading={isLoading}
          testId="pm-stat-low-stock-base-items"
        />
        <StatCard
          title={t("projectManagerDashboard.outOfStockBaseItems")}
          value={summary.out_of_stock_base_items}
          icon={AlertCircle}
          iconClass="text-destructive"
          isLoading={isLoading}
          testId="pm-stat-out-of-stock-base-items"
        />
      </div>
    </div>
  );
}

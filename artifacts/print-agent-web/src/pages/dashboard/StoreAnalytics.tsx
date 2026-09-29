import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useLocation } from "wouter";
import { useStoreAnalyticsFilters } from "@/hooks/use-store-analytics-filters";
import { StoreAnalyticsFilterBar } from "@/components/StoreAnalyticsFilterBar";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import StoreAnalyticsOverview from "./StoreAnalyticsOverview";
import StoreAnalyticsFunnel from "./StoreAnalyticsFunnel";
import { StoreSalesSection } from "@/components/StoreSalesSection";
import { StorePaymentMethodsSection } from "@/components/StorePaymentMethodsSection";
import StoreProductAnalytics from "./StoreProductAnalytics";

export default function StoreAnalyticsPage() {
  const { t } = useTranslation();
  const filters = useStoreAnalyticsFilters();
  const [tab, setTab] = useState("overview");
  const [, setLocation] = useLocation();

  // Insights on the Overview tab link to the section that produced them. In-page
  // sections switch the active tab; sections that live on their own route (e.g.
  // cart & checkout) navigate there.
  const handleNavigateSection = (section: string) => {
    if (section === "cart_checkout") {
      setLocation("/cart-checkout-analytics");
      return;
    }
    if (["overview", "products", "sales", "payments", "funnel"].includes(section)) {
      setTab(section);
    }
  };

  return (
    <div className="space-y-6 p-4 sm:p-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">
          {t("storeAnalytics.title")}
        </h1>
        <p className="text-sm text-muted-foreground">{t("storeAnalytics.subtitle")}</p>
      </div>

      <StoreAnalyticsFilterBar filters={filters} />

      <Tabs value={tab} onValueChange={setTab} className="space-y-6">
        <TabsList>
          <TabsTrigger value="overview">
            {t("storeAnalytics.tabs.overview")}
          </TabsTrigger>
          <TabsTrigger value="products">
            {t("storeAnalytics.tabs.products")}
          </TabsTrigger>
          <TabsTrigger value="sales">
            {t("storeAnalytics.tabs.sales")}
          </TabsTrigger>
          <TabsTrigger value="payments">
            {t("storeAnalytics.tabs.payments")}
          </TabsTrigger>
          <TabsTrigger value="funnel">
            {t("storeAnalytics.tabs.funnel")}
          </TabsTrigger>
        </TabsList>

        <TabsContent value="overview" className="space-y-6">
          <StoreAnalyticsOverview
            filters={filters}
            onNavigateSection={handleNavigateSection}
          />
        </TabsContent>

        <TabsContent value="products" className="space-y-6">
          <StoreProductAnalytics params={filters.apiParams} />
        </TabsContent>

        <TabsContent value="sales" className="space-y-6">
          <StoreSalesSection
            apiParams={filters.apiParams}
            preset={filters.preset}
            resolvedRange={filters.resolvedRange}
          />
        </TabsContent>

        <TabsContent value="payments" className="space-y-6">
          <StorePaymentMethodsSection apiParams={filters.apiParams} />
        </TabsContent>

        <TabsContent value="funnel" className="space-y-6">
          <StoreAnalyticsFunnel filters={filters} />
        </TabsContent>
      </Tabs>
    </div>
  );
}

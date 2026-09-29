import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useQuery, useMutation } from "@tanstack/react-query";
import { Sparkles, Search, ShoppingBag, LayoutGrid, ImageIcon } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { useToast } from "@/hooks/use-toast";
import { useWorkspaceRole } from "@/hooks/use-workspace-role";
import { apiFetch, queryClient } from "@/lib/queryClient";
import { imageUrl } from "@/lib/imageUrl";
import {
  useListCatalogCategories,
  getListCatalogCategoriesQueryKey,
  useUpdateCatalogCategory,
} from "@workspace/api-client-react";
import type { CatalogAttribute } from "@workspace/api-client-react";

type UpsellProduct = {
  id: number;
  name: string;
  status: string;
  main_image_url: string | null;
  is_upsell?: boolean;
};

function StatCard({ label, value, icon }: { label: string; value: string | number; icon: React.ReactNode }) {
  return (
    <div className="bg-card border border-border rounded-xl p-5">
      <div className="flex items-start justify-between">
        <div>
          <p className="text-sm text-muted-foreground font-medium">{label}</p>
          <p className="text-2xl font-bold mt-1">{value}</p>
        </div>
        <div className="p-2 bg-primary/10 rounded-lg text-primary">{icon}</div>
      </div>
    </div>
  );
}

function ProductsPanel({ canManage }: { canManage: boolean }) {
  const { t } = useTranslation();
  const { toast } = useToast();
  const [search, setSearch] = useState("");
  const [onlyUpsell, setOnlyUpsell] = useState(false);

  const productsUrl = (() => {
    const params = new URLSearchParams();
    if (search.trim()) params.set("q", search.trim());
    params.set("page", "1");
    params.set("pageSize", "100");
    return `/api/products?${params.toString()}`;
  })();

  const { data, isLoading } = useQuery({
    queryKey: ["upsell-products", search.trim()],
    queryFn: () => apiFetch<{ products: UpsellProduct[] }>(productsUrl),
  });

  const toggleMutation = useMutation({
    mutationFn: ({ id, value }: { id: number; value: boolean }) =>
      apiFetch(`/api/products/${id}`, {
        method: "PATCH",
        body: JSON.stringify({ is_upsell: value }),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["upsell-products"] });
      queryClient.invalidateQueries({ queryKey: ["products"] });
    },
    onError: () => {
      toast({ title: t("upsell.updateFailed"), variant: "destructive" });
    },
  });

  const allProducts = data?.products ?? [];
  const products = onlyUpsell ? allProducts.filter((p) => p.is_upsell) : allProducts;

  return (
    <div className="space-y-4">
      <div className="flex flex-col sm:flex-row gap-3">
        <div className="relative flex-1">
          <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
          <Input
            placeholder={t("upsell.searchProducts")}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="pl-8"
          />
        </div>
        <label className="flex items-center gap-2 text-sm text-muted-foreground shrink-0">
          <Switch checked={onlyUpsell} onCheckedChange={setOnlyUpsell} aria-label={t("upsell.onlyUpsell")} />
          {t("upsell.onlyUpsell")}
        </label>
      </div>

      <div className="bg-card border border-border rounded-xl">
        {isLoading ? (
          <div className="space-y-3 p-4">
            {Array.from({ length: 5 }).map((_, i) => (
              <Skeleton key={i} className="h-12 rounded-md" />
            ))}
          </div>
        ) : products.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-16 text-center">
            <ShoppingBag size={40} className="text-muted-foreground mb-3" />
            <p className="font-medium">{t("upsell.noProducts")}</p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border bg-muted/30">
                  <th className="text-left px-4 py-3 font-medium text-muted-foreground">{t("upsell.product")}</th>
                  <th className="text-left px-4 py-3 font-medium text-muted-foreground">{t("upsell.status")}</th>
                  <th className="text-left px-4 py-3 font-medium text-muted-foreground">{t("upsell.upsellColumn")}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {products.map((p) => (
                  <tr key={p.id} className="hover:bg-muted/20 transition-colors">
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-3">
                        {p.main_image_url ? (
                          <img
                            src={imageUrl(p.main_image_url) ?? p.main_image_url}
                            alt=""
                            className="w-8 h-8 rounded object-cover border border-border shrink-0"
                            onError={(e) => { (e.target as HTMLImageElement).style.display = "none"; }}
                          />
                        ) : (
                          <div className="w-8 h-8 rounded border border-border shrink-0 flex items-center justify-center bg-muted/40">
                            <ImageIcon size={14} className="text-muted-foreground" />
                          </div>
                        )}
                        <span className="font-medium">{p.name}</span>
                      </div>
                    </td>
                    <td className="px-4 py-3">
                      <Badge variant={p.status === "available" ? "default" : "secondary"}>{p.status}</Badge>
                    </td>
                    <td className="px-4 py-3">
                      <Switch
                        checked={!!p.is_upsell}
                        disabled={!canManage || toggleMutation.isPending}
                        onCheckedChange={(v) => toggleMutation.mutate({ id: p.id, value: v })}
                        aria-label={t("upsell.upsellColumn")}
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

function CategoriesPanel({ canManage }: { canManage: boolean }) {
  const { t } = useTranslation();
  const { toast } = useToast();
  const [search, setSearch] = useState("");
  const [onlyUpsell, setOnlyUpsell] = useState(false);

  const listParams = { ...(search.trim() ? { q: search.trim() } : {}), page: 1, pageSize: 100 as const };
  const { data, isLoading } = useListCatalogCategories(listParams);
  const updateMutation = useUpdateCatalogCategory();

  function handleToggle(item: CatalogAttribute, value: boolean) {
    updateMutation.mutate(
      { id: item.id, data: { is_upsell: value } },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: getListCatalogCategoriesQueryKey() });
        },
        onError: () => {
          toast({ title: t("upsell.updateFailed"), variant: "destructive" });
        },
      },
    );
  }

  const allItems = (data?.items ?? []) as CatalogAttribute[];
  const items = onlyUpsell ? allItems.filter((c) => (c as { is_upsell?: boolean }).is_upsell) : allItems;

  return (
    <div className="space-y-4">
      <div className="flex flex-col sm:flex-row gap-3">
        <div className="relative flex-1">
          <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
          <Input
            placeholder={t("upsell.searchCategories")}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="pl-8"
          />
        </div>
        <label className="flex items-center gap-2 text-sm text-muted-foreground shrink-0">
          <Switch checked={onlyUpsell} onCheckedChange={setOnlyUpsell} aria-label={t("upsell.onlyUpsell")} />
          {t("upsell.onlyUpsell")}
        </label>
      </div>

      <div className="bg-card border border-border rounded-xl">
        {isLoading ? (
          <div className="space-y-3 p-4">
            {Array.from({ length: 5 }).map((_, i) => (
              <Skeleton key={i} className="h-12 rounded-md" />
            ))}
          </div>
        ) : items.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-16 text-center">
            <LayoutGrid size={40} className="text-muted-foreground mb-3" />
            <p className="font-medium">{t("upsell.noCategories")}</p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border bg-muted/30">
                  <th className="text-left px-4 py-3 font-medium text-muted-foreground">{t("upsell.category")}</th>
                  <th className="text-left px-4 py-3 font-medium text-muted-foreground">{t("upsell.status")}</th>
                  <th className="text-left px-4 py-3 font-medium text-muted-foreground">{t("upsell.upsellColumn")}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {items.map((c) => (
                  <tr key={c.id} className="hover:bg-muted/20 transition-colors">
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-3">
                        {c.image_url ? (
                          <img
                            src={imageUrl(c.image_url) ?? c.image_url}
                            alt=""
                            className="w-8 h-8 rounded object-cover border border-border shrink-0"
                            onError={(e) => { (e.target as HTMLImageElement).style.display = "none"; }}
                          />
                        ) : (
                          <div className="w-8 h-8 rounded border border-border shrink-0 flex items-center justify-center bg-muted/40">
                            <ImageIcon size={14} className="text-muted-foreground" />
                          </div>
                        )}
                        <span className="font-medium">{c.name}</span>
                      </div>
                    </td>
                    <td className="px-4 py-3">
                      <Badge variant={c.is_active ? "default" : "secondary"}>
                        {c.is_active ? t("upsell.active") : t("upsell.inactive")}
                      </Badge>
                    </td>
                    <td className="px-4 py-3">
                      <Switch
                        checked={!!(c as { is_upsell?: boolean }).is_upsell}
                        disabled={!canManage || updateMutation.isPending}
                        onCheckedChange={(v) => handleToggle(c, v)}
                        aria-label={t("upsell.upsellColumn")}
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

export default function Upsell() {
  const { t } = useTranslation();
  const { isOwner, allowedPages } = useWorkspaceRole();
  const canManage = isOwner || (allowedPages ?? []).includes("upsell.manage");

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2">
          <Sparkles size={22} /> {t("upsell.title")}
        </h1>
        <p className="text-muted-foreground text-sm mt-0.5">{t("upsell.subtitle")}</p>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <StatCard label={t("upsell.productsTab")} value={t("upsell.productsCardHint")} icon={<ShoppingBag size={18} />} />
        <StatCard label={t("upsell.categoriesTab")} value={t("upsell.categoriesCardHint")} icon={<LayoutGrid size={18} />} />
      </div>

      <Tabs defaultValue="products">
        <TabsList>
          <TabsTrigger value="products">{t("upsell.productsTab")}</TabsTrigger>
          <TabsTrigger value="categories">{t("upsell.categoriesTab")}</TabsTrigger>
        </TabsList>
        <TabsContent value="products" className="mt-4">
          <ProductsPanel canManage={canManage} />
        </TabsContent>
        <TabsContent value="categories" className="mt-4">
          <CategoriesPanel canManage={canManage} />
        </TabsContent>
      </Tabs>
    </div>
  );
}

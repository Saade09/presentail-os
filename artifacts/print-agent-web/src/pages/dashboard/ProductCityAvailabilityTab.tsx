import { useState, useEffect } from "react";
import { Search, Globe, CheckCircle, XCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/hooks/use-toast";
import { queryClient } from "@/lib/queryClient";
import { cn } from "@/lib/utils";
import {
  useGetProductCityAvailability,
  getGetProductCityAvailabilityQueryKey,
  useSetProductCityAvailability,
  useBulkSetProductCityAvailability,
} from "@workspace/api-client-react";
import type { ProductCityAvailabilityRow } from "@workspace/api-client-react";

type ProductCityAvailabilityTabProps = {
  productId: number;
  canManage: boolean;
};

export function ProductCityAvailabilityTab({ productId, canManage }: ProductCityAvailabilityTabProps) {
  const { toast } = useToast();
  const [search, setSearch] = useState("");
  const [localCities, setLocalCities] = useState<ProductCityAvailabilityRow[]>([]);
  const [dirty, setDirty] = useState(false);

  const { data, isLoading } = useGetProductCityAvailability(productId);

  useEffect(() => {
    if (data?.cities) {
      setLocalCities(data.cities);
      setDirty(false);
    }
  }, [data]);

  const saveMutation = useSetProductCityAvailability();
  const bulkMutation = useBulkSetProductCityAvailability();

  const queryKey = getGetProductCityAvailabilityQueryKey(productId);

  function handleSave() {
    const updates = localCities.map((c) => ({ city_id: c.city_id, is_available: c.is_available }));
    saveMutation.mutate(
      { id: productId, data: updates },
      {
        onSuccess: () => {
          toast({ title: "City availability saved" });
          queryClient.invalidateQueries({ queryKey });
          setDirty(false);
        },
        onError: () => toast({ title: "Failed to save", variant: "destructive" }),
      },
    );
  }

  function handleBulk(enableAll: boolean) {
    bulkMutation.mutate(
      { id: productId, data: { enable_all: enableAll } },
      {
        onSuccess: () => {
          toast({ title: "Updated all cities" });
          queryClient.invalidateQueries({ queryKey });
        },
        onError: () => toast({ title: "Failed to update", variant: "destructive" }),
      },
    );
  }

  const filtered = localCities.filter((c) => {
    if (!search) return true;
    const q = search.toLowerCase();
    return (
      c.city_name.toLowerCase().includes(q) ||
      c.city_slug.toLowerCase().includes(q) ||
      c.country_code.toLowerCase().includes(q)
    );
  });

  const enabledCount = localCities.filter((c) => c.is_available).length;
  const totalCities = data?.total_cities ?? localCities.length;

  function toggleCity(cityId: number, available: boolean) {
    setLocalCities((prev) => prev.map((c) => (c.city_id === cityId ? { ...c, is_available: available } : c)));
    setDirty(true);
  }

  return (
    <div className="rounded-lg border border-border bg-card">
      <div className="px-5 py-4 border-b border-border space-y-3">
        <div className="flex items-center gap-3 p-3 bg-muted rounded-lg">
          <Globe size={20} className="text-primary shrink-0" />
          <div>
            <p className="font-medium text-sm">{enabledCount} of {totalCities} cities enabled</p>
            <p className="text-xs text-muted-foreground">
              Products are available in every delivery city by default. Turn a city off to hide this product there.
            </p>
          </div>
        </div>
        {canManage && (
          <div className="flex gap-2">
            <Button
              variant="outline"
              size="sm"
              className="flex-1"
              onClick={() => handleBulk(true)}
              disabled={bulkMutation.isPending}
            >
              <CheckCircle size={14} className="mr-1.5" />
              Enable All Cities
            </Button>
            <Button
              variant="outline"
              size="sm"
              className="flex-1"
              onClick={() => handleBulk(false)}
              disabled={bulkMutation.isPending}
            >
              <XCircle size={14} className="mr-1.5" />
              Disable All Cities
            </Button>
          </div>
        )}
      </div>

      <div className="px-5 py-3 border-b border-border">
        <div className="relative">
          <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
          <Input
            placeholder="Search cities..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="pl-8 h-8 text-sm"
          />
        </div>
      </div>

      <div className="max-h-[480px] overflow-y-auto">
        {isLoading ? (
          <div className="space-y-3 p-4">
            {Array.from({ length: 5 }).map((_, i) => (
              <Skeleton key={i} className="h-12 rounded-md" />
            ))}
          </div>
        ) : filtered.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-16 text-center px-4">
            <Globe size={40} className="text-muted-foreground mb-3" />
            <p className="text-sm text-muted-foreground">
              {search ? "No matching cities found" : "No delivery cities configured yet"}
            </p>
          </div>
        ) : (
          <div className="divide-y divide-border">
            {filtered.map((city) => (
              <div key={city.city_id} className="flex items-center justify-between px-5 py-3 hover:bg-muted/30 transition-colors">
                <div className="min-w-0 flex-1">
                  <p className={cn("text-sm font-medium", !city.city_is_active && "text-muted-foreground")}>{city.city_name}</p>
                  <p className="text-xs text-muted-foreground">{city.country_code}</p>
                </div>
                <Switch
                  checked={city.is_available}
                  disabled={!canManage}
                  onCheckedChange={(v) => toggleCity(city.city_id, v)}
                />
              </div>
            ))}
          </div>
        )}
      </div>

      {canManage && (
        <div className="px-5 py-4 border-t border-border flex justify-end">
          <Button onClick={handleSave} disabled={!dirty || saveMutation.isPending}>
            {saveMutation.isPending ? "Saving…" : "Save Changes"}
          </Button>
        </div>
      )}
    </div>
  );
}

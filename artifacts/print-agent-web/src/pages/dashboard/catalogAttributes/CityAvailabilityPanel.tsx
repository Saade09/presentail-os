import { useState, useEffect } from "react";
import { X, Search, Globe, CheckCircle, XCircle, AlertTriangle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/hooks/use-toast";
import { queryClient } from "@/lib/queryClient";
import { cn } from "@/lib/utils";
import type { AttributeHooksConfig } from "./attributeHooks";
import type { CatalogAttribute, CatalogAttributeCityAvailabilityRow } from "@workspace/api-client-react";

type CityAvailabilityPanelProps = {
  hooksConfig: AttributeHooksConfig;
  item: CatalogAttribute;
  onClose: () => void;
};

export function CityAvailabilityPanel({ hooksConfig, item, onClose }: CityAvailabilityPanelProps) {
  const { toast } = useToast();
  const [search, setSearch] = useState("");
  const [localCities, setLocalCities] = useState<CatalogAttributeCityAvailabilityRow[]>([]);
  const [dirty, setDirty] = useState(false);

  const { data, isLoading, isError, refetch, isRefetching } = hooksConfig.useGetCityAvailability(item.id);

  useEffect(() => {
    if (data?.cities) {
      setLocalCities(data.cities);
      setDirty(false);
    }
  }, [data]);

  const saveMutation = hooksConfig.useSetCityAvailability();
  const bulkMutation = hooksConfig.useBulkSetCityAvailability();

  function handleSave() {
    const updates = localCities.map((c) => ({ city_id: c.city_id, is_enabled: c.is_enabled }));
    saveMutation.mutate(
      { id: item.id, data: updates },
      {
        onSuccess: () => {
          toast({ title: "City availability saved" });
          queryClient.invalidateQueries({ queryKey: hooksConfig.getListQueryKey() });
          queryClient.invalidateQueries({ queryKey: hooksConfig.getCityAvailabilityQueryKey(item.id) });
          setDirty(false);
        },
        onError: () => toast({ title: "Failed to save", variant: "destructive" }),
      },
    );
  }

  function handleBulk(enableAll: boolean) {
    bulkMutation.mutate(
      { id: item.id, data: { enable_all: enableAll } },
      {
        onSuccess: () => {
          toast({ title: "Updated all cities" });
          queryClient.invalidateQueries({ queryKey: hooksConfig.getListQueryKey() });
          queryClient.invalidateQueries({ queryKey: hooksConfig.getCityAvailabilityQueryKey(item.id) });
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

  const enabledCount = localCities.filter((c) => c.is_enabled).length;
  const totalCities = data?.total_cities ?? localCities.length;

  function toggleCity(cityId: number, enabled: boolean) {
    setLocalCities((prev) => prev.map((c) => c.city_id === cityId ? { ...c, is_enabled: enabled } : c));
    setDirty(true);
  }

  return (
    <div className="fixed inset-0 z-50 flex">
      <div className="flex-1 bg-black/40" onClick={onClose} />
      <div className="w-full max-w-lg bg-background border-l border-border flex flex-col h-full shadow-2xl">
        <div className="flex items-center justify-between px-6 py-4 border-b border-border">
          <div>
            <h2 className="text-lg font-semibold">Manage City Availability</h2>
            <p className="text-sm text-muted-foreground">{item.name}</p>
          </div>
          <div className="flex items-center gap-2">
            <Badge variant={item.is_active ? "default" : "secondary"}>
              {item.is_active ? "Globally Active" : "Globally Inactive"}
            </Badge>
            <Button variant="ghost" size="icon" onClick={onClose}><X size={18} /></Button>
          </div>
        </div>

        <div className="px-6 py-4 border-b border-border space-y-3">
          <div className="flex items-center gap-3 p-3 bg-muted rounded-lg">
            <Globe size={20} className="text-primary shrink-0" />
            <div>
              <p className="font-medium text-sm">{enabledCount} of {totalCities} cities enabled</p>
              <p className="text-xs text-muted-foreground">Customers in enabled cities will see this in their catalog</p>
            </div>
          </div>
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
        </div>

        <div className="px-6 py-3 border-b border-border">
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

        <div className="flex-1 overflow-y-auto">
          {isLoading ? (
            <div className="space-y-3 p-4">
              {Array.from({ length: 5 }).map((_, i) => (
                <Skeleton key={i} className="h-12 rounded-md" />
              ))}
            </div>
          ) : isError ? (
            <div className="flex flex-col items-center justify-center py-16 text-center px-4">
              <AlertTriangle size={40} className="text-destructive mb-3" />
              <p className="text-sm font-medium">Couldn't load cities</p>
              <p className="text-xs text-muted-foreground mt-1 mb-4">
                Something went wrong while loading delivery cities. Please try again.
              </p>
              <Button
                variant="outline"
                size="sm"
                onClick={() => refetch()}
                disabled={isRefetching}
              >
                {isRefetching ? "Retrying…" : "Retry"}
              </Button>
            </div>
          ) : filtered.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-16 text-center px-4">
              <Globe size={40} className="text-muted-foreground mb-3" />
              <p className="text-sm text-muted-foreground">
                {search ? "No matching cities found" : "No cities found"}
              </p>
            </div>
          ) : (
            <div className="divide-y divide-border">
              {filtered.map((city) => (
                <div key={city.city_id} className="flex items-center justify-between px-6 py-3 hover:bg-muted/30 transition-colors">
                  <div className="min-w-0 flex-1">
                    <p className={cn("text-sm font-medium", !city.city_is_active && "text-muted-foreground")}>{city.city_name}</p>
                    <p className="text-xs text-muted-foreground">{city.country_code}</p>
                  </div>
                  <Switch
                    checked={city.is_enabled}
                    onCheckedChange={(v) => toggleCity(city.city_id, v)}
                  />
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="px-6 py-4 border-t border-border flex gap-3">
          <Button variant="outline" className="flex-1" onClick={onClose}>Cancel</Button>
          <Button
            className="flex-1"
            onClick={handleSave}
            disabled={!dirty || saveMutation.isPending}
          >
            {saveMutation.isPending ? "Saving…" : "Save Changes"}
          </Button>
        </div>
      </div>
    </div>
  );
}

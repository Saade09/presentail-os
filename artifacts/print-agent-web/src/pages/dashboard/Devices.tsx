import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { Link } from "wouter";
import {
  Smartphone,
  Trash2,
  Circle,
  ArrowRight,
  Download,
  Printer,
  MapPin,
  AlertTriangle,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import { apiFetch, queryClient } from "@/lib/queryClient";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
} from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { useToast } from "@/hooks/use-toast";
import { StaleDataBadge } from "@/components/StaleDataBadge";

type Device = {
  id: number;
  name: string;
  machine_id: string;
  os: string | null;
  agent_version: string | null;
  printers: string[];
  last_seen_at: string;
  created_at: string;
  location_id: number | null;
  location_name: string | null;
  location_country: string | null;
};

type Location = {
  id: number;
  name: string;
  country: string;
  device_count: number;
};

function timeAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

function isOnline(iso: string): boolean {
  return Date.now() - new Date(iso).getTime() < 5 * 60 * 1000;
}

const UNASSIGNED_VALUE = "__none__";

export default function DevicesPage() {
  const { t } = useTranslation();
  const { toast } = useToast();
  const { data, isLoading } = useQuery({
    queryKey: ["devices"],
    queryFn: () => apiFetch<{ devices: Device[] }>("/api/devices"),
  });

  const { data: usersData } = useQuery({
    queryKey: ["users"],
    queryFn: () => apiFetch<{ me: { role: string } }>("/api/users"),
  });

  const { data: locationsData } = useQuery({
    queryKey: ["locations"],
    queryFn: () => apiFetch<{ locations: Location[] }>("/api/locations"),
    enabled: usersData?.me.role === "owner",
  });

  const isOwner = usersData?.me.role === "owner";

  const deleteMutation = useMutation({
    mutationFn: (id: number) =>
      apiFetch(`/api/devices/${id}`, { method: "DELETE" }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["devices"] }),
  });

  const assignLocationMutation = useMutation({
    mutationFn: ({
      deviceId,
      locationId,
    }: {
      deviceId: number;
      locationId: number | null;
    }) =>
      apiFetch(`/api/devices/${deviceId}/location`, {
        method: "PATCH",
        body: JSON.stringify({ location_id: locationId }),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["devices"] });
      queryClient.invalidateQueries({ queryKey: ["locations"] });
      queryClient.invalidateQueries({ queryKey: ["location-detail"] });
    },
  });

  const { data: settingsData } = useQuery({
    queryKey: ["workspace-settings"],
    queryFn: () => apiFetch<{ offline_alert_threshold_minutes: number }>("/api/settings"),
  });

  const devices = data?.devices ?? [];
  const locations = locationsData?.locations ?? [];
  const offlineThresholdMs = (settingsData?.offline_alert_threshold_minutes ?? 5) * 60 * 1000;
  const offlineDevices = devices.filter((d) => Date.now() - new Date(d.last_seen_at).getTime() >= offlineThresholdMs);
  const [printersFor, setPrintersFor] = useState<Device | null>(null);

  const handleLocationChange = (device: Device, value: string) => {
    const newLocationId = value === UNASSIGNED_VALUE ? null : parseInt(value, 10);
    assignLocationMutation.mutate(
      { deviceId: device.id, locationId: newLocationId },
      {
        onSuccess: () => {
          const loc = locations.find((l) => l.id === newLocationId);
          toast({
            title: newLocationId
              ? `Assigned to ${loc?.name ?? "location"}`
              : "Removed from location",
          });
        },
      },
    );
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">{t("devices.title")}</h1>
          <p className="text-muted-foreground mt-2">
            {t("devices.description")}
          </p>
        </div>
        <StaleDataBadge
          queries={[{ queryKey: ["devices"], url: "/api/devices" }]}
          data-testid="devices-stale-badge"
        />
      </div>

      {!isLoading && offlineDevices.length > 0 && (
        <div
          className="flex items-start gap-3 rounded-lg border border-amber-300 bg-amber-50 px-4 py-3 text-amber-900"
          data-testid="devices-offline-alert-banner"
        >
          <AlertTriangle size={18} className="shrink-0 mt-0.5 text-amber-600" />
          <div className="flex-1 min-w-0 text-sm">
            <p className="font-semibold">
              {offlineDevices.length === 1
                ? "1 device has been offline"
                : `${offlineDevices.length} devices have been offline`}{" "}
              for more than {settingsData?.offline_alert_threshold_minutes ?? 5} minutes
            </p>
            <p className="mt-0.5 text-amber-800">
              {offlineDevices.map((d) => d.name).join(", ")}
            </p>
          </div>
          <Link
            href="/settings"
            className="text-xs font-medium text-amber-700 underline underline-offset-2 hover:text-amber-900 shrink-0"
          >
            Alert settings
          </Link>
        </div>
      )}

      {isLoading ? (
        <div className="grid gap-4">
          {[1, 2, 3].map((i) => (
            <Card key={i}>
              <CardHeader>
                <div className="flex items-start justify-between gap-4">
                  <div className="flex items-center gap-3">
                    <div className="w-10 h-10 rounded-md bg-muted animate-pulse shrink-0" />
                    <div className="space-y-2">
                      <div className="h-5 w-36 rounded bg-muted animate-pulse" />
                      <div className="h-3.5 w-24 rounded bg-muted animate-pulse" />
                    </div>
                  </div>
                </div>
              </CardHeader>
              <CardContent className="grid grid-cols-2 md:grid-cols-4 gap-4 text-sm">
                {[1, 2, 3, 4].map((j) => (
                  <div key={j}>
                    <div className="h-3 w-16 rounded bg-muted animate-pulse" />
                    <div className="h-4 w-20 rounded bg-muted animate-pulse mt-2" />
                  </div>
                ))}
              </CardContent>
            </Card>
          ))}
        </div>
      ) : devices.length === 0 ? (
        <Card>
          <CardContent className="py-12 px-6 space-y-6 text-center">
            <Smartphone className="w-12 h-12 mx-auto text-muted-foreground" />
            <div className="space-y-2">
              <p className="font-medium text-lg">{t("devices.noDevicesTitle")}</p>
              <p className="text-sm text-muted-foreground max-w-md mx-auto">
                {t("devices.noDevicesDesc")}
              </p>
            </div>

            <div className="flex flex-wrap gap-3 justify-center">
              <Link href="/downloads">
                <Button variant="outline" data-testid="button-download">
                  <Download size={16} className="mr-1.5" />
                  {t("devices.downloadInstaller")}
                </Button>
              </Link>
              <Link href="/connect">
                <Button data-testid="button-connect">
                  {t("devices.connectThisMac")}
                  <ArrowRight size={16} className="ml-1.5" />
                </Button>
              </Link>
            </div>

            <p className="text-xs text-muted-foreground pt-2">
              {t("devices.installerNote")}
            </p>
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-4">
          {devices.map((d) => (
            <Card key={d.id} data-testid={`device-${d.id}`}>
              <CardHeader>
                <div className="flex items-start justify-between gap-4">
                  <div className="flex items-center gap-3">
                    <div className="w-10 h-10 rounded-md bg-secondary flex items-center justify-center">
                      <Smartphone size={20} />
                    </div>
                    <div>
                      <div className="flex items-center gap-2 flex-wrap">
                        <CardTitle className="text-lg">{d.name}</CardTitle>
                        {d.location_name && (
                          <Badge
                            variant="secondary"
                            className="gap-1 text-xs font-normal"
                            data-testid={`badge-location-${d.id}`}
                          >
                            <MapPin size={10} />
                            {d.location_name}
                          </Badge>
                        )}
                      </div>
                      <CardDescription className="flex items-center gap-2 mt-1">
                        <Circle
                          size={8}
                          className={
                            isOnline(d.last_seen_at)
                              ? "fill-green-500 text-green-500"
                              : "fill-muted-foreground text-muted-foreground"
                          }
                        />
                        {isOnline(d.last_seen_at) ? t("common.online") : t("common.offline")} ·
                        {t("devices.lastSeen", { time: timeAgo(d.last_seen_at) })}
                      </CardDescription>
                    </div>
                  </div>
                  {isOwner && (
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => {
                        if (confirm(`Remove ${d.name}?`))
                          deleteMutation.mutate(d.id);
                      }}
                      data-testid={`button-delete-device-${d.id}`}
                    >
                      <Trash2 size={16} className="text-destructive" />
                    </Button>
                  )}
                </div>
              </CardHeader>
              <CardContent className="grid grid-cols-2 md:grid-cols-4 gap-4 text-sm">
                <div>
                  <div className="text-xs text-muted-foreground uppercase tracking-wide">
                    OS
                  </div>
                  <div className="font-medium mt-1">{d.os ?? "Unknown"}</div>
                </div>
                <div>
                  <div className="text-xs text-muted-foreground uppercase tracking-wide">
                    Agent
                  </div>
                  <div className="font-medium mt-1">
                    v{d.agent_version ?? "?"}
                  </div>
                </div>
                <div>
                  <div className="text-xs text-muted-foreground uppercase tracking-wide">
                    Machine ID
                  </div>
                  <div className="font-mono text-xs mt-1 truncate">
                    {d.machine_id}
                  </div>
                </div>
                <div>
                  <div className="text-xs text-muted-foreground uppercase tracking-wide">
                    Printers
                  </div>
                  <Button
                    variant="link"
                    size="sm"
                    className="h-auto p-0 mt-1 font-medium text-foreground hover:text-primary"
                    onClick={() => setPrintersFor(d)}
                    disabled={(d.printers?.length ?? 0) === 0}
                    data-testid={`button-view-printers-${d.id}`}
                  >
                    {d.printers?.length ?? 0}{" "}
                    {(d.printers?.length ?? 0) > 0 && (
                      <span className="ml-1 text-xs text-muted-foreground">
                        view
                      </span>
                    )}
                  </Button>
                </div>
              </CardContent>

              {isOwner && (
                <CardContent className="pt-0 border-t mt-0">
                  <div className="flex items-center gap-2 pt-3">
                    <MapPin size={14} className="text-muted-foreground shrink-0" />
                    <span className="text-xs text-muted-foreground whitespace-nowrap">{t("devices.location")}:</span>
                    <Select
                      value={d.location_id !== null ? String(d.location_id) : UNASSIGNED_VALUE}
                      onValueChange={(v) => handleLocationChange(d, v)}
                      disabled={assignLocationMutation.isPending}
                    >
                      <SelectTrigger
                        className="h-7 text-xs flex-1 max-w-xs"
                        data-testid={`select-device-location-${d.id}`}
                      >
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value={UNASSIGNED_VALUE} className="text-xs">
                          {t("devices.unassigned")}
                        </SelectItem>
                        {locations.map((loc) => (
                          <SelectItem key={loc.id} value={String(loc.id)} className="text-xs">
                            {loc.name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                </CardContent>
              )}
            </Card>
          ))}
        </div>
      )}

      <Dialog
        open={printersFor !== null}
        onOpenChange={(open) => !open && setPrintersFor(null)}
      >
        <DialogContent data-testid="dialog-printers">
          <DialogHeader>
            <DialogTitle>Printers on {printersFor?.name}</DialogTitle>
            <DialogDescription>
              {printersFor?.printers?.length ?? 0} printer
              {(printersFor?.printers?.length ?? 0) === 1 ? "" : "s"} detected
              by Presentail OS on this device.
            </DialogDescription>
          </DialogHeader>
          {printersFor?.printers && printersFor.printers.length > 0 ? (
            <ul className="divide-y rounded-md border">
              {printersFor.printers.map((p, idx) => (
                <li
                  key={`${p}-${idx}`}
                  className="flex items-center gap-3 px-4 py-3"
                  data-testid={`printer-item-${p}`}
                >
                  <Printer
                    size={16}
                    className="text-muted-foreground shrink-0"
                  />
                  <span className="font-mono text-sm break-all">{p}</span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-muted-foreground">
              No printers detected. Add a printer in System Settings on this
              Mac, then wait for the agent to refresh.
            </p>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}

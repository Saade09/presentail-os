import { useQuery } from "@tanstack/react-query";
import { Download, Command, Monitor, Puzzle } from "lucide-react";
import { useTranslation } from "react-i18next";
import { StaleDataBadge } from "@/components/StaleDataBadge";
import { apiFetch } from "@/lib/queryClient";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
} from "@/components/ui/card";

type Version = {
  platform: string;
  version: string;
  label: string;
  extension: string;
  downloadUrl: string;
  releasedAt: string;
  downloadCount: number;
  lastDownloadedAt: string | null;
};

const ICONS: Record<string, typeof Command> = {
  mac: Command,
  windows: Monitor,
  chrome: Puzzle,
};

export default function DownloadsPage() {
  const { t } = useTranslation();
  const { data, isLoading } = useQuery({
    queryKey: ["downloads-versions"],
    queryFn: () =>
      apiFetch<{ versions: Version[] }>("/api/downloads/versions"),
  });

  const versions = data?.versions ?? [];

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">{t("downloads.title")}</h1>
          <p className="text-muted-foreground mt-2">
            {t("downloads.description")}
          </p>
        </div>
        <StaleDataBadge
          queries={[{ queryKey: ["downloads-versions"], url: "/api/downloads/versions" }]}
          data-testid="downloads-stale-badge"
        />
      </div>

      {isLoading ? (
        <Card>
          <CardContent className="py-12 text-center text-muted-foreground">
            {t("common.loading")}
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-4 md:grid-cols-2">
          {versions.map((v) => {
            const Icon = ICONS[v.platform] ?? Download;
            return (
              <Card key={v.platform} data-testid={`version-${v.platform}`}>
                <CardHeader>
                  <div className="flex items-start gap-4">
                    <div className="w-12 h-12 rounded-md bg-primary text-primary-foreground flex items-center justify-center">
                      <Icon size={24} />
                    </div>
                    <div className="flex-1">
                      <CardTitle>{v.label}</CardTitle>
                      <CardDescription className="mt-1">
                        Version {v.version} · {v.extension}
                      </CardDescription>
                    </div>
                  </div>
                </CardHeader>
                <CardContent className="space-y-4">
                  <div className="grid grid-cols-2 gap-4 text-sm">
                    <div>
                      <div className="text-xs text-muted-foreground uppercase tracking-wide">
                        {t("downloads.released")}
                      </div>
                      <div className="font-medium mt-1">
                        {new Date(v.releasedAt).toLocaleDateString()}
                      </div>
                    </div>
                    <div>
                      <div className="text-xs text-muted-foreground uppercase tracking-wide">
                        {t("downloads.yourDownloads")}
                      </div>
                      <div className="font-medium mt-1">
                        {v.downloadCount}
                      </div>
                    </div>
                  </div>
                  <Button asChild className="w-full gap-2">
                    <a
                      href={v.downloadUrl}
                      download
                      data-testid={`button-download-${v.platform}`}
                    >
                      <Download size={16} />
                      {t("downloads.downloadForPlatform", { label: v.label }) || `Download ${v.label}`}
                    </a>
                  </Button>
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}

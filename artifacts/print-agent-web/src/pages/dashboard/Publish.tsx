import { useMutation } from "@tanstack/react-query";
import { apiFetch } from "@/lib/queryClient";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { useToast } from "@/hooks/use-toast";
import { Rss, CheckCircle2, XCircle, Loader2, AlertTriangle } from "lucide-react";
import { useTranslation } from "react-i18next";

type PublishArea = "delivery" | "catalog_attributes" | "products";

type PublishAreaResult = {
  area: PublishArea;
  success: boolean;
  count: number;
  error?: string;
};

type PublishSnapshotResult = {
  success: boolean;
  results: PublishAreaResult[];
};

const AREA_LABEL_KEYS: Record<PublishArea, string> = {
  delivery: "publish.areaDelivery",
  catalog_attributes: "publish.areaCatalogAttributes",
  products: "publish.areaProducts",
};

export default function PublishPage() {
  const { t } = useTranslation();
  const { toast } = useToast();

  const mutation = useMutation<PublishSnapshotResult>({
    mutationFn: () => apiFetch("/api/publish", { method: "POST" }) as Promise<PublishSnapshotResult>,
    onSuccess: (data) => {
      if (data.success) {
        toast({ title: t("publish.toastSuccessTitle"), description: t("publish.toastSuccessDesc") });
      } else {
        toast({
          variant: "destructive",
          title: t("publish.toastPartialTitle"),
          description: t("publish.toastPartialDesc"),
        });
      }
    },
    onError: () => {
      toast({
        variant: "destructive",
        title: t("publish.toastErrorTitle"),
        description: t("publish.toastErrorDesc"),
      });
    },
  });

  const result = mutation.data;
  const isPending = mutation.isPending;
  const hasFailures = result ? !result.success : false;

  return (
    <div className="mx-auto max-w-3xl space-y-6 p-4 sm:p-6">
      <div className="flex items-center gap-3">
        <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary/10 text-primary">
          <Rss className="h-5 w-5" />
        </div>
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">{t("publish.title")}</h1>
          <p className="text-sm text-muted-foreground">{t("publish.subtitle")}</p>
        </div>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>{t("publish.cardTitle")}</CardTitle>
          <CardDescription>{t("publish.cardDescription")}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <ul className="list-disc space-y-1 pl-5 text-sm text-muted-foreground">
            <li>{t("publish.includeDelivery")}</li>
            <li>{t("publish.includeCatalogAttributes")}</li>
            <li>{t("publish.includeProducts")}</li>
          </ul>

          <Button onClick={() => mutation.mutate()} disabled={isPending} data-testid="button-publish">
            {isPending ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                {t("publish.publishing")}
              </>
            ) : result ? (
              t("publish.republish")
            ) : (
              t("publish.publishNow")
            )}
          </Button>

          {isPending && (
            <p className="text-sm text-muted-foreground" data-testid="text-publish-progress">
              {t("publish.progressNote")}
            </p>
          )}
        </CardContent>
      </Card>

      {result && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              {result.success ? (
                <CheckCircle2 className="h-5 w-5 text-green-600" />
              ) : (
                <AlertTriangle className="h-5 w-5 text-amber-600" />
              )}
              {result.success ? t("publish.resultSuccessTitle") : t("publish.resultPartialTitle")}
            </CardTitle>
            <CardDescription>
              {result.success ? t("publish.resultSuccessDesc") : t("publish.resultPartialDesc")}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            {result.results.map((area) => (
              <div
                key={area.area}
                className="flex items-start justify-between gap-3 rounded-md border p-3"
                data-testid={`result-area-${area.area}`}
              >
                <div className="flex items-start gap-2">
                  {area.success ? (
                    <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-green-600" />
                  ) : (
                    <XCircle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
                  )}
                  <div>
                    <p className="text-sm font-medium">{t(AREA_LABEL_KEYS[area.area])}</p>
                    {area.success ? (
                      <p className="text-xs text-muted-foreground">
                        {t("publish.recordsPublished", { count: area.count })}
                      </p>
                    ) : (
                      <p className="text-xs text-destructive">{area.error ?? t("publish.areaFailed")}</p>
                    )}
                  </div>
                </div>
              </div>
            ))}

            {hasFailures && (
              <Button
                variant="outline"
                onClick={() => mutation.mutate()}
                disabled={isPending}
                data-testid="button-retry-publish"
              >
                {isPending ? (
                  <>
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    {t("publish.publishing")}
                  </>
                ) : (
                  t("publish.retry")
                )}
              </Button>
            )}
          </CardContent>
        </Card>
      )}
    </div>
  );
}

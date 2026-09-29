import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  TotersImportPreviewResponse,
  TotersImportResultResponse,
  TotersImportBatchListResponse,
} from "@workspace/api-client-react";
import { Upload, FileSpreadsheet, CheckCircle2, AlertTriangle, RotateCcw } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { apiFetch } from "@/lib/queryClient";

function formatUsd(v: number): string {
  return v.toLocaleString(undefined, {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

type Step = "idle" | "preview" | "result";

/**
 * Toters Imports — upload a Toters sales CSV, review the validation preview
 * (rows, new orders, duplicates, invalid rows, excluded non-arrived orders,
 * revenue to be added), confirm the import, and browse past batches.
 */
export function TotersImportsSection({ onImported }: { onImported?: () => void }) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [step, setStep] = useState<Step>("idle");
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<TotersImportPreviewResponse | null>(null);
  const [result, setResult] = useState<TotersImportResultResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const historyQuery = useQuery({
    queryKey: ["/api/toters-imports"],
    queryFn: () => apiFetch<TotersImportBatchListResponse>("/api/toters-imports"),
  });

  async function handleFileSelected(file: File) {
    setError(null);
    setSelectedFile(file);
    setBusy(true);
    try {
      const fd = new FormData();
      fd.append("file", file);
      const data = await apiFetch<TotersImportPreviewResponse>("/api/toters-imports/preview", {
        method: "POST",
        body: fd,
      });
      setPreview(data);
      setStep("preview");
    } catch (err) {
      setError(err instanceof Error ? err.message : t("totersImports.previewFailed"));
      setSelectedFile(null);
    } finally {
      setBusy(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  }

  async function handleConfirm() {
    if (!selectedFile) return;
    setBusy(true);
    setError(null);
    try {
      const fd = new FormData();
      fd.append("file", selectedFile);
      const data = await apiFetch<TotersImportResultResponse>("/api/toters-imports", {
        method: "POST",
        body: fd,
      });
      setResult(data);
      setStep("result");
      queryClient.invalidateQueries({ queryKey: ["/api/toters-imports"] });
      onImported?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("totersImports.importFailed"));
    } finally {
      setBusy(false);
    }
  }

  function reset() {
    setStep("idle");
    setSelectedFile(null);
    setPreview(null);
    setResult(null);
    setError(null);
  }

  const batches = historyQuery.data?.batches ?? [];

  return (
    <Card data-testid="toters-imports">
      <CardHeader className="pb-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <CardTitle className="text-base font-semibold">
              {t("totersImports.title")}
            </CardTitle>
            <p className="text-sm text-muted-foreground mt-1">{t("totersImports.subtitle")}</p>
          </div>
          {step === "idle" && (
            <>
              <input
                ref={fileInputRef}
                type="file"
                accept=".csv,.xlsx,.xls"
                className="hidden"
                data-testid="toters-file-input"
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (file) void handleFileSelected(file);
                }}
              />
              <Button
                size="sm"
                className="gap-1.5"
                disabled={busy}
                onClick={() => fileInputRef.current?.click()}
                data-testid="toters-upload-button"
              >
                <Upload size={14} aria-hidden />
                {busy ? t("totersImports.validating") : t("totersImports.uploadCta")}
              </Button>
            </>
          )}
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {error && (
          <div
            className="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm text-destructive"
            data-testid="toters-error"
          >
            <AlertTriangle size={16} className="shrink-0 mt-0.5" aria-hidden />
            <p>{error}</p>
          </div>
        )}

        {step === "preview" && preview && (
          <div className="rounded-lg border p-4 space-y-3" data-testid="toters-preview">
            <p className="flex items-center gap-2 text-sm font-medium">
              <FileSpreadsheet size={16} aria-hidden />
              {preview.file_name}
            </p>
            <dl className="grid grid-cols-2 gap-x-6 gap-y-1.5 text-sm sm:grid-cols-3">
              <div className="flex justify-between sm:block">
                <dt className="text-muted-foreground">{t("totersImports.detectedRows")}</dt>
                <dd className="font-medium" data-testid="toters-preview-total">{preview.total_rows}</dd>
              </div>
              <div className="flex justify-between sm:block">
                <dt className="text-muted-foreground">{t("totersImports.newOrders")}</dt>
                <dd className="font-medium" data-testid="toters-preview-new">{preview.new_orders}</dd>
              </div>
              <div className="flex justify-between sm:block">
                <dt className="text-muted-foreground">{t("totersImports.duplicates")}</dt>
                <dd className="font-medium" data-testid="toters-preview-duplicates">
                  {preview.duplicate_orders}
                </dd>
              </div>
              <div className="flex justify-between sm:block">
                <dt className="text-muted-foreground">{t("totersImports.invalidRows")}</dt>
                <dd className="font-medium" data-testid="toters-preview-invalid">
                  {preview.invalid_rows.length}
                </dd>
              </div>
              <div className="flex justify-between sm:block">
                <dt className="text-muted-foreground">{t("totersImports.excludedOrders")}</dt>
                <dd className="font-medium" data-testid="toters-preview-excluded">
                  {preview.excluded_orders}
                </dd>
              </div>
              <div className="flex justify-between sm:block">
                <dt className="text-muted-foreground">{t("totersImports.revenueToAdd")}</dt>
                <dd className="font-semibold" data-testid="toters-preview-revenue">
                  {formatUsd(preview.revenue_to_add)}
                </dd>
              </div>
            </dl>
            {preview.invalid_rows.length > 0 && (
              <div className="text-xs text-muted-foreground">
                {t("totersImports.invalidRowsDetail")}{" "}
                {preview.invalid_rows
                  .slice(0, 8)
                  .map((r) => `#${r.row} (${r.reason})`)
                  .join(", ")}
                {preview.invalid_rows.length > 8 ? "…" : ""}
              </div>
            )}
            <div className="flex items-center gap-2">
              <Button
                size="sm"
                onClick={() => void handleConfirm()}
                disabled={busy || preview.new_orders === 0}
                data-testid="toters-confirm-button"
              >
                {busy ? t("totersImports.importing") : t("totersImports.confirmCta")}
              </Button>
              <Button size="sm" variant="outline" onClick={reset} disabled={busy} data-testid="toters-cancel-button">
                {t("totersImports.cancel")}
              </Button>
              {preview.new_orders === 0 && (
                <span className="text-xs text-muted-foreground">
                  {t("totersImports.nothingToImport")}
                </span>
              )}
            </div>
          </div>
        )}

        {step === "result" && result && (
          <div className="rounded-lg border p-4 space-y-3" data-testid="toters-result">
            <p className="flex items-center gap-2 text-sm font-medium text-green-700">
              <CheckCircle2 size={16} aria-hidden />
              {t("totersImports.importDone")}
            </p>
            <dl className="grid grid-cols-2 gap-x-6 gap-y-1.5 text-sm sm:grid-cols-4">
              <div className="flex justify-between sm:block">
                <dt className="text-muted-foreground">{t("totersImports.inserted")}</dt>
                <dd className="font-medium" data-testid="toters-result-inserted">{result.inserted}</dd>
              </div>
              <div className="flex justify-between sm:block">
                <dt className="text-muted-foreground">{t("totersImports.skippedDuplicates")}</dt>
                <dd className="font-medium" data-testid="toters-result-skipped">
                  {result.skipped_duplicates}
                </dd>
              </div>
              <div className="flex justify-between sm:block">
                <dt className="text-muted-foreground">{t("totersImports.rejected")}</dt>
                <dd className="font-medium" data-testid="toters-result-rejected">
                  {result.rejected_rows.length}
                </dd>
              </div>
              <div className="flex justify-between sm:block">
                <dt className="text-muted-foreground">{t("totersImports.revenueAdded")}</dt>
                <dd className="font-semibold" data-testid="toters-result-revenue">
                  {formatUsd(result.revenue_added)}
                </dd>
              </div>
            </dl>
            <Button size="sm" variant="outline" onClick={reset} className="gap-1.5" data-testid="toters-again-button">
              <RotateCcw size={14} aria-hidden />
              {t("totersImports.importAnother")}
            </Button>
          </div>
        )}

        {/* Import history */}
        <div>
          <h3 className="text-sm font-semibold mb-2">{t("totersImports.historyTitle")}</h3>
          {historyQuery.isLoading ? (
            <div className="space-y-2">
              <Skeleton className="h-8 w-full" />
              <Skeleton className="h-8 w-full" />
            </div>
          ) : batches.length === 0 ? (
            <p className="text-sm text-muted-foreground" data-testid="toters-history-empty">
              {t("totersImports.historyEmpty")}
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm" data-testid="toters-history">
                <thead>
                  <tr className="border-b text-left text-xs text-muted-foreground">
                    <th className="py-1.5 pr-3 font-medium">{t("totersImports.historyDate")}</th>
                    <th className="py-1.5 pr-3 font-medium">{t("totersImports.historyFile")}</th>
                    <th className="py-1.5 pr-3 font-medium text-right">{t("totersImports.inserted")}</th>
                    <th className="py-1.5 pr-3 font-medium text-right">
                      {t("totersImports.skippedDuplicates")}
                    </th>
                    <th className="py-1.5 pr-3 font-medium text-right">{t("totersImports.rejected")}</th>
                    <th className="py-1.5 font-medium text-right">{t("totersImports.revenueAdded")}</th>
                  </tr>
                </thead>
                <tbody>
                  {batches.map((b) => (
                    <tr key={b.id} className="border-b last:border-0" data-testid={`toters-batch-${b.id}`}>
                      <td className="py-1.5 pr-3 whitespace-nowrap">
                        {new Date(b.created_at).toLocaleString()}
                      </td>
                      <td className="py-1.5 pr-3 max-w-[220px] truncate">{b.file_name ?? "—"}</td>
                      <td className="py-1.5 pr-3 text-right">{b.inserted}</td>
                      <td className="py-1.5 pr-3 text-right">{b.skipped_duplicates}</td>
                      <td className="py-1.5 pr-3 text-right">{b.rejected}</td>
                      <td className="py-1.5 text-right font-medium">{formatUsd(b.revenue_added)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

import { useCallback, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  FileSpreadsheet,
  Loader2,
  Save,
  Trash2,
  Upload,
  X,
  AlertCircle,
} from "lucide-react";
import { apiFetch } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Progress } from "@/components/ui/progress";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { cn } from "@/lib/utils";

export type AccountingSource = {
  id: number;
  entity_id: number;
  name: string;
  source_type: string;
  is_auto_sync: boolean;
  source_month_id: number | null;
  sales_status: string | null;
  last_synced_at: string | null;
  rows_count: number | null;
};

type ImportTemplate = {
  id: number;
  name: string;
  source_type: string;
  column_mappings: Record<string, string>;
};

type PreviewResponse = {
  filename: string;
  fileType: "csv" | "excel";
  headers: string[];
  previewRows: Record<string, unknown>[];
};

type ConfirmResponse = {
  syncRunId: number;
  rowsAccepted: number;
  rowsInserted: number;
  rowsSkipped: number;
  rowsRejected: number;
  rejectedRows: Array<{ row_index: number; raw: Record<string, unknown>; reason: string }>;
  totalGross: number;
  totalRefunds: number;
};

type SyncRun = {
  id: number;
  status: string;
  started_at: string;
  filename: string | null;
  rows_accepted: number;
  rows_rejected: number;
};

const STANDARD_OS_FIELDS = [
  "transaction_id",
  "date",
  "description",
  "amount",
  "currency",
  "reference",
] as const;

const BANK_TRANSFER_FIELDS = [
  "related_ltd_ref",
  "invoice_ref",
  "transfer_date",
  "recognition_date",
  "sending_bank",
  "receiving_bank",
  "orig_currency",
  "orig_amount",
  "exchange_rate",
  "reporting_amount",
  "bank_fees",
  "expected_amount",
  "received_amount",
  "difference",
  "document_link",
] as const;

const MARKETPLACE_FIELDS = [
  "gross_sales",
  "cancellations",
  "refunds",
  "commission",
  "vat_on_commission",
  "platform_promotions",
  "own_promotions",
  "delivery_charges",
  "penalties",
  "other_adjustments",
  "net_payout",
  "actual_payout",
  "difference",
] as const;

const MARKETPLACE_SOURCE_TYPES = ["toters", "wolt", "bolt", "foodie"];
const BANK_TRANSFER_SOURCE_TYPES = ["bank_transfer"];

function getOsFields(sourceType: string): readonly string[] {
  if (MARKETPLACE_SOURCE_TYPES.some((t) => sourceType.includes(t))) {
    return [...STANDARD_OS_FIELDS, ...MARKETPLACE_FIELDS];
  }
  if (BANK_TRANSFER_SOURCE_TYPES.some((t) => sourceType.includes(t))) {
    return [...STANDARD_OS_FIELDS, ...BANK_TRANSFER_FIELDS];
  }
  return STANDARD_OS_FIELDS;
}

const STEPS = ["upload", "map", "preview", "confirm"] as const;
type Step = (typeof STEPS)[number];

function StepIndicator({ current, steps }: { current: Step; steps: readonly Step[] }) {
  const { t } = useTranslation();
  const idx = steps.indexOf(current);
  return (
    <div className="flex items-center gap-2 mb-6">
      {steps.map((step, i) => (
        <div key={step} className="flex items-center gap-2">
          <div
            className={cn(
              "flex items-center justify-center w-7 h-7 rounded-full text-xs font-semibold",
              i < idx
                ? "bg-teal-700 text-white"
                : i === idx
                  ? "bg-teal-600 text-white ring-2 ring-teal-200"
                  : "bg-muted text-muted-foreground",
            )}
          >
            {i < idx ? <CheckCircle2 size={14} /> : i + 1}
          </div>
          <span
            className={cn(
              "text-xs font-medium hidden sm:inline",
              i === idx ? "text-teal-700" : "text-muted-foreground",
            )}
          >
            {t(`accounting.import.steps.${step}`)}
          </span>
          {i < steps.length - 1 && <div className="w-6 h-px bg-border mx-1" />}
        </div>
      ))}
    </div>
  );
}

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  source: AccountingSource | null;
  sourceMonthId: number | null;
  year: number;
  month: number;
  onImportComplete: () => void;
};

export function ImportStatementDrawer({
  open,
  onOpenChange,
  source,
  sourceMonthId,
  year,
  month,
  onImportComplete,
}: Props) {
  const { t } = useTranslation();
  const { toast } = useToast();
  const qc = useQueryClient();
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [step, setStep] = useState<Step>("upload");
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<PreviewResponse | null>(null);
  const [mappings, setMappings] = useState<Record<string, string>>({});
  const [selectedTemplateId, setSelectedTemplateId] = useState<string>("");
  const [saveTemplate, setSaveTemplate] = useState(false);
  const [templateName, setTemplateName] = useState("");
  const [confirmResult, setConfirmResult] = useState<ConfirmResponse | null>(null);
  const [activeSourceMonthId, setActiveSourceMonthId] = useState<number | null>(null);

  const effectiveSourceMonthId = activeSourceMonthId ?? sourceMonthId;

  const { data: templatesData } = useQuery<{ templates: ImportTemplate[] }>({
    queryKey: ["import-templates", source?.source_type],
    queryFn: () =>
      apiFetch(`/accounting/import-templates?sourceType=${source?.source_type ?? ""}`),
    enabled: open && !!source,
  });
  const templates = templatesData?.templates ?? [];

  const { data: syncRunsData } = useQuery<{ syncRuns: SyncRun[] }>({
    queryKey: ["sync-runs", effectiveSourceMonthId],
    queryFn: () => apiFetch(`/accounting/source-months/${effectiveSourceMonthId}/sync-runs`),
    enabled: open && !!effectiveSourceMonthId,
  });
  const syncRuns = syncRunsData?.syncRuns ?? [];

  const ensureMutation = useMutation({
    mutationFn: (body: { source_id: number; year: number; month: number }) =>
      apiFetch<{ sourceMonth: { id: number } }>("/accounting/source-months/ensure", {
        method: "POST",
        body: JSON.stringify(body),
      }),
  });

  const previewMutation = useMutation({
    mutationFn: async ({ smId, f }: { smId: number; f: File }) => {
      const fd = new FormData();
      fd.append("file", f);
      return apiFetch<PreviewResponse>(`/accounting/source-months/${smId}/import/preview`, {
        method: "POST",
        body: fd,
      });
    },
    onSuccess: (data) => {
      setPreview(data);
      if (selectedTemplateId) {
        const tpl = templates.find((t) => String(t.id) === selectedTemplateId);
        if (tpl) setMappings(tpl.column_mappings);
      }
      setStep("map");
    },
    onError: (err: Error) => {
      toast({ title: t("accounting.import.parseError"), description: err.message, variant: "destructive" });
    },
  });

  const confirmMutation = useMutation({
    mutationFn: async ({ smId, f }: { smId: number; f: File }) => {
      const fd = new FormData();
      fd.append("file", f);
      fd.append(
        "mapping",
        JSON.stringify({
          column_mappings: mappings,
          save_template: saveTemplate,
          template_name: templateName || undefined,
          template_id: selectedTemplateId ? parseInt(selectedTemplateId) : undefined,
          source_type: source?.source_type,
        }),
      );
      return apiFetch<ConfirmResponse>(`/accounting/source-months/${smId}/import/confirm`, {
        method: "POST",
        body: fd,
      });
    },
    onSuccess: (data) => {
      setConfirmResult(data);
      setStep("confirm");
      qc.invalidateQueries({ queryKey: ["accounting-sources"] });
      qc.invalidateQueries({ queryKey: ["sync-runs", effectiveSourceMonthId] });
      if (saveTemplate) {
        qc.invalidateQueries({ queryKey: ["import-templates", source?.source_type] });
      }
    },
    onError: (err: Error) => {
      toast({ title: t("accounting.import.importError"), description: err.message, variant: "destructive" });
    },
  });

  const rollbackMutation = useMutation({
    mutationFn: async ({ smId, runId }: { smId: number; runId: number }) =>
      apiFetch(`/accounting/source-months/${smId}/import/${runId}`, { method: "DELETE" }),
    onSuccess: () => {
      toast({ title: t("accounting.import.rollbackSuccess") });
      qc.invalidateQueries({ queryKey: ["accounting-sources"] });
      qc.invalidateQueries({ queryKey: ["sync-runs", effectiveSourceMonthId] });
    },
    onError: (err: Error) => {
      toast({ title: t("accounting.import.rollbackError"), description: err.message, variant: "destructive" });
    },
  });

  function reset() {
    setStep("upload");
    setFile(null);
    setPreview(null);
    setMappings({});
    setSelectedTemplateId("");
    setSaveTemplate(false);
    setTemplateName("");
    setConfirmResult(null);
    setActiveSourceMonthId(null);
  }

  function handleClose() {
    onOpenChange(false);
    setTimeout(reset, 300);
  }

  function handleFileChange(f: File | null) {
    setFile(f);
    setPreview(null);
  }

  function handleDrop(e: React.DragEvent) {
    e.preventDefault();
    const f = e.dataTransfer.files[0];
    if (f) handleFileChange(f);
  }

  async function handleParse() {
    if (!file || !source) return;
    let smId = effectiveSourceMonthId;
    if (!smId) {
      const ensureResult = await ensureMutation.mutateAsync({ source_id: source.id, year, month });
      smId = ensureResult.sourceMonth.id;
      setActiveSourceMonthId(smId);
    }
    previewMutation.mutate({ smId, f: file });
  }

  function handleTemplateSelect(tplId: string) {
    setSelectedTemplateId(tplId);
    if (tplId && preview) {
      const tpl = templates.find((t) => String(t.id) === tplId);
      if (tpl) setMappings(tpl.column_mappings);
    } else if (!tplId) {
      setMappings({});
    }
  }

  async function handleConfirm() {
    if (!file || !effectiveSourceMonthId) return;
    confirmMutation.mutate({ smId: effectiveSourceMonthId, f: file });
  }

  function handleImportComplete() {
    onImportComplete();
    handleClose();
  }

  const osFields = source ? getOsFields(source.source_type) : STANDARD_OS_FIELDS;
  const headers = preview?.headers ?? [];
  const isLoading = previewMutation.isPending || confirmMutation.isPending || ensureMutation.isPending;

  return (
    <Sheet open={open} onOpenChange={(o) => !o && handleClose()}>
      <SheetContent className="w-full sm:max-w-2xl flex flex-col gap-0 p-0 overflow-hidden">
        <SheetHeader className="px-6 pt-6 pb-4 border-b">
          <div className="flex items-start justify-between gap-2">
            <div>
              <SheetTitle className="text-base">
                {t("accounting.import.title")}
              </SheetTitle>
              {source && (
                <p className="text-sm text-muted-foreground mt-0.5">{source.name}</p>
              )}
            </div>
          </div>
          <StepIndicator current={step} steps={STEPS} />
        </SheetHeader>

        <div className="flex-1 overflow-y-auto px-6 py-4">
          {step === "upload" && (
            <UploadStep
              file={file}
              templates={templates}
              selectedTemplateId={selectedTemplateId}
              onTemplateSelect={handleTemplateSelect}
              onFileChange={handleFileChange}
              onDrop={handleDrop}
              fileInputRef={fileInputRef}
              syncRuns={syncRuns}
              sourceMonthId={effectiveSourceMonthId}
              onRollback={(runId) => {
                if (effectiveSourceMonthId) {
                  rollbackMutation.mutate({ smId: effectiveSourceMonthId, runId });
                }
              }}
              isRollingBack={rollbackMutation.isPending}
            />
          )}

          {step === "map" && preview && (
            <MapStep
              headers={headers}
              osFields={osFields}
              mappings={mappings}
              onMappingChange={(field, col) => setMappings((m) => ({ ...m, [field]: col }))}
              previewRows={preview.previewRows}
              saveTemplate={saveTemplate}
              onSaveTemplateChange={setSaveTemplate}
              templateName={templateName}
              onTemplateNameChange={setTemplateName}
            />
          )}

          {step === "preview" && preview && (
            <PreviewTableStep
              headers={headers}
              previewRows={preview.previewRows}
              mappings={mappings}
            />
          )}

          {step === "confirm" && confirmResult && (
            <ConfirmStep result={confirmResult} />
          )}
        </div>

        <div className="px-6 py-4 border-t flex items-center justify-between gap-3">
          {step === "upload" && (
            <>
              <Button variant="outline" onClick={handleClose}>
                {t("accounting.import.cancel")}
              </Button>
              <div className="flex gap-2">
                {preview === null && (
                  <Button
                    onClick={handleParse}
                    disabled={!file || isLoading}
                    className="gap-2"
                  >
                    {isLoading ? <Loader2 size={14} className="animate-spin" /> : <ChevronRight size={14} />}
                    {t("accounting.import.parseFile")}
                  </Button>
                )}
              </div>
            </>
          )}

          {step === "map" && (
            <>
              <Button variant="outline" onClick={() => setStep("upload")} className="gap-2">
                <ChevronLeft size={14} />
                {t("accounting.import.back")}
              </Button>
              <div className="flex gap-2">
                <Button variant="outline" onClick={() => setStep("preview")} className="gap-2">
                  {t("accounting.import.previewRows")}
                  <ChevronRight size={14} />
                </Button>
                <Button onClick={handleConfirm} disabled={isLoading} className="gap-2">
                  {isLoading ? <Loader2 size={14} className="animate-spin" /> : <Upload size={14} />}
                  {t("accounting.import.importNow")}
                </Button>
              </div>
            </>
          )}

          {step === "preview" && (
            <>
              <Button variant="outline" onClick={() => setStep("map")} className="gap-2">
                <ChevronLeft size={14} />
                {t("accounting.import.back")}
              </Button>
              <Button onClick={handleConfirm} disabled={isLoading} className="gap-2">
                {isLoading ? <Loader2 size={14} className="animate-spin" /> : <Upload size={14} />}
                {t("accounting.import.importNow")}
              </Button>
            </>
          )}

          {step === "confirm" && (
            <>
              <Button variant="outline" onClick={reset} className="gap-2">
                <Upload size={14} />
                {t("accounting.import.importAnother")}
              </Button>
              <Button onClick={handleImportComplete} className="gap-2">
                <CheckCircle2 size={14} />
                {t("accounting.import.done")}
              </Button>
            </>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}

function UploadStep({
  file,
  templates,
  selectedTemplateId,
  onTemplateSelect,
  onFileChange,
  onDrop,
  fileInputRef,
  syncRuns,
  sourceMonthId,
  onRollback,
  isRollingBack,
}: {
  file: File | null;
  templates: ImportTemplate[];
  selectedTemplateId: string;
  onTemplateSelect: (id: string) => void;
  onFileChange: (f: File | null) => void;
  onDrop: (e: React.DragEvent) => void;
  fileInputRef: React.RefObject<HTMLInputElement | null>;
  syncRuns: SyncRun[];
  sourceMonthId: number | null;
  onRollback: (runId: number) => void;
  isRollingBack: boolean;
}) {
  const { t } = useTranslation();

  return (
    <div className="flex flex-col gap-6">
      {templates.length > 0 && (
        <div className="flex flex-col gap-2">
          <Label>{t("accounting.import.useTemplate")}</Label>
          <Select value={selectedTemplateId} onValueChange={onTemplateSelect}>
            <SelectTrigger>
              <SelectValue placeholder={t("accounting.import.noTemplate")} />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="">{t("accounting.import.noTemplate")}</SelectItem>
              {templates.map((tpl) => (
                <SelectItem key={tpl.id} value={String(tpl.id)}>
                  {tpl.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      )}

      <div
        className={cn(
          "border-2 border-dashed rounded-lg p-10 text-center cursor-pointer transition-colors",
          file ? "border-teal-400 bg-teal-50" : "border-muted-foreground/25 hover:border-teal-400 hover:bg-teal-50/40",
        )}
        onDragOver={(e) => e.preventDefault()}
        onDrop={onDrop}
        onClick={() => fileInputRef.current?.click()}
      >
        <FileSpreadsheet size={32} className={cn("mx-auto mb-3", file ? "text-teal-600" : "text-muted-foreground")} />
        {file ? (
          <div>
            <p className="font-medium text-sm">{file.name}</p>
            <p className="text-xs text-muted-foreground mt-1">
              {(file.size / 1024).toFixed(0)} KB
            </p>
            <Button
              variant="ghost"
              size="sm"
              className="mt-2 text-destructive"
              onClick={(e) => { e.stopPropagation(); onFileChange(null); }}
            >
              <X size={12} className="mr-1" />
              {t("accounting.import.removeFile")}
            </Button>
          </div>
        ) : (
          <div>
            <p className="font-medium text-sm">{t("accounting.import.dropFileHere")}</p>
            <p className="text-xs text-muted-foreground mt-1">
              {t("accounting.import.fileTypes")}
            </p>
          </div>
        )}
        <input
          ref={fileInputRef}
          type="file"
          accept=".csv,.xlsx,.xls,.ods"
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0] ?? null;
            onFileChange(f);
            e.target.value = "";
          }}
        />
      </div>

      {syncRuns.length > 0 && (
        <div className="flex flex-col gap-2">
          <Label className="text-xs text-muted-foreground">{t("accounting.import.previousRuns")}</Label>
          <div className="border rounded-lg divide-y">
            {syncRuns.slice(0, 5).map((run) => (
              <div key={run.id} className="flex items-center justify-between px-3 py-2 gap-2">
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium truncate">{run.filename ?? t("accounting.import.unknownFile")}</p>
                  <p className="text-xs text-muted-foreground">
                    {new Date(run.started_at).toLocaleString()} ·{" "}
                    {run.rows_accepted} {t("accounting.import.rowsAccepted")}
                    {run.rows_rejected > 0 && (
                      <span className="text-destructive">
                        {" "}· {run.rows_rejected} {t("accounting.import.rowsRejected")}
                      </span>
                    )}
                  </p>
                </div>
                <Badge
                  variant="outline"
                  className={cn(
                    "shrink-0 text-xs",
                    run.status === "completed" && "border-green-300 text-green-700",
                  )}
                >
                  {run.status}
                </Badge>
                <Button
                  variant="ghost"
                  size="sm"
                  className="text-destructive shrink-0"
                  disabled={isRollingBack}
                  onClick={() => onRollback(run.id)}
                >
                  <Trash2 size={13} />
                </Button>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function MapStep({
  headers,
  osFields,
  mappings,
  onMappingChange,
  previewRows,
  saveTemplate,
  onSaveTemplateChange,
  templateName,
  onTemplateNameChange,
}: {
  headers: string[];
  osFields: readonly string[];
  mappings: Record<string, string>;
  onMappingChange: (field: string, col: string) => void;
  previewRows: Record<string, unknown>[];
  saveTemplate: boolean;
  onSaveTemplateChange: (v: boolean) => void;
  templateName: string;
  onTemplateNameChange: (v: string) => void;
}) {
  const { t } = useTranslation();

  return (
    <div className="flex flex-col gap-5">
      <p className="text-sm text-muted-foreground">
        {t("accounting.import.mapInstructions")}
      </p>

      <div className="grid grid-cols-1 gap-3">
        {osFields.map((field) => (
          <div key={field} className="flex items-center gap-3">
            <div className="w-44 shrink-0">
              <Label className="text-xs font-medium">
                {t(`accounting.import.fields.${field}`, { defaultValue: field })}
              </Label>
              {["amount", "date"].includes(field) && (
                <span className="text-xs text-destructive ml-1">*</span>
              )}
            </div>
            <Select
              value={mappings[field] ?? ""}
              onValueChange={(v) => onMappingChange(field, v)}
            >
              <SelectTrigger className="flex-1">
                <SelectValue placeholder={t("accounting.import.skipColumn")} />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="">{t("accounting.import.skipColumn")}</SelectItem>
                {headers.map((h) => (
                  <SelectItem key={h} value={h}>
                    {h}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {mappings[field] && previewRows[0]?.[mappings[field]] != null && (
              <span className="text-xs text-muted-foreground truncate max-w-[120px]">
                e.g. {String(previewRows[0][mappings[field]])}
              </span>
            )}
          </div>
        ))}
      </div>

      <div className="border-t pt-4 flex flex-col gap-3">
        <div className="flex items-center gap-2">
          <Checkbox
            id="save-template"
            checked={saveTemplate}
            onCheckedChange={(v) => onSaveTemplateChange(!!v)}
          />
          <Label htmlFor="save-template" className="text-sm cursor-pointer">
            <Save size={12} className="inline mr-1" />
            {t("accounting.import.saveAsTemplate")}
          </Label>
        </div>
        {saveTemplate && (
          <Input
            placeholder={t("accounting.import.templateNamePlaceholder")}
            value={templateName}
            onChange={(e) => onTemplateNameChange(e.target.value)}
            className="max-w-xs"
          />
        )}
      </div>
    </div>
  );
}

function PreviewTableStep({
  headers,
  previewRows,
  mappings,
}: {
  headers: string[];
  previewRows: Record<string, unknown>[];
  mappings: Record<string, string>;
}) {
  const { t } = useTranslation();
  const mappedCols = new Set(Object.values(mappings).filter(Boolean));
  const shownHeaders = headers.slice(0, 8);

  return (
    <div className="flex flex-col gap-3">
      <p className="text-sm text-muted-foreground">
        {t("accounting.import.previewNote", { count: previewRows.length })}
      </p>
      <div className="overflow-x-auto rounded-lg border">
        <Table>
          <TableHeader>
            <TableRow>
              {shownHeaders.map((h) => (
                <TableHead
                  key={h}
                  className={cn("text-xs", mappedCols.has(h) && "bg-teal-50 text-teal-700")}
                >
                  {h}
                  {mappedCols.has(h) && (
                    <CheckCircle2 size={10} className="inline ml-1 text-teal-500" />
                  )}
                </TableHead>
              ))}
            </TableRow>
          </TableHeader>
          <TableBody>
            {previewRows.slice(0, 10).map((row, i) => (
              <TableRow key={i}>
                {shownHeaders.map((h) => (
                  <TableCell
                    key={h}
                    className={cn(
                      "text-xs max-w-[140px] truncate",
                      mappedCols.has(h) && "bg-teal-50/40",
                    )}
                  >
                    {row[h] != null ? String(row[h]) : ""}
                  </TableCell>
                ))}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}

function ConfirmStep({ result }: { result: ConfirmResponse }) {
  const { t } = useTranslation();
  const total = result.rowsAccepted + result.rowsRejected;
  const pct = total > 0 ? Math.round((result.rowsInserted / total) * 100) : 100;

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center gap-3">
        <CheckCircle2 size={36} className="text-teal-600 shrink-0" />
        <div>
          <h3 className="font-semibold">{t("accounting.import.importComplete")}</h3>
          <p className="text-sm text-muted-foreground">{t("accounting.import.importCompleteDesc")}</p>
        </div>
      </div>

      <Progress value={pct} className="h-2" />

      <div className="grid grid-cols-2 gap-3">
        <div className="rounded-lg border p-3">
          <p className="text-xs text-muted-foreground">{t("accounting.import.rowsInserted")}</p>
          <p className="text-2xl font-bold text-teal-700">{result.rowsInserted}</p>
        </div>
        <div className="rounded-lg border p-3">
          <p className="text-xs text-muted-foreground">{t("accounting.import.rowsSkipped")}</p>
          <p className="text-2xl font-bold text-muted-foreground">{result.rowsSkipped}</p>
        </div>
        {result.rowsRejected > 0 && (
          <div className="rounded-lg border p-3 border-destructive/30">
            <p className="text-xs text-destructive">{t("accounting.import.rowsRejectedCount")}</p>
            <p className="text-2xl font-bold text-destructive">{result.rowsRejected}</p>
          </div>
        )}
        <div className="rounded-lg border p-3">
          <p className="text-xs text-muted-foreground">{t("accounting.import.totalGross")}</p>
          <p className="text-lg font-semibold">{result.totalGross.toFixed(2)}</p>
        </div>
      </div>

      {result.rejectedRows.length > 0 && (
        <div className="flex flex-col gap-2">
          <div className="flex items-center gap-2 text-destructive">
            <AlertCircle size={14} />
            <span className="text-sm font-medium">{t("accounting.import.rejectedRowsTitle")}</span>
          </div>
          <div className="border border-destructive/20 rounded-lg divide-y max-h-48 overflow-y-auto">
            {result.rejectedRows.map((r) => (
              <div key={r.row_index} className="px-3 py-2">
                <p className="text-xs font-medium text-destructive">{t("accounting.import.rowLabel", { n: r.row_index + 1 })}: {r.reason}</p>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

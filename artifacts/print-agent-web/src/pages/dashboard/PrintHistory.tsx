import { useState, useRef, useEffect } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { useSearch, useLocation } from "wouter";
import { FileClock, CheckCircle2, XCircle, Clock, Trash2, X, Download, Monitor } from "lucide-react";
import { apiFetch } from "@/lib/queryClient";
import { StaleDataBadge } from "@/components/StaleDataBadge";
import {
  Card,
  CardContent,
} from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { ToastAction } from "@/components/ui/toast";
import { useToast } from "@/hooks/use-toast";

type Job = {
  id: number;
  device_name: string | null;
  printer_name: string;
  file_name: string;
  pages: number | null;
  copies: number | null;
  status: string;
  pre_cancel_status: string | null;
  error: string | null;
  created_at: string;
  completed_at: string | null;
};

type FilterType = "all" | "documents" | "stickers";

const STICKER_PATTERN = /^sticker-.+\.pdf$/i;
const DEFAULT_UNDO_DURATION_MS = 5000;

function getDeviceFromSearch(search: string): string | null {
  return new URLSearchParams(search).get("device") ?? null;
}

function exportJobsToCSV(jobs: Job[]) {
  const headers = ["ID", "File", "Printer", "Device", "Pages", "Copies", "Status", "Error", "Created At", "Completed At"];
  const rows = jobs.map((j) => [
    j.id,
    j.file_name,
    j.printer_name,
    j.device_name ?? "",
    j.pages ?? "",
    j.copies ?? "",
    j.status,
    j.error ?? "",
    j.created_at,
    j.completed_at ?? "",
  ]);
  const csv = [headers, ...rows]
    .map((row) => row.map((cell) => `"${String(cell).replace(/"/g, '""')}"`).join(","))
    .join("\n");
  const blob = new Blob([csv], { type: "text/csv" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `print-history-${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

function UndoProgressBar({ durationMs }: { durationMs: number }) {
  const [pct, setPct] = useState(100);
  useEffect(() => {
    const INTERVAL = 50;
    const step = (100 * INTERVAL) / durationMs;
    const id = setInterval(() => setPct((p) => Math.max(0, p - step)), INTERVAL);
    return () => clearInterval(id);
  }, [durationMs]);
  return (
    <div className="mt-1.5 h-1 w-full rounded-full bg-muted overflow-hidden">
      <div
        className="h-full bg-foreground/40 rounded-full"
        style={{ width: `${pct}%`, transition: "width 50ms linear" }}
      />
    </div>
  );
}

function isSticker(fileName: string) {
  return STICKER_PATTERN.test(fileName);
}

function isPending(status: string) {
  return status === "pending" || status === "claimed";
}

function StatusBadge({ status, preCancelStatus }: { status: string; preCancelStatus?: string | null }) {
  if (status === "done" || status === "completed") {
    return (
      <Badge variant="outline" className="gap-1 text-green-700 border-green-200 bg-green-50">
        <CheckCircle2 size={12} /> Completed
      </Badge>
    );
  }
  if (status === "failed") {
    return (
      <Badge variant="outline" className="gap-1 text-destructive border-destructive/30 bg-destructive/5">
        <XCircle size={12} /> Failed
      </Badge>
    );
  }
  if (status === "cancelled") {
    const wasInProgress = preCancelStatus === "claimed";
    return (
      <Badge variant="outline" className="gap-1 text-orange-700 border-orange-200 bg-orange-50" title={wasInProgress ? "Was in progress when cancelled" : "Was waiting when cancelled"}>
        <XCircle size={12} /> {wasInProgress ? "Cancelled (in progress)" : "Cancelled"}
      </Badge>
    );
  }
  return (
    <Badge variant="outline" className="gap-1 text-muted-foreground">
      <Clock size={12} /> {status === "claimed" ? "In Progress" : status}
    </Badge>
  );
}

const FILTER_KEYS: { labelKey: string; value: FilterType }[] = [
  { labelKey: "printHistory.all", value: "all" },
  { labelKey: "printHistory.documents", value: "documents" },
  { labelKey: "printHistory.stickers", value: "stickers" },
];

function getFilterFromSearch(search: string): FilterType {
  const params = new URLSearchParams(search);
  const type = params.get("type");
  if (type === "documents" || type === "stickers") return type;
  return "all";
}

function UndoCountdownAction({
  onUndo,
  durationMs,
}: {
  onUndo: () => void;
  durationMs: number;
}) {
  const [seconds, setSeconds] = useState(Math.ceil(durationMs / 1000));

  useEffect(() => {
    const id = setInterval(() => {
      setSeconds((s) => Math.max(0, s - 1));
    }, 1000);
    return () => clearInterval(id);
  }, []);

  return (
    <ToastAction
      altText="Undo deletion"
      data-testid="undo-delete"
      onClick={onUndo}
    >
      Undo ({seconds}s)
    </ToastAction>
  );
}

export default function PrintHistoryPage() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const search = useSearch();
  const [location, navigate] = useLocation();
  const filter = getFilterFromSearch(search);
  const deviceFilter = getDeviceFromSearch(search);
  const { toast } = useToast();
  const [confirmJob, setConfirmJob] = useState<Job | null>(null);
  const undoTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  function setFilter(value: FilterType) {
    if (value === "all") {
      navigate(location.split("?")[0], { replace: true });
    } else {
      navigate(`${location.split("?")[0]}?type=${value}`, { replace: true });
    }
  }

  const { data: settingsData } = useQuery({
    queryKey: ["workspace-settings"],
    queryFn: () => apiFetch<{ undo_duration_seconds?: number }>("/api/settings"),
  });
  const undoDurationMs = (settingsData?.undo_duration_seconds ?? 5) * 1000;

  const { data, isLoading } = useQuery({
    queryKey: ["print-jobs"],
    queryFn: () => apiFetch<{ jobs: Job[] }>("/api/print-jobs"),
  });

  const softDeleteMutation = useMutation({
    mutationFn: (jobId: number) =>
      apiFetch(`/api/print-jobs/${jobId}`, { method: "DELETE" }),
    onSuccess: (_data, jobId) => {
      queryClient.invalidateQueries({ queryKey: ["print-jobs"] });
      setConfirmJob(null);
      scheduleUndo(jobId);
    },
  });

  const restoreMutation = useMutation({
    mutationFn: (jobId: number) =>
      apiFetch(`/api/print-jobs/${jobId}/restore`, { method: "POST" }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["print-jobs"] });
    },
  });

  const permanentDeleteMutation = useMutation({
    mutationFn: (jobId: number) =>
      apiFetch(`/api/print-jobs/${jobId}/permanent`, { method: "DELETE" }),
  });

  function scheduleUndo(jobId: number) {
    if (undoTimerRef.current) {
      clearTimeout(undoTimerRef.current);
    }

    const { dismiss } = toast({
      title: "Print job deleted",
      description: (
        <div>
          <span>The job has been removed from your history.</span>
          <UndoProgressBar durationMs={undoDurationMs} />
        </div>
      ) as unknown as string,
      duration: undoDurationMs,
      action: (
        <UndoCountdownAction
          durationMs={undoDurationMs}
          onUndo={() => {
            if (undoTimerRef.current) {
              clearTimeout(undoTimerRef.current);
              undoTimerRef.current = null;
            }
            restoreMutation.mutate(jobId);
            dismiss();
          }}
        />
      ),
    });

    undoTimerRef.current = setTimeout(() => {
      undoTimerRef.current = null;
      permanentDeleteMutation.mutate(jobId);
    }, undoDurationMs);
  }

  const jobs = data?.jobs ?? [];

  const counts: Record<FilterType, number> = {
    all: jobs.length,
    stickers: jobs.filter((j) => isSticker(j.file_name)).length,
    documents: jobs.filter((j) => !isSticker(j.file_name)).length,
  };

  const filteredJobs = jobs.filter((j) => {
    if (filter === "stickers" && !isSticker(j.file_name)) return false;
    if (filter === "documents" && isSticker(j.file_name)) return false;
    if (deviceFilter && j.device_name !== deviceFilter) return false;
    return true;
  });

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">{t("printHistory.title")}</h1>
          <p className="text-muted-foreground mt-2">
            {t("printHistory.description")}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <StaleDataBadge
            queries={[{ queryKey: ["print-jobs"], url: "/api/print-jobs" }]}
            data-testid="print-history-stale-badge"
          />
          <Button
            variant="outline"
            size="sm"
            className="gap-1.5"
            disabled={isLoading || filteredJobs.length === 0}
            onClick={() => exportJobsToCSV(filteredJobs)}
            data-testid="export-csv-button"
          >
            <Download size={14} />
            Export CSV
          </Button>
        </div>
      </div>

      {deviceFilter && (
        <div className="flex items-center gap-2">
          <div className="inline-flex items-center gap-1.5 text-sm bg-secondary px-3 py-1 rounded-full" data-testid="device-filter-chip">
            <Monitor size={13} />
            <span>Device: <strong>{deviceFilter}</strong></span>
            <button
              onClick={() => {
                const base = location.split("?")[0];
                const params = new URLSearchParams(search);
                params.delete("device");
                const qs = params.toString();
                navigate(qs ? `${base}?${qs}` : base, { replace: true });
              }}
              className="ml-1 hover:text-destructive"
              data-testid="clear-device-filter"
            >
              <X size={12} />
            </button>
          </div>
        </div>
      )}

      <div
        className="inline-flex rounded-lg border bg-muted p-1 gap-1"
        role="tablist"
        aria-label="Filter by job type"
        data-testid="job-type-filter"
      >
        {FILTER_KEYS.map((opt) => (
          <button
            key={opt.value}
            role="tab"
            aria-selected={filter === opt.value}
            data-testid={`filter-${opt.value}`}
            onClick={() => setFilter(opt.value)}
            className={`px-4 py-1.5 rounded-md text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${
              filter === opt.value
                ? "bg-background text-foreground shadow-sm"
                : "text-muted-foreground hover:text-foreground"
            }`}
          >
            {t(opt.labelKey)}{!isLoading && ` (${counts[opt.value]})`}
          </button>
        ))}
      </div>

      {!isLoading && (
        <p className="text-sm text-muted-foreground" data-testid="results-summary">
          {filter === "all"
            ? `Showing all ${counts.all} job${counts.all !== 1 ? "s" : ""}`
            : `Showing ${filteredJobs.length} ${filter}`}
        </p>
      )}

      {isLoading ? (
        <Card>
          <CardContent className="py-12 text-center text-muted-foreground">
            {t("common.loading")}
          </CardContent>
        </Card>
      ) : filteredJobs.length === 0 ? (
        <Card>
          <CardContent className="py-12 text-center space-y-3">
            <FileClock className="w-12 h-12 mx-auto text-muted-foreground" />
            <div>
              <p className="font-medium">
                {jobs.length === 0 ? t("printHistory.noJobsTitle") : t("printHistory.noJobsTitle")}
              </p>
              <p className="text-sm text-muted-foreground">
                {jobs.length === 0
                  ? t("printHistory.noJobsDesc")
                  : t("printHistory.noJobsDesc")}
              </p>
            </div>
          </CardContent>
        </Card>
      ) : (
        <Card>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t("common.file") ?? "File"}</TableHead>
                <TableHead>{t("printHistory.printer")}</TableHead>
                <TableHead>{t("printHistory.device")}</TableHead>
                <TableHead>{t("printHistory.pages")}</TableHead>
                <TableHead>{t("common.copies") ?? "Copies"}</TableHead>
                <TableHead>{t("printHistory.status")}</TableHead>
                <TableHead>{t("printHistory.date")}</TableHead>
                <TableHead className="w-24" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {filteredJobs.map((j) => (
                <TableRow key={j.id} data-testid={`job-${j.id}`}>
                  <TableCell className="font-medium max-w-xs">
                    <div className="flex items-center gap-2">
                      <span className="truncate">{j.file_name}</span>
                      {isSticker(j.file_name) && (
                        <Badge variant="outline" className="shrink-0 text-purple-700 border-purple-200 bg-purple-50">
                          {t("printHistory.stickers")}
                        </Badge>
                      )}
                    </div>
                  </TableCell>
                  <TableCell>{j.printer_name}</TableCell>
                  <TableCell className="text-muted-foreground">
                    {j.device_name ?? "—"}
                  </TableCell>
                  <TableCell>{j.pages ?? "—"}</TableCell>
                  <TableCell>{j.copies ?? "—"}</TableCell>
                  <TableCell>
                    <StatusBadge status={j.status} preCancelStatus={j.pre_cancel_status} />
                  </TableCell>
                  <TableCell className="text-muted-foreground text-sm">
                    {new Date(j.created_at).toLocaleString()}
                  </TableCell>
                  <TableCell>
                    {isPending(j.status) ? (
                      <Button
                        variant="ghost"
                        size="sm"
                        className="text-muted-foreground hover:text-destructive gap-1"
                        onClick={() => setConfirmJob(j)}
                        data-testid={`cancel-job-${j.id}`}
                      >
                        <X size={14} /> {t("common.cancel")}
                      </Button>
                    ) : (
                      <Button
                        variant="ghost"
                        size="sm"
                        className="text-muted-foreground hover:text-destructive"
                        onClick={() => setConfirmJob(j)}
                        data-testid={`delete-job-${j.id}`}
                      >
                        <Trash2 size={14} />
                      </Button>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Card>
      )}

      <AlertDialog open={!!confirmJob} onOpenChange={(open) => { if (!open) setConfirmJob(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {confirmJob && isPending(confirmJob.status) ? "Cancel print job?" : "Delete print job?"}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {confirmJob && isPending(confirmJob.status)
                ? `This will stop "${confirmJob?.file_name}" from printing. It will remain in your history as cancelled.`
                : `This will remove "${confirmJob?.file_name}" from your print history. You'll have a few seconds to undo.`}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={() => confirmJob && softDeleteMutation.mutate(confirmJob.id)}
              disabled={softDeleteMutation.isPending}
              data-testid="confirm-delete"
            >
              {confirmJob && isPending(confirmJob.status) ? "Cancel job" : "Delete"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

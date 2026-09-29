import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Download, FileText, Table2, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useToast } from "@/hooks/use-toast";
import {
  exportAnalyticsCsv,
  exportAnalyticsPdf,
  type ExportDataset,
} from "@/lib/analytics-export";

type Props = {
  /** Base filename without extension, e.g. "store-analytics". */
  filename: string;
  /** Report title printed inside the exported files (English is fine). */
  title: string;
  /** Active-filter summary line printed inside the exported files. */
  filterSummary?: string;
  /** Called lazily on click; return the datasets to export. */
  getDatasets: () => ExportDataset[];
  /** Disable while page data is loading / absent. */
  disabled?: boolean;
};

export function AnalyticsExportMenu({
  filename,
  title,
  filterSummary = "",
  getDatasets,
  disabled = false,
}: Props) {
  const { t } = useTranslation();
  const { toast } = useToast();
  const [busy, setBusy] = useState(false);

  const handleExport = async (kind: "csv" | "pdf") => {
    setBusy(true);
    try {
      const datasets = getDatasets().filter((d) => d.rows.length > 0);
      if (datasets.length === 0) {
        toast({ title: t("export.nothingToExport"), variant: "destructive" });
        return;
      }
      if (kind === "csv") {
        exportAnalyticsCsv(filename, title, filterSummary, datasets);
      } else {
        await exportAnalyticsPdf(filename, title, filterSummary, datasets);
      }
    } catch {
      toast({ title: t("export.failed"), variant: "destructive" });
    } finally {
      setBusy(false);
    }
  };

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          disabled={disabled || busy}
          data-testid="analytics-export-button"
        >
          {busy ? (
            <Loader2 size={16} className="me-2 animate-spin" />
          ) : (
            <Download size={16} className="me-2" />
          )}
          {t("export.button")}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem
          onClick={() => void handleExport("csv")}
          data-testid="analytics-export-csv"
        >
          <Table2 size={16} className="me-2" />
          {t("export.csv")}
        </DropdownMenuItem>
        <DropdownMenuItem
          onClick={() => void handleExport("pdf")}
          data-testid="analytics-export-pdf"
        >
          <FileText size={16} className="me-2" />
          {t("export.pdf")}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

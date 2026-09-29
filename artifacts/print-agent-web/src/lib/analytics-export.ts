export type ExportValue = string | number | boolean | null | undefined;

export type ExportDataset = {
  /** Section heading (English is fine for exported content). */
  title: string;
  rows: Array<Record<string, ExportValue>>;
};

function formatValue(v: ExportValue): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "number") {
    return Number.isInteger(v) ? String(v) : String(Math.round(v * 100) / 100);
  }
  return String(v);
}

function csvEscape(v: string): string {
  if (/[",\n\r]/.test(v)) {
    return `"${v.replace(/"/g, '""')}"`;
  }
  return v;
}

function datasetColumns(rows: Array<Record<string, ExportValue>>): string[] {
  const cols: string[] = [];
  for (const row of rows) {
    for (const key of Object.keys(row)) {
      if (!cols.includes(key)) cols.push(key);
    }
  }
  return cols;
}

function triggerDownload(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

export function buildFilterSummary(params: Record<string, unknown> | undefined): string {
  if (!params) return "";
  return Object.entries(params)
    .filter(([, v]) => v !== undefined && v !== null && v !== "" && !(Array.isArray(v) && v.length === 0))
    .map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(", ") : String(v)}`)
    .join(" | ");
}

function humanize(key: string): string {
  return key
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .replace(/^./, (c) => c.toUpperCase());
}

function isScalar(v: unknown): v is ExportValue {
  return (
    v === null ||
    v === undefined ||
    typeof v === "string" ||
    typeof v === "number" ||
    typeof v === "boolean"
  );
}

/**
 * Generic mapper: turns an analytics API response object into export datasets.
 * - Top-level scalar fields and nested plain objects of scalars become a
 *   "Summary" key/value dataset (nested keys flattened as "parent — child").
 * - Top-level arrays of objects become one dataset each (scalar columns only,
 *   humanized headers).
 */
export function datasetsFromResponse(
  input: object | undefined | null,
  summaryTitle = "Summary",
): ExportDataset[] {
  if (!input) return [];
  const data = input as Record<string, unknown>;
  const summaryRows: Array<Record<string, ExportValue>> = [];
  const tableDatasets: ExportDataset[] = [];

  const pushSummary = (metric: string, value: ExportValue) => {
    summaryRows.push({ Metric: metric, Value: value });
  };

  for (const [key, value] of Object.entries(data)) {
    if (isScalar(value)) {
      pushSummary(humanize(key), value);
    } else if (Array.isArray(value)) {
      const objectRows = value.filter(
        (r): r is Record<string, unknown> =>
          typeof r === "object" && r !== null && !Array.isArray(r),
      );
      if (objectRows.length === 0) continue;
      const rows = objectRows.map((r) => {
        const out: Record<string, ExportValue> = {};
        for (const [ck, cv] of Object.entries(r)) {
          if (isScalar(cv)) out[humanize(ck)] = cv;
        }
        return out;
      });
      tableDatasets.push({ title: humanize(key), rows });
    } else if (typeof value === "object" && value !== null) {
      for (const [sk, sv] of Object.entries(value as Record<string, unknown>)) {
        if (isScalar(sv)) {
          pushSummary(`${humanize(key)} — ${humanize(sk)}`, sv);
        }
      }
    }
  }

  const datasets: ExportDataset[] = [];
  if (summaryRows.length > 0) datasets.push({ title: summaryTitle, rows: summaryRows });
  datasets.push(...tableDatasets);
  return datasets;
}

export function exportAnalyticsCsv(
  filename: string,
  title: string,
  filterSummary: string,
  datasets: ExportDataset[],
): void {
  const lines: string[] = [];
  lines.push(csvEscape(title));
  lines.push(csvEscape(`Exported: ${new Date().toISOString()}`));
  if (filterSummary) lines.push(csvEscape(`Filters: ${filterSummary}`));
  for (const ds of datasets) {
    if (ds.rows.length === 0) continue;
    lines.push("");
    lines.push(csvEscape(ds.title));
    const cols = datasetColumns(ds.rows);
    lines.push(cols.map(csvEscape).join(","));
    for (const row of ds.rows) {
      lines.push(cols.map((c) => csvEscape(formatValue(row[c]))).join(","));
    }
  }
  const blob = new Blob(["\uFEFF" + lines.join("\r\n")], {
    type: "text/csv;charset=utf-8",
  });
  triggerDownload(blob, filename.endsWith(".csv") ? filename : `${filename}.csv`);
}

export async function exportAnalyticsPdf(
  filename: string,
  title: string,
  filterSummary: string,
  datasets: ExportDataset[],
): Promise<void> {
  const [{ jsPDF }, autoTableModule] = await Promise.all([
    import("jspdf"),
    import("jspdf-autotable"),
  ]);
  const autoTable = autoTableModule.default;
  const doc = new jsPDF({ orientation: "portrait", unit: "pt", format: "a4" });

  const marginX = 40;
  let y = 48;

  doc.setFontSize(16);
  doc.setFont("helvetica", "bold");
  doc.text(title, marginX, y);
  y += 18;

  doc.setFontSize(9);
  doc.setFont("helvetica", "normal");
  doc.setTextColor(110);
  doc.text(`Exported: ${new Date().toLocaleString("en-US")}`, marginX, y);
  y += 12;
  if (filterSummary) {
    const wrapped = doc.splitTextToSize(`Filters: ${filterSummary}`, 515);
    doc.text(wrapped, marginX, y);
    y += wrapped.length * 11;
  }
  doc.setTextColor(0);
  y += 8;

  for (const ds of datasets) {
    if (ds.rows.length === 0) continue;
    const cols = datasetColumns(ds.rows);
    const body = ds.rows.map((row) => cols.map((c) => formatValue(row[c])));

    if (y > 740) {
      doc.addPage();
      y = 48;
    }
    doc.setFontSize(12);
    doc.setFont("helvetica", "bold");
    doc.text(ds.title, marginX, y);
    y += 8;

    autoTable(doc, {
      startY: y,
      head: [cols],
      body,
      margin: { left: marginX, right: marginX },
      styles: { fontSize: 8, cellPadding: 3 },
      headStyles: { fillColor: [6, 78, 90] },
      theme: "striped",
    });
    y = (doc as unknown as { lastAutoTable: { finalY: number } }).lastAutoTable.finalY + 24;
  }

  doc.save(filename.endsWith(".pdf") ? filename : `${filename}.pdf`);
}

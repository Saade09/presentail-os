import PDFDocument from "pdfkit";
import type { MonthlySalesResult, MonthlySalesRow } from "./cmcMonthlySales";

// ── Palette ────────────────────────────────────────────────────────────────
const BRAND     = "#0A404E";
const TEAL_MID  = "#0f766e";
const TEAL_BG   = "#f0fdfa";
const TEAL_BDR  = "#5eead4";
const TEXT_DARK = "#111827";
const TEXT_GRAY = "#6b7280";
const TEXT_DIM  = "#9ca3af";
const BG_LIGHT  = "#f9fafb";
const BDR_GRAY  = "#e5e7eb";
const GREEN_TXT = "#166534";
const GREEN_BG  = "#f0fdf4";
const GREEN_BDR = "#86efac";
const AMBER_TXT = "#92400e";
const AMBER_BG  = "#fffbeb";
const AMBER_BDR = "#fcd34d";
const RED_TXT   = "#991b1b";
const RED_BG    = "#fef2f2";
const RED_BDR   = "#fca5a5";

// ── Helpers ────────────────────────────────────────────────────────────────

function fmtMoney(n: number): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(n);
}

function fmtDate(d: string | null | undefined): string {
  if (!d) return "—";
  const p = d.split("-");
  if (p.length !== 3) return d;
  return new Date(+p[0], +p[1] - 1, +p[2]).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

function fmtDateShort(d: string): string {
  const p = d.split("-");
  return new Date(+p[0], +p[1] - 1, +p[2]).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
  });
}

function fmtMonth(ym: string): string {
  const [y, m] = ym.split("-");
  return new Date(+y, +m - 1, 1).toLocaleDateString("en-US", {
    month: "long",
    year: "numeric",
  });
}

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

function currentMonthLabel(): string {
  const n = new Date();
  return `${n.getFullYear()}-${String(n.getMonth() + 1).padStart(2, "0")}`;
}

function daysUntilDue(dueDate: string): number {
  const t = new Date(todayIso() + "T00:00:00").getTime();
  const d = new Date(dueDate + "T00:00:00").getTime();
  return Math.round((d - t) / 86_400_000);
}

type DS = "paid" | "due_soon" | "overdue" | "draft";

function getDS(row: MonthlySalesRow): DS {
  const today = todayIso();
  const curr  = currentMonthLabel();
  if (row.status === "paid") return "paid";
  if (row.month >= curr)     return "draft";
  if (row.dueDate && row.dueDate < today) return "overdue";
  return "due_soon";
}

function dsLabel(ds: DS): string {
  return { paid: "Paid", due_soon: "Due soon", overdue: "Overdue", draft: "Draft" }[ds];
}

function dsColor(ds: DS): string {
  return {
    paid:     GREEN_TXT,
    due_soon: AMBER_TXT,
    overdue:  RED_TXT,
    draft:    TEXT_GRAY,
  }[ds];
}

// ── Shared header bar ──────────────────────────────────────────────────────
// Returns new y (below header + gap).
function drawPageHeader(
  doc: InstanceType<typeof PDFDocument>,
  pageW: number,
  marginX: number,
  docTypeLabel: string,
): number {
  const H = 52;
  doc.rect(0, 0, pageW, H).fill(BRAND);

  // Logo box
  const lx = marginX, ly = 14, ls = 24;
  doc.save().fillOpacity(0.18).rect(lx, ly, ls, ls).fill("#ffffff").restore();
  doc.fillColor("#ffffff").fontSize(14).font("Helvetica-Bold")
    .text("P", lx, ly + 4, { width: ls, align: "center", lineBreak: false });

  // Brand name
  doc.fillColor("#ffffff").fontSize(13).font("Helvetica-Bold")
    .text("Presentail OS", lx + ls + 8, ly + 5, { lineBreak: false });

  // Doc type label – right-aligned in header
  doc.fillColor("#a5d6df").fontSize(8.5).font("Helvetica")
    .text(docTypeLabel, 0, ly + 8, {
      width: pageW - marginX,
      align: "right",
      lineBreak: false,
    });

  return H + 16; // top y for content
}

// ─────────────────────────────────────────────────────────────────────────────
// DELIVERABLE 1 — A4 landscape Commission Reconciliation Summary
// ─────────────────────────────────────────────────────────────────────────────
export async function generateCmcCommissionSummaryPdf(
  data: MonthlySalesResult,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({
      layout: "landscape",
      size: "A4",
      margins: { top: 40, bottom: 40, left: 40, right: 40 },
      bufferPages: true,
      info: {
        Title: "CMC Commission Statement Summary",
        Author: "Presentail OS",
        Subject: "Commission Reconciliation",
        Keywords: "CMC commission reconciliation presentail",
      },
    });

    const chunks: Buffer[] = [];
    doc.on("data", (c: Buffer) => chunks.push(c));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    const PW = doc.page.width;   // 841.89 landscape
    const PH = doc.page.height;  // 595.28 landscape
    const MX = 40;
    const CW = PW - MX * 2;     // 761.89
    const FOOTER_RESERVE = 36;

    const now    = new Date();
    const today  = todayIso();
    const todayLong  = now.toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" });
    const todayShort = now.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
    const currMonthName = now.toLocaleDateString("en-US", { month: "long" });

    let y = drawPageHeader(doc, PW, MX, "COMMISSION RECONCILIATION");

    // ── Title + Prepared-for metadata ────────────────────────────────────────
    doc.fillColor(TEXT_DARK).fontSize(18).font("Helvetica-Bold")
      .text("CMC Commission Statement Summary", MX, y, { lineBreak: false });

    // Right metadata block (two rows stacked)
    const metaX = PW - MX - 200;
    doc.fillColor(TEXT_GRAY).fontSize(8).font("Helvetica")
      .text("Prepared for", metaX, y, { lineBreak: false });
    doc.fillColor(TEXT_DARK).fontSize(8).font("Helvetica-Bold")
      .text("CMC", metaX + 82, y, { lineBreak: false });
    doc.fillColor(TEXT_GRAY).fontSize(8).font("Helvetica")
      .text("Currency", metaX, y + 12, { lineBreak: false });
    doc.fillColor(TEXT_DARK).fontSize(8).font("Helvetica-Bold")
      .text("USD", metaX + 82, y + 12, { lineBreak: false });

    y += 22;
    doc.fillColor(TEXT_GRAY).fontSize(9).font("Helvetica")
      .text(
        `Through ${todayLong}  |  Includes ${currMonthName} month-to-date`,
        MX, y, { lineBreak: false },
      );
    y += 22;

    // ── KPI boxes ─────────────────────────────────────────────────────────────
    const rows      = data.months;
    const actionable = rows
      .filter((r) => { const d = getDS(r); return d === "due_soon" || d === "overdue"; })
      .sort((a, b) => (a.dueDate ?? "").localeCompare(b.dueDate ?? ""));
    const drafts     = rows
      .filter((r) => getDS(r) === "draft")
      .sort((a, b) => (a.dueDate ?? "").localeCompare(b.dueDate ?? ""));

    const dueRow      = actionable[0] ?? null;
    const upcomingRow = drafts[0] ?? null;
    const paidTotal   = rows.filter((r) => r.status === "paid").reduce((s, r) => s + r.payable, 0);

    const KPI_GAP = 8;
    const KPI_W   = Math.floor((CW - KPI_GAP * 4) / 5);
    const KPI_H   = 58;

    type KpiDef = { label: string; value: string; sub: string; accent?: boolean };
    const kpis: KpiDef[] = [
      { label: "Gross sales",    value: fmtMoney(data.totals.gross), sub: "" },
      { label: "Net sales",      value: fmtMoney(data.totals.net),   sub: "Excluding sales VAT" },
      { label: "Paid to CMC",    value: fmtMoney(paidTotal),         sub: `As of ${todayShort}` },
      {
        label: dueRow ? `Due ${fmtDateShort(dueRow.dueDate)}` : "Currently due",
        value: dueRow ? fmtMoney(dueRow.payable) : "—",
        sub: dueRow
          ? (() => {
              const d = daysUntilDue(dueRow.dueDate);
              return d >= 0
                ? `${d} day${d !== 1 ? "s" : ""} remaining`
                : `${Math.abs(d)} day${Math.abs(d) !== 1 ? "s" : ""} overdue`;
            })()
          : "Nothing due",
        accent: !!dueRow,
      },
      {
        label: "Upcoming",
        value: upcomingRow ? fmtMoney(upcomingRow.payable) : "—",
        sub: upcomingRow
          ? `Draft - due ${fmtDateShort(upcomingRow.dueDate)}`
          : "",
      },
    ];

    let kx = MX;
    for (const kpi of kpis) {
      const ac = !!kpi.accent;
      const bgCol  = ac ? TEAL_BG  : "#ffffff";
      const bdrCol = ac ? TEAL_BDR : BDR_GRAY;
      doc.rect(kx, y, KPI_W, KPI_H).fillAndStroke(bgCol, bdrCol);

      doc.fillColor(ac ? TEAL_MID : TEXT_GRAY)
        .fontSize(7.5).font("Helvetica")
        .text(kpi.label, kx + 8, y + 8, { width: KPI_W - 16, lineBreak: false });

      doc.fillColor(ac ? TEAL_MID : TEXT_DARK)
        .fontSize(15).font("Helvetica-Bold")
        .text(kpi.value, kx + 8, y + 20, { width: KPI_W - 16, lineBreak: false });

      if (kpi.sub) {
        doc.fillColor(ac ? TEAL_MID : TEXT_DIM)
          .fontSize(7).font("Helvetica")
          .text(kpi.sub, kx + 8, y + 42, { width: KPI_W - 16, lineBreak: false });
      }
      kx += KPI_W + KPI_GAP;
    }
    y += KPI_H + 22;

    // ── Monthly reconciliation section heading ─────────────────────────────
    doc.fillColor(TEXT_DARK).fontSize(11).font("Helvetica-Bold")
      .text("Monthly reconciliation", MX, y, { lineBreak: false });
    y += 15;
    doc.fillColor(TEXT_GRAY).fontSize(8).font("Helvetica")
      .text("Due and upcoming amounts are shown separately.", MX, y, { lineBreak: false });
    y += 18;

    // ── Table ─────────────────────────────────────────────────────────────────
    // Column widths — manually tuned to fill CW = 761.89 ≈ 762
    const COLS: Array<{ label: string; w: number; align: "left" | "right" | "center" }> = [
      { label: "Month",                  w: 130, align: "left"   },
      { label: "Gross sales",            w: 90,  align: "right"  },
      { label: "Net sales",              w: 90,  align: "right"  },
      { label: "Commission\n20%",        w: 90,  align: "right"  },
      { label: "VAT on commission\n11%", w: 90,  align: "right"  },
      { label: "Amount due\nto CMC",     w: 90,  align: "right"  },
      { label: "Due date",               w: 90,  align: "left"   },
      { label: "Status",                 w: 72,  align: "center" },
    ];
    // Distribute remaining pixels to first column
    const COLS_TOTAL = COLS.reduce((s, c) => s + c.w, 0);
    COLS[0].w += Math.floor(CW - COLS_TOTAL);

    const HDR_H   = 28;
    const ROW_H   = 20;
    const TOT_H   = 22;

    function drawTblHeader(yy: number): number {
      doc.rect(MX, yy, CW, HDR_H).fill(BRAND);
      let cx = MX + 6;
      doc.fillColor("#ffffff").fontSize(7.5).font("Helvetica-Bold");
      for (const col of COLS) {
        doc.text(col.label, cx, yy + 4, {
          width: col.w - 8,
          align: col.align,
          lineGap: 1,
          lineBreak: true,
        });
        cx += col.w;
      }
      return yy + HDR_H;
    }

    y = drawTblHeader(y);

    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      const ds  = getDS(row);

      // Overflow → new page
      if (y + ROW_H > PH - FOOTER_RESERVE - 30) {
        doc.addPage({ layout: "landscape", size: "A4", margins: { top: 40, bottom: 40, left: 40, right: 40 } });
        y = 40;
        y = drawTblHeader(y);
      }

      // Alternating row background
      if (i % 2 === 0) doc.rect(MX, y, CW, ROW_H).fill(BG_LIGHT);
      doc.strokeColor(BDR_GRAY).lineWidth(0.4)
        .moveTo(MX, y + ROW_H).lineTo(MX + CW, y + ROW_H).stroke();

      const isDraft = ds === "draft";
      let cx = MX + 6;

      // Month cell (possibly with "Month-to-date" subtitle)
      if (isDraft) {
        doc.fillColor(TEXT_DARK).fontSize(8).font("Helvetica-Bold")
          .text(fmtMonth(row.month), cx, y + 2, { width: COLS[0].w - 8, lineBreak: false });
        doc.fillColor(TEXT_GRAY).fontSize(7).font("Helvetica")
          .text("Month-to-date", cx, y + 11, { width: COLS[0].w - 8, lineBreak: false });
      } else {
        doc.fillColor(TEXT_DARK).fontSize(8).font("Helvetica-Bold")
          .text(fmtMonth(row.month), cx, y + 6, { width: COLS[0].w - 8, lineBreak: false });
      }
      cx += COLS[0].w;

      // Numeric columns
      const nums = [
        fmtMoney(row.gross),
        fmtMoney(row.net),
        fmtMoney(row.commission),
        fmtMoney(row.commissionVat),
        fmtMoney(row.payable),
      ];
      for (let c = 0; c < 5; c++) {
        const isAmt = c === 4;
        doc.fillColor(isAmt ? TEAL_MID : TEXT_DARK)
          .fontSize(8)
          .font(isAmt ? "Helvetica-Bold" : "Helvetica")
          .text(nums[c], cx, y + 6, {
            width: COLS[c + 1].w - 8,
            align: "right",
            lineBreak: false,
          });
        cx += COLS[c + 1].w;
      }

      // Due date
      doc.fillColor(TEXT_GRAY).fontSize(8).font("Helvetica")
        .text(fmtDate(row.dueDate), cx, y + 6, { width: COLS[6].w - 8, lineBreak: false });
      cx += COLS[6].w;

      // Status
      doc.fillColor(dsColor(ds)).fontSize(8).font("Helvetica-Bold")
        .text(dsLabel(ds), cx, y + 6, { width: COLS[7].w - 8, align: "center", lineBreak: false });

      y += ROW_H;
    }

    // Totals row
    if (y + TOT_H > PH - FOOTER_RESERVE - 30) {
      doc.addPage({ layout: "landscape", size: "A4", margins: { top: 40, bottom: 40, left: 40, right: 40 } });
      y = 40;
      y = drawTblHeader(y);
    }

    doc.rect(MX, y, CW, TOT_H).fill("#f0fdf4");
    doc.strokeColor(BDR_GRAY).lineWidth(0.4)
      .moveTo(MX, y + TOT_H).lineTo(MX + CW, y + TOT_H).stroke();

    let cx = MX + 6;
    doc.fillColor(TEXT_DARK).fontSize(8).font("Helvetica-Bold")
      .text("TOTAL", cx, y + 7, { width: COLS[0].w - 8, lineBreak: false });
    cx += COLS[0].w;

    const totNums = [
      fmtMoney(data.totals.gross),
      fmtMoney(data.totals.net),
      fmtMoney(data.totals.commission),
      fmtMoney(data.totals.commissionVat),
      fmtMoney(data.totals.payable),
    ];
    for (let c = 0; c < 5; c++) {
      doc.fillColor(c === 4 ? TEAL_MID : TEXT_DARK).fontSize(8).font("Helvetica-Bold")
        .text(totNums[c], cx, y + 7, { width: COLS[c + 1].w - 8, align: "right", lineBreak: false });
      cx += COLS[c + 1].w;
    }
    cx += COLS[6].w; // skip due date
    doc.fillColor(TEXT_GRAY).fontSize(8).font("Helvetica-Bold")
      .text("Scheduled", cx, y + 7, { width: COLS[7].w - 8, align: "center", lineBreak: false });
    y += TOT_H + 18;

    // ── Formula explanation ────────────────────────────────────────────────
    const FORMULA_H = 32;
    if (y + FORMULA_H > PH - FOOTER_RESERVE - 10) {
      doc.addPage({ layout: "landscape", size: "A4", margins: { top: 40, bottom: 40, left: 40, right: 40 } });
      y = 40;
    }
    doc.rect(MX, y, CW, FORMULA_H).fill(BG_LIGHT);
    doc.fillColor(TEXT_DARK).fontSize(8).font("Helvetica-Bold")
      .text("How the amount due is calculated", MX + 8, y + 6, { lineBreak: false });
    doc.fillColor(TEXT_GRAY).fontSize(8).font("Helvetica")
      .text(
        "Gross sales − sales VAT = Net sales  |  Net sales × 20% = Commission  |  Commission + 11% VAT = Amount due to CMC",
        MX + 8, y + 18,
        { width: CW - 16, lineBreak: false },
      );

    // ── Footer on every page ───────────────────────────────────────────────
    const totalPages = doc.bufferedPageRange().count;
    for (let i = 0; i < totalPages; i++) {
      doc.switchToPage(i);
      const FY = PH - 30;
      doc.strokeColor(BDR_GRAY).lineWidth(0.4)
        .moveTo(MX, FY - 2).lineTo(PW - MX, FY - 2).stroke();
      doc.fillColor(TEXT_DIM).fontSize(7.5).font("Helvetica")
        .text("Presentail OS", MX, FY, { lineBreak: false });
      doc.fillColor(TEXT_DIM).fontSize(7.5).font("Helvetica")
        .text(`Generated ${todayLong}  |  All figures in USD`, 0, FY, {
          width: PW,
          align: "center",
          lineBreak: false,
        });
      doc.fillColor(TEXT_DIM).fontSize(7.5).font("Helvetica")
        .text(`Page ${i + 1} of ${totalPages}`, MX, FY, {
          width: CW,
          align: "right",
          lineBreak: false,
        });
    }

    doc.end();
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// DELIVERABLE 2 — A4 portrait Monthly Commission Statement
// ─────────────────────────────────────────────────────────────────────────────
export async function generateCmcCommissionStatementPdf(
  month: string,
  data: MonthlySalesResult,
): Promise<Buffer> {
  // Fallback: empty statement
  const row = data.months[0];
  if (!row) {
    return new Promise((resolve, reject) => {
      const d = new PDFDocument({ size: "A4", bufferPages: true });
      const ch: Buffer[] = [];
      d.on("data", (c: Buffer) => ch.push(c));
      d.on("end", () => resolve(Buffer.concat(ch)));
      d.on("error", reject);
      d.text("No data for this period.").end();
    });
  }

  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({
      layout: "portrait",
      size: "A4",
      margins: { top: 40, bottom: 40, left: 50, right: 50 },
      bufferPages: true,
      info: {
        Title: `CMC Commission Statement ${fmtMonth(month)}`,
        Author: "Presentail OS",
        Subject: "Commission Statement",
        Keywords: `CMC commission statement ${month}`,
      },
    });

    const chunks: Buffer[] = [];
    doc.on("data", (c: Buffer) => chunks.push(c));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    const PW = doc.page.width;   // 595.28
    const PH = doc.page.height;  // 841.89
    const MX = 50;
    const CW = PW - MX * 2;

    const now = new Date();
    const todayLong = now.toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" });
    const ds = getDS(row);

    let y = drawPageHeader(doc, PW, MX, "COMMISSION STATEMENT");

    // ── Status badge (top right, same vertical level as title) ────────────
    const badgeW = 88, badgeH = 20;
    const badgeX = PW - MX - badgeW;
    const badgeY = y + 2;
    const [badgeBg, badgeBdr, badgeClr] = (() => {
      if (ds === "paid")     return [GREEN_BG,  GREEN_BDR,  GREEN_TXT];
      if (ds === "overdue")  return [RED_BG,    RED_BDR,    RED_TXT];
      if (ds === "draft")    return ["#f3f4f6", BDR_GRAY,   TEXT_GRAY];
      return [AMBER_BG, AMBER_BDR, AMBER_TXT]; // due_soon
    })();
    doc.rect(badgeX, badgeY, badgeW, badgeH).fillAndStroke(badgeBg, badgeBdr);
    doc.fillColor(badgeClr).fontSize(8).font("Helvetica-Bold")
      .text(dsLabel(ds).toUpperCase(), badgeX, badgeY + 5.5, {
        width: badgeW,
        align: "center",
        lineBreak: false,
      });

    // ── Title + subtitle ──────────────────────────────────────────────────
    doc.fillColor(TEXT_DARK).fontSize(20).font("Helvetica-Bold")
      .text("CMC Commission Statement", MX, y, { lineBreak: false });
    y += 26;
    doc.fillColor(TEXT_GRAY).fontSize(12).font("Helvetica")
      .text(fmtMonth(month), MX, y, { lineBreak: false });
    y += 28;

    // ── Amount due panel ──────────────────────────────────────────────────
    const PANEL_H = 76;
    const [panelBg, panelBdr, amtClr] = (() => {
      if (ds === "paid")    return [GREEN_BG,  GREEN_BDR,  GREEN_TXT];
      if (ds === "overdue") return [RED_BG,    RED_BDR,    RED_TXT];
      if (ds === "draft")   return [BG_LIGHT,  BDR_GRAY,   TEXT_GRAY];
      return [TEAL_BG, TEAL_BDR, TEAL_MID]; // due_soon
    })();
    doc.rect(MX, y, CW, PANEL_H).fillAndStroke(panelBg, panelBdr);

    doc.fillColor(TEXT_GRAY).fontSize(7.5).font("Helvetica")
      .text("AMOUNT DUE TO CMC", MX + 16, y + 10, { lineBreak: false });
    doc.fillColor(amtClr).fontSize(26).font("Helvetica-Bold")
      .text(fmtMoney(row.payable), MX + 16, y + 22, { lineBreak: false });

    // Right side: due date / paid date
    if (ds !== "paid") {
      const rX = PW - MX - 200;
      doc.fillColor(TEXT_GRAY).fontSize(7.5).font("Helvetica")
        .text("Due date", rX, y + 14, { lineBreak: false });
      doc.fillColor(TEXT_DARK).fontSize(10).font("Helvetica-Bold")
        .text(fmtDate(row.dueDate), rX, y + 26, { lineBreak: false });
      if (row.dueDate) {
        const d = daysUntilDue(row.dueDate);
        doc.fillColor(TEXT_GRAY).fontSize(7.5).font("Helvetica")
          .text(
            d >= 0
              ? `${d} day${d !== 1 ? "s" : ""} remaining at generation`
              : `${Math.abs(d)} day${Math.abs(d) !== 1 ? "s" : ""} overdue`,
            rX, y + 44,
            { lineBreak: false },
          );
      }
    } else if (row.paidAt) {
      const rX = PW - MX - 200;
      doc.fillColor(TEXT_GRAY).fontSize(7.5).font("Helvetica")
        .text("Paid on", rX, y + 14, { lineBreak: false });
      doc.fillColor(GREEN_TXT).fontSize(10).font("Helvetica-Bold")
        .text(
          new Date(row.paidAt).toLocaleDateString("en-US", {
            month: "short", day: "numeric", year: "numeric",
          }),
          rX, y + 26,
          { lineBreak: false },
        );
    }

    y += PANEL_H + 20;

    // ── Statement metadata row ─────────────────────────────────────────────
    const META_H = 38;
    const metaItems = [
      { label: "Statement number", value: `ST-CMC-${month}` },
      { label: "Issue date",       value: todayLong },
      { label: "Prepared for",     value: "CMC" },
      { label: "Currency",         value: "USD" },
    ];
    const metaColW = CW / 4;
    doc.rect(MX, y, CW, META_H).fill(BG_LIGHT);
    for (let i = 0; i < metaItems.length; i++) {
      const mx = MX + i * metaColW + 8;
      doc.fillColor(TEXT_GRAY).fontSize(7.5).font("Helvetica")
        .text(metaItems[i].label, mx, y + 7, { width: metaColW - 8, lineBreak: false });
      doc.fillColor(TEXT_DARK).fontSize(9).font("Helvetica-Bold")
        .text(metaItems[i].value, mx, y + 20, { width: metaColW - 8, lineBreak: false });
    }
    y += META_H + 22;

    // ── Statement calculation ─────────────────────────────────────────────
    doc.fillColor(TEXT_DARK).fontSize(11).font("Helvetica-Bold")
      .text("Statement calculation", MX, y, { lineBreak: false });
    y += 14;
    doc.fillColor(TEXT_GRAY).fontSize(8.5).font("Helvetica")
      .text("Sales VAT is removed before applying the 20% commission.", MX, y, { lineBreak: false });
    y += 22;

    const salesVat = row.gross - row.net;
    type CalcLine = {
      label: string;
      value: string;
      bold?: boolean;
      topDivider?: boolean;
      valueColor?: string;
    };
    const calcLines: CalcLine[] = [
      { label: "Gross sales (VAT inclusive)",  value: fmtMoney(row.gross) },
      { label: "Less: sales VAT",              value: `(${fmtMoney(salesVat)})` },
      { label: "Net sales",                    value: fmtMoney(row.net),            bold: true, topDivider: true },
      { label: "Commission — 20% of net sales", value: fmtMoney(row.commission) },
      { label: "VAT on commission — 11%",       value: fmtMoney(row.commissionVat) },
      {
        label:      "Amount due to CMC",
        value:      fmtMoney(row.payable),
        bold:       true,
        topDivider: true,
        valueColor: TEAL_MID,
      },
    ];

    const CALC_LINE_H = 22;
    for (const line of calcLines) {
      if (line.topDivider) {
        doc.strokeColor(BDR_GRAY).lineWidth(0.4)
          .moveTo(MX, y).lineTo(MX + CW, y).stroke();
        y += 6;
      }
      const font = line.bold ? "Helvetica-Bold" : "Helvetica";
      doc.fillColor(TEXT_DARK).fontSize(9).font(font)
        .text(line.label, MX + 10, y + 4, { lineBreak: false });
      doc.fillColor(line.valueColor ?? TEXT_DARK).fontSize(9).font(font)
        .text(line.value, MX, y + 4, { width: CW - 10, align: "right", lineBreak: false });
      y += CALC_LINE_H;
    }

    y += 14;

    // ── Payment status box ────────────────────────────────────────────────
    const PBOX_H = 42;
    doc.rect(MX, y, CW, PBOX_H).fill(BG_LIGHT);
    doc.fillColor(TEXT_GRAY).fontSize(7.5).font("Helvetica")
      .text("Payment status", MX + 10, y + 8, { lineBreak: false });
    const pmMsg = ds === "paid"
      ? (row.paidAt
          ? `Payment recorded on ${new Date(row.paidAt).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}.`
          : "Payment has been recorded.")
      : "Payment has not yet been recorded. Record the payment in Presentail OS once settled.";
    doc.fillColor(ds === "paid" ? GREEN_TXT : TEXT_DARK).fontSize(8.5).font("Helvetica")
      .text(pmMsg, MX + 10, y + 22, { width: CW - 20, lineBreak: false });
    y += PBOX_H + 18;

    // ── Calculation method note ───────────────────────────────────────────
    doc.fillColor(TEXT_DARK).fontSize(9).font("Helvetica-Bold")
      .text("Calculation method", MX, y, { lineBreak: false });
    y += 14;
    doc.fillColor(TEXT_GRAY).fontSize(8).font("Helvetica")
      .text(
        "Gross sales − sales VAT = Net sales\nNet sales × 20% = Commission  |  Commission + 11% VAT = Amount due to CMC",
        MX, y,
        { width: CW },
      );

    // ── Footer on every page ──────────────────────────────────────────────
    const totalPages = doc.bufferedPageRange().count;
    for (let i = 0; i < totalPages; i++) {
      doc.switchToPage(i);
      const FY = PH - 30;
      doc.strokeColor(BDR_GRAY).lineWidth(0.4)
        .moveTo(MX, FY - 2).lineTo(PW - MX, FY - 2).stroke();
      doc.fillColor(TEXT_DIM).fontSize(7.5).font("Helvetica")
        .text("Presentail OS", MX, FY, { lineBreak: false });
      doc.fillColor(TEXT_DIM).fontSize(7.5).font("Helvetica")
        .text(`Generated ${todayLong}  |  All figures in USD`, 0, FY, {
          width: PW,
          align: "center",
          lineBreak: false,
        });
      doc.fillColor(TEXT_DIM).fontSize(7.5).font("Helvetica")
        .text(`Page ${i + 1} of ${totalPages}`, MX, FY, {
          width: CW,
          align: "right",
          lineBreak: false,
        });
    }

    doc.end();
  });
}

// Keep the old export name as a thin compatibility shim so nothing breaks
// if any other code still imports it. Routes have been updated to call the
// new dedicated generators directly.
export async function generateCmcMonthlySalesPdf(
  period: string,
  data: MonthlySalesResult,
): Promise<Buffer> {
  if (period === "all-time" || !period.match(/^\d{4}-\d{2}$/)) {
    return generateCmcCommissionSummaryPdf(data);
  }
  return generateCmcCommissionStatementPdf(period, data);
}

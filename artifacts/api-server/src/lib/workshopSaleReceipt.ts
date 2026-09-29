import PDFDocument from "pdfkit";

export interface ReceiptItem {
  name: string;
  description?: string | null;
  quantity: string | number;
  unit_price: string | number;
  discount?: string | number;
  discount_type?: string | null;
  tax_rate?: string | number;
}

export interface ReceiptPayment {
  method: string;
  amount: string | number;
  currency: string;
  paid_at?: string | Date | null;
  reference?: string | null;
}

export interface WorkshopSaleReceiptData {
  orderNumber: string;
  status: string;
  currency: string;
  createdAt: string | Date | null;
  customerName?: string | null;
  customerPhone?: string | null;
  customerEmail?: string | null;
  occasion?: string | null;
  locationName?: string | null;
  brandName?: string | null;
  subtotal: string | number;
  discountTotal: string | number;
  taxTotal: string | number;
  total: string | number;
  amountPaid: string | number;
  balanceDue: string | number;
  items: ReceiptItem[];
  payments: ReceiptPayment[];
}

function n(v: string | number | null | undefined): number {
  if (typeof v === "number") return Number.isFinite(v) ? v : 0;
  if (typeof v === "string" && v.trim() !== "") {
    const x = Number(v);
    return Number.isFinite(x) ? x : 0;
  }
  return 0;
}

function money(v: string | number | null | undefined, currency: string): string {
  return `${currency} ${n(v).toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

function dateLabel(v: string | Date | null | undefined): string {
  if (!v) return "—";
  const d = typeof v === "string" ? new Date(v) : v;
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleDateString("en-US", {
    year: "numeric",
    month: "long",
    day: "numeric",
  });
}

/**
 * Build a workshop-sale receipt PDF and resolve with the rendered Buffer.
 */
export function buildWorkshopSaleReceiptPdf(
  data: WorkshopSaleReceiptData,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({ margin: 50, size: "A4" });
      const chunks: Buffer[] = [];
      doc.on("data", (c: Buffer) => chunks.push(c));
      doc.on("end", () => resolve(Buffer.concat(chunks)));
      doc.on("error", reject);

      const BRAND = "#4f46e5";
      const GRAY = "#64748b";
      const LIGHT_GRAY = "#94a3b8";
      const BLACK = "#0f172a";
      const pageWidth = doc.page.width - 100;
      const currency = data.currency || "USD";

      // Header bar
      doc.rect(50, 50, pageWidth, 4).fill(BRAND);
      doc.fontSize(22).fillColor(BLACK).font("Helvetica-Bold").text("Presentail OS", 50, 70);
      doc.fontSize(10).fillColor(GRAY).font("Helvetica").text("Workshop Sale Receipt", 50, 96);
      doc
        .fontSize(18)
        .fillColor(BLACK)
        .font("Helvetica-Bold")
        .text(data.orderNumber, 50, 70, { align: "right", width: pageWidth });

      const afterHeaderY = 120;
      doc.moveTo(50, afterHeaderY).lineTo(50 + pageWidth, afterHeaderY).strokeColor("#e2e8f0").stroke();

      const col1X = 50;
      const col2X = 50 + pageWidth / 2;
      let y = afterHeaderY + 18;

      function field(label: string, value: string, x: number, yPos: number) {
        doc.fontSize(8).fillColor(LIGHT_GRAY).font("Helvetica-Bold").text(label.toUpperCase(), x, yPos);
        doc.fontSize(11).fillColor(BLACK).font("Helvetica").text(value, x, yPos + 13, { width: pageWidth / 2 - 10 });
      }

      const statusLabel = data.status.charAt(0).toUpperCase() + data.status.slice(1);
      field("Date", dateLabel(data.createdAt), col1X, y);
      field("Status", statusLabel, col2X, y);
      y += 44;
      field("Customer", data.customerName || "Walk-in customer", col1X, y);
      field("Phone", data.customerPhone || "—", col2X, y);
      y += 44;
      if (data.customerEmail || data.occasion) {
        field("Email", data.customerEmail || "—", col1X, y);
        field("Occasion", data.occasion || "—", col2X, y);
        y += 44;
      }
      if (data.locationName || data.brandName) {
        field("Location", data.locationName || "—", col1X, y);
        field("Brand", data.brandName || "—", col2X, y);
        y += 44;
      }

      doc.moveTo(50, y).lineTo(50 + pageWidth, y).strokeColor("#e2e8f0").stroke();
      y += 14;

      // Items table
      const descW = pageWidth * 0.5;
      const qtyW = pageWidth * 0.12;
      const priceW = pageWidth * 0.18;
      const totalW = pageWidth * 0.2;
      const colDesc = 50;
      const colQty = colDesc + descW;
      const colPrice = colQty + qtyW;
      const colTotal = colPrice + priceW;

      doc.rect(50, y, pageWidth, 18).fill("#f8fafc");
      doc.fontSize(8).fillColor(GRAY).font("Helvetica-Bold");
      doc.text("Item", colDesc + 4, y + 5, { width: descW - 4 });
      doc.text("Qty", colQty, y + 5, { width: qtyW, align: "right" });
      doc.text("Unit Price", colPrice, y + 5, { width: priceW, align: "right" });
      doc.text("Line Total", colTotal, y + 5, { width: totalW, align: "right" });
      y += 22;

      if (data.items.length === 0) {
        doc.fontSize(10).fillColor(LIGHT_GRAY).font("Helvetica").text("No items.", colDesc + 4, y);
        y += 18;
      }

      for (const it of data.items) {
        const qty = n(it.quantity);
        const unit = n(it.unit_price);
        const line = qty * unit;
        const discRaw = n(it.discount);
        const discAmount = it.discount_type === "percentage" ? (line * discRaw) / 100 : discRaw;
        const taxable = Math.max(0, line - discAmount);
        const tax = (taxable * n(it.tax_rate)) / 100;
        const lineTotal = taxable + tax;

        const descText = it.description ? `${it.name}\n${it.description}` : it.name;
        const rowH = Math.max(18, doc.heightOfString(descText, { width: descW - 8 }) + 10);
        if (y + rowH > doc.page.height - 120) {
          doc.addPage();
          y = 50;
        }
        doc.fontSize(9).fillColor(BLACK).font("Helvetica");
        doc.text(descText, colDesc + 4, y + 4, { width: descW - 8 });
        doc.text(String(qty), colQty, y + 4, { width: qtyW, align: "right" });
        doc.text(money(unit, currency), colPrice, y + 4, { width: priceW, align: "right" });
        doc.text(money(lineTotal, currency), colTotal, y + 4, { width: totalW, align: "right" });
        y += rowH;
        doc.moveTo(50, y).lineTo(50 + pageWidth, y).strokeColor("#f1f5f9").stroke();
      }

      y += 14;

      // Totals box
      const totalsX = 50 + pageWidth * 0.55;
      const totalsW = pageWidth * 0.45;
      function totalRow(label: string, value: string, bold = false) {
        doc.fontSize(bold ? 11 : 9).fillColor(bold ? BLACK : GRAY).font(bold ? "Helvetica-Bold" : "Helvetica");
        doc.text(label, totalsX, y, { width: totalsW * 0.5 });
        doc.text(value, totalsX + totalsW * 0.5, y, { width: totalsW * 0.5, align: "right" });
        y += bold ? 18 : 15;
      }
      totalRow("Subtotal", money(data.subtotal, currency));
      if (n(data.discountTotal) > 0) totalRow("Discount", `- ${money(data.discountTotal, currency)}`);
      if (n(data.taxTotal) > 0) totalRow("Tax", money(data.taxTotal, currency));
      totalRow("Total", money(data.total, currency), true);
      totalRow("Amount Paid", money(data.amountPaid, currency));
      totalRow("Balance Due", money(data.balanceDue, currency), true);

      // Payments
      if (data.payments.length > 0) {
        y += 16;
        if (y > doc.page.height - 120) {
          doc.addPage();
          y = 50;
        }
        doc.fontSize(10).fillColor(GRAY).font("Helvetica-Bold").text("PAYMENTS", 50, y);
        y += 16;
        for (const p of data.payments) {
          doc.fontSize(9).fillColor(BLACK).font("Helvetica");
          const label = `${dateLabel(p.paid_at)} · ${p.method}${p.reference ? ` (${p.reference})` : ""}`;
          doc.text(label, 54, y, { width: pageWidth * 0.7 });
          doc.text(money(p.amount, p.currency || currency), 50, y, {
            width: pageWidth,
            align: "right",
          });
          y += 15;
        }
      }

      // Footer
      const footerY = doc.page.height - 60;
      doc.fontSize(8).fillColor(LIGHT_GRAY).font("Helvetica").text(
        "Thank you for your business. Generated by Presentail OS.",
        50,
        footerY,
        { align: "center", width: pageWidth },
      );

      doc.end();
    } catch (err) {
      reject(err as Error);
    }
  });
}

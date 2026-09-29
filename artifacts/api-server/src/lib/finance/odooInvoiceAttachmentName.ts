function cleanFilenamePart(value: unknown): string {
  return String(value ?? "")
    .replace(/[\u0000-\u001f\u007f<>:"/\\|?*]/g, " ")
    .replace(/\s+/g, " ")
    .replace(/^[.\s]+|[.\s]+$/g, "")
    .trim();
}

/**
 * Odoo invoice scans must not inherit OCR/source-upload filenames. Prefer the
 * approved supplier invoice reference and use Odoo's move name for legacy
 * records without one.
 */
export function buildOdooInvoiceAttachmentName(
  supplierName: unknown,
  invoiceReference: unknown,
  moveName: unknown,
): string {
  const supplier = cleanFilenamePart(supplierName) || "Supplier";
  const reference = cleanFilenamePart(invoiceReference) || cleanFilenamePart(moveName) || "Vendor bill";
  const extension = ".pdf";
  const maxStemLength = 255 - extension.length;
  const stem = `${supplier} ${reference}`.slice(0, maxStemLength).trim().replace(/[.\s]+$/g, "");
  return `${stem || "Supplier invoice"}${extension}`;
}
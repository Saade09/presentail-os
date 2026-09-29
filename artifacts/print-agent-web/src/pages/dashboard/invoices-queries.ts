import { useQuery, useQueryClient } from "@tanstack/react-query";
import { apiFetch, getClerkToken } from "@/lib/queryClient";

export type InvoiceRow = {
  id: number;
  invoice_number: string;
  created_at: string;
  customer_name: string | null;
  customer_email: string | null;
  item_description: string | null;
  amount: number | string | null;
  currency: string;
  created_by_name: string | null;
};

export type InvoiceSummary = {
  total: number;
  this_month: number;
  total_value: number | null;
  last_created_at: string | null;
};

export type InvoiceListResponse = {
  items: InvoiceRow[];
  total: number;
  total_pages: number;
  summary: InvoiceSummary;
};

export type InvoiceListParams = {
  search?: string;
  dateFrom?: string;
  dateTo?: string;
  currency?: string;
  page?: number;
  page_size?: number;
};

export function invoiceListQueryKey(params: InvoiceListParams) {
  return ["invoices", params] as const;
}

export function useInvoiceList(params: InvoiceListParams) {
  const qs = new URLSearchParams();
  if (params.search) qs.set("search", params.search);
  if (params.dateFrom) qs.set("dateFrom", params.dateFrom);
  if (params.dateTo) qs.set("dateTo", params.dateTo);
  if (params.currency) qs.set("currency", params.currency);
  if (params.page) qs.set("page", String(params.page));
  if (params.page_size) qs.set("page_size", String(params.page_size));

  return useQuery({
    queryKey: invoiceListQueryKey(params),
    queryFn: () =>
      apiFetch<InvoiceListResponse>(`/api/invoices?${qs.toString()}`),
    placeholderData: (prev) => prev,
  });
}

export function useInvalidateInvoiceList() {
  const qc = useQueryClient();
  return () => qc.invalidateQueries({ queryKey: ["invoices"] });
}

async function downloadBlob(url: string, fallbackName: string) {
  const token = await getClerkToken();
  const res = await fetch(url, {
    credentials: "include",
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const blob = await res.blob();
  const objectUrl = URL.createObjectURL(blob);
  const disposition = res.headers.get("Content-Disposition") ?? "";
  const match = disposition.match(/filename="([^"]+)"/);
  const a = document.createElement("a");
  a.href = objectUrl;
  a.download = match?.[1] ?? fallbackName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(objectUrl), 60_000);
}

export async function downloadInvoicePdf(id: number) {
  await downloadBlob(`/api/invoices/${id}/download`, `Invoice-${id}.pdf`);
}

export async function exportInvoicesCsv(params: Omit<InvoiceListParams, "page" | "page_size">) {
  const qs = new URLSearchParams();
  if (params.search) qs.set("search", params.search);
  if (params.dateFrom) qs.set("dateFrom", params.dateFrom);
  if (params.dateTo) qs.set("dateTo", params.dateTo);
  if (params.currency) qs.set("currency", params.currency);
  await downloadBlob(`/api/invoices/export-csv?${qs.toString()}`, "Invoices.csv");
}

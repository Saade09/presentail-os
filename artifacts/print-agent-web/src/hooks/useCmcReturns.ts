import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiFetch } from "@/lib/queryClient";

// ── Types ──────────────────────────────────────────────────────────────────────

export type ReturnReason =
  | "damaged"
  | "wilted"
  | "expired"
  | "incorrect_item"
  | "quality_issue";

export const RETURN_REASONS: { value: ReturnReason; label: string }[] = [
  { value: "damaged", label: "Damaged" },
  { value: "wilted", label: "Wilted" },
  { value: "expired", label: "Expired" },
  { value: "incorrect_item", label: "Incorrect item" },
  { value: "quality_issue", label: "Quality issue" },
];

export type CollectionMethod =
  | "next_delivery"
  | "asap"
  | "self_send";

export const COLLECTION_METHODS: {
  value: CollectionMethod;
  label: string;
  description: string;
}[] = [
  {
    value: "next_delivery",
    label: "Next CMC delivery",
    description: "Items will be collected on the next scheduled delivery",
  },
  {
    value: "asap",
    label: "As soon as possible",
    description: "Urgent collection will be arranged",
  },
  {
    value: "self_send",
    label: "I will send it to CMC",
    description: "You'll arrange delivery of the items yourself",
  },
];

export type ReturnStatus =
  | "draft"
  | "submitted"
  | "awaiting_pickup"
  | "picked_up"
  | "received"
  | "cancelled";

/** Shape returned by GET /api/cmc-pos/shelf-products */
export interface ShelfProduct {
  id: number;
  name: string;
  sku: string | null;
  main_image_url: string | null;
  stock_qty: number | null;
  is_cmc: boolean;
  status: string;
}

/** Internal product shape used by the returns wizard */
export interface EligibleProduct {
  id: number;
  name: string;
  sku: string | null;
  image_url: string | null;
  available_stock: number;
}

export interface ReturnLineItem {
  id: number;
  product_id: number | null;
  name_snapshot: string;
  sku_snapshot: string | null;
  image_url: string | null;
  stock_snapshot: number | null;
  quantity: number;
  reason: ReturnReason;
  is_custom: boolean;
}

export interface ReturnAuditEvent {
  id: number;
  actor_email: string | null;
  from_status: ReturnStatus | null;
  to_status: ReturnStatus;
  notes: string | null;
  created_at: string;
}

export interface CmcReturn {
  id: string | number;
  reference: string;
  status: ReturnStatus;
  notes: string | null;
  collection_method: CollectionMethod;
  collection_date: string | null;
  submitted_at: string | null;
  created_at: string;
  operator_name: string | null;
  operator_email: string | null;
  branch_name: string | null;
  return_to_name: string | null;
  photo_urls?: string[];
  line_items: ReturnLineItem[];
  events?: ReturnAuditEvent[];
}

export interface CmcReturnSummary {
  id: string | number;
  reference: string;
  status: ReturnStatus;
  collection_method: CollectionMethod;
  created_at: string;
  submitted_at: string | null;
  product_count: number;
  unit_count: number;
  operator_name: string | null;
  operator_email: string | null;
  branch_name: string | null;
}

export interface CmcReturnsListResult {
  returns: CmcReturnSummary[];
  total: number;
  limit: number;
  offset: number;
}

// ── Location / shift helpers ──────────────────────────────────────────────────

export function useCmcActiveShift() {
  return useQuery<{
    shift: { id: number; location_id: number; location_name: string } | null;
  }>({
    queryKey: ["cmc-active-shift"],
    queryFn: () =>
      apiFetch<{
        shift: { id: number; location_id: number; location_name: string } | null;
      }>("/api/cmc-pos/shifts/active", {}),
  });
}

export function useWorkspaceLocations() {
  return useQuery<{ locations: { id: number; name: string }[] }>({
    queryKey: ["workspace-locations"],
    queryFn: () =>
      apiFetch<{ locations: { id: number; name: string }[] }>("/api/locations", {}),
  });
}

// ── Product search (uses existing shelf-products endpoint, client-filtered) ──

export function useCmcShelfProducts(
  locationId: number | null,
  query: string,
): { data: EligibleProduct[] | undefined; isLoading: boolean } {
  const result = useQuery<{ products: ShelfProduct[] }>({
    queryKey: ["cmc-shelf-products", locationId],
    queryFn: () =>
      apiFetch<{ products: ShelfProduct[] }>(
        `/api/cmc-pos/shelf-products${locationId ? `?location_id=${locationId}` : ""}`,
        {},
      ),
    enabled: locationId !== null,
    placeholderData: (prev) => prev,
  });

  const q = query.trim().toLowerCase();
  const products: EligibleProduct[] | undefined = result.data?.products
    .filter((p) => {
      if (!q) return true;
      return (
        p.name.toLowerCase().includes(q) ||
        (p.sku && p.sku.toLowerCase().includes(q))
      );
    })
    .map((p) => ({
      id: p.id,
      name: p.name,
      sku: p.sku,
      image_url: p.main_image_url,
      available_stock: p.stock_qty ?? 0,
    }));

  return { data: products, isLoading: result.isLoading || result.isFetching };
}

// ── Returns list / detail ─────────────────────────────────────────────────────

export function useCmcReturnsList(params: {
  q?: string;
  status?: ReturnStatus | "";
  offset?: number;
  limit?: number;
}) {
  const sp = new URLSearchParams();
  if (params.q) sp.set("q", params.q);
  if (params.status) sp.set("status", params.status);
  sp.set("limit", String(params.limit ?? 20));
  sp.set("offset", String(params.offset ?? 0));

  return useQuery<CmcReturnsListResult>({
    queryKey: ["cmc-returns", params],
    queryFn: () =>
      apiFetch<CmcReturnsListResult>(`/api/cmc-pos/returns?${sp.toString()}`, {}),
    placeholderData: (prev) => prev,
  });
}

export function useCmcReturnDetail(id: string | number | null) {
  return useQuery<{ return: CmcReturn }>({
    queryKey: ["cmc-return", id],
    queryFn: () =>
      apiFetch<{ return: CmcReturn }>(`/api/cmc-pos/returns/${id}`, {}),
    enabled: id !== null,
  });
}

// ── Create + submit (two-step) ────────────────────────────────────────────────

interface CreateReturnBody {
  branch_location_id: number;
  return_to_location_id: number;
  collection_method: CollectionMethod;
  collection_date: string;
  notes?: string | null;
  line_items: Array<{
    product_id: number | null;
    name_snapshot: string;
    sku_snapshot?: string | null;
    image_url?: string | null;
    quantity: number;
    reason: ReturnReason;
    is_custom: boolean;
  }>;
}

/** Step 1 of 2: create the return as a draft. Returns the new return with its id. */
export function useCreateCmcReturn() {
  return useMutation({
    mutationFn: (body: CreateReturnBody) =>
      apiFetch<{ return: CmcReturn }>(`/api/cmc-pos/returns`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }),
  });
}

/** Step 2 of 2: transition the draft to awaiting_pickup, deduct stock. */
export function useActivateCmcReturn() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string | number) =>
      apiFetch<{ return: CmcReturn }>(`/api/cmc-pos/returns/${id}/submit`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["cmc-returns"] });
    },
  });
}

export function useCancelCmcReturn(id: string | number) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () =>
      apiFetch(`/api/cmc-pos/returns/${id}/cancel`, { method: "POST" }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["cmc-returns"] });
      void qc.invalidateQueries({ queryKey: ["cmc-return", id] });
    },
  });
}

export function useUploadReturnPhoto() {
  return useMutation({
    mutationFn: async (file: File): Promise<{ url: string }> => {
      const formData = new FormData();
      formData.append("photo", file);
      const result = await apiFetch<{ url: string }>(
        "/api/cmc-pos/returns/upload-photo",
        { method: "POST", body: formData },
      );
      return result;
    },
  });
}

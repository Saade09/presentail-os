import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Link, useLocation } from "wouter";
import {
  ArrowLeft, Plus, Trash2, Loader2, Pencil,
  ArrowRight, CheckCircle2, AlertTriangle, Clock,
  RotateCcw, ShoppingBag,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { apiFetch } from "@/lib/queryClient";
import { isPermissionError } from "@/lib/permissionError";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "@/hooks/use-toast";
import { imageUrl } from "@/lib/imageUrl";
import { BranchProductPickerModal } from "./BranchProductPickerModal";

// ── Types ─────────────────────────────────────────────────────────────────────

type Location = { id: number; name: string };

type RequestLineItem = {
  product_id: number | null;
  productName: string;
  requested_qty: number;
  unit_price: string;
  notes: string;
  customMode: boolean;
  image_url?: string | null;
  description?: string | null;
};

// ── Helpers ───────────────────────────────────────────────────────────────────

function displayNeededBy(iso: string): string {
  const d = new Date(iso);
  const today = new Date();
  const tomorrow = new Date(today);
  tomorrow.setDate(today.getDate() + 1);
  const time = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  if (d.toDateString() === today.toDateString()) return `Today, ${time}`;
  if (d.toDateString() === tomorrow.toDateString()) return `Tomorrow, ${time}`;
  return d.toLocaleDateString([], { day: "numeric", month: "short" }) + ", " + time;
}

// ── Quantity stepper (inline form rows) ───────────────────────────────────────

function QtyControl({ value, onChange }: { value: number; onChange: (v: number) => void }) {
  return (
    <div className="flex items-center gap-1">
      <button
        type="button"
        className="h-7 w-7 rounded border text-lg leading-none flex items-center justify-center hover:bg-muted transition-colors"
        onClick={() => onChange(Math.max(1, value - 1))}
      >
        −
      </button>
      <span className="w-8 text-center text-sm font-medium">{value}</span>
      <button
        type="button"
        className="h-7 w-7 rounded border text-lg leading-none flex items-center justify-center hover:bg-muted transition-colors"
        onClick={() => onChange(value + 1)}
      >
        +
      </button>
    </div>
  );
}

// ── Main component ────────────────────────────────────────────────────────────

export default function CmcPosRequest() {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [, navigate] = useLocation();

  // Form state
  const [sourceLocationId, setSourceLocationId] = useState<string>("");
  const [destLocationId, setDestLocationId] = useState<string>("");
  const [purpose, setPurpose] = useState("for_customer");
  const [priority, setPriority] = useState<"standard" | "urgent">("standard");
  const [neededBy, setNeededBy] = useState("");
  const [notes, setNotes] = useState("");
  const [lineItems, setLineItems] = useState<RequestLineItem[]>([]);
  const [pickerOpen, setPickerOpen] = useState(false);

  const [draftSavedAt, setDraftSavedAt] = useState<Date | null>(null);

  // Locations query
  const { data: locationsData } = useQuery<{ locations: Location[] }>({
    queryKey: ["locations"],
    queryFn: () => apiFetch<{ locations: Location[] }>("/api/locations", {}),
  });

  const locations = locationsData?.locations ?? [];

  // Line item helpers
  const removeLineItem = (i: number) =>
    setLineItems((prev) => prev.filter((_, idx) => idx !== i));

  const updateLineItem = (i: number, patch: Partial<RequestLineItem>) =>
    setLineItems((prev) => prev.map((li, idx) => (idx === i ? { ...li, ...patch } : li)));

  // Add a blank custom item row
  const addCustomItem = () =>
    setLineItems((prev) => [
      ...prev,
      { product_id: null, productName: "", requested_qty: 1, unit_price: "", notes: "", customMode: true },
    ]);

  // Summary calculations
  const totalItems = lineItems.length;
  const totalUnits = lineItems.reduce((s, li) => s + li.requested_qty, 0);
  const estimatedValue = lineItems.reduce((s, li) => {
    const price = parseFloat(li.unit_price) || 0;
    return s + price * li.requested_qty;
  }, 0);
  const allProductsHavePrice = lineItems.every((li) => li.customMode || (li.product_id && li.unit_price));
  const allItemsFilled = lineItems.every((li) => li.customMode ? li.productName.trim() : li.product_id);
  // A source branch is required for submission: requests dispatch as a
  // source → destination Tookan route, so both legs must be selected.
  const canSubmit = allItemsFilled && lineItems.length > 0 && destLocationId && sourceLocationId;

  // Save as draft mutation
  const saveDraftMutation = useMutation({
    mutationFn: async () =>
      apiFetch<{ request: { id: string } }>("/api/cmc-pos/requests", {
        method: "POST",
        body: JSON.stringify({
          destination_location_id: destLocationId ? parseInt(destLocationId) : null,
          source_location_id: sourceLocationId ? parseInt(sourceLocationId) : null,
          purpose,
          priority,
          needed_by: neededBy || null,
          notes: notes || null,
          line_items: lineItems.map((li) => ({
            product_id: li.product_id,
            name: li.customMode ? (li.productName || null) : null,
            requested_qty: li.requested_qty,
            unit_price: li.unit_price ? parseFloat(li.unit_price) : null,
            notes: li.notes || null,
            image_url: li.image_url ?? null,
            description: li.description || null,
          })),
        }),
      }),
    onSuccess: () => {
      setDraftSavedAt(new Date());
      qc.invalidateQueries({ queryKey: ["cmc-pos-requests"] });
      toast({ title: "Draft saved" });
    },
    onError: (err) => {
      if (isPermissionError(err)) {
        toast({ title: t("cmcPos.noPermission"), description: t("cmcPos.noPermissionDesc"), variant: "destructive" });
        return;
      }
      toast({ title: "Failed to save draft", description: String(err), variant: "destructive" });
    },
  });

  // Submit mutation (create + submit)
  const submitMutation = useMutation({
    mutationFn: async () => {
      const createRes = await apiFetch<{ request: { id: string } }>("/api/cmc-pos/requests", {
        method: "POST",
        body: JSON.stringify({
          destination_location_id: destLocationId ? parseInt(destLocationId) : null,
          source_location_id: sourceLocationId ? parseInt(sourceLocationId) : null,
          purpose,
          priority,
          needed_by: neededBy || null,
          notes: notes || null,
          line_items: lineItems.map((li) => ({
            product_id: li.product_id,
            name: li.customMode ? (li.productName || null) : null,
            requested_qty: li.requested_qty,
            unit_price: li.unit_price ? parseFloat(li.unit_price) : null,
            notes: li.notes || null,
            image_url: li.image_url ?? null,
            description: li.description || null,
          })),
        }),
      });
      const submitRes = await apiFetch<{ request: unknown; tookan_error?: string }>(
        `/api/cmc-pos/requests/${createRes.request.id}/submit`,
        { method: "POST" },
      );
      return { id: createRes.request.id, tookanError: submitRes.tookan_error ?? null };
    },
    onSuccess: ({ id, tookanError }) => {
      qc.invalidateQueries({ queryKey: ["cmc-pos-requests"] });
      qc.invalidateQueries({ queryKey: ["cmc-pos-request-metrics"] });
      if (tookanError) {
        // Request was submitted but the courier task couldn't be created —
        // surface the actionable message; the detail page offers a retry.
        toast({
          title: "Submitted, but dispatch task failed",
          description: tookanError,
          variant: "destructive",
        });
      }
      navigate(`/cmc-pos/request/${id}`);
    },
    onError: (err) => {
      if (isPermissionError(err)) {
        toast({ title: t("cmcPos.noPermission"), description: t("cmcPos.noPermissionDesc"), variant: "destructive" });
        return;
      }
      toast({ title: "Submission failed", description: String(err), variant: "destructive" });
    },
  });

  const sourceName = locations.find((l) => String(l.id) === sourceLocationId)?.name;
  const destName = locations.find((l) => String(l.id) === destLocationId)?.name;
  const isPending = saveDraftMutation.isPending || submitMutation.isPending;

  return (
    <div className="flex flex-col min-h-full">
      {/* Header */}
      <div className="flex items-center gap-3 px-6 py-4 border-b">
        <Button variant="ghost" size="icon" className="h-9 w-9 shrink-0" asChild>
          <Link href="/cmc-pos/location-requests">
            <ArrowLeft className="h-4 w-4" />
          </Link>
        </Button>
        <div>
          <p className="text-xs text-muted-foreground">
            <Link href="/cmc-pos/location-requests" className="hover:underline">Branch Requests</Link>
          </p>
          <h1 className="text-base font-semibold leading-tight">New branch request</h1>
        </div>
        {draftSavedAt && (
          <Badge variant="outline" className="ml-2 text-xs text-muted-foreground font-normal">
            Draft saved {draftSavedAt.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
          </Badge>
        )}
      </div>

      {/* Two-panel layout */}
      <div className="flex flex-1 overflow-auto">
        {/* LEFT — Main form */}
        <div className="flex-1 min-w-0 overflow-y-auto">
          <div className="p-6 space-y-6 max-w-3xl">

            {/* Request details section */}
            <div>
              <h2 className="text-sm font-semibold mb-1">Request details</h2>
              <p className="text-xs text-muted-foreground mb-4">Choose where the items should come from and when you need them.</p>

              {/* Route row */}
              <div className="flex items-end gap-3 mb-4">
                <div className="flex-1 space-y-1.5">
                  <Label className="text-xs text-muted-foreground">
                    Request from <span className="text-destructive">*</span>
                  </Label>
                  <Select value={sourceLocationId} onValueChange={setSourceLocationId}>
                    <SelectTrigger className="h-9">
                      <SelectValue placeholder="Select source branch" />
                    </SelectTrigger>
                    <SelectContent>
                      {locations.map((l) => (
                        <SelectItem key={l.id} value={String(l.id)}>{l.name}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>

                <div className="pb-1.5 shrink-0">
                  <ArrowRight className="h-4 w-4 text-muted-foreground" />
                </div>

                <div className="flex-1 space-y-1.5">
                  <Label className="text-xs text-muted-foreground">
                    Deliver to <span className="text-destructive">*</span>
                  </Label>
                  <Select value={destLocationId} onValueChange={setDestLocationId}>
                    <SelectTrigger className="h-9">
                      <SelectValue placeholder="Select destination" />
                    </SelectTrigger>
                    <SelectContent>
                      {locations.map((l) => (
                        <SelectItem key={l.id} value={String(l.id)}>{l.name}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </div>

              {/* Purpose / Priority / Needed by */}
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                <div className="space-y-1.5">
                  <Label className="text-xs">Purpose</Label>
                  <Select value={purpose} onValueChange={setPurpose}>
                    <SelectTrigger className="h-9">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="for_customer">For customer</SelectItem>
                      <SelectItem value="internal">Internal</SelectItem>
                      <SelectItem value="display">Display</SelectItem>
                    </SelectContent>
                  </Select>
                </div>

                <div className="space-y-1.5">
                  <Label className="text-xs">Priority</Label>
                  <div className="flex rounded-md border overflow-hidden h-9">
                    {(["standard", "urgent"] as const).map((p) => (
                      <button
                        key={p}
                        type="button"
                        className={`flex-1 text-sm font-medium transition-colors capitalize ${
                          priority === p
                            ? p === "urgent"
                              ? "bg-orange-100 text-orange-700"
                              : "bg-muted text-foreground"
                            : "text-muted-foreground hover:bg-muted/50"
                        }`}
                        onClick={() => {
                          setPriority(p);
                          if (p === "urgent") {
                            const now = new Date();
                            now.setMinutes(now.getMinutes() + 45);
                            const pad = (n: number) => String(n).padStart(2, "0");
                            const datetimeLocal = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}T${pad(now.getHours())}:${pad(now.getMinutes())}`;
                            setNeededBy(datetimeLocal);
                          }
                        }}
                      >
                        {p.charAt(0).toUpperCase() + p.slice(1)}
                      </button>
                    ))}
                  </div>
                </div>

                <div className="space-y-1.5">
                  <Label className="text-xs">Needed by</Label>
                  <Input
                    type="datetime-local"
                    className="h-9 text-sm"
                    value={neededBy}
                    onChange={(e) => setNeededBy(e.target.value)}
                  />
                </div>
              </div>

              {/* Notes */}
              <div className="mt-3 space-y-1.5">
                <Label className="text-xs">Notes (optional)</Label>
                <Textarea
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                  rows={2}
                  placeholder="Add delivery instructions or customer context…"
                  className="text-sm resize-none"
                />
              </div>
            </div>

            {/* Items section */}
            <div>
              <div className="flex items-center justify-between mb-3">
                <div>
                  <h2 className="text-sm font-semibold">Items</h2>
                  {sourceLocationId && (
                    <p className="text-xs text-muted-foreground">
                      Products are requested from the selected source branch
                    </p>
                  )}
                </div>
                <div className="flex items-center gap-2">
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-8 text-xs gap-1"
                    onClick={addCustomItem}
                  >
                    <Pencil className="h-3.5 w-3.5" /> Custom item
                  </Button>
                  <Button
                    size="sm"
                    className="h-8 text-xs gap-1 bg-teal-800 hover:bg-teal-900 text-white"
                    disabled={!sourceLocationId}
                    title={!sourceLocationId ? "Select a source branch first" : undefined}
                    onClick={() => setPickerOpen(true)}
                  >
                    <ShoppingBag className="h-3.5 w-3.5" />
                    {lineItems.some((li) => !li.customMode) ? "Edit selection" : "Add products"}
                  </Button>
                </div>
              </div>

              {/* Empty state */}
              {lineItems.length === 0 && (
                <div className="rounded-lg border border-dashed p-8 text-center text-sm text-muted-foreground">
                  {sourceLocationId ? (
                    <>
                      <ShoppingBag className="mx-auto h-8 w-8 mb-2 opacity-30" />
                      <p>No items added yet.</p>
                      <p className="mt-1 text-xs">Click <strong>Add products</strong> to browse the catalogue.</p>
                    </>
                  ) : (
                    <>
                      <AlertTriangle className="mx-auto h-8 w-8 mb-2 opacity-30" />
                      <p>Select a source branch to add products.</p>
                    </>
                  )}
                </div>
              )}

              {/* Items table */}
              {lineItems.length > 0 && (
                <div className="rounded-lg border overflow-hidden">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b bg-muted/30">
                        <th className="text-left py-2 px-3 text-xs font-medium text-muted-foreground">Product</th>
                        <th className="text-center py-2 px-3 text-xs font-medium text-muted-foreground w-28">Quantity</th>
                        <th className="text-right py-2 px-3 text-xs font-medium text-muted-foreground w-24">Unit price</th>
                        <th className="text-right py-2 px-3 text-xs font-medium text-muted-foreground w-24">Total</th>
                        <th className="w-10" />
                      </tr>
                    </thead>
                    <tbody>
                      {lineItems.map((li, i) => {
                        const lineTotal = (parseFloat(li.unit_price) || 0) * li.requested_qty;
                        const imgUrl = imageUrl(li.image_url ?? null);
                        return (
                          <tr key={i} className="border-b last:border-0">
                            <td className="py-2.5 px-3">
                              <div className="flex items-center gap-2">
                                {imgUrl ? (
                                  <img src={imgUrl} alt="" className="h-8 w-8 rounded object-cover border shrink-0" />
                                ) : (
                                  <div className="h-8 w-8 rounded border bg-muted shrink-0" />
                                )}
                                {li.customMode ? (
                                  <div className="flex items-center gap-1.5 flex-1 min-w-0">
                                    <Input
                                      className="h-8 text-sm flex-1 min-w-0"
                                      placeholder="Custom item name"
                                      value={li.productName}
                                      onChange={(e) => updateLineItem(i, { productName: e.target.value })}
                                    />
                                    <button
                                      type="button"
                                      title="Remove custom item"
                                      className="shrink-0 text-muted-foreground hover:text-destructive transition-colors"
                                      onClick={() => removeLineItem(i)}
                                    >
                                      <RotateCcw className="h-3 w-3" />
                                    </button>
                                  </div>
                                ) : (
                                  <span className="text-sm font-medium truncate">{li.productName}</span>
                                )}
                              </div>
                            </td>
                            <td className="py-2.5 px-3">
                              <div className="flex justify-center">
                                <QtyControl
                                  value={li.requested_qty}
                                  onChange={(v) => updateLineItem(i, { requested_qty: v })}
                                />
                              </div>
                            </td>
                            <td className="py-2.5 px-3 text-right">
                              <Input
                                type="number"
                                min="0"
                                step="0.01"
                                value={li.unit_price}
                                onChange={(e) => updateLineItem(i, { unit_price: e.target.value })}
                                className="h-8 text-sm text-right w-20 ml-auto"
                                placeholder="—"
                              />
                            </td>
                            <td className="py-2.5 px-3 text-right text-sm font-medium">
                              {li.unit_price ? `$${lineTotal.toFixed(2)}` : "—"}
                            </td>
                            <td className="py-2.5 px-3">
                              <button
                                type="button"
                                className="text-muted-foreground hover:text-destructive transition-colors"
                                onClick={() => removeLineItem(i)}
                              >
                                <Trash2 className="h-4 w-4" />
                              </button>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </div>

          </div>
        </div>

        {/* RIGHT — Sticky summary */}
        <div className="hidden lg:flex flex-col w-80 shrink-0 border-l">
          <div className="sticky top-0 p-5 space-y-5 overflow-y-auto max-h-screen">
            <h3 className="font-semibold text-sm">Request summary</h3>

            {/* Route */}
            <div className="flex items-center gap-2 text-sm font-medium">
              <span>{sourceName || "—"}</span>
              <ArrowRight className="h-3.5 w-3.5 text-muted-foreground" />
              <span>{destName || "—"}</span>
            </div>

            {/* Stats */}
            <div className="space-y-2.5 text-sm">
              <div className="flex items-center justify-between text-muted-foreground">
                <div className="flex items-center gap-2">
                  <div className="h-4 w-4 rounded border border-current flex items-center justify-center text-[10px]">3</div>
                  <span>{totalItems} {totalItems === 1 ? "product" : "products"}</span>
                </div>
              </div>
              <div className="flex items-center justify-between text-muted-foreground">
                <span className="flex items-center gap-2">
                  <div className="h-4 w-4 flex items-center justify-center text-xs font-bold">#</div>
                  {totalUnits} total units
                </span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-muted-foreground">Estimated value</span>
                <span className="font-semibold">
                  {allProductsHavePrice ? `$${estimatedValue.toFixed(2)}` : "—"}
                </span>
              </div>
              {neededBy && (
                <div className="flex items-center justify-between">
                  <span className="flex items-center gap-1.5 text-muted-foreground">
                    <Clock className="h-3.5 w-3.5" /> Needed by
                  </span>
                  <span className="font-medium text-xs">{displayNeededBy(neededBy)}</span>
                </div>
              )}
              <div className="flex items-center justify-between">
                <span className="text-muted-foreground">Priority</span>
                <Badge
                  variant="outline"
                  className={priority === "urgent"
                    ? "bg-orange-50 text-orange-700 border-orange-200 text-xs"
                    : "bg-muted text-muted-foreground text-xs"}
                >
                  {priority === "urgent" ? "Urgent" : "Standard"}
                </Badge>
              </div>
            </div>

            {/* Availability */}
            <div className={`rounded-lg px-3 py-2.5 text-xs flex items-center gap-2 ${
              sourceLocationId && lineItems.some(li => li.product_id)
                ? "bg-emerald-50 text-emerald-700"
                : "bg-muted text-muted-foreground"
            }`}>
              {sourceLocationId && lineItems.some(li => li.product_id) ? (
                <>
                  <CheckCircle2 className="h-3.5 w-3.5 shrink-0" />
                  <span>Availability confirmed</span>
                </>
              ) : (
                <>
                  <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
                  <span>Select a source branch to check availability</span>
                </>
              )}
            </div>

            {/* Actions */}
            <div className="space-y-2 pt-1">
              <Button
                className="w-full bg-teal-800 hover:bg-teal-900 text-white"
                disabled={!canSubmit || isPending}
                onClick={() => submitMutation.mutate()}
              >
                {submitMutation.isPending && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
                Submit request
              </Button>
              <p className="text-xs text-center text-muted-foreground">
                {sourceLocationId
                  ? "The source branch manager will be notified."
                  : "Select a source branch to submit — dispatch routes from source to destination."}
              </p>
              <Button
                variant="outline"
                className="w-full"
                disabled={isPending || lineItems.every((li) => !li.product_id && !li.productName)}
                onClick={() => saveDraftMutation.mutate()}
              >
                {saveDraftMutation.isPending && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
                Save as draft
              </Button>
              <Button variant="ghost" className="w-full text-muted-foreground" asChild>
                <Link href="/cmc-pos/location-requests">Cancel</Link>
              </Button>
            </div>
          </div>
        </div>
      </div>

      {/* Mobile actions bar */}
      <div className="lg:hidden flex gap-2 p-4 border-t bg-background">
        <Button
          variant="outline"
          className="flex-1"
          disabled={isPending}
          onClick={() => saveDraftMutation.mutate()}
        >
          Save draft
        </Button>
        <Button
          className="flex-1 bg-teal-800 hover:bg-teal-900 text-white"
          disabled={!canSubmit || isPending}
          onClick={() => submitMutation.mutate()}
        >
          {isPending && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
          Submit
        </Button>
      </div>

      {/* Product picker modal */}
      <BranchProductPickerModal
        open={pickerOpen}
        onClose={() => setPickerOpen(false)}
        sourceBranchName={sourceName}
        initialLineItems={lineItems}
        onConfirm={(picked) => {
          // Replace catalog items with the new selection; preserve any custom items
          const customItems = lineItems.filter((li) => li.customMode);
          setLineItems([...picked, ...customItems]);
          setPickerOpen(false);
        }}
        onAddCustomItem={addCustomItem}
      />
    </div>
  );
}

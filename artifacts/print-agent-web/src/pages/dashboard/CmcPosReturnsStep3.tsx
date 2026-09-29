import { useState } from "react";
import {
  AlertTriangle,
  Edit2,
  Loader2,
  Package,
  ImageIcon,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { toast } from "@/hooks/use-toast";
import {
  RETURN_REASONS,
  COLLECTION_METHODS,
  useCreateCmcReturn,
  useActivateCmcReturn,
} from "@/hooks/useCmcReturns";
import type { CmcReturn } from "@/hooks/useCmcReturns";
import { useReturnsContext } from "./CmcPosReturnsContext";

function fmtDate(iso: string): string {
  const parts = iso.split("-");
  if (parts.length !== 3) return iso;
  const d = new Date(
    parseInt(parts[0]),
    parseInt(parts[1]) - 1,
    parseInt(parts[2]),
  );
  return d.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

function reasonLabel(r: string): string {
  return RETURN_REASONS.find((x) => x.value === r)?.label ?? r;
}

function collectionLabel(m: string): string {
  return COLLECTION_METHODS.find((x) => x.value === m)?.label ?? m;
}

const REASON_COLORS: Record<string, string> = {
  damaged: "bg-red-50 text-red-700 border-red-200",
  wilted: "bg-amber-50 text-amber-700 border-amber-200",
  expired: "bg-orange-50 text-orange-700 border-orange-200",
  incorrect_item: "bg-blue-50 text-blue-700 border-blue-200",
  quality_issue: "bg-purple-50 text-purple-700 border-purple-200",
};

interface Props {
  onSuccess: (ret: CmcReturn) => void;
}

export default function CmcPosReturnsStep3({ onSuccess }: Props) {
  const { draft, setStep } = useReturnsContext();
  const { lines, details } = draft;
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  const createReturn = useCreateCmcReturn();
  const activateReturn = useActivateCmcReturn();

  const totalUnits = lines.reduce((s, l) => s + l.quantity, 0);

  const handleSubmit = async () => {
    if (submitting) return;
    if (!details.branch_location_id || !details.return_to_location_id) {
      setSubmitError(
        "Branch and return destination locations are required. Please go back to step 1.",
      );
      return;
    }
    setSubmitting(true);
    setSubmitError(null);
    try {
      // Step 1: create the return draft
      const createResult = await createReturn.mutateAsync({
        branch_location_id: details.branch_location_id,
        return_to_location_id: details.return_to_location_id,
        collection_method: details.collection_method,
        collection_date: details.collection_date,
        notes: details.notes || null,
        line_items: lines.map((l) => ({
          product_id: l.product_id,
          name_snapshot: l.name_snapshot,
          sku_snapshot: l.sku_snapshot,
          image_url: l.image_url,
          quantity: l.quantity,
          reason: l.reason,
          is_custom: l.is_custom,
        })),
      });

      const returnId = createResult.return.id;

      // Step 2: submit (transitions to awaiting_pickup, deducts stock)
      const submitResult = await activateReturn.mutateAsync(returnId);
      onSuccess(submitResult.return);
    } catch (err) {
      const msg =
        err instanceof Error ? err.message : "Failed to submit return";
      setSubmitError(msg);
      toast({
        title: "Submission failed",
        description: msg,
        variant: "destructive",
      });
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="flex flex-col gap-6">
      {/* Step header */}
      <div>
        <h2
          className="text-base font-semibold"
          id="step3-heading"
          tabIndex={-1}
        >
          Step 3 of 3 — Review & submit
        </h2>
        <p className="text-sm text-muted-foreground mt-0.5">
          Review your return before submitting.
        </p>
      </div>

      {/* Products section */}
      <div className="rounded-lg border overflow-hidden">
        <div className="flex items-center justify-between px-4 py-3 border-b bg-muted/20">
          <h3 className="text-sm font-semibold">
            Products · {lines.length} item{lines.length !== 1 ? "s" : ""} ·{" "}
            {totalUnits} unit{totalUnits !== 1 ? "s" : ""}
          </h3>
          <button
            type="button"
            className="flex items-center gap-1 text-xs text-teal-700 hover:underline font-medium"
            onClick={() => setStep(0)}
            aria-label="Edit products"
          >
            <Edit2 className="h-3 w-3" />
            Edit
          </button>
        </div>
        <div className="divide-y">
          {lines.map((l) => (
            <div
              key={l.draftId}
              className="flex items-center gap-3 px-4 py-3"
            >
              {l.image_url ? (
                <img
                  src={l.image_url}
                  alt=""
                  className="h-9 w-9 rounded border object-cover shrink-0"
                />
              ) : (
                <div className="h-9 w-9 rounded border bg-muted shrink-0 flex items-center justify-center">
                  <Package className="h-4 w-4 text-muted-foreground opacity-40" />
                </div>
              )}
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium truncate">
                  {l.name_snapshot}
                </p>
                {l.sku_snapshot && (
                  <p className="text-xs text-muted-foreground">
                    {l.sku_snapshot}
                  </p>
                )}
                {l.is_custom && (
                  <Badge
                    variant="outline"
                    className="text-xs bg-purple-50 text-purple-700 border-purple-200 mt-0.5"
                  >
                    Custom
                  </Badge>
                )}
              </div>
              <div className="flex items-center gap-2 shrink-0">
                <span className="text-sm font-medium">×{l.quantity}</span>
                <Badge
                  variant="outline"
                  className={`text-xs ${REASON_COLORS[l.reason] ?? "bg-muted text-muted-foreground"}`}
                >
                  {reasonLabel(l.reason)}
                </Badge>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Return details section */}
      <div className="rounded-lg border overflow-hidden">
        <div className="flex items-center justify-between px-4 py-3 border-b bg-muted/20">
          <h3 className="text-sm font-semibold">Return details</h3>
          <button
            type="button"
            className="flex items-center gap-1 text-xs text-teal-700 hover:underline font-medium"
            onClick={() => setStep(1)}
            aria-label="Edit return details"
          >
            <Edit2 className="h-3 w-3" />
            Edit
          </button>
        </div>
        <div className="px-4 py-4 space-y-3 text-sm">
          <div className="flex gap-4">
            <div className="flex-1">
              <p className="text-xs text-muted-foreground">Collection method</p>
              <p className="mt-0.5 font-medium">
                {collectionLabel(details.collection_method)}
              </p>
            </div>
            <div className="flex-1">
              <p className="text-xs text-muted-foreground">Collection date</p>
              <p className="mt-0.5 font-medium">
                {details.collection_date
                  ? fmtDate(details.collection_date)
                  : "—"}
              </p>
            </div>
          </div>

          {details.notes && (
            <div>
              <p className="text-xs text-muted-foreground">Condition notes</p>
              <p className="mt-0.5 text-foreground">{details.notes}</p>
            </div>
          )}

          <div>
            <p className="text-xs text-muted-foreground">Photos</p>
            {details.photo_urls.length === 0 ? (
              <p className="mt-0.5 text-muted-foreground">None</p>
            ) : (
              <div className="flex items-center gap-2 mt-1">
                <ImageIcon className="h-4 w-4 text-muted-foreground" />
                <p className="text-sm">
                  {details.photo_urls.length} photo
                  {details.photo_urls.length !== 1 ? "s" : ""} attached
                </p>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Warning */}
      <div className="flex items-start gap-2.5 rounded-md bg-amber-50 border border-amber-200 px-4 py-3 text-sm text-amber-800">
        <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0" />
        <span>
          Submitting this return will remove the reported units from your
          available stock. This action cannot be undone.
        </span>
      </div>

      {/* Submit error */}
      {submitError && (
        <div className="rounded-md bg-red-50 border border-red-200 px-4 py-3 text-sm text-red-700">
          {submitError}
        </div>
      )}

      {/* Actions */}
      <div className="flex items-center justify-between pt-2">
        <Button
          type="button"
          variant="outline"
          onClick={() => setStep(1)}
          disabled={submitting}
          aria-label="Back to step 2"
        >
          Back
        </Button>
        <Button
          className="bg-teal-700 hover:bg-teal-800 text-white"
          onClick={handleSubmit}
          disabled={submitting}
          aria-label="Submit return to CMC"
        >
          {submitting ? (
            <>
              <Loader2 className="h-4 w-4 mr-2 animate-spin" />
              Submitting…
            </>
          ) : (
            "Submit return to CMC"
          )}
        </Button>
      </div>
    </div>
  );
}

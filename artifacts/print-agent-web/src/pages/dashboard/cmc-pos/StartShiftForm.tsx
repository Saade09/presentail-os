import { useState, useEffect } from "react";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { apiFetch } from "@/lib/queryClient";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "@/hooks/use-toast";

type Location = { id: number; name: string; currency: string; secondary_currency: string | null };

export function StartShiftForm({ onSuccess, onCancel }: { onSuccess: () => void; onCancel: () => void }) {
  const [locationId, setLocationId] = useState("");
  const [openingCash, setOpeningCash] = useState("0");
  const [openingCashSecondary, setOpeningCashSecondary] = useState("0");
  const [selectedCurrency, setSelectedCurrency] = useState<string>("");

  // Use the CMC-specific locations endpoint so we get drawer currency info.
  const { data: locData } = useQuery<{ locations: Location[] }>({
    queryKey: ["cmc-pos-locations"],
    queryFn: () => apiFetch("/api/cmc-pos/locations"),
    staleTime: 300_000,
  });
  const locations = locData?.locations ?? [];

  // Auto-select CMC Beirut Hospital, falling back to the first location
  useEffect(() => {
    if (locations.length === 0) return;
    const match =
      locations.find((l) => l.name.toLowerCase().includes("cmc beirut hospital")) ??
      locations[0];
    setLocationId(String(match.id));
    // Auto-set currency for single-currency drawers
    if (!match.secondary_currency) {
      setSelectedCurrency(match.currency);
    }
    // For dual-currency drawers the currency radio is replaced by two separate
    // opening-cash fields, so no selectedCurrency is needed.
  }, [locations]);

  const selectedLocation = locations.find((l) => String(l.id) === locationId) ?? null;
  const isDualCurrency = !!(selectedLocation?.secondary_currency);

  const qc = useQueryClient();
  const startShift = useMutation({
    mutationFn: () =>
      apiFetch("/api/cmc-pos/shifts", {
        method: "POST",
        body: JSON.stringify(
          isDualCurrency
            ? {
                location_id: Number(locationId),
                opening_cash: Number(openingCash) || 0,
                opening_cash_secondary: Number(openingCashSecondary) || 0,
              }
            : {
                location_id: Number(locationId),
                opening_cash: Number(openingCash) || 0,
                currency: selectedCurrency || undefined,
              },
        ),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["cmc-pos-active-shift"] });
      qc.invalidateQueries({ queryKey: ["cmc-pos-cash-drawer"] });
      qc.invalidateQueries({ queryKey: ["cmc-pos-cash-drawer-transactions"] });
      qc.invalidateQueries({ queryKey: ["cmc-pos-metrics"] });
      qc.invalidateQueries({ queryKey: ["cmc-pos-shifts"] });
      onSuccess();
    },
    onError: (err: Error) => {
      const code = (err as Error & { code?: string }).code;
      const msg = err.message || "Failed to start shift";
      if (msg.includes("already have an open shift") || code === "DUPLICATE_USER_SHIFT") {
        toast({ title: "You already have an open shift", variant: "destructive" });
        qc.invalidateQueries({ queryKey: ["cmc-pos-active-shift"] });
      } else if (code === "NO_ACTIVE_DRAWER") {
        toast({
          title: "No cash drawer at this location",
          description: "Ask a manager to set up an active cash drawer before starting a shift here.",
          variant: "destructive",
        });
      } else {
        toast({ title: msg, variant: "destructive" });
      }
    },
  });

  // Dual-currency: valid when both amounts are ≥ 0 (zero is a valid opening balance).
  // Single-currency: valid when a currency is selected and the amount is ≥ 0.
  const valid = isDualCurrency
    ? !!locationId &&
      openingCash !== "" &&
      Number(openingCash) >= 0 &&
      openingCashSecondary !== "" &&
      Number(openingCashSecondary) >= 0
    : !!locationId && openingCash !== "" && Number(openingCash) >= 0 && !!selectedCurrency;

  return (
    <div className="px-5 py-4 space-y-4 border-t border-gray-100 bg-gray-50">
      <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide">Start Shift</p>

      {/* Dual-currency: two opening-cash fields (one per currency) */}
      {isDualCurrency && selectedLocation ? (
        <div className="space-y-3">
          <p className="text-xs text-gray-400">
            Enter the opening cash for each currency in the drawer.
          </p>
          <div className="space-y-1.5">
            <Label className="text-xs">Opening Cash ({selectedLocation.currency})</Label>
            <Input
              type="number"
              min="0"
              step="0.01"
              className="h-9 text-sm"
              placeholder="0.00"
              value={openingCash}
              onChange={(e) => setOpeningCash(e.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs">Opening Cash ({selectedLocation.secondary_currency})</Label>
            <Input
              type="number"
              min="0"
              step="0.01"
              className="h-9 text-sm"
              placeholder="0.00"
              value={openingCashSecondary}
              onChange={(e) => setOpeningCashSecondary(e.target.value)}
            />
          </div>
        </div>
      ) : (
        /* Single-currency: one opening-cash field */
        <div className="space-y-1.5">
          <Label className="text-xs">Opening Cash{selectedCurrency ? ` (${selectedCurrency})` : ""}</Label>
          <Input
            type="number"
            min="0"
            step="0.01"
            className="h-9 text-sm"
            placeholder="0.00"
            value={openingCash}
            onChange={(e) => setOpeningCash(e.target.value)}
          />
          <p className="text-xs text-gray-400">Amount of cash in the drawer at shift start</p>
        </div>
      )}

      <div className="flex gap-2">
        <Button
          variant="outline"
          size="sm"
          className="flex-1"
          onClick={onCancel}
          disabled={startShift.isPending}
        >
          Cancel
        </Button>
        <Button
          size="sm"
          className="flex-1"
          style={{ background: "#00414e" }}
          disabled={!valid || startShift.isPending}
          onClick={() => startShift.mutate()}
        >
          {startShift.isPending && <Loader2 className="h-3.5 w-3.5 animate-spin mr-1" />}
          Start Shift
        </Button>
      </div>
    </div>
  );
}

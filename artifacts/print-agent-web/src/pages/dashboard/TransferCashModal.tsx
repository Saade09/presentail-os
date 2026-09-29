import React, { useRef, useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import {
  AlertTriangle,
  ArrowRight,
  Check,
  ChevronDown,
  Info,
  Loader2,
  Paperclip,
  X,
} from "lucide-react";
import { apiFetch } from "@/lib/queryClient";
import { formatCashMoney, DASH } from "@/lib/cashMoney";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { useToast } from "@/hooks/use-toast";
import type { CurrencySummary, SessionDetailResponse } from "./CashSessionDetail";

const TEAL_DARK = "#064E5A";
const TEAL_PALE = "#E6F4F6";

type LocationRow = { id: number; name: string };
type DrawerRow = {
  id: number;
  name: string;
  code: string | null;
  location_id: number | null;
  is_active: boolean;
  // The API returns per-drawer `currency` (+ optional `secondary_currency`);
  // some older payloads/tests may include a `currencies` array. All are optional
  // here so malformed payloads can never crash the dialog.
  currency?: string | null;
  secondary_currency?: string | null;
  currencies?: unknown;
};

/**
 * Currencies a drawer supports, tolerant of missing/malformed fields.
 * Returns null when the payload carries no currency info at all, in which
 * case we skip currency filtering for that drawer instead of hiding it.
 */
export function drawerSupportedCurrencies(d: DrawerRow): string[] | null {
  const out: string[] = [];
  if (Array.isArray(d.currencies)) {
    for (const c of d.currencies) {
      if (typeof c === "string" && c) out.push(c);
    }
  }
  if (typeof d.currency === "string" && d.currency) out.push(d.currency);
  if (typeof d.secondary_currency === "string" && d.secondary_currency) {
    out.push(d.secondary_currency);
  }
  return out.length > 0 ? out : null;
}
type UserRow = { id: number; name: string | null; email: string | null; clerk_user_id: string | null };

type TransferMethod = "same_location_handover" | "cross_location_delivery" | "whish_transfer";

export function transferMethodLabel(method: string): string {
  switch (method) {
    case "same_location_handover": return "Same-location handover";
    case "cross_location_delivery": return "Cross-location delivery";
    case "whish_transfer": return "Whish transfer";
    default: return method;
  }
}

type TransferFormState = {
  currency: string;
  amount: string;
  destinationLocationId: string;
  destinationDrawerId: string;
  method: TransferMethod;
  receiverUserId: string;
  carrierUserId: string;
  carrierExternal: string;
  useExternalCarrier: boolean;
  reason: string;
  documentFile: File | null;
};

export type TransferCashModalProps = {
  open: boolean;
  onClose: () => void;
  sessionId: string;
  sessionNumber: string;
  sourceLocationName: string | null;
  sourceDrawerName: string | null;
  sourceDrawerId: number | null;
  currencies: string[];
  currencySummary: CurrencySummary[];
  onSuccess: () => void;
};

export function TransferCashModal({
  open,
  onClose,
  sessionId,
  sessionNumber,
  sourceLocationName,
  sourceDrawerName,
  sourceDrawerId,
  currencies,
  currencySummary,
  onSuccess,
}: TransferCashModalProps) {
  const { t } = useTranslation();
  const { toast } = useToast();
  const idempotencyKeyRef = useRef<string>(crypto.randomUUID());

  const [step, setStep] = useState<1 | 2>(1);
  const [confirmed, setConfirmed] = useState(false);

  const defaultCurrency = currencies[0] ?? "USD";
  const [form, setForm] = useState<TransferFormState>({
    currency: defaultCurrency,
    amount: "",
    destinationLocationId: "",
    destinationDrawerId: "",
    method: "same_location_handover",
    receiverUserId: "",
    carrierUserId: "",
    carrierExternal: "",
    useExternalCarrier: false,
    reason: "",
    documentFile: null,
  });
  const fileRef = useRef<HTMLInputElement>(null);

  // Fetch locations
  const { data: locData } = useQuery<{ locations: LocationRow[] }>({
    queryKey: ["locations"],
    queryFn: () => apiFetch("/api/locations"),
    enabled: open,
  });
  // Fetch drawers
  const { data: drawerData } = useQuery<{ drawers: DrawerRow[] }>({
    queryKey: ["cash-drawers"],
    queryFn: () => apiFetch("/api/cash-drawers"),
    enabled: open,
  });
  // Fetch users
  const { data: usersData } = useQuery<{ members: UserRow[] }>({
    queryKey: ["users"],
    queryFn: () => apiFetch("/api/users"),
    enabled: open,
  });

  const locations = locData?.locations ?? [];
  const allDrawers = drawerData?.drawers ?? [];
  const users = usersData?.members ?? [];

  // Filter drawers for selected destination location, excluding the source drawer by ID,
  // and only showing drawers that support the selected transfer currency.
  const destinationDrawers = allDrawers.filter((d) => {
    if (!d.is_active) return false;
    if (String(d.location_id) !== form.destinationLocationId) return false;
    if (d.id === sourceDrawerId) return false;
    const supported = drawerSupportedCurrencies(d);
    // No currency info on the payload → don't filter this drawer out.
    return supported === null || supported.includes(form.currency);
  });

  // Available cash for selected currency
  const summaryRow = currencySummary.find((r) => r.currency === form.currency);
  const availableCash = summaryRow?.expected_cash ?? 0;

  const amountNum = parseFloat(form.amount || "0");
  const amountValid = !isNaN(amountNum) && amountNum > 0 && amountNum <= availableCash;

  const step1Valid =
    amountValid &&
    !!form.destinationLocationId &&
    !!form.destinationDrawerId &&
    (form.method === "same_location_handover"
      ? !form.useExternalCarrier
        ? !!form.carrierUserId
        : !!form.carrierExternal.trim()
      : !form.useExternalCarrier
        ? !!form.carrierUserId
        : !!form.carrierExternal.trim());

  // Derived destination info
  const destLocation = locations.find((l) => String(l.id) === form.destinationLocationId);
  const destDrawer = destinationDrawers.find((d) => String(d.id) === form.destinationDrawerId);
  const receiverUser = users.find((u) => String(u.id) === form.receiverUserId);
  const carrierUser = users.find((u) => String(u.id) === form.carrierUserId);

  // Source balance visualization
  const sourceAfter = availableCash - amountNum;

  function patchForm(patch: Partial<TransferFormState>) {
    setForm((f) => ({ ...f, ...patch }));
  }

  function handleClose() {
    setStep(1);
    setConfirmed(false);
    setForm({
      currency: defaultCurrency,
      amount: "",
      destinationLocationId: "",
      destinationDrawerId: "",
      method: "same_location_handover",
      receiverUserId: "",
      carrierUserId: "",
      carrierExternal: "",
      useExternalCarrier: false,
      reason: "",
      documentFile: null,
    });
    idempotencyKeyRef.current = crypto.randomUUID();
    onClose();
  }

  const transferMutation = useMutation({
    mutationFn: async () => {
      // Upload document if attached
      let documentUrl: string | undefined;
      if (form.documentFile) {
        const fd = new FormData();
        fd.append("invoice", form.documentFile);
        const uploaded = await apiFetch<{ url: string }>(
          `/api/cash-sessions/${sessionId}/bill/invoice`,
          { method: "POST", body: fd },
        );
        documentUrl = uploaded.url;
      }

      return apiFetch(`/api/cash-sessions/${sessionId}/transfer`, {
        method: "POST",
        headers: { "X-Idempotency-Key": idempotencyKeyRef.current },
        body: JSON.stringify({
          currency: form.currency,
          amount: amountNum,
          destination_drawer_id: Number(form.destinationDrawerId),
          transfer_method: form.method,
          receiver_user_id: form.receiverUserId && form.receiverUserId !== "__none"
            ? Number(form.receiverUserId)
            : null,
          carrier_user_id: !form.useExternalCarrier && form.carrierUserId
            ? Number(form.carrierUserId)
            : null,
          carrier_external_name: form.useExternalCarrier
            ? form.carrierExternal.trim() || null
            : null,
          reason: form.reason.trim() || null,
          document_url: documentUrl ?? null,
        }),
      });
    },
    onSuccess: () => {
      toast({ title: "Transfer created successfully" });
      onSuccess();
      handleClose();
    },
    onError: (err: Error) => {
      toast({ title: err.message || "Transfer failed", variant: "destructive" });
    },
  });

  const carrierLabel = form.useExternalCarrier
    ? form.carrierExternal.trim() || "—"
    : carrierUser?.name ?? carrierUser?.email ?? "—";

  return (
    <Dialog open={open} onOpenChange={(o) => !o && handleClose()}>
      <DialogContent
        className="flex max-h-[90vh] w-full max-w-2xl flex-col overflow-hidden p-0"
        data-testid="transfer-cash-modal"
      >
        {/* Modal header with stepper */}
        <DialogHeader className="shrink-0 space-y-3 border-b px-6 py-4">
          <DialogTitle className="text-lg font-semibold">Transfer Cash</DialogTitle>
          {/* Stepper */}
          <div className="flex items-center gap-2">
            {[1, 2].map((n, i) => {
              const active = step === n;
              const done = step > n;
              const labels = ["Transfer details", "Review & handover"];
              return (
                <div key={n} className="flex items-center gap-2">
                  {i > 0 && <div className="h-px w-6 bg-border" />}
                  <div
                    className={`flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium ${
                      active ? "text-white" : done ? "" : "text-muted-foreground"
                    }`}
                    style={
                      active
                        ? { backgroundColor: TEAL_DARK }
                        : done
                          ? { backgroundColor: TEAL_PALE, color: TEAL_DARK }
                          : undefined
                    }
                  >
                    {done ? <Check className="h-3 w-3" /> : <span>{n}</span>}
                    <span className="hidden sm:inline">{labels[i]}</span>
                  </div>
                </div>
              );
            })}
          </div>
        </DialogHeader>

        {/* Scrollable body */}
        <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5">
          {step === 1 ? (
            <Step1Form
              form={form}
              patchForm={patchForm}
              currencies={currencies}
              availableCash={availableCash}
              locations={locations}
              destinationDrawers={destinationDrawers}
              users={users}
              sessionNumber={sessionNumber}
              sourceLocationName={sourceLocationName}
              sourceDrawerName={sourceDrawerName}
              selectedCurrency={form.currency}
              fileRef={fileRef}
              amountNum={amountNum}
              amountValid={!!form.amount && amountValid}
            />
          ) : (
            <Step2Review
              form={form}
              amountNum={amountNum}
              availableCash={availableCash}
              sourceAfter={sourceAfter}
              sourceLocationName={sourceLocationName}
              sourceDrawerName={sourceDrawerName}
              destLocation={destLocation}
              destDrawer={destDrawer}
              receiverUser={receiverUser}
              carrierLabel={carrierLabel}
              confirmed={confirmed}
              onConfirmedChange={setConfirmed}
            />
          )}
        </div>

        {/* Footer */}
        <div
          className="shrink-0 space-y-2 border-t px-6 py-4"
          style={{ backgroundColor: "#FAFAFA" }}
        >
          {step === 1 && (
            <p className="text-xs text-muted-foreground">
              Transfers cannot be edited after handover.
            </p>
          )}
          <div className="flex items-center justify-between gap-2">
            <Button variant="outline" size="sm" onClick={handleClose}>
              Cancel
            </Button>
            {step === 1 ? (
              <Button
                size="sm"
                disabled={!step1Valid}
                onClick={() => setStep(2)}
                style={{ backgroundColor: TEAL_DARK }}
                className="text-white hover:opacity-90"
                data-testid="button-continue-to-review"
              >
                Continue to review
              </Button>
            ) : (
              <div className="flex gap-2">
                <Button variant="outline" size="sm" onClick={() => setStep(1)}>
                  Back
                </Button>
                <Button
                  size="sm"
                  disabled={!confirmed || transferMutation.isPending}
                  onClick={() => transferMutation.mutate()}
                  style={{ backgroundColor: TEAL_DARK }}
                  className="text-white hover:opacity-90"
                  data-testid="button-confirm-handover"
                >
                  {transferMutation.isPending && (
                    <Loader2 className="me-1.5 h-4 w-4 animate-spin" />
                  )}
                  Confirm handover & create transfer
                </Button>
              </div>
            )}
          </div>
        </div>

        {/* Hidden file input */}
        <input
          ref={fileRef}
          type="file"
          accept="image/jpeg,image/png,image/webp,application/pdf"
          className="hidden"
          onChange={(e) => patchForm({ documentFile: e.target.files?.[0] ?? null })}
        />
      </DialogContent>
    </Dialog>
  );
}

// ── Step 1 ──────────────────────────────────────────────────────────────────

function Step1Form({
  form,
  patchForm,
  currencies,
  availableCash,
  locations,
  destinationDrawers,
  users,
  sessionNumber,
  sourceLocationName,
  sourceDrawerName,
  selectedCurrency,
  fileRef,
  amountNum,
  amountValid,
}: {
  form: TransferFormState;
  patchForm: (patch: Partial<TransferFormState>) => void;
  currencies: string[];
  availableCash: number;
  locations: LocationRow[];
  destinationDrawers: DrawerRow[];
  users: UserRow[];
  sessionNumber: string;
  sourceLocationName: string | null;
  sourceDrawerName: string | null;
  selectedCurrency: string;
  fileRef: React.RefObject<HTMLInputElement | null>;
  amountNum: number;
  amountValid: boolean;
}) {
  return (
    <div className="space-y-5">
      {/* Source panel (read-only) */}
      <div
        className="rounded-lg border p-3 text-sm"
        style={{ backgroundColor: TEAL_PALE }}
      >
        <p className="mb-1.5 text-xs font-semibold uppercase tracking-wide" style={{ color: TEAL_DARK }}>
          Source
        </p>
        <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs">
          <span className="text-muted-foreground">Location</span>
          <span className="font-medium">{sourceLocationName ?? "—"}</span>
          <span className="text-muted-foreground">Drawer</span>
          <span className="font-medium">{sourceDrawerName ?? "—"}</span>
          <span className="text-muted-foreground">Session</span>
          <span className="font-mono font-medium">{sessionNumber}</span>
        </div>
      </div>

      {/* Amount + Currency */}
      <div className="space-y-1.5">
        <Label htmlFor="transfer-amount">Amount</Label>
        <div className="flex gap-2">
          <Input
            id="transfer-amount"
            type="number"
            min="0.01"
            step="0.01"
            placeholder="0.00"
            value={form.amount}
            onChange={(e) => patchForm({ amount: e.target.value })}
            data-testid="input-transfer-amount"
          />
          <Select
            value={form.currency}
            onValueChange={(v) => patchForm({ currency: v })}
          >
            <SelectTrigger className="w-24 shrink-0" data-testid="select-transfer-currency">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {currencies.map((c) => (
                <SelectItem key={c} value={c}>{c}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        {/* Available cash hint */}
        <p className={`text-xs ${form.amount && !amountValid ? "text-red-600" : "text-muted-foreground"}`}>
          Available: {form.currency} {formatCashMoney(availableCash, form.currency)}
          {form.amount && !amountValid && amountNum > 0
            ? " — Amount exceeds available cash"
            : ""}
        </p>
      </div>

      {/* Destination location */}
      <div className="space-y-1.5">
        <Label>Destination location</Label>
        <Select
          value={form.destinationLocationId}
          onValueChange={(v) =>
            patchForm({ destinationLocationId: v, destinationDrawerId: "" })
          }
        >
          <SelectTrigger data-testid="select-destination-location">
            <SelectValue placeholder="Select location…" />
          </SelectTrigger>
          <SelectContent>
            {locations.map((l) => (
              <SelectItem key={l.id} value={String(l.id)}>{l.name}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {/* Destination drawer */}
      <div className="space-y-1.5">
        <Label>Destination drawer</Label>
        <Select
          value={form.destinationDrawerId}
          onValueChange={(v) => patchForm({ destinationDrawerId: v })}
          disabled={!form.destinationLocationId}
        >
          <SelectTrigger data-testid="select-destination-drawer">
            <SelectValue placeholder={form.destinationLocationId ? "Select drawer…" : "Select location first"} />
          </SelectTrigger>
          <SelectContent>
            {destinationDrawers.length === 0 ? (
              <div className="px-3 py-4 text-center text-xs text-muted-foreground">
                {form.destinationLocationId
                  ? `No active drawers support ${selectedCurrency} at this location.`
                  : "Select a location first."}
              </div>
            ) : (
              destinationDrawers.map((d) => (
                <SelectItem key={d.id} value={String(d.id)}>{d.name}</SelectItem>
              ))
            )}
          </SelectContent>
        </Select>
      </div>

      {/* Transfer method */}
      <div className="space-y-2">
        <Label>Transfer method</Label>
        <div className="grid grid-cols-3 gap-2">
          {(
            [
              { value: "same_location_handover", label: "Same-location handover", desc: "Cash handed directly within the same location" },
              { value: "cross_location_delivery", label: "Cross-location delivery", desc: "Cash transported to another location" },
              { value: "whish_transfer", label: "Whish transfer", desc: "Amount sent digitally via Whish wallet" },
            ] as { value: TransferMethod; label: string; desc: string }[]
          ).map((opt) => (
            <button
              key={opt.value}
              type="button"
              onClick={() => patchForm({ method: opt.value })}
              className={`rounded-lg border p-3 text-start text-xs transition-colors ${
                form.method === opt.value
                  ? "border-2 font-medium"
                  : "text-muted-foreground hover:bg-muted/50"
              }`}
              style={
                form.method === opt.value
                  ? { borderColor: TEAL_DARK, color: TEAL_DARK }
                  : undefined
              }
              data-testid={`radio-method-${opt.value}`}
            >
              <span className="block font-semibold">{opt.label}</span>
              <span className="mt-0.5 block text-[11px] leading-tight opacity-75">{opt.desc}</span>
            </button>
          ))}
        </div>
      </div>

      {/* Intended receiver */}
      <div className="space-y-1.5">
        <Label>
          Intended receiver
          <span className="ms-1 text-xs font-normal text-muted-foreground">(optional)</span>
        </Label>
        <Select
          value={form.receiverUserId}
          onValueChange={(v) => patchForm({ receiverUserId: v })}
        >
          <SelectTrigger data-testid="select-receiver-user">
            <SelectValue placeholder="Select receiver…" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="__none">— None —</SelectItem>
            {users.map((u) => (
              <SelectItem key={u.id} value={String(u.id)}>
                {u.name ?? u.email ?? `User #${u.id}`}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {/* Carried by */}
      <div className="space-y-2">
        <Label>Carried by</Label>
        <label className="flex items-center gap-2 text-sm">
          <Checkbox
            checked={form.useExternalCarrier}
            onCheckedChange={(v) =>
              patchForm({ useExternalCarrier: v === true, carrierUserId: "", carrierExternal: "" })
            }
            data-testid="checkbox-external-carrier"
          />
          External carrier (not a workspace member)
        </label>
        {form.useExternalCarrier ? (
          <Input
            placeholder="Carrier name or ID"
            value={form.carrierExternal}
            onChange={(e) => patchForm({ carrierExternal: e.target.value })}
            data-testid="input-carrier-external"
          />
        ) : (
          <Select
            value={form.carrierUserId}
            onValueChange={(v) => patchForm({ carrierUserId: v })}
          >
            <SelectTrigger data-testid="select-carrier-user">
              <SelectValue placeholder="Select carrier…" />
            </SelectTrigger>
            <SelectContent>
              {users.map((u) => (
                <SelectItem key={u.id} value={String(u.id)}>
                  {u.name ?? u.email ?? `User #${u.id}`}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
      </div>

      {/* Reason / note */}
      <div className="space-y-1.5">
        <Label>
          Reason / note
          <span className="ms-1 text-xs font-normal text-muted-foreground">(optional)</span>
        </Label>
        <Textarea
          rows={2}
          placeholder="e.g. End-of-day consolidation"
          value={form.reason}
          onChange={(e) => patchForm({ reason: e.target.value })}
          data-testid="textarea-transfer-reason"
        />
      </div>

      {/* Attach handover document */}
      <div className="space-y-1.5">
        <Label>
          Handover document
          <span className="ms-1 text-xs font-normal text-muted-foreground">(optional)</span>
        </Label>
        {form.documentFile ? (
          <div className="flex items-center justify-between gap-2 rounded-md border px-3 py-2 text-sm">
            <span className="flex min-w-0 items-center gap-1.5">
              <Paperclip className="h-3.5 w-3.5 shrink-0" />
              <span className="truncate">{form.documentFile.name}</span>
            </span>
            <Button
              variant="ghost"
              size="sm"
              className="h-6 w-6 p-0"
              onClick={() => {
                patchForm({ documentFile: null });
                if (fileRef.current) fileRef.current.value = "";
              }}
            >
              <X className="h-3.5 w-3.5" />
            </Button>
          </div>
        ) : (
          <button
            type="button"
            onClick={() => fileRef.current?.click()}
            className="flex items-center gap-1.5 text-sm font-medium hover:underline"
            style={{ color: TEAL_DARK }}
            data-testid="button-attach-document"
          >
            <Paperclip className="h-3.5 w-3.5" /> Attach document
          </button>
        )}
      </div>

      {/* Balance impact callout */}
      {amountNum > 0 && (
        <div
          className="rounded-lg border p-3 text-xs"
          style={{ backgroundColor: "#EFF6FF", borderColor: "#BFDBFE" }}
        >
          <div className="mb-1.5 flex items-center gap-1.5 font-semibold text-blue-800">
            <Info className="h-3.5 w-3.5 shrink-0" />
            How balances will update
          </div>
          <ul className="space-y-1 text-blue-700">
            <li>
              Source drawer ({sourceDrawerName ?? "this drawer"}) expected cash will decrease by{" "}
              <strong>{formatCashMoney(amountNum, form.currency)}</strong>.
            </li>
            <li>
              Destination drawer will show a pending incoming transfer until received and confirmed.
            </li>
          </ul>
        </div>
      )}
    </div>
  );
}

// ── Step 2 ──────────────────────────────────────────────────────────────────

function Step2Review({
  form,
  amountNum,
  availableCash,
  sourceAfter,
  sourceLocationName,
  sourceDrawerName,
  destLocation,
  destDrawer,
  receiverUser,
  carrierLabel,
  confirmed,
  onConfirmedChange,
}: {
  form: TransferFormState;
  amountNum: number;
  availableCash: number;
  sourceAfter: number;
  sourceLocationName: string | null;
  sourceDrawerName: string | null;
  destLocation: LocationRow | undefined;
  destDrawer: DrawerRow | undefined;
  receiverUser: UserRow | undefined;
  carrierLabel: string;
  confirmed: boolean;
  onConfirmedChange: (v: boolean) => void;
}) {
  const methodLabel = transferMethodLabel(form.method);

  return (
    <div className="space-y-5">
      {/* Summary fields */}
      <div className="space-y-3 rounded-lg border p-4 text-sm">
        <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          Transfer summary
        </p>
        <div className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-2">
          <span className="text-muted-foreground">Amount</span>
          <span className="font-semibold" dir="ltr">
            {formatCashMoney(amountNum, form.currency)}
          </span>

          <span className="text-muted-foreground">Currency</span>
          <span>{form.currency}</span>

          <span className="text-muted-foreground">From</span>
          <span>
            {[sourceLocationName, sourceDrawerName].filter(Boolean).join(" · ")}
          </span>

          <span className="text-muted-foreground">To</span>
          <span>
            {[destLocation?.name, destDrawer?.name].filter(Boolean).join(" · ")}
          </span>

          <span className="text-muted-foreground">Method</span>
          <span>{methodLabel}</span>

          {receiverUser && (
            <>
              <span className="text-muted-foreground">Receiver</span>
              <span>{receiverUser.name ?? receiverUser.email}</span>
            </>
          )}

          <span className="text-muted-foreground">Carried by</span>
          <span>{carrierLabel}</span>

          {form.reason && (
            <>
              <span className="text-muted-foreground">Reason</span>
              <span className="break-words">{form.reason}</span>
            </>
          )}

          {form.documentFile && (
            <>
              <span className="text-muted-foreground">Document</span>
              <span className="flex items-center gap-1.5">
                <Paperclip className="h-3.5 w-3.5 shrink-0" />
                {form.documentFile.name}
              </span>
            </>
          )}
        </div>
      </div>

      {/* Balance impact visualization */}
      <div>
        <p className="mb-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          Balance impact
        </p>
        <div className="grid grid-cols-3 gap-2 text-center text-xs">
          {/* Source */}
          <div className="rounded-lg border p-3 space-y-1">
            <p className="text-[11px] font-semibold uppercase text-muted-foreground">Source</p>
            <p className="font-medium">{sourceDrawerName ?? "—"}</p>
            <div className="space-y-0.5">
              <div className="tabular-nums text-muted-foreground">
                {formatCashMoney(availableCash, form.currency)}
              </div>
              <div className="flex items-center justify-center gap-1">
                <ArrowRight className="h-3 w-3 text-muted-foreground" />
              </div>
              <div
                className="rounded px-1.5 py-0.5 font-semibold tabular-nums"
                style={{ backgroundColor: TEAL_PALE, color: TEAL_DARK }}
              >
                {formatCashMoney(sourceAfter, form.currency)}
              </div>
            </div>
          </div>

          {/* In transit */}
          <div
            className="rounded-lg border p-3 space-y-1"
            style={{ borderColor: "#BFDBFE", backgroundColor: "#EFF6FF" }}
          >
            <p className="text-[11px] font-semibold uppercase text-blue-700">In transit</p>
            <div className="flex items-center justify-center py-1">
              <ArrowRight className="h-5 w-5 text-blue-500" />
            </div>
            <div className="tabular-nums font-semibold text-blue-800">
              {formatCashMoney(amountNum, form.currency)}
            </div>
          </div>

          {/* Destination */}
          <div className="rounded-lg border p-3 space-y-1">
            <p className="text-[11px] font-semibold uppercase text-muted-foreground">Destination</p>
            <p className="font-medium">{destDrawer?.name ?? "—"}</p>
            <div className="space-y-0.5">
              <div className="tabular-nums text-muted-foreground">Current</div>
              <div className="flex items-center justify-center gap-1">
                <ArrowRight className="h-3 w-3 text-muted-foreground" />
              </div>
              <div className="rounded px-1.5 py-0.5 text-muted-foreground tabular-nums text-xs">
                +{formatCashMoney(amountNum, form.currency)} incoming
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Confirmation checkbox */}
      <label
        className="flex items-start gap-2 rounded-lg border p-3 text-sm"
        data-testid="label-transfer-confirm"
      >
        <Checkbox
          checked={confirmed}
          onCheckedChange={(v) => onConfirmedChange(v === true)}
          data-testid="checkbox-transfer-confirm"
        />
        <span>
          I confirm{" "}
          <strong dir="ltr">{form.currency} {formatCashMoney(amountNum, form.currency)}</strong>{" "}
          has been counted and handed to <strong>{carrierLabel}</strong> for delivery.
        </span>
      </label>
    </div>
  );
}

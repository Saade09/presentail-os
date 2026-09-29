import { useEffect, useState } from "react";
import { useParams } from "wouter";
import { useTranslation } from "react-i18next";
import { CheckCircle2, XCircle, MessageSquareDiff, Loader2, Package, Building2, MapPin, CalendarDays, AlertTriangle, ChevronDown, ChevronUp } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";

type PoLineItem = {
  id: number;
  description: string;
  quantity: string;
  unit_price: string;
  currency: string;
  supplier_item_code: string | null;
  supplier_item_unit: string | null;
};

type PurchaseOrderPublic = {
  id: number;
  po_number_label: string;
  status: string;
  currency: string;
  grand_total_amount: string | null;
  subtotal_amount: string | null;
  discount_amount: string | null;
  delivery_fee_amount: string | null;
  vat_treatment: string | null;
  vat_rate: string | null;
  vat_amount: string | null;
  expected_delivery_date: string | null;
  notes: string | null;
  payment_terms: string | null;
  supplier_reference: string | null;
  sent_at: string | null;
  supplier_name: string | null;
  location_name: string | null;
  line_items: PoLineItem[];
};

type AcceptanceInfo = {
  id: number;
  status: string;
  is_invalidated: boolean;
  responded_at: string | null;
  responder_name: string | null;
  created_at: string;
};

function fmtAmt(val: string | null | undefined, decimals = 2): string {
  if (val == null) return "—";
  const n = parseFloat(val);
  if (isNaN(n)) return "—";
  return n.toLocaleString(undefined, { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
}

function formatDate(dateStr: string | null | undefined): string {
  if (!dateStr) return "—";
  return new Date(dateStr).toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric" });
}

export default function SupplierAcceptPage() {
  const { t } = useTranslation();
  const params = useParams<{ token: string }>();
  const token = params.token ?? "";

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [po, setPo] = useState<PurchaseOrderPublic | null>(null);
  const [acceptance, setAcceptance] = useState<AcceptanceInfo | null>(null);
  const [showItems, setShowItems] = useState(false);

  const [action, setAction] = useState<"accepted" | "declined" | "changes_requested" | null>(null);
  const [responderName, setResponderName] = useState("");
  const [responderContact, setResponderContact] = useState("");
  const [notes, setNotes] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState<"accepted" | "declined" | "changes_requested" | null>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);

  useEffect(() => {
    if (!token) return;
    setLoading(true);
    fetch(`/api/po-accept/${encodeURIComponent(token)}`)
      .then(async (r) => {
        if (!r.ok) {
          const body = await r.json().catch(() => ({}));
          throw new Error(body.error ?? `Error ${r.status}`);
        }
        return r.json();
      })
      .then((data) => {
        setPo(data.purchase_order);
        setAcceptance(data.acceptance);
      })
      .catch((err) => setError(err instanceof Error ? err.message : "Failed to load purchase order"))
      .finally(() => setLoading(false));
  }, [token]);

  async function handleSubmit() {
    if (!action) return;
    setSubmitting(true);
    setSubmitError(null);
    try {
      const r = await fetch(`/api/po-accept/${encodeURIComponent(token)}/respond`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action,
          responder_name: responderName.trim() || undefined,
          responder_contact: responderContact.trim() || undefined,
          notes: notes.trim() || undefined,
        }),
      });
      const body = await r.json();
      if (!r.ok) throw new Error(body.error ?? `Error ${r.status}`);
      setSubmitted(action);
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : "Submission failed");
    } finally {
      setSubmitting(false);
    }
  }

  if (loading) {
    return (
      <div className="min-h-screen bg-gray-50 flex items-center justify-center">
        <div className="flex items-center gap-3 text-gray-500">
          <Loader2 className="animate-spin" size={20} />
          <span>{t("supplierAccept.loading", "Loading purchase order…")}</span>
        </div>
      </div>
    );
  }

  if (error || !po || !acceptance) {
    return (
      <div className="min-h-screen bg-gray-50 flex items-center justify-center p-6">
        <div className="max-w-md w-full bg-white rounded-2xl shadow-sm border border-gray-100 p-8 text-center space-y-4">
          <div className="h-16 w-16 rounded-full bg-red-50 flex items-center justify-center mx-auto">
            <AlertTriangle className="text-red-500" size={28} />
          </div>
          <h1 className="text-xl font-semibold text-gray-900">
            {t("supplierAccept.linkNotFound", "Link not found")}
          </h1>
          <p className="text-gray-500 text-sm">
            {error ?? t("supplierAccept.linkExpired", "This acceptance link may have expired or been revoked. Please contact the sender for an updated link.")}
          </p>
        </div>
      </div>
    );
  }

  if (acceptance.is_invalidated) {
    return (
      <div className="min-h-screen bg-gray-50 flex items-center justify-center p-6">
        <div className="max-w-md w-full bg-white rounded-2xl shadow-sm border border-gray-100 p-8 text-center space-y-4">
          <div className="h-16 w-16 rounded-full bg-amber-50 flex items-center justify-center mx-auto">
            <AlertTriangle className="text-amber-500" size={28} />
          </div>
          <h1 className="text-xl font-semibold text-gray-900">
            {t("supplierAccept.linkInvalidated", "This link has been updated")}
          </h1>
          <p className="text-gray-500 text-sm">
            {t("supplierAccept.linkInvalidatedDesc", "The purchase order was modified after this link was sent. Please ask the buyer to resend it.")}
          </p>
        </div>
      </div>
    );
  }

  if (submitted) {
    return (
      <div className="min-h-screen bg-gray-50 flex items-center justify-center p-6">
        <div className="max-w-md w-full bg-white rounded-2xl shadow-sm border border-gray-100 p-8 text-center space-y-4">
          {submitted === "accepted" ? (
            <>
              <div className="h-16 w-16 rounded-full bg-teal-50 flex items-center justify-center mx-auto">
                <CheckCircle2 className="text-teal-500" size={32} />
              </div>
              <h1 className="text-xl font-semibold text-gray-900">
                {t("supplierAccept.acceptedTitle", "Order accepted!")}
              </h1>
              <p className="text-gray-500 text-sm">
                {t("supplierAccept.acceptedDesc", "Thank you for confirming. The buyer has been notified.")}
              </p>
            </>
          ) : submitted === "changes_requested" ? (
            <>
              <div className="h-16 w-16 rounded-full bg-amber-50 flex items-center justify-center mx-auto">
                <MessageSquareDiff className="text-amber-500" size={32} />
              </div>
              <h1 className="text-xl font-semibold text-gray-900">
                {t("supplierAccept.changesRequestedTitle", "Changes requested")}
              </h1>
              <p className="text-gray-500 text-sm">
                {t("supplierAccept.changesRequestedDesc", "Your request has been recorded. The buyer will review your notes and follow up with an updated order.")}
              </p>
            </>
          ) : (
            <>
              <div className="h-16 w-16 rounded-full bg-gray-100 flex items-center justify-center mx-auto">
                <XCircle className="text-gray-400" size={32} />
              </div>
              <h1 className="text-xl font-semibold text-gray-900">
                {t("supplierAccept.declinedTitle", "Order declined")}
              </h1>
              <p className="text-gray-500 text-sm">
                {t("supplierAccept.declinedDesc", "Your response has been recorded. The buyer will be in touch.")}
              </p>
            </>
          )}
        </div>
      </div>
    );
  }

  if (acceptance.status !== "pending") {
    return (
      <div className="min-h-screen bg-gray-50 flex items-center justify-center p-6">
        <div className="max-w-md w-full bg-white rounded-2xl shadow-sm border border-gray-100 p-8 text-center space-y-4">
          <div className={`h-16 w-16 rounded-full flex items-center justify-center mx-auto ${
            acceptance.status === "accepted" ? "bg-green-50" :
            acceptance.status === "changes_requested" ? "bg-amber-50" : "bg-gray-100"
          }`}>
            {acceptance.status === "accepted" ? (
              <CheckCircle2 className="text-green-500" size={32} />
            ) : acceptance.status === "changes_requested" ? (
              <MessageSquareDiff className="text-amber-500" size={32} />
            ) : (
              <XCircle className="text-gray-400" size={32} />
            )}
          </div>
          <h1 className="text-xl font-semibold text-gray-900">
            {acceptance.status === "accepted"
              ? t("supplierAccept.alreadyAccepted", "Order already accepted")
              : acceptance.status === "changes_requested"
              ? t("supplierAccept.alreadyChangesRequested", "Changes already requested")
              : t("supplierAccept.alreadyDeclined", "Order already declined")}
          </h1>
          <p className="text-gray-500 text-sm">
            {t("supplierAccept.alreadyResponded", "You have already responded to this purchase order on {{date}}.", {
              date: formatDate(acceptance.responded_at),
            })}
          </p>
        </div>
      </div>
    );
  }

  const subtotal = po.subtotal_amount ?? null;
  const vatAmt = po.vat_amount ?? null;
  const grandTotal = po.grand_total_amount ?? null;

  return (
    <div className="min-h-screen bg-gray-50 py-10 px-4">
      <div className="max-w-2xl mx-auto space-y-6">
        {/* Header card */}
        <div className="bg-white rounded-2xl shadow-sm border border-gray-100 overflow-hidden">
          <div className="bg-gradient-to-r from-teal-600 to-teal-700 px-6 py-5">
            <p className="text-teal-200 text-xs font-medium uppercase tracking-wider mb-1">
              {t("supplierAccept.purchaseOrder", "Purchase Order")}
            </p>
            <h1 className="text-white text-2xl font-bold font-mono">{po.po_number_label}</h1>
            {po.sent_at && (
              <p className="text-teal-200 text-xs mt-1">
                {t("supplierAccept.sentOn", "Sent {{date}}", { date: formatDate(po.sent_at) })}
              </p>
            )}
          </div>

          <div className="p-6 space-y-4">
            <div className="grid grid-cols-2 gap-4 text-sm">
              {po.supplier_name && (
                <div className="flex items-start gap-2">
                  <Building2 size={15} className="text-gray-400 mt-0.5 shrink-0" />
                  <div>
                    <p className="text-xs text-gray-400 mb-0.5">{t("supplierAccept.from", "From")}</p>
                    <p className="font-medium text-gray-800">{po.supplier_name}</p>
                  </div>
                </div>
              )}
              {po.location_name && (
                <div className="flex items-start gap-2">
                  <MapPin size={15} className="text-gray-400 mt-0.5 shrink-0" />
                  <div>
                    <p className="text-xs text-gray-400 mb-0.5">{t("supplierAccept.location", "Location")}</p>
                    <p className="font-medium text-gray-800">{po.location_name}</p>
                  </div>
                </div>
              )}
              {po.expected_delivery_date && (
                <div className="flex items-start gap-2">
                  <CalendarDays size={15} className="text-gray-400 mt-0.5 shrink-0" />
                  <div>
                    <p className="text-xs text-gray-400 mb-0.5">{t("supplierAccept.expectedDelivery", "Expected Delivery")}</p>
                    <p className="font-medium text-gray-800">{formatDate(po.expected_delivery_date)}</p>
                  </div>
                </div>
              )}
              {po.payment_terms && (
                <div className="flex items-start gap-2">
                  <div className="w-[15px] shrink-0" />
                  <div>
                    <p className="text-xs text-gray-400 mb-0.5">{t("supplierAccept.paymentTerms", "Payment Terms")}</p>
                    <p className="font-medium text-gray-800">{po.payment_terms}</p>
                  </div>
                </div>
              )}
            </div>

            {po.notes && (
              <div className="rounded-lg bg-gray-50 border border-gray-100 px-4 py-3 text-sm text-gray-600">
                <p className="text-xs font-medium text-gray-400 mb-1">{t("supplierAccept.notes", "Notes")}</p>
                <p className="whitespace-pre-wrap">{po.notes}</p>
              </div>
            )}
          </div>
        </div>

        {/* Line items */}
        <div className="bg-white rounded-2xl shadow-sm border border-gray-100 overflow-hidden">
          <button
            type="button"
            className="w-full flex items-center justify-between px-6 py-4 text-left"
            onClick={() => setShowItems((v) => !v)}
          >
            <div className="flex items-center gap-2">
              <Package size={16} className="text-gray-400" />
              <span className="font-semibold text-gray-800 text-sm">
                {t("supplierAccept.lineItems", "Line Items")} ({po.line_items.length})
              </span>
            </div>
            {showItems ? <ChevronUp size={16} className="text-gray-400" /> : <ChevronDown size={16} className="text-gray-400" />}
          </button>

          {showItems && (
            <div className="border-t border-gray-100">
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="bg-gray-50 border-b border-gray-100">
                      <th className="text-left px-4 py-2.5 text-xs font-medium text-gray-500">{t("supplierAccept.item", "Item")}</th>
                      <th className="text-right px-4 py-2.5 text-xs font-medium text-gray-500">{t("supplierAccept.qty", "Qty")}</th>
                      <th className="text-right px-4 py-2.5 text-xs font-medium text-gray-500">{t("supplierAccept.unitPrice", "Unit Price")}</th>
                      <th className="text-right px-4 py-2.5 text-xs font-medium text-gray-500">{t("supplierAccept.total", "Total")}</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-50">
                    {po.line_items.map((li) => {
                      const qty = parseFloat(li.quantity);
                      const price = parseFloat(li.unit_price);
                      const lineTotal = !isNaN(qty) && !isNaN(price) ? qty * price : null;
                      return (
                        <tr key={li.id} className="hover:bg-gray-50/50">
                          <td className="px-4 py-3">
                            <p className="font-medium text-gray-800">{li.description}</p>
                            {li.supplier_item_code && (
                              <p className="text-xs text-gray-400 font-mono">{li.supplier_item_code}</p>
                            )}
                          </td>
                          <td className="px-4 py-3 text-right text-gray-700">
                            {fmtAmt(li.quantity, 0)}{li.supplier_item_unit ? ` ${li.supplier_item_unit}` : ""}
                          </td>
                          <td className="px-4 py-3 text-right text-gray-700 whitespace-nowrap">
                            {po.currency} {fmtAmt(li.unit_price)}
                          </td>
                          <td className="px-4 py-3 text-right font-medium text-gray-800 whitespace-nowrap">
                            {lineTotal != null ? `${po.currency} ${fmtAmt(String(lineTotal))}` : "—"}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>

              {/* Cost summary */}
              <div className="border-t border-gray-100 px-6 py-4 space-y-1.5 text-sm">
                {subtotal && (
                  <div className="flex justify-between text-gray-600">
                    <span>{t("supplierAccept.subtotal", "Subtotal")}</span>
                    <span>{po.currency} {fmtAmt(subtotal)}</span>
                  </div>
                )}
                {po.discount_amount && parseFloat(po.discount_amount) > 0 && (
                  <div className="flex justify-between text-red-600">
                    <span>{t("supplierAccept.discount", "Discount")}</span>
                    <span>− {po.currency} {fmtAmt(po.discount_amount)}</span>
                  </div>
                )}
                {po.delivery_fee_amount && parseFloat(po.delivery_fee_amount) > 0 && (
                  <div className="flex justify-between text-gray-600">
                    <span>{t("supplierAccept.deliveryFee", "Delivery Fee")}</span>
                    <span>+ {po.currency} {fmtAmt(po.delivery_fee_amount)}</span>
                  </div>
                )}
                {vatAmt && po.vat_treatment !== "no_vat" && (
                  <div className="flex justify-between text-gray-600">
                    <span>
                      {t("supplierAccept.vat", "VAT")} ({po.vat_rate ?? "0"}%
                      {po.vat_treatment === "vat_inclusive" ? ` ${t("supplierAccept.incl", "incl.")}` : ""})
                    </span>
                    <span>
                      {po.vat_treatment === "vat_inclusive" ? `${t("supplierAccept.incl", "incl.")} ` : "+ "}
                      {po.currency} {fmtAmt(vatAmt)}
                    </span>
                  </div>
                )}
                {grandTotal && (
                  <div className="flex justify-between font-semibold text-gray-900 pt-2 border-t border-gray-100">
                    <span>{t("supplierAccept.grandTotal", "Grand Total")}</span>
                    <span>{po.currency} {fmtAmt(grandTotal)}</span>
                  </div>
                )}
              </div>
            </div>
          )}
        </div>

        {/* Response form */}
        <div className="bg-white rounded-2xl shadow-sm border border-gray-100 p-6 space-y-5">
          <h2 className="font-semibold text-gray-900">
            {t("supplierAccept.responseTitle", "Your Response")}
          </h2>

          <div className="space-y-2">
            <button
              type="button"
              onClick={() => setAction("accepted")}
              className={cn(
                "w-full flex items-center justify-center gap-2 rounded-xl border-2 py-3.5 text-sm font-semibold transition-all",
                action === "accepted"
                  ? "border-teal-500 bg-teal-50 text-teal-700"
                  : "border-gray-200 text-gray-600 hover:border-teal-200 hover:bg-teal-50/50",
              )}
            >
              <CheckCircle2 size={18} />
              {t("supplierAccept.accept", "Accept Order")}
            </button>
            <div className="grid grid-cols-2 gap-2">
              <button
                type="button"
                onClick={() => setAction("changes_requested")}
                className={cn(
                  "flex items-center justify-center gap-2 rounded-xl border-2 py-3 text-sm font-semibold transition-all",
                  action === "changes_requested"
                    ? "border-amber-400 bg-amber-50 text-amber-700"
                    : "border-gray-200 text-gray-600 hover:border-amber-200 hover:bg-amber-50/50",
                )}
              >
                <MessageSquareDiff size={16} />
                {t("supplierAccept.changesRequested", "Request Changes")}
              </button>
              <button
                type="button"
                onClick={() => setAction("declined")}
                className={cn(
                  "flex items-center justify-center gap-2 rounded-xl border-2 py-3 text-sm font-semibold transition-all",
                  action === "declined"
                    ? "border-red-400 bg-red-50 text-red-600"
                    : "border-gray-200 text-gray-600 hover:border-red-200 hover:bg-red-50/50",
                )}
              >
                <XCircle size={16} />
                {t("supplierAccept.decline", "Decline")}
              </button>
            </div>
          </div>

          <div className="space-y-3">
            <div className="space-y-1">
              <Label className="text-sm text-gray-600">
                {t("supplierAccept.yourName", "Your Name")}
                <span className="text-gray-400 ml-1 text-xs">{t("supplierAccept.optional", "(optional)")}</span>
              </Label>
              <Input
                placeholder={t("supplierAccept.namePlaceholder", "e.g. John Smith")}
                value={responderName}
                onChange={(e) => setResponderName(e.target.value)}
              />
            </div>
            <div className="space-y-1">
              <Label className="text-sm text-gray-600">
                {t("supplierAccept.contact", "Contact / Phone")}
                <span className="text-gray-400 ml-1 text-xs">{t("supplierAccept.optional", "(optional)")}</span>
              </Label>
              <Input
                placeholder={t("supplierAccept.contactPlaceholder", "e.g. +971 50 123 4567")}
                value={responderContact}
                onChange={(e) => setResponderContact(e.target.value)}
              />
            </div>
            <div className="space-y-1">
              <Label className="text-sm text-gray-600">
                {t("supplierAccept.notesLabel", "Notes")}
                <span className="text-gray-400 ml-1 text-xs">{t("supplierAccept.optional", "(optional)")}</span>
              </Label>
              <Textarea
                placeholder={t("supplierAccept.notesPlaceholder", "Any conditions, comments, or questions…")}
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                rows={3}
              />
            </div>
          </div>

          {submitError && (
            <p className="text-sm text-red-600 bg-red-50 border border-red-100 rounded-lg px-3 py-2">
              {submitError}
            </p>
          )}

          <Button
            className="w-full"
            size="lg"
            onClick={handleSubmit}
            disabled={!action || submitting}
          >
            {submitting ? (
              <><Loader2 className="animate-spin mr-2" size={16} />{t("supplierAccept.submitting", "Submitting…")}</>
            ) : action === "accepted" ? (
              t("supplierAccept.confirmAccept", "Confirm Acceptance")
            ) : action === "declined" ? (
              t("supplierAccept.confirmDecline", "Confirm Decline")
            ) : action === "changes_requested" ? (
              t("supplierAccept.confirmChangesRequested", "Confirm Changes Request")
            ) : (
              t("supplierAccept.selectResponse", "Select a response above")
            )}
          </Button>
        </div>

        <p className="text-center text-xs text-gray-400 pb-6">
          {t("supplierAccept.poweredBy", "Powered by Presentail OS")}
        </p>
      </div>
    </div>
  );
}

import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "wouter";
import { ArrowLeft, Truck, CheckCircle2, Loader2, Plus, Trash2, PenLine, ImagePlus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { apiFetch } from "@/lib/queryClient";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "@/hooks/use-toast";
import { ContactSearchPicker, contactDisplayName } from "@/components/ContactSearchPicker";
import type { WizardContact } from "@/components/ContactSearchPicker";
import { imageUrl } from "@/lib/imageUrl";
import { normalizePersonName } from "@/lib/personName";

type ShelfProduct = {
  id: number;
  name: string;
  price_usd: string;
  price_aed: string;
  sku: string;
  status: string;
  main_image_url: string | null;
};

type DeliveryLineItem = {
  customMode: boolean;
  product_id: number | null;
  name: string;
  qty: number;
  unit_price: string;
  image_url?: string | null;
  description?: string | null;
};

type CreatedOrder = { id: string; display_order_number?: string };

const CURRENCIES = ["USD", "AED", "LBP", "SAR", "EUR", "GBP"];
const PAYMENT_METHODS = ["cash", "card", "bank_transfer", "whish", "stripe", "other"];

function makeBlankItem(): DeliveryLineItem {
  return { customMode: false, product_id: null, name: "", qty: 1, unit_price: "", image_url: null, description: null };
}

export default function CmcPosDelivery() {
  const { t } = useTranslation();
  const qc = useQueryClient();

  const [submitted, setSubmitted] = useState(false);
  const [createdOrder, setCreatedOrder] = useState<CreatedOrder | null>(null);

  const [selectedRecipient, setSelectedRecipient] = useState<WizardContact | null>(null);
  const [recipientName, setRecipientName] = useState("");
  const [recipientPhone, setRecipientPhone] = useState("");
  const [recipientEmail, setRecipientEmail] = useState("");
  const [recipientAddress, setRecipientAddress] = useState("");
  const [currency, setCurrency] = useState("USD");
  const [paymentMethod, setPaymentMethod] = useState("cash");
  const [notes, setNotes] = useState("");
  const [customerName, setCustomerName] = useState("");
  const [customerEmail, setCustomerEmail] = useState("");
  const [cardMessage, setCardMessage] = useState("");
  const [cardFrom, setCardFrom] = useState("");
  const [cardTo, setCardTo] = useState("");

  const [lineItems, setLineItems] = useState<DeliveryLineItem[]>([makeBlankItem()]);

  const { data: productsData } = useQuery<{ products: ShelfProduct[] }>({
    queryKey: ["cmc-pos-shelf-products"],
    queryFn: () => apiFetch<{ products: ShelfProduct[] }>("/api/cmc-pos/shelf-products", {}),
  });

  const products = productsData?.products ?? [];

  const addLineItem = () => setLineItems((prev) => [...prev, makeBlankItem()]);
  const removeLineItem = (i: number) => setLineItems((prev) => prev.filter((_, idx) => idx !== i));
  const updateLineItem = (i: number, patch: Partial<DeliveryLineItem>) =>
    setLineItems((prev) => prev.map((li, idx) => (idx === i ? { ...li, ...patch } : li)));

  const toggleCustomMode = (i: number) => {
    const li = lineItems[i];
    if (li.customMode) {
      updateLineItem(i, { customMode: false, product_id: null, name: "", unit_price: "", image_url: null, description: null });
    } else {
      updateLineItem(i, { customMode: true, product_id: null, name: "", image_url: null, description: null });
    }
  };

  const uploadDeliveryItemImage = async (i: number, file: File) => {
    updateLineItem(i, { image_url: null });
    const fd = new FormData();
    fd.append("image", file);
    try {
      const data = await apiFetch<{ url: string }>("/api/cmc-pos/upload-image", { method: "POST", body: fd });
      updateLineItem(i, { image_url: data.url });
    } catch {
      toast({ title: t("cmcPos.uploadError", "Upload failed"), variant: "destructive" });
    }
  };

  const computedTotal = lineItems.reduce((s, li) => {
    const price = parseFloat(li.unit_price) || 0;
    return s + price * li.qty;
  }, 0);

  const handleSelectContact = (contact: WizardContact | null) => {
    setSelectedRecipient(contact);
    if (contact) {
      setRecipientName(normalizePersonName(contactDisplayName(contact)) ?? "");
      setRecipientPhone(contact.phone ?? "");
      setRecipientAddress(contact.last_delivery_address ?? "");
    } else {
      setRecipientPhone("");
      setRecipientAddress("");
    }
  };

  const hasAtLeastOneItem = lineItems.some((li) => li.name.trim().length > 0);

  const createDeliveryOrder = useMutation({
    mutationFn: async () => {
      if (!recipientName || !recipientPhone) {
        throw new Error(t("cmcPos.delivery.missingFields"));
      }
      if (!hasAtLeastOneItem) {
        throw new Error(t("cmcPos.delivery.missingItems"));
      }
      return apiFetch<{ order: CreatedOrder }>("/api/cmc-pos/delivery-orders", {
        method: "POST",
        body: JSON.stringify({
           recipient_name: normalizePersonName(recipientName) ?? "",
          recipient_phone: recipientPhone,
          recipient_contact_id: selectedRecipient?.id ?? null,
          recipient_address: recipientAddress || null,
          recipient_email: recipientEmail || null,
          currency,
          payment_method: paymentMethod,
          notes: notes || null,
          line_items: lineItems
            .filter((li) => li.name.trim())
            .map((li) => ({
              product_id: li.product_id ?? null,
              name: li.name.trim(),
              quantity: li.qty,
              unit_price: li.unit_price ? parseFloat(li.unit_price) : null,
              image_url: li.image_url ?? null,
              description: li.description || null,
              is_custom_item: !li.product_id ? true : undefined,
            })),
           customer_name: normalizePersonName(customerName),
          customer_email: customerEmail || null,
          card_message: cardMessage || null,
           card_from: normalizePersonName(cardFrom),
           card_to: normalizePersonName(cardTo),
        }),
      });
    },
    onSuccess: (data) => {
      setCreatedOrder(data.order);
      setSubmitted(true);
      qc.invalidateQueries({ queryKey: ["orders"] });
    },
    onError: (err) => {
      toast({
        title: t("cmcPos.delivery.errorTitle"),
        description: err instanceof Error ? err.message : String(err),
        variant: "destructive",
      });
    },
  });

  const reset = () => {
    setSubmitted(false);
    setCreatedOrder(null);
    setSelectedRecipient(null);
    setRecipientName("");
    setRecipientPhone("");
    setRecipientEmail("");
    setRecipientAddress("");
    setCurrency("USD");
    setPaymentMethod("cash");
    setNotes("");
    setCustomerName("");
    setCustomerEmail("");
    setCardMessage("");
    setCardFrom("");
    setCardTo("");
    setLineItems([makeBlankItem()]);
  };

  if (submitted && createdOrder) {
    return (
      <div className="flex flex-col items-center justify-center gap-6 p-8 text-center min-h-[60vh]">
        <CheckCircle2 className="h-16 w-16 text-violet-500" />
        <h2 className="text-xl font-semibold">{t("cmcPos.delivery.successTitle")}</h2>
        {createdOrder.display_order_number && (
          <p className="text-muted-foreground">
            {t("cmcPos.delivery.orderNumber")}: <span className="font-mono font-medium">{createdOrder.display_order_number}</span>
          </p>
        )}
        <p className="text-muted-foreground">{t("cmcPos.delivery.successDesc")}</p>
        <div className="flex flex-col gap-3 w-full max-w-xs sm:flex-row sm:max-w-none sm:w-auto">
          <Button className="h-12 sm:h-10" onClick={reset}>{t("cmcPos.delivery.newOrder")}</Button>
          <Button variant="outline" className="h-12 sm:h-10" asChild>
            <Link href={`/orders/${createdOrder.id}`}>{t("cmcPos.delivery.viewOrder")}</Link>
          </Button>
          <Button variant="outline" className="h-12 sm:h-10" asChild>
            <Link href="/cmc-pos">{t("cmcPos.backToDashboard")}</Link>
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-5 p-4 sm:p-6">
      <div className="flex items-center gap-2">
        <Button variant="ghost" size="icon" className="h-11 w-11 shrink-0" asChild>
          <Link href="/cmc-pos"><ArrowLeft className="h-5 w-5" /></Link>
        </Button>
        <div>
          <h1 className="text-lg font-semibold sm:text-xl">{t("cmcPos.workflow3Title")}</h1>
          <p className="text-sm text-muted-foreground">{t("cmcPos.workflow3Desc")}</p>
        </div>
      </div>

      <div className="space-y-4">
        {/* Recipient section */}
        <div className="rounded-lg border p-4 space-y-4">
          <h3 className="text-sm font-medium">{t("cmcPos.delivery.recipient")}</h3>

          <div className="space-y-1.5">
            <Label className="text-xs text-muted-foreground">{t("cmcPos.delivery.contactSearchLabel")}</Label>
            <ContactSearchPicker
              mode="recipient"
              selected={selectedRecipient}
              onSelect={handleSelectContact}
              testIdPrefix="cmc-recipient"
            />
          </div>

          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label>{t("cmcPos.delivery.name")} *</Label>
               <Input className="h-11" value={recipientName} onChange={(e) => setRecipientName(e.target.value)} onBlur={() => setRecipientName(normalizePersonName(recipientName) ?? "")} placeholder={t("cmcPos.delivery.namePlaceholder")} />
            </div>
            <div className="space-y-1.5">
              <Label>{t("cmcPos.delivery.phone")} *</Label>
              <Input className="h-11" value={recipientPhone} onChange={(e) => setRecipientPhone(e.target.value)} placeholder="+961..." />
            </div>
            <div className="space-y-1.5">
              <Label>{t("cmcPos.delivery.recipientEmail")}</Label>
              <Input className="h-11" type="email" value={recipientEmail} onChange={(e) => setRecipientEmail(e.target.value)} placeholder="email@example.com" />
            </div>
            <div className="space-y-1.5">
              <Label>{t("cmcPos.delivery.address")}</Label>
              <Input className="h-11" value={recipientAddress} onChange={(e) => setRecipientAddress(e.target.value)} />
            </div>
          </div>
        </div>

        {/* Sender (customer) section */}
        <div className="rounded-lg border p-4 space-y-4">
          <h3 className="text-sm font-medium">{t("cmcPos.delivery.senderSection")}</h3>
          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label>{t("cmcPos.delivery.customerName")}</Label>
               <Input className="h-11" value={customerName} onChange={(e) => setCustomerName(e.target.value)} onBlur={() => setCustomerName(normalizePersonName(customerName) ?? "")} placeholder={t("cmcPos.delivery.namePlaceholder")} />
            </div>
            <div className="space-y-1.5">
              <Label>{t("cmcPos.delivery.customerEmail")}</Label>
              <Input className="h-11" type="email" value={customerEmail} onChange={(e) => setCustomerEmail(e.target.value)} placeholder="email@example.com" />
            </div>
          </div>
        </div>

        {/* Items section */}
        <div className="rounded-lg border p-4 space-y-4">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-medium">{t("cmcPos.delivery.items")}</h3>
            <Button size="sm" variant="outline" className="h-9" onClick={addLineItem}>
              <Plus className="me-1 h-4 w-4" />{t("cmcPos.delivery.addItem")}
            </Button>
          </div>

          <div className="space-y-3">
            {lineItems.map((li, i) => (
              <div key={i} className="rounded-md border p-3 space-y-3">
                {/* Mode toggle + product or name input */}
                <div className="space-y-1.5">
                  <div className="flex items-center justify-between">
                    <Label className="text-xs">{t("cmcPos.request.product")}</Label>
                    <Button
                      type="button"
                      size="sm"
                      variant={li.customMode ? "default" : "outline"}
                      className="h-6 px-2 text-xs"
                      onClick={() => toggleCustomMode(i)}
                    >
                      <PenLine className="me-1 h-3 w-3" />
                      {li.customMode ? t("cmcPos.customMode") : t("cmcPos.request.customProduct")}
                    </Button>
                  </div>
                  {li.customMode ? (
                    <div className="space-y-2">
                      <Input
                        className="h-10"
                        placeholder={t("cmcPos.customItemName")}
                        value={li.name}
                        onChange={(e) => updateLineItem(i, { name: e.target.value })}
                      />
                      <Textarea
                        className="min-h-[56px] resize-none text-sm"
                        placeholder={t("cmcPos.customItemDesc")}
                        value={li.description ?? ""}
                        onChange={(e) => updateLineItem(i, { description: e.target.value })}
                        rows={2}
                      />
                      <div className="flex items-center gap-2">
                        <label className="cursor-pointer">
                          <input
                            type="file"
                            accept="image/*"
                            className="sr-only"
                            onChange={(e) => {
                              const f = e.target.files?.[0];
                              if (f) uploadDeliveryItemImage(i, f);
                            }}
                          />
                          <Button type="button" size="sm" variant="outline" className="h-8 pointer-events-none">
                            <ImagePlus className="me-1 h-3.5 w-3.5" />{t("cmcPos.customItemImage")}
                          </Button>
                        </label>
                        {li.image_url && imageUrl(li.image_url) && (
                          <img src={imageUrl(li.image_url) ?? undefined} alt="" className="h-8 w-8 rounded object-cover border" />
                        )}
                      </div>
                    </div>
                  ) : (
                    <Select
                      value={li.product_id ? String(li.product_id) : ""}
                      onValueChange={(v) => {
                        const p = products.find((pr) => pr.id === parseInt(v));
                        updateLineItem(i, {
                          product_id: parseInt(v),
                          name: p?.name ?? "",
                          unit_price: p?.price_usd ?? "",
                        });
                      }}
                    >
                      <SelectTrigger className="h-10">
                        <SelectValue placeholder={t("cmcPos.request.selectProduct")} />
                      </SelectTrigger>
                      <SelectContent>
                        {products.map((p) => (
                          <SelectItem key={p.id} value={String(p.id)}>
                            <div className="flex items-center gap-2">
                              {imageUrl(p.main_image_url) ? (
                                <img src={imageUrl(p.main_image_url) ?? undefined} alt="" className="h-6 w-6 rounded object-cover shrink-0" />
                              ) : (
                                <div className="h-6 w-6 rounded bg-muted shrink-0" />
                              )}
                              <span>{p.name}</span>
                              {p.sku && <span className="text-muted-foreground text-xs">{p.sku}</span>}
                            </div>
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  )}
                </div>

                {/* Qty + unit price + trash */}
                <div className="flex items-end gap-2">
                  <div className="w-20 space-y-1.5">
                    <Label className="text-xs">{t("cmcPos.request.qty")}</Label>
                    <Input
                      type="number"
                      min="1"
                      className="h-10"
                      value={li.qty}
                      onChange={(e) => updateLineItem(i, { qty: parseInt(e.target.value) || 1 })}
                    />
                  </div>
                  <div className="flex-1 space-y-1.5">
                    <Label className="text-xs">{t("cmcPos.request.unitPrice")}</Label>
                    <Input
                      type="number"
                      min="0"
                      className="h-10"
                      placeholder="0.00"
                      value={li.unit_price}
                      onChange={(e) => updateLineItem(i, { unit_price: e.target.value })}
                    />
                  </div>
                  {lineItems.length > 1 && (
                    <Button
                      size="icon"
                      variant="ghost"
                      className="h-10 w-10 text-destructive shrink-0"
                      onClick={() => removeLineItem(i)}
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  )}
                </div>
              </div>
            ))}
          </div>

          {/* Computed total + currency */}
          <div className="flex items-center justify-between rounded-md bg-muted/50 px-3 py-2 gap-3">
            <span className="text-sm font-medium">{t("cmcPos.delivery.computedTotal")}</span>
            <div className="flex items-center gap-2 shrink-0">
              <span className="font-semibold text-violet-700">
                {computedTotal.toFixed(2)}
              </span>
              <Select value={currency} onValueChange={setCurrency}>
                <SelectTrigger className="h-8 w-24">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {CURRENCIES.map((c) => (
                    <SelectItem key={c} value={c}>{c}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
        </div>

        {/* Card message section */}
        <div className="rounded-lg border p-4 space-y-3">
          <h3 className="text-sm font-medium">{t("cmcPos.delivery.cardMessage")}</h3>
          <Textarea value={cardMessage} onChange={(e) => setCardMessage(e.target.value)} rows={2} placeholder={t("cmcPos.delivery.cardMessagePlaceholder")} />
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label className="text-xs">{t("cmcPos.delivery.cardFrom")}</Label>
               <Input className="h-10" value={cardFrom} onChange={(e) => setCardFrom(e.target.value)} onBlur={() => setCardFrom(normalizePersonName(cardFrom) ?? "")} />
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">{t("cmcPos.delivery.cardTo")}</Label>
               <Input className="h-10" value={cardTo} onChange={(e) => setCardTo(e.target.value)} onBlur={() => setCardTo(normalizePersonName(cardTo) ?? "")} />
            </div>
          </div>
        </div>

        {/* Payment section */}
        <div className="rounded-lg border p-4 space-y-4">
          <h3 className="text-sm font-medium">{t("cmcPos.delivery.payment")}</h3>
          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label>{t("cmcPos.sale.paymentMethod")}</Label>
              <Select value={paymentMethod} onValueChange={setPaymentMethod}>
                <SelectTrigger className="h-11"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {PAYMENT_METHODS.map((m) => (
                    <SelectItem key={m} value={m}>{t(`cmcPos.sale.pm.${m}`)}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label>{t("cmcPos.sale.notes")}</Label>
              <Textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={2} placeholder={t("cmcPos.sale.notesPlaceholder")} />
            </div>
          </div>
        </div>

        <Button
          className="w-full h-12 bg-violet-600 hover:bg-violet-700 text-base font-semibold"
          disabled={!recipientName || !recipientPhone || !hasAtLeastOneItem || createDeliveryOrder.isPending}
          onClick={() => createDeliveryOrder.mutate()}
        >
          {createDeliveryOrder.isPending ? <Loader2 className="me-2 h-4 w-4 animate-spin" /> : <Truck className="me-2 h-5 w-5" />}
          {t("cmcPos.delivery.createOrder")}
        </Button>
      </div>
    </div>
  );
}

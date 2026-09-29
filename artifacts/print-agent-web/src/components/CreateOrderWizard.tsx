import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useAuth } from "@clerk/react";
import {
  Loader2,
  Search,
  Trash2,
  Plus,
  Minus,
  Check,
  ChevronRight,
  User,
  Gift,
  MapPin,
  ShoppingBag,
  ClipboardList,
  CalendarIcon,
  Package,
  ImageIcon,
  MessageSquare,
} from "lucide-react";
import { format } from "date-fns";
import { useQuery } from "@tanstack/react-query";
import { useCreateManualOrder } from "@workspace/api-client-react";
import type { CreateOrderInput } from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Calendar } from "@/components/ui/calendar";
import { TimePicker } from "@/components/ui/time-picker";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { useToast } from "@/hooks/use-toast";
import { apiFetch } from "@/lib/queryClient";
import {
  fallbackToOriginalProductImage,
  imageUrl,
  productImageUrl,
} from "@/lib/imageUrl";
import { cn } from "@/lib/utils";
import {
  ContactSearchPicker,
  contactDisplayName,
  type WizardContact,
} from "@/components/ContactSearchPicker";
import { Switch } from "@/components/ui/switch";
import { CountryCombobox } from "@/components/CountryCombobox";
import { COUNTRY_CATALOGUE, findCountryByName } from "@/lib/countries";
import { normalizePersonName } from "@/lib/personName";
import { calculateCityDeliveryFee } from "@/lib/cityDeliveryPricing";

type ProductRow = {
  id: number;
  name: string;
  price_usd: string;
  price_aed: string;
  main_image_url: string | null;
  main_image_display_url?: string | null;
  main_image_thumbnail_url?: string | null;
  status: string;
  sku: string | null;
  has_input_field: boolean;
  letter_input_enabled: boolean;
};

export function CreateOrderProductThumbnail({
  product,
  eager = false,
}: {
  product: ProductRow;
  eager?: boolean;
}) {
  const source = productImageUrl(product, "thumbnail");
  if (!source) return null;
  return (
    <img
      src={source}
      alt=""
      width={36}
      height={36}
      loading={eager ? "eager" : "lazy"}
      decoding="async"
      onError={(event) =>
        fallbackToOriginalProductImage(event.currentTarget, product.main_image_url)
      }
      className="h-full w-full object-cover"
    />
  );
}

function hasPersonalization(product: ProductRow): boolean {
  return Boolean(product.has_input_field || product.letter_input_enabled);
}

type ProductsResponse = {
  products: ProductRow[];
  total: number;
};

type CatalogLine = {
  kind: "catalog";
  product: ProductRow;
  quantity: number;
  custom_input: string;
};

type CustomLine = {
  kind: "custom";
  id: string;
  name: string;
  unit_price: number;
  quantity: number;
  production_instructions: string;
  image_url: string | null;
};

type CartLine = CatalogLine | CustomLine;

const CURRENCIES = ["USD", "AED", "EUR", "GBP", "SAR"] as const;
type Currency = (typeof CURRENCIES)[number];

const PAYMENT_METHODS = ["cash_on_delivery", "payment_link", "whish", "money_transfer"] as const;
const ORDER_SOURCES = ["manual", "whatsapp", "instagram", "phone", "walkin", "website", "other"] as const;
const ORDER_STATUSES = ["pending", "processing"] as const;

const TOTAL_STEPS = 6;

// Build a human-readable time-slot label (e.g. "9:00 AM – 12:00 PM") from a
// window start/end ISO pair, mirroring the Orders page Reschedule dialog's
// `delivery_address.slot` text. Returns "" when no valid start time exists.
function formatSlotRange(startIso: string | null, endIso: string | null): string {
  if (!startIso) return "";
  const start = new Date(startIso);
  if (Number.isNaN(start.getTime())) return "";
  const fmt = (d: Date) =>
    d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  const startLabel = fmt(start);
  if (!endIso) return startLabel;
  const end = new Date(endIso);
  if (Number.isNaN(end.getTime())) return startLabel;
  return `${startLabel} – ${fmt(end)}`;
}

// Combine a chosen day + `HH:mm` local time into an ISO timestamp (local time
// zone). Returns null when no day is chosen or the result is invalid.
function combineDayAndTime(date: Date | undefined, time: string): string | null {
  if (!date) return null;
  const pad = (n: number) => String(n).padStart(2, "0");
  const dateStr = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  const timeStr = time && time.includes(":") ? time : "00:00";
  const d = new Date(`${dateStr}T${timeStr}`);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString();
}

function unitPriceFor(product: ProductRow, currency: Currency): number {
  const raw = currency === "AED" ? product.price_aed : product.price_usd;
  const n = Number(raw);
  return Number.isFinite(n) ? n : 0;
}

function nativeCurrencyFor(currency: Currency): "AED" | "USD" {
  return currency === "AED" ? "AED" : "USD";
}

export type WizardContactPrefill = {
  name?: string | null;
  email?: string | null;
  phone?: string | null;
};

export function CreateOrderWizard({
  open,
  onOpenChange,
  onCreated,
  initialCustomer,
  initialRecipient,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated?: (orderId: string) => void;
  /** Prefill the customer step (e.g. from a contact profile). */
  initialCustomer?: WizardContactPrefill;
  /** Prefill the recipient step; also unchecks "same as customer". */
  initialRecipient?: WizardContactPrefill;
}) {
  const { t } = useTranslation();
  const { toast } = useToast();
  const { userId } = useAuth();

  const [step, setStep] = useState(1);
  const [attemptedNext, setAttemptedNext] = useState(false);

  // Step 1 — customer (search-first; legacy free-text state only backs the
  // prefill path from ContactProfile, which has no contact id).
  const [selectedCustomer, setSelectedCustomer] = useState<WizardContact | null>(null);
  const [custName, setCustName] = useState("");
  const [custEmail, setCustEmail] = useState("");
  const [custPhone, setCustPhone] = useState("");

  // Step 2 — recipient
  const [sameAsCustomer, setSameAsCustomer] = useState(false);
  const [selectedRecipient, setSelectedRecipient] = useState<WizardContact | null>(null);
  const [recName, setRecName] = useState("");
  const [recPhone, setRecPhone] = useState("");
  const [deliveryAddress, setDeliveryAddress] = useState("");
  const [deliveryInstructions, setDeliveryInstructions] = useState("");
  const [collectAddressLater, setCollectAddressLater] = useState(false);
  const [collectAddressLanguage, setCollectAddressLanguage] = useState<"en" | "ar">("en");

  // Step 3 — country & city
  const [deliveryCountryCode, setDeliveryCountryCode] = useState("");
  const [deliveryCitySlug, setDeliveryCitySlug] = useState("");

  // Step 3 — products
  const [productSearch, setProductSearch] = useState("");
  const [productStatusFilter, setProductStatusFilter] = useState<"available" | "out_of_stock" | "">("");
  const [productCategoryFilter, setProductCategoryFilter] = useState<string>("");
  const [productOccasionFilter, setProductOccasionFilter] = useState<string>("");

  type CityRow = {
    slug: string;
    name: string;
    country: string;
    country_code: string;
    delivery_fee: string;
    free_delivery_enabled: boolean;
    free_delivery_threshold: string | null;
    currency: Currency;
  };
  type CitiesResponse = { cities: CityRow[]; countries: string[] };

  const citiesQuery = useQuery({
    queryKey: ["wizard-cities"],
    enabled: open && step === 3,
    queryFn: () => apiFetch<CitiesResponse>("/api/cities"),
  });

  const categoriesQuery = useQuery({
    queryKey: ["catalog-categories"],
    enabled: open && step === 4,
    queryFn: () => apiFetch<Array<{ id: number; name: string; slug: string }>>("/api/catalog-attributes/categories"),
  });
  const occasionsQuery = useQuery({
    queryKey: ["catalog-occasions"],
    enabled: open && step === 4,
    queryFn: () => apiFetch<Array<{ id: number; name: string; slug: string }>>("/api/catalog-attributes/occasions"),
  });

  // Custom item form
  const [showCustomForm, setShowCustomForm] = useState(false);
  const [customName, setCustomName] = useState("");
  const [customPrice, setCustomPrice] = useState("");
  const [customQty, setCustomQty] = useState(1);
  const [customInstructions, setCustomInstructions] = useState("");
  const [customImageUrl, setCustomImageUrl] = useState<string | null>(null);
  const [customImageUploading, setCustomImageUploading] = useState(false);
  const customImageInputRef = useRef<HTMLInputElement>(null);
  const [cart, setCart] = useState<CartLine[]>([]);

  // Step 4 — details
  const [currency, setCurrency] = useState<Currency>("USD");
  const [source, setSource] = useState<string>("manual");
  const [status, setStatus] = useState<string>("pending");
  const [paymentMethod, setPaymentMethod] = useState<string>("cash_on_delivery");
  const [paymentStatus, setPaymentStatus] = useState<string>("pending");

  // Step 5 — payment link picker
  const [paymentLinkId, setPaymentLinkId] = useState<number | null>(null);
  const [paymentLinkSearch, setPaymentLinkSearch] = useState("");
  const [paymentLinkOpen, setPaymentLinkOpen] = useState(false);
  const [cardMessage, setCardMessage] = useState("");
  const [cardFrom, setCardFrom] = useState("");
  const [cardTo, setCardTo] = useState("");
  const [internalNote, setInternalNote] = useState("");

  // Step 4 — delivery window (optional; free date/time entry like Reschedule)
  const [deliveryDay, setDeliveryDay] = useState<Date | undefined>(undefined);
  const [deliveryStartTime, setDeliveryStartTime] = useState("");
  const [deliveryEndTime, setDeliveryEndTime] = useState("");
  const [deliveryDayOpen, setDeliveryDayOpen] = useState(false);

  const productsQuery = useQuery({
    queryKey: ["create-order-products", productSearch, productStatusFilter, productCategoryFilter, productOccasionFilter],
    enabled: open && step === 4,
    queryFn: () => {
      const params = new URLSearchParams();
      if (productSearch.trim()) params.set("q", productSearch.trim());
      if (productStatusFilter) params.set("status", productStatusFilter);
      if (productCategoryFilter) params.set("category", productCategoryFilter);
      if (productOccasionFilter) params.set("occasion", productOccasionFilter);
      params.set("page", "1");
      params.set("pageSize", "100");
      return apiFetch<ProductsResponse>(`/api/order-catalog/products?${params.toString()}`);
    },
  });

  type PaymentLinkOption = {
    id: number;
    amount: number;
    currency: string;
    description: string | null;
    status: "active" | "paid" | "expired";
    public_token: string;
    sender_first_name?: string | null;
    sender_last_name?: string | null;
    order_id?: string | null;
  };

  const paymentLinksQuery = useQuery({
    queryKey: ["wizard-payment-links"],
    enabled: open && step === 5,
    queryFn: () =>
      apiFetch<{ payment_links: PaymentLinkOption[] }>("/api/payment-links"),
  });

  const filteredPaymentLinks = useMemo(() => {
    const all = paymentLinksQuery.data?.payment_links ?? [];
    const q = paymentLinkSearch.trim().toLowerCase();
    if (!q) return all;
    return all.filter((pl) => {
      const desc = (pl.description ?? "").toLowerCase();
      const name = [pl.sender_first_name, pl.sender_last_name]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
      const amount = (pl.amount / 100).toFixed(2);
      return desc.includes(q) || name.includes(q) || amount.includes(q);
    });
  }, [paymentLinksQuery.data, paymentLinkSearch]);

  const selectedPaymentLink = useMemo(
    () =>
      paymentLinksQuery.data?.payment_links?.find((pl) => pl.id === paymentLinkId) ?? null,
    [paymentLinksQuery.data, paymentLinkId],
  );

  const createMut = useCreateManualOrder();

  useEffect(() => {
    if (!open) return;
    if (initialCustomer) {
      setCustName(normalizePersonName(initialCustomer.name) ?? "");
      setCustEmail(initialCustomer.email ?? "");
      setCustPhone(initialCustomer.phone ?? "");
    }
    if (initialRecipient) {
      setSameAsCustomer(false);
      setRecName(normalizePersonName(initialRecipient.name) ?? "");
      setRecPhone(initialRecipient.phone ?? "");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const resetAll = () => {
    setStep(1);
    setSelectedCustomer(null);
    setCustName("");
    setCustEmail("");
    setCustPhone("");
    setSameAsCustomer(false);
    setSelectedRecipient(null);
    setRecName("");
    setRecPhone("");
    setDeliveryAddress("");
    setDeliveryInstructions("");
    setDeliveryCountryCode("");
    setDeliveryCitySlug("");
    setCollectAddressLater(false);
    setProductSearch("");
    setProductStatusFilter("");
    setProductCategoryFilter("");
    setProductOccasionFilter("");
    setCart([]);
    resetCustomForm();
    setCurrency("USD");
    setSource("manual");
    setStatus("pending");
    setPaymentMethod("cash_on_delivery");
    setPaymentStatus("pending");
    setPaymentLinkId(null);
    setPaymentLinkSearch("");
    setPaymentLinkOpen(false);
    setCardMessage("");
    setCardFrom("");
    setCardTo("");
    setInternalNote("");
    setDeliveryDay(undefined);
    setDeliveryStartTime("");
    setDeliveryEndTime("");
    setDeliveryDayOpen(false);
  };

  const handleOpenChange = (next: boolean) => {
    if (!next && createMut.isPending) return;
    if (!next) resetAll();
    onOpenChange(next);
  };

  const addToCart = (product: ProductRow) => {
    setCart((prev) => {
      const existing = prev.find((l) => l.kind === "catalog" && l.product.id === product.id);
      if (existing) {
        return prev.map((l) =>
          l.kind === "catalog" && l.product.id === product.id
            ? { ...l, quantity: l.quantity + 1 }
            : l,
        );
      }
      return [...prev, { kind: "catalog", product, quantity: 1, custom_input: "" }];
    });
  };

  const setQty = (productId: number, delta: number) => {
    setCart((prev) =>
      prev
        .map((l) =>
          l.kind === "catalog" && l.product.id === productId
            ? { ...l, quantity: Math.max(0, l.quantity + delta) }
            : l,
        )
        .filter((l) => l.quantity > 0),
    );
  };

  const setCustomLineQty = (id: string, delta: number) => {
    setCart((prev) =>
      prev
        .map((l) =>
          l.kind === "custom" && l.id === id
            ? { ...l, quantity: Math.max(0, l.quantity + delta) }
            : l,
        )
        .filter((l) => l.quantity > 0),
    );
  };

  const setCustomInput = (productId: number, value: string) => {
    setCart((prev) =>
      prev.map((l) =>
        l.kind === "catalog" && l.product.id === productId ? { ...l, custom_input: value } : l,
      ),
    );
  };

  const removeLine = (productId: number) =>
    setCart((prev) =>
      prev.filter((l) => !(l.kind === "catalog" && l.product.id === productId)),
    );

  const removeCustomLine = (id: string) =>
    setCart((prev) => prev.filter((l) => !(l.kind === "custom" && l.id === id)));

  const resetCustomForm = () => {
    setShowCustomForm(false);
    setCustomName("");
    setCustomPrice("");
    setCustomQty(1);
    setCustomInstructions("");
    setCustomImageUrl(null);
    if (customImageInputRef.current) customImageInputRef.current.value = "";
  };

  const addCustomItem = () => {
    const name = customName.trim();
    const price = Math.max(0, parseFloat(customPrice) || 0);
    const instructions = customInstructions.trim();
    if (!name || price <= 0 || !instructions) return;
    const newLine: CustomLine = {
      kind: "custom",
      id: `custom-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      name,
      unit_price: price,
      quantity: Math.max(1, customQty),
      production_instructions: customInstructions.trim(),
      image_url: customImageUrl,
    };
    setCart((prev) => [...prev, newLine]);
    resetCustomForm();
  };

  const handleCustomImageUpload = async (file: File) => {
    setCustomImageUploading(true);
    try {
      const formData = new FormData();
      formData.append("image", file);
      const res = await fetch("/api/products/upload-image", {
        method: "POST",
        body: formData,
        credentials: "include",
      });
      if (res.ok) {
        const data = (await res.json()) as { url?: string };
        setCustomImageUrl(data.url ?? null);
      }
    } catch {
      // silently ignore upload errors
    } finally {
      setCustomImageUploading(false);
    }
  };

  const subtotal = useMemo(
    () =>
      cart.reduce((s, l) => {
        if (l.kind === "catalog") return s + unitPriceFor(l.product, currency) * l.quantity;
        return s + l.unit_price * l.quantity;
      }, 0),
    [cart, currency],
  );
  const selectedCity = useMemo(
    () => (citiesQuery.data?.cities ?? []).find((city) => city.slug === deliveryCitySlug) ?? null,
    [citiesQuery.data, deliveryCitySlug],
  );
  const deliveryFee = useMemo(
    () => calculateCityDeliveryFee(selectedCity, subtotal, currency),
    [currency, selectedCity, subtotal],
  );
  const grandTotal = subtotal + deliveryFee;

  // Selecting a different customer invalidates a recipient chosen in that
  // customer's context (saved-recipient metadata no longer applies).
  const handleSelectCustomer = (c: WizardContact | null) => {
    const normalized = c
      ? {
          ...c,
          first_name: normalizePersonName(c.first_name),
          last_name: normalizePersonName(c.last_name),
          display_name: normalizePersonName(c.display_name),
        }
      : null;
    setSelectedCustomer((prev) => {
      if (prev?.id !== normalized?.id) setSelectedRecipient(null);
      return normalized;
    });
  };

  const handleSelectRecipient = (c: WizardContact | null) => {
    setSelectedRecipient(
      c
        ? {
            ...c,
            first_name: normalizePersonName(c.first_name),
            last_name: normalizePersonName(c.last_name),
            display_name: normalizePersonName(c.display_name),
          }
        : null,
    );
  };

  // Per-step validation
  const customerValid =
    selectedCustomer != null || custName.trim().length > 0 || custPhone.trim().length > 0;
  const recipientValid =
    sameAsCustomer ||
    selectedRecipient != null ||
    recName.trim().length > 0 ||
    recPhone.trim().length > 0;
  const productsValid = cart.length > 0;
  // When "collect address later" is on we message the recipient over WhatsApp,
  // so both a recipient first name and phone number are required. Resolve them
  // from the linked contact (recipient, or customer when "same as customer") or
  // the free-text recipient fields.
  const effectiveRecipientName = sameAsCustomer
    ? normalizePersonName(selectedCustomer?.display_name ?? custName) ?? ""
    : normalizePersonName(selectedRecipient?.display_name ?? recName) ?? "";
  const effectiveRecipientPhone = sameAsCustomer
    ? (selectedCustomer?.phone ?? custPhone).trim()
    : (selectedRecipient?.phone ?? recPhone).trim();
  const collectAddressValid =
    !collectAddressLater ||
    (effectiveRecipientName.length > 0 && effectiveRecipientPhone.length > 0);
  // Delivery window is optional, but when a day + both times are chosen the
  // end must not be before the start (same rule as the Reschedule dialog).
  const windowStartIso = combineDayAndTime(deliveryDay, deliveryStartTime);
  const windowEndIso = deliveryDay && deliveryEndTime
    ? combineDayAndTime(deliveryDay, deliveryEndTime)
    : null;
  const windowValid =
    !windowStartIso ||
    !windowEndIso ||
    new Date(windowEndIso).getTime() >= new Date(windowStartIso).getTime();
  const isPastDeliveryDay = !!deliveryDay && (() => {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const day = new Date(deliveryDay);
    day.setHours(0, 0, 0, 0);
    return day.getTime() < today.getTime();
  })();
  const stepValid = useMemo(() => {
    switch (step) {
      case 1:
        return customerValid;
      case 2:
        return recipientValid;
      case 3:
        return windowValid;
      case 4:
        return productsValid;
      case 5:
        return true;
      default:
        return true;
    }
  }, [step, customerValid, recipientValid, productsValid, windowValid]);

  const goNext = () => {
    if (!stepValid) {
      setAttemptedNext(true);
      return;
    }
    setAttemptedNext(false);
    setStep((s) => Math.min(s + 1, TOTAL_STEPS));
  };
  const goBack = () => {
    setAttemptedNext(false);
    setStep((s) => Math.max(s - 1, 1));
  };

  const buildPayload = (paymentLinkConfirmation?: {
    reassignment: boolean;
    mismatch: boolean;
  }): CreateOrderInput & {
    collect_address?: boolean;
    preferred_language?: "en" | "ar";
    confirm_payment_link_reassignment?: boolean;
    confirm_payment_link_mismatch?: boolean;
  } => {
    // Customer: prefer a linked contact id; fall back to free-text fields
    // (prefill path) which the server upserts into the contact pool.
    const customer: CreateOrderInput["customer"] = selectedCustomer
      ? { contact_id: selectedCustomer.id }
      : {
          display_name: normalizePersonName(custName),
          email: custEmail.trim() || null,
          phone: custPhone.trim() || null,
        };
    let recipient: CreateOrderInput["recipient"] = null;
    if (sameAsCustomer) {
      // "Customer is also the recipient" — link the same contact, no new row.
      recipient = selectedCustomer ? { contact_id: selectedCustomer.id } : null;
    } else if (selectedRecipient) {
      recipient = { contact_id: selectedRecipient.id };
    } else if (recName.trim() || recPhone.trim()) {
      recipient = { display_name: normalizePersonName(recName), phone: recPhone.trim() || null };
    }
    // Delivery window: mirror the Reschedule dialog — store the timestamps and
    // reflect the date + slot label in the delivery address metadata so the
    // Orders list shows the correct delivery date/time immediately.
    const address: Record<string, unknown> = {};
    if (deliveryAddress.trim()) address.address = deliveryAddress.trim();
    if (deliveryCountryCode) address.countryCode = deliveryCountryCode;
    if (deliveryCitySlug) address.cityId = deliveryCitySlug;
    if (windowStartIso) {
      const startDate = new Date(windowStartIso);
      const pad = (n: number) => String(n).padStart(2, "0");
      address.date = `${startDate.getFullYear()}-${pad(startDate.getMonth() + 1)}-${pad(startDate.getDate())}`;
      const slot = formatSlotRange(windowStartIso, windowEndIso);
      if (slot) address.slot = slot;
    }
    return {
      source,
      status: status as CreateOrderInput["status"],
      customer,
      recipient,
      line_items: cart.map((l) => {
        if (l.kind === "catalog") {
          return {
            product_id: l.product.id,
            sku: l.product.sku ?? null,
            name: l.product.name,
            quantity: l.quantity,
            unit_price: unitPriceFor(l.product, currency),
            image_url: l.product.main_image_url ?? null,
            custom_input: l.custom_input.trim() ? l.custom_input.trim() : null,
            is_custom_item: false,
            production_instructions: null,
            custom_item_created_by: null,
          };
        }
        return {
          product_id: null,
          sku: null,
          name: l.name,
          quantity: l.quantity,
          unit_price: l.unit_price,
          image_url: l.image_url,
          custom_input: null,
          is_custom_item: true,
          production_instructions: l.production_instructions || null,
          custom_item_created_by: userId ?? null,
        };
      }),
      delivery_address: Object.keys(address).length > 0 ? address : null,
      delivery_instructions: deliveryInstructions.trim() || null,
      window_start: windowStartIso,
      window_end: windowEndIso,
      card_message: cardMessage.trim() || null,
      card_from: normalizePersonName(cardFrom),
      card_to: normalizePersonName(cardTo),
      totals: { subtotal, shipping: deliveryFee, delivery_fee: deliveryFee, total: grandTotal, currency },
      payment: { method: paymentMethod, status: paymentStatus, currency },
      notes: internalNote.trim() ? { internal_note: internalNote.trim() } : null,
      payment_link_id: paymentLinkId ?? undefined,
      confirm_payment_link_reassignment: paymentLinkConfirmation?.reassignment || undefined,
      confirm_payment_link_mismatch: paymentLinkConfirmation?.mismatch || undefined,
      collect_address: collectAddressLater,
      preferred_language: collectAddressLanguage,
    };
  };

  const handleSubmit = () => {
    if (!customerValid || !productsValid || !windowValid) return;
    if (!collectAddressValid) {
      setAttemptedNext(true);
      return;
    }
    const selectedLinkAmount = selectedPaymentLink ? selectedPaymentLink.amount / 100 : null;
    const requiresReassignment = Boolean(selectedPaymentLink?.order_id);
    const requiresMismatchConfirmation =
      selectedPaymentLink != null &&
      (selectedPaymentLink.currency.toUpperCase() !== currency.toUpperCase() ||
        (selectedLinkAmount != null && Math.abs(selectedLinkAmount - grandTotal) > 0.005));
    if (requiresReassignment || requiresMismatchConfirmation) {
      const reasons = [
        requiresReassignment ? "This payment link is currently attached to another order." : null,
        requiresMismatchConfirmation
          ? "Its amount or currency differs from this order's commercial total."
          : null,
      ]
        .filter(Boolean)
        .join(" ");
      if (!window.confirm(`${reasons} Do you want to link it to this order anyway?`)) {
        return;
      }
    }
    createMut.mutate(
      {
        data: buildPayload({
          reassignment: requiresReassignment,
          mismatch: requiresMismatchConfirmation,
        }),
      },
      {
        onSuccess: (res) => {
          toast({ title: t("orders.co.created") });
          onCreated?.(res.id);
          resetAll();
          onOpenChange(false);
        },
        onError: (err: unknown) => {
          const message =
            err != null &&
            typeof err === "object" &&
            "message" in err &&
            typeof (err as { message?: unknown }).message === "string"
              ? (err as { message: string }).message
              : t("orders.co.createError");
          toast({ title: message, variant: "destructive" });
        },
      },
    );
  };

  const stepMeta = [
    { icon: User, label: t("orders.co.stepCustomer") },
    { icon: Gift, label: t("orders.co.stepRecipient") },
    { icon: MapPin, label: t("orders.co.stepDelivery") },
    { icon: ShoppingBag, label: t("orders.co.stepProducts") },
    { icon: ClipboardList, label: t("orders.co.stepDetails") },
    { icon: MessageSquare, label: t("orders.co.stepCardMessage") },
  ];

  const fmt = (n: number) => `${currency} ${n.toFixed(2)}`;
  const nativeCurrency = nativeCurrencyFor(currency);
  const fmtCatalog = (n: number) => `${nativeCurrency} ${n.toFixed(2)}`;
  const showPricesInUsdNote = currency !== "USD" && currency !== "AED";

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent
        className={cn("p-0", step === 4 ? "max-w-5xl" : "max-w-2xl")}
        style={{ display: "grid", gridTemplateRows: "auto auto minmax(0,1fr) auto", maxHeight: "90vh" }}
      >
        <DialogHeader className="px-6 pt-6">
          <DialogTitle>{t("orders.co.title")}</DialogTitle>
        </DialogHeader>

        {/* Stepper */}
        <div className="flex items-center gap-1 px-6 pb-2">
          {stepMeta.map((m, i) => {
            const n = i + 1;
            const active = n === step;
            const done = n < step;
            const Icon = m.icon;
            return (
              <div key={m.label} className="flex items-center gap-1 flex-1">
                <div
                  className={cn(
                    "flex items-center gap-1.5 rounded-md px-2 py-1.5 text-xs font-medium w-full justify-center",
                    active && "bg-teal-700 text-white",
                    done && "bg-teal-100 text-teal-800",
                    !active && !done && "bg-muted text-muted-foreground",
                  )}
                >
                  {done ? <Check size={14} /> : <Icon size={14} />}
                  <span className="hidden sm:inline">{m.label}</span>
                </div>
                {n < stepMeta.length && <ChevronRight size={14} className="text-muted-foreground shrink-0" />}
              </div>
            );
          })}
        </div>

        {/* Body */}
        <div className="overflow-y-auto px-6 py-2 min-h-0">
          {step === 1 && (
            <div className="space-y-4">
              <p className="text-sm text-muted-foreground">{t("orders.co.customerSearchHint")}</p>
              {!selectedCustomer && (custName.trim() || custPhone.trim() || custEmail.trim()) ? (
                <div className="flex items-start justify-between gap-3 rounded-md border p-3">
                  <div className="min-w-0">
                    <p className="text-sm font-medium truncate">
                      {custName.trim() || t("orders.co.noName")}
                    </p>
                    <p className="text-xs text-muted-foreground truncate">
                      {[custPhone.trim(), custEmail.trim()].filter(Boolean).join(" · ")}
                    </p>
                  </div>
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    onClick={() => {
                      setCustName("");
                      setCustEmail("");
                      setCustPhone("");
                    }}
                  >
                    {t("orders.co.changeContact")}
                  </Button>
                </div>
              ) : (
                <ContactSearchPicker
                  mode="customer"
                  selected={selectedCustomer}
                  onSelect={handleSelectCustomer}
                  testIdPrefix="create-order-customer"
                />
              )}
              {attemptedNext && !customerValid && (
                <p role="alert" className="text-xs text-amber-600">
                  {t("orders.co.customerRequired")}
                </p>
              )}
            </div>
          )}

          {step === 2 && (
            <div className="space-y-4">
              <label className="flex items-center gap-2 text-sm font-medium cursor-pointer">
                <input
                  type="checkbox"
                  checked={sameAsCustomer}
                  onChange={(e) => setSameAsCustomer(e.target.checked)}
                  className="h-4 w-4"
                  data-testid="checkbox-create-order-same-as-customer"
                />
                {t("orders.co.sameAsCustomer")}
              </label>
              {!sameAsCustomer &&
                (recName.trim() || recPhone.trim() ? (
                  <div className="flex items-start justify-between gap-3 rounded-md border p-3">
                    <div className="min-w-0">
                      <p className="text-sm font-medium truncate">
                        {recName.trim() || t("orders.co.noName")}
                      </p>
                      {recPhone.trim() && (
                        <p className="text-xs text-muted-foreground truncate">{recPhone.trim()}</p>
                      )}
                    </div>
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      onClick={() => {
                        setRecName("");
                        setRecPhone("");
                      }}
                    >
                      {t("orders.co.changeContact")}
                    </Button>
                  </div>
                ) : (
                  <ContactSearchPicker
                    mode="recipient"
                    customerContactId={selectedCustomer?.id ?? null}
                    selected={selectedRecipient}
                    onSelect={handleSelectRecipient}
                    testIdPrefix="create-order-recipient"
                  />
                ))}
              {attemptedNext && !recipientValid && (
                <p className="text-sm text-destructive">
                  {t("orders.co.recipientRequired", "Please select a recipient or check \u201cRecipient is the same as the customer\u201d.")}
                </p>
              )}
            </div>
          )}

          {step === 3 && (
            <div className="space-y-4">
              {/* Country combobox — restricted to workspace-configured countries */}
              <div className="space-y-1.5">
                <Label>{t("orders.co.country", "Country")}</Label>
                {(() => {
                  const workspaceCountryNames = citiesQuery.data?.countries ?? [];
                  const workspaceCodes = new Set(
                    workspaceCountryNames
                      .map((name) => findCountryByName(name)?.code)
                      .filter(Boolean) as string[],
                  );
                  const allowedCountries = COUNTRY_CATALOGUE.filter((c) =>
                    workspaceCodes.has(c.code),
                  );
                  return (
                    <CountryCombobox
                      value={deliveryCountryCode}
                      onChange={(code) => {
                        setDeliveryCountryCode(code);
                        setDeliveryCitySlug("");
    setCollectAddressLater(false);
                      }}
                      countries={allowedCountries.length > 0 ? allowedCountries : undefined}
                    />
                  );
                })()}
              </div>
              {/* City dropdown — appears when a country is selected and cities exist */}
              {deliveryCountryCode && (() => {
                const citiesForCountry = (citiesQuery.data?.cities ?? []).filter(
                  (c) => c.country_code?.toLowerCase() === deliveryCountryCode.toLowerCase(),
                );
                if (citiesForCountry.length === 0) return null;
                return (
                  <div className="space-y-1.5">
                    <Label>{t("orders.co.city", "City")}</Label>
                    <Select
                      value={deliveryCitySlug}
                      onValueChange={(v) => {
                        const nextSlug = v === "__clear__" ? "" : v;
                        setDeliveryCitySlug(nextSlug);
                        const nextCity = (citiesQuery.data?.cities ?? []).find(
                          (city) => city.slug === nextSlug,
                        );
                        if (nextCity) setCurrency(nextCity.currency);
                      }}
                    >
                      <SelectTrigger>
                        <SelectValue placeholder={t("orders.co.cityPlaceholder", "Select city…")} />
                      </SelectTrigger>
                      <SelectContent>
                        {deliveryCitySlug && (
                          <SelectItem value="__clear__">{t("orders.co.cityClear", "— Clear selection —")}</SelectItem>
                        )}
                        {citiesForCountry.map((c) => (
                          <SelectItem key={c.slug} value={c.slug}>
                            {c.name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                );
              })()}
              <div className="flex items-center gap-2">
                <Switch
                  id="collect-address-later"
                  checked={collectAddressLater}
                  onCheckedChange={setCollectAddressLater}
                />
                <Label htmlFor="collect-address-later" className="cursor-pointer font-normal">
                  {t("orders.co.collectAddressLater", "Collect address later")}
                </Label>
              </div>
              {collectAddressLater && (
                <div className="space-y-1.5 rounded-lg border border-border bg-muted/40 p-3">
                  <Label htmlFor="collect-address-language">
                    {t("orders.co.collectAddressLanguage", "Recipient's WhatsApp language")}
                  </Label>
                  <Select
                    value={collectAddressLanguage}
                    onValueChange={(v) => setCollectAddressLanguage(v as "en" | "ar")}
                  >
                    <SelectTrigger id="collect-address-language" className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="en">{t("orders.co.langEnglish", "English")}</SelectItem>
                      <SelectItem value="ar">{t("orders.co.langArabic", "Arabic")}</SelectItem>
                    </SelectContent>
                  </Select>
                  {attemptedNext && !collectAddressValid && (
                    <p className="text-sm text-destructive">
                      {t(
                        "orders.co.collectAddressRecipientRequired",
                        "A recipient name and phone number are required to send the address request.",
                      )}
                    </p>
                  )}
                </div>
              )}
              {!collectAddressLater && (
                <div className="space-y-1.5">
                  <Label>{t("orders.co.deliveryAddress")}</Label>
                  <Textarea
                    value={deliveryAddress}
                    onChange={(e) => setDeliveryAddress(e.target.value)}
                    rows={2}
                    placeholder={t("orders.co.deliveryAddressPlaceholder")}
                  />
                </div>
              )}
              <div className="space-y-1.5">
                <Label>{t("orders.co.deliveryInstructions")}</Label>
                <Textarea
                  value={deliveryInstructions}
                  onChange={(e) => setDeliveryInstructions(e.target.value)}
                  rows={2}
                />
              </div>

              {/* Delivery date & time window (optional) */}
              <div className="space-y-3 rounded-lg border border-border p-3">
                <div>
                  <p className="text-sm font-medium">{t("orders.co.deliveryWindowTitle")}</p>
                  <p className="text-xs text-muted-foreground">
                    {t("orders.co.deliveryWindowHint")}
                  </p>
                </div>
                <div className="space-y-1.5">
                  <Label>{t("orders.deliveryDay")}</Label>
                  <Popover open={deliveryDayOpen} onOpenChange={setDeliveryDayOpen}>
                    <PopoverTrigger asChild>
                      <Button
                        type="button"
                        variant="outline"
                        className={cn(
                          "w-full justify-start gap-2 text-start font-normal",
                          !deliveryDay && "text-muted-foreground",
                        )}
                        data-testid="create-order-delivery-day"
                      >
                        <CalendarIcon size={15} className="shrink-0 text-muted-foreground" />
                        <span className="truncate">
                          {deliveryDay
                            ? format(deliveryDay, "EEE, MMM d, yyyy")
                            : t("orders.datePlaceholder")}
                        </span>
                      </Button>
                    </PopoverTrigger>
                    <PopoverContent className="w-auto p-0" align="start">
                      <Calendar
                        mode="single"
                        selected={deliveryDay}
                        onSelect={(d) => {
                          setDeliveryDay(d);
                          setDeliveryDayOpen(false);
                        }}
                        defaultMonth={deliveryDay ?? new Date()}
                      />
                    </PopoverContent>
                  </Popover>
                </div>
                {deliveryDay ? (
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    <div className="space-y-1.5">
                      <span className="text-xs font-medium text-muted-foreground">
                        {t("orders.startTime")}
                      </span>
                      <TimePicker
                        value={deliveryStartTime}
                        onChange={setDeliveryStartTime}
                        data-testid="create-order-start-time"
                      />
                    </div>
                    <div className="space-y-1.5">
                      <span className="text-xs font-medium text-muted-foreground">
                        {t("orders.endTime")}
                      </span>
                      <TimePicker
                        value={deliveryEndTime}
                        onChange={setDeliveryEndTime}
                        data-testid="create-order-end-time"
                      />
                    </div>
                  </div>
                ) : (
                  <p className="text-sm text-muted-foreground">{t("orders.pickDayFirst")}</p>
                )}
                {deliveryDay && (
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    onClick={() => {
                      setDeliveryDay(undefined);
                      setDeliveryStartTime("");
                      setDeliveryEndTime("");
                    }}
                    data-testid="create-order-clear-delivery"
                  >
                    {t("orders.co.clearDeliveryWindow")}
                  </Button>
                )}
                {isPastDeliveryDay && (
                  <p role="alert" className="text-xs text-amber-600">
                    {t("orders.pastDeliveryDayWarning")}
                  </p>
                )}
                {!windowValid && (
                  <p role="alert" className="text-xs text-amber-600">
                    {t("orders.windowOrderError")}
                  </p>
                )}
              </div>
            </div>
          )}

          {step === 4 && (
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 h-full min-h-0">
              {/* ── Left: product discovery ── */}
              <div className="flex flex-col gap-2 min-h-0">
                {/* Search */}
                <div className="relative">
                  <Search size={16} className="absolute left-2.5 top-2.5 text-muted-foreground" />
                  <Input
                    data-testid="input-create-order-product-search"
                    className="pl-8"
                    value={productSearch}
                    onChange={(e) => setProductSearch(e.target.value)}
                    placeholder={t("orders.co.searchProducts")}
                    autoFocus
                  />
                </div>
                {/* Status + category + occasion filters */}
                <div className="flex gap-1.5 flex-wrap">
                  {(["", "available", "out_of_stock"] as const).map((f) => (
                    <button
                      key={f}
                      type="button"
                      onClick={() => setProductStatusFilter(f)}
                      className={cn(
                        "rounded-full px-3 py-0.5 text-xs font-medium border transition-colors",
                        productStatusFilter === f
                          ? "bg-teal-700 text-white border-teal-700"
                          : "border-border text-muted-foreground hover:bg-muted",
                      )}
                    >
                      {f === "" ? t("orders.co.filterAll") : f === "available" ? t("orders.co.filterAvailable") : t("orders.co.filterOutOfStock")}
                    </button>
                  ))}
                  {(categoriesQuery.data ?? []).map((c) => (
                    <button
                      key={`cat-${c.id}`}
                      type="button"
                      onClick={() => setProductCategoryFilter(productCategoryFilter === c.slug ? "" : c.slug)}
                      className={cn(
                        "rounded-full px-3 py-0.5 text-xs font-medium border transition-colors",
                        productCategoryFilter === c.slug
                          ? "bg-amber-600 text-white border-amber-600"
                          : "border-border text-muted-foreground hover:bg-muted",
                      )}
                    >
                      {c.name}
                    </button>
                  ))}
                  {(occasionsQuery.data ?? []).map((o) => (
                    <button
                      key={`occ-${o.id}`}
                      type="button"
                      onClick={() => setProductOccasionFilter(productOccasionFilter === o.slug ? "" : o.slug)}
                      className={cn(
                        "rounded-full px-3 py-0.5 text-xs font-medium border transition-colors",
                        productOccasionFilter === o.slug
                          ? "bg-pink-600 text-white border-pink-600"
                          : "border-border text-muted-foreground hover:bg-muted",
                      )}
                    >
                      {o.name}
                    </button>
                  ))}
                </div>
                {/* Product list */}
                <div className="flex-1 overflow-y-auto rounded-md border divide-y min-h-0">
                  {productsQuery.isLoading ? (
                    <div className="flex items-center justify-center py-8">
                      <Loader2 size={18} className="animate-spin text-muted-foreground" />
                    </div>
                  ) : productsQuery.isError ? (
                    <p className="py-8 text-center text-sm text-destructive">
                      {t("orders.co.productsLoadError", "Could not load products. Please try again.")}
                    </p>
                  ) : (productsQuery.data?.products ?? []).length === 0 ? (
                    <p className="py-8 text-center text-sm text-muted-foreground">
                      {t("orders.co.noProducts")}
                    </p>
                  ) : (
                    (productsQuery.data?.products ?? []).map((p, index) => {
                      const inCart = cart.some((l) => l.kind === "catalog" && l.product.id === p.id);
                      return (
                        <button
                          type="button"
                          key={p.id}
                          data-testid={`button-add-product-${p.id}`}
                          onClick={() => addToCart(p)}
                          className="flex w-full items-center gap-3 px-3 py-2 text-left hover:bg-muted"
                        >
                          <div className="h-9 w-9 shrink-0 overflow-hidden rounded bg-muted">
                            <CreateOrderProductThumbnail
                              product={p}
                              eager={index < 8}
                            />
                          </div>
                          <div className="flex-1 min-w-0">
                            <p className="text-sm font-medium truncate">{p.name}</p>
                            <p className="text-xs text-muted-foreground">
                              {p.sku ? <span className="mr-1.5 inline-flex items-center rounded bg-slate-100 px-1 text-[10px] font-medium text-slate-600">{p.sku}</span> : null}
                              {fmtCatalog(unitPriceFor(p, currency))}
                            </p>
                            {p.status === "out_of_stock" && (
                              <span className="text-xs text-amber-600">{t("orders.co.outOfStock")}</span>
                            )}
                          </div>
                          {inCart ? (
                            <Check size={16} className="text-teal-700 shrink-0" />
                          ) : (
                            <Plus size={16} className="text-teal-700 shrink-0" />
                          )}
                        </button>
                      );
                    })
                  )}
                </div>
              </div>

              {/* ── Right: cart + custom item form ── */}
              <div className="flex flex-col gap-3 min-h-0 overflow-y-auto">
                {/* Cart items */}
                <div className="space-y-2">
                  {cart.length === 0 ? (
                    <p className="text-sm text-muted-foreground text-center py-4 border rounded-md">
                      {t("orders.co.cartEmpty")}
                    </p>
                  ) : (
                    <>
                      <div className="space-y-1.5">
                        {cart.map((l) => (
                          <div key={l.kind === "catalog" ? l.product.id : l.id} className="flex items-start gap-2 rounded-md border px-2 py-1.5">
                            {/* Thumbnail */}
                            <div className="h-8 w-8 shrink-0 overflow-hidden rounded bg-muted">
                              {l.kind === "catalog" ? (
                                productImageUrl(l.product, "thumbnail") ? (
                                  <img
                                    src={productImageUrl(l.product, "thumbnail")!}
                                    alt=""
                                    width={32}
                                    height={32}
                                    loading="eager"
                                    decoding="async"
                                    onError={(event) =>
                                      fallbackToOriginalProductImage(event.currentTarget, l.product.main_image_url)
                                    }
                                    className="h-full w-full object-cover"
                                  />
                                ) : null
                              ) : l.image_url ? (
                                <img src={imageUrl(l.image_url) ?? l.image_url} alt="" className="h-full w-full object-cover" />
                              ) : null}
                            </div>
                            {l.kind === "catalog" ? (
                              <>
                                <div className="flex-1 min-w-0">
                                  <p className="text-sm font-medium truncate">{l.product.name}</p>
                                  <p className="text-xs text-muted-foreground">
                                    {fmtCatalog(unitPriceFor(l.product, currency))} × {l.quantity} = {fmtCatalog(unitPriceFor(l.product, currency) * l.quantity)}
                                  </p>
                                  {hasPersonalization(l.product) && (
                                    <Input
                                      className="mt-1 h-7 text-xs"
                                      value={l.custom_input}
                                      maxLength={22}
                                      onChange={(e) => setCustomInput(l.product.id, e.target.value)}
                                      placeholder={t("orders.co.customInputPlaceholder")}
                                    />
                                  )}
                                </div>
                                <div className="flex items-center gap-1 shrink-0">
                                  <Button type="button" size="icon" variant="outline" className="h-6 w-6" onClick={() => setQty(l.product.id, -1)}>
                                    <Minus size={10} />
                                  </Button>
                                  <span className="w-5 text-center text-sm">{l.quantity}</span>
                                  <Button type="button" size="icon" variant="outline" className="h-6 w-6" onClick={() => setQty(l.product.id, 1)}>
                                    <Plus size={10} />
                                  </Button>
                                  <Button type="button" size="icon" variant="ghost" className="h-6 w-6 text-destructive" onClick={() => removeLine(l.product.id)}>
                                    <Trash2 size={10} />
                                  </Button>
                                </div>
                              </>
                            ) : (
                              <>
                                <div className="flex-1 min-w-0">
                                  <div className="flex items-center gap-1.5">
                                    <p className="text-sm font-medium truncate">{l.name}</p>
                                    <span className="inline-flex items-center rounded-sm bg-violet-100 px-1 py-0 text-xs font-medium text-violet-700">
                                      {t("orders.customItem.badge")}
                                    </span>
                                  </div>
                                  <p className="text-xs text-muted-foreground">
                                    {fmt(l.unit_price)} × {l.quantity} = {fmt(l.unit_price * l.quantity)}
                                  </p>
                                  {l.production_instructions && (
                                    <p className="text-xs text-muted-foreground truncate">{l.production_instructions}</p>
                                  )}
                                </div>
                                <div className="flex items-center gap-1 shrink-0">
                                  <Button type="button" size="icon" variant="outline" className="h-6 w-6" onClick={() => setCustomLineQty(l.id, -1)}>
                                    <Minus size={10} />
                                  </Button>
                                  <span className="w-5 text-center text-sm">{l.quantity}</span>
                                  <Button type="button" size="icon" variant="outline" className="h-6 w-6" onClick={() => setCustomLineQty(l.id, 1)}>
                                    <Plus size={10} />
                                  </Button>
                                  <Button type="button" size="icon" variant="ghost" className="h-6 w-6 text-destructive" onClick={() => removeCustomLine(l.id)}>
                                    <Trash2 size={10} />
                                  </Button>
                                </div>
                              </>
                            )}
                          </div>
                        ))}
                      </div>
                      <div className="flex justify-between border-t pt-1.5 text-sm font-medium">
                        <span>{t("orders.co.subtotal")}</span>
                        <span>{fmt(subtotal)}</span>
                      </div>
                      <div className="flex justify-between text-sm" data-testid="create-order-delivery-fee">
                        <span>{t("orders.co.deliveryFee", "Delivery fee")}</span>
                        <span>
                          {selectedCity?.free_delivery_enabled && deliveryFee === 0
                            ? t("orders.co.freeDelivery", "Free")
                            : fmt(deliveryFee)}
                        </span>
                      </div>
                      <div className="flex justify-between border-t pt-1.5 text-sm font-semibold" data-testid="create-order-grand-total">
                        <span>{t("orders.co.total", "Total")}</span>
                        <span>{fmt(grandTotal)}</span>
                      </div>
                      {showPricesInUsdNote && (
                        <p className="text-xs text-muted-foreground pt-0.5">
                          {t("orders.co.pricesInUsd", { currency })}
                        </p>
                      )}
                    </>
                  )}
                </div>

                {/* Custom item form */}
                {showCustomForm ? (
                  <div className="rounded-md border p-3 space-y-2.5 bg-violet-50/50">
                    <p className="text-xs font-semibold text-violet-700 uppercase tracking-wide">{t("orders.co.customItem.title")}</p>
                    <div className="space-y-1">
                      <Label className="text-xs">{t("orders.co.customItem.name")} <span className="text-destructive">*</span></Label>
                      <Input
                        className="h-8 text-sm"
                        value={customName}
                        onChange={(e) => setCustomName(e.target.value)}
                        placeholder={t("orders.co.customItem.namePlaceholder")}
                      />
                    </div>
                    <div className="grid grid-cols-2 gap-2">
                      <div className="space-y-1">
                        <Label className="text-xs">{t("orders.co.customItem.price")} <span className="text-destructive">*</span></Label>
                        <Input
                          className="h-8 text-sm"
                          type="number"
                          min="0"
                          step="0.01"
                          value={customPrice}
                          onChange={(e) => setCustomPrice(e.target.value)}
                          placeholder="0.00"
                        />
                      </div>
                      <div className="space-y-1">
                        <Label className="text-xs">{t("orders.co.customItem.qty")}</Label>
                        <div className="flex items-center gap-1">
                          <Button type="button" size="icon" variant="outline" className="h-8 w-8 shrink-0" onClick={() => setCustomQty((q) => Math.max(1, q - 1))}>
                            <Minus size={12} />
                          </Button>
                          <span className="w-8 text-center text-sm font-medium">{customQty}</span>
                          <Button type="button" size="icon" variant="outline" className="h-8 w-8 shrink-0" onClick={() => setCustomQty((q) => q + 1)}>
                            <Plus size={12} />
                          </Button>
                        </div>
                      </div>
                    </div>
                    <div className="space-y-1">
                      <Label className="text-xs">{t("orders.co.customItem.instructions")} <span className="text-destructive">*</span></Label>
                      <Textarea
                        className="text-sm min-h-0"
                        rows={2}
                        value={customInstructions}
                        onChange={(e) => setCustomInstructions(e.target.value)}
                        placeholder={t("orders.co.customItem.instructionsPlaceholder")}
                      />
                    </div>
                    <div className="space-y-1">
                      <Label className="text-xs">{t("orders.co.customItem.image")}</Label>
                      {customImageUrl ? (
                        <div className="flex items-center gap-2">
                          <img src={imageUrl(customImageUrl) ?? customImageUrl} alt="" className="h-10 w-10 rounded object-cover shrink-0 border" />
                          <Button type="button" size="sm" variant="ghost" className="text-xs h-7" onClick={() => { setCustomImageUrl(null); if (customImageInputRef.current) customImageInputRef.current.value = ""; }}>
                            {t("orders.co.customItem.removeImage")}
                          </Button>
                        </div>
                      ) : (
                        <label className={cn("flex items-center gap-2 cursor-pointer rounded-md border border-dashed px-3 py-2 text-xs text-muted-foreground hover:bg-muted", customImageUploading && "opacity-50 pointer-events-none")}>
                          {customImageUploading ? <Loader2 size={14} className="animate-spin" /> : <ImageIcon size={14} />}
                          <span>{customImageUploading ? t("orders.co.customItem.uploading") : t("orders.co.customItem.imagePlaceholder")}</span>
                          <input
                            ref={customImageInputRef}
                            type="file"
                            accept="image/*"
                            className="sr-only"
                            onChange={(e) => {
                              const f = e.target.files?.[0];
                              if (f) void handleCustomImageUpload(f);
                            }}
                          />
                        </label>
                      )}
                    </div>
                    <div className="flex gap-2 pt-1">
                      <Button type="button" size="sm" variant="ghost" className="text-xs" onClick={resetCustomForm}>
                        {t("orders.co.cancel")}
                      </Button>
                      <Button
                        type="button"
                        size="sm"
                        className="text-xs bg-violet-700 hover:bg-violet-800 text-white"
                        disabled={!customName.trim() || !customPrice.trim() || !customInstructions.trim()}
                        onClick={addCustomItem}
                      >
                        {t("orders.co.customItem.add")}
                      </Button>
                    </div>
                  </div>
                ) : (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="gap-1.5 border-dashed text-muted-foreground self-start"
                    onClick={() => setShowCustomForm(true)}
                  >
                    <Package size={14} />
                    {t("orders.co.addCustomItem")}
                  </Button>
                )}

                {attemptedNext && !productsValid && (
                  <p className="text-xs text-amber-600">{t("orders.co.productsRequired")}</p>
                )}
              </div>
            </div>
          )}

          {step === 5 && (
            <div className="space-y-4">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <Label>{t("orders.co.currency")}</Label>
                  <Select value={currency} onValueChange={(v) => setCurrency(v as Currency)}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {CURRENCIES.map((c) => (
                        <SelectItem key={c} value={c} disabled={!!selectedCity && c !== selectedCity.currency}>
                          {c}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-1.5">
                  <Label>{t("orders.co.source")}</Label>
                  <Select value={source} onValueChange={setSource}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {ORDER_SOURCES.map((s) => (
                        <SelectItem key={s} value={s}>{t(`orders.co.source_${s}`)}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-1.5">
                  <Label>{t("orders.co.status")}</Label>
                  <Select value={status} onValueChange={setStatus}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {ORDER_STATUSES.map((s) => (
                        <SelectItem key={s} value={s}>{t(`orders.co.status_${s}`)}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-1.5">
                  <Label>{t("orders.co.paymentMethod")}</Label>
                  <Select value={paymentMethod} onValueChange={setPaymentMethod}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {PAYMENT_METHODS.map((m) => (
                        <SelectItem key={m} value={m}>{t(`orders.co.method_${m}`)}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </div>

              {/* Payment link picker — optional link to an existing payment link */}
              <div className="space-y-1.5">
                <Label>{t("orders.co.paymentLink", "Payment Link (optional)")}</Label>
                <Popover open={paymentLinkOpen} onOpenChange={setPaymentLinkOpen}>
                  <PopoverTrigger asChild>
                    <Button
                      type="button"
                      variant="outline"
                      className="w-full justify-start gap-2 font-normal text-left h-auto min-h-9"
                    >
                      {selectedPaymentLink ? (
                        <span className="flex-1 truncate text-sm">
                          {(() => {
                            const pl = selectedPaymentLink;
                            const name = [pl.sender_first_name, pl.sender_last_name].filter(Boolean).join(" ");
                            const amtStr = `${pl.currency} ${(pl.amount / 100).toFixed(2)}`;
                            return name ? `${name} — ${amtStr}` : pl.description ? `${pl.description} — ${amtStr}` : amtStr;
                          })()}
                        </span>
                      ) : (
                        <span className="flex-1 text-muted-foreground text-sm">
                          {t("orders.co.paymentLinkPlaceholder", "Search payment links…")}
                        </span>
                      )}
                      {selectedPaymentLink && (
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            setPaymentLinkId(null);
                            setPaymentLinkSearch("");
                          }}
                          className="ml-auto shrink-0 text-muted-foreground hover:text-foreground"
                          aria-label="Clear"
                        >
                          <Check size={14} className="text-teal-700" />
                        </button>
                      )}
                    </Button>
                  </PopoverTrigger>
                  <PopoverContent className="w-[400px] p-0" align="start">
                    <div className="p-2 border-b">
                      <div className="relative">
                        <Search size={14} className="absolute left-2.5 top-2.5 text-muted-foreground" />
                        <input
                          className="w-full pl-8 pr-3 py-1.5 text-sm rounded border border-input bg-background outline-none focus:ring-1 focus:ring-ring"
                          placeholder={t("orders.co.paymentLinkSearchPlaceholder", "Search by name, amount, or description…")}
                          value={paymentLinkSearch}
                          onChange={(e) => setPaymentLinkSearch(e.target.value)}
                          autoFocus
                        />
                      </div>
                    </div>
                    <div className="max-h-60 overflow-y-auto">
                      {paymentLinksQuery.isLoading ? (
                        <div className="flex items-center justify-center py-6">
                          <Loader2 size={16} className="animate-spin text-muted-foreground" />
                        </div>
                      ) : filteredPaymentLinks.length === 0 ? (
                        <p className="text-sm text-muted-foreground text-center py-4">
                          {t("orders.co.paymentLinkEmpty", "No payment links found")}
                        </p>
                      ) : (
                        filteredPaymentLinks.map((pl) => {
                          const name = [pl.sender_first_name, pl.sender_last_name].filter(Boolean).join(" ");
                          const amtStr = `${pl.currency} ${(pl.amount / 100).toFixed(2)}`;
                          const label = name || pl.description || amtStr;
                          const sub = name ? (pl.description ? `${pl.description} · ${amtStr}` : amtStr) : amtStr;
                          const isPaid = pl.status === "paid";
                          return (
                            <button
                              key={pl.id}
                              type="button"
                              className={cn(
                                "flex w-full items-start gap-2 px-3 py-2 text-left hover:bg-muted text-sm",
                                paymentLinkId === pl.id && "bg-muted",
                              )}
                              onClick={() => {
                                setPaymentLinkId(pl.id);
                                if (isPaid) {
                                  setPaymentMethod("payment_link");
                                  setPaymentStatus("paid");
                                }
                                setPaymentLinkOpen(false);
                                setPaymentLinkSearch("");
                              }}
                            >
                              <div className="flex-1 min-w-0">
                                <p className="font-medium truncate">{label}</p>
                                {label !== sub && (
                                  <p className="text-xs text-muted-foreground truncate">{sub}</p>
                                )}
                              </div>
                              <span className={cn(
                                "inline-flex items-center shrink-0 rounded-full px-2 py-0.5 text-xs font-medium",
                                isPaid
                                  ? "bg-green-100 text-green-800"
                                  : pl.status === "expired"
                                    ? "bg-secondary text-muted-foreground"
                                    : "bg-amber-100 text-amber-800",
                              )}>
                                {isPaid ? t("paymentLinks.paymentStatusPaid", "Paid") : pl.status === "expired" ? t("paymentLinks.linkStatusExpired", "Expired") : t("paymentLinks.linkStatusActive", "Active")}
                              </span>
                            </button>
                          );
                        })
                      )}
                    </div>
                    {selectedPaymentLink && (
                      <div className="border-t p-2">
                        <button
                          type="button"
                          className="text-xs text-muted-foreground hover:text-foreground w-full text-left"
                          onClick={() => {
                            setPaymentLinkId(null);
                            setPaymentLinkSearch("");
                            setPaymentLinkOpen(false);
                          }}
                        >
                          {t("orders.co.paymentLinkClear", "Clear selection")}
                        </button>
                      </div>
                    )}
                  </PopoverContent>
                </Popover>
                <p className="text-xs text-muted-foreground">
                  {t("orders.co.paymentLinkHint", "Link a payment link that was already sent to the customer.")}
                </p>
              </div>

              <p className="text-xs text-muted-foreground">{t("orders.co.noChargeHint")}</p>

              <div className="space-y-1.5">
                <Label>{t("orders.co.internalNote")}</Label>
                <Textarea value={internalNote} onChange={(e) => setInternalNote(e.target.value)} rows={2} />
              </div>
            </div>
          )}

          {step === 6 && (
            <div className="space-y-4">
              <p className="text-sm text-muted-foreground">{t("orders.co.cardMessageHint", "All fields are optional.")}</p>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <Label>{t("orders.co.cardFrom")}</Label>
                  <Input
                    value={cardFrom}
                    onChange={(e) => setCardFrom(e.target.value)}
                    onBlur={() => setCardFrom(normalizePersonName(cardFrom) ?? "")}
                  />
                </div>
                <div className="space-y-1.5">
                  <Label>{t("orders.co.cardTo")}</Label>
                  <Input
                    value={cardTo}
                    onChange={(e) => setCardTo(e.target.value)}
                    onBlur={() => setCardTo(normalizePersonName(cardTo) ?? "")}
                  />
                </div>
              </div>
              <div className="space-y-1.5">
                <Label>{t("orders.co.cardMessage")}</Label>
                <Textarea value={cardMessage} onChange={(e) => setCardMessage(e.target.value)} rows={3} />
              </div>
            </div>
          )}
        </div>

        {/* Footer */}
        <DialogFooter className="flex-row justify-between gap-2 border-t px-6 py-4">
          <Button
            type="button"
            variant="outline"
            onClick={step === 1 ? () => handleOpenChange(false) : goBack}
            disabled={createMut.isPending}
          >
            {step === 1 ? t("orders.co.cancel") : t("orders.co.back")}
          </Button>
          {step < TOTAL_STEPS ? (
            <Button
              type="button"
              className="bg-teal-700 text-white hover:bg-teal-800"
              onClick={goNext}
              disabled={step === 4 ? cart.length === 0 : !stepValid}
              data-testid="button-create-order-next"
            >
              {step === 4
                ? `${t("orders.co.next")}: ${t("orders.co.stepDetails")} · ${cart.length} ${cart.length === 1 ? t("orders.co.itemSingular") : t("orders.co.itemPlural")} · ${fmt(grandTotal)}`
                : t("orders.co.next")}
            </Button>
          ) : (
            <Button
              type="button"
              className="bg-teal-700 text-white hover:bg-teal-800"
              onClick={handleSubmit}
              disabled={createMut.isPending || !customerValid || !productsValid || !collectAddressValid}
              data-testid="button-create-order-submit"
            >
              {createMut.isPending ? (
                <>
                  <Loader2 size={16} className="mr-1.5 animate-spin" />
                  {t("orders.co.creating")}
                </>
              ) : (
                t("orders.co.create")
              )}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

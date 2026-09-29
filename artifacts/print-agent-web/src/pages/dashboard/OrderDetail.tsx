import React from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Link, useParams, useLocation } from "wouter";
import {
  ArrowLeft,
  Loader2,
  ShoppingCart,
  User,
  CreditCard,
  Truck,
  Package,
  FileText,
  MapPin,
  Pencil,
  MessageSquare,
  Trash2,
  RotateCcw,
  Star,
  Printer,
  History,
  Link2,
  Copy,
  AlertTriangle,
  BadgeCheck,
  Send,
  Flower2,
  Phone,
  MoreHorizontal,
  Check,
  Activity,
  StickyNote,
  MessageCircle,
  ChevronLeft,
  ChevronRight,
  ChevronDown,
  Minus,
  Plus,
  Search,
  MoreVertical,
  Lock,
  HeartHandshake,
  Megaphone,
  Tag,
  ZoomIn,
  Download,
  CalendarDays,
} from "lucide-react";
import { apiFetch, getClerkToken } from "@/lib/queryClient";
import { cn } from "@/lib/utils";
import { formatPaymentMethodLabel } from "@/lib/paymentMethodLabel";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { useTranslation } from "react-i18next";
import { getCountryMetadata } from "@/lib/countries";
import { useToast } from "@/hooks/use-toast";
import { useWorkspaceRole } from "@/hooks/use-workspace-role";
import { useRoles } from "@/hooks/use-roles";
import {
  useUpdateOrder,
  useUpdateOrderContacts,
  useDeleteOrder,
  useRefundOrder,
  useMarkOrderPaid,
  useSendOrderPaymentInstructions,
  useResendWhishPaymentInstructions,
  useListOrderContactEdits,
  getListOrderContactEditsQueryKey,
  useRetryTookanTask,
  useSendOrderToFlorist,
  useRemoveOrderFloristAssignment,
  useGetOrderFloristAssignment,
  getGetOrderFloristAssignmentQueryKey,
  useListOrderActivity,
  getListOrderActivityQueryKey,
  getOrderRescheduleOptions,
  rescheduleOrderDelivery,
  useAddOrderInternalNote,
  getListOrderLineItemCatalogQueryKey,
  useListOrderLineItemCatalog,
  useAddOrderLineItem,
  useUpdateOrderLineItem,
  useRemoveOrderLineItem,
} from "@workspace/api-client-react";
import type {
  OrderLineItemCatalogProduct,
  UpdateOrderInput,
  UpdateOrderContactsInput,
} from "@workspace/api-client-react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  ORDER_STATUSES,
  ORDER_STATUS_LABEL_KEYS,
  normalizeOrderStatus,
  orderStatusBadgeClass,
} from "@/lib/orderStatus";
import { OrderStatusStepper, nextFlowStatus } from "@/components/OrderStatusStepper";
import { computePunctuality } from "@/lib/orderPunctuality";
import { OrderStatusBadge } from "@/components/OrderStatusBadge";
import {
  formatDeliverySchedule,
  marketDateKey,
  rescheduleErrorMessage,
  rescheduleInitialDate,
  resolveDeliverySchedule,
  type RescheduleOptionsResponse,
} from "@/lib/deliveryDate";
import { imageUrl } from "@/lib/imageUrl";
import { getTookanStatusBadge } from "@/lib/tookanStatusBadge";
import { FloristPhotoLightbox, downloadImage as downloadFloristImage, type LightboxImage } from "@/components/FloristPhotoLightbox";
import { FloristPhotoPublicationControl } from "@/components/FloristPhotoVerification";
import { usePageTitleOverride } from "@/hooks/use-page-title";
import OrderCommunicationsCard from "@/components/OrderCommunicationsCard";
import RespondioConversationCard from "@/components/RespondioConversationCard";
import {
  buildDeliveryPresentationModel,
  needsAddressCollectorAttention,
  type AddressCollectorRequest,
} from "./orderDeliveryModel";
import {
  getPaidCurrencyConversion,
  convertToPaidCurrency,
  formatPaidCurrency,
  showsUsdApproximation,
  usdFallbackCurrencyLabel,
  getPaidOrderCurrency,
} from "@/lib/paidCurrencyDisplay";

type LineItem = {
  id: string;
  name: string;
  sku: string | null;
  quantity: number;
  unit_price: string | null;
  total: string | null;
  line_total?: string | null;
  /** Actually-charged per-item price in the order's paid currency (nullable). */
  paid_unit_price?: string | null;
  /** Actually-charged line total in the order's paid currency (nullable). */
  paid_line_total?: string | null;
  image_url: string | null;
  product_id: number | null;
  custom_input: string | null;
  is_custom_item?: boolean | null;
  production_instructions?: string | null;
  /** True when this line was added as a $0 customer-service gesture. */
  is_complimentary?: boolean | null;
  /** Immutable catalog unit price captured when the item was made complimentary. */
  complimentary_original_price?: string | number | null;
  complimentary_reason?: string | null;
  complimentary_note?: string | null;
  complimentary_added_by?: string | null;
  complimentary_added_at?: string | null;
  metadata?: Record<string, unknown> | null;
};

function complimentaryDisplayValue(
  item: LineItem,
  quantity = 1,
): { amount: number; currency: string } | null {
  const addPrice =
    item.metadata?.add_product_price &&
    typeof item.metadata.add_product_price === "object"
      ? (item.metadata.add_product_price as Record<string, unknown>)
      : null;
  const amount = toFiniteNumber(addPrice?.original_unit_price);
  const currency =
    typeof addPrice?.currency === "string" ? addPrice.currency.trim().toUpperCase() : "";
  return amount != null && currency ? { amount: amount * quantity, currency } : null;
}
type Contact = {
  role: string;
  /** Null for synthetic entries derived from raw_payload when no linked contact row exists. */
  contact_id: string | null;
  first_name: string | null;
  last_name: string | null;
  display_name: string | null;
  email: string | null;
  phone: string | null;
  respondio_contact_id: string | null;
  respondio_url: string | null;
  respondio_sync_status?: string | null;
  /** True when the contact is synced to respond.io but RESPONDIO_SPACE_ID is not configured. */
  respondio_synced?: boolean;
};

type Assignment = {
  assignment_id: number;
  assignment_status: string;
  scheduled_at: string | null;
  delivered_at: string | null;
  assignment_notes: string | null;
  driver_id: number;
  driver_first_name: string | null;
  driver_last_name: string | null;
  driver_phone: string | null;
};

type LinkedPaymentLink = {
  id: number;
  public_token: string;
  amount: number;
  currency: string;
  status: string;
  description: string | null;
  provider?: string | null;
  created_at?: string | null;
  paid_at?: string | null;
  creator_clerk_id?: string | null;
};

type PaymentSummary = {
  commercial_total: number | string | null;
  commercial_currency: string | null;
  paid: number | string;
  pending: number | string;
  remaining: number | string | null;
  overpaid: number | string;
  currency_mismatch: boolean;
  status: string;
};
type OrderDetail = {
  id: string;
  display_order_number: string | null;
  external_order_id: string | null;
  status: string;
  source: string | null;
  channel: string | null;
  ordered_at: string | null;
  delivery_type: string | null;
  delivery_address: Record<string, unknown> | null;
  delivery_instructions: string | null;
  window_start: string | null;
  window_end: string | null;
  totals: Record<string, unknown> | null;
  created_at: string;
  updated_at: string;
  payment_status: string | null;
  payment_method: string | null;
  payment_provider: string | null;
  payment_reference: string | null;
  payment_amount_usd: string | number | null;
  payment_amount: string | number | null;
  payment_currency: string | null;
  whish_instructions_sent_at: string | null;
  refunded_amount: string | number | null;
  refunded_amount_usd: string | number | null;
  paid_at: string | null;
  customer_note: string | null;
  florist_note: string | null;
  driver_note: string | null;
  internal_note: string | null;
  card_message: string | null;
  card_from: string | null;
  card_to: string | null;
  qr_link: string | null;
  metadata: Record<string, unknown> | null;
  tookan_task_id: string | null;
  tookan_job_id: string | null;
  tookan_status: string | null;
  tookan_created_at: string | null;
  tookan_error: string | null;
  tookan_delivered_at: string | null;
  delivery_date_review: string | null;
  coupon_discount_usd?: string | number | null;
  coupon_code?: string | null;
  coupon_discount_type?: string | null;
  coupon_discount_value?: string | number | null;
  coupon_description?: string | null;
  is_anonymous?: boolean;
  is_sensitive_occasion?: boolean;
  marketing_attribution?: Record<string, unknown> | null;
  payment_link?: LinkedPaymentLink | null;
  linked_payment_links?: LinkedPaymentLink[];
  payment_summary?: PaymentSummary;
  address_collector_request?: AddressCollectorRequest | null;
};

type ContactEdit = {
  role: string;
  edited_by_user_id: string;
  edited_by_name: string | null;
  edited_at: string;
};

type OrderDetailResponse = {
  success: boolean;
  order: OrderDetail;
  line_items: LineItem[];
  contacts: Contact[];
  contact_edits?: ContactEdit[];
  additional_card_messages?: CardMessage[];
  assignment: Assignment | null;
  customer_prior_orders?: number;
  recipient_prior_orders?: number;
  line_items_edited?: boolean;
  /** Most-recent ISO timestamp keyed by status, from order_events history. */
  status_timestamps: Record<string, string>;
  /** IANA timezone for the delivery city, e.g. "Asia/Beirut". Defaults to "UTC". */
  timezone: string;
};
type CardMessage = {
  id: string;
  card_to: string | null;
  card_message: string;
  card_from: string | null;
  qr_link: string | null;
  created_at: string;
};
function formatDateTime(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function ContactEditedNote({ edit }: { edit: ContactEdit | null }) {
  const { t } = useTranslation();
  if (!edit) return null;
  const date = formatDateTime(edit.edited_at);
  const text = edit.edited_by_name
    ? t("orders.lastEditedBy", { name: edit.edited_by_name, date })
    : t("orders.lastEditedAt", { date });
  return <p className="text-xs text-muted-foreground italic pt-1">{text}</p>;
}

function ContactEditHistoryDialog({
  orderId,
  role,
  open,
  onOpenChange,
}: {
  orderId: string;
  role: "customer" | "recipient";
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { t } = useTranslation();
  const params = { limit: 200 };
  const { data, isLoading, isError } = useListOrderContactEdits(
    orderId,
    params,
    {
      query: {
        enabled: open,
        queryKey: getListOrderContactEditsQueryKey(orderId, params),
      },
    },
  );

  const edits = (data?.contact_edits ?? []).filter((e) => e.role === role);
  const title =
    role === "customer"
      ? t("orders.editHistoryCustomer")
      : t("orders.editHistoryRecipient");

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md max-h-[80vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <History size={16} className="text-muted-foreground" />
            {title}
          </DialogTitle>
        </DialogHeader>
        <div className="py-2">
          {isLoading ? (
            <div className="flex justify-center py-8">
              <Loader2 size={20} className="animate-spin text-muted-foreground" />
            </div>
          ) : isError ? (
            <p className="text-sm text-destructive py-4">
              {t("orders.editHistoryLoadError")}
            </p>
          ) : edits.length === 0 ? (
            <p className="text-sm text-muted-foreground py-4 text-center">
              {t("orders.editHistoryEmpty")}
            </p>
          ) : (
            <ol className="space-y-3">
              {edits.map((edit, idx) => (
                <li
                  key={`${edit.edited_at}-${idx}`}
                  className="flex flex-col gap-0.5 border-l-2 border-muted pl-3"
                >
                  <span className="text-sm font-medium">
                    {edit.edited_by_name
                      ? t("orders.editHistoryEditedBy", { name: edit.edited_by_name })
                      : t("orders.editHistoryEditedByUnknown")}
                  </span>
                  <span className="text-xs text-muted-foreground">
                    {formatDateTime(edit.edited_at)}
                  </span>
                </li>
              ))}
            </ol>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {t("orders.editHistoryClose")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ContactEditHistoryButton({ onClick }: { onClick: () => void }) {
  const { t } = useTranslation();
  return (
    <button
      type="button"
      onClick={onClick}
      className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground underline-offset-2 hover:underline pt-1"
    >
      <History size={12} />
      {t("orders.viewEditHistory")}
    </button>
  );
}

function sanitizeQrUrl(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  let urlToCheck = trimmed;
  if (!/^[a-z][a-z0-9+\-.]*:\/\//i.test(trimmed)) {
    urlToCheck = `https://${trimmed}`;
  }
  try {
    const parsed = new URL(urlToCheck);
    if (parsed.protocol === "http:" || parsed.protocol === "https:") {
      return urlToCheck;
    }
    return null;
  } catch {
    return null;
  }
}

function QrLinkRow({ url, t }: { url: string; t: (key: string) => string }) {
  const safeUrl = sanitizeQrUrl(url);
  const { toast } = useToast();

  function handleCopy() {
    const text = safeUrl ?? url;
    navigator.clipboard.writeText(text).then(() => {
      toast({ description: t("orders.qrLinkCopied") });
    }).catch(() => {
      toast({ description: t("orders.qrLinkCopyFailed"), variant: "destructive" });
    });
  }

  return (
    <div className="flex items-center gap-2 pt-1 flex-wrap">
      <span className="font-medium text-muted-foreground flex items-center gap-1 shrink-0">
        <Link2 size={13} />
        {t("orders.qrCodeLink")}:
      </span>
      {safeUrl ? (
        <a
          href={safeUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="text-teal-600 underline underline-offset-2 break-all hover:text-teal-700"
        >
          {safeUrl}
        </a>
      ) : (
        <span className="break-all text-muted-foreground">{url}</span>
      )}
      <button
        type="button"
        onClick={handleCopy}
        className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground shrink-0"
        title={t("orders.qrLinkCopy")}
      >
        <Copy size={13} />
      </button>
    </div>
  );
}

function LinkedPaymentLinkRow({ paymentLink }: { paymentLink: LinkedPaymentLink }) {
  const { t } = useTranslation();
  const { toast } = useToast();
  const [copied, setCopied] = React.useState(false);

  const payUrl = `${window.location.origin}/pay/${paymentLink.public_token}`;
  const amountStr = (() => {
    const amount = paymentLink.amount / 100;
    try {
      return new Intl.NumberFormat("en-US", {
        style: "currency",
        currency: paymentLink.currency,
        minimumFractionDigits: 2,
      }).format(amount);
    } catch {
      return `${paymentLink.currency} ${amount.toFixed(2)}`;
    }
  })();

  const label = paymentLink.description ? `${paymentLink.description} · ${amountStr}` : amountStr;

  function handleCopy() {
    navigator.clipboard.writeText(payUrl).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
      toast({ description: t("orders.paymentLinkCopied", "Payment link copied") });
    }).catch(() => {
      toast({ description: t("orders.paymentLinkCopyFailed", "Failed to copy"), variant: "destructive" });
    });
  }

  return (
    <div className="flex items-center gap-2 pt-1 flex-wrap">
      <span className="font-medium text-muted-foreground flex items-center gap-1 shrink-0">
        <Link2 size={13} />
        {t("orders.linkedPaymentLink", "Payment link")}:
      </span>
      <span className="text-sm text-foreground truncate">{label}</span>
      <button
        type="button"
        onClick={handleCopy}
        className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground shrink-0 border rounded px-1.5 py-0.5"
        title={payUrl}
      >
        {copied ? (
          <><Check size={11} className="text-green-600" /><span className="text-green-600">{t("orders.copied", "Copied")}</span></>
        ) : (
          <><Copy size={11} />{t("orders.copyLink", "Copy link")}</>
        )}
      </button>
    </div>
  );
}

function toFiniteNumber(value: unknown): number | null {
  if (value == null || value === "") return null;
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

function isWhishOrder(order: {
  payment_method?: string | null;
  payment_provider?: string | null;
}): boolean {
  return [order.payment_method, order.payment_provider].some(
    (value) => typeof value === "string" && value.trim().toLowerCase() === "whish",
  );
}

// Resolve the full amount the customer was charged, including the delivery fee.
// Prefers the exact provider-charged amount stored on the payment record; falls
// back to reconstructing subtotal + shipping − discount from the totals JSON so
// already-stored orders (whose totals.total excludes delivery) still show the
// delivery-inclusive amount. Returns the raw stored total only when neither the
// charged amount nor a reconstructable subtotal is available.
function resolveChargedTotal(order: {
  totals: Record<string, unknown> | null;
  payment_amount_usd?: string | number | null;
}): { value: number | null; currency: string } {
  const totals = order.totals ?? {};
  // The stored figures below (payment_amount_usd, subtotal/shipping/discount,
  // total) are USD by construction — never pair them with a non-USD
  // totals.currency label (a payload anomaly): fall back to a USD label.
  const currency = usdFallbackCurrencyLabel(totals.currency);

  // Prefer the amount the customer actually paid (paid-currency pair stored at
  // ingest, e.g. CHF 70.00) over the USD figures; USD/legacy orders keep the
  // behavior below unchanged.
  const paidTotal = toFiniteNumber(totals.paid_total);
  const paidCurrency =
    typeof totals.paid_currency === "string" && totals.paid_currency.trim() !== ""
      ? totals.paid_currency
      : "";
  if (paidTotal != null && paidCurrency) {
    return { value: paidTotal, currency: paidCurrency };
  }

  const charged = toFiniteNumber(order.payment_amount_usd);
  if (charged != null) return { value: charged, currency };

  const subtotal = toFiniteNumber(totals.subtotal);
  const shipping = toFiniteNumber(totals.shipping);
  const discount = toFiniteNumber(totals.discount);
  const storedTotal = toFiniteNumber(
    totals.total ?? totals.grand_total ?? totals.order_total,
  );

  if (subtotal != null) {
    return {
      value: subtotal + (shipping ?? 0) - (discount ?? 0),
      currency,
    };
  }
  return { value: storedTotal, currency };
}

function formatTotal(order: {
  totals: Record<string, unknown> | null;
  payment_amount_usd?: string | number | null;
}): string {
  const { value, currency } = resolveChargedTotal(order);
  if (value == null) return "—";
  try {
    if (currency) {
      return new Intl.NumberFormat("en-US", {
        style: "currency",
        currency,
        minimumFractionDigits: 2,
      }).format(value);
    }
    return value.toFixed(2);
  } catch {
    return `${value.toFixed(2)} ${currency}`.trim();
  }
}

// When the order was paid in a non-USD currency, resolve the stored USD
// equivalent so the detail page can show it secondarily (e.g. "≈ $72.00" under
// "CHF 70.00"). Returns null for USD/legacy orders (no secondary line needed).
function resolveUsdEquivalent(order: {
  totals: Record<string, unknown> | null;
  payment_amount_usd?: string | number | null;
}): number | null {
  const totals = order.totals ?? {};
  const paidCurrency =
    typeof totals.paid_currency === "string" && totals.paid_currency.trim() !== ""
      ? totals.paid_currency.trim().toUpperCase()
      : "";
  if (!paidCurrency || paidCurrency === "USD") return null;
  const paidTotal = toFiniteNumber(totals.paid_total);
  if (paidTotal == null) return null;
  const usdEquivalent =
    toFiniteNumber(order.payment_amount_usd) ??
    toFiniteNumber(totals.total ?? totals.grand_total ?? totals.order_total);
  // Suppress the "≈ $" line when it would be a 1:1 mirror of the paid figure
  // (an implied rate of exactly 1 — typically a mislabeled ingest).
  if (usdEquivalent != null && usdEquivalent === paidTotal) return null;
  return usdEquivalent;
}

function formatUsd(value: number): string {
  try {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: "USD",
      minimumFractionDigits: 2,
    }).format(value);
  } catch {
    return `USD ${value.toFixed(2)}`;
  }
}

// Resolve the paid currency + refundable balances for the refund UI. Prefers
// the paid-currency figures on the payment record, falling back to the USD
// figure for legacy/USD orders. All amounts are in the returned `currency`.
function resolveRefundInfo(order: {
  totals: Record<string, unknown> | null;
  payment_amount?: string | number | null;
  payment_amount_usd?: string | number | null;
  payment_currency?: string | null;
  refunded_amount?: string | number | null;
}): {
  currency: string;
  paidTotal: number | null;
  alreadyRefunded: number;
  remaining: number | null;
} {
  const totals = order.totals ?? {};
  const currency = (
    order.payment_currency ||
    (typeof totals.paid_currency === "string" ? totals.paid_currency : "") ||
    "USD"
  )
    .trim()
    .toUpperCase();
  const paidTotal =
    toFiniteNumber(order.payment_amount) ??
    toFiniteNumber(order.payment_amount_usd);
  const alreadyRefunded = toFiniteNumber(order.refunded_amount) ?? 0;
  const remaining =
    paidTotal != null
      ? Math.round((paidTotal - alreadyRefunded) * 100) / 100
      : null;
  return { currency, paidTotal, alreadyRefunded, remaining };
}

function formatMoney(value: number, currency: string): string {
  try {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency,
      minimumFractionDigits: 2,
    }).format(value);
  } catch {
    return `${currency} ${value.toFixed(2)}`;
  }
}

function DeliveryDetailsCard({
  order,
  recipientHasContact,
  recipientPhone,
  recipientRespondioUrl,
  recipientRespondioSynced,
  recipientRespondioSyncStatus,
  canRequestAddress,
  isRequestingAddress,
  onRequestAddress,
}: {
  order: OrderDetail;
  recipientHasContact: boolean;
  recipientPhone: string | null;
  recipientRespondioUrl: string | null;
  recipientRespondioSynced?: boolean;
  recipientRespondioSyncStatus?: string | null;
  canRequestAddress: boolean;
  isRequestingAddress: boolean;
  onRequestAddress: () => void;
}) {
  const { t } = useTranslation();
  const { toast } = useToast();
  const [showOriginal, setShowOriginal] = React.useState(false);
  const request = order.address_collector_request ?? null;
  const presentation = React.useMemo(
    () =>
      buildDeliveryPresentationModel({
        deliveryAddress: order.delivery_address,
        deliveryInstructions: order.delivery_instructions,
        addressCollectorRequest: request,
      }),
    [order.delivery_address, order.delivery_instructions, request],
  );
  const isAttention = needsAddressCollectorAttention(request);
  const isClosed = Boolean(request?.closed_at);
  const isReceived = request
    ? ["address_received", "verified"].includes(request.status)
    : false;
  const copiedAddress = presentation.copiedAddress ?? presentation.originalAddress;

  async function copyAddress() {
    if (!copiedAddress) return;
    try {
      await navigator.clipboard.writeText(copiedAddress);
      toast({ title: t("orders.addressCopied") });
    } catch {
      toast({ title: t("orders.addressCopyFailed"), variant: "destructive" });
    }
  }

  return (
    <Card data-testid="card-delivery">
      <CardHeader className="pb-3">
        <div className="flex items-center gap-2">
          <Package size={15} className="text-muted-foreground" />
          <CardTitle className="text-sm font-medium">{t("orders.sectionDelivery")}</CardTitle>
          {order.delivery_type && (
            <Badge variant="secondary" className="ml-auto max-w-[11rem] truncate capitalize text-xs">
              {order.delivery_type.replace(/_/g, " ")}
            </Badge>
          )}
        </div>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        <div className="space-y-1">
          {presentation.destination ? (
            <>
              <p className="text-base font-semibold leading-snug text-foreground" data-testid="delivery-destination">
                {presentation.destination}
              </p>
              {presentation.locality && (
                <p className="text-muted-foreground" data-testid="delivery-locality">
                  {presentation.locality}
                  {presentation.country ? ` · ${presentation.country}` : ""}
                </p>
              )}
              {!presentation.locality && presentation.country && (
                <p className="text-muted-foreground">{presentation.country}</p>
              )}
            </>
          ) : presentation.originalAddress ? (
            <p className="leading-relaxed text-foreground" data-testid="delivery-original-fallback">
              {presentation.originalAddress}
            </p>
          ) : null}
          {presentation.usesCollectedAddress && (
            <p className="text-xs font-medium text-emerald-700">
              {t("orders.addressReceived")}
            </p>
          )}
        </div>

        {presentation.instructions && (
          <div className="rounded-md bg-muted/60 px-3 py-2" data-testid="delivery-instructions">
            <p className="text-xs font-medium text-muted-foreground">{t("orders.instructions")}</p>
            <p className="mt-0.5 leading-relaxed text-foreground">{presentation.instructions}</p>
          </div>
        )}

        {!request && presentation.isIncomplete && (
          <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-amber-900">
            <div className="flex items-center gap-1.5 text-xs">
              <AlertTriangle size={13} className="shrink-0" />
              <span>{t("orders.addressNeeded")}</span>
            </div>
            {canRequestAddress && (
              <Button
                size="sm"
                variant="outline"
                className="border-amber-300 bg-background"
                onClick={onRequestAddress}
                disabled={isRequestingAddress}
                data-testid="button-request-address"
              >
                {isRequestingAddress && <Loader2 size={14} className="mr-1.5 animate-spin" />}
                {t("orders.requestAddress")}
              </Button>
            )}
          </div>
        )}

        {request && (
          <div
            className={cn(
              "flex flex-wrap items-center justify-between gap-2 rounded-md border px-3 py-2",
              isClosed
                ? "border-border bg-muted/40 text-foreground"
                : isAttention
                ? "border-amber-200 bg-amber-50 text-amber-950"
                : "border-border bg-muted/40",
            )}
            data-testid="delivery-address-request"
          >
            <div className="flex items-center gap-2 text-xs">
              {!isClosed && isAttention && <AlertTriangle size={13} className="shrink-0" />}
              <span className="font-medium">
                {isClosed
                  ? t("orders.addressCollectionClosed")
                  : isAttention
                  ? t("orders.addressRequestNeedsAttention")
                  : isReceived
                    ? t("orders.addressRequestReceived")
                    : t("orders.addressRequestInProgress")}
              </span>
              <Badge variant="outline" className="text-[11px]">
                {request.resolution_outcome
                  ? t(`addressCollector.outcome.${request.resolution_outcome}`, request.resolution_outcome)
                  : t(`addressCollector.status.${request.status}`, request.status)}
              </Badge>
            </div>
            {isClosed && (
              <div className="basis-full text-xs text-muted-foreground" data-testid="address-collection-closure-reason">
                {request.closure_reason || t("addressCollector.noActionRequired")}
                {request.closed_at ? ` · ${new Date(request.closed_at).toLocaleString()}` : ""}
              </div>
            )}
            <Button size="sm" variant="ghost" className="h-7 px-2 text-xs" asChild>
              <a
                href={`/address-collector?requestId=${encodeURIComponent(request.id)}`}
                data-testid="link-view-address-collector"
              >
                {isClosed ? t("orders.viewCollectionHistory") : t("orders.viewInAddressCollector")}
                <ChevronRight size={13} className="ml-1" />
              </a>
            </Button>
          </div>
        )}

        <div className="flex flex-wrap gap-2">
          {copiedAddress && (
            <Button size="sm" variant="outline" className="gap-1.5" onClick={copyAddress}>
              <Copy size={14} />
              {t("orders.copyAddress")}
            </Button>
          )}
          {presentation.mapUrl && (
            <Button size="sm" variant="outline" className="gap-1.5" asChild>
              <a href={presentation.mapUrl} target="_blank" rel="noopener noreferrer">
                <MapPin size={14} />
                {t("orders.openInMaps")}
              </a>
            </Button>
          )}
          {recipientPhone && (
            <Button size="sm" variant="outline" className="gap-1.5" asChild>
              <a href={`tel:${recipientPhone}`}>
                <Phone size={14} />
                {t("orders.call")}
              </a>
            </Button>
          )}
          {recipientHasContact && recipientRespondioUrl && (
            <Button size="sm" variant="outline" className="gap-1.5" asChild>
              <a
                href={recipientRespondioUrl}
                target="_blank"
                rel="noopener noreferrer"
                data-testid="link-recipient-whatsapp"
              >
                <MessageCircle size={14} />
                {t("orders.whatsapp")}
              </a>
            </Button>
          )}
          {recipientHasContact && !recipientRespondioUrl && (
            <Tooltip>
              <TooltipTrigger asChild>
                <span tabIndex={0}>
                  <Button
                    size="sm"
                    variant="outline"
                    className="gap-1.5"
                    disabled
                    data-testid="button-recipient-whatsapp-unavailable"
                    style={{ pointerEvents: "none" }}
                  >
                    <MessageCircle size={14} />
                    {t("orders.respondioUnavailable")}
                  </Button>
                </span>
              </TooltipTrigger>
              <TooltipContent>
                {recipientRespondioSyncStatus === "phone_format_invalid"
                  ? t("orders.respondioPhoneFormatInvalid")
                  : recipientRespondioSynced
                    ? t("orders.respondioSpaceIdMissing")
                    : t("orders.respondioUnavailableTitle")}
              </TooltipContent>
            </Tooltip>
          )}
        </div>

        {presentation.originalAddress && (
          <div>
            <button
              type="button"
              onClick={() => setShowOriginal((visible) => !visible)}
              className="text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
            >
              {showOriginal ? t("orders.hideOriginalAddress") : t("orders.viewOriginalAddress")}
            </button>
            {showOriginal && (
              <p
                className="mt-1 whitespace-pre-wrap break-words rounded-md border border-border bg-muted/30 p-2 text-xs text-foreground"
                data-testid="delivery-original-address"
              >
                {presentation.originalAddress}
              </p>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function str(v: unknown): string | null {
  if (v == null || v === "") return null;
  if (typeof v === "object") return null;
  return String(v).trim() || null;
}

function pick(obj: Record<string, unknown>, ...keys: string[]): string | null {
  for (const k of keys) {
    const v = str(obj[k]);
    if (v != null) return v;
  }
  return null;
}

type MetadataRow = { label: string; value: string };

function TotersMetadataCard({ metadata, t }: { metadata: Record<string, unknown>; t: (key: string) => string }) {
  const rows: MetadataRow[] = [];
  const consumed = new Set<string>();

  function consume(key: string) {
    consumed.add(key);
  }

  const customer = metadata.customer as Record<string, unknown> | null | undefined;
  const storeAndDelivery = metadata.storeAndDelivery as Record<string, unknown> | null | undefined;
  const totals = metadata.totals as Record<string, unknown> | null | undefined;
  const order = metadata.order as Record<string, unknown> | null | undefined;
  const lineItems = Array.isArray(metadata.lineItems) ? (metadata.lineItems as unknown[]) : null;

  ["customer", "storeAndDelivery", "totals", "order", "lineItems"].forEach(consume);

  const addRow = (labelKey: string, value: string | null) => {
    if (value != null) rows.push({ label: t(`orders.${labelKey}`), value });
  };

  if (customer && typeof customer === "object") {
    addRow("totersCustomerName", pick(customer, "customerName", "customer_name", "name"));
    addRow("totersCustomerPhone", pick(customer, "customerPhone", "customer_phone", "phone"));
    addRow("totersCustomerId", pick(customer, "customerUniqueId", "customer_unique_id", "id"));
  }

  if (storeAndDelivery && typeof storeAndDelivery === "object") {
    addRow("totersStoreName", pick(storeAndDelivery, "storeName", "store_name"));
    addRow("totersDeliveryAddress", pick(storeAndDelivery, "deliveryAddress", "delivery_address", "address"));
  }

  if (totals && typeof totals === "object") {
    addRow("totersCurrency", pick(totals, "currency"));
    addRow("totersItemsTotal", pick(totals, "itemsTotal", "items_total", "subtotal"));
    addRow("totersDiscount", pick(totals, "discount"));
    addRow("totersFinalTotal", pick(totals, "finalTotal", "final_total", "total"));
  }

  if (order && typeof order === "object") {
    addRow("totersOrderStatus", pick(order, "orderStatus", "order_status", "status"));
    addRow("totersShopperStatus", pick(order, "shopperStatus", "shopper_status"));
    addRow("totersPlacedAt", pick(order, "placedAt", "placed_at"));
    addRow("totersPrepareBy", pick(order, "prepareBy", "prepare_by"));
  }

  const topLevelKnown: Array<[string, string[]]> = [
    ["totersPlatform", ["platform", "_platform"]],
    ["totersCapturedAt", ["capturedAt", "captured_at"]],
    ["totersNotes", ["notes"]],
  ];
  for (const [labelKey, keys] of topLevelKnown) {
    const v = pick(metadata, ...keys);
    keys.forEach(consume);
    addRow(labelKey, v);
  }

  ["pageUrl", "page_url", "_platform"].forEach(consume);

  const remaining: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(metadata)) {
    if (!consumed.has(k)) remaining[k] = v;
  }
  const hasRemaining = Object.keys(remaining).length > 0;

  if (rows.length === 0 && !lineItems && !hasRemaining) {
    return (
      <pre className="text-xs bg-secondary/50 rounded p-3 overflow-auto max-h-64 whitespace-pre-wrap break-all">
        {JSON.stringify(metadata, null, 2)}
      </pre>
    );
  }

  return (
    <div className="space-y-3">
      {rows.length > 0 && (
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-sm">
          {rows.map(({ label, value }) => (
            <React.Fragment key={label}>
              <dt className="text-muted-foreground whitespace-nowrap font-medium">{label}:</dt>
              <dd className="text-foreground break-words">{value}</dd>
            </React.Fragment>
          ))}
        </dl>
      )}

      {lineItems && lineItems.length > 0 && (
        <div>
          <p className="text-sm font-medium text-muted-foreground mb-1.5">{t("orders.totersLineItems")}:</p>
          <table className="w-full text-xs border border-border rounded overflow-hidden">
            <thead>
              <tr className="bg-secondary/40 border-b border-border">
                <th className="text-left px-3 py-1.5 font-medium text-muted-foreground">{t("orders.colItemName")}</th>
                <th className="text-right px-3 py-1.5 font-medium text-muted-foreground">{t("orders.colQty")}</th>
                <th className="text-right px-3 py-1.5 font-medium text-muted-foreground hidden sm:table-cell">{t("orders.colUnitPrice")}</th>
                <th className="text-right px-3 py-1.5 font-medium text-muted-foreground">{t("orders.colItemTotal")}</th>
              </tr>
            </thead>
            <tbody>
              {lineItems.map((item, i) => {
                const li = item as Record<string, unknown>;
                const name = str(li.name) ?? "—";
                const options = str(li.options);
                const qty = str(li.qty) ?? "1";
                const price = str(li.price);
                const total = str(li.total);
                return (
                  <tr key={i} className={`border-b border-border last:border-0 ${i % 2 === 0 ? "" : "bg-secondary/10"}`}>
                    <td className="px-3 py-1.5">
                      {name}{options ? <span className="text-muted-foreground"> ({options})</span> : null}
                    </td>
                    <td className={`px-3 py-1.5 text-right ${Number(qty) > 1 ? "font-bold text-destructive" : ""}`}>{qty}</td>
                    <td className="px-3 py-1.5 text-right text-muted-foreground hidden sm:table-cell">{price ?? "—"}</td>
                    <td className="px-3 py-1.5 text-right font-medium">{total ?? price ?? "—"}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {hasRemaining && (
        <div>
          <p className="text-xs font-medium text-muted-foreground mb-1">{t("orders.totersOtherData")}:</p>
          <pre className="text-xs bg-secondary/50 rounded p-3 overflow-auto max-h-48 whitespace-pre-wrap break-all">
            {JSON.stringify(remaining, null, 2)}
          </pre>
        </div>
      )}
    </div>
  );
}

type DriverOption = {
  id: number;
  first_name: string | null;
  last_name: string | null;
  phone?: string | null;
  onboarding_status?: string | null;
};

function toLocalInput(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function fromLocalInput(v: string): string | null {
  if (!v.trim()) return null;
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString();
}

function emptyToNull(v: string): string | null {
  const trimmed = v.trim();
  return trimmed === "" ? null : trimmed;
}

function contactName(c: Contact | null): string {
  if (!c) return "";
  return (
    c.display_name ?? ([c.first_name, c.last_name].filter(Boolean).join(" ") || "")
  );
}

function OrderEditDialog({
  open,
  onOpenChange,
  order,
  assignment,
  customer,
  recipient,
  orderId,
  timezone,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  order: OrderDetail;
  assignment: Assignment | null;
  customer: Contact | null;
  recipient: Contact | null;
  orderId: string;
  timezone: string;
}) {
  const { t } = useTranslation();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const updateMut = useUpdateOrder();
  const updateContactsMut = useUpdateOrderContacts();
  const [saving, setSaving] = React.useState(false);

  const addr = (order.delivery_address ?? {}) as Record<string, unknown>;
  const addrStr = (k: string): string =>
    typeof addr[k] === "string" ? (addr[k] as string) : "";

  const [form, setForm] = React.useState({
    status: normalizeOrderStatus(order.status),
    ordered_at: toLocalInput(order.ordered_at),
    window_start: order.window_start
      ? `${marketDateKey(new Date(order.window_start), timezone)}T${timeInZone(order.window_start, timezone)}`
      : "",
    window_end: order.window_end
      ? `${marketDateKey(new Date(order.window_end), timezone)}T${timeInZone(order.window_end, timezone)}`
      : "",
    delivery_type: order.delivery_type ?? "",
    address_1: addrStr("address") || addrStr("address_1"),
    city: addrStr("city"),
    country: addrStr("country"),
    phone: addrStr("phone"),
    delivery_instructions: order.delivery_instructions ?? "",
    customer_note: order.customer_note ?? "",
    florist_note: order.florist_note ?? "",
    driver_note: order.driver_note ?? "",
    internal_note: order.internal_note ?? "",
    driver_id: assignment ? String(assignment.driver_id) : "unassigned",
    customer_name: contactName(customer),
    customer_email: customer?.email ?? "",
    customer_phone: customer?.phone ?? "",
    recipient_name: contactName(recipient),
    recipient_phone: recipient?.phone ?? "",
  });

  const set = (key: keyof typeof form) => (value: string) =>
    setForm((f) => ({ ...f, [key]: value }));

  const { data: driversData } = useQuery<{ drivers: DriverOption[] }>({
    queryKey: ["fleet-drivers", "order-edit-picker"],
    queryFn: () => apiFetch(`/api/fleet/drivers`),
    enabled: open,
  });
  const drivers = (driversData?.drivers ?? []).filter(
    (d) => (d.onboarding_status ?? "approved") === "approved",
  );

  const { data: deliveryData } = useQuery<{
    cities: { id: number; name: string; country: string }[];
    countries: string[];
  }>({
    queryKey: ["order-edit-delivery"],
    queryFn: () => apiFetch(`/api/cities`),
    enabled: open,
  });

  // Country options from configured delivery countries, preserving any
  // pre-existing free-text value that isn't in the configured list.
  const countryOptions = React.useMemo(() => {
    const names = deliveryData?.countries ?? [];
    const list = [...names];
    if (form.country && !list.includes(form.country)) list.unshift(form.country);
    return list;
  }, [deliveryData?.countries, form.country]);

  // City options from ALL configured delivery cities (no country filter),
  // preserving any pre-existing free-text value that isn't in the list.
  const cityOptions = React.useMemo(() => {
    const names = (deliveryData?.cities ?? []).map((c) => c.name);
    const list = [...names];
    if (form.city && !list.includes(form.city)) list.unshift(form.city);
    return list;
  }, [deliveryData?.cities, form.city]);

  // Changing the country no longer affects the city; the city dropdown lists
  // every configured delivery city regardless of the selected country.
  const onCountryChange = (value: string) =>
    setForm((f) => ({ ...f, country: value }));

  function buildAddress(): Record<string, unknown> | null {
    const base = { ...((order.delivery_address ?? {}) as Record<string, unknown>) };
    const apply = (k: string, v: string) => {
      const trimmed = v.trim();
      if (trimmed === "") delete base[k];
      else base[k] = trimmed;
    };
    // Canonical key is `address` (what external ingest writes and what the
    // Tookan composer reads first). Drop the legacy `address_1` key so the
    // stored JSON converges on one street-line key going forward.
    apply("address", form.address_1);
    delete base.address_1;
    apply("city", form.city);
    const configuredCity = deliveryData?.cities.find(
      (city) => city.name === form.city,
    );
    if (configuredCity) base.cityId = configuredCity.id;
    apply("country", form.country);
    apply("phone", form.phone);
    if (!form.window_start && !form.window_end) {
      delete base.date;
      delete base.slot;
    }
    return Object.keys(base).length ? base : null;
  }

  async function handleSave() {
    setSaving(true);
    try {
      const originalWindowStart = order.window_start
        ? `${marketDateKey(new Date(order.window_start), timezone)}T${timeInZone(order.window_start, timezone)}`
        : "";
      const originalWindowEnd = order.window_end
        ? `${marketDateKey(new Date(order.window_end), timezone)}T${timeInZone(order.window_end, timezone)}`
        : "";
      const windowChanged =
        form.window_start !== originalWindowStart ||
        form.window_end !== originalWindowEnd;
      if (windowChanged && Boolean(form.window_start) !== Boolean(form.window_end)) {
        throw new Error(t("orders.windowRequired"));
      }
      if (windowChanged && form.window_start && form.window_end) {
        const [date, startTime] = form.window_start.split("T");
        const [, endTime] = form.window_end.split("T");
        const normalizedStart = startTime.slice(0, 5);
        const normalizedEnd = endTime.slice(0, 5);
        const available = await getOrderRescheduleOptions(orderId, { date });
        const selected = available.slots.find(
          (slot) =>
            slot.start_time === normalizedStart &&
            slot.end_time === normalizedEnd,
        );
        if (!selected) {
          throw new Error(
            "That delivery slot is no longer available. Choose an available slot from Reschedule.",
          );
        }
        await rescheduleOrderDelivery(orderId, {
          date,
          slot_id: selected.id,
          start_time: normalizedStart,
          end_time: normalizedEnd,
          delivery_type: emptyToNull(form.delivery_type),
          delivery_address: buildAddress(),
        });
      }

      const body: UpdateOrderInput = {
        status: form.status as UpdateOrderInput["status"],
        ordered_at: fromLocalInput(form.ordered_at),
        window_start: windowChanged && !form.window_start ? null : undefined,
        window_end: windowChanged && !form.window_end ? null : undefined,
        delivery_type: windowChanged ? undefined : emptyToNull(form.delivery_type),
        delivery_address: windowChanged ? undefined : buildAddress(),
        delivery_instructions: emptyToNull(form.delivery_instructions),
        customer_note: emptyToNull(form.customer_note),
        florist_note: emptyToNull(form.florist_note),
        driver_note: emptyToNull(form.driver_note),
        internal_note: emptyToNull(form.internal_note),
      };
      await updateMut.mutateAsync({ id: orderId, data: body });

      // Update the linked customer / recipient contact records when their
      // fields changed. Only send the blocks that actually differ.
      const contactsBody: UpdateOrderContactsInput = {};
      if (
        form.customer_name !== contactName(customer) ||
        form.customer_email !== (customer?.email ?? "") ||
        form.customer_phone !== (customer?.phone ?? "")
      ) {
        contactsBody.customer = {
          name: emptyToNull(form.customer_name),
          email: emptyToNull(form.customer_email),
          phone: emptyToNull(form.customer_phone),
        };
      }
      if (
        form.recipient_name !== contactName(recipient) ||
        form.recipient_phone !== (recipient?.phone ?? "")
      ) {
        contactsBody.recipient = {
          name: emptyToNull(form.recipient_name),
          phone: emptyToNull(form.recipient_phone),
        };
      }
      if (contactsBody.customer || contactsBody.recipient) {
        await updateContactsMut.mutateAsync({ id: orderId, data: contactsBody });
      }

      const currentDriver = assignment ? String(assignment.driver_id) : "unassigned";
      if (form.driver_id === "unassigned") {
        // Clear an existing assignment when the owner picks "Unassigned".
        if (currentDriver !== "unassigned") {
          await apiFetch(`/api/fleet/orders/${orderId}/assign-driver`, {
            method: "DELETE",
          });
        }
      } else if (form.driver_id !== currentDriver) {
        // Driver scheduling is synchronized by the authoritative reschedule
        // operation; this call is only needed when the selected driver changes.
        await apiFetch(`/api/fleet/orders/${orderId}/assign-driver`, {
          method: "PATCH",
          body: JSON.stringify({
            driver_id: Number(form.driver_id),
            scheduled_at: fromLocalInput(form.window_start),
          }),
        });
      }

      // Prefix invalidation: the page cache may be keyed by the order number
      // (route param) rather than this dialog's UUID prop.
      await queryClient.invalidateQueries({ queryKey: ["order"] });
      toast({ title: t("orders.editSaved") });
      onOpenChange(false);
    } catch (err) {
      const code = (err as { code?: string } | null)?.code;
      toast({
        title: t("orders.editFailed"),
        description:
          code === "payment_not_paid"
            ? t("orders.markPaidBeforeProcessing")
            : err instanceof Error
              ? err.message
              : String(err),
        variant: "destructive",
      });
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{t("orders.editOrder")}</DialogTitle>
        </DialogHeader>

        <div className="space-y-4 py-2">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div className="space-y-1.5">
              <Label>{t("orders.fieldStatus")}</Label>
              <Select value={form.status} onValueChange={set("status")}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {ORDER_STATUSES.map((s) => (
                    <SelectItem key={s} value={s}>
                      {t(ORDER_STATUS_LABEL_KEYS[s])}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label>{t("orders.fieldDriver")}</Label>
              <Select value={form.driver_id} onValueChange={set("driver_id")}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="unassigned">{t("orders.driverUnassigned")}</SelectItem>
                  {drivers.map((d) => (
                    <SelectItem key={d.id} value={String(d.id)}>
                      {[d.first_name, d.last_name].filter(Boolean).join(" ") || `#${d.id}`}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            <div className="space-y-1.5">
              <Label>{t("orders.orderedAt")}</Label>
              <Input
                type="datetime-local"
                value={form.ordered_at}
                onChange={(e) => set("ordered_at")(e.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label>{t("orders.fieldWindowStart")}</Label>
              <Input
                type="datetime-local"
                value={form.window_start}
                onChange={(e) => set("window_start")(e.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label>{t("orders.fieldWindowEnd")}</Label>
              <Input
                type="datetime-local"
                value={form.window_end}
                onChange={(e) => set("window_end")(e.target.value)}
              />
            </div>
          </div>

          <div className="space-y-1.5">
            <Label>{t("orders.deliveryType")}</Label>
            <Input
              value={form.delivery_type}
              onChange={(e) => set("delivery_type")(e.target.value)}
            />
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div className="space-y-1.5">
              <Label>{t("orders.addressLine1")}</Label>
              <Input value={form.address_1} onChange={(e) => set("address_1")(e.target.value)} />
            </div>
            <div className="space-y-1.5">
              <Label>{t("orders.city")}</Label>
              <Select
                value={form.city || undefined}
                onValueChange={set("city")}
                disabled={cityOptions.length === 0}
              >
                <SelectTrigger>
                  <SelectValue
                    placeholder={
                      cityOptions.length === 0
                        ? t("orders.noCitiesConfigured")
                        : t("orders.selectCity")
                    }
                  />
                </SelectTrigger>
                <SelectContent>
                  {cityOptions.map((c) => (
                    <SelectItem key={c} value={c}>
                      {c}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label>{t("orders.country")}</Label>
              <Select value={form.country || undefined} onValueChange={onCountryChange}>
                <SelectTrigger>
                  <SelectValue placeholder={t("orders.selectCountry")} />
                </SelectTrigger>
                <SelectContent>
                  {countryOptions.map((c) => {
                    const flag = getCountryMetadata(c)?.flagEmoji ?? "";
                    return (
                      <SelectItem key={c} value={c}>
                        {flag ? `${flag} ${c}` : c}
                      </SelectItem>
                    );
                  })}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label>{t("orders.phone")}</Label>
              <Input value={form.phone} onChange={(e) => set("phone")(e.target.value)} />
            </div>
          </div>

          <div className="space-y-1.5">
            <Label>{t("orders.sectionOrderNote")}</Label>
            <Textarea
              rows={2}
              value={form.delivery_instructions}
              onChange={(e) => set("delivery_instructions")(e.target.value)}
            />
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div className="space-y-1.5">
              <Label>{t("orders.noteCustomer")}</Label>
              <Textarea
                rows={2}
                value={form.customer_note}
                onChange={(e) => set("customer_note")(e.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label>{t("orders.noteFlorist")}</Label>
              <Textarea
                rows={2}
                value={form.florist_note}
                onChange={(e) => set("florist_note")(e.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label>{t("orders.noteDriver")}</Label>
              <Textarea
                rows={2}
                value={form.driver_note}
                onChange={(e) => set("driver_note")(e.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label>{t("orders.noteInternal")}</Label>
              <Textarea
                rows={2}
                value={form.internal_note}
                onChange={(e) => set("internal_note")(e.target.value)}
              />
            </div>
          </div>

          <div className="space-y-3 border-t pt-4">
            <p className="text-sm font-medium">{t("orders.sectionContact")}</p>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
              <div className="space-y-1.5">
                <Label>{t("orders.contactName")}</Label>
                <Input
                  value={form.customer_name}
                  onChange={(e) => set("customer_name")(e.target.value)}
                />
              </div>
              <div className="space-y-1.5">
                <Label>{t("orders.contactEmail")}</Label>
                <Input
                  type="email"
                  value={form.customer_email}
                  onChange={(e) => set("customer_email")(e.target.value)}
                />
              </div>
              <div className="space-y-1.5">
                <Label>{t("orders.contactPhone")}</Label>
                <Input
                  value={form.customer_phone}
                  onChange={(e) => set("customer_phone")(e.target.value)}
                />
              </div>
            </div>
          </div>

          <div className="space-y-3 border-t pt-4">
            <p className="text-sm font-medium">{t("orders.sectionRecipient")}</p>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div className="space-y-1.5">
                <Label>{t("orders.contactName")}</Label>
                <Input
                  value={form.recipient_name}
                  onChange={(e) => set("recipient_name")(e.target.value)}
                />
              </div>
              <div className="space-y-1.5">
                <Label>{t("orders.contactPhone")}</Label>
                <Input
                  value={form.recipient_phone}
                  onChange={(e) => set("recipient_phone")(e.target.value)}
                />
              </div>
            </div>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>
            {t("orders.editCancel")}
          </Button>
          <Button onClick={handleSave} disabled={saving}>
            {saving && <Loader2 size={14} className="mr-1 animate-spin" />}
            {t("orders.editSave")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
/** Reasons a staff member can pick when adding a $0 complimentary line item — mirrors COMPLIMENTARY_LINE_ITEM_REASONS on the API server. */
const COMPLIMENTARY_LINE_ITEM_REASONS = [
  "customer_service_gesture",
  "complaint_resolution",
  "vip_gesture",
  "damaged_replacement_item",
  "other",
] as const;

type ComplimentaryLineItemReason = (typeof COMPLIMENTARY_LINE_ITEM_REASONS)[number];

function isComplimentaryReason(value: unknown): value is ComplimentaryLineItemReason {
  return (
    typeof value === "string" &&
    (COMPLIMENTARY_LINE_ITEM_REASONS as readonly string[]).includes(value)
  );
}

function complimentaryReasonLabel(
  reason: unknown,
  t: (key: string, opts?: Record<string, unknown>) => string,
): string {
  return isComplimentaryReason(reason)
    ? t(`orders.complimentaryReason.${reason}`)
    : String(reason ?? "");
}

type ActivityEvent = {
  id: string;
  event_type: string;
  payload?: Record<string, unknown> | null;
  actor_name?: string | null;
  created_at: string;
};

function activityLabel(
  ev: ActivityEvent,
  t: (key: string, opts?: Record<string, unknown>) => string,
): string {
  const p = (ev.payload ?? {}) as Record<string, unknown>;
  const statusLabel = (s: unknown) => {
    const key = ORDER_STATUS_LABEL_KEYS[s as keyof typeof ORDER_STATUS_LABEL_KEYS];
    return key ? t(key) : String(s ?? "");
  };
  switch (ev.event_type) {
    case "order_placed":
      return t("orders.activityOrderPlaced");
    case "status_changed":
      return t("orders.activityStatusChanged", {
        from: statusLabel(p.from),
        to: statusLabel(p.to),
      });
    case "payment_marked_paid":
      return t("orders.activityPaymentMarkedPaid");
    case "refunded_order_restored":
      return t("orders.activityRefundedOrderRestored");
    case "payment_received":
      return t("orders.activityPaymentReceived");
    case "delivery_rescheduled":
      return t("orders.activityDeliveryRescheduled");
    case "discount_applied": {
      const amount = toFiniteNumber(p.amount);
      const currency = typeof p.currency === "string" && p.currency ? p.currency : "USD";
      const reason = typeof p.reason === "string" ? p.reason : "";
      return t("orders.activityDiscountApplied", {
        amount: amount != null ? formatMoney(amount, currency) : "",
        reason,
      });
    }
    case "order_refunded": {
      const amt = toFiniteNumber(p.amount);
      const cur =
        typeof p.currency === "string" && p.currency ? p.currency : "USD";
      if (p.partial === true && amt != null) {
        return t("orders.activityRefundedPartial", {
          amount: formatMoney(amt, cur),
        });
      }
      return t("orders.activityRefunded");
    }
    case "internal_note":
      return typeof p.note === "string" ? p.note : t("orders.activityInternalNote");
    case "contact_updated":
      return t("orders.activityContactUpdated", {
        role:
          p.role === "recipient"
            ? t("orders.sectionRecipient")
            : t("orders.sectionCustomer"),
      });
    case "line_item_added":
      return t("orders.activityLineItemAdded", {
        name: String(p.name ?? ""),
        quantity: String(p.quantity ?? ""),
      });
    case "line_item_removed":
      return t("orders.activityLineItemRemoved", { name: String(p.name ?? "") });
    case "line_item_replaced":
      return t("orders.activityLineItemReplaced", {
        from: String(p.from ?? ""),
        to: String(p.to ?? ""),
      });
    case "line_item_quantity_changed":
      return t("orders.activityLineItemQuantityChanged", {
        name: String(p.name ?? ""),
        from: String(p.from ?? ""),
        to: String(p.to ?? ""),
      });
    case "line_item_custom_input_changed":
      return t("orders.activityLineItemCustomInputChanged", {
        name: String(p.name ?? ""),
      });
    case "line_item_complimentary_added": {
      const value = toFiniteNumber(p.original_value);
      const currency =
        typeof p.currency === "string" && p.currency.trim() ? p.currency.trim().toUpperCase() : "USD";
      const base = t("orders.activityLineItemComplimentaryAdded", {
        name: String(p.name ?? ""),
        quantity: String(p.quantity ?? ""),
        reason: complimentaryReasonLabel(p.reason, t),
        value: value != null ? formatMoney(value, currency) : "",
      });
      const note = typeof p.note === "string" ? p.note.trim() : "";
      return note ? `${base} · ${t("orders.activityComplimentaryNoteSuffix", { note })}` : base;
    }
    case "line_item_complimentary_removed": {
      const value = toFiniteNumber(p.original_value);
      const currency =
        typeof p.currency === "string" && p.currency.trim() ? p.currency.trim().toUpperCase() : "USD";
      const base = t("orders.activityLineItemComplimentaryRemoved", {
        name: String(p.name ?? ""),
        reason: complimentaryReasonLabel(p.reason, t),
        value: value != null ? formatMoney(value, currency) : "",
      });
      const note = typeof p.note === "string" ? p.note.trim() : "";
      return note ? `${base} · ${t("orders.activityComplimentaryNoteSuffix", { note })}` : base;
    }
    case "email_sent":
      return t("orders.activityEmailSent", { to: String(p.to ?? "") });
    case "email_resent":
      return t("orders.activityEmailResent", { to: String(p.to ?? "") });
    case "email_failed":
      return t("orders.activityEmailFailed", { to: String(p.to ?? "") });
    case "email_delivered":
      return t("orders.activityEmailDelivered", { to: String(p.to ?? "") });
    case "email_opened":
      return t("orders.activityEmailOpened", { to: String(p.to ?? "") });
    case "email_bounced":
      return t("orders.activityEmailBounced", { to: String(p.to ?? "") });
    case "whish_payment_instructions_sent":
      return t("orders.activityWhishInstructionsSent", {
        to: String(p.destination ?? ""),
        amount: `${String(p.currency ?? "")} ${String(p.amount ?? "")}`.trim(),
      });
    case "whish_payment_instructions_resent":
      return t("orders.activityWhishInstructionsResent", {
        to: String(p.destination ?? ""),
        amount: `${String(p.currency ?? "")} ${String(p.amount ?? "")}`.trim(),
      });
    case "whish_payment_instructions_failed":
      return t("orders.activityWhishInstructionsFailed", {
        reason: String(p.error ?? ""),
      });
    default:
      return ev.event_type.replace(/_/g, " ");
  }
}

function ActivityCard({ orderId }: { orderId: string }) {
  const { t } = useTranslation();
  const [showAll, setShowAll] = React.useState(false);
  const { data, isLoading } = useListOrderActivity(orderId, {
    query: { queryKey: getListOrderActivityQueryKey(orderId) },
  });
  const events = (data?.events ?? []) as ActivityEvent[];
  const visible = showAll ? events : events.slice(0, 5);
  return (
    <Card data-testid="card-activity">
      <CardHeader className="pb-3">
        <CardTitle className="text-sm font-medium flex items-center gap-2">
          <Activity size={15} className="text-muted-foreground" />
          {t("orders.sectionActivity")}
        </CardTitle>
      </CardHeader>
      <CardContent className="text-sm">
        {isLoading ? (
          <Loader2 size={16} className="animate-spin text-muted-foreground" />
        ) : events.length === 0 ? (
          <p className="text-muted-foreground italic">{t("orders.activityEmpty")}</p>
        ) : (
          <ul className="space-y-3">
            {visible.map((ev) => (
              <li key={ev.id} className="flex gap-2.5">
                <span className="mt-1.5 w-1.5 h-1.5 rounded-full bg-primary shrink-0" />
                <div className="min-w-0">
                  <p className="text-foreground break-words">{activityLabel(ev, t)}</p>
                  <p className="text-xs text-muted-foreground">
                    {formatDateTime(ev.created_at)}
                    {ev.actor_name ? ` · ${ev.actor_name}` : ""}
                  </p>
                </div>
              </li>
            ))}
          </ul>
        )}
        {events.length > 5 && (
          <Button
            variant="link"
            size="sm"
            className="px-0 mt-2 h-auto text-xs"
            onClick={() => setShowAll((v) => !v)}
          >
            {showAll ? t("orders.showLessActivity") : t("orders.viewAllActivity")}
          </Button>
        )}
      </CardContent>
    </Card>
  );
}

function errorMessage(err: unknown): string {
  if (err instanceof Error && err.message) return err.message;
  return String(err);
}

// ── Line items editing ───────────────────────────────────────────────────────

type ProductSearchRow = {
  id: number;
  name: string;
  sku: string | null;
  unit_price: number | null;
  currency: string;
  image_url: string | null;
  status: string;
  available: boolean;
  price_error: string | null;
};

function productThumbUrl(p: ProductSearchRow): string | null {
  const u = (p.image_url ?? "").trim();
  if (!u) return null;
  if (/^https?:\/\//i.test(u)) return u;
  if (u.startsWith("/objects/")) return `/api/storage${u}`;
  return u.startsWith("/") ? u : null;
}

function productPriceLabel(p: ProductSearchRow): string {
  return p.unit_price != null ? formatPaidCurrency(p.unit_price, p.currency) : "—";
}

const MAX_CUSTOM_INPUT = 22;

type LineItemDialogState =
  | { type: "add" }
  | { type: "replace"; item: LineItem }
  | { type: "quantity"; item: LineItem }
  | { type: "customInput"; item: LineItem }
  | { type: "remove"; item: LineItem }
  | null;

function ProductPickerDialog({
  mode,
  item,
  orderId,
  onClose,
}: {
  mode: "add" | "replace";
  item?: LineItem;
  orderId: string;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [search, setSearch] = React.useState("");
  const [debouncedSearch, setDebouncedSearch] = React.useState("");
  const [selected, setSelected] = React.useState<ProductSearchRow | null>(null);
  const [quantity, setQuantity] = React.useState(1);
  const [customInput, setCustomInput] = React.useState("");
  const [pricingMode, setPricingMode] = React.useState<"regular" | "complimentary">("regular");
  const [complimentaryReason, setComplimentaryReason] = React.useState<ComplimentaryLineItemReason | "">("");
  const [complimentaryNote, setComplimentaryNote] = React.useState("");

  React.useEffect(() => {
    const timer = window.setTimeout(() => setDebouncedSearch(search.trim()), 300);
    return () => window.clearTimeout(timer);
  }, [search]);

  const catalogParams = { q: debouncedSearch || undefined, page_size: 25 };
  const addCatalogQuery = useListOrderLineItemCatalog(orderId, catalogParams, {
    query: {
      queryKey: getListOrderLineItemCatalogQueryKey(orderId, catalogParams),
      enabled: mode === "add",
      retry: false,
    },
  });
  const replaceCatalogQuery = useQuery<{
    products: Array<{
      id: number;
      name: string;
      sku: string | null;
      price_usd: string | number | null;
      discount_price_usd: string | number | null;
      main_image_url: string | null;
      status: string;
    }>;
  }>({
    queryKey: ["order-line-item-product-search", debouncedSearch],
    queryFn: () =>
      apiFetch(`/api/products?pageSize=25${debouncedSearch ? `&q=${encodeURIComponent(debouncedSearch)}` : ""}`),
    enabled: mode === "replace",
  });
  const addCatalog = addCatalogQuery.data;
  const products: ProductSearchRow[] =
    mode === "add"
      ? (addCatalog?.products ?? []).map((product: OrderLineItemCatalogProduct) => ({
          ...product,
          image_url: product.image_url ?? null,
          price_error: product.price_error ?? null,
        }))
      : (replaceCatalogQuery.data?.products ?? []).map((product) => {
          const price =
            toFiniteNumber(product.discount_price_usd) ?? toFiniteNumber(product.price_usd);
          return {
            id: product.id,
            name: product.name,
            sku: product.sku,
            unit_price: price,
            currency: "USD",
            image_url: product.main_image_url,
            status: product.status,
            available: price != null,
            price_error: price == null ? t("orders.productPriceUnavailable") : null,
          };
        });
  const activeQuery = mode === "add" ? addCatalogQuery : replaceCatalogQuery;
  const isLoading = activeQuery.isLoading || (mode === "add" && search.trim() !== debouncedSearch);
  const isError = activeQuery.isError;

  const invalidate = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ["order", orderId] }),
      queryClient.invalidateQueries({ queryKey: getListOrderActivityQueryKey(orderId) }),
    ]);
  };

  const addMutation = useAddOrderLineItem({
    mutation: {
      onSuccess: async () => {
        await invalidate();
        toast({ title: t("orders.lineItemAdded") });
        onClose();
      },
      onError: (err) =>
        toast({ title: t("orders.lineItemEditFailed"), description: errorMessage(err), variant: "destructive" }),
    },
  });
  const replaceMutation = useUpdateOrderLineItem({
    mutation: {
      onSuccess: async () => {
        await invalidate();
        toast({ title: t("orders.lineItemReplaced") });
        onClose();
      },
      onError: (err) =>
        toast({ title: t("orders.lineItemEditFailed"), description: errorMessage(err), variant: "destructive" }),
    },
  });

  const pending = addMutation.isPending || replaceMutation.isPending;
  const qty = quantity;
  const qtyValid = Number.isFinite(qty) && qty >= 1 && qty <= 999;
  const isComplimentary = mode === "add" && pricingMode === "complimentary";
  const complimentaryNoteRequired = isComplimentary && complimentaryReason === "other";
  const complimentaryValid =
    !isComplimentary ||
    (complimentaryReason !== "" && (!complimentaryNoteRequired || complimentaryNote.trim() !== ""));
  const canSave =
    selected != null &&
    selected.available &&
    selected.unit_price != null &&
    (mode === "replace" || qtyValid) &&
    complimentaryValid &&
    !pending;

  const handleSave = () => {
    if (!selected) return;
    if (mode === "add") {
      addMutation.mutate({
        id: orderId,
        data: {
          product_id: selected.id,
          quantity: qty,
          ...(customInput.trim() ? { custom_input: customInput.trim() } : {}),
          ...(isComplimentary && complimentaryReason !== ""
            ? {
                complimentary: {
                  reason: complimentaryReason,
                  ...(complimentaryNote.trim() ? { note: complimentaryNote.trim() } : {}),
                },
              }
            : {}),
        },
      });
    } else if (item) {
      replaceMutation.mutate({
        id: orderId,
        itemId: item.id,
        data: { product_id: selected.id },
      });
    }
  };

  const catalogUnitPrice = selected?.unit_price ?? 0;
  const complimentaryOriginalValue = qtyValid ? catalogUnitPrice * qty : catalogUnitPrice;
  const formattedOriginalValue = selected
    ? formatPaidCurrency(complimentaryOriginalValue, selected.currency)
    : "—";
  const formattedZero = selected ? formatPaidCurrency(0, selected.currency) : "—";
  const isSelectionStep = mode === "add" && selected == null;

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent
        className="w-[calc(100vw-2rem)] sm:max-w-[740px] h-[min(680px,calc(100dvh-2rem))] max-h-[calc(100dvh-2rem)] flex flex-col overflow-hidden p-0 gap-0"
        style={{ display: "flex" }}
      >
        <DialogHeader className="px-5 sm:px-6 pt-5 sm:pt-6 pb-4 border-b">
          <DialogTitle>
            {mode === "add" ? t("orders.addProductTitle") : t("orders.replaceProductTitle")}
          </DialogTitle>
          <DialogDescription>
            {mode === "add" && isSelectionStep
              ? t("orders.addProductSelectionDesc")
              : mode === "add"
                ? t("orders.addProductConfigurationDesc")
              : t("orders.replaceProductDesc", { name: item?.name ?? "" })}
          </DialogDescription>
        </DialogHeader>
        <div className="flex-1 min-h-0 overflow-y-auto px-5 sm:px-6 py-5">
        {(isSelectionStep || mode === "replace") ? (
          <div className="space-y-4">
            <div className="relative">
              <Search size={16} className="absolute start-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
              <Input
                autoFocus
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder={t("orders.searchProducts")}
                className="ps-9 h-11"
                aria-label={t("orders.searchProducts")}
                data-testid="input-line-item-product-search"
              />
            </div>
            {mode === "add" && addCatalog && (
              <div className="inline-flex items-center rounded-md border px-2.5 py-1.5 text-xs font-medium">
                {addCatalog.market.label} · {addCatalog.market.currency}
              </div>
            )}
            <div className="flex items-center justify-between text-sm">
              <span className="font-medium">{t("orders.productsLabel")}</span>
              {mode === "add" && addCatalog && (
                <span className="text-muted-foreground">
                  {t("orders.productResultsCount", { count: addCatalog.total })}
                </span>
              )}
            </div>
            <div
              className="h-[330px] overflow-y-auto border border-border rounded-lg divide-y divide-border"
              aria-live="polite"
              data-testid="line-item-product-results"
            >
              {isLoading ? (
                <div className="space-y-1 p-2" role="status" aria-label={t("orders.loadingProducts")}>
                  {[0, 1, 2, 3].map((key) => (
                    <div key={key} className="h-[72px] rounded-md bg-muted animate-pulse" />
                  ))}
                </div>
              ) : isError ? (
                <div className="h-full flex flex-col items-center justify-center gap-3 text-center p-6">
                  <AlertTriangle size={22} className="text-destructive" />
                  <p className="text-sm font-medium">{t("orders.productSearchError")}</p>
                  <Button type="button" variant="outline" size="sm" onClick={() => activeQuery.refetch()}>
                    <RotateCcw size={14} className="me-2" />
                    {t("orders.retryProductSearch")}
                  </Button>
                </div>
              ) : products.length === 0 ? (
                <div className="h-full flex flex-col items-center justify-center text-center p-6">
                  <Package size={24} className="text-muted-foreground mb-2" />
                  <p className="text-sm font-medium">{t("orders.noProductsFound")}</p>
                  <p className="text-xs text-muted-foreground mt-1">{t("orders.noProductsFoundHint")}</p>
                </div>
              ) : (
                products.map((p) => {
                  const thumb = productThumbUrl(p);
                  return (
                    <button
                      key={p.id}
                      type="button"
                      onClick={() => p.available && setSelected(p)}
                      disabled={!p.available}
                      aria-disabled={!p.available}
                      className="w-full min-h-[72px] flex items-center gap-3 px-3 py-2 text-start text-sm hover:bg-secondary/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-inset disabled:cursor-not-allowed disabled:opacity-60"
                      data-testid={`row-line-item-product-${p.id}`}
                    >
                      {thumb ? (
                        <img src={thumb} alt="" className="w-12 h-12 rounded-md object-cover shrink-0" />
                      ) : (
                        <div className="w-12 h-12 rounded-md bg-secondary shrink-0 flex items-center justify-center">
                          <Package size={17} className="text-muted-foreground" />
                        </div>
                      )}
                      <div className="min-w-0 flex-1">
                        <p className="font-medium truncate">{p.name}</p>
                        <p className="text-xs text-muted-foreground truncate">{p.sku || t("orders.noSku")}</p>
                        <p className={cn("text-sm font-medium mt-0.5", !p.available && "text-destructive")}>
                          {p.available ? productPriceLabel(p) : p.price_error}
                        </p>
                      </div>
                      <ChevronRight size={17} className="text-muted-foreground shrink-0 rtl:rotate-180" />
                    </button>
                  );
                })
              )}
            </div>
            <p className="text-xs text-muted-foreground">{t("orders.selectProductToContinue")}</p>
          </div>
        ) : selected ? (
          <div className="space-y-5">
            <div className="flex items-center gap-4 rounded-lg border p-3">
              {productThumbUrl(selected) ? (
                <img src={productThumbUrl(selected)!} alt="" className="h-16 w-16 rounded-md object-cover shrink-0" />
              ) : (
                <div className="h-16 w-16 rounded-md bg-secondary flex items-center justify-center shrink-0">
                  <Package size={20} className="text-muted-foreground" />
                </div>
              )}
              <div className="min-w-0 flex-1">
                <p className="font-semibold truncate">{selected.name}</p>
                <p className="text-xs text-muted-foreground">{selected.sku || t("orders.noSku")}</p>
                <p className="text-sm font-medium mt-1">{productPriceLabel(selected)}</p>
              </div>
              <Button type="button" variant="ghost" size="sm" onClick={() => setSelected(null)} data-testid="button-change-product">
                {t("orders.changeProduct")}
              </Button>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-[120px_1fr] gap-4">
            <div className="space-y-1">
              <Label htmlFor="line-item-qty">{t("orders.colQty")}</Label>
              <div className="h-10 grid grid-cols-3 rounded-md border" role="group" aria-label={t("orders.quantityStepperLabel")}>
                <button type="button" aria-label={t("orders.decreaseQuantity")} disabled={quantity <= 1} onClick={() => setQuantity((v) => Math.max(1, v - 1))} className="flex items-center justify-center border-e disabled:opacity-40" data-testid="button-decrease-quantity">
                  <Minus size={14} />
                </button>
                <output id="line-item-qty" className="flex items-center justify-center text-sm font-medium" data-testid="input-line-item-quantity">{quantity}</output>
                <button type="button" aria-label={t("orders.increaseQuantity")} disabled={quantity >= 999} onClick={() => setQuantity((v) => Math.min(999, v + 1))} className="flex items-center justify-center border-s" data-testid="button-increase-quantity">
                  <Plus size={14} />
                </button>
              </div>
            </div>
            <div className="space-y-1">
              <Label htmlFor="line-item-custom">{t("orders.productCustomizationOptional")}</Label>
              <Input
                id="line-item-custom"
                maxLength={MAX_CUSTOM_INPUT}
                value={customInput}
                onChange={(e) => setCustomInput(e.target.value)}
                placeholder={t("orders.productCustomizationPlaceholder")}
                data-testid="input-line-item-custom-input"
              />
            </div>
          </div>
          <div className="space-y-3">
            <p className="text-sm font-medium">{t("orders.pricingLabel")}</p>
            <RadioGroup
              value={pricingMode}
              onValueChange={(v) => setPricingMode(v as "regular" | "complimentary")}
              className="grid grid-cols-2 gap-2"
            >
              <Label
                htmlFor="pricing-regular"
                className={cn(
                  "flex flex-col gap-1 rounded-md border px-3 py-2 text-sm cursor-pointer transition-colors",
                  pricingMode === "regular"
                    ? "border-primary bg-primary/5 font-medium"
                    : "border-border hover:bg-secondary/40",
                )}
              >
                <span className="flex items-center gap-2">
                  <RadioGroupItem value="regular" id="pricing-regular" data-testid="radio-pricing-regular" />
                  {t("orders.pricingRegular")}
                </span>
                <span className="text-xs text-muted-foreground ps-6">
                  {t("orders.customerPaysAmount", { amount: formattedOriginalValue })}
                </span>
              </Label>
              <Label
                htmlFor="pricing-complimentary"
                className={cn(
                  "flex flex-col gap-1 rounded-md border px-3 py-2 text-sm cursor-pointer transition-colors",
                  pricingMode === "complimentary"
                    ? "border-primary bg-primary/5 font-medium"
                    : "border-border hover:bg-secondary/40",
                )}
              >
                <span className="flex items-center gap-2">
                  <RadioGroupItem
                    value="complimentary"
                    id="pricing-complimentary"
                    data-testid="radio-pricing-complimentary"
                  />
                  {t("orders.pricingComplimentary")}
                </span>
                <span className="text-xs text-muted-foreground ps-6">
                  {t("orders.customerPaysAmount", { amount: formattedZero })}
                </span>
              </Label>
            </RadioGroup>

            {isComplimentary && (
              <div className="space-y-4 pt-1">
                <div className="rounded-lg border border-emerald-200 bg-emerald-50 p-3 text-emerald-900">
                  <p className="text-sm font-semibold flex items-center gap-2">
                    <HeartHandshake size={16} />
                    {t("orders.complimentaryItemTitle")}
                  </p>
                  <p className="text-xs mt-1" data-testid="text-complimentary-summary">
                    {t("orders.complimentarySummary", {
                      original: formattedOriginalValue,
                      customerPays: formattedZero,
                    })}
                  </p>
                </div>
                <div className="space-y-1">
                  <Label htmlFor="complimentary-reason">
                    {t("orders.complimentaryReasonLabel")} <span className="text-destructive">*</span>
                  </Label>
                  <Select
                    value={complimentaryReason}
                    onValueChange={(v) => setComplimentaryReason(v as ComplimentaryLineItemReason)}
                  >
                    <SelectTrigger id="complimentary-reason" data-testid="select-complimentary-reason">
                      <SelectValue placeholder={t("orders.complimentaryReasonPlaceholder")} />
                    </SelectTrigger>
                    <SelectContent>
                      {COMPLIMENTARY_LINE_ITEM_REASONS.map((reason) => (
                        <SelectItem key={reason} value={reason} data-testid={`option-complimentary-reason-${reason}`}>
                          {t(`orders.complimentaryReason.${reason}`)}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-1">
                  <Label htmlFor="complimentary-note">
                    {t("orders.complimentaryNoteLabel")}
                    {complimentaryNoteRequired && <span className="text-destructive"> *</span>}
                  </Label>
                  <Textarea
                    id="complimentary-note"
                    value={complimentaryNote}
                    onChange={(e) => setComplimentaryNote(e.target.value)}
                    placeholder={
                      complimentaryNoteRequired
                        ? t("orders.complimentaryNoteRequiredPlaceholder")
                        : t("orders.complimentaryNoteOptionalPlaceholder")
                    }
                    maxLength={1000}
                    rows={2}
                    data-testid="input-complimentary-note"
                  />
                </div>
              </div>
            )}
          </div>
          </div>
        ) : null}
        </div>
        <DialogFooter className="shrink-0 border-t bg-background px-5 sm:px-6 py-4">
          <Button variant="outline" onClick={onClose} disabled={pending}>
            {t("common.cancel")}
          </Button>
          {!isSelectionStep && (
            <Button onClick={handleSave} disabled={!canSave} data-testid="button-line-item-save">
              {pending && <Loader2 size={14} className="animate-spin me-1" />}
              {isComplimentary ? t("orders.addComplimentaryItem") : mode === "add" ? t("orders.addProduct") : t("orders.replaceProduct")}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function LineItemQuantityDialog({
  item,
  orderId,
  onClose,
}: {
  item: LineItem;
  orderId: string;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [quantity, setQuantity] = React.useState(String(item.quantity ?? 1));

  const mutation = useUpdateOrderLineItem({
    mutation: {
      onSuccess: async () => {
        await Promise.all([
          queryClient.invalidateQueries({ queryKey: ["order", orderId] }),
          queryClient.invalidateQueries({ queryKey: getListOrderActivityQueryKey(orderId) }),
        ]);
        toast({ title: t("orders.lineItemUpdated") });
        onClose();
      },
      onError: (err) =>
        toast({ title: t("orders.lineItemEditFailed"), description: errorMessage(err), variant: "destructive" }),
    },
  });

  const qty = parseInt(quantity, 10);
  const qtyValid = Number.isFinite(qty) && qty >= 1 && qty <= 999;

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>{t("orders.editQuantityTitle")}</DialogTitle>
          <DialogDescription>{item.name}</DialogDescription>
        </DialogHeader>
        <div className="space-y-1">
          <Label htmlFor="edit-qty">{t("orders.colQty")}</Label>
          <Input
            id="edit-qty"
            type="number"
            min={1}
            max={999}
            value={quantity}
            onChange={(e) => setQuantity(e.target.value)}
            data-testid="input-edit-quantity"
          />
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={mutation.isPending}>
            {t("common.cancel")}
          </Button>
          <Button
            onClick={() => mutation.mutate({ id: orderId, itemId: item.id, data: { quantity: qty } })}
            disabled={!qtyValid || mutation.isPending}
            data-testid="button-save-quantity"
          >
            {mutation.isPending && <Loader2 size={14} className="animate-spin me-1" />}
            {t("common.save")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function LineItemCustomInputDialog({
  item,
  orderId,
  onClose,
}: {
  item: LineItem;
  orderId: string;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [value, setValue] = React.useState(item.custom_input ?? "");

  const mutation = useUpdateOrderLineItem({
    mutation: {
      onSuccess: async () => {
        await Promise.all([
          queryClient.invalidateQueries({ queryKey: ["order", orderId] }),
          queryClient.invalidateQueries({ queryKey: getListOrderActivityQueryKey(orderId) }),
        ]);
        toast({ title: t("orders.lineItemUpdated") });
        onClose();
      },
      onError: (err) =>
        toast({ title: t("orders.lineItemEditFailed"), description: errorMessage(err), variant: "destructive" }),
    },
  });

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>{t("orders.editCustomInputTitle")}</DialogTitle>
          <DialogDescription>{item.name}</DialogDescription>
        </DialogHeader>
        <div className="space-y-1">
          <Label htmlFor="edit-custom-input">{t("orders.customInput")}</Label>
          <Input
            id="edit-custom-input"
            maxLength={MAX_CUSTOM_INPUT}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            data-testid="input-edit-custom-input"
          />
          <p className="text-xs text-muted-foreground">
            {t("orders.customInputHint", { max: MAX_CUSTOM_INPUT })}
          </p>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={mutation.isPending}>
            {t("common.cancel")}
          </Button>
          <Button
            onClick={() =>
              mutation.mutate({
                id: orderId,
                itemId: item.id,
                data: { custom_input: value.trim() === "" ? null : value.trim() },
              })
            }
            disabled={mutation.isPending}
            data-testid="button-save-custom-input"
          >
            {mutation.isPending && <Loader2 size={14} className="animate-spin me-1" />}
            {t("common.save")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function LineItemRemoveDialog({
  item,
  orderId,
  isLast,
  onClose,
}: {
  item: LineItem;
  orderId: string;
  isLast: boolean;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const mutation = useRemoveOrderLineItem({
    mutation: {
      onSuccess: async () => {
        await Promise.all([
          queryClient.invalidateQueries({ queryKey: ["order", orderId] }),
          queryClient.invalidateQueries({ queryKey: getListOrderActivityQueryKey(orderId) }),
        ]);
        toast({ title: t("orders.lineItemRemoved") });
        onClose();
      },
      onError: (err) =>
        toast({ title: t("orders.lineItemEditFailed"), description: errorMessage(err), variant: "destructive" }),
    },
  });

  return (
    <AlertDialog open onOpenChange={(open) => !open && onClose()}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{t("orders.removeProductTitle")}</AlertDialogTitle>
          <AlertDialogDescription>
            {isLast
              ? t("orders.cannotRemoveLastItem")
              : t("orders.removeProductDesc", { name: item.name })}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={mutation.isPending}>{t("common.cancel")}</AlertDialogCancel>
          {!isLast && (
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={(e) => {
                e.preventDefault();
                mutation.mutate({ id: orderId, itemId: item.id });
              }}
              data-testid="button-confirm-remove-line-item"
            >
              {mutation.isPending && <Loader2 size={14} className="animate-spin me-1" />}
              {t("orders.removeProduct")}
            </AlertDialogAction>
          )}
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

/**
 * Tookan statuses meaning the driver has the order — mirrors the backend
 * lock in the line-item routes (`started` / `in_progress` / `arrived` are
 * shown as the "out for delivery" family on the Tookan badge).
 */
const TOOKAN_OUT_FOR_DELIVERY = new Set(["started", "in_progress", "arrived"]);
/** Fleet-driver assignment statuses meaning the driver has picked up the order. */
const FLEET_OUT_FOR_DELIVERY = new Set(["picked_up", "out_for_delivery"]);

function LineItemsSection({
  orderId,
  order,
  assignment,
  lineItems,
  edited,
  canEdit,
}: {
  orderId: string;
  order: OrderDetail;
  assignment: Assignment | null;
  lineItems: LineItem[];
  edited: boolean;
  canEdit: boolean;
}) {
  const { t } = useTranslation();
  const [dialog, setDialog] = React.useState<LineItemDialogState>(null);
  // Non-null only when the order was paid in a non-USD currency: line items
  // and the subtotal are then displayed in the paid currency using the
  // order's implied rate (paid_total ÷ USD total).
  const paidConversion = getPaidCurrencyConversion(order);
  // Paid-currency label used with the ACTUALLY-CHARGED per-line amounts
  // (paid_unit_price / paid_line_total stored at ingest). Lines that carry
  // these fields render them verbatim — matching what the customer's cart
  // charged — instead of the implied-rate conversion of the base USD price.
  const paidCurrency = getPaidOrderCurrency(order);
  // Completed orders (incl. legacy "delivered") are locked: line items can
  // no longer be added, edited, replaced, or removed. Orders out for delivery
  // (order status, Tookan job started, or fleet driver picked up) are equally
  // locked. Mirrors the server-side guard on the line-item routes.
  const completedLocked = normalizeOrderStatus(order.status) === "completed";
  const outForDeliveryLocked =
    !completedLocked &&
    (normalizeOrderStatus(order.status) === "out_for_delivery" ||
      TOOKAN_OUT_FOR_DELIVERY.has((order.tookan_status ?? "").trim().toLowerCase()) ||
      FLEET_OUT_FOR_DELIVERY.has(
        (assignment?.assignment_status ?? "").trim().toLowerCase(),
      ));
  const orderLocked = completedLocked || outForDeliveryLocked;
  const canModify = canEdit && !orderLocked;
  const complimentaryItems = lineItems.filter((li) => li.is_complimentary);

  if (lineItems.length === 0 && !canEdit) return null;

  return (
    <>
      <Card data-testid="card-line-items">
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between gap-2 flex-wrap">
            <CardTitle className="text-sm font-medium flex items-center gap-2">
              <ShoppingCart size={15} className="text-muted-foreground" />
              {t("orders.sectionLineItems")} ({lineItems.length})
              {edited && (
                <Badge
                  variant="outline"
                  className="bg-amber-50 text-amber-800 border-amber-300 font-medium"
                  data-testid="badge-line-items-edited"
                >
                  {t("orders.editedBadge")}
                </Badge>
              )}
            </CardTitle>
            {canModify && (
              <Button
                size="sm"
                variant="outline"
                className="gap-1"
                onClick={() => setDialog({ type: "add" })}
                data-testid="button-add-product"
              >
                <Plus size={14} />
                {t("orders.addProduct")}
              </Button>
            )}
            {canEdit && orderLocked && (
              <span
                className="flex items-center gap-1.5 text-xs text-muted-foreground"
                data-testid="text-line-items-locked"
              >
                <Lock size={12} className="shrink-0" />
                {outForDeliveryLocked
                  ? t("orders.lineItemsLockedOutForDeliveryHint")
                  : t("orders.lineItemsLockedHint")}
              </span>
            )}
          </div>
        </CardHeader>
        <CardContent className="p-0">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-secondary/40 border-b border-border">
                <th className="text-left px-4 py-2 font-medium text-muted-foreground">{t("orders.colItemName")}</th>
                <th className="text-left px-4 py-2 font-medium text-muted-foreground hidden sm:table-cell">{t("orders.colSku")}</th>
                <th className="text-right px-4 py-2 font-medium text-muted-foreground">{t("orders.colQty")}</th>
                <th className="text-right px-4 py-2 font-medium text-muted-foreground hidden md:table-cell">{t("orders.colUnitPrice")}</th>
                <th className="text-right px-4 py-2 font-medium text-muted-foreground">{t("orders.colItemTotal")}</th>
                {canModify && <th className="w-10 px-2 py-2" aria-label={t("orders.colActions")} />}
              </tr>
            </thead>
            <tbody>
              {lineItems.map((item, i) => (
                <tr
                  key={item.id}
                  className={`border-b border-border last:border-0 ${i % 2 === 0 ? "" : "bg-secondary/10"}`}
                  data-testid={`row-line-item-${item.id}`}
                >
                  <td className="px-4 py-2.5">
                    {item.product_id != null ? (
                      <Link
                        href={`/products/${item.product_id}`}
                        className="flex items-center gap-2 group cursor-pointer"
                      >
                        {item.image_url && (
                          <img
                            src={imageUrl(item.image_url) ?? undefined}
                            alt={item.name}
                            className="w-8 h-8 rounded object-cover shrink-0"
                          />
                        )}
                        <span className="font-medium text-primary group-hover:underline">
                          {item.name}
                        </span>
                        {item.is_complimentary && (
                          <span
                            className="inline-flex items-center gap-1 rounded-sm bg-violet-100 px-1.5 py-0.5 text-xs font-medium text-violet-700 shrink-0"
                            data-testid={`badge-complimentary-${item.id}`}
                          >
                            <HeartHandshake size={11} />
                            {t("orders.complimentaryBadge")}
                          </span>
                        )}
                      </Link>
                    ) : (
                      <div className="flex items-center gap-2">
                        {item.image_url && (
                          <img
                            src={imageUrl(item.image_url) ?? undefined}
                            alt={item.name}
                            className="w-8 h-8 rounded object-cover shrink-0"
                          />
                        )}
                        <span className="font-medium">{item.name}</span>
                        {item.is_custom_item && (
                          <span className="inline-flex items-center rounded-sm bg-violet-100 px-1.5 py-0.5 text-xs font-medium text-violet-700 shrink-0">
                            {t("orders.customItem.badge")}
                          </span>
                        )}
                        {item.is_complimentary && (
                          <span
                            className="inline-flex items-center gap-1 rounded-sm bg-violet-100 px-1.5 py-0.5 text-xs font-medium text-violet-700 shrink-0"
                            data-testid={`badge-complimentary-${item.id}`}
                          >
                            <HeartHandshake size={11} />
                            {t("orders.complimentaryBadge")}
                          </span>
                        )}
                      </div>
                    )}
                    {item.custom_input && (
                      <p className="mt-1 text-xs text-muted-foreground">
                        {t("orders.customInput")}: <span className="font-medium text-foreground">{item.custom_input}</span>
                      </p>
                    )}
                    {item.is_custom_item && item.production_instructions && (
                      <p className="mt-1 text-xs text-muted-foreground">
                        {t("orders.customItem.productionInstructions")}: <span className="font-medium text-foreground">{item.production_instructions}</span>
                      </p>
                    )}
                  </td>
                  <td className="px-4 py-2.5 text-muted-foreground hidden sm:table-cell">
                    {item.sku ?? "—"}
                  </td>
                  <td className={`px-4 py-2.5 text-right ${Number(item.quantity) > 1 ? "font-bold text-destructive" : ""}`}>{item.quantity}</td>
                  <td className="px-4 py-2.5 text-right text-muted-foreground hidden md:table-cell">
                    {(() => {
                      if (item.is_complimentary) {
                        const original = toFiniteNumber(item.complimentary_original_price) ?? 0;
                        const immutableDisplay = complimentaryDisplayValue(item);
                        const originalDisplay = immutableDisplay
                          ? formatPaidCurrency(immutableDisplay.amount, immutableDisplay.currency)
                          : paidConversion
                            ? formatPaidCurrency(
                                convertToPaidCurrency(original, paidConversion),
                                paidConversion.currency,
                              )
                            : original.toFixed(2);
                        const zeroDisplay = immutableDisplay
                          ? formatPaidCurrency(0, immutableDisplay.currency)
                          : paidConversion
                            ? formatPaidCurrency(0, paidConversion.currency)
                            : (0).toFixed(2);
                        return (
                          <span
                            className="inline-flex flex-col items-end gap-0.5"
                            data-testid={`text-complimentary-original-price-${item.id}`}
                          >
                            <span className="text-xs line-through text-muted-foreground/70">
                              {originalDisplay}
                            </span>
                            <span className="text-emerald-600 font-semibold">{zeroDisplay}</span>
                          </span>
                        );
                      }
                      // Prefer the actually-charged paid-currency unit price
                      // (external storefront orders); fall back to the base
                      // USD price (implied-rate converted for non-USD orders).
                      const paidUnit = toFiniteNumber(item.paid_unit_price);
                      if (paidCurrency && paidUnit != null) {
                        return formatPaidCurrency(paidUnit, paidCurrency);
                      }
                      if (item.unit_price == null) return "—";
                      return paidConversion
                        ? formatPaidCurrency(
                            convertToPaidCurrency(Number(item.unit_price), paidConversion),
                            paidConversion.currency,
                          )
                        : Number(item.unit_price).toFixed(2);
                    })()}
                  </td>
                  <td
                    className={`px-4 py-2.5 text-right font-medium ${item.is_complimentary ? "text-emerald-600" : ""}`}
                  >
                    {(() => {
                      const lineTotal = toFiniteNumber(item.line_total ?? item.total);
                      // Prefer the actually-charged paid-currency line total,
                      // with the base USD amount as the secondary "≈" line.
                      const paidLineTotal = toFiniteNumber(item.paid_line_total);
                      if (paidCurrency && paidLineTotal != null) {
                        return (
                          <span className="inline-flex flex-col items-end">
                            <span>{formatPaidCurrency(paidLineTotal, paidCurrency)}</span>
                            {lineTotal != null && lineTotal !== paidLineTotal && (
                              <span className="text-xs font-normal text-muted-foreground">
                                ≈ {formatUsd(lineTotal)}
                              </span>
                            )}
                          </span>
                        );
                      }
                      if (lineTotal == null) return "—";
                      if (!paidConversion) return lineTotal.toFixed(2);
                      return (
                        <span className="inline-flex flex-col items-end">
                          <span>
                            {formatPaidCurrency(
                              convertToPaidCurrency(lineTotal, paidConversion),
                              paidConversion.currency,
                            )}
                          </span>
                          {showsUsdApproximation(paidConversion) && (
                            <span className="text-xs font-normal text-muted-foreground">
                              ≈ {formatUsd(lineTotal)}
                            </span>
                          )}
                        </span>
                      );
                    })()}
                  </td>
                  {canModify && (
                    <td className="px-2 py-2.5 text-right">
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-7 w-7"
                            data-testid={`button-line-item-menu-${item.id}`}
                          >
                            <MoreVertical size={14} />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                          <DropdownMenuItem onClick={() => setDialog({ type: "quantity", item })}>
                            {t("orders.editQuantity")}
                          </DropdownMenuItem>
                          {!item.is_complimentary && (
                            <DropdownMenuItem onClick={() => setDialog({ type: "replace", item })}>
                              {t("orders.replaceProduct")}
                            </DropdownMenuItem>
                          )}
                          <DropdownMenuItem onClick={() => setDialog({ type: "customInput", item })}>
                            {t("orders.editCustomInput")}
                          </DropdownMenuItem>
                          <DropdownMenuSeparator />
                          <DropdownMenuItem
                            className="text-destructive focus:text-destructive"
                            onClick={() => setDialog({ type: "remove", item })}
                          >
                            {t("orders.removeProduct")}
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </td>
                  )}
                </tr>
              ))}
              {lineItems.length === 0 && (
                <tr>
                  <td
                    colSpan={canModify ? 6 : 5}
                    className="px-4 py-6 text-center text-muted-foreground italic"
                  >
                    {t("orders.noLineItems")}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
          {(() => {
            const totals = (order.totals ?? {}) as Record<string, unknown>;
            const subtotal = toFiniteNumber(totals.subtotal);
            // Actually-charged paid-currency subtotal / delivery fee stored at
            // ingest (external storefront orders). Rendered verbatim when
            // present so the summary matches the displayed paid line totals.
            const paidSubtotal = paidCurrency ? toFiniteNumber(totals.paid_subtotal) : null;
            const paidShipping = paidCurrency ? toFiniteNumber(totals.paid_shipping) : null;
            const deliveryFee =
              toFiniteNumber(totals.shipping) ??
              toFiniteNumber(totals.delivery_fee) ??
              toFiniteNumber(totals.shipping_total);
            // Discount (USD): prefer totals.discount, fall back to the
            // coupon-redemption ledger amount resolved server-side. Only
            // rendered when non-zero so discount-free orders are unchanged.
            const totalsDiscount = toFiniteNumber(totals.discount);
            const couponDiscount = toFiniteNumber(order.coupon_discount_usd);
            const discount =
              totalsDiscount != null && totalsDiscount > 0
                ? totalsDiscount
                : couponDiscount != null && couponDiscount > 0
                  ? couponDiscount
                  : null;
            const couponCode =
              typeof order.coupon_code === "string" && order.coupon_code.trim() !== ""
                ? order.coupon_code.trim()
                : null;
            const cmcDiscount =
              totals.cmc_discount && typeof totals.cmc_discount === "object"
                ? (totals.cmc_discount as Record<string, unknown>)
                : null;
            const cmcDiscountReason =
              typeof cmcDiscount?.reason === "string" && cmcDiscount.reason.trim() !== ""
                ? cmcDiscount.reason.trim()
                : null;
            // Present when the order has at least one complimentary line item:
            // merchandise_subtotal is the full retail value of every item
            // (including complimentary ones at their catalog price), and
            // complimentary_total is the negative retail value being waived.
            const merchandiseSubtotal = toFiniteNumber(totals.merchandise_subtotal);
            const complimentaryTotal = toFiniteNumber(totals.complimentary_total);
            const hasComplimentary = merchandiseSubtotal != null && complimentaryTotal != null;
            const formatSummaryAmount = (amount: number, negative = false) => {
              const sign = negative ? -1 : 1;
              if (paidConversion) {
                return (
                  <>
                    {negative && "-"}
                    {formatPaidCurrency(
                      convertToPaidCurrency(amount, paidConversion),
                      paidConversion.currency,
                    )}
                    {showsUsdApproximation(paidConversion) && (
                      <span className="block text-xs text-muted-foreground">
                        ≈ {negative && "-"}
                        {formatUsd(amount)}
                      </span>
                    )}
                  </>
                );
              }
              return `${negative ? "-" : ""}${amount.toFixed(2)}`;
            };
            return (
              <div className="border-t border-border px-4 py-3 flex flex-wrap items-start justify-between gap-4">
                {complimentaryItems.length > 0 && (
                  <div className="flex-1 min-w-[220px] space-y-1.5" data-testid="section-complimentary-summary">
                    {complimentaryItems.map((li) => {
                      const original = toFiniteNumber(li.complimentary_original_price) ?? 0;
                      const qty = toFiniteNumber(li.quantity) ?? 1;
                      const value = Math.round(original * qty * 100) / 100;
                      const immutableDisplay = complimentaryDisplayValue(li, qty);
                      return (
                        <div
                          key={li.id}
                          className="flex items-start gap-2 rounded-md border border-violet-200 bg-violet-50 px-3 py-2 text-xs text-violet-900"
                          data-testid={`text-complimentary-summary-${li.id}`}
                        >
                          <HeartHandshake size={13} className="shrink-0 mt-0.5 text-violet-500" />
                          <span>
                            {t("orders.complimentarySummaryLine", {
                              actor: li.complimentary_added_by || t("orders.complimentarySummaryUnknownActor"),
                              quantity: qty,
                              name: li.name,
                              reason: complimentaryReasonLabel(li.complimentary_reason, t),
                              value: immutableDisplay
                                ? formatPaidCurrency(immutableDisplay.amount, immutableDisplay.currency)
                                : formatUsd(value),
                            })}
                            {li.complimentary_note && li.complimentary_note.trim() && (
                              <span className="block text-violet-700/80">
                                {t("orders.activityComplimentaryNoteSuffix", {
                                  note: li.complimentary_note.trim(),
                                })}
                              </span>
                            )}
                          </span>
                        </div>
                      );
                    })}
                  </div>
                )}
                <div className="w-full max-w-xs space-y-1 text-sm ms-auto">
                  {hasComplimentary ? (
                    <>
                      <div className="flex justify-between text-muted-foreground">
                        <span>{t("orders.merchandiseSubtotal")}</span>
                        <span className="text-foreground text-right">
                          {formatSummaryAmount(merchandiseSubtotal!)}
                        </span>
                      </div>
                      <div
                        className="flex justify-between text-muted-foreground"
                        data-testid="row-complimentary-total"
                      >
                        <span>{t("orders.complimentaryItemsTotal")}</span>
                        <span className="text-foreground text-right">
                          {formatSummaryAmount(Math.abs(complimentaryTotal!), true)}
                        </span>
                      </div>
                    </>
                  ) : (
                    (subtotal != null || paidSubtotal != null) && (
                    <div className="flex justify-between text-muted-foreground">
                      <span>{t("orders.subtotal")}</span>
                      <span className="text-foreground text-right">
                        {paidCurrency && paidSubtotal != null ? (
                          <>
                            {formatPaidCurrency(paidSubtotal, paidCurrency)}
                            {subtotal != null && subtotal !== paidSubtotal && (
                              <span className="block text-xs text-muted-foreground">
                                ≈ {formatUsd(subtotal)}
                              </span>
                            )}
                          </>
                        ) : subtotal == null ? null : paidConversion ? (
                          <>
                            {formatPaidCurrency(
                              convertToPaidCurrency(subtotal, paidConversion),
                              paidConversion.currency,
                            )}
                            {showsUsdApproximation(paidConversion) && (
                              <span className="block text-xs text-muted-foreground">
                                ≈ {formatUsd(subtotal)}
                              </span>
                            )}
                          </>
                        ) : (
                          subtotal.toFixed(2)
                        )}
                      </span>
                    </div>
                    )
                  )}
                  {(deliveryFee != null || paidShipping != null) && (
                    <div className="flex justify-between text-muted-foreground">
                      <span>{t("orders.deliveryFee")}</span>
                      <span className="text-foreground text-right">
                        {paidCurrency && paidShipping != null ? (
                          <>
                            {formatPaidCurrency(paidShipping, paidCurrency)}
                            {deliveryFee != null && deliveryFee !== paidShipping && (
                              <span className="block text-xs text-muted-foreground">
                                ≈ {formatUsd(deliveryFee)}
                              </span>
                            )}
                          </>
                        ) : deliveryFee == null ? null : paidConversion ? (
                          <>
                            {formatPaidCurrency(
                              convertToPaidCurrency(deliveryFee, paidConversion),
                              paidConversion.currency,
                            )}
                            {showsUsdApproximation(paidConversion) && (
                              <span className="block text-xs text-muted-foreground">
                                ≈ {formatUsd(deliveryFee)}
                              </span>
                            )}
                          </>
                        ) : (
                          deliveryFee.toFixed(2)
                        )}
                      </span>
                    </div>
                  )}
                  {discount != null && (
                    <div className="flex justify-between text-muted-foreground">
                      <span>
                        {t("orders.discount")}
                        {couponCode ? ` (${couponCode})` : ""}
                        {!couponCode && cmcDiscountReason ? ` (${cmcDiscountReason})` : ""}
                      </span>
                      <span className="text-foreground text-right">
                        {paidConversion ? (
                          <>
                            -
                            {formatPaidCurrency(
                              convertToPaidCurrency(discount, paidConversion),
                              paidConversion.currency,
                            )}
                            {showsUsdApproximation(paidConversion) && (
                              <span className="block text-xs text-muted-foreground">
                                ≈ -{formatUsd(discount)}
                              </span>
                            )}
                          </>
                        ) : (
                          `-${discount.toFixed(2)}`
                        )}
                      </span>
                    </div>
                  )}
                  <div className="flex justify-between font-semibold pt-1 border-t border-border">
                    <span>{hasComplimentary ? t("orders.customerTotal") : t("orders.total")}</span>
                    <span>{formatTotal(order)}</span>
                  </div>
                  {(() => {
                    const usdEquivalent = resolveUsdEquivalent(order);
                    return usdEquivalent != null ? (
                      <div className="flex justify-end text-xs text-muted-foreground">
                        <span>≈ {formatUsd(usdEquivalent)}</span>
                      </div>
                    ) : null;
                  })()}
                </div>
              </div>
            );
          })()}
          {edited && (
            <div className="border-t border-border px-4 py-2.5 flex items-center gap-2 text-xs text-muted-foreground">
              <History size={13} className="shrink-0" />
              {t("orders.editedNote")}
            </div>
          )}
        </CardContent>
      </Card>

      {dialog?.type === "add" && (
        <ProductPickerDialog mode="add" orderId={orderId} onClose={() => setDialog(null)} />
      )}
      {dialog?.type === "replace" && (
        <ProductPickerDialog
          mode="replace"
          item={dialog.item}
          orderId={orderId}
          onClose={() => setDialog(null)}
        />
      )}
      {dialog?.type === "quantity" && (
        <LineItemQuantityDialog item={dialog.item} orderId={orderId} onClose={() => setDialog(null)} />
      )}
      {dialog?.type === "customInput" && (
        <LineItemCustomInputDialog item={dialog.item} orderId={orderId} onClose={() => setDialog(null)} />
      )}
      {dialog?.type === "remove" && (
        <LineItemRemoveDialog
          item={dialog.item}
          orderId={orderId}
          isLast={lineItems.length <= 1}
          onClose={() => setDialog(null)}
        />
      )}
    </>
  );
}

function InternalNotesCard({
  orderId,
  legacyNote,
  canEdit,
}: {
  orderId: string;
  legacyNote: string | null;
  canEdit: boolean;
}) {
  const { t } = useTranslation();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [note, setNote] = React.useState("");
  const addNoteMut = useAddOrderInternalNote();
  const { data } = useListOrderActivity(orderId, {
    query: { queryKey: getListOrderActivityQueryKey(orderId) },
  });
  const noteEvents = ((data?.events ?? []) as ActivityEvent[]).filter(
    (ev) => ev.event_type === "internal_note",
  );

  const handleAdd = () => {
    const trimmed = note.trim();
    if (!trimmed) return;
    addNoteMut.mutate(
      { id: orderId, data: { note: trimmed } },
      {
        onSuccess: () => {
          setNote("");
          void queryClient.invalidateQueries({
            queryKey: getListOrderActivityQueryKey(orderId),
          });
          toast({ title: t("orders.noteAdded") });
        },
        onError: (err: unknown) =>
          toast({
            title: t("orders.noteAddFailed"),
            description: err instanceof Error ? err.message : String(err),
            variant: "destructive",
          }),
      },
    );
  };

  return (
    <Card data-testid="card-internal-notes">
      <CardHeader className="pb-3">
        <CardTitle className="text-sm font-medium flex items-center gap-2">
          <StickyNote size={15} className="text-muted-foreground" />
          {t("orders.sectionInternalNotes")}
        </CardTitle>
      </CardHeader>
      <CardContent className="text-sm space-y-3">
        {canEdit && (
          <div className="space-y-2">
            <Textarea
              rows={2}
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder={t("orders.addInternalNotePlaceholder")}
              data-testid="input-internal-note"
            />
            <Button
              size="sm"
              variant="outline"
              onClick={handleAdd}
              disabled={!note.trim() || addNoteMut.isPending}
              data-testid="button-add-internal-note"
            >
              {addNoteMut.isPending ? (
                <Loader2 size={14} className="mr-1.5 animate-spin" />
              ) : null}
              {t("orders.addNote")}
            </Button>
          </div>
        )}
        {noteEvents.length === 0 && !legacyNote ? (
          <p className="text-muted-foreground italic">{t("orders.noInternalNotes")}</p>
        ) : (
          <ul className="space-y-2.5">
            {noteEvents.map((ev) => (
              <li key={ev.id} className="rounded-md border border-border bg-secondary/20 px-3 py-2">
                <p className="whitespace-pre-wrap break-words">
                  {typeof (ev.payload as Record<string, unknown> | null)?.note === "string"
                    ? String((ev.payload as Record<string, unknown>).note)
                    : ""}
                </p>
                <p className="text-xs text-muted-foreground mt-1">
                  {ev.actor_name ?? t("orders.teamNote")} · {formatDateTime(ev.created_at)}
                </p>
              </li>
            ))}
            {legacyNote && (
              <li className="rounded-md border border-border bg-secondary/20 px-3 py-2">
                <p className="whitespace-pre-wrap break-words">{legacyNote}</p>
                <p className="text-xs text-muted-foreground mt-1">{t("orders.teamNote")}</p>
              </li>
            )}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

function AssignDriverDialog({
  orderId,
  assignment,
  open,
  onOpenChange,
}: {
  orderId: string;
  assignment: Assignment | null;
  open: boolean;
  onOpenChange: (v: boolean) => void;
}) {
  const { t } = useTranslation();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [driverId, setDriverId] = React.useState<string>(
    assignment ? String(assignment.driver_id) : "unassigned",
  );
  const [saving, setSaving] = React.useState(false);

  React.useEffect(() => {
    if (open) setDriverId(assignment ? String(assignment.driver_id) : "unassigned");
  }, [open, assignment]);

  const { data: driversData } = useQuery<{ drivers: DriverOption[] }>({
    queryKey: ["fleet-drivers", "order-edit-picker"],
    queryFn: () => apiFetch(`/api/fleet/drivers`),
    enabled: open,
  });
  const drivers = (driversData?.drivers ?? []).filter(
    (d) => (d.onboarding_status ?? "approved") === "approved",
  );

  const handleSave = async () => {
    setSaving(true);
    try {
      const current = assignment ? String(assignment.driver_id) : "unassigned";
      if (driverId === "unassigned") {
        if (current !== "unassigned") {
          await apiFetch(`/api/fleet/orders/${orderId}/assign-driver`, {
            method: "DELETE",
          });
        }
      } else if (driverId !== current) {
        await apiFetch(`/api/fleet/orders/${orderId}/assign-driver`, {
          method: "PATCH",
          body: JSON.stringify({ driver_id: Number(driverId) }),
        });
      }
      // Prefix invalidation: the page cache may be keyed by the order number
      // (route param) rather than this dialog's UUID prop.
      await queryClient.invalidateQueries({ queryKey: ["order"] });
      toast({ title: t("orders.driverAssigned") });
      onOpenChange(false);
    } catch (err) {
      toast({
        title: t("orders.driverAssignFailed"),
        description: err instanceof Error ? err.message : String(err),
        variant: "destructive",
      });
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent data-testid="dialog-assign-driver">
        <DialogHeader>
          <DialogTitle>{t("orders.assignDriver")}</DialogTitle>
          <DialogDescription>{t("orders.assignDriverBody")}</DialogDescription>
        </DialogHeader>
        <div className="py-2 space-y-1.5">
          <Label>{t("orders.driver")}</Label>
          <Select value={driverId} onValueChange={setDriverId}>
            <SelectTrigger className="w-full" data-testid="select-driver">
              <SelectValue placeholder={t("orders.selectDriver")} />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="unassigned">{t("orders.unassigned")}</SelectItem>
              {drivers.map((d) => (
                <SelectItem key={d.id} value={String(d.id)}>
                  {[d.first_name, d.last_name].filter(Boolean).join(" ") || d.phone}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {t("orders.cancel")}
          </Button>
          <Button onClick={handleSave} disabled={saving} data-testid="button-confirm-assign-driver">
            {saving && <Loader2 size={14} className="mr-1.5 animate-spin" />}
            {t("orders.assignDriver")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

type CompactHeaderFloristAssignment = {
  location_id: number;
  location_name?: string | null;
} | null;

function timeInZone(value: string | null, timeZone: string): string {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const get = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((part) => part.type === type)?.value ?? "";
  return `${get("hour")}:${get("minute")}`;
}

function RescheduleDeliveryDialog({
  orderId,
  order,
  timezone,
  open,
  onOpenChange,
  onSuccess,
}: {
  orderId: string;
  order: OrderDetail;
  timezone: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSuccess: () => void;
}) {
  const { t } = useTranslation();
  const [date, setDate] = React.useState("");
  const [deliveryType, setDeliveryType] = React.useState<"standard" | "express">("standard");
  const [selectedSlotId, setSelectedSlotId] = React.useState("");
  const [saving, setSaving] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [autoSelectCurrent, setAutoSelectCurrent] = React.useState(true);

  React.useEffect(() => {
    if (!open) return;
    setDate(
      rescheduleInitialDate(
        {
          windowStart: order.window_start,
          windowEnd: order.window_end,
          legacyDate: order.delivery_address?.date,
          legacySlot: order.delivery_address?.slot,
        },
        timezone,
      ),
    );
    setSelectedSlotId("");
    setDeliveryType(
      order.delivery_type?.trim().toLowerCase() === "express" ? "express" : "standard",
    );
    setAutoSelectCurrent(true);
    setError(null);
  }, [open, order.delivery_address, order.delivery_type, order.window_start, timezone]);

  const optionsQuery = useQuery<RescheduleOptionsResponse>({
    queryKey: ["order-reschedule-options", orderId, date, deliveryType],
    queryFn: () => getOrderRescheduleOptions(orderId, { date, delivery_type: deliveryType }),
    enabled: open && /^\d{4}-\d{2}-\d{2}$/.test(date),
    retry: false,
  });
  const slots = optionsQuery.data?.slots ?? [];

  React.useEffect(() => {
    if (!open || !autoSelectCurrent || selectedSlotId || slots.length === 0) return;
    const currentStart = timeInZone(order.window_start, timezone);
    const currentEnd = timeInZone(order.window_end, timezone);
    const current = slots.find(
      (slot) => slot.start_time === currentStart && slot.end_time === currentEnd,
    );
    if (current) setSelectedSlotId(current.id);
  }, [
    autoSelectCurrent,
    open,
    order.window_end,
    order.window_start,
    selectedSlotId,
    slots,
    timezone,
  ]);

  async function save() {
    const selected = slots.find((slot) => slot.id === selectedSlotId);
    if (!selected) return;
    setSaving(true);
    setError(null);
    try {
      await rescheduleOrderDelivery(
        orderId,
        {
          date,
          slot_id: selected.id,
          start_time: selected.start_time,
          end_time: selected.end_time,
          delivery_type: deliveryType,
        },
      );
      onSuccess();
      onOpenChange(false);
    } catch (err) {
      setAutoSelectCurrent(false);
      setSelectedSlotId("");
      setError(rescheduleErrorMessage(err, t("orders.rescheduleUnexpected")));
      await optionsQuery.refetch();
    } finally {
      setSaving(false);
    }
  }

  const currentSchedule = formatDeliverySchedule(
    resolveDeliverySchedule({
      windowStart: order.window_start,
      windowEnd: order.window_end,
      legacyDate: (order.delivery_address ?? {}).date,
      legacySlot: (order.delivery_address ?? {}).slot,
    }),
    timezone,
  );

  return (
    <Dialog open={open} onOpenChange={saving ? undefined : onOpenChange}>
      <DialogContent className="max-w-md" data-testid="dialog-reschedule-delivery">
        <DialogHeader>
          <DialogTitle>{t("orders.rescheduleTitle")}</DialogTitle>
          <DialogDescription>
            {t("orders.rescheduleCurrent", {
              schedule: currentSchedule?.fullLabel ?? t("orders.noDeliveryDate"),
            })}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4 py-2">
          <div className="space-y-1.5">
            <Label htmlFor="reschedule-delivery-type">
              {t("orders.rescheduleDeliveryType")}
            </Label>
            <Select
              value={deliveryType}
              onValueChange={(value) => {
                setDeliveryType(value as "standard" | "express");
                setAutoSelectCurrent(false);
                setSelectedSlotId("");
                setError(null);
              }}
            >
              <SelectTrigger
                id="reschedule-delivery-type"
                data-testid="reschedule-delivery-type"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="standard">{t("orders.standardDelivery")}</SelectItem>
                <SelectItem value="express">{t("orders.expressDelivery")}</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="reschedule-delivery-date">{t("orders.deliveryDay")}</Label>
            <Input
              id="reschedule-delivery-date"
              type="date"
              min={marketDateKey(new Date(), timezone)}
              value={date}
              onChange={(event) => {
                setDate(event.target.value);
                setAutoSelectCurrent(false);
                setSelectedSlotId("");
                setError(null);
              }}
              data-testid="reschedule-delivery-date"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="reschedule-delivery-slot">{t("orders.availableDeliverySlot")}</Label>
            {optionsQuery.isLoading || optionsQuery.isFetching ? (
              <div className="flex items-center gap-2 rounded-md border px-3 py-2 text-sm text-muted-foreground">
                <Loader2 size={14} className="animate-spin" />
                {t("orders.loadingDeliverySlots")}
              </div>
            ) : optionsQuery.isError ? (
              <p className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">
                {rescheduleErrorMessage(
                  optionsQuery.error,
                  t("orders.rescheduleUnexpected"),
                )}
              </p>
            ) : slots.length === 0 ? (
              <p className="rounded-md border px-3 py-2 text-sm text-muted-foreground">
                {t("orders.noDeliverySlotsAvailable")}
              </p>
            ) : (
              <Select value={selectedSlotId} onValueChange={setSelectedSlotId}>
                <SelectTrigger id="reschedule-delivery-slot" data-testid="reschedule-delivery-slot">
                  <SelectValue placeholder={t("orders.selectDeliverySlot")} />
                </SelectTrigger>
                <SelectContent>
                  {slots.map((slot) => (
                    <SelectItem key={slot.id} value={slot.id}>
                      {slot.label
                        ? `${slot.label} · ${slot.start_time}–${slot.end_time}`
                        : `${slot.start_time}–${slot.end_time}`}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          </div>
          {error && (
            <p
              role="alert"
              className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive"
            >
              {error}
            </p>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>
            {t("orders.editCancel")}
          </Button>
          <Button
            onClick={save}
            disabled={saving || !selectedSlotId || optionsQuery.isFetching}
            data-testid="button-confirm-reschedule"
          >
            {saving && <Loader2 size={14} className="mr-1.5 animate-spin" />}
            {t("orders.reschedule")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function CompactOrderHeader({
  order,
  orderLabel,
  nextStatus,
  advanceStatusMut,
  advanceBlockedUnpaid,
  canEditOrders,
  canDeleteOrders,
  floristAssignment,
  setEditOpen,
  setFloristLocationId,
  setFloristDialogForPreparing,
  setSendToFloristOpen,
  setRefundOpen,
  setDeleteOpen,
  handleGenerateInvoice,
  generatingInvoice,
  openPrintCardDialog,
  deliveryWindowLabel,
  hidden,
}: {
  order: OrderDetail;
  orderLabel: string;
  nextStatus: string | null;
  advanceStatusMut: { isPending: boolean; mutate: (status: string) => void };
  advanceBlockedUnpaid: boolean;
  canEditOrders: boolean;
  canDeleteOrders: boolean;
  floristAssignment: CompactHeaderFloristAssignment;
  setEditOpen: (v: boolean) => void;
  setFloristLocationId: (v: string) => void;
  setFloristDialogForPreparing: (v: boolean) => void;
  setSendToFloristOpen: (v: boolean) => void;
  setRefundOpen: (v: boolean) => void;
  setDeleteOpen: (v: boolean) => void;
  handleGenerateInvoice: () => void;
  generatingInvoice: boolean;
  openPrintCardDialog: () => void;
  deliveryWindowLabel: string;
  hidden: boolean;
}) {
  const { t } = useTranslation();
  const idx = 0;

  const showRefund =
    canEditOrders &&
    ["stripe", "paypal"].includes((order.payment_provider ?? "").toLowerCase()) &&
    !!order.payment_reference &&
    order.status !== "refunded" &&
    order.payment_status !== "refunded";

  // Shared More-menu items — rendered in both the narrow (collapsed) and wide dropdown.
  const renderMoreItems = () => (
    <>
      <DropdownMenuItem onClick={handleGenerateInvoice} disabled={generatingInvoice}>
        <FileText size={14} className="mr-2" />
        {t("orders.generateInvoice")}
      </DropdownMenuItem>
      <DropdownMenuItem onClick={() => openPrintCardDialog()}>
        <Printer size={14} className="mr-2" />
        {t("orders.printCard")}
      </DropdownMenuItem>
      {canEditOrders && (
        <DropdownMenuItem
          onClick={() => {
            setFloristLocationId(
              floristAssignment ? String(floristAssignment.location_id) : "",
            );
            setSendToFloristOpen(true);
          }}
        >
          <Flower2 size={14} className="mr-2" />
          {floristAssignment ? t("orders.resendToFlorist") : t("orders.sendToFlorist")}
        </DropdownMenuItem>
      )}
      {showRefund && (
        <DropdownMenuItem onClick={() => setRefundOpen(true)}>
          <RotateCcw size={14} className="mr-2" />
          {t("orders.refund")}
        </DropdownMenuItem>
      )}
      {canDeleteOrders && (
        <>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            className="text-destructive focus:text-destructive"
            onClick={() => setDeleteOpen(true)}
          >
            <Trash2 size={14} className="mr-2" />
            {t("orders.deleteOrder")}
          </DropdownMenuItem>
        </>
      )}
    </>
  );

  // The outer div is a 0-height sticky anchor so it never shifts surrounding content.
  // The inner bar overflows visually from the anchor only while it is needed.
  // It is intentionally tied to the dashboard's desktop breakpoint so zoomed
  // laptop layouts retain it while the existing mobile/tablet shell does not.
  return (
    <div className="-mx-6 md:-mx-10 sticky top-0 z-20 h-0 hidden md:block">
      {!hidden && (
        <div
          data-testid="compact-order-header"
          className="bg-white border-b border-border shadow-sm"
        >
        <div className="flex items-center gap-2 px-6 md:px-10 py-3 min-h-[68px] flex-nowrap">
          {/* Left: order number + status chip */}
          <div className="flex items-center gap-2 shrink min-w-0 max-w-[160px] lg:max-w-[200px]">
            <span className="font-semibold text-sm text-foreground/90 truncate">
              {t("orders.detailTitle", { order: orderLabel })}
            </span>
            <div className="shrink-0">
              <OrderStatusBadge status={order.status} />
            </div>
          </div>

          {/* Delivery window — always expose the value, including its clear fallback. */}
          <div className="flex items-center gap-1.5 shrink min-w-0 overflow-hidden ml-2">
            <Truck size={13} className="shrink-0 text-muted-foreground" />
            <div className="flex flex-col min-w-0">
              <span className="text-muted-foreground font-medium whitespace-nowrap text-xs leading-tight">
                {t("orders.deliveryWindow")}
              </span>
              <span className="text-foreground/90 truncate text-xs leading-tight">{deliveryWindowLabel}</span>
            </div>
          </div>

          <div className="flex-1" />

          {/* Primary action — always shown */}
          {canEditOrders && nextStatus && (
            <Tooltip>
              <TooltipTrigger asChild>
                <span tabIndex={advanceBlockedUnpaid && !hidden ? 0 : -1}>
                  <Button
                    size="sm"
                    className="gap-1.5 shrink-0"
                    tabIndex={idx}
                    data-testid="button-compact-advance-status"
                    onClick={() => {
                      if (nextStatus === "preparing") {
                        setFloristLocationId(
                          floristAssignment ? String(floristAssignment.location_id) : "",
                        );
                        setFloristDialogForPreparing(true);
                        setSendToFloristOpen(true);
                        return;
                      }
                      advanceStatusMut.mutate(nextStatus);
                    }}
                    disabled={advanceStatusMut.isPending || advanceBlockedUnpaid}
                  >
                    {advanceStatusMut.isPending ? (
                      <Loader2 size={14} className="animate-spin" />
                    ) : (
                      <ChevronRight size={14} className="rtl:rotate-180" />
                    )}
                    <span>
                      {t("orders.markAsStatus", {
                        status: t(
                          ORDER_STATUS_LABEL_KEYS[
                            nextStatus as keyof typeof ORDER_STATUS_LABEL_KEYS
                          ],
                        ),
                      })}
                    </span>
                  </Button>
                </span>
              </TooltipTrigger>
              {advanceBlockedUnpaid && !hidden && (
                <TooltipContent>{t("orders.markPaidBeforeProcessing")}</TooltipContent>
              )}
            </Tooltip>
          )}

          {/* Narrow (md–lg): Edit + More collapsed into a single overflow menu */}
          <div className="lg:hidden shrink-0">
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  size="sm"
                  variant="outline"
                  tabIndex={idx}
                  data-testid="button-compact-overflow-actions"
                  aria-label={t("orders.moreActions")}
                >
                  <MoreHorizontal size={14} />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                {canEditOrders && (
                  <>
                    <DropdownMenuItem onClick={() => setEditOpen(true)}>
                      <Pencil size={14} className="mr-2" />
                      {t("orders.editOrder")}
                    </DropdownMenuItem>
                    <DropdownMenuSeparator />
                  </>
                )}
                {renderMoreItems()}
              </DropdownMenuContent>
            </DropdownMenu>
          </div>

          {/* Wide (lg+): Edit + More shown separately */}
          <div className="hidden lg:flex items-center gap-2 shrink-0">
            {canEditOrders && (
              <Button
                size="sm"
                variant="outline"
                className="gap-1.5"
                tabIndex={idx}
                data-testid="button-compact-edit-order"
                onClick={() => setEditOpen(true)}
              >
                <Pencil size={14} />
                <span className="hidden xl:inline">{t("orders.editOrder")}</span>
              </Button>
            )}
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
              <Button
                size="sm"
                variant="outline"
                className="gap-1.5"
                tabIndex={idx}
                data-testid="button-compact-more-actions"
              >
                  <MoreHorizontal size={14} />
                  <span className="hidden xl:inline">{t("orders.moreActions")}</span>
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                {renderMoreItems()}
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>
        </div>
      )}
    </div>
  );
}

export default function OrderDetailPage() {
  const { t } = useTranslation();
  const params = useParams<{ id: string }>();
  const orderId = params.id;
  const {
    isOwner,
    role,
    allowedPages,
    customRoleIds = [],
  } = useWorkspaceRole();
  const { data: workspaceRolesData } = useRoles();
  const hasOps2Role = customRoleIds.some((roleId) =>
    workspaceRolesData?.roles.some(
      (workspaceRole) => workspaceRole.id === roleId && workspaceRole.name === "Ops 2",
    ),
  );
  const canRestoreRefundedOrder = isOwner || role === "admin" || hasOps2Role;
  const canEditOrders = isOwner || !!allowedPages?.includes("orders");
  // Deleting an order requires Orders-page access and an elevated role.
  const canDeleteOrders =
    isOwner ||
    (canEditOrders && (role === "admin" || hasOps2Role));
  const [editOpen, setEditOpen] = React.useState(false);
  const [deleteOpen, setDeleteOpen] = React.useState(false);
  const [refundOpen, setRefundOpen] = React.useState(false);
  const [refundMode, setRefundMode] = React.useState<"full" | "partial">("full");
  const [refundAmountInput, setRefundAmountInput] = React.useState("");
  const [markPaidOpen, setMarkPaidOpen] = React.useState(false);
  const [customerHistoryOpen, setCustomerHistoryOpen] = React.useState(false);
  const [recipientHistoryOpen, setRecipientHistoryOpen] = React.useState(false);
  const [assignDriverOpen, setAssignDriverOpen] = React.useState(false);
  const [rescheduleOpen, setRescheduleOpen] = React.useState(false);
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [, navigate] = useLocation();
  const deleteMut = useDeleteOrder();
  const refundMut = useRefundOrder();
  const markPaidMut = useMarkOrderPaid();
  const sendInstructionsMut = useSendOrderPaymentInstructions();
  const resendWhishInstructionsMut = useResendWhishPaymentInstructions();
  const retryTookanMut = useRetryTookanTask();

  // Trustpilot service-review invitation — admin card state (raw fetch, not
  // in the OpenAPI spec, mirroring the order invoice route pattern).
  const { data: trustpilotData } = useQuery({
    queryKey: ["trustpilot-invitation", orderId],
    enabled: isOwner,
    queryFn: () =>
      apiFetch<{
        success: boolean;
        enabled: boolean;
        testMode: boolean;
        invitation: {
          id: string;
          status: string;
          recipient_email: string | null;
          locale: string | null;
          preferred_send_time: string | null;
          attempt_count: number;
          next_attempt_at: string | null;
          last_error: string | null;
          last_attempt_at: string | null;
          trustpilot_invitation_id: string | null;
          created_at: string;
          updated_at: string;
        } | null;
      }>(`/api/orders/${orderId}/trustpilot-invitation`),
  });
  const retryTrustpilotMut = useMutation({
    mutationFn: () =>
      apiFetch(`/api/orders/${resolvedOrderId}/trustpilot-invitation/retry`, {
        method: "POST",
      }),
  });
  const updateCardMut = useUpdateOrder();
  // Sensitive-occasion flag toggle (auto-detected at creation; staff override).
  const sensitiveMut = useUpdateOrder();
  // Payment section is collapsed to a one-line summary chip by default.
  const [paymentOpen, setPaymentOpen] = React.useState(false);
  const [linkExistingPaymentOpen, setLinkExistingPaymentOpen] = React.useState(false);
  const [selectedExistingPayment, setSelectedExistingPayment] = React.useState<LinkedPaymentLink | null>(null);
  const [confirmExistingPayment, setConfirmExistingPayment] = React.useState(false);
  // Full marketing-attribution parameter list, collapsed by default.
  const [attributionOpen, setAttributionOpen] = React.useState(false);
  // Integration cards (Tookan, Trustpilot) collapsed at the bottom.
  const [tookanOpen, setTookanOpen] = React.useState(false);
  const [trustpilotOpen, setTrustpilotOpen] = React.useState(false);
  // Florist verification photo lightbox
  const [lightboxOpen, setLightboxOpen] = React.useState(false);
  const [lightboxIndex, setLightboxIndex] = React.useState(0);
  const lightboxItemsTriggerRef = React.useRef<HTMLButtonElement>(null);
  const lightboxCardTriggerRef = React.useRef<HTMLButtonElement>(null);

  function handleToggleSensitive(next: boolean) {
    if (!resolvedOrderId) return;
    sensitiveMut.mutate(
      { id: resolvedOrderId, data: { is_sensitive_occasion: next } },
      {
        onSuccess: () => {
          void queryClient.invalidateQueries({ queryKey: ["order", orderId] });
          void queryClient.invalidateQueries({
            queryKey: ["trustpilot-invitation", orderId],
          });
          toast({
            title: next
              ? t("orders.sensitiveFlaggedToast")
              : t("orders.sensitiveUnflaggedToast"),
          });
        },
        onError: (err: unknown) => {
          const msg = err instanceof Error ? err.message : String(err);
          toast({ title: t("orders.sensitiveToggleFailed"), description: msg, variant: "destructive" });
        },
      },
    );
  }

  // The route param may be a UUID or a display order number (e.g. `lb-1125`);
  // the API's detail endpoint accepts both, so it is passed through as-is.
  const {
    data,
    isLoading,
    isError,
    error: orderError,
    isFetching: isOrderFetching,
    refetch: refetchOrder,
  } = useQuery<OrderDetailResponse>({
    queryKey: ["order", orderId],
    queryFn: () => apiFetch<OrderDetailResponse>(`/api/orders/${orderId}`),
    enabled: !!orderId,
    // A genuine 404 (order really doesn't exist / wrong number) should never
    // be retried. Anything else (auth hiccup, transient 5xx, network blip)
    // gets one retry before we show the "couldn't load" state — retrying
    // matters here because those transient failures otherwise render
    // identically to a real 404, wrongly telling the user the order is gone.
    retry: (failureCount, err) => {
      const status = (err as (Error & { status?: number }) | undefined)?.status;
      if (status === 404) return false;
      return failureCount < 1;
    },
  });

  // Follow-up calls (status changes, notes, florist/driver actions, PDFs) must
  // always target the resolved UUID so mutations stay unambiguous even when
  // the page was opened via an order-number URL.
  const resolvedOrderId = data?.order?.id ?? orderId;
  const requestAddressMut = useMutation<
    { success: boolean; created: boolean; requestId: string | null },
    Error,
    void
  >({
    mutationFn: () => apiFetch(`/api/orders/${resolvedOrderId}/address-collector`, { method: "POST" }),
    onSuccess: (result) => {
      void queryClient.invalidateQueries({ queryKey: ["order", orderId] });
      void queryClient.invalidateQueries({ queryKey: ["orders"] });
      toast({
        title: result.created
          ? t("orders.addressRequestCreated")
          : t("orders.addressRequestAlreadyExists"),
      });
    },
    onError: (error: Error & { code?: string }) => {
      toast({
        title:
          error.code === "missing_recipient"
            ? t("orders.addressRequestMissingRecipient")
            : t("orders.addressRequestFailed"),
        description: error.message,
        variant: "destructive",
      });
    },
  });
  const availablePayments = useQuery({
    queryKey: ["payment-links", "unlinked-for-order"],
    enabled: linkExistingPaymentOpen,
    queryFn: () => apiFetch<{ payment_links: LinkedPaymentLink[] }>("/api/payment-links"),
  });
  const linkExistingPayment = useMutation({
    mutationFn: () => apiFetch(`/api/payment-links/${selectedExistingPayment?.id}/order`, {
      method: "POST",
      body: JSON.stringify({
        order_id: resolvedOrderId,
        confirm_mismatch: confirmExistingPayment,
        confirm_reassignment: confirmExistingPayment,
      }),
    }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["order", orderId] });
      void queryClient.invalidateQueries({ queryKey: ["orders"] });
      void queryClient.invalidateQueries({ queryKey: ["payment-links"] });
      setLinkExistingPaymentOpen(false);
      setSelectedExistingPayment(null);
      toast({ title: "Payment link attached" });
    },
    onError: (error: Error) => toast({ title: error.message || "Could not attach payment link", variant: "destructive" }),
  });

  // Inline editing of the gift card message (To / message / From)
  const [editingCard, setEditingCard] = React.useState(false);
  const [cardForm, setCardForm] = React.useState({
    card_to: "",
    card_message: "",
    card_from: "",
    qr_link: "",
  });
  const [qrLinkError, setQrLinkError] = React.useState<string | null>(null);
  const [addingCard, setAddingCard] = React.useState(false);
  const [additionalCardForm, setAdditionalCardForm] = React.useState({
    card_to: "",
    card_message: "",
    card_from: "",
    qr_link: "",
  });
  const [additionalQrLinkError, setAdditionalQrLinkError] = React.useState<string | null>(null);
  const addCardMut = useMutation({
    mutationFn: (card: typeof additionalCardForm) =>
      apiFetch(`/api/orders/${resolvedOrderId}/card-messages`, {
        method: "POST",
        body: JSON.stringify({
          card_to: emptyToNull(card.card_to),
          card_message: card.card_message.trim(),
          card_from: emptyToNull(card.card_from),
          qr_link: emptyToNull(card.qr_link),
        }),
      }),
    onSuccess: () => {
      setAddingCard(false);
      setAdditionalCardForm({ card_to: "", card_message: "", card_from: "", qr_link: "" });
      void queryClient.invalidateQueries({ queryKey: ["order", orderId] });
      toast({ title: t("orders.additionalCardSaved") });
    },
    onError: (err: Error) => {
      toast({
        title: t("orders.cardMessageSaveFailed"),
        description: errorMessage(err),
        variant: "destructive",
      });
    },
  });

  function startCardEdit(o: { card_to?: string | null; card_message?: string | null; card_from?: string | null; qr_link?: string | null }) {
    setCardForm({
      card_to: o.card_to ?? "",
      card_message: o.card_message ?? "",
      card_from: o.card_from ?? "",
      qr_link: o.qr_link ?? "",
    });
    setQrLinkError(null);
    setEditingCard(true);
  }

  function isValidHttpUrl(value: string): boolean {
    try {
      const u = new URL(value);
      return u.protocol === "http:" || u.protocol === "https:";
    } catch {
      return false;
    }
  }

  function handleSaveCard() {
    if (!resolvedOrderId) return;
    const trimmedQrLink = cardForm.qr_link.trim();
    if (trimmedQrLink && !isValidHttpUrl(trimmedQrLink)) {
      setQrLinkError(t("orders.qrLinkInvalid"));
      return;
    }
    setQrLinkError(null);
    updateCardMut.mutate(
      {
        id: resolvedOrderId,
        data: {
          card_to: emptyToNull(cardForm.card_to),
          card_message: emptyToNull(cardForm.card_message),
          card_from: emptyToNull(cardForm.card_from),
          qr_link: trimmedQrLink === "" ? null : trimmedQrLink,
        },
      },
      {
        onSuccess: () => {
          setEditingCard(false);
          void queryClient.invalidateQueries({ queryKey: ["order", orderId] });
          toast({ title: t("orders.cardMessageSaved") });
        },
        onError: (err) => {
          toast({
            title: t("orders.cardMessageSaveFailed"),
            description: errorMessage(err),
            variant: "destructive",
          });
        },
      },
    );
  }

  function handleSaveAdditionalCard() {
    const qrLink = additionalCardForm.qr_link.trim();
    if (!additionalCardForm.card_message.trim()) return;
    if (qrLink && !isValidHttpUrl(qrLink)) {
      setAdditionalQrLinkError(t("orders.qrLinkInvalid"));
      return;
    }
    setAdditionalQrLinkError(null);
    addCardMut.mutate({ ...additionalCardForm, qr_link: qrLink });
  }

  // Send to Florist (owner-only)
  const [sendToFloristOpen, setSendToFloristOpen] = React.useState(false);
  // When true, the florist dialog was opened by the "Mark as Preparing"
  // status-advance button (assignment is required to enter Preparing).
  const [floristDialogForPreparing, setFloristDialogForPreparing] =
    React.useState(false);
  const [unassignFloristOpen, setUnassignFloristOpen] = React.useState(false);
  const [floristLocationId, setFloristLocationId] = React.useState<string>("");
  const sendToFloristMut = useSendOrderToFlorist();
  const unassignFloristMut = useRemoveOrderFloristAssignment();
  const { data: floristAssignmentData } = useGetOrderFloristAssignment(
    resolvedOrderId ?? "",
    {
      query: {
        enabled: !!data?.order && canEditOrders,
        queryKey: getGetOrderFloristAssignmentQueryKey(resolvedOrderId ?? ""),
      },
    },
  );
  const floristAssignment = floristAssignmentData?.assignment ?? null;
  const floristVerificationPhotos =
    floristAssignment?.photo_items_path
      ? {
          items: floristAssignment.photo_items_path,
          card: floristAssignment.photo_card_path ?? null,
        }
      : null;
  const { data: floristLocationsData } = useQuery({
    queryKey: ["locations"],
    queryFn: () =>
      apiFetch<{ locations: { id: number; name: string }[] }>("/api/locations"),
    enabled: canEditOrders,
  });
  const floristLocations = floristLocationsData?.locations ?? [];

  const handleSendToFlorist = () => {
    if (!resolvedOrderId || !floristLocationId) return;
    sendToFloristMut.mutate(
      { id: resolvedOrderId, data: { locationId: parseInt(floristLocationId, 10) } },
      {
        onSuccess: () => {
          toast({
            title: floristDialogForPreparing
              ? t("orders.statusAdvanced", {
                  status: t("orders.statusPreparing"),
                })
              : t("orders.sentToFlorist"),
          });
          setSendToFloristOpen(false);
          setFloristDialogForPreparing(false);
          queryClient.invalidateQueries({
            queryKey: getGetOrderFloristAssignmentQueryKey(resolvedOrderId),
          });
          // send-to-florist auto-advances pending/processing orders to
          // preparing, so refresh the order + activity too.
          void queryClient.invalidateQueries({ queryKey: ["order", orderId] });
          void queryClient.invalidateQueries({ queryKey: ["orders"] });
          void queryClient.invalidateQueries({
            queryKey: getListOrderActivityQueryKey(resolvedOrderId),
          });
        },
        onError: (e: unknown) =>
          toast({
            title: t("orders.sendToFloristFailed"),
            description: e instanceof Error ? e.message : undefined,
            variant: "destructive",
          }),
      },
    );
  };

  const handleUnassignFlorist = () => {
    if (!resolvedOrderId) return;
    unassignFloristMut.mutate(
      { id: resolvedOrderId },
      {
        onSuccess: () => {
          setUnassignFloristOpen(false);
          toast({ title: t("orders.floristUnassigned") });
          void queryClient.invalidateQueries({
            queryKey: getGetOrderFloristAssignmentQueryKey(resolvedOrderId),
          });
          void queryClient.invalidateQueries({ queryKey: ["order", orderId] });
          void queryClient.invalidateQueries({ queryKey: ["orders"] });
          void queryClient.invalidateQueries({
            queryKey: getListOrderActivityQueryKey(resolvedOrderId),
          });
          void queryClient.invalidateQueries({
            queryKey: ["/api/florist-orders"],
          });
        },
        onError: (err: unknown) =>
          toast({
            title: t("orders.unassignFloristFailed"),
            description: errorMessage(err),
            variant: "destructive",
          }),
      },
    );
  };

  const advanceStatusMut = useMutation({
    mutationFn: (status: string) =>
      apiFetch(`/api/orders/${resolvedOrderId}/status`, {
        method: "PATCH",
        body: JSON.stringify({ status }),
      }),
    onSuccess: (_data, status) => {
      void queryClient.invalidateQueries({ queryKey: ["order", orderId] });
      void queryClient.invalidateQueries({ queryKey: ["orders"] });
      if (resolvedOrderId) {
        void queryClient.invalidateQueries({
          queryKey: getGetOrderFloristAssignmentQueryKey(resolvedOrderId),
        });
        void queryClient.invalidateQueries({
          queryKey: getListOrderActivityQueryKey(resolvedOrderId),
        });
      }
      const key = ORDER_STATUS_LABEL_KEYS[status as keyof typeof ORDER_STATUS_LABEL_KEYS];
      toast({
        title: t("orders.statusAdvanced", { status: key ? t(key) : status }),
      });
    },
    onError: (err: unknown) => {
      const code = (err as { code?: string } | null)?.code;
      toast({
        title: t("orders.statusAdvanceFailed"),
        description:
          code === "payment_not_paid"
            ? t("orders.markPaidBeforeProcessing")
            : err instanceof Error
              ? err.message
              : String(err),
        variant: "destructive",
      });
    },
  });

  // ── Compact sticky header ────────────────────────────────────────────────
  const fullHeaderBoundaryRef = React.useRef<HTMLDivElement>(null);
  const [fullHeaderVisible, setFullHeaderVisible] = React.useState(true);

  React.useEffect(() => {
    const boundary = fullHeaderBoundaryRef.current;
    if (!boundary) return;

    // The dashboard scrolls inside its shell, not on window. A viewport-rooted
    // observer therefore never changes while an operator scrolls the order.
    // The sentinel sits immediately after the complete full-header region
    // (heading, controls, and stepper), so the compact controls start only
    // after that whole region has crossed the shell's top edge.
    const scrollContainer = document.querySelector<HTMLElement>(
      "[data-dashboard-scroll-container]",
    );
    // OrderDetail is also rendered in isolated component tests without the OS
    // shell. Keep the full controls active there rather than treating jsdom's
    // zero-sized viewport as a scrolled dashboard.
    if (!scrollContainer) {
      setFullHeaderVisible(true);
      return;
    }
    let frame: number | undefined;
    const update = () => {
      frame = undefined;
      const scrollTop = scrollContainer.getBoundingClientRect().top;
      setFullHeaderVisible(boundary.getBoundingClientRect().bottom > scrollTop + 1);
    };
    const scheduleUpdate = () => {
      if (frame == null) frame = window.requestAnimationFrame(update);
    };
    const observer =
      typeof window.IntersectionObserver === "undefined"
        ? null
        : new IntersectionObserver(scheduleUpdate, {
            root: scrollContainer,
            threshold: 0,
          });
    const resizeObserver =
      typeof window.ResizeObserver === "undefined"
        ? null
        : new ResizeObserver(scheduleUpdate);

    observer?.observe(boundary);
    resizeObserver?.observe(boundary);
    scrollContainer.addEventListener("scroll", scheduleUpdate, { passive: true });
    resizeObserver?.observe(scrollContainer);
    window.addEventListener("resize", scheduleUpdate);
    update();

    return () => {
      if (frame != null) window.cancelAnimationFrame(frame);
      observer?.disconnect();
      resizeObserver?.disconnect();
      scrollContainer.removeEventListener("scroll", scheduleUpdate);
      window.removeEventListener("resize", scheduleUpdate);
    };
  }, [data?.order?.id]);

  // Resolve the delivery window label once so both headers share the same string.
  const deliveryWindowLabel = React.useMemo(() => {
    const o = data?.order;
    if (!o) return t("orders.noDeliveryDate");
    const da = (o.delivery_address ?? {}) as Record<string, unknown>;
    const schedule = resolveDeliverySchedule({
      windowStart: o.window_start,
      windowEnd: o.window_end,
      legacyDate: da.date,
      legacySlot: da.slot,
    });
    return (
      formatDeliverySchedule(schedule, data.timezone ?? "UTC")?.fullLabel ??
      t("orders.noDeliveryDate")
    );
  }, [data?.order, data?.timezone, t]);

  const loadedOrder = data?.order;
  const tabOrderLabel = loadedOrder
    ? loadedOrder.display_order_number
      ? `#${loadedOrder.display_order_number}`
      : loadedOrder.external_order_id
        ? `#${loadedOrder.external_order_id}`
        : loadedOrder.id.slice(0, 8)
    : null;
  usePageTitleOverride(
    tabOrderLabel ? t("orders.tabTitle", { order: tabOrderLabel }) : t("orders.tabTitleLoading"),
  );

  function handleDelete(id: string) {
    deleteMut.mutate(
      { id },
      {
        onSuccess: () => {
          setDeleteOpen(false);
          void queryClient.invalidateQueries({ queryKey: ["orders"] });
          toast({ title: t("orders.deleteSuccess") });
          navigate("/orders");
        },
        onError: (err) => {
          toast({
            title: t("orders.deleteFailed"),
            description: errorMessage(err),
            variant: "destructive",
          });
        },
      },
    );
  }

  function handleRefund(id: string, amount?: number) {
    refundMut.mutate(
      { id, data: amount != null ? { amount } : {} },
      {
        onSuccess: () => {
          setRefundOpen(false);
          setRefundMode("full");
          setRefundAmountInput("");
          void queryClient.invalidateQueries({ queryKey: ["order", orderId] });
          void queryClient.invalidateQueries({ queryKey: ["orders"] });
          toast({ title: t("orders.refundSuccess") });
        },
        onError: (err) => {
          toast({
            title: t("orders.refundFailed"),
            description: errorMessage(err),
            variant: "destructive",
          });
        },
      },
    );
  }

  function handleMarkPaid(id: string) {
    markPaidMut.mutate(
      { id },
      {
        onSuccess: () => {
          setMarkPaidOpen(false);
          void queryClient.invalidateQueries({ queryKey: ["order", orderId] });
          void queryClient.invalidateQueries({ queryKey: ["orders"] });
          toast({ title: t("orders.markPaidSuccess") });
        },
        onError: (err) => {
          toast({
            title: t("orders.markPaidFailed"),
            description: errorMessage(err),
            variant: "destructive",
          });
        },
      },
    );
  }

  function handleSendPaymentInstructions(id: string) {
    sendInstructionsMut.mutate(
      { id },
      {
        onSuccess: (data) => {
          if (data?.emailed) {
            toast({ title: t("orders.sendInstructionsSuccess") });
          } else {
            toast({
              title: t("orders.sendInstructionsNoEmail"),
              variant: "destructive",
            });
          }
        },
        onError: (err) => {
          toast({
            title: t("orders.sendInstructionsFailed"),
            description: errorMessage(err),
            variant: "destructive",
          });
        },
      },
    );
  }

  function handleResendWhishPaymentInstructions(id: string) {
    resendWhishInstructionsMut.mutate(
      { id },
      {
        onSuccess: () => {
          void queryClient.invalidateQueries({ queryKey: ["order", orderId] });
          void queryClient.invalidateQueries({
            queryKey: getListOrderActivityQueryKey(id),
          });
          toast({ title: t("orders.resendWhishInstructionsSuccess") });
        },
        onError: (err) => {
          toast({
            title: t("orders.resendWhishInstructionsFailed"),
            description: errorMessage(err),
            variant: "destructive",
          });
        },
      },
    );
  }

  const [generatingInvoice, setGeneratingInvoice] = React.useState(false);
  const [invoiceNameDialogOpen, setInvoiceNameDialogOpen] = React.useState(false);
  const [invoiceNameType, setInvoiceNameType] = React.useState<"individual" | "company">(
    "individual",
  );
  const [invoiceName, setInvoiceName] = React.useState("");

  async function handleGenerateInvoice() {
    const defaultName = customer ? contactName(customer) : "";
    setInvoiceNameType("individual");
    setInvoiceName(defaultName);
    setInvoiceNameDialogOpen(true);
  }

  async function downloadInvoice() {
    if (!resolvedOrderId) return;
    setGeneratingInvoice(true);
    try {
      const token = await getClerkToken();
      const params = new URLSearchParams({
        billToType: invoiceNameType,
        billToName: invoiceName.trim(),
      });
      const res = await fetch(`/api/orders/${resolvedOrderId}/invoice?${params.toString()}`, {
        credentials: "include",
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      const label = order?.display_order_number
        ? order.display_order_number
        : resolvedOrderId.slice(0, 8);
      a.download = `Invoice-${label.replace(/[^a-zA-Z0-9_-]/g, "_")}.pdf`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
      setInvoiceNameDialogOpen(false);
    } catch (err) {
      toast({
        title: t("orders.invoiceFailed"),
        description: errorMessage(err),
        variant: "destructive",
      });
    } finally {
      setGeneratingInvoice(false);
    }
  }

  // ── Print Card dialog state ──────────────────────────────────────────────
  const PRINT_CARD_SHOP = "Presentail Flowers and Gifts";
  const [printCardOpen, setPrintCardOpen] = React.useState(false);
  const [printCardBranch, setPrintCardBranch] = React.useState("");
  const [printCardTo, setPrintCardTo] = React.useState("");
  const [printCardMessage, setPrintCardMessage] = React.useState("");
  const [printCardFrom, setPrintCardFrom] = React.useState("");
  const [printCardQrLink, setPrintCardQrLink] = React.useState("");
  const [printAdditionalCardId, setPrintAdditionalCardId] = React.useState<string | null>(null);
  const [printCardError, setPrintCardError] = React.useState<string | null>(null);
  const [printCardPending, setPrintCardPending] = React.useState(false);

  // Fetch branch configs (available to all members)
  const { data: branchConfigsData } = useQuery<{ configs: { id: number; name: string }[] }>({
    queryKey: ["card-message-branch-configs"],
    queryFn: () => apiFetch("/api/card-message/branch-configs"),
    enabled: printCardOpen,
  });
  // Fetch print history for this order
  const { data: printHistoryData, refetch: refetchPrintHistory } = useQuery<{
    logs: {
      id: string;
      user_display_name: string;
      location: string;
      shop_name: string;
      printed_at: string;
    }[];
  }>({
    queryKey: ["card-print-logs", resolvedOrderId],
    queryFn: () => apiFetch(`/api/card-message/order-print-logs/${resolvedOrderId}`),
    enabled: !!resolvedOrderId,
  });
  const printHistory = printHistoryData?.logs ?? [];

  const branchConfigs = branchConfigsData?.configs ?? [];

  function openPrintCardDialog(card?: CardMessage) {
    if (!order) return;
    setPrintCardBranch("");
    setPrintCardTo(card?.card_to ?? order.card_to ?? "");
    setPrintCardMessage(card?.card_message ?? order.card_message ?? "");
    setPrintCardFrom(card?.card_from ?? order.card_from ?? "");
    setPrintCardQrLink(card?.qr_link ?? order.qr_link ?? "");
    setPrintAdditionalCardId(card?.id ?? null);
    setPrintCardError(null);
    setPrintCardOpen(true);
  }

  async function handlePrintCardSubmit() {
    if (!resolvedOrderId || !order) return;
    setPrintCardPending(true);
    setPrintCardError(null);
    const webhookOrderId =
      order.display_order_number ?? order.external_order_id ?? resolvedOrderId;
    try {
      await apiFetch("/api/card-message/print", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          location: printCardBranch,
          shopName: PRINT_CARD_SHOP,
          orderId: webhookOrderId,
          cardMessage: printCardMessage.trim() || " ",
          toName: printCardTo,
          fromName: printCardFrom,
          realOrderId: resolvedOrderId,
          additionalCardMessageId: printAdditionalCardId ?? undefined,
        }),
      });
      setPrintCardOpen(false);
      void refetchPrintHistory();
      toast({ title: t("orders.printCardDialog.successToast") });
    } catch (err) {
      const msg = err instanceof Error ? err.message : "";
      if (msg.includes("no_printer_configured")) {
        setPrintCardError(t("orders.printCardDialog.noPrinter"));
      } else {
        setPrintCardError(t("orders.printCardDialog.errorMessage"));
      }
    } finally {
      setPrintCardPending(false);
    }
  }

  const printCardCanPrint = !!printCardBranch;
  const cakeItem = data?.line_items?.find((item) => /cake/i.test(item.name) && item.custom_input?.trim());
  const [cakePrintOpen, setCakePrintOpen] = React.useState(false);
  const [cakeLocation, setCakeLocation] = React.useState("");
  const [cakePrintPending, setCakePrintPending] = React.useState(false);
  const [cakePrintError, setCakePrintError] = React.useState<string | null>(null);

  async function printCakeMessage() {
    if (!cakeItem?.custom_input || !cakeLocation) return;
    setCakePrintPending(true);
    setCakePrintError(null);
    try {
      await apiFetch("/api/card-message/print-cake", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ location: cakeLocation, cakeMessage: cakeItem.custom_input.trim(), realOrderId: resolvedOrderId }),
      });
      setCakePrintOpen(false);
      toast({ title: t("cardMessage.cakeSuccessMessage") });
    } catch {
      setCakePrintError(t("cardMessage.cakeErrorMessage"));
    } finally {
      setCakePrintPending(false);
    }
  }

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-24">
        <Loader2 className="animate-spin text-muted-foreground" size={28} />
      </div>
    );
  }

  if (isError) {
    // Only a genuine 404 means the order itself doesn't exist. Anything else
    // (expired session, permission error, transient 5xx, network blip) must
    // not claim the order is gone — that sends staff on a wild goose chase
    // for an order that's actually fine. Offer a retry instead.
    const status = (orderError as (Error & { status?: number }) | undefined)?.status;
    if (status !== 404) {
      return (
        <div className="flex flex-col items-center justify-center py-24 gap-3 text-center">
          <AlertTriangle size={40} className="text-muted-foreground opacity-40" />
          <p className="font-medium">{t("orders.loadErrorTitle")}</p>
          <p className="text-sm text-muted-foreground max-w-sm">
            {t("orders.loadErrorDescription")}
          </p>
          <div className="flex gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => void refetchOrder()}
              disabled={isOrderFetching}
            >
              {isOrderFetching ? (
                <Loader2 size={14} className="mr-1 animate-spin" />
              ) : null}
              {t("orders.tryAgain")}
            </Button>
            <Link href="/orders">
              <Button variant="outline" size="sm">
                <ArrowLeft size={14} className="mr-1" />
                {t("orders.backToOrders")}
              </Button>
            </Link>
          </div>
        </div>
      );
    }
  }

  if (isError || !data?.order) {
    return (
      <div className="flex flex-col items-center justify-center py-24 gap-3 text-center">
        <ShoppingCart size={40} className="text-muted-foreground opacity-40" />
        <p className="font-medium">{t("orders.notFound")}</p>
        <Link href="/orders">
          <Button variant="outline" size="sm">
            <ArrowLeft size={14} className="mr-1" />
            {t("orders.backToOrders")}
          </Button>
        </Link>
      </div>
    );
  }

  const { order, line_items, contacts, assignment } = data;
  const contactEdits = data.contact_edits ?? [];
  const customerEdit = contactEdits.find((e) => e.role === "customer") ?? null;
  const recipientEdit = contactEdits.find((e) => e.role === "recipient") ?? null;
  const customer = contacts.find((c) => c.role === "customer") ?? contacts[0] ?? null;
  const recipient = contacts.find((c) => c.role === "recipient") ?? null;
  const recipientName =
    recipient &&
    (recipient.display_name ??
      ([recipient.first_name, recipient.last_name].filter(Boolean).join(" ") || null));
  const orderLabel = order.display_order_number
    ? `#${order.display_order_number}`
    : order.external_order_id
      ? `#${order.external_order_id}`
      : order.id.slice(0, 8);
  const priorOrders = data.customer_prior_orders ?? 0;
  const recipientPriorOrders = data.recipient_prior_orders ?? 0;
  const nextStatus =
    order.status !== "refunded" ? nextFlowStatus(order.status) : null;
  // Unpaid orders can't be advanced into fulfillment — the server enforces the
  // same rule, this just surfaces it up-front with a tooltip.
  const advanceBlockedUnpaid =
    nextStatus === "processing" &&
    (order.payment_status ?? "").toLowerCase() !== "paid";
  const whishPayment = isWhishOrder(order);
  const canResendWhishInstructions =
    whishPayment &&
    !["paid", "refunded"].includes((order.payment_status ?? "").toLowerCase());
  const normalizedStatus = normalizeOrderStatus(order.status);
  const rescheduleUnavailable =
    normalizedStatus === "out_for_delivery"
      ? t("orders.rescheduleUnavailableOutForDelivery")
      : normalizedStatus === "completed"
        ? t("orders.rescheduleUnavailableCompleted")
        : normalizedStatus === "cancelled"
          ? t("orders.rescheduleUnavailableCancelled")
          : null;
  const operationalSchedule = formatDeliverySchedule(
    resolveDeliverySchedule({
      windowStart: order.window_start,
      windowEnd: order.window_end,
      legacyDate: (order.delivery_address ?? {}).date,
      legacySlot: (order.delivery_address ?? {}).slot,
    }),
    data.timezone ?? "UTC",
  );

  return (
    <>
      <CompactOrderHeader
        order={order}
        orderLabel={orderLabel}
        nextStatus={nextStatus}
        advanceStatusMut={advanceStatusMut}
        advanceBlockedUnpaid={advanceBlockedUnpaid}
        canEditOrders={canEditOrders}
        canDeleteOrders={canDeleteOrders}
        floristAssignment={floristAssignment}
        setEditOpen={setEditOpen}
        setFloristLocationId={setFloristLocationId}
        setFloristDialogForPreparing={setFloristDialogForPreparing}
        setSendToFloristOpen={setSendToFloristOpen}
        setRefundOpen={setRefundOpen}
        setDeleteOpen={setDeleteOpen}
        handleGenerateInvoice={handleGenerateInvoice}
        generatingInvoice={generatingInvoice}
        openPrintCardDialog={openPrintCardDialog}
        deliveryWindowLabel={deliveryWindowLabel}
        hidden={fullHeaderVisible}
      />
      <div className="space-y-6">
      <div className="flex items-center gap-4">
        <Link href="/orders">
          <Button variant="ghost" size="sm" className="gap-1">
            <ArrowLeft size={14} />
            {t("orders.backToOrders")}
          </Button>
        </Link>
      </div>

      {order.delivery_date_review && (
        <div className="flex items-start gap-3 rounded-lg border border-amber-300 bg-amber-50 px-4 py-3 text-amber-900">
          <AlertTriangle size={18} className="mt-0.5 shrink-0 text-amber-600" />
          <div className="space-y-0.5">
            <p className="font-medium text-sm">
              {t("orders.deliveryDateReviewTitle")}
            </p>
            <p className="text-sm">{order.delivery_date_review}</p>
          </div>
        </div>
      )}

      {/* Sensitive occasion — calm, muted banner (deliberately not red/alarm). */}
      {order.is_sensitive_occasion && (
        <div
          className="flex items-start gap-3 rounded-lg border border-slate-200 bg-slate-50 px-4 py-3 text-slate-700"
          data-testid="banner-sensitive-occasion"
        >
          <HeartHandshake size={18} className="mt-0.5 shrink-0 text-slate-500" />
          <div className="flex-1 space-y-0.5">
            <p className="font-medium text-sm">{t("orders.sensitiveBannerTitle")}</p>
            <p className="text-sm text-slate-600">{t("orders.sensitiveBannerBody")}</p>
          </div>
          {canEditOrders && (
            <Button
              size="sm"
              variant="ghost"
              className="shrink-0 text-slate-600"
              disabled={sensitiveMut.isPending}
              onClick={() => handleToggleSensitive(false)}
              data-testid="button-sensitive-unflag"
            >
              {sensitiveMut.isPending && (
                <Loader2 size={14} className="mr-1 animate-spin" />
              )}
              {t("orders.sensitiveUnflag")}
            </Button>
          )}
        </div>
      )}

      <div className="flex items-center justify-between gap-4 flex-wrap">
        <div>
          <div className="flex items-center gap-2 flex-wrap">
            <h1 className="text-2xl font-bold tracking-tight">
              {t("orders.detailTitle", { order: orderLabel })}
            </h1>
            {order.source === "toters" && (
              <Badge className="bg-orange-100 text-orange-800 border-orange-300 hover:bg-orange-100 border font-medium text-sm">
                Toters
              </Badge>
            )}
            {order.is_sensitive_occasion && (
              <Badge
                className="bg-slate-100 text-slate-700 border-slate-200 hover:bg-slate-100 border font-medium text-xs gap-1"
                data-testid="badge-sensitive-occasion"
              >
                <HeartHandshake size={12} />
                {t("orders.sensitiveBadge")}
              </Badge>
            )}
          </div>
          <p className="text-sm text-muted-foreground mt-1">
            {t("orders.detailSource", {
              source:
                order.source === "manual"
                  ? t("orders.sourceOS")
                  : order.source === "external"
                    ? t("orders.sourceWebsite")
                    : order.source === "native"
                      ? t("orders.sourceApp")
                      : order.source === "toters"
                        ? t("orders.sourceToters")
                        : order.source && order.source.trim() !== ""
                          ? order.source
                          : "—",
            })}
            {" · "}
            {t("orders.headerCreated", { date: formatDateTime(order.created_at) })}
          </p>
        </div>
        <div
          className="flex items-center gap-2 flex-wrap"
          aria-hidden={!fullHeaderVisible ? "true" : undefined}
        >
          {order.status === "refunded" && canRestoreRefundedOrder ? (
            <Select
              value={order.status}
              onValueChange={(status) => advanceStatusMut.mutate(status)}
              disabled={advanceStatusMut.isPending}
            >
              <SelectTrigger
                data-testid="select-refunded-order-status"
                className={`h-8 w-auto gap-1 border px-2.5 py-0 text-xs font-medium capitalize ${orderStatusBadgeClass(order.status)}`}
                aria-label={t("orders.fieldStatus")}
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {ORDER_STATUSES.map((status) => (
                  <SelectItem
                    key={status}
                    value={status}
                    disabled={status === "refunded"}
                  >
                    {t(ORDER_STATUS_LABEL_KEYS[status])}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          ) : (
            <OrderStatusBadge status={order.status} />
          )}
          {canEditOrders && nextStatus && (
            <Tooltip>
              <TooltipTrigger asChild>
                <span tabIndex={advanceBlockedUnpaid && fullHeaderVisible ? 0 : -1}>
                  <Button
                    size="sm"
                    className="gap-1.5"
                    tabIndex={!fullHeaderVisible ? -1 : undefined}
                    onClick={() => {
                      if (nextStatus === "preparing") {
                        // Entering Preparing means a florist takes over — ask
                        // for the florist location and assign+advance via the
                        // send-to-florist flow instead of a bare status change.
                        setFloristLocationId(
                          floristAssignment
                            ? String(floristAssignment.location_id)
                            : "",
                        );
                        setFloristDialogForPreparing(true);
                        setSendToFloristOpen(true);
                        return;
                      }
                      advanceStatusMut.mutate(nextStatus);
                    }}
                    disabled={advanceStatusMut.isPending || advanceBlockedUnpaid}
                    data-testid="button-advance-status"
                  >
                    {advanceStatusMut.isPending ? (
                      <Loader2 size={14} className="animate-spin" />
                    ) : (
                      <ChevronRight size={14} className="rtl:rotate-180" />
                    )}
                    {t("orders.markAsStatus", {
                      status: t(
                        ORDER_STATUS_LABEL_KEYS[
                          nextStatus as keyof typeof ORDER_STATUS_LABEL_KEYS
                        ],
                      ),
                    })}
                  </Button>
                </span>
              </TooltipTrigger>
              {advanceBlockedUnpaid && fullHeaderVisible && (
                <TooltipContent>
                  {t("orders.markPaidBeforeProcessing")}
                </TooltipContent>
              )}
            </Tooltip>
          )}
          {canEditOrders && (
            <Button
              size="sm"
              variant="outline"
              className="gap-1.5"
              tabIndex={!fullHeaderVisible ? -1 : undefined}
              onClick={() => setEditOpen(true)}
              data-testid="button-edit-order"
            >
              <Pencil size={14} />
              {t("orders.editOrder")}
            </Button>
          )}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                size="sm"
                variant="outline"
                className="gap-1.5"
                tabIndex={!fullHeaderVisible ? -1 : undefined}
                data-testid="button-more-actions"
              >
                <MoreHorizontal size={14} />
                {t("orders.moreActions")}
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem
                onClick={handleGenerateInvoice}
                disabled={generatingInvoice}
              >
                <FileText size={14} className="mr-2" />
                {t("orders.generateInvoice")}
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => openPrintCardDialog()}>
                <Printer size={14} className="mr-2" />
                {t("orders.printCard")}
              </DropdownMenuItem>
              {canEditOrders && !order.is_sensitive_occasion && (
                <DropdownMenuItem
                  onClick={() => handleToggleSensitive(true)}
                  data-testid="button-sensitive-flag"
                >
                  <HeartHandshake size={14} className="mr-2" />
                  {t("orders.sensitiveFlag")}
                </DropdownMenuItem>
              )}
              {canEditOrders && (
                <DropdownMenuItem
                  onClick={() => {
                    setFloristLocationId(
                      floristAssignment ? String(floristAssignment.location_id) : "",
                    );
                    setSendToFloristOpen(true);
                  }}
                  data-testid="button-send-to-florist"
                >
                  <Flower2 size={14} className="mr-2" />
                  {floristAssignment
                    ? t("orders.resendToFlorist")
                    : t("orders.sendToFlorist")}
                </DropdownMenuItem>
              )}
              {canEditOrders &&
                ["stripe", "paypal"].includes(
                  (order.payment_provider ?? "").toLowerCase(),
                ) &&
                !!order.payment_reference &&
                order.status !== "refunded" &&
                order.payment_status !== "refunded" && (
                  <DropdownMenuItem onClick={() => setRefundOpen(true)}>
                    <RotateCcw size={14} className="mr-2" />
                    {t("orders.refund")}
                  </DropdownMenuItem>
                )}
              {canDeleteOrders && (
                <>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem
                    className="text-destructive focus:text-destructive"
                    onClick={() => setDeleteOpen(true)}
                  >
                    <Trash2 size={14} className="mr-2" />
                    {t("orders.deleteOrder")}
                  </DropdownMenuItem>
                </>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>

      <OrderStatusStepper
        status={order.status}
        statusTimestamps={data.status_timestamps ?? {}}
        timezone={data.timezone ?? "UTC"}
        orderedAt={order.ordered_at}
      />
      <div
        ref={fullHeaderBoundaryRef}
        className="h-px"
        data-testid="order-compact-header-sentinel"
        aria-hidden="true"
      />

      {/* Schedule / assignment strip — when is it due, who has it */}
      <div
        className="flex flex-wrap items-center gap-x-6 gap-y-3 rounded-lg border bg-card px-4 py-3 text-sm"
        data-testid="strip-due-assignment"
      >
        <div className="flex flex-wrap items-center gap-3" data-testid="scheduled-delivery-block">
          <div className="flex min-w-0 items-center gap-2">
            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-emerald-50 text-emerald-700">
              <CalendarDays size={18} aria-hidden="true" />
            </span>
            <div className="min-w-0">
              <span className="block text-xs text-muted-foreground">
                {t("orders.scheduledDelivery")}
              </span>
              <span className="block whitespace-normal font-semibold text-foreground">
                {operationalSchedule?.relativeLabel ? (
                  <>
                    <strong>{operationalSchedule.relativeLabel}</strong>
                    {operationalSchedule.fullLabel.slice(
                      operationalSchedule.relativeLabel.length,
                    )}
                  </>
                ) : (
                  operationalSchedule?.fullLabel ?? t("orders.noDeliveryDate")
                )}
              </span>
            </div>
          </div>
          {canEditOrders && (
            <Tooltip>
              <TooltipTrigger asChild>
                <span tabIndex={rescheduleUnavailable ? 0 : -1}>
                  <Button
                    size="sm"
                    variant="outline"
                    className="gap-1.5 border-emerald-600 text-emerald-700 hover:bg-emerald-50 hover:text-emerald-800 focus-visible:ring-2 focus-visible:ring-emerald-600"
                    onClick={() => setRescheduleOpen(true)}
                    disabled={!!rescheduleUnavailable}
                    data-testid="button-reschedule-delivery"
                  >
                    <CalendarDays size={14} aria-hidden="true" />
                    {t("orders.reschedule")}
                  </Button>
                </span>
              </TooltipTrigger>
              {rescheduleUnavailable && (
                <TooltipContent>{rescheduleUnavailable}</TooltipContent>
              )}
            </Tooltip>
          )}
        </div>
        {(() => {
          const effectiveDeliveredAt =
            assignment?.delivered_at ?? order.tookan_delivered_at ?? null;
          const tz = data.timezone ?? "UTC";
          const punct = computePunctuality(
            effectiveDeliveredAt,
            order.window_start,
            order.window_end,
            tz,
          );
          const isDelivered = normalizeOrderStatus(order.status) === "completed";

          if (punct.verdict === "unavailable") {
            if (!isDelivered) return null;
            return (
              <span className="text-xs text-muted-foreground">
                {t("orders.performanceUnavailable", "Performance unavailable")}
              </span>
            );
          }

          const pillCls =
            punct.verdict === "early"
              ? "bg-amber-100 text-amber-800 border border-amber-200"
              : punct.verdict === "on_time"
                ? "bg-green-100 text-green-800 border border-green-200"
                : "bg-red-100 text-red-800 border border-red-200";

          const pillLabel =
            punct.verdict === "early"
              ? t("orders.deliveryEarly", "Early")
              : punct.verdict === "on_time"
                ? t("orders.deliveryOnTime", "On time")
                : t("orders.deliveryLate", "Late");

          const supportText =
            punct.verdict === "on_time"
              ? `Delivered ${punct.deliveredLabel}`
              : (punct.varianceLabel ?? "");

          return (
            <div className="flex items-center gap-1.5">
              <span
                className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${pillCls}`}
                data-testid="punctuality-pill"
              >
                {pillLabel}
              </span>
              {supportText && (
                <span className="text-xs text-muted-foreground">{supportText}</span>
              )}
            </div>
          );
        })()}
        <div className="flex items-center gap-1.5">
          <Flower2 size={14} className="text-muted-foreground" />
          <span className="text-muted-foreground">{t("orders.florist")}:</span>
          <span className="font-medium">
            {floristAssignment?.location_name ?? t("orders.unassigned")}
          </span>
        </div>
        <div className="flex items-center gap-1.5">
          <Truck size={14} className="text-muted-foreground" />
          <span className="text-muted-foreground">{t("orders.driver")}:</span>
          <span className="font-medium">
            {assignment
              ? [assignment.driver_first_name, assignment.driver_last_name]
                  .filter(Boolean)
                  .join(" ") || t("orders.unassigned")
              : t("orders.unassigned")}
          </span>
        </div>
        {canEditOrders && order.tookan_job_id && (
          <div className="flex items-center gap-1.5">
            <span className="text-muted-foreground">Tookan:</span>
            {(() => {
              const badge = getTookanStatusBadge(order.tookan_status, order.tookan_job_id);
              return <Badge className={badge.className}>{t(badge.labelKey)}</Badge>;
            })()}
          </div>
        )}
      </div>

      {canEditOrders && (
        <RescheduleDeliveryDialog
          orderId={resolvedOrderId}
          order={order}
          timezone={data.timezone ?? "UTC"}
          open={rescheduleOpen}
          onOpenChange={setRescheduleOpen}
          onSuccess={() => {
            void queryClient.invalidateQueries({ queryKey: ["order", orderId] });
            void queryClient.invalidateQueries({ queryKey: ["orders"] });
            void queryClient.invalidateQueries({
              queryKey: getListOrderActivityQueryKey(resolvedOrderId),
            });
            void queryClient.invalidateQueries({ queryKey: ["fleet-orders"] });
            toast({ title: t("orders.rescheduleSaved") });
          }}
        />
      )}

      {/* Send to Florist dialog (owner-only) */}
      <Dialog
        open={sendToFloristOpen}
        onOpenChange={(open) => {
          setSendToFloristOpen(open);
          if (!open) setFloristDialogForPreparing(false);
        }}
      >
        <DialogContent data-testid="dialog-send-to-florist">
          <DialogHeader>
            <DialogTitle>
              {floristDialogForPreparing
                ? t("orders.markPreparingTitle")
                : t("orders.sendToFlorist")}
            </DialogTitle>
            <DialogDescription>
              {floristDialogForPreparing
                ? t("orders.markPreparingBody")
                : floristAssignment
                  ? t("orders.sendToFloristReplaceBody", {
                      location: floristAssignment.location_name ?? "",
                    })
                  : t("orders.sendToFloristBody")}
            </DialogDescription>
          </DialogHeader>
          <div className="py-2 space-y-1.5">
            <Label>{t("orders.floristLocation")}</Label>
            <Select value={floristLocationId} onValueChange={setFloristLocationId}>
              <SelectTrigger className="w-full" data-testid="select-florist-location">
                <SelectValue placeholder={t("orders.floristLocationPlaceholder")} />
              </SelectTrigger>
              <SelectContent>
                {floristLocations.map((loc) => (
                  <SelectItem key={loc.id} value={String(loc.id)}>
                    {loc.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setSendToFloristOpen(false)}>
              {t("orders.cancel")}
            </Button>
            <Button
              disabled={!floristLocationId || sendToFloristMut.isPending}
              onClick={handleSendToFlorist}
              data-testid="button-confirm-send-to-florist"
            >
              {sendToFloristMut.isPending && (
                <Loader2 size={14} className="mr-1.5 animate-spin" />
              )}
              {floristDialogForPreparing
                ? t("orders.markPreparingConfirm")
                : t("orders.sendToFlorist")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <AlertDialog
        open={unassignFloristOpen}
        onOpenChange={(open) => {
          if (!unassignFloristMut.isPending) setUnassignFloristOpen(open);
        }}
      >
        <AlertDialogContent data-testid="dialog-unassign-florist">
          <AlertDialogHeader>
            <AlertDialogTitle>{t("orders.unassignFloristTitle")}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("orders.unassignFloristBody", {
                location: floristAssignment?.location_name ?? t("orders.florist"),
              })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={unassignFloristMut.isPending}>
              {t("common.cancel")}
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={(event) => {
                event.preventDefault();
                handleUnassignFlorist();
              }}
              disabled={unassignFloristMut.isPending}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              data-testid="button-confirm-unassign-florist"
            >
              {unassignFloristMut.isPending && (
                <Loader2 size={14} className="mr-1.5 animate-spin" />
              )}
              {t("orders.unassignFlorist")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={deleteOpen} onOpenChange={setDeleteOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("orders.deleteConfirmTitle")}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("orders.deleteConfirmBody", { order: orderLabel })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleteMut.isPending}>
              {t("orders.cancel")}
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => {
                e.preventDefault();
                handleDelete(order.id);
              }}
              disabled={deleteMut.isPending}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {deleteMut.isPending && (
                <Loader2 size={14} className="mr-1.5 animate-spin" />
              )}
              {t("orders.deleteOrder")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {(() => {
        const refundInfo = resolveRefundInfo(order);
        const partialSupported = refundInfo.paidTotal != null;
        const remaining = refundInfo.remaining;
        const parsedAmount = Number.parseFloat(refundAmountInput);
        const amountValid =
          Number.isFinite(parsedAmount) &&
          parsedAmount > 0 &&
          (remaining == null || parsedAmount <= remaining + 0.005);
        const amountError =
          refundMode === "partial" &&
          refundAmountInput.trim() !== "" &&
          !amountValid
            ? remaining != null && Number.isFinite(parsedAmount) && parsedAmount > remaining
              ? t("orders.refundExceedsRemaining", {
                  amount: formatMoney(remaining, refundInfo.currency),
                })
              : t("orders.refundInvalidAmount")
            : null;
        const confirmDisabled =
          refundMut.isPending ||
          (refundMode === "partial" && (!partialSupported || !amountValid));
        return (
          <AlertDialog open={refundOpen} onOpenChange={setRefundOpen}>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>{t("orders.refundConfirmTitle")}</AlertDialogTitle>
                <AlertDialogDescription>
                  {t("orders.refundConfirmBody", { order: orderLabel })}
                </AlertDialogDescription>
              </AlertDialogHeader>

              <div className="space-y-3">
                {refundInfo.paidTotal != null && (
                  <div className="rounded-md bg-muted/50 p-3 text-sm space-y-1">
                    <div className="flex justify-between">
                      <span className="text-muted-foreground">
                        {t("orders.refundPaidTotal")}
                      </span>
                      <span className="font-medium">
                        {formatMoney(refundInfo.paidTotal, refundInfo.currency)}
                      </span>
                    </div>
                    {refundInfo.alreadyRefunded > 0 && (
                      <div className="flex justify-between">
                        <span className="text-muted-foreground">
                          {t("orders.refundAlreadyRefunded")}
                        </span>
                        <span className="font-medium">
                          {formatMoney(
                            refundInfo.alreadyRefunded,
                            refundInfo.currency,
                          )}
                        </span>
                      </div>
                    )}
                    {remaining != null && (
                      <div className="flex justify-between">
                        <span className="text-muted-foreground">
                          {t("orders.refundRemaining")}
                        </span>
                        <span className="font-semibold">
                          {formatMoney(remaining, refundInfo.currency)}
                        </span>
                      </div>
                    )}
                  </div>
                )}

                {partialSupported && (
                  <div className="space-y-2">
                    <div className="flex gap-2">
                      <Button
                        type="button"
                        size="sm"
                        variant={refundMode === "full" ? "default" : "outline"}
                        className="flex-1"
                        onClick={() => setRefundMode("full")}
                      >
                        {t("orders.refundFull")}
                      </Button>
                      <Button
                        type="button"
                        size="sm"
                        variant={refundMode === "partial" ? "default" : "outline"}
                        className="flex-1"
                        onClick={() => {
                          setRefundMode("partial");
                          if (remaining != null) {
                            setRefundAmountInput(remaining.toFixed(2));
                          }
                        }}
                      >
                        {t("orders.refundPartial")}
                      </Button>
                    </div>
                    {refundMode === "partial" && (
                      <div className="space-y-1">
                        <Label htmlFor="refund-amount">
                          {t("orders.refundAmountLabel", {
                            currency: refundInfo.currency,
                          })}
                        </Label>
                        <Input
                          id="refund-amount"
                          type="number"
                          min="0"
                          step="0.01"
                          inputMode="decimal"
                          value={refundAmountInput}
                          onChange={(e) => setRefundAmountInput(e.target.value)}
                          placeholder={
                            remaining != null ? remaining.toFixed(2) : "0.00"
                          }
                        />
                        {amountError && (
                          <p className="text-xs text-destructive">{amountError}</p>
                        )}
                      </div>
                    )}
                  </div>
                )}
              </div>

              <AlertDialogFooter>
                <AlertDialogCancel disabled={refundMut.isPending}>
                  {t("orders.cancel")}
                </AlertDialogCancel>
                <AlertDialogAction
                  onClick={(e) => {
                    e.preventDefault();
                    handleRefund(
                      order.id,
                      refundMode === "partial" ? parsedAmount : undefined,
                    );
                  }}
                  disabled={confirmDisabled}
                >
                  {refundMut.isPending && (
                    <Loader2 size={14} className="mr-1.5 animate-spin" />
                  )}
                  {t("orders.refund")}
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        );
      })()}

      <AlertDialog open={markPaidOpen} onOpenChange={setMarkPaidOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("orders.markPaidConfirmTitle")}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("orders.markPaidConfirmBody", { order: orderLabel })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={markPaidMut.isPending}>
              {t("orders.cancel")}
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => {
                e.preventDefault();
                handleMarkPaid(order.id);
              }}
              disabled={markPaidMut.isPending}
            >
              {markPaidMut.isPending && (
                <Loader2 size={14} className="mr-1.5 animate-spin" />
              )}
              {t("orders.markPaid")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {canEditOrders && editOpen && (
        <OrderEditDialog
          open={editOpen}
          onOpenChange={setEditOpen}
          order={order}
          assignment={assignment}
          customer={customer}
          recipient={recipient}
          orderId={order.id}
          timezone={data.timezone ?? "UTC"}
        />
      )}

      <ContactEditHistoryDialog
        orderId={order.id}
        role="customer"
        open={customerHistoryOpen}
        onOpenChange={setCustomerHistoryOpen}
      />
      <ContactEditHistoryDialog
        orderId={order.id}
        role="recipient"
        open={recipientHistoryOpen}
        onOpenChange={setRecipientHistoryOpen}
      />

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {/* Recipient */}
        <Card data-testid="card-recipient">
          <CardHeader className="pb-3">
            <CardTitle className="text-sm font-medium flex items-center gap-2">
              <User size={15} className="text-muted-foreground" />
              {t("orders.sectionRecipient")}
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-1 text-sm">
            {recipientName || recipient?.phone ? (
              <>
                {recipientName && <p className="font-medium">{recipientName}</p>}
                {recipient?.phone && (
                  <p className="text-muted-foreground" dir="ltr">{recipient.phone}</p>
                )}
                {recipient && (
                  <div className="flex flex-wrap gap-2 pt-2">
                    {recipient.phone && (
                      <Button size="sm" variant="outline" className="gap-1.5" asChild>
                        <a href={`tel:${recipient.phone}`} data-testid="button-call-recipient">
                          <Phone size={14} />
                          {t("orders.call")}
                        </a>
                      </Button>
                    )}
                    {recipient.respondio_url ? (
                      <Button size="sm" variant="outline" className="gap-1.5" asChild>
                        <a
                          href={recipient.respondio_url}
                          target="_blank"
                          rel="noopener noreferrer"
                          data-testid="button-whatsapp-recipient"
                        >
                          <MessageCircle size={14} />
                          {t("orders.whatsapp")}
                        </a>
                      </Button>
                    ) : (
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <span tabIndex={0}>
                            <Button
                              size="sm"
                              variant="outline"
                              className="gap-1.5"
                              disabled
                              data-testid="button-whatsapp-recipient-unavailable"
                              style={{ pointerEvents: "none" }}
                            >
                              <MessageCircle size={14} />
                              {t("orders.respondioUnavailable")}
                            </Button>
                          </span>
                        </TooltipTrigger>
                        <TooltipContent>
                          {recipient.respondio_sync_status === "phone_format_invalid"
                            ? t("orders.respondioPhoneFormatInvalid")
                            : recipient.respondio_synced
                              ? t("orders.respondioSpaceIdMissing")
                              : t("orders.respondioUnavailableTitle")}
                        </TooltipContent>
                      </Tooltip>
                    )}
                  </div>
                )}
                {recipientPriorOrders > 0 && (
                  <div className="pt-1.5 space-y-1">
                    <Badge
                      className="bg-emerald-100 text-emerald-800 border-emerald-200 hover:bg-emerald-100 border text-xs font-medium"
                      data-testid="badge-returning-recipient"
                    >
                      {t("orders.returningRecipient")}
                    </Badge>
                    <p className="text-xs text-muted-foreground">
                      {t("orders.previousOrders", { count: recipientPriorOrders })}
                    </p>
                  </div>
                )}
              </>
            ) : (
              <p className="text-muted-foreground italic">{t("orders.noContact")}</p>
            )}
            <ContactEditedNote edit={recipientEdit} />
            {recipientEdit && (
              <ContactEditHistoryButton onClick={() => setRecipientHistoryOpen(true)} />
            )}
          </CardContent>
        </Card>

        <DeliveryDetailsCard
          order={order}
          recipientHasContact={!!recipient}
          recipientPhone={recipient?.phone ?? null}
          recipientRespondioUrl={recipient?.respondio_url ?? null}
          recipientRespondioSynced={recipient?.respondio_synced}
          recipientRespondioSyncStatus={recipient?.respondio_sync_status}
          canRequestAddress={canEditOrders}
          isRequestingAddress={requestAddressMut.isPending}
          onRequestAddress={() => requestAddressMut.mutate()}
        />
      </div>

      {/* Line items */}
      <LineItemsSection
        orderId={order.id}
        order={order}
        assignment={data.assignment ?? null}
        lineItems={line_items}
        edited={!!data.line_items_edited}
        canEdit={canEditOrders}
      />

      {/* Card Message */}
      <Card>
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between gap-2">
            <CardTitle className="text-sm font-medium flex items-center gap-2">
              <MessageSquare size={15} className="text-muted-foreground" />
              {t("orders.sectionCardMessage")}
            </CardTitle>
            <div className="flex items-center gap-2">
              {canEditOrders && !editingCard && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => startCardEdit(order)}
                >
                  <Pencil size={14} className="mr-1" />
                  {t("orders.editCardMessage")}
                </Button>
              )}
              {canEditOrders && !addingCard && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setAddingCard(true)}
                  data-testid="button-add-card-message"
                >
                  <Plus size={14} className="mr-1" />
                  {t("orders.addCardMessage")}
                </Button>
              )}
              <Button
                variant="outline"
                size="sm"
                onClick={() => openPrintCardDialog()}
                data-testid="button-print-card"
              >
                <Printer size={14} className="mr-1" />
                {t("orders.printCard")}
              </Button>
            </div>
          </div>
        </CardHeader>
        <CardContent className="text-sm space-y-2">
          {editingCard ? (
            <div className="space-y-3">
              <div className="space-y-1.5">
                <Label htmlFor="card-edit-to">{t("orders.cardTo")}</Label>
                <Input
                  id="card-edit-to"
                  value={cardForm.card_to}
                  maxLength={300}
                  onChange={(e) =>
                    setCardForm((f) => ({ ...f, card_to: e.target.value }))
                  }
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="card-edit-message">
                  {t("orders.cardMessageLabel")}
                </Label>
                <Textarea
                  id="card-edit-message"
                  rows={4}
                  value={cardForm.card_message}
                  maxLength={5000}
                  onChange={(e) =>
                    setCardForm((f) => ({ ...f, card_message: e.target.value }))
                  }
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="card-edit-from">{t("orders.cardFrom")}</Label>
                <Input
                  id="card-edit-from"
                  value={cardForm.card_from}
                  maxLength={300}
                  onChange={(e) =>
                    setCardForm((f) => ({ ...f, card_from: e.target.value }))
                  }
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="card-edit-qr-link">{t("orders.qrLinkLabel")}</Label>
                <Input
                  id="card-edit-qr-link"
                  type="url"
                  dir="ltr"
                  value={cardForm.qr_link}
                  maxLength={2000}
                  placeholder={t("orders.qrLinkPlaceholder")}
                  aria-invalid={!!qrLinkError}
                  className={qrLinkError ? "border-destructive" : undefined}
                  onChange={(e) => {
                    setCardForm((f) => ({ ...f, qr_link: e.target.value }));
                    if (qrLinkError) setQrLinkError(null);
                  }}
                />
                {qrLinkError && (
                  <p className="text-xs text-destructive">{qrLinkError}</p>
                )}
              </div>
              <div className="flex justify-end gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setEditingCard(false)}
                  disabled={updateCardMut.isPending}
                >
                  {t("common.cancel")}
                </Button>
                <Button
                  size="sm"
                  onClick={handleSaveCard}
                  disabled={updateCardMut.isPending}
                >
                  {updateCardMut.isPending && (
                    <Loader2 size={14} className="mr-1 animate-spin" />
                  )}
                  {t("common.save")}
                </Button>
              </div>
            </div>
          ) : (
            <div className="space-y-3">
              <div className="rounded-md border p-3 space-y-2" data-testid="card-message-primary">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-xs font-medium text-muted-foreground">
                    {t("orders.primaryCardMessage")}
                  </span>
                  <Button variant="ghost" size="sm" onClick={() => openPrintCardDialog()}>
                    <Printer size={14} className="mr-1" />
                    {t("orders.printCard")}
                  </Button>
                </div>
              {order.card_message ? (
                <>
              {order.card_to && (
                <p>
                  <span className="font-medium text-muted-foreground">{t("orders.cardTo")}: </span>
                  <span className="break-words">{order.card_to}</span>
                </p>
              )}
              {order.card_message && (
                <p className="whitespace-pre-wrap break-words">{order.card_message}</p>
              )}
              {order.card_from && (
                <p>
                  <span className="font-medium text-muted-foreground">{t("orders.cardFrom")}: </span>
                  <span className="break-words">{order.card_from}</span>
                </p>
              )}
                </>
              ) : (
                <p className="text-muted-foreground italic">{t("orders.noCardMessage")}</p>
              )}
              {order.qr_link?.trim() && <QrLinkRow url={order.qr_link} t={t} />}
              </div>
              {cakeItem?.custom_input && (
                <div className="rounded-md border p-3 space-y-2" data-testid="cake-message">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-xs font-medium text-muted-foreground">{t("cardMessage.cakeMessage")}</span>
                    <Button variant="ghost" size="sm" data-testid="button-print-cake" onClick={() => {
                      setCakeLocation("");
                      setCakePrintError(null);
                      setCakePrintOpen(true);
                    }}>
                      <Printer size={14} className="mr-1" />{t("cardMessage.printCake")}
                    </Button>
                  </div>
                  <p className="whitespace-pre-wrap break-words">{cakeItem.custom_input}</p>
                </div>
              )}
              {(data.additional_card_messages ?? []).map((card, index) => (
                <div
                  key={card.id}
                  className="rounded-md border p-3 space-y-2"
                  data-testid={`card-message-extra-${index}`}
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-xs font-medium text-muted-foreground">
                      {t("orders.additionalCardMessage", { number: index + 2 })}
                    </span>
                    <Button variant="ghost" size="sm" onClick={() => openPrintCardDialog(card)}>
                      <Printer size={14} className="mr-1" />
                      {t("orders.printCard")}
                    </Button>
                  </div>
                  {card.card_to && <p><span className="font-medium text-muted-foreground">{t("orders.cardTo")}: </span>{card.card_to}</p>}
                  <p className="whitespace-pre-wrap break-words">{card.card_message}</p>
                  {card.card_from && <p><span className="font-medium text-muted-foreground">{t("orders.cardFrom")}: </span>{card.card_from}</p>}
                  {card.qr_link?.trim() && <QrLinkRow url={card.qr_link} t={t} />}
                </div>
              ))}
            </div>
          )}
          {addingCard && (
            <div className="rounded-md border p-3 space-y-3" data-testid="form-add-card-message">
              <div className="space-y-1.5">
                <Label htmlFor="additional-card-to">{t("orders.cardTo")}</Label>
                <Input id="additional-card-to" maxLength={300} value={additionalCardForm.card_to} onChange={(e) => setAdditionalCardForm((f) => ({ ...f, card_to: e.target.value }))} />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="additional-card-message">{t("orders.cardMessageLabel")}</Label>
                <Textarea id="additional-card-message" rows={4} required maxLength={5000} value={additionalCardForm.card_message} onChange={(e) => setAdditionalCardForm((f) => ({ ...f, card_message: e.target.value }))} />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="additional-card-from">{t("orders.cardFrom")}</Label>
                <Input id="additional-card-from" maxLength={300} value={additionalCardForm.card_from} onChange={(e) => setAdditionalCardForm((f) => ({ ...f, card_from: e.target.value }))} />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="additional-card-qr">{t("orders.qrLinkLabel")}</Label>
                <Input id="additional-card-qr" dir="ltr" maxLength={2000} placeholder={t("orders.qrLinkPlaceholder")} value={additionalCardForm.qr_link} aria-invalid={!!additionalQrLinkError} onChange={(e) => { setAdditionalCardForm((f) => ({ ...f, qr_link: e.target.value })); setAdditionalQrLinkError(null); }} />
                {additionalQrLinkError && <p className="text-xs text-destructive">{additionalQrLinkError}</p>}
              </div>
              <div className="flex justify-end gap-2">
                <Button variant="outline" size="sm" onClick={() => setAddingCard(false)} disabled={addCardMut.isPending}>{t("common.cancel")}</Button>
                <Button size="sm" onClick={handleSaveAdditionalCard} disabled={addCardMut.isPending || !additionalCardForm.card_message.trim()} data-testid="button-save-additional-card">
                  {addCardMut.isPending && <Loader2 size={14} className="mr-1 animate-spin" />}
                  {t("common.save")}
                </Button>
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Payment — collapsed to a one-line summary chip; expands to details */}
      <Collapsible open={paymentOpen} onOpenChange={setPaymentOpen}>
        <Card data-testid="card-payment">
          <CollapsibleTrigger asChild>
            <button type="button" className="w-full text-left" data-testid="button-payment-chip">
              <CardHeader className="py-3">
                <div className="flex items-center justify-between gap-2">
                  <div className="flex items-center gap-2 flex-wrap text-sm">
                    <CreditCard size={15} className="text-muted-foreground" />
                    <span className="font-medium">{t("orders.sectionPayment")}</span>
                    <span className="text-muted-foreground">·</span>
                    {order.payment_status ? (
                      <Badge variant="secondary" className="text-xs capitalize">
                        {t(
                          `orders.paymentStatus${order.payment_status
                            .split("_")
                            .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
                            .join("")}`,
                          { defaultValue: order.payment_status.replace(/_/g, " ") },
                        )}
                      </Badge>
                    ) : (
                      <span className="text-muted-foreground">—</span>
                    )}
                    <span className="text-muted-foreground">·</span>
                    <span className="font-semibold">{formatTotal(order)}</span>
                    {formatPaymentMethodLabel(order.payment_method) && (
                      <>
                        <span className="text-muted-foreground">·</span>
                        <span>
                          {formatPaymentMethodLabel(order.payment_method)}
                          {order.payment_provider &&
                            (order.payment_provider ?? "").toLowerCase() !==
                              (order.payment_method ?? "").toLowerCase() &&
                            ` ${t("orders.paymentVia", {
                              provider: formatPaymentMethodLabel(order.payment_provider),
                            })}`}
                        </span>
                      </>
                    )}
                  </div>
                  <ChevronDown
                    size={16}
                    className={cn(
                      "shrink-0 text-muted-foreground transition-transform",
                      paymentOpen && "rotate-180",
                    )}
                  />
                </div>
              </CardHeader>
            </button>
          </CollapsibleTrigger>
          <CollapsibleContent>
            <CardContent className="space-y-1 text-sm pt-0">
              {formatPaymentMethodLabel(order.payment_method) && (
                <p className="text-muted-foreground">
                  {t("orders.paymentMethod")}:{" "}
                  <span className="text-foreground">
                    {formatPaymentMethodLabel(order.payment_method)}
                  </span>
                </p>
              )}
               {(order.linked_payment_links ?? (order.payment_link ? [order.payment_link] : [])).map((paymentLink) => (
                 <LinkedPaymentLinkRow key={paymentLink.id} paymentLink={paymentLink} />
               ))}
               {order.payment_summary && (
                 <div className="mt-2 grid grid-cols-2 gap-2 rounded-md bg-muted/50 p-3 text-sm sm:grid-cols-4">
                   <div><p className="text-xs text-muted-foreground">Commercial total</p><p className="font-medium">{formatMoney(Number(order.payment_summary.commercial_total ?? 0), order.payment_summary.commercial_currency ?? "USD")}</p></div>
                   <div><p className="text-xs text-muted-foreground">Paid</p><p className="font-medium">{formatMoney(Number(order.payment_summary.paid), order.payment_summary.commercial_currency ?? "USD")}</p></div>
                   <div><p className="text-xs text-muted-foreground">Pending</p><p className="font-medium">{formatMoney(Number(order.payment_summary.pending), order.payment_summary.commercial_currency ?? "USD")}</p></div>
                   <div><p className="text-xs text-muted-foreground">{Number(order.payment_summary.overpaid) > 0 ? "Overpaid" : "Remaining"}</p><p className="font-medium">{formatMoney(Number(order.payment_summary.overpaid) > 0 ? Number(order.payment_summary.overpaid) : Number(order.payment_summary.remaining ?? 0), order.payment_summary.commercial_currency ?? "USD")}</p></div>
                   {order.payment_summary.currency_mismatch && <p className="col-span-full text-amber-700">One or more linked payments use a different currency and are not included in the paid total.</p>}
                 </div>
               )}
               {canEditOrders && (
                 <Button size="sm" variant="outline" className="mt-2 gap-1.5" onClick={() => setLinkExistingPaymentOpen(true)}>
                   <Link2 size={14} /> Link existing payment
                 </Button>
               )}
              {order.payment_provider && (
                <p className="text-muted-foreground">
                  {t("orders.paymentProvider")}:{" "}
                  <span className="text-foreground">
                    {formatPaymentMethodLabel(order.payment_provider)}
                  </span>
                </p>
              )}
              {order.paid_at && (
                <p className="text-muted-foreground">
                  {t("orders.paidAt")}: <span className="text-foreground">{formatDateTime(order.paid_at)}</span>
                </p>
              )}
              {whishPayment && order.whish_instructions_sent_at && (
                <p className="text-muted-foreground">
                  {t("orders.whishInstructionsAutomaticallySentAt")}:{" "}
                  <span className="text-foreground">
                    {formatDateTime(order.whish_instructions_sent_at)}
                  </span>
                </p>
              )}
              <p className="font-semibold pt-1">{t("orders.total")}: {formatTotal(order)}</p>
              {(() => {
                const info = resolveRefundInfo(order);
                if (info.alreadyRefunded <= 0) return null;
                return (
                  <>
                    <p className="text-muted-foreground">
                      {t("orders.refundAlreadyRefunded")}:{" "}
                      <span className="text-foreground font-medium">
                        {formatMoney(info.alreadyRefunded, info.currency)}
                      </span>
                    </p>
                    {info.remaining != null && info.remaining > 0.005 && (
                      <p className="text-muted-foreground">
                        {t("orders.refundRemaining")}:{" "}
                        <span className="text-foreground font-medium">
                          {formatMoney(info.remaining, info.currency)}
                        </span>
                      </p>
                    )}
                  </>
                );
              })()}
              {canEditOrders &&
                order.status !== "refunded" &&
                (order.payment_status ?? "").toLowerCase() !== "paid" &&
                !(order.payment_status ?? "").toLowerCase().includes("refund") &&
                resolveRefundInfo(order).alreadyRefunded <= 0 && (
                  <div className="flex flex-wrap gap-2 pt-2">
                    <Button
                      size="sm"
                      variant="default"
                      className="gap-1.5"
                      onClick={() => setMarkPaidOpen(true)}
                      disabled={markPaidMut.isPending}
                    >
                      <BadgeCheck size={14} />
                      {t("orders.markPaid")}
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      className="gap-1.5"
                      onClick={() => order.id && handleSendPaymentInstructions(order.id)}
                      disabled={sendInstructionsMut.isPending}
                    >
                      {sendInstructionsMut.isPending ? (
                        <Loader2 size={14} className="animate-spin" />
                      ) : (
                        <Send size={14} />
                      )}
                      {t("orders.sendInstructions")}
                    </Button>
                  </div>
                )}
              {canEditOrders && canResendWhishInstructions && (
                <div className="flex flex-wrap gap-2 pt-2">
                  <Button
                    size="sm"
                    variant="outline"
                    className="gap-1.5"
                    onClick={() => order.id && handleResendWhishPaymentInstructions(order.id)}
                    disabled={resendWhishInstructionsMut.isPending}
                    data-testid="button-resend-whish-payment-instructions"
                  >
                    {resendWhishInstructionsMut.isPending ? (
                      <Loader2 size={14} className="animate-spin" />
                    ) : (
                      <MessageCircle size={14} />
                    )}
                    {t("orders.resendWhishPaymentInstructions")}
                  </Button>
                </div>
              )}
              {canEditOrders &&
                (order.payment_provider ?? "").toLowerCase() === "stripe" &&
                !!order.payment_reference &&
                order.status !== "refunded" &&
                (order.payment_status ?? "").toLowerCase() !== "refunded" && (
                  <div className="pt-2">
                    <Button
                      size="sm"
                      variant="outline"
                      className="gap-1.5"
                      onClick={() => setRefundOpen(true)}
                      disabled={refundMut.isPending}
                      data-testid="button-payment-card-refund"
                    >
                      <RotateCcw size={14} />
                      {t("orders.refund")}
                    </Button>
                  </div>
                )}
            </CardContent>
          </CollapsibleContent>
        </Card>
      </Collapsible>

      <Dialog open={linkExistingPaymentOpen} onOpenChange={setLinkExistingPaymentOpen}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Link existing payment</DialogTitle>
            <DialogDescription>Select an available payment link. This never changes the commercial order total.</DialogDescription>
          </DialogHeader>
          <div className="max-h-72 space-y-2 overflow-y-auto">
            {availablePayments.isLoading && <p className="text-sm text-muted-foreground">Loading payment links…</p>}
            {availablePayments.isError && <p className="text-sm text-destructive">Could not load payment links. Close and try again.</p>}
            {(availablePayments.data?.payment_links ?? []).filter((link) => !(link as LinkedPaymentLink & { order_id?: string | null }).order_id).map((link) => (
              <button key={link.id} type="button" onClick={() => { setSelectedExistingPayment(link); setConfirmExistingPayment(false); }}
                className={cn("w-full rounded-md border p-3 text-left text-sm", selectedExistingPayment?.id === link.id && "border-teal-700 bg-teal-50")}>
                <span className="font-medium">{link.description || `Payment link #${link.id}`}</span>
                <span className="ml-2 text-muted-foreground">{(link.amount / 100).toFixed(2)} {link.currency} · {link.status}</span>
              </button>
            ))}
          </div>
          {selectedExistingPayment && (
            <label className="flex items-start gap-2 rounded-md border border-amber-200 bg-amber-50 p-3 text-sm">
              <input type="checkbox" checked={confirmExistingPayment} onChange={(e) => setConfirmExistingPayment(e.target.checked)} className="mt-1" />
              <span>Confirm this association if the payment amount or currency differs. The order total remains unchanged.</span>
            </label>
          )}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setLinkExistingPaymentOpen(false)}>Cancel</Button>
            <Button type="button" disabled={!selectedExistingPayment || !confirmExistingPayment || linkExistingPayment.isPending} onClick={() => linkExistingPayment.mutate()}>
              {linkExistingPayment.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />} Link payment
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Coupon */}
      {order.coupon_code && (
        <Card data-testid="card-coupon">
          <CardHeader className="pb-3">
            <CardTitle className="text-sm font-medium flex items-center gap-2">
              <Tag size={15} className="text-muted-foreground" />
              {t("orders.sectionCoupon")}
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-1 text-sm">
            <div className="flex items-center gap-2 flex-wrap">
              <Badge variant="secondary" className="font-mono text-xs">
                {order.coupon_code}
              </Badge>
              {(() => {
                if (
                  order.coupon_discount_type === "percentage" &&
                  order.coupon_discount_value != null
                ) {
                  return (
                    <span className="text-muted-foreground">
                      {t("orders.couponPercentOff", {
                        value: order.coupon_discount_value,
                      })}
                    </span>
                  );
                }
                if (
                  order.coupon_discount_type === "fixed" &&
                  order.coupon_discount_value != null
                ) {
                  return (
                    <span className="text-muted-foreground">
                      {t("orders.couponAmountOff", {
                        value: order.coupon_discount_value,
                      })}
                    </span>
                  );
                }
                const applied = toFiniteNumber(order.coupon_discount_usd);
                if (applied != null && applied > 0) {
                  return (
                    <span className="text-muted-foreground">
                      {t("orders.couponApplied", {
                        amount: formatMoney(applied, "USD"),
                      })}
                    </span>
                  );
                }
                return null;
              })()}
            </div>
            {order.coupon_description && (
              <p className="text-xs text-muted-foreground">
                {order.coupon_description}
              </p>
            )}
          </CardContent>
        </Card>
      )}

      {/* Customer + Marketing attribution */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <Card data-testid="card-customer">
          <CardHeader className="pb-3">
            <CardTitle className="text-sm font-medium flex items-center gap-2">
              <User size={15} className="text-muted-foreground" />
              {t("orders.sectionCustomer")}
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-1 text-sm">
            {customer ? (
              <>
                <p className="font-medium">
                  {order.is_anonymous
                    ? t("orders.anonymousCustomer")
                    : (customer.display_name ??
                        ([customer.first_name, customer.last_name].filter(Boolean).join(" ") || "—"))}
                </p>
                {!order.is_anonymous && customer.email && <p className="text-muted-foreground break-words">{customer.email}</p>}
                {customer.phone && <p className="text-muted-foreground" dir="ltr">{customer.phone}</p>}
                {priorOrders > 0 && (
                  <div className="pt-1.5 space-y-1">
                    <Badge className="bg-emerald-100 text-emerald-800 border-emerald-200 hover:bg-emerald-100 border text-xs font-medium">
                      {t("orders.returningCustomer")}
                    </Badge>
                    <p className="text-xs text-muted-foreground">
                      {t("orders.previousOrders", { count: priorOrders })}
                    </p>
                  </div>
                )}
                <ContactEditedNote edit={customerEdit} />
                {customerEdit && (
                  <ContactEditHistoryButton onClick={() => setCustomerHistoryOpen(true)} />
                )}
              </>
            ) : (
              <>
                <p className="text-muted-foreground italic">{t("orders.noContact")}</p>
                <ContactEditedNote edit={customerEdit} />
                {customerEdit && (
                  <ContactEditHistoryButton onClick={() => setCustomerHistoryOpen(true)} />
                )}
              </>
            )}
          </CardContent>
        </Card>

        {/* Marketing attribution — where this order came from */}
        <Card data-testid="card-attribution">
          <CardHeader className="pb-3">
            <CardTitle className="text-sm font-medium flex items-center gap-2">
              <Megaphone size={15} className="text-muted-foreground" />
              {t("orders.attributionSection")}
            </CardTitle>
          </CardHeader>
          <CardContent className="text-sm space-y-1">
            {(() => {
              // Persisted shape (see external order ingest): { source,
              // first_touch, last_touch, conversion } where each touch holds
              // the UTM params / click IDs / referrer captured at that visit.
              const attr = (order.marketing_attribution ?? {}) as Record<string, unknown>;
              const asObj = (v: unknown): Record<string, unknown> =>
                v && typeof v === "object" && !Array.isArray(v)
                  ? (v as Record<string, unknown>)
                  : {};
              const firstTouch = asObj(attr.first_touch);
              const lastTouch = asObj(attr.last_touch);
              // Channel is judged on the converting (last) touch, falling
              // back to the first touch when the last one is empty.
              const touch = Object.keys(lastTouch).length > 0 ? lastTouch : firstTouch;
              const sv = (o: Record<string, unknown>, k: string) => {
                const v = o[k];
                return typeof v === "string" && v.trim() !== "" ? v.trim() : null;
              };
              const source = sv(attr, "source");
              const utmSource = sv(touch, "utm_source");
              const utmMedium = sv(touch, "utm_medium");
              const campaign = sv(touch, "utm_campaign");
              const gclid = sv(touch, "gclid") ?? sv(touch, "gbraid") ?? sv(touch, "wbraid");
              const fbclid = sv(touch, "fbclid");
              const referrer = sv(touch, "referrer");
              let channel: string | null = null;
              if (gclid) channel = "Google Ads";
              else if (fbclid) channel = "Meta Ads";
              else if (utmSource) channel = utmMedium ? `${utmSource} / ${utmMedium}` : utmSource;
              else if (source) channel = source;
              else if (referrer) {
                try {
                  channel = new URL(referrer).hostname;
                } catch {
                  channel = referrer;
                }
              }
              // Flatten scalar detail rows: source + each touch's scalar
              // fields, prefixed so first/last touch stay distinguishable.
              const scalarEntries = (
                prefix: string,
                o: Record<string, unknown>,
              ): Array<[string, string]> =>
                Object.entries(o)
                  .filter(
                    ([, v]) =>
                      (typeof v === "string" && v.trim() !== "") ||
                      typeof v === "number",
                  )
                  .map(([k, v]) => [prefix ? `${prefix} · ${k}` : k, String(v)]);
              const entries: Array<[string, string]> = [
                ...(source ? ([["source", source]] as Array<[string, string]>) : []),
                ...scalarEntries("last", lastTouch),
                ...scalarEntries("first", firstTouch),
              ];
              return (
                <>
                  <p className="text-muted-foreground">
                    {t("orders.attributionChannel")}:{" "}
                    <span className="text-foreground font-medium" data-testid="text-attribution-channel">
                      {channel ?? t("orders.attributionDirect")}
                    </span>
                  </p>
                  {campaign && (
                    <p className="text-muted-foreground">
                      {t("orders.attributionCampaign")}:{" "}
                      <span className="text-foreground">{campaign}</span>
                    </p>
                  )}
                  {entries.length > 0 ? (
                    <Collapsible open={attributionOpen} onOpenChange={setAttributionOpen}>
                      <CollapsibleTrigger asChild>
                        <Button
                          variant="ghost"
                          size="sm"
                          className="px-0 text-muted-foreground gap-1 hover:bg-transparent"
                          data-testid="button-attribution-details"
                        >
                          <ChevronDown
                            size={14}
                            className={cn("transition-transform", attributionOpen && "rotate-180")}
                          />
                          {t("orders.attributionShowAll")}
                        </Button>
                      </CollapsibleTrigger>
                      <CollapsibleContent>
                        <div className="space-y-0.5 pt-1">
                          {entries.map(([k, v]) => (
                            <p key={k} className="text-xs text-muted-foreground break-all">
                              <span className="font-medium">{k}</span>:{" "}
                              <span className="text-foreground">{String(v)}</span>
                            </p>
                          ))}
                        </div>
                      </CollapsibleContent>
                    </Collapsible>
                  ) : (
                    <p className="text-muted-foreground text-xs">
                      {t("orders.attributionNoneHint")}
                    </p>
                  )}
                </>
              );
            })()}
          </CardContent>
        </Card>
      </div>

      {/* Fulfillment / Activity / Internal notes */}
      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
        <Card data-testid="card-fulfillment">
          <CardHeader className="pb-3">
            <CardTitle className="text-sm font-medium flex items-center gap-2">
              <Truck size={15} className="text-muted-foreground" />
              {t("orders.sectionFulfillment")}
            </CardTitle>
          </CardHeader>
          <CardContent className="text-sm space-y-1">
            <p className="text-muted-foreground">
              {t("orders.florist")}:{" "}
              <span className="text-foreground">
                {floristAssignment?.location_name ?? t("orders.unassigned")}
              </span>
            </p>
            <p className="text-muted-foreground">
              {t("orders.driver")}:{" "}
              <span className="text-foreground">
                {assignment
                  ? [assignment.driver_first_name, assignment.driver_last_name]
                      .filter(Boolean)
                      .join(" ") || t("orders.unassigned")
                  : t("orders.unassigned")}
              </span>
            </p>
            {assignment && (
              <div className="flex items-center gap-2 pt-0.5">
                <span className="text-muted-foreground">{t("orders.assignmentStatus")}:</span>
                <Badge variant="secondary" className="text-xs capitalize">
                  {assignment.assignment_status.replace(/_/g, " ")}
                </Badge>
              </div>
            )}
            {canEditOrders && (
              <div className="flex flex-wrap gap-2 pt-2">
                <Button
                  size="sm"
                  variant="outline"
                  className="gap-1.5"
                  onClick={() => {
                    setFloristLocationId(
                      floristAssignment
                        ? String(floristAssignment.location_id)
                        : "",
                    );
                    setSendToFloristOpen(true);
                  }}
                  data-testid="button-assign-florist"
                >
                  <Flower2 size={14} />
                  {t("orders.assignFlorist")}
                </Button>
                {floristAssignment &&
                  floristAssignment.status !== "completed" && (
                    <Button
                      size="sm"
                      variant="outline"
                      className="gap-1.5 text-destructive hover:text-destructive"
                      onClick={() => setUnassignFloristOpen(true)}
                      data-testid="button-unassign-florist"
                    >
                      <Trash2 size={14} />
                      {t("orders.unassignFlorist")}
                    </Button>
                  )}
                {isOwner && (
                  <Button
                    size="sm"
                    variant="outline"
                    className="gap-1.5"
                    onClick={() => setAssignDriverOpen(true)}
                    data-testid="button-assign-driver"
                  >
                    <Truck size={14} />
                    {t("orders.assignDriver")}
                  </Button>
                )}
                <Button
                  size="sm"
                  variant="outline"
                  className="gap-1.5"
                  onClick={() => openPrintCardDialog()}
                  data-testid="button-print-ticket"
                >
                  <Printer size={14} />
                  {t("orders.printTicket")}
                </Button>
              </div>
            )}
          </CardContent>
        </Card>

        {floristAssignment && resolvedOrderId && (() => {
          const itemsSrc = floristVerificationPhotos
            ? imageUrl(floristVerificationPhotos.items) ?? undefined
            : undefined;
          const cardSrc = floristVerificationPhotos
            ? imageUrl(floristVerificationPhotos.card) ?? undefined
            : undefined;
          const lightboxImages: LightboxImage[] = [
            ...(itemsSrc ? [{ src: itemsSrc, category: t("orders.floristVerificationItems"), alt: t("orders.floristVerificationItems") }] : []),
            ...(cardSrc ? [{ src: cardSrc, category: t("orders.floristVerificationCard"), alt: t("orders.floristVerificationCard") }] : []),
          ];
          const orderSlug = order.display_order_number ?? order.external_order_id ?? order.id.slice(0, 8);

          return (
            <>
              <Card data-testid="card-florist-verification-photos">
                <CardHeader className="pb-3">
                  <CardTitle className="text-sm font-medium flex items-center gap-2">
                    <BadgeCheck size={15} className="text-emerald-600" />
                    {t("orders.floristVerificationPhotos")}
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                    {itemsSrc && (
                      <figure className="min-w-0 space-y-2">
                        <figcaption className="text-xs font-medium text-muted-foreground">
                          {t("orders.floristVerificationItems")}
                        </figcaption>
                        <div className="relative group">
                          <button
                            ref={lightboxItemsTriggerRef}
                            type="button"
                            className="block w-full focus:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded-md"
                            aria-label={`View ${t("orders.floristVerificationItems")}`}
                            onClick={() => {
                              setLightboxIndex(lightboxImages.findIndex((img) => img.src === itemsSrc));
                              setLightboxOpen(true);
                            }}
                          >
                            <img
                              src={itemsSrc}
                              alt={t("orders.floristVerificationItems")}
                              className="aspect-[4/3] w-full rounded-md border object-cover"
                              data-testid="image-florist-verification-items"
                            />
                            <span className="absolute inset-0 flex items-center justify-center rounded-md bg-black/0 group-hover:bg-black/20 group-focus-visible:bg-black/20 transition-colors">
                              <ZoomIn size={28} className="text-white opacity-0 group-hover:opacity-100 group-focus-visible:opacity-100 drop-shadow transition-opacity" />
                            </span>
                          </button>
                          <button
                            type="button"
                            className="absolute bottom-2 right-2 rounded-md bg-white/80 p-1 opacity-0 group-hover:opacity-100 focus:opacity-100 hover:bg-white transition-all shadow"
                            aria-label={`Download ${t("orders.floristVerificationItems")}`}
                            onClick={(e) => {
                              e.stopPropagation();
                              void downloadFloristImage(itemsSrc, `${orderSlug.replace(/[^a-z0-9_\-]/gi, "-").toLowerCase()}-prepared-order-1.jpg`);
                            }}
                          >
                            <Download size={14} />
                          </button>
                        </div>
                      </figure>
                    )}
                    {cardSrc && (
                      <figure className="min-w-0 space-y-2">
                        <figcaption className="text-xs font-medium text-muted-foreground">
                          {t("orders.floristVerificationCard")}
                        </figcaption>
                        <div className="relative group">
                          <button
                            ref={lightboxCardTriggerRef}
                            type="button"
                            className="block w-full focus:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded-md"
                            aria-label={`View ${t("orders.floristVerificationCard")}`}
                            onClick={() => {
                              setLightboxIndex(lightboxImages.findIndex((img) => img.src === cardSrc));
                              setLightboxOpen(true);
                            }}
                          >
                            <img
                              src={cardSrc}
                              alt={t("orders.floristVerificationCard")}
                              className="aspect-[4/3] w-full rounded-md border object-cover"
                              data-testid="image-florist-verification-card"
                            />
                            <span className="absolute inset-0 flex items-center justify-center rounded-md bg-black/0 group-hover:bg-black/20 group-focus-visible:bg-black/20 transition-colors">
                              <ZoomIn size={28} className="text-white opacity-0 group-hover:opacity-100 group-focus-visible:opacity-100 drop-shadow transition-opacity" />
                            </span>
                          </button>
                          <button
                            type="button"
                            className="absolute bottom-2 right-2 rounded-md bg-white/80 p-1 opacity-0 group-hover:opacity-100 focus:opacity-100 hover:bg-white transition-all shadow"
                            aria-label={`Download ${t("orders.floristVerificationCard")}`}
                            onClick={(e) => {
                              e.stopPropagation();
                              void downloadFloristImage(cardSrc, `${orderSlug.replace(/[^a-z0-9_\-]/gi, "-").toLowerCase()}-card-message-1.jpg`);
                            }}
                          >
                            <Download size={14} />
                          </button>
                        </div>
                      </figure>
                    )}
                  </div>
                  <div className="mt-4">
                    <FloristPhotoPublicationControl
                      orderId={resolvedOrderId}
                      assignment={floristAssignment}
                    />
                  </div>
                </CardContent>
              </Card>

              {lightboxOpen && lightboxImages.length > 0 && (
                <FloristPhotoLightbox
                  images={lightboxImages}
                  initialIndex={lightboxIndex}
                  orderLabel={orderLabel}
                  orderSlug={orderSlug}
                  onClose={() => setLightboxOpen(false)}
                  triggerRef={
                    lightboxIndex === 0
                      ? lightboxItemsTriggerRef
                      : lightboxCardTriggerRef
                  }
                />
              )}
            </>
          );
        })()}

        <ActivityCard orderId={order.id} />

        <InternalNotesCard
          orderId={order.id}
          legacyNote={order.internal_note}
          canEdit={canEditOrders}
        />
      </div>

      <AssignDriverDialog
        orderId={order.id}
        assignment={assignment}
        open={assignDriverOpen}
        onOpenChange={setAssignDriverOpen}
      />

      {/* Driver assignment */}
      {assignment && (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-sm font-medium flex items-center gap-2">
              <Truck size={15} className="text-muted-foreground" />
              {t("orders.sectionDriver")}
            </CardTitle>
          </CardHeader>
          <CardContent className="text-sm space-y-1">
            <p className="font-medium">
              {[assignment.driver_first_name, assignment.driver_last_name].filter(Boolean).join(" ") || "—"}
            </p>
            {assignment.driver_phone && (
              <p className="text-muted-foreground">{assignment.driver_phone}</p>
            )}
            <div className="flex items-center gap-2 pt-0.5">
              <span className="text-muted-foreground">{t("orders.assignmentStatus")}:</span>
              <Badge variant="secondary" className="text-xs capitalize">
                {assignment.assignment_status.replace(/_/g, " ")}
              </Badge>
            </div>
            {assignment.scheduled_at && (
              <p className="text-muted-foreground">
                {t("orders.scheduledAt")}: <span className="text-foreground">{formatDateTime(assignment.scheduled_at)}</span>
              </p>
            )}
            {assignment.delivered_at && (
              <p className="text-muted-foreground">
                {t("orders.deliveredAt")}: <span className="text-foreground">{formatDateTime(assignment.delivered_at)}</span>
              </p>
            )}
          </CardContent>
        </Card>
      )}

      {/* Toters data */}
      {order.source === "toters" && (order.external_order_id || order.metadata) && (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-sm font-medium flex items-center gap-2">
              <MapPin size={15} className="text-orange-500" />
              <Badge className="bg-orange-100 text-orange-800 border-orange-300 hover:bg-orange-100 border font-medium text-xs">
                Toters
              </Badge>
              {t("orders.totersSection")}
            </CardTitle>
          </CardHeader>
          <CardContent className="text-sm space-y-3">
            {order.external_order_id && (
              <div className="flex items-center gap-2">
                <span className="font-medium text-muted-foreground">{t("orders.totersOrderNumber")}</span>
                <span className="font-mono bg-secondary/60 rounded px-1.5 py-0.5 text-xs">{order.external_order_id}</span>
              </div>
            )}
            {order.metadata && Object.keys(order.metadata).length > 0 && (
              <TotersMetadataCard metadata={order.metadata} t={t} />
            )}
          </CardContent>
        </Card>
      )}

      {/* Notes */}
      {(order.customer_note || order.florist_note || order.driver_note) && (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-sm font-medium flex items-center gap-2">
              <FileText size={15} className="text-muted-foreground" />
              {t("orders.sectionNotes")}
            </CardTitle>
          </CardHeader>
          <CardContent className="text-sm space-y-2">
            {order.customer_note && (
              <div>
                <span className="font-medium text-muted-foreground">{t("orders.noteCustomer")}: </span>
                {order.customer_note}
              </div>
            )}
            {order.florist_note && (
              <div>
                <span className="font-medium text-muted-foreground">{t("orders.noteFlorist")}: </span>
                {order.florist_note}
              </div>
            )}
            {order.driver_note && (
              <div>
                <span className="font-medium text-muted-foreground">{t("orders.noteDriver")}: </span>
                {order.driver_note}
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {/* Order Note */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm font-medium flex items-center gap-2">
            <FileText size={15} className="text-muted-foreground" />
            {t("orders.sectionOrderNote")}
          </CardTitle>
        </CardHeader>
        <CardContent className="text-sm space-y-2">
          {order.delivery_instructions ? (
            <p className="whitespace-pre-wrap break-words">{order.delivery_instructions}</p>
          ) : (
            <p className="text-muted-foreground italic">{t("orders.noOrderNote")}</p>
          )}
        </CardContent>
      </Card>

      {/* Print History */}
      {printHistory.length > 0 && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium flex items-center gap-2">
              <History size={15} className="text-muted-foreground" />
              {t("orders.cardPrintHistory")}
            </CardTitle>
          </CardHeader>
          <CardContent className="text-sm space-y-2">
            {printHistory.map((log) => (
              <div key={log.id} className="flex flex-col gap-0.5">
                <span className="font-medium">{log.user_display_name}</span>
                <span className="text-muted-foreground text-xs">
                  {t("orders.cardPrintBranch")}: {log.location} · {log.shop_name} · {formatDateTime(log.printed_at)}
                </span>
              </div>
            ))}
          </CardContent>
        </Card>
      )}

      {/* Tookan delivery integration — collapsed at the bottom */}
      {canEditOrders && (
        <Collapsible open={tookanOpen} onOpenChange={setTookanOpen}>
          <Card data-testid="card-tookan">
            <CollapsibleTrigger asChild>
              <button type="button" className="w-full text-left" data-testid="button-tookan-toggle">
                <CardHeader className="py-3">
                  <div className="flex items-center justify-between gap-2">
                    <CardTitle className="text-sm font-medium flex items-center gap-2">
                      <Truck size={15} className="text-blue-500" />
                      {t("orders.tookanSection")}
                      {(() => {
                        const badge = getTookanStatusBadge(order.tookan_status, order.tookan_job_id);
                        return <Badge className={badge.className}>{t(badge.labelKey)}</Badge>;
                      })()}
                    </CardTitle>
                    <ChevronDown
                      size={16}
                      className={cn(
                        "shrink-0 text-muted-foreground transition-transform",
                        tookanOpen && "rotate-180",
                      )}
                    />
                  </div>
                </CardHeader>
              </button>
            </CollapsibleTrigger>
            <CollapsibleContent>
              <CardContent className="text-sm space-y-1 pt-0">
                {!order.tookan_job_id && (
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={retryTookanMut.isPending}
                    onClick={() => {
                      if (!resolvedOrderId) return;
                      retryTookanMut.mutate(
                        { id: resolvedOrderId },
                        {
                          onSuccess: () => {
                            void queryClient.invalidateQueries({ queryKey: ["order", orderId] });
                            toast({ title: t("orders.tookanRetrySuccess") });
                          },
                          onError: (err: unknown) => {
                            const msg = err instanceof Error ? err.message : String(err);
                            toast({
                              title: t("orders.tookanRetryFailed"),
                              description: msg,
                              variant: "destructive",
                            });
                          },
                        },
                      );
                    }}
                  >
                    {retryTookanMut.isPending ? (
                      <><Loader2 size={14} className="mr-1 animate-spin" />{t("orders.tookanRetrying")}</>
                    ) : (
                      <><RotateCcw size={14} className="mr-1" />{t("orders.tookanRetry")}</>
                    )}
                  </Button>
                )}
                {order.tookan_job_id && (
                  <p className="text-muted-foreground">
                    {t("orders.tookanJobId")}:{" "}
                    <span className="font-mono text-foreground bg-secondary/60 rounded px-1.5 py-0.5 text-xs">
                      {order.tookan_job_id}
                    </span>
                  </p>
                )}
                {order.tookan_status === "failed" && order.tookan_error && (
                  order.tookan_error.startsWith("Delivery address missing") ? (
                    // Missing-address skip: actionable hint instead of a raw
                    // Tookan error — add an address, then Retry (or it auto-syncs
                    // on address save).
                    <p className="text-amber-600 text-xs break-words">
                      {t("orders.tookanMissingAddressHint")}
                    </p>
                  ) : (
                    <p className="text-muted-foreground text-xs">
                      <span className="font-medium">{t("orders.tookanLastError")}: </span>
                      <span className="text-red-600 break-words">{order.tookan_error}</span>
                    </p>
                  )
                )}
              </CardContent>
            </CollapsibleContent>
          </Card>
        </Collapsible>
      )}

      {/* Respond.io conversation — collapsed at the bottom */}
      {canEditOrders && customer?.phone && (
        <RespondioConversationCard orderId={order.id} />
      )}

      {/* Trustpilot review invitation — collapsed at the bottom */}
      {isOwner && trustpilotData?.enabled && (
        <Collapsible open={trustpilotOpen} onOpenChange={setTrustpilotOpen}>
          <Card data-testid="card-trustpilot">
            <CollapsibleTrigger asChild>
              <button type="button" className="w-full text-left" data-testid="button-trustpilot-toggle">
                <CardHeader className="py-3">
                  <div className="flex items-center justify-between gap-2">
                    <CardTitle className="text-sm font-medium flex items-center gap-2">
                      <Star size={15} className="text-emerald-600" />
                      {t("orders.trustpilotSection")}
                      {trustpilotData.testMode && (
                        <Badge variant="outline" className="text-amber-600 border-amber-300">
                          {t("orders.trustpilotTestMode")}
                        </Badge>
                      )}
                      {order.is_sensitive_occasion ? (
                        <Badge
                          className="bg-slate-100 text-slate-700 border-slate-200"
                          data-testid="badge-trustpilot-suppressed"
                        >
                          {t("orders.trustpilotStatus.suppressed")}
                        </Badge>
                      ) : (
                        (() => {
                          const s = trustpilotData.invitation?.status ?? "none";
                          const cls =
                            s === "created"
                              ? "bg-emerald-100 text-emerald-800"
                              : s === "failed"
                                ? "bg-red-100 text-red-800"
                                : s === "skipped"
                                  ? "bg-gray-100 text-gray-700"
                                  : s === "none"
                                    ? "bg-gray-100 text-gray-700"
                                    : "bg-amber-100 text-amber-800";
                          return <Badge className={cls}>{t(`orders.trustpilotStatus.${s}`)}</Badge>;
                        })()
                      )}
                    </CardTitle>
                    <ChevronDown
                      size={16}
                      className={cn(
                        "shrink-0 text-muted-foreground transition-transform",
                        trustpilotOpen && "rotate-180",
                      )}
                    />
                  </div>
                </CardHeader>
              </button>
            </CollapsibleTrigger>
            <CollapsibleContent>
              <CardContent className="text-sm space-y-1 pt-0">
                {order.is_sensitive_occasion && (
                  <p className="text-muted-foreground text-xs" data-testid="text-trustpilot-suppressed-hint">
                    {t("orders.trustpilotSuppressedHint")}
                  </p>
                )}
                {!order.is_sensitive_occasion &&
                  trustpilotData.invitation?.status === "failed" && (
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={retryTrustpilotMut.isPending}
                      onClick={() => {
                        if (!resolvedOrderId) return;
                        retryTrustpilotMut.mutate(undefined, {
                          onSuccess: () => {
                            void queryClient.invalidateQueries({
                              queryKey: ["trustpilot-invitation", orderId],
                            });
                            toast({ title: t("orders.trustpilotRetrySuccess") });
                          },
                          onError: (err: unknown) => {
                            const msg = err instanceof Error ? err.message : String(err);
                            toast({
                              title: t("orders.trustpilotRetryFailed"),
                              description: msg,
                              variant: "destructive",
                            });
                          },
                        });
                      }}
                    >
                      {retryTrustpilotMut.isPending ? (
                        <><Loader2 size={14} className="mr-1 animate-spin" />{t("orders.trustpilotRetrying")}</>
                      ) : (
                        <><RotateCcw size={14} className="mr-1" />{t("orders.trustpilotRetry")}</>
                      )}
                    </Button>
                  )}
                <div className="flex items-center gap-2">
                  <span className="text-muted-foreground">{t("orders.trustpilotStatusLabel")}:</span>
                  {(() => {
                    const s = trustpilotData.invitation?.status ?? "none";
                    const cls =
                      s === "created"
                        ? "bg-emerald-100 text-emerald-800"
                        : s === "failed"
                          ? "bg-red-100 text-red-800"
                          : s === "skipped"
                            ? "bg-gray-100 text-gray-700"
                            : s === "none"
                              ? "bg-gray-100 text-gray-700"
                              : "bg-amber-100 text-amber-800";
                    return <Badge className={cls}>{t(`orders.trustpilotStatus.${s}`)}</Badge>;
                  })()}
                </div>
                {trustpilotData.invitation?.recipient_email && (
                  <p className="text-muted-foreground">
                    {t("orders.trustpilotRecipient")}:{" "}
                    <span className="text-foreground">{trustpilotData.invitation.recipient_email}</span>
                  </p>
                )}
                {trustpilotData.invitation?.preferred_send_time &&
                  trustpilotData.invitation.status !== "failed" &&
                  trustpilotData.invitation.status !== "skipped" && (
                    <p className="text-muted-foreground">
                      {t("orders.trustpilotSendTime")}:{" "}
                      <span className="text-foreground">
                        {new Date(trustpilotData.invitation.preferred_send_time).toLocaleString()}
                      </span>
                    </p>
                  )}
                {(trustpilotData.invitation?.attempt_count ?? 0) > 0 && (
                  <p className="text-muted-foreground text-xs">
                    {t("orders.trustpilotAttempts")}: {trustpilotData.invitation?.attempt_count}
                    {trustpilotData.invitation?.last_attempt_at && (
                      <>
                        {" · "}
                        {t("orders.trustpilotLastAttempt")}:{" "}
                        {new Date(trustpilotData.invitation.last_attempt_at).toLocaleString()}
                      </>
                    )}
                  </p>
                )}
                {trustpilotData.invitation?.last_error && (
                  <p className="text-muted-foreground text-xs">
                    <span className="font-medium">{t("orders.trustpilotLastError")}: </span>
                    <span className="text-red-600 break-words">
                      {trustpilotData.invitation.last_error}
                    </span>
                  </p>
                )}
                {!trustpilotData.invitation && !order.is_sensitive_occasion && (
                  <p className="text-muted-foreground text-xs">{t("orders.trustpilotNoneHint")}</p>
                )}
              </CardContent>
            </CollapsibleContent>
          </Card>
        </Collapsible>
      )}

      {/* Customer Communications — very bottom of the page */}
      <OrderCommunicationsCard
        orderId={order.id}
        canEdit={canEditOrders}
        orderStatus={order.status}
        canSendWhatsappPaymentInstructions={canResendWhishInstructions}
        trustpilotEnabled={isOwner ? (trustpilotData?.enabled ?? false) : undefined}
        trustpilotInvitation={isOwner ? (trustpilotData?.invitation ?? null) : undefined}
      />

      {/* Print Card dialog */}
      <Dialog
        open={invoiceNameDialogOpen}
        onOpenChange={(open) => {
          if (!generatingInvoice) setInvoiceNameDialogOpen(open);
        }}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{t("orders.invoiceNameDialog.title")}</DialogTitle>
            <DialogDescription>{t("orders.invoiceNameDialog.description")}</DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <RadioGroup
              value={invoiceNameType}
              onValueChange={(value) => {
                const type = value as "individual" | "company";
                setInvoiceNameType(type);
                setInvoiceName(type === "individual" && customer ? contactName(customer) : "");
              }}
              className="grid grid-cols-2 gap-3"
            >
              <Label
                htmlFor="invoice-name-individual"
                className="flex cursor-pointer items-center gap-2 rounded-md border p-3"
              >
                <RadioGroupItem value="individual" id="invoice-name-individual" />
                {t("orders.invoiceNameDialog.individual")}
              </Label>
              <Label
                htmlFor="invoice-name-company"
                className="flex cursor-pointer items-center gap-2 rounded-md border p-3"
              >
                <RadioGroupItem value="company" id="invoice-name-company" />
                {t("orders.invoiceNameDialog.company")}
              </Label>
            </RadioGroup>
            <div className="space-y-2">
              <Label htmlFor="invoice-bill-to-name">
                {invoiceNameType === "company"
                  ? t("orders.invoiceNameDialog.companyName")
                  : t("orders.invoiceNameDialog.individualName")}
              </Label>
              <Input
                id="invoice-bill-to-name"
                value={invoiceName}
                onChange={(event) => setInvoiceName(event.target.value)}
                maxLength={200}
                autoFocus
              />
            </div>
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setInvoiceNameDialogOpen(false)}
              disabled={generatingInvoice}
            >
              {t("orders.invoiceNameDialog.cancel")}
            </Button>
            <Button
              onClick={() => void downloadInvoice()}
              disabled={generatingInvoice || invoiceName.trim().length === 0}
              data-testid="button-download-invoice"
            >
              {generatingInvoice && <Loader2 size={14} className="mr-1.5 animate-spin" />}
              {t("orders.invoiceNameDialog.generate")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={cakePrintOpen} onOpenChange={(open) => { if (!cakePrintPending) setCakePrintOpen(open); }}>
        <DialogContent data-testid="dialog-print-cake">
          <DialogHeader>
            <DialogTitle>{t("cardMessage.printCake")}</DialogTitle>
            <DialogDescription>{t("cardMessage.cakeSelectLocation")}</DialogDescription>
          </DialogHeader>
          <Label>{t("cardMessage.location")}</Label>
          <Select value={cakeLocation} onValueChange={setCakeLocation}>
            <SelectTrigger data-testid="select-print-cake-location"><SelectValue placeholder={t("cardMessage.locationPlaceholder")} /></SelectTrigger>
            <SelectContent>
              <SelectItem value="Achrafieh">Achrafieh</SelectItem>
              <SelectItem value="Jdeideh">Jdeideh</SelectItem>
            </SelectContent>
          </Select>
          {cakePrintError && <p role="alert" className="text-sm text-destructive">{cakePrintError}</p>}
          <DialogFooter>
            <Button disabled={!cakeLocation || cakePrintPending} data-testid="button-print-cake-submit" onClick={printCakeMessage}>
              {cakePrintPending ? t("cardMessage.printing") : t("cardMessage.printCake")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <Dialog open={printCardOpen} onOpenChange={(open) => { if (!printCardPending) setPrintCardOpen(open); }}>
        <DialogContent className="max-w-md" data-testid="dialog-print-card">
          <DialogHeader>
            <DialogTitle>{t("orders.printCardDialog.title")}</DialogTitle>
            <DialogDescription>{t("orders.printCardDialog.description")}</DialogDescription>
          </DialogHeader>

          <div className="space-y-4">
            {/* Branch selector */}
            <div className="space-y-1.5">
              <Label>{t("orders.printCardDialog.branch")}</Label>
              <Select value={printCardBranch} onValueChange={setPrintCardBranch}>
                <SelectTrigger className="w-full" data-testid="select-print-card-branch">
                  <SelectValue placeholder={t("orders.printCardDialog.branchPlaceholder")} />
                </SelectTrigger>
                <SelectContent>
                  {branchConfigs.length === 0 ? (
                    <SelectItem value="__none" disabled>
                      {t("orders.printCardDialog.noBranches")}
                    </SelectItem>
                  ) : (
                    branchConfigs.map((b) => (
                      <SelectItem key={b.id} value={b.name}>{b.name}</SelectItem>
                    ))
                  )}
                </SelectContent>
              </Select>
            </div>

            {/* Inline error */}
            {printCardError && (
              <p className="text-sm font-medium text-destructive">{printCardError}</p>
            )}
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setPrintCardOpen(false)} disabled={printCardPending}>
              {t("common.cancel")}
            </Button>
            <Button
              onClick={handlePrintCardSubmit}
              disabled={!printCardCanPrint || printCardPending}
              data-testid="button-print-card-submit"
            >
              {printCardPending && <Loader2 size={14} className="mr-1 animate-spin" />}
              <Printer size={14} className="mr-1" />
              {t("orders.printCardDialog.print")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
    </>
  );
}

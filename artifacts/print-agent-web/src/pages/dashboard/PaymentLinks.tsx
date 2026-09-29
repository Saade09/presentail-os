import { useState, useEffect, useRef, useMemo } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiFetch } from "@/lib/queryClient";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
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
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import {
  CreditCard,
  Plus,
  Copy,
  Check,
  ExternalLink,
  Loader2,
  ArrowRightLeft,
  MoreHorizontal,
  MessageCircle,
  Ban,
  Trash2,
  CopyPlus,
  AlertCircle,
  RotateCcw,
  SlidersHorizontal,
  X,
  ChevronDown,
  Link2,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import {
  SUPPORTED_CURRENCIES,
  SUPPORTED_PROVIDERS,
  STRIPE_UNSUPPORTED_CURRENCIES,
  PAYPAL_UNSUPPORTED_CURRENCIES,
  MAMO_UNSUPPORTED_CURRENCIES,
} from "@workspace/payment-constants";
import { isExcludedCountry } from "@/lib/countries";
import { FlagImage } from "@/components/FlagImage";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type PaymentLink = {
  id: number;
  amount: number;
  currency: string;
  provider: string;
  description: string | null;
  country: string | null;
  status: "active" | "paid" | "expired";
  public_url: string;
  provider_checkout_url: string | null;
  created_at: string;
  paid_at: string | null;
  creator_first_name: string | null;
  creator_image_url: string | null;
  original_amount?: number | null;
  original_currency?: string | null;
  official_exchange_rate?: number | null;
  markup_percentage_used?: number | null;
  rounding_rule_used?: string | null;
  sender_first_name?: string | null;
  sender_last_name?: string | null;
  sender_phone_country_code?: string | null;
  sender_phone?: string | null;
  sender_email?: string | null;
  sender_submitted_at?: string | null;
  order_id?: string | null;
  order_number?: string | null;
  order_customer_name?: string | null;
};

type CreateFormState = {
  amount: string;
  currency: string;
  country: string;
  provider: string;
  description: string;
};

type ConversionResult = {
  from_currency: string;
  to_currency: string;
  source_amount: number;
  official_rate: number;
  markup_percentage: number;
  effective_rate: number;
  converted_amount_exact: number;
  final_amount: number;
  rounding_rule: string;
  rate_fetched_at: string;
};

type PaymentMethodStatus = {
  stripe: boolean;
  paypal: boolean;
  mamo: boolean;
  mamo_enabled: boolean;
};

type PaymentStatus = "unpaid" | "paid" | "partially_paid" | "refunded";
type LinkStatus = "active" | "expired" | "disabled";
type SortOrder = "newest" | "oldest" | "amount_high" | "amount_low";
type TabFilter = "all" | "unpaid" | "paid" | "expired";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const COPY_FEEDBACK_MS = 2000;
const MAX_PAYMENT_AMOUNT = 999_999.99;

function formatAmount(cents: number, currency: string): string {
  const amount = cents / 100;
  try {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency,
      minimumFractionDigits: 2,
    }).format(amount);
  } catch {
    return `${amount.toFixed(2)} ${currency}`;
  }
}

function formatDate(iso: string): string {
  try {
    return new Date(iso).toLocaleDateString("en-GB", {
      day: "numeric",
      month: "short",
      year: "numeric",
    });
  } catch {
    return iso.slice(0, 10);
  }
}

function roundingRuleLabel(rule: string): string {
  switch (rule) {
    case "round_up_whole": return "Rounded up";
    case "round_nearest_whole": return "Rounded to nearest";
    case "none": return "No rounding";
    default: return rule;
  }
}

function getPaymentStatus(link: PaymentLink): PaymentStatus {
  if (link.status === "paid") return "paid";
  return "unpaid";
}

function getLinkStatus(link: PaymentLink): LinkStatus {
  if (link.status === "expired") return "expired";
  if (link.status === "active") return "active";
  return "disabled";
}

type OrderMatch = {
  id: string;
  display_order_number: string | null;
  customer_name: string | null;
  customer_phone: string | null;
  totals: { total?: number | string | null; subtotal?: number | string | null; currency?: string } | null;
};

function LinkOrderDialog({
  link,
  open,
  onOpenChange,
}: {
  link: PaymentLink | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [search, setSearch] = useState("");
  const [debounced, setDebounced] = useState("");
  const [selected, setSelected] = useState<OrderMatch | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [serverMismatch, setServerMismatch] = useState(false);
  const [serverReassignment, setServerReassignment] = useState(false);

  useEffect(() => {
    const timeout = window.setTimeout(() => setDebounced(search.trim()), 250);
    return () => window.clearTimeout(timeout);
  }, [search]);
  useEffect(() => {
    if (!open) {
      setSearch("");
      setDebounced("");
      setSelected(null);
      setConfirmed(false);
      setServerMismatch(false);
      setServerReassignment(false);
    }
  }, [open]);

  const matches = useQuery({
    queryKey: ["payment-link-order-search", debounced],
    enabled: open && debounced.length >= 2,
    queryFn: () => apiFetch<{ orders: OrderMatch[] }>(
      `/api/payment-links/orders/search?q=${encodeURIComponent(debounced)}`,
    ),
  });
  const effectiveOrderAmount = selected?.totals?.total ?? selected?.totals?.subtotal;
  const isMismatch = selected != null && link != null && (
    String(selected.totals?.currency ?? "USD").toUpperCase() !== link.currency.toUpperCase() ||
    (effectiveOrderAmount != null &&
      Math.abs(Number(effectiveOrderAmount) - link.amount / 100) > 0.005)
  );
  const isReassignment = Boolean(link?.order_id) || serverReassignment;
  const effectiveMismatch = isMismatch || serverMismatch;
  const needsConfirmation = isReassignment || effectiveMismatch;
  const save = useMutation({
    mutationFn: () => apiFetch(`/api/payment-links/${link?.id}/order`, {
      method: "POST",
      body: JSON.stringify({
        order_id: selected?.id,
        confirm_reassignment: Boolean(isReassignment && confirmed),
        confirm_mismatch: Boolean(effectiveMismatch && confirmed),
      }),
    }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["payment-links"] });
      void queryClient.invalidateQueries({ queryKey: ["orders"] });
      if (selected) void queryClient.invalidateQueries({ queryKey: ["order", selected.id] });
      toast({ title: link?.order_id ? "Payment link moved" : "Payment link linked to order" });
      onOpenChange(false);
    },
    onError: (error: Error & { status?: number; body?: Record<string, unknown> }) => {
      if (error.status === 409 && error.body) {
        const rc = error.body.requires_confirmation;
        if (rc === "mismatch") {
          setConfirmed(false);
          setServerMismatch(true);
          return;
        }
        if (rc === "reassignment") {
          setConfirmed(false);
          setServerReassignment(true);
          return;
        }
      }
      toast({ title: error.message || "Could not link payment", variant: "destructive" });
    },
  });

  const context = link ? `${formatAmount(link.amount, link.currency)} · ${link.provider}` : "";
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{link?.order_id ? "Change linked order" : "Link payment to order"}</DialogTitle>
          <DialogDescription>
            {context}. Search by order number, customer, or phone, then explicitly choose an order.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <Label htmlFor="payment-link-order-search">Find an order</Label>
          <Input
            id="payment-link-order-search"
            autoFocus
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Order number, customer, or phone"
          />
          {debounced.length > 0 && debounced.length < 2 && (
            <p className="text-sm text-muted-foreground">Enter at least 2 characters.</p>
          )}
          {matches.isLoading && (
            <p className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" /> Searching orders…</p>
          )}
          {matches.isError && (
            <div className="flex items-center justify-between gap-3 rounded-md border p-3 text-sm">
              <span>Order search failed.</span>
              <Button type="button" size="sm" variant="outline" onClick={() => void matches.refetch()}>Retry</Button>
            </div>
          )}
          {!matches.isLoading && debounced.length >= 2 && !matches.isError &&
            (matches.data?.orders.length ?? 0) === 0 && (
              <p className="rounded-md border border-dashed p-3 text-sm text-muted-foreground">No accessible orders match this search.</p>
            )}
          <div className="max-h-56 space-y-1 overflow-y-auto">
            {matches.data?.orders.map((order) => (
              <button
                key={order.id}
                type="button"
                onClick={() => { setSelected(order); setConfirmed(false); setServerMismatch(false); setServerReassignment(false); }}
                className={`w-full rounded-md border p-3 text-left text-sm transition-colors ${
                  selected?.id === order.id ? "border-teal-700 bg-teal-50" : "hover:bg-muted/60"
                }`}
              >
                <span className="font-semibold text-teal-900">{order.display_order_number ?? "Order"}</span>
                <span className="ml-2 text-muted-foreground">{order.customer_name || order.customer_phone || "No customer"}</span>
                {order.totals?.total != null && (
                  <span className="ml-2 text-muted-foreground">
                    {Number(order.totals.total).toFixed(2)} {order.totals.currency ?? "USD"}
                  </span>
                )}
              </button>
            ))}
          </div>
          {selected && needsConfirmation && (
            <label className="flex items-start gap-2 rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-950">
              <input type="checkbox" checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} className="mt-1" />
              <span>
                {isReassignment && effectiveMismatch
                  ? "I understand this moves the payment link from its current order, and the amount or currency differs. The commercial order total will not change."
                  : isReassignment
                  ? "I understand this moves the payment link from its current order."
                  : "I understand the payment amount or currency differs from this order. The commercial order total will not change."}
              </span>
            </label>
          )}
        </div>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button
            type="button"
            disabled={!selected || save.isPending || (needsConfirmation && !confirmed)}
            onClick={() => save.mutate()}
          >
            {save.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            {link?.order_id ? "Move payment link" : "Link order"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function isActiveMonth(iso: string | null): boolean {
  if (!iso) return false;
  const d = new Date(iso);
  const now = new Date();
  return d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth();
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function PaymentStatusBadge({ status }: { status: PaymentStatus }) {
  const { t } = useTranslation();
  if (status === "paid") {
    return (
      <Badge className="bg-green-100 text-green-800 hover:bg-green-100 border-green-200 whitespace-nowrap">
        {t("paymentLinks.paymentStatusPaid")}
      </Badge>
    );
  }
  if (status === "partially_paid") {
    return (
      <Badge className="bg-blue-100 text-blue-800 hover:bg-blue-100 border-blue-200 whitespace-nowrap">
        {t("paymentLinks.paymentStatusPartiallyPaid")}
      </Badge>
    );
  }
  if (status === "refunded") {
    return (
      <Badge variant="secondary" className="whitespace-nowrap">
        {t("paymentLinks.paymentStatusRefunded")}
      </Badge>
    );
  }
  return (
    <Badge className="bg-amber-100 text-amber-800 hover:bg-amber-100 border-amber-200 whitespace-nowrap">
      {t("paymentLinks.paymentStatusUnpaid")}
    </Badge>
  );
}

function LinkStatusBadge({ status }: { status: LinkStatus }) {
  const { t } = useTranslation();
  if (status === "active") {
    return (
      <Badge className="bg-teal-100 text-teal-800 hover:bg-teal-100 border-teal-200 whitespace-nowrap">
        {t("paymentLinks.linkStatusActive")}
      </Badge>
    );
  }
  return (
    <Badge variant="secondary" className="whitespace-nowrap">
      {status === "expired" ? t("paymentLinks.linkStatusExpired") : t("paymentLinks.linkStatusDisabled")}
    </Badge>
  );
}

function ProviderBadge({ provider }: { provider: string }) {
  if (provider === "stripe") {
    return (
      <span className="inline-flex items-center gap-1 text-xs font-medium text-purple-700 bg-purple-50 border border-purple-200 rounded px-1.5 py-0.5">
        Stripe
      </span>
    );
  }
  if (provider === "mamo") {
    return (
      <span className="inline-flex items-center gap-1 text-xs font-medium text-emerald-700 bg-emerald-50 border border-emerald-200 rounded px-1.5 py-0.5">
        Mamo
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 text-xs font-medium text-blue-700 bg-blue-50 border border-blue-200 rounded px-1.5 py-0.5">
      PayPal
    </span>
  );
}

function CopyButton({ text, linkId }: { text: string; linkId?: number }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), COPY_FEEDBACK_MS);
    } catch {
      /* ignore */
    }
  };

  return (
    <Button
      variant="outline"
      size="sm"
      className="h-7 px-2 gap-1 text-xs"
      onClick={handleCopy}
      title={text}
      data-linkid={linkId}
    >
      {copied ? (
        <>
          <Check size={12} className="text-green-600" />
          <span className="text-green-600">Copied</span>
        </>
      ) : (
        <>
          <Copy size={12} />
          Copy link
        </>
      )}
    </Button>
  );
}

function PaymentLinkSummary({
  links,
  isLoading,
}: {
  links: PaymentLink[];
  isLoading: boolean;
}) {
  const { t } = useTranslation();

  const outstanding = useMemo(() => {
    return links
      .filter((l) => l.status === "active")
      .reduce((sum, l) => sum + l.amount / 100, 0);
  }, [links]);

  const paidThisMonth = useMemo(() => {
    return links
      .filter((l) => l.status === "paid" && isActiveMonth(l.paid_at))
      .reduce((sum, l) => sum + l.amount / 100, 0);
  }, [links]);

  const activeCount = useMemo(() => links.filter((l) => l.status === "active").length, [links]);

  const conversionRate = useMemo(() => {
    const eligible = links.filter((l) => l.status !== "expired");
    if (eligible.length === 0) return 0;
    const paid = eligible.filter((l) => l.status === "paid").length;
    return Math.round((paid / eligible.length) * 100);
  }, [links]);

  const cards = [
    {
      label: t("paymentLinks.summaryOutstanding"),
      value: isLoading ? null : `$${outstanding.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`,
    },
    {
      label: t("paymentLinks.summaryPaidMonth"),
      value: isLoading ? null : `$${paidThisMonth.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`,
    },
    {
      label: t("paymentLinks.summaryActiveLinks"),
      value: isLoading ? null : String(activeCount),
    },
    {
      label: t("paymentLinks.summaryConversion"),
      value: isLoading ? null : `${conversionRate}%`,
    },
  ];

  return (
    <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
      {cards.map((card) => (
        <div key={card.label} className="rounded-lg border border-border bg-card p-4 space-y-1">
          <p className="text-xs text-muted-foreground font-medium">{card.label}</p>
          {isLoading || card.value === null ? (
            <Skeleton className="h-6 w-20" />
          ) : (
            <p className="text-xl font-semibold text-foreground">{card.value}</p>
          )}
        </div>
      ))}
    </div>
  );
}

function TableSkeleton() {
  return (
    <div className="border border-border rounded-lg overflow-hidden">
      <div className="bg-secondary/50 border-b border-border px-4 py-3 flex gap-4">
        {[120, 80, 70, 70, 90, 80].map((w, i) => (
          <Skeleton key={i} className={`h-4`} style={{ width: w }} />
        ))}
      </div>
      {Array.from({ length: 6 }).map((_, i) => (
        <div key={i} className="px-4 py-3 border-b border-border last:border-0 flex gap-4 items-center">
          <div className="space-y-1.5 flex-1 min-w-0">
            <Skeleton className="h-4 w-32" />
            <Skeleton className="h-3 w-24" />
          </div>
          <Skeleton className="h-4 w-16 shrink-0" />
          <Skeleton className="h-5 w-14 rounded-full shrink-0 hidden md:block" />
          <Skeleton className="h-5 w-14 rounded-full shrink-0 hidden md:block" />
          <Skeleton className="h-4 w-20 shrink-0 hidden lg:block" />
          <Skeleton className="h-7 w-20 shrink-0" />
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main page
// ---------------------------------------------------------------------------

export default function PaymentLinksPage() {
  const { t } = useTranslation();
  const { toast } = useToast();
  const qc = useQueryClient();

  // Create dialog state
  const [createOpen, setCreateOpen] = useState(false);
  const [successLink, setSuccessLink] = useState<PaymentLink | null>(null);
  const [amountFieldError, setAmountFieldError] = useState<string | null>(null);
  const [form, setForm] = useState<CreateFormState>({
    amount: "",
    currency: "USD",
    country: "",
    provider: "stripe",
    description: "",
  });
  const [convertEnabled, setConvertEnabled] = useState(false);
  const [srcAmount, setSrcAmount] = useState("");
  const [srcCurrency, setSrcCurrency] = useState("USD");
  const [conversionResult, setConversionResult] = useState<ConversionResult | null>(null);
  const [conversionLoading, setConversionLoading] = useState(false);
  const [conversionError, setConversionError] = useState<string | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Toolbar state
  const [searchQuery, setSearchQuery] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const searchDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [activeTab, setActiveTab] = useState<TabFilter>("all");
  const [sortOrder, setSortOrder] = useState<SortOrder>("newest");
  const [filterOpen, setFilterOpen] = useState(false);
  const [filterDateFrom, setFilterDateFrom] = useState("");
  const [filterDateTo, setFilterDateTo] = useState("");
  const [filterDestinations, setFilterDestinations] = useState<string[]>([]);
  const [filterAmountMin, setFilterAmountMin] = useState("");
  const [filterAmountMax, setFilterAmountMax] = useState("");

  // Action state
  const [disableId, setDisableId] = useState<number | null>(null);
  const [deleteId, setDeleteId] = useState<number | null>(null);
  const [duplicateSource, setDuplicateSource] = useState<PaymentLink | null>(null);
  const [orderLinkTarget, setOrderLinkTarget] = useState<PaymentLink | null>(null);

  function handleSearchChange(val: string) {
    setSearchQuery(val);
    if (searchDebounceRef.current) clearTimeout(searchDebounceRef.current);
    searchDebounceRef.current = setTimeout(() => setDebouncedSearch(val), 350);
  }

  const hasActiveFilters =
    activeTab !== "all" ||
    debouncedSearch !== "" ||
    filterDateFrom !== "" ||
    filterDateTo !== "" ||
    filterDestinations.length > 0 ||
    filterAmountMin !== "" ||
    filterAmountMax !== "";

  function clearAllFilters() {
    setActiveTab("all");
    setSearchQuery("");
    setDebouncedSearch("");
    setFilterDateFrom("");
    setFilterDateTo("");
    setFilterDestinations([]);
    setFilterAmountMin("");
    setFilterAmountMax("");
  }

  // ---------------------------------------------------------------------------
  // Queries
  // ---------------------------------------------------------------------------

  const {
    data,
    isLoading,
    isError,
    refetch,
  } = useQuery({
    queryKey: ["payment-links"],
    queryFn: () => apiFetch<{ payment_links: PaymentLink[] }>("/api/payment-links"),
  });

  const { data: providerStatus } = useQuery({
    queryKey: ["payment-methods-status"],
    queryFn: () => apiFetch<PaymentMethodStatus>("/api/payment-methods/status"),
  });

  const { data: settingsData } = useQuery({
    queryKey: ["workspace-settings"],
    queryFn: () =>
      apiFetch<{
        available_countries: string[];
        available_country_details?: Array<{ name: string; code: string | null; flagImageUrl: string | null }>;
      }>("/api/settings"),
  });

  const countryFlagUrls: Record<string, string | null> = (() => {
    const map: Record<string, string | null> = {};
    for (const d of settingsData?.available_country_details ?? []) {
      map[d.name] = d.flagImageUrl;
    }
    return map;
  })();

  const availableCountries = (settingsData?.available_countries ?? []).filter(
    (c) => !isExcludedCountry(c),
  );

  const allLinks = data?.payment_links ?? [];
  const unlinkOrder = useMutation({
    mutationFn: (linkId: number) =>
      apiFetch(`/api/payment-links/${linkId}/order`, { method: "DELETE" }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["payment-links"] });
      void qc.invalidateQueries({ queryKey: ["orders"] });
      toast({ title: "Payment link unlinked from order" });
    },
    onError: (error: Error) =>
      toast({ title: error.message || "Could not unlink payment", variant: "destructive" }),
  });

  // Determine if provider column should be shown (multiple providers in use)
  const showProviderColumn = useMemo(() => {
    const providers = new Set(allLinks.map((l) => l.provider));
    return providers.size > 1;
  }, [allLinks]);

  // ---------------------------------------------------------------------------
  // Client-side filtering & sorting
  // ---------------------------------------------------------------------------

  const filteredLinks = useMemo(() => {
    let result = [...allLinks];

    // Search
    if (debouncedSearch) {
      const q = debouncedSearch.toLowerCase();
      result = result.filter((l) => {
        const name = [l.sender_first_name, l.sender_last_name].filter(Boolean).join(" ").toLowerCase();
        const desc = (l.description ?? "").toLowerCase();
        const country = (l.country ?? "").toLowerCase();
        return name.includes(q) || desc.includes(q) || country.includes(q) || (l.sender_email ?? "").toLowerCase().includes(q);
      });
    }

    // Tab filter
    if (activeTab === "unpaid") {
      result = result.filter((l) => getPaymentStatus(l) === "unpaid" && getLinkStatus(l) === "active");
    } else if (activeTab === "paid") {
      result = result.filter((l) => getPaymentStatus(l) === "paid");
    } else if (activeTab === "expired") {
      result = result.filter((l) => getLinkStatus(l) === "expired");
    }

    // Date range
    if (filterDateFrom) {
      result = result.filter((l) => l.created_at >= filterDateFrom);
    }
    if (filterDateTo) {
      result = result.filter((l) => l.created_at <= filterDateTo + "T23:59:59");
    }

    // Destination
    if (filterDestinations.length > 0) {
      result = result.filter((l) => l.country && filterDestinations.includes(l.country));
    }

    // Amount range
    const minCents = filterAmountMin ? parseFloat(filterAmountMin) * 100 : null;
    const maxCents = filterAmountMax ? parseFloat(filterAmountMax) * 100 : null;
    if (minCents !== null) result = result.filter((l) => l.amount >= minCents);
    if (maxCents !== null) result = result.filter((l) => l.amount <= maxCents);

    // Sort
    switch (sortOrder) {
      case "oldest":
        result.sort((a, b) => a.created_at.localeCompare(b.created_at));
        break;
      case "amount_high":
        result.sort((a, b) => b.amount - a.amount);
        break;
      case "amount_low":
        result.sort((a, b) => a.amount - b.amount);
        break;
      default:
        result.sort((a, b) => b.created_at.localeCompare(a.created_at));
    }

    return result;
  }, [allLinks, debouncedSearch, activeTab, filterDateFrom, filterDateTo, filterDestinations, filterAmountMin, filterAmountMax, sortOrder]);

  // Tab counts (computed against all links, ignoring current tab filter)
  const tabCounts = useMemo(() => {
    const unpaidSearch = debouncedSearch
      ? allLinks.filter((l) => {
          const q = debouncedSearch.toLowerCase();
          const name = [l.sender_first_name, l.sender_last_name].filter(Boolean).join(" ").toLowerCase();
          return name.includes(q) || (l.description ?? "").toLowerCase().includes(q);
        })
      : allLinks;
    return {
      all: allLinks.length,
      unpaid: allLinks.filter((l) => getPaymentStatus(l) === "unpaid" && getLinkStatus(l) === "active").length,
      paid: allLinks.filter((l) => getPaymentStatus(l) === "paid").length,
      expired: allLinks.filter((l) => getLinkStatus(l) === "expired").length,
    };
  }, [allLinks, debouncedSearch]);

  // ---------------------------------------------------------------------------
  // Currency conversion
  // ---------------------------------------------------------------------------

  useEffect(() => {
    if (!convertEnabled) {
      setConversionResult(null);
      setConversionError(null);
      return;
    }
    if (!srcAmount || parseFloat(srcAmount) <= 0 || !srcCurrency || !form.currency) return;
    if (srcCurrency === form.currency) {
      setConversionResult(null);
      setConversionError("Source and target currency are the same.");
      return;
    }

    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(async () => {
      setConversionLoading(true);
      setConversionError(null);
      try {
        const result = await apiFetch<ConversionResult>(
          `/api/exchange-rates/convert?amount=${encodeURIComponent(srcAmount)}&from=${encodeURIComponent(srcCurrency)}&to=${encodeURIComponent(form.currency)}`,
        );
        setConversionResult(result);
      } catch (err) {
        const msg = String((err as Error).message ?? "");
        if (msg.includes("Rate not available")) {
          setConversionError(`Rate not available for this pair: ${srcCurrency} → ${form.currency}`);
        } else {
          setConversionError("Failed to fetch conversion rate.");
        }
        setConversionResult(null);
      } finally {
        setConversionLoading(false);
      }
    }, 500);
  }, [convertEnabled, srcAmount, srcCurrency, form.currency]);

  function handleUseConvertedAmount() {
    if (!conversionResult) return;
    setForm((f) => ({
      ...f,
      amount: String(conversionResult.final_amount),
      currency: conversionResult.to_currency,
    }));
  }

  // ---------------------------------------------------------------------------
  // Mutations
  // ---------------------------------------------------------------------------

  const createMutation = useMutation({
    mutationFn: (body: CreateFormState & { conversionData?: ConversionResult | null }) => {
      const { conversionData, ...formBody } = body;
      const payload: Record<string, unknown> = {
        amount: parseFloat(formBody.amount),
        currency: formBody.currency,
        country: formBody.country || undefined,
        provider: formBody.provider,
        description: formBody.description || undefined,
      };
      if (conversionData) {
        payload.original_amount = conversionData.source_amount;
        payload.original_currency = conversionData.from_currency;
        payload.official_exchange_rate = conversionData.official_rate;
        payload.markup_percentage_used = conversionData.markup_percentage;
        payload.converted_amount_exact = conversionData.converted_amount_exact;
        payload.final_amount_charged = conversionData.final_amount;
        payload.converted_currency = conversionData.to_currency;
        payload.rounding_rule_used = conversionData.rounding_rule;
        payload.exchange_rate_fetched_at = conversionData.rate_fetched_at;
      }
      return apiFetch<{ payment_link: PaymentLink }>("/api/payment-links", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
    },
    onSuccess: (res) => {
      qc.invalidateQueries({ queryKey: ["payment-links"] });
      setCreateOpen(false);
      setSuccessLink(res.payment_link);
      setAmountFieldError(null);
      setForm({ amount: "", currency: "USD", country: "", provider: "stripe", description: "" });
      setConvertEnabled(false);
      setSrcAmount("");
      setSrcCurrency("USD");
      setConversionResult(null);
      setDuplicateSource(null);
    },
    onError: (err) => {
      const msg = String(err.message);
      if (msg.toLowerCase().includes("must not exceed")) {
        setAmountFieldError(t("paymentLinks.amountTooLarge"));
      } else {
        toast({
          title: t("paymentLinks.createError"),
          description: msg,
          variant: "destructive",
        });
      }
    },
  });

  const deactivateMutation = useMutation({
    mutationFn: (id: number) =>
      apiFetch(`/api/payment-links/${id}`, { method: "DELETE" }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["payment-links"] });
      setDisableId(null);
      setDeleteId(null);
      toast({
        title: t("paymentLinks.deactivated"),
        description: t("paymentLinks.deactivatedDesc"),
      });
    },
    onError: (err) => {
      toast({
        title: t("common.error"),
        description: String(err.message),
        variant: "destructive",
      });
    },
  });

  // ---------------------------------------------------------------------------
  // Form helpers
  // ---------------------------------------------------------------------------

  const isAmountValid = (value: string) =>
    /^\d+(\.\d+)?$/.test(value.trim()) && parseFloat(value) > 0;

  const handleCreateSubmit = () => {
    if (!isAmountValid(form.amount) || !form.country) return;
    if (parseFloat(form.amount) > MAX_PAYMENT_AMOUNT) {
      setAmountFieldError(t("paymentLinks.amountTooLarge"));
      return;
    }
    setAmountFieldError(null);
    createMutation.mutate({ ...form, conversionData: convertEnabled ? conversionResult : null });
  };

  function openDuplicate(link: PaymentLink) {
    setDuplicateSource(link);
    setForm({
      amount: String(link.amount / 100),
      currency: link.currency,
      country: link.country ?? "",
      provider: link.provider,
      description: link.description ?? "",
    });
    setConvertEnabled(false);
    setConversionResult(null);
    setAmountFieldError(null);
    setCreateOpen(true);
  }

  function openCreate() {
    setDuplicateSource(null);
    setForm({ amount: "", currency: "USD", country: "", provider: "stripe", description: "" });
    setConvertEnabled(false);
    setConversionResult(null);
    setAmountFieldError(null);
    setCreateOpen(true);
  }

  function buildWhatsAppUrl(link: { public_url: string; amount: number; currency: string; description: string | null }): string {
    const amount = link.amount / 100;
    const amountStr = new Intl.NumberFormat("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 2 }).format(amount);
    let text = `Hi! Here's a payment request for ${amountStr} ${link.currency}`;
    if (link.description) text += ` (${link.description})`;
    text += `: ${link.public_url}`;
    const msg = encodeURIComponent(text);
    return `https://wa.me/?text=${msg}`;
  }

  // Unique destinations for filter
  const uniqueDestinations = useMemo(() => {
    const seen = new Set<string>();
    for (const l of allLinks) {
      if (l.country) seen.add(l.country);
    }
    return Array.from(seen).sort();
  }, [allLinks]);

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  const tabs: { key: TabFilter; labelKey: string }[] = [
    { key: "all", labelKey: "paymentLinks.tabAll" },
    { key: "unpaid", labelKey: "paymentLinks.tabUnpaid" },
    { key: "paid", labelKey: "paymentLinks.tabPaid" },
    { key: "expired", labelKey: "paymentLinks.tabExpired" },
  ];

  const sortOptions: { value: SortOrder; labelKey: string }[] = [
    { value: "newest", labelKey: "paymentLinks.sortNewest" },
    { value: "oldest", labelKey: "paymentLinks.sortOldest" },
    { value: "amount_high", labelKey: "paymentLinks.sortAmountHigh" },
    { value: "amount_low", labelKey: "paymentLinks.sortAmountLow" },
  ];

  return (
    <div className="space-y-6">
      {/* Page header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">{t("paymentLinks.title")}</h1>
          <p className="text-muted-foreground text-sm mt-1">{t("paymentLinks.description")}</p>
        </div>
        <Button onClick={openCreate} className="gap-2" data-testid="button-create-payment-link">
          <Plus size={16} />
          {t("paymentLinks.create")}
        </Button>
      </div>

      {/* KPI summary cards */}
      <PaymentLinkSummary links={allLinks} isLoading={isLoading} />

      {/* Toolbar */}
      <div className="space-y-2">
        {/* Tabs + search row */}
        <div className="flex flex-col sm:flex-row gap-2 items-start sm:items-center justify-between">
          {/* Segmented tabs */}
          <div className="flex items-center gap-1 p-1 bg-secondary/50 rounded-lg border border-border flex-wrap">
            {tabs.map(({ key, labelKey }) => (
              <button
                key={key}
                onClick={() => setActiveTab(key)}
                className={`px-3 py-1.5 rounded-md text-sm font-medium transition-colors flex items-center gap-1.5 ${
                  activeTab === key
                    ? "bg-background text-foreground shadow-sm"
                    : "text-muted-foreground hover:text-foreground"
                }`}
              >
                {t(labelKey)}
                <span className={`text-xs px-1.5 py-0.5 rounded-full font-normal ${
                  activeTab === key ? "bg-primary/10 text-primary" : "bg-muted text-muted-foreground"
                }`}>
                  {tabCounts[key]}
                </span>
              </button>
            ))}
          </div>

          {/* Search */}
          <div className="relative w-full sm:w-64">
            <svg className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground pointer-events-none h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <circle cx="11" cy="11" r="8" /><path d="m21 21-4.35-4.35" />
            </svg>
            <Input
              className="pl-9 h-9"
              placeholder={t("paymentLinks.searchPlaceholder")}
              value={searchQuery}
              onChange={(e) => handleSearchChange(e.target.value)}
            />
          </div>
        </div>

        {/* Filters + sort row */}
        <div className="flex items-center gap-2 flex-wrap">
          {/* Filters popover */}
          <Popover open={filterOpen} onOpenChange={setFilterOpen}>
            <PopoverTrigger asChild>
              <Button variant="outline" size="sm" className="gap-1.5 h-8 text-xs">
                <SlidersHorizontal size={13} />
                {t("paymentLinks.filters")}
                {(filterDateFrom || filterDateTo || filterDestinations.length > 0 || filterAmountMin || filterAmountMax) && (
                  <span className="w-1.5 h-1.5 rounded-full bg-primary" />
                )}
              </Button>
            </PopoverTrigger>
            <PopoverContent className="w-72 p-4 space-y-4" align="start">
              {/* Date range */}
              <div className="space-y-2">
                <Label className="text-xs font-medium">{t("paymentLinks.filterDate")}</Label>
                <div className="grid grid-cols-2 gap-2">
                  <div className="space-y-1">
                    <Label className="text-xs text-muted-foreground">From</Label>
                    <Input
                      type="date"
                      className="h-7 text-xs"
                      value={filterDateFrom}
                      onChange={(e) => setFilterDateFrom(e.target.value)}
                    />
                  </div>
                  <div className="space-y-1">
                    <Label className="text-xs text-muted-foreground">To</Label>
                    <Input
                      type="date"
                      className="h-7 text-xs"
                      value={filterDateTo}
                      onChange={(e) => setFilterDateTo(e.target.value)}
                    />
                  </div>
                </div>
              </div>

              {/* Destination */}
              {uniqueDestinations.length > 0 && (
                <div className="space-y-2">
                  <Label className="text-xs font-medium">{t("paymentLinks.filterDestination")}</Label>
                  <div className="space-y-1.5 max-h-28 overflow-y-auto">
                    {uniqueDestinations.map((dest) => (
                      <label key={dest} className="flex items-center gap-2 cursor-pointer">
                        <input
                          type="checkbox"
                          className="rounded"
                          checked={filterDestinations.includes(dest)}
                          onChange={(e) => {
                            setFilterDestinations((prev) =>
                              e.target.checked ? [...prev, dest] : prev.filter((d) => d !== dest),
                            );
                          }}
                        />
                        <FlagImage country={dest} url={countryFlagUrls[dest] ?? null} size={12} />
                        <span className="text-sm">{dest}</span>
                      </label>
                    ))}
                  </div>
                </div>
              )}

              {/* Amount range */}
              <div className="space-y-2">
                <Label className="text-xs font-medium">{t("paymentLinks.filterAmount")}</Label>
                <div className="grid grid-cols-2 gap-2">
                  <div className="space-y-1">
                    <Label className="text-xs text-muted-foreground">Min</Label>
                    <Input
                      type="number"
                      min="0"
                      className="h-7 text-xs"
                      placeholder="0"
                      value={filterAmountMin}
                      onChange={(e) => setFilterAmountMin(e.target.value)}
                    />
                  </div>
                  <div className="space-y-1">
                    <Label className="text-xs text-muted-foreground">Max</Label>
                    <Input
                      type="number"
                      min="0"
                      className="h-7 text-xs"
                      placeholder="∞"
                      value={filterAmountMax}
                      onChange={(e) => setFilterAmountMax(e.target.value)}
                    />
                  </div>
                </div>
              </div>

              <Button
                variant="outline"
                size="sm"
                className="w-full h-7 text-xs"
                onClick={() => {
                  setFilterDateFrom("");
                  setFilterDateTo("");
                  setFilterDestinations([]);
                  setFilterAmountMin("");
                  setFilterAmountMax("");
                }}
              >
                {t("paymentLinks.clearFilters")}
              </Button>
            </PopoverContent>
          </Popover>

          {/* Sort */}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" size="sm" className="gap-1.5 h-8 text-xs">
                {t("paymentLinks.sort")}
                <ChevronDown size={12} />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start">
              {sortOptions.map((opt) => (
                <DropdownMenuItem
                  key={opt.value}
                  onClick={() => setSortOrder(opt.value)}
                  className={sortOrder === opt.value ? "font-medium" : ""}
                >
                  {sortOrder === opt.value && <Check size={12} className="mr-1 text-primary" />}
                  {t(opt.labelKey)}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>

          {/* Clear all filters */}
          {hasActiveFilters && (
            <Button
              variant="ghost"
              size="sm"
              className="gap-1.5 h-8 text-xs text-muted-foreground hover:text-foreground"
              onClick={clearAllFilters}
            >
              <X size={12} />
              {t("paymentLinks.clearFilters")}
            </Button>
          )}
        </div>
      </div>

      {/* Content area */}
      {isLoading ? (
        <TableSkeleton />
      ) : isError ? (
        <div className="flex flex-col items-center justify-center py-16 text-center gap-3 border border-border rounded-lg">
          <AlertCircle size={36} className="text-destructive opacity-60" />
          <div>
            <p className="font-medium text-foreground">{t("paymentLinks.errorTitle")}</p>
            <p className="text-sm text-muted-foreground mt-1">{t("paymentLinks.errorDesc")}</p>
          </div>
          <Button variant="outline" size="sm" className="gap-2" onClick={() => refetch()}>
            <RotateCcw size={14} />
            {t("paymentLinks.errorRetry")}
          </Button>
        </div>
      ) : allLinks.length === 0 ? (
        /* Empty: no links at all */
        <div className="flex flex-col items-center justify-center py-16 text-center gap-3 border border-border rounded-lg">
          <CreditCard size={40} className="text-muted-foreground opacity-40" />
          <div>
            <p className="font-medium text-foreground">{t("paymentLinks.empty")}</p>
            <p className="text-sm text-muted-foreground mt-1">{t("paymentLinks.emptyHint")}</p>
          </div>
          <Button onClick={openCreate} className="gap-2 mt-2">
            <Plus size={16} />
            {t("paymentLinks.create")}
          </Button>
        </div>
      ) : filteredLinks.length === 0 ? (
        /* Empty: no results */
        <div className="flex flex-col items-center justify-center py-16 text-center gap-3 border border-border rounded-lg">
          <CreditCard size={36} className="text-muted-foreground opacity-40" />
          <div>
            <p className="font-medium text-foreground">
              {debouncedSearch
                ? t("paymentLinks.noSearchResults")
                : t("paymentLinks.noFilterResults")}
            </p>
            <p className="text-sm text-muted-foreground mt-1">
              {debouncedSearch
                ? t("paymentLinks.noSearchResultsHint")
                : t("paymentLinks.noFilterResultsHint")}
            </p>
          </div>
          <Button
            variant="outline"
            size="sm"
            className="gap-2"
            onClick={clearAllFilters}
          >
            <X size={14} />
            {t("paymentLinks.clearFiltersAction")}
          </Button>
        </div>
      ) : (
        /* Table */
        <div className="border border-border rounded-lg overflow-hidden">
          {/* Desktop table */}
          <div className="hidden md:block overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="sticky top-0 z-10">
                <tr className="bg-secondary/50 border-b border-border">
                  <th className="text-left px-4 py-3 font-medium text-muted-foreground">{t("paymentLinks.colCustomer")}</th>
                  <th className="text-left px-4 py-3 font-medium text-muted-foreground">Order</th>
                  <th className="text-left px-4 py-3 font-medium text-muted-foreground">{t("paymentLinks.colAmount")}</th>
                  <th className="text-left px-4 py-3 font-medium text-muted-foreground">{t("paymentLinks.colPayment")}</th>
                  <th className="text-left px-4 py-3 font-medium text-muted-foreground">{t("paymentLinks.colLink")}</th>
                  <th className="text-left px-4 py-3 font-medium text-muted-foreground hidden lg:table-cell">{t("paymentLinks.colCreated")}</th>
                  <th className="text-left px-4 py-3 font-medium text-muted-foreground hidden xl:table-cell">Created by</th>
                  <th className="text-left px-4 py-3 font-medium text-muted-foreground hidden xl:table-cell">{t("paymentLinks.colDestination")}</th>
                  {showProviderColumn && (
                    <th className="text-left px-4 py-3 font-medium text-muted-foreground hidden lg:table-cell">{t("paymentLinks.colProvider")}</th>
                  )}
                  <th className="text-right px-4 py-3 font-medium text-muted-foreground">{t("paymentLinks.colActions")}</th>
                </tr>
              </thead>
              <tbody>
                {filteredLinks.map((link, i) => {
                  const paymentStatus = getPaymentStatus(link);
                  const linkStatus = getLinkStatus(link);
                  const customerName = [link.sender_first_name, link.sender_last_name].filter(Boolean).join(" ");

                  return (
                    <tr
                      key={link.id}
                      className={`border-b border-border last:border-0 ${i % 2 === 0 ? "" : "bg-secondary/20"}`}
                    >
                      {/* Customer / Description */}
                      <td className="px-4 py-3 max-w-[180px]">
                        {customerName ? (
                          <TooltipProvider>
                            <Tooltip>
                              <TooltipTrigger asChild>
                                <div>
                                  <p className="font-medium text-foreground truncate">{customerName}</p>
                                  {link.description && (
                                    <p className="text-xs text-muted-foreground truncate">{link.description}</p>
                                  )}
                                </div>
                              </TooltipTrigger>
                              {customerName.length > 24 && (
                                <TooltipContent>{customerName}</TooltipContent>
                              )}
                            </Tooltip>
                          </TooltipProvider>
                        ) : (
                          <div>
                            <p className="text-muted-foreground/50 text-sm italic">
                              {link.description || t("paymentLinks.noCustomer")}
                            </p>
                          </div>
                        )}
                      </td>

                       <td className="px-4 py-3 whitespace-nowrap">
                         {link.order_id ? (
                           <a
                             href={`/orders/${link.order_id}`}
                             className="inline-flex items-center gap-1 font-semibold text-teal-900 hover:underline"
                             aria-label={`Open linked order ${link.order_number ?? ""}`}
                           >
                             <Link2 size={13} aria-hidden="true" />
                             {link.order_number ?? "Linked order"}
                           </a>
                         ) : (
                           <Button
                             type="button"
                             variant="link"
                             size="sm"
                             className="h-auto p-0 text-teal-800"
                             onClick={() => setOrderLinkTarget(link)}
                           >
                             + Link order
                           </Button>
                         )}
                       </td>

                      {/* Amount */}
                      <td className="px-4 py-3 font-medium whitespace-nowrap">
                        <div>{formatAmount(link.amount, link.currency)}</div>
                        {link.original_currency && link.original_amount != null && (
                          <div className="text-xs text-muted-foreground mt-0.5 flex items-center gap-1">
                            <ArrowRightLeft size={10} className="shrink-0" />
                            <span>
                              Converted from {link.original_amount} {link.original_currency}
                              {link.official_exchange_rate != null && (
                                <> · Rate {Number(link.official_exchange_rate).toFixed(4)}</>
                              )}
                              {link.markup_percentage_used != null && link.markup_percentage_used > 0 && (
                                <> + {link.markup_percentage_used}% markup</>
                              )}
                              {link.rounding_rule_used && link.rounding_rule_used !== "none" && (
                                <> · {roundingRuleLabel(link.rounding_rule_used)}</>
                              )}
                            </span>
                          </div>
                        )}
                      </td>

                      {/* Payment status */}
                      <td className="px-4 py-3">
                        <PaymentStatusBadge status={paymentStatus} />
                      </td>

                      {/* Link status */}
                      <td className="px-4 py-3">
                        <LinkStatusBadge status={linkStatus} />
                      </td>

                      {/* Created */}
                      <td className="px-4 py-3 text-muted-foreground whitespace-nowrap hidden lg:table-cell">
                        {formatDate(link.created_at)}
                      </td>

                      {/* Created by */}
                      <td className="px-4 py-3 hidden xl:table-cell">
                        {link.creator_first_name || link.creator_image_url ? (
                          <div className="flex items-center gap-2">
                            {link.creator_image_url ? (
                              <img
                                src={link.creator_image_url}
                                alt={link.creator_first_name ?? ""}
                                className="w-6 h-6 rounded-full object-cover shrink-0"
                              />
                            ) : (
                              <div className="w-6 h-6 rounded-full bg-muted flex items-center justify-center shrink-0">
                                <span className="text-[10px] font-medium text-muted-foreground">
                                  {link.creator_first_name?.charAt(0).toUpperCase() ?? "?"}
                                </span>
                              </div>
                            )}
                            <span className="text-sm text-muted-foreground">{link.creator_first_name ?? "—"}</span>
                          </div>
                        ) : (
                          <span className="text-muted-foreground/50">—</span>
                        )}
                      </td>

                      {/* Destination */}
                      <td className="px-4 py-3 hidden xl:table-cell">
                        {link.country ? (
                          <span className="inline-flex items-center gap-1.5 text-sm text-muted-foreground">
                            <FlagImage country={link.country} url={countryFlagUrls[link.country] ?? null} size={14} />
                            {link.country}
                          </span>
                        ) : (
                          <span className="text-muted-foreground/40">—</span>
                        )}
                      </td>

                      {/* Provider (conditional) */}
                      {showProviderColumn && (
                        <td className="px-4 py-3 hidden lg:table-cell">
                          <ProviderBadge provider={link.provider} />
                        </td>
                      )}

                      {/* Actions */}
                      <td className="px-4 py-3">
                        <div className="flex items-center justify-end gap-1">
                          {/* Primary action: Copy link */}
                          <CopyButton text={link.public_url} linkId={link.id} />

                          {/* Overflow menu */}
                          <DropdownMenu>
                            <DropdownMenuTrigger asChild>
                              <Button variant="ghost" size="sm" className="h-7 w-7 p-0">
                                <MoreHorizontal size={14} />
                              </Button>
                            </DropdownMenuTrigger>
                            <DropdownMenuContent align="end">
                              <DropdownMenuItem
                                onClick={() => window.open(link.public_url, "_blank")}
                              >
                                <ExternalLink size={14} className="mr-2" />
                                {t("paymentLinks.openLink")}
                              </DropdownMenuItem>
                              <DropdownMenuItem
                                onClick={() => window.open(buildWhatsAppUrl(link), "_blank")}
                              >
                                <MessageCircle size={14} className="mr-2" />
                                {t("paymentLinks.whatsappAction")}
                              </DropdownMenuItem>
                              <DropdownMenuItem onClick={() => setOrderLinkTarget(link)}>
                                <Link2 size={14} className="mr-2" />
                                {link.order_id ? "Change linked order" : "Link order"}
                              </DropdownMenuItem>
                              {link.order_id && (
                                <DropdownMenuItem
                                  onClick={() => {
                                    if (window.confirm("Unlink this payment link from its order? Neither record will be deleted.")) {
                                      unlinkOrder.mutate(link.id);
                                    }
                                  }}
                                >
                                  <Link2 size={14} className="mr-2" />
                                  Unlink order
                                </DropdownMenuItem>
                              )}
                              {linkStatus !== "expired" && paymentStatus !== "paid" && (
                                <DropdownMenuItem onClick={() => openDuplicate(link)}>
                                  <CopyPlus size={14} className="mr-2" />
                                  {t("paymentLinks.duplicate")}
                                </DropdownMenuItem>
                              )}
                              <DropdownMenuSeparator />
                              {linkStatus === "active" && (
                                <DropdownMenuItem
                                  onClick={() => setDisableId(link.id)}
                                  className="text-muted-foreground"
                                >
                                  <Ban size={14} className="mr-2" />
                                  {t("paymentLinks.disable")}
                                </DropdownMenuItem>
                              )}
                              <DropdownMenuItem
                                onClick={() => setDeleteId(link.id)}
                                className="text-destructive focus:text-destructive"
                              >
                                <Trash2 size={14} className="mr-2" />
                                {t("paymentLinks.delete")}
                              </DropdownMenuItem>
                            </DropdownMenuContent>
                          </DropdownMenu>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {/* Mobile card layout */}
          <div className="md:hidden divide-y divide-border">
            {filteredLinks.map((link) => {
              const paymentStatus = getPaymentStatus(link);
              const linkStatus = getLinkStatus(link);
              const customerName = [link.sender_first_name, link.sender_last_name].filter(Boolean).join(" ");

              return (
                <div key={link.id} className="p-4 space-y-3">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <p className="font-medium text-foreground truncate">
                        {customerName || link.description || t("paymentLinks.noCustomer")}
                      </p>
                      {customerName && link.description && (
                        <p className="text-xs text-muted-foreground truncate">{link.description}</p>
                      )}
                    </div>
                    <p className="font-semibold text-foreground shrink-0">
                      {formatAmount(link.amount, link.currency)}
                    </p>
                  </div>
                  <div className="flex items-center gap-2 flex-wrap">
                    <PaymentStatusBadge status={paymentStatus} />
                    <LinkStatusBadge status={linkStatus} />
                    {link.order_id ? (
                      <a href={`/orders/${link.order_id}`} className="inline-flex items-center gap-1 text-xs font-semibold text-teal-900 hover:underline">
                        <Link2 size={12} /> {link.order_number ?? "Linked order"}
                      </a>
                    ) : (
                      <Button type="button" variant="link" size="sm" className="h-auto p-0 text-xs text-teal-800" onClick={() => setOrderLinkTarget(link)}>
                        + Link order
                      </Button>
                    )}
                    {link.country && (
                      <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
                        <FlagImage country={link.country} url={countryFlagUrls[link.country] ?? null} size={12} />
                        {link.country}
                      </span>
                    )}
                  </div>
                  <div className="flex items-center justify-between">
                    <p className="text-xs text-muted-foreground">{formatDate(link.created_at)}</p>
                    <div className="flex items-center gap-1">
                      <CopyButton text={link.public_url} linkId={link.id} />
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button variant="ghost" size="sm" className="h-7 w-7 p-0">
                            <MoreHorizontal size={14} />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                          <DropdownMenuItem onClick={() => window.open(link.public_url, "_blank")}>
                            <ExternalLink size={14} className="mr-2" />
                            {t("paymentLinks.openLink")}
                          </DropdownMenuItem>
                          <DropdownMenuItem onClick={() => window.open(buildWhatsAppUrl(link), "_blank")}>
                            <MessageCircle size={14} className="mr-2" />
                            {t("paymentLinks.whatsappAction")}
                          </DropdownMenuItem>
                          <DropdownMenuItem onClick={() => setOrderLinkTarget(link)}>
                            <Link2 size={14} className="mr-2" />
                            {link.order_id ? "Change linked order" : "Link order"}
                          </DropdownMenuItem>
                          {link.order_id && (
                            <DropdownMenuItem onClick={() => {
                              if (window.confirm("Unlink this payment link from its order? Neither record will be deleted.")) unlinkOrder.mutate(link.id);
                            }}>
                              <Link2 size={14} className="mr-2" /> Unlink order
                            </DropdownMenuItem>
                          )}
                          {linkStatus !== "expired" && paymentStatus !== "paid" && (
                            <DropdownMenuItem onClick={() => openDuplicate(link)}>
                              <CopyPlus size={14} className="mr-2" />
                              {t("paymentLinks.duplicate")}
                            </DropdownMenuItem>
                          )}
                          <DropdownMenuSeparator />
                          {linkStatus === "active" && (
                            <DropdownMenuItem onClick={() => setDisableId(link.id)} className="text-muted-foreground">
                              <Ban size={14} className="mr-2" />
                              {t("paymentLinks.disable")}
                            </DropdownMenuItem>
                          )}
                          <DropdownMenuItem onClick={() => setDeleteId(link.id)} className="text-destructive focus:text-destructive">
                            <Trash2 size={14} className="mr-2" />
                            {t("paymentLinks.delete")}
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      <LinkOrderDialog
        link={orderLinkTarget}
        open={orderLinkTarget !== null}
        onOpenChange={(open) => { if (!open) setOrderLinkTarget(null); }}
      />

      {/* ------------------------------------------------------------------ */}
      {/* Create dialog                                                        */}
      {/* ------------------------------------------------------------------ */}
      <Dialog
        open={createOpen}
        onOpenChange={(open) => {
          setCreateOpen(open);
          if (!open) {
            setAmountFieldError(null);
            setConvertEnabled(false);
            setSrcAmount("");
            setSrcCurrency("USD");
            setConversionResult(null);
            setConversionError(null);
            setDuplicateSource(null);
          }
        }}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>
              {duplicateSource ? t("paymentLinks.duplicateTitle") : t("paymentLinks.createTitle")}
            </DialogTitle>
            <DialogDescription>{t("paymentLinks.createDesc")}</DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label htmlFor="pl-amount">{t("paymentLinks.fieldAmount")}</Label>
                <Input
                  id="pl-amount"
                  data-testid="input-payment-amount"
                  type="text"
                  inputMode="decimal"
                  placeholder="0.00"
                  value={form.amount}
                  className={amountFieldError ? "border-destructive focus-visible:ring-destructive" : ""}
                  onChange={(e) => {
                    const stripped = e.target.value.replace(/[^0-9.]/g, "");
                    const dotIdx = stripped.indexOf(".");
                    const deduped =
                      dotIdx === -1
                        ? stripped
                        : stripped.slice(0, dotIdx + 1) + stripped.slice(dotIdx + 1).replace(/\./g, "");
                    const filtered =
                      deduped.indexOf(".") === -1
                        ? deduped
                        : deduped.slice(0, deduped.indexOf(".") + 3);
                    setAmountFieldError(null);
                    setForm((f) => ({ ...f, amount: filtered }));
                  }}
                />
                {amountFieldError && (
                  <p className="text-xs text-destructive" data-testid="error-amount-too-large">{amountFieldError}</p>
                )}
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="pl-currency">{t("paymentLinks.fieldCurrency")}</Label>
                <Select
                  value={form.currency}
                  onValueChange={(v) =>
                    setForm((f) => {
                      let provider = f.provider;
                      if (provider === "paypal" && PAYPAL_UNSUPPORTED_CURRENCIES.has(v)) provider = "stripe";
                      if (provider === "mamo" && MAMO_UNSUPPORTED_CURRENCIES.has(v)) provider = "stripe";
                      return { ...f, currency: v, provider };
                    })
                  }
                >
                  <SelectTrigger id="pl-currency">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {SUPPORTED_CURRENCIES.map((c) => {
                      const noProviderSupports =
                        STRIPE_UNSUPPORTED_CURRENCIES.has(c) &&
                        PAYPAL_UNSUPPORTED_CURRENCIES.has(c) &&
                        MAMO_UNSUPPORTED_CURRENCIES.has(c);
                      return (
                        <SelectItem
                          key={c}
                          value={c}
                          disabled={noProviderSupports}
                          title={noProviderSupports ? t("paymentLinks.currencyNotSupportedTooltip") : undefined}
                        >
                          {noProviderSupports ? (
                            <span className="flex items-center gap-1.5">
                              {c}
                              <span className="text-xs text-muted-foreground/60">({t("paymentLinks.currencyNotSupported")})</span>
                            </span>
                          ) : (
                            c
                          )}
                        </SelectItem>
                      );
                    })}
                  </SelectContent>
                </Select>
              </div>
            </div>

            {/* Currency conversion toggle */}
            <div className="rounded-md border border-border p-3 space-y-3">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <ArrowRightLeft size={14} className="text-muted-foreground" />
                  <Label htmlFor="convert-toggle" className="cursor-pointer text-sm font-medium">
                    Convert from another currency
                  </Label>
                </div>
                <Switch id="convert-toggle" checked={convertEnabled} onCheckedChange={setConvertEnabled} />
              </div>
              {convertEnabled && (
                <div className="space-y-3">
                  <div className="grid grid-cols-2 gap-3">
                    <div className="space-y-1.5">
                      <Label htmlFor="src-amount" className="text-xs">Source Amount</Label>
                      <Input
                        id="src-amount"
                        type="text"
                        inputMode="decimal"
                        placeholder="0.00"
                        value={srcAmount}
                        onChange={(e) => {
                          const stripped = e.target.value.replace(/[^0-9.]/g, "");
                          const dotIdx = stripped.indexOf(".");
                          const deduped =
                            dotIdx === -1
                              ? stripped
                              : stripped.slice(0, dotIdx + 1) + stripped.slice(dotIdx + 1).replace(/\./g, "");
                          setSrcAmount(deduped);
                        }}
                      />
                    </div>
                    <div className="space-y-1.5">
                      <Label htmlFor="src-currency" className="text-xs">Source Currency</Label>
                      <Select value={srcCurrency} onValueChange={setSrcCurrency}>
                        <SelectTrigger id="src-currency">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {SUPPORTED_CURRENCIES.map((c) => (
                            <SelectItem key={c} value={c}>{c}</SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                  </div>
                  {conversionLoading && (
                    <div className="flex items-center gap-2 text-xs text-muted-foreground">
                      <Loader2 size={12} className="animate-spin" />
                      Fetching rate…
                    </div>
                  )}
                  {conversionError && !conversionLoading && (
                    <p className="text-xs text-destructive">{conversionError}</p>
                  )}
                  {conversionResult && !conversionLoading && (
                    <div className="rounded-md bg-secondary/50 p-3 space-y-1.5 text-xs">
                      <div className="flex justify-between">
                        <span className="text-muted-foreground">Official rate</span>
                        <span className="font-medium">1 {conversionResult.from_currency} = {conversionResult.official_rate.toFixed(6)} {conversionResult.to_currency}</span>
                      </div>
                      {conversionResult.markup_percentage > 0 && (
                        <div className="flex justify-between">
                          <span className="text-muted-foreground">Markup</span>
                          <span className="font-medium">{conversionResult.markup_percentage}%</span>
                        </div>
                      )}
                      <div className="flex justify-between">
                        <span className="text-muted-foreground">Exact converted</span>
                        <span className="font-medium">{conversionResult.converted_amount_exact.toFixed(4)} {conversionResult.to_currency}</span>
                      </div>
                      <div className="flex justify-between border-t border-border pt-1.5 mt-1.5">
                        <span className="text-muted-foreground font-medium">Final amount ({roundingRuleLabel(conversionResult.rounding_rule)})</span>
                        <span className="font-semibold text-foreground">{conversionResult.final_amount} {conversionResult.to_currency}</span>
                      </div>
                      <Button size="sm" variant="outline" className="w-full mt-1 h-7 text-xs" onClick={handleUseConvertedAmount} type="button">
                        Use this amount
                      </Button>
                    </div>
                  )}
                </div>
              )}
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="pl-country">{t("paymentLinks.fieldCountry")}</Label>
              <Select value={form.country} onValueChange={(v) => setForm((f) => ({ ...f, country: v }))}>
                <SelectTrigger id="pl-country" data-testid="select-country">
                  <SelectValue placeholder={t("paymentLinks.countryPlaceholder")} />
                </SelectTrigger>
                <SelectContent>
                  {availableCountries.map((c) => (
                    <SelectItem key={c} value={c}>
                      <span className="inline-flex items-center gap-2">
                        <FlagImage country={c} url={countryFlagUrls[c] ?? null} size={14} />
                        {c}
                      </span>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-1.5">
              <Label>{t("paymentLinks.fieldProvider")}</Label>
              <div className="flex gap-2">
                {SUPPORTED_PROVIDERS.map((p) => {
                  const noCountry = !form.country;
                  const mamoNotAvailable =
                    p === "mamo" &&
                    providerStatus !== undefined &&
                    (!providerStatus.mamo || !providerStatus.mamo_enabled);
                  const isUnsupported =
                    noCountry ||
                    mamoNotAvailable ||
                    (p === "paypal" && PAYPAL_UNSUPPORTED_CURRENCIES.has(form.currency)) ||
                    (p === "mamo" && MAMO_UNSUPPORTED_CURRENCIES.has(form.currency));
                  return (
                    <button
                      key={p}
                      type="button"
                      data-testid={`button-provider-${p}`}
                      disabled={isUnsupported}
                      onClick={() => !isUnsupported && setForm((f) => ({ ...f, provider: p }))}
                      className={`flex-1 py-2 px-4 rounded-md border text-sm font-medium transition-colors ${
                        isUnsupported
                          ? "border-border text-muted-foreground opacity-40 cursor-not-allowed"
                          : form.provider === p
                            ? "border-primary bg-primary/5 text-primary"
                            : "border-border text-muted-foreground hover:bg-secondary"
                      }`}
                    >
                      {p === "stripe" ? "Stripe" : p === "paypal" ? "PayPal" : "Mamo"}
                    </button>
                  );
                })}
              </div>
              {PAYPAL_UNSUPPORTED_CURRENCIES.has(form.currency) && !MAMO_UNSUPPORTED_CURRENCIES.has(form.currency) && (
                <p className="text-xs text-muted-foreground">{t("paymentLinks.paypalUnsupported")}</p>
              )}
              {MAMO_UNSUPPORTED_CURRENCIES.has(form.currency) && !PAYPAL_UNSUPPORTED_CURRENCIES.has(form.currency) && (
                <p className="text-xs text-muted-foreground">{t("paymentLinks.mamoUnsupported")}</p>
              )}
              {PAYPAL_UNSUPPORTED_CURRENCIES.has(form.currency) && MAMO_UNSUPPORTED_CURRENCIES.has(form.currency) && (
                <p className="text-xs text-muted-foreground">{t("paymentLinks.paypalAndMamoUnsupported")}</p>
              )}
              {providerStatus && !providerStatus.mamo && (
                <p className="text-xs text-muted-foreground">{t("paymentLinks.mamoNotConfigured")}</p>
              )}
              {providerStatus && providerStatus.mamo && !providerStatus.mamo_enabled && (
                <p className="text-xs text-muted-foreground">{t("paymentLinks.mamoDisabled")}</p>
              )}
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="pl-description">
                {t("paymentLinks.fieldDescription")}
                <span className="text-muted-foreground font-normal ml-1">({t("paymentLinks.optional")})</span>
              </Label>
              <Textarea
                id="pl-description"
                placeholder={t("paymentLinks.descriptionPlaceholder")}
                value={form.description}
                onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))}
                rows={2}
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setCreateOpen(false)}>
              {t("common.cancel")}
            </Button>
            <Button
              onClick={handleCreateSubmit}
              disabled={!isAmountValid(form.amount) || !form.country || createMutation.isPending}
              className="gap-2"
              data-testid="button-create-submit"
            >
              {createMutation.isPending && <Loader2 size={14} className="animate-spin" />}
              {createMutation.isPending ? t("paymentLinks.creating") : t("paymentLinks.createAction")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ------------------------------------------------------------------ */}
      {/* Success dialog                                                       */}
      {/* ------------------------------------------------------------------ */}
      <Dialog open={!!successLink} onOpenChange={(o) => { if (!o) setSuccessLink(null); }}>
        <DialogContent className="sm:max-w-md" data-testid="dialog-payment-link-success">
          <DialogHeader>
            <DialogTitle>{t("paymentLinks.successTitle")}</DialogTitle>
            <DialogDescription>{t("paymentLinks.successDesc")}</DialogDescription>
          </DialogHeader>
          {successLink && (
            <div className="space-y-4 py-2">
              {/* Public (shareable) URL */}
              <div className="bg-secondary/50 rounded-lg p-4 space-y-1">
                <p className="text-xs text-muted-foreground font-medium">{t("paymentLinks.shareableUrl")}</p>
                <div className="flex items-center gap-2">
                  <code className="text-sm break-all flex-1 text-foreground" data-testid="text-public-url">
                    {successLink.public_url}
                  </code>
                  <CopyButton text={successLink.public_url} />
                </div>
              </div>

              {/* Provider checkout URL */}
              {successLink.provider_checkout_url && (
                <div className="space-y-1">
                  <p className="text-xs text-muted-foreground font-medium">
                    {successLink.provider === "stripe"
                      ? t("paymentLinks.stripeCheckoutUrl")
                      : successLink.provider === "paypal"
                        ? t("paymentLinks.paypalApprovalUrl")
                        : t("paymentLinks.mamoCheckoutUrl")}
                  </p>
                  <a
                    data-testid="link-checkout-url"
                    href={successLink.provider_checkout_url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-xs text-primary break-all underline underline-offset-2 hover:opacity-80 block"
                  >
                    {successLink.provider_checkout_url}
                  </a>
                </div>
              )}

              <p className="text-xs text-muted-foreground">{t("paymentLinks.successHint")}</p>

              {/* Action CTAs */}
              <div className="flex flex-col gap-2">
                <Button
                  variant="outline"
                  className="w-full gap-2"
                  onClick={() => window.open(buildWhatsAppUrl(successLink), "_blank")}
                >
                  <MessageCircle size={15} />
                  {t("paymentLinks.whatsappAction")}
                </Button>
                <Button
                  variant="outline"
                  className="w-full gap-2"
                  onClick={() => window.open(successLink.public_url, "_blank")}
                >
                  <ExternalLink size={15} />
                  {t("paymentLinks.openLink")}
                </Button>
              </div>
            </div>
          )}
          <DialogFooter>
            <Button onClick={() => setSuccessLink(null)}>{t("common.close")}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ------------------------------------------------------------------ */}
      {/* Disable confirmation                                                 */}
      {/* ------------------------------------------------------------------ */}
      <AlertDialog open={disableId !== null} onOpenChange={(o) => { if (!o) setDisableId(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("paymentLinks.disableTitle")}</AlertDialogTitle>
            <AlertDialogDescription>{t("paymentLinks.disableDesc")}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("common.cancel")}</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => disableId !== null && deactivateMutation.mutate(disableId)}
            >
              {t("paymentLinks.disable")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* ------------------------------------------------------------------ */}
      {/* Delete confirmation                                                  */}
      {/* ------------------------------------------------------------------ */}
      <AlertDialog open={deleteId !== null} onOpenChange={(o) => { if (!o) setDeleteId(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("paymentLinks.deleteTitle")}</AlertDialogTitle>
            <AlertDialogDescription>{t("paymentLinks.deleteDesc")}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("common.cancel")}</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={() => deleteId !== null && deactivateMutation.mutate(deleteId)}
            >
              {t("paymentLinks.delete")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

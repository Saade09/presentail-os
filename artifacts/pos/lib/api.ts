import { useState, useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import type {
  DeliveryCity, DeliverySlot, Order, OrderItem, OrderStatus, PaymentStatus,
  PaymentMethod, OrderSource,
} from '@/types';

const OS_API_URL = (process.env.EXPO_PUBLIC_OS_API_URL ?? '').replace(/\/$/, '');
const WORKSPACE_ID = process.env.EXPO_PUBLIC_OS_WORKSPACE_ID ?? '';
const OS_API_KEY = process.env.EXPO_PUBLIC_OS_API_KEY ?? '';

type ApiDeliverySlot = {
  id: number | string;
  day_of_week: number;
  label?: string | null;
  start_time?: string | null;
  end_time?: string | null;
  capacity?: number | null;
  is_enabled?: boolean | null;
};

type ApiCity = {
  id: number;
  name: string;
  slug: string;
  delivery_fee: number;
  free_delivery_enabled: boolean;
  free_delivery_threshold: number | null;
  express_delivery_enabled: boolean;
  express_delivery_fee: number | null;
  express_delivery_cutoff_time: string | null;
  delivery_slots?: ApiDeliverySlot[] | null;
};

type ApiCountry = {
  country_code: string;
  name: string;
  cities: ApiCity[];
};

type ApiResponse = {
  countries: ApiCountry[];
};

function mapCity(city: ApiCity): DeliveryCity {
  const deliverySlots: DeliverySlot[] = (city.delivery_slots ?? []).map(s => ({
    id: String(s.id),
    dayOfWeek: s.day_of_week,
    label: s.label ?? `${s.start_time ?? ''} – ${s.end_time ?? ''}`,
    startTime: s.start_time ?? '',
    endTime: s.end_time ?? '',
    capacity: s.capacity ?? 10,
    enabled: s.is_enabled !== false,
  }));

  return {
    id: city.slug,
    numericId: city.id,
    name: city.name,
    isActive: true,
    deliveryFee: city.delivery_fee,
    freeDeliveryEnabled: city.free_delivery_enabled,
    freeDeliveryThreshold: city.free_delivery_threshold ?? 0,
    expressAvailable: city.express_delivery_enabled,
    expressCutoffTime: city.express_delivery_cutoff_time ?? undefined,
    expressFee: city.express_delivery_fee ?? undefined,
    deliverySlots,
  };
}

export type LiveDeliveryCitiesResult = {
  cities: DeliveryCity[];
  loading: boolean;
  error: string | null;
};

export function useLiveDeliveryCities(): LiveDeliveryCitiesResult {
  const [cities, setCities] = useState<DeliveryCity[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!OS_API_URL || !WORKSPACE_ID) {
      setError('OS API URL or workspace ID is not configured.');
      setLoading(false);
      return;
    }

    let cancelled = false;
    setLoading(true);
    setError(null);

    fetch(`${OS_API_URL}/api/delivery-locations?workspace=${encodeURIComponent(WORKSPACE_ID)}`)
      .then(res => {
        if (!res.ok) throw new Error(`Server returned ${res.status}`);
        return res.json() as Promise<ApiResponse>;
      })
      .then(data => {
        if (cancelled) return;
        const mapped: DeliveryCity[] = data.countries.flatMap(country =>
          country.cities.map(mapCity)
        );
        setCities(mapped);
        setLoading(false);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : 'Failed to load delivery cities.');
        setLoading(false);
      });

    return () => { cancelled = true; };
  }, []);

  return { cities, loading, error };
}

// ── Orders (live) ───────────────────────────────────────────────────────────
// Maps the Presentail OS `/api/orders` + `/api/orders/:id` responses into the
// POS `Order` shape. Authentication uses a workspace API key (`pk_live_...`),
// sent via the `x-api-key` header — the OS grants read-only access to orders
// for any valid key. The order-detail line items carry a resolved `image_url`.

type ApiTotals = {
  total?: number | string | null;
  subtotal?: number | string | null;
  shipping?: number | string | null;
  discount?: number | string | null;
  currency?: string | null;
};

type ApiDeliveryAddress = {
  district?: string | null;
  cityId?: string | null;
  countryCode?: string | null;
  address?: string | null;
  phone?: string | null;
  date?: string | null;
  slot?: string | null;
  isExpress?: boolean | null;
  expressSurchargeUsd?: number | string | null;
};

type ApiOrderBase = {
  id: string;
  display_order_number?: string | null;
  external_order_id?: string | null;
  status?: string | null;
  source?: string | null;
  channel?: string | null;
  ordered_at?: string | null;
  delivery_address?: ApiDeliveryAddress | null;
  window_start?: string | null;
  totals?: ApiTotals | null;
  created_at?: string | null;
  payment_status?: string | null;
  payment_method?: string | null;
  is_anonymous?: boolean | null;
};

type ApiOrderListItem = ApiOrderBase & {
  contact_id?: number | null;
  contact_name?: string | null;
  contact_email?: string | null;
  contact_phone?: string | null;
  is_anonymous?: boolean | null;
};

type ApiLineItem = {
  id: number;
  product_id?: number | null;
  sku?: string | null;
  name?: string | null;
  quantity?: number | string | null;
  unit_price?: number | string | null;
  image_url?: string | null;
};

type ApiOrderContact = {
  role: string;
  contact_id: number;
  first_name?: string | null;
  last_name?: string | null;
  display_name?: string | null;
  email?: string | null;
  phone?: string | null;
};

type ApiOrderDetail = ApiOrderBase & {
  card_message?: string | null;
  internal_note?: string | null;
  occasion?: string | null;
};

type ApiOrderDetailResponse = {
  order: ApiOrderDetail;
  line_items: ApiLineItem[];
  contacts: ApiOrderContact[];
};

function num(v: unknown): number {
  const n = typeof v === 'string' ? parseFloat(v) : typeof v === 'number' ? v : 0;
  return Number.isFinite(n) ? n : 0;
}

const STATUS_MAP: Record<string, OrderStatus> = {
  pending: 'awaiting_payment',
  confirmed: 'paid',
  processing: 'preparing',
  out_for_delivery: 'with_driver',
  delivered: 'delivered',
  completed: 'delivered',
  cancelled: 'closed',
  on_hold: 'issue_reported',
  refunded: 'closed',
};

function mapStatus(s: string | null | undefined): OrderStatus {
  return STATUS_MAP[(s ?? '').toLowerCase()] ?? 'draft';
}

function mapPaymentStatus(s: string | null | undefined): PaymentStatus {
  const v = (s ?? '').toLowerCase();
  if (v === 'paid') return 'paid';
  if (v === 'failed') return 'failed';
  if (v === 'expired') return 'expired';
  if (v === 'draft') return 'draft';
  return 'awaiting_payment';
}

function mapPaymentMethod(m: string | null | undefined): PaymentMethod | undefined {
  const v = (m ?? '').toLowerCase();
  const allowed: PaymentMethod[] = ['payment_link', 'cash', 'card', 'bank_transfer', 'already_paid'];
  return allowed.includes(v as PaymentMethod) ? (v as PaymentMethod) : undefined;
}

function mapSource(s: string | null | undefined): OrderSource {
  const v = (s ?? '').toLowerCase();
  const allowed: OrderSource[] = ['whatsapp', 'instagram', 'phone', 'walkin', 'website', 'other'];
  return allowed.includes(v as OrderSource) ? (v as OrderSource) : 'other';
}

function mapBaseOrder(o: ApiOrderBase): Order {
  const totals = o.totals ?? {};
  const addr = o.delivery_address ?? {};
  const created = o.created_at ?? o.ordered_at ?? new Date().toISOString();
  return {
    id: o.id,
    orderNumber: o.display_order_number || o.external_order_id || `#${String(o.id).slice(0, 8)}`,
    status: mapStatus(o.status),
    paymentStatus: mapPaymentStatus(o.payment_status),
    paymentMethod: mapPaymentMethod(o.payment_method),
    source: mapSource(o.source ?? o.channel),
    customer: {
      id: '', name: 'Unknown', phone: '', language: 'en',
      isVip: false, totalOrders: 0, lifetimeSpend: 0,
    },
    recipient: {
      name: '',
      phone: addr.phone ?? '',
      city: addr.cityId ?? '',
      area: addr.district ?? undefined,
      address: addr.address ?? '',
    },
    items: [],
    addOns: [],
    deliveryDate: addr.date ?? o.window_start ?? undefined,
    deliveryTimeSlot: addr.slot ?? undefined,
    deliveryFee: num(totals.shipping),
    expressFee: num(addr.expressSurchargeUsd),
    discount: num(totals.discount),
    subtotal: num(totals.subtotal),
    total: num(totals.total),
    isAnonymous: o.is_anonymous === true,
    isUrgent: false,
    hasIssue: false,
    agentId: '',
    agentName: '',
    createdAt: created,
    updatedAt: created,
  };
}

function mapListOrder(o: ApiOrderListItem): Order {
  const base = mapBaseOrder(o);
  base.customer = {
    id: o.contact_id != null ? String(o.contact_id) : '',
    name: o.is_anonymous ? 'Anonymous' : (o.contact_name ?? 'Unknown'),
    phone: o.contact_phone ?? '',
    email: o.is_anonymous ? undefined : (o.contact_email ?? undefined),
    language: 'en',
    isVip: false,
    totalOrders: 0,
    lifetimeSpend: 0,
  };
  base.recipient.name = o.contact_name ?? '';
  return base;
}

function contactName(c: ApiOrderContact): string {
  return (
    c.display_name?.trim() ||
    [c.first_name, c.last_name].filter(Boolean).join(' ').trim() ||
    ''
  );
}

function mapDetailOrder(resp: ApiOrderDetailResponse): Order {
  const order = mapBaseOrder(resp.order);
  order.cardMessage = resp.order.card_message ?? undefined;
  order.internalNotes = resp.order.internal_note ?? undefined;
  order.occasion = resp.order.occasion ?? undefined;

  order.items = (resp.line_items ?? []).map((li): OrderItem => ({
    id: String(li.id),
    product: {
      id: li.product_id != null ? String(li.product_id) : li.sku ?? String(li.id),
      name: li.name ?? 'Item',
      category: '',
      price: num(li.unit_price),
      image: li.image_url ?? '',
      availability: 'available',
      cities: [],
    },
    quantity: num(li.quantity) || 1,
    unitPrice: num(li.unit_price),
  }));

  const customer = (resp.contacts ?? []).find(c => c.role === 'customer');
  const recipient = (resp.contacts ?? []).find(c => c.role === 'recipient');

  if (customer) {
    const anon = resp.order.is_anonymous === true;
    order.customer = {
      id: String(customer.contact_id),
      name: anon ? 'Anonymous' : (contactName(customer) || 'Unknown'),
      phone: customer.phone ?? '',
      email: anon ? undefined : (customer.email ?? undefined),
      language: 'en',
      isVip: false,
      totalOrders: 0,
      lifetimeSpend: 0,
    };
  }
  order.recipient.name = recipient ? contactName(recipient) : order.customer.name;
  if (recipient?.phone && !order.recipient.phone) order.recipient.phone = recipient.phone;

  if (!order.subtotal && order.items.length > 0) {
    order.subtotal = order.items.reduce((sum, it) => sum + it.unitPrice * it.quantity, 0);
  }
  return order;
}

function authHeaders(): Record<string, string> {
  return OS_API_KEY ? { 'x-api-key': OS_API_KEY } : {};
}

function ordersConfigError(): string | null {
  if (!OS_API_URL) return 'OS API URL is not configured.';
  if (!OS_API_KEY) return 'OS API key is not configured.';
  return null;
}

export type LiveOrdersResult = {
  orders: Order[];
  loading: boolean;
  refreshing: boolean;
  error: string | null;
  refetch: () => void;
};

export function useLiveOrders(): LiveOrdersResult {
  const query = useQuery({
    queryKey: ['orders'],
    queryFn: async (): Promise<Order[]> => {
      const cfgErr = ordersConfigError();
      if (cfgErr) throw new Error(cfgErr);
      const res = await fetch(`${OS_API_URL}/api/orders?limit=100`, { headers: authHeaders() });
      if (!res.ok) throw new Error(`Server returned ${res.status}`);
      const data = (await res.json()) as { orders?: ApiOrderListItem[] };
      return (data.orders ?? []).map(mapListOrder);
    },
  });

  return {
    orders: query.data ?? [],
    loading: query.isLoading,
    refreshing: query.isFetching && !query.isLoading,
    error: query.error
      ? query.error instanceof Error
        ? query.error.message
        : 'Failed to load orders.'
      : null,
    refetch: () => { void query.refetch(); },
  };
}

export type LiveOrderResult = {
  order: Order | null;
  loading: boolean;
  error: string | null;
  refetch: () => void;
};

export function useLiveOrder(id: string | undefined): LiveOrderResult {
  const query = useQuery({
    queryKey: ['order', id],
    enabled: !!id,
    queryFn: async (): Promise<Order> => {
      const cfgErr = ordersConfigError();
      if (cfgErr) throw new Error(cfgErr);
      const res = await fetch(`${OS_API_URL}/api/orders/${encodeURIComponent(id!)}`, {
        headers: authHeaders(),
      });
      if (res.status === 404) throw new Error('Order not found');
      if (!res.ok) throw new Error(`Server returned ${res.status}`);
      const data = (await res.json()) as ApiOrderDetailResponse;
      return mapDetailOrder(data);
    },
  });

  return {
    order: query.data ?? null,
    loading: query.isLoading,
    error: query.error
      ? query.error instanceof Error
        ? query.error.message
        : 'Failed to load order.'
      : null,
    refetch: () => { void query.refetch(); },
  };
}

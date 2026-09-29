export type OrderStatus =
  | 'draft'
  | 'awaiting_payment'
  | 'paid'
  | 'sent_to_florist'
  | 'preparing'
  | 'ready_for_pickup'
  | 'with_driver'
  | 'delivered'
  | 'issue_reported'
  | 'closed';

export type PaymentStatus = 'draft' | 'awaiting_payment' | 'paid' | 'failed' | 'expired';
export type PaymentMethod = 'payment_link' | 'cash' | 'card' | 'bank_transfer' | 'already_paid';
export type OrderSource = 'whatsapp' | 'instagram' | 'phone' | 'walkin' | 'website' | 'other';
export type Language = 'en' | 'ar';
export type RefundStatus = 'pending' | 'approved' | 'rejected' | 'processed';

export interface Customer {
  id: string;
  name: string;
  phone: string;
  whatsapp?: string;
  email?: string;
  language: Language;
  isVip: boolean;
  totalOrders: number;
  lifetimeSpend: number;
  lastOrderDate?: string;
  notes?: string;
  avatar?: string;
}

export interface Recipient {
  name: string;
  phone: string;
  city: string;
  area?: string;
  address: string;
  notes?: string;
  isSameAsSender?: boolean;
}

export interface ProductVariant {
  id: string;
  name: string;
  price: number;
}

export interface Product {
  id: string;
  name: string;
  category: string;
  price: number;
  image: string;
  availability: 'available' | 'out_of_stock' | 'not_available';
  cities: string[];
  description?: string;
  variants?: ProductVariant[];
  tags?: string[];
}

export interface OrderItem {
  id: string;
  product: Product;
  quantity: number;
  variant?: ProductVariant;
  unitPrice: number;
}

export interface AddOn {
  id: string;
  name: string;
  price: number;
  quantity: number;
}

export interface DeliverySlot {
  id: string;
  dayOfWeek: number; // 0 = Sunday, 1 = Monday, ..., 6 = Saturday
  label: string;
  startTime: string;
  endTime: string;
  capacity: number;
  enabled: boolean;
}

export interface DeliveryCity {
  id: string;
  numericId: number;
  name: string;
  isActive: boolean;
  deliveryFee: number;
  freeDeliveryThreshold: number;
  freeDeliveryEnabled: boolean;
  expressAvailable: boolean;
  expressCutoffTime?: string;
  expressFee?: number;
  deliverySlots: DeliverySlot[];
}

export interface Order {
  id: string;
  orderNumber: string;
  status: OrderStatus;
  paymentStatus: PaymentStatus;
  paymentMethod?: PaymentMethod;
  source: OrderSource;
  customer: Customer;
  recipient: Recipient;
  items: OrderItem[];
  addOns: AddOn[];
  occasion?: string;
  cardMessage?: string;
  deliveryDate?: string;
  deliveryTimeSlot?: string;
  deliveryCity?: DeliveryCity;
  deliveryFee: number;
  expressFee: number;
  discount: number;
  subtotal: number;
  total: number;
  isAnonymous?: boolean;
  isUrgent: boolean;
  hasIssue: boolean;
  issueDescription?: string;
  internalNotes?: string;
  agentId: string;
  agentName: string;
  paymentLink?: string;
  createdAt: string;
  updatedAt: string;
}

export interface CannedReply {
  id: string;
  category: string;
  title: string;
  bodyEn: string;
  bodyAr?: string;
}

export interface RefundRequest {
  id: string;
  orderId: string;
  orderNumber: string;
  customerName: string;
  agentName: string;
  reasonCode: string;
  amount?: number;
  percentage?: number;
  explanation: string;
  status: RefundStatus;
  createdAt: string;
  evidence?: string;
}

export interface NewOrderDraft {
  step: number;
  customer?: Partial<Customer>;
  isNewCustomer?: boolean;
  recipient?: Partial<Recipient>;
  occasion?: string;
  items?: OrderItem[];
  addOns?: AddOn[];
  cardTo?: string;
  cardMessage?: string;
  cardFrom?: string;
  cardLanguage?: Language;
  source?: OrderSource;
  deliveryCityId?: string;
  deliveryDate?: string;
  deliveryTimeSlot?: string;
  isExpress?: boolean;
  isUrgent?: boolean;
  paymentMethod?: PaymentMethod;
  internalNotes?: string;
}

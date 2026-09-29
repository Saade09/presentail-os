import React, { useState, useMemo } from 'react';
import {
  View, Text, StyleSheet, ScrollView, TouchableOpacity,
  TextInput, Platform, KeyboardAvoidingView,
} from 'react-native';
import { Feather } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { router, useLocalSearchParams } from 'expo-router';
import { useColors } from '@/hooks/useColors';
import { ProductCard } from '@/components/ProductCard';
import {
  CUSTOMERS, PRODUCTS, PRODUCT_CATEGORIES, OCCASIONS,
  ADD_ONS,
} from '@/data/mock';
import { useLiveDeliveryCities } from '@/lib/api';
import type { NewOrderDraft, OrderItem, AddOn, OrderSource, DeliveryCity } from '@/types';
import { DeliverySchedulerPopover } from '@/components/DeliverySchedulerPopover';

const SOURCES: { label: string; value: OrderSource }[] = [
  { label: 'WhatsApp', value: 'whatsapp' },
  { label: 'Instagram', value: 'instagram' },
  { label: 'Phone', value: 'phone' },
  { label: 'Walk-in', value: 'walkin' },
  { label: 'Website', value: 'website' },
  { label: 'Other', value: 'other' },
];

const PAYMENT_METHODS = [
  { label: 'Payment Link', value: 'payment_link', icon: 'link' as const },
  { label: 'Cash', value: 'cash', icon: 'dollar-sign' as const },
  { label: 'Card', value: 'card', icon: 'credit-card' as const },
  { label: 'Already Paid', value: 'already_paid', icon: 'check-circle' as const },
];

const initialDraft: NewOrderDraft = {
  step: 1,
  customer: {},
  recipient: {},
  items: [],
  addOns: [],
  source: 'whatsapp',
  paymentMethod: 'payment_link',
  isExpress: false,
  isUrgent: false,
  cardLanguage: 'en',
  deliveryDate: undefined,
  deliveryTimeSlot: undefined,
};

const TOTAL_STEPS = 5;
const STEP_LABELS = ['Customer', 'Recipient', 'Products', 'Details', 'Review'];

export default function NewOrderScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const topPad = Platform.OS === 'web' ? 67 : insets.top;
  const bottomPad = Platform.OS === 'web' ? 34 : insets.bottom;
  const params = useLocalSearchParams<{ items?: string; addOns?: string; prefillProduct?: string }>();
  const [draft, setDraft] = useState<NewOrderDraft>(() => {
    if (params.prefillProduct === 'true' && params.items) {
      try {
        const parsedItems = JSON.parse(params.items) as OrderItem[];
        const parsedAddOns = params.addOns ? JSON.parse(params.addOns) as AddOn[] : [];
        return { ...initialDraft, step: 3, items: parsedItems, addOns: parsedAddOns };
      } catch {
        return initialDraft;
      }
    }
    return initialDraft;
  });
  const [catFilter, setCatFilter] = useState('All');
  const { cities, loading: citiesLoading, error: citiesError } = useLiveDeliveryCities();

  const update = (partial: Partial<NewOrderDraft>) => setDraft(prev => ({ ...prev, ...partial }));
  const goNext = () => { Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light); update({ step: Math.min(draft.step + 1, TOTAL_STEPS) }); };
  const goBack = () => {
    if (draft.step === 1) { router.back(); return; }
    update({ step: draft.step - 1 });
  };

  const addItem = (productId: string) => {
    const product = PRODUCTS.find(p => p.id === productId);
    if (!product) return;
    const existing = draft.items?.find(i => i.product.id === productId);
    if (existing) {
      update({ items: draft.items?.map(i => i.product.id === productId ? { ...i, quantity: i.quantity + 1 } : i) });
    } else {
      const newItem: OrderItem = { id: `oi-${Date.now()}`, product, quantity: 1, unitPrice: product.price };
      update({ items: [...(draft.items ?? []), newItem] });
    }
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
  };

  const removeItem = (productId: string) => update({ items: draft.items?.filter(i => i.product.id !== productId) });

  const toggleAddOn = (addOnId: string) => {
    const found = draft.addOns?.find(a => a.id === addOnId);
    const src = ADD_ONS.find(a => a.id === addOnId);
    if (!src) return;
    if (found) {
      update({ addOns: draft.addOns?.filter(a => a.id !== addOnId) });
    } else {
      update({ addOns: [...(draft.addOns ?? []), { ...src, quantity: 1 }] });
    }
  };

  const subtotal = (draft.items ?? []).reduce((s, i) => s + i.unitPrice * i.quantity, 0) +
    (draft.addOns ?? []).reduce((s, a) => s + a.price * a.quantity, 0);
  const city = cities.find(c => c.id === draft.deliveryCityId);
  const deliveryFee = city ? (city.freeDeliveryEnabled && subtotal >= city.freeDeliveryThreshold ? 0 : city.deliveryFee) : 0;
  const expressFee = draft.isExpress && city?.expressAvailable ? (city.expressFee ?? 0) : 0;
  const total = subtotal + deliveryFee + expressFee;

  const step = draft.step;
  const isLast = step === TOTAL_STEPS;
  const isValid = step !== 4 || (!!draft.deliveryDate && !!draft.deliveryTimeSlot);

  return (
    <View style={[styles.container, { backgroundColor: colors.background }]}>
      {/* Header */}
      <View style={[styles.header, { paddingTop: topPad + 8, backgroundColor: colors.card, borderBottomColor: colors.border }]}>
        <View style={styles.headerRow}>
          <TouchableOpacity onPress={goBack} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
            <Feather name={step === 1 ? 'x' : 'arrow-left'} size={22} color={colors.foreground} />
          </TouchableOpacity>
          <Text style={[styles.stepTitle, { color: colors.foreground }]}>
            {STEP_LABELS[step - 1]}
          </Text>
          <Text style={[styles.stepCount, { color: colors.mutedForeground }]}>{step}/{TOTAL_STEPS}</Text>
        </View>
        {/* Progress bar */}
        <View style={[styles.progressTrack, { backgroundColor: colors.border }]}>
          <View style={[styles.progressFill, { backgroundColor: colors.primary, width: `${(step / TOTAL_STEPS) * 100}%` }]} />
        </View>
      </View>

      {/* Sticky cart summary */}
      {(subtotal > 0) && (
        <View style={[styles.cartSummary, { backgroundColor: colors.card, borderBottomColor: colors.border }]}>
          <View style={styles.cartSummaryRow}>
            <View style={styles.cartSummaryLeft}>
              <Feather name="shopping-cart" size={14} color={colors.primary} />
              <Text style={[styles.cartSummaryText, { color: colors.foreground }]}>
                {(draft.items ?? []).reduce((n, i) => n + i.quantity, 0)} item{(draft.items ?? []).reduce((n, i) => n + i.quantity, 0) !== 1 ? 's' : ''}
              </Text>
            </View>
            <Text style={[styles.cartSummaryTotal, { color: colors.foreground }]}>AED {total.toFixed(0)}</Text>
          </View>
        </View>
      )}

      <KeyboardAvoidingView style={styles.body} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <ScrollView style={styles.scroll} contentContainerStyle={[styles.bodyContent, { paddingBottom: bottomPad + 100 }]} showsVerticalScrollIndicator={false}>
          {step === 1 && <StepCustomer draft={draft} update={update} colors={colors} />}
          {step === 2 && <StepRecipient draft={draft} update={update} colors={colors} cities={cities} citiesLoading={citiesLoading} citiesError={citiesError} />}
          {step === 3 && <StepProducts draft={draft} addItem={addItem} removeItem={removeItem} catFilter={catFilter} setCatFilter={setCatFilter} colors={colors} />}
          {step === 4 && <StepDetails draft={draft} update={update} colors={colors} city={city} deliveryFee={deliveryFee} expressFee={expressFee} total={total} />}
          {step === 5 && <StepReview draft={draft} subtotal={subtotal} deliveryFee={deliveryFee} expressFee={expressFee} total={total} city={city} colors={colors} />}
        </ScrollView>
      </KeyboardAvoidingView>

      {/* Bottom nav */}
      <View style={[styles.bottomNav, { backgroundColor: colors.card, borderTopColor: colors.border, paddingBottom: bottomPad + 8 }]}>
        {step > 1 && (
          <TouchableOpacity style={[styles.backBtn, { borderColor: colors.border }]} onPress={goBack}>
            <Feather name="arrow-left" size={18} color={colors.foreground} />
          </TouchableOpacity>
        )}
        <TouchableOpacity
          style={[styles.nextBtn, { backgroundColor: isValid ? colors.primary : colors.border, flex: step > 1 ? 0.75 : 1, opacity: isValid ? 1 : 0.6 }]}
          onPress={isValid ? (isLast ? () => { Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success); router.replace('/(tabs)/' as never); } : goNext) : undefined}
          disabled={!isValid}
        >
          <Text style={styles.nextBtnText}>{isLast ? 'Submit Order' : 'Continue'}</Text>
          <Feather name={isLast ? 'check' : 'arrow-right'} size={18} color="#fff" />
        </TouchableOpacity>
      </View>
    </View>
  );
}

// ---- Field helpers ----

function Field({ label, children, colors }: { label: string; children: React.ReactNode; colors: any }) {
  return (
    <View style={fStyles.field}>
      <Text style={[fStyles.label, { color: colors.mutedForeground }]}>{label}</Text>
      {children}
    </View>
  );
}

function TInput({ value, onChangeText, placeholder, colors, keyboardType, multiline }: {
  value: string; onChangeText: (t: string) => void;
  placeholder?: string; colors: any;
  keyboardType?: 'default' | 'phone-pad' | 'email-address';
  multiline?: boolean;
}) {
  return (
    <TextInput
      style={[fStyles.input, { borderColor: colors.border, backgroundColor: colors.card, color: colors.foreground, ...(multiline ? { height: 64, textAlignVertical: 'top' } : {}) }]}
      value={value}
      onChangeText={onChangeText}
      placeholder={placeholder}
      placeholderTextColor={colors.mutedForeground}
      keyboardType={keyboardType}
      multiline={multiline}
    />
  );
}

// ---- Step 1: Customer (compact) ----
function StepCustomer({ draft, update, colors }: { draft: NewOrderDraft; update: (p: Partial<NewOrderDraft>) => void; colors: any }) {
  const [phoneSearch, setPhoneSearch] = useState('');
  const found = phoneSearch.length > 5 ? CUSTOMERS.find(c => c.phone.includes(phoneSearch)) : null;

  return (
    <View style={fStyles.step}>
      <Field label="Search by phone" colors={colors}>
        <TInput value={phoneSearch} onChangeText={setPhoneSearch} placeholder="+971..." colors={colors} keyboardType="phone-pad" />
      </Field>
      {found && (
        <TouchableOpacity
          style={[fStyles.foundCard, { backgroundColor: colors.primary + '10', borderColor: colors.primary }]}
          onPress={() => { update({ customer: found, isNewCustomer: false }); setPhoneSearch(''); }}
        >
          <View style={{ flex: 1 }}>
            <Text style={[fStyles.foundName, { color: colors.foreground }]}>{found.name} {found.isVip ? '⭐' : ''}</Text>
            <Text style={[fStyles.foundMeta, { color: colors.mutedForeground }]}>{found.phone} · {found.totalOrders} orders · AED {found.lifetimeSpend}</Text>
          </View>
          <Feather name="user-check" size={18} color={colors.primary} />
        </TouchableOpacity>
      )}
      <Field label="Full Name" colors={colors}>
        <TInput value={draft.customer?.name ?? ''} onChangeText={v => update({ customer: { ...draft.customer, name: v } })} placeholder="Sender's name" colors={colors} />
      </Field>
      <Field label="Phone" colors={colors}>
        <TInput value={draft.customer?.phone ?? ''} onChangeText={v => update({ customer: { ...draft.customer, phone: v } })} placeholder="+971..." colors={colors} keyboardType="phone-pad" />
      </Field>
      <Field label="Order Source" colors={colors}>
        <View style={fStyles.chipRow}>
          {SOURCES.map(s => (
            <TouchableOpacity
              key={s.value}
              style={[fStyles.chip, { backgroundColor: draft.source === s.value ? colors.primary : colors.secondary, borderColor: draft.source === s.value ? colors.primary : colors.border }]}
              onPress={() => update({ source: s.value })}
            >
              <Text style={[fStyles.chipText, { color: draft.source === s.value ? '#fff' : colors.mutedForeground }]}>{s.label}</Text>
            </TouchableOpacity>
          ))}
        </View>
      </Field>
    </View>
  );
}

// ---- Step 2: Recipient (compact) ----
function StepRecipient({ draft, update, colors, cities, citiesLoading, citiesError }: {
  draft: NewOrderDraft; update: (p: Partial<NewOrderDraft>) => void; colors: any;
  cities: any[]; citiesLoading: boolean; citiesError: string | null;
}) {
  return (
    <View style={fStyles.step}>
      <TouchableOpacity
        style={[fStyles.sameAsSenderToggle, { backgroundColor: draft.recipient?.isSameAsSender ? colors.primary + '12' : colors.secondary, borderColor: draft.recipient?.isSameAsSender ? colors.primary : colors.border }]}
        onPress={() => update({ recipient: { ...draft.recipient, isSameAsSender: !draft.recipient?.isSameAsSender, name: !draft.recipient?.isSameAsSender ? draft.customer?.name ?? '' : '', phone: !draft.recipient?.isSameAsSender ? draft.customer?.phone ?? '' : '' } })}
      >
        <Feather name={draft.recipient?.isSameAsSender ? 'check-square' : 'square'} size={16} color={draft.recipient?.isSameAsSender ? colors.primary : colors.mutedForeground} />
        <Text style={[fStyles.chipText, { color: draft.recipient?.isSameAsSender ? colors.primary : colors.foreground }]}>Same as sender</Text>
      </TouchableOpacity>
      {!draft.recipient?.isSameAsSender && (
        <>
          <Field label="Recipient Name" colors={colors}>
            <TInput value={draft.recipient?.name ?? ''} onChangeText={v => update({ recipient: { ...draft.recipient, name: v } })} placeholder="Recipient's name" colors={colors} />
          </Field>
          <Field label="Recipient Phone" colors={colors}>
            <TInput value={draft.recipient?.phone ?? ''} onChangeText={v => update({ recipient: { ...draft.recipient, phone: v } })} placeholder="+971..." colors={colors} keyboardType="phone-pad" />
          </Field>
        </>
      )}
      <Field label="City" colors={colors}>
        {citiesLoading && (
          <View style={[fStyles.citiesLoading, { backgroundColor: colors.secondary, borderColor: colors.border }]}>
            <Text style={[fStyles.chipText, { color: colors.mutedForeground }]}>Loading cities...</Text>
          </View>
        )}
        {!citiesLoading && citiesError && (
          <View style={[fStyles.citiesLoading, { backgroundColor: '#fee2e2', borderColor: '#fca5a5' }]}>
            <Text style={[fStyles.chipText, { color: '#991b1b' }]}>Could not load cities</Text>
          </View>
        )}
        {!citiesLoading && !citiesError && (
          <View style={fStyles.chipRow}>
            {cities.filter(c => c.isActive).map(c => (
              <TouchableOpacity key={c.id}
                style={[fStyles.chip, { backgroundColor: draft.deliveryCityId === c.id ? colors.primary : colors.secondary, borderColor: draft.deliveryCityId === c.id ? colors.primary : colors.border }]}
                onPress={() => { update({ deliveryCityId: c.id, recipient: { ...draft.recipient, city: c.name } }); }}
              >
                <Text style={[fStyles.chipText, { color: draft.deliveryCityId === c.id ? '#fff' : colors.mutedForeground }]}>{c.name}</Text>
              </TouchableOpacity>
            ))}
          </View>
        )}
      </Field>
      <Field label="Area" colors={colors}>
        <TInput value={draft.recipient?.area ?? ''} onChangeText={v => update({ recipient: { ...draft.recipient, area: v } })} placeholder="e.g. Jumeirah, Marina" colors={colors} />
      </Field>
      <Field label="Full Address" colors={colors}>
        <TInput value={draft.recipient?.address ?? ''} onChangeText={v => update({ recipient: { ...draft.recipient, address: v } })} placeholder="Building, street, apartment..." colors={colors} multiline />
      </Field>
    </View>
  );
}

// ---- Step 3: Products (compact) ----
function StepProducts({ draft, addItem, removeItem, catFilter, setCatFilter, colors }: {
  draft: NewOrderDraft; addItem: (id: string) => void; removeItem: (id: string) => void;
  catFilter: string; setCatFilter: (c: string) => void; colors: any;
}) {
  const filtered = catFilter === 'All' ? PRODUCTS : PRODUCTS.filter(p => p.category === catFilter);
  return (
    <View style={fStyles.step}>
      {(draft.items ?? []).length > 0 && (
        <View style={[fStyles.cartBox, { backgroundColor: colors.primary + '08', borderColor: colors.primary + '20' }]}>
          <View style={fStyles.cartHeader}>
            <Text style={[fStyles.cartTitle, { color: colors.primary }]}>In Cart</Text>
            <Text style={[fStyles.cartCount, { color: colors.primary }]}>{(draft.items ?? []).reduce((n, i) => n + i.quantity, 0)} items</Text>
          </View>
          {(draft.items ?? []).map(item => (
            <View key={item.id} style={fStyles.cartItem}>
              <Text style={[fStyles.cartName, { color: colors.foreground }]}>{item.product.name} × {item.quantity}</Text>
              <View style={fStyles.cartControls}>
                <Text style={[fStyles.cartPrice, { color: colors.mutedForeground }]}>AED {item.unitPrice * item.quantity}</Text>
                <TouchableOpacity onPress={() => removeItem(item.product.id)} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
                  <Feather name="x" size={16} color={colors.destructive} />
                </TouchableOpacity>
              </View>
            </View>
          ))}
        </View>
      )}
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={fStyles.catRow}>
        {PRODUCT_CATEGORIES.map(cat => (
          <TouchableOpacity key={cat}
            style={[fStyles.chip, { backgroundColor: catFilter === cat ? colors.primary : colors.secondary, borderColor: catFilter === cat ? colors.primary : colors.border }]}
            onPress={() => setCatFilter(cat)}
          >
            <Text style={[fStyles.chipText, { color: catFilter === cat ? '#fff' : colors.mutedForeground }]}>{cat}</Text>
          </TouchableOpacity>
        ))}
      </ScrollView>
      <View style={fStyles.productGrid}>
        {filtered.map(p => (
          <ProductCard key={p.id} product={p} onAdd={() => addItem(p.id)} showAdd />
        ))}
      </View>
    </View>
  );
}

// ---- Step 4: Details (occasion + message + delivery + payment) ----
function StepDetails({ draft, update, colors, city, deliveryFee, expressFee, total }: {
  draft: NewOrderDraft; update: (p: Partial<NewOrderDraft>) => void;
  colors: any; city: DeliveryCity | undefined; deliveryFee: number; expressFee: number; total: number;
}) {
  const [popoverVisible, setPopoverVisible] = useState(false);

  const deliveryDayDisplay = draft.deliveryDate
    ? (() => {
        const parts = draft.deliveryDate.split('-');
        if (parts.length !== 3) return draft.deliveryDate;
        const y = parseInt(parts[0]!, 10);
        const m = parseInt(parts[1]!, 10) - 1;
        const d = parseInt(parts[2]!, 10);
        const date = new Date(y, m, d);
        const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
        const monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
        return `${dayNames[date.getDay()]}, ${d} ${monthNames[date.getMonth()]}`;
      })()
    : '';

  return (
    <View style={fStyles.step}>
      {/* Occasion */}
      <Field label="Occasion" colors={colors}>
        <View style={fStyles.occasionGrid}>
          {OCCASIONS.map(occ => (
            <TouchableOpacity
              key={occ}
              style={[fStyles.occasionTile, { backgroundColor: draft.occasion === occ ? colors.primary : colors.card, borderColor: draft.occasion === occ ? colors.primary : colors.border }]}
              onPress={() => { update({ occasion: occ }); Haptics.selectionAsync(); }}
            >
              <Text style={[fStyles.occasionText, { color: draft.occasion === occ ? '#fff' : colors.foreground }]}>{occ}</Text>
            </TouchableOpacity>
          ))}
        </View>
      </Field>

      {/* Add-ons */}
      <Field label="Add-ons" colors={colors}>
        {ADD_ONS.map(ao => {
          const selected = draft.addOns?.some(a => a.id === ao.id);
          return (
            <TouchableOpacity key={ao.id}
              style={[fStyles.addOnRow, { backgroundColor: selected ? colors.primary + '08' : colors.card, borderColor: selected ? colors.primary : colors.border }]}
              onPress={() => {
                const found = draft.addOns?.find(a => a.id === ao.id);
                if (found) {
                  update({ addOns: draft.addOns?.filter(a => a.id !== ao.id) });
                } else {
                  update({ addOns: [...(draft.addOns ?? []), { ...ao, quantity: 1 }] });
                }
              }}
            >
              <View style={[fStyles.addOnCheck, { backgroundColor: selected ? colors.primary : colors.secondary, borderColor: selected ? colors.primary : colors.border }]}>
                {selected && <Feather name="check" size={12} color="#fff" />}
              </View>
              <Text style={[fStyles.addOnName, { color: colors.foreground, flex: 1 }]}>{ao.name}</Text>
              <Text style={[fStyles.addOnPrice, { color: colors.mutedForeground }]}>AED {ao.price}</Text>
            </TouchableOpacity>
          );
        })}
      </Field>

      {/* Card Message */}
      <Field label="Card Message" colors={colors}>
        <View style={fStyles.langToggle}>
          {(['en', 'ar'] as const).map(lang => (
            <TouchableOpacity key={lang}
              style={[fStyles.langBtn, { backgroundColor: draft.cardLanguage === lang ? colors.primary : colors.secondary, borderColor: draft.cardLanguage === lang ? colors.primary : colors.border }]}
              onPress={() => update({ cardLanguage: lang })}
            >
              <Text style={[fStyles.langText, { color: draft.cardLanguage === lang ? '#fff' : colors.mutedForeground }]}>{lang === 'en' ? 'English' : 'Arabic'}</Text>
            </TouchableOpacity>
          ))}
        </View>
        <TextInput
          style={[fStyles.input, { borderColor: colors.border, backgroundColor: colors.card, color: colors.foreground }]}
          value={draft.cardTo ?? ''}
          onChangeText={v => update({ cardTo: v })}
          placeholder="Recipient name"
          placeholderTextColor={colors.mutedForeground}
        />
        <TextInput
          style={[fStyles.messageInput, { borderColor: colors.border, backgroundColor: colors.card, color: colors.foreground, textAlign: draft.cardLanguage === 'ar' ? 'right' : 'left' }]}
          value={draft.cardMessage ?? ''}
          onChangeText={v => update({ cardMessage: v })}
          placeholder={draft.cardLanguage === 'ar' ? 'اكتب رسالتك للمستلم...' : 'Write a message for the recipient…'}
          placeholderTextColor={colors.mutedForeground}
          multiline
          maxLength={300}
        />
        <TextInput
          style={[fStyles.input, { borderColor: colors.border, backgroundColor: colors.card, color: colors.foreground }]}
          value={draft.cardFrom ?? ''}
          onChangeText={v => update({ cardFrom: v })}
          placeholder="Sender name"
          placeholderTextColor={colors.mutedForeground}
        />
        <Text style={[fStyles.charCount, { color: colors.mutedForeground }]}>{(draft.cardMessage ?? '').length}/300</Text>
      </Field>

      {/* Delivery */}
      <Field label="Delivery" colors={colors}>
        <View style={fStyles.deliveryRow}>
          <TouchableOpacity
            style={[fStyles.deliveryOption, { backgroundColor: !draft.isExpress ? colors.primary : colors.secondary, borderColor: !draft.isExpress ? colors.primary : colors.border }]}
            onPress={() => update({ isExpress: false })}
          >
            <Feather name="truck" size={14} color={!draft.isExpress ? '#fff' : colors.mutedForeground} />
            <Text style={{ color: !draft.isExpress ? '#fff' : colors.mutedForeground, fontSize: 12, fontFamily: 'Inter_600SemiBold' }}>Standard</Text>
            <Text style={{ color: !draft.isExpress ? '#fff' : colors.mutedForeground, fontSize: 11, fontFamily: 'Inter_400Regular' }}>
              {deliveryFee === 0 ? 'Free' : `AED ${deliveryFee}`}
            </Text>
          </TouchableOpacity>
          {city?.expressAvailable && (
            <TouchableOpacity
              style={[fStyles.deliveryOption, { backgroundColor: draft.isExpress ? colors.primary : colors.secondary, borderColor: draft.isExpress ? colors.primary : colors.border }]}
              onPress={() => update({ isExpress: true })}
            >
              <Feather name="zap" size={14} color={draft.isExpress ? '#fff' : colors.mutedForeground} />
              <Text style={{ color: draft.isExpress ? '#fff' : colors.mutedForeground, fontSize: 12, fontFamily: 'Inter_600SemiBold' }}>Express</Text>
              <Text style={{ color: draft.isExpress ? '#fff' : colors.mutedForeground, fontSize: 11, fontFamily: 'Inter_400Regular' }}>
                AED {expressFee} {city?.expressCutoffTime ? `· before ${city.expressCutoffTime}` : ''}
              </Text>
            </TouchableOpacity>
          )}
        </View>
        {/* Delivery day & time trigger fields */}
        <View style={fStyles.schedulerRow}>
          <TouchableOpacity
            style={[fStyles.schedulerField, { borderColor: draft.deliveryDate ? '#0D9488' : colors.border, backgroundColor: colors.card }]}
            onPress={() => setPopoverVisible(true)}
            accessibilityLabel="Select delivery day"
            accessibilityRole="button"
          >
            <Feather name="calendar" size={14} color={draft.deliveryDate ? '#0D9488' : colors.mutedForeground} />
            <Text style={{ fontSize: 12, fontFamily: 'Inter_600SemiBold', color: draft.deliveryDate ? '#0D9488' : colors.mutedForeground, flex: 1 }} numberOfLines={1}>
              {deliveryDayDisplay || 'Delivery day'}
            </Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={[fStyles.schedulerField, { borderColor: draft.deliveryTimeSlot ? '#0D9488' : colors.border, backgroundColor: colors.card }]}
            onPress={() => setPopoverVisible(true)}
            accessibilityLabel="Select delivery time"
            accessibilityRole="button"
          >
            <Feather name="clock" size={14} color={draft.deliveryTimeSlot ? '#0D9488' : colors.mutedForeground} />
            <Text style={{ fontSize: 12, fontFamily: 'Inter_600SemiBold', color: draft.deliveryTimeSlot ? '#0D9488' : colors.mutedForeground, flex: 1 }} numberOfLines={1}>
              {draft.deliveryTimeSlot || 'Delivery time'}
            </Text>
          </TouchableOpacity>
        </View>
        {!draft.deliveryDate && !draft.deliveryTimeSlot && (
          <Text style={{ fontSize: 11, fontFamily: 'Inter_400Regular', color: colors.mutedForeground, marginTop: 2 }}>
            Tap either field to open the scheduler
          </Text>
        )}
      </Field>

      <DeliverySchedulerPopover
        visible={popoverVisible}
        onClose={() => setPopoverVisible(false)}
        onConfirm={(date, slot) => {
          update({ deliveryDate: date, deliveryTimeSlot: slot });
          setPopoverVisible(false);
        }}
        city={city}
        initialDate={draft.deliveryDate}
        initialSlot={draft.deliveryTimeSlot}
      />

      {/* Payment */}
      <Field label="Payment Method" colors={colors}>
        <View style={fStyles.paymentGrid}>
          {PAYMENT_METHODS.map(pm => (
            <TouchableOpacity
              key={pm.value}
              style={[fStyles.paymentTile, { backgroundColor: draft.paymentMethod === pm.value ? colors.primary : colors.card, borderColor: draft.paymentMethod === pm.value ? colors.primary : colors.border }]}
              onPress={() => update({ paymentMethod: pm.value as import('../../types').PaymentMethod })}
            >
              <Feather name={pm.icon} size={16} color={draft.paymentMethod === pm.value ? '#fff' : colors.mutedForeground} />
              <Text style={{ color: draft.paymentMethod === pm.value ? '#fff' : colors.foreground, fontSize: 12, fontFamily: 'Inter_600SemiBold', marginTop: 4 }}>{pm.label}</Text>
            </TouchableOpacity>
          ))}
        </View>
      </Field>

      {/* Urgent toggle */}
      <TouchableOpacity
        style={[fStyles.urgentToggle, { backgroundColor: draft.isUrgent ? colors.destructive + '10' : colors.card, borderColor: draft.isUrgent ? colors.destructive : colors.border }]}
        onPress={() => update({ isUrgent: !draft.isUrgent })}
      >
        <Feather name={draft.isUrgent ? 'alert-circle' : 'circle'} size={16} color={draft.isUrgent ? colors.destructive : colors.mutedForeground} />
        <Text style={{ color: draft.isUrgent ? colors.destructive : colors.foreground, fontSize: 13, fontFamily: 'Inter_600SemiBold' }}>Mark as Urgent</Text>
      </TouchableOpacity>
    </View>
  );
}

// ---- Step 5: Review ----
function StepReview({ draft, subtotal, deliveryFee, expressFee, total, city, colors }: {
  draft: NewOrderDraft; subtotal: number; deliveryFee: number; expressFee: number; total: number;
  city: any; colors: any;
}) {
  return (
    <View style={fStyles.step}>
      <View style={[fStyles.reviewCard, { backgroundColor: colors.card, borderColor: colors.border }]}>
        <Text style={[fStyles.reviewTitle, { color: colors.foreground }]}>Order Summary</Text>

        <View style={fStyles.reviewRow}>
          <Text style={[fStyles.reviewLabel, { color: colors.mutedForeground }]}>Customer</Text>
          <Text style={[fStyles.reviewValue, { color: colors.foreground }]}>{draft.customer?.name ?? '—'}</Text>
        </View>
        <View style={fStyles.reviewRow}>
          <Text style={[fStyles.reviewLabel, { color: colors.mutedForeground }]}>Phone</Text>
          <Text style={[fStyles.reviewValue, { color: colors.foreground }]}>{draft.customer?.phone ?? '—'}</Text>
        </View>
        <View style={fStyles.reviewRow}>
          <Text style={[fStyles.reviewLabel, { color: colors.mutedForeground }]}>Recipient</Text>
          <Text style={[fStyles.reviewValue, { color: colors.foreground }]}>{draft.recipient?.isSameAsSender ? 'Same as sender' : (draft.recipient?.name ?? '—')}</Text>
        </View>
        <View style={fStyles.reviewRow}>
          <Text style={[fStyles.reviewLabel, { color: colors.mutedForeground }]}>City</Text>
          <Text style={[fStyles.reviewValue, { color: colors.foreground }]}>{draft.recipient?.city ?? '—'}</Text>
        </View>
        <View style={fStyles.reviewRow}>
          <Text style={[fStyles.reviewLabel, { color: colors.mutedForeground }]}>Address</Text>
          <Text style={[fStyles.reviewValue, { color: colors.foreground }]}>{draft.recipient?.address ?? '—'}</Text>
        </View>
        <View style={fStyles.reviewRow}>
          <Text style={[fStyles.reviewLabel, { color: colors.mutedForeground }]}>Occasion</Text>
          <Text style={[fStyles.reviewValue, { color: colors.foreground }]}>{draft.occasion ?? '—'}</Text>
        </View>
        <View style={fStyles.reviewRow}>
          <Text style={[fStyles.reviewLabel, { color: colors.mutedForeground }]}>Delivery mode</Text>
          <Text style={[fStyles.reviewValue, { color: colors.foreground }]}>{draft.isExpress ? 'Express' : 'Standard'}</Text>
        </View>
        <View style={fStyles.reviewRow}>
          <Text style={[fStyles.reviewLabel, { color: colors.mutedForeground }]}>Delivery date</Text>
          <Text style={[fStyles.reviewValue, { color: colors.foreground }]}>
            {draft.deliveryDate
              ? (() => {
                  const parts = draft.deliveryDate.split('-');
                  if (parts.length !== 3) return draft.deliveryDate;
                  const y = parseInt(parts[0]!, 10);
                  const m = parseInt(parts[1]!, 10) - 1;
                  const d = parseInt(parts[2]!, 10);
                  const date = new Date(y, m, d);
                  const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
                  const monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
                  return `${dayNames[date.getDay()]}, ${d} ${monthNames[date.getMonth()]}`;
                })()
              : '—'}
          </Text>
        </View>
        <View style={fStyles.reviewRow}>
          <Text style={[fStyles.reviewLabel, { color: colors.mutedForeground }]}>Delivery time</Text>
          <Text style={[fStyles.reviewValue, { color: colors.foreground }]}>{draft.deliveryTimeSlot ?? '—'}</Text>
        </View>
        <View style={fStyles.reviewRow}>
          <Text style={[fStyles.reviewLabel, { color: colors.mutedForeground }]}>Payment</Text>
          <Text style={[fStyles.reviewValue, { color: colors.foreground }]}>{PAYMENT_METHODS.find(p => p.value === draft.paymentMethod)?.label ?? '—'}</Text>
        </View>
        {draft.isUrgent && (
          <View style={[fStyles.urgentBadge, { backgroundColor: colors.destructive + '12' }]}>
            <Feather name="alert-circle" size={12} color={colors.destructive} />
            <Text style={{ color: colors.destructive, fontSize: 12, fontFamily: 'Inter_600SemiBold' }}>Urgent Order</Text>
          </View>
        )}
      </View>

      {/* Card Message */}
      {(draft.cardTo || draft.cardMessage || draft.cardFrom) && (
        <View style={[fStyles.reviewCard, { backgroundColor: colors.card, borderColor: colors.border }]}>
          <Text style={[fStyles.reviewTitle, { color: colors.foreground }]}>Card Message</Text>
          {!!draft.cardTo && (
            <View style={fStyles.reviewRow}>
              <Text style={[fStyles.reviewLabel, { color: colors.mutedForeground }]}>To</Text>
              <Text style={[fStyles.reviewValue, { color: colors.foreground }]}>{draft.cardTo}</Text>
            </View>
          )}
          {!!draft.cardMessage && (
            <View style={fStyles.reviewRow}>
              <Text style={[fStyles.reviewLabel, { color: colors.mutedForeground }]}>Message</Text>
              <Text style={[fStyles.reviewValue, { color: colors.foreground, flexShrink: 1 }]}>{draft.cardMessage}</Text>
            </View>
          )}
          {!!draft.cardFrom && (
            <View style={fStyles.reviewRow}>
              <Text style={[fStyles.reviewLabel, { color: colors.mutedForeground }]}>From</Text>
              <Text style={[fStyles.reviewValue, { color: colors.foreground }]}>{draft.cardFrom}</Text>
            </View>
          )}
        </View>
      )}

      {/* Items */}
      {(draft.items ?? []).length > 0 && (
        <View style={[fStyles.reviewCard, { backgroundColor: colors.card, borderColor: colors.border }]}>
          <Text style={[fStyles.reviewTitle, { color: colors.foreground }]}>Items</Text>
          {(draft.items ?? []).map(item => (
            <View key={item.id} style={fStyles.reviewItemRow}>
              <Text style={[fStyles.reviewItemName, { color: colors.foreground }]}>{item.product.name} × {item.quantity}</Text>
              <Text style={[fStyles.reviewItemPrice, { color: colors.mutedForeground }]}>AED {item.unitPrice * item.quantity}</Text>
            </View>
          ))}
          {(draft.addOns ?? []).length > 0 && (draft.addOns ?? []).map(ao => (
            <View key={ao.id} style={fStyles.reviewItemRow}>
              <Text style={[fStyles.reviewItemName, { color: colors.foreground }]}>{ao.name} × {ao.quantity}</Text>
              <Text style={[fStyles.reviewItemPrice, { color: colors.mutedForeground }]}>AED {ao.price * ao.quantity}</Text>
            </View>
          ))}
        </View>
      )}

      {/* Totals */}
      <View style={[fStyles.reviewCard, { backgroundColor: colors.card, borderColor: colors.border }]}>
        <View style={fStyles.reviewItemRow}>
          <Text style={[fStyles.reviewItemName, { color: colors.mutedForeground }]}>Subtotal</Text>
          <Text style={[fStyles.reviewItemPrice, { color: colors.foreground }]}>AED {subtotal.toFixed(0)}</Text>
        </View>
        <View style={fStyles.reviewItemRow}>
          <Text style={[fStyles.reviewItemName, { color: colors.mutedForeground }]}>Delivery</Text>
          <Text style={[fStyles.reviewItemPrice, { color: colors.foreground }]}>{deliveryFee === 0 ? 'Free' : `AED ${deliveryFee.toFixed(0)}`}</Text>
        </View>
        {expressFee > 0 && (
          <View style={fStyles.reviewItemRow}>
            <Text style={[fStyles.reviewItemName, { color: colors.mutedForeground }]}>Express</Text>
            <Text style={[fStyles.reviewItemPrice, { color: colors.foreground }]}>AED {expressFee.toFixed(0)}</Text>
          </View>
        )}
        <View style={[fStyles.reviewItemRow, { marginTop: 8, paddingTop: 8, borderTopWidth: 1, borderTopColor: colors.border }]}>
          <Text style={[fStyles.reviewTotalLabel, { color: colors.foreground }]}>Total</Text>
          <Text style={[fStyles.reviewTotal, { color: colors.primary }]}>AED {total.toFixed(0)}</Text>
        </View>
      </View>
    </View>
  );
}

// ---- Styles ----
const styles = StyleSheet.create({
  container: { flex: 1 },
  header: {
    paddingHorizontal: 16,
    paddingBottom: 10,
    borderBottomWidth: 1,
    gap: 6,
  },
  headerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  stepTitle: { fontSize: 17, fontFamily: 'Inter_700Bold' },
  stepCount: { fontSize: 13, fontFamily: 'Inter_600SemiBold' },
  progressTrack: {
    height: 3,
    borderRadius: 2,
    overflow: 'hidden',
  },
  progressFill: {
    height: '100%',
    borderRadius: 2,
  },
  cartSummary: {
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderBottomWidth: 1,
  },
  cartSummaryRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  cartSummaryLeft: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  cartSummaryText: { fontSize: 13, fontFamily: 'Inter_600SemiBold' },
  cartSummaryTotal: { fontSize: 14, fontFamily: 'Inter_700Bold' },
  body: { flex: 1 },
  scroll: { flex: 1 },
  bodyContent: { padding: 14 },
  bottomNav: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingHorizontal: 14,
    paddingTop: 10,
    borderTopWidth: 1,
  },
  backBtn: {
    width: 44,
    height: 44,
    borderRadius: 12,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  nextBtn: {
    height: 44,
    borderRadius: 12,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
  },
  nextBtnText: {
    color: '#fff',
    fontSize: 15,
    fontFamily: 'Inter_700Bold',
  },
});

const fStyles = StyleSheet.create({
  step: { gap: 10 },
  field: { gap: 4 },
  label: { fontSize: 12, fontFamily: 'Inter_600SemiBold' },
  input: {
    borderWidth: 1,
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 14,
    fontFamily: 'Inter_400Regular',
  },
  chipRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 6,
  },
  chip: {
    borderRadius: 8,
    borderWidth: 1,
    paddingHorizontal: 10,
    paddingVertical: 6,
  },
  chipText: {
    fontSize: 12,
    fontFamily: 'Inter_600SemiBold',
  },
  foundCard: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    borderRadius: 10,
    borderWidth: 1,
    padding: 10,
  },
  foundName: {
    fontSize: 14,
    fontFamily: 'Inter_700Bold',
  },
  foundMeta: {
    fontSize: 12,
    fontFamily: 'Inter_400Regular',
  },
  sameAsSenderToggle: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    borderRadius: 10,
    borderWidth: 1,
    padding: 10,
  },
  citiesLoading: {
    borderRadius: 10,
    borderWidth: 1,
    padding: 12,
    alignItems: 'center',
  },
  cartBox: {
    borderRadius: 10,
    borderWidth: 1,
    padding: 10,
    gap: 6,
  },
  cartHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  cartTitle: {
    fontSize: 13,
    fontFamily: 'Inter_700Bold',
  },
  cartCount: {
    fontSize: 12,
    fontFamily: 'Inter_600SemiBold',
  },
  cartItem: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  cartName: {
    fontSize: 13,
    fontFamily: 'Inter_600SemiBold',
  },
  cartControls: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  cartPrice: {
    fontSize: 12,
    fontFamily: 'Inter_600SemiBold',
  },
  catRow: {
    gap: 6,
    paddingBottom: 4,
  },
  productGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    marginHorizontal: -4,
  },
  occasionGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 6,
  },
  occasionTile: {
    borderRadius: 8,
    borderWidth: 1,
    paddingHorizontal: 10,
    paddingVertical: 6,
  },
  occasionText: {
    fontSize: 12,
    fontFamily: 'Inter_600SemiBold',
  },
  addOnRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    borderRadius: 10,
    borderWidth: 1,
    padding: 10,
    marginBottom: 6,
  },
  addOnCheck: {
    width: 20,
    height: 20,
    borderRadius: 6,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  addOnName: {
    fontSize: 13,
    fontFamily: 'Inter_600SemiBold',
  },
  addOnPrice: {
    fontSize: 12,
    fontFamily: 'Inter_600SemiBold',
  },
  langToggle: {
    flexDirection: 'row',
    gap: 8,
    marginBottom: 6,
  },
  langBtn: {
    borderRadius: 8,
    borderWidth: 1,
    paddingHorizontal: 12,
    paddingVertical: 6,
  },
  langText: {
    fontSize: 12,
    fontFamily: 'Inter_600SemiBold',
  },
  messageInput: {
    borderWidth: 1,
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 14,
    fontFamily: 'Inter_400Regular',
    minHeight: 64,
  },
  charCount: {
    fontSize: 11,
    fontFamily: 'Inter_400Regular',
    alignSelf: 'flex-end',
  },
  deliveryRow: {
    flexDirection: 'row',
    gap: 8,
  },
  deliveryOption: {
    flex: 1,
    borderRadius: 10,
    borderWidth: 1,
    padding: 10,
    alignItems: 'center',
    gap: 3,
  },
  timeRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 6,
    marginTop: 8,
  },
  timeChip: {
    borderRadius: 8,
    borderWidth: 1,
    paddingHorizontal: 10,
    paddingVertical: 6,
  },
  paymentGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
  },
  paymentTile: {
    flex: 1,
    minWidth: 80,
    borderRadius: 10,
    borderWidth: 1,
    padding: 10,
    alignItems: 'center',
  },
  urgentToggle: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    borderRadius: 10,
    borderWidth: 1,
    padding: 10,
  },
  schedulerRow: {
    flexDirection: 'row',
    gap: 8,
    marginTop: 8,
  },
  schedulerField: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    borderWidth: 1,
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  reviewCard: {
    borderRadius: 12,
    borderWidth: 1,
    padding: 14,
    gap: 8,
  },
  reviewTitle: {
    fontSize: 15,
    fontFamily: 'Inter_700Bold',
    marginBottom: 4,
  },
  reviewRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  reviewLabel: {
    fontSize: 12,
    fontFamily: 'Inter_400Regular',
  },
  reviewValue: {
    fontSize: 13,
    fontFamily: 'Inter_600SemiBold',
    textAlign: 'right',
    flex: 1,
    marginLeft: 12,
  },
  reviewItemRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  reviewItemName: {
    fontSize: 13,
    fontFamily: 'Inter_600SemiBold',
  },
  reviewItemPrice: {
    fontSize: 13,
    fontFamily: 'Inter_600SemiBold',
  },
  reviewTotalLabel: {
    fontSize: 15,
    fontFamily: 'Inter_700Bold',
  },
  reviewTotal: {
    fontSize: 18,
    fontFamily: 'Inter_700Bold',
  },
  urgentBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 6,
    alignSelf: 'flex-start',
  },
});

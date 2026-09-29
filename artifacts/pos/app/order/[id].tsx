import React, { useState } from 'react';
import {
  View, Text, StyleSheet, ScrollView, TouchableOpacity,
  Platform, Alert, Image, ActivityIndicator,
} from 'react-native';
import { Feather } from '@expo/vector-icons';
import { router, useLocalSearchParams } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useColors } from '@/hooks/useColors';
import { StatusBadge } from '@/components/StatusBadge';
import { useLiveOrder } from '@/lib/api';
import type { OrderStatus } from '@/types';

const STATUS_STEPS: { key: OrderStatus; label: string }[] = [
  { key: 'draft', label: 'Draft' },
  { key: 'awaiting_payment', label: 'Awaiting Payment' },
  { key: 'paid', label: 'Paid' },
  { key: 'sent_to_florist', label: 'Sent to Florist' },
  { key: 'preparing', label: 'Preparing' },
  { key: 'ready_for_pickup', label: 'Ready for Pickup' },
  { key: 'with_driver', label: 'With Driver' },
  { key: 'delivered', label: 'Delivered' },
];

export default function OrderDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const topPad = Platform.OS === 'web' ? 67 : insets.top;
  const [showActions, setShowActions] = useState(false);

  const { order, loading, error, refetch } = useLiveOrder(id);

  if (loading) {
    return (
      <View style={[styles.center, { backgroundColor: colors.background }]}>
        <ActivityIndicator size="large" color={colors.primary} />
        <Text style={[styles.notFound, { color: colors.mutedForeground }]}>Loading order…</Text>
      </View>
    );
  }

  if (error || !order) {
    return (
      <View style={[styles.center, { backgroundColor: colors.background }]}>
        <Feather name="alert-circle" size={40} color="#ef4343" />
        <Text style={[styles.notFound, { color: colors.foreground }]}>{error ?? 'Order not found'}</Text>
        <View style={styles.errorActions}>
          <TouchableOpacity
            style={[styles.retryBtn, { backgroundColor: colors.primary }]}
            onPress={refetch}
          >
            <Feather name="refresh-cw" size={14} color="#fff" />
            <Text style={styles.retryText}>Retry</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={[styles.retryBtn, { backgroundColor: colors.secondary }]}
            onPress={() => router.back()}
          >
            <Text style={[styles.retryText, { color: colors.foreground }]}>Go Back</Text>
          </TouchableOpacity>
        </View>
      </View>
    );
  }

  const currentStepIdx = STATUS_STEPS.findIndex(s => s.key === order.status);

  const QUICK_ACTIONS = [
    { label: 'Send Payment Link', icon: 'send' as const, color: colors.primary },
    { label: 'Copy Payment Link', icon: 'copy' as const, color: colors.primary },
    { label: 'Mark as Paid', icon: 'check-circle' as const, color: '#16a34a' },
    { label: 'Mark Urgent', icon: 'alert-circle' as const, color: '#d97706' },
    { label: 'Report Issue', icon: 'alert-triangle' as const, color: '#ef4343' },
    { label: 'Request Refund', icon: 'rotate-ccw' as const, color: '#ef4343' },
    { label: 'Edit Card Message', icon: 'edit-2' as const, color: colors.foreground },
    { label: 'Contact Customer', icon: 'phone' as const, color: colors.foreground },
  ];

  return (
    <View style={[styles.container, { backgroundColor: colors.background }]}>
      {/* Header */}
      <View style={[styles.header, { paddingTop: topPad + 10, backgroundColor: colors.card, borderBottomColor: colors.border }]}>
        <View style={styles.headerRow}>
          <TouchableOpacity onPress={() => router.back()} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
            <Feather name="arrow-left" size={22} color={colors.foreground} />
          </TouchableOpacity>
          <View style={styles.headerTitle}>
            <Text style={[styles.orderNum, { color: colors.foreground }]}>{order.orderNumber}</Text>
            <View style={styles.badges}>
              <StatusBadge status={order.paymentStatus} small />
              {order.isUrgent && <StatusBadge status="urgent" small />}
              {order.hasIssue && <StatusBadge status="issue" small />}
            </View>
          </View>
          <TouchableOpacity
            style={[styles.actionsBtn, { backgroundColor: colors.secondary }]}
            onPress={() => setShowActions(!showActions)}
          >
            <Feather name="zap" size={16} color={colors.primary} />
          </TouchableOpacity>
        </View>
        <StatusBadge status={order.status} />
        <Text style={[styles.total, { color: colors.foreground }]}>AED {order.total.toFixed(0)}</Text>
      </View>

      {/* Quick actions panel */}
      {showActions && (
        <View style={[styles.actionsPanel, { backgroundColor: colors.card, borderBottomColor: colors.border }]}>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.actionsContent}>
            {QUICK_ACTIONS.map(action => (
              <TouchableOpacity
                key={action.label}
                style={[styles.actionChip, { backgroundColor: action.color + '15', borderColor: action.color + '30' }]}
                onPress={() => Alert.alert(action.label, 'This action will be connected to the Presentail OS backend.')}
              >
                <Feather name={action.icon} size={14} color={action.color} />
                <Text style={[styles.actionChipText, { color: action.color }]}>{action.label}</Text>
              </TouchableOpacity>
            ))}
          </ScrollView>
        </View>
      )}

      <ScrollView
        style={styles.scroll}
        contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + 30 }]}
        showsVerticalScrollIndicator={false}
      >
        {/* Timeline */}
        <Section title="Status Timeline" icon="activity" colors={colors}>
          <View style={styles.timeline}>
            {STATUS_STEPS.map((step, i) => {
              const done = i < currentStepIdx;
              const active = i === currentStepIdx;
              return (
                <View key={step.key} style={styles.timelineItem}>
                  <View style={styles.timelineLeft}>
                    <View style={[styles.timelineDot, {
                      backgroundColor: done || active ? colors.primary : colors.border,
                      borderColor: active ? colors.primary : 'transparent',
                    }]}>
                      {done && <Feather name="check" size={10} color="#fff" />}
                    </View>
                    {i < STATUS_STEPS.length - 1 && (
                      <View style={[styles.timelineLine, { backgroundColor: done ? colors.primary : colors.border }]} />
                    )}
                  </View>
                  <Text style={[styles.timelineLabel, { color: active ? colors.primary : done ? colors.foreground : colors.mutedForeground, fontFamily: active ? 'Inter_700Bold' : 'Inter_400Regular' }]}>
                    {step.label}
                  </Text>
                </View>
              );
            })}
          </View>
        </Section>

        {/* Customer */}
        <Section title="Sender / Customer" icon="user" colors={colors}>
          <InfoRow label="Name" value={order.isAnonymous ? 'Anonymous' : order.customer.name} colors={colors} />
          {!order.isAnonymous && <InfoRow label="Phone" value={order.customer.phone} colors={colors} />}
          {!order.isAnonymous && order.customer.whatsapp && <InfoRow label="WhatsApp" value={order.customer.whatsapp} colors={colors} />}
          {!order.isAnonymous && <InfoRow label="Language" value={order.customer.language === 'ar' ? 'Arabic' : 'English'} colors={colors} />}
          {!order.isAnonymous && order.customer.isVip && <InfoRow label="Status" value="⭐ VIP Customer" colors={colors} />}
        </Section>

        {/* Recipient */}
        <Section title="Recipient" icon="gift" colors={colors}>
          <InfoRow label="Name" value={order.recipient.name} colors={colors} />
          <InfoRow label="Phone" value={order.recipient.phone} colors={colors} />
          <InfoRow label="City" value={order.recipient.city} colors={colors} />
          {order.recipient.area && <InfoRow label="Area" value={order.recipient.area} colors={colors} />}
          <InfoRow label="Address" value={order.recipient.address} colors={colors} />
          {order.recipient.notes && <InfoRow label="Notes" value={order.recipient.notes} colors={colors} />}
        </Section>

        {/* Products */}
        <Section title="Products & Add-ons" icon="package" colors={colors}>
          {order.items.map(item => (
            <View key={item.id} style={[styles.productRow, { borderBottomColor: colors.border }]}>
              {item.product.image ? (
                <Image
                  source={{ uri: item.product.image }}
                  style={[styles.productThumb, { backgroundColor: colors.muted, borderColor: colors.border }]}
                />
              ) : (
                <View style={[styles.productThumb, styles.productThumbEmpty, { backgroundColor: colors.muted, borderColor: colors.border }]}>
                  <Feather name="image" size={18} color={colors.mutedForeground} />
                </View>
              )}
              <View style={styles.productInfo}>
                <Text style={[styles.productName, { color: colors.foreground }]}>{item.product.name}</Text>
                <Text style={[styles.productMeta, { color: colors.mutedForeground }]}>
                  {item.product.category} · qty {item.quantity}
                </Text>
              </View>
              <Text style={[styles.productPrice, { color: colors.foreground }]}>AED {item.unitPrice * item.quantity}</Text>
            </View>
          ))}
          {order.addOns.map(ao => (
            <View key={ao.id} style={[styles.productRow, { borderBottomColor: colors.border }]}>
              <View style={styles.productInfo}>
                <Text style={[styles.productName, { color: colors.foreground }]}>{ao.name}</Text>
                <Text style={[styles.productMeta, { color: colors.mutedForeground }]}>Add-on</Text>
              </View>
              <Text style={[styles.productPrice, { color: colors.foreground }]}>AED {ao.price}</Text>
            </View>
          ))}
        </Section>

        {/* Card message */}
        {order.cardMessage && (
          <Section title="Card Message" icon="message-square" colors={colors}>
            <View style={[styles.cardMsgBox, { backgroundColor: colors.secondary }]}>
              <Text style={[styles.cardMsg, { color: colors.foreground }]}>"{order.cardMessage}"</Text>
            </View>
            <Text style={[styles.occasion, { color: colors.mutedForeground }]}>Occasion: {order.occasion ?? '—'}</Text>
          </Section>
        )}

        {/* Delivery */}
        <Section title="Delivery" icon="truck" colors={colors}>
          <InfoRow label="City" value={order.deliveryCity?.name ?? '—'} colors={colors} />
          <InfoRow label="Date" value={order.deliveryDate ?? '—'} colors={colors} />
          {order.deliveryTimeSlot && <InfoRow label="Slot" value={order.deliveryTimeSlot} colors={colors} />}
          <InfoRow label="Delivery Fee" value={order.deliveryFee === 0 ? 'Free' : `AED ${order.deliveryFee}`} colors={colors} />
          {order.expressFee > 0 && <InfoRow label="Express Fee" value={`AED ${order.expressFee}`} colors={colors} />}
        </Section>

        {/* Payment */}
        <Section title="Payment" icon="credit-card" colors={colors}>
          <InfoRow label="Method" value={(order.paymentMethod ?? '—').replace('_', ' ')} colors={colors} />
          <InfoRow label="Subtotal" value={`AED ${order.subtotal}`} colors={colors} />
          {order.discount > 0 && <InfoRow label="Discount" value={`-AED ${order.discount}`} colors={colors} />}
          <InfoRow label="Delivery" value={order.deliveryFee === 0 ? 'Free' : `AED ${order.deliveryFee}`} colors={colors} />
          <View style={[styles.totalRow, { borderTopColor: colors.border }]}>
            <Text style={[styles.totalLabel, { color: colors.foreground }]}>Total</Text>
            <Text style={[styles.totalValue, { color: colors.primary }]}>AED {order.total}</Text>
          </View>
          {order.paymentLink && (
            <View style={[styles.linkRow, { backgroundColor: colors.secondary }]}>
              <Feather name="link" size={14} color={colors.primary} />
              <Text style={[styles.linkText, { color: colors.primary }]} numberOfLines={1}>{order.paymentLink}</Text>
            </View>
          )}
        </Section>

        {/* Notes */}
        {order.internalNotes && (
          <Section title="Internal Notes" icon="edit-3" colors={colors}>
            <Text style={[styles.notes, { color: colors.foreground }]}>{order.internalNotes}</Text>
          </Section>
        )}

        {/* Meta */}
        <View style={[styles.metaFooter, { backgroundColor: colors.secondary }]}>
          <Text style={[styles.metaText, { color: colors.mutedForeground }]}>Agent: {order.agentName}</Text>
          <Text style={[styles.metaText, { color: colors.mutedForeground }]}>Source: {order.source}</Text>
          <Text style={[styles.metaText, { color: colors.mutedForeground }]}>Created: {new Date(order.createdAt).toLocaleString()}</Text>
        </View>
      </ScrollView>
    </View>
  );
}

function Section({ title, icon, colors, children }: { title: string; icon: React.ComponentProps<typeof Feather>['name']; colors: ReturnType<typeof useColors>; children: React.ReactNode }) {
  return (
    <View style={[styles.section, { backgroundColor: colors.card, borderColor: colors.border }]}>
      <View style={styles.sectionHeader}>
        <Feather name={icon} size={14} color={colors.primary} />
        <Text style={[styles.sectionTitle, { color: colors.foreground }]}>{title}</Text>
      </View>
      <View style={styles.sectionContent}>{children}</View>
    </View>
  );
}

function InfoRow({ label, value, colors }: { label: string; value: string; colors: ReturnType<typeof useColors> }) {
  return (
    <View style={[styles.infoRow, { borderBottomColor: colors.border }]}>
      <Text style={[styles.infoLabel, { color: colors.mutedForeground }]}>{label}</Text>
      <Text style={[styles.infoValue, { color: colors.foreground }]}>{value}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 12, paddingHorizontal: 24 },
  notFound: { fontSize: 16, fontFamily: 'Inter_400Regular', textAlign: 'center' },
  errorActions: { flexDirection: 'row', gap: 10, marginTop: 4 },
  retryBtn: {
    flexDirection: 'row', alignItems: 'center', gap: 6,
    borderRadius: 8, paddingHorizontal: 16, paddingVertical: 9,
  },
  retryText: { color: '#fff', fontSize: 14, fontFamily: 'Inter_600SemiBold' },
  header: {
    paddingHorizontal: 16, paddingBottom: 12, borderBottomWidth: 1, gap: 6,
  },
  headerRow: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  headerTitle: { flex: 1, gap: 4 },
  orderNum: { fontSize: 20, fontFamily: 'Inter_700Bold' },
  badges: { flexDirection: 'row', gap: 4 },
  actionsBtn: { width: 36, height: 36, borderRadius: 10, alignItems: 'center', justifyContent: 'center' },
  total: { fontSize: 22, fontFamily: 'Inter_700Bold' },
  actionsPanel: { borderBottomWidth: 1 },
  actionsContent: { padding: 12, gap: 8, flexDirection: 'row' },
  actionChip: { flexDirection: 'row', alignItems: 'center', gap: 6, borderWidth: 1, borderRadius: 20, paddingHorizontal: 12, paddingVertical: 7 },
  actionChipText: { fontSize: 13, fontFamily: 'Inter_500Medium' },
  scroll: { flex: 1 },
  content: { padding: 12, gap: 8 },
  section: { borderRadius: 12, borderWidth: 1, overflow: 'hidden' },
  sectionHeader: { flexDirection: 'row', alignItems: 'center', gap: 6, padding: 12, paddingBottom: 10 },
  sectionTitle: { fontSize: 13, fontFamily: 'Inter_700Bold', textTransform: 'uppercase', letterSpacing: 0.5 },
  sectionContent: { paddingHorizontal: 12, paddingBottom: 8 },
  infoRow: { flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 8, borderBottomWidth: StyleSheet.hairlineWidth },
  infoLabel: { fontSize: 13, fontFamily: 'Inter_400Regular' },
  infoValue: { fontSize: 13, fontFamily: 'Inter_500Medium', maxWidth: '60%', textAlign: 'right' },
  timeline: { gap: 0, paddingBottom: 8 },
  timelineItem: { flexDirection: 'row', alignItems: 'flex-start', gap: 10 },
  timelineLeft: { alignItems: 'center', width: 20 },
  timelineDot: { width: 20, height: 20, borderRadius: 10, alignItems: 'center', justifyContent: 'center', borderWidth: 2 },
  timelineLine: { width: 2, height: 20, borderRadius: 1 },
  timelineLabel: { fontSize: 13, paddingTop: 2, paddingBottom: 12 },
  productRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingVertical: 10, borderBottomWidth: StyleSheet.hairlineWidth, gap: 10 },
  productThumb: { width: 44, height: 44, borderRadius: 8, borderWidth: StyleSheet.hairlineWidth },
  productThumbEmpty: { alignItems: 'center', justifyContent: 'center' },
  productInfo: { flex: 1, gap: 2 },
  productName: { fontSize: 14, fontFamily: 'Inter_500Medium' },
  productMeta: { fontSize: 12, fontFamily: 'Inter_400Regular' },
  productPrice: { fontSize: 14, fontFamily: 'Inter_600SemiBold' },
  cardMsgBox: { borderRadius: 10, padding: 12, marginBottom: 8 },
  cardMsg: { fontSize: 14, fontFamily: 'Inter_400Regular', fontStyle: 'italic', lineHeight: 20 },
  occasion: { fontSize: 12, fontFamily: 'Inter_400Regular' },
  totalRow: { flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 10, borderTopWidth: 1.5, marginTop: 4 },
  totalLabel: { fontSize: 15, fontFamily: 'Inter_700Bold' },
  totalValue: { fontSize: 17, fontFamily: 'Inter_700Bold' },
  linkRow: { flexDirection: 'row', alignItems: 'center', gap: 8, borderRadius: 8, padding: 10, marginTop: 6 },
  linkText: { fontSize: 13, fontFamily: 'Inter_400Regular', flex: 1 },
  notes: { fontSize: 14, fontFamily: 'Inter_400Regular', lineHeight: 20, paddingBottom: 4 },
  metaFooter: { borderRadius: 12, padding: 14, gap: 4 },
  metaText: { fontSize: 12, fontFamily: 'Inter_400Regular' },
});

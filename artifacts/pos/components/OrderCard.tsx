import React from 'react';
import { View, Text, StyleSheet, TouchableOpacity } from 'react-native';
import { Feather } from '@expo/vector-icons';
import { useColors } from '@/hooks/useColors';
import { StatusBadge } from './StatusBadge';
import type { Order } from '@/types';

interface Props {
  order: Order;
  onPress: () => void;
}

export function OrderCard({ order, onPress }: Props) {
  const colors = useColors();
  const dateStr = order.deliveryDate
    ? new Date(order.deliveryDate).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
    : null;

  return (
    <TouchableOpacity
      style={[styles.card, { backgroundColor: colors.card, borderColor: colors.border }]}
      onPress={onPress}
      activeOpacity={0.7}
    >
      <View style={styles.header}>
        <View style={styles.headerLeft}>
          <Text style={[styles.orderNum, { color: colors.foreground }]}>{order.orderNumber}</Text>
          {order.isUrgent && <StatusBadge status="urgent" small />}
          {order.hasIssue && <StatusBadge status="issue" small />}
        </View>
        <StatusBadge status={order.paymentStatus} small />
      </View>

      <View style={styles.body}>
        <View style={styles.row}>
          <Feather name="user" size={13} color={colors.mutedForeground} />
          <Text style={[styles.meta, { color: colors.foreground }]} numberOfLines={1}>
            {order.customer.name}
          </Text>
        </View>
        <View style={styles.row}>
          <Feather name="gift" size={13} color={colors.mutedForeground} />
          <Text style={[styles.meta, { color: colors.mutedForeground }]} numberOfLines={1}>
            To: {order.recipient.name} · {order.recipient.city}
          </Text>
        </View>
        {dateStr && (
          <View style={styles.row}>
            <Feather name="calendar" size={13} color={colors.mutedForeground} />
            <Text style={[styles.meta, { color: colors.mutedForeground }]}>
              {dateStr}{order.deliveryTimeSlot ? ` · ${order.deliveryTimeSlot}` : ''}
            </Text>
          </View>
        )}
      </View>

      <View style={styles.footer}>
        <StatusBadge status={order.status} small />
        <Text style={[styles.total, { color: colors.foreground }]}>
          AED {order.total.toFixed(0)}
        </Text>
      </View>
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  card: {
    borderRadius: 12,
    borderWidth: 1,
    padding: 14,
    marginBottom: 10,
    gap: 10,
  },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  headerLeft: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  orderNum: {
    fontSize: 15,
    fontFamily: 'Inter_700Bold',
  },
  body: {
    gap: 4,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  meta: {
    fontSize: 13,
    fontFamily: 'Inter_400Regular',
    flex: 1,
  },
  footer: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingTop: 8,
    borderTopWidth: 1,
    borderTopColor: '#f1f5f9',
  },
  total: {
    fontSize: 15,
    fontFamily: 'Inter_700Bold',
  },
});

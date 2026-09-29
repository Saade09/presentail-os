import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import type { OrderStatus, PaymentStatus } from '@/types';

type BadgeVariant = OrderStatus | PaymentStatus | 'urgent' | 'issue' | 'vip';

const BADGE_CONFIG: Record<BadgeVariant, { label: string; bg: string; text: string }> = {
  draft: { label: 'Draft', bg: '#f1f5f9', text: '#64748b' },
  awaiting_payment: { label: 'Awaiting Payment', bg: '#fef3c7', text: '#92400e' },
  paid: { label: 'Paid', bg: '#dcfce7', text: '#166534' },
  sent_to_florist: { label: 'Sent to Florist', bg: '#e0f2fe', text: '#075985' },
  preparing: { label: 'Preparing', bg: '#dbeafe', text: '#1e40af' },
  ready_for_pickup: { label: 'Ready', bg: '#ede9fe', text: '#5b21b6' },
  with_driver: { label: 'With Driver', bg: '#cffafe', text: '#155e75' },
  delivered: { label: 'Delivered', bg: '#dcfce7', text: '#166534' },
  issue_reported: { label: 'Issue', bg: '#fee2e2', text: '#991b1b' },
  closed: { label: 'Closed', bg: '#f1f5f9', text: '#475569' },
  failed: { label: 'Failed', bg: '#fee2e2', text: '#991b1b' },
  expired: { label: 'Expired', bg: '#fef9c3', text: '#713f12' },
  urgent: { label: 'Urgent', bg: '#fee2e2', text: '#991b1b' },
  issue: { label: 'Issue', bg: '#fee2e2', text: '#991b1b' },
  vip: { label: 'VIP', bg: '#fef3c7', text: '#92400e' },
};

interface Props {
  status: BadgeVariant;
  small?: boolean;
}

export function StatusBadge({ status, small = false }: Props) {
  const config = BADGE_CONFIG[status] ?? BADGE_CONFIG.draft;
  return (
    <View style={[styles.badge, { backgroundColor: config.bg }, small && styles.small]}>
      <Text style={[styles.label, { color: config.text }, small && styles.smallLabel]}>
        {config.label}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  badge: {
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 20,
    alignSelf: 'flex-start',
  },
  label: {
    fontSize: 12,
    fontFamily: 'Inter_600SemiBold',
    letterSpacing: 0.1,
  },
  small: {
    paddingHorizontal: 6,
    paddingVertical: 2,
  },
  smallLabel: {
    fontSize: 10,
  },
});

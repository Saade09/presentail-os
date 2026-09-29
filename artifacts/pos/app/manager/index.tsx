import React, { useState } from 'react';
import {
  View, Text, StyleSheet, ScrollView, TouchableOpacity,
  Platform, Alert, TextInput,
} from 'react-native';
import { Feather } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { router } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useColors } from '@/hooks/useColors';
import { MOCK_REFUND_REQUESTS, MOCK_ORDERS } from '@/data/mock';
import type { RefundRequest } from '@/types';

export default function ManagerScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const topPad = Platform.OS === 'web' ? 67 : insets.top;
  const [requests, setRequests] = useState<RefundRequest[]>(MOCK_REFUND_REQUESTS);
  const [activeTab, setActiveTab] = useState<'refunds' | 'urgent' | 'activity'>('refunds');

  const pendingRequests = requests.filter(r => r.status === 'pending');
  const urgentOrders = MOCK_ORDERS.filter(o => o.isUrgent);

  const handleApprove = (id: string) => {
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    setRequests(prev => prev.map(r => r.id === id ? { ...r, status: 'approved' } : r));
  };

  const handleReject = (id: string) => {
    Alert.alert('Reject Request', 'Are you sure you want to reject this request?', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Reject', style: 'destructive',
        onPress: () => {
          Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
          setRequests(prev => prev.map(r => r.id === id ? { ...r, status: 'rejected' } : r));
        },
      },
    ]);
  };

  const TABS = [
    { key: 'refunds', label: `Refunds (${pendingRequests.length})`, icon: 'rotate-ccw' as const },
    { key: 'urgent', label: `Urgent (${urgentOrders.length})`, icon: 'alert-circle' as const },
    { key: 'activity', label: 'Activity', icon: 'bar-chart-2' as const },
  ];

  return (
    <View style={[styles.container, { backgroundColor: colors.background }]}>
      <View style={[styles.header, { paddingTop: topPad + 10, backgroundColor: colors.card, borderBottomColor: colors.border }]}>
        <View style={styles.headerRow}>
          <TouchableOpacity onPress={() => router.back()} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
            <Feather name="arrow-left" size={22} color={colors.foreground} />
          </TouchableOpacity>
          <Text style={[styles.title, { color: colors.foreground }]}>Manager Queue</Text>
        </View>
        <View style={styles.tabs}>
          {TABS.map(tab => (
            <TouchableOpacity
              key={tab.key}
              style={[styles.tab, activeTab === tab.key && { borderBottomColor: colors.primary, borderBottomWidth: 2 }]}
              onPress={() => setActiveTab(tab.key as typeof activeTab)}
            >
              <Feather name={tab.icon} size={14} color={activeTab === tab.key ? colors.primary : colors.mutedForeground} />
              <Text style={[styles.tabText, { color: activeTab === tab.key ? colors.primary : colors.mutedForeground }]}>
                {tab.label}
              </Text>
            </TouchableOpacity>
          ))}
        </View>
      </View>

      <ScrollView contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + 30 }]} showsVerticalScrollIndicator={false}>
        {activeTab === 'refunds' && (
          <>
            {requests.length === 0 ? (
              <View style={styles.empty}>
                <Feather name="check-circle" size={40} color={colors.mutedForeground} />
                <Text style={[styles.emptyText, { color: colors.mutedForeground }]}>No pending requests</Text>
              </View>
            ) : (
              requests.map(req => (
                <RefundCard key={req.id} req={req} colors={colors} onApprove={handleApprove} onReject={handleReject} />
              ))
            )}
          </>
        )}

        {activeTab === 'urgent' && (
          <>
            {urgentOrders.length === 0 ? (
              <View style={styles.empty}>
                <Feather name="check-circle" size={40} color={colors.mutedForeground} />
                <Text style={[styles.emptyText, { color: colors.mutedForeground }]}>No urgent orders</Text>
              </View>
            ) : (
              urgentOrders.map(order => (
                <TouchableOpacity
                  key={order.id}
                  style={[styles.urgentCard, { backgroundColor: colors.card, borderColor: '#ef4343' }]}
                  onPress={() => router.push(`/order/${order.id}` as never)}
                >
                  <View>
                    <View style={styles.urgentHeader}>
                      <Text style={[styles.urgentOrderNum, { color: colors.foreground }]}>{order.orderNumber}</Text>
                      <View style={[styles.urgentBadge, { backgroundColor: '#fee2e2' }]}>
                        <Text style={styles.urgentBadgeText}>URGENT</Text>
                      </View>
                    </View>
                    <Text style={[styles.urgentMeta, { color: colors.mutedForeground }]}>
                      {order.customer.name} → {order.recipient.city}
                    </Text>
                    {order.deliveryDate && (
                      <Text style={[styles.urgentDate, { color: colors.mutedForeground }]}>Delivery: {order.deliveryDate}</Text>
                    )}
                  </View>
                  <Feather name="chevron-right" size={18} color={colors.mutedForeground} />
                </TouchableOpacity>
              ))
            )}
          </>
        )}

        {activeTab === 'activity' && (
          <View style={styles.activitySection}>
            <Text style={[styles.activityTitle, { color: colors.foreground }]}>Today's Overview</Text>
            {[
              { label: 'Total Orders Created', value: '6', icon: 'shopping-bag', color: colors.primary },
              { label: 'Payment Links Sent', value: '3', icon: 'send', color: '#2563eb' },
              { label: 'Orders Delivered', value: '2', icon: 'check-circle', color: '#16a34a' },
              { label: 'Issues Reported', value: '1', icon: 'alert-triangle', color: '#ef4343' },
              { label: 'Refund Requests', value: '2', icon: 'rotate-ccw', color: '#d97706' },
            ].map(stat => (
              <View key={stat.label} style={[styles.activityRow, { backgroundColor: colors.card, borderColor: colors.border }]}>
                <View style={[styles.activityIcon, { backgroundColor: stat.color + '18' }]}>
                  <Feather name={stat.icon as React.ComponentProps<typeof Feather>['name']} size={16} color={stat.color} />
                </View>
                <Text style={[styles.activityLabel, { color: colors.foreground }]}>{stat.label}</Text>
                <Text style={[styles.activityValue, { color: stat.color }]}>{stat.value}</Text>
              </View>
            ))}
          </View>
        )}
      </ScrollView>
    </View>
  );
}

function RefundCard({ req, colors, onApprove, onReject }: {
  req: RefundRequest;
  colors: ReturnType<typeof useColors>;
  onApprove: (id: string) => void;
  onReject: (id: string) => void;
}) {
  const [comment, setComment] = useState('');
  const isPending = req.status === 'pending';

  return (
    <View style={[styles.refundCard, {
      backgroundColor: colors.card,
      borderColor: req.status === 'approved' ? '#16a34a' : req.status === 'rejected' ? '#ef4343' : colors.border,
      borderLeftWidth: req.status !== 'pending' ? 3 : 1,
    }]}>
      <View style={styles.refundHeader}>
        <Text style={[styles.refundOrderNum, { color: colors.foreground }]}>{req.orderNumber}</Text>
        <View style={[styles.statusBadge, { backgroundColor: req.status === 'approved' ? '#dcfce7' : req.status === 'rejected' ? '#fee2e2' : '#fef3c7' }]}>
          <Text style={[styles.statusBadgeText, { color: req.status === 'approved' ? '#166534' : req.status === 'rejected' ? '#991b1b' : '#92400e' }]}>
            {req.status.toUpperCase()}
          </Text>
        </View>
      </View>
      <Text style={[styles.refundCustomer, { color: colors.mutedForeground }]}>Customer: {req.customerName}</Text>
      <Text style={[styles.refundAgent, { color: colors.mutedForeground }]}>Agent: {req.agentName}</Text>
      <View style={[styles.reasonBox, { backgroundColor: colors.secondary }]}>
        <Text style={[styles.reasonLabel, { color: colors.mutedForeground }]}>Reason</Text>
        <Text style={[styles.reasonValue, { color: colors.foreground }]}>{req.reasonCode}</Text>
      </View>
      {req.amount !== undefined && (
        <Text style={[styles.amount, { color: colors.primary }]}>Requested Amount: AED {req.amount}</Text>
      )}
      {req.percentage !== undefined && (
        <Text style={[styles.amount, { color: colors.primary }]}>Requested Discount: {req.percentage}%</Text>
      )}
      <Text style={[styles.explanation, { color: colors.foreground }]}>{req.explanation}</Text>
      {isPending && (
        <>
          <TextInput
            style={[styles.commentInput, { borderColor: colors.border, backgroundColor: colors.background, color: colors.foreground, fontFamily: 'Inter_400Regular' }]}
            value={comment}
            onChangeText={setComment}
            placeholder="Manager comment (optional)..."
            placeholderTextColor={colors.mutedForeground}
            multiline
          />
          <View style={styles.actions}>
            <TouchableOpacity style={[styles.rejectBtn, { borderColor: '#ef4343', backgroundColor: '#fee2e2' }]} onPress={() => onReject(req.id)}>
              <Feather name="x" size={16} color="#991b1b" />
              <Text style={[styles.actionText, { color: '#991b1b' }]}>Reject</Text>
            </TouchableOpacity>
            <TouchableOpacity style={[styles.approveBtn, { backgroundColor: '#16a34a' }]} onPress={() => onApprove(req.id)}>
              <Feather name="check" size={16} color="#fff" />
              <Text style={[styles.actionText, { color: '#fff' }]}>Approve</Text>
            </TouchableOpacity>
          </View>
        </>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  header: { paddingHorizontal: 16, paddingBottom: 0, borderBottomWidth: 1, gap: 12 },
  headerRow: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  title: { fontSize: 18, fontFamily: 'Inter_700Bold' },
  tabs: { flexDirection: 'row', gap: 0 },
  tab: { flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 5, paddingVertical: 12, borderBottomWidth: 2, borderBottomColor: 'transparent' },
  tabText: { fontSize: 12, fontFamily: 'Inter_600SemiBold' },
  content: { padding: 14, gap: 0 },
  empty: { alignItems: 'center', paddingTop: 80, gap: 10 },
  emptyText: { fontSize: 15, fontFamily: 'Inter_500Medium' },
  refundCard: { borderRadius: 12, borderWidth: 1, padding: 14, marginBottom: 10, gap: 8 },
  refundHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  refundOrderNum: { fontSize: 16, fontFamily: 'Inter_700Bold' },
  statusBadge: { borderRadius: 6, paddingHorizontal: 8, paddingVertical: 3 },
  statusBadgeText: { fontSize: 10, fontFamily: 'Inter_700Bold' },
  refundCustomer: { fontSize: 13, fontFamily: 'Inter_400Regular' },
  refundAgent: { fontSize: 13, fontFamily: 'Inter_400Regular' },
  reasonBox: { borderRadius: 8, padding: 10, flexDirection: 'row', gap: 8, alignItems: 'center' },
  reasonLabel: { fontSize: 12, fontFamily: 'Inter_500Medium' },
  reasonValue: { fontSize: 13, fontFamily: 'Inter_600SemiBold' },
  amount: { fontSize: 15, fontFamily: 'Inter_700Bold' },
  explanation: { fontSize: 13, fontFamily: 'Inter_400Regular', lineHeight: 18 },
  commentInput: { borderWidth: 1, borderRadius: 8, padding: 10, fontSize: 13, minHeight: 60 },
  actions: { flexDirection: 'row', gap: 10 },
  rejectBtn: { flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, borderWidth: 1.5, borderRadius: 10, paddingVertical: 12 },
  approveBtn: { flex: 1.5, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, borderRadius: 10, paddingVertical: 12 },
  actionText: { fontSize: 14, fontFamily: 'Inter_700Bold' },
  urgentCard: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', borderWidth: 1.5, borderRadius: 12, padding: 14, marginBottom: 10 },
  urgentHeader: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 4 },
  urgentOrderNum: { fontSize: 15, fontFamily: 'Inter_700Bold' },
  urgentBadge: { borderRadius: 6, paddingHorizontal: 6, paddingVertical: 2 },
  urgentBadgeText: { fontSize: 10, fontFamily: 'Inter_700Bold', color: '#991b1b' },
  urgentMeta: { fontSize: 13, fontFamily: 'Inter_400Regular' },
  urgentDate: { fontSize: 12, fontFamily: 'Inter_400Regular' },
  activitySection: { gap: 10 },
  activityTitle: { fontSize: 16, fontFamily: 'Inter_700Bold', marginBottom: 4 },
  activityRow: { flexDirection: 'row', alignItems: 'center', gap: 12, borderRadius: 12, borderWidth: 1, padding: 14 },
  activityIcon: { width: 36, height: 36, borderRadius: 10, alignItems: 'center', justifyContent: 'center' },
  activityLabel: { flex: 1, fontSize: 14, fontFamily: 'Inter_400Regular' },
  activityValue: { fontSize: 18, fontFamily: 'Inter_700Bold' },
});

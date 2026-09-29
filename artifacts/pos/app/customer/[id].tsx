import React from 'react';
import { View, Text, StyleSheet, ScrollView, TouchableOpacity, Platform } from 'react-native';
import { Feather } from '@expo/vector-icons';
import { router, useLocalSearchParams } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useColors } from '@/hooks/useColors';
import { StatusBadge } from '@/components/StatusBadge';
import { CUSTOMERS, MOCK_ORDERS } from '@/data/mock';

export default function CustomerScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const topPad = Platform.OS === 'web' ? 67 : insets.top;

  const customer = CUSTOMERS.find(c => c.id === id) ?? CUSTOMERS[0];
  const orders = MOCK_ORDERS.filter(o => o.customer.id === customer.id);

  return (
    <View style={[styles.container, { backgroundColor: colors.background }]}>
      <View style={[styles.header, { paddingTop: topPad + 10, backgroundColor: colors.card, borderBottomColor: colors.border }]}>
        <TouchableOpacity onPress={() => router.back()} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
          <Feather name="arrow-left" size={22} color={colors.foreground} />
        </TouchableOpacity>
        <Text style={[styles.title, { color: colors.foreground }]}>Customer Profile</Text>
      </View>

      <ScrollView contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + 30 }]}>
        {/* Profile hero */}
        <View style={[styles.profileCard, { backgroundColor: colors.primary }]}>
          <View style={styles.avatar}>
            <Text style={styles.avatarText}>{customer.name[0]}</Text>
          </View>
          <View style={styles.profileInfo}>
            <View style={styles.nameRow}>
              <Text style={styles.customerName}>{customer.name}</Text>
              {customer.isVip && (
                <View style={styles.vipBadge}>
                  <Text style={styles.vipText}>VIP</Text>
                </View>
              )}
            </View>
            <Text style={styles.customerPhone}>{customer.phone}</Text>
          </View>
        </View>

        {/* Stats */}
        <View style={styles.statsRow}>
          {[
            { label: 'Total Orders', value: customer.totalOrders },
            { label: 'Lifetime Spend', value: `AED ${customer.lifetimeSpend.toLocaleString()}` },
          ].map(s => (
            <View key={s.label} style={[styles.statCard, { backgroundColor: colors.card, borderColor: colors.border }]}>
              <Text style={[styles.statValue, { color: colors.primary }]}>{s.value}</Text>
              <Text style={[styles.statLabel, { color: colors.mutedForeground }]}>{s.label}</Text>
            </View>
          ))}
        </View>

        {/* Info */}
        <View style={[styles.section, { backgroundColor: colors.card, borderColor: colors.border }]}>
          <Text style={[styles.sectionTitle, { color: colors.foreground }]}>Contact Details</Text>
          {[
            { label: 'Phone', value: customer.phone },
            { label: 'WhatsApp', value: customer.whatsapp ?? '—' },
            { label: 'Email', value: customer.email ?? '—' },
            { label: 'Language', value: customer.language === 'ar' ? 'Arabic' : 'English' },
            { label: 'Last Order', value: customer.lastOrderDate ?? '—' },
          ].map(row => (
            <View key={row.label} style={[styles.row, { borderTopColor: colors.border }]}>
              <Text style={[styles.rowLabel, { color: colors.mutedForeground }]}>{row.label}</Text>
              <Text style={[styles.rowValue, { color: colors.foreground }]}>{row.value}</Text>
            </View>
          ))}
        </View>

        {/* Notes */}
        {customer.notes && (
          <View style={[styles.section, { backgroundColor: colors.card, borderColor: colors.border }]}>
            <Text style={[styles.sectionTitle, { color: colors.foreground }]}>Notes</Text>
            <Text style={[styles.notesText, { color: colors.foreground }]}>{customer.notes}</Text>
          </View>
        )}

        {/* Previous orders */}
        <View>
          <Text style={[styles.ordersTitle, { color: colors.foreground }]}>Order History ({orders.length})</Text>
          {orders.length === 0 ? (
            <View style={[styles.emptyOrders, { backgroundColor: colors.card, borderColor: colors.border }]}>
              <Text style={[styles.emptyText, { color: colors.mutedForeground }]}>No orders yet</Text>
            </View>
          ) : (
            orders.map(order => (
              <TouchableOpacity
                key={order.id}
                style={[styles.orderRow, { backgroundColor: colors.card, borderColor: colors.border }]}
                onPress={() => router.push(`/order/${order.id}` as never)}
              >
                <View>
                  <Text style={[styles.orderNum, { color: colors.foreground }]}>{order.orderNumber}</Text>
                  <Text style={[styles.orderDate, { color: colors.mutedForeground }]}>{order.deliveryDate ?? order.createdAt.slice(0, 10)}</Text>
                </View>
                <View style={styles.orderRight}>
                  <StatusBadge status={order.paymentStatus} small />
                  <Text style={[styles.orderTotal, { color: colors.foreground }]}>AED {order.total}</Text>
                </View>
                <Feather name="chevron-right" size={16} color={colors.mutedForeground} />
              </TouchableOpacity>
            ))
          )}
        </View>

        {/* Actions */}
        <TouchableOpacity
          style={[styles.newOrderBtn, { backgroundColor: colors.primary }]}
          onPress={() => router.push('/(tabs)/new-order' as never)}
        >
          <Feather name="plus" size={18} color="#fff" />
          <Text style={styles.newOrderText}>Create New Order for {customer.name.split(' ')[0]}</Text>
        </TouchableOpacity>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  header: {
    flexDirection: 'row', alignItems: 'center', gap: 14,
    paddingHorizontal: 16, paddingBottom: 14, borderBottomWidth: 1,
  },
  title: { fontSize: 18, fontFamily: 'Inter_700Bold' },
  content: { padding: 16, gap: 14 },
  profileCard: { borderRadius: 16, padding: 20, flexDirection: 'row', alignItems: 'center', gap: 14 },
  avatar: { width: 56, height: 56, borderRadius: 28, backgroundColor: 'rgba(255,255,255,0.25)', alignItems: 'center', justifyContent: 'center' },
  avatarText: { color: '#fff', fontSize: 22, fontFamily: 'Inter_700Bold' },
  profileInfo: { flex: 1, gap: 4 },
  nameRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  customerName: { color: '#fff', fontSize: 18, fontFamily: 'Inter_700Bold' },
  vipBadge: { backgroundColor: '#fef3c7', borderRadius: 6, paddingHorizontal: 6, paddingVertical: 2 },
  vipText: { color: '#92400e', fontSize: 11, fontFamily: 'Inter_700Bold' },
  customerPhone: { color: 'rgba(255,255,255,0.8)', fontSize: 14, fontFamily: 'Inter_400Regular' },
  statsRow: { flexDirection: 'row', gap: 10 },
  statCard: { flex: 1, borderRadius: 12, borderWidth: 1, padding: 16, gap: 4 },
  statValue: { fontSize: 20, fontFamily: 'Inter_700Bold' },
  statLabel: { fontSize: 12, fontFamily: 'Inter_400Regular' },
  section: { borderRadius: 12, borderWidth: 1, padding: 14 },
  sectionTitle: { fontSize: 14, fontFamily: 'Inter_700Bold', marginBottom: 8 },
  row: { flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 8, borderTopWidth: StyleSheet.hairlineWidth },
  rowLabel: { fontSize: 13, fontFamily: 'Inter_400Regular' },
  rowValue: { fontSize: 13, fontFamily: 'Inter_500Medium', maxWidth: '60%', textAlign: 'right' },
  notesText: { fontSize: 14, fontFamily: 'Inter_400Regular', lineHeight: 20 },
  ordersTitle: { fontSize: 15, fontFamily: 'Inter_700Bold', marginBottom: 8 },
  orderRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', borderRadius: 10, borderWidth: 1, padding: 12, marginBottom: 8 },
  orderNum: { fontSize: 14, fontFamily: 'Inter_600SemiBold' },
  orderDate: { fontSize: 12, fontFamily: 'Inter_400Regular' },
  orderRight: { flex: 1, alignItems: 'flex-end', gap: 4, marginRight: 8 },
  orderTotal: { fontSize: 14, fontFamily: 'Inter_600SemiBold' },
  emptyOrders: { borderRadius: 10, borderWidth: 1, padding: 20, alignItems: 'center' },
  emptyText: { fontSize: 14, fontFamily: 'Inter_400Regular' },
  newOrderBtn: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, borderRadius: 12, paddingVertical: 14 },
  newOrderText: { color: '#fff', fontSize: 15, fontFamily: 'Inter_700Bold' },
});

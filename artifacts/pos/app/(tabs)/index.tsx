import React, { useState } from 'react';
import {
  View, Text, StyleSheet, ScrollView, TouchableOpacity,
  Platform, FlatList, RefreshControl, ActivityIndicator,
} from 'react-native';
import { Feather } from '@expo/vector-icons';
import { router } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useColors } from '@/hooks/useColors';
import { StatCard } from '@/components/StatCard';
import { OrderCard } from '@/components/OrderCard';
import { SearchBar } from '@/components/SearchBar';
import { useLiveOrders } from '@/lib/api';
import { MOCK_AGENT } from '@/data/mock';
import type { Order } from '@/types';

export default function DashboardScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const [search, setSearch] = useState('');
  const { orders, loading, refreshing, error, refetch } = useLiveOrders();

  const topPad = Platform.OS === 'web' ? 67 : insets.top;

  const todayOrders = orders.length;
  const paidOrders = orders.filter(o => o.paymentStatus === 'paid').length;
  const pendingPayment = orders.filter(o => o.paymentStatus === 'awaiting_payment').length;
  const urgentOrders = orders.filter(o => o.isUrgent).length;

  const pendingPaymentOrders = orders.filter(o => o.paymentStatus === 'awaiting_payment');
  const urgentList = orders.filter(o => o.isUrgent);
  const issueList = orders.filter(o => o.hasIssue);
  const recentOrders = orders.slice(0, 5);

  const filtered = search
    ? orders.filter(o =>
        o.orderNumber.toLowerCase().includes(search.toLowerCase()) ||
        o.customer.name.toLowerCase().includes(search.toLowerCase()) ||
        o.recipient.name.toLowerCase().includes(search.toLowerCase()) ||
        o.customer.phone.includes(search)
      )
    : null;

  const today = new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });

  return (
    <View style={[styles.container, { backgroundColor: colors.background }]}>
      {/* Header */}
      <View style={[styles.header, { paddingTop: topPad + 12, backgroundColor: colors.card, borderBottomColor: colors.border }]}>
        <View style={styles.headerTop}>
          <View>
            <Text style={[styles.greeting, { color: colors.mutedForeground }]}>Good morning,</Text>
            <Text style={[styles.agentName, { color: colors.foreground }]}>{MOCK_AGENT.name}</Text>
          </View>
          <TouchableOpacity
            style={[styles.avatarBtn, { backgroundColor: colors.primary }]}
            onPress={() => router.push('/more' as never)}
          >
            <Text style={styles.avatarText}>S</Text>
          </TouchableOpacity>
        </View>
        <Text style={[styles.dateText, { color: colors.mutedForeground }]}>{today}</Text>
        <View style={styles.searchRow}>
          <View style={{ flex: 1 }}>
            <SearchBar
              value={search}
              onChangeText={setSearch}
              placeholder="Search orders, customers, phones..."
            />
          </View>
        </View>
      </View>

      {search ? (
        <FlatList
          data={filtered ?? []}
          keyExtractor={item => item.id}
          contentContainerStyle={[styles.listContent, { paddingBottom: insets.bottom + 80 }]}
          renderItem={({ item }) => (
            <OrderCard order={item} onPress={() => router.push(`/order/${item.id}` as never)} />
          )}
          ListEmptyComponent={
            <View style={styles.empty}>
              <Feather name="search" size={32} color={colors.mutedForeground} />
              <Text style={[styles.emptyText, { color: colors.mutedForeground }]}>No results found</Text>
            </View>
          }
        />
      ) : loading ? (
        <View style={styles.empty}>
          <ActivityIndicator size="large" color={colors.primary} />
          <Text style={[styles.emptyText, { color: colors.mutedForeground }]}>Loading orders…</Text>
        </View>
      ) : error ? (
        <View style={styles.empty}>
          <Feather name="alert-circle" size={40} color="#ef4343" />
          <Text style={[styles.emptyText, { color: colors.foreground }]}>Couldn't load orders</Text>
          <Text style={[styles.errorDetail, { color: colors.mutedForeground }]}>{error}</Text>
          <TouchableOpacity
            style={[styles.retryBtn, { backgroundColor: colors.primary }]}
            onPress={refetch}
          >
            <Feather name="refresh-cw" size={14} color="#fff" />
            <Text style={styles.retryText}>Retry</Text>
          </TouchableOpacity>
        </View>
      ) : (
        <ScrollView
          style={styles.scroll}
          contentContainerStyle={[styles.scrollContent, { paddingBottom: insets.bottom + 100 }]}
          showsVerticalScrollIndicator={false}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={refetch} tintColor={colors.primary} />}
        >
          {/* Stats */}
          <View style={styles.statsGrid}>
            <View style={styles.statsRow}>
              <StatCard label="Today's Orders" value={todayOrders} icon="shopping-bag" />
              <StatCard label="Paid" value={paidOrders} icon="check-circle" color="#16a34a" />
            </View>
            <View style={styles.statsRow}>
              <StatCard label="Pending Payment" value={pendingPayment} icon="clock" color="#d97706" />
              <StatCard label="Urgent" value={urgentOrders} icon="alert-circle" color="#ef4343" />
            </View>
          </View>

          {/* New Order CTA */}
          <TouchableOpacity
            style={[styles.newOrderBtn, { backgroundColor: colors.primary }]}
            onPress={() => router.push('/(tabs)/new-order' as never)}
            activeOpacity={0.85}
          >
            <Feather name="plus-circle" size={22} color="#fff" />
            <Text style={styles.newOrderText}>Create New Order</Text>
            <Feather name="chevron-right" size={20} color="rgba(255,255,255,0.7)" />
          </TouchableOpacity>

          {/* Pending Payments */}
          {pendingPaymentOrders.length > 0 && (
            <Section title="Pending Payments" icon="clock" color="#d97706" count={pendingPaymentOrders.length}>
              {pendingPaymentOrders.map(order => (
                <PendingPaymentCard key={order.id} order={order} colors={colors} />
              ))}
            </Section>
          )}

          {/* Urgent Orders */}
          {urgentList.length > 0 && (
            <Section title="Urgent Orders" icon="alert-circle" color="#ef4343" count={urgentList.length}>
              {urgentList.map(order => (
                <OrderCard key={order.id} order={order} onPress={() => router.push(`/order/${order.id}` as never)} />
              ))}
            </Section>
          )}

          {/* Issues */}
          {issueList.length > 0 && (
            <Section title="Orders With Issues" icon="alert-triangle" color="#ef4343" count={issueList.length}>
              {issueList.map(order => (
                <OrderCard key={order.id} order={order} onPress={() => router.push(`/order/${order.id}` as never)} />
              ))}
            </Section>
          )}

          {/* Recent Orders */}
          <Section title="Recent Orders" icon="list" color={colors.primary}>
            {recentOrders.map(order => (
              <OrderCard key={order.id} order={order} onPress={() => router.push(`/order/${order.id}` as never)} />
            ))}
            <TouchableOpacity
              style={[styles.viewAllBtn, { borderColor: colors.border }]}
              onPress={() => router.push('/(tabs)/orders' as never)}
            >
              <Text style={[styles.viewAllText, { color: colors.primary }]}>View All Orders</Text>
              <Feather name="chevron-right" size={15} color={colors.primary} />
            </TouchableOpacity>
          </Section>
        </ScrollView>
      )}
    </View>
  );
}

function Section({ title, icon, color, count, children }: {
  title: string; icon: React.ComponentProps<typeof Feather>['name'];
  color: string; count?: number; children: React.ReactNode;
}) {
  const colors = useColors();
  return (
    <View style={styles.section}>
      <View style={styles.sectionHeader}>
        <Feather name={icon} size={15} color={color} />
        <Text style={[styles.sectionTitle, { color: colors.foreground }]}>{title}</Text>
        {count !== undefined && (
          <View style={[styles.countBadge, { backgroundColor: color + '20' }]}>
            <Text style={[styles.countText, { color }]}>{count}</Text>
          </View>
        )}
      </View>
      {children}
    </View>
  );
}

function PendingPaymentCard({ order, colors }: { order: Order; colors: ReturnType<typeof useColors> }) {
  return (
    <TouchableOpacity
      style={[styles.pendingCard, { backgroundColor: colors.card, borderColor: colors.border }]}
      onPress={() => router.push(`/order/${order.id}` as never)}
      activeOpacity={0.7}
    >
      <View style={styles.pendingLeft}>
        <Text style={[styles.pendingOrderNum, { color: colors.foreground }]}>{order.orderNumber}</Text>
        <Text style={[styles.pendingCustomer, { color: colors.mutedForeground }]}>{order.customer.name}</Text>
      </View>
      <View style={styles.pendingRight}>
        <Text style={[styles.pendingAmount, { color: colors.foreground }]}>AED {order.total}</Text>
        <View style={[styles.resendBtn, { backgroundColor: colors.primary + '15', borderColor: colors.primary + '30' }]}>
          <Feather name="send" size={12} color={colors.primary} />
          <Text style={[styles.resendText, { color: colors.primary }]}>Resend</Text>
        </View>
      </View>
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  header: {
    paddingHorizontal: 16,
    paddingBottom: 12,
    borderBottomWidth: 1,
    gap: 6,
  },
  headerTop: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
  },
  greeting: { fontSize: 13, fontFamily: 'Inter_400Regular' },
  agentName: { fontSize: 20, fontFamily: 'Inter_700Bold', marginTop: 1 },
  avatarBtn: {
    width: 40, height: 40, borderRadius: 20,
    alignItems: 'center', justifyContent: 'center',
  },
  avatarText: { color: '#fff', fontSize: 16, fontFamily: 'Inter_700Bold' },
  dateText: { fontSize: 13, fontFamily: 'Inter_400Regular', marginBottom: 6 },
  searchRow: { flexDirection: 'row', gap: 10, alignItems: 'center' },
  scroll: { flex: 1 },
  scrollContent: { padding: 16, gap: 4 },
  statsGrid: { gap: 8, marginBottom: 16 },
  statsRow: { flexDirection: 'row', gap: 8 },
  newOrderBtn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
    gap: 10, borderRadius: 14, paddingVertical: 16, marginBottom: 20,
  },
  newOrderText: { color: '#fff', fontSize: 16, fontFamily: 'Inter_700Bold', flex: 1 },
  section: { marginBottom: 20 },
  sectionHeader: {
    flexDirection: 'row', alignItems: 'center', gap: 6,
    marginBottom: 10,
  },
  sectionTitle: { fontSize: 15, fontFamily: 'Inter_700Bold', flex: 1 },
  countBadge: { borderRadius: 10, paddingHorizontal: 7, paddingVertical: 2 },
  countText: { fontSize: 12, fontFamily: 'Inter_700Bold' },
  pendingCard: {
    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
    borderRadius: 12, borderWidth: 1, padding: 14, marginBottom: 8,
  },
  pendingLeft: { gap: 3 },
  pendingOrderNum: { fontSize: 14, fontFamily: 'Inter_700Bold' },
  pendingCustomer: { fontSize: 13, fontFamily: 'Inter_400Regular' },
  pendingRight: { alignItems: 'flex-end', gap: 6 },
  pendingAmount: { fontSize: 15, fontFamily: 'Inter_700Bold' },
  resendBtn: {
    flexDirection: 'row', alignItems: 'center', gap: 4,
    borderWidth: 1, borderRadius: 8, paddingHorizontal: 8, paddingVertical: 4,
  },
  resendText: { fontSize: 11, fontFamily: 'Inter_600SemiBold' },
  viewAllBtn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
    gap: 4, borderWidth: 1, borderRadius: 10, paddingVertical: 12, marginTop: 6,
  },
  viewAllText: { fontSize: 14, fontFamily: 'Inter_600SemiBold' },
  listContent: { padding: 16 },
  empty: { alignItems: 'center', paddingTop: 60, gap: 8 },
  emptyText: { fontSize: 15, fontFamily: 'Inter_500Medium' },
  errorDetail: { fontSize: 13, fontFamily: 'Inter_400Regular', textAlign: 'center', paddingHorizontal: 24 },
  retryBtn: {
    flexDirection: 'row', alignItems: 'center', gap: 6,
    borderRadius: 8, paddingHorizontal: 16, paddingVertical: 9, marginTop: 8,
  },
  retryText: { color: '#fff', fontSize: 14, fontFamily: 'Inter_600SemiBold' },
});

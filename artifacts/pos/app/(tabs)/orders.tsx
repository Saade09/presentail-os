import React, { useState, useMemo } from 'react';
import {
  View, Text, StyleSheet, FlatList, TouchableOpacity,
  ScrollView, Platform, ActivityIndicator, RefreshControl,
} from 'react-native';
import { Feather } from '@expo/vector-icons';
import { router } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useColors } from '@/hooks/useColors';
import { OrderCard } from '@/components/OrderCard';
import { SearchBar } from '@/components/SearchBar';
import { useLiveOrders } from '@/lib/api';
import type { OrderStatus } from '@/types';

const FILTERS: { label: string; value: OrderStatus | 'all' }[] = [
  { label: 'All', value: 'all' },
  { label: 'Draft', value: 'draft' },
  { label: 'Awaiting Payment', value: 'awaiting_payment' },
  { label: 'Paid', value: 'paid' },
  { label: 'Preparing', value: 'preparing' },
  { label: 'With Driver', value: 'with_driver' },
  { label: 'Delivered', value: 'delivered' },
  { label: 'Issues', value: 'issue_reported' },
];

export default function OrdersScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const topPad = Platform.OS === 'web' ? 67 : insets.top;
  const [search, setSearch] = useState('');
  const [activeFilter, setActiveFilter] = useState<OrderStatus | 'all'>('all');
  const { orders, loading, refreshing, error, refetch } = useLiveOrders();

  const filtered = useMemo(() => {
    let result = orders;
    if (activeFilter !== 'all') result = result.filter(o => o.status === activeFilter);
    if (search) {
      const q = search.toLowerCase();
      result = result.filter(o =>
        o.orderNumber.toLowerCase().includes(q) ||
        o.customer.name.toLowerCase().includes(q) ||
        o.recipient.name.toLowerCase().includes(q) ||
        o.recipient.city.toLowerCase().includes(q)
      );
    }
    return result;
  }, [orders, search, activeFilter]);

  return (
    <View style={[styles.container, { backgroundColor: colors.background }]}>
      <View style={[styles.header, { paddingTop: topPad + 12, backgroundColor: colors.card, borderBottomColor: colors.border }]}>
        <View style={styles.headerRow}>
          <Text style={[styles.title, { color: colors.foreground }]}>Orders</Text>
          <TouchableOpacity
            style={[styles.newBtn, { backgroundColor: colors.primary }]}
            onPress={() => router.push('/(tabs)/new-order' as never)}
          >
            <Feather name="plus" size={16} color="#fff" />
            <Text style={styles.newBtnText}>New</Text>
          </TouchableOpacity>
        </View>
        <SearchBar value={search} onChangeText={setSearch} placeholder="Search orders..." />
        <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.filterScroll} contentContainerStyle={styles.filterContent}>
          {FILTERS.map(f => (
            <TouchableOpacity
              key={f.value}
              style={[styles.chip, {
                backgroundColor: activeFilter === f.value ? colors.primary : colors.secondary,
                borderColor: activeFilter === f.value ? colors.primary : colors.border,
              }]}
              onPress={() => setActiveFilter(f.value)}
            >
              <Text style={[styles.chipText, { color: activeFilter === f.value ? '#fff' : colors.mutedForeground }]}>
                {f.label}
              </Text>
            </TouchableOpacity>
          ))}
        </ScrollView>
      </View>

      {loading ? (
        <View style={styles.empty}>
          <ActivityIndicator size="large" color={colors.primary} />
          <Text style={[styles.emptyText, { color: colors.mutedForeground }]}>Loading orders…</Text>
        </View>
      ) : (
        <FlatList
          data={filtered}
          keyExtractor={item => item.id}
          contentContainerStyle={[styles.list, { paddingBottom: insets.bottom + 90 }]}
          refreshControl={
            <RefreshControl refreshing={refreshing} onRefresh={refetch} tintColor={colors.primary} />
          }
          renderItem={({ item }) => (
            <OrderCard order={item} onPress={() => router.push(`/order/${item.id}` as never)} />
          )}
          ListEmptyComponent={
            error ? (
              <View style={styles.empty}>
                <Feather name="alert-circle" size={40} color="#ef4343" />
                <Text style={[styles.emptyTitle, { color: colors.foreground }]}>Couldn't load orders</Text>
                <Text style={[styles.emptyText, { color: colors.mutedForeground }]}>{error}</Text>
                <TouchableOpacity
                  style={[styles.retryBtn, { backgroundColor: colors.primary }]}
                  onPress={refetch}
                >
                  <Feather name="refresh-cw" size={14} color="#fff" />
                  <Text style={styles.retryText}>Retry</Text>
                </TouchableOpacity>
              </View>
            ) : (
              <View style={styles.empty}>
                <Feather name="inbox" size={40} color={colors.mutedForeground} />
                <Text style={[styles.emptyTitle, { color: colors.foreground }]}>No orders found</Text>
                <Text style={[styles.emptyText, { color: colors.mutedForeground }]}>Try adjusting your filters</Text>
              </View>
            )
          }
          showsVerticalScrollIndicator={false}
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  header: {
    paddingHorizontal: 16,
    paddingBottom: 12,
    borderBottomWidth: 1,
    gap: 10,
  },
  headerRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  title: { fontSize: 24, fontFamily: 'Inter_700Bold' },
  newBtn: {
    flexDirection: 'row', alignItems: 'center', gap: 4,
    borderRadius: 8, paddingHorizontal: 12, paddingVertical: 7,
  },
  newBtnText: { color: '#fff', fontSize: 14, fontFamily: 'Inter_600SemiBold' },
  filterScroll: { marginHorizontal: -4 },
  filterContent: { paddingHorizontal: 4, gap: 6, flexDirection: 'row' },
  chip: {
    borderRadius: 20, paddingHorizontal: 12, paddingVertical: 6,
    borderWidth: 1,
  },
  chipText: { fontSize: 13, fontFamily: 'Inter_500Medium' },
  list: { padding: 16 },
  empty: { alignItems: 'center', paddingTop: 80, gap: 8 },
  emptyTitle: { fontSize: 17, fontFamily: 'Inter_600SemiBold', marginTop: 8 },
  emptyText: { fontSize: 14, fontFamily: 'Inter_400Regular', textAlign: 'center', paddingHorizontal: 24 },
  retryBtn: {
    flexDirection: 'row', alignItems: 'center', gap: 6,
    borderRadius: 8, paddingHorizontal: 16, paddingVertical: 9, marginTop: 8,
  },
  retryText: { color: '#fff', fontSize: 14, fontFamily: 'Inter_600SemiBold' },
});

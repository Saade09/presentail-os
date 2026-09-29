import React from 'react';
import { View, Text, StyleSheet, TouchableOpacity, ScrollView, Platform } from 'react-native';
import { Feather } from '@expo/vector-icons';
import { router } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useColors } from '@/hooks/useColors';
import { MOCK_AGENT } from '@/data/mock';

const MENU_ITEMS = [
  { id: 'customers', title: 'Customers', subtitle: 'Search and view customer profiles', icon: 'users' as const, route: '/customer/c1' },
  { id: 'conversation', title: 'Conversation Helper', subtitle: 'Canned replies for WhatsApp & Instagram', icon: 'message-circle' as const, route: '/conversation' },
  { id: 'manager', title: 'Manager Queue', subtitle: 'Approve refunds and discount requests', icon: 'shield' as const, route: '/manager' },
  { id: 'settings', title: 'Settings', subtitle: 'Delivery cities, canned replies, permissions', icon: 'settings' as const, route: '/settings' },
];

export default function MoreScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const topPad = Platform.OS === 'web' ? 67 : insets.top;

  return (
    <View style={[styles.container, { backgroundColor: colors.background }]}>
      <View style={[styles.header, { paddingTop: topPad + 12, backgroundColor: colors.card, borderBottomColor: colors.border }]}>
        <Text style={[styles.title, { color: colors.foreground }]}>More</Text>
      </View>
      <ScrollView
        contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + 90 }]}
        showsVerticalScrollIndicator={false}
      >
        {/* Profile card */}
        <View style={[styles.profileCard, { backgroundColor: colors.primary }]}>
          <View style={styles.avatar}>
            <Text style={styles.avatarText}>{MOCK_AGENT.name[0]}</Text>
          </View>
          <View>
            <Text style={styles.agentName}>{MOCK_AGENT.name}</Text>
            <Text style={styles.agentRole}>Customer Service Agent</Text>
          </View>
        </View>

        {/* Menu items */}
        <View style={styles.menuSection}>
          {MENU_ITEMS.map(item => (
            <TouchableOpacity
              key={item.id}
              style={[styles.menuItem, { backgroundColor: colors.card, borderColor: colors.border }]}
              onPress={() => router.push(item.route as never)}
              activeOpacity={0.7}
            >
              <View style={[styles.menuIcon, { backgroundColor: colors.primary + '15' }]}>
                <Feather name={item.icon} size={20} color={colors.primary} />
              </View>
              <View style={styles.menuText}>
                <Text style={[styles.menuTitle, { color: colors.foreground }]}>{item.title}</Text>
                <Text style={[styles.menuSubtitle, { color: colors.mutedForeground }]} numberOfLines={1}>{item.subtitle}</Text>
              </View>
              <Feather name="chevron-right" size={18} color={colors.mutedForeground} />
            </TouchableOpacity>
          ))}
        </View>

        {/* Quick Stats */}
        <View style={styles.statsSection}>
          <Text style={[styles.statsTitle, { color: colors.foreground }]}>Today at a Glance</Text>
          <View style={[styles.statsCard, { backgroundColor: colors.card, borderColor: colors.border }]}>
            {[
              { label: 'Orders Handled', value: '6' },
              { label: 'Payment Links Sent', value: '3' },
              { label: 'Issues Resolved', value: '1' },
            ].map((s, i) => (
              <View key={i} style={[styles.statRow, i > 0 && { borderTopWidth: 1, borderTopColor: colors.border }]}>
                <Text style={[styles.statLabel, { color: colors.mutedForeground }]}>{s.label}</Text>
                <Text style={[styles.statValue, { color: colors.foreground }]}>{s.value}</Text>
              </View>
            ))}
          </View>
        </View>

        <View style={[styles.versionRow]}>
          <Text style={[styles.version, { color: colors.mutedForeground }]}>Presentail POS v1.0</Text>
        </View>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  header: { paddingHorizontal: 16, paddingBottom: 14, borderBottomWidth: 1 },
  title: { fontSize: 24, fontFamily: 'Inter_700Bold' },
  content: { padding: 16, gap: 16 },
  profileCard: {
    flexDirection: 'row', alignItems: 'center', gap: 14,
    borderRadius: 16, padding: 18,
  },
  avatar: { width: 48, height: 48, borderRadius: 24, backgroundColor: 'rgba(255,255,255,0.25)', alignItems: 'center', justifyContent: 'center' },
  avatarText: { color: '#fff', fontSize: 20, fontFamily: 'Inter_700Bold' },
  agentName: { color: '#fff', fontSize: 17, fontFamily: 'Inter_700Bold' },
  agentRole: { color: 'rgba(255,255,255,0.75)', fontSize: 13, fontFamily: 'Inter_400Regular', marginTop: 2 },
  menuSection: { gap: 8 },
  menuItem: {
    flexDirection: 'row', alignItems: 'center', gap: 12,
    borderRadius: 12, borderWidth: 1, padding: 14,
  },
  menuIcon: { width: 40, height: 40, borderRadius: 10, alignItems: 'center', justifyContent: 'center' },
  menuText: { flex: 1 },
  menuTitle: { fontSize: 15, fontFamily: 'Inter_600SemiBold' },
  menuSubtitle: { fontSize: 12, fontFamily: 'Inter_400Regular', marginTop: 2 },
  statsSection: { gap: 10 },
  statsTitle: { fontSize: 15, fontFamily: 'Inter_700Bold' },
  statsCard: { borderRadius: 12, borderWidth: 1, overflow: 'hidden' },
  statRow: { flexDirection: 'row', justifyContent: 'space-between', padding: 14 },
  statLabel: { fontSize: 14, fontFamily: 'Inter_400Regular' },
  statValue: { fontSize: 15, fontFamily: 'Inter_700Bold' },
  versionRow: { alignItems: 'center', paddingVertical: 8 },
  version: { fontSize: 12, fontFamily: 'Inter_400Regular' },
});

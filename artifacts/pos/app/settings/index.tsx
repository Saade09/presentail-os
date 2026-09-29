import React from 'react';
import { View, Text, StyleSheet, ScrollView, TouchableOpacity, Platform, ActivityIndicator } from 'react-native';
import { Feather } from '@expo/vector-icons';
import { router } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useColors } from '@/hooks/useColors';
import { useLiveDeliveryCities } from '@/lib/api';

export default function SettingsScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const topPad = Platform.OS === 'web' ? 67 : insets.top;
  const { cities, loading, error } = useLiveDeliveryCities();

  return (
    <View style={[styles.container, { backgroundColor: colors.background }]}>
      <View style={[styles.header, { paddingTop: topPad + 10, backgroundColor: colors.card, borderBottomColor: colors.border }]}>
        <TouchableOpacity onPress={() => router.back()} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
          <Feather name="arrow-left" size={22} color={colors.foreground} />
        </TouchableOpacity>
        <Text style={[styles.title, { color: colors.foreground }]}>Settings</Text>
      </View>
      <ScrollView contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + 30 }]} showsVerticalScrollIndicator={false}>
        {/* Delivery Cities */}
        <View style={styles.section}>
          <Text style={[styles.sectionTitle, { color: colors.foreground }]}>Delivery Cities</Text>
          {loading && (
            <View style={[styles.statusBox, { backgroundColor: colors.card, borderColor: colors.border }]}>
              <ActivityIndicator size="small" color={colors.primary} />
              <Text style={[styles.statusText, { color: colors.mutedForeground }]}>Loading cities...</Text>
            </View>
          )}
          {!loading && error && (
            <View style={[styles.statusBox, { backgroundColor: '#fee2e2', borderColor: '#fca5a5' }]}>
              <Feather name="alert-circle" size={16} color="#ef4343" />
              <Text style={[styles.statusText, { color: '#991b1b' }]}>Could not load cities: {error}</Text>
            </View>
          )}
          {!loading && !error && cities.map(city => (
            <View key={city.id} style={[styles.cityCard, { backgroundColor: colors.card, borderColor: colors.border }]}>
              <View style={styles.cityHeader}>
                <View style={[styles.cityActive, { backgroundColor: city.isActive ? '#dcfce7' : '#fee2e2' }]}>
                  <Feather name={city.isActive ? 'check-circle' : 'x-circle'} size={14} color={city.isActive ? '#16a34a' : '#ef4343'} />
                </View>
                <Text style={[styles.cityName, { color: colors.foreground }]}>{city.name}</Text>
                <Text style={[styles.cityFee, { color: colors.primary }]}>AED {city.deliveryFee}</Text>
              </View>
              <View style={styles.cityDetails}>
                <Text style={[styles.cityDetail, { color: colors.mutedForeground }]}>
                  Free delivery: {city.freeDeliveryEnabled ? `above AED ${city.freeDeliveryThreshold}` : 'Disabled'}
                </Text>
                <Text style={[styles.cityDetail, { color: colors.mutedForeground }]}>
                  Express: {city.expressAvailable ? `AED ${city.expressFee} (cutoff ${city.expressCutoffTime})` : 'Not available'}
                </Text>
              </View>
            </View>
          ))}
        </View>

        {/* Other settings */}
        {[
          { title: 'Payment Methods', desc: 'Configure accepted payment options' },
          { title: 'Canned Replies', desc: 'Manage conversation templates' },
          { title: 'Occasions', desc: 'Manage occasion types' },
          { title: 'Agent Permissions', desc: 'Configure role-based access' },
          { title: 'Order Sources', desc: 'Manage order channel types' },
        ].map(item => (
          <TouchableOpacity
            key={item.title}
            style={[styles.settingRow, { backgroundColor: colors.card, borderColor: colors.border }]}
          >
            <View style={styles.settingText}>
              <Text style={[styles.settingTitle, { color: colors.foreground }]}>{item.title}</Text>
              <Text style={[styles.settingDesc, { color: colors.mutedForeground }]}>{item.desc}</Text>
            </View>
            <Feather name="chevron-right" size={18} color={colors.mutedForeground} />
          </TouchableOpacity>
        ))}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  header: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 16, paddingBottom: 14, borderBottomWidth: 1 },
  title: { fontSize: 18, fontFamily: 'Inter_700Bold' },
  content: { padding: 16, gap: 16 },
  section: { gap: 8 },
  sectionTitle: { fontSize: 15, fontFamily: 'Inter_700Bold', marginBottom: 4 },
  cityCard: { borderRadius: 12, borderWidth: 1, padding: 12, gap: 8 },
  cityHeader: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  cityActive: { width: 24, height: 24, borderRadius: 12, alignItems: 'center', justifyContent: 'center' },
  cityName: { fontSize: 15, fontFamily: 'Inter_600SemiBold', flex: 1 },
  cityFee: { fontSize: 14, fontFamily: 'Inter_700Bold' },
  cityDetails: { gap: 2, paddingLeft: 32 },
  cityDetail: { fontSize: 12, fontFamily: 'Inter_400Regular' },
  statusBox: { flexDirection: 'row', alignItems: 'center', gap: 8, borderWidth: 1, borderRadius: 12, padding: 12 },
  statusText: { fontSize: 13, fontFamily: 'Inter_400Regular', flex: 1 },
  settingRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', borderRadius: 12, borderWidth: 1, padding: 14 },
  settingText: { flex: 1, gap: 2 },
  settingTitle: { fontSize: 15, fontFamily: 'Inter_600SemiBold' },
  settingDesc: { fontSize: 12, fontFamily: 'Inter_400Regular' },
});

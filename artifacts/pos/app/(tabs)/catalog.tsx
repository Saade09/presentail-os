import React, { useState, useMemo } from 'react';
import {
  View, Text, StyleSheet, FlatList, TouchableOpacity,
  ScrollView, Platform,
} from 'react-native';
import { Feather } from '@expo/vector-icons';
import { router } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useColors } from '@/hooks/useColors';
import { ProductCard } from '@/components/ProductCard';
import { SearchBar } from '@/components/SearchBar';
import { PRODUCTS, PRODUCT_CATEGORIES } from '@/data/mock';

export default function CatalogScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const topPad = Platform.OS === 'web' ? 67 : insets.top;
  const [search, setSearch] = useState('');
  const [category, setCategory] = useState('All');

  const filtered = useMemo(() => {
    let r = PRODUCTS;
    if (category !== 'All') r = r.filter(p => p.category === category);
    if (search) {
      const q = search.toLowerCase();
      r = r.filter(p => p.name.toLowerCase().includes(q) || p.category.toLowerCase().includes(q));
    }
    return r;
  }, [search, category]);

  return (
    <View style={[styles.container, { backgroundColor: colors.background }]}>
      <View style={[styles.header, { paddingTop: topPad + 12, backgroundColor: colors.card, borderBottomColor: colors.border }]}>
        <Text style={[styles.title, { color: colors.foreground }]}>Product Catalog</Text>
        <SearchBar value={search} onChangeText={setSearch} placeholder="Search products..." />
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.catContent}>
          {PRODUCT_CATEGORIES.map(cat => (
            <TouchableOpacity
              key={cat}
              style={[styles.chip, {
                backgroundColor: category === cat ? colors.primary : colors.secondary,
                borderColor: category === cat ? colors.primary : colors.border,
              }]}
              onPress={() => setCategory(cat)}
            >
              <Text style={[styles.chipText, { color: category === cat ? '#fff' : colors.mutedForeground }]}>
                {cat}
              </Text>
            </TouchableOpacity>
          ))}
        </ScrollView>
      </View>

      <FlatList
        data={filtered}
        keyExtractor={item => item.id}
        numColumns={2}
        contentContainerStyle={[styles.grid, { paddingBottom: insets.bottom + 90 }]}
        columnWrapperStyle={styles.row}
        renderItem={({ item }) => (
          <ProductCard
            product={item}
            onPress={() => router.push(`/product/${item.id}` as any)}
            onAdd={() => router.push(`/product/${item.id}` as any)}
          />
        )}
        ListEmptyComponent={
          <View style={styles.empty}>
            <Feather name="package" size={40} color={colors.mutedForeground} />
            <Text style={[styles.emptyText, { color: colors.mutedForeground }]}>No products found</Text>
          </View>
        }
        showsVerticalScrollIndicator={false}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  header: {
    paddingHorizontal: 16, paddingBottom: 12,
    borderBottomWidth: 1, gap: 10,
  },
  title: { fontSize: 24, fontFamily: 'Inter_700Bold' },
  catContent: { gap: 6, flexDirection: 'row', paddingBottom: 4 },
  chip: { borderRadius: 20, paddingHorizontal: 12, paddingVertical: 6, borderWidth: 1 },
  chipText: { fontSize: 13, fontFamily: 'Inter_500Medium' },
  grid: { padding: 8 },
  row: { justifyContent: 'space-between' },
  empty: { alignItems: 'center', paddingTop: 80, gap: 8 },
  emptyText: { fontSize: 15, fontFamily: 'Inter_500Medium' },
});

import React from 'react';
import { View, Text, StyleSheet, TouchableOpacity, Image } from 'react-native';
import { Feather } from '@expo/vector-icons';
import { useColors } from '@/hooks/useColors';
import type { Product } from '@/types';

interface Props {
  product: Product;
  onAdd?: () => void;
  onPress?: () => void;
  showAdd?: boolean;
}

export function ProductCard({ product, onAdd, onPress, showAdd = true }: Props) {
  const colors = useColors();
  const isUnavailable = product.availability !== 'available';

  return (
    <TouchableOpacity
      style={[styles.card, { backgroundColor: colors.card, borderColor: colors.border }]}
      onPress={onPress}
      activeOpacity={0.75}
    >
      <View style={styles.imageContainer}>
        <Image
          source={{ uri: product.image }}
          style={[styles.image, isUnavailable && styles.dimmed]}
          resizeMode="cover"
        />
        {isUnavailable && (
          <View style={styles.unavailableBadge}>
            <Text style={styles.unavailableText}>Out of Stock</Text>
          </View>
        )}
        <View style={[styles.categoryBadge, { backgroundColor: colors.background }]}>
          <Text style={[styles.categoryText, { color: colors.mutedForeground }]}>{product.category}</Text>
        </View>
      </View>

      <View style={styles.info}>
        <Text style={[styles.name, { color: colors.foreground }]} numberOfLines={2}>{product.name}</Text>
        <View style={styles.priceRow}>
          <Text style={[styles.price, { color: colors.primary }]}>AED {product.price}</Text>
          {showAdd && !isUnavailable && (
            <TouchableOpacity
              style={[styles.addBtn, { backgroundColor: colors.primary }]}
              onPress={onAdd}
              hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
            >
              <Feather name="plus" size={16} color="#fff" />
            </TouchableOpacity>
          )}
        </View>
      </View>
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  card: {
    borderRadius: 12,
    borderWidth: 1,
    overflow: 'hidden',
    flex: 1,
    margin: 4,
  },
  imageContainer: {
    position: 'relative',
  },
  image: {
    width: '100%',
    aspectRatio: 1,
    backgroundColor: '#f8f9fa',
  },
  dimmed: {
    opacity: 0.5,
  },
  unavailableBadge: {
    position: 'absolute',
    top: 8,
    left: 8,
    backgroundColor: 'rgba(0,0,0,0.6)',
    borderRadius: 8,
    paddingHorizontal: 6,
    paddingVertical: 2,
  },
  unavailableText: {
    color: '#fff',
    fontSize: 10,
    fontFamily: 'Inter_600SemiBold',
  },
  categoryBadge: {
    position: 'absolute',
    bottom: 6,
    right: 6,
    borderRadius: 6,
    paddingHorizontal: 5,
    paddingVertical: 2,
    opacity: 0.9,
  },
  categoryText: {
    fontSize: 10,
    fontFamily: 'Inter_500Medium',
  },
  info: {
    padding: 10,
    gap: 6,
  },
  name: {
    fontSize: 13,
    fontFamily: 'Inter_600SemiBold',
    lineHeight: 18,
  },
  priceRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  price: {
    fontSize: 14,
    fontFamily: 'Inter_700Bold',
  },
  addBtn: {
    width: 28,
    height: 28,
    borderRadius: 8,
    alignItems: 'center',
    justifyContent: 'center',
  },
});

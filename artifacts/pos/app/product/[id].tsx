import React, { useState, useMemo } from 'react';
import {
  View, Text, StyleSheet, ScrollView, TouchableOpacity,
  Image, Platform, Alert,
} from 'react-native';
import { Feather } from '@expo/vector-icons';
import { router, useLocalSearchParams } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import * as Haptics from 'expo-haptics';
import { useColors } from '@/hooks/useColors';
import { PRODUCTS, ADD_ONS } from '@/data/mock';
import type { Product, ProductVariant, AddOn } from '@/types';

export default function ProductDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const topPad = Platform.OS === 'web' ? 67 : insets.top;
  const bottomPad = Platform.OS === 'web' ? 34 : insets.bottom;

  const product = PRODUCTS.find(p => p.id === id);
  const [selectedVariant, setSelectedVariant] = useState<ProductVariant | null>(null);
  const [quantity, setQuantity] = useState(1);
  const [selectedAddOns, setSelectedAddOns] = useState<string[]>([]);

  const unitPrice = useMemo(() => {
    if (selectedVariant) return selectedVariant.price;
    return product?.price ?? 0;
  }, [selectedVariant, product]);

  const addOnsTotal = useMemo(() => {
    return selectedAddOns.reduce((sum, addonId) => {
      const addon = ADD_ONS.find(a => a.id === addonId);
      return sum + (addon?.price ?? 0);
    }, 0);
  }, [selectedAddOns]);

  const total = (unitPrice * quantity) + (addOnsTotal * quantity);

  if (!product) {
    return (
      <View style={[styles.container, { backgroundColor: colors.background }]}>
        <View style={[styles.header, { paddingTop: topPad + 10, backgroundColor: colors.card }]}>
          <TouchableOpacity onPress={() => router.back()} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
            <Feather name="arrow-left" size={22} color={colors.foreground} />
          </TouchableOpacity>
        </View>
        <View style={styles.center}>
          <Feather name="package" size={40} color={colors.mutedForeground} />
          <Text style={[styles.notFound, { color: colors.mutedForeground }]}>Product not found</Text>
        </View>
      </View>
    );
  }

  const isAvailable = product.availability === 'available';

  const toggleAddOn = (addonId: string) => {
    setSelectedAddOns(prev =>
      prev.includes(addonId) ? prev.filter(id => id !== addonId) : [...prev, addonId]
    );
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
  };

  const addToOrder = () => {
    if (!isAvailable) return;
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    // Navigate to new order with product pre-filled
    const orderItems = JSON.stringify([{
      id: `oi-${Date.now()}`,
      product,
      quantity,
      variant: selectedVariant ?? undefined,
      unitPrice,
    }]);
    const orderAddOns = JSON.stringify(
      selectedAddOns.map(id => {
        const addon = ADD_ONS.find(a => a.id === id);
        return addon ? { ...addon, quantity } : null;
      }).filter(Boolean)
    );
    router.push({
      pathname: '/(tabs)/new-order' as any,
      params: {
        prefillProduct: 'true',
        items: orderItems,
        addOns: orderAddOns,
      },
    });
  };

  return (
    <View style={[styles.container, { backgroundColor: colors.background }]}>
      {/* Header */}
      <View style={[styles.header, { paddingTop: topPad + 10, backgroundColor: colors.card, borderBottomColor: colors.border }]}>
        <View style={styles.headerRow}>
          <TouchableOpacity onPress={() => router.back()} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
            <Feather name="arrow-left" size={22} color={colors.foreground} />
          </TouchableOpacity>
          <Text style={[styles.headerTitle, { color: colors.foreground }]} numberOfLines={1}>
            {product.name}
          </Text>
          <View style={{ width: 22 }} />
        </View>
      </View>

      <ScrollView
        style={styles.scroll}
        contentContainerStyle={{ paddingBottom: bottomPad + 100 }}
        showsVerticalScrollIndicator={false}
      >
        {/* Product Image */}
        <Image source={{ uri: product.image }} style={styles.heroImage} resizeMode="cover" />

        {/* Info Section */}
        <View style={[styles.infoCard, { backgroundColor: colors.card, borderColor: colors.border }]}>
          <View style={styles.nameRow}>
            <View style={{ flex: 1 }}>
              <Text style={[styles.productName, { color: colors.foreground }]}>{product.name}</Text>
              <Text style={[styles.category, { color: colors.mutedForeground }]}>{product.category}</Text>
            </View>
            <View style={[styles.availabilityBadge, {
              backgroundColor: isAvailable ? '#dcfce7' : '#fee2e2',
            }]}>
              <Text style={[styles.availabilityText, {
                color: isAvailable ? '#166534' : '#991b1b',
              }]}>
                {isAvailable ? 'In Stock' : 'Out of Stock'}
              </Text>
            </View>
          </View>

          {product.description && (
            <Text style={[styles.description, { color: colors.mutedForeground }]}>{product.description}</Text>
          )}

          {/* Price */}
          <View style={styles.priceRow}>
            <Text style={[styles.price, { color: colors.primary }]}>
              AED {unitPrice.toFixed(0)}
            </Text>
            {selectedVariant && (
              <Text style={[styles.originalPrice, { color: colors.mutedForeground }]}>
                Was AED {product.price.toFixed(0)}
              </Text>
            )}
          </View>

          {/* Cities */}
          <View style={styles.citiesSection}>
            <Text style={[styles.sectionLabel, { color: colors.foreground }]}>Available in</Text>
            <View style={styles.citiesRow}>
              {product.cities.map(city => (
                <View key={city} style={[styles.cityTag, { backgroundColor: colors.secondary }]}>
                  <Text style={[styles.cityText, { color: colors.secondaryForeground }]}>{city}</Text>
                </View>
              ))}
            </View>
          </View>
        </View>

        {/* Variants */}
        {product.variants && product.variants.length > 0 && (
          <View style={[styles.sectionCard, { backgroundColor: colors.card, borderColor: colors.border }]}>
            <Text style={[styles.sectionTitle, { color: colors.foreground }]}>Select Variant</Text>
            <View style={styles.variantsGrid}>
              {product.variants.map(variant => (
                <TouchableOpacity
                  key={variant.id}
                  style={[styles.variantTile, {
                    backgroundColor: selectedVariant?.id === variant.id ? colors.primary + '12' : colors.secondary,
                    borderColor: selectedVariant?.id === variant.id ? colors.primary : colors.border,
                  }]}
                  onPress={() => {
                    setSelectedVariant(variant);
                    Haptics.selectionAsync();
                  }}
                >
                  <Text style={[styles.variantName, { color: colors.foreground }]}>{variant.name}</Text>
                  <Text style={[styles.variantPrice, { color: colors.primary }]}>AED {variant.price}</Text>
                </TouchableOpacity>
              ))}
            </View>
          </View>
        )}

        {/* Add-ons */}
        <View style={[styles.sectionCard, { backgroundColor: colors.card, borderColor: colors.border }]}>
          <Text style={[styles.sectionTitle, { color: colors.foreground }]}>Add-ons</Text>
          {ADD_ONS.map(addon => {
            const selected = selectedAddOns.includes(addon.id);
            return (
              <TouchableOpacity
                key={addon.id}
                style={[styles.addOnRow, {
                  backgroundColor: selected ? colors.primary + '08' : 'transparent',
                  borderColor: selected ? colors.primary : colors.border,
                }]}
                onPress={() => toggleAddOn(addon.id)}
              >
                <View style={[styles.addOnCheck, {
                  backgroundColor: selected ? colors.primary : colors.secondary,
                  borderColor: selected ? colors.primary : colors.border,
                }]}>
                  {selected && <Feather name="check" size={12} color="#fff" />}
                </View>
                <Text style={[styles.addOnName, { color: colors.foreground }]}>{addon.name}</Text>
                <Text style={[styles.addOnPrice, { color: colors.mutedForeground }]}>AED {addon.price}</Text>
              </TouchableOpacity>
            );
          })}
        </View>

        {/* Quantity */}
        <View style={[styles.sectionCard, { backgroundColor: colors.card, borderColor: colors.border }]}>
          <Text style={[styles.sectionTitle, { color: colors.foreground }]}>Quantity</Text>
          <View style={styles.quantityRow}>
            <TouchableOpacity
              style={[styles.qtyBtn, { borderColor: colors.border }]}
              onPress={() => setQuantity(q => Math.max(1, q - 1))}
              disabled={quantity <= 1}
            >
              <Feather name="minus" size={18} color={quantity <= 1 ? colors.mutedForeground : colors.foreground} />
            </TouchableOpacity>
            <Text style={[styles.qtyValue, { color: colors.foreground }]}>{quantity}</Text>
            <TouchableOpacity
              style={[styles.qtyBtn, { borderColor: colors.border }]}
              onPress={() => setQuantity(q => q + 1)}
            >
              <Feather name="plus" size={18} color={colors.foreground} />
            </TouchableOpacity>
          </View>
        </View>

        {/* Tags */}
        {product.tags && product.tags.length > 0 && (
          <View style={[styles.sectionCard, { backgroundColor: colors.card, borderColor: colors.border }]}>
            <Text style={[styles.sectionTitle, { color: colors.foreground }]}>Tags</Text>
            <View style={styles.tagsRow}>
              {product.tags.map(tag => (
                <View key={tag} style={[styles.tag, { backgroundColor: colors.secondary }]}>
                  <Text style={[styles.tagText, { color: colors.secondaryForeground }]}>{tag}</Text>
                </View>
              ))}
            </View>
          </View>
        )}
      </ScrollView>

      {/* Bottom Action Bar */}
      <View style={[styles.bottomBar, {
        backgroundColor: colors.card,
        borderTopColor: colors.border,
        paddingBottom: bottomPad + 8,
      }]}>
        <View style={styles.bottomRow}>
          <View style={styles.totalSection}>
            <Text style={[styles.totalLabel, { color: colors.mutedForeground }]}>Total</Text>
            <Text style={[styles.totalValue, { color: colors.foreground }]}>AED {total.toFixed(0)}</Text>
          </View>
          <TouchableOpacity
            style={[styles.addBtn, {
              backgroundColor: isAvailable ? colors.primary : colors.muted,
              opacity: isAvailable ? 1 : 0.6,
            }]}
            onPress={addToOrder}
            disabled={!isAvailable}
          >
            <Feather name="shopping-cart" size={18} color="#fff" />
            <Text style={styles.addBtnText}>Add to Order</Text>
          </TouchableOpacity>
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  header: {
    paddingHorizontal: 16,
    paddingBottom: 12,
    borderBottomWidth: 1,
  },
  headerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  headerTitle: {
    fontSize: 16,
    fontFamily: 'Inter_700Bold',
    flex: 1,
    textAlign: 'center',
    marginHorizontal: 12,
  },
  scroll: { flex: 1 },
  center: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 12,
  },
  notFound: {
    fontSize: 16,
    fontFamily: 'Inter_500Medium',
  },
  heroImage: {
    width: '100%',
    aspectRatio: 1.2,
    backgroundColor: '#f8f9fa',
  },
  infoCard: {
    margin: 12,
    borderRadius: 12,
    borderWidth: 1,
    padding: 14,
    gap: 10,
  },
  nameRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
  },
  productName: {
    fontSize: 20,
    fontFamily: 'Inter_700Bold',
    flex: 1,
  },
  category: {
    fontSize: 13,
    fontFamily: 'Inter_400Regular',
    marginTop: 2,
  },
  availabilityBadge: {
    borderRadius: 20,
    paddingHorizontal: 10,
    paddingVertical: 4,
  },
  availabilityText: {
    fontSize: 11,
    fontFamily: 'Inter_600SemiBold',
  },
  description: {
    fontSize: 14,
    fontFamily: 'Inter_400Regular',
    lineHeight: 20,
  },
  priceRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  price: {
    fontSize: 24,
    fontFamily: 'Inter_700Bold',
  },
  originalPrice: {
    fontSize: 14,
    fontFamily: 'Inter_400Regular',
    textDecorationLine: 'line-through',
  },
  citiesSection: {
    marginTop: 4,
  },
  sectionLabel: {
    fontSize: 12,
    fontFamily: 'Inter_600SemiBold',
    marginBottom: 6,
  },
  citiesRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 6,
  },
  cityTag: {
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 4,
  },
  cityText: {
    fontSize: 12,
    fontFamily: 'Inter_500Medium',
  },
  sectionCard: {
    margin: 12,
    marginTop: 0,
    borderRadius: 12,
    borderWidth: 1,
    padding: 14,
    gap: 8,
  },
  sectionTitle: {
    fontSize: 15,
    fontFamily: 'Inter_700Bold',
    marginBottom: 4,
  },
  variantsGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
  },
  variantTile: {
    borderRadius: 10,
    borderWidth: 1.5,
    padding: 12,
    minWidth: 100,
    alignItems: 'center',
    gap: 4,
  },
  variantName: {
    fontSize: 13,
    fontFamily: 'Inter_600SemiBold',
  },
  variantPrice: {
    fontSize: 14,
    fontFamily: 'Inter_700Bold',
  },
  addOnRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    borderRadius: 10,
    borderWidth: 1,
    padding: 10,
  },
  addOnCheck: {
    width: 22,
    height: 22,
    borderRadius: 6,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  addOnName: {
    fontSize: 14,
    fontFamily: 'Inter_600SemiBold',
    flex: 1,
  },
  addOnPrice: {
    fontSize: 13,
    fontFamily: 'Inter_600SemiBold',
  },
  quantityRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 16,
  },
  qtyBtn: {
    width: 40,
    height: 40,
    borderRadius: 10,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  qtyValue: {
    fontSize: 20,
    fontFamily: 'Inter_700Bold',
    minWidth: 36,
    textAlign: 'center',
  },
  tagsRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 6,
  },
  tag: {
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 4,
  },
  tagText: {
    fontSize: 12,
    fontFamily: 'Inter_500Medium',
  },
  bottomBar: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    borderTopWidth: 1,
    paddingHorizontal: 14,
    paddingTop: 12,
  },
  bottomRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  totalSection: {
    flex: 1,
  },
  totalLabel: {
    fontSize: 12,
    fontFamily: 'Inter_500Medium',
  },
  totalValue: {
    fontSize: 20,
    fontFamily: 'Inter_700Bold',
  },
  addBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    borderRadius: 12,
    paddingHorizontal: 20,
    paddingVertical: 12,
  },
  addBtnText: {
    color: '#fff',
    fontSize: 15,
    fontFamily: 'Inter_700Bold',
  },
});

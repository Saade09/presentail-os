import React from 'react';
import { View, Text, StyleSheet, TouchableOpacity } from 'react-native';
import { Feather } from '@expo/vector-icons';
import { useColors } from '@/hooks/useColors';

interface Props {
  label: string;
  value: number | string;
  icon: React.ComponentProps<typeof Feather>['name'];
  color?: string;
  onPress?: () => void;
}

export function StatCard({ label, value, icon, color, onPress }: Props) {
  const colors = useColors();
  const tint = color ?? colors.primary;

  const Wrapper: React.ElementType = onPress ? TouchableOpacity : View;

  return (
    <Wrapper
      style={[styles.card, { backgroundColor: colors.card, borderColor: colors.border }]}
      onPress={onPress}
      activeOpacity={0.7}
    >
      <View style={[styles.iconBox, { backgroundColor: tint + '18' }]}>
        <Feather name={icon} size={16} color={tint} />
      </View>
      <Text style={[styles.value, { color: colors.foreground }]}>{value}</Text>
      <Text style={[styles.label, { color: colors.mutedForeground }]} numberOfLines={1}>{label}</Text>
    </Wrapper>
  );
}

const styles = StyleSheet.create({
  card: {
    flex: 1,
    borderRadius: 12,
    borderWidth: 1,
    padding: 14,
    gap: 6,
    alignItems: 'flex-start',
    minWidth: 80,
  },
  iconBox: {
    width: 32,
    height: 32,
    borderRadius: 8,
    alignItems: 'center',
    justifyContent: 'center',
  },
  value: {
    fontSize: 22,
    fontFamily: 'Inter_700Bold',
    marginTop: 2,
  },
  label: {
    fontSize: 12,
    fontFamily: 'Inter_500Medium',
  },
});

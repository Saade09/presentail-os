import React from 'react';
import { View, TextInput, StyleSheet, TouchableOpacity } from 'react-native';
import { Feather } from '@expo/vector-icons';
import { useColors } from '@/hooks/useColors';

interface Props {
  value: string;
  onChangeText: (text: string) => void;
  placeholder?: string;
  autoFocus?: boolean;
}

export function SearchBar({ value, onChangeText, placeholder = 'Search...', autoFocus }: Props) {
  const colors = useColors();

  return (
    <View style={[styles.container, { backgroundColor: colors.card, borderColor: colors.border }]}>
      <Feather name="search" size={16} color={colors.mutedForeground} />
      <TextInput
        style={[styles.input, { color: colors.foreground, fontFamily: 'Inter_400Regular' }]}
        value={value}
        onChangeText={onChangeText}
        placeholder={placeholder}
        placeholderTextColor={colors.mutedForeground}
        autoFocus={autoFocus}
        returnKeyType="search"
        clearButtonMode="while-editing"
      />
      {value.length > 0 && (
        <TouchableOpacity onPress={() => onChangeText('')} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
          <Feather name="x" size={16} color={colors.mutedForeground} />
        </TouchableOpacity>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flexDirection: 'row',
    alignItems: 'center',
    borderWidth: 1,
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
    gap: 8,
  },
  input: {
    flex: 1,
    fontSize: 15,
    padding: 0,
    margin: 0,
  },
});

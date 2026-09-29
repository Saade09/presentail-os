import React, { useState } from 'react';
import {
  View, Text, StyleSheet, FlatList, TouchableOpacity,
  ScrollView, Platform, Alert, Clipboard,
} from 'react-native';
import { Feather } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { router } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useColors } from '@/hooks/useColors';
import { CANNED_REPLIES } from '@/data/mock';
import type { CannedReply } from '@/types';

const CATEGORIES = ['All', 'Greeting', 'Order Update', 'Payment', 'Delay', 'Issues', 'Closing'];

export default function ConversationScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const topPad = Platform.OS === 'web' ? 67 : insets.top;
  const [category, setCategory] = useState('All');
  const [lang, setLang] = useState<'en' | 'ar'>('en');
  const [copied, setCopied] = useState<string | null>(null);

  const filtered = category === 'All' ? CANNED_REPLIES : CANNED_REPLIES.filter(r => r.category === category);

  const copyReply = (reply: CannedReply) => {
    const text = lang === 'ar' && reply.bodyAr ? reply.bodyAr : reply.bodyEn;
    Clipboard.setString(text);
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    setCopied(reply.id);
    setTimeout(() => setCopied(null), 2000);
  };

  return (
    <View style={[styles.container, { backgroundColor: colors.background }]}>
      <View style={[styles.header, { paddingTop: topPad + 10, backgroundColor: colors.card, borderBottomColor: colors.border }]}>
        <View style={styles.headerRow}>
          <TouchableOpacity onPress={() => router.back()} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
            <Feather name="arrow-left" size={22} color={colors.foreground} />
          </TouchableOpacity>
          <Text style={[styles.title, { color: colors.foreground }]}>Conversation Helper</Text>
          <View style={styles.langToggle}>
            {(['en', 'ar'] as const).map(l => (
              <TouchableOpacity
                key={l}
                style={[styles.langBtn, { backgroundColor: lang === l ? colors.primary : colors.secondary, borderColor: lang === l ? colors.primary : colors.border }]}
                onPress={() => setLang(l)}
              >
                <Text style={[styles.langText, { color: lang === l ? '#fff' : colors.mutedForeground }]}>{l === 'en' ? 'EN' : 'AR'}</Text>
              </TouchableOpacity>
            ))}
          </View>
        </View>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.catRow}>
          {CATEGORIES.map(cat => (
            <TouchableOpacity
              key={cat}
              style={[styles.chip, { backgroundColor: category === cat ? colors.primary : colors.secondary, borderColor: category === cat ? colors.primary : colors.border }]}
              onPress={() => setCategory(cat)}
            >
              <Text style={[styles.chipText, { color: category === cat ? '#fff' : colors.mutedForeground }]}>{cat}</Text>
            </TouchableOpacity>
          ))}
        </ScrollView>
      </View>

      <FlatList
        data={filtered}
        keyExtractor={item => item.id}
        contentContainerStyle={[styles.list, { paddingBottom: insets.bottom + 30 }]}
        renderItem={({ item }) => {
          const text = lang === 'ar' && item.bodyAr ? item.bodyAr : item.bodyEn;
          const isCopied = copied === item.id;
          return (
            <View style={[styles.card, { backgroundColor: colors.card, borderColor: colors.border }]}>
              <View style={styles.cardHeader}>
                <View style={[styles.categoryTag, { backgroundColor: colors.secondary }]}>
                  <Text style={[styles.categoryTagText, { color: colors.mutedForeground }]}>{item.category}</Text>
                </View>
                <Text style={[styles.replyTitle, { color: colors.foreground }]}>{item.title}</Text>
              </View>
              <Text
                style={[styles.replyBody, { color: colors.foreground, textAlign: lang === 'ar' ? 'right' : 'left', writingDirection: lang === 'ar' ? 'rtl' : 'ltr' }]}
                numberOfLines={4}
              >
                {text}
              </Text>
              <View style={styles.cardFooter}>
                <TouchableOpacity
                  style={[styles.copyBtn, { backgroundColor: isCopied ? '#dcfce7' : colors.primary, borderColor: isCopied ? '#16a34a' : colors.primary }]}
                  onPress={() => copyReply(item)}
                >
                  <Feather name={isCopied ? 'check' : 'copy'} size={14} color={isCopied ? '#16a34a' : '#fff'} />
                  <Text style={[styles.copyBtnText, { color: isCopied ? '#16a34a' : '#fff' }]}>
                    {isCopied ? 'Copied!' : 'Copy'}
                  </Text>
                </TouchableOpacity>
                <View style={styles.varBtns}>
                  <TouchableOpacity style={[styles.varBtn, { backgroundColor: colors.secondary, borderColor: colors.border }]}
                    onPress={() => Alert.alert('AI Helper', 'Make it warmer — AI feature coming soon.')}>
                    <Feather name="sun" size={12} color={colors.mutedForeground} />
                  </TouchableOpacity>
                  <TouchableOpacity style={[styles.varBtn, { backgroundColor: colors.secondary, borderColor: colors.border }]}
                    onPress={() => Alert.alert('AI Helper', 'Make it shorter — AI feature coming soon.')}>
                    <Feather name="minimize-2" size={12} color={colors.mutedForeground} />
                  </TouchableOpacity>
                  <TouchableOpacity style={[styles.varBtn, { backgroundColor: colors.secondary, borderColor: colors.border }]}
                    onPress={() => setLang(lang === 'en' ? 'ar' : 'en')}>
                    <Feather name="globe" size={12} color={colors.mutedForeground} />
                  </TouchableOpacity>
                </View>
              </View>
            </View>
          );
        }}
        showsVerticalScrollIndicator={false}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  header: { paddingHorizontal: 16, paddingBottom: 12, borderBottomWidth: 1, gap: 10 },
  headerRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  title: { fontSize: 18, fontFamily: 'Inter_700Bold', flex: 1 },
  langToggle: { flexDirection: 'row', gap: 4 },
  langBtn: { borderWidth: 1, borderRadius: 6, paddingHorizontal: 10, paddingVertical: 5 },
  langText: { fontSize: 12, fontFamily: 'Inter_700Bold' },
  catRow: { gap: 6, flexDirection: 'row' },
  chip: { borderRadius: 20, paddingHorizontal: 12, paddingVertical: 6, borderWidth: 1 },
  chipText: { fontSize: 12, fontFamily: 'Inter_500Medium' },
  list: { padding: 14, gap: 0 },
  card: { borderRadius: 12, borderWidth: 1, padding: 14, marginBottom: 10, gap: 10 },
  cardHeader: { gap: 5 },
  categoryTag: { alignSelf: 'flex-start', borderRadius: 6, paddingHorizontal: 8, paddingVertical: 2 },
  categoryTagText: { fontSize: 10, fontFamily: 'Inter_600SemiBold', textTransform: 'uppercase', letterSpacing: 0.5 },
  replyTitle: { fontSize: 14, fontFamily: 'Inter_600SemiBold' },
  replyBody: { fontSize: 13, fontFamily: 'Inter_400Regular', lineHeight: 19 },
  cardFooter: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  copyBtn: { flexDirection: 'row', alignItems: 'center', gap: 6, borderRadius: 8, paddingHorizontal: 12, paddingVertical: 7, borderWidth: 1 },
  copyBtnText: { fontSize: 13, fontFamily: 'Inter_600SemiBold' },
  varBtns: { flexDirection: 'row', gap: 6, marginLeft: 'auto' },
  varBtn: { width: 30, height: 30, borderRadius: 8, borderWidth: 1, alignItems: 'center', justifyContent: 'center' },
});

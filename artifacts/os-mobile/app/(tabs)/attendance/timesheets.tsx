import { useGetMyTimesheets, getGetMyTimesheetsQueryKey } from "@workspace/api-client-react";
import { Feather } from "@expo/vector-icons";
import { type Href, useRouter } from "expo-router";
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  FlatList,
  Pressable,
  RefreshControl,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useQueryClient } from "@tanstack/react-query";

import { useColors } from "@/hooks/useColors";

function formatDate(iso: string | undefined | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return d.toLocaleDateString([], { weekday: "short", month: "short", day: "numeric", year: "numeric" });
}

function formatTime(iso: string | undefined | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function formatMinutes(mins: number | undefined | null): string {
  if (!mins || mins <= 0) return "—";
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  if (h === 0) return `${m}m`;
  return `${h}h ${m}m`;
}

type StatusKey = "open" | "completed" | "pending_review" | "approved" | "rejected" | string;

function StatusBadge({ status, colors }: { status: StatusKey; colors: ReturnType<typeof useColors> }) {
  let bg = colors.muted;
  let fg = colors.mutedForeground;
  let label = status;
  if (status === "completed" || status === "approved") {
    bg = colors.success + "22"; fg = colors.success; label = status === "completed" ? "Completed" : "Approved";
  } else if (status === "open") {
    bg = colors.primary + "22"; fg = colors.primary; label = "Open";
  } else if (status === "pending_review") {
    bg = colors.warning + "22"; fg = colors.warning; label = "Pending Review";
  } else if (status === "rejected") {
    bg = colors.destructive + "22"; fg = colors.destructive; label = "Rejected";
  }
  return (
    <View style={[badgeStyles.badge, { backgroundColor: bg }]}>
      <Text style={[badgeStyles.text, { color: fg, fontFamily: "Inter_500Medium" }]}>{label}</Text>
    </View>
  );
}

const badgeStyles = StyleSheet.create({
  badge: { borderRadius: 6, paddingHorizontal: 8, paddingVertical: 3 },
  text: { fontSize: 11 },
});

type Session = {
  id: number;
  clock_in_at?: string;
  clock_out_at?: string;
  status?: StatusKey;
  paid_minutes?: number;
  break_minutes?: number;
  late_minutes?: number;
  early_leave_minutes?: number;
  overtime_minutes?: number;
  location_name?: string;
};

const MONTHS = [
  "January","February","March","April","May","June",
  "July","August","September","October","November","December",
];

const PAGE_SIZE = 20;

function SummaryCard({ sessions }: { sessions: Session[] }) {
  const colors = useColors();
  const { totalPaid, totalOvertime, totalBreak } = useMemo(() => {
    let paid = 0, overtime = 0, brk = 0;
    for (const s of sessions) {
      paid += s.paid_minutes ?? 0;
      overtime += s.overtime_minutes ?? 0;
      brk += s.break_minutes ?? 0;
    }
    return { totalPaid: paid, totalOvertime: overtime, totalBreak: brk };
  }, [sessions]);

  return (
    <View style={[s2.summaryCard, { backgroundColor: colors.card, borderColor: colors.border }]}>
      <SummaryItem label="Paid Hours" value={formatMinutes(totalPaid)} icon="clock" accent={colors.primary} />
      <View style={[s2.summaryDivider, { backgroundColor: colors.border }]} />
      <SummaryItem label="Overtime" value={formatMinutes(totalOvertime)} icon="zap" accent={colors.warning} />
      <View style={[s2.summaryDivider, { backgroundColor: colors.border }]} />
      <SummaryItem label="Break Time" value={formatMinutes(totalBreak)} icon="coffee" accent={colors.mutedForeground} />
    </View>
  );
}

function SummaryItem({ label, value, icon, accent }: { label: string; value: string; icon: keyof typeof Feather.glyphMap; accent: string }) {
  const colors = useColors();
  return (
    <View style={s2.summaryItem}>
      <Feather name={icon} size={16} color={accent} />
      <Text style={[s2.summaryValue, { color: colors.foreground, fontFamily: "Inter_700Bold" }]}>{value}</Text>
      <Text style={[s2.summaryLabel, { color: colors.mutedForeground, fontFamily: "Inter_400Regular" }]}>{label}</Text>
    </View>
  );
}

export default function TimesheetsScreen() {
  const colors = useColors();
  const router = useRouter();
  const queryClient = useQueryClient();
  const now = new Date();
  const [selectedYear, setSelectedYear] = useState(now.getFullYear());
  const [selectedMonth, setSelectedMonth] = useState(now.getMonth());
  const [currentOffset, setCurrentOffset] = useState(0);
  const [allSessions, setAllSessions] = useState<Session[]>([]);

  const fromDate = new Date(selectedYear, selectedMonth, 1).toISOString();
  const toDate = new Date(selectedYear, selectedMonth + 1, 1).toISOString();

  const { data, isLoading, isFetching, refetch } = useGetMyTimesheets({
    from: fromDate,
    to: toDate,
    limit: PAGE_SIZE,
    offset: currentOffset,
  });

  const processedKeyRef = useRef("");

  useEffect(() => {
    if (!data) return;
    const incoming = (data as { sessions?: Session[]; offset?: number }).sessions ?? [];
    const thisOffset = (data as { offset?: number }).offset ?? 0;
    const sessionKey = `${fromDate}-${toDate}-${thisOffset}-${incoming.length}`;
    if (processedKeyRef.current === sessionKey) return;
    processedKeyRef.current = sessionKey;
    if (thisOffset === 0) {
      setAllSessions(incoming);
    } else {
      setAllSessions((prev) => {
        const existingIds = new Set(prev.map((s) => s.id));
        return [...prev, ...incoming.filter((s) => !existingIds.has(s.id))];
      });
    }
  }, [data, fromDate, toDate]);

  const total = (data as { total?: number } | undefined)?.total ?? 0;
  const hasMore = allSessions.length < total;
  const isCurrentMonth = selectedYear === now.getFullYear() && selectedMonth === now.getMonth();

  function prevMonth() {
    processedKeyRef.current = "";
    setAllSessions([]);
    setCurrentOffset(0);
    if (selectedMonth === 0) { setSelectedYear(y => y - 1); setSelectedMonth(11); }
    else setSelectedMonth(m => m - 1);
  }

  function nextMonth() {
    if (isCurrentMonth) return;
    processedKeyRef.current = "";
    setAllSessions([]);
    setCurrentOffset(0);
    if (selectedMonth === 11) { setSelectedYear(y => y + 1); setSelectedMonth(0); }
    else setSelectedMonth(m => m + 1);
  }

  const loadMore = useCallback(() => {
    if (!hasMore || isFetching) return;
    setCurrentOffset(allSessions.length);
  }, [hasMore, isFetching, allSessions.length]);

  const onRefresh = useCallback(async () => {
    processedKeyRef.current = "";
    setAllSessions([]);
    setCurrentOffset(0);
    await queryClient.invalidateQueries({ queryKey: getGetMyTimesheetsQueryKey() });
    await refetch();
  }, [queryClient, refetch]);

  const renderItem = useCallback(({ item }: { item: Session }) => (
    <SessionRow session={item} colors={colors} />
  ), [colors]);

  return (
    <SafeAreaView style={[styles.safe, { backgroundColor: colors.background }]} edges={["bottom"]}>
      <FlatList
        data={allSessions}
        keyExtractor={(item) => String(item.id)}
        contentContainerStyle={styles.list}
        renderItem={renderItem}
        refreshControl={
          <RefreshControl
            refreshing={isFetching && currentOffset === 0}
            onRefresh={onRefresh}
            tintColor={colors.primary}
          />
        }
        ListHeaderComponent={
          <>
            <View style={[styles.monthNav, { borderBottomColor: colors.border }]}>
              <Pressable onPress={prevMonth} style={styles.navBtn} hitSlop={8}>
                <Text style={[styles.navArrow, { color: colors.primary, fontFamily: "Inter_600SemiBold" }]}>‹</Text>
              </Pressable>
              <Text style={[styles.monthLabel, { color: colors.foreground, fontFamily: "Inter_600SemiBold" }]}>
                {MONTHS[selectedMonth]} {selectedYear}
              </Text>
              <Pressable onPress={nextMonth} style={styles.navBtn} disabled={isCurrentMonth} hitSlop={8}>
                <Text style={[styles.navArrow, { color: isCurrentMonth ? colors.mutedForeground : colors.primary, fontFamily: "Inter_600SemiBold" }]}>›</Text>
              </Pressable>
            </View>
            {allSessions.length > 0 ? <SummaryCard sessions={allSessions} /> : null}
            {allSessions.length > 0 ? (
              <Text style={[s2.sessionsCount, { color: colors.mutedForeground, fontFamily: "Inter_500Medium" }]}>
                {total} session{total !== 1 ? "s" : ""}
              </Text>
            ) : null}
          </>
        }
        ListEmptyComponent={
          isLoading ? null : (
            <View style={styles.center}>
              <Feather name="calendar" size={32} color={colors.mutedForeground} />
              <Text style={[styles.emptyText, { color: colors.mutedForeground, fontFamily: "Inter_400Regular" }]}>
                No attendance records for {MONTHS[selectedMonth]} {selectedYear}.
              </Text>
            </View>
          )
        }
        ListFooterComponent={
          isLoading && allSessions.length === 0 ? (
            <View style={styles.center}>
              <ActivityIndicator color={colors.primary} size="large" />
            </View>
          ) : hasMore ? (
            <View style={{ alignItems: "center", marginTop: 8, marginBottom: 24 }}>
              <Pressable
                style={[s2.loadMoreBtn, { backgroundColor: colors.secondary }]}
                onPress={loadMore}
                disabled={isFetching}
              >
                {isFetching ? (
                  <ActivityIndicator size="small" color={colors.secondaryForeground} />
                ) : (
                  <Text style={[s2.loadMoreText, { color: colors.secondaryForeground, fontFamily: "Inter_500Medium" }]}>
                    Load more
                  </Text>
                )}
              </Pressable>
            </View>
          ) : (
            <View style={{ height: 24 }} />
          )
        }
      />
    </SafeAreaView>
  );
}

function SessionRow({ session, colors }: { session: Session; colors: ReturnType<typeof useColors> }) {
  const router = useRouter();
  return (
    <View style={[styles.row, { backgroundColor: colors.card, borderColor: colors.border }]}>
      <View style={styles.rowHeader}>
        <Text style={[styles.rowDate, { color: colors.foreground, fontFamily: "Inter_600SemiBold" }]}>
          {formatDate(session.clock_in_at)}
        </Text>
        {session.status && <StatusBadge status={session.status} colors={colors} />}
      </View>

      {session.location_name ? (
        <Text style={[styles.rowLocation, { color: colors.mutedForeground, fontFamily: "Inter_400Regular" }]}>
          📍 {session.location_name}
        </Text>
      ) : null}

      <View style={styles.rowTimes}>
        <TimeChip label="In" value={formatTime(session.clock_in_at)} colors={colors} />
        <TimeChip label="Out" value={formatTime(session.clock_out_at)} colors={colors} />
        <TimeChip label="Paid" value={formatMinutes(session.paid_minutes)} colors={colors} highlight />
      </View>

      <View style={styles.indicators}>
        {(session.late_minutes ?? 0) > 0 && (
          <IndicatorChip label={`Late ${formatMinutes(session.late_minutes)}`} color={colors.warning} />
        )}
        {(session.early_leave_minutes ?? 0) > 0 && (
          <IndicatorChip label={`Early −${formatMinutes(session.early_leave_minutes)}`} color={colors.warning} />
        )}
        {(session.overtime_minutes ?? 0) > 0 && (
          <IndicatorChip label={`OT +${formatMinutes(session.overtime_minutes)}`} color={colors.success} />
        )}
      </View>

      <Pressable
        style={[s2.correctionBtn, { borderColor: colors.border }]}
        onPress={() => router.push(`/(tabs)/attendance/request?sessionId=${session.id}` as Href)}
      >
        <Feather name="edit-2" size={12} color={colors.mutedForeground} />
        <Text style={[s2.correctionBtnText, { color: colors.mutedForeground, fontFamily: "Inter_400Regular" }]}>
          Request Correction
        </Text>
      </Pressable>
    </View>
  );
}

function TimeChip({ label, value, colors, highlight }: {
  label: string;
  value: string;
  colors: ReturnType<typeof useColors>;
  highlight?: boolean;
}) {
  return (
    <View style={styles.timeChip}>
      <Text style={[styles.timeChipLabel, { color: colors.mutedForeground, fontFamily: "Inter_400Regular" }]}>{label}</Text>
      <Text style={[styles.timeChipValue, {
        color: highlight ? colors.primary : colors.foreground,
        fontFamily: highlight ? "Inter_600SemiBold" : "Inter_500Medium",
      }]}>{value}</Text>
    </View>
  );
}

function IndicatorChip({ label, color }: { label: string; color: string }) {
  return (
    <View style={[styles.indChip, { backgroundColor: color + "22" }]}>
      <Text style={[styles.indChipText, { color, fontFamily: "Inter_500Medium" }]}>{label}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1 },
  monthNav: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 20,
    paddingVertical: 12,
    borderBottomWidth: 1,
  },
  navBtn: { padding: 4 },
  navArrow: { fontSize: 24 },
  monthLabel: { fontSize: 16 },
  center: { flex: 1, alignItems: "center", justifyContent: "center", padding: 32 },
  emptyText: { fontSize: 15, textAlign: "center" },
  list: { padding: 16, gap: 12 },
  row: {
    borderRadius: 14,
    borderWidth: 1,
    padding: 16,
    gap: 10,
  },
  rowHeader: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  rowDate: { fontSize: 14 },
  rowLocation: { fontSize: 13 },
  rowTimes: { flexDirection: "row", gap: 16 },
  timeChip: { gap: 2 },
  timeChipLabel: { fontSize: 11 },
  timeChipValue: { fontSize: 15 },
  indicators: { flexDirection: "row", flexWrap: "wrap", gap: 6 },
  indChip: { borderRadius: 6, paddingHorizontal: 8, paddingVertical: 3 },
  indChipText: { fontSize: 11 },
});

const s2 = StyleSheet.create({
  summaryCard: {
    flexDirection: "row",
    borderRadius: 12,
    borderWidth: 1,
    overflow: "hidden",
    marginTop: 12,
  },
  sessionsCount: {
    fontSize: 13,
    marginTop: 8,
    marginBottom: 4,
  },
  summaryItem: {
    flex: 1,
    alignItems: "center",
    paddingVertical: 16,
    gap: 4,
  },
  summaryDivider: {
    width: StyleSheet.hairlineWidth,
    marginVertical: 12,
  },
  summaryValue: {
    fontSize: 18,
  },
  summaryLabel: {
    fontSize: 11,
  },
  loadMoreBtn: {
    paddingHorizontal: 24,
    paddingVertical: 12,
    borderRadius: 10,
    minWidth: 120,
    alignItems: "center",
  },
  loadMoreText: {
    fontSize: 14,
  },
  correctionBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
    alignSelf: "flex-start",
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 6,
    borderWidth: 1,
  },
  correctionBtnText: {
    fontSize: 12,
  },
});

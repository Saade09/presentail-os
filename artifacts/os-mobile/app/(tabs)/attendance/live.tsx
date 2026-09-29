import {
  useGetAttendanceLive,
  getGetAttendanceLiveQueryKey,
} from "@workspace/api-client-react";
import { Feather } from "@expo/vector-icons";
import React, { useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  AppState,
  type AppStateStatus,
  FlatList,
  RefreshControl,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { useColors } from "@/hooks/useColors";

type LiveSession = {
  id: number;
  employee_id: number;
  employee_name: string;
  location_name: string | null;
  clock_in_at: string;
  clock_out_at: string | null;
  status: string;
  is_overdue: boolean;
  scheduled_end_time: string | null;
};

function formatTime(iso: string | undefined | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function formatScheduledEnd(timeStr: string | null | undefined): string {
  if (!timeStr) return "";
  const [hhRaw, mmRaw] = timeStr.split(":");
  const hh = parseInt(hhRaw ?? "0", 10);
  const mm = mmRaw ?? "00";
  const period = hh >= 12 ? "PM" : "AM";
  const hour12 = hh % 12 === 0 ? 12 : hh % 12;
  return `${hour12}:${mm} ${period}`;
}

function sessionStatusLabel(s: LiveSession): string {
  if (s.clock_out_at) return "Clocked Out";
  if (s.status === "open") return "Clocked In";
  return s.status;
}

function OverdueBanner({ count, colors }: { count: number; colors: ReturnType<typeof useColors> }) {
  if (count === 0) return null;
  return (
    <View style={[bannerStyles.banner, { backgroundColor: colors.destructive + "14", borderColor: colors.destructive + "50" }]}>
      <Feather name="alert-triangle" size={16} color={colors.destructive} />
      <Text style={[bannerStyles.text, { color: colors.destructive, fontFamily: "Inter_600SemiBold" }]}>
        {count === 1
          ? "1 employee is still clocked in past their scheduled end time"
          : `${count} employees are still clocked in past their scheduled end time`}
      </Text>
    </View>
  );
}

const bannerStyles = StyleSheet.create({
  banner: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    marginHorizontal: 16,
    marginTop: 12,
    marginBottom: 4,
    padding: 12,
    borderRadius: 12,
    borderWidth: 1,
  },
  text: { flex: 1, fontSize: 13, lineHeight: 18 },
});

function SessionCard({ session, colors }: { session: LiveSession; colors: ReturnType<typeof useColors> }) {
  const isOpen = !session.clock_out_at;
  const overdue = session.is_overdue;

  const borderColor = overdue ? colors.destructive + "60" : colors.border;
  const bgColor = overdue ? colors.destructive + "08" : colors.card;

  return (
    <View style={[cardStyles.card, { backgroundColor: bgColor, borderColor }]}>
      <View style={cardStyles.header}>
        <View style={{ flex: 1, gap: 2 }}>
          <Text style={[cardStyles.name, { color: colors.foreground, fontFamily: "Inter_600SemiBold" }]}>
            {session.employee_name}
          </Text>
          {session.location_name ? (
            <Text style={[cardStyles.location, { color: colors.mutedForeground, fontFamily: "Inter_400Regular" }]}>
              {session.location_name}
            </Text>
          ) : null}
        </View>

        <View style={{ alignItems: "flex-end", gap: 4 }}>
          {overdue ? (
            <View style={[cardStyles.badge, { backgroundColor: colors.destructive + "18", borderColor: colors.destructive + "44" }]}>
              <Feather name="alert-circle" size={11} color={colors.destructive} />
              <Text style={[cardStyles.badgeText, { color: colors.destructive, fontFamily: "Inter_700Bold" }]}>
                Overdue
              </Text>
            </View>
          ) : isOpen ? (
            <View style={[cardStyles.badge, { backgroundColor: colors.success + "18", borderColor: colors.success + "44" }]}>
              <View style={[cardStyles.dot, { backgroundColor: colors.success }]} />
              <Text style={[cardStyles.badgeText, { color: colors.success, fontFamily: "Inter_600SemiBold" }]}>
                Clocked In
              </Text>
            </View>
          ) : (
            <View style={[cardStyles.badge, { backgroundColor: colors.muted, borderColor: colors.border }]}>
              <Text style={[cardStyles.badgeText, { color: colors.mutedForeground, fontFamily: "Inter_500Medium" }]}>
                {sessionStatusLabel(session)}
              </Text>
            </View>
          )}
        </View>
      </View>

      <View style={[cardStyles.timesRow, { backgroundColor: overdue ? colors.destructive + "08" : colors.muted, borderRadius: 8 }]}>
        <View style={cardStyles.timeItem}>
          <Text style={[cardStyles.timeLabel, { color: colors.mutedForeground, fontFamily: "Inter_400Regular" }]}>
            Clocked In
          </Text>
          <Text style={[cardStyles.timeValue, { color: colors.foreground, fontFamily: "Inter_600SemiBold" }]}>
            {formatTime(session.clock_in_at)}
          </Text>
        </View>
        {session.clock_out_at ? (
          <View style={cardStyles.timeItem}>
            <Text style={[cardStyles.timeLabel, { color: colors.mutedForeground, fontFamily: "Inter_400Regular" }]}>
              Clocked Out
            </Text>
            <Text style={[cardStyles.timeValue, { color: colors.foreground, fontFamily: "Inter_600SemiBold" }]}>
              {formatTime(session.clock_out_at)}
            </Text>
          </View>
        ) : session.scheduled_end_time ? (
          <View style={cardStyles.timeItem}>
            <Text style={[cardStyles.timeLabel, { color: colors.mutedForeground, fontFamily: "Inter_400Regular" }]}>
              Shift Ends
            </Text>
            <Text style={[cardStyles.timeValue, {
              color: overdue ? colors.destructive : colors.foreground,
              fontFamily: overdue ? "Inter_700Bold" : "Inter_600SemiBold",
            }]}>
              {formatScheduledEnd(session.scheduled_end_time)}
            </Text>
          </View>
        ) : null}
      </View>

      {overdue && session.scheduled_end_time ? (
        <View style={[cardStyles.overdueNote, { backgroundColor: colors.destructive + "10", borderColor: colors.destructive + "30" }]}>
          <Feather name="clock" size={12} color={colors.destructive} />
          <Text style={[cardStyles.overdueNoteText, { color: colors.destructive, fontFamily: "Inter_500Medium" }]}>
            Still clocked in — shift ended at {formatScheduledEnd(session.scheduled_end_time)}
          </Text>
        </View>
      ) : null}
    </View>
  );
}

const cardStyles = StyleSheet.create({
  card: {
    borderRadius: 14,
    borderWidth: 1,
    padding: 14,
    gap: 10,
  },
  header: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 10,
  },
  name: { fontSize: 15 },
  location: { fontSize: 12 },
  badge: {
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
    paddingHorizontal: 9,
    paddingVertical: 4,
    borderRadius: 20,
    borderWidth: 1,
  },
  badgeText: { fontSize: 12 },
  dot: { width: 7, height: 7, borderRadius: 4 },
  timesRow: { flexDirection: "row", gap: 20, padding: 10 },
  timeItem: { gap: 2 },
  timeLabel: { fontSize: 11 },
  timeValue: { fontSize: 14 },
  overdueNote: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    padding: 9,
    borderRadius: 8,
    borderWidth: 1,
  },
  overdueNoteText: { flex: 1, fontSize: 12, lineHeight: 16 },
});

export default function LiveAttendanceScreen() {
  const colors = useColors();
  const appStateRef = useRef<AppStateStatus>(AppState.currentState);
  const [appIsActive, setAppIsActive] = useState(AppState.currentState === "active");

  useEffect(() => {
    const sub = AppState.addEventListener("change", (next: AppStateStatus) => {
      appStateRef.current = next;
      setAppIsActive(next === "active");
    });
    return () => sub.remove();
  }, []);

  const { data, isLoading, isFetching, refetch } = useGetAttendanceLive(undefined, {
    query: {
      queryKey: getGetAttendanceLiveQueryKey(),
      refetchInterval: appIsActive ? 60_000 : false,
      refetchIntervalInBackground: false,
    },
  });

  const result = data as {
    success?: boolean;
    sessions?: LiveSession[];
    date?: string;
  } | undefined;

  const sessions: LiveSession[] = result?.sessions ?? [];
  const overdueSessions = sessions.filter((s) => s.is_overdue);
  const overdueCount = overdueSessions.length;

  if (isLoading) {
    return (
      <SafeAreaView style={[styles.safe, { backgroundColor: colors.background }]} edges={["bottom"]}>
        <View style={styles.center}>
          <ActivityIndicator color={colors.primary} size="large" />
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={[styles.safe, { backgroundColor: colors.background }]} edges={["bottom"]}>
      <OverdueBanner count={overdueCount} colors={colors} />

      {sessions.length === 0 ? (
        <View style={styles.center}>
          <Feather name="users" size={40} color={colors.mutedForeground} style={{ marginBottom: 16 }} />
          <Text style={[styles.emptyText, { color: colors.mutedForeground, fontFamily: "Inter_500Medium" }]}>
            No sessions today
          </Text>
          <Text style={[styles.emptySubtext, { color: colors.mutedForeground, fontFamily: "Inter_400Regular" }]}>
            Pull to refresh to check for new activity.
          </Text>
        </View>
      ) : (
        <FlatList
          data={sessions}
          keyExtractor={(item) => String(item.id)}
          contentContainerStyle={styles.list}
          refreshControl={
            <RefreshControl
              refreshing={isFetching && !isLoading}
              onRefresh={() => void refetch()}
              tintColor={colors.primary}
            />
          }
          renderItem={({ item }) => <SessionCard session={item} colors={colors} />}
        />
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1 },
  center: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    padding: 32,
    gap: 8,
  },
  emptyText: { fontSize: 16, textAlign: "center" },
  emptySubtext: { fontSize: 13, textAlign: "center", lineHeight: 20 },
  list: { padding: 16, gap: 12 },
});

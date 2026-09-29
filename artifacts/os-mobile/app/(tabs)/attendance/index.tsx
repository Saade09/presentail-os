import {
  useClockIn,
  useClockOut,
  useStartBreak,
  useEndBreak,
  useGetAttendanceToday,
  getGetAttendanceTodayQueryKey,
} from "@workspace/api-client-react";
import { Feather } from "@expo/vector-icons";
import * as Location from "expo-location";
import { type Href, useRouter } from "expo-router";
import React, { useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  AppState,
  type AppStateStatus,
  Modal,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useQueryClient } from "@tanstack/react-query";

import { useColors } from "@/hooks/useColors";

type VerificationStatus = "verified" | "outside_geofence" | "no_location" | "permission_needed" | "waiting_for_punch";

type GeofenceVerdict = "verified" | "outside_geofence" | "no_location" | "manual_exception";

interface VerificationResult {
  action: "clock_in" | "clock_out";
  status: GeofenceVerdict;
}

type LocationResult = {
  coords: { lat: number; lon: number; accuracy: number } | null;
  status: VerificationStatus;
};

function haversineMeters(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371000;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLon / 2) *
      Math.sin(dLon / 2);
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function formatTime(iso: string | undefined | null): string {
  if (!iso) return "\u2014";
  const d = new Date(iso);
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function formatMinutes(mins: number | undefined | null): string {
  if (!mins || mins <= 0) return "0h 0m";
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  if (h === 0) return `${m}m`;
  return `${h}h ${m}m`;
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleDateString([], { weekday: "long", month: "long", day: "numeric" });
}

function GeoVerificationBadge({ status }: { status: GeofenceVerdict }) {
  const colors = useColors();
  if (status === "verified") return null;

  const config: Record<
    Exclude<GeofenceVerdict, "verified">,
    { label: string; icon: keyof typeof Feather.glyphMap; color: string }
  > = {
    outside_geofence: { label: "Outside geofence", icon: "alert-triangle", color: colors.warning },
    no_location: { label: "No GPS location", icon: "x-circle", color: colors.mutedForeground },
    manual_exception: { label: "Remote clock-in", icon: "wifi", color: colors.primary },
  };
  const { label, icon, color } = config[status as Exclude<GeofenceVerdict, "verified">];
  return (
    <View style={[styles.geoVerifBadge, { borderColor: color }]}>
      <Feather name={icon} size={12} color={color} />
      <Text style={[styles.geoVerifBadgeText, { color, fontFamily: "Inter_500Medium" }]}>{label}</Text>
    </View>
  );
}

function VerificationResultModal({
  result,
  onDismiss,
  onRequestCorrection,
}: {
  result: VerificationResult | null;
  onDismiss: () => void;
  onRequestCorrection: () => void;
}) {
  const colors = useColors();
  if (!result) return null;
  const actionLabel = result.action === "clock_in" ? "Clock In" : "Clock Out";
  const cfg: Record<
    GeofenceVerdict,
    {
      icon: keyof typeof Feather.glyphMap;
      iconColor: string;
      title: string;
      description: string;
      showCorrection: boolean;
    }
  > = {
    verified: {
      icon: "check-circle",
      iconColor: colors.success,
      title: "Location Verified",
      description: `Your ${actionLabel.toLowerCase()} location was confirmed within the work area.`,
      showCorrection: false,
    },
    outside_geofence: {
      icon: "alert-triangle",
      iconColor: colors.warning,
      title: "Outside Work Location",
      description: `You clocked ${result.action === "clock_in" ? "in" : "out"} from outside the designated work area. This session has been flagged for review. If this was a mistake or you have a valid reason, please submit a correction request.`,
      showCorrection: true,
    },
    no_location: {
      icon: "map-pin",
      iconColor: colors.mutedForeground,
      title: "Location Unavailable",
      description: `GPS location could not be determined at the time of your ${actionLabel.toLowerCase()}. The session was recorded without location verification.`,
      showCorrection: false,
    },
    manual_exception: {
      icon: "wifi",
      iconColor: colors.primary,
      title: "Remote Clock-In Recorded",
      description: `Your ${actionLabel.toLowerCase()} was recorded as a remote session. No geofence check was required.`,
      showCorrection: false,
    },
  };
  const { icon, iconColor, title, description, showCorrection } = cfg[result.status];
  return (
    <Modal transparent animationType="fade" visible={result !== null} onRequestClose={onDismiss}>
      <Pressable style={styles.modalOverlay} onPress={onDismiss}>
        <Pressable
          style={[styles.modalCard, { backgroundColor: colors.card, borderColor: colors.border }]}
          onPress={(e) => e.stopPropagation()}
        >
          <View style={styles.modalIconRow}>
            <View style={[styles.modalIconCircle, { backgroundColor: iconColor + "20" }]}>
              <Feather name={icon} size={28} color={iconColor} />
            </View>
          </View>
          <Text style={[styles.modalTitle, { color: colors.foreground, fontFamily: "Inter_700Bold" }]}>
            {title}
          </Text>
          <Text style={[styles.modalDescription, { color: colors.mutedForeground, fontFamily: "Inter_400Regular" }]}>
            {description}
          </Text>
          {showCorrection && (
            <Pressable
              style={[styles.correctionLink, { backgroundColor: colors.warning + "18", borderColor: colors.warning + "50" }]}
              onPress={() => {
                onDismiss();
                onRequestCorrection();
              }}
            >
              <Feather name="edit-2" size={14} color={colors.warning} />
              <Text style={[styles.correctionLinkText, { color: colors.warning, fontFamily: "Inter_500Medium" }]}>
                Submit a Correction Request
              </Text>
            </Pressable>
          )}
          <Pressable style={[styles.modalDismissBtn, { backgroundColor: colors.primary }]} onPress={onDismiss}>
            <Text style={[styles.modalDismissBtnText, { color: colors.primaryForeground, fontFamily: "Inter_600SemiBold" }]}>
              Got it
            </Text>
          </Pressable>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

function elapsedSince(isoStart: string): number {
  return Math.floor((Date.now() - new Date(isoStart).getTime()) / 60_000);
}

export default function ClockScreen() {
  const colors = useColors();
  const router = useRouter();
  const queryClient = useQueryClient();

  const [locationStatus, setLocationStatus] = useState<VerificationStatus>("waiting_for_punch");
  const [capturedCoords, setCapturedCoords] = useState<{ lat: number; lon: number; accuracy: number } | null>(null);
  const [outsideReason, setOutsideReason] = useState("");
  const [actionLoading, setActionLoading] = useState(false);
  const [verificationResult, setVerificationResult] = useState<VerificationResult | null>(null);

  // ── Background-awareness ────────────────────────────────────────────────────
  const [appIsActive, setAppIsActive] = useState<boolean>(AppState.currentState === "active");
  const appStateRef = useRef<AppStateStatus>(AppState.currentState);

  useEffect(() => {
    const sub = AppState.addEventListener("change", (next: AppStateStatus) => {
      appStateRef.current = next;
      setAppIsActive(next === "active");
    });
    return () => sub.remove();
  }, []);

  const { data, isLoading, isRefetching, refetch } = useGetAttendanceToday({
    query: {
      queryKey: getGetAttendanceTodayQueryKey(),
      refetchInterval: appIsActive ? 60_000 : false,
      refetchIntervalInBackground: false,
    },
  });

  const clockInMutation = useClockIn();
  const clockOutMutation = useClockOut();
  const startBreakMutation = useStartBreak();
  const endBreakMutation = useEndBreak();

  const today = data as {
    success?: boolean;
    today?: string;
    employeeId?: number;
    openSession?: Record<string, unknown> | null;
    activeBreak?: Record<string, unknown> | null;
    assignedLocation?: Record<string, unknown> | null;
    todaySchedule?: Record<string, unknown> | null;
  } | undefined;

  const openSession = today?.openSession as Record<string, unknown> | null | undefined;
  const activeBreak = today?.activeBreak as Record<string, unknown> | null | undefined;
  const assignedLocation = today?.assignedLocation as {
    id?: number;
    name?: string;
    latitude?: number | null;
    longitude?: number | null;
    geofence_radius_meters?: number;
    attendance_enabled?: boolean;
  } | null | undefined;

  const isOnBreak = !!activeBreak;
  const isClockedIn = !!openSession && !isOnBreak;
  const isNotClockedIn = !openSession;

  const clockInAt = openSession?.clock_in_at as string | undefined;
  const breakMinutes = openSession?.break_minutes as number | undefined;
  const paidMinutes = openSession?.paid_minutes as number | undefined;
  const overtimeMinutes = openSession?.overtime_minutes as number | undefined;
  const breakStartAt = activeBreak?.break_start_at as string | undefined;

  // ── Elapsed-time ticker ─────────────────────────────────────────────────────
  const isLiveSession = isClockedIn || isOnBreak;
  const [elapsedMinutes, setElapsedMinutes] = useState<number | null>(null);

  useEffect(() => {
    if (!isLiveSession || !clockInAt) {
      setElapsedMinutes(null);
      return;
    }

    setElapsedMinutes(elapsedSince(clockInAt));

    const id = setInterval(() => {
      if (appStateRef.current === "active") {
        setElapsedMinutes(elapsedSince(clockInAt));
      }
    }, 60_000);

    const sub = AppState.addEventListener("change", (next: AppStateStatus) => {
      if (next === "active" && clockInAt) {
        setElapsedMinutes(elapsedSince(clockInAt));
      }
    });

    return () => {
      clearInterval(id);
      sub.remove();
    };
  }, [isLiveSession, clockInAt]);

  async function requestLocationAndCapture(): Promise<LocationResult> {
    const { status } = await Location.requestForegroundPermissionsAsync();
    if (status !== "granted") {
      setLocationStatus("permission_needed");
      return { coords: null, status: "permission_needed" };
    }
    try {
      const pos = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced });
      const coords = {
        lat: pos.coords.latitude,
        lon: pos.coords.longitude,
        accuracy: pos.coords.accuracy ?? 50,
      };
      setCapturedCoords(coords);

      let verdict: VerificationStatus = "no_location";
      if (
        assignedLocation?.latitude != null &&
        assignedLocation?.longitude != null
      ) {
        const dist = haversineMeters(
          assignedLocation.latitude,
          assignedLocation.longitude,
          coords.lat,
          coords.lon,
        );
        const radius = assignedLocation.geofence_radius_meters ?? 100;
        verdict = dist <= radius ? "verified" : "outside_geofence";
      }
      setLocationStatus(verdict);
      return { coords, status: verdict };
    } catch {
      setLocationStatus("no_location");
      return { coords: null, status: "no_location" };
    }
  }

  function invalidateToday() {
    void queryClient.invalidateQueries({ queryKey: getGetAttendanceTodayQueryKey() });
  }

  async function handleClockIn() {
    setActionLoading(true);
    const { coords, status } = await requestLocationAndCapture();
    if (status === "outside_geofence" && !outsideReason.trim()) {
      setActionLoading(false);
      return;
    }
    try {
      const result = await clockInMutation.mutateAsync({
        data: coords
          ? { latitude: coords.lat, longitude: coords.lon, accuracy_meters: coords.accuracy, note: outsideReason || undefined }
          : { note: outsideReason || undefined },
      });
      const serverStatus = (result as { verificationStatus?: GeofenceVerdict })?.verificationStatus;
      if (serverStatus) {
        setVerificationResult({ action: "clock_in", status: serverStatus });
      }
      setOutsideReason("");
      invalidateToday();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Failed to clock in";
      Alert.alert("Error", msg);
    } finally {
      setActionLoading(false);
    }
  }

  async function handleClockOut() {
    setActionLoading(true);
    const { coords, status } = await requestLocationAndCapture();
    if (status === "outside_geofence" && !outsideReason.trim()) {
      setActionLoading(false);
      return;
    }
    try {
      const result = await clockOutMutation.mutateAsync({
        data: coords
          ? { latitude: coords.lat, longitude: coords.lon, accuracy_meters: coords.accuracy, note: outsideReason || undefined }
          : { note: outsideReason || undefined },
      });
      const serverStatus = (result as { verificationStatus?: GeofenceVerdict })?.verificationStatus;
      if (serverStatus) {
        setVerificationResult({ action: "clock_out", status: serverStatus });
      }
      setOutsideReason("");
      setCapturedCoords(null);
      setLocationStatus("waiting_for_punch");
      invalidateToday();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Failed to clock out";
      Alert.alert("Error", msg);
    } finally {
      setActionLoading(false);
    }
  }

  async function handleStartBreak() {
    setActionLoading(true);
    const { coords, status } = await requestLocationAndCapture();
    if (status === "outside_geofence" && !outsideReason.trim()) {
      setActionLoading(false);
      return;
    }
    try {
      await startBreakMutation.mutateAsync({
        data: { note: outsideReason || undefined },
      });
      setOutsideReason("");
      invalidateToday();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Failed to start break";
      Alert.alert("Error", msg);
    } finally {
      setActionLoading(false);
    }
  }

  async function handleEndBreak() {
    setActionLoading(true);
    const { coords, status } = await requestLocationAndCapture();
    if (status === "outside_geofence" && !outsideReason.trim()) {
      setActionLoading(false);
      return;
    }
    try {
      await endBreakMutation.mutateAsync();
      setOutsideReason("");
      invalidateToday();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Failed to end break";
      Alert.alert("Error", msg);
    } finally {
      setActionLoading(false);
    }
  }

  // Primary action changes based on single attendance state per spec:
  // Not clocked in -> Clock In (primary)
  // Clocked in (not on break) -> Start Break (primary), Clock Out (secondary)
  // On break -> End Break (primary)
  const primaryAction = isOnBreak
    ? { label: "End Break", color: colors.success, handler: handleEndBreak }
    : isClockedIn
    ? { label: "Start Break", color: colors.primary, handler: handleStartBreak }
    : { label: "Clock In", color: colors.primary, handler: handleClockIn };

  const secondaryAction = isClockedIn
    ? { label: "Clock Out", color: colors.destructive, handler: handleClockOut }
    : null;

  const showLocationInput = locationStatus === "outside_geofence";

  const statusLabel = isOnBreak ? "On Break" : isClockedIn ? "Clocked In" : "Not Clocked In";
  const statusColor = isOnBreak ? colors.warning : isClockedIn ? colors.success : colors.mutedForeground;

  return (
    <SafeAreaView style={[styles.safe, { backgroundColor: colors.background }]}>
      <VerificationResultModal
        result={verificationResult}
        onDismiss={() => setVerificationResult(null)}
        onRequestCorrection={() => router.push("/(tabs)/attendance/request" as Href)}
      />
      <ScrollView
        contentContainerStyle={styles.scroll}
        refreshControl={
          <RefreshControl
            refreshing={isRefetching}
            onRefresh={() => void refetch()}
            tintColor={colors.primary}
          />
        }
      >
        {isLoading ? (
          <View style={styles.center}>
            <ActivityIndicator color={colors.primary} size="large" />
          </View>
        ) : (
          <>
            <Text style={[styles.dateText, { color: colors.mutedForeground, fontFamily: "Inter_400Regular" }]}>
              {today?.today ? formatDate(today.today) : "Today"}
            </Text>

            {assignedLocation?.name ? (
              <Text style={[styles.locationText, { color: colors.foreground, fontFamily: "Inter_500Medium" }]}>
                \ud83d\udccd {assignedLocation.name}
              </Text>
            ) : null}

            <View style={[styles.statusBadge, { backgroundColor: colors.muted }]}>
              <View style={[styles.statusDot, { backgroundColor: statusColor }]} />
              <Text style={[styles.statusLabel, { color: statusColor, fontFamily: "Inter_600SemiBold" }]}>
                {statusLabel}
              </Text>
            </View>

            <View style={[styles.geoRow, {
              backgroundColor: locationStatus === "verified"
                ? colors.success + "22"
                : locationStatus === "outside_geofence"
                ? colors.destructive + "22"
                : colors.muted,
              borderColor: locationStatus === "verified"
                ? colors.success
                : locationStatus === "outside_geofence"
                ? colors.destructive
                : locationStatus === "permission_needed"
                ? colors.warning
                : colors.border,
            }]}>
              <Text style={[styles.geoText, {
                color: locationStatus === "verified"
                  ? colors.success
                  : locationStatus === "outside_geofence"
                  ? colors.destructive
                  : locationStatus === "permission_needed"
                  ? colors.warning
                  : colors.mutedForeground,
                fontFamily: "Inter_500Medium",
              }]}>
                {locationStatus === "verified" && "\u2713 Location verified"}
                {locationStatus === "outside_geofence" && "\u26a0 Outside assigned location"}
                {locationStatus === "no_location" && "Location not available"}
                {locationStatus === "permission_needed" && "\u26a0 Location permission needed"}
                {locationStatus === "waiting_for_punch" && "Tap punch to verify location"}
              </Text>
            </View>

            {showLocationInput && (
              <View style={styles.reasonContainer}>
                <Text style={[styles.reasonLabel, { color: colors.foreground, fontFamily: "Inter_500Medium" }]}>
                  Reason for punching outside assigned location *
                </Text>
                <TextInput
                  style={[styles.reasonInput, {
                    backgroundColor: colors.card,
                    borderColor: colors.border,
                    color: colors.foreground,
                    fontFamily: "Inter_400Regular",
                  }]}
                  value={outsideReason}
                  onChangeText={setOutsideReason}
                  placeholder="Enter reason..."
                  placeholderTextColor={colors.mutedForeground}
                  multiline
                  numberOfLines={3}
                />
              </View>
            )}

            <Pressable
              style={[styles.primaryButton, { backgroundColor: primaryAction.color },
                (actionLoading || (showLocationInput && !outsideReason.trim())) && styles.disabled,
              ]}
              onPress={primaryAction.handler}
              disabled={actionLoading || (showLocationInput && !outsideReason.trim())}
            >
              {actionLoading ? (
                <ActivityIndicator color="#ffffff" />
              ) : (
                <Text style={[styles.primaryButtonText, { fontFamily: "Inter_700Bold" }]}>
                  {primaryAction.label}
                </Text>
              )}
            </Pressable>

            {secondaryAction && (
              <Pressable
                style={[styles.secondaryButton, { borderColor: secondaryAction.color },
                  actionLoading && styles.disabled,
                ]}
                onPress={secondaryAction.handler}
                disabled={actionLoading}
              >
                <Text style={[styles.secondaryButtonText, { color: secondaryAction.color, fontFamily: "Inter_600SemiBold" }]}>
                  {secondaryAction.label}
                </Text>
              </Pressable>
            )}

            {!isNotClockedIn && (
              <View style={[styles.summaryCard, { backgroundColor: colors.card, borderColor: colors.border }]}>
                <Text style={[styles.summaryTitle, { color: colors.foreground, fontFamily: "Inter_600SemiBold" }]}>
                  Today's Summary
                </Text>
                <View style={styles.summaryRow}>
                  <SummaryItem label="Clocked In" value={formatTime(clockInAt)} colors={colors} />
                  {isOnBreak ? (
                    <SummaryItem label="Break Since" value={formatTime(breakStartAt)} colors={colors} />
                  ) : (
                    <SummaryItem label="Break Time" value={formatMinutes(breakMinutes)} colors={colors} />
                  )}
                </View>
                <View style={styles.summaryRow}>
                  <SummaryItem label="Paid Time" value={formatMinutes(paidMinutes)} colors={colors} />
                  {(overtimeMinutes ?? 0) > 0 && (
                    <SummaryItem label="Overtime" value={formatMinutes(overtimeMinutes)} colors={colors} />
                  )}
                </View>
                {openSession?.clock_in_verification_status && (openSession?.clock_in_verification_status as string) !== "verified" ? (
                  <View style={{ marginTop: 8 }}>
                    <GeoVerificationBadge status={openSession?.clock_in_verification_status as GeofenceVerdict} />
                  </View>
                ) : null}
                {elapsedMinutes !== null && (
                  <View style={styles.summaryRow}>
                    <SummaryItem label="Elapsed" value={formatMinutes(elapsedMinutes)} colors={colors} />
                  </View>
                )}
              </View>
            )}

            <View style={styles.actions}>
              <Pressable
                style={[styles.linkButton, { borderColor: colors.border, backgroundColor: colors.card }]}
                onPress={() => router.push("/(tabs)/attendance/timesheets" as Href)}
              >
                <Text style={[styles.linkButtonText, { color: colors.primary, fontFamily: "Inter_500Medium" }]}>
                  My Timesheets
                </Text>
              </Pressable>
              <Pressable
                style={[styles.linkButton, { borderColor: colors.border, backgroundColor: colors.card }]}
                onPress={() => router.push("/(tabs)/attendance/request" as Href)}
              >
                <Text style={[styles.linkButtonText, { color: colors.primary, fontFamily: "Inter_500Medium" }]}>
                  Request Correction
                </Text>
              </Pressable>
              <Pressable
                style={[styles.linkButton, { borderColor: colors.primary + "55", backgroundColor: colors.primary + "10" }]}
                onPress={() => router.push("/(tabs)/attendance/approvals" as Href)}
              >
                <Text style={[styles.linkButtonText, { color: colors.primary, fontFamily: "Inter_600SemiBold" }]}>
                  Team Approvals
                </Text>
              </Pressable>
            </View>

            <View style={[styles.privacyNote, { backgroundColor: colors.muted }]}>
              <Text style={[styles.privacyText, { color: colors.mutedForeground, fontFamily: "Inter_400Regular" }]}>
                \ud83d\udd12 Location is only captured when you clock in, clock out, or manage breaks. Presentail does not track your location continuously.
              </Text>
            </View>
          </>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

function SummaryItem({
  label,
  value,
  colors,
}: {
  label: string;
  value: string;
  colors: ReturnType<typeof useColors>;
}) {
  return (
    <View style={styles.summaryItem}>
      <Text style={[styles.summaryItemLabel, { color: colors.mutedForeground, fontFamily: "Inter_400Regular" }]}>
        {label}
      </Text>
      <Text style={[styles.summaryItemValue, { color: colors.foreground, fontFamily: "Inter_600SemiBold" }]}>
        {value}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1 },
  scroll: { flexGrow: 1, padding: 24, gap: 16 },
  center: { flex: 1, alignItems: "center", justifyContent: "center", paddingVertical: 60 },
  dateText: { fontSize: 14, textAlign: "center" },
  locationText: { fontSize: 15, textAlign: "center" },
  statusBadge: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    paddingVertical: 10,
    paddingHorizontal: 20,
    borderRadius: 24,
    alignSelf: "center",
  },
  statusDot: { width: 8, height: 8, borderRadius: 4 },
  statusLabel: { fontSize: 15 },
  geoRow: {
    paddingVertical: 10,
    paddingHorizontal: 14,
    borderRadius: 10,
    borderWidth: 1,
    alignItems: "center",
  },
  geoText: { fontSize: 13 },
  reasonContainer: { gap: 6 },
  reasonLabel: { fontSize: 14 },
  reasonInput: {
    borderWidth: 1,
    borderRadius: 10,
    padding: 12,
    fontSize: 14,
    minHeight: 80,
    textAlignVertical: "top",
  },
  primaryButton: {
    height: 64,
    borderRadius: 14,
    alignItems: "center",
    justifyContent: "center",
    marginTop: 8,
  },
  primaryButtonText: { fontSize: 20, color: "#ffffff" },
  secondaryButton: {
    height: 48,
    borderRadius: 12,
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 1.5,
  },
  secondaryButtonText: { fontSize: 15 },
  disabled: { opacity: 0.5 },
  summaryCard: {
    borderRadius: 14,
    borderWidth: 1,
    padding: 16,
    gap: 12,
  },
  summaryTitle: { fontSize: 15, marginBottom: 4 },
  summaryRow: { flexDirection: "row", gap: 16 },
  summaryItem: { flex: 1, gap: 2 },
  summaryItemLabel: { fontSize: 12 },
  summaryItemValue: { fontSize: 16 },
  actions: { flexDirection: "row", gap: 12 },
  linkButton: {
    flex: 1,
    paddingVertical: 14,
    borderRadius: 12,
    borderWidth: 1,
    alignItems: "center",
  },
  linkButtonText: { fontSize: 14 },
  privacyNote: {
    borderRadius: 10,
    padding: 12,
    marginTop: 4,
  },
  privacyText: { fontSize: 12, lineHeight: 18, textAlign: "center" },
  geoVerifBadge: {
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
    alignSelf: "flex-start",
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 6,
    borderWidth: 1,
  },
  geoVerifBadgeText: { fontSize: 11 },
  modalOverlay: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.45)",
    justifyContent: "center",
    alignItems: "center",
    padding: 24,
  },
  modalCard: {
    width: "100%",
    borderRadius: 16,
    borderWidth: 1,
    padding: 24,
    gap: 0,
  },
  modalIconRow: {
    alignItems: "center",
    marginBottom: 16,
  },
  modalIconCircle: {
    width: 64,
    height: 64,
    borderRadius: 32,
    alignItems: "center",
    justifyContent: "center",
  },
  modalTitle: {
    fontSize: 18,
    textAlign: "center",
    marginBottom: 10,
  },
  modalDescription: {
    fontSize: 14,
    lineHeight: 22,
    textAlign: "center",
    marginBottom: 20,
  },
  correctionLink: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    paddingVertical: 12,
    paddingHorizontal: 16,
    borderRadius: 10,
    borderWidth: 1,
    marginBottom: 12,
  },
  correctionLinkText: { fontSize: 14 },
  modalDismissBtn: {
    paddingVertical: 14,
    borderRadius: 10,
    alignItems: "center",
  },
  modalDismissBtnText: { fontSize: 15 },
});

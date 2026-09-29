import {
  useGetAdminAttendanceRequests,
  useGetAdminAttendancePendingCount,
  useApproveAttendanceRequest,
  useRejectAttendanceRequest,
  getGetAdminAttendanceRequestsQueryKey,
  getGetAdminAttendancePendingCountQueryKey,
} from "@workspace/api-client-react";
import { Feather } from "@expo/vector-icons";
import React, { useCallback, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  FlatList,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  RefreshControl,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { type Href, useFocusEffect, useRouter } from "expo-router";
import { useQueryClient } from "@tanstack/react-query";

import { useColors } from "@/hooks/useColors";
import { usePendingBadgeAck } from "@/hooks/usePendingBadgeAck";

type RequestType =
  | "missed_clock_in"
  | "missed_clock_out"
  | "edit_clock_in"
  | "edit_clock_out"
  | "offsite_clock_in"
  | "offsite_clock_out"
  | "other"
  | string;

type CorrectionRequest = {
  id: number;
  employee_id: number;
  employee_name: string;
  request_type: RequestType;
  status: string;
  reason: string | null;
  requested_clock_in_at: string | null;
  requested_clock_out_at: string | null;
  reviewer_note: string | null;
  created_at: string;
};

function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return d.toLocaleString([], {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function formatDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return d.toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" });
}

function requestTypeLabel(type: RequestType): string {
  switch (type) {
    case "missed_clock_in": return "Missed Clock-In";
    case "missed_clock_out": return "Missed Clock-Out";
    case "edit_clock_in": return "Edit Clock-In";
    case "edit_clock_out": return "Edit Clock-Out";
    case "offsite_clock_in": return "Offsite Clock-In";
    case "offsite_clock_out": return "Offsite Clock-Out";
    case "other": return "Other";
    default: return type;
  }
}

function RequestCard({
  request,
  colors,
  onApprove,
  onReject,
}: {
  request: CorrectionRequest;
  colors: ReturnType<typeof useColors>;
  onApprove: (request: CorrectionRequest) => void;
  onReject: (request: CorrectionRequest) => void;
}) {
  return (
    <View style={[cardStyles.card, { backgroundColor: colors.card, borderColor: colors.border }]}>
      <View style={cardStyles.header}>
        <View style={{ flex: 1 }}>
          <Text style={[cardStyles.employeeName, { color: colors.foreground, fontFamily: "Inter_600SemiBold" }]}>
            {request.employee_name}
          </Text>
          <Text style={[cardStyles.requestType, { color: colors.primary, fontFamily: "Inter_500Medium" }]}>
            {requestTypeLabel(request.request_type)}
          </Text>
        </View>
        <Text style={[cardStyles.date, { color: colors.mutedForeground, fontFamily: "Inter_400Regular" }]}>
          {formatDate(request.created_at)}
        </Text>
      </View>

      {(request.requested_clock_in_at || request.requested_clock_out_at) && (
        <View style={[cardStyles.timesRow, { backgroundColor: colors.muted, borderRadius: 8 }]}>
          {request.requested_clock_in_at && (
            <View style={cardStyles.timeItem}>
              <Text style={[cardStyles.timeLabel, { color: colors.mutedForeground, fontFamily: "Inter_400Regular" }]}>
                Clock In
              </Text>
              <Text style={[cardStyles.timeValue, { color: colors.foreground, fontFamily: "Inter_600SemiBold" }]}>
                {formatDateTime(request.requested_clock_in_at)}
              </Text>
            </View>
          )}
          {request.requested_clock_out_at && (
            <View style={cardStyles.timeItem}>
              <Text style={[cardStyles.timeLabel, { color: colors.mutedForeground, fontFamily: "Inter_400Regular" }]}>
                Clock Out
              </Text>
              <Text style={[cardStyles.timeValue, { color: colors.foreground, fontFamily: "Inter_600SemiBold" }]}>
                {formatDateTime(request.requested_clock_out_at)}
              </Text>
            </View>
          )}
        </View>
      )}

      {request.reason ? (
        <Text style={[cardStyles.reason, { color: colors.mutedForeground, fontFamily: "Inter_400Regular" }]}>
          "{request.reason}"
        </Text>
      ) : null}

      <View style={cardStyles.actions}>
        <Pressable
          style={[cardStyles.actionBtn, { backgroundColor: colors.success + "18", borderColor: colors.success + "44" }]}
          onPress={() => onApprove(request)}
          hitSlop={4}
        >
          <Feather name="check" size={15} color={colors.success} />
          <Text style={[cardStyles.actionText, { color: colors.success, fontFamily: "Inter_600SemiBold" }]}>
            Approve
          </Text>
        </Pressable>
        <Pressable
          style={[cardStyles.actionBtn, { backgroundColor: colors.destructive + "12", borderColor: colors.destructive + "44" }]}
          onPress={() => onReject(request)}
          hitSlop={4}
        >
          <Feather name="x" size={15} color={colors.destructive} />
          <Text style={[cardStyles.actionText, { color: colors.destructive, fontFamily: "Inter_600SemiBold" }]}>
            Reject
          </Text>
        </Pressable>
      </View>
    </View>
  );
}

const cardStyles = StyleSheet.create({
  card: {
    borderRadius: 14,
    borderWidth: 1,
    padding: 16,
    gap: 12,
  },
  header: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 8,
  },
  employeeName: { fontSize: 15 },
  requestType: { fontSize: 13, marginTop: 2 },
  date: { fontSize: 12, marginTop: 2 },
  timesRow: { flexDirection: "row", gap: 16, padding: 10 },
  timeItem: { gap: 2 },
  timeLabel: { fontSize: 11 },
  timeValue: { fontSize: 13 },
  reason: { fontSize: 13, fontStyle: "italic" },
  actions: { flexDirection: "row", gap: 10 },
  actionBtn: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    paddingVertical: 10,
    borderRadius: 10,
    borderWidth: 1,
  },
  actionText: { fontSize: 14 },
});

type ActionMode = "approve" | "reject";

export default function ApprovalsScreen() {
  const colors = useColors();
  const queryClient = useQueryClient();
  const router = useRouter();
  const { ack } = usePendingBadgeAck();
  const { data: pendingCountData } = useGetAdminAttendancePendingCount();

  useFocusEffect(
    useCallback(() => {
      const rawCount = (pendingCountData as { count?: number } | undefined)?.count ?? 0;
      ack(rawCount);
      void queryClient.invalidateQueries({ queryKey: getGetAdminAttendancePendingCountQueryKey() });
    }, [queryClient, ack, pendingCountData]),
  );

  const [statusFilter, setStatusFilter] = useState<"pending" | "approved" | "rejected">("pending");
  const [actionModal, setActionModal] = useState<{
    mode: ActionMode;
    request: CorrectionRequest;
  } | null>(null);
  const [note, setNote] = useState("");
  const [actionLoading, setActionLoading] = useState(false);

  const { data, isLoading, isFetching, refetch } = useGetAdminAttendanceRequests({
    status: statusFilter,
    limit: 50,
    offset: 0,
  });

  const approveMutation = useApproveAttendanceRequest();
  const rejectMutation = useRejectAttendanceRequest();

  const result = data as {
    success?: boolean;
    requests?: CorrectionRequest[];
  } | undefined;

  const requests = result?.requests ?? [];

  function openApprove(request: CorrectionRequest) {
    setNote("");
    setActionModal({ mode: "approve", request });
  }

  function openReject(request: CorrectionRequest) {
    setNote("");
    setActionModal({ mode: "reject", request });
  }

  function closeModal() {
    if (!actionLoading) setActionModal(null);
  }

  async function handleConfirm() {
    if (!actionModal) return;
    setActionLoading(true);
    try {
      const { mode, request } = actionModal;
      if (mode === "approve") {
        await approveMutation.mutateAsync({ id: request.id, data: { reviewer_note: note.trim() || undefined } });
      } else {
        await rejectMutation.mutateAsync({ id: request.id, data: { reviewer_note: note.trim() || undefined } });
      }
      setActionModal(null);
      await queryClient.invalidateQueries({ queryKey: getGetAdminAttendanceRequestsQueryKey() });
      await queryClient.invalidateQueries({ queryKey: getGetAdminAttendancePendingCountQueryKey() });
    } catch {
      Alert.alert("Error", "Failed to process the request. Please try again.");
    } finally {
      setActionLoading(false);
    }
  }

  const isApproving = actionModal?.mode === "approve";
  const confirmColor = isApproving ? colors.success : colors.destructive;
  const confirmLabel = isApproving ? "Approve" : "Reject";

  return (
    <SafeAreaView style={[styles.safe, { backgroundColor: colors.background }]} edges={["bottom"]}>
      <Pressable
        style={[styles.liveBtn, { backgroundColor: colors.primary + "12", borderColor: colors.primary + "40" }]}
        onPress={() => router.push("/(tabs)/attendance/live" as Href)}
      >
        <View style={[styles.liveDot, { backgroundColor: colors.success }]} />
        <Text style={[styles.liveBtnText, { color: colors.primary, fontFamily: "Inter_600SemiBold" }]}>
          Live Attendance
        </Text>
        <Feather name="chevron-right" size={16} color={colors.primary} />
      </Pressable>

      <View style={[styles.filterRow, { borderBottomColor: colors.border }]}>
        {(["pending", "approved", "rejected"] as const).map((s) => (
          <Pressable
            key={s}
            style={[
              styles.filterBtn,
              statusFilter === s && { backgroundColor: colors.primary + "18" },
            ]}
            onPress={() => setStatusFilter(s)}
          >
            <Text
              style={[
                styles.filterText,
                {
                  color: statusFilter === s ? colors.primary : colors.mutedForeground,
                  fontFamily: statusFilter === s ? "Inter_600SemiBold" : "Inter_400Regular",
                },
              ]}
            >
              {s.charAt(0).toUpperCase() + s.slice(1)}
            </Text>
          </Pressable>
        ))}
      </View>

      {isLoading ? (
        <View style={styles.center}>
          <ActivityIndicator color={colors.primary} size="large" />
        </View>
      ) : requests.length === 0 ? (
        <View style={styles.center}>
          <Feather name="inbox" size={40} color={colors.mutedForeground} style={{ marginBottom: 16 }} />
          <Text style={[styles.emptyText, { color: colors.mutedForeground, fontFamily: "Inter_500Medium" }]}>
            {statusFilter === "pending" ? "No pending requests" : `No ${statusFilter} requests`}
          </Text>
          <Text style={[styles.emptySubtext, { color: colors.mutedForeground, fontFamily: "Inter_400Regular" }]}>
            {statusFilter === "pending"
              ? "All caught up! Your team has no correction requests waiting."
              : "Nothing to show here."}
          </Text>
        </View>
      ) : (
        <FlatList
          data={requests}
          keyExtractor={(item) => String(item.id)}
          contentContainerStyle={styles.list}
          refreshControl={
            <RefreshControl
              refreshing={isFetching && !isLoading}
              onRefresh={() => void refetch()}
              tintColor={colors.primary}
            />
          }
          renderItem={({ item }) => (
            <RequestCard
              request={item}
              colors={colors}
              onApprove={openApprove}
              onReject={openReject}
            />
          )}
        />
      )}

      <Modal
        visible={actionModal !== null}
        transparent
        animationType="fade"
        onRequestClose={closeModal}
      >
        <KeyboardAvoidingView
          behavior={Platform.OS === "ios" ? "padding" : "height"}
          style={styles.modalOverlay}
        >
          <Pressable style={StyleSheet.absoluteFill} onPress={closeModal} />
          <View style={[styles.modalCard, { backgroundColor: colors.card, borderColor: colors.border }]}>
            <View style={[styles.modalIconCircle, { backgroundColor: confirmColor + "18" }]}>
              <Feather
                name={isApproving ? "check-circle" : "x-circle"}
                size={28}
                color={confirmColor}
              />
            </View>

            <Text style={[styles.modalTitle, { color: colors.foreground, fontFamily: "Inter_600SemiBold" }]}>
              {isApproving ? "Approve Request" : "Reject Request"}
            </Text>

            {actionModal && (
              <Text style={[styles.modalSubtitle, { color: colors.mutedForeground, fontFamily: "Inter_400Regular" }]}>
                {actionModal.request.employee_name} · {requestTypeLabel(actionModal.request.request_type)}
              </Text>
            )}

            <Text style={[styles.noteLabel, { color: colors.foreground, fontFamily: "Inter_500Medium" }]}>
              Note (optional)
            </Text>
            <TextInput
              style={[
                styles.noteInput,
                {
                  borderColor: colors.border,
                  color: colors.foreground,
                  backgroundColor: colors.background,
                  fontFamily: "Inter_400Regular",
                },
              ]}
              placeholder="Add a note for the employee..."
              placeholderTextColor={colors.mutedForeground}
              value={note}
              onChangeText={setNote}
              multiline
              numberOfLines={3}
              textAlignVertical="top"
              editable={!actionLoading}
            />

            <View style={styles.modalActions}>
              <Pressable
                style={[styles.cancelBtn, { borderColor: colors.border }]}
                onPress={closeModal}
                disabled={actionLoading}
              >
                <Text style={[styles.cancelText, { color: colors.mutedForeground, fontFamily: "Inter_500Medium" }]}>
                  Cancel
                </Text>
              </Pressable>
              <Pressable
                style={[styles.confirmBtn, { backgroundColor: confirmColor }, actionLoading && styles.disabled]}
                onPress={() => void handleConfirm()}
                disabled={actionLoading}
              >
                {actionLoading ? (
                  <ActivityIndicator color="#ffffff" size="small" />
                ) : (
                  <Text style={[styles.confirmText, { fontFamily: "Inter_600SemiBold" }]}>
                    {confirmLabel}
                  </Text>
                )}
              </Pressable>
            </View>
          </View>
        </KeyboardAvoidingView>
      </Modal>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1 },
  liveBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    marginHorizontal: 16,
    marginTop: 12,
    marginBottom: 4,
    paddingHorizontal: 14,
    paddingVertical: 11,
    borderRadius: 12,
    borderWidth: 1,
  },
  liveDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
  },
  liveBtnText: { flex: 1, fontSize: 14 },
  filterRow: {
    flexDirection: "row",
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderBottomWidth: 1,
    gap: 8,
  },
  filterBtn: {
    paddingHorizontal: 14,
    paddingVertical: 7,
    borderRadius: 20,
  },
  filterText: { fontSize: 13 },
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
  modalOverlay: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.45)",
    justifyContent: "center",
    alignItems: "center",
    padding: 24,
  },
  modalCard: {
    width: "100%",
    borderRadius: 20,
    borderWidth: 1,
    padding: 24,
    gap: 12,
    alignItems: "stretch",
  },
  modalIconCircle: {
    width: 56,
    height: 56,
    borderRadius: 28,
    alignItems: "center",
    justifyContent: "center",
    alignSelf: "center",
    marginBottom: 4,
  },
  modalTitle: { fontSize: 18, textAlign: "center" },
  modalSubtitle: { fontSize: 13, textAlign: "center", marginBottom: 4 },
  noteLabel: { fontSize: 14 },
  noteInput: {
    borderWidth: 1,
    borderRadius: 10,
    padding: 12,
    fontSize: 14,
    minHeight: 80,
  },
  modalActions: { flexDirection: "row", gap: 10, marginTop: 4 },
  cancelBtn: {
    flex: 1,
    paddingVertical: 13,
    borderRadius: 10,
    borderWidth: 1,
    alignItems: "center",
  },
  cancelText: { fontSize: 15 },
  confirmBtn: {
    flex: 1,
    paddingVertical: 13,
    borderRadius: 10,
    alignItems: "center",
  },
  confirmText: { fontSize: 15, color: "#ffffff" },
  disabled: { opacity: 0.6 },
});

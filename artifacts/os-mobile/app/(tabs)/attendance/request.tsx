import {
  useCreateAttendanceRequest,
  type CreateAttendanceRequestBodyRequestType,
} from "@workspace/api-client-react";
import DateTimePicker, {
  type DateTimePickerEvent,
} from "@react-native-community/datetimepicker";
import { useRouter } from "expo-router";
import React, { useState } from "react";
import {
  ActivityIndicator,
  Alert,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { useColors } from "@/hooks/useColors";

type RequestType = CreateAttendanceRequestBodyRequestType;

const REQUEST_TYPES: { value: RequestType; label: string; description: string }[] = [
  { value: "missed_clock_in", label: "Missed Clock-In", description: "I forgot to clock in" },
  { value: "missed_clock_out", label: "Missed Clock-Out", description: "I forgot to clock out" },
  { value: "edit_clock_in", label: "Edit Clock-In", description: "Correct my clock-in time" },
  { value: "edit_clock_out", label: "Edit Clock-Out", description: "Correct my clock-out time" },
  { value: "offsite_clock_in", label: "Offsite Clock-In", description: "Clocked in from an offsite location" },
  { value: "offsite_clock_out", label: "Offsite Clock-Out", description: "Clocked out from an offsite location" },
  { value: "other", label: "Other", description: "Another type of correction" },
];

function formatDateTimeLocal(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function toISOStr(d: Date): string {
  return d.toISOString();
}

function DateTimeField({
  label,
  value,
  onChange,
  colors,
}: {
  label: string;
  value: Date | null;
  onChange: (d: Date) => void;
  colors: ReturnType<typeof useColors>;
}) {
  const [show, setShow] = useState(false);
  const display = value ? formatDateTimeLocal(value) : "";

  return (
    <View style={dtStyles.container}>
      <Text style={[dtStyles.label, { color: colors.foreground, fontFamily: "Inter_500Medium" }]}>{label}</Text>
      <Pressable
        style={[dtStyles.field, {
          backgroundColor: colors.card,
          borderColor: colors.border,
        }]}
        onPress={() => setShow(true)}
      >
        <Text style={{
          color: display ? colors.foreground : colors.mutedForeground,
          fontFamily: "Inter_400Regular",
          fontSize: 15,
        }}>
          {display || "Tap to set date & time"}
        </Text>
      </Pressable>
      {show && (
        <DateTimePicker
          value={value || new Date()}
          mode="datetime"
          display={Platform.OS === "ios" ? "spinner" : "default"}
          onChange={(_: DateTimePickerEvent, selectedDate?: Date) => {
            if (Platform.OS === "android") setShow(false);
            if (selectedDate) onChange(selectedDate);
          }}
        />
      )}
      {Platform.OS !== "web" && (
        <Text style={[dtStyles.hint, { color: colors.mutedForeground, fontFamily: "Inter_400Regular" }]}>
          Uses your device\u2019s native date picker
        </Text>
      )}
    </View>
  );
}

const dtStyles = StyleSheet.create({
  container: { gap: 4 },
  label: { fontSize: 14, marginBottom: 2 },
  field: {
    height: 48,
    borderRadius: 10,
    borderWidth: 1,
    paddingHorizontal: 14,
    justifyContent: "center",
  },
  hint: { fontSize: 11 },
});

export default function RequestCorrectionScreen() {
  const colors = useColors();
  const router = useRouter();

  const [requestType, setRequestType] = useState<RequestType>("missed_clock_in");
  const [clockInDate, setClockInDate] = useState<Date | null>(null);
  const [clockOutDate, setClockOutDate] = useState<Date | null>(null);
  const [reason, setReason] = useState("");

  const createMutation = useCreateAttendanceRequest();

  const needsClockIn = ["missed_clock_in", "edit_clock_in", "offsite_clock_in"].includes(requestType);
  const needsClockOut = ["missed_clock_out", "edit_clock_out", "offsite_clock_out"].includes(requestType);

  async function handleSubmit() {
    if (!reason.trim()) {
      Alert.alert("Missing reason", "Please provide a reason for the correction request.");
      return;
    }

    if (needsClockIn && !clockInDate) {
      Alert.alert("Missing time", "Please select a clock-in date and time.");
      return;
    }
    if (needsClockOut && !clockOutDate) {
      Alert.alert("Missing time", "Please select a clock-out date and time.");
      return;
    }

    try {
      await createMutation.mutateAsync({
        data: {
          request_type: requestType,
          reason: reason.trim(),
          ...(clockInDate ? { requested_clock_in_at: toISOStr(clockInDate) } : {}),
          ...(clockOutDate ? { requested_clock_out_at: toISOStr(clockOutDate) } : {}),
        },
      });
      Alert.alert(
        "Request submitted",
        "Your correction request has been submitted and is pending manager review.",
        [{ text: "OK", onPress: () => router.back() }],
      );
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Failed to submit request";
      Alert.alert("Error", msg);
    }
  }

  const isLoading = createMutation.isPending;

  return (
    <SafeAreaView style={[styles.safe, { backgroundColor: colors.background }]} edges={["bottom"]}>
      <KeyboardAvoidingView
        behavior={Platform.OS === "ios" ? "padding" : "height"}
        style={styles.flex}
      >
        <ScrollView contentContainerStyle={styles.scroll} keyboardShouldPersistTaps="handled">
          <Text style={[styles.sectionTitle, { color: colors.foreground, fontFamily: "Inter_600SemiBold" }]}>
            Request Type
          </Text>
          <View style={[styles.typeList, { borderColor: colors.border }]}>
            {REQUEST_TYPES.map((rt, index) => (
              <Pressable
                key={rt.value}
                style={[
                  styles.typeRow,
                  {
                    backgroundColor: requestType === rt.value ? colors.primary + "12" : colors.card,
                    borderBottomColor: colors.border,
                  },
                  index === REQUEST_TYPES.length - 1 && styles.typeRowLast,
                ]}
                onPress={() => setRequestType(rt.value)}
              >
                <View style={styles.typeContent}>
                  <Text style={[styles.typeLabel, {
                    color: requestType === rt.value ? colors.primary : colors.foreground,
                    fontFamily: "Inter_500Medium",
                  }]}>
                    {rt.label}
                  </Text>
                  <Text style={[styles.typeDescription, { color: colors.mutedForeground, fontFamily: "Inter_400Regular" }]}>
                    {rt.description}
                  </Text>
                </View>
                <View style={[styles.radio, {
                  borderColor: requestType === rt.value ? colors.primary : colors.border,
                }]}>
                  {requestType === rt.value && (
                    <View style={[styles.radioFill, { backgroundColor: colors.primary }]} />
                  )}
                </View>
              </Pressable>
            ))}
          </View>

          {needsClockIn && (
            <DateTimeField
              label="Requested Clock-In Time"
              value={clockInDate}
              onChange={setClockInDate}
              colors={colors}
            />
          )}

          {needsClockOut && (
            <DateTimeField
              label="Requested Clock-Out Time"
              value={clockOutDate}
              onChange={setClockOutDate}
              colors={colors}
            />
          )}

          <View style={styles.reasonContainer}>
            <Text style={[styles.sectionTitle, { color: colors.foreground, fontFamily: "Inter_600SemiBold" }]}>
              Reason *
            </Text>
            <TextInput
              style={[styles.reasonInput, {
                backgroundColor: colors.card,
                borderColor: colors.border,
                color: colors.foreground,
                fontFamily: "Inter_400Regular",
              }]}
              value={reason}
              onChangeText={setReason}
              placeholder="Explain why you're requesting this correction..."
              placeholderTextColor={colors.mutedForeground}
              multiline
              numberOfLines={4}
            />
          </View>

          <Pressable
            style={[styles.submitButton, { backgroundColor: colors.primary },
              (isLoading || !reason.trim()) && styles.disabled,
            ]}
            onPress={handleSubmit}
            disabled={isLoading || !reason.trim()}
          >
            {isLoading ? (
              <ActivityIndicator color="#ffffff" />
            ) : (
              <Text style={[styles.submitButtonText, { fontFamily: "Inter_600SemiBold" }]}>
                Submit Request
              </Text>
            )}
          </Pressable>

          <Text style={[styles.disclaimer, { color: colors.mutedForeground, fontFamily: "Inter_400Regular" }]}>
            Your request will be reviewed by a manager. You'll receive a notification once a decision is made.
          </Text>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1 },
  flex: { flex: 1 },
  scroll: { padding: 20, gap: 20 },
  sectionTitle: { fontSize: 15 },
  typeList: {
    borderRadius: 14,
    borderWidth: 1,
    overflow: "hidden",
  },
  typeRow: {
    flexDirection: "row",
    alignItems: "center",
    padding: 14,
    borderBottomWidth: 1,
    gap: 12,
  },
  typeRowLast: { borderBottomWidth: 0 },
  typeContent: { flex: 1, gap: 2 },
  typeLabel: { fontSize: 14 },
  typeDescription: { fontSize: 12 },
  radio: {
    width: 20,
    height: 20,
    borderRadius: 10,
    borderWidth: 2,
    alignItems: "center",
    justifyContent: "center",
  },
  radioFill: { width: 10, height: 10, borderRadius: 5 },
  reasonContainer: { gap: 8 },
  reasonInput: {
    borderWidth: 1,
    borderRadius: 10,
    padding: 12,
    fontSize: 14,
    minHeight: 100,
    textAlignVertical: "top",
  },
  submitButton: {
    height: 52,
    borderRadius: 12,
    alignItems: "center",
    justifyContent: "center",
    marginTop: 4,
  },
  submitButtonText: { color: "#ffffff", fontSize: 16 },
  disabled: { opacity: 0.5 },
  disclaimer: {
    fontSize: 12,
    textAlign: "center",
    lineHeight: 18,
    paddingBottom: 24,
  },
});

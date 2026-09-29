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
import { Feather } from "@expo/vector-icons";
import { router } from "expo-router";

import { useColors } from "@/hooks/useColors";
import { useCreateAttendanceRequest } from "@workspace/api-client-react";

const REQUEST_TYPES = [
  { value: "missed_clock_in", label: "Missed Clock In" },
  { value: "missed_clock_out", label: "Missed Clock Out" },
  { value: "edit_clock_in", label: "Edit Clock In Time" },
  { value: "edit_clock_out", label: "Edit Clock Out Time" },
  { value: "offsite_clock_in", label: "Offsite Clock In" },
  { value: "offsite_clock_out", label: "Offsite Clock Out" },
  { value: "other", label: "Other" },
] as const;

type RequestType = (typeof REQUEST_TYPES)[number]["value"];

function formatLocalDatetime(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `T${pad(date.getHours())}:${pad(date.getMinutes())}`
  );
}

export default function CorrectionRequestScreen() {
  const colors = useColors();

  const [requestType, setRequestType] = useState<RequestType>("missed_clock_in");
  const [clockInAt, setClockInAt] = useState("");
  const [clockOutAt, setClockOutAt] = useState("");
  const [reason, setReason] = useState("");

  const mutation = useCreateAttendanceRequest();

  const needsClockIn = ["missed_clock_in", "edit_clock_in", "offsite_clock_in"].includes(
    requestType,
  );
  const needsClockOut = ["missed_clock_out", "edit_clock_out", "offsite_clock_out"].includes(
    requestType,
  );

  const handleSubmit = async () => {
    if (!reason.trim()) {
      Alert.alert("Reason Required", "Please describe the reason for your correction request.");
      return;
    }

    try {
      await mutation.mutateAsync({
        data: {
          request_type: requestType,
          requested_clock_in_at: needsClockIn && clockInAt ? new Date(clockInAt).toISOString() : undefined,
          requested_clock_out_at: needsClockOut && clockOutAt ? new Date(clockOutAt).toISOString() : undefined,
          reason: reason.trim(),
        },
      });
      Alert.alert(
        "Request Submitted",
        "Your correction request has been submitted and is pending review.",
        [{ text: "OK", onPress: () => router.back() }],
      );
    } catch (err: unknown) {
      const msg =
        (err as { data?: { error?: string } })?.data?.error ??
        "Failed to submit request. Please try again.";
      Alert.alert("Submission Failed", msg);
    }
  };

  return (
    <SafeAreaView style={[styles.container, { backgroundColor: colors.background }]}>
      <KeyboardAvoidingView
        behavior={Platform.OS === "ios" ? "padding" : undefined}
        style={{ flex: 1 }}
      >
        <ScrollView
          contentContainerStyle={styles.scroll}
          showsVerticalScrollIndicator={false}
          keyboardShouldPersistTaps="handled"
        >
          {/* Nav Header */}
          <View style={styles.navHeader}>
            <Pressable
              onPress={() => router.back()}
              style={[styles.backBtn, { backgroundColor: colors.secondary }]}
            >
              <Feather name="arrow-left" size={18} color={colors.secondaryForeground} />
            </Pressable>
            <Text
              style={[
                styles.navTitle,
                { color: colors.foreground, fontFamily: "Inter_700Bold" },
              ]}
            >
              Correction Request
            </Text>
            <View style={{ width: 36 }} />
          </View>

          <Text
            style={[
              styles.subtitle,
              { color: colors.mutedForeground, fontFamily: "Inter_400Regular" },
            ]}
          >
            Submit a request to correct a missed or incorrect punch. Your manager will review it.
          </Text>

          {/* Request Type */}
          <Text
            style={[styles.label, { color: colors.foreground, fontFamily: "Inter_600SemiBold" }]}
          >
            Request Type
          </Text>
          <View style={[styles.typeGrid]}>
            {REQUEST_TYPES.map((rt) => {
              const selected = requestType === rt.value;
              return (
                <Pressable
                  key={rt.value}
                  onPress={() => setRequestType(rt.value)}
                  style={[
                    styles.typeChip,
                    {
                      backgroundColor: selected ? colors.primary : colors.card,
                      borderColor: selected ? colors.primary : colors.border,
                    },
                  ]}
                >
                  <Text
                    style={[
                      styles.typeChipText,
                      {
                        color: selected ? colors.primaryForeground : colors.foreground,
                        fontFamily: selected ? "Inter_600SemiBold" : "Inter_400Regular",
                      },
                    ]}
                  >
                    {rt.label}
                  </Text>
                </Pressable>
              );
            })}
          </View>

          {/* Clock-In Time */}
          {needsClockIn && (
            <View style={styles.fieldGroup}>
              <Text
                style={[styles.label, { color: colors.foreground, fontFamily: "Inter_600SemiBold" }]}
              >
                Requested Clock-In Time
              </Text>
              <TextInput
                style={[
                  styles.input,
                  {
                    backgroundColor: colors.card,
                    borderColor: colors.border,
                    color: colors.foreground,
                    fontFamily: "Inter_400Regular",
                  },
                ]}
                placeholder="YYYY-MM-DDTHH:MM"
                placeholderTextColor={colors.mutedForeground}
                value={clockInAt}
                onChangeText={setClockInAt}
                autoCapitalize="none"
                autoCorrect={false}
              />
              <Pressable
                onPress={() => setClockInAt(formatLocalDatetime(new Date()))}
                style={styles.nowBtn}
              >
                <Text
                  style={[
                    styles.nowBtnText,
                    { color: colors.primary, fontFamily: "Inter_500Medium" },
                  ]}
                >
                  Use now
                </Text>
              </Pressable>
            </View>
          )}

          {/* Clock-Out Time */}
          {needsClockOut && (
            <View style={styles.fieldGroup}>
              <Text
                style={[styles.label, { color: colors.foreground, fontFamily: "Inter_600SemiBold" }]}
              >
                Requested Clock-Out Time
              </Text>
              <TextInput
                style={[
                  styles.input,
                  {
                    backgroundColor: colors.card,
                    borderColor: colors.border,
                    color: colors.foreground,
                    fontFamily: "Inter_400Regular",
                  },
                ]}
                placeholder="YYYY-MM-DDTHH:MM"
                placeholderTextColor={colors.mutedForeground}
                value={clockOutAt}
                onChangeText={setClockOutAt}
                autoCapitalize="none"
                autoCorrect={false}
              />
              <Pressable
                onPress={() => setClockOutAt(formatLocalDatetime(new Date()))}
                style={styles.nowBtn}
              >
                <Text
                  style={[
                    styles.nowBtnText,
                    { color: colors.primary, fontFamily: "Inter_500Medium" },
                  ]}
                >
                  Use now
                </Text>
              </Pressable>
            </View>
          )}

          {/* Reason */}
          <View style={styles.fieldGroup}>
            <Text
              style={[styles.label, { color: colors.foreground, fontFamily: "Inter_600SemiBold" }]}
            >
              Reason <Text style={{ color: colors.destructive }}>*</Text>
            </Text>
            <TextInput
              style={[
                styles.textarea,
                {
                  backgroundColor: colors.card,
                  borderColor: colors.border,
                  color: colors.foreground,
                  fontFamily: "Inter_400Regular",
                },
              ]}
              placeholder="Explain what happened and what needs to be corrected…"
              placeholderTextColor={colors.mutedForeground}
              value={reason}
              onChangeText={setReason}
              multiline
              numberOfLines={5}
              textAlignVertical="top"
            />
          </View>

          {/* Submit */}
          <Pressable
            style={[
              styles.submitBtn,
              {
                backgroundColor: colors.primary,
                opacity: mutation.isPending ? 0.6 : 1,
              },
            ]}
            onPress={handleSubmit}
            disabled={mutation.isPending}
          >
            {mutation.isPending ? (
              <ActivityIndicator size="small" color={colors.primaryForeground} />
            ) : (
              <Feather name="send" size={16} color={colors.primaryForeground} />
            )}
            <Text
              style={[
                styles.submitBtnText,
                { color: colors.primaryForeground, fontFamily: "Inter_600SemiBold" },
              ]}
            >
              {mutation.isPending ? "Submitting…" : "Submit Request"}
            </Text>
          </Pressable>

          <View style={{ height: 60 }} />
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  scroll: {
    padding: 20,
  },
  navHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: 16,
  },
  backBtn: {
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: "center",
    justifyContent: "center",
  },
  navTitle: {
    fontSize: 20,
  },
  subtitle: {
    fontSize: 14,
    lineHeight: 20,
    marginBottom: 24,
  },
  label: {
    fontSize: 14,
    marginBottom: 8,
  },
  typeGrid: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 8,
    marginBottom: 24,
  },
  typeChip: {
    borderWidth: 1,
    borderRadius: 8,
    paddingHorizontal: 14,
    paddingVertical: 8,
  },
  typeChipText: {
    fontSize: 13,
  },
  fieldGroup: {
    marginBottom: 20,
  },
  input: {
    borderWidth: 1,
    borderRadius: 8,
    paddingHorizontal: 14,
    paddingVertical: 12,
    fontSize: 14,
  },
  nowBtn: {
    marginTop: 6,
    alignSelf: "flex-start",
  },
  nowBtnText: {
    fontSize: 13,
  },
  textarea: {
    borderWidth: 1,
    borderRadius: 8,
    paddingHorizontal: 14,
    paddingVertical: 12,
    fontSize: 14,
    minHeight: 110,
  },
  submitBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    paddingVertical: 15,
    borderRadius: 10,
    marginTop: 8,
  },
  submitBtnText: {
    fontSize: 15,
  },
});

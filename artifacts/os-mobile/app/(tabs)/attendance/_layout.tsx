import { Stack } from "expo-router";
import React from "react";
import { useColors } from "@/hooks/useColors";

export default function AttendanceLayout() {
  const colors = useColors();
  return (
    <Stack
      screenOptions={{
        headerShown: true,
        headerBackButtonDisplayMode: "minimal",
        headerStyle: { backgroundColor: colors.card },
        headerTintColor: colors.primary,
        headerTitleStyle: {
          fontFamily: "Inter_600SemiBold",
          fontSize: 16,
          color: colors.foreground,
        },
        contentStyle: { backgroundColor: colors.background },
      }}
    >
      <Stack.Screen name="index" options={{ title: "Attendance" }} />
      <Stack.Screen name="timesheets" options={{ title: "My Timesheets" }} />
      <Stack.Screen name="request" options={{ title: "Request Correction" }} />
      <Stack.Screen name="approvals" options={{ title: "Team Approvals" }} />
      <Stack.Screen name="live" options={{ title: "Live Attendance" }} />
    </Stack>
  );
}

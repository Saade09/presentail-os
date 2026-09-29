import { setAuthTokenGetter, useSaveAttendancePushToken, useGetAdminAttendancePendingCount, getGetAdminAttendancePendingCountQueryKey } from "@workspace/api-client-react";
import { BlurView } from "expo-blur";
import { type Href, Redirect, Tabs, useRouter } from "expo-router";
import { SymbolView } from "expo-symbols";
import { Feather } from "@expo/vector-icons";
import * as Notifications from "expo-notifications";
import { Platform } from "react-native";
import React, { useEffect, useRef } from "react";
import { StyleSheet, View, useColorScheme } from "react-native";

import { useColors } from "@/hooks/useColors";
import { usePendingBadgeAck } from "@/hooks/usePendingBadgeAck";
import { useAuth } from "@/contexts/AuthContext";

try {
  Notifications.setNotificationHandler({
    handleNotification: async () => ({
      shouldShowAlert: true,
      shouldPlaySound: true,
      shouldSetBadge: false,
      shouldShowBanner: true,
      shouldShowList: true,
    }),
  });
} catch {
  // Never let notification-handler setup crash the app at module load.
}

async function registerForPushNotificationsAsync(): Promise<string | null> {
  if (Platform.OS === "web") return null;

  try {
    let permResponse = await Notifications.getPermissionsAsync() as unknown as { granted: boolean };
    if (!permResponse.granted) {
      permResponse = await Notifications.requestPermissionsAsync() as unknown as { granted: boolean };
    }
    if (!permResponse.granted) return null;

    const tokenData = await Notifications.getExpoPushTokenAsync();
    return tokenData.data;
  } catch (err: unknown) {
    // FCM may not be available if google-services.json is missing or Play
    // Services are absent. Log the reason but never let it crash the app.
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[Notifications] Push registration failed (non-fatal):", msg);
    return null;
  }
}

export default function TabLayout() {
  const colors = useColors();
  const colorScheme = useColorScheme();
  const isDark = colorScheme === "dark";
  const isIOS = Platform.OS === "ios";
  const isWeb = Platform.OS === "web";
  const { isSignedIn, isLoaded, token } = useAuth();
  const router = useRouter();
  const notificationResponseListener = useRef<Notifications.EventSubscription | null>(null);

  const savePushToken = useSaveAttendancePushToken();

  const { data: pendingCountData } = useGetAdminAttendancePendingCount({
    query: { queryKey: getGetAdminAttendancePendingCountQueryKey(), refetchInterval: 30_000, enabled: !!isSignedIn },
  });
  const { ackCount } = usePendingBadgeAck();
  const rawPendingCount = (pendingCountData as { count?: number } | undefined)?.count ?? 0;
  const pendingCount = rawPendingCount > ackCount ? rawPendingCount - ackCount : 0;

  useEffect(() => {
    setAuthTokenGetter(() => Promise.resolve(token));
  }, [token]);

  useEffect(() => {
    if (!isSignedIn || isWeb) return;

    void registerForPushNotificationsAsync().then((expoPushToken) => {
      if (!expoPushToken) return;
      savePushToken.mutate({ data: { expo_push_token: expoPushToken } });
    });

    notificationResponseListener.current = Notifications.addNotificationResponseReceivedListener(
      (response) => {
        const screen = response.notification.request.content.data?.screen as string | undefined;
        if (screen === "approvals") {
          router.push("/(tabs)/attendance/approvals" as Href);
        } else if (screen === "attendance") {
          router.push("/(tabs)/attendance" as Href);
        } else if (screen === "orders") {
          router.push("/(tabs)" as Href);
        } else if (screen === "florist-orders") {
          router.push("/(tabs)" as Href);
        }
      },
    );

    return () => {
      notificationResponseListener.current?.remove();
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isSignedIn, isWeb]);

  // E2E test bypass — two independent guards are required:
  //   1. EXPO_PUBLIC_E2E_HARNESS === "1"  (compile-time, baked into the bundle
  //      by the Playwright webServer env).  This is never set in production
  //      deployments, so the condition short-circuits to false and no
  //      localStorage read is attempted.  A user cannot enable this at
  //      runtime in a production build.
  //   2. localStorage.__e2e_auth_bypass === "1"  (set per-test via
  //      page.addInitScript in clerk-session-mock.ts).  This ensures only
  //      tests that explicitly opt in bypass the redirect — existing auth
  //      flow tests that never set the key still redirect normally.
  const isE2EAuthBypass =
    process.env.EXPO_PUBLIC_E2E_HARNESS === "1" &&
    Platform.OS === "web" &&
    typeof window !== "undefined" &&
    window.localStorage?.getItem("__e2e_auth_bypass") === "1";

  if (!isLoaded) return null;
  if (!isSignedIn && !isE2EAuthBypass) return <Redirect href={"/(auth)/sign-in" as Href} />;

  return (
    <Tabs
      screenOptions={{
        tabBarActiveTintColor: colors.primary,
        tabBarInactiveTintColor: colors.mutedForeground,
        headerShown: false,
        tabBarStyle: {
          position: "absolute",
          backgroundColor: isIOS ? "transparent" : colors.card,
          borderTopWidth: 1,
          borderTopColor: colors.border,
          elevation: 0,
          ...(isWeb ? { height: 84 } : {}),
        },
        tabBarBackground: () =>
          isIOS ? (
            <BlurView
              intensity={100}
              tint={isDark ? "dark" : "light"}
              style={StyleSheet.absoluteFill}
            />
          ) : isWeb ? (
            <View
              style={[StyleSheet.absoluteFill, { backgroundColor: colors.card }]}
            />
          ) : null,
        tabBarLabelStyle: {
          fontFamily: "Inter_500Medium",
          fontSize: 11,
        },
      }}
    >
      <Tabs.Screen
        name="index"
        options={{
          title: "Dashboard",
          tabBarIcon: ({ color }) =>
            isIOS ? (
              <SymbolView name="house" tintColor={color} size={22} />
            ) : (
              <Feather name="home" size={22} color={color} />
            ),
        }}
      />
      <Tabs.Screen
        name="attendance"
        options={{
          title: "Attendance",
          tabBarBadge: pendingCount > 0 ? pendingCount : undefined,
          tabBarIcon: ({ color }) =>
            isIOS ? (
              <SymbolView name="clock" tintColor={color} size={22} />
            ) : (
              <Feather name="clock" size={22} color={color} />
            ),
        }}
      />
      <Tabs.Screen
        name="team"
        options={{
          title: "Team",
          tabBarIcon: ({ color }) =>
            isIOS ? (
              <SymbolView name="person.2" tintColor={color} size={22} />
            ) : (
              <Feather name="users" size={22} color={color} />
            ),
        }}
      />
    </Tabs>
  );
}

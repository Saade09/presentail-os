import {
  Inter_400Regular,
  Inter_500Medium,
  Inter_600SemiBold,
  Inter_700Bold,
  useFonts,
} from "@expo-google-fonts/inter";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Stack } from "expo-router";
import * as SplashScreen from "expo-splash-screen";
import React, { useCallback, useRef, useEffect } from "react";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { SafeAreaProvider } from "react-native-safe-area-context";

import { ErrorBoundary } from "@/components/ErrorBoundary";
import { setBaseUrl } from "@workspace/api-client-react";
import { PendingBadgeAckProvider, usePendingBadgeAckState } from "@/hooks/usePendingBadgeAck";
import { AuthProvider } from "@/contexts/AuthContext";

SplashScreen.preventAutoHideAsync().catch(() => {});

const queryClient = new QueryClient();

const domain = process.env.EXPO_PUBLIC_DOMAIN;
if (domain) setBaseUrl(`https://${domain}`);

function RootLayoutNav() {
  const { ackCount, ack } = usePendingBadgeAckState();

  return (
    <PendingBadgeAckProvider value={{ ackCount, ack }}>
      <Stack screenOptions={{ headerShown: false }}>
        <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
        <Stack.Screen name="(auth)" options={{ headerShown: false }} />
        <Stack.Screen
          name="correction-request"
          options={{
            headerShown: false,
            presentation: "modal",
          }}
        />
      </Stack>
    </PendingBadgeAckProvider>
  );
}

export default function RootLayout() {
  const [fontsLoaded, fontError] = useFonts({
    Inter_400Regular,
    Inter_500Medium,
    Inter_600SemiBold,
    Inter_700Bold,
  });

  // Track both readiness signals before hiding the splash screen so there's no
  // blank-white flash between splash and the first real screen.
  const authLoadedRef = useRef(false);
  const fontsReadyRef = useRef(false);

  const maybeDismissSplash = useCallback(() => {
    if (authLoadedRef.current && fontsReadyRef.current) {
      SplashScreen.hideAsync().catch(() => {});
    }
  }, []);

  const handleAuthLoaded = useCallback(() => {
    authLoadedRef.current = true;
    maybeDismissSplash();
  }, [maybeDismissSplash]);

  useEffect(() => {
    if (fontsLoaded || fontError) {
      fontsReadyRef.current = true;
      maybeDismissSplash();
    }
  }, [fontsLoaded, fontError, maybeDismissSplash]);

  if (!fontsLoaded && !fontError) return null;

  return (
    <SafeAreaProvider>
      <ErrorBoundary>
        <AuthProvider onLoaded={handleAuthLoaded}>
          <QueryClientProvider client={queryClient}>
            <GestureHandlerRootView style={{ flex: 1 }}>
              <RootLayoutNav />
            </GestureHandlerRootView>
          </QueryClientProvider>
        </AuthProvider>
      </ErrorBoundary>
    </SafeAreaProvider>
  );
}

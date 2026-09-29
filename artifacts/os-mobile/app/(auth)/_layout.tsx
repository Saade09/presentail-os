import { Redirect, Stack } from "expo-router";
import { useAuth } from "@/contexts/AuthContext";

export default function AuthLayout() {
  const { isSignedIn, isLoaded } = useAuth();

  if (!isLoaded) return null;
  if (isSignedIn) return <Redirect href="/(tabs)" />;

  return (
    <Stack screenOptions={{ headerShown: false }}>
      <Stack.Screen name="index" />
      <Stack.Screen name="sign-in" options={{ animation: "fade" }} />
    </Stack>
  );
}

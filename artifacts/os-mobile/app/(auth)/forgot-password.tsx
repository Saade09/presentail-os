import { useRouter } from "expo-router";
import React from "react";
import {
  StyleSheet,
  Text,
  View,
  Pressable,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { useColors } from "@/hooks/useColors";

export default function ForgotPasswordScreen() {
  const colors = useColors();
  const router = useRouter();

  return (
    <SafeAreaView style={[styles.safe, { backgroundColor: colors.background }]}>
      <View style={styles.container}>
        <Pressable onPress={() => router.back()} style={styles.backButton}>
          <Text style={[styles.backText, { color: colors.primary, fontFamily: "Inter_500Medium" }]}>
            ← Back
          </Text>
        </Pressable>

        <View style={styles.header}>
          <Text testID="forgot-password-title" style={[styles.title, { color: colors.foreground, fontFamily: "Inter_700Bold" }]}>
            Reset your password
          </Text>
          <Text style={[styles.subtitle, { color: colors.mutedForeground, fontFamily: "Inter_400Regular" }]}>
            Password resets are managed through the Presentail OS web dashboard. Please sign in at{" "}
            <Text style={{ color: colors.primary }}>app.presentail.com</Text>
            {" "}and use the "Forgot password" link there.
          </Text>
        </View>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1 },
  container: {
    flex: 1,
    paddingHorizontal: 24,
    paddingVertical: 40,
  },
  backButton: {
    marginBottom: 24,
  },
  backText: {
    fontSize: 15,
  },
  header: {
    gap: 6,
    marginTop: 40,
  },
  title: {
    fontSize: 28,
    letterSpacing: -0.5,
  },
  subtitle: {
    fontSize: 15,
    lineHeight: 22,
    marginTop: 8,
  },
});

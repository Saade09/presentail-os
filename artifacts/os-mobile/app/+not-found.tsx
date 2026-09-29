import { Link, Stack } from "expo-router";
import React from "react";
import { StyleSheet, Text, View } from "react-native";

import { useColors } from "@/hooks/useColors";

export default function NotFoundScreen() {
  const colors = useColors();

  return (
    <>
      <Stack.Screen options={{ title: "Not Found" }} />
      <View style={[styles.container, { backgroundColor: colors.background }]}>
        <Text style={[styles.title, { color: colors.foreground }]}>
          This screen doesn't exist.
        </Text>
        <Link href="/" style={[styles.link, { color: colors.primary }]}>
          Go to home screen
        </Link>
      </View>
    </>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    padding: 20,
  },
  title: {
    fontSize: 20,
    fontWeight: "600",
    marginBottom: 16,
  },
  link: {
    fontSize: 14,
    textDecorationLine: "underline",
  },
});

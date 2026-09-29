import React from "react";
import { View, Text, StyleSheet, TouchableOpacity } from "react-native";

interface State {
  hasError: boolean;
  error?: Error;
}

interface Props {
  children: React.ReactNode;
}

export class ErrorBoundary extends React.Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false };
  }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo): void {
    // Log to console so crashes appear in EAS build logs and `adb logcat`.
    // Strips nothing — stack traces are essential for diagnosing release builds.
    console.error(
      "[ErrorBoundary] Uncaught React error:",
      error.message,
      "\nStack:", error.stack,
      "\nComponent stack:", info.componentStack,
    );
  }

  render() {
    if (this.state.hasError) {
      return (
        <View style={styles.container}>
          <Text style={styles.title}>Something went wrong</Text>
          <Text style={styles.message}>{this.state.error?.message}</Text>
          <TouchableOpacity
            style={styles.button}
            onPress={() => this.setState({ hasError: false })}
          >
            <Text style={styles.buttonText}>Try again</Text>
          </TouchableOpacity>
        </View>
      );
    }

    return this.props.children;
  }
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    padding: 24,
    backgroundColor: "#f9fafb",
  },
  title: {
    fontSize: 18,
    fontWeight: "600",
    color: "#0f1624",
    marginBottom: 8,
  },
  message: {
    fontSize: 14,
    color: "#525f7a",
    textAlign: "center",
    marginBottom: 24,
  },
  button: {
    paddingHorizontal: 20,
    paddingVertical: 10,
    backgroundColor: "#0a3f4d",
    borderRadius: 8,
  },
  buttonText: {
    color: "#ffffff",
    fontSize: 14,
    fontWeight: "500",
  },
});

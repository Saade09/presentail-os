/**
 * Custom app entry: installs a startup crash shield BEFORE the app loads.
 *
 * TestFlight builds were aborting ~160ms after launch with no visible error
 * (fatal JS exception -> ExceptionsManager.reportFatalException -> native
 * abort on the TurboModule queue). This shield intercepts fatal JS errors and
 * renders the error text on screen instead of letting the process die, so the
 * root cause is always readable on device.
 *
 * Marker for IPA verification: STARTUP_CRASH_SHIELD_V1
 */

/* eslint-disable @typescript-eslint/no-require-imports */

function formatError(error) {
  try {
    const name = (error && error.name) || "Error";
    const message = (error && error.message) || String(error);
    const stack = (error && error.stack) || "";
    return (name + ": " + message + "\n\n" + stack).slice(0, 4000);
  } catch (_e) {
    return "Unknown startup error (STARTUP_CRASH_SHIELD_V1)";
  }
}

function showFatalErrorScreen(error) {
  const details = formatError(error);
  try {
    const React = require("react");
    const { AppRegistry, ScrollView, Text, View } = require("react-native");

    function StartupCrashScreen() {
      return React.createElement(
        View,
        { style: { flex: 1, backgroundColor: "#115655", paddingTop: 80 } },
        React.createElement(
          ScrollView,
          { style: { flex: 1, paddingHorizontal: 20 } },
          React.createElement(
            Text,
            {
              style: {
                color: "#ffffff",
                fontSize: 20,
                fontWeight: "700",
                marginBottom: 12,
              },
            },
            "Something went wrong at startup"
          ),
          React.createElement(
            Text,
            {
              style: {
                color: "#d2e7e6",
                fontSize: 13,
                marginBottom: 16,
              },
            },
            "Please screenshot this screen and send it to support."
          ),
          React.createElement(
            Text,
            {
              style: {
                color: "#ffd7d7",
                fontSize: 12,
                fontFamily: "Courier",
                marginBottom: 60,
              },
              selectable: true,
            },
            details
          )
        )
      );
    }

    // Covers the case where the fatal error happened during bundle
    // evaluation, before the real app was registered: native will call
    // runApplication("main") and render this screen instead.
    AppRegistry.registerComponent("main", () => StartupCrashScreen);
  } catch (_e) {
    // ignore — Alert fallback below still fires
  }

  // Covers the case where the app already mounted: re-registering "main"
  // has no effect on a mounted root, but a native alert is always visible.
  try {
    const { Alert, Platform } = require("react-native");
    if (Platform.OS !== "web") {
      setTimeout(() => {
        try {
          Alert.alert("Startup error", details.slice(0, 1000));
        } catch (_e) {
          // ignore
        }
      }, 500);
    }
  } catch (_e) {
    // ignore
  }

  try {
    // eslint-disable-next-line no-console
    console.error("[STARTUP_CRASH_SHIELD_V1] Fatal startup error:", details);
  } catch (_e) {
    // ignore
  }
}

(function installStartupCrashShield() {
  try {
    const ErrorUtils = globalThis.ErrorUtils;
    if (!ErrorUtils || typeof ErrorUtils.setGlobalHandler !== "function") {
      return; // web / non-RN environment
    }
    const previousHandler =
      typeof ErrorUtils.getGlobalHandler === "function"
        ? ErrorUtils.getGlobalHandler()
        : null;
    ErrorUtils.setGlobalHandler(function (error, isFatal) {
      if (!isFatal) {
        if (previousHandler) previousHandler(error, isFatal);
        return;
      }
      // Fatal: swallow the default path (which aborts the process natively)
      // and surface the error on screen instead.
      showFatalErrorScreen(error);
    });
  } catch (_e) {
    // never let the shield itself break startup
  }
})();

try {
  require("expo-router/entry");
} catch (error) {
  showFatalErrorScreen(error);
}

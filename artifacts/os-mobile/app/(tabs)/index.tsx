import * as WebBrowser from "expo-web-browser";
import React, { useCallback, useEffect, useRef, useState } from "react";
import { ActivityIndicator, Platform, Pressable, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { useColors } from "@/hooks/useColors";
import { useAuth } from "@/contexts/AuthContext";
import {
  DashboardHandoffAttempts,
  isDashboardCompletionUrl,
  isDashboardReadyMessage,
  isTopFrameNavigation,
} from "@/lib/dashboardHandoffAttempts";

// Present as Safari on iPhone so Google OAuth accepts the user agent.
// WKWebView is blocked by Google ("disallowed_useragent") — Safari UA is not.
const SAFARI_UA =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_6 like Mac OS X) " +
  "AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.6 Mobile/15E148 Safari/604.1";

// Inject a mobile-friendly viewport so pages don't render at desktop scale.
const VIEWPORT_JS = `
(function() {
  var meta = document.querySelector('meta[name="viewport"]');
  if (!meta) {
    meta = document.createElement('meta');
    meta.name = 'viewport';
    document.head.appendChild(meta);
  }
  meta.content = 'width=device-width, initial-scale=1.0, user-scalable=yes, minimum-scale=0.5, maximum-scale=4.0';
})();
true;
`;
const WEBVIEW_LOAD_TIMEOUT_MS = 20_000;

// The Clerk → Google OAuth chain MUST run entirely inside the WebView.
// If it is handed off to SFSafariViewController (or a Custom Tab), the
// resulting Clerk session cookie is created in the external browser's
// isolated cookie store, which WKWebView can never read — the user completes
// Google sign-in in the sheet, lands on the signed-in dashboard *there*, and
// returns to the app still signed out. The WebView already presents a Safari
// user agent (SAFARI_UA above) precisely so Google accepts it.
//
// The chain includes first-party Clerk hops on other presentail.com
// subdomains (production Clerk FAPI/proxy is clerk.presentail.com, and the
// post-Google redirect lands on .../v1/oauth_callback there), so ALL
// presentail.com subdomains must stay in the WebView — otherwise the
// callback hop opens in a Safari sheet and finishes sign-in in its isolated
// cookie jar (blank os.presentail.com sheet, app still signed out).
//
// Everything outside presentail.com + the Google/Clerk auth domains still
// opens externally; after that browser closes we reload the WebView.
const WEBVIEW_ALLOWED_HOSTS = new Set([
  "presentail.com",
  "accounts.google.com",
  "accounts.youtube.com",
  // Replit-managed Clerk routes the post-Google OAuth callback through this
  // shared gateway before landing back on os.presentail.com. Seen live in
  // TestFlight: Google "Continue" → clerk-shared-gateway.replit.com →
  // os.presentail.com. If this hop escapes to the Safari sheet the session
  // strands there.
  "clerk-shared-gateway.replit.com",
]);
const WEBVIEW_ALLOWED_HOST_SUFFIXES = [
  ".presentail.com",
  ".google.com",
  ".gstatic.com",
  ".googleusercontent.com",
  ".googleapis.com",
  // Clerk auth-chain hosts: shared-gateway subdomains (Replit-managed Clerk),
  // Clerk-hosted FAPI/account domains, dev-instance FAPI.
  ".clerk-shared-gateway.replit.com",
  ".clerk.com",
  ".clerk.accounts.dev",
];

function isAllowedInWebView(url: string): boolean {
  try {
    const parsed = new URL(url);
    // Allow inline/system content through.
    if (
      parsed.protocol === "data:" ||
      parsed.protocol === "blob:" ||
      parsed.protocol === "about:"
    ) {
      return true;
    }
    const host = parsed.hostname.toLowerCase();
    if (WEBVIEW_ALLOWED_HOSTS.has(host)) return true;
    return WEBVIEW_ALLOWED_HOST_SUFFIXES.some((suffix) => host.endsWith(suffix));
  } catch {
    // Non-standard loads (about:blank etc.) stay in the WebView.
    return true;
  }
}

export default function DashboardScreen() {
  const colors = useColors();
  const { getDashboardBootstrapUrl } = useAuth();
  const [loading, setLoading] = useState(true);
  const [bootstrapUrl, setBootstrapUrl] = useState<string | null>(null);
  const [handoffError, setHandoffError] = useState<string | null>(null);
  const [attemptId, setAttemptId] = useState(0);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const webRef = useRef<any>(null);
  const attemptsRef = useRef(new DashboardHandoffAttempts());
  const requestAbortRef = useRef<AbortController | null>(null);
  const currentNavigationUrlRef = useRef<string | null>(null);

  const clearLoadTimeout = useCallback(() => {
    attemptsRef.current.clearTimeout();
  }, []);

  const failAttempt = useCallback((id: number, message: string) => {
    if (!attemptsRef.current.isCurrent(id)) return;
    clearLoadTimeout();
    setBootstrapUrl(null);
    setHandoffError(message);
    setLoading(false);
  }, [clearLoadTimeout]);

  const bootstrapDashboard = useCallback(async () => {
    const id = attemptsRef.current.begin();
    requestAbortRef.current?.abort();
    const controller = new AbortController();
    requestAbortRef.current = controller;
    setAttemptId(id);
    setLoading(true);
    setHandoffError(null);
    setBootstrapUrl(null);
    try {
      const url = await getDashboardBootstrapUrl(controller.signal);
      if (!attemptsRef.current.isCurrent(id)) return;
      requestAbortRef.current = null;
      currentNavigationUrlRef.current = url;
      attemptsRef.current.scheduleTimeout(id, WEBVIEW_LOAD_TIMEOUT_MS, () => {
        webRef.current?.stopLoading?.();
        failAttempt(id, "The dashboard took too long to load. Please try again.");
      });
      setBootstrapUrl(url);
    } catch (error) {
      if (!attemptsRef.current.isCurrent(id)) return;
      requestAbortRef.current = null;
      failAttempt(
        id,
        error instanceof Error ? error.message : "Unable to open the dashboard right now",
      );
    }
  }, [clearLoadTimeout, failAttempt, getDashboardBootstrapUrl]);

  useEffect(() => {
    void bootstrapDashboard();
    return () => {
      requestAbortRef.current?.abort();
      requestAbortRef.current = null;
      attemptsRef.current.dispose();
    };
  }, [bootstrapDashboard, clearLoadTimeout]);

  // Must be declared unconditionally (Rules of Hooks) — used only on native.
  const openExternal = useCallback((url: string) => {
    WebBrowser.openBrowserAsync(url, {
      dismissButtonStyle: "done",
      presentationStyle: WebBrowser.WebBrowserPresentationStyle.FULL_SCREEN,
    }).then(() => {
      // Reload so Clerk picks up the new session after OAuth completes.
      webRef.current?.reload();
    });
  }, []);

  const handleNavRequest = useCallback(
    (request: { url: string; isTopFrame?: boolean }): boolean => {
      try {
        const parsed = new URL(request.url);
        if (parsed.searchParams.get("mobile_handoff_error") === "1") {
          failAttempt(attemptId, "The secure dashboard sign-in could not be completed.");
          return false;
        }
      } catch {
        // Let the existing host policy handle malformed or system URLs.
      }
      if (!isAllowedInWebView(request.url)) {
        openExternal(request.url);
        return false; // Block navigation inside WebView
      }
      if (isTopFrameNavigation(request)) {
        currentNavigationUrlRef.current = request.url;
      }
      return true;
    },
    [attemptId, failAttempt, openExternal],
  );

  const handleLoadStart = useCallback(() => {
    if (!attemptsRef.current.isCurrent(attemptId)) return;
    setLoading(true);
  }, [attemptId]);

  const handleLoadEnd = useCallback(
    (event: { nativeEvent: { url: string } }) => {
      if (!attemptsRef.current.isCurrent(attemptId) || !bootstrapUrl) return;
      if (!isDashboardCompletionUrl(event.nativeEvent.url, bootstrapUrl)) return;
      clearLoadTimeout();
      setLoading(false);
    },
    [attemptId, bootstrapUrl, clearLoadTimeout],
  );

  const handleDashboardMessage = useCallback((event: { nativeEvent: { data: string } }) => {
    if (!attemptsRef.current.isCurrent(attemptId)) return;
    if (!isDashboardReadyMessage(event.nativeEvent.data)) return;
    clearLoadTimeout();
    setLoading(false);
  }, [attemptId, clearLoadTimeout]);

  // Catches window.open() calls that bypass onShouldStartLoadWithRequest.
  // Auth-chain URLs (Clerk → Google) must stay in the WebView's cookie jar,
  // so navigate the main frame there instead of opening an external browser.
  const handleOpenWindow = useCallback(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (event: any) => {
      const url: string | undefined =
        event?.targetUrl ?? event?.nativeEvent?.targetUrl;
      if (!url) return;
      if (isAllowedInWebView(url)) {
        currentNavigationUrlRef.current = url;
        webRef.current?.injectJavaScript(
          `window.location.href = ${JSON.stringify(url)}; true;`,
        );
      } else {
        openExternal(url);
      }
    },
    [openExternal],
  );

  if (Platform.OS === "web") {
    return null;
  }

  if (!bootstrapUrl) {
    return (
      <SafeAreaView
        style={[styles.handoffState, { backgroundColor: colors.background }]}
        edges={["top", "bottom"]}
      >
        {handoffError ? (
          <>
            <Text style={[styles.errorTitle, { color: colors.foreground }]}>
              Dashboard unavailable
            </Text>
            <Text style={[styles.errorText, { color: colors.mutedForeground }]}>
              {handoffError}
            </Text>
            <Pressable
              testID="dashboard-handoff-retry"
              accessibilityRole="button"
              onPress={() => void bootstrapDashboard()}
              style={[styles.retryButton, { backgroundColor: colors.primary }]}
            >
              <Text style={[styles.retryText, { color: colors.primaryForeground }]}>
                Try again
              </Text>
            </Pressable>
          </>
        ) : (
          <ActivityIndicator size="large" color={colors.primary} />
        )}
      </SafeAreaView>
    );
  }

  // Lazy-require so the web bundler never tries to bundle react-native-webview
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { WebView } = require("react-native-webview") as typeof import("react-native-webview");

  return (
    <View style={[styles.container, { backgroundColor: colors.background }]}>
      <SafeAreaView style={styles.safeArea} edges={["top"]}>
        {/* eslint-disable-next-line @typescript-eslint/no-explicit-any */}
        <WebView
          key={attemptId}
          ref={webRef}
          source={{ uri: bootstrapUrl }}
          style={styles.webview}
          onLoadStart={handleLoadStart}
          onLoadEnd={handleLoadEnd}
          onMessage={handleDashboardMessage}
          onError={() =>
            failAttempt(attemptId, "The dashboard could not be loaded. Check your connection and try again.")
          }
          onHttpError={(event) =>
            event.nativeEvent.url === currentNavigationUrlRef.current
              ? failAttempt(
                  attemptId,
                  `The dashboard returned an error (${event.nativeEvent.statusCode}). Please try again.`,
                )
              : undefined
          }
          javaScriptEnabled
          domStorageEnabled
          sharedCookiesEnabled
          thirdPartyCookiesEnabled
          allowsInlineMediaPlayback
          allowsBackForwardNavigationGestures
          pullToRefreshEnabled
          decelerationRate="normal"
          contentInsetAdjustmentBehavior="automatic"
          // Present as Safari so Google OAuth doesn't block the request
          userAgent={SAFARI_UA}
          // Inject mobile viewport on every page load
          injectedJavaScript={VIEWPORT_JS}
          injectedJavaScriptBeforeContentLoaded={VIEWPORT_JS}
          // Keep the OAuth chain in the WebView; everything else external
          onShouldStartLoadWithRequest={handleNavRequest}
          // Intercept window.open() calls (e.g. Clerk OAuth popup)
          onOpenWindow={handleOpenWindow}
          // Force window.open to navigate the same frame on Android so the
          // OAuth chain stays in this WebView's cookie jar.
          setSupportMultipleWindows={false}
          // Allow pinch-to-zoom so users can drill into dense tables
          scalesPageToFit={Platform.OS === "android"}
        />
        {loading && (
          <View
            style={[
              styles.loadingOverlay,
              { backgroundColor: colors.background },
            ]}
          >
            <ActivityIndicator size="large" color={colors.primary} />
          </View>
        )}
      </SafeAreaView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  safeArea: {
    flex: 1,
  },
  webview: {
    flex: 1,
  },
  loadingOverlay: {
    ...StyleSheet.absoluteFillObject,
    alignItems: "center",
    justifyContent: "center",
  },
  handoffState: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 32,
  },
  errorTitle: {
    fontSize: 22,
    fontWeight: "700",
    marginBottom: 8,
    textAlign: "center",
  },
  errorText: {
    fontSize: 15,
    lineHeight: 22,
    marginBottom: 20,
    textAlign: "center",
  },
  retryButton: {
    borderRadius: 10,
    paddingHorizontal: 24,
    paddingVertical: 12,
  },
  retryText: {
    fontSize: 16,
    fontWeight: "600",
  },
});

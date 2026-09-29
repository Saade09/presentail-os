import { useRouter } from "expo-router";
import React, { useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
  useColorScheme,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import Constants from "expo-constants";
import * as Crypto from "expo-crypto";
import * as AppleAuthentication from "expo-apple-authentication";

import { AnimatedPressButton } from "@/components/AnimatedPressButton";
import { useColors } from "@/hooks/useColors";
import { useAuth } from "@/contexts/AuthContext";

type EmailMode = "idle" | "otp" | "password";

// Read from app.config.js extra (baked at EAS build time) — more reliable than
// process.env.EXPO_PUBLIC_* which depends on Metro inline-replacement timing.
const IOS_CLIENT_ID =
  (Constants.expoConfig?.extra?.googleIosClientId as string | undefined) ||
  process.env.EXPO_PUBLIC_GOOGLE_CLIENT_ID_IOS;
const WEB_CLIENT_ID =
  (Constants.expoConfig?.extra?.googleWebClientId as string | undefined) ||
  process.env.EXPO_PUBLIC_GOOGLE_CLIENT_ID_WEB;
const GOOGLE_ENABLED = !!(IOS_CLIENT_ID || WEB_CLIENT_ID);
const IS_NATIVE = Platform.OS !== "web";
const IS_IOS = Platform.OS === "ios";
// On iOS we need the iOS client ID; on Android the web client ID is sufficient.
const NATIVE_GOOGLE_MISCONFIGURED =
  IS_NATIVE &&
  GOOGLE_ENABLED &&
  (Platform.OS === "ios" ? !IOS_CLIENT_ID : !WEB_CLIENT_ID);

// Lazily require the native Google Sign-In SDK — it is only available on native
// builds and the import will be ignored by the web bundler.
function getNativeGoogleSignin() {
  if (!IS_NATIVE) return null;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return require("@react-native-google-signin/google-signin") as typeof import("@react-native-google-signin/google-signin");
  } catch {
    return null;
  }
}

export default function SignInScreen() {
  const colors = useColors();
  const colorScheme = useColorScheme();
  const isDark = colorScheme === "dark";
  const router = useRouter();
  const { signIn, signInWithGoogle, requestAppleChallenge, signInWithApple, completeAppleLink, requestOtp, verifyOtp } = useAuth();

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [otp, setOtp] = useState("");
  const [emailMode, setEmailMode] = useState<EmailMode>("idle");

  const [googleLoading, setGoogleLoading] = useState(false);
  const [appleLoading, setAppleLoading] = useState(false);
  const [appleLinkToken, setAppleLinkToken] = useState<string | null>(null);
  const [appleLinkCodeSent, setAppleLinkCodeSent] = useState(false);
  const [otpLoading, setOtpLoading] = useState(false);
  const [passwordLoading, setPasswordLoading] = useState(false);

  const [googleError, setGoogleError] = useState<string | null>(null);
  const [appleError, setAppleError] = useState<string | null>(null);
  const [otpError, setOtpError] = useState<string | null>(null);
  const [passwordError, setPasswordError] = useState<string | null>(null);

  const otpInputRef = useRef<TextInput>(null);
  const passwordInputRef = useRef<TextInput>(null);

  // Configure native Google Sign-In once on mount (iOS + Android).
  useEffect(() => {
    if (!IS_NATIVE || !GOOGLE_ENABLED) return;
    const native = getNativeGoogleSignin();
    if (!native) return;
    if (__DEV__) {
      console.log(
        `[SignIn] Configuring native GoogleSignin — webClientId: ${WEB_CLIENT_ID ? "(set)" : "(missing)"}, iosClientId: ${IOS_CLIENT_ID ? "(set)" : "(missing)"}`,
      );
    }
    try {
      native.GoogleSignin.configure({
        webClientId: WEB_CLIENT_ID,
        iosClientId: IOS_CLIENT_ID,
      });
    } catch (configErr: unknown) {
      // A native initialisation failure here must not crash the app — the user
      // can still sign in via OTP or password. We surface a visible message.
      const msg = configErr instanceof Error ? configErr.message : "Google Sign-In configuration failed";
      console.error("[SignIn] GoogleSignin.configure() threw:", msg);
      setGoogleError("Google sign in is unavailable on this device");
    }
  }, []);

  // No expo-auth-session Google hook — native iOS uses @react-native-google-signin only.

  // ── Google button handler ────────────────────────────────────────────────
  const handleGooglePress = async () => {
    setGoogleError(null);
    setGoogleLoading(true);

    if (IS_NATIVE) {
      // Native path — uses native iOS account picker, never opens an in-app browser
      if (__DEV__) console.log("[SignIn] handleGooglePress — native path");
      const native = getNativeGoogleSignin();
      if (!native) {
        setGoogleError("Google sign in is not available on this device");
        setGoogleLoading(false);
        return;
      }
      try {
        await native.GoogleSignin.hasPlayServices({ showPlayServicesUpdateDialog: true });

        // v14: signIn() returns a discriminated union — must check type first
        const signInResult = await native.GoogleSignin.signIn();
        if (__DEV__) {
          console.log(
            `[SignIn] GoogleSignin.signIn() type: ${signInResult.type}` +
            `, data.idToken: ${signInResult.data?.idToken ? "(set)" : "(null)"}`,
          );
        }
        if (signInResult.type !== "success") {
          if (__DEV__) console.log(`[SignIn] signIn() type="${signInResult.type}" — aborting quietly`);
          setGoogleLoading(false);
          return;
        }

        // v14: getTokens() returns both idToken and accessToken after a confirmed signIn
        const tokens = await native.GoogleSignin.getTokens();
        const { idToken, accessToken } = tokens;
        if (__DEV__) {
          console.log(
            `[SignIn] getTokens() — idToken: ${idToken ? `${idToken.length} chars` : "(null)"}` +
            `, accessToken: ${accessToken ? `${accessToken.length} chars` : "(null)"}`,
          );
        }

        // Use accessToken: production backend verifies via Google's userinfo endpoint.
        // idToken path requires a backend deployment with updated schema.
        if (!accessToken) {
          setGoogleError(
            "Google sign in returned no access token.\n" +
            `getTokens() — idToken: ${idToken ? `${idToken.length} chars` : "(null)"}, accessToken: (null).`,
          );
          setGoogleLoading(false);
          return;
        }

        // Send accessToken to backend
        try {
          await signInWithGoogle(accessToken, "accessToken");
          router.replace("/(tabs)");
        } catch (backendErr: unknown) {
          const backendMsg = backendErr instanceof Error ? backendErr.message : "Backend error";
          if (__DEV__) {
            console.log("[SignIn] Google backend error:", {
              message: backendMsg,
              idTokenPresent: !!idToken,
              accessTokenPresent: !!accessToken,
            });
          }
          // Strip the "[HTTP NNN] " prefix from callAuthEndpoint for a clean display
          const displayMsg = backendMsg.replace(/^\[HTTP \d+\] /, "");
          setGoogleError(displayMsg || "Google sign in failed — please try again");
          setGoogleLoading(false);
        }
      } catch (err: unknown) {
        const { statusCodes } = native;
        if (
          err !== null &&
          typeof err === "object" &&
          "code" in err &&
          (err as { code: string }).code === statusCodes.SIGN_IN_CANCELLED
        ) {
          // User cancelled — clear loading, no error message
          if (__DEV__) console.log("[SignIn] Google sign in cancelled by user");
        } else if (
          err !== null &&
          typeof err === "object" &&
          "code" in err &&
          (err as { code: string }).code === statusCodes.IN_PROGRESS
        ) {
          if (__DEV__) console.log("[SignIn] Google sign in already in progress");
        } else {
          const msg = err instanceof Error ? err.message : "Google sign in failed";
          setGoogleError(msg);
          if (__DEV__) console.log(`[SignIn] Google sign in error: ${msg}`);
        }
        setGoogleLoading(false);
      }
    } else {
      // Web: @react-native-google-signin is native-only
      setGoogleError("Google sign in is not supported on web");
      setGoogleLoading(false);
    }
  };

  const handleSendCode = async () => {
    if (!email) return;
    setOtpError(null);
    setOtpLoading(true);
    if (__DEV__) console.log("[SignIn] handleSendCode — requesting OTP");
    try {
      await requestOtp(email.trim());
      setEmailMode("otp");
      setOtp("");
      setAppleLinkCodeSent(Boolean(appleLinkToken));
      setTimeout(() => otpInputRef.current?.focus(), 200);
    } catch (err: unknown) {
      setOtpError(err instanceof Error ? err.message : "Failed to send code");
    } finally {
      setOtpLoading(false);
    }
  };

  const handleApplePress = async () => {
    if (appleLoading) return;
    setAppleError(null);
    setAppleLoading(true);
    try {
      const available = await AppleAuthentication.isAvailableAsync();
      if (!available) {
        throw new Error(
          "Apple sign in is unavailable on this device. Update iOS and try again, or sign in with email.",
        );
      }
      const nonce = await requestAppleChallenge();
      const appleNonce = await Crypto.digestStringAsync(
        Crypto.CryptoDigestAlgorithm.SHA256,
        nonce,
      );
      const credential = await AppleAuthentication.signInAsync({
        requestedScopes: [
          AppleAuthentication.AppleAuthenticationScope.FULL_NAME,
          AppleAuthentication.AppleAuthenticationScope.EMAIL,
        ],
        nonce: appleNonce,
      });
      if (!credential.identityToken) throw new Error("Apple did not return an identity token");
      const result = await signInWithApple(credential.identityToken, nonce);
      if (result.requiresLink && result.linkToken) {
        setAppleLinkToken(result.linkToken);
        setAppleLinkCodeSent(false);
        setOtp("");
        setOtpError(null);
        setEmailMode("idle");
      } else {
        router.replace("/(tabs)");
      }
    } catch (err: unknown) {
      const code = err && typeof err === "object" && "code" in err ? String((err as { code: unknown }).code) : "";
      if (code !== "ERR_REQUEST_CANCELED") {
        setAppleError(err instanceof Error ? err.message : "Apple sign in failed");
      }
    } finally {
      setAppleLoading(false);
    }
  };

  const clearAppleLink = () => {
    setAppleLinkToken(null);
    setAppleLinkCodeSent(false);
    setOtp("");
    setOtpError(null);
  };

  const handleVerifyOtp = async () => {
    if (!email || otp.length !== 6) return;
    setOtpError(null);
    setOtpLoading(true);
    if (__DEV__) console.log("[SignIn] handleVerifyOtp — verifying code");
    try {
      if (appleLinkToken) {
        await completeAppleLink(appleLinkToken, email.trim(), otp.trim());
        clearAppleLink();
      } else {
        await verifyOtp(email.trim(), otp.trim());
      }
      router.replace("/(tabs)");
    } catch (err: unknown) {
      setOtpError(err instanceof Error ? err.message : "Invalid code");
    } finally {
      setOtpLoading(false);
    }
  };

  const handlePasswordSignIn = async () => {
    if (!email || !password) return;
    setPasswordError(null);
    setPasswordLoading(true);
    if (__DEV__) console.log("[SignIn] handlePasswordSignIn — signing in with password");
    try {
      await signIn(email.trim(), password);
      router.replace("/(tabs)");
    } catch (err: unknown) {
      setPasswordError(err instanceof Error ? err.message : "Sign in failed");
    } finally {
      setPasswordLoading(false);
    }
  };

  const switchToPassword = () => {
    clearAppleLink();
    setOtpError(null);
    setPasswordError(null);
    setEmailMode("password");
    setTimeout(() => passwordInputRef.current?.focus(), 200);
  };

  const switchToOtp = () => {
    clearAppleLink();
    setOtpError(null);
    setPasswordError(null);
    setEmailMode("otp");
    setTimeout(() => otpInputRef.current?.focus(), 200);
  };

  const inputBg = isDark ? colors.card : "#ffffff";
  const borderColor = colors.border;
  const loading = googleLoading || appleLoading || otpLoading || passwordLoading;
  return (
    <SafeAreaView style={[styles.safe, { backgroundColor: colors.background }]}>
      <KeyboardAvoidingView
        behavior={Platform.OS === "ios" ? "padding" : "height"}
        style={styles.flex}
      >
        <ScrollView
          contentContainerStyle={styles.scrollContent}
          keyboardShouldPersistTaps="handled"
        >
          {/* Header */}
          <View style={styles.header}>
            <Text style={[styles.appName, { color: colors.primary, fontFamily: "Inter_600SemiBold" }]}>
              Presentail OS
            </Text>
            <Text style={[styles.title, { color: colors.foreground, fontFamily: "Inter_700Bold" }]}>
              Welcome back
            </Text>
            <Text style={[styles.subtitle, { color: colors.mutedForeground, fontFamily: "Inter_400Regular" }]}>
              Sign in to your workspace
            </Text>
          </View>

          {/* ── Google ── */}
          {GOOGLE_ENABLED && (
            <>
              {NATIVE_GOOGLE_MISCONFIGURED ? (
                <View
                  style={[
                    styles.googleButton,
                    styles.googleMisconfigured,
                    { borderColor: colors.destructive, backgroundColor: inputBg },
                  ]}
                >
                  <Text style={[styles.googleMisconfiguredText, { color: colors.destructive, fontFamily: "Inter_500Medium" }]}>
                    Google sign in is not configured for this device
                  </Text>
                </View>
              ) : (
                <>
                  <AnimatedPressButton
                    style={[styles.googleButton, { borderColor, backgroundColor: inputBg }]}
                    onPress={handleGooglePress}
                    disabled={loading}
                  >
                    {googleLoading ? (
                      <ActivityIndicator color={colors.foreground} />
                    ) : (
                      <View style={styles.googleButtonInner}>
                        <Text style={styles.googleLogo}>G</Text>
                        <Text style={[styles.googleButtonText, { color: colors.foreground, fontFamily: "Inter_600SemiBold" }]}>
                          Continue with Google
                        </Text>
                      </View>
                    )}
                  </AnimatedPressButton>
                  {googleError && (
                    <Text style={[styles.error, { color: colors.destructive }]}>{googleError}</Text>
                  )}
                </>
              )}
            </>
          )}

          {IS_IOS && (
            <View style={styles.appleSection}>
              <View style={[styles.appleButtonFrame, loading && styles.buttonDisabled]}>
                <AppleAuthentication.AppleAuthenticationButton
                  testID="apple-sign-in-button"
                  accessibilityLabel="Continue with Apple"
                  buttonType={AppleAuthentication.AppleAuthenticationButtonType.CONTINUE}
                  buttonStyle={
                    isDark
                      ? AppleAuthentication.AppleAuthenticationButtonStyle.WHITE
                      : AppleAuthentication.AppleAuthenticationButtonStyle.BLACK
                  }
                  cornerRadius={10}
                  style={[styles.appleButton, appleLoading && styles.appleButtonLoading]}
                  onPress={handleApplePress}
                />
                {appleLoading && (
                  <View pointerEvents="none" style={styles.appleLoadingOverlay}>
                    <ActivityIndicator color={isDark ? "#000000" : "#ffffff"} />
                  </View>
                )}
              </View>
              {appleError && (
                <Text style={[styles.error, { color: colors.destructive }]}>{appleError}</Text>
              )}
            </View>
          )}

          {/* ── Divider ── */}
          <View style={styles.dividerRow}>
            <View style={[styles.dividerLine, { backgroundColor: borderColor }]} />
            <Text style={[styles.dividerText, { color: colors.mutedForeground, fontFamily: "Inter_400Regular" }]}>
              or sign in with email
            </Text>
            <View style={[styles.dividerLine, { backgroundColor: borderColor }]} />
          </View>

          {/* ── Email input (shared) ── */}
          <Text style={[styles.label, { color: colors.foreground, fontFamily: "Inter_500Medium" }]}>
            Email address
          </Text>
          {appleLinkToken && (
            <View
              testID="apple-link-step"
              style={[
                styles.appleLinkCard,
                { backgroundColor: isDark ? colors.card : "#f4f7ff", borderColor: colors.primary },
              ]}
            >
              <Text style={[styles.appleLinkTitle, { color: colors.foreground, fontFamily: "Inter_600SemiBold" }]}>
                Verify your invited Presentail email
              </Text>
              <Text style={[styles.appleLinkBody, { color: colors.mutedForeground, fontFamily: "Inter_400Regular" }]}>
                Apple used a private relay address. Enter the email from your Presentail invitation, tap
                {" "}Send me a code, then enter the six-digit code below. You will not need to repeat Apple authorization.
              </Text>
              {appleLinkCodeSent && (
                <Text style={[styles.appleLinkStatus, { color: colors.primary, fontFamily: "Inter_500Medium" }]}>
                  Verification code sent. Enter it below to finish linking.
                </Text>
              )}
              {otpError && (
                <Pressable
                  testID="apple-link-restart"
                  onPress={() => {
                    clearAppleLink();
                    void handleApplePress();
                  }}
                  disabled={loading}
                >
                  <Text style={[styles.switchLinkText, { color: colors.primary, fontFamily: "Inter_500Medium" }]}>
                    Start over with Apple
                  </Text>
                </Pressable>
              )}
              <Pressable
                testID="apple-link-cancel"
                onPress={() => {
                  clearAppleLink();
                  setEmailMode("idle");
                }}
                disabled={loading}
              >
                <Text style={[styles.switchLinkText, { color: colors.primary, fontFamily: "Inter_500Medium" }]}>
                  Use regular email sign-in instead
                </Text>
              </Pressable>
            </View>
          )}
          <TextInput
            testID="email-input"
            style={[styles.input, { backgroundColor: inputBg, borderColor, color: colors.foreground, fontFamily: "Inter_400Regular" }]}
            value={email}
            onChangeText={(t) => {
              setEmail(t);
              // Reset method choice if email changes after a code was sent
              if (emailMode === "otp") {
                setEmailMode("idle");
                if (appleLinkToken) setAppleLinkCodeSent(false);
              }
            }}
            placeholder="you@example.com"
            placeholderTextColor={colors.mutedForeground}
            autoCapitalize="none"
            keyboardType="email-address"
            autoComplete="email"
            textContentType="emailAddress"
          />

          {/* ── Sign in method buttons — shown upfront before mode is chosen ── */}
          {emailMode === "idle" && (
            <View style={styles.methodStack}>
              <AnimatedPressButton
                style={[
                  styles.methodButton,
                  { backgroundColor: colors.primary },
                  (!email || loading) && styles.buttonDisabled,
                ]}
                onPress={handleSendCode}
                disabled={!email || loading}
              >
                {otpLoading ? (
                  <ActivityIndicator color={colors.primaryForeground} />
                ) : (
                  <Text style={[styles.methodButtonText, { color: colors.primaryForeground, fontFamily: "Inter_600SemiBold" }]}>
                    Send me a code
                  </Text>
                )}
              </AnimatedPressButton>

              <AnimatedPressButton
                style={[
                  styles.methodButton,
                  styles.methodButtonOutline,
                  { borderColor: colors.primary, backgroundColor: inputBg },
                  (!email || loading) && styles.buttonDisabled,
                ]}
                onPress={switchToPassword}
                disabled={!email || loading}
              >
                <Text style={[styles.methodButtonText, { color: colors.primary, fontFamily: "Inter_600SemiBold" }]}>
                  Sign in with password
                </Text>
              </AnimatedPressButton>
            </View>
          )}

          {/* ── "Send me a code" button shown when already in OTP mode's pre-state ── */}
          {emailMode === "password" && (
            <View style={styles.methodStack}>
              <AnimatedPressButton
                style={[
                  styles.methodButton,
                  { backgroundColor: colors.primary },
                  (!email || loading) && styles.buttonDisabled,
                ]}
                onPress={handleSendCode}
                disabled={!email || loading}
              >
                {otpLoading ? (
                  <ActivityIndicator color={colors.primaryForeground} />
                ) : (
                  <Text style={[styles.methodButtonText, { color: colors.primaryForeground, fontFamily: "Inter_600SemiBold" }]}>
                    Send me a code
                  </Text>
                )}
              </AnimatedPressButton>
            </View>
          )}

          {/* ── OTP code entry ── */}
          {emailMode === "otp" && (
            <View style={styles.otpSection}>
              <View style={styles.otpHeader}>
                <Text style={[styles.otpHint, { color: colors.mutedForeground, fontFamily: "Inter_400Regular" }]}>
                  {appleLinkCodeSent ? "Code sent to" : "Enter code for"} {email}
                </Text>
                <Pressable onPress={handleSendCode} disabled={otpLoading}>
                  <Text style={[styles.resendText, { color: colors.primary, fontFamily: "Inter_500Medium" }]}>
                    Resend
                  </Text>
                </Pressable>
              </View>

              <TextInput
                ref={otpInputRef}
                testID="otp-input"
                style={[
                  styles.input,
                  styles.otpInput,
                  { backgroundColor: inputBg, borderColor, color: colors.foreground, fontFamily: "Inter_700Bold" },
                ]}
                value={otp}
                onChangeText={(t) => setOtp(t.replace(/\D/g, "").slice(0, 6))}
                placeholder="000000"
                placeholderTextColor={colors.mutedForeground}
                keyboardType="number-pad"
                maxLength={6}
              />

              {otpError && (
                <Text style={[styles.error, { color: colors.destructive }]}>{otpError}</Text>
              )}

              <AnimatedPressButton
                style={[
                  styles.primaryButton,
                  { backgroundColor: colors.primary },
                  (otp.length !== 6 || otpLoading) && styles.buttonDisabled,
                ]}
                onPress={handleVerifyOtp}
                disabled={otp.length !== 6 || otpLoading}
              >
                {otpLoading ? (
                  <ActivityIndicator color={colors.primaryForeground} />
                ) : (
                  <Text style={[styles.primaryButtonText, { color: colors.primaryForeground, fontFamily: "Inter_600SemiBold" }]}>
                    Verify code
                  </Text>
                )}
              </AnimatedPressButton>

              <Pressable style={styles.switchLink} onPress={switchToPassword}>
                <Text style={[styles.switchLinkText, { color: colors.primary, fontFamily: "Inter_500Medium" }]}>
                  Use password instead
                </Text>
              </Pressable>
            </View>
          )}

          {/* ── Password entry ── */}
          {emailMode === "password" && (
            <View style={styles.passwordSection}>
              <Text style={[styles.label, { color: colors.foreground, fontFamily: "Inter_500Medium" }]}>
                Password
              </Text>
              <TextInput
                ref={passwordInputRef}
                testID="password-input"
                style={[styles.input, { backgroundColor: inputBg, borderColor, color: colors.foreground, fontFamily: "Inter_400Regular" }]}
                value={password}
                onChangeText={setPassword}
                placeholder="Enter password"
                placeholderTextColor={colors.mutedForeground}
                secureTextEntry
                autoComplete="password"
                textContentType="password"
              />

              {passwordError && (
                <Text style={[styles.error, { color: colors.destructive }]}>{passwordError}</Text>
              )}

              <AnimatedPressButton
                style={[
                  styles.primaryButton,
                  { backgroundColor: colors.primary },
                  (!email || !password || passwordLoading) && styles.buttonDisabled,
                ]}
                onPress={handlePasswordSignIn}
                disabled={!email || !password || passwordLoading}
              >
                {passwordLoading ? (
                  <ActivityIndicator color={colors.primaryForeground} />
                ) : (
                  <Text style={[styles.primaryButtonText, { color: colors.primaryForeground, fontFamily: "Inter_600SemiBold" }]}>
                    Sign in
                  </Text>
                )}
              </AnimatedPressButton>

              <Pressable style={styles.switchLink} onPress={switchToOtp}>
                <Text style={[styles.switchLinkText, { color: colors.primary, fontFamily: "Inter_500Medium" }]}>
                  Send me a code instead
                </Text>
              </Pressable>
            </View>
          )}
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1 },
  flex: { flex: 1 },
  scrollContent: {
    flexGrow: 1,
    justifyContent: "center",
    paddingHorizontal: 24,
    paddingVertical: 40,
  },
  header: {
    marginBottom: 28,
    gap: 6,
  },
  appName: {
    fontSize: 14,
    letterSpacing: 0.5,
    marginBottom: 4,
  },
  title: {
    fontSize: 28,
    letterSpacing: -0.5,
  },
  subtitle: {
    fontSize: 15,
    lineHeight: 22,
  },
  googleButton: {
    height: 52,
    borderRadius: 10,
    borderWidth: 1,
    alignItems: "center",
    justifyContent: "center",
    marginBottom: 4,
  },
  googleMisconfigured: {
    paddingHorizontal: 16,
  },
  googleMisconfiguredText: {
    fontSize: 13,
    textAlign: "center",
  },
  googleButtonInner: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
  },
  googleLogo: {
    fontSize: 18,
    fontWeight: "700",
    color: "#4285F4",
  },
  googleButtonText: {
    fontSize: 15,
  },
  appleSection: {
    marginTop: 8,
    position: "relative",
  },
  appleButton: {
    height: 52,
    width: "100%",
  },
  appleButtonFrame: {
    height: 52,
    width: "100%",
    position: "relative",
  },
  appleButtonLoading: {
    opacity: 0.65,
  },
  appleLoadingOverlay: {
    ...StyleSheet.absoluteFillObject,
    alignItems: "center",
    justifyContent: "center",
  },
  appleLinkCard: {
    borderWidth: 1,
    borderRadius: 12,
    padding: 14,
    gap: 8,
    marginBottom: 12,
  },
  appleLinkTitle: {
    fontSize: 15,
  },
  appleLinkBody: {
    fontSize: 13,
    lineHeight: 19,
  },
  appleLinkStatus: {
    fontSize: 13,
    lineHeight: 19,
  },
  dividerRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    marginVertical: 20,
  },
  dividerLine: {
    flex: 1,
    height: 1,
  },
  dividerText: {
    fontSize: 13,
  },
  label: {
    fontSize: 14,
    marginBottom: 6,
  },
  input: {
    height: 48,
    borderRadius: 10,
    borderWidth: 1,
    paddingHorizontal: 14,
    fontSize: 15,
  },
  methodStack: {
    gap: 10,
    marginTop: 12,
  },
  methodButton: {
    height: 52,
    borderRadius: 10,
    alignItems: "center",
    justifyContent: "center",
  },
  methodButtonOutline: {
    borderWidth: 1.5,
  },
  methodButtonText: {
    fontSize: 15,
  },
  otpSection: {
    marginTop: 16,
    gap: 8,
  },
  otpHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: 4,
  },
  otpHint: {
    fontSize: 13,
  },
  resendText: {
    fontSize: 13,
  },
  otpInput: {
    fontSize: 28,
    letterSpacing: 12,
    textAlign: "center",
    height: 64,
  },
  passwordSection: {
    marginTop: 16,
    gap: 8,
  },
  primaryButton: {
    height: 48,
    borderRadius: 10,
    alignItems: "center",
    justifyContent: "center",
    marginTop: 8,
  },
  primaryButtonText: {
    fontSize: 15,
  },
  buttonDisabled: {
    opacity: 0.5,
  },
  error: {
    fontSize: 13,
    marginTop: 2,
  },
  switchLink: {
    alignSelf: "center",
    paddingVertical: 10,
  },
  switchLinkText: {
    fontSize: 14,
  },
});

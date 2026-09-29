import React, { createContext, useCallback, useContext, useEffect, useState } from "react";
import * as SecureStore from "expo-secure-store";
import { Platform } from "react-native";
import { requestDashboardBootstrap } from "@/lib/dashboardBootstrap";

const TOKEN_KEY = "mobile_auth_token";
const USER_KEY = "mobile_auth_user";

const PRODUCTION_DOMAIN = "os.presentail.com";

export interface MobileUser {
  id: string;
  email: string;
  firstName: string | null;
  lastName: string | null;
}

interface AuthContextValue {
  isSignedIn: boolean;
  isLoaded: boolean;
  token: string | null;
  user: MobileUser | null;
  signIn: (email: string, password: string) => Promise<void>;
  signInWithGoogle: (token: string, tokenType: "idToken" | "accessToken") => Promise<void>;
  requestAppleChallenge: () => Promise<string>;
  signInWithApple: (identityToken: string, nonce: string) => Promise<{ requiresLink: boolean; linkToken?: string }>;
  completeAppleLink: (linkToken: string, email: string, otp: string) => Promise<void>;
  requestOtp: (email: string) => Promise<void>;
  verifyOtp: (email: string, otp: string) => Promise<void>;
  signOut: () => Promise<void>;
  getDashboardBootstrapUrl: (signal?: AbortSignal) => Promise<string>;
}

const AuthContext = createContext<AuthContextValue>({
  isSignedIn: false,
  isLoaded: false,
  token: null,
  user: null,
  signIn: async () => {},
  signInWithGoogle: async (_token: string, _tokenType: "idToken" | "accessToken") => {},
  requestAppleChallenge: async () => "",
  signInWithApple: async () => ({ requiresLink: false }),
  completeAppleLink: async () => {},
  requestOtp: async () => {},
  verifyOtp: async () => {},
  signOut: async () => {},
  getDashboardBootstrapUrl: async () => "",
});

async function storeValue(key: string, value: string): Promise<void> {
  if (Platform.OS === "web") {
    try { localStorage.setItem(key, value); } catch {}
  } else {
    await SecureStore.setItemAsync(key, value);
  }
}

async function loadValue(key: string): Promise<string | null> {
  if (Platform.OS === "web") {
    try { return localStorage.getItem(key); } catch { return null; }
  }
  return SecureStore.getItemAsync(key);
}

async function deleteValue(key: string): Promise<void> {
  if (Platform.OS === "web") {
    try { localStorage.removeItem(key); } catch {}
  } else {
    await SecureStore.deleteItemAsync(key);
  }
}

function getApiBase(): string {
  const domain = process.env.EXPO_PUBLIC_DOMAIN;
  if (domain) return `https://${domain}`;
  if (__DEV__ && Platform.OS !== "web") {
    console.warn(
      "[Auth] EXPO_PUBLIC_DOMAIN is not set. Native API calls will fail. " +
      `Falling back to https://${PRODUCTION_DOMAIN} — set EXPO_PUBLIC_DOMAIN in eas.json.`,
    );
  }
  // On native builds without the env var, fall back to the known production domain
  // so the app is never silently broken — calls will reach the correct server.
  if (Platform.OS !== "web") return `https://${PRODUCTION_DOMAIN}`;
  return "";
}

async function callAuthEndpoint(
  path: string,
  body: Record<string, string>,
): Promise<{ token: string; user: MobileUser }> {
  const url = `${getApiBase()}${path}`;
  if (__DEV__) {
    console.log(
      `[Auth] POST ${url}\n  fields: ${Object.keys(body).join(", ")}\n  Content-Type: application/json`,
    );
  }
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify(body),
  });
  // Read raw text first so we always have it for diagnostics
  const rawText = await res.text().catch(() => "");
  let data: { error?: string; token?: string; user?: MobileUser } = {};
  try {
    data = JSON.parse(rawText) as typeof data;
  } catch {
    // non-JSON response
  }
  if (__DEV__) {
    console.log(
      `[Auth] ${res.ok ? "OK" : "FAIL"} HTTP ${res.status} — ${path}\n  response: ${rawText.slice(0, 300)}`,
    );
  }
  if (!res.ok) {
    // Include HTTP status in message so callers can surface it in diagnostic UI
    throw new Error(`[HTTP ${res.status}] ${(data.error ?? rawText.slice(0, 150)) || "Sign in failed"}`);
  }
  return data as { token: string; user: MobileUser };
}

async function callAppleEndpoint(
  path: string,
  body: Record<string, string>,
): Promise<{ token?: string; user?: MobileUser; requiresLink?: boolean; linkToken?: string }> {
  const res = await fetch(`${getApiBase()}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({})) as {
    error?: string; token?: string; user?: MobileUser; requiresLink?: boolean; linkToken?: string;
  };
  if (!res.ok && res.status !== 202) throw new Error(data.error ?? "Apple sign in failed");
  return data;
}

export function AuthProvider({
  children,
  onLoaded,
}: {
  children: React.ReactNode;
  onLoaded?: () => void;
}) {
  const [token, setToken] = useState<string | null>(null);
  const [user, setUser] = useState<MobileUser | null>(null);
  const [isLoaded, setIsLoaded] = useState(false);

  useEffect(() => {
    (async () => {
      if (__DEV__) console.log("[Auth] Restoring session from storage…");
      const [storedToken, storedUser] = await Promise.all([
        loadValue(TOKEN_KEY),
        loadValue(USER_KEY),
      ]);
      if (storedToken && storedUser) {
        setToken(storedToken);
        setUser(JSON.parse(storedUser) as MobileUser);
        if (__DEV__) console.log("[Auth] Session restored successfully.");
        // Background validation: if the stored token is expired or invalid,
        // sign out so the user lands on the native sign-in screen instead of hitting
        // authed screens with a dead session. Network failures are ignored —
        // only a definitive 401 clears the session.
        void (async () => {
          try {
            const res = await fetch(`${getApiBase()}/api/mobile/auth/me`, {
              headers: { Authorization: `Bearer ${storedToken}` },
            });
            // Only trust a 401 that carries the endpoint's marker header —
            // older servers 401 ALL unknown /api routes, and we must never
            // sign users out based on that ambiguous response.
            if (res.status === 401 && res.headers.get("x-mobile-auth") === "invalid") {
              if (__DEV__) console.log("[Auth] Stored token rejected (401) — signing out.");
              await Promise.all([deleteValue(TOKEN_KEY), deleteValue(USER_KEY)]);
              setToken(null);
              setUser(null);
            }
          } catch {
            // Offline or server unreachable — keep the session optimistically.
          }
        })();
      } else {
        if (__DEV__) console.log("[Auth] No stored session found.");
        // No native credential is stored, so the auth layout shows sign-in.
      }
      setIsLoaded(true);
      onLoaded?.();
    })();
  // onLoaded is intentionally excluded — it's a one-time startup callback and
  // we don't want to re-run if the caller re-renders and passes a new reference.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const persist = useCallback(async (data: { token: string; user: MobileUser }) => {
    if (__DEV__) console.log(`[Auth] Persisting session for user ${data.user.id}`);
    await Promise.all([
      storeValue(TOKEN_KEY, data.token),
      storeValue(USER_KEY, JSON.stringify(data.user)),
    ]);
    setToken(data.token);
    setUser(data.user);
  }, []);

  const signIn = useCallback(async (email: string, password: string) => {
    if (__DEV__) console.log("[Auth] signIn() — method: password");
    const data = await callAuthEndpoint("/api/mobile/auth/login", { email, password });
    await persist(data);
  }, [persist]);

  const signInWithGoogle = useCallback(async (token: string, tokenType: "idToken" | "accessToken") => {
    if (__DEV__) console.log(`[Auth] signInWithGoogle() — tokenType: ${tokenType}`);
    const body: Record<string, string> = tokenType === "idToken" ? { idToken: token } : { accessToken: token };
    const data = await callAuthEndpoint("/api/mobile/auth/google", body);
    await persist(data);
  }, [persist]);

  const requestAppleChallenge = useCallback(async () => {
    const data = await fetch(`${getApiBase()}/api/mobile/auth/apple/challenge`, {
      method: "POST",
      headers: { Accept: "application/json" },
    }).then(async (res) => {
      const body = await res.json().catch(() => ({})) as { nonce?: string; error?: string };
      if (!res.ok || !body.nonce) throw new Error(body.error ?? "Apple sign in is unavailable");
      return body;
    });
    return data.nonce!;
  }, []);

  const signInWithApple = useCallback(async (identityToken: string, nonce: string) => {
    const data = await callAppleEndpoint("/api/mobile/auth/apple", { identityToken, nonce });
    if (data.token && data.user) {
      await persist({ token: data.token, user: data.user });
      return { requiresLink: false };
    }
    return { requiresLink: data.requiresLink === true, linkToken: data.linkToken };
  }, [persist]);

  const completeAppleLink = useCallback(async (linkToken: string, email: string, otp: string) => {
    const data = await callAppleEndpoint("/api/mobile/auth/apple/link", { linkToken, email, otp });
    if (!data.token || !data.user) throw new Error("Apple account linking failed");
    await persist({ token: data.token, user: data.user });
  }, [persist]);

  const requestOtp = useCallback(async (email: string) => {
    const url = `${getApiBase()}/api/mobile/auth/otp/request`;
    if (__DEV__) console.log(`[Auth] requestOtp() — POST ${url}`);
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email }),
    });
    if (__DEV__) console.log(`[Auth] requestOtp() — status: ${res.status}`);
    if (!res.ok) {
      const data = await res.json().catch(() => ({})) as { error?: string };
      if (__DEV__) console.log(`[Auth] requestOtp() — error: ${data.error ?? "(none)"}`);
      throw new Error(data.error ?? "Failed to send code");
    }
  }, []);

  const verifyOtp = useCallback(async (email: string, otp: string) => {
    if (__DEV__) console.log("[Auth] verifyOtp() — verifying OTP code");
    const data = await callAuthEndpoint("/api/mobile/auth/otp/verify", { email, otp });
    await persist(data);
  }, [persist]);

  const signOut = useCallback(async () => {
    if (__DEV__) console.log("[Auth] signOut()");
    if (token) {
      try {
        await fetch(`${getApiBase()}/api/mobile/auth/logout`, {
          method: "POST",
          headers: { Authorization: `Bearer ${token}` },
        });
      } catch {
        // Logout is best-effort when offline; local credentials are always cleared.
      }
    }
    await Promise.all([deleteValue(TOKEN_KEY), deleteValue(USER_KEY)]);
    setToken(null);
    setUser(null);
  }, [token]);

  const getDashboardBootstrapUrl = useCallback(async (signal?: AbortSignal) => {
    if (!token) throw new Error("Your session has expired. Please sign in again.");
    return requestDashboardBootstrap({
      apiBase: getApiBase(),
      token,
      signal,
      onInvalidSession: async () => {
        await Promise.all([deleteValue(TOKEN_KEY), deleteValue(USER_KEY)]);
        setToken(null);
        setUser(null);
      },
    });
  }, [token]);

  const isSignedIn = !!token;

  return (
    <AuthContext.Provider
      value={{ isSignedIn, isLoaded, token, user, signIn, signInWithGoogle, requestAppleChallenge, signInWithApple, completeAppleLink, requestOtp, verifyOtp, signOut, getDashboardBootstrapUrl }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  return useContext(AuthContext);
}

import { useState, useEffect, useRef } from "react";
import { useSignIn } from "@clerk/react";
import { ArrowRight, ChevronLeft, KeyRound, Fingerprint, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
const basePath = import.meta.env.BASE_URL.replace(/\/$/, "");

type AuthMethod = "google" | "password" | "otp" | null;
type OtpStep = "email" | "code";
type PasswordStep = "credentials" | "code";

function clerkErrorMessage(e: unknown): string {
  if (e != null && typeof e === "object") {
    const asAny = e as Record<string, unknown>;
    if (typeof asAny.longMessage === "string") return asAny.longMessage;
    if (typeof asAny.message === "string") return asAny.message;
    const errors = asAny.errors;
    if (Array.isArray(errors) && errors.length > 0) {
      const first = errors[0] as Record<string, unknown>;
      return (
        (typeof first.longMessage === "string" ? first.longMessage : undefined) ??
        (typeof first.message === "string" ? first.message : undefined) ??
        "Something went wrong. Please try again."
      );
    }
  }
  if (e instanceof Error) return e.message;
  return "Something went wrong. Please try again.";
}

function GoogleIcon() {
  return (
    <svg viewBox="0 0 24 24" className="w-5 h-5" aria-hidden="true">
      <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" fill="#4285F4" />
      <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853" />
      <path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l3.66-2.84z" fill="#FBBC05" />
      <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335" />
    </svg>
  );
}

function LeftPanel() {
  return (
    <div
      className="hidden lg:flex flex-col justify-between p-10 relative overflow-hidden"
      style={{ background: "linear-gradient(145deg, hsl(192,77%,12%) 0%, hsl(192,77%,20%) 60%, hsl(185,70%,26%) 100%)" }}
    >
      <div className="relative z-10">
        <div className="flex items-center gap-3">
          <img src={`${basePath}/presentail-logo.png`} alt="Presentail OS logo" className="w-10 h-10 rounded-md object-cover" />
          <span className="text-white font-semibold text-lg tracking-tight">Presentail OS</span>
        </div>
      </div>

      <div className="relative z-10 space-y-4">
        <h2 className="text-white text-3xl font-bold leading-snug">
          Run Presentail operations from one place.
        </h2>
        <p className="text-white/70 text-sm leading-relaxed max-w-xs">
          One platform to manage products, orders, users, deliveries, approvals, and daily operations across Presentail.
        </p>
      </div>

      <div className="relative z-10 flex flex-wrap gap-4">
        {[
          { label: "Products", subtitle: "Catalog managed" },
          { label: "Orders", subtitle: "Tracked end to end" },
          { label: "Deliveries", subtitle: "Coordinated daily" },
        ].map((s) => (
          <div key={s.label} className="bg-white/10 backdrop-blur-sm rounded-xl px-4 py-3 min-w-[100px]">
            <div className="text-white font-bold text-base">{s.label}</div>
            <div className="text-white/60 text-xs mt-0.5">{s.subtitle}</div>
          </div>
        ))}
      </div>

      <div aria-hidden="true" className="absolute -top-24 -right-24 w-80 h-80 rounded-full opacity-10" style={{ background: "radial-gradient(circle, hsl(185,80%,60%) 0%, transparent 70%)" }} />
      <div aria-hidden="true" className="absolute bottom-20 -right-10 w-56 h-56 rounded-full opacity-10" style={{ background: "radial-gradient(circle, hsl(200,80%,70%) 0%, transparent 70%)" }} />
      <div aria-hidden="true" className="absolute top-1/2 -left-20 w-48 h-48 rounded-full opacity-10" style={{ background: "radial-gradient(circle, hsl(170,80%,60%) 0%, transparent 70%)" }} />
    </div>
  );
}

function MethodCard({
  icon,
  label,
  subtitle,
  onClick,
  disabled,
}: {
  icon: React.ReactNode;
  label: string;
  subtitle: string;
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="w-full flex items-center gap-4 p-4 rounded-xl border border-border bg-card hover:bg-secondary/50 hover:border-primary/30 transition-all text-left group disabled:opacity-40 disabled:cursor-not-allowed focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      <div className="flex-shrink-0 w-10 h-10 rounded-lg bg-secondary flex items-center justify-center text-primary group-hover:bg-primary/10 transition-colors">
        {icon}
      </div>
      <div className="flex-1 min-w-0">
        <div className="text-sm font-semibold text-foreground">{label}</div>
        <div className="text-xs text-muted-foreground mt-0.5">{subtitle}</div>
      </div>
      <ArrowRight size={16} className="text-muted-foreground group-hover:text-primary group-hover:translate-x-0.5 transition-all flex-shrink-0" />
    </button>
  );
}

function BackButton({ onClick }: { onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors"
    >
      <ChevronLeft size={16} />
      Back
    </button>
  );
}

function PasswordFlow({ onBack }: { onBack: () => void }) {
  const { signIn } = useSignIn();
  const [step, setStep] = useState<PasswordStep>("credentials");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [resendStatus, setResendStatus] = useState<"idle" | "sending" | "sent">("idle");
  const [resendCooldown, setResendCooldown] = useState(0);

  useEffect(() => {
    if (resendCooldown <= 0) return;
    const id = setInterval(() => {
      setResendCooldown((prev) => {
        if (prev <= 1) { clearInterval(id); return 0; }
        return prev - 1;
      });
    }, 1000);
    return () => clearInterval(id);
  }, [resendCooldown]);

  useEffect(() => {
    if (resendStatus !== "sent") return;
    const timer = setTimeout(() => setResendStatus("idle"), 5000);
    return () => clearTimeout(timer);
  }, [resendStatus]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!signIn) return;
    setLoading(true);
    setError(null);
    try {
      // Use the factor-specific password method (Clerk SignInFuture API).
      // signIn.create({ identifier, password }) is the legacy path and must
      // not be used here — it silently falls back to the wrong factor channel
      // on misconfigured instances. signIn.password() throws on bad credentials
      // so wrong passwords are caught by the catch block below.
      await signIn.password({ emailAddress: email, password });
      const status: string = signIn.status ?? "";
      if (status === "complete") {
        await signIn.finalize();
        window.location.href = `${basePath}/devices`;
        return;
      }
      // needs_second_factor: the user has genuine user-enabled MFA. Use the
      // dedicated MFA channel (signIn.mfa.*), never the passwordless
      // first-factor emailCode channel.
      if (status === "needs_second_factor") {
        const { error: sendError } = await signIn.mfa.sendEmailCode();
        if (sendError) {
          setError(clerkErrorMessage(sendError));
          return;
        }
        setStep("code");
        return;
      }
      // needs_client_trust: OS uses direct password login — client-trust OTPs
      // are not part of the intended flow. This status indicates a Clerk
      // instance configuration mismatch; surface a clear error rather than
      // silently emailing a code the user didn't ask for.
      if (status === "needs_client_trust") {
        setError(
          "Sign-in requires a device-verification step that is not supported in Presentail OS. Contact your administrator.",
        );
        return;
      }
      // needs_first_factor means the password did not satisfy the first factor
      // (password sign-in may be disabled in the Clerk instance configuration).
      // Surfacing a clear error prevents the confusing OTP-after-password loop.
      if (status === "needs_first_factor") {
        setError(
          "Password sign-in is not available for this account. Please use the one-time code option instead.",
        );
        return;
      }
      setError("Sign-in could not be completed. Please try again, or use a one-time code instead.");
    } catch (e) {
      setError(clerkErrorMessage(e));
    } finally {
      setLoading(false);
    }
  };

  const handleCodeSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!signIn) return;
    setLoading(true);
    setError(null);
    try {
      // The code step in PasswordFlow is only reached via needs_second_factor
      // (genuine user-enabled MFA). Use the dedicated MFA channel — not the
      // passwordless first-factor emailCode channel.
      const { error: verifyError } = await signIn.mfa.verifyEmailCode({ code });
      if (verifyError) {
        setError(clerkErrorMessage(verifyError));
        return;
      }
      if (signIn.status === "complete") {
        await signIn.finalize();
        window.location.href = `${basePath}/devices`;
      } else {
        setError("Sign-in could not be completed. Please try again.");
      }
    } catch (e) {
      setError(clerkErrorMessage(e));
    } finally {
      setLoading(false);
    }
  };

  const handleResend = async () => {
    if (!signIn) return;
    setResendStatus("sending");
    setError(null);
    try {
      const { error: resendError } = await signIn.mfa.sendEmailCode();
      if (resendError) {
        setError(clerkErrorMessage(resendError));
        setResendStatus("idle");
        return;
      }
      setResendStatus("sent");
      setResendCooldown(RESEND_COOLDOWN_SECONDS);
    } catch (e) {
      setError(clerkErrorMessage(e));
      setResendStatus("idle");
    }
  };

  if (step === "code") {
    return (
      <form onSubmit={handleCodeSubmit} className="space-y-4">
        <BackButton onClick={() => { setStep("credentials"); setCode(""); setError(null); setResendStatus("idle"); setResendCooldown(0); }} />
        <div>
          <h3 className="font-semibold text-foreground">Verify it's you</h3>
          <p className="text-sm text-muted-foreground mt-1">
            We sent a 6-digit code to <span className="font-medium text-foreground">{email}</span>.
          </p>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="pw-code">One-time code</Label>
          <Input
            id="pw-code"
            type="text"
            inputMode="numeric"
            autoComplete="one-time-code"
            placeholder="000000"
            maxLength={6}
            value={code}
            onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))}
            required
            autoFocus
            className="text-center tracking-widest text-lg font-mono"
          />
        </div>
        {error && (
          <p className="text-sm text-destructive bg-destructive/10 rounded-lg px-3 py-2" role="alert">{error}</p>
        )}
        <Button type="submit" disabled={loading || !signIn || code.length !== 6} className="w-full" size="lg">
          {loading ? <><Loader2 size={16} className="mr-2 animate-spin" />Verifying…</> : "Verify & sign in"}
        </Button>
        <div className="text-center space-y-1">
          {resendStatus === "sent" && (
            <p className="text-sm text-muted-foreground">Code resent — check your inbox.</p>
          )}
          <button
            type="button"
            disabled={resendStatus === "sending" || resendCooldown > 0 || !signIn}
            onClick={handleResend}
            className="text-sm text-muted-foreground underline underline-offset-2 hover:text-foreground disabled:opacity-50 disabled:cursor-not-allowed disabled:no-underline transition-colors tabular-nums"
          >
            {resendStatus === "sending"
              ? "Resending…"
              : resendCooldown > 0
                ? `Resend in ${resendCooldown}s`
                : "Resend code"}
          </button>
        </div>
      </form>
    );
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <BackButton onClick={onBack} />
      <div>
        <h3 className="font-semibold text-foreground">Sign in with email & password</h3>
        <p className="text-sm text-muted-foreground mt-1">Enter your credentials below.</p>
      </div>
      <div className="space-y-3">
        <div className="space-y-1.5">
          <Label htmlFor="pw-email">Email address</Label>
          <Input
            id="pw-email"
            type="email"
            autoComplete="email"
            placeholder="you@example.com"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
            autoFocus
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="pw-password">Password</Label>
          <Input
            id="pw-password"
            type="password"
            autoComplete="current-password"
            placeholder="••••••••"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
          />
        </div>
      </div>
      {error && (
        <p className="text-sm text-destructive bg-destructive/10 rounded-lg px-3 py-2" role="alert">{error}</p>
      )}
      <Button type="submit" disabled={loading || !signIn || !email || !password} className="w-full" size="lg">
        {loading ? <><Loader2 size={16} className="mr-2 animate-spin" />Signing in…</> : "Sign in"}
      </Button>
    </form>
  );
}

const RESEND_COOLDOWN_SECONDS = 30;

function OtpFlow({ onBack }: { onBack: () => void }) {
  const { signIn } = useSignIn();
  const [step, setStep] = useState<OtpStep>("email");
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [resendStatus, setResendStatus] = useState<"idle" | "sending" | "sent">("idle");
  const [resendCooldown, setResendCooldown] = useState(0);

  useEffect(() => {
    if (resendCooldown <= 0) return;
    const id = setInterval(() => {
      setResendCooldown((prev) => {
        if (prev <= 1) {
          clearInterval(id);
          return 0;
        }
        return prev - 1;
      });
    }, 1000);
    return () => clearInterval(id);
  }, [resendCooldown]);

  useEffect(() => {
    if (resendStatus !== "sent") return;
    const timer = setTimeout(() => setResendStatus("idle"), 5000);
    return () => clearTimeout(timer);
  }, [resendStatus]);

  const handleEmailSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!signIn) return;
    setLoading(true);
    setError(null);
    try {
      const { error: createError } = await signIn.create({ identifier: email });
      if (createError) {
        setError(clerkErrorMessage(createError));
        return;
      }
      const { error: sendError } = await signIn.emailCode.sendCode();
      if (sendError) {
        setError(clerkErrorMessage(sendError));
        return;
      }
      setStep("code");
    } catch (e) {
      setError(clerkErrorMessage(e));
    } finally {
      setLoading(false);
    }
  };

  const handleCodeSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!signIn) return;
    setLoading(true);
    setError(null);
    try {
      const { error: verifyError } = await signIn.emailCode.verifyCode({ code });
      if (verifyError) {
        setError(clerkErrorMessage(verifyError));
        return;
      }
      if (signIn.status === "complete") {
        await signIn.finalize();
        window.location.href = `${basePath}/devices`;
      } else {
        setError("Sign-in could not be completed. Please try again.");
      }
    } catch (e) {
      setError(clerkErrorMessage(e));
    } finally {
      setLoading(false);
    }
  };

  const handleResend = async () => {
    if (!signIn) return;
    setResendStatus("sending");
    setError(null);
    try {
      const { error: resendError } = await signIn.emailCode.sendCode();
      if (resendError) {
        setError(clerkErrorMessage(resendError));
        setResendStatus("idle");
        return;
      }
      setResendStatus("sent");
      setResendCooldown(RESEND_COOLDOWN_SECONDS);
    } catch (e) {
      setError(clerkErrorMessage(e));
      setResendStatus("idle");
    }
  };

  if (step === "code") {
    return (
      <form onSubmit={handleCodeSubmit} className="space-y-4">
        <BackButton onClick={() => { setStep("email"); setCode(""); setError(null); setResendStatus("idle"); setResendCooldown(0); }} />
        <div>
          <h3 className="font-semibold text-foreground">Check your email</h3>
          <p className="text-sm text-muted-foreground mt-1">
            We sent a 6-digit code to <span className="font-medium text-foreground">{email}</span>.
          </p>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="otp-code">One-time code</Label>
          <Input
            id="otp-code"
            type="text"
            inputMode="numeric"
            autoComplete="one-time-code"
            placeholder="000000"
            maxLength={6}
            value={code}
            onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))}
            required
            autoFocus
            className="text-center tracking-widest text-lg font-mono"
          />
        </div>
        {error && (
          <p className="text-sm text-destructive bg-destructive/10 rounded-lg px-3 py-2" role="alert">{error}</p>
        )}
        <Button type="submit" disabled={loading || !signIn || code.length !== 6} className="w-full" size="lg">
          {loading ? <><Loader2 size={16} className="mr-2 animate-spin" />Verifying…</> : "Verify & sign in"}
        </Button>
        <div className="text-center space-y-1">
          {resendStatus === "sent" && (
            <p className="text-sm text-muted-foreground">Code resent — check your inbox.</p>
          )}
          <button
            type="button"
            disabled={resendStatus === "sending" || resendCooldown > 0 || !signIn}
            onClick={handleResend}
            className="text-sm text-muted-foreground underline underline-offset-2 hover:text-foreground disabled:opacity-50 disabled:cursor-not-allowed disabled:no-underline transition-colors tabular-nums"
          >
            {resendStatus === "sending"
              ? "Resending…"
              : resendCooldown > 0
                ? `Resend in ${resendCooldown}s`
                : "Resend code"}
          </button>
        </div>
      </form>
    );
  }

  return (
    <form onSubmit={handleEmailSubmit} className="space-y-4">
      <BackButton onClick={onBack} />
      <div>
        <h3 className="font-semibold text-foreground">Sign in with a one-time code</h3>
        <p className="text-sm text-muted-foreground mt-1">Enter your email and we'll send you a code.</p>
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="otp-email">Email address</Label>
        <Input
          id="otp-email"
          type="email"
          autoComplete="email"
          placeholder="you@example.com"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          required
          autoFocus
        />
      </div>
      {error && (
        <p className="text-sm text-destructive bg-destructive/10 rounded-lg px-3 py-2" role="alert">{error}</p>
      )}
      <Button type="submit" disabled={loading || !signIn || !email} className="w-full" size="lg">
        {loading ? <><Loader2 size={16} className="mr-2 animate-spin" />Sending code…</> : "Send code"}
      </Button>
    </form>
  );
}

const GOOGLE_REDIRECT_TIMEOUT_MS = 15_000;
const MOBILE_TICKET_TIMEOUT_MS = 15_000;

export default function CustomSignIn() {
  const { signIn } = useSignIn();
  const [activeMethod, setActiveMethod] = useState<AuthMethod>(null);
  const [googleLoading, setGoogleLoading] = useState(false);
  const [googleError, setGoogleError] = useState<string | null>(null);
  const [ticketLoading, setTicketLoading] = useState(false);
  const [ticketError, setTicketError] = useState<string | null>(null);
  const ticketProcessed = useRef(false);
  const googleTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (ticketProcessed.current) return;
    const params = new URLSearchParams(window.location.search);
    const ticket = params.get("__clerk_ticket");
    const isMobileHandoff = params.get("mobile_handoff") === "1";
    if (!ticket || !signIn) return;

    ticketProcessed.current = true;
    setTicketLoading(true);
    let active = true;
    let mobileTicketTimeout: ReturnType<typeof setTimeout> | null = null;
    const returnMobileError = () => {
      if (!active) return;
      active = false;
      window.location.href = `${basePath}/sign-in?mobile_handoff_error=1`;
    };
    if (isMobileHandoff) {
      mobileTicketTimeout = setTimeout(returnMobileError, MOBILE_TICKET_TIMEOUT_MS);
    }

    function resolveTicketError(e: unknown): string {
      if (e != null && typeof e === "object") {
        const asAny = e as Record<string, unknown>;
        const errors = asAny.errors;
        if (Array.isArray(errors) && errors.length > 0) {
          const first = errors[0] as Record<string, unknown>;
          const code = typeof first.code === "string" ? first.code : "";
          if (code === "invitation_already_accepted" || code === "ticket_already_consumed") {
            return "__already_used__";
          }
        }
      }
      return "__expired__";
    }

    signIn
      .create({ strategy: "ticket", ticket })
      .then(async (result) => {
        const asAny = result as Record<string, unknown>;
        if (!active) return;
        if (asAny.error) {
          if (isMobileHandoff) {
            returnMobileError();
            return;
          }
          ticketProcessed.current = false;
          setTicketLoading(false);
          setTicketError(resolveTicketError(asAny.error));
          return;
        }
        if (signIn.status === "complete") {
          try {
            await signIn.finalize();
          } catch {
            if (!active) return;
            if (isMobileHandoff) {
              returnMobileError();
              return;
            }
            ticketProcessed.current = false;
            setTicketLoading(false);
            setTicketError("__finalize_failed__");
            return;
          }
          if (!active) return;
          active = false;
          if (mobileTicketTimeout) clearTimeout(mobileTicketTimeout);
          setTicketLoading(false);
          window.location.href = `${basePath}/dashboard`;
          return;
        }
        if (isMobileHandoff) {
          returnMobileError();
          return;
        }
        ticketProcessed.current = false;
        setTicketLoading(false);
        setTicketError("__expired__");
      })
      .catch((e: unknown) => {
        if (!active) return;
        if (isMobileHandoff) {
          returnMobileError();
          return;
        }
        ticketProcessed.current = false;
        setTicketLoading(false);
        setTicketError(resolveTicketError(e));
      });
    return () => {
      active = false;
      if (mobileTicketTimeout) clearTimeout(mobileTicketTimeout);
    };
  }, [signIn]);

  if (
    new URLSearchParams(window.location.search).get("mobile_handoff_error") ===
    "1"
  ) {
    return (
      <div className="flex min-h-[100dvh] items-center justify-center bg-background px-6">
        <p className="text-sm text-destructive bg-destructive/10 rounded-lg px-4 py-3" role="alert">
          The secure mobile sign-in could not be completed. Return to the app and try again.
        </p>
      </div>
    );
  }

  const handleGoogleClick = async () => {
    if (!signIn) return;
    setGoogleLoading(true);
    setGoogleError(null);
    // Clear any previous safety timeout.
    if (googleTimeoutRef.current) clearTimeout(googleTimeoutRef.current);
    try {
      const { error } = await signIn.sso({
        strategy: "oauth_google",
        redirectUrl: `${window.location.origin}${basePath}/devices`,
        redirectCallbackUrl: `${window.location.origin}${basePath}/sign-in/sso-callback`,
      });
      if (error) {
        setGoogleError(clerkErrorMessage(error));
        setGoogleLoading(false);
        return;
      }
      // sso() resolved without an error — the redirect is in-flight.
      // If the OAuth chain fails silently (e.g. the page reloads without
      // completing sign-in), the spinner would stay forever. Reset it after
      // a safety window so the user can try again.
      googleTimeoutRef.current = setTimeout(() => {
        setGoogleLoading(false);
        setGoogleError(
          "Redirecting to Google\u2014if nothing happened, please try again.",
        );
      }, GOOGLE_REDIRECT_TIMEOUT_MS);
    } catch (e) {
      setGoogleError(clerkErrorMessage(e));
      setGoogleLoading(false);
    }
  };

  if (ticketLoading) {
    return (
      <div className="flex min-h-[100dvh] items-center justify-center bg-background">
        <Loader2 size={32} className="animate-spin text-primary" />
      </div>
    );
  }

  return (
    <div className="flex min-h-[100dvh]">
      <LeftPanel />

      <div className="flex-1 flex flex-col items-center justify-center bg-background px-6 py-12 lg:px-12">
        <div className="w-full max-w-sm space-y-8">
          <div className="lg:hidden flex items-center gap-3 mb-2">
            <img src={`${basePath}/presentail-logo.png`} alt="Presentail OS logo" className="w-8 h-8 rounded-md object-cover" />
            <span className="text-foreground font-semibold text-base tracking-tight">Presentail OS</span>
          </div>

          <div>
            <h1 className="text-2xl font-bold text-foreground tracking-tight">Welcome back!</h1>
            <p className="text-sm text-muted-foreground mt-1.5">Sign in to your account to continue.</p>
          </div>

          {ticketError === "__already_used__" && (
            <div className="text-sm text-destructive bg-destructive/10 rounded-lg px-3 py-2 space-y-1" role="alert">
              <p>This invitation has already been accepted. Each invite link can only be used once.</p>
              <p>
                If you still need access, ask your workspace admin to{" "}
                <button
                  type="button"
                  className="underline font-medium hover:opacity-75 focus:outline-none"
                  onClick={() => {
                    const subject = encodeURIComponent("New invitation needed for Presentail OS");
                    const body = encodeURIComponent(
                      "Hi,\n\nThe invitation link I received has already been used. Could you please send me a new one?\n\nThank you"
                    );
                    window.location.href = `mailto:?subject=${subject}&body=${body}`;
                  }}
                >
                  send a new invitation
                </button>
                .
              </p>
            </div>
          )}

          {ticketError === "__finalize_failed__" && (
            <div className="text-sm text-destructive bg-destructive/10 rounded-lg px-3 py-2" role="alert">
              <p>Sign-in could not be completed. Please try again.</p>
            </div>
          )}

          {ticketError === "__expired__" && (
            <div className="text-sm text-destructive bg-destructive/10 rounded-lg px-3 py-2 space-y-1" role="alert">
              <p>This sign-in link has expired or is invalid. Please request a new one.</p>
              <p>
                Ask your workspace admin to{" "}
                <button
                  type="button"
                  className="underline font-medium hover:opacity-75 focus:outline-none"
                  onClick={() => {
                    const subject = encodeURIComponent("Re-send my invitation to Presentail OS");
                    const body = encodeURIComponent(
                      "Hi,\n\nMy sign-in link has expired. Could you please resend my invitation?\n\nThank you"
                    );
                    window.location.href = `mailto:?subject=${subject}&body=${body}`;
                  }}
                >
                  resend your invitation
                </button>
                .
              </p>
            </div>
          )}

          {activeMethod === null && (
            <div className="space-y-3">
              <MethodCard
                icon={googleLoading ? <Loader2 size={18} className="animate-spin" /> : <GoogleIcon />}
                label="Continue with Google"
                subtitle={googleLoading ? "Redirecting to Google…" : "Fast sign-in via your Google account"}
                onClick={handleGoogleClick}
                disabled={!signIn || googleLoading}
              />
              {googleError && (
                <p className="text-sm text-destructive bg-destructive/10 rounded-lg px-3 py-2" role="alert">{googleError}</p>
              )}
              <MethodCard
                icon={<KeyRound size={18} />}
                label="Continue with Email + Password"
                subtitle="Sign in with your email address and password"
                onClick={() => setActiveMethod("password")}
                disabled={googleLoading}
              />
              <MethodCard
                icon={<Fingerprint size={18} />}
                label="Continue with Email (One-Time Code)"
                subtitle="We'll email you a secure 6-digit code"
                onClick={() => setActiveMethod("otp")}
                disabled={googleLoading}
              />
            </div>
          )}

          {activeMethod === "password" && (
            <PasswordFlow onBack={() => setActiveMethod(null)} />
          )}
          {activeMethod === "otp" && (
            <OtpFlow onBack={() => setActiveMethod(null)} />
          )}

        </div>
      </div>
    </div>
  );
}

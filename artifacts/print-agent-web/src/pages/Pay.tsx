import { useEffect, useRef, useState } from "react";
import { useParams, useSearch } from "wouter";
import {
  CreditCard,
  CheckCircle2,
  XCircle,
  Loader2,
  ExternalLink,
  Clock,
  RefreshCw,
  ArrowLeft,
  User,
  Phone,
  Mail,
  Gift,
  Lock,
} from "lucide-react";
import { parsePhoneNumber, isValidPhoneNumber } from "react-phone-number-input";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { PhoneInputField } from "@/components/PhoneInputField";
import {
  initPixels,
  trackInitiateCheckout,
  trackPurchase,
  hasFiredPurchase,
  markPurchaseFired,
} from "@/lib/pixels";

const basePath = import.meta.env.BASE_URL.replace(/\/$/, "");

const POLL_INTERVAL_MS = 3000;
const POLL_TIMEOUT_MS = 30000;
export const CHECK_AGAIN_ERROR_DISMISS_MS = 5000;
export const NAV_TIMEOUT_MS = 10000;

type PaymentLinkDetails = {
  id: number;
  amount: number;
  currency: string;
  provider: string;
  description: string | null;
  country: string | null;
  status: "active" | "paid" | "expired";
  checkout_url: string | null;
  created_at: string;
  paid_at: string | null;
  sender_first_name: string | null;
  sender_last_name: string | null;
  sender_phone_country_code: string | null;
  sender_phone: string | null;
  sender_email: string | null;
  sender_submitted_at: string | null;
};

type SenderForm = {
  firstName: string;
  lastName: string;
  phoneCountryCode: string;
  phone: string;
  email: string;
};

function formatAmount(cents: number, currency: string): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency,
    minimumFractionDigits: 2,
  }).format(cents / 100);
}

async function fetchPaymentLink(token: string): Promise<PaymentLinkDetails> {
  const r = await fetch(`${basePath}/api/pay/${token}`);
  if (!r.ok) {
    const body = await r.json().catch(() => ({ error: "Not found" }));
    throw new Error((body as { error?: string }).error ?? "Not found");
  }
  return r.json() as Promise<PaymentLinkDetails>;
}

export function getGoogleClickAttribution(search: string): Record<string, string> | null {
  const params = new URLSearchParams(search);
  const entry = (["gclid", "gbraid", "wbraid"] as const)
    .map((key) => [key, params.get(key)?.trim()] as const)
    .find(([, value]) => value);
  if (!entry) return null;
  const [key, value] = entry;
  return { [key]: value as string };
}
async function submitSender(token: string, form: SenderForm): Promise<void> {
  const r = await fetch(`${basePath}/api/pay/${token}/sender`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      first_name: form.firstName.trim(),
      last_name: form.lastName.trim(),
      phone_country_code: form.phoneCountryCode,
      phone: form.phone.trim(),
      email: form.email.trim(),
      // submitted=true signals an explicit "Continue to payment" action.
      // The backend only stamps sender_submitted_at when this flag is true,
      // so auto-saves (which never set it) never mark the form as complete.
      submitted: true,
    }),
  });
  if (!r.ok) {
    const body = await r.json().catch(() => ({ error: "Failed" }));
    throw new Error((body as { error?: string }).error ?? "Failed to save your details");
  }
}

/**
 * Build a payload for auto-save that only includes fields the customer has
 * actually filled in. Empty strings are omitted entirely so the backend's
 * per-field validators (min(1), phone regex, email format) never see them.
 * The `submitted` flag is intentionally absent — auto-saves must not trigger
 * sender_submitted_at on the server.
 */
function buildAutoSavePayload(form: SenderForm): Record<string, string> | null {
  const payload: Record<string, string> = {};
  if (form.firstName.trim()) payload.first_name = form.firstName.trim();
  if (form.lastName.trim()) payload.last_name = form.lastName.trim();
  // Only include phone fields when the national number is present.
  if (form.phone.trim()) {
    payload.phone = form.phone.trim();
    if (form.phoneCountryCode) payload.phone_country_code = form.phoneCountryCode;
  }
  if (form.email.trim()) payload.email = form.email.trim();
  return Object.keys(payload).length > 0 ? payload : null;
}

async function autoSaveSender(token: string, form: SenderForm): Promise<void> {
  const payload = buildAutoSavePayload(form);
  if (!payload) return;
  await fetch(`${basePath}/api/pay/${token}/sender`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  // Silently ignore auto-save errors; final submit will retry.
}

function getSenderStorageKey(token: string) {
  return `pay_sender_${token}`;
}

function loadSenderFromStorage(token: string): SenderForm | null {
  try {
    const raw = sessionStorage.getItem(getSenderStorageKey(token));
    if (!raw) return null;
    return JSON.parse(raw) as SenderForm;
  } catch {
    return null;
  }
}

function saveSenderToStorage(token: string, form: SenderForm) {
  try {
    sessionStorage.setItem(getSenderStorageKey(token), JSON.stringify(form));
  } catch { /* ignore */ }
}

function isValidEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim());
}

function isSenderFormValid(form: SenderForm, e164: string): boolean {
  return (
    form.firstName.trim().length > 0 &&
    form.lastName.trim().length > 0 &&
    isValidPhoneNumber(e164) &&
    isValidEmail(form.email)
  );
}

// Step indicator component
function StepIndicator({ step }: { step: "sender" | "summary" }) {
  const steps = [
    { key: "sender", label: "Sender details" },
    { key: "summary", label: "Payment" },
  ] as const;

  return (
    <div className="flex items-center justify-center gap-0 mb-6 select-none">
      {steps.map((s, i) => {
        const isActive = s.key === step;
        const isPast = i === 0 && step === "summary";
        return (
          <div key={s.key} className="flex items-center">
            <div className="flex items-center gap-2">
              <div
                className={`w-7 h-7 rounded-full flex items-center justify-center text-xs font-bold transition-colors ${
                  isActive
                    ? "bg-[#0d6e7a] text-white"
                    : isPast
                    ? "bg-[#0d6e7a]/20 text-[#0d6e7a]"
                    : "bg-muted text-muted-foreground"
                }`}
              >
                {isPast ? <CheckCircle2 size={14} /> : i + 1}
              </div>
              <span
                className={`text-sm font-medium ${
                  isActive ? "text-foreground" : "text-muted-foreground"
                }`}
              >
                {s.label}
              </span>
            </div>
            {i < steps.length - 1 && (
              <div
                className={`mx-3 h-px w-10 transition-colors ${
                  step === "summary" ? "bg-[#0d6e7a]/40" : "bg-border"
                }`}
              />
            )}
          </div>
        );
      })}
    </div>
  );
}

// Provider security badge
function ProviderBadge({ provider }: { provider: string }) {
  if (provider === "stripe") {
    return (
      <span className="inline-flex items-center gap-1.5 text-xs font-medium text-purple-700 bg-purple-50 border border-purple-200 rounded-full px-3 py-1.5">
        <Lock size={11} />
        Secured by Stripe
      </span>
    );
  }
  if (provider === "mamo") {
    return (
      <span className="inline-flex items-center gap-1.5 text-xs font-medium text-emerald-700 bg-emerald-50 border border-emerald-200 rounded-full px-3 py-1.5">
        <Lock size={11} />
        Secured by Mamo
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1.5 text-xs font-medium text-blue-700 bg-blue-50 border border-blue-200 rounded-full px-3 py-1.5">
      <Lock size={11} />
      Secured by PayPal
    </span>
  );
}

// Amount due chip
function AmountChip({ amount, currency, description }: { amount: number; currency: string; description: string | null }) {
  return (
    <div className="flex flex-col items-center gap-1">
      <div className="inline-flex items-center gap-2 bg-[#f0f9fa] border border-[#b2dde3] rounded-full px-4 py-2">
        <Gift size={14} className="text-[#0d6e7a]" />
        <span className="text-sm font-medium text-[#0d6e7a]">
          Amount due: <span className="font-bold">{formatAmount(amount, currency)}</span>
        </span>
      </div>
      {description && (
        <p className="text-xs text-muted-foreground text-center max-w-xs">{description}</p>
      )}
    </div>
  );
}

export default function PayPage() {
  const { token } = useParams<{ token: string }>();
  const search = useSearch();
  const params = new URLSearchParams(search);
  const isPaidReturn = params.get("paid") === "1";

  const [details, setDetails] = useState<PaymentLinkDetails | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [pollingPending, setPollingPending] = useState(false);
  const [pollingTimedOut, setPollingTimedOut] = useState(false);
  const [checkingAgain, setCheckingAgain] = useState(false);
  const [checkAgainError, setCheckAgainError] = useState<string | null>(null);
  const [navigating, setNavigating] = useState(false);
  const [paymentError, setPaymentError] = useState<string | null>(null);

  // Two-step flow: "sender" = step 1, "summary" = step 2
  const [step, setStep] = useState<"sender" | "summary">("sender");
  const [senderForm, setSenderForm] = useState<SenderForm>({
    firstName: "",
    lastName: "",
    phoneCountryCode: "+961",
    phone: "",
    email: "",
  });
  // E.164 value for PhoneInputField (e.g. "+96170123456")
  const [e164Phone, setE164Phone] = useState("");
  const [senderSubmitting, setSenderSubmitting] = useState(false);
  const [senderError, setSenderError] = useState<string | null>(null);

  const pollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pollDeadlineRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isPollingRef = useRef(false);
  const checkAgainErrorTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const navTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Debounce ref for auto-save
  const autoSaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  function stopPolling() {
    isPollingRef.current = false;
    if (pollTimerRef.current) {
      clearTimeout(pollTimerRef.current);
      pollTimerRef.current = null;
    }
    if (pollDeadlineRef.current) {
      clearTimeout(pollDeadlineRef.current);
      pollDeadlineRef.current = null;
    }
  }

  function schedulePoll(tokenVal: string) {
    if (!isPollingRef.current) return;
    pollTimerRef.current = setTimeout(async () => {
      if (!isPollingRef.current) return;
      try {
        const data = await fetchPaymentLink(tokenVal);
        setDetails(data);
        if (data.status === "paid") {
          setPollingPending(false);
          stopPolling();
        } else if (isPollingRef.current) {
          schedulePoll(tokenVal);
        }
      } catch {
        if (isPollingRef.current) {
          schedulePoll(tokenVal);
        }
      }
    }, POLL_INTERVAL_MS);
  }

  function startPolling(tokenVal: string) {
    isPollingRef.current = true;
    setPollingPending(true);
    setPollingTimedOut(false);
    schedulePoll(tokenVal);
    pollDeadlineRef.current = setTimeout(() => {
      if (isPollingRef.current) {
        stopPolling();
        setPollingPending(false);
        setPollingTimedOut(true);
      }
    }, POLL_TIMEOUT_MS);
  }

  function clearCheckAgainErrorTimer() {
    if (checkAgainErrorTimerRef.current) {
      clearTimeout(checkAgainErrorTimerRef.current);
      checkAgainErrorTimerRef.current = null;
    }
  }

  async function handleCheckAgain() {
    if (!token || checkingAgain) return;
    setCheckingAgain(true);
    clearCheckAgainErrorTimer();
    setCheckAgainError(null);
    try {
      const data = await fetchPaymentLink(token);
      setDetails(data);
      if (data.status === "paid") {
        setPollingTimedOut(false);
      }
    } catch {
      setCheckAgainError("Couldn't reach the server. Please check your connection and try again.");
      checkAgainErrorTimerRef.current = setTimeout(() => {
        setCheckAgainError(null);
        checkAgainErrorTimerRef.current = null;
      }, CHECK_AGAIN_ERROR_DISMISS_MS);
    } finally {
      setCheckingAgain(false);
    }
  }

  useEffect(() => {
    initPixels();
  }, []);

  useEffect(() => {
    if (!token) return;

    fetchPaymentLink(token)
      .then((data) => {
        setDetails(data);
        setLoading(false);

        if (isPaidReturn) {
          setStep("summary");
          if (data.status !== "paid" && !isPollingRef.current) {
            startPolling(token);
          }
          return;
        }

        if (data.status !== "active") {
          setStep("summary");
          return;
        }

        if (data.sender_submitted_at) {
          // Customer clicked "Continue to payment" in a previous session.
          // Pre-fill all captured fields and skip straight to the summary step.
          const cc = data.sender_phone_country_code ?? "+961";
          const nat = data.sender_phone ?? "";
          setSenderForm({
            firstName: data.sender_first_name ?? "",
            lastName: data.sender_last_name ?? "",
            phoneCountryCode: cc,
            phone: nat,
            email: data.sender_email ?? "",
          });
          setE164Phone(nat ? cc + nat : "");
          setStep("summary");
        } else if (
          data.sender_first_name ||
          data.sender_last_name ||
          data.sender_phone ||
          data.sender_phone_country_code ||
          data.sender_email
        ) {
          // Partial auto-save exists on the server — pre-fill whatever was
          // captured and keep the customer on the sender step to complete it.
          const cc = data.sender_phone_country_code ?? "+961";
          const nat = data.sender_phone ?? "";
          setSenderForm({
            firstName: data.sender_first_name ?? "",
            lastName: data.sender_last_name ?? "",
            phoneCountryCode: cc,
            phone: nat,
            email: data.sender_email ?? "",
          });
          setE164Phone(nat ? cc + nat : "");
          setStep("sender");
        } else {
          const saved = loadSenderFromStorage(token);
          if (saved) {
            setSenderForm(saved);
            setE164Phone(saved.phone ? saved.phoneCountryCode + saved.phone : "");
            setStep("summary");
          } else {
            setStep("sender");
          }
        }
      })
      .catch((err: Error) => {
        setError(err.message);
        setLoading(false);
      });

    return () => {
      stopPolling();
      clearCheckAgainErrorTimer();
      if (navTimeoutRef.current) {
        clearTimeout(navTimeoutRef.current);
        navTimeoutRef.current = null;
      }
      if (autoSaveTimerRef.current) {
        clearTimeout(autoSaveTimerRef.current);
        autoSaveTimerRef.current = null;
      }
    };
  }, [token, isPaidReturn]);

  // Debounced auto-save: fires 800ms after firstName/lastName changes when both are non-empty
  const senderFormRef = useRef(senderForm);
  useEffect(() => {
    senderFormRef.current = senderForm;
  }, [senderForm]);

  useEffect(() => {
    if (!token || step !== "sender") return;
    const hasAnyContent =
      senderForm.firstName.trim() ||
      senderForm.lastName.trim() ||
      senderForm.phone.trim() ||
      senderForm.email.trim();
    if (!hasAnyContent) return;

    if (autoSaveTimerRef.current) {
      clearTimeout(autoSaveTimerRef.current);
    }
    autoSaveTimerRef.current = setTimeout(() => {
      autoSaveTimerRef.current = null;
      const form = senderFormRef.current;
      const hasContent =
        form.firstName.trim() ||
        form.lastName.trim() ||
        form.phone.trim() ||
        form.email.trim();
      if (!hasContent) return;
      // Fire partial save with only the fields the customer has typed so far.
      // autoSaveSender strips empty fields so validators never see them, and
      // never sends submitted=true so sender_submitted_at is not stamped.
      autoSaveSender(token, form).catch(() => {
        // Silently ignore auto-save errors — full submit on Continue will retry
      });
    }, 800);

    return () => {
      if (autoSaveTimerRef.current) {
        clearTimeout(autoSaveTimerRef.current);
        autoSaveTimerRef.current = null;
      }
    };
  }, [token, step, senderForm.firstName, senderForm.lastName, senderForm.phone, senderForm.phoneCountryCode, senderForm.email]);

  const pollingTimedOutRef = useRef(pollingTimedOut);
  useEffect(() => {
    pollingTimedOutRef.current = pollingTimedOut;
  }, [pollingTimedOut]);

  const isConfirmedPaidRef = useRef(false);
  useEffect(() => {
    isConfirmedPaidRef.current = details?.status === "paid";
  }, [details]);

  const handleCheckAgainRef = useRef(handleCheckAgain);
  useEffect(() => {
    handleCheckAgainRef.current = handleCheckAgain;
  });

  useEffect(() => {
    function handlePageShow(e: PageTransitionEvent) {
      if (e.persisted) {
        setNavigating(false);
      }
    }
    window.addEventListener("pageshow", handlePageShow);
    return () => {
      window.removeEventListener("pageshow", handlePageShow);
    };
  }, []);

  useEffect(() => {
    if (!isPaidReturn) return;

    function handleVisibilityChange() {
      if (
        document.visibilityState === "visible" &&
        pollingTimedOutRef.current &&
        !isConfirmedPaidRef.current
      ) {
        handleCheckAgainRef.current();
      }
    }

    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => {
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, [isPaidReturn]);

  useEffect(() => {
    if (!token || !isPaidReturn) return;
    if (details?.status !== "paid") return;
    if (hasFiredPurchase(token)) return;
    markPurchaseFired(token);
    trackPurchase(details.amount, details.currency, token, details.country);
  }, [token, isPaidReturn, details]);

  async function handleSenderSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!token || !isSenderFormValid(senderForm, e164Phone) || senderSubmitting) return;
    setSenderSubmitting(true);
    setSenderError(null);
    try {
      await submitSender(token, senderForm);
      saveSenderToStorage(token, senderForm);
      setStep("summary");
    } catch (err) {
      setSenderError(err instanceof Error ? err.message : "Something went wrong. Please try again.");
    } finally {
      setSenderSubmitting(false);
    }
  }

  async function handlePayNow() {
    if (!token || !details?.checkout_url || navigating) return;
    setNavigating(true);
    setPaymentError(null);
    try {
      await captureGoogleClickId(token);
      trackInitiateCheckout(details.amount, details.currency);
      window.location.href = details.checkout_url;
      navTimeoutRef.current = setTimeout(() => {
        navTimeoutRef.current = null;
        setNavigating(false);
      }, NAV_TIMEOUT_MS);
    } catch (err) {
      setPaymentError(
        err instanceof Error
          ? err.message
          : "We couldn't prepare the secure payment. Please try again.",
      );
      setNavigating(false);
    }
  }

  const isConfirmedPaid = details?.status === "paid";
  const showPendingBanner = isPaidReturn && pollingPending && !isConfirmedPaid;
  const showSuccessBanner = isConfirmedPaid || (isPaidReturn && !pollingPending && !pollingTimedOut);

  const showStepIndicator =
    !loading &&
    !error &&
    details !== null &&
    (step === "sender" || (step === "summary" && details.status === "active" && !isPaidReturn));

  return (
    <div className="min-h-[100dvh] bg-[#f5f5f0] flex flex-col items-center justify-center px-4 py-10">
      <div className="w-full max-w-[480px]">
        {/* Logo / brand */}
        <div className="flex justify-center mb-8">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-lg bg-[#0d6e7a] flex items-center justify-center text-white">
              <CreditCard size={18} strokeWidth={2.5} />
            </div>
            <span className="font-bold text-lg tracking-tight text-foreground">
              Presentail OS
            </span>
          </div>
        </div>

        {loading ? (
          <div className="flex justify-center py-12">
            <Loader2 className="animate-spin text-muted-foreground" size={28} />
          </div>
        ) : error ? (
          <div className="bg-white border border-border rounded-2xl shadow-sm p-8 text-center space-y-4">
            <XCircle size={40} className="text-destructive mx-auto" />
            <div>
              <h2 className="text-lg font-semibold text-foreground">This link isn't available</h2>
              <p className="text-sm text-muted-foreground mt-1">
                This payment link may have expired or been removed. Please contact the sender for a new link.
              </p>
            </div>
          </div>
        ) : details ? (
          <>
            {showStepIndicator && <StepIndicator step={step} />}

            {step === "sender" && details.status === "active" ? (
              /* ── Step 1: Sender details form ── */
              <div className="bg-white border border-border rounded-2xl shadow-sm overflow-hidden">
                <div className="p-7 space-y-6">
                  {/* Amount due chip */}
                  <div className="flex justify-center">
                    <AmountChip amount={details.amount} currency={details.currency} description={details.description} />
                  </div>

                  {/* Heading */}
                  <div className="space-y-1">
                    <h2 className="text-lg font-bold text-foreground tracking-tight">Tell us who's sending</h2>
                    <p className="text-sm text-muted-foreground">
                      Enter your contact details before proceeding to payment.
                    </p>
                  </div>

                  <form onSubmit={handleSenderSubmit} className="space-y-4">
                    {/* Name row */}
                    <div className="grid grid-cols-2 gap-3">
                      <div className="space-y-1.5">
                        <Label htmlFor="pay-first-name" className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
                          First name
                        </Label>
                        <Input
                          id="pay-first-name"
                          autoComplete="given-name"
                          placeholder="Jane"
                          value={senderForm.firstName}
                          onChange={(e) => setSenderForm((f) => ({ ...f, firstName: e.target.value }))}
                          required
                          maxLength={100}
                          className="h-11"
                        />
                      </div>
                      <div className="space-y-1.5">
                        <Label htmlFor="pay-last-name" className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
                          Last name
                        </Label>
                        <Input
                          id="pay-last-name"
                          autoComplete="family-name"
                          placeholder="Doe"
                          value={senderForm.lastName}
                          onChange={(e) => setSenderForm((f) => ({ ...f, lastName: e.target.value }))}
                          required
                          maxLength={100}
                          className="h-11"
                        />
                      </div>
                    </div>

                    {/* Phone */}
                    <div className="space-y-1.5">
                      <Label className="text-xs font-medium text-muted-foreground uppercase tracking-wide flex items-center gap-1.5">
                        <Phone size={11} />
                        Phone number
                      </Label>
                      <PhoneInputField
                        defaultCountry="LB"
                        value={e164Phone}
                        onChange={(v) => {
                          const val = v ?? "";
                          setE164Phone(val);
                          const parsed = val ? parsePhoneNumber(val) : undefined;
                          if (parsed) {
                            setSenderForm((f) => ({
                              ...f,
                              phoneCountryCode: "+" + parsed.countryCallingCode,
                              phone: parsed.nationalNumber,
                            }));
                          } else {
                            setSenderForm((f) => ({ ...f, phoneCountryCode: "", phone: "" }));
                          }
                        }}
                        className={`h-11 ${e164Phone && !isValidPhoneNumber(e164Phone) ? "border-destructive focus-within:ring-destructive" : ""}`}
                      />
                      {e164Phone && !isValidPhoneNumber(e164Phone) && (
                        <p className="text-xs text-destructive">Enter a valid phone number</p>
                      )}
                    </div>

                    {/* Email */}
                    <div className="space-y-1.5">
                      <Label htmlFor="pay-email" className="text-xs font-medium text-muted-foreground uppercase tracking-wide flex items-center gap-1.5">
                        <Mail size={11} />
                        Email address
                      </Label>
                      <Input
                        id="pay-email"
                        type="email"
                        autoComplete="email"
                        placeholder="jane@example.com"
                        value={senderForm.email}
                        onChange={(e) => setSenderForm((f) => ({ ...f, email: e.target.value }))}
                        required
                        maxLength={255}
                        className={`h-11 ${senderForm.email && !isValidEmail(senderForm.email) ? "border-destructive focus-visible:ring-destructive" : ""}`}
                      />
                      {senderForm.email && !isValidEmail(senderForm.email) && (
                        <p className="text-xs text-destructive">Enter a valid email address</p>
                      )}
                    </div>

                    {senderError && (
                      <p className="text-sm text-destructive">{senderError}</p>
                    )}

                    <Button
                      type="submit"
                      className="w-full h-12 text-base gap-2 bg-[#0d6e7a] hover:bg-[#0a5c67] text-white"
                      disabled={!isSenderFormValid(senderForm, e164Phone) || senderSubmitting}
                    >
                      {senderSubmitting ? (
                        <Loader2 size={18} className="animate-spin" />
                      ) : null}
                      {senderSubmitting ? "Saving…" : "Continue to payment"}
                    </Button>
                  </form>
                </div>

                <div className="border-t border-border bg-[#fafafa] px-7 py-4 flex items-center justify-center gap-2">
                  <Lock size={12} className="text-muted-foreground" />
                  <p className="text-xs text-muted-foreground">
                    Secure payment · Powered by Presentail OS
                  </p>
                </div>
              </div>
            ) : (
              /* ── Step 2: Summary + Pay CTA ── */
              <div className="bg-white border border-border rounded-2xl shadow-sm overflow-hidden">
                {/* Pending confirmation banner */}
                {showPendingBanner && (
                  <div className="bg-amber-500 text-white px-6 py-4 flex items-center gap-3">
                    <Loader2 size={22} className="animate-spin shrink-0" />
                    <div>
                      <p className="font-semibold">Confirming your payment…</p>
                      <p className="text-sm opacity-90">Please wait while we verify your payment.</p>
                    </div>
                  </div>
                )}

                {/* Success banner */}
                {showSuccessBanner && !showPendingBanner && (
                  <div className="bg-green-500 text-white px-6 py-4 flex items-center gap-3">
                    <CheckCircle2 size={22} />
                    <div>
                      <p className="font-semibold">Payment successful!</p>
                      <p className="text-sm opacity-90">Thank you for your payment.</p>
                    </div>
                  </div>
                )}

                {/* Timed out banner */}
                {isPaidReturn && pollingTimedOut && !isConfirmedPaid && (
                  <div className="bg-muted border-b border-border px-6 py-4 space-y-2">
                    <div className="flex items-center gap-3">
                      <Clock size={20} className="text-muted-foreground shrink-0" />
                      <div className="flex-1">
                        <p className="font-semibold text-foreground text-sm">Still processing</p>
                        <p className="text-xs text-muted-foreground">Your payment is being processed. This page will not auto-refresh further.</p>
                      </div>
                      <Button
                        size="sm"
                        variant="outline"
                        className="shrink-0 gap-1.5"
                        onClick={handleCheckAgain}
                        disabled={checkingAgain}
                      >
                        {checkingAgain ? (
                          <Loader2 size={14} className="animate-spin" />
                        ) : (
                          <RefreshCw size={14} />
                        )}
                        Check again
                      </Button>
                    </div>
                    {checkAgainError && (
                      <p className="text-xs text-destructive pl-8" role="alert">
                        {checkAgainError}
                      </p>
                    )}
                  </div>
                )}

                <div className="p-7 space-y-6">
                  {/* Amount chip */}
                  <div className="flex justify-center">
                    <AmountChip amount={details.amount} currency={details.currency} description={details.description} />
                  </div>

                  {/* Heading */}
                  {!isConfirmedPaid && details.status === "active" && (
                    <div className="text-center">
                      <h2 className="text-lg font-bold text-foreground tracking-tight">Complete your payment</h2>
                    </div>
                  )}

                  {/* Sender summary */}
                  {senderForm.email && (
                    <div className="rounded-xl border border-border bg-[#fafafa] p-4 space-y-3">
                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-2">
                          <div className="w-8 h-8 rounded-full bg-[#e6f4f6] flex items-center justify-center">
                            <User size={14} className="text-[#0d6e7a]" />
                          </div>
                          <p className="text-sm font-semibold text-foreground">
                            {senderForm.firstName} {senderForm.lastName}
                          </p>
                        </div>
                        {details.status === "active" && !isPaidReturn && (
                          <button
                            type="button"
                            className="text-xs text-[#0d6e7a] hover:underline flex items-center gap-1 font-medium"
                            onClick={() => setStep("sender")}
                          >
                            <ArrowLeft size={11} />
                            Edit
                          </button>
                        )}
                      </div>
                      <div className="space-y-1 pl-10">
                        <p className="text-sm text-muted-foreground flex items-center gap-2">
                          <Phone size={12} className="shrink-0" />
                          {senderForm.phoneCountryCode} {senderForm.phone}
                        </p>
                        <p className="text-sm text-muted-foreground flex items-center gap-2">
                          <Mail size={12} className="shrink-0" />
                          {senderForm.email}
                        </p>
                      </div>
                    </div>
                  )}

                  {/* Provider security note */}
                  <div className="flex justify-center">
                    <ProviderBadge provider={details.provider} />
                  </div>

                  {/* CTA */}
                  {isConfirmedPaid || (isPaidReturn && !pollingTimedOut) ? (
                    <div className="flex items-center justify-center gap-2 text-green-600 font-medium py-2">
                      {isConfirmedPaid ? (
                        <>
                          <CheckCircle2 size={20} />
                          <span>Payment received</span>
                        </>
                      ) : (
                        <>
                          <Loader2 size={20} className="animate-spin" />
                          <span className="text-amber-600">Verifying payment…</span>
                        </>
                      )}
                    </div>
                  ) : details.status === "active" ? (
                    <Button
                      className="w-full h-13 text-base gap-2 bg-[#0d6e7a] hover:bg-[#0a5c67] text-white py-3.5"
                      onClick={handlePayNow}
                      disabled={!details.checkout_url || navigating}
                    >
                      {navigating ? (
                        <Loader2 size={18} className="animate-spin" />
                      ) : (
                        <ExternalLink size={18} />
                      )}
                      Pay {formatAmount(details.amount, details.currency)}
                    </Button>
                  ) : (
                    <div className="text-center text-muted-foreground text-sm py-2">
                      This payment link is no longer active.
                    </div>
                  )}
                  {paymentError && (
                    <p className="text-sm text-destructive text-center" role="alert">
                      {paymentError}
                    </p>
                  )}
                </div>

                <div className="border-t border-border bg-[#fafafa] px-7 py-4 flex items-center justify-center gap-2">
                  <Lock size={12} className="text-muted-foreground" />
                  <p className="text-xs text-muted-foreground">
                    Secure payment · Powered by Presentail OS
                  </p>
                </div>
              </div>
            )}
          </>
        ) : null}
      </div>
    </div>
  );
}

async function captureGoogleClickId(token: string): Promise<void> {
  const attribution = getGoogleClickAttribution(window.location.search);
  if (!attribution) return;
  const response = await fetch(`${basePath}/api/pay/${token}/attribution`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(attribution),
    keepalive: true,
  });
  if (!response.ok) {
    throw new Error("We couldn't prepare the secure payment. Please try again.");
  }
}

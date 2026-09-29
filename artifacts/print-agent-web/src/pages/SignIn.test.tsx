import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import SignIn from "./SignIn";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockSignInCreate = vi.fn();
const mockSignInPassword = vi.fn();
const mockEmailCodeSendCode = vi.fn();
const mockEmailCodeVerifyCode = vi.fn();
const mockMfaSendEmailCode = vi.fn();
const mockMfaVerifyEmailCode = vi.fn();

const stableSignIn = {
  create: mockSignInCreate,
  password: mockSignInPassword,
  status: "needs_first_factor" as string,
  finalize: vi.fn(),
  sso: vi.fn(),
  emailCode: {
    sendCode: mockEmailCodeSendCode,
    verifyCode: mockEmailCodeVerifyCode,
  },
  mfa: {
    sendEmailCode: mockMfaSendEmailCode,
    verifyEmailCode: mockMfaVerifyEmailCode,
  },
};

vi.mock("@clerk/react", () => ({
  useSignIn: () => ({ signIn: stableSignIn }),
}));

// ---------------------------------------------------------------------------
// Location helpers
// ---------------------------------------------------------------------------

const originalLocation = window.location;

function restoreLocation() {
  Object.defineProperty(window, "location", {
    value: originalLocation,
    writable: true,
    configurable: true,
  });
}

/**
 * Replace window.location with a spy on the href setter. Captures the current
 * search string BEFORE replacing location so the getter doesn't recurse.
 */
function mockLocationHref(): ReturnType<typeof vi.fn> {
  const hrefSetter = vi.fn();
  const capturedSearch = window.location.search;
  const mockLoc = Object.create(null);
  Object.defineProperties(mockLoc, {
    search: { value: capturedSearch, configurable: true },
    href: {
      get() { return ""; },
      set(v: string) { hrefSetter(v); },
      configurable: true,
    },
  });
  Object.defineProperty(window, "location", {
    value: mockLoc,
    writable: true,
    configurable: true,
  });
  return hrefSetter;
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks();
  // Reset implementation queues so leaked once-values from a failed test
  // don't bleed into the next test.
  mockSignInCreate.mockReset();
  mockSignInPassword.mockReset();
  mockEmailCodeSendCode.mockReset();
  mockEmailCodeVerifyCode.mockReset();
  mockMfaSendEmailCode.mockReset();
  mockMfaVerifyEmailCode.mockReset();
  stableSignIn.finalize.mockReset();
  stableSignIn.sso.mockReset();
  stableSignIn.status = "needs_first_factor";
  restoreLocation();
  history.pushState({}, "", "/sign-in");
});

afterEach(() => {
  vi.useRealTimers();
  stableSignIn.status = "needs_first_factor";
  restoreLocation();
  history.pushState({}, "", "/sign-in");
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function renderSignIn() {
  return render(<SignIn />);
}

function simulateExpiredTicketUrl() {
  history.pushState({}, "", "/sign-in?__clerk_ticket=expired_ticket_abc");
}

// ---------------------------------------------------------------------------
// Tests — expired ticket error banner
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Ticket loading spinner tests
// ---------------------------------------------------------------------------

describe("SignIn — ticketLoading spinner", () => {
  it("shows a fullscreen spinner while the ticket sign-in promise is pending", async () => {
    history.pushState({}, "", "/sign-in?__clerk_ticket=valid_ticket_xyz");

    let rejectCreate!: (reason: Error) => void;
    const pendingCreate = new Promise<never>((_, reject) => {
      rejectCreate = reject;
    });
    mockSignInCreate.mockReturnValueOnce(pendingCreate);

    const { container } = render(<SignIn />);

    await waitFor(() => {
      expect(mockSignInCreate).toHaveBeenCalledWith({
        strategy: "ticket",
        ticket: "valid_ticket_xyz",
      });
    });

    expect(container.querySelector("svg.animate-spin")).toBeInTheDocument();
    expect(
      screen.queryByText(/this sign-in link has expired or is invalid/i),
    ).not.toBeInTheDocument();

    await act(async () => {
      rejectCreate(new Error("Ticket is expired"));
    });
  });

  it("hides the spinner and shows the error banner after the ticket sign-in promise rejects with an error", async () => {
    history.pushState({}, "", "/sign-in?__clerk_ticket=valid_ticket_xyz");

    let rejectCreate!: (reason: Error) => void;
    const pendingCreate = new Promise<never>((_, reject) => {
      rejectCreate = reject;
    });
    mockSignInCreate.mockReturnValueOnce(pendingCreate);

    const { container } = render(<SignIn />);

    await waitFor(() => {
      expect(mockSignInCreate).toHaveBeenCalledWith({
        strategy: "ticket",
        ticket: "valid_ticket_xyz",
      });
    });

    expect(container.querySelector("svg.animate-spin")).toBeInTheDocument();

    await act(async () => {
      rejectCreate(new Error("Ticket is expired"));
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(container.querySelector("svg.animate-spin")).not.toBeInTheDocument();
      expect(
        screen.getByText(/this sign-in link has expired or is invalid/i),
      ).toBeInTheDocument();
    });
  });
});

// ---------------------------------------------------------------------------
// Successful ticket sign-in tests
// ---------------------------------------------------------------------------

describe("SignIn — successful ticket sign-in", () => {
  it("finalizes the updated sign-in resource and redirects to /dashboard", async () => {
    history.pushState({}, "", "/sign-in?__clerk_ticket=valid_ticket_xyz");

    stableSignIn.status = "complete";
    stableSignIn.finalize.mockResolvedValueOnce(undefined);
    mockSignInCreate.mockResolvedValueOnce({});

    const hrefSetter = mockLocationHref();

    const { container } = render(<SignIn />);

    await waitFor(() => {
      expect(mockSignInCreate).toHaveBeenCalledWith({
        strategy: "ticket",
        ticket: "valid_ticket_xyz",
      });
    });

    await waitFor(() => {
      expect(container.querySelector("svg.animate-spin")).not.toBeInTheDocument();
    });

    expect(stableSignIn.finalize).toHaveBeenCalled();
    expect(hrefSetter).toHaveBeenCalledWith(expect.stringContaining("/dashboard"));
  });

  it("hides the spinner and shows an error message when finalize rejects after ticket sign-in resolves with status complete", async () => {
    history.pushState({}, "", "/sign-in?__clerk_ticket=valid_ticket_xyz");

    stableSignIn.status = "complete";
    stableSignIn.finalize.mockRejectedValueOnce(new Error("Session could not be established."));
    mockSignInCreate.mockResolvedValueOnce({});

    const { container } = render(<SignIn />);

    await waitFor(() => {
      expect(mockSignInCreate).toHaveBeenCalledWith({
        strategy: "ticket",
        ticket: "valid_ticket_xyz",
      });
    });

    await waitFor(() => {
      expect(container.querySelector("svg.animate-spin")).not.toBeInTheDocument();
      expect(screen.getByRole("alert")).toBeInTheDocument();
    });

    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent("Sign-in could not be completed. Please try again.");
    expect(alert).not.toHaveTextContent("This sign-in link has expired or is invalid.");
  });
});

describe("SignIn — mobile handoff failures", () => {
  it("returns control to the app when ticket finalization stalls", async () => {
    vi.useFakeTimers();
    history.pushState(
      {},
      "",
      "/sign-in?__clerk_ticket=mobile_ticket&mobile_handoff=1",
    );
    mockSignInCreate.mockReturnValueOnce(new Promise(() => {}));
    const hrefSetter = mockLocationHref();

    render(<SignIn />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(15_000);
    });

    expect(hrefSetter).toHaveBeenCalledWith(
      expect.stringContaining("/sign-in?mobile_handoff_error=1"),
    );
  });

  it("returns control to the mobile app instead of rendering another sign-in screen", async () => {
    history.pushState(
      {},
      "",
      "/sign-in?__clerk_ticket=mobile_ticket&mobile_handoff=1",
    );
    mockSignInCreate.mockRejectedValueOnce(new Error("Ticket is expired"));
    const hrefSetter = mockLocationHref();

    render(<SignIn />);

    await waitFor(() => {
      expect(hrefSetter).toHaveBeenCalledWith(
        expect.stringContaining("/sign-in?mobile_handoff_error=1"),
      );
    });
    expect(screen.queryByText("Continue with Google")).not.toBeInTheDocument();
  });

  it("fails closed at the mobile error URL without exposing web sign-in methods", () => {
    history.pushState({}, "", "/sign-in?mobile_handoff_error=1");

    render(<SignIn />);

    expect(screen.getByRole("alert")).toHaveTextContent(
      "Return to the app and try again",
    );
    expect(screen.queryByText("Continue with Google")).not.toBeInTheDocument();
    expect(
      screen.queryByText("Continue with Email + Password"),
    ).not.toBeInTheDocument();
  });

  it("returns a non-complete mobile ticket outcome to the app", async () => {
    history.pushState(
      {},
      "",
      "/sign-in?__clerk_ticket=mobile_ticket&mobile_handoff=1",
    );
    mockSignInCreate.mockResolvedValueOnce({ status: "needs_first_factor" });
    const hrefSetter = mockLocationHref();

    render(<SignIn />);

    await waitFor(() => {
      expect(hrefSetter).toHaveBeenCalledWith(
        expect.stringContaining("/sign-in?mobile_handoff_error=1"),
      );
    });
  });
});

// ---------------------------------------------------------------------------
// Expired ticket error banner tests
// ---------------------------------------------------------------------------

describe("SignIn — expired ticket error banner", () => {
  async function renderWithTicket() {
    renderSignIn();
    // Yield to the event loop so React's scheduler can commit the state updates
    // that result from the signIn.create() promise chain in the useEffect.
    await act(async () => {
      await new Promise<void>((r) => setTimeout(r, 50));
    });
  }

  it("shows the expired-link error message when the ticket sign-in call rejects with an error", async () => {
    simulateExpiredTicketUrl();
    mockSignInCreate.mockRejectedValueOnce(new Error("Ticket is expired"));

    await renderWithTicket();

    await waitFor(() => {
      expect(
        screen.getByText(/this sign-in link has expired or is invalid/i),
      ).toBeInTheDocument();
    });
  });

  it("shows the expired-link error message when the ticket sign-in call throws", async () => {
    simulateExpiredTicketUrl();
    mockSignInCreate.mockRejectedValueOnce(new Error("Network error"));

    await renderWithTicket();

    await waitFor(() => {
      expect(
        screen.getByText(/this sign-in link has expired or is invalid/i),
      ).toBeInTheDocument();
    });
  });

  it("shows the 'resend your invitation' button when the ticket sign-in fails", async () => {
    simulateExpiredTicketUrl();
    mockSignInCreate.mockRejectedValueOnce(new Error("Ticket is expired"));

    await renderWithTicket();

    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: /resend your invitation/i }),
      ).toBeInTheDocument();
    });
  });

  it("the error banner has role='alert' and contains both the error text and the resend button", async () => {
    simulateExpiredTicketUrl();
    mockSignInCreate.mockRejectedValueOnce(new Error("Ticket is expired"));

    await renderWithTicket();

    await waitFor(() => {
      const alert = screen.getByRole("alert");
      expect(alert).toBeInTheDocument();
      expect(alert).toHaveTextContent(/this sign-in link has expired or is invalid/i);
      expect(alert).toHaveTextContent(/resend your invitation/i);
    });
  });

  it("clicking 'resend your invitation' sets window.location.href to a mailto: URL", async () => {
    simulateExpiredTicketUrl();
    mockSignInCreate.mockRejectedValueOnce(new Error("Ticket is expired"));

    const hrefSetter = vi.fn();
    const mockLocation = Object.create(null);
    Object.defineProperties(mockLocation, {
      search: {
        value: "?__clerk_ticket=expired_ticket_abc",
        writable: false,
        configurable: true,
      },
      href: {
        get() { return ""; },
        set(v: string) { hrefSetter(v); },
        configurable: true,
      },
    });
    Object.defineProperty(window, "location", {
      value: mockLocation,
      writable: true,
      configurable: true,
    });

    await renderWithTicket();

    const resendBtn = await screen.findByRole("button", { name: /resend your invitation/i });
    await userEvent.click(resendBtn);

    expect(hrefSetter).toHaveBeenCalledWith(
      expect.stringMatching(/^mailto:/),
    );
  });

  it("shows the expired-link banner and hides the spinner when signIn.create resolves with an error payload", async () => {
    history.pushState({}, "", "/sign-in?__clerk_ticket=expired_ticket_abc");

    mockSignInCreate.mockResolvedValueOnce({
      error: { message: "Ticket is expired or invalid." },
    });

    const { container } = render(<SignIn />);

    await waitFor(() => {
      expect(mockSignInCreate).toHaveBeenCalledWith({
        strategy: "ticket",
        ticket: "expired_ticket_abc",
      });
    });

    await waitFor(() => {
      expect(
        screen.getByText(/this sign-in link has expired or is invalid/i),
      ).toBeInTheDocument();
      expect(container.querySelector("svg.animate-spin")).not.toBeInTheDocument();
    });
  });

  it("does NOT show the error banner when there is no ticket in the URL", () => {
    renderSignIn();

    expect(
      screen.queryByText(/this sign-in link has expired or is invalid/i),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /resend your invitation/i }),
    ).not.toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// Tests — already-used ticket error banner
// ---------------------------------------------------------------------------

describe("SignIn — already-used ticket error banner", () => {
  async function renderWithTicket(container: HTMLElement) {
    await act(async () => {
      await new Promise<void>((r) => setTimeout(r, 50));
    });
    return container;
  }

  it("shows the already-used banner and hides the spinner when signIn.create resolves with error code invitation_already_accepted", async () => {
    history.pushState({}, "", "/sign-in?__clerk_ticket=used_ticket_abc");
    mockSignInCreate.mockResolvedValueOnce({
      error: { errors: [{ code: "invitation_already_accepted" }] },
    });

    const { container } = render(<SignIn />);
    await renderWithTicket(container);

    await waitFor(() => {
      expect(
        screen.getByText(/this invitation has already been accepted/i),
      ).toBeInTheDocument();
      expect(container.querySelector("svg.animate-spin")).not.toBeInTheDocument();
    });
  });

  it("shows the already-used banner and hides the spinner when signIn.create resolves with error code ticket_already_consumed", async () => {
    history.pushState({}, "", "/sign-in?__clerk_ticket=used_ticket_xyz");
    mockSignInCreate.mockResolvedValueOnce({
      error: { errors: [{ code: "ticket_already_consumed" }] },
    });

    const { container } = render(<SignIn />);
    await renderWithTicket(container);

    await waitFor(() => {
      expect(
        screen.getByText(/this invitation has already been accepted/i),
      ).toBeInTheDocument();
      expect(container.querySelector("svg.animate-spin")).not.toBeInTheDocument();
    });
  });
});

// ---------------------------------------------------------------------------
// Tests — PasswordFlow
// ---------------------------------------------------------------------------

describe("PasswordFlow", () => {
  async function openPasswordFlow() {
    renderSignIn();
    await userEvent.click(
      screen.getByRole("button", { name: /continue with email \+ password/i }),
    );
  }

  async function fillAndSubmitPassword(email: string, password: string) {
    await userEvent.type(screen.getByLabelText(/email address/i), email);
    await userEvent.type(screen.getByLabelText(/password/i), password);
    await userEvent.click(screen.getByRole("button", { name: /^sign in$/i }));
  }

  // ── Core submit path ─────────────────────────────────────────────────────────

  it("calls signIn.password() with correct args, calls finalize(), and redirects to /devices", async () => {
    mockSignInPassword.mockImplementationOnce(async () => {
      stableSignIn.status = "complete";
    });
    const hrefSetter = mockLocationHref();

    await openPasswordFlow();
    await fillAndSubmitPassword("user@example.com", "secret123");

    await waitFor(() => {
      // Must use the factor-specific password method, never signIn.create().
      expect(mockSignInPassword).toHaveBeenCalledWith({
        emailAddress: "user@example.com",
        password: "secret123",
      });
      expect(stableSignIn.finalize).toHaveBeenCalled();
      expect(hrefSetter).toHaveBeenCalledWith(expect.stringContaining("/devices"));
    });
    expect(mockSignInCreate).not.toHaveBeenCalled();
  });

  it("shows an error alert when the password is wrong — no OTP sent", async () => {
    mockSignInPassword.mockRejectedValueOnce(
      new Error("Password is incorrect. Try again, or use another method."),
    );

    await openPasswordFlow();
    await fillAndSubmitPassword("user@example.com", "wrongpass");

    await waitFor(() => {
      expect(screen.getByRole("alert")).toBeInTheDocument();
    });
    // Wrong credentials must never trigger an OTP or advance to the code screen.
    expect(mockMfaSendEmailCode).not.toHaveBeenCalled();
    expect(mockEmailCodeSendCode).not.toHaveBeenCalled();
    expect(screen.queryByLabelText(/one-time code/i)).not.toBeInTheDocument();
  });

  it("shows loading text while the sign-in request is in flight", async () => {
    let settle!: (v: unknown) => void;
    mockSignInPassword.mockReturnValueOnce(new Promise((r) => { settle = r; }));

    await openPasswordFlow();
    await userEvent.type(screen.getByLabelText(/email address/i), "user@example.com");
    await userEvent.type(screen.getByLabelText(/password/i), "secret123");

    const clickPromise = userEvent.click(screen.getByRole("button", { name: /^sign in$/i }));

    await waitFor(() => {
      expect(screen.getByText(/signing in/i)).toBeInTheDocument();
    });

    settle(undefined);
    await clickPromise;
  });

  it("disables the submit button while the sign-in request is in flight", async () => {
    let settle!: (v: unknown) => void;
    mockSignInPassword.mockReturnValueOnce(new Promise((r) => { settle = r; }));

    await openPasswordFlow();
    await userEvent.type(screen.getByLabelText(/email address/i), "user@example.com");
    await userEvent.type(screen.getByLabelText(/password/i), "secret123");

    const clickPromise = userEvent.click(screen.getByRole("button", { name: /^sign in$/i }));

    await waitFor(() => {
      expect(screen.getByRole("button", { name: /signing in/i })).toBeDisabled();
    });

    settle(undefined);
    await clickPromise;
  });

  it("shows an error alert for an unknown email — no OTP sent", async () => {
    mockSignInPassword.mockRejectedValueOnce(
      new Error("No account found with that email."),
    );

    await openPasswordFlow();
    await fillAndSubmitPassword("unknown@example.com", "anypass");

    await waitFor(() => {
      expect(screen.getByRole("alert")).toBeInTheDocument();
    });
    expect(mockMfaSendEmailCode).not.toHaveBeenCalled();
    expect(mockEmailCodeSendCode).not.toHaveBeenCalled();
    expect(screen.queryByLabelText(/one-time code/i)).not.toBeInTheDocument();
  });

  it("clicking Back returns to the method selection screen", async () => {
    await openPasswordFlow();
    await userEvent.click(screen.getByRole("button", { name: /^back$/i }));

    expect(
      screen.getByRole("button", { name: /continue with email \+ password/i }),
    ).toBeInTheDocument();
  });

  it("shows an error and re-enables the button when finalize rejects after status complete", async () => {
    mockSignInPassword.mockImplementationOnce(async () => {
      stableSignIn.status = "complete";
    });
    stableSignIn.finalize.mockRejectedValueOnce(new Error("Session could not be established."));

    await openPasswordFlow();
    await fillAndSubmitPassword("user@example.com", "secret123");

    await waitFor(() => {
      expect(screen.getByRole("alert")).toHaveTextContent(
        /session could not be established/i,
      );
    });
    expect(screen.getByRole("button", { name: /^sign in$/i })).not.toBeDisabled();
    expect(screen.queryByText(/signing in/i)).not.toBeInTheDocument();
  });

  // ── Status-specific handling ──────────────────────────────────────────────────

  it("shows a configuration error (no OTP sent) when status is needs_client_trust", async () => {
    // OS uses direct password login; client-trust OTPs are not part of the
    // intended flow. The code must surface a clear error instead of emailing a
    // code the user did not request.
    mockSignInPassword.mockImplementationOnce(async () => {
      stableSignIn.status = "needs_client_trust";
    });

    await openPasswordFlow();
    await fillAndSubmitPassword("user@example.com", "secret123");

    await waitFor(() => {
      expect(screen.getByRole("alert")).toHaveTextContent(
        /sign-in requires a device-verification step/i,
      );
    });
    expect(mockEmailCodeSendCode).not.toHaveBeenCalled();
    expect(mockMfaSendEmailCode).not.toHaveBeenCalled();
    expect(screen.queryByLabelText(/one-time code/i)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^sign in$/i })).not.toBeDisabled();
  });

  it("advances to MFA code screen and calls signIn.mfa.sendEmailCode when status is needs_second_factor", async () => {
    // needs_second_factor is the only status that legitimately advances to the
    // code screen in PasswordFlow. It must use the dedicated MFA channel, never
    // the passwordless first-factor emailCode channel.
    mockSignInPassword.mockImplementationOnce(async () => {
      stableSignIn.status = "needs_second_factor";
    });
    mockMfaSendEmailCode.mockResolvedValueOnce({ error: null });

    await openPasswordFlow();
    await fillAndSubmitPassword("user@example.com", "secret123");

    expect(await screen.findByLabelText(/one-time code/i)).toBeInTheDocument();
    expect(mockMfaSendEmailCode).toHaveBeenCalledTimes(1);
    expect(mockEmailCodeSendCode).not.toHaveBeenCalled();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("verifies MFA code via signIn.mfa.verifyEmailCode and calls finalize on complete", async () => {
    mockSignInPassword.mockImplementationOnce(async () => {
      stableSignIn.status = "needs_second_factor";
    });
    mockMfaSendEmailCode.mockResolvedValueOnce({ error: null });
    mockMfaVerifyEmailCode.mockImplementationOnce(async () => {
      stableSignIn.status = "complete";
      return { error: null };
    });
    const hrefSetter = mockLocationHref();

    await openPasswordFlow();
    await fillAndSubmitPassword("user@example.com", "secret123");
    await screen.findByLabelText(/one-time code/i);

    await userEvent.type(screen.getByLabelText(/one-time code/i), "654321");
    await userEvent.click(screen.getByRole("button", { name: /verify & sign in/i }));

    await waitFor(() => {
      // Must verify through the MFA channel, never the passwordless emailCode channel.
      expect(mockMfaVerifyEmailCode).toHaveBeenCalledWith({ code: "654321" });
      expect(stableSignIn.finalize).toHaveBeenCalled();
      expect(hrefSetter).toHaveBeenCalledWith(expect.stringContaining("/devices"));
    });
    expect(mockEmailCodeVerifyCode).not.toHaveBeenCalled();
  });

  it("shows a clear error (no OTP sent) when status is needs_first_factor", async () => {
    // stableSignIn.status is "needs_first_factor" (default from beforeEach).
    // Password didn't satisfy the first factor — no OTP must be sent since
    // that creates a confusing loop in the password flow.
    mockSignInPassword.mockResolvedValueOnce(undefined);

    await openPasswordFlow();
    await fillAndSubmitPassword("user@example.com", "secret123");

    await waitFor(() => {
      expect(screen.getByRole("alert")).toHaveTextContent(
        /password sign-in is not available for this account/i,
      );
    });
    expect(mockMfaSendEmailCode).not.toHaveBeenCalled();
    expect(mockEmailCodeSendCode).not.toHaveBeenCalled();
    expect(screen.queryByLabelText(/one-time code/i)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^sign in$/i })).not.toBeDisabled();
  });

  it("shows fallback error when signIn.password resolves but status is unrecognized", async () => {
    mockSignInPassword.mockImplementationOnce(async () => {
      stableSignIn.status = "needs_new_password";
    });

    await openPasswordFlow();
    await fillAndSubmitPassword("user@example.com", "secret123");

    await waitFor(() => {
      expect(screen.getByRole("alert")).toHaveTextContent(
        /sign-in could not be completed\. please try again, or use a one-time code instead\./i,
      );
    });
    expect(mockMfaSendEmailCode).not.toHaveBeenCalled();
    expect(mockEmailCodeSendCode).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: /^sign in$/i })).not.toBeDisabled();
    expect(screen.queryByText(/signing in/i)).not.toBeInTheDocument();
  });

  it("resend code on the MFA screen calls signIn.mfa.sendEmailCode again", async () => {
    mockSignInPassword.mockImplementationOnce(async () => {
      stableSignIn.status = "needs_second_factor";
    });
    mockMfaSendEmailCode.mockResolvedValueOnce({ error: null });
    mockMfaSendEmailCode.mockResolvedValueOnce({ error: null });

    await openPasswordFlow();
    await fillAndSubmitPassword("user@example.com", "secret123");
    await screen.findByLabelText(/one-time code/i);

    await userEvent.click(screen.getByRole("button", { name: /resend code/i }));

    await waitFor(() => {
      expect(mockMfaSendEmailCode).toHaveBeenCalledTimes(2);
      expect(screen.getByText(/code resent/i)).toBeInTheDocument();
    });
    // Must never touch the passwordless first-factor emailCode channel.
    expect(mockEmailCodeSendCode).not.toHaveBeenCalled();
  });

});

// ---------------------------------------------------------------------------
// Tests — OtpFlow
// ---------------------------------------------------------------------------

describe("OtpFlow", () => {
  afterEach(() => { vi.useRealTimers(); });

  async function openOtpFlow() {
    renderSignIn();
    await userEvent.click(
      screen.getByRole("button", { name: /continue with email \(one-time code\)/i }),
    );
  }

  async function submitEmail(email: string) {
    await userEvent.type(screen.getByLabelText(/email address/i), email);
    await userEvent.click(screen.getByRole("button", { name: /send code/i }));
  }

  async function goToCodeStep() {
    mockSignInCreate.mockResolvedValueOnce({ error: null });
    mockEmailCodeSendCode.mockResolvedValueOnce({ error: null });
    await openOtpFlow();
    await submitEmail("user@example.com");
    await screen.findByLabelText(/one-time code/i);
  }

  it("happy path — code step appears after email is submitted", async () => {
    mockSignInCreate.mockResolvedValueOnce({ error: null });
    mockEmailCodeSendCode.mockResolvedValueOnce({ error: null });

    await openOtpFlow();
    await submitEmail("user@example.com");

    expect(await screen.findByLabelText(/one-time code/i)).toBeInTheDocument();
  });

  it("happy path — calls finalize and redirects to /devices after valid code", async () => {
    stableSignIn.status = "complete";
    mockEmailCodeVerifyCode.mockResolvedValueOnce({ error: null });

    const hrefSetter = mockLocationHref();

    await goToCodeStep();

    await userEvent.type(screen.getByLabelText(/one-time code/i), "123456");
    await userEvent.click(screen.getByRole("button", { name: /verify & sign in/i }));

    await waitFor(() => {
      expect(stableSignIn.finalize).toHaveBeenCalled();
      expect(hrefSetter).toHaveBeenCalledWith(expect.stringContaining("/devices"));
    });
  });

  it("shows an error alert when the OTP code is invalid", async () => {
    mockEmailCodeVerifyCode.mockResolvedValueOnce({
      error: { message: "Incorrect code. Please try again." },
    });

    await goToCodeStep();

    await userEvent.type(screen.getByLabelText(/one-time code/i), "000000");
    await userEvent.click(screen.getByRole("button", { name: /verify & sign in/i }));

    await waitFor(() => {
      expect(screen.getByRole("alert")).toHaveTextContent(/incorrect code/i);
    });
  });

  it("resend code — clicking Back from code step returns to email step for resubmission", async () => {
    await goToCodeStep();

    await userEvent.click(screen.getByRole("button", { name: /^back$/i }));

    expect(screen.getByLabelText(/email address/i)).toBeInTheDocument();
    expect(screen.queryByLabelText(/one-time code/i)).not.toBeInTheDocument();

    mockSignInCreate.mockResolvedValueOnce({ error: null });
    mockEmailCodeSendCode.mockResolvedValueOnce({ error: null });

    await userEvent.click(screen.getByRole("button", { name: /send code/i }));

    await waitFor(() => {
      expect(mockEmailCodeSendCode).toHaveBeenCalledTimes(2);
    });
  });

  it("disables the Send code button while the signIn.create promise is in-flight", async () => {
    let settle!: (v: unknown) => void;
    mockSignInCreate.mockReturnValueOnce(new Promise((r) => { settle = r; }));
    mockEmailCodeSendCode.mockResolvedValueOnce({ error: null });

    await openOtpFlow();
    await userEvent.type(screen.getByLabelText(/email address/i), "user@example.com");

    const clickPromise = userEvent.click(screen.getByRole("button", { name: /send code/i }));

    await waitFor(() => {
      expect(screen.getByRole("button", { name: /sending code/i })).toBeDisabled();
    });

    settle({ error: null });
    await clickPromise;
  });

  it("shows an error alert when sendCode fails", async () => {
    mockSignInCreate.mockResolvedValueOnce({ error: null });
    mockEmailCodeSendCode.mockResolvedValueOnce({
      error: { message: "Failed to send code. Please try again." },
    });

    await openOtpFlow();
    await submitEmail("user@example.com");

    await waitFor(() => {
      expect(screen.getByRole("alert")).toHaveTextContent(/failed to send code/i);
    });
  });

  it("resend code — button is visible on the code step", async () => {
    await goToCodeStep();
    expect(screen.getByRole("button", { name: /resend code/i })).toBeInTheDocument();
  });

  it("resend code — clicking it calls sendCode again and shows confirmation", async () => {
    await goToCodeStep();
    mockEmailCodeSendCode.mockResolvedValueOnce({ error: null });

    await userEvent.click(screen.getByRole("button", { name: /resend code/i }));

    await waitFor(() => {
      expect(mockEmailCodeSendCode).toHaveBeenCalledTimes(2);
      expect(screen.getByText(/code resent/i)).toBeInTheDocument();
    });
  });

  it("resend code — button is disabled while resend is in flight", async () => {
    await goToCodeStep();

    let settle!: (v: { error: null }) => void;
    mockEmailCodeSendCode.mockReturnValueOnce(
      new Promise<{ error: null }>((res) => { settle = res; }),
    );

    const resendButton = screen.getByRole("button", { name: /resend code/i });
    await userEvent.click(resendButton);

    await waitFor(() => {
      expect(screen.getByRole("button", { name: /resending/i })).toBeDisabled();
    });

    settle({ error: null });
    await waitFor(() => {
      expect(screen.getByText(/code resent/i)).toBeInTheDocument();
    });
  });

  it("resend code — shows an error alert when resend fails", async () => {
    await goToCodeStep();
    mockEmailCodeSendCode.mockResolvedValueOnce({
      error: { message: "Too many attempts. Please try again later." },
    });

    await userEvent.click(screen.getByRole("button", { name: /resend code/i }));

    await waitFor(() => {
      expect(screen.getByRole("alert")).toHaveTextContent(/too many attempts/i);
      expect(screen.getByRole("button", { name: /resend code/i })).toBeInTheDocument();
    });
  });

  it("resend cooldown — shows disabled countdown button immediately after a successful resend", async () => {
    await goToCodeStep();
    mockEmailCodeSendCode.mockResolvedValueOnce({ error: null });
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });

    await userEvent.click(screen.getByRole("button", { name: /resend code/i }));

    await waitFor(() => {
      const btn = screen.getByRole("button", { name: /resend in 30s/i });
      expect(btn).toBeDisabled();
    });
  });

  it("resend cooldown — countdown decrements each second and button re-enables at zero", async () => {
    await goToCodeStep();
    mockEmailCodeSendCode.mockResolvedValueOnce({ error: null });
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });

    await userEvent.click(screen.getByRole("button", { name: /resend code/i }));

    await waitFor(() => {
      expect(screen.getByRole("button", { name: /resend in 30s/i })).toBeDisabled();
    });

    await act(async () => { vi.advanceTimersByTime(15_000); });
    expect(screen.getByRole("button", { name: /resend in 15s/i })).toBeDisabled();

    await act(async () => { vi.advanceTimersByTime(15_000); });
    await waitFor(() => {
      const btn = screen.getByRole("button", { name: /resend code/i });
      expect(btn).toBeEnabled();
    });
  });

  it("resend cooldown — no countdown appears when resend fails", async () => {
    await goToCodeStep();
    mockEmailCodeSendCode.mockResolvedValueOnce({
      error: { message: "Too many attempts. Please try again later." },
    });

    await userEvent.click(screen.getByRole("button", { name: /resend code/i }));

    await waitFor(() => {
      expect(screen.getByRole("alert")).toHaveTextContent(/too many attempts/i);
    });

    expect(screen.queryByRole("button", { name: /resend in/i })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /resend code/i })).toBeEnabled();
  });

  it("resend cooldown — navigating back clears the countdown", async () => {
    await goToCodeStep();
    mockEmailCodeSendCode.mockResolvedValueOnce({ error: null });
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });

    await userEvent.click(screen.getByRole("button", { name: /resend code/i }));

    await waitFor(() => {
      expect(screen.getByRole("button", { name: /resend in 30s/i })).toBeDisabled();
    });

    await userEvent.click(screen.getByRole("button", { name: /^back$/i }));

    expect(screen.queryByRole("button", { name: /resend in/i })).not.toBeInTheDocument();
    expect(screen.getByLabelText(/email address/i)).toBeInTheDocument();
  });

  it("disables the Verify & sign in button while the verifyCode promise is in-flight", async () => {
    let settle!: (v: { error: null }) => void;
    mockEmailCodeVerifyCode.mockReturnValueOnce(
      new Promise<{ error: null }>((res) => { settle = res; }),
    );

    await goToCodeStep();

    await userEvent.type(screen.getByLabelText(/one-time code/i), "123456");

    const clickPromise = userEvent.click(
      screen.getByRole("button", { name: /verify & sign in/i }),
    );

    await waitFor(() => {
      expect(screen.getByRole("button", { name: /verifying/i })).toBeDisabled();
    });

    settle({ error: null });
    await clickPromise;
  });

  it("shows a user-friendly error alert when verifyCode throws a network error", async () => {
    mockEmailCodeVerifyCode.mockRejectedValueOnce(new Error("Network request failed"));

    await goToCodeStep();

    await userEvent.type(screen.getByLabelText(/one-time code/i), "123456");
    await userEvent.click(screen.getByRole("button", { name: /verify & sign in/i }));

    await waitFor(() => {
      expect(screen.getByRole("alert")).toHaveTextContent(/network request failed/i);
    });

    expect(screen.getByRole("button", { name: /verify & sign in/i })).not.toBeDisabled();
    expect(screen.queryByText(/verifying/i)).not.toBeInTheDocument();
  });

  it("shows the fallback error alert when verifyCode resolves without error but status is not complete", async () => {
    mockEmailCodeVerifyCode.mockResolvedValueOnce({ error: null });

    await goToCodeStep();

    await userEvent.type(screen.getByLabelText(/one-time code/i), "123456");
    await userEvent.click(screen.getByRole("button", { name: /verify & sign in/i }));

    await waitFor(() => {
      expect(screen.getByRole("alert")).toHaveTextContent(
        /sign-in could not be completed\. please try again\./i,
      );
    });

    expect(screen.getByRole("button", { name: /verify & sign in/i })).not.toBeDisabled();
    expect(screen.queryByText(/verifying/i)).not.toBeInTheDocument();
  });

  it("shows an error alert and re-enables the button when finalize rejects after successful OTP verification", async () => {
    stableSignIn.status = "complete";
    mockEmailCodeVerifyCode.mockResolvedValueOnce({ error: null });
    stableSignIn.finalize.mockRejectedValueOnce(new Error("Session could not be established."));

    await goToCodeStep();

    await userEvent.type(screen.getByLabelText(/one-time code/i), "123456");
    await userEvent.click(screen.getByRole("button", { name: /verify & sign in/i }));

    await waitFor(() => {
      expect(screen.getByRole("alert")).toHaveTextContent(
        /session could not be established/i,
      );
    });

    expect(screen.getByRole("button", { name: /verify & sign in/i })).not.toBeDisabled();
    expect(screen.queryByText(/verifying/i)).not.toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// Tests — Google SSO flow
// ---------------------------------------------------------------------------

describe("GoogleFlow", () => {
  it("happy path — calls signIn.sso with the correct strategy and redirect URLs", async () => {
    stableSignIn.sso.mockResolvedValueOnce({ error: null });

    renderSignIn();
    await userEvent.click(
      screen.getByRole("button", { name: /continue with google/i }),
    );

    await waitFor(() => {
      expect(stableSignIn.sso).toHaveBeenCalledWith({
        strategy: "oauth_google",
        redirectUrl: expect.stringContaining("/devices"),
        redirectCallbackUrl: expect.stringContaining("/sign-in/sso-callback"),
      });
    });
  });

  it("disables the button and shows the loading subtitle while sso() is pending", async () => {
    let resolveSso!: (value: { error: null }) => void;
    stableSignIn.sso.mockReturnValueOnce(
      new Promise<{ error: null }>((resolve) => {
        resolveSso = resolve;
      }),
    );

    renderSignIn();
    const googleButton = screen.getByRole("button", {
      name: /continue with google/i,
    });

    await userEvent.click(googleButton);

    expect(
      screen.getByText(/redirecting to google…/i),
    ).toBeInTheDocument();
    expect(googleButton).toBeDisabled();

    await act(async () => {
      resolveSso({ error: null });
    });
  });

  it("shows an error alert when sso() returns an error object", async () => {
    stableSignIn.sso.mockResolvedValueOnce({
      error: { message: "Google sign-in failed. Please try again." },
    });

    renderSignIn();
    await userEvent.click(
      screen.getByRole("button", { name: /continue with google/i }),
    );

    await waitFor(() => {
      expect(screen.getByRole("alert")).toHaveTextContent(
        /google sign-in failed/i,
      );
    });
  });

  it("shows an error alert when sso() throws an exception", async () => {
    stableSignIn.sso.mockRejectedValueOnce(
      new Error("Network error during Google sign-in"),
    );

    renderSignIn();
    await userEvent.click(
      screen.getByRole("button", { name: /continue with google/i }),
    );

    await waitFor(() => {
      expect(screen.getByRole("alert")).toHaveTextContent(
        /network error during google sign-in/i,
      );
    });
  });
});

describe("Public account access", () => {
  it("shows sign-in methods without a public sign-up CTA", () => {
    renderSignIn();

    expect(screen.getByRole("button", { name: /continue with google/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /continue with email \+ password/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /continue with email \(one-time code\)/i })).toBeInTheDocument();
    expect(screen.queryByText(/don't have an account/i)).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /sign up/i })).not.toBeInTheDocument();
  });
});

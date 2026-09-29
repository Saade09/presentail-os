import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, act } from "@testing-library/react";
import JoinPage from "./Join";

const INVITE_TOKEN_KEY = "presentail_invite_token";
const VALID_TOKEN = "tok_valid_abc123";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockNavigate = vi.fn();
vi.mock("wouter", () => ({
  useLocation: () => ["/join", mockNavigate],
}));

const mockGetToken = vi.fn().mockResolvedValue("fake-jwt-token");
const mockUseAuth = vi.fn();
vi.mock("@clerk/react", () => ({
  useAuth: () => mockUseAuth(),
  SignUp: ({ routing, path }: { routing: string; path: string }) => (
    <div data-testid="clerk-sign-up" data-routing={routing} data-path={path}>
      Sign Up Form
    </div>
  ),
}));

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

// ---------------------------------------------------------------------------
// Response helpers
// ---------------------------------------------------------------------------

function validInviteResponse() {
  return new Response(
    JSON.stringify({
      email: "newuser@example.com",
      invitedBy: "owner@example.com",
      workspaceName: "Acme Corp",
    }),
    { status: 200 },
  );
}

function notFoundResponse() {
  return new Response(JSON.stringify({ error: "Not found" }), { status: 404 });
}

function goneExpiredResponse() {
  return new Response(JSON.stringify({ error: "Invite expired" }), { status: 410 });
}

function goneUsedResponse() {
  return new Response(JSON.stringify({ error: "Invite already used" }), { status: 410 });
}

function claimSuccessResponse() {
  return new Response(JSON.stringify({ ok: true, alreadyMember: false }), { status: 200 });
}

function claimAlreadyMemberResponse() {
  return new Response(JSON.stringify({ ok: true, alreadyMember: true }), { status: 200 });
}

function claimWrongEmailResponse() {
  return new Response(
    JSON.stringify({ error: "This invite was sent to a different email address." }),
    { status: 403 },
  );
}

// ---------------------------------------------------------------------------
// Render helper
// ---------------------------------------------------------------------------

function renderJoinPage() {
  return render(<JoinPage />);
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks();
  sessionStorage.clear();
  mockGetToken.mockResolvedValue("fake-jwt-token");
  mockUseAuth.mockReturnValue({ isLoaded: true, isSignedIn: false, getToken: mockGetToken });
  history.pushState({}, "", "/join");
});

afterEach(() => {
  history.pushState({}, "", "/join");
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("JoinPage — sessionStorage fallback (Clerk sub-path regression)", () => {
  it("shows the sign-up UI when the token is in the URL", async () => {
    history.pushState({}, "", "/join?token=" + VALID_TOKEN);
    mockFetch.mockResolvedValueOnce(validInviteResponse());

    renderJoinPage();

    await waitFor(() => {
      expect(screen.getByTestId("clerk-sign-up")).toBeInTheDocument();
    });

    expect(screen.getByText(/acme corp/i)).toBeInTheDocument();
    expect(screen.queryByText(/invalid invite link/i)).not.toBeInTheDocument();
  });

  it("persists the token in sessionStorage when the URL contains it", async () => {
    history.pushState({}, "", "/join?token=" + VALID_TOKEN);
    mockFetch.mockResolvedValueOnce(validInviteResponse());

    renderJoinPage();

    await waitFor(() => {
      expect(screen.getByTestId("clerk-sign-up")).toBeInTheDocument();
    });

    expect(sessionStorage.getItem(INVITE_TOKEN_KEY)).toBe(VALID_TOKEN);
  });

  it("shows the sign-up UI when Clerk navigates to a sub-path that drops the token (e.g. /join/verify-email-address)", async () => {
    sessionStorage.setItem(INVITE_TOKEN_KEY, VALID_TOKEN);
    history.pushState({}, "", "/join/verify-email-address");
    mockFetch.mockResolvedValueOnce(validInviteResponse());

    renderJoinPage();

    await waitFor(() => {
      expect(screen.getByTestId("clerk-sign-up")).toBeInTheDocument();
    });

    expect(screen.queryByText(/invalid invite link/i)).not.toBeInTheDocument();
  });

  it("uses the sessionStorage token for the API call when Clerk's sub-path URL has no token", async () => {
    sessionStorage.setItem(INVITE_TOKEN_KEY, VALID_TOKEN);
    history.pushState({}, "", "/join/verify-email-address");
    mockFetch.mockResolvedValueOnce(validInviteResponse());

    renderJoinPage();

    await waitFor(() => {
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining(encodeURIComponent(VALID_TOKEN)),
        expect.anything(),
      );
    });
  });

  it("shows 'Invalid invite link' when neither URL nor sessionStorage has a token", async () => {
    renderJoinPage();

    await waitFor(() => {
      expect(screen.getByText(/invalid invite link/i)).toBeInTheDocument();
    });

    expect(mockFetch).not.toHaveBeenCalled();
  });
});

describe("JoinPage — sessionStorage cleanup on terminal API failures", () => {
  it("clears sessionStorage and shows 'Invalid invite link' on a 404 response", async () => {
    sessionStorage.setItem(INVITE_TOKEN_KEY, VALID_TOKEN);
    mockFetch.mockResolvedValueOnce(notFoundResponse());

    renderJoinPage();

    await waitFor(() => {
      expect(screen.getByText(/invalid invite link/i)).toBeInTheDocument();
    });

    expect(sessionStorage.getItem(INVITE_TOKEN_KEY)).toBeNull();
  });

  it("clears sessionStorage and shows the expired card on a 410 expired response", async () => {
    sessionStorage.setItem(INVITE_TOKEN_KEY, VALID_TOKEN);
    mockFetch.mockResolvedValueOnce(goneExpiredResponse());

    renderJoinPage();

    await waitFor(() => {
      expect(screen.getByText(/invite link expired/i)).toBeInTheDocument();
    });

    expect(sessionStorage.getItem(INVITE_TOKEN_KEY)).toBeNull();
  });

  it("clears sessionStorage and shows the used card on a 410 already-used response", async () => {
    sessionStorage.setItem(INVITE_TOKEN_KEY, VALID_TOKEN);
    mockFetch.mockResolvedValueOnce(goneUsedResponse());

    renderJoinPage();

    await waitFor(() => {
      expect(screen.getByText(/invite already used/i)).toBeInTheDocument();
    });

    expect(sessionStorage.getItem(INVITE_TOKEN_KEY)).toBeNull();
  });

  it("does NOT clear sessionStorage on a transient server error (500), allowing retry", async () => {
    sessionStorage.setItem(INVITE_TOKEN_KEY, VALID_TOKEN);
    mockFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: "Internal error" }), { status: 500 }),
    );

    renderJoinPage();

    await waitFor(() => {
      expect(screen.getByText(/something went wrong/i)).toBeInTheDocument();
    });

    expect(sessionStorage.getItem(INVITE_TOKEN_KEY)).toBe(VALID_TOKEN);
  });
});

describe("JoinPage — auth loading state (isLoaded: false)", () => {
  it("shows a spinner while Clerk auth is loading, even when a token is present", () => {
    mockUseAuth.mockReturnValue({ isLoaded: false, isSignedIn: false });
    sessionStorage.setItem(INVITE_TOKEN_KEY, VALID_TOKEN);
    mockFetch.mockResolvedValueOnce(validInviteResponse());

    renderJoinPage();

    expect(screen.getByRole("status")).toBeInTheDocument();
    expect(screen.queryByTestId("clerk-sign-up")).not.toBeInTheDocument();
    expect(screen.queryByText(/invalid invite link/i)).not.toBeInTheDocument();
  });

  it("shows a spinner while Clerk auth is loading, even when no token is present", () => {
    mockUseAuth.mockReturnValue({ isLoaded: false, isSignedIn: false });

    renderJoinPage();

    expect(screen.getByRole("status")).toBeInTheDocument();
    expect(screen.queryByText(/invalid invite link/i)).not.toBeInTheDocument();
  });

  it("hides the spinner and shows the sign-up UI once isLoaded becomes true with a valid invite", async () => {
    mockUseAuth.mockReturnValue({ isLoaded: false, isSignedIn: false });
    sessionStorage.setItem(INVITE_TOKEN_KEY, VALID_TOKEN);
    mockFetch.mockResolvedValueOnce(validInviteResponse());

    const { rerender } = renderJoinPage();

    expect(screen.getByRole("status")).toBeInTheDocument();

    mockUseAuth.mockReturnValue({ isLoaded: true, isSignedIn: false });
    rerender(<JoinPage />);

    await waitFor(() => {
      expect(screen.queryByRole("status")).not.toBeInTheDocument();
      expect(screen.getByTestId("clerk-sign-up")).toBeInTheDocument();
    });
  });

  it("hides the spinner and shows 'Invalid invite link' once isLoaded becomes true with no token", async () => {
    mockUseAuth.mockReturnValue({ isLoaded: false, isSignedIn: false });

    const { rerender } = renderJoinPage();

    expect(screen.getByRole("status")).toBeInTheDocument();

    mockUseAuth.mockReturnValue({ isLoaded: true, isSignedIn: false });
    rerender(<JoinPage />);

    await waitFor(() => {
      expect(screen.queryByRole("status")).not.toBeInTheDocument();
      expect(screen.getByText(/invalid invite link/i)).toBeInTheDocument();
    });
  });
});

describe("JoinPage — spinner during invite claim (claimStatus: claiming)", () => {
  it("shows a spinner while the claim POST is in flight", async () => {
    sessionStorage.setItem(INVITE_TOKEN_KEY, VALID_TOKEN);
    mockUseAuth.mockReturnValue({ isLoaded: true, isSignedIn: true, getToken: mockGetToken });

    let resolveClaim!: (value: Response) => void;
    const pendingClaim = new Promise<Response>((resolve) => {
      resolveClaim = resolve;
    });

    mockFetch
      .mockResolvedValueOnce(validInviteResponse())
      .mockReturnValueOnce(pendingClaim);

    renderJoinPage();

    // Wait until the claim POST has been issued (second fetch call) — this
    // confirms we are specifically in the claimStatus === "claiming" state, not
    // the initial inviteStatus === "loading" state that also shows a spinner.
    await waitFor(() => {
      expect(mockFetch).toHaveBeenCalledTimes(2);
      expect(mockFetch).toHaveBeenLastCalledWith(
        expect.stringContaining("/api/invite/claim"),
        expect.objectContaining({ method: "POST" }),
      );
    });

    expect(screen.getByRole("status")).toBeInTheDocument();
    expect(screen.queryByTestId("clerk-sign-up")).not.toBeInTheDocument();
    expect(screen.queryByText(/invalid invite link/i)).not.toBeInTheDocument();

    resolveClaim(claimSuccessResponse());
  });

  it("hides the spinner and redirects to dashboard once the claim resolves", async () => {
    sessionStorage.setItem(INVITE_TOKEN_KEY, VALID_TOKEN);
    mockUseAuth.mockReturnValue({ isLoaded: true, isSignedIn: true, getToken: mockGetToken });

    mockFetch
      .mockResolvedValueOnce(validInviteResponse())
      .mockResolvedValueOnce(claimSuccessResponse());

    renderJoinPage();

    await waitFor(() => {
      expect(mockNavigate).toHaveBeenCalledWith("/devices");
    });

    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });
});

describe("JoinPage — sessionStorage cleanup after claim", () => {
  it("clears sessionStorage after a successful claim and navigates to dashboard", async () => {
    sessionStorage.setItem(INVITE_TOKEN_KEY, VALID_TOKEN);
    mockUseAuth.mockReturnValue({ isLoaded: true, isSignedIn: true, getToken: mockGetToken });
    mockFetch
      .mockResolvedValueOnce(validInviteResponse())
      .mockResolvedValueOnce(claimSuccessResponse());

    renderJoinPage();

    await waitFor(() => {
      expect(mockNavigate).toHaveBeenCalledWith("/devices");
    });

    expect(sessionStorage.getItem(INVITE_TOKEN_KEY)).toBeNull();
  });

  it("clears sessionStorage after an 'already member' claim and navigates to dashboard", async () => {
    sessionStorage.setItem(INVITE_TOKEN_KEY, VALID_TOKEN);
    mockUseAuth.mockReturnValue({ isLoaded: true, isSignedIn: true, getToken: mockGetToken });
    mockFetch
      .mockResolvedValueOnce(validInviteResponse())
      .mockResolvedValueOnce(claimAlreadyMemberResponse());

    renderJoinPage();

    await waitFor(() => {
      expect(mockNavigate).toHaveBeenCalledWith("/devices");
    });

    expect(sessionStorage.getItem(INVITE_TOKEN_KEY)).toBeNull();
  });

  it("clears sessionStorage and shows 'Wrong email' card on a 403 claim response", async () => {
    sessionStorage.setItem(INVITE_TOKEN_KEY, VALID_TOKEN);
    mockUseAuth.mockReturnValue({ isLoaded: true, isSignedIn: true, getToken: mockGetToken });
    mockFetch
      .mockResolvedValueOnce(validInviteResponse())
      .mockResolvedValueOnce(claimWrongEmailResponse());

    renderJoinPage();

    await waitFor(() => {
      expect(screen.getByText(/wrong email address/i)).toBeInTheDocument();
    });

    expect(sessionStorage.getItem(INVITE_TOKEN_KEY)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Helpers shared by the retry-backoff suite
// ---------------------------------------------------------------------------

/**
 * Flush all pending microtasks (resolved Promises + React state batches).
 */
async function flush() {
  await act(async () => {});
}

/**
 * Advance fake timers by `ms` milliseconds then drain the resulting
 * microtask queue so that any `await setTimeout(…)` inside the retry loop
 * has a chance to resume and commit React state updates.
 */
async function advanceAndFlush(ms: number) {
  act(() => {
    vi.advanceTimersByTime(ms);
  });
  await flush();
  await flush();
}

function claim401Response() {
  return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401 });
}

// ---------------------------------------------------------------------------
// Retry-backoff tests (vi.useFakeTimers)
// ---------------------------------------------------------------------------

describe("JoinPage — invite claim 401 silent retry", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    sessionStorage.setItem(INVITE_TOKEN_KEY, VALID_TOKEN);
    mockUseAuth.mockReturnValue({ isLoaded: true, isSignedIn: true, getToken: mockGetToken });
    history.pushState({}, "", "/join");
  });

  afterEach(() => {
    vi.useRealTimers();
    sessionStorage.clear();
    history.pushState({}, "", "/join");
  });

  it("navigates to /devices when the first attempt returns 401 and the second returns 200", async () => {
    mockFetch
      .mockResolvedValueOnce(validInviteResponse()) // GET /api/invite/:token
      .mockResolvedValueOnce(claim401Response())    // POST /api/invite/claim — attempt 0 → 401
      .mockResolvedValueOnce(claimSuccessResponse()); // POST /api/invite/claim — attempt 1 → 200

    renderJoinPage();

    // Drain the invite fetch (inviteStatus → valid) and the first claim attempt
    // (attempt 0 → 401 → 500 ms delay timer created).  Two act flushes are
    // sufficient because each resolves one level of the promise chain.
    await flush();
    await flush();

    // vi.runAllTimersAsync fires the 500 ms retry delay and then awaits the
    // resulting microtask queue, letting attempt(1) run to completion (200 OK →
    // claimStatus "claimed" → navigate effect fires).
    await act(async () => {
      await vi.runAllTimersAsync();
    });

    expect(mockNavigate).toHaveBeenCalledWith("/devices");
    // The "Session not ready" error card must never have been rendered.
    expect(screen.queryByText(/session not ready/i)).not.toBeInTheDocument();
  });

  it("shows the 'Session not ready' card after all three retries return 401", async () => {
    mockFetch
      .mockResolvedValueOnce(validInviteResponse()) // GET /api/invite/:token
      .mockResolvedValueOnce(claim401Response())    // attempt 0 → 401
      .mockResolvedValueOnce(claim401Response())    // attempt 1 → 401
      .mockResolvedValueOnce(claim401Response())    // attempt 2 → 401
      .mockResolvedValueOnce(claim401Response());   // attempt 3 → 401 (MAX_RETRIES exhausted)

    renderJoinPage();

    // Drain the invite fetch and first claim attempt (attempt 0 → 401 →
    // 500 ms delay timer created).
    await flush();
    await flush();

    // vi.runAllTimersAsync cascades through all three retry delays
    // (500 ms → 1 000 ms → 2 000 ms), firing each timer and awaiting the
    // resulting microtask chain before continuing to the next timer.
    // After attempt 3 also returns 401 the retry limit is hit and
    // claimStatus becomes "session_not_ready".
    await act(async () => {
      await vi.runAllTimersAsync();
    });

    expect(screen.getByText(/session not ready/i)).toBeInTheDocument();
    expect(mockNavigate).not.toHaveBeenCalledWith("/devices");
  });
});

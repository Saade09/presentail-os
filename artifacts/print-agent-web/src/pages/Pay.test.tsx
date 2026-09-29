import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, act, fireEvent } from "@testing-library/react";
import PayPage, {
  CHECK_AGAIN_ERROR_DISMISS_MS,
  NAV_TIMEOUT_MS,
  getGoogleClickAttribution,
} from "./Pay";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockUseParams = vi.fn();
const mockUseSearch = vi.fn();
const pixelMocks = vi.hoisted(() => ({
  initPixels: vi.fn(),
  trackInitiateCheckout: vi.fn(),
  trackPurchase: vi.fn(),
  hasFiredPurchase: vi.fn(() => false),
  markPurchaseFired: vi.fn(),
}));
vi.mock("wouter", () => ({
  useParams: () => mockUseParams(),
  useSearch: () => mockUseSearch(),
}));
vi.mock("@/lib/pixels", () => pixelMocks);

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeResponse(data: object, status = 200) {
  return new Response(JSON.stringify(data), { status });
}

function activeLink() {
  return {
    id: 1,
    amount: 2500,
    currency: "USD",
    provider: "stripe",
    description: "Test payment",
    country: "Lebanon",
    status: "active",
    checkout_url: "https://checkout.stripe.com/test",
    created_at: "2024-01-01T00:00:00Z",
    paid_at: null,
  };
}

function paidLink() {
  return {
    ...activeLink(),
    status: "paid",
    paid_at: "2024-01-01T00:01:00Z",
  };
}

/**
 * Flush all pending microtasks (resolved Promises + React state batches).
 * Calling this once after an async boundary is usually enough to drain a
 * single level of promise chain; call it twice when there is a nested await
 * inside the callback that triggered the update.
 */
async function flush() {
  await act(async () => {});
}

/**
 * Advance fake timers by `ms` milliseconds, then flush the resulting
 * microtask queue so that any `await fetch(...)` callbacks inside the
 * timed-out function have a chance to run and commit React state updates.
 */
async function advanceAndFlush(ms: number) {
  act(() => {
    vi.advanceTimersByTime(ms);
  });
  await flush();
  await flush();
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  mockUseParams.mockReturnValue({ token: "tok_test" });
  mockUseSearch.mockReturnValue("");
});

afterEach(() => {
  vi.useRealTimers();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Google click attribution", () => {
  it.each([
    ["?gclid=google-click", { gclid: "google-click" }],
    ["?gbraid=ios-click", { gbraid: "ios-click" }],
    ["?wbraid=web-click", { wbraid: "web-click" }],
    ["?foo=bar", null],
  ])("extracts the supported identifier from %s", (search, expected) => {
    expect(getGoogleClickAttribution(search)).toEqual(expected);
  });
});

describe("PayPage – polling behaviour", () => {
  // -------------------------------------------------------------------------
  // Polling does NOT start in various baseline conditions
  // -------------------------------------------------------------------------

  it("does NOT start polling when ?paid=1 is absent, even if status is active", async () => {
    mockUseSearch.mockReturnValue("");
    mockFetch.mockResolvedValueOnce(makeResponse(activeLink()));

    render(<PayPage />);
    await flush();

    expect(
      screen.queryByText(/confirming your payment/i),
    ).not.toBeInTheDocument();

    await advanceAndFlush(3000);

    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("does NOT start polling when ?paid=1 is present but status is already 'paid'", async () => {
    mockUseSearch.mockReturnValue("?paid=1");
    mockFetch.mockResolvedValueOnce(makeResponse(paidLink()));

    render(<PayPage />);
    await flush();

    expect(
      screen.queryByText(/confirming your payment/i),
    ).not.toBeInTheDocument();

    await advanceAndFlush(3000);

    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("routes a confirmed paid return using the payment link destination", async () => {
    mockUseSearch.mockReturnValue("?paid=1");
    mockFetch.mockResolvedValueOnce(makeResponse(paidLink()));

    render(<PayPage />);
    await flush();

    expect(pixelMocks.trackPurchase).toHaveBeenCalledWith(
      2500,
      "USD",
      "tok_test",
      "Lebanon",
    );
    expect(pixelMocks.markPurchaseFired).toHaveBeenCalledWith("tok_test");
  });

  it("keeps the per-token session deduplication guard", async () => {
    pixelMocks.hasFiredPurchase.mockReturnValueOnce(true);
    mockUseSearch.mockReturnValue("?paid=1");
    mockFetch.mockResolvedValueOnce(makeResponse(paidLink()));

    render(<PayPage />);
    await flush();

    expect(pixelMocks.hasFiredPurchase).toHaveBeenCalledWith("tok_test");
    expect(pixelMocks.trackPurchase).not.toHaveBeenCalled();
    expect(pixelMocks.markPurchaseFired).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // Pending banner shown while polling is in progress
  // -------------------------------------------------------------------------

  it("shows the pending banner immediately after the initial fetch when ?paid=1 and status is 'active'", async () => {
    mockUseSearch.mockReturnValue("?paid=1");
    mockFetch.mockResolvedValueOnce(makeResponse(activeLink()));

    render(<PayPage />);
    await flush();

    expect(
      screen.getByText(/confirming your payment/i),
    ).toBeInTheDocument();
  });

  it("keeps the pending banner visible while the status remains 'active' across poll ticks", async () => {
    mockUseSearch.mockReturnValue("?paid=1");
    mockFetch
      .mockResolvedValueOnce(makeResponse(activeLink()))
      .mockResolvedValueOnce(makeResponse(activeLink()));

    render(<PayPage />);
    await flush();

    expect(screen.getByText(/confirming your payment/i)).toBeInTheDocument();

    await advanceAndFlush(3000);

    expect(screen.getByText(/confirming your payment/i)).toBeInTheDocument();
    expect(screen.queryByText(/payment successful/i)).not.toBeInTheDocument();
  });

  // -------------------------------------------------------------------------
  // Polling stops once status becomes "paid"
  // -------------------------------------------------------------------------

  it("hides the pending banner and shows the success banner when a poll returns 'paid'", async () => {
    mockUseSearch.mockReturnValue("?paid=1");
    mockFetch
      .mockResolvedValueOnce(makeResponse(activeLink()))
      .mockResolvedValueOnce(makeResponse(paidLink()));

    render(<PayPage />);
    await flush();

    expect(screen.getByText(/confirming your payment/i)).toBeInTheDocument();

    await advanceAndFlush(3000);

    expect(
      screen.queryByText(/confirming your payment/i),
    ).not.toBeInTheDocument();
    expect(screen.getByText(/payment successful/i)).toBeInTheDocument();
  });

  it("makes no further fetch calls after polling confirms 'paid'", async () => {
    mockUseSearch.mockReturnValue("?paid=1");
    mockFetch
      .mockResolvedValueOnce(makeResponse(activeLink()))
      .mockResolvedValueOnce(makeResponse(paidLink()));

    render(<PayPage />);
    await flush();
    await advanceAndFlush(3000);

    expect(mockFetch).toHaveBeenCalledTimes(2);

    await advanceAndFlush(3000);
    await advanceAndFlush(3000);

    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  // -------------------------------------------------------------------------
  // 30-second timeout → "Still processing" banner
  // -------------------------------------------------------------------------

  it("shows the 'Still processing' banner after the 30-second timeout elapses", async () => {
    mockUseSearch.mockReturnValue("?paid=1");
    mockFetch.mockImplementation(() => Promise.resolve(makeResponse(activeLink())));

    render(<PayPage />);
    await flush();

    expect(screen.getByText(/confirming your payment/i)).toBeInTheDocument();
    expect(screen.queryByText(/still processing/i)).not.toBeInTheDocument();

    await advanceAndFlush(30000);

    expect(screen.getByText(/still processing/i)).toBeInTheDocument();
    expect(
      screen.queryByText(/confirming your payment/i),
    ).not.toBeInTheDocument();
  });

  it("does not show the 'Still processing' banner before 30 seconds have elapsed", async () => {
    mockUseSearch.mockReturnValue("?paid=1");
    mockFetch.mockImplementation(() => Promise.resolve(makeResponse(activeLink())));

    render(<PayPage />);
    await flush();

    await advanceAndFlush(29999);

    expect(screen.queryByText(/still processing/i)).not.toBeInTheDocument();
    expect(screen.getByText(/confirming your payment/i)).toBeInTheDocument();
  });

  it("makes no further fetch calls after the polling timeout fires", async () => {
    mockUseSearch.mockReturnValue("?paid=1");
    mockFetch.mockImplementation(() => Promise.resolve(makeResponse(activeLink())));

    render(<PayPage />);
    await flush();
    await advanceAndFlush(30000);

    expect(screen.getByText(/still processing/i)).toBeInTheDocument();
    const countAfterTimeout = mockFetch.mock.calls.length;

    await advanceAndFlush(3000);
    await advanceAndFlush(3000);

    expect(mockFetch.mock.calls.length).toBe(countAfterTimeout);
  });

  // -------------------------------------------------------------------------
  // Resilience: retry on fetch error
  // -------------------------------------------------------------------------

  it("retries polling on the next tick when a mid-poll fetch error occurs", async () => {
    mockUseSearch.mockReturnValue("?paid=1");
    mockFetch
      .mockResolvedValueOnce(makeResponse(activeLink()))
      .mockRejectedValueOnce(new Error("Network error"))
      .mockResolvedValueOnce(makeResponse(paidLink()));

    render(<PayPage />);
    await flush();

    expect(screen.getByText(/confirming your payment/i)).toBeInTheDocument();

    await advanceAndFlush(3000);

    expect(screen.getByText(/confirming your payment/i)).toBeInTheDocument();

    await advanceAndFlush(3000);

    expect(screen.getByText(/payment successful/i)).toBeInTheDocument();
    expect(
      screen.queryByText(/confirming your payment/i),
    ).not.toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// Helpers for visibilitychange tests
// ---------------------------------------------------------------------------

/**
 * Simulate the browser switching the document's visibility state and
 * dispatching the matching DOM event.
 */
function fireVisibilityChange(state: "visible" | "hidden") {
  Object.defineProperty(document, "visibilityState", {
    value: state,
    writable: true,
    configurable: true,
  });
  document.dispatchEvent(new Event("visibilitychange"));
}

// ---------------------------------------------------------------------------
// Tab-return / visibilitychange re-check tests
// ---------------------------------------------------------------------------

describe("PayPage – tab-return payment re-check (visibilitychange)", () => {
  // -------------------------------------------------------------------------
  // Fetch IS triggered when polling timed out and payment is unconfirmed
  // -------------------------------------------------------------------------

  it("triggers a re-check fetch when the tab becomes visible after polling has timed out", async () => {
    mockUseSearch.mockReturnValue("?paid=1");
    // Initial fetch → active (starts polling). All subsequent poll ticks also
    // return active so the 30-second deadline fires.
    mockFetch.mockImplementation(() => Promise.resolve(makeResponse(activeLink())));

    render(<PayPage />);
    await flush();

    // Advance past the polling deadline so pollingTimedOut becomes true.
    await advanceAndFlush(30000);
    expect(screen.getByText(/still processing/i)).toBeInTheDocument();

    const fetchCountAfterTimeout = mockFetch.mock.calls.length;

    // The next call (re-check) should return active as well.
    mockFetch.mockResolvedValueOnce(makeResponse(activeLink()));

    // Simulate the user returning to the tab.
    await act(async () => {
      fireVisibilityChange("visible");
      await flush();
    });

    // Exactly one extra fetch should have been made.
    expect(mockFetch.mock.calls.length).toBe(fetchCountAfterTimeout + 1);
  });

  it("clears the 'Still processing' banner and shows success when the re-check returns 'paid'", async () => {
    mockUseSearch.mockReturnValue("?paid=1");
    mockFetch.mockImplementation(() => Promise.resolve(makeResponse(activeLink())));

    render(<PayPage />);
    await flush();
    await advanceAndFlush(30000);

    expect(screen.getByText(/still processing/i)).toBeInTheDocument();

    // On tab return the payment has now been confirmed.
    mockFetch.mockResolvedValueOnce(makeResponse(paidLink()));

    await act(async () => {
      fireVisibilityChange("visible");
      await flush();
    });

    expect(screen.queryByText(/still processing/i)).not.toBeInTheDocument();
    expect(screen.getByText(/payment successful/i)).toBeInTheDocument();
  });

  // -------------------------------------------------------------------------
  // Fetch is NOT triggered when payment is already confirmed
  // -------------------------------------------------------------------------

  it("does NOT trigger a re-check fetch when the tab becomes visible but payment is already confirmed", async () => {
    mockUseSearch.mockReturnValue("?paid=1");
    // First poll tick returns paid, so polling stops immediately.
    mockFetch
      .mockResolvedValueOnce(makeResponse(activeLink()))
      .mockResolvedValueOnce(makeResponse(paidLink()));

    render(<PayPage />);
    await flush();
    await advanceAndFlush(3000);

    expect(screen.getByText(/payment successful/i)).toBeInTheDocument();

    const fetchCountAfterPaid = mockFetch.mock.calls.length;

    await act(async () => {
      fireVisibilityChange("visible");
      await flush();
    });

    // No additional fetch should have been made.
    expect(mockFetch.mock.calls.length).toBe(fetchCountAfterPaid);
  });

  // -------------------------------------------------------------------------
  // Fetch is NOT triggered when polling is still in progress (not timed out)
  // -------------------------------------------------------------------------

  it("does NOT trigger a re-check fetch when the tab becomes visible while polling is still in progress", async () => {
    mockUseSearch.mockReturnValue("?paid=1");
    mockFetch.mockImplementation(() => Promise.resolve(makeResponse(activeLink())));

    render(<PayPage />);
    await flush();

    // Only advance partway through the polling window — not enough to time out.
    await advanceAndFlush(9000);

    expect(screen.getByText(/confirming your payment/i)).toBeInTheDocument();
    expect(screen.queryByText(/still processing/i)).not.toBeInTheDocument();

    const fetchCountMidPoll = mockFetch.mock.calls.length;

    await act(async () => {
      fireVisibilityChange("visible");
      await flush();
    });

    // visibilitychange should not have added any extra fetch beyond normal polling.
    expect(mockFetch.mock.calls.length).toBe(fetchCountMidPoll);
  });

  // -------------------------------------------------------------------------
  // Listener is NOT attached when ?paid=1 is absent
  // -------------------------------------------------------------------------

  it("does NOT trigger a re-check fetch on visibilitychange when ?paid=1 is absent", async () => {
    mockUseSearch.mockReturnValue("");
    mockFetch.mockResolvedValueOnce(makeResponse(activeLink()));

    render(<PayPage />);
    await flush();

    const fetchCountAfterLoad = mockFetch.mock.calls.length;

    await act(async () => {
      fireVisibilityChange("visible");
      await flush();
    });

    expect(mockFetch.mock.calls.length).toBe(fetchCountAfterLoad);
  });
});

// ---------------------------------------------------------------------------
// "Check again" retry-flow tests
// ---------------------------------------------------------------------------

describe("PayPage – Check again retry flow", () => {
  /**
   * Helper: render the page with ?paid=1, let it reach the 30-second timeout
   * so the "Still processing" / "Check again" state is active.
   */
  async function renderAndTimeout() {
    mockUseSearch.mockReturnValue("?paid=1");
    // Initial fetch returns active; every subsequent poll also returns active
    mockFetch.mockImplementation(() => Promise.resolve(makeResponse(activeLink())));

    render(<PayPage />);
    await flush();

    // Let the 30-second deadline fire so pollingTimedOut becomes true
    await advanceAndFlush(30000);

    expect(screen.getByText(/still processing/i)).toBeInTheDocument();
  }

  it("shows the 'Check again' button after the polling timeout elapses", async () => {
    await renderAndTimeout();

    expect(
      screen.getByRole("button", { name: /check again/i }),
    ).toBeInTheDocument();
  });

  it("shows the success banner when 'Check again' is clicked and the server returns 'paid'", async () => {
    await renderAndTimeout();

    // Next fetch returns paid
    mockFetch.mockResolvedValueOnce(makeResponse(paidLink()));

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /check again/i }));
    });

    expect(screen.getByText(/payment successful/i)).toBeInTheDocument();
    expect(screen.queryByText(/still processing/i)).not.toBeInTheDocument();
  });

  it("leaves the 'Still processing' banner in place when 'Check again' is clicked and payment is still unpaid", async () => {
    await renderAndTimeout();

    // Next fetch still returns active (not paid)
    mockFetch.mockResolvedValueOnce(makeResponse(activeLink()));

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /check again/i }));
    });

    expect(screen.getByText(/still processing/i)).toBeInTheDocument();
    expect(screen.queryByText(/payment successful/i)).not.toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// Auto-redirect behaviour
// ---------------------------------------------------------------------------

describe("PayPage – auto-redirect to checkout_url", () => {
  let originalLocation: Location;

  beforeEach(() => {
    originalLocation = window.location;
    // Replace window.location with a plain writable object so we can spy on
    // href assignments without triggering a real navigation in jsdom.
    Object.defineProperty(window, "location", {
      value: { href: "" },
      writable: true,
      configurable: true,
    });
  });

  afterEach(() => {
    Object.defineProperty(window, "location", {
      value: originalLocation,
      writable: true,
      configurable: true,
    });
  });

  it("sets window.location.href to checkout_url when the link is active and ?paid=1 is absent", async () => {
    mockUseSearch.mockReturnValue("");
    mockFetch.mockResolvedValueOnce(makeResponse(activeLink()));

    render(<PayPage />);
    await flush();

    expect(window.location.href).toBe("https://checkout.stripe.com/test");
  });

  it("does NOT redirect when ?paid=1 is present and the link is active", async () => {
    mockUseSearch.mockReturnValue("?paid=1");
    mockFetch.mockResolvedValueOnce(makeResponse(activeLink()));

    render(<PayPage />);
    await flush();

    expect(window.location.href).toBe("");
  });

  it("does NOT redirect when the link status is 'expired'", async () => {
    mockUseSearch.mockReturnValue("");
    mockFetch.mockResolvedValueOnce(
      makeResponse({ ...activeLink(), status: "expired", checkout_url: null }),
    );

    render(<PayPage />);
    await flush();

    expect(window.location.href).toBe("");
  });

  it("does NOT redirect when the link status is already 'paid' and ?paid=1 is absent", async () => {
    mockUseSearch.mockReturnValue("");
    mockFetch.mockResolvedValueOnce(makeResponse(paidLink()));

    render(<PayPage />);
    await flush();

    expect(window.location.href).toBe("");
  });

  it("does NOT redirect when the link is active but checkout_url is null", async () => {
    mockUseSearch.mockReturnValue("");
    mockFetch.mockResolvedValueOnce(
      makeResponse({ ...activeLink(), checkout_url: null }),
    );

    render(<PayPage />);
    await flush();

    expect(window.location.href).toBe("");
  });
});

// ---------------------------------------------------------------------------
// Static rendering states (expired / paid / error)
// ---------------------------------------------------------------------------

describe("PayPage – static rendering states", () => {
  it("shows 'no longer active' text for an expired link without ?paid=1", async () => {
    mockUseSearch.mockReturnValue("");
    mockFetch.mockResolvedValueOnce(
      makeResponse({ ...activeLink(), status: "expired", checkout_url: null }),
    );

    render(<PayPage />);
    await flush();

    expect(
      screen.getByText(/no longer active/i),
    ).toBeInTheDocument();
    expect(screen.queryByText(/pay.*now/i)).not.toBeInTheDocument();
  });

  it("shows payment received state for an already-paid link without ?paid=1", async () => {
    mockUseSearch.mockReturnValue("");
    mockFetch.mockResolvedValueOnce(makeResponse(paidLink()));

    render(<PayPage />);
    await flush();

    expect(screen.getByText(/payment received/i)).toBeInTheDocument();
    expect(screen.queryByText(/pay.*now/i)).not.toBeInTheDocument();
  });

  it("renders the error card when the fetch returns a non-OK response", async () => {
    mockUseSearch.mockReturnValue("");
    mockFetch.mockResolvedValueOnce(
      makeResponse({ error: "Not found" }, 404),
    );

    render(<PayPage />);
    await flush();

    expect(
      screen.getByText(/this link isn't available/i),
    ).toBeInTheDocument();
  });

  it("renders the error card when the fetch rejects with a network error", async () => {
    mockUseSearch.mockReturnValue("");
    mockFetch.mockRejectedValueOnce(new Error("Network error"));

    render(<PayPage />);
    await flush();

    expect(
      screen.getByText(/this link isn't available/i),
    ).toBeInTheDocument();
  });

  it("shows the pending confirmation banner for an active link when ?paid=1 is present (redirect suppressed)", async () => {
    mockUseSearch.mockReturnValue("?paid=1");
    mockFetch.mockImplementation(() => Promise.resolve(makeResponse(activeLink())));

    render(<PayPage />);
    await flush();

    // No redirect should have occurred; instead the pending confirmation
    // banner should be visible while polling is underway.
    expect(screen.getByText(/confirming your payment/i)).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// "Check again" error handling
// ---------------------------------------------------------------------------

describe("PayPage – 'Check again' error handling", () => {
  it("shows a friendly inline error when the re-check request fails and keeps the 'Still processing' banner", async () => {
    mockUseSearch.mockReturnValue("?paid=1");
    // Initial fetch + all poll ticks return active so the 30-second deadline fires.
    mockFetch.mockImplementation(() => Promise.resolve(makeResponse(activeLink())));

    render(<PayPage />);
    await flush();
    await advanceAndFlush(30000);

    expect(screen.getByText(/still processing/i)).toBeInTheDocument();

    // The re-check call fails with a network error.
    mockFetch.mockRejectedValueOnce(new Error("Network error"));

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /check again/i }));
      await flush();
    });

    // The "Still processing" banner must still be visible.
    expect(screen.getByText(/still processing/i)).toBeInTheDocument();

    // A friendly error message should appear near the button.
    expect(
      screen.getByRole("alert"),
    ).toHaveTextContent(/couldn't reach the server/i);
  });

  it("clears the error message when a subsequent 'Check again' succeeds", async () => {
    mockUseSearch.mockReturnValue("?paid=1");
    mockFetch.mockImplementation(() => Promise.resolve(makeResponse(activeLink())));

    render(<PayPage />);
    await flush();
    await advanceAndFlush(30000);

    expect(screen.getByText(/still processing/i)).toBeInTheDocument();

    // First re-check: fails.
    mockFetch.mockRejectedValueOnce(new Error("Network error"));
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /check again/i }));
      await flush();
    });

    expect(screen.getByRole("alert")).toBeInTheDocument();

    // Second re-check: succeeds (still active, not yet paid).
    mockFetch.mockResolvedValueOnce(makeResponse(activeLink()));
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /check again/i }));
      await flush();
    });

    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("auto-clears the error message after CHECK_AGAIN_ERROR_DISMISS_MS without any user interaction", async () => {
    mockUseSearch.mockReturnValue("?paid=1");
    mockFetch.mockImplementation(() => Promise.resolve(makeResponse(activeLink())));

    render(<PayPage />);
    await flush();
    await advanceAndFlush(30000);

    // Trigger a failing re-check.
    mockFetch.mockRejectedValueOnce(new Error("Network error"));
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /check again/i }));
      await flush();
    });

    expect(screen.getByRole("alert")).toBeInTheDocument();

    // Just under the dismiss delay — error should still be visible.
    await advanceAndFlush(CHECK_AGAIN_ERROR_DISMISS_MS - 1);
    expect(screen.getByRole("alert")).toBeInTheDocument();

    // At the dismiss delay — error should have been cleared.
    await advanceAndFlush(1);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("cancels the auto-clear timer when 'Check again' is clicked again before it fires", async () => {
    mockUseSearch.mockReturnValue("?paid=1");
    mockFetch.mockImplementation(() => Promise.resolve(makeResponse(activeLink())));

    render(<PayPage />);
    await flush();
    await advanceAndFlush(30000);

    // First re-check: fails, starting the auto-clear timer.
    mockFetch.mockRejectedValueOnce(new Error("Network error"));
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /check again/i }));
      await flush();
    });

    expect(screen.getByRole("alert")).toBeInTheDocument();

    // Click again before the dismiss delay fires — second call also fails.
    mockFetch.mockRejectedValueOnce(new Error("Network error"));
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /check again/i }));
      await flush();
    });

    // Error is still visible (new timer has started from this second click).
    expect(screen.getByRole("alert")).toBeInTheDocument();

    // Advance past where the *first* timer would have fired (dismiss delay from first click).
    // The original timer should have been cancelled, so the error should persist
    // until the second timer fires at the dismiss delay after the second click.
    await advanceAndFlush(CHECK_AGAIN_ERROR_DISMISS_MS - 1);
    expect(screen.getByRole("alert")).toBeInTheDocument();

    // At the dismiss delay after the second click the error clears.
    await advanceAndFlush(1);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// "Pay now" button
// ---------------------------------------------------------------------------

describe("PayPage – 'Pay now' button", () => {
  let originalLocation: Location;

  beforeEach(() => {
    originalLocation = window.location;
    // Replace window.location with a plain writable object so href assignments
    // don't trigger real navigation in jsdom.
    Object.defineProperty(window, "location", {
      value: { href: "" },
      writable: true,
      configurable: true,
    });
  });

  afterEach(() => {
    Object.defineProperty(window, "location", {
      value: originalLocation,
      writable: true,
      configurable: true,
    });
  });

  it("waits for click attribution to be persisted before redirecting", async () => {
    Object.defineProperty(window, "location", {
      value: { href: "", search: "?gclid=google-click-123" },
      writable: true,
      configurable: true,
    });
    let acknowledgeAttribution!: (response: Response) => void;
    const attributionResponse = new Promise<Response>((resolve) => {
      acknowledgeAttribution = resolve;
    });
    mockFetch
      .mockResolvedValueOnce(makeResponse({
        ...activeLink(),
        sender_submitted_at: "2026-08-30T10:00:00Z",
      }))
      .mockReturnValueOnce(attributionResponse);

    render(<PayPage />);
    await flush();
    const payButton = screen.getByRole("button", { name: /^pay \$25\.00$/i });

    fireEvent.click(payButton);
    await flush();

    expect(window.location.href).toBe("");
    expect(mockFetch).toHaveBeenLastCalledWith(
      expect.stringContaining("/api/pay/tok_test/attribution"),
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ gclid: "google-click-123" }),
        keepalive: true,
      }),
    );

    acknowledgeAttribution(makeResponse({ ok: true }));
    await flush();
    expect(window.location.href).toBe("https://checkout.stripe.com/test");
  });

  it("sets window.location.href to checkout_url when clicked", async () => {
    // Use ?paid=1 + polling timeout so the button is visible without
    // auto-redirect interfering (auto-redirect only fires when ?paid=1 is absent).
    mockUseSearch.mockReturnValue("?paid=1");
    mockFetch.mockImplementation(() =>
      Promise.resolve(makeResponse(activeLink())),
    );

    render(<PayPage />);
    await flush();

    // Advance past the 30-second deadline so pollingTimedOut becomes true and
    // the "Pay now" button is rendered instead of the spinner.
    await advanceAndFlush(30000);

    const payButton = screen.getByRole("button", { name: /pay.*now/i });
    expect(payButton).toBeInTheDocument();

    await act(async () => {
      fireEvent.click(payButton);
    });

    expect(window.location.href).toBe("https://checkout.stripe.com/test");
  });

  it("is disabled when checkout_url is null", async () => {
    // With checkout_url null and no ?paid=1, auto-redirect does not fire
    // (the redirect guard checks for a non-null url).
    mockUseSearch.mockReturnValue("");
    mockFetch.mockResolvedValueOnce(
      makeResponse({ ...activeLink(), checkout_url: null }),
    );

    render(<PayPage />);
    await flush();

    const payButton = screen.getByRole("button", { name: /pay.*now/i });
    expect(payButton).toBeDisabled();
  });

  it("is NOT rendered while ?paid=1 is present and the 30-second polling timeout has not yet elapsed", async () => {
    mockUseSearch.mockReturnValue("?paid=1");
    mockFetch.mockImplementation(() =>
      Promise.resolve(makeResponse(activeLink())),
    );

    render(<PayPage />);
    await flush();

    // Spinner should be visible; Pay now button must be absent.
    expect(screen.getByText(/verifying payment/i)).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /pay.*now/i }),
    ).not.toBeInTheDocument();

    // Advance partway through the polling window — still before the timeout.
    await advanceAndFlush(15000);

    expect(screen.getByText(/verifying payment/i)).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /pay.*now/i }),
    ).not.toBeInTheDocument();
  });

  it("IS rendered (and the spinner is absent) after the 30-second polling timeout fires", async () => {
    mockUseSearch.mockReturnValue("?paid=1");
    mockFetch.mockImplementation(() =>
      Promise.resolve(makeResponse(activeLink())),
    );

    render(<PayPage />);
    await flush();

    // Before timeout: spinner visible, button absent.
    expect(screen.getByText(/verifying payment/i)).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /pay.*now/i }),
    ).not.toBeInTheDocument();

    // Advance past the 30-second deadline.
    await advanceAndFlush(30000);

    // After timeout: button visible, spinner absent.
    expect(
      screen.getByRole("button", { name: /pay.*now/i }),
    ).toBeInTheDocument();
    expect(screen.queryByText(/verifying payment/i)).not.toBeInTheDocument();
  });

  it("is disabled immediately after the first click to prevent duplicate checkout sessions", async () => {
    mockUseSearch.mockReturnValue("?paid=1");
    mockFetch.mockImplementation(() =>
      Promise.resolve(makeResponse(activeLink())),
    );

    render(<PayPage />);
    await flush();

    // Advance past the 30-second deadline so the "Pay now" button is visible.
    await advanceAndFlush(30000);

    const payButton = screen.getByRole("button", { name: /pay.*now/i });
    expect(payButton).not.toBeDisabled();

    await act(async () => {
      fireEvent.click(payButton);
    });

    // The button must be disabled after the first click.
    expect(payButton).toBeDisabled();
  });

  it("re-enables the button when the page is restored from bfcache (pageshow with persisted=true)", async () => {
    mockUseSearch.mockReturnValue("?paid=1");
    mockFetch.mockImplementation(() =>
      Promise.resolve(makeResponse(activeLink())),
    );

    render(<PayPage />);
    await flush();

    // Advance past the 30-second deadline so the "Pay now" button is visible.
    await advanceAndFlush(30000);

    const payButton = screen.getByRole("button", { name: /pay.*now/i });
    expect(payButton).not.toBeDisabled();

    // Simulate clicking "Pay now" — button enters disabled/loading state.
    await act(async () => {
      fireEvent.click(payButton);
    });
    expect(payButton).toBeDisabled();

    // Simulate the browser restoring the page from bfcache (back-forward cache).
    await act(async () => {
      const event = new Event("pageshow") as PageTransitionEvent;
      Object.defineProperty(event, "persisted", { value: true });
      window.dispatchEvent(event);
    });

    // The button must be re-enabled so the user can retry.
    expect(payButton).not.toBeDisabled();
  });

  it("does NOT re-enable the button on a normal pageshow (persisted=false)", async () => {
    mockUseSearch.mockReturnValue("?paid=1");
    mockFetch.mockImplementation(() =>
      Promise.resolve(makeResponse(activeLink())),
    );

    render(<PayPage />);
    await flush();
    await advanceAndFlush(30000);

    const payButton = screen.getByRole("button", { name: /pay.*now/i });

    await act(async () => {
      fireEvent.click(payButton);
    });
    expect(payButton).toBeDisabled();

    // A non-persisted pageshow (normal page load) must not reset the state.
    await act(async () => {
      const event = new Event("pageshow") as PageTransitionEvent;
      Object.defineProperty(event, "persisted", { value: false });
      window.dispatchEvent(event);
    });

    expect(payButton).toBeDisabled();
  });

  it("re-enables the button when window.location.href assignment throws (e.g. network/security error)", async () => {
    mockUseSearch.mockReturnValue("?paid=1");
    mockFetch.mockImplementation(() =>
      Promise.resolve(makeResponse(activeLink())),
    );

    render(<PayPage />);
    await flush();
    await advanceAndFlush(30000);

    // Make href assignment throw to simulate a failed navigation.
    Object.defineProperty(window, "location", {
      value: {
        get href() {
          return "";
        },
        set href(_: string) {
          throw new Error("Navigation failed");
        },
      },
      writable: true,
      configurable: true,
    });

    const payButton = screen.getByRole("button", { name: /pay.*now/i });
    expect(payButton).not.toBeDisabled();

    await act(async () => {
      fireEvent.click(payButton);
    });

    // The button must be re-enabled after the throw so the user can retry.
    expect(payButton).not.toBeDisabled();
  });

  it("re-enables the button after NAV_TIMEOUT_MS if the redirect never fires", async () => {
    mockUseSearch.mockReturnValue("?paid=1");
    mockFetch.mockImplementation(() =>
      Promise.resolve(makeResponse(activeLink())),
    );

    render(<PayPage />);
    await flush();
    await advanceAndFlush(30000);

    const payButton = screen.getByRole("button", { name: /pay.*now/i });
    expect(payButton).not.toBeDisabled();

    await act(async () => {
      fireEvent.click(payButton);
    });

    // Immediately after click the button should be disabled (spinner showing).
    expect(payButton).toBeDisabled();

    // Just under the timeout — still disabled.
    await advanceAndFlush(NAV_TIMEOUT_MS - 1);
    expect(payButton).toBeDisabled();

    // At the timeout — button must be re-enabled.
    await advanceAndFlush(1);
    expect(payButton).not.toBeDisabled();
  });
});

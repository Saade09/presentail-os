import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createElement } from "react";
import { useOmnichannelSSE, HEARTBEAT_TIMEOUT_MS } from "./useOmnichannelSSE";

// A single stable mock function — must not be recreated per render.
// useOmnichannelSSE stores getToken in a ref (getTokenRef) and reads it via
// getTokenRef.current() so that the `connect` useCallback never needs getToken
// in its dependency array.  However, if the mock itself returned a *new*
// function reference on every render the ref update (getTokenRef.current =
// getToken) would still be safe, but a fresh getToken identity on each call to
// useAuth() could mask bugs in hypothetical future refactors.  Keeping a single
// stable reference here also mirrors the guarantee the production Clerk hook
// provides: the same function object persists across unrelated re-renders.
const stableGetToken = vi.fn().mockResolvedValue("tok");

vi.mock("@clerk/react", () => ({
  useAuth: () => ({ getToken: stableGetToken }),
}));

// ---------------------------------------------------------------------------
// Controllable fetch mock
// ---------------------------------------------------------------------------

interface MockConnection {
  url: string;
  signal: AbortSignal;
  /** Make fetch resolve successfully — SSE stream stays open indefinitely */
  triggerOpen(): void;
  /** Make fetch reject with a network error — triggers scheduleRetry */
  triggerError(err?: Error): void;
  /** Close the stream (reader.read returns done=true) — triggers scheduleRetry */
  triggerStreamEnd(): void;
  /** Push a raw chunk of bytes into the stream */
  pushChunk(text: string): void;
}

let connections: MockConnection[] = [];

function setupFetchMock() {
  vi.stubGlobal(
    "fetch",
    (url: string, init?: RequestInit): Promise<Response> => {
      return new Promise<Response>((resolveFetch, rejectFetch) => {
        // eslint-disable-next-line prefer-const
        let streamCtrl!: ReadableStreamDefaultController<Uint8Array>;
        const body = new ReadableStream<Uint8Array>({
          start(ctrl) {
            streamCtrl = ctrl;
          },
        });

        const conn: MockConnection = {
          url,
          signal: init?.signal as AbortSignal,
          triggerOpen() {
            // When the controller is aborted (e.g. by the heartbeat watchdog),
            // close the ReadableStream so reader.read() resolves {done:true}.
            // This mirrors real browser behaviour where aborting the fetch
            // causes the stream to end.
            init?.signal?.addEventListener("abort", () => {
              try {
                streamCtrl.close();
              } catch {
                // already closed — ignore
              }
            });
            resolveFetch(new Response(body, { status: 200 }));
          },
          triggerError(err = new Error("Network error")) {
            rejectFetch(err);
          },
          triggerStreamEnd() {
            streamCtrl.close();
          },
          pushChunk(text: string) {
            const encoder = new TextEncoder();
            streamCtrl.enqueue(encoder.encode(text));
          },
        };

        connections.push(conn);
      });
    },
  );
}

// ---------------------------------------------------------------------------
// Timer mock
//
// We directly replace globalThis.setTimeout / clearTimeout without calling
// vi.useFakeTimers().  That way React 19's act() does NOT detect a fake-timer
// environment and won't call runAllTimers(), so our pending timers only fire
// when we explicitly call fireNextTimer().
//
// We use a very high starting ID (1_000_000) to avoid accidental collisions
// with any real browser/Node timer IDs that might be in flight.
// ---------------------------------------------------------------------------

type TimerEntry = {
  id: ReturnType<typeof setTimeout>;
  delay: number;
  fn: () => void;
};

let pendingTimers: TimerEntry[] = [];
let _nextTimerId = 1_000_000;

let _originalSetTimeout: typeof globalThis.setTimeout;
let _originalClearTimeout: typeof globalThis.clearTimeout;

function setupTimerMock() {
  _originalSetTimeout = globalThis.setTimeout;
  _originalClearTimeout = globalThis.clearTimeout;

  (globalThis as Record<string, unknown>).setTimeout = (
    fn: TimerHandler,
    delay?: number,
  ) => {
    const id = (_nextTimerId++) as unknown as ReturnType<typeof setTimeout>;
    pendingTimers.push({ id, delay: delay ?? 0, fn: fn as () => void });
    return id;
  };

  (globalThis as Record<string, unknown>).clearTimeout = (
    id?: ReturnType<typeof setTimeout>,
  ) => {
    pendingTimers = pendingTimers.filter((t) => t.id !== id);
  };
}

function teardownTimerMock() {
  (globalThis as Record<string, unknown>).setTimeout = _originalSetTimeout;
  (globalThis as Record<string, unknown>).clearTimeout = _originalClearTimeout;
}

/** Fire the oldest pending timer (simulates that its delay has elapsed). */
function fireNextTimer() {
  const t = pendingTimers.shift();
  t?.fn();
}

/** Fire the timer with the given delay (first match). */
function fireTimerWithDelay(delay: number) {
  const idx = pendingTimers.findIndex((t) => t.delay === delay);
  if (idx === -1) throw new Error(`No timer with delay ${delay} found`);
  const [t] = pendingTimers.splice(idx, 1);
  t.fn();
}

// ---------------------------------------------------------------------------
// Wrapper
// ---------------------------------------------------------------------------

function makeWrapper() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return ({ children }: { children: React.ReactNode }) =>
    createElement(QueryClientProvider, { client: qc }, children);
}

/** Flush pending microtasks and React state updates. */
const flushPromises = () => act(async () => {});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("useOmnichannelSSE reconnect behaviour", () => {
  beforeEach(() => {
    connections = [];
    pendingTimers = [];
    _nextTimerId = 1_000_000;
    setupFetchMock();
    setupTimerMock();
  });

  afterEach(() => {
    teardownTimerMock();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("connects immediately on mount and calls fetch once", async () => {
    const { unmount } = renderHook(() => useOmnichannelSSE(), {
      wrapper: makeWrapper(),
    });

    await flushPromises(); // flush getToken then fetch

    expect(connections).toHaveLength(1);
    expect(connections[0].url).toBe("/api/omnichannel/events");
    expect(connections[0].signal).toBeDefined();
    unmount();
  });

  it("sets reconnecting=true and schedules a retry after MIN_DELAY_MS (2 s) on error", async () => {
    const { result, unmount } = renderHook(() => useOmnichannelSSE(), {
      wrapper: makeWrapper(),
    });

    await flushPromises(); // connections[0] is now pending

    expect(result.current.reconnecting).toBe(false);

    act(() => {
      connections[0].triggerError();
    });
    await flushPromises(); // flush rejection handling → scheduleRetry called

    expect(result.current.reconnecting).toBe(true);

    // Retry timer queued with 2 s delay — verify delay and that no new
    // connection exists yet (timer has not fired)
    expect(pendingTimers).toHaveLength(1);
    expect(pendingTimers[0].delay).toBe(2_000);
    expect(connections).toHaveLength(1);

    // Fire the timer → connect() runs → new fetch call
    act(() => {
      fireNextTimer();
    });
    await flushPromises();
    expect(connections).toHaveLength(2);

    unmount();
  });

  it("doubles the retry delay on each consecutive error (exponential back-off)", async () => {
    const { unmount } = renderHook(() => useOmnichannelSSE(), {
      wrapper: makeWrapper(),
    });

    await flushPromises(); // connections[0] pending

    // First error → delay = 2 s
    act(() => {
      connections[0].triggerError();
    });
    await flushPromises();
    expect(pendingTimers[0].delay).toBe(2_000);

    act(() => {
      fireNextTimer();
    });
    await flushPromises(); // connections[1] pending
    expect(connections).toHaveLength(2);

    // Second error → delay should now be 4 s
    act(() => {
      connections[1].triggerError();
    });
    await flushPromises();
    expect(pendingTimers[0].delay).toBe(4_000);

    act(() => {
      fireNextTimer();
    });
    await flushPromises(); // connections[2] pending
    expect(connections).toHaveLength(3);

    unmount();
  });

  it("clears the pending retry timer when the component unmounts mid-retry", async () => {
    const { unmount } = renderHook(() => useOmnichannelSSE(), {
      wrapper: makeWrapper(),
    });

    await flushPromises(); // connections[0] pending

    act(() => {
      connections[0].triggerError();
    });
    await flushPromises(); // retry timer queued

    expect(pendingTimers).toHaveLength(1);

    // Unmount before the timer fires — cleanup should clear the timer
    unmount();

    // Timer was cleared via clearTimeout
    expect(pendingTimers).toHaveLength(0);

    // Even if we manually fire any residual callback, no new connection appears
    act(() => {
      fireNextTimer();
    });
    await flushPromises();
    expect(connections).toHaveLength(1);
  });

  it("resets reconnecting to false when the new connection opens successfully", async () => {
    const { result, unmount } = renderHook(() => useOmnichannelSSE(), {
      wrapper: makeWrapper(),
    });

    await flushPromises(); // connections[0] pending

    // Trigger error and wait for retry connection
    act(() => {
      connections[0].triggerError();
    });
    await flushPromises();
    expect(result.current.reconnecting).toBe(true);

    act(() => {
      fireNextTimer();
    });
    await flushPromises(); // connections[1] pending
    expect(connections).toHaveLength(2);

    // Open the second connection
    act(() => {
      connections[1].triggerOpen();
    });
    await flushPromises();

    expect(result.current.reconnecting).toBe(false);

    unmount();
  });

  it("resets the retry delay back to 2 s after a successful open", async () => {
    const { unmount } = renderHook(() => useOmnichannelSSE(), {
      wrapper: makeWrapper(),
    });

    await flushPromises(); // connections[0] pending

    // First error → retry → second connection opens successfully
    act(() => {
      connections[0].triggerError();
    });
    await flushPromises();
    act(() => {
      fireNextTimer();
    });
    await flushPromises(); // connections[1] pending
    act(() => {
      connections[1].triggerOpen();
    });
    await flushPromises(); // hook reading stream; retryDelay reset to 2 s

    // End the stream → scheduleRetry → delay should be back to 2 s
    act(() => {
      connections[1].triggerStreamEnd();
    });
    await flushPromises();
    // The retry timer is 2 s; heartbeat timer (60 s) was cleared on stream end
    expect(pendingTimers.some((t) => t.delay === 2_000)).toBe(true);

    // Fire that timer → third connection
    act(() => {
      fireTimerWithDelay(2_000);
    });
    await flushPromises();
    expect(connections).toHaveLength(3);

    unmount();
  });

  it("aborts the fetch connection on unmount", async () => {
    const { unmount } = renderHook(() => useOmnichannelSSE(), {
      wrapper: makeWrapper(),
    });

    await flushPromises(); // connections[0] pending

    const firstSignal = connections[0].signal;
    expect(firstSignal.aborted).toBe(false);

    unmount();

    expect(firstSignal.aborted).toBe(true);
  });

  // -------------------------------------------------------------------------
  // Heartbeat watchdog tests
  // -------------------------------------------------------------------------

  it("schedules a heartbeat watchdog timer (HEARTBEAT_TIMEOUT_MS) when the stream opens", async () => {
    const { unmount } = renderHook(() => useOmnichannelSSE(), {
      wrapper: makeWrapper(),
    });

    await flushPromises(); // connections[0] pending

    act(() => {
      connections[0].triggerOpen();
    });
    await flushPromises(); // stream open; heartbeat timer scheduled

    expect(pendingTimers.some((t) => t.delay === HEARTBEAT_TIMEOUT_MS)).toBe(true);

    unmount();
  });

  it("fires the heartbeat watchdog when no data arrives → aborts and schedules a reconnect", async () => {
    const { result, unmount } = renderHook(() => useOmnichannelSSE(), {
      wrapper: makeWrapper(),
    });

    await flushPromises(); // connections[0] pending

    act(() => {
      connections[0].triggerOpen();
    });
    await flushPromises(); // stream open; heartbeat timer queued

    expect(result.current.reconnecting).toBe(false);

    // Fire the heartbeat watchdog (simulates 60 s of silence)
    act(() => {
      fireTimerWithDelay(HEARTBEAT_TIMEOUT_MS);
    });
    await flushPromises(); // AbortError propagated → scheduleRetry called

    expect(result.current.reconnecting).toBe(true);
    // Retry timer (2 s) queued
    expect(pendingTimers.some((t) => t.delay === 2_000)).toBe(true);

    unmount();
  });

  it("reconnects after the retry timer fires following a heartbeat timeout", async () => {
    const { unmount } = renderHook(() => useOmnichannelSSE(), {
      wrapper: makeWrapper(),
    });

    await flushPromises(); // connections[0] pending

    act(() => {
      connections[0].triggerOpen();
    });
    await flushPromises();

    // Fire heartbeat watchdog → schedules retry
    act(() => {
      fireTimerWithDelay(HEARTBEAT_TIMEOUT_MS);
    });
    await flushPromises();

    // Fire the retry timer → new fetch
    act(() => {
      fireTimerWithDelay(2_000);
    });
    await flushPromises();

    expect(connections).toHaveLength(2);

    unmount();
  });

  it("resets the heartbeat watchdog when data arrives on the stream", async () => {
    const { unmount } = renderHook(() => useOmnichannelSSE(), {
      wrapper: makeWrapper(),
    });

    await flushPromises(); // connections[0] pending

    act(() => {
      connections[0].triggerOpen();
    });
    await flushPromises(); // first heartbeat timer scheduled

    // Record the ID of the first heartbeat timer
    const firstHeartbeatTimer = pendingTimers.find(
      (t) => t.delay === HEARTBEAT_TIMEOUT_MS,
    );
    expect(firstHeartbeatTimer).toBeDefined();
    const firstId = firstHeartbeatTimer!.id;

    // Push a chunk (e.g. a heartbeat comment from the server)
    act(() => {
      connections[0].pushChunk(": heartbeat\n\n");
    });
    await flushPromises(); // chunk processed; watchdog reset

    // The old timer was replaced — the new one has a different ID
    const newHeartbeatTimer = pendingTimers.find(
      (t) => t.delay === HEARTBEAT_TIMEOUT_MS,
    );
    expect(newHeartbeatTimer).toBeDefined();
    expect(newHeartbeatTimer!.id).not.toBe(firstId);

    unmount();
  });

  it("clears the heartbeat watchdog timer on unmount", async () => {
    const { unmount } = renderHook(() => useOmnichannelSSE(), {
      wrapper: makeWrapper(),
    });

    await flushPromises(); // connections[0] pending

    act(() => {
      connections[0].triggerOpen();
    });
    await flushPromises(); // stream open; heartbeat timer queued

    expect(pendingTimers.some((t) => t.delay === HEARTBEAT_TIMEOUT_MS)).toBe(true);

    unmount();

    // All timers (including the heartbeat one) should be cleared
    expect(pendingTimers.some((t) => t.delay === HEARTBEAT_TIMEOUT_MS)).toBe(false);
  });
});

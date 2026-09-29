import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";

// A single stable mock function — mirrors the guarantee the production Clerk
// hook provides (the hook keeps getToken in a ref anyway).
const stableGetToken = vi.fn();

vi.mock("@clerk/react", () => ({
  useAuth: () => ({ getToken: stableGetToken }),
}));

import { useAuthedSse, HEARTBEAT_TIMEOUT_MS } from "./use-authed-sse";

// ---------------------------------------------------------------------------
// Controllable fetch mock
// ---------------------------------------------------------------------------

interface MockConnection {
  url: string;
  headers: Record<string, string>;
  signal: AbortSignal;
  triggerOpen(): void;
  triggerResponse(response: Response): void;
  triggerError(err?: Error): void;
  triggerStreamEnd(): void;
  pushChunk(text: string): void;
}

let connections: MockConnection[] = [];

function setupFetchMock() {
  vi.stubGlobal(
    "fetch",
    (url: string, init?: RequestInit): Promise<Response> => {
      return new Promise<Response>((resolveFetch, rejectFetch) => {
        let streamCtrl!: ReadableStreamDefaultController<Uint8Array>;
        const body = new ReadableStream<Uint8Array>({
          start(ctrl) {
            streamCtrl = ctrl;
          },
        });

        const conn: MockConnection = {
          url,
          headers: (init?.headers ?? {}) as Record<string, string>,
          signal: init?.signal as AbortSignal,
          triggerOpen() {
            // Aborting the fetch closes the stream so reader.read() resolves
            // { done: true }, mirroring real browser behaviour.
            init?.signal?.addEventListener("abort", () => {
              try {
                streamCtrl.close();
              } catch {
                // already closed — ignore
              }
            });
            resolveFetch(new Response(body, { status: 200 }));
          },
          triggerResponse(response) {
            resolveFetch(response);
          },
          triggerError(err = new Error("Network error")) {
            rejectFetch(err);
          },
          triggerStreamEnd() {
            streamCtrl.close();
          },
          pushChunk(text: string) {
            streamCtrl.enqueue(new TextEncoder().encode(text));
          },
        };

        connections.push(conn);
      });
    },
  );
}

// ---------------------------------------------------------------------------
// Timer mock — replace setTimeout/clearTimeout directly (no vi.useFakeTimers,
// so React act() does not auto-run timers). Timers only fire when we call
// fireNextTimer().
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

/** Flush pending microtasks and React state updates. */
const flushPromises = () => act(async () => {});

const URL = "/api/events";

function jwtWithExp(exp: number): string {
  const payload = btoa(JSON.stringify({ exp }))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
  return `e30.${payload}.signature`;
}

describe("useAuthedSse", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    connections = [];
    pendingTimers = [];
    stableGetToken.mockResolvedValue("tok-1");
    setupFetchMock();
    setupTimerMock();
  });

  afterEach(() => {
    teardownTimerMock();
    vi.unstubAllGlobals();
  });

  it("does not connect when enabled is false", async () => {
    renderHook(() => useAuthedSse(URL, false, {}));
    await flushPromises();

    expect(stableGetToken).not.toHaveBeenCalled();
    expect(connections).toHaveLength(0);
  });

  it("connects with an Authorization: Bearer header carrying the Clerk token", async () => {
    const { unmount } = renderHook(() => useAuthedSse(URL, true, {}));
    await flushPromises();

    expect(connections).toHaveLength(1);
    expect(connections[0].url).toBe(URL);
    expect(connections[0].headers).toEqual({ Authorization: "Bearer tok-1" });

    unmount();
  });

  it("bypasses Clerk's token cache when the returned JWT is near expiry", async () => {
    stableGetToken
      .mockResolvedValueOnce(jwtWithExp(Math.floor(Date.now() / 1000) + 5))
      .mockResolvedValueOnce("tok-fresh");

    const { unmount } = renderHook(() => useAuthedSse(URL, true, {}));
    await flushPromises();

    expect(stableGetToken).toHaveBeenNthCalledWith(1, undefined);
    expect(stableGetToken).toHaveBeenNthCalledWith(2, { skipCache: true });
    expect(connections).toHaveLength(1);
    expect(connections[0].headers).toEqual({
      Authorization: "Bearer tok-fresh",
    });

    unmount();
  });

  it("dispatches named events to the matching handler with the raw data text", async () => {
    const onOrderCreated = vi.fn();
    const { unmount } = renderHook(() =>
      useAuthedSse(URL, true, { "order.created": onOrderCreated }),
    );
    await flushPromises();

    act(() => connections[0].triggerOpen());
    await flushPromises();

    act(() => {
      connections[0].pushChunk(
        'event: order.created\ndata: {"data":{"id":"o1"}}\n\n',
      );
    });
    await flushPromises();

    expect(onOrderCreated).toHaveBeenCalledTimes(1);
    expect(onOrderCreated).toHaveBeenCalledWith('{"data":{"id":"o1"}}');

    unmount();
  });

  it("ignores events that have no registered handler and heartbeat comments", async () => {
    const onChanged = vi.fn();
    const { unmount } = renderHook(() =>
      useAuthedSse(URL, true, { changed: onChanged }),
    );
    await flushPromises();

    act(() => connections[0].triggerOpen());
    await flushPromises();

    act(() => {
      connections[0].pushChunk(": heartbeat\n\n");
      connections[0].pushChunk("event: unrelated\ndata: {}\n\n");
      connections[0].pushChunk("event: changed\ndata: {}\n\n");
    });
    await flushPromises();

    expect(onChanged).toHaveBeenCalledTimes(1);

    unmount();
  });

  it("handles events split across multiple chunks", async () => {
    const onChanged = vi.fn();
    const { unmount } = renderHook(() =>
      useAuthedSse(URL, true, { changed: onChanged }),
    );
    await flushPromises();

    act(() => connections[0].triggerOpen());
    await flushPromises();

    act(() => {
      connections[0].pushChunk("event: chan");
      connections[0].pushChunk("ged\ndata: 1");
      connections[0].pushChunk("23\n\n");
    });
    await flushPromises();

    expect(onChanged).toHaveBeenCalledTimes(1);
    expect(onChanged).toHaveBeenCalledWith("123");

    unmount();
  });

  it("retries with backoff and a FRESH token after a network error", async () => {
    stableGetToken
      .mockResolvedValueOnce("tok-1")
      .mockResolvedValueOnce("tok-2");

    const { unmount } = renderHook(() => useAuthedSse(URL, true, {}));
    await flushPromises();

    act(() => connections[0].triggerError());
    await flushPromises();

    // A retry timer was scheduled with the minimum delay (2 s)
    expect(pendingTimers).toHaveLength(1);
    expect(pendingTimers[0].delay).toBe(2_000);

    act(() => fireNextTimer());
    await flushPromises();

    expect(connections).toHaveLength(2);
    expect(stableGetToken).toHaveBeenCalledTimes(2);
    expect(connections[1].headers).toEqual({ Authorization: "Bearer tok-2" });

    unmount();
  });

  it("doubles the retry delay on consecutive failures and caps at 30 s", async () => {
    const { unmount } = renderHook(() => useAuthedSse(URL, true, {}));
    await flushPromises();

    const expectedDelays = [2_000, 4_000, 8_000, 16_000, 30_000, 30_000];
    for (let i = 0; i < expectedDelays.length; i++) {
      act(() => connections[i].triggerError());
      await flushPromises();
      expect(pendingTimers[0]?.delay).toBe(expectedDelays[i]);
      act(() => fireNextTimer());
      await flushPromises();
    }

    unmount();
  });

  it("forces a fresh token after an HTTP 401 before retrying the stream", async () => {
    stableGetToken
      .mockResolvedValueOnce("tok-expired")
      .mockResolvedValueOnce("tok-fresh");

    const { unmount } = renderHook(() => useAuthedSse(URL, true, {}));
    await flushPromises();

    act(() => connections[0].triggerResponse(new Response(null, { status: 401 })));
    await flushPromises();

    expect(pendingTimers).toHaveLength(1);
    expect(pendingTimers[0].delay).toBe(2_000);

    act(() => fireNextTimer());
    await flushPromises();

    expect(stableGetToken).toHaveBeenNthCalledWith(1, undefined);
    expect(stableGetToken).toHaveBeenNthCalledWith(2, { skipCache: true });
    expect(connections).toHaveLength(2);
    expect(connections[1].headers).toEqual({
      Authorization: "Bearer tok-fresh",
    });

    unmount();
  });

  it("reconnects when the server closes the stream", async () => {
    const { unmount } = renderHook(() => useAuthedSse(URL, true, {}));
    await flushPromises();

    act(() => connections[0].triggerOpen());
    await flushPromises();

    act(() => connections[0].triggerStreamEnd());
    await flushPromises();

    expect(pendingTimers.some((t) => t.delay === 2_000)).toBe(true);
    act(() => fireNextTimer());
    await flushPromises();

    expect(connections).toHaveLength(2);

    unmount();
  });

  it("schedules a retry when no token is available", async () => {
    stableGetToken.mockResolvedValueOnce(null);

    const { unmount } = renderHook(() => useAuthedSse(URL, true, {}));
    await flushPromises();

    expect(connections).toHaveLength(0);
    expect(pendingTimers).toHaveLength(1);
    expect(pendingTimers[0].delay).toBe(2_000);

    unmount();
  });

  it("aborts the connection via the heartbeat watchdog when the stream goes silent", async () => {
    const { unmount } = renderHook(() => useAuthedSse(URL, true, {}));
    await flushPromises();

    act(() => connections[0].triggerOpen());
    await flushPromises();

    // The heartbeat watchdog timer is pending
    const watchdog = pendingTimers.find((t) => t.delay === HEARTBEAT_TIMEOUT_MS);
    expect(watchdog).toBeDefined();

    // Fire it — the controller aborts, the stream closes, and a reconnect is scheduled
    act(() => {
      pendingTimers = pendingTimers.filter((t) => t !== watchdog);
      watchdog!.fn();
    });
    await flushPromises();

    expect(connections[0].signal.aborted).toBe(true);
    expect(pendingTimers.some((t) => t.delay === 2_000)).toBe(true);

    unmount();
  });

  it("aborts the in-flight connection and cancels timers on unmount", async () => {
    const { unmount } = renderHook(() => useAuthedSse(URL, true, {}));
    await flushPromises();

    act(() => connections[0].triggerOpen());
    await flushPromises();

    unmount();
    await flushPromises();

    expect(connections[0].signal.aborted).toBe(true);
    expect(pendingTimers).toHaveLength(0);
  });

  it("closes the connection when enabled flips from true to false", async () => {
    const { rerender } = renderHook(
      ({ enabled }: { enabled: boolean }) => useAuthedSse(URL, enabled, {}),
      { initialProps: { enabled: true } },
    );
    await flushPromises();

    act(() => connections[0].triggerOpen());
    await flushPromises();

    rerender({ enabled: false });
    await flushPromises();

    expect(connections[0].signal.aborted).toBe(true);
  });

  it("a throwing handler does not kill the stream", async () => {
    const onChanged = vi.fn(() => {
      throw new Error("boom");
    });
    const { unmount } = renderHook(() =>
      useAuthedSse(URL, true, { changed: onChanged }),
    );
    await flushPromises();

    act(() => connections[0].triggerOpen());
    await flushPromises();

    act(() => {
      connections[0].pushChunk("event: changed\ndata: {}\n\n");
      connections[0].pushChunk("event: changed\ndata: {}\n\n");
    });
    await flushPromises();

    expect(onChanged).toHaveBeenCalledTimes(2);
    // No retry scheduled besides the heartbeat watchdog — connection is alive
    expect(pendingTimers.filter((t) => t.delay === 2_000)).toHaveLength(0);

    unmount();
  });

  it("uses the latest handlers without reconnecting when the handlers object changes", async () => {
    const first = vi.fn();
    const second = vi.fn();

    const { rerender, unmount } = renderHook(
      ({ handler }: { handler: (d: string) => void }) =>
        useAuthedSse(URL, true, { changed: handler }),
      { initialProps: { handler: first } },
    );
    await flushPromises();

    act(() => connections[0].triggerOpen());
    await flushPromises();

    rerender({ handler: second });
    await flushPromises();

    // No reconnect happened
    expect(connections).toHaveLength(1);

    act(() => {
      connections[0].pushChunk("event: changed\ndata: {}\n\n");
    });
    await flushPromises();

    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);

    unmount();
  });
});

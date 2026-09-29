import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockInvalidateQueries = vi.fn();
const mockApiFetch = vi.fn().mockResolvedValue({ requests: [] });

vi.mock("@/lib/queryClient", () => ({
  apiFetch: (...args: unknown[]) => mockApiFetch(...args),
  queryClient: {
    invalidateQueries: (...args: unknown[]) => mockInvalidateQueries(...args),
  },
}));

vi.mock("@tanstack/react-query", () => ({
  useQuery: vi.fn().mockReturnValue({ data: undefined, isLoading: false }),
}));

// ---------------------------------------------------------------------------
// Mock of the shared authed-SSE helper. It records each active subscription
// so tests can assert on the URL, emit events, and observe teardown (the
// real helper aborts its fetch stream when the effect cleans up).
// ---------------------------------------------------------------------------

interface SseSubscription {
  url: string;
  handlers: Record<string, (data: string) => void>;
  closed: boolean;
}

const { sseState } = vi.hoisted(() => ({
  sseState: { subs: [] as SseSubscription[] },
}));

vi.mock("@/hooks/use-authed-sse", async () => {
  const { useEffect } = await import("react");
  return {
    useAuthedSse: (
      url: string,
      enabled: boolean,
      handlers: Record<string, (data: string) => void>,
    ) => {
      useEffect(() => {
        if (!enabled) return;
        const sub: SseSubscription = { url, handlers, closed: false };
        sseState.subs.push(sub);
        return () => {
          sub.closed = true;
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [url, enabled]);
      const active = sseState.subs.find((s) => s.url === url && !s.closed);
      if (active) active.handlers = handlers;
    },
  };
});

beforeEach(() => {
  vi.clearAllMocks();
  sseState.subs = [];
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

import { usePendingAccessRequests } from "./use-pending-access-requests";

function emit(event: string) {
  const active = sseState.subs.find((s) => !s.closed);
  active?.handlers[event]?.("{}");
}

describe("usePendingAccessRequests – stream lifecycle", () => {
  it("does not open a stream when enabled is false", () => {
    renderHook(() => usePendingAccessRequests(false));
    expect(sseState.subs).toHaveLength(0);
  });

  it("opens a stream pointing at /api/access-requests/events when enabled is true", () => {
    renderHook(() => usePendingAccessRequests(true));
    expect(sseState.subs).toHaveLength(1);
    expect(sseState.subs[0].url).toBe("/api/access-requests/events");
  });

  it("closes the stream when the hook unmounts", () => {
    const { unmount } = renderHook(() => usePendingAccessRequests(true));
    unmount();
    expect(sseState.subs[0].closed).toBe(true);
  });

  it("closes the stream when enabled changes from true to false", () => {
    const { rerender } = renderHook(
      ({ enabled }: { enabled: boolean }) => usePendingAccessRequests(enabled),
      { initialProps: { enabled: true } },
    );

    rerender({ enabled: false });

    expect(sseState.subs[0].closed).toBe(true);
  });
});

describe("usePendingAccessRequests – cache invalidation on SSE events", () => {
  it("calls queryClient.invalidateQueries with the access-requests key when a 'changed' event is received", () => {
    renderHook(() => usePendingAccessRequests(true));

    act(() => {
      emit("changed");
    });

    expect(mockInvalidateQueries).toHaveBeenCalledTimes(1);
    expect(mockInvalidateQueries).toHaveBeenCalledWith({ queryKey: ["access-requests"] });
  });

  it("calls invalidateQueries each time a 'changed' event is received", () => {
    renderHook(() => usePendingAccessRequests(true));

    act(() => {
      emit("changed");
      emit("changed");
      emit("changed");
    });

    expect(mockInvalidateQueries).toHaveBeenCalledTimes(3);
  });

  it("does not call invalidateQueries for events other than 'changed'", () => {
    renderHook(() => usePendingAccessRequests(true));

    act(() => {
      emit("open");
      emit("message");
    });

    expect(mockInvalidateQueries).not.toHaveBeenCalled();
  });

  it("does not call invalidateQueries when enabled is false (no stream was opened)", () => {
    renderHook(() => usePendingAccessRequests(false));

    expect(sseState.subs).toHaveLength(0);
    expect(mockInvalidateQueries).not.toHaveBeenCalled();
  });
});

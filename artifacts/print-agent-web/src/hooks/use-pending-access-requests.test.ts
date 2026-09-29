import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";

const { mockInvalidateQueries } = vi.hoisted(() => ({
  mockInvalidateQueries: vi.fn(),
}));

vi.mock("@/lib/queryClient", () => ({
  apiFetch: vi.fn(),
  queryClient: { invalidateQueries: mockInvalidateQueries },
}));

vi.mock("@tanstack/react-query", () => ({
  useQuery: vi.fn().mockReturnValue({ data: undefined }),
}));

// ---------------------------------------------------------------------------
// Mock of the shared authed-SSE helper. The transport itself (Bearer token,
// reconnect, heartbeat) is covered in use-authed-sse.test.ts; here we only
// verify the hook wires up the right stream + handlers.
// ---------------------------------------------------------------------------

interface SseInstance {
  url: string;
  handlers: Record<string, (data: string) => void>;
}

const { sseState } = vi.hoisted(() => ({
  sseState: { instances: [] as SseInstance[] },
}));

vi.mock("@/hooks/use-authed-sse", () => ({
  useAuthedSse: (
    url: string,
    enabled: boolean,
    handlers: Record<string, (data: string) => void>,
  ) => {
    if (!enabled) return;
    const existing = sseState.instances.find((i) => i.url === url);
    if (existing) {
      existing.handlers = handlers;
    } else {
      sseState.instances.push({ url, handlers });
    }
  },
}));

import { useQuery } from "@tanstack/react-query";
import {
  usePendingAccessRequests,
  usePendingAccessRequestCount,
} from "./use-pending-access-requests";

function emit(event: string) {
  sseState.instances[0]?.handlers[event]?.("{}");
}

describe("usePendingAccessRequests — SSE listener", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sseState.instances = [];
  });

  it("calls queryClient.invalidateQueries with the access-requests key when a changed event is received", () => {
    renderHook(() => usePendingAccessRequests(true));

    expect(sseState.instances).toHaveLength(1);
    expect(sseState.instances[0].url).toBe("/api/access-requests/events");

    act(() => {
      emit("changed");
    });

    expect(mockInvalidateQueries).toHaveBeenCalledTimes(1);
    expect(mockInvalidateQueries).toHaveBeenCalledWith({
      queryKey: ["access-requests"],
    });
  });

  it("does not open a stream when enabled is false", () => {
    renderHook(() => usePendingAccessRequests(false));

    expect(sseState.instances).toHaveLength(0);
    expect(mockInvalidateQueries).not.toHaveBeenCalled();
  });

  it("invalidates the query once per changed event and not for unrelated events", () => {
    renderHook(() => usePendingAccessRequests(true));

    act(() => {
      emit("changed");
      emit("changed");
    });

    expect(mockInvalidateQueries).toHaveBeenCalledTimes(2);

    act(() => {
      emit("unrelated");
    });

    expect(mockInvalidateQueries).toHaveBeenCalledTimes(2);
  });
});

describe("usePendingAccessRequestCount — missing/partial data", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sseState.instances = [];
  });

  it("returns 0 when query data is undefined", () => {
    vi.mocked(useQuery).mockReturnValueOnce({
      data: undefined,
    } as ReturnType<typeof useQuery>);

    const { result } = renderHook(() => usePendingAccessRequestCount(true));

    expect(result.current).toBe(0);
  });

  it("returns 0 when query data has no requests field", () => {
    vi.mocked(useQuery).mockReturnValueOnce({
      data: {} as never,
    } as ReturnType<typeof useQuery>);

    const { result } = renderHook(() => usePendingAccessRequestCount(true));

    expect(result.current).toBe(0);
  });

  it("returns 0 when requests array is empty", () => {
    vi.mocked(useQuery).mockReturnValueOnce({
      data: { requests: [] },
    } as ReturnType<typeof useQuery>);

    const { result } = renderHook(() => usePendingAccessRequestCount(true));

    expect(result.current).toBe(0);
  });

  it("returns the correct count when requests is populated", () => {
    vi.mocked(useQuery).mockReturnValueOnce({
      data: { requests: [{ id: 1 }, { id: 2 }, { id: 3 }] },
    } as ReturnType<typeof useQuery>);

    const { result } = renderHook(() => usePendingAccessRequestCount(true));

    expect(result.current).toBe(3);
  });
});

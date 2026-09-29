import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  useTypeAssignment,
  type TypeAssignmentState,
} from "./use-type-assignment";

const { mockApiFetch } = vi.hoisted(() => ({
  mockApiFetch: vi.fn(),
}));

vi.mock("@/lib/queryClient", () => ({
  apiFetch: mockApiFetch,
}));

const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

const loadedOptions = (overrides: Partial<Parameters<typeof useTypeAssignment>[0]> = {}) => ({
  isLoaded: true,
  userId: "user_123",
  userType: null,
  reload: vi.fn().mockResolvedValue({
    publicMetadata: { userType: "team" },
  }),
  ...overrides,
});

beforeEach(() => {
  vi.clearAllMocks();
});

describe("useTypeAssignment", () => {
  it("leaves the loading state when reload replaces the Clerk user object", async () => {
    const assignment = deferred<unknown>();
    const reloadResult = deferred<{
      publicMetadata: { userType: string };
    }>();
    const reload = vi.fn().mockReturnValue(reloadResult.promise);
    mockApiFetch.mockReturnValue(assignment.promise);

    const options = loadedOptions({ reload });
    const { result, rerender } = renderHook(
      (currentOptions) => useTypeAssignment(currentOptions),
      { initialProps: options },
    );

    expect(result.current.status).toBe("assigning");

    await act(async () => {
      assignment.resolve({ assigned: true, userType: "team" });
      await assignment.promise;
      await waitFor(() => expect(reload).toHaveBeenCalledTimes(1));
      // Simulate Clerk replacing the user object after reload. The hook only
      // receives stable primitives, so this must not restart the assignment.
      rerender({
        ...options,
        reload: vi.fn().mockResolvedValue({
          publicMetadata: { userType: "team" },
        }),
        userType: "team",
      });
      reloadResult.resolve({ publicMetadata: { userType: "team" } });
    });

    await waitFor(() => {
      expect(result.current.status).toBe("ready");
    });
    expect(mockApiFetch).toHaveBeenCalledTimes(1);
  });

  it("does not run assignment for an existing userType", async () => {
    const { result } = renderHook(() =>
      useTypeAssignment(loadedOptions({ userType: "team" })),
    );

    await waitFor(() => expect(result.current.status).toBe("ready"));
    expect(mockApiFetch).not.toHaveBeenCalled();
  });

  it("uses a bounded auth-loading state while Clerk is not loaded", () => {
    const { result } = renderHook(() =>
      useTypeAssignment(loadedOptions({ isLoaded: false })),
    );

    expect(result.current).toEqual<TypeAssignmentState>({
      status: "auth-loading",
      error: null,
    });
    expect(mockApiFetch).not.toHaveBeenCalled();
  });

  it("enters an error state when assignment times out", async () => {
    vi.useFakeTimers();
    try {
      mockApiFetch.mockReturnValue(new Promise(() => {}));
      const { result } = renderHook(() => useTypeAssignment(loadedOptions()));

      expect(result.current.status).toBe("assigning");
      await act(async () => {
        await vi.advanceTimersByTimeAsync(15_000);
      });

      expect(result.current.status).toBe("error");
      expect(result.current.error).toContain("timed out");
    } finally {
      vi.useRealTimers();
    }
  });

  it("enters an error state when assignment fails", async () => {
    mockApiFetch.mockRejectedValue(new Error("HTTP 500"));
    const { result } = renderHook(() => useTypeAssignment(loadedOptions()));

    await waitFor(() => {
      expect(result.current.status).toBe("error");
    });
    expect(result.current.error).toBe("HTTP 500");
  });

  it("enters an error state when reload fails", async () => {
    mockApiFetch.mockResolvedValue({ assigned: true, userType: "team" });
    const { result } = renderHook(() =>
      useTypeAssignment(
        loadedOptions({
          reload: vi.fn().mockRejectedValue(new Error("reload failed")),
        }),
      ),
    );

    await waitFor(() => {
      expect(result.current.status).toBe("error");
    });
    expect(result.current.error).toBe("reload failed");
  });

  it("enters an error state when metadata is still missing after reload", async () => {
    mockApiFetch.mockResolvedValue({ assigned: true, userType: "team" });
    const { result } = renderHook(() =>
      useTypeAssignment(
        loadedOptions({
          reload: vi.fn().mockResolvedValue({
            publicMetadata: {},
          }),
        }),
      ),
    );

    await waitFor(() => {
      expect(result.current.status).toBe("error");
    });
    expect(result.current.error).toContain("updated session was not available");
  });
});

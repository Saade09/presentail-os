import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getRegisteredAuthToken: vi.fn(),
}));

vi.mock("@workspace/api-client-react", () => ({
  getRegisteredAuthToken: mocks.getRegisteredAuthToken,
}));

import { apiFetch } from "./queryClient";

describe("apiFetch request deadlines", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mocks.getRegisteredAuthToken.mockResolvedValue("test-token");
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it("rejects a stalled bootstrap request with an actionable timeout error", async () => {
    const fetchMock = vi.fn(
      (_url: string, options?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          options?.signal?.addEventListener("abort", () => {
            reject(new DOMException("The request was aborted", "AbortError"));
          });
        }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const request = apiFetch("/api/users", { timeoutMs: 15_000 });
    const timeoutAssertion = expect(request).rejects.toMatchObject({
      message: "The request took too long. Please reload the page and try again.",
      code: "request_timeout",
      url: "/api/users",
    });
    await vi.advanceTimersByTimeAsync(15_000);

    await timeoutAssertion;
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/users",
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: "Bearer test-token",
        }),
      }),
    );
  });
});
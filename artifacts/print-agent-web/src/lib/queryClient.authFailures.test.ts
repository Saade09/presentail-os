import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getRegisteredAuthToken: vi.fn(),
}));

vi.mock("@workspace/api-client-react", () => ({
  getRegisteredAuthToken: mocks.getRegisteredAuthToken,
}));

import { apiFetch, observeApiAuthFailures, on401 } from "./queryClient";

describe("observeApiAuthFailures", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it("reports stale Clerk sessions from every same-origin API fetch", async () => {
    const listener = vi.fn();
    const unsubscribe = on401(listener);
    const response = new Response(
      JSON.stringify({ error: "Unauthorized", code: "stale_clerk_session" }),
      { status: 401, headers: { "Content-Type": "application/json" } },
    );
    const fetchMock = vi.fn().mockResolvedValue(response);
    const observedFetch = observeApiAuthFailures(fetchMock);

    const returned = await observedFetch("/api/products/482");
    await vi.waitFor(() => expect(listener).toHaveBeenCalledOnce());

    expect(returned).toBe(response);
    expect(await returned.json()).toEqual({
      error: "Unauthorized",
      code: "stale_clerk_session",
    });
    expect(listener).toHaveBeenCalledWith({
      status: 401,
      url: "/api/products/482",
      code: "stale_clerk_session",
    });
    unsubscribe();
  });

  it("replays a stale-session failure that arrives before the listener mounts", async () => {
    const observedFetch = observeApiAuthFailures(
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            error: "Unauthorized",
            code: "stale_clerk_session",
          }),
          { status: 401, headers: { "Content-Type": "application/json" } },
        ),
      ),
    );

    await observedFetch("/api/products/318");
    await new Promise((resolve) => setTimeout(resolve, 0));

    const listener = vi.fn();
    const unsubscribe = on401(listener);

    expect(listener).toHaveBeenCalledOnce();
    expect(listener).toHaveBeenCalledWith({
      status: 401,
      url: "/api/products/318",
      code: "stale_clerk_session",
    });
    unsubscribe();
  });

  it("ignores 403 permission responses", async () => {
    const listener = vi.fn();
    const unsubscribe = on401(listener);
    const observedFetch = observeApiAuthFailures(
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ error: "no_access" }), { status: 403 }),
      ),
    );

    await observedFetch("/api/orders");
    await Promise.resolve();

    expect(listener).not.toHaveBeenCalled();
    unsubscribe();
  });

  it("ignores external 401 responses", async () => {
    const listener = vi.fn();
    const unsubscribe = on401(listener);
    const observedFetch = observeApiAuthFailures(
      vi.fn().mockResolvedValue(new Response(null, { status: 401 })),
    );

    await observedFetch("https://accounts.example.com/api/session");
    await Promise.resolve();

    expect(listener).not.toHaveBeenCalled();
    unsubscribe();
  });

  it("does not wrap an already observed fetch a second time", () => {
    const fetchMock = vi.fn() as unknown as typeof fetch;
    const observedFetch = observeApiAuthFailures(fetchMock);

    expect(observeApiAuthFailures(observedFetch)).toBe(observedFetch);
  });

  it("returns the original response if cloning fails", async () => {
    const listener = vi.fn();
    const unsubscribe = on401(listener);
    const response = {
      status: 401,
      clone: () => {
        throw new Error("body already consumed");
      },
    } as unknown as Response;
    const observedFetch = observeApiAuthFailures(
      vi.fn().mockResolvedValue(response),
    );

    await expect(observedFetch("/api/orders")).resolves.toBe(response);
    expect(listener).not.toHaveBeenCalled();
    unsubscribe();
  });
});

describe("apiFetch authentication recovery", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it("retries a rejected action once with a fresh Clerk token", async () => {
    mocks.getRegisteredAuthToken
      .mockResolvedValueOnce("cached-token")
      .mockResolvedValueOnce("fresh-token");
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ success: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(apiFetch("/api/cmc-pos/shifts", {
      method: "POST",
      body: JSON.stringify({ location_id: 1, opening_cash: 80 }),
    })).resolves.toEqual({ success: true });

    expect(mocks.getRegisteredAuthToken).toHaveBeenNthCalledWith(1, undefined);
    expect(mocks.getRegisteredAuthToken).toHaveBeenNthCalledWith(2, { skipCache: true });
    expect(fetchMock).toHaveBeenNthCalledWith(2, "/api/cmc-pos/shifts", expect.objectContaining({
      headers: expect.objectContaining({ Authorization: "Bearer fresh-token" }),
    }));
  });

  it("does not retry validation and permission errors", async () => {
    mocks.getRegisteredAuthToken.mockResolvedValue("cached-token");
    const fetchMock = vi.fn().mockResolvedValue(new Response(
      JSON.stringify({ error: "Finance access required" }),
      { status: 403, headers: { "Content-Type": "application/json" } },
    ));
    vi.stubGlobal("fetch", fetchMock);

    await expect(apiFetch("/api/finance/invoice-review/43/draft", {
      method: "PATCH",
      body: "{}",
    })).rejects.toMatchObject({ status: 403, message: "Finance access required" });
    expect(fetchMock).toHaveBeenCalledOnce();
  });
});
import { afterEach, describe, expect, it, vi } from "vitest";
import { setAuthTokenGetter } from "@workspace/api-client-react";
import {
  ApiError,
  customFetch,
} from "../../../../lib/api-client-react/src/custom-fetch";

afterEach(() => {
  setAuthTokenGetter(null);
  vi.restoreAllMocks();
});

describe("customFetch authentication recovery", () => {
  const actionRoutes = [
    ["POST", "/api/orders/manual"],
    ["PATCH", "/api/orders/123"],
    ["POST", "/api/orders/123/items"],
    ["POST", "/api/products"],
    ["PATCH", "/api/products/123"],
    ["POST", "/api/cash-sessions"],
    ["POST", "/api/finance/ai-invoice-import/imports/123/approve"],
    ["PATCH", "/api/florist-orders/123/assign"],
  ] as const;

  it.each(actionRoutes)(
    "recovers an expired token for %s %s",
    async (method, url) => {
      const getToken = vi
        .fn()
        .mockResolvedValueOnce("expired-token")
        .mockResolvedValueOnce("fresh-token");
      setAuthTokenGetter(getToken);
      const fetchMock = vi
        .spyOn(globalThis, "fetch")
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ error: "Unauthorized" }), {
            status: 401,
            headers: { "Content-Type": "application/json" },
          }),
        )
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ ok: true }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }),
        );

      await expect(
        customFetch(url, { method, responseType: "json" }),
      ).resolves.toEqual({ ok: true });
      expect(getToken).toHaveBeenNthCalledWith(2, { skipCache: true });
      expect(fetchMock).toHaveBeenCalledTimes(2);
    },
  );

  it("refreshes a near-expiry JWT before sending the request", async () => {
    const payload = btoa(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 5 }))
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
    const nearExpiryToken = `header.${payload}.signature`;
    const getToken = vi
      .fn()
      .mockResolvedValueOnce(nearExpiryToken)
      .mockResolvedValueOnce("fresh-token");
    setAuthTokenGetter(getToken);
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );

    await expect(
      customFetch("/api/products", { method: "POST", responseType: "json" }),
    ).resolves.toEqual({ ok: true });

    expect(getToken).toHaveBeenNthCalledWith(2, { skipCache: true });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(new Headers(fetchMock.mock.calls[0][1]?.headers).get("authorization"))
      .toBe("Bearer fresh-token");
  });

  it("retries a 401 once with a forced-fresh token", async () => {
    const getToken = vi
      .fn()
      .mockResolvedValueOnce("expired-token")
      .mockResolvedValueOnce("fresh-token");
    setAuthTokenGetter(getToken);

    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ error: "Unauthorized" }), {
          status: 401,
          headers: { "Content-Type": "application/json" },
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ id: 42 }), {
          status: 201,
          headers: { "Content-Type": "application/json" },
        }),
      );

    await expect(
      customFetch<{ id: number }>("/api/products", {
        method: "POST",
        body: JSON.stringify({ name: "Rose" }),
        responseType: "json",
      }),
    ).resolves.toEqual({ id: 42 });

    expect(getToken).toHaveBeenNthCalledWith(1);
    expect(getToken).toHaveBeenNthCalledWith(2, { skipCache: true });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(new Headers(fetchMock.mock.calls[0][1]?.headers).get("authorization"))
      .toBe("Bearer expired-token");
    expect(new Headers(fetchMock.mock.calls[1][1]?.headers).get("authorization"))
      .toBe("Bearer fresh-token");
  });

  it("does not replace or retry an explicit Authorization header", async () => {
    const getToken = vi.fn().mockResolvedValue("clerk-token");
    setAuthTokenGetter(getToken);
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      }),
    );

    await expect(
      customFetch("/api/machine-action", {
        method: "POST",
        headers: { Authorization: "Bearer machine-token" },
        responseType: "json",
      }),
    ).rejects.toBeInstanceOf(ApiError);

    expect(getToken).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(new Headers(fetchMock.mock.calls[0][1]?.headers).get("authorization"))
      .toBe("Bearer machine-token");
  });

  it("returns the original 401 when Clerk cannot provide a fresh token", async () => {
    const getToken = vi
      .fn()
      .mockResolvedValueOnce("expired-token")
      .mockResolvedValueOnce(null);
    setAuthTokenGetter(getToken);
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      }),
    );

    await expect(
      customFetch("/api/orders/manual", {
        method: "POST",
        responseType: "json",
      }),
    ).rejects.toMatchObject({ status: 401 });

    expect(getToken).toHaveBeenNthCalledWith(2, { skipCache: true });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
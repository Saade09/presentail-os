import assert from "node:assert/strict";
import test from "node:test";

import { requestDashboardBootstrap } from "../lib/dashboardBootstrap";

test("returns a fresh bootstrap URL", async () => {
  const url = await requestDashboardBootstrap({
    apiBase: "https://example.test",
    token: "mobile-token",
    onInvalidSession: async () => assert.fail("valid session was cleared"),
    fetchImpl: async () =>
      new Response(JSON.stringify({ bootstrapUrl: "https://example.test/sign-in?ticket=fresh" })),
  });
  assert.equal(url, "https://example.test/sign-in?ticket=fresh");
});

test("bounds a stalled bootstrap request", async () => {
  await assert.rejects(
    requestDashboardBootstrap({
      apiBase: "https://example.test",
      token: "mobile-token",
      timeoutMs: 5,
      onInvalidSession: async () => assert.fail("temporary failure cleared the session"),
      fetchImpl: (_input, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () =>
            reject(new DOMException("Aborted", "AbortError")),
          );
        }),
    }),
    /timed out/i,
  );
});

test("the same deadline bounds a response body that stalls after headers", async () => {
  await assert.rejects(
    requestDashboardBootstrap({
      apiBase: "https://example.test",
      token: "mobile-token",
      timeoutMs: 5,
      onInvalidSession: async () => assert.fail("timeout cleared the session"),
      fetchImpl: async () => {
        const response = new Response();
        Object.defineProperty(response, "json", {
          value: () => new Promise(() => {}),
        });
        return response;
      },
    }),
    /timed out/i,
  );
});

test("a superseded request is actively aborted", async () => {
  const controller = new AbortController();
  let fetchWasAborted = false;
  const pending = requestDashboardBootstrap({
    apiBase: "https://example.test",
    token: "mobile-token",
    signal: controller.signal,
    onInvalidSession: async () => assert.fail("cancellation cleared the session"),
    fetchImpl: (_input, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          fetchWasAborted = true;
          reject(new DOMException("Aborted", "AbortError"));
        });
      }),
  });
  controller.abort();

  await assert.rejects(pending, /cancelled/i);
  assert.equal(fetchWasAborted, true);
});

test("abort after headers prevents a stale invalid response from clearing the session", async () => {
  const controller = new AbortController();
  let releaseBody!: () => void;
  let cleared = false;
  const bodyGate = new Promise<void>((resolve) => {
    releaseBody = resolve;
  });
  const pending = requestDashboardBootstrap({
    apiBase: "https://example.test",
    token: "old-token",
    signal: controller.signal,
    onInvalidSession: async () => {
      cleared = true;
    },
    fetchImpl: async () => {
      const response = new Response(null, {
        status: 401,
        headers: { "X-Mobile-Auth": "invalid" },
      });
      Object.defineProperty(response, "json", {
        value: async () => {
          await bodyGate;
          return { error: "Unauthorized" };
        },
      });
      return response;
    },
  });

  await Promise.resolve();
  controller.abort();
  releaseBody();
  await assert.rejects(pending, /cancelled/i);
  assert.equal(cleared, false);
});

test("definitive rejection clears the native session", async () => {
  let cleared = false;
  await assert.rejects(
    requestDashboardBootstrap({
      apiBase: "https://example.test",
      token: "invalid-token",
      onInvalidSession: async () => {
        cleared = true;
      },
      fetchImpl: async () =>
        new Response(JSON.stringify({ error: "Unauthorized" }), {
          status: 401,
          headers: { "X-Mobile-Auth": "invalid" },
        }),
    }),
    /session has expired/i,
  );
  assert.equal(cleared, true);
});

test("temporary provider errors remain retryable", async () => {
  let cleared = false;
  await assert.rejects(
    requestDashboardBootstrap({
      apiBase: "https://example.test",
      token: "valid-token",
      onInvalidSession: async () => {
        cleared = true;
      },
      fetchImpl: async () =>
        new Response(JSON.stringify({ error: "Authentication service unavailable" }), {
          status: 503,
        }),
    }),
    /service unavailable/i,
  );
  assert.equal(cleared, false);
});
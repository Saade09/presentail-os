import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ---------------------------------------------------------------------------
// Mocks — declared before importing the module under test
// ---------------------------------------------------------------------------

const mockDbQuery = vi.fn();

vi.mock("./db", () => ({
  db: {
    query: (...args: unknown[]) => mockDbQuery(...args),
  },
}));

vi.mock("./logger", () => ({
  logger: { error: vi.fn(), info: vi.fn(), warn: vi.fn() },
}));

vi.mock("./publicWebhookFetch", () => ({
  publicWebhookFetch: (...args: unknown[]) => fetch(...args as [string, RequestInit]),
}));

import { createHmac } from "node:crypto";
import { fireWebhookEvent, retryDelivery } from "./catalogWebhook";

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

const OWNER = "user_test_owner";
const ENDPOINT_URL = "https://example.test/hook";
const SIGNING_SECRET = "shh-secret";

type SentRequest = { headers: Record<string, string>; body: string };

function expectedSignature(deliveryId: string, timestamp: string, body: string): string {
  return (
    "sha256=" +
    createHmac("sha256", SIGNING_SECRET).update(`${deliveryId}.${timestamp}.${body}`).digest("hex")
  );
}

function captureFetch(...responses: Array<{ ok: boolean; status: number }>) {
  const sent: SentRequest[] = [];
  const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
    const idx = sent.length;
    sent.push({
      headers: init.headers as Record<string, string>,
      body: init.body as string,
    });
    const r = responses[idx] ?? responses[responses.length - 1] ?? { ok: true, status: 200 };
    return { ok: r.ok, status: r.status, text: async () => (r.ok ? "ok" : "err") };
  });
  vi.stubGlobal("fetch", fetchMock);
  return { sent, fetchMock };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks();
  mockDbQuery.mockResolvedValue({ rows: [], rowCount: 0 });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("catalogWebhook per-attempt timestamp + signature", () => {
  it("re-stamps the body timestamp, header, and signature freshly on each automatic retry", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-11T00:00:00.000Z"));

    mockDbQuery.mockImplementation((sql: string) => {
      if (/SELECT id, endpoint_url/.test(sql)) {
        return Promise.resolve({
          rows: [
            {
              id: 1,
              endpoint_url: ENDPOINT_URL,
              signing_secret: SIGNING_SECRET,
              subscribed_events: ["currency_rates.updated"],
            },
          ],
          rowCount: 1,
        });
      }
      if (/INSERT INTO webhook_deliveries/.test(sql)) {
        return Promise.resolve({ rows: [{ id: 42 }], rowCount: 1 });
      }
      return Promise.resolve({ rows: [], rowCount: 0 });
    });

    // First attempt fails (forces a backoff retry); second attempt succeeds.
    const { sent, fetchMock } = captureFetch({ ok: false, status: 500 }, { ok: true, status: 200 });

    await fireWebhookEvent("currency_rates.updated", OWNER, { foo: "bar" });
    // Flush the fire-and-forget first attempt's microtasks.
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // Move the clock forward past the 5-minute replay window, then fire the
    // first backoff retry (30s timer).
    vi.setSystemTime(new Date("2026-06-11T00:06:00.000Z"));
    await vi.advanceTimersByTimeAsync(30_000);
    expect(fetchMock).toHaveBeenCalledTimes(2);

    const [first, second] = sent;

    const ts1 = first.headers["x-presentail-timestamp"];
    const ts2 = second.headers["x-presentail-timestamp"];
    const id1 = first.headers["x-presentail-delivery-id"];
    const id2 = second.headers["x-presentail-delivery-id"];

    // Each attempt carries a distinct, fresh timestamp.
    expect(ts1).not.toBe(ts2);
    expect(new Date(ts2).getTime()).toBeGreaterThan(new Date(ts1).getTime());

    // The body's timestamp field equals the header timestamp on every attempt.
    expect(JSON.parse(first.body).timestamp).toBe(ts1);
    expect(JSON.parse(second.body).timestamp).toBe(ts2);

    // The signature matches the body + timestamp actually sent on each attempt.
    expect(first.headers["x-presentail-signature"]).toBe(expectedSignature(id1, ts1, first.body));
    expect(second.headers["x-presentail-signature"]).toBe(expectedSignature(id2, ts2, second.body));

    // The retry's timestamp would pass a 5-minute replay window relative to now.
    expect(Math.abs(Date.now() - new Date(ts2).getTime())).toBeLessThan(5 * 60_000);
  });

  it("re-stamps a stale persisted payload with a fresh timestamp on manual retry", async () => {
    const stalePayload = {
      event: "currency_rates.updated",
      workspace: OWNER,
      timestamp: "2020-01-01T00:00:00.000Z",
      data: { base_currency: "USD" },
    };

    mockDbQuery.mockImplementation((sql: string) => {
      if (/UPDATE webhook_deliveries AS d/.test(sql)) {
        return Promise.resolve({
          rows: [
            {
              id: 7,
              webhook_endpoint_id: 1,
              event: "currency_rates.updated",
              payload: stalePayload,
              attempt_count: 3,
              endpoint_url: ENDPOINT_URL,
              signing_secret: SIGNING_SECRET,
              is_active: true,
              owner_id: OWNER,
            },
          ],
          rowCount: 1,
        });
      }
      return Promise.resolve({ rows: [], rowCount: 0 });
    });

    const { sent, fetchMock } = captureFetch({ ok: true, status: 200 });

    const before = Date.now();
    const ok = await retryDelivery(7, OWNER);
    // Flush the fire-and-forget delivery's microtasks.
    await new Promise((r) => setTimeout(r, 0));

    expect(ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const [sentReq] = sent;
    const ts = sentReq.headers["x-presentail-timestamp"];
    const id = sentReq.headers["x-presentail-delivery-id"];
    const sentBody = JSON.parse(sentReq.body);

    // The stale creation-time timestamp must be replaced with a fresh one.
    expect(sentBody.timestamp).not.toBe(stalePayload.timestamp);
    expect(sentBody.timestamp).toBe(ts);
    expect(new Date(ts).getTime()).toBeGreaterThanOrEqual(before);

    // Signature matches the freshly re-stamped body that was actually sent.
    expect(sentReq.headers["x-presentail-signature"]).toBe(expectedSignature(id, ts, sentReq.body));
  });

  it("does not send when a manual retry cannot atomically claim the delivery", async () => {
    mockDbQuery.mockResolvedValue({ rows: [], rowCount: 0 });
    const { fetchMock } = captureFetch({ ok: true, status: 200 });

    const ok = await retryDelivery(7, OWNER);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(ok).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(mockDbQuery).toHaveBeenCalledWith(
      expect.stringContaining("d.status IN ('delivered', 'failed', 'pending_retry')"),
      [7, OWNER],
    );
  });
});

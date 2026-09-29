import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const mockDbQuery = vi.fn();
vi.mock("./db", () => ({
  db: { query: (...args: unknown[]) => mockDbQuery(...args) },
}));

vi.mock("./logger", () => ({
  logger: { warn: vi.fn(), info: vi.fn() },
}));

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

function makeOkResponse(ticket: { status: string; message?: string; details?: { error?: string } }) {
  return {
    ok: true,
    json: async () => ({ data: ticket }),
  } as unknown as Response;
}

function makeHttpErrorResponse(status: number) {
  return {
    ok: false,
    status,
    text: async () => "Internal Server Error",
  } as unknown as Response;
}

function makeNetworkError() {
  return Promise.reject(new Error("Network failure"));
}

describe("sendExpoPushNotification", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("sends a single request and resolves when the ticket status is ok", async () => {
    mockFetch.mockResolvedValueOnce(makeOkResponse({ status: "ok" }));

    const { sendExpoPushNotification } = await import("./expoPush");
    const result = await sendExpoPushNotification("ExponentPushToken[abc]", "Title", "Body", { key: "val" });
    expect(result).toEqual({ success: true });

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://exp.host/--/api/v2/push/send");
    const payload = JSON.parse(init.body as string);
    expect(payload).toMatchObject({
      to: "ExponentPushToken[abc]",
      title: "Title",
      body: "Body",
      data: { key: "val" },
    });
  });

  it("retries on HTTP error and succeeds on second attempt", async () => {
    mockFetch
      .mockResolvedValueOnce(makeHttpErrorResponse(500))
      .mockResolvedValueOnce(makeOkResponse({ status: "ok" }));

    const { sendExpoPushNotification } = await import("./expoPush");
    const promise = sendExpoPushNotification("ExponentPushToken[retry]", "T", "B");
    await vi.runAllTimersAsync();
    const result = await promise;

    expect(result).toEqual({ success: true });
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it("retries on network error and succeeds on third attempt", async () => {
    mockFetch
      .mockImplementationOnce(() => makeNetworkError())
      .mockImplementationOnce(() => makeNetworkError())
      .mockResolvedValueOnce(makeOkResponse({ status: "ok" }));

    const { sendExpoPushNotification } = await import("./expoPush");
    const promise = sendExpoPushNotification("ExponentPushToken[net]", "T", "B");
    await vi.runAllTimersAsync();
    const result = await promise;

    expect(result).toEqual({ success: true });
    expect(mockFetch).toHaveBeenCalledTimes(3);
  });

  it("gives up after MAX_RETRIES and does not throw", async () => {
    mockFetch
      .mockResolvedValueOnce(makeHttpErrorResponse(503))
      .mockResolvedValueOnce(makeHttpErrorResponse(503))
      .mockResolvedValueOnce(makeHttpErrorResponse(503));

    const { sendExpoPushNotification } = await import("./expoPush");
    const promise = sendExpoPushNotification("ExponentPushToken[fail]", "T", "B");
    await vi.runAllTimersAsync();
    const result = await promise;

    expect(result).toEqual({ success: false });
    expect(mockFetch).toHaveBeenCalledTimes(3);
  });

  it("clears the stale push token from DB when ticket error is DeviceNotRegistered", async () => {
    mockFetch.mockResolvedValueOnce(
      makeOkResponse({
        status: "error",
        message: "DeviceNotRegistered",
        details: { error: "DeviceNotRegistered" },
      }),
    );
    mockDbQuery.mockResolvedValueOnce({ rows: [] });

    const { sendExpoPushNotification } = await import("./expoPush");
    const result = await sendExpoPushNotification("ExponentPushToken[stale]", "T", "B");
    expect(result).toEqual({ success: false });

    expect(mockDbQuery).toHaveBeenCalledTimes(1);
    const [sql, params] = mockDbQuery.mock.calls[0] as [string, unknown[]];
    expect(sql).toMatch(/UPDATE fleet_drivers SET expo_push_token = NULL/);
    expect(params).toEqual(["ExponentPushToken[stale]"]);
  });

  it("returns { success: false } and does NOT clear the DB token for non-DeviceNotRegistered ticket errors", async () => {
    mockFetch.mockResolvedValueOnce(
      makeOkResponse({
        status: "error",
        message: "MessageTooBig",
        details: { error: "MessageTooBig" },
      }),
    );

    const { sendExpoPushNotification } = await import("./expoPush");
    const result = await sendExpoPushNotification("ExponentPushToken[big]", "T", "B");
    expect(result).toEqual({ success: false });

    expect(mockDbQuery).not.toHaveBeenCalled();
  });

  it("resolves on successful ticket without data field in response", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({}),
    } as unknown as Response);

    const { sendExpoPushNotification } = await import("./expoPush");
    const result = await sendExpoPushNotification("ExponentPushToken[nodata]", "T", "B");
    expect(result).toEqual({ success: true });
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });
});

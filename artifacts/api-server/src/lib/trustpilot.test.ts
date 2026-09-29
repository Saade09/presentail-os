import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("./logger", () => ({
  logger: { error: vi.fn(), info: vi.fn(), warn: vi.fn() },
}));

import {
  isTrustpilotEnabled,
  isTrustpilotTestMode,
  trustpilotDelayHours,
  resolveTrustpilotLocale,
  computePreferredSendTime,
  buildInvitationPayload,
  createTrustpilotInvitation,
  getTrustpilotAccessToken,
  resetTrustpilotTokenCache,
  isRetryableTrustpilotError,
  TrustpilotApiError,
} from "./trustpilot";

const ENV_KEYS = [
  "TRUSTPILOT_ENABLED",
  "TRUSTPILOT_API_KEY",
  "TRUSTPILOT_API_SECRET",
  "TRUSTPILOT_BUSINESS_UNIT_ID",
  "TRUSTPILOT_BUSINESS_USER_ID",
  "TRUSTPILOT_SERVICE_TEMPLATE_ID",
  "TRUSTPILOT_INVITATION_DELAY_HOURS",
  "TRUSTPILOT_TEST_MODE",
];
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const k of ENV_KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  resetTrustpilotTokenCache();
  vi.restoreAllMocks();
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

function enableAll() {
  process.env.TRUSTPILOT_ENABLED = "true";
  process.env.TRUSTPILOT_API_KEY = "key";
  process.env.TRUSTPILOT_API_SECRET = "secret";
  process.env.TRUSTPILOT_BUSINESS_UNIT_ID = "bu-1";
}

describe("isTrustpilotEnabled", () => {
  it("is false when env flag is unset", () => {
    expect(isTrustpilotEnabled()).toBe(false);
  });

  it("is false when flag is on but credentials are missing", () => {
    process.env.TRUSTPILOT_ENABLED = "true";
    expect(isTrustpilotEnabled()).toBe(false);
  });

  it("is true when flag and credentials are present", () => {
    enableAll();
    expect(isTrustpilotEnabled()).toBe(true);
  });

  it("is false when flag is explicitly false despite credentials", () => {
    enableAll();
    process.env.TRUSTPILOT_ENABLED = "false";
    expect(isTrustpilotEnabled()).toBe(false);
  });
});

describe("isTrustpilotTestMode / trustpilotDelayHours", () => {
  it("test mode only when TRUSTPILOT_TEST_MODE=true", () => {
    expect(isTrustpilotTestMode()).toBe(false);
    process.env.TRUSTPILOT_TEST_MODE = "TRUE";
    expect(isTrustpilotTestMode()).toBe(true);
  });

  it("delay defaults to 24 and honors valid overrides", () => {
    expect(trustpilotDelayHours()).toBe(24);
    process.env.TRUSTPILOT_INVITATION_DELAY_HOURS = "0";
    expect(trustpilotDelayHours()).toBe(0);
    process.env.TRUSTPILOT_INVITATION_DELAY_HOURS = "48";
    expect(trustpilotDelayHours()).toBe(48);
    process.env.TRUSTPILOT_INVITATION_DELAY_HOURS = "junk";
    expect(trustpilotDelayHours()).toBe(24);
    process.env.TRUSTPILOT_INVITATION_DELAY_HOURS = "-1";
    expect(trustpilotDelayHours()).toBe(24);
  });
});

describe("resolveTrustpilotLocale", () => {
  it("maps Arabic language to ar", () => {
    expect(resolveTrustpilotLocale("ar", "Lebanon")).toBe("ar");
    expect(resolveTrustpilotLocale("AR-LB", null)).toBe("ar");
  });

  it("maps Cyprus to en-GB", () => {
    expect(resolveTrustpilotLocale(null, "Cyprus")).toBe("en-GB");
    expect(resolveTrustpilotLocale("en", "cy")).toBe("en-GB");
  });

  it("defaults to en-US", () => {
    expect(resolveTrustpilotLocale(null, null)).toBe("en-US");
    expect(resolveTrustpilotLocale("en", "Lebanon")).toBe("en-US");
    expect(resolveTrustpilotLocale("fr", "United Arab Emirates")).toBe("en-US");
  });
});

describe("computePreferredSendTime", () => {
  it("adds the configured delay to the completion time", () => {
    process.env.TRUSTPILOT_INVITATION_DELAY_HOURS = "24";
    const completed = new Date("2026-07-01T10:00:00Z");
    expect(computePreferredSendTime(completed)).toBe("2026-07-02T10:00:00.000Z");
  });

  it("falls back to now for missing/invalid completion times", () => {
    process.env.TRUSTPILOT_INVITATION_DELAY_HOURS = "1";
    const now = new Date("2026-07-01T00:00:00Z");
    expect(computePreferredSendTime(null, now)).toBe("2026-07-01T01:00:00.000Z");
    expect(computePreferredSendTime("not-a-date", now)).toBe("2026-07-01T01:00:00.000Z");
  });
});

describe("isRetryableTrustpilotError", () => {
  it("retries 429 and 5xx", () => {
    expect(isRetryableTrustpilotError(new TrustpilotApiError("x", 429, ""))).toBe(true);
    expect(isRetryableTrustpilotError(new TrustpilotApiError("x", 500, ""))).toBe(true);
    expect(isRetryableTrustpilotError(new TrustpilotApiError("x", 503, ""))).toBe(true);
  });

  it("does not retry other 4xx", () => {
    expect(isRetryableTrustpilotError(new TrustpilotApiError("x", 400, ""))).toBe(false);
    expect(isRetryableTrustpilotError(new TrustpilotApiError("x", 401, ""))).toBe(false);
    expect(isRetryableTrustpilotError(new TrustpilotApiError("x", 404, ""))).toBe(false);
  });

  it("retries network-level errors", () => {
    expect(isRetryableTrustpilotError(new TypeError("fetch failed"))).toBe(true);
  });
});

describe("buildInvitationPayload", () => {
  it("includes recipient, reference, locale, template and send time", () => {
    process.env.TRUSTPILOT_SERVICE_TEMPLATE_ID = "tpl-1";
    const payload = buildInvitationPayload({
      email: "a@b.com",
      name: "Alice",
      referenceId: "lb-1001",
      locale: "en-US",
      preferredSendTime: "2026-07-02T10:00:00.000Z",
      tags: ["Lebanon", "web"],
    });
    expect(payload).toMatchObject({
      referenceNumber: "lb-1001",
      consumerName: "Alice",
      consumerEmail: "a@b.com",
      locale: "en-US",
      serviceReviewInvitation: {
        templateId: "tpl-1",
        preferredSendTime: "2026-07-02T10:00:00.000Z",
        tags: ["Lebanon", "web"],
      },
    });
  });

  it("falls back to email when name missing", () => {
    const payload = buildInvitationPayload({
      email: "a@b.com",
      name: null,
      referenceId: "r",
      locale: "ar",
      preferredSendTime: "2026-07-02T10:00:00.000Z",
      tags: [],
    });
    expect(payload.consumerName).toBe("a@b.com");
  });
});

describe("createTrustpilotInvitation (test mode)", () => {
  it("returns synthetic success without any network call", async () => {
    enableAll();
    process.env.TRUSTPILOT_TEST_MODE = "true";
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const result = await createTrustpilotInvitation({
      email: "a@b.com",
      name: "Alice",
      referenceId: "r",
      locale: "en-US",
      preferredSendTime: "2026-07-02T10:00:00.000Z",
      tags: [],
    });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(result.invitationId).toBeNull();
    expect(result.responsePayload).toMatchObject({ testMode: true });
  });
});

describe("token cache", () => {
  it("fetches once and reuses the cached token", async () => {
    enableAll();
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ access_token: "tok", expires_in: 3600 }), { status: 200 }),
    );
    expect(await getTrustpilotAccessToken()).toBe("tok");
    expect(await getTrustpilotAccessToken()).toBe("tok");
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("throws TrustpilotApiError on token failure", async () => {
    enableAll();
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("nope", { status: 401 }));
    await expect(getTrustpilotAccessToken()).rejects.toBeInstanceOf(TrustpilotApiError);
  });
});

describe("createTrustpilotInvitation (live)", () => {
  it("posts the invitation and returns the id", async () => {
    enableAll();
    process.env.TRUSTPILOT_BUSINESS_USER_ID = "bu-user";
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ access_token: "tok", expires_in: 3600 }), { status: 200 }),
      )
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: "inv-1" }), { status: 200 }));
    fetchSpy.mockClear();

    const result = await createTrustpilotInvitation({
      email: "a@b.com",
      name: "Alice",
      referenceId: "r",
      locale: "en-US",
      preferredSendTime: "2026-07-02T10:00:00.000Z",
      tags: ["Lebanon"],
    });
    expect(result.invitationId).toBe("inv-1");
    const [url, init] = fetchSpy.mock.calls[1] as [string, RequestInit];
    expect(url).toContain("/business-units/bu-1/email-invitations");
    expect((init.headers as Record<string, string>)["x-business-user-id"]).toBe("bu-user");
  });

  it("refreshes the token and retries once on 401", async () => {
    enableAll();
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ access_token: "tok1", expires_in: 3600 }), { status: 200 }),
      )
      .mockResolvedValueOnce(new Response("unauthorized", { status: 401 }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ access_token: "tok2", expires_in: 3600 }), { status: 200 }),
      )
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: "inv-2" }), { status: 200 }));
    fetchSpy.mockClear();

    const result = await createTrustpilotInvitation({
      email: "a@b.com",
      name: null,
      referenceId: "r",
      locale: "en-US",
      preferredSendTime: "2026-07-02T10:00:00.000Z",
      tags: [],
    });
    expect(result.invitationId).toBe("inv-2");
    expect(fetchSpy).toHaveBeenCalledTimes(4);
    const retryInit = fetchSpy.mock.calls[3][1] as RequestInit;
    expect((retryInit.headers as Record<string, string>).Authorization).toBe("Bearer tok2");
  });

  it("fails after one 401 retry (no infinite loop)", async () => {
    enableAll();
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ access_token: "tok1", expires_in: 3600 }), { status: 200 }),
      )
      .mockResolvedValueOnce(new Response("unauthorized", { status: 401 }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ access_token: "tok2", expires_in: 3600 }), { status: 200 }),
      )
      .mockResolvedValueOnce(new Response("unauthorized", { status: 401 }));
    fetchSpy.mockClear();

    await expect(
      createTrustpilotInvitation({
        email: "a@b.com",
        name: null,
        referenceId: "r",
        locale: "en-US",
        preferredSendTime: "2026-07-02T10:00:00.000Z",
        tags: [],
      }),
    ).rejects.toMatchObject({ status: 401 });
    expect(fetchSpy).toHaveBeenCalledTimes(4);
  });

  it("throws TrustpilotApiError with status on failure", async () => {
    enableAll();
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ access_token: "tok", expires_in: 3600 }), { status: 200 }),
      )
      .mockResolvedValueOnce(new Response("rate limited", { status: 429 }));
    await expect(
      createTrustpilotInvitation({
        email: "a@b.com",
        name: null,
        referenceId: "r",
        locale: "en-US",
        preferredSendTime: "2026-07-02T10:00:00.000Z",
        tags: [],
      }),
    ).rejects.toMatchObject({ status: 429 });
  });
});

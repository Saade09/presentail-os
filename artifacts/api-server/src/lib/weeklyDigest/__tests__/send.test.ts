// Unit tests for weekly digest send orchestration + idempotency (task #2830).
// Mocks the db, Resend email helper, and AI insights.

import { describe, it, expect, vi, beforeEach } from "vitest";

const dbQuery = vi.fn();
vi.mock("../../db", () => ({
  db: { query: (...args: unknown[]) => dbQuery(...args) },
}));

const sendWeeklyDigestEmail = vi.fn();
vi.mock("../../email", () => ({
  sendWeeklyDigestEmail: (...args: unknown[]) => sendWeeklyDigestEmail(...args),
}));

const generateDigestInsights = vi.fn();
vi.mock("../insights", () => ({
  generateDigestInsights: (...args: unknown[]) => generateDigestInsights(...args),
}));

const buildWeeklyDigestData = vi.fn();
vi.mock("../aggregate", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../aggregate")>();
  return {
    ...actual,
    buildWeeklyDigestData: (...args: unknown[]) => buildWeeklyDigestData(...args),
  };
});

import {
  buildAndSendWeeklyDigest,
  normalizeExtraRecipients,
  resolveDigestRecipients,
} from "../send";
import { isDigestSendTime } from "../../weeklyDigestJob";
import type { WeekWindow, WeeklyMetrics } from "../aggregate";

const WINDOW: WeekWindow = {
  start: new Date("2026-06-22T00:00:00.000Z"),
  end: new Date("2026-06-29T00:00:00.000Z"),
};

const EMPTY_METRICS: WeeklyMetrics = {
  orders: 0,
  grossSalesUsd: 0,
  netSalesUsd: 0,
  discountsUsd: 0,
  aovUsd: 0,
  cogsUsd: 0,
  cogsCoveredSalesUsd: 0,
  grossMarginPct: null,
  byCountry: [],
  byCity: [],
  byChannel: [],
  byCategory: [],
  bestSellers: [],
  byOccasion: [],
  byRecipient: [],
  newCustomers: 0,
  returningCustomers: 0,
  repeatRatePct: null,
  guestOrders: 0,
  registeredOrders: 0,
  daily: [],
  cancelledOrders: 0,
  cancelledUsd: 0,
  refundedOrders: 0,
  refundedUsd: 0,
  couponRedemptions: 0,
  couponDiscountUsd: 0,
  delivery: {
    deliveryOrders: 0,
    deliveredOrders: 0,
    onTimeDeliveries: 0,
    lateDeliveries: 0,
    onTimeRatePct: null,
    sameDayOrders: 0,
    expressOrders: 0,
    avgDeliveryTimeHours: null,
  },
  funnel: {
    productViews: 0,
    addToCarts: 0,
    purchases: 0,
    addToCartRatePct: null,
    conversionRatePct: null,
    tracked: false,
  },
  cmcMetrics: {
    saleCount: 0,
    grossSalesUsd: 0,
    netSalesUsd: 0,
    commissionUsd: 0,
    commissionVatUsd: 0,
    payableUsd: 0,
  },
};

const DIGEST_DATA = {
  weekNumber: 26,
  window: WINDOW,
  current: EMPTY_METRICS,
  previous: EMPTY_METRICS,
};

beforeEach(() => {
  vi.clearAllMocks();
  buildWeeklyDigestData.mockResolvedValue(DIGEST_DATA);
  generateDigestInsights.mockResolvedValue({
    insights: ["i1"],
    actions: ["a1"],
    source: "fallback",
  });
  sendWeeklyDigestEmail.mockResolvedValue(undefined);
});

describe("normalizeExtraRecipients", () => {
  it("dedupes, lowercases, trims, and drops non-strings", () => {
    expect(
      normalizeExtraRecipients([" A@X.com", "a@x.com", 5, "", "b@y.com "]),
    ).toEqual(["a@x.com", "b@y.com"]);
  });
  it("returns [] for non-arrays", () => {
    expect(normalizeExtraRecipients(null)).toEqual([]);
    expect(normalizeExtraRecipients("a@x.com")).toEqual([]);
  });
});

describe("resolveDigestRecipients", () => {
  it("merges owner emails with extra recipients, deduped", async () => {
    dbQuery.mockResolvedValueOnce({
      rows: [{ member_email: "Owner@Biz.com" }],
      rowCount: 1,
    });
    const result = await resolveDigestRecipients("ws1", ["owner@biz.com", "extra@x.com"]);
    expect(result).toEqual(["owner@biz.com", "extra@x.com"]);
  });

  it("only queries owners who have not opted out of the weekly digest", async () => {
    dbQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    await resolveDigestRecipients("ws1", []);
    const [sql] = dbQuery.mock.calls[0];
    expect(sql).toContain("notify_email_weekly_digest = true");
  });

  it("still includes extra recipients when all owners opted out", async () => {
    dbQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    const result = await resolveDigestRecipients("ws1", ["extra@x.com"]);
    expect(result).toEqual(["extra@x.com"]);
  });
});

describe("buildAndSendWeeklyDigest idempotency", () => {
  it("sends and records the claim on first run", async () => {
    dbQuery
      .mockResolvedValueOnce({ rows: [{ member_email: "owner@biz.com" }], rowCount: 1 }) // recipients
      .mockResolvedValueOnce({ rows: [{ id: 1 }], rowCount: 1 }); // claim INSERT wins

    const result = await buildAndSendWeeklyDigest({
      ownerId: "ws1",
      window: WINDOW,
      extraRecipients: [],
      recordSend: true,
    });

    expect(result.sent).toBe(true);
    expect(result.weekStart).toBe("2026-06-22");
    expect(sendWeeklyDigestEmail).toHaveBeenCalledTimes(1);
    const insertCall = dbQuery.mock.calls[1];
    expect(insertCall[0]).toContain("ON CONFLICT (workspace_owner_id, week_start) DO NOTHING");
    expect(insertCall[1]).toEqual(["ws1", "2026-06-22", JSON.stringify(["owner@biz.com"])]);
  });

  it("skips when the week was already sent (claim loses)", async () => {
    dbQuery
      .mockResolvedValueOnce({ rows: [{ member_email: "owner@biz.com" }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 }); // claim lost

    const result = await buildAndSendWeeklyDigest({
      ownerId: "ws1",
      window: WINDOW,
      extraRecipients: [],
      recordSend: true,
    });

    expect(result.sent).toBe(false);
    expect(result.reason).toBe("already_sent");
    expect(sendWeeklyDigestEmail).not.toHaveBeenCalled();
  });

  it("releases the claim when the send fails, so a retry is possible", async () => {
    dbQuery
      .mockResolvedValueOnce({ rows: [{ member_email: "owner@biz.com" }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [{ id: 1 }], rowCount: 1 }) // claim wins
      .mockResolvedValueOnce({ rows: [], rowCount: 1 }); // DELETE claim
    sendWeeklyDigestEmail.mockRejectedValueOnce(new Error("resend down"));

    await expect(
      buildAndSendWeeklyDigest({
        ownerId: "ws1",
        window: WINDOW,
        extraRecipients: [],
        recordSend: true,
      }),
    ).rejects.toThrow("resend down");

    const deleteCall = dbQuery.mock.calls[2];
    expect(deleteCall[0]).toContain("DELETE FROM weekly_digest_sends");
    expect(deleteCall[1]).toEqual(["ws1", "2026-06-22"]);
  });

  it("does not touch the ledger for manual send-now (recordSend=false)", async () => {
    dbQuery.mockResolvedValueOnce({ rows: [{ member_email: "owner@biz.com" }], rowCount: 1 });

    const result = await buildAndSendWeeklyDigest({
      ownerId: "ws1",
      window: WINDOW,
      extraRecipients: ["cfo@biz.com"],
      recordSend: false,
    });

    expect(result.sent).toBe(true);
    expect(result.recipients).toEqual(["owner@biz.com", "cfo@biz.com"]);
    expect(dbQuery).toHaveBeenCalledTimes(1); // only the recipients query
  });

  it("skips with no_recipients when the owner has no email", async () => {
    dbQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const result = await buildAndSendWeeklyDigest({
      ownerId: "ws1",
      window: WINDOW,
      extraRecipients: [],
      recordSend: true,
    });

    expect(result.sent).toBe(false);
    expect(result.reason).toBe("no_recipients");
    expect(sendWeeklyDigestEmail).not.toHaveBeenCalled();
    expect(dbQuery).toHaveBeenCalledTimes(1);
  });
});

describe("isDigestSendTime", () => {
  it("is true only on Mondays from 06:00 UTC", () => {
    expect(isDigestSendTime(new Date("2026-06-29T06:00:00.000Z"))).toBe(true); // Mon 06:00
    expect(isDigestSendTime(new Date("2026-06-29T23:00:00.000Z"))).toBe(true); // Mon late
    expect(isDigestSendTime(new Date("2026-06-29T05:59:00.000Z"))).toBe(false); // Mon early
    expect(isDigestSendTime(new Date("2026-06-30T09:00:00.000Z"))).toBe(false); // Tue
    expect(isDigestSendTime(new Date("2026-06-28T09:00:00.000Z"))).toBe(false); // Sun
  });
});

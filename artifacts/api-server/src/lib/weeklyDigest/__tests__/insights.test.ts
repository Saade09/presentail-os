// Unit tests for AI insights generation + rule-based fallback (task #2830).

import { describe, it, expect, vi, beforeEach } from "vitest";

const chatCreate = vi.fn();
vi.mock("@workspace/integrations-openai-ai-server", () => ({
  openai: { chat: { completions: { create: (...args: unknown[]) => chatCreate(...args) } } },
}));

import { generateDigestInsights, buildFallbackInsights } from "../insights";
import type { WeeklyDigestData, WeeklyMetrics } from "../aggregate";

function metrics(overrides: Partial<WeeklyMetrics> = {}): WeeklyMetrics {
  return {
    orders: 10,
    grossSalesUsd: 1100,
    netSalesUsd: 1000,
    discountsUsd: 100,
    aovUsd: 100,
    cogsUsd: 400,
    cogsCoveredSalesUsd: 800,
    grossMarginPct: 50,
    byCountry: [],
    byCity: [],
    byChannel: [],
    byCategory: [],
    bestSellers: [
      { name: "Roses", units: 5, salesUsd: 500, marginPct: 60, isNew: true },
    ],
    byOccasion: [],
    byRecipient: [],
    newCustomers: 4,
    returningCustomers: 2,
    repeatRatePct: 33.3,
    guestOrders: 3,
    registeredOrders: 7,
    daily: [],
    cancelledOrders: 1,
    cancelledUsd: 50,
    refundedOrders: 0,
    refundedUsd: 0,
    couponRedemptions: 2,
    couponDiscountUsd: 30,
    delivery: {
      deliveryOrders: 10,
      deliveredOrders: 9,
      onTimeDeliveries: 8,
      lateDeliveries: 1,
      onTimeRatePct: 88.9,
      sameDayOrders: 4,
      expressOrders: 2,
      avgDeliveryTimeHours: 5.5,
    },
    funnel: {
      productViews: 100,
      addToCarts: 12,
      purchases: 4,
      addToCartRatePct: 12,
      conversionRatePct: 4,
      tracked: true,
    },
    cmcMetrics: {
      saleCount: 0,
      grossSalesUsd: 0,
      netSalesUsd: 0,
      commissionUsd: 0,
      commissionVatUsd: 0,
      payableUsd: 0,
    },
    ...overrides,
  };
}

const DATA: WeeklyDigestData = {
  weekNumber: 27,
  window: {
    start: new Date("2026-06-29T00:00:00.000Z"),
    end: new Date("2026-07-06T00:00:00.000Z"),
  },
  current: metrics(),
  previous: metrics({ netSalesUsd: 800, orders: 8, aovUsd: 100, grossMarginPct: 55 }),
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe("generateDigestInsights", () => {
  it("uses the AI response when the call succeeds", async () => {
    chatCreate.mockResolvedValueOnce({
      choices: [
        {
          message: {
            content: JSON.stringify({
              insights: ["Sales up 25%", "Margin dipped"],
              actions: ["Restock roses"],
            }),
          },
        },
      ],
    });
    const result = await generateDigestInsights(DATA);
    expect(result.source).toBe("ai");
    expect(result.insights).toEqual(["Sales up 25%", "Margin dipped"]);
    expect(result.actions).toEqual(["Restock roses"]);
  });

  it("tolerates code-fenced JSON from the model", async () => {
    chatCreate.mockResolvedValueOnce({
      choices: [
        {
          message: {
            content: '```json\n{"insights":["a"],"actions":["b"]}\n```',
          },
        },
      ],
    });
    const result = await generateDigestInsights(DATA);
    expect(result.source).toBe("ai");
    expect(result.insights).toEqual(["a"]);
  });

  it("falls back to rule-based insights when the AI call fails", async () => {
    chatCreate.mockRejectedValueOnce(new Error("proxy unavailable"));
    const result = await generateDigestInsights(DATA);
    expect(result.source).toBe("fallback");
    expect(result.insights.length).toBeGreaterThanOrEqual(3);
    expect(result.actions.length).toBeGreaterThanOrEqual(3);
  });

  it("falls back when the AI returns unparseable output", async () => {
    chatCreate.mockResolvedValueOnce({
      choices: [{ message: { content: "sorry, I cannot do that" } }],
    });
    const result = await generateDigestInsights(DATA);
    expect(result.source).toBe("fallback");
  });
});

describe("buildFallbackInsights", () => {
  it("produces 3-5 concrete bullets referencing the numbers", () => {
    const result = buildFallbackInsights(DATA);
    expect(result.insights.length).toBeGreaterThanOrEqual(3);
    expect(result.insights.length).toBeLessThanOrEqual(5);
    expect(result.actions.length).toBeGreaterThanOrEqual(3);
    expect(result.actions.length).toBeLessThanOrEqual(5);
    expect(result.insights.join(" ")).toContain("$1,000");
    expect(result.insights.join(" ")).toContain("Roses");
  });

  it("flags margin decline in actions", () => {
    const result = buildFallbackInsights(DATA); // 55% → 50%
    expect(result.actions.join(" ")).toContain("55.0%");
  });
});

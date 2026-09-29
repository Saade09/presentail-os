// ---------------------------------------------------------------------------
// Weekly Sales Digest — AI insights + rule-based fallback (task #2830)
//
// Sends the computed weekly numbers to OpenAI (via the Replit AI integration
// proxy, @workspace/integrations-openai-ai-server) and asks for 3–5 plain
// business-language insight bullets and 3–5 suggested actions. If the AI call
// fails for any reason, falls back to deterministic rule-based highlights so
// the digest email always sends.
// ---------------------------------------------------------------------------

import { z } from "zod/v4";
import { logger } from "../logger";
import type { WeeklyDigestData } from "./aggregate";
import { pctChange } from "./aggregate";
import { aiUsageAttribution, type AiUsageAttribution } from "../aiUsageRecorder";

const AI_MODEL = "gpt-5-mini";
const MAX_TOKENS = 8192;

export interface DigestInsights {
  insights: string[];
  actions: string[];
  source: "ai" | "fallback";
}

const OutputSchema = z.object({
  insights: z.array(z.string()).min(1).max(6),
  actions: z.array(z.string()).min(1).max(6),
});

function buildPrompt(data: WeeklyDigestData): string {
  const cur = data.current;
  const prev = data.previous;
  const payload = {
    week_number: data.weekNumber,
    current_week: cur,
    previous_week: prev,
  };
  return `You are a retail/e-commerce business analyst writing a weekly report for the CEO of a flower & gifts business. All amounts are USD.

Below are the computed metrics for this week and the previous week (JSON). Fields ending in "Usd" are dollar amounts; "Pct" fields are percentages.

${JSON.stringify(payload)}

Write:
1. "insights": 3-5 bullets — the most important things that actually changed week-over-week, in plain business language, each referencing concrete figures (e.g. "Net sales grew 18% to $12,400 driven by UAE orders" or "Cakes grew 22% but margin dropped from 72% to 68%"). Prefer surprising or actionable observations over restating totals.
2. "actions": 3-5 bullets — specific, practical suggested actions grounded in those numbers.

Respond ONLY with a JSON object: {"insights": string[], "actions": string[]}. No markdown, no extra text.`;
}

async function generateWithAI(data: WeeklyDigestData, attribution?: AiUsageAttribution): Promise<DigestInsights> {
  const { callAI } = await import("../ai/callAI");
  const response = await callAI({
    actionKey: "weekly_digest.insights",
    surface: "weekly_digest",
    provider: "openai",
    model: AI_MODEL,
    ...aiUsageAttribution(attribution),
    maxTokens: MAX_TOKENS,
    messages: [{ role: "user", content: buildPrompt(data) }],
  });
  const content = response.choices[0]?.message?.content ?? "";
  // Tolerate accidental code fences
  const cleaned = content.replace(/^```(?:json)?\s*/i, "").replace(/\s*```\s*$/, "").trim();
  const parsed = OutputSchema.parse(JSON.parse(cleaned));
  return {
    insights: parsed.insights.slice(0, 5),
    actions: parsed.actions.slice(0, 5),
    source: "ai",
  };
}

const usdFmt = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  maximumFractionDigits: 0,
});

function pctStr(v: number | null): string {
  if (v == null) return "n/a";
  return `${v > 0 ? "+" : ""}${v.toFixed(1)}%`;
}

/** Deterministic highlights used when the AI call fails. Exported for tests. */
export function buildFallbackInsights(data: WeeklyDigestData): DigestInsights {
  const cur = data.current;
  const prev = data.previous;
  const insights: string[] = [];
  const actions: string[] = [];

  const salesDelta = pctChange(cur.netSalesUsd, prev.netSalesUsd);
  insights.push(
    `Net sales were ${usdFmt.format(cur.netSalesUsd)} across ${cur.orders} orders (${pctStr(salesDelta)} vs ${usdFmt.format(prev.netSalesUsd)} last week).`,
  );

  const aovDelta = pctChange(cur.aovUsd, prev.aovUsd);
  insights.push(
    `Average order value was ${usdFmt.format(cur.aovUsd)} (${pctStr(aovDelta)} week-over-week).`,
  );

  if (cur.grossMarginPct != null) {
    const marginNote =
      prev.grossMarginPct != null
        ? ` vs ${prev.grossMarginPct.toFixed(1)}% last week`
        : "";
    insights.push(
      `Gross margin on costed products was ${cur.grossMarginPct.toFixed(1)}%${marginNote}, with COGS of ${usdFmt.format(cur.cogsUsd)}.`,
    );
  }

  const topProduct = cur.bestSellers[0];
  if (topProduct) {
    insights.push(
      `Best seller: ${topProduct.name} with ${topProduct.units} units and ${usdFmt.format(topProduct.salesUsd)} in sales${topProduct.isNew ? " — new to the top 10 this week" : ""}.`,
    );
  }

  if (cur.newCustomers + cur.returningCustomers > 0) {
    insights.push(
      `${cur.newCustomers} new and ${cur.returningCustomers} returning customers ordered this week${cur.repeatRatePct != null ? ` (repeat rate ${cur.repeatRatePct.toFixed(1)}%)` : ""}.`,
    );
  }

  // Delivery: mention a notable on-time rate change (≥5pp either way)
  const curOnTime = cur.delivery?.onTimeRatePct ?? null;
  const prevOnTime = prev.delivery?.onTimeRatePct ?? null;
  if (curOnTime != null && prevOnTime != null && Math.abs(curOnTime - prevOnTime) >= 5) {
    const direction = curOnTime < prevOnTime ? "dropped" : "improved";
    insights.push(
      `On-time delivery rate ${direction} from ${prevOnTime.toFixed(1)}% to ${curOnTime.toFixed(1)}% (${cur.delivery.lateDeliveries} late deliver${cur.delivery.lateDeliveries === 1 ? "y" : "ies"} this week).`,
    );
  }

  // Actions
  if (curOnTime != null && prevOnTime != null && curOnTime < prevOnTime - 5) {
    actions.push(
      `On-time delivery slipped to ${curOnTime.toFixed(1)}% — review the ${cur.delivery.lateDeliveries} late deliver${cur.delivery.lateDeliveries === 1 ? "y" : "ies"} for routing or capacity issues.`,
    );
  }
  if (salesDelta != null && salesDelta < 0) {
    actions.push(
      "Sales declined week-over-week — review the daily breakdown for the weakest days and consider a mid-week promotion.",
    );
  } else {
    actions.push(
      "Keep momentum going — review the best-sellers list and make sure top products are in stock and featured.",
    );
  }
  if (cur.grossMarginPct != null && prev.grossMarginPct != null && cur.grossMarginPct < prev.grossMarginPct) {
    actions.push(
      `Margin slipped from ${prev.grossMarginPct.toFixed(1)}% to ${cur.grossMarginPct.toFixed(1)}% — check supplier prices and recipe costs on high-volume products.`,
    );
  }
  if (cur.cancelledOrders + cur.refundedOrders > 0) {
    actions.push(
      `Investigate the ${cur.cancelledOrders} cancellation(s) and ${cur.refundedOrders} refund(s) this week to spot fulfilment or quality issues.`,
    );
  }
  if (cur.repeatRatePct != null && cur.repeatRatePct < 30) {
    actions.push(
      "Repeat rate is below 30% — consider a follow-up email or coupon for first-time customers.",
    );
  }
  if (actions.length < 3) {
    actions.push(
      "Compare city and channel performance and shift marketing attention to the fastest-growing segment.",
    );
  }

  return {
    insights: insights.slice(0, 5),
    actions: actions.slice(0, 5),
    source: "fallback",
  };
}

/** AI insights with rule-based fallback — never throws. */
export async function generateDigestInsights(data: WeeklyDigestData, attribution?: AiUsageAttribution): Promise<DigestInsights> {
  try {
    return await generateWithAI(data, attribution);
  } catch (err) {
    logger.warn({ err }, "Weekly digest AI insights failed — using rule-based fallback");
    return buildFallbackInsights(data);
  }
}

import { z } from "zod";
import { openai } from "@workspace/integrations-openai-ai-server/image";
import type { TotersExtractedReport, TotersExtractedMetric, TotersExtractedTrend, TotersExtractedItem } from "./totersPdfExtractor.js";
import { logger } from "./logger.js";
import { aiUsageAttribution, type AiUsageAttribution } from "./aiUsageRecorder.js";

const metricSchema = z.object({
  name: z.string(),
  value: z.number().nullable(),
  unit: z.string().nullable(),
  category: z.string(),
});

const trendSchema = z.object({
  weekLabel: z.string(),
  weekStart: z.string().nullable(),
  value: z.number().nullable(),
  metricName: z.string(),
});

const itemSchema = z.object({
  rank: z.number().int(),
  name: z.string(),
  quantity: z.number().nullable(),
  revenue: z.number().nullable(),
});

const aiExtractionSchema = z.object({
  merchantName: z.string().nullable().default(null),
  country: z.string().nullable().default(null),
  address: z.string().nullable().default(null),
  reportPeriodStart: z.string().nullable().default(null),
  reportPeriodEnd: z.string().nullable().default(null),
  metrics: z.array(metricSchema).default([]),
  weeklyTrends: z.array(trendSchema).default([]),
  bestSellingItems: z.array(itemSchema).default([]),
  confidence: z.number().min(0).max(1).default(0.5),
});

const EXTRACTION_PROMPT = `You are an expert data extraction assistant specializing in marketplace delivery platform reports (e.g. Toters, Talabat, Careem Food).

Extract all data from this marketplace report PDF image and return ONLY a valid JSON object with exactly these fields (no extra text, no markdown):

{
  "merchantName": "Full merchant/restaurant name as it appears in the report header, or null",
  "country": "Country name or code, or null",
  "address": "Merchant address or branch address, or null",
  "reportPeriodStart": "Report period start date in ISO format YYYY-MM-DD, or null",
  "reportPeriodEnd": "Report period end date in ISO format YYYY-MM-DD, or null",
  "metrics": [
    {
      "name": "metric_key_snake_case (e.g. total_orders, total_revenue, avg_order_value, cancellation_rate, acceptance_rate, avg_delivery_time, rating, new_customers, total_customers, impressions, conversion_rate, promo_cost, commission, net_revenue)",
      "value": 0.0,
      "unit": "unit string or null (e.g. 'count', 'USD', 'AED', '%', 'min', 'score')",
      "category": "summary or operational"
    }
  ],
  "weeklyTrends": [
    {
      "weekLabel": "Human-readable week label, e.g. 'Week 1' or 'May 11 - May 17'",
      "weekStart": "ISO date YYYY-MM-DD for the week start, or null",
      "value": 0.0,
      "metricName": "revenue"
    }
  ],
  "bestSellingItems": [
    {
      "rank": 1,
      "name": "Item name",
      "quantity": 50,
      "revenue": 500.0
    }
  ],
  "confidence": 0.95
}

Important rules:
- All dates MUST be in ISO format YYYY-MM-DD (e.g. "2024-05-11"). Convert "May 11 - May 17, 2024" to start="2024-05-11", end="2024-05-17".
- All numeric values must be plain numbers without currency symbols or commas (e.g. 1234.56 not "$1,234.56").
- Percentage values should be stored as numbers (e.g. 15.5 for 15.5%, not "15.5%").
- The merchantName often appears as a heading at the top of the report, not labeled with "Merchant:".
- The confidence score (0.0–1.0) reflects how clearly the report data was readable:
  - 0.85–1.0: clear, complete report
  - 0.60–0.84: partially readable or incomplete
  - 0.00–0.59: poor quality or very incomplete

Return ONLY the JSON object, no explanation.`;

async function pdfBufferToBase64Image(pdfBuffer: Buffer): Promise<string> {
  const { pdfToImage } = await import("./pdfToImage.js");
  const imageBuffer = await pdfToImage(pdfBuffer);
  if (!imageBuffer) {
    throw new Error("Failed to convert PDF to image for AI extraction");
  }
  return imageBuffer.toString("base64");
}

/**
 * AI-powered marketplace report extractor using GPT-5-mini vision.
 * Mirrors the pattern used in finance/aiExtraction.ts for invoice extraction.
 * Returns a TotersExtractedReport — the same shape the regex extractor returns,
 * so callers can swap one for the other transparently.
 *
 * Throws on failure so the caller can fall back to the regex extractor.
 */
export async function extractMarketplaceReportWithAI(
  pdfBuffer: Buffer,
  attribution?: AiUsageAttribution,
): Promise<TotersExtractedReport> {
  const model = process.env.AI_MARKETPLACE_MODEL ?? "gpt-5-mini";

  let base64Image: string;
  try {
    base64Image = await pdfBufferToBase64Image(pdfBuffer);
  } catch (err) {
    logger.warn({ err }, "aiMarketplaceExtractor: PDF to image conversion failed");
    throw new Error("Failed to convert PDF to image for AI extraction");
  }

  let rawJsonText: string;
  try {
    const { callAI } = await import("./ai/callAI.js");
    const response = await callAI({
      actionKey: "marketplace.report_extraction",
      surface: "marketplace",
      provider: "openai",
      model,
      client: openai,
      ...aiUsageAttribution(attribution),
      maxTokens: 8192,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "text",
              text: EXTRACTION_PROMPT,
            },
            {
              type: "image_url",
              image_url: {
                url: `data:image/png;base64,${base64Image}`,
                detail: "high",
              },
            },
          ],
        },
      ],
    });

    rawJsonText = response.choices[0]?.message?.content ?? "";
  } catch (err) {
    logger.error({ err }, "aiMarketplaceExtractor: OpenAI API call failed");
    throw new Error("AI extraction failed: " + (err instanceof Error ? err.message : "Unknown error"));
  }

  const jsonMatch = rawJsonText.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    throw new Error("AI extraction returned no valid JSON");
  }

  let rawJson: Record<string, unknown>;
  try {
    rawJson = JSON.parse(jsonMatch[0]) as Record<string, unknown>;
  } catch {
    throw new Error("AI extraction returned invalid JSON");
  }

  const parsed = aiExtractionSchema.safeParse(rawJson);
  if (!parsed.success) {
    logger.warn({ issues: parsed.error.issues }, "aiMarketplaceExtractor: validation warnings, attempting partial parse");
    const partial = aiExtractionSchema.partial().safeParse(rawJson);
    if (!partial.success) {
      throw new Error("AI extraction returned data that could not be parsed");
    }
  }

  const data = parsed.success ? parsed.data : aiExtractionSchema.partial().parse(rawJson);

  const metrics: TotersExtractedMetric[] = (data.metrics ?? []).map((m) => ({
    name: m.name,
    value: m.value ?? null,
    unit: m.unit ?? null,
    category: m.category,
  }));

  const weeklyTrends: TotersExtractedTrend[] = (data.weeklyTrends ?? []).map((t) => ({
    weekLabel: t.weekLabel,
    weekStart: t.weekStart ?? null,
    value: t.value ?? null,
    metricName: t.metricName,
  }));

  const bestSellingItems: TotersExtractedItem[] = (data.bestSellingItems ?? []).map((item) => ({
    rank: item.rank,
    name: item.name,
    quantity: item.quantity ?? null,
    revenue: item.revenue ?? null,
  }));

  return {
    merchantName: data.merchantName ?? null,
    country: data.country ?? null,
    address: data.address ?? null,
    reportPeriodStart: data.reportPeriodStart ?? null,
    reportPeriodEnd: data.reportPeriodEnd ?? null,
    metrics,
    weeklyTrends,
    bestSellingItems,
    rawText: "",
    confidence: data.confidence ?? 0.5,
  };
}

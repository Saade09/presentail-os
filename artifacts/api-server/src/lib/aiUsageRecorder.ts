import { db } from "./db.js";
import { logger } from "./logger.js";

export type AiUsageTokens = {
  inputTokens?: number | null;
  outputTokens?: number | null;
  cachedTokens?: number | null;
  reasoningTokens?: number | null;
};

export type AiUsageAttribution = {
  workspaceOwnerId?: string | null;
  orderId?: string | number | null;
  country?: string | null;
};

export function aiUsageAttribution(
  attribution?: AiUsageAttribution,
): Pick<AiUsageRecord, "sessionId" | "orderId" | "country"> {
  return {
    sessionId: attribution?.workspaceOwnerId
      ? `workspace:${attribution.workspaceOwnerId}`
      : null,
    orderId: attribution?.orderId == null ? null : String(attribution.orderId),
    country: attribution?.country ?? null,
  };
}

export type AiUsageRecord = AiUsageTokens & {
  actionKey: string;
  surface: string;
  provider: string;
  modelId: string;
  keySource: string;
  wasFallback?: boolean;
  costUsd?: number | null;
  costSource?: AiCostSource | null;
  imageSize?: string | null;
  imageQuality?: string | null;
  latencyMs?: number | null;
  success: boolean;
  errorCode?: string | null;
  orderId?: string | null;
  sessionId?: string | null;
  country?: string | null;
};

export type AiCostSource = "provider_billed" | "estimated";

type TrackOptions<T> = Omit<AiUsageRecord, keyof AiUsageTokens | "success" | "latencyMs" | "errorCode"> & {
  call: () => Promise<T>;
  tokens?: (value: NoInfer<T>) => AiUsageTokens;
};

type ModelPricing = {
  effectiveDate: string;
  source: string;
  tokenRates?: { input: number; cachedInput: number; output: number };
  imageRates?: Readonly<Record<string, Readonly<Record<string, number>>>>;
  note?: string;
};

// Central pricing registry. Token rates are USD per million tokens; image rates
// are USD per generated image, keyed first by quality and then output size.
export const MODEL_PRICING: Readonly<Record<string, ModelPricing>> = {
  "gpt-5-mini": {
    effectiveDate: "2025-08-07",
    source: "https://openai.com/api/pricing/",
    tokenRates: { input: 0.25, cachedInput: 0.025, output: 2 },
  },
  "gpt-4.1-mini": {
    effectiveDate: "2025-04-14",
    source: "https://openai.com/api/pricing/",
    tokenRates: { input: 0.4, cachedInput: 0.1, output: 1.6 },
  },
  "gpt-4o": {
    effectiveDate: "2024-11-20",
    source: "https://openai.com/api/pricing/",
    tokenRates: { input: 2.5, cachedInput: 1.25, output: 10 },
  },
  "gpt-4o-mini": {
    effectiveDate: "2024-07-18",
    source: "https://openai.com/api/pricing/",
    tokenRates: { input: 0.15, cachedInput: 0.075, output: 0.6 },
  },
  "claude-opus-5": {
    effectiveDate: "2026-08-01",
    source: "https://docs.anthropic.com/en/docs/about-claude/pricing",
    tokenRates: { input: 5, cachedInput: 0.5, output: 25 },
  },
  "claude-haiku-4-5-20251001": {
    effectiveDate: "2026-08-29",
    source: "https://docs.anthropic.com/en/docs/about-claude/pricing",
    tokenRates: { input: 1, cachedInput: 0.1, output: 5 },
  },
  "claude-sonnet-4": {
    effectiveDate: "2026-08-29",
    source: "https://docs.anthropic.com/en/docs/about-claude/pricing",
    tokenRates: { input: 3, cachedInput: 0.3, output: 15 },
  },
  "claude-sonnet-4-5": {
    effectiveDate: "2026-08-29",
    source: "https://docs.anthropic.com/en/docs/about-claude/pricing",
    tokenRates: { input: 3, cachedInput: 0.3, output: 15 },
  },
  "claude-sonnet-5": {
    effectiveDate: "2026-08-29",
    source: "https://docs.anthropic.com/en/docs/about-claude/pricing",
    tokenRates: { input: 2, cachedInput: 0.2, output: 10 },
  },
  "claude-opus-4": {
    effectiveDate: "2026-08-29",
    source: "https://docs.anthropic.com/en/docs/about-claude/pricing",
    tokenRates: { input: 15, cachedInput: 1.5, output: 75 },
  },
  "claude-opus-4-1": {
    effectiveDate: "2026-08-29",
    source: "https://docs.anthropic.com/en/docs/about-claude/pricing",
    tokenRates: { input: 15, cachedInput: 1.5, output: 75 },
  },
  "gpt-5.6-terra": {
    effectiveDate: "2026-08-01",
    source: "https://openai.com/api/pricing/",
    tokenRates: { input: 2, cachedInput: 0.2, output: 12 },
  },
  "gpt-5.6-sol": {
    effectiveDate: "2026-08-01",
    source: "https://openai.com/api/pricing/",
    tokenRates: { input: 5, cachedInput: 0.5, output: 30 },
  },
  "gpt-5.6-luna": {
    effectiveDate: "2026-08-01",
    source: "https://openai.com/api/pricing/",
    tokenRates: { input: 0.2, cachedInput: 0.02, output: 1.2 },
  },
  "gpt-5.4": {
    effectiveDate: "2026-08-01",
    source: "https://openai.com/api/pricing/",
    tokenRates: { input: 2.5, cachedInput: 0.25, output: 15 },
  },
  "gpt-5.2": {
    effectiveDate: "2026-08-01",
    source: "https://openai.com/api/pricing/",
    tokenRates: { input: 1.75, cachedInput: 0.175, output: 14 },
  },
  "gpt-5.1": {
    effectiveDate: "2026-08-01",
    source: "https://openai.com/api/pricing/",
    tokenRates: { input: 1.25, cachedInput: 0.125, output: 10 },
  },
  "gpt-5": {
    effectiveDate: "2025-08-07",
    source: "https://openai.com/api/pricing/",
    tokenRates: { input: 1.25, cachedInput: 0.125, output: 10 },
  },
  "gpt-5.4-mini": {
    effectiveDate: "2026-08-01",
    source: "https://openai.com/api/pricing/",
    tokenRates: { input: 0.75, cachedInput: 0.075, output: 4.5 },
  },
  "gpt-5-nano": {
    effectiveDate: "2025-08-07",
    source: "https://openai.com/api/pricing/",
    tokenRates: { input: 0.05, cachedInput: 0.005, output: 0.4 },
  },
  "gpt-image-1": {
    effectiveDate: "2025-04-23",
    source: "https://openai.com/api/pricing/",
    imageRates: {
      low: { "1024x1024": 0.011, "1024x1536": 0.016, "1536x1024": 0.016 },
      medium: { "1024x1024": 0.042, "1024x1536": 0.063, "1536x1024": 0.063 },
      high: { "1024x1024": 0.167, "1024x1536": 0.25, "1536x1024": 0.25 },
    },
  },
  "gpt-image-2": {
    effectiveDate: "2026-08-01",
    source: "https://openai.com/api/pricing/",
    imageRates: {
      low: { "1024x1024": 0.011, "1024x1536": 0.016, "1536x1024": 0.016 },
      medium: { "1024x1024": 0.042, "1024x1536": 0.063, "1536x1024": 0.063 },
      high: { "1024x1024": 0.167, "1024x1536": 0.25, "1536x1024": 0.25 },
    },
    note: "Integration-routed image model; rates follow the provider's published size/quality schedule.",
  },
};

export const BLOOMPRINT_VISION_MODELS = [
  "gpt-5.6-sol",
  "gpt-5.6-terra",
  "gpt-5.6-luna",
  "gpt-5.4",
  "gpt-5.2",
  "gpt-5.1",
  "gpt-5",
  "gpt-5.4-mini",
  "gpt-5-mini",
  "gpt-5-nano",
] as const;

export const BLOOMPRINT_IMAGE_MODELS = ["gpt-image-1"] as const;

export const PRODUCTION_MODEL_DEFAULTS = [
  "gpt-5-mini",
  "gpt-4.1-mini",
  "gpt-4o",
  "gpt-4o-mini",
  "claude-opus-5",
  "gpt-5.6-terra",
  "gpt-image-1",
  "gpt-image-2",
] as const;

const CONFIGURED_MODEL_ENV_DEFAULTS = {
  AI_TRANSLATE_MODEL: "gpt-5-mini",
  AI_PLACE_ASSESSOR_MODEL: "gpt-4o-mini",
  AI_GENDER_MODEL: "gpt-5-mini",
  AI_FLORIST_VERIFICATION_MODEL: "gpt-4o",
  AI_MARKETPLACE_MODEL: "gpt-5-mini",
  AI_INVOICE_MODEL: "claude-opus-5",
  RECIPE_SUGGESTION_MODEL: "gpt-4o-mini",
  OPENAI_MODEL: "gpt-4.1-mini",
  BLOOMPRINT_VISION_MODEL: "gpt-5.6-terra",
  BLOOMPRINT_IMAGE_MODEL: "gpt-image-1",
  PRODUCT_GALLERY_IMAGE_MODEL: "gpt-image-2",
} as const;

export function configuredProductionModelIds(
  environment: NodeJS.ProcessEnv = process.env,
): string[] {
  return [
    ...PRODUCTION_MODEL_DEFAULTS,
    ...BLOOMPRINT_VISION_MODELS,
    ...BLOOMPRINT_IMAGE_MODELS,
    ...Object.entries(CONFIGURED_MODEL_ENV_DEFAULTS).map(
      ([key, fallback]) => environment[key] ?? fallback,
    ),
  ];
}

export function missingModelPricingEntries(modelIds: readonly string[]): string[] {
  return [...new Set(modelIds.map((modelId) => modelId.trim().toLowerCase()).filter(Boolean))]
    .filter((modelId) => !MODEL_PRICING[modelId])
    .sort();
}

function finiteInteger(value: unknown): number | null {
  if (value == null || value === "") return null;
  const number = typeof value === "number" ? value : Number(value);
  return Number.isFinite(number) && number >= 0 ? Math.round(number) : null;
}

function finiteNumber(value: unknown): number | null {
  if (value == null || value === "") return null;
  const number = typeof value === "number" ? value : Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

export function aiErrorCode(error: unknown): string | null {
  if (!error || typeof error !== "object") return null;
  const candidate = error as {
    code?: unknown;
    status?: unknown;
    type?: unknown;
    name?: unknown;
    error?: { code?: unknown } | null;
  };
  const value =
    candidate.code ??
    candidate.status ??
    candidate.type ??
    candidate.error?.code ??
    candidate.name;
  return typeof value === "string" || typeof value === "number"
    ? String(value).slice(0, 120)
    : null;
}

export function openAiUsage(value: unknown): AiUsageTokens {
  const usage = (value as {
    usage?: {
      prompt_tokens?: unknown;
      completion_tokens?: unknown;
      prompt_tokens_details?: { cached_tokens?: unknown };
      completion_tokens_details?: { reasoning_tokens?: unknown };
    };
  } | null)?.usage;
  return {
    inputTokens: finiteInteger(usage?.prompt_tokens),
    outputTokens: finiteInteger(usage?.completion_tokens),
    cachedTokens: finiteInteger(usage?.prompt_tokens_details?.cached_tokens),
    reasoningTokens: finiteInteger(usage?.completion_tokens_details?.reasoning_tokens),
  };
}

export function openAiResponsesUsage(value: unknown): AiUsageTokens {
  const usage = (value as {
    usage?: {
      input_tokens?: unknown;
      output_tokens?: unknown;
      input_tokens_details?: { cached_tokens?: unknown };
      output_tokens_details?: { reasoning_tokens?: unknown };
    };
  } | null)?.usage;
  return {
    inputTokens: finiteInteger(usage?.input_tokens),
    outputTokens: finiteInteger(usage?.output_tokens),
    cachedTokens: finiteInteger(usage?.input_tokens_details?.cached_tokens),
    reasoningTokens: finiteInteger(usage?.output_tokens_details?.reasoning_tokens),
  };
}

export function anthropicUsage(value: unknown): AiUsageTokens {
  const usage = (value as {
    usage?: {
      input_tokens?: unknown;
      output_tokens?: unknown;
      cache_read_input_tokens?: unknown;
      cache_creation_input_tokens?: unknown;
    };
  } | null)?.usage;
  const ordinaryInput = finiteInteger(usage?.input_tokens);
  const cacheRead = finiteInteger(usage?.cache_read_input_tokens);
  const cacheCreation = finiteInteger(usage?.cache_creation_input_tokens);
  return {
    inputTokens:
      ordinaryInput == null && cacheRead == null && cacheCreation == null
        ? null
        : (ordinaryInput ?? 0) + (cacheRead ?? 0) + (cacheCreation ?? 0),
    outputTokens: finiteInteger(usage?.output_tokens),
    cachedTokens: cacheRead,
    reasoningTokens: null,
  };
}

/** Estimated USD cost from the model's published token rates, or null if unknown. */
export function estimateAiCostUsd(
  modelId: string,
  tokens: AiUsageTokens,
  image?: { size?: string | null; quality?: string | null },
): number | null {
  const pricing = MODEL_PRICING[modelId.toLowerCase()];
  if (image?.size && image.quality) {
    const imageRate = pricing?.imageRates?.[image.quality.toLowerCase()]?.[image.size.toLowerCase()];
    if (imageRate != null) return imageRate;
  }
  const rates = pricing?.tokenRates;
  if (!rates || (tokens.inputTokens == null && tokens.outputTokens == null)) return null;
  const input = Math.max(0, tokens.inputTokens ?? 0);
  // Cached input is included in input_tokens by both currently supported APIs.
  const cached = Math.min(input, Math.max(0, tokens.cachedTokens ?? 0));
  const output = Math.max(0, tokens.outputTokens ?? 0);
  return Number((((input - cached) * rates.input + cached * rates.cachedInput + output * rates.output) / 1_000_000).toFixed(6));
}

function providerBilledCostUsd(value: unknown): number | null {
  const data = value as {
    cost_usd?: unknown;
    cost?: unknown;
    usage?: { cost_usd?: unknown; cost?: unknown };
  } | null;
  return finiteNumber(data?.cost_usd ?? data?.usage?.cost_usd ?? data?.cost ?? data?.usage?.cost);
}

/**
 * Best-effort persistence only. This function always resolves, including when
 * the database/table is unavailable, and never logs prompt or response data.
 */
export async function recordAiUsage(record: AiUsageRecord): Promise<void> {
  try {
    await db.query(
      `INSERT INTO ai_usage_log
         (action_key, surface, provider, model_id, key_source, was_fallback,
          input_tokens, output_tokens, cached_tokens, reasoning_tokens,
          cost_usd, cost_source, image_size, image_quality,
          latency_ms, success, error_code, order_id, session_id, country)
       VALUES
         ($1, $2, $3, $4, $5, $6,
           $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20)`,
      [
        record.actionKey,
        record.surface,
        record.provider,
        record.modelId,
        record.keySource,
        record.wasFallback ?? false,
        finiteInteger(record.inputTokens),
        finiteInteger(record.outputTokens),
        finiteInteger(record.cachedTokens),
        finiteInteger(record.reasoningTokens),
        finiteNumber(record.costUsd),
        record.costSource ?? null,
        record.imageSize ?? null,
        record.imageQuality ?? null,
        finiteInteger(record.latencyMs),
        record.success,
        record.errorCode ?? null,
        record.orderId ?? null,
        record.sessionId ?? null,
        record.country ?? null,
      ],
    );
  } catch (err) {
    try {
      logger.warn(
        { err, actionKey: record.actionKey, provider: record.provider },
        "AI usage logging failed",
      );
    } catch {
      // Telemetry and its failure reporter must never affect provider behavior.
    }
  }
}

/**
 * Time a provider call and enqueue its usage record without awaiting logging.
 * The exact provider value or error is therefore returned/thrown unchanged,
 * even when usage persistence is slow or fails.
 */
export async function trackAiUsage<T>(options: TrackOptions<T>): Promise<T> {
  const startedAt = Date.now();
  const { call, tokens: extractTokens, ...metadata } = options;
  try {
    const value = await call();
    let tokens: AiUsageTokens = {};
    try {
      tokens = extractTokens?.(value) ?? {};
    } catch {
      // Usage extraction is observability-only.
    }
    const providerCostUsd = providerBilledCostUsd(value);
    const estimatedCostUsd = estimateAiCostUsd(metadata.modelId, tokens, {
      size: metadata.imageSize,
      quality: metadata.imageQuality,
    });
    void recordAiUsage({
      ...metadata,
      ...tokens,
      costUsd: providerCostUsd ?? estimatedCostUsd,
      costSource: providerCostUsd != null
        ? "provider_billed"
        : estimatedCostUsd != null
          ? "estimated"
          : null,
      success: true,
      latencyMs: Date.now() - startedAt,
    } as AiUsageRecord);
    return value;
  } catch (error) {
    void recordAiUsage({
      ...metadata,
      success: false,
      errorCode: aiErrorCode(error),
      latencyMs: Date.now() - startedAt,
    } as AiUsageRecord);
    throw error;
  }
}
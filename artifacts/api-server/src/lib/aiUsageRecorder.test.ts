import { beforeEach, describe, expect, it, vi } from "vitest";

const query = vi.fn();

vi.mock("./db", () => ({
  db: { query: (...args: unknown[]) => query(...args) },
}));

vi.mock("./logger", () => ({
  logger: { warn: vi.fn() },
}));

import {
  openAiUsage,
  openAiResponsesUsage,
  anthropicUsage,
  aiUsageAttribution,
  estimateAiCostUsd,
  missingModelPricingEntries,
  configuredProductionModelIds,
  MODEL_PRICING,
  PRODUCTION_MODEL_DEFAULTS,
  BLOOMPRINT_IMAGE_MODELS,
  BLOOMPRINT_VISION_MODELS,
  recordAiUsage,
  trackAiUsage,
} from "./aiUsageRecorder";

describe("aiUsageRecorder", () => {
  beforeEach(() => {
    query.mockReset();
    query.mockResolvedValue({ rows: [] });
  });

  it("captures timing, outcome, and OpenAI token details", async () => {
    vi.useFakeTimers();
    const providerValue = {
      id: "response-1",
      usage: {
        prompt_tokens: 12,
        completion_tokens: 7,
        prompt_tokens_details: { cached_tokens: 4 },
        completion_tokens_details: { reasoning_tokens: 2 },
      },
    };

    const pending = trackAiUsage({
      actionKey: "test.action",
      surface: "test",
      provider: "openai",
      modelId: "gpt-5-mini",
      keySource: "integration",
      call: async () => {
        await new Promise((resolve) => setTimeout(resolve, 25));
        return providerValue;
      },
      tokens: openAiUsage,
    });
    await vi.advanceTimersByTimeAsync(25);

    await expect(pending).resolves.toBe(providerValue);
    expect(query).toHaveBeenCalledTimes(1);
    expect(query.mock.calls[0][1]).toEqual([
      "test.action", "test", "openai", "gpt-5-mini", "integration", false,
      12, 7, 4, 2, 0.000016, "estimated", null, null, 25, true, null, null, null, null,
    ]);
    vi.useRealTimers();
  });

  it("estimates supported model cost without double-counting cached input", () => {
    expect(estimateAiCostUsd("gpt-4o", {
      inputTokens: 1_000_000,
      cachedTokens: 200_000,
      outputTokens: 100_000,
    })).toBe(3.25);
    expect(estimateAiCostUsd("unknown-model", { inputTokens: 1 })).toBeNull();
  });

  it("estimates image cost only when size and quality match a dated rate", () => {
    expect(estimateAiCostUsd("gpt-image-1", {}, {
      size: "1024x1024",
      quality: "medium",
    })).toBe(0.042);
    expect(estimateAiCostUsd("gpt-image-1", {}, {
      size: "1024x1024",
    })).toBeNull();
    expect(estimateAiCostUsd("gpt-image-1", {}, {
      size: "unsupported",
      quality: "medium",
    })).toBeNull();
  });

  it("records image pricing dimensions and estimated provenance", async () => {
    await trackAiUsage({
      actionKey: "test.image",
      surface: "test",
      provider: "openai",
      modelId: "gpt-image-1",
      keySource: "integration",
      imageSize: "1024x1024",
      imageQuality: "medium",
      call: async () => Buffer.from("image"),
    });
    expect(query.mock.calls[0][1].slice(10, 14)).toEqual([
      0.042, "estimated", "1024x1024", "medium",
    ]);
  });

  it("includes all Anthropic cache input categories in tokens and estimated cost", () => {
    const tokens = anthropicUsage({
      usage: {
        input_tokens: 500_000,
        cache_read_input_tokens: 300_000,
        cache_creation_input_tokens: 200_000,
        output_tokens: 100_000,
      },
    });
    expect(tokens).toEqual({
      inputTokens: 1_000_000,
      outputTokens: 100_000,
      cachedTokens: 300_000,
      reasoningTokens: null,
    });
    expect(estimateAiCostUsd("claude-sonnet-4", tokens)).toBe(3.69);
  });

  it("documents dated pricing metadata for every production model default", () => {
    expect(missingModelPricingEntries(PRODUCTION_MODEL_DEFAULTS)).toEqual([]);
    expect(missingModelPricingEntries(configuredProductionModelIds())).toEqual([]);
    expect(missingModelPricingEntries([
      ...BLOOMPRINT_VISION_MODELS,
      ...BLOOMPRINT_IMAGE_MODELS,
    ])).toEqual([]);
    for (const modelId of PRODUCTION_MODEL_DEFAULTS) {
      expect(MODEL_PRICING[modelId].effectiveDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(MODEL_PRICING[modelId].source).toMatch(/^https:\/\//);
    }
  });

  it("retains pricing coverage consolidated from the shared AI wrapper", () => {
    expect(missingModelPricingEntries([
      "claude-haiku-4-5-20251001",
      "claude-sonnet-4",
      "claude-sonnet-4-5",
      "claude-sonnet-5",
      "claude-opus-4",
      "claude-opus-4-1",
    ])).toEqual([]);
  });

  it("retains verified fallback token rates for the integration-routed GPT models", () => {
    expect(Object.fromEntries(
      [
        "gpt-5.1",
        "gpt-5.2",
        "gpt-5.4",
        "gpt-5.4-mini",
        "gpt-5.6-sol",
        "gpt-5.6-terra",
        "gpt-5.6-luna",
      ].map((modelId) => [modelId, MODEL_PRICING[modelId].tokenRates]),
    )).toEqual({
      "gpt-5.1": { input: 1.25, cachedInput: 0.125, output: 10 },
      "gpt-5.2": { input: 1.75, cachedInput: 0.175, output: 14 },
      "gpt-5.4": { input: 2.5, cachedInput: 0.25, output: 15 },
      "gpt-5.4-mini": { input: 0.75, cachedInput: 0.075, output: 4.5 },
      "gpt-5.6-sol": { input: 5, cachedInput: 0.5, output: 30 },
      "gpt-5.6-terra": { input: 2, cachedInput: 0.2, output: 12 },
      "gpt-5.6-luna": { input: 0.2, cachedInput: 0.02, output: 1.2 },
    });
  });

  it("flags configured model overrides that have no pricing entry", () => {
    const configured = configuredProductionModelIds({
      AI_TRANSLATE_MODEL: "new-production-model",
    });
    expect(missingModelPricingEntries(configured))
      .toEqual(["new-production-model"]);
  });

  it("prefers provider-billed cost and records its provenance", async () => {
    await trackAiUsage({
      actionKey: "test.billed",
      surface: "test",
      provider: "openai",
      modelId: "gpt-5-mini",
      keySource: "integration",
      call: async () => ({
        cost_usd: 0.42,
        usage: { prompt_tokens: 10, completion_tokens: 5 },
      }),
      tokens: openAiUsage,
    });
    expect(query.mock.calls[0][1][10]).toBe(0.42);
    expect(query.mock.calls[0][1][11]).toBe("provider_billed");
  });

  it("builds trusted workspace, order, and country attribution fields", () => {
    expect(aiUsageAttribution({
      workspaceOwnerId: "owner-1",
      orderId: 42,
      country: "AE",
    })).toEqual({
      sessionId: "workspace:owner-1",
      orderId: "42",
      country: "AE",
    });
  });

  it("database failures do not change a successful provider value", async () => {
    query.mockRejectedValueOnce(new Error("database unavailable"));
    const value = { answer: 42 };

    await expect(trackAiUsage({
      actionKey: "test.success",
      surface: "test",
      provider: "openai",
      modelId: "model",
      keySource: "integration",
      call: async () => value,
    })).resolves.toBe(value);
  });

  it("database failures do not hide or replace the original provider error", async () => {
    query.mockRejectedValueOnce(new Error("database unavailable"));
    const providerError = Object.assign(new Error("provider failed"), { code: "rate_limit" });

    await expect(trackAiUsage({
      actionKey: "test.failure",
      surface: "test",
      provider: "openai",
      modelId: "model",
      keySource: "integration",
      call: async () => {
        throw providerError;
      },
    })).rejects.toBe(providerError);

    expect(query.mock.calls[0][1][5]).toBe(false);
    expect(query.mock.calls[0][1][15]).toBe(false);
    expect(query.mock.calls[0][1][16]).toBe("rate_limit");
  });

  it("normalizes nested provider error codes", async () => {
    const providerError = { error: { code: "billing_error" } };
    await expect(trackAiUsage({
      actionKey: "test.nested-error",
      surface: "test",
      provider: "anthropic",
      modelId: "claude-sonnet-4",
      keySource: "integration",
      call: async () => {
        throw providerError;
      },
    })).rejects.toBe(providerError);
    expect(query.mock.calls[0][1][16]).toBe("billing_error");
  });

  it("keeps fallback false unless the caller explicitly identifies an alternate attempt", async () => {
    await trackAiUsage({
      actionKey: "test.alternate",
      surface: "test",
      provider: "anthropic",
      modelId: "claude-opus-5",
      keySource: "integration",
      wasFallback: true,
      call: async () => ({ usage: { input_tokens: 1, output_tokens: 1 } }),
      tokens: anthropicUsage,
    });
    expect(query.mock.calls[0][1][5]).toBe(true);
  });

  it("extracts Responses API usage and only marks explicit fallback records", () => {
    expect(openAiResponsesUsage({ usage: {
      input_tokens: 9, output_tokens: 3,
      input_tokens_details: { cached_tokens: 2 },
      output_tokens_details: { reasoning_tokens: 1 },
    } })).toEqual({ inputTokens: 9, outputTokens: 3, cachedTokens: 2, reasoningTokens: 1 });
  });

  it("recordAiUsage itself is fail-open", async () => {
    query.mockRejectedValueOnce(new Error("missing table"));
    await expect(recordAiUsage({
      actionKey: "test.direct",
      surface: "test",
      provider: "anthropic",
      modelId: "model",
      keySource: "integration",
      success: true,
    })).resolves.toBeUndefined();
  });
});
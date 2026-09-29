import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  chatCreate: vi.fn(),
  responseCreate: vi.fn(),
  messageCreate: vi.fn(),
  query: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));

vi.mock("@workspace/integrations-openai-ai-server", () => ({
  openai: {
    baseURL: "https://api.replit.com/v1/modelfarm/openai",
    chat: { completions: { create: mocks.chatCreate } },
    responses: { create: mocks.responseCreate },
  },
}));
vi.mock("@workspace/integrations-anthropic-ai-server", () => ({
  anthropic: {
    baseURL: "https://ai-integrations.replit.com/anthropic",
    messages: { create: mocks.messageCreate },
  },
}));
vi.mock("./db", () => ({ db: { query: mocks.query } }));
vi.mock("./logger", () => ({ logger: { warn: mocks.warn } }));

import { callAI } from "./ai/callAI.js";

const metadata = { actionKey: "test.action", surface: "unit-test" };

describe("callAI telemetry", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.query.mockResolvedValue({ rows: [] });
    process.env.AI_INTEGRATIONS_OPENAI_BASE_URL = "https://ai-integrations.replit.com/openai";
  });

  it("returns the unchanged OpenAI response and records one content-free insert", async () => {
    const response = {
      id: "response-id",
      choices: [{ message: { content: "secret completion" } }],
      usage: { prompt_tokens: 12, completion_tokens: 3 },
    };
    mocks.chatCreate.mockResolvedValue(response);
    const result = await callAI({
      provider: "openai",
      model: "gpt-5-mini",
      messages: [{ role: "user", content: "secret prompt" }],
      ...metadata,
    });

    expect(result).toBe(response);
    expect(mocks.query).toHaveBeenCalledOnce();
    const [sql, values] = mocks.query.mock.calls[0];
    expect(sql).toContain("INSERT INTO ai_usage_log");
    expect(values).toContain("modelfarm");
    expect(JSON.stringify([sql, values])).not.toContain("secret prompt");
    expect(JSON.stringify([sql, values])).not.toContain("secret completion");
  });

  it("dispatches OpenAI Responses and records exactly one telemetry row", async () => {
    const response = {
      id: "response-api-id",
      output: [],
      output_text: "generated text",
      usage: { input_tokens: 8, output_tokens: 2 },
    };
    mocks.responseCreate.mockResolvedValue(response);

    expect(await callAI({
      provider: "openai",
      api: "responses",
      model: "gpt-4.1-mini",
      instructions: "system prompt",
      input: "user prompt",
      ...metadata,
    })).toBe(response);
    expect(mocks.responseCreate).toHaveBeenCalledOnce();
    expect(mocks.query).toHaveBeenCalledOnce();
    expect(mocks.query.mock.calls[0][1][6]).toBe(8);
    expect(mocks.query.mock.calls[0][1][7]).toBe(2);
  });

  it("tracks an OpenAI image helper call exactly once without changing its result", async () => {
    const image = Buffer.from("generated-image");
    const generate = vi.fn().mockResolvedValue(image);

    expect(await callAI({
      provider: "openai",
      api: "image",
      model: "gpt-image-1",
      call: generate,
      ...metadata,
    })).toBe(image);
    expect(generate).toHaveBeenCalledOnce();
    expect(mocks.query).toHaveBeenCalledOnce();
  });

  it("dispatches Anthropic and logs its normalized usage", async () => {
    const response = {
      id: "message-id",
      content: [],
      usage: { input_tokens: 10, output_tokens: 4, cache_read_input_tokens: 5 },
    };
    mocks.messageCreate.mockResolvedValue(response);
    expect(await callAI({
      provider: "anthropic",
      model: "claude-opus-5",
      maxTokens: 10,
      messages: [{ role: "user", content: "hi" }],
      ...metadata,
    })).toBe(response);
    expect(mocks.messageCreate).toHaveBeenCalledOnce();
    expect(mocks.query.mock.calls[0][1][6]).toBe(15);
    expect(mocks.query.mock.calls[0][1][8]).toBe(5);
  });

  it("does not misclassify a direct Anthropic credential as modelfarm", async () => {
    const { anthropic } = await import("@workspace/integrations-anthropic-ai-server");
    const mockedClient = anthropic as unknown as { baseURL: string };
    const priorBaseURL = mockedClient.baseURL;
    mockedClient.baseURL = "https://api.anthropic.com";
    mocks.messageCreate.mockResolvedValue({ id: "message-id", content: [], usage: { input_tokens: 1, output_tokens: 1 } });
    try {
      await callAI({
        provider: "anthropic",
        model: "claude-opus-5",
        messages: [{ role: "user", content: "hi" }],
        ...metadata,
      });
      expect(mocks.query.mock.calls[0][1]).toContain("provider_direct");
    } finally {
      mockedClient.baseURL = priorBaseURL;
    }
  });

  it("records failed calls once and rethrows the exact provider error", async () => {
    const providerError = Object.assign(new Error("limited"), { code: "rate_limit" });
    mocks.chatCreate.mockRejectedValue(providerError);
    await expect(callAI({
      provider: "openai",
      model: "gpt-5-mini",
      messages: [{ role: "user", content: "hello" }],
      ...metadata,
    })).rejects.toBe(providerError);
    expect(mocks.query).toHaveBeenCalledOnce();
     expect(mocks.query.mock.calls[0][1][15]).toBe(false);
     expect(mocks.query.mock.calls[0][1][16]).toBe("rate_limit");
  });

  it("does not mistake an explicit modelfarm client for a workspace key", async () => {
    const create = vi.fn().mockResolvedValue({ id: "custom", usage: null });
    const client = {
      baseURL: "http://127.0.0.1:1106/v1",
      chat: { completions: { create } },
    } as never;
    await callAI({
      provider: "openai",
      model: "gpt-5-mini",
      messages: [{ role: "user", content: "hi" }],
      ...metadata,
      client,
    });
    expect(create).toHaveBeenCalledOnce();
    expect(mocks.query.mock.calls[0][1]).toContain("modelfarm");
    expect(mocks.query.mock.calls[0][1]).not.toContain("workspace_key");
  });

  it("classifies an OpenAI provider endpoint as a direct provider key", async () => {
    const create = vi.fn().mockResolvedValue({ id: "custom", usage: null });
    const client = {
      baseURL: "https://api.openai.com/v1",
      chat: { completions: { create } },
    } as never;
    await callAI({
      provider: "openai",
      model: "gpt-5-mini",
      messages: [{ role: "user", content: "hi" }],
      ...metadata,
      client,
    });
    expect(mocks.query.mock.calls[0][1]).toContain("provider_direct");
  });

  it("uses workspace_key only for a database-resolved credential", async () => {
    const create = vi.fn().mockResolvedValue({ id: "custom", usage: null });
    const client = {
      baseURL: "https://api.openai.com/v1",
      chat: { completions: { create } },
    } as never;
    await callAI({
      provider: "openai",
      model: "gpt-5-mini",
      messages: [{ role: "user", content: "hi" }],
      ...metadata,
      client,
      credentialResolvedFromDatabase: true,
    });
    expect(mocks.query.mock.calls[0][1]).toContain("workspace_key");
  });

  it("does not change success or failure when telemetry insertion fails", async () => {
    mocks.query.mockRejectedValue(new Error("database unavailable"));
    const response = { id: "ok", usage: null };
    mocks.chatCreate.mockResolvedValue(response);
    expect(await callAI({
      provider: "openai",
      model: "gpt-5-mini",
      messages: [{ role: "user", content: "hi" }],
      ...metadata,
    })).toBe(response);
    await vi.waitFor(() => expect(mocks.warn).toHaveBeenCalledOnce());

    const providerError = new Error("provider unavailable");
    mocks.chatCreate.mockRejectedValue(providerError);
    await expect(callAI({
      provider: "openai",
      model: "gpt-5-mini",
      messages: [{ role: "user", content: "hi" }],
      ...metadata,
    })).rejects.toBe(providerError);
    await vi.waitFor(() => expect(mocks.warn).toHaveBeenCalledTimes(2));
  });

  it("does not wait for telemetry persistence before returning", async () => {
    mocks.query.mockReturnValue(new Promise(() => {}));
    const response = { id: "ok", usage: null };
    mocks.chatCreate.mockResolvedValue(response);
    expect(await callAI({
      provider: "openai",
      model: "gpt-5-mini",
      messages: [{ role: "user", content: "hi" }],
      ...metadata,
    })).toBe(response);
  });

  it("logs and rethrows even when a provider rejects with undefined", async () => {
    mocks.chatCreate.mockRejectedValue(undefined);
    await expect(callAI({
      provider: "openai",
      model: "gpt-5-mini",
      messages: [{ role: "user", content: "hi" }],
      ...metadata,
    })).rejects.toBeUndefined();
    expect(mocks.query).toHaveBeenCalledOnce();
    expect(mocks.query.mock.calls[0][1][15]).toBe(false);
  });
});